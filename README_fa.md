<div dir="rtl" align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&color=0:78350f,50:f59e0b,100:ea580c&height=230&section=header&text=%E2%9A%A1%20FLASH%20PANEL&fontSize=58&fontColor=fff8eb&animation=twinkling&fontAlignY=36&desc=Serverless%20VLESS%20%C2%B7%20Trojan%20%C2%B7%20WARP%20proxy%20panel%20for%20Cloudflare%20Workers&descAlignY=57&descSize=17" alt="Flash Panel" width="100%" />

<img src="assets/readme/hero.svg" alt="نماد فلش پنل — برق متحرک، حلقه‌های چرخان و ذرات مداری" width="720" />

<img src="https://readme-typing-svg.demolab.com?font=Vazirmatn&weight=700&size=22&duration=2600&pause=800&color=F59E0B&center=true&vCenter=true&width=820&height=70&lines=%D8%B3%D8%B1%DB%8C%D8%B9+%D9%85%D8%AB%D9%84+%D8%A8%D8%B1%D9%82;VLESS+%C2%B7+TROJAN+%C2%B7+WARP+%D8%B1%D9%88%DB%8C+Cloudflare+Workers;%D9%85%D9%87%D9%86%D8%AF%D8%B3%DB%8C+%D9%85%D8%B9%DA%A9%D9%88%D8%B3%E2%80%8C%D8%B4%D8%AF%D9%87+%D8%A8%D8%B1%D8%A7%DB%8C+%D9%84%D8%A8%D9%87;%D8%A8%D8%AF%D9%88%D9%86+%D8%B3%D8%B1%D9%88%D8%B1+%D9%88+%D8%A8%D8%AF%D9%88%D9%86+%D9%87%D8%B2%DB%8C%D9%86%D9%87" alt="فلش پنل در یک خط" />

[![Release](https://img.shields.io/github/v/release/CheginiSoroush/flash-panel?style=for-the-badge&logo=github&label=Release&color=f59e0b)](https://github.com/CheginiSoroush/flash-panel/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/CheginiSoroush/flash-panel/ci.yml?branch=main&style=for-the-badge&logo=githubactions&label=CI&color=34d399)](https://github.com/CheginiSoroush/flash-panel/actions)
[![Tests](https://img.shields.io/badge/Tests-439%20passing-34d399?style=for-the-badge&logo=vitest&logoColor=white)](https://github.com/CheginiSoroush/flash-panel/actions)
[![Bundle](https://img.shields.io/badge/Bundle-138%20KB%20gzip-f59e0b?style=for-the-badge&logo=esbuild&logoColor=white)](https://github.com/CheginiSoroush/flash-panel/blob/main/scripts/build.js)

[![Platform](https://img.shields.io/badge/Platform-Cloudflare%20Workers-F38020?style=for-the-badge&logo=cloudflare&logoColor=white)](#-چطور-یک-درخواست-جریان-مییابد)
[![License](https://img.shields.io/github/license/CheginiSoroush/flash-panel?style=for-the-badge&label=License&color=e11d48)](LICENSE)
[![Repo](https://img.shields.io/github/repo-size/CheginiSoroush/flash-panel?style=for-the-badge&label=Repo&color=fb7185)](#)
[![Visitors](https://hits.sh/github.com/CheginiSoroush/flash-panel.svg?style=for-the-badge&color=f59e0b)](https://github.com/CheginiSoroush/flash-panel)

[🇬🇧 English](README.md) · [🪄 فلش ویزارد](https://github.com/CheginiSoroush/flash-wizard) · [⬆ نصب](#-نصب)

</div>

<div dir="rtl">

<div align="center">

<img src="assets/readme/divider.svg" alt="جداکننده‌ی متحرک" width="70%" />

### ⚡ یک نگاه

| | | | |
|:---:|:---:|:---:|:---:|
| **۰** سرور | **۳** هسته‌ی کانفیگ | **۳۹۱** تست واحد | **۱۳۷ کیلوبایت** gzip |
| **ETag** و ۳۰۴ آنی | **gzip** روی ساب‌ها | **QR** مموایز | **۳ آینه‌ای** سلف‌آپدیت |
| **۲۴/۷** خودتیون | **تلمتری لبه** | **ضداسکنر** | **۱۰۰٪** بدون سرور |

<img src="assets/readme/divider.svg" alt="جداکننده‌ی متحرک" width="70%" />

</div>

## 🌀 چطور یک درخواست جریان می‌یابد

<div align="center">

<img src="assets/readme/architecture.svg" alt="دیاگرام متحرک: کلاینت از لبه‌ی Cloudflare (فلش پنل) به مقصد وصل می‌شود — بسته‌ها در حرکت‌اند و لبه تلمتری می‌فرستد و خودش را تیون می‌کند" width="820" />

</div>

هر اتصال **گیت توکن** دارد، اندازه‌گیری می‌شود و به‌خاطر سپرده می‌شود — پنل از ترافیک خودش یاد می‌گیرد و خودش را دوباره تیون می‌کند. هیچ فورکی این را ندارد.

---

## ✨ چرا فلش؟

اکثر فورک‌ها فقط **اسم** را عوض می‌کنند. فلش پنل **موتور** را بازسازی کرده:

<details open>
<summary><b>🔥 هسته‌ی پروتکل — بازنویسی‌شده از صفر</b></summary>

| فیکس | اثر |
|------|-----|
| باگ race در سوکت | کانکشن‌هایی که وسط handshake می‌مردند → حذف کامل |
| SHA-224 در **هر کانکشن** | کش‌شده — احراز Trojan تقریباً رایگان |
| پارس VLESS با ۱۰ بار کپی | zero-copy — مصرف CPU هر کانکشن کاهش |
| قفل writer در هر chunk | کش‌شده — توان پایدار |
| خواندن KV در **هر درخواست** | کش سطح isolate + TTL |
| تولید دوباره‌ی کانفیگ در هر fetch | ETag/304 — سرو آنی وقتی چیزی عوض نشده |
| JSON با تورفتگی (~۲۰MB) | فشرده — **ساب‌ها ۹۴٪ کوچک‌تر** |

</details>

<details open>
<summary><b>🛰️ هوش لبه — پنلی که خودش را می‌بیند</b> <i>(v0.8.4 / v0.8.5)</i></summary>

اکثر پنل‌ها کور پرواز می‌کنند. فلش پنل متادیتای خود Cloudflare را به یک **حلقه‌ی بسته‌ی کنترل کیفیت** تبدیل کرد:

- 🛰️ **تلمتری `request.cf`** — هر handshake واقعی WS (بعد از گیت توکن) و ۲۵٪ واکشی‌های ساب بی‌صدا `colo`، `clientTcpRtt`، `ASN + اپراتور`، `tlsVersion` و `httpProtocol` را ثبت می‌کنند. بدون ping اضافه، **بدون ذخیره‌ی IP** — کلاینت‌های خودت می‌شوند ناوگان پروب
- 📊 **شمارش بایت هر کانکشن** — بایت up/down و مدت هر اتصال WS با صفر هزینه در مسیر داغ (WeakMap، با بسته‌شدن GC) → «کدام ISP چقدر ترافیک از کدام دیتاسنتر رد می‌کند»
- 💰 **مهندسی سهمیه‌ی پلن رایگان** — بافر داخل isolate → flush بچی (۱۲ نمونه / ۱۵ ثانیه)، سقف ۲۰۰۰ نمونه در روز، ۴۰ flush برای هر isolate، هرس ۴۸ ساعته، top-12 دیتاسنتر + top-24 اپراتور → خیلی زیر ۱۰۰۰ نوشتن KV در روز
- 🎯 **تیون خودکار حلقه‌بسته** — خط پایه‌ی روزانه‌ی RTT (EMA با ۸۵/۱۵)؛ وقتی میانگین امروز می‌پرد (≥ +۴۰ms **و** ≥ ۱٫۵×، حداقل ۸ نمونه) تیونرهای **ProxyIP / CleanIP خودکار بیدار می‌شوند** و تلگرام لیست بدترین ASNها را می‌گیرد (کول‌داون تیون ۶ ساعت / هشدار ۱۲ ساعت)
- 🧭 **همه‌جا قابل‌دیدن** — دستور `/edge` ربات، یک خط در خلاصه‌ی روزانه و اندپوینت احرازهویت‌شده‌ی پنل با نمایش خوانای بایت (B تا TB)
- 🔬 **ترنسپورت‌های مهندسی‌معکوس‌شده** — HTTPUpgrade سمت سرور *مجانی* است (اثبات: `101 Switching Protocols`) ولی در کلاینت‌های مدرن Xray مرده است → ۳۵ پروفایل مرده ساخته، تست و **قبل از رسیدن به پروداکشن کشته شدند**؛ مسیر واقعی آینده XHTTP + Durable Objects است (کاندیدای v0.9.0)
- 🩺 **جナیدن حوادث** — امضای «کانکشن صفر-بایتی» (۱۱۱ پاس می‌شود ولی هیچ بایتی رد و بدل نمی‌شود) خرابی خروجی پلتفرم را از رگرسیون کد جدا می‌کند

</details>

<details>
<summary><b>🛡️ امنیت — نه به‌عنوان فکر ثانوی</b></summary>

- 🔐 **محدودسازی نرخ لاگین** + مقایسه‌ی constant-time
- 🤖 **اعتبارسنجی webhook تلگرام** — رد آپدیت‌های جعلی
- 🔒 صفحه‌ی لاگین / تنظیمات / ساب‌ها کاملاً جدا از هم
- ⚡ مسیر `workers.dev` **خودکار خاموش** — خارج از رادار اسکنرها (گارد هر ۳۰ دقیقه دوباره چک می‌کند و در تلگرام خبر می‌دهد)

</details>

<details>
<summary><b>⚙️ اتوماسیون — پنل خودش خودش را می‌چرخاند</b></summary>

یک‌بار cron trigger را ست کن (`'0 * * * *'` در `wrangler.jsonc`)؛ بقیه‌اش با پنل:

- ⏰ **انقضای خودکار کاربران اشتراک** — برای هر کاربر تاریخ انقضا بگذار؛ لینک‌هایش همان ثانیه‌ی گذشتن می‌ایستند (سلف-اجرا در لحظه‌ی resolve، حتی بدون cron)، sweep ساعتی وضعیت را در پنل به «منقضی» می‌برد و تو در تلگرام خبر می‌شوی
- 📋 **خلاصه‌ی روزانه (digest)** — روزی یک پیام: مصرف در برابر سهمیه، تعداد فعال/منقضی/لغوشده، انقضاهای پیش‌رو، پرکارترین کاربران و یک خط تلمتری لبه (روی‌تقاضا هم: `/digest`)
- 🔴 **هشدار مصرف** — یک‌بار وقتی کل درخواست‌ها از ۸۰٪ سهمیه‌ی روزانه‌ی Free رد شود
- 📊 **نمونه‌گیری مصرف بدون بازدید** — نمودار ۳۱ روزه حتی در روزهایی که کسی پنل را باز نمی‌کند کامل می‌ماند
- ⚡ **انتخاب خودکار بهترین ProxyIP** — یک کلیک همه‌ی ProxyIP های تنظیم‌شده را تست می‌کند (دسته‌ای، ۲ تلاش هرکدام) و ورکر را با سریع‌ترین سالم به‌عنوان هدف اصلی مجدداً دیپلوی می‌کند
- 🧹 **گارد workers.dev** — اگر کسی پیش‌نمایش `*.workers.dev` را دوباره روشن کند، تیک بعدی دوباره می‌بنددش تا اسکنرها نچسبند

</details>

<details>
<summary><b>⚡ کارایی — CPU کمتر، دیتای کمتر</b></summary>

- 🧠 **کش بدنه‌ی اشتراک بر اساس ETag** — کانفیگ‌های تولیدشده (JSON ایکس‌ری / YAML کلش / base64 رَو) با کلید ETag در حافظه‌ی isolate مموایز می‌شوند؛ ETag از قبل نسخه + همه‌ی تنظیمات + کلاینت + کاربر را پوشش می‌دهد. واکشی تکراری در بازه‌ی ۵ دقیقه‌ای TTL تولید کانفیگ را *کاملاً* رد می‌کند — بدون resolve دامنه، بدون ساخت JSON، بدون btoa — تقریباً صفر CPU برای پرترافیک‌ترین اندپوینت
- 🗜️ **پاسخ اشتراک با gzip** — بدنه‌های ≥ ۱ کیلوبایت وقتی کلاینت `Accept-Encoding: gzip` فرستاده (v2rayNG، Hiddify، Streisand و بقیه می‌فرستند) با `CompressionStream` بومی فشرده می‌شوند. JSON/YAML کانفیگ ~۷۰-۸۰٪ فشرده می‌شود — مصرف دیتای موبایل روی هر آپدیت مستقیماً کم می‌شود و `Vary: Accept-Encoding` هم نسخه‌ها را قاطی نمی‌کند
- 🖼️ **مموایز QR** — انکودر PNG کیوآر (حلقه‌ی RGBA + deflate) برای هر لینک یکتا فقط یک‌بار اجرا می‌شود؛ باز کردن دوباره‌ی مودال QR در پنل صفر CPU دارد. هدر کش مرورگر (`max-age=3600`) هم درخواست دوباره را کلاً منتفی می‌کند
- 🔧 **بهداشت ریز** — `TextEncoder` سطح ماژول برای هش ETag، اسنپ‌شات هدرها همراه با کش به‌جای بازسازی per-request

همه‌شان محدودِ حافظه هستند (LRU + سقف اندازه) و با تست واحد پوشش داده شده‌اند — **۳۹۱/۳۹۱ سبز در ۲۶ فایل**.

</details>

<details>
<summary><b>🧭 ضد ۴۰۳ — کانفیگ‌هایی که فقط وصل می‌شوند</b></summary>

خطای ۴۰۳ یعنی آدرس اتصال (معمولاً `workers.dev`) از سمت ISP بلاک شده. حالا پنل خودش می‌جنگد:

- 🧪 **بهینه‌ساز Clean IP** (صفحه‌ی `/clean-ip`) — یک کلیک **Auto-optimize**: کاندیداهای تازه از جمع‌کننده‌های عمومی می‌گیرد، همه‌ی Clean IP ها + کاندیدها را پروب می‌کند (پروب لبه، ۲ تلاش)، لیست را «سالم‌ها اول، سریع‌ترین بالا» بازآرایی می‌کند، تا ۵ آی‌پی سالم تازه اضافه می‌کند و redeploy می‌کند — کل چرخه بدون دست‌زدن به فرم تنظیمات
- 🥇 **Clean IPs First (ضد ۴۰۳)** — وقتی فعال باشد Clean IP ها *اولین* آدرس اتصال در همه‌ی کانفیگ‌های تولیدی می‌شوند، به‌جای دامنه‌ی (اغلب بلاک‌شده‌ی) ورکر
- 🩺 **سلامت و تأخیر تک‌تک اندپوینت‌ها** — هر ردیف نرخ موفقیت و تأخیر TCP را نشان می‌دهد؛ اندپوینت مرده یک‌نگاه مشخص می‌شود
- 📰 **هدرهای هوشمند اشتراک** — `profile-update-interval`، `profile-web-page-url` و `subscription-userinfo` (شمارش معکوس انقضا برای کاربران اشتراک) به کلاینت‌های مدرن (Hiddify، v2rayNG، Streisand) سرو می‌شود

</details>

<details>
<summary><b>✈️ تلگرام — درجه‌یک از داخل تونل</b></summary>

پروکسی MTProto کلاسیک روی Cloudflare Workers ممکن نیست (کلاینت‌های تلگرام به پروکسی MTProto با TCP خام وصل می‌شوند — ورکر فقط HTTP/WebSocket می‌پذیرد). اشتراک شما تلگرام را از راه مطمئن تونل می‌کند:

- 🧲 **روتینگ تلگرام (همیشه از تونل)** — پیش‌فرض: روشن؛ قوانین صریح در همه‌ی کانفیگ‌های تولیدی (Xray / sing-box / Clash) دامنه‌های رسمی تلگرام و **هر ۱۳ رنج دیتاسنتر** (IPv4 + IPv6) را از تونل عبور می‌دهند — *قبل از* قوانین block/bypass، یعنی حتی پروفایل‌های `bypass Iran/China` هم نمی‌توانند تلگرام را به مسیر مستقیم بفرستند
- 🧾 **بدون وابستگی به فایل geo** — قوانین، لیست دامنه/IP ساده‌ی داخل خود کانفیگ‌اند: نیازی به دانلود geosite نیست و با فایل‌های geo قدیمی کلاینت هم کار می‌کند
- 🤖 **دستور `/tg` ربات** — راهنمای قدم‌به‌قدم اتصال تلگرام (v2rayNG / Hiddify / Streisand) مستقیم از ربات
- 📞 **نکته‌ی صادقانه‌ی تماس‌ها** — کانفیگ‌های عادی پیام، رسانه و فایل را حمل می‌کنند (TCP)؛ برای تماس صوتی/تصویری از نوع اشتراک **Warp** استفاده کنید (UDP)

</details>

<details>
<summary><b>🤖 ربات تلگرام — کنترل کامل از جیب</b></summary>

URL پنل معمولاً فیلتره. تلگرامت نه.

```text
/config    — دریافت کانفیگ + QR
/status    — نمای کلی پنل
/edge      — تلمتری لبه: RTT/بایت برای هر دیتاسنتر و اپراتور
/tg        — راهنمای اتصال تلگرام
/users     — آمار هر کاربر + شمارش معکوس انقضا
/digest    — خلاصه‌ی روزانه روی تقاضا
/settings  — ۱۸ تنظیم قابل‌ویرایش (DNS، پروتکل‌ها، IP های تمیز، مسیریابی...)
/restart   — ریست آنی کش
```

</details>

<details>
<summary><b>🔄 آپدیت خودکار پنل — مقاوم به ۴۰۳ گیت‌هاب</b></summary>

دکمه‌ی **Update panel** آخرین `worker.js` را می‌گیرد و با همان تنظیمات شما redeploy می‌کند. قبلاً دانلود سمت سرور از Releases گیت‌هاب از روی IPهای مشترک لبه‌ی کلادفلر اغلب `۴۰۳/۴۲۹` می‌گرفت — موتور جدید:

- **۳ آینه با fallback خودکار** — GitHub Releases → آینه‌ی GitHub Pages (`site/download/worker.js`، با هر ریلیز بازنشر می‌شود) → CDN جی‌دلیور
- **تلاش مجدد با backoff** روی `403/429/5xx`/تایم‌اوت؛ `404` فوراً می‌رود آینه‌ی بعد
- **اعتبارسنجی محتوا** — صفحه‌ی خطای HTML یا بدنه‌ی ناقص هرگز deploy نمی‌شود (چک طول + `export default`)
- **کش ۱۰ دقیقه‌ای لبه + ادغام درخواست‌های هم‌زمان** — کلیک‌های پشت‌سرهم صفر fetch اضافه
- **خطای صادقانه** — نوتیف پنل حالا دلیل واقعی را نشان می‌دهد (۴۰۳ گیت‌هاب / دسترسی توکن / سهمیه) نه فقط «try again»
- **فال‌بک چک نسخه سمت مرورگر** — اول `raw.githubusercontent.com`، بعد جی‌دلیور

> 💡 اگر پنل شما قدیمی‌تر از **v0.7.1** است و دکمه‌ی آپدیت خطا داد، چند دقیقه بعد دوباره امتحان کنید (۴۰۳ گذراست) یا `worker.js` را دستی از داشبورد کلادفلر / فلش ویزارد آپلود کنید — بعد از آن همه‌ی آپدیت‌های بعدی از موتور آینه‌ای می‌روند.

</details>

<details>
<summary><b>🧪 مهندسی — مثل نرم‌افزار واقعی</b></summary>

- **۳۹۱ تست واحد** در ۲۶ فایل — پارسرهای پروتکل، اعتبارسنج‌های تنظیمات، مهاجرت KV، کاربران اشتراک، تلمتری، تیونرها، گاردها
- **CI روی هر push** — typecheck → تست → بیلد → **گیت حجم باندل** (gzip ≤ ۱۵۰ کیلوبایت، ~۴٫۵٪ سقف پلن رایگان Workers)
- **Release خودکار** — tag → build → publish → آینه‌ی Pages
- **آپدیت خودکار از پنل** — بدون downtime با موتور ۳ آینه‌ای

</details>

---

<div align="center">

<img src="assets/readme/divider.svg" alt="جداکننده‌ی متحرک" width="70%" />

### 📊 بنچمارک — در برابر فورک‌های «بهینه‌شده»

*تنظیمات یکسان، IP های یکسان، پورت‌های یکسان — کنار هم*

| | فلش پنل | فورک دیگر |
|---|:---:|:---:|
| کانفیگ سالم | **۷۲ از ۸۵** ✅ | ۵۹ از ۸۵ |
| کمترین پینگ | **فلش** ✅ | — |

**+۲۲٪ کانفیگ سالم بیشتر** — اندازه‌گیری‌شده، نه ادعا.

<img src="assets/readme/divider.svg" alt="جداکننده‌ی متحرک" width="70%" />

</div>

---

## 🚀 نصب

### 🪄 فلش ویزارد — ۶۰ ثانیه، بدون خط فرمان

**[→ فلش ویزارد را خودت نصب کن](https://github.com/CheginiSoroush/flash-wizard)**

> ⚠️ **هرگز URL زنده‌ی پنلت را جایی منتشر نکن.** اسکنرها `*.workers.dev` را ۲۴ ساعته می‌پایند و گزارش خودکار می‌دهند — اکانت‌ها اینطوری ساسپند شدن. یه دامنه‌ی $۳ در سال روی Cloudflare تو رو از رادار خارج می‌کنه. اسم workers.dev ویزارد را هم خصوصی نگه دار (فقط یک‌بار موقع نصب لازمش داری).

### نصب دستی

```bash
npm install
cp wrangler.jsonc.example wrangler.jsonc
# فایل را ویرایش کن: account_id و شناسه‌ی KV namespace، بعد بیلد و deploy:
npm run check && npm run test && npm run build
npx wrangler deploy
```

اعتبارنامه‌ها (`EMBEDED_SETTINGS`) در زمان deploy توسط **فلش ویزارد** تزریق می‌شوند. برای نصب کاملاً دستی، این بلاک را به ابتدای `dist/worker.js` اضافه کن (مقادیر را با مال خودت عوض کن):

```js
Object.assign(globalThis, { EMBEDED_SETTINGS: {
    accID: "<شناسه اکانت>", accEmail: "<ایمیل اکانت>", apiToken: "<توکن اسکوپ‌دار>",
    vlUUID: "<uuid>", trPass: "<رمز تروجان>", securePath: "<مسیر مخفی>",
    proxyIpMode: "proxyip", proxyIPs: [], prefixes: [],
    mainDomain: "<دامنه تو>", fallback: "www.speedtest.net", dohUrl: ""
}});
```

> ویزارد همه‌ی این‌ها را خودکار انجام می‌دهد — نصب دستی برای CI و حالت‌های خاص است.

---

## 📈 آمار

<div dir="ltr" align="center">

<table>
<tr>
<td width="50%">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://github-readme-stats.vercel.app/api?username=CheginiSoroush&show_icons=true&hide_border=true&bg_color=00000000&title_color=f59e0b&icon_color=fb7185&text_color=e6edf3" />
  <img src="https://github-readme-stats.vercel.app/api?username=CheginiSoroush&show_icons=true&hide_border=true&bg_color=00000000&title_color=b45309&icon_color=ea580c&text_color=57606a" alt="GitHub stats" />
</picture>

</td>
<td width="50%">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://streak-stats.demolab.com?user=CheginiSoroush&hide_border=true&background=00000000&stroke=f59e0b&ring=f97316&fire=fbbf24&currStreakNum=e6edf3&sideNums=e6edf3&currStreakLabel=f59e0b&sideLabels=a8a29e&dates=9ca3af" />
  <img src="https://streak-stats.demolab.com?user=CheginiSoroush&hide_border=true&background=00000000&stroke=ea580c&ring=f59e0b&fire=ea580c&currStreakNum=24292f&sideNums=24292f&currStreakLabel=b45309&sideLabels=6e7781&dates=57606a" alt="GitHub streak" />
</picture>

</td>
</tr>
</table>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://github-readme-stats.vercel.app/api/top-langs/?username=CheginiSoroush&layout=compact&hide_border=true&bg_color=00000000&title_color=f59e0b&text_color=e6edf3&langs_count=8" />
  <img src="https://github-readme-stats.vercel.app/api/top-langs/?username=CheginiSoroush&layout=compact&hide_border=true&bg_color=00000000&title_color=b45309&text_color=57606a&langs_count=8" alt="Top languages" width="42%" />
</picture>

### 🐍 مار بی‌پایان contribution

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/CheginiSoroush/flash-panel/output/github-contribution-grid-snake-dark.svg" />
  <img src="https://raw.githubusercontent.com/CheginiSoroush/flash-panel/output/github-contribution-grid-snake.svg" alt="انیمیشن مار contribution" width="100%" />
</picture>

</div>

### 🧰 ساخته‌شده با

<div align="center">

<img src="https://skillicons.dev/icons?i=ts,js,bun,cloudflare,git,github,linux,vscode&perrow=8" alt="TypeScript، JavaScript، Bun، Cloudflare، Git، GitHub، Linux، VS Code" />

<details>
<summary><b>⭐ تاریخچه‌ی ستاره‌ها</b></summary>

<div dir="ltr">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=CheginiSoroush/flash-panel&type=Date&theme=dark" />
  <img src="https://api.star-history.com/svg?repos=CheginiSoroush/flash-panel&type=Date&theme=light" alt="نمودار تاریخچه‌ی ستاره‌ها" width="80%" />
</picture>

</div>

</details>

</div>

---

## 📖 مستندات

- 🇬🇧 [English README](README.md)
- 📚 [مستندات داخل ریپو (فارسی)](docs/fa/docs/index.md) · [In-repo docs (EN)](docs/en/docs/index.md)
- 🪄 [فلش ویزارد](https://github.com/CheginiSoroush/flash-wizard) — ابزار نصب

## 👤 سازنده

فلش پنل ساخته، متعلق به و نگهداری‌شده توسط [CheginiSoroush](https://github.com/CheginiSoroush) است.

<div align="center">

<img src="https://contrib.rocks/image?repo=CheginiSoroush/flash-panel" alt="مشارکت‌کنندگان" />

**لایسنس:** GPL-3.0 — فایل [LICENSE](LICENSE)

<img src="assets/readme/divider.svg" alt="جداکننده‌ی متحرک" width="70%" />

<img src="https://capsule-render.vercel.app/api?type=waving&color=0:ea580c,50:f59e0b,100:78350f&height=140&section=footer&text=fast%20because%20it%20is%20engineered%20to%20be&fontSize=20&fontColor=fff8eb&animation=fadeIn&fontAlignY=70" alt="پایان" width="100%" />

</div>
</div>
