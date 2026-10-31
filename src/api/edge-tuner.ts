import { safeError } from '@common';
import { getEdgeTelemetry, EdgeDay, EdgeAgg, formatBytes } from '@settings/edge-telemetry';
import { tuneProxyIPs } from './proxy-tuner';
import { tuneCleanIPs } from './clean-tuner';
import { escapeHtml } from './telegram-broadcast';

/**
 * 🎯 Edge-Tuner — حلقه‌ی بسته‌ی هوش لبه (v0.8.5)
 *
 * v0.8.4 تلمتری را می‌دید ولی تصمیم نمی‌گرفت؛ این ماژول تصمیم می‌گیرد:
 *
 *   امروز میانگین TCP-RTT واقعی کاربران نسبت به baseline (EMA) بیشتر از
 *   آستانه پرید؟ → یعنی ورودی‌ها (ProxyIP/CleanIP) برای اپراتورهای واقعی
 *   خراب‌تر شده‌اند → خودکار tuner ها را بیدار می‌کند و به ادمین هشدار
 *   دقیق می‌دهد (کدام ASN بدترین افت را داشته).
 *
 * چرا EMA و نه مقایسه‌ی روز-به-روز؟ RTT پایه‌ی هر اپراتور متفاوت است و
 * نوسان روزانه دارد؛ EMA (وزن ۸۵/۱۵ روزانه) خط پایه‌ی پایدار می‌سازد و
 * فقط «جهش» واقعی را می‌گذرد.
 *
 * آستانه‌ها (تجربی، از داده‌ی زنده‌ی v0.8.4):
 *   - جهش فقط وقتی «مطلق + نسبی» باهم رد شد (جهش کم-but-نسبی بزرگ در
 *     RTT های خیلی پایین مثلاً ۵→۱۰ms نویز است؛ ۶۰→۹۵ms واقعی).
 *   - حداقل نمونه: با ترافیک کم، میانگین ناپایدار است — تصمیم نه.
 *   - cooldown تیون ۶ ساعت / cooldown هشدار ۱۲ ساعت (ضد-اسپم تلگرام).
 *
 * هرگز throw نمی‌کند — پروکسی هرگز نباید به پنل وابسته بماند.
 */

export interface EdgeTuneResult {
    status: 'no-data' | 'insufficient' | 'baseline-set' | 'ok' | 'spike' | 'error';
    /** میانگین RTT امروز (ms) — فقط وقتی نمونه‌ی کافی باشد */
    todayAvgRtt?: number;
    /** خط پایه‌ی EMA (ms) */
    baselineRtt?: number;
    /** نمونه‌های RTT دار امروز */
    rttSamples?: number;
    /** ASN های بدترین افت — فقط در spike */
    spikeAsns?: string[];
    /** آیا tuner ها در این دور بیدار شدند؟ */
    tuned?: boolean;
}

interface EdgeTunerState {
    /** خط پایه‌ی EMA (ms) */
    baselineRtt?: number;
    /** تاریخ UTC آخرین blend شدن EMA — blend فقط یک‌بار در روز */
    baselineDate?: string;
    /** آخرین trigger تیون (epoch ms) — cooldown ۶ ساعت */
    lastTuneAt?: number;
    /** آخرین هشدار تلگرام (epoch ms) — cooldown ۱۲ ساعت */
    lastAlertAt?: number;
}

const TUNER_KEY = 'edgeTunerState';
/** حداقل نمونه‌ی RTT دار در روز برای تصمیم */
const MIN_RTT_SAMPLES = 8;
/** جهش مطلق حداقلی (ms) */
const SPIKE_ABS_MS = 40;
/** جهش نسبی حداقلی (×baseline) */
const SPIKE_RATIO = 1.5;
/** وزن EMA — ۸۵٪ پایه‌ی قبلی + ۱۵٪ امروز، یک‌بار در روز */
const EMA_OLD_WEIGHT = 0.85;
/** cooldown تیون (۶ ساعت) */
const TUNE_COOLDOWN_MS = 6 * 3_600_000;
/** cooldown هشدار (۱۲ ساعت) */
const ALERT_COOLDOWN_MS = 12 * 3_600_000;
/** حداقل نمونه‌ی یک ASN برای گزارش به‌عنوان مقصر */
const MIN_ASN_SAMPLES = 3;

// ---------- خواندن/نوشتن state ----------

async function loadState(env: Env): Promise<EdgeTunerState> {
    try {
        const raw = await env.kv.get(TUNER_KEY, { type: 'json' });
        if (raw && typeof raw === 'object') return raw as EdgeTunerState;
    } catch {
        // KV خراب — شروع تازه
    }
    return {};
}

async function saveState(env: Env, state: EdgeTunerState): Promise<void> {
    try {
        await env.kv.put(TUNER_KEY, JSON.stringify(state));
    } catch (error) {
        console.log(`edge-tuner: state save failed — ${safeError(error)}`);
    }
}

// ---------- تجمیع امروز ----------

interface DayRtt {
    rttSum: number;
    rttN: number;
    asns: Array<{ asn: string; avg: number; n: number }>;
}

/** جمع RTT های امروز از هر دو نقشه (colo + asn) — بدون دوبارشماری: فقط colo کافی است ولی per-ASN از asns می‌آید */
function summarizeDay(day: EdgeDay): DayRtt {
    let rttSum = 0;
    let rttN = 0;
    for (const a of Object.values(day.colos ?? {})) {
        if (a.rttSum > 0) {
            rttSum += a.rttSum;
            rttN += a.n;
        }
    }
    const asns: Array<{ asn: string; avg: number; n: number }> = [];
    for (const [asn, a] of Object.entries(day.asns ?? {})) {
        if (a.rttSum > 0 && a.n > 0) {
            asns.push({ asn, avg: Math.round(a.rttSum / a.n), n: a.n });
        }
    }
    asns.sort((x, y) => y.avg - x.avg);
    return { rttSum, rttN, asns };
}

function aggTraffic(agg: EdgeAgg | undefined): number {
    return agg?.downSum ?? 0;
}

// ---------- اجرا ----------

export async function runEdgeTuner(
    env: Env,
    /** v0.8.36 — callback می‌تواند boolean تحویل برگرداند (notifyAdmin)؛ void = تحویل فرض می‌شود */
    notify: ((html: string) => Promise<boolean | void>) | null,
    now: number = Date.now()
): Promise<EdgeTuneResult> {
    try {
        const telemetry = await getEdgeTelemetry(env);
        if (!telemetry?.days || !Object.keys(telemetry.days).length) {
            return { status: 'no-data' };
        }

        const today = new Date(now).toISOString().slice(0, 10);
        const day = telemetry.days[today];
        if (!day || day.date !== today) {
            return { status: 'no-data' };
        }

        const { rttSum, rttN, asns } = summarizeDay(day);
        if (rttN < MIN_RTT_SAMPLES) {
            return { status: 'insufficient', rttSamples: rttN };
        }

        const todayAvg = Math.round(rttSum / rttN);
        const state = await loadState(env);

        let baseline = state.baselineRtt;
        if (baseline === undefined) {
            // اولین مشاهده — خط پایه از داده‌ی امروز
            await saveState(env, { ...state, baselineRtt: todayAvg, baselineDate: today });
            return { status: 'baseline-set', baselineRtt: todayAvg, todayAvgRtt: todayAvg, rttSamples: rttN };
        }

        // ---------- تشخیص جهش — قبل از blend! ----------
        // داده‌ی روز جهش هرگز وارد EMA نمی‌شود (وگرنه baseline بالا می‌خزد و
        // جهش‌های مکرر کم‌کم «عادی» به نظر می‌رسیدند)
        const sinceTune = now - (state.lastTuneAt ?? 0);
        const sinceAlert = now - (state.lastAlertAt ?? 0);
        const isSpike = todayAvg >= baseline + SPIKE_ABS_MS && todayAvg >= baseline * SPIKE_RATIO;

        if (isSpike) {
            if (sinceTune < TUNE_COOLDOWN_MS) {
                // جهش ادامه دارد ولی cooldown تیون — blend هم نمی‌کنیم
                return { status: 'ok', todayAvgRtt: todayAvg, baselineRtt: baseline, rttSamples: rttN };
            }

            // مقصرها — ASN هایی که میانگینشان به‌طور معنادار بالای پایه است
            const spikeAsns = asns
                .filter((a) => a.n >= MIN_ASN_SAMPLES && a.avg >= baseline! + SPIKE_ABS_MS)
                .slice(0, 3)
                .map((a) => a.asn);

            // بیدار کردن tuner ها — best-effort، نتیجه فقط لاگ می‌شود
            let tuned = false;
            try {
                const proxy = await tuneProxyIPs(env);
                tuned = true;
                console.log(`edge-tuner: proxy tune on RTT spike — healthy ${proxy.healthyCount}/${proxy.poolSize}, best ${proxy.best ?? '—'}`);
            } catch (error) {
                console.log(`edge-tuner: proxy tune failed — ${safeError(error)}`);
            }
            try {
                const clean = await tuneCleanIPs(env, now);
                tuned = true;
                console.log(`edge-tuner: clean tune on RTT spike — healthy ${clean.healthyCount}/${clean.poolSize}, changed ${clean.changed}`);
            } catch (error) {
                console.log(`edge-tuner: clean tune failed — ${safeError(error)}`);
            }

            const trafficDown = Object.values(day.colos ?? {}).reduce((sum, a) => sum + aggTraffic(a), 0);

            // v0.8.36 — شکست تحویل (false) cooldown هشدار را نمی‌بندد: تیک تیون
            // بعدی (۶ ساعت) دوباره تلاش می‌کند؛ تحویلِ موفق همان ۱۲ ساعت آرامش
            let alertDelivered = false;
            if (notify && sinceAlert >= ALERT_COOLDOWN_MS) {
                const asnLines = spikeAsns.length
                    ? spikeAsns.map((a) => `• ${escapeHtml(a)}`).join('\n')
                    : '• — (no single dominant ASN)';
                const html =
                    `🎯 <b>Edge-Tuner — RTT Spike</b>\n` +
                    `Avg RTT today: <b>${todayAvg}ms</b> (baseline ${baseline}ms, +${todayAvg - baseline}ms)\n` +
                    `Samples: ${rttN}\n` +
                    `Worst ISPs:\n${asnLines}\n` +
                    (trafficDown > 0 ? `Observed traffic: ↓ ${formatBytes(trafficDown)}\n` : '') +
                    `🔧 ProxyIP + CleanIP tuners triggered automatically.`;
                try {
                    alertDelivered = (await notify(html)) !== false;
                } catch (error) {
                    console.log(`edge-tuner: alert failed — ${safeError(error)}`);
                }
            }

            // baselineDate = today → blend این روزِ آلوده به جهش رد می‌شود
            const next: EdgeTunerState = { ...state, baselineRtt: baseline, baselineDate: today, lastTuneAt: now };
            if (alertDelivered) next.lastAlertAt = now;
            await saveState(env, next);
            return { status: 'spike', todayAvgRtt: todayAvg, baselineRtt: baseline, rttSamples: rttN, spikeAsns, tuned };
        }

        // ---------- بدون جهش — blend روزانه‌ی EMA (فقط اولین دورِ روز) ----------
        const isNewDay = state.baselineDate !== today;
        if (isNewDay) {
            baseline = Math.round(baseline * EMA_OLD_WEIGHT + todayAvg * (1 - EMA_OLD_WEIGHT));
        }
        await saveState(env, { ...state, baselineRtt: baseline, baselineDate: today });
        return { status: 'ok', todayAvgRtt: todayAvg, baselineRtt: baseline, rttSamples: rttN };
    } catch (error) {
        console.log(`edge-tuner: unexpected failure — ${safeError(error)}`);
        return { status: 'error' };
    }
}
