import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * وچ‌داگ first-byte (v0.8.18):
 * مقصدهای «سیاه‌چاله» (نمونه: اتصال مستقیم به IPهای خود CF) TCP را باز نگه
 * می‌دارند، داده‌ای برنمی‌گردانند و هرگز close نمی‌شوند → retry قدیمی که به
 * رویداد close تکیه داشت هیچ‌وقت فعال نمی‌شد و کاربر «وصل ولی بدون ترافیک»
 * می‌ماند. این تست‌ها تضمین می‌کنند:
 *   ۱) بدون داده در بازه‌ی تایم‌اوت → سوکت بسته می‌شود و retry صدا زده می‌شود
 *   ۲) با رسیدن اولین داده → وچ‌داگ خاموش و retry هرگز اجرا نمی‌شود
 *   ۳) خطای بالادستی وقتی retry در راه است، WS را نمی‌بندد (باگ قبلی)
 */

vi.mock('cloudflare:sockets', () => ({ connect: vi.fn() }));

// global های بیلد — settings.ts هنگام ایمپورت به آن‌ها نیاز دارد
(globalThis as any).VERSION = '0.8.18';

// یاواس فیک — حداقلِ چیزی که remoteSocketToWS لازم دارد
function fakeWs() {
    const sent: (Uint8Array | ArrayBuffer)[] = [];
    return {
        sent,
        readyState: 1, // OPEN
        send: vi.fn((d: Uint8Array | ArrayBuffer) => sent.push(d)),
        close: vi.fn(),
    } as unknown as WebSocket & { sent: (Uint8Array | ArrayBuffer)[]; send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
}

// سوکت فیک با استریم قابل‌کنترل
function fakeSocket() {
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
    const readable = new ReadableStream<Uint8Array>({
        start(controller) { controllerRef = controller; },
        pull() { /* هنگ عمدی — سیاه‌چاله */ },
    });
    // با close() واقعی سوکت (که وچ‌داگ صدا می‌زند) استریم پایان تمیز می‌یابد
    const socket = {
        readable,
        writable: new WritableStream(),
        close: vi.fn(() => {
            try { controllerRef?.close(); } catch { /* noop */ }
        }),
        closed: Promise.resolve(),
    } as unknown as Socket & { close: ReturnType<typeof vi.fn> };
    return { socket };
}

describe('first-byte watchdog — dead upstream (v0.8.18)', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('no data within timeout → socket closed, retry fires, WS stays open', async () => {
        const { remoteSocketToWS } = await import('../src/protocols/common');
        const { socket } = fakeSocket();
        const ws = fakeWs();
        const retry = vi.fn();

        const done = remoteSocketToWS(socket, ws, null, retry, () => {});

        const assertion = (async () => {
            await vi.advanceTimersByTimeAsync(6_000);
            await done;
            expect(socket.close).toHaveBeenCalled();
            expect(retry).toHaveBeenCalledTimes(1);
            expect(ws.close).not.toHaveBeenCalled(); // WS باید برای retry زنده بماند
        })();
        await Promise.all([done, assertion]);
    });

    it('first data arrives in time → no retry, watchdog disarmed', async () => {
        const { remoteSocketToWS } = await import('../src/protocols/common');
        const { socket } = fakeSocket();
        const ws = fakeWs();
        const retry = vi.fn();

        // استریمی که فوراً یک chunk می‌دهد و می‌بندد
        const payload = new Uint8Array([1, 2, 3]);
        const readable = new ReadableStream<Uint8Array>({
            start(controller) { controller.enqueue(payload); controller.close(); },
        });
        (socket as unknown as { readable: ReadableStream }).readable = readable;

        await remoteSocketToWS(socket, ws, null, retry, () => {});

        await vi.advanceTimersByTimeAsync(60_000); // فراتر از تایم‌اوت — نباید اتفاقی بیفتد
        expect(retry).not.toHaveBeenCalled();
        expect(ws.sent.length).toBe(1);
    });

    it('upstream error with pending retry → WS not closed (old bug)', async () => {
        const { remoteSocketToWS } = await import('../src/protocols/common');
        const ws = fakeWs();
        const retry = vi.fn();

        const readable = new ReadableStream<Uint8Array>({
            start(controller) { controller.error(new Error('reset by peer')); },
        });
        const socket = {
            readable,
            writable: new WritableStream(),
            close: vi.fn(),
            closed: Promise.resolve(),
        } as unknown as Socket;

        await remoteSocketToWS(socket, ws, null, retry, () => {});

        expect(retry).toHaveBeenCalledTimes(1);
        expect(ws.close).not.toHaveBeenCalled();
    });
});
