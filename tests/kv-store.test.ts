import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';

/**
 * v0.8.11 — موتور پایداری proxySettings (src/settings/store)
 *
 * کلاس باگی که این موتور نابود می‌کند:
 *   هر ماژول get→mutate→put دست‌ساز داشت؛ دو context همزمان (پنل + ربات +
 *   cron tuner) blob را روی نسخه‌ی کهنه‌ی خودشان می‌نوشتند و تغییرِ دیگری
 *   بی‌صدا پاک می‌شد (lost update).
 *
 * پوشش این فایل:
 *   ۱) no-op skip — بدون تغییر = بدون put (صرفه‌ی سهمیه‌ی روزانه)
 *   ۲) settingsRev — بامپ فقط روی تغییر واقعی
 *   ۳) 🔒 lost-update — دو تراکنش همزمان روی یک isolate، هر دو باید سبز شوند
 *   ۴) چرخه‌ی سهمیه — 429 واقعی → مهر؛ write ضمنی بعدش skip-fast
 *   ۵) retry خطای گذرا — تلاش دوم موفق
 *   ۶) invalidation کش دیتاست بعد از commit (بدون /restart ادمین)
 */

(globalThis as any).VERSION = '0.8.11';
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
        panelVersion: '0.8.11',
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

function createKvMock(seed: Record<string, unknown> = {}) {
    const store = new Map<string, string>(
        Object.entries(seed).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])
    );
    let putAttempts = 0;
    let putBehavior: () => void = () => { };

    const kv = {
        async get(key: string, opts?: { type?: string }) {
            const raw = store.get(key);
            if (raw === undefined) return null;
            return opts?.type === 'json' ? JSON.parse(raw) : raw;
        },
        async put(key: string, value: string) {
            putAttempts++;
            putBehavior();
            store.set(key, value);
        },
        async delete(key: string) {
            store.delete(key);
        }
    } as unknown as KVNamespace;

    return {
        kv,
        store,
        getPutAttempts: () => putAttempts,
        failNextPutThenRecover(failures = 1) {
            let left = failures;
            putBehavior = () => {
                if (left > 0) { left--; throw new Error('transient KV outage'); }
            };
        },
        failAllPutsWithQuota() {
            putBehavior = () => { throw new Error('KV put() limit exceeded for the day.'); };
        }
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

describe('store: no-op skip + settingsRev', () => {
    it('mutator که همان blob را برمی‌گرداند → صفر put، skipped=unchanged', async () => {
        const { kv, getPutAttempts } = createKvMock({ proxySettings: fullBlob() });

        const res = await store.mutateSettings({ kv } as any, cur => ({ ...cur! }), { reason: 'test:no-op' });

        expect(res.ok).toBe(true);
        expect(res.changed).toBe(false);
        expect(res.skipped).toBe('unchanged');
        expect(getPutAttempts()).toBe(0);
    });

    it('تغییر واقعی → یک put + rev=1؛ تغییر بعدی rev=2؛ no-op وسط راه rev را نمی‌زند', async () => {
        const { kv, store: kvStore, getPutAttempts } = createKvMock({ proxySettings: fullBlob() });

        const r1 = await store.mutateSettings({ kv } as any, cur => ({ ...cur!, bypassIran: true }), { reason: 'test:r1' });
        expect(r1.changed).toBe(true);
        expect(JSON.parse(kvStore.get('proxySettings')!).settingsRev).toBe(1);
        expect(JSON.parse(kvStore.get('proxySettings')!).bypassIran).toBe(true);

        const r2 = await store.mutateSettings({ kv } as any, cur => ({ ...cur! }), { reason: 'test:r2-noop' });
        expect(r2.changed).toBe(false);
        expect(getPutAttempts()).toBe(1);

        const r3 = await store.mutateSettings({ kv } as any, cur => ({ ...cur!, localDNS: '1.1.1.1' }), { reason: 'test:r3' });
        expect(r3.changed).toBe(true);
        expect(JSON.parse(kvStore.get('proxySettings')!).settingsRev).toBe(2);
        expect(JSON.parse(kvStore.get('proxySettings')!).bypassIran).toBe(true); // حفظ قبلی
        expect(getPutAttempts()).toBe(2);
    });

    it('skipWrite سفارشی → بدون put و با دلیل ساختاریافته', async () => {
        const { kv, getPutAttempts } = createKvMock({ proxySettings: fullBlob() });

        const res = await store.mutateSettings({ kv } as any, () => store.skipWrite('nothing to do'), { reason: 'test:skip' });

        expect(res.ok).toBe(true);
        expect(res.changed).toBe(false);
        expect(res.skipped).toBe('nothing to do');
        expect(getPutAttempts()).toBe(0);
    });
});

describe('store: 🔒 lost-update regression (serialization per isolate)', () => {
    it('دو تراکنش همزمان با فیلدهای متفاوت → هر دو در blob نهایی زنده‌اند (قبلاً یکی پاک می‌شد)', async () => {
        const { kv, store: kvStore } = createKvMock({ proxySettings: fullBlob() });
        const env = { kv } as any;

        // هر دو mutator عمداً دیر برمی‌گردند — بدون صف، هر دو از همان blob کهنه
        // می‌خوانند و نویسنده‌ی دوم تغییرِ اولی را پاک می‌کرد
        const a = store.mutateSettings(env, async cur => {
            await sleep(30);
            return { ...cur!, bypassIran: true };
        }, { reason: 'test:concurrent-a' });

        const b = store.mutateSettings(env, async cur => {
            await sleep(10);
            return { ...cur!, localDNS: '9.9.9.9' };
        }, { reason: 'test:concurrent-b' });

        const [ra, rb] = await Promise.all([a, b]);

        expect(ra.ok).toBe(true);
        expect(rb.ok).toBe(true);

        const final = JSON.parse(kvStore.get('proxySettings')!);
        expect(final.bypassIran).toBe(true);      // تغییر A
        expect(final.localDNS).toBe('9.9.9.9');   // تغییر B — قبلاً قربانی می‌شد
        expect(final.settingsRev).toBe(2);        // دو commit واقعی
    });

    it('mutator روی blob تازه می‌خواند — تغییر تراکنش قبلی در تراکنش بعدی دیده می‌شود', async () => {
        const { kv } = createKvMock({ proxySettings: fullBlob() });
        const env = { kv } as any;

        await store.mutateSettings(env, cur => ({ ...cur!, cleanIPs: ['104.17.147.22'] }), { reason: 'test:seed-list' });

        let seen: unknown;
        await store.mutateSettings(env, cur => {
            seen = cur!.cleanIPs;
            return null;
        }, { reason: 'test:observe' });

        expect(seen).toEqual(['104.17.147.22']);
    });
});

describe('store: چرخه‌ی سهمیه‌ی مرده‌ی KV', () => {
    it('429 واقعی → مهر؛ write ضمنی بعدی skip-fast بدون تلاش؛ write صریح واقعاً تلاش می‌کند', async () => {
        const { kv, getPutAttempts, failAllPutsWithQuota } = createKvMock({ proxySettings: fullBlob() });
        failAllPutsWithQuota();
        const env = { kv } as any;

        // اولین write ضمنی: تلاش واقعی → 429 → مهر
        const first = await store.mutateSettings(env, cur => ({ ...cur!, bypassIran: true }), { reason: 'test:implicit-1', implicit: true });
        expect(first.ok).toBe(false);
        expect(first.error).toContain('limit');
        expect(getPutAttempts()).toBe(1);
        expect(store.isKvQuotaMarked()).toBe(true);

        // write ضمنی بعدی: skip-fast — حتی یک put هم تلاش نمی‌شود
        const second = await store.mutateSettings(env, cur => ({ ...cur!, localDNS: '9.9.9.9' }), { reason: 'test:implicit-2', implicit: true });
        expect(second.ok).toBe(false);
        expect(second.skipped).toBe('kv quota');
        expect(getPutAttempts()).toBe(1); // تغییری نکرد

        // write صریح (ادمین): همیشه تلاش می‌کند تا خطای واقعی را ببیند
        const explicit = await store.mutateSettings(env, cur => ({ ...cur!, localDNS: '9.9.9.9' }), { reason: 'test:explicit' });
        expect(explicit.ok).toBe(false);
        expect(getPutAttempts()).toBe(2);
    });

    it('reset وضعیت تست → مهر پاک می‌شود و write ضمنی دوباره تلاش می‌کند', async () => {
        const { kv, failAllPutsWithQuota } = createKvMock({ proxySettings: fullBlob() });
        failAllPutsWithQuota();
        const env = { kv } as any;

        await store.mutateSettings(env, cur => ({ ...cur!, bypassIran: true }), { reason: 'test:mark', implicit: true });
        expect(store.isKvQuotaMarked()).toBe(true);

        store._resetStoreStateForTest();
        expect(store.isKvQuotaMarked()).toBe(false);

        const res = await store.mutateSettings(env, cur => ({ ...cur!, localDNS: '9.9.9.9' }), { reason: 'test:after-reset', implicit: true });
        expect(res.ok).toBe(false);
        expect(res.skipped).toBeUndefined(); // تلاش واقعی شد، skip-fast نشد
    });
});

describe('store: تاب‌آوری در برابر خطای گذرا', () => {
    it('put بار اول می‌میرد (خطای عمومی) → یک retry → موفق', async () => {
        const { kv, store: kvStore, getPutAttempts, failNextPutThenRecover } = createKvMock({ proxySettings: fullBlob() });
        failNextPutThenRecover(1);

        const res = await store.mutateSettings({ kv } as any, cur => ({ ...cur!, bypassIran: true }), { reason: 'test:retry' });

        expect(res.ok).toBe(true);
        expect(res.changed).toBe(true);
        expect(getPutAttempts()).toBe(2);
        expect(JSON.parse(kvStore.get('proxySettings')!).bypassIran).toBe(true);
    });

    it('put هر دو تلاش می‌میرد → ok:false با error ساختاریافته، بدون throw', async () => {
        const { kv, failNextPutThenRecover } = createKvMock({ proxySettings: fullBlob() });
        failNextPutThenRecover(5);

        const res = await store.mutateSettings({ kv } as any, cur => ({ ...cur!, bypassIran: true }), { reason: 'test:retry-dead' });

        expect(res.ok).toBe(false);
        expect(res.error).toContain('transient');
    });
});

describe('store: هم‌خوانی با لایه‌ی dataset', () => {
    it('بعد از commit موفق، getDataset بدون invalidate دستی مقدار جدید را می‌بیند', async () => {
        const { kv } = createKvMock({
            proxySettings: fullBlob(),
            // v0.8.23: seed سالم — گارد ساختاری مرز لود تک‌اکانت را به fetchWarpAccounts (شبکه) می‌فرستد
warpAccounts: [
            { privateKey: 'k1', publicKey: 'K1', warpIPv6: '2606:4700::1/128', reserved: 'AAAA' },
            { privateKey: 'k2', publicKey: 'K2', warpIPv6: '2606:4700::2/128', reserved: 'BBBB' }
        ],
            telegramBot: { telegramBotToken: '', telegramUserId: '' }
        });
        const env = { kv } as any;

        // کش را با مقدار قدیمی گرم کن
        const before = await kvmod.getDataset(env);
        expect(before.settings.localDNS).toBe('8.8.8.8');

        await store.mutateSettings(env, cur => ({ ...cur!, localDNS: '9.9.9.9' }), { reason: 'test:cache' });

        // کش ۵ ثانیه‌ای هنوز از نظر زمانی معتبر است — ولی commit آن را باطل کرده
        const after = await kvmod.getDataset(env);
        expect(after.settings.localDNS).toBe('9.9.9.9');
    });

    it('شکست commit → دیتاست دست‌نخورده سرویس می‌دهد (قرارداد degrade)', async () => {
        const { kv, store: kvStore, failAllPutsWithQuota } = createKvMock({
            proxySettings: fullBlob(),
            // v0.8.23: seed سالم — گارد ساختاری مرز لود تک‌اکانت را به fetchWarpAccounts (شبکه) می‌فرستد
warpAccounts: [
            { privateKey: 'k1', publicKey: 'K1', warpIPv6: '2606:4700::1/128', reserved: 'AAAA' },
            { privateKey: 'k2', publicKey: 'K2', warpIPv6: '2606:4700::2/128', reserved: 'BBBB' }
        ],
            telegramBot: { telegramBotToken: '', telegramUserId: '' }
        });
        failAllPutsWithQuota();
        const env = { kv } as any;

        const res = await store.mutateSettings(env, cur => ({ ...cur!, bypassIran: true }), { reason: 'test:degrade' });
        expect(res.ok).toBe(false);

        const data = await kvmod.getDataset(env);
        expect(data.settings.bypassIran).toBe(false);       // blob ننوشته شد
        expect(JSON.parse(kvStore.get('proxySettings')!).bypassIran).toBe(false);
    });
});

describe('store: هسته‌ی commitSettingsBlob (مسیر merge/heal)', () => {
    it('blob یکسان → بدون put؛ blob متفاوت → put با rev بامپ‌شده', async () => {
        const { kv, store: kvStore, getPutAttempts } = createKvMock({ proxySettings: fullBlob() });
        const env = { kv } as any;

        const current = JSON.parse(kvStore.get('proxySettings')!);
        const same = await store.commitSettingsBlob(env, current, { ...current }, { reason: 'test:same' });
        expect(same.changed).toBe(false);
        expect(getPutAttempts()).toBe(0);

        const changed = await store.commitSettingsBlob(env, current, { ...current, ports: [443, 8443] }, { reason: 'test:diff' });
        expect(changed.changed).toBe(true);
        expect(JSON.parse(kvStore.get('proxySettings')!).settingsRev).toBe(1);
        expect(JSON.parse(kvStore.get('proxySettings')!).ports).toEqual([443, 8443]);
    });
});

describe('store: 🔒 lost-update — updateDataset (panel save) هم در صف نوشتن (v0.8.25)', () => {
    it('ذخیره‌ی پنل هم‌زمان با tuner → فیلد خارج از payload پنل از blob تازه resolve می‌شود (قبلاً tuner قربانی می‌شد)', async () => {
        const { kv, store: kvStore } = createKvMock({ proxySettings: fullBlob() });
        const env = { kv } as any;

        // tuner اول صفحه می‌گیرد و عمداً داخل mutator دیر برمی‌گردد
        const tuner = store.mutateSettings(env, async cur => {
            await sleep(30);
            return { ...cur!, autoProxyIPs: ['104.17.147.22'] };
        }, { reason: 'test:tuner-holds-queue' });

        // ذخیره‌ی پنل: payload فقط localDNS را عوض می‌کند — autoProxyIPs در payload نیست
        // (قبلاً: read دستیِ بیرون از صف → tuner بین read و commit می‌نشست → commit پنل
        // روی نسخه‌ی کهنه، tuner بی‌صدا پاک می‌شد)
        const save = kvmod.updateDataset(env, { localDNS: '9.9.9.9' } as any);

        const [tunerRes] = await Promise.all([tuner, save]);

        expect(tunerRes.ok).toBe(true);
        const final = JSON.parse(kvStore.get('proxySettings')!);
        expect(final.localDNS).toBe('9.9.9.9');                 // ذخیره‌ی پنل
        expect(final.autoProxyIPs).toEqual(['104.17.147.22']);  // tuner — قبلاً قربانی می‌شد
        expect(final.settingsRev).toBe(2);                      // دو commit واقعی، پشت‌سرهم
    });

    it('خطای merge (شبکه/callback) → updateDataset throw می‌کند؛ KV دست‌نخورده می‌ماند', async () => {
        const { kv, store: kvStore, getPutAttempts } = createKvMock({ proxySettings: fullBlob() });
        const env = { kv } as any;

        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('doh down'); }));
        try {
            // remoteDNS دامنه‌ای جدید → callback resolveDNS → شبکه می‌میرد
            await expect(kvmod.updateDataset(env, { remoteDNS: 'https://doh-fail.example/dns-query' } as any))
                .rejects.toThrow(/updating KV/);
        } finally {
            vi.unstubAllGlobals();
        }

        expect(getPutAttempts()).toBe(0);
        expect(JSON.parse(kvStore.get('proxySettings')!).remoteDNS).toBe('1.1.1.1');
    });
});
