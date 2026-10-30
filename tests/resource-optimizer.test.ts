import { describe, it, expect } from 'vitest';
import { SubBodyCache } from '@handlers/optimize';

// ============================
// SubBodyCache — TTL، LRU، سقف اندازه
// ============================
describe('SubBodyCache', () => {
    it('hit/miss ساده', () => {
        const cache = new SubBodyCache();
        expect(cache.get('a')).toBeNull();

        cache.put('a', '{"cfg":1}', 'application/json', [['x-test', '1']]);
        const entry = cache.get('a');
        expect(entry?.body).toBe('{"cfg":1}');
        expect(entry?.contentType).toBe('application/json');
        expect(entry?.headers).toEqual([['x-test', '1']]);
        expect(cache.size).toBe(1);
    });

    it('انقضای TTL — بعد از پنج دقیقه برگرداندن null و حذف ورودی', () => {
        const cache = new SubBodyCache(5_000); // TTL کوتاه برای تست
        cache.put('k', 'body', 'text/plain', [], 0);

        expect(cache.get('k', 4_999)).not.toBeNull();
        expect(cache.get('k', 5_000)).toBeNull(); // مرز: >= TTL منقضی
        expect(cache.size).toBe(0);

        // دوباره put بعد از انقضا — بدون رشد غیرمعمول
        cache.put('k', 'fresh', 'text/plain', [], 5_100);
        expect(cache.get('k', 5_100)?.body).toBe('fresh');
    });

    it('LRU — قدیمی‌ترین دست‌نخورده حذف می‌شود، دست‌خورده می‌ماند', () => {
        const cache = new SubBodyCache(60_000, 3);

        cache.put('a', 'A', 'text/plain', []);
        cache.put('b', 'B', 'text/plain', []);
        cache.put('c', 'C', 'text/plain', []);

        cache.get('a', 100); // a تازه می‌شود → b قدیمی‌ترین

        cache.put('d', 'D', 'text/plain', [], 200); // باید b حذف شود
        expect(cache.get('b', 200)).toBeNull();
        expect(cache.get('a', 200)?.body).toBe('A');
        expect(cache.get('c', 200)?.body).toBe('C');
        expect(cache.get('d', 200)?.body).toBe('D');
        expect(cache.size).toBe(3);
    });

    it('put تکراری همان کلید — مقدار جایگزین و رشد دوبرابر نمی‌شود', () => {
        const cache = new SubBodyCache(60_000, 2);
        cache.put('a', 'old', 'text/plain', []);
        cache.put('b', 'B', 'text/plain', []);
        cache.put('a', 'new', 'text/plain', []); // جایگزینی بدون evict

        expect(cache.size).toBe(2);
        expect(cache.get('a', 0)?.body).toBe('new');
        expect(cache.get('b', 0)?.body).toBe('B');
    });

    it('بدنه‌های بزرگ‌تر از سقف کش نمی‌شوند (حفاظ حافظه)', () => {
        const cache = new SubBodyCache(60_000, 10, 100); // سقف ۱۰۰ بایت
        const big = 'x'.repeat(51); // ×2 بایت UTF-16 = 102 > 100

        cache.put('big', big, 'text/plain', []);
        expect(cache.get('big')).toBeNull();

        const ok = 'x'.repeat(50); // دقیقاً ۱۰۰ بایت
        cache.put('ok', ok, 'text/plain', []);
        expect(cache.get('ok')?.body).toBe(ok);
    });

    it('clear همه را پاک می‌کند', () => {
        const cache = new SubBodyCache();
        cache.put('a', 'A', 'text/plain', []);
        cache.put('b', 'B', 'text/plain', []);
        cache.clear();
        expect(cache.size).toBe(0);
        expect(cache.get('a')).toBeNull();
    });
});
