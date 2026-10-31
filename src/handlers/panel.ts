import { PanelSettings, TelegramBot } from '#types/settings';
import { deployPages, deletePagesProject } from '@api/pages';
import { getUsage, getUsageHistoryEndpoint } from '@api/usage';
import { fetchWarpAccounts } from '@api/warp';
import { deployWorkers, deleteWorker } from '@api/workers';
import { getUpdateCheckEndpoint } from '@api/update-check';
import { getEdgeTelemetryEndpoint } from '@settings/edge-telemetry';
import { loadApiToken } from '@settings';
import { resetPassword, logout, authenticate, invalidateTotpCache } from '@auth';
import { buildOtpAuthUri, generateTotpSecret, verifyTotp } from '@auth/totp';
import { decompressGzipBase64, respond, HttpStatus, safeError } from '@common';
import { getDataset, updateDataset, invalidateDatasetCache } from '@kv';
import { buildScript, updateMainSettings } from '@main';
import { getGlobals, getMainSettings, getDefaultKvSettings, subscriptions, clients } from '@settings';
import { CF_TOKEN_MISSING_ERROR } from '@api/cf-auth';
import { createSubUser, deleteSubUser, getSubUsers, importSubUsers, isValidSubUserId, updateSubUser } from '@settings/sub-users';
import {
    buildSettingsBackup,
    parseSettingsBackup,
    prepareImport
} from '@api/settings-backup';
import { validateSettings } from '@validators';
import { setTelegramBot } from '@api/telegram';
import { buildQrPng } from './qrcode';
import { fallback } from './utils';

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

// فقط این سه زیرمسیر apiToken را واقعاً مصرف می‌کنند (usage → GraphQL کوئری
// اکانت؛ update-panel/delete-panel → deploy/delete از api/workers و api/pages).
// usage/history فقط سری KV می‌خواند؛ update-warp از API مصرف‌کننده‌ی WARP
// (api.cloudflareclient.com) می‌گیرد — نه apiToken پنل.
const CF_API_PANEL_PATHS: ReadonlySet<string> = new Set([
    'panel/usage',
    'panel/update-panel',
    'panel/delete-panel',
]);

export async function handlePanel(request: Request, env: Env): Promise<Response> {
    const { pathname } = getGlobals();
    const parts = pathname.split('/');
    const path = parts.slice(2).join('/');

    // v0.8.39 — توکن CF فقط برای زیرمسیرهای واقعاً مصرف‌کننده‌ی CF-API لود می‌شود
    // (usage → GraphQL، update-panel/delete-panel → deploy/delete API). بقیه‌ی
    // زیرمسیرها (logout، totp-status که صفحه‌ی login در هر بازدید صدا می‌زند،
    // sub-users، my-ip، edge، settings/import/export) دیگر خواندن KV توکن را
    // نمی‌پردازند — قبلاً سقف «۱ خواندن اضافه در ۵ث» روی همه بود. usage/history
    // فقط KV می‌خواند (بدون GraphQL) و update-warp از API مصرف‌کننده‌ی WARP
    // می‌گیرد نه apiToken پنل — هیچ‌کدام توکن نمی‌خواهند. کرون (sampleUsageNow)
    // توکن را خودش لود می‌کند (v0.8.12) و رندر HTML از قبل مستثنا بود (v0.8.16).
    if (CF_API_PANEL_PATHS.has(path)) {
        await loadApiToken(env);
    }

    switch (path) {
        case 'panel':
            return renderPanel(request, env);

        case 'panel/settings':
            return getPanelSettings(request, env);

        case 'panel/update-settings':
            return updatePanelSettings(request, env);

        case 'panel/reset-settings':
            return resetPanelSettings(request, env);

        case 'panel/settings/export':
            return exportSettingsBackup(request, env);

        case 'panel/settings/import':
            return importSettingsBackup(request, env);

        case 'panel/reset-password':
            return resetPassword(request, env);

        case 'panel/my-ip':
            return getMyIP(request, env);

        case 'panel/update-warp':
            return updateWarpConfigs(request, env);

        case 'panel/update-check':
            return getUpdateCheckEndpoint(request, env);

        case 'panel/update-panel':
            return updatePanel(request, env);

        case 'panel/delete-panel':
            return deletePanel(request, env);

        case 'panel/usage':
            return getUsage(request, env);

        case 'panel/usage/history':
            return getUsageHistoryEndpoint(request, env);

        case 'panel/edge':
            return getEdgeTelemetryEndpoint(request, env);

        case 'panel/logout':
            return logout();

        case 'panel/totp/status':
            return getTotpStatus(request, env);

        case 'panel/totp/setup':
            return setupTotp(request, env);

        case 'panel/totp/enable':
            return enableTotp(request, env);

        case 'panel/totp/disable':
            return disableTotp(request, env);

        case 'panel/sub-users':
            return handleSubUsers(request, env);

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

        // v0.8.12 — دکمه‌ی Update بدون توکن به‌جای 401 مبهم CF، پیام صادق می‌دهد
        // (خود deployWorkers هم گارد دارد؛ این گارد پیام را تمیزتر به UI می‌رساند)
        const { apiToken } = getGlobals();
        if (!apiToken) {
            return respond(false, HttpStatus.SERVICE_UNAVAILABLE, CF_TOKEN_MISSING_ERROR);
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
                // v0.8.45 — ثبت وب‌هوک best-effort (همان قرارداد بازیابی بکاپ):
                // تنظیمات همین‌جا ذخیره شده‌اند؛ خطای سمت تلگرام (API پایین/429/توکن
                // باطل) نباید یک ذخیره‌ی موفق را 500 کاذب کند — وب‌هوک بعداً از
                // Settings تلگرام دوباره ست می‌شود.
                try {
                    await setTelegramBot(newSettings.securePath, bot.telegramBotToken);
                } catch (e) {
                    console.log('Telegram webhook re-registration skipped:', safeError(e));
                }
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

// ---------- پشتیبان‌گیری و بازیابی تنظیمات ----------

async function exportSettingsBackup(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'GET') {
        return respond(false, HttpStatus.METHOD_NOT_ALLOWED, 'Method not allowed.');
    }

    const auth = await authenticate(request, env);
    if (!auth) {
        return respond(false, HttpStatus.UNAUTHORIZED, 'Unauthorized or expired session.');
    }

    try {
        const [{ settings, telegramBot }, users] = await Promise.all([
            getDataset(env),
            getSubUsers(env)
        ]);

        const backup = buildSettingsBackup({
            settings,
            main: getMainSettings(),
            subUsers: users,
            telegramBot,
            version: VERSION
        });

        const date = backup._meta.exportedAt.slice(0, 10);

        return new Response(JSON.stringify(backup, null, 2), {
            headers: {
                'Content-Type': 'application/json',
                'Content-Disposition': `attachment; filename="flash-panel-backup-${date}.json"`,
                'Cache-Control': 'no-store'
            }
        });
    } catch (error) {
        console.log(error);
        return respond(
            false,
            HttpStatus.INTERNAL_SERVER_ERROR,
            `Error occurred while exporting settings: ${safeError(error)}`
        );
    }
}

async function importSettingsBackup(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') {
        return respond(false, HttpStatus.METHOD_NOT_ALLOWED, 'Method not allowed.');
    }

    const auth = await authenticate(request, env);
    if (!auth) {
        return respond(false, HttpStatus.UNAUTHORIZED, 'Unauthorized or expired session.');
    }

    try {
        const parsed = parseSettingsBackup(await parseJsonBody(request));
        if (!parsed) {
            return respond(false, HttpStatus.BAD_REQUEST, 'Invalid backup file — expected a Flash Panel settings export.');
        }

        const { settings: currentSettings, telegramBot: currentBot } = await getDataset(env);
        const prepared = prepareImport(parsed, currentSettings, getDefaultKvSettings());

        // دروازه‌ی نهایی — همان اعتبارسنجی ذخیره‌ی عادی پنل
        const errors = validateSettings(prepared.settings);
        if (errors) return respond(false, HttpStatus.BAD_REQUEST, 'Validation Error', errors);

        await Promise.all([
            updateDataset(env, prepared.settings),
            updateMainSettings(prepared.settings)
        ]);

        if (prepared.users) {
            // v0.8.35 — جایگزینی کامل از صف نوشتن subUsers، نه put مستقیم
            await importSubUsers(env, prepared.users.users);
        }

        if (prepared.bot) {
            await env.kv.put('telegramBot', JSON.stringify(prepared.bot));
            // v0.8.45 — قرارداد kv.ts: هر write مستقیم KV کش دیتاست را باطل کند
            // (telegramBot جزو Dataset است — همان تعهدی که updateWarpConfigs و
            // api/telegram خودشان رعایت می‌کنند). بدون این، یک getDataset هم‌ایزوله
            // که در پنجره‌ی میان commit تنظیمات و این put پر شده باشد، تا ۵ ثانیه
            // رباتِ پیش از بازیابی را سرو می‌کند.
            invalidateDatasetCache();
            if (prepared.bot.telegramBotToken) {
                // وب‌هوک دوباره ست می‌شود — best-effort، خطای تلگرام بازیابی را خراب نمی‌کند
                try {
                    await setTelegramBot(prepared.settings.securePath, prepared.bot.telegramBotToken);
                } catch (e) {
                    console.log('Telegram webhook restore skipped:', e);
                }
            }
        }

        const previousBotActive = Boolean(currentBot?.telegramBotToken);

        return respond(true, HttpStatus.OK, 'Settings restored from backup.', {
            importedFields: prepared.importedFields,
            skippedFields: prepared.skippedFields,
            importedUsers: prepared.users?.users.length ?? 0,
            skippedUsers: prepared.users?.skipped ?? 0,
            usersSection: prepared.users !== null,
            botImported: Boolean(prepared.bot),
            botReplaced: previousBotActive,
            settings: prepared.settings
        }, { 'Cache-Control': 'no-store' });
    } catch (error) {
        console.log(error);
        return respond(
            false,
            HttpStatus.INTERNAL_SERVER_ERROR,
            `Error occurred while importing settings: ${safeError(error)}`
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
        // v0.8.45 — سقف زمانی جست‌وجوی جغرافیای IP (همان کلاس v0.8.44 برای DoH):
        // ip-api.com آویزان نباید درخواست پنل ادمین را بی‌نهایت نگه دارد.
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), myIpFetchTimeoutMs);
        let response: Response;
        try {
            response = await fetch(`http://ip-api.com/json/${ip}?nocache=${Date.now()}`, { signal: controller.signal });
        } finally {
            clearTimeout(timer);
        }
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
        // fetchWarpAccounts مستقیم KV می‌نویسد — قرارداد kv.ts: کش دیتاست باید باطل شود
        // وگرنه همین isolate تا ۵ ثانیه (TTL کش) اکانت‌های کهنه را سرو می‌کند.
        invalidateDatasetCache();
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

// ---------- سقف زمانی جست‌وجوی IP (v0.8.45) ----------
// getMyIP ورودی کاربر را مستقیم به ip-api.com می‌فرستد — fetch بدون سقف زمانی
// یعنی یک آپ‌استریمِ آویزان، درخواستِ ادمین را آویزان نگه می‌دارد. الگوی همان
// سقف DoH (v0.8.44): AbortController + هُک تست.
const MY_IP_FETCH_TIMEOUT_MS = 5_000;
let myIpFetchTimeoutMs = MY_IP_FETCH_TIMEOUT_MS;

/** فقط برای تست‌ها — سقف زمانی جست‌وجوی IP را کوچک کند */
export function _setMyIpFetchTimeoutForTest(ms: number): void {
    myIpFetchTimeoutMs = ms;
}

// ---------- ورود دومرحله‌ای TOTP ----------

/**
 * PNG → data URL — برای نمایش QR در مودال پنل بدون درخواست اضافه
 */
function pngToDataUrl(png: ArrayBuffer): string {
    const bytes = new Uint8Array(png);
    let binary = '';
    const CHUNK = 0x8000;

    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }

    return `data:image/png;base64,${btoa(binary)}`;
}

async function parseJsonBody(request: Request): Promise<Record<string, any> | null> {
    try {
        return await request.json();
    } catch {
        return null;
    }
}

async function getTotpStatus(request: Request, env: Env): Promise<Response> {
    const auth = await authenticate(request, env);
    if (!auth) {
        return respond(false, HttpStatus.UNAUTHORIZED, 'Unauthorized or expired session.');
    }

    const [enabled, pending] = await Promise.all([
        env.kv.get('totpEnabled'),
        env.kv.get('totpPendingSecret')
    ]);

    return respond(true, HttpStatus.OK, undefined, {
        enabled: enabled === 'true',
        pending: Boolean(pending)
    }, {
        'Cache-Control': 'no-store'
    });
}

async function setupTotp(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') {
        return respond(false, HttpStatus.METHOD_NOT_ALLOWED, 'Method not allowed.');
    }

    const auth = await authenticate(request, env);
    if (!auth) {
        return respond(false, HttpStatus.UNAUTHORIZED, 'Unauthorized or expired session.');
    }

    try {
        const secret = generateTotpSecret();
        const { accEmail, hostname } = getGlobals();
        const otpauthUri = buildOtpAuthUri(secret, accEmail || hostname || 'admin', 'Flash Panel');

        // secret تا زمان تأیید اولین کد، «در انتظار» می‌مونه — 2FA هنوز فعال نیست
        await env.kv.put('totpPendingSecret', secret);

        const qrDataUrl = pngToDataUrl(await buildQrPng(otpauthUri));

        return respond(true, HttpStatus.OK, undefined, {
            secret,
            otpauthUri,
            qrDataUrl
        }, { 'Cache-Control': 'no-store' });
    } catch (error) {
        console.log(error);
        return respond(
            false,
            HttpStatus.INTERNAL_SERVER_ERROR,
            `Error generating 2FA setup: ${safeError(error)}`
        );
    }
}

async function enableTotp(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') {
        return respond(false, HttpStatus.METHOD_NOT_ALLOWED, 'Method not allowed.');
    }

    const auth = await authenticate(request, env);
    if (!auth) {
        return respond(false, HttpStatus.UNAUTHORIZED, 'Unauthorized or expired session.');
    }

    const data = await parseJsonBody(request);
    const code = typeof data?.code === 'string' ? data.code : '';

    const pendingSecret = await env.kv.get('totpPendingSecret');
    if (!pendingSecret) {
        return respond(false, HttpStatus.BAD_REQUEST, 'No pending 2FA setup — run setup first.');
    }

    const { ok, counter } = await verifyTotp(pendingSecret, code);
    if (!ok || counter === null) {
        return respond(false, HttpStatus.BAD_REQUEST, 'Invalid verification code — check your authenticator app.');
    }

    await env.kv.put('totpSecret', pendingSecret);
    await env.kv.put('totpEnabled', 'true');
    await env.kv.put('totpLastUsed', String(counter));
    await env.kv.delete('totpPendingSecret');
    invalidateTotpCache(true);

    return respond(true, HttpStatus.OK, 'Two-factor authentication enabled!');
}

async function disableTotp(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') {
        return respond(false, HttpStatus.METHOD_NOT_ALLOWED, 'Method not allowed.');
    }

    const auth = await authenticate(request, env);
    if (!auth) {
        return respond(false, HttpStatus.UNAUTHORIZED, 'Unauthorized or expired session.');
    }

    const data = await parseJsonBody(request);
    const code = typeof data?.code === 'string' ? data.code : '';

    const activeSecret = await env.kv.get('totpSecret');
    if (!activeSecret) {
        return respond(false, HttpStatus.BAD_REQUEST, '2FA is not enabled.');
    }

    const { ok } = await verifyTotp(activeSecret, code);
    if (!ok) {
        return respond(false, HttpStatus.BAD_REQUEST, 'Invalid verification code.');
    }

    await Promise.all([
        env.kv.delete('totpSecret'),
        env.kv.delete('totpEnabled'),
        env.kv.delete('totpLastUsed'),
        env.kv.delete('totpPendingSecret')
    ]);
    invalidateTotpCache(false);

    return respond(true, HttpStatus.OK, 'Two-factor authentication disabled!');
}

// ---------- اشتراک چندکاربره (per-user subscription UUID) ----------

/**
 * CRUD کاربران اشتراک — همهٔ متدها نیاز به session معتبر دارند.
 *   GET            → لیست کاربران
 *   POST {name}    → ساخت کاربر + UUID جدید
 *   PUT {id, name?, active?} → تغییر نام یا فعال/غیرفعال‌سازی (لغو دسترسی)
 *   DELETE {id}    → حذف کامل
 */
async function handleSubUsers(request: Request, env: Env): Promise<Response> {
    const auth = await authenticate(request, env);
    if (!auth) {
        return respond(false, HttpStatus.UNAUTHORIZED, 'Unauthorized or expired session.');
    }

    try {
        switch (request.method) {
            case 'GET': {
                const users = await getSubUsers(env);
                // تازه‌ترین‌ها اول — برای نمایش در پنل
                return respond(true, HttpStatus.OK, undefined, { users: users.reverse() }, {
                    'Cache-Control': 'no-store'
                });
            }

            case 'POST': {
                const data = await parseJsonBody(request);
                const user = await createSubUser(env, data?.name);
                if (!user) {
                    return respond(false, HttpStatus.BAD_REQUEST,
                        `Invalid name (1-40 chars) or user limit reached.`);
                }

                return respond(true, HttpStatus.CREATED, 'Subscription user created.', { user }, {
                    'Cache-Control': 'no-store'
                });
            }

            case 'PUT': {
                const data = await parseJsonBody(request);
                const id = typeof data?.id === 'string' ? data.id : '';
                if (!isValidSubUserId(id)) {
                    return respond(false, HttpStatus.BAD_REQUEST, 'Invalid user id.');
                }

                const patch: { name?: unknown; active?: unknown; telegramChatId?: unknown; expiresAt?: unknown } = {};
                if (data?.name !== undefined) patch.name = data.name;
                if (data?.active !== undefined) patch.active = data.active;
                // لینک chat_id تلگرام برای broadcast ربات — '' یعنی حذف لینک
                if (data?.telegramChatId !== undefined) patch.telegramChatId = data.telegramChatId;
                // انقضای خودکار — عدد epoch ms آینده؛ '' یعنی حذف انقضا
                if (data?.expiresAt !== undefined) patch.expiresAt = data.expiresAt;

                const user = await updateSubUser(env, id, patch);
                if (!user) {
                    return respond(false, HttpStatus.NOT_FOUND, 'Subscription user not found.');
                }

                return respond(true, HttpStatus.OK, 'Subscription user updated.', { user }, {
                    'Cache-Control': 'no-store'
                });
            }

            case 'DELETE': {
                const data = await parseJsonBody(request);
                const id = typeof data?.id === 'string' ? data.id : '';
                if (!isValidSubUserId(id)) {
                    return respond(false, HttpStatus.BAD_REQUEST, 'Invalid user id.');
                }

                const removed = await deleteSubUser(env, id);
                if (!removed) {
                    return respond(false, HttpStatus.NOT_FOUND, 'Subscription user not found.');
                }

                return respond(true, HttpStatus.OK, 'Subscription user deleted — its links are revoked now.');
            }

            default:
                return respond(false, HttpStatus.METHOD_NOT_ALLOWED, 'Method not allowed.');
        }
    } catch (error) {
        console.log(error);
        return respond(
            false,
            HttpStatus.INTERNAL_SERVER_ERROR,
            `Error handling subscription users: ${safeError(error)}`
        );
    }
}