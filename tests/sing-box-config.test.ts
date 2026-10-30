import { describe, it, expect, beforeAll, vi } from 'vitest';

/**
 * تست‌های تولید کانفیگ sing-box (لایه‌ی cores/sing-box) — بدون شبکه.
 *
 * رگرسیون v0.8.24 — بدنه‌های اشتراک sing-box باید «فشرده» باشند:
 * JSON.stringify بدون تورفتگی (قبلاً null,4 بود — ~۳۰٪ بدنه‌ی بزرگ‌تر
 * بدون هیچ سودی برای کلاینت‌های sing-box/mihomo/Hiddify).
 * + گارد ساختاری: نودها/گروه‌ها/endpoints سالم و شمارش درست.
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

// ---------- KV mock (دو اکانت warp — همان حالت واقعی پنل) ----------

const WARP_ACCOUNTS = [
    {
        privateKey: '4NyxMUme2zGv5r3QWI0hJBlNglm1J/thoCE55PK29G8=',
        publicKey: 'bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=',
        warpIPv6: '2606:4700:110:8fd2:11f3:8e67:11d4:3704/128',
        reserved: 'N16D'
    },
    {
        privateKey: 'aPQwXZBOndL0km0Swo0ArDOoy3bjeZzTu+/d4YHxW04=',
        publicKey: 'bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=',
        warpIPv6: '2606:4700:110:859d:1029:4dfa:bf63:ff08/128',
        reserved: 'SmWi'
    }
];

const store = new Map<string, string>([
    ['warpAccounts', JSON.stringify(WARP_ACCOUNTS)]
]);

const kvMock = {
    async get(key: string, opts?: { type?: string }) {
        const raw = store.get(key);
        if (raw === undefined) return null;
        return opts?.type === 'json' ? JSON.parse(raw) : raw;
    },
    async put(key: string, value: string) { store.set(key, value); },
    async delete(key: string) { store.delete(key); }
} as unknown as KVNamespace;

// ---------- استاب DoH — resolveDNS بدون شبکه پاسخ قطعی می‌دهد ----------

vi.stubGlobal('fetch', vi.fn(async (input: any) => {
    const url = String(input instanceof URL ? input : input?.url ?? input);
    if (url.includes('cloudflare-dns.com')) {
        const u = new URL(url);
        const answer = u.searchParams.get('name') === 'example.com' && u.searchParams.get('type') === 'A'
            ? [{ type: 1, TTL: 300, data: '1.2.3.4' }]
            : [];
        return new Response(JSON.stringify({ Answer: answer }), {
            headers: { 'content-type': 'application/dns-json' }
        });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
}));

let getSbCustomConfig: typeof import('../src/cores/sing-box/configs')['getSbCustomConfig'];
let getSbWarpConfig: typeof import('../src/cores/sing-box/configs')['getSbWarpConfig'];

beforeAll(async () => {
    const settings = await import('../src/settings/settings');
    settings.init(
        new Request('https://example.com/sp/sub/normal?app=singbox'),
        { kv: kvMock } as unknown as Env
    );
    await settings.setSettings({ kv: kvMock } as unknown as Env);

    const configs = await import('../src/cores/sing-box/configs');
    getSbCustomConfig = configs.getSbCustomConfig;
    getSbWarpConfig = configs.getSbWarpConfig;
});

describe('getSbCustomConfig', () => {
    it('بدنه‌ی فشرده — بدون هیچ تورفتگی/خط جدید (رگرسیون pretty-print)', async () => {
        const res = await getSbCustomConfig(false);
        expect(res.status).toBe(200);

        const body = await res.text();
        expect(body.includes('\n')).toBe(false);          // تک‌خطی
        expect(body.includes('    ')).toBe(false);        // بدون تورفتگی ۴تایی
        expect(() => JSON.parse(body)).not.toThrow();     // JSON معتبر
    });

    it('ساختار سالم — نودها/Selector/urltest با شمارش درست', async () => {
        const res = await getSbCustomConfig(false);
        const config = JSON.parse(await res.text());

        // دامنه‌ها: [example.com, 1.2.3.4 (DoH stub), www.speedtest.net (cleanIP پیش‌فرض)]
        // پورت 443 × پروتکل‌های vless,trojan → ۳ میزبان × ۲ پروتکل = ۶ نود
        const nodes = config.outbounds.filter((o: any) => o.type === 'vless' || o.type === 'trojan');
        expect(nodes).toHaveLength(6);
        expect(nodes.filter((o: any) => o.type === 'vless')).toHaveLength(3);
        expect(nodes.filter((o: any) => o.type === 'trojan')).toHaveLength(3);

        // Selector همه‌ی نودها + گروه‌های غیرخالی را دارد
        const selector = config.outbounds.find((o: any) => o.tag === '✅ Selector');
        expect(selector).toBeDefined();
        expect(selector.type).toBe('selector');
        expect(selector.outbounds).toContain('⚡ Best Ping 🚀');

        // customDomain پیش‌فرض '' است → همه‌ی نودها در گروه غیر-D
        const bestPing = config.outbounds.find((o: any) => o.tag === '⚡ Best Ping 🚀');
        expect(bestPing).toBeDefined();
        expect(bestPing.type).toBe('urltest');
        expect(bestPing.outbounds).toHaveLength(6);

        // گروه‌های D و 🔗 بدون عضو → فیلتر شده‌اند (نباید urltest خالی ساخته شود)
        expect(config.outbounds.find((o: any) => o.tag === '⚡ Best Ping D 🚀')).toBeUndefined();
        expect(config.outbounds.find((o: any) => o.tag === '⚡ 🔗 Best Ping 🚀')).toBeUndefined();

        // direct با resolver
        const direct = config.outbounds.find((o: any) => o.tag === 'direct');
        expect(direct?.type).toBe('direct');
    });
});

describe('getSbWarpConfig', () => {
    it('بدنه‌ی فشرده + جفت Warp/WoW برای هر endpoint (رگرسیون pretty-print)', async () => {
        const res = await getSbWarpConfig();
        expect(res.status).toBe(200);

        const body = await res.text();
        expect(body.includes('\n')).toBe(false);
        expect(body.includes('    ')).toBe(false);
        const config = JSON.parse(body);

        // پیش‌فرض یک endpoint (engage.cloudflareclient.com:2408) → ۱ Warp + ۱ WoW
        const endpoints = config.endpoints;
        expect(endpoints).toHaveLength(2);
        expect(endpoints.every((e: any) => e.type === 'wireguard')).toBe(true);

        const [warp, wow] = endpoints;
        expect(warp.tag).toBe('⚡ 1. Warp 🇮🇷');
        expect(warp.detour).toBeUndefined();                       // Warp آزاد
        expect(warp.peers[0].port).toBe(2408);

        expect(wow.tag).toBe('⚡ 1. WoW 🌍');
        expect(wow.detour).toBe(warp.tag);                          // WoW زنجیره روی Warp
        expect(wow.peers[0].address).toBe('162.159.192.1');         // engage داخلی WoW
        expect(wow.peers[0].port).toBe(2408);

        // دو گروه urltest با یک عضو هرکدام
        const warpGroup = config.outbounds.find((o: any) => o.tag === '⚡ Warp - Best Ping 🚀');
        const wowGroup = config.outbounds.find((o: any) => o.tag === '⚡ WoW - Best Ping 🚀');
        expect(warpGroup?.outbounds).toEqual([warp.tag]);
        expect(wowGroup?.outbounds).toEqual([wow.tag]);
    });
});
