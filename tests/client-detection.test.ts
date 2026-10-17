import { describe, expect, it } from 'vitest';
import { detectClientFromUA, resolveClientApp } from '../src/settings/client-detect';

describe('resolveClientApp — پارامتر app اشتراک', () => {
    it('core های دقیق را بدون تغییر پاس می‌دهد (حروف بزرگ/کوچک و فاصله هم)', () => {
        expect(resolveClientApp('xray', null)).toBe('xray');
        expect(resolveClientApp('sing-box', null)).toBe('sing-box');
        expect(resolveClientApp('clash', null)).toBe('clash');
        expect(resolveClientApp('xray-knocker', null)).toBe('xray-knocker');
        expect(resolveClientApp('wireguard', null)).toBe('wireguard');
        expect(resolveClientApp('amnezia', null)).toBe('amnezia');
        expect(resolveClientApp(' XRay ', null)).toBe('xray');
        expect(resolveClientApp('SING-BOX', null)).toBe('sing-box');
    });

    it('نام‌های قدیمی کلاینت‌ها (BPB) را به core نگاشت می‌کند', () => {
        expect(resolveClientApp('v2rayNG', '')).toBe('xray');
        expect(resolveClientApp('v2rayN', '')).toBe('xray');
        expect(resolveClientApp('v2rayN-PRO', '')).toBe('xray-knocker');
        expect(resolveClientApp('MahsaNG', '')).toBe('xray');
        expect(resolveClientApp('Streisand', '')).toBe('xray');
        expect(resolveClientApp('Shadowrocket', '')).toBe('xray');
        expect(resolveClientApp('Hiddify', '')).toBe('sing-box');
        expect(resolveClientApp('NekoBox', '')).toBe('sing-box');
        expect(resolveClientApp('Karing', '')).toBe('sing-box');
        expect(resolveClientApp('Clash Meta', '')).toBe('clash');
        expect(resolveClientApp('Clash Verge', '')).toBe('clash');
        expect(resolveClientApp('FlClash', '')).toBe('clash');
        expect(resolveClientApp('Stash', '')).toBe('clash');
        expect(resolveClientApp('Amnezia', '')).toBe('amnezia');
        expect(resolveClientApp('WG Tunnel', '')).toBe('amnezia');
        expect(resolveClientApp('Wireguard', '')).toBe('wireguard');
    });

    it('app ناشناس → تشخیص از User-Agent', () => {
        expect(resolveClientApp('foo', 'v2rayNG/1.8.23')).toBe('xray');
        expect(resolveClientApp('unknown-app', 'HiddifyNext/2.0.5 (Android)')).toBe('sing-box');
        expect(resolveClientApp('whatever', 'ClashMetaForAndroid/2.11.31')).toBe('clash');
    });

    it('app حذف‌شده → تشخیص از User-Agent (کلاینت‌هایی که query را می‌برند)', () => {
        expect(resolveClientApp('', 'v2rayNG/1.8.23')).toBe('xray');
        expect(resolveClientApp('', 'v2rayN/7.22.5')).toBe('xray');
        expect(resolveClientApp('', 'Hiddify/2.0.5')).toBe('sing-box');
        expect(resolveClientApp('', 'sing-box 1.12.0')).toBe('sing-box');
        expect(resolveClientApp('', 'NekoBoxForAndroid/1.3.2')).toBe('sing-box');
        expect(resolveClientApp('', 'Karing/1.2.1')).toBe('sing-box');
        expect(resolveClientApp('', 'clash-verge/v2.5.1')).toBe('clash');
        expect(resolveClientApp('', 'Streisand/1.6.71')).toBe('xray');
        expect(resolveClientApp('', 'MahsaNG/17.0')).toBe('xray');
        expect(resolveClientApp('', 'AmneziaWG/4.8.21.0')).toBe('amnezia');
        expect(resolveClientApp('', 'WG Tunnel/5.1.0')).toBe('amnezia');
        expect(resolveClientApp('', 'com.wireguard.android/1.0')).toBe('wireguard');
    });

    it('بدون app و بدون UA شناخته‌شده → پیش‌فرض xray (رفتار BPB)', () => {
        expect(resolveClientApp('', null)).toBe('xray');
        expect(resolveClientApp('', undefined)).toBe('xray');
        expect(resolveClientApp('', 'curl/8.6.0')).toBe('xray');
        expect(resolveClientApp('', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('xray');
        expect(resolveClientApp('', '')).toBe('xray');
    });

    it('v2rayNG قبل از v2rayN چک می‌شود (زیررشته)', () => {
        expect(detectClientFromUA('v2rayNG/1.8.23')).toBe('xray');
        expect(detectClientFromUA('v2rayN/7.22.5')).toBe('xray');
    });
});
