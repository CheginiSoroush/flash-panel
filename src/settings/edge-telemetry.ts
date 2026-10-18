import { authenticate } from '@auth';
import { HttpStatus, respond, safeError } from '@common';

/**
 * 🛰️ Edge Telemetry — معکوس‌مهندسی پلتفرم Cloudflare (v0.8.4)
 *
 * کشف: `request.cf` در هر درخواست Worker شامل داده‌هایی است که هیچ پنل مشابه‌ای
 * استفاده نمی‌کند:
 *   - `colo`          → کدام دیتاسنتر CF به کاربر سرویس داد (anycast واقعی)
 *   - `clientTcpRtt`  → RTT واقعی TCP کلاینت تا لبه (میلی‌ثانیه!) — اوراکل
 *                       ایران‌ساید رایگان، بدون هیچ ping اضافه
 *   - `asn` + `asOrganization` → اپراتور کاربر (MCI/ایرانسل/مخابرات/…)
 *
 * منبع داده: ترافیک واقعی — هر WS-handshake موفق و هر fetch اشتراک یک نمونه
 * می‌دهد. صفر subrequest اضافه، صفر ping، صفر هزینه‌ی CPU محسوس.
 *
 * چرا بافر + flush تأخیری؟ سهمیه‌ی KV رایگان ۱۰۰۰ write/روز است. بافر در حافظه‌ی
 * isolate جمع می‌شود و یا وقتی ≥۱۲ نمونه شد و یا ۱۵ ثانیه بعد (waitUntil) یک‌جا
 * نوشته می‌شود. با ترافیک کم هر نمونه ~۱۵ ثانیه بعد می‌نشیند؛ با ترافیک زیاد
 * بچ‌بچ می‌شود و سقف نمونه‌ی روزانه هم نوشتن‌های بعد از سقف را کلاً قطع می‌کند.
 *
 * افشا: هیچ داده‌ی شخصی — فقط (colo، ASN، RTT، نوع). بدون IP.
 */

export interface EdgeAgg {
    /** تعداد نمونه */
    n: number;
    /** جمع RTT برای میانگین (ms) */
    rttSum: number;
    /** بیشترین RTT دیده‌شده (ms) */
    rttMax: number;
    /** چند نمونه از WS-handshake واقعی پروکسی (نه فقط HTTP) */
    ws: number;
    /** جمع بایت کلاینت→ورکر (نمونه‌های close اتصال — v0.8.5) */
    upSum: number;
    /** جمع بایت ورکر→کلاینت (v0.8.5) */
    downSum: number;
}

export interface EdgeDay {
    /** تاریخ UTC — YYYY-MM-DD */
    date: string;
    colos: Record<string, EdgeAgg>;
    asns: Record<string, EdgeAgg>;
    total: number;
    updatedAt: number;
}

export interface EdgeSample {
    colo: string;
    asn: string;
    /** TCP RTT کلاینت→لبه (ms) — گاهی platform مقدار نمی‌دهد */
    rtt?: number;
    ws: boolean;
    /** بایت کلاینت→ورکر — فقط نمونه‌های close اتصال WS (v0.8.5) */
    up?: number;
    /** بایت ورکر→کلاینت (v0.8.5) */
    down?: number;
    /** epoch ms — فقط در بافر داخلی، داخل KV نمی‌رود */
    at?: number;
}

const TELEMETRY_KEY = 'edgeTelemetry';
const MAX_DAYS = 2;
const MAX_COLOS = 12;
const MAX_ASNS = 24;
/** سقف نمونه‌ی ثبت‌شده در روز — بعد از آن flush ها drop می‌شوند (محافظ سهمیه‌ی KV) */
const MAX_SAMPLES_PER_DAY = 2000;
const FLUSH_AT = 12;
const FLUSH_DELAY_MS = 15_000;
/** سقف flush در طول عمر هر isolate — محافظ دوم سهمیه‌ی نوشتن */
const MAX_FLUSHES_PER_ISOLATE = 40;

// ---------- بافر داخلی isolate ----------

let buffer: EdgeSample[] = [];
let flushCount = 0;
let flushScheduled = false;
/** برای تست — نرخ نمونه‌گیری HTTP */
let httpSampleRate = 0.25;

export function _setHttpSampleRate(rate: number): void {
    httpSampleRate = rate;
}

export function _resetEdgeTelemetryForTest(): void {
    buffer = [];
    flushCount = 0;
    flushScheduled = false;
    httpSampleRate = 0.25;
}

/** برای تست — بافر را بدون تایمر فوراً می‌شوید */
export async function _flushNow(env: Env): Promise<void> {
    const batch = buffer.splice(0, buffer.length);
    if (batch.length) await flushSamples(env, batch);
}

// ---------- استخراج از request.cf ----------

export function extractEdgeSample(request: Request, kind: 'ws' | 'http'): EdgeSample | null {
    try {
        const cf: unknown = (request as any).cf;
        if (!cf || typeof cf !== 'object') return null;
        const c = cf as Record<string, unknown>;

        const colo = typeof c.colo === 'string' ? c.colo : '';
        if (!colo) return null;

        const rtt = typeof c.clientTcpRtt === 'number' && c.clientTcpRtt >= 0 && Number.isFinite(c.clientTcpRtt)
            ? c.clientTcpRtt
            : undefined;
        const asnNum = typeof c.asn === 'number' ? c.asn : undefined;
        const asOrg = typeof c.asOrganization === 'string' ? c.asOrganization.trim().split(/\s+/)[0] ?? '' : '';
        const asn = asnNum !== undefined ? (asOrg ? `${asnNum} ${asOrg}` : `${asnNum}`) : 'unknown';

        return { colo, asn, rtt, ws: kind === 'ws' };
    } catch {
        return null;
    }
}

// ---------- ثبت + زمان‌بندی flush ----------

/**
 * ثبت یک نمونه لبه. برای kind='ws' با close اتصال صدا زده می‌شود و بایت‌های
 * ترافیک واقعی را هم حمل می‌کند (v0.8.5). هرگز throw نمی‌کند.
 */
export function recordEdgeSample(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
    kind: 'ws' | 'http' = 'http',
    traffic?: { up?: number; down?: number }
): void {
    try {
        const s = extractEdgeSample(request, kind);
        if (!s) return;
        if (traffic) {
            if (typeof traffic.up === 'number' && Number.isFinite(traffic.up) && traffic.up >= 0) s.up = Math.round(traffic.up);
            if (typeof traffic.down === 'number' && Number.isFinite(traffic.down) && traffic.down >= 0) s.down = Math.round(traffic.down);
        }

        // WS-handshake همیشه (ترافیک واقعی پروکسی، کم‌تکرار)؛ HTTP یک‌بار در ۴
        if (!s.ws && Math.random() >= httpSampleRate) return;

        buffer.push({ ...s, at: Date.now() });

        if (buffer.length >= FLUSH_AT && flushCount < MAX_FLUSHES_PER_ISOLATE) {
            flushCount++;
            const batch = buffer.splice(0, buffer.length);
            ctx.waitUntil(flushSamples(env, batch).catch(() => {}));
            return;
        }

        // ترافیک کم → flush تأخیری تا نمونه‌ها گم نشوند
        if (!flushScheduled) {
            flushScheduled = true;
            ctx.waitUntil(
                new Promise<void>((res) => setTimeout(res, FLUSH_DELAY_MS))
                    .then(() => {
                        flushScheduled = false;
                        if (buffer.length && flushCount < MAX_FLUSHES_PER_ISOLATE) {
                            flushCount++;
                            const batch = buffer.splice(0, buffer.length);
                            return flushSamples(env, batch);
                        }
                    })
                    .catch(() => {})
            );
        }
    } catch {
        // هرگز مسیر اصلی را خراب نکند
    }
}

// ---------- نگاشت KV ----------

function emptyAgg(): EdgeAgg {
    return { n: 0, rttSum: 0, rttMax: 0, ws: 0, upSum: 0, downSum: 0 };
}

function addAgg(
    map: Record<string, EdgeAgg>,
    key: string,
    rtt?: number,
    ws = false,
    cap = Infinity,
    up = 0,
    down = 0
): void {
    let agg = map[key];
    if (!agg) {
        // نقشه پر و کلید تازه؟ ضعیف‌ترین (کم‌تکرارترین) را آزاد کن
        const keys = Object.keys(map);
        if (keys.length >= cap && keys.length) {
            const weakest = keys.sort((a, b) => map[a].n - map[b].n)[0];
            delete map[weakest];
        }
        agg = emptyAgg();
        map[key] = agg;
    }
    agg.n++;
    if (typeof rtt === 'number') {
        agg.rttSum += rtt;
        if (rtt > agg.rttMax) agg.rttMax = rtt;
    }
    if (ws) agg.ws++;
    if (up > 0) agg.upSum += up;
    if (down > 0) agg.downSum += down;
}

function pruneMaps(map: Record<string, EdgeAgg>, cap: number): void {
    const keys = Object.keys(map);
    if (keys.length <= cap) return;
    keys.sort((a, b) => map[b].n - map[a].n);
    for (const k of keys.slice(cap)) delete map[k];
}

export async function flushSamples(env: Env, batch: EdgeSample[]): Promise<void> {
    if (!batch.length) return;

    const today = new Date().toISOString().slice(0, 10);
    let days: Record<string, EdgeDay> = {};
    try {
        const raw = await env.kv.get(TELEMETRY_KEY, { type: 'json' });
        if (raw && typeof raw === 'object' && (raw as Record<string, unknown>).days) {
            days = (raw as { days: Record<string, EdgeDay> }).days ?? {};
        }
    } catch {
        // خرابی JSON = شروع تازه
    }

    let cur = days[today];
    if (!cur || cur.date !== today || typeof cur.total !== 'number') {
        cur = { date: today, colos: {}, asns: {}, total: 0, updatedAt: 0 };
        days = { [today]: cur };
    }

    let dropped = false;
    for (const s of batch) {
        if (cur.total >= MAX_SAMPLES_PER_DAY) { dropped = true; break; }
        addAgg(cur.colos, s.colo, s.rtt, s.ws, MAX_COLOS, s.up ?? 0, s.down ?? 0);
        addAgg(cur.asns, s.asn, s.rtt, s.ws, MAX_ASNS, s.up ?? 0, s.down ?? 0);
        cur.total++;
    }
    cur.updatedAt = Date.now();

    // هرس روزهای قدیمی
    const fresh: Record<string, EdgeDay> = { [today]: cur };
    for (const [k, v] of Object.entries(days)) {
        if (k !== today && v?.date && fresh[k] === undefined && Object.keys(fresh).length < MAX_DAYS) {
            fresh[k] = v;
        }
    }
    pruneMaps(cur.colos, MAX_COLOS);
    pruneMaps(cur.asns, MAX_ASNS);

    try {
        await env.kv.put(TELEMETRY_KEY, JSON.stringify({ days: fresh, dropped }));
    } catch (error) {
        console.log(`edge-telemetry: flush failed — ${safeError(error)}`);
    }
}

export async function getEdgeTelemetry(env: Env): Promise<{ days: Record<string, EdgeDay>; dropped?: boolean } | null> {
    try {
        const raw = await env.kv.get(TELEMETRY_KEY, { type: 'json' });
        if (raw && typeof raw === 'object') return raw as { days: Record<string, EdgeDay>; dropped?: boolean };
    } catch {
        // خواندن نشد
    }
    return null;
}

/** GET panel/edge — telemetry برای داشبورد/ربات (نیازمند نشست معتبر) */
export async function getEdgeTelemetryEndpoint(request: Request, env: Env): Promise<Response> {
    try {
        const auth = await authenticate(request, env);
        if (!auth) {
            return respond(false, HttpStatus.UNAUTHORIZED, 'Unauthorized or expired session.');
        }

        const telemetry = await getEdgeTelemetry(env);
        return respond(true, HttpStatus.OK, '', telemetry ?? { days: {} }, {
            'Cache-Control': 'no-store'
        });
    } catch (error) {
        return respond(false, HttpStatus.INTERNAL_SERVER_ERROR, `Error occurred: ${safeError(error)}`);
    }
}

// ---------- نمایش ----------

/** واحد انسانی — B/KB/MB/GB/TB */
export function formatBytes(n: number): string {
    if (!Number.isFinite(n) || n <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** جمع ترافیک کل تلمتری (تقریبی — هرس نقشه‌ها ممکنه بخشی را drop کرده باشد) */
export function getTrafficTotals(telemetry: { days: Record<string, EdgeDay> } | null): { up: number; down: number } {
    let up = 0, down = 0;
    if (!telemetry?.days) return { up, down };
    for (const day of Object.values(telemetry.days)) {
        for (const a of Object.values(day.colos ?? {})) { up += a.upSum ?? 0; down += a.downSum ?? 0; }
    }
    return { up, down };
}

function topAggs(map: Record<string, EdgeAgg>, limit: number): Array<[string, EdgeAgg]> {
    return Object.entries(map)
        .sort((a, b) => b[1].n - a[1].n)
        .slice(0, limit);
}

function fmtAgg(name: string, agg: EdgeAgg): string {
    const avg = agg.n && agg.rttSum > 0 ? Math.round(agg.rttSum / agg.n) : null;
    const parts = [name];
    parts.push(avg !== null ? `${avg}ms` : '—');
    if (agg.rttMax > 0) parts.push(`max ${agg.rttMax}ms`);
    parts.push(`×${agg.n}`);
    if (agg.ws > 0) parts.push(`ws ${agg.ws}`);
    if ((agg.downSum ?? 0) > 0) parts.push(`↓ ${formatBytes(agg.downSum)}`);
    if ((agg.upSum ?? 0) > 0) parts.push(`↑ ${formatBytes(agg.upSum)}`);
    return parts.join(' · ');
}

/** خلاصه‌ی یک‌خطی برای digest — null یعنی داده‌ای نیست */
export function buildEdgeSummary(telemetry: { days: Record<string, EdgeDay> } | null): string | null {
    if (!telemetry?.days) return null;
    const agg: Record<string, EdgeAgg> = {};
    let total = 0;
    for (const day of Object.values(telemetry.days)) {
        total += day.total ?? 0;
        for (const [colo, a] of Object.entries(day.colos ?? {})) {
            const t = agg[colo] ?? (agg[colo] = emptyAgg());
            t.n += a.n; t.rttSum += a.rttSum; t.rttMax = Math.max(t.rttMax, a.rttMax); t.ws += a.ws;
            t.upSum += a.upSum ?? 0; t.downSum += a.downSum ?? 0;
        }
    }
    if (!total) return null;
    let downSum = 0;
    for (const t of Object.values(agg)) downSum += t.downSum;
    const tops = topAggs(agg, 3).map(([colo, a]) => fmtAgg(colo, a));
    const traffic = downSum > 0 ? ` · ↓${formatBytes(downSum)}` : '';
    return `Colo: ${tops.join(' | ')} (samples ${total})${traffic}`;
}

/** متن کامل برای دستور /edge ربات و endpoint پنل */
export function buildEdgeText(telemetry: { days: Record<string, EdgeDay>; dropped?: boolean } | null): string {
    const lines: string[] = ['🛰️ <b>Edge Telemetry</b>', '━━━━━━━━━━━━━━━━'];

    if (!telemetry?.days || !Object.keys(telemetry.days).length) {
        lines.push(
            'No samples yet — telemetry fills up with real client traffic.',
            '',
            'Every WS handshake and sub fetch reports colo / ISP / TCP-RTT',
            'from Cloudflare request.cf — zero extra requests, zero pings.'
        );
        return lines.join('\n');
    }

    const colos: Record<string, EdgeAgg> = {};
    const asns: Record<string, EdgeAgg> = {};
    let total = 0;
    for (const day of Object.values(telemetry.days)) {
        total += day.total ?? 0;
        for (const [k, a] of Object.entries(day.colos ?? {})) {
            const t = colos[k] ?? (colos[k] = emptyAgg());
            t.n += a.n; t.rttSum += a.rttSum; t.rttMax = Math.max(t.rttMax, a.rttMax); t.ws += a.ws;
            t.upSum += a.upSum ?? 0; t.downSum += a.downSum ?? 0;
        }
        for (const [k, a] of Object.entries(day.asns ?? {})) {
            const t = asns[k] ?? (asns[k] = emptyAgg());
            t.n += a.n; t.rttSum += a.rttSum; t.rttMax = Math.max(t.rttMax, a.rttMax); t.ws += a.ws;
            t.upSum += a.upSum ?? 0; t.downSum += a.downSum ?? 0;
        }
    }

    const totals = getTrafficTotals(telemetry);
    if (totals.down > 0 || totals.up > 0) {
        lines.push('', `📊 <b>Traffic (observed):</b> ↓ ${formatBytes(totals.down)} · ↑ ${formatBytes(totals.up)}`);
    }

    lines.push('', '🌍 <b>Colo (CF datacenter):</b>');
    for (const [colo, a] of topAggs(colos, 5)) {
        lines.push(`• ${fmtAgg(colo, a)}`);
    }

    lines.push('', '📡 <b>ISPs (ASN):</b>');
    for (const [asn, a] of topAggs(asns, 6)) {
        lines.push(`• ${fmtAgg(asn, a)}`);
    }

    lines.push(
        '',
        `Samples: ${total} (last ${Object.keys(telemetry.days).length} day(s))${telemetry.dropped ? ' — ⚠️ daily cap hit, older samples dropped' : ''}`,
        '',
        '💡 <code>/cdn-cgi/trace</code> on your domain shows colo/TLS/ECH for free (zero CPU).',
        '💡 RTT spike for an ISP = entry degradation → Edge-Tuner retunes automatically.'
    );

    return lines.join('\n');
}
