import { DnsHost, KvSettings, PanelSettings, TelegramBot, WarpAccount } from '#types/settings';
import { extractProxyParams, extractUpstreamParams, getDomain, resolveDNS } from '@utils';
import { fetchWarpAccounts } from '@api/warp';
import { safeError } from '@common';
import { getKvSettings, syncKvSettings, DEFAULT_WARP_ENDPOINTS } from '@settings';
import { setCustomDomain } from '@main';
import { mutateSettings } from './store';

export interface Dataset {
    settings: KvSettings;
    telegramBot: TelegramBot;
    warpAccounts: WarpAccount[];
}

// ---------- کش در حافظه isolate ----------
// قبلاً هر فراخوانی ۳ خواندن KV داشت — حالا حداکثر یک‌بار در هر TTL

const DATASET_CACHE_TTL = 5_000; // ۵ ثانیه

let datasetCache: { data: Dataset; expiresAt: number } | null = null;
let inflight: Promise<Dataset> | null = null;

/**
 * نسلِ دیتاست (v0.8.55) — با هر invalidate یک واحد جلو می‌رود.
 *
 * کلاس باگ: لودِ سردی که قبل از یک write شروع شده بود، وقتی resolve می‌شد
 * `.then` آن cache را با «دیتای پیش از نوشتن» دوباره پر می‌کرد و invalidate‌ای
 * که commit تازه زده بود را خنثی می‌ساخت — نتیجه: تا ۵ ثانیه (TTL) تنظیماتِ
 * پیش از write سرو می‌شد و بدتر، `setSettings` (subscription/telegram/clean-ip)
 * همان دیتای کهنه را روی snapshot ماژول می‌نشت و `syncKvSettings` تازه را
 * clobber می‌کرد. این مسابقه در دورهای دوم و سومِ ممیزی ثبت شده بود («برای دور
 * بعد»). فیکس: نتیجه‌ی لود فقط وقتی کش می‌شود که در طول لود invalidate‌ای
 * رخ نداده باشد؛ مصرف‌کننده‌ی هم‌پوشان هم یک‌بار تازه‌خوانی می‌شود.
 */
let datasetGeneration = 0;

// ---------- رژیم degrade سهمیه‌ی KV ----------
// سقف رایگان ۱٬۰۰۰ put/روز است؛ وقتی تمام شود (429 «KV put() limit exceeded»)
// هیچ نوشتنیِ *ضمنی* (مهاجرت نسخه/بوت‌استرپ) نباید سرویس را پایین بیاورد —
// باگ ریشه‌ای قبلی: شکست put مهاجرت → throw → کل sub/panel error page می‌داد.
// با تنظیمات merge-شده‌ی در حافظه ادامه می‌دهیم؛ ۱۵ دقیقه بعد دوباره تلاش می‌شود.
const MIGRATION_RETRY_MS = 15 * 60 * 1000;
let migrationRetryAfter = 0;

export function _resetMigrationThrottleForTest(): void {
    migrationRetryAfter = 0;
}

/**
 * باطل کردن کش — بعد از هر write به KV باید صدا زده بشه.
 * (برای فایل‌هایی که مستقیم KV می‌نویسن — مثل telegram و warp — هم export شده)
 * نسل هم جلو می‌رود تا لودِ درحال‌انجامِ هم‌پوشان با این invalidate، دیگر نتیجه‌ی
 * پیش از نوشتن را کش/سرو نکند (v0.8.55 — جزئیات بالای datasetGeneration).
 */
export function invalidateDatasetCache() {
    datasetCache = null;
    datasetGeneration++;
}

/**
 * کلون سطحی — آبجکت‌های برگشتی از کش هر بار «جدید» هستن
 * تا اگه جایی mutate شد، خود کش خراب نشه
 */
function cloneDataset(data: Dataset): Dataset {
    return {
        settings: { ...data.settings },
        telegramBot: { ...data.telegramBot },
        warpAccounts: data.warpAccounts.slice()
    };
}

export async function getDataset(env: Env, _reloadAttempt = 0): Promise<Dataset> {
    if (datasetCache && Date.now() < datasetCache.expiresAt) {
        return cloneDataset(datasetCache.data);
    }

    // جلوگیری از stampede — request های همزمان فقط یک بار KV می‌خونن
    const generation = datasetGeneration;
    if (!inflight) {
        inflight = loadDataset(env)
            .then(data => {
                // v0.8.55 — نتیجه فقط وقتی کش می‌شود که در طول لود invalidate‌ای
                // رخ نداده باشد؛ وگرنه دیتای پیش از نوشتن به‌جای دیتای تازه می‌نشیند
                if (generation === datasetGeneration) {
                    datasetCache = { data, expiresAt: Date.now() + DATASET_CACHE_TTL };
                }
                return data;
            })
            .finally(() => {
                inflight = null;
            });
    }

    const data = await inflight;

    if (generation !== datasetGeneration && _reloadAttempt < 2) {
        // لود با یک write هم‌پوشان شده — این نتیجه پیش از نوشتن است. یک‌بار
        // تازه‌خوانی: هم مصرف‌کننده‌ی جاری دیتای تازه می‌گیرد، هم setSettings
        // دیگر snapshot تازه‌ی syncKvSettings را clobber نمی‌کند. سقف ۲ تلاش —
        // در نویز write بی‌پایان، بهترینِ موجود سرو می‌شود (رفتار قدیمی).
        // (مهاجرت/heal داخلِ loadDataset هم invalidate می‌زنند؛ لودِ بعد از آن‌ها
        // دیتای تازه می‌خواند و بدون write جدید کش می‌شود — حلقه نمی‌زند.)
        return getDataset(env, _reloadAttempt + 1);
    }

    return cloneDataset(data);
}

/**
 * اعتبارسنجی ساختاری warpAccounts خوانده‌شده از KV.
 *
 * مصرف‌کنندگان (configs در cores/clash + xray + sing-box و wireguard.ts) هر دو اکانت
 * [0] و [1] را بدون گارد destructure می‌کنند — هر داده‌ی ناقص از KV (آرایه‌ی خالی،
 * تک‌اکانت، رکورد بی‌کلید، مقدار غیرآرایه) یعنی ۵۰۰ شدن همه‌ی ساب‌های warp/wow و
 * ZIP وایرگارد. شرط قدیمی «!warpAccounts» فقط null را می‌گرفت. این گارد در مرزِ لود،
 * همه‌ی آن حالت‌ها را به بازسازی خودکار (fetchWarpAccounts) می‌فرستد؛ آن تابع روی
 * شکست، اکانت‌های embedded را برمی‌گرداند → سرویس هرگز با اکانت ناقص بالا نمی‌ماند.
 */
function isWellFormedWarpAccounts(value: unknown): value is WarpAccount[] {
    return Array.isArray(value)
        && value.length >= 2
        && value.every(acc =>
            !!acc
            && typeof acc.privateKey === 'string' && acc.privateKey.length > 0
            && typeof acc.publicKey === 'string' && acc.publicKey.length > 0
            && typeof acc.warpIPv6 === 'string' && acc.warpIPv6.length > 0
            && typeof acc.reserved === 'string'
        );
}

/**
 * v0.8.65 — اعتبارسنجی ساختاری warpEndpoints خوانده‌شده از KV (قرارداد v0.8.23
 * برای accounts، این‌بار برای endpoints). validateWarpEndpoints قدیمی فقط فرمت
 * هر عضو را می‌سنجید و آرایه‌ی خالی را قبول می‌کرد — پاک‌کردن textarea endpoints
 * در پنل یا blob دستیِ KV یعنی ساب‌های warp هر سه هسته + ZIP وایرگارد با صفر
 * outbound: sing-box کل پروفایل را رد می‌کرد (detour DNS به گروهی که دیگر ساخته
 * نمی‌شود)، clash گروه Selector با proxies خالی می‌داد، xray balancer بی‌عضو.
 * فرمت اعضا حوزه‌ی ولیدیتور است؛ این گارد فقط «ساختارِ غیرقابل‌سرو» را می‌گیرد.
 */
function isWellFormedWarpEndpoints(value: unknown): value is string[] {
    return Array.isArray(value)
        && value.length >= 1
        && value.every(endpoint => typeof endpoint === 'string' && endpoint.length > 0);
}

async function loadDataset(env: Env): Promise<Dataset> {
    let settings: KvSettings | null, warpAccounts: WarpAccount[] | null;
    const kvSettings = getKvSettings();

    try {
        // ۳ خواندن موازی به‌جای متوالی — یک رفت‌وبرگشت به‌جای سه‌تا
        // cast تایپ tuple: داخل Promise.all استنباط تایپ از context از بین می‌ره
        const [storedSettings, storedWarpAccounts, storedTelegramBot] = await Promise.all([
            env.kv.get('proxySettings', { type: 'json' }),
            env.kv.get('warpAccounts', { type: 'json' }),
            env.kv.get('telegramBot', { type: 'json' })
        ]) as [KvSettings | null, WarpAccount[] | null, TelegramBot | null];

        settings = storedSettings;
        warpAccounts = storedWarpAccounts;

        if (!settings) {
            // بوت‌استرپ اولین اجرا — put best-effort: با سهمیه‌ی تمام‌شده هم سرویس زنده می‌ماند
            settings = kvSettings;
            try {
                await env.kv.put('proxySettings', JSON.stringify(kvSettings));
            } catch (error) {
                console.log(`KV bootstrap put skipped (best-effort): ${safeError(error)}`);
            }
        }

        if (!isWellFormedWarpAccounts(warpAccounts)) {
            // self-heal — null / [] / تک‌اکانت / رکورد ناقص → بازسازی (fetchWarpAccounts
            // روی موفقیت در KV می‌نویسد و روی شکست اکانت‌های embedded را برمی‌گرداند)
            warpAccounts = await fetchWarpAccounts(env);
        }

        if (VERSION !== settings.panelVersion && Date.now() >= migrationRetryAfter) {
            // مهاجرت نسخه — از طریق صف نوشتن (v0.8.25): خواندن تازه داخل صف؛
            // baseی که mutator می‌گیرد جدیدترین blob است (?? settings = حالت
            // بوت‌استرپ/شکست خواندن). قبلاً commit مستقیم بیرون از صف بود.
            const migrated = await mutateSettings(
                env,
                (kvCurrent) => computeMergedSettings(env, undefined, kvCurrent ?? settings),
                { reason: 'migration' }
            );
            if (migrated.ok && migrated.settings) {
                settings = migrated.settings;
                migrationRetryAfter = 0;
            } else {
                // 🔴 سقف put روزانه (429) یا هر خطای write دیگر → هرگز لود تنظیمات را نکش؛
                // سرویس با merge در حافظه ادامه می‌دهد (پس از ریست سهمیه، put بعدی مهاجرت را ثبت می‌کند)
                console.log(`KV migration put deferred (best-effort, retry in 15m): ${migrated.error ?? migrated.skipped}`);
                migrationRetryAfter = Date.now() + MIGRATION_RETRY_MS;
                settings = { ...kvSettings, ...settings, panelVersion: VERSION };
                syncKvSettings(settings);
            }
        }

        // self-heal — remoteDnsHost باید با remoteDNS هم‌تراز باشد (بوت‌استرپ DoH دامنه‌ای)
        settings = await healRemoteDnsHost(env, settings);

        // v0.8.65 — self-heal warpEndpoints خالی/ناقص در مرزِ لود (قرارداد v0.8.23).
        // heal در حافظه — هر لود دوباره heal می‌شود؛ نوشتنِ KV بعدی با ولیدیتورِ
        // جدید دیگر خالی ذخیره نمی‌کند، پس persist ضمنی بی‌معناست و سهمیه write
        // مصرف نمی‌کند. مصرف‌کنندگان: هر سه مولد warp + ZIP وایرگارد — همه از
        // getSettings می‌خوانند و از این نقطه بعد مقدار سالم می‌بینند.
        if (!isWellFormedWarpEndpoints(settings.warpEndpoints)) {
            console.log(`warpEndpoints empty/malformed at KV load — healed in-memory to default (${DEFAULT_WARP_ENDPOINTS[0]})`);
            settings = { ...settings, warpEndpoints: DEFAULT_WARP_ENDPOINTS.slice() };
        }

        let telegramBot: TelegramBot | null = storedTelegramBot;
        if (!telegramBot) {
            telegramBot = { telegramBotToken: '', telegramUserId: '' };
            try {
                await env.kv.put('telegramBot', JSON.stringify(telegramBot));
            } catch (error) {
                console.log(`KV telegramBot bootstrap put skipped (best-effort): ${safeError(error)}`);
            }
        }

        return {
            settings,
            telegramBot,
            warpAccounts
        };
    } catch (error) {
        console.log(error);
        throw new Error(`An error occurred while getting KV: ${safeError(error)}`);
    }
}

// لیست فیلدها یک‌بار در عمر isolate ساخته می‌شه (قبلاً در هر فراخوانی)
const SETTINGS_FIELDS: Array<
    [keyof KvSettings] |
    [keyof KvSettings, keyof KvSettings, (key: any) => any | Promise<any>]
> = [
        ['remoteDNS'],
        ['remoteDnsHost', 'remoteDNS', getDnsParams],
        ['localDNS'],
        ['antiSanctionDNS'],
        ['enableIPv6'],
        ['fakeDNS'],
        ['logLevel'],
        ['allowLANConnection'],
        ['customDomain', 'customDomain', setCustomDomain],
        ['upstreamProxy'],
        ['upstreamParams', 'upstreamProxy', extractUpstreamParams],
        ['chainProxy'],
        ['chainProxyParams', 'chainProxy', extractProxyParams],
        ['cleanIPs'],
        ['cleanIPsFirst'],
        ['telegramProxy'],
        ['customCdnAddrs'],
        ['customCdnHost'],
        ['customCdnSni'],
        ['bestPingInterval'],
        ['protocols'],
        ['ports'],
        ['fingerprint'],
        ['enableTFO'],
        ['fragmentMode'],
        ['fragmentLengthMin'],
        ['fragmentLengthMax'],
        ['fragmentDelayMin'],
        ['fragmentDelayMax'],
        ['fragmentMaxSplitMin'],
        ['fragmentMaxSplitMax'],
        ['fragmentPackets'],
        ['enableECH'],
        ['echServerName'],
        ['bypassIran'],
        ['bypassChina'],
        ['bypassRussia'],
        ['bypassOpenAi'],
        ['bypassGoogleAi'],
        ['bypassMicrosoft'],
        ['bypassOracle'],
        ['bypassDocker'],
        ['bypassAdobe'],
        ['bypassEpicGames'],
        ['bypassIntel'],
        ['bypassAmd'],
        ['bypassNvidia'],
        ['bypassAsus'],
        ['bypassHp'],
        ['bypassLenovo'],
        ['blockAds'],
        ['blockPorn'],
        ['blockUDP443'],
        ['blockMalware'],
        ['blockPhishing'],
        ['blockCryptominers'],
        ['customBypassRules'],
        ['customBlockRules'],
        ['customBypassSanctionRules'],
        ['wsGuardianEnabled'],
        ['wsGuardianIdleSec'],
        ['warpRemoteDNS'],
        ['warpEndpoints'],
        ['warpBestPingInterval'],
        ['warpReservedBytes'],
        ['xrayUdpNoises'],
        ['knockerNoiseMode'],
        ['knockerNoiseCountMin'],
        ['knockerNoiseCountMax'],
        ['knockerNoiseSizeMin'],
        ['knockerNoiseSizeMax'],
        ['knockerNoiseDelayMin'],
        ['knockerNoiseDelayMax'],
        ['amneziaNoiseCount'],
        ['amneziaNoiseSizeMin'],
        ['amneziaNoiseSizeMax'],
        ['customSubs'],
        ['remoteSettings'],
        ['autoProxyIPs'],
        ['customConfigs']
    ];

/**
 * هستهٔ merge — محاسبهٔ خالص، بدون نوشتن (v0.8.25).
 *
 * هم برای ذخیرهٔ پنل (با newSettings) و هم مهاجرت نسخه (بدون newSettings):
 * newSettings === undefined → مقدار ذخیره‌شده ?? پیش‌فرض (مهاجرت حفظ‌کننده)
 *
 * قبلاً همین تابع خودش commitSettingsBlob را مستقیم صدا می‌زد — بیرون از صف
 * نوشتنِ store. باگ: ذخیره‌ی پنل (read دستی + merge چندصد میلی‌ثانیه‌ای با
 * callbacks شبکه‌ای + commit مستقیم) با تراکنش tuner/رباتِ هم‌ایزوله هم‌پوشان
 * می‌شد و تغییرِ آن‌ها بی‌صدا پاک می‌شد — همان کلاس lost-update که موتور
 * v0.8.11 برای نابودی‌اش ساخته شد ولی بزرگ‌ترین نویسنده هنوز از صف عبور می‌کرد.
 * حالا callerها از طریق mutateSettings صف می‌گیرند؛ این تابع فقط محاسبه می‌کند.
 */
async function computeMergedSettings(
    env: Env,
    newSettings: PanelSettings | undefined,
    currentSettings: KvSettings | null
): Promise<KvSettings> {
    const kvSettings = getKvSettings();

    const getParam = async <T extends keyof KvSettings>(
        key: T,
        cbKey?: T,
        callback?: (value: KvSettings[T]) => any | Promise<any>
    ) => {
        const resolve = (k: T) => newSettings?.[k] ?? currentSettings?.[k] ?? kvSettings[k];

        if (callback && cbKey) {
            const cbValue = resolve(cbKey);
            if (cbValue !== currentSettings?.[cbKey]) {
                return callback(cbValue);
            }
        }

        return newSettings?.[key] ?? currentSettings?.[key] ?? kvSettings[key];
    };

    const entries = await Promise.all(
        SETTINGS_FIELDS.map(async ([key, callbackKey, callbackFunc]) => {
            return [key, await getParam(key, callbackKey, callbackFunc)];
        })
    );

    return {
        ...Object.fromEntries(entries),
        panelVersion: VERSION
    };
}

export async function updateDataset(env: Env, newSettings?: PanelSettings): Promise<KvSettings> {
    // بدون newSettings → ذخیرهٔ تنظیمات فعلیِ حافظه (panel.ts به این رفتار وابسته‌ست)
    // از طریق تراکنش مرکزی: اگر KV عیناً همین را داشت، بدون put skip می‌شود (صرفه‌ی سهمیه)
    if (!newSettings) {
        const kvSettings = getKvSettings();
        const result = await mutateSettings(env, () => structuredClone(kvSettings), { reason: 'sync-memory' });
        if (!result.ok) {
            throw new Error(`An error occurred while updating KV: ${result.error}`);
        }
        return kvSettings;
    }

    // ذخیره‌ی پنل/بکاپ/clean-ip — از طریق تراکنش متمرکز (v0.8.25).
    // قبلاً read دستی + commit مستقیم بیرون از صف بود؛ tuner/رباتِ هم‌ایزوله که
    // بین read و commit می‌نشست روی نسخه‌ی کهنه بازنویسی می‌شد (lost update).
    // فیلدهایی که در payload پنل نیستند (مثل autoProxyIPs که tuner مدیریت می‌کند)
    // حالا از تازه‌ترین blob داخل صف resolve می‌شوند و concurrent write می‌مانند.
    const result = await mutateSettings(
        env,
        (kvCurrent) => computeMergedSettings(env, newSettings, kvCurrent),
        { reason: 'merge' }
    );
    if (!result.ok || !result.settings) {
        throw new Error(`An error occurred while updating KV: ${result.error ?? result.skipped}`);
    }
    return result.settings;
}

async function getDnsParams(dns: string): Promise<DnsHost> {
    const { host, isHostDomain } = getDomain(dns);
    const dohHost: DnsHost = { host, isDomain: isHostDomain, ipv4: [], ipv6: [] };

    if (isHostDomain) {
        const { ipv4, ipv6 } = await resolveDNS(host);
        dohHost.ipv4 = ipv4;
        dohHost.ipv6 = ipv6;
    }

    return dohHost;
}

/**
 * self-heal — هم‌ترازسازی remoteDnsHost با remoteDNS (یک‌بارِ می‌نویسد، بدون loop).
 *
 * وقتی remoteDNS دامنه‌ای است (DoH با URL — مثل AdGuard)، کلاینت برای بوت‌استرپ
 * به pin‌کردن IP آن دامنه در hosts نیاز دارد (dns.ts: رزولوشن دامنه‌ی سرور DNS
 * نباید به خود DNS واگذار شود — مرغ و تخم‌مرغ). اگر داده‌ی KV کهنه/ناسازگار
 * باشد (مثلاً remoteDNS از پنل/API عوض شده ولی remoteDnsHost قدیمی مانده)،
 * بوت‌استرپ به DNS سیستم کلاینت می‌افتد — در ایران سمّی‌پذیر است و کل رزولوشن
 * ریموت را کند/مطمئین‌ناپذیر می‌کند. اینجا در لود، داده درست بازساخته و یک‌بار
 * persist می‌شود؛ در لودهای بعدی شرط برقرار است و write ای در کار نیست.
 */
export async function healRemoteDnsHost(env: Env, settings: KvSettings): Promise<KvSettings> {
    try {
        const { host, isHostDomain } = getDomain(settings.remoteDNS);
        if (!isHostDomain) return settings; // مبتنی بر IP — pin کردن بی‌معنا

        const current = settings.remoteDnsHost;
        if (current?.isDomain && current.host === host) return settings; // سالم و هم‌تراز

        // رزولوشن DoH بیرون از صف — صف نوشتن نباید روی شبکه‌ی DNS بایستد
        const healed = await getDnsParams(settings.remoteDNS);

        // write ضمنی self-heal — از طریق صف نوشتن (v0.8.25). baseی تازه‌ترین blob
        // است؛ اگر نویسنده‌ی دیگری همین حالا heal کرده باشد، بدون put دوم رد می‌شویم.
        const result = await mutateSettings(env, (kvCurrent) => {
            const base = kvCurrent ?? settings;
            if (base.remoteDnsHost?.isDomain && base.remoteDnsHost.host === host) return null;
            return { ...base, remoteDnsHost: healed };
        }, { reason: 'dns-heal', implicit: true });

        if (result.ok && result.settings) return result.settings;
        // شکست write (سهمیه/شبکه) → حداقل این‌درخواست با داده‌ی heal‌شده در حافظه ادامه می‌دهد
        return { ...settings, remoteDnsHost: healed };
    } catch {
        // best-effort — هرگز لود تنظیمات را نمی‌شکند؛ دور بعد دوباره تلاش می‌شود
        return settings;
    }
}