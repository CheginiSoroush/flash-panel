import { KvSettings } from '#types/settings';
import { safeError } from '@common';
import { syncKvSettings } from '@settings';
import { invalidateDatasetCache } from './kv';

// ---------- موتور پایداری proxySettings (معماری v2 — v0.8.11) ----------
//
// تا v0.8.10 هر ماژول خودش get→mutate→put دست‌ساز انجام می‌داد:
//   • دو isolate / دو درخواست همزمان → ازدست‌رفتن آپدیت (نویسنده‌ی آخرِ
//     کل blob را روی نسخه‌ی کهنه‌ی خودش می‌نویسد و تغییر دیگری پاک می‌شود)
//   • هر write کوچک = rewrite کامل blob — حتی وقتی هیچ چیزی عوض نشده
//   • خطای گذرای KV = داده‌ی ادمین نمی‌نشست (بدون retry)
//   • سقف روزانه‌ی KV (1,000 put) = پیام خطای خام در پنل/ربات
//
// این ماژول «تنها نقطه‌ی عبور» نوشتنِ blob است:
//   ۱) صف نوشتن per-isolate — تراکنش‌های همزمان serialize می‌شوند
//      (نابودکننده‌ی کامل کلاس باگ lost-update درون یک isolate)
//   ۲) خواندنِ تازه داخل صف (نه کش ۵ ثانیه‌ای) — پایه‌ی write همیشه جدیدترین
//   ۳) skip بدون تغییر — خروجی mutator با current برابر بود → هیچ put نمی‌زنیم
//      (صرفه‌ی سهمیه؛ رفتاری که قبلاً فقط tuner ها دست‌ساز داشتند)
//   ۴) settingsRev — شمارنده‌ی نسخه‌ی blob (پایه‌ی ردیابی و همگرای آینده)
//   ۵) retry با backoff برای خطای گذرا (یک تلاش مجدد)
//   ۶) آگاهی از سهمیه — 429 واقعی → مهر تا نیمه‌شب UTC؛ write های «ضمنی»
//      (cron/self-heal) بعد از آن skip-fast می‌شوند — تعمیم رژیم degrade
//      v0.8.9 از «فقط مهاجرت» به همه‌ی write های ضمنی
//   ۷) یک نقطه‌ی invalidate کش دیتاست + sync snapshot ماژول

export interface StoreWriteResult {
    /** put موفق (یا بی‌تغییر skip شده) */
    ok: boolean;
    /** blob واقعاً عوض شد و put شد */
    changed: boolean;
    /** وضعیت نهایی — روی شکست، همان current خوانده‌شده */
    settings: KvSettings | null;
    /** 'unchanged' | 'kv quota' | دلیل سفارشی mutator */
    skipped?: string;
    error?: string;
}

export interface SkipSignal {
    __kvSkip: string;
}

export type SettingsMutatorResult = KvSettings | null | SkipSignal;
/** mutator ممکن است async باشد (مثل clean-tuner که داخل تراکنش DoH می‌زند) */
export type SettingsMutator = (current: KvSettings | null) => SettingsMutatorResult | Promise<SettingsMutatorResult>;

export interface MutateOptions {
    /** برچسب ساختاریافته برای لاگ — مثل 'telegram:cleanIPs' یا 'proxy-tune' */
    reason: string;
    /** write خودکارِ پس‌زمینه (cron/self-heal) — با سهمیه‌ی مرده skip-fast می‌شود */
    implicit?: boolean;
}

/** سیگنال «این تراکنش عمداً نوشتن را رد می‌کند» — برای مسیرهای شرطی tuner ها */
export function skipWrite(reason: string): SkipSignal {
    return { __kvSkip: reason };
}

const PUT_RETRY_DELAY_MS = 300;

let quotaExhaustedUntil = 0;
let writeChain: Promise<unknown> = Promise.resolve();

/** ریست وضعیت ماژول بین تست‌ها (صف + مهر سهمیه) */
export function _resetStoreStateForTest(): void {
    quotaExhaustedUntil = 0;
    writeChain = Promise.resolve();
}

/** آیا مهر سهمیه‌ی مرده فعّال است؟ (برای لاگ/تلمتری و تصمیم caller های ضمنی) */
export function isKvQuotaMarked(): boolean {
    return Date.now() < quotaExhaustedUntil;
}

function isQuotaError(error: unknown): boolean {
    return /limit exceeded|429|too many requests/i.test(safeError(error));
}

function nextUtcMidnight(): number {
    const now = new Date();
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
}

/**
 * مقایسه بدون settingsRev — rev فقط توسط commit بامپ می‌شود و نباید در تشخیص
 * «بی‌تغییر» نقش بگیرد (وگرنه هر commit، commit بعدی را تغییرِ کاذب می‌بیند).
 */
function withoutRev(s: KvSettings | null): Record<string, unknown> | null {
    if (!s || typeof s !== 'object') return null;
    const { settingsRev: _rev, ...rest } = s as KvSettings & { settingsRev?: number };
    return rest;
}

function serialize(s: KvSettings | null): string | null {
    const bare = withoutRev(s);
    return bare ? JSON.stringify(bare) : null;
}

/**
 * هسته‌ی نوشتن — برای مسیرهایی که current را خودشان خوانده‌اند (merge/heal).
 *
 *   بی‌تغییر → بدون put (changed:false)
 *   تغییر    → rev++ → put با retry خطای گذرا + مهر سهمیه روی 429
 *             → invalidate کش دیتاست + sync snapshot ماژول
 *
 * در شکست نهایی throw می‌کند (قرارداد قبلی merge/updateDataset — caller
 * تصمیم می‌گیرد error page بدهد یا best-effort ادامه دهد).
 */
export async function commitSettingsBlob(
    env: Env,
    current: KvSettings | null,
    next: KvSettings,
    opts: { reason: string; implicit?: boolean }
): Promise<{ changed: boolean; settings: KvSettings }> {
    if (serialize(next) === serialize(current)) {
        // هیچ چیز عوض نشده — سهمیه دست‌نخورده می‌ماند
        return { changed: false, settings: current ?? next };
    }

    if (opts.implicit && isKvQuotaMarked()) {
        // write ضمنی هنگام سهمیه‌ی مرده — تلاش بی‌معناست؛ زودتر رد شو
        throw new Error('KV put skipped — daily quota exhausted (marked)');
    }

    const rev = (current?.settingsRev ?? 0) + 1;
    const blob: KvSettings = { ...next, settingsRev: rev };
    const body = JSON.stringify(blob);

    for (let attempt = 1; ; attempt++) {
        try {
            await env.kv.put('proxySettings', body);
            invalidateDatasetCache();
            syncKvSettings(blob);
            console.log(`[kv-store] commit ok reason=${opts.reason} rev=${rev} attempt=${attempt}${opts.implicit ? ' (implicit)' : ''}`);
            return { changed: true, settings: blob };
        } catch (error) {
            if (isQuotaError(error)) {
                // 429 واقعی از CF — تا نیمه‌شب UTC مهر بزن
                quotaExhaustedUntil = nextUtcMidnight();
                console.log(`[kv-store] quota exhausted (reason=${opts.reason}) — implicit writes skip until UTC midnight`);
                throw error;
            }
            if (attempt === 1) {
                console.log(`[kv-store] transient put failure (reason=${opts.reason}) — retry in ${PUT_RETRY_DELAY_MS}ms: ${safeError(error)}`);
                await new Promise(resolve => setTimeout(resolve, PUT_RETRY_DELAY_MS));
                continue;
            }
            console.log(`[kv-store] commit FAILED reason=${opts.reason} after ${attempt} attempts: ${safeError(error)}`);
            throw error;
        }
    }
}

/**
 * تراکنش متمرکز خواندن-تغییر-نوشتن روی proxySettings.
 *
 * ترتیب تضمین‌شده: صف → خواندن تازه → mutator → no-op skip → rev → put
 * با retry/سهمیه → invalidate+sync. هرگز throw نمی‌کند — نتیجه ساختاریافته است.
 *
 * mutator ممکن است برگرداند:
 *   - KvSettings جدید  → commit (با no-op skip)
 *   - null             → بدون تغییر (ok:true, changed:false)
 *   - skipWrite(reason) → skip ساختاریافته (ok:true, changed:false, skipped)
 */
export async function mutateSettings(
    env: Env,
    mutator: SettingsMutator,
    opts: MutateOptions
): Promise<StoreWriteResult> {
    const run = writeChain.catch(() => undefined).then(async (): Promise<StoreWriteResult> => {
        if (opts.implicit && isKvQuotaMarked()) {
            return { ok: false, changed: false, settings: null, skipped: 'kv quota' };
        }

        // خواندن تازه داخل صف — پایه‌ی write هرگز از کش ۵ ثانیه‌ای نمی‌آید
        let current: KvSettings | null = null;
        try {
            current = await env.kv.get('proxySettings', { type: 'json' }) as KvSettings | null;
        } catch (error) {
            return { ok: false, changed: false, settings: null, error: safeError(error) };
        }

        let next: KvSettings | null | SkipSignal;
        try {
            next = await mutator(current);
        } catch (error) {
            return { ok: false, changed: false, settings: current, error: safeError(error) };
        }

        if (next && typeof next === 'object' && '__kvSkip' in next) {
            return { ok: true, changed: false, settings: current, skipped: next.__kvSkip };
        }
        if (!next) {
            return { ok: true, changed: false, settings: current, skipped: 'unchanged' };
        }

        try {
            const { changed, settings } = await commitSettingsBlob(env, current, next, opts);
            // no-op در سطح commit هم برچسب یکسان می‌گیرد — caller یک قرارداد دارد
            return changed
                ? { ok: true, changed: true, settings }
                : { ok: true, changed: false, settings, skipped: 'unchanged' };
        } catch (error) {
            return { ok: false, changed: false, settings: current, error: safeError(error) };
        }
    });

    writeChain = run;
    return run;
}
