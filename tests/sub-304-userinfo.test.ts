import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';

/**
 * v0.8.61 — 304 ساب باید هدرهای per-request را منعکس کند (subscription.ts)
 *
 * کلاس باگی که این تست‌ها نابود می‌کنند:
 *   پاس 304 فقط ETag برمی‌گرداند. اما انقضای کاربر اشتراک (subUserExpiresAt)
 *   آگاهانه جزو ورودی‌های ETag نیست (بدنه embed‌اش نمی‌کند) — تنها کانال
 *   رساندنش به کلاینت هدر subscription-userinfo است. نتیجه‌ی مسیر قدیمی:
 *   ادمین انقضای کاربر را تمدید/تغییر می‌دهد → KV به‌روز، ولی تا وقتی هیچ
 *   ورودی دیگری از ETag (settings/اکانت WARP/DNS) نچرخد، همان ETag قبلی
 *   معتبر می‌ماند → 304 بدون userinfo → نمایش/هشدار انقضا در v2rayNG/Hiddify
 *   برای همیشه روی مقدار کهنه می‌ماند.
 *
 * رفتار درست: 304 فراداده‌ی 200 را منعکس می‌کند (RFC 9110 §15.4.5) —
 * userinfo تازه (از خواندن KV همان درخواست)، profile-* و X-Sub-User.
 */

(globalThis as any).VERSION = '0.8.61';
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

// ---------- کاربر اشتراک چندکاربره ----------

const SUB_USER_ID = '3fa85f64-5717-4a89-b312-2c963f66afa6'; // UUID v4 معتبر
const DAY = 24 * 60 * 60 * 1000;

function subUsersSeed(expiresAt: number) {
    return [{
        id: SUB_USER_ID,
        name: 'tester',
        createdAt: Date.now() - 10 * DAY,
        active: true,
        expiresAt
    }];
}

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

function freshEnv(expiresAt: number) {
    return createKvMock({
        proxySettings: null,
        telegramBot: { telegramBotToken: '', telegramUserId: '' },
        subUsers: subUsersSeed(expiresAt)
    });
}

let settings: typeof import('../src/settings/settings');
let kvmod: typeof import('../src/settings/kv');
let store: typeof import('../src/settings/store');
let subusers: typeof import('../src/settings/sub-users');
let sub: typeof import('../src/handlers/subscription');
let optimize: typeof import('../src/handlers/optimize');

beforeAll(async () => {
    settings = await import('../src/settings/settings');
    kvmod = await import('../src/settings/kv');
    store = await import('../src/settings/store');
    subusers = await import('../src/settings/sub-users');
    sub = await import('../src/handlers/subscription');
    optimize = await import('../src/handlers/optimize');

    settings.init(
        new Request('https://example.com/sp/sub/normal?app=clash'),
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
    subusers._resetSubUsersWriteQueueForTest();
    subusers._resetSubUserFetchState();
    optimize.subBodyCache.clear();
});

/** اول یک 200 بی‌قید برای گرفتن ETag، بعد همان درخواست شرطی —
 *  هر درخواست با settings.init روی globals خودش (pathname/client) mount می‌شود
 *  (همان الگوی tests/sub-users.test.ts — globals از Request می‌آیند نه URL ماژول) */
async function conditionalAgainst(env: any, url: string): Promise<Response> {
    const firstReq = new Request(url, { headers: { 'User-Agent': 'ClashForAndroid/2.5.12' } });
    settings.init(firstReq, env);
    const first = await sub.handleSubscriptions(firstReq, env);
    expect(first.status).toBe(200);
    const etag = first.headers.get('ETag');
    expect(etag).toBeTruthy();

    const conditional = new Request(url, {
        method: 'GET',
        headers: { 'User-Agent': 'ClashForAndroid/2.5.12', 'If-None-Match': etag! }
    });
    settings.init(conditional, env);
    const res = await sub.handleSubscriptions(conditional, env);
    return res;
}

describe('304 ساب: انعکاس هدرهای per-request (v0.8.61)', () => {

    it('🔴 رگرسیون اصلی — تغییر انقضای کاربر روی 304 بعدی دیده می‌شود (ETag ثابت می‌ماند)', async () => {
        const expire1 = Date.now() + 30 * DAY;
        const expire2 = Date.now() + 60 * DAY;
        const { kv, store: kvStore } = freshEnv(expire1);
        const env = { kv } as any;
        await settings.setSettings(env);

        const url = `https://example.com/sp/sub/${SUB_USER_ID}/normal?app=clash`;
        const res304 = await conditionalAgainst(env, url);
        expect(res304.status).toBe(304);

        // کد قدیمی: 304 فقط ETag دارد — userinfo اصلاً غایب است
        const ui1 = res304.headers.get('subscription-userinfo');
        expect(ui1).toBeTruthy();
        expect(ui1).toContain(`expire=${Math.floor(expire1 / 1000)}`);
        expect(res304.headers.get('ETag')).toBeTruthy();

        // ادمین انقضا را تمدید می‌کند — هیچ ورودی دیگری از ETag عوض نمی‌شود
        kvStore.set('subUsers', JSON.stringify(subUsersSeed(expire2)));
        kvmod.invalidateDatasetCache();
        subusers._resetSubUserFetchState();
        await settings.setSettings(env);

        // پیش‌فرض پین‌شده: انقضا ورودی ETag نیست (فراداده است، نه بدنه)
        const etag1 = res304.headers.get('ETag');
        const res304b = await conditionalAgainst(env, url);
        expect(res304b.status).toBe(304);
        expect(res304b.headers.get('ETag')).toBe(etag1); // ETag همان — همان کلاس 304 ابدیِ فراداده

        // اما userinfo تازه است → کلاینت نمایش انقضا را به‌روز می‌کند
        const ui2 = res304b.headers.get('subscription-userinfo');
        expect(ui2).toBeTruthy();
        expect(ui2).toContain(`expire=${Math.floor(expire2 / 1000)}`);
        expect(ui2).not.toBe(ui1);
    });

    it('304 چندکاربره X-Sub-User و profile-* را هم می‌برد', async () => {
        const { kv } = freshEnv(Date.now() + 30 * DAY);
        const env = { kv } as any;
        await settings.setSettings(env);

        const url = `https://example.com/sp/sub/${SUB_USER_ID}/normal?app=clash`;
        const res304 = await conditionalAgainst(env, url);
        expect(res304.status).toBe(304);
        expect(res304.headers.get('X-Sub-User')).toBe(SUB_USER_ID);
        expect(res304.headers.get('profile-update-interval')).toBe('3');
        expect(res304.headers.get('profile-web-page-url')).toBe('https://example.com');
    });

    it('گارد — مسیر 200 همچنان userinfo تازه دارد (رفتار حفظ شده)', async () => {
        const expire = Date.now() + 45 * DAY;
        const { kv } = freshEnv(expire);
        const env = { kv } as any;
        await settings.setSettings(env);

        const url = `https://example.com/sp/sub/${SUB_USER_ID}/normal?app=clash`;
        const req200 = new Request(url, { headers: { 'User-Agent': 'ClashForAndroid/2.5.12' } });
        settings.init(req200, env);
        const res200 = await sub.handleSubscriptions(req200, env);
        expect(res200.status).toBe(200);
        const ui = res200.headers.get('subscription-userinfo');
        expect(ui).toContain(`expire=${Math.floor(expire / 1000)}`);
    });

    it('گارد — مسیر ادمین (بدون کاربر) userinfo ندارد، 304 یا 200', async () => {
        const { kv } = freshEnv(Date.now() + 30 * DAY);
        const env = { kv } as any;
        await settings.setSettings(env);

        const url = 'https://example.com/sp/sub/normal?app=clash';
        const res = await conditionalAgainst(env, url);
        expect(res.status).toBe(304);
        expect(res.headers.get('subscription-userinfo')).toBeNull();
        expect(res.headers.get('profile-update-interval')).toBe('3'); // profile-* برای همه‌ی مسیرهای غیر share
    });

    it('گارد — share-settings روی 304 هدرهای پروفایل/userinfo ندارد', async () => {
        const { kv } = freshEnv(Date.now() + 30 * DAY);
        const env = { kv } as any;
        await settings.setSettings(env);

        const url = 'https://example.com/sp/sub/share-settings';
        const res = await conditionalAgainst(env, url);
        expect(res.status).toBe(304);
        expect(res.headers.get('profile-update-interval')).toBeNull();
        expect(res.headers.get('profile-web-page-url')).toBeNull();
        expect(res.headers.get('subscription-userinfo')).toBeNull();
        expect(res.headers.get('ETag')).toBeTruthy(); // فقط ETag — مثل قبل
    });
});
