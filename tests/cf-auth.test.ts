import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';

/**
 * v0.8.7 — احراز دوحالته‌ی CF API داخل ورکر:
 * Global API Key (۳۷ hex) باید X-Auth-Email + X-Auth-Key برود، API Token باید Bearer.
 * قبل از این، دکمه‌ی Update پنل و گارد workers.dev با Global Key شکست می‌خوردند.
 */

const MOCK_EMBEDED: Record<string, any> = {
    accID: 'test-account-id',
    accEmail: 'admin@example.com',
    // کلید Global واقعی: دقیقاً ۳۷ کاراکتر hex — از قبل ست باشد تا snapshot بگیرد
    apiToken: 'a'.repeat(37),
    vlUUID: 'b831381d-6324-4d53-ad4f-8cda48b30811',
    trPass: 'trojan-pass',
    securePath: 'sp',
    proxyIpMode: 'public',
    proxyIPs: [],
    prefixes: [],
    mainDomain: 'example.com',
    fallback: '',
    dohUrl: ''
};

// کلید Global واقعی: دقیقاً ۳۷ کاراکتر hex
const GLOBAL_KEY = 'a'.repeat(37);
const API_TOKEN = 'x'.repeat(40);

describe('cfAuthHeaders — dual-mode Cloudflare auth', () => {
    let mod: typeof import('../src/api/cf-auth');

    beforeAll(async () => {
        (globalThis as any).EMBEDED_SETTINGS = MOCK_EMBEDED;
        (globalThis as any).VERSION = '0.8.7';
        (globalThis as any)._repo_ = 'https://github.com/CheginiSoroush/flash-panel';
        (globalThis as any)._public_proxy_ip_ = 'bpb.yousef.isegaro.com';
        mod = await import('../src/api/cf-auth');
        // getGlobals بدون init مقدار undefined می‌دهد — مثل بقیه‌ی تست‌ها init کن
        const settings = await import('../src/settings/settings');
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

    it('37-hex credential + email → X-Auth-Email + X-Auth-Key (Global Key mode)', () => {
        const h = mod.cfAuthHeaders(GLOBAL_KEY, 'admin@example.com');
        expect(h['X-Auth-Email']).toBe('admin@example.com');
        expect(h['X-Auth-Key']).toBe(GLOBAL_KEY);
        expect(h['Authorization']).toBeUndefined();
    });

    it('40-char token → Bearer (API Token mode)', () => {
        const h = mod.cfAuthHeaders(API_TOKEN, 'admin@example.com');
        expect(h['Authorization']).toBe(`Bearer ${API_TOKEN}`);
        expect(h['X-Auth-Key']).toBeUndefined();
    });

    it('37-hex credential WITHOUT email → Bearer fallback (nothing better available)', () => {
        const h = mod.cfAuthHeaders(GLOBAL_KEY, undefined);
        expect(h['Authorization']).toBe(`Bearer ${GLOBAL_KEY}`);
    });

    it('case-insensitive hex detection', () => {
        const h = mod.cfAuthHeaders('A'.repeat(37), 'admin@example.com');
        expect(h['X-Auth-Key']).toBe('A'.repeat(37));
    });

    it('non-hex 37-char credential stays Bearer (scoped token lookalike)', () => {
        const h = mod.cfAuthHeaders('g'.repeat(37), 'admin@example.com'); // g خروج از hex
        expect(h['Authorization']).toBe(`Bearer ${'g'.repeat(37)}`);
    });

    it('cfAuthFromGlobals reads the embedded settings', () => {
        const h = mod.cfAuthFromGlobals();
        expect(h['X-Auth-Key']).toBe(GLOBAL_KEY);
        expect(h['X-Auth-Email']).toBe('admin@example.com');
    });
});
