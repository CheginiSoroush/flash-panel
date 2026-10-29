/**
 * 📦 MiniZip — سازنده‌ی ZIP فقط-STORE، صفر وابستگی (بهینه‌سازی v0.8.16)
 *
 * جایگزین jszip (~۹۵KB بعد از minify) برای تنها مصرف‌کننده‌اش: باندل
 * کانفیگ‌های Wireguard/WARP. ورودی‌ها فایل‌های conf متنی‌اند؛ STORE بدون
 * فشرده‌سازی عملاً هم‌حجم jszip deflate است و خود gzip کلاینت/CDN کار را می‌کند.
 *
 * ساختار: local header + data برای هر entry → central directory → EOCD.
 * زمان فایل ثابت 1980-01-01 (خروجی قطعی = کش‌پذیر و deterministic).
 */

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
    return c >>> 0;
});

function crc32(data: Uint8Array): number {
    let c = 0xffffffff;
    for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
    name: Uint8Array;
    data: Uint8Array;
    crc: number;
}

export class MiniZip {
    private entries: ZipEntry[] = [];
    private te = new TextEncoder();

    add(name: string, content: string): void {
        const data = this.te.encode(content);
        this.entries.push({ name: this.te.encode(name), data, crc: crc32(data) });
    }

    build(): ArrayBuffer {
        const n = this.entries.length;
        let localSize = 0;
        let cdSize = 0;
        for (const e of this.entries) {
            localSize += 30 + e.name.length + e.data.length;
            cdSize += 46 + e.name.length;
        }
        const buf = new Uint8Array(localSize + cdSize + 22);
        const dv = new DataView(buf.buffer);

        let off = 0;
        const offsets: number[] = [];
        for (const e of this.entries) {
            offsets.push(off);
            dv.setUint32(off, 0x04034b50, true); // local file header signature
            dv.setUint16(off + 4, 20, true); // version needed
            dv.setUint16(off + 8, 0, true); // flags
            dv.setUint16(off + 10, 0, true); // method: STORE
            dv.setUint16(off + 12, 0, true); // mod time
            dv.setUint16(off + 14, 0x21, true); // mod date: 1980-01-01
            dv.setUint32(off + 16, e.crc, true);
            dv.setUint32(off + 20, e.data.length, true); // compressed size
            dv.setUint32(off + 24, e.data.length, true); // uncompressed size
            dv.setUint16(off + 28, e.name.length, true);
            buf.set(e.name, off + 30);
            buf.set(e.data, off + 30 + e.name.length);
            off += 30 + e.name.length + e.data.length;
        }

        const cdStart = off;
        for (let i = 0; i < n; i++) {
            const e = this.entries[i];
            dv.setUint32(off, 0x02014b50, true); // central directory signature
            dv.setUint16(off + 4, 20, true); // version made by
            dv.setUint16(off + 6, 20, true); // version needed
            dv.setUint16(off + 14, 0x21, true); // mod date
            dv.setUint32(off + 16, e.crc, true);
            dv.setUint32(off + 20, e.data.length, true);
            dv.setUint32(off + 24, e.data.length, true);
            dv.setUint16(off + 28, e.name.length, true);
            dv.setUint32(off + 42, offsets[i], true); // local header offset
            buf.set(e.name, off + 46);
            off += 46 + e.name.length;
        }

        dv.setUint32(off, 0x06054b50, true); // EOCD signature
        dv.setUint16(off + 8, n, true); // entries on this disk
        dv.setUint16(off + 10, n, true); // total entries
        dv.setUint32(off + 12, off - cdStart, true); // central directory size
        dv.setUint32(off + 16, cdStart, true); // central directory offset
        return buf.buffer;
    }
}
