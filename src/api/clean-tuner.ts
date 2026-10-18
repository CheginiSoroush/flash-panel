import {
    dayRankHash,
    isCloudflareEdgeIPv4,
    isValidCleanEntry
} from './clean-ip';
import { mutateSettings, skipWrite } from '@settings/store';
import { safeError } from '@common';
import { KvSettings } from '#types/settings';

// ---------- Auto-Tune CleanIPs (v0.8.2 — اوراکل دو لایه: اعتبار + زنده‌بودن) ----------
//
// معکوس‌مهندسی زنده (v0.8.1/0.8.2):
//   ۱) سوکت Worker → IP لبه‌ی CF در سطح پلتفرم cancel می‌شود ("Stream was
//      cancelled") — تست سوکتی نسخه‌ی 0.7.9 از نظر ساختاری هیچ‌وقت نمی‌توانست
//      کاندیدای واقعی CF را تأیید کند؛ نتیجه همیشه 'no healthy clean ip' بود.
//   ۲) عضویت در رنج رسمی فقط «اعتبار» را اثبات می‌کند، نه «زنده‌بودن»: از ۱۴
//      IP تصادفی داخل رنج فقط ۴ تا واقعاً سرویس می‌دادند (رنج‌های منتشرشده
//      IP تاریک/dark دارند — مخصوصاً نقاط مرزی مثل x.x.x.1).
//
// اوراکل نهایی:
//   - IPv4 خارج از رنج‌های رسمی CF (مثل Google/GCP) = قطعاً مرده → جایگزین
//   - کاندیدای جایگزین = IPهای داخل رکورد A دامنه‌های واقعاً CF-fronted که
//     همین لحظه با DoH (JSON API — fetch مجاز است) واکشی می‌شوند → تضمین
//     زنده‌بودن؛ رتبه‌بندی قطعی روزانه (تنوع ضد-فیلترینگ، idempotent در روز)
//   - fallback ثابت = فقط IPهایی که در دیاگ زنده تأیید شدند
//   - دامنه = معتبر (قصد ادمین — مثل www.speedtest.net که CF-fronted است)
//
// سیاست محافظه‌کار (حفظ شده):
//   - ورودی معتبر ادمین هرگز حذف/جابجا نمی‌شود (churn = صفر)
//   - customCdnAddrs و customDomain همیشه می‌مانند
//   - لیست خالی = دخالت نمی‌کند (پیش‌فرض EMBEDED حاکم می‌شود)
//   - هیچ IP تأییدنشده‌ای نوشته نمی‌شود؛ کاندیدای صفر = بدون write
//   - فقط تغییر واقعی → یک write (صرفه‌ی KV)

export interface CleanTuneResult {
    poolSize: number;
    healthyCount: number;
    applied: string[];
    best: string | null;
    changed: boolean;
    skipped?: string;
}

// ---------- منابع کاندیدای زنده ----------

/** دامنه‌های CF-fronted معروف — A record آن‌ها = IP لبه‌ی قطعاً زنده */
const CLEAN_DNS_SEED_HOSTS: string[] = [
    'speed.cloudflare.com',
    'www.speedtest.net',
    'www.cloudflare.com',
    'cf.090227.xyz',        // جمع‌کننده‌ی معروف جامعه (خودش CF-fronted)
    'workers.dev',
    'pages.dev'
];

/**
 * fallback ثابت — فقط IPهایی که در دیاگ زنده‌ی 2026-10-18 (TLS با SNI پنل)
 * واقعاً گواهی دادند. هیچ IP «حدسی» در این لیست جایی ندارد.
 */
const CLEAN_VERIFIED_FALLBACK: string[] = [
    '104.17.147.22',    // www.speedtest.net
    '104.17.148.22',    // www.speedtest.net
    '162.159.140.220',  // speed.cloudflare.com
    '172.66.0.218',     // speed.cloudflare.com
    '104.16.160.3',     // تأییدشده در دیاگ
    '104.16.123.96',    // www.cloudflare.com
    '172.64.32.11',     // تأییدشده در دیاگ
    '172.67.68.4',      // تأییدشده در دیاگ
    '190.93.246.1'      // تأییدشده در دیاگ
];

const DOH_TIMEOUT_MS = 4000;
const DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query';

/** A record های زنده‌ی دامنه‌های بذری — فقط عضوهای رنج رسمی CF برمی‌گردند */
async function fetchLiveEdgeIPs(mainDomain?: string): Promise<string[]> {
    const hosts = mainDomain ? [...CLEAN_DNS_SEED_HOSTS, mainDomain] : CLEAN_DNS_SEED_HOSTS;
    const settled = await Promise.allSettled(hosts.map(async (host) => {
        const res = await fetch(`${DOH_ENDPOINT}?name=${encodeURIComponent(host)}&type=A`, {
            headers: { accept: 'application/dns-json' },
            signal: AbortSignal.timeout(DOH_TIMEOUT_MS)
        });
        if (!res.ok) throw new Error(`DoH HTTP ${res.status}`);
        const data = await res.json() as { Answer?: Array<{ type: number; data: string }> };
        return (data.Answer ?? [])
            .filter(a => a.type === 1 && typeof a.data === 'string')
            .map(a => a.data);
    }));

    const ips = new Set<string>();
    for (const s of settled) {
        if (s.status !== 'fulfilled') continue;
        for (const ip of s.value) {
            if (isCloudflareEdgeIPv4(ip)) ips.add(ip);
        }
    }
    return [...ips];
}

export async function tuneCleanIPs(env: Env, now: number = Date.now()): Promise<CleanTuneResult> {
    try {
        // نتایج داخل mutator جمع می‌شود تا دقیقاً همان قرارداد قبلی result برگردد
        let info: CleanTuneResult | null = null;

        const res = await mutateSettings(env, async (blob) => {
            if (!blob || typeof blob !== 'object') {
                return skipWrite('settings blob missing');
            }

            const protectedEntries = new Set<string>([
                ...(Array.isArray(blob.customCdnAddrs) ? blob.customCdnAddrs : []),
                ...(blob.customDomain ? [blob.customDomain] : [])
            ]);

            const current = (Array.isArray(blob.cleanIPs) ? blob.cleanIPs : [])
                .filter((x): x is string => typeof x === 'string' && x.trim() !== '');

            if (!current.length) {
                return skipWrite('cleanIPs empty — EMBEDED default applies');
            }

            // دسته‌بندی: محافظت‌شده / معتبر / نامعتبر (فقط IPv4 خارج از رنج CF)
            const keptProtected: string[] = [];
            const valid: string[] = [];
            const invalid: string[] = [];
            for (const entry of current) {
                if (protectedEntries.has(entry)) keptProtected.push(entry);
                else if (isValidCleanEntry(entry)) valid.push(entry);
                else invalid.push(entry);
            }

            if (!invalid.length) {
                // همه معتبر — بدون write (کمترین churn)
                const best = valid[0] ?? keptProtected[0] ?? null;
                info = { poolSize: current.length, healthyCount: current.length, applied: current, best, changed: false };
                return null;
            }

            // کاندیداهای زنده: DoH (تازه) + fallback تأییدشده — بدون حدس
            // (فقط وقتی ترمیم لازم است شبکه می‌زند — مسیر سریع همان KC طی می‌کند)
            const dayBucket = Math.floor(now / 86_400_000);
            const taken = new Set([...keptProtected, ...valid]);
            let pool: string[] = [];
            try {
                const blobMainDomain = (blob as { mainDomain?: unknown }).mainDomain;
                pool = await fetchLiveEdgeIPs(typeof blobMainDomain === 'string' ? blobMainDomain : undefined);
            } catch {
                pool = [];
            }
            pool = pool.filter(ip => !taken.has(ip));
            for (const ip of CLEAN_VERIFIED_FALLBACK) {
                if (pool.length >= invalid.length) break;
                if (!taken.has(ip) && !pool.includes(ip)) pool.push(ip);
            }

            if (!pool.length) {
                // هیچ کاندیدای تأییدشده‌ای نیست — لیست فعلی دست‌نخورده (بهتر از حدس)
                info = { poolSize: current.length, healthyCount: valid.length, applied: current, best: valid[0] ?? null, changed: false, skipped: 'no verified live candidates (DoH down?)' };
                return null;
            }

            // رتبه‌بندی قطعی روزانه → جایگزینی ۱:۱ (کم‌بودن کاندیدا = جایگزینی جزئی
            // با حفظ اندازه: باقیمانده‌ی نامعتبرها موقتاً می‌مانند تا تیک بعدی)
            const ranked = [...pool].sort((a, b) => dayRankHash(a, dayBucket) - dayRankHash(b, dayBucket));
            const candidates = ranked.slice(0, invalid.length);
            const merged = [...new Set([...keptProtected, ...valid, ...candidates])];
            for (const entry of invalid) {
                if (merged.length >= current.length) break;
                merged.push(entry);
            }
            const applied = merged.slice(0, current.length);

            if (JSON.stringify(applied) === JSON.stringify(current)) {
                info = { poolSize: current.length, healthyCount: valid.length + candidates.length, applied: current, best: valid[0] ?? null, changed: false };
                return null;
            }

            info = {
                poolSize: current.length,
                healthyCount: valid.length + candidates.length,
                applied,
                best: applied.find(e => !protectedEntries.has(e)) ?? applied[0] ?? null,
                changed: true
            };
            // فقط slice فیلد cleanIPs عوض می‌شود — بقیه‌ی blob دست‌نخورده (no-op skip موتور هم فعال است)
            return { ...blob, cleanIPs: applied };
        }, { reason: 'clean-tune', implicit: true });

        if (info) return info;

        // mutator به مرحله‌ی نتیجه نرسید — skip/خطا را به قرارداد قبلی ترجمه کن
        if (res.skipped && res.skipped !== 'unchanged') {
            return { poolSize: 0, healthyCount: 0, applied: [], best: null, changed: false, skipped: res.skipped };
        }
        return { poolSize: 0, healthyCount: 0, applied: [], best: null, changed: false, skipped: res.error ?? 'unchanged' };
    } catch (error) {
        return { poolSize: 0, healthyCount: 0, applied: [], best: null, changed: false, skipped: safeError(error) };
    }
}
