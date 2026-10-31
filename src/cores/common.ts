import { base64DecodeUtf8, base64EncodeUtf8 } from '@common';
import { getSettings } from '@settings';
import {
    generateRemark,
    generateWsPath,
    getConfigAddresses,
    getProtocols,
    isBase64,
    isHttps,
    pickFingerprint,
    selectSniHost
} from '@utils';

export async function getURLConfigs() {
    const {
        ports,
        chainProxy,
        remoteDNS,
        customConfigs,
        customSubs,
        customDomain,
        vlUUID,
        trPass,
        httpsPorts,
        client,
        mainDomain,
        upstreamParams: { upstreamServer, upstreamPort }
    } = getSettings();

    // ضد خوشه‌بندی JA3 — fp چرخشی قطعی بر اساس شماره‌ی پروفایل
    const buildConfig = (protocol: string, addr: string, port: number, host: string, sni: string, remark: string, fpSeed: number) => {
        const isTLS = httpsPorts.includes(port) || addr === upstreamServer;
        const security = isTLS ? 'tls' : 'none';
        const config = new URL(`${protocol}://config`);

        if (protocol === _VL_) {
            config.username = vlUUID;
            config.searchParams.append('encryption', 'none');
        } else {
            config.username = trPass;
        }

        const path = generateWsPath(protocol);
        config.hostname = addr;
        config.port = port.toString();
        config.searchParams.append('host', host);
        config.searchParams.append('type', 'ws');
        config.searchParams.append('security', security);
        config.hash = remark;

        if (client === 'sing-box') {
            config.searchParams.append('eh', 'Sec-WebSocket-Protocol');
            config.searchParams.append('ed', '2560');
            config.searchParams.append('path', path);
        } else {
            config.searchParams.append('path', `${path}?ed=2560`);
        }

        if (isTLS) {
            config.searchParams.append('sni', sni);
            config.searchParams.append('fp', pickFingerprint(fpSeed));
            config.searchParams.append('alpn', 'http/1.1');
        }

        return config.href;
    }

    let VLConfs = '', TRConfs = '', chainConfig = '';
    let proxyIndex = 1;
    const domains = [...new Set([mainDomain].concatIf(!!customDomain, customDomain))];
    const protocols = getProtocols();

    for (const domain of domains) {
        const totalPorts = ports.filter(port => domain.endsWith('workers.dev') || isHttps(port));
        const addrs = await getConfigAddresses(domain, false);
        // v0.8.62 — جفت upstream دیگر در totalPorts/addrs ادغام نمی‌شود (unshift +
        // XOR-skip — پاریتی با فیکس‌های xray v0.8.52 / sing-box v0.8.53 / clash).
        // با تصادم (رایج‌ترین: ports=[443] و upstream روی همان ۴۴۳): جفت upstream
        // دوبار تولید و کانفیگ‌های عادی همان پورت حذف می‌شدند — ساب raw بدون هیچ
        // کانفیگ ورکری روی پورت تصادم. حالا upstream نقطه‌ی ورود اضافه است — اول
        // صف، بدون تداخل با پورت‌های عادی؛ ترتیب بدون تصادم عیناً مثل قبل.
        const hasUpstream = !!(upstreamServer && upstreamPort);
        const pairs: Array<{ addr: string; port: number }> = [];
        if (hasUpstream) pairs.push({ addr: upstreamServer, port: upstreamPort });
        for (const port of totalPorts) {
            for (const addr of addrs) {
                pairs.push({ addr, port });
            }
        }

        for (const { addr, port } of pairs) {
            const { sni, host } = selectSniHost(addr, domain);

            if (protocols.includes(_VL_)) {
                const remark = generateRemark(proxyIndex, port, addr, _VL_, domain, false, false);
                const vlConfig = buildConfig(_VL_, addr, port, host, sni, remark, proxyIndex);
                VLConfs += `${vlConfig}\n`;
            }

            if (protocols.includes(_TR_)) {
                const remark = generateRemark(proxyIndex, port, addr, _TR_, domain, false, false);
                const trConfig = buildConfig(_TR_, addr, port, host, sni, remark, proxyIndex);
                TRConfs += `${trConfig}\n`;
            }

            proxyIndex++;
        }
    }

    if (chainProxy) {
        let chainRemark = `#${encodeURIComponent('⚡ Chain proxy 🔗')}`;
        if (chainProxy.startsWith('socks') || chainProxy.startsWith('http')) {
            const regex = /^(?:socks|http):\/\/([^@]+)@/;
            const isUserPass = chainProxy.match(regex);
            const userPass = isUserPass ? isUserPass[1] : false;
            chainConfig = userPass
                ? chainProxy.replace(userPass, btoa(userPass)) + chainRemark
                : chainProxy + chainRemark;
        } else {
            chainConfig = chainProxy.split('#')[0] + chainRemark;
        }
    }

    const customConfs = customConfigs.join('\n') + await fetchCustomSubs(customSubs);
    const configs = base64EncodeUtf8(VLConfs + TRConfs + chainConfig + customConfs);

    return new Response(configs, {
        status: 200,
        headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
            'Pragma': 'no-cache',
            'Expires': '0',
            'Profile-Title': `base64:${base64EncodeUtf8(`⚡ ${_project_} Raw`)}`,
            // کلاینت‌ها (v2rayNG/Hiddify) هر ۳ ساعت خودکار آپدیت می‌گیرند
            'Profile-Update-Interval': '3',
            'DNS': remoteDNS
        }
    });
}

// v0.8.50 — پنجمین عضو خانواده‌ی «آپ‌استریم بی‌سقف» (بعد از DoH در v0.8.44،
// my-ip در v0.8.45 و زنجیره‌ی کرون در v0.8.46) — این بار در مسیر ساب کلاینت:
// fetchCustomSubs روی هر درخواست «raw» اجرا می‌شود؛ یک URL ساب سفارشی آویزان
// (سرور مرده، سیاه‌چاله، اتصال نیمه‌باز) کل تولید ساب raw را برای همیشه نگه
// می‌داشت و کلاینت «خطای آپدیت — بدون کانفیگ» می‌دید. سقف ۱۰ث هر واکشی؛ چون
// واکشی‌ها با Promise.all موازی‌اند، دیوارِ زمانیِ کل تابع هم ۱۰ث است.
const CUSTOM_SUB_FETCH_TIMEOUT_MS = 10_000;
let customSubFetchTimeoutMs = CUSTOM_SUB_FETCH_TIMEOUT_MS;

/** هُک تست — الگوی v0.8.44 (_setMyIpFetchTimeoutForTest) */
export function _setCustomSubFetchTimeoutForTest(ms: number): void {
    customSubFetchTimeoutMs = ms;
}

async function fetchCustomSubs(subs: string[]): Promise<string> {
    const results = await Promise.all(
        subs.map(async (url) => {
            const controller = new AbortController();
            // signal کل چرخه‌ی واکشی را پوشش می‌دهد — هدر و بدنه (آپ‌استریم
            // کند-ریز که بدنه را قطره‌قطره می‌فرستد هم در همین سقف می‌میرد)
            const timer = setTimeout(() => controller.abort(), customSubFetchTimeoutMs);
            try {
                const res = await fetch(url, { signal: controller.signal });
                if (!res.ok) return '';

                const text = (await res.text()).trim();
                if (!text) return '';

                if (isBase64(text)) {
                    try {
                        return base64DecodeUtf8(text);
                    } catch {
                        return text;
                    }
                }

                return text;
            } catch {
                // قرارداد موجود: ساب سفارشیِ مرده هرگز کل ساب raw را نمی‌شکند —
                // حالا «آویزان» هم در همین قرارداد می‌افتد (abort → رد → '')
                return '';
            } finally {
                clearTimeout(timer);
            }
        })
    );

    return results
        .filter(Boolean)
        .join('\n');
}
