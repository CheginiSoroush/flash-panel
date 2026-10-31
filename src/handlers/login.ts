import { generateJWTToken, authenticate, isTotpEnabled } from '@auth';
import { decompressGzipBase64, respond, HttpStatus } from '@common';
import { getGlobals } from '@settings';
import { fallback } from './utils';

// ---------- کش سطح isolate برای HTML لاگین ----------

let cachedLoginHtml: string | null = null;
let cachedLoginEtag = '';

async function getLoginHtml(): Promise<{ html: string; etag: string }> {
    if (cachedLoginHtml !== null) {
        return { html: cachedLoginHtml, etag: cachedLoginEtag };
    }

    const str = await decompressGzipBase64(LOGIN_HTML_CONTENT);
    cachedLoginHtml = str.replaceAll('__ICON__', ICON_CONTENT);

    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(cachedLoginHtml));
    let hex = '';
    for (const b of new Uint8Array(digest).slice(0, 8)) {
        hex += b.toString(16).padStart(2, '0');
    }
    cachedLoginEtag = `"${hex}"`;

    return { html: cachedLoginHtml, etag: cachedLoginEtag };
}

export async function handleLogin(request: Request, env: Env): Promise<Response> {
    const { pathname } = getGlobals();
    const parts = pathname.split('/');
    const path = parts.slice(2).join('/');

    switch (path) {
        case 'login':
            return renderLogin(request, env);

        case 'login/authenticate':
            return generateJWTToken(request, env);

        case 'login/totp-status':
            return getTotpStatus(request, env);

        default:
            return fallback(request);
    }
}

async function renderLogin(request: Request, env: Env): Promise<Response> {
    const auth = await authenticate(request, env);
    if (auth) {
        const panelURL = new URL('./panel', request.url);
        return Response.redirect(panelURL, 302);
    }

    const { html, etag } = await getLoginHtml();

    // revalidate — رفرش بعدی فقط 304
    if (request.headers.get('If-None-Match') === etag) {
        return new Response(null, {
            status: 304,
            headers: {
                'ETag': etag,
                'Cache-Control': 'no-cache'
            }
        });
    }

    return new Response(html, {
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'ETag': etag,
            'Cache-Control': 'no-cache'
        }
    });
}

/**
 * وضعیت 2FA برای صفحه لاگین — عمومی ولی فقط یک boolean (بدون افشای secret)
 * صفحه لاگین با این تصمیم می‌گیره فیلد کد رو نشون بده یا نه
 */
async function getTotpStatus(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'GET') {
        return respond(false, HttpStatus.METHOD_NOT_ALLOWED, 'Method not allowed.');
    }

    // v0.8.37 — از کش ۱۵ثانیه‌ای isTotpEnabled به‌جای خواندن خام KV در هر بازدید
    // (صفحه‌ی لاگین داغ‌ترین مسیر عمومی است) + stale-on-error داخلی → outage هم 200
    const enabled = await isTotpEnabled(env);

    return respond(true, HttpStatus.OK, undefined, { enabled }, {
        'Cache-Control': 'no-store'
    });
}