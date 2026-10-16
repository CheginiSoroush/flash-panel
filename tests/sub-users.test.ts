import { describe, it, expect } from 'vitest';
import {
    createSubUser,
    deleteSubUser,
    getSubUsers,
    isValidSubUserId,
    parseSubUsers,
    resolveSubUser,
    sanitizeSubUserName,
    SUB_USERS_LIMIT,
    SUB_USER_NAME_MAX,
    updateSubUser,
    SubUser
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
