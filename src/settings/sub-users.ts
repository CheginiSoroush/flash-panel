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

export function parseSubUsers(raw: unknown): SubUser[] {
    if (!Array.isArray(raw)) return [];
    return raw.filter(
        (u): u is SubUser =>
            Boolean(u) &&
            typeof u === 'object' &&
            isValidSubUserId(String((u as SubUser).id)) &&
            typeof (u as SubUser).name === 'string'
    );
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
    patch: { name?: unknown; active?: unknown }
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
 * (لینک قدیمی ادمین)، null یعنی UUID هست ولی نامعتبر/غیرفعاله
 */
export async function resolveSubUser(env: Env, id: string): Promise<SubUser | null | undefined> {
    if (!isValidSubUserId(id)) return undefined;

    const users = await getSubUsers(env);
    const user = users.find(u => u.id === id);
    return user && user.active ? user : null;
}
