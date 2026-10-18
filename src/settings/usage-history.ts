import { safeError } from '@common';

/**
 * سری زمانی مصرف روزانه در KV — یک کلید واحد (usageHistory) شامل نگاشتِ
 * «تاریخ UTC → نمونه مصرف» برای ۳۱ روز اخیر.
 *
 * چرا یک کلید؟
 *  - هر خواندنِ نمودار فقط یک عملیات KV است (به‌جای N کلید روزانه)
 *  - حجم: ۳۱ روز × ~۷۰ بایت ≈ ۲.۲KB — خیلی زیر سقف ۲۵MB هر مقدار KV
 *  - هرس خودکار در همان write — بدون نیاز به cron یا پاک‌سازی دستی
 *
 * منبع داده: endpoint افتراقی Cloudflare (GraphQL) ۲۴ ساعت اخیر را برمی‌گرداند؛
 * هر بار که پنل آن را می‌گیرد، یک نمونه برای «امروز» ثبت می‌شود
 * (آخرین نمونه‌ی روز برنده است — چون پنجره ۲۴ ساعته‌ی CF همیشه تازه‌ترین است).
 */

export interface UsageDay {
    /** تاریخ UTC به شکل YYYY-MM-DD */
    date: string;
    /** کل درخواست‌های اکانت در پنجره ۲۴ ساعته‌ی آخرین نمونه */
    total: number;
    /** درخواست‌های خود Worker (فلش‌پنل) */
    worker: number;
    /** چند نمونه در این روز ثبت شده (تشخیص کیفیت داده) */
    samples: number;
    /** زمان آخرین ثبت به‌صورت epoch ms */
    updatedAt: number;
}

const USAGE_KEY = 'usageHistory';
const MAX_DAYS = 31;

/**
 * 🍳 رژیم write (v0.8.7) — سهمیه‌ی KV رایگان فقط ۱٬۰۰۰ put/روز است.
 * نمونه‌گیری هر ۳۰ دقیقه cron + هر باز شدن پنل یعنی ده‌ها put اضافه در روز،
 * در حالی که نمودار فقط دانه‌بندی روزانه دارد. نمونه‌ی تازه‌تر از این فاصله
 * نوشته نمی‌شود (خواندن KV ارزان است — ۱۰۰ هزار/روز — فقط put گران است).
 */
export const USAGE_SAMPLE_MIN_INTERVAL_MS = 3 * 3_600_000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function utcDateKey(d: Date = new Date()): string {
    return d.toISOString().slice(0, 10);
}

function isUsageDay(v: unknown): v is UsageDay {
    if (typeof v !== 'object' || v === null) return false;
    const day = v as Record<string, unknown>;
    return typeof day.date === 'string'
        && DATE_RE.test(day.date)
        && typeof day.total === 'number'
        && Number.isFinite(day.total)
        && typeof day.worker === 'number'
        && Number.isFinite(day.worker)
        && typeof day.samples === 'number'
        && typeof day.updatedAt === 'number';
}

/** خواندن کل نگاشت با بازیابی امن — خرابی JSON یعنی شروع از صفر، نه کرش */
async function loadMap(env: Env): Promise<Record<string, UsageDay>> {
    try {
        const raw = await env.kv.get(USAGE_KEY, { type: 'json' });
        if (!raw || typeof raw !== 'object') return {};

        const clean: Record<string, UsageDay> = {};
        for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
            if (DATE_RE.test(key) && isUsageDay(value)) {
                clean[key] = value;
            }
        }
        return clean;
    } catch (error) {
        console.log(`usage-history: corrupted KV value ignored — ${safeError(error)}`);
        return {};
    }
}

/** هرس روزهای قدیمی‌تر از MAX_DAYS */
function prune(history: Record<string, UsageDay>): Record<string, UsageDay> {
    const cutoff = Date.now() - MAX_DAYS * 24 * 60 * 60 * 1000;
    const kept: Record<string, UsageDay> = {};
    for (const [date, day] of Object.entries(history)) {
        if (day.updatedAt >= cutoff) kept[date] = day;
    }
    return kept;
}

/** نتیجه‌ی ثبت — برای لاگ/تست */
export type UsageRecordOutcome = 'recorded' | 'throttled' | 'skipped';

/**
 * ثبت نمونه امروز — «آخرین نمونه برنده» چون پنجره ۲۴ ساعته CF همیشه تازه‌ترین
 * مقادیر را دارد. خطاها بلعیده می‌شوند تا هرگز پاس usage را خراب نکنند.
 *
 * v0.8.7: نمونه‌های تازه‌تر از USAGE_SAMPLE_MIN_INTERVAL_MS نوشته نمی‌شوند
 * (سقف ۱٬۰۰۰ put روزانه‌ی KV رایگان). تست‌ها می‌توانند با minIntervalMs: 0
 * رفتار قدیمی را بگیرند.
 */
export async function recordUsageSample(
    env: Env,
    total: number,
    worker: number,
    opts?: { minIntervalMs?: number }
): Promise<UsageRecordOutcome> {
    try {
        if (!Number.isFinite(total) || !Number.isFinite(worker)) return 'skipped';
        if (total < 0 || worker < 0) return 'skipped';

        const minIntervalMs = opts?.minIntervalMs ?? USAGE_SAMPLE_MIN_INTERVAL_MS;
        const history = prune(await loadMap(env));
        const date = utcDateKey();
        const prev = history[date];

        // 🍳 نمونه‌ی تازه داریم؟ هیچ چیزِ تازه‌ای برای نوشتن نیست — put نزن
        if (prev && minIntervalMs > 0 && Date.now() - prev.updatedAt < minIntervalMs) {
            return 'throttled';
        }

        history[date] = {
            date,
            total: Math.round(total),
            worker: Math.round(worker),
            samples: (prev?.samples ?? 0) + 1,
            updatedAt: Date.now()
        };

        await env.kv.put(USAGE_KEY, JSON.stringify(history));
        return 'recorded';
    } catch (error) {
        // ثبت نباید هرگز مسیر اصلی usage را بشکند
        console.log(`usage-history: record failed — ${safeError(error)}`);
        return 'skipped';
    }
}

export interface UsageHistoryResult {
    /** روزها صعودی؛ روزهای بدون داده null هستند تا محور نمودار پیوسته بماند */
    days: Array<UsageDay | null>;
    /** سقف روزانه Free (برای خط ۸۰٪ نمودار) */
    quotaDaily: number;
    /** تاریخ آخرین نمونه ثبت‌شده یا null */
    lastRecorded: string | null;
}

/**
 * تاریخچه N روز اخیر (پیش‌فرض ۳۰) با پرکردن شکاف‌ها —
 * روزهای گم‌شده null برمی‌گردند تا نمودار عرض یکنواخت داشته باشد.
 */
export async function getUsageHistory(env: Env, days = 30): Promise<UsageHistoryResult> {
    const safeDays = Math.min(Math.max(1, Math.floor(days) || 30), MAX_DAYS);
    const history = await loadMap(env);

    const result: Array<UsageDay | null> = [];
    const now = new Date();
    let lastRecorded: string | null = null;

    for (let i = safeDays - 1; i >= 0; i--) {
        const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
        const key = utcDateKey(d);
        const day = history[key];
        result.push(day ?? null);
        if (day && (!lastRecorded || key > lastRecorded)) {
            lastRecorded = key;
        }
    }

    return { days: result, quotaDaily: 100_000, lastRecorded };
}
