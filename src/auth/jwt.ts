// ---------- JWT مینیمال HS256 — جایگزین jose (v0.8.16) ----------
//
// پنل فقط دو کار با JWT می‌کند: امضای {id, iat, exp} و وریفای HS256 —
// کل jose (~۳۰KB پس از minify) برای این یک الگوریتم سنگین بود. این ماژول
// همان کار را با WebCrypto بومی ورکر انجام می‌دهد: صفر وابستگی، فرمت
// خروجی/ورودی استاندارد JWT (header.payload.signature با base64url).

export interface JwtClaims {
    id?: string;
    iat?: number;
    exp?: number;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64urlEncode(bytes: Uint8Array): string {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(input: string): Uint8Array {
    const pad = input.length % 4 ? 4 - (input.length % 4) : 0;
    const bin = atob(input.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
    return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
        'sign',
        'verify',
    ]);
}

/**
 * ساخت توکن HS256 استاندارد — claims + iat اکنون + exp = اکنون + ttl.
 * رفتار معادل SignJWT(...).setIssuedAt().setExpirationTime().sign().
 */
export async function signJwt(claims: JwtClaims, secret: string, ttlSeconds: number): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const header = b64urlEncode(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
    const payload = b64urlEncode(
        enc.encode(JSON.stringify({ ...claims, iat: now, exp: now + ttlSeconds }))
    );
    const data = `${header}.${payload}`;
    const sig = new Uint8Array(
        await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(data))
    );
    return `${data}.${b64urlEncode(sig)}`;
}

/**
 * وریفای توکن HS256 — نامعتبر/منقضی/الگوریتم دیگر → null.
 * امضا با crypto.subtle.verify (مقایسه‌ی ثابت‌زمان داخلی) و بررسی exp/iat.
 */
export async function verifyJwt(token: string, secret: string): Promise<JwtClaims | null> {
    try {
        const parts = token.split('.');
        if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return null;

        // فقط HS256 — هر الگوریتم دیگری (alg confusion) توکن نامعتبر است
        const header = JSON.parse(dec.decode(b64urlDecode(parts[0]))) as { alg?: string };
        if (header?.alg !== 'HS256') return null;

        const valid = await crypto.subtle.verify(
            'HMAC',
            await hmacKey(secret),
            b64urlDecode(parts[2]) as BufferSource,
            enc.encode(`${parts[0]}.${parts[1]}`)
        );
        if (!valid) return null;

        const claims = JSON.parse(dec.decode(b64urlDecode(parts[1]))) as JwtClaims;
        const now = Math.floor(Date.now() / 1000);
        if (typeof claims.exp !== 'number' || claims.exp <= now) return null;
        if (typeof claims.iat === 'number' && claims.iat > now + 5) return null;
        return claims;
    } catch {
        return null;
    }
}
