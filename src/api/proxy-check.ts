// ---------- کتابخانه‌ی مشترک تست ProxyIP ----------
// یک‌جا برای endpoint پنل (test/test-all) و موتور Auto-Tune (اتوماسیون) —
// منطق یکی است: اتصال TCP به candidate:443 + درخواست HTTP با Host سالم؛
// پاسخ 400 + cf-ray یعنی واسط واقعاً ترافیک را رله می‌کند.
// connect به‌صورت تنبل import می‌شود تا بارگذاری ماژول به cloudflare:sockets
// وابسته نباشد (زنجیره‌ی automation بدون mock در محیط تست لود می‌شود).

export const PROXY_TEST_SNI = 'speed.cloudflare.com';
export const PROXY_TEST_TIMEOUT_MS = 5000;
export const BATCH_TEST_CONCURRENCY = 4;
export const BATCH_TEST_ATTEMPTS = 2;
export const BATCH_MAX_TARGETS = 20;

// connect یک‌بار resolve و به‌اشتراک گذاشته می‌شود — فراخوانی‌های همزمان
// import نباید با هم رقابت کنند (در محیط تست mock-registry ریسک throw دارد)
let connectPromise: Promise<any> | null = null;

function getConnect(): Promise<any> {
    connectPromise ??= import('cloudflare:sockets').then(m => m.connect);
    return connectPromise;
}

export interface ProxyAttemptResult {
    ok: boolean;
    elapsedMs: number;
}

export interface ProxyTargetTestResult {
    target: string;
    ok: boolean;
    successRate: string;
    avgLatencyMs: number | null;
}

/**
 * سلامت یک ProxyIP — TCP + HTTP relay semantics.
 * ok = واسط زنده است و پاسخ واقعی لبه‌ی کلادفلر برگرداند.
 */
export async function checkProxyIP(
    address: string,
    timeoutMs: number = PROXY_TEST_TIMEOUT_MS
): Promise<ProxyAttemptResult> {
    const start = Date.now();
    const TEST_PATH = '/__down?bytes=5000';

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    });

    try {
        const connect = await getConnect();
        const socket = connect({ hostname: address, port: 443 });
        const writer = socket.writable.getWriter();
        const req = `GET ${TEST_PATH} HTTP/1.1\r\nHost: ${PROXY_TEST_SNI}\r\nConnection: close\r\n\r\n`;

        await writer.write(new TextEncoder().encode(req));
        writer.releaseLock();
        const reader = socket.readable.getReader();

        const { value, done } = await Promise.race([reader.read(), timeout]);
        reader.releaseLock();
        await socket.close().catch(() => { });

        if (done || !value) {
            return { ok: false, elapsedMs: Date.now() - start };
        }

        const response = new TextDecoder().decode(value);
        const isOk = /^HTTP\/1\.[01] 400/.test(response);
        const hasCfRay = /cf-ray:/i.test(response);

        return { ok: isOk && hasCfRay, elapsedMs: Date.now() - start };
    } catch {
        return { ok: false, elapsedMs: Date.now() - start };
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

/**
 * تست دسته‌ای با هم‌زمانی محدود — خروجی مرتب: سالم‌ها اول، بعد سریع‌ترین.
 * هر هدف چند تلاش موازی می‌گیرد (نمونه‌ی تکی گمراه‌کننده است).
 */
export async function runProxyIPBatchTest(
    targets: string[],
    opts?: { concurrency?: number; attempts?: number; maxTargets?: number }
): Promise<ProxyTargetTestResult[]> {
    const concurrency = opts?.concurrency ?? BATCH_TEST_CONCURRENCY;
    const attempts = opts?.attempts ?? BATCH_TEST_ATTEMPTS;
    const list = [...new Set(targets.filter(Boolean))].slice(0, opts?.maxTargets ?? BATCH_MAX_TARGETS);

    const results: ProxyTargetTestResult[] = [];

    for (let i = 0; i < list.length; i += concurrency) {
        const batch = list.slice(i, i + concurrency);
        const batchResults = await Promise.all(batch.map(async (target) => {
            const tries = await Promise.all(
                Array.from({ length: attempts }, () => checkProxyIP(target))
            );
            const oks = tries.filter(a => a.ok);

            return {
                target,
                ok: oks.length > 0,
                successRate: `${oks.length}/${attempts}`,
                avgLatencyMs: oks.length
                    ? Math.round(oks.reduce((s, a) => s + a.elapsedMs, 0) / oks.length)
                    : null
            };
        }));

        results.push(...batchResults);
    }

    return results.sort((a, b) => {
        if (a.ok !== b.ok) return a.ok ? -1 : 1;
        const la = a.avgLatencyMs ?? Number.MAX_SAFE_INTEGER;
        const lb = b.avgLatencyMs ?? Number.MAX_SAFE_INTEGER;
        return la - lb;
    });
}
