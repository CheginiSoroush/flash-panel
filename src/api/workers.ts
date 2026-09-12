import { safeError } from '@common';
import { getGlobals } from '@settings';

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
        if (!data.success) throw new Error(data?.errors?.[0]?.message);
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
        const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accID}/workers/scripts/${scriptName}/subdomain`, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${apiToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ enabled })
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
/**
 * ⚡ خاموش کردن مسیر workers.dev — وقتی دامنه‌ی سفارشی وصل می‌شه صدا زده می‌شه
 * تا URL قابل‌اسکن (*.workers.dev) از رادار خارج بشه
 */
export async function disableWorkersDev() {
    const { accID, apiToken, mainDomain } = getGlobals();
    const scriptName = mainDomain.split('.')[0];

    try {
        const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accID}/workers/scripts/${scriptName}/subdomain`, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${apiToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ enabled: false })
        });

        const data: any = await res.json();
        if (!data.success) throw new Error(data?.errors?.[0]?.message);
    } catch (error) {
        throw new Error(`Failed to disable workers.dev route: ${safeError(error)}`);
    }
}
