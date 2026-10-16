import { describe, it, expect, beforeEach, beforeAll } from 'vitest';

// ماژول‌های routing از @settings وارد می‌شوند که در بارگذاری به VERSION نیاز دارد —
// پس import داینامیک در beforeAll است (هم‌الگوی auth.test.ts / doh.test.ts)
(globalThis as any).VERSION = '0.6.0';

let TELEGRAM_DOMAINS: string[];
let TELEGRAM_IPS: string[];
let getKvSettings: () => any;
let buildXrRules: (...args: boolean[]) => any[];
let buildSbRules: (isWarp: boolean) => any;
let buildClRules: (isWarp: boolean) => string[];
let buildTelegramGuideText: () => string;

beforeAll(async () => {
    ({ TELEGRAM_DOMAINS, TELEGRAM_IPS } = await import('../src/cores/utils'));
    ({ getKvSettings } = await import('../src/settings/settings'));
    ({ buildRoutingRules: buildXrRules } = await import('../src/cores/xray/routing'));
    ({ buildRoutingRules: buildSbRules } = await import('../src/cores/sing-box/routing'));
    ({ buildRoutingRules: buildClRules } = await import('../src/cores/clash/routing'));
    ({ buildTelegramGuideText } = await import('../src/api/telegram-broadcast'));
});

const reset = () => {
    Object.assign(getKvSettings(), {
        telegramProxy: true,
        bypassIran: false,
        bypassChina: false,
        bypassRussia: false,
        blockUDP443: false
    });
};

beforeEach(reset);

// ---------- ثابت‌های مشترک ----------

describe('Telegram routing constants', () => {
    it('دامنه‌های رسمی تلگرام را پوشش می‌دهد و تکراری ندارد', () => {
        for (const domain of ['t.me', 'telegram.org', 'cdn-telegram.org', 'telesco.pe']) {
            expect(TELEGRAM_DOMAINS).toContain(domain);
        }
        expect(new Set(TELEGRAM_DOMAINS).size).toBe(TELEGRAM_DOMAINS.length);
    });

    it('رنج‌های رسمی دیتاسنترهای تلگرام — IPv4 و IPv6 با CIDR معتبر', () => {
        expect(TELEGRAM_IPS).toContain('149.154.160.0/20');
        expect(TELEGRAM_IPS).toContain('91.108.4.0/22');
        expect(TELEGRAM_IPS.some(ip => ip.startsWith('2001:'))).toBe(true);

        const cidrRe = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,3}$|^[0-9a-f:]+\/\d{1,3}$/i;
        for (const ip of TELEGRAM_IPS) {
            expect(ip).toMatch(cidrRe);
        }
        expect(new Set(TELEGRAM_IPS).size).toBe(TELEGRAM_IPS.length);
    });
});

// ---------- Xray ----------

describe('Xray — telegram routing', () => {
    it('در حالت عادی: قوانین domain + ip با خروجی proxy، قبل از قوانین block/bypass', () => {
        getKvSettings().bypassIran = true; // باید تلگرام را خنثی کند
        const rules = buildXrRules(false, false, false, false);

        const tgDomainRule = rules.find(r => r.domain?.includes('domain:t.me'));
        const tgIpRule = rules.find(r => r.ip?.includes('149.154.160.0/20'));

        expect(tgDomainRule).toBeDefined();
        expect(tgDomainRule!.outboundTag).toBe('proxy');
        expect(tgIpRule).toBeDefined();
        expect(tgIpRule!.outboundTag).toBe('proxy');
        expect(tgIpRule!.ip).toContain('geoip:telegram');
        expect(tgIpRule!.ip).toContain('91.108.4.0/22');

        // اولویت: قانون تلگرام قبل از هر قانون bypass/direct با geosite
        const tgIndex = rules.indexOf(tgDomainRule!);
        const irIndex = rules.findIndex(r => r.domain?.includes('geosite:category-ir'));
        expect(irIndex).toBeGreaterThan(-1);
        expect(tgIndex).toBeLessThan(irIndex);
    });

    it('حالت chain و balancer — خروجی مطابق خروجی نهایی', () => {
        const chainRules = buildXrRules(true, false, false, false);
        expect(chainRules.find(r => r.domain?.includes('domain:t.me'))!.outboundTag).toBe('chain');

        const balancerRules = buildXrRules(false, true, false, false);
        const tgRule = balancerRules.find(r => r.domain?.includes('domain:t.me'));
        expect(tgRule!.balancerTag).toBe('all-proxies');
        expect(tgRule!.outboundTag).toBeUndefined();
    });

    it('حالت workerless — قوانین تلگرام تزریق نمی‌شوند (اولویت fragment حفظ می‌شود)', () => {
        const rules = buildXrRules(false, false, true, false);
        expect(rules.some(r => r.domain?.includes('domain:t.me'))).toBe(false);
        expect(rules.some(r => r.ip?.includes('149.154.160.0/20'))).toBe(false);
    });

    it('telegramProxy=false — هیچ قانون تلگرامی تزریق نمی‌شود', () => {
        getKvSettings().telegramProxy = false;
        const rules = buildXrRules(false, false, false, false);
        expect(rules.some(r => r.domain?.includes('domain:t.me'))).toBe(false);
        expect(rules.some(r => r.ip?.includes('149.154.160.0/20'))).toBe(false);
    });
});

// ---------- sing-box ----------

describe('sing-box — telegram routing', () => {
    it('قوانین domain_suffix و ip_cidr با خروجی Selector، قبل از قوانین bypass', () => {
        getKvSettings().bypassIran = true;
        const route = buildSbRules(false);

        const tgDomain = route.rules.find(r => r.domain_suffix?.includes('t.me'));
        const tgIps = route.rules.find(r => Array.isArray(r.ip_cidr) && r.ip_cidr.includes('149.154.160.0/20'));

        expect(tgDomain).toBeDefined();
        expect(tgDomain!.outbound).toBe('✅ Selector');
        expect(tgIps).toBeDefined();

        const tgIndex = route.rules.indexOf(tgDomain!);
        const irIndex = route.rules.findIndex(r => r.rule_set?.includes('geosite-ir'));
        expect(irIndex).toBeGreaterThan(-1);
        expect(tgIndex).toBeLessThan(irIndex);
    });

    it('UDP تلگرام همچنان reject می‌ماند (ورکر UDP غیر-DNS حمل نمی‌کند)', () => {
        const route = buildSbRules(false);
        const udpRejectIndex = route.rules.findIndex(r => r.network === 'udp' && r.action === 'reject');
        expect(udpRejectIndex).toBeGreaterThan(-1);
        // هیچ قانون تلگرامی با network udp وجود ندارد
        expect(route.rules.some(r => r.network === 'udp' && r.domain_suffix?.includes('t.me'))).toBe(false);
    });

    it('telegramProxy=false — بدون قوانین تلگرام', () => {
        getKvSettings().telegramProxy = false;
        const route = buildSbRules(false);
        expect(route.rules.some(r => r.domain_suffix?.includes('t.me'))).toBe(false);
    });
});

// ---------- Clash ----------

describe('Clash — telegram routing', () => {
    it('قوانین DOMAIN-SUFFIX و IP-CIDR (no-resolve) با خروجی Selector، قبل از bypass', () => {
        getKvSettings().bypassIran = true;
        const rules = buildClRules(false);

        const tgDomainIndex = rules.indexOf('DOMAIN-SUFFIX,t.me,✅ Selector');
        expect(tgDomainIndex).toBeGreaterThan(-1);
        expect(rules).toContain('IP-CIDR,149.154.160.0/20,✅ Selector,no-resolve');
        expect(rules).toContain('IP-CIDR,91.108.4.0/22,✅ Selector,no-resolve');

        // بعد از NETWORK,udp,REJECT (تماس UDP وضعیت قبل را دارد) و قبل از bypass ایران
        const udpIndex = rules.indexOf('NETWORK,udp,REJECT');
        const irIndex = rules.indexOf('RULE-SET,ir,DIRECT');
        expect(udpIndex).toBeGreaterThan(-1);
        expect(tgDomainIndex).toBeGreaterThan(udpIndex);
        expect(irIndex).toBeGreaterThan(tgDomainIndex);
    });

    it('telegramProxy=false — بدون قوانین تلگرام', () => {
        getKvSettings().telegramProxy = false;
        const rules = buildClRules(false);
        expect(rules.some(r => r.startsWith('DOMAIN-SUFFIX,t.me'))).toBe(false);
        expect(rules.some(r => r.includes('149.154.160.0/20'))).toBe(false);
    });
});

// ---------- راهنمای بات ----------

describe('buildTelegramGuideText', () => {
    it('راهنمای کامل با هر سه پلتفرم + توضیح MTProto + تماس‌ها', () => {
        const text = buildTelegramGuideText();

        expect(text).toContain('v2rayNG');
        expect(text).toContain('Streisand');
        expect(text).toContain('Warp');
        expect(text).toContain('MTProto');
        expect(text).toContain('raw TCP');
        expect(text).toContain('subscription');
    });

    it('بدون کاراکتر خطرناک HTML (parse_mode HTML)', () => {
        const text = buildTelegramGuideText();
        expect(text).not.toMatch(/<(?!\/?b>|\/?i>)/);
    });
});
