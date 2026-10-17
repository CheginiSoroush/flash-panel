import { describe, it, expect, beforeAll } from 'vitest';

/**
 * گیت توکن مسیر WS — ضد پروب فعال (معکوس‌مهندسی v0.8.0)
 *
 * قبل: مسیر WS تصادفی بود ولی ورکر بدون اعتبارسنجی روی /vl/<هرچیزی> پاس 101
 * می‌داد → سیگنال قطعی برای active-probing فیلترچی. حالا فقط /vl|/tr/<توکن
 * مشتق‌شده از securePath> وارد هندلر پروتکل می‌شود؛ بقیه fallback (صفحه‌ی عادی).
 */

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
(globalThis as any).VERSION = '0.8.0';

let deriveWsToken: typeof import('../src/cores/utils')['deriveWsToken'];
let getWsRoute: typeof import('../src/cores/utils')['getWsRoute'];
let pickFingerprint: typeof import('../src/cores/utils')['pickFingerprint'];
let generateWsPath: typeof import('../src/cores/utils')['generateWsPath'];

beforeAll(async () => {
    const utils = await import('../src/cores/utils');
    deriveWsToken = utils.deriveWsToken;
    getWsRoute = utils.getWsRoute;
    pickFingerprint = utils.pickFingerprint;
    generateWsPath = utils.generateWsPath;

    // init واقعی globals — generateWsPath برای توکن به securePath نیاز دارد
    const settings = await import('../src/settings/settings');
    settings.init(
        new Request('https://example.com/sp/panel'),
        { kv: { get: () => Promise.resolve(null), put: () => Promise.resolve(), delete: () => Promise.resolve() } } as any
    );
});

describe('deriveWsToken — مشتق قطعی از securePath + پروتکل', () => {
    it('قطعی است — ورودی یکسان، خروجی یکسان', () => {
        expect(deriveWsToken('sp', 'vl')).toBe(deriveWsToken('sp', 'vl'));
    });

    it('فرمت: ۲۴ کاراکتر هگز', () => {
        const token = deriveWsToken('sp', 'vl');
        expect(token).toMatch(/^[0-9a-f]{24}$/);
    });

    it('پروتکل‌های vl/tr توکن متفاوت دارند', () => {
        expect(deriveWsToken('sp', 'vl')).not.toBe(deriveWsToken('sp', 'tr'));
    });

    it('securePath متفاوت → توکن متفاوت (بدون securePath قابل حدس نیست)', () => {
        expect(deriveWsToken('sp', 'vl')).not.toBe(deriveWsToken('other', 'vl'));
        expect(deriveWsToken('', 'vl')).not.toBe(deriveWsToken('sp', 'vl'));
    });
});

describe('getWsRoute — گیت پروب', () => {
    it('مسیر درست → پروتکل', () => {
        const tokenVl = deriveWsToken('sp', 'vl');
        const tokenTr = deriveWsToken('sp', 'tr');
        expect(getWsRoute(`/vl/${tokenVl}`, 'sp')).toBe('vl');
        expect(getWsRoute(`/tr/${tokenTr}`, 'sp')).toBe('tr');
    });

    it('توکن غلط / غایب → null (fallback، نه 101)', () => {
        expect(getWsRoute('/vl/wrongtoken', 'sp')).toBeNull();
        expect(getWsRoute('/vl', 'sp')).toBeNull();
        expect(getWsRoute('/vl/', 'sp')).toBeNull();
    });

    it('پروتکل ناشناخته و ریشه → null', () => {
        expect(getWsRoute(`/other/${deriveWsToken('sp', 'vl')}`, 'sp')).toBeNull();
        expect(getWsRoute('/', 'sp')).toBeNull();
        expect(getWsRoute('', 'sp')).toBeNull();
    });

    it('توکن درست با دنباله‌ی اضافه → null (سخت‌گیر کامل)', () => {
        expect(getWsRoute(`/vl/${deriveWsToken('sp', 'vl')}/extra`, 'sp')).toBeNull();
    });

    it('توکن پروتکل دیگر قبول نمی‌شود (tr token روی مسیر vl)', () => {
        expect(getWsRoute(`/vl/${deriveWsToken('sp', 'tr')}`, 'sp')).toBeNull();
    });
});

describe('generateWsPath — سازگاری تولید کانفیگ با گیت', () => {
    it('فرمت /vl|/tr/<توکن> — همان چیزی که گیت قبول می‌کند', () => {
        const vlPath = generateWsPath('vless');
        const trPath = generateWsPath('trojan');

        expect(vlPath).toMatch(/^\/vl\/[0-9a-f]{24}$/);
        expect(trPath).toMatch(/^\/tr\/[0-9a-f]{24}$/);

        // رفت‌وبرگشت کامل: مسیرِ تولیدی باید از گیت رد شود
        expect(getWsRoute(vlPath, 'sp')).toBe('vl');
        expect(getWsRoute(trPath, 'sp')).toBe('tr');
    });

    it('قطعی است — هر پروفایل همان مسیر را می‌گیرد (داخل TLS نامرئی است)', () => {
        expect(generateWsPath('vless')).toBe(generateWsPath('vless'));
    });
});

describe('pickFingerprint — چرخش ضد خوشه‌بندی JA3', () => {
    const VALID = new Set(['chrome', 'firefox', 'safari', 'ios', 'android', 'edge', '360', 'qq']);

    it('قطعی است', () => {
        expect(pickFingerprint(7)).toBe(pickFingerprint(7));
    });

    it('همه‌ی مقادیر معتبر uTLS هستند', () => {
        for (let i = 0; i < 100; i++) {
            expect(VALID.has(pickFingerprint(i))).toBe(true);
        }
    });

    it('chrome سهم غالب دارد ولی ios/firefox هم حاضرند (تنوع کلاس JA3)', () => {
        const counts = new Map<string, number>();
        for (let i = 0; i < 100; i++) {
            const fp = pickFingerprint(i);
            counts.set(fp, (counts.get(fp) ?? 0) + 1);
        }

        const chrome = counts.get('chrome') ?? 0;
        expect(chrome).toBeGreaterThanOrEqual(50);
        expect(counts.has('ios')).toBe(true);
        expect(counts.has('firefox')).toBe(true);
        expect(chrome).toBeGreaterThan(counts.get('ios') ?? 0);
        expect(chrome).toBeGreaterThan(counts.get('firefox') ?? 0);
    });
});
