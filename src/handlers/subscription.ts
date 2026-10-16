import { getClNormalConfig, getClWarpConfig } from '@cores/clash/configs';
import { getURLConfigs } from '@cores/common';
import { getSbCustomConfig, getSbWarpConfig } from '@cores/sing-box/configs';
import { getXrCustomConfigs, getXrWarpConfigs } from '@cores/xray/configs';
import { setSettings, getGlobals, getSharedSettings, getSettings } from '@settings';
import { isValidSubUserId, resolveAndRecordSubUser } from '@settings/sub-users';
import { buildSubUserInfoHeader } from '@api/clean-ip';
import { fallback } from './utils';
import { getWireguardConfigs } from '@cores/wireguard';
import { HttpStatus, respond } from '@common';
import { SharedSettings } from '#types/settings';

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

    // نوع ساب: حالت چندکاربره از seg4، حالت قدیمی ادمین از seg3
    const path = userId ? seg4 : seg3;

    // ETag بر اساس «ورودی‌های» تولید کانفیگ (نه خروجی‌شون):
    // نسخه پنل + کل تنظیمات KV + تنظیمات embedded + نوع ساب + کلاینت + شناسه کاربر.
    // getSettings() همه‌چیز رو داره: kvSettings + globalSettings (شامل client, hostname, origin)
    const etag = await computeSubETag(path, client, userId);

    // کلاینت قبلاً همین نسخه رو گرفته؟ کل تولید کانفیگ رد می‌شه → 304
    if (request.method === 'GET' && request.headers.get('If-None-Match') === etag) {
        return new Response(null, { status: 304, headers: { ETag: etag } });
    }

    const response = await routeSubscription(path, client);
    if (response) {
        response.headers.set('ETag', etag);
        if (userId) response.headers.set('X-Sub-User', userId);

        // هدرهای کیفیت اشتراک — کلاینت‌های حرفه‌ای (Hiddify/v2rayNG/Streisand)
        // از آن‌ها برای به‌روزرسانی دوره‌ای و نمایش انقضا استفاده می‌کنند
        if (path !== 'share-settings') {
            response.headers.set('profile-update-interval', '12');
            response.headers.set('profile-web-page-url', new URL(request.url).origin);

            const userinfo = buildSubUserInfoHeader({ expireMs: subUserExpiresAt });
            if (userinfo) response.headers.set('subscription-userinfo', userinfo);
        }

        return response;
    }

    return fallback(request);
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
 */
async function computeSubETag(path: string, client: string, userId: string | null = null): Promise<string> {
    const payload = JSON.stringify({ v: VERSION, path, client, u: userId, s: getSettings() });
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
    const bytes = new Uint8Array(digest).slice(0, 8);

    let hex = '';
    for (const b of bytes) {
        hex += b.toString(16).padStart(2, '0');
    }
    return `"${hex}"`;
}

async function shareSettings() {
    const sharedSettings: SharedSettings = getSharedSettings();
    const body = btoa(JSON.stringify(sharedSettings));

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