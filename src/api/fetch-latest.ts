import { safeError } from '@common';

/**
 * 🔄 موتور مقاوم دریافت آخرین ریلیز worker.js برای به‌روزرسانی خودکار پنل.
 *
 * مشکل ریشه‌ای: دانلود مستقیم از github.com/releases/latest/download از سمت
 * IPهای مشترک لبه‌ی کلادفلر اغلب 403/429 می‌گیرد (rate-limit گیت‌هاب روی
 * IPهای اشتراکی) — همان خطایی که کاربر با «Failed to update» می‌دید.
 *
 * راه‌حل: زنجیره‌ی آینه‌ها + تلاش مجدد با backoff + اعتبارسنجی محتوا + کش.
 *   1) GitHub Releases  — مرجع رسمی
 *   2) GitHub Pages     — site/download/worker.js (release.yml با هر ریلیز commit می‌کند؛ CDN فست‌لی، rate-limit ندارد)
 *   3) jsDelivr         — @gh-pages همان فایل از CDN جهانی
 */

const MIRRORS: readonly { name: string; url: string }[] = [
    {
        name: 'github-releases',
        url: 'https://github.com/CheginiSoroush/flash-panel/releases/latest/download/worker.js'
    },
    {
        name: 'github-pages',
        url: 'https://cheginisoroush.github.io/flash-panel/download/worker.js'
    },
    {
        name: 'jsdelivr',
        url: 'https://cdn.jsdelivr.net/gh/CheginiSoroush/flash-panel@gh-pages/download/worker.js'
    }
];

/** حداقل حجم معتبر برای باندل worker (خطاهای HTML/صفحه‌ی خطا را رد می‌کند) */
const MIN_SCRIPT_LENGTH = 50_000;
/** باندل ESM ورکر همیشه export default دارد */
const SCRIPT_MARKER = 'export default';

/** هر 403/429/5xx قابل تلاش مجدد است؛ 404 نه (فایل واقعاً نیست) */
function isRetryableStatus(status: number): boolean {
    return status === 403 || status === 429 || status >= 500;
}

export interface ScriptFetchResult {
    script: string;
    source: string;
    fetchedAt: number;
}

interface FetchState {
    cache: ScriptFetchResult | null;
    inflight: Promise<ScriptFetchResult> | null;
}

// کش سطح isolate — تلاش‌های پشت‌سرهم به‌روزرسانی (مثلاً چند ادمین یا retry UI)
// فقط یک واکشی واقعی انجام می‌دهند (همان الگوی کش DoH)
const state: FetchState = { cache: null, inflight: null };

export function invalidateLatestScriptCache(): void {
    state.cache = null;
    state.inflight = null;
}

function isValidWorkerScript(script: string): boolean {
    return script.length >= MIN_SCRIPT_LENGTH && script.includes(SCRIPT_MARKER);
}

interface MirrorOutcome {
    source: string;
    ok: boolean;
    status?: number;
    error?: string;
}

async function fetchFromMirror(
    mirror: { name: string; url: string },
    fetchImpl: typeof fetch,
    timeoutMs: number,
    now: () => number
): Promise<ScriptFetchResult> {
    const res = await fetchImpl(mirror.url, {
        // redirect خودکار دنبال می‌شود (release asset → objects.githubusercontent.com)
        signal: AbortSignal.timeout(timeoutMs)
    });

    if (!res.ok) {
        const err = new Error(`status ${res.status}`);
        (err as Error & { status?: number }).status = res.status;
        throw err;
    }

    const script = await res.text();
    if (!isValidWorkerScript(script)) {
        // پاسخ 200 ولی محتوا معتبر نیست (صفحه‌ی خطا/حجم ناقص) — مثل خطا رفتار کن
        const err = new Error(`invalid content (length ${script.length})`);
        (err as Error & { status?: number }).status = 502;
        throw err;
    }

    return { script, source: mirror.name, fetchedAt: now() };
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * دریافت آخرین worker.js از اولین آینه‌ی سالم.
 * هر آینه: تلاش اول + یک تلاش مجدد برای خطاهای retryable (با backoff).
 * خطاها جمع‌بندی می‌شوند تا پیام نهایی دقیق بگوید کجای کار لنگید.
 */
export async function fetchLatestWorkerScript(options?: {
    fetchImpl?: typeof fetch;
    attempts?: number;
    timeoutMs?: number;
    now?: () => number;
    cacheTtlMs?: number;
    backoffMs?: number;
}): Promise<ScriptFetchResult> {
    const fetchImpl = options?.fetchImpl ?? fetch;
    const attempts = options?.attempts ?? 2;
    const timeoutMs = options?.timeoutMs ?? 12_000;
    const now = options?.now ?? Date.now;
    const cacheTtlMs = options?.cacheTtlMs ?? 10 * 60_000;
    const backoffMs = options?.backoffMs ?? 800;

    // کش تازه؟ هیچ CPU/شبکه‌ای هزینه ندارد
    if (state.cache && now() - state.cache.fetchedAt < cacheTtlMs) {
        return state.cache;
    }

    // درخواست هم‌زمان دوباره از همان isolate → یکی واکشی می‌کند، بقیه منتظر
    if (state.inflight) return state.inflight;

    const job = (async (): Promise<ScriptFetchResult> => {
        const outcomes: MirrorOutcome[] = [];

        for (const mirror of MIRRORS) {
            for (let attempt = 1; attempt <= attempts; attempt++) {
                try {
                    const result = await fetchFromMirror(mirror, fetchImpl, timeoutMs, now);
                    state.cache = result;
                    return result;
                } catch (error) {
                    const status = (error as Error & { status?: number }).status;
                    outcomes.push({
                        source: mirror.name,
                        ok: false,
                        status,
                        error: safeError(error)
                    });

                    // 404 یعنی فایل در این آینه نیست — برو آینه‌ی بعد، تلاش مجدد بی‌فایده
                    if (status === 404) break;
                    // خطای retryable (403/429/5xx) یا خطای شبکه بدون status (timeout/DNS)؟ backoff کوتاه
                    const retryable = status === undefined || isRetryableStatus(status);
                    if (attempt < attempts && retryable) {
                        await sleep(backoffMs * attempt);
                    }
                }
            }
        }

        const summary = outcomes
            .map(o => `${o.source}${o.status ? ` (${o.status})` : ''}${o.error && !o.status ? ` (${o.error})` : ''}`)
            .join(', ');

        throw new Error(`all mirrors failed — ${summary}`);
    })();

    state.inflight = job;
    try {
        return await job;
    } finally {
        state.inflight = null;
    }
}
