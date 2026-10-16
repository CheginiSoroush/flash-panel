/**
 * بات تلگرام — broadcast شخصی‌سازی‌شده + آمار کاربران اشتراک
 *
 * همه‌ی توابع خالص (pure) این ماژول بدون هیچ وابستگی خارجی‌اند تا راحت تست بشن؛
 * فقط ارسال واقعی (sendBroadcast) به یک تابع sender وابسته است که از telegram.ts تزریق می‌شود.
 */

// ---------- انواع ----------

/** شکل مینیمال کاربر — SubUser از settings به‌صورت ساختاری با این سازگار است */
export interface BroadcastUser {
    id: string;
    name: string;
    active: boolean;
    fetchCount?: number;
    lastFetchedAt?: number;
    telegramChatId?: string;
    /** انقضای خودکار — epoch ms (اختیاری) */
    expiresAt?: number;
}

export interface BroadcastRecipient {
    chatId: string;
    /** نام برای شخصی‌سازی {name} — ادمین: 'Admin' */
    name: string;
    /** مقدار {link} — لینک اشتراک نرمال همین گیرنده */
    link: string;
    /** مقدار {uuid} — برای ادمین رشته‌ی خالی */
    uuid: string;
}

export interface BroadcastVars {
    name: string;
    link: string;
    uuid: string;
}

export interface BroadcastResult {
    sent: number;
    failed: number;
    /** chat_id های شکست‌خورده — برای گزارش به ادمین */
    failedChats: string[];
}

// ---------- ثابت‌ها ----------

/** حداکثر پیام همزمان در هر batch — محدودیت ~۳۰ پیام/ثانیه تلگرام */
export const BROADCAST_BATCH_SIZE = 10;
/** مکث بین batch ها (ms) */
export const BROADCAST_BATCH_DELAY_MS = 350;

/** کاربر در هر صفحه‌ی لیست /users */
export const USERS_PER_PAGE = 5;

// ---------- کمکی‌های خالص ----------

/** escape برای parse_mode:HTML تلگرام — ورودی کاربر هرگز HTML خام نمی‌شود */
export function escapeHtml(str: string): string {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * گیرنده‌های broadcast: ادمین اول، بعد کاربران فعالِ لینک‌شده به تلگرام.
 * حذف تکراری بر اساس chatId (مثلاً ادمین که خودش هم کاربر است).
 */
export function resolveBroadcastRecipients(
    users: BroadcastUser[],
    adminChatId: string,
    buildLink: (userId: string) => string
): BroadcastRecipient[] {
    const recipients: BroadcastRecipient[] = [];
    const seen = new Set<string>();

    if (adminChatId) {
        seen.add(adminChatId);
        recipients.push({ chatId: adminChatId, name: 'Admin', link: buildLink(''), uuid: '' });
    }

    for (const user of users) {
        if (!user.active || !user.telegramChatId || seen.has(user.telegramChatId)) continue;
        seen.add(user.telegramChatId);
        recipients.push({
            chatId: user.telegramChatId,
            name: user.name,
            link: buildLink(user.id),
            uuid: user.id
        });
    }

    return recipients;
}

/**
 * شخصی‌سازی متن broadcast — توکن‌های {name} {link} {uuid} با مقادیر هر گیرنده.
 * توکن‌های ناشناخته دست‌نخورده می‌مانند (متن ادمین آزاد است).
 */
export function personalizeBroadcastText(text: string, vars: BroadcastVars): string {
    return text
        .replace(/\{name\}/g, vars.name)
        .replace(/\{link\}/g, vars.link)
        .replace(/\{uuid\}/g, vars.uuid);
}

/** تقسیم گیرنده‌ها به batch های هم‌اندازه برای رعایت rate-limit تلگرام */
export function chunkBroadcastBatches<T>(items: T[], size: number = BROADCAST_BATCH_SIZE): T[][] {
    if (size < 1) size = 1;
    const batches: T[][] = [];
    for (let i = 0; i < items.length; i += size) {
        batches.push(items.slice(i, i + size));
    }
    return batches;
}

/** زمان نسبی خوانا — granularity دقیقه؛ برای ورودی‌های خراب '—' */
export function relativeTime(ts: number | undefined, now: number = Date.now()): string {
    if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return '—';

    const diff = now - ts;
    if (diff < 0) return '—';
    if (diff < 60_000) return 'just now';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;

    return new Date(ts).toISOString().slice(0, 10);
}

/**
 * نشانگر انقضا برای نمایش در ربات/پنل — خالص و قابل‌تست.
 *   بدون انقضا → ''   |   منقضی → '❌ expired'   |   ≤۷۲h → '⏳ Xh left'
 *   بقیه → '⏳ Xd left'
 */
export function expiryBadge(
    expiresAt: number | undefined,
    now: number = Date.now()
): string {
    if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= 0) return '';

    const diff = expiresAt - now;
    if (diff <= 0) return '❌ expired';

    const hours = Math.ceil(diff / 3_600_000);
    if (hours <= 72) return `⏳ ${hours}h left`;

    return `⏳ ${Math.ceil(hours / 24)}d left`;
}

/** صفحه‌بندی لیست کاربران — صفحه‌ی خارج از بازه clamp می‌شود */
export function paginateUsers<T>(
    items: T[],
    page: number,
    perPage: number = USERS_PER_PAGE
): { slice: T[]; page: number; totalPages: number } {
    const totalPages = Math.max(1, Math.ceil(items.length / perPage));
    const safePage = Math.min(Math.max(1, Math.floor(page) || 1), totalPages);
    const start = (safePage - 1) * perPage;
    return { slice: items.slice(start, start + perPage), page: safePage, totalPages };
}

// ---------- متن‌های UI ربات ----------

/** نمای کلی کاربران — خلاصه‌ی آماری */
export function buildUsersOverviewText(users: BroadcastUser[], now: number = Date.now()): string {
    const total = users.length;
    const active = users.filter(u => u.active).length;
    const linked = users.filter(u => u.active && u.telegramChatId).length;
    const totalFetches = users.reduce((sum, u) => sum + (u.fetchCount || 0), 0);
    const activeLast24h = users.filter(
        u => typeof u.lastFetchedAt === 'number' && now - u.lastFetchedAt < 86_400_000
    ).length;
    const expired = users.filter(u => u.active && typeof u.expiresAt === 'number' && u.expiresAt <= now).length;
    const expiringSoon = users.filter(
        u => u.active && typeof u.expiresAt === 'number'
            && u.expiresAt > now && u.expiresAt - now <= 72 * 3_600_000
    ).length;

    const top = [...users]
        .filter(u => (u.fetchCount || 0) > 0)
        .sort((a, b) => (b.fetchCount || 0) - (a.fetchCount || 0))
        .slice(0, 3)
        .map(u => `  • ${escapeHtml(u.name)} — ${u.fetchCount}`)
        .join('\n');

    const lines = [
        '👥 <b>Subscription Users</b>',
        '━━━━━━━━━━━━━━━━',
        `📊 Total: <b>${total}</b> — Active: <b>${active}</b> — Revoked: <b>${total - active}</b>`,
        `🔗 Telegram-linked: <b>${linked}</b> (broadcast-ready)`,
        `📈 Fetches recorded: <b>${totalFetches}</b> — Active in 24h: <b>${activeLast24h}</b>`
    ];

    if (expired || expiringSoon) {
        lines.push(`⏰ Expiry — ❌ ${expired} expired · ⏳ ${expiringSoon} within 72h`);
    }

    if (top) {
        lines.push('', '🏆 Most active:', top);
    }

    return lines.join('\n');
}

/** متن جزئیات یک کاربر */
export function buildUserDetailText(user: BroadcastUser, now: number = Date.now()): string {
    const expiredNow = typeof user.expiresAt === 'number' && user.expiresAt <= now;
    const status = user.active
        ? (expiredNow ? '🟠 Active (expired — links stopped)' : '🟢 Active')
        : '🔴 Revoked';
    const fetches = user.fetchCount || 0;
    const lastFetch = relativeTime(user.lastFetchedAt, now);
    const linked = user.telegramChatId
        ? `✅ <code>${escapeHtml(user.telegramChatId)}</code>`
        : '— not linked —';
    const expiry = expiryBadge(user.expiresAt, now);
    const expiryLine = expiry
        ? `⏰ Auto-expiry: <b>${new Date(user.expiresAt!).toISOString().slice(0, 16).replace('T', ' ')} UTC</b> (${expiry})`
        : '⏰ Auto-expiry: — none —';

    return [
        `👤 <b>${escapeHtml(user.name)}</b>`,
        '━━━━━━━━━━━━━━━━',
        `${status}`,
        `📈 Recorded fetches: <b>${fetches}</b>`,
        `🕐 Last fetch: <b>${lastFetch}</b>`,
        expiryLine,
        '',
        `💬 Telegram chat: ${linked}`,
        '',
        '<i>Link this user from the panel (Subscription Users section) to include them in broadcasts.</i>'
    ].join('\n');
}

/** پیام پیش‌نمایش broadcast برای تأیید ادمین */
export function buildBroadcastConfirmText(
    text: string,
    recipientCount: number,
    sampleVars: BroadcastVars
): string {
    const preview = personalizeBroadcastText(text, sampleVars);
    const personalized = /\{(name|link|uuid)\}/.test(text);

    return [
        '📢 <b>Broadcast preview</b>',
        '━━━━━━━━━━━━━━━━',
        `👥 Recipients: <b>${recipientCount}</b>`,
        personalized
            ? '✨ Placeholders <b>{name}</b>, <b>{link}</b>, <b>{uuid}</b> will be personalized per user.'
            : 'ℹ️ Same message for everyone (no placeholders found).',
        '',
        '<b>Preview:</b>',
        '『' + escapeHtml(preview.slice(0, 3500)) + '』'
    ].join('\n');
}

// ---------- راهنمای تلگرام ----------

/**
 * راهنمای اتصال تلگرام از طریق اشتراک پنل — خالص و تست‌پذیر.
 * پاسخ صادقانه به «پروکسی MTProto تلگرام روی کلادفلر»: غیرممکن است
 * (ورکر فقط HTTP/WS می‌پذیرد) ولی تونل VLESS/WS همین اشتراک تلگرام را کامل عبور می‌دهد.
 */
export function buildTelegramGuideText(): string {
    return [
        '✈️ <b>Telegram via your subscription</b>',
        '━━━━━━━━━━━━━━━━',
        'Your panel configs already tunnel Telegram — no separate MTProto proxy needed.',
        '',
        '<b>📱 Android</b>',
        '1️⃣ Install <i>v2rayNG</i> or <i>Hiddify</i>',
        '2️⃣ Import your subscription link',
        '3️⃣ Connect → open Telegram ✅',
        '',
        '<b>📱 iOS</b>',
        '<i>Streisand</i> / <i>Shadowrocket</i> — same steps',
        '',
        '<b>💻 Desktop</b>',
        '<i>v2rayN</i> / <i>Hiddify</i> → system proxy → Telegram',
        '',
        '<b>📞 Voice / video calls:</b>',
        'Use the <b>Warp</b> subscription type (carries UDP). Normal configs carry messages, media and files (TCP).',
        '',
        'ℹ️ <i>Why not a real MTProto proxy?</i> Telegram apps connect to MTProto proxies over raw TCP — Cloudflare Workers only accept HTTP/WebSocket. This tunnel is the reliable Cloudflare way.',
        '',
        '🛡 Telegram domains &amp; IPs are always routed through the tunnel (Telegram Routing setting).'
    ].join('\n');
}

// ---------- ارسال ----------

/** sender تزریقی — true یعنی پیام با موفقیت تحویل شد */
export type BroadcastSender = (chatId: string, text: string) => Promise<boolean>;

/**
 * ارسال broadcast به همه‌ی گیرنده‌ها — batch های کوچک با مکث بینشان
 * تا rate-limit تلگرام (~۳۰ پیام/ثانیه) رعایت بشه. خطای هر گیرنده مستقل است.
 */
export async function sendBroadcast(
    recipients: BroadcastRecipient[],
    template: string,
    sender: BroadcastSender
): Promise<BroadcastResult> {
    const result: BroadcastResult = { sent: 0, failed: 0, failedChats: [] };

    const batches = chunkBroadcastBatches(recipients);
    for (const [index, batch] of batches.entries()) {
        const outcomes = await Promise.all(
            batch.map(async recipient => {
                const text = personalizeBroadcastText(template, {
                    name: recipient.name,
                    link: recipient.link,
                    uuid: recipient.uuid
                });
                try {
                    return (await sender(recipient.chatId, text))
                        ? null
                        : recipient.chatId;
                } catch {
                    return recipient.chatId;
                }
            })
        );

        for (const failed of outcomes) {
            if (failed) {
                result.failed += 1;
                result.failedChats.push(failed);
            } else {
                result.sent += 1;
            }
        }

        if (index < batches.length - 1) {
            await new Promise(resolve => setTimeout(resolve, BROADCAST_BATCH_DELAY_MS));
        }
    }

    return result;
}
