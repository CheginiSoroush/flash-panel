import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

/**
 * v0.8.50 — سقف زمانی واکشی ساب‌های سفارشی (fetchCustomSubs در src/cores/common.ts)
 *
 * کلاس باگ (پنجمین عضو خانواده‌ی «آپ‌استریم بی‌سقف» — بعد از DoH در v0.8.44،
 * my-ip در v0.8.45 و زنجیره‌ی کرون در v0.8.46):
 *   fetchCustomSubs روی هر درخواست ساب «raw» با fetch خام و بدون AbortController
 *   URLهای customSubs را می‌خواند. یک URL آویزان (سرور مرده/سیاه‌چاله/اتصال
 *   نیمه‌باز) کل تولید ساب raw را برای همیشه نگه می‌داشت → کلاینتِ مسیر raw
 *   «خطای آپدیت — بدون کانفیگ» می‌دید؛ همان خانواده‌ی UX «سرو نمی‌شود».
 *
 * استراتژی تست (الگوی cron-fetch-timeouts.test.ts): استاب fetch «خوب‌رفتار» که
 * به AbortSignal گوش می‌دهد و روی abort رد می‌شود. روی کد قدیمی (بدون signal)
 * هیچ‌وقت settle نمی‌شود → تست با timeout ران قرمز می‌شود (اثبات RED).
 * قرارداد حفظ‌شده: ساب سفارشیِ مرده هرگز کل ساب raw را نمی‌شکند — فقط محتوای
 * خودش حذف می‌شود (catch موجود → '')؛ تست گارد محتوای ساب سالم را هم پوشش می‌دهد.
 */

// ---------- globals زنجیره‌ی import (الگوی sub-body-purity.test.ts) ----------
(globalThis as any).VERSION = '0.8.50';
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

const FAST_SUB_URL = 'https://fast-sub.example.com/list';
const HANG_SUB_URL = 'https://hang-sub.example.com/list';
const FAST_SUB_BODY = 'fast-node-content';

// ---------- استاب fetch — DoH جواب ثابت، ساب آویزان فقط با signal می‌میرد ----------
vi.stubGlobal('fetch', vi.fn(async (input: any, init?: { signal?: AbortSignal }) => {
    const url = String(input instanceof URL ? input : input?.url ?? input);
    if (url.includes('cloudflare-dns.com')) {
        const type = new URL(url).searchParams.get('type');
        const records = type === 'A' ? ['1.2.3.4'] : ['2606:4700:4700::1111'];
        return new Response(JSON.stringify({
            Answer: records.map(data => ({ type: type === 'A' ? 1 : 28, TTL: 300, data }))
        }), { status: 200, headers: { 'Content-Type': 'application/dns-json' } });
    }
    if (url === FAST_SUB_URL) {
        return new Response(FAST_SUB_BODY, { status: 200 });
    }
    if (url === HANG_SUB_URL) {
        // آویختگی واقعی — بدون signal هرگز settle نمی‌شود (کد قدیمی = قرمزِ زمانی)
        return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')));
        });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
}));

let settingsMod: typeof import('../src/settings/settings');
let kvMod: typeof import('../src/settings/kv');
let commonMod: typeof import('../src/cores/common');

function kvMockWithCustomSubs(subs: string[]) {
    return {
        get: async (key: string) => {
            if (key === 'proxySettings') {
                return { ...settingsMod.getKvSettings(), customSubs: subs };
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

async function rawBody(): Promise<string> {
    const res = await commonMod.getURLConfigs();
    expect(res.status).toBe(200);
    return await res.text();
}

describe('custom-sub fetch timeout (v0.8.50 contract)', () => {
    beforeAll(async () => {
        settingsMod = await import('../src/settings/settings');
        kvMod = await import('../src/settings/kv');
        commonMod = await import('../src/cores/common');

        settingsMod.init(
            new Request('https://example.com/sp/sub/raw', {
                headers: { 'User-Agent': 'v2rayNG/1.8.5' }
            }),
            { kv: {} } as Env
        );
    });

    beforeEach(() => {
        kvMod.invalidateDatasetCache();
        // فراخوانی اختیاری — روی کد قدیمی (بدون هُک) سقف تولیدی ۱۰ث می‌ماند و
        // ساب آویزان واقعاً آویزان می‌ماند → قرمزِ زمانی (اثبات RED صادق)
        (commonMod as any)._setCustomSubFetchTimeoutForTest?.(150);
    });

    afterEach(() => {
        kvMod.invalidateDatasetCache();
    });

    it('a hanging custom sub cannot stall the raw subscription — completes bounded', async () => {
        const { setSettings } = settingsMod;
        const env = { kv: kvMockWithCustomSubs([HANG_SUB_URL]) } as unknown as Env;
        await setSettings(env);

        const body = await rawBody();
        expect(body.length).toBeGreaterThan(0);
    });

    it('graceful degradation — healthy sub content included, hanging one skipped', async () => {
        const { setSettings } = settingsMod;
        const env = { kv: kvMockWithCustomSubs([FAST_SUB_URL, HANG_SUB_URL]) } as unknown as Env;
        await setSettings(env);

        const body = await rawBody();
        // بدنه‌ی raw پایه‌۶۴ است — محتوای ساب سالم باید داخلش باشد
        const decoded = Buffer.from(body, 'base64').toString('utf-8');
        expect(decoded).toContain(FAST_SUB_BODY);
    });
});
