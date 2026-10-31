import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

/**
 * v0.8.54 — زنجیره‌ی خراب هرگز نباید کل ساب sing-box را ۵۰۰ کند
 * (getSbCustomConfig در src/cores/sing-box/configs.ts)
 *
 * هم‌تاب tests/clash-chain-failsoft.test.ts (v0.8.51) — همان کلاس باگ که در
 * sing-box زنده بود: buildChainOutbound روی blob زنجیره‌ی فاسد پرتاب می‌کند —
 *   • new URL(chainProxy) برای رشته‌ی غیر-URL (خط ۱۶۱ outbounds.ts)
 *   • split/JSON روی فیلدهای ناقص (alpn/path/host از blob ناقص)
 * و این پرتاب از getSbCustomConfig بیرون می‌پرید → کل ساب sing-box
 * (normal و fragment) ۵۰۰ می‌شد، بدون هیچ مسیر خودترمیمی.
 *
 * مسیر رسیدن داده‌ی خراب: ولیدیتور ذخیره‌ی پنل new URL/JSON.parse را گارد کرده
 * (ValidationError تمیز) و لود دیتاست blob را همان‌طور که هست عبور می‌دهد —
 * پس blobهای KV باستان از پیش از ولیدیتور، بازیابی بکاپ قدیمی یا هر نویسنده‌ای
 * که از ولیدیتور عبور نکند، می‌توانند chainProxy خراب بگذارند. قرارداد
 * fail-soft کد‌بیس: قابلیت اختیاریِ خراب حذف می‌شود، ساب سرو می‌شود.
 */

// ---------- globals زنجیره‌ی import (الگوی clash-chain-failsoft.test.ts) ----------
(globalThis as any).VERSION = '0.8.54';
(globalThis as any)._repo_ = 'https://github.com/CheginiSoroush/flash-panel';
(globalThis as any)._project_SM_ = 'flash';
(globalThis as any)._public_proxy_ip_ = 'bpb.yousef.isegaro.com';
(globalThis as any).EMBEDED_SETTINGS = {
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

let settingsMod: typeof import('../src/settings/settings');
let kvMod: typeof import('../src/settings/kv');
let sbMod: typeof import('../src/cores/sing-box/configs');
let utilsMod: typeof import('../src/cores/utils');

const VALID_VLESS_CHAIN = 'vless://chain-uuid@chain.example.com:443?sni=chain.example.com&security=tls&type=ws&path=%2Fchain#chain';

function kvMockWithSettings(extra: Record<string, unknown>) {
    return {
        get: async (key: string) => {
            if (key === 'proxySettings') {
                return { ...settingsMod.getKvSettings(), ...extra };
            }
            if (key === 'warpAccounts') {
                return [
                    { privateKey: 'k1', publicKey: 'p1', warpIPv6: 'v6-1', reserved: 'r1' },
                    { privateKey: 'k2', publicKey: 'p2', warpIPv6: 'v6-2', reserved: 'r2' }
                ];
            }
            return null;
        },
        put: async () => { }
    };
}

async function genSb(isFragment = false): Promise<{ status: number; config: any }> {
    const res = await sbMod.getSbCustomConfig(isFragment);
    const body = await res.text();
    return { status: res.status, config: JSON.parse(body) };
}

describe('sing-box chain fail-soft (v0.8.54 contract — clash v0.8.51 parity)', () => {
    beforeAll(async () => {
        settingsMod = await import('../src/settings/settings');
        kvMod = await import('../src/settings/kv');
        sbMod = await import('../src/cores/sing-box/configs');
        utilsMod = await import('../src/cores/utils');

        settingsMod.init(
            new Request('https://example.com/sp/sub/normal', {
                headers: { 'User-Agent': 'SFM/0.4.0' }
            }),
            { kv: {} } as Env
        );
    });

    beforeEach(() => {
        kvMod.invalidateDatasetCache();
    });

    afterEach(() => {
        kvMod.invalidateDatasetCache();
    });

    it('an entirely unparseable chainProxy URL cannot 500 the whole sing-box sub', async () => {
        const { setSettings } = settingsMod;
        // blob باستان: رشته‌ی غیر-URL — روی کد قدیمی new URL در buildChainOutbound
        // (outbounds.ts:161) پرتاب می‌کند → ۵۰۰
        await setSettings({ kv: kvMockWithSettings({ chainProxy: 'http://[::1' }) } as unknown as Env);

        const { status, config } = await genSb();
        expect(status).toBe(200);
        // بدون زنجیره — هیچ گره‌ای detour زنجیره‌ای ندارد
        const chained = (config.outbounds as any[]).filter(o => !!o.server && !!o.detour);
        expect(chained.length).toBe(0);
        // گروه زنجیره خالی مانده → در selector هم نیست
        const selector = (config.outbounds as any[]).find(o => o.tag === '✅ Selector');
        expect(selector.outbounds).not.toContain('⚡ 🔗 Best Ping 🚀');
    });

    it('a partial legacy chainProxyParams blob (no server) serves without chain (contract guard)', async () => {
        const { setSettings } = settingsMod;
        // سناریوی blob باستان: chainProxy سالم ولی chainProxyParams ناقص
        // (protocol هست، server نیست). توجه: برخلاف clash، buildOutbound در
        // sing-box عمل رشته‌ای روی server ندارد → این حالت روی کد قدیمی هم
        // پرتاب نمی‌کند؛ این تست «قرارداد» است نه RED — خروجی باید بدون
        // زنجیره (نه ۵۰۰ و نه گره مرده) سرو شود.
        await setSettings({ kv: kvMockWithSettings({ chainProxy: 'vless://uuid@old.example.com:443', chainProxyParams: { protocol: 'vless', port: 443 } } as any) } as unknown as Env);

        const { status, config } = await genSb();
        expect(status).toBe(200);
        const chained = (config.outbounds as any[]).filter(o => !!o.server && !!o.detour);
        expect(chained.length).toBe(0);
    });

    it('guard — a healthy vless chain still produces detour chain nodes', async () => {
        const { setSettings } = settingsMod;
        // همان کاری که merge در مسیر واقعی می‌کند: مشتق‌سازی chainProxyParams از chainProxy
        const chainParams = utilsMod.extractProxyParams(VALID_VLESS_CHAIN);
        await setSettings({ kv: kvMockWithSettings({ chainProxy: VALID_VLESS_CHAIN, chainProxyParams: chainParams }) } as unknown as Env);

        const { status, config } = await genSb();
        expect(status).toBe(200);
        const chained = (config.outbounds as any[]).filter(o => !!o.server && !!o.detour);
        expect(chained.length).toBeGreaterThan(0);
        expect(chained[0].server).toBe('chain.example.com');
        const selector = (config.outbounds as any[]).find(o => o.tag === '✅ Selector');
        expect(selector.outbounds).toContain('⚡ 🔗 Best Ping 🚀');
    });
});
