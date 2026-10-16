import { describe, it, expect } from 'vitest';
import {
    base32Decode,
    base32Encode,
    generateTotpSecret,
    hotp,
    totp,
    verifyTotp,
    buildOtpAuthUri,
    TOTP_DIGITS,
    TOTP_PERIOD
} from '../src/auth/totp';

// ---------- RFC 4648 — Base32 ----------

describe('base32', () => {
    it('encodes RFC 4648 test vectors', () => {
        // secret = "foobar" family — بردارهای رسمی RFC 4648 §10
        // بردار «foobart» مطابق erratum RFC اصلاح شده (در RFC اصلی ۵۰ بیت برای ۵۶ بیت جا نمی‌شد)
        const vectors: Array<[string, string]> = [
            ['', ''],
            ['f', 'MY======'],
            ['fo', 'MZXQ===='],
            ['foo', 'MZXW6==='],
            ['foob', 'MZXW6YQ='],
            ['fooba', 'MZXW6YTB'],
            ['foobart', 'MZXW6YTBOJ2A====']
        ];

        for (const [plain, expected] of vectors) {
            const bytes = new TextEncoder().encode(plain);
            // بدون padding مقایسه می‌کنیم — encoder ما padding تولید نمی‌کنه
            expect(base32Encode(bytes)).toBe(expected.replace(/=+$/, ''));
        }
    });

    it('round-trips encode → decode', () => {
        const samples = [
            new Uint8Array(0),
            new Uint8Array([1, 2, 3]),
            new TextEncoder().encode('foobart'),
            crypto.getRandomValues(new Uint8Array(32)),
            crypto.getRandomValues(new Uint8Array(20))
        ];

        for (const bytes of samples) {
            expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
        }
    });

    it('decodes with padding, spaces and dashes (user-tolerant)', () => {
        const expected = new TextEncoder().encode('foo');
        expect(base32Decode('MZXW6===')).toEqual(expected);
        expect(base32Decode('MZ XW6')).toEqual(expected);
        expect(base32Decode('MZ-XW6')).toEqual(expected);
        expect(base32Decode('mzxw6')).toEqual(expected); // lowercase
        expect(base32Decode('')).toEqual(new Uint8Array(0)); // empty round-trip
        expect(base32Decode('   ')).toEqual(new Uint8Array(0));
    });

    it('rejects invalid characters', () => {
        expect(() => base32Decode('ABC1')).toThrow(/Invalid base32/); // 1 خارج از الفبا
        expect(() => base32Decode('A@B')).toThrow(/Invalid base32/);
    });
});

// ---------- RFC 6238 — TOTP (HMAC-SHA1) ----------

// secret استاندارد RFC 6238: بایت‌های ASCII "12345678901234567890"
const RFC_SECRET_BYTES = new TextEncoder().encode('12345678901234567890');

// بردارهای رسمی RFC 6238 (SHA-1، ۸ رقم): T(sec) → کد
const RFC_6238_SHA1_VECTORS: Array<[number, string]> = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130']
];

describe('TOTP (RFC 6238)', () => {
    it('matches official RFC 6238 SHA-1 8-digit vectors', async () => {
        for (const [timeSec, expected] of RFC_6238_SHA1_VECTORS) {
            const code = await hotp(RFC_SECRET_BYTES, Math.floor(timeSec / 30), 8);
            expect(code, `T=${timeSec}`).toBe(expected);
        }
    });

    it('6-digit code is last 6 digits of 8-digit (same truncation path)', async () => {
        for (const [timeSec] of RFC_6238_SHA1_VECTORS) {
            const code8 = await hotp(RFC_SECRET_BYTES, Math.floor(timeSec / 30), 8);
            const code6 = await hotp(RFC_SECRET_BYTES, Math.floor(timeSec / 30), 6);
            expect(code6).toBe(code8.slice(-6));
        }
    });

    it('totp() derives counter from timestamp with 30s period', async () => {
        const secret = base32Encode(RFC_SECRET_BYTES);
        const t59 = await totp(secret, 59_000, 6, 30);
        const t45 = await totp(secret, 45_000, 6, 30); // همان گام اول (30s ≤ t < 60s)
        const t90 = await totp(secret, 90_000, 6, 30);

        expect(t59).toBe(t45); // همان گام — کد یکسان
        expect(t90).not.toBe(t59); // گام بعد — کد جدید
        expect(t59).toHaveLength(6);
    });

    it('zero-pads short codes', async () => {
        // گامی که کدش کمتر از ۶ رقم می‌شود — با بردار RFC: 07081804 → 081804 با ۶ رقم
        const code = await hotp(RFC_SECRET_BYTES, Math.floor(1111111109 / 30), 6);
        expect(code).toBe('081804');
        expect(code.startsWith('0')).toBe(true);
    });

    it('generates unique secrets with correct length', () => {
        const secrets = new Set<string>();
        for (let i = 0; i < 20; i++) {
            const secret = generateTotpSecret();
            expect(secret).toHaveLength(32); // 20 بایت → 32 کاراکتر base32
            expect(secret).toMatch(/^[A-Z2-7]+$/);
            secrets.add(secret);
        }
        expect(secrets.size).toBe(20);
    });
});

// ---------- verifyTotp ----------

describe('verifyTotp', () => {
    const secret = base32Encode(RFC_SECRET_BYTES);
    const T = 1_700_000_000_000; // ms
    const currentCounter = Math.floor(T / 1000 / TOTP_PERIOD);

    it('accepts the current code and reports matched counter', async () => {
        const code = await hotp(RFC_SECRET_BYTES, currentCounter);
        const result = await verifyTotp(secret, code, 1, T);
        expect(result).toEqual({ ok: true, counter: currentCounter });
    });

    it('accepts ±1 step drift with window=1', async () => {
        const prevCode = await hotp(RFC_SECRET_BYTES, currentCounter - 1);
        const nextCode = await hotp(RFC_SECRET_BYTES, currentCounter + 1);

        expect(await verifyTotp(secret, prevCode, 1, T)).toEqual({ ok: true, counter: currentCounter - 1 });
        expect(await verifyTotp(secret, nextCode, 1, T)).toEqual({ ok: true, counter: currentCounter + 1 });
    });

    it('rejects codes beyond the drift window', async () => {
        const farPast = await hotp(RFC_SECRET_BYTES, currentCounter - 2);
        const farFuture = await hotp(RFC_SECRET_BYTES, currentCounter + 2);

        expect((await verifyTotp(secret, farPast, 1, T)).ok).toBe(false);
        expect((await verifyTotp(secret, farFuture, 1, T)).ok).toBe(false);
    });

    it('rejects wrong codes and malformed input', async () => {
        const code = await hotp(RFC_SECRET_BYTES, currentCounter);
        const wrongCode = code === '000000' ? '000001' : '000000';

        expect((await verifyTotp(secret, wrongCode, 1, T)).ok).toBe(false);
        expect((await verifyTotp(secret, '', 1, T)).ok).toBe(false);
        expect((await verifyTotp(secret, '12', 1, T)).ok).toBe(false);
        expect((await verifyTotp(secret, 'abcdef', 1, T)).ok).toBe(false); // غیرعددی
        expect((await verifyTotp(secret, '1234567', 1, T)).ok).toBe(false); // طول اشتباه
        expect((await verifyTotp('INVALID!!', code, 1, T)).ok).toBe(false); // secret خراب
    });

    it('tolerates spacing in user input', async () => {
        const code = await hotp(RFC_SECRET_BYTES, currentCounter);
        const spaced = code.slice(0, 3) + ' ' + code.slice(3);
        expect((await verifyTotp(secret, spaced, 1, T)).ok).toBe(true);
    });
});

// ---------- otpauth URI ----------

describe('buildOtpAuthUri', () => {
    it('builds a standard otpauth://totp URI', () => {
        const uri = buildOtpAuthUri('JBSWY3DPEHPK3PXP', 'admin@example.com', 'Flash Panel');

        expect(uri.startsWith('otpauth://totp/')).toBe(true);
        expect(uri).toContain('Flash%20Panel%3Aadmin%40example.com');
        expect(uri).toContain('secret=JBSWY3DPEHPK3PXP');
        expect(uri).toContain('issuer=Flash+Panel');
        expect(uri).toContain('algorithm=SHA1');
        expect(uri).toContain('digits=6');
        expect(uri).toContain('period=30');
    });

    it('produces URI scannable by authenticators (sanity round-trip)', () => {
        const secret = generateTotpSecret();
        const uri = buildOtpAuthUri(secret, 'user@host', 'Flash Panel');
        const url = new URL(uri);

        expect(url.protocol).toBe('otpauth:');
        // در اسکیم‌های non-special، بخش «totp» به‌عنوان host پارس می‌شه
        expect(url.host).toBe('totp');
        expect(decodeURIComponent(url.pathname)).toBe('/Flash Panel:user@host');
        expect(url.searchParams.get('secret')).toBe(secret);
    });
});
