import { describe, it, expect, afterEach, vi } from 'vitest';

(globalThis as any).VERSION = '0.8.4';

function createKvMock() {
    const store = new Map<string, string>();
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

function fakeRequest(cf: Record<string, unknown> | undefined): Request {
    const req = new Request('https://fp.imsoroush.top/x/sub/normal?app=xray');
    if (cf !== undefined) (req as any).cf = cf;
    return req;
}

function fakeCtx(): { ctx: ExecutionContext; awaited: () => Promise<void> } {
    const holder: { p: Promise<unknown> | null } = { p: null };
    const ctx = {
        waitUntil(p: Promise<unknown>) { holder.p = p; },
        passThroughOnException() {}
    } as unknown as ExecutionContext;
    return {
        ctx,
        awaited: async () => {
            if (holder.p) await holder.p;
        }
    };
}

const FULL_CF = {
    colo: 'FRA',
    clientTcpRtt: 42,
    asn: 58224,
    asOrganization: 'TIC IR-AS TIC',
    country: 'DE',
    tlsVersion: 'TLSv1.3',
    httpProtocol: 'HTTP/2'
};

afterEach(() => {
    vi.resetModules();
});

// ---------- extractEdgeSample ----------

describe('extractEdgeSample', () => {
    it('extracts colo/asn/rtt from a full request.cf', async () => {
        const { extractEdgeSample } = await import('../src/settings/edge-telemetry');
        const s = extractEdgeSample(fakeRequest(FULL_CF), 'ws');
        expect(s).not.toBeNull();
        expect(s!.colo).toBe('FRA');
        expect(s!.rtt).toBe(42);
        expect(s!.asn).toBe('58224 TIC');
        expect(s!.ws).toBe(true);
    });

    it('returns null without request.cf or without colo', async () => {
        const { extractEdgeSample } = await import('../src/settings/edge-telemetry');
        expect(extractEdgeSample(fakeRequest(undefined), 'http')).toBeNull();
        expect(extractEdgeSample(fakeRequest({ asn: 123 }), 'http')).toBeNull();
    });

    it('tolerates garbage rtt and missing org', async () => {
        const { extractEdgeSample } = await import('../src/settings/edge-telemetry');
        const s = extractEdgeSample(fakeRequest({ colo: 'IST', clientTcpRtt: 'garbage', asn: 44244 }), 'http');
        expect(s!.rtt).toBeUndefined();
        expect(s!.asn).toBe('44244');
    });
});

// ---------- recordEdgeSample + flush ----------

describe('recordEdgeSample / flushSamples', () => {
    it('buffers and flushes through waitUntil (ws sampled always)', async () => {
        const mod = await import('../src/settings/edge-telemetry');
        mod._resetEdgeTelemetryForTest();
        mod._setHttpSampleRate(0); // HTTP را کلاً قطع کن — فقط WS

        const { kv, store } = createKvMock();
        const env = { kv } as unknown as Env;
        const { ctx, awaited } = fakeCtx();

        for (let i = 0; i < 12; i++) {
            mod.recordEdgeSample(fakeRequest(FULL_CF), env, ctx, 'ws');
        }
        // بافر پر شد → flush از مسیر waitUntil
        await awaited();

        const blob = JSON.parse(store.get('edgeTelemetry')!);
        const today = new Date().toISOString().slice(0, 10);
        expect(blob.days[today].colos.FRA.n).toBe(12);
        expect(blob.days[today].colos.FRA.ws).toBe(12);
        expect(blob.days[today].asns['58224 TIC'].n).toBe(12);
        // میانگین RTT
        expect(blob.days[today].colos.FRA.rttSum).toBe(42 * 12);
    });

    it('http sampling respects the rate (0 = never)', async () => {
        const mod = await import('../src/settings/edge-telemetry');
        mod._resetEdgeTelemetryForTest();
        mod._setHttpSampleRate(0);

        const { kv } = createKvMock();
        const env = { kv } as unknown as Env;
        const { ctx } = fakeCtx();

        for (let i = 0; i < 30; i++) {
            mod.recordEdgeSample(fakeRequest(FULL_CF), env, ctx, 'http');
        }
        await mod._flushNow(env);
        const telemetry = await mod.getEdgeTelemetry(env);
        expect(telemetry?.days).toBeUndefined(); // هیچ نمونه‌ای ثبت نشده
    });

    it('http sampling with rate 1 records everything', async () => {
        const mod = await import('../src/settings/edge-telemetry');
        mod._resetEdgeTelemetryForTest();
        mod._setHttpSampleRate(1);

        const { kv, store } = createKvMock();
        const env = { kv } as unknown as Env;
        const { ctx } = fakeCtx();

        for (let i = 0; i < 5; i++) {
            mod.recordEdgeSample(fakeRequest(FULL_CF), env, ctx, 'http');
        }
        await mod._flushNow(env);
        const blob = JSON.parse(store.get('edgeTelemetry')!);
        const today = new Date().toISOString().slice(0, 10);
        expect(blob.days[today].total).toBe(5);
        expect(blob.days[today].colos.FRA.ws).toBe(0); // http — نه ws
    });

    it('never throws when request has no cf (tests/scheduled)', async () => {
        const mod = await import('../src/settings/edge-telemetry');
        mod._resetEdgeTelemetryForTest();

        const { kv } = createKvMock();
        const env = { kv } as unknown as Env;
        const { ctx } = fakeCtx();

        expect(() => mod.recordEdgeSample(fakeRequest(undefined), env, ctx, 'http')).not.toThrow();
    });

    it('prunes old days and keeps only the last two', async () => {
        const mod = await import('../src/settings/edge-telemetry');
        mod._resetEdgeTelemetryForTest();

        const { kv, store } = createKvMock();
        const env = { kv } as unknown as Env;

        // دو روز قدیمی + امروز بکار
        const old1 = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
        const old2 = new Date(Date.now() - 1 * 86_400_000).toISOString().slice(0, 10);
        const today = new Date().toISOString().slice(0, 10);
        await kv.put('edgeTelemetry', JSON.stringify({
            days: {
                [old1]: { date: old1, colos: { MRS: { n: 9, rttSum: 900, rttMax: 200, ws: 3 } }, asns: {}, total: 9, updatedAt: 1 },
                [old2]: { date: old2, colos: { HKG: { n: 5, rttSum: 400, rttMax: 100, ws: 5 } }, asns: {}, total: 5, updatedAt: 2 }
            }
        }));

        mod.recordEdgeSample(fakeRequest({ ...FULL_CF, colo: 'FRA' }), env, fakeCtx().ctx, 'ws');
        await mod._flushNow(env);

        const blob = JSON.parse(store.get('edgeTelemetry')!);
        expect(Object.keys(blob.days)).toContain(today);
        expect(Object.keys(blob.days).length).toBeLessThanOrEqual(2);
        expect(blob.days[today].colos.FRA).toBeDefined();
    });

    it('stops writing after the daily sample cap', async () => {
        const mod = await import('../src/settings/edge-telemetry');
        mod._resetEdgeTelemetryForTest();

        const { kv, store } = createKvMock();
        const env = { kv } as unknown as Env;

        const today = new Date().toISOString().slice(0, 10);
        await kv.put('edgeTelemetry', JSON.stringify({
            days: { [today]: { date: today, colos: {}, asns: {}, total: 2000, updatedAt: 9 } }
        }));

        mod.recordEdgeSample(fakeRequest(FULL_CF), env, fakeCtx().ctx, 'ws');
        await mod._flushNow(env);

        const blob = JSON.parse(store.get('edgeTelemetry')!);
        expect(blob.days[today].total).toBe(2000); // drop شد — سقف
        expect(blob.dropped).toBe(true);
    });
});

// ---------- نمایش ----------

describe('buildEdgeSummary / buildEdgeText', () => {
    it('returns null for empty telemetry', async () => {
        const { buildEdgeSummary } = await import('../src/settings/edge-telemetry');
        expect(buildEdgeSummary(null)).toBeNull();
        expect(buildEdgeSummary({ days: {} })).toBeNull();
    });

    it('builds a one-line summary across days', async () => {
        const { buildEdgeSummary } = await import('../src/settings/edge-telemetry');
        const s = buildEdgeSummary({
            days: {
                '2026-10-18': { date: 'x', colos: { FRA: { n: 10, rttSum: 420, rttMax: 90, ws: 8 } }, asns: {}, total: 10, updatedAt: 1 },
                '2026-10-17': { date: 'x', colos: { FRA: { n: 5, rttSum: 300, rttMax: 120, ws: 5 } }, asns: {}, total: 5, updatedAt: 2 }
            }
        });
        expect(s).toContain('FRA');
        expect(s).toContain('48ms');   // (420+300)/15 = 48
        expect(s).toContain('samples 15');
    });

    it('buildEdgeText renders colo + ISP sections and hints', async () => {
        const { buildEdgeText } = await import('../src/settings/edge-telemetry');
        const text = buildEdgeText({
            days: {
                '2026-10-18': {
                    date: 'x',
                    colos: { FRA: { n: 12, rttSum: 504, rttMax: 90, ws: 12 } },
                    asns: { '58224 TIC': { n: 12, rttSum: 504, rttMax: 90, ws: 12 } },
                    total: 12, updatedAt: 1
                }
            }
        });
        expect(text).toContain('Edge Telemetry');
        expect(text).toContain('FRA');
        expect(text).toContain('58224 TIC');
        expect(text).toContain('42ms'); // 504/12
        expect(text).toContain('cdn-cgi/trace');
    });

    it('buildEdgeText stays friendly when nothing is recorded yet', async () => {
        const { buildEdgeText } = await import('../src/settings/edge-telemetry');
        const text = buildEdgeText(null);
        expect(text).toContain('No samples yet');
        expect(text).toContain('request.cf');
    });
});
