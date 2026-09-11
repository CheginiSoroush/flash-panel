// ---------- منطق parsing پروتکل‌ها — کاملاً خالص و بدون وابستگی ----------
// جدا از vless/trojan تا قابل تست واحد باشه (فاز ۰)

const textDecoder = new TextDecoder();

let cachedUserUUID = '';
let cachedUUIDBytes = new Uint8Array(16);

/** UUID رشته‌ای → ۱۶ بایت — کش‌شده در عمر isolate */
export function getUUIDBytes(uuid: string): Uint8Array {
    if (uuid === cachedUserUUID) return cachedUUIDBytes;

    const hex = uuid.replace(/-/g, '');
    if (hex.length !== 32) {
        throw new Error('invalid VLESS UUID');
    }

    const bytes = new Uint8Array(16);
    for (let i = 0; i < 16; i++) {
        bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }

    cachedUserUUID = uuid;
    cachedUUIDBytes = bytes;
    return bytes;
}

/** مقایسه constant-time UUID — امن در برابر timing attack */
export function uuidMatches(buf: Uint8Array, offset: number, expected: Uint8Array): boolean {
    let diff = 0;
    for (let i = 0; i < 16; i++) {
        diff |= buf[offset + i] ^ expected[i];
    }
    return diff === 0;
}

/** مقایسه constant-time هش ۵۶ بایتی trojan */
export function hashMatches(buf: Uint8Array, expected: Uint8Array): boolean {
    let diff = 0;
    for (let i = 0; i < 56; i++) {
        diff |= buf[i] ^ expected[i];
    }
    return diff === 0;
}

export interface ParsedVlessHeader {
    hasError: boolean;
    message?: string;
    addressRemote?: string;
    addressType?: number;
    portRemote?: number;
    rawDataIndex?: number;
    version?: number;
    isUDP?: boolean;
}

/**
 * پارس هدر VLESS:
 * [version(1)][uuid(16)][addonsLen(1)][addons(N)][command(1)][port(2)][addrType(1)][addr][payload]
 */
export function parseVlHeader(chunk: ArrayBuffer, userUUIDBytes: Uint8Array): ParsedVlessHeader {
    if (chunk.byteLength < 24) {
        return { hasError: true, message: 'invalid data' };
    }

    const buf = new Uint8Array(chunk); // view بدون کپی
    const version = buf[0];

    if (!uuidMatches(buf, 1, userUUIDBytes)) {
        return { hasError: true, message: 'invalid user' };
    }

    const optLength = buf[17];
    const commandIndex = 18 + optLength;

    if (commandIndex + 4 > buf.length) {
        return { hasError: true, message: 'invalid data' };
    }

    const command = buf[commandIndex];
    let isUDP = false;

    if (command === 1) {
        // TCP
    } else if (command === 2) {
        isUDP = true;
    } else {
        return {
            hasError: true,
            message: `command ${command} is not supported, command 01-tcp,02-udp,03-mux`,
        };
    }

    const portIndex = commandIndex + 1;
    const portRemote = (buf[portIndex] << 8) | buf[portIndex + 1];

    const addressIndex = portIndex + 2;
    const addressType = buf[addressIndex];
    let addressValueIndex = addressIndex + 1;
    let addressLength = 0;
    let addressValue = '';

    switch (addressType) {
        case 1: // IPv4
            if (addressValueIndex + 4 > buf.length) {
                return { hasError: true, message: 'invalid IPv4 address' };
            }
            addressLength = 4;
            addressValue =
                buf[addressValueIndex] + '.' +
                buf[addressValueIndex + 1] + '.' +
                buf[addressValueIndex + 2] + '.' +
                buf[addressValueIndex + 3];
            break;

        case 2: // Domain
            if (addressValueIndex + 1 > buf.length) {
                return { hasError: true, message: 'invalid domain length' };
            }
            addressLength = buf[addressValueIndex];
            addressValueIndex += 1;
            if (addressValueIndex + addressLength > buf.length) {
                return { hasError: true, message: 'invalid domain' };
            }
            addressValue = textDecoder.decode(
                buf.subarray(addressValueIndex, addressValueIndex + addressLength)
            );
            break;

        case 3: { // IPv6
            if (addressValueIndex + 16 > buf.length) {
                return { hasError: true, message: 'invalid IPv6 address' };
            }
            addressLength = 16;
            const parts: string[] = [];
            for (let i = 0; i < 8; i++) {
                const offset = addressValueIndex + i * 2;
                parts.push(((buf[offset] << 8) | buf[offset + 1]).toString(16));
            }
            addressValue = parts.join(':');
            break;
        }

        default:
            return {
                hasError: true,
                message: `invalid addressType is ${addressType}`,
            };
    }

    if (!addressValue) {
        return {
            hasError: true,
            message: `addressValue is empty, addressType is ${addressType}`,
        };
    }

    return {
        hasError: false,
        addressRemote: addressValue,
        addressType,
        portRemote,
        rawDataIndex: addressValueIndex + addressLength,
        version,
        isUDP,
    };
}

export interface ParsedTrHeader {
    hasError: boolean;
    message?: string;
    addressRemote?: string;
    portRemote?: number;
    rawClientData?: Uint8Array;
}

/**
 * پارس هدر Trojan:
 * [hash(56 hex)][CRLF][CMD(1)][ATYP(1)][addr][port(2)][CRLF][payload]
 * ATYP: 1=IPv4, 3=domain, 4=IPv6
 */
export function parseTrHeader(chunk: ArrayBuffer, hashBytes: Uint8Array): ParsedTrHeader {
    // حداقل: hash(56) + CRLF(2)
    if (chunk.byteLength < 58) {
        return { hasError: true, message: 'invalid data' };
    }

    const buf = new Uint8Array(chunk); // view بدون کپی

    if (buf[56] !== 0x0d || buf[57] !== 0x0a) {
        return { hasError: true, message: 'invalid header format (missing CR LF)' };
    }

    if (!hashMatches(buf, hashBytes)) {
        return { hasError: true, message: 'invalid password' };
    }

    const req = 58;
    if (req + 2 > buf.length) {
        return { hasError: true, message: 'invalid data' };
    }

    const cmd = buf[req];
    if (cmd !== 1) {
        return { hasError: true, message: 'unsupported command, only TCP (CONNECT) is allowed' };
    }

    const atype = buf[req + 1];
    let addressLength = 0;
    let addressIndex = req + 2;
    let address = '';

    switch (atype) {
        case 1: // IPv4
            if (addressIndex + 4 > buf.length) {
                return { hasError: true, message: 'invalid data' };
            }
            addressLength = 4;
            address =
                buf[addressIndex] + '.' +
                buf[addressIndex + 1] + '.' +
                buf[addressIndex + 2] + '.' +
                buf[addressIndex + 3];
            break;

        case 3: // Domain
            if (addressIndex + 1 > buf.length) {
                return { hasError: true, message: 'invalid data' };
            }
            addressLength = buf[addressIndex];
            addressIndex += 1;
            if (addressIndex + addressLength > buf.length) {
                return { hasError: true, message: 'invalid data' };
            }
            address = textDecoder.decode(
                buf.subarray(addressIndex, addressIndex + addressLength)
            );
            break;

        case 4: { // IPv6
            if (addressIndex + 16 > buf.length) {
                return { hasError: true, message: 'invalid data' };
            }
            addressLength = 16;
            const parts: string[] = [];
            for (let i = 0; i < 8; i++) {
                const offset = addressIndex + i * 2;
                parts.push(((buf[offset] << 8) | buf[offset + 1]).toString(16));
            }
            address = parts.join(':');
            break;
        }

        default:
            return {
                hasError: true,
                message: `invalid addressType is ${atype}`,
            };
    }

    if (!address) {
        return {
            hasError: true,
            message: `address is empty, addressType is ${atype}`,
        };
    }

    // port(2) + CRLF(2)
    const portIndex = addressIndex + addressLength;
    if (portIndex + 4 > buf.length) {
        return { hasError: true, message: 'invalid data' };
    }

    const portRemote = (buf[portIndex] << 8) | buf[portIndex + 1];

    return {
        hasError: false,
        addressRemote: address,
        portRemote,
        // view بدون کپی — payload بعد از port و CRLF
        rawClientData: new Uint8Array(chunk, portIndex + 4),
    };
}
