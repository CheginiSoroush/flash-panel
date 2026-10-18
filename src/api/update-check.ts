import { respond, HttpStatus, safeError } from '@common';
import { authenticate } from '@auth';
import { getSettings } from '@settings';

/**
 * 🛰 panel/update-check — چکِ نسخه‌ی سمت سرور، پشتیبانِ چکِ سمت مرورگر.
 *
 * مشکل ریشه‌ای («دکمه‌ی آپدیت فعال نیست»): checkVersion سمت کلاینت
 * package.json را مستقیم از raw.githubusercontent / jsDelivr می‌گیرد —
 * در شبکه‌های فیلترشده (مثل ایران) هر دو اغلب از دسترس خارج‌اند، پس fetch
 * بی‌صدا شکست می‌خورد و دکمه‌ی Update هیچ‌وقت از حالت disabled درنمی‌آمد.
 *
 * راه‌حل: خود ورکر از لبه‌ی کلادفلر (egress کلادفلر هرگز فیلتر نمی‌شود)
 * آخرین نسخه را از همان آینه‌ها می‌گیرد؛ کلاینت بعد از شکست آینه‌های مستقیم
 * به این endpoint fallback می‌کند.
 *
 * قواعد write-diet: این endpoint صفر KV put انجام می‌دهد — کش سطح isolate
 * با TTL ده‌دقیقه‌ای، تا چند ادمین/ری‌لود هم درخواست گیت‌هاب تکرار نکنند.
 */

const VERSION_MIRRORS: readonly { name: string; url: string }[] = [
    {
        name: 'raw-github',
        url: 'https://raw.githubusercontent.com/CheginiSoroush/flash-panel/refs/heads/main/package.json'
    },
    {
        name: 'jsdelivr',
        url: 'https://cdn.jsdelivr.net/gh/CheginiSoroush/flash-panel@main/package.json'
    }
];

const CACHE_TTL_MS = 10 * 60 * 1000;
const MIRROR_TIMEOUT_MS = 8_000;
const VERSION_RE = /^\d+\.\d+\.\d+$/;

interface LatestVersionResult {
    latest: string | null;
    source: string;
    error?: string;
}

interface VersionCacheState {
    cache: { latest: string; source: string; at: number } | null;
    inflight: Promise<LatestVersionResult> | null;
}

const state: VersionCacheState = { cache: null, inflight: null };

export function resetUpdateCheckCache(): void {
    state.cache = null;
    state.inflight = null;
}

/** همان منطق مقایسه‌ی کلاینت (isNewerVersion در script.js) — سمن‌ور ساده x.y.z */
export function isNewerVersion(latest: string, current: string): boolean {
    const lv = latest.split('.').map(Number);
    const cv = current.split('.').map(Number);

    for (let i = 0; i < Math.max(lv.length, cv.length); i++) {
        const l = lv[i] ?? 0;
        const c = cv[i] ?? 0;
        if (l > c) return true;
        if (l < c) return false;
    }

    return false;
}

async function fetchVersionFromMirror(
    mirror: { name: string; url: string }
): Promise<LatestVersionResult> {
    const res = await fetch(mirror.url, {
        cache: 'no-store',
        signal: AbortSignal.timeout(MIRROR_TIMEOUT_MS)
    });
    if (!res.ok) {
        return { latest: null, source: mirror.name, error: `mirror ${mirror.name} → status ${res.status}` };
    }

    const pkg: any = await res.json().catch(() => null);
    const version = pkg?.version;
    if (typeof version !== 'string' || !VERSION_RE.test(version)) {
        return { latest: null, source: mirror.name, error: `mirror ${mirror.name} → invalid payload` };
    }

    return { latest: version, source: mirror.name };
}

/** آخرین نسخه‌ی منتشرشده — با کش isolate + ادغام درخواست‌های هم‌زمان (inflight) */
export async function fetchLatestVersion(): Promise<LatestVersionResult> {
    if (state.cache && Date.now() - state.cache.at < CACHE_TTL_MS) {
        return { latest: state.cache.latest, source: state.cache.source };
    }
    if (state.inflight) {
        return state.inflight;
    }

    state.inflight = (async (): Promise<LatestVersionResult> => {
        const errors: string[] = [];
        for (const mirror of VERSION_MIRRORS) {
            try {
                const result = await fetchVersionFromMirror(mirror);
                if (result.latest) {
                    state.cache = { latest: result.latest, source: result.source, at: Date.now() };
                    return result;
                }
                errors.push(result.error ?? `${mirror.name} failed`);
            } catch (error) {
                errors.push(`mirror ${mirror.name} → ${safeError(error)}`);
            }
        }

        return { latest: null, source: 'none', error: errors.join(' | ') || 'all version mirrors failed' };
    })();

    try {
        return await state.inflight;
    } finally {
        state.inflight = null;
    }
}

export async function getUpdateCheckEndpoint(request: Request, env: Env): Promise<Response> {
    try {
        const auth = await authenticate(request, env);
        if (!auth) {
            return respond(false, HttpStatus.UNAUTHORIZED, 'Unauthorized or expired session.');
        }

        const { latest, source, error } = await fetchLatestVersion();
        const current = getSettings().panelVersion;

        if (!latest) {
            return respond(
                false,
                HttpStatus.SERVICE_UNAVAILABLE,
                `Version check failed on server: ${error ?? 'all mirrors failed'}`
            );
        }

        return respond(true, HttpStatus.OK, '', {
            latest,
            current,
            updateAvailable: isNewerVersion(latest, current),
            source
        });
    } catch (error) {
        return respond(
            false,
            HttpStatus.INTERNAL_SERVER_ERROR,
            `Error occurred while checking for updates: ${safeError(error)}`
        );
    }
}
