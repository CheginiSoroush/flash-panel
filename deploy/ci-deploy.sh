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

export CF_DOMAIN_VERIFY="https://v1.imsoroush.top"

echo "▸ [1/6] install + check + build"
npm ci --legacy-peer-deps
npm run check
npm run build

echo "▸ [2/6] inject EMBEDED_SETTINGS (fail-closed)"
node deploy/inject-embed.mjs

echo "▸ [3/6] generate wrangler.jsonc (from example — gitignored، فقط برای این run)"
# شناسه‌ی KV: اول secret اختیاری CLOUDFLARE_KV_ID (وقتی API محدود است)،
# وگرنه با API از روی title پیدا می‌شود — هیچ ID ای در سورس نیست
if [ -n "${CLOUDFLARE_KV_ID:-}" ]; then
    KV_ID="$CLOUDFLARE_KV_ID"
    echo "  KV id ← CLOUDFLARE_KV_ID secret (API lookup skipped)"
else
    KV_ID="$(curl -fsS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
        "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/storage/kv/namespaces?per_page=100" \
      | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);if(!j.success)throw new Error('KV list failed: '+JSON.stringify(j.errors||[]));const n=(j.result||[]).find(n=>n.title==='flash-panel-kv');if(!n)throw new Error('KV namespace flash-panel-kv not found');process.stdout.write(n.id)})")"
    echo "  KV id ← API lookup"
fi
node - "$CLOUDFLARE_ACCOUNT_ID" "$KV_ID" <<'EOF'
const fs = require('fs');
let c = fs.readFileSync('wrangler.jsonc.example', 'utf8');
c = c.replaceAll('"YOUR_ACCOUNT_ID"', JSON.stringify(process.argv[2]));
c = c.replaceAll('"YOUR_KV_NAMESPACE_ID"', JSON.stringify(process.argv[3]));
if (c.includes('YOUR_')) throw new Error('unresolved placeholder in generated wrangler.jsonc');
fs.writeFileSync('wrangler.jsonc', c);
console.log('  wrangler.jsonc generated (account_id + KV id resolved)');
EOF

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

echo "▸ [4/6] deploy via wrangler"
deploy

echo "▸ [5/6] verify live (securePath masked)"
sleep 10
if verify; then
    echo "✅ deploy سالم و زنده است."
    exit 0
fi

# ---------- rescue: امضای enforcement پلتفرم (صفر invocation + 1101) ----------
echo "⚠️  [6/6] وریفای شکست خورد → rescue: delete + recreate (playbook بازیابی؛ KV دست‌نخورده می‌ماند)"
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
