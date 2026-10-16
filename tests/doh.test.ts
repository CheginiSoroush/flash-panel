import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

/**
 * تست هندلر DoH با connection reuse:
 * کش TTL-آگاه + single-flight + LRU + stale-on-error + عبور مستقیم (BYPASS)
 * پیام‌های DNS به‌صورت synthetic ساخته می‌شوند (RFC 1035 wire format)
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
    dohUrl: 'https://dns.example-doh.test/dns-query'
};

(globalThis as any).EMBEDED_SETTINGS = MOCK_EMBEDED;
(globalThis as any).VERSION = '0.3.8';

// ---------- سازنده‌های پیام DNS ----------

function encodeQname(qname: string): number[] {
    const labels = qname.replace(/\.$/, '').split('.').filter(Boolean);
    const bytes: number[] = [];
    for (const label of labels) {
        bytes.push(label.length, ...Array.from(label, c => c.charCodeAt(0)));
    }
    bytes.push(0);
    return bytes;
}

function u16(value: number): number[] {
    return [(value >> 8) & 0xff, value & 0xff];
}

function u32(value: number): number[] {
    return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

export function buildDnsQuery(id: number, qname: string, qtype: number): Uint8Array {
    return new Uint8Array([
        ...u16(id),
        ...u16(0x0100),              // RD
        ...u16(1), ...u16(0), ...u16(0), ...u16(0),  // QD=1
        ...encodeQname(qname),
        ...u16(qtype), ...u16(1)     // IN
    ]);
}

interface AnswerOpt {
    ttl: number;
    type?: number;
    rdata?: number[];
    /** نام با compression pointer به سؤال اشاره کند (0xC00C) */
    pointerName?: boolean;
}

export function buildDnsResponse(
    id: number,
    qname: string,
    qtype: number,
    answers: AnswerOpt[] = [],
    rcode = 0
): Uint8Array {
    const flags = 0x8000 | (rcode & 0xf) | 0x0080;   // QR + RA
    const body: number[] = [
        ...u16(id),
        ...u16(flags),
        ...u16(1), ...u16(answers.length), ...u16(0), ...u16(0)
    ];

    const question = [...encodeQname(qname), ...u16(qtype), ...u16(1)];
    body.push(...question);

    for (const answer of answers) {
        const name = answer.pointerName ? [0xc0, 0x0c] : encodeQname(qname);
        const rdata = answer.rdata ?? [1, 2, 3, 4];
        body.push(
            ...name,
            ...u16(answer.type ?? 1),   // A
            ...u16(1),                  // IN
            ...u32(answer.ttl),
            ...u16(rdata.length),
            ...rdata
        );
    }

    return new Uint8Array(body);
}

function toBase64Url(bytes: Uint8Array): string {
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    return a.length === b.length && a.every((v, i) => v === b[i]);
}

// ---------- راه‌اندازی (ایمپورت پویا — بعد از ست‌شدن globals) ----------

let handleDoH: typeof import('../src/handlers/doh')['handleDoH'];
let minAnswerTtl: typeof import('../src/handlers/doh')['minAnswerTtl'];
let clearDohCache: typeof import('../src/handlers/doh')['clearDohCache'];
let init: typeof import('../src/settings/settings')['init'];

const fetchMock = vi.fn();

function dohRequest(dnsParam: string): Request {
    return new Request(`https://example.com/sp/dns-query?dns=${dnsParam}`, {
        headers: { 'Accept': 'application/dns-message' }
    });
}

beforeAll(async () => {
    const settings = await import('../src/settings/settings');
    init = settings.init;
    const doh = await import('../src/handlers/doh');
    handleDoH = doh.handleDoH;
    minAnswerTtl = doh.minAnswerTtl;
    clearDohCache = doh.clearDohCache;

    init(
        new Request('https://example.com/sp/dns-query'),
        { kv: undefined } as unknown as Env
    );
});

beforeEach(() => {
    clearDohCache();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

// ---------- تست‌های parser ----------

describe('minAnswerTtl', () => {
    it('TTL تک رکورد A را برمی‌گرداند', () => {
        const msg = buildDnsResponse(1, 'example.com', 1, [{ ttl: 120 }]);
        expect(minAnswerTtl(msg)).toBe(120);
    });

    it('کمینه‌ی TTL بین چند رکورد', () => {
        const msg = buildDnsResponse(1, 'example.com', 1, [{ ttl: 300 }, { ttl: 60 }, { ttl: 600 }]);
        expect(minAnswerTtl(msg)).toBe(60);
    });

    it('نام با compression pointer هم parse می‌شود', () => {
        const msg = buildDnsResponse(1, 'example.com', 1, [{ ttl: 45, pointerName: true }]);
        expect(minAnswerTtl(msg)).toBe(45);
    });

    it('TTL صفر یعنی رکورد بی‌ثبات → ۰', () => {
        const msg = buildDnsResponse(1, 'example.com', 1, [{ ttl: 120 }, { ttl: 0 }]);
        expect(minAnswerTtl(msg)).toBe(0);
    });

    it('بدون ANSWER (NXDOMAIN) → null', () => {
        const msg = buildDnsResponse(1, 'missing.example.com', 1, [], 3);
        expect(minAnswerTtl(msg)).toBe(null);
    });

    it('پیام خراب/کوتاه → null (کرش نمی‌کند)', () => {
        expect(minAnswerTtl(new Uint8Array([1, 2, 3]))).toBe(null);
        expect(minAnswerTtl(new Uint8Array(0))).toBe(null);
    });
});

// ---------- تست‌های هندلر ----------

describe('handleDoH — کش و connection reuse', () => {
    it('درخواست تکراری → HIT با یک fetch بالادستی', async () => {
        const query = buildDnsQuery(0x1111, 'example.com', 1);
        const response = buildDnsResponse(0x1111, 'example.com', 1, [{ ttl: 120 }]);
        fetchMock.mockResolvedValue(
            new Response(response as unknown as BodyInit, {
                headers: { 'Content-Type': 'application/dns-message' }
            })
        );

        const param = toBase64Url(query);
        const first = await handleDoH(dohRequest(param));
        const second = await handleDoH(dohRequest(param));

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(first.headers.get('X-DNS-Cache')).toBe('MISS');
        expect(second.headers.get('X-DNS-Cache')).toBe('HIT');
        expect(await first.arrayBuffer()).toEqual(await second.arrayBuffer());
    });

    it('ID پاسخ کش‌شده با ID درخواست جدید بازنویسی می‌شود', async () => {
        const queryA = buildDnsQuery(0xaaaa, 'example.com', 1);
        const responseA = buildDnsResponse(0xaaaa, 'example.com', 1, [{ ttl: 120 }]);
        fetchMock.mockImplementation(async () =>
            new Response(responseA.slice() as unknown as BodyInit, { headers: { 'Content-Type': 'application/dns-message' } })
        );

        await handleDoH(dohRequest(toBase64Url(queryA)));

        const queryB = buildDnsQuery(0xBBBB, 'example.com', 1);
        const hit = await handleDoH(dohRequest(toBase64Url(queryB)));
        const body = new Uint8Array(await hit.arrayBuffer());
        expect(body[0]).toBe(0xbb);
        expect(body[1]).toBe(0xbb);
        expect(hit.headers.get('X-DNS-Cache')).toBe('HIT');
    });

    it('TTL کلمپ می‌شود (۶۰۰ → max-age ۳۰۰)', async () => {
        const query = buildDnsQuery(1, 'clamp.test', 1);
        const response = buildDnsResponse(1, 'clamp.test', 1, [{ ttl: 600 }]);
        fetchMock.mockResolvedValue(
            new Response(response as unknown as BodyInit, { headers: { 'Content-Type': 'application/dns-message' } })
        );

        await handleDoH(dohRequest(toBase64Url(query)));
        const hit = await handleDoH(dohRequest(toBase64Url(query)));
        expect(hit.headers.get('Cache-Control')).toBe('max-age=300');
    });

    it('پس از انقضای TTL دوباره fetch می‌شود', async () => {
        const query = buildDnsQuery(1, 'expire.test', 1);
        const response = buildDnsResponse(1, 'expire.test', 1, [{ ttl: 30 }]);
        fetchMock.mockImplementation(async () =>
            new Response(response.slice() as unknown as BodyInit, { headers: { 'Content-Type': 'application/dns-message' } })
        );

        await handleDoH(dohRequest(toBase64Url(query)));
        vi.setSystemTime(Date.now() + 31_000);
        const fresh = await handleDoH(dohRequest(toBase64Url(query)));
        expect(fresh.headers.get('X-DNS-Cache')).toBe('MISS');
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('TTL صفر → کش نمی‌شود (هر بار MISS)', async () => {
        const query = buildDnsQuery(1, 'unstable.test', 1);
        const response = buildDnsResponse(1, 'unstable.test', 1, [{ ttl: 0 }]);
        fetchMock.mockResolvedValue(
            new Response(response as unknown as BodyInit, { headers: { 'Content-Type': 'application/dns-message' } })
        );

        await handleDoH(dohRequest(toBase64Url(query)));
        await handleDoH(dohRequest(toBase64Url(query)));
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('NXDOMAIN → کش منفی ۳۰ ثانیه', async () => {
        const query = buildDnsQuery(1, 'nxdomain.test', 1);
        const response = buildDnsResponse(1, 'nxdomain.test', 1, [], 3);
        fetchMock.mockResolvedValue(
            new Response(response as unknown as BodyInit, { headers: { 'Content-Type': 'application/dns-message' } })
        );

        await handleDoH(dohRequest(toBase64Url(query)));
        const hit = await handleDoH(dohRequest(toBase64Url(query)));
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(hit.headers.get('X-DNS-Cache')).toBe('HIT');
    });

    it('کوئری متفاوت → MISS جداگانه', async () => {
        const response = buildDnsResponse(1, 'x.test', 1, [{ ttl: 60 }]);
        fetchMock.mockImplementation(async () =>
            new Response(response.slice() as unknown as BodyInit, { headers: { 'Content-Type': 'application/dns-message' } })
        );

        const qA = buildDnsQuery(1, 'a.test', 1);
        const qB = buildDnsQuery(2, 'b.test', 1);
        await handleDoH(dohRequest(toBase64Url(qA)));
        await handleDoH(dohRequest(toBase64Url(qB)));
        expect(fetchMock).toHaveBeenCalledTimes(2);

        // تکرار A → HIT از کش (بدون fetch جدید)
        await handleDoH(dohRequest(toBase64Url(qA)));
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('همان qname با ID متفاوت → HIT (کلید بر اساس سؤال است نه ID)', async () => {
        const response = buildDnsResponse(0x1111, 'same.test', 28, [{ ttl: 90 }]);
        fetchMock.mockImplementation(async () =>
            new Response(response.slice() as unknown as BodyInit, { headers: { 'Content-Type': 'application/dns-message' } })
        );

        const q1 = buildDnsQuery(0x1111, 'same.test', 28);   // AAAA
        const q2 = buildDnsQuery(0x2222, 'SAME.TEST', 28);   // نام متفاوت در حروف + ID متفاوت
        await handleDoH(dohRequest(toBase64Url(q1)));
        const hit = await handleDoH(dohRequest(toBase64Url(q2)));

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(hit.headers.get('X-DNS-Cache')).toBe('HIT');
        const body = new Uint8Array(await hit.arrayBuffer());
        expect((body[0] << 8) | body[1]).toBe(0x2222);       // ID بازنویسی شده
    });
});

describe('handleDoH — single-flight و مقاوم‌سازی', () => {
    it('کوئری همزمان یکسان → فقط یک fetch، هر دو پاسخ برابر', async () => {
        const query = buildDnsQuery(1, 'race.test', 1);
        let releaseUpstream!: (v: Response) => void;
        const gate = new Promise<Response>(resolve => { releaseUpstream = resolve; });
        fetchMock.mockReturnValue(gate);

        const response = buildDnsResponse(1, 'race.test', 1, [{ ttl: 120 }]);

        const p1 = handleDoH(dohRequest(toBase64Url(query)));
        const p2 = handleDoH(dohRequest(toBase64Url(query)));
        releaseUpstream(new Response(response as unknown as BodyInit, { headers: { 'Content-Type': 'application/dns-message' } }));

        const [r1, r2] = await Promise.all([p1, p2]);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(bytesEqual(
            new Uint8Array(await r1.arrayBuffer()),
            new Uint8Array(await r2.arrayBuffer())
        )).toBe(true);
    });

    it('خطای بالادستی بدون کش → ۵۰۲', async () => {
        fetchMock.mockRejectedValue(new Error('network down'));
        const query = buildDnsQuery(1, 'fail.test', 1);
        const res = await handleDoH(dohRequest(toBase64Url(query)));
        expect(res.status).toBe(502);
        expect(await res.text()).toContain('network down');
    });

    it('خطای بالادستی با کش منقضی → STALE سرو می‌شود', async () => {
        const query = buildDnsQuery(1, 'stale.test', 1);
        const response = buildDnsResponse(1, 'stale.test', 1, [{ ttl: 20 }]);
        fetchMock.mockResolvedValue(
            new Response(response as unknown as BodyInit, { headers: { 'Content-Type': 'application/dns-message' } })
        );

        await handleDoH(dohRequest(toBase64Url(query)));
        vi.setSystemTime(Date.now() + 25_000);
        fetchMock.mockRejectedValue(new Error('upstream dead'));

        const stale = await handleDoH(dohRequest(toBase64Url(query)));
        expect(stale.headers.get('X-DNS-Cache')).toBe('STALE');
        const body = new Uint8Array(await stale.arrayBuffer());
        expect(body.length).toBe(response.length);
    });

    it('upstream غیر-ok (۵۰۳) → ۵۰۲', async () => {
        fetchMock.mockResolvedValue(new Response('boom', { status: 503 }));
        const query = buildDnsQuery(1, 'err503.test', 1);
        const res = await handleDoH(dohRequest(toBase64Url(query)));
        expect(res.status).toBe(502);
    });
});

describe('handleDoH — مسیرهای عبور و حاشیه', () => {
    it('GET بدون dns → BYPASS passthrough', async () => {
        fetchMock.mockResolvedValue(new Response('{"Status":0}', { headers: { 'Content-Type': 'application/dns-json' } }));
        const req = new Request('https://example.com/sp/dns-query?name=example.com&type=A');
        const res = await handleDoH(req);
        expect(res.headers.get('X-DNS-Cache')).toBe('BYPASS');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(String(fetchMock.mock.calls[0][0])).toContain('name=example.com');
    });

    it('POST → با hash بدنه کش می‌شود', async () => {
        const wire = buildDnsQuery(1, 'post.test', 1);
        const response = buildDnsResponse(1, 'post.test', 1, [{ ttl: 60 }]);
        fetchMock.mockResolvedValue(
            new Response(response as unknown as BodyInit, { headers: { 'Content-Type': 'application/dns-message' } })
        );

        const req = () => new Request('https://example.com/sp/dns-query', {
            method: 'POST',
            headers: { 'Content-Type': 'application/dns-message' },
            body: wire as unknown as BodyInit
        });

        const first = await handleDoH(req());
        const second = await handleDoH(req());
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(first.headers.get('X-DNS-Cache')).toBe('MISS');
        expect(second.headers.get('X-DNS-Cache')).toBe('HIT');
    });

    it('متد غیرمجاز → ۴۰۵', async () => {
        const res = await handleDoH(new Request('https://example.com/sp/dns-query', { method: 'PUT' }));
        expect(res.status).toBe(405);
        expect(res.headers.get('Allow')).toBe('GET, POST');
    });

    it('dns param خراب (غیر base64) → BYPASS', async () => {
        fetchMock.mockResolvedValue(new Response('x', { status: 400 }));
        const res = await handleDoH(dohRequest('!!!not-base64!!!'));
        expect(res.headers.get('X-DNS-Cache')).toBe('BYPASS');
    });
});

describe('handleDoH — LRU', () => {
    it('سقف کش رعایت می‌شود (۲۵۶ ورودی)', async () => {
        const response = buildDnsResponse(1, 'lru.test', 1, [{ ttl: 300 }]);
        fetchMock.mockImplementation(async (input: any) => {
            const url = typeof input === 'string' ? input : input.url;
            // هر کوئری نام خودش را در qname دارد — همان پاسخ عمومی کافی است
            void url;
            return new Response(response as unknown as BodyInit, { headers: { 'Content-Type': 'application/dns-message' } });
        });

        // ورودی‌های متفاوت از طریق پارامتر اضافه‌ی مجاز (dns متفاوت) ساخته می‌شوند
        for (let i = 0; i < 300; i++) {
            const q = buildDnsQuery(1, `host${i}.test`, 1);
            await handleDoH(dohRequest(toBase64Url(q)));
        }
        // host0 (قدیمی‌ترین) از LRU حرف زده شده → دوباره fetch می‌شود
        const q = buildDnsQuery(1, 'host0.test', 1);
        const hit = await handleDoH(dohRequest(toBase64Url(q)));
        expect(['HIT', 'MISS']).toContain(hit.headers.get('X-DNS-Cache'));
        expect(fetchMock.mock.calls.length).toBe(301);
    });
});
