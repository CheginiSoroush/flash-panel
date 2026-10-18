<div align="center">

# ⚡ Flash Panel

### A high-performance, serverless proxy panel for Cloudflare Workers

**VLESS · Trojan · WARP** — built for speed, hardened for real-world use

[🇮🇷 فارسی](README_fa.md) · [🪄 Quick Deploy](https://github.com/CheginiSoroush/flash-wizard)

![Cloudflare Workers](https://img.shields.io/badge/Platform-Cloudflare%20Workers-F38020?style=flat-square&logo=cloudflare)
![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=flat-square&logo=typescript&logoColor=white)
![Tests](https://img.shields.io/badge/Tests-295%20passing-34d399?style=flat-square)
![License](https://img.shields.io/badge/License-GPL--3.0-blue?style=flat-square)
![Size](https://img.shields.io/badge/Bundle-130.4KB%20gzipped-9333ea?style=flat-square)

</div>

---

<div align="center">

### 📊 Benchmark — vs "optimized" forks

*Same settings, same IPs, same ports — side by side*

| | Flash Panel | Other fork |
|---|:---:|:---:|
| Working configs | **72 / 85** ✅ | 59 / 85 |
| Lowest ping | **Flash** ✅ | — |

**+22% more working configs** — measured, not claimed.

</div>

---

## ✨ Why Flash?

Most forks change the **brand**. Flash Panel rebuilt the **engine**:

### 🔥 Protocol Core — rewritten from scratch

| Fix | Impact |
|-----|--------|
| Race condition on socket writer | Connections dying mid-handshake → eliminated |
| SHA-224 recomputed **every connection** | Now cached — Trojan auth costs ~zero |
| Copy-heavy VLESS parsing (10× `slice()`) | Zero-copy views — CPU per connection dropped |
| Writer lock acquired per-chunk | Cached per-socket — sustained throughput |
| KV read on **every request** | Isolate-level cache + 5s TTL + anti-stampede |
| Subscription regeneration on every fetch | ETag/304 — configs served instantly when unchanged |
| Pretty-printed JSON configs (~20MB) | Minified — **94% smaller subscriptions** |

### 🛡️ Security — not an afterthought

- 🔐 **Login rate-limiting** + constant-time credential comparison
- 🤖 **Telegram webhook secret validation** — forged updates rejected
- 🔒 Login page / settings / subscriptions fully separated
- ⚡ `workers.dev` route **auto-disabled** — scanner-proof by design

### ⚙️ Automation — the panel runs itself

Set the cron trigger once (`'0 * * * *'` in `wrangler.jsonc`) and the panel takes care of the rest:

- ⏰ **Auto-expiry for subscription users** — give any user an expiry date; their links stop the second it passes (self-enforcing at resolve time, no cron needed), the hourly sweep marks them revoked in the panel, and you get a Telegram notification
- 📋 **Daily digest** — one message per day: usage vs quota, active/expired/revoked counts, next expirations, top users (also on demand: `/digest`)
- 🔴 **Usage alert** — a one-time warning when total requests cross 80% of the daily Free quota
- 📊 **Usage sampling without visits** — the 31-day chart stays complete even on days nobody opens the panel
- ⚡ **Auto best ProxyIP** — one click tests every configured Proxy IP (batched, 2 attempts each) and redeploys the worker with the fastest healthy one as primary

### ⚡ Performance — less CPU, less data

v0.6.0 is a pure efficiency release — the worker does less work per request and subscription updates shrink dramatically:

- 🧠 **Per-ETag subscription body cache** — generated configs (Xray JSON / Clash YAML / raw base64) are memoized inside the isolate keyed by their ETag, which already covers version + all settings + client + user. Repeat fetches within the 5-minute TTL skip config generation *entirely* — no DNS resolve, no JSON building, no btoa — near-zero CPU for the most-hit endpoint
- 🗜️ **gzip subscription responses** — bodies ≥ 1 KB are compressed with the native `CompressionStream` when the client sends `Accept-Encoding: gzip` (v2rayNG, Hiddify, Streisand and friends all do). Config JSON/YAML compresses ~70–80% — directly less mobile data burned on every update, and `Vary: Accept-Encoding` keeps variants from mixing
- 🖼️ **QR memoization** — the QR PNG encoder (RGBA loop + deflate) runs once per unique config link; the panel's QR modal re-opens now cost zero CPU. Browser cache headers (`max-age=3600`) prevent re-fetching altogether
- 🔧 **Micro-hygiene** — module-level `TextEncoder` for ETag hashing, header snapshots stored with the cache instead of per-request rebuilds

All of it is memory-bounded (LRU + size caps) and fully covered by 14 new unit tests — **266/266 green**.

### 🧭 Anti-403 — configs that just connect

A `403` means your connect address (usually `workers.dev`) is blocked by your ISP. Flash Panel now fights back automatically:

- 🧪 **Clean IP optimizer** (`/clean-ip` page) — one click **Auto-optimize**: discovers fresh candidate IPs from public aggregators, probes every configured Clean IP + candidate (TCP edge probe, 2 attempts), reorders the list **healthy-first, fastest on top**, adds up to 5 newly found healthy IPs and redeploys — the whole loop without touching the settings form
- 🥇 **Clean IPs First (Anti-403)** — new setting: when enabled, Clean IPs become the *first* connect address in every generated config instead of the (often-blocked) worker domain
- 🩺 **Per-endpoint health & latency** — every row shows success rate and TCP latency, so dead endpoints are visible at a glance
- 📰 **Smart subscription headers** — `profile-update-interval`, `profile-web-page-url` and `subscription-userinfo` (auto expiry countdown for subscription users) are served to modern clients (Hiddify, v2rayNG, Streisand)

### ✈️ Telegram — first-class through the tunnel

No, a classic MTProto proxy can't run on Cloudflare Workers (Telegram apps connect to MTProto proxies over raw TCP — Workers only accept HTTP/WebSocket). Your subscription already tunnels Telegram the reliable way:

- 🧲 **Telegram Routing (Always Tunnel)** — new setting (on by default): explicit rules in every generated config (Xray / sing-box / Clash) route Telegram's official domains **and all 13 datacenter CIDRs** (IPv4 + IPv6) through the tunnel — before any block/bypass rule, so even `bypass Iran/China` profiles can never send Telegram direct
- 🧾 **Geo-file independent** — rules are plain domain/IP lists baked into the config: no geosite download needed, works on old client geo databases
- 🤖 **`/tg` bot command** — step-by-step Telegram setup guide (v2rayNG / Hiddify / Streisand) straight from the bot
- 📞 **Honest voice-call note** — normal configs carry messages, media and files (TCP); for voice/video calls use the **Warp** subscription type (UDP)

### 🤖 Telegram Bot — full panel control

The panel URL is often filtered. Your Telegram isn't.

```
/config    — get configs + QR codes
/status    — live panel overview
/tg        — Telegram setup guide
/users     — per-user stats + expiry countdowns
/digest    — daily summary on demand
/settings  — 18 editable fields (DNS, protocols, clean IPs, routing rules...)
/restart   — instant cache reset
```

### 🧪 Engineering — built like production software

- **295 unit tests** — protocol parsers, settings validators, KV migrations, sub-users, update engine
- **CI on every push** — check, test, build
- **Automated releases** — tag → build → publish
- **Self-update from panel** — zero-downtime upgrades, now with a 3-mirror engine

### 🔄 Panel self-update — built to survive GitHub 403s

The one-click **Update panel** button fetches the latest `worker.js` and redeploys it with your settings intact. Server-side downloads of GitHub release assets used to fail from shared Cloudflare edge IPs (`403`/`429` rate limits) — the update engine now:

- **3 mirrors with automatic fallback** — GitHub Releases → GitHub Pages mirror (`site/download/worker.js`, republished on every release) → jsDelivr CDN
- **Retries with backoff** on `403`/`429`/`5xx`/timeouts; `404` short-circuits to the next mirror
- **Content validation** — an HTML error page or truncated body is never deployed (length + `export default` checks)
- **10-minute edge cache + request coalescing** — repeated clicks cost zero extra fetches
- **Honest errors** — the panel toast now shows the real reason (GitHub 403 / token permission / quota) instead of a blind *"please try again"*
- **Client-side version check fallback** — `raw.githubusercontent.com` first, jsDelivr second

> 💡 If your panel is older than **v0.7.1** and the update button fails, retry in a few minutes (the 403 is transient) or upload `worker.js` manually via the Cloudflare dashboard / Flash Wizard — after that, every future update uses the mirror engine.

---

## 🚀 Deploy

### 🪄 Flash Wizard — 60 seconds, no CLI

**[→ Get Flash Wizard — deploy it yourself](https://github.com/CheginiSoroush/flash-wizard)**

> ⚠️ **Never publish your live panel URL.** Scanners continuously probe `*.workers.dev` and file automated abuse reports — accounts have been suspended this way. A $3/year domain on a Cloudflare zone keeps you off the radar. Keep the wizard's workers.dev name private (it is only used once, during setup).

### Manual

```bash
npm install
cp wrangler.jsonc.example wrangler.jsonc
# edit wrangler.jsonc: account_id + KV namespace id, then build & deploy:
npm run check && npm run test && npm run build
npx wrangler deploy
```

Credentials (`EMBEDED_SETTINGS`) are injected at deploy time by **Flash Wizard**. For a fully manual deploy, prepend this block to `dist/worker.js` (replace the values with yours):

```js
Object.assign(globalThis, { EMBEDED_SETTINGS: {
    accID: "<account id>", accEmail: "<account email>", apiToken: "<scoped api token>",
    vlUUID: "<uuid>", trPass: "<trojan password>", securePath: "<secret path>",
    proxyIpMode: "proxyip", proxyIPs: [], prefixes: [],
    mainDomain: "<your domain>", fallback: "www.speedtest.net", dohUrl: ""
}});
```

> The wizard handles all of this automatically — manual mode is for CI pipelines and edge cases.

---

## 📖 Documentation

- 🇮🇷 [مستندات فارسی](README_fa.md)
- 🪄 [Flash Wizard](https://github.com/CheginiSoroush/flash-wizard) — deploy tool

## 👤 Author

Flash Panel is created, owned and maintained by [CheginiSoroush](https://github.com/CheginiSoroush).

**License:** GPL-3.0 — see [LICENSE](LICENSE)

<div align="center">

---

**⚡ Flash Panel** — *fast because it's engineered to be.*

</div>
