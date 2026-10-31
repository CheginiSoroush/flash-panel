import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';


/**
 * v0.8.42 — ماسک کیس SNI باید قطعی باشد (src/cores/utils.ts)
 *
 * کلاس باگ: selectSniHost (مصرف‌شده توسط هر ۴ مولد کور — clash/sing-box/xray و
 * لینک‌های اشتراک در cores/common.ts) برای کیسِ SNI از randomUpperCase با
 * Math.random خالص استفاده می‌کرد. یعنی دو نسل پشت‌سرهم از «همان ورودی‌ها»
 * بدنه‌ای با بایت‌های متفاوت (کیس متفاوت sni در ده‌ها پروفایل) می‌ساخت:
 *   • computeSubETag { نسخه/مسیر/کلاینت/کاربر/settings/DNS/WARP } را هش می‌کند —
 *     کیسِ SNI از هیچ‌کدام قابل‌اشتقاق نیست (خودِ RNG ورودی است!) → ETag ثابت،
 *     بدنه‌ی متغیر → کلاینت شرطی 304 می‌گیرد و کیسِ کهنه را نگه می‌دارد.
 *   • subBodyCache کلیدش خودِ ETag است — نسلی تازه با بایت‌های متفاوت زیر همان
 *     کلید بازنویسی می‌شد؛ «کلید → بدنه» دیگر تابع قطعی نبود.
 *   • دقیقاً همان کلاس ناسازگاری که v0.8.31 (اکانت‌های WARP) و v0.8.41
 *     (رکوردهای DNS) بسته بودند — این آخرین لایه‌ی RNG داخل بدنه بود.
 *
 * قرارداد نو: بیت کیس هر کاراکتر از هش محتوایی خود رشته (FNV-1a seed +
 * splitmix32 per-position) — همان رویکرد seeded‌ی pickFingerprint:
 *   • قطعی: همان ورودی → همان خروجی (بدنه = تابعِ صرفِ ورودی‌های ETag)
 *   • تنوع بین دامنه‌ها حفظ: هر دامنه الگوی کیس خودش را دارد (ضد خوشه‌بندی)
 *   • خاصیت ضد-DPI حفظ: کیسِ مخلوط (0x20-encoding) همچنان اعمال می‌شود
 *
 * استراتژی تست: واحدِ randomUpperCase + انتها-به-انتها (دو نسل کامل بدنه‌ی
 * ساب clash با استاب DoH — الگوی sub-etag-dns.test.ts — باید بایت‌به-بایت
 * برابر باشند؛ روی کد قدیمی با ده‌ها sni تصادفی عملاً حتماً متفاوت‌اند).
 */

(globalThis as any).VERSION = '0.8.42';
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

// ---------- استاب DoH — جواب ثابت (تنها متغیر مجاز بدنه حذف می‌شود) ----------

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
let randomUpperCase: typeof import('../src/cores/utils').randomUpperCase;
let clearDnsCache: typeof import('../src/cores/utils').clearDnsCache;
let getClNormalConfig: typeof import('../src/cores/clash/configs').getClNormalConfig;

describe('sub body purity × deterministic SNI case mask (v0.8.42 contract)', () => {
    beforeAll(async () => {
        settingsMod = await import('../src/settings/settings');
        ({ randomUpperCase, clearDnsCache } = await import('../src/cores/utils'));
        ({ getClNormalConfig } = await import('../src/cores/clash/configs'));

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
        clearDnsCache();
    });

    it('same input → same output across many calls (RED on old code)', () => {
        const samples = new Set<string>();
        for (let i = 0; i < 25; i++) {
            samples.add(randomUpperCase('panel.example.com'));
        }

        // کد قدیمی: هر فراخوانی کیس تازه می‌ساخت — ۲۵ نمونه ≈ همیشه متمایز
        expect(samples.size).toBe(1);
    });

    it('mask preserves case-insensitive identity and keeps mixed case (anti-DPI guard)', () => {
        for (const domain of ['panel.example.com', 'cloudflare-dns.com', 'imsoroush.top']) {
            const masked = randomUpperCase(domain);

            // DNS case-insensitive است — هویت دامنه باید دست‌نخورده بماند
            expect(masked.toLowerCase()).toBe(domain);
            // 0x20-encoding باید واقعاً مخلوط باشد (نمونه‌های ۱۳-۱۸ کاراکتری)
            expect(masked).toMatch(/[A-Z]/);
        }
    });

    it('different domains get different case patterns — no clustering collapse', () => {
        const patterns = ['one.example.com', 'two.example.com', 'three.example.com']
            .map(domain => randomUpperCase(domain));

        // ضد خوشه‌بندی: همه‌ی پروفایل‌ها نباید یک کلاس کیس بگیرند
        expect(new Set(patterns).size).toBeGreaterThanOrEqual(2);
    });

    it('two full regenerations of the clash sub body are byte-identical (RED on old — ETag contract)', async () => {
        const body1 = await (await getClNormalConfig()).text();

        clearDnsCache(); // مجبور به نسل کامل تازه (شامل resolve مجدد DNS)
        const body2 = await (await getClNormalConfig()).text();

        // کد قدیمی: ده‌ها فیلد sni با کیس تصادفی → دو نسل عملاً هرگز برابر نبودند
        expect(body2).toBe(body1);
    });
});
