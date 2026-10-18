import { describe, it, expect, afterEach, vi } from 'vitest';

// الگوی automation.test.ts — ماژول‌ها EMBEDED_SETTINGS را در load می‌خواهند
(globalThis as any).VERSION = '0.8.3';

function createKvMock() {
    const store = new Map<string, string>();
    const kv = {
        async get(key: string, opts?: { type?: string }) {
            const raw = store.get(key);
            if (raw === undefined) return null;
            return opts?.type === 'json' ? JSON.parse(raw) : raw;
        },
        async put(key: string, value: string) {
            store.set(key, value);
        },
        async delete(key: string) {
            store.delete(key);
        }
    } as unknown as KVNamespace;
    return { kv, store };
}

/** ماژول‌های تازه با EMBEDED تازه — staticGlobals در سطح ماژول کش می‌شود */
async function freshModules(embeded: Record<string, unknown>) {
    vi.resetModules();
    (globalThis as any).EMBEDED_SETTINGS = embeded;
    const settings = await import('../src/settings/settings');
    return settings;
}

const BASE_EMBEDED = {
    accID: 'test-account',
    accEmail: 'test@example.com',
    apiToken: 'test-token',
    vlUUID: 'b831381d-6324-4d53-ad4f-8cda48b30811',
    trPass: 'test-pass',
    securePath: 'fp',
    proxyIpMode: '',
    proxyIPs: [],
    prefixes: [],
    fallback: '',
    dohUrl: ''
};

afterEach(() => {
    delete (globalThis as any).EMBEDED_SETTINGS;
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

// ---------- resolveWorkerName ----------

describe('resolveWorkerName', () => {
    it('derives the script name from a workers.dev mainDomain', async () => {
        await freshModules({ ...BASE_EMBEDED, mainDomain: 'mypanel.example.workers.dev' });
        const settings = await import('../src/settings/settings');
        settings.initForScheduled({} as Env);
        const { resolveWorkerName } = await import('../src/api/worker-name');
        expect(resolveWorkerName()).toBe('mypanel');
    });

    it('falls back to flash-panel for a custom domain without scriptName', async () => {
        // 🔴 بازتولید باگ v0.8.2- : mainDomain=fp.imsoroush.top → «fp» اشتباه بود
        await freshModules({ ...BASE_EMBEDED, mainDomain: 'fp.imsoroush.top' });
        const settings = await import('../src/settings/settings');
        settings.initForScheduled({} as Env);
        const { resolveWorkerName } = await import('../src/api/worker-name');
        expect(resolveWorkerName()).toBe('flash-panel');
        expect(resolveWorkerName()).not.toBe('fp');
    });

    it('prefers the pinned scriptName when present', async () => {
        await freshModules({ ...BASE_EMBEDED, mainDomain: 'fp.imsoroush.top', scriptName: 'my-flash' });
        const settings = await import('../src/settings/settings');
        settings.initForScheduled({} as Env);
        const { resolveWorkerName } = await import('../src/api/worker-name');
        expect(resolveWorkerName()).toBe('my-flash');
    });

    it('never throws when globals are uninitialized', async () => {
        await freshModules({ ...BASE_EMBEDED, mainDomain: 'fp.imsoroush.top' });
        // بدون initForScheduled — globalSettings هنوز null است
        const { resolveWorkerName } = await import('../src/api/worker-name');
        expect(resolveWorkerName()).toBe('flash-panel');
    });
});

// ---------- ensureWorkersDevDisabled ----------

interface CfCall {
    method: string;
    url: string;
    body?: unknown;
    auth?: string;
}

/** fetch stub با مسیریابی CF API — وضعیت workers.dev هر اسکریپت قابل تنظیم */
function stubCfApi(opts: {
    scripts?: string[];
    enabled?: Record<string, boolean>;
    listOk?: boolean;
    patchOk?: boolean;
    calls: CfCall[];
}) {
    vi.stubGlobal('fetch', (async (input: any, init?: any) => {
        const url = String(input instanceof URL ? input.href : input);
        const method = (init?.method ?? 'GET').toUpperCase();
        const auth = init?.headers?.Authorization ?? init?.headers?.get?.('Authorization');
        let body: unknown;
        if (typeof init?.body === 'string') {
            try { body = JSON.parse(init.body); } catch { body = init.body; }
        }
        opts.calls.push({ method, url, body, auth });

        if (url.endsWith('/workers/scripts') && method === 'GET') {
            if (!opts.listOk) {
                return new Response(JSON.stringify({ success: false, errors: [{ message: 'not authorized' }] }), { status: 403 });
            }
            return new Response(JSON.stringify({
                success: true,
                result: (opts.scripts ?? []).map((id) => ({ id }))
            }), { status: 200 });
        }

        const subdomainMatch = url.match(/\/workers\/scripts\/([^/]+)\/subdomain$/);
        if (subdomainMatch) {
            const name = decodeURIComponent(subdomainMatch[1]);
            if (method === 'GET') {
                const enabled = opts.enabled?.[name] ?? false;
                return new Response(JSON.stringify({ success: true, result: { enabled, previews_enabled: false } }), { status: 200 });
            }
            if (method === 'PATCH') {
                if (!opts.patchOk) return new Response(JSON.stringify({ success: false, errors: [{ message: 'denied' }] }), { status: 403 });
                if (opts.enabled) opts.enabled[name] = false;
                return new Response(JSON.stringify({ success: true, result: { enabled: false, previews_enabled: false } }), { status: 200 });
            }
        }

        return new Response('{}', { status: 404 });
    }) as typeof fetch);
}

async function initGuardModules(mainDomain: string) {
    const settings = await freshModules({ ...BASE_EMBEDED, mainDomain });
    settings.initForScheduled({} as Env);
    const guard = await import('../src/api/workersdev-guard');
    return guard;
}

describe('ensureWorkersDevDisabled', () => {
    it('disables an open workers.dev host and reports it', async () => {
        const calls: CfCall[] = [];
        stubCfApi({ scripts: ['flash-panel', 'flash-wizard'], enabled: { 'flash-panel': true, 'flash-wizard': false }, listOk: true, patchOk: true, calls });
        const guard = await initGuardModules('fp.imsoroush.top');

        const res = await guard.ensureWorkersDevDisabled();
        expect(res.checked).toEqual(['flash-panel', 'flash-wizard']);
        expect(res.enabledFound).toEqual(['flash-panel']);
        expect(res.disabled).toEqual(['flash-panel']);
        expect(res.leftOpen).toEqual([]);
        expect(res.ok).toBe(true);

        const patch = calls.find((c) => c.method === 'PATCH');
        expect(patch).toBeDefined();
        expect(patch!.url).toContain('/workers/scripts/flash-panel/subdomain');
        expect(patch!.body).toEqual({ enabled: false, previews_enabled: false });
        expect(patch!.auth).toBe('Bearer test-token');
    });

    it('sends no PATCH when everything is already disabled', async () => {
        const calls: CfCall[] = [];
        stubCfApi({ scripts: ['flash-panel', 'flash-wizard'], enabled: { 'flash-panel': false, 'flash-wizard': false }, listOk: true, calls });
        const guard = await initGuardModules('fp.imsoroush.top');

        const res = await guard.ensureWorkersDevDisabled();
        expect(res.checked).toEqual(['flash-panel', 'flash-wizard']);
        expect(res.enabledFound).toEqual([]);
        expect(res.disabled).toEqual([]);
        expect(res.ok).toBe(true);
        expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    });

    it('marks a script leftOpen when the PATCH fails', async () => {
        const calls: CfCall[] = [];
        stubCfApi({ scripts: ['flash-panel'], enabled: { 'flash-panel': true }, patchOk: false, calls });
        const guard = await initGuardModules('fp.imsoroush.top');

        const res = await guard.ensureWorkersDevDisabled();
        expect(res.enabledFound).toEqual(['flash-panel']);
        expect(res.disabled).toEqual([]);
        expect(res.leftOpen).toEqual(['flash-panel']);
        expect(res.ok).toBe(false);
    });

    it('falls back to the own script when listing is not permitted', async () => {
        const calls: CfCall[] = [];
        stubCfApi({ scripts: [], listOk: false, enabled: { 'flash-panel': false }, calls });
        const guard = await initGuardModules('fp.imsoroush.top');

        const res = await guard.ensureWorkersDevDisabled();
        expect(res.checked).toEqual(['flash-panel']);
        expect(res.enabledFound).toEqual([]);
        expect(res.error).toContain('list-scripts unavailable');
    });

    it('stays silent on garbage subdomain responses (no crash)', async () => {
        const calls: CfCall[] = [];
        stubCfApi({ scripts: ['flash-panel'], enabled: {}, calls });
        // enabled بدون کلید → مسیر GET پاس می‌دهد enabled=false؛ ولی پاس GraphQL‌شکل هم تست می‌شود:
        const guard = await initGuardModules('fp.imsoroush.top');
        const res = await guard.ensureWorkersDevDisabled();
        expect(res.enabledFound).toEqual([]);
        expect(res.ok).toBe(true);
    });
});

// ---------- runWorkersDevGuard — هشدار + cooldown ----------

describe('runWorkersDevGuard', () => {
    it('alerts once and records the cooldown in KV', async () => {
        const calls: CfCall[] = [];
        stubCfApi({ scripts: ['flash-panel'], enabled: { 'flash-panel': true }, patchOk: true, calls });
        const guard = await initGuardModules('fp.imsoroush.top');

        const { kv, store } = createKvMock();
        const env = { kv } as unknown as Env;
        const sent: string[] = [];

        const first = await guard.runWorkersDevGuard(env, async (html) => { sent.push(html); });
        expect(first?.enabledFound).toEqual(['flash-panel']);
        expect(first?.disabled).toEqual(['flash-panel']);
        expect(sent).toHaveLength(1);
        expect(sent[0]).toContain('Workers.dev guard');
        expect(sent[0]).toContain('flash-panel');
        expect(store.has('workersdevGuardAlert')).toBe(true);

        // دور دوم بلافاصله — گارد دور اول خودش بسته → چیزی باز پیدا نمی‌کند؛
        // و cooldown هم هیچ پیام تکراری‌ای نمی‌سازد
        const second = await guard.runWorkersDevGuard(env, async (html) => { sent.push(html); });
        expect(second?.enabledFound).toEqual([]);
        expect(sent).toHaveLength(1);
    });

    it('stays fully silent when nothing is open', async () => {
        const calls: CfCall[] = [];
        stubCfApi({ scripts: ['flash-panel'], enabled: { 'flash-panel': false }, calls });
        const guard = await initGuardModules('fp.imsoroush.top');

        const { kv, store } = createKvMock();
        const env = { kv } as unknown as Env;
        const sent: string[] = [];

        const res = await guard.runWorkersDevGuard(env, async (html) => { sent.push(html); });
        expect(res?.enabledFound).toEqual([]);
        expect(sent).toHaveLength(0);
        expect(store.has('workersdevGuardAlert')).toBe(false);
    });

    it('never throws even when the CF API is completely down', async () => {
        vi.stubGlobal('fetch', (async () => {
            throw new Error('network down');
        }) as typeof fetch);
        const guard = await initGuardModules('fp.imsoroush.top');

        const { kv } = createKvMock();
        const env = { kv } as unknown as Env;
        const sent: string[] = [];

        const res = await guard.runWorkersDevGuard(env, async (html) => { sent.push(html); });
        // list fail → fallback own script → subdomain fail → skip → ok با لیست خالی
        expect(res).not.toBeNull();
        expect(res?.enabledFound).toEqual([]);
        expect(sent).toHaveLength(0);
    });
});
