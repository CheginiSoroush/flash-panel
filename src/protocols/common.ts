import { connect } from 'cloudflare:sockets';
import { isIPv4, parseHostPort, resolveDNS } from '@utils';
import { safeError } from '@common';
import { getGlobals } from '@settings';

export const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;

export type Logger = (info: string, event?: unknown) => void;
export type Chunk = ArrayBuffer | Uint8Array;

/**
 * Wrapper سوکت ریموت با کش writer.
 * caller های قدیمی فقط { value } می‌فرستن و رفتار قبلی براشون حفظ می‌شه —
 * caller های جدید { value, writer } می‌فرستن تا از کش writer استفاده کنن.
 */
export interface RemoteSocketWrapper {
    value: Socket | null;
    writer?: WritableStreamDefaultWriter<Chunk> | null;
}

export async function handleTCPOutBound(
    remoteSocket: RemoteSocketWrapper,
    addressRemote: string,
    portRemote: number,
    rawClientData: Chunk | undefined,
    webSocket: WebSocket,
    VLResponseHeader: Uint8Array | null,
    log: Logger
) {
    async function connectAndWrite(address: string, port: number): Promise<Socket> {
        const tcpSocket = connect({
            hostname: address,
            port: port,
        });

        // اگه caller از کش writer پشتیبانی کنه، قفل فقط یک‌بار گرفته می‌شه و تا پایان
        // عمر سوکت نگه داشته می‌شه — هم race قفل حذف می‌شه هم سربار per-chunk
        const keepWriter = 'writer' in remoteSocket;
        const writer = tcpSocket.writable.getWriter();

        // قبل از اولین await مقداردهی می‌شن تا chunk های بعدی بدون race
        // از همین writer استفاده کنن (ترتیب FIFO خود writer تضمین می‌شه)
        remoteSocket.value = tcpSocket;
        if (keepWriter) {
            remoteSocket.writer = writer;
        }

        log(`connected to ${address}:${port}`);

        if (rawClientData) {
            await writer.write(rawClientData);
        }

        if (!keepWriter) {
            writer.releaseLock();
        }

        return tcpSocket;
    }

    async function retry() {
        const { proxyIpMode, proxyIPs, prefixes } = getGlobals();
        const getRandomValue = (arr: string[]) => arr[Math.floor(Math.random() * arr.length)];

        // کل منطق retry داخل try — دیگه unhandled rejection نداریم
        try {
            if (proxyIpMode === 'proxyip') {
                log(`direct connection failed, trying to use Proxy IP for ${addressRemote}`);
                const proxyIP = getRandomValue(proxyIPs);
                const { host, port } = parseHostPort(proxyIP, true);
                if (host) addressRemote = host;
                if (port) portRemote = port;
            } else if (proxyIpMode === 'prefix') {
                log(`direct connection failed, trying to generate dynamic prefix for ${addressRemote}`);
                const prefix = getRandomValue(prefixes);
                const dynamicProxyIP = await getDynamicProxyIP(addressRemote, prefix);

                if (dynamicProxyIP) {
                    addressRemote = dynamicProxyIP;
                } else {
                    webSocket.close(1011, 'Retry connection failed: Invalid Prefix');
                    return; // باگ قبلی: ادامه می‌داد و به همون آدرس شکست‌خورده reconnect می‌کرد
                }
            }
        } catch (error) {
            console.error('Retry connection failed:', error);
            webSocket.close(1011, `Retry connection failed: ${safeError(error)}`);
            return;
        }

        try {
            const tcpSocket = await connectAndWrite(addressRemote, portRemote);
            tcpSocket.closed
                .catch(error => console.log('retry TCP socket closed error', error))
                .finally(() => safeCloseWebSocket(webSocket));

            remoteSocketToWS(tcpSocket, webSocket, VLResponseHeader, null, log);
        } catch (error) {
            console.error('Retry connection failed:', error);
            webSocket.close(1011, `Retry connection failed: ${safeError(error)}`);
        }
    }

    try {
        const tcpSocket = await connectAndWrite(addressRemote, portRemote);
        remoteSocketToWS(tcpSocket, webSocket, VLResponseHeader, retry, log);
    } catch (error) {
        console.error(`Connection failed: ${error}`);
        webSocket.close(1011, `Connection failed: ${safeError(error)}`);
    }
}

async function remoteSocketToWS(
    remoteSocket: Socket,
    webSocket: WebSocket,
    VLResponseHeader: Uint8Array | null,
    retry: (() => void) | null,
    log: Logger
) {
    let vlHeader = VLResponseHeader;
    let hasIncomingData = false;

    const writableStream = new WritableStream({
        async write(chunk: Chunk, controller) {
            hasIncomingData = true;
            if (webSocket.readyState !== WS_READY_STATE_OPEN) {
                controller.error('webSocket.readyState is not open, maybe close');
                return; // باگ قبلی: بعد از error هم به send ادامه می‌داد
            }

            if (vlHeader) {
                // الحاق همگام با تخصیص واحد — به‌جای Blob + arrayBuffer async
                const view = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
                const merged = new Uint8Array(vlHeader.length + view.length);
                merged.set(vlHeader, 0);
                merged.set(view, vlHeader.length);
                vlHeader = null;
                webSocket.send(merged);
            } else {
                webSocket.send(chunk);
            }
        },
        close() {
            log(`remoteConnection.readable is close with hasIncomingData is ${hasIncomingData}`);
        },
        abort(reason) {
            console.error(`remoteConnection.readable abort`, reason);
            safeCloseTcpSocket(remoteSocket);
        },
    });

    try {
        await remoteSocket.readable.pipeTo(writableStream);
    } catch (error) {
        console.error('VLRemoteSocketToWS has exception.', error);
        safeCloseTcpSocket(remoteSocket);
        safeCloseWebSocket(webSocket);
    }

    if (hasIncomingData === false && retry) {
        log(`retry`);
        retry();
    }
}

export function makeReadableWebSocketStream(
    webSocketServer: WebSocket,
    earlyDataHeader: string,
    log: Logger
) {
    let readableStreamCancel = false;
    let streamEnded = false; // گارد: جلوگیری از close/error دوباره روی controller

    const stream = new ReadableStream({
        start(controller) {
            webSocketServer.addEventListener('message', (event) => {
                if (readableStreamCancel) return;
                controller.enqueue(event.data);
            });

            webSocketServer.addEventListener('close', () => {
                safeCloseWebSocket(webSocketServer);
                if (readableStreamCancel || streamEnded) return;
                streamEnded = true;
                controller.close();
            });

            webSocketServer.addEventListener('error', (err) => {
                log('webSocketServer has error');
                safeCloseWebSocket(webSocketServer);
                if (readableStreamCancel || streamEnded) return;
                streamEnded = true;
                controller.error(err);
            });

            const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);

            if (error) {
                streamEnded = true;
                controller.error(error);
                safeCloseWebSocket(webSocketServer); // باگ قبلی: WS باز می‌موند
            } else if (earlyData) {
                controller.enqueue(earlyData);
            }
        },
        cancel(reason) {
            if (readableStreamCancel) return;
            log(`ReadableStream was canceled, due to ${reason}`);
            readableStreamCancel = true;
            safeCloseWebSocket(webSocketServer);
        },
    });

    return stream;
}

function base64ToArrayBuffer(base64Str: string) {
    if (!base64Str) {
        return { earlyData: null, error: null };
    }

    try {
        // Base64 برای URL (rfc4648) — تک‌پاس به‌جای دو regex
        const normalized = base64Str.replace(/[-_]/g, (c) => (c === '-' ? '+' : '/'));
        const decode = atob(normalized);
        const buffer = new Uint8Array(decode.length);
        for (let i = 0; i < decode.length; i++) {
            buffer[i] = decode.charCodeAt(i);
        }
        return { earlyData: buffer.buffer, error: null };
    } catch (error) {
        return { earlyData: null, error };
    }
}

export function safeCloseTcpSocket(socket: Socket | null) {
    if (socket) {
        try {
            socket.close();
        } catch (error) {
            console.error('Failed to close TCP socket:', error);
        }
    }
}

export function safeCloseWebSocket(socket: WebSocket) {
    try {
        if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING) {
            socket.close();
        }
    } catch (error) {
        console.error('safeCloseWebSocket error', error);
    }
}

async function getDynamicProxyIP(address: string, prefix: string) {
    let finalAddress = address;

    if (!isIPv4(address)) {
        const { ipv4 } = await resolveDNS(address, true);

        if (ipv4.length) {
            finalAddress = ipv4[0];
        } else {
            throw new Error('Unable to find IPv4 in DNS records');
        }
    }

    return convertToNAT64IPv6(finalAddress, prefix);
}

function convertToNAT64IPv6(ipv4Address: string, prefix: string) {
    const parts = ipv4Address.split('.');

    if (parts.length !== 4) {
        throw new Error('Invalid IPv4 address');
    }

    const hex = parts.map(part => {
        const num = parseInt(part, 10);

        if (num < 0 || num > 255) {
            throw new Error('Invalid IPv4 address');
        }

        return num.toString(16).padStart(2, '0');
    });

    const match = prefix.match(/^\[([0-9A-Fa-f:]+)\]$/);

    if (match) {
        return `[${match[1]}${hex[0]}${hex[1]}:${hex[2]}${hex[3]}]`;
    }
}