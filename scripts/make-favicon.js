// ⚡ تولید favicon فلش — بدون وابستگی (فرمت ICO خالص)
import { writeFileSync } from 'fs';

const SIZES = [16, 32, 48];
const OUT = 'src/assets/favicon.ico';

// زرد برقی #ffd60a به‌صورت BGRA
const COLOR = [0x0a, 0xd6, 0xff];

// پلی‌گون صاعقه (مختصات نسبی 0..1)
const BOLT = [
    [0.52, 0.02],
    [0.25, 0.52],
    [0.40, 0.52],
    [0.30, 0.98],
    [0.75, 0.40],
    [0.57, 0.40],
    [0.72, 0.02],
];

function inBolt(x, y) {
    let inside = false;
    for (let i = 0, j = BOLT.length - 1; i < BOLT.length; j = i++) {
        const [xi, yi] = BOLT[i];
        const [xj, yj] = BOLT[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
            inside = !inside;
        }
    }
    return inside;
}

function makeImage(size) {
    // پیکسل‌ها با supersampling برای لبه نرم
    const px = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            let hit = 0;
            for (const [dx, dy] of [[.25, .25], [.75, .25], [.25, .75], [.75, .75]]) {
                if (inBolt((x + dx) / size, (y + dy) / size)) hit++;
            }
            const alpha = Math.round((hit / 4) * 255);
            if (alpha > 0) {
                const i = (y * size + x) * 4;
                px[i] = COLOR[0];
                px[i + 1] = COLOR[1];
                px[i + 2] = COLOR[2];
                px[i + 3] = alpha;
            }
        }
    }

    const stride = size * 4;
    const maskRow = Math.ceil(size / 32) * 4;
    const data = Buffer.alloc(stride * size + maskRow * size);

    // پیکسل‌ها و ماسک — bottom-up مطابق فرمت BMP داخل ICO
    for (let y = 0; y < size; y++) {
        const src = size - 1 - y;
        Buffer.from(px.buffer, src * stride, stride).copy(data, y * stride);
        for (let x = 0; x < size; x++) {
            if (px[(src * size + x) * 4 + 3] === 0) {
                data[stride * size + y * maskRow + (x >> 3)] |= 0x80 >> (x & 7);
            }
        }
    }

    const header = Buffer.alloc(40);
    header.writeUInt32LE(40, 0);
    header.writeInt32LE(size, 4);
    header.writeInt32LE(size * 2, 8);
    header.writeUInt16LE(1, 12);
    header.writeUInt16LE(32, 14);
    header.writeUInt32LE(data.length, 20);

    return Buffer.concat([header, data]);
}

const images = SIZES.map(makeImage);
const ico = Buffer.alloc(6 + 16 * images.length);
ico.writeUInt16LE(1, 2);
ico.writeUInt16LE(images.length, 4);

let offset = ico.length;
images.forEach((img, i) => {
    const d = 6 + i * 16;
    ico[d] = SIZES[i];
    ico[d + 1] = SIZES[i];
    ico.writeUInt16LE(1, d + 4);
    ico.writeUInt16LE(32, d + 6);
    ico.writeUInt32LE(img.length, d + 8);
    ico.writeUInt32LE(offset, d + 12);
    offset += img.length;
});

const file = Buffer.concat([ico, ...images]);
writeFileSync(OUT, file);
console.log(`⚡ favicon ساخته شد: ${OUT} (${file.length} bytes)`);
