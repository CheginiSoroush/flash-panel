/**
 * نگهبان اتصال WebSocket — جایگزین عملی «ping frame» در Cloudflare Workers
 *
 * چرا این طراحی؟
 *  - WebSocket در Workers هیچ API ای برای ارسال ping frame در سطح پروتکل ندارد
 *    (فقط send/close/accept) — و ارسال بایت دلخواه روی استریم VLESS/Trojan
 *    استریم را خراب می‌کند. پس نگه‌داریِ سمت سرور فقط به شکل «بستن اتصال‌های
 *    زامبی» ممکن است.
 *  - روی شبکه موبایل (مخصوصاً بعد از تعویض BTS) mapping عمومی NAT می‌میرد ولی
 *    لبه‌ی Cloudflare متوجه نمی‌شود؛ کلاینت تا timeout های طولانی TCP معلق
 *    می‌ماند. بستنِ فعالِ اتصالِ بی‌تفاوت، کلاینت را به reconnect فوری می‌برد —
 *    عملاً «نگه‌داری اتصال» با احیای سریع.
 *
 * دوطرفه بودن آستانه مهم است: دانلود فعال یعنی سمت کلاینت ساکت ولی سمت سرور
 * در حال نوشتن — با ثبت activity هر دو جهت، اتصال سالم بسته نمی‌شود.
 */

export interface WsGuardianOptions {
    /** آستانه‌ی بی‌تفاوتی دوطرفه (ms) — بیشتر از این = اتصال زامبی */
    idleMs: number;
    /** فاصله‌ی بررسی (ms) — پیش‌فرض ۱۰ ثانیه؛ برای تست‌ها قابل تغییر */
    checkMs?: number;
}

export interface WsGuardianConfig {
    enabled: boolean;
    /** آستانه به ثانیه — بین ۳۰ تا ۳۶۰۰ */
    idleSec: number;
}

export const WS_GUARDIAN_DEFAULT_IDLE_SEC = 300;
export const WS_GUARDIAN_MIN_IDLE_SEC = 30;
export const WS_GUARDIAN_MAX_IDLE_SEC = 3600;

/** فاصله‌ی بررسی — ثابت ۱۰ ثانیه؛ در تست‌ها با checkMs override می‌شود */
const DEFAULT_CHECK_MS = 10_000;

// رجیستری activity — WeakMap تا سوکت بسته‌شده GC شود و رفرش ارزان بماند
const activity = new WeakMap<WebSocket, { lastRead: number; lastWrite: number }>();

/** ثبت فعالیت سمت کلاینت — در makeReadableWebSocketStream روی هر message */
export function touchWsRead(ws: WebSocket): void {
    const a = activity.get(ws);
    if (a) a.lastRead = Date.now();
}

/** ثبت فعالیت سمت سرور — در remoteSocketToWS روی هر chunk نوشته‌شده */
export function touchWsWrite(ws: WebSocket): void {
    const a = activity.get(ws);
    if (a) a.lastWrite = Date.now();
}

/** آخرین زمان فعالیت دوطرفه — برای تست‌ها و دیباگ */
export function wsLastActivity(ws: WebSocket): { lastRead: number; lastWrite: number } | null {
    return activity.get(ws) ?? null;
}

/** کلمپ آستانه‌ی ثانیه‌ای — ورودی KV/فرم ممکنه خراب باشد؛ مقدار غایب = پیش‌فرض */
export function clampGuardianIdleSec(raw: unknown): number {
    if (raw === null || raw === undefined || raw === '') return WS_GUARDIAN_DEFAULT_IDLE_SEC;
    const value = Math.floor(Number(raw));
    if (!Number.isFinite(value)) return WS_GUARDIAN_DEFAULT_IDLE_SEC;
    return Math.min(Math.max(value, WS_GUARDIAN_MIN_IDLE_SEC), WS_GUARDIAN_MAX_IDLE_SEC);
}

/**
 * اتصال نگهبان به یک WS پذیرفته‌شده (accept شده).
 *
 * onClose تزریقی است تا ماژول از منطق بستن TCP/WS جدا بماند (تست‌پذیری) —
 * در هندلرها safeCloseTcpSocket(remoteSocketWrapper.value) + safeCloseWebSocket
 * را می‌بندد. تایمر با رویداد close/error خود WS هم پاک می‌شود.
 */
export function attachWsGuardian(
    ws: WebSocket,
    onClose: () => void,
    options: WsGuardianOptions,
    log: (info: string) => void = () => {}
): void {
    const idleMs = Math.max(options.idleMs, 1_000);
    const checkMs = Math.max(options.checkMs ?? DEFAULT_CHECK_MS, 250);

    activity.set(ws, { lastRead: Date.now(), lastWrite: Date.now() });

    const stop = () => clearInterval(timer);

    const timer = setInterval(() => {
        const a = activity.get(ws);
        const last = Math.max(a?.lastRead ?? 0, a?.lastWrite ?? 0);
        const idle = Date.now() - last;

        if (idle >= idleMs) {
            stop();
            log(`ws guardian: idle ${Math.round(idle / 1000)}s — closing zombie connection`);
            onClose();
        }
    }, checkMs);

    // اتصال تمام‌شده → تایمر نباید context را بیشتر از لازم نگه دارد
    ws.addEventListener('close', stop);
    ws.addEventListener('error', stop);
}
