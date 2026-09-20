<div dir="rtl" align="center">

# ⚡ فلش پنل

### پنل پروکسی بدون سرور برای Cloudflare Workers

**VLESS · Trojan · WARP** — ساخته‌شده برای سرعت، مقاوم‌شده برای دنیای واقعی

[🇬🇧 English](README.md) · [🪄 نصب سریع](https://flash-wizard.imsoroush.workers.dev/)

![Cloudflare Workers](https://img.shields.io/badge/Platform-Cloudflare%20Workers-F38020?style=flat-square&logo=cloudflare)
![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=flat-square&logo=typescript&logoColor=white)
![Tests](https://img.shields.io/badge/Tests-22%20passing-34d399?style=flat-square)
![License](https://img.shields.io/badge/License-GPL--3.0-blue?style=flat-square)
![Size](https://img.shields.io/badge/Bundle-176KB%20gzipped-9333ea?style=flat-square)

</div>

<div dir="rtl">

---

<div align="center">

### 📊 بنچمارک — در برابر فورک «بهینه‌شده»‌ی BPB

*تنظیمات یکسان، IP های یکسان، پورت‌های یکسان — کنار هم*

| | فلش پنل | فورک دیگر |
|---|:---:|:---:|
| کانفیگ سالم | **۷۲ از ۸۵** ✅ | ۵۹ از ۸۵ |
| کمترین پینگ | **فلش** ✅ | — |

**+۲۲٪ کانفیگ سالم بیشتر** — اندازه‌گیری‌شده، نه ادعا.

</div>

---

## ✨ چرا فلش؟

اکثر فورک‌های BPB فقط **اسم** را عوض می‌کنند. فلش پنل **موتور** را بازسازی کرده:

### 🔥 هسته‌ی پروتکل — بازنویسی‌شده از صفر

| فیکس | اثر |
|------|-----|
| باگ race در سوکت | کانکشن‌هایی که وسط handshake می‌مردند → حذف کامل |
| SHA-224 در **هر کانکشن** | کش‌شده — احراز Trojan تقریباً رایگان |
| پارس VLESS با ۱۰ بار کپی | zero-copy — مصرف CPU هر کانکشن کاهش |
| قفل writer در هر chunk | کش‌شده — توان پایدار |
| خواندن KV در **هر درخواست** | کش سطح isolate + TTL |
| تولید دوباره‌ی کانفیگ در هر fetch | ETag/304 — سرو آنی وقتی چیزی عوض نشده |
| JSON با تورفتگی (~۲۰MB) | فشرده — **ساب‌ها ۹۴٪ کوچیک‌تر** |

### 🛡️ امنیت — نه به‌عنوان بعدthought

- 🔐 **محدودسازی نرخ لاگین** + مقایسه‌ی constant-time
- 🤖 **اعتبارسنجی webhook تلگرام** — رد آپدیت‌های جعلی
- ⚡ مسیر `workers.dev` **خودکار خاموش** — خارج از رادار اسکنرها

### 🤖 ربات تلگرام — کنترل کامل از جیب

URL پنل معمولاً فیلتره. تلگرامت نه.

```
/config    — دریافت کانفیگ + QR
/status    — نمای کلی پنل
/settings  — ۱۸ تنظیم قابل‌ویرایش (DNS، پروتکل‌ها، IP های تمیز، مسیریابی...)
/restart   — ریست آنی کش
```

### 🧪 مهندسی — مثل نرم‌افزار واقعی

- **۲۲ تست واحد** روی پارسرهای پروتکل
- **CI روی هر push**
- **Release خودکار** — tag → build → publish
- **آپدیت خودکار از پنل** — بدون downtime

---

## 🚀 نصب

### 🪄 فلش ویزارد — ۶۰ ثانیه، بدون خط فرمان

**[→ همین الان نصب کن](https://flash-wizard.imsoroush.workers.dev/)**

> ⚠️ **حتماً دامنه‌ی شخصی استفاده کن.** اسکنرها `*.workers.dev` را ۲۴ ساعته می‌پایند و گزارش خودکار می‌دهند — اکانت‌ها اینطوری ساسپند شدن. یه دامنه‌ی $۳ در سال روی Cloudflare تو رو از رادار خارج می‌کنه.

---

## 📖 مستندات

- [نصب دستی و مشکلات رایج](#)
- 🪄 [فلش ویزارد](https://github.com/CheginiSoroush/flash-wizard) — ابزار نصب

## 🙏 اعتبار

فلش پنل یه هارد‌فورک از [BPB-Worker-Panel](https://github.com/bia-pain-bache/BPB-Worker-Panel) است — تشکر فراوان از [bia-pain-bache](https://github.com/bia-pain-bache) و جامعه‌ی BPB برای پایه‌ی محکم.

**لایسنس:** GPL-3.0 — فایل [LICENSE](LICENSE)

<div align="center">

---

**⚡ فلش پنل** — *سریع، چون برای سریع بودن مهندسی شده.*

</div>
</div>
