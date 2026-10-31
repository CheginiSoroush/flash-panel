import { getGlobals } from '@settings';
import {
    safeCloseTcpSocket,
    safeCloseWebSocket,
    handleTCPOutBound,
    makeReadableWebSocketStream,
    REMOTE_SOCKET_MAX_BUFFERED_BYTES,
    WS_READY_STATE_OPEN
} from '@protocols/common';
import type { RemoteSocketWrapper } from '@protocols/common';
import { attachWsGuardian, WsGuardianConfig } from './ws-guardian';
import { beginWsMetrics, endWsMetrics } from './ws-metrics';
import { getUUIDBytes, parseVlHeader } from './parsers';
import { recordEdgeSample } from '@settings/edge-telemetry';
import { resolveDnsWire } from '@handlers/doh';

// در حالت دیباگ true کنید تا لاگ‌ها فعال بشن
const LOG_ENABLED = false;

export async function VlOverWSHandler(request: Request, env: Env, ctx: ExecutionContext, guardian?: WsGuardianConfig | null): Promise<Response> {
    const { vlUUID } = getGlobals();
    const userUUIDBytes = getUUIDBytes(vlUUID);

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

    // writer حالا داخل wrapper توسط common.ts کش می‌شه
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
    let udpStreamWrite: ((chunk: ArrayBuffer | Uint8Array<ArrayBuffer>) => Promise<void>) | null = null;
    let isDns = false;

    // نگهبان اتصال — فقط وقتی در تنظیمات فعال باشه (پیش‌فرض: خاموش)
    // بعد از wrapper ثبت می‌شه تا onClose به سوکت ریموت دسترسی داشته باشه
    if (guardian?.enabled) {
        attachWsGuardian(webSocket, () => {
            safeCloseTcpSocket(remoteSocketWrapper.value);
            safeCloseWebSocket(webSocket);
        }, { idleMs: guardian.idleSec * 1_000 }, log);
    }

    const writableStream = new WritableStream({
        async write(chunk: ArrayBuffer) {
            if (isDns && udpStreamWrite) {
                return udpStreamWrite(chunk);
            }

            // استفاده از writer کش‌شده — بدون getWriter/releaseLock و بدون race
            const writer = remoteSocketWrapper.writer;
            if (writer) {
                // v0.8.48 — ردِ نوشته (مرگ سوکتِ تلاش فعلی در حال پرواز: وچ‌داگ first-byte،
                // RST، سیاه‌چاله‌ی مقصد) نباید پمپِ کلاینت→ریموت را بکشد: pipeTo که یک writeاش
                // رد شود readable را cancel می‌کند (پیام‌های بعدی حذف می‌شوند) و WS بسته می‌شود
                // → زنجیره‌ی failover هرگز اجرا نمی‌شود و کل نشست با یک نوشته‌ی مردود می‌میرد.
                // chunk به buffered برمی‌گردد تا قرارداد بازپخش v0.8.28/v0.8.38 آن را به ترتیب
                // درست به تلاش بعدی برساند؛ پمپ زنده می‌ماند تا writer تلاش بعدی را بگیرد.
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
                rawDataIndex = 0,
                version = 0,
                isUDP = false,
            } = parseVlHeader(chunk, userUUIDBytes);

            address = addressRemote;
            portForLog = portRemote;

            if (hasError) {
                throw new Error(message);
            }

            const vlessResponseHeader = new Uint8Array([version, 0]);
            const rawClientData = new Uint8Array(chunk, rawDataIndex);

            if (isUDP) {
                if (portRemote === 53) {
                    isDns = true;
                    const { write } = await handleUDPOutBound(webSocket, vlessResponseHeader, log);
                    udpStreamWrite = write;
                    await udpStreamWrite(rawClientData);
                    return;
                } else {
                    throw new Error('UDP proxy only enable for DNS which is port 53');
                }
            }

            handleTCPOutBound(
                remoteSocketWrapper,
                addressRemote,
                portRemote,
                rawClientData,
                webSocket,
                vlessResponseHeader,
                log
            );
        },
        close() {
            safeCloseTcpSocket(remoteSocketWrapper.value);
        },
        abort(reason) {
            log('readableWebSocketStream is abort', JSON.stringify(reason));
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

async function handleUDPOutBound(
    webSocket: WebSocket,
    vlessResponseHeader: Uint8Array<ArrayBuffer>,
    log: (info: string, event?: unknown) => void
) {
    let isHeaderSent = false;

    // تایپ‌های صریح — خروجی Uint8Array<ArrayBuffer> تا برای body قابل استفاده باشه
    const transformStream = new TransformStream<
        ArrayBuffer | Uint8Array<ArrayBuffer>,
        Uint8Array<ArrayBuffer>
    >({
        transform(message, controller) {
            const data = message instanceof ArrayBuffer ? new Uint8Array(message) : message;
            for (let index = 0; index + 2 <= data.length;) {
                const udpPacketLength = (data[index] << 8) | data[index + 1];
                index += 2;
                controller.enqueue(data.subarray(index, index + udpPacketLength));
                index += udpPacketLength;
            }
        },
    });

    transformStream.readable
        .pipeTo(
            new WritableStream<Uint8Array<ArrayBuffer>>({
                async write(chunk) {
                    // v0.8.20: DNS تونل از لایه‌ی کش DoH می‌گذرد — کوئری تکراری
                    // بدون رفت‌وبرگشت بالادستی پاس می‌گیرد (کش TTL-آگاه +
                    // single-flight + stale-on-error) و dohUrl ادمین رعایت
                    // می‌شود (قبلاً fetch خام به URL هاردکد بود). null =
                    // بالادست مرد؛ بدون پاسخ برمی‌گردیم تا کانال DNS زنده بماند
                    // و کلاینت retry کند (قبلاً یک fetch بد کل کانال را می‌بست)
                    const dnsQueryResult = await resolveDnsWire(chunk);
                    if (!dnsQueryResult) return;

                    const udpSize = dnsQueryResult.length;

                    const response = new Uint8Array(
                        (isHeaderSent ? 0 : vlessResponseHeader.length) + 2 + udpSize
                    );
                    let offset = 0;
                    if (!isHeaderSent) {
                        response.set(vlessResponseHeader, 0);
                        offset = vlessResponseHeader.length;
                        isHeaderSent = true;
                    }
                    response[offset] = (udpSize >> 8) & 0xff;
                    response[offset + 1] = udpSize & 0xff;
                    response.set(dnsQueryResult, offset + 2);

                    if (webSocket.readyState === WS_READY_STATE_OPEN) {
                        webSocket.send(response);
                    }
                },
            })
        )
        .catch((error) => {
            log('dns udp has error', String(error));
        });

    const writer = transformStream.writable.getWriter();

    return {
        async write(chunk: ArrayBuffer | Uint8Array<ArrayBuffer>) {
            await writer.write(chunk);
        },
    };
}