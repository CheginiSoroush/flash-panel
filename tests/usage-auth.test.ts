import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';

/**
 * v0.8.7 — usage هرگز دروغ نمی‌گوید:
 *   ۱. خطای GraphQL/HTTP دیگر «success با صفر» نمی‌شود (ریشه‌ی usage-all-zeros)
 *   ۲. اگر Bearer رد شد (کاربر Global API Key گذاشته)، با X-Auth-Email + X-Auth-Key دوباره تلاش می‌شود
 *   ۳. هر دو شکست → success:false با پیام قابل‌اقدام
 */

const MOCK_EMBEDED = {
    accID: 'test-account-id',
    accEmail: 'admin@example.com',
    apiToken: 'my-secret-credential',
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
(globalThis as any).VERSION = '0.8.7';
(globalThis as any)._repo_ = 'https://github.com/CheginiSoroush/flash-panel';
(globalThis as any)._public_proxy_ip_ = 'bpb.yousef.isegaro.com';

function gqlPayload(total: number, worker: number) {
    return {
        data: {
            viewer: {
                accounts: [{
                    total: [{ sum: { requests: total } }],
                    worker: [{ sum: { requests: worker } }]
                }]
            }
        }
    };
}

interface CapturedRequest {
    url: string;
    headers: Record<string, string>;
    body: string;
}

function mockGqlFetch(responder: (req: CapturedRequest, attempt: number) => any) {
    const captured: CapturedRequest[] = [];
    let attempt = 0;
    const fetchMock = vi.fn(async (input: any, init?: any) => {
        attempt++;
        const req: CapturedRequest = {
            url: String(input),
            headers: normalizeHeaders(init?.headers ?? {}),
            body: String(init?.body ?? '')
        };
        captured.push(req);
        return responder(req, attempt);
    });
    (globalThis as any).fetch = fetchMock;
    return { captured, fetchMock };
}

function normalizeHeaders(h: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = String(v);
    return out;
}

function gqlErrorsResponse(messages: string[]) {
    return new Response(JSON.stringify({ errors: messages.map(m => ({ message: m })) }), { status: 200 });
}

describe('getCfWorkerUsage — honest results + dual auth (v0.8.7)', () => {
    let usage: typeof import('../src/api/usage');

    beforeAll(async () => {
        const settings = await import('../src/settings/settings');
        usage = await import('../src/api/usage');

        settings.init(
            new Request('https://example.com/sp/panel', {
                headers: { 'CF-Connecting-IP': '1.2.3.4' }
            }),
            { kv: new Map() } as any
        );
    });

    afterEach(() => {
        vi.restoreAllMocks();
        delete (globalThis as any).fetch;
    });

    it('Bearer success → real numbers, no fallback attempt', async () => {
        const { captured } = mockGqlFetch(() => new Response(JSON.stringify(gqlPayload(4242, 777)), { status: 200 }));

        const res = await usage.getCfWorkerUsage();
        expect(res.success).toBe(true);
        expect(res.total).toBe(4242);
        expect(res.worker).toBe(777);
        expect(captured).toHaveLength(1);
        expect(captured[0].headers['authorization']).toBe('Bearer my-secret-credential');
    });

    it('REGRESSION: GraphQL errors no longer become a silent success-with-zeros', async () => {
        // قبل از فیکس: errors + نبودِ account → total=0/worker=0 با success:true
        mockGqlFetch(() => new Response(JSON.stringify({
            errors: [{ message: 'Authentication error (code: 10000)' }]
        }), { status: 200 }));

        const res = await usage.getCfWorkerUsage();
        expect(res.success).toBe(false);
        expect(res.error).toContain('Authentication error');
        expect(res.total).toBeUndefined();
        expect(res.worker).toBeUndefined();
    });

    it('Bearer rejected → Global API Key fallback with X-Auth-Email + X-Auth-Key', async () => {
        const { captured } = mockGqlFetch((_req, attempt) => {
            if (attempt === 1) {
                // Bearer روی Global Key: خطای احراز GraphQL
                return gqlErrorsResponse(['Invalid request headers (code: 9109)']);
            }
            return new Response(JSON.stringify(gqlPayload(91000, 1234)), { status: 200 });
        });

        const res = await usage.getCfWorkerUsage();
        expect(res.success).toBe(true);
        expect(res.total).toBe(91000);
        expect(res.worker).toBe(1234);
        expect(captured).toHaveLength(2);
        expect(captured[1].headers['x-auth-email']).toBe('admin@example.com');
        expect(captured[1].headers['x-auth-key']).toBe('my-secret-credential');
        expect(captured[1].headers['authorization']).toBeUndefined();
    });

    it('both modes fail → success:false with an actionable combined message', async () => {
        mockGqlFetch((_req, attempt) => {
            if (attempt === 1) return new Response('rate limited', { status: 429 });
            return gqlErrorsResponse(['code: 9109 unauthorized']);
        });

        const res = await usage.getCfWorkerUsage();
        expect(res.success).toBe(false);
        expect(res.error).toContain('API Token (Bearer)');
        expect(res.error).toContain('Global API Key (X-Auth-Key)');
        expect(res.error).toContain('Account Analytics:Read');
    });

    it('HTTP non-200 is an error, not zeros', async () => {
        mockGqlFetch(() => new Response('forbidden', { status: 403 }));

        const res = await usage.getCfWorkerUsage();
        expect(res.success).toBe(false);
        expect(res.error).toContain('HTTP 403');
    });

    it('network exception stays a clean failure (never throws, never zeros)', async () => {
        mockGqlFetch(() => { throw new Error('connection reset'); });

        const res = await usage.getCfWorkerUsage();
        expect(res.success).toBe(false);
        expect(res.error).toBeTruthy();
    });

    it('partial GraphQL errors with valid data still count as success', async () => {
        // GraphQL می‌تواند هم data بدهد هم errors — داده‌ی سالم برنده است
        const payload = { ...gqlPayload(500, 50), errors: [{ message: 'some unrelated warning' }] };
        mockGqlFetch(() => new Response(JSON.stringify(payload), { status: 200 }));

        const res = await usage.getCfWorkerUsage();
        expect(res.success).toBe(true);
        expect(res.total).toBe(500);
        expect(res.worker).toBe(50);
    });
});
