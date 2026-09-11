import { getGlobals } from '@settings';
import {
    safeCloseTcpSocket,
    handleTCPOutBound,
    makeReadableWebSocketStream,
    WS_READY_STATE_OPEN
} from '@protocols/common';
import type { RemoteSocketWrapper } from '@protocols/common';
import { getUUIDBytes, parseVlHeader } from './parsers';

// در حالت دیباگ true کنید تا لاگ‌ها فعال بشن
const LOG_ENABLED = false;

export async function VlOverWSHandler(request: Request): Promise<Response> {
    const { vlUUID } = getGlobals();
    const userUUIDBytes = getUUIDBytes(vlUUID);

    const webSocketPair = new WebSocketPair();
    const [client, webSocket] = Object.values(webSocketPair);
    webSocket.accept();
    webSocket.binaryType = 'arraybuffer';

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
    let udpStreamWrite: ((chunk: ArrayBuffer | Uint8Array<ArrayBuffer>) => Promise<void>) | null = null;
    let isDns = false;

    const writableStream = new WritableStream({
        async write(chunk: ArrayBuffer) {
            if (isDns && udpStreamWrite) {
                return udpStreamWrite(chunk);
            }

            // استفاده از writer کش‌شده — بدون getWriter/releaseLock و بدون race
            const writer = remoteSocketWrapper.writer;
            if (writer) {
                return writer.write(chunk);
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
                    const resp = await fetch('https://cloudflare-dns.com/dns-query', {
                        method: 'POST',
                        headers: {
                            'content-type': 'application/dns-message',
                        },
                        body: chunk,
                    });

                    const dnsQueryResult = new Uint8Array(await resp.arrayBuffer());
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