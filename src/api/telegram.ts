import { HttpStatus, respond, safeError } from '@common';
import { clients, getGlobals, subscriptions } from '@settings';
import { getSubUsers } from '@settings/sub-users';
import { buildEdgeText, getEdgeTelemetry } from '@settings/edge-telemetry';
import { getCfWorkerUsage } from './usage';
import {
    BroadcastRecipient,
    buildBroadcastConfirmText,
    buildTelegramGuideText,
    buildUserDetailText,
    buildUsersOverviewText,
    escapeHtml,
    paginateUsers,
    resolveBroadcastRecipients,
    sendBroadcast,
    USERS_PER_PAGE
} from './telegram-broadcast';
import { buildDigestForCommand } from './automation';
import { authenticate } from '@auth';
import { getDataset, invalidateDatasetCache } from '@kv';
import { TelegramBot } from '#types/settings';

// ---------- کش usage ----------
// getCfWorkerUsage در هر پیام/کلیک صدا زده می‌شد — یه درخواست کامل به API کلادفلر!
// دیتای usage روزانه‌ست — کش ۶۰ ثانیه‌ای کاملاً کافیه

type UsageResult = Awaited<ReturnType<typeof getCfWorkerUsage>>;

let usageCache: { data: UsageResult; expiresAt: number } | null = null;
const USAGE_CACHE_TTL = 60_000;

async function getUsageCached(): Promise<UsageResult> {
    if (usageCache && Date.now() < usageCache.expiresAt) {
        return usageCache.data;
    }
    const data = await getCfWorkerUsage();
    usageCache = { data, expiresAt: Date.now() + USAGE_CACHE_TTL };
    return data;
}

/**
 * secret وب‌هوک — مشتق‌شده از توکن بات (بدون تغییر schema ذخیره‌سازی).
 * در setWebhook به تلگرام داده می‌شه و در هر آپدیت با هدر
 * X-Telegram-Bot-Api-Secret-Token مقایسه می‌شه.
 */
async function deriveWebhookSecret(botToken: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(botToken));
    return Array.from(new Uint8Array(digest).slice(0, 24), b => b.toString(16).padStart(2, '0')).join('');
}

export async function setupTelegramWebhook(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'PUT') {
        return respond(false, HttpStatus.METHOD_NOT_ALLOWED, 'Method not allowed.');
    }

    try {
        const auth = await authenticate(request, env);
        if (!auth) {
            return respond(false, HttpStatus.UNAUTHORIZED, 'Unauthorized or expired session.');
        }

        const body = await request.json().catch(() => null) as any;
        const botToken = typeof body?.telegramBotToken === 'string' ? body.telegramBotToken.trim() : '';
        const userID = typeof body?.telegramUserId === 'string' ? body.telegramUserId.trim() : '';

        if (!botToken || !userID) {
            return respond(false, HttpStatus.BAD_REQUEST, 'Missing bot info.');
        }

        const { securePath } = getGlobals();
        await setTelegramBot(securePath, botToken);

        const bot: TelegramBot = {
            telegramBotToken: botToken,
            telegramUserId: userID
        };

        await env.kv.put('telegramBot', JSON.stringify(bot));
        invalidateDatasetCache(); // کش دیتاست بعد از write باطل بشه
        return respond(true, HttpStatus.OK, 'Telegram bot setup completed successfully!', bot);
    } catch (error) {
        return respond(false, HttpStatus.INTERNAL_SERVER_ERROR, `Error occurred while setting Telegram Bot: ${safeError(error)}`);
    }
}

export async function setTelegramBot(path: string, token: string) {
    const { origin } = getGlobals();
    const webhookUrl = new URL(`/${path}/telegram/webhook`, origin);
    const api = new URL(`https://api.telegram.org/bot${token}/setWebhook`);
    api.searchParams.set('url', webhookUrl.href);
    // 🔐 secret token — برای اعتبارسنجی منبع آپدیت‌های وب‌هوک
    api.searchParams.set('secret_token', await deriveWebhookSecret(token));

    try {
        const res = await fetch(api);
        const data: any = await res.json();
        if (!data.ok) {
            throw new Error(data.description || 'Failed to set webhook.');
        }

        const commRes = await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                commands: [
                    { command: 'start', description: '🤖 Show welcome menu' },
                    { command: 'config', description: '🔗 Get configs' },
                    { command: 'clients', description: '📱 Get supported clients' },
                    { command: 'tg', description: '✈️ Telegram setup guide' },
                    { command: 'usage', description: '📊 Monitor usage' },
                    { command: 'users', description: '👥 Subscription users & stats' },
                    { command: 'digest', description: '📋 Daily summary (usage + users)' },
                    { command: 'edge', description: '🛰️ Edge telemetry (colo/ISP/RTT)' },
                    { command: 'broadcast', description: '📢 Message all linked users' },
                    { command: 'settings', description: '⚙️ Change panel settings' },

                ]
            })
        });

        const commData: any = await commRes.json();
        if (!commData.ok) {
            throw new Error(commData.description || 'Failed to set bot commands.');
        }
    } catch (error) {
        throw new Error(safeError(error));
    }
}

export async function removeTelegramBot(request: Request, env: Env) {
    if (request.method !== 'POST') {
        return respond(false, HttpStatus.METHOD_NOT_ALLOWED, 'Method not allowed.');
    }

    try {
        const auth = await authenticate(request, env);
        if (!auth) {
            return respond(false, HttpStatus.UNAUTHORIZED, 'Unauthorized or expired session.');
        }

        const { telegramBot: tgBot } = await getDataset(env);
        const token = tgBot?.telegramBotToken || '';

        // اگر بات ست نشده بود، فقط KV پاک بشه (قبلاً کل عملیات fail می‌شد)
        if (token) {
            const res = await fetch(`https://api.telegram.org/bot${token}/deleteWebhook`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    drop_pending_updates: true
                })
            });

            const data = await res.json() as { ok: boolean; description?: string };
            if (!res.ok || !data.ok) {
                throw new Error(data.description || `Failed with status ${res.status}`);
            }
        }

        const bot: TelegramBot = { telegramBotToken: '', telegramUserId: '' };
        await env.kv.put('telegramBot', JSON.stringify(bot));
        invalidateDatasetCache(); // کش دیتاست بعد از write باطل بشه

        return respond(true, HttpStatus.OK, 'Telegram bot webhook deleted successfully!', bot);
    } catch (error) {
        return respond(false, HttpStatus.INTERNAL_SERVER_ERROR, `Error occurred while removing Telegram bot: ${safeError(error)}`);
    }
}

interface TgUser {
    id: number;
    is_bot?: boolean;
    first_name?: string;
    last_name?: string;
    username?: string;
}

interface TgMessage {
    message_id: number;
    from: TgUser;
    chat: { id: number; type: string };
    text?: string;
    caption?: string;
    reply_to_message?: TgMessage;
}

interface TgCallbackQuery {
    id: string;
    from: TgUser;
    message?: { message_id: number; chat: { id: number } };
    data?: string;
}

interface TgUpdate {
    update_id: number;
    message?: TgMessage;
    callback_query?: TgCallbackQuery;
}

function mainKeyboard() {
    return {
        inline_keyboard: [
            [{ text: '🔗 Get Config', callback_data: 'sub' }],
            [{ text: '📱 Supported Clients', callback_data: 'clients' }],
            [{ text: '📊 Usage', callback_data: 'usage' }],
            [{ text: '⚙️ Settings', callback_data: 'settings' }],
            [
                { text: '👥 Users', callback_data: 'users' },
                { text: '📢 Broadcast', callback_data: 'broadcast' }
            ],
            [
                { text: '📡 Status', callback_data: 'status' },
                { text: '🔄 Restart', callback_data: 'restart' }
            ],
        ]
    };
}

function subKeyboard() {
    const subs = Object.entries(subscriptions).map(([type, category]) => [{
        text: `🔗 ${category.label}`,
        callback_data: `sub_${type}`
    }]);

    return {
        inline_keyboard: [
            ...subs,
            [{ text: '◀️ Back', callback_data: 'main' }]
        ]
    };
}

function usageKeyboard() {
    return {
        inline_keyboard: [
            [{ text: '🔄 Refresh', callback_data: 'usage_refresh' }],
            [{ text: '◀️ Back', callback_data: 'main' }]
        ]
    };
}

function clientsKeyboard() {
    const suppClients = clients.map(client => [{
        text: `🟢 ${client.name}`,
        callback_data: `client_${client.name}`
    }]);

    return {
        inline_keyboard: [
            ...suppClients,
            [{ text: '◀️ Back', callback_data: 'main' }]
        ]
    };
}
// ============================================================
// ⚙️ Settings از تلگرام — تغییر تنظیمات بدون باز کردن پنل
// فقط فیلدهای امن — بدون UUID/securePath/pass/customDomain
// ============================================================

/** فیلدهای قابل‌ویرایش از ربات */
const EDITABLE_SETTINGS = {
    'localDNS': {
        label: '🌐 Local DNS',
        hint: 'مثل: 8.8.8.8 یا 1.1.1.1',
        validate: (v: string) => /^(\d{1,3}\.){3}\d{1,3}$/.test(v.trim()) || 'Invalid IP format',
        current: (s: any) => s.localDNS
    },
    'remoteDNS': {
        label: '🌍 Remote DNS',
        hint: 'مثل: https://8.8.8.8/dns-query',
        validate: (v: string) => v.trim().startsWith('https://') || v.trim().startsWith('http://') || /^(\d{1,3}\.){3}\d{1,3}$/.test(v.trim()) || 'Invalid DNS format',
        current: (s: any) => s.remoteDNS
    },
    'protocols': {
        label: '🛡 Protocols',
        hint: 'مثل: vless,trojan (جداشده با کاما)',
        validate: (v: string) => {
            const protos = v.toLowerCase().split(',').map(p => p.trim());
            const valid = protos.every(p => ['vless', 'trojan'].includes(p));
            return valid || 'Only vless and trojan are allowed';
        },
        current: (s: any) => s.protocols
    },
    'cleanIPs': {
        label: '🧹 Clean IPs',
        hint: 'هر خط یک IP یا دامنه',
        validate: (v: string) => {
            const lines = v.split('\n').map(l => l.trim()).filter(Boolean);
            if (!lines.length) return 'Empty list';
            if (lines.length > 50) return 'Max 50 entries';
            return true;
        },
        current: (s: any) => (s.cleanIPs || []).join('\n') || '(empty)'
    },
    'fingerprint': {
        label: '🔑 Fingerprint',
        hint: 'chrome, firefox, safari, android, ios, edge',
        validate: (v: string) => {
            const valid = ['chrome', 'firefox', 'safari', 'android', 'ios', 'edge', 'random'];
            return valid.includes(v.toLowerCase()) || `Must be one of: ${valid.join(', ')}`;
        },
        current: (s: any) => s.fingerprint
    },

    // ---------- نگهبان WS ----------
    'wsGuardianEnabled': {
        label: '🛰 WS Guardian',
        hint: 'true یا false — بستن اتصال‌های زامبی شبکه موبایل',
        validate: boolValidate, current: (s: any) => String(s.wsGuardianEnabled)
    },
    'wsGuardianIdleSec': {
        label: '🛰 WS Guardian Timeout',
        hint: 'ثانیه — بین ۳۰ تا ۳۶۰۰ (پیش‌فرض ۳۰۰)',
        validate: (v: string) => {
            const n = Number(v.trim());
            return (Number.isInteger(n) && n >= 30 && n <= 3600) || 'Must be an integer between 30 and 3600';
        },
        current: (s: any) => String(s.wsGuardianIdleSec)
    },

    // ---------- قوانین مسیریابی — toggle های true/false ----------
    'bypassIran': {
        label: '🇮🇷 Bypass Iran',
        hint: 'true یا false',
        validate: boolValidate, current: (s: any) => String(s.bypassIran)
    },
    'bypassChina': {
        label: '🇨🇳 Bypass China',
        hint: 'true یا false',
        validate: boolValidate, current: (s: any) => String(s.bypassChina)
    },
    'bypassRussia': {
        label: '🇷🇺 Bypass Russia',
        hint: 'true یا false',
        validate: boolValidate, current: (s: any) => String(s.bypassRussia)
    },
    'bypassOpenAi': {
        label: '🤖 Bypass OpenAI',
        hint: 'true یا false',
        validate: boolValidate, current: (s: any) => String(s.bypassOpenAi)
    },
    'bypassGoogleAi': {
        label: '🧠 Bypass Google AI',
        hint: 'true یا false',
        validate: boolValidate, current: (s: any) => String(s.bypassGoogleAi)
    },
    'bypassMicrosoft': {
        label: '🪟 Bypass Microsoft',
        hint: 'true یا false',
        validate: boolValidate, current: (s: any) => String(s.bypassMicrosoft)
    },
    'bypassOracle': {
        label: '☁️ Bypass Oracle',
        hint: 'true یا false',
        validate: boolValidate, current: (s: any) => String(s.bypassOracle)
    },
    'bypassDocker': {
        label: '🐳 Bypass Docker',
        hint: 'true یا false',
        validate: boolValidate, current: (s: any) => String(s.bypassDocker)
    },
    'blockAds': {
        label: '🚫 Block Ads',
        hint: 'true یا false',
        validate: boolValidate, current: (s: any) => String(s.blockAds)
    },
    'blockPorn': {
        label: '🔞 Block Porn',
        hint: 'true یا false',
        validate: boolValidate, current: (s: any) => String(s.blockPorn)
    },
    'blockMalware': {
        label: '🦠 Block Malware',
        hint: 'true یا false',
        validate: boolValidate, current: (s: any) => String(s.blockMalware)
    },
    'blockPhishing': {
        label: '🎣 Block Phishing',
        hint: 'true یا false',
        validate: boolValidate, current: (s: any) => String(s.blockPhishing)
    },
    'blockCryptominers': {
        label: '⛏️ Block Cryptominers',
        hint: 'true یا false',
        validate: boolValidate, current: (s: any) => String(s.blockCryptominers)
    },
} as const;

/** اعتبارسنجی true/false */
function boolValidate(v: string): true | string {
    return ['true', 'false'].includes(v.trim().toLowerCase()) || 'Send true or false';
}

type EditableField = keyof typeof EDITABLE_SETTINGS;

/**
 * فیلد تنظیمات از متن خام پرامپت بات — خالص و تست‌پذیر.
 * replyTo.text تلگرام همیشه WITHOUT مارک‌آپ HTML است، پس regex تگ‌دار
 * قبلی هیچ‌وقت match نمی‌شد و reply ادمین نادیده گرفته می‌شد
 * (احساس «دکمه‌ی تنظیمات کار نمی‌کند»). این نسخه متن را نرمالایز و
 * لیبل‌ها را جستجو می‌کند — با و بدون تگ کار می‌کند.
 */
export function resolveSettingsFieldFromBotText(botText: string): string | null {
    if (!botText) return null;
    const plain = botText
        .replace(/<[^>]*>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
    // طولانی‌ترین لیبل برنده — «WS Guardian Timeout» نباید با «WS Guardian»
    // اشتباه گرفته شود (زیررشته است)
    const entry = Object.entries(EDITABLE_SETTINGS)
        .filter(([, cfg]) => plain.includes(cfg.label))
        .sort((a, b) => b[1].label.length - a[1].label.length)[0];
    return entry ? entry[0] : null;
}

function settingsKeyboard() {
    return {
        inline_keyboard: [
            [{ text: '🌐 Local DNS', callback_data: 'set_localDNS' }],
            [{ text: '🌍 Remote DNS', callback_data: 'set_remoteDNS' }],
            [{ text: '🛡 Protocols', callback_data: 'set_protocols' }],
            [{ text: '🧹 Clean IPs', callback_data: 'set_cleanIPs' }],
            [{ text: '🔑 Fingerprint', callback_data: 'set_fingerprint' }],
            // ---------- نگهبان WS ----------
            [
                { text: '🛰 Guardian', callback_data: 'set_wsGuardianEnabled' },
                { text: '⏱ Timeout', callback_data: 'set_wsGuardianIdleSec' }
            ],
            // ---------- مسیریابی ----------
            [
                { text: '🇮🇷 Iran', callback_data: 'set_bypassIran' },
                { text: '🇨🇳 China', callback_data: 'set_bypassChina' },
                { text: '🇷🇺 Russia', callback_data: 'set_bypassRussia' }
            ],
            [
                { text: '🤖 OpenAI', callback_data: 'set_bypassOpenAi' },
                { text: '🧠 GoogleAI', callback_data: 'set_bypassGoogleAi' },
                { text: '🪟 MSFT', callback_data: 'set_bypassMicrosoft' }
            ],
            [
                { text: '☁️ Oracle', callback_data: 'set_bypassOracle' },
                { text: '🐳 Docker', callback_data: 'set_bypassDocker' }
            ],
            [
                { text: '🚫 Ads', callback_data: 'set_blockAds' },
                { text: '🔞 Porn', callback_data: 'set_blockPorn' }
            ],
            [
                { text: '🦠 Malware', callback_data: 'set_blockMalware' },
                { text: '🎣 Phishing', callback_data: 'set_blockPhishing' },
                { text: '⛏️ Miners', callback_data: 'set_blockCryptominers' }
            ],
            [{ text: '◀️ Back', callback_data: 'main' }]
        ]
    };
}

async function tgFetch(token: string, method: string, body: any): Promise<any> {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    return res.json();
}

function buildUsageText(totalUsage: number, panelUsage: number): string {
    const panelReqPct = Math.ceil(Number(panelUsage) / 100000 * 100);
    const totalReqPct = Math.ceil(Number(totalUsage) / 100000 * 100);
    const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

    let text = [
        '📊 <b>Cloudflare Workers Usage</b>',
        `━━━━━━━━━━━━━━━━`,
        `📅 Today: ${today}`,
        '',
        `🔵 <b>${_project_} requests</b>`,
        `${panelUsage} / 100,000 (${panelReqPct}%)`,
        '',
        '🔵 <b>Total requests</b>',
        `${totalUsage} / 100,000 (${totalReqPct}%)`,
        '',
        ''
    ].join('\n');

    if (totalReqPct > 80) {
        text += '🔴 <b>WARNING:</b> Approaching limit!\n';
    } else {
        text += '✅ All within limits';
    }

    return text;
}

function buildSubUrl(type: string, app: string): URL {
    const { securePath, origin } = getGlobals();

    const url = new URL(`/${securePath}/sub/${type}`, origin);
    url.searchParams.set('app', app);

    return url;
}

/** لینک اشتراک مخصوص یک کاربر چندکاربره — <securePath>/sub/<userId>/<type> */
function buildUserSubUrl(userId: string, type: string, app: string): URL {
    const { securePath, origin } = getGlobals();

    const url = new URL(`/${securePath}/sub/${userId}/${type}`, origin);
    url.searchParams.set('app', app);

    return url;
}

function buildClientUrl(type: string, app: string, label: string): string {
    const url = buildSubUrl(type, app);

    if (app === 'sing-box' && type !== 'raw') {
        const singUrl = new URL('sing-box://import-remote-profile');
        singUrl.searchParams.set('url', url.href);
        singUrl.hash = `⚡ ${_project_} ${label}`;

        return singUrl.href;
    }

    url.hash = `⚡ ${_project_} ${label}`;
    return url.href;
}

function buildQrUrl(type: string, app: string, label: string): string {
    const { securePath, origin } = getGlobals();
    const url = buildClientUrl(type, app, label);

    const qrUrl = new URL(`/${securePath}/qrcode`, origin);
    qrUrl.searchParams.set('data', url);
    qrUrl.searchParams.set('nocache', Date.now().toString());

    return qrUrl.href;
}

function buildDocUrl(type: string, app: string): string | null {
    if (type === 'raw') return null;

    const url = buildSubUrl(type, app);
    const docUrl = new URL(url);

    const configApp = app.replace('xray-knocker', 'mahsang');
    const baseType = `${type}-${configApp}`;
    const isWg = ['wireguard', 'amnezia'].includes(app);

    const configType = isWg ? `${baseType}-conf` : baseType;
    const ext = isWg ? 'zip' : 'json';

    docUrl.pathname = `${url.pathname}/${_project_SM_}-${configType}.${ext}`;
    docUrl.searchParams.set('nocache', Date.now().toString());

    return docUrl.href;
}

// ============================================================
// 👥 کاربران اشتراک + 📢 broadcast — آمار per-user از KV
// ============================================================

async function sendUsersList(token: string, chatId: number, env: Env, page = 1): Promise<void> {
    const users = await getSubUsers(env);
    // تازه‌ترین‌ها اول — مثل ترتیب پنل
    const ordered = [...users].reverse();
    const { slice, page: safePage, totalPages } = paginateUsers(ordered, page, USERS_PER_PAGE);

    const userButtons = slice.map(user => [{
        text: `${user.active ? '🟢' : '🔴'} ${user.name}  (${user.fetchCount || 0}×)`,
        callback_data: `u_${user.id}`
    }]);

    const navRow: { text: string; callback_data: string }[] = [];
    if (safePage > 1) navRow.push({ text: '◀️ Prev', callback_data: `users_page_${safePage - 1}` });
    if (safePage < totalPages) navRow.push({ text: 'Next ▶️', callback_data: `users_page_${safePage + 1}` });

    const rows: { text: string; callback_data: string }[][] = [
        ...userButtons,
        ...(navRow.length ? [navRow] : []),
        [{ text: '◀️ Back', callback_data: 'main' }]
    ];

    await tgFetch(token, 'sendMessage', {
        chat_id: chatId,
        text: buildUsersOverviewText(ordered),
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: rows }
    });
}

async function sendUserDetail(token: string, chatId: number, env: Env, userId: string): Promise<void> {
    const users = await getSubUsers(env);
    const user = users.find(u => u.id === userId);
    if (!user) {
        await tgFetch(token, 'sendMessage', {
            chat_id: chatId,
            text: '⚠️ User not found — it may have been deleted from the panel.',
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[{ text: '◀️ Users', callback_data: 'users' }]] }
        });
        return;
    }

    await tgFetch(token, 'sendMessage', {
        chat_id: chatId,
        text: buildUserDetailText(user),
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [
                [{ text: '🔗 Resend links', callback_data: `ulink_${user.id}` }],
                [{ text: '◀️ Users', callback_data: 'users' }]
            ]
        }
    });
}

/** ارسال دوباره‌ی لینک‌های یک کاربر — به chat خودش اگر لینک باشد، وگرنه به ادمین */
async function sendUserLinks(token: string, adminChatId: number, env: Env, userId: string): Promise<void> {
    const users = await getSubUsers(env);
    const user = users.find(u => u.id === userId);
    if (!user) {
        await tgFetch(token, 'sendMessage', {
            chat_id: adminChatId,
            text: '⚠️ User not found.',
            parse_mode: 'HTML'
        });
        return;
    }

    const normalUrl = buildUserSubUrl(user.id, 'normal', 'xray').href;
    const rawUrl = buildUserSubUrl(user.id, 'raw', 'xray').href;
    const safeName = escapeHtml(user.name);
    const text = [
        `🔗 <b>Subscription links — ${safeName}</b>`,
        '━━━━━━━━━━━━━━━━',
        `📡 <b>Normal (Xray):</b>\n<code>${escapeHtml(normalUrl)}</code>`,
        '',
        `📄 <b>Raw:</b>\n<code>${escapeHtml(rawUrl)}</code>`,
        '',
        user.active ? '✅ This link is active.' : '🔴 This user is revoked — links return 401 until restored.'
    ].join('\n');

    const target = user.telegramChatId ? Number(user.telegramChatId) : adminChatId;
    await tgFetch(token, 'sendMessage', {
        chat_id: target,
        text,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '◀️ Users', callback_data: 'users' }]] }
    });

    if (target !== adminChatId) {
        await tgFetch(token, 'sendMessage', {
            chat_id: adminChatId,
            text: `✅ Links sent to <b>${escapeHtml(user.name)}</b>'s Telegram chat.`,
            parse_mode: 'HTML'
        });
    }
}

/** شروع flow broadcast — پیام بعدی ادمین متن announcement است */
async function promptBroadcast(token: string, chatId: number, env: Env, adminId: string): Promise<void> {
    const users = await getSubUsers(env);
    const recipients = resolveBroadcastRecipients(users, adminId, () => '');

    if (recipients.length === 0) {
        await tgFetch(token, 'sendMessage', {
            chat_id: chatId,
            text: '⚠️ <b>No recipients.</b>\n\nBroadcast needs at least the admin chat — this should never happen. Check the bot setup.',
            parse_mode: 'HTML'
        });
        return;
    }

    await setPending(env, adminId, TG_BROADCAST_PENDING);
    await tgFetch(token, 'sendMessage', {
        chat_id: chatId,
        text: [
            '📢 <b>Broadcast</b>',
            '━━━━━━━━━━━━━━━━',
            `👥 Recipients: <b>${recipients.length}</b> (admin + Telegram-linked users)`,
            '',
            '💬 Send the message to broadcast now.',
            '',
            '✨ Supported placeholders:',
            '• <code>{name}</code> — user name',
            '• <code>{link}</code> — their personal subscription URL',
            '• <code>{uuid}</code> — their UUID',
            '',
            '<i>Send /settings or tap a menu button to cancel.</i>'
        ].join('\n'),
        parse_mode: 'HTML',
        reply_markup: { force_reply: true, selective: true }
    });
}

/** متن broadcast دریافت شد — ذخیره در pending + پیش‌نمایش برای تأیید */
async function handleBroadcastTextInput(
    token: string,
    chatId: number,
    env: Env,
    adminId: string,
    text: string
): Promise<void> {
    const users = await getSubUsers(env);
    const recipients = resolveBroadcastRecipients(
        users,
        adminId,
        (userId) => userId ? buildUserSubUrl(userId, 'normal', 'xray').href : buildSubUrl('normal', 'xray').href
    );

    // متن + پیشوند در یک کلید pending — بدون KV اضافه
    await setPending(env, adminId, `${TG_BROADCAST_PREFIX}${text}`);

    const sample = recipients[0] || { name: 'Admin', link: '', uuid: '' };
    await tgFetch(token, 'sendMessage', {
        chat_id: chatId,
        text: buildBroadcastConfirmText(text, recipients.length, sample),
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [[
                { text: `✅ Send to ${recipients.length}`, callback_data: 'broadcast_confirm' },
                { text: '❌ Cancel', callback_data: 'broadcast_cancel' }
            ]]
        }
    });
}

/** fan-out نهایی — ارسال شخصی‌سازی‌شده به همه‌ی گیرنده‌ها با گزارش */
async function confirmBroadcast(token: string, chatId: number, env: Env, adminId: string): Promise<void> {
    const pending = await getPending(env, adminId);
    if (!pending || !pending.startsWith(TG_BROADCAST_PREFIX)) {
        await tgFetch(token, 'sendMessage', {
            chat_id: chatId,
            text: '⚠️ No pending broadcast — compose one with /broadcast first.',
            parse_mode: 'HTML',
            reply_markup: mainKeyboard()
        });
        return;
    }

    const template = pending.slice(TG_BROADCAST_PREFIX.length);
    await clearPending(env, adminId); // جلوگیری از ارسال دوباره با tap های اتفاقی

    const users = await getSubUsers(env);
    const recipients = resolveBroadcastRecipients(
        users,
        adminId,
        (userId) => userId ? buildUserSubUrl(userId, 'normal', 'xray').href : buildSubUrl('normal', 'xray').href
    );

    const status = await tgFetch(token, 'sendMessage', {
        chat_id: chatId,
        text: `📤 Broadcasting to ${recipients.length} recipient(s)…`,
        parse_mode: 'HTML'
    });

    const result = await sendBroadcast(recipients, template, async (recipientChatId, text) => {
        const res: any = await tgFetch(token, 'sendMessage', {
            chat_id: Number(recipientChatId),
            text,
            parse_mode: 'HTML',
            link_preview_options: { is_disabled: true }
        });
        return Boolean(res?.ok);
    });

    // ویرایش پیام «در حال ارسال» به گزارش نهایی — با fallback به پیام جدید
    const report = [
        '📢 <b>Broadcast complete</b>',
        '━━━━━━━━━━━━━━━━',
        `✅ Sent: <b>${result.sent}</b>`,
        `❌ Failed: <b>${result.failed}</b>`,
        result.failedChats.length
            ? `\n⚠️ Failed chats: <code>${result.failedChats.slice(0, 10).join(', ')}</code>`
            : '',
        '',
        `${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`
    ].join('\n');

    const statusMsgId = (status as any)?.result?.message_id;
    if (status?.ok && statusMsgId) {
        await tgFetch(token, 'editMessageText', {
            chat_id: chatId,
            message_id: statusMsgId,
            text: report,
            parse_mode: 'HTML',
            reply_markup: mainKeyboard()
        });
    } else {
        await tgFetch(token, 'sendMessage', {
            chat_id: chatId,
            text: report,
            parse_mode: 'HTML',
            reply_markup: mainKeyboard()
        });
    }
}

async function cancelBroadcast(token: string, chatId: number, env: Env, adminId: string): Promise<void> {
    await clearPending(env, adminId);
    await tgFetch(token, 'sendMessage', {
        chat_id: chatId,
        text: '❌ Broadcast cancelled — nothing was sent.',
        parse_mode: 'HTML',
        reply_markup: mainKeyboard()
    });
}

async function handleCallback(cq: TgCallbackQuery, token: string, chatId: number, env: Env): Promise<void> {
    const data = cq.data || '';

    switch (data) {
        case 'settings':
            await tgFetch(token, 'sendMessage', {
                chat_id: chatId,
                text: '⚙️ <b>Panel Settings</b>\n\nChoose a setting to change:',
                parse_mode: 'HTML',
                reply_markup: settingsKeyboard()
            });
            break;

        case 'status':
            await sendStatus(token, chatId, env);
            break;

        case 'restart':
            await invalidateDatasetCache();
            await tgFetch(token, 'sendMessage', {
                chat_id: chatId,
                text: '🔄 <b>Caches invalidated!</b>\n\nSettings KV and dataset cache cleared — fresh values will be loaded on next request.',
                parse_mode: 'HTML',
                reply_markup: mainKeyboard()
            });
            break;

        case 'sub':
            await tgFetch(token, 'sendMessage', {
                chat_id: chatId,
                text: '🔗 <b>Get Config</b>\n\nChoose a config type:',
                parse_mode: 'HTML',
                reply_markup: subKeyboard()
            });
            break;

        case 'clients':
            await tgFetch(token, 'sendMessage', {
                chat_id: chatId,
                text: '📱 <b>Supported clients</b>\n\nChoose a client:',
                parse_mode: 'HTML',
                reply_markup: clientsKeyboard()
            });
            break;

        // ---------- 👥 کاربران اشتراک + 📢 broadcast ----------
        case 'users':
            await sendUsersList(token, chatId, env, 1);
            break;

        case 'broadcast':
            await promptBroadcast(token, chatId, env, cq.from.id.toString());
            break;

        case 'broadcast_confirm':
            await confirmBroadcast(token, chatId, env, cq.from.id.toString());
            break;

        case 'broadcast_cancel':
            await cancelBroadcast(token, chatId, env, cq.from.id.toString());
            break;

        case 'usage':
        case 'usage_refresh':
            const result = await getUsageCached();
            if (!result.success) {
                await tgFetch(token, 'sendMessage', {
                    chat_id: chatId,
                    text: result.error,
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'main' }]] }
                });
                break;
            }

            // صفر هم داده‌ی معتبر است (ابتدای روز UTC) — دکمه باید همیشه چیزی نشان دهد؛
            // قبلاً total/worker صفر باعث break بی‌صدا می‌شد و دکمه «کار نمی‌کرد»
            const text = buildUsageText(result.total ?? 0, result.worker ?? 0);
            if (data === 'usage_refresh' && cq.message?.message_id) {
                const edited = await tgFetch(token, 'editMessageText', {
                    chat_id: chatId,
                    message_id: cq.message.message_id,
                    text: text,
                    parse_mode: 'HTML',
                    reply_markup: usageKeyboard()
                });
                // «message is not modified» و خطاهای مشابه تلگرام → پیام تازه به‌جای سکوت
                if (!edited?.ok) {
                    await tgFetch(token, 'sendMessage', {
                        chat_id: chatId,
                        text: text,
                        parse_mode: 'HTML',
                        reply_markup: usageKeyboard()
                    });
                }
            } else {
                await tgFetch(token, 'sendMessage', {
                    chat_id: chatId,
                    text: text,
                    parse_mode: 'HTML',
                    reply_markup: usageKeyboard()
                });
            }
            break;

        default:
            // ---------- Users: صفحه‌بندی، جزئیات، ارسال لینک ----------
            // ترتیب مهم است: users_page_ و ulink_ قبل از u_ چک بشن
            if (data.startsWith('users_page_')) {
                const page = parseInt(data.slice(11), 10);
                await sendUsersList(token, chatId, env, Number.isFinite(page) ? page : 1);
            } else if (data.startsWith('ulink_')) {
                await sendUserLinks(token, chatId, env, data.slice(6));
            } else if (data.startsWith('u_')) {
                await sendUserDetail(token, chatId, env, data.slice(2));
            }
            // ---------- Settings ----------
            else if (data.startsWith('set_')) {
                const field = data.slice(4) as EditableField;
                const config = EDITABLE_SETTINGS[field];
                if (!config) break;

                const { settings } = await getDataset(env);
                const currentValue = config.current(settings);

                // ثبت حالت انتظار برای این کاربر (fallback بدون reply)
                await setPending(env, cq.from.id.toString(), field);

                await tgFetch(token, 'sendMessage', {
                    chat_id: chatId,
                    text: `⚙️ <b>${config.label}</b>\n\n` +
                          `📋 <b>Current:</b>\n<code>${currentValue}</code>\n\n` +
                          `💬 <b>Send new value (reply یا پیام تکی):</b>\n<i>${config.hint}</i>`,
                    parse_mode: 'HTML',
                    reply_markup: {
                        force_reply: true,
                        selective: true
                    }
                });
                break;
            }
            if (data.startsWith('sub_')) {
                // با slice به‌جای split — کل مقدار بعد از پیشوند
                const typeKey = data.slice(4); // 'sub_'.length
                const subscription = subscriptions[typeKey];
                if (!subscription) break;

                for (const [index, appInfo] of subscription.categories.entries()) {
                    const clientUrl = buildClientUrl(typeKey, appInfo.core, subscription.label);
                    const qrUrl = buildQrUrl(typeKey, appInfo.core, subscription.label);
                    const docUrl = buildDocUrl(typeKey, appInfo.core);
                    const wgClient = ['wireguard', 'amnezia'].includes(appInfo.core);

                    const supportedList = appInfo.clients.map(a => `✅ ${a}`).join('\n');
                    const showUrl = wgClient ? '' : `<code>${clientUrl}</code>\n\n`;
                    const caption = `⚡ <b>${_project_} ${subscription.label}</b>\n\n${showUrl}<b>Supported apps:</b>\n\n${supportedList}`;

                    const isLast = index === subscription.categories.length - 1;
                    const backBtn = {
                        reply_markup: {
                            inline_keyboard: [[{ text: '◀️ Back', callback_data: 'sub' }]]
                        }
                    };

                    if (wgClient) {
                        await tgFetch(token, 'sendDocument', {
                            chat_id: chatId,
                            document: docUrl,
                            caption: caption,
                            parse_mode: 'HTML',
                            ...(isLast && backBtn)
                        });
                    } else {
                        const hasDocument = typeKey !== 'raw';

                        const photoRes = await tgFetch(token, 'sendPhoto', {
                            chat_id: chatId,
                            photo: qrUrl,
                            caption: caption,
                            parse_mode: 'HTML',
                            ...(isLast && !hasDocument && backBtn)
                        });

                        // QR اگر به هر دلیلی ارسال نشد (تصویر بزرگ/خطای تلگرام/...) —
                        // لینک متنی می‌فرستیم تا دکمه هیچ‌وقت بی‌جواب نماند
                        if (!photoRes?.ok) {
                            await tgFetch(token, 'sendMessage', {
                                chat_id: chatId,
                                text: `⚡ <b>${_project_} ${subscription.label}</b>\n\n<code>${escapeHtml(clientUrl)}</code>\n\n<b>Supported apps:</b>\n\n${supportedList}`,
                                parse_mode: 'HTML',
                                ...(isLast && !hasDocument && backBtn)
                            });
                        }

                        if (hasDocument) {
                            await tgFetch(token, 'sendDocument', {
                                chat_id: chatId,
                                document: docUrl,
                                ...(isLast && backBtn)
                            });
                        }
                    }
                }
            }

            if (data.startsWith('client_')) {
                // باگ قبلی: split('_')[1] برای اسم‌های دارای فاصله
                // ('Clash Meta', 'Clash verge rev', 'WG Tunnel') فقط بخش اول اسم رو
                // برمی‌گردوند و این دکمه‌ها کار نمی‌کردن — با slice کل اسم حفظ می‌شه
                const clientName = data.slice(7); // 'client_'.length
                const client = clients.find(cli => cli.name === clientName);
                if (!client) break;
                let text = [
                    `✅ <b>${client.name}</b>`,
                    `━━━━━━━━━━━━━━━━`,
                    `📍 <b>Minimum requirement:</b> ${client.minVer}`,
                    `🏚️ <b>Download source:</b> ${client.source}`,
                    '',
                    `📥 <a href=\"${atob(client.b64Url)}\"><b>Get latest version</b></a>`,
                    ''
                ].join('\n');

                await tgFetch(token, 'sendMessage', {
                    chat_id: chatId,
                    text: text,
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [[{ text: '◀️ Back', callback_data: 'clients' }]]
                    }
                });
            }
    }
}

export async function handleTelegramWebhook(request: Request, env: Env): Promise<Response> {
    try {
        return await handleTelegramUpdate(request, env);
    } catch {
        // تور ایمنی نهایی — هرگز 500 برنگرد؛ تلگرام روی خطا retry می‌کند
        // و همان آپدیت دوباره اجرا می‌شود (پیام‌های تکراری/لوپ)
        return new Response(null, { status: 200 });
    }
}

async function handleTelegramUpdate(request: Request, env: Env): Promise<Response> {
    // تنظیمات بات از دیتاست کش‌شده — به‌جای خواندن KV در هر آپدیت
    const { telegramBot: tgBot } = await getDataset(env);
    if (!tgBot) return new Response(null, { status: 200 });

    const { telegramBotToken: botToken, telegramUserId: userId } = tgBot;
    if (!botToken || !userId) return new Response(null, { status: 200 });

    // 🔐 اعتبارسنجی secret تلگرام — درخواست فقط از سرورهای تلگرام معتبره
    // (قبلاً هر کسی که URL وب‌هوک رو بدونه می‌تونست آپدیت جعلی بفرسته)
    const expectedSecret = await deriveWebhookSecret(botToken);
    if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== expectedSecret) {
        return new Response(null, { status: 200 });
    }

    let update: TgUpdate;
    try {
        update = await request.json();
    } catch {
        return new Response(null, { status: 200 });
    }

    if (update.callback_query) {
        const cq = update.callback_query;
        if (cq.from.id.toString() !== userId) return new Response(null, { status: 200 });

        await tgFetch(botToken, 'answerCallbackQuery', { callback_query_id: cq.id });

        const chatId = cq.message?.chat.id;
        if (!chatId) return new Response(null, { status: 200 });

        const data = cq.data || '';

        if (data === 'main') {
            // لغو flow های در انتظار broadcast با بازگشت به منوی اصلی
            const pending = await getPending(env, cq.from.id.toString());
            if (pending && (pending === TG_BROADCAST_PENDING || pending.startsWith(TG_BROADCAST_PREFIX))) {
                await clearPending(env, cq.from.id.toString());
            }

            await tgFetch(botToken, 'sendMessage', {
                chat_id: chatId,
                text: `🤖 <b>${_project_} Panel Bot</b>\n\nChoose an option:`,
                parse_mode: 'HTML',
                reply_markup: mainKeyboard()
            });
        } else {
            try {
                await handleCallback(cq, botToken, chatId, env);
            } catch (error) {
                // خطای غیرمنتظره در هندلر دکمه — ادمین باید بداند، نه سکوت
                await tgFetch(botToken, 'sendMessage', {
                    chat_id: chatId,
                    text: `⚠️ Action failed: ${safeError(error).slice(0, 200)}`
                }).catch(() => {});
            }
        }
        // await شده — بدون await بعد از return شدن response در Workers
        // این promise احتمالاً cancel می‌شد (باگ قبلی)
        await checkCfUsageWarning(botToken, chatId);
        return new Response(null, { status: 200 });
    }

    if (update.message) {
        if (update.message.from.id.toString() !== userId) return new Response(null, { status: 200 });

        const chatId = update.message.chat.id;
        const text = update.message.text || '';

        // ---------- Settings: ورودی کاربر ----------
        // اول از reply تشخیص بده، اگه نبود از KV-pending
        let settingsField: string | null = null;

        const replyTo = update.message.reply_to_message;
        if (replyTo && replyTo.from?.is_bot && text) {
            const botText = replyTo.text || replyTo.caption || '';
            // مسیر قدیمی — لیبل تگ‌دار (برای سازگاری حفظ شد؛ معمولاً match نمی‌شود
            // چون replyTo.text بدون مارک‌آپ است)
            const fieldMatch = botText.match(/<b>([^<]+)<\/b>/);
            if (fieldMatch) {
                const label = fieldMatch[1];
                const fieldEntry = Object.entries(EDITABLE_SETTINGS).find(
                    ([, cfg]) => cfg.label === label
                );
                if (fieldEntry) settingsField = fieldEntry[0];
            }
            // مسیر جدید — تشخیص از متن خام؛ حتی وقتی pending منقضی شده باشد کار می‌کند
            if (!settingsField) settingsField = resolveSettingsFieldFromBotText(botText);
        }

        if (!settingsField && text && !text.startsWith('/')) {
            const pending = await getPending(env, update.message.from.id.toString());

            // ---------- 📢 Broadcast: در انتظار متن announcement ----------
            if (pending === TG_BROADCAST_PENDING) {
                await handleBroadcastTextInput(botToken, chatId, env, update.message.from.id.toString(), text);
                await checkCfUsageWarning(botToken, chatId);
                return new Response(null, { status: 200 });
            }

            if (pending && pending in EDITABLE_SETTINGS) settingsField = pending;
        }

        if (settingsField) {
            {
                const field = settingsField as EditableField;
                const config = EDITABLE_SETTINGS[field];
                {
                    const validation = config.validate(text);

                    if (validation !== true) {
                        await tgFetch(botToken, 'sendMessage', {
                            chat_id: chatId,
                            text: `❌ <b>Error:</b> ${validation}\n\nTry again:`,
                            parse_mode: 'HTML',
                            reply_to_message_id: update.message.message_id,
                            reply_markup: {
                                inline_keyboard: [[
                                    { text: '🔄 Retry', callback_data: `set_${field}` },
                                    { text: '◀️ Cancel', callback_data: 'settings' }
                                ]]
                            }
                        });
                        await checkCfUsageWarning(botToken, chatId);
                        return new Response(null, { status: 200 });
                    }

                    let newValue: any;
                    if (field === 'protocols') {
                        newValue = text.toLowerCase().split(',').map(p => p.trim()).join(',');
                    } else if (field === 'cleanIPs') {
                        newValue = text.split('\n').map(l => l.trim()).filter(Boolean);
                    } else if (config.validate === boolValidate) {
                        // باگ پیش‌موجود: رشته‌ی 'false' در JS truthy است و قوانین
                        // مسیریابی را وارونه می‌کرد — بولی واقعی ذخیره می‌شود
                        newValue = text.trim().toLowerCase() === 'true';
                    } else if (field === 'wsGuardianIdleSec') {
                        newValue = Number(text.trim());
                    } else {
                        newValue = text.trim();
                    }

                    const { settings } = await getDataset(env);
                    (settings as any)[field] = newValue;
                    try {
                        await updateDatasetFromTelegram(env, settings);
                    } catch (saveError) {
                        // KV هرگز نباید ادمین را بی‌جواب بگذارد
                        await tgFetch(botToken, 'sendMessage', {
                            chat_id: chatId,
                            text: `⚠️ <b>Save failed:</b> ${safeError(saveError)}\n\nTry again in a moment.`,
                            parse_mode: 'HTML'
                        });
                        await checkCfUsageWarning(botToken, chatId);
                        return new Response(null, { status: 200 });
                    }

                    await tgFetch(botToken, 'sendMessage', {
                        chat_id: chatId,
                        text: `✅ <b>${config.label} updated!</b>\n\n` +
                              `📋 <b>New value:</b>\n<code>${newValue}</code>`,
                        parse_mode: 'HTML',
                        reply_markup: settingsKeyboard()
                    });
                    await clearPending(env, update.message.from.id.toString());
                    await checkCfUsageWarning(botToken, chatId);
                    return new Response(null, { status: 200 });
                }
            }
        }

        // دستور جدید = لغو هر flow در انتظار (متن broadcast آماده‌ی تأیید هم پاک می‌شود)
        if (text.startsWith('/')) {
            const stalePending = await getPending(env, update.message.from.id.toString());
            if (stalePending && (stalePending === TG_BROADCAST_PENDING || stalePending.startsWith(TG_BROADCAST_PREFIX))) {
                await clearPending(env, update.message.from.id.toString());
            }
        }

        switch (text) {
            case '/usage':
                const result = await getUsageCached();
                if (!result.success || !result.worker || !result.total) break;
                await tgFetch(botToken, 'sendMessage', {
                    chat_id: chatId,
                    text: buildUsageText(result.total, result.worker),
                    parse_mode: 'HTML',
                    reply_markup: usageKeyboard()
                });
                break;

            case '/settings':
                await tgFetch(botToken, 'sendMessage', {
                    chat_id: chatId,
                    text: '⚙️ <b>Panel Settings</b>\n\nChoose a setting to change:',
                    parse_mode: 'HTML',
                    reply_markup: settingsKeyboard()
                });
                break;

            case '/status':
                await sendStatus(botToken, chatId, env);
                break;

            case '/restart':
                await invalidateDatasetCache();
                await tgFetch(botToken, 'sendMessage', {
                    chat_id: chatId,
                    text: '🔄 <b>Caches invalidated!</b>\n\nFresh values will be loaded on next request.',
                    parse_mode: 'HTML',
                    reply_markup: mainKeyboard()
                });
                break;

            case '/clients':
                await tgFetch(botToken, 'sendMessage', {
                    chat_id: chatId,
                    text: '📱 <b>Supported clients</b>\n\nChoose a client:',
                    parse_mode: 'HTML',
                    reply_markup: clientsKeyboard()
                });
                break;

            case '/tg':
                await tgFetch(botToken, 'sendMessage', {
                    chat_id: chatId,
                    text: buildTelegramGuideText(),
                    parse_mode: 'HTML',
                    reply_markup: mainKeyboard()
                });
                break;

            case '/users':
                await sendUsersList(botToken, chatId, env, 1);
                break;

            case '/digest':
                await tgFetch(botToken, 'sendMessage', {
                    chat_id: chatId,
                    text: await buildDigestForCommand(env),
                    parse_mode: 'HTML',
                    reply_markup: mainKeyboard()
                });
                break;

            case '/edge':
                await tgFetch(botToken, 'sendMessage', {
                    chat_id: chatId,
                    text: buildEdgeText(await getEdgeTelemetry(env)),
                    parse_mode: 'HTML',
                    reply_markup: mainKeyboard()
                });
                break;

            case '/broadcast':
                await promptBroadcast(botToken, chatId, env, update.message.from.id.toString());
                break;

            case '/config':
                await tgFetch(botToken, 'sendMessage', {
                    chat_id: chatId,
                    text: '🔗 <b>Get Config</b>\n\nChoose a configuration type:',
                    parse_mode: 'HTML',
                    reply_markup: subKeyboard()
                });
                break;

            default:
                await tgFetch(botToken, 'sendMessage', {
                    chat_id: chatId,
                    text: `🤖 <b>${_project_} Panel Bot</b>\n\nChoose an option:`,
                    parse_mode: 'HTML',
                    reply_markup: mainKeyboard()
                });
                break;
        }

        await checkCfUsageWarning(botToken, chatId);
        return new Response(null, { status: 200 });
    }

    return new Response(null, { status: 200 });
}

/** نمای کلی پنل — وضعیت، مصرف، خلاصه‌ی تنظیمات */
async function sendStatus(token: string, chatId: number, env: Env): Promise<void> {
    const { settings } = await getDataset(env);
    const usage = await getUsageCached();

    const toggles = [
        ['🇮🇷 Iran', settings.bypassIran],
        ['🇨🇳 China', settings.bypassChina],
        ['🇷🇺 Russia', settings.bypassRussia],
        ['🤖 OpenAI', settings.bypassOpenAi],
        ['🚫 Ads', settings.blockAds],
        ['🦠 Malware', settings.blockMalware],
    ] as const;

    const toggleLines = toggles
        .map(([label, on]) => `${on ? '🟢' : '⚫'} ${label}`)
        .join('   ');

    let usageLine = '📊 Usage: unavailable';
    if (usage?.success && usage.worker && usage.total) {
        const pct = Math.ceil(Number(usage.total) / 100000 * 100);
        usageLine = `📊 Usage: ${usage.total.toLocaleString()} / 100,000 (${pct}%)`;
    }

    const text = [
        `📡 <b>Flash Panel Status</b>`,
        `━━━━━━━━━━━━━━━━`,
        `✅ Panel: <b>alive</b>`,
        `⚡ Version: <b>${settings.panelVersion || 'unknown'}</b>`,
        usageLine,
        ``,
        `🌐 Local DNS: <code>${settings.localDNS}</code>`,
        `🛡 Protocols: <code>${settings.protocols}</code>`,
        `🔑 Fingerprint: <code>${settings.fingerprint}</code>`,
        `🧹 Clean IPs: <b>${(settings.cleanIPs || []).length}</b> entries`,
        ``,
        `Routing:`,
        toggleLines,
    ].join('\n');

    await tgFetch(token, 'sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        reply_markup: mainKeyboard()
    });
}

async function checkCfUsageWarning(botToken: string, chatId: number): Promise<void> {
    const result = await getUsageCached();
    if (!result.success || !result.worker || !result.total) return;

    const nearLimit = result.total / 100000 * 100 > 80;
    if (nearLimit) {
        await tgFetch(botToken, 'sendMessage', {
            chat_id: chatId,
            text: buildUsageText(result.total, result.worker),
            parse_mode: 'HTML',
            reply_markup: usageKeyboard()
        });
    }
}
// ---------- state ورودی Settings (KV با TTL) ----------
// force_reply بعضی کلاینت‌های تلگرام قابل‌اعتماد نیست — پس هم reply واقعی
// رو قبول می‌کنیم هم پیام تکی رو (اگه user توی حالت انتظار باشه)

const TG_PENDING_PREFIX = 'tg-pending-';

// flow broadcast از همان مکانیزم pending استفاده می‌کند:
//   مقدار TG_BROADCAST_PENDING = «در انتظار متن announcement»
//   مقدار TG_BROADCAST_PREFIX + text = «متن آماده‌ی ارسال، منتظر تأیید»
const TG_BROADCAST_PENDING = 'broadcast';
const TG_BROADCAST_PREFIX = 'broadcast:';

async function setPending(env: Env, userId: string, field: string) {
    // ۱۵ دقیقه — قبلاً ۳۰۰ ثانیه بود؛ ادمینی که دیر جواب می‌داد
    // پیامش بی‌اثر می‌شد (احساس «کار نمی‌کند»)
    await env.kv.put(TG_PENDING_PREFIX + userId, field, { expirationTtl: 900 });
}

async function getPending(env: Env, userId: string): Promise<string | null> {
    return env.kv.get(TG_PENDING_PREFIX + userId);
}

async function clearPending(env: Env, userId: string) {
    await env.kv.delete(TG_PENDING_PREFIX + userId);
}

/** ذخیره‌ی تنظیمات از ربات — مستقیم در KV + invalidate کش */
async function updateDatasetFromTelegram(env: Env, settings: any): Promise<void> {
    await env.kv.put('proxySettings', JSON.stringify(settings));
    invalidateDatasetCache();
}