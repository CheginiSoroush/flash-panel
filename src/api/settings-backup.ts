/**
 * پشتیبان‌گیری و بازیابی تنظیمات — ماژول خالص و بدون وابستگی (تست‌پذیر)
 *
 * Export: proxySettings در KV + کاربران اشتراک + MainSettings (هویت پنل) + بات تلگرام
 *         → یک JSON ساختاریافته با متادیتا. عمداً شامل این‌ها نیست:
 *           - پسورد ادمین (hash) → بعد از بازیابی باید دوباره ست شود (امن‌تر)
 *           - TOTP secret → ثبت‌نام دوباره‌ی 2FA روی دیپلوی جدید (آگاهانه)
 *           - warpAccounts → خودکار از API دوباره گرفته می‌شود
 *           - accID/apiToken → هرگز از مرز پنل خارج نمی‌شوند
 * Import: اعتبارسنجی ساختار بکاپ، ادغام سفیدلیست‌شده روی تنظیمات فعلی
 *         (فقط کلیدهای شناخته‌شده با تایپ درست)، و دروازه‌ی نهایی
 *         validateSettings موجود — همان مسیر ذخیره‌ی عادی پنل.
 */

import { KvSettings, MainSettings, PanelSettings, TelegramBot } from '#types/settings';
import {
    isValidSubUserId,
    normalizeSubUserChatId,
    sanitizeSubUserName,
    SUB_USERS_LIMIT,
    SubUser
} from '@settings/sub-users';

export const BACKUP_KIND = 'flash-panel-settings-backup';
export const BACKUP_APP = 'flash-panel';

/** فیلدهای مدیریتی که از بکاپ بازیابی نمی‌شوند */
export const NON_RESTORED_KEYS = ['panelVersion'] as const;

export interface BackupMeta {
    app: string;
    kind: string;
    version: string;
    exportedAt: string;
    /** بکاپ شامل رازهاست (UUID/تراسپاس/توکن بات) — فایل را محرمانه نگه دارید */
    includesSecrets: true;
    /** چیزهایی که عمداً در بکاپ نیستند */
    excludes: string[];
}

export interface SettingsBackup {
    _meta: BackupMeta;
    settings: KvSettings;
    main: MainSettings;
    subUsers: SubUser[];
    telegramBot: TelegramBot;
}

export interface BackupInput {
    settings: KvSettings;
    main: MainSettings;
    subUsers: SubUser[];
    telegramBot: TelegramBot | null;
    version: string;
    now?: Date;
}

export function buildSettingsBackup(input: BackupInput): SettingsBackup {
    const {
        settings, main, subUsers, telegramBot, version,
        now = new Date()
    } = input;

    return {
        _meta: {
            app: BACKUP_APP,
            kind: BACKUP_KIND,
            version,
            exportedAt: now.toISOString(),
            includesSecrets: true,
            excludes: [
                'admin password (set a new one after restore)',
                'TOTP secret (re-enroll 2FA after restore)',
                'warp accounts (auto-fetched)',
                'cloudflare account id / api token'
            ]
        },
        settings: structuredClone(settings),
        main: structuredClone(main),
        subUsers: structuredClone(subUsers),
        telegramBot: telegramBot
            ? structuredClone(telegramBot)
            : { telegramBotToken: '', telegramUserId: '' }
    };
}

// ---------- Import ----------

export interface ParsedBackup {
    settings: Record<string, unknown>;
    main: Record<string, unknown>;
    subUsers: unknown;
    telegramBot: unknown;
}

/**
 * اعتبارسنجی ساختاری بکاپ — فقط شکل درست را رد می‌کند به لایه‌ی merge.
 * null یعنی این فایل اصلاً بکاپ Flash Panel نیست.
 */
export function parseSettingsBackup(raw: unknown): ParsedBackup | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

    const meta = (raw as Record<string, unknown>)._meta;
    if (!meta || typeof meta !== 'object') return null;
    if ((meta as BackupMeta).kind !== BACKUP_KIND) return null;
    if ((meta as BackupMeta).app !== BACKUP_APP) return null;

    const settings = (raw as Record<string, unknown>).settings;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return null;

    const main = (raw as Record<string, unknown>).main;
    const subUsers = (raw as Record<string, unknown>).subUsers;
    const telegramBot = (raw as Record<string, unknown>).telegramBot;

    return {
        settings: settings as Record<string, unknown>,
        main: main && typeof main === 'object' && !Array.isArray(main)
            ? main as Record<string, unknown>
            : {},
        subUsers,
        telegramBot
    };
}

function shapeOf(value: unknown): 'array' | 'object' | 'primitive' {
    if (Array.isArray(value)) return 'array';
    if (value && typeof value === 'object') return 'object';
    return 'primitive';
}

/** تایپ‌سنجی نسبت به مقدار پیش‌فرض — primitive/array/object هم‌خانواده باشند */
function isSameShape(value: unknown, reference: unknown): boolean {
    const v = shapeOf(value);
    const r = shapeOf(reference);
    if (v !== r) return false;
    // primitive ها فقط هم‌تایپ باشند (string/number/boolean قاطی نشوند)
    if (v === 'primitive') return typeof value === typeof reference;
    return true;
}

export interface MergedImport {
    merged: KvSettings;
    imported: number;
    skipped: string[];
}

/**
 * ادغام بکاپ روی تنظیمات فعلی — فقط کلیدهای شناخته‌شده (کلیدهای پیش‌فرض)
 * با تایپ درست اعمال می‌شوند؛ بقیه skip و گزارش می‌شوند.
 * کلیدهای مدیریتی (panelVersion) همیشه skip — مهاجرت نسخه باید طبیعی رخ دهد.
 */
export function mergeImportedSettings(
    current: KvSettings,
    incoming: Record<string, unknown>,
    defaults: KvSettings
): MergedImport {
    const merged: KvSettings = structuredClone(current);
    const defaultRecord = defaults as unknown as Record<string, unknown>;
    const mergedRecord = merged as unknown as Record<string, unknown>;
    let imported = 0;
    const skipped: string[] = [];

    for (const [key, value] of Object.entries(incoming)) {
        if (!(key in defaultRecord)) {
            skipped.push(key);
            continue;
        }

        if ((NON_RESTORED_KEYS as readonly string[]).includes(key)) {
            skipped.push(key);
            continue;
        }

        if (value === null || value === undefined || !isSameShape(value, defaultRecord[key])) {
            skipped.push(key);
            continue;
        }

        mergedRecord[key] = structuredClone(value);
        imported++;
    }

    return { merged, imported, skipped };
}

const MAIN_FIELDS = [
    'vlUUID', 'trPass', 'securePath',
    'proxyIpMode', 'proxyIPs', 'prefixes', 'forceProxyDomains', 'fallback', 'dohUrl'
] as const;

/**
 * استخراج MainSettings معتبر از بکاپ — فقط فیلدهای شناخته‌شده.
 * رشته‌ها/آرایه‌های رشته‌ای ساده تایپ‌چک می‌شوند؛ اعتبارسنجی محتوایی
 * (UUID/پسورد/path/IP ها) با validateSettings موجود انجام می‌شود.
 */
export function sanitizeImportedMain(raw: Record<string, unknown>): Partial<MainSettings> {
    const out: Record<string, unknown> = {};

    for (const field of MAIN_FIELDS) {
        const value = raw[field];
        if (value === undefined || value === null) continue;

        if (field === 'proxyIPs' || field === 'prefixes' || field === 'forceProxyDomains') {
            if (Array.isArray(value) && value.every(v => typeof v === 'string')) {
                out[field] = value;
            }
            continue;
        }

        if (typeof value === 'string') {
            out[field] = value;
        }
    }

    return out as Partial<MainSettings>;
}

export interface ImportedUsers {
    users: SubUser[];
    skipped: number;
}

/**
 * اعتبارسنجی کاربران بکاپ — رکوردهای سالم نگه داشته می‌شوند، خراب‌ها
 * شمرده و رد می‌شوند. سقف SUB_USERS_LIMIT همیشه رعایت می‌شود.
 * raw === undefined → null (بکاپ بدون بخش کاربران — لیست فعلی دست‌نخورده)
 */
export function parseImportedUsers(raw: unknown): ImportedUsers | null {
    if (raw === undefined) return null;
    if (!Array.isArray(raw)) return { users: [], skipped: 0 };

    const users: SubUser[] = [];

    for (const entry of raw) {
        if (users.length >= SUB_USERS_LIMIT) break;
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;

        const record = entry as Record<string, unknown>;
        const id = typeof record.id === 'string' ? record.id : '';
        const name = sanitizeSubUserName(record.name);
        if (!isValidSubUserId(id) || !name) continue;

        const createdAt = Number(record.createdAt);
        const user: SubUser = {
            id,
            name,
            createdAt: Number.isFinite(createdAt) && createdAt > 0 ? Math.floor(createdAt) : Date.now(),
            active: record.active !== false
        };

        const chat = normalizeSubUserChatId(record.telegramChatId);
        if (chat) user.telegramChatId = chat;

        const fetchCount = Number(record.fetchCount);
        if (Number.isFinite(fetchCount) && fetchCount > 0) user.fetchCount = Math.floor(fetchCount);

        const lastFetchedAt = Number(record.lastFetchedAt);
        if (Number.isFinite(lastFetchedAt) && lastFetchedAt > 0) {
            user.lastFetchedAt = Math.floor(lastFetchedAt);
        }

        // انقضای خودکار — بدون این، restore همه‌ی تاریخ‌های انقضا را حذف می‌کرد
        const expiresAt = Number(record.expiresAt);
        if (Number.isFinite(expiresAt) && expiresAt > 0) {
            user.expiresAt = Math.floor(expiresAt);
        }

        users.push(user);
    }

    return { users, skipped: raw.length - users.length };
}

/** بات تلگرام بکاپ — فقط اگر هر دو فیلد رشته باشند؛ حداقل یکی پر */
export function parseImportedBot(raw: unknown): TelegramBot | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

    const record = raw as Record<string, unknown>;
    if (typeof record.telegramBotToken !== 'string' || typeof record.telegramUserId !== 'string') {
        return null;
    }

    if (!record.telegramBotToken && !record.telegramUserId) return null;

    return {
        telegramBotToken: record.telegramBotToken,
        telegramUserId: record.telegramUserId
    };
}

/**
 * تجمیع نهایی برای هندلر پنل — ورودی بکاپ parse‌شده، خروجی آماده‌ی
 * validateSettings + ذخیره. defaults تزریقی است (ماژول به @settings وابسته نیست).
 */
export function prepareImport(
    parsed: ParsedBackup,
    current: KvSettings,
    defaults: KvSettings
): {
    settings: PanelSettings;
    importedFields: number;
    skippedFields: string[];
    users: ImportedUsers | null;
    bot: TelegramBot | null;
} {
    const { merged, imported, skipped } = mergeImportedSettings(current, parsed.settings, defaults);
    const main = sanitizeImportedMain(parsed.main);
    const users = parseImportedUsers(parsed.subUsers);
    const bot = parseImportedBot(parsed.telegramBot);

    const settings = { ...merged, ...main } as PanelSettings;

    return {
        settings,
        importedFields: imported,
        skippedFields: skipped,
        users,
        bot
    };
}
