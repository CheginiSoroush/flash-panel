import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';


/**
 * v0.8.53 — هم‌راستاسازی جفت upstream در مولد sing-box با فیکس xray
 * (src/cores/sing-box/configs.ts — getSbCustomConfig)
 *
 * الگوی قدیمی (unshift upstreamPort/upstreamServer + XOR-skip) وقتی upstreamPort
 * عضو ports باشد (رایج‌ترین حالت: ports پیش‌فرض [443] و upstream روی ۴۴۳):
 *
 * ۱) جفت upstream دوبار تولید می‌شد — هر دو کپیِ پورت با شرط
 *    (port === upstreamPort) !== (host === upstreamServer) پاس می‌کردند →
 *    کانفیگ‌های تکراری «Upstream Proxy» در ساب.
 *
 * ۲) کانفیگ‌های عادی همان پورت حذف می‌شدند — host عادی × پورت upstream توسط
 *    همان شرط skip می‌شد → با ports=[443] یعنی ساب بدون هیچ کانفیگ ورکری.
 *
 * هم‌تاب tests/xray-upstream-pair.test.ts (v0.8.52).
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
(globalThis as any).VERSION = '0.8.53';
(globalThis as any)._repo_ = 'https://github.com/CheginiSoroush/flash-panel';
(globalThis as any)._project_SM_ = 'flash';
(globalThis as any)._public_proxy_ip_ = 'bpb.yousef.isegaro.com';

// ---------- استاب DoH — جواب ثابت ----------

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

type AnyOutbound = { tag?: string; server?: string; server_port?: number };

async function sbOutbounds(isFragment = false): Promise<AnyOutbound[]> {
    const config = JSON.parse(await (await getSbCustomConfig(isFragment)).text());
    return config.outbounds ?? [];
}

describe('sing-box upstream pair — collision-free generation (v0.8.53, xray parity)', () => {
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

    it('upstream on a port already in ports: one upstream pair per protocol + worker entries restored (RED on old)', async () => {
        // تصادم کامل: ports پیش‌فرض [443] و upstream روی همان ۴۴۳
        await applyKvOverrides({
            upstreamParams: { upstreamServer: 'upstream.example.com', upstreamPort: 443 }
        });

        const outbounds = await sbOutbounds();

        // کد قدیمی: ۴ (۲ پروتکل × ۲ کپی تکراری)
        const upstreamCount = outbounds.filter(o => o.server === 'upstream.example.com').length;
        expect(upstreamCount).toBe(2);

        // کد قدیمی: ۰ — کانفیگ ورکر روی ۴۴۳ به‌کلی حذف می‌شد
        const worker443 = outbounds.filter(o => o.server === 'example.com' && o.server_port === 443);
        expect(worker443.length).toBe(2);
    });

    it('no collision (upstream outside ports): order and counts unchanged (regression guard)', async () => {
        await applyKvOverrides({
            ports: [443],
            upstreamParams: { upstreamServer: 'upstream.example.com', upstreamPort: 2053 }
        });

        const outbounds = await sbOutbounds();
        const proxies = outbounds.filter(o => !!o.server);

        // upstream اول صف — همان ترتیب unshift قدیمی
        expect(proxies[0].server).toBe('upstream.example.com');
        expect(proxies[0].tag).toContain('Upstream Proxy');
        expect(outbounds.filter(o => o.server === 'upstream.example.com').length).toBe(2);

        const worker443 = outbounds.filter(o => o.server === 'example.com' && o.server_port === 443);
        expect(worker443.length).toBe(2);
    });
});
