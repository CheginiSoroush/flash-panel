import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

/**
 * v0.8.63 — بهینه‌سازی: modifyOutbound (xray) و کپی زنجیره (clash/sing-box) از
 * structuredClone به پخش سطحی/copy-on-write تغییر کرد (~۴۰× سریع‌تر در تولید ساب).
 *
 * ریسک این بهینه‌سازی «aliasing» است: اگر نوشتنِ تودرتو روی شیءِ مشترک انجام
 * شود، همه‌ی کپی‌ها مقدار آخر را می‌گیرند. در xray تنها نوشتن تودرتو
 * streamSettings.sockopt.dialerProxy است — هر outbound زنجیره باید dialer-proxy
 * خودش را داشته باشد. ساختار ساب xray:
 *   - کانفیگ تکی زنجیره‌دار: [chain(dp='proxy'), proxy] — جفت عمومی
 *   - کانفیگ «⚡ 🔗 Best Ping 🚀»: [...chain-N(dp='proxy-N'), ...proxy-N] — جفت اندیس‌دار
 * تست با تولید کامل ساب، هر دو جفت را پین می‌کند — روی یک پخشِ سطحیِ ساده‌لوحانه
 * (نوشتن تودرتوی روی شیء مشترک) همه‌ی chain-N آخرین dialerProxy را می‌گرفتند.
 *
 * هارنس: همان الگوی xray-upstream-pair.test.ts (init واقعی settings + KV mock
 * + استاب DoH سطح fetch).
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
(globalThis as any).VERSION = '0.8.63';
(globalThis as any)._repo_ = 'https://github.com/CheginiSoroush/flash-panel';
(globalThis as any)._project_SM_ = 'flash';
(globalThis as any)._public_proxy_ip_ = 'bpb.yousef.isegaro.com';

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

const CHAIN_VLESS_URL = 'vless://chain-uuid@chain.example.com:443?sni=chain.example.com&security=tls&type=ws&path=%2Fchain#chain';

let store: Map<string, string>;
let setSettings: typeof import('../src/settings/settings')['setSettings'];
let getKvSettings: typeof import('../src/settings/settings')['getKvSettings'];
let invalidateDatasetCache: typeof import('../src/settings/kv')['invalidateDatasetCache'];
let extractProxyParams: typeof import('../src/cores/utils')['extractProxyParams'];
let getXrCustomConfigs: typeof import('../src/cores/xray/configs')['getXrCustomConfigs'];

async function applyKvOverrides(overrides: Record<string, unknown>) {
    const current = JSON.parse(JSON.stringify(getKvSettings()));
    const merged = { ...current, ...overrides, panelVersion: '0.3.8' };
    store.set('proxySettings', JSON.stringify(merged));
    invalidateDatasetCache();
    await setSettings({ kv: { get: (k: string, o?: any) => Promise.resolve(store.has(k) ? (o?.type === 'json' ? JSON.parse(store.get(k)!) : store.get(k)) : null), put: (k: string, v: string) => { store.set(k, v); }, delete: (k: string) => { store.delete(k); } } } as unknown as Env);
}

type AnyConfig = { remarks: string; outbounds: Array<any> };

async function normalConfigs(): Promise<AnyConfig[]> {
    return JSON.parse(await (await getXrCustomConfigs(false)).text());
}

describe('xray chain sockopt aliasing — copy-on-write keeps per-chain dialer-proxy (v0.8.63)', () => {
    beforeAll(async () => {
        const mock = createKvMock({
            warpAccounts: JSON.stringify([WARP_ACCOUNT, { ...WARP_ACCOUNT, privateKey: 'second-private-key', reserved: 'BBBB' }])
        });
        store = mock.store;

        const settings = await import('../src/settings/settings');
        setSettings = settings.setSettings;
        getKvSettings = settings.getKvSettings;
        ({ invalidateDatasetCache } = await import('../src/settings/kv'));
        ({ extractProxyParams } = await import('../src/cores/utils'));
        ({ getXrCustomConfigs } = await import('../src/cores/xray/configs'));

        settings.init(
            new Request('https://example.com/sp/sub/normal'),
            { kv: mock.kv } as unknown as Env
        );
        await setSettings({ kv: mock.kv } as unknown as Env);
    });

    beforeEach(async () => {
        await applyKvOverrides({});
    });

    it('healthy chain: individual configs pair chain(dp=proxy)→proxy; indexed chains keep unique dialer-proxy', async () => {
        await applyKvOverrides({
            chainProxy: CHAIN_VLESS_URL,
            chainProxyParams: extractProxyParams(CHAIN_VLESS_URL)
        });

        const configs = await normalConfigs();

        // ---------- کانفیگ‌های تکی زنجیره‌دار: جفت عمومی [chain(dp='proxy'), proxy] ----------
        const chainIndividuals = configs.filter(c => c.remarks.includes('🔗') && !c.remarks.includes('Best Ping'));
        expect(chainIndividuals.length).toBeGreaterThanOrEqual(2);

        for (const config of chainIndividuals) {
            const chainOb = config.outbounds[0];
            const proxyOb = config.outbounds[1];

            expect(chainOb.tag).toBe('chain');
            // نوشتن تودرتو روی نسخه‌ی خودِ این کپی دیده می‌شود و به جفتش اشاره می‌کند
            expect(chainOb.streamSettings?.sockopt?.dialerProxy).toBe(proxyOb.tag);
            // زیرشیء مشترک TLS سالم مانده — copy-on-write نباید چیزی را خراب کند
            expect(chainOb.streamSettings?.security).toBe('tls');
            expect(chainOb.settings?.vnext?.[0]?.address).toBe('chain.example.com');
        }

        // ---------- Best Ping زنجیره‌دار: chain-N(dp='proxy-N') — پین اصلی ضد-aliasing ----------
        const chainBestPing = configs.find(c => c.remarks === '⚡ 🔗 Best Ping 🚀');
        expect(chainBestPing).toBeDefined();

        const indexedChains = chainBestPing!.outbounds.filter(o => o.tag?.startsWith('chain-'));
        expect(indexedChains.length).toBeGreaterThanOrEqual(2);

        const proxyTags = new Set(chainBestPing!.outbounds.filter(o => o.tag?.startsWith('proxy-')).map(o => o.tag));
        const dialerProxies: string[] = [];
        for (const chainOb of indexedChains) {
            const paired = chainOb.tag.replace('chain-', 'proxy-');
            expect(chainOb.streamSettings?.sockopt?.dialerProxy).toBe(paired);
            expect(proxyTags.has(paired)).toBe(true);
            dialerProxies.push(chainOb.streamSettings.sockopt.dialerProxy);
        }

        // روی spread ساده‌لوحانه همه‌ی کپی‌ها آخرین dialerProxy مشترک را می‌گرفتند
        expect(new Set(dialerProxies).size).toBe(dialerProxies.length);
    });

    it('guard — without chain, no chain remarks and no sockopt.dialer-proxy anywhere', async () => {
        // overrides انباشته می‌شوند — chainProxy باید صریح خالی شود
        await applyKvOverrides({ chainProxy: '' });

        const configs = await normalConfigs();
        expect(configs.some(c => c.remarks.includes('🔗'))).toBe(false);
        expect(configs.some(c => c.outbounds.some(o => o.streamSettings?.sockopt?.dialerProxy))).toBe(false);
    });
});
