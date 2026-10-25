# :material-fingerprint:{ .md .middle } Supported Clients

Here you can find the minimum requirements for a proper connection with Flash Panel and download the latest version of each client. The same catalog is built into the Telegram bot (`/clients`), which also decodes the download link for you.

## Client catalog

These are the clients the panel tracks with a minimum version and an official download source:

| Client | Platform | Minimum version | Download |
| --- | --- | --- | --- |
| v2rayNG | Android | 2.2.3 | [GitHub releases](https://github.com/2dust/v2rayNG/releases/latest) |
| v2rayN | Windows | 7.22.5 | [GitHub releases](https://github.com/2dust/v2rayN/releases/latest) |
| MahsaNG | Android | 17 | [Google Play](https://play.google.com/store/apps/details?id=com.MahsaNet.MahsaNG&hl=en) |
| Streisand | iOS | 1.6.71 | [App Store](https://apps.apple.com/us/app/streisand/id6450534064) |
| sing-box | All platforms | 1.12.0 | [GitHub releases](https://github.com/SagerNet/sing-box/releases/latest) |
| husi | Android | 1.3.2 | [Codeberg releases](https://codeberg.org/xchacha20-poly1305/husi/releases/latest) |
| NekoBox | Android | 1.3.2 | [GitHub releases](https://github.com/MatsuriDayo/NekoBoxForAndroid/releases/latest) |
| Clash Meta | Android | 2.11.31 | [GitHub releases](https://github.com/MetaCubeX/ClashMetaForAndroid/releases/latest) |
| Clash Verge Rev | Windows / macOS / Linux | 2.5.1 | [GitHub releases](https://github.com/clash-verge-rev/clash-verge-rev/releases/latest) |
| FlClash | Windows / macOS / Linux / Android | 0.8.94 | [GitHub releases](https://github.com/chen08209/FlClash/releases/latest) |
| Stash | iOS | 3.4.1 | [App Store](https://apps.apple.com/us/app/stash-rules-based-proxy/id1596063349) |
| Amnezia | All platforms | 4.8.21.0 | [GitHub releases](https://github.com/amnezia-vpn/amnezia-client/releases/latest) |
| WireGuard | All platforms | Stable | [Official website](https://www.wireguard.com/install/) |
| WG Tunnel | Android | 5.1.0 | [GitHub releases](https://github.com/ggTunnel/android/releases/latest) |

!!! note
    There are other clients which perform very well and are listed in some subscriptions (e.g. Shadowrocket, Hiddify, Karing, PassWall), however they are not listed here due to lack of continuous development or incompatibility with standard cores' configuration formats.

## Subscription formats per client

Every subscription is served at `https://<domain>/<securePath>/sub/<type>` and picks its output format from the `app` parameter:

| `app` value | Format served | Fits |
| --- | --- | --- |
| `xray` | Xray JSON | v2rayNG, v2rayN, MahsaNG, Streisand, Shadowrocket, PassWall |
| `sing-box` | sing-box JSON | sing-box, husi, NekoBox, Hiddify, Karing |
| `clash` | Clash (Mihomo) YAML | Clash Meta, Clash Verge Rev, FlClash, Stash |
| `xray-knocker` | Xray + UDP noise (Warp Pro) | MahsaNG, v2rayN-PRO |
| `wireguard` / `amnezia` | WireGuard configs | WireGuard, WG Tunnel, Amnezia |

Examples: `.../sub/normal?app=clash` or `.../sub/fragment?app=sing-box`. For convenience the panel also accepts legacy client names (`v2rayng`, `hiddify`, `nekobox`, `clash meta`, `mihomo`, `stash`, ...), and when `app` is missing it falls back to the request's `User-Agent`; unknown values default to the `xray` format. The **Raw** subscription is the exception: it is a base64 list of share URIs (`vless://`, `trojan://`, ...) that URI-based clients import directly.

## Recommendations per platform

| Platform | First choice | Format | Alternatives |
| --- | --- | --- | --- |
| Windows | v2rayN | `xray` | Clash Verge Rev, FlClash (`clash`) |
| macOS | Clash Verge Rev | `clash` | FlClash, sing-box (`sing-box`) |
| Linux | Clash Verge Rev | `clash` | FlClash, sing-box (`sing-box`) |
| Android | v2rayNG | `xray` | MahsaNG, NekoBox, husi (`sing-box`), Clash Meta (`clash`) |
| iOS | Streisand | `xray` | Stash (`clash`), Shadowrocket, Karing |

!!! tip "ECH requires recent cores"
    If you enable [ECH](../configuration/vless-trojan.md#ech-encrypted-client-hello), note that sing-box supports it from 1.13.0 and Clash (Mihomo) from 1.19.20 — older clients ignore it, so leave the ECH server name empty if your clients do not meet these versions.

## Link handling

- The Telegram bot and the panel QR page generate QR codes and ready-to-import files per core; sing-box entries use the `sing-box://import-remote-profile` deep link.
- Subscription responses carry `Profile-Update-Interval: 3` and `subscription-userinfo` headers, which mainstream clients (v2rayNG, Streisand, Hiddify) use for auto-update and expiry display.
- Personal per-user links look like `/<securePath>/sub/<userId>/<type>` and stop working (401) when the user is revoked.
