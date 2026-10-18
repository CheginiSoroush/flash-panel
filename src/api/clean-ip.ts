/**
 * موتور کیفیت Clean IP / Endpoint — ضد خطای ۴۰۳
 *
 * خطای ۴۰۳ معمولاً وقتی می‌آید که آدرس اتصال کلاینت (workers.dev یا یک IP لبه‌ی
 * پرچم‌شده) از سمت ISP مسدود است. راه‌حل استاندارد: آدرس‌های «تمیز» — IP های لبه‌ی
 * Cloudflare که هنوز سالم‌اند. این ماژول منطق خالصِ کشف → تست → رتبه‌بندی →
 * بازآرایی لیست cleanIPs را دارد (بدون هیچ وابستگی به KV/@settings تا در تست
 * و در هندلر بدون side-effect مصرف شود).
 *
 * منابع کشف، جمع‌کننده‌های عمومی شناخته‌شده‌ی جامعه هستند — best-effort و
 * کاملاً اختیاری: اگر هیچ‌کدام در دسترس نبود، فقط تست/بازآرایی لیست فعلی کار می‌کند.
 */

export interface EndpointTestResult {
    target: string;
    ok: boolean;
    successRate: string;
    avgLatencyMs: number | null;
    /** true = تأیید ساختاری (رنج رسمی CF) بدون پروب سوکتی — CF→CF cancel می‌شود */
    structural?: boolean;
}

/** جمع‌کننده‌های عمومی IP تمیز — هر کدام متن ساده (IP یا دامنه در هر خط) برمی‌گردانند */
export const CLEAN_IP_DISCOVERY_SOURCES: string[] = [
    'https://cf.090227.xyz/',
    'https://ip.164746.xyz/ipTop10.html'
];

const IPV4_RE = /^(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.(?:25[0-5]|2[0-4]\d|[01]?\d\d?)$/;
const IPV6_RE = /^\[(?:(?:[a-fA-F0-9]{1,4}:){7}[a-fA-F0-9]{1,4}|(?:[a-fA-F0-9]{1,4}:){1,7}:|::(?:[a-fA-F0-9]{1,4}:){0,7}|(?:[a-fA-F0-9]{1,4}:){1,6}:[a-fA-F0-9]{1,4}|(?:[a-fA-F0-9]{1,4}:){1,5}(?::[a-fA-F0-9]{1,4}){1,2}|(?:[a-fA-F0-9]{1,4}:){1,4}(?::[a-fA-F0-9]{1,4}){1,3}|(?:[a-fA-F0-9]{1,4}:){1,3}(?::[a-fA-F0-9]{1,4}){1,4}|(?:[a-fA-F0-9]{1,4}:){1,2}(?::[a-fA-F0-9]{1,4}){1,5}|[a-fA-F0-9]{1,4}:(?::[a-fA-F0-9]{1,4}){1,6})\]$/;
const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export function isValidEndpoint(value: string): boolean {
    if (!value || value.length > 253) return false;
    return IPV4_RE.test(value) || IPV6_RE.test(value) || DOMAIN_RE.test(value);
}

// ---------- اعتبارسنجی ساختاری لبه‌ی Cloudflare ----------
// دیاگ زنده (v0.8.1): سوکت Worker → IP لبه‌ی CF در سطح پلتفرم cancel می‌شود
// ("Stream was cancelled") — یعنی هیچ تست سوکتی از داخل Worker روی IP های
// لبه ممکن نیست (CF→CF مسدود است). چیزی که از لبه قابل‌اثبات است فقط
// «اعتبار ساختاری» است: عضویت IPv4 در رنج‌های رسمی منتشرشده‌ی CF.
// IPv4 خارج از این رنج‌ها (مثل Google/GCP) برای clean-IP «قطعاً» مرده است —
// کلاینت با SNI دامنه‌ی ما به آن IP وصل می‌شود و گواهی mismatch می‌گیرد.

export const CF_EDGE_RANGES: ReadonlyArray<{ base: string; bits: number }> = [
    { base: '104.16.0.0', bits: 13 },      // 104.16.0.0/13
    { base: '104.24.0.0', bits: 14 },      // 104.24.0.0/14
    { base: '172.64.0.0', bits: 13 },      // 172.64.0.0/13
    { base: '162.158.0.0', bits: 15 },     // 162.158.0.0/15
    { base: '108.162.192.0', bits: 18 },   // 108.162.192.0/18
    { base: '141.101.64.0', bits: 18 },    // 141.101.64.0/18
    { base: '188.114.96.0', bits: 20 },    // 188.114.96.0/20
    { base: '190.93.240.0', bits: 20 },    // 190.93.240.0/20
    { base: '103.21.244.0', bits: 22 },    // 103.21.244.0/22
    { base: '198.41.128.0', bits: 17 },    // 198.41.128.0/17
    { base: '173.245.48.0', bits: 20 },    // 173.245.48.0/20
    { base: '131.0.72.0', bits: 22 }       // 131.0.72.0/22
];

const CLEAN_IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** IPv4 → int (بی‌اعتبار = null) */
export function cleanIpToInt(ip: string): number | null {
    const m = CLEAN_IPV4_RE.exec(ip);
    if (!m) return null;
    const octets = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
    if (octets.some(o => o > 255)) return null;
    return (((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0);
}

/** آیا این IPv4 در رنج‌های رسمی لبه‌ی Cloudflare است؟ */
export function isCloudflareEdgeIPv4(ip: string): boolean {
    const value = cleanIpToInt(ip);
    if (value === null) return false;
    for (const range of CF_EDGE_RANGES) {
        const base = cleanIpToInt(range.base);
        if (base === null) continue;
        const mask = (0xFFFFFFFF << (32 - range.bits)) >>> 0;
        if ((value & mask) === (base & mask)) return true;
    }
    return false;
}

/**
 * اعتبار ساختاری یک ورودی clean-IP:
 *  - IPv4 → فقط داخل رنج‌های CF معتبر است (خارج = قطعاً مرده برای کلاینت)
 *  - دامنه → محافظه‌کارانه معتبر (قصد ادمین؛ دامنه‌های CF-fronted مثل
 *    www.speedtest.net این‌اند؛ تشخیص CF-fronted بودن از لبه ممکن نیست)
 */
export function isValidCleanEntry(entry: string): boolean {
    const trimmed = (entry ?? '').trim();
    if (!trimmed) return false;
    if (cleanIpToInt(trimmed) === null) return true; // دامنه/IPv6
    return isCloudflareEdgeIPv4(trimmed);
}

// ---------- تولید کاندیدای قطعی از رنج‌های CF ----------
// به‌جای لیست ثابتِ کهنه‌شونده: تولید قطعی (seed = روز UTC + ایندکس) از
// رنج‌های رسمی — هر روز ترکیب متفاوت (تنوع ضد-فیلترینگ)، بدون اینترنت و
// بدون سوکت. همان IP در همان روز همیشه همان است (idempotent).

/** splitmix32 — PRNG قطعی کوچک */
function splitmix32(seed: number): () => number {
    let s = seed | 0;
    return () => {
        s = (s + 0x9E3779B9) | 0;
        let z = s;
        z = Math.imul(z ^ (z >>> 16), 0x21F0AAAD);
        z = Math.imul(z ^ (z >>> 15), 0x735A2D97);
        return (z ^ (z >>> 15)) >>> 0;
    };
}

/** کاندیدای clean-IP قطعی برای (روز، ایندکس) — همیشه داخل رنج‌های CF */
export function generateCleanCandidate(dayBucket: number, index: number): string {
    const rand = splitmix32((Math.imul(dayBucket, 2654435761) ^ Math.imul(index + 1, 0x9E3779B9)) | 0);
    const range = CF_EDGE_RANGES[rand() % CF_EDGE_RANGES.length];
    const base = cleanIpToInt(range.base)!;
    const mask = (0xFFFFFFFF << (32 - range.bits)) >>> 0;
    const hostMask = (~mask) >>> 0;
    const hostBits = 32 - range.bits;
    let host = rand() % hostMask;
    if (hostBits >= 8) {
        // پرهیز از لبه‌ی اکتت (x.y.z.0 / x.y.z.255)
        const last = host & 0xFF;
        if (last === 0) host += 1;
        else if (last === 255) host -= 1;
    }
    const value = ((base & mask) | (host & hostMask)) >>> 0;
    return `${(value >>> 24) & 255}.${(value >>> 16) & 255}.${(value >>> 8) & 255}.${value & 255}`;
}

/**
 * استخراج کاندیداهای معتبر از متن خام منابع کشف — جداسازی با فاصله/خط جدید/
 * کاما/گیومه، پاک‌سازی پسوند پورت (`1.2.3.4:443`)، حذف تکرار و سقف تعداد.
 */
export function extractCandidates(raw: string, cap = 60): string[] {
    if (!raw) return [];

    const tokens = raw
        .split(/[\s,;"'<>]+/)
        .map(token => token.trim())
        .filter(Boolean);

    const seen = new Set<string>();
    const candidates: string[] = [];

    for (const token of tokens) {
        // پسوند پورت رایج در منابع کشف — فقط :443/:80 معنا دارد، بقیه را رد کن
        const portMatch = token.match(/^(.+):(\d{1,5})$/);
        let value = token;

        if (portMatch && (portMatch[2] === '443' || portMatch[2] === '80')) {
            value = portMatch[1];
        } else if (portMatch) {
            continue;
        }

        if (!isValidEndpoint(value) || seen.has(value)) continue;

        seen.add(value);
        candidates.push(value);
        if (candidates.length >= cap) break;
    }

    return candidates;
}

/**
 * رتبه‌بندی نتایج تست: سالم‌ها اول، بعد بر اساس کم‌ترین میانگین تأخیر.
 * شکست‌خورده‌ها در انتها (خودشان هم بر اساس تأخیر مرتب می‌شوند — سریع‌ترین خطا
 * یعنی رد صریح لبه، بهتر از timeout است).
 */
export function rankResults<T extends EndpointTestResult>(results: T[]): T[] {
    const latency = (r: T) => r.avgLatencyMs ?? Number.MAX_SAFE_INTEGER;

    return [...results].sort((a, b) => {
        if (a.ok !== b.ok) return a.ok ? -1 : 1;
        return latency(a) - latency(b);
    });
}

export interface ReorderOptions {
    /** سقف کل لیست cleanIPs پس از بازآرایی */
    cap?: number;
    /** سقف افزودن از کاندیداهای کشف‌شده در یک اجرا */
    maxAdd?: number;
}

export interface ReorderOutcome {
    /** لیست نهایی — سالم‌ها (سریع‌ترین اول) → نام‌سالم‌های قبلی → کاندیداهای کشف‌شده */
    list: string[];
    /** موارد تازه‌افزوده‌شده از کشف */
    added: string[];
    /** اگر لیست نهایی با ورودی یکسان باشد false — یعنی redeploy لازم نیست */
    applied: boolean;
}

/**
 * بازآرایی خودکار لیست cleanIPs بر اساس نتیجه‌ی تست + کشف تازه.
 *
 * - ورودی‌های سالم فعلی، مرتب بر اساس تأخیر واقعی، در رأس می‌مانند
 *   (ترتیب همین‌جا مهم است: اولین آدرس = اولین گزینه‌ی اتصال کلاینت)
 * - ورودی‌های نام‌سالم/تست‌نشده‌ی فعلی بعد از آن‌ها حفظ می‌شوند (حذف نمی‌کنیم —
 *   ممکن است فقط از دید ورکر سالم نباشند؛ دید کلاینت می‌تواند متفاوت باشد)
 * - کاندیداهای کشف‌شده‌ی سالمِ جدید تا سقف مجاز اضافه می‌شوند
 */
export function reorderCleanIPs(
    current: string[],
    results: EndpointTestResult[],
    discovered: EndpointTestResult[],
    { cap = 10, maxAdd = 5 }: ReorderOptions = {}
): ReorderOutcome {
    const unique = [...new Set(current.filter(Boolean))];
    const resultMap = new Map(results.map(r => [r.target, r]));

    const healthySorted = rankResults(results.filter(r => r.ok)).map(r => r.target);
    const healthySet = new Set(healthySorted);

    const ordered: string[] = [];

    // ۱) سالم‌های فعلی به ترتیب رتبه‌ی تأخیر
    for (const target of healthySorted) {
        if (unique.includes(target) && !ordered.includes(target)) ordered.push(target);
    }

    // ۲) نام‌سالم/تست‌نشده‌های فعلی با ترتیب اصلی (حفظ، نه حذف)
    for (const entry of unique) {
        if (!ordered.includes(entry) && !healthySet.has(entry)) ordered.push(entry);
    }

    // ۳) کاندیداهای کشف‌شده‌ی سالم جدید — تا سقف
    const added: string[] = [];
    for (const result of rankResults(discovered.filter(r => r.ok))) {
        if (ordered.length >= cap || added.length >= maxAdd) break;
        if (ordered.includes(result.target)) continue;

        ordered.push(result.target);
        added.push(result.target);
    }

    // مقایسه با ورودی اصلی (نه نرمال‌شده) — پاک‌سازی تکراری/خالی هم تغییر محسوب
    // می‌شود چون handler ورودی را از قبل نرمال می‌کند و اینجا حالت تمیز است
    const applied = JSON.stringify(ordered) !== JSON.stringify(current);

    return { list: ordered, added, applied };
}

/**
 * هدر استاندارد `subscription-userinfo` برای کلاینت‌ها (نمایش سهمیه/انقضا).
 * اگر expire نداشته باشیم header برنمی‌گردد (کلاینت‌ها نبودش را درست تفسیر می‌کنند).
 */
export function buildSubUserInfoHeader(params: {
    expireMs?: number | null;
    totalBytes?: number | null;
    usedBytes?: number | null;
}): string | null {
    const { expireMs, totalBytes, usedBytes } = params;
    if (typeof expireMs !== 'number' || !Number.isFinite(expireMs) || expireMs <= 0) {
        return null;
    }

    const parts = ['upload=0', `download=${Math.max(0, Math.floor(usedBytes ?? 0))}`];

    if (typeof totalBytes === 'number' && totalBytes > 0) {
        parts.push(`total=${Math.floor(totalBytes)}`);
    }

    parts.push(`expire=${Math.floor(expireMs / 1000)}`);
    return parts.join('; ');
}
