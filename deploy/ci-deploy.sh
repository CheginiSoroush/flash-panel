#!/usr/bin/env bash
# ============================================================================
# استقرار خودکار Flash Panel روی Cloudflare Workers — تمام منطق دیپلوی اینجاست
# (workflow فقط پوسته‌ی نازک است — الگوی «استقرار خودکار»، قابل اجرای محلی هم)
#
# مسیر: build → تزریق هویت (secret) → wrangler deploy → وریفای زنده → rescue
#
# درس‌های سخت امروز (2026-10-28) که این اسکریپت آن‌ها را مراعاتق می‌کند:
#  1) هرگز با تنظیمات پیش‌فرض روی ورکر زنده دیپلوی نکن — هویت پنل (securePath/
#     vlUUID/…) پاک می‌شود → PANEL_EMBED_JSON اجباری است (fail-closed).
#  2) اسکریپت upload فقط از مسیر wrangler — multipart دستی POST/PUT با API
#     روی این اکانت 10405 می‌دهد یا state را به‌هم می‌ریزد.
#  3) Custom Domain روی این اکانت ناپایدار است — الگوی پایدار: route + AAAA
#     100:: (در wrangler.jsonc نگهداری می‌شود، wrangler خودش idempotent ensure می‌کند).
#  4) اگر بعد از deploy وریفای زنده شکست خورد (پاسخ 1101/522 بدون invocation =
#     امضای enforcement سمت پلتفرم)، rescue: delete + recreate (همان playbook
#     بازیابی — KV جدا است و تنظیمات حفظ می‌شود).
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

# ---------- fail-closed: بدون اعتبارنامه هیچ کاری نکن ----------
: "${CLOUDFLARE_API_TOKEN:?❌ secret CLOUDFLARE_API_TOKEN تنظیم نشده}"
: "${CLOUDFLARE_ACCOUNT_ID:?❌ secret CLOUDFLARE_ACCOUNT_ID تنظیم نشده}"
: "${PANEL_EMBED_JSON:?❌ secret PANEL_EMBED_JSON تنظیم نشده — دیپلوی بدون هویت پنل ممنوع}"

export CF_DOMAIN_VERIFY="https://s2.imsoroush.top"

echo "▸ [1/5] install + check + build"
npm ci --legacy-peer-deps
npm run check
npm run build

echo "▸ [2/5] inject EMBEDED_SETTINGS (fail-closed)"
node deploy/inject-embed.mjs

deploy() {
    npx wrangler deploy dist/worker-deploy.js
}

verify() {
    # ۳ تلاش با فاصله؛ securePath در لاگ چاپ نمی‌شود
    local code=""
    for _ in 1 2 3; do
        code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$CF_DOMAIN_VERIFY/$(node -e 'process.stdout.write(JSON.parse(process.env.PANEL_EMBED_JSON).securePath)')/login" || true)"
        [ "$code" = "200" ] && return 0
        sleep 10
    done
    echo "  آخرین کد وریفای: ${code:-none}"
    return 1
}

echo "▸ [3/5] deploy via wrangler"
deploy

echo "▸ [4/5] verify live (securePath masked)"
sleep 10
if verify; then
    echo "✅ deploy سالم و زنده است."
    exit 0
fi

# ---------- rescue: امضای enforcement پلتفرم (صفر invocation + 1101) ----------
echo "⚠️  [5/5] وریفای شکست خورد → rescue: delete + recreate (playbook بازیابی؛ KV دست‌نخورده می‌ماند)"
curl -sS -X DELETE \
    "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/flash-panel" \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" | head -c 200; echo
sleep 5
deploy

echo "▸ verify after rescue"
sleep 15
if verify; then
    echo "✅ rescue موفق — پنل دوباره زنده است."
    exit 0
fi

echo "❌ rescue هم شکست خورد — نیاز به بررسی دستی (لاگ wrangler بالا را ببین)."
exit 1
