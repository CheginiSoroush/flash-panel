import { decompressGzipBase64, respond, HttpStatus, safeError } from '@common';
import { authenticate } from '@auth';
import { getGlobals, getSettings, setSettings } from '@settings';
import { updateDataset } from '@kv';
import { updateMainSettings } from '@main';
import { validateSettings } from '@validators';
import {
    CLEAN_IP_DISCOVERY_SOURCES,
    EndpointTestResult,
    extractCandidates,
    rankResults,
    reorderCleanIPs
} from '@api/clean-ip';
import { PanelSettings } from '#types/settings';
import { fallback } from './utils';
import { connect } from 'cloudflare:sockets';

export async function handleCleanIPs(request: Request, env: Env): Promise<Response> {
    const { pathname } = getGlobals();
    const auth = await authenticate(request, env);
    if (!auth) {
        const url = new URL('./login', request.url)
        return Response.redirect(url, 302);
    }

    // snapshot ماژول kvSettings باید از KV تازه شود — در غیر این صورت
    // getSettings() پیش‌فرض‌ها را می‌دهد و add/auto-apply تنظیمات ذخیره‌شده را بازنویسی می‌کنند
    await setSettings(env);

    const parts = pathname.split('/');
    const path = parts.slice(2).join('/');

    switch (path) {
        case 'clean-ip':
            return renderCleanIPs();

        case 'clean-ip/get':
            return getCleanIPsInfo();

        case 'clean-ip/test':
            return testSingleEndpoint();

        case 'clean-ip/test-all':
            return testAllCleanIPsEndpoint();

        case 'clean-ip/discover':
            return discoverCleanIPsEndpoint();

        case 'clean-ip/add':
            return addCleanIPs(request, env);

        case 'clean-ip/auto-apply':
            return autoApplyCleanIPs(request, env);

        default:
            return fallback(request);
    }
}

async function renderCleanIPs() {
    const str = await decompressGzipBase64(CLEAN_IP_HTML_CONTENT);
    const html = str.replaceAll('__ICON__', ICON_CONTENT);

    return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
}

async function getCleanIPsInfo(): Promise<Response> {
    const { cleanIPs, customCdnAddrs } = getSettings();
    return respond(true, HttpStatus.OK, undefined, {
        cleanIPs: [...new Set(cleanIPs.filter(Boolean))],
        customCdnAddrs: [...new Set(customCdnAddrs.filter(Boolean))]
    });
}

// ---------- تست کیفیت لبه‌ی Cloudflare ----------

const PROBE_SNI = 'speed.cloudflare.com';
const PROBE_TIMEOUT_MS = 5000;

interface ProbeAttempt {
    ok: boolean;
    elapsedMs: number;
}

/**
 * پروب سلامت لبه: TCP:443 + درخواست HTTP ساده به مسیر سنجه — یک لبه‌ی سالم
 * Cloudflare پاسخ 400 با هدر cf-ray می‌دهد (همان تکنیک تست ProxyIP موجود).
 * اگر IP/دامنه برای اتصال کلاینت قابل‌استفاده باشد این چک پاس می‌شود.
 */
async function checkEndpoint(address: string): Promise<ProbeAttempt> {
    const start = Date.now();

    const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), PROBE_TIMEOUT_MS)
    );

    try {
        const socket = connect({ hostname: address, port: 443 });
        const writer = socket.writable.getWriter();
        const req = `GET /__down?bytes=5000 HTTP/1.1\r\nHost: ${PROBE_SNI}\r\nConnection: close\r\n\r\n`;

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
    }
}

const BATCH_CONCURRENCY = 4;
const BATCH_ATTEMPTS = 2;
const MAX_BATCH_TARGETS = 20;
const DISCOVER_TEST_ATTEMPTS = 1;
const MAX_DISCOVER_CANDIDATES = 12;

async function batchTest(targets: string[], attempts: number): Promise<EndpointTestResult[]> {
    const unique = [...new Set(targets.filter(Boolean))].slice(0, MAX_BATCH_TARGETS);
    const results: EndpointTestResult[] = [];

    for (let i = 0; i < unique.length; i += BATCH_CONCURRENCY) {
        const batch = unique.slice(i, i + BATCH_CONCURRENCY);
        const batchResults = await Promise.all(batch.map(async (target) => {
            const probes = await Promise.all(
                Array.from({ length: attempts }, () => checkEndpoint(target))
            );
            const oks = probes.filter(p => p.ok);

            return {
                target,
                ok: oks.length > 0,
                successRate: `${oks.length}/${attempts}`,
                avgLatencyMs: oks.length
                    ? Math.round(oks.reduce((s, p) => s + p.elapsedMs, 0) / oks.length)
                    : null
            };
        }));

        results.push(...batchResults);
    }

    return rankResults(results);
}

async function testSingleEndpoint(): Promise<Response> {
    const { searchParams } = getGlobals();
    const target = searchParams.get('target') ?? '';

    if (!target) {
        return respond(false, HttpStatus.BAD_REQUEST, 'Missing ?target= parameter.');
    }

    const attempts = await Promise.all(
        Array.from({ length: BATCH_ATTEMPTS }, () => checkEndpoint(target))
    );
    const oks = attempts.filter(a => a.ok);

    return respond(true, HttpStatus.OK, '', {
        target,
        ok: oks.length > 0,
        successRate: `${oks.length}/${BATCH_ATTEMPTS}`,
        avgLatencyMs: oks.length
            ? Math.round(oks.reduce((s, a) => s + a.elapsedMs, 0) / oks.length)
            : null
    });
}

async function testAllCleanIPsEndpoint(): Promise<Response> {
    try {
        const { cleanIPs } = getSettings();
        const results = await batchTest(cleanIPs, BATCH_ATTEMPTS);
        const best = results.find(r => r.ok)?.target ?? null;
        return respond(true, HttpStatus.OK, '', { results, best });
    } catch (error) {
        return respond(false, HttpStatus.INTERNAL_SERVER_ERROR, `Batch test failed: ${safeError(error)}`);
    }
}

// ---------- کشف خودکار IP تمیز ----------

const DISCOVER_TIMEOUT_MS = 6000;

async function fetchSource(url: string): Promise<string> {
    const response = await fetch(url, {
        headers: { 'User-Agent': 'flash-panel/0.5' },
        signal: AbortSignal.timeout(DISCOVER_TIMEOUT_MS)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
}

/**
 * کشف کاندیداهای تازه از منابع عمومی + تست سلامت هر کدام.
 * best-effort کامل: شکست یک منبع (یا همه) فقط «کشف خالی» می‌دهد، هرگز خطا.
 */
async function discoverAndTest(exclude: string[]): Promise<{ sources: string[]; results: EndpointTestResult[] }> {
    const settled = await Promise.allSettled(CLEAN_IP_DISCOVERY_SOURCES.map(fetchSource));
    const sources = settled.filter(s => s.status === 'fulfilled').map(() => 'ok');

    const excludeSet = new Set(exclude);
    const candidates = extractCandidates(
        settled
            .filter((s): s is PromiseFulfilledResult<string> => s.status === 'fulfilled')
            .map(s => s.value)
            .join('\n'),
        MAX_DISCOVER_CANDIDATES * 4
    )
        .filter(c => !excludeSet.has(c))
        .slice(0, MAX_DISCOVER_CANDIDATES);

    const results = candidates.length
        ? await batchTest(candidates, DISCOVER_TEST_ATTEMPTS)
        : [];

    return { sources, results };
}

async function discoverCleanIPsEndpoint(): Promise<Response> {
    try {
        const { cleanIPs } = getSettings();
        const { sources, results } = await discoverAndTest(cleanIPs);
        return respond(true, HttpStatus.OK, '', {
            sourcesReached: sources.length,
            sourcesTotal: CLEAN_IP_DISCOVERY_SOURCES.length,
            results
        });
    } catch (error) {
        return respond(false, HttpStatus.INTERNAL_SERVER_ERROR, `Discovery failed: ${safeError(error)}`);
    }
}

// ---------- ذخیره‌سازی مشترک (همان مسیر Save پنل) ----------

async function persistCleanIPs(env: Env, cleanIPs: string[]): Promise<void> {
    const merged = {
        ...getSettings(),
        cleanIPs
    } as PanelSettings;

    const errors = validateSettings(merged);
    if (errors?.length) {
        throw new Error(`Validation failed: ${errors.map(e => e.message).join(', ')}`);
    }

    await updateDataset(env, merged);
    await updateMainSettings(merged);
}

async function addCleanIPs(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') {
        return respond(false, HttpStatus.METHOD_NOT_ALLOWED, 'Method not allowed.');
    }

    try {
        const body = await request.json().catch(() => ({})) as { targets?: unknown };
        const targets = Array.isArray(body.targets)
            ? body.targets.filter((t): t is string => typeof t === 'string')
            : [];

        if (!targets.length) {
            return respond(false, HttpStatus.BAD_REQUEST, 'No targets provided.');
        }

        const { cleanIPs } = getSettings();
        // سقف ۱۵ و اعتبارسنجی سخت — ورودی مستقیم کاربر است
        const merged = [...new Set([...cleanIPs.filter(Boolean), ...targets])].slice(0, 15);
        await persistCleanIPs(env, merged);

        return respond(true, HttpStatus.OK, `${targets.length} target(s) processed — worker redeployed.`, {
            cleanIPs: merged
        });
    } catch (error) {
        return respond(false, HttpStatus.INTERNAL_SERVER_ERROR, `Add failed: ${safeError(error)}`);
    }
}

// ---------- بهینه‌سازی یک‌کلیکی (تست + کشف + بازآرایی + redeploy) ----------

async function autoApplyCleanIPs(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') {
        return respond(false, HttpStatus.METHOD_NOT_ALLOWED, 'Method not allowed.');
    }

    try {
        const body = await request.json().catch(() => ({})) as { includeDiscovered?: boolean };
        const { cleanIPs } = getSettings();
        const current = [...new Set(cleanIPs.filter(Boolean))];

        const results = await batchTest(current, BATCH_ATTEMPTS);

        let discovered: EndpointTestResult[] = [];
        if (body.includeDiscovered !== false) {
            ({ results: discovered } = await discoverAndTest(current));
        }

        const outcome = reorderCleanIPs(current, results, discovered, { cap: 15, maxAdd: 5 });

        if (!outcome.applied) {
            return respond(true, HttpStatus.OK, 'Already optimal — no changes needed.', {
                results,
                discovered,
                applied: false,
                best: results.find(r => r.ok)?.target ?? null,
                cleanIPs: outcome.list
            });
        }

        if (!outcome.list.some(Boolean)) {
            return respond(false, HttpStatus.INTERNAL_SERVER_ERROR,
                'No usable endpoint found — keep your current list.', { results, discovered });
        }

        await persistCleanIPs(env, outcome.list);

        return respond(true, HttpStatus.OK,
            `Optimized: ${outcome.list.length} endpoint(s), ${outcome.added.length} newly discovered — worker redeployed.`,
            {
                results,
                discovered,
                applied: true,
                best: outcome.list[0],
                cleanIPs: outcome.list,
                added: outcome.added
            });
    } catch (error) {
        return respond(false, HttpStatus.INTERNAL_SERVER_ERROR, `Auto-optimize failed: ${safeError(error)}`);
    }
}
