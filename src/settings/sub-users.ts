/**
 * اشتراک چندکاربره — مدیریت کاربران اشتراک با UUID مستقل
 *
 * هر کاربر یک UUID v4 تصادفی می‌گیره که آدرس اشتراکش می‌شه:
 *   <securePath>/sub/<userId>/<type>?app=<client>
 *
 * مزیت نسبت به لینک اشتراکیِ مبتنی بر securePath:
 *   - UUID هر کاربر قابل لغو مستقله (غیرفعال/حذف) بدون تأثیر بقیه
 *   - افشای لینکِ یک کاربر، بقیه رو در خطر نمی‌ذاره
 *   - securePath هرگز در لینک کاربران به اشتراک گذاشته نمی‌شه؟ — نه، همچنان در URL هست،
 *     اما از دست دادن لینکِ یک کاربر فقط با غیرفعال‌کردن همان کاربر خنثی می‌شه.
 */

export interface SubUser {
    id: string;
    name: string;
    createdAt: number;
    active: boolean;
    /** تعداد واکشی‌های ثبت‌شده‌ی لینک اشتراک (با آستانه‌ی ۵ دقیقه‌ای — ببین recordSubUserFetch) */
    fetchCount?: number;
    /** آخرین واکشی ثبت‌شده — epoch ms */
    lastFetchedAt?: number;
    /**
     * chat_id تلگرام این کاربر (اختیاری) — برای broadcast شخصی‌سازی‌شده از ربات.
     * فقط رقم — chat_id کاربر عادی تلگرام همیشه مثبت است.
     */
    telegramChatId?: string;
    /**
     * انقضای خودکار دسترسی (epoch ms، اختیاری) — بعد از این زمان لینک‌های کاربر
     * خودبه‌خود می‌ایستند (resolve به‌صورت سلف-اجراکننده چک می‌کند) و cron
     * sweep کاربر را غیرفعال علامت می‌زند و به ادمین خبر می‌دهد.
     */
    expiresAt?: number;
}

// حداقل/حداکثر منطقی برای جلوگیری از سوءاستفاده و پر شدن KV
export const SUB_USER_NAME_MIN = 1;
export const SUB_USER_NAME_MAX = 40;
export const SUB_USERS_LIMIT = 100;

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidSubUserId(id: string): boolean {
    return UUID_V4_RE.test(id);
}

export function sanitizeSubUserName(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const name = raw.trim().replace(/\s+/g, ' ');
    if (name.length < SUB_USER_NAME_MIN || name.length > SUB_USER_NAME_MAX) return null;
    return name;
}

/**
 * پاکسازی chat_id تلگرام — فقط رقم (کاربر عادی)، طول ۵..۲۰.
 * null یعنی ورودی نامعتبر؛ رشته‌ی خالی یعنی «حذف لینک».
 */
export function normalizeSubUserChatId(raw: unknown): string | null {
    if (raw === null || raw === '') return '';
    if (typeof raw !== 'string' && typeof raw !== 'number') return null;
    const str = String(typeof raw === 'number' ? Math.trunc(raw) : raw.trim());
    if (str === '') return '';
    if (!/^\d{5,20}$/.test(str)) return null;
    return str;
}

/**
 * آیا دسترسی این کاربر منقضی شده؟ — undefined یعنی اصلاً انقضا ندارد.
 * جدا از active — کاربر منقضی مثل کاربر revoke شده رفتار می‌کند.
 */
export function isSubUserExpired(u: SubUser, now: number = Date.now()): boolean {
    return typeof u.expiresAt === 'number'
        && Number.isFinite(u.expiresAt)
        && u.expiresAt > 0
        && u.expiresAt <= now;
}

/** اعمال فیلدهای آماری/اختیاری بعد از اعتبارسنجی ساختاری — ورودی KV خام ممکنه خراب باشه */
function sanitizeStats(u: SubUser): SubUser {
    const count = Number(u.fetchCount);
    if (Number.isFinite(count) && count > 0) u.fetchCount = Math.floor(count);
    else delete u.fetchCount;

    const at = Number(u.lastFetchedAt);
    if (Number.isFinite(at) && at > 0) u.lastFetchedAt = Math.floor(at);
    else delete u.lastFetchedAt;

    const chat = normalizeSubUserChatId(u.telegramChatId);
    if (chat) u.telegramChatId = chat;
    else delete u.telegramChatId;

    const exp = Number(u.expiresAt);
    if (Number.isFinite(exp) && exp > 0) u.expiresAt = Math.floor(exp);
    else delete u.expiresAt;

    return u;
}

export function parseSubUsers(raw: unknown): SubUser[] {
    if (!Array.isArray(raw)) return [];
    return raw.filter(
        (u): u is SubUser =>
            Boolean(u) &&
            typeof u === 'object' &&
            isValidSubUserId(String((u as SubUser).id)) &&
            typeof (u as SubUser).name === 'string'
    ).map(sanitizeStats);
}

// ---------- عملیات KV ----------

export async function getSubUsers(env: Env): Promise<SubUser[]> {
    const raw = await env.kv.get('subUsers', { type: 'json' });
    return parseSubUsers(raw);
}

export async function saveSubUsers(env: Env, users: SubUser[]): Promise<void> {
    await env.kv.put('subUsers', JSON.stringify(users));
}

export async function createSubUser(env: Env, rawName: unknown): Promise<SubUser | null> {
    const name = sanitizeSubUserName(rawName);
    if (!name) return null;

    const users = await getSubUsers(env);
    if (users.length >= SUB_USERS_LIMIT) return null;

    // نام تکراری ممنوع نیست، ولی UUID همیشه یکتاست
    const user: SubUser = {
        id: crypto.randomUUID(),
        name,
        createdAt: Date.now(),
        active: true
    };

    await saveSubUsers(env, [...users, user]);
    return user;
}

export async function updateSubUser(
    env: Env,
    id: string,
    patch: { name?: unknown; active?: unknown; telegramChatId?: unknown; expiresAt?: unknown }
): Promise<SubUser | null> {
    const users = await getSubUsers(env);
    const user = users.find(u => u.id === id);
    if (!user) return null;

    if (patch.name !== undefined) {
        const name = sanitizeSubUserName(patch.name);
        if (!name) return null;
        user.name = name;
    }

    if (patch.active !== undefined) {
        user.active = Boolean(patch.active);
    }

    if (patch.telegramChatId !== undefined) {
        const chat = normalizeSubUserChatId(patch.telegramChatId);
        // null = نامعتبر؛ '' = حذف لینک
        if (chat === null) return null;
        if (chat === '') delete user.telegramChatId;
        else user.telegramChatId = chat;
    }

    if (patch.expiresAt !== undefined) {
        // '' / null = حذف انقضا (بدون محدودیت زمانی)؛ عدد = epoch ms آینده
        if (patch.expiresAt === '' || patch.expiresAt === null) {
            delete user.expiresAt;
        } else {
            const exp = Number(patch.expiresAt);
            if (!Number.isFinite(exp) || exp <= Date.now()) return null;
            user.expiresAt = Math.floor(exp);
        }
    }

    await saveSubUsers(env, users);
    return user;
}

export async function deleteSubUser(env: Env, id: string): Promise<boolean> {
    const users = await getSubUsers(env);
    const next = users.filter(u => u.id !== id);
    if (next.length === users.length) return false;

    await saveSubUsers(env, next);
    return true;
}

/**
 * پیدا کردن کاربر فعال برای مسیر اشتراک — undefined یعنی مسیر UUID نبوده
 * (لینک قدیمی ادمین)، null یعنی UUID هست ولی نامعتبر/غیرفعال/منقضی.
 * انقضا سلف-اجراکننده است: حتی بدون cron، لینک منقضی همان لحظه می‌ایستد.
 */
export async function resolveSubUser(env: Env, id: string, now: number = Date.now()): Promise<SubUser | null | undefined> {
    if (!isValidSubUserId(id)) return undefined;

    const users = await getSubUsers(env);
    const user = users.find(u => u.id === id);
    return user && user.active && !isSubUserExpired(user, now) ? user : null;
}

// ---------- آمار واکشی هر کاربر ----------

// آستانه‌ی ثبت — هر واکشی با فاصله‌ی کمتر از این از شمارش می‌افتد:
// جلوگیری از burn شدن سهمیه‌ی write کلاینت‌هایی که پشت‌سرهم refresh می‌زنن.
export const SUB_USER_FETCH_THROTTLE_MS = 5 * 60_000;

// کش سطح isolate — اگه همین isolate تازه ثبت کرده، اصلاً KV خونده نمی‌شه
// (تأثیر صفر روی تأخیر پاسخ اشتراک). بین isolate ها KV مرجع است.
const fetchSeenAt = new Map<string, number>();

/** ریست حالت isolate — فقط برای تست‌ها */
export function _resetSubUserFetchState(): void {
    fetchSeenAt.clear();
}

/**
 * resolve + ثبت آمار واکشی — best-effort؛ هرگز پاس اشتراک را خراب نمی‌کند.
 * آستانه‌ی ۵ دقیقه‌ای دو لایه است:
 *   1. کش isolate — در بازه، اصلاً write نمی‌شود (خواندن KV برای چک revoke لازم است)
 *   2. چک زمانی روی خود رکورد — isolate سرد هم شمارش تکراری نمی‌سازد
 * ترکیب resolve + ثبت در یک خواندن KV (به‌جای دو بار خواندن).
 */
export async function resolveAndRecordSubUser(
    env: Env,
    id: string,
    now: number = Date.now()
): Promise<SubUser | null | undefined> {
    if (!isValidSubUserId(id)) return undefined;

    // در آستانه‌ی کش isolate؟ بدون write رد شو
    const seen = fetchSeenAt.get(id);
    if (seen !== undefined && now - seen < SUB_USER_FETCH_THROTTLE_MS) {
        // هنوز باید اعتبار کاربر چک بشه — ولی خواندن KV برای resolve لازم است
        const users = await getSubUsers(env);
        const user = users.find(u => u.id === id);
        return user && user.active && !isSubUserExpired(user, now) ? user : null;
    }

    const users = await getSubUsers(env);
    const user = users.find(u => u.id === id);
    // همان قرارداد resolveSubUser: مسیر UUID همیشه null می‌دهد (نه undefined)
    if (!user || !user.active || isSubUserExpired(user, now)) return null;

    const freshWindow = typeof user.lastFetchedAt === 'number' &&
        now - user.lastFetchedAt < SUB_USER_FETCH_THROTTLE_MS;

    user.lastFetchedAt = now;
    if (!freshWindow) {
        user.fetchCount = (user.fetchCount || 0) + 1;
    }

    try {
        await saveSubUsers(env, users);
        fetchSeenAt.set(id, now);
    } catch {
        // write ناموفق — آمار مهم‌تر از دسترس‌پذیری اشتراک نیست
    }

    return user;
}

// ---------- sweep خودکار انقضا (برای cron اتوماسیون) ----------

export interface ExpirySweepResult {
    /** کاربرانی که در این اجرا غیرفعال شدند — active=true و منقضی */
    swept: SubUser[];
    /** کاربرانی که تا ۷۲ ساعت آینده منقضی می‌شوند (هنوز فعال) — برای هشدار پیش از انقضا */
    expiringSoon: SubUser[];
    /** افق هشدار پیش از انقضا — ۷۲ ساعت */
    soonWindowMs: number;
}

/**
 * sweep انقضا — کاربران active که expiresAt شان گذشته را غیرفعال می‌کند.
 *
 * لینک منقضی حتی بدون این sweep از resolveSubUser رد می‌شود (سلف-اجراکننده)،
 * اما این تابع وضعیت را در KV هم صادق می‌کند تا پنل/ربات «منقضی» را ببینند
 * و ادمین بتواند بر اساس آن notify بگیرد. فقط کاربران active بررسی می‌شوند —
 * پس اجرای مکرر cron هیچ duplicate notify یا write اضافه‌ای نمی‌سازد.
 *
 * best-effort: خطای write هرگز بالا نمی‌رود (برنامه‌ی cron خراب نمی‌شود).
 */
export async function sweepExpiredSubUsers(
    env: Env,
    now: number = Date.now(),
    soonWindowMs: number = 72 * 60 * 60 * 1000
): Promise<ExpirySweepResult> {
    const result: ExpirySweepResult = { swept: [], expiringSoon: [], soonWindowMs };

    try {
        const users = await getSubUsers(env);
        let changed = false;

        for (const user of users) {
            if (!user.active) continue;

            if (isSubUserExpired(user, now)) {
                user.active = false;
                result.swept.push(user);
                changed = true;
            } else if (
                typeof user.expiresAt === 'number'
                && user.expiresAt > now
                && user.expiresAt - now <= soonWindowMs
            ) {
                result.expiringSoon.push(user);
            }
        }

        if (changed) {
            await saveSubUsers(env, users);
        }
    } catch {
        // sweep نباید cron را بشکند — دور بعد دوباره امتحان می‌شود
    }

    return result;
}
