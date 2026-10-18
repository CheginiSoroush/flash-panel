import { safeError } from '@common';
import { getGlobals } from '@settings';
import { resolveWorkerName } from './worker-name';

/**
 * 🛡️ گارد ضد-abuse — workers.dev باید همیشه بسته بماند.
 *
 * پس‌زمینه: اسکنرها ۲۴/۷ روی *.workers.dev می‌خرورند و به Cloudflare گزارش
 * خودکار abuse می‌دهند (گزارش‌های واقعی 2512190207a0dbbf و 92750cec97857ec6
 * روی flash-panel.cheginisoroush6.workers.dev). یک deploy اشتباه، wizard
 * تازه‌نصب، یا تغییر دستی می‌تواند workers.dev را دوباره روشن کند — این گارد
 * هر tick اتوماسیون وضعیت را چک می‌کند، بازها را بسته می‌کند و به ادمین
 * خبر می‌دهد (با cooldown ضد-اسپم).
 *
 * اصول: best-effort مطلق — هیچ خطایی به cron نمی‌رسد؛ دسترسی‌نداشتن به
 * یک اسکریپت = ردِ بی‌صدای همان اسکریپت، نه crash.
 */

export interface WorkersDevGuardResult {
    /** چک بدون خطای بحرانی تمام شد */
    ok: boolean;
    /** اسکریپت‌هایی که وضعیت workers.dev شان خوانده شد */
    checked: string[];
    /** اسکریپت‌هایی که workers.dev شان باز پیدا شد */
    enabledFound: string[];
    /** اسکریپت‌هایی که بستیم */
    disabled: string[];
    /** باز مانده‌ها (PATCH شکست خورد) — نیازمند اقدام دستی */
    leftOpen: string[];
    error?: string;
}

interface GuardAlertState {
    at?: number;
}

const ALERT_KEY = 'workersdevGuardAlert';
/** بین هشدارهای تکراری حداقل ۱۲ ساعت فاصله — ضد-اسپم */
const ALERT_COOLDOWN_MS = 12 * 3_600_000;
/** سقف اسکریپت‌های چک‌شده در هر دور — پلن رایگان سقف subrequest خشک دارد؛ ۲۵ امن است */
const MAX_SCRIPTS = 25;

async function cfJson(accID: string, apiToken: string, path: string, method: string = 'GET', body?: unknown) {
    let res: Response;
    try {
        res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accID}/workers/scripts${path}`, {
            method,
            headers: {
                'Authorization': `Bearer ${apiToken}`,
                ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
            },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {})
        });
    } catch {
        // خطای سطح شبکه — مثل پاس غریبه رفتار می‌کنیم تا caller بتواند fallback بگیرد
        return { status: 0, data: null };
    }
    const data: any = await res.json().catch(() => null);
    return { status: res.status, data };
}

/**
 * چک + بستن workers.dev روی همه‌ی اسکریپت‌های قابل‌مشاهده.
 * اگر لیست‌کردن اسکریپت‌ها ممنوع بود (توکن محدود)، فقط اسکریپت خود پنل چک می‌شود.
 */
export async function ensureWorkersDevDisabled(): Promise<WorkersDevGuardResult> {
    const { accID, apiToken } = getGlobals();
    const result: WorkersDevGuardResult = { ok: false, checked: [], enabledFound: [], disabled: [], leftOpen: [] };

    if (!accID || !apiToken) {
        result.error = 'missing accID/apiToken in embedded settings';
        return result;
    }

    // ۱) لیست اسکریپت‌ها — اگر نشد، فقط اسکریپت خودمان
    let names: string[] = [];
    const list = await cfJson(accID, apiToken, '');
    const listed = list.data?.result;
    if (Array.isArray(listed)) {
        names = listed
            .map((s: any) => s?.id)
            .filter((n: unknown): n is string => typeof n === 'string' && !!n);
    } else {
        names = [resolveWorkerName()];
        result.error = `list-scripts unavailable (HTTP ${list.status}) — checking own script only`;
    }

    // ۲) وضعیت workers.dev هر اسکریپت + بستن بازها
    for (const name of names.slice(0, MAX_SCRIPTS)) {
        let enabled: unknown;
        try {
            const sub = await cfJson(accID, apiToken, `/${encodeURIComponent(name)}/subdomain`);
            // پاس غریبه (مثلاً پاس GraphQL در تست‌ها یا 403) → رد بی‌صدا
            if (!sub.data?.result || typeof sub.data.result !== 'object') continue;
            enabled = sub.data.result.enabled;
        } catch {
            continue; // best-effort
        }
        result.checked.push(name);

        if (enabled !== true) continue;
        result.enabledFound.push(name);

        try {
            const patch = await cfJson(accID, apiToken, `/${encodeURIComponent(name)}/subdomain`, 'PATCH', {
                enabled: false,
                previews_enabled: false
            });
            if (patch.data?.result?.enabled === false || patch.status === 200) {
                result.disabled.push(name);
            } else {
                result.leftOpen.push(name);
            }
        } catch {
            result.leftOpen.push(name);
        }
    }

    result.ok = result.leftOpen.length === 0;
    return result;
}

export function buildGuardText(res: WorkersDevGuardResult): string {
    const lines: string[] = ['🛡️ <b>Workers.dev guard</b>', '━━━━━━━━━━━━━━━━'];
    if (res.enabledFound.length) {
        lines.push(`⚠️ Found enabled: ${res.enabledFound.map((n) => `<code>${n}</code>`).join(', ')}`);
    }
    if (res.disabled.length) {
        lines.push(`✅ Auto-disabled: ${res.disabled.map((n) => `<code>${n}</code>`).join(', ')}`);
    }
    if (res.leftOpen.length) {
        lines.push(`🔴 <b>STILL OPEN (manual fix needed!):</b> ${res.leftOpen.map((n) => `<code>${n}</code>`).join(', ')}`);
    }
    lines.push('', 'Scanners auto-report <code>*.workers.dev</code> hosts — keep them off.');
    return lines.join('\n');
}

/**
 * نقطه‌ی ورود از automation — چک + بستن + هشدار ادمین (فقط وقتی چیزی باز بود،
 * حداکثر یک‌بار در ۱۲ ساعت). هرگز throw نمی‌کند؛ null یعنی دور رد شد.
 */
export async function runWorkersDevGuard(
    env: Env,
    notify: ((html: string) => Promise<void>) | null
): Promise<WorkersDevGuardResult | null> {
    try {
        const res = await ensureWorkersDevDisabled();

        if (res.enabledFound.length) {
            let last = 0;
            try {
                const st = await env.kv.get(ALERT_KEY, { type: 'json' }) as GuardAlertState | null;
                last = typeof st?.at === 'number' ? st.at : 0;
            } catch {
                // خواندن نشد — هشدار می‌دهیم
            }

            if (Date.now() - last >= ALERT_COOLDOWN_MS) {
                if (notify) {
                    try {
                        await notify(buildGuardText(res));
                    } catch (error) {
                        console.log(`workersdev-guard: notify failed — ${safeError(error)}`);
                    }
                }
                try {
                    await env.kv.put(ALERT_KEY, JSON.stringify({ at: Date.now() } satisfies GuardAlertState));
                } catch {
                    // نوشتن نشد — دور بعد ممکن است هشدار تکرار شود؛ قابل‌قبول
                }
            }
        }

        return res;
    } catch (error) {
        console.log(`workersdev-guard: failed — ${safeError(error)}`);
        return null;
    }
}
