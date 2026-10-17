import { describe, it, expect, vi, beforeAll } from 'vitest';

// globals حداقلی — قبل از import ماژول‌های وابسته به @settings
(globalThis as any).VERSION = '0.7.5';

// cloudflare:sockets در node وجود ندارد — فقط ماژول mock می‌شود (الگوی perf-stealth.test.ts)
vi.mock('cloudflare:sockets', () => ({
    connect: vi.fn(() => { throw new Error('not used in tests'); })
}));

let resolveForceList: (adminList?: string[]) => string[];
let shouldForceProxy: (address: string, domains: string[]) => boolean;
let DEFAULT_FORCE_PROXY_DOMAINS: string[];

beforeAll(async () => {
    ({
        resolveForceList,
        shouldForceProxy,
        DEFAULT_FORCE_PROXY_DOMAINS
    } = await import('@protocols/common'));
});

describe('resolveForceList — تبدیل تنظیم ادمین به لیست فعال', () => {
    it('نبودِ کلید (undefined) → پیش‌فرض داخلی (رفتار v0.7.3+)', () => {
        expect(resolveForceList(undefined)).toBe(DEFAULT_FORCE_PROXY_DOMAINS);
    });

    it('[] → صریحاً خاموش (رفع باگ v0.7.3 که [] هم به پیش‌فرض برمی‌گشت)', () => {
        const list = resolveForceList([]);
        expect(list).toEqual([]);
        expect(list).not.toBe(DEFAULT_FORCE_PROXY_DOMAINS);
    });

    it('لیست ادمین عیناً پاس می‌شود', () => {
        const admin = ['example.com', 'test.org'];
        expect(resolveForceList(admin)).toBe(admin);
    });
});

describe('shouldForceProxy — تطبیق دامنه', () => {
    it('لیست خالی → هیچ دامنه‌ای force نمی‌شود (حالت معمول/خاموش)', () => {
        expect(shouldForceProxy('www.google.com', [])).toBe(false);
        expect(shouldForceProxy('gemini.google.com', [])).toBe(false);
    });

    it('با لیست پیش‌فرض، دامنه‌های گوگل/OpenAI و زیردامنه‌ها force می‌شوند', () => {
        expect(shouldForceProxy('www.google.com', DEFAULT_FORCE_PROXY_DOMAINS)).toBe(true);
        expect(shouldForceProxy('gemini.google.com', DEFAULT_FORCE_PROXY_DOMAINS)).toBe(true);
        expect(shouldForceProxy('chatgpt.com', DEFAULT_FORCE_PROXY_DOMAINS)).toBe(true);
        expect(shouldForceProxy('a.b.googleapis.com', DEFAULT_FORCE_PROXY_DOMAINS)).toBe(true);
    });

    it('دامنه‌های نامرتبط force نمی‌شوند + پسوند فریبنده (notgoogle.com) تطبیق نیست', () => {
        expect(shouldForceProxy('www.youtube.com', DEFAULT_FORCE_PROXY_DOMAINS)).toBe(false);
        expect(shouldForceProxy('notgoogle.com', DEFAULT_FORCE_PROXY_DOMAINS)).toBe(false);
        expect(shouldForceProxy('example.com', [])).toBe(false);
    });

    it('IP literal هرگز force نمی‌شود', () => {
        expect(shouldForceProxy('1.2.3.4', DEFAULT_FORCE_PROXY_DOMAINS)).toBe(false);
        expect(shouldForceProxy('2606:4700::1', DEFAULT_FORCE_PROXY_DOMAINS)).toBe(false);
    });
});
