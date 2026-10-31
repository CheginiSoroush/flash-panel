import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

/**
 * v0.8.62 — جفت upstream در مولد clash (src/cores/clash/configs.ts —
 * getClNormalConfig) و ساب raw (src/cores/common.ts — getURLConfigs) دیگر با
 * unshift در totalPorts/hosts ادغام نمی‌شود — پاریتی با فیکس‌های xray v0.8.52
 * (fac65c6) و sing-box v0.8.53 (7183237).
 *
 * الگوی قدیمی (unshift upstreamPort/upstreamServer + XOR-skip) دو پیش‌فرضِ
 * نقض‌شده داشت: upstreamPort نباید در ports می‌بود. با تصادم (رایج‌ترین:
 * ports=[443] و upstream روی همان ۴۴۳):
 *
 * ۱) جفت upstream دوبار تولید می‌شد — هر دو کپیِ پورت با شرط
 *    (port === upstreamPort) !== (host === upstreamServer) پاس می‌کردند →
 *    کانفیگ‌های تکراری «Upstream Proxy» در ساب.
 *
 * ۲) کانفیگ‌های عادی همان پورت حذف می‌شدند — host عادی × پورت upstream توسط
 *    همان شرط skip می‌شد → با ports=[443] یعنی ساب بدون هیچ کانفیگ ورکری،
 *    فقط دو کپی upstream — کلید ورکر عملاً از ساب غایب.
 *
 * تست‌ها با همان الگوی xray-upstream-pair.test.ts (init واقعی settings + KV mock
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
(globalThis as any).VERSION = '0.8.62';
(globalThis as any)._repo_ = 'https://github.com/CheginiSoroush/flash-panel';
(globalThis as any)._project_SM_ = 'flash';
(globalThis as any)._project_ = 'flash';
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

let store: Map<string, string>;
let setSettings: typeof import('../src/settings/settings')['setSettings'];
let getKvSettings: typeof import('../src/settings/settings')['getKvSettings'];
let invalidateDatasetCache: typeof import('../src/settings/kv')['invalidateDatasetCache'];
let getClNormalConfig: typeof import('../src/cores/clash/configs')['getClNormalConfig'];
let getURLConfigs: typeof import('../src/cores/common')['getURLConfigs'];

async function applyKvOverrides(overrides: Record<string, unknown>) {
    const current = JSON.parse(JSON.stringify(getKvSettings()));
    const merged = { ...current, ...overrides, panelVersion: '0.3.8' };
    store.set('proxySettings', JSON.stringify(merged));
    invalidateDatasetCache();
    await setSettings({ kv: { get: (k: string, o?: any) => Promise.resolve(store.has(k) ? (o?.type === 'json' ? JSON.parse(store.get(k)!) : store.get(k)) : null), put: (k: string, v: string) => { store.set(k, v); }, delete: (k: string) => { store.delete(k); } } } as unknown as Env);
}

type ClashProxy = { name: string; type: string; server: string; port: number };

async function clashProxies(): Promise<ClashProxy[]> {
    const body = await (await getClNormalConfig()).text();
    return JSON.parse(body).proxies ?? [];
}

/** ساب raw را decode و خط‌به‌خط می‌کند (هر خط یک URI) */
async function rawLines(): Promise<string[]> {
    const body = await (await getURLConfigs()).text();
    return Buffer.from(body, 'base64').toString('utf8').split('\n').filter(Boolean);
}

describe('clash upstream pair — collision-free generation (v0.8.62)', () => {
    beforeAll(async () => {
        const mock = createKvMock();
        store = mock.store;

        const settings = await import('../src/settings/settings');
        setSettings = settings.setSettings;
        getKvSettings = settings.getKvSettings;
        ({ invalidateDatasetCache } = await import('../src/settings/kv'));
        ({ getClNormalConfig } = await import('../src/cores/clash/configs'));

        await settings.init(
            new Request('https://example.com/sp/sub/normal'),
            { kv: mock.kv } as unknown as Env
        );
        await setSettings({ kv: mock.kv } as unknown as Env);
    });

    beforeEach(async () => {
        await applyKvOverrides({});
    });

    it('collision: exactly one upstream pair per protocol + worker 443 restored (RED on old)', async () => {
        // تصادم کامل: ports=[443] و upstream روی همان ۴۴۳
        await applyKvOverrides({
            ports: [443],
            upstreamParams: { upstreamServer: 'upstream.example.com', upstreamPort: 443 }
        });

        const proxies = await clashProxies();

        // کد قدیمی: ۴ (۲ پروتکل × ۲ کپی تکراری)
        const upstreams = proxies.filter(p => p.name.includes('Upstream Proxy'));
        expect(upstreams.length).toBe(2);
        // بدون تکرار — دقیقاً یک جفت به‌ازای هر پروتکل (کد قدیمی: ۲ به‌ازای هر پروتکل)
        expect(upstreams.filter(p => p.type === 'vless').length).toBe(1);
        expect(upstreams.filter(p => p.type === 'trojan').length).toBe(1);

        // کد قدیمی: ۰ — کانفیگ ورکر روی ۴۴۳ به‌کلی حذف می‌شد
        const worker443 = proxies.filter(p => p.server === 'example.com' && p.port === 443);
        expect(worker443.length).toBe(2);
    });

    it('collision: Best Ping membership includes the restored 443 workers', async () => {
        await applyKvOverrides({
            ports: [443],
            upstreamParams: { upstreamServer: 'upstream.example.com', upstreamPort: 443 }
        });

        const body = JSON.parse(await (await getClNormalConfig()).text());
        const bestPing = body['proxy-groups'].find((g: any) => g.name === '⚡ Best Ping 🚀');
        expect(bestPing).toBeDefined();

        // کد قدیمی: هیچ تگی با ': 443' برای آدرس دامنه‌ی ورکر در گروه نبود
        const worker443Tags = (bestPing.proxies as string[]).filter(tag =>
            tag.includes('example.com') || tag.endsWith(': 443'));
        expect(worker443Tags.length).toBeGreaterThanOrEqual(2);
    });

    it('no collision (upstream outside ports): upstream first, counts unchanged (regression guard)', async () => {
        await applyKvOverrides({
            ports: [443],
            upstreamParams: { upstreamServer: 'upstream.example.com', upstreamPort: 2053 }
        });

        const proxies = await clashProxies();

        // upstream اول صف — همان ترتیب unshift قدیمی
        expect(proxies[0].name).toContain('Upstream Proxy');
        expect(proxies.filter(p => p.name.includes('Upstream Proxy')).length).toBe(2);

        const worker443 = proxies.filter(p => p.server === 'example.com' && p.port === 443);
        expect(worker443.length).toBe(2);
    });
});

describe('raw sub (getURLConfigs) upstream pair — collision-free generation (v0.8.62)', () => {
    beforeAll(async () => {
        const mock = createKvMock();
        store = mock.store;

        const settings = await import('../src/settings/settings');
        setSettings = settings.setSettings;
        getKvSettings = settings.getKvSettings;
        ({ invalidateDatasetCache } = await import('../src/settings/kv'));
        ({ getURLConfigs } = await import('../src/cores/common'));

        await settings.init(
            new Request('https://example.com/sp/sub/normal'),
            { kv: mock.kv } as unknown as Env
        );
        await setSettings({ kv: mock.kv } as unknown as Env);
    });

    beforeEach(async () => {
        await applyKvOverrides({});
    });

    it('collision: one upstream line per protocol + worker 443 restored (RED on old)', async () => {
        await applyKvOverrides({
            ports: [443],
            upstreamParams: { upstreamServer: 'upstream.example.com', upstreamPort: 443 }
        });

        const lines = await rawLines();

        // کد قدیمی: ۲ خط upstream به‌ازای هر پروتکل (دو کپی پورت ۴۴۳)
        expect(lines.filter(l => l.startsWith('vless://') && l.includes('Upstream%20Proxy')).length).toBe(1);
        expect(lines.filter(l => l.startsWith('trojan://') && l.includes('Upstream%20Proxy')).length).toBe(1);

        // کد قدیمی: ۰ — خط ورکر روی ۴۴۳ حذف می‌شد
        expect(lines.filter(l => l.startsWith('vless://') && l.includes('@example.com:443') && !l.includes('Upstream%20Proxy')).length).toBe(1);
        expect(lines.filter(l => l.startsWith('trojan://') && l.includes('@example.com:443') && !l.includes('Upstream%20Proxy')).length).toBe(1);
    });

    it('no collision (upstream outside ports): order and counts unchanged (regression guard)', async () => {
        await applyKvOverrides({
            ports: [443],
            upstreamParams: { upstreamServer: 'upstream.example.com', upstreamPort: 2053 }
        });

        const lines = await rawLines();

        // upstream اول صف — همان ترتیب unshift قدیمی
        expect(lines[0]).toContain('Upstream%20Proxy');

        expect(lines.filter(l => l.startsWith('vless://') && l.includes('Upstream%20Proxy')).length).toBe(1);
        expect(lines.filter(l => l.startsWith('trojan://') && l.includes('Upstream%20Proxy')).length).toBe(1);

        expect(lines.filter(l => l.startsWith('vless://') && l.includes('@example.com:443') && !l.includes('Upstream%20Proxy')).length).toBe(1);
        expect(lines.filter(l => l.startsWith('trojan://') && l.includes('@example.com:443') && !l.includes('Upstream%20Proxy')).length).toBe(1);
    });
});
