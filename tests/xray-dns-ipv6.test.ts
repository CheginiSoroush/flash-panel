import { describe, it, expect, beforeAll, vi } from 'vitest';

/**
 * v0.8.32 — پارامتر وارونه‌ی resolveDNS در buildDNS سابت‌باکس Xray (src/cores/xray/dns.ts)
 *
 * کلاس باگ: buildDNS برای پین‌کردن IPهای استاتیک دامنه (domainToStaticIPs — تنها
 * مصرف‌کننده: کانفیگ «⚡ Smart Fragment 🧠» که mainDomain را پین می‌کند تا کلاینت
 * بدون DNS bootstrap وصل شود) این‌طور صدا می‌زد:
 *     resolveDNS(domainToStaticIPs, enableIPv6)        // ❌ فقط‌IPv4 = enableIPv6 !!
 * در حالی که قرارداد resolveDNS(domain, onlyIPv4) است و همه‌ی فراخوان‌های دیگر
 * (getConfigAddresses در cores/utils) درست «!enableIPv6» می‌فرستند. نتیجه‌ی وارونه:
 *   • enableIPv6=true  → فقط A کوئری می‌خورد → پین استاتیک بدون هیچ AAAA → کلاینت
 *     IPv6-خواه (شبکه‌های موبایل v6-only) مسیر edge را از دست می‌دهد.
 *   • enableIPv6=false → A+AAAA کوئری می‌خورد → رکوردهای مرده در hosts (با
 *     queryStrategy=UseIPv4 هرگز استفاده نمی‌شوند) + یک کوئری AAAA بیهوده.
 *
 * قرارداد درست: پین استاتیک باید عین سیاست IPv6 ادمین باشد — resolveDNS(d, !enableIPv6).
 * استراتژی تست: استاب DoH سطح fetch (الگوی sing-box-config.test.ts) — resolveDNS
 * واقعی (کش/single-flight) بدون شبکه اجرا می‌شود و نتیجه از روی «محتوای hosts»
 * ادعا می‌شود، نه از روی آرگومان تابع.
 */

const MOCK_EMBEDED = {
    accID: 'test-account-id',
    accEmail: 'admin@example.com',
    apiToken: 'api-token',
    vlUUID: 'b831381d-6324-4d53-ad4f-8cda48b30811',
    trPass: 'trojan-pass',
    securePath: 'sp',
    proxyIpMode: 'public',
    proxyIPs: [] as string[],
    prefixes: [] as string[],
    mainDomain: 'example.com',
    fallback: '',
    dohUrl: ''
};

(globalThis as any).EMBEDED_SETTINGS = MOCK_EMBEDED;
(globalThis as any).VERSION = '0.8.32';

// ---------- استاب DoH — جواب قطعی A + AAAA برای example.com ----------

/** ثبت کوئری‌های رسیده برای ادعای ترکیب qtype در تست‌ها */
const dohQueries: Array<{ name: string; type: string }> = [];

vi.stubGlobal('fetch', vi.fn(async (input: any) => {
    const url = String(input instanceof URL ? input : input?.url ?? input);
    if (url.includes('cloudflare-dns.com')) {
        const u = new URL(url);
        const name = u.searchParams.get('name') ?? '';
        const type = u.searchParams.get('type') ?? '';
        if (name === 'example.com') dohQueries.push({ name, type });

        const answer = name === 'example.com' && type === 'A'
            ? [{ type: 1, TTL: 300, data: '1.2.3.4' }]
            : name === 'example.com' && type === 'AAAA'
                ? [{ type: 28, TTL: 300, data: '2606:4700:4700::1111' }]
                : [];

        return new Response(JSON.stringify({ Answer: answer }), {
            headers: { 'content-type': 'application/dns-json' }
        });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
}));

// ---------- KV mock ----------

const store = new Map<string, string>();
const kvMock = {
    async get(key: string, opts?: { type?: string }) {
        const raw = store.get(key);
        if (raw === undefined) return null;
        return opts?.type === 'json' ? JSON.parse(raw) : raw;
    },
    async put(key: string, value: string) { store.set(key, value); },
    async delete(key: string) { store.delete(key); }
} as unknown as KVNamespace;

let settings: typeof import('../src/settings/settings');
let storeMod: typeof import('../src/settings/store');
let buildDNS: typeof import('../src/cores/xray/dns')['buildDNS'];

beforeAll(async () => {
    settings = await import('../src/settings/settings');
    storeMod = await import('../src/settings/store');
    const dns = await import('../src/cores/xray/dns');
    buildDNS = dns.buildDNS;

    settings.init(
        new Request('https://example.com/sp/sub/fragment?app=xray'),
        { kv: kvMock } as unknown as Env
    );
    await settings.setSettings({ kv: kvMock } as unknown as Env);
});

/** چرخش enableIPv6 از طریق صف نوشتن رسمی + سینک دوباره‌ی state ماژول */
async function setIPv6(enabled: boolean) {
    await storeMod.mutateSettings(
        { kv: kvMock } as unknown as Env,
        cur => ({ ...cur!, enableIPv6: enabled }),
        { reason: `test:ipv6-${enabled}` }
    );
    await settings.setSettings({ kv: kvMock } as unknown as Env);
    expect(settings.getSettings().enableIPv6).toBe(enabled); // state واقعاً چرخید
}

describe('buildDNS xray — پین استاتیک دامنه باید از سیاست enableIPv6 پیروی کند (v0.8.32)', () => {

    it('🔴 enableIPv6=true → پین mainDomain باید AAAA داشته باشد (شبکه‌ی v6-only مسیر edge را از دست نمی‌دهد)', async () => {
        await setIPv6(true);
        dohQueries.length = 0;

        const dns = await buildDNS(['example.com'], false, false, 'example.com');
        const pinned = dns.hosts!['example.com'];

        // کوئری AAAA واقعاً برای دامنه‌ی پین‌شده زده شده باشد
        expect(dohQueries.some(q => q.type === 'AAAA')).toBe(true);
        // کد قدیمی: فقط A کوئری می‌خورد → پین بدون IPv6 → کلاینت v6-only بی‌مسیر
        expect(pinned).toContain('2606:4700:4700::1111');
        expect(pinned).toContain('1.2.3.4');
    });

    it('🔴 enableIPv6=false → پین فقط IPv4 باشد (بدون AAAA مرده‌ی غیرقابل‌استفاده زیر queryStrategy=UseIPv4)', async () => {
        await setIPv6(false);
        dohQueries.length = 0;

        const dns = await buildDNS(['example.com'], false, false, 'example.com');
        const pinned = dns.hosts!['example.com'];

        // هیچ کوئری AAAA بیهوده‌ای نزده باشد
        expect(dohQueries.some(q => q.type === 'AAAA')).toBe(false);
        // کد قدیمی: AAAA هم resolve و پین می‌شود — رکورد مرده
        expect(pinned).not.toContain('2606:4700:4700::1111');
        expect(pinned).toEqual(['1.2.3.4']);
    });
});
