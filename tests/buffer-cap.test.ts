import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createHash } from 'node:crypto';

/**
 * سقف بافرِ پنجره‌ی failover (v0.8.49):
 *
 * در پنجره‌ی «نویسنده هنوز آماده نیست» (DNS حالت prefix، زنجیره‌ی retry، و از
 * v0.8.48 مسیر نوشته‌ی ردشده) هر chunk کلاینت به remoteSocket.buffered می‌رود.
 * پل WS در Workers هیچ backpressure به کلاینت نمی‌دهد → کلاینتی که به مقصدِ
 * سیاه‌چاله آپلود می‌کند می‌تواند در پنجره‌ی ۶-۱۲ثانیه‌ای صدها مگابایت انباشته
 * کند → OOM ایزوله = مرگ همه‌ی اتصال‌های همان ایزوله (کلاس انبوهِ «بدون ترافیک»).
 *
 * قرارداد جدید: بافر بر-اتصال سقف بایتی دارد (REMOTE_SOCKET_MAX_BUFFERED_BYTES).
 * عبور از سقف = بستن تمیز همان اتصال (کلاینت reconnect می‌کند) نه به خطر
 * انداختن کل ایزوله. انباشت زیر سقف باید طبق قرارداد v0.8.28 دست‌نخورده بماند.
 *
 * تست‌ها کل هندلر واقعی را با WS فیک و پنجره‌ی DNS گیت‌شده می‌رانند.
 */

const hoisted = vi.hoisted(() => ({
    globals: {} as Record<string, unknown>,
    effList: [] as string[],
    resolveDNSImpl: (_domain: string, _v4?: boolean) =>
        Promise.resolve({ ipv4: ['203.0.113.10'], ipv6: [] }) as Promise<{ ipv4: string[]; ipv6: string[] }>,
}));

vi.mock('cloudflare:sockets', () => ({ connect: vi.fn() }));

vi.mock('@settings', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
        ...actual,
        getGlobals: () => hoisted.globals,
        getEffectiveProxyIPs: () => [...hoisted.effList],
    };
});

vi.mock('@utils', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
        ...actual,
        resolveDNS: (domain: string, v4?: boolean) => hoisted.resolveDNSImpl(domain, v4),
    };
});

vi.mock('@settings/edge-telemetry', () => ({ recordEdgeSample: vi.fn() }));

(globalThis as Record<string, unknown>).VERSION = '0.8.49';

// ---------- فیک‌ها ----------

type Listener = (ev?: unknown) => void;
type FakeWs = WebSocket & { fire: (type: string, ev?: unknown) => void };

function makeFakeWs(): FakeWs {
    const listeners = new Map<string, Listener[]>();
    let state = 1; // OPEN
    const ws = {
        accept: () => {},
        binaryType: '',
        get readyState() {
            return state;
        },
        send: () => {},
        close: () => {
            if (state === 1) {
                state = 2;
                listeners.get('close')?.forEach((f) => f());
            }
        },
        addEventListener: (type: string, fn: Listener) => {
            const arr = listeners.get(type) ?? [];
            arr.push(fn);
            listeners.set(type, arr);
        },
        fire: (type: string, ev?: unknown) => {
            listeners.get(type)?.forEach((f) => f(ev));
        },
    } as unknown as FakeWs;
    return ws;
}

let lastPair: [FakeWs, FakeWs] | null = null;

beforeAll(() => {
    class WsResponse {
        status: number;
        webSocket: unknown;
        constructor(_body: null, init: { status: number; webSocket: unknown }) {
            this.status = init.status;
            this.webSocket = init.webSocket;
        }
    }
    vi.stubGlobal('Response', WsResponse);

    (globalThis as Record<string, unknown>).WebSocketPair = class {
        constructor() {
            const pair: [FakeWs, FakeWs] = [makeFakeWs(), makeFakeWs()];
            lastPair = pair;
            Object.assign(this, { 0: pair[0], 1: pair[1] });
        }
    };
});
afterAll(() => {
    vi.unstubAllGlobals();
});

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
async function until(cond: () => boolean, max = 600): Promise<void> {
    for (let i = 0; i < max && !cond(); i++) await tick();
}

/** سوکت واسط نویسه‌ثبت — برای تست زیر-سقف (بازپخش کامل) */
function recordingSocket() {
    const written: Uint8Array[] = [];
    const socket = {
        readable: new ReadableStream<Uint8Array>({ start(c) { c.close(); } }),
        writable: new WritableStream<Uint8Array | ArrayBuffer>({
            write(c) { written.push(c instanceof Uint8Array ? c : new Uint8Array(c)); },
        }),
        close: () => {},
        closed: Promise.resolve(),
    } as unknown as Socket;
    return { socket, written };
}

const makeRequest = () =>
    new Request('https://panel.test/ws', { headers: { 'sec-websocket-protocol': '' } });
const fakeCtx = () =>
    ({ waitUntil: () => {}, passThroughOnException: () => {} }) as unknown as ExecutionContext;

// ---------- سازنده‌های هدر ----------

const PROBE_UUID = '3a2a0461-1fec-4acd-a123-cbab2586bab1';
const TR_PASS = 'cap-test-pass';

function uuidBytes(uuid: string): Uint8Array {
    const hex = uuid.replace(/-/g, '');
    const out = new Uint8Array(16);
    for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
}

/** [version][uuid(16)][addonsLen=0][cmd=1][port(2)][atype=2][len][domain][payload] */
function vlHeader(domain: string, port: number, payload: string): ArrayBuffer {
    const enc = new TextEncoder();
    const dom = enc.encode(domain);
    const pay = enc.encode(payload);
    const buf = new Uint8Array(21 + 2 + dom.length + pay.length);
    let i = 0;
    buf[i++] = 0;
    buf.set(uuidBytes(PROBE_UUID), i);
    i += 16;
    buf[i++] = 0;
    buf[i++] = 1;
    buf[i++] = (port >> 8) & 0xff;
    buf[i++] = port & 0xff;
    buf[i++] = 2;
    buf[i++] = dom.length;
    buf.set(dom, i);
    i += dom.length;
    buf.set(pay, i);
    return buf.buffer;
}

/** [hash(56)][CRLF][cmd=1][atype=3][len][domain][port(2)][CRLF][payload] */
function trHeader(domain: string, port: number, payload: string): ArrayBuffer {
    const hash = createHash('sha224').update(TR_PASS).digest('hex');
    const enc = new TextEncoder();
    const dom = enc.encode(domain);
    const pay = enc.encode(payload);
    const buf = new Uint8Array(56 + 2 + 1 + 1 + 1 + dom.length + 2 + 2 + pay.length);
    let i = 0;
    for (const ch of hash) buf[i++] = ch.charCodeAt(0);
    buf[i++] = 0x0d;
    buf[i++] = 0x0a;
    buf[i++] = 1;
    buf[i++] = 3;
    buf[i++] = dom.length;
    buf.set(dom, i);
    i += dom.length;
    buf[i++] = (port >> 8) & 0xff;
    buf[i++] = port & 0xff;
    buf[i++] = 0x0d;
    buf[i++] = 0x0a;
    buf.set(pay, i);
    return buf.buffer;
}

const decode = (b: Uint8Array) => new TextDecoder().decode(b);

// پنجره‌ی DNS حالت prefix را گیت می‌کند — حین باز بودنش همه‌ی chunkها بافر می‌شوند
function gatePrefixDns() {
    hoisted.globals = {
        proxyIpMode: 'prefix',
        prefixes: ['[64:ff9b::]'],
        forceProxyDomains: undefined, // پیش‌فرض داخلی — google.com forced → مسیر واسط از ابتدا
    };
    hoisted.effList = [];
    let releaseDns!: () => void;
    const dnsGate = new Promise<void>((r) => { releaseDns = r; });
    hoisted.resolveDNSImpl = async () => {
        await dnsGate;
        return { ipv4: ['203.0.113.10'], ipv6: [] };
    };
    return { releaseDns };
}

// chunk های 64KB — با سقف 4MB حدود ۶۵ عدد از سقف می‌گذرد
const BIG_CHUNK = new Uint8Array(64 * 1024).fill(0x41);

async function driveOverflow(handlerPath: string, header: ArrayBuffer, extraGlobals: Record<string, unknown>) {
    const { releaseDns } = gatePrefixDns();
    Object.assign(hoisted.globals, extraGlobals);

    const { connect } = await import('cloudflare:sockets');
    const conn = vi.mocked(connect);
    conn.mockReset();
    conn.mockImplementation(() => {
        throw new Error('no connect expected in overflow test');
    });

    const mod = (await import(handlerPath)) as Record<string, unknown>;
    const Handler = mod.VlOverWSHandler ?? mod.TrOverWSHandler;
    const res = await (Handler as (r: Request, e: Env, c: ExecutionContext, g: unknown) => Promise<Response>)(
        makeRequest(), {} as Env, fakeCtx(), null
    );
    expect(res.status).toBe(101);
    const server = lastPair![1];

    // هدر → مسیر forced-prefix → روی DNS گیت‌شده می‌ایستد (بافر مسلح)
    server.fire('message', { data: header });
    await tick();
    await tick();

    // آپلود انبوه داخل پنجره — ۷۰ × 64KB = 4.48MB > سقف 4MB
    for (let i = 0; i < 70; i++) {
        server.fire('message', { data: BIG_CHUNK.buffer.slice(0) });
        if (i % 10 === 0) await tick();
    }

    // قرارداد جدید: عبور از سقف = بستن تمیز همان اتصال، همان لحظه (قبل از رفع DNS)
    await until(() => server.readyState !== 1);
    expect(server.readyState).not.toBe(1);

    // پاک‌سازی: رفع DNS — زنجیره نباید چیز بیشتری باز کند
    releaseDns();
    await tick();
    await tick();
}

describe('failover-window buffer cap (v0.8.49)', () => {
    it('VLESS: flooding the writer-not-ready window past the cap closes the connection cleanly', async () => {
        await driveOverflow('../src/protocols/vless', vlHeader('www.google.com', 443, 'HELLO'), {
            vlUUID: PROBE_UUID,
        });
    });

    it('Trojan: same cap on the trojan handler', async () => {
        await driveOverflow('../src/protocols/trojan', trHeader('www.google.com', 443, 'HELLO'), {
            trPass: TR_PASS,
        });
    });

    it('VLESS: bursts under the cap still replay fully and in order (v0.8.28 contract intact)', async () => {
        const { releaseDns } = gatePrefixDns();
        hoisted.globals.vlUUID = PROBE_UUID;

        const proxy = recordingSocket();
        const { connect } = await import('cloudflare:sockets');
        const conn = vi.mocked(connect);
        conn.mockReset();
        conn.mockReturnValueOnce(proxy.socket).mockImplementation(() => {
            throw new Error('no second path');
        });

        const { VlOverWSHandler } = await import('../src/protocols/vless');
        const res = await VlOverWSHandler(makeRequest(), {} as Env, fakeCtx(), null);
        expect(res.status).toBe(101);
        const server = lastPair![1];

        server.fire('message', { data: vlHeader('www.google.com', 443, 'HELLO') });
        await tick();
        // چند chunk زیر سقف — همه باید در پنجره بافر و بعداً به ترتیب بازپخش شوند
        for (let i = 0; i < 4; i++) {
            server.fire('message', { data: BIG_CHUNK.buffer.slice(0) });
            await tick();
        }

        releaseDns();
        await until(() => proxy.written.length >= 5);
        await tick();

        expect(proxy.written).toHaveLength(5);
        expect(decode(proxy.written[0])).toBe('HELLO');
        expect(proxy.written[1][0]).toBe(0x41);
        expect(proxy.written[4][0]).toBe(0x41);
        await until(() => server.readyState !== 1); // EOF آنی واسط → پایان تمیز
    });
});
