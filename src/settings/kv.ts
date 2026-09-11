import { DnsHost, KvSettings, PanelSettings, TelegramBot, WarpAccount } from '#types/settings';
import { extractProxyParams, extractUpstreamParams, getDomain, resolveDNS } from '@utils';
import { fetchWarpAccounts } from '@api/warp';
import { safeError } from '@common';
import { getKvSettings } from '@settings';
import { setCustomDomain } from '@main';

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
            await env.kv.put('proxySettings', JSON.stringify(kvSettings));
            settings = kvSettings;
        }

        if (!warpAccounts) {
            warpAccounts = await fetchWarpAccounts(env);
        }

        if (VERSION !== settings.panelVersion) {
            // مهاجرت نسخه — مستقیم از روی settings ذخیره‌شده merge می‌شه
            // (بدون خواندن دوباره KV + بدون overwrite شدن با پیش‌فرض‌ها)
            settings = await mergeDataset(env, undefined, settings);
        }

        let telegramBot: TelegramBot | null = storedTelegramBot;
        if (!telegramBot) {
            telegramBot = { telegramBotToken: '', telegramUserId: '' };
            await env.kv.put('telegramBot', JSON.stringify(telegramBot));
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

        await env.kv.put('proxySettings', JSON.stringify(updatedSettings));
        invalidateDatasetCache(); // بعد از ذخیره، کش همیشه تازه‌ست
        return updatedSettings;
    } catch (error) {
        console.log(error);
        throw new Error(`An error occurred while updating KV: ${safeError(error)}`);
    }
}

export async function updateDataset(env: Env, newSettings?: PanelSettings): Promise<KvSettings> {
    // بدون newSettings → ذخیرهٔ تنظیمات فعلیِ حافظه (panel.ts به این رفتار وابسته‌ست)
    if (!newSettings) {
        const kvSettings = getKvSettings();
        try {
            await env.kv.put('proxySettings', JSON.stringify(kvSettings));
        } catch (error) {
            console.log(error);
            throw new Error(`An error occurred while updating KV: ${safeError(error)}`);
        }
        invalidateDatasetCache();
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