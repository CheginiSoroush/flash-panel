import { connect } from 'cloudflare:sockets';
import { isIPv4, parseHostPort, resolveDNS } from '@utils';
import { safeError } from '@common';
import { getGlobals, getEffectiveProxyIPs } from '@settings';
import { touchWsRead, touchWsWrite } from './ws-guardian';
import { countWsDown, countWsUp } from './ws-metrics';

// ---------- رجیستری سلامت ProxyIP (سطح isolate — بدون KV و write) ----------
// انتخاب قبلی کاملاً تصادفی بود؛ یک ProxyIP مرده دوباره و دوباره امتحان می‌شد
// و هر بار کل زنجیره‌ی اتصال → خطا → retry را برای کاربر گرون می‌کرد. حالا:
// - موفقیت (رسیدن اولین داده‌ی واقعی) → IP سالم، جریمه صفر
// - شکست (اتصال بدون داده بسته شد) → cooldown نمایی ۳۰s → ۱۰min
// - اگر همه جریمه شدند → همان لیست کامل (شانس دوباره — وضعیت شبکه عوض شده)

interface ProxyStat {
    fails: number;
    cooldownUntil: number;
}

const proxyHealth = new Map<string, ProxyStat>();
const PROXY_COOLDOWN_BASE_MS = 30_000;
const PROXY_COOLDOWN_MAX_MS = 10 * 60_000;
const PROXY_HEALTH_MAX_ENTRIES = 100;

// ---------- وچ‌داگ first-byte (v0.8.18) ----------
// بعضی مقصدها اتصال را «سیاه‌چاله» می‌کنند: TCP باز می‌مانَد، هیچ داده‌ای برنمی‌گردد
// و هیچ‌وقت هم close نمی‌شود (نمونه‌ی آشکار: اتصال مستقیم به IPهای خود Cloudflare
// وقتی واسط ProxyIP باید استفاده شود). retry قبلی فقط به رویداد close تکیه داشت
// → هیچ‌وقت فعال نمی‌شد → کاربر «وصل ولی بدون ترافیک» می‌ماند. حالا اگر در این
// بازه هیچ بایتی از مقصد نیامد، سوکت گرِیس‌فول بسته می‌شود تا مسیر retry
// (واسط ProxyIP / تلاش دوم) بلافاصله فعال شود.
const FIRST_BYTE_TIMEOUT_MS = 6_000;

function rememberProxy(key: string, stat: ProxyStat | undefined): void {
    if (proxyHealth.size >= PROXY_HEALTH_MAX_ENTRIES && !proxyHealth.has(key)) {
        const oldest = proxyHealth.keys().next().value;
        if (oldest !== undefined) proxyHealth.delete(oldest);
    }
    if (stat) {
        proxyHealth.delete(key);
        proxyHealth.set(key, stat);
    }
}

/**
 * انتخاب ProxyIP با اولویت سالم‌ها — اگر همه در cooldown بودند، از لیست کامل
 * انتخاب می‌شود (شبکه ممکن است برگردد) و cooldown آن‌ها منقضی‌شده در نظر گرفته می‌شود.
 *
 * انتخاب وزنی (نه یکنواخت): Auto-Tune لیست را «سریع‌ترین → کندتر» مرتب می‌کند؛
 * کاندیدای اول بیشترین وزن را دارد (n) و وزن هر ورودی بعدی یکی کم می‌شود.
 * نتیجه: بیشترِ ترافیک از سریع‌ترین واسط می‌گذرد ولی بقیه هم سهم می‌برند
 * (پخش بار + ضد-abuse). لیست ادمین (مرتب‌نشده) هم ضرری نمی‌کند — فقط ترجیح ترتیب.
 */
export function pickProxyIP(proxyIPs: string[]): string {
    if (proxyIPs.length === 0) return '';
    const now = Date.now();
    const healthy = proxyIPs.filter((ip) => (proxyHealth.get(ip)?.cooldownUntil ?? 0) <= now);
    const pool = healthy.length ? healthy : proxyIPs;
    if (pool.length === 1) return pool[0];

    // چرخ رولت وزنی: وزن‌های n, n-1, …, 1 — جمع = n(n+1)/2
    let r = Math.random() * ((pool.length * (pool.length + 1)) / 2);
    for (let i = 0; i < pool.length; i++) {
        r -= pool.length - i;
        if (r < 0) return pool[i];
    }
    return pool[0];
}

/** اتصال موفق با جریان داده — جریمه پاک می‌شود */
export function markProxyOk(proxyIP: string): void {
    rememberProxy(proxyIP, { fails: 0, cooldownUntil: 0 });
}

/** اتصال بی‌داده — cooldown نمایی؛ هر شکست پشت‌سرهم دامنه را دوبرابر می‌کند */
export function markProxyFail(proxyIP: string): void {
    const prev = proxyHealth.get(proxyIP);
    const fails = Math.min((prev?.fails ?? 0) + 1, 16);
    const cooldown = Math.min(PROXY_COOLDOWN_BASE_MS * 2 ** (fails - 1), PROXY_COOLDOWN_MAX_MS);
    rememberProxy(proxyIP, { fails, cooldownUntil: Date.now() + cooldown });
}

// ---------- مسیر اجباری ProxyIP برای دامنه‌های حساس ----------
// اتصال مستقیم به برخی سرویس‌ها (گوگل — به‌ویژه Gemini/AI — و OpenAI) از egress
// کلادفلر «فنیاً» موفق می‌شود ولی IP خروجی بسته به PoP ممکن است در رنجِ بلاکِ
// آن سرویس باشد → صفحه‌ی 403 «Your client does not have permission». برای این
// دامنه‌ها اتصال از همان ابتدا از ProxyIP می‌رود تا IP خروجی ثابت و تمیز باشد؛
// اگر واسط پاسخ نداد، fallback به اتصال مستقیم (و بعد retry معمول).
// EMBEDED_SETTINGS.forceProxyDomains لیست ادمین است ([] = خاموش)؛ نبودِ کلید = همین پیش‌فرض
export const DEFAULT_FORCE_PROXY_DOMAINS: string[] = [
    'google.com',
    'googleapis.com',
    'gstatic.com',
    'googleusercontent.com',
    'google.ai',
    'ai.google.dev',
    'deepmind.com',
    'openai.com',
    'chatgpt.com',
    'oaistatic.com',
    'oaiusercontent.com'
];

/**
 * تشخیص لیست force: لیست ادمین فقط وقتی معتبر است که آرایه‌ی واقعی باشد —
 * [] یعنی صریحاً خاموش؛ نبودِ کلید (undefined) یعنی پیش‌فرض داخلی.
 * (رفع باگ v0.7.3: قبل‌اً [] هم مثل نبودِ کلید به پیش‌فرض برمی‌گشت و خاموش‌کردن ممکن نبود)
 */
export function resolveForceList(adminList?: string[]): string[] {
    return Array.isArray(adminList) ? adminList : DEFAULT_FORCE_PROXY_DOMAINS;
}

/** تطبیق دامنه‌ای پسوندی — IP literal ها هرگز force نمی‌شوند */
export function shouldForceProxy(address: string, domains: string[]): boolean {
    if (!domains?.length) return false;
    const host = address.toLowerCase();
    if (isIPv4(host) || host.includes(':')) return false;
    return domains.some((raw) => {
        const domain = raw.trim().toLowerCase().replace(/^\.+|\.+$/g, '');
        return domain !== '' && (host === domain || host.endsWith(`.${domain}`));
    });
}

export const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;

export type Logger = (info: string, event?: unknown) => void;
export type Chunk = ArrayBuffer | Uint8Array;

/**
 * Wrapper سوکت ریموت با کش writer.
 * caller های قدیمی فقط { value } می‌فرستن و رفتار قبلی براشون حفظ می‌شه —
 * caller های جدید { value, writer } می‌فرستن تا از کش writer استفاده کنن.
 */
export interface RemoteSocketWrapper {
    value: Socket | null;
    writer?: WritableStreamDefaultWriter<Chunk> | null;
    /**
     * v0.8.28 — chunkهای رسیده در پنجره‌ی «نویسنده هنوز آماده نیست».
     * در صدر handleTCPOutBound مسلح می‌شود و connectAndWrite به محض ست‌شدن
     * نویسنده، به ترتیب ورود و در یک بلوک sync تخلیه‌اش می‌کند. بدون این،
     * chunkهای پنجره یا گم می‌شدند یا (بدتر) به‌جای هدر پروتکل پارس می‌شدند.
     */
    buffered?: Chunk[];
    /**
     * v0.8.49 — جمع بایت‌های درون buffered. در مرز push (هندلرها)، drain و
     * بازگردانی شکست نوشته (connectAndWrite) نگه داشته می‌شود تا سقف
     * REMOTE_SOCKET_MAX_BUFFERED_BYTES قابل اعمال باشد — پل WS در Workers
     * هیچ backpressure به کلاینت نمی‌دهد؛ بدون سقف، آپلود به مقصد سیاه‌چاله
     * در پنجره‌ی failover می‌تواند ایزوله را OOM کند (مرگ همه‌ی اتصال‌ها).
     */
    bufferedBytes?: number;
}

/**
 * v0.8.49 — سقف بایتی بافر پنجره‌ی failover بر هر اتصال.
 * عبور = بستن تمیز همان اتصال (کلاینت reconnect می‌کند) نه به خطر انداختن
 * کل ایزوله. ۴MB برای پرواز اولیه‌ی TLS/HTTP بسیار سخاوتمندانه است و در
 * عین حال بدترین‌حالت هر اتصال را ≤ ۳٪ سقف حافظه‌ی ایزوله نگه می‌دارد.
 */
export const REMOTE_SOCKET_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

export async function handleTCPOutBound(
    remoteSocket: RemoteSocketWrapper,
    addressRemote: string,
    portRemote: number,
    rawClientData: Chunk | undefined,
    webSocket: WebSocket,
    VLResponseHeader: Uint8Array | null,
    log: Logger
) {
    // v0.8.28 — مسلح‌سازی بافر پنجره؛ از همین لحظه (sync، قبل از هر await)
    // هر chunk رسیده تا آماده‌شدن نویسنده به‌جای پارس/گم‌شدن بافر می‌شود
    remoteSocket.buffered ??= [];

    async function connectAndWrite(address: string, port: number): Promise<Socket> {
        const tcpSocket = connect({
            hostname: address,
            port: port,
        });

        // اگه caller از کش writer پشتیبانی کنه، قفل فقط یک‌بار گرفته می‌شه و تا پایان
        // عمر سوکت نگه داشته می‌شه — هم race قفل حذف می‌شه هم سربار per-chunk
        const keepWriter = 'writer' in remoteSocket;
        const writer = tcpSocket.writable.getWriter();

        // قبل از اولین await مقداردهی می‌شن تا chunk های بعدی بدون race
        // از همین writer استفاده کنن (ترتیب FIFO خود writer تضمین می‌شه)
        remoteSocket.value = tcpSocket;
        if (keepWriter) {
            remoteSocket.writer = writer;
        }

        // v0.8.28 — صدور همگام نوشته‌ها به ترتیب ورود: اول داده‌ی ابتدایی
        // (دُم هدر)، بعد هر chunk که در پنجره‌ی «نویسنده آماده نیست» بافر شده
        // (مسیر forced-proxy در حالت prefix قبل از اینجا روی DNS می‌ایستد؛
        // پنجره‌ی مشابه هم در retry و تلاش دومِ واسط هست). همه در «یک» بلوک
        // sync صادر می‌شوند تا writeهای تازه‌ی pipeTo نتوانند بین‌شان سبقت
        // بکشند — FIFO خود writer ترتیب نهایی را تضمین می‌کند.
        const writes: Promise<void>[] = [];
        if (rawClientData) {
            writes.push(writer.write(rawClientData));
        }
        const buffered = remoteSocket.buffered;
        // v0.8.38 — فهرست chunkهای تخلیه‌شده؛ اگر نوشته شکست بخورد باید به بافر برگردند
        const drained: Chunk[] = [];
        if (buffered?.length) {
            for (const chunk of buffered) {
                writes.push(writer.write(chunk));
                drained.push(chunk);
            }
            buffered.length = 0;
            remoteSocket.bufferedBytes = 0; // v0.8.49 — سقف بایتی با تخلیه صفر می‌شود
        }

        log(`connected to ${address}:${port}`);

        if (writes.length) {
            try {
                await Promise.all(writes);
            } catch (error) {
                // v0.8.38 — نوشته‌ی شکست‌خورده یعنی chunkهای تخلیه‌شده به مقصد نرسیدند؛
                // به بافر برمی‌گردند تا تلاش بعدی (fallback/retry) همان قرارداد v0.8.28
                // بازپخش‌شان کند. بدون این، failover با جریان بالینک ناقص بالا می‌آمد
                // (rawClientData بدون ادامه‌ی استریم = دقیقاً «وصل ولی بدون ترافیک»).
                // rawClientData نیازی به بازیابی ندارد — هر تلاش آن را از پارامترِ
                // بسته‌ی handleTCPOutBound دوباره می‌فرستد.
                if (drained.length) {
                    (remoteSocket.buffered ??= []).unshift(...drained);
                    // v0.8.49 — بازگردانی دسته‌ی تخلیه‌شده به حساب بایتی برمی‌گردد
                    remoteSocket.bufferedBytes =
                        (remoteSocket.bufferedBytes ?? 0) + drained.reduce((sum, c) => sum + c.byteLength, 0);
                }
                throw error;
            }
        }

        if (!keepWriter) {
            writer.releaseLock();
        }

        return tcpSocket;
    }

    // انتخاب مقصد واسط بر اساس حالت تنظیمات — بدون mutation متغیرهای اصلی تا
    // fallback مستقیم همیشه آدرس واقعی مقصد را داشته باشد
    // exclude: کاندیداهایی که در این زنجیره امتحان شده‌اند (failover دوم)
    async function resolveProxyTarget(
        targetHost: string,
        targetPort: number,
        exclude?: ReadonlySet<string>
    ): Promise<{ host: string; port: number; proxyIP: string } | null> {
        const { proxyIpMode, prefixes } = getGlobals();
        // Auto-Tune اگر موجود باشد، وگرنه لیست ادمین — منهای کاندیداهای مردود این زنجیره
        const fullList = getEffectiveProxyIPs();
        const proxyIPs = exclude?.size ? fullList.filter(ip => !exclude.has(ip)) : fullList;
        const getRandomValue = (arr: string[]) => arr[Math.floor(Math.random() * arr.length)];

        if (proxyIpMode === 'proxyip') {
            const proxyIP = pickProxyIP(proxyIPs);
            const { host, port } = parseHostPort(proxyIP, true);
            // ProxyIP خالی (لیست خالی) → همان مقصد مستقیم (رفتار قبلی: یک retry مستقیم)
            return { host: host || targetHost, port: port || targetPort, proxyIP };
        }

        if (proxyIpMode === 'prefix') {
            const prefix = getRandomValue(prefixes);
            // خطای prefix با exception بالا می‌آید — caller تصمیم می‌گیرد (close یا fallback)
            const dynamicProxyIP = await getDynamicProxyIP(targetHost, prefix);
            if (!dynamicProxyIP) return null;
            return { host: dynamicProxyIP, port: targetPort, proxyIP: '' };
        }

        return null;
    }

    // یک تلاش از مسیر واسط با ثبت سلامت ProxyIP؛ next = مسیر جایگزین اگر
    // اتصال/جریان بدون داده تمام شد (null = آخرین تلاش است)
    async function attemptViaProxy(
        target: { host: string; port: number; proxyIP: string },
        next: (() => void) | null
    ): Promise<void> {
        try {
            log(`connecting via ${target.host}:${target.port}`);
            const tcpSocket = await connectAndWrite(target.host, target.port);
            // نکته‌ی v0.8.19: بستن WS به remoteSocketToWS منتقل شد (تصمیم واحد
            // بعد از پایان جریان). قبلاً اینجا به رویداد closed سوکتِ «اولین»
            // تلاش گره خورده بود → اولین واسطِ مرده، WS را قبل از رسیدن نوبتِ
            // failover می‌بست و تلاش دوم هرگز به کلاینت نمی‌رسید.

            // سلامت ProxyIP — کلاینت-آگاه (v0.8.29):
            //   داده‌ی واقعی برگشت → واسط سالم است (اثبات‌شده، فارغ از سرنوشت کلاینت)
            //   بدون داده + کلاینت هنوز زنده → واسط واقعاً پاسخ نداد → cooldown
            //   بدون داده + کلاینت رفته → بی‌نتیجه — هیچ ثبتی نه. قبلاً flap موبایل /
            //   بستنِ تب، واسطِ سالم را جریمه می‌کرد (cooldown نمایی تا ۱۰ دقیقه) و
            //   یک کلاینتِ پریشان، بهترین کاندیداها را یکی‌یکی از چرخه می‌انداخت.
            remoteSocketToWS(tcpSocket, webSocket, VLResponseHeader, next, log, (hasData, clientAlive) => {
                if (!target.proxyIP) return;
                if (hasData) markProxyOk(target.proxyIP);
                else if (clientAlive) markProxyFail(target.proxyIP);
            });
        } catch (error) {
            if (target.proxyIP) markProxyFail(target.proxyIP);
            console.error('connection via proxy failed:', error);
            if (next) next();
            else safeCloseWebSocketWithReason(webSocket, 1011, `Retry connection failed: ${safeError(error)}`);
        }
    }

    async function retry() {
        // v0.8.28 — نویسنده‌ی سوکت مردود باطل می‌شود تا chunkهای رسیده در
        // پنجره‌ی انتظار این تلاش (مثلاً DNS حالت prefix) به‌جای ورود به سوکت
        // مرده، بافر و به تلاش بعدی بازپخش شوند — همان قرارداد rawClientData
        if ('writer' in remoteSocket) remoteSocket.writer = null;
        // کل منطق retry داخل try — دیگه unhandled rejection نداریم
        try {
            const target = await resolveProxyTarget(addressRemote, portRemote);
            if (!target) {
                safeCloseWebSocketWithReason(webSocket, 1011, 'Retry connection failed: Invalid Prefix');
                return; // باگ قبلی: ادامه می‌داد و به همون آدرس شکست‌خورده reconnect می‌کرد
            }

            // failover دوم: اگر واسط اول بدون هیچ داده‌ای مُرد، یک کاندیدای «متفاوت»
            // امتحان می‌شود — کاربر دیگر به‌خاطر یک واسط بد کل اتصال را از دست نمی‌دهد.
            // (کاندیدای مرده همان لحظه cooldown می‌خورد؛ تلاش دوم به‌طور طبیعی ازش می‌پرد.
            //  فقط وقتی استخر ≥۲ کاندیداست معنا دارد و به‌اندازه‌ی یک connect گرون است.)
            const attemptSecondProxy = getEffectiveProxyIPs().length >= 2
                ? () => {
                    void (async () => {
                        try {
                            const exclude = new Set<string>(target.proxyIP ? [target.proxyIP] : []);
                            // v0.8.28 — همان پنجره برای تلاش دوم (بافر به‌جای سوکت مرده)
                            if ('writer' in remoteSocket) remoteSocket.writer = null;
                            const alt = await resolveProxyTarget(addressRemote, portRemote, exclude);
                            if (!alt || (alt.host === target.host && alt.port === target.port)) {
                                // کاندیدای متمایز نبود (استخر تک‌نفره در عمل) — پایان تمیز
                                safeCloseWebSocketWithReason(webSocket, 1011, 'Retry connection failed');
                                return;
                            }
                            await attemptViaProxy(alt, null);
                        } catch (error) {
                            console.error('Retry connection failed:', error);
                            safeCloseWebSocketWithReason(webSocket, 1011, `Retry connection failed: ${safeError(error)}`);
                        }
                    })();
                }
                : null;

            await attemptViaProxy(target, attemptSecondProxy);
        } catch (error) {
            console.error('Retry connection failed:', error);
            safeCloseWebSocketWithReason(webSocket, 1011, `Retry connection failed: ${safeError(error)}`);
        }
    }

    const attemptDirect = async () => {
        try {
            const tcpSocket = await connectAndWrite(addressRemote, portRemote);
            remoteSocketToWS(tcpSocket, webSocket, VLResponseHeader, retry, log);
        } catch (error) {
            console.error(`Connection failed: ${error}`);
            safeCloseWebSocketWithReason(webSocket, 1011, `Connection failed: ${safeError(error)}`);
        }
    };

    // دامنه‌های حساس مستقیم به مسیر واسط می‌روند (نه بعد از شکست) — جزئیات بالای فایل
    // [] = صریحاً خاموش (حالت معمول)؛ نبودِ کلید = پیش‌فرض داخلی
    const { forceProxyDomains } = getGlobals();
    const forceList = resolveForceList(forceProxyDomains);

    if (shouldForceProxy(addressRemote, forceList)) {
        log(`forced proxy route for ${addressRemote}`);
        try {
            const target = await resolveProxyTarget(addressRemote, portRemote);
            if (target) await attemptViaProxy(target, attemptDirect);
            else await attemptDirect();
        } catch (error) {
            console.error(`forced proxy route failed, falling back to direct for ${addressRemote}:`, error);
            await attemptDirect();
        }
    } else {
        await attemptDirect();
    }
}

export async function remoteSocketToWS(
    remoteSocket: Socket,
    webSocket: WebSocket,
    VLResponseHeader: Uint8Array | null,
    retry: (() => void) | null,
    log: Logger,
    onResult?: (hasData: boolean, clientAlive: boolean) => void
) {
    let vlHeader = VLResponseHeader;
    let hasIncomingData = false;

    // وچ‌داگ first-byte — فقط داون‌لینک مهم است؛ اولین داده → خاموشی
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    const disarmWatchdog = () => {
        if (watchdog) {
            clearTimeout(watchdog);
            watchdog = null;
        }
    };
    watchdog = setTimeout(() => {
        watchdog = null;
        if (!hasIncomingData) {
            log(`first-byte timeout (${FIRST_BYTE_TIMEOUT_MS}ms) — closing dead upstream to trigger retry`);
            safeCloseTcpSocket(remoteSocket);
        }
    }, FIRST_BYTE_TIMEOUT_MS);

    const writableStream = new WritableStream({
        async write(chunk: Chunk, controller) {
            if (!hasIncomingData) disarmWatchdog();
            hasIncomingData = true;
            touchWsWrite(webSocket); // نگهبان: فعالیت سمت سرور
            countWsDown(webSocket, chunk instanceof Uint8Array ? chunk.byteLength : (chunk as ArrayBuffer).byteLength ?? 0);
            if (webSocket.readyState !== WS_READY_STATE_OPEN) {
                controller.error('webSocket.readyState is not open, maybe close');
                return; // باگ قبلی: بعد از error هم به send ادامه می‌داد
            }

            if (vlHeader) {
                // الحاق همگام با تخصیص واحد — به‌جای Blob + arrayBuffer async
                const view = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
                const merged = new Uint8Array(vlHeader.length + view.length);
                merged.set(vlHeader, 0);
                merged.set(view, vlHeader.length);
                vlHeader = null;
                webSocket.send(merged);
            } else {
                webSocket.send(chunk);
            }
        },
        close() {
            log(`remoteConnection.readable is close with hasIncomingData is ${hasIncomingData}`);
        },
        abort(reason) {
            console.error(`remoteConnection.readable abort`, reason);
            safeCloseTcpSocket(remoteSocket);
        },
    });

    try {
        await remoteSocket.readable.pipeTo(writableStream);
    } catch (error) {
        console.error('VLRemoteSocketToWS has exception.', error);
        safeCloseTcpSocket(remoteSocket);
    }
    disarmWatchdog();

    // گزارش نتیجه برای رجیستری سلامت ProxyIP (فقط مسیر واسط استفاده می‌کند).
    // v0.8.29 — آرگومان دوم: آیا کلاینت در لحظه‌ی settle زنده بوده؟
    const clientAlive = webSocket.readyState === WS_READY_STATE_OPEN;
    onResult?.(hasIncomingData, clientAlive);

    // مالکیت بستن WS — تصمیم واحد، بعد از settle شدن جریان (v0.8.19):
    //  • داده رد و بدل شد → تونل تمام است (EOF تمیز یا قطع) → بستن
    //  • بدون داده + راه retry باز → WS زنده می‌ماند تا تلاش بعدی (failover)
    //  • بدون داده + هیچ راهی نمانده → بستن تا کلاینت بی‌نهایت معطل نماند
    // مسیر مستقیم هم حالا روی EOF تمیزِ مقصد WS را می‌بندد (قبلاً تا کلاینت
    // خودش نبندد باز می‌ماند).
    if (hasIncomingData || !retry) {
        safeCloseWebSocket(webSocket);
    }

    // v0.8.29 — retry فقط برای نشست زنده: کلاینتِ رفته (flap موبایل/تب بسته)
    // مخاطبی برای تلاش بعدی ندارد؛ زنجیره فقط connect بیهوده می‌زد، منابع هدر
    // می‌رفت و واسط‌های بعدیِ همین نشستِ مرده هم به‌اشتباه cooldown می‌خوردند.
    if (hasIncomingData === false && retry && clientAlive) {
        log(`retry`);
        retry();
    }
}

export function makeReadableWebSocketStream(
    webSocketServer: WebSocket,
    earlyDataHeader: string,
    log: Logger
) {
    let readableStreamCancel = false;
    let streamEnded = false; // گارد: جلوگیری از close/error دوباره روی controller

    const stream = new ReadableStream({
        start(controller) {
            webSocketServer.addEventListener('message', (event) => {
                // v0.8.59 — گارد streamEnded هم لازم است: بعد از controller.error،
                // enqueue روی استریمِ errored طبق spec پرتاب می‌کند و این پرتاب داخل
                // لیسنر WS بی‌گیرنده می‌ماند (TypeError ثبت‌نشده به‌ازای هر پیامِ دیررس)
                if (readableStreamCancel || streamEnded) return;
                touchWsRead(webSocketServer); // نگهبان: فعالیت سمت کلاینت
                // متریک ترافیک: بایت آپ‌لینک (استرینگ = فریم متنی، طول کاراکتر ~ بایت)
                const d = event.data as unknown;
                countWsUp(webSocketServer, typeof d === 'string' ? d.length : (d as ArrayBuffer).byteLength ?? 0);
                controller.enqueue(event.data);
            });

            webSocketServer.addEventListener('close', () => {
                safeCloseWebSocket(webSocketServer);
                if (readableStreamCancel || streamEnded) return;
                streamEnded = true;
                controller.close();
            });

            webSocketServer.addEventListener('error', (err) => {
                log('webSocketServer has error');
                safeCloseWebSocket(webSocketServer);
                if (readableStreamCancel || streamEnded) return;
                streamEnded = true;
                controller.error(err);
            });

            const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);

            if (error) {
                streamEnded = true;
                controller.error(error);
                safeCloseWebSocket(webSocketServer); // باگ قبلی: WS باز می‌موند
            } else if (earlyData) {
                countWsUp(webSocketServer, earlyData.byteLength); // early-data هم آپ‌لینک است
                controller.enqueue(earlyData);
            }
        },
        cancel(reason) {
            if (readableStreamCancel) return;
            log(`ReadableStream was canceled, due to ${reason}`);
            readableStreamCancel = true;
            safeCloseWebSocket(webSocketServer);
        },
    });

    return stream;
}

function base64ToArrayBuffer(base64Str: string) {
    if (!base64Str) {
        return { earlyData: null, error: null };
    }

    try {
        // Base64 برای URL (rfc4648) — تک‌پاس به‌جای دو regex
        const normalized = base64Str.replace(/[-_]/g, (c) => (c === '-' ? '+' : '/'));
        const decode = atob(normalized);
        const buffer = new Uint8Array(decode.length);
        for (let i = 0; i < decode.length; i++) {
            buffer[i] = decode.charCodeAt(i);
        }
        return { earlyData: buffer.buffer, error: null };
    } catch (error) {
        return { earlyData: null, error };
    }
}

export function safeCloseTcpSocket(socket: Socket | null) {
    if (socket) {
        try {
            socket.close();
        } catch (error) {
            console.error('Failed to close TCP socket:', error);
        }
    }
}

export function safeCloseWebSocket(socket: WebSocket) {
    try {
        if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING) {
            socket.close();
        }
    } catch (error) {
        console.error('safeCloseWebSocket error', error);
    }
}

/**
 * v0.8.60 — سقف بایتی reason بستن WS (RFC 6458: حداکثر ۱۲۳ بایت UTF-8).
 * workerd پرتاب نمی‌کند — close() با reason بلندتر «موفق» به نظر می‌رسد ولی فریم
 * close روی سیم نامعتبر می‌شود: کلاینت به‌جای کد/دلیل ما، 1002 «Protocol error -
 * invalid control frame» با clean=false می‌گیرد. نتیجه در مسیرهای خطا:
 * دلیل تشخیصی گم می‌شود و بسته‌شدن تمیز 1011 به خطای پروتکل تبدیل می‌شود.
 * (اثبات wire-level با wrangler dev محلی: reason≤123 → 1011 می‌رسد؛ ≥124 → 1002.)
 */
export const WS_CLOSE_REASON_MAX_BYTES = 123;

/** برش امن UTF-8 — هرگز دنباله‌ی چندبایتی را نصف نمی‌کند */
export function clampWsCloseReason(reason: string, maxBytes: number = WS_CLOSE_REASON_MAX_BYTES): string {
    if (maxBytes <= 0) return '';

    // مسیر سریع: ASCII خالص (همه‌ی پیام‌های خودمان) — طول کاراکتر = طول بایت
    let isAscii = true;
    for (let i = 0; i < reason.length; i++) {
        if (reason.charCodeAt(i) > 0x7f) {
            isAscii = false;
            break;
        }
    }
    if (isAscii) {
        return reason.length <= maxBytes ? reason : reason.slice(0, maxBytes);
    }

    // چندبایتی: کدگذاری کامل، برش روی مرز دنباله‌ی UTF-8، برگرداندن رشته‌ی معتبر
    const encoded = new TextEncoder().encode(reason);
    if (encoded.length <= maxBytes) return reason;

    let end = maxBytes;
    while (end > 0 && (encoded[end] & 0xc0) === 0x80) end--; // ادامه‌ی ناتمام = برش پیش از بایت آغازین
    return new TextDecoder().decode(encoded.slice(0, end));
}

/** بستن WS با کد و reason — reason بلند به‌صورت بایت-ایمن کلمپ می‌شود (v0.8.60) */
export function safeCloseWebSocketWithReason(socket: WebSocket, code: number, reason: string): void {
    try {
        if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING) {
            socket.close(code, clampWsCloseReason(reason));
        }
    } catch (error) {
        console.error('safeCloseWebSocketWithReason error', error);
    }
}

async function getDynamicProxyIP(address: string, prefix: string) {
    let finalAddress = address;

    if (!isIPv4(address)) {
        const { ipv4 } = await resolveDNS(address, true);

        if (ipv4.length) {
            finalAddress = ipv4[0];
        } else {
            throw new Error('Unable to find IPv4 in DNS records');
        }
    }

    return convertToNAT64IPv6(finalAddress, prefix);
}

function convertToNAT64IPv6(ipv4Address: string, prefix: string) {
    const parts = ipv4Address.split('.');

    if (parts.length !== 4) {
        throw new Error('Invalid IPv4 address');
    }

    const hex = parts.map(part => {
        const num = parseInt(part, 10);

        if (num < 0 || num > 255) {
            throw new Error('Invalid IPv4 address');
        }

        return num.toString(16).padStart(2, '0');
    });

    const match = prefix.match(/^\[([0-9A-Fa-f:]+)\]$/);

    if (match) {
        return `[${match[1]}${hex[0]}${hex[1]}:${hex[2]}${hex[3]}]`;
    }

    // v0.8.59 — prefix نامعتبر دیگر صامت undefined نیست؛ صریح پرتاب می‌شود تا
    // قراردادِ مستند (خطای prefix با exception بالا می‌آید — تصمیم با caller،
    // کامنت resolveProxyTarget) واقعاً برقرار باشد و دلیل واقعی در پیام خطا/بستن
    // دیده شود، نه 'Invalid Prefix' عمومی. هر دو caller مسیر throw را از قبل
    // try/catch دارند (retry → close؛ مسیر forced → fallback مستقیم).
    throw new Error('Invalid NAT64 prefix format');
}