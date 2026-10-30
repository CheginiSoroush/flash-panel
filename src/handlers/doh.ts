import { getGlobals } from '@settings';
import { safeError } from '@common';

/**
 * DoH proxy با استفاده‌ی مجدد از اتصال (RFC 8484):
 * - کش پاسخ DNS با TTL واقعی (کمینه‌ی TTL رکوردهای پاسخ، کلمپ ۱۰..۳۰۰ ثانیه)
 * - single-flight: کوئری‌های همزمان یکسان فقط یک رفت‌وبرگشت به بالادستی دارند
 * - LRU با سقف مشخص برای مهار حافظه‌ی isolate
 * - stale-on-error: خرابی بالادستی → سرو نسخه‌ی کهنه (تا از دسترس‌خارج شدن DNS جلوگیری شود)
 * - هدر X-DNS-Cache برای رصد: HIT / MISS / STALE / BYPASS
 *
 * نکته: در Workers اتصال به یک origin به‌صورت خودکار بین درخواست‌های یک isolate
 * استفاده‌ی مجدد می‌شود؛ لایه‌ی کش + single-flight در واقع تعداد رفت‌وبرگشت‌های
 * بالادستی را به‌شدت کم می‌کند (معماری معادل connection pooling).
 */

const DOH_CACHE_LIMIT = 256;      // سقف ورودی‌های کش (LRU)
const DOH_MIN_TTL = 10;           // کلمپ پایین TTL
const DOH_MAX_TTL = 300;          // کلمپ بالا TTL — پاسخ‌های DNS نباید خیلی کهنه شوند
const DOH_NEGATIVE_TTL = 30;      // کش منفی (NXDOMAIN/NODATA یا خطای parse)

interface DohUpstreamResult {
    body: Uint8Array;
    ttl: number;              // ثانیه؛ ۰ یعنی کش نشود
    contentType: string;
}

interface CacheEntry {
    body: Uint8Array;         // بایت‌های پاسخ DNS (ID هر بار بازنویسی می‌شود)
    contentType: string;
    expiresAt: number;
}

const cache = new Map<string, CacheEntry>();   // ترتیب Map = LRU
const inflight = new Map<string, Promise<DohUpstreamResult>>();

/** پاک‌کردن کش — برای تست‌ها و تغییر dohUrl از پنل */
export function clearDohCache() {
    cache.clear();
    inflight.clear();
}

// ---------- هدر DNS (RFC 1035) ----------

interface DnsHeader {
    id: number;
    flags: number;
    qdcount: number;
    ancount: number;
}

export function parseDnsHeader(msg: Uint8Array): DnsHeader | null {
    if (msg.length < 12) return null;
    const view = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
    return {
        id: view.getUint16(0),
        flags: view.getUint16(2),
        qdcount: view.getUint16(4),
        ancount: view.getUint16(6)
    };
}

/**
 * رد شدن از یک نام دامنه (QNAME/OWNER) — آگاه از compression pointer.
 * آفست بعد از پایان نام را برمی‌گرداند؛ -۱ یعنی خراب.
 */
function skipName(msg: Uint8Array, offset: number): number {
    for (;;) {
        if (offset >= msg.length) return -1;
        const len = msg[offset];
        if ((len & 0xC0) === 0xC0) return offset + 2;   // pointer — نام اینجا تمام می‌شود
        if (len === 0) return offset + 1;
        offset += 1 + len;
    }
}

/**
 * کمینه‌ی TTL رکوردهای ANSWER را از پیام DNS خام برمی‌گرداند:
 * - عدد > ۰ → TTL معتبر
 * - ۰ → حداقل یک رکورد بی‌ثبات (TTL=۰) — نباید کش شود
 * - null → بدون ANSWER (کش منفی) یا خطای parse (نگه‌داری محافظه‌کارانه‌ی کوتاه)
 */
export function minAnswerTtl(msg: Uint8Array): number | null {
    try {
        const header = parseDnsHeader(msg);
        if (!header) return null;

        const view = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
        let offset = 12;

        for (let i = 0; i < header.qdcount; i++) {
            offset = skipName(msg, offset);
            if (offset < 0 || offset + 4 > msg.length) return null;
            offset += 4; // QTYPE + QCLASS
        }

        let minTtl: number | null = null;
        for (let i = 0; i < header.ancount; i++) {
            offset = skipName(msg, offset);
            if (offset < 0 || offset + 10 > msg.length) return minTtl;
            const type = view.getUint16(offset);
            const ttl = view.getUint32(offset + 4);
            const rdlength = view.getUint16(offset + 8);
            offset += 10 + rdlength;

            if (type === 41) continue;      // OPT/EDNS — TTL معنا ندارد
            if (ttl === 0) return 0;        // رکورد بی‌ثبات
            minTtl = minTtl === null ? ttl : Math.min(minTtl, ttl);
        }
        return minTtl;
    } catch {
        return null;
    }
}

// ---------- کمکی‌ها ----------

/**
 * کلید کش از روی SECTION سؤال (qname|qtype) — نه ID تصادفی کلاینت.
 * این باعث می‌شود کوئری‌های یکسان از کلاینت‌های مختلف (با ID متفاوت)
 * همدیگر را HIT کنند — جوهره‌ی query coalescing.
 * EDNS cookies/ECS در کلید بی‌اثرند (نمودار کش بهتر).
 */
function questionKey(wire: Uint8Array): string | null {
    try {
        const header = parseDnsHeader(wire);
        if (!header || header.qdcount < 1) return null;

        let offset = 12;
        const labels: string[] = [];
        for (;;) {
            if (offset >= wire.length) return null;
            const len = wire[offset];
            if ((len & 0xC0) !== 0) return null;   // نام سؤال نباید compressed باشد
            if (len === 0) { offset += 1; break; }
            labels.push(
                String.fromCharCode(...wire.slice(offset + 1, offset + 1 + len)).toLowerCase()
            );
            offset += 1 + len;
        }
        if (offset + 2 > wire.length) return null;
        const qtype = (wire[offset] << 8) | wire[offset + 1];
        return `${labels.join('.')}|${qtype}`;
    } catch {
        return null;
    }
}

function base64UrlDecode(value: string): Uint8Array | null {
    try {
        const b64 = value.replace(/-/g, '+').replace(/_/g, '/');
        const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
        const bin = atob(padded);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    } catch {
        return null;
    }
}

async function sha256Hex(data: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

function getEntry(key: string, now: number, allowStale = false): CacheEntry | null {
    const entry = cache.get(key);
    if (!entry) return null;
    if (now < entry.expiresAt) {
        // refresh ترتیب LRU
        cache.delete(key);
        cache.set(key, entry);
        return entry;
    }
    // منقضی — حذف نمی‌شود تا به‌عنوان stale در دسترس باشد (با evict بعداً حذف می‌شود)
    return allowStale ? entry : null;
}

function putEntry(key: string, result: DohUpstreamResult, now: number) {
    if (result.ttl <= 0) return;
    cache.delete(key);
    cache.set(key, {
        body: result.body,
        contentType: result.contentType,
        expiresAt: now + result.ttl * 1000
    });
    while (cache.size > DOH_CACHE_LIMIT) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
    }
}

function respond(entry: CacheEntry, requestId: number | null, status: 'HIT' | 'MISS' | 'STALE'): Response {
    const body = withId(entry.body, requestId);
    const remaining = Math.max(0, Math.ceil((entry.expiresAt - Date.now()) / 1000));
    return new Response(body, {
        headers: {
            'Content-Type': entry.contentType,
            'Cache-Control': `max-age=${remaining}`,
            'X-DNS-Cache': status
        }
    });
}

/** کپی پاسخ با ID کوئری درخواست‌دهنده (RFC 1035: ID پاسخ = ID کوئری) */
function withId(body: Uint8Array, requestId: number | null): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(body);
    if (out.length >= 2 && requestId !== null) {
        out[0] = (requestId >> 8) & 0xff;
        out[1] = requestId & 0xff;
    }
    return out;
}

/** Base بالادست DoH — dohUrl خراب/تنظیم‌نشده هرگز این مسیر را نمی‌شکند */
function upstreamBase(): URL {
    try {
        return new URL(getGlobals().dohUrl || 'https://cloudflare-dns.com/dns-query');
    } catch {
        return new URL('https://cloudflare-dns.com/dns-query');
    }
}

async function fetchUpstream(
    targetBase: URL,
    incoming: URL,
    method: 'GET' | 'POST',
    wire: Uint8Array | null
): Promise<DohUpstreamResult> {
    const target = new URL(targetBase.toString());
    if (method === 'GET') {
        incoming.searchParams.forEach((value, key) => target.searchParams.set(key, value));
    }

    const upstream = await fetch(target.toString(), {
        method,
        headers: {
            'Accept': 'application/dns-message',
            ...(method === 'POST' ? { 'Content-Type': 'application/dns-message' } : {})
        },
        body: method === 'POST' ? (wire as BufferSource) : undefined
    });

    if (!upstream.ok) throw new Error(`DoH upstream responded ${upstream.status}`);

    const body = new Uint8Array(await upstream.arrayBuffer());
    const parsedTtl = minAnswerTtl(body);
    const ttl = parsedTtl === null
        ? DOH_NEGATIVE_TTL
        : parsedTtl === 0
            ? 0
            : Math.min(DOH_MAX_TTL, Math.max(DOH_MIN_TTL, parsedTtl));

    return {
        body,
        ttl,
        contentType: upstream.headers.get('Content-Type') ?? 'application/dns-message'
    };
}

// ---------- هندلر ----------

/**
 * مسیر سطح-سیم برای DNS تونل (پکت‌های UDP 53 داخل تونل VLESS — v0.8.20).
 * دقیقاً همان زیرساخت هندلر HTTP را استفاده می‌کند: کش TTL-آگاه +
 * single-flight + stale-on-error + coalescing بر اساس (qname|qtype).
 * تا v0.8.19 مسیر تونل fetch خام به URL هاردکد بود — بدون کش، بدون
 * single-flight و نادیده‌گرفتن dohUrl ادمین.
 *
 * ورودی: بایت‌های کوئری DNS. خروجی: بایت‌های پاسخ با ID بازنویسی‌شده،
 * یا null (کوئری خراب / بالادست مرد و stale هم نبود) — هرگز throw نمی‌کند
 * تا یک کوئری بد هرگز کانال DNS تونل را نبندد.
 */
export async function resolveDnsWire(wire: Uint8Array): Promise<Uint8Array | null> {
    try {
        if (!wire || wire.length < 12) return null;

        const targetBase = upstreamBase();
        const now = Date.now();
        const requestId = parseDnsHeader(wire)?.id ?? null;

        const qKey = questionKey(wire);
        if (qKey) {
            const key = `q:${qKey}`;

            const hit = getEntry(key, now);
            if (hit) return withId(hit.body, requestId);

            let pending = inflight.get(key);
            if (!pending) {
                pending = fetchUpstream(targetBase, new URL(targetBase.toString()), 'POST', wire)
                    .finally(() => inflight.delete(key));
                inflight.set(key, pending);
            }

            try {
                const fresh = await pending;
                putEntry(key, fresh, now);
                return withId(fresh.body, requestId);
            } catch {
                const stale = getEntry(key, now, true);
                return stale ? withId(stale.body, requestId) : null;
            }
        }

        // کلیدسازی نشد — عبور مستقیم بدون کش (معادل BYPASS هندلر HTTP)
        try {
            const fresh = await fetchUpstream(targetBase, new URL(targetBase.toString()), 'POST', wire);
            return withId(fresh.body, requestId);
        } catch {
            return null;
        }
    } catch {
        return null;
    }
}

export async function handleDoH(request: Request): Promise<Response> {
    const { dohUrl } = getGlobals();
    const url = new URL(request.url);
    const targetBase = new URL(dohUrl);
    const now = Date.now();

    let wire: Uint8Array | null = null;
    let key: string | null = null;
    let method: 'GET' | 'POST';

    if (request.method === 'GET') {
        method = 'GET';
        const dnsParam = url.searchParams.get('dns');
        if (dnsParam) {
            wire = base64UrlDecode(dnsParam);
            // کلید از سؤال (qname|qtype) — coalescing بین کلاینت‌های مختلف
            const qKey = wire ? questionKey(wire) : null;
            key = qKey ? `q:${qKey}` : wire ? `g:${dnsParam}` : null;
        }
    } else if (request.method === 'POST') {
        method = 'POST';
        const body = new Uint8Array(await request.arrayBuffer());
        if (body.length >= 12) {
            wire = body;
            const qKey = questionKey(body);
            key = qKey ? `q:${qKey}` : `p:${await sha256Hex(body)}`;
        }
    } else {
        return new Response('Method Not Allowed', {
            status: 405,
            headers: { 'Allow': 'GET, POST' }
        });
    }

    // مسیر عبور مستقیم — کوئری JSON یا بدنه‌ی نامعتبر (سازگار با رفتار قبلی)
    if (!key || !wire) {
        const target = new URL(targetBase.toString());
        if (method === 'GET') {
            url.searchParams.forEach((value, key) => target.searchParams.set(key, value));
        }
        const upstream = await fetch(target.toString(), {
            method,
            headers: method === 'POST'
                ? { 'Content-Type': request.headers.get('Content-Type') ?? 'application/dns-message' }
                : undefined,
            body: method === 'POST' ? ((wire ?? new Uint8Array(0)) as BufferSource) : undefined
        });
        // هدرهای پاسخ fetch در Workers غیرقابل‌تغییرند — بازسازی می‌شود
        const response = new Response(upstream.body, upstream);
        response.headers.set('X-DNS-Cache', 'BYPASS');
        return response;
    }

    const header = parseDnsHeader(wire);
    const requestId = header?.id ?? null;

    // ۱) کش
    const hit = getEntry(key, now);
    if (hit) return respond(hit, requestId, 'HIT');

    // ۲) single-flight — کوئری‌های همزمان یکسان فقط یک fetch
    let pending = inflight.get(key);
    if (!pending) {
        pending = fetchUpstream(targetBase, url, method, wire)
            .finally(() => inflight.delete(key));
        inflight.set(key, pending);
    }

    try {
        const fresh = await pending;
        putEntry(key, fresh, now);
        return freshResponse(fresh, requestId, now);
    } catch (error) {
        // ۳) stale-on-error
        const stale = getEntry(key, now, true);
        if (stale) return respond(stale, requestId, 'STALE');
        return new Response(`DoH upstream error: ${safeError(error)}`, { status: 502 });
    }
}

function freshResponse(fresh: DohUpstreamResult, requestId: number | null, now: number): Response {
    return respond(
        { body: fresh.body, contentType: fresh.contentType, expiresAt: now + fresh.ttl * 1000 },
        requestId,
        'MISS'
    );
}
