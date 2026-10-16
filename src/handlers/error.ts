import { decompressGzipBase64, safeError } from '@common';

/** escape کامل HTML — پیام خطا ممکن است ورودی کاربر را داشته باشد (جلوگیری از XSS بازتابی) */
function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export async function renderError(error: any): Promise<Response> {
    const str = await decompressGzipBase64(ERROR_HTML_CONTENT);
    const html = str
        // replacer تابعی — الگوهای $&/$' داخل پیام به‌عنوان جایگزینی تفسیر نشوند
        .replace('__ERROR_MESSAGE__', () => escapeHtml(safeError(error)))
        .replaceAll('__ICON__', () => ICON_CONTENT);

    return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
}
