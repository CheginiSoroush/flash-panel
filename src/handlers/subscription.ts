import { getClNormalConfig, getClWarpConfig } from '@cores/clash/configs';
import { getURLConfigs } from '@cores/common';
import { getSbCustomConfig, getSbWarpConfig } from '@cores/sing-box/configs';
import { getXrCustomConfigs, getXrWarpConfigs } from '@cores/xray/configs';
import { setSettings, getGlobals, getSharedSettings, getSettings, getWarpAccounts } from '@settings';
import { isValidSubUserId, resolveAndRecordSubUser } from '@settings/sub-users';
import { buildSubUserInfoHeader } from '@api/clean-ip';
import { fallback } from './utils';
import { getWireguardConfigs } from '@cores/wireguard';
import { base64EncodeUtf8, HttpStatus, respond } from '@common';
import { SharedSettings } from '#types/settings';
import { subBodyCache } from './optimize';

// انکودر سطح ماژول — ساختنش در هر درخواست هدرِ SHA-256 هدر کوچکی هم دارد
const etagEncoder = new TextEncoder();

// نام‌های مسیر پنل‌های قدیمی (legacy) → نوع فعلی — سازگاری با لینک‌های قبلی
const SUB_PATH_ALIASES: Record<string, string> = {
    frag: 'fragment',
    warpro: 'warp-pro',
    pro: 'warp-pro'
};

export async function handleSubscriptions(request: Request, env: Env): Promise<Response> {
    await setSettings(env);
    const { pathname, client } = getGlobals();
    const segments = pathname.split('/');
    // <securePath>/sub/<seg3>/<seg4?> — seg3 می‌تونه نوع ساب یا UUID کاربر باشه
    const seg3 = segments[3] ?? '';
    const seg4 = segments[4] ?? '';

    // اشتراک چندکاربره: <securePath>/sub/<userId>/<type>
    // UUID نامعتبر شکل‌اً (نه نوع ساب و نه UUID) → fallback مثل قبل
    let userId: string | null = null;
    let subUserExpiresAt: number | null = null;

    if (isValidSubUserId(seg3)) {
        // resolve + ثبت آمار واکشی (best-effort، آستانه‌ی ۵ دقیقه‌ای) در یک خواندن KV
        const user = await resolveAndRecordSubUser(env, seg3);
        if (!user) {
            // کاربر حذف/غیرفعال شده — پاس صریح 401 (نه صفحه‌ی fallback)
            return respond(false, HttpStatus.UNAUTHORIZED, 'This subscription link has been revoked or is inactive.');
        }
        userId = user.id;
        subUserExpiresAt = typeof user.expiresAt === 'number' && user.expiresAt > 0
            ? user.expiresAt
            : null;
    }

    // نوع ساب: حالت چندکاربره از seg4، حالت قدیمی ادمین از seg3 + نام‌های قدیمی مسیر
    const path = SUB_PATH_ALIASES[userId ? seg4 : seg3] ?? (userId ? seg4 : seg3);

    // ETag بر اساس «ورودی‌های» تولید کانفیگ (نه خروجی‌شون):
    // نسخه پنل + کل تنظیمات KV + تنظیمات embedded + نوع ساب + کلاینت + شناسه کاربر
    // + اکانت‌های WARP فقط برای مسیرهای warp-خانواده (کلید KV جداگانه — تنها
    // مولدهای warp/wow/wireguard آن‌ها را embed می‌کنند؛ رگرسیون v0.8.30 و دامنه‌ی
    // اثرش v0.8.31: بدون این ورودی 304 ابدی، با اضافه‌شدن بی‌شرط churn بی‌دلیل).
    // getSettings() همه‌چیز رو داره: kvSettings + globalSettings (شامل client, hostname, origin)
    const etag = await computeSubETag(path, client, userId);

    // کلاینت قبلاً همین نسخه رو گرفته؟ کل تولید کانفیگ رد می‌شه → 304
    if (request.method === 'GET' && request.headers.get('If-None-Match') === etag) {
        return new Response(null, { status: 304, headers: { ETag: etag } });
    }

    // ---------- مسیر سریع: کش بدنه‌ی اشتراک (سطح isolate) ----------
    // کلید = ETag — تمام ورودی‌های تولید کانفیگ (نسخه/تنظیمات/کلاینت/کاربر) را
    // پوشش می‌دهد؛ تغییر هر ورودی → کلید جدید → تولید تازه. درخواست تکراری در
    // بازه‌ی TTL صفر CPU برای تولید کانفیگ خرج می‌کند (بدون DNS و JSON و btoa).
    let entry = request.method === 'GET' ? subBodyCache.get(etag) : null;

    if (!entry) {
        const response = await routeSubscription(path, client);
        if (!response) return fallback(request);

        const body = await response.text();
        const headers: [string, string][] = [];
        response.headers.forEach((value, key) => {
            if (key.toLowerCase() !== 'content-length') headers.push([key, value]);
        });

        entry = { body, contentType: response.headers.get('Content-Type') ?? 'text/plain; charset=utf-8', headers, storedAt: Date.now() };
        subBodyCache.put(etag, body, entry.contentType, headers);
    }

    const responseHeaders = new Headers(entry.headers);
    responseHeaders.set('ETag', etag);
    if (userId) responseHeaders.set('X-Sub-User', userId);

    // هدرهای کیفیت اشتراک — کلاینت‌های حرفه‌ای (Hiddify/v2rayNG/Streisand)
    // از آن‌ها برای به‌روزرسانی دوره‌ای و نمایش انقضا استفاده می‌کنند
    if (path !== 'share-settings') {
        // تولیدکننده‌ی ساب ممکن است interval اختصاصی گذاشته باشد (مثلاً raw: 3h) — به آن احترام
        // 3h برای همه: تغییرات سرعت/پیکربندی (مثل Auto-Tune ProxyIP) سریع‌تر به کلاینت می‌رسد؛
        // ETag/304 هم هزینه‌ی واکشی تکراری را تقریباً صفر می‌کند
        if (!responseHeaders.has('profile-update-interval')) responseHeaders.set('profile-update-interval', '3');
        responseHeaders.set('profile-web-page-url', new URL(request.url).origin);

        const userinfo = buildSubUserInfoHeader({ expireMs: subUserExpiresAt });
        if (userinfo) responseHeaders.set('subscription-userinfo', userinfo);
    }

    // هشدار: هدر Vary اینجا عمداً حذف شده و فشرده‌سازی هم انجام نمی‌شود —
    // لبه‌ی Cloudflare هدر Accept-Encoding کلاینت را با «gzip, br» بازنویسی
    // می‌کند؛ اگر ورکر خودش gzip بفرستد، لبه برای کلاینت‌های بدون A-E به‌جای
    // decompress فقط هدر Content-Encoding را حذف می‌کند و بدنه‌ی gzip بی‌اعلام
    // می‌رسد → کلاینت «خطای آپدیت — بدون کانفیگ» می‌بیند. فشرده‌سازی را لبه
    // برای کلاینت‌های پذیرنده خودش با هدر درست انجام می‌دهد (تأیید عملی — Task 21).

    return new Response(entry.body, {
        status: HttpStatus.OK,
        headers: responseHeaders
    });
}

async function routeSubscription(path: string, client: string): Promise<Response | null> {
    switch (path) {
        case 'normal':
            switch (client) {
                case 'xray':
                    return getXrCustomConfigs(false);

                case 'sing-box':
                    return getSbCustomConfig(false);

                case 'clash':
                    return getClNormalConfig();
            }
            // ← باگ fallthrough: بدون این break ها، default داخلی به case بعدی
            // سقوط می‌کرد و در نهایت shareSettings (فایل تنظیمات) برگردانده می‌شد!
            break;

        case 'raw':
            switch (client) {
                case 'xray':
                case 'sing-box':
                    return getURLConfigs();
            }
            break;

        case 'fragment':
            switch (client) {
                case 'xray':
                    return getXrCustomConfigs(true);

                case 'sing-box':
                    return getSbCustomConfig(true);
            }
            break;

        case 'warp':
            switch (client) {
                case 'xray':
                    return getXrWarpConfigs(false, false);

                case 'sing-box':
                    return getSbWarpConfig();

                case 'clash':
                    return getClWarpConfig(false);

                case 'wireguard':
                    return getWireguardConfigs(false);
            }
            break;

        case 'warp-pro':
            switch (client) {
                case 'xray':
                    return getXrWarpConfigs(true, false);

                case 'xray-knocker':
                    return getXrWarpConfigs(true, true);

                case 'clash':
                    return getClWarpConfig(true);

                case 'amnezia':
                    return getWireguardConfigs(true);
            }
            break;

        case 'share-settings':
            return shareSettings();
    }

    return null;
}

/**
 * هش SHA-256 از ورودی‌های تولید کانفیگ — ۸ بایت اول به‌صورت hex
 *
 * ورودی‌ها باید «هر چیزی که بدنه را می‌سازد» را پوشش دهند: settings + اکانت‌های
 * WARP برای مسیرهای warp-خانواده (تنها مولدهای getClWarpConfig/getXrWarpConfigs/
 * getSbWarpConfig/getWireguardConfigs اکانت‌ها را می‌خوانند و wireguard فقط زیر
 * همین دو مسیر سرو می‌شود). چرخش اکانت‌ها → ETag مسیرهای warp نو → کلاینت شرطی
 * بدنه‌ی نو می‌گیرد؛ مسیرهای normal/raw/fragment که اکانت‌ها در آن‌ها نقشی ندارند
 * ETag ثابت می‌مانند → بدون دانلود مجدد بی‌دلیل و بدون تخلیه‌ی LRU کش بدنه.
 */
const WARP_FAMILY_PATHS = new Set(['warp', 'warp-pro']);

export async function computeSubETag(path: string, client: string, userId: string | null = null): Promise<string> {
    const payload = JSON.stringify({
        v: VERSION,
        path,
        client,
        u: userId,
        s: getSettings(),
        w: WARP_FAMILY_PATHS.has(path) ? getWarpAccounts() : null
    });
    const digest = await crypto.subtle.digest('SHA-256', etagEncoder.encode(payload));
    const bytes = new Uint8Array(digest).slice(0, 8);

    let hex = '';
    for (const b of bytes) {
        hex += b.toString(16).padStart(2, '0');
    }
    return `"${hex}"`;
}

async function shareSettings() {
    const sharedSettings: SharedSettings = getSharedSettings();
    // btoa خام روی هر کاراکتر خارج از Latin1 (ریمارک فارسی/ایموجی در customConfigs و
    // customSubs — کاملاً رایج) InvalidCharacterError می‌دهد و کل endpoint را ۵۰۰ می‌کند.
    // base64EncodeUtf8 همان JSON را به‌صورت UTF-8 کد می‌کند؛ برای بدنه‌های ASCII خروجی
    // بایت‌به‌بایت با btoa یکسان است (سازگاری کامل با فایل‌های .dat قبلی).
    const body = base64EncodeUtf8(JSON.stringify(sharedSettings));

    return new Response(body, {
        status: HttpStatus.OK,
        headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Content-Disposition': `attachment; filename=${_project_SM_}-settings.dat`,
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET',
            'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
            'Pragma': 'no-cache',
            'Expires': '0'
        }
    });
}