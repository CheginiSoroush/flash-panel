/**
 * 📊 متریک‌های ترافیک هر اتصال WebSocket — حلقه‌ی دوم معکوس‌مهندسی (v0.8.5)
 *
 * v0.8.4 فقط RTT/colo/ASN هر handshake را می‌دید؛ حالا هر اتصال بسته‌شده
 * می‌گوید چقدر داده در هر جهت رد شد و چقدر زندگی کرد:
 *   - up   → بایت‌های کلاینت→ورکر (بدنه‌ی درخواست‌ها)
 *   - down → بایت‌های ورکر→کلاینت (محتوای دانلود)
 *   - durMs→ طول عمر اتصال
 *
 * چرا روی close ثبت می‌کنیم و نه handshake؟
 *   ۱) نمونه‌ی handshake ترافیک ندارد — دو نمونه‌ی همبسته فقط حجم KV و میانگین
 *      RTT را دوبرابر می‌کرد.
 *   ۲) یک اتصال = یک نمونه‌ی کامل (rtt + colo + asn + بایت‌ها) — اوراکل واقعی
 *      «چه کاربری از کدام ISP چقدر ترافیک از کدام لبه گرفت».
 *
 * کاربرد: تشخیص ISP/colo پرمصرف، هشدار افت کیفیت، و تصمیم‌های tuner بر پایه‌ی
 * مصرف واقعی — بدون هیچ subrequest اضافه.
 *
 * صفر هزینه در مسیر داغ: شمارش = یک جمع روی آبجکت WeakMap. هرگز throw نمی‌کند.
 */

export interface WsTraffic {
    /** بایت کلاینت → ورکر */
    up: number;
    /** بایت ورکر → کلاینت */
    down: number;
    /** طول عمر اتصال (ms) */
    durMs: number;
}

interface WsMetricRec extends WsTraffic {
    start: number;
}

// WeakMap — سوکت بسته‌شده GC می‌شود؛ رجیستری هیچ‌وقت نشت نمی‌کند
const metrics = new WeakMap<WebSocket, WsMetricRec>();

/** شروع اندازه‌گیری — در هندلر بعد از accept */
export function beginWsMetrics(ws: WebSocket): void {
    try {
        metrics.set(ws, { up: 0, down: 0, start: Date.now(), durMs: 0 });
    } catch {
        // هرگز مسیر پروکسی را خراب نکند
    }
}

/** شمارش بایت کلاینت→ورکر — در message listener استریم */
export function countWsUp(ws: WebSocket, n: number): void {
    if (n <= 0) return;
    try {
        const m = metrics.get(ws);
        if (m) m.up += n;
    } catch {
        // noop
    }
}

/** شمارش بایت ورکر→کلاینت — در حلقه‌ی remoteSocketToWS */
export function countWsDown(ws: WebSocket, n: number): void {
    if (n <= 0) return;
    try {
        const m = metrics.get(ws);
        if (m) m.down += n;
    } catch {
        // noop
    }
}

/**
 * پایان اندازه‌گیری — در eventهای close/error (idempotent: اولین فراخوانی
 * برمی‌گرداند و رکورد پاک می‌شود؛ دوباره null).
 * نکته‌ی پلتفرم: بعد از accept شدن WS، context درخواست تا بسته‌شدن WS زنده
 * می‌ماند → waitUntil در close listener معتبر است.
 */
export function endWsMetrics(ws: WebSocket): WsTraffic | null {
    try {
        const m = metrics.get(ws);
        if (!m) return null;
        metrics.delete(ws);
        return { up: m.up, down: m.down, durMs: Date.now() - m.start };
    } catch {
        return null;
    }
}

/** برای تست — ثبت مستقیم یک رکورد (بدون سوکت واقعی) */
export function _peekWsMetrics(ws: WebSocket): WsTraffic | null {
    try {
        const m = metrics.get(ws);
        return m ? { up: m.up, down: m.down, durMs: Date.now() - m.start } : null;
    } catch {
        return null;
    }
}
