import { authenticate } from '@auth';
import { HttpStatus, respond, safeError } from '@common';
import { getGlobals, initForScheduled } from '@settings';
import { getUsageHistory, recordUsageSample } from '@settings/usage-history';
import { resolveWorkerName } from './worker-name';

interface CfUsageResult {
    success: boolean;
    total?: number;
    worker?: number;
    error?: string;
}

/**
 * نتیجه‌ی یک تلاش GraphQL — چه موفق چه ناموفق همیشه جزئیات دارد تا
 * هیچ‌وقت «موفقِ صفرِ دروغین» تولید نشود (باگ usage-all-zeros).
 */
interface GqlAttempt {
    ok: boolean;
    total: number;
    worker: number;
    error?: string;
    /** کدام مود احراز استفاده شد — برای پیام خطای دقیق */
    authKind: 'token' | 'key';
}

/** استخراج امن از پاسخ GraphQL — خطاهای سطح GraphQL را نادیده نمی‌گیرد */
function extractUsage(gqlData: any): { ok: boolean; total: number; worker: number; gqlError?: string } {
    // GraphQL ممکن است errors بدهد ولی HTTP 200 برگرداند — بررسی هر دو لازم است
    const errs: any[] = Array.isArray(gqlData?.errors) ? gqlData.errors : [];
    const account = gqlData?.data?.viewer?.accounts?.[0];

    if (!account || typeof account !== 'object') {
        const detail = errs.length
            ? errs.map((e) => e?.message || JSON.stringify(e)).join('; ')
            : 'empty analytics payload';
        return { ok: false, total: 0, worker: 0, gqlError: detail };
    }

    const totalRequests = (account.total ?? []).reduce(
        (sum: number, entry: any) => sum + (entry?.sum?.requests || 0), 0
    );
    const workerRequests = (account.worker ?? []).reduce(
        (sum: number, entry: any) => sum + (entry?.sum?.requests || 0), 0
    );

    return { ok: true, total: totalRequests, worker: workerRequests };
}

/**
 * یک درخواست GraphQL کامل با هدرهای داده‌شده.
 * خطای fetch / JSON / HTTP به نتیجه تبدیل می‌شود، هرگز throw نمی‌کند.
 */
async function runUsageQuery(
    authHeaders: Record<string, string>,
    variables: Record<string, string>,
    query: string,
    authKind: GqlAttempt['authKind']
): Promise<GqlAttempt> {
    try {
        const gqlRes = await fetch('https://api.cloudflare.com/client/v4/graphql', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders },
            body: JSON.stringify({ query, variables })
        });

        if (!gqlRes.ok) {
            return {
                ok: false, total: 0, worker: 0, authKind,
                error: `HTTP ${gqlRes.status} from analytics API`
            };
        }

        const gqlData: any = await gqlRes.json().catch(() => null);
        if (!gqlData) {
            return { ok: false, total: 0, worker: 0, authKind, error: 'analytics API returned non-JSON' };
        }

        const extracted = extractUsage(gqlData);
        if (!extracted.ok) {
            return {
                ok: false, total: 0, worker: 0, authKind,
                error: extracted.gqlError ?? 'no analytics data returned'
            };
        }

        return { ok: true, total: extracted.total, worker: extracted.worker, authKind };
    } catch (error) {
        return { ok: false, total: 0, worker: 0, authKind, error: safeError(error) };
    }
}

/** پیام خطای قابل‌اقدام — کاربر باید بفهمد کدام نوع کلید را باید بگذارد */
function buildUsageError(attempts: GqlAttempt[]): string {
    const details = attempts
        .map((a) => `${a.authKind === 'token' ? 'API Token (Bearer)' : 'Global API Key (X-Auth-Key)'}: ${a.error}`)
        .join(' · ');
    return (
        'Usage analytics unavailable — Cloudflare rejected the credentials. ' +
        `Details: ${details}. ` +
        'Fix: paste an API Token with "Account Analytics:Read" permission, ' +
        'or the account Global API Key (the panel deploy email is used automatically).'
    );
}

export async function getCfWorkerUsage(): Promise<CfUsageResult> {
    const { accID, accEmail, apiToken } = getGlobals();
    // v0.8.3: قبلاً mainDomain.split('.')[0] بود که برای دامنه‌ی شخصی «fp» می‌داد
    // و فیلتر scriptName در GraphQL هیچ‌وقت match نمی‌شد (Panel requests همیشه ۰)
    const scriptName = resolveWorkerName();

    try {
        const now = new Date();
        const datetimeEnd = now.toISOString();
        const datetimeStart = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

        const query = `
            query GetUsage($accountTag: String!, $scriptName: String!, $start: String!, $end: String!) {
                viewer {
                    accounts(filter: { accountTag: $accountTag }) {
                        total: workersInvocationsAdaptive(
                            limit: 100
                            filter: { datetime_geq: $start, datetime_leq: $end }
                        ) {
                            sum { requests }
                        }
                        worker: workersInvocationsAdaptive(
                            limit: 100
                            filter: { scriptName: $scriptName, datetime_geq: $start, datetime_leq: $end }
                        ) {
                            sum { requests }
                        }
                    }
                }
            }
        `;
        const variables = { accountTag: accID, scriptName, start: datetimeStart, end: datetimeEnd };

        // ---------- تلاش ۱: API Token (استاندارد Bearer) ----------
        const tokenAttempt = await runUsageQuery(
            { Authorization: `Bearer ${apiToken}` }, variables, query, 'token'
        );
        if (tokenAttempt.ok) {
            return { success: true, total: tokenAttempt.total, worker: tokenAttempt.worker };
        }

        // ---------- تلاش ۲: Global API Key (اگر ایمیل اکانت embed شده باشد) ----------
        // دیپلوی‌های Flash Panel همیشه accEmail را embed می‌کنند؛ اگر کاربر به‌جای
        // API Token کلید Global گذاشته باشد، Bearer جواب نمی‌دهد ولی X-Auth-Key کار می‌کند.
        // (این همان ریشه‌ی «usage همیشه صفر» بود — خطا بی‌صدا صفر می‌شد.)
        if (accEmail) {
            const keyAttempt = await runUsageQuery(
                { 'X-Auth-Email': accEmail, 'X-Auth-Key': apiToken }, variables, query, 'key'
            );
            if (keyAttempt.ok) {
                return { success: true, total: keyAttempt.total, worker: keyAttempt.worker };
            }
            return { success: false, error: buildUsageError([tokenAttempt, keyAttempt]) };
        }

        return { success: false, error: buildUsageError([tokenAttempt]) };
    } catch (error) {
        return { success: false, error: 'Error fetching usage data. Check your credentials.' };
    }
}

/**
 * نمونه‌گیری مستقل از درخواست — برای scheduled handler (cron trigger).
 *
 * بدون این، سری زمانی usage فقط وقتی پر می‌شه که کسی پنل رو باز کنه و
 * روزهای بدون بازدید خالی می‌مونن. globals بدون Request مقداردهی می‌شن
 * (فیلدهای وابسته به درخواست در مسیر GraphQL استفاده نمی‌شن) و هر خطا
 * swallow می‌شه — cron هرگز نباید worker رو crash کنه.
 */
export async function sampleUsageNow(env: Env): Promise<void> {
    try {
        initForScheduled(env);

        const usage = await getCfWorkerUsage();
        if (usage.success) {
            await recordUsageSample(env, usage.total ?? 0, usage.worker ?? 0);
        }
    } catch {
        // best-effort — نبودِ نمونه بهتر از کرشِ scheduled handler است
    }
}

export async function getUsage(request: Request, env: Env) {
    try {
        const auth = await authenticate(request, env);
        if (!auth) {
            throw new Error('Unauthorized or expired session.');
        }

        const usage = await getCfWorkerUsage();
        if (!usage.success) {
            // پیام واقعی به پنل می‌رسد — دیگر «صفرِ دروغین» تولید نمی‌کنیم
            return respond(false, HttpStatus.SERVICE_UNAVAILABLE, usage.error ?? 'Failed to fetch account usage.');
        }

        // ثبت نمونه برای سری زمانی روزانه — best-effort، هرگز پاس را خراب نمی‌کند
        // (رژیم write: اگر نمونه‌ی تازه‌ای در همین روز ثبت شده، خودش skip می‌کند)
        await recordUsageSample(env, usage.total ?? 0, usage.worker ?? 0);

        return respond(true, HttpStatus.OK, '', {total: usage.total, worker: usage.worker});
    } catch (error) {
        return respond(false, HttpStatus.INTERNAL_SERVER_ERROR, `Error occurred while fetching usage: ${safeError(error)}`);
    }
}

/**
 * تاریخچه مصرف روزانه برای نمودار پنل — GET panel/usage/history?days=30
 * فقط سری KV خوانده می‌شود (بدون تماس GraphQL) — سریع و بدون سهمی‌گرفتن از API کلودفلر.
 */
export async function getUsageHistoryEndpoint(request: Request, env: Env) {
    try {
        const auth = await authenticate(request, env);
        if (!auth) {
            return respond(false, HttpStatus.UNAUTHORIZED, 'Unauthorized or expired session.');
        }

        const { searchParams } = new URL(request.url);
        const days = Number(searchParams.get('days')) || 30;
        const history = await getUsageHistory(env, days);

        return respond(true, HttpStatus.OK, '', history, {
            'Cache-Control': 'no-store'
        });
    } catch (error) {
        return respond(false, HttpStatus.INTERNAL_SERVER_ERROR, `Error occurred while fetching usage history: ${safeError(error)}`);
    }
}
