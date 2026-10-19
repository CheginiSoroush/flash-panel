import { safeError } from '@common';
import { getGlobals } from '@settings';
import { resolveWorkerName } from './worker-name';
import { cfAuthFromGlobals, CF_TOKEN_MISSING_ERROR } from './cf-auth';

/**
 * پیام‌های خطای Cloudflare API را به راهنمای عملی تبدیل می‌کند —
 * کاربر به‌جای «please try again» بداند دقیقاً چه چیزی را باید درست کند.
 */
function humanizeDeployError(message: string): string {
    if (/authentication|authorization|invalid api token|code:? ?10000|forbidden/i.test(message)) {
        return `${message} — hint: your API token needs "Workers Scripts:Edit" permission for panel updates.`;
    }
    if (/quota|exceeded|rate limit|too many requests/i.test(message)) {
        return `${message} — hint: free plan daily limit hit; retry after the quota resets.`;
    }
    if (/too large|size limit|10027/i.test(message)) {
        return `${message} — hint: script size limit for your plan; use the latest optimized release.`;
    }
    return message;
}

export async function deployWorkers(script: string) {
    const { accID, apiToken, mainDomain } = getGlobals();

    // v0.8.12 — بدون توکن، درخواست با 401 مبهم CF می‌مرد؛ پیام صادق و قابل‌اقدام
    if (!apiToken) {
        throw new Error(CF_TOKEN_MISSING_ERROR);
    }

    const metadata = {
        main_module: 'worker.js',
        keep_bindings: ['kv_namespace'],
        compatibility_date: new Date().toISOString().split('T')[0],
        compatibility_flags: ['nodejs_compat']
    };
    const uploadForm = new FormData();
    uploadForm.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    uploadForm.append('worker.js', new Blob([script], { type: 'application/javascript+module' }), 'worker.js');
    // v0.8.3: قبلاً mainDomain.split('.')[0] بود که با دامنه‌ی شخصی اسکریپت اشتباه آپدیت می‌کرد
    const scriptName = resolveWorkerName();

    try {
        const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accID}/workers/scripts/${scriptName}`, {
            method: 'PUT',
            headers: cfAuthFromGlobals(),
            body: uploadForm
        });

        const data: any = await res.json();
        if (!data.success) throw new Error(humanizeDeployError(data?.errors?.[0]?.message ?? `HTTP ${res.status}`));
    } catch (error) {
        throw new Error(`Failed to deploy worker: ${safeError(error)}`);
    }
}

export async function getWorkerDomains(): Promise<string[]> {
    const { accID, apiToken } = getGlobals();

    // v0.8.12 — گارد توکن مثل deployWorkers
    if (!apiToken) {
        throw new Error(CF_TOKEN_MISSING_ERROR);
    }

    const scriptName = resolveWorkerName();

    try {
        const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accID}/workers/domains?service=${scriptName}`, {
            headers: cfAuthFromGlobals()
        });

        const data: any = await res.json();
        if (!data.success) throw new Error(data?.errors?.[0]?.message);
        return data.result.map((r: any) => r.hostname);
    } catch (error) {
        throw new Error(`Failed to get worker domains: ${safeError(error)}`);
    }
}

export async function setWorkerDomain(domain: string) {
    const { accID, apiToken } = getGlobals();
    const scriptName = resolveWorkerName();

    try {
        const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accID}/workers/domains`, {
            method: 'PUT',
            headers: {
                ...cfAuthFromGlobals(),
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                hostname: domain,
                service: scriptName
            })
        });

        const data: any = await res.json();
        if (!data.success) throw new Error(data?.errors?.[0]?.message);
    } catch (error) {
        throw new Error(`Failed to set worker domain: ${safeError(error)}`);
    }
}

/**
 * ⚡ کنترل مسیر workers.dev
 * enabled=false → وقتی دامنه‌ی سفارشی فعاله: URL قابل‌اسکن از رادار خارج می‌شه
 * enabled=true  → وقتی دامنه پاک می‌شه: پنل بی‌جا نمی‌مونه
 */
export async function setWorkersDevRoute(enabled: boolean) {
    const { accID, apiToken } = getGlobals();
    const scriptName = resolveWorkerName();

    try {
        const form = new FormData();
        form.append('settings', new Blob([JSON.stringify({ workers_dev: enabled })], { type: 'application/json' }));

        const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accID}/workers/scripts/${scriptName}/settings`, {
            method: 'PATCH',
            headers: cfAuthFromGlobals(),
            body: form
        });

        const data: any = await res.json();
        if (!data.success) throw new Error(data?.errors?.[0]?.message);
    } catch (error) {
        throw new Error(`Failed to set workers.dev route: ${safeError(error)}`);
    }
}

export async function deleteWorker() {
    const { accID, apiToken } = getGlobals();
    const scriptName = resolveWorkerName();

    try {
        const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accID}/workers/scripts/${scriptName}`, {
            method: 'DELETE',
            headers: cfAuthFromGlobals()
        });

        const data: any = await res.json();
        if (!data.success) throw new Error(data?.errors?.[0]?.message);
    } catch (error) {
        throw new Error(`Failed to delete worker: ${safeError(error)}`);
    }
}