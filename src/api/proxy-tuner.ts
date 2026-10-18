import { runProxyIPBatchTest } from './proxy-check';
import { getGlobals } from '@settings';
import { mutateSettings, skipWrite } from '@settings/store';
import { safeError } from '@common';

// ---------- Auto-Tune ProxyIP ----------
// هر ۶ ساعت (گارد در automation) لیست استخر فعلی + کاندیداهای عمومی تست
// می‌شود و ۳ واسط سالمِ سریع در KV ذخیره می‌شود (autoProxyIPs). مسیر داده
// بدون redeploy و بدون KV-خوانی اضافی (از همان چرخه‌ی ۵ دقیقه‌ای نگهبان)
// از این لیست استفاده می‌کند — ProxyIP مرده دیگر هرگز اتصال‌ها را گرون نمی‌کند.
//
// ایمنی:
//   - هیچ کاندیدای مرده‌ای استفاده نمی‌شود (تست قبل از انتخاب)
//   - اگر هیچ سالمی نبود، لیست قبلی دست‌نخورده می‌ماند (آخرین حالت خوب بهتر از پاک‌کردن)
//   - شکست کل فرآیند فقط return خطاست — هرگز scheduled را crash نمی‌کند

export const AUTO_PROXY_CANDIDATES: string[] = [
    'bpb.yousef.isegaro.com',      // پیش‌فرض فعلی پنل (زنده — چند IP رله)
    'proxyip.fxxk.dedyn.io',       // لیست معروف CM (زنده — CNAME به لبه‌ی CF)
    'proxyip.us.fxxk.dedyn.io',    // واریانت منطقه‌ای US (زنده)
    'proxyip.jp.fxxk.dedyn.io'     // واریانت منطقه‌ای JP (زنده)
];

const TUNE_TOP_N = 3;
const TUNE_MAX_POOL = 12;

export interface ProxyTuneResult {
    poolSize: number;
    healthyCount: number;
    applied: string[];
    best: string | null;
    changed: boolean;
    skipped?: string;
}

/**
 * استخر = لیست ادمین/فعلی + کاندیداهای عمومی → تست → top-3 سالم → KV.
 */
export async function tuneProxyIPs(env: Env): Promise<ProxyTuneResult> {
    try {
        const { proxyIPs } = getGlobals();
        const pool = [...new Set([...(proxyIPs ?? []), ...AUTO_PROXY_CANDIDATES].filter(Boolean))]
            .slice(0, TUNE_MAX_POOL);

        const results = await runProxyIPBatchTest(pool, { concurrency: 4, attempts: 2 });
        const healthy = results.filter(r => r.ok).map(r => r.target);

        if (!healthy.length) {
            return { poolSize: pool.length, healthyCount: 0, applied: [], best: null, changed: false, skipped: 'no healthy proxy ip' };
        }

        const top = healthy.slice(0, TUNE_TOP_N);

        // تراکنش متمرکز: خواندن تازه داخل صف + no-op skip + rev + retry + سهمیه‌آگاه
        // (قبلاً get→put دست‌ساز بود و با ذخیره‌ی همزمان پنل/ربات race داشت)
        const res = await mutateSettings(env, (current) => {
            if (!current || typeof current !== 'object') {
                return skipWrite('settings blob missing');
            }

            const existing = Array.isArray(current.autoProxyIPs) ? current.autoProxyIPs : [];
            // مقایسه با مقدار فعلی KV — بدون تغییر = بدون write (صرفه‌ی KV)
            if (JSON.stringify(existing) === JSON.stringify(top)) {
                return null;
            }
            return { ...current, autoProxyIPs: top };
        }, { reason: 'proxy-tune', implicit: true });

        if (res.skipped && res.skipped !== 'unchanged') {
            return { poolSize: pool.length, healthyCount: healthy.length, applied: top, best: top[0], changed: false, skipped: res.skipped };
        }
        if (!res.ok) {
            return { poolSize: pool.length, healthyCount: healthy.length, applied: top, best: top[0], changed: false, skipped: res.error ?? 'commit failed' };
        }

        return { poolSize: pool.length, healthyCount: healthy.length, applied: top, best: top[0], changed: res.changed };
    } catch (error) {
        return { poolSize: 0, healthyCount: 0, applied: [], best: null, changed: false, skipped: safeError(error) };
    }
}
