import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';


/**
 * v0.8.44 — سقف زمانی fetchهای DoH + موازی‌سازی A/AAAA (src/cores/utils.ts)
 *
 * کلاس باگ: fetchِ DoH هیچ سقف زمانی نداشت. resolveDNS دقیقاً در دو مسیر حساس
 * مصرف می‌شود:
 *   • تولید بدنه‌ی ساب (getConfigAddresses) — DoHِ آویزان = درخواست سابِ آویزان
 *   • mutatorهای داخل صف نوشتن KV (getDnsParams هنگام تغییر remoteDNS در
 *     ذخیره‌ی پنل/بازیابی بکاپ) — DoHِ آویزان = writeChain برای همیشه روی همان
 *     await می‌ماند و همه‌ی writeهای بعدی همان isolate (پنل/tuner/ربات/heal/
 *     مهاجرت) مرده‌اند. اصل مستند healRemoteDnsHost («صف نوشتن نباید روی
 *     شبکه‌ی DNS بایستد») بدون سقف زمانیِ خود شبکه فقط یک آرزو بود.
 *
 * قرارداد نو:
 *   1. هر fetch DoH با AbortController به سقف DNS_FETCH_TIMEOUT_MS (۵ث تولید)
 *      محدود می‌شود؛ stale-on-error موجود در resolveDNS حالا «به‌موقع» فعال
 *      می‌شود — با کش کهنه جواب کهنه، بدون کش خطای صریح (همان رفتار قبلی،
 *      فقط دیگر بی‌نهایت طول نمی‌کشد).
 *   2. A و AAAA موازی — بدترین‌حالت سرد از ۲×سقف به ۱×سقف رسید.
 *
 * استراتژی تست: استاب DoH سطح fetch که fetchِ «خوب‌رفتار» را شبیه‌سازی می‌کند
 * (به signal گوش می‌دهد و روی abort رد می‌شود) — همان کاری که fetch واقعی
 * می‌کند. روی کدِ قدیمی (بدون signal) هیچ‌وقت settle نمی‌شود → تست‌های ۱ و ۲
 * با timeout ران قرمز می‌شوند (اثبات RED).
 */

// globals موردنیاز زنجیره‌ی import (الگوی sub-etag-dns.test.ts) — قبل از import پویا
(globalThis as any).VERSION = '0.8.44';
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

// ---------- استاب DoH — حالت ok / hang با پشتیبانی از AbortSignal ----------

let dohMode: 'ok' | 'hang' = 'ok';
let fetchCalls: string[] = [];

vi.stubGlobal('fetch', vi.fn((input: any, init?: any) => {
    const url = String(input instanceof URL ? input : input?.url ?? input);
    if (!url.includes('cloudflare-dns.com')) {
        return Promise.reject(new Error(`unexpected fetch in test: ${url}`));
    }
    const type = new URL(url).searchParams.get('type') ?? '?';
    fetchCalls.push(type);

    if (dohMode === 'hang') {
        // fetch واقعی روی abort رد می‌شود — بدون signal هرگز settle نمی‌شود
        return new Promise((_, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')));
        });
    }

    const records = type === 'A' ? ['1.2.3.4'] : ['2606:4700:4700::1111'];
    return Promise.resolve(new Response(JSON.stringify({
        Answer: records.map(data => ({ type: type === 'A' ? 1 : 28, TTL: 300, data }))
    }), { status: 200, headers: { 'Content-Type': 'application/dns-json' } }));
}));

let resolveDNS: typeof import('../src/cores/utils').resolveDNS;
let clearDnsCache: typeof import('../src/cores/utils').clearDnsCache;
let setDnsTimeout: typeof import('../src/cores/utils')._setDnsFetchTimeoutForTest;

describe('DoH fetch timeout × write-queue safety (v0.8.44 contract)', () => {
    beforeAll(async () => {
        ({ resolveDNS, clearDnsCache, _setDnsFetchTimeoutForTest: setDnsTimeout } =
            await import('../src/cores/utils'));
    });

    beforeEach(() => {
        clearDnsCache();
        dohMode = 'ok';
        fetchCalls = [];
        setDnsTimeout?.(150); // سقف تستی — در تولید ۵ ثانیه است (کد قدیمی این هُک را ندارد)
    });

    afterEach(() => {
        setDnsTimeout?.(5_000);
        vi.useRealTimers();
        clearDnsCache();
    });

    it('a hanging cold DoH resolve rejects within the timeout instead of hanging forever (RED on old code)', async () => {
        dohMode = 'hang';
        const t0 = Date.now();

        // کد قدیمی: بدون signal، استاب هرگز settle نمی‌شود → این await آویزان می‌ماند
        await expect(resolveDNS('hang.example.com')).rejects.toThrow();
        expect(Date.now() - t0).toBeLessThan(2_000);
    });

    it('stale-on-error still answers from cache when a re-resolve times out (RED on old code)', async () => {
        const first = await resolveDNS('stale.example.com');
        expect(first.ipv4).toEqual(['1.2.3.4']);
        expect(first.ipv6).toEqual(['2606:4700:4700::1111']);

        // TTL بگذرد — ورودی کهنه فقط به‌عنوان «پاسخِ بازگشتِ در خطا» می‌ماند
        // (فقط Date جعلی می‌شود؛ تایمرها واقعی می‌مانند تا abort واقعی رخ دهد)
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(Date.now() + 6 * 60_000);

        dohMode = 'hang';
        const second = await resolveDNS('stale.example.com');
        expect(second.ipv4).toEqual(['1.2.3.4']);
        expect(second.ipv6).toEqual(['2606:4700:4700::1111']);
    });

    it('A and AAAA resolve in one cold call and onlyIPv4 skips AAAA (parallel guard)', async () => {
        const both = await resolveDNS('both.example.com');
        expect(both.ipv4).toEqual(['1.2.3.4']);
        expect(both.ipv6).toEqual(['2606:4700:4700::1111']);
        expect(fetchCalls.filter(t => t === 'A').length).toBe(1);
        expect(fetchCalls.filter(t => t === 'AAAA').length).toBe(1);

        fetchCalls = [];
        const v4only = await resolveDNS('v4only.example.com', true);
        expect(v4only.ipv4).toEqual(['1.2.3.4']);
        expect(v4only.ipv6).toEqual([]);
        expect(fetchCalls).toEqual(['A']);
    });
});
