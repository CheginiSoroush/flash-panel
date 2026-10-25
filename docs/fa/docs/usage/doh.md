# :material-playlist-check:{ .md .middle } DNS over HTTPS (DoH)

از اونجایی که بیشتر سرورهای عمومی معروف DoH توسط فایروال‌ها مسدود شدن، می‌تونیم از domain fronting استفاده کنیم تا بتونیم با موفقیت فایروال رو دور بزنیم. فلش پنل DoH فقط از سرورهای استاندارد DoH بر اساس RFC 8484 پشتیبانی می‌کنه که معمولاً در فرمت `https://domain/dns-query` هستن. مثلاً گوگل دو نوع DoH داره: `https://dns.google/dns-query` که RFC 8484 هست و `https://dns.google/resolve` که API JSON هست. فلش پنل فقط از نوع اول پشتیبانی می‌کنه.

!!! warning "هشدار"
    از فلش پنل DoH برای remote DNS استفاده نکنید، وگرنه درخواست‌های worker‌تون رو هدر می‌دید. بهتره در مرورگرها یا کلاینت‌های مبتنی بر DoH مثل Intra و Rethink ازش استفاده کنید.

## آدرس Endpoint

سرور DoH پنل روی همون مسیر امن پنل سرو می‌شه:

```
https://<دامنه‌ی ورکر>/<securePath>/dns-query
```

`securePath` همون مسیری هست که پنل و لینک‌های اشتراک باهاش محافظت می‌شن؛ بدون اون هیچ پاسخی نمی‌گیرید (فقط صفحه‌ی پوششی). آدرس کامل سرور DoH شما انتهای پنل، توی بخش **DNS over HTTPS** نمایش داده می‌شه. فیلد **Underlying DoH** توی تنظیمات هم تعیین می‌کنه بالادستیِ این سرور چی باشه (پیش‌فرض `https://cloudflare-dns.com/dns-query` که می‌تونید به Adguard یا مشابهش تغییر بدید).

## متدهای پشتیبانی‌شده

| متد | نحوه‌ی ارسال کوئری |
| --- | --- |
| `GET` | پیام DNS انکودشده با Base64URL در پارامتر `dns` |
| `POST` | بدنه‌ی درخواست = پیام DNS خام با هدر `Content-Type: application/dns-message` |

هر متد دیگه‌ای پاسخ **405** با هدر `Allow: GET, POST` می‌گیره. کوئری‌های سبک JSON (مثل `?name=example.com&type=A` که مال `dns.google/resolve` هست) جزو RFC 8484 نیستن و پشتیبانی نمی‌شن؛ این‌جور درخواست‌ها بدون کش مستقیم به سرور بالادستی پاس داده می‌شن (هدر `X-DNS-Cache: BYPASS`) و بسته به سرور مقصد معمولاً خطا می‌گیرن. هر کلاینت استاندارد DoH — مرورگرها، Intra، Rethink، هسته‌های Xray/sing-box — wireformat می‌فرسته و مشکلی نداره.

## کش و هدر X-DNS-Cache

سرور DoH پنل یه کش لبه با این ویژگی‌ها داره:

- **TTL واقعی:** کمینه‌ی TTL رکوردهای ANSWER، با کلمپ ۱۰ تا ۳۰۰ ثانیه؛ کش منفی (NXDOMAIN و مشابه) ۳۰ ثانیه.
- **سقف ۲۵۶ ورودی** با جایگزینی LRU — حافظه‌ی isolate مهار می‌شه.
- **Single-flight:** کوئری‌های همزمانِ یکسان فقط یک رفت‌وبرگشت به بالادست دارن.
- **Stale-on-error:** اگه بالادست موقتاً در دسترس نباشه، نسخه‌ی کهنه‌ی کش‌شده سرو می‌شه تا DNS یهو کور نشه.

وضعیت هر پاسخ توی هدر `X-DNS-Cache` برمی‌گرده:

| مقدار | معنی |
| --- | --- |
| `MISS` | پاسخ تازه از بالادست گرفته و کش شد |
| `HIT` | از کش سرو شد |
| `STALE` | بالادست خطا داد؛ نسخه‌ی منقضی‌شده سرو شد |
| `BYPASS` | بدون کش — ورودی غیر استاندارد یا پاس‌دادن مستقیم |

کلید کش از خود سؤال (`qname|qtype`) ساخته می‌شه، نه از ID تصادفی کلاینت؛ بنابراین کوئری‌های یکسان از کلاینت‌های مختلف همدیگه رو HIT می‌کنن و ID هر پاسخ هم به‌درستی با ID کوئریِ درخواست‌کننده بازنویسی می‌شه.

## نمونه با curl

```bash
# GET — کوئری A برای example.com (پیام DNS در پارامتر dns)
curl -sD - \
  "https://YOUR-DOMAIN/YOUR-SECURE-PATH/dns-query?dns=EjQBAAABAAAAAAAAB2V4YW1wbGUDY29tAAABAAE" \
  -o reply.bin

# POST — همون کوئری به‌صورت بدنه‌ی باینری
curl -sD - \
  -H "Content-Type: application/dns-message" \
  --data-binary @query.bin \
  "https://YOUR-DOMAIN/YOUR-SECURE-PATH/dns-query" -o reply.bin
```

برای ساختن `query.bin` کافیه یه پیام DNS استاندارد (RFC 1035) بنویسید:

```bash
python3 - <<'EOF'
import struct
q = (b'\x12\x34\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00'   # ID + RD + QDCOUNT=1
     + b'\x07example\x03com\x00'                            # QNAME: example.com
     + struct.pack('>HH', 1, 1))                            # QTYPE=A, QCLASS=IN
open('query.bin', 'wb').write(q)
EOF
```

پاسخ توی `reply.bin` یه پیام DNS خام (wireformat) هست که با ابزارهایی مثل `dig +wire` یا `kdig` قابل خوندنه.

## پیکربندی کلاینت

- **فایرفاکس:** Settings → Privacy & Security → DNS over HTTPS → Custom، و آدرس سرور DoH پنل رو وارد کنید.
- **Rethink / Intra روی اندروید:** در بخش DNS، نوع DoH رو انتخاب و همین URL رو بدید.
- **هسته‌های Xray و sing-box:** به‌عنوان مقدار DNS از نوع `https` در کانفیگ کلاینت (نه فیلد Remote DNS پنل).

!!! tip "نکته"
    چون این سرور پشت دامنه‌ی خود پنله، مثل بقیه‌ی DoHهای عمومی به‌سادگی فیلتر نمی‌شه؛ ولی مصرف هر کوئری از سهمیه‌ی درخواست روزانه‌ی ورکر کم می‌کنه — برای همین استفاده ازش به‌عنوان Remote DNS توصیه نمی‌شه.
