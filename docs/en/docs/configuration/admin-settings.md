# :material-cog-outline:{ .md .middle } Admin settings

The **Admin** card is the control room of the panel. It contains the panel lifecycle actions (reset password, update, delete) and every setting the admin can change. All settings below are stored in KV and take effect as soon as you press **Apply Settings**.

!!! info
    You must update your subscriptions after making any changes.

## Panel lifecycle

| Action | What it does |
| --- | --- |
| Reset Password | Sets a new password for the panel login page. |
| Update Panel | Updates Flash Panel to the latest stable version. The button activates as soon as a new version is available. |
| Delete Panel | Removes the Worker (and its panel) from your Cloudflare account permanently. |
| Reset Settings | Small button next to **Apply Settings** — resets every setting to factory defaults. |

!!! warning "Panel update and usage need a Cloudflare API token"
    Since v0.8.12 Flash Panel follows a **no-credentials-in-source** policy: the deployed Worker source contains no secrets. The Cloudflare API token used by **panel self-update** and **usage monitoring** lives in Workers KV under the key `cfApiToken` and must be set through the Telegram bot with the [`/cftoken` command](telegram-bot.md#cftoken-command). Without it, those features report *not configured* instead of failing with an obscure error.

!!! note "workers.dev is permanently disabled"
    The panel must be served through a custom domain route (Workers Route + DNS record on your zone). The `*.workers.dev` subdomain is disabled permanently by policy, so Telegram webhooks and subscription links always use your custom domain.

## Settings reference

### Access and identity

| Field | Type / choices | Default | Effect |
| --- | --- | --- | --- |
| `vlUUID` | UUID | generated at deploy | User ID of all VLESS configs. |
| `trPass` | Password (`A-Z a-z 0-9 !@$&*_-+;:,.`) | generated at deploy | Password of all Trojan configs. |
| `securePath` | Secret path (`A-Z a-z 0-9 !@$&*_-+;:,.`) | generated at deploy | Secret segment for every endpoint: `/panel`, `/login`, `/sub`, `/dns-query`, ... |
| `customDomain` | Domain | *(empty)* | Extra domain merged into the configs alongside the main domain. |
| `proxyIpMode` | `proxyip` or `prefix` | `proxyip` | How Cloudflare-bound traffic is relayed: Proxy IPs or NAT64 prefixes. |
| `proxyIPs` | IPs / domains (one per line) | deploy-time list | Worker-to-Cloudflare relay addresses. |
| `prefixes` | IPv6 NAT64 prefixes (one per line) | deploy-time list | Used when `proxyIpMode` is `prefix`. |
| `fallback` | Domain | *(empty)* | Domain served to non-proxy traffic. |

!!! warning "Changing identity fields invalidates every link"
    Changing `securePath`, `vlUUID` or `trPass` through the panel rewrites the panel path, subscription URLs and all config credentials. Existing clients keep working with the old values only until they re-subscribe — send everyone the new subscription link and update every client.

### Ports and protocols

| Field | Type / choices | Default | Effect |
| --- | --- | --- | --- |
| `protocols` | `vless`, `trojan` (comma separated) | `vless,trojan` | Which protocols appear in the subscriptions. |
| `ports` | Port list | `443` | Ports used by generated configs. At least one TLS port is required. |
| `fingerprint` | `chrome`, `firefox`, `safari`, `ios`, `android`, `edge`, `360`, `qq`, `random`, `randomized` | `chrome` | uTLS fingerprint of TLS configs. |
| `enableTFO` | Boolean | off | TCP Fast Open in generated configs. |
| `bestPingInterval` | Number (seconds) | `30` | Re-test interval of the *Best* configs. |

### Fragment and ECH

| Field | Type / choices | Default | Effect |
| --- | --- | --- | --- |
| `fragmentMode` | `custom`, `low`, `medium`, `high` | `custom` | Fragment preset; `custom` uses the fields below. |
| `fragmentPackets` | `tlshello`, `1-1`, `1-2`, `1-3`, `1-5` | `tlshello` | Which packets get fragmented. |
| `fragmentLengthMin` / `Max` | Number | `100` / `200` | Fragment size range. |
| `fragmentDelayMin` / `Max` | Number | `1` / `1` | Fragment delay range (ms). |
| `fragmentMaxSplitMin` / `Max` | Number | `0` / `0` | Advanced split limit (Xray). |
| `enableECH` | Boolean | off | Encrypted Client Hello in Xray configs. |
| `echServerName` | Domain | *(empty)* | ECH config source domain; empty = your worker domain. |

### Clean IPs and Custom CDN

| Field | Type / choices | Default | Effect |
| --- | --- | --- | --- |
| `cleanIPs` | IPs / domains (one per line) | `www.speedtest.net` | Clean addresses merged into the configs. |
| `cleanIPsFirst` | Boolean | off | Prioritize Clean IPs to counter 403 responses. |
| `customCdnAddrs` | IPs / domains (one per line) | *(empty)* | Addresses of a non-Cloudflare CDN (Fastly, Gcore, ...). |
| `customCdnHost` | Domain | *(empty)* | CDN host header pointing to your Worker. |
| `customCdnSni` | Domain | *(empty)* | SNI used on the custom CDN. All three fields must be filled or empty together. |

### DNS

| Field | Type / choices | Default | Effect |
| --- | --- | --- | --- |
| `localDNS` | IPv4 or `localhost` | `8.8.8.8` | Direct (local) DNS of the clients. |
| `remoteDNS` | DoH / DoT / TCP URL | `https://8.8.8.8/dns-query` | DNS used through the tunnel. Cloudflare DNS is rejected here. |
| `antiSanctionDNS` | IP or domain | `178.22.122.100` | DNS resolving sanction-bypass domains. |
| `customBypassSanctionRules` | Domains (one per line) | *(empty)* | Domains forced through `antiSanctionDNS`. |
| `dohUrl` | `https://.../dns-query` | `https://cloudflare-dns.com/dns-query` | Upstream resolver behind the panel's own [DoH endpoint](../usage/doh.md). |
| `fakeDNS` | Boolean | off | Fake-DNS in generated configs. |
| `enableIPv6` | Boolean | off | Prefer/allow IPv6 addresses in configs. |
| `allowLANConnection` | Boolean | off | Keep LAN access allowed in client configs. |
| `logLevel` | `none`, `warning`, `error`, `info`, `debug` | `warning` | Log level of the generated core configs. |

### Routing toggles and rules

| Field | Type / choices | Default | Effect |
| --- | --- | --- | --- |
| `telegramProxy` | Boolean | on | Telegram always routed through the tunnel. |
| `bypassIran`, `bypassChina`, `bypassRussia`, `bypassOpenAi`, `bypassGoogleAi`, `bypassMicrosoft`, `bypassOracle`, `bypassDocker`, `bypassAdobe`, `bypassEpicGames`, `bypassIntel`, `bypassAmd`, `bypassNvidia`, `bypassAsus`, `bypassHp`, `bypassLenovo` | Boolean | off | Route the matching country/service directly instead of through the tunnel. |
| `blockAds`, `blockPorn`, `blockUDP443`, `blockMalware`, `blockPhishing`, `blockCryptominers` | Boolean | off | Block the matching traffic category. |
| `customBypassRules` | Domains / IP CIDRs (one per line) | *(empty)* | Custom direct-routing rules. |
| `customBlockRules` | Domains / IP CIDRs (one per line) | *(empty)* | Custom block rules. |

### Chain, upstream and misc

| Field | Type / choices | Default | Effect |
| --- | --- | --- | --- |
| `chainProxy` | Share URI (vless/vmess/trojan/ss/socks/http) | *(empty)* | Fixed exit IP chained after the worker. |
| `upstreamProxy` | `IP:Port` / `Domain:Port` | *(empty)* | TCP upstream proxy (e.g. SNI spoofing) for Normal/Raw. |
| `wsGuardianEnabled` | Boolean | off | Actively close zombie WebSocket connections on mobile networks. |
| `wsGuardianIdleSec` | 30–3600 seconds | `300` | Two-way idle threshold of the WS Guardian. |
| `customSubs` / `customConfigs` | URLs / raw config lines | *(empty)* | External configs merged into the [Raw subscription](external-configs.md). |
| `remoteSettings` | Flash share-settings URL | *(empty)* | Import a shared settings blob from another Flash panel. |

!!! tip
    Validation runs on every apply: minimums cannot exceed maximums, at least one TLS port must stay selected, Cloudflare DNS is rejected as Remote DNS, and each list field expects one value per line.
