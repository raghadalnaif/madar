# مدار — معلومات السيرفر

## السيرفر الإنتاجي
- **IP:** 207.180.202.200
- **User:** root
- **Path:** /var/www/madar-new
- **الدومين:** ma-dar.solutions (و www.ma-dar.solutions)

هذا سيرفر مستقل تماماً عن مشروع "مدارك" القديم (الذي يعمل من `/var/www/madarek` على نفس الجهاز) — مجلد مختلف، منفذ باك-إند مختلف، قاعدة بيانات مختلفة. لا تُنشئي أي رابط أو اعتماد بينهما.

## أمر النشر
```bash
ssh root@207.180.202.200 "cd /var/www/madar-new && git pull origin main"
```

## الباك-إند (خادم تخزين البيانات)
- خدمة systemd: `madar-new-api`
- المنفذ: `3010` (على 127.0.0.1 فقط، خلف nginx)
- ملف البيئة (يحوي `PLATFORM_TOKEN`): `/etc/madar-new-api.env`
- قاعدة البيانات: `/var/www/madar-new/server/data.db` (SQLite)
- بعد أي تحديث لـ`server/server.js`: `systemctl restart madar-new-api`

## nginx
- ملف الإعداد: `/etc/nginx/sites-available/ma-dar` (مفعّل عبر symlink في `sites-enabled`)
- يخدم `/var/www/madar-new` مباشرة، ويمرّر `/api/` و`/api/stream` إلى `127.0.0.1:3010`

## ملاحظات
- ملف واحد رئيسي: `index.html` (نظام متعدد المدارس — كل مدرسة تسجّل حسابها الخاص وبياناتها معزولة تماماً عن غيرها)
- BUILD version string موجود في `<head>` بأول index.html
- لوحة تحكم مزوّد الخدمة (لإدارة كل المدارس المشتركة): الرابط + `#provider`
