import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { gzipSync } from 'node:zlib';

/** PANEL_HTML_CONTENT یک global تزریق‌شده‌ی build است — در تست با gzip+base64 واقعی شبیه‌سازی می‌شود */
(globalThis as any).PANEL_HTML_CONTENT = gzipSync(
    Buffer.from('<!DOCTYPE html><html><head><title>Flash Panel Test</title></head><body><div id="app">panel-test-placeholder-content</div></body></html>')
).toString('base64');
(globalThis as any).ICON_CONTENT = 'data:image/svg+xml;base64,PHN2Zy8+';

/**
 * v0.8.67 — سه خواندن خام KVِ pwd در handlers/panel.ts از مسیر کش ۵ثانیه‌ای
 * getPwd (auth.ts) عبور کردند — همان قرارداد v0.8.37 (isTotpEnabled) و
 * v0.8.58 (stale-on-error).
 *
 * قبل: renderPanel (گیت احراز)، getPanelSettings (isPassSet) و getMyIP (گیت
 * احراز) هر کدام `env.kv.get('pwd')` خام می‌زدند — یعنی هر بارگذاری پنل سه
 * خواندن KV اضافه برای فیلدی که تقریباً هرگز عوض نمی‌شود، و روی قطعی گذرای
 * KVِ گرم، استثنای هندل‌نشده (1101) به‌جای stale-on-error.
 *
 * بعد: getPwd — کش ۵ثانیه‌ای + stale-on-error گرم. قرارداد invalidation از
 * قبل برقرار است: resetPassword کش را بلافاصله بعد از put به‌روز می‌کند، پس
 * پنجره‌ی «پنل باز پس از ست‌شدن پسورد» صفر می‌ماند و isPassSet بعد از setup
 * اولیه بلافاصله true دیده می‌شود.
 *
 * استراتژی RED: شمارش getهای KV روی کلید 'pwd'. روی کد قدیمی هر فراخوانی یک
 * خواندن تازه است؛ روی جدید فقط اولین فراخوانی هر پنجره‌ی ۵ثانیه‌ای.
 */

(globalThis as any).VERSION = '0.8.67';
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

// ماک ماژول‌های سنگین شبکه‌ای — موضوع تست KV/کش است نه دیپلوی/تلگرام/CF
vi.mock('@main', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
        ...actual,
        buildScript: async () => '',
        updateMainSettings: async () => ({})
    };
});

vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('unexpected fetch in test'))));

const HEALTHY_SEED: Record<string, string> = {
    warpAccounts: JSON.stringify([
        { privateKey: 'pk1', publicKey: 'pub1', warpIPv6: '2606:4700::1/128', reserved: 'AAAA' },
        { privateKey: 'pk2', publicKey: 'pub2', warpIPv6: '2606:4700::2/128', reserved: 'AAAB' }
    ]),
    telegramBot: JSON.stringify({ telegramBotToken: '', telegramUserId: '' })
};

/** KV ماک با شمارش get روی کلید دلخواه */
function createCountingKv(seed: Record<string, string> = {}, countKey = 'pwd') {
    const store = new Map<string, string>(Object.entries(seed));
    let countedGets = 0;
    const kv = {
        async get(key: string, opts?: { type?: string }) {
            if (key === countKey) countedGets++;
            const raw = store.get(key);
            if (raw === undefined) return null;
            return opts?.type === 'json' ? JSON.parse(raw) : raw;
        },
        async put(key: string, value: string) { store.set(key, value); },
        async delete(key: string) { store.delete(key); }
    } as unknown as KVNamespace;
    return {
        kv,
        store,
        getCount: () => countedGets,
        resetCount: () => { countedGets = 0; }
    };
}

describe('panel: خواندن pwd از کش ۵ثانیه‌ای getPwd (v0.8.67)', () => {
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
        import('../src/settings/store').then(m => m._resetStoreStateForTest());
        kvMod.invalidateDatasetCache();
    });

    afterEach(() => {
        kvMod.invalidateDatasetCache();
    });

    /** init + درایو هندلر — globals از درخواستِ init می‌آیند (الگوی panel-write-hardening) */
    async function drive(
        env: Env,
        path: string,
        options: { method?: string; body?: string } = {}
    ): Promise<Response> {
        const req = new Request(`https://example.com/sp/${path}`, {
            method: options.method ?? 'GET',
            headers: {
                'CF-Connecting-IP': '1.2.3.4',
                ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {})
            },
            ...(options.body !== undefined ? { body: options.body } : {})
        });
        settings.init(req, env);
        return panel.handlePanel(req, env);
    }

    it('🔴 getPanelSettings بدون احراز: دو فراخوانی پیاپی فقط یک خواندن pwd — isPassSet یکسان', async () => {
        const counted = createCountingKv({ pwd: 'TempProbe123', ...HEALTHY_SEED });
        const env = { kv: counted.kv } as any;

        const res1 = await drive(env, 'panel/settings');
        expect(res1.status).toBe(401);
        expect(((await res1.json()) as any).body.isPassSet).toBe(true);
        expect(counted.getCount()).toBe(1); // خواندن سرد — طبیعی

        counted.resetCount();
        const res2 = await drive(env, 'panel/settings');
        expect(res2.status).toBe(401);
        expect(((await res2.json()) as any).body.isPassSet).toBe(true);
        expect(counted.getCount()).toBe(0); // 🔴 روی قدیمی: 1 — خواندن خام دوم
    });

    it('🔴 renderPanel با pwd ست‌شده و بدون احراز: ریدایرکت 302 و فراخوانی دوم صفر خواندن pwd', async () => {
        const counted = createCountingKv({ pwd: 'TempProbe123', ...HEALTHY_SEED });
        const env = { kv: counted.kv } as any;

        const res1 = await drive(env, 'panel');
        expect(res1.status).toBe(302);
        expect(res1.headers.get('Location')).toBe('https://example.com/sp/login');
        expect(counted.getCount()).toBe(1);

        counted.resetCount();
        const res2 = await drive(env, 'panel');
        expect(res2.status).toBe(302);
        expect(counted.getCount()).toBe(0); // 🔴 روی قدیمی: 1
    });

    it('🔴 getMyIP با pwd ست‌شده و بدون احراز: 401 و فراخوانی دوم صفر خواندن pwd', async () => {
        const counted = createCountingKv({ pwd: 'TempProbe123', ...HEALTHY_SEED });
        const env = { kv: counted.kv } as any;

        const res1 = await drive(env, 'panel/my-ip', { method: 'POST', body: '8.8.8.8' });
        expect(res1.status).toBe(401);
        expect(counted.getCount()).toBe(1);

        counted.resetCount();
        const res2 = await drive(env, 'panel/my-ip', { method: 'POST', body: '8.8.8.8' });
        expect(res2.status).toBe(401);
        expect(counted.getCount()).toBe(0); // 🔴 روی قدیمی: 1
    });

    it('🟢 گارد — bootstrap: pwd ناموجود → isPassSet false؛ بعد از setup، بلافاصله true (بدون پنجره‌ی ۵ثانیه‌ای)', async () => {
        const counted = createCountingKv({ ...HEALTHY_SEED }); // pwd عمداً غایب
        const env = { kv: counted.kv } as any;

        const res1 = await drive(env, 'panel/settings');
        expect(res1.status).toBe(401);
        expect(((await res1.json()) as any).body.isPassSet).toBe(false);

        // setup اولیه — مسیر resetPassword بدون سشن (username = accEmail)
        const resSetup = await drive(env, 'panel/reset-password', {
            method: 'POST',
            body: JSON.stringify({ username: 'admin@example.com', password: 'NewPass123' })
        });
        expect(resSetup.status).toBe(200);

        // قرارداد invalidation: کش بلافاصله به‌روز شده — isPassSet بدون خواندن تازه true است
        counted.resetCount();
        const res2 = await drive(env, 'panel/settings');
        expect(res2.status).toBe(401);
        expect(((await res2.json()) as any).body.isPassSet).toBe(true);
        expect(counted.getCount()).toBe(0); // از کش همگام‌شده — نه KV
    });

    it('🟢 گارد — پنلِ بازِ bootstrap با pwd ناموجود سر جایش است (رفتار حفظ شده)', async () => {
        const counted = createCountingKv({ ...HEALTHY_SEED });
        const env = { kv: counted.kv } as any;

        // pwd unset → HTML پنل بدون احراز رندر می‌شود (جریان setup اولیه)
        const res = await drive(env, 'panel');
        expect(res.status).toBe(200);
        expect(await res.text()).toContain('panel-test-placeholder-content');
    });
});
