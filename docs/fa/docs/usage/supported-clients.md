# :material-fingerprint:{ .md .middle } برنامه‌های پشتیبانی‌شده

در این قسمت می‌تونید حداقل نسخه مورد نیاز برای اتصال بدون مشکل به کانفیگای فلش پنل رو ببینید و همچنین آخرین نسخه پایدار برنامه‌ها رو دانلود کنید.

تعداد دیگه‌ای از برنامه‌ها هم هستن که خیلی خوبن ولی یا دیر به دیر بروزرسانی میشن یا فرمت کانفیگاشون با فرمت استاندارد هسته‌ها متفاوته و اینجا قید نشدن.

## جدول برنامه‌ها

این همون فهرستی هست که ربات تلگرام با دستور `/clients` نشون می‌ده:

| برنامه | حداقل نسخه | منبع دانلود | پلتفرم |
| --- | --- | --- | --- |
| **v2rayNG** | 2.2.3 | Github | اندروید |
| **v2rayN** | 7.22.5 | Github | ویندوز |
| **MahsaNG** | 17 | Google Play | اندروید |
| **Streisand** | 1.6.71 | App Store | iOS / macOS |
| **sing-box** | 1.12.0 | Github | اندروید / iOS / دسکتاپ |
| **husi** | 1.3.2 | Codeberg | اندروید |
| **NekoBox** | 1.3.2 | Github | اندروید |
| **Clash Meta** | 2.11.31 | Github | اندروید |
| **Clash verge rev** | 2.5.1 | Github | دسکتاپ (ویندوز / لینوکس / macOS) |
| **FlClash** | 0.8.94 | Github | اندروید / دسکتاپ |
| **Stash** | 3.4.1 | App Store | iOS / macOS |
| **Amnezia** | 4.8.21.0 | Github | اندروید / دسکتاپ |
| **Wireguard** | Stable | وب‌سایت رسمی | همه‌ی پلتفرم‌ها |
| **WG Tunnel** | 5.1.0 | Github | اندروید |

از ربات تلگرام، بعد از انتخاب هر برنامه، دکمه‌ی **Get latest version** مستقیم به صفحه‌ی دانلود آخرین نسخه‌ی پایدار همون برنامه می‌ره.

## کدام اشتراک برای کدام برنامه؟

هر اشتراک پنل برای یک یا چند هسته ساخته می‌شه و لیست برنامه‌های سازگارش کنار همون لینک (توی پنل و ربات) هم میاد:

| اشتراک | هسته | برنامه‌ها |
| --- | --- | --- |
| **Normal** | Xray | v2rayN(G)، MahsaNG، Streisand |
| | sing-box | sing-box، husi |
| | Clash | Clash Meta، Clash Verge، FlClash، Stash |
| **Fragment** | Xray | v2rayN(G)، MahsaNG، Streisand |
| | sing-box | sing-box، husi |
| **Raw** | Xray | v2rayN(G)، Shadowrocket، Streisand، PassWall |
| | sing-box | husi، NekoBox، Hiddify، Karing |
| **Warp** | Xray | v2rayN(G)، Streisand |
| | sing-box | sing-box، husi |
| | Clash | Clash Meta، Clash Verge، FlClash، Stash |
| | WireGuard | Wireguard |
| **Warp Pro** | Xray | v2rayN(G)، Streisand |
| | Xray-Knocker | MahsaNG، v2rayN-PRO |
| | Clash | Clash Meta، Clash Verge، FlClash، Stash |
| | Amnezia | Amnezia، WG Tunnel |

!!! note "یادداشت"
    کانفیگ‌های **Fragment** فقط در هسته‌های Xray و sing-box ارائه می‌شن؛ برنامه‌های مبتنی بر Clash از fragment پشتیبانی نمی‌کنن. برنامه‌های مبتنی بر WireGuard هم برای اشتراک **Warp** و **Warp Pro** فایل کانفیگ زیپ می‌گیرن، نه لینک اشتراک.

## نکات ایمپورت

- **از ربات راحت‌تره:** با `/config` برای هر نوع اشتراک، QR code + لینک + فایل JSON (یا زیپ برای WireGuard/Amnezia) می‌گیرید. لینک sing-box به‌صورت deep link میاد و با یک لمس ایمپورت می‌شه.
- **v2rayNG:** بعد از ایمپورت، توی `Asset files` فایل‌های Geo رو آپدیت کنید وگرنه با Routing فعال ممکنه وصل نشید.
- **برنامه‌های Clash:** فقط نسخه‌های مبتنی بر هسته‌ی Meta (mihomo) رو نصب کنید — همون‌هایی که توی جدول بالا تأیید شدن؛ هسته‌ی قدیمی Clash از قالب کانفیگ‌های پنل پشتیبانی نمی‌کنه.
- **اشتراک Raw:** Remote DNS باید دستی توی برنامه روی DoH/DoT/TCP ست بشه و Mux خاموش باشه؛ جزئیات توی [اشتراک Raw](raw.md).
- **اپراتورهای دارای IPv6** (مثل رایتل و ایرانسل): IPv6 سیم‌کارت رو فعال و گزینه‌ی Prefer IPv6 برنامه رو روشن کنید و از دو کانفیگ آخر استفاده کنید.
- **کانفیگ‌های شخصی** که از [External Configs](../configuration/external-configs.md) اضافه می‌کنید، به اندازه‌ی هسته‌ی برنامه‌ی مقصد محدودن؛ مثلاً XHTTP روی هسته‌های قدیمی sing-box کار نمی‌کنه.
