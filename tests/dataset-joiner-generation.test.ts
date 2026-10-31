import { describe, it, expect, beforeAll, afterEach } from 'vitest';

/**
 * v0.8.66 — حفره‌ی joiner در قفل نسل v0.8.55 (src/settings/kv.ts)
 *
 * فیکس v0.8.55 مسابقه‌ی «لود سرد × write» را برای «سازنده‌ی لود» بست: نتیجه‌ی
 * لود فقط وقتی کش می‌شود که در طول لود invalidate‌ای رخ نداده باشد و مصرف‌کننده‌ی
 * هم‌پوشان یک‌بار تازه‌خوانی می‌کند. اما تشخیصِ هم‌پوشانی به snapshot نسلِ لحظه‌ی
 * فراخوانی هر caller اتکا داشت — و callerی که *بعد* از کامیتِ write و *قبل* از
 * resolve لودِ معلق وارد می‌شود (joiner)، snapshot خودش را از قبل bump‌شده
 * می‌گیرد و چک «نسلِ من ≠ نسلِ فعلی» برایش همیشه سبز است:
 *
 *   t0: سازنده getDataset → لود سرد شروع، خواندن proxySettings پشت gate (نسل G)
 *   t1: mutateSettings کامیت می‌شود → put + invalidate (نسل G+1) + syncKvSettings تازه
 *   t2: joiner getDataset → کش null، inflight همان لود معلق → به آن می‌پیوندد،
 *       snapshot خودش G+1 است
 *   t3: gate با blob پیش از نوشتن آزاد می‌شود → لود با دیتای کهنه resolve می‌شود
 *   t4: سازنده: G ≠ G+1 → تازه‌خوانی ✓ (پوشش تست v0.8.55)
 *       joiner:  G+1 === G+1 → دیتای پیش از نوشتن سرو می‌شود ✗
 *
 * و اگر joiner مسیر setSettings باشد (subscription/telegram/clean-ip)، همان
 * دیتای کهنه را روی snapshot ماژول می‌نشد و syncKvSettings تازه را clobber
 * می‌کرد — دقیقاً آسیب کلاس-۲ای که v0.8.55 لیست کرده بود، از مسیر joiner.
 *
 * فیکس: نسلِ شروعِ لودِ درحال‌انجام (inflightGeneration) ثبت می‌شود و چک
 * استالنس همه‌ی مصرف‌کنندگان (سازنده و joiner) بر مبنای نسلِ شروعِ لودی است
 * که به آن پیوسته‌اند — نه snapshot لحظه‌ی فراخوانی خودشان.
 *
 * پوشش این فایل:
 *   ۱) 🔒 joinerِ پس از write دیتای تازه می‌گیرد (RED روی قدیمی)
 *   ۲) 🔒 setSettings به‌عنوان joiner snapshot را clobber نمی‌کند (RED روی قدیمی)
 *   ۳) گارد: joinerِ قبل از write مثل قبل تازه‌خوانی می‌کند (رفتار v0.8.55 دست‌نخورده)
 *   ۴) گارد: stampede سالم — joinerِ بدون write، لود اضافه نمی‌زند (یک get برای دو caller)
 */

(globalThis as any).VERSION = '0.8.66';
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
        panelVersion: '0.8.66',
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
 * تا پنجره‌ی «لود معلق × write کامیت‌شده × joiner» قطعی شود.
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

describe('dataset cache: 🔒 حفره‌ی joiner در قفل نسل (v0.8.66)', () => {
    it('joinerِ واردشده پس از کامیت write و قبل از resolve لود، دیتای تازه می‌گیرد — نه پیش از نوشتن', async () => {
        const gated = createGatedKv({
            proxySettings: fullBlob({ localDNS: '8.8.8.8' }),
            ...HEALTHY_SEED
        });
        const env = { kv: gated.kv } as any;

        // t0 — لود سرد شروع می‌شود و خواندن proxySettings پشت gate معلق می‌ماند
        gated.armGate();
        const creator = kvmod.getDataset(env);
        await sleep(10);

        // blob پیش از نوشتن — همان چیزی که لود معلق «خوانده» است
        const preWriteBlob = JSON.parse(gated.store.get('proxySettings')!);

        // t1 — write کامل در میانه‌ی لود: put + invalidate + sync
        await store.mutateSettings(
            env,
            cur => ({ ...cur!, localDNS: '9.9.9.9' }),
            { reason: 'test:joiner-write' }
        );
        expect(JSON.parse(gated.store.get('proxySettings')!).localDNS).toBe('9.9.9.9');

        // t2 — joiner بعد از invalidate وارد می‌شود و به لودِ معلقِ پیش از نوشتن می‌پیوندد
        const joiner = kvmod.getDataset(env);

        // t3 — لودِ کهنه با blob پیش از نوشتن تمام می‌شود
        gated.releaseGate(preWriteBlob);
        const rj = await joiner;
        const rc = await creator;

        // joiner نباید دیتای پیش از نوشتن را «تازه» سرو کند
        expect(rj.settings.localDNS).toBe('9.9.9.9');
        // سازنده هم مثل v0.8.55 تازه می‌خواند
        expect(rc.settings.localDNS).toBe('9.9.9.9');

        // لود سرد + خواندنِ داخل صف write + یک لود تازه‌خوانی مشترک — بدون انفجار stampede
        expect(gated.getSettingsGetCalls()).toBe(3);
    });

    it('setSettings به‌عنوان joiner، snapshot ماژول را با دیتای پیش از نوشتن clobber نمی‌کند', async () => {
        const gated = createGatedKv({
            proxySettings: fullBlob({ localDNS: '8.8.8.8' }),
            ...HEALTHY_SEED
        });
        const env = { kv: gated.kv } as any;

        // سازنده‌ی لود معلق
        gated.armGate();
        const creator = kvmod.getDataset(env);
        await sleep(10);

        const preWriteBlob = JSON.parse(gated.store.get('proxySettings')!);

        // tuner در میانه‌ی لود کامیت می‌کند — syncKvSettings عمداً snapshot را تازه می‌کند
        await store.mutateSettings(
            env,
            cur => ({ ...cur!, localDNS: '9.9.9.9' }),
            { reason: 'test:joiner-snapshot-write' }
        );
        expect(settings.getKvSettings().localDNS).toBe('9.9.9.9'); // sync تازه

        // ورودی subscription به‌عنوان joiner به لودِ کهنه می‌پیوندد — روی کد قدیمی
        // همین‌جا snapshot تازه با 8.8.8.8 clobber می‌شد
        const loader = settings.setSettings(env);

        gated.releaseGate(preWriteBlob);
        await loader;
        await creator;

        expect(settings.getKvSettings().localDNS).toBe('9.9.9.9');
    });

    it('گارد: joinerِ واردشده قبل از write مثل v0.8.55 تازه‌خوانی می‌کند', async () => {
        const gated = createGatedKv({
            proxySettings: fullBlob({ localDNS: '8.8.8.8' }),
            ...HEALTHY_SEED
        });
        const env = { kv: gated.kv } as any;

        // t0 — لود سرد پشت gate
        gated.armGate();
        const creator = kvmod.getDataset(env);
        await sleep(10);

        // t2' — joiner قبل از write می‌پیوندد (snapshot خودش G است)
        const joiner = kvmod.getDataset(env);

        // t1 — write در میانه‌ی لود
        const preWriteBlob = JSON.parse(gated.store.get('proxySettings')!);
        await store.mutateSettings(
            env,
            cur => ({ ...cur!, localDNS: '9.9.9.9' }),
            { reason: 'test:early-joiner-write' }
        );

        gated.releaseGate(preWriteBlob);
        const rj = await joiner;
        const rc = await creator;

        // هر دو باید تازه بخوانند — این رفتار از v0.8.55 درست بود و نباید خراب شود
        expect(rj.settings.localDNS).toBe('9.9.9.9');
        expect(rc.settings.localDNS).toBe('9.9.9.9');
    });

    it('گارد: stampede سالم — joinerِ بدون write لود اضافه نمی‌زند (یک get برای دو caller)', async () => {
        const gated = createGatedKv({
            proxySettings: fullBlob(),
            ...HEALTHY_SEED
        });
        const env = { kv: gated.kv } as any;

        // دو caller هم‌زمان — دوم به inflight اول می‌پیوندد
        const a = kvmod.getDataset(env);
        const b = kvmod.getDataset(env);
        const [ra, rb] = await Promise.all([a, b]);

        expect(ra.settings.localDNS).toBe('8.8.8.8');
        expect(rb.settings.localDNS).toBe('8.8.8.8');
        expect(gated.getSettingsGetCalls()).toBe(1);
    });
});
