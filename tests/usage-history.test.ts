import { describe, it, expect, beforeAll } from 'vitest';

/**
 * تست سری زمانی مصرف روزانه — record + history + هرس + بازیابی از خرابی KV
 * و endpoint پنل (401 بدون session / 200 با session واقعی)
 */

// ---------- globals شبیه‌سازی‌شده ----------

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
(globalThis as any).VERSION = '0.3.8';
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

function utcDateKey(offsetDays = 0): string {
    return new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

describe('usage history — KV time-series', () => {
    let usage: typeof import('../src/settings/usage-history');
    let settings: typeof import('../src/settings/settings');

    beforeAll(async () => {
        settings = await import('../src/settings/settings');
        usage = await import('../src/settings/usage-history');

        settings.init(
            new Request('https://example.com/sp/panel', {
                headers: { 'CF-Connecting-IP': '1.2.3.4' }
            }),
            { kv: createKvMock().kv } as Env
        );
    });

    it('records today’s sample on empty KV', async () => {
        const { kv, store } = createKvMock();
        await usage.recordUsageSample({ kv } as Env, 1234, 567);

        const raw = store.get('usageHistory')!;
        const map = JSON.parse(raw);
        expect(map[utcDateKey()]).toBeDefined();
        expect(map[utcDateKey()].total).toBe(1234);
        expect(map[utcDateKey()].worker).toBe(567);
        expect(map[utcDateKey()].samples).toBe(1);
    });

    it('latest sample wins and samples counter increments', async () => {
        const { kv, store } = createKvMock();
        await usage.recordUsageSample({ kv } as Env, 1000, 100);
        await usage.recordUsageSample({ kv } as Env, 2500, 300);
        await usage.recordUsageSample({ kv } as Env, 9999, 999);

        const map = JSON.parse(store.get('usageHistory')!);
        expect(map[utcDateKey()].total).toBe(9999);
        expect(map[utcDateKey()].worker).toBe(999);
        expect(map[utcDateKey()].samples).toBe(3);
    });

    it('ignores invalid inputs (negative / NaN / Infinity)', async () => {
        const { kv, store } = createKvMock();
        await usage.recordUsageSample({ kv } as Env, -5, 10);
        await usage.recordUsageSample({ kv } as Env, Number.NaN, 10);
        await usage.recordUsageSample({ kv } as Env, 10, Number.POSITIVE_INFINITY);
        expect(store.has('usageHistory')).toBe(false);
    });

    it('history gap-fills missing days with null in ascending order', async () => {
        const { kv, store } = createKvMock();
        const env = { kv } as Env;
        // فقط امروز و ۳ روز پیش — روزهای بین باید null شوند
        await usage.recordUsageSample({ kv } as Env, 500, 50);
        // دستی: ۳ روز پیش
        const raw = JSON.parse(store.get('usageHistory')!);
        raw[utcDateKey(-3)] = { date: utcDateKey(-3), total: 100, worker: 10, samples: 1, updatedAt: Date.now() - 3 * 86400_000 };
        store.set('usageHistory', JSON.stringify(raw));

        const { days } = await usage.getUsageHistory(env, 5);
        expect(days).toHaveLength(5);
        // صعودی: ۴ روز پیش null، ۳ روز پیش داده، ۲ و ۱ روز پیش null، امروز داده
        expect(days[0]).toBeNull();
        expect(days[1]?.total).toBe(100);
        expect(days[2]).toBeNull();
        expect(days[3]).toBeNull();
        expect(days[4]?.total).toBe(500);
    });

    it('clamps requested days into 1..31 range', async () => {
        const { kv } = createKvMock();
        const env = { kv } as Env;

        expect((await usage.getUsageHistory(env, 0)).days).toHaveLength(30); // falsy → پیش‌فرض
        expect((await usage.getUsageHistory(env, -10)).days).toHaveLength(1);
        expect((await usage.getUsageHistory(env, 500)).days).toHaveLength(31);
        expect((await usage.getUsageHistory(env, 7)).days).toHaveLength(7);
    });

    it('prunes history older than 31 days on each record', async () => {
        const oldDate = utcDateKey(-40);
        const { kv, store } = createKvMock({
            usageHistory: JSON.stringify({
                [oldDate]: { date: oldDate, total: 1, worker: 1, samples: 1, updatedAt: Date.now() - 40 * 86400_000 }
            })
        });

        await usage.recordUsageSample({ kv } as Env, 42, 24);
        const map = JSON.parse(store.get('usageHistory')!);
        expect(map[oldDate]).toBeUndefined();
        expect(map[utcDateKey()].total).toBe(42);
    });

    it('recovers from corrupted KV JSON without throwing', async () => {
        const { kv } = createKvMock({ usageHistory: '{broken json!!' });
        const env = { kv } as Env;

        const { days } = await usage.getUsageHistory(env, 3);
        expect(days).toHaveLength(3);
        expect(days.every(d => d === null)).toBe(true);

        // ثبت بعد از خرابی هم باید کار کند و KV را دوباره سالم کند
        await usage.recordUsageSample({ kv } as Env, 77, 7);
        const { days: after } = await usage.getUsageHistory(env, 1);
        expect(after[0]?.total).toBe(77);
    });

    it('filters malformed entries out of the map', async () => {
        const { kv } = createKvMock({
            usageHistory: JSON.stringify({
                [utcDateKey()]: { date: utcDateKey(), total: 'oops', worker: 1, samples: 1, updatedAt: Date.now() },
                'not-a-date': { date: 'not-a-date', total: 5, worker: 1, samples: 1, updatedAt: Date.now() },
                [utcDateKey(-1)]: { date: utcDateKey(-1), total: 250, worker: 25, samples: 2, updatedAt: Date.now() - 86400_000 }
            })
        });

        const { days, lastRecorded } = await usage.getUsageHistory({ kv } as Env, 2);
        expect(days[0]?.total).toBe(250);   // دیروز سالم
        expect(days[1]).toBeNull();          // امروزِ خراب فیلتر شده
        expect(lastRecorded).toBe(utcDateKey(-1));
    });
});

describe('usage history endpoint — panel/usage/history', () => {
    let endpoint: typeof import('../src/api/usage');
    let auth: typeof import('../src/auth/auth');

    beforeAll(async () => {
        const settings = await import('../src/settings/settings');
        endpoint = await import('../src/api/usage');
        auth = (await import('../src/auth/auth')) as any;

        settings.init(
            new Request('https://example.com/sp/panel/usage/history', {
                headers: { 'CF-Connecting-IP': '1.2.3.4' }
            }),
            { kv: createKvMock().kv } as Env
        );
    });

    function authedRequest(token: string, url = 'https://example.com/sp/panel/usage/history'): Request {
        return new Request(url, {
            headers: { Cookie: `jwtToken=${token}` }
        });
    }

    it('returns 401 without a session', async () => {
        const { kv } = createKvMock({ pwd: 'correct-pass' });
        const env = { kv } as Env;

        const res = await endpoint.getUsageHistoryEndpoint(
            new Request('https://example.com/sp/panel/usage/history'), env
        );

        expect(res.status).toBe(401);
    });

    it('returns history with quota for an authenticated session', async () => {
        const { kv } = createKvMock({ pwd: 'correct-pass' });
        const env = { kv } as Env;

        // session واقعی
        const loginRes = await auth.generateJWTToken(new Request('https://example.com/sp/login/authenticate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.9.8.7' },
            body: JSON.stringify({ username: 'admin@example.com', password: 'correct-pass' })
        }), env);
        const token = (loginRes.headers.get('Set-Cookie') || '').match(/jwtToken=([^;]*)/)?.[1] ?? '';
        expect(token).not.toBe('');

        // یک نمونه ثبت کن
        await (await import('../src/settings/usage-history')).recordUsageSample(env, 8000, 800);

        const res = await endpoint.getUsageHistoryEndpoint(authedRequest(token), env);
        expect(res.status).toBe(200);

        const { success, body } = await res.json();
        expect(success).toBe(true);
        expect(body.days).toHaveLength(30);
        expect(body.quotaDaily).toBe(100000);
        expect(body.lastRecorded).toBe(utcDateKey());
        expect(body.days.at(-1)?.total).toBe(8000);
    });
});
