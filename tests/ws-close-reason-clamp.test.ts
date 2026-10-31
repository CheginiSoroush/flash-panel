// v0.8.60 — رگرسیون سقف بایتی reason بستن WS
//
// باگ: webSocket.close(1011, `... ${safeError(error)}`) بدون سقف طول reason.
// اثبات wire-level با wrangler dev محلی (workerd):
//   reason ≤ 123 بایت  → کلاینت کد 1011 و دلیل را می‌گیرد ✓
//   reason ≥ 124 بایت  → close() «موفق» ولی فریم نامعتبر می‌شود؛ کلاینت
//                        1002 "Protocol error - invalid control frame" با
//                        clean=false می‌گیرد — دلیل تشخیصی گم و بستن تمیز
//                        به خطای پروتکل تبدیل می‌شود.
// فیکس: safeCloseWebSocketWithReason — کلمپ بایت-ایمن UTF-8 (بدون نصف‌کردن
// دنباله‌ی چندبایتی) روی هر شش مسیر خطای protocols/common.ts.

import { describe, it, expect, vi, beforeAll } from 'vitest';

// cloudflare:sockets در node وجود ندارد — ماک خنثی (الگوی force-proxy.test.ts)؛
// فقط توابع clamp/close تحت آزمایش‌اند، نه سوکت واقعی
vi.mock('cloudflare:sockets', () => ({ connect: vi.fn() }));

// VERSION ثابت build-time است — پیش از ارزیابی زنجیره‌ی @settings مقداردهی می‌شود
(globalThis as Record<string, unknown>).VERSION = '0.8.60';

import { safeError } from '@common';

let clampWsCloseReason: typeof import('@protocols/common').clampWsCloseReason;
let safeCloseWebSocketWithReason: typeof import('@protocols/common').safeCloseWebSocketWithReason;
let WS_CLOSE_REASON_MAX_BYTES: number;

beforeAll(async () => {
    // درونجگرا: import آزمودنی باید بعد از مقداردهی VERSION انجام شود (الگوی ws-stream-edge-guards)
    const mod = await import('@protocols/common');
    clampWsCloseReason = mod.clampWsCloseReason;
    safeCloseWebSocketWithReason = mod.safeCloseWebSocketWithReason;
    WS_CLOSE_REASON_MAX_BYTES = mod.WS_CLOSE_REASON_MAX_BYTES;
});

/** طول بایتی UTF-8 */
const utf8Len = (s: string) => new TextEncoder().encode(s).length;

/** اعتبار UTF-8 — decode سخت‌گیر نباید پرتاب کند و U+FFFD نباید ببیند */
const isValidUtf8 = (s: string) => {
    try {
        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(new TextEncoder().encode(s));
        return !decoded.includes('\uFFFD');
    } catch {
        return false;
    }
};

describe('clampWsCloseReason', () => {
    it('ASCII بلندتر از سقف → دقیقاً ۱۲۳ بایت با حفظ پیشوند', () => {
        const long = 'Retry connection failed: ' + 'x'.repeat(500);
        const clamped = clampWsCloseReason(long);
        expect(clamped.length).toBe(WS_CLOSE_REASON_MAX_BYTES);
        expect(utf8Len(clamped)).toBeLessThanOrEqual(WS_CLOSE_REASON_MAX_BYTES);
        expect(clamped.startsWith('Retry connection failed: ')).toBe(true);
    });

    it('مرز دقیق — ۱۲۳ بایت دست‌نخورده، ۱۲۴ بایت برش می‌خورد', () => {
        const ok123 = 'a'.repeat(123);
        expect(clampWsCloseReason(ok123)).toBe(ok123);
        expect(clampWsCloseReason('a'.repeat(124))).toHaveLength(123);
    });

    it('متن چندبایتی (فارسی) → سقف بایتی رعایت و UTF-8 معتبر می‌ماند', () => {
        // هر حرف فارسی ۲ بایت UTF-8 — ۱۰۰ حرف = ۲۰۰ بایت
        const persian = 'اتصال ناموفق بود: ' + 'پ'.repeat(100);
        const clamped = clampWsCloseReason(persian);
        expect(utf8Len(clamped)).toBeLessThanOrEqual(WS_CLOSE_REASON_MAX_BYTES);
        expect(isValidUtf8(clamped)).toBe(true);
        expect(clamped.startsWith('اتصال ناموفق بود: ')).toBe(true);
    });

    it('ایموجی ۴بایتی روی مرز برش → دنباله نصف نمی‌شود', () => {
        // ۳۰ ایموجی = ۱۲۰ بایت؛ بعدش ایموجی کامل دیگر — برش نباید وسط دنباله بیفتد
        const emoji = '💥'.repeat(40); // 160 بایت
        const clamped = clampWsCloseReason(emoji);
        expect(utf8Len(clamped)).toBeLessThanOrEqual(WS_CLOSE_REASON_MAX_BYTES);
        expect(isValidUtf8(clamped)).toBe(true);
        // تعداد ایموجی‌های سالم = طول بایتی / ۴
        expect(utf8Len(clamped) % 4).toBe(0);
    });

    it('maxBytes ≤ 0 → رشته‌ی خالی', () => {
        expect(clampWsCloseReason('anything', 0)).toBe('');
        expect(clampWsCloseReason('anything', -5)).toBe('');
    });
});

describe('safeCloseWebSocketWithReason', () => {
    function makeFakeWs(readyState: number, closeImpl?: (code?: number, reason?: string) => void) {
        return {
            readyState,
            close: closeImpl ?? vi.fn(),
        } as unknown as WebSocket;
    }

    it('reason بلند تولیدیِ مسیر خطا → close با reason کلمپ‌شده و کد دست‌نخورده', () => {
        // دقیقاً همان شکلی که در مسیرهای خطای handleTCPOutBound ساخته می‌شود
        const rawError = new Error('getaddrinfo EAI_AGAIN ' + 'd'.repeat(200));
        const reason = `Retry connection failed: ${safeError(rawError)}`;
        expect(utf8Len(reason)).toBeGreaterThan(WS_CLOSE_REASON_MAX_BYTES); // پیش‌شرط باگ

        const close = vi.fn();
        const ws = makeFakeWs(1 /* OPEN */, close);
        safeCloseWebSocketWithReason(ws, 1011, reason);

        expect(close).toHaveBeenCalledTimes(1);
        const [code, sentReason] = close.mock.calls[0];
        expect(code).toBe(1011);
        expect(utf8Len(sentReason)).toBeLessThanOrEqual(WS_CLOSE_REASON_MAX_BYTES);
        expect(sentReason.startsWith('Retry connection failed: ')).toBe(true);
    });

    it('کوتاه‌تر از سقف → عیناً همان reason عبور می‌کند', () => {
        const close = vi.fn();
        const ws = makeFakeWs(1, close);
        safeCloseWebSocketWithReason(ws, 1011, 'Retry connection failed: Invalid Prefix');
        expect(close).toHaveBeenCalledWith(1011, 'Retry connection failed: Invalid Prefix');
    });

    it('WS بسته/CLOSING و در حال پرتاب close → بدون گیرنده و بدون اثر جانبی', () => {
        // closed (3) — close اصلاً نباید صدا زده شود (هم‌گارد safeCloseWebSocket)
        const closedWs = makeFakeWs(3, vi.fn());
        expect(() => safeCloseWebSocketWithReason(closedWs, 1011, 'x'.repeat(500))).not.toThrow();
        expect(closedWs.close).not.toHaveBeenCalled();

        // open ولی close پرتاب می‌کند (spec-violation دفاعی) — خورده می‌شود
        const throwingClose = vi.fn(() => { throw new Error('already closing'); });
        const throwingWs = makeFakeWs(1, throwingClose);
        expect(() => safeCloseWebSocketWithReason(throwingWs, 1011, 'x'.repeat(500))).not.toThrow();
        expect(throwingClose).toHaveBeenCalledTimes(1);
    });
});
