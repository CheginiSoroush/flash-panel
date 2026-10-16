import { handleDoH } from '@handlers/doh';
import { renderError } from '@handlers/error';
import { handleLogin } from '@handlers/login';
import { handlePanel } from '@handlers/panel';
import { handleProxyIPs } from '@handlers/proxy-ip';
import { generateQRCode } from '@handlers/qrcode';
import { handleSubscriptions } from '@handlers/subscription';
import { handleTelegram } from '@handlers/telegram';
import { fallback, hardenResponse, robotsResponse } from '@handlers/utils';
import { handleWebsocket } from '@handlers/websocket';
import { runScheduledAutomation } from '@api/automation';
import { init, getGlobals } from '@settings';

export default {
    async fetch(request: Request, env: Env) {
        try {
            init(request, env);

            // Upgrade باید case-insensitive باشه (RFC 6455)
            if ((request.headers.get('Upgrade') || '').toLowerCase() === 'websocket') {
                return handleWebsocket(request, env);
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
     * Cron trigger — موتور اتوماسیون (نمونه‌گیری مصرف + sweep انقضا + هشدار + digest).
     *
     * پیشنهاد: ساعتی — '0 * * * *' در wrangler.jsonc → triggers.crons.
     * همه‌ی مراحل best-effort اند و گارد روزانه در KV جلوی notify تکراری را می‌گیرد؛
     * بدون بات تلگرام هم sweep و نمونه‌گیری کار می‌کنند (فقط پیامی ارسال نمی‌شود).
     */
    async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
        ctx.waitUntil(runScheduledAutomation(env));
    }
}