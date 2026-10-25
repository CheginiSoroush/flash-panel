# :material-cloud-question-outline:{ .lg .middle } Frequently Asked Questions

??? question "Why don't v2ray configs connect?"
    If you enabled `Routing rules` and the VPN doesn't connect, the only reason is that the Geo assets are not updated. In the v2rayN(G) client menu, go to the `Asset files` section and tap the cloud or download icon to update. Note that it takes a while to update, you have to wait to see `success` for all files. If the update fails, it won't connect. If you tried everything and it still doesn't update, download the two files below from the links and instead of updating, tap the add button and import these two files:
    ```title="GeoIP"
    https://github.com/Loyalsoldier/v2ray-rules-dat/releases/latest/download/geoip.dat
    ```
    ```title="GeoSite"
    https://github.com/Loyalsoldier/v2ray-rules-dat/releases/latest/download/geosite.dat
    ```

??? question "Why don't Raw subscription configs connect or cannot open websites?"  
    To use these configs, disable `Mux` in the settings of whichever app you’re using. Also set remote DNS to DOH, DoT or TCP:
    ```title="DoH"
    https://8.8.8.8/dns-query
    ```
    ```title="DoT"
    tls://8.8.8.8  
    ```
    ```title="TCP"
    tcp://8.8.8.8  
    ```

??? question "Why configs connect using v2rayNG and not Streisand for example?"
    Flash Panel tries adapting new cores' features ASAP, meanwhile some developers just upgrade cores to the latest version regardless of full features adaption and optimizations. So you should communicate such issues with their own developers.

??? question "Why Fragment configs speed is slow on my ISP?"
    Each ISP has its own prefered Fragment settings. Most are fine with the panel defaults, but these values may work well on yours. You may need to change Fragment profile to `Medium`, `High` or even manually change settings in `Custom` profile to achieve better results. Also MahsaNG is recommended to connect to fragment configs.

??? question "Why some websites or applications like X and ChatGPT are not working well?"  
    There are many public porxy IPs and some of them might be unstable. You need to test to find a good one from panel.

    Also disable IPv6 if your ISP does not provide it.  

??? question "It worked when I set a proxy IP, but now it's not working!"
    If you use a single IP, it may stop working after some time and many sites won’t open. You need to redo the steps. Preferably, if you're not doing anything that needs a static IP, just use the panel default and don't use a single proxy IP.  

??? question "Why do I get an error when I go to the `panel/` address?"
    You can only install Flash Panel using Flash Wizard and save panel address immediately. If you lost it install another one.  

??? question "I deployed it but Cloudflare returns error 1101!"
    Your Cloudflare account has likely been flagged. Create a new Cloudflare account with an official email like Gmail and. Also, make sure the project name doesn't include the word "Flash Panel".  
    It is recommended to use **Wizard** for installation.  

??? question "Can I use this for trading?"
    If your Cloudflare IP is located in Germany (which it usually is), using a single Germany proxy IP should be fine. But preferably use the Chain Proxy method to stabilize the IP.  

??? question "Why I can't see non-TLS ports in panel?"
    To use non-TLS configs, you must deploy via Workers method and without a custom domain.  

??? question "Why doesn’t the Smart Fragment config connect or work properly?"
    Turn off `Prefer IPv6` in settings.  

??? question "Why don't Telegram calls or Clubhouse work?"
    Cloudflare can't properly handle the UDP traffic. There is currently no effective solution. Use Warp configs instead.

??? question "I forgot the panel password. What should I do?"
    Go to your Cloudflare dashboard, find the KV created for Worker or Pages, click view, go to the KV Pairs section. In the table, you’ll see a `pwd` key — the value next to it is your password.  

??? question "I used the Pages method but I get a 404."
    Cloudflare takes a few seconds to register Pages domains. Give it time, refresh, and it should work.  

??? question "Why doesn’t the panel show the Block Ads checkbox?"
    Extensions like `uBlock`, `AdGuard` or even some browsers with built-in ad-block settings, can hide it. Disable them for the panel.

??? question "Why wizard is detected as Virus in windows?"
    The wizard app lacks `Code signing certificate` and this is common across Go applications known as False Positive. So you have to temporarily disable Windows defender or any other Anti Virus program.

??? question "Why v2rayN cannot ping test configs?"
    Right now v2rayN is experiencing some issues with custom configs and Flash Panel panel configs are all custom. No worries, just enable config and use it. You also have Best Ping config in all subscriptions which connects to best IP automatically, so you don't need to test all configs everytime.

??? question "Why sing-box throws error while importing subscription?"
    Flash Panel only supports sing-box 1.12.0 or higher

??? question "Why do I get `429 Too Many Requests` when logging in?"
    After **5 failed login attempts** from one IP, that IP is blocked for **15 minutes** (HTTP 429 with `Retry-After`). The guard is global and KV-backed, so it works no matter how Cloudflare routes your requests across isolates. Just wait ~15 minutes and log in with the correct credentials — there is deliberately no early-reset.

??? question "Why should I keep the workers.dev subdomain disabled?"
    The `*.workers.dev` domain is continuously crawled by automated scanners and abuse-report bots — it was the trigger of the abuse report that once got this panel blocked (error 1101). Since v0.8.12 the panel treats workers.dev as disabled-by-design (`enabled=false`, `previews=false`), ships a guard against accidental re-deploys there, and serves everything from your own custom domain. See [Security & Recovery](security.md).

??? question "Is it risky to download large files through the configs?"
    A single WebSocket connection carries the whole download — it counts as **1 request** with near-zero CPU, so occasional multi-GB downloads are normal personal-scale usage. What stands out is sustained 24/7 saturation or multi-threaded download managers (each thread opens its own tunnel). Prefer single-connection downloads. The destination sites only see the proxy IP, not your Cloudflare account. Full analysis in [Security & Recovery](security.md#traffic-volume-what-cloudflare-actually-sees).

??? question "How does the panel update itself?"
    The update engine fetches the latest `worker.js` from three mirrors in order — GitHub Releases, GitHub Pages (`/download/worker.js`), then jsDelivr — preserves your embedded settings and KV bindings, and deploys with the cron schedule intact. CI refreshes the mirrors on every release, and `version.json` on the Pages site always states the latest published version.

??? question "Cloudflare sent me an abuse report — what do I do?"
    Don't panic: these are usually automated reports against a URL, not verdicts. Identify the reported URL — if it is your `workers.dev` address, it is already disabled by design. Verify your panel still answers on the custom domain, then reply to `abusereply@cloudflare.com` with the report ID in the subject and the facts (subdomain permanently disabled, personal-use panel on custom domain only). If execution is actually blocked (error 1101), the full recovery procedure — delete + recreate, route restoration, cron re-apply — is documented step by step in [Security & Recovery](security.md#abuse-report-playbook).
