# ⚡ Flash Panel

A fast, optimized Cloudflare Workers panel for **VLESS**, **Trojan** and **Warp** — built for personal use, hardened for performance and security.

> Flash Panel is a hard fork of [BPB-Worker-Panel](https://github.com/bia-pain-bache/BPB-Worker-Panel) with major performance optimizations, bug fixes and security hardening.

## Highlights

- **Fast** — cached socket writer, zero-copy parsing, isolate-level caches
- **Secure** — login rate-limiting, constant-time credential checks, Telegram webhook secret validation
- **Tested** — unit tests on protocol parsers, CI on every push
- **Small** — about 172 KB gzipped

## 🪄 Quick Install

Deploy your own panel in 60 seconds with **[Flash Wizard](https://flash-wizard.imsoroush.workers.dev)** — no CLI needed.

## Build

Requires Node.js 22+. Run npm install, then npm run check, npm run test and npm run build. Deploy the built worker with your EMBEDED_SETTINGS injected.

## Credits & License

- Original project: [BPB-Worker-Panel](https://github.com/bia-pain-bache/BPB-Worker-Panel) by [bia-pain-bache](https://github.com/bia-pain-bache)
- Licensed under GPL-3.0 — see the LICENSE file
