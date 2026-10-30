import { describe, it, expect, beforeAll, afterEach } from 'vitest';

/**
 * v0.8.9 — رژیم degrade سهمیه‌ی KV (رگرسیون بحرانی live)
 *
 * باگ واقعی که اشتراک و پنل را پایین آورد:
 *   getKV → مهاجرت نسخه (panelVersion قدیمی در KV) → kv.put → 429
 *   «KV put() limit exceeded for the day» → throw → همه‌ی مسیرها error page
 *
 * قرار دادن مهاجرت/بوت‌استرپ: best-effort — با تنظیمات merge-شده‌ی حافظه
 * سرویس ادامه می‌دهد؛ ۱۵ دقیقه بعد دوباره تلاش می‌شود.
 */

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
(globalThis as any).VERSION = '0.8.9';
(globalThis as any)._repo_ = 'https://github.com/CheginiSoroush/flash-panel';
(globalThis as any)._public_proxy_ip_ = 'bpb.yousef.isegaro.com';

const QUOTA_ERROR = new Error('KV put() limit exceeded for the day.');

/** KV که get هایش کار می‌کند ولی put هایش با سقف روزانه می‌میرند */
function createQuotaDeadKv(seed: Record<string, any>) {
    const store = new Map<string, string>(
        Object.entries(seed).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])
    );
    let putAttempts = 0;
    const kv = {
        async get(key: string, opts?: { type?: string }) {
            const raw = store.get(key);
            if (raw === undefined) return null;
            return opts?.type === 'json' ? JSON.parse(raw) : raw;
        },
        async put() {
            putAttempts++;
            throw QUOTA_ERROR;
        },
        async delete(key: string) {
            store.delete(key);
        }
    } as unknown as KVNamespace;

    return { kv, store, putCounter: () => putAttempts };
}


// v0.8.23: گارد ساختاری warpAccounts در مرز لود — هر seed باید دو اکانت سالم باشد
// تا fetchWarpAccounts (که شبکه می‌زند) در تست‌های degrade فایر نشود
const validWarpAccounts = [
    { privateKey: 'k1', publicKey: 'K1', warpIPv6: '2606:4700::1/128', reserved: 'AAAA' },
    { privateKey: 'k2', publicKey: 'K2', warpIPv6: '2606:4700::2/128', reserved: 'BBBB' }
];

describe('KV quota-exhausted degrade (v0.8.9) — the service must never die', () => {
    let settings: typeof import('../src/settings/settings');
    let kvmod: typeof import('../src/settings/kv');

    beforeAll(async () => {
        settings = await import('../src/settings/settings');
        kvmod = await import('../src/settings/kv');

        settings.init(
            new Request('https://example.com/sp/panel', {
                headers: { 'CF-Connecting-IP': '1.2.3.4' }
            }),
            { kv: new Map() } as any
        );
    });

    afterEach(() => {
        kvmod.invalidateDatasetCache();
        kvmod._resetMigrationThrottleForTest();
    });

    it('REGRESSION: stale panelVersion + exhausted KV quota → getDataset still returns merged settings (was: throw → error page)', async () => {
        const { kv } = createQuotaDeadKv({
            proxySettings: { panelVersion: '0.8.5', remoteDNS: '1.1.1.1', ports: [443, 8443] },
            // v0.8.23: گارد ساختاری در مرز لود — seed باید دو اکانت سالم باشد
            // (تک‌اکانت/ناقص حالا به بازسازی fetchWarpAccounts می‌رود = شبکه در تست)
            warpAccounts: [
                { privateKey: 'k1', publicKey: 'K1', warpIPv6: '2606:4700::1/128', reserved: 'AAAA' },
                { privateKey: 'k2', publicKey: 'K2', warpIPv6: '2606:4700::2/128', reserved: 'BBBB' }
            ],
            telegramBot: { telegramBotToken: 'tok', telegramUserId: '123' }
        });

        const data = await kvmod.getDataset({ kv } as any);
        expect(data.settings.panelVersion).toBe('0.8.9'); // در حافظه مهر نسخه‌ی جدید
        expect(data.settings.remoteDNS).toBe('1.1.1.1'); // مقدار ذخیره‌شده حفظ شده
        expect(data.settings.ports).toEqual([443, 8443]);
        expect(data.telegramBot.telegramBotToken).toBe('tok');
        expect(data.warpAccounts).toHaveLength(2);
    });

    it('migration throttle: within 15 minutes the failed put is NOT retried on every request', async () => {
        // customDomain/'' ذخیره می‌شود تا callback ستCustomDomain (که network می‌زند) فایر نشود
        // و mergeDataset به put برسد → همان‌جا 429 می‌گیرد
        const { kv, putCounter } = createQuotaDeadKv({
            proxySettings: { panelVersion: '0.8.5', customDomain: '', remoteDNS: '1.1.1.1', upstreamProxy: '', chainProxy: '' },
            warpAccounts: validWarpAccounts,
            telegramBot: { telegramBotToken: '', telegramUserId: '' }
        });

        await kvmod.getDataset({ kv } as any);
        const first = putCounter();
        expect(first).toBeGreaterThan(0);

        kvmod.invalidateDatasetCache(); // کش را دور بریز تا loadDataset دوباره اجرا شود
        await kvmod.getDataset({ kv } as any);
        kvmod.invalidateDatasetCache();
        await kvmod.getDataset({ kv } as any);

        expect(putCounter()).toBe(first); // بدون put اضافه — throttle فعال
    });

    it('bootstrap with empty KV + dead quota → defaults in memory, no throw', async () => {
        const { kv } = createQuotaDeadKv({
            warpAccounts: validWarpAccounts,
            telegramBot: { telegramBotToken: '', telegramUserId: '' }
        });

        const data = await kvmod.getDataset({ kv } as any);
        expect(data.settings.panelVersion).toBe('0.8.9');
        expect(data.settings.localDNS).toBe('8.8.8.8'); // از پیش‌فرض‌های KV
    });

    it('missing telegramBot + dead quota → default bot object in memory, no throw', async () => {
        const { kv } = createQuotaDeadKv({
            proxySettings: { panelVersion: '0.8.5' },
            warpAccounts: validWarpAccounts
        });

        const data = await kvmod.getDataset({ kv } as any);
        expect(data.telegramBot).toEqual({ telegramBotToken: '', telegramUserId: '' });
    });
});
