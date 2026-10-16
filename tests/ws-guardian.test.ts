import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    attachWsGuardian,
    clampGuardianIdleSec,
    touchWsRead,
    touchWsWrite,
    wsLastActivity,
    WS_GUARDIAN_DEFAULT_IDLE_SEC,
    WS_GUARDIAN_MAX_IDLE_SEC,
    WS_GUARDIAN_MIN_IDLE_SEC
} from '../src/protocols/ws-guardian';

// ---------- FakeWebSocket — EventTarget مینیمال با close ----------

class FakeWebSocket extends EventTarget {
    closed = false;
    close(): void {
        if (this.closed) return;
        this.closed = true;
        this.dispatchEvent(new Event('close'));
    }
    emitMessage(): void {
        this.dispatchEvent(new MessageEvent('message'));
    }
}

// ---------- clampGuardianIdleSec ----------

describe('clampGuardianIdleSec', () => {
    it('keeps values inside the 30..3600 range', () => {
        expect(clampGuardianIdleSec(300)).toBe(300);
        expect(clampGuardianIdleSec('120')).toBe(120);
        expect(clampGuardianIdleSec(30)).toBe(30);
        expect(clampGuardianIdleSec(3600)).toBe(3600);
    });

    it('clamps out-of-range values', () => {
        expect(clampGuardianIdleSec(10)).toBe(WS_GUARDIAN_MIN_IDLE_SEC);
        expect(clampGuardianIdleSec(99999)).toBe(WS_GUARDIAN_MAX_IDLE_SEC);
    });

    it('falls back to the default for garbage input', () => {
        expect(clampGuardianIdleSec(undefined)).toBe(WS_GUARDIAN_DEFAULT_IDLE_SEC);
        expect(clampGuardianIdleSec('abc')).toBe(WS_GUARDIAN_DEFAULT_IDLE_SEC);
        expect(clampGuardianIdleSec(Number.NaN)).toBe(WS_GUARDIAN_DEFAULT_IDLE_SEC);
        expect(clampGuardianIdleSec(null)).toBe(WS_GUARDIAN_DEFAULT_IDLE_SEC);
    });

    it('floors fractional values', () => {
        expect(clampGuardianIdleSec(299.9)).toBe(299);
    });
});

// ---------- attachWsGuardian ----------

describe('attachWsGuardian', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('closes an idle connection after the threshold', () => {
        const ws = new FakeWebSocket();
        const onClose = vi.fn();

        attachWsGuardian(ws as unknown as WebSocket, onClose, { idleMs: 5_000, checkMs: 1_000 });

        vi.advanceTimersByTime(4_000);
        expect(onClose).not.toHaveBeenCalled();

        vi.advanceTimersByTime(1_100);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('does not close while reads keep the connection active', () => {
        const ws = new FakeWebSocket();
        const onClose = vi.fn();

        attachWsGuardian(ws as unknown as WebSocket, onClose, { idleMs: 5_000, checkMs: 1_000 });

        // هر ۲ ثانیه پیام می‌آید — هرگز آستانه پر نمی‌شود
        for (let i = 0; i < 10; i++) {
            vi.advanceTimersByTime(2_000);
            touchWsRead(ws as unknown as WebSocket);
        }

        expect(onClose).not.toHaveBeenCalled();
    });

    it('does not close while server-side writes keep it active (active download)', () => {
        const ws = new FakeWebSocket();
        const onClose = vi.fn();

        attachWsGuardian(ws as unknown as WebSocket, onClose, { idleMs: 5_000, checkMs: 1_000 });

        // دانلود فعال: کلاینت ساکت، سرور مدام می‌نویسد
        for (let i = 0; i < 10; i++) {
            vi.advanceTimersByTime(2_000);
            touchWsWrite(ws as unknown as WebSocket);
        }

        expect(onClose).not.toHaveBeenCalled();
    });

    it('stops checking after the close event (no zombie timers)', () => {
        const ws = new FakeWebSocket();
        const onClose = vi.fn();

        attachWsGuardian(ws as unknown as WebSocket, onClose, { idleMs: 5_000, checkMs: 1_000 });

        ws.close(); // رویداد close → تایمر پاک می‌شود
        vi.advanceTimersByTime(60_000);

        expect(onClose).not.toHaveBeenCalled();
    });

    it('tracks activity per-socket (two sockets do not interfere)', () => {
        const wsA = new FakeWebSocket();
        const wsB = new FakeWebSocket();
        const closeA = vi.fn();
        const closeB = vi.fn();

        attachWsGuardian(wsA as unknown as WebSocket, closeA, { idleMs: 5_000, checkMs: 1_000 });
        attachWsGuardian(wsB as unknown as WebSocket, closeB, { idleMs: 5_000, checkMs: 1_000 });

        // فقط B فعال می‌ماند
        for (let i = 0; i < 6; i++) {
            vi.advanceTimersByTime(2_000);
            touchWsRead(wsB as unknown as WebSocket);
        }

        expect(closeA).toHaveBeenCalledTimes(1);
        expect(closeB).not.toHaveBeenCalled();
    });

    it('closes only once even if checks continue past the threshold', () => {
        const ws = new FakeWebSocket();
        const onClose = vi.fn();

        attachWsGuardian(ws as unknown as WebSocket, onClose, { idleMs: 5_000, checkMs: 1_000 });

        vi.advanceTimersByTime(20_000);

        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('exposes last activity for debugging', () => {
        const ws = new FakeWebSocket();
        const typed = ws as unknown as WebSocket;

        expect(wsLastActivity(typed)).toBeNull();

        attachWsGuardian(typed, () => {}, { idleMs: 5_000, checkMs: 1_000 });

        // snapshot عددی — آبجکت activity به‌صورت in-place آپدیت می‌شود
        const beforeRead = wsLastActivity(typed)!.lastRead;

        vi.advanceTimersByTime(2_000);
        touchWsRead(typed);
        expect(wsLastActivity(typed)!.lastRead).toBeGreaterThan(beforeRead);
    });
});

// ---------- sampleUsageNow (cron handler) ----------

describe('sampleUsageNow', () => {
    let kvStore: Map<string, string>;

    beforeEach(async () => {
        vi.useRealTimers();
        kvStore = new Map();

        // globals شبیه‌سازی‌شده (هم‌الگوی auth.test.ts) — قبل از import داینامیک
        (globalThis as any).EMBEDED_SETTINGS = {
            accID: 'test-account',
            accEmail: 'test@example.com',
            apiToken: 'test-token',
            vlUUID: 'b831381d-6324-4d53-ad4f-8cda48b30811',
            trPass: 'test-pass',
            securePath: 'fp',
            proxyIpMode: '',
            proxyIPs: [],
            prefixes: [],
            mainDomain: 'flash-panel.test',
            fallback: '',
            dohUrl: ''
        };
        (globalThis as any).VERSION = '0.3.8';
        (globalThis as any)._repo_ = 'https://github.com/CheginiSoroush/flash-panel';
        (globalThis as any)._public_proxy_ip_ = 'bpb.yousef.isegaro.com';

        const { sampleUsageNow } = await import('../src/api/usage');
        (globalThis as any).__sampleUsageNow = sampleUsageNow;
    });

    afterEach(() => {
        delete (globalThis as any).EMBEDED_SETTINGS;
        delete (globalThis as any).VERSION;
        delete (globalThis as any)._repo_;
        delete (globalThis as any)._public_proxy_ip_;
        delete (globalThis as any).__sampleUsageNow;
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    function makeEnv() {
        return {
            kv: {
                async get(key: string, opts?: { type?: string }) {
                    const raw = kvStore.get(key);
                    if (raw === undefined) return null;
                    return opts?.type === 'json' ? JSON.parse(raw) : raw;
                },
                async put(key: string, value: string) {
                    kvStore.set(key, value);
                },
                async delete(key: string) {
                    kvStore.delete(key);
                }
            }
        } as unknown as Env;
    }

    function stubCloudflareApi(total: number, worker: number) {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
            data: {
                viewer: {
                    accounts: [{
                        total: [{ sum: { requests: total } }],
                        worker: [{ sum: { requests: worker } }]
                    }]
                }
            }
        }), { status: 200 })));
    }

    it('records a usage sample without any panel visit', async () => {
        stubCloudflareApi(1_234, 567);

        await (globalThis as any).__sampleUsageNow(makeEnv());

        const stored = JSON.parse(kvStore.get('usageHistory')!);
        const today = new Date().toISOString().slice(0, 10);
        expect(stored[today]).toMatchObject({ date: today, total: 1_234, worker: 567, samples: 1 });
    });

    it('does not write anything when the Cloudflare API fails', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => {
            throw new Error('network down');
        }));

        await (globalThis as any).__sampleUsageNow(makeEnv());

        expect(kvStore.has('usageHistory')).toBe(false);
    });

    it('survives a missing EMBEDED_SETTINGS without throwing', async () => {
        delete (globalThis as any).EMBEDED_SETTINGS;

        await expect((globalThis as any).__sampleUsageNow(makeEnv())).resolves.toBeUndefined();
        expect(kvStore.has('usageHistory')).toBe(false);
    });
});
