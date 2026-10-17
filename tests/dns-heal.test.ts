import { describe, it, expect, beforeEach, afterEach, vi, beforeAll } from 'vitest';

// ---------- self-heal ریموت DNS ----------
// remoteDNS دامنه‌ای + remoteDnsHost کهنه/ناسازگار → بازسازی + persist یک‌بار

(globalThis as any).VERSION = '0.7.9';
(globalThis as any)._repo_ = 'https://github.com/CheginiSoroush/flash-panel';
(globalThis as any)._public_proxy_ip_ = 'bpb.yousef.isegaro.com';

const DOH_DOMAIN = 'doh-heal-test.example';

let kvMod: typeof import('../src/settings/kv');
let utilsMod: typeof import('@utils');

beforeAll(async () => {
    kvMod = await import('../src/settings/kv');
    utilsMod = await import('@utils');
});

function dnsJson(records: Array<{ type: number; TTL: number; data: string }>) {
    return new Response(JSON.stringify({ Answer: records }), { status: 200 });
}

const A_RECORD = { type: 1, TTL: 300, data: '1.2.3.4' };

function createKvMock() {
    const store = new Map<string, string>();
    let putCount = 0;
    const kv = {
        async get(key: string, opts?: { type?: string }) {
            const raw = store.get(key);
            if (raw === undefined) return null;
            return opts?.type === 'json' ? JSON.parse(raw) : raw;
        },
        async put(key: string, value: string) {
            putCount++;
            store.set(key, value);
        },
        async delete(key: string) {
            store.delete(key);
        }
    } as unknown as KVNamespace;
    return { kv, store, getPutCount: () => putCount };
}

beforeEach(() => {
    utilsMod.clearDnsCache();
    vi.stubGlobal('fetch', vi.fn(async (input: any) => {
        const url = String(input instanceof URL ? input.href : input);
        if (url.includes(`name=${DOH_DOMAIN}&type=A`)) return dnsJson([A_RECORD]);
        if (url.includes(`name=${DOH_DOMAIN}&type=AAAA`)) return dnsJson([]);
        return new Response('{}', { status: 404 });
    }));
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('healRemoteDnsHost', () => {
    const DOMAIN_DNS = `https://${DOH_DOMAIN}/dns-query/abc123`;

    it('stale remoteDnsHost + domain-based remoteDNS → rebuilt, pinned IPs, one KV write', async () => {
        const { kv, store, getPutCount } = createKvMock();

        const settings = {
            remoteDNS: DOMAIN_DNS,
            remoteDnsHost: { host: '8.8.8.8', isDomain: false, ipv4: [], ipv6: [] } // کهنه!
        } as any;

        const healed = await kvMod.healRemoteDnsHost({ kv } as Env, settings);

        expect(healed.remoteDnsHost).toEqual({
            host: DOH_DOMAIN,
            isDomain: true,
            ipv4: ['1.2.3.4'],
            ipv6: []
        });
        expect(getPutCount()).toBe(1);
        expect(JSON.parse(store.get('proxySettings')!).remoteDnsHost.host).toBe(DOH_DOMAIN);
    });

    it('already aligned → untouched, zero writes', async () => {
        const { kv, getPutCount } = createKvMock();

        const settings = {
            remoteDNS: DOMAIN_DNS,
            remoteDnsHost: { host: DOH_DOMAIN, isDomain: true, ipv4: ['9.9.9.9'], ipv6: [] }
        } as any;

        const result = await kvMod.healRemoteDnsHost({ kv } as Env, settings);

        expect(result).toBe(settings); // همان آبجکت — بدون تغییر
        expect(getPutCount()).toBe(0);
    });

    it('IP-based remoteDNS → nothing to pin, no fetch, no write', async () => {
        const { kv, getPutCount } = createKvMock();

        const settings = {
            remoteDNS: 'https://8.8.8.8/dns-query',
            remoteDnsHost: { host: '8.8.8.8', isDomain: false, ipv4: [], ipv6: [] }
        } as any;

        const result = await kvMod.healRemoteDnsHost({ kv } as Env, settings);

        expect(result).toBe(settings);
        expect(getPutCount()).toBe(0);
    });

    it('DNS resolution failure → returns original settings without throwing', async () => {
        const { kv, getPutCount } = createKvMock();

        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('doh down'); }));

        const settings = {
            remoteDNS: DOMAIN_DNS,
            remoteDnsHost: { host: '8.8.8.8', isDomain: false, ipv4: [], ipv6: [] }
        } as any;

        const result = await kvMod.healRemoteDnsHost({ kv } as Env, settings);

        expect(result).toBe(settings); // best-effort — بدون تغییر و بدون crash
        expect(getPutCount()).toBe(0);
    });
});
