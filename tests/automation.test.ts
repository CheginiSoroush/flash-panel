import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    createSubUser,
    getSubUsers,
    isSubUserExpired,
    resolveSubUser,
    resolveAndRecordSubUser,
    sweepExpiredSubUsers,
    updateSubUser,
    SubUser,
    _resetSubUserFetchState
} from '../src/settings/sub-users';
import { expiryBadge } from '../src/api/telegram-broadcast';

// ماژول automation از @settings وارد می‌شود که در بارگذاری به VERSION نیاز دارد —
// پس import آن داینامیک است (هم‌الگوی doh.test.ts / ws-guardian.test.ts)
(globalThis as any).VERSION = '0.4.0';

// ---------- KV mock — رفتار واقعی: مقدار رشته، type:json پارس می‌شود ----------

function createKvMock() {
    const store = new Map<string, string>();
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

const NOW = 1_800_000_000_000; // 2027-01-15T05:20:00Z — ثابت برای قطعیت تست‌ها
const DAY = 24 * 60 * 60 * 1000;

// ---------- isSubUserExpired ----------

describe('isSubUserExpired', () => {
    it('returns false for users without expiry', () => {
        const user = { id: crypto.randomUUID(), name: 'A', createdAt: 1, active: true } as SubUser;
        expect(isSubUserExpired(user, NOW)).toBe(false);
    });

    it('returns false for garbage expiresAt values', () => {
        const base = { id: crypto.randomUUID(), name: 'A', createdAt: 1, active: true } as SubUser;
        expect(isSubUserExpired({ ...base, expiresAt: undefined }, NOW)).toBe(false);
        expect(isSubUserExpired({ ...base, expiresAt: NaN }, NOW)).toBe(false);
        expect(isSubUserExpired({ ...base, expiresAt: 0 }, NOW)).toBe(false);
        expect(isSubUserExpired({ ...base, expiresAt: -5 }, NOW)).toBe(false);
    });

    it('flags exactly-at and past expiry', () => {
        const base = { id: crypto.randomUUID(), name: 'A', createdAt: 1, active: true } as SubUser;
        expect(isSubUserExpired({ ...base, expiresAt: NOW }, NOW)).toBe(true);
        expect(isSubUserExpired({ ...base, expiresAt: NOW - 1 }, NOW)).toBe(true);
        expect(isSubUserExpired({ ...base, expiresAt: NOW + 1 }, NOW)).toBe(false);
    });
});

// ---------- resolve با انقضا — سلف-اجراکننده ----------

describe('expiry-aware resolve', () => {
    beforeEach(() => {
        _resetSubUserFetchState();
    });

    it('resolveSubUser returns null for an expired active user', async () => {
        const { kv } = createKvMock();
        const env = { kv } as Env;
        const user = await createSubUser(env, 'Ali');
        expect(user).not.toBeNull();

        // ست کردن انقضای گذشته مستقیماً در KV — updateSubUser گذشته را نمی‌پذیرد
        const users = await getSubUsers(env);
        users[0].expiresAt = NOW - DAY;
        await (env as any).kv.put('subUsers', JSON.stringify(users));

        expect(await resolveSubUser(env, user!.id, NOW)).toBeNull();
    });

    it('resolveSubUser still returns future-expiry users', async () => {
        const { kv } = createKvMock();
        const env = { kv } as Env;
        const user = await createSubUser(env, 'Ali');
        await updateSubUser(env, user!.id, { expiresAt: NOW + 3 * DAY });

        const resolved = await resolveSubUser(env, user!.id, NOW);
        expect(resolved).not.toBeNull();
        expect(resolved!.expiresAt).toBe(NOW + 3 * DAY);
    });

    it('resolveAndRecordSubUser stops counting fetches once expired', async () => {
        const { kv } = createKvMock();
        const env = { kv } as Env;
        const user = await createSubUser(env, 'Ali');

        // قبل از انقضا — ثبت می‌شود
        expect(await resolveAndRecordSubUser(env, user!.id, NOW)).not.toBeNull();

        // بعد از انقضا — null و بدون write جدید
        const users = await getSubUsers(env);
        users[0].expiresAt = NOW - DAY;
        await (env as any).kv.put('subUsers', JSON.stringify(users));

        const countBefore = (await getSubUsers(env))[0].fetchCount;
        expect(await resolveAndRecordSubUser(env, user!.id, NOW)).toBeNull();

        const after = (await getSubUsers(env))[0];
        expect(after.fetchCount).toBe(countBefore);
    });
});

// ---------- updateSubUser با expiresAt ----------

describe('updateSubUser expiry patch', () => {
    it('sets a future epoch and persists it', async () => {
        const { kv } = createKvMock();
        const env = { kv } as Env;
        const user = await createSubUser(env, 'Ali');

        const updated = await updateSubUser(env, user!.id, { expiresAt: NOW + DAY });
        expect(updated!.expiresAt).toBe(NOW + DAY);
        expect((await getSubUsers(env))[0].expiresAt).toBe(NOW + DAY);
    });

    it("clears expiry with '' and null", async () => {
        const { kv } = createKvMock();
        const env = { kv } as Env;
        const user = await createSubUser(env, 'Ali');
        await updateSubUser(env, user!.id, { expiresAt: NOW + DAY });

        const cleared = await updateSubUser(env, user!.id, { expiresAt: '' });
        expect(cleared!.expiresAt).toBeUndefined();

        await updateSubUser(env, user!.id, { expiresAt: NOW + DAY });
        const cleared2 = await updateSubUser(env, user!.id, { expiresAt: null });
        expect(cleared2!.expiresAt).toBeUndefined();
    });

    it('rejects past timestamps and non-numeric garbage', async () => {
        const { kv } = createKvMock();
        const env = { kv } as Env;
        const user = await createSubUser(env, 'Ali');

        // دقت: updateSubUser با ساعت واقعی مقایسه می‌کند (نه NOW آزمون که آینده است)
        expect(await updateSubUser(env, user!.id, { expiresAt: Date.now() - 1 })).toBeNull();
        expect(await updateSubUser(env, user!.id, { expiresAt: 'soon' })).toBeNull();
        // کاربر دست‌نخورده مانده
        expect((await getSubUsers(env))[0].expiresAt).toBeUndefined();
    });
});

// ---------- sweepExpiredSubUsers ----------

describe('sweepExpiredSubUsers', () => {
    function makeEnv() {
        const { kv, store } = createKvMock();
        return { env: { kv } as Env, store };
    }

    it('deactivates only active+expired users and reports expiring soon', async () => {
        const { env, store } = makeEnv();

        const expired = await createSubUser(env, 'expired');
        const soon = await createSubUser(env, 'soon');
        const future = await createSubUser(env, 'future');
        const revoked = await createSubUser(env, 'revoked');
        await createSubUser(env, 'no-expiry');

        const users = await getSubUsers(env);
        const byName = (n: string) => users.find(u => u.name === n)!;
        byName('expired').expiresAt = NOW - 1000;             // منقضی
        byName('soon').expiresAt = NOW + 24 * 3600_000;       // تا ۷۲ ساعت
        byName('future').expiresAt = NOW + 10 * DAY;          // دور
        byName('revoked').expiresAt = NOW - 1000;
        byName('revoked').active = false;
        await (env as any).kv.put('subUsers', JSON.stringify(users));
        void store;

        const result = await sweepExpiredSubUsers(env, NOW);

        expect(result.swept.map(u => u.name).sort()).toEqual(['expired']);
        expect(result.expiringSoon.map(u => u.name)).toEqual(['soon']);

        const after = await getSubUsers(env);
        expect(byName2(after, 'expired').active).toBe(false);
        expect(byName2(after, 'soon').active).toBe(true);
        expect(byName2(after, 'future').active).toBe(true);
        expect(byName2(after, 'no-expiry').active).toBe(true);
        void revoked;
    });

    it('is idempotent — second sweep finds nothing new and writes nothing', async () => {
        const { env } = makeEnv();
        const u = await createSubUser(env, 'expired');
        const users = await getSubUsers(env);
        users[0].expiresAt = NOW - 1000;
        await (env as any).kv.put('subUsers', JSON.stringify(users));

        const first = await sweepExpiredSubUsers(env, NOW);
        expect(first.swept).toHaveLength(1);

        const rawBefore = JSON.stringify(await getSubUsers(env));
        const second = await sweepExpiredSubUsers(env, NOW);
        expect(second.swept).toHaveLength(0);
        expect(second.expiringSoon).toHaveLength(0);
        expect(JSON.stringify(await getSubUsers(env))).toBe(rawBefore);
        void u;
    });

    it('survives a broken KV without throwing', async () => {
        const badEnv = {
            kv: {
                get: async () => { throw new Error('kv down'); },
                put: async () => { throw new Error('kv down'); },
                delete: async () => { throw new Error('kv down'); }
            }
        } as unknown as Env;

        const result = await sweepExpiredSubUsers(badEnv, NOW);
        expect(result.swept).toHaveLength(0);
    });
});

function byName2(users: SubUser[], name: string): SubUser {
    return users.find(u => u.name === name)!;
}

// ---------- expiryBadge (ربات) ----------

describe('expiryBadge', () => {
    it('empty for no expiry or garbage', () => {
        expect(expiryBadge(undefined, NOW)).toBe('');
        expect(expiryBadge(0, NOW)).toBe('');
        expect(expiryBadge(NaN, NOW)).toBe('');
    });

    it('expired / hours / days formats', () => {
        expect(expiryBadge(NOW - 1, NOW)).toBe('❌ expired');
        expect(expiryBadge(NOW + 3600_000, NOW)).toBe('⏳ 1h left');
        expect(expiryBadge(NOW + 71 * 3600_000, NOW)).toBe('⏳ 71h left');
        expect(expiryBadge(NOW + 73 * 3600_000, NOW)).toBe('⏳ 4d left'); // سقف ۷۲ → روز
        expect(expiryBadge(NOW + 5 * DAY, NOW)).toBe('⏳ 5d left');
    });
});

// ---------- buildDigestText / buildSweepText ----------

describe('buildDigestText', () => {
    const users: SubUser[] = [
        { id: '1', name: 'active', createdAt: 1, active: true, fetchCount: 12 },
        { id: '2', name: 'expiring', createdAt: 2, active: true, expiresAt: NOW + 2 * 3600_000 },
        { id: '3', name: 'expired', createdAt: 3, active: true, expiresAt: NOW - DAY },
        { id: '4', name: 'revoked', createdAt: 4, active: false, fetchCount: 30 },
        { id: '5', name: 'quiet', createdAt: 5, active: true }
    ];

    it('contains usage bar, user counts, expiry sections and top users', async () => {
        const { buildDigestText } = await import('../src/api/automation');
        const text = buildDigestText({
            usage: { success: true, total: 95_000, worker: 40_000 },
            users,
            date: '2027-01-15',
            now: NOW
        });

        expect(text).toContain('Daily Digest');
        expect(text).toContain('95,000 / 100,000 (95%)');
        expect(text).toContain('<b>3</b> active / 5 total'); // active + expiring + quiet
        expect(text).toContain('Next expirations:');
        expect(text).toContain('expiring — 2027-01-15 10'); // NOW=08:00Z + 2h
        expect(text).toContain('revoked — 30 fetches');
        expect(text).not.toContain('quiet —'); // صفر واکشی در top نیست
    });

    it('degrades gracefully when usage fetch failed', async () => {
        const { buildDigestText } = await import('../src/api/automation');
        const text = buildDigestText({ usage: { success: false }, users: [] });
        expect(text).toContain('Usage: unavailable');
        expect(text).toContain('<b>0</b> active / 0 total');
    });
});

describe('buildSweepText', () => {
    it('lists swept and expiring-soon users', async () => {
        const { buildSweepText } = await import('../src/api/automation');

        const swept: SubUser[] = [
            { id: '1', name: '<b>evil</b>', createdAt: 1, active: false, expiresAt: NOW - DAY }
        ];
        const soon: SubUser[] = [
            { id: '2', name: 'soon', createdAt: 2, active: true, expiresAt: NOW + 5 * 3600_000 }
        ];

        const text = buildSweepText(swept, soon, NOW);
        expect(text).toContain('1 user(s) expired');
        expect(text).toContain('&lt;b&gt;evil&lt;/b&gt;'); // escape شده
        expect(text).toContain('5h left');
    });

    it('reports a clean state when nothing expired', async () => {
        const { buildSweepText } = await import('../src/api/automation');
        const text = buildSweepText([], []);
        expect(text).toContain('Nothing expired');
    });
});

// ---------- runScheduledAutomation — کل موتور با fetch شبیه‌سازی‌شده ----------

describe('runScheduledAutomation', () => {
    let kvStore: Map<string, string>;
    let sentMessages: any[];

    beforeEach(() => {
        kvStore = new Map();
        sentMessages = [];

        (globalThis as any).EMBEDED_SETTINGS = {
            accID: 'test-account',
            accEmail: 'test@example.com',
            apiToken: 'test-token',
            vlUUID: 'b831381d-6324-4d53-ad4f-8cda48b30811',
            trPass: 'test-pass',
            securePath: 'fp',
            proxyIpMode: '',
            proxyIPs: [],
            prefixes: [],
            mainDomain: 'flash-panel.test',
            fallback: '',
            dohUrl: ''
        };

        // fetch شبیه‌سازی‌شده: GraphQL کلادفلر ۹۵٪ مصرف + تلگرام ضبط می‌شود
        vi.stubGlobal('fetch', (async (input: any) => {
            const url = String(input instanceof URL ? input.href : input);

            if (url.includes('api.cloudflare.com')) {
                return new Response(JSON.stringify({
                    data: {
                        viewer: {
                            accounts: [{
                                total: [{ sum: { requests: 95_000 } }],
                                worker: [{ sum: { requests: 40_000 } }]
                            }]
                        }
                    }
                }), { status: 200 });
            }

            if (url.includes('api.telegram.org')) {
                sentMessages.push(url);
                return new Response(JSON.stringify({ ok: true }), { status: 200 });
            }

            return new Response('{}', { status: 404 });
        }) as typeof fetch);
    });

    afterEach(() => {
        delete (globalThis as any).EMBEDED_SETTINGS;
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        _resetSubUserFetchState();
    });

    function makeEnv() {
        // از kvStore بیرونی استفاده کن — نه store جدید (تست‌ها وضعیتش را چک می‌کنند)
        const kv = {
            async get(key: string, opts?: { type?: string }) {
                const raw = kvStore.get(key);
                if (raw === undefined) return null;
                return opts?.type === 'json' ? JSON.parse(raw) : raw;
            },
            async put(key: string, value: string) {
                kvStore.set(key, value);
            },
            async delete(key: string) {
                kvStore.delete(key);
            }
        } as unknown as KVNamespace;

        return { kv } as unknown as Env;
    }

    async function seedBot(env: Env) {
        await (env as any).kv.put('telegramBot', JSON.stringify({
            telegramBotToken: '123:ABC',
            telegramUserId: '42'
        }));
    }

    it('sweeps expired users, warns usage and sends digest once per day', async () => {
        const { runScheduledAutomation } = await import('../src/api/automation');
        const env = makeEnv();
        await seedBot(env);

        const user = await createSubUser(env, 'gone');
        const users = await getSubUsers(env);
        users[0].expiresAt = NOW - DAY;
        await (env as any).kv.put('subUsers', JSON.stringify(users));
        void user;

        const result = await runScheduledAutomation(env, NOW);

        expect(result.swept).toBe(1);
        expect(result.usageWarned).toBe(true);   // ۹۵٪ ≥ ۸۰٪
        expect(result.digestSent).toBe(true);

        // سه پیام: sweep + warn + digest
        expect(sentMessages).toHaveLength(3);
        expect(sentMessages[0]).toContain('bot123:ABC/sendMessage');

        // کاربر در KV غیرفعال شده
        expect((await getSubUsers(env))[0].active).toBe(false);

        // نمونه مصرف ثبت شده
        expect(kvStore.has('usageHistory')).toBe(true);

        // ---------- اجرای دوم در همان روز — هیچ پیام تکراری ----------
        const second = await runScheduledAutomation(env, NOW + 3600_000);
        expect(second.swept).toBe(0);
        expect(second.usageWarned).toBe(false);
        expect(second.digestSent).toBe(false);
        expect(sentMessages).toHaveLength(3);
    });

    it('skips notifications without a bot but still sweeps and samples', async () => {
        const { runScheduledAutomation } = await import('../src/api/automation');
        const env = makeEnv();

        const users = await getSubUsers(env);
        void users;

        const result = await runScheduledAutomation(env, NOW);
        expect(result.digestSent).toBe(false);
        expect(result.notified).toBe(false);
        expect(sentMessages).toHaveLength(0);
        expect(kvStore.has('usageHistory')).toBe(true);
    });

    it('resets daily guards on a new UTC day', async () => {
        const { runScheduledAutomation } = await import('../src/api/automation');
        const env = makeEnv();
        await seedBot(env);

        await runScheduledAutomation(env, NOW);

        // روز بعد — digest دوباره می‌رود (دو بار پیام: warn? نه — گارد روزانه ریست شده ولی warn هم شرطش مصرف بالاست)
        await runScheduledAutomation(env, NOW + DAY);
        // run1: sweep(0)→بدون پیام + warn + digest = 2 پیام؛ run2: warn + digest = 2 پیام
        expect(sentMessages.length).toBeGreaterThanOrEqual(3);
    });

    it('does not warn when usage is below 80%', async () => {
        vi.stubGlobal('fetch', (async (input: any) => {
            const url = String(input instanceof URL ? input.href : input);
            if (url.includes('api.cloudflare.com')) {
                return new Response(JSON.stringify({
                    data: { viewer: { accounts: [{ total: [{ sum: { requests: 40_000 } }], worker: [{ sum: { requests: 10_000 } }] }] } }
                }), { status: 200 });
            }
            if (url.includes('api.telegram.org')) {
                sentMessages.push(url);
                return new Response(JSON.stringify({ ok: true }), { status: 200 });
            }
            return new Response('{}', { status: 404 });
        }) as typeof fetch);

        const { runScheduledAutomation } = await import('../src/api/automation');
        const env = makeEnv();
        await seedBot(env);

        const result = await runScheduledAutomation(env, NOW);
        expect(result.usageWarned).toBe(false);
        // فقط digest
        expect(sentMessages).toHaveLength(1);
    });

    it('buildDigestForCommand returns digest without touching daily guard', async () => {
        const { buildDigestForCommand } = await import('../src/api/automation');
        const { initForScheduled } = await import('@settings');

        const env = makeEnv();
        await seedBot(env);
        await createSubUser(env, 'cmd-user');
        initForScheduled(env);

        const text = await buildDigestForCommand(env);
        expect(text).toContain('Daily Digest');
        expect(text).toContain('<b>1</b> active / 1 total');
        // هیچ پیامی به تلگرام نرفته
        expect(sentMessages).toHaveLength(0);
    });
});
