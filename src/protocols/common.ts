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
}

export async function handleTCPOutBound(
    remoteSocket: RemoteSocketWrapper,
    addressRemote: string,
    portRemote: number,
    rawClientData: Chunk | undefined,
    webSocket: WebSocket,
    VLResponseHeader: Uint8Array | null,
    log: Logger
) {
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

        log(`connected to ${address}:${port}`);

        if (rawClientData) {
            await writer.write(rawClientData);
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
            tcpSocket.closed
                .catch(error => console.log('retry TCP socket closed error', error))
                .finally(() => safeCloseWebSocket(webSocket));

            // سلامت ProxyIP: اگر در این تلاش داده‌ی واقعی برگشت → سالم؛
            // اگر جریان بدون هیچ داده‌ای بسته شد → مرده و cooldown می‌خورد
            remoteSocketToWS(tcpSocket, webSocket, VLResponseHeader, next, log, (hasData) => {
                if (target.proxyIP) hasData ? markProxyOk(target.proxyIP) : markProxyFail(target.proxyIP);
            });
        } catch (error) {
            if (target.proxyIP) markProxyFail(target.proxyIP);
            console.error('connection via proxy failed:', error);
            if (next) next();
            else webSocket.close(1011, `Retry connection failed: ${safeError(error)}`);
        }
    }

    async function retry() {
        // کل منطق retry داخل try — دیگه unhandled rejection نداریم
        try {
            const target = await resolveProxyTarget(addressRemote, portRemote);
            if (!target) {
                webSocket.close(1011, 'Retry connection failed: Invalid Prefix');
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
                            const alt = await resolveProxyTarget(addressRemote, portRemote, exclude);
                            if (!alt || (alt.host === target.host && alt.port === target.port)) {
                                // کاندیدای متمایز نبود (استخر تک‌نفره در عمل) — پایان تمیز
                                webSocket.close(1011, 'Retry connection failed');
                                return;
                            }
                            await attemptViaProxy(alt, null);
                        } catch (error) {
                            console.error('Retry connection failed:', error);
                            webSocket.close(1011, `Retry connection failed: ${safeError(error)}`);
                        }
                    })();
                }
                : null;

            await attemptViaProxy(target, attemptSecondProxy);
        } catch (error) {
            console.error('Retry connection failed:', error);
            webSocket.close(1011, `Retry connection failed: ${safeError(error)}`);
        }
    }

    const attemptDirect = async () => {
        try {
            const tcpSocket = await connectAndWrite(addressRemote, portRemote);
            remoteSocketToWS(tcpSocket, webSocket, VLResponseHeader, retry, log);
        } catch (error) {
            console.error(`Connection failed: ${error}`);
            webSocket.close(1011, `Connection failed: ${safeError(error)}`);
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

async function remoteSocketToWS(
    remoteSocket: Socket,
    webSocket: WebSocket,
    VLResponseHeader: Uint8Array | null,
    retry: (() => void) | null,
    log: Logger,
    onResult?: (hasData: boolean) => void
) {
    let vlHeader = VLResponseHeader;
    let hasIncomingData = false;

    const writableStream = new WritableStream({
        async write(chunk: Chunk, controller) {
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
        safeCloseWebSocket(webSocket);
    }

    // گزارش نتیجه برای رجیستری سلامت ProxyIP (فقط مسیر retry استفاده می‌کند)
    onResult?.(hasIncomingData);

    if (hasIncomingData === false && retry) {
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
                if (readableStreamCancel) return;
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
}