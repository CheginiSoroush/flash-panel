import { describe, it, expect, afterEach, vi } from 'vitest';

/**
 * v0.8.12 — خروج توکن CF API از سورس آپلودی (no-credentials-in-source)
 *
 * پیش‌زمینه: تا v0.8.11 توکن زنده‌ی CF داخل EMBEDED_SETTINGS (سورسِ ورکر آپلودی)
 * embed می‌شد — الگوی «credential in source» ماشه‌ی اسکنر CF شد و با گزارش abuse
 * اجرای کل ورکر بلاک شد (Task 48-51). این سوئیت قراردادهای v0.8.12 را قفل می‌کند:
 *
 *   ۱) loader (loadApiToken) توکن را از KV کلید cfApiToken به globals تزریق می‌کند
 *      و فیچرهای CF-API آن را می‌بینند — با کش ۵ ثانیه‌ای و failure-safe
 *   ۲) KV خالی/مفقود → توکن '' می‌ماند و ورودی‌های CF-API (usage / deploy / list)
 *      پیام صادق «not configured» می‌دهند — نه صفرِ دروغین، نه 401 مبهم
 *   ۳) embed همیشه apiToken:'' است — حتی وقتی توکن زنده در globals هست
 *   ۴) /cftoken ربات: ذخیره+verify (موفق)، رد غیرادمین، وضعیت ماسک‌شده، و
 *      شکست سقف KV با پیام «Save failed» — توکن کامل هرگز بازتاب نمی‌شود
 */

// ---------- ثابت‌های هارنس ----------

const CF_TOKEN_MSG =
    'CF API token is not configured — set it with /cftoken <token> in the Telegram bot';

const KV_TOKEN = 'KVToken-1234567890abcdef';

const BOT_TOKEN = '123456:TEST-TELEGRAM-TOKEN';
const ADMIN_ID = 111;

const WH_SECRET = [...new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(BOT_TOKEN))
)].slice(0, 24).map(b => b.toString(16).padStart(2, '0')).join('');

/** EMBEDED_SETTINGS در دنیای v0.8.12 — توکن همیشه خالی */
const BASE_EMBEDED = {
    accID: 'test-account',
    accEmail: 'test@example.com',
    apiToken: '',
    vlUUID: 'b831381d-6324-4d53-ad4f-8cda48b30811',
    trPass: 'test-pass',
    securePath: 'sp',
    mainDomain: 'panel.example.com',
    scriptName: 'flash-panel-test',
    proxyIpMode: 'proxyip',
    proxyIPs: [],
    prefixes: [],
    forceProxyDomains: [],
    fallback: '',
    dohUrl: ''
};

const QUOTA_ERROR = new Error('KV put() limit exceeded for the day.');

/** حداقل MainSettings برای buildEmbededSettings (بدون فیلدهای حذف‌شده) */
const MAIN_SETTINGS_FIXTURE = {
    vlUUID: 'b831381d-6324-4d53-ad4f-8cda48b30811',
    trPass: 'trojan-pass',
    securePath: 'sp',
    proxyIpMode: 'proxyip',
    proxyIPs: [],
    prefixes: [],
    forceProxyDomains: [],
    fallback: '',
    dohUrl: ''
};

// ---------- KV mock ها (هم‌الگوی tests/kv-store.test.ts) ----------

function createKvMock(seed: Record<string, unknown> = {}) {
    const store = new Map<string, string>(
        Object.entries(seed).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])
    );
    let putAttempts = 0;
    let getAttempts = 0;
    let getBehavior: () => void = () => { };

    const kv = {
        async get(key: string, opts?: { type?: string }) {
            getAttempts++;
            getBehavior();
            const raw = store.get(key);
            if (raw === undefined) return null;
            return opts?.type === 'json' ? JSON.parse(raw) : raw;
        },
        async put(key: string, value: string) {
            putAttempts++;
            store.set(key, value);
        },
        async delete(key: string) {
            store.delete(key);
        }
    } as unknown as KVNamespace;

    return {
        kv,
        store,
        getPutAttempts: () => putAttempts,
        getGetAttempts: () => getAttempts,
        failAllGets(error = 'KV backend unreachable') {
            getBehavior = () => { throw new Error(error); };
        }
    };
}

/** KV که put/delete هایش با سقف روزانه می‌میرند (429 زنده) — get ها سالم */
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

// ---------- boot ماژول‌ها (resetModules per test — هم‌الگوی telegram-resilience) ----------

interface BootOptions {
    kvSeed?: Record<string, unknown>;
    embededToken?: string;
    failGets?: boolean;
}

async function boot(opts: BootOptions = {}) {
    vi.resetModules();

    (globalThis as any).VERSION = '0.8.12';
    (globalThis as any).EMBEDED_SETTINGS = { ...BASE_EMBEDED, apiToken: opts.embededToken ?? '' };
    // buildScript محتواهای embed را در object literal ارزیابی می‌کند — باید موجود باشند
    (globalThis as any).PANEL_HTML_CONTENT = '';
    (globalThis as any).LOGIN_HTML_CONTENT = '';
    (globalThis as any).ERROR_HTML_CONTENT = '';
    (globalThis as any).PROXY_IP_HTML_CONTENT = '';
    (globalThis as any).CLEAN_IP_HTML_CONTENT = '';
    (globalThis as any).ICON_CONTENT = '';
    delete (globalThis as any).SOURCE_CONTENT;

    const kvBox = createKvMock(opts.kvSeed ?? {});
    if (opts.failGets) kvBox.failAllGets();

    fetchCalls = []; // هر boot رکوردر fetch تازه — بدون نشتی بین تست‌ها

    const settings = await import('../src/settings/settings');
    settings.init(new Request('https://panel.example.com/sp/panel'), { kv: kvBox.kv } as any);

    return { settings, kvBox };
}

// ---------- fetch recorder ----------

interface FetchCall { url: string; init?: any; }

let fetchCalls: FetchCall[] = [];
/** پاس /user/tokens/verify — 'active' | 'invalid' | 'throw' */
let cfVerifyMode: 'active' | 'invalid' | 'throw' = 'active';

function installFetchStub() {
    vi.stubGlobal('fetch', vi.fn(async (input: any, init?: any) => {
        const url = String(input instanceof Request ? input.url : input);
        fetchCalls.push({ url, init });

        // تلگرام — ثبت فراخوانی‌ها برای assert های پیام
        if (url.includes('api.telegram.org')) {
            let body: any = {};
            try {
                const rawBody = input instanceof Request ? await input.text() : init?.body;
                body = rawBody ? JSON.parse(rawBody) : {};
            } catch {
                body = {};
            }
            tgCalls.push({ method: url.split('/').pop() || '', body });
            return new Response(JSON.stringify({ ok: true, result: { message_id: 42, chat: { id: ADMIN_ID } } }),
                { status: 200, headers: { 'Content-Type': 'application/json' } });
        }

        if (url.includes('api.cloudflare.com/client/v4/user/tokens/verify')) {
            if (cfVerifyMode === 'throw') throw new Error('verify network down');
            if (cfVerifyMode === 'invalid') {
                return new Response(JSON.stringify({
                    success: false,
                    errors: [{ code: 1000, message: 'Invalid API Token' }],
                    result: null
                }), { status: 400, headers: { 'Content-Type': 'application/json' } });
            }
            return new Response(JSON.stringify({
                success: true,
                errors: [],
                result: { id: 'test-token-id', status: 'active' }
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }

        if (url.includes('api.cloudflare.com/client/v4/graphql')) {
            return new Response(JSON.stringify({
                data: {
                    viewer: {
                        accounts: [{
                            total: [{ sum: { requests: 10 } }],
                            worker: [{ sum: { requests: 4 } }]
                        }]
                    }
                }
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }

        // آینه‌های worker.js برای buildScript — باندل معتبرِ حداقلی (≥50KB + marker)
        if (url.includes('worker.js')) {
            const fakeBundle = `${'x'.repeat(60_000)}\nexport default {};`;
            return new Response(fakeBundle, { status: 200 });
        }

        return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as any);
}

afterEach(() => {
    delete (globalThis as any).EMBEDED_SETTINGS;
    delete (globalThis as any).VERSION;
    delete (globalThis as any).PANEL_HTML_CONTENT;
    delete (globalThis as any).LOGIN_HTML_CONTENT;
    delete (globalThis as any).ERROR_HTML_CONTENT;
    delete (globalThis as any).PROXY_IP_HTML_CONTENT;
    delete (globalThis as any).CLEAN_IP_HTML_CONTENT;
    delete (globalThis as any).ICON_CONTENT;
    delete (globalThis as any).SOURCE_CONTENT;
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

// ---------- ۱) loader — KV → globals → فیچرها ----------

describe('loadApiToken — KV-backed runtime token', () => {
    it('picks up the KV token into globals and CF-API features see it', async () => {
        installFetchStub();
        const { settings, kvBox } = await boot({ kvSeed: { cfApiToken: KV_TOKEN } });
        const env = { kv: kvBox.kv } as any;

        await settings.loadApiToken(env);

        expect(settings.getGlobals().apiToken).toBe(KV_TOKEN);

        // فیچر CF-API همان توکن را روی سیم می‌برد
        const usage = await import('../src/api/usage');
        const result = await usage.getCfWorkerUsage();

        expect(result.success).toBe(true);
        expect(result.total).toBe(10);
        const gql = fetchCalls.find(c => c.url.includes('/client/v4/graphql'));
        expect(gql, 'usage query was not sent').toBeTruthy();
        expect(gql!.init.headers.Authorization).toBe(`Bearer ${KV_TOKEN}`);
    });

    it('5s in-memory cache — repeated loads within TTL do not re-read KV', async () => {
        const { settings, kvBox } = await boot({ kvSeed: { cfApiToken: KV_TOKEN } });
        const env = { kv: kvBox.kv } as any;

        await settings.loadApiToken(env);
        const afterFirst = kvBox.getGetAttempts();

        await settings.loadApiToken(env);
        await settings.loadApiToken(env);

        expect(kvBox.getGetAttempts()).toBe(afterFirst);
        expect(settings.getGlobals().apiToken).toBe(KV_TOKEN);
    });

    it('KV failure is failure-safe — resolves, keeps the current token, never throws', async () => {
        installFetchStub();
        const { settings, kvBox } = await boot({ kvSeed: { cfApiToken: KV_TOKEN } });
        const env = { kv: kvBox.kv } as any;

        // بار اول توکن می‌نشیند
        await settings.loadApiToken(env);
        settings._resetApiTokenCacheForTest();

        // حالا KV می‌میرد — loader نباید throw کند و توکن باید بماند
        kvBox.failAllGets('KV backend unreachable');
        await expect(settings.loadApiToken(env)).resolves.toBeUndefined();
        expect(settings.getGlobals().apiToken).toBe(KV_TOKEN);
    });

    it('works without kv binding at all (never crashes boot)', async () => {
        const { settings } = await boot();
        await expect(settings.loadApiToken({} as any)).resolves.toBeUndefined();
        expect(settings.getGlobals().apiToken).toBe('');
    });
});

// ---------- ۲) degrade صادق — بدون توکن ----------

describe('no token configured — honest short-circuit', () => {
    it('missing KV key → token stays "" and guarded features refuse with the clear error', async () => {
        const { settings, kvBox } = await boot({ embededToken: '' });
        const env = { kv: kvBox.kv } as any;

        await settings.loadApiToken(env);
        expect(settings.getGlobals().apiToken).toBe('');

        // usage — نه صفرِ دروغین، نه 401 مبهم
        const usage = await import('../src/api/usage');
        const result = await usage.getCfWorkerUsage();
        expect(result.success).toBe(false);
        expect(result.error).toBe(CF_TOKEN_MSG);

        // deploy / list — پیام صادق، صفر درخواست به CF
        const workers = await import('../src/api/workers');
        await expect(workers.deployWorkers('const script = "x";')).rejects.toThrow(CF_TOKEN_MSG);
        await expect(workers.getWorkerDomains()).rejects.toThrow(CF_TOKEN_MSG);
        expect(fetchCalls.filter(c => c.url.includes('api.cloudflare.com'))).toHaveLength(0);
    });

    it('cron path: sampleUsageNow loads the KV token before sampling (records instead of skipping)', async () => {
        installFetchStub();
        const { kvBox } = await boot({ kvSeed: { cfApiToken: KV_TOKEN } });
        const env = { kv: kvBox.kv } as any;

        const usage = await import('../src/api/usage');
        await usage.sampleUsageNow(env);

        const stored = JSON.parse(kvBox.store.get('usageHistory')!);
        const today = new Date().toISOString().slice(0, 10);
        expect(stored[today]).toMatchObject({ date: today, total: 10, worker: 4 });
    });

    it('cron path with no token → no usage sample is written (no silent zeros)', async () => {
        installFetchStub();
        const { kvBox } = await boot({ embededToken: '' });
        const env = { kv: kvBox.kv } as any;

        const usage = await import('../src/api/usage');
        await usage.sampleUsageNow(env);

        expect(kvBox.store.has('usageHistory')).toBe(false);
        expect(fetchCalls.filter(c => c.url.includes('api.cloudflare.com'))).toHaveLength(0);
    });
});

// ---------- ۳) embed همیشه خالی ----------

describe('buildEmbededSettings / buildScript — no credentials in source', () => {
    it('embeds apiToken:"" even when a live token sits in globals', async () => {
        const { settings, kvBox } = await boot({ kvSeed: { cfApiToken: KV_TOKEN } });
        await settings.loadApiToken({ kv: kvBox.kv } as any);
        expect(settings.getGlobals().apiToken).toBe(KV_TOKEN); // پیش‌شرط

        const main = await import('../src/settings/main');
        const embeded = main.buildEmbededSettings(MAIN_SETTINGS_FIXTURE);

        expect(embeded.apiToken).toBe('');
        // بقیه‌ی فیلدهای embed دست‌نخورده‌اند (خارج از اسکوپ این نسخه)
        expect(embeded.vlUUID).toBe(MAIN_SETTINGS_FIXTURE.vlUUID);
        expect(embeded.trPass).toBe(MAIN_SETTINGS_FIXTURE.trPass);
        expect(embeded.securePath).toBe(MAIN_SETTINGS_FIXTURE.securePath);
    });

    it('buildScript output embeds apiToken:"" and never a real-looking token', async () => {
        installFetchStub();
        const { settings, kvBox } = await boot({ kvSeed: { cfApiToken: KV_TOKEN } });
        await settings.loadApiToken({ kv: kvBox.kv } as any);

        const main = await import('../src/settings/main');
        const script = await main.buildScript(true); // مسیر استاندارد = آینه‌ی گیت‌هاب

        expect(script).toContain('"apiToken":""');
        expect(script).not.toContain(KV_TOKEN);
        expect(script).not.toMatch(/cfut_[A-Za-z0-9]{10,}/);
        // آینه واقعاً مصرف شده (مسیر استاندارد)
        expect(fetchCalls.some(c => c.url.includes('worker.js'))).toBe(true);
    });
});

// ---------- ۴) /cftoken ربات ----------

// ---------- Telegram harness ----------

interface TgCall { method: string; body: any; }

let tgCalls: TgCall[] = [];

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

async function bootBot(opts: { kvSeed?: Record<string, unknown>; deadKv?: boolean; cfVerify?: 'active' | 'invalid' | 'throw' } = {}) {
    vi.resetModules();
    cfVerifyMode = opts.cfVerify ?? 'active';

    (globalThis as any).VERSION = '0.8.12';
    (globalThis as any).EMBEDED_SETTINGS = { ...BASE_EMBEDED, apiToken: '' };

    const seed = {
        proxySettings: { localDNS: '8.8.8.8', panelVersion: '0.8.12' },
        // v0.8.23: seed سالم — گارد ساختاری مرز لود آرایه‌ی خالی را به fetchWarpAccounts (شبکه) می‌فرستد
        warpAccounts: [
            { privateKey: 'k1', publicKey: 'K1', warpIPv6: '2606:4700::1/128', reserved: 'AAAA' },
            { privateKey: 'k2', publicKey: 'K2', warpIPv6: '2606:4700::2/128', reserved: 'BBBB' }
        ],
        telegramBot: { telegramBotToken: BOT_TOKEN, telegramUserId: String(ADMIN_ID) },
        ...opts.kvSeed
    };

    const kvBox = opts.deadKv ? createQuotaDeadKv(seed) : createKvMock(seed);

    installFetchStub();
    tgCalls = [];
    fetchCalls = [];

    const settings = await import('../src/settings/settings');
    settings.init(new Request('https://panel.example.com/sp/panel'), { kv: kvBox.kv } as any);

    const telegram = await import('../src/api/telegram');
    const env = { kv: kvBox.kv } as unknown as Env;
    return { settings, telegram, env, store: kvBox.store };
}

describe('/cftoken command (admin-only)', () => {
    it('saves the raw token to KV, refreshes the cache, and verifies with CF (never echoes the token)', async () => {
        const { settings, telegram, env, store } = await bootBot({});
        const value = 'TestToken-1234567890abcdef';

        const res = await post(telegram, env, messageUpdate(`/cftoken ${value}`));

        expect(res.status).toBe(200);
        expect(store.get('cfApiToken')).toBe(value); // raw string، بدون JSON

        // کش isolate فوراً تازه شده — فیچرها همین الان توکن را می‌بینند
        expect(settings.getGlobals().apiToken).toBe(value);

        const texts = sentTexts().join('\n');
        expect(texts).toContain('saved');
        expect(texts).toContain('CF says');
        expect(texts).toContain('active');
        // 🔒 توکن کامل هیچ‌وقت در پاسخ بازتاب نمی‌شود — فقط ماسک ۴ کاراکتر آخر
        expect(texts).not.toContain(value);
        expect(texts).toContain(`****${value.slice(-4)}`);

        const verify = fetchCalls.find(c => c.url.includes('/user/tokens/verify'));
        expect(verify, 'token was not verified with CF').toBeTruthy();
        expect(verify!.init.headers.Authorization).toBe(`Bearer ${value}`);
    });

    it('non-admin is rejected silently (same gate as every other command)', async () => {
        const { telegram, env, store } = await bootBot({});

        const res = await post(telegram, env, messageUpdate('/cftoken TestToken-1234567890abcdef', {}, 999));

        expect(res.status).toBe(200);
        expect(tgCalls).toHaveLength(0);
        expect(store.get('cfApiToken')).toBeUndefined();
        expect(fetchCalls.filter(c => c.url.includes('api.cloudflare.com'))).toHaveLength(0);
    });

    it('bare /cftoken shows masked status only (never the full token)', async () => {
        const { telegram, env } = await bootBot({ kvSeed: { cfApiToken: 'supersecrettokenabcd' } });

        const res = await post(telegram, env, messageUpdate('/cftoken'));

        expect(res.status).toBe(200);
        const texts = sentTexts().join('\n');
        expect(texts).toContain('****abcd');
        expect(texts).not.toContain('supersecrettokenabcd');
        expect(fetchCalls.filter(c => c.url.includes('api.cloudflare.com'))).toHaveLength(0);
    });

    it('bare /cftoken with nothing configured replies "not configured"', async () => {
        const { telegram, env } = await bootBot({});

        await post(telegram, env, messageUpdate('/cftoken'));

        expect(sentTexts().join('\n')).toContain('not configured');
    });

    it('KV-put failure under quota → honest "Save failed", no verify call, token not echoed', async () => {
        const { telegram, env, store } = await bootBot({ deadKv: true });
        const value = 'DeadQuotaToken-12345678';

        await post(telegram, env, messageUpdate(`/cftoken ${value}`));

        const texts = sentTexts().join('\n');
        expect(texts).toContain('Save failed');
        expect(texts).toContain('KV put() limit exceeded');
        expect(texts).not.toContain(value); // 🔒 حتی در خطا

        expect(store.get('cfApiToken')).toBeUndefined();
        expect(fetchCalls.filter(c => c.url.includes('/user/tokens/verify'))).toHaveLength(0);
    });

    it('CF verify failure is reported honestly (token still saved)', async () => {
        const { telegram, env, store } = await bootBot({ cfVerify: 'invalid' });
        const value = 'TestToken-1234567890abcdef';

        await post(telegram, env, messageUpdate(`/cftoken ${value}`));

        expect(store.get('cfApiToken')).toBe(value);
        const texts = sentTexts().join('\n');
        expect(texts).toContain('saved');
        expect(texts).toContain('Invalid API Token'); // خطای واقعی CF — صادق
        expect(texts).not.toContain(value);
    });
});
