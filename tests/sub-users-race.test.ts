import { describe, it, expect, beforeEach } from 'vitest';
import {
    createSubUser,
    resolveAndRecordSubUser,
    updateSubUser,
    SubUser,
    _resetSubUserFetchState,
    _resetSubUsersWriteQueueForTest
} from '../src/settings/sub-users';

/**
 * v0.8.35 — صف نوشتن subUsers (الگوی store.ts)
 *
 * کلاس باگ: هر ۵ نویسنده‌ی کلید subUsers قبلاً read-modify-write بی‌صف بودند —
 * همان lost-update که موتور store (v0.8.11/v0.8.25) برای proxySettings نابود کرد.
 * دو جهت ملموس:
 *   ۱) write آمار واکشی (resolveAndRecordSubUser — سقف ۴۸ put/روز/کاربر) که از روی
 *      نسخه‌ی کهنه «کل blob» را بازنویسی می‌کند → revoke ادمین (active=false)
 *      بی‌صدا پاک می‌شود و دسترسی کاربر برمی‌گردد؛
 *   ۲) برعکس: revoke/write ادمین که آمارِ هم‌زمان را گم می‌کند؛ و دو create
 *      هم‌زمان (دابل‌کلیک) که یک کاربر را کامل از دست می‌دهد.
 *
 * صحنه‌آرایی قطعی بدون گیت — به ترتیب ثبت میکروتک‌ها تکیه دارد:
 * resolveAndRecordSubUser اول صدا زده می‌شود (خواندنِ اعتبارسنجی‌اش sync صادر
 * می‌شود و داده‌ی پیش از revoke را می‌بیند)، بعد نویسنده‌ی دوم وارد صف می‌شود.
 * کد قدیمی: پایه‌ی write هرکدام نسخه‌ی کهنه‌ی خودش است → یکی از دو تغییر گم
 * می‌شود. کد جدید: هر دو از صف می‌گذرند و write آمار داخل صف از «رکورد تازه»
 * فقط فیلدهای آمار را اعمال می‌کند → هر دو تغییر در blob نهایی می‌ماند.
 */

const ID = 'b831381d-6324-4d53-ad4f-8cda48b30811';

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

function seedUser(): SubUser {
    return { id: ID, name: 'u1', createdAt: 1, active: true };
}

beforeEach(() => {
    _resetSubUserFetchState();
    _resetSubUsersWriteQueueForTest();
});

describe('subUsers write queue (v0.8.35) — نابودی lost-update بین نویسنده‌ها', () => {

    it('🔴 write آمار هم‌زمان با revoke ادمین → هر دو تغییر باید در blob نهایی بمانند', async () => {
        const m = createKvMock();
        m.store.set('subUsers', JSON.stringify([seedUser()]));

        // اول resolve (خواندنش داده‌ی پیش از revoke را می‌بیند) بعد revoke
        const pStats = resolveAndRecordSubUser(m as unknown as Env, ID, 1_000_000);
        const pRevoke = updateSubUser(m as unknown as Env, ID, { active: false });

        const user = await pStats;
        await pRevoke;

        // resolve از خواندن خودش (قبل از revoke) کاربر فعال را دیده — پاس مثل قبل
        expect(user).not.toBeNull();

        const final = JSON.parse(m.store.get('subUsers')!);
        // 🔴 کد قدیمی: هر write از روی نسخه‌ی کهنه‌ی خودش کل blob را می‌نویسد —
        // اینجا پایه‌ی write آمار قبل از revoke است → revoke ادمین بی‌صدا پاک می‌شود
        // (یا در ترتیب برعکس، آمار گم می‌شود) — در هر دو جهت یکی از دو گارد زیر قرمز است
        expect(final[0].active).toBe(false);
        expect(final[0].fetchCount).toBe(1);
        expect(final[0].lastFetchedAt).toBe(1_000_000);
    });

    it('🔴 دو createSubUser هم‌زمان (دابل‌کلیک) → هر دو کاربر باید بمانند', async () => {
        const m = createKvMock();
        m.store.set('subUsers', JSON.stringify([]));

        const p1 = createSubUser(m as unknown as Env, 'alice');
        const p2 = createSubUser(m as unknown as Env, 'bob');

        const u1 = await p1;
        const u2 = await p2;

        expect(u1).not.toBeNull();
        expect(u2).not.toBeNull();

        const final = JSON.parse(m.store.get('subUsers')!);
        // 🔴 کد قدیمی: create دوم از روی فهرست خالیِ خوانده‌شده‌ی قبل از put اولی می‌نویسد → alice گم می‌شود
        expect(final.map((u: SubUser) => u.name).sort()).toEqual(['alice', 'bob']);
    });

    it('🟢 کاربر revoke شده → هیچ write آماری نمی‌زند (blob دست‌نخورده)', async () => {
        const m = createKvMock();
        const blob = JSON.stringify([{ ...seedUser(), active: false }]);
        m.store.set('subUsers', blob);

        const result = await resolveAndRecordSubUser(m as unknown as Env, ID, 1_000_000);

        expect(result).toBeNull();
        expect(m.store.get('subUsers')).toBe(blob); // بدون put — قرارداد قبلی حفظ شده
    });

    it('🟢 ترتیبی طبیعی: update سپس آمار → هر دو تغییر در blob نهایی', async () => {
        const m = createKvMock();
        m.store.set('subUsers', JSON.stringify([seedUser()]));

        const renamed = await updateSubUser(m as unknown as Env, ID, { name: 'renamed' });
        expect(renamed?.name).toBe('renamed');

        const user = await resolveAndRecordSubUser(m as unknown as Env, ID, 1_000_000);
        expect(user).not.toBeNull();

        const final = JSON.parse(m.store.get('subUsers')!);
        expect(final[0].name).toBe('renamed');
        expect(final[0].fetchCount).toBe(1);
        expect(final[0].active).toBe(true);
    });
});
