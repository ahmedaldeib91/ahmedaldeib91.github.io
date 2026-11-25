# send-mail — وظيفة البريد (Supabase Edge Function)

نقطة واحدة `POST https://rlfwkdvecypdjnijhojz.supabase.co/functions/v1/send-mail` بجسم JSON، لثلاثة أغراض:

| `action` | من يستدعيها | ماذا تفعل |
|----------|-------------|-----------|
| `contact` | أي زائر (بدون تسجيل) | تحفظ رسالة «تواصل معنا» ثم ترسلها لبريد المدرب، والرد يصل للزائر مباشرة (Reply-To). |
| `interest` | متدرب مسجّل الدخول | تحفظ طلب «سجّل اهتمامًا/اشترك» في دورة، وترسله للمدرب، وتعيد نص الرسالة ليتمكن المتدرب من نسخه (واتساب مثلًا). |
| `welcome` | المدير فقط | ترسل للمتدرب رسالة ترحيب بعد تفعيل اشتراكه في دورة، مع رابط لوحة المتدرب. |

نُشرت بـ`verify_jwt = false` (لأن `contact` للزوار)، والتحقق من هوية المستخدم والمدير يتم داخل الكود.

## 1. الإعداد لصاحب الموقع (مرة واحدة)

### أ) كلمة مرور تطبيق Gmail (App Password)
1. فعّل «التحقق بخطوتين» في حساب Google: <https://myaccount.google.com/security>.
2. افتح <https://myaccount.google.com/apppasswords>، أنشئ كلمة مرور باسم مثل `supabase-send-mail`، وانسخ الأحرف الستة عشر.
3. لا تكتبها في أي ملف ولا ترسلها لأحد؛ تُلصق فقط في لوحة Supabase.

### ب) الأسرار (Secrets) في Supabase
لوحة Supabase ← Edge Functions ← Secrets (أو Project Settings ← Edge Functions) وأضف:

| الاسم | إلزامي؟ | القيمة |
|-------|---------|--------|
| `GMAIL_USER` | نعم | `ahmedaldeib91@gmail.com` (الحساب الذي يرسل) |
| `GMAIL_APP_PASSWORD` | نعم | كلمة مرور التطبيق (المسافات تُحذف تلقائيًا) |
| `MAIL_TO` | لا | البريد الذي تصله رسائل الزوار والطلبات. الافتراضي = `GMAIL_USER` |
| `ALLOWED_ORIGIN` | لا | أصل الموقع المسموح له. الافتراضي `https://ahmedaldeib91.github.io` (بدون `/` في النهاية) |
| `IP_HASH_SALT` | لا (مستحسن) | نص عشوائي طويل (32 حرفًا أو أكثر) لتجزئة عناوين IP. إن لم يوجد يُشتق مفتاح التجزئة من مفتاح الخادم داخليًا |

`SUPABASE_URL` و`SUPABASE_ANON_KEY` و`SUPABASE_SERVICE_ROLE_KEY` تضيفها Supabase تلقائيًا؛ **لا تضعها يدويًا ولا تنسخ مفتاح الخادم إلى أي مكان**.

بدون `GMAIL_USER`/`GMAIL_APP_PASSWORD` تعمل الوظيفة وتحفظ الرسائل في القاعدة (تظهر في لوحة المدرب)، لكنها تعيد `mailed:false` مع `reason:"mail_not_configured"`.

بعد إضافة الأسرار لا حاجة لإعادة النشر (تُقرأ عند كل تشغيل جديد للوظيفة).

### ج) خطوة قاعدة البيانات (008) — مطبَّقة
مشغّل `private.contact_messages_before` (الملف 003) يحسب عنوان IP من رؤوس الطلب الواصلة لقاعدة البيانات. عندما تُدرج الوظيفة الصف بمفتاح الخادم يكون هذا العنوان هو عنوان خادم الوظيفة نفسه، فتشترك كل الرسائل في عنوان واحد ويصبح حد «5 رسائل/ساعة لكل عنوان» حدًا للموقع كله. الحل في `supabase/migrations/008_contact_messages_trusted_edge_insert.sql` (**مطبَّق على القاعدة الفعلية بتاريخ 2026-11-25**): يقبل المشغّل التجزئة التي ترسلها الوظيفة إذا كان الطلب بدور `service_role` فقط، ويطبق حد 10 طلبات/ساعة لكل متدرب على `interest`.

## 2. العقد (API)

الرؤوس:
- `Content-Type: application/json` (إلزامي؛ غيره يُرفض بـ415)
- `apikey: <anon key>` (يقبله بوابة Supabase؛ غير مطلوب للتحقق داخل الوظيفة)
- `Authorization: Bearer <access_token للمستخدم>` لـ`interest` و`welcome`. في `contact` يُتجاهل.

حد حجم الجسم 20KB. الحقول غير المعروفة تُتجاهل.

### `contact`
```json
{ "action": "contact", "name": "اختياري ≤100", "email": "إلزامي", "subject": "اختياري ≤150",
  "message": "إلزامي 10..2000 حرف", "website": "" }
```
- `website` حقل مصيدة (honeypot) يكون مخفيًا في النموذج ويُرسل فارغًا. إن امتلأ: الرد `{"ok":true,"mailed":false}` دون حفظ أو إرسال.
- حد: 5 رسائل/ساعة لكل عنوان IP (مجزّأ HMAC-SHA256، لا يُخزن العنوان نفسه) + 200/ساعة للموقع كله (في القاعدة).
- نجاح: `{"ok":true,"mailed":true}` أو `{"ok":true,"mailed":false,"reason":"mail_not_configured"|"mail_failed"}` (الرسالة محفوظة في الحالتين).

### `interest` (يتطلب متدربًا مسجّلًا وحسابه نشط)
```json
{ "action": "interest", "course_id": "pmp" }
```
- الدورة يجب أن تكون منشورة. الاسم والهاتف من `profiles`، والبريد من حساب الدخول؛ لا يُقبل أي منها من المتصفح.
- إن أرسل المتدرب طلبًا للدورة نفسها خلال 10 دقائق: تُعاد الرسالة السابقة دون بريد ثانٍ: `{"ok":true,"message":"...","mailed":false,"reason":"duplicate"}`.
- حد: 10 طلبات/ساعة لكل متدرب.
- نجاح: `{"ok":true,"message":"<نص عربي جاهز للنسخ>","mailed":true|false[,"reason":...]}`.

### `welcome` (يتطلب مديرًا)
```json
{ "action": "welcome", "user_id": "<uuid المتدرب>", "course_id": "pmp" }
```
- يُتحقق من أن المتصل مدير (`profiles.role='admin'` و`status='active'`، يُقرأ بصلاحيات المتصل نفسه)، ومن وجود اشتراك **نشط** للمتدرب في الدورة.
- يُرسل لبريد المتدرب مع رابط <https://ahmedaldeib91.github.io/dashboard/>، والرد يذهب إلى `MAIL_TO`.
- نجاح: `{"ok":true,"mailed":true}` أو `{"ok":true,"mailed":false,"reason":"mail_not_configured"|"mail_failed"|"trainee_has_no_email"}`.

### الأخطاء
دائمًا `{"ok":false,"error":"<code>"}`:

| الحالة | الرموز |
|--------|--------|
| 400 | `invalid_json`, `invalid_action`, `invalid_email`, `invalid_name`, `invalid_subject`, `invalid_message`, `invalid_course_id`, `unknown_course`, `account_has_no_email`, `invalid_user_id`, `no_active_enrollment` |
| 401 | `auth_required`, `invalid_token` |
| 403 | `forbidden` (ليس مديرًا), `account_suspended`, `origin_not_allowed` |
| 405 | `method_not_allowed` |
| 413 | `body_too_large` |
| 415 | `content_type_must_be_json` |
| 429 | `rate_limited` |
| 500 | `server_error` (لا تفاصيل داخلية) |

### مثال من الواجهة
```js
const { data, error } = await supabase.functions.invoke('send-mail', {
  body: { action: 'interest', course_id: 'pmp' },
}); // supabase-js يضيف Authorization للمستخدم المسجّل تلقائيًا
```
ملاحظة: `functions.invoke` يعتبر أي رد غير 2xx خطأ (`error.context` هو الـResponse؛ اقرأ `await error.context.json()` لمعرفة الرمز).

## 3. الأمان
- CORS: يُرد بـ`Access-Control-Allow-Origin` فقط إن طابق `Origin` القيمة `ALLOWED_ORIGIN`؛ أي `Origin` آخر يُرفض بـ403. اشتراط `application/json` يجبر المتصفحات على طلب preflight.
- كل نص داخل جسم البريد يُهرَّب (HTML escape)، وكل ما يدخل رؤوس البريد (الموضوع، الأسماء) تُحذف منه أسطر CR/LF ورموز التحكم ورموز اتجاه النص (bidi)، وعناوين Reply-To تُمرر ككائنات `{name,address}` بعد التحقق من صيغتها.
- الرابط الوحيد في الرسائل ثابت (لوحة المتدرب)؛ لا تُجلب أي روابط أو ملفات من مدخلات المستخدم (`disableUrlAccess`, `disableFileAccess`).
- عنوان IP: يُفضَّل `cf-connecting-ip` (تضعه Cloudflare ولا يمكن للمتصل تزويره)، ثم `x-real-ip`، ثم أول قيمة في `x-forwarded-for`.
- الأخطاء لا تكشف تفاصيل داخلية؛ السجلات تحوي رموز الأخطاء فقط بلا محتوى الرسائل.
- المنفذ 465 (TLS مباشر)؛ Supabase تمنع المنفذين 25 و587.
