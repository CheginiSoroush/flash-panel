import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

/**
 * v0.8.51 — زنجیره‌ی خراب هرگز نباید کل ساب clash normal را ۵۰۰ کند
 * (getClNormalConfig در src/cores/clash/configs.ts)
 *
 * کلاس باگ: buildChainOutbound روی داده‌ی زنجیره‌ی خراب پرتاب می‌کند —
 *   • new URL(chainProxy) برای رشته‌ی غیر-URL
 *   • JSON.parse(base64DecodeUtf8(url.host)) برای لینک vmess با host غیر-Base64
 * و این پرتاب از getClNormalConfig بیرون می‌پرید → کل ساب clash normal
 * (پرکاربردترین نوع ساب) ۵۰۰ می‌شد، بدون هیچ مسیر خودترمیمی.
 *
 * مسیر رسیدن داده‌ی خراب: ولیدیتور ذخیره‌ی پنل new URL/JSON.parse را گارد کرده
 * (ValidationError تمیز) — ولی blobهای KV باستان از پیش از ولیدیتور، بازیابی
 * بکاپ قدیمی یا هر نویسنده‌ی آینده‌ای که از ولیدیتور عبور نکند، می‌توانند
 * chainProxy خراب بگذارند. قرارداد fail-soft کد‌بیس: قابلیت اختیاریِ خراب
 * خودش حذف می‌شود، ساب سرو می‌شود (هم‌راستا با parseHostPort → direct،
 * resolveDNS → null، ساب سفارشی مرده → حذف محتوا در v0.8.50).
 *
 * استراتژی تست: تنظیمات با KV-mock (نه validateSettings — دقیقاً مسیر «از
 * ولیدیتور عبور نکرده») → getClNormalConfig واقعی باید ۲۰۰ بدهد و بدون گره
 * زنجیره سرو کند. روی کد قدیمی پرتاب → قرمز. گارد: chainProxy سالم با
 * chainProxyParams مشتق‌شده (همان کاری که merge می‌کند) → گره‌های زنجیره با
 * dialer-proxy سر جایشان.
 */

// ---------- globals زنجیره‌ی import (الگوی sub-body-purity.test.ts) ----------
(globalThis as any).VERSION = '0.8.51';
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

// ---------- استاب DoH — جواب ثابت (الگوی sub-etag-dns.test.ts) ----------
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
let clashMod: typeof import('../src/cores/clash/configs');
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

async function genNormal(): Promise<{ status: number; config: any }> {
    const res = await clashMod.getClNormalConfig();
    const body = await res.text();
    return { status: res.status, config: JSON.parse(body) };
}

describe('clash chain fail-soft (v0.8.51 contract)', () => {
    beforeAll(async () => {
        settingsMod = await import('../src/settings/settings');
        kvMod = await import('../src/settings/kv');
        clashMod = await import('../src/cores/clash/configs');
        utilsMod = await import('../src/cores/utils');

        settingsMod.init(
            new Request('https://example.com/sp/sub/normal', {
                headers: { 'User-Agent': 'ClashForAndroid/2.5.12' }
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

    it('a partial legacy chainProxyParams blob (no server) cannot 500 the whole sub', async () => {
        const { setSettings } = settingsMod;
        // سناریوی واقعی blob باستان: chainProxy ولیِ URL سالم، ولی chainProxyParams
        // ناقص (protocol هست، server نیست — شکلِ مشتق‌سازیِ نسخه‌ی قدیمی یا نوشته‌ی
        // معیوب). روی کد قدیمی buildOutbound در server.replace پرتاب می‌کند → ۵۰۰.
        await setSettings({ kv: kvMockWithSettings({ chainProxy: 'vmess://eyJhZGQiOiJleGFtcGxlLmNvbSJ9', chainProxyParams: { protocol: 'vmess', port: 443 } }) } as unknown as Env);

        const { status, config } = await genNormal();
        expect(status).toBe(200);
        // بدون زنجیره — هیچ گره‌ای dialer-proxy ندارد
        const chained = (config.proxies as any[]).filter(p => 'dialer-proxy' in p);
        expect(chained.length).toBe(0);
        // گروه زنجیره هم خالی مانده → حذف شده (buildConfig گروه‌های خالی را می‌ریزد)
        const groupNames = (config['proxy-groups'] as any[]).map(g => g.name);
        expect(groupNames).not.toContain('⚡ 🔗 Best Ping 🚀');
    });

    it('an entirely unparseable chainProxy URL cannot 500 the whole sub', async () => {
        const { setSettings } = settingsMod;
        await setSettings({ kv: kvMockWithSettings({ chainProxy: 'http://[::1' }) } as unknown as Env);

        const { status, config } = await genNormal();
        expect(status).toBe(200);
        const chained = (config.proxies as any[]).filter(p => 'dialer-proxy' in p);
        expect(chained.length).toBe(0);
    });

    it('guard — a healthy vless chain still produces dialer-proxy chain nodes', async () => {
        const { setSettings } = settingsMod;
        // همان کاری که merge در مسیر واقعی می‌کند: مشتق‌سازی chainProxyParams از chainProxy
        const chainParams = utilsMod.extractProxyParams(VALID_VLESS_CHAIN);
        await setSettings({ kv: kvMockWithSettings({ chainProxy: VALID_VLESS_CHAIN, chainProxyParams: chainParams }) } as unknown as Env);

        const { status, config } = await genNormal();
        expect(status).toBe(200);
        const chained = (config.proxies as any[]).filter(p => 'dialer-proxy' in p);
        expect(chained.length).toBeGreaterThan(0);
        expect(chained[0].server).toBe('chain.example.com');
        // گروه زنجیره با گره‌های زنجیره پر شده
        const chainGroup = (config['proxy-groups'] as any[]).find(g => g.name === '⚡ 🔗 Best Ping 🚀');
        expect(chainGroup.proxies.length).toBe(chained.length);
    });
});
