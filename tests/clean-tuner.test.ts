import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import {
    isCloudflareEdgeIPv4,
    isValidCleanEntry,
    dayRankHash
} from '../src/api/clean-ip';

// ---------- تست tuneCleanIPs نسخه‌ی v0.8.2 (اوراکل دو لایه) ----------
// درس معکوس‌مهندسی زنده:
//   ۱) سوکت Worker → لبه‌ی CF پلتفرم cancel می‌کند → تست سوکتی (≤0.7.9) بی‌معنا
//   ۲) عضویت در رنج فقط «اعتبار» است، نه «زنده‌بودن» — از ۱۴ IP تصادفی داخل
//      رنج فقط ۴ تا واقعاً سرویس می‌دادند (dip زنده‌ی 2026-10-18)
// پس کاندیدا فقط از منابع «مشاهده‌پذیر زنده» می‌آیند: DoH دامنه‌های CF-fronted
// + fallback ثابتِ تأییدشده. هیچ IP حدسی نوشته نمی‌شود.

(globalThis as any).VERSION = '0.8.2';
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

// ---------- DoH mock ----------

function mockDoh(records: Record<string, string[]>, failAll = false) {
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
        if (failAll) throw new Error('doh down');
        const u = String(url);
        const m = u.match(/name=([^&]+)/);
        const host = m ? decodeURIComponent(m[1]) : '';
        const ips = records[host] ?? [];
        return {
            ok: true,
            json: async () => ({ Answer: ips.map(ip => ({ type: 1, data: ip })) })
        };
    }));
}

afterEach(() => {
    vi.unstubAllGlobals();
});

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

const GOOGLE_IPS = ['142.250.108.165', '142.251.158.186', '142.250.192.215', '35.190.22.67',
    '35.201.70.107', '34.149.9.231', '173.194.113.18', '173.194.197.102', '142.251.46.128',
    '142.250.139.202', '142.250.19.128', '35.197.104.227', '142.251.14.155', '172.217.208.139'];

const DOH_RECORDS: Record<string, string[]> = {
    'speed.cloudflare.com': ['162.159.140.220', '172.66.0.218'],
    'www.speedtest.net': ['104.17.147.22', '104.17.148.22'],
    'www.cloudflare.com': ['104.16.124.96', '104.16.123.96'],
    'cf.090227.xyz': ['172.67.172.155', '104.21.71.249'],
    'workers.dev': ['104.18.12.15', '104.18.13.15'],
    'pages.dev': ['104.18.20.135', '104.18.21.135']
};

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

    it('dayRankHash: قطعی، وابسته به روز، پخش‌شده', () => {
        expect(dayRankHash('104.16.160.3', 20700)).toBe(dayRankHash('104.16.160.3', 20700));
        expect(dayRankHash('104.16.160.3', 20700)).not.toBe(dayRankHash('104.16.160.3', 20701));
        const ranks = ['104.16.1.1', '104.17.2.2', '104.18.3.3'].map(ip => dayRankHash(ip, 20700));
        expect(new Set(ranks).size).toBe(3);
    });
});

describe('tuneCleanIPs (v0.8.2 — verified-live candidates)', () => {
    it('سناریوی زنده: ۱۴ IP گوگل → جایگزینی با کاندیدای DoH-زنده، حفظ اندازه، یک write', async () => {
        const { kv, store, getPutCount } = createKvMock();
        store.set('proxySettings', JSON.stringify({ panelVersion: '0.8.1', cleanIPs: GOOGLE_IPS }));
        mockDoh(DOH_RECORDS);

        const res = await cleanTuner.tuneCleanIPs({ kv } as Env);

        expect(res.changed).toBe(true);
        expect(res.applied).toHaveLength(14); // ۱:۱ — بدون کوچک‌شدن
        for (const entry of res.applied) {
            expect(isCloudflareEdgeIPv4(entry), entry).toBe(true);
            expect(GOOGLE_IPS).not.toContain(entry);
        }
        expect(res.skipped).toBeUndefined();

        const saved = JSON.parse(store.get('proxySettings')!);
        expect(saved.cleanIPs).toEqual(res.applied);
        expect(getPutCount()).toBe(1);
    });

    it('DoH پایین → fallback تأییدشده؛ کاندیدای کمتر از نیاز = جایگزینی جزئی بدون حدس', async () => {
        const { kv, store } = createKvMock();
        store.set('proxySettings', JSON.stringify({ panelVersion: '0.8.1', cleanIPs: GOOGLE_IPS }));
        mockDoh({}, true); // همه‌ی DoH ها reject

        const res = await cleanTuner.tuneCleanIPs({ kv } as Env);

        expect(res.changed).toBe(true);
        expect(res.applied).toHaveLength(14); // اندازه حفظ می‌شود
        const replaced = res.applied.filter(e => !GOOGLE_IPS.includes(e));
        const keptDead = res.applied.filter(e => GOOGLE_IPS.includes(e));
        // فقط fallback تأییدشده (۹ تا) — بدون اختراع IP
        expect(replaced.length).toBe(9);
        for (const ip of replaced) expect(isCloudflareEdgeIPv4(ip), ip).toBe(true);
        expect(keptDead.length).toBe(5); // باقیمانده‌ی مرده تا تیک بعدی (DoH زنده می‌شود)

        const saved = JSON.parse(store.get('proxySettings')!);
        expect(saved.cleanIPs).toEqual(res.applied);
    });

    it('لیست معتبر → دست‌نخورده، بدون write، بدون هیچ DoH (idempotent)', async () => {
        const { kv, getPutCount } = createKvMock();
        await kv.put('proxySettings', JSON.stringify({
            panelVersion: '0.8.2',
            cleanIPs: ['104.16.160.3', 'www.speedtest.net', '172.67.68.4']
        }));

        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);

        const first = await cleanTuner.tuneCleanIPs({ kv } as Env);
        expect(first.changed).toBe(false);
        expect(first.applied).toEqual(['104.16.160.3', 'www.speedtest.net', '172.67.68.4']);
        expect(fetchSpy).not.toHaveBeenCalled(); // مسیر سریع — DoH اصلاً صدا نمی‌خورد
        expect(getPutCount()).toBe(1); // فقط put خود seed

        const second = await cleanTuner.tuneCleanIPs({ kv } as Env);
        expect(second.changed).toBe(false);
        expect(getPutCount()).toBe(1);
    });

    it('ترکیب معتبر/نامعتبر/محافظت‌شده → فقط نامعتبرها با کاندیدای زنده جایگزین می‌شوند', async () => {
        const { kv, store } = createKvMock();
        store.set('proxySettings', JSON.stringify({
            panelVersion: '0.8.2',
            cleanIPs: ['142.250.108.165', '104.16.160.3', '8.8.8.8', 'my.panel.example'],
            customCdnAddrs: [],
            customDomain: 'my.panel.example'
        }));
        mockDoh(DOH_RECORDS);

        const res = await cleanTuner.tuneCleanIPs({ kv } as Env);

        expect(res.changed).toBe(true);
        expect(res.applied).toContain('104.16.160.3');       // معتبر ماند
        expect(res.applied).toContain('my.panel.example');   // محافظت‌شده ماند
        expect(res.applied).toHaveLength(4);                 // ۱:۱
        for (const entry of res.applied) {
            if (entry !== 'my.panel.example') expect(isCloudflareEdgeIPv4(entry), entry).toBe(true);
        }
    });

    it('mainDomain blob هم در منابع DoH پرسیده می‌شود', async () => {
        const { kv } = createKvMock();
        await kv.put('proxySettings', JSON.stringify({
            panelVersion: '0.8.2',
            cleanIPs: ['142.250.108.165'],
            mainDomain: 'fp.example.com'
        }));

        const seenHosts: string[] = [];
        vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
            const m = String(url).match(/name=([^&]+)/);
            if (m) seenHosts.push(decodeURIComponent(m[1]));
            return {
                ok: true,
                json: async () => ({ Answer: [{ type: 1, data: '104.18.99.7' }] })
            };
        }));

        const res = await cleanTuner.tuneCleanIPs({ kv } as Env);
        expect(res.changed).toBe(true);
        expect(seenHosts).toContain('fp.example.com');
        expect(res.applied).toEqual(['104.18.99.7']);
    });

    it('لیست خالی → دخالت نمیکند (پیش‌فرض EMBEDED حاکم است)', async () => {
        const { kv, getPutCount } = createKvMock();
        await kv.put('proxySettings', JSON.stringify({ panelVersion: '0.8.2', cleanIPs: [] }));

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
            panelVersion: '0.8.2',
            cleanIPs: ['my.panel.example'],
            customDomain: 'my.panel.example'
        }));

        const res = await cleanTuner.tuneCleanIPs({ kv } as Env);
        expect(res.changed).toBe(false);
        expect(getPutCount()).toBe(1);
    });
});
