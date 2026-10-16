// ---------- RFC 6238 TOTP + RFC 4648 Base32 (Web Crypto — سازگار با Cloudflare Workers) ----------

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const BASE32_LOOKUP: Record<string, number> = {};
for (let i = 0; i < BASE32_ALPHABET.length; i++) {
    BASE32_LOOKUP[BASE32_ALPHABET[i]] = i;
}

export const TOTP_DIGITS = 6;
export const TOTP_PERIOD = 30;

/**
 * Base32 decode — RFC 4648
 * فاصله/خط تیره نادیده گرفته می‌شه (ورودی از موبایل ممکنه جدا شده باشه)
 * کاراکتر نامعتبر → خطا
 */
export function base32Decode(input: string): Uint8Array {
    const clean = input.toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');

    if (!clean.length) {
        return new Uint8Array(0);
    }

    let bits = 0;
    let value = 0;
    const output: number[] = [];

    for (const char of clean) {
        const idx = BASE32_LOOKUP[char];
        if (idx === undefined) {
            throw new Error(`Invalid base32 character: "${char}"`);
        }

        value = (value << 5) | idx;
        bits += 5;

        if (bits >= 8) {
            output.push((value >>> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }

    return new Uint8Array(output);
}

/**
 * Base32 encode — بدون padding (فرمت استاندارد secret های otpauth)
 */
export function base32Encode(bytes: Uint8Array): string {
    let bits = 0;
    let value = 0;
    let output = '';

    for (const byte of bytes) {
        value = (value << 8) | byte;
        bits += 8;

        while (bits >= 5) {
            output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }

    if (bits > 0) {
        output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
    }

    return output;
}

/**
 * secret تازه — ۲۰ بایت تصادفی (160 bit — توصیه RFC 4226)
 */
export function generateTotpSecret(): string {
    const bytes = new Uint8Array(20);
    crypto.getRandomValues(bytes);
    return base32Encode(bytes);
}

async function hmacSha1(key: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
    const cryptoKey = await crypto.subtle.importKey(
        'raw',
        key as unknown as ArrayBuffer,
        { name: 'HMAC', hash: 'SHA-1' },
        false,
        ['sign']
    );

    const signature = await crypto.subtle.sign('HMAC', cryptoKey, message as unknown as ArrayBuffer);
    return new Uint8Array(signature);
}

/**
 * HOTP — RFC 4226 (HMAC-based، پرکاربردترین حالت HMAC-SHA1 با ۶ رقم)
 */
export async function hotp(secret: Uint8Array, counter: number, digits: number = TOTP_DIGITS): Promise<string> {
    // شمارنده ۸ بایتی big-endian
    const message = new Uint8Array(8);
    let c = counter;
    for (let i = 7; i >= 0; i--) {
        message[i] = c & 0xff;
        c = Math.floor(c / 256);
    }

    const mac = await hmacSha1(secret, message);

    // Dynamic truncation — RFC 4226 §5.4
    const offset = mac[mac.length - 1] & 0x0f;
    const binary =
        ((mac[offset] & 0x7f) << 24) |
        ((mac[offset + 1] & 0xff) << 16) |
        ((mac[offset + 2] & 0xff) << 8) |
        (mac[offset + 3] & 0xff);

    const code = binary % 10 ** digits;
    return code.toString().padStart(digits, '0');
}

/**
 * TOTP — RFC 6238 (time-based با گام ۳۰ ثانیه و SHA-1)
 * timestamp برحسب میلی‌ثانیه — قابل تست با مقدار ثابت
 */
export async function totp(
    secretBase32: string,
    timestamp: number = Date.now(),
    digits: number = TOTP_DIGITS,
    period: number = TOTP_PERIOD
): Promise<string> {
    const secret = base32Decode(secretBase32);
    const counter = Math.floor(timestamp / 1000 / period);
    return hotp(secret, counter, digits);
}

/**
 * مقایسه constant-time برای رشته‌های کد
 */
function constantTimeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;

    let diff = 0;
    for (let i = 0; i < a.length; i++) {
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }

    return diff === 0;
}

/**
 * بررسی کد TOTP با پنجره drift (پیش‌فرض ±۱ گام = ±۳۰ ثانیه)
 * مقاوم در برابر فاصله‌گذاری ورودی («123 456» یا «123-456» هم قبول می‌شه)
 *
 * خروجی counter مرحله تطبیق‌یافته — برای جلوگیری از replay استفاده می‌شه
 */
export async function verifyTotp(
    secretBase32: string,
    code: string,
    window: number = 1,
    timestamp: number = Date.now(),
    digits: number = TOTP_DIGITS,
    period: number = TOTP_PERIOD
): Promise<{ ok: boolean; counter: number | null }> {
    const normalized = code.replace(/\D/g, '');

    if (normalized.length !== digits) {
        return { ok: false, counter: null };
    }

    let secret: Uint8Array;
    try {
        secret = base32Decode(secretBase32);
    } catch {
        return { ok: false, counter: null };
    }

    const currentCounter = Math.floor(timestamp / 1000 / period);

    // از گام‌های جدید به قدیمی — اولین تطبیق، معتبرترین
    for (let drift = 0; drift <= window; drift++) {
        for (const counter of drift === 0 ? [currentCounter] : [currentCounter + drift, currentCounter - drift]) {
            const expected = await hotp(secret, counter, digits);
            if (constantTimeEqual(normalized, expected)) {
                return { ok: true, counter };
            }
        }
    }

    return { ok: false, counter: null };
}

/**
 * ساخت URI نرمال otpauth:// — سازگار با Google Authenticator / Aegis / 1Password / Authy
 */
export function buildOtpAuthUri(
    secret: string,
    account: string,
    issuer: string,
    digits: number = TOTP_DIGITS,
    period: number = TOTP_PERIOD
): string {
    const label = encodeURIComponent(`${issuer}:${account}`);
    const params = new URLSearchParams({
        secret,
        issuer,
        algorithm: 'SHA1',
        digits: String(digits),
        period: String(period)
    });

    return `otpauth://totp/${label}?${params.toString()}`;
}
