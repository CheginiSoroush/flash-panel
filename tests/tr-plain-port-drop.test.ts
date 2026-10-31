import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

/**
 * v0.8.63 — trojan روی پورت non-TLS تولید نمی‌شود (پاریتی چهار هسته).
 *
 * کلاس باگ: clash از همیشه برای trojan روی پورت non-TLS مقدار null برمی‌گرداند
 * (src/cores/clash/outbounds.ts — `if (protocol === _TR_ && !isTLS) return null`)
 * اما سه مولد دیگر — xray، sing-box و ساب raw — کانفیگ trojan بدون TLS تولید
 * می‌کردند. trojan کل مدل امنیتی‌اش بر TLS بنا شده: بدون TLS هش sha224 رمز
 * به‌صورت plaintext روی سیم می‌رود — قابل کپچر و replay توسط هر ناظر مسیر
 * (همان سانسوری که کاربر از آن فرار می‌کند) و برای DPI یک‌نگاهی قابل‌تشخیص.
 * VLESS پلین عمداً می‌ماند (header رمزنگاری‌ناپذیر بخشی از طراحی VLESS است).
 *
 * سطح رسیدن باگ: فقط وقتی پورت non-TLS عضو ports باشد — و چون هر چهار مولد
 * پورت‌های non-TLS را فقط برای دامنه‌ی workers.dev نگه می‌دارند (فیلتر
 * `domain.endsWith('workers.dev') || isHttps(port)`)، سناریوی واقعی یعنی
 * mainDomain از نوع workers.dev + پورت ۸۰/۸۰۸۰/… در پنل. validatePorts فقط
 * «حداقل یک پورت TLS» می‌خواهد — یعنی این ترکیب از نظر پنل معتبر و رایج است.
 *
 * استثنای محفوظ: جفت upstream — `address === upstreamServer` همیشه TLS
 * می‌گیرد حتی روی پورت non-TLS (سرور خودِ کاربر؛ قرارداد فیکس‌های upstream
 * از v0.8.52/53/62) — این تست گارد می‌شود که فیکس جدید upstream را هم نیندازد.
 *
 * تست‌ها با همان الگوی upstream-pair-clash-common.test.ts (init واقعی settings
 * + KV mock + استاب DoH سطح fetch).
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
    // ⚠️ باید workers.dev باشد — پورت‌های non-TLS فقط برای این دامنه‌ها
    // وارد مولدها می‌شوند (فیلتر totalPorts در هر چهار هسته)
    mainDomain: 'test.workers.dev',
    fallback: '',
    dohUrl: ''
};

(globalThis as any).EMBEDED_SETTINGS = MOCK_EMBEDED;
(globalThis as any).VERSION = '0.8.63';
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
let getXrCustomConfigs: typeof import('../src/cores/xray/configs')['getXrCustomConfigs'];
let getSbCustomConfig: typeof import('../src/cores/sing-box/configs')['getSbCustomConfig'];
let getURLConfigs: typeof import('../src/cores/common')['getURLConfigs'];

async function applyKvOverrides(overrides: Record<string, unknown>) {
    const current = JSON.parse(JSON.stringify(getKvSettings()));
    const merged = { ...current, ...overrides, panelVersion: '0.3.8' };
    store.set('proxySettings', JSON.stringify(merged));
    invalidateDatasetCache();
    await setSettings({ kv: { get: (k: string, o?: any) => Promise.resolve(store.has(k) ? (o?.type === 'json' ? JSON.parse(store.get(k)!) : store.get(k)) : null), put: (k: string, v: string) => { store.set(k, v); }, delete: (k: string) => { store.delete(k); } } } as unknown as Env);
}

type XrConfig = { outbounds?: Array<{ protocol?: string; streamSettings?: { security?: string }; settings?: { servers?: Array<{ address: string; port: number }> } }> };

async function xrayOutbounds(): Promise<NonNullable<XrConfig['outbounds']>> {
    const configs: XrConfig[] = JSON.parse(await (await getXrCustomConfigs(false)).text());
    return configs.flatMap(config => config.outbounds ?? []);
}

async function sbOutbounds(): Promise<Array<{ type?: string; server?: string; server_port?: number; tls?: { enabled?: boolean } }>> {
    const body = await (await getSbCustomConfig(false)).text();
    return JSON.parse(body).outbounds ?? [];
}

/** ساب raw را decode و خط‌به‌خط می‌کند (هر خط یک URI) */
async function rawLines(): Promise<string[]> {
    const body = await (await getURLConfigs()).text();
    return Buffer.from(body, 'base64').toString('utf8').split('\n').filter(Boolean);
}

describe('xray — trojan on non-TLS port dropped (v0.8.63)', () => {
    beforeAll(async () => {
        const mock = createKvMock();
        store = mock.store;

        const settings = await import('../src/settings/settings');
        setSettings = settings.setSettings;
        getKvSettings = settings.getKvSettings;
        ({ invalidateDatasetCache } = await import('../src/settings/kv'));
        ({ getXrCustomConfigs } = await import('../src/cores/xray/configs'));

        await settings.init(
            new Request('https://test.workers.dev/sp/sub/normal'),
            { kv: mock.kv } as unknown as Env
        );
        await setSettings({ kv: mock.kv } as unknown as Env);
    });

    beforeEach(async () => {
        await applyKvOverrides({});
    });

    it('plain-port profile: zero plaintext trojans, TLS trojans intact, vless-plain kept (RED on old)', async () => {
        // پورت ۸۰ روی workers.dev وارد مولد می‌شود ولی TLS نیست
        await applyKvOverrides({ ports: [80, 443] });

        const outbounds = await xrayOutbounds();

        // کد قدیمی: trojan با security 'none' روی پورت ۸۰ — هش رمز plaintext
        const plainTrojans = outbounds.filter(o => o.protocol === 'trojan' && o.streamSettings?.security !== 'tls');
        expect(plainTrojans.length).toBe(0);

        // trojan روی ۴۴۳ سالم می‌ماند
        expect(outbounds.filter(o => o.protocol === 'trojan' && o.streamSettings?.security === 'tls').length).toBeGreaterThanOrEqual(1);

        // گارد: vless پلین عمداً می‌ماند (feature، نه باگ)
        expect(outbounds.filter(o => o.protocol === 'vless' && o.streamSettings?.security === 'none').length).toBeGreaterThanOrEqual(1);
        expect(outbounds.filter(o => o.protocol === 'vless' && o.streamSettings?.security === 'tls').length).toBeGreaterThanOrEqual(1);
    });

    it('upstream trojan on a plain port survives with TLS (guard — upstream contract)', async () => {
        await applyKvOverrides({
            ports: [80, 443],
            upstreamParams: { upstreamServer: 'up.example.com', upstreamPort: 80 }
        });

        const outbounds = await xrayOutbounds();

        // قرارداد upstream: TLS حتی روی پورت non-TLS (address === upstreamServer)
        const upstreamTrojan = outbounds.find(o =>
            o.protocol === 'trojan'
            && o.settings?.servers?.[0]?.address === 'up.example.com'
            && o.settings?.servers?.[0]?.port === 80
        );
        expect(upstreamTrojan).toBeDefined();
        expect(upstreamTrojan?.streamSettings?.security).toBe('tls');
    });

    it('all-TLS ports=[443]: unchanged (regression guard)', async () => {
        await applyKvOverrides({ ports: [443] });

        const outbounds = await xrayOutbounds();

        expect(outbounds.filter(o => o.protocol === 'trojan' && o.streamSettings?.security !== 'tls').length).toBe(0);
        expect(outbounds.filter(o => o.protocol === 'vless' && o.streamSettings?.security !== 'tls').length).toBe(0);
        expect(outbounds.filter(o => o.protocol === 'trojan' && o.streamSettings?.security === 'tls').length).toBeGreaterThanOrEqual(1);
    });
});

describe('sing-box — trojan on non-TLS port dropped (v0.8.63)', () => {
    beforeAll(async () => {
        const mock = createKvMock();
        store = mock.store;

        const settings = await import('../src/settings/settings');
        setSettings = settings.setSettings;
        getKvSettings = settings.getKvSettings;
        ({ invalidateDatasetCache } = await import('../src/settings/kv'));
        ({ getSbCustomConfig } = await import('../src/cores/sing-box/configs'));

        await settings.init(
            new Request('https://test.workers.dev/sp/sub/normal'),
            { kv: mock.kv } as unknown as Env
        );
        await setSettings({ kv: mock.kv } as unknown as Env);
    });

    beforeEach(async () => {
        await applyKvOverrides({});
    });

    it('plain-port profile: zero plaintext trojans, TLS trojans intact, vless-plain kept (RED on old)', async () => {
        await applyKvOverrides({ ports: [80, 443] });

        const outbounds = await sbOutbounds();

        // کد قدیمی: trojan بدون tls روی پورت ۸۰
        const plainTrojans = outbounds.filter(o => o.type === 'trojan' && o.tls?.enabled !== true);
        expect(plainTrojans.length).toBe(0);

        expect(outbounds.filter(o => o.type === 'trojan' && o.tls?.enabled === true).length).toBeGreaterThanOrEqual(1);

        // گارد: vless پلین عمداً می‌ماند
        expect(outbounds.filter(o => o.type === 'vless' && !o.tls?.enabled).length).toBeGreaterThanOrEqual(1);
        expect(outbounds.filter(o => o.type === 'vless' && o.tls?.enabled === true).length).toBeGreaterThanOrEqual(1);
    });

    it('upstream trojan on a plain port survives with TLS (guard — upstream contract)', async () => {
        await applyKvOverrides({
            ports: [80, 443],
            upstreamParams: { upstreamServer: 'up.example.com', upstreamPort: 80 }
        });

        const outbounds = await sbOutbounds();

        const upstreamTrojan = outbounds.find(o =>
            o.type === 'trojan' && o.server === 'up.example.com' && o.server_port === 80
        );
        expect(upstreamTrojan).toBeDefined();
        expect(upstreamTrojan?.tls?.enabled).toBe(true);
    });

    it('all-TLS ports=[443]: unchanged (regression guard)', async () => {
        await applyKvOverrides({ ports: [443] });

        const outbounds = await sbOutbounds();

        expect(outbounds.filter(o => o.type === 'trojan' && o.tls?.enabled !== true).length).toBe(0);
        expect(outbounds.filter(o => o.type === 'vless' && o.tls?.enabled !== true).length).toBe(0);
        expect(outbounds.filter(o => o.type === 'trojan' && o.tls?.enabled === true).length).toBeGreaterThanOrEqual(1);
    });
});

describe('raw sub — trojan on non-TLS port dropped (v0.8.63)', () => {
    beforeAll(async () => {
        const mock = createKvMock();
        store = mock.store;

        const settings = await import('../src/settings/settings');
        setSettings = settings.setSettings;
        getKvSettings = settings.getKvSettings;
        ({ invalidateDatasetCache } = await import('../src/settings/kv'));
        ({ getURLConfigs } = await import('../src/cores/common'));

        await settings.init(
            new Request('https://test.workers.dev/sp/sub/normal'),
            { kv: mock.kv } as unknown as Env
        );
        await setSettings({ kv: mock.kv } as unknown as Env);
    });

    beforeEach(async () => {
        await applyKvOverrides({});
    });

    it('plain-port profile: zero security=none trojan lines, TLS trojans intact, vless-plain kept (RED on old)', async () => {
        await applyKvOverrides({ ports: [80, 443] });

        const lines = await rawLines();

        // کد قدیمی: trojan://...?security=none روی پورت ۸۰
        const plainTrojans = lines.filter(l => l.startsWith('trojan://') && l.includes('security=none'));
        expect(plainTrojans.length).toBe(0);

        expect(lines.filter(l => l.startsWith('trojan://') && l.includes('security=tls')).length).toBeGreaterThanOrEqual(1);

        // گارد: vless پلین عمداً می‌ماند
        expect(lines.filter(l => l.startsWith('vless://') && l.includes('security=none')).length).toBeGreaterThanOrEqual(1);
        expect(lines.filter(l => l.startsWith('vless://') && l.includes('security=tls')).length).toBeGreaterThanOrEqual(1);
    });

    it('upstream trojan on a plain port survives with TLS (guard — upstream contract)', async () => {
        await applyKvOverrides({
            ports: [80, 443],
            upstreamParams: { upstreamServer: 'up.example.com', upstreamPort: 80 }
        });

        const lines = await rawLines();

        const upstreamTrojan = lines.find(l => l.startsWith('trojan://') && l.includes('@up.example.com:80'));
        expect(upstreamTrojan).toBeDefined();
        expect(upstreamTrojan).toContain('security=tls');
    });

    it('all-TLS ports=[443]: unchanged (regression guard)', async () => {
        await applyKvOverrides({ ports: [443] });

        const lines = await rawLines();

        expect(lines.filter(l => l.startsWith('trojan://') && l.includes('security=none')).length).toBe(0);
        expect(lines.filter(l => l.startsWith('vless://') && l.includes('security=none')).length).toBe(0);
        expect(lines.filter(l => l.startsWith('trojan://') && l.includes('security=tls')).length).toBeGreaterThanOrEqual(1);
    });
});
