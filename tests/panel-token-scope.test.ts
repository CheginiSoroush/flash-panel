import { describe, it, expect, beforeAll, vi } from 'vitest';

/**
 * v0.8.39 — loadApiToken فقط روی زیرمسیرهای واقعاً مصرف‌کننده‌ی CF-API
 *
 * تا v0.8.38 هر زیرمسیر پنل غیر از رندر HTML یک `loadApiToken` می‌زد — یعنی
 * logout، totp-status (مسیر داغ عمومی که صفحه‌ی login در هر بازدید صدا می‌زند)،
 * sub-users، my-ip، edge، usage/history (فقط KV می‌خواند) و update-warp (API
 * مصرف‌کننده‌ی WARP است، نه apiToken پنل) همگی هزینه‌ی یک خواندن KV توکن را
 * می‌پرداختند (سقف: ۱ خواندن اضافه در ۵ث کش). فقط سه مسیر apiToken واقعی
 * مصرف می‌کنند: usage (GraphQL)، update-panel و delete-panel (deploy/delete API).
 *
 * تست‌ها بدون نشست معتبر می‌رانند — گیتِ توکن «قبل از» سوئیچ است، پس رفتارش
 * مستقل از احراز قابل‌اندازه‌گیری است (قرارداد: گیت قبل از auth، همان‌جا می‌ماند).
 */

vi.mock('@settings', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    let calls = 0;
    return {
        ...actual,
        loadApiToken: async () => { calls++; },
        _tokenLoadCalls: () => calls,
        _resetTokenLoadCalls: () => { calls = 0; },
    };
});

// ---------- globals شبیه‌سازی‌شده (همان الگوی usage-history.test) ----------

const MOCK_EMBEDED = {
    accID: 'test-account-id',
    accEmail: 'admin@example.com',
    apiToken: 'embedded-token',
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
(globalThis as any).VERSION = '0.8.39';
(globalThis as any)._repo_ = 'https://github.com/CheginiSoroush/flash-panel';
(globalThis as any)._public_proxy_ip_ = 'bpb.yousef.isegaro.com';

// ---------- KV mock ----------

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
        },
        async delete(key: string) {
            store.delete(key);
        }
    } as unknown as KVNamespace;
    return { kv, store };
}

describe('v0.8.39 — loadApiToken gate scoped to real CF-API panel paths', () => {
    let panel: typeof import('../src/handlers/panel');
    let settings: typeof import('../src/settings/settings');
    let settingsMod: typeof import('../src/settings/settings') & {
        _tokenLoadCalls(): number;
        _resetTokenLoadCalls(): void;
    };

    beforeAll(async () => {
        settings = await import('../src/settings/settings');
        panel = await import('../src/handlers/panel');
        settingsMod = (await import('../src/settings/settings')) as typeof settings & {
            _tokenLoadCalls(): number;
            _resetTokenLoadCalls(): void;
        };
    });

    /** handlePanel را با مسیر داده‌شده می‌راند (بدون نشست — 401/200 انتظار) */
    async function drive(path: string, method = 'GET'): Promise<Response> {
        const { kv } = createKvMock();
        settings.init(
            new Request(`https://example.com/sp/${path}`, {
                method,
                headers: { 'CF-Connecting-IP': '1.2.3.4' }
            }),
            { kv } as Env
        );
        const req = new Request(`https://example.com/sp/${path}`, { method });
        return panel.handlePanel(req, { kv } as Env);
    }

    it('non-CF paths never load the token — even the hot login-page totp-status', async () => {
        const paths = [
            'panel/totp/status',   // مسیر داغ عمومی — صفحه‌ی login هر بازدید صدا می‌زند
            'panel/logout',        // فقط پاک‌کردن کوکی
            'panel/usage/history', // فقط سری KV — بدون GraphQL (مستند در usage.ts)
            'panel/sub-users',     // KV + صف نوشتن
            'panel/settings',      // KV
            'panel/my-ip',         // هدرهای درخواست
            'panel/edge',          // KV تلِمتری
            'panel/update-warp'    // API مصرف‌کننده‌ی WARP (api.cloudflareclient.com) — بدون apiToken
        ];
        for (const p of paths) {
            settingsMod._resetTokenLoadCalls();
            const res = await drive(p);
            expect(settingsMod._tokenLoadCalls(), `path ${p} must not load the token`).toBe(0);
            expect(res.status, `path ${p} must answer cleanly`).toBeLessThan(500);
        }
    });

    it('CF-API paths still load the token before auth (usage/update-panel/delete-panel)', async () => {
        const cases: Array<[string, string]> = [
            ['panel/usage', 'GET'],
            ['panel/update-panel', 'POST'],
            ['panel/delete-panel', 'POST']
        ];
        for (const [p, method] of cases) {
            settingsMod._resetTokenLoadCalls();
            const res = await drive(p, method);
            expect(settingsMod._tokenLoadCalls(), `path ${p} must load the token`).toBe(1);
            // بدون نشست → 401 — ولی گیت توکن قبل از auth اجرا شده (قرارداد v0.8.16 حفظ)
            expect(res.status, `path ${p} unauthenticated`).toBe(401);
        }
    });

    it('unknown paths keep the exemption (fallback never loads the token)', async () => {
        settingsMod._resetTokenLoadCalls();
        await drive('panel/unknown-sub');
        expect(settingsMod._tokenLoadCalls()).toBe(0);
    });
});
