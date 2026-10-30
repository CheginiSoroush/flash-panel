import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

/**
 * v0.8.23 — گارد ساختاری warpAccounts در مرز لود KV (src/settings/kv.ts)
 *
 * کلاس باگی که این گارد نابود می‌کند:
 *   شرط قدیمی «if (!warpAccounts)» فقط null را می‌گرفت؛ اما مصرف‌کنندگان
 *   (configs در cores/clash + xray + sing-box و wireguard.ts) هر دو اکانت
 *   [0] و [1] را بدون گارد destructure می‌کنند. یک آرایه‌ی خالی/تک‌عضوی یا
 *   رکورد ناقص در KV (نوشتن دستی، خرابی partial، دستکاری ادمین) یعنی ۵۰۰ شدن
 *   همه‌ی ساب‌های warp/wow هر سه هسته + ZIP وایرگارد.
 *
 * رفتار درست: داده‌ی ناقص در مرز لود → بازسازی خودکار (fetchWarpAccounts).
 *   آن تابع روی موفقیت در KV می‌نویسد (self-heal ماندگار) و روی شکستِ شبکه،
 *   اکانت‌های embedded را برمی‌گرداند → سرویس هرگز با اکانت ناقص ۵۰۰ نمی‌دهد.
 */

(globalThis as any).VERSION = '0.8.23';
(globalThis as any)._repo_ = 'https://github.com/CheginiSoroush/flash-panel';
(globalThis as any)._public_proxy_ip_ = 'bpb.yousef.isegaro.com';
(globalThis as any).EMBEDED_SETTINGS = {
    accID: 'test-account-id',
    accEmail: 'admin@example.com',
    apiToken: 'api-token',
    vlUUID: 'b831381d-6324-4d53-ad4f-8cda48b30811',
    trPass: 'trojan-pass',
    securePath: 'sp',
    proxyIpMode: 'proxyip',
    proxyIPs: [] as string[],
    prefixes: [] as string[],
    forceProxyDomains: [],
    mainDomain: 'example.com',
    fallback: '',
    dohUrl: ''
};

const { fetchWarpAccountsMock } = vi.hoisted(() => ({ fetchWarpAccountsMock: vi.fn() }));

// mock ماژول ثبت WARP — هیچ شبکه‌ای در تست
vi.mock('@api/warp', () => ({ fetchWarpAccounts: fetchWarpAccountsMock }));

const acc1 = {
    privateKey: 'p1-private-key',
    publicKey: 'p1-public-key',
    warpIPv6: '2606:4700:110:aaaa:1111:2222:3333:4444/128',
    reserved: 'AAAA'
};
const acc2 = {
    privateKey: 'p2-private-key',
    publicKey: 'p2-public-key',
    warpIPv6: '2606:4700:110:bbbb:1111:2222:3333:5555/128',
    reserved: 'BBBB'
};

/** رفتار واقعی fetchWarpAccounts: روی موفقیت در KV می‌نویسد */
function mockSuccess(accounts: unknown[] = [acc1, acc2]) {
    fetchWarpAccountsMock.mockImplementation(async (env: any) => {
        await env.kv.put('warpAccounts', JSON.stringify(accounts));
        return accounts;
    });
}

function fullBlob() {
    return {
        panelVersion: '0.8.23',
        remoteDNS: '1.1.1.1',
        remoteDnsHost: { host: '1.1.1.1', isDomain: false, ipv4: [], ipv6: [] },
        customDomain: '',
        upstreamProxy: '',
        chainProxy: '',
        ports: [443],
        localDNS: '8.8.8.8',
        bypassIran: false,
        cleanIPs: ['104.16.160.3']
    };
}

/** mock KV هم‌رفتار با Workers واقعی: JSON نامعتبر → null (نه throw) */
function createKvMock(seed: Record<string, unknown> = {}) {
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
                return null; // رفتار KV واقعی
            }
        },
        async put(key: string, value: string) {
            store.set(key, value);
        },
        async delete(key: string) {
            store.delete(key);
        }
    };
    return { kv, store };
}

function seedKv(warpAccounts: unknown) {
    return createKvMock({
        proxySettings: fullBlob(),
        telegramBot: { telegramBotToken: '', telegramUserId: '' },
        warpAccounts
    });
}

let settings: typeof import('../src/settings/settings');
let kvmod: typeof import('../src/settings/kv');
let store: typeof import('../src/settings/store');

beforeAll(async () => {
    settings = await import('../src/settings/settings');
    kvmod = await import('../src/settings/kv');
    store = await import('../src/settings/store');

    settings.init(
        new Request('https://example.com/sp/panel', {
            headers: { 'CF-Connecting-IP': '1.2.3.4' }
        }),
        { kv: new Map() } as any
    );
});

beforeEach(() => {
    fetchWarpAccountsMock.mockReset();
});

afterEach(() => {
    kvmod.invalidateDatasetCache();
    kvmod._resetMigrationThrottleForTest();
    store._resetStoreStateForTest();
});

describe('kv: گارد ساختاری warpAccounts (self-heal در مرز لود)', () => {

    it('آرایه‌ی خالی در KV → بازسازی خودکار + self-heal ماندگار در KV', async () => {
        mockSuccess();
        const { kv, store: kvStore } = seedKv([]);

        await settings.setSettings({ kv } as any);

        expect(fetchWarpAccountsMock).toHaveBeenCalledTimes(1);
        const accs = settings.getWarpAccounts();
        expect(accs).toHaveLength(2);
        expect(accs[0].publicKey).toBe('p1-public-key');
        expect(accs[1].publicKey).toBe('p2-public-key');
        // self-heal — KV حالا اکانت‌های سالم دارد
        expect(JSON.parse(kvStore.get('warpAccounts')!)[0].publicKey).toBe('p1-public-key');
    });

    it('تک‌اکانت در KV → بازسازی (کلاینت WoW به اکانت دوم نیاز دارد)', async () => {
        mockSuccess();
        const { kv } = seedKv([acc1]);

        await settings.setSettings({ kv } as any);

        expect(fetchWarpAccountsMock).toHaveBeenCalledTimes(1);
        expect(settings.getWarpAccounts()).toHaveLength(2);
    });

    it('رکورد ناقص (بی‌کلید عمومی) → بازسازی؛ base64ToDecimal روی null نمی‌ترکد', async () => {
        mockSuccess();
        const { kv } = seedKv([
            acc1,
            { privateKey: 'ok-key', warpIPv6: '2606:4700::/128', reserved: 'CCCC' } // publicKey ندارد
        ]);

        await settings.setSettings({ kv } as any);

        expect(fetchWarpAccountsMock).toHaveBeenCalledTimes(1);
        expect(settings.getWarpAccounts()[1].publicKey).toBe('p2-public-key');
    });

    it('مقدار غیر JSON در KV (خرابی دستی) → null مثل KV واقعی → بازسازی، بدون throw', async () => {
        mockSuccess();
        // seed رشته‌ی non-JSON — createKvMock رشته‌ها را خام نگه می‌دارد
        const { kv } = seedKv('not-json{{{');

        await expect(settings.setSettings({ kv } as any)).resolves.not.toThrow();
        expect(fetchWarpAccountsMock).toHaveBeenCalledTimes(1);
        expect(settings.getWarpAccounts()).toHaveLength(2);
    });

    it('دو اکانت سالم در KV → بدون شبکه، عیناً همان‌ها استفاده می‌شوند', async () => {
        const { kv } = seedKv([acc1, acc2]);

        await settings.setSettings({ kv } as any);

        expect(fetchWarpAccountsMock).not.toHaveBeenCalled();
        const accs = settings.getWarpAccounts();
        expect(accs[0]).toMatchObject({ publicKey: 'p1-public-key', reserved: 'AAAA' });
        expect(accs[1]).toMatchObject({ publicKey: 'p2-public-key', reserved: 'BBBB' });
    });

    it('بازسازیِ شکست‌خورده (شبکه‌ی مرده) → سرویس با اکانت fallback بالا می‌ماند؛ KV خراب می‌ماند', async () => {
        // قرارداد واقعی fetchWarpAccounts: هرگز throw نمی‌کند؛ روی شکستِ ثبت،
        // اکانت‌های embedded را برمی‌گرداند و KV را نمی‌نویسد (بدون self-heal)
        fetchWarpAccountsMock.mockImplementation(async () => [acc1, acc2]); // بدون put

        const { kv, store: kvStore } = seedKv([]);

        await settings.setSettings({ kv } as any);

        const accs = settings.getWarpAccounts();
        expect(accs).toHaveLength(2);
        expect(accs[0].privateKey).toBeTruthy();
        expect(accs[1].privateKey).toBeTruthy();
        // KV همچنان [] است — isolate سردِ بعدی دوباره تلاش می‌کند (همان رفتار bootstrap null)
        expect(JSON.parse(kvStore.get('warpAccounts')!)).toEqual([]);
    });
});
