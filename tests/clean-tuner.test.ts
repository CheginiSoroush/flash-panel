import { describe, it, expect, beforeAll, vi } from 'vitest';

// ---------- mock سوکت — قبل از import ماژول‌ها (هم‌الگوی proxy-tuner.test) ----------
// host داخل HOST_HEALTH → پاسخ سالم (400 + cf-ray)؛ بقیه مرده

const HOST_HEALTH = new Set<string>();
const HOST_DELAY_MS: Record<string, number> = {
    '104.16.160.3': 5,
    '104.17.148.22': 50,
    'good1.test': 10
};

const HEALTHY_BODY = 'HTTP/1.1 400 Bad Request\r\ncf-ray: 8abc\r\n\r\n';

vi.mock('cloudflare:sockets', () => ({
    connect: vi.fn(({ hostname }: { hostname: string; port: number }) => {
        if (!HOST_HEALTH.has(hostname)) {
            throw new Error('simulated dead clean ip');
        }

        const delay = HOST_DELAY_MS[hostname] ?? 10;

        return {
            writable: {
                getWriter: () => ({
                    write: async () => { },
                    releaseLock: () => { }
                })
            },
            readable: {
                getReader: () => {
                    let read = false;
                    return {
                        read: async () => {
                            if (read) return { done: true, value: undefined };
                            read = true;
                            await new Promise(r => setTimeout(r, delay));
                            return { done: false, value: new TextEncoder().encode(HEALTHY_BODY) };
                        },
                        releaseLock: () => { }
                    };
                }
            },
            close: async () => { },
            opened: Promise.resolve(),
            closed: Promise.resolve()
        } as unknown as Socket;
    })
}));

(globalThis as any).VERSION = '0.7.9';
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

describe('tuneCleanIPs', () => {
    it('replaces dead current entries with fastest healthy candidates and writes KV', async () => {
        const { kv, store, getPutCount } = createKvMock();
        store.set('proxySettings', JSON.stringify({ panelVersion: '0.7.9', cleanIPs: ['good1.test', 'dead.test'] }));

        HOST_HEALTH.clear();
        HOST_HEALTH.add('good1.test');
        HOST_HEALTH.add('104.16.160.3');   // کاندیدای واقعی استخر — سریع‌ترین (5ms)
        HOST_HEALTH.add('104.17.148.22');  // کاندیدای واقعی استخر — کندتر (50ms)

        const res = await cleanTuner.tuneCleanIPs({ kv } as Env);

        expect(res.changed).toBe(true);
        expect(res.healthyCount).toBe(3);
        expect(res.best).toBe('104.16.160.3'); // سریع‌ترین کل استخر
        // dead.test حذف، good1.test حفظ، سریع‌ترین کاندیدا جایگزین (۱:۱ با اندازه‌ی فعلی)
        expect(res.applied).toEqual(['good1.test', '104.16.160.3']);

        const saved = JSON.parse(store.get('proxySettings')!);
        expect(saved.cleanIPs).toEqual(['good1.test', '104.16.160.3']);
        expect(getPutCount()).toBe(1);
    });

    it('all current healthy → list untouched, no write (minimal churn)', async () => {
        const { kv, getPutCount } = createKvMock();
        await kv.put('proxySettings', JSON.stringify({ panelVersion: '0.7.9', cleanIPs: ['good1.test'] }));

        HOST_HEALTH.clear();
        HOST_HEALTH.add('good1.test');

        const res = await cleanTuner.tuneCleanIPs({ kv } as Env);

        expect(res.changed).toBe(false);
        expect(res.applied).toEqual(['good1.test']);
        expect(res.best).toBe('good1.test');
    });

    it('protected entries (customCdnAddrs/customDomain) survive even if dead', async () => {
        const { kv, store } = createKvMock();
        store.set('proxySettings', JSON.stringify({
            panelVersion: '0.7.9',
            // ادمین ورودی‌های CDN شخصی را داخل cleanIPs هم گذاشته — tuner نباید حذفشان کند
            cleanIPs: ['dead.test', 'cdn.custom.example', 'my.panel.example'],
            customCdnAddrs: ['cdn.custom.example'],
            customDomain: 'my.panel.example'
        }));

        HOST_HEALTH.clear();
        HOST_HEALTH.add('104.16.160.3'); // فقط یک کاندیدای سالم خارج از current

        const res = await cleanTuner.tuneCleanIPs({ kv } as Env);

        expect(res.changed).toBe(true);
        // هر دو محافظت‌شده ماندند (بدون تست) + کاندیدای سالم جایگزین مرده
        // (kept+۱: دست‌کم یک clean-IP قابل‌تست سالم همیشه در لیست است)
        expect(res.applied).toEqual(['cdn.custom.example', 'my.panel.example', '104.16.160.3']);
        expect(res.applied).not.toContain('dead.test');

        const saved = JSON.parse(store.get('proxySettings')!);
        expect(saved.cleanIPs).toContain('cdn.custom.example');
    });

    it('no healthy candidate → previous list preserved, no write', async () => {
        const { kv, store, getPutCount } = createKvMock();
        await kv.put('proxySettings', JSON.stringify({ panelVersion: '0.7.9', cleanIPs: ['good1.test'] }));

        HOST_HEALTH.clear(); // همه مرده

        const res = await cleanTuner.tuneCleanIPs({ kv } as Env);

        expect(res.changed).toBe(false);
        expect(res.healthyCount).toBe(0);
        expect(res.skipped).toContain('no healthy');
        const saved = JSON.parse(store.get('proxySettings')!);
        expect(saved.cleanIPs).toEqual(['good1.test']);
        expect(getPutCount()).toBe(1); // فقط put خود seed
    });

    it('missing settings blob → skipped, no crash', async () => {
        const { kv } = createKvMock();
        const res = await cleanTuner.tuneCleanIPs({ kv } as Env);

        expect(res.changed).toBe(false);
        expect(res.skipped).toContain('settings blob missing');
    });

    it('second run with same healthy list → no write (idempotent)', async () => {
        const { kv, getPutCount } = createKvMock();
        await kv.put('proxySettings', JSON.stringify({ panelVersion: '0.7.9', cleanIPs: ['good1.test'] }));

        HOST_HEALTH.clear();
        HOST_HEALTH.add('good1.test');

        await cleanTuner.tuneCleanIPs({ kv } as Env);
        const putsAfterFirst = getPutCount();
        const second = await cleanTuner.tuneCleanIPs({ kv } as Env);

        expect(second.changed).toBe(false);
        expect(getPutCount()).toBe(putsAfterFirst);
    });
});
