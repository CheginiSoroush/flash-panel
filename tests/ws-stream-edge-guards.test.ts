import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * v0.8.59 — دو گاردِ لبه در protocols/common.ts
 *
 * ۱) makeReadableWebSocketStream — لیسنر message فقط readableStreamCancel را
 *    چک می‌کرد، نه streamEnded. بعد از controller.error (رویداد error WS)،
 *    enqueue روی استریمِ errored طبق WHATWG spec پرتاب می‌کند و این پرتاب داخل
 *    لیسنر WS هیچ گیرنده‌ای ندارد → TypeError ثبت‌نشده به‌ازای هر پیامِ دیررس
 *    (بین error و بسته‌شدن واقعی WS). فیکس: گارد دوگانه مثل لیسنرهای close/error.
 *
 * ۲) convertToNAT64IPv6 — prefix بدون فرمت [...] صامت undefined برمی‌گرداند در
 *    حالی که قرارداد مستند resolveProxyTarget می‌گوید «خطای prefix با exception
 *    بالا می‌آید — caller تصمیم می‌گیرد». فیکس: پرتاب صریح 'Invalid NAT64 prefix
 *    format' → پیام بستن/لاگ دلیل واقعی را نشان می‌دهد نه 'Invalid Prefix' عمومی؛
 *    کنترل‌فلو هر دو caller (retry → close؛ forced → fallback مستقیم) عیناً حفظ
 *    می‌شود چون مسیر throw از قبل try/catch دارد.
 *
 * پوشش این فایل:
 *   ۱) 🔒 پیام دیررس بعد از error → هیچ پرتابی در لیسنر — RED روی قدیمی (TypeError)
 *   ۲) گارد: جریان سالم (پیام → enqueue، close → done) دست‌نخورده
 *   ۳) 🔒 prefix خراب در زنجیره‌ی retry → close با دلیل صریح — RED روی قدیمی ('Invalid Prefix')
 */

vi.mock('cloudflare:sockets', () => ({ connect: vi.fn() }));

const hoisted = vi.hoisted(() => ({
    mode: 'prefix' as 'prefix' | 'proxyip',
    prefixes: ['bogus-unbracketed-prefix'] as string[],
}));

vi.mock('@settings', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
        ...actual,
        getGlobals: () => ({
            proxyIpMode: hoisted.mode,
            prefixes: hoisted.prefixes,
            forceProxyDomains: [],
        }),
        getEffectiveProxyIPs: () => ['p1.example:443'],
    };
});

vi.mock('@utils', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
        ...actual,
        resolveDNS: async () => ({ ipv4: ['1.2.3.4'] }),
    };
});

(globalThis as any).VERSION = '0.8.59';

// ---------- WS فیک با dispatch قابل‌کنترل + ثبت پرتابِ لیسنرها ----------

function fakeEventWs() {
    const handlers: Record<string, Array<(ev: { data?: unknown }) => void>> = {};
    const listenerErrors: unknown[] = [];

    const ws = {
        readyState: 1, // OPEN — safeCloseWebSocket داخلش را می‌بندد
        close: vi.fn(),
        addEventListener: (type: string, fn: (ev: { data?: unknown }) => void) => {
            (handlers[type] ??= []).push(fn);
        },
    };
    const dispatch = (type: string, ev: { data?: unknown } = {}) => {
        for (const h of handlers[type] ?? []) {
            try {
                h(ev);
            } catch (e) {
                listenerErrors.push(e);
            }
        }
    };
    return { ws, dispatch, listenerErrors };
}

async function readAll(stream: ReadableStream): Promise<unknown[]> {
    const reader = stream.getReader();
    const chunks: unknown[] = [];
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
    }
    return chunks;
}

// ---------- ۱) گارد پیام دیررس بعد از error ----------

describe('makeReadableWebSocketStream — late message after error (v0.8.59)', () => {
    it('🔒 پیام بعد از رویداد error دیگر داخل لیسنر پرتاب نمی‌کند (بدون TypeError ثبت‌نشده)', async () => {
        const { makeReadableWebSocketStream } = await import('../src/protocols/common');
        const { ws, dispatch, listenerErrors } = fakeEventWs();

        const stream = makeReadableWebSocketStream(ws as unknown as WebSocket, '', () => {});

        // خطای WS → controller.error → streamEnded
        dispatch('error', {});
        expect((await stream.getReader().read().then(r => r.done, () => 'errored'))).not.toBe(undefined);

        // پیام دیررس — روی کد قدیمی: enqueue روی استریم errored → TypeError داخل لیسنر
        dispatch('message', { data: new Uint8Array([1, 2, 3]) });

        expect(listenerErrors).toHaveLength(0);
    });

    it('گارد: جریان سالم — پیام‌ها enqueue و close پایان تمیز', async () => {
        const { makeReadableWebSocketStream } = await import('../src/protocols/common');
        const { ws, dispatch, listenerErrors } = fakeEventWs();

        const stream = makeReadableWebSocketStream(ws as unknown as WebSocket, '', () => {});
        const chunks = readAll(stream);

        dispatch('message', { data: new Uint8Array([7, 7]) });
        dispatch('message', { data: new Uint8Array([9]) });
        dispatch('close', {});

        const received = await chunks;
        expect(received).toHaveLength(2);
        expect(Array.from(received[0] as Uint8Array)).toEqual([7, 7]);
        expect(listenerErrors).toHaveLength(0);
    });
});

// ---------- ۲) قرارداد پرتاب صریح prefix خراب (زنجیره‌ی retry واقعی) ----------

describe('convertToNAT64IPv6 — unbracketed prefix throws explicitly (v0.8.59)', () => {
    function deadSocket() {
        return {
            readable: new ReadableStream<Uint8Array>({ start(c) { c.close(); } }),
            writable: new WritableStream(),
            close: vi.fn(),
            closed: Promise.resolve(),
        } as unknown as Socket;
    }

    function fakeWsV2() {
        let state = 1;
        return {
            get readyState() { return state; },
            send: vi.fn(),
            close: vi.fn(() => { state = 2; }),
        } as unknown as WebSocket & { close: ReturnType<typeof vi.fn> };
    }

    beforeEach(() => {
        vi.useFakeTimers();
        hoisted.mode = 'prefix';
        hoisted.prefixes = ['bogus-unbracketed-prefix'];
    });
    afterEach(() => {
        hoisted.mode = 'proxyip';
        vi.useRealTimers();
    });

    it('🔒 مستقیم مرده + prefix خراب → بستن با دلیل صریح «Invalid NAT64 prefix format»', async () => {
        const { connect } = await import('cloudflare:sockets');
        const { handleTCPOutBound } = await import('../src/protocols/common');
        const conn = vi.mocked(connect);
        conn.mockClear();
        conn.mockImplementation(() => deadSocket());

        const ws = fakeWsV2();
        void handleTCPOutBound({ value: null }, 'example.com', 80, new Uint8Array([1]), ws, null, () => {});

        for (let i = 0; i < 100 && ws.close.mock.calls.length === 0; i++) {
            await vi.advanceTimersByTimeAsync(50);
        }

        expect(ws.close).toHaveBeenCalledTimes(1);
        // 🔴 روی کد قدیمی: 'Retry connection failed: Invalid Prefix' (عمومی — دلیل گم شده)
        const reason = String(ws.close.mock.calls[0]?.[1] ?? '');
        expect(reason).toContain('Invalid NAT64 prefix format');
    });
});
