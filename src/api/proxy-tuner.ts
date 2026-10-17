import { runProxyIPBatchTest } from './proxy-check';
import { getGlobals, syncKvSettings } from '@settings';
import { invalidateDatasetCache } from '@kv';
import { safeError } from '@common';
import { KvSettings } from '#types/settings';

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

        // مقایسه با مقدار فعلی KV — بدون تغییر = بدون write (صرفه‌ی KV)
        const current = await env.kv.get('proxySettings', { type: 'json' }) as KvSettings | null;
        if (!current || typeof current !== 'object') {
            return { poolSize: pool.length, healthyCount: healthy.length, applied: top, best: top[0], changed: false, skipped: 'settings blob missing' };
        }

        const existing = Array.isArray(current.autoProxyIPs) ? current.autoProxyIPs : [];
        const changed = JSON.stringify(existing) !== JSON.stringify(top);

        if (!changed) {
            return { poolSize: pool.length, healthyCount: healthy.length, applied: top, best: top[0], changed: false };
        }

        const next: KvSettings = { ...current, autoProxyIPs: top };
        await env.kv.put('proxySettings', JSON.stringify(next));
        invalidateDatasetCache();
        syncKvSettings(next);

        return { poolSize: pool.length, healthyCount: healthy.length, applied: top, best: top[0], changed: true };
    } catch (error) {
        return { poolSize: 0, healthyCount: 0, applied: [], best: null, changed: false, skipped: safeError(error) };
    }
}
