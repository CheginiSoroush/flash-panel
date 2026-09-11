import { PanelSettings, TelegramBot } from '#types/settings';
import { deployPages, deletePagesProject } from '@api/pages';
import { getUsage } from '@api/usage';
import { fetchWarpAccounts } from '@api/warp';
import { deployWorkers, deleteWorker } from '@api/workers';
import { resetPassword, logout, authenticate } from '@auth';
import { decompressGzipBase64, respond, HttpStatus, safeError } from '@common';
import { getDataset, updateDataset } from '@kv';
import { buildScript, updateMainSettings } from '@main';
import { getGlobals, getMainSettings, getDefaultKvSettings, subscriptions, clients } from '@settings';
import { validateSettings } from '@validators';
import { fallback } from './utils';
import { setTelegramBot } from '@api/telegram';

// ---------- کش سطح isolate برای HTML پنل ----------
// PANEL_HTML_CONTENT و ICON_CONTENT ثابت‌ان — دیکمپرس + جایگزینی آیکون
// فقط یک‌بار در عمر isolate انجام می‌شه (قبلاً در هر لود پنل)

let cachedPanelHtml: string | null = null;
let cachedPanelEtag = '';

async function getPanelHtml(): Promise<{ html: string; etag: string }> {
    if (cachedPanelHtml !== null) {
        return { html: cachedPanelHtml, etag: cachedPanelEtag };
    }

    const str = await decompressGzipBase64(PANEL_HTML_CONTENT);
    cachedPanelHtml = str.replaceAll('__ICON__', ICON_CONTENT);

    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(cachedPanelHtml));
    let hex = '';
    for (const b of new Uint8Array(digest).slice(0, 8)) {
        hex += b.toString(16).padStart(2, '0');
    }
    cachedPanelEtag = `"${hex}"`;

    return { html: cachedPanelHtml, etag: cachedPanelEtag };
}

export async function handlePanel(request: Request, env: Env): Promise<Response> {
    const { pathname } = getGlobals();
    const parts = pathname.split('/');
    const path = parts.slice(2).join('/');

    switch (path) {
        case 'panel':
            return renderPanel(request, env);

        case 'panel/settings':
            return getPanelSettings(request, env);

        case 'panel/update-settings':
            return updatePanelSettings(request, env);

        case 'panel/reset-settings':
            return resetPanelSettings(request, env);

        case 'panel/reset-password':
            return resetPassword(request, env);

        case 'panel/my-ip':
            return getMyIP(request, env);

        case 'panel/update-warp':
            return updateWarpConfigs(request, env);

        case 'panel/update-panel':
            return updatePanel(request, env);

        case 'panel/delete-panel':
            return deletePanel(request, env);

        case 'panel/usage':
            return getUsage(request, env);

        case 'panel/logout':
            return logout();

        default:
            return fallback(request);
    }
}

async function renderPanel(request: Request, env: Env): Promise<Response> {
    const pwd = await env.kv.get('pwd');
    if (pwd) {
        const auth = await authenticate(request, env);
        if (!auth) {
            const url = new URL('./login', request.url);
            return Response.redirect(url, 302);
        }
    }

    const { html, etag } = await getPanelHtml();

    // revalidate — بار بعدی فقط 304 برمی‌گرده
    if (request.headers.get('If-None-Match') === etag) {
        return new Response(null, {
            status: 304,
            headers: {
                'ETag': etag,
                'Cache-Control': 'no-cache'
            }
        });
    }

    return new Response(html, {
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'ETag': etag,
            'Cache-Control': 'no-cache'
        }
    });
}

async function updatePanel(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') {
        return respond(false, HttpStatus.METHOD_NOT_ALLOWED, 'Method not allowed.');
    }

    try {
        const auth = await authenticate(request, env);
        if (!auth) {
            return respond(false, HttpStatus.UNAUTHORIZED, 'Unauthorized or expired session.');
        }

        const { deployType } = getGlobals();
        const script = await buildScript(true);
        if (deployType === 'pages') {
            await deployPages(script);
        } else {
            await deployWorkers(script);
        }

        return respond(true, HttpStatus.OK);
    } catch (error) {
        return respond(
            false,
            HttpStatus.INTERNAL_SERVER_ERROR,
            `Error occurred while upgrading panel: ${safeError(error)}`
        );
    }
}

async function deletePanel(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') {
        return respond(false, HttpStatus.METHOD_NOT_ALLOWED, 'Method not allowed.');
    }

    try {
        const auth = await authenticate(request, env);
        if (!auth) {
            return respond(false, HttpStatus.UNAUTHORIZED, 'Unauthorized or expired session.');
        }

        const { deployType } = getGlobals();
        if (deployType === 'pages') {
            await deletePagesProject();
        } else {
            await deleteWorker();
        }

        return respond(true, HttpStatus.OK);
    } catch (error) {
        return respond(
            false,
            HttpStatus.INTERNAL_SERVER_ERROR,
            `Error occurred while deleting panel: ${safeError(error)}`
        );
    }
}

async function getPanelSettings(request: Request, env: Env): Promise<Response> {
    const isPassSet = Boolean(await env.kv.get('pwd'));

    try {
        const auth = await authenticate(request, env);
        if (!auth) {
            return respond(false, HttpStatus.UNAUTHORIZED, 'Unauthorized or expired session.', { isPassSet });
        }

        const { settings: kvSettings, telegramBot } = await getDataset(env);
        const mainSettings = getMainSettings();
        const data = {
            proxySettings: { ...kvSettings, ...mainSettings },
            telegramSettings: telegramBot,
            subscriptions,
            clients,
            isPassSet
        };

        return respond(true, HttpStatus.OK, undefined, data, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
            'Pragma': 'no-cache',
            'Expires': '0'
        });
    } catch (error) {
        console.log(error);
        return respond(
            false,
            HttpStatus.INTERNAL_SERVER_ERROR,
            `Error occurred while fetching settings: ${safeError(error)}`
        );
    }
}

async function updatePanelSettings(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'PUT') {
        return respond(false, HttpStatus.METHOD_NOT_ALLOWED, 'Method not allowed.');
    }

    try {
        const auth = await authenticate(request, env);
        if (!auth) {
            return respond(false, HttpStatus.UNAUTHORIZED, 'Unauthorized or expired session.');
        }

        const newSettings: PanelSettings = await request.json();
        const errors = validateSettings(newSettings);
        if (errors) return respond(false, HttpStatus.BAD_REQUEST, 'Validation Error', errors);

        await Promise.all([
            updateDataset(env, newSettings),
            updateMainSettings(newSettings)
        ]);

        const { securePath } = getGlobals();
        if (newSettings.securePath !== securePath) {
            const bot: TelegramBot | null = await env.kv.get('telegramBot', { type: 'json' });
            if (bot) {
                await setTelegramBot(newSettings.securePath, bot.telegramBotToken);
            }
        }

        return respond(true, HttpStatus.OK, '');
    } catch (error) {
        console.log(error);
        return respond(false, HttpStatus.INTERNAL_SERVER_ERROR, safeError(error));
    }
}

async function resetPanelSettings(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') {
        return respond(false, HttpStatus.METHOD_NOT_ALLOWED, 'Method not allowed!');
    }

    try {
        const auth = await authenticate(request, env);
        if (!auth) {
            return respond(false, HttpStatus.UNAUTHORIZED, 'Unauthorized or expired session.');
        }

        // باگ قبلی: updateDataset(env) متغیر ماژول رو ذخیره می‌کرد که ممکن بود
        // stale باشه (اگه request سابسکریپشن قبلاً توی همین isolate اجرا شده بود،
        // reset هیچی رو ریست نمی‌کرد). حالا همیشه پیش‌فرض‌های تازه ذخیره می‌شن
                const [kvSettings, mainSettings] = await Promise.all([
            updateDataset(env, getDefaultKvSettings() as unknown as PanelSettings),
            updateMainSettings(null)
        ]);

        return respond(true, HttpStatus.OK, '', { ...kvSettings, ...mainSettings });
    } catch (error) {
        console.log(error);
        return respond(
            false,
            HttpStatus.INTERNAL_SERVER_ERROR,
            `Error occurred while resetting settings: ${safeError(error)}`
        );
    }
}

async function getMyIP(request: Request, env: Env): Promise<Response> {
    // auth — بقیه endpoint ها این چک رو دارن، این یکی نداشت!
    const pwd = await env.kv.get('pwd');
    if (pwd) {
        const auth = await authenticate(request, env);
        if (!auth) {
            return respond(false, HttpStatus.UNAUTHORIZED, 'Unauthorized or expired session.');
        }
    }

    const ip = (await request.text()).trim();

    // ورودی کاربر مستقیم می‌ره توی URL درخواست خارجی — اعتبارسنجی اجباریه
    // (فقط کاراکترهای معتبر IPv4/IPv6)
    if (!/^[0-9a-fA-F.:]+$/.test(ip)) {
        return respond(false, HttpStatus.BAD_REQUEST, 'Invalid IP address.');
    }

    try {
        const response = await fetch(`http://ip-api.com/json/${ip}?nocache=${Date.now()}`);
        const geoLocation = await response.json();
        return respond(true, HttpStatus.OK, '', geoLocation);
    } catch (error) {
        console.error('Error fetching IP address:', error);
        return respond(
            false,
            HttpStatus.INTERNAL_SERVER_ERROR,
            `Error fetching IP address: ${safeError(error)}`
        );
    }
}

async function updateWarpConfigs(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') return respond(false, HttpStatus.METHOD_NOT_ALLOWED, 'Method not allowed.');

    try {
        const auth = await authenticate(request, env);
        if (!auth) {
            return respond(false, HttpStatus.UNAUTHORIZED, 'Unauthorized or expired session.');
        }

        await fetchWarpAccounts(env);
        return respond(true, HttpStatus.OK, 'Warp configs updated successfully!');
    } catch (error) {
        console.log(error);
        return respond(
            false,
            HttpStatus.INTERNAL_SERVER_ERROR,
            `An error occurred while updating Warp configs: ${safeError(error)}`
        );
    }
}