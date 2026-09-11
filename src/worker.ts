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
import { init, getGlobals } from '@settings';

export default {
    async fetch(request: Request, env: Env) {
        try {
            init(request, env);

            // طبق RFC 6455 مقایسه Upgrade باید case-insensitive باشه
            // (کلاینتی که 'WebSocket' بفرسته قبلاً به مسیر پنل می‌افتاد)
            if ((request.headers.get('Upgrade') || '').toLowerCase() === 'websocket') {
                return handleWebsocket(request);
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
    }
}