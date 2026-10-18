import { getGlobals } from '@settings';

/**
 * 🔐 احراز دوحالته‌ی Cloudflare API داخل ورکر (v0.8.7)
 *
 * دیپلوی‌های Flash Panel همیشه accEmail را embed می‌کنند، ولی apiToken بسته به
 * نصب می‌تواند دو چیز کاملاً متفاوت باشد:
 *   - API Token سکوپ‌دار  → فقط Bearer کار می‌کند
 *   - Global API Key      → Bearer همیشه رد می‌شود؛ باید X-Auth-Email + X-Auth-Key رفت
 *
 * قبل از این هلپر همه‌ی فراخوانی‌ها فقط Bearer می‌زدند → با Global Key، دکمه‌ی
 * Update پنل، گارد workers.dev و DNS همه بی‌صدا (یا با خطای گمراه‌کننده) شکست
 * می‌خوردند — همان الگویی که usage را «همیشه صفر» کرده بود.
 *
 * تشخیص: Global API Key دقیقاً ۳۷ کاراکتر hex است؛ API Token مدرن ۴۰ کاراکتر
 * base62. اگر کلید ۳۷-hex بود و ایمیل داشتیم → حالت Key، وگرنه Bearer.
 */
export function cfAuthHeaders(apiToken: string, accEmail?: string): Record<string, string> {
    if (accEmail && /^[0-9a-f]{37}$/i.test(apiToken)) {
        return { 'X-Auth-Email': accEmail, 'X-Auth-Key': apiToken };
    }
    return { Authorization: `Bearer ${apiToken}` };
}

/** میان‌بر: هدرهای CF را از تنظیمات embed‌شده بساز */
export function cfAuthFromGlobals(): Record<string, string> {
    const { apiToken, accEmail } = getGlobals();
    return cfAuthHeaders(apiToken, accEmail);
}
