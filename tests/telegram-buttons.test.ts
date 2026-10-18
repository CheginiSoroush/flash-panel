/**
 * شبیه‌سازی کامل ربات تلگرام — هر دکمه‌ای که کیبوردها تولید می‌کنند
 * باید حداقل یک پاسخ قابل‌مشاهده از بات تولید کند.
 *
 * باگ‌هایی که این سوئیت قبلاً پیدا کرد (همه «بی‌صدا» بودند — وب‌هوک 200
 * می‌داد ولی هیچ پیامی نمی‌رفت و دکمه «کار نمی‌کرد»):
 *   ۱) usage با total/worker صفر → break بی‌صدا
 *   ۲) usage_refresh وقتی editMessageText شکست می‌خورد → سکوت
 *   ۳) reply به پرامپت تنظیمات → regex تگ‌دار هیچ‌وقت match نمی‌شد
 *   ۴) نام کاربر با کاراکتر HTML → parse error تلگرام → دکمه‌ی لینک‌ها می‌مرد
 *   ۵) کرش داخل هندلر دکمه → 500 → لوپ retry تلگرام
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

(globalThis as any).VERSION = '0.8.6';

// ---------- ثابت‌های هارنس ----------

const BOT_TOKEN = '123456:TEST-TELEGRAM-TOKEN';
const ADMIN_ID = 111;
// chat_id تلگرام باید ۵..۲۰ رقم باشد — پنل کوتاه‌تر را در sanitizeStats حذف می‌کند
const LINKED_CHAT = 22222;

const WH_SECRET = [...new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(BOT_TOKEN))
)].slice(0, 24).map(b => b.toString(16).padStart(2, '0')).join('');

const BASE_EMBEDED = {
    accID: 'test-account',
    accEmail: 'test@example.com',
    apiToken: 'test-token',
    vlUUID: 'b831381d-6324-4d53-ad4f-8cda48b30811',
    trPass: 'test-pass',
    securePath: 'sp',
    mainDomain: 'panel.example.com',
    scriptName: 'flash-panel-test',
    proxyIpMode: '',
    proxyIPs: [],
    prefixes: [],
    forceProxyDomains: [],
    fallback: '',
    dohUrl: ''
};

const SUB_USERS = [
    { id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', name: 'Ali', active: true, fetchCount: 12, lastFetchedAt: Date.now() - 3_600_000 },
    { id: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', name: 'Sara', active: true, fetchCount: 5, telegramChatId: String(LINKED_CHAT) },
    { id: 'c3d4e5f6-a7b8-4c9d-ae1f-2a3b4c5d6e7f', name: 'Reza', active: true, fetchCount: 0 },
    { id: 'd4e5f6a7-b8c9-4d0e-bf2a-3b4c5d6e7f8a', name: 'Mina', active: false, fetchCount: 1 },
    { id: 'e5f6a7b8-c9d0-4e1f-9a3b-4c5d6e7f8a9b', name: 'Hossein', active: true, fetchCount: 3 },
    { id: 'f6a7b8c9-d0e1-4f2a-8b4c-5d6e7f8a9b0c', name: 'Nazi <script>&co', active: true, fetchCount: 2 } // نام متخاصم — باید escape شود
];

// ---------- KV mock ----------

function createKvMock(seed: Record<string, unknown> = {}) {
    const store = new Map<string, string>();
    for (const [k, v] of Object.entries(seed)) {
        store.set(k, typeof v === 'string' ? v : JSON.stringify(v));
    }
    return {
        kv: {
            async get(key: string, opts?: { type?: string }) {
                const raw = store.get(key);
                if (raw === undefined) return null;
                return opts?.type === 'json' ? JSON.parse(raw) : raw;
            },
            async put(key: string, value: string) { store.set(key, value); },
            async delete(key: string) { store.delete(key); }
        } as unknown as KVNamespace,
        store
    };
}

// ---------- Telegram/CF fetch recorder ----------

interface TgCall { method: string; body: any; }

let tgCalls: TgCall[] = [];
let tgBehavior: Partial<Record<string, (body: any, calls: TgCall[]) => unknown>> = {};
let usageStub = { total: 4200, worker: 1700 };

function defaultTgResult(method: string) {
    if (method === 'getMe') return { id: 123456, is_bot: true, username: 'test_bot' };
    if (method === 'sendDocument') return { message_id: 43, document: {} };
    if (method === 'sendPhoto') return { message_id: 44, photo: [] };
    return { message_id: 42, chat: { id: ADMIN_ID } };
}

function installFetchStub() {
    vi.stubGlobal('fetch', vi.fn(async (input: any, init?: any) => {
        const url = String(input instanceof Request ? input.url : input);

        if (url.includes('api.telegram.org')) {
            const method = url.split('/').pop() || '';
            let body: any = {};
            try {
                const rawBody = input instanceof Request ? await input.text() : init?.body;
                body = rawBody ? JSON.parse(rawBody) : {};
            } catch {
                body = {};
            }
            const call: TgCall = { method, body };
            tgCalls.push(call);

            const behavior = tgBehavior[method];
            if (behavior) {
                const result = behavior(body, tgCalls);
                if (result === 'THROW') throw new Error('network down');
                return new Response(JSON.stringify(
                    (result as any)?.__raw ? result : { ok: true, result: result ?? defaultTgResult(method) }
                ), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }

            return new Response(JSON.stringify({ ok: true, result: defaultTgResult(method) }),
                { status: 200, headers: { 'Content-Type': 'application/json' } });
        }

        if (url.includes('api.cloudflare.com/client/v4/graphql')) {
            return new Response(JSON.stringify({
                data: {
                    viewer: {
                        accounts: [{
                            total: [{ sum: { requests: usageStub.total } }],
                            worker: [{ sum: { requests: usageStub.worker } }]
                        }]
                    }
                }
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }

        // هر fetch دیگری (DoH و…) — پاس عمومی
        return new Response(JSON.stringify({ ok: true, Status: 0 }), { status: 200 });
    }) as any);
}

// ---------- boot ماژول‌ها ----------

async function bootBot() {
    vi.resetModules();
    (globalThis as any).EMBEDED_SETTINGS = { ...BASE_EMBEDED };

    const settings = await import('../src/settings/settings');
    settings.init(new Request('https://panel.example.com/sp/anything'), {} as Env);

    const { kv, store } = createKvMock({
        proxySettings: { ...settings.getKvSettings(), panelVersion: (globalThis as any).VERSION },
        warpAccounts: [],
        telegramBot: { telegramBotToken: BOT_TOKEN, telegramUserId: String(ADMIN_ID) },
        subUsers: SUB_USERS
    });

    installFetchStub();
    tgCalls = [];
    tgBehavior = {};
    usageStub = { total: 4200, worker: 1700 };

    const telegram = await import('../src/api/telegram');
    const env = { kv } as unknown as Env;
    return { telegram, env, store };
}

function callbackUpdate(data: string, messageId = 100, fromId = ADMIN_ID, cqId = 'cbq-1') {
    return {
        update_id: Math.floor(Math.random() * 1e9),
        callback_query: {
            id: cqId,
            from: { id: fromId, is_bot: false, first_name: 'Admin' },
            message: { message_id: messageId, chat: { id: fromId } },
            data
        }
    };
}

function messageUpdate(text: string, extra: Record<string, unknown> = {}, fromId = ADMIN_ID) {
    return {
        update_id: Math.floor(Math.random() * 1e9),
        message: {
            message_id: 500 + Math.floor(Math.random() * 100),
            from: { id: fromId, is_bot: false, first_name: 'Admin' },
            chat: { id: fromId, type: 'private' },
            text,
            ...extra
        }
    };
}

async function post(telegram: any, env: Env, update: unknown): Promise<Response> {
    return telegram.handleTelegramWebhook(new Request('https://panel.example.com/sp/telegram/webhook', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Telegram-Bot-Api-Secret-Token': WH_SECRET
        },
        body: JSON.stringify(update)
    }), env);
}

const sentTexts = () => tgCalls.filter(c => c.method === 'sendMessage').map(c => String(c.body.text || ''));
const calledMethods = () => new Set(tgCalls.map(c => c.method));

afterEach(() => {
    delete (globalThis as any).EMBEDED_SETTINGS;
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

// ---------- ۱) دکمه‌های منوی اصلی ----------

describe('main-menu buttons — every press must be visible', () => {
    const MAIN_BUTTONS = ['main', 'sub', 'clients', 'usage', 'settings', 'users', 'broadcast', 'status', 'restart'];

    it.each(MAIN_BUTTONS)('callback "%s" → 200 + at least one Telegram message', async (data) => {
        const { telegram, env } = await bootBot();
        const res = await post(telegram, env, callbackUpdate(data));

        expect(res.status).toBe(200);
        const methods = calledMethods();
        const visible = methods.has('sendMessage') || methods.has('sendPhoto') || methods.has('sendDocument');
        expect(visible, `button "${data}" produced no visible Telegram call — dead button!`).toBe(true);
    });

    it('main menu contains all 8 action buttons', async () => {
        const { telegram, env } = await bootBot();
        await post(telegram, env, callbackUpdate('main'));

        const menuCall = tgCalls.find(c => c.method === 'sendMessage');
        expect(menuCall, 'main menu message was not sent').toBeTruthy();
        const keyboard = menuCall!.body.reply_markup.inline_keyboard.flat();
        const actions = keyboard.map((b: any) => b.callback_data);
        for (const action of ['sub', 'clients', 'usage', 'settings', 'users', 'broadcast', 'status', 'restart']) {
            expect(actions).toContain(action);
        }
    });
});

// ---------- ۲) دکمه‌های اشتراک ----------

describe('subscription buttons — config must always arrive', () => {
    const SUB_TYPES = ['normal', 'fragment', 'raw', 'warp', 'warp-pro'];

    it.each(SUB_TYPES)('callback "sub_%s" → 200 + photo/document delivered', async (type) => {
        const { telegram, env } = await bootBot();
        const res = await post(telegram, env, callbackUpdate(`sub_${type}`));

        expect(res.status).toBe(200);
        const methods = calledMethods();
        expect(
            methods.has('sendPhoto') || methods.has('sendDocument') || methods.has('sendMessage'),
            `sub_${type} delivered nothing`
        ).toBe(true);
    });

    it('sub buttons list matches the subscriptions registry (no orphan button)', async () => {
        const { telegram, env } = await bootBot();
        await post(telegram, env, callbackUpdate('sub'));

        const menuCall = tgCalls.find(c => c.method === 'sendMessage');
        expect(menuCall, 'sub menu message was not sent').toBeTruthy();
        const actions = menuCall!.body.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data);
        expect(actions.filter((a: string) => a.startsWith('sub_'))).toHaveLength(5);
    });

    it('QR photo failure → text fallback with the link (never silent)', async () => {
        const { telegram, env } = await bootBot();
        tgBehavior.sendPhoto = () => ({ __raw: { ok: false, description: 'Bad Request: wrong file identifier' } });

        await post(telegram, env, callbackUpdate('sub_normal'));

        const fallback = sentTexts().find(t => t.includes('sub/normal?app=xray'));
        expect(fallback, 'photo failed and no text fallback was sent').toBeTruthy();
        expect(fallback).toContain('Supported apps');
    });
});

// ---------- ۳) دکمه‌های کلاینت‌ها ----------

describe('supported-clients buttons — every client responds', () => {
    it('every client_ button (incl. names with spaces) sends its detail card', async () => {
        const { telegram, env } = await bootBot();
        const { clients } = await import('../src/settings/settings');

        for (const client of clients) {
            tgCalls = [];
            const res = await post(telegram, env, callbackUpdate(`client_${client.name}`));

            expect(res.status).toBe(200);
            const text = sentTexts().join('\n');
            expect(text, `client "${client.name}" produced no message`).toContain(client.name);
            expect(text).toContain('Get latest version');
        }
    });
});

// ---------- ۴) دکمه‌های تنظیمات ----------

describe('settings buttons — every field prompts and stores pending', () => {
    it('every set_ button opens a force-reply prompt and registers pending state', async () => {
        const { telegram, env, store } = await bootBot();
        const { resolveSettingsFieldFromBotText } = telegram;

        // هر ۱۸ فیلد از روی خود کیبورد استخراج می‌شود — نه لیست دستی
        await post(telegram, env, callbackUpdate('settings'));
        const settingsCall = tgCalls.find(c => c.method === 'sendMessage');
        expect(settingsCall, 'settings menu message was not sent').toBeTruthy();
        const actions: string[] = settingsCall!.body.reply_markup.inline_keyboard
            .flat().map((b: any) => b.callback_data).filter((a: string) => a.startsWith('set_'));

        for (const action of actions) {
            tgCalls = [];
            const field = action.slice(4);
            const res = await post(telegram, env, callbackUpdate(action));

            expect(res.status).toBe(200);
            expect(store.get(`tg-pending-${ADMIN_ID}`)).toBe(field);
            const prompt = sentTexts().join('\n');
            expect(prompt, `set_${field} produced no prompt`).toContain('Current');

            // هر پرامپت باید توسط resolveSettingsFieldFromBotText قابل‌تشخیص باشد
            const plainPrompt = prompt.replace(/<[^>]*>/g, '');
            expect(resolveSettingsFieldFromBotText(plainPrompt)).toBe(field);
        }
    });

    it('value applied via reply to bot prompt even when pending is absent (regression — dead reply path)', async () => {
        const { telegram, env, store } = await bootBot();

        // پرامپت بات — همان‌طور که تلگرام در reply_to_message تحویل می‌دهد: بدون تگ HTML
        await post(telegram, env, messageUpdate('1.1.1.1', {
            reply_to_message: {
                message_id: 42,
                from: { id: 123456, is_bot: true },
                chat: { id: ADMIN_ID, type: 'private' },
                text: '⚙️ 🌐 Local DNS\n\n📋 Current:\n8.8.8.8\n\n💬 Send new value:\nمثل: 8.8.8.8 یا 1.1.1.1'
            }
        }));

        expect(JSON.parse(store.get('proxySettings')!).localDNS).toBe('1.1.1.1');
        expect(sentTexts().join(' ')).toContain('updated');
    });

    it('value applied via plain message while pending is active', async () => {
        const { telegram, env, store } = await bootBot();

        await post(telegram, env, callbackUpdate('set_fingerprint'));
        await post(telegram, env, messageUpdate('safari'));

        expect(JSON.parse(store.get('proxySettings')!).fingerprint).toBe('safari');
    });

    it('invalid value → error message with Retry button (never silent)', async () => {
        const { telegram, env } = await bootBot();

        await post(telegram, env, callbackUpdate('set_localDNS'));
        tgCalls = [];
        await post(telegram, env, messageUpdate('not-an-ip'));

        expect(sentTexts().join(' ')).toContain('Error');
        const retry = tgCalls.find(c => c.body.reply_markup?.inline_keyboard?.flat().some((b: any) => b.callback_data === 'set_localDNS'));
        expect(retry).toBeTruthy();
    });
});

// ---------- ۵) کاربران — لیست، صفحه‌بندی، جزئیات، لینک‌ها ----------

describe('users buttons — list, pages, detail, links', () => {
    it('users list + pagination + detail + back all respond', async () => {
        const { telegram, env } = await bootBot();

        await post(telegram, env, callbackUpdate('users'));
        expect(sentTexts().join(' ')).toContain('Subscription Users');

        tgCalls = [];
        await post(telegram, env, callbackUpdate('users_page_2'));
        expect(sentTexts().length).toBeGreaterThan(0);

        tgCalls = [];
        await post(telegram, env, callbackUpdate('u_a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'));
        expect(sentTexts().join(' ')).toContain('Ali');

        tgCalls = [];
        await post(telegram, env, callbackUpdate('ulink_a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'));
        expect(sentTexts().join(' ')).toContain('sub/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d/normal');
    });

    it('hostile user name is HTML-escaped in links message (regression — parse error killed the button)', async () => {
        const { telegram, env } = await bootBot();

        const res = await post(telegram, env, callbackUpdate('ulink_f6a7b8c9-d0e1-4f2a-8b4c-5d6e7f8a9b0c'));
        expect(res.status).toBe(200);

        const text = sentTexts().join('\n');
        expect(text).toContain('Nazi &lt;script&gt;&amp;co');
        expect(text).not.toContain('Nazi <script>');
    });
});

// ---------- ۶) usage — رگرسیون‌های دکمه‌ی مرده ----------

describe('usage buttons — never silent', () => {
    it('zero totals (start of UTC day) still render the usage card (regression)', async () => {
        const { telegram, env } = await bootBot();
        usageStub = { total: 0, worker: 0 };

        await post(telegram, env, callbackUpdate('usage'));

        const text = sentTexts().join('\n');
        expect(text).toContain('Cloudflare Workers Usage');
        expect(text).toContain('0 / 100,000');
    });

    it('usage_refresh falls back to a fresh message when edit is rejected (regression)', async () => {
        const { telegram, env } = await bootBot();
        tgBehavior.editMessageText = () => ({ __raw: { ok: false, description: 'Bad Request: message is not modified' } });

        await post(telegram, env, callbackUpdate('usage_refresh', 77));

        expect(calledMethods()).toContain('editMessageText');
        expect(sentTexts().join('\n')).toContain('Cloudflare Workers Usage');
    });

    it('usage failure shows the error card with a Back button (never silent)', async () => {
        const { telegram, env } = await bootBot();
        // getCfWorkerUsage فقط وقتی fetch پرتاب شود شکست می‌خورد — GraphQL را خراب می‌کنیم
        vi.stubGlobal('fetch', vi.fn(async (input: any, init?: any) => {
            const url = String(input instanceof Request ? input.url : input);
            if (url.includes('api.telegram.org')) {
                const method = url.split('/').pop() || '';
                let body: any = {};
                try {
                    const rawBody = input instanceof Request ? await input.text() : init?.body;
                    body = rawBody ? JSON.parse(rawBody) : {};
                } catch { body = {}; }
                tgCalls.push({ method, body });
                return new Response(JSON.stringify({ ok: true, result: defaultTgResult(method) }), { status: 200 });
            }
            throw new Error('CF API unreachable');
        }) as any);

        await post(telegram, env, callbackUpdate('usage'));

        // v0.8.7: پیام خطا حالا قابل‌اقدام است و هرگز «صفرِ دروغین» نمی‌شود
        const errCall = tgCalls.find(c =>
            c.method === 'sendMessage' && String(c.body.text || '').includes('Usage analytics unavailable'));
        expect(errCall, 'usage failure message was not sent').toBeTruthy();
        const hasBack = errCall!.body.reply_markup?.inline_keyboard?.flat()
            .some((b: any) => b.callback_data === 'main');
        expect(hasBack, 'usage failure card must offer the Back button').toBe(true);
    });
});

// ---------- ۷) broadcast — جریان کامل ----------

describe('broadcast flow — prompt, preview, confirm, cancel', () => {
    it('confirm without pending → explicit warning (never silent)', async () => {
        const { telegram, env } = await bootBot();

        await post(telegram, env, callbackUpdate('broadcast_confirm'));
        expect(sentTexts().join(' ')).toContain('No pending broadcast');
    });

    it('full flow: prompt → text → preview → confirm → personalized fan-out + report', async () => {
        const { telegram, env } = await bootBot();

        await post(telegram, env, callbackUpdate('broadcast'));
        expect(sentTexts().join(' ')).toContain('Broadcast');

        await post(telegram, env, messageUpdate('Hello {name} — your link: {link}'));
        const preview = sentTexts().join('\n');
        expect(preview).toContain('Broadcast preview');
        expect(preview).toContain('Hello Admin');

        tgCalls = [];
        await post(telegram, env, callbackUpdate('broadcast_confirm'));

        // فن‌اوت: ادمین + کاربر لینک‌شده
        const fanout = tgCalls.filter(c => c.method === 'sendMessage' && c.body.chat_id === LINKED_CHAT);
        expect(fanout).toHaveLength(1);
        expect(fanout[0].body.text).toContain(`Hello Sara`);

        // گزارش نهایی روی همان پیام «در حال ارسال» edit می‌شود — نه پیام جدید
        const report = [
            ...sentTexts(),
            ...tgCalls.filter(c => c.method === 'editMessageText').map(c => String(c.body.text || ''))
        ].join('\n');
        expect(report).toContain('Broadcast complete');
        expect(report).toContain('Sent: <b>2</b>');
    });

    it('cancel clears pending and confirms', async () => {
        const { telegram, env } = await bootBot();

        await post(telegram, env, callbackUpdate('broadcast'));
        await post(telegram, env, messageUpdate('draft'));
        await post(telegram, env, callbackUpdate('broadcast_cancel'));

        expect(sentTexts().join(' ')).toContain('cancelled');

        tgCalls = [];
        await post(telegram, env, callbackUpdate('broadcast_confirm'));
        expect(sentTexts().join(' ')).toContain('No pending broadcast');
    });
});

// ---------- ۸) مقاومت وب‌هوک ----------

describe('webhook resilience', () => {
    it('wrong secret → ignored silently', async () => {
        const { telegram, env } = await bootBot();

        const res = await telegram.handleTelegramWebhook(new Request('https://panel.example.com/sp/telegram/webhook', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'wrong-secret' },
            body: JSON.stringify(callbackUpdate('status'))
        }), env);

        expect(res.status).toBe(200);
        expect(tgCalls).toHaveLength(0);
    });

    it('non-admin callback → ignored', async () => {
        const { telegram, env } = await bootBot();

        const res = await post(telegram, env, callbackUpdate('status', 100, 999));
        expect(res.status).toBe(200);
        expect(tgCalls).toHaveLength(0);
    });

    it('handler crash → 200 (no retry loop) + admin notified (never silent 500)', async () => {
        const { telegram, env } = await bootBot();
        tgBehavior.sendMessage = (_body, calls) => {
            // اولین sendMessage (خودِ status) شبکه‌اش پایین است؛
            // پیام «Action failed» بعدی باید برسد
            const sentSoFar = calls.filter(c => c.method === 'sendMessage').length;
            if (sentSoFar === 1) return 'THROW';
            return undefined;
        };

        const res = await post(telegram, env, callbackUpdate('status'));

        expect(res.status).toBe(200);
        expect(sentTexts().join(' ')).toContain('Action failed');
    });

    it('unknown callback data → 200, no crash (v0.8.10: explicit "Unknown option" reply)', async () => {
        const { telegram, env } = await bootBot();
        const res = await post(telegram, env, callbackUpdate('definitely-not-a-button'));
        expect(res.status).toBe(200);
        // فیکس Task 39: دیگر 200ِ بی‌صدا نیست — بازخورد صریح با منو
        expect(sentTexts().join(' ')).toContain('Unknown option');
    });

    it('malformed JSON body → 200, no crash', async () => {
        const { telegram, env } = await bootBot();
        const res = await telegram.handleTelegramWebhook(new Request('https://panel.example.com/sp/telegram/webhook', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': WH_SECRET },
            body: '{broken json'
        }), env);
        expect(res.status).toBe(200);
    });
});
