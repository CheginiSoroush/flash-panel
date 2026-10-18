/**
 * v0.8.10 — مقاومت ربات تلگرام زیر سقف مرده‌ی KV (Task 39)
 *
 * وضعیت زنده: سهمیه‌ی ۱٬۰۰۰ put/روز KV رایگان تمام شده (429 تا 2026-10-19 UTC) —
 * این سوئیت تضمین می‌کند در همان وضعیت:
 *   ۱) پرامپت تنظیمات و broadcast باز می‌شوند (setPending/clearPending best-effort)
 *      و پرامپت hint آفلاین دارد؛ reply به پرامپت هم بدون pending کار می‌کند
 *   ۲) کرش شاخه‌ی main → «⚠️ Action failed» (دیگر از catch بی‌صدای بیرونی عبور نمی‌کند)
 *   ۳) دستور /usage همان رندر دکمه را دارد — صفر = کارت، شکست = کارت خطا (هرگز بی‌صدا)
 *   ۴) callback ناشناخته و دکمه‌ی رجیستر-کهنه → پیام صریح + منو (نه سکوت)
 *   ۵) شکست answerCallbackQuery dispatch را نمی‌کشد
 *   ۶) هشدار usage: cooldown ساعتی در حافظه (صفر KV) + بدون تکرار بعد از دکمه‌های usage
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

(globalThis as any).VERSION = '0.8.10';

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
    { id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', name: 'Ali', active: true, fetchCount: 12 },
    { id: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', name: 'Sara', active: true, fetchCount: 5, telegramChatId: String(LINKED_CHAT) }
];

const QUOTA_ERROR = new Error('KV put() limit exceeded for the day.');

// ---------- KV mock ها ----------

function createKvMock(seed: Record<string, unknown> = {}) {
    const store = new Map<string, string>();
    for (const [k, v] of Object.entries(seed)) {
        store.set(k, typeof v === 'string' ? v : JSON.stringify(v));
    }
    let writeAttempts = 0;
    return {
        kv: {
            async get(key: string, opts?: { type?: string }) {
                const raw = store.get(key);
                if (raw === undefined) return null;
                return opts?.type === 'json' ? JSON.parse(raw) : raw;
            },
            async put(key: string, value: string) { writeAttempts++; store.set(key, value); },
            async delete(key: string) { writeAttempts++; store.delete(key); }
        } as unknown as KVNamespace,
        store,
        writeCounter: () => writeAttempts
    };
}

/** KV که get هایش کار می‌کند ولی put/delete هایش با سقف روزانه می‌میرند (429 زنده) */
function createQuotaDeadKv(seed: Record<string, unknown> = {}) {
    const store = new Map<string, string>();
    for (const [k, v] of Object.entries(seed)) {
        store.set(k, typeof v === 'string' ? v : JSON.stringify(v));
    }
    let putAttempts = 0;
    return {
        kv: {
            async get(key: string, opts?: { type?: string }) {
                const raw = store.get(key);
                if (raw === undefined) return null;
                return opts?.type === 'json' ? JSON.parse(raw) : raw;
            },
            async put() {
                putAttempts++;
                throw QUOTA_ERROR;
            },
            async delete() {
                putAttempts++;
                throw QUOTA_ERROR;
            }
        } as unknown as KVNamespace,
        store,
        putCounter: () => putAttempts
    };
}

// ---------- Telegram/CF fetch recorder ----------

interface TgCall { method: string; body: any; }

let tgCalls: TgCall[] = [];
let tgBehavior: Partial<Record<string, (body: any, calls: TgCall[]) => unknown>> = {};
let usageStub = { total: 4200, worker: 1700 };

function defaultTgResult(method: string) {
    if (method === 'getMe') return { id: 123456, is_bot: true, username: 'test_bot' };
    return { message_id: 42, chat: { id: ADMIN_ID } };
}

function installFetchStub(opts: { cfFail?: boolean } = {}) {
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

        // شبیه‌سازی API کلادفلر مرده (پشت فیلترینگ/ creds رد شده)
        if (opts.cfFail) throw new Error('CF API unreachable');

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

async function bootBot(opts: { deadKv?: boolean; cfFail?: boolean; usage?: { total: number; worker: number } } = {}) {
    vi.resetModules();
    (globalThis as any).EMBEDED_SETTINGS = { ...BASE_EMBEDED };

    const settings = await import('../src/settings/settings');
    settings.init(new Request('https://panel.example.com/sp/anything'), {} as Env);

    const seed = {
        proxySettings: { ...settings.getKvSettings(), panelVersion: (globalThis as any).VERSION },
        warpAccounts: [],
        telegramBot: { telegramBotToken: BOT_TOKEN, telegramUserId: String(ADMIN_ID) },
        subUsers: SUB_USERS
    };

    const kvBox = opts.deadKv ? createQuotaDeadKv(seed) : createKvMock(seed);

    installFetchStub({ cfFail: opts.cfFail });
    tgCalls = [];
    tgBehavior = {};
    usageStub = opts.usage ?? { total: 4200, worker: 1700 };

    const telegram = await import('../src/api/telegram');
    const env = { kv: kvBox.kv } as unknown as Env;
    return { telegram, env, store: kvBox.store, putCounter: kvBox.putCounter };
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

// ---------- ۱) سهمیه‌ی مرده‌ی KV — پرامپت‌ها باید باز شوند ----------

describe('quota-dead KV (live 429) — prompts must still open', () => {
    it('set_ prompt opens with force_reply + offline hint when kv.put always throws', async () => {
        const { telegram, env, store, putCounter } = await bootBot({ deadKv: true });

        const res = await post(telegram, env, callbackUpdate('set_localDNS'));

        expect(res.status).toBe(200);
        const prompt = tgCalls.find(c => c.method === 'sendMessage');
        expect(prompt, 'settings prompt was not sent under dead KV').toBeTruthy();
        expect(String(prompt!.body.text)).toContain('Current');
        expect(String(prompt!.body.text)).toContain('(offline — reply to this message)');
        expect(prompt!.body.reply_markup).toEqual({ force_reply: true, selective: true });

        // put واقعا تلاش شده و 429 خورده — pending در KV نیست
        expect(putCounter()).toBeGreaterThan(0);
        expect(store.get(`tg-pending-${ADMIN_ID}`)).toBeUndefined();

        // پرامپت آفلاین همچنان توسط resolveSettingsFieldFromBotText قابل‌تشخیص است
        const plainPrompt = sentTexts().join('\n').replace(/<[^>]*>/g, '');
        expect(telegram.resolveSettingsFieldFromBotText(plainPrompt)).toBe('localDNS');
    });

    it('reply to the offline prompt is recognized and the save fails LOUDLY (strict explicit save intact)', async () => {
        const { telegram, env } = await bootBot({ deadKv: true });

        // پرامپت بات — همان‌طور که تلگرام در reply_to_message تحویل می‌دهد: بدون تگ HTML
        const res = await post(telegram, env, messageUpdate('1.1.1.1', {
            reply_to_message: {
                message_id: 42,
                from: { id: 123456, is_bot: true },
                chat: { id: ADMIN_ID, type: 'private' },
                text: '⚙️ 🌐 Local DNS\n\n📋 Current:\n8.8.8.8\n\n💬 Send new value:\nمثل: 8.8.8.8 یا 1.1.1.1\n(offline — reply to this message)'
            }
        }));

        expect(res.status).toBe(200);
        // ذخیره‌ی صریح ادمین strict می‌ماند (فیکس v0.8.9) — شکست با پیام، نه سکوت
        expect(sentTexts().join(' ')).toContain('Save failed');
        expect(sentTexts().join(' ')).toContain('KV put() limit exceeded');
    });

    it('broadcast prompt opens with offline hint when kv.put always throws', async () => {
        const { telegram, env, putCounter } = await bootBot({ deadKv: true });

        const res = await post(telegram, env, callbackUpdate('broadcast'));

        expect(res.status).toBe(200);
        const prompt = tgCalls.find(c => c.method === 'sendMessage');
        expect(prompt, 'broadcast prompt was not sent under dead KV').toBeTruthy();
        expect(String(prompt!.body.text)).toContain('Broadcast');
        expect(String(prompt!.body.text)).toContain('(offline — reply to this message)');
        expect(prompt!.body.reply_markup?.force_reply).toBe(true);
        expect(putCounter()).toBeGreaterThan(0);
        expect(calledMethods()).toContain('answerCallbackQuery');
    });

    it('offline broadcast: reply to the prompt still produces the preview (Send/Cancel buttons)', async () => {
        const { telegram, env } = await bootBot({ deadKv: true });

        // پرامپت با pending مرده باز شده؛ ادمین به همان پیام reply می‌کند
        const res = await post(telegram, env, messageUpdate('Hello {name}', {
            reply_to_message: {
                message_id: 42,
                from: { id: 123456, is_bot: true },
                chat: { id: ADMIN_ID, type: 'private' },
                text: '📢 Broadcast\n━━━━━━━━━━━━━━━━\n👥 Recipients: 2 (admin + Telegram-linked users)\n\n💬 Send the message to broadcast now.\n\nSend /settings or tap a menu button to cancel.\n(offline — reply to this message)'
            }
        }));

        expect(res.status).toBe(200);
        const preview = sentTexts().join('\n');
        expect(preview, 'offline broadcast reply produced no preview').toContain('Broadcast preview');
        expect(preview).toContain('Hello Admin');

        const confirmBtn = tgCalls.find(c =>
            c.body.reply_markup?.inline_keyboard?.flat().some((b: any) => b.callback_data === 'broadcast_confirm'));
        expect(confirmBtn, 'preview must carry the confirm button').toBeTruthy();
    });
});

// ---------- ۲) شاخه‌ی main — داخل همان try پیام‌دار ----------

describe('main callback — guarded like every other button', () => {
    it('crash in the main renderer → "⚠️ Action failed" (was: silent 200 via outer catch)', async () => {
        const { telegram, env } = await bootBot();
        tgBehavior.sendMessage = (_body, calls) => {
            // اولین sendMessage (خودِ منوی main) شبکه‌اش پایین است؛
            // پیام «Action failed» بعدی باید برسد
            const sentSoFar = calls.filter(c => c.method === 'sendMessage').length;
            if (sentSoFar === 1) return 'THROW';
            return undefined;
        };

        const res = await post(telegram, env, callbackUpdate('main'));

        expect(res.status).toBe(200);
        expect(sentTexts().join(' ')).toContain('Action failed');
    });
});

// ---------- ۳) دستور /usage — همان رندر دکمه ----------

describe('/usage command — same renderer as the Usage button (never silent)', () => {
    it('zero data (start of UTC day) still renders the card (was: silent break)', async () => {
        const { telegram, env } = await bootBot({ usage: { total: 0, worker: 0 } });

        const res = await post(telegram, env, messageUpdate('/usage'));

        expect(res.status).toBe(200);
        const text = sentTexts().join('\n');
        expect(text).toContain('Cloudflare Workers Usage');
        expect(text).toContain('0 / 100,000');

        const card = tgCalls.find(c => String(c.body.text || '').includes('Cloudflare Workers Usage'));
        const refresh = card!.body.reply_markup?.inline_keyboard?.flat()
            .some((b: any) => b.callback_data === 'usage_refresh');
        expect(refresh, 'usage card must carry the Refresh button').toBe(true);
    });

    it('failure renders the error card with a Back button (was: silent break)', async () => {
        const { telegram, env } = await bootBot({ cfFail: true });

        const res = await post(telegram, env, messageUpdate('/usage'));

        expect(res.status).toBe(200);
        const errCall = tgCalls.find(c =>
            c.method === 'sendMessage' && String(c.body.text || '').includes('Usage analytics unavailable'));
        expect(errCall, 'usage failure message was not sent').toBeTruthy();

        const hasBack = errCall!.body.reply_markup?.inline_keyboard?.flat()
            .some((b: any) => b.callback_data === 'main');
        expect(hasBack, 'usage failure card must offer the Back button').toBe(true);
    });
});

// ---------- ۴) callback ناشناخته / رجیستر کهنه — بازخورد صریح ----------

describe('unknown + stale callbacks — explicit feedback instead of silence', () => {
    it('unknown callback_data → "Unknown option" reply with the main menu (was: silent 200)', async () => {
        const { telegram, env } = await bootBot();

        const res = await post(telegram, env, callbackUpdate('definitely-not-a-button'));

        expect(res.status).toBe(200);
        const msg = tgCalls.find(c => c.method === 'sendMessage');
        expect(msg, 'unknown callback produced no reply').toBeTruthy();
        expect(String(msg!.body.text)).toContain('Unknown option');
        const actions = msg!.body.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data);
        expect(actions).toContain('sub'); // mainKeyboard همراه پیام است
    });

    it('stale registry hits (set_/sub_/client_ with unknown ids) → "no longer available" + menu', async () => {
        const { telegram, env } = await bootBot();

        for (const data of ['set_removedField', 'sub_removed', 'client_Ghost Client']) {
            tgCalls = [];
            const res = await post(telegram, env, callbackUpdate(data));

            expect(res.status).toBe(200);
            const msg = tgCalls.find(c => c.method === 'sendMessage');
            expect(msg, `${data} produced no reply`).toBeTruthy();
            expect(String(msg!.body.text)).toContain('no longer available');
            const actions = msg!.body.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data);
            expect(actions).toContain('sub'); // mainKeyboard
        }
    });
});

// ---------- ۵) answerCallbackQuery نباید dispatch را بکشد ----------

describe('answerCallbackQuery failure — dispatch must survive', () => {
    it('answerCallbackQuery throwing → button still handled (status card arrives)', async () => {
        const { telegram, env } = await bootBot();
        tgBehavior.answerCallbackQuery = () => 'THROW';

        const res = await post(telegram, env, callbackUpdate('status'));

        expect(res.status).toBe(200);
        expect(calledMethods()).toContain('answerCallbackQuery');
        expect(sentTexts().join(' ')).toContain('Flash Panel Status');
    });
});

// ---------- ۶) هشدار usage — cooldown حافظه‌ای + بدون تکرار بعد از usage ----------

describe('usage warning — per-chat in-memory cooldown (zero KV)', () => {
    it('no duplicate warning card right after usage/usage_refresh callbacks', async () => {
        const { telegram, env } = await bootBot({ usage: { total: 90_000, worker: 40_000 } });

        await post(telegram, env, callbackUpdate('usage'));

        const usageMsgs = tgCalls.filter(c =>
            c.method === 'sendMessage' && String(c.body.text).includes('Cloudflare Workers Usage'));
        // فقط کارت usage — کارت هشدارِ تکراری نه (قبلاً دو پیام پشت‌هم می‌رفت)
        expect(usageMsgs).toHaveLength(1);
    });

    it('warning fires once per hour per chat; skipped after the /usage command too', async () => {
        const { telegram, env } = await bootBot({ usage: { total: 90_000, worker: 40_000 } });

        await post(telegram, env, callbackUpdate('status'));
        expect(sentTexts().join(' ')).toContain('Flash Panel Status');
        expect(sentTexts().join(' ')).toContain('WARNING'); // اولین هشدار رسید

        tgCalls = [];
        await post(telegram, env, callbackUpdate('status'));
        expect(sentTexts().join(' ')).not.toContain('WARNING'); // cooldown — تکرار نه

        tgCalls = [];
        await post(telegram, env, messageUpdate('/usage'));
        const msgs = tgCalls.filter(c => c.method === 'sendMessage');
        expect(msgs).toHaveLength(1); // فقط کارت usage — بدون پیام هشدار دوم
        expect(String(msgs[0].body.text)).toContain('Cloudflare Workers Usage');
    });
});
