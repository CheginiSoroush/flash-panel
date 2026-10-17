import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

// globals حداقلی — الگوی telegram-routing.test.ts
(globalThis as any).VERSION = '0.7.6';

let getKvSettings: () => any;
let buildXrRules: (isChain: boolean, isBalancer: boolean, isWorkerless: boolean, isWarp: boolean) => any[];
let buildSbRules: (isWarp: boolean) => any;
let buildClRules: (isWarp: boolean) => string[];
let buildXrDns: (...args: any[]) => Promise<any>;

beforeAll(async () => {
    ({ getKvSettings } = await import('@settings'));
    ({ buildRoutingRules: buildXrRules } = await import('@xray/routing'));
    ({ buildRoutingRules: buildSbRules } = await import('@sing-box/routing'));
    ({ buildRoutingRules: buildClRules } = await import('@clash/routing'));
    ({ buildDNS: buildXrDns } = await import('@xray/dns'));
});

const reset = (over: Record<string, unknown> = {}) => {
    Object.assign(getKvSettings(), {
        telegramProxy: false,
        blockUDP443: false,
        enableIPv6: false,
        ...over
    });
};

describe('ضدسوءاستفاده — BT و SMTP در همه‌ی کرنل‌ها بلاک می‌شوند', () => {
    beforeEach(reset);

    it('xray: قانون protocol bittorrent → block و port 25 tcp → block، قبل از block/bypass کاربر', () => {
        const rules = buildXrRules(false, false, false, false);
        const bt = rules.findIndex(r => r.protocol?.includes('bittorrent') && r.outboundTag === 'block');
        const smtp = rules.findIndex(r => r.port === 25 && r.network === 'tcp' && r.outboundTag === 'block');
        expect(bt).toBeGreaterThan(-1);
        expect(smtp).toBeGreaterThan(-1);
        // باید بعد از private و قبل از قوانین geo کاربر (block/bypass) باشند
        const privateIdx = rules.findIndex(r => r.domain?.includes('geosite:private'));
        const firstUserGeo = rules.findIndex(r =>
            !r.inboundTag && !r.protocol && r.network === undefined &&
            (r.domain?.length || r.ip?.length) &&
            !r.domain?.includes('geosite:private') && !r.ip?.includes('geoip:private')
        );
        expect(bt).toBeGreaterThan(privateIdx);
        expect(smtp).toBeGreaterThan(privateIdx);
        if (firstUserGeo > -1) {
            expect(bt).toBeLessThan(firstUserGeo);
            expect(smtp).toBeLessThan(firstUserGeo);
        }
    });

    it('sing-box: قانون protocol bittorrent → reject و port 25 → reject', () => {
        const route = buildSbRules(false);
        expect(route.rules.some((r: any) => r.protocol === 'bittorrent' && r.action === 'reject')).toBe(true);
        expect(route.rules.some((r: any) => r.port === 25 && r.action === 'reject')).toBe(true);
    });

    it('clash: قانون DST-PORT,25,REJECT', () => {
        const rules = buildClRules(false);
        expect(rules).toContain('DST-PORT,25,REJECT');
        // بعد از GEOIP,lan و قبل از MATCH
        expect(rules.indexOf('DST-PORT,25,REJECT')).toBeLessThan(rules.indexOf('MATCH,✅ Selector'));
    });

    it('workerless هم BT/SMTP را بلاک می‌کند (قوانین fragment بعد از آن‌ها می‌آیند)', () => {
        const rules = buildXrRules(false, false, true, false);
        const bt = rules.findIndex(r => r.protocol?.includes('bittorrent') && r.outboundTag === 'block');
        const frag = rules.findIndex(r => r.protocol?.includes('tls'));
        expect(bt).toBeGreaterThan(-1);
        expect(frag).toBeGreaterThan(bt);
    });
});

describe('queryStrategy DNS اکسترا — بدون IPv6 فقط A کوئری بزن', () => {
    beforeEach(reset);

    it('enableIPv6=false → UseIPv4 (حتی در مدهای عادی و warp)', async () => {
        reset({ enableIPv6: false });
        for (const isWarp of [false, true]) {
            const dns = await buildXrDns([], false, isWarp);
            expect(dns.queryStrategy).toBe('UseIPv4');
        }
    });

    it('enableIPv6=true → UseIP (رفتار قبلی حفظ)', async () => {
        reset({ enableIPv6: true });
        const dns = await buildXrDns([], false, false);
        expect(dns.queryStrategy).toBe('UseIP');
    });
});
