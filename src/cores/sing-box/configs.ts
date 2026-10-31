import { Outbound, WireguardEndpoint, Config } from '#types/sing-box';
import { getConfigAddresses, generateRemark, isHttps, getProtocols } from '@utils';
import { buildChainOutbound, buildUrlTest, buildWarpOutbound, buildWebsocketOutbound } from './outbounds.js';
import { getSettings, getWarpAccounts } from '@settings';
import { buildRoutingRules } from './routing';
import { buildMixedInbound, tun } from './inbounds';
import { buildDNS } from './dns';

type TagGroup = Record<string, string[]>;

async function buildConfig(
    outbounds: Outbound[],
    endpoints: WireguardEndpoint[],
    TagGroups: TagGroup,
    isWarp: boolean,
    isChain: boolean
): Promise<Config> {
    const { logLevel } = getSettings();

    const groups = Object.keys(TagGroups).filter(group => !!TagGroups[group].length);
    const selectorTags: string[] = [
        ...groups,
        ...groups.flatMap(key => TagGroups[key])
    ];

    const config: Config = {
        log: {
            disabled: logLevel === 'none',
            level: logLevel === 'none' ? undefined : logLevel === 'warning' ? 'warn' : logLevel,
            timestamp: true
        },
        dns: await buildDNS(isWarp, isChain),
        inbounds: [
            tun,
            buildMixedInbound()
        ],
        outbounds: [
            ...outbounds,
            {
                type: 'selector',
                tag: '✅ Selector',
                outbounds: selectorTags,
                interrupt_exist_connections: false
            },
            {
                type: 'direct',
                tag: 'direct',
                domain_resolver: 'dns-direct'
            }
        ],
        endpoints: endpoints.omitEmpty(),
        route: buildRoutingRules(isWarp),
        ntp: {
            enabled: true,
            server: 'time.cloudflare.com',
            server_port: 123,
            domain_resolver: 'dns-direct',
            interval: '30m',
            write_to_system: false
        },
        experimental: {
            cache_file: {
                enabled: true,
                store_fakeip: true
            },
            clash_api: {
                external_controller: '127.0.0.1:9090',
                external_ui: 'ui',
                default_mode: 'Rule',
                external_ui_download_url: 'https://github.com/MetaCubeX/metacubexd/archive/refs/heads/gh-pages.zip',
                external_ui_download_detour: 'direct'
            }
        }
    };

    for (const group of groups) {
        if (TagGroups[group].length) {
            const urlTest = buildUrlTest(group, TagGroups[group], isWarp);
            config.outbounds.push(urlTest);
        }
    }

    return config;
}

export async function getSbCustomConfig(isFragment: boolean): Promise<Response> {
    const {
        chainProxy,
        ports,
        mainDomain,
        customDomain,
        upstreamParams: { upstreamServer, upstreamPort }
    } = getSettings();

    const chainOutbound = chainProxy ? buildChainOutbound() : undefined;
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
        // هم‌راستا با هسته‌ی xray: برچسب «D» فقط برای دامنه‌ی سفارشیِ واقعی —
        // customDomain === mainDomain یعنی دامنه‌ی اصلی، نه سفارشی (v0.8.43)
        const isCustomDomain = domain === customDomain && domain !== mainDomain;
        const totalPorts = ports.filter(port => !isFragment && domain.endsWith('workers.dev') || isHttps(port));
        const hosts = await getConfigAddresses(domain, isFragment);
        // هم‌راستا با هسته‌ی xray: جفت upstream فقط در پروفایل‌های non-fragment —
        // پروفایل fragment روی پین استاتیک mainDomain بنا شده و TLS-fragment
        // به سمت سرور upstream بی‌معناست (v0.8.43)
        // v0.8.53 — جفت upstream دیگر در totalPorts/hosts ادغام نمی‌شود (همان
        // فیکس xray v0.8.52): unshift + XOR-skip وقتی upstreamPort عضو ports
        // باشد (رایج‌ترین: ۴۴۳) جفت upstream را دوبار تولید می‌کرد و کانفیگ‌های
        // عادی همان پورت را کلاً حذف می‌کرد — با ports پیش‌فرض [443] یعنی سابِ
        // بدون هیچ کانفیگ ورکری. حالا upstream زوج مستقلِ اولِ صف است.
        const hasUpstream = !!(upstreamServer && upstreamPort && !isFragment);

        for (const protocol of protocols) {
            let protocolIndex = 1;

            const pairs: Array<{ host: string; port: number }> = [];
            if (hasUpstream) pairs.push({ host: upstreamServer, port: upstreamPort });
            for (const port of totalPorts) {
                for (const host of hosts) {
                    pairs.push({ host, port });
                }
            }

            for (const { host, port } of pairs) {
                const tag = generateRemark(protocolIndex, port, host, protocol, domain, isFragment, false);
                const outbound = buildWebsocketOutbound(protocol, tag, host, port, domain, isFragment, outbounds.length);
                outbounds.push(outbound);

                if (isCustomDomain) {
                    tagGroup['⚡ Best Ping D 🚀'].push(tag);
                } else {
                    tagGroup['⚡ Best Ping 🚀'].push(tag);
                }

                if (isChain) {
                    const chainTag = generateRemark(protocolIndex, port, host, protocol, domain, isFragment, true);
                    const chain = structuredClone(chainOutbound);
                    chain.tag = chainTag;
                    chain.detour = tag;
                    outbounds.push(chain);

                    if (isCustomDomain) {
                        tagGroup['⚡ 🔗 Best Ping D 🚀'].push(chainTag);
                    } else {
                        tagGroup['⚡ 🔗 Best Ping 🚀'].push(chainTag);
                    }
                }

                protocolIndex++;
            }
        }
    }

    const config = await buildConfig(
        outbounds,
        [],
        tagGroup,
        false,
        isChain
    );

    const fileName = isFragment ? 'fragment' : 'normal';
    // فشرده — JSON.stringify بدون تورفتگی (~۳۰٪ بدنه‌ی کوچک‌تر؛ کلاینت‌های sing-box/mihomo JSON فشرده را کامل قبول می‌کنند)
    return new Response(JSON.stringify(config), {
        status: 200,
        headers: {
            'Content-Type': 'application/json',
            'Content-Disposition': `attachment; filename=${_project_SM_}-${fileName}-sing-box.json`,
            'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
            'Pragma': 'no-cache',
            'Expires': '0'
        }
    });
}

export async function getSbWarpConfig(): Promise<Response> {
    const { warpEndpoints } = getSettings();
    const warpAccounts = getWarpAccounts();
    const outbounds: WireguardEndpoint[] = [];

    const tagGroup: TagGroup = {
        '⚡ Warp - Best Ping 🚀': [],
        '⚡ WoW - Best Ping 🚀': []
    };

    warpEndpoints.forEach((endpoint, index) => {
        const warpTag = `⚡ ${index + 1}. Warp 🇮🇷`;
        tagGroup['⚡ Warp - Best Ping 🚀'].push(warpTag);

        const wowTag = `⚡ ${index + 1}. WoW 🌍`;
        tagGroup['⚡ WoW - Best Ping 🚀'].push(wowTag);

        const warpOutbound = buildWarpOutbound(warpAccounts[0], warpTag, endpoint);
        const wowOutbound = buildWarpOutbound(warpAccounts[1], wowTag, endpoint, warpTag);
        outbounds.push(warpOutbound, wowOutbound);
    });

    const config = await buildConfig(
        [],
        outbounds,
        tagGroup,
        true,
        false
    );

    // فشرده — JSON.stringify بدون تورفتگی (~۳۰٪ بدنه‌ی کوچک‌تر؛ کلاینت‌های sing-box/mihomo JSON فشرده را کامل قبول می‌کنند)
    return new Response(JSON.stringify(config), {
        status: 200,
        headers: {
            'Content-Type': 'application/json',
            'Content-Disposition': `attachment; filename=${_project_SM_}-warp-sing-box.json`,
            'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
            'Pragma': 'no-cache',
            'Expires': '0'
        }
    });
}