<div dir="rtl" align="center">

# ⚡ فلش پنل

**پنل مدیریت پروکسی قدرتمند و بدون سرور بر بستر Cloudflare Workers**

[🇬🇧 English](README.md)

![Workers](https://img.shields.io/badge/Platform-Cloudflare%20Workers-F38020?style=flat-square&logo=cloudflare)
![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=flat-square&logo=typescript&logoColor=white)
![License](https://img.shields.io/badge/License-GPL--3.0-blue?style=flat-square)

</div>

<div dir="rtl">

---

فلش پنل، Cloudflare Workers شما را به یک سرور پروکسی پیشرفته تبدیل می‌کند. با هزینه‌های سنگین VPS خداحافظی کنید و از معماری کاملاً بدون سرور با مسیریابی هوشمند، پشتیبانی چند هسته و ربات تلگرام لذت ببرید.

> هارد‌فورک کامل از [BPB-Worker-Panel](https://github.com/bia-pain-bache/BPB-Worker-Panel) با بهینه‌سازی عملکرد، رفع باگ و بهبودهای امنیتی.

## ✨ ویژگی‌های کلیدی

| | |
|---|---|
| ☁️ **کاملاً بدون سرور** | اجرای ۱۰۰٪ روی Cloudflare — بدون VPS و هزینه |
| 🛡️ **VLESS + Trojan** | پروتکل‌های مدرن با WebSocket + TLS |
| 📦 **سازگاری کامل** | Xray، Sing-box و Clash |
| 🤖 **ربات تلگرام** | مدیریت کامل از چت — کانفیگ، مصرف، کاربران |
| 🔀 **مسیریابی پیشرفته** | WARP، WARP Pro، Fragment، DoH |
| 🌍 **Proxy IP** | اتصال به IP های تمیز خارجی |
| 🔄 **آپدیت خودکار** | از GitHub — بدون خط فرمان |
| 🧪 **۲۲ تست + CI** | کنترل کیفیت روی هر تغییر |

## 🚀 استقرار سریع

### 🪄 فلش ویزارد — پیشنهادی

نصب در **۶۰ ثانیه** با [فلش ویزارد](https://flash-wizard.imsuroush.workers.dev/) — بدون خط فرمان.

> ⚠️ **از دامنه شخصی استفاده کنید.** استقرار روی `*.workers.dev` ریسک گزارش خودکار و مسدودی اکانت دارد.

### ⚠️ دامنه اختصاصی — حیاتی

| | workers.dev | دامنه شخصی |
|---|---|---|
| خطر مسدودی | 🔴 بالا | 🟢 صفر |
| دسترسی ایران | 🔴 فیلتر | 🟢 پایدار |
| کانفیگ‌ها | 🔴 قابل کشف | 🟢 مخفی |

**راهنما:** دامنه بخرید ($۲-۳/سال) → در Cloudflare اضافه کنید → با ویزارد نصب کنید

### نصب دستی

```bash
git clone https://github.com/CheginiSoroush/flash-panel.git
cd flash-panel
npm install
cp wrangler.jsonc.example wrangler.jsonc
cp deploy/settings.example.js deploy/settings.js
npm run check && npm run test && npm run build
npx wrangler deploy
```

## 🔧 مشکلات رایج

<details>
<summary>کانفیگ‌ها به workers.dev اشاره می‌کنند</summary>

پنل → تنظیمات → **Custom Domain** → دامنه خود را وارد کنید → Save
</details>

<details>
<summary>تنظیمات ذخیره نمی‌شود</summary>

این باگ BPB است — در فلش پنل فیکس شده.
Custom Domain را پاک کنید → Save → دوباره وارد کنید → Save
</details>

<details>
<summary>workers.dev بعد از هر deploy روشن می‌شود</summary>

`"workers_dev": false` را به `wrangler.jsonc` اضافه کنید
</details>

<details>
<summary>مصرف روزانه بالا (۴۰٪+)</summary>

طبیعی است — قطعی شبکه = reconnect زیاد. سقف: ۱۰۰,۰۰۰/روز
</details>

## 🔄 آپدیت

- **از پنل:** Update Panel → تأیید (تنظیمات حفظ می‌شود)
- **از ترمینال:** `git pull` → `npm run build` → `npx wrangler deploy`

## 🛡️ نکات امنیتی

- پسورد قوی (۱۲+ کاراکتر)
- کانفیگ‌ها را فقط با افراد مطمئن شیر کنید
- اکانت جدا برای پنل
- توکن API را دوره‌ای تغییر دهید

## 📖 اعتبار

| | |
|---|---|
| **پروژه اصلی** | [BPB-Worker-Panel](https://github.com/bia-pain-bache/BPB-Worker-Panel) |
| **لایسنس** | GPL-3.0 |
| **ویزارد** | [فلش ویزارد](https://github.com/CheginiSoroush/flash-wizard) |

</div>

<div dir="rtl" align="center">

---

**⚡ فلش پنل** — ساخته شده با ❤️ برای اینترنت آزاد

</div>
