import { describe, it, expect, beforeAll, vi } from 'vitest';

/**
 * تست‌های تولید کانفیگ Clash (لایه‌ی cores/clash) — بدون شبکه.
 *
 * رگرسیون v0.8.22 — بدنه‌های اشتراک clash باید «فشرده» باشند:
 * JSON.stringify بدون تورفتگی (قبلاً null,4 بود — ~۳۰٪ بدنه‌ی بزرگ‌تر
 * بدون هیچ سودی برای کلاینت‌های mihomo/Verge/FlClach).
 * + گارد ساختاری: proxies/groups/rules سالم و شمارش درست نودها.
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

let getClNormalConfig: typeof import('../src/cores/clash/configs')['getClNormalConfig'];
let getClWarpConfig: typeof import('../src/cores/clash/configs')['getClWarpConfig'];
let getSettings: typeof import('../src/settings/settings')['getSettings'];

beforeAll(async () => {
    const settings = await import('../src/settings/settings');
    settings.init(
        new Request('https://example.com/sp/sub/normal?app=clash'),
        { kv: kvMock } as unknown as Env
    );
    await settings.setSettings({ kv: kvMock } as unknown as Env);

    const configs = await import('../src/cores/clash/configs');
    getClNormalConfig = configs.getClNormalConfig;
    getClWarpConfig = configs.getClWarpConfig;
    getSettings = settings.getSettings;
});

describe('getClNormalConfig', () => {
    it('بدنه‌ی فشرده — بدون هیچ تورفتگی/خط جدید (رگرسیون pretty-print)', async () => {
        const res = await getClNormalConfig();
        expect(res.status).toBe(200);

        const body = await res.text();
        expect(body.includes('\n')).toBe(false);          // تک‌خطی
        expect(body.includes('    ')).toBe(false);        // بدون تورفتگی ۴تایی
        expect(() => JSON.parse(body)).not.toThrow();     // JSON معتبر
    });

    it('ساختار سالم — نودها/گروه‌ها/قوانین با شمارش درست', async () => {
        const res = await getClNormalConfig();
        const config = JSON.parse(await res.text());

        // دامنه‌ها: [example.com, 1.2.3.4 (DoH stub), www.speedtest.net (cleanIP پیش‌فرض)]
        // پورت 443 × پروتکل‌های vless,trojan → ۳ میزبان × ۲ پروتکل = ۶ نود
        expect(getSettings().protocols).toBe('vless,trojan');
        expect(config['proxies']).toHaveLength(6);

        const types = config['proxies'].map((p: any) => p.type);
        expect(types.filter((t: string) => t === 'vless')).toHaveLength(3);
        expect(types.filter((t: string) => t === 'trojan')).toHaveLength(3);

        // گروه‌ها: Selector + گروه‌های Best-Ping خالی‌نشده
        const groupNames = config['proxy-groups'].map((g: any) => g.name);
        expect(groupNames[0]).toBe('✅ Selector');
        expect(groupNames).toContain('⚡ Best Ping 🚀');

        // Selector باید همه‌ی گروه‌ها + همه‌ی نودها را داشته باشد
        const selector = config['proxy-groups'][0];
        expect(selector.proxies).toContain('⚡ Best Ping 🚀');

        // قوانین: آخرین قانون MATCH به Selector
        const rules: string[] = config['rules'];
        expect(rules[rules.length - 1]).toBe('MATCH,✅ Selector');
    });
});

describe('getClWarpConfig', () => {
    it('بدنه‌ی فشرده + جفت Warp/WoW برای هر endpoint', async () => {
        const res = await getClWarpConfig(false);
        expect(res.status).toBe(200);

        const body = await res.text();
        expect(body.includes('\n')).toBe(false);
        const config = JSON.parse(body);

        // پیش‌فرض یک endpoint → ۱ Warp + ۱ WoW
        expect(config['proxies']).toHaveLength(2);
        expect(config['proxies'][0]['type']).toBe('wireguard');
        expect(config['proxies'][0]['dialer-proxy']).toBeUndefined(); // Warp آزاد
        expect(config['proxies'][1]['dialer-proxy']).toBe(config['proxies'][0]['name']); // WoW زنجیره
    });
});
