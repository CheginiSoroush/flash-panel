import { describe, it, expect, afterEach, vi } from 'vitest';

/**
 * v0.8.58 — getSecretKey: خطای خواندن KV دیگر «کلید وجود ندارد» تفسیر نمی‌شود
 *
 * کلاس باگ: getSecretKey روی ایزولیت سرد، خطای خواندن KV را بی‌صدا می‌بلعید و
 * null برمی‌گرداند — همان خروجیِ «کلید هنوز در KV نیست». فراخوانِ لاگین روی null
 * کلید تازه می‌ساخت و با put در KV می‌نوشت؛ یعنی یک لغزش گذرای خواندن (با نوشتن
 * سالم — get و put دو مسیر مستقل‌اند) secretKey سراسری را بازتولید و جایگزین
 * می‌کرد = ابطال بی‌صدای همه‌ی سشن‌های معتبر. این دقیقاً نقض قصد اعلام‌شده‌ی
 * کامنت v0.8.27 بالای همین تابع بود: «شکست خواندن KV = کشِ کهنه — بهتر از
 * logout کردن ناخواسته‌ی همه در حین قطعی KV».
 *
 * فیکس (هم‌الگوی getPwd v0.8.37 و isTotpEnabled v0.8.47): کش گرم + خطا → stale
 * (سشن‌ها زنده می‌مانند)؛ کش سرد + خطا → پرتاب → لاگین ۵۰۳ صریح می‌دهد و هیچ
 * نوشتنی رخ نمی‌دهد. authenticate خودش catch دارد → fail-closed (false).
 * مسیر بوت‌استرپ واقعی (خواندن سالم + کلید غایب) دست‌نخورده می‌ماند.
 *
 * پوشش این فایل:
 *   ۱) 🔒 خواندن secretKey خطا می‌دهد → ۵۰۳ + صفر put روی secretKey — RED روی قدیمی
 *      (قدیمی: 200 + put کلید تازه = ابطال سراسری)
 *   ۲) 🔒 authenticate روی خطای خواندن fail-closed → false بدون throw (گارد — هر دو کد سبز)
 *   ۳) گارد: بوت‌استرپ واقعی (خواندن سالم، کلید غایب) → تولید + put + توکن (هر دو کد سبز)
 *   ۴) گارد: کش گرم + قطعی بعد از انقضای TTL → stale-on-error، سشن‌ها زنده (قرارداد v0.8.27)
 */

const EMBEDED = {
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

const SECRET = 'a'.repeat(64);

/** KV با تزریق خطای انتخابی روی get کلیدهای مشخص + شمارنده‌ی put */
function createAuthKv(seed: Record<string, string> = {}) {
    const store = new Map<string, string>(Object.entries(seed));
    const failGets = new Set<string>();
    const puts: Array<{ key: string; value: string }> = [];

    const kv = {
        async get(key: string) {
            if (failGets.has(key)) throw new Error(`simulated KV outage: ${key}`);
            const raw = store.get(key);
            return raw === undefined ? null : raw;
        },
        async put(key: string, value: string) {
            puts.push({ key, value });
            store.set(key, value);
        },
        async delete(key: string) {
            store.delete(key);
        }
    } as unknown as KVNamespace;

    return {
        kv,
        store,
        failGets,
        puts,
        putCount: (key: string) => puts.filter(p => p.key === key).length
    };
}

async function boot(kvMock: ReturnType<typeof createAuthKv>) {
    vi.resetModules();

    (globalThis as any).VERSION = '0.8.58';
    (globalThis as any).EMBEDED_SETTINGS = { ...EMBEDED };

    const settings = await import('../src/settings/settings');
    settings.init(
        new Request('https://example.com/sp/panel', {
            headers: { 'CF-Connecting-IP': '1.2.3.4' }
        }),
        { kv: kvMock.kv } as unknown as Env
    );

    const auth = await import('../src/auth/auth');
    return { settings, auth };
}

function loginRequest(body: unknown, ip: string): Request {
    return new Request('https://example.com/sp/login/authenticate', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'CF-Connecting-IP': ip
        },
        body: JSON.stringify(body)
    });
}

// هر تست IP و ماژول تازه — تا rate-limit in-memory بین تست‌ها تداخل نکند
let ipCounter = 0;
const nextIp = () => `10.9.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`;

afterEach(() => {
    delete (globalThis as any).EMBEDED_SETTINGS;
    delete (globalThis as any).VERSION;
    vi.restoreAllMocks();
    vi.resetModules();
});

describe('getSecretKey — KV outage must not regenerate the global session key (v0.8.58)', () => {
    it('🔒 خواندن secretKey روی ایزولیت سرد خطا می‌دهد → ۵۰۳ صریح و هیچ put روی secretKey', async () => {
        const m = createAuthKv({ pwd: 'correct-pass', secretKey: SECRET });
        m.failGets.add('secretKey');
        const { auth } = await boot(m);
        const env = { kv: m.kv } as unknown as Env;

        const res = await auth.generateJWTToken(
            loginRequest({ username: 'admin@example.com', password: 'correct-pass' }, nextIp()),
            env
        );

        // 🔴 روی کد قدیمی: 200 + put('secretKey', کلید تازه) = ابطال بی‌صدای همه‌ی سشن‌ها
        expect(res.status).toBe(503);
        expect(m.putCount('secretKey')).toBe(0);
        expect(m.store.get('secretKey')).toBe(SECRET); // کلید اصلی دست‌نخورده
    });

    it('🔒 authenticate روی خطای خواندن fail-closed می‌ماند (false — نه throw، نه پذیرش)', async () => {
        const m = createAuthKv({ pwd: 'correct-pass', secretKey: SECRET });
        m.failGets.add('secretKey');
        const { auth } = await boot(m);
        const env = { kv: m.kv } as unknown as Env;

        const req = new Request('https://example.com/sp/panel', {
            headers: { Cookie: 'jwtToken=some.token.here' }
        });

        await expect(auth.authenticate(req, env)).resolves.toBe(false);
    });

    it('گارد: بوت‌استرپ واقعی (خواندن سالم، کلید غایب) → کلید تولید و ذخیره و توکن صادر می‌شود', async () => {
        const m = createAuthKv({ pwd: 'correct-pass' }); // secretKey عمداً غایب
        const { auth } = await boot(m);
        const env = { kv: m.kv } as unknown as Env;

        const res = await auth.generateJWTToken(
            loginRequest({ username: 'admin@example.com', password: 'correct-pass' }, nextIp()),
            env
        );

        expect(res.status).toBe(200);
        expect(res.headers.get('Set-Cookie') || '').toContain('jwtToken=');
        expect(m.putCount('secretKey')).toBe(1);
        expect(m.store.get('secretKey')).toMatch(/^[0-9a-f]{64}$/);
    });

    it('گارد: کش گرم + قطعی بعد از انقضای TTL → stale-on-error؛ سشن‌ها زنده می‌مانند (قرارداد v0.8.27)', async () => {
        vi.useFakeTimers();
        try {
            const m = createAuthKv({ pwd: 'correct-pass', secretKey: SECRET });
            const { auth } = await boot(m);
            const env = { kv: m.kv } as unknown as Env;

            // لاگین اول — کش را با کلید واقعی گرم می‌کند (بدون put — کلید از قبل هست)
            const r1 = await auth.generateJWTToken(
                loginRequest({ username: 'admin@example.com', password: 'correct-pass' }, nextIp()),
                env
            );
            expect(r1.status).toBe(200);
            expect(m.putCount('secretKey')).toBe(0);

            // ۳۱ ثانیه جلو — TTL کش ۳۰ثانیه‌ای تمام
            vi.setSystemTime(Date.now() + 31_000);
            m.failGets.add('secretKey');

            const r2 = await auth.generateJWTToken(
                loginRequest({ username: 'admin@example.com', password: 'correct-pass' }, nextIp()),
                env
            );

            // stale → وریفای با همان کلید قبلی → لاگین سالم؛ بدون ۵۰۳ و بدون بازتولید
            expect(r2.status).toBe(200);
            expect((r2.headers.get('Set-Cookie') || '')).toContain('jwtToken=');
            expect(m.putCount('secretKey')).toBe(0);
            expect(m.store.get('secretKey')).toBe(SECRET);
        } finally {
            vi.useRealTimers();
        }
    });
});
