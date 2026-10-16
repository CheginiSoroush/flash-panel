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
