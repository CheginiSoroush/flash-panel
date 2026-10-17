import { runProxyIPBatchTest } from './proxy-check';
import { syncKvSettings } from '@settings';
import { invalidateDatasetCache } from '@kv';
import { safeError } from '@common';
import { KvSettings } from '#types/settings';

// ---------- Auto-Tune CleanIPs ----------
// همان فلسفه‌ی Auto-Tune ProxyIP ولی برای آدرس‌های رو-به-کلاینت (cleanIPs):
// فیلترینگ مدام تغییر می‌کند — IP تمیزِ امروز ممکن است فردا مُرد باشد و اولین
// پروفایل‌های ساب (که کاربر اول همان‌ها را تست می‌کند) بی‌جان شوند تا ادمین
// دستی عوضشان کند. حالا هر ۶ ساعت استخر فعلی + کاندیداهای عمومی از لبه‌ی CF
// تست می‌شود (TCP:443 + پاسخ ۴۰۰ با cf-ray = لبه‌ی زنده‌ی کلادفلر) و ورودی‌های
// مرده با سالم‌ترین کاندیداها جایگزین می‌شوند.
//
// سیاست محافظه‌کار:
//   - ورودی سالم ادمین هرگز حذف/جابجا نمی‌شود (حداقل churn)
//   - customCdnAddrs و customDomain اصلاً تست نمی‌شوند و همیشه می‌مانند
//     (دامنه‌های CDN شخصی ممکن است معیار تست relay را پاس نکنند ولی برای
//      مسیر پنل معتبر باشند)
//   - همه‌ی ورودی‌های فعلی سالم بودند → بدون write (صرفه‌ی KV)
//   - هیچ سالمی نبود → لیست قبلی دست‌نخورده (آخرین حالت خوب بهتر از خالی است)

export const CLEAN_IP_CANDIDATES: string[] = [
    'speed.cloudflare.com',     // دامنه‌ی رسمی تست سرعت CF — همیشه در رنج لبه
    '104.16.160.3',             // رنج 104.16/12
    '104.17.148.22',            // رنج 104.17/16
    '172.66.0.218',             // رنج 172.66/15
    '104.16.123.96',            // کاندیدای عمومی رنج 104.16
    '104.17.147.22',            // کاندیدای عمومی رنج 104.17
    '172.64.32.11',             // کاندیدای عمومی رنج 172.64
    '172.67.68.4',              // کاندیدای عمومی رنج 172.67
    '108.162.229.1',            // کاندیدای عمومی رنج 108.162
    '141.101.90.1',             // کاندیدای عمومی رنج 141.101
    '190.93.246.1'              // کاندیدای عمومی رنج 190.93 (آمریکای لاتین)
];

const CLEAN_TOP_N = 5;
const CLEAN_MAX_POOL = 16;

export interface CleanTuneResult {
    poolSize: number;
    healthyCount: number;
    applied: string[];
    best: string | null;
    changed: boolean;
    skipped?: string;
}

/**
 * استخر = cleanIPs فعلی + کاندیداهای عمومی → تست از لبه → جایگزینی مرده‌ها.
 * خواندن/نوشتن مستقیم blob (بدون وابستگی به snapshot ماژول — cron در isolate
 * سرد هم درست کار می‌کند، هم‌الگوی tuneProxyIPs).
 */
export async function tuneCleanIPs(env: Env): Promise<CleanTuneResult> {
    try {
        const blob = await env.kv.get('proxySettings', { type: 'json' }) as KvSettings | null;
        if (!blob || typeof blob !== 'object') {
            return { poolSize: 0, healthyCount: 0, applied: [], best: null, changed: false, skipped: 'settings blob missing' };
        }

        const protectedEntries = new Set<string>([
            ...(Array.isArray(blob.customCdnAddrs) ? blob.customCdnAddrs : []),
            ...(blob.customDomain ? [blob.customDomain] : [])
        ]);

        const current = (Array.isArray(blob.cleanIPs) ? blob.cleanIPs : [])
            .filter((x): x is string => typeof x === 'string' && x.trim() !== '');

        const pool = [...new Set([...current, ...CLEAN_IP_CANDIDATES])]
            .filter(entry => !protectedEntries.has(entry))
            .slice(0, CLEAN_MAX_POOL);

        const results = await runProxyIPBatchTest(pool, { concurrency: 4, attempts: 2 });
        const healthy = results.filter(r => r.ok); // مرتب: سالم‌ها اول، بعد سریع‌ترین
        const best = healthy[0]?.target ?? null;

        if (!healthy.length) {
            return { poolSize: pool.length, healthyCount: 0, applied: current, best: null, changed: false, skipped: 'no healthy clean ip' };
        }

        // ورودی‌های محافظت‌شده: همیشه می‌مانند (تست نشدند — ممکن است relay را پاس نکنند)
        const kept = current.filter(entry => protectedEntries.has(entry));
        const testableCurrent = current.filter(entry => !protectedEntries.has(entry));
        const healthySet = new Set(healthy.map(r => r.target));

        // همه‌ی ورودی‌های قابل‌تست سالم‌اند → لیست ادمین دست‌نخورده (بدون write)
        if (current.length && testableCurrent.every(entry => healthySet.has(entry))) {
            return { poolSize: pool.length, healthyCount: healthy.length, applied: current, best, changed: false };
        }

        const healthyCurrent = testableCurrent.filter(entry => healthySet.has(entry));
        const candidates = healthy.map(r => r.target).filter(t => !current.includes(t));

        // جایگزینی مرده‌ها با سریع‌ترین کاندیداها:
        //   - حداقل به اندازه‌ی لیست فعلی (بدون کوچک‌شدن)
        //   - ورودی‌های محافظت‌شده نباید کل اسلات‌ها را بگیرند — همیشه دست‌کم یک
        //     clean-IP قابل‌تست سالم در لیست بماند (kept + ۱)
        const targetSize = Math.max(current.length || CLEAN_TOP_N, kept.length + 1);
        const applied = [...new Set([...kept, ...healthyCurrent, ...candidates])]
            .slice(0, targetSize);

        const changed = JSON.stringify(applied) !== JSON.stringify(current);
        if (!changed) {
            return { poolSize: pool.length, healthyCount: healthy.length, applied: current, best, changed: false };
        }

        const next: KvSettings = { ...blob, cleanIPs: applied };
        await env.kv.put('proxySettings', JSON.stringify(next));
        invalidateDatasetCache();
        syncKvSettings(next);

        return { poolSize: pool.length, healthyCount: healthy.length, applied, best, changed: true };
    } catch (error) {
        return { poolSize: 0, healthyCount: 0, applied: [], best: null, changed: false, skipped: safeError(error) };
    }
}
