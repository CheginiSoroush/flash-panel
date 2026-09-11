import { createHash } from 'node:crypto';
import { getGlobals } from '@settings';
import {
    handleTCPOutBound,
    makeReadableWebSocketStream,
    safeCloseTcpSocket
} from '@protocols/common';
import type { RemoteSocketWrapper } from '@protocols/common';
import { parseTrHeader } from './parsers';

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

export async function TrOverWSHandler(request: Request): Promise<Response> {
    const { trPass } = getGlobals();
    const hashBytes = getHashBytes(trPass);

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

    // wrapper با writer — از کش writer در common.ts استفاده می‌شه
    const remoteSocketWrapper: RemoteSocketWrapper = { value: null, writer: null };

    const writableStream = new WritableStream({
        async write(chunk: ArrayBuffer) {
            // writer کش‌شده — بدون getWriter/releaseLock و بدون race
            const writer = remoteSocketWrapper.writer;
            if (writer) {
                return writer.write(chunk);
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