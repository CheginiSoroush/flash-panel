import { describe, it, expect, beforeEach } from 'vitest';
import {
    createSubUser,
    deleteSubUser,
    getSubUsers,
    isValidSubUserId,
    normalizeSubUserChatId,
    parseSubUsers,
    resolveSubUser,
    resolveAndRecordSubUser,
    sanitizeSubUserName,
    SUB_USERS_LIMIT,
    SUB_USER_NAME_MAX,
    SUB_USER_FETCH_THROTTLE_MS,
    updateSubUser,
    SubUser,
    _resetSubUserFetchState
} from '../src/settings/sub-users';

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

// ---------- isValidSubUserId ----------

describe('isValidSubUserId', () => {
    it('accepts real UUID v4 values', () => {
        for (let i = 0; i < 20; i++) {
            expect(isValidSubUserId(crypto.randomUUID())).toBe(true);
        }
    });

    it('accepts a hand-crafted v4 shape case-insensitively', () => {
        expect(isValidSubUserId('B831381D-6324-4D53-AD4F-8CDA48B30811')).toBe(true);
    });

    it('rejects v1-style, malformed and random segments', () => {
        // نسخه ۱ — nibble نسخه باید 4 باشه
        expect(isValidSubUserId('c9bf9e57-1685-4c89-bafb-ff5af830be8a'.replace('4c89', '1c89'))).toBe(false);
        expect(isValidSubUserId('not-a-uuid')).toBe(false);
        expect(isValidSubUserId('')).toBe(false);
        expect(isValidSubUserId('normal')).toBe(false);
        expect(isValidSubUserId('warp')).toBe(false);
        expect(isValidSubUserId('b831381d63244d53ad4f8cda48b30811')).toBe(false); // بدون خط تیره
        expect(isValidSubUserId('b831381d-6324-4d53-cd4f-8cda48b30811')).toBe(false); // variant نامعتبر
    });
});

// ---------- sanitizeSubUserName ----------

describe('sanitizeSubUserName', () => {
    it('trims and collapses inner whitespace', () => {
        expect(sanitizeSubUserName('  John   phone ')).toBe('John phone');
    });

    it('accepts unicode names (Persian/Arabic)', () => {
        expect(sanitizeSubUserName('  علی — موبایل ')).toBe('علی — موبایل');
    });

    it('rejects empty, oversized and non-string inputs', () => {
        expect(sanitizeSubUserName('')).toBeNull();
        expect(sanitizeSubUserName('   ')).toBeNull();
        expect(sanitizeSubUserName('x'.repeat(SUB_USER_NAME_MAX + 1))).toBeNull();
        expect(sanitizeSubUserName(123)).toBeNull();
        expect(sanitizeSubUserName(null)).toBeNull();
        expect(sanitizeSubUserName(undefined)).toBeNull();
        expect(sanitizeSubUserName({ name: 'John' })).toBeNull();
    });

    it('accepts exactly max-length names', () => {
        expect(sanitizeSubUserName('x'.repeat(SUB_USER_NAME_MAX))).toBe('x'.repeat(SUB_USER_NAME_MAX));
    });
});

// ---------- parseSubUsers ----------

describe('parseSubUsers', () => {
    it('keeps only well-formed entries', () => {
        const good: SubUser = {
            id: crypto.randomUUID(),
            name: 'John',
            createdAt: 1,
            active: true
        };

        const raw = [
            good,
            null,
            { id: 'garbage', name: 'x' },
            { id: good.id, name: 42 },
            'string'
        ];

        expect(parseSubUsers(raw)).toEqual([good]);
    });

    it('returns empty array for non-array input', () => {
        expect(parseSubUsers(null)).toEqual([]);
        expect(parseSubUsers({})).toEqual([]);
        expect(parseSubUsers('nope')).toEqual([]);
    });
});

// ---------- عملیات KV ----------

describe('sub-users KV operations', () => {
    it('creates a user with v4 UUID, sanitized name and active state', async () => {
        const { kv } = createKvMock();
        const env = { kv } as Env;

        const user = await createSubUser(env, '  Ali   mobile ');
        expect(user).not.toBeNull();
        expect(user!.name).toBe('Ali mobile');
        expect(user!.active).toBe(true);
        expect(isValidSubUserId(user!.id)).toBe(true);
        expect(typeof user!.createdAt).toBe('number');

        const all = await getSubUsers(env);
        expect(all).toHaveLength(1);
        expect(all[0].id).toBe(user!.id);
    });

    it('rejects invalid names without touching KV', async () => {
        const { kv } = createKvMock();
        const env = { kv } as Env;

        expect(await createSubUser(env, '')).toBeNull();
        expect(await createSubUser(env, 'a'.repeat(100))).toBeNull();
        expect(await getSubUsers(env)).toHaveLength(0);
    });

    it('updates name and active flag; unknown id returns null', async () => {
        const { kv } = createKvMock();
        const env = { kv } as Env;

        const user = (await createSubUser(env, 'John'))!;
        const renamed = await updateSubUser(env, user.id, { name: 'John 2', active: false });
        expect(renamed!.name).toBe('John 2');
        expect(renamed!.active).toBe(false);

        // وضعیت در KV هم عوض شده
        const all = await getSubUsers(env);
        expect(all[0].active).toBe(false);

        expect(await updateSubUser(env, crypto.randomUUID(), { active: true })).toBeNull();
        // نام نامعتبر → آپدیت رد می‌شه
        expect(await updateSubUser(env, user.id, { name: '' })).toBeNull();
    });

    it('deletes a user; unknown id returns false', async () => {
        const { kv } = createKvMock();
        const env = { kv } as Env;

        const a = (await createSubUser(env, 'A'))!;
        const b = (await createSubUser(env, 'B'))!;

        expect(await deleteSubUser(env, a.id)).toBe(true);
        const all = await getSubUsers(env);
        expect(all).toHaveLength(1);
        expect(all[0].id).toBe(b.id);

        expect(await deleteSubUser(env, a.id)).toBe(false);
        expect(await deleteSubUser(env, 'garbage')).toBe(false);
    });

    it('enforces the user limit', async () => {
        const { kv } = createKvMock();
        const env = { kv } as Env;

        for (let i = 0; i < SUB_USERS_LIMIT; i++) {
            const created = await createSubUser(env, `user-${i}`);
            expect(created).not.toBeNull();
        }

        // نفر ۱۰۱ رد می‌شه
        expect(await createSubUser(env, 'overflow')).toBeNull();
    });
});

// ---------- resolveSubUser ----------

describe('resolveSubUser', () => {
    it('returns undefined for non-UUID segments (legacy admin path)', async () => {
        const { kv } = createKvMock();
        const env = { kv } as Env;

        expect(await resolveSubUser(env, 'normal')).toBeUndefined();
        expect(await resolveSubUser(env, 'warp-pro')).toBeUndefined();
        expect(await resolveSubUser(env, '')).toBeUndefined();
    });

    it('returns null for unknown UUIDs', async () => {
        const { kv } = createKvMock();
        const env = { kv } as Env;

        expect(await resolveSubUser(env, crypto.randomUUID())).toBeNull();
    });

    it('returns the user only when active', async () => {
        const { kv } = createKvMock();
        const env = { kv } as Env;

        const user = (await createSubUser(env, 'John'))!;
        expect(await resolveSubUser(env, user.id)).toEqual(user);

        await updateSubUser(env, user.id, { active: false });
        expect(await resolveSubUser(env, user.id)).toBeNull();

        await updateSubUser(env, user.id, { active: true });
        const resolved = await resolveSubUser(env, user.id);
        expect(resolved).not.toBeNull();
        expect(resolved!.id).toBe(user.id);
    });

    it('resolves correctly with multiple users (revocation is per-user)', async () => {
        const { kv } = createKvMock();
        const env = { kv } as Env;

        const a = (await createSubUser(env, 'A'))!;
        const b = (await createSubUser(env, 'B'))!;

        await updateSubUser(env, a.id, { active: false });

        expect(await resolveSubUser(env, a.id)).toBeNull();   // A لغو شد
        expect((await resolveSubUser(env, b.id))!.id).toBe(b.id); // B مستقل کار می‌کنه
    });
});

// ---------- normalizeSubUserChatId (لینک تلگرام برای broadcast) ----------

describe('normalizeSubUserChatId', () => {
    it('accepts plain digit strings of 5-20 chars', () => {
        expect(normalizeSubUserChatId('123456789')).toBe('123456789');
        expect(normalizeSubUserChatId('12345')).toBe('12345');
        expect(normalizeSubUserChatId('12345678901234567890')).toBe('12345678901234567890');
    });

    it('trims surrounding whitespace and accepts numbers', () => {
        expect(normalizeSubUserChatId('  987654321 ')).toBe('987654321');
        expect(normalizeSubUserChatId(987654321)).toBe('987654321');
        expect(normalizeSubUserChatId(987654321.7)).toBe('987654321'); // truncate
    });

    it('returns empty string as the explicit "unlink" signal', () => {
        expect(normalizeSubUserChatId('')).toBe('');
        expect(normalizeSubUserChatId('   ')).toBe('');
        expect(normalizeSubUserChatId(null)).toBe('');
    });

    it('rejects non-numeric, short, long and wrong-typed inputs', () => {
        expect(normalizeSubUserChatId('12a45')).toBeNull();
        expect(normalizeSubUserChatId('-123456')).toBeNull();
        expect(normalizeSubUserChatId('1234')).toBeNull();
        expect(normalizeSubUserChatId('1'.repeat(21))).toBeNull();
        expect(normalizeSubUserChatId(undefined)).toBeNull();
        expect(normalizeSubUserChatId({ id: 1 })).toBeNull();
        expect(normalizeSubUserChatId(true)).toBeNull();
    });
});

// ---------- آمار واکشی + chat id در parse/KV ----------

describe('sub-user stats fields', () => {
    it('drops malformed stats but keeps valid ones when parsing raw KV', () => {
        const id = crypto.randomUUID();
        const [parsed] = parseSubUsers([{
            id,
            name: 'John',
            active: true,
            fetchCount: 'garbage',
            lastFetchedAt: -5,
            telegramChatId: 'not-digits!'
        }]);

        expect(parsed.fetchCount).toBeUndefined();
        expect(parsed.lastFetchedAt).toBeUndefined();
        expect(parsed.telegramChatId).toBeUndefined();

        const good = crypto.randomUUID();
        const [ok] = parseSubUsers([{
            id: good,
            name: 'Ali',
            active: true,
            fetchCount: 7,
            lastFetchedAt: 1700000000000,
            telegramChatId: '999888777'
        }]);

        expect(ok.fetchCount).toBe(7);
        expect(ok.lastFetchedAt).toBe(1700000000000);
        expect(ok.telegramChatId).toBe('999888777');
    });

    it('updates telegramChatId — set, clear with empty string, reject invalid', async () => {
        const { kv } = createKvMock();
        const env = { kv } as Env;

        const user = (await createSubUser(env, 'John'))!;

        const linked = await updateSubUser(env, user.id, { telegramChatId: '  111222333 ' });
        expect(linked!.telegramChatId).toBe('111222333');

        // عدد هم قابل قبول است
        const numeric = await updateSubUser(env, user.id, { telegramChatId: 444555666 });
        expect(numeric!.telegramChatId).toBe('444555666');

        // '' = حذف لینک
        const cleared = await updateSubUser(env, user.id, { telegramChatId: '' });
        expect(cleared!.telegramChatId).toBeUndefined();

        // نامعتبر → کل آپدیت رد می‌شه (null) و KV دست‌نخورده می‌مونه
        expect(await updateSubUser(env, user.id, { telegramChatId: 'abc' })).toBeNull();
        expect((await getSubUsers(env))[0].telegramChatId).toBeUndefined();
    });

    it('keeps other fields intact when only chat id changes', async () => {
        const { kv } = createKvMock();
        const env = { kv } as Env;

        const user = (await createSubUser(env, 'John'))!;
        await updateSubUser(env, user.id, { telegramChatId: '111222333' });

        const all = await getSubUsers(env);
        expect(all[0].name).toBe('John');
        expect(all[0].active).toBe(true);
        expect(all[0].id).toBe(user.id);
    });
});

// ---------- resolveAndRecordSubUser (آمار واکشی با آستانه) ----------

describe('resolveAndRecordSubUser', () => {
    beforeEach(() => {
        _resetSubUserFetchState();
    });

    it('keeps the resolve semantics: undefined for legacy, null for revoked/unknown', async () => {
        const { kv } = createKvMock();
        const env = { kv } as Env;

        expect(await resolveAndRecordSubUser(env, 'normal')).toBeUndefined();
        expect(await resolveAndRecordSubUser(env, crypto.randomUUID())).toBeNull();

        const user = (await createSubUser(env, 'John'))!;
        await updateSubUser(env, user.id, { active: false });
        expect(await resolveAndRecordSubUser(env, user.id)).toBeNull();
    });

    it('counts the first fetch and stores lastFetchedAt', async () => {
        const { kv } = createKvMock();
        const env = { kv } as Env;
        const user = (await createSubUser(env, 'John'))!;

        const now = Date.now();
        const resolved = await resolveAndRecordSubUser(env, user.id, now);

        expect(resolved).not.toBeNull();
        expect(resolved!.fetchCount).toBe(1);
        expect(resolved!.lastFetchedAt).toBe(now);

        const all = await getSubUsers(env);
        expect(all[0].fetchCount).toBe(1);
        expect(all[0].lastFetchedAt).toBe(now);
    });

    it('same-isolate bursts within the window do not increment and skip the write', async () => {
        const { kv } = createKvMock();
        let puts = 0;
        const countingKv = {
            get: kv.get.bind(kv),
            put: async (key: string, value: string) => { puts++; await kv.put(key, value); },
            delete: kv.delete.bind(kv)
        } as unknown as KVNamespace;
        const env = { kv: countingKv } as Env;

        const user = (await createSubUser(env, 'John'))!; // ۱ put برای ساخت
        puts = 0;

        const t0 = Date.now();
        await resolveAndRecordSubUser(env, user.id, t0);                          // ثبت — ۱ write
        await resolveAndRecordSubUser(env, user.id, t0 + 30_000);                 // کش isolate — بدون write
        await resolveAndRecordSubUser(env, user.id, t0 + SUB_USER_FETCH_THROTTLE_MS - 1_000);

        expect(puts).toBe(1);
        const all = await getSubUsers(env);
        expect(all[0].fetchCount).toBe(1);
        expect(all[0].lastFetchedAt).toBe(t0);
    });

    it('increments again after the throttle window passes', async () => {
        const { kv } = createKvMock();
        const env = { kv } as Env;
        const user = (await createSubUser(env, 'John'))!;

        const t0 = Date.now();
        await resolveAndRecordSubUser(env, user.id, t0);
        await resolveAndRecordSubUser(env, user.id, t0 + SUB_USER_FETCH_THROTTLE_MS + 60_000);
        await resolveAndRecordSubUser(env, user.id, t0 + 2 * (SUB_USER_FETCH_THROTTLE_MS + 60_000));

        const all = await getSubUsers(env);
        expect(all[0].fetchCount).toBe(3);
    });

    it('revoked users get no fetch recording', async () => {
        const { kv } = createKvMock();
        const env = { kv } as Env;
        const user = (await createSubUser(env, 'John'))!;
        await updateSubUser(env, user.id, { active: false });

        await resolveAndRecordSubUser(env, user.id, Date.now());

        const all = await getSubUsers(env);
        expect(all[0].fetchCount).toBeUndefined();
    });

    it('v0.8.7 write-diet: a cold isolate inside the fresh window writes nothing', async () => {
        // ریشه‌ی سوختن سهمیه‌ی KV: قبلاً isolate سرد حتی داخل پنجره‌ی تازه هم
        // فقط برای lastFetchedAt کل blob را می‌نوشت. حالا صفر write.
        const { kv } = createKvMock();
        let puts = 0;
        const countingKv = {
            get: kv.get.bind(kv),
            put: async (key: string, value: string) => { puts++; await kv.put(key, value); },
            delete: kv.delete.bind(kv)
        } as unknown as KVNamespace;
        const env = { kv: countingKv } as Env;

        const user = (await createSubUser(env, 'John'))!;
        const t0 = Date.now();
        await resolveAndRecordSubUser(env, user.id, t0);   // ثبت اول — ۱ write
        puts = 0;
        _resetSubUserFetchState();                          // شبیه‌سازی isolate سرد

        const resolved = await resolveAndRecordSubUser(env, user.id, t0 + SUB_USER_FETCH_THROTTLE_MS - 1_000);
        expect(resolved).not.toBeNull();                    // کاربر سالم resolve شد
        expect(puts).toBe(0);                               // ولی هیچ put ای نزد

        const all = await getSubUsers(env);
        expect(all[0].fetchCount).toBe(1);                  // شمارش دست‌نخورده
        expect(all[0].lastFetchedAt).toBe(t0);
    });

    it('still resolves the user when the stats write fails (best-effort)', async () => {
        const { kv, store } = createKvMock();
        const env = { kv } as Env;
        const user = (await createSubUser(env, 'John'))!;
        _resetSubUserFetchState();

        // put برای آمار شکست می‌خورد — ولی resolve باید سالم برگردد
        const failingKv = {
            get: kv.get.bind(kv),
            put: async () => { throw new Error('KV write quota exceeded'); },
            delete: kv.delete.bind(kv)
        } as unknown as KVNamespace;

        const resolved = await resolveAndRecordSubUser({ kv: failingKv } as Env, user.id, Date.now());
        expect(resolved).not.toBeNull();
        expect(resolved!.id).toBe(user.id);
        // store دست‌نخورده — آمار نوشته نشده
        expect(JSON.parse(store.get('subUsers')!)[0].fetchCount).toBeUndefined();
    });

    it('uses the isolate cache: consecutive calls within throttle still resolve correctly', async () => {
        const { kv } = createKvMock();
        const env = { kv } as Env;
        const user = (await createSubUser(env, 'John'))!;

        const t0 = Date.now();
        const first = await resolveAndRecordSubUser(env, user.id, t0);
        const second = await resolveAndRecordSubUser(env, user.id, t0 + 60_000);

        expect(first!.fetchCount).toBe(1);
        expect(second!.fetchCount).toBe(1); // داخل آستانه — بدون افزایش
        expect(second!.lastFetchedAt).toBe(t0); // رکورد KV همان t0 است (write جدیدی نشده)
    });
});
