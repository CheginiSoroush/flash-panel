<div align="center">
  <h1>⚡ Flash Panel</h1>
  <p><strong>A high-performance, serverless proxy management panel powered by Cloudflare Workers.</strong></p>
  <p><a href="README_fa.md">🇮🇷 فارسی</a></p>
  <p>
    <img src="https://img.shields.io/badge/Platform-Cloudflare%20Workers-F38020?style=flat-square&logo=cloudflare" alt="Workers">
    <img src="https://img.shields.io/badge/TypeScript-007ACC?style=flat-square&logo=typescript&logoColor=white" alt="TS">
    <img src="https://img.shields.io/badge/License-GPL--3.0-blue?style=flat-square" alt="License">
  </p>
</div>

---

Flash Panel transforms your Cloudflare Workers into a robust, easily manageable proxy server. Say goodbye to expensive VPS hosting and embrace the serverless revolution with advanced routing, multiple core support, and Telegram bot integration.

> Hard fork of [BPB-Worker-Panel](https://github.com/bia-pain-bache/BPB-Worker-Panel) with performance optimizations, bug fixes, and security hardening.

## ✨ Key Features

* **☁️ 100% Serverless** — zero maintenance costs
* **🛡️ VLESS + Trojan** — modern protocol support
* **📦 Xray, Sing-box, Clash** — universal core compatibility
* **🤖 Telegram Bot** — manage everything from chat
* **🔀 Advanced Routing** — WARP, Fragment, DoH
* **🌍 Proxy IPs** — external IP integration

## 🚀 Quick Deployment

### 🪄 Flash Wizard (recommended)

Deploy in 60 seconds with **[Flash Wizard](https://flash-wizard.imsoroush.workers.dev/)** — no CLI needed.

> ⚠️ **Use a custom domain.** Deploying on `*.workers.dev` risks automated abuse reports and account suspension.

### Manual

```bash
npm install
cp wrangler.jsonc.example wrangler.jsonc
cp deploy/settings.example.js deploy/settings.js
npm run check && npm run test && npm run build
npx wrangler deploy
```

## 📖 Credits & License

- **Original:** [BPB-Worker-Panel](https://github.com/bia-pain-bache/BPB-Worker-Panel) by [bia-pain-bache](https://github.com/bia-pain-bache)
- **License:** GPL-3.0 — [LICENSE](LICENSE)
- **Wizard:** [Flash Wizard](https://github.com/CheginiSoroush/flash-wizard)
