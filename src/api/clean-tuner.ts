import {
    CF_EDGE_RANGES,
    generateCleanCandidate,
    isValidCleanEntry
} from './clean-ip';
import { syncKvSettings } from '@settings';
import { invalidateDatasetCache } from '@kv';
import { safeError } from '@common';
import { KvSettings } from '#types/settings';

// ---------- Auto-Tune CleanIPs (v0.8.1 — بازطراحی مبتنی بر معکوس‌مهندسی) ----------
//
// تفاوت ماهوی با ProxyIP tuner: کاندیداهای ProxyIP سرورهای رله‌ی «غیر-CF»
// هستند (VPS های جامعه که :443 را به لبه‌ی CF فوروارد می‌کنند) و سوکت Worker
// به آن‌ها آزاد است — تست TCP+HTTP آن‌ها معنا دارد. ولی CleanIP ها خودِ
// «لبه‌ی Cloudflare»اند و پلتفرم، سوکت Worker → CF را cancel می‌کند
// (دیاگ زنده: "Stream was cancelled") — یعنی نسخه‌ی قبلی (تست سوکتی) از
// نظر ساختاری «هرگز» نمی‌توانست نه کاندیداها را تأیید کند و نه لیست خراب
// ادمین را ترمیم کند؛ نتیجه‌اش همیشه 'no healthy clean ip' بود.
//
// مدل جدید — اعتبارسنجی ساختاری (اثبات‌پذیر از لبه):
//   - IPv4 خارج از رنج‌های رسمی CF (مثل Google/GCP) = قطعاً مرده
//     (کلاینت با SNI دامنه‌ی ما وصل می‌شود → گواهی mismatch) → جایگزین
//   - IPv4 داخل رنج = معتبر → می‌ماند (سلامت واقعیِ ایران‌ساید فقط از
//     سمت ایران سنجیدنی است — هیچ اوراکلی از لبه وجود ندارد؛ صادقانه)
//   - دامنه = معتبر (قصد ادمین — مثل www.speedtest.net که CF-fronted است)
//
// کاندیداهای جایگزین: تولید قطعی با بذر روز UTC از رنج‌های رسمی CF —
// بدون اینترنت، بدون سوکت، هر روز ترکیب متفاوت (تنوع ضد-فیلترینگ).
//
// سیاست محافظه‌کار (حفظ شده):
//   - ورودی معتبر ادمین هرگز حذف/جابجا نمی‌شود (churn = صفر)
//   - customCdnAddrs و customDomain همیشه می‌مانند
//   - لیست خالی = دخالت نمی‌کند (پیش‌فرض EMBEDED حاکم می‌شود)
//   - فقط تغییر واقعی → یک write (صرفه‌ی KV)

export interface CleanTuneResult {
    poolSize: number;
    healthyCount: number;
    applied: string[];
    best: string | null;
    changed: boolean;
    skipped?: string;
}

export async function tuneCleanIPs(env: Env, now: number = Date.now()): Promise<CleanTuneResult> {
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

        if (!current.length) {
            return { poolSize: 0, healthyCount: 0, applied: [], best: null, changed: false, skipped: 'cleanIPs empty — EMBEDED default applies' };
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
            return { poolSize: current.length, healthyCount: current.length, applied: current, best, changed: false };
        }

        // جایگزینی ۱:۱ نامعتبرها با کاندیدای قطعی متمایز از همان روز
        const dayBucket = Math.floor(now / 86_400_000);
        const taken = new Set([...keptProtected, ...valid]);
        const candidates: string[] = [];
        for (let i = 0; candidates.length < invalid.length && i < invalid.length * 20 + 20; i++) {
            const candidate = generateCleanCandidate(dayBucket, i);
            if (!taken.has(candidate) && !candidates.includes(candidate)) {
                candidates.push(candidate);
            }
        }

        const applied = [...new Set([...keptProtected, ...valid, ...candidates])].slice(0, current.length);
        const changed = JSON.stringify(applied) !== JSON.stringify(current);
        if (!changed) {
            return { poolSize: current.length, healthyCount: valid.length + candidates.length, applied: current, best: valid[0] ?? null, changed: false };
        }

        const next: KvSettings = { ...blob, cleanIPs: applied };
        await env.kv.put('proxySettings', JSON.stringify(next));
        invalidateDatasetCache();
        syncKvSettings(next);

        return {
            poolSize: current.length,
            healthyCount: valid.length + candidates.length,
            applied,
            best: applied.find(e => !protectedEntries.has(e)) ?? applied[0] ?? null,
            changed: true
        };
    } catch (error) {
        return { poolSize: 0, healthyCount: 0, applied: [], best: null, changed: false, skipped: safeError(error) };
    }
}
