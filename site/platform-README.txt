منصة المتدربين: التسجيل والدخول ولوحة المتدرب (المرحلة P3)
==========================================================
بلا مكتبات ولا npm: جافاسكربت عادي يتصل بـ Supabase عبر fetch. القاعدة نفسها موثّقة في ..\supabase\README.md.

1) الملفات
----------
  src\pages\account.html     /account/    تسجيل جديد، دخول، نسيت كلمة المرور، وإعادة التعيين من رابط البريد (noindex)
  src\pages\dashboard.html   /dashboard/  لوحة المتدرب: دوراتي، الدورات المتاحة، معلوماتي، وعرض الدورة بثلاثة أقسام (noindex)
  src\pages\privacy.html     /privacy/    مسودة سياسة الخصوصية (تحتاج مراجعة قانونية)
  src\pages\terms.html       /terms/      مسودة شروط الاستخدام (تحتاج مراجعة قانونية)
  src\js\platform-api.js     العميل المشترك: الإعداد، الجلسة، Auth وREST وStorage، ترجمة الأخطاء، أدوات DOM والتبويبات والمدقّقات
  src\js\account.js          منطق صفحة الحساب
  src\js\dashboard.js        منطق لوحة المتدرب
  src\js\platform-nav.js     يُحمَّل في كل الصفحات (head.html): رابط data-auth-link يصير «لوحتي» ← /dashboard/ إن وُجدت جلسة،
                             وإلا «التسجيل / الدخول» ← /account/. يقرأ وجود الجلسة فقط ولا يتصل بالشبكة.
  src\css\platform.css       كل الأنماط الجديدة (وضعان فاتح وداكن بمتغيرات tokens.css؛ أصناف تبدأ بـ pf-)
  data\site.json             مفتاح جديد "supabase": {"url", "key"}: عنوان المشروع والمفتاح العام (publishable) فقط.
                             مفتاح service_role لا يوضع هنا ولا في أي ملف أبدًا.

تعديلات على القطع المشتركة (طُبّقت):
  head.html     أُضيف <script src="/assets/js/platform-nav.js" defer>
  header.html   صار <a class="lg" data-auth-link href="/account/">التسجيل / الدخول</a> بدل «دخول المنصة»
  footer.html   عمود «روابط»: <a data-auth-link href="/account/">التسجيل / الدخول</a>
  (بقيت {{site.login}} في site.json وفي شريحة «دخول المنصة التعليمية» داخل contact.html؛ يقرر صاحب الموقع إبقاءها أو حذفها.)

2) العقد (ما تفترضه الواجهة)
--------------------------
- الإعداد يصل إلى الجافاسكربت من خصائص على <main>: data-sb-url و data-sb-key و data-wa (= {{site.whatsapp}})، فلا شيء مكتوب في الجافاسكربت.
- الجلسة: localStorage بمفتاح واحد plat_session = {access_token, refresh_token, expires_at, user:{id,email}}. تُجدَّد قبل انتهائها
  بدقيقة، وعند 401 تُجدَّد مرة ثم يُعاد الطلب، وإن رُفض التجديد تُمسح الجلسة ويُحوَّل إلى /account/?reason=expired.
  الخروج: POST /auth/v1/logout?scope=local ثم مسح المفتاح. تبويب آخر يخرج ← هذا التبويب يخرج (حدث storage). عودة الصفحة من bfcache
  بلا جلسة ← تُفرَّغ اللوحة ويُحوَّل إلى الدخول.
- الجداول: profiles (قراءة وتعديل full_name وphone وcountry وlast_seen_at لصاحبه)، courses، enrollments، course_items،
  quiz_questions، quiz_attempts (إدراج {user_id, course_id, answers:[{q,a}]} فقط؛ الدرجة يحسبها الخادم، ويُجلب مفتاح الإجابات
  correct_index وexplanation بعد التسليم فقط)، site_settings (إعلان اللوحة: المفتاح dashboard_announcement بقيمة {"text","active"}).
  ملفات الدورة الخاصة: POST /storage/v1/object/sign/course-files/<path> (رابط موقّع لخمس دقائق).
- آخر ظهور: تُحدَّث profiles.last_seen_at عند فتح اللوحة مرة كل نصف ساعة على الأكثر (تعتمد عليها admin_stats).
- الفيديو: يُضمَّن فقط من YouTube (youtube.com أو youtu.be أو youtube-nocookie.com ← يُحوَّل إلى youtube-nocookie.com/embed/<id>)
  وVimeo (player.vimeo.com) وBunny (iframe.mediadelivery.net)، بـ sandbox وloading=lazy وreferrerpolicy. أي مضيف آخر يظهر رابطًا عاديًا
  يُفتح في تبويب جديد (https فقط).
- زر «اشترك»: https://wa.me/message/…?text=<رسالة عربية بعنوان الدورة وبريد المتدرب> (القاعدة من {{site.whatsapp}}). تحقق على هاتف
  حقيقي أن واتساب يحترم ?text مع روابط wa.me/message/؛ وإن تجاهله فالمدرب يرى المحادثة فقط بلا النص الجاهز.
- نص كل خطأ يظهر للمستخدم عربي جاهز من MSG/CODES في platform-api.js؛ لا يُعرض أي نص قادم من الخادم.

3) ما يضبطه صاحب الموقع في لوحة Supabase (لا يمكن من الكود)
----------------------------------------------------------
- Authentication > URL Configuration: Site URL = نطاق الموقع النهائي؛ وفي Redirect URLs أضف https://<النطاق>/account/
  (وللتجربة المحلية http://localhost:4195/account/ إن رغبت). بدونها يعود رابط البريد إلى Site URL فلا تعمل صفحة /account/ من الرابط.
- Authentication > Sign In / Providers > Email: فعّل «Confirm email» (إلزامي: الواجهة لا تسجّل دخولًا قبل التأكيد، ولو أُغلق الخيار
  فسيدخل المسجِّل دون تأكيد). اجعل الحد الأدنى لكلمة المرور ٨ فأكثر (الواجهة تشترط ٨).
- قوالب البريد (Confirm signup وReset password): أبقِ الرابط {{ .ConfirmationURL }} (تدفق الرابط المباشر: التوكنات في الجزء بعد #)،
  وعرّب النص كما تشاء.
- البريد: خدمة Supabase المدمجة تحدّ رسائل الساعة جدًا؛ قبل الإطلاق اضبط SMTP خاصًا (Resend أو غيره) بنطاق موثّق.
- Rate limits في Authentication: راجع حدود الدخول والتسجيل (30 دخولًا لكل 5 دقائق لكل IP افتراضيًا).

4) رؤوس الحماية عند النشر (CSP) والفهرسة
--------------------------------------
  connect-src  'self' https://rlfwkdvecypdjnijhojz.supabase.co
  frame-src    https://www.youtube-nocookie.com https://player.vimeo.com https://iframe.mediadelivery.net
  script-src   'self' (+ hash أو nonce للسكربتين المضمّنين في head.html)     form-action 'self'     object-src 'none'
  صفحتا /account/ و/dashboard/ بلا سكربت مضمّن ولا معالج أحداث مضمّن ولا style مضمّن.
- noindex: وُضع <meta name="robots" content="noindex"> داخل الصفحتين (build.mjs لا يدعم حقل robots في الترويسة). الأقوى أن يضيف الاستضافة
  X-Robots-Tag: noindex لمسارات /account/ و/dashboard/ و/admin/. وbuild.mjs يضع الصفحتين في sitemap.xml (لا خيار للاستثناء)؛
  تعديل مقترح عليه: حقل اختياري robots=noindex في ترويسة الصفحة يُخرج الوسم ويستثني الصفحة من sitemap.
- لا تحجب هذه المسارات في robots.txt إن اعتمدت noindex، فالزاحف يحتاج قراءة الوسم.

5) قواعد لمن يضيف صفحات على هذا العميل (P4 وما بعده)
--------------------------------------------------
- لا innerHTML ولا insertAdjacentHTML بأي نص من قاعدة البيانات: استعمل Platform.ui.h وtextContent.
- كل طلب بتوكن المستخدم يمر بـ Platform.rest.* (تجديد وإعادة محاولة تلقائيان)، ولا تقرأ plat_session مباشرة.
- لا تسجّل التوكنات في أي سجل ولا تضعها في رابط ولا خاصية DOM.

6) لوحة المدرب /admin/ (المرحلة P4)
===================================
بلا مكتبات ولا npm. كل البيانات تمر بالقاعدة عبر Platform.rest/storage (جلسة المدرب نفسها)، والصلاحية الحقيقية لسياسات RLS؛ إخفاء الواجهة عن غير المدير راحة استعمال فقط.

6.1 الملفات
  src\pages\admin.html          /admin/  الهيكل (noindex)، بلا سكربت مضمّن ولا معالج أحداث مضمّن ولا style مضمّن. القائمة div بدور navigation (وليست وسم nav: قواعد nav العامة في base.css وshared-extra.css تفسد ترتيبها).
  src\css\admin.css             أنماط اللوحة وحدها (أصناف ad-)، تُحمَّل في /admin/ فقط بعد platform.css. عرض الأشرطة يُضبط بـ CSSOM لا بخاصية style.
  src\js\admin-core.js          النواة (window.Admin): مكوّنات DOM الآمنة، نافذة التأكيد، جدول البيانات، CSV، أنواع الملفات وتحققها، رفع بتقدّم، تحميل الدليل والبريد، أدوات التركيز.
  src\js\admin.js               الإقلاع والحارس والتوجيه (hash) والخروج.
  src\js\admin-stats.js         الإحصاءات (RPC admin_stats).     src\js\admin-trainees.js     المتدربون (قائمة + صفحة المتدرب + CSV).
  src\js\admin-enrollments.js   الاشتراكات.                      src\js\admin-courses.js      الدورات (إعدادات + ملفات + فيديو + أسئلة).
  src\js\admin-messages.js      الرسائل.                         src\js\admin-blog.js         المدونة.
  src\js\admin-settings.js      الإعدادات (إعلان اللوحة، بياناتي، سجل التدقيق).
  src\js\platform-api.js        أُضيف إليه فقط: rest.upsert/remove/rpc/count/page وstorage.upload/remove/publicUrl/publicPath وvideoEmbed (انتقلت من dashboard.js) وconfig.url. dashboard.js يستعمل P.videoEmbed الآن.
  ..\supabase\migrations\006_admin_user_emails.sql   الدالة public.admin_user_emails() (للمدير فقط) — انظر 6.4.

6.2 السلوك والعقد
- الدخول: بلا جلسة ← /account/ ؛ ومع جلسة يُقرأ صفّ المستخدم من profiles، ولا يُطلب أي شيء من بيانات اللوحة إلا إن كان role=admin وstatus=active، وإلا ← /dashboard/ (replace).
  عند أي خطأ صلاحية (403/42501) يُعاد قراءة الدور فإن سُحب يُحوَّل إلى /dashboard/. انتهاء الجلسة ← /account/?reason=expired. الخروج يفرّغ الواجهة أولًا ثم يبطل الجلسة.
- التوجيه: #stats #trainees #trainees/<uuid> #enrollments #courses #courses/<id>[/videos|/questions] #messages[/<uuid>] #blog #blog/new #blog/<uuid> #settings. بعد كل انتقال: aria-current على الرابط، وتركيز على h2 القسم، وإعلان للقارئ الشاشي.
- الدور لا يتغير من الواجهة (يُمنح من محرر SQL فقط كما في ملف القاعدة). المدير لا يوقف حسابه (يرفضه حارس القاعدة).
- الاشتراك: صف ملغى يُعاد تفعيله (لا صف جديد)؛ كل منح/إلغاء/تفعيل/إيقاف يظهر في سجل التدقيق باسم المدرب. الإيقاف والإلغاء وإلغاء نشر دورة وكل حذف بنافذة تأكيد (dialog أصلي، زر الإلغاء هو الافتراضي، وحبس تركيز).
- الرفع: دلو course-files (خاص) بمسار <course_id>/<uuid>-<اسم ASCII آمن> ؛ دلو blog-media (عام) بمسار posts/<uuid>-<اسم آمن>. الأنواع من الامتداد (لا من file.type): pdf zip docx pptx xlsx png jpg للدورات، وpng jpg webp gif mp4 webm للمدونة، ≤ ٥٠ ميغابايت. الرفع يتم عند «حفظ»/«إضافة» ويُحذف الكائن المرفوع إن فشلت كتابة الصف، ويُحذف كائن الصف المحذوف أو المستبدل.
- الفيديو: https فقط. YouTube/Vimeo/Bunny تُخزَّن بصيغة معيارية بلا معلمات تتبّع (watch?v=… أو vimeo.com/<id>) وتُضمَّن في لوحة المتدرب بـ Platform.videoEmbed نفسها؛ غيرها رابط عادي يُفتح في تبويب جديد.
- CSV: من المتصفح، الخلية التي تبدأ بـ = + - @ (أو مسافة/تحكم قبلها) تُسبق بفاصلة عليا ' فتصير نصًا؛ لذلك تظهر أرقام الهواتف بـ '+ في Excel. الملف UTF-8 مع BOM.
- المدونة: النص عادي (الفقرات بسطر فارغ) ولا يُفسَّر HTML أبدًا. الرابط (slug) يُولَّد من العنوان ويُفحص تفرّده. إلغاء النشر يصفّر published_at فيُختم النشر التالي بوقته.
- لا innerHTML ولا insertAdjacentHTML في أي ملف admin-*.js: كل بيانات القاعدة بـ textContent. الروابط من ui.h تمر بفحص http/https؛ وmailto: لا يُبنى إلا لبريد صالح، وwa.me برقم دولي أرقامه فقط.

6.3 رؤوس الحماية (CSP) لمسار /admin/
  تُضاف إلى ما في القسم 4 (الصفحة نفسها بلا سكربت/style مضمّن، فتكفي القواعد التالية):
  connect-src  'self' https://rlfwkdvecypdjnijhojz.supabase.co     (REST وAuth وStorage؛ الرفع بـ XMLHttpRequest إلى المضيف نفسه)
  img-src      'self' https: blob:      (معاينة مقال: صورة من رابط https يكتبه المدرب، أو من دلو blog-media، أو ملف مختار قبل رفعه)
  media-src    'self' https: blob:      (معاينة فيديو mp4/webm مباشر)
  frame-src    https://www.youtube-nocookie.com https://player.vimeo.com https://iframe.mediadelivery.net   (كما في لوحة المتدرب)
  لتشديدها اكتب بدل https: المضيف https://rlfwkdvecypdjnijhojz.supabase.co فقط (فتعمل معاينة وسائط التخزين وتعطل معاينة روابط خارجية).
  والصفحة العامة للمدونة (P5) ستحتاج img-src/media-src للمضيف نفسه لعرض وسائط blog-media.
  /admin/ يدخل sitemap.xml مثل /account/ و/dashboard/ (build.mjs لا يدعم الاستثناء)؛ والأقوى أن تضيف الاستضافة X-Robots-Tag: noindex لمسارات /admin/ و/dashboard/ و/account/.

6.4 بريد المتدربين (الترحيل 006)
  البريد في auth.users ولا يقرؤه REST، فبدون الدالة لا يعرف المدرب أي بريد يخص أي متدرب (رسالة «اشترك» في واتساب تحمل البريد).
  الترحيل 006 يضيف public.admin_user_emails() للمدير فقط (طبقتان كـ admin_stats: غلاف SECURITY INVOKER فوق دالة SECURITY DEFINER في المخطط private تتحقق من is_admin()). طُبِّق على المشروع، وأُضيف إلى tests\rls_security_tests.sql ست حالات له (النتيجة ١١١/١١١ PASS).
  إن لم يُطبَّق (مشروع جديد) تعمل اللوحة كلها بلا عمود البريد وتعرض تنبيهًا بذلك في المتدربين والاشتراكات.

6.5 حدود معروفة
- حذف حساب متدرب نهائيًا (auth.users) لا يتم من اللوحة (يحتاج مفتاح الخادم أو وظيفة Edge)، وتغيير البريد أو كلمة المرور لا يتم منها.
- عناوين الدورات المعدّلة في اللوحة لا تغيّر صفحة «الدورات» العامة (مصدرها data\courses.json)؛ ترتيب الدورات (sort) لا يُعدَّل من اللوحة.
- بعد حذف وسائط مدونة قد يبقى الرابط العام يعمل دقائق من ذاكرة CDN المؤقتة (الصف يُحذف فورًا من التخزين).
- تغيير الترتيب بالأسهم يعيد ترقيم الدورة (١٠، ٢٠، …) بطلب لكل عنصر تغيّر ترتيبه.
- لا تنبيه عند مغادرة محرر المقال بتغييرات غير محفوظة.
