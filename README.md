<div align="center">

# ⚡ Flash Panel

### A high-performance, serverless proxy panel for Cloudflare Workers

**VLESS · Trojan · WARP** — built for speed, hardened for real-world use

[🇮🇷 فارسی](README_fa.md) · [🪄 Quick Deploy](https://flash-wizard.cheginisoroush6.workers.dev/)

![Cloudflare Workers](https://img.shields.io/badge/Platform-Cloudflare%20Workers-F38020?style=flat-square&logo=cloudflare)
![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=flat-square&logo=typescript&logoColor=white)
![Tests](https://img.shields.io/badge/Tests-22%20passing-34d399?style=flat-square)
![License](https://img.shields.io/badge/License-GPL--3.0-blue?style=flat-square)
![Size](https://img.shields.io/badge/Bundle-176KB%20gzipped-9333ea?style=flat-square)

</div>

---

<div align="center">

### 📊 Benchmark — vs "optimized" BPB fork

*Same settings, same IPs, same ports — side by side*

| | Flash Panel | Other fork |
|---|:---:|:---:|
| Working configs | **72 / 85** ✅ | 59 / 85 |
| Lowest ping | **Flash** ✅ | — |

**+22% more working configs** — measured, not claimed.

</div>

---

## ✨ Why Flash?

Most BPB forks change the **brand**. Flash Panel rebuilt the **engine**:

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

### 🤖 Telegram Bot — full panel control

The panel URL is often filtered. Your Telegram isn't.

```
/config    — get configs + QR codes
/status    — live panel overview
/settings  — 18 editable fields (DNS, protocols, clean IPs, routing rules...)
/restart   — instant cache reset
```

### 🧪 Engineering — built like production software

- **22 unit tests** on protocol parsers (VLESS/Trojan header edge cases)
- **CI on every push** — check, test, build
- **Automated releases** — tag → build → publish
- **Self-update from panel** — zero-downtime upgrades

---

## 🚀 Deploy

### 🪄 Flash Wizard — 60 seconds, no CLI

**[→ Deploy now](https://flash-wizard.cheginisoroush6.workers.dev/)**

> ⚠️ **Use a custom domain.** Scanners continuously probe `*.workers.dev` and file automated abuse reports — accounts have been suspended this way. A $3/year domain on a Cloudflare zone keeps you off the radar.

### Manual

```bash
npm install
cp wrangler.jsonc.example wrangler.jsonc
cp deploy/settings.example.js deploy/settings.js
# fill in your settings, then:
npm run check && npm run test && npm run build
npx wrangler deploy
```

---

## 📖 Documentation

- 🇮🇷 [مستندات فارسی](README_fa.md)
- 🪄 [Flash Wizard](https://github.com/CheginiSoroush/flash-wizard) — deploy tool

## 🙏 Credits

Flash Panel is a hard fork of [BPB-Worker-Panel](https://github.com/bia-pain-bache/BPB-Worker-Panel) — massive thanks to [bia-pain-bache](https://github.com/bia-pain-bache) and the BPB community for the foundation.

**License:** GPL-3.0 — see [LICENSE](LICENSE)

<div align="center">

---

**⚡ Flash Panel** — *fast because it's engineered to be.*

</div>
