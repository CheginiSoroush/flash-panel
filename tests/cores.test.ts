import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

/**
 * تست‌های یکپارچگی config builders (لایه‌ی cores):
 * xray/outbounds — freedom / websocket / wireguard (warp) / chain
 * با init واقعی settings + KV mock (بدون شبکه — warpAccounts سید می‌شود)
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
(globalThis as any).VERSION = '0.3.8';

// ---------- KV mock ----------

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

// ---------- ایمپورت پویای ماژول‌های پروژه (بعد از آماده‌سازی globals) ----------

let buildFreedomOutbound: typeof import('../src/cores/xray/outbounds')['buildFreedomOutbound'];
let buildWebsocketOutbound: typeof import('../src/cores/xray/outbounds')['buildWebsocketOutbound'];
let buildWarpOutbound: typeof import('../src/cores/xray/outbounds')['buildWarpOutbound'];
let buildChainOutbound: typeof import('../src/cores/xray/outbounds')['buildChainOutbound'];
let init: typeof import('../src/settings/settings')['init'];
let setSettings: typeof import('../src/settings/settings')['setSettings'];
let getKvSettings: typeof import('../src/settings/settings')['getKvSettings'];
let invalidateDatasetCache: typeof import('../src/settings/kv')['invalidateDatasetCache'];

// ---------- راه‌اندازی ----------

let store: Map<string, string>;

async function applyKvOverrides(overrides: Record<string, unknown>) {
    // مقدار پیش‌فرض فعلی + override → نوشتن به KV → بارگذاری دوباره
    const current = JSON.parse(JSON.stringify(getKvSettings()));
    const merged = { ...current, ...overrides, panelVersion: '0.3.8' };
    store.set('proxySettings', JSON.stringify(merged));
    invalidateDatasetCache();
    await setSettings({ kv: { get: (k: string, o?: any) => Promise.resolve(store.has(k) ? (o?.type === 'json' ? JSON.parse(store.get(k)!) : store.get(k)) : null), put: (k: string, v: string) => { store.set(k, v); }, delete: (k: string) => { store.delete(k); } } } as unknown as Env);
}

beforeAll(async () => {
    const mock = createKvMock({
        warpAccounts: JSON.stringify([WARP_ACCOUNT])
    });
    store = mock.store;

    const settings = await import('../src/settings/settings');
    init = settings.init;
    setSettings = settings.setSettings;
    getKvSettings = settings.getKvSettings;
    ({ invalidateDatasetCache } = await import('../src/settings/kv'));

    const outbounds = await import('../src/cores/xray/outbounds');
    buildFreedomOutbound = outbounds.buildFreedomOutbound;
    buildWebsocketOutbound = outbounds.buildWebsocketOutbound;
    buildWarpOutbound = outbounds.buildWarpOutbound;
    buildChainOutbound = outbounds.buildChainOutbound;

    init(
        new Request('https://example.com/sp/panel?app=xray'),
        { kv: mock.kv } as unknown as Env
    );
    await setSettings({ kv: mock.kv } as unknown as Env);
});

beforeEach(async () => {
    // بازگشت به تنظیمات پیش‌فرض بین تست‌ها
    vi.unstubAllGlobals();
    await applyKvOverrides({ enableIPv6: false });
});

// ---------- freedom ----------

describe('buildFreedomOutbound', () => {
    it('بدون fragment — domainStrategy UseIPv4 و بدون finalmask', () => {
        const outbound = buildFreedomOutbound(false, false, 'direct');
        expect(outbound.protocol).toBe('freedom');
        expect(outbound.tag).toBe('direct');
        expect((outbound.settings as any).domainStrategy).toBe('UseIPv4');
        expect(outbound.streamSettings?.sockopt).toBeUndefined();
        expect(outbound.streamSettings?.finalmask).toBeUndefined();
    });

    it('با fragment — sockopt و finalmask.tcp با پارامترهای پاس‌شده', () => {
        const outbound = buildFreedomOutbound(true, false, 'frag', '10-20', '1-2', 'tlshello');
        const sockopt = outbound.streamSettings?.sockopt;
        expect(sockopt).toBeDefined();
        expect(sockopt?.happyEyeballs?.tryDelayMs).toBe(250);

        const finalmask = outbound.streamSettings?.finalmask;
        expect(finalmask?.udp).toBeUndefined();
        expect(finalmask?.tcp?.[0]?.type).toBe('fragment');
        expect(finalmask?.tcp?.[0]?.settings).toMatchObject({
            packets: 'tlshello',
            length: '10-20',
            delay: '1-2'
        });
    });

    it('با UDP noise — finalmask.udp از xrayUdpNoises ساخته می‌شود', () => {
        const outbound = buildFreedomOutbound(false, true, 'noisy');
        const noise = outbound.streamSettings?.finalmask?.udp?.[0];
        expect(noise?.type).toBe('noise');
        expect(noise?.settings?.reset).toBe('30-60');
        // پیش‌فرض: ۵ نویزه‌ی rand
        expect(noise?.settings?.noise?.length).toBe(5);
    });

    it('enableIPv6=true — domainStrategy UseIPv4v6', async () => {
        await applyKvOverrides({ enableIPv6: true });
        const outbound = buildFreedomOutbound(false, false, 'direct');
        expect((outbound.settings as any).domainStrategy).toBe('UseIPv4v6');
    });
});

// ---------- websocket ----------

describe('buildWebsocketOutbound', () => {
    it('vless روی 443 — TLS با sni دامنه و id کاربر', () => {
        const outbound = buildWebsocketOutbound('proxy', 'vless', 'speed.example.com', 443, 'panel.example.com', false);
        expect(outbound.protocol).toBe('vless');
        expect(outbound.tag).toBe('proxy');

        const vnext = (outbound.settings as any).vnext;
        expect(vnext?.[0]?.address).toBe('speed.example.com');
        expect(vnext?.[0]?.port).toBe(443);
        expect(vnext?.[0]?.users?.[0]?.id).toBe(MOCK_EMBEDED.vlUUID);

        const stream = outbound.streamSettings!;
        expect(stream.network).toBe('ws');
        expect(stream.security).toBe('tls');
        expect(stream.tlsSettings?.serverName?.toLowerCase()).toBe('panel.example.com');
        expect(stream.tlsSettings?.fingerprint).toBe('chrome');
        expect(stream.wsSettings?.host).toBe('panel.example.com');
        expect(String(stream.wsSettings?.path)).toContain('?ed=2560');
        expect(String(stream.wsSettings?.path)).toMatch(/^\/vl\//);
    });

    it('trojan روی 80 — بدون TLS و پسورد trojan', () => {
        const outbound = buildWebsocketOutbound('proxy', 'trojan', 'speed.example.com', 80, 'panel.example.com', false);
        expect(outbound.protocol).toBe('trojan');
        expect((outbound.settings as any).servers?.[0]?.password).toBe(MOCK_EMBEDED.trPass);

        const stream = outbound.streamSettings!;
        expect(stream.security).toBe('none');
        expect(stream.tlsSettings).toBeUndefined();
        expect(String(stream.wsSettings?.path)).toMatch(/^\/tr\//);
    });

    it('fragment — finalmask با طول/تاخیر پاس‌شده', () => {
        const outbound = buildWebsocketOutbound('proxy', 'vless', 'speed.example.com', 443, 'panel.example.com', true, '50-100', '5-10');
        const frag = outbound.streamSettings?.finalmask?.tcp?.[0]?.settings;
        expect(frag).toMatchObject({ packets: 'tlshello', length: '50-100', delay: '5-10' });
    });
});

// ---------- wireguard / warp ----------

function reservedFromBase64(base64: string): number[] {
    return Array.from(atob(base64), c => c.charCodeAt(0));
}

describe('buildWarpOutbound', () => {
    it('warp معمولی — endpoint پنل، keepAlive و reserved bytes', () => {
        const endpoint = 'engage.cloudflareclient.com:2408';
        const outbound = buildWarpOutbound(WARP_ACCOUNT, endpoint, false, false, false);

        expect(outbound.protocol).toBe('wireguard');
        expect(outbound.tag).toBe('proxy');
        const wg = outbound.settings as any;
        expect(wg.mtu).toBe(1280);
        expect(wg.secretKey).toBe(WARP_ACCOUNT.privateKey);
        expect(wg.peers?.[0]?.endpoint).toBe(endpoint);
        expect(wg.peers?.[0]?.keepAlive).toBe(5);
        expect(wg.reserved).toEqual(reservedFromBase64(WARP_ACCOUNT.reserved));
    });

    it('warp over warp — endpoint ثابت و dialerProxy', () => {
        const outbound = buildWarpOutbound(WARP_ACCOUNT, 'engage.cloudflareclient.com:2408', true, false, false);
        expect(outbound.tag).toBe('chain');
        expect((outbound.settings as any).peers?.[0]?.endpoint).toBe('162.159.192.1:2408');
        expect(outbound.streamSettings?.sockopt?.dialerProxy).toBe('proxy');
    });

    it('warpReservedBytes=false — reserved صفر', async () => {
        await applyKvOverrides({ warpReservedBytes: false });
        const outbound = buildWarpOutbound(WARP_ACCOUNT, 'engage.cloudflareclient.com:2408', false, false, false);
        expect((outbound.settings as any).reserved).toEqual([0, 0, 0]);
    });

    it('warp pro + knocker — نویزه‌های amnezia اعمال می‌شود', async () => {
        const outbound = buildWarpOutbound(WARP_ACCOUNT, 'engage.cloudflareclient.com:2408', false, true, true);
        const wg = outbound.settings as any;
        expect(wg.wnoise).toBe('quic');
        expect(wg.wnoisecount).toBe('10-15');
        expect(wg.wpayloadsize).toBe('5-10');
        expect(wg.wnoisedelay).toBe('1'); // toRange(1,1) → '1'
    });
});

// ---------- chain ----------

const CHAIN_TLS_WS = {
    protocol: 'vless',
    server: 'chain.example.com',
    port: 8443,
    uuid: 'chain-user-uuid',
    flow: 'xtls-rprx-vision',
    security: 'tls',
    type: 'ws',
    sni: 'sni.example.com',
    fp: 'chrome',
    host: 'chain.example.com',
    path: '/chainpath',
    alpn: 'http/1.1',
    encryption: undefined,
    user: undefined,
    pass: undefined,
    password: undefined,
    method: undefined,
    pbk: undefined,
    sid: undefined,
    spx: undefined,
    headerType: undefined,
    serviceName: undefined,
    mode: undefined,
    authority: undefined
};

describe('buildChainOutbound', () => {
    it('vless chain با TLS+ws — کاربر، sni و مسیر درست', async () => {
        await applyKvOverrides({ chainProxyParams: CHAIN_TLS_WS });
        const outbound = buildChainOutbound();
        expect(outbound).toBeDefined();
        expect(outbound!.protocol).toBe('vless');
        expect(outbound!.tag).toBe('chain');

        const vnext = (outbound!.settings as any).vnext;
        expect(vnext?.[0]?.address).toBe('chain.example.com');
        expect(vnext?.[0]?.port).toBe(8443);
        expect(vnext?.[0]?.users?.[0]?.id).toBe('chain-user-uuid');
        expect(vnext?.[0]?.users?.[0]?.flow).toBe('xtls-rprx-vision');

        const stream = outbound!.streamSettings!;
        expect(stream.security).toBe('tls');
        expect(stream.tlsSettings?.serverName).toBe('sni.example.com');
        expect(stream.wsSettings?.path).toBe('/chainpath');
        expect(outbound!.mux?.enabled).toBe(true); // vless TLS+ws → mux فعال
        expect(outbound!.mux?.concurrency).toBe(8);
    });

    it('reality chain — realitySettings با publicKey و بدون mux', async () => {
        await applyKvOverrides({
            chainProxyParams: {
                ...CHAIN_TLS_WS,
                security: 'reality',
                type: 'grpc',
                pbk: 'server-public-key',
                sid: 'abcd',
                spx: 'https://example.com',
                serviceName: 'grpcSvc'
            }
        });

        const outbound = buildChainOutbound();
        const stream = outbound!.streamSettings!;
        expect(stream.security).toBe('reality');
        expect(stream.realitySettings?.publicKey).toBe('server-public-key');
        expect(stream.realitySettings?.shortId).toBe('abcd');
        expect(stream.grpcSettings?.serviceName).toBe('grpcSvc');
        expect(outbound!.mux).toBeUndefined();
    });

    it('socks chain — user/pass', async () => {
        await applyKvOverrides({
            chainProxyParams: {
                ...CHAIN_TLS_WS,
                protocol: 'socks',
                security: 'none',
                user: 'socksUser',
                pass: 'socksPass'
            }
        });
        const outbound = buildChainOutbound();
        expect(outbound!.protocol).toBe('socks');
        const server = (outbound!.settings as any).servers?.[0];
        expect(server?.users?.[0]).toMatchObject({ user: 'socksUser', pass: 'socksPass' });
    });

    it('shadowsocks chain — method و password', async () => {
        await applyKvOverrides({
            chainProxyParams: {
                ...CHAIN_TLS_WS,
                protocol: 'shadowsocks',
                security: 'none',
                method: 'aes-128-gcm',
                password: 'ss-pass'
            }
        });
        const outbound = buildChainOutbound();
        expect(outbound!.protocol).toBe('shadowsocks');
        expect((outbound!.settings as any).servers?.[0]).toMatchObject({
            method: 'aes-128-gcm',
            password: 'ss-pass'
        });
    });

    it('trojan chain — پسورد trojan', async () => {
        await applyKvOverrides({
            chainProxyParams: {
                ...CHAIN_TLS_WS,
                protocol: 'trojan',
                security: 'none',
                password: 'chain-trojan-pass'
            }
        });
        const outbound = buildChainOutbound();
        expect(outbound!.protocol).toBe('trojan');
        expect((outbound!.settings as any).servers?.[0]?.password).toBe('chain-trojan-pass');
    });

    it('vmess chain — security auto', async () => {
        await applyKvOverrides({
            chainProxyParams: {
                ...CHAIN_TLS_WS,
                protocol: 'vmess',
                security: 'none'
            }
        });
        const outbound = buildChainOutbound();
        expect(outbound!.protocol).toBe('vmess');
        expect((outbound!.settings as any).vnext?.[0]?.users?.[0]?.security).toBe('auto');
    });

    it('پروتکل ناشناخته — undefined (کرش نمی‌کند)', async () => {
        await applyKvOverrides({
            chainProxyParams: { ...CHAIN_TLS_WS, protocol: 'nope' }
        });
        expect(buildChainOutbound()).toBeUndefined();
    });
});
