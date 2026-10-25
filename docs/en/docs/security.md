# :material-shield-lock-outline:{ .lg .middle } Security & Recovery

How Flash Panel stays hard to find, hard to abuse, and easy to recover — plus the exact playbook for Cloudflare abuse reports and account hardening.

## Security model (v0.8.12+)

### No credentials in source

Until v0.8.11 the Cloudflare API token was embedded inside the deployed worker source. Cloudflare's secret scanners flag "credential in source" patterns, and that was one of the triggers of the abuse report that once blocked this panel (error 1101). Since v0.8.12:

- The deployed source **always** contains `apiToken: ''`.
- The real token lives in the KV namespace under the key `cfApiToken` (raw string, never JSON).
- It is read at isolate boot via `loadApiToken()` with a 5-second cache and injected into the runtime globals — a KV failure never breaks request handling.
- You set or rotate it with the `/cftoken` command in the Telegram bot (or the panel settings page).

!!! tip "Use a scoped API token, not the Global API Key"
    Create a token with the minimum scopes the panel needs (Workers Scripts: Edit, KV Storage: Edit, Zone: Read) and paste *that* via `/cftoken`. The Global API Key should ideally never be used by the panel at all.

### workers.dev permanently disabled

The `*.workers.dev` domain is continuously crawled by automated scanners and abuse-report bots — the panel's original block came through exactly such a report. v0.8.12 therefore treats workers.dev as **disabled by design**:

- Per-script subdomain: `enabled=false`, `previews_enabled=false`.
- The panel ships a guard (`workersdev-guard`) that refuses mis-deploys targeting a workers.dev address.
- All traffic is served from **your own custom domain** only.

!!! warning "Do not re-enable workers.dev"
    Re-enabling it re-attaches your panel to the most-scanned domain on the platform. Keep it off permanently.

### Anti-discovery layers

- **Fallback page** — any request outside the secure path is answered with a realistic decoy page (a speedtest site), not a 404. Scanners see a normal website.
- **Secure path** — the panel, subscriptions, DoH, proxy-IP and QR endpoints all live behind the secret path. Without it, everything falls back to the decoy.
- **Hardened responses** — security headers and response shaping on all panel routes.
- **Webhook authentication** — Telegram updates are rejected unless the `X-Telegram-Bot-Api-Secret-Token` header matches (derived from the bot token), and non-admin senders are silently ignored.

### Login brute-force guard (v0.8.14/15)

- 5 failed login attempts from one IP → that IP is **blocked for 15 minutes** (HTTP 429 with `Retry-After`).
- The strike counters and the block marker live in **KV**, so the guard is global — Cloudflare fans requests out across many isolates and an in-memory limiter alone would be bypassed.
- KV write-diet: the 429 path writes nothing; worst case is ~6 writes per 15-minute window.
- Failure-safe: if KV is unavailable the guard fails open rather than locking you out.

!!! note "Locked out yourself?"
    Wait ~15 minutes for the block marker to expire, then log in. There is no way to clear it early by design — that is what makes it meaningful.

## Domain choice & anonymity

- **The worker name is never public.** With workers.dev disabled, the script name only exists inside your Cloudflare account. Abuse reports attach to the *account*, not the name — renaming a worker means a delete-and-recreate cycle for zero external benefit.
- **The custom domain is the only public surface.** Pick a neutral-looking subdomain (something that reads like a CDN node, e.g. `s2.example.com`) instead of names that advertise the panel's purpose.
- **Migrating domains** does not require rebuilding the worker: create the DNS record + Workers route for the new host, redeploy with the new `mainDomain` (the rescue deploy script supports a `CF_MAIN_DOMAIN` override), keep the old route alive during the transition, then re-register the Telegram webhook on the new domain and finally remove the old DNS + route.

## Traffic volume — what Cloudflare actually sees

Understanding the real signals removes most of the fear:

| Signal | Large download (e.g. 5 GB) through the tunnel |
|---|---|
| Request count | **1** — the whole download flows through a single WebSocket connection |
| CPU time | Near zero — the worker only pipes bytes |
| Connection duration + bytes | **Visible to Cloudflare** — this is inherent to proxying and cannot be hidden |
| Seen by destination sites | The **proxy IP** address, not your Cloudflare account |

Practical guidance:

- Occasional multi-GB downloads: normal personal-scale usage, low risk.
- Avoid 24/7 saturated streaming/downloading for days — that pattern reads as "commercial server", not "personal panel".
- Prefer **single-connection** downloads; multi-threaded download managers (e.g. 16 segments) open one tunnel per thread and look bot-like.
- The panel's `wsGuardian` kills idle tunnels after 300 s, so dead connections do not accumulate.

## Abuse report playbook

Cloudflare abuse emails are usually **automated reports against a URL**, not verdicts. In the past, a report against this panel's workers.dev address arrived *after* the subdomain had already been disabled — the report targeted a dead URL.

1. **Identify the reported URL.** If it is your `workers.dev` address — it is already disabled; there is nothing to turn off.
2. **Verify your panel is still serving.** Check that login responds on your custom domain. If it does, the report is email-only and no enforcement has happened.
3. **Reply to `abusereply@cloudflare.com`** with the report ID in the subject. State the facts: the reported subdomain is permanently disabled (`enabled=false`, `previews=false`), the service is a personal-use panel served only from your own custom domain with access control, and you remain available to cooperate.
4. **If execution is actually blocked (error 1101):** the block is attached to the *script identity*, not the content. Content-only redeploys will not clear it. The recovery that works:
    1. Back up settings (KV values and the embedded settings from the live script).
    2. `DELETE` the worker script, then `PUT` the same build back under the same name with `keep_bindings` for KV.
    3. Re-create the **Workers Route** on your custom domain — deleting a script silently deletes its zone routes, and a missing route looks like error 522.
    4. Re-apply the cron trigger schedule.
    5. End-to-end verify: login, subscription, WebSocket handshake, real-tunnel traffic.
5. **Prevention beats recovery.** The checklist below is what makes reports harmless in the first place.

## Account hardening checklist

- [ ] **Enable 2FA (TOTP)** on the Cloudflare account — the single highest-value action.
- [ ] **Roll the Global API Key** if it was ever pasted anywhere; prefer scoped API tokens for daily use.
- [ ] Keep **workers.dev disabled** (both the subdomain and preview URLs).
- [ ] Feed the panel a **scoped token** via `/cftoken`, rotate it periodically.
- [ ] Keep the panel **updated** — the self-update engine consumes the three mirrors refreshed by CI on every release.
- [ ] Take a **settings backup** (Import/Export in the panel) before big changes.
- [ ] Prefer a neutral custom-domain subdomain; do not put product names in DNS.
