import { decompressGzipBase64, respond, HttpStatus, safeError } from '@common';
import { authenticate } from '@auth';
import { resolveDNS } from '@cores/utils';
import { getGlobals } from '@settings';
import { updateMainSettings } from '@main';
import { PanelSettings } from '#types/settings';
import { fallback } from './utils';
import { runProxyIPBatchTest, checkProxyIP } from '@api/proxy-check';

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

const SINGLE_TEST_ATTEMPTS = 5;

async function testProxyIP() {
    const { searchParams } = getGlobals();

    const target = searchParams.get('target') as string;
    const attemptPromises = Array.from({ length: SINGLE_TEST_ATTEMPTS }, (_, i) =>
        checkProxyIP(target).then(res => ({ attempt: i + 1, ...res }))
    );

    const attempts = await Promise.all(attemptPromises);
    const successes = attempts.filter((a) => a.ok);
    const avgLatencyMs = successes.length
        ? Math.round(successes.reduce((sum, a) => sum + a.elapsedMs, 0) / successes.length)
        : null;

    return respond(true, HttpStatus.OK, '', {
        successRate: `${successes.length}/${SINGLE_TEST_ATTEMPTS}`,
        avgLatencyMs,
        attempts,
    });
}

// ---------- تست دسته‌ای + انتخاب خودکار بهترین ProxyIP ----------

/**
 * تست همه‌ی ProxyIP های تنظیم‌شده در یک endpoint — به‌جای کلیک تکی روی هر ردیف.
 * منطق تست در @api/proxy-check مشترک است (همان موتور Auto-Tune اتوماسیون).
 * خروجی مرتب‌شده: سالم‌ها اول، بعد سریع‌ترین — «بهترین» = اولین ردیف سالم.
 */

async function testAllProxyIPsEndpoint(): Promise<Response> {
    try {
        const { proxyIPs } = getGlobals();
        const results = await runProxyIPBatchTest(proxyIPs ?? []);
        const best = results.find(r => r.ok)?.target ?? null;
        return respond(true, HttpStatus.OK, '', { results, best });
    } catch (error) {
        return respond(false, HttpStatus.INTERNAL_SERVER_ERROR, `Batch test failed: ${safeError(error)}`);
    }
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
        const results = await runProxyIPBatchTest(getGlobals().proxyIPs ?? []);
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


