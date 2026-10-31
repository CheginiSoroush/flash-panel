import { buildDNS } from './dns';
import { buildRoutingRules, buildRuleProviders } from './routing';
import { buildChainOutbound, buildUrlTest, buildWarpOutbound, buildWebsocketOutbound } from './outbounds';
import type { ChainOutbound, WireguardOutbound, Config, Outbound } from '#types/clash';
import { getConfigAddresses, generateRemark, isHttps, getProtocols } from '@utils';
import { sniffer, tun } from './inbounds';
import { getSettings, getWarpAccounts } from '@settings';
import { safeError } from '@common';

type TagGroup = Record<string, string[]>;

async function buildConfig(
    outbounds: Outbound[],
    TagGroups: TagGroup,
    isChain: boolean,
    isWarp: boolean,
    isPro: boolean
): Promise<Config> {
    const { logLevel, allowLANConnection } = getSettings();

    const groups = Object.keys(TagGroups).filter(key => !!TagGroups[key].length);
    const selectorTags: string[] = [
        ...groups,
        ...groups.flatMap(key => TagGroups[key])
    ];

    const tcpSettings = isWarp ? {} : {
        'disable-keep-alive': false,
        'keep-alive-idle': 10,
        'keep-alive-interval': 15,
        'tcp-concurrent': true
    };

    const config: Config = {
        'mixed-port': 7890,
        'ipv6': true,
        'allow-lan': allowLANConnection,
        'unified-delay': false,
        'log-level': logLevel.replace('none', 'silent'),
        'mode': 'rule',
        ...tcpSettings,
        'geo-auto-update': true,
        'geo-update-interval': 168,
        'external-controller': '127.0.0.1:9090',
        'external-controller-cors': {
            'allow-origins': ['*'],
            'allow-private-network': true
        },
        'external-ui': 'ui',
        'external-ui-url': 'https://github.com/MetaCubeX/metacubexd/archive/refs/heads/gh-pages.zip',
        'profile': {
            'store-selected': true,
            'store-fake-ip': true
        },
        'dns': await buildDNS(isChain, isWarp, isPro),
        'tun': tun,
        'sniffer': sniffer,
        'proxies': outbounds,
        'proxy-groups': [
            {
                'name': '✅ Selector',
                'type': 'select',
                'proxies': selectorTags
            }
        ],
        'rule-providers': buildRuleProviders(),
        'rules': buildRoutingRules(isWarp),
        'ntp': {
            'enable': true,
            'server': 'time.cloudflare.com',
            'port': 123,
            'interval': 30
        }
    };

    for (const group of groups) {
        if (TagGroups[group].length) {
            const urlTest = buildUrlTest(group, TagGroups[group], isWarp);
            config['proxy-groups'].push(urlTest);
        }
    }

    return config;
}

export async function getClNormalConfig(): Promise<Response> {
    const {
        chainProxy,
        ports,
        mainDomain,
        customDomain,
        upstreamParams: { upstreamServer, upstreamPort }
    } = getSettings();

    // v0.8.51 — زنجیره قابلیتی «اختیاری» است؛ داده‌ی زنجیره‌ی خراب (blob KV باستان از
    // پیش از ولیدیتور، بازیابی بکاپ ناقص، نویسنده‌ی معیوب آینده) هرگز نباید کل ساب
    // clash normal را ۵۰۰ کند — قرارداد fail-soft هم‌راستا با بقیه‌ی کد‌بیس:
    // parseHostPort → direct، resolveDNS → null، ساب سفارشی مرده → حذف محتوا.
    // ذخیره‌ی پنل خودش ولیدیتور دارد (new URL/JSON.parse گارد شده)؛ این گارد برای
    // مسیرهایی است که از ولیدیتور عبور نکرده‌اند — بدون زنجیره سرو می‌شود و لاگ می‌ماند.
    let chainAttempt: ChainOutbound | undefined;
    if (chainProxy) {
        try {
            chainAttempt = buildChainOutbound();
        } catch (error) {
            console.log(`chain outbound skipped (bad chainProxy — sub continues without chain): ${safeError(error)}`);
        }
    }
    // const مجدد — باریک‌سازی نوع از طریق isChain (aliased condition) فقط روی const کار می‌کند
    const chainOutbound = chainAttempt;
    const isChain = !!chainOutbound;
    const domains = [...new Set([mainDomain].concatIf(!!customDomain, customDomain))];
    const protocols = getProtocols();

    const outbounds: Outbound[] = [];
    const tagGroup: TagGroup = {
        '⚡ Best Ping 🚀': [],
        '⚡ 🔗 Best Ping 🚀': [],
        '⚡ Best Ping D 🚀': [],
        '⚡ 🔗 Best Ping D 🚀': [],
    };

    for (const domain of domains) {
        const totalPorts = ports.filter(port => domain.endsWith('workers.dev') || isHttps(port));
        const hosts = await getConfigAddresses(domain, false);
        // v0.8.62 — جفت upstream دیگر در totalPorts/hosts ادغام نمی‌شود (unshift +
        // XOR-skip — پاریتی با فیکس‌های xray v0.8.52 و sing-box v0.8.53). ادغامِ
        // قدیمی وقتی upstreamPort عضو ports باشد (رایج‌ترین: ۴۴۳) دو ایراد می‌ساخت:
        // (۱) جفت upstream دوبار تولید می‌شد — هر دو کپیِ پورت با شرط XOR پاس
        // می‌کردند؛ (۲) کانفیگ‌های عادی همان پورت حذف می‌شدند — host عادی × پورت
        // upstream توسط همان شرط skip می‌شد؛ با ports پیش‌فرض [443] یعنی سابِ
        // clash بدون هیچ کانفیگ ورکری روی پورت تصادم، فقط دو کپی upstream. حالا
        // upstream یک «نقطه‌ی ورود اضافه» است — اول صف، بدون تداخل با پورت‌های
        // عادی. ترتیب در حالت بدون تصادم عیناً مثل قبل می‌ماند (port-بیرونی،
        // host-درونی).
        const hasUpstream = !!(upstreamServer && upstreamPort);
        const pairs: Array<{ host: string; port: number }> = [];
        if (hasUpstream) pairs.push({ host: upstreamServer, port: upstreamPort });
        for (const port of totalPorts) {
            for (const host of hosts) {
                pairs.push({ host, port });
            }
        }

        for (const protocol of protocols) {
            let protocolIndex = 1;
            for (const { host, port } of pairs) {
                const tag = generateRemark(protocolIndex, port, host, protocol, domain, false, false);
                const outbound = buildWebsocketOutbound(protocol, tag, host, port, domain, outbounds.length);

                if (outbound) {
                    outbounds.push(outbound);
                    if (domain === customDomain && domain !== mainDomain) {
                        tagGroup['⚡ Best Ping D 🚀'].push(tag);
                    } else {
                        tagGroup['⚡ Best Ping 🚀'].push(tag);
                    }

                    if (isChain) {
                        const chainTag = generateRemark(protocolIndex, port, host, protocol, domain, false, true);
                        const chain = structuredClone(chainOutbound);
                        chain['name'] = chainTag;
                        chain['dialer-proxy'] = tag;
                        outbounds.push(chain);

                        if (domain === customDomain && domain !== mainDomain) {
                            tagGroup['⚡ 🔗 Best Ping D 🚀'].push(chainTag);
                        } else {
                            tagGroup['⚡ 🔗 Best Ping 🚀'].push(chainTag);
                        }
                    }

                    protocolIndex++;
                }
            }
        }
    }

    const config = await buildConfig(
        outbounds,
        tagGroup,
        isChain,
        false,
        false
    );

    // بدنه‌ی فشرده — کلاینت‌ها (mihomo/Clash Verge/FlClash) فرمت تورفتگی را لازم ندارند؛
    // ~۳۰٪ بدنه و حافظه‌ی subBodyCache کمتر + stringify سریع‌تر در هر تولید
    return new Response(JSON.stringify(config), {
        status: 200,
        headers: {
            'Content-Type': 'application/json',
            'Content-Disposition': `attachment; filename=${_project_SM_}-normal-clash.json`,
            'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
            'Pragma': 'no-cache',
            'Expires': '0'
        }
    });
}

export async function getClWarpConfig(isPro: boolean): Promise<Response> {
    const { warpEndpoints } = getSettings();
    const warpAccounts = getWarpAccounts();

    const outbounds: WireguardOutbound[] = [];
    const proSign = isPro ? 'Pro ' : '';
    const tagGroup: TagGroup = {
        [`⚡ Warp ${proSign}- Best Ping 🚀`]: [],
        [`⚡ WoW ${proSign}- Best Ping 🚀`]: []
    };

    warpEndpoints.forEach((endpoint, index) => {
        const warpTag = `⚡ ${index + 1}. Warp ${proSign}🇮🇷`;
        tagGroup[`⚡ Warp ${proSign}- Best Ping 🚀`].push(warpTag);

        const wowTag = `⚡ ${index + 1}. WoW ${proSign}🌍`;
        tagGroup[`⚡ WoW ${proSign}- Best Ping 🚀`].push(wowTag);

        const warpOutbound = buildWarpOutbound(warpAccounts[0], warpTag, endpoint, '', isPro);
        const wowOutbound = buildWarpOutbound(warpAccounts[1], wowTag, endpoint, warpTag, false);
        outbounds.push(warpOutbound, wowOutbound);
    });

    const config = await buildConfig(
        outbounds,
        tagGroup,
        false,
        true,
        isPro
    );

    const fileName = isPro ? 'warp-Pro' : 'warp';
    // بدنه‌ی فشرده — هم‌راستا با getClNormalConfig
    return new Response(JSON.stringify(config), {
        status: 200,
        headers: {
            'Content-Type': 'application/json',
            'Content-Disposition': `attachment; filename=${_project_SM_}-${fileName}-clash.json`,
            'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
            'Pragma': 'no-cache',
            'Expires': '0'
        }
    });
}