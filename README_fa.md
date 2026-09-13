<div dir="rtl">

# ⚡ فلش پنل

پنل شخصی پروکسی روی Cloudflare Workers — بهینه‌شده، امن و مستقل

> هارد‌فورک کامل از [BPB-Worker-Panel](https://github.com/bia-pain-bache/BPB-Worker-Panel) با بهینه‌سازی، رفع باگ و بهبود امنیتی.

## امکانات

| قابلیت | توضیح |
|---------|--------|
| VLESS + Trojan | WebSocket + TLS |
| Warp + Warp Pro | پشتیبانی کامل |
| سابسکریپشن خودکار | v2rayNG, sing-box, Clash... |
| DoH اختصاصی | DNS over HTTPS |
| ربات تلگرام | مدیریت از تلگرام |
| Fragment | دور زدن فیلترینگ TLS |
| آپدیت خودکار | از GitHub |
| ۲۲ تست + CI | روی هر تغییر |

## نصب سریع

۱. [فلش ویزارد](https://flash-wizard.imsoroush.workers.dev/) رو باز کنید
۲. توکن API بسازید ([اینجا](https://dash.cloudflare.com/profile/api-tokens) — قالب Edit Cloudflare Workers)
۳. دامنه‌تون رو وارد کنید
۴. «نصب کن» 🚀

**بعد از نصب:** URL پنل — یوزرنیم = ایمیل اکانت — پسورد = موقع اولین ورود

## ⚠️ دامنه اختصاصی — حیاتی

> **تجربه‌ی واقعی:** اکانتم به خاطر abuse report خودکار روی workers.dev ساسپند شد.
> اسکنرها دامنه‌های *.workers.dev رو برای پنل پروکسی می‌کَون و ریپورت می‌کنن.

| | workers.dev | دامنه شخصی |
|---|---|---|
| خطر بن | 🔴 بالا | 🟢 صفر |
| دسترسی ایران | 🔴 فیلتره | 🟢 پایدار |

**راهنما:** دامنه بخر → Add a domain توی CF → NS ست کن → با ویزارد نصب کن

## مشکلات رایج

<details>
<summary>🔴 اکانتم ساسپند شد</summary>

Appeal به abusereply@cloudflare.com — با اکانت جدید و دامنه شخصی دوباره نصب کن
</details>

<details>
<summary>🔴 کانفیگ‌ها به workers.dev اشاره می‌کنن</summary>

پنل → تنظیمات → Custom Domain → دامنه‌تون → Save
</details>

<details>
<summary>🔴 تنظیمات ذخیره نمی‌شه</summary>

باگ BPB — توی فلش پنل فیکس شده. Custom Domain رو پاک کن → Save → دوباره بذار → Save
</details>

<details>
<summary>🟡 workers.dev بعد از deploy روشن می‌شه</summary>

`"workers_dev": false` به wrangler.jsonc اضافه کن
</details>

<details>
<summary>🟡 درخواست‌های زیاد (40%+ روزانه)</summary>

طبیعیه — قطعی شبکه = reconnect زیاد. سقف: ۱۰۰k/روز
</details>

## آپدیت

- **از پنل:** Update Panel → تأیید (تنظیمات حفظ می‌شه)
- **از ترمینال:** git pull → build → deploy

## امنیت

- پسورد قوی (۱۲+ کاراکتر)
- UUID/Trojan جدید بعد از تغییرات مهم
- کانفیگ‌ها فقط با آدمای مطمئن
- اکانت جدا برای پنل
- توکن API رو دوره‌ای عوض کن

## اعتبار

- پروژه اصلی: [BPB-Worker-Panel](https://github.com/bia-pain-bache/BPB-Worker-Panel)
- لایسنس: GPL-3.0
- ویزارد: [Flash Wizard](https://github.com/CheginiSoroush/flash-wizard)

</div>
