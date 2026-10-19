import { handleDoH } from '@handlers/doh';
import { renderError } from '@handlers/error';
import { handleLogin } from '@handlers/login';
import { handlePanel } from '@handlers/panel';
import { handleProxyIPs } from '@handlers/proxy-ip';
import { handleCleanIPs } from '@handlers/clean-ip';
import { generateQRCode } from '@handlers/qrcode';
import { handleSubscriptions } from '@handlers/subscription';
import { handleTelegram } from '@handlers/telegram';
import { fallback, hardenResponse, robotsResponse } from '@handlers/utils';
import { handleWebsocket } from '@handlers/websocket';
import { recordEdgeSample } from '@settings/edge-telemetry';
import { runScheduledAutomation } from '@api/automation';
import { init, getGlobals, loadApiToken } from '@settings';

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext) {
        try {
            init(request, env);
            // v0.8.12 — توکن CF از KV (کلید cfApiToken) قبل از هر فیچر CF-API؛
            // کش ۵ ثانیه‌ای دارد و failure-safe است (هرگز مسیر درخواست را نمی‌شکند)
            await loadApiToken(env);

            // Upgrade باید case-insensitive باشه (RFC 6455)
            if ((request.headers.get('Upgrade') || '').toLowerCase() === 'websocket') {
                return handleWebsocket(request, env, ctx);
            }

            const { securePath, pathname } = getGlobals();

            // robots.txt در ریشه‌ی دامنه — قبل از گارد securePath (استاندارد جایی
            // است که خزنده‌ها سراغش می‌روند)؛ محتوایش هیچ اطلاعاتی افشا نمی‌کند
            if (pathname === '/robots.txt') {
                return robotsResponse();
            }

            // روتینگ سگمنت‌محور — بدون join/splice و تخصیص‌های اضافه
            // معادل دقیق منطق قبلی: '/segment1/segment2/...' → مسیر ۳ سگمنتی
            const segments = pathname.split('/');
            if (segments[1] !== securePath) {
                return fallback(request);
            }

            let response: Response;
            switch (segments[2]) {
                case 'panel':
                    response = await handlePanel(request, env);
                    break;

                case 'login':
                    response = await handleLogin(request, env);
                    break;

                case 'sub':
                    // 🛰️ Edge telemetry — ترافیک واقعی کاربران (cf.colo/clientTcpRtt/asn)
                    recordEdgeSample(request, env, ctx, 'http');
                    response = await handleSubscriptions(request, env);
                    break;

                case 'telegram':
                    response = await handleTelegram(request, env);
                    break;

                case 'dns-query':
                    response = await handleDoH(request);
                    break;

                case 'proxy-ip':
                    response = await handleProxyIPs(request, env);
                    break;

                case 'clean-ip':
                    response = await handleCleanIPs(request, env);
                    break;

                case 'qrcode':
                    response = await generateQRCode(request);
                    break;

                default:
                    return fallback(request);
            }

            // ضد شناسایی/نشتی روی همه‌ی پاسخ‌های مسیر امن (پنل/لاگین/اشتراک/…)
            return hardenResponse(response);
        } catch (error) {
            return hardenResponse(await renderError(error));
        }
    },

    /**
     * Cron trigger — موتور اتوماسیون (نمونه‌گیری مصرف + Auto-Tune ProxyIP +
     * sweep انقضا + هشدار + digest).
     *
     * زمان‌بندی هر ۳۰ دقیقه در metadata دیپلوی ست می‌شود (rescue-panel-update)؛
     * همه‌ی مراحل best-effort اند و گارد روزانه در KV جلوی notify تکراری را می‌گیرد؛
     * Auto-Tune گارد ۶ ساعته دارد و sweep/digest گارد روزانه.
     */
    async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
        ctx.waitUntil(runScheduledAutomation(env));
    }
}