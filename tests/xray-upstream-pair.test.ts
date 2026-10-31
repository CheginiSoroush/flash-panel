import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';


/**
 * v0.8.52 — جفت upstream در مولد xray دیگر با unshift در totalPorts/hosts ادغام
 * نمی‌شود (src/cores/xray/configs.ts — getXrCustomConfigs)
 *
 * الگوی قدیمی (unshift upstreamPort/upstreamServer + XOR-skip) دو پیش‌فرضِ
 * نقض‌شده داشت: upstreamPort نباید در ports می‌بود. با تصادم (رایج‌ترین حالت:
 * ports پیش‌فرض [443] و upstream روی ۴۴۳):
 *
 * ۱) جفت upstream دوبار تولید می‌شد — هر دو کپیِ پورت با شرط
 *    (port === upstreamPort) !== (host === upstreamServer) پاس می‌کردند →
 *    کانفیگ‌های تکراری «Upstream Proxy» در ساب.
 *
 * ۲) کانفیگ‌های عادی همان پورت حذف می‌شدند — host عادی × پورت upstream توسط
 *    همان شرط skip می‌شد → با ports=[443] یعنی ساب بدون هیچ کانفیگ ورکری،
 *    فقط دو کپی upstream — کلید ورکر عملاً از ساب غایب.
 *
 * ۳) totalHosts قبل از unshift کپی می‌شد → دامنه‌ی upstream از bypass‌های DNS
 *    در پروفایل Best Ping جا می‌ماند → رزولوشن سرور upstream از مسیر remote-dns
 *    (داخل تونل) — حلِ وابستگی وقتی بالانسر همان اتصال upstream را بردارد.
 *
 * تست‌ها با همان الگوی sing-box-guards.test.ts (init واقعی settings + KV mock
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
(globalThis as any).VERSION = '0.8.52';
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
let getXrCustomConfigs: typeof import('../src/cores/xray/configs')['getXrCustomConfigs'];

async function applyKvOverrides(overrides: Record<string, unknown>) {
    const current = JSON.parse(JSON.stringify(getKvSettings()));
    const merged = { ...current, ...overrides, panelVersion: '0.3.8' };
    store.set('proxySettings', JSON.stringify(merged));
    invalidateDatasetCache();
    await setSettings({ kv: { get: (k: string, o?: any) => Promise.resolve(store.has(k) ? (o?.type === 'json' ? JSON.parse(store.get(k)!) : store.get(k)) : null), put: (k: string, v: string) => { store.set(k, v); }, delete: (k: string) => { store.delete(k); } } } as unknown as Env);
}

type AnyConfig = { remarks: string; outbounds: Array<any>; dns?: any };

/** آدرس/پورت اولین outbound واقعی پروکسی (vnext یا servers) */
function dialOf(config: AnyConfig): { address?: string; port?: number } {
    for (const outbound of config.outbounds) {
        const entry = outbound?.settings?.vnext?.[0] ?? outbound?.settings?.servers?.[0];
        if (entry?.address) return { address: entry.address, port: entry.port };
    }
    return {};
}

function isIndividual(config: AnyConfig): boolean {
    return !config.remarks.includes('Best Ping')
        && !config.remarks.includes('Smart Fragment')
        && !config.remarks.includes('Serverless');
}

async function normalConfigs(): Promise<AnyConfig[]> {
    return JSON.parse(await (await getXrCustomConfigs(false)).text());
}

describe('xray upstream pair — collision-free generation (v0.8.52)', () => {
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
        ({ getXrCustomConfigs } = await import('../src/cores/xray/configs'));

        init(
            new Request('https://example.com/sp/sub/normal'),
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

        const configs = await normalConfigs();
        const individuals = configs.filter(isIndividual);

        // کد قدیمی: ۴ (۲ پروتکل × ۲ کپی تکراری)
        const upstreamCount = individuals.filter(c => c.remarks.includes('Upstream Proxy')).length;
        expect(upstreamCount).toBe(2);

        // کد قدیمی: ۰ — کانفیگ ورکر روی ۴۴۳ به‌کلی حذف می‌شد
        const worker443 = individuals.filter(c => {
            const { address, port } = dialOf(c);
            return address === 'example.com' && port === 443;
        });
        expect(worker443.length).toBe(2);
    });

    it('Best Ping DNS bypasses the upstream server domain (RED on old)', async () => {
        await applyKvOverrides({
            upstreamParams: { upstreamServer: 'upstream.example.com', upstreamPort: 443 }
        });

        const configs = await normalConfigs();
        const bestPing = configs.find(c => c.remarks.includes('Best Ping'));
        expect(bestPing).toBeDefined();

        // کد قدیمی: totalHosts قبل از unshift کپی می‌شد → full:upstream.example.com
        // در سرور localDNS غایب بود → رزولوشن سرور upstream از داخل تونل
        const bypassed = bestPing!.dns.servers.some((server: any) =>
            Array.isArray(server.domains) && server.domains.includes('full:upstream.example.com')
        );
        expect(bypassed).toBe(true);
    });

    it('no collision (upstream outside ports): order and counts unchanged (regression guard)', async () => {
        await applyKvOverrides({
            ports: [443],
            upstreamParams: { upstreamServer: 'upstream.example.com', upstreamPort: 2053 }
        });

        const configs = await normalConfigs();
        const individuals = configs.filter(isIndividual);

        // upstream اول صف — همان ترتیب unshift قدیمی
        expect(individuals[0].remarks).toContain('Upstream Proxy');
        expect(individuals.filter(c => c.remarks.includes('Upstream Proxy')).length).toBe(2);

        const worker443 = individuals.filter(c => {
            const { address, port } = dialOf(c);
            return address === 'example.com' && port === 443;
        });
        expect(worker443.length).toBe(2);
    });

    it('fragment profiles still exclude the upstream pair (v0.8.43 parity guard)', async () => {
        await applyKvOverrides({
            ports: [443],
            upstreamParams: { upstreamServer: 'upstream.example.com', upstreamPort: 2053 }
        });

        const fragment = JSON.parse(await (await getXrCustomConfigs(true)).text());
        const upstreamRemarks = fragment.filter((c: AnyConfig) => c.remarks.includes('Upstream Proxy'));
        expect(upstreamRemarks.length).toBe(0);
    });
});
