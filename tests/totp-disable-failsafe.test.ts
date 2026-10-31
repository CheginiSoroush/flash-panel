import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

/**
 * v0.8.56 — ترتیب حذف fail-safe در disableTotp (handlers/panel.ts)
 *
 * کلاس باگ: disableTotp چهار کلید TOTP را در Promise.all با ترتیب دلخواه پاک
 * می‌کرد. جریان لاگین (auth.ts) روی وضعیت «totpEnabled=true + totpSecret غایب»
 * fail-closed است («2FA verification code required») و بازیابی هم خودش لاگین
 * می‌خواهد — پس شکست جزئیِ KV که totpSecret را پاک کند و totpEnabled را نگه
 * دارد = قفل‌شدن کامل ادمین از پنل (ساب‌ها سالم می‌مانند). پنجره‌ی دوم: اگر
 * هر حذفی شکست بخورد invalidateTotpCache اجرا نمی‌شد و کش ۱۵ثانیه‌ای «فعال»
 * با KV خاموش می‌ماند — همین قفل، اما ۱۵ثانیه‌ای.
 *
 * فیکس: اول totpEnabled (شکستش → 500 صادق + وضعیت دست‌نخورده → retry)؛ بعد
 * بقیه best-effort؛ کش همان‌جا که enabled واقعاً پاک شد خاموش می‌شود.
 *
 * پوشش این فایل:
 *   ۱) 🔒 شکست حذف totpEnabled → وضعیت کامل حفظ می‌شود (قفل‌شدن اتفاق نمی‌افتد) — RED روی قدیمی
 *   ۲) 🔒 شکست حذف کلید جانبی (totpLastUsed) → غیرفعال‌سازی موفق + کش فوراً خاموش — RED روی قدیمی
 *   ۳) گارد: مسیر سالم → هر ۴ کلید پاک + کش خاموش (هر دو کد سبز)
 *
 * کد TOTP با همان ساعت واقعی محاسبه می‌شود؛ پنجره‌ی drift ±1 هر عبور مرز گام
 * ۳۰ثانیه‌ای را پوشش می‌دهد → تست بدون فلیک.
 */

(globalThis as any).VERSION = '0.8.56';
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

function createKvMock(seed: Record<string, string> = {}, failDeletes: Set<string> = new Set()) {
    const store = new Map<string, string>(Object.entries(seed));
    const kv = {
        async get(key: string, opts?: { type?: string }) {
            const raw = store.get(key);
            if (raw === undefined) return null;
            return opts?.type === 'json' ? JSON.parse(raw) : raw;
        },
        async put(key: string, value: string) {
            store.set(key, value);
        },
        async delete(key: string) {
            if (failDeletes.has(key)) {
                throw new Error(`kv delete outage on ${key}`);
            }
            store.delete(key);
        }
    } as unknown as KVNamespace;
    return { kv, store };
}

describe('disableTotp fail-safe ordering (v0.8.56)', () => {
    let panel: typeof import('../src/handlers/panel');
    let settings: typeof import('../src/settings/settings');
    let auth: typeof import('../src/auth/auth');
    let totp: typeof import('../src/auth/totp');

    const TOTP_SECRET = 'JBSWY3DPEHPK3PXP'; // base32 معتبر — برای وریفای کد

    beforeAll(async () => {
        settings = await import('../src/settings/settings');
        auth = await import('../src/auth/auth');
        totp = await import('../src/auth/totp');
        panel = await import('../src/handlers/panel');
    });

    beforeEach(() => {
        auth._resetAuthStateForTest();
    });

    /** لاگین واقعی (2FA هنوز خاموش) → کوکی معتبر؛ بعد کلیدهای 2FA دستی سید می‌شوند */
    async function login(store: Map<string, string>, env: Env): Promise<string> {
        const loginReq = new Request('https://example.com/sp/login/authenticate', {
            method: 'POST',
            headers: { 'CF-Connecting-IP': '1.2.3.4', 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'admin@example.com', password: 'TempProbe123' })
        });
        settings.init(loginReq, env);
        const res = await auth.generateJWTToken(loginReq, env);
        expect(res.status).toBe(200);
        void store;
        return (res.headers.get('Set-Cookie') || '').match(/jwtToken=([^;]*)/)?.[1] ?? '';
    }

    async function seedTotpOn(store: Map<string, string>): Promise<string> {
        store.set('totpEnabled', 'true');
        store.set('totpSecret', TOTP_SECRET);
        store.set('totpLastUsed', '0');
        return totp.totp(TOTP_SECRET);
    }

    async function drive(
        env: Env,
        cookie: string,
        code: string
    ): Promise<Response> {
        const req = new Request('https://example.com/sp/panel/totp/disable', {
            method: 'POST',
            headers: {
                'CF-Connecting-IP': '1.2.3.4',
                'Content-Type': 'application/json',
                ...(cookie ? { Cookie: `jwtToken=${cookie}` } : {})
            },
            body: JSON.stringify({ code })
        });
        settings.init(req, env);
        return panel.handlePanel(req, env);
    }

    it('🔒 شکست حذف totpEnabled → وضعیت کامل حفظ می‌شود و پاسخ retry می‌خواهد (قفل‌شدن رخ نمی‌دهد)', async () => {
        const gated = new Set(['totpEnabled']);
        const { kv, store } = createKvMock({ pwd: 'TempProbe123' }, gated);
        const env = { kv } as unknown as Env;

        const cookie = await login(store, env);
        const code = await seedTotpOn(store);
        // کش ۱۵ثانیه‌ای در زمانِ لاگین (قبل از سید) false شده — با همان هُک
        // invalidation که خود disable استفاده می‌کند هم‌تراز وضعیت واقعی می‌کنیم
        auth.invalidateTotpCache(true);

        const res = await drive(env, cookie, code);
        expect(res.status).toBe(500);

        // قرارداد fail-safe: هیچ کلیدی پاک نشده — 2FA کامل روشن با secret سالم
        expect(store.get('totpEnabled')).toBe('true');
        expect(store.get('totpSecret')).toBe(TOTP_SECRET);
        expect(store.get('totpLastUsed')).toBe('0');
        // شکستِ disable نباید کش را جابجا کند — همان وضعیت فعال می‌ماند
        expect(await auth.isTotpEnabled(env)).toBe(true);

        // روی کد قدیمی اینجا قفل کامل بود: totpSecret پاک و totpEnabled مانده بود
    });

    it('🔒 شکست حذف کلید جانبی (totpLastUsed) → غیرفعال‌سازی موفق + کش فوراً خاموش', async () => {
        const gated = new Set(['totpLastUsed']);
        const { kv, store } = createKvMock({ pwd: 'TempProbe123' }, gated);
        const env = { kv } as unknown as Env;

        const cookie = await login(store, env);
        const code = await seedTotpOn(store);
        // کش را با وضعیت واقعی (فعال) گرم می‌کنیم تا assertion پس از disable
        // واقعاً invalidateTotpCache(false) را اندازه‌گیری کند — نه اینکه کش از
        // زمانِ لاگین (قبل از سید) falseِ کهنه باشد
        auth.invalidateTotpCache(true);

        const res = await drive(env, cookie, code);
        expect(res.status).toBe(200);

        // کلید تصمیم‌گیری پاک شده — 2FA خاموش؛ یتیمِ بهینه‌پذیر فقط totpLastUsed
        expect(store.get('totpEnabled')).toBeUndefined();
        expect(store.get('totpSecret')).toBeUndefined();
        expect(store.get('totpLastUsed')).toBe('0'); // شکست خورد — بعداً enable پاکش می‌کند

        // کش ۱۵ثانیه‌ای باید بلافاصله خاموش باشد — نه پنجره‌ی قفل ۱۵ثانیه‌ای
        expect(await auth.isTotpEnabled(env)).toBe(false);
    });

    it('گارد: مسیر سالم → هر ۴ کلید پاک + کش خاموش + پاسخ موفق', async () => {
        const { kv, store } = createKvMock({ pwd: 'TempProbe123' });
        const env = { kv } as unknown as Env;

        const cookie = await login(store, env);
        const code = await seedTotpOn(store);
        store.set('totpPendingSecret', 'PENDING-SECRET');

        const res = await drive(env, cookie, code);
        expect(res.status).toBe(200);

        expect(store.get('totpEnabled')).toBeUndefined();
        expect(store.get('totpSecret')).toBeUndefined();
        expect(store.get('totpLastUsed')).toBeUndefined();
        expect(store.get('totpPendingSecret')).toBeUndefined();
        expect(await auth.isTotpEnabled(env)).toBe(false);
    });
});
