import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

/**
 * v0.8.45 — سه سخت‌سازی مسیر نوشتن پنل (handlers/panel.ts):
 *
 * ۱) قرارداد کش دیتاست برای write مستقیم KV — بازیابی بکاپ با بخش بات،
 *    `env.kv.put('telegramBot', …)` می‌زد بدون `invalidateDatasetCache()`.
 *    telegramBot جزو Dataset است و هر نوشته‌ی مستقیم دیگر (updateWarpConfigs،
 *    api/telegram، موتور store) همین تعهد را دارد. پنجره‌ی خطا: یک getDataset
 *    هم‌ایزوله که بین commit تنظیمات و put بات پر شود، تا ۵ ثانیه (TTL کش)
 *    رباتِ پیش از بازیابی را سرو می‌کند — تست با قلاب put، همان پرشدنِ هم‌زمان
 *    را قطعی شبیه‌سازی می‌کند (مستقل از skip/put بودن commit تنظیمات).
 *
 * ۲) ثبت وب‌هوک تلگرام هنگام تغییر securePath best-effort نیست — تنظیمات
 *    همین‌جا ذخیره شده‌اند؛ یک خطای سمت تلگرام (API پایین/429) ذخیره‌ی موفق را
 *    500 کاذب می‌کرد. همان قرارداد مسیر بازیابی بکاپ («خطای تلگرام بازیابی را
 *    خراب نمی‌کند») به ذخیره‌ی عادی پنل هم تعمیم یافت.
 *
 * ۳) جست‌وجوی جغرافیای IP (getMyIP → ip-api.com) بدون سقف زمانی بود — همان
 *    کلاس v0.8.44 برای DoH: آپ‌استریمِ آویزان، درخواست ادمین را بی‌نهایت نگه
 *    می‌دارد. فیکس: AbortController با سقف ۵ث تولیدی + هُک تست.
 *
 * استراتژی RED: استاب fetch «خوب‌رفتار» که به AbortSignal گوش می‌دهد. روی کد
 * قدیمی تست ۳ هیچ‌وقت settle نمی‌شود (timeout قرمز)، تست ۱ ربات کهنه را
 * برمی‌گرداند و تست ۲ وضعیت 500 می‌گیرد.
 */

// ---------- globals — قبل از import پویا (الگوی dns-fetch-timeout.test) ----------
(globalThis as any).VERSION = '0.8.45';
(globalThis as any)._repo_ = 'https://github.com/CheginiSoroush/flash-panel';
(globalThis as any)._project_SM_ = 'flash';
(globalThis as any)._public_proxy_ip_ = 'bpb.yousef.isegaro.com';
(globalThis as any).EMBEDED_SETTINGS = {
    accID: 'test-account-id',
    accEmail: 'admin@example.com',
    apiToken: 'api-token',
    vlUUID: 'b831381d-6324-4d53-ad4f-8cda48b30811',
    trPass: 'trojan-pass',
    securePath: 'sp',
    proxyIpMode: 'public',
    proxyIPs: [] as string[],
    prefixes: [] as string[],
    mainDomain: 'example.com',
    fallback: '',
    dohUrl: ''
};

// ---------- ماک ماژول‌های شبکه‌ایِ سنگین ----------

// ذخیره‌ی پنل به‌طور عادی یک redeploy کامل می‌زند (updateMainSettings → deploy) —
// در این تست‌ها موضوع، رفتار KV/کش است نه دیپلوی. بقیه‌ی exportهای واقعی حفظ
// می‌شوند (kv.ts ست‌آپ `setCustomDomain` را از همین ماژول برمی‌دارد).
vi.mock('@main', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
        ...actual,
        buildScript: async () => '',
        updateMainSettings: async () => ({})
    };
});

const setTelegramBotMock = vi.fn(async () => {});
vi.mock('@api/telegram', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return { ...actual, setTelegramBot: (...args: unknown[]) => setTelegramBotMock(...(args as [])) };
});

// ---------- استاب fetch — ip-api با حالت ok/hang (حسی به AbortSignal) ----------

let ipApiMode: 'ok' | 'hang' = 'ok';
let unexpectedFetches: string[] = [];

vi.stubGlobal('fetch', vi.fn((input: any, init?: any) => {
    const url = String(input instanceof URL ? input : input?.url ?? input);

    if (url.includes('ip-api.com')) {
        if (ipApiMode === 'hang') {
            // fetch واقعی روی abort رد می‌شود — بدون signal هرگز settle نمی‌شود
            return new Promise((_, reject) => {
                init?.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')));
            });
        }
        return Promise.resolve(new Response(JSON.stringify({ status: 'success', country: 'Germany', query: '8.8.8.8' }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }

    unexpectedFetches.push(url);
    return Promise.reject(new Error(`unexpected fetch in test: ${url}`));
}));

// ---------- KV mock + seed ----------

const WARP_ACCOUNTS = [
    { privateKey: 'pk1', publicKey: 'pub1', warpIPv6: '2606:4700:110:8a36:df8e:6b81:5c05:1149', reserved: 'AAAA' },
    { privateKey: 'pk2', publicKey: 'pub2', warpIPv6: '2606:4700:110:8a36:df8e:6b81:5c05:1150', reserved: 'AAAB' }
];

function createKvMock(seed: Record<string, string> = {}, onPut?: (key: string, value: string) => Promise<void>) {
    const store = new Map<string, string>(Object.entries(seed));
    const kv = {
        async get(key: string, opts?: { type?: string }) {
            const raw = store.get(key);
            if (raw === undefined) return null;
            return opts?.type === 'json' ? JSON.parse(raw) : raw;
        },
        async put(key: string, value: string) {
            if (onPut) await onPut(key, value);
            store.set(key, value);
        },
        async delete(key: string) {
            store.delete(key);
        }
    } as unknown as KVNamespace;
    return { kv, store };
}

function seedBase(botToken = 'OLD-TOKEN'): Record<string, string> {
    return {
        pwd: 'TempProbe123',
        warpAccounts: JSON.stringify(WARP_ACCOUNTS),
        telegramBot: JSON.stringify({ telegramBotToken: botToken, telegramUserId: 'u1' })
    };
}

function makeBackup(bot: Record<string, string>): Record<string, unknown> {
    return {
        _meta: {
            app: 'flash-panel',
            kind: 'flash-panel-settings-backup',
            version: '0.8.45',
            exportedAt: new Date().toISOString(),
            includesSecrets: true,
            excludes: []
        },
        settings: {},           // بدون فیلد → merge روی مقادیر فعلی → بدون تغییر
        main: {
            // سکشن هویت — فیلدهایی که whitelist KV ندارد و فقط از main می‌آیند
            vlUUID: 'b831381d-6324-4d53-ad4f-8cda48b30811',
            trPass: 'trojan-pass',
            securePath: 'sp',
            proxyIpMode: 'public',
            proxyIPs: [],
            prefixes: [],
            fallback: '',
            dohUrl: ''
        },
        telegramBot: bot
        // subUsers عمداً غایب → parseImportedUsers(undefined) → null → skip
    };
}

describe('panel write-path hardening (v0.8.45)', () => {
    let panel: typeof import('../src/handlers/panel');
    let settings: typeof import('../src/settings/settings');
    let auth: typeof import('../src/auth/auth');
    let kvMod: typeof import('../src/settings/kv');

    beforeAll(async () => {
        settings = await import('../src/settings/settings');
        auth = await import('../src/auth/auth');
        kvMod = await import('../src/settings/kv');
        panel = await import('../src/handlers/panel');
    });

    beforeEach(() => {
        auth._resetAuthStateForTest();
        (kvMod as any)._resetMigrationThrottleForTest?.();
        // صف نوشتن store و sub-users بین تست‌ها صفر شود
        import('../src/settings/store').then(m => m._resetStoreStateForTest());
        import('../src/settings/sub-users').then(m => m._resetSubUsersWriteQueueForTest());
        ipApiMode = 'ok';
        unexpectedFetches = [];
        setTelegramBotMock.mockClear();
    });

    afterEach(async () => {
        (panel as any)._setMyIpFetchTimeoutForTest?.(5_000);
        kvMod.invalidateDatasetCache();
    });

    /** init + لاگین واقعی → کوکی معتبر (init با درخواستِ لاگین — برای accEmail) */
    async function login(store: Map<string, string>): Promise<string> {
        const loginReq = new Request('https://example.com/sp/login/authenticate', {
            method: 'POST',
            headers: { 'CF-Connecting-IP': '1.2.3.4', 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'admin@example.com', password: 'TempProbe123' })
        });
        settings.init(loginReq, { kv: { get: async (k: string, o?: any) => {
            const raw = store.get(k);
            return raw === undefined ? null : (o?.type === 'json' ? JSON.parse(raw) : raw);
        }, put: async (k: string, v: string) => { store.set(k, v); }, delete: async (k: string) => { store.delete(k); } } } as Env);
        const res = await auth.generateJWTToken(loginReq, { kv: { get: async (k: string, o?: any) => {
            const raw = store.get(k);
            return raw === undefined ? null : (o?.type === 'json' ? JSON.parse(raw) : raw);
        }, put: async (k: string, v: string) => { store.set(k, v); }, delete: async (k: string) => { store.delete(k); } } } as Env);
        expect(res.status).toBe(200);
        return (res.headers.get('Set-Cookie') || '').match(/jwtToken=([^;]*)/)?.[1] ?? '';
    }

    /**
     * درایو هندلر — globals از درخواستِ init می‌آیند، پس init و handlePanel
     * باید «همان URL» را ببینند (الگوی panel-token-scope.test).
     */
    async function drive(
        env: Env,
        path: string,
        options: { method?: string; body?: string; cookie?: string } = {}
    ): Promise<Response> {
        const req = new Request(`https://example.com/sp/${path}`, {
            method: options.method ?? 'GET',
            headers: {
                'CF-Connecting-IP': '1.2.3.4',
                ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
                ...(options.cookie ? { Cookie: `jwtToken=${options.cookie}` } : {})
            },
            ...(options.body !== undefined ? { body: options.body } : {})
        });
        settings.init(req, env);
        return panel.handlePanel(req, env);
    }

    it('1 — backup import with a bot section invalidates the dataset cache (direct-KV-write contract)', async () => {
        const { kv, store } = createKvMock(seedBase(), async (key) => {
            // شبیه‌سازی قطعیِ پرشدن هم‌زمان: درخواست دیگری دقیقاً در پنجره‌ی
            // میان commit تنظیمات و put بات، کش دیتاست را پر می‌کند.
            if (key === 'telegramBot') await kvMod.getDataset({ kv } as Env);
        });
        const env = { kv } as Env;
        const cookie = await login(store);

        // کش با باتِ کهنه گرم می‌شود
        const before = await kvMod.getDataset(env);
        expect(before.telegramBot.telegramBotToken).toBe('OLD-TOKEN');

        const res = await drive(env, 'panel/settings/import', {
            method: 'POST',
            cookie,
            body: JSON.stringify(makeBackup({ telegramBotToken: 'NEW-TOKEN', telegramUserId: 'u1' }))
        });
        expect(res.status).toBe(200);
        expect(unexpectedFetches).toEqual([]);

        const after = await kvMod.getDataset(env);
        expect(after.telegramBot.telegramBotToken).toBe('NEW-TOKEN');
    });

    it('2 — settings save succeeds even when the Telegram webhook re-registration fails', async () => {
        const { kv, store } = createKvMock(seedBase());
        const env = { kv } as Env;
        const cookie = await login(store);

        setTelegramBotMock.mockRejectedValueOnce(new Error('telegram api down (502)'));

        // prime کش دیتاست — مثل دنیای واقعی که پنل قبل از ذخیره لود شده
        // (وگرنه current=null و کال‌بک customDomain به CF-API می‌زند)
        await kvMod.getDataset(env);

        const payload = {
            ...settings.getDefaultKvSettings(),
            ...settings.getMainSettings(),   // فیلدهای هویتی (proxyIPs/…) که UI هم می‌فرستد
            securePath: 'sp2'
        };
        const res = await drive(env, 'panel/update-settings', {
            method: 'PUT',
            cookie,
            body: JSON.stringify(payload)
        });

        // تنظیمات ذخیره شده‌اند — خطای تلگرام نباید 500 کاذب بسازد (کد قدیمی: 500)
        expect(res.status).toBe(200);
        expect(setTelegramBotMock).toHaveBeenCalledTimes(1);
        expect(setTelegramBotMock.mock.calls[0][0]).toBe('sp2');
        expect(setTelegramBotMock.mock.calls[0][1]).toBe('OLD-TOKEN');
        // blob تنظیمات واقعاً نوشته شده (ذخیره موفق، مستقل از وضعیت وب‌هوک)
        expect(store.has('proxySettings')).toBe(true);
    });

    it('3a — my-ip lookup returns 200 on a healthy upstream', async () => {
        const { kv, store } = createKvMock(seedBase());
        const env = { kv } as Env;
        const cookie = await login(store);

        const res = await drive(env, 'panel/my-ip', { method: 'POST', cookie, body: '8.8.8.8' });

        expect(res.status).toBe(200);
        const body = await res.json() as any;
        expect(body?.body?.country ?? body?.country).toBe('Germany');
    });

    it('3b — my-ip lookup cannot hang past the bounded timeout (old code: test times out)', async () => {
        (panel as any)._setMyIpFetchTimeoutForTest(80); // سقف تستی — در تولید ۵ ثانیه
        const { kv, store } = createKvMock(seedBase());
        const env = { kv } as Env;
        const cookie = await login(store);

        ipApiMode = 'hang';
        const res = await drive(env, 'panel/my-ip', { method: 'POST', cookie, body: '8.8.8.8' });

        // کد قدیمی: fetch آویزان → این expect هرگز اجرا نمی‌شود (timeout قرمز)
        expect(res.status).toBe(500);
    });
});
