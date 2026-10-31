import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createHash } from 'node:crypto';

/**
 * رقابتِ «نویسنده هنوز آماده نیست» در مسیر خروجی TCP (v0.8.28):
 *
 * مسیر forced-proxy (گوگل/OpenAI — پیش‌فرض روشن) در handleTCPOutBound قبل از
 * ست‌شدن نویسنده‌ی سوکت روی `await resolveProxyTarget` می‌ایستد. در حالت
 * prefix این ایست، وضوح واقعی DNS است (getDynamicProxyIP → resolveDNS) —
 * یعنی پنجره‌ای در حد میلی‌ثانیه‌ها. کلاینت‌های early-data (کلمپ شِد by پنل)
 * هدر را در Sec-WebSocket-Protocol و payload را در پیام اول می‌فرستند؛ اگر
 * پیام payload در همین پنجره برسد:
 *   • کد قدیمی: payload به‌جای هدر VLESS/Trojan پارس می‌شد → hasError →
 *     throw → pipe رد می‌شد → تونل مرده + WS زامبی («وصل ولی بدون ترافیک»)
 *   • کد جدید: chunk در remoteSocketWrapper.buffered می‌نشیند و connectAndWrite
 *     به محض آماده‌شدن نویسنده، به‌ترتیب ورود و در یک بلوک sync تخلیه‌اش می‌کند
 * همین پنجره در retry و تلاش دومِ واسط هم هست (نویسنده‌ی سوکت مردود باطل
 * می‌شود تا chunkها به تلاش بعدی بازپخش شوند، نه اینکه در سوکت مرده گم شوند).
 *
 * تست‌ها کل هندلر واقعی (VlOverWSHandler/TrOverWSHandler) را با WS فیک و
 * DNS کنترل‌شده می‌رانند — بدون شبیه‌سازیِ دستیِ منطق.
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

// فقط resolveDNS کنترل‌شده می‌شود؛ isIPv4/parseHostPort واقعی می‌مانند
vi.mock('@utils', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
        ...actual,
        resolveDNS: (domain: string, v4?: boolean) => hoisted.resolveDNSImpl(domain, v4),
    };
});

// بستن WS → recordEdgeSample → KV/سوکت نمی‌خواهیم در تست لمس شود
vi.mock('@settings/edge-telemetry', () => ({ recordEdgeSample: vi.fn() }));

(globalThis as Record<string, unknown>).VERSION = '0.8.28';

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

// WebSocketPair در Node نیست — جفت فیک که سمت سرور برای تست در دسترس بماند
let lastPair: [FakeWs, FakeWs] | null = null;

// Response در Node وضعیت 101 را نمی‌پذیرد (مخصوص Workers) — استابِ حداقلی
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

/** سوکتی که بلافاصله EOF تمیز می‌دهد و نوشته‌ها را ثبت می‌کند */
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

/** سیاه‌چاله‌ی کنترل‌شده: نوشته‌ها بی‌صدا می‌بلعد؛ EOF فقط با آزادشدن گیت */
function gatedDeadSocket(gate: Promise<void>) {
    return {
        readable: new ReadableStream<Uint8Array>({ start(c) { void gate.then(() => c.close()); } }),
        writable: new WritableStream(),
        close: () => {},
        closed: Promise.resolve(),
    } as unknown as Socket;
}

/** سوکت نویسه‌ثبت با EOF گیت‌شده — برای نگه‌داشتن تونل تا پایان مرحله‌ی ارسال */
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
const TR_PASS = 'race-test-pass';

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

const CLIENT_HELLO = new Uint8Array(32).fill(0x16); // بایت TLS handshake — payload خالص
const decode = (b: Uint8Array) => new TextDecoder().decode(b);

// ---------- ۱) پنجره‌ی forced-proxy در حالت prefix (هدر در پیام اول، payload در پیام دوم) ----------

describe('outbound write race — forced prefix window (v0.8.28)', () => {
    it('VLESS: payload chunk arriving during prefix-DNS is buffered and delivered in order', async () => {
        const { connect } = await import('cloudflare:sockets');
        const { VlOverWSHandler } = await import('../src/protocols/vless');

        let releaseDns!: () => void;
        const dnsGate = new Promise<void>((r) => { releaseDns = r; });
        hoisted.globals = {
            vlUUID: PROBE_UUID,
            proxyIpMode: 'prefix',
            prefixes: ['[64:ff9b::]'],
            forceProxyDomains: undefined, // پیش‌فرض داخلی — google.com روشن
        };
        hoisted.resolveDNSImpl = async () => {
            await dnsGate;
            return { ipv4: ['203.0.113.10'], ipv6: [] };
        };

        const proxy = recordingSocket();
        const conn = vi.mocked(connect);
        conn.mockReset();
        conn.mockReturnValueOnce(proxy.socket).mockImplementationOnce(() => {
            throw new Error('no second path in this test');
        });

        const res = await VlOverWSHandler(makeRequest(), {} as Env, fakeCtx(), null);
        expect(res.status).toBe(101);
        const server = lastPair![1];

        // پیام ۱: هدر VLESS برای دامنه‌ی forced (google) + داده‌ی اولیه
        server.fire('message', { data: vlHeader('www.google.com', 443, 'HELLO') });
        // پیام ۲ در همان پنجره‌ی DNS: payload خالص — روی کد قدیمی به‌جای هدر پارس می‌شد
        server.fire('message', { data: CLIENT_HELLO.buffer });

        releaseDns();
        await until(() => proxy.written.length >= 2);
        await tick();

        // کلیدی: هر دو chunk به سوکت واسط رسیدند و به ترتیب ورود
        expect(proxy.written.length).toBe(2);
        expect(decode(proxy.written[0])).toBe('HELLO');
        expect(proxy.written[1][0]).toBe(0x16);
        // مسیر واقعاً از واسط prefix گذشته باشد
        const host = (conn.mock.calls[0][0] as { hostname: string }).hostname;
        expect(host.startsWith('[64:ff9b::')).toBe(true);
    });

    it('Trojan: same window — payload chunk is buffered, not parsed as header', async () => {
        const { connect } = await import('cloudflare:sockets');
        const { TrOverWSHandler } = await import('../src/protocols/trojan');

        let releaseDns!: () => void;
        const dnsGate = new Promise<void>((r) => { releaseDns = r; });
        hoisted.globals = {
            trPass: TR_PASS,
            proxyIpMode: 'prefix',
            prefixes: ['[64:ff9b::]'],
            forceProxyDomains: undefined,
        };
        hoisted.resolveDNSImpl = async () => {
            await dnsGate;
            return { ipv4: ['203.0.113.10'], ipv6: [] };
        };

        const proxy = recordingSocket();
        const conn = vi.mocked(connect);
        conn.mockReset();
        conn.mockReturnValueOnce(proxy.socket).mockImplementationOnce(() => {
            throw new Error('no second path in this test');
        });

        const res = await TrOverWSHandler(makeRequest(), {} as Env, fakeCtx(), null);
        expect(res.status).toBe(101);
        const server = lastPair![1];

        server.fire('message', { data: trHeader('www.google.com', 443, 'HELLO') });
        server.fire('message', { data: CLIENT_HELLO.buffer });

        releaseDns();
        await until(() => proxy.written.length >= 2);
        await tick();

        expect(proxy.written.length).toBe(2);
        expect(decode(proxy.written[0])).toBe('HELLO');
        expect(proxy.written[1][0]).toBe(0x16);
    });
});

// ---------- ۲) پنجره‌ی retry — chunk رسیده در DNS واسط باید بازپخش شود نه گم ----------

describe('outbound write race — retry window (v0.8.28)', () => {
    it('chunk arriving during retry DNS is replayed to the proxy attempt', async () => {
        const { connect } = await import('cloudflare:sockets');
        const { VlOverWSHandler } = await import('../src/protocols/vless');

        // گیت اول: EOF مقصد مستقیم فقط با آزادسازی — تا پنجره‌ی retry دقیق کنترل شود
        let releaseEof!: () => void;
        const eofGate = new Promise<void>((r) => { releaseEof = r; });
        // گیت دوم: DNS واسط معلق — پنجره‌ی retry
        let releaseRetryDns!: () => void;
        const retryDnsGate = new Promise<void>((r) => { releaseRetryDns = r; });
        let dnsCalls = 0;

        hoisted.globals = {
            vlUUID: PROBE_UUID,
            proxyIpMode: 'prefix',
            prefixes: ['[64:ff9b::]'],
            forceProxyDomains: [], // خاموش — مسیر مستقیم اول
        };
        hoisted.effList = []; // استخر خالی → تلاش دومِ واسط ندارد
        hoisted.resolveDNSImpl = async () => {
            dnsCalls++;
            await retryDnsGate;
            return { ipv4: ['203.0.113.10'], ipv6: [] };
        };

        const direct = gatedDeadSocket(eofGate);
        const proxy = recordingSocket();
        const conn = vi.mocked(connect);
        conn.mockReset();
        conn.mockReturnValueOnce(direct).mockReturnValueOnce(proxy.socket);

        const res = await VlOverWSHandler(makeRequest(), {} as Env, fakeCtx(), null);
        expect(res.status).toBe(101);
        const server = lastPair![1];

        server.fire('message', { data: vlHeader('example.com', 80, 'GET /') });
        await until(() => conn.mock.calls.length === 1); // اتصال مستقیم برقرار شد

        releaseEof(); // EOF بدون داده → retry → باطل‌شدن نویسنده → DNS معلق
        await until(() => dnsCalls === 1);
        await tick();

        // پنجره‌ی retry باز است — payload کلاینت می‌رسد
        server.fire('message', { data: CLIENT_HELLO.buffer });
        await tick();

        releaseRetryDns(); // DNS واسط حل شد → اتصال واسط + تخلیه‌ی بافر
        await until(() => proxy.written.length >= 2);
        await tick();

        // کلیدی: GET / (بازپخش rawClientData) و بعد payload پنجره — هر دو به تلاش جدید
        expect(proxy.written.length).toBe(2);
        expect(decode(proxy.written[0])).toBe('GET /');
        expect(proxy.written[1][0]).toBe(0x16);
    });
});

// ---------- ۴) v0.8.38 — نوشته‌ی شکست‌خورده نباید chunkهای تخلیه‌شده را گم کند ----------

describe('outbound write race — failed write batch must restore drained chunks (v0.8.38)', () => {
    it('VLESS: payload drained into a dead proxy socket is replayed to the direct fallback', async () => {
        const { connect } = await import('cloudflare:sockets');
        const { VlOverWSHandler } = await import('../src/protocols/vless');

        // گیت ۱: DNS prefix معلق — پنجره‌ی بافر (پیام payload همین‌جا می‌رسد)
        let releaseDns!: () => void;
        const dnsGate = new Promise<void>((r) => { releaseDns = r; });
        let dnsCalls = 0;

        hoisted.globals = {
            vlUUID: PROBE_UUID,
            proxyIpMode: 'prefix',
            prefixes: ['[64:ff9b::]'],
            forceProxyDomains: undefined, // پیش‌فرض داخلی — google.com forced → مسیر واسط اول
        };
        hoisted.effList = []; // تلاش دومِ واسط ندارد → fallback = مستقیم
        hoisted.resolveDNSImpl = async () => {
            if (dnsCalls++ === 0) await dnsGate; // فقط اولی معلق — بقیه آنی
            return { ipv4: ['203.0.113.10'], ipv6: [] };
        };

        // واسطی که نوشته‌ها را رد می‌کند — connectAndWrite باید با شکست batch بالا بیاید
        const deadProxy = {
            readable: new ReadableStream<Uint8Array>({ start(c) { c.close(); } }),
            writable: new WritableStream<Uint8Array | ArrayBuffer>({
                write() { throw new Error('proxy socket dead'); },
            }),
            close: () => {},
            closed: Promise.resolve(),
        } as unknown as Socket;

        // مقصد مستقیم: نویسه‌ثبت با EOF گیت‌شده — تا قبل از assert تونل باز بماند
        let releaseEof!: () => void;
        const eofGate = new Promise<void>((r) => { releaseEof = r; });
        const direct = gatedRecordingSocket(eofGate);
        const after = recordingSocket();

        const conn = vi.mocked(connect);
        conn.mockReset();
        conn.mockReturnValueOnce(deadProxy).mockReturnValueOnce(direct.socket).mockReturnValue(after.socket);

        const res = await VlOverWSHandler(makeRequest(), {} as Env, fakeCtx(), null);
        expect(res.status).toBe(101);
        const server = lastPair![1];

        server.fire('message', { data: vlHeader('www.google.com', 443, 'HELLO') });
        await until(() => dnsCalls === 1);
        await tick();
        // پیام payload در پنجره‌ی DNS → بافر می‌شود
        server.fire('message', { data: CLIENT_HELLO.buffer });
        await tick();

        releaseDns(); // واسط prefix حل → connectAndWrite → تخلیه‌ی بافر → نوشته رد می‌شود → fallback مستقیم
        await until(() => direct.written.length >= 1);
        await tick();

        // کلیدی: fallback مستقیم باید «HELLO» (بازپخش rawClientData) و بعد CLIENT_HELLO
        // (chunk تخلیه‌شده‌ی بازیابی‌شده) را بگیرد — قرارداد v0.8.28 در مسیر شکست
        expect(decode(direct.written[0])).toBe('HELLO');
        expect(direct.written).toHaveLength(2);
        expect(direct.written[1][0]).toBe(0x16);

        // پاک‌سازی: EOF مستقیم → retry → سوکت بعدی EOF آنی → تونل تمام، بدون تایمر معلق
        releaseEof();
        await until(() => server.readyState !== 1);
    });
});

// ---------- ۳) گارد مسیر سالم — رفتار معمول proxyip دست‌نخورده بماند ----------

describe('outbound write race — happy path unchanged', () => {
    it('proxyip mode: split messages flow through the writer path in order, replay intact', async () => {
        const { connect } = await import('cloudflare:sockets');
        const { VlOverWSHandler } = await import('../src/protocols/vless');

        hoisted.globals = {
            vlUUID: PROBE_UUID,
            proxyIpMode: 'proxyip',
            prefixes: [],
            forceProxyDomains: [],
        };
        hoisted.effList = ['p1.example:443']; // تک‌کاندیدا → بدون تلاش دوم
        hoisted.resolveDNSImpl = async () => ({ ipv4: ['203.0.113.10'], ipv6: [] });

        let releaseDirectEof!: () => void;
        const directEofGate = new Promise<void>((r) => { releaseDirectEof = r; });
        const direct = gatedRecordingSocket(directEofGate);
        const proxy = recordingSocket();
        const conn = vi.mocked(connect);
        conn.mockReset();
        conn.mockReturnValueOnce(direct.socket).mockReturnValueOnce(proxy.socket);

        const res = await VlOverWSHandler(makeRequest(), {} as Env, fakeCtx(), null);
        expect(res.status).toBe(101);
        const server = lastPair![1];

        server.fire('message', { data: vlHeader('example.com', 80, 'GET /') });
        await until(() => direct.written.length >= 1);
        server.fire('message', { data: CLIENT_HELLO.buffer });
        await until(() => direct.written.length >= 2);

        // حالا EOF مقصد مستقیم → retry از واسط
        releaseDirectEof();
        await until(() => proxy.written.length >= 1);
        await tick();

        expect(decode(direct.written[0])).toBe('GET /');
        expect(direct.written[1][0]).toBe(0x16);
        expect(decode(proxy.written[0])).toBe('GET /'); // بازپخش rawClientData
        expect(proxy.written.length).toBe(1); // چیزی اضافه بافر/بازپخش نشده
    });
});
