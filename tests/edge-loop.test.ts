import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';

/**
 * تست‌های حلقه‌ی بسته‌ی هوش لبه (v0.8.5):
 *  ۱) ws-metrics — شمارش بایت up/down + مدت اتصال (WeakMap، idempotent)
 *  ۲) edge-telemetry — تجمیع ترافیک در KV + نمایش انسانی (formatBytes/summary)
 *  ۳) edge-tuner — تشخیص RTT-spike → trigger tuner + هشدار + cooldown + EMA
 *
 * همه‌ی ماژول‌های شبکه‌دار (tuners / broadcast) mock می‌شوند — تست کاملاً هرمتیک.
 */

(globalThis as any).EMBEDED_SETTINGS = {
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
(globalThis as any).VERSION = '0.8.5';

// ---------- tuner ها و broadcast mock (قبل از ایمپورت edge-tuner) ----------

vi.mock('../src/api/proxy-tuner', () => ({
    tuneProxyIPs: vi.fn(async () => ({ poolSize: 3, healthyCount: 3, applied: ['1.1.1.1'], best: '1.1.1.1', changed: false }))
}));

vi.mock('../src/api/clean-tuner', () => ({
    tuneCleanIPs: vi.fn(async () => ({ poolSize: 2, healthyCount: 2, applied: ['1.0.0.1'], best: '1.0.0.1', changed: false }))
}));

vi.mock('../src/api/telegram-broadcast', () => ({
    escapeHtml: (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
}));

// ---------- KV mock ----------

function createKvMock(seed: Record<string, string> = {}) {
    const store = new Map<string, string>(Object.entries(seed));
    const failing = { fail: false };
    const kv = {
        async get(key: string, opts?: { type?: string }) {
            if (failing.fail) throw new Error('kv down');
            const raw = store.get(key);
            if (raw === undefined) return null;
            return opts?.type === 'json' ? JSON.parse(raw) : raw;
        },
        async put(key: string, value: string) {
            if (failing.fail) throw new Error('kv down');
            store.set(key, value);
        },
        async delete(key: string) {
            if (failing.fail) throw new Error('kv down');
            store.delete(key);
        }
    } as unknown as KVNamespace;
    return { kv, store, failing };
}

function fakeRequest(cf: Record<string, unknown>): Request {
    const req = new Request('https://fp.imsoroush.top/x/vl/sp');
    (req as any).cf = cf;
    return req;
}

function fakeCtx(): ExecutionContext {
    return { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
}

const CF = { colo: 'FRA', clientTcpRtt: 42, asn: 58224, asOrganization: 'TIC IR-AS TIC' };

afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
});

// ---------- ۱) ws-metrics ----------

describe('ws-metrics — چرخه‌ی عمر اتصال', () => {
    it('begin → count → end مجموع بایت‌ها و مدت را می‌دهد', async () => {
        const { beginWsMetrics, countWsUp, countWsDown, endWsMetrics } = await import('../src/protocols/ws-metrics');
        const ws = { fake: true } as unknown as WebSocket;

        beginWsMetrics(ws);
        countWsUp(ws, 1024);
        countWsUp(ws, 512);
        countWsDown(ws, 4096);
        countWsDown(ws, 8);
        // صفر و منفی نادیده گرفته می‌شوند
        countWsUp(ws, 0);
        countWsDown(ws, -5);

        const t = endWsMetrics(ws);
        expect(t).not.toBeNull();
        expect(t!.up).toBe(1536);
        expect(t!.down).toBe(4104);
        expect(t!.durMs).toBeGreaterThanOrEqual(0);
    });

    it('end idempotent است — دوباره null (روی close+error دوباره نمونه نمی‌سازد)', async () => {
        const { beginWsMetrics, countWsUp, endWsMetrics } = await import('../src/protocols/ws-metrics');
        const ws = {} as WebSocket;

        beginWsMetrics(ws);
        countWsUp(ws, 10);
        expect(endWsMetrics(ws)).not.toBeNull();
        expect(endWsMetrics(ws)).toBeNull();
        // بدون begin هم امن
        expect(endWsMetrics({} as WebSocket)).toBeNull();
    });

    it('شمارش بدون begin بی‌صدا نادیده می‌شود و هرگز throw نمی‌کند', async () => {
        const { countWsUp, countWsDown } = await import('../src/protocols/ws-metrics');
        const ghost = {} as WebSocket;
        expect(() => countWsUp(ghost, 100)).not.toThrow();
        expect(() => countWsDown(ghost, 100)).not.toThrow();
    });
});

// ---------- ۲) تلمتری ترافیک ----------

describe('edge-telemetry — تجمیع ترافیک', () => {
    it('نمونه‌ی close با بایت‌ها → upSum/downSum در KV', async () => {
        const mock = createKvMock();
        const { recordEdgeSample, _flushNow, getEdgeTelemetry, getTrafficTotals } =
            await import('../src/settings/edge-telemetry');

        const env = { kv: mock.kv } as unknown as Env;
        const ctx = fakeCtx();

        recordEdgeSample(fakeRequest(CF), env, ctx, 'ws', { up: 1024, down: 1_000_000 });
        recordEdgeSample(fakeRequest({ ...CF, colo: 'IST' }), env, ctx, 'ws', { up: 2048, down: 2_500_000 });
        await _flushNow(env);

        const telemetry = await getEdgeTelemetry(env);
        expect(telemetry).not.toBeNull();
        const day = Object.values(telemetry!.days)[0];
        expect(day.total).toBe(2);

        const fra = day.colos['FRA'];
        expect(fra.upSum).toBe(1024);
        expect(fra.downSum).toBe(1_000_000);
        expect(fra.ws).toBe(1);

        const totals = getTrafficTotals(telemetry);
        expect(totals.up).toBe(3072);
        expect(totals.down).toBe(3_500_000);
    });

    it('traffic نامعتبر (منفی/غیرعددی) نادیده می‌شود', async () => {
        const mock = createKvMock();
        const { recordEdgeSample, _flushNow, getEdgeTelemetry } = await import('../src/settings/edge-telemetry');
        const env = { kv: mock.kv } as unknown as Env;

        recordEdgeSample(fakeRequest(CF), env, fakeCtx(), 'ws', { up: -5, down: undefined as unknown as number });
        await _flushNow(env);

        const telemetry = await getEdgeTelemetry(env);
        const day = Object.values(telemetry!.days)[0];
        expect(day.colos['FRA'].upSum).toBe(0);
        expect(day.colos['FRA'].downSum).toBe(0);
    });

    it('formatBytes واحدهای انسانی درست می‌دهد', async () => {
        const { formatBytes } = await import('../src/settings/edge-telemetry');
        expect(formatBytes(0)).toBe('0 B');
        expect(formatBytes(512)).toBe('512 B');
        expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
        expect(formatBytes(1536 * 1024 * 1024)).toBe('1.5 GB');
        expect(formatBytes(3_500_000)).toBe('3.3 MB');
    });

    it('buildEdgeSummary و buildEdgeText ترافیک را نشان می‌دهند', async () => {
        const mock = createKvMock();
        const { recordEdgeSample, _flushNow, getEdgeTelemetry, buildEdgeSummary, buildEdgeText } =
            await import('../src/settings/edge-telemetry');
        const env = { kv: mock.kv } as unknown as Env;

        recordEdgeSample(fakeRequest(CF), env, fakeCtx(), 'ws', { up: 1024, down: 3_500_000 });
        await _flushNow(env);

        const telemetry = await getEdgeTelemetry(env);
        const summary = buildEdgeSummary(telemetry);
        expect(summary).toContain('FRA');
        expect(summary).toContain('3.3 MB');

        const text = buildEdgeText(telemetry);
        expect(text).toContain('Traffic (observed)');
        expect(text).toContain('↓ 3.3 MB');
    });
});

// ---------- ۳) Edge-Tuner ----------

/** ساخت یک EdgeDay با نمونه‌های RTT یکنواخت روی یک colo + چند ASN */
function makeDay(now: number, rttPerSample: number, samples: number, asn?: string): string {
    const today = new Date(now).toISOString().slice(0, 10);
    const day = {
        date: today,
        colos: { FRA: { n: samples, rttSum: rttPerSample * samples, rttMax: rttPerSample, ws: samples, upSum: 0, downSum: 4096 } },
        asns: {
            [asn ?? '58224 TIC']: { n: samples, rttSum: rttPerSample * samples, rttMax: rttPerSample, ws: samples, upSum: 0, downSum: 4096 }
        },
        total: samples,
        updatedAt: now
    };
    return JSON.stringify({ days: { [today]: day } });
}

describe('edge-tuner — حلقه‌ی بسته', () => {
    it('بدون داده → no-data', async () => {
        const mock = createKvMock();
        const { runEdgeTuner } = await import('../src/api/edge-tuner');
        const result = await runEdgeTuner({ kv: mock.kv } as unknown as Env, null, 1_700_000_000_000);
        expect(result.status).toBe('no-data');
    });

    it('نمونه‌ی ناکافی → insufficient (تصمیم ناپایدار نمی‌گیرد)', async () => {
        const now = 1_700_000_000_000;
        const mock = createKvMock({ edgeTelemetry: makeDay(now, 60, 5) });
        const { runEdgeTuner } = await import('../src/api/edge-tuner');
        const result = await runEdgeTuner({ kv: mock.kv } as unknown as Env, null, now);
        expect(result.status).toBe('insufficient');
        expect(result.rttSamples).toBe(5);
    });

    it('اولین مشاهده → baseline-set (بدون هشدار و بدون tuner)', async () => {
        const now = 1_700_000_000_000;
        const mock = createKvMock({ edgeTelemetry: makeDay(now, 60, 12) });
        const { runEdgeTuner } = await import('../src/api/edge-tuner');
        const notify = vi.fn(async () => {});
        const result = await runEdgeTuner({ kv: mock.kv } as unknown as Env, notify, now);

        expect(result.status).toBe('baseline-set');
        expect(result.baselineRtt).toBe(60);
        expect(notify).not.toHaveBeenCalled();
        const { tuneProxyIPs } = await import('../src/api/proxy-tuner');
        expect(tuneProxyIPs).not.toHaveBeenCalled();
    });

    it('جهش واقعی → spike + هشدار + trigger هر دو tuner', async () => {
        const now = 1_700_000_000_000;
        // baseline 100 از دور قبل، امروز 180 (+80 مطلق، 1.8× نسبی)
        const state = JSON.stringify({ baselineRtt: 100, baselineDate: '2023-11-13' });
        const today = new Date(now).toISOString().slice(0, 10);
        const mock = createKvMock({
            edgeTelemetry: makeDay(now, 180, 12, '44344 IRSEL'),
            edgeTunerState: state
        });
        const { runEdgeTuner } = await import('../src/api/edge-tuner');
        const notify = vi.fn(async () => {});
        const result = await runEdgeTuner({ kv: mock.kv } as unknown as Env, notify, now);

        expect(result.status).toBe('spike');
        expect(result.todayAvgRtt).toBe(180);
        expect(result.baselineRtt).toBe(100);
        expect(result.tuned).toBe(true);
        expect(result.spikeAsns).toContain('44344 IRSEL');
        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify.mock.calls[0][0]).toContain('RTT Spike');
        expect(notify.mock.calls[0][0]).toContain('44344 IRSEL');

        const { tuneProxyIPs } = await import('../src/api/proxy-tuner');
        const { tuneCleanIPs } = await import('../src/api/clean-tuner');
        expect(tuneProxyIPs).toHaveBeenCalledTimes(1);
        expect(tuneCleanIPs).toHaveBeenCalledTimes(1);

        // cooldown ثبت شد
        const saved = JSON.parse(mock.store.get('edgeTunerState')!);
        expect(saved.lastTuneAt).toBe(now);
        expect(saved.baselineDate).toBe(today);
    });

    it('cooldown — جهش پشت‌سرهم در بازه‌ی ۶ ساعت دوباره tuner بیدار نمی‌کند', async () => {
        const now = 1_700_000_000_000;
        const state = JSON.stringify({ baselineRtt: 100, baselineDate: new Date(now).toISOString().slice(0, 10), lastTuneAt: now - 60_000 });
        const mock = createKvMock({
            edgeTelemetry: makeDay(now, 180, 12),
            edgeTunerState: state
        });
        const { runEdgeTuner } = await import('../src/api/edge-tuner');
        const notify = vi.fn(async () => {});
        const result = await runEdgeTuner({ kv: mock.kv } as unknown as Env, notify, now);

        expect(result.status).toBe('ok');
        const { tuneProxyIPs } = await import('../src/api/proxy-tuner');
        expect(tuneProxyIPs).not.toHaveBeenCalled();
        expect(notify).not.toHaveBeenCalled();
    });

    it('بدون جهش → ok + blend روزانه‌ی EMA (۸۵/۱۵)', async () => {
        const now = 1_700_000_000_000;
        const state = JSON.stringify({ baselineRtt: 100, baselineDate: '2023-11-13' });
        const mock = createKvMock({
            edgeTelemetry: makeDay(now, 60, 12),
            edgeTunerState: state
        });
        const { runEdgeTuner } = await import('../src/api/edge-tuner');
        const result = await runEdgeTuner({ kv: mock.kv } as unknown as Env, null, now);

        expect(result.status).toBe('ok');
        // EMA: 100*0.85 + 60*0.15 = 94
        expect(result.baselineRtt).toBe(94);
        const saved = JSON.parse(mock.store.get('edgeTunerState')!);
        expect(saved.baselineRtt).toBe(94);
    });

    it('blend فقط یک‌بار در روز — دور دومِ همان روز EMA را دوباره نمی‌مکند', async () => {
        const now = 1_700_000_000_000;
        const today = new Date(now).toISOString().slice(0, 10);
        const state = JSON.stringify({ baselineRtt: 94, baselineDate: today });
        const mock = createKvMock({
            edgeTelemetry: makeDay(now, 60, 12),
            edgeTunerState: state
        });
        const { runEdgeTuner } = await import('../src/api/edge-tuner');
        const result = await runEdgeTuner({ kv: mock.kv } as unknown as Env, null, now);
        expect(result.status).toBe('ok');
        expect(result.baselineRtt).toBe(94);
    });

    it('KV خراب → هرگز throw نمی‌کند (no-data)', async () => {
        const mock = createKvMock();
        mock.failing.fail = true;
        const { runEdgeTuner } = await import('../src/api/edge-tuner');
        const result = await runEdgeTuner({ kv: mock.kv } as unknown as Env, null, 1_700_000_000_000);
        expect(result.status).toBe('no-data');
    });
});
