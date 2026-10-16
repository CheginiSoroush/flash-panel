import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';

// globals حداقلی — باید قبل از import ماژول‌های وابسته به @settings ست شوند
// (الگوی auth.test.ts: import داینامیک بعد از مقداردهی globals)
(globalThis as any).VERSION = '0.4.0';
(globalThis as any)._repo_ = 'https://github.com/CheginiSoroush/flash-panel';
(globalThis as any)._public_proxy_ip_ = 'bpb.yousef.isegaro.com';

// cloudflare:sockets در node وجود ندارد — فقط ماژول mock می‌شود
vi.mock('cloudflare:sockets', () => ({
    connect: vi.fn(() => { throw new Error('not used in tests'); }),
}));

let resolveDNS: (domain: string, onlyIPv4?: boolean) => Promise<{ ipv4: string[]; ipv6: string[] }>;
let clearDnsCache: () => void;
let pickProxyIP: (list: string[]) => string;
let markProxyOk: (ip: string) => void;
let markProxyFail: (ip: string) => void;
let hardenResponse: (res: Response) => Response;
let robotsResponse: () => Response;

beforeAll(async () => {
    ({ resolveDNS, clearDnsCache } = await import('@utils'));
    ({ pickProxyIP, markProxyOk, markProxyFail } = await import('@protocols/common'));
    ({ hardenResponse, robotsResponse } = await import('@handlers/utils'));
});

// ---------- helpers ----------

function dnsJson(records: Array<{ type: number; TTL: number; data: string }>) {
    return new Response(JSON.stringify({ Answer: records }), { status: 200 });
}

const A_RECORD = { type: 1, TTL: 60, data: '1.2.3.4' };

// =====================================================================
// ۱) کش DNS — TTL-آگاه، ادغام in-flight، stale-on-error
// =====================================================================
describe('resolveDNS isolate cache', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        clearDnsCache();
        vi.useFakeTimers();
        fetchMock = vi.fn(async (url: string | URL | Request) => {
            const u = String(url);
            if (u.includes('&type=A')) return dnsJson([A_RECORD]);
            return dnsJson([]); // AAAA → بدون رکورد
        });
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('دومین فراخوانی در بازه TTL هیچ fetch اضافه نمی‌زند', async () => {
        await resolveDNS('example.com', true);
        await resolveDNS('example.com', true);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('درخواست‌های همزمان ادغام می‌شوند (in-flight dedupe)', async () => {
        let release!: (v: Response) => void;
        fetchMock.mockImplementationOnce(() => new Promise<Response>((res) => { release = res; }));

        const p1 = resolveDNS('slow.com', true);
        const p2 = resolveDNS('slow.com', true);

        release(dnsJson([A_RECORD]));
        const [r1, r2] = await Promise.all([p1, p2]);

        expect(r1.ipv4).toEqual(['1.2.3.4']);
        expect(r2.ipv4).toEqual(['1.2.3.4']);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('بعد از انقضای TTL دوباره resolve می‌شود', async () => {
        await resolveDNS('ttl.com', true);
        vi.advanceTimersByTime(6 * 60_000); // TTL پیش‌فرض ۵ دقیقه
        await resolveDNS('ttl.com', true);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('stale-on-error — با خرابی DoH، آخرین پاسخ سالم برمی‌گردد', async () => {
        await resolveDNS('flaky.com', true); // سالم کش می‌شود

        vi.advanceTimersByTime(6 * 60_000); // TTL تمام
        fetchMock.mockImplementationOnce(async () => { throw new Error('DoH down'); });

        const result = await resolveDNS('flaky.com', true);
        expect(result.ipv4).toEqual(['1.2.3.4']); // پاسخ کهنه به‌جای throw
    });

    it('بدون کش قبلی، خرابی DoH همچنان throw می‌کند', async () => {
        fetchMock.mockImplementationOnce(async () => { throw new Error('boom'); });
        await expect(resolveDNS('never.com', true)).rejects.toThrow();
    });

    it('کلید onlyIPv4 و کامل از هم جدا هستند', async () => {
        await resolveDNS('dual.com', true);
        await resolveDNS('dual.com', false);
        // یک fetch برای A در حالت v4، دو fetch (A+AAAA) در حالت کامل
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('clearDnsCache همه‌ی ورودی‌ها را حذف می‌کند', async () => {
        await resolveDNS('wipe.com', true);
        clearDnsCache();
        await resolveDNS('wipe.com', true);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});

// =====================================================================
// ۲) رجیستری سلامت ProxyIP — cooldown نمایی، اولویت سالم‌ها
// =====================================================================
describe('proxy-IP health registry', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('لیست خالی رشته خالی برمی‌گرداند', () => {
        expect(pickProxyIP([])).toBe('');
    });

    it('IP در cooldown هرگز در حالت وجود گزینه سالم انتخاب نمی‌شود', () => {
        markProxyFail('dead.example.com:443');
        // داخل cooldown (۳۰ ثانیه اول)
        for (let i = 0; i < 50; i++) {
            expect(pickProxyIP(['dead.example.com:443', 'alive.example.com:443'])).toBe('alive.example.com:443');
        }
    });

    it('اگر همه در cooldown باشند از لیست کامل انتخاب می‌شود (شانس دوباره)', () => {
        markProxyFail('a.com:443');
        markProxyFail('b.com:443');
        const pick = pickProxyIP(['a.com:443', 'b.com:443']);
        expect(['a.com:443', 'b.com:443']).toContain(pick);
    });

    it('markProxyOk جریمه را صفر می‌کند', () => {
        markProxyFail('y.com:443'); // تنها رقیب جریمه می‌شود
        markProxyOk('x.com:443');   // اگر قبلاً جریمه بود، پاک می‌شود
        vi.advanceTimersByTime(1);
        for (let i = 0; i < 20; i++) {
            expect(pickProxyIP(['x.com:443', 'y.com:443'])).toBe('x.com:443');
        }
    });

    it('شکست‌های پشت‌سرهم cooldown را نمایی بزرگ می‌کنند (سقف ۱۰ دقیقه)', () => {
        const ip = 'escalate.com:443';

        markProxyFail(ip); // ۳۰s
        vi.advanceTimersByTime(31_000);
        // بعد از ۳۱ ثانیه، با یک شکست، دوباره واجد شرایط است — ولی قبلش شکست دوم می‌خوریم
        markProxyFail(ip); // ۶۰s از الان
        vi.advanceTimersByTime(31_000);
        markProxyFail(ip); // ۱۲۰s از الان

        // هنگام: ۶۲s از آخرین شکست — cooldown ۱۲۰s هنوز تمام نشده
        for (let i = 0; i < 20; i++) {
            expect(pickProxyIP([ip, 'fresh.com:443'])).toBe('fresh.com:443');
        }
    });
});

// =====================================================================
// ۳) هدرهای ضد شناسایی/نشتی + robots.txt
// =====================================================================
describe('hardenResponse & robots.txt', () => {
    it('سه هدر امنیتی روی پاسخ ست می‌شوند', () => {
        const res = hardenResponse(new Response('ok'));
        expect(res.headers.get('X-Robots-Tag')).toContain('noindex');
        expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
        expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    });

    it('بدنه و وضعیت پاسخ حفظ می‌شود', async () => {
        const original = new Response('subscription-body', { status: 200, headers: { 'Profile-Title': 'x' } });
        const res = hardenResponse(original);
        expect(res.status).toBe(200);
        expect(await res.text()).toBe('subscription-body');
        expect(res.headers.get('Profile-Title')).toBe('x');
    });

    it('robots.txt کل دامنه را از خزیدن منع می‌کند', async () => {
        const res = robotsResponse();
        const text = await res.text();
        expect(text).toContain('User-agent: *');
        expect(text).toContain('Disallow: /');
        expect(res.headers.get('Content-Type')).toContain('text/plain');
        expect(res.headers.get('Cache-Control')).toContain('max-age');
    });
});
