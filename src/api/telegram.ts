import { HttpStatus, respond, safeError } from '@common';
import { clients, getGlobals, subscriptions } from '@settings';
import { getCfWorkerUsage } from './usage';
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
                    { command: 'usage', description: '📊 Monitor usage' },
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
    first_name?: string;
    last_name?: string;
    username?: string;
}

interface TgMessage {
    message_id: number;
    from: TgUser;
    chat: { id: number; type: string };
    text?: string;
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

async function handleCallback(cq: TgCallbackQuery, token: string, chatId: number): Promise<void> {
    const data = cq.data || '';

    switch (data) {
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

        case 'usage':
        case 'usage_refresh':
            const result = await getUsageCached();
            if (!result) {
                await tgFetch(token, 'sendMessage', {
                    chat_id: chatId,
                    text: '⚠️ Could not fetch usage data.',
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'main' }]] }
                });
                break;
            }

            if (!result.success) {
                await tgFetch(token, 'sendMessage', {
                    chat_id: chatId,
                    text: result.error,
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'main' }]] }
                });
                break;
            }

            if (!result.total || !result.worker) break;
            const text = buildUsageText(result.total, result.worker);
            if (data === 'usage_refresh' && cq.message?.message_id) {
                await tgFetch(token, 'editMessageText', {
                    chat_id: chatId,
                    message_id: cq.message.message_id,
                    text: text,
                    parse_mode: 'HTML',
                    reply_markup: usageKeyboard()
                });
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

                        await tgFetch(token, 'sendPhoto', {
                            chat_id: chatId,
                            photo: qrUrl,
                            caption: caption,
                            parse_mode: 'HTML',
                            ...(isLast && !hasDocument && backBtn)
                        });

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
            await tgFetch(botToken, 'sendMessage', {
                chat_id: chatId,
                text: `🤖 <b>${_project_} Panel Bot</b>\n\nChoose an option:`,
                parse_mode: 'HTML',
                reply_markup: mainKeyboard()
            });
        } else {
            await handleCallback(cq, botToken, chatId);
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

            case '/clients':
                await tgFetch(botToken, 'sendMessage', {
                    chat_id: chatId,
                    text: '📱 <b>Supported clients</b>\n\nChoose a client:',
                    parse_mode: 'HTML',
                    reply_markup: clientsKeyboard()
                });
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