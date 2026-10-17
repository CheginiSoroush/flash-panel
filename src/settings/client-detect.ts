/**
 * تشخیص core اشتراک از پارامتر app و User-Agent
 *
 * پنل‌های قدیمی‌تر (BPB-مانند) در لینک اشتراک «نام کلاینت» را می‌فرستادند
 * (مثل app=v2rayNG یا app=Hiddify) و بعضی کلاینت‌ها هم هنگام آپدیت اشتراک،
 * پارامترهای query را حذف/دستکاری می‌کنند. اگر فقط core های دقیق پذیرفته
 * شوند، این لینک‌ها به صفحه‌ی fallback (404) می‌روند و کلاینت «خطای آپدیت —
 * بدون هیچ کانفیگی» می‌دهد.
 *
 * نرمال‌سازی مقدار app:
 *   1. core دقیق (xray, sing-box, clash, xray-knocker, wireguard, amnezia)
 *   2. نام کلاینت قدیمی → نگاشت به core
 *   3. تشخیص از User-Agent
 *   4. پیش‌فرض xray (رایج‌ترین core — همان رفتار BPB)
 */

/** core های معتبر مسیر اشتراک */
const VALID_CORES = ['xray', 'sing-box', 'clash', 'xray-knocker', 'wireguard', 'amnezia'];

/** نام‌های قدیمی کلاینت‌ها → core معادل (همه با حروف کوچک) */
const LEGACY_APP_ALIASES: Record<string, string> = {
    'v2rayng': 'xray',
    'v2rayn': 'xray',
    'v2rayn-pro': 'xray-knocker',
    'mahsang': 'xray',
    'streisand': 'xray',
    'shadowrocket': 'xray',
    'passwall': 'xray',
    'hiddify': 'sing-box',
    'hiddify-next': 'sing-box',
    'nekobox': 'sing-box',
    'nekoboxforandroid': 'sing-box',
    'karing': 'sing-box',
    'husi': 'sing-box',
    'sfa': 'sing-box',
    'clash meta': 'clash',
    'clashmetaforandroid': 'clash',
    'clash verge': 'clash',
    'clash-verge': 'clash',
    'flclash': 'clash',
    'stash': 'clash',
    'cfa': 'clash',
    'mihomo': 'clash',
    'amnezia': 'amnezia',
    'amnezia-wg': 'amnezia',
    'wg tunnel': 'amnezia',
    'wgtunnel': 'amnezia',
    'wireguard': 'wireguard'
};

/**
 * تشخیص core از User-Agent
 * ترتیب چک‌ها مهم است — v2rayN زیررشته‌ی v2rayNG است و باید اول NG چک شود
 */
export function detectClientFromUA(userAgent: string): string {
    const ua = userAgent.toLowerCase();

    if (ua.includes('v2rayng')) return 'xray';
    if (ua.includes('v2rayn-pro') || ua.includes('v2rayn')) return 'xray';
    if (
        ua.includes('mahsang') ||
        ua.includes('streisand') ||
        ua.includes('shadowrocket') ||
        ua.includes('passwall')
    ) {
        return 'xray';
    }
    if (
        ua.includes('sing-box') ||
        ua.includes('singbox') ||
        ua.includes('hiddify') ||
        ua.includes('nekobox') ||
        ua.includes('karing') ||
        ua.includes('husi')
    ) {
        return 'sing-box';
    }
    if (ua.includes('clash') || ua.includes('mihomo') || ua.includes('stash') || ua.includes('flclash')) {
        return 'clash';
    }
    if (ua.includes('amnezia')) return 'amnezia';
    if (ua.includes('wgtunnel') || ua.includes('wg tunnel')) return 'amnezia';
    if (ua.includes('wireguard')) return 'wireguard';

    // پیش‌فرض — رایج‌ترین core (رفتار پنل‌های BPB-مانند)
    return 'xray';
}

/**
 * نرمال‌سازی پارامتر app اشتراک → core معتبر
 * @param appParam  مقدار خام پارامتر app (خالی/نام کلاینت قدیمی/ناشناس)
 * @param userAgent هدر User-Agent درخواست — برای وقتی app حذف یا ناشناس است
 */
export function resolveClientApp(appParam: string, userAgent: string | null | undefined): string {
    const app = appParam.trim().toLowerCase();

    if (VALID_CORES.includes(app)) return app;

    if (app && LEGACY_APP_ALIASES[app]) return LEGACY_APP_ALIASES[app];

    // app حذف یا ناشناس — تشخیص از User-Agent
    return detectClientFromUA(userAgent ?? '');
}
