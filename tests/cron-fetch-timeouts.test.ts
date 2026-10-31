import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * v0.8.46 — سقف زمانی همه‌ی fetchهای خروجی زنجیره‌ی کرون/اتوماسیون + بستن
 * سوکتِ تست ProxyIP در مسیر تایم‌اوت (src/api/automation.ts، workersdev-guard.ts،
 * usage.ts، proxy-check.ts)
 *
 * کلاس باگ (سومین عضو خانواده — بعد از DoH در v0.8.44 و my-ip در v0.8.45):
 *   • notifyAdmin (تلگرام) — در ۴ نقطه await می‌شود و callback گارد/edge-tuner
 *     است؛ api.telegram.org آویزان = کل tick کرون روی همان await — مراحل بعدی
 *     (usage-warn/digest/ذخیره‌ی state) هرگز اجرا نمی‌شوند.
 *   • cfJson (گارد workers.dev) — تا ۵۱ فراخوانی CF-API در هر tick بدون سقف؛
 *     یک api.cloudflare.com آویزان = گارد و کل tick گروگان.
 *   • runUsageQuery (GraphQL) — هم کرون و هم درخواست پنل ادمین (getUsage) را
 *     آویزان می‌کند (همان استدلال my-ip).
 *   • checkProxyIP — socket.close فقط در مسیر موفق؛ در تایم‌اوت سوکت باز
 *     می‌ماند و سهمیه‌ی اتصال همزمان Workers (۶ — مشترک بین fetch و سوکت)
 *     را می‌بلعد → fetchهای بعدی همان tick گرسنه.
 *
 * استراتژی تست (الگوی dns-fetch-timeout.test.ts): استاب fetch «خوب‌رفتار» که
 * به AbortSignal گوش می‌دهد و روی abort رد می‌شود — همان کاری که fetch واقعی
 * می‌کند. روی کد قدیمی (بدون signal) هیچ‌وقت settle نمی‌شود → تست‌های آویزش
 * با timeout ران قرمز می‌شوند (اثبات RED). تست سوکت: close باید در مسیر
 * تایم‌اوت صدا زده شود — روی کد قدیمی closeSpy صفر می‌ماند (RED معمولی).
 */

// ---------- globals زنجیره‌ی import (الگوی workersdev-guard.test.ts) ----------
(globalThis as any).VERSION = '0.8.46';
(globalThis as any)._repo_ = 'https://github.com/CheginiSoroush/flash-panel';
(globalThis as any)._project_SM_ = 'flash';
(globalThis as any)._public_proxy_ip_ = 'bpb.yousef.isegaro.com';

const BASE_EMBEDED = {
    accID: 'test-account-id',
    accEmail: 'admin@example.com',
    apiToken: 'api-token',
    vlUUID: 'b831381d-6324-4d53-ad4f-8cda48b30811',
    trPass: 'trojan-pass',
    securePath: 'sp',
    proxyIpMode: '',
    proxyIPs: [] as string[],
    prefixes: [] as string[],
    mainDomain: 'fp.example.com',
    fallback: '',
    dohUrl: ''
};

beforeEach(() => {
    (globalThis as any).EMBEDED_SETTINGS = { ...BASE_EMBEDED };
});

// ---------- استاب fetch — آویختگی واقعی با پشتیبانی از AbortSignal ----------
// بدون init.signal (کد قدیمی) → هرگز settle نمی‌شود؛ با signal → روی abort رد.
function hangingFetchAware() {
    return vi.fn((_url: unknown, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')));
        })
    );
}

// ---------- mock سوکت آویزان — برای تست close در مسیر تایم‌اوت ----------
const { closeSpy } = vi.hoisted(() => ({ closeSpy: vi.fn(async () => { }) }));
vi.mock('cloudflare:sockets', () => ({
    connect: vi.fn(() => ({
        writable: {
            getWriter: () => ({ write: async () => { }, releaseLock: () => { } })
        },
        readable: {
            getReader: () => ({
                read: () => new Promise(() => { }), // هرگز — آویختگی واقعی
                releaseLock: () => { }
            })
        },
        close: closeSpy,
        opened: Promise.resolve(),
        closed: Promise.resolve()
    }))
}));

afterEach(() => {
    delete (globalThis as any).EMBEDED_SETTINGS;
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    closeSpy.mockClear();
});

// ---------- ۱) notifyAdmin — تلگرام آویزان → false در سقف (نه هرگز) ----------

describe('notifyAdmin timeout (v0.8.46)', () => {
    it('returns false when Telegram hangs — the tick never stalls on it', async () => {
        const automation = await import('../src/api/automation');
        automation._setNotifyTimeoutForTest(50);
        const hang = hangingFetchAware();
        vi.stubGlobal('fetch', hang);

        const r = await automation.notifyAdmin({ token: 'T', adminChatId: 'C' } as any, 'hi');
        expect(r).toBe(false);
        expect(hang).toHaveBeenCalledOnce();
        // signal واقعاً به fetch پاس داده شده باشد (نه صرفاً تایم‌اوت داخلی)
        expect(hang.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    });

    it('healthy Telegram still delivers — true + payload intact (no over-removal)', async () => {
        const automation = await import('../src/api/automation');
        const okFetch = vi.fn(async (_url: unknown, init?: { body?: string }) =>
            new Response(JSON.stringify({ ok: true }), { status: 200 })
        );
        vi.stubGlobal('fetch', okFetch);

        const r = await automation.notifyAdmin({ token: 'T', adminChatId: 'C' } as any, 'hello <b>world</b>');
        expect(r).toBe(true);
        const body = JSON.parse(okFetch.mock.calls[0][1]?.body ?? '{}');
        expect(body.chat_id).toBe('C');
        expect(body.text).toBe('hello <b>world</b>');
        expect(body.parse_mode).toBe('HTML');
    });
});

// ---------- ۲) گارد workers.dev — CF-API آویزان → تکمیل سقف‌دار با fallback ----------

describe('workersdev-guard cfJson timeout (v0.8.46)', () => {
    it('completes bounded when api.cloudflare.com hangs — list fallback path', async () => {
        const settings = await import('../src/settings/settings');
        settings.initForScheduled({} as Env);

        const guard = await import('../src/api/workersdev-guard');
        guard._setGuardFetchTimeoutForTest(50);
        vi.stubGlobal('fetch', hangingFetchAware());

        // هر دو فراخوانی (لیست + subdomain خودِ اسکریپت) abort می‌شوند →
        // مسیر «پاس غریبه» → fallback به اسکریپت خود پنل → skip بی‌صدا.
        // کد قدیمی: هیچ‌وقت resolve نمی‌شد (تست با timeout قرمز).
        const res = await guard.ensureWorkersDevDisabled();
        expect(res.checked).toEqual([]);
        expect(res.enabledFound).toEqual([]);
        expect(res.leftOpen).toEqual([]);
        expect(res.error).toContain('list-scripts unavailable');
    });
});

// ---------- ۳) usage — GraphQL آویزان → نتیجه‌ی صادق ناموفق در سقف ----------

describe('getCfWorkerUsage timeout (v0.8.46)', () => {
    it('returns success:false with actionable error when analytics hangs', async () => {
        const settings = await import('../src/settings/settings');
        settings.initForScheduled({} as Env);

        const usage = await import('../src/api/usage');
        usage._setUsageFetchTimeoutForTest(50);
        vi.stubGlobal('fetch', hangingFetchAware());

        // هر دو تلاش (token + key) abort → buildUsageError — هیچ‌وقت بی‌نهایت.
        // کد قدیمی: هرگز resolve نمی‌شد؛ هم کرون و هم getUsage پنل گروگان.
        const r = await usage.getCfWorkerUsage();
        expect(r.success).toBe(false);
        expect(r.error).toContain('Usage analytics unavailable');
        expect(r.error).toContain('API Token (Bearer)');
        expect(r.error).toContain('Global API Key (X-Auth-Key)');
    });

    it('healthy analytics still parses — success:true with totals', async () => {
        const settings = await import('../src/settings/settings');
        settings.initForScheduled({} as Env);

        const usage = await import('../src/api/usage');
        const okFetch = vi.fn(async () =>
            new Response(JSON.stringify({
                data: { viewer: { accounts: [{ total: [{ sum: { requests: 1500 } }], worker: [{ sum: { requests: 700 } }] }] } }
            }), { status: 200 })
        );
        vi.stubGlobal('fetch', okFetch);

        const r = await usage.getCfWorkerUsage();
        expect(r.success).toBe(true);
        expect(r.total).toBe(1500);
        expect(r.worker).toBe(700);
    });
});

// ---------- ۴) checkProxyIP — سوکت مسیر تایم‌اوت بسته شود (نشتی سهمیه‌ی اتصال) ----------

describe('checkProxyIP socket cleanup (v0.8.46)', () => {
    it('closes the socket when the read times out — no leaked connection', async () => {
        const { checkProxyIP } = await import('../src/api/proxy-check');

        const r = await checkProxyIP('hang.test', 30);
        expect(r.ok).toBe(false);
        // کد قدیمی: close فقط در مسیر موفق → closeSpy صفر می‌ماند (RED معمولی)
        expect(closeSpy).toHaveBeenCalled();
    });

    it('still closes exactly once on the healthy path (idempotent, no double-close crash)', async () => {
        // سوکت سالم: اولین read همان پاسخ را می‌دهد
        vi.doMock('cloudflare:sockets', () => ({
            connect: vi.fn(() => ({
                writable: { getWriter: () => ({ write: async () => { }, releaseLock: () => { } }) },
                readable: {
                    getReader: () => {
                        let read = false;
                        return {
                            read: async () => {
                                if (read) return { done: true, value: undefined };
                                read = true;
                                return { done: false, value: new TextEncoder().encode('HTTP/1.1 400 Bad Request\r\ncf-ray: 8abc\r\n\r\n') };
                            },
                            releaseLock: () => { }
                        };
                    }
                },
                close: closeSpy,
                opened: Promise.resolve(),
                closed: Promise.resolve()
            }))
        }));
        vi.resetModules();
        const { checkProxyIP } = await import('../src/api/proxy-check');

        const r = await checkProxyIP('ok.test', 5_000);
        expect(r.ok).toBe(true);
        expect(closeSpy).toHaveBeenCalledTimes(1);
    });
});
