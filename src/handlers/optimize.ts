/**
 * بهینه‌ساز منابع — مصرف CPU ورکر Cloudflare
 *
 * مسئله‌ای که این ماژول حل می‌کند:
 *
 * ۱) CPU ورکر: تولید کانفیگ (resolve DNS + ساخت JSON/YAML/base64) روی هر
 *    درخواست اشتراک تکرار می‌شد. حالا بدنه‌ی پاسخ با کلید ETag (که تمام
 *    ورودی‌های تولید — نسخه، تنظیمات، کلاینت، کاربر — را پوشش می‌دهد) در
 *    حافظه‌ی isolate کش می‌شود؛ درخواست‌های تکراری در بازه‌ی TTL صفر CPU
 *    برای تولید کانفیگ دارند و فقط هدرهای per-request دوباره ساخته می‌شوند.
 *
 * فشرده‌سازی اینجا انجام نمی‌شود — عمداً. لبه‌ی Cloudflare با هدر
 * Accept-Encoding کلاینت مذاکره و gzip/brotli را با هدر درست اعمال می‌کند؛
 * اگر ورکر خودش بدنه‌ی فشرده بفرستد، لبه برای کلاینت‌های بدون Accept-Encoding
 * فقط هدر Content-Encoding را حذف می‌کند و بدنه‌ی gzip بی‌اعلام می‌رسد →
 * کلاینت «خطای آپدیت — بدون کانفیگ» می‌بیند (شرح کامل: subscription.ts).
 *
 * مکانیزم کش آگاه از محدودیت حافظه است: LRU با سقف ورودی + سقف اندازه‌ی
 * بدنه — isolate هرگز متورم نمی‌شود.
 */

// ---------- کش بدنه‌ی اشتراک (سطح isolate) ----------

export interface SubCacheEntry {
    body: string;
    contentType: string;
    /** هدرهای پاسخ تولیدکننده — عیناً (بدون Content-Length که حذف شده) */
    headers: [string, string][];
    storedAt: number;
}

const SUB_CACHE_TTL_MS = 5 * 60_000;          // پنج دقیقه — بعد از آن تولید تازه
const SUB_CACHE_MAX_ENTRIES = 12;             // سقف ورودی‌ها (LRU)
const SUB_CACHE_MAX_BODY_BYTES = 256 * 1024;  // بدنه‌های غول‌آسا کش نمی‌شوند

export class SubBodyCache {
    private map = new Map<string, SubCacheEntry>();
    private readonly ttlMs: number;
    private readonly maxEntries: number;
    private readonly maxBodyBytes: number;

    constructor(
        ttlMs: number = SUB_CACHE_TTL_MS,
        maxEntries: number = SUB_CACHE_MAX_ENTRIES,
        maxBodyBytes: number = SUB_CACHE_MAX_BODY_BYTES
    ) {
        this.ttlMs = ttlMs;
        this.maxEntries = maxEntries;
        this.maxBodyBytes = maxBodyBytes;
    }

    get(key: string, now: number = Date.now()): SubCacheEntry | null {
        const entry = this.map.get(key);
        if (!entry) return null;

        if (now - entry.storedAt >= this.ttlMs) {
            this.map.delete(key);
            return null;
        }

        // تازه‌سازی ترتیب LRU
        this.map.delete(key);
        this.map.set(key, entry);
        return entry;
    }

    put(
        key: string,
        body: string,
        contentType: string,
        headers: [string, string][],
        now: number = Date.now()
    ): void {
        // تخمین اندازه: UTF-16 → هر کاراکتر ≈ ۲ بایت؛ سقف محافظه‌کارانه
        if (body.length * 2 > this.maxBodyBytes) return;

        if (!this.map.has(key) && this.map.size >= this.maxEntries) {
            const oldest = this.map.keys().next().value;
            if (oldest !== undefined) this.map.delete(oldest);
        }

        this.map.delete(key);
        this.map.set(key, { body, contentType, headers, storedAt: now });
    }

    /** پاک‌سازی کامل — برای تست‌ها */
    clear(): void {
        this.map.clear();
    }

    /** تعداد ورودی‌های فعلی — برای تست‌ها و رصد */
    get size(): number {
        return this.map.size;
    }
}

/** نمونه‌ی سراسری — در طول عمر isolate زنده می‌ماند */
export const subBodyCache = new SubBodyCache();

