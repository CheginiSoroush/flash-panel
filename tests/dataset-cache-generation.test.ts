import { describe, it, expect, beforeAll, afterEach } from 'vitest';

/**
 * v0.8.55 — مسابقه‌ی «لود درحال‌انجام × write» در کش دیتاست (kv.ts)
 *
 * کلاس باگ (ثبت‌شده در دور دوم ممیزی iter 17 و دور سوم iter 27 — «برای دور بعد»):
 *   لودِ سردی که قبل از یک write هم‌ایزوله شروع شده بود، وقتی resolve می‌شد،
 *   thenِ آن cache را با «دیتای پیش از نوشتن» دوباره پر می‌کرد و invalidate‌ای
 *   که commitSettingsBlob تازه زده بود را خنثی می‌ساخت:
 *     ۱) تا ۵ ثانیه (TTL) تنظیماتِ پیش از write سرو می‌شد؛
 *     ۲) بدتر — setSettings (ورودی subscription/telegram/clean-ip) همان دیتای
 *        کهنه را روی snapshot ماژول می‌نشت و syncKvSettings تازه را clobber می‌کرد.
 *
 * صحنه‌آرایی قطعی: get اولِ proxySettings پشت یک gate نگه داشته می‌شود؛ وسطِ
 * همان لود، یک mutateSettings کامل (خواندن تازه داخل صف + put + invalidate +
 * sync) تمام می‌شود؛ بعد gate با blobِ پیش از نوشتن آزاد می‌شود.
 *
 * پوشش این فایل:
 *   ۱) 🔒 مصرف‌کننده‌ی هم‌پوشان دیتای تازه می‌گیرد و کش آلوده نمی‌شود (RED روی قدیمی)
 *   ۲) 🔒 setSettings بعد از هم‌پوشانی snapshot تازه می‌نشد، نه پیش از نوشتن (RED روی قدیمی)
 *   ۳) گارد: بدون write هم‌پوشان، کش ۵ ثانیه‌ای سر جایش است (یک get برای دو getDataset)
 */

(globalThis as any).VERSION = '0.8.55';
(globalThis as any)._repo_ = 'https://github.com/CheginiSoroush/flash-panel';
(globalThis as any)._public_proxy_ip_ = 'bpb.yousef.isegaro.com';
(globalThis as any).EMBEDED_SETTINGS = {
    accID: 'test-account-id',
    accEmail: 'admin@example.com',
    apiToken: 'api-token',
    vlUUID: 'b831381d-6324-4d53-ad4f-8cda48b30811',
    trPass: 'trojan-pass',
    securePath: 'sp',
    proxyIpMode: 'proxyip',
    proxyIPs: [] as string[],
    prefixes: [] as string[],
    forceProxyDomains: [],
    mainDomain: 'example.com',
    fallback: '',
    dohUrl: ''
};

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** blob کاملِ امن — مهاجرت/هیل/bootstrap هیچ‌کدام شبکه نمی‌زنند */
function fullBlob(overrides: Record<string, unknown> = {}) {
    return {
        panelVersion: '0.8.55',
        remoteDNS: '1.1.1.1',
        remoteDnsHost: { host: '1.1.1.1', isDomain: false, ipv4: [], ipv6: [] },
        customDomain: '',
        upstreamProxy: '',
        chainProxy: '',
        ports: [443],
        localDNS: '8.8.8.8',
        bypassIran: false,
        cleanIPs: ['104.16.160.3'],
        ...overrides
    };
}

const HEALTHY_SEED = {
    warpAccounts: [
        { privateKey: 'k1', publicKey: 'K1', warpIPv6: '2606:4700::1/128', reserved: 'AAAA' },
        { privateKey: 'k2', publicKey: 'K2', warpIPv6: '2606:4700::2/128', reserved: 'BBBB' }
    ],
    telegramBot: { telegramBotToken: '', telegramUserId: '' }
};

/**
 * KV ماک با gate — اولین get بعد از armGate روی proxySettings معلق می‌ماند
 * تا صحنه‌ی «لود سرد هم‌پوشان با write» قطعی شود.
 */
function createGatedKv(seed: Record<string, unknown> = {}) {
    const store = new Map<string, string>(
        Object.entries(seed).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])
    );
    let gate: ((value: unknown) => void) | null = null;
    let gateArmed = false;
    let settingsGetCalls = 0;

    const kv = {
        async get(key: string, opts?: { type?: string }) {
            if (key === 'proxySettings') {
                settingsGetCalls++;
                if (gateArmed) {
                    gateArmed = false;
                    return new Promise(resolve => { gate = resolve; });
                }
            }
            const raw = store.get(key);
            if (raw === undefined) return null;
            return opts?.type === 'json' ? JSON.parse(raw) : raw;
        },
        async put(key: string, value: string) {
            store.set(key, value);
        },
        async delete(key: string) {
            store.delete(key);
        }
    } as unknown as KVNamespace;

    return {
        kv,
        store,
        getSettingsGetCalls: () => settingsGetCalls,
        armGate: () => { gateArmed = true; },
        releaseGate: (value: unknown) => { gate?.(value); gate = null; }
    };
}

let settings: typeof import('../src/settings/settings');
let kvmod: typeof import('../src/settings/kv');
let store: typeof import('../src/settings/store');

beforeAll(async () => {
    settings = await import('../src/settings/settings');
    kvmod = await import('../src/settings/kv');
    store = await import('../src/settings/store');

    settings.init(
        new Request('https://example.com/sp/panel', {
            headers: { 'CF-Connecting-IP': '1.2.3.4' }
        }),
        { kv: new Map() } as any
    );
});

afterEach(() => {
    kvmod.invalidateDatasetCache();
    kvmod._resetMigrationThrottleForTest();
    store._resetStoreStateForTest();
});

describe('dataset cache: 🔒 مسابقه‌ی لود سرد × write (v0.8.55)', () => {
    it('لودِ هم‌پوشان با commit، کش را با دیتای پیش از نوشتن آلوده نمی‌کند و مصرف‌کننده‌ی بعدی تازه می‌خواند', async () => {
        const gated = createGatedKv({
            proxySettings: fullBlob({ localDNS: '8.8.8.8' }),
            ...HEALTHY_SEED
        });
        const env = { kv: gated.kv } as any;

        // لود سرد شروع می‌شود و پشت gate می‌ماند
        gated.armGate();
        const coldLoad = kvmod.getDataset(env);
        await sleep(10); // loadDataset به gate برسد

        // blob پیش از نوشتن — همان چیزی که لود معلق «خوانده» است
        const preWriteBlob = JSON.parse(gated.store.get('proxySettings')!);

        // write کامل در میانه‌ی لود: خواندن تازه داخل صف + put + invalidate + sync
        const write = store.mutateSettings(
            env,
            cur => ({ ...cur!, localDNS: '9.9.9.9' }),
            { reason: 'test:interleave' }
        );
        await write;
        expect(JSON.parse(gated.store.get('proxySettings')!).localDNS).toBe('9.9.9.9');

        // لود با دیتای پیش از نوشتن resolve می‌شود — ولی getDataset دیگر همان را
        // برنمی‌گرداند: mismatch نسل → تازه‌خوانی → caller هم‌زمان هم دیتای تازه می‌گیرد
        gated.releaseGate(preWriteBlob);
        const result1 = await coldLoad;
        expect(result1.settings.localDNS).toBe('9.9.9.9');

        // قرارداد: خواننده‌ی بعدی نباید دیتای پیش از نوشتن را از کش بگیرد
        const result2 = await kvmod.getDataset(env);
        expect(result2.settings.localDNS).toBe('9.9.9.9');

        // تازه‌خوانی واقعی رخ داده (get سوم) نه سروِ کش آلوده
        expect(gated.getSettingsGetCalls()).toBe(3);
    });

    it('setSettings بعد از هم‌پوشانی، snapshot ماژول را با دیتای تازه می‌نشد — نه clobber با پیش از نوشتن', async () => {
        const gated = createGatedKv({
            proxySettings: fullBlob({ localDNS: '8.8.8.8' }),
            ...HEALTHY_SEED
        });
        const env = { kv: gated.kv } as any;

        // ورودی subscription: setSettings → getDataset سرد → پشت gate
        gated.armGate();
        const load = settings.setSettings(env);
        await sleep(10);

        const preWriteBlob = JSON.parse(gated.store.get('proxySettings')!);

        // tuner در میانه‌ی لود کامیت می‌کند — syncKvSettings عمداً snapshot را تازه می‌کند
        await store.mutateSettings(
            env,
            cur => ({ ...cur!, localDNS: '9.9.9.9' }),
            { reason: 'test:interleave-snapshot' }
        );
        expect(settings.getKvSettings().localDNS).toBe('9.9.9.9'); // sync تازه

        // لودِ کهنه تمام می‌شود — روی کد قدیمی، همان لحظه snapshot تازه clobber می‌شد
        gated.releaseGate(preWriteBlob);
        await load;

        expect(settings.getKvSettings().localDNS).toBe('9.9.9.9');
    });

    it('گارد: بدون write هم‌پوشان، کش ۵ ثانیه‌ای سر جایش است — دو getDataset فقط یک get', async () => {
        const gated = createGatedKv({
            proxySettings: fullBlob(),
            ...HEALTHY_SEED
        });
        const env = { kv: gated.kv } as any;

        const first = await kvmod.getDataset(env);
        const second = await kvmod.getDataset(env);

        expect(first.settings.localDNS).toBe('8.8.8.8');
        expect(second.settings.localDNS).toBe('8.8.8.8');
        expect(gated.getSettingsGetCalls()).toBe(1); // second از کش — فیکس نباید کش را بی‌جهت بشکند
    });
});
