import { describe, it, expect, beforeAll } from 'vitest';
import {
    isCloudflareEdgeIPv4,
    isValidCleanEntry,
    generateCleanCandidate
} from '../src/api/clean-ip';

// ---------- تست tuneCleanIPs نسخه‌ی v0.8.1 (اوراکل ساختاری) ----------
// v0.8.0 به پایین: تست سوکتی — از نظر ساختاری نادرست بود چون سوکت
// Worker → IP لبه‌ی CF در سطح پلتفرم cancel می‌شود (دیاگ زنده confirmed)
// و هیچ کاندیدایی هرگز تأیید نمی‌شد. حالا اوراکل = عضویت در رنج رسمی CF.

(globalThis as any).VERSION = '0.8.1';
(globalThis as any).EMBEDED_SETTINGS = {
    accID: 'test-acc',
    accEmail: 'test@example.com',
    apiToken: 'token',
    vlUUID: 'uuid',
    trPass: 'pass',
    securePath: 'sec',
    proxyIpMode: 'proxyip',
    proxyIPs: [],
    prefixes: [],
    forceProxyDomains: [],
    mainDomain: 'fp.example.com',
    fallback: '',
    dohUrl: ''
};

// ---------- KV mock ----------

function createKvMock() {
    const store = new Map<string, string>();
    let putCount = 0;
    const kv = {
        async get(key: string, opts?: { type?: string }) {
            const raw = store.get(key);
            if (raw === undefined) return null;
            return opts?.type === 'json' ? JSON.parse(raw) : raw;
        },
        async put(key: string, value: string) {
            putCount++;
            store.set(key, value);
        },
        async delete(key: string) {
            store.delete(key);
        }
    } as unknown as KVNamespace;

    return { kv, store, getPutCount: () => putCount };
}

let cleanTuner: typeof import('../src/api/clean-tuner');

beforeAll(async () => {
    cleanTuner = await import('../src/api/clean-tuner');
});

describe('CF edge range validation (reverse-engineered oracle)', () => {
    it('IPهای داخل رنج‌های رسمی CF → true', () => {
        for (const ip of ['104.16.160.3', '104.23.255.254', '104.24.1.2', '172.64.32.11', '172.71.255.254',
            '162.159.140.220', '108.162.229.1', '141.101.90.1', '188.114.97.1', '190.93.246.1',
            '103.21.244.5', '198.41.200.1', '173.245.48.9', '131.0.72.5']) {
            expect(isCloudflareEdgeIPv4(ip), ip).toBe(true);
        }
    });

    it('IPهای خارج رنج (Google/GCP/عمومی) → false', () => {
        for (const ip of ['142.250.108.165', '142.251.158.186', '35.190.22.67', '35.197.104.227',
            '34.149.9.231', '8.8.8.8', '1.1.1.1', '104.15.255.255', '172.72.0.1', '256.1.1.1']) {
            expect(isCloudflareEdgeIPv4(ip), ip).toBe(false);
        }
    });

    it('اعتبارسنجی ورودی: دامنه معتبر، IPv4 خارج رنج نامعتبر، خالی نامعتبر', () => {
        expect(isValidCleanEntry('www.speedtest.net')).toBe(true);
        expect(isValidCleanEntry('104.16.160.3')).toBe(true);
        expect(isValidCleanEntry('142.250.108.165')).toBe(false); // Google — قطعاً مرده برای کلاینت
        expect(isValidCleanEntry('')).toBe(false);
        expect(isValidCleanEntry('   ')).toBe(false);
    });

    it('کاندیدای تولیدی: قطعی، داخل رنج، برای ایندکس‌های متفاوت متمایز', () => {
        const day = 20700;
        expect(generateCleanCandidate(day, 0)).toBe(generateCleanCandidate(day, 0)); // قطعیت
        const seen = new Set<string>();
        for (let i = 0; i < 60; i++) {
            const ip = generateCleanCandidate(day, i);
            expect(isCloudflareEdgeIPv4(ip), ip).toBe(true);
            seen.add(ip);
        }
        expect(seen.size).toBeGreaterThan(50); // تنوع کافی
        expect(generateCleanCandidate(day, 0)).not.toBe(generateCleanCandidate(day + 1, 0)); // بذر روزانه
    });
});

describe('tuneCleanIPs (v0.8.1 — structural)', () => {
    it('سناریوی زنده: ۱۴ IP گوگل → جایگزینی با کاندیدای CF، حفظ اندازه، یک write', async () => {
        const { kv, store, getPutCount } = createKvMock();
        const googleIPs = ['142.250.108.165', '142.251.158.186', '142.250.192.215', '35.190.22.67',
            '35.201.70.107', '34.149.9.231', '173.194.113.18', '173.194.197.102', '142.251.46.128',
            '142.250.139.202', '142.250.19.128', '35.197.104.227', '142.251.14.155', '172.217.208.139'];
        store.set('proxySettings', JSON.stringify({ panelVersion: '0.8.0', cleanIPs: googleIPs }));

        const res = await cleanTuner.tuneCleanIPs({ kv } as Env);

        expect(res.changed).toBe(true);
        expect(res.applied).toHaveLength(14); // ۱:۱ — بدون کوچک‌شدن
        for (const entry of res.applied) {
            expect(isCloudflareEdgeIPv4(entry), entry).toBe(true);
            expect(googleIPs).not.toContain(entry);
        }
        expect(res.best).not.toBeNull();

        const saved = JSON.parse(store.get('proxySettings')!);
        expect(saved.cleanIPs).toEqual(res.applied);
        expect(getPutCount()).toBe(1);
    });

    it('لیست معتبر → دست‌نخورده، بدون write (idempotent)', async () => {
        const { kv, getPutCount } = createKvMock();
        await kv.put('proxySettings', JSON.stringify({
            panelVersion: '0.8.1',
            cleanIPs: ['104.16.160.3', 'www.speedtest.net', '172.67.68.4']
        }));

        const first = await cleanTuner.tuneCleanIPs({ kv } as Env);
        expect(first.changed).toBe(false);
        expect(first.applied).toEqual(['104.16.160.3', 'www.speedtest.net', '172.67.68.4']);
        expect(getPutCount()).toBe(1); // فقط put خود seed

        const second = await cleanTuner.tuneCleanIPs({ kv } as Env);
        expect(second.changed).toBe(false);
        expect(getPutCount()).toBe(1);
    });

    it('ترکیب معتبر/نامعتبر/محافظت‌شده → فقط نامعتبرها جایگزین می‌شوند', async () => {
        const { kv, store } = createKvMock();
        store.set('proxySettings', JSON.stringify({
            panelVersion: '0.8.1',
            cleanIPs: ['142.250.108.165', '104.16.160.3', '8.8.8.8', 'my.panel.example'],
            customCdnAddrs: [],
            customDomain: 'my.panel.example'
        }));

        const res = await cleanTuner.tuneCleanIPs({ kv } as Env);

        expect(res.changed).toBe(true);
        expect(res.applied).toContain('104.16.160.3');       // معتبر ماند
        expect(res.applied).toContain('my.panel.example');   // محافظت‌شده ماند
        expect(res.applied).toHaveLength(4);                 // ۱:۱
        for (const entry of res.applied) {
            // هیچ IP گوگل/غیر-CF باقی نمانده (دامنه‌ی محافظت‌شده مجاز)
            if (entry !== 'my.panel.example') expect(isCloudflareEdgeIPv4(entry), entry).toBe(true);
        }

        const saved = JSON.parse(store.get('proxySettings')!);
        expect(saved.cleanIPs).toEqual(res.applied);
    });

    it('لیست خالی → دخالت نمیکند (پیش‌فرض EMBEDED حاکم است)', async () => {
        const { kv, getPutCount } = createKvMock();
        await kv.put('proxySettings', JSON.stringify({ panelVersion: '0.8.1', cleanIPs: [] }));

        const res = await cleanTuner.tuneCleanIPs({ kv } as Env);

        expect(res.changed).toBe(false);
        expect(res.skipped).toContain('empty');
        expect(getPutCount()).toBe(1);
    });

    it('settings blob ناموجود → skipped بدون crash', async () => {
        const { kv } = createKvMock();
        const res = await cleanTuner.tuneCleanIPs({ kv } as Env);
        expect(res.changed).toBe(false);
        expect(res.skipped).toContain('settings blob missing');
    });

    it('همه‌ی ورودی‌ها محافظت‌شده → بدون write حتی اگر خارج رنج باشند', async () => {
        const { kv, getPutCount } = createKvMock();
        await kv.put('proxySettings', JSON.stringify({
            panelVersion: '0.8.1',
            cleanIPs: ['my.panel.example'],
            customDomain: 'my.panel.example'
        }));

        const res = await cleanTuner.tuneCleanIPs({ kv } as Env);
        expect(res.changed).toBe(false);
        expect(getPutCount()).toBe(1);
    });
});
