import { safeError } from '@common';
import { getGlobals } from '@settings';

interface PagesContext {
    accID: string;
    apiToken: string;
    projectName: string;
}

function getPagesContext(): PagesContext {
    const { accID, apiToken, mainDomain } = getGlobals();
    return { accID, apiToken, projectName: mainDomain.split('.')[0] };
}

/**
 * هلپر مشترک برای فراخوانی Cloudflare API — حذف تکرار ۴ تابع
 */
async function cfApi(path: string, init: RequestInit = {}): Promise<any> {
    const { accID, apiToken } = getPagesContext();

    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${apiToken}`);

    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accID}${path}`, {
        ...init,
        headers
    });

    return res.json();
}

export async function deployPages(script: string) {
    const { projectName } = getPagesContext();

    const uploadForm = new FormData();
    uploadForm.append('manifest', '{}');
    uploadForm.append(
        '_worker.js',
        new Blob([script], { type: 'application/javascript' }),
        '_worker.js'
    );

    try {
        const deployData: any = await cfApi(`/pages/projects/${projectName}/deployments`, {
            method: 'POST',
            body: uploadForm
        });
        if (!deployData.success) throw new Error(deployData?.errors?.[0]?.message || JSON.stringify(deployData.errors));
    } catch (error) {
        throw new Error(`Failed to create Pages deployment: ${safeError(error)}`);
    }
}

export async function getPagesDomains(): Promise<string[]> {
    const { projectName } = getPagesContext();

    try {
        const data: any = await cfApi(`/pages/projects/${projectName}/domains`);
        if (!data.success) throw new Error(data?.errors?.[0]?.message);
        return data.result.map((r: any) => r.hostname);
    } catch (error) {
        throw new Error(`Failed to get Pages project domains: ${safeError(error)}`);
    }
}

export async function setPagesDomain(domain: string) {
    const { projectName } = getPagesContext();

    try {
        const data: any = await cfApi(`/pages/projects/${projectName}/domains`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: domain })
        });
        if (!data.success) throw new Error(data?.errors?.[0]?.message);
    } catch (error) {
        throw new Error(`Failed to set Pages project domain: ${safeError(error)}`);
    }
}

export async function deletePagesProject() {
    const { projectName } = getPagesContext();

    try {
        // (console.log(mainDomain) بی‌دلیل حذف شد)
        const data: any = await cfApi(`/pages/projects/${projectName}`, { method: 'DELETE' });
        if (!data.success) throw new Error(data?.errors?.[0]?.message);
    } catch (error) {
        throw new Error(`Failed to delete pages project: ${safeError(error)}`);
    }
}