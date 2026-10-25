# :material-cog-outline:{ .md .middle } Telegram Bot

Flash Panel ships a full admin bot: get subscriptions and QR codes, monitor Cloudflare usage, manage subscription users, change panel settings and broadcast messages — without opening the panel.

## Setup

1. Create a bot with `@BotFather` and copy the **API token** it gives you.
2. Get your numeric user ID from `@userinfobot`.
3. In the panel open **Telegram Bot**, submit the token and your user ID, and save.

The panel then registers the webhook at `https://<your-domain>/<securePath>/telegram/webhook` and pushes the command list to Telegram via `setMyCommands`.

!!! note
    Telegram webhooks require a valid HTTPS URL. The panel is served from your custom domain — `workers.dev` is permanently disabled (v0.8.12 policy), so the webhook always points at the custom domain.

!!! info "Who can talk to the bot"
    Every update whose sender is not the configured `telegramUserId` is silently ignored. Subscription users never talk to the bot directly — they only *receive* messages (links, broadcasts) if you link their chat ID in the panel.

## Commands

| Command | Description |
| --- | --- |
| `/start` | Show the welcome menu (inline keyboard with all sections). |
| `/config` | Get configs — pick a subscription type and receive its link, QR code and ready-to-import file. |
| `/clients` | Get supported clients — minimum version and download link per client. |
| `/tg` | Telegram setup guide (how configs tunnel Telegram, no MTProto proxy needed). |
| `/usage` | Cloudflare Workers usage — panel and total requests against the 100,000/day free limit. |
| `/users` | Subscription users and stats — paginated list with activity and fetch counts. |
| `/digest` | Daily summary — usage plus user statistics in one message. |
| `/edge` | Edge telemetry — Cloudflare colo, client ISP/ASN and TCP RTT samples. |
| `/broadcast` | Message all linked users (see below). |
| `/settings` | Change panel settings from the chat (see below). |
| `/cftoken` | Cloudflare API token — show status / set (admin only). |

The inline menu also exposes **Status** (panel version, usage, key settings) and **Restart** (invalidates the settings/dataset caches so fresh values are loaded on the next request).

## `/cftoken` command

Since v0.8.12 the Cloudflare API token is never embedded in the Worker source (that pattern triggers Cloudflare's secret scanner and blocks execution). The token lives only in Workers KV under the key `cfApiToken` and is injected at runtime; it powers the usage features and the panel self-update engine.

- `/cftoken` — shows the current status as a masked value (`****` + last 4 characters) or `not configured`.
- `/cftoken <token>` — stores the token in KV, verifies it live against the Cloudflare `tokens/verify` endpoint and applies it immediately.

Security notes:

- Only the admin (the configured `telegramUserId`) can use the command; it is intentionally absent from the inline menu.
- The full token is never echoed back in any reply.
- To rotate the token, send `/cftoken <new-token>` — the old value is replaced atomically. Rotate also in the Cloudflare dashboard if you suspect leakage, and consider deleting the message containing the token from your chat history.

## Subscription links from the bot

**Get Config** lists your subscription types (Normal, Fragment, Raw, Warp, Warp Pro). For each type the bot sends:

- a QR code and the plain subscription URL: `https://<domain>/<securePath>/sub/<type>?app=<core>`
- a ready-to-import document (`.json` per core, `.zip` for Wireguard/Amnezia); sing-box links use the `sing-box://import-remote-profile` deep link
- the list of supported apps for that subscription

In **Users** you can pick a subscription user and tap **Resend links** to send their personal links (`/<securePath>/sub/<userId>/<type>`) — delivered straight to the user's chat when they have a linked Telegram chat ID. Revoked users get a 401 until restored.

## Settings from the chat

The settings menu exposes only *safe* fields — identity fields (`securePath`, UUID, Trojan password, custom domain) are deliberately not editable here:

- `localDNS`, `remoteDNS`, `protocols`, `cleanIPs` (max 50 lines), `fingerprint`
- WS Guardian: `wsGuardianEnabled`, `wsGuardianIdleSec` (30–3600 s)
- Routing/blocking toggles: bypass Iran/China/Russia/OpenAI/Google AI/Microsoft/Oracle/Docker, block Ads/Porn/Malware/Phishing/Cryptominers

Tap a field, then reply to the bot's prompt (or send a standalone value within 15 minutes). Booleans accept `true`/`false` and are stored as real booleans; `cleanIPs` accepts one IP or domain per line.

## Broadcast

`/broadcast` sends a personalized message to the admin chat plus every active subscription user with a linked Telegram chat ID. Supported placeholders: `{name}` (user name), `{link}` (their personal subscription URL), `{uuid}` (their user ID). You get a preview with recipient count, then confirm or cancel; a final report shows sent/failed counts.

## Troubleshooting

??? question "Bot answers nothing"
    Check that the sender is exactly the configured `telegramUserId`. After changing the bot token or moving to another domain, re-submit the setup in the panel so the webhook URL and secret are re-registered.

??? question "Webhook security"
    The webhook secret is derived from the bot token (SHA-256, first 24 hex chars) and passed to Telegram via `setWebhook`. Every incoming update is validated against the `X-Telegram-Bot-Api-Secret-Token` header — forged updates are dropped.

??? question "Usage shows *not configured*"
    No Cloudflare API token is stored. Set it with `/cftoken <token>`; usage, edge telemetry limits and panel self-update depend on it.

??? question "Save failed / KV limit"
    Workers KV has a daily write quota. The bot reports failures honestly instead of pretending success; wait a moment and retry. Settings prompts survive this: replying to the bot's message works even when the pending state could not be saved.
