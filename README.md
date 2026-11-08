# مكتبة الروابط (Link Hub)

## الملفات
- index.html / style.css / app.js : الواجهة والمنطق
- sync.js : الدمج والمزامنة مع Google Drive
- sw.js : عمل التطبيق بدون إنترنت (Service Worker)
- manifest.webmanifest + icons/ : التثبيت كتطبيق

## 1) الاستضافة (إلزامية للـ PWA والمزامنة: لازم HTTPS)
أسهل طريقة GitHub Pages:
1. أنشئ مستودعاً جديداً على GitHub وارفع كل محتويات هذا المجلد (بنفس بنيته).
2. Settings ← Pages ← Branch: main ← Save.
3. سيعمل التطبيق على: https://USERNAME.github.io/REPO/
(بدائل: Netlify Drop أو Cloudflare Pages، كلها مجانية.)

## 2) التثبيت على الجوال
- أندرويد/كروم: القائمة ⋮ في كروم ← "تثبيت التطبيق" (أو من قائمة التطبيق نفسه).
- آيفون/سفاري: مشاركة ← "إضافة إلى الشاشة الرئيسية".
بعد التثبيت على أندرويد يظهر التطبيق في قائمة "مشاركة" لأي رابط في المتصفح.

## 3) تفعيل مزامنة Google Drive (مرة واحدة)
1. افتح https://console.cloud.google.com وأنشئ مشروعاً جديداً.
2. APIs & Services ← Library ← فعّل "Google Drive API".
3. شاشة الموافقة (OAuth consent screen / Google Auth Platform):
   النوع External، واسم التطبيق أي اسم، وأضف بريدك ضمن Test users.
4. Credentials ← Create credentials ← OAuth client ID ← Web application.
   في Authorized JavaScript origins ضع عنوان موقعك بدون مسار، مثل:
   https://USERNAME.github.io
5. انسخ الـ Client ID.
6. إمّا الصقه في التطبيق: القائمة ⋮ ← المزامنة ← Client ID ← حفظ وتفعيل،
   أو ضعه في أعلى sync.js في DEFAULT_CLIENT_ID ليعمل على كل أجهزتك دون إدخاله.
7. اضغط "ربط حساب Google" ووافق. كرّر الربط على كل جهاز (بنفس الحساب).

ملاحظات:
- ستظهر رسالة "Google hasn't verified this app": اضغط Advanced ثم Continue (التطبيق لك أنت).
- البيانات تُحفظ في مجلد التطبيق الخاص (appDataFolder) ولا يرى التطبيق بقية ملفاتك.
- رمز الدخول يدوم ساعة؛ عند انتهائه تظهر نقطة حمراء على أيقونة السحابة، اضغطها لإعادة الدخول.

## 4) الاستخدام
- اضغط مطوّلاً على أي بطاقة ثم اسحب لإعادة الترتيب (يعمل أيضاً لنقل موقع بين تصنيفين).
- ⋮ في كل بطاقة: تثبيت / تعديل / نقل / حذف. وبعد الحذف يظهر زر "تراجع".
- اضغط على رأس التصنيف لطيّه.

## 5) التحديثات
بعد أي تعديل على الملفات غيّر VERSION في أعلى sw.js ليصل التحديث لأجهزتك.

## ملاحظة
مكتبة السحب SortableJS تُحمَّل من CDN وتُخزَّن للعمل بدون إنترنت بعد أول تشغيل.
إن أردت استضافتها بنفسك: نزّل Sortable.min.js (الإصدار 1.15.2) وضعه في vendor/Sortable.min.js وسيُستخدم تلقائياً.
