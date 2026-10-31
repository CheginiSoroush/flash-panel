import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

/**
 * v0.8.65 — گارد warpEndpoints خالی در مرز لود + حداقلِ ولیدیتور.
 *
 * کلاس باگ: validateWarpEndpoints فقط «فرمت هر عضو» را می‌سنجید و آرایه‌ی خالی
 * را قبول می‌کرد (validatePorts همتایش از همیشه «حداقل یک پورت TLS» می‌خواست).
 * پاک‌کردن textarea endpoints در پنل یا یک blob دستیِ KV یعنی ساب‌های warp هر
 * سه هسته + ZIP وایرگارد با صفر outbound تولید می‌شدند:
 *
 *  - sing-box: dns-remote با detour به گروه «⚡ Warp - Best Ping 🚀» که دیگر
 *    ساخته نمی‌شود (tagGroup خالی → urltest حذف) → کلاینت کل پروفایل را رد
 *    می‌کند («outbound not found» در بوت).
 *  - clash: گروه «✅ Selector» با proxies: [] → mihomo کانفیگ را رد می‌کند.
 *  - xray: balancer «all-proxies» با selector ['proxy'] بدون هیچ proxy-* →
 *    کانفیگ لود می‌شود ولی هیچ مسیری انتخاب نمی‌شود (ساب مرده).
 *
 * فیکس (قرارداد v0.8.23 برای warpAccounts، این‌بار برای endpoints):
 *  ۱) ولیدیتور: حداقل یک endpoint (هم‌تراز با «حداقل یک پورت TLS»).
 *  ۲) مرزِ لود KV: آرایه‌ی خالی/ناقص → heal در حافظه به endpoint پیش‌فرض؛
 *     blobهای باستان و دست‌نویس هم پوشش داده می‌شوند.
 *
 * اثبات با «صحت ارجاعی»: هر detour/عضو گروه/balancer-selector باید به تگی
 * اشاره کند که واقعاً در خروجی وجود دارد — روی کد قدیمی دقیقاً همین‌جا قرمز است.
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
(globalThis as any).VERSION = '0.8.65';
(globalThis as any)._repo_ = 'https://github.com/CheginiSoroush/flash-panel';
(globalThis as any)._project_SM_ = 'flash';
(globalThis as any)._project_ = 'flash';
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
    // WARP registration در تست نباید شبکه واقعی بخورد — خطای ساختاری برمی‌گردد
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

let store: Map<string, string>;
let setSettings: typeof import('../src/settings/settings')['setSettings'];
let getKvSettings: typeof import('../src/settings/settings')['getKvSettings'];
let getSettings: typeof import('../src/settings/settings')['getSettings'];
let invalidateDatasetCache: typeof import('../src/settings/kv')['invalidateDatasetCache'];
let getSbWarpConfig: typeof import('../src/cores/sing-box/configs')['getSbWarpConfig'];
let getClWarpConfig: typeof import('../src/cores/clash/configs')['getClWarpConfig'];
let getXrWarpConfigs: typeof import('../src/cores/xray/configs')['getXrWarpConfigs'];
let validateSettings: typeof import('../src/settings/validators')['validateSettings'];

async function applyKvOverrides(overrides: Record<string, unknown>) {
    const current = JSON.parse(JSON.stringify(getKvSettings()));
    const merged = { ...current, ...overrides, panelVersion: '0.3.8' };
    store.set('proxySettings', JSON.stringify(merged));
    invalidateDatasetCache();
    await setSettings({ kv: { get: (k: string, o?: any) => Promise.resolve(store.has(k) ? (o?.type === 'json' ? JSON.parse(store.get(k)!) : store.get(k)) : null), put: (k: string, v: string) => { store.set(k, v); }, delete: (k: string) => { store.delete(k); } } } as unknown as Env);
}

describe('warpEndpoints خالی — sing-box (صحت ارجاعی، v0.8.65)', () => {
    beforeAll(async () => {
        const mock = createKvMock();
        store = mock.store;

        const settings = await import('../src/settings/settings');
        setSettings = settings.setSettings;
        getKvSettings = settings.getKvSettings;
        getSettings = settings.getSettings;
        ({ invalidateDatasetCache } = await import('../src/settings/kv'));
        ({ getSbWarpConfig } = await import('../src/cores/sing-box/configs'));
        ({ validateSettings } = await import('../src/settings/validators'));

        await settings.init(
            new Request('https://example.com/sp/sub/normal'),
            { kv: mock.kv } as unknown as Env
        );
        await setSettings({ kv: mock.kv } as unknown as Env);
    });

    beforeEach(async () => {
        await applyKvOverrides({});
    });

    it('endpoints=[] — heal به پیش‌فرض (RED روی کد قدیمی: خالی می‌ماند)', async () => {
        await applyKvOverrides({ warpEndpoints: [] });

        // کد قدیمی: [] عیناً به getSettings می‌رسد → صفر outbound در ساب‌های warp
        expect(getSettings().warpEndpoints).toEqual(['engage.cloudflareclient.com:2408']);
    });

    it('endpoints=[] — هر detour/عضو گروه به تگی موجود اشاره می‌کند (RED روی قدیمی)', async () => {
        await applyKvOverrides({ warpEndpoints: [] });

        const config = JSON.parse(await (await getSbWarpConfig()).text());

        const tags = new Set<string>();
        for (const outbound of config.outbounds ?? []) tags.add(outbound.tag);
        for (const endpoint of config.endpoints ?? []) tags.add(endpoint.tag);

        // DNS — detour هر سرور باید outbound/گروه موجود باشد
        for (const server of config.dns?.servers ?? []) {
            if (server.detour) expect(tags.has(server.detour)).toBe(true);
        }
        // outbounds — detour زنجیره‌ای
        for (const outbound of config.outbounds ?? []) {
            if (outbound.detour) expect(tags.has(outbound.detour)).toBe(true);
        }
        // گروه‌ها — اعضای selector/urltest
        for (const group of config.outbounds ?? []) {
            if (Array.isArray(group.outbounds)) {
                expect(group.outbounds.length).toBeGreaterThanOrEqual(1);
                for (const member of group.outbounds) expect(tags.has(member)).toBe(true);
            }
        }
        // endpoints — detour زنجیره‌ی WoW
        for (const endpoint of config.endpoints ?? []) {
            if (endpoint.detour) expect(tags.has(endpoint.detour)).toBe(true);
        }
    });

    it('endpoints سفارشی — heal دست‌نمی‌زند و ارجاع‌ها سالم می‌مانند (گارد)', async () => {
        await applyKvOverrides({ warpEndpoints: ['alt.example.com:2408'] });

        expect(getSettings().warpEndpoints).toEqual(['alt.example.com:2408']);

        const config = JSON.parse(await (await getSbWarpConfig()).text());
        const tags = new Set<string>();
        for (const outbound of config.outbounds ?? []) tags.add(outbound.tag);
        for (const endpoint of config.endpoints ?? []) tags.add(endpoint.tag);

        for (const server of config.dns?.servers ?? []) {
            if (server.detour) expect(tags.has(server.detour)).toBe(true);
        }
        const wireguardEndpoints = (config.endpoints ?? []).filter((e: any) => e.type === 'wireguard');
        expect(wireguardEndpoints.length).toBeGreaterThanOrEqual(2); // Warp + WoW
    });

    it('ولیدیتور — endpoints خالی رد می‌شود (هم‌تراز «حداقل یک پورت TLS»)', async () => {
        // پایه‌ی فرم باید PanelSettings کامل باشد (فیلدهایی مثل proxyIPs دارد)
        // — merged snapshot همان شکلی است که پنل به ولیدیتور می‌فرستد
        const form = JSON.parse(JSON.stringify(getSettings())) as any;
        form.warpEndpoints = [];

        const errors = validateSettings(form);
        const endpointError = (errors ?? []).find(e => e.field === 'Warp Endpoints');
        expect(endpointError).toBeDefined();
    });
});

describe('warpEndpoints خالی — clash و xray (صحت ارجاعی، v0.8.65)', () => {
    beforeAll(async () => {
        const mock = createKvMock();
        store = mock.store;

        const settings = await import('../src/settings/settings');
        setSettings = settings.setSettings;
        getKvSettings = settings.getKvSettings;
        ({ invalidateDatasetCache } = await import('../src/settings/kv'));
        ({ getClWarpConfig } = await import('../src/cores/clash/configs'));
        ({ getXrWarpConfigs } = await import('../src/cores/xray/configs'));

        await settings.init(
            new Request('https://example.com/sp/sub/normal'),
            { kv: mock.kv } as unknown as Env
        );
        await setSettings({ kv: mock.kv } as unknown as Env);
    });

    beforeEach(async () => {
        await applyKvOverrides({});
    });

    it('clash: endpoints=[] — هیچ گروهی proxies خالی ندارد (RED روی قدیمی)', async () => {
        await applyKvOverrides({ warpEndpoints: [] });

        const config = JSON.parse(await (await getClWarpConfig(false)).text());

        const proxyNames = new Set<string>((config.proxies ?? []).map((p: any) => p.name));
        const groups = config['proxy-groups'] ?? [];
        expect(groups.length).toBeGreaterThanOrEqual(1);
        for (const group of groups) {
            expect((group.proxies ?? []).length).toBeGreaterThanOrEqual(1);
            for (const member of group.proxies ?? []) {
                // عضو گروه باید پروکسی موجود یا گروه موجود باشد
                const isGroup = groups.some((g: any) => g.name === member);
                expect(proxyNames.has(member) || isGroup).toBe(true);
            }
        }
    });

    it('xray: endpoints=[] — balancer با selector خالی نیست (RED روی قدیمی)', async () => {
        await applyKvOverrides({ warpEndpoints: [] });

        const configs: any[] = JSON.parse(await (await getXrWarpConfigs(false, false)).text());
        expect(configs.length).toBeGreaterThanOrEqual(1);

        for (const config of configs) {
            const tags = new Set<string>((config.outbounds ?? []).map((o: any) => o.tag));
            for (const balancer of config.routing?.balancers ?? []) {
                const matched = (balancer.selector ?? []).flatMap((prefix: string) =>
                    [...tags].filter(tag => tag.startsWith(prefix)));
                // کد قدیمی: balancer all-proxies با صفر outbound منطبق
                expect(matched.length).toBeGreaterThanOrEqual(1);
            }
        }
    });
});
