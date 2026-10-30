import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * وچ‌داگ first-byte (v0.8.18):
 * مقصدهای «سیاه‌چاله» (نمونه: اتصال مستقیم به IPهای خود CF) TCP را باز نگه
 * می‌دارند، داده‌ای برنمی‌گردانند و هرگز close نمی‌شوند → retry قدیمی که به
 * رویداد close تکیه داشت هیچ‌وقت فعال نمی‌شد و کاربر «وصل ولی بدون ترافیک»
 * می‌ماند. این تست‌ها تضمین می‌کنند:
 *   ۱) بدون داده در بازه‌ی تایم‌اوت → سوکت بسته می‌شود و retry صدا زده می‌شود
 *   ۲) با رسیدن اولین داده → وچ‌داگ خاموش و retry هرگز اجرا نمی‌شود
 *   ۳) خطای بالادستی وقتی retry در راه است، WS را نمی‌بندد (باگ قبلی)
 */

vi.mock('cloudflare:sockets', () => ({ connect: vi.fn() }));

// ---------- failover زنجیره‌ای (v0.8.19) ----------
// رگرسیون: تا v0.8.18 بستن WS در attemptViaProxy به رویداد closed سوکتِ
// «اولین» تلاش گره خورده بود → اولین واسط/اتصال مرده، WS را قبل از نوبتِ
// failover می‌بست و تلاش دوم هرگز به کلاینت نمی‌رسید. حالا بستن WS فقط
// در remoteSocketToWS (بعد از settle شدن جریان) تصمیم‌گیری می‌شود.

const hoisted = vi.hoisted(() => ({
    effList: ['p1.example:443', 'p2.example:443'] as string[],
}));

vi.mock('@settings', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
        ...actual,
        getGlobals: () => ({ proxyIpMode: 'proxyip', prefixes: [], forceProxyDomains: [] }),
        getEffectiveProxyIPs: () => [...hoisted.effList],
    };
});

// global های بیلد — settings.ts هنگام ایمپورت به آن‌ها نیاز دارد
(globalThis as any).VERSION = '0.8.18';

// یاواس فیک — حداقلِ چیزی که remoteSocketToWS لازم دارد
function fakeWs() {
    const sent: (Uint8Array | ArrayBuffer)[] = [];
    return {
        sent,
        readyState: 1, // OPEN
        send: vi.fn((d: Uint8Array | ArrayBuffer) => sent.push(d)),
        close: vi.fn(),
    } as unknown as WebSocket & { sent: (Uint8Array | ArrayBuffer)[]; send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
}

// سوکت فیک با استریم قابل‌کنترل
function fakeSocket() {
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
    const readable = new ReadableStream<Uint8Array>({
        start(controller) { controllerRef = controller; },
        pull() { /* هنگ عمدی — سیاه‌چاله */ },
    });
    // با close() واقعی سوکت (که وچ‌داگ صدا می‌زند) استریم پایان تمیز می‌یابد
    const socket = {
        readable,
        writable: new WritableStream(),
        close: vi.fn(() => {
            try { controllerRef?.close(); } catch { /* noop */ }
        }),
        closed: Promise.resolve(),
    } as unknown as Socket & { close: ReturnType<typeof vi.fn> };
    return { socket };
}

describe('first-byte watchdog — dead upstream (v0.8.18)', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('no data within timeout → socket closed, retry fires, WS stays open', async () => {
        const { remoteSocketToWS } = await import('../src/protocols/common');
        const { socket } = fakeSocket();
        const ws = fakeWs();
        const retry = vi.fn();

        const done = remoteSocketToWS(socket, ws, null, retry, () => {});

        const assertion = (async () => {
            await vi.advanceTimersByTimeAsync(6_000);
            await done;
            expect(socket.close).toHaveBeenCalled();
            expect(retry).toHaveBeenCalledTimes(1);
            expect(ws.close).not.toHaveBeenCalled(); // WS باید برای retry زنده بماند
        })();
        await Promise.all([done, assertion]);
    });

    it('first data arrives in time → no retry, watchdog disarmed', async () => {
        const { remoteSocketToWS } = await import('../src/protocols/common');
        const { socket } = fakeSocket();
        const ws = fakeWs();
        const retry = vi.fn();

        // استریمی که فوراً یک chunk می‌دهد و می‌بندد
        const payload = new Uint8Array([1, 2, 3]);
        const readable = new ReadableStream<Uint8Array>({
            start(controller) { controller.enqueue(payload); controller.close(); },
        });
        (socket as unknown as { readable: ReadableStream }).readable = readable;

        await remoteSocketToWS(socket, ws, null, retry, () => {});

        await vi.advanceTimersByTimeAsync(60_000); // فراتر از تایم‌اوت — نباید اتفاقی بیفتد
        expect(retry).not.toHaveBeenCalled();
        expect(ws.sent.length).toBe(1);
    });

    it('upstream error with pending retry → WS not closed (old bug)', async () => {
        const { remoteSocketToWS } = await import('../src/protocols/common');
        const ws = fakeWs();
        const retry = vi.fn();

        const readable = new ReadableStream<Uint8Array>({
            start(controller) { controller.error(new Error('reset by peer')); },
        });
        const socket = {
            readable,
            writable: new WritableStream(),
            close: vi.fn(),
            closed: Promise.resolve(),
        } as unknown as Socket;

        await remoteSocketToWS(socket, ws, null, retry, () => {});

        expect(retry).toHaveBeenCalledTimes(1);
        expect(ws.close).not.toHaveBeenCalled();
    });
});

// ---------- زنجیره‌ی failover واقعی handleTCPOutBound (v0.8.19) ----------

describe('failover chain — WS close ownership (v0.8.19)', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    // WS فیک با رفتار واقعی: close() → readyState=2 → send بعدی باید خطا بدهد
    function fakeWsV2() {
        const sent: (Uint8Array | ArrayBuffer)[] = [];
        let state = 1; // OPEN
        return {
            sent,
            get readyState() { return state; },
            send: vi.fn((d: Uint8Array | ArrayBuffer) => { sent.push(d); }),
            close: vi.fn(() => { state = 2; }),
        } as unknown as WebSocket & {
            sent: (Uint8Array | ArrayBuffer)[];
            send: ReturnType<typeof vi.fn>;
            close: ReturnType<typeof vi.fn>;
        };
    }

    // مقصد مرده: TCP باز می‌شود ولی بدون هیچ داده‌ای بسته می‌شود
    function deadSocket() {
        return {
            readable: new ReadableStream<Uint8Array>({ start(c) { c.close(); } }),
            writable: new WritableStream(),
            close: vi.fn(),
            closed: Promise.resolve(),
        } as unknown as Socket;
    }

    // مقصد زنده: یک chunk می‌دهد و تمیز EOF می‌کند
    function liveSocket(payload: Uint8Array) {
        return {
            readable: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(payload); c.close(); } }),
            writable: new WritableStream(),
            close: vi.fn(),
            closed: Promise.resolve(),
        } as unknown as Socket;
    }

    it('direct dead + proxy#1 dead → proxy#2 data reaches client (old bug killed WS)', async () => {
        const { connect } = await import('cloudflare:sockets');
        const { handleTCPOutBound } = await import('../src/protocols/common');
        const payload = new Uint8Array([9, 9, 9]);
        const conn = vi.mocked(connect);
        conn.mockClear();
        conn.mockReturnValueOnce(deadSocket())   // تلاش مستقیم example.com
            .mockReturnValueOnce(deadSocket())   // واسط اول (p1 یا p2)
            .mockReturnValueOnce(liveSocket(payload)); // واسط دوم

        const ws = fakeWsV2();
        void handleTCPOutBound({ value: null }, 'example.com', 80, new Uint8Array([1]), ws, null, () => {});

        for (let i = 0; i < 100 && ws.sent.length === 0; i++) {
            await vi.advanceTimersByTimeAsync(50);
        }
        await vi.advanceTimersByTimeAsync(50); // تسویه‌ی بستن نهایی

        expect(ws.sent.length).toBe(1); // کلیدی‌ترین ادعا: داده‌ی تلاش دوم به کلاینت رسید
        const hosts = conn.mock.calls.map((c) => (c[0] as { hostname: string }).hostname);
        expect(hosts[0]).toBe('example.com');
        // failover باید از یک کاندیدای «متمایز» استفاده کرده باشد
        expect(new Set(hosts.slice(1))).toEqual(new Set(['p1.example', 'p2.example']));
        // EOF تمیزِ مقصدِ موفق → تونل تمام → بستن WS (رفتار درست و جدید)
        expect(ws.close).toHaveBeenCalledTimes(1);
    });

    it('single-candidate pool: direct + proxy dead → WS closed, client not left hanging', async () => {
        const { connect } = await import('cloudflare:sockets');
        const { handleTCPOutBound } = await import('../src/protocols/common');
        hoisted.effList = ['solo.example:443'];
        const conn = vi.mocked(connect);
        conn.mockClear();
        conn.mockReturnValueOnce(deadSocket()).mockReturnValueOnce(deadSocket());

        const ws = fakeWsV2();
        void handleTCPOutBound({ value: null }, 'example.com', 80, new Uint8Array([1]), ws, null, () => {});

        for (let i = 0; i < 100 && ws.close.mock.calls.length === 0; i++) {
            await vi.advanceTimersByTimeAsync(50);
        }

        expect(conn).toHaveBeenCalledTimes(2); // مستقیم + تنها واسط — تلاش سومی وجود ندارد
        expect(ws.sent.length).toBe(0);
        expect(ws.close).toHaveBeenCalledTimes(1);
        hoisted.effList = ['p1.example:443', 'p2.example:443']; // بازگردانی برای تست‌های دیگر
    });
});

// ---------- سلامتِ ProxyIP کلاینت-آگاه + retry بی‌فایده (v0.8.29) ----------
// رگرسیون: کلاینتِ رفته (flap موبایل/تب بسته) قبل از رسیدن اولین بایتِ دانلود،
// قبلاً دو آسیب می‌زد: (۱) واسطِ سالم markProxyFail می‌خورد (cooldown نمایی تا
// ۱۰ دقیقه) و انتخاب وزنی خراب می‌شد؛ (۲) زنجیره‌ی retry برای نشستِ مرده باز
// connect می‌زد و واسط‌های بعدی را هم جریمه می‌کرد. این تست‌ها تضمین می‌کنند:
//   ۱) کلاینتِ مرده = هیچ اثری روی رجیستری سلامت + هیچ connect بیهوده
//   ۲) مرگ وسطِ زنجیره = تلاشِ در حال پرواز جریمه نمی‌خورد، زنجیره همان‌جا تمام

describe('proxy health is client-aware (v0.8.29)', () => {
    // سوکت سیاه‌چاله: TCP باز، نه داده نه close — وچ‌داگ باید ببنددش
    function silentSocket() {
        let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
        const readable = new ReadableStream<Uint8Array>({
            start(controller) { controllerRef = controller; },
            pull() { /* هنگ عمدی — سیاه‌چاله */ },
        });
        return {
            readable,
            writable: new WritableStream(),
            close: vi.fn(() => {
                try { controllerRef?.close(); } catch { /* noop */ }
            }),
            closed: Promise.resolve(),
        } as unknown as Socket & { close: ReturnType<typeof vi.fn> };
    }

    // WS با مرگِ شبیه‌سازی‌شده‌ی کلاینت (بدون close سمت سرور — مثل flap واقعی)
    function clientWs() {
        const sent: (Uint8Array | ArrayBuffer)[] = [];
        let state = 1; // OPEN
        return {
            sent,
            get readyState() { return state; },
            send: vi.fn((d: Uint8Array | ArrayBuffer) => { sent.push(d); }),
            close: vi.fn(() => { state = 2; }),
            kill: () => { state = 3; }, // CLOSED — کلاینت رفت
        } as unknown as WebSocket & {
            sent: (Uint8Array | ArrayBuffer)[];
            send: ReturnType<typeof vi.fn>;
            close: ReturnType<typeof vi.fn>;
            kill: () => void;
        };
    }

    let rnd: ReturnType<typeof vi.spyOn>;
    let runId = 0;

    beforeEach(() => {
        vi.useFakeTimers();
        runId += 1;
        // نام‌های یکتا برای هر اجرا — رجیستری سلامت در سطح ماژول است و تست‌های
        // بالادستِ همین فایل (زنجیره‌ی failover) واسط‌های خودشان را markProxyFail
        // می‌کنند؛ ادعای این describe باید مستقل از آن وضعیت بماند.
        hoisted.effList = [`pa${runId}.example:443`, `pb${runId}.example:443`];
        // رو Roulette وزنی قطعی‌بودن بدهیم — اولین کاندیدای سالم انتخاب شود
        rnd = vi.spyOn(Math, 'random').mockReturnValue(0);
    });
    afterEach(() => {
        rnd.mockRestore();
        vi.useRealTimers();
        hoisted.effList = ['p1.example:443', 'p2.example:443'];
    });

    it('client gone from the start → chain stops after direct, proxies untouched', async () => {
        const { connect } = await import('cloudflare:sockets');
        const { handleTCPOutBound, pickProxyIP } = await import('../src/protocols/common');
        const conn = vi.mocked(connect);
        conn.mockClear();
        conn.mockImplementation(() => silentSocket());

        const ws = clientWs();
        ws.kill(); // کلاینت قبل از هر تلاشی رفته
        void handleTCPOutBound({ value: null }, 'example.com', 80, new Uint8Array([1]), ws, null, () => {});

        await vi.advanceTimersByTimeAsync(7_000); // فراتر از وچ‌داگ ۶ ثانیه‌ای

        // فقط اتصال مستقیم — نه واسط اول، نه تلاش دوم برای نشستِ مرده
        expect(conn).toHaveBeenCalledTimes(1);
        // فرصت تسویه برای هر تلاشِ رهاشده‌ی کد قدیمی (وچ‌داگ واسط ~۱۲ثانیه) —
        // بعدش هم هیچ واسطی نباید cooldown خورده باشد
        await vi.advanceTimersByTimeAsync(6_000);
        // هیچ واسطی cooldown نخورده → pa همچنان اولین انتخاب سالم است
        // (کد قدیمی: pa جریمه → کاندیدای بعدی برمی‌گشت)
        expect(pickProxyIP([`pa${runId}.example:443`, `pb${runId}.example:443`, 'untouched.example:443'])).toBe(`pa${runId}.example:443`);
    });

    it('client dies mid-chain → in-flight proxy not penalized, no further attempts', async () => {
        const { connect } = await import('cloudflare:sockets');
        const { handleTCPOutBound, pickProxyIP } = await import('../src/protocols/common');
        const conn = vi.mocked(connect);
        conn.mockClear();
        conn.mockImplementation(() => silentSocket());

        const ws = clientWs(); // اول زنده
        void handleTCPOutBound({ value: null }, 'example.com', 80, new Uint8Array([1]), ws, null, () => {});

        // وچ‌داگ مستقیم (۶ ثانیه) → settle → retry → connect واسط اول؛
        // وچ‌داگِ واسط هنوز (~۱۲ثانیه) نایستاده — پنجره‌ی مرگ کلاینت
        await vi.advanceTimersByTimeAsync(7_000);
        expect(conn).toHaveBeenCalledTimes(2); // مستقیم + واسط اول — کلاینت هنوز زنده بود
        ws.kill(); // کلاینت وسط زنجیره رفت

        await vi.advanceTimersByTimeAsync(7_000); // وچ‌داگ تلاشِ در حال پرواز را می‌بندد

        // تلاش سوم برای نشستِ مرده انجام نشد (کد قدیمی: ۳ بار connect)
        expect(conn).toHaveBeenCalledTimes(2);
        // واسطِ در حال پرواز جریمه نخورد (کد قدیمی: pa cooldown → کاندیدای بعدی)
        expect(pickProxyIP([`pa${runId}.example:443`, `pb${runId}.example:443`, 'untouched.example:443'])).toBe(`pa${runId}.example:443`);
    });
});
