import { getGlobals } from '@settings';

/**
 * استخراج قطعی نام اسکریپت ورکر — واحدِ همه‌ی تماس‌های CF API.
 *
 * 🐞 باگ قبلی (رفع‌شده در v0.8.3): همه‌جا `mainDomain.split('.')[0]` استفاده
 * می‌شد که برای دامنه‌ی شخصی (مثلاً fp.imsoroush.top) «fp» می‌داد، نه
 * «flash-panel» — نتیجه: آپدیت خودِ پنل به اسکریپت اشتباه می‌رفت
 * («Failed to update your Flash Panel») و آمار «Panel requests» در digest
 * همیشه صفر بود (فیلتر GraphQL scriptName:"fp" هیچ‌وقت match نمی‌شد).
 *
 * اولویت:
 *   1. EMBEDED_SETTINGS.scriptName — اگر موقع بیلد/دیپلوی تزریق شده باشد
 *   2. دامنه‌ی workers.dev → لیبل اول دقیقاً نام اسکریپت است
 *   3. نام پیش‌فرض محصول
 */
export function resolveWorkerName(): string {
    try {
        const globals = getGlobals() as { mainDomain?: string; scriptName?: string } | null;

        const pinned = globals?.scriptName?.trim();
        if (pinned) return pinned;

        const host = (globals?.mainDomain ?? '').split('/')[0].trim().toLowerCase();
        if (host.endsWith('.workers.dev')) {
            const label = host.split('.')[0];
            if (label) return label;
        }
    } catch {
        // globals مقداردهی نشده — پایین fallback می‌گیریم
    }
    return 'flash-panel';
}
