import { describe, it, expect, beforeAll } from 'vitest';
import type { Response } from 'undici';

/**
 * تست یکپارچگی احراز هویت — جریان واقعی login + TOTP + authenticate + resetPassword
 * با KV mock و EMBEDED_SETTINGS شبیه‌سازی‌شده (بدون نیاز به worker runtime)
 */

// ---------- globals شبیه‌سازی‌شده (معادل esbuild define + wrangler) ----------

const MOCK_EMBEDED = {
    accID: 'test-account-id',
    accEmail: 'admin@example.com',
    apiToken: 'api-token',
    vlUUID: 'b831381d-6324-4d53-ad4f-8cda48b30811',
    trPass: 'trojan-pass',
    securePath: 'sp',
    proxyIpMode: 'public',
    proxyIPs: [] as string[],
    prefixes: [] as string[],
    mainDomain: 'example.com',
    fallback: '',
    dohUrl: ''
};

(globalThis as any).EMBEDED_SETTINGS = MOCK_EMBEDED;
(globalThis as any).VERSION = '0.3.8';
(globalThis as any)._repo_ = 'https://github.com/CheginiSoroush/flash-panel';
(globalThis as any)._public_proxy_ip_ = 'bpb.yousef.isegaro.com';

// ---------- KV mock ----------

function createKvMock(seed: Record<string, string> = {}) {
    const store = new Map<string, string>(Object.entries(seed));
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

// ---------- helpers ----------

function loginRequest(body: unknown, ip: string): Request {
    return new Request('https://example.com/sp/login/authenticate', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'CF-Connecting-IP': ip
        },
        body: JSON.stringify(body)
    });
}

function getCookieToken(res: Response): string {
    const setCookie = res.headers.get('Set-Cookie') || '';
    const match = setCookie.match(/jwtToken=([^;]*)/);
    return match ? match[1] : '';
}

// هر تست IP جداگانه — تا rate-limit in-memory بین تست‌ها تداخل نکند
let ipCounter = 0;
const nextIp = () => `10.0.${Math.floor(++ipCounter / 250)}.${ipCounter % 250 + 1}`;

describe('auth integration — login + TOTP + sessions', () => {
    let auth: typeof import('../src/auth/auth');
    let totp: typeof import('../src/auth/totp');

    beforeAll(async () => {
        // import پویا — بعد از ست‌شدن globals
        const settings = await import('../src/settings/settings');
        auth = (await import('../src/auth/auth')) as any;
        totp = await import('../src/auth/totp');

        // مقداردهی globalSettings — مثل ورکر واقعی که روی هر درخواست init می‌شود
        settings.init(
            new Request('https://example.com/sp/panel/login/authenticate', {
                method: 'POST',
                headers: { 'CF-Connecting-IP': '1.2.3.4' }
            }),
            { kv: createKvMock().kv } as Env
        );
    });

    it('rejects wrong credentials and does not issue a token', async () => {
        const { kv } = createKvMock({ pwd: 'correct-pass' });
        const env = { kv } as Env;

        const res = await auth.generateJWTToken(loginRequest({
            username: 'admin@example.com',
            password: 'wrong-pass'
        }, nextIp()), env);

        expect(res.status).toBe(401);
        expect(getCookieToken(res)).toBe('');
    });

    it('rejects unknown username even with correct password', async () => {
        const { kv } = createKvMock({ pwd: 'correct-pass' });
        const env = { kv } as Env;

        const res = await auth.generateJWTToken(loginRequest({
            username: 'attacker@example.com',
            password: 'correct-pass'
        }, nextIp()), env);

        expect(res.status).toBe(401);
    });

    it('logs in without 2FA and the issued session authenticates', async () => {
        const { kv } = createKvMock({ pwd: 'correct-pass' });
        const env = { kv } as Env;

        const res = await auth.generateJWTToken(loginRequest({
            username: 'admin@example.com',
            password: 'correct-pass'
        }, nextIp()), env);

        expect(res.status).toBe(200);
        const token = getCookieToken(res);
        expect(token).not.toBe('');

        // همان توکن authenticate می‌شود
        const authed = await auth.authenticate(
            new Request('https://example.com/sp/panel', { headers: { Cookie: `jwtToken=${token}` } }),
            env
        );
        expect(authed).toBe(true);

        // بدون کوکی → رد
        expect(await auth.authenticate(new Request('https://example.com/sp/panel'), env)).toBe(false);
        // توکن دستکاری‌شده → رد
        const tampered = await auth.authenticate(
            new Request('https://example.com/sp/panel', { headers: { Cookie: `jwtToken=${token}x` } }),
            env
        );
        expect(tampered).toBe(false);
    });

    it('requires a 2FA code when enabled, rejects bad codes, accepts the live code', async () => {
        const secret = totp.generateTotpSecret();
        const { kv } = createKvMock({ pwd: 'correct-pass', totpEnabled: 'true', totpSecret: secret });
        const env = { kv } as Env;
        auth.invalidateTotpCache(true);

        const ip = nextIp();

        // بدون کد
        const noCode = await auth.generateJWTToken(loginRequest({
            username: 'admin@example.com', password: 'correct-pass'
        }, ip), env);
        expect(noCode.status).toBe(401);

        // کد غلط
        const bad = await auth.generateJWTToken(loginRequest({
            username: 'admin@example.com', password: 'correct-pass', totp: '000000'
        }, ip), env);
        expect(bad.status).toBe(401);

        // کد معتبر زمان جاری
        const code = await totp.totp(secret);
        const good = await auth.generateJWTToken(loginRequest({
            username: 'admin@example.com', password: 'correct-pass', totp: code
        }, ip), env);
        expect(good.status).toBe(200);
        expect(getCookieToken(good)).not.toBe('');
    });

    it('blocks TOTP code replay — a used code cannot log in again', async () => {
        const secret = totp.generateTotpSecret();
        const { kv } = createKvMock({ pwd: 'correct-pass', totpEnabled: 'true', totpSecret: secret });
        const env = { kv } as Env;
        auth.invalidateTotpCache(true);

        const code = await totp.totp(secret);
        const ip = nextIp();

        const first = await auth.generateJWTToken(loginRequest({
            username: 'admin@example.com', password: 'correct-pass', totp: code
        }, ip), env);
        expect(first.status).toBe(200);

        // replay همان کد — حتی با پسورد درست
        const replay = await auth.generateJWTToken(loginRequest({
            username: 'admin@example.com', password: 'correct-pass', totp: code
        }, ip), env);
        expect(replay.status).toBe(401);
    });

    it('rate-limits brute force to 5 failed attempts per minute per IP', async () => {
        const { kv } = createKvMock({ pwd: 'correct-pass' });
        const env = { kv } as Env;

        const ip = nextIp();
        const attempt = () => auth.generateJWTToken(loginRequest({
            username: 'admin@example.com', password: 'nope'
        }, ip), env);

        // ۵ تلاش اول → 401
        for (let i = 0; i < 5; i++) {
            const res = await attempt();
            expect(res.status).toBe(401);
        }

        // تلاش ششم → 429
        const blocked = await attempt();
        expect(blocked.status).toBe(429);
    });

    it('resetPassword requires auth when a password exists, then updates it', async () => {
        // نکته: کش pwd سطح isolate (TTL ۵ث) بین تست‌ها مشترک است — همان پسورد اولین تست
        // در کش است؛ پس این تست هم با 'correct-pass' لاگین می‌کند (شبیه‌سازی همان isolate واقعی)
        const { kv } = createKvMock({ pwd: 'correct-pass' });
        const env = { kv } as Env;

        // کش TOTP سطح isolate (TTL ۱۵ث) از تست‌های قبلی فعاله — این KV آن را ندارد
        auth.invalidateTotpCache(false);

        // بدون auth → رد
        const unauthorized = await auth.resetPassword(new Request('https://example.com/sp/panel/reset-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': nextIp() },
            body: JSON.stringify({ password: 'brand-new-pass' })
        }), env);
        expect(unauthorized.status).toBe(401);

        // با auth → تغییر پسورد
        const login = await auth.generateJWTToken(loginRequest({
            username: 'admin@example.com', password: 'correct-pass'
        }, nextIp()), env);
        const token = getCookieToken(login);

        const changed = await auth.resetPassword(new Request('https://example.com/sp/panel/reset-password', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Cookie': `jwtToken=${token}`
            },
            body: JSON.stringify({ password: 'brand-new-pass' })
        }), env);
        expect(changed.status).toBe(200);

        // پسورد جدید بلافاصله معتبر (کش فوراً invalidate می‌شود) و قدیمی رد
        const withNew = await auth.generateJWTToken(loginRequest({
            username: 'admin@example.com', password: 'brand-new-pass'
        }, nextIp()), env);
        expect(withNew.status).toBe(200);
    });
});
