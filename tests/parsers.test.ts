import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
    parseVlHeader,
    parseTrHeader,
    getUUIDBytes
} from '../src/protocols/parsers';

const TEST_UUID = '003c745e-0e46-4fe6-a91b-88bd50a700c2';

// ---------- هلپرهای ساخت هدر ----------

function uuidToBytes(uuid: string): number[] {
    const hex = uuid.replace(/-/g, '');
    return Array.from({ length: 16 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16));
}

interface VlessOpts {
    uuid?: string;
    command?: number;    // 1=TCP, 2=UDP
    port?: number;
    addrType?: number;   // 1=IPv4, 2=domain, 3=IPv6
    addr?: string;
    optLength?: number;
    payloadBytes?: number;
}

function buildVlessHeader(opts: VlessOpts = {}): ArrayBuffer {
    const uuid = opts.uuid ?? TEST_UUID;
    const command = opts.command ?? 1;
    const port = opts.port ?? 443;
    const addrType = opts.addrType ?? 1;
    const addr = opts.addr ?? '10.0.0.1';
    const optLength = opts.optLength ?? 0;
    const payloadBytes = opts.payloadBytes ?? 0;

    let addrBytes: number[];
    if (addrType === 1) {
        addrBytes = addr.split('.').map(Number);
    } else if (addrType === 2) {
        const enc = new TextEncoder().encode(addr);
        addrBytes = [enc.length, ...enc];
    } else {
        addrBytes = [];
        for (const g of addr.split(':')) {
            const v = parseInt(g || '0', 16);
            addrBytes.push((v >> 8) & 0xff, v & 0xff);
        }
    }

    const header = [
        0,                        // version
        ...uuidToBytes(uuid),
        optLength,
        ...new Array(optLength).fill(0),
        command,
        (port >> 8) & 0xff, port & 0xff,
        addrType,
        ...addrBytes,
    ];

    const buffer = new Uint8Array(header.length + payloadBytes);
    buffer.set(header);
    for (let i = 0; i < payloadBytes; i++) buffer[header.length + i] = i + 1;
    return buffer.buffer;
}

interface TrojanOpts {
    password?: string;
    command?: number;    // 1=TCP, 3=UDP
    atype?: number;      // 1=IPv4, 3=domain, 4=IPv6
    addr?: string;
    port?: number;
    payloadBytes?: number;
}

const TR_PASS = 'test-password';

function getHashBytes(password: string): Uint8Array {
    const hex = createHash('sha224').update(password).digest('hex');
    const bytes = new Uint8Array(56);
    for (let i = 0; i < 56; i++) bytes[i] = hex.charCodeAt(i);
    return bytes;
}

function buildTrojanHeader(opts: TrojanOpts = {}): ArrayBuffer {
    const password = opts.password ?? TR_PASS;
    const command = opts.command ?? 1;
    const atype = opts.atype ?? 1;
    const addr = opts.addr ?? '10.0.0.1';
    const port = opts.port ?? 443;
    const payloadBytes = opts.payloadBytes ?? 0;

    let addrBytes: number[];
    if (atype === 1) {
        addrBytes = addr.split('.').map(Number);
    } else if (atype === 4) {
        addrBytes = [];
        for (const g of addr.split(':')) {
            const v = parseInt(g || '0', 16);
            addrBytes.push((v >> 8) & 0xff, v & 0xff);
        }
    } else {
        const enc = new TextEncoder().encode(addr);
        addrBytes = [enc.length, ...enc];
    }

    const hex = createHash('sha224').update(password).digest('hex');
    const hashBytes = Array.from(hex, c => c.charCodeAt(0));

    const header = [
        ...hashBytes,                    // 56 بایت هش
        0x0d, 0x0a,                      // CRLF
        command,
        atype,
        ...addrBytes,
        (port >> 8) & 0xff, port & 0xff,
        0x0d, 0x0a,                      // CRLF بعد از port
    ];

    const buffer = new Uint8Array(header.length + payloadBytes);
    buffer.set(header);
    for (let i = 0; i < payloadBytes; i++) buffer[header.length + i] = i + 1;
    return buffer.buffer;
}

// ---------- تست‌های VLESS ----------

describe('parseVlHeader', () => {
    const uuidBytes = getUUIDBytes(TEST_UUID);

    it('IPv4 + TCP درست parse می‌شه', () => {
        const result = parseVlHeader(buildVlessHeader({ addr: '10.0.0.1', port: 443 }), uuidBytes);
        expect(result.hasError).toBe(false);
        expect(result.addressRemote).toBe('10.0.0.1');
        expect(result.portRemote).toBe(443);
        expect(result.isUDP).toBe(false);
        expect(result.rawDataIndex).toBe(26);
    });

    it('پورت بزرگ (8443) درست parse می‌شه', () => {
        const result = parseVlHeader(buildVlessHeader({ port: 8443 }), uuidBytes);
        expect(result.portRemote).toBe(8443);
    });

    it('دامنه درست parse می‌شه', () => {
        const result = parseVlHeader(buildVlessHeader({ addrType: 2, addr: 'example.com' }), uuidBytes);
        expect(result.hasError).toBe(false);
        expect(result.addressRemote).toBe('example.com');
        expect(result.rawDataIndex).toBe(34);
    });

    it('IPv6 به فرم کامل برمی‌گرده', () => {
        const result = parseVlHeader(
            buildVlessHeader({ addrType: 3, addr: '2606:4700:4700:0:0:0:0:1111' }),
            uuidBytes
        );
        expect(result.hasError).toBe(false);
        expect(result.addressRemote).toBe('2606:4700:4700:0:0:0:0:1111');
        expect(result.rawDataIndex).toBe(38);
    });

    it('UDP + پورت 53 تشخیص داده می‌شه', () => {
        const result = parseVlHeader(buildVlessHeader({ command: 2, port: 53 }), uuidBytes);
        expect(result.hasError).toBe(false);
        expect(result.isUDP).toBe(true);
        expect(result.portRemote).toBe(53);
    });

    it('UUID اشتباه → invalid user', () => {
        const wrongBytes = getUUIDBytes('11111111-2222-3333-4444-555555555555');
        const result = parseVlHeader(buildVlessHeader(), wrongBytes);
        expect(result.hasError).toBe(true);
        expect(result.message).toBe('invalid user');
    });

    it('UUID با حروف بزرگ هم پذیرفته می‌شه', () => {
        const result = parseVlHeader(buildVlessHeader({ uuid: TEST_UUID.toUpperCase() }), uuidBytes);
        expect(result.hasError).toBe(false);
    });

    it('بافر کوتاه → invalid data', () => {
        const result = parseVlHeader(new ArrayBuffer(10), uuidBytes);
        expect(result.hasError).toBe(true);
        expect(result.message).toBe('invalid data');
    });

    it('command پشتیبانی‌نشده (mux=3) → خطا', () => {
        const result = parseVlHeader(buildVlessHeader({ command: 3 }), uuidBytes);
        expect(result.hasError).toBe(true);
        expect(result.message).toContain('not supported');
    });

    it('addons (optLength) درست رد می‌شه', () => {
        const result = parseVlHeader(buildVlessHeader({ optLength: 4 }), uuidBytes);
        expect(result.hasError).toBe(false);
        expect(result.addressRemote).toBe('10.0.0.1');
        expect(result.rawDataIndex).toBe(30);
    });

    it('payload بعد از هدر سالم می‌مونه', () => {
        const chunk = buildVlessHeader({ payloadBytes: 12 });
        const result = parseVlHeader(chunk, uuidBytes);
        const payload = new Uint8Array(chunk, result.rawDataIndex!);
        expect(payload.length).toBe(12);
        expect(payload[0]).toBe(1);
        expect(payload[11]).toBe(12);
    });

    it('IPv6 ناقص → خطای تمیز (نه RangeError)', () => {
        const full = new Uint8Array(buildVlessHeader({ addrType: 3, addr: '2606:4700:4700:0:0:0:0:1111' }));
        const truncated = full.slice(0, 36).buffer; // ۲ بایت کم
        const result = parseVlHeader(truncated, uuidBytes);
        expect(result.hasError).toBe(true);
        expect(result.message).toBe('invalid IPv6 address');
    });
});

describe('getUUIDBytes', () => {
    it('UUID خراب → throw', () => {
        expect(() => getUUIDBytes('not-a-uuid')).toThrow();
    });

    it('نتیجه کش می‌شه (همون reference)', () => {
        expect(getUUIDBytes(TEST_UUID)).toBe(getUUIDBytes(TEST_UUID));
    });
});

// ---------- تست‌های Trojan ----------

describe('parseTrHeader', () => {
    const hashBytes = getHashBytes(TR_PASS);

    it('IPv4 + TCP + payload درست parse می‌شه', () => {
        const chunk = buildTrojanHeader({ addr: '10.0.0.1', port: 8443, payloadBytes: 7 });
        const result = parseTrHeader(chunk, hashBytes);
        expect(result.hasError).toBe(false);
        expect(result.addressRemote).toBe('10.0.0.1');
        expect(result.portRemote).toBe(8443);
        expect(result.rawClientData!.length).toBe(7);
        expect(result.rawClientData![0]).toBe(1);
    });

    it('دامنه (atype=3) درست parse می‌شه', () => {
        const result = parseTrHeader(buildTrojanHeader({ atype: 3, addr: 'example.com' }), hashBytes);
        expect(result.hasError).toBe(false);
        expect(result.addressRemote).toBe('example.com');
    });

    it('IPv6 (atype=4) درست parse می‌شه', () => {
        const result = parseTrHeader(
            buildTrojanHeader({ atype: 4, addr: '2606:4700:4700:0:0:0:0:1111' }),
            hashBytes
        );
        expect(result.addressRemote).toBe('2606:4700:4700:0:0:0:0:1111');
    });

    it('پسورد اشتباه → invalid password', () => {
        const result = parseTrHeader(buildTrojanHeader({ password: 'wrong-pass' }), hashBytes);
        expect(result.hasError).toBe(true);
        expect(result.message).toBe('invalid password');
    });

    it('CRLF جاافتاده → invalid header format', () => {
        const full = new Uint8Array(buildTrojanHeader());
        full[56] = 0x00; // CRLF اول رو خراب کن
        const result = parseTrHeader(full.buffer, hashBytes);
        expect(result.hasError).toBe(true);
        expect(result.message).toBe('invalid header format (missing CR LF)');
    });

    it('بافر کوتاه → invalid data', () => {
        const result = parseTrHeader(new ArrayBuffer(40), hashBytes);
        expect(result.hasError).toBe(true);
        expect(result.message).toBe('invalid data');
    });

    it('UDP (command=3) → unsupported', () => {
        const result = parseTrHeader(buildTrojanHeader({ command: 3 }), hashBytes);
        expect(result.hasError).toBe(true);
        expect(result.message).toContain('unsupported command');
    });

    it('هدر ناقص (port/CRLF قطع) → invalid data', () => {
        const full = new Uint8Array(buildTrojanHeader());
        const cut = full.slice(0, 66).buffer; // پورت هست، CRLF پایانی نه
        const result = parseTrHeader(cut, hashBytes);
        expect(result.hasError).toBe(true);
        expect(result.message).toBe('invalid data');
    });
});
