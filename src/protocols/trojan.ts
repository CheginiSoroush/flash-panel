import { createHash } from 'node:crypto';
import { getGlobals } from '@settings';
import {
    handleTCPOutBound,
    makeReadableWebSocketStream,
    safeCloseTcpSocket,
    safeCloseWebSocket,
    REMOTE_SOCKET_MAX_BUFFERED_BYTES
} from '@protocols/common';
import type { RemoteSocketWrapper } from '@protocols/common';
import { attachWsGuardian, WsGuardianConfig } from './ws-guardian';
import { beginWsMetrics, endWsMetrics } from './ws-metrics';
import { parseTrHeader } from './parsers';
import { recordEdgeSample } from '@settings/edge-telemetry';

// در حالت دیباگ true کنید تا لاگ‌ها فعال بشن
const LOG_ENABLED = false;

// هش SHA-224 رمز فقط یک‌بار در عمر isolate محاسبه و کش می‌شه
let cachedTrPass = '';
let cachedHashBytes = new Uint8Array(56);

function getHashBytes(trPass: string): Uint8Array {
    if (trPass === cachedTrPass) return cachedHashBytes;

    const hex = createHash('sha224').update(trPass).digest('hex');
    const bytes = new Uint8Array(56);
    for (let i = 0; i < 56; i++) {
        bytes[i] = hex.charCodeAt(i);
    }

    cachedTrPass = trPass;
    cachedHashBytes = bytes;
    return bytes;
}

export async function TrOverWSHandler(request: Request, env: Env, ctx: ExecutionContext, guardian?: WsGuardianConfig | null): Promise<Response> {
    const { trPass } = getGlobals();
    const hashBytes = getHashBytes(trPass);

    const webSocketPair = new WebSocketPair();
    const [client, webSocket] = Object.values(webSocketPair);
    webSocket.accept();
    webSocket.binaryType = 'arraybuffer';

    // 📊 متریک ترافیک — از accept تا close (نمونه در close ثبت می‌شود، نه handshake)
    beginWsMetrics(webSocket);
    webSocket.addEventListener('close', () => {
        const traffic = endWsMetrics(webSocket);
        if (traffic) recordEdgeSample(request, env, ctx, 'ws', traffic);
    });
    webSocket.addEventListener('error', () => {
        const traffic = endWsMetrics(webSocket);
        if (traffic) recordEdgeSample(request, env, ctx, 'ws', traffic);
    });

    let address = '';
    let portForLog = 0;

    const log = (info: string, event?: unknown) => {
        if (LOG_ENABLED) {
            console.log(`[${address}:${portForLog}] ${info}`, event || '');
        }
    };

    const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
    const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader, log);

    // wrapper با writer — از کش writer در common.ts استفاده می‌شه
    const remoteSocketWrapper: RemoteSocketWrapper = { value: null, writer: null };

    // v0.8.49 — push به بافر پنجره با سقف بایتی؛ عبور از سقف = بستن تمیز همان
    // اتصال (کلاینت reconnect می‌کند) نه OOM ایزوله — پل WS هیچ backpressure به
    // کلاینت نمی‌دهد و پنجره‌ی failover می‌تواند نامحدود طول بکشد
    const pushBuffered = (chunk: ArrayBuffer): void => {
        (remoteSocketWrapper.buffered ??= []).push(chunk);
        const total = (remoteSocketWrapper.bufferedBytes ?? 0) + chunk.byteLength;
        remoteSocketWrapper.bufferedBytes = total;
        if (total > REMOTE_SOCKET_MAX_BUFFERED_BYTES) {
            safeCloseTcpSocket(remoteSocketWrapper.value);
            safeCloseWebSocket(webSocket);
        }
    };

    // نگهبان اتصال — فقط وقتی در تنظیمات فعال باشه (پیش‌فرض: خاموش)
    if (guardian?.enabled) {
        attachWsGuardian(webSocket, () => {
            safeCloseTcpSocket(remoteSocketWrapper.value);
            safeCloseWebSocket(webSocket);
        }, { idleMs: guardian.idleSec * 1_000 }, log);
    }

    const writableStream = new WritableStream({
        async write(chunk: ArrayBuffer) {
            // writer کش‌شده — بدون getWriter/releaseLock و بدون race
            const writer = remoteSocketWrapper.writer;
            if (writer) {
                // v0.8.48 — ردِ نوشته (مرگ سوکتِ تلاش فعلی در حال پرواز) نباید پمپِ
                // کلاینت→ریموت را بکشد: pipeTo که یک writeاش رد شود readable را cancel
                // می‌کند (پیام‌های بعدی حذف می‌شوند) و WS بسته می‌شود → زنجیره‌ی failover
                // هرگز اجرا نمی‌شود. chunk به buffered برمی‌گردد تا قرارداد بازپخش
                // v0.8.28/v0.8.38 آن را به ترتیب درست به تلاش بعدی برساند.
                return writer.write(chunk).catch(() => {
                    pushBuffered(chunk);
                });
            }

            // v0.8.28 — اگر خروجی TCP شروع شده ولی نویسنده هنوز آماده نیست
            // (پنجره‌ی DNS مسیر forced-proxy در حالت prefix، یا پنجره‌ی retry)،
            // chunk بافر می‌شود — پارسِ آن به‌عنوان هدر یعنی مرگ تونل + WS زامبی
            if (remoteSocketWrapper.buffered) {
                pushBuffered(chunk);
                return;
            }

            const {
                hasError,
                message,
                portRemote = 443,
                addressRemote = '',
                rawClientData,
            } = parseTrHeader(chunk, hashBytes);

            address = addressRemote;
            portForLog = portRemote;

            if (hasError) {
                throw new Error(message);
            }

            handleTCPOutBound(
                remoteSocketWrapper,
                addressRemote,
                portRemote,
                rawClientData,
                webSocket,
                null,
                log
            );
        },
        close() {
            safeCloseTcpSocket(remoteSocketWrapper.value);
        },
        abort(reason) {
            log('readableWebSocketStream is aborted', JSON.stringify(reason));
        },
    });

    readableWebSocketStream
        .pipeTo(writableStream)
        .catch((error) => {
            log('readableWebSocketStream pipeTo error', error);
            safeCloseTcpSocket(remoteSocketWrapper.value);
        });

    return new Response(null, {
        status: 101,
        webSocket: client,
    });
}