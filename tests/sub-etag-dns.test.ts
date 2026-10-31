import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';


/**
 * v0.8.41 — ETag اشتراک باید رکوردهای DNS دامنه‌ها را هم پوشش دهد
 * (src/handlers/subscription.ts + src/cores/utils.ts)
 *
 * کلاس باگ: بدنه‌ی ساب‌های normal/fragment/raw از طریق getConfigAddresses جواب
 * DoH (رکوردهای A/AAAA دامنه‌ها) را embed می‌کند — ولی computeSubETag فقط
 * { نسخه، مسیر، کلاینت، کاربر، settings، اکانت‌های WARP } را هش می‌کرد. جواب
 * رزالور خارج از settings عوض می‌شود → بدنه‌ی نو با ETag کهنه:
 *   • کلاینت شرطی (If-None-Match — همه‌ی کلاینت‌های حرفه‌ای ETag می‌فهمند)
 *     → 304 → مجموعه‌ی IP قدیمی تا وقتی ورودی دیگری ETag را عوض کند.
 *   • دقیقاً همان کلاس «304 ابدی» که v0.8.31 برای اکانت‌های WARP بسته شد.
 *
 * قرارداد نو (دو نیمه‌ی مکمل):
 *   1. نرمال‌سازی getConfigAddresses (مرتب‌سازی + حذف تکرار رکوردها) — رزالور
 *      ترتیب را تضمین نمی‌کند؛ بدون این، همان مجموعه با ترتیب چرخان بدنه‌ی
 *      متفاوت می‌ساخت و ETag ثابت می‌ماند (ناسازگاری) یا با هشِ خامِ DNS،
 *      ETag مدام می‌چرخید (شور 304). حالا بدنه تابعِ صرفِ «مجموعه» است.
 *   2. اثر انگشت DNS (همان نرمال‌سازی) داخل ETag — فقط برای مسیرهای
 *      DNS-دار (normal/fragment/raw)؛ خانواده‌ی warp اندپوینت ثابت دارد و
 *      share-settings فقط settings — بدون کوئری DNS اضافه و بدون churn.
 *   تاب‌آوری: خطای DNS سرد در ETag → null (نه پرتاب) — کلاینتِ دارای بدنه‌ی
 *   سالم در قطعی DoH همان 304 را می‌گیرد و کانفیگ کارش ادامه دارد.
 *
 * استراتژی تست: استاب DoH سطح fetch (الگوی xray-dns-ipv6.test.ts) — resolveDNS
 * واقعی (کش/single-flight) بدون شبکه اجرا می‌شود؛ clearDnsCache بین نسل‌ها.
 */

(globalThis as any).VERSION = '0.8.41';
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

// ---------- استاب DoH — جواب‌های قابل‌تغییر در زمان اجرا ----------

const dohState = {
    a: ['1.2.3.4'] as string[],       // رکوردهای A
    aaaa: ['2606:4700:4700::1111'] as string[],  // رکوردهای AAAA
    dead: false                        // شبیه‌سازی قطعی DoH
};

vi.stubGlobal('fetch', vi.fn(async (input: any) => {
    const url = String(input instanceof URL ? input : input?.url ?? input);
    if (url.includes('cloudflare-dns.com')) {
        if (dohState.dead) throw new Error('doh down');
        const type = new URL(url).searchParams.get('type');
        const records = type === 'A' ? dohState.a : dohState.aaaa;
        return new Response(JSON.stringify({
            Answer: records.map(data => ({ type: type === 'A' ? 1 : 28, TTL: 300, data }))
        }), { status: 200, headers: { 'Content-Type': 'application/dns-json' } });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
}));

let computeSubETag: typeof import('../src/handlers/subscription').computeSubETag;
let getConfigAddresses: typeof import('../src/cores/utils').getConfigAddresses;
let clearDnsCache: typeof import('../src/cores/utils').clearDnsCache;
let settingsMod: typeof import('../src/settings/settings');

describe('subscription ETag × DNS records (v0.8.41 contract)', () => {
    beforeAll(async () => {
        // import پویا — بعد از ست‌شدن globals (الگوی sub-etag-warp.test.ts)
        settingsMod = await import('../src/settings/settings');
        ({ computeSubETag } = await import('../src/handlers/subscription'));
        ({ getConfigAddresses, clearDnsCache } = await import('../src/cores/utils'));

        settingsMod.init(
            new Request('https://example.com/sp/sub/normal', {
                headers: { 'User-Agent': 'ClashForAndroid/2.5.12' }
            }),
            { kv: {} } as Env
        );
    });

    beforeEach(() => {
        clearDnsCache();
    });

    afterEach(() => {
        dohState.a = ['1.2.3.4'];
        dohState.aaaa = ['2606:4700:4700::1111'];
        dohState.dead = false;
        clearDnsCache();
    });

    it('ETag changes when the resolved DNS record set changes (RED on old code)', async () => {
        const etag1 = await computeSubETag('normal', 'clash');

        // چرخش واقعی رکوردها — جواب رزالور عوض شد، settings دست نخورده
        dohState.a = ['5.6.7.8'];
        clearDnsCache();
        const etag2 = await computeSubETag('normal', 'clash');

        // کد قدیمی: ETag همان قبلی → 304 ابدی روی مجموعه‌ی IP مرده
        expect(etag2).not.toBe(etag1);
    });

    it('ETag is stable across resolver order shuffles — no churn (anti-flap guard)', async () => {
        dohState.a = ['9.9.9.9', '1.1.1.1'];
        clearDnsCache();
        const etag1 = await computeSubETag('normal', 'clash');

        // همان مجموعه، ترتیب چرخیده — رزالورهای round-robin دقیقاً همین را می‌دهند
        dohState.a = ['1.1.1.1', '9.9.9.9'];
        clearDnsCache();
        const etag2 = await computeSubETag('normal', 'clash');

        expect(etag2).toBe(etag1);
    });

    it('ETag for warp-family paths stays DNS-independent (no needless input, no churn)', async () => {
        const etag1 = await computeSubETag('warp', 'clash');

        dohState.a = ['5.6.7.8'];
        clearDnsCache();
        const etag2 = await computeSubETag('warp', 'clash');

        expect(etag2).toBe(etag1);
    });

    it('cold DoH outage in the ETag path degrades to a DNS-less ETag instead of throwing', async () => {
        dohState.dead = true;
        clearDnsCache();

        // کد شکننده: پرتاب خطا → به‌جای 304، خطای عمومی برای کلاینتی که بدنه‌ی سالم دارد
        const etag = await computeSubETag('normal', 'clash');
        expect(typeof etag).toBe('string');
        expect(etag.startsWith('"')).toBe(true);
    });

    it('getConfigAddresses normalizes resolver answers: sorted + deduped (RED on old code)', async () => {
        dohState.a = ['9.9.9.9', '1.1.1.1', '9.9.9.9'];
        clearDnsCache();

        const addrs = await getConfigAddresses('example.com', false);

        // دامنه اول؛ بعد رکوردهای A مرتب‌شده و بدون تکرار؛ دنباله‌ی customCdnAddrs
        // (پیش‌فرض embeded) سر جایش — فقط نرمال‌سازی بخش DNS مدعی است
        expect(addrs[0]).toBe('example.com');
        expect(addrs.slice(1, 3)).toEqual(['1.1.1.1', '9.9.9.9']);
        expect(addrs.filter(addr => addr === '9.9.9.9')).toHaveLength(1);
    });
});
