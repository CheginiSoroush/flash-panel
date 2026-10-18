import { describe, it, expect, beforeAll, vi } from 'vitest';

// ---------- mock سوکت — قبل از import ماژول‌ها ----------
// رفتار بر اساس hostname: تأخیر مشخص + پاسخ سالم، یا مرده/خطا

const HOST_DELAY_MS: Record<string, number> = {
    // 30 (نه 5) — setTimeout(5) با ساعت درشت Date.now گاهی 4ms اندازه‌گیری می‌شد
    // و تست لاتنسی روی رانر سریع CI فِیکی می‌شد؛ 30ms حاشیه‌ی امن می‌دهد
    'fast.test': 30,
    'admin.test': 50,
    'slow.test': 100
};

const HEALTHY_BODY = 'HTTP/1.1 400 Bad Request\r\ncf-ray: 8abc\r\n\r\n';

vi.mock('cloudflare:sockets', () => ({
    connect: vi.fn(({ hostname }: { hostname: string; port: number }) => {
        if (!(hostname in HOST_DELAY_MS)) {
            throw new Error('simulated dead proxy');
        }

        const delay = HOST_DELAY_MS[hostname];
        const response = new Response(HEALTHY_BODY);

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

(globalThis as any).VERSION = '0.7.7';
(globalThis as any).EMBEDED_SETTINGS = {
    accID: 'test-acc',
    accEmail: 'test@example.com',
    apiToken: 'token',
    vlUUID: 'uuid',
    trPass: 'pass',
    securePath: 'sec',
    proxyIpMode: 'proxyip',
    proxyIPs: ['admin.test', 'fast.test', 'slow.test'],
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

let settingsMod: typeof import('../src/settings/settings');
let tunerMod: typeof import('../src/api/proxy-tuner');

beforeAll(async () => {
    settingsMod = await import('../src/settings/settings');
    tunerMod = await import('../src/api/proxy-tuner');

    // globalSettings واقعی — getGlobals/getEffectiveProxyIPs به آن وابسته‌اند
    settingsMod.init(new Request('https://fp.example.com/sec/sub/normal'), { kv: createKvMock().kv } as Env);
});

describe('tuneProxyIPs', () => {
    it('selects healthy fastest, writes top-3 into KV (autoProxyIPs)', async () => {
        const { kv, store, getPutCount } = createKvMock();
        // settings blob موجود — مستقیم در store (بدون احتساب در putCount)
        store.set('proxySettings', JSON.stringify({ panelVersion: '0.7.7', bypassIran: false }));

        const res = await tunerMod.tuneProxyIPs({ kv } as Env);

        expect(res.changed).toBe(true);
        expect(res.healthyCount).toBe(3); // فقط fast/admin/salem زنده‌اند
        expect(res.best).toBe('fast.test');
        expect(res.applied).toEqual(['fast.test', 'admin.test', 'slow.test']);

        const saved = JSON.parse(store.get('proxySettings')!);
        expect(saved.autoProxyIPs).toEqual(['fast.test', 'admin.test', 'slow.test']);
        expect(getPutCount()).toBe(1);
    });

    it('second run with same result → no write (idempotent)', async () => {
        const { kv, getPutCount } = createKvMock();
        await kv.put('proxySettings', JSON.stringify({ panelVersion: '0.7.7' }));

        await tunerMod.tuneProxyIPs({ kv } as Env);
        const putsAfterFirst = getPutCount();
        const second = await tunerMod.tuneProxyIPs({ kv } as Env);

        expect(second.changed).toBe(false);
        expect(getPutCount()).toBe(putsAfterFirst);
    });

    it('no healthy candidate → previous autoProxyIPs preserved, no write', async () => {
        const { kv, store } = createKvMock();
        await kv.put('proxySettings', JSON.stringify({ panelVersion: '0.7.7', autoProxyIPs: ['kept.test'] }));

        // همه‌ی کاندیداهای واقعی + استخر ادمین را مرده می‌کنیم
        const realCandidates = [...tunerMod.AUTO_PROXY_CANDIDATES];
        const backup = { ...HOST_DELAY_MS };
        for (const k of Object.keys(backup)) delete HOST_DELAY_MS[k];

        const res = await tunerMod.tuneProxyIPs({ kv } as Env);

        expect(res.healthyCount).toBe(0);
        expect(res.changed).toBe(false);
        expect(res.skipped).toContain('no healthy');
        const saved = JSON.parse(store.get('proxySettings')!);
        expect(saved.autoProxyIPs).toEqual(['kept.test']);

        Object.assign(HOST_DELAY_MS, backup);
        void realCandidates;
    });

    it('missing settings blob → skipped, no crash', async () => {
        const { kv } = createKvMock(); // خالی
        const res = await tunerMod.tuneProxyIPs({ kv } as Env);

        expect(res.changed).toBe(false);
        expect(res.skipped).toContain('settings blob missing');
        expect(res.best).toBe('fast.test');
    });
});

describe('autoProxyIPs data-path feed', () => {
    it('setAutoProxyIPs overrides admin list in getEffectiveProxyIPs', () => {
        // admin list از EMBEDED
        settingsMod.setAutoProxyIPs([]);
        expect(settingsMod.getEffectiveProxyIPs()).toEqual(['admin.test', 'fast.test', 'slow.test']);

        settingsMod.setAutoProxyIPs(['fast.test', 'admin.test']);
        expect(settingsMod.getEffectiveProxyIPs()).toEqual(['fast.test', 'admin.test']);
        expect(settingsMod.getAutoProxyIPs()).toEqual(['fast.test', 'admin.test']);
    });

    it('empty/garbage feed falls back to admin list', () => {
        settingsMod.setAutoProxyIPs([]);
        expect(settingsMod.getEffectiveProxyIPs()).toEqual(['admin.test', 'fast.test', 'slow.test']);

        settingsMod.setAutoProxyIPs(['ok.test', '', 42, null, 'clean.test'] as any);
        // فقط رشته‌های غیرخالی — ۴۲ و null حذف
        expect(settingsMod.getAutoProxyIPs()).toEqual(['ok.test', 'clean.test']);

        settingsMod.setAutoProxyIPs(undefined as any);
        expect(settingsMod.getAutoProxyIPs()).toEqual([]);
        expect(settingsMod.getEffectiveProxyIPs()).toEqual(['admin.test', 'fast.test', 'slow.test']);
    });
});

describe('proxy-check shared lib', () => {
    it('healthy target reports ok with latency', async () => {
        const check = await import('../src/api/proxy-check');
        const res = await check.checkProxyIP('fast.test');
        expect(res.ok).toBe(true);
        expect(res.elapsedMs).toBeGreaterThanOrEqual(5);
    });

    it('dead target reports not-ok without throwing', async () => {
        const check = await import('../src/api/proxy-check');
        const res = await check.checkProxyIP('dead.test');
        expect(res.ok).toBe(false);
    });

    it('batch sorts healthy-first then by latency', async () => {
        const check = await import('../src/api/proxy-check');
        const results = await check.runProxyIPBatchTest(['slow.test', 'dead.test', 'fast.test'], { attempts: 1 });
        expect(results.map(r => r.target)).toEqual(['fast.test', 'slow.test', 'dead.test']);
        expect(results[0].successRate).toBe('1/1');
    });
});
