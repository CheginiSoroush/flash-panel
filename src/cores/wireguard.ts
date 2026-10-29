import { HttpStatus, respond, safeError } from '@common';
import { getSettings, getWarpAccounts } from '@settings';
import { MiniZip } from './mini-zip';

export async function getWireguardConfigs(isPro: boolean): Promise<Response> {
    try {
        const { warpIPv6, publicKey, privateKey } = getWarpAccounts()[0];
        const {
            warpEndpoints,
            warpRemoteDNS,
            amneziaNoiseCount,
            amneziaNoiseSizeMin,
            amneziaNoiseSizeMax
        } = getSettings();

        const zip = new MiniZip();

        warpEndpoints?.forEach((endpoint, index) => {
            const conf = [
                '[Interface]',
                `PrivateKey = ${privateKey}`,
                `Address = 172.16.0.2/32, ${warpIPv6}`,
                `DNS = ${warpRemoteDNS}`,
                'MTU = 1280',
                ...(isPro ? [
                    `Jc = ${amneziaNoiseCount}`,
                    `Jmin = ${amneziaNoiseSizeMin}`,
                    `Jmax = ${amneziaNoiseSizeMax}`,
                    'S1 = 0',
                    'S2 = 0',
                    'H1 = 1',
                    'H2 = 2',
                    'H3 = 3',
                    'H4 = 4'
                ] : []),
                '',
                '[Peer]',
                `PublicKey = ${publicKey}`,
                'AllowedIPs = 0.0.0.0/0, ::/0',
                `Endpoint = ${endpoint}`,
                'PersistentKeepalive = 25'
            ].join('\n');

            zip.add(`${_project_}-Warp-${index + 1}.conf`, conf);
        });

        // ZIP فقط-STORE با MiniZip — بدون jszip (~۹۵KB سبک‌تر، بهینه‌سازی v0.8.16)
        const zipBytes = zip.build();

        const fileName = isPro ? 'pro-amnezia' : 'wireguard';
        return new Response(zipBytes, {
            headers: {
                'Content-Type': 'application/zip',
                'Content-Disposition': `attachment; filename=${_project_SM_}-warp-${fileName}-conf.zip`,
                'Cache-Control': 'no-store, no-cache, must-revalidate',
                'Pragma': 'no-cache'
            },
        });
    } catch (error) {
        return respond(false, HttpStatus.INTERNAL_SERVER_ERROR, `Error generating ZIP file: ${safeError(error)}`);
    }
}