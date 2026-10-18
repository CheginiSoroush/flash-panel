import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';

/**
 * v0.8.8 — panel/update-check: چک آپدیت سمت سرور (پشتیبان چک سمت مرورگر)
 *
 * ریشه‌ی «دکمه‌ی آپدیت فعال نیست»: checkVersion سمت کلاینت فقط با fetch
 * مستقیم مرورگر از raw.githubusercontent / jsDelivr کار می‌کرد — در شبکه‌های
 * فیلترشده (ایران) هر دو اغلب از دسترس خارج‌اند و دکمه هیچ‌وقت فعال نمی‌شد.
 * حالا ورکر خودش از لبه‌ی کلادفلر نسخه‌ی آخر را برمی‌گرداند.
 *
 * قواعد write-diet: این endpoint صفر KV put دارد (فقط کش isolate).
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
(globalThis as any).VERSION = '0.8.8';
(globalThis as any)._repo_ = 'https://github.com/CheginiSoroush/flash-panel';
(globalThis as any)._public_proxy_ip_ = 'bpb.yousef.isegaro.com';

function createKvMock(seed: Record<string, string> = {}) {
    const store = new Map<string, string>(Object.entries(seed));
    const kv = {
        async get(key: string, opts?: { type?: string }) {
            const raw = store.get(key);
            if (raw === undefined) return null;
            return opts?.type === 'json' ? JSON.parse(raw) : raw;
        },
        async put(key: string, value: string) {
            store.set(key, value);
            return undefined;
        },
        async delete(key: string) {
            store.delete(key);
        }
    } as unknown as KVNamespace;

    return { kv, store };
}

function pkgResponse(version: string) {
    return new Response(JSON.stringify({ name: 'flash-panel', version }), { status: 200 });
}

describe('panel/update-check — server-side version check (v0.8.8)', () => {
    let settings: typeof import('../src/settings/settings');
    let auth: typeof import('../src/auth/auth');
    let mod: typeof import('../src/api/update-check');
    let kvMock: ReturnType<typeof createKvMock>;

    const loginAsAdmin = async (): Promise<string> => {
        const res = await auth.generateJWTToken(
            new Request('https://example.com/sp/login/authenticate', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'CF-Connecting-IP': '10.77.0.1'
                },
                body: JSON.stringify({ username: 'admin@example.com', password: 'correct-pass' })
            }),
            { kv: kvMock.kv } as any
        );
        const setCookie = res.headers.get('Set-Cookie') || '';
        const match = setCookie.match(/jwtToken=([^;]*)/);
        return match ? match[1] : '';
    };

    const authedRequest = (token: string) =>
        new Request('https://example.com/sp/panel/update-check', {
            headers: { Cookie: `jwtToken=${token}` }
        });

    beforeAll(async () => {
        settings = await import('../src/settings/settings');
        auth = await import('../src/auth/auth');
        mod = await import('../src/api/update-check');

        kvMock = createKvMock({ pwd: 'correct-pass' });
        settings.init(
            new Request('https://example.com/sp/panel', {
                headers: { 'CF-Connecting-IP': '1.2.3.4' }
            }),
            { kv: kvMock.kv } as any
        );
    });

    afterEach(() => {
        vi.restoreAllMocks();
        delete (globalThis as any).fetch;
        mod.resetUpdateCheckCache();
    });

    it('isNewerVersion — semver compare semantics identical to client', () => {
        expect(mod.isNewerVersion('0.8.9', '0.8.8')).toBe(true);
        expect(mod.isNewerVersion('0.9.0', '0.8.8')).toBe(true);
        expect(mod.isNewerVersion('1.0.0', '0.8.8')).toBe(true);
        expect(mod.isNewerVersion('0.8.8', '0.8.8')).toBe(false);
        expect(mod.isNewerVersion('0.8.7', '0.8.8')).toBe(false);
        expect(mod.isNewerVersion('0.7.99', '0.8.0')).toBe(false);
    });

    it('rejects unauthenticated requests', async () => {
        const res = await mod.getUpdateCheckEndpoint(
            new Request('https://example.com/sp/panel/update-check'),
            { kv: kvMock.kv } as any
        );
        const json: any = await res.json();
        expect(res.status).toBe(401);
        expect(json.success).toBe(false);
    });

    it('returns latest + updateAvailable:true when a newer release exists', async () => {
        const token = await loginAsAdmin();
        expect(token).not.toBe('');

        const fetchMock = vi.fn(async (input: any) => {
            const url = String(input);
            if (url.includes('raw.githubusercontent.com')) return pkgResponse('0.9.0');
            return new Response('should not be reached', { status: 500 });
        });
        (globalThis as any).fetch = fetchMock;

        const res = await mod.getUpdateCheckEndpoint(authedRequest(token), { kv: kvMock.kv } as any);
        const json: any = await res.json();
        expect(res.status).toBe(200);
        expect(json.success).toBe(true);
        expect(json.body.latest).toBe('0.9.0');
        expect(json.body.current).toBe('0.8.8');
        expect(json.body.updateAvailable).toBe(true);
        expect(json.body.source).toBe('raw-github');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('reports updateAvailable:false when already on the latest version', async () => {
        const token = await loginAsAdmin();
        vi.fn();
        (globalThis as any).fetch = vi.fn(async () => pkgResponse('0.8.8'));

        const res = await mod.getUpdateCheckEndpoint(authedRequest(token), { kv: kvMock.kv } as any);
        const json: any = await res.json();
        expect(json.success).toBe(true);
        expect(json.body.latest).toBe('0.8.8');
        expect(json.body.updateAvailable).toBe(false);
    });

    it('REGRESSION (Iran filtering): falls through to the second mirror when the first is unreachable', async () => {
        const token = await loginAsAdmin();
        const seen: string[] = [];
        (globalThis as any).fetch = vi.fn(async (input: any) => {
            seen.push(String(input));
            if (String(input).includes('raw.githubusercontent.com')) {
                throw new TypeError('fetch failed (blocked)');
            }
            return pkgResponse('0.10.0');
        });

        const res = await mod.getUpdateCheckEndpoint(authedRequest(token), { kv: kvMock.kv } as any);
        const json: any = await res.json();
        expect(json.success).toBe(true);
        expect(json.body.latest).toBe('0.10.0');
        expect(json.body.source).toBe('jsdelivr');
        expect(seen.some(u => u.includes('cdn.jsdelivr.net'))).toBe(true);
    });

    it('invalid payload (non-semver) is rejected and the next mirror still answers', async () => {
        const token = await loginAsAdmin();
        (globalThis as any).fetch = vi.fn(async (input: any) => {
            if (String(input).includes('raw.githubusercontent.com')) {
                return new Response(JSON.stringify({ version: 'not-a-version' }), { status: 200 });
            }
            return pkgResponse('1.2.3');
        });

        const res = await mod.getUpdateCheckEndpoint(authedRequest(token), { kv: kvMock.kv } as any);
        const json: any = await res.json();
        expect(json.success).toBe(true);
        expect(json.body.latest).toBe('1.2.3');
        expect(json.body.updateAvailable).toBe(true);
    });

    it('all mirrors fail → success:false with a combined actionable message', async () => {
        const token = await loginAsAdmin();
        (globalThis as any).fetch = vi.fn(async () => new Response('forbidden', { status: 403 }));

        const res = await mod.getUpdateCheckEndpoint(authedRequest(token), { kv: kvMock.kv } as any);
        const json: any = await res.json();
        expect(res.status).toBe(503);
        expect(json.success).toBe(false);
        expect(json.message).toContain('raw-github');
        expect(json.message).toContain('jsdelivr');
    });

    it('isolate cache: repeated checks within TTL hit GitHub only once', async () => {
        const token = await loginAsAdmin();
        const fetchMock = vi.fn(async () => pkgResponse('0.9.1'));
        (globalThis as any).fetch = fetchMock;

        const first = await mod.getUpdateCheckEndpoint(authedRequest(token), { kv: kvMock.kv } as any);
        const second = await mod.getUpdateCheckEndpoint(authedRequest(token), { kv: kvMock.kv } as any);

        expect(((await first.json()) as any).body.latest).toBe('0.9.1');
        expect(((await second.json()) as any).body.latest).toBe('0.9.1');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('write-diet: the endpoint performs zero KV puts', async () => {
        const token = await loginAsAdmin();
        const putsBefore = [...(kvMock.store as Map<string, string>).keys()].length;
        let putCalls = 0;
        const originalPut = (kvMock.kv as any).put.bind(kvMock.kv);
        (kvMock.kv as any).put = async (...args: any[]) => {
            putCalls++;
            return originalPut(...args);
        };

        (globalThis as any).fetch = vi.fn(async () => pkgResponse('0.9.2'));
        await mod.getUpdateCheckEndpoint(authedRequest(token), { kv: kvMock.kv } as any);

        expect(putCalls).toBe(0);
        expect([...(kvMock.store as Map<string, string>).keys()].length).toBe(putsBefore);
    });
});
