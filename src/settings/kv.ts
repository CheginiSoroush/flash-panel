import { DnsHost, KvSettings, PanelSettings, TelegramBot, WarpAccount } from '#types/settings';
import { extractProxyParams, extractUpstreamParams, getDomain, resolveDNS } from '@utils';
import { fetchWarpAccounts } from '@api/warp';
import { safeError } from '@common';
import { getKvSettings, syncKvSettings } from '@settings';
import { setCustomDomain } from '@main';
import { commitSettingsBlob, mutateSettings } from './store';

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
 */
export function invalidateDatasetCache() {
    datasetCache = null;
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

export async function getDataset(env: Env): Promise<Dataset> {
    if (datasetCache && Date.now() < datasetCache.expiresAt) {
        return cloneDataset(datasetCache.data);
    }

    // جلوگیری از stampede — request های همزمان فقط یک بار KV می‌خونن
    if (!inflight) {
        inflight = loadDataset(env)
            .then(data => {
                datasetCache = { data, expiresAt: Date.now() + DATASET_CACHE_TTL };
                return data;
            })
            .finally(() => {
                inflight = null;
            });
    }

    return cloneDataset(await inflight);
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

        if (!warpAccounts) {
            warpAccounts = await fetchWarpAccounts(env);
        }

        if (VERSION !== settings.panelVersion && Date.now() >= migrationRetryAfter) {
            // مهاجرت نسخه — مستقیم از روی settings ذخیره‌شده merge می‌شه
            // (بدون خواندن دوباره KV + بدون overwrite شدن با پیش‌فرض‌ها)
            try {
                settings = await mergeDataset(env, undefined, settings);
                migrationRetryAfter = 0;
            } catch (error) {
                // 🔴 سقف put روزانه (429) یا هر خطای write دیگر → هرگز لود تنظیمات را نکش؛
                // سرویس با merge در حافظه ادامه می‌دهد (پس از ریست سهمیه، put بعدی مهاجرت را ثبت می‌کند)
                console.log(`KV migration put deferred (best-effort, retry in 15m): ${safeError(error)}`);
                migrationRetryAfter = Date.now() + MIGRATION_RETRY_MS;
                settings = { ...kvSettings, ...settings, panelVersion: VERSION };
                syncKvSettings(settings);
            }
        }

        // self-heal — remoteDnsHost باید با remoteDNS هم‌تراز باشد (بوت‌استرپ DoH دامنه‌ای)
        settings = await healRemoteDnsHost(env, settings);

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
 * هستهٔ merge — هم برای ذخیرهٔ پنل (با newSettings) و هم مهاجرت نسخه (بدون newSettings).
 * newSettings === undefined → مقدار ذخیره‌شده ?? پیش‌فرض (مهاجرت حفظ‌کننده)
 */
async function mergeDataset(
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

    try {
        const entries = await Promise.all(
            SETTINGS_FIELDS.map(async ([key, callbackKey, callbackFunc]) => {
                return [key, await getParam(key, callbackKey, callbackFunc)];
            })
        );

        const updatedSettings: KvSettings = {
            ...Object.fromEntries(entries),
            panelVersion: VERSION
        };

        // نوشتن از طریق موتور پایداری — no-op skip (صرفه‌ی سهمیه) + rev + retry
        // + آگاهی از سهمیه؛ invalidate کش دیتاست و sync snapshot ماژول داخل
        // خودِ commit انجام می‌شود (وگرنه handlerهای بدون setSettings مثل
        // clean-ip مقدار پیش‌فرض/کهنه را می‌خوانند و روی KV پس‌می‌نویسند)
        await commitSettingsBlob(env, currentSettings, updatedSettings, { reason: 'merge' });
        return updatedSettings;
    } catch (error) {
        console.log(error);
        throw new Error(`An error occurred while updating KV: ${safeError(error)}`);
    }
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

    let currentSettings: KvSettings | null = null;
    try {
        currentSettings = await env.kv.get('proxySettings', { type: 'json' });
    } catch (error) {
        console.log(error);
        throw new Error(`An error occurred while getting current KV settings: ${safeError(error)}`);
    }

    return mergeDataset(env, newSettings, currentSettings);
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

        const healed = await getDnsParams(settings.remoteDNS);
        const next: KvSettings = { ...settings, remoteDnsHost: healed };
        // write ضمنی self-heal — از موتور پایداری (no-op skip + سهمیه‌آگاه + rev)
        await commitSettingsBlob(env, settings, next, { reason: 'dns-heal', implicit: true });
        return next;
    } catch {
        // best-effort — هرگز لود تنظیمات را نمی‌شکند؛ دور بعد دوباره تلاش می‌شود
        return settings;
    }
}