import { describe, expect, it, beforeAll } from 'vitest';

/**
 * تست‌های موتور دریافت آخرین ریلیز (fetch-latest.ts)
 * fetch کاملاً تزریقی است — هیچ درخواست واقعی شبکه‌ای انجام نمی‌شود.
 * الگوی import داینامیک داخل beforeAll (محدودیت vitest این پروژه با top-level await)
 */

type FetchLatest = typeof import('../src/api/fetch-latest');

const VALID_SCRIPT = `// worker\n${'x'.repeat(60_000)}\nexport default { fetch() {} };`;

function makeResponse(status: number, body = ''): Response {
    return new Response(body, { status });
}

describe('fetch-latest — اعتبارسنجی محتوا', () => {
    let mod: FetchLatest;

    beforeAll(async () => {
        mod = await import('../src/api/fetch-latest');
    });

    it('پاسخ 200 ولی HTML/صفحه‌ی خطا رد می‌شود و به آینه‌ی بعد می‌رود', async () => {
        mod.invalidateLatestScriptCache();
        const calls: string[] = [];
        const html = '<!DOCTYPE html><html><body>error page</body></html>';

        const result = await mod.fetchLatestWorkerScript({
            fetchImpl: async (url: any) => {
                calls.push(String(url));
                // آینه‌ی اول صفحه‌ی خطای HTML می‌دهد (شبیه 200 GitHub error)
                return calls.length === 1 ? makeResponse(200, html) : makeResponse(200, VALID_SCRIPT);
            },
            attempts: 1,
            timeoutMs: 1000,
            now: () => 1000
        });

        expect(calls.length).toBe(2); // آینه‌ی اول رد شد → آینه‌ی دوم
        expect(result.source).toBe('github-pages');
        expect(result.script).toBe(VALID_SCRIPT);
    });

    it('اسکریپت کوتاه‌تر از حداقل حجم رد می‌شود (MIN_SCRIPT_LENGTH)', async () => {
        mod.invalidateLatestScriptCache();
        const tooShort = `export default {}; // ${'y'.repeat(100)}`;

        await expect(
            mod.fetchLatestWorkerScript({
                fetchImpl: async () => makeResponse(200, tooShort),
                attempts: 1,
                now: () => 1000
            })
        ).rejects.toThrow(/all mirrors failed/);
    });
});

describe('fetch-latest — زنجیره‌ی آینه‌ها', () => {
    let mod: FetchLatest;

    beforeAll(async () => {
        mod = await import('../src/api/fetch-latest');
    });

    it('403 آینه‌ی اول → بدون معطلی بی‌خود به آینه‌ی دوم می‌رود (backoff نه — چون 403 روی تلاش آخر)', async () => {
        mod.invalidateLatestScriptCache();
        const calls: string[] = [];

        const result = await mod.fetchLatestWorkerScript({
            fetchImpl: async (url: any) => {
                calls.push(String(url));
                if (calls.length === 1) return makeResponse(403);
                return makeResponse(200, VALID_SCRIPT);
            },
            attempts: 1,
            now: () => 1000
        });

        expect(calls.length).toBe(2);
        expect(result.source).toBe('github-pages');
    });

    it('404 آینه اول فوراً آینه بعد را می‌رود و تلاش مجدد نمی‌کند', async () => {
        mod.invalidateLatestScriptCache();
        const calls: string[] = [];

        const result = await mod.fetchLatestWorkerScript({
            fetchImpl: async (url: any) => {
                calls.push(String(url));
                if (calls.length === 1) return makeResponse(404); // آینه اول نه
                return makeResponse(200, VALID_SCRIPT);
            },
            attempts: 2,
            now: () => 1000
        });

        // 404 در آینه اول → break بدون تلاش دوم → مستقیم آینه دوم موفق
        expect(calls.length).toBe(2);
        expect(result.source).toBe('github-pages');
    });

    it('تمام آینه‌ها خطا بدهند، خطای جمع‌بندی با وضعیت هر آینه پرتاب می‌شود', async () => {
        mod.invalidateLatestScriptCache();

        await expect(
            mod.fetchLatestWorkerScript({
                fetchImpl: async () => makeResponse(429),
                attempts: 1,
                now: () => 1000
            })
        ).rejects.toThrow(/all mirrors failed.*github-releases.*429.*github-pages.*429.*jsdelivr.*429/s);
    });

    it('خطای شبکه بدون status (timeout) هم retryable است', async () => {
        mod.invalidateLatestScriptCache();
        let calls = 0;

        const result = await mod.fetchLatestWorkerScript({
            fetchImpl: async () => {
                calls++;
                if (calls === 1) throw new Error('The operation was aborted due to timeout');
                return makeResponse(200, VALID_SCRIPT);
            },
            attempts: 2,
            backoffMs: 1,
            now: () => 1000
        });

        expect(calls).toBe(2);
        expect(result.source).toBe('github-releases');
    });
});

describe('fetch-latest — retry و backoff', () => {
    let mod: FetchLatest;

    beforeAll(async () => {
        mod = await import('../src/api/fetch-latest');
    });

    it('429 روی تلاش اول آینه اول → تلاش دوم همان آینه موفق (بدون رفتن به آینه بعد)', async () => {
        mod.invalidateLatestScriptCache();
        const calls: string[] = [];

        const result = await mod.fetchLatestWorkerScript({
            fetchImpl: async (url: any) => {
                calls.push(String(url));
                if (calls.length === 1) return makeResponse(429);
                return makeResponse(200, VALID_SCRIPT);
            },
            attempts: 2,
            backoffMs: 1,
            now: () => 1000
        });

        expect(calls.length).toBe(2);
        expect(calls[0]).toBe(calls[1]); // همان آینه
        expect(result.source).toBe('github-releases');
    });
});

describe('fetch-latest — کش', () => {
    let mod: FetchLatest;

    beforeAll(async () => {
        mod = await import('../src/api/fetch-latest');
    });

    it('فراخوانی دوم در TTL هیچ fetch جدیدی نمی‌زند', async () => {
        mod.invalidateLatestScriptCache();
        let calls = 0;
        let clock = 1000;

        await mod.fetchLatestWorkerScript({
            fetchImpl: async () => {
                calls++;
                return makeResponse(200, VALID_SCRIPT);
            },
            now: () => clock
        });

        // زمان جلو می‌رود ولی زیر TTL
        clock = 1000 + 5 * 60_000;

        const cached = await mod.fetchLatestWorkerScript({
            fetchImpl: async () => {
                calls++;
                return makeResponse(200, VALID_SCRIPT);
            },
            now: () => clock
        });

        expect(calls).toBe(1);
        expect(cached.source).toBe('github-releases');
    });

    it('بعد از انقضای TTL دوباره واکشی می‌شود', async () => {
        mod.invalidateLatestScriptCache();
        let calls = 0;
        let clock = 2000;

        const opts = () => ({
            fetchImpl: (async () => {
                calls++;
                return makeResponse(200, VALID_SCRIPT);
            }) as typeof fetch,
            now: () => clock,
            cacheTtlMs: 60_000
        });

        await mod.fetchLatestWorkerScript(opts());
        clock += 61_000;
        await mod.fetchLatestWorkerScript(opts());

        expect(calls).toBe(2);
    });

    it('inflight تکراری — درخواست هم‌زمان فقط یک واکشی واقعی انجام می‌دهد', async () => {
        mod.invalidateLatestScriptCache();
        let calls = 0;

        const fetchImpl = (async () => {
            calls++;
            await new Promise(r => setTimeout(r, 5));
            return makeResponse(200, VALID_SCRIPT);
        }) as typeof fetch;

        const [a, b] = await Promise.all([
            mod.fetchLatestWorkerScript({ fetchImpl, now: () => 1000 }),
            mod.fetchLatestWorkerScript({ fetchImpl, now: () => 1000 })
        ]);

        expect(calls).toBe(1);
        expect(a.script).toBe(b.script);
    });
});
