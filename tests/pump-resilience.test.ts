import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createHash } from 'node:crypto';

/**
 * تاب‌آوریِ پمپِ کلاینت→ریموت در برابر ردِ نوشته (v0.8.48):
 *
 * sink هر دو هندلر نوشته‌های کلاینت را با `writer.write(chunk)` به سوکتِ
 * «تلاش فعلی» می‌فرستد. اگر همین نوشته رد شود (مرگ سوکت در حال پرواز:
 * وچ‌داگ first-byte، RST، سیاه‌چاله‌ی مقصد)، pipeTo که یکی از writeهایش رد
 * شود برای همیشه می‌میرد و readable نیز cancel می‌شود (پیام‌های بعدی در
 * listener حذف می‌شوند). تلاش بعدیِ زنجیره‌ی failover سوکت تازه می‌سازد و
 * rawClientData را بازپخش می‌کند — ولی دیگر «هیچ» داده‌ی تازه‌ای از کلاینت
 * دریافت نمی‌کند: تونل زامبی = دقیقاً کلاسِ «وصل ولی بدون ترافیک».
 *
 * قرارداد درست: ردِ نوشته نباید پمپ را بکشد — chunk باید به buffered برگردد
 * تا قرارداد بازپخش v0.8.28/v0.8.38 آن را به ترتیب درست به تلاش بعدی برساند.
 *
 * تست‌ها کل هندلر واقعی (VlOverWSHandler/TrOverWSHandler) را با WS فیک و
 * سوکت‌های کنترل‌شده می‌رانند — بدون شبیه‌سازیِ دستیِ منطق.
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

(globalThis as Record<string, unknown>).VERSION = '0.8.48';

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
async function until(cond: () => boolean, max = 300): Promise<void> {
    for (let i = 0; i < max && !cond(); i++) await tick();
}

/** سوکت مقصد مستقیم: نوشته‌ها ثبت و موفق‌اند تا kill() — بعد از آن هر نوشته رد می‌شود؛ EOF گیت‌شده */
function killableRecordingSocket(eofGate: Promise<void>) {
    const written: Uint8Array[] = [];
    let dead = false;
    const socket = {
        readable: new ReadableStream<Uint8Array>({ start(c) { void eofGate.then(() => c.close()); } }),
        writable: new WritableStream<Uint8Array | ArrayBuffer>({
            write(c) {
                if (dead) throw new Error('socket died mid-flight');
                written.push(c instanceof Uint8Array ? c : new Uint8Array(c));
            },
        }),
        close: () => {},
        closed: Promise.resolve(),
    } as unknown as Socket;
    return { socket, written, kill: () => { dead = true; } };
}

/** سوکت واسط نویسه‌ثبت با EOF گیت‌شده — تونل را تا پایان assertها باز نگه می‌دارد */
function gatedRecordingSocket(gate: Promise<void>) {
    const written: Uint8Array[] = [];
    const socket = {
        readable: new ReadableStream<Uint8Array>({ start(c) { void gate.then(() => c.close()); } }),
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
const TR_PASS = 'pump-test-pass';

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

// payload های متمایز — بایت اول هر chunk را جداگانه‌ای می‌گذاریم تا ترتیب بازپخش قابل ادعا باشد
const CHUNK_OK = new Uint8Array(16).fill(0x30); // '0' — قبل از مرگ سوکت: نوشته موفق (به همان سوکت می‌رسد)
const CHUNK_DURING_DEATH = new Uint8Array(16).fill(0x31); // '1' — بعد از مرگ سوکت: نوشته رد → باید به بافر برگردد
const CHUNK_AFTER_FAILOVER = new Uint8Array(16).fill(0x32); // '2' — بعد از جایگزینی واسط: مستقیم روی نویسنده‌ی جدید
const decode = (b: Uint8Array) => new TextDecoder().decode(b);

async function drivePumpDeath(
    handlerModule: () => Promise<Record<string, unknown>>,
    header: ArrayBuffer,
    globals: Record<string, unknown>
) {
    hoisted.globals = globals;
    hoisted.effList = ['p1.example:443']; // تک‌کاندیدا → بدون تلاش دومِ واسط
    hoisted.resolveDNSImpl = async () => ({ ipv4: ['203.0.113.10'], ipv6: [] });

    let releaseDirectEof!: () => void;
    const directEofGate = new Promise<void>((r) => { releaseDirectEof = r; });
    let releaseProxyEof!: () => void;
    const proxyEofGate = new Promise<void>((r) => { releaseProxyEof = r; });

    const direct = killableRecordingSocket(directEofGate);
    const proxy = gatedRecordingSocket(proxyEofGate);
    const { connect } = await import('cloudflare:sockets');
    const conn = vi.mocked(connect);
    conn.mockReset();
    conn.mockReturnValueOnce(direct.socket).mockReturnValue(proxy.socket);

    const mod = await handlerModule();
    const Handler = mod.VlOverWSHandler ?? mod.TrOverWSHandler;
    const res = await (Handler as (r: Request, e: Env, c: ExecutionContext, g: unknown) => Promise<Response>)(
        makeRequest(), {} as Env, fakeCtx(), null
    );
    expect(res.status).toBe(101);
    const server = lastPair![1];

    // ۱) هدر پروتکل → اتصال مستقیم + بازپخش rawClientData
    server.fire('message', { data: header });
    await until(() => direct.written.length >= 1);

    // ۲) یک chunk عادی — نوشته موفق (به سوکت مستقیم می‌رسد)
    server.fire('message', { data: CHUNK_OK.buffer.slice(0) });
    await until(() => direct.written.length >= 2);
    expect(direct.written[1][0]).toBe(0x30); // گارد: نوشته‌ی سالم طبق معمول می‌گذرد

    // ۳) سوکت در حال پرواز می‌میرد؛ بعد chunk تازه می‌رسد → نوشته‌اش باید رد شود
    direct.kill();
    server.fire('message', { data: CHUNK_DURING_DEATH.buffer.slice(0) });
    await tick();
    await tick();

    // ۴) EOF مقصد مستقیم (بدون داده) → retry → تلاش واسط
    releaseDirectEof();
    // کلیدی (کد جدید): chunk مرگ به buffered برگشته و توسط تلاش واسط بازپخش می‌شود
    await until(() => proxy.written.length >= 2);
    await tick();

    // ۵) chunk تازه‌ی بعد از failover — از طریق نویسنده‌ی سوکت جدید
    server.fire('message', { data: CHUNK_AFTER_FAILOVER.buffer.slice(0) });
    await until(() => proxy.written.length >= 3);
    await tick();

    // قرارداد کامل: بازپخش rawClientData، بازپخش chunkِ مرگ به ترتیب، و جریان زنده‌ی بعد از failover
    expect(decode(proxy.written[0])).toBe('GET /');
    expect(proxy.written[1][0]).toBe(0x31);
    expect(proxy.written[2][0]).toBe(0x32);

    // پاک‌سازی: EOF واسط → تونل تمام، WS بسته، بدون تایمر معلق
    releaseProxyEof();
    await until(() => server.readyState !== 1);
}

describe('pump resilience — rejected write must not kill the client→remote pump (v0.8.48)', () => {
    it('VLESS: chunk whose write dies mid-flight is replayed to the failover attempt; pump stays alive', async () => {
        await drivePumpDeath(
            async () => await import('../src/protocols/vless'),
            vlHeader('example.com', 80, 'GET /'),
            {
                vlUUID: PROBE_UUID,
                proxyIpMode: 'proxyip',
                prefixes: [],
                forceProxyDomains: [], // مسیر مستقیم اول
            }
        );
    });

    it('Trojan: same contract on the trojan handler', async () => {
        await drivePumpDeath(
            async () => await import('../src/protocols/trojan'),
            trHeader('example.com', 80, 'GET /'),
            {
                trPass: TR_PASS,
                proxyIpMode: 'proxyip',
                prefixes: [],
                forceProxyDomains: [],
            }
        );
    });
});
