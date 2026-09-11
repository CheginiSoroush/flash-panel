import { HttpStatus } from '@common';
import { TrOverWSHandler } from '@protocols/trojan';
import { VlOverWSHandler } from '@protocols/vless';
import { getGlobals } from '@settings';
import { fallback } from './utils';

export async function handleWebsocket(request: Request): Promise<Response> {
    const { pathname } = getGlobals();

    // استخراج سگمنت اول بدون ساخت آرایه (در هر کانکشن اجرا می‌شه)
    // '/vl' → 'vl' ، '/vl/xyz' → 'vl' ، '/' → ''
    const slash = pathname.indexOf('/', 1);
    const protocol = slash === -1 ? pathname.slice(1) : pathname.slice(1, slash);

    try {
        switch (protocol) {
            case 'vl':
                return VlOverWSHandler(request);

            case 'tr':
                return TrOverWSHandler(request);

            default:
                return fallback(request);
        }
    } catch (error) {
        // فقط در مسیر خطا اجرا می‌شه — علت واقعی برای دیباگ لاگ بشه
        console.error('handleWebsocket error:', error);
        return new Response('Bad Request', { status: HttpStatus.BAD_REQUEST });
    }
}