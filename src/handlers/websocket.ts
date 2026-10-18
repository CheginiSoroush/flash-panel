import { HttpStatus } from '@common';
import { TrOverWSHandler } from '@protocols/trojan';
import { VlOverWSHandler } from '@protocols/vless';
import { getGlobals, setAutoProxyIPs } from '@settings';
import { recordEdgeSample } from '@settings/edge-telemetry';
import { getWsRoute } from '@utils';
import { fallback } from './utils';
import { clampGuardianIdleSec, WsGuardianConfig } from '@protocols/ws-guardian';
import { getDataset } from '@kv';

// ----------
// پیکربندی نگهبان با کش ۵ دقیقه‌ای isolate — تنظیمات به‌ندرت عوض می‌شن و
// هر اتصال WS نباید هزینه‌ی خواندن KV داشته باشه (بعد از اولین fetch، صفر I/O).
// خرابی خواندن → گاردینگ خاموش (پروکسی هرگز نباید وابسته به پنل بشه)
// ----------

const GUARDIAN_CACHE_TTL = 5 * 60_000;

let guardianCache: { value: WsGuardianConfig; expiresAt: number } | null = null;

async function resolveGuardianConfig(env: Env): Promise<WsGuardianConfig> {
    if (guardianCache && Date.now() < guardianCache.expiresAt) {
        return guardianCache.value;
    }

    let config: WsGuardianConfig = { enabled: false, idleSec: clampGuardianIdleSec(undefined) };

    try {
        const { settings } = await getDataset(env);
        // فید Auto-Tune ProxyIP — در همان چرخه‌ی ۵ دقیقه‌ای، بدون خواندن اضافه
        setAutoProxyIPs(settings.autoProxyIPs);
        config = {
            enabled: settings.wsGuardianEnabled === true,
            idleSec: clampGuardianIdleSec(settings.wsGuardianIdleSec)
        };
    } catch {
        // تنظیمات در دسترس نیست — پیش‌فرض امن (خاموش)
    }

    guardianCache = { value: config, expiresAt: Date.now() + GUARDIAN_CACHE_TTL };
    return config;
}

export async function handleWebsocket(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const { pathname, securePath } = getGlobals();

    // گیت توکن مسیر — ضد پروب فعال: بدون توکن درست، هر WS آپگرید با صفحه‌ی
    // fallback (speedtest) جواب می‌گیرد نه 101 → ورکر از ظاهر یک سایت عادی
    // قابل تفکیک نیست. توکن = مشتق securePath (داخل TLS نامرئی برای DPI).
    const route = getWsRoute(pathname, securePath);

    try {
        switch (route) {
            case 'vl':
                // 🛰️ گیت پاس شد → ترافیک واقعی پروکسی — نمونه‌برداری لبه (همیشه)
                if (ctx) recordEdgeSample(request, env, ctx, 'ws');
                return VlOverWSHandler(request, await resolveGuardianConfig(env));

            case 'tr':
                if (ctx) recordEdgeSample(request, env, ctx, 'ws');
                return TrOverWSHandler(request, await resolveGuardianConfig(env));

            default:
                return fallback(request);
        }
    } catch (error) {
        // فقط در مسیر خطا اجرا می‌شه — علت واقعی برای دیباگ لاگ بشه
        console.error('handleWebsocket error:', error);
        return new Response('Bad Request', { status: HttpStatus.BAD_REQUEST });
    }
}
