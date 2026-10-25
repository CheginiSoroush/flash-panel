# :material-cog-outline:{ .md .middle } External Raw Configs

Flash Panel can mix your own configs into the generated **Raw** subscription. Two fields control this:

| Field | Content | Validation |
| --- | --- | --- |
| `customConfigs` | Raw config lines, one per URI | none — passed through as-is |
| `customSubs` | URLs of external subscriptions, one per line | must be valid URLs |

## How it works

When a client fetches the Raw subscription (`/<securePath>/sub/raw`), the panel:

1. Generates its own VLESS and Trojan share URIs from your settings.
2. Appends the [Chain Proxy](vless-trojan.md#chain-proxy) config (if configured, marked with a chain icon).
3. Appends every line of `customConfigs`.
4. Fetches every `customSubs` URL live and appends the decoded content.

The whole body is base64-encoded, which is the standard format every V2Ray-family client can import. The response also carries `Profile-Update-Interval: 3`, so clients re-fetch (and re-merge your external sources) about every 3 hours.

## Accepted formats

- **Custom configs**: standard share URIs — `vless://...`, `trojan://...`, `vmess://base64`, `ss://...`, plus socks/http URIs with credentials. One URI per line; a `#remark` suffix becomes the config name.
- **External subscriptions**: any HTTP(S) URL. The response body may be plain text (one URI per line) or base64 — the panel detects base64 automatically and decodes it. Failed fetches or empty responses are silently skipped, so one dead source never breaks the subscription.
- Full client **config JSON** (sing-box/Clash objects) is not applicable here: the Raw subscription is a URI list, not a core config file. Use those formats with the dedicated `normal`/`fragment` `?app=` variants instead (see [Supported clients](../usage/supported-clients.md)).

!!! note
    The panel does not validate or rewrite `customConfigs` lines — whatever you paste is delivered verbatim to your clients.

## Risks

!!! warning "Third-party configs are trusted blindly"
    External configs bypass the panel's generated settings (fragment, routing, fingerprints). A malicious source can inject arbitrary exit nodes — only add subscriptions you trust, and prefer HTTPS URLs.

!!! warning "Core compatibility"
    There are compatibility issues between cores: a config using a transport the client's core does not support (XHTTP for example) cannot be parsed or connected to by sing-box-based clients such as Hiddify or NekoBox. Keep exotic configs in a separate profile.

!!! info "Request cost"
    Every `customSubs` URL is fetched from the Worker each time the Raw body is regenerated. Unreachable sources add latency and count against your Cloudflare request quota.

## Tips

- Paste one URI per line and test a new source by importing the Raw subscription into a client before sharing it with others.
- Changes only reach clients after **Apply Settings** and a subscription refresh — the Raw body is regenerated and cached by an ETag that covers all settings inputs.
- Keep heavy sources (hundreds of configs) out of `customConfigs` and reference them as `customSubs` instead; the panel merges both the same way.
