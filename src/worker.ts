import { handleDoH } from '@handlers/doh';
import { renderError } from '@handlers/error';
import { handleLogin } from '@handlers/login';
import { handlePanel } from '@handlers/panel';
import { handleProxyIPs } from '@handlers/proxy-ip';
import { generateQRCode } from '@handlers/qrcode';
import { handleSubscriptions } from '@handlers/subscription';
import { handleTelegram } from '@handlers/telegram';
import { fallback } from '@handlers/utils';
import { handleWebsocket } from '@handlers/websocket';
import { sampleUsageNow } from '@api/usage';
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

            // روتینگ سگمنت‌محور — بدون join/splice و تخصیص‌های اضافه
            // معادل دقیق منطق قبلی: '/segment1/segment2/...' → مسیر ۳ سگمنتی
            const segments = pathname.split('/');
            if (segments[1] !== securePath) {
                return fallback(request);
            }

            switch (segments[2]) {
                case 'panel':
                    return handlePanel(request, env);

                case 'login':
                    return handleLogin(request, env);

                case 'sub':
                    return handleSubscriptions(request, env);

                case 'telegram':
                    return handleTelegram(request, env);

                case 'dns-query':
                    return handleDoH(request);

                case 'proxy-ip':
                    return handleProxyIPs(request, env);

                case 'qrcode':
                    return generateQRCode(request);

                default:
                    return fallback(request);
            }
        } catch (error) {
            return renderError(error);
        }
    },

    /**
     * Cron trigger — نمونه‌گیری خودکار مصرف.
     *
     * بدون این، سری زمانی usage فقط وقتی ثبت می‌شه که کسی پنل رو باز کنه —
     * روزهای بدون بازدید توی نمودار مصرف خالی می‌مونن. با یک cron روزانه
     * (پیشنهاد: '0 3 * * *' در wrangler.jsonc → triggers.crons) حتی بدون
     * بازدید، نمونه‌ی روزانه ثبت می‌شه. best-effort — خطا هرگز throw نمی‌شه.
     */
    async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
        ctx.waitUntil(sampleUsageNow(env));
    }
}