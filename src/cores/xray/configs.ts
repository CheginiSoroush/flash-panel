import type { Balancer, Config, Observatory, Outbound } from '#types/xray';
import { getSettings, getWarpAccounts } from '@settings';
import { buildDokodemoInbound, buildMixedInbound } from './inbounds';
import { buildRoutingRules } from './routing';
import { buildDNS } from './dns';
import {
    buildChainOutbound,
    buildWebsocketOutbound,
    buildWarpOutbound,
    buildFreedomOutbound
} from './outbounds';

import {
    getConfigAddresses,
    generateRemark,
    isDomain,
    isHttps,
    parseHostPort,
    getProtocols
} from '@utils';

function buildBalancer(tag: string, selector: string, hasFallback: boolean): Balancer {
    return {
        tag,
        selector: [selector],
        strategy: {
            type: 'leastPing',
        },
        fallbackTag: hasFallback ? 'proxy-2' : undefined
    };
}

// ---------- پارامترهای نامی به‌جای ۱۱ آرگومان positional ----------
// خوانایی بالاتر + صفر ریسک جابه‌جایی آرگومان

interface BuildConfigOptions {
    remark: string;
    outbounds: Outbound[];
    isBalancer: boolean;
    isChain: boolean;
    balancerFallback: boolean;
    isWarp: boolean;
    isWorkerLess: boolean;
    outboundAddrs: string[];
    domainToStaticIPs?: string;
    customDns?: string;
    customDnsHosts?: string[];
}

async function buildConfig(options: BuildConfigOptions): Promise<Config> {
    const {
        remark,
        outbounds,
        isBalancer,
        isChain,
        balancerFallback,
        isWarp,
        isWorkerLess,
        outboundAddrs,
        domainToStaticIPs,
        customDns,
        customDnsHosts
    } = options;

    const {
        fakeDNS,
        warpBestPingInterval,
        bestPingInterval,
        logLevel,
        allowLANConnection
    } = getSettings();
    let balancers, observatory;

    if (isBalancer) {
        balancers = [buildBalancer('all-proxies', 'proxy', balancerFallback)]
            .concatIf(isChain, buildBalancer('all-chains', 'chain', false));

        observatory = {
            subjectSelector: isChain ? ['chain', 'proxy'] : ['proxy'],
            probeUrl: 'https://www.gstatic.com/generate_204',
            probeInterval: `${isWarp
                ? warpBestPingInterval
                : bestPingInterval}s`,
            enableConcurrency: true
        } satisfies Observatory;
    }

    const config: Config = {
        remarks: remark,
        version: {
            min: '26.2.6'
        },
        log: {
            loglevel: logLevel,
        },
        dns: await buildDNS(outboundAddrs, isWorkerLess, isWarp, domainToStaticIPs, customDns, customDnsHosts),
        inbounds: [
            buildMixedInbound(allowLANConnection, isWorkerLess, isWorkerLess || fakeDNS),
            buildDokodemoInbound(allowLANConnection),
            // buildTunInbound(isWorkerLess, fakeDNS)
        ],
        outbounds: [
            ...outbounds,
            {
                protocol: 'dns',
                settings: {
                    rules: [
                        {
                            action: 'hijack'
                        }
                    ]
                },
                tag: 'dns-out'
            },
            {
                protocol: 'freedom',
                settings: {
                    domainStrategy: 'UseIP'
                },
                tag: 'direct'
            },
            {
                protocol: 'blackhole',
                settings: {
                    response: {
                        type: 'http'
                    }
                },
                tag: 'block'
            },
        ],
        routing: {
            domainStrategy: 'IPIfNonMatch',
            rules: buildRoutingRules(isChain, isBalancer, isWorkerLess, isWarp),
            balancers
        },
        observatory,
        policy: {
            levels: {
                0: {
                    connIdle: 300,
                    handshake: 4,
                    uplinkOnly: 1,
                    downlinkOnly: 1
                }
            },
            system: {
                statsOutboundUplink: true,
                statsOutboundDownlink: true
            }
        },
        stats: {}
    };

    return config;
}

async function addBestPingConfigs(
    configs: Config[],
    totalAddresses: string[],
    proxyOutbounds: Outbound[],
    chainOutbounds: Outbound[],
    isFragment: boolean,
    isCustomDomain: boolean
) {
    const uniqueAddresses = [...new Set(totalAddresses)];
    const isChain = !!chainOutbounds.length;
    const chainSign = isChain ? '🔗 ' : '';
    const fragmentSign = isFragment ? 'F ' : '';
    const customDomainSign = isCustomDomain ? 'D ' : '';
    const configType = `${fragmentSign}${customDomainSign}`;

    const remark = `⚡ ${chainSign}Best Ping ${configType}🚀`;
    const outbounds = [
        ...chainOutbounds,
        ...proxyOutbounds
    ];

    const config = await buildConfig({
        remark,
        outbounds,
        isBalancer: true,
        isChain,
        balancerFallback: true,
        isWarp: false,
        isWorkerLess: false,
        outboundAddrs: uniqueAddresses
    });

    if (isChain) {
        await addBestPingConfigs(configs, uniqueAddresses, proxyOutbounds, [], isFragment, isCustomDomain);
    }

    configs.push(config);
}

async function addBestFragmentConfigs(
    configs: Config[],
    chainProxy?: Outbound
) {
    const { mainDomain, fragmentDelayMin, fragmentDelayMax } = getSettings();
    const isChain = !!chainProxy;
    const outbounds: Outbound[] = [];
    const bestFragValues = [
        '1-5', '1-10', '10-20', '20-30',
        '30-40', '40-50', '50-60', '60-70',
        '70-80', '80-90', '90-100', '10-30',
        '20-40', '30-50', '40-60', '50-70',
        '60-80', '70-90', '80-100', '100-200'
    ];

    bestFragValues.forEach((fragLength, index) => {
        if (isChain) {
            const chain = modifyOutbound(chainProxy, `chain-${index + 1}`, `proxy-${index + 1}`);
            outbounds.push(chain);
        }

        const proxy = buildWebsocketOutbound(
            `proxy-${index + 1}`,
            _VL_,
            mainDomain,
            443,
            mainDomain,
            true,
            fragLength,
            `${fragmentDelayMin}-${fragmentDelayMax}`
        );

        outbounds.push(proxy);
    });

    const chainSign = isChain ? '🔗 ' : '';
    const config = await buildConfig({
        remark: `⚡ ${chainSign}Smart Fragment 🧠`,
        outbounds,
        isBalancer: true,
        isChain,
        balancerFallback: false,
        isWarp: false,
        isWorkerLess: false,
        outboundAddrs: [],
        domainToStaticIPs: mainDomain
    });

    if (chainProxy) {
        await addBestFragmentConfigs(configs);
    }

    configs.push(config);
}

async function addWorkerlessConfigs(configs: Config[]) {
    const tlsFragment = buildFreedomOutbound(true, false, 'proxy');
    const udpNoise = buildFreedomOutbound(false, true, 'udp-noise');
    const httpFragment = buildFreedomOutbound(true, false, 'http-fragment', undefined, undefined, '1-1');
    const outbounds = [
        tlsFragment,
        httpFragment,
        udpNoise
    ];

    const cfDnsConfig = await buildConfig({
        remark: `⚡ 1 - Serverless 🌟`,
        outbounds,
        isBalancer: false,
        isChain: false,
        balancerFallback: false,
        isWarp: false,
        isWorkerLess: true,
        outboundAddrs: [],
        customDns: 'cloudflare-dns.com',
        customDnsHosts: ['cloudflare.com']
    });

    const googleDnsConfig = await buildConfig({
        remark: `⚡ 2 - Serverless 🌟`,
        outbounds,
        isBalancer: false,
        isChain: false,
        balancerFallback: false,
        isWarp: false,
        isWorkerLess: true,
        outboundAddrs: [],
        customDns: 'dns.google',
        customDnsHosts: ['8.8.8.8', '8.8.4.4']
    });

    configs.push(cfDnsConfig, googleDnsConfig);
}

export async function getXrCustomConfigs(isFragment: boolean): Promise<Response> {
    const {
        chainProxy,
        ports,
        mainDomain,
        customDomain,
        upstreamParams: { upstreamServer, upstreamPort }
    } = getSettings();

    const chainOutbound = chainProxy ? buildChainOutbound() : undefined;
    const domains = [...new Set([mainDomain].concatIf(!!customDomain, customDomain))];
    const protocols = getProtocols();

    const configs: Config[] = [];
    let index = 1;

    for (const domain of domains) {
        const proxies: Outbound[] = [];
        const chains: Outbound[] = [];
        const totalPorts = ports.filter(port => !isFragment && domain.endsWith('workers.dev') || isHttps(port));
        const hosts = await getConfigAddresses(domain, isFragment);
        const totalHosts: string[] = [...hosts];

        if (upstreamServer && upstreamPort && !isFragment) {
            totalPorts.unshift(upstreamPort);
            hosts.unshift(upstreamServer);
        }

        for (const protocol of protocols) {
            let protocolIndex = 1;

            for (const port of totalPorts) {
                for (const host of hosts) {
                    if ((port === upstreamPort) !== (host === upstreamServer)) continue;

                    const outbound = buildWebsocketOutbound('proxy', protocol, host, port, domain, isFragment);
                    const proxy = modifyOutbound(outbound, `proxy-${index}`);
                    proxies.push(proxy);

                    const remark = generateRemark(protocolIndex, port, host, protocol, domain, isFragment, false);
                    const config = await buildConfig({
                        remark,
                        outbounds: [outbound],
                        isBalancer: false,
                        isChain: false,
                        balancerFallback: false,
                        isWarp: false,
                        isWorkerLess: false,
                        outboundAddrs: [host]
                    });
                    configs.push(config);

                    if (chainOutbound) {
                        const chainRemark = generateRemark(protocolIndex, port, host, protocol, domain, isFragment, true);
                        const chainConfig = await buildConfig({
                            remark: chainRemark,
                            outbounds: [chainOutbound, outbound],
                            isBalancer: false,
                            isChain: true,
                            balancerFallback: false,
                            isWarp: false,
                            isWorkerLess: false,
                            outboundAddrs: [host]
                        });
                        configs.push(chainConfig);

                        const chain = modifyOutbound(chainOutbound, `chain-${index}`, `proxy-${index}`);
                        chains.push(chain);
                    }

                    protocolIndex++;
                    index++;
                }
            }
        }

        const isCustomDomain = domain === customDomain && domain !== mainDomain;
        await addBestPingConfigs(configs, totalHosts, proxies, chains, isFragment, isCustomDomain);
    }

    if (isFragment) {
        await addBestFragmentConfigs(configs, chainOutbound);
        await addWorkerlessConfigs(configs);
    }

    const fileName = isFragment ? 'fragment' : 'normal';
    return buildConfigsResponse(configs, `${_project_SM_}-${fileName}-xray.json`);
}

export async function getXrWarpConfigs(
    isPro: boolean,
    isKnocker: boolean
): Promise<Response> {
    const { warpEndpoints } = getSettings();
    const warpAccounts = getWarpAccounts();

    const proIndicator = isPro ? ' Pro ' : ' ';
    const configs: Config[] = [];
    const proxies: Outbound[] = [];
    const chains: Outbound[] = [];
    const outboundDomains: string[] = [];

    for (const [index, endpoint] of warpEndpoints.entries()) {
        const { host } = parseHostPort(endpoint);
        if (isDomain(host)) outboundDomains.push(host);

        const warpOutbound = buildWarpOutbound(warpAccounts[0], endpoint, false, isPro, isKnocker);
        const wowOutbound = buildWarpOutbound(warpAccounts[1], endpoint, true, isPro, isKnocker);

        const warpConfig = await buildConfig({
            remark: `⚡ ${index + 1} - Warp${proIndicator}🇮🇷`,
            outbounds: [warpOutbound],
            isBalancer: false,
            isChain: false,
            balancerFallback: false,
            isWarp: true,
            isWorkerLess: false,
            outboundAddrs: [host]
        });

        const wowConfig = await buildConfig({
            remark: `⚡ ${index + 1} - WoW${proIndicator}🌍`,
            outbounds: [wowOutbound, warpOutbound],
            isBalancer: false,
            isChain: true,
            balancerFallback: false,
            isWarp: true,
            isWorkerLess: false,
            outboundAddrs: [host]
        });

        configs.push(warpConfig, wowConfig);

        const proxy = modifyOutbound(warpOutbound, `proxy-${index + 1}`);
        proxies.push(proxy);

        const chain = modifyOutbound(wowOutbound, `chain-${index + 1}`, `proxy-${index + 1}`);
        chains.push(chain);
    }

    const warpBestPing = await buildConfig({
        remark: `⚡ Warp${proIndicator}- Best Ping 🚀`,
        outbounds: [...proxies],
        isBalancer: true,
        isChain: false,
        balancerFallback: false,
        isWarp: true,
        isWorkerLess: false,
        outboundAddrs: outboundDomains
    });

    const wowBestPing = await buildConfig({
        remark: `⚡ WoW${proIndicator}- Best Ping 🚀`,
        outbounds: [...chains, ...proxies],
        isBalancer: true,
        isChain: true,
        balancerFallback: false,
        isWarp: true,
        isWorkerLess: false,
        outboundAddrs: outboundDomains
    });

    configs.push(warpBestPing, wowBestPing);

    const fileName = isPro ? 'warp-Pro' : 'warp';
    return buildConfigsResponse(configs, `${_project_SM_}-${fileName}-xray.json`);
}

// ---------- Response builder مشترک ----------
// minified JSON — کانفیگ‌ها ~۷۵٪ کوچیک‌تر از pretty-print با تورفتگی ۴
// کلاینت‌های Xray JSON فشرده رو کاملاً قبول می‌کنن

function buildConfigsResponse(configs: Config[], fileName: string): Response {
    return new Response(JSON.stringify(configs), {
        status: 200,
        headers: {
            'Content-Type': 'application/json',
            'Content-Disposition': `attachment; filename=${fileName}`,
            'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
            'Pragma': 'no-cache',
            'Expires': '0'
        }
    });
}

function modifyOutbound(outbound: Outbound, tag: string, dialerProxy?: string): Outbound {
    const newOutbound = structuredClone(outbound);
    newOutbound.tag = tag;

    if (dialerProxy && newOutbound.streamSettings?.sockopt) {
        newOutbound.streamSettings.sockopt.dialerProxy = dialerProxy;
    }

    return newOutbound;
}
