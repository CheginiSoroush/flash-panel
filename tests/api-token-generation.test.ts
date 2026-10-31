import { describe, it, expect, afterEach, vi } from 'vitest';

/**
 * v0.8.57 — نسل توکن + single-flight در loadApiToken (settings/settings.ts)
 *
 * کلاس باگ (هم‌کلاس فیکس v0.8.55 روی کش دیتاست — مسابقه‌ی «لود سرد × write»):
 * loadApiToken خواندن KV را بی‌هیچ گاردی شروع می‌کرد و نتیجه را — هرچند دیر
 * برسد — تزریق و کش می‌کرد. اگر در طول همین لود ادمین توکن تازه را با /cftoken
 * ذخیره می‌کرد (applyApiToken → setRuntimeApiToken تازه)، خواندنی که قبل از آن
 * شروع شده بود بعد از آن resolve می‌شد و توکن تازه را با مقدار کهنه‌ی KV
 * clobber می‌کرد. KV انتشار تدریجی دارد (تا ~۶۰ث مقدار کهنه سرو می‌شود) پس این
 * clobber می‌توانست چند پنجره‌ی ۵ثانیه‌ای کش دوام بیاورد — فیچرهای CF-API
 * (usage/deploy/tuner) بعد از چرخش توکن بی‌دلیل شکست می‌خوردند.
 *
 * مسیر دوم (سرعت): کش ۵ثانیه‌ای single-flight نداشت — فراخوانی‌های هم‌زمان روی
 * مرز TTL (poll داشبورد usage + وب‌هوک تلگرام + تیک کرون) هرکدام خواندن KV
 * خودشان را می‌زدند = N خواندن موازی برای یک مقدار.
 *
 * فیکس: apiTokenGeneration که applyApiToken/ریست جلو می‌برد — نتیجه‌ی لود فقط
 * بدون تعویض نسل تزریق/کش می‌شود؛ فراخوانی هم‌پوشان یک‌بار تازه‌خوانی می‌کند
 * (بعد از applyApiToken کش تازه است؛ retry همان‌جا برمی‌گردد) + inflight مشترک.
 *
 * پوشش این فایل:
 *   ۱) 🔒 لود در-حال-اجرا بعد از applyApiToken resolve شود → توکن تازه جان سالم — RED روی قدیمی (clobber)
 *   ۲) 🔒 ۵ فراخوانی هم‌زمان روی کش سرد → دقیقاً ۱ خواندن KV — RED روی قدیمی (۵ خواندن)
 *   ۳) گارد: لود سالم → تزریق + کش ۵ثانیه‌ای (هر دو کد سبز)
 */

const EMBEDED = {
    accID: 'test-account',
    accEmail: 'test@example.com',
    apiToken: '',
    vlUUID: 'b831381d-6324-4d53-ad4f-8cda48b30811',
    trPass: 'test-pass',
    securePath: 'sp',
    mainDomain: 'panel.example.com',
    scriptName: 'flash-panel-test',
    proxyIpMode: 'proxyip',
    proxyIPs: [] as string[],
    prefixes: [] as string[],
    forceProxyDomains: [] as string[],
    fallback: '',
    dohUrl: ''
};

const OLD_TOKEN = 'OLDToken-1234567890abcdef';
const NEW_TOKEN = 'NEWToken-9876543210fedcba';

/** KV با شمارنده‌ی get و گیت قابل‌مسلحه برای اولین get یک کلید مشخص */
function createGatedTokenKv(seed: Record<string, string> = {}) {
    const store = new Map<string, string>(Object.entries(seed));
    let getAttempts = 0;
    let gateArmedFor: string | null = null;
    let pendingResolve: ((value: string | null) => void) | null = null;

    const kv = {
        async get(key: string) {
            getAttempts++;
            if (gateArmedFor === key) {
                gateArmedFor = null;
                return await new Promise<string | null>(resolve => { pendingResolve = resolve; });
            }
            const raw = store.get(key);
            return raw === undefined ? null : raw;
        },
        async put(key: string, value: string) { store.set(key, value); },
        async delete(key: string) { store.delete(key); }
    } as unknown as KVNamespace;

    return {
        kv,
        store,
        getAttempts: () => getAttempts,
        armGate(key: string) { gateArmedFor = key; },
        releaseGate(value: string | null) {
            const r = pendingResolve;
            pendingResolve = null;
            r?.(value);
        }
    };
}

async function boot(kvBox: ReturnType<typeof createGatedTokenKv>) {
    vi.resetModules();

    (globalThis as any).VERSION = '0.8.57';
    (globalThis as any).EMBEDED_SETTINGS = { ...EMBEDED };

    const settings = await import('../src/settings/settings');
    settings.init(new Request('https://panel.example.com/sp/panel'), { kv: kvBox.kv } as any);
    return settings;
}

afterEach(() => {
    delete (globalThis as any).EMBEDED_SETTINGS;
    delete (globalThis as any).VERSION;
    vi.resetModules();
});

describe('loadApiToken — generation guard + single-flight (v0.8.57)', () => {
    it('🔒 لود در-حال-اجرا که بعد از applyApiToken resolve می‌شود توکن تازه را clobber نمی‌کند', async () => {
        const gated = createGatedTokenKv({ cfApiToken: OLD_TOKEN });
        const settings = await boot(gated);
        const env = { kv: gated.kv } as any;

        gated.armGate('cfApiToken');
        const load = settings.loadApiToken(env);
        await new Promise(r => setTimeout(r, 10)); // لود به گیت می‌رسد و می‌ماند

        // /cftoken در همین فاصله توکن تازه را تزریق می‌کند
        settings.applyApiToken(NEW_TOKEN);
        expect(settings.getGlobals().apiToken).toBe(NEW_TOKEN); // پیش‌شرط

        // حالا مقدار کهنه‌ی KV می‌رسد — نباید برنده شود
        gated.releaseGate(OLD_TOKEN);
        await load;

        // 🔴 روی کد قدیمی: OLD_TOKEN (clobber) — و چون KV تا ۶۰ث کهنه سرو
        // می‌کند، هر loadApiToken بعدی هم توکن کهنه را دوباره می‌نشاند
        expect(settings.getGlobals().apiToken).toBe(NEW_TOKEN);
        // فراخوانی هم‌پوشان روی کش تازه‌ی applyApiToken برگشت — بدون خواندن دوم
        expect(gated.getAttempts()).toBe(1);
    });

    it('🔒 گله‌ی هم‌زمان روی کش سرد — ۵ فراخوانی، دقیقاً ۱ خواندن KV (single-flight)', async () => {
        const gated = createGatedTokenKv({ cfApiToken: OLD_TOKEN });
        const settings = await boot(gated);
        const env = { kv: gated.kv } as any;

        gated.armGate('cfApiToken');
        const loads = Promise.all(Array.from({ length: 5 }, () => settings.loadApiToken(env)));
        await new Promise(r => setTimeout(r, 10)); // هر پنج روی inflight مشترک می‌نشینند
        gated.releaseGate(OLD_TOKEN);
        await loads;

        // 🔴 روی کد قدیمی: ۵ خواندن موازی برای یک مقدار
        expect(gated.getAttempts()).toBe(1);
        expect(settings.getGlobals().apiToken).toBe(OLD_TOKEN);
    });

    it('گارد: لود سالم — تزریق توکن + کش ۵ثانیه‌ای بدون خواندن مجدد', async () => {
        const plain = createGatedTokenKv({ cfApiToken: OLD_TOKEN }); // بدون گیت
        const settings = await boot(plain);
        const env = { kv: plain.kv } as any;

        await settings.loadApiToken(env);
        expect(settings.getGlobals().apiToken).toBe(OLD_TOKEN);

        await settings.loadApiToken(env);
        await settings.loadApiToken(env);
        expect(plain.getAttempts()).toBe(1);
    });
});
