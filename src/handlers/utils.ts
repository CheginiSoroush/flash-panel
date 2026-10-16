import { HttpStatus } from '@common';
import { getGlobals } from '@settings';

/**
 * هدرهای ضد شناسایی / ضد نشتی برای همه‌ی پاسخ‌های حساس (پنل، لاگین، اشتراک، خطا):
 * - X-Robots-Tag: موتورهای جستجو ایندکس نکنند — روش اصلی لو رفتن پنل‌ها، ایندکس
 *   صفحه‌ی لاگین/اشتراک در گوگل و اسکنرهای دامنه‌ی workers.dev است.
 * - Referrer-Policy: no-referrer — لینک اشتراک (شامل securePath محرمانه) با
 *   هدر Referer به سایت‌های ثالث نشت نمی‌کند.
 * - X-Content-Type-Options: nosniff — جلوی MIME-sniffing روی پاسخ‌های متنی را می‌گیرد.
 */
export function hardenResponse(response: Response): Response {
    const res = new Response(response.body, response);
    res.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
    res.headers.set('Referrer-Policy', 'no-referrer');
    res.headers.set('X-Content-Type-Options', 'nosniff');
    return res;
}

/** robots.txt در ریشه‌ی دامنه — بدون افشای هیچ اطلاعاتی، کل خزیدن را برای همه تعطیل می‌کند */
export function robotsResponse(): Response {
    return new Response('User-agent: *\nDisallow: /\n', {
        headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'public, max-age=86400',
        },
    });
}

export async function fallback(request: Request): Promise<Response> {
    const { url, method, headers, body } = request;
    const { fallback } = getGlobals();

    if (!fallback) return new Response('Not Found', { status: HttpStatus.NOT_FOUND });

    const newURL = new URL(url);
    newURL.hostname = fallback;
    newURL.protocol = 'https:';
    const newRequest = new Request(newURL.toString(), {
        method,
        headers,
        body,
        redirect: 'manual'
    });

    return fetch(newRequest);
}