import { HttpStatus, respond } from '@common';
import { SignJWT, jwtVerify } from 'jose';
import { getGlobals } from '@settings';

// ---------- کش‌های سطح isolate ----------

// secretKey عملاً immutable هست (یک‌بار ساخته می‌شه) — فقط یک خواندن KV در عمر isolate
let cachedSecretKey: string | null = null;
let secretKeyLoaded = false;

async function getSecretKey(env: Env): Promise<string | null> {
    if (!secretKeyLoaded) {
        cachedSecretKey = await env.kv.get('secretKey');
        secretKeyLoaded = true;
    }
    return cachedSecretKey;
}

// pwd ممکنه تغییر کنه (resetPassword) — TTL کوتاه + invalidation محلی فوری
let cachedPwd: string | null = null;
let pwdLoadedAt = 0;
const PWD_CACHE_TTL = 5_000;

export async function getPwd(env: Env): Promise<string | null> {
    if (Date.now() - pwdLoadedAt < PWD_CACHE_TTL) {
        return cachedPwd;
    }
    cachedPwd = await env.kv.get('pwd');
    pwdLoadedAt = Date.now();
    return cachedPwd;
}

// ---------- محدودکننده نرخ لاگین (per-IP در حافظه isolate) ----------

const LOGIN_ATTEMPTS_LIMIT = 5;
const LOGIN_WINDOW_MS = 60_000;
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

function isRateLimited(ip: string): boolean {
    const entry = loginAttempts.get(ip);
    if (!entry || Date.now() > entry.resetAt) return false;
    return entry.count >= LOGIN_ATTEMPTS_LIMIT;
}

function recordFailedLogin(ip: string) {
    const now = Date.now();
    const entry = loginAttempts.get(ip);

    if (!entry || now > entry.resetAt) {
        loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    } else {
        entry.count++;
    }

    // پاکسازی دوره‌ای — جلوگیری از رشد بی‌نهایت Map
    if (loginAttempts.size > 1000) {
        for (const [key, e] of loginAttempts) {
            if (now > e.resetAt) loginAttempts.delete(key);
        }
    }
}

// ---------- مقایسه constant-time ----------

function constantTimeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
}

export function logout(): Response {
    return respond(true, HttpStatus.OK, 'Successfully logged out!', null, {
        'Set-Cookie': 'jwtToken=; Path=/; Secure; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
        'Content-Type': 'text/plain'
    });
}

export async function generateJWTToken(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') {
        return respond(false, HttpStatus.METHOD_NOT_ALLOWED, 'Method not allowed.');
    }

    let data: any;
    try {
        data = await request.json();
    } catch {
        return respond(false, HttpStatus.BAD_REQUEST, 'Invalid request body.');
    }

    // محدودسازی brute-force — ۵ تلاش ناموفق در دقیقه برای هر IP
    const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (isRateLimited(clientIP)) {
return respond(false, 429 as unknown as HttpStatus, 'Too many attempts. Try again later.');    }

    const username = typeof data.username === 'string' ? data.username.toLowerCase() : '';
    const password = typeof data.password === 'string' ? data.password : '';
    const { accEmail } = getGlobals();
    const savedPass = await getPwd(env);

    // بدون پسورد ست‌شده نمی‌شه لاگین کرد (رفتار قبلی حفظ شده)
    if (!savedPass || username !== accEmail || !constantTimeEqual(password, savedPass)) {
        recordFailedLogin(clientIP);
        return respond(false, HttpStatus.UNAUTHORIZED, 'Wrong Credentials.');
    }

    let secretKey = await getSecretKey(env);
    if (!secretKey) {
        secretKey = generateSecretKey();
        await env.kv.put('secretKey', secretKey);
        cachedSecretKey = secretKey;
        secretKeyLoaded = true;
    }

    const secret = new TextEncoder().encode(secretKey);
    const { accID } = getGlobals();
    const jwtToken = await new SignJWT({ id: accID })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('24h')
        .sign(secret);

    // لاگین موفق — شمارنده IP پاک بشه
    loginAttempts.delete(clientIP);

    return respond(true, HttpStatus.OK, 'Successfully generated Auth token', null, {
        'Set-Cookie': `jwtToken=${jwtToken}; Path=/; HttpOnly; Secure; Max-Age=${24 * 60 * 60}; SameSite=Strict`,
        'Content-Type': 'text/plain',
    });
}

function generateSecretKey(): string {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);

    return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function authenticate(request: Request, env: Env): Promise<boolean> {
    try {
        const secretKey = await getSecretKey(env);
        if (!secretKey) {
            return false;
        }

        const secret = new TextEncoder().encode(secretKey);
        const cookie = request.headers.get('Cookie')?.match(/(^|;\s*)jwtToken=([^;]*)/);
        const token = cookie ? cookie[2] : null;
        if (!token) {
            return false;
        }

        await jwtVerify(token, secret);
        return true;
    } catch (error) {
        return false;
    }
}

export async function resetPassword(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') {
        return respond(false, HttpStatus.METHOD_NOT_ALLOWED, 'Method not allowed.');
    }

    let data: any;
    try {
        data = await request.json();
    } catch {
        return respond(false, HttpStatus.BAD_REQUEST, 'Invalid request body.');
    }

    const auth = await authenticate(request, env);
    const oldPwd = await getPwd(env);
    if (oldPwd && !auth) {
        return respond(false, HttpStatus.UNAUTHORIZED, 'Unauthorized.');
    }

    const { accEmail } = getGlobals();

    if (!auth && !data.username) {
        return respond(false, HttpStatus.BAD_REQUEST, 'Missing username.');
    }

    if (data.username && data.username !== accEmail) {
        return respond(false, HttpStatus.BAD_REQUEST, 'Wrong username.');
    }

    const newPassword = typeof data.password === 'string' ? data.password : '';
    if (!newPassword) {
        return respond(false, HttpStatus.BAD_REQUEST, 'Missing password.');
    }

    if (newPassword === oldPwd) {
        return respond(false, HttpStatus.BAD_REQUEST, 'Please enter a new Password.');
    }

    await env.kv.put('pwd', newPassword);

    // کش pwd فوری به‌روز بشه (بقیه isolate ها حداکثر ۵ ثانیه بعد)
    cachedPwd = newPassword;
    pwdLoadedAt = Date.now();

    return respond(true, HttpStatus.OK, 'Successfully logged in!', null, {
        'Set-Cookie': 'jwtToken=; Path=/; Secure; SameSite=Strict; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
        'Content-Type': 'text/plain',
    });
}