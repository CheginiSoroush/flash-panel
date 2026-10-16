/**
 * بهینه‌ساز منابع — مصرف CPU ورکر Cloudflare + مصرف داده‌ی کاربر
 *
 * دو مسئله‌ی اصلی که این ماژول حل می‌کند:
 *
 * ۱) CPU ورکر: تولید کانفیگ (resolve DNS + ساخت JSON/YAML/base64) روی هر
 *    درخواست اشتراک تکرار می‌شد. حالا بدنه‌ی پاسخ با کلید ETag (که تمام
 *    ورودی‌های تولید — نسخه، تنظیمات، کلاینت، کاربر — را پوشش می‌دهد) در
 *    حافظه‌ی isolate کش می‌شود؛ درخواست‌های تکراری در بازه‌ی TTL صفر CPU
 *    برای تولید کانفیگ دارند و فقط هدرهای per-request دوباره ساخته می‌شوند.
 *
 * ۲) مصرف داده: بدنه‌های اشتراک (JSON ایکس‌ری / YAML کلش / base64 رَو)
 *    متنی و به‌شدت فشرده‌پذیرند (~۷۰-۸۰٪ کاهش). gzip با CompressionStream
 *    بومی ورکر فقط وقتی اعمال می‌شود که کلاینت پذیرفته باشد و بدنه از آستانه
 *    بزرگ‌تر باشد — پاسخ‌های ریز فشرده نمی‌شوند (سربار بی‌فایده).
 *
 * هر دو مکانیزم آگاه از محدودیت حافظه‌اند: LRU با سقف ورودی + سقف اندازه‌ی
 * بدنه — isolate هرگز متورم نمی‌شود.
 */

// ---------- کش بدنه‌ی اشتراک (سطح isolate) ----------

export interface SubCacheEntry {
    body: string;
    contentType: string;
    /** هدرهای پاسخ تولیدشده — غیر از Cache-Control که per-request بازنویسی می‌شود */
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

// ---------- فشرده‌سازی gzip ----------

/** زیر این اندازه، سربار فشرده‌سازی از صرفه‌ی پهنای باند بیشتر است */
const GZIP_MIN_BYTES = 1024;

/**
 * کلاینت gzip را می‌پذیرد؟ (RFC 7231)
 * - توکن gzip باید حاضر باشد
 * - gzip;q=0 صریح یعنی «نپذیرفتن» — رعایت می‌شود
 */
export function acceptsGzip(acceptEncoding: string | null): boolean {
    if (!acceptEncoding) return false;
    if (!/\bgzip\b/i.test(acceptEncoding)) return false;

    // q=0 (یا 0.0) صریح — gzip ممنوع
    const params = acceptEncoding.split(',');
    for (const part of params) {
        const m = part.trim().match(/^gzip\s*;\s*q\s*=\s*(\d(?:\.\d+)?)$/i);
        if (m && Number(m[1]) === 0) return false;
    }

    return true;
}

/** تصمیم نهایی فشرده‌سازی — آستانه‌ی اندازه + پذیرش کلاینت */
export function shouldGzip(acceptEncoding: string | null, bodyLength: number): boolean {
    return bodyLength >= GZIP_MIN_BYTES && acceptsGzip(acceptEncoding);
}

/** فشرده‌سازی gzip بومی ورکر (CompressionStream — بدون کتابخانه‌ی خارجی) */
export async function gzipCompress(text: string): Promise<Uint8Array<ArrayBuffer>> {
    const stream = new Blob([text])
        .stream()
        .pipeThrough(new CompressionStream('gzip'));

    return new Uint8Array(await new Response(stream).arrayBuffer());
}
