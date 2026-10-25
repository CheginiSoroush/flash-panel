import { HttpStatus, respond } from '@common';
import { SignJWT, jwtVerify } from 'jose';
import { getGlobals } from '@settings';
import { verifyTotp } from './totp';

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

// ---------- محدودکننده نرخ لاگین (per-IP: حافظه سریع + قاطع سراسری KV) ----------
// v0.8.13: شمارنده‌ی حافظه فقط برای isolate خودش معنا دارد — در تولید، CF درخواست‌های
// یک IP را بین چند isolate پخش می‌کند و سقف ۵تایی عملاً per-isolate اعمال می‌شد.
// لایه‌ی دوم: مارکر بلاک در KV — هر isolate که آستانه را رد کند مارکر را با TTL می‌نویسد
// و همه‌ی isolateها قبل از پردازش لاگین آن را می‌خوانند (1 خواندن به‌ازای هر تلاش لاگین —
// لاگین نادر است؛ نوشتن فقط در عبور از آستانه — رژیم نوشتار KV دست‌نخورده می‌ماند).

const LOGIN_ATTEMPTS_LIMIT = 5;
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_BLOCK_TTL = 300;   // ثانیه — مارکر بلاک سراسری (حداقل مجاز KV: ۶۰)
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

function loginBlockKey(ip: string): string {
    return `loginBlock:${ip}`;
}

async function isRateLimited(ip: string, env: Env): Promise<boolean> {
    // مسیر سریع — حافظه‌ی isolate (صفر KV)
    const entry = loginAttempts.get(ip);
    if (entry && Date.now() <= entry.resetAt && entry.count >= LOGIN_ATTEMPTS_LIMIT) return true;
    // قاطع سراسری — مارکر KV (failure-safe: خرابی KV → fail-open مثل بقیه‌ی پنل)
    try {
        return (await env.kv.get(loginBlockKey(ip))) === '1';
    } catch {
        return false;
    }
}

async function recordFailedLogin(ip: string, env: Env): Promise<void> {
    const now = Date.now();
    const entry = loginAttempts.get(ip);

    let crossed = false;
    if (!entry || now > entry.resetAt) {
        loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    } else {
        entry.count++;
        // فقط در عبور از آستانه مارکر سراسری نوشته می‌شود — نه هر بار
        crossed = entry.count === LOGIN_ATTEMPTS_LIMIT;
    }

    // پاکسازی دوره‌ای — جلوگیری از رشد بی‌نهایت Map
    if (loginAttempts.size > 1000) {
        for (const [key, e] of loginAttempts) {
            if (now > e.resetAt) loginAttempts.delete(key);
        }
    }

    if (crossed) {
        try {
            await env.kv.put(loginBlockKey(ip), '1', { expirationTtl: LOGIN_BLOCK_TTL });
        } catch {
            // سقف/خرابی KV — حافظه‌ی همین isolate همچنان محافظت می‌کند
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
    if (await isRateLimited(clientIP, env)) {
return respond(false, 429 as unknown as HttpStatus, 'Too many attempts. Try again later.');    }

    const username = typeof data.username === 'string' ? data.username.toLowerCase() : '';
    const password = typeof data.password === 'string' ? data.password : '';
    const { accEmail } = getGlobals();
    const savedPass = await getPwd(env);

    // بدون پسورد ست‌شده نمی‌شه لاگین کرد (رفتار قبلی حفظ شده)
    if (!savedPass || username !== accEmail || !constantTimeEqual(password, savedPass)) {
        await recordFailedLogin(clientIP, env);
        return respond(false, HttpStatus.UNAUTHORIZED, 'Wrong Credentials.');
    }

    // ---------- ورود دومرحله‌ای TOTP (بعد از تأیید پسورد) ----------
    // خطای TOTP هم در سهمیه‌ی rate-limit محاسبه می‌شه (همان ۵ تلاش در دقیقه)
    if (await isTotpEnabled(env)) {
        const totpSecret = await env.kv.get('totpSecret');
        const code = typeof data.totp === 'string' ? data.totp : '';

        if (!totpSecret || !code) {
            await recordFailedLogin(clientIP, env);
            return respond(false, HttpStatus.UNAUTHORIZED, '2FA verification code required.');
        }

        const { ok, counter } = await verifyTotp(totpSecret, code);

        // جلوگیری از replay — یک کد فقط یک‌بار مصرف می‌شه (بهترین تلاش روی KV نهایی‌المنطقه)
        const lastUsedRaw = await env.kv.get('totpLastUsed');
        const lastUsed = lastUsedRaw ? Number(lastUsedRaw) : 0;

        if (!ok || counter === null || counter <= lastUsed) {
            await recordFailedLogin(clientIP, env);
            return respond(false, HttpStatus.UNAUTHORIZED, 'Invalid 2FA code.');
        }

        await env.kv.put('totpLastUsed', String(counter));
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

// ---------- وضعیت TOTP (تغییر نادر — TTL کش می‌تونه بلند باشه) ----------

let cachedTotpEnabled = false;
let totpLoadedAt = 0;
const TOTP_CACHE_TTL = 15_000;

export async function isTotpEnabled(env: Env): Promise<boolean> {
    if (Date.now() - totpLoadedAt < TOTP_CACHE_TTL) {
        return cachedTotpEnabled;
    }

    cachedTotpEnabled = (await env.kv.get('totpEnabled')) === 'true';
    totpLoadedAt = Date.now();
    return cachedTotpEnabled;
}

// invalidation محلی بعد از enable/disable در همان isolate
export function invalidateTotpCache(enabled: boolean): void {
    cachedTotpEnabled = enabled;
    totpLoadedAt = Date.now();
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