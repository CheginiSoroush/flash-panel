import { safeError } from '@common';
import { getGlobals } from '@settings';

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
    const metadata = {
        main_module: 'worker.js',
        keep_bindings: ['kv_namespace'],
        compatibility_date: new Date().toISOString().split('T')[0],
        compatibility_flags: ['nodejs_compat']
    };
    const uploadForm = new FormData();
    uploadForm.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    uploadForm.append('worker.js', new Blob([script], { type: 'application/javascript+module' }), 'worker.js');
    const scriptName = mainDomain.split('.')[0];

    try {
        const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accID}/workers/scripts/${scriptName}`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${apiToken}` },
            body: uploadForm
        });

        const data: any = await res.json();
        if (!data.success) throw new Error(humanizeDeployError(data?.errors?.[0]?.message ?? `HTTP ${res.status}`));
    } catch (error) {
        throw new Error(`Failed to deploy worker: ${safeError(error)}`);
    }
}

export async function getWorkerDomains(): Promise<string[]> {
    const { accID, apiToken, mainDomain } = getGlobals();
    const scriptName = mainDomain.split('.')[0];

    try {
        const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accID}/workers/domains?service=${scriptName}`, {
            headers: { 'Authorization': `Bearer ${apiToken}` }
        });

        const data: any = await res.json();
        if (!data.success) throw new Error(data?.errors?.[0]?.message);
        return data.result.map((r: any) => r.hostname);
    } catch (error) {
        throw new Error(`Failed to get worker domains: ${safeError(error)}`);
    }
}

export async function setWorkerDomain(domain: string) {
    const { accID, apiToken, mainDomain } = getGlobals();
    const scriptName = mainDomain.split('.')[0];

    try {
        const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accID}/workers/domains`, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${apiToken}`,
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
    const { accID, apiToken, mainDomain } = getGlobals();
    const scriptName = mainDomain.split('.')[0];

    try {
        const form = new FormData();
        form.append('settings', new Blob([JSON.stringify({ workers_dev: enabled })], { type: 'application/json' }));

        const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accID}/workers/scripts/${scriptName}/settings`, {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${apiToken}`
            },
            body: form
        });

        const data: any = await res.json();
        if (!data.success) throw new Error(data?.errors?.[0]?.message);
    } catch (error) {
        throw new Error(`Failed to set workers.dev route: ${safeError(error)}`);
    }
}

export async function deleteWorker() {
    const { accID, apiToken, mainDomain } = getGlobals();
    const scriptName = mainDomain.split('.')[0];

    try {
        const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accID}/workers/scripts/${scriptName}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${apiToken}` }
        });

        const data: any = await res.json();
        if (!data.success) throw new Error(data?.errors?.[0]?.message);
    } catch (error) {
        throw new Error(`Failed to delete worker: ${safeError(error)}`);
    }
}