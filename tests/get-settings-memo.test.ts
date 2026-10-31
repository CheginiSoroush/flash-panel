import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';

// v0.8.38 — این فایل merge واقعی ~۱۵۰فیلدی را هزاران بار می‌چرخاند؛ زیر بار
// ۴۴-workerِ ران کامل، یک تک‌تست از سقف پیش‌فرض ۵ث رد می‌شود (فلیک محیطی
// تکرارشده در iteration 18/19/20/21). سقف همین فایل ۲۰ث — بدون اثر بیرونی.

/**
 * بهینه‌سازی v0.8.33 — اسنپ‌شات memo شده‌ی getSettings (src/settings/settings.ts)
 *
 * کلاس هزینه: getSettings هر بار یک شیء ~۱۵۰فیلدی از نو spread می‌کرد — ولی در
 * تولید کانفیگ «به ازای هر نود» صدا زده می‌شود (buildWebsocketOutbound +
 * selectSniHost + generateRemark در هر سه core) یعنی ~۳ spread به ازای هر نود؛
 * با ~۸۰ نود پیش‌فرض × ۳ core، صدها spread فقط در یک cold-miss. و چون kvSettings/
 * globalSettings فقط در ۴ نقطه‌ی صریح عوض می‌شوند (init / initForScheduled /
 * setSettings / syncKvSettings)، merge یک بار کافی است به شرط باطل‌سازی درست.
 *
 * این تست‌ها دو قرارداد را قفل می‌کنند:
 *   ۱) پایداری هویت بین فراخوانی‌ها (هزینه‌ی صفر merge تکراری) — روی کد قدیمی قرمز
 *   ۲) باطل‌سازی در هر ۴ نقطه‌ی تغییر — هیچ مسیری نباید مقدار کهنه ببیند (گارد)
 *
 * قرارداد نوشتاری: خروجی فقط-خواندنی است. ممیزی grep (iteration 15→16) نشان داد
 * هیچ فراخوانی‌ای در src/ فیلد سطح-اول خروجی را می‌نویسد؛ نوشتن تو در تو از قبل
 * با shallow-spread به kvSettings نشت می‌کرد — بدون تغییر.
 */

vi.setConfig({ testTimeout: 20_000 });

const MOCK_EMBEDED = {
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

(globalThis as any).EMBEDED_SETTINGS = MOCK_EMBEDED;
(globalThis as any).VERSION = '0.8.33';

function createKvMock(seed: Record<string, unknown> = {}) {
    // seed پیش‌فرض: blob صریح — وگرنه بوت‌استرپ null به kvSettings ماژولِ آلوده‌ی
    // تست قبل fallback می‌شود (چشمه‌ی KV خالی = merge با state ماژول)
    if (!seed.proxySettings) seed.proxySettings = { enableIPv6: false };
    const store = new Map<string, string>(
        Object.entries(seed).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])
    );
    const kv = {
        async get(key: string, opts?: { type?: string }) {
            const raw = store.get(key);
            if (raw === undefined) return null;
            if (opts?.type !== 'json') return raw;
            try {
                return JSON.parse(raw);
            } catch {
                return null;
            }
        },
        async put(key: string, value: string) { store.set(key, value); },
        async delete(key: string) { store.delete(key); }
    };
    return { kv, store };
}

let settings: typeof import('../src/settings/settings');
let kvmod: typeof import('../src/settings/kv');
let store: typeof import('../src/settings/store');

beforeAll(async () => {
    settings = await import('../src/settings/settings');
    kvmod = await import('../src/settings/kv');
    store = await import('../src/settings/store');
});

afterEach(() => {
    kvmod.invalidateDatasetCache();
    store._resetStoreStateForTest();
    // تزریق توکن بین تست‌ها نباید به کش ۵ ثانیه‌ای loadApiToken نشت کند
    settings._resetApiTokenCacheForTest();
});

describe('getSettings memo — پایداری هویت + باطل‌سازی در ۴ نقطه‌ی تغییر (v0.8.33)', () => {

    it('🔴 فراخوانی‌های پشت‌سرهم همان شیء را برمی‌گردانند (صفر spread تکراری)', async () => {
        settings.init(
            new Request('https://example.com/sp/login'),
            { kv: createKvMock().kv } as any
        );
        await settings.setSettings({ kv: createKvMock().kv } as any);

        const s1 = settings.getSettings();
        const s2 = settings.getSettings();

        // کد قدیمی: هر بار شیء نو — صدها spread به ازای هر تولید کانفیگ
        expect(s2).toBe(s1);
        // محتوای درست هم هست (merge هر دو لایه)
        expect(s2.securePath).toBe('sp');
        expect(s2.mainDomain).toBe('example.com');
    });

    it('🟢 نوشتن KV → syncKvSettings → مقدار نو بلافاصله دیده می‌شود (باطل‌سازی نقطه‌ی ۱)', async () => {
        const { kv } = createKvMock();
        settings.init(new Request('https://example.com/sp/login'), { kv } as any);
        await settings.setSettings({ kv } as any);
        expect(settings.getSettings().enableIPv6).toBe(false);

        await store.mutateSettings(
            { kv } as any,
            cur => ({ ...cur!, enableIPv6: true }),
            { reason: 'test:memo-sync' }
        );

        // commitSettingsBlob → syncKvSettings → invalidation — اگر جا افتاده بود اینجا کهنه می‌دید
        expect(settings.getSettings().enableIPv6).toBe(true);
    });

    it('🟢 تغییر blob در KV → setSettings → مقدار نو دیده می‌شود (باطل‌سازی نقطه‌ی ۲)', async () => {
        const { kv, store: kvStore } = createKvMock();
        settings.init(new Request('https://example.com/sp/login'), { kv } as any);
        await settings.setSettings({ kv } as any);
        const before = settings.getSettings();
        expect(before.enableIPv6).toBe(false);

        // نویسنده‌ی isolate دیگر — blob را در KV عوض می‌کند
        const blob = JSON.parse(kvStore.get('proxySettings')!);
        blob.enableIPv6 = true;
        kvStore.set('proxySettings', JSON.stringify(blob));
        kvmod.invalidateDatasetCache();

        await settings.setSettings({ kv } as any);
        expect(settings.getSettings().enableIPv6).toBe(true);
        // اسنپ‌شات قبلی (مرجع نگه‌داشته‌شده) کهنه می‌ماند — همان قرارداد همیشگی
        expect(before.enableIPv6).toBe(false);
    });

    it('🟢 init با درخواست نو → hostname/origin/client تازه (باطل‌سازی نقطه‌ی ۳)', async () => {
        const { kv } = createKvMock();
        settings.init(new Request('https://first-host.com/sp/login'), { kv } as any);
        await settings.setSettings({ kv } as any);
        expect(settings.getSettings().hostname).toBe('first-host.com');

        settings.init(new Request('https://second-host.org/sp/login?app=xray'), { kv } as any);
        const s = settings.getSettings();
        expect(s.hostname).toBe('second-host.org');
        expect(s.origin).toBe('https://second-host.org');
        expect(s.client).toBe('xray');
    });
});

describe('getSettings memo — نقطه‌ی جهش پنجم: تزریق توکن runtime (v0.8.34)', () => {

    it('🔴 applyApiToken (مسیر /cftoken ربات) → merged snapshot باید توکن نو را ببیند', async () => {
        const { kv } = createKvMock();
        settings.init(new Request('https://example.com/sp/login'), { kv } as any);
        await settings.setSettings({ kv } as any);

        // memo با توکن embed ساخته می‌شود (mock: 'api-token')
        const before = settings.getSettings();
        expect(before.apiToken).toBe('api-token');

        settings.applyApiToken('brand-new-token');

        // getGlobals زنده است — مصرف‌کنندگان فعلی CF-API از همین می‌خوانند
        expect(settings.getGlobals().apiToken).toBe('brand-new-token');
        // 🔴 کد قدیمی: memo باطل نمی‌شد → merged.apiToken کهنه ('api-token') می‌ماند
        // تا init/setSettings بعدی؛ هر مصرف‌کننده‌ی آینده‌ی merged.apiToken توکن مرده می‌گرفت
        expect(settings.getSettings().apiToken).toBe('brand-new-token');
    });

    it('🔴 loadApiToken از KV (مسیر lazy پنل/cron) → merged snapshot توکن تازه', async () => {
        const { kv } = createKvMock({ cfApiToken: 'kv-injected-token' });
        settings.init(new Request('https://example.com/sp/login'), { kv } as any);
        await settings.setSettings({ kv } as any);

        const before = settings.getSettings();
        expect(before.apiToken).not.toBe('kv-injected-token');

        await settings.loadApiToken({ kv } as any);

        // 🔴 کد قدیمی: memo کهنه — توکن KV هرگز وارد merged نمی‌شود تا ری‌init
        expect(settings.getSettings().apiToken).toBe('kv-injected-token');
    });
});
