import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';

/**
 * v0.8.30 — ETag اشتراک باید اکانت‌های WARP را پوشش دهد (src/handlers/subscription.ts)
 *
 * کلاس باگی که این تست‌ها نابود می‌کنند:
 *   ETag ساب از { نسخه، مسیر، کلاینت، کاربر، getSettings() } ساخته می‌شد — اما
 *   بدنه‌ی ساب‌های warp/wow/wireguard علاوه بر settings، اکانت‌های WARP را هم
 *   embed می‌کند (getWarpAccounts در cores/clash + xray + sing-box + wireguard).
 *   اکانت‌های WARP در «کلید KV جداگانه» (warpAccounts) زندگی می‌کنند و دو نویسنده‌ی
 *   runtime دارند: دکمه‌ی «به‌روزرسانی WARP» پنل (panel.ts updateWarpConfigs) و
 *   self-heal مرز لود (kv.ts loadDataset). بعد از هر تغییر:
 *     • کلاینت شرطی (If-None-Match — Clash/Verge/mihomo/v2rayNG همه ETag می‌فهمند)
 *       → ETag همان قبلی → 304 ابدی → کلید خصوصی/IPv6/reserved کهنه تا همیشه
 *       = دقیقاً «نود وایرگارد وصل می‌شود ولی هیچ ترافیکی رد نمی‌شود».
 *     • کلید subBodyCache هم همان ETag است (آن‌جا TTL ۵ دقیقه سقف است؛ 304 بدون سقف).
 *
 * رفتار درست: چرخش اکانت‌ها → ETag نو → کلاینت بدنه‌ی نو با اعتبارنامه‌ی نو می‌گیرد.
 * + گارد ضد-flap: خواندن دوباره‌ی همان اکانت‌ها (نمونه‌ی آرایه‌ی نو از JSON) نباید ETag را تکاند.
 */

(globalThis as any).VERSION = '0.8.30';
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
    proxyIpMode: 'proxyip',
    proxyIPs: [] as string[],
    prefixes: [] as string[],
    forceProxyDomains: [],
    mainDomain: 'example.com',
    fallback: '',
    dohUrl: ''
};

// ---------- اکانت‌های WARP واقعی‌نما (فرمت embeded پنل) ----------

const acc1 = {
    privateKey: '4NyxMUme2zGv5r3QWI0hJBlNglm1J/thoCE55PK29G8=',
    publicKey: 'bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=',
    warpIPv6: '2606:4700:110:8fd2:11f3:8e67:11d4:3704/128',
    reserved: 'N16D'
};
const acc2 = {
    privateKey: 'aPQwXZBOndL0km0Swo0ArDOoy3bjeZzTu+/d4YHxW04=',
    publicKey: 'bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=',
    warpIPv6: '2606:4700:110:859d:1029:4dfa:bf63:ff08/128',
    reserved: 'SmWi'
};
// نسل بعد — عیناً همان شکلی که fetchWarpAccounts بعد از دکمه‌ی پنل/self-heal می‌سازد
const acc3 = {
    privateKey: 'R3nd1eedPrivateKay000000000000000000000000000=',
    publicKey: 'R3nd1eedPublicKey0000000000000000000000000000=',
    warpIPv6: '2606:4700:110:cccc:1111:2222:3333:6666/128',
    reserved: 'Q0ND'
};
const acc4 = {
    privateKey: 'R3nd1eedPrivateKay111111111111111111111111111=',
    publicKey: 'R3nd1eedPublicKey1111111111111111111111111111=',
    warpIPv6: '2606:4700:110:dddd:1111:2222:3333:7777/128',
    reserved: 'RERE'
};

/** mock KV هم‌رفتار با Workers واقعی: JSON نامعتبر → null */
function createKvMock(seed: Record<string, unknown> = {}) {
    const store = new Map<string, string>(
        Object.entries(seed).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])
    );
    const kv = {
        async get(key: string, opts?: { type?: string }) {
            const raw = store.get(key);
            if (raw === undefined) return null;
            if (opts?.type !== 'json') return raw;
            try {
                return JSON.parse(raw);
            } catch {
                return null;
            }
        },
        async put(key: string, value: string) {
            store.set(key, value);
        },
        async delete(key: string) {
            store.delete(key);
        }
    };
    return { kv, store };
}

/** proxySettings = null → بوت‌استرپ با پیش‌فرض‌های کامل ماژول (بدون مهاجرت) */
function freshEnv() {
    return createKvMock({
        proxySettings: null,
        telegramBot: { telegramBotToken: '', telegramUserId: '' },
        warpAccounts: [acc1, acc2]
    });
}

let settings: typeof import('../src/settings/settings');
let kvmod: typeof import('../src/settings/kv');
let store: typeof import('../src/settings/store');
let sub: typeof import('../src/handlers/subscription');
let optimize: typeof import('../src/handlers/optimize');

beforeAll(async () => {
    settings = await import('../src/settings/settings');
    kvmod = await import('../src/settings/kv');
    store = await import('../src/settings/store');
    sub = await import('../src/handlers/subscription');
    optimize = await import('../src/handlers/optimize');

    settings.init(
        new Request('https://example.com/sp/sub/warp?app=clash'),
        { kv: new Map() } as any
    );
});

beforeEach(() => {
    optimize.subBodyCache.clear();
});

afterEach(() => {
    kvmod.invalidateDatasetCache();
    kvmod._resetMigrationThrottleForTest();
    store._resetStoreStateForTest();
    optimize.subBodyCache.clear();
});

describe('sub ETag: پوشش اکانت‌های WARP (v0.8.30)', () => {

    it('🔴 رگرسیون اصلی — چرخش اکانت‌های WARP باید ETag ساب warp را عوض کند', async () => {
        const { kv, store: kvStore } = freshEnv();
        const env = { kv } as any;

        await settings.setSettings(env);
        const etagBefore = await sub.computeSubETag('warp', 'clash');

        // ادمین دکمه‌ی «به‌روزرسانی WARP» را می‌زند / self-heal رخ می‌دهد
        kvStore.set('warpAccounts', JSON.stringify([acc3, acc4]));
        kvmod.invalidateDatasetCache();
        await settings.setSettings(env);

        expect(settings.getWarpAccounts()[0].publicKey).toBe(acc3.publicKey); // state واقعاً چرخید
        const etagAfter = await sub.computeSubETag('warp', 'clash');

        // کد قدیمی: برابر → 304 ابدی → کلاینت هرگز اعتبارنامه‌ی نو نمی‌گیرد
        expect(etagAfter).not.toBe(etagBefore);
    });

    it('304 → 200 انتها-به-انتها — کلاینت شرطی بعد از چرخش، بدنه‌ی نو می‌گیرد', async () => {
        const { kv, store: kvStore } = freshEnv();
        const env = { kv } as any;

        await settings.setSettings(env);
        const etag = await sub.computeSubETag('warp', 'clash');

        // همان نسخه → 304 (رفتار درست کش شرطی)
        const conditional = () => new Request('https://example.com/x', {
            method: 'GET',
            headers: { 'If-None-Match': etag }
        });
        const res304 = await sub.handleSubscriptions(conditional(), env);
        expect(res304.status).toBe(304);

        // چرخش اکانت‌ها + همان درخواست شرطی
        kvStore.set('warpAccounts', JSON.stringify([acc3, acc4]));
        kvmod.invalidateDatasetCache();

        const res200 = await sub.handleSubscriptions(conditional(), env);
        expect(res200.status).toBe(200); // کد قدیمی: 304 — باگ
        const body = await res200.text();
        expect(body).toContain(acc3.publicKey); // اعتبارنامه‌ی نو واقعاً سرو شد
    });

    it('ضد-flap — خواندن دوباره‌ی همان اکانت‌ها (نمونه‌ی نو از JSON) ETag را ثابت نگه می‌دارد', async () => {
        const { kv } = freshEnv();
        const env = { kv } as any;

        await settings.setSettings(env);
        const etagA = await sub.computeSubETag('warp', 'clash');

        kvmod.invalidateDatasetCache();
        await settings.setSettings(env); // آرایه‌ی نو، محتوای یکسان
        const etagB = await sub.computeSubETag('warp', 'clash');

        expect(etagB).toBe(etagA);
    });

    it('گارد رگرسیون — تغییر settings هنوز ETag را عوض می‌کند (پوشش قبلی سالم)', async () => {
        const { kv, store: kvStore } = freshEnv();
        const env = { kv } as any;

        await settings.setSettings(env);
        const etagBefore = await sub.computeSubETag('warp', 'clash');

        const blob = JSON.parse(kvStore.get('proxySettings')!);
        blob.ports = [443, 2053];
        kvStore.set('proxySettings', JSON.stringify(blob));
        kvmod.invalidateDatasetCache();
        await settings.setSettings(env);

        const etagAfter = await sub.computeSubETag('warp', 'clash');
        expect(etagAfter).not.toBe(etagBefore);
    });
});
