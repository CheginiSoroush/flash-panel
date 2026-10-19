import { safeError } from '@common';
import { initForScheduled, loadApiToken } from '@settings';
import { getCfWorkerUsage } from '@api/usage';
import { recordUsageSample } from '@settings/usage-history';
import { getSubUsers, isSubUserExpired, sweepExpiredSubUsers, SubUser } from '@settings/sub-users';
import { tuneProxyIPs, ProxyTuneResult } from './proxy-tuner';
import { tuneCleanIPs, CleanTuneResult } from './clean-tuner';
import { runWorkersDevGuard, WorkersDevGuardResult } from './workersdev-guard';
import { runEdgeTuner, EdgeTuneResult } from './edge-tuner';
import { buildEdgeSummary, getEdgeTelemetry } from '@settings/edge-telemetry';
import { TelegramBot } from '#types/settings';

/**
 * موتور اتوماسیون — همه‌ی کارهای زمان‌بندی‌شده‌ی پنل در یک نقطه.
 *
 * با cron trigger اجرا می‌شود (پیشنهاد: ساعتی — '0 * * * *' در wrangler.jsonc) و:
 *   1. نمونه‌گیری مصرف (سری زمانی نمودار حتی بدون بازدید پنل پر می‌ماند)
 *   2. sweep انقضای کاربران اشتراک + خبر رسانی فوری به ادمین (تلگرام)
 *   3. هشدار مصرف ≥۸۰٪ سهمیه‌ی روزانه — حداکثر یک‌بار در روز
 *   4. خلاصه‌ی روزانه (digest) — حداکثر یک‌بار در روز UTC
 *
 * اصول:
 *   - best-effort مطلق: هیچ مرحله‌ای نمی‌تواند کل scheduled handler را crash کند
 *   - ضد duplicate: وضعیت هر روز UTC در KV (automationState) نگه داشته می‌شود —
 *     اجرای مکرر cron (یا هم‌زمانی دو isolate) پیام تکراری نمی‌سازد
 *   - بدون بات، همه‌چیز باز هم کار می‌کند — فقط notify ها بی‌صدا رد می‌شوند
 */

// ---------- وضعیت گارد روزانه ----------

interface AutomationState {
    /** تاریخ UTC که این state به آن تعلق دارد — YYYY-MM-DD */
    date: string;
    /** خلاصه‌ی روزانه ارسال شد؟ */
    digestSent?: boolean;
    /** هشدار مصرف ۸۰٪ ارسال شد؟ */
    usageWarned?: boolean;
    /** آخرین Auto-Tune ProxyIP (epoch ms) — بین روزها حفظ می‌شود */
    proxyTunedAt?: number;
    /** آخرین Auto-Tune CleanIPs (epoch ms) — بین روزها حفظ می‌شود */
    cleanTunedAt?: number;
}

const AUTOMATION_KEY = 'automationState';
const DAILY_QUOTA = 100_000;
const USAGE_WARN_PCT = 80;

function utcDateKey(d: Date = new Date()): string {
    return d.toISOString().slice(0, 10);
}

async function loadState(env: Env): Promise<AutomationState> {
    try {
        const raw = await env.kv.get(AUTOMATION_KEY, { type: 'json' });
        if (raw && typeof raw === 'object' && typeof (raw as AutomationState).date === 'string') {
            return raw as AutomationState;
        }
    } catch {
        // خرابی state = گاردی نیست = بدترین حالا یک پیام تکراری
    }
    return { date: utcDateKey() };
}

async function saveState(env: Env, state: AutomationState): Promise<void> {
    try {
        await env.kv.put(AUTOMATION_KEY, JSON.stringify(state));
    } catch {
        // گارد write نشد — دور بعد ممکن است پیام تکراری برود؛ قابل‌قبول
    }
}

// ---------- دسترسی بات (بدون وابستگی به dataset کش‌شده) ----------

interface BotConfig {
    token: string;
    adminChatId: string;
}

async function getBot(env: Env): Promise<BotConfig | null> {
    try {
        const bot: TelegramBot | null = await env.kv.get('telegramBot', { type: 'json' });
        const token = bot?.telegramBotToken;
        const adminChatId = bot?.telegramUserId;
        if (token && adminChatId) return { token, adminChatId };
    } catch {
        // بدون بات — فقط notify ها از دست می‌روند
    }
    return null;
}

async function notifyAdmin(bot: BotConfig, html: string): Promise<void> {
    try {
        await fetch(`https://api.telegram.org/bot${bot.token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: bot.adminChatId,
                text: html,
                parse_mode: 'HTML'
            })
        });
    } catch (error) {
        console.log(`automation: notify failed — ${safeError(error)}`);
    }
}

// ---------- متن‌های اطلاع‌رسانی ----------

function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtExpiry(ts: number): string {
    return new Date(ts).toISOString().slice(0, 16).replace('T', ' ');
}

export function buildSweepText(swept: SubUser[], expiringSoon: SubUser[], now: number = Date.now()): string {
    const lines: string[] = ['⏰ <b>Auto-expiry report</b>'];

    if (swept.length) {
        lines.push('', `🔒 <b>${swept.length} user(s) expired & revoked:</b>`);
        for (const u of swept) {
            lines.push(`• ${esc(u.name)} — expired ${u.expiresAt ? fmtExpiry(u.expiresAt) : ''}`);
        }
    }

    if (expiringSoon.length) {
        lines.push('', `⚠️ <b>${expiringSoon.length} expiring within 72h:</b>`);
        for (const u of expiringSoon) {
            const hoursLeft = Math.max(1, Math.ceil((u.expiresAt! - now) / 3_600_000));
            lines.push(`• ${esc(u.name)} — ${hoursLeft}h left`);
        }
    }

    if (!swept.length && !expiringSoon.length) {
        lines.push('', '✅ Nothing expired, nothing expiring soon.');
    }

    return lines.join('\n');
}

export interface DigestInput {
    usage: { success: boolean; total?: number; worker?: number };
    users: SubUser[];
    date?: string;
    /** مرجع زمان برای محاسبه‌ی انقضا — پیش‌فرض اکنون (برای تست قطعی لازم است) */
    now?: number;
    /** بهترین ProxyIP از Auto-Tune — اگر موجود باشد نمایش داده می‌شود */
    bestProxyIP?: string | null;
    /** بهترین CleanIP از Auto-Tune — اگر موجود باشد نمایش داده می‌شود */
    bestCleanIP?: string | null;
    /** 🛰️ خلاصه‌ی یک‌خطی Edge Telemetry (colo/RTT ترافیک واقعی) — از buildEdgeSummary */
    edgeSummary?: string | null;
}

/**
 * خلاصه‌ی روزانه — هم برای cron و هم دستور /digest ربات.
 * شامل: مصرف امروز/سهمیه، آمار کاربران، منقضی‌شده‌ها، نزدیک‌انقضاها، top 5 واکشی.
 */
export function buildDigestText(input: DigestInput): string {
    const date = input.date ?? utcDateKey();
    const now = input.now ?? Date.now();
    const users = input.users ?? [];
    const active = users.filter(u => u.active && !isSubUserExpired(u, now));
    const expired = users.filter(u => isSubUserExpired(u, now));
    const revoked = users.filter(u => !u.active && !isSubUserExpired(u, now));
    const expiringSoon = active
        .filter(u => typeof u.expiresAt === 'number' && u.expiresAt > now)
        .sort((a, b) => a.expiresAt! - b.expiresAt!)
        .slice(0, 5);
    const topUsers = [...users]
        .filter(u => (u.fetchCount || 0) > 0)
        .sort((a, b) => (b.fetchCount || 0) - (a.fetchCount || 0))
        .slice(0, 5);

    const lines: string[] = [
        '📋 <b>Daily Digest</b>',
        `━━━━━━━━━━━━━━━━`,
        `📅 ${date}`,
        ''
    ];

    if (input.usage?.success && typeof input.usage.total === 'number') {
        const pct = Math.ceil(input.usage.total / DAILY_QUOTA * 100);
        const bar = '█'.repeat(Math.min(10, Math.ceil(pct / 10))) || '▏';
        lines.push(
            `📊 Usage: ${input.usage.total.toLocaleString()} / ${DAILY_QUOTA.toLocaleString()} (${pct}%)`,
            `${bar} ${pct >= USAGE_WARN_PCT ? '🔴' : pct >= 50 ? '🟡' : '🟢'}`,
            `⚡ Panel requests: ${(input.usage.worker ?? 0).toLocaleString()}`,
            ''
        );
    } else {
        lines.push('📊 Usage: unavailable (check CF credentials)', '');
    }

    lines.push(
        `👥 Users: <b>${active.length}</b> active / ${users.length} total`,
        `🔒 Expired: ${expired.length}   🚫 Revoked: ${revoked.length}`
    );

    if (expiringSoon.length) {
        lines.push('', '⏳ <b>Next expirations:</b>');
        for (const u of expiringSoon) {
            lines.push(`• ${esc(u.name)} — ${fmtExpiry(u.expiresAt!)}`);
        }
    }

    if (topUsers.length) {
        lines.push('', '🔥 <b>Top fetches (5-min throttled):</b>');
        for (const u of topUsers) {
            lines.push(`• ${esc(u.name)} — ${u.fetchCount} fetches`);
        }
    }

    if (input.bestProxyIP) {
        lines.push('', `⚡ <b>Auto-tuned proxyIP:</b> ${esc(input.bestProxyIP)}`);
    }

    if (input.bestCleanIP) {
        lines.push('', `🧹 <b>Auto-tuned cleanIPs:</b> ${esc(input.bestCleanIP)}`);
    }

    if (input.edgeSummary) {
        lines.push('', `🛰️ ${esc(input.edgeSummary)}`);
    }

    return lines.join('\n');
}

function buildUsageWarnText(total: number, worker: number): string {
    const pct = Math.ceil(total / DAILY_QUOTA * 100);
    return [
        '🔴 <b>Usage warning</b>',
        `━━━━━━━━━━━━━━━━`,
        `Total: ${total.toLocaleString()} / ${DAILY_QUOTA.toLocaleString()} (${pct}%)`,
        `Panel: ${worker.toLocaleString()}`,
        '',
        'Approaching the Cloudflare Free daily limit —',
        'traffic may start failing soon (error 1027/429).'
    ].join('\n');
}

// ---------- اجرای اصلی ----------

export interface AutomationRunResult {
    swept: number;
    notified: boolean;
    digestSent: boolean;
    usageWarned: boolean;
    /** Auto-Tune ProxyIP در این دور اجرا شد؟ */
    proxyTuned?: boolean;
    /** بهترین ProxyIP اعمال‌شده (برای لاگ/تست) */
    bestProxyIP?: string | null;
    /** نتیجه‌ی کامل tune — برای تست */
    tune?: ProxyTuneResult;
    /** Auto-Tune CleanIPs در این دور اجرا شد؟ */
    cleanTuned?: boolean;
    /** بهترین CleanIP تست‌شده (برای لاگ/تست) */
    bestCleanIP?: string | null;
    /** نتیجه‌ی کامل clean tune — برای تست */
    clean?: CleanTuneResult;
    /** 🛡️ گارد ضد-abuse workers.dev — نتیجه‌ی چک این دور (v0.8.3) */
    workersDevGuard?: WorkersDevGuardResult;
    /** 🎯 Edge-Tuner — نتیجه‌ی چک RTT-spike این دور (v0.8.5) */
    edgeTune?: EdgeTuneResult;
    /** 🛰️ خلاصه‌ی یک‌خطی Edge Telemetry (colo/RTT ترافیک واقعی) */
    edgeSummary?: string | null;
}

/**
 * نقطه‌ی ورود cron — از worker.ts scheduled() صدا زده می‌شود.
 * هر مرحله مستقل و best-effort است؛ خروجی فقط برای تست/لاگ.
 */
export async function runScheduledAutomation(env: Env, now: number = Date.now()): Promise<AutomationRunResult> {
    const result: AutomationRunResult = {
        swept: 0, notified: false, digestSent: false, usageWarned: false
    };

    // globals بدون Request — برای getCfWorkerUsage (فیلدهای استاتیک embeded)
    try {
        initForScheduled(env);
        // v0.8.12 — توکن CF از KV قبل از usage/guard های CF-API در کرون
        // (failure-safe — شکست خواندن توکن، کرون را نمی‌کشد)
        await loadApiToken(env);
    } catch (error) {
        console.log(`automation: init failed — ${safeError(error)}`);
        return result;
    }

    const today = utcDateKey(new Date(now));
    let state = await loadState(env);
    if (state.date !== today) {
        // روز جدید — گاردهای روزانه ریست؛ tuner timestamps بین روزها حفظ می‌شوند
        state = { date: today, proxyTunedAt: state.proxyTunedAt, cleanTunedAt: state.cleanTunedAt };
    }

    // ---------- ۱+۲) نمونه‌گیری مصرف + sweep انقضا + بات — مستقل و موازی ----------
    // (قبلاً سری بود و usage در همین tick تا ۳ بار fetch می‌شد — حالا یک‌بار
    //  fetch و در هشدار/digest همان tick استفاده می‌شود: ۲ subrequest کمتر در هر دور)
    let usage: Awaited<ReturnType<typeof getCfWorkerUsage>> = { success: false };

    // (متغیر usage در closure پر می‌شود؛ عنصر میانی tuple صرفاً همگام‌سازی است)
    const [bot, , sweep] = await Promise.all([
        getBot(env),
        getCfWorkerUsage()
            .then((u) => {
                usage = u;
                if (usage.success) {
                    return recordUsageSample(env, usage.total ?? 0, usage.worker ?? 0)
                        .catch((error) => console.log(`automation: usage record failed — ${safeError(error)}`));
                }
                return undefined;
            })
            .catch((error) => {
                console.log(`automation: usage sample failed — ${safeError(error)}`);
                return undefined;
            }),
        sweepExpiredSubUsers(env, now).catch((error) => {
            console.log(`automation: expiry sweep failed — ${safeError(error)}`);
            return { swept: [] as SubUser[], expiringSoon: [] as SubUser[] };
        })
    ]);

    result.swept = sweep.swept.length;
    if (bot && (sweep.swept.length || sweep.expiringSoon.length)) {
        await notifyAdmin(bot, buildSweepText(sweep.swept, sweep.expiringSoon));
        result.notified = true;
    }

    // ---------- ۲b) 🛡️ گارد ضد-abuse — workers.dev باید همیشه بسته بماند ----------
    // گزارش‌های abuse واقعی (2512190207a0dbbf و 92750cec97857ec6) نشواند که
    // اسکنرها *.workers.dev را ۲۴/۷ گزارش می‌کنند؛ یک deploy اشتباه کافی است تا
    // دوباره باز شود. این گارد هر دور چک می‌کند، بسته می‌کند و خبر می‌دهد.
    try {
        const guard = await runWorkersDevGuard(env, bot ? (html) => notifyAdmin(bot, html) : null);
        if (guard) {
            result.workersDevGuard = guard;
            if (guard.enabledFound.length) {
                console.log(`automation: workers.dev guard — found open [${guard.enabledFound.join(', ')}], disabled [${guard.disabled.join(', ') || 'NONE'}], left open [${guard.leftOpen.join(', ') || 'none'}]`);
            }
        }
    } catch (error) {
        console.log(`automation: workers.dev guard failed — ${safeError(error)}`);
    }

    // ---------- ۲c) 🎯 Edge-Tuner — جهش RTT واقعی کاربران → تیونر بیدار شود ----------
    // تلمتری v0.8.4 حالا تصمیم می‌گیرد: اگر میانگین TCP-RTT اپراتورهای واقعی
    // نسبت به خط پایه پرید، ProxyIP/CleanIP tuner ها خارج از زمان‌بندی عادی
    // اجرا می‌شوند و ادمین هشدار دقیق می‌گیرد (کدام ASN بدترین افت را داشته).
    try {
        const edgeTune = await runEdgeTuner(env, bot ? (html) => notifyAdmin(bot, html) : null, now);
        result.edgeTune = edgeTune;
        if (edgeTune.status === 'spike') {
            console.log(`automation: edge-tuner — RTT spike ${edgeTune.todayAvgRtt}ms (baseline ${edgeTune.baselineRtt}ms), tuned=${edgeTune.tuned}, asns [${(edgeTune.spikeAsns ?? []).join(', ')}]`);
        }
    } catch (error) {
        console.log(`automation: edge-tuner failed — ${safeError(error)}`);
    }

    // ---------- ۳) Auto-Tune ProxyIP (هر ۶ ساعت — بدون بات هم کار می‌کند) ----------
    const TUNE_INTERVAL_MS = 6 * 3_600_000;
    try {
        if (now - (state.proxyTunedAt ?? 0) >= TUNE_INTERVAL_MS) {
            const tune = await tuneProxyIPs(env);
            state.proxyTunedAt = now;
            await saveState(env, state);
            result.proxyTuned = true;
            result.bestProxyIP = tune.best;
            result.tune = tune;
            console.log(`automation: proxy tune — pool ${tune.poolSize}, healthy ${tune.healthyCount}, best ${tune.best ?? '—'}, changed ${tune.changed}${tune.skipped ? ` (${tune.skipped})` : ''}`);

            if (bot && tune.changed && tune.best) {
                await notifyAdmin(bot,
                    `⚡ <b>Auto-Tune ProxyIP</b>\n` +
                    `Best: ${esc(tune.best)}\n` +
                    `Applied: ${tune.applied.map(esc).join(' , ') || '—'}\n` +
                    `Healthy: ${tune.healthyCount}/${tune.poolSize}`);
                result.notified = true;
            }
        }
    } catch (error) {
        console.log(`automation: proxy tune failed — ${safeError(error)}`);
    }

    // ---------- ۳b) Auto-Tune CleanIPs (هر ۶ ساعت — ضد-فیلترینگ خودکار) ----------
    // بعد از proxy tune (هر دو blob می‌نویسند — موازی نباشند تا clobber نشود)
    const CLEAN_TUNE_INTERVAL_MS = 6 * 3_600_000;
    try {
        if (now - (state.cleanTunedAt ?? 0) >= CLEAN_TUNE_INTERVAL_MS) {
            const clean = await tuneCleanIPs(env);
            state.cleanTunedAt = now;
            await saveState(env, state);
            result.cleanTuned = true;
            result.bestCleanIP = clean.best;
            result.clean = clean;
            console.log(`automation: clean ip tune — pool ${clean.poolSize}, healthy ${clean.healthyCount}, best ${clean.best ?? '—'}, changed ${clean.changed}${clean.skipped ? ` (${clean.skipped})` : ''}`);
        }
    } catch (error) {
        console.log(`automation: clean ip tune failed — ${safeError(error)}`);
    }

    // ---------- ۴) هشدار مصرف ≥۸۰٪ (یک‌بار در روز — همان نمونه‌ی ابتدای tick) ----------
    try {
        if (bot && !state.usageWarned && usage.success &&
            (usage.total ?? 0) / DAILY_QUOTA * 100 >= USAGE_WARN_PCT) {
            await notifyAdmin(bot, buildUsageWarnText(usage.total ?? 0, usage.worker ?? 0));
            state.usageWarned = true;
            result.usageWarned = true;
            await saveState(env, state);
        }
    } catch (error) {
        console.log(`automation: usage warn failed — ${safeError(error)}`);
    }

    // ---------- ۵) خلاصه‌ی روزانه (یک‌بار در روز UTC — همان نمونه‌ی مصرف) ----------
    try {
        if (bot && !state.digestSent) {
            const users = await getSubUsers(env);
            // 🛰️ خلاصه‌ی لبه — ترافیک واقعی کلاینت‌ها (colo/RTT/ISP)
            let edgeSummary: string | null = null;
            try {
                edgeSummary = buildEdgeSummary(await getEdgeTelemetry(env));
            } catch {
                // بدون telemetry — digest بدون این خط
            }
            await notifyAdmin(bot, buildDigestText({ usage, users, date: today, bestProxyIP: result.bestProxyIP, bestCleanIP: result.bestCleanIP, edgeSummary }));
            state.digestSent = true;
            result.digestSent = true;
            await saveState(env, state);
        }
    } catch (error) {
        console.log(`automation: digest failed — ${safeError(error)}`);
    }

    return result;
}

/**
 * خلاصه‌ی روی‌تقاضا — برای دستور /digest ربات (بدون گارد روزانه).
 * usage را تازه می‌گیرد؛ اگر fail شود، خلاصه بدون بخش مصرف ساخته می‌شود.
 */
export async function buildDigestForCommand(env: Env): Promise<string> {
    const [users, usage, telemetry] = await Promise.all([
        getSubUsers(env),
        getCfWorkerUsage().catch(() => ({ success: false })),
        getEdgeTelemetry(env).catch(() => null)
    ]);

    return buildDigestText({ usage, users, edgeSummary: buildEdgeSummary(telemetry) });
}
