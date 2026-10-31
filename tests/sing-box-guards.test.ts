import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';


/**
 * v0.8.43 — هم‌راستاسازی گاردهای مولد sing-box با هسته‌ی xray
 * (src/cores/sing-box/configs.ts)
 *
 * دو واگرایی واقعی برای «همان ورودی ادمین» بین دو هسته:
 *
 * ۱) جفت upstream در پروفایل‌های fragment — xray (configs.ts:315) صراحتاً
 *    `!isFragment` دارد ولی sing-box نداشت → ساب fragment sing-box پروفایل‌های
 *    «Upstream Proxy» می‌ساخت که TLS-fragment (record_fragment) به سمت سرور
 *    upstream اعمال می‌کرد؛ در حالی که طراحی fragment روی پین استاتیک
 *    mainDomain بنا شده و fragment به سمت upstream بی‌معناست.
 *
 * ۲) گروه «D» (Best Ping D) — xray شرط `domain !== mainDomain` دارد ولی
 *    sing-box فقط `domain === customDomain` → اگر ادمین customDomain را برابر
 *    mainDomain بگذارد، پروفایل‌های دامنه‌ی اصلی به‌اشتباه برچسب دامنه‌ی سفارشی
 *    می‌گرفتند و گروه D بجوش می‌آمد.
 *
 * جهت هم‌راستایی: xray (معناشناسی اصلی‌تر و سخت‌گیرانه‌تر). تست‌ها با همان
 * الگوی cores.test.ts (init واقعی settings + KV mock + استاب DoH سطح fetch).
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
(globalThis as any).VERSION = '0.8.43';
(globalThis as any)._repo_ = 'https://github.com/CheginiSoroush/flash-panel';
(globalThis as any)._project_SM_ = 'flash';
(globalThis as any)._public_proxy_ip_ = 'bpb.yousef.isegaro.com';

// ---------- استاب DoH — جواب ثابت برای هر دو دامنه ----------

vi.stubGlobal('fetch', vi.fn(async (input: any) => {
    const url = String(input instanceof URL ? input : input?.url ?? input);
    if (url.includes('cloudflare-dns.com')) {
        const type = new URL(url).searchParams.get('type');
        const records = type === 'A' ? ['1.2.3.4'] : ['2606:4700:4700::1111'];
        return new Response(JSON.stringify({
            Answer: records.map(data => ({ type: type === 'A' ? 1 : 28, TTL: 300, data }))
        }), { status: 200, headers: { 'Content-Type': 'application/dns-json' } });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
}));

// ---------- KV mock (الگوی cores.test.ts) ----------

function createKvMock(seed: Record<string, string> = {}) {
    const store = new Map<string, string>(Object.entries(seed));
    return {
        kv: {
            async get(key: string, opts?: { type?: string }) {
                const raw = store.get(key);
                if (raw === undefined) return null;
                return opts?.type === 'json' ? JSON.parse(raw) : raw;
            },
            async put(key: string, value: string) {
                store.set(key, value);
            },
            async delete(key: string) {
                store.delete(key);
            }
        } as unknown as KVNamespace,
        store
    };
}

const WARP_ACCOUNT = {
    privateKey: '4NyxMUme2zGv5r3QWI0hJBlNglm1J/thoCE55PK29G8=',
    publicKey: 'bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=',
    warpIPv6: '2606:4700:110:8fd2:11f3:8e67:11d4:3704/128',
    reserved: 'N16D'
};

let store: Map<string, string>;
let init: typeof import('../src/settings/settings')['init'];
let setSettings: typeof import('../src/settings/settings')['setSettings'];
let getKvSettings: typeof import('../src/settings/settings')['getKvSettings'];
let invalidateDatasetCache: typeof import('../src/settings/kv')['invalidateDatasetCache'];
let getSbCustomConfig: typeof import('../src/cores/sing-box/configs')['getSbCustomConfig'];

async function applyKvOverrides(overrides: Record<string, unknown>) {
    const current = JSON.parse(JSON.stringify(getKvSettings()));
    const merged = { ...current, ...overrides, panelVersion: '0.3.8' };
    store.set('proxySettings', JSON.stringify(merged));
    invalidateDatasetCache();
    await setSettings({ kv: { get: (k: string, o?: any) => Promise.resolve(store.has(k) ? (o?.type === 'json' ? JSON.parse(store.get(k)!) : store.get(k)) : null), put: (k: string, v: string) => { store.set(k, v); }, delete: (k: string) => { store.delete(k); } } } as unknown as Env);
}

describe('sing-box generator guards — xray-core parity (v0.8.43)', () => {
    beforeAll(async () => {
        const mock = createKvMock({
            warpAccounts: JSON.stringify([WARP_ACCOUNT, { ...WARP_ACCOUNT, privateKey: 'second-private-key', reserved: 'BBBB' }])
        });
        store = mock.store;

        const settings = await import('../src/settings/settings');
        init = settings.init;
        setSettings = settings.setSettings;
        getKvSettings = settings.getKvSettings;
        ({ invalidateDatasetCache } = await import('../src/settings/kv'));
        ({ getSbCustomConfig } = await import('../src/cores/sing-box/configs'));

        init(
            new Request('https://example.com/sp/panel?app=sing-box'),
            { kv: mock.kv } as unknown as Env
        );
        await setSettings({ kv: mock.kv } as unknown as Env);
    });

    beforeEach(async () => {
        await applyKvOverrides({});
    });

    it('fragment profiles exclude the upstream pair — normal keeps it (RED on old)', async () => {
        await applyKvOverrides({
            upstreamParams: { upstreamServer: 'upstream.example.com', upstreamPort: 2053 }
        });

        const fragment = JSON.parse(await (await getSbCustomConfig(true)).text());
        const fragmentServers = fragment.outbounds.map((o: any) => o.server).filter(Boolean);
        // کد قدیمی: upstream با record_fragment به سمت upstream می‌آمد
        expect(fragmentServers).not.toContain('upstream.example.com');

        // گارد قرارداد: در حالت normal جفت upstream باید همچنان باشد
        const normal = JSON.parse(await (await getSbCustomConfig(false)).text());
        const normalServers = normal.outbounds.map((o: any) => o.server).filter(Boolean);
        expect(normalServers).toContain('upstream.example.com');
    });

    it('customDomain === mainDomain does not spin up the "D" group (RED on old)', async () => {
        await applyKvOverrides({ customDomain: 'example.com' });

        const config = JSON.parse(await (await getSbCustomConfig(false)).text());
        const selector = config.outbounds.find((o: any) => o.tag === '✅ Selector');

        // کد قدیمی: پروفایل‌های دامنه‌ی اصلی به گروه D (دامنه‌ی سفارشی) می‌رفتند
        expect(selector.outbounds).not.toContain('⚡ Best Ping D 🚀');
        expect(selector.outbounds).toContain('⚡ Best Ping 🚀');
    });

    it('a real custom domain still gets its own "D" group (over-removal guard)', async () => {
        await applyKvOverrides({ customDomain: 'custom.example.net' });

        const config = JSON.parse(await (await getSbCustomConfig(false)).text());
        const selector = config.outbounds.find((o: any) => o.tag === '✅ Selector');

        expect(selector.outbounds).toContain('⚡ Best Ping D 🚀');
        expect(selector.outbounds).toContain('⚡ Best Ping 🚀');

        const dGroup = config.outbounds.find((o: any) => o.tag === '⚡ Best Ping D 🚀');
        expect(dGroup.outbounds.length).toBeGreaterThan(0);
    });
});
