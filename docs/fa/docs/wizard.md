# :material-new-box:{ .md .middle } راه‌اندازی خودکار با فلش ویزارد

برای ساده‌تر کردن فرآیند راه‌اندازی و جلوگیری از اشتباهات کاربرها، پروژه [فلش ویزارد](https://github.com/CheginiSoroush/flash-wizard) در دو نسخه تحت وب و ترمینال برای سیستم‌عامل‌های مختلف راه‌اندازی شده. این ابزار از هر دو روش Workers و Pages پشتیبانی می‌کنه و فقط چند ثانیه زمان می‌بره تا پنل رو نصب کنه.

<p align="center" class="img-wrapper">
  <img src="/flash-panel/images/wizard-web.jpg" width="400" alt="wizard-web" />
  <img src="/flash-panel/images/wizard-cli.jpg" width="400" alt="wizard-cli" />
</p>

## ۱. حساب Cloudflare

برای استفاده از این روش، فقط به یه حساب Cloudflare نیاز دارید. می‌تونید [از اینجا ثبت‌نام کنید](https://dash.cloudflare.com/sign-up/). بعدش یادتون نره ایمیلتون رو چک کنید تا حساب رو تأیید کنید.

## ۲. نصب فلش پنل

### نسخه تحت وب

این نسخه بدون تنظیمات خاصی قابل استفاده هست، با توجه به مراحل ذکر شده در صفحه یه Token می‌سازید و پنل رو نصب می‌کنید.

بعد از اولین نصب هم بهتون یه `Private Link` میده که قابلیت نصب تک کلیک رو روی اکانتتون فعال می‌کنه.

```url title="نصب آنلاین"
# لینک زنده در مخزن فلش ویزارد منتشر می‌شود:
# https://github.com/CheginiSoroush/flash-wizard
```

### نسخه ترمینال

```bash title="Windows PowerShell"
# دستور نصب در مخزن فلش ویزارد منتشر می‌شود:
# https://github.com/CheginiSoroush/flash-wizard
```

```bash title="Android (Termux) - Linux - macOS"
# دستور نصب در مخزن فلش ویزارد منتشر می‌شود:
# https://github.com/CheginiSoroush/flash-wizard
```

!!! warning "توصیه‌های استفاده از Termux"
    حتماً Termux رو از [منبع رسمی](https://github.com/termux/termux-app/releases/latest) دانلود و نصب کنید. نصب از گوگل پلی ممکنه مشکلاتی ایجاد کنه. ترجیحا قبل از اجرا فیلترشکن رو قطع کنید.
