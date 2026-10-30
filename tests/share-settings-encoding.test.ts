import { describe, it, expect } from 'vitest';
import { base64EncodeUtf8, base64DecodeUtf8 } from '@common';

/**
 * رگرسیون v0.8.21 — endpoint اشتراک‌گذاری تنظیمات (share-settings)
 *
 * باگ: shareSettings() از btoa خام استفاده می‌کرد؛ btoa روی هر کاراکتر خارج
 * از Latin1 (ریمارک فارسی/ایموجی داخل customConfigs/customSubs — کاربران
 * ایرانی تقریباً همیشه دارند) InvalidCharacterError می‌داد → endpoint کل
 * ۵۰۰ می‌شد و export/import تنظیمات پنل از کار می‌افتاد.
 *
 * فیکس: base64EncodeUtf8 (همان مسیری که ساب Raw از زمان همیشه استفاده می‌کند).
 * سازگاری: بدنه‌های ASCII خروجی بایت‌به‌بایت با btoa یکسان‌اند → فایل‌های
 * .dat قبلی که عملاً همه ASCII بودند (چون بقیه crash می‌کردند) سالم می‌مانند
 * و decode سمت پنل (TextDecoder روی بایت‌های atob) هر دو را می‌خواند.
 */

describe('encodeShareBody — کدگذاری UTF-8 امن برای share-settings', () => {
    it('بدنه‌ی ASCII دقیقاً معادل btoa خام است (سازگاری با فایل‌های قبلی)', () => {
        const asciiJson = JSON.stringify({
            cleanIPs: ['www.speedtest.net'],
            ports: [443, 2053, 8443],
            remoteDNS: 'https://8.8.8.8/dns-query',
            protocols: 'vl,tr',
            panelVersion: '0.8.21'
        });

        // معادل مستقیم همان کاری که btoa انجام می‌داد — بایت‌به‌بایت
        const expected = Buffer.from(asciiJson, 'binary').toString('base64');
        expect(base64EncodeUtf8(asciiJson)).toBe(expected);
    });

    it('ریمارک فارسی و ایموجی — بدون throw و گردش کامل صحیح (روی btoa خام crash می‌کرد)', () => {
        const sharedSettings = {
            customConfigs: [
                'vless://3a2a0461-1fec-4acd-a123-cbab2586bab1@example.com:443?security=tls#🇩🇪 تنکس آلمان ⚡',
                'trojan://pass@example.com:8443?security=tls#کانفیگ دوم — تست'
            ],
            customSubs: ['https://example.com/sub?name=ساب فارسی'],
            customBypassRules: ['domain:example.com'],
            echServerName: 'example.org'
        };
        const json = JSON.stringify(sharedSettings);

        // اثبات باگ: btoa خام واقعاً روی همین ورودی می‌میرد
        expect(() => btoa(json)).toThrow();
        // فیکس: بدون خطا
        const encoded = base64EncodeUtf8(json);
        expect(typeof encoded).toBe('string');

        // گردش کامل — همان مسیر decode سمت پنل (decodeShareBody در script.js)
        const bin = atob(encoded);
        const decoded = new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
        expect(decoded).toBe(json);
        expect(JSON.parse(decoded)).toEqual(sharedSettings);
    });

    it('بدنه‌ی بزرگ (چندصدم کیلوبایت با یونیکد) — بدون خرابی و برش', () => {
        const remark = 'کانفیگ #⚡ — متن فارسی طولانی ';
        const big = {
            customConfigs: Array.from({ length: 2000 }, (_, i) => `vless://u${i}@h${i}.example.com:443#${remark}${i}`)
        };
        const json = JSON.stringify(big);
        expect(json.length).toBeGreaterThan(100_000);

        const encoded = base64EncodeUtf8(json);
        const decoded = base64DecodeUtf8(encoded);
        expect(decoded).toBe(json);
        expect(JSON.parse(decoded).customConfigs).toHaveLength(2000);
    });

    it('کاراکترهای مرزی U+0080..U+00FF — ناحیه‌ای که btoa خام «آرام» ولی غلط کار می‌کند', () => {
        // خروجی btoa خام برای این ناحیه با کدگذاری UTF-8 فرق دارد؛
        // decode سمت پنل UTF-8 است → encode هم باید UTF-8 باشد وگرنه mojibake
        const json = JSON.stringify({ note: 'café ñ ünfähig' });

        const encoded = base64EncodeUtf8(json);
        const decoded = base64DecodeUtf8(encoded);
        expect(JSON.parse(decoded).note).toBe('café ñ ünfähig');
    });
});
