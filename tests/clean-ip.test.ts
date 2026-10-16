import { describe, expect, it } from 'vitest';
import {
    buildSubUserInfoHeader,
    extractCandidates,
    isValidEndpoint,
    rankResults,
    reorderCleanIPs,
    EndpointTestResult
} from '../src/api/clean-ip';

describe('Clean IP engine — extractCandidates', () => {
    it('استخراج IP و دامنه از متن خام با جداکننده‌های متنوع', () => {
        const raw = `
104.16.0.1, 104.16.0.2
"172.64.32.1"; 172.64.32.2
speed.cloudflare.com
    www.visa.com.sg
        junk!text
        `;

        const candidates = extractCandidates(raw);
        expect(candidates).toContain('104.16.0.1');
        expect(candidates).toContain('104.16.0.2');
        expect(candidates).toContain('172.64.32.1');
        expect(candidates).toContain('172.64.32.2');
        expect(candidates).toContain('speed.cloudflare.com');
        expect(candidates).toContain('www.visa.com.sg');
        expect(candidates.some(c => c.includes('!'))).toBe(false);
    });

    it('پسوند پورت :443/:80 حذف ولی پورت‌های عجیب رد می‌شوند', () => {
        const candidates = extractCandidates('104.16.0.1:443 104.16.0.2:8443 104.16.0.3:80');
        expect(candidates).toEqual(['104.16.0.1', '104.16.0.3']);
    });

    it('تکراری‌ها حذف و سقف تعداد رعایت می‌شود', () => {
        const raw = Array.from({ length: 30 }, (_, i) => `104.16.0.${i % 5}`).join('\n');
        const candidates = extractCandidates(raw, 3);
        expect(candidates).toHaveLength(3);
        expect(new Set(candidates).size).toBe(3);
    });

    it('ورودی خالی/بی‌معنی → خالی', () => {
        expect(extractCandidates('')).toEqual([]);
        expect(extractCandidates('   \n\t  ')).toEqual([]);
        expect(extractCandidates('999.999.999.999 not-an-ip!!')).toEqual([]);
    });

    it('isValidEndpoint مرزهای اعتبارسنجی', () => {
        expect(isValidEndpoint('1.2.3.4')).toBe(true);
        expect(isValidEndpoint('speed.cloudflare.com')).toBe(true);
        expect(isValidEndpoint('[2606:4700::6810:1]')).toBe(true);
        expect(isValidEndpoint('1.2.3.256')).toBe(false);
        expect(isValidEndpoint('-bad-.domain')).toBe(false);
        expect(isValidEndpoint('')).toBe(false);
    });
});

describe('Clean IP engine — rankResults', () => {
    const r = (target: string, ok: boolean, avgLatencyMs: number | null): EndpointTestResult =>
        ({ target, ok, successRate: ok ? '2/2' : '0/2', avgLatencyMs });

    it('سالم‌ها اول، بعد سریع‌ترین', () => {
        const ranked = rankResults([
            r('slow', true, 900),
            r('dead', false, null),
            r('fast', true, 120),
            r('mid', true, 400)
        ]);

        expect(ranked.map(x => x.target)).toEqual(['fast', 'mid', 'slow', 'dead']);
    });

    it('در خطاها، سریع‌ترین شکست (رد صریح) قبل از timeout', () => {
        const ranked = rankResults([
            r('timeout', false, null),
            r('refused', false, 80)
        ]);
        expect(ranked.map(x => x.target)).toEqual(['refused', 'timeout']);
    });

    it('ورودی اصلی mutation نمی‌شود', () => {
        const input = [r('a', true, 100), r('b', true, 50)];
        rankResults(input);
        expect(input[0].target).toBe('a');
    });
});

describe('Clean IP engine — reorderCleanIPs', () => {
    const r = (target: string, ok: boolean, avgLatencyMs: number | null): EndpointTestResult =>
        ({ target, ok, successRate: ok ? '1/1' : '0/1', avgLatencyMs });

    it('سالم‌های فعلی بر اساس تأخیر در رأس، نام‌سالم‌ها حفظ می‌شوند', () => {
        const outcome = reorderCleanIPs(
            ['slow', 'dead', 'fast'],
            [r('fast', true, 100), r('slow', true, 800), r('dead', false, null)],
            [],
        );

        expect(outcome.list).toEqual(['fast', 'slow', 'dead']);
        expect(outcome.added).toEqual([]);
        expect(outcome.applied).toBe(true);
    });

    it('کاندیدای کشف‌شده‌ی سالم جدید اضافه می‌شود (تا سقف maxAdd و cap)', () => {
        const outcome = reorderCleanIPs(
            ['dead'],
            [r('dead', false, null)],
            [r('new1', true, 90), r('new2', true, 110), r('new3', true, 130)],
            { cap: 10, maxAdd: 2 }
        );

        expect(outcome.list).toEqual(['dead', 'new1', 'new2']);
        expect(outcome.added).toEqual(['new1', 'new2']);
        expect(outcome.applied).toBe(true);
    });

    it('سقف کل لیست رعایت می‌شود', () => {
        const current = ['a', 'b'];
        const results = [r('a', true, 10), r('b', true, 20)];
        const discovered = [r('c', true, 30), r('d', true, 40), r('e', true, 50)];

        const outcome = reorderCleanIPs(current, results, discovered, { cap: 3, maxAdd: 5 });
        expect(outcome.list).toEqual(['a', 'b', 'c']);
        expect(outcome.added).toEqual(['c']);
    });

    it('idempotent — لیست بهینه‌شده‌ی فعلی → applied=false', () => {
        const outcome = reorderCleanIPs(
            ['fast', 'slow'],
            [r('fast', true, 100), r('slow', true, 800)],
            []
        );

        expect(outcome.list).toEqual(['fast', 'slow']);
        expect(outcome.applied).toBe(false);
        expect(outcome.added).toEqual([]);
    });

    it('تکراری‌های ورودی و مقادیر خالی پاک‌سازی می‌شوند', () => {
        const outcome = reorderCleanIPs(
            ['fast', 'fast', ''],
            [r('fast', true, 100)],
            []
        );

        expect(outcome.list).toEqual(['fast']);
        expect(outcome.applied).toBe(true);
    });

    it('کاندیدای کشف‌شده که از قبل در لیست است دوباره اضافه نمی‌شود', () => {
        const outcome = reorderCleanIPs(
            ['existing'],
            [r('existing', true, 100)],
            [r('existing', true, 100), r('fresh', true, 120)]
        );

        expect(outcome.list).toEqual(['existing', 'fresh']);
        expect(outcome.added).toEqual(['fresh']);
    });
});

describe('Clean IP engine — buildSubUserInfoHeader', () => {
    it('با انقضا — expire به ثانیه تبدیل می‌شود', () => {
        const header = buildSubUserInfoHeader({ expireMs: 1_735_689_600_000 });
        expect(header).toBe('upload=0; download=0; expire=1735689600');
    });

    it('با سهمیه — total درج می‌شود', () => {
        const header = buildSubUserInfoHeader({
            expireMs: 1_735_689_600_000,
            totalBytes: 100_000,
            usedBytes: 25_000
        });
        expect(header).toBe('upload=0; download=25000; total=100000; expire=1735689600');
    });

    it('بدون انقضا — null (هدر ست نمی‌شود)', () => {
        expect(buildSubUserInfoHeader({})).toBeNull();
        expect(buildSubUserInfoHeader({ expireMs: null })).toBeNull();
        expect(buildSubUserInfoHeader({ expireMs: 0 })).toBeNull();
        expect(buildSubUserInfoHeader({ expireMs: Number.NaN })).toBeNull();
    });
});
