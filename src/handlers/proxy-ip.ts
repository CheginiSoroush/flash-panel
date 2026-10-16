import { decompressGzipBase64, respond, HttpStatus, safeError } from '@common';
import { authenticate } from '@auth';
import { resolveDNS } from '@cores/utils';
import { getGlobals } from '@settings';
import { updateMainSettings } from '@main';
import { PanelSettings } from '#types/settings';
import { fallback } from './utils';
import { connect } from 'cloudflare:sockets';

export async function handleProxyIPs(request: Request, env: Env): Promise<Response> {
    const { pathname } = getGlobals();
    const auth = await authenticate(request, env);
    if (!auth) {
        const url = new URL('./login', request.url)
        return Response.redirect(url, 302);
    }

    const parts = pathname.split('/');
    const path = parts.slice(2).join('/');

    switch (path) {
        case 'proxy-ip':
            return renderProxyIPs();

        case 'proxy-ip/get':
            return getProxyIPsInfo();

        case 'proxy-ip/test':
            return testProxyIP();

        case 'proxy-ip/test-all':
            return testAllProxyIPsEndpoint();

        case 'proxy-ip/auto-apply':
            return autoApplyBestProxyIP(request, env);

        default:
            return fallback(request);
    }
}

async function renderProxyIPs() {
    const str = await decompressGzipBase64(PROXY_IP_HTML_CONTENT);
    const html = str.replaceAll('__ICON__', ICON_CONTENT);

    return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
}

async function getProxyIPsInfo(): Promise<Response> {
    const ips = await resolveDNS(_public_proxy_ip_, true);
    const geoLocInfo = await geoLookupBatch(ips.ipv4);
    return respond(
        true,
        HttpStatus.OK,
        undefined,
        geoLocInfo
    );
}

interface IpApiBatchResponse {
    query: string;
    city?: string;
    country?: string;
    countryCode?: string;
    isp?: string;
    status: 'success' | 'fail';
    message?: string;
}

interface GeoResult {
    ip: string;
    city?: string;
    country?: string;
    countryCode?: string;
    isp?: string;
}

function chunkArray<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
        chunks.push(arr.slice(i, i + size));
    }

    return chunks;
}

async function geoLookupBatch(ipList: string[]): Promise<GeoResult[]> {
    const batches = chunkArray(ipList, 100);
    const results: GeoResult[] = [];

    for (const batch of batches) {
        const res = await fetch(
            'http://ip-api.com/batch?fields=query,city,country,countryCode,isp,status',
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(batch),
            }
        );

        if (!res.ok) {
            throw new Error(`ip-api request failed: ${res.status}`);
        }

        const data: IpApiBatchResponse[] = await res.json();

        for (const item of data) {
            if (item.status === 'success') {
                results.push({
                    ip: item.query,
                    city: item.city,
                    country: item.country,
                    countryCode: item.countryCode,
                    isp: item.isp,
                });
            }
        }
    }

    return results;
}

const DEFAULT_SNI = 'speed.cloudflare.com';
const TIMEOUT_MS = 5000;
const ATTEMPTS = 5;

interface Attempt {
    attempt: number;
    ok: boolean;
    elapsedMs: number;
}

async function checkProxyIP(address: string): Promise<Omit<Attempt, 'attempt'>> {
    const start = Date.now();
    const TEST_PATH = '/__down?bytes=5000';

    const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS)
    );

    try {
        const socket = connect({ hostname: address, port: 443 });
        const writer = socket.writable.getWriter();
        const req = `GET ${TEST_PATH} HTTP/1.1\r\nHost: ${DEFAULT_SNI}\r\nConnection: close\r\n\r\n`;

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
        const isHealthy = isOk && hasCfRay;

        return {
            ok: isHealthy,
            elapsedMs: Date.now() - start
        };
    } catch (err) {
        return {
            ok: false,
            elapsedMs: Date.now() - start
        };
    }
}

async function testProxyIP() {
    const { searchParams } = getGlobals();

    const target = searchParams.get('target') as string;
    const attemptPromises = Array.from({ length: ATTEMPTS }, (_, i) =>
        checkProxyIP(target).then(res => ({ attempt: i + 1, ...res }))
    );

    const attempts = await Promise.all(attemptPromises);
    const successes = attempts.filter((a) => a.ok);
    const avgLatencyMs = successes.length
        ? Math.round(successes.reduce((sum, a) => sum + a.elapsedMs, 0) / successes.length)
        : null;

    return respond(true, HttpStatus.OK, '', {
        successRate: `${successes.length}/${ATTEMPTS}`,
        avgLatencyMs,
        attempts,
    });
}

// ---------- تست دسته‌ای + انتخاب خودکار بهترین ProxyIP ----------

/**
 * تست همه‌ی ProxyIP های تنظیم‌شده در یک endpoint — به‌جای کلیک تکی روی هر ردیف.
 *
 * هم‌زمانی محدود (۴ در هر موج) که سهمیه‌ی socket و CPU ورکر نسوزد؛
 * هر هدف ۲ تلاش موازی می‌گیرد (نمونه‌ی تکی گمراه‌کننده است).
 * خروجی مرتب‌شده: سالم‌ها اول، بعد سریع‌ترین — «بهترین» = اولین ردیف سالم.
 */

const TEST_ALL_CONCURRENCY = 4;
const TEST_ALL_ATTEMPTS = 2;
const MAX_TEST_TARGETS = 20;

interface TargetTestResult {
    target: string;
    ok: boolean;
    successRate: string;
    avgLatencyMs: number | null;
}

async function testAllProxyIPsEndpoint(): Promise<Response> {
    try {
        const results = await runProxyIPBatchTest();
        const best = results.find(r => r.ok)?.target ?? null;
        return respond(true, HttpStatus.OK, '', { results, best });
    } catch (error) {
        return respond(false, HttpStatus.INTERNAL_SERVER_ERROR, `Batch test failed: ${safeError(error)}`);
    }
}

async function runProxyIPBatchTest(): Promise<TargetTestResult[]> {
    const { proxyIPs } = getGlobals();
    const targets = [...new Set(proxyIPs.filter(Boolean))].slice(0, MAX_TEST_TARGETS);
    const results: TargetTestResult[] = [];

    for (let i = 0; i < targets.length; i += TEST_ALL_CONCURRENCY) {
        const batch = targets.slice(i, i + TEST_ALL_CONCURRENCY);
        const batchResults = await Promise.all(batch.map(async (target) => {
            const attempts = await Promise.all(
                Array.from({ length: TEST_ALL_ATTEMPTS }, () => checkProxyIP(target))
            );
            const oks = attempts.filter(a => a.ok);

            return {
                target,
                ok: oks.length > 0,
                successRate: `${oks.length}/${TEST_ALL_ATTEMPTS}`,
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

/**
 * انتخاب خودکار بهترین ProxyIP — تست دسته‌ای + اعمال با redeploy.
 *
 * «بهترین» = سریع‌ترین IP سالم. اگه با سرتیف رویه‌ی فعلی یکی باشد، هیچ redeploy
 * اتفاق نمی‌افتد (idempotent). غیر از آن، ترتیب proxyIPs بازنویسی و با همان
 * مسیر ذخیره‌ی عادی پنل (updateMainSettings) ورکر مجدداً دیپلوی می‌شود —
 * یعنی دقیقاً همان کاری که «Save» پنل انجام می‌دهد، بدون دخالت دست.
 */
async function autoApplyBestProxyIP(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') {
        return respond(false, HttpStatus.METHOD_NOT_ALLOWED, 'Method not allowed.');
    }

    const auth = await authenticate(request, env);
    if (!auth) {
        return respond(false, HttpStatus.UNAUTHORIZED, 'Unauthorized or expired session.');
    }

    try {
        const results = await runProxyIPBatchTest();
        const best = results.find(r => r.ok);

        if (!best) {
            return respond(false, HttpStatus.INTERNAL_SERVER_ERROR,
                'No healthy proxy IP found — nothing applied.', { results });
        }

        const { proxyIPs, proxyIpMode, prefixes, fallback, dohUrl, vlUUID, trPass, securePath } = getGlobals();
        const current = [...new Set(proxyIPs.filter(Boolean))];

        if (current[0] === best.target) {
            return respond(true, HttpStatus.OK, 'Already optimal — no redeploy needed.', {
                results,
                applied: false,
                best: best.target
            });
        }

        const reordered = [best.target, ...current.filter(t => t !== best.target)];

        await updateMainSettings({
            vlUUID,
            trPass,
            securePath,
            proxyIpMode,
            proxyIPs: reordered,
            prefixes,
            fallback,
            dohUrl
        } as PanelSettings);

        return respond(true, HttpStatus.OK, `Best proxy IP applied: ${best.target} — worker redeployed.`, {
            results,
            applied: true,
            best: best.target,
            order: reordered
        });
    } catch (error) {
        return respond(false, HttpStatus.INTERNAL_SERVER_ERROR,
            `Auto-apply failed: ${safeError(error)}`);
    }
}


