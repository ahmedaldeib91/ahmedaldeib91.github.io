# نظام الاختبارات والمحاكاة — المرحلة 1: تحليل المشروع الحالي وخطة المعمارية والتنفيذ

> الحالة: **تحليل وخطة فقط (read-only)**. لم يُعدَّل أي كود ولا قاعدة بيانات ولم يُنشر شيء.
> الفرع: `exams-system` (من `blog-public` @ `3c84cad`). مشروع Supabase: `rlfwkdvecypdjnijhojz` (Postgres 17.12).
> المصطلحات التقنية بالإنجليزية عمدًا. كل ادعاء مُسنَد إلى ملف:سطر أو استعلام SELECT على القاعدة الحية؛ ما لم يُتحقق منه موسوم **[غير مؤكَّد]**.

---

## 0. الخلاصة التنفيذية

- المنصة الحالية: موقع ثابت عربي RTL بلا framework، يُبنى بـ `node site/build.mjs` (Node فقط، بلا حزم) ويُنشر على GitHub Pages؛ الخلفية Supabase (RLS صارم + دوال `private.*` SECURITY DEFINER + Edge Function واحدة `send-mail`).
- **لا يوجد دور مدرّب/instructor** ولا جدول ربط دورة↔مدرّب: `profiles.role in ('trainee','admin')` فقط (`supabase/migrations/001_core_tables.sql:11`).
- نظام الأسئلة الحالي (`quiz_questions`/`quiz_attempts`) **MCQ واحد فقط، والمفتاح مقروء للمتدرب المشترك عمدًا**: سياسة `quiz_questions_select` (`004_rls_policies_grants.sql:66-68`) + منح SELECT على كل الأعمدة بما فيها `correct_index, explanation` (تحقق حي من `information_schema.column_privileges`)، وموثّق كقرار في `supabase/README.md` §8. هذا يتعارض جذريًا مع متطلب «عدم إرسال الإجابات للمتصفح»، لذا **النظام الجديد لا يعيد استعمال هذين الجدولين** ويبقيهما كما هما (توافق خلفي).
- التوصية: نظام جديد بالكامل بجداول إضافية (additive) تُعرَّف بالـ `course_id` (text)، مع فصل صارم بين الحمولة العامة للسؤال ومفتاح الإجابة، و**كل عمليات المحاولة عبر RPCs بـ SECURITY DEFINER** (لا وصول REST مباشر للمتدرب إلى جداول الأسئلة إطلاقًا)، وEdge Functions فقط لما يحتاج I/O خارجي (روابط ملفات موقّعة، ترجمة، وربما الاستيراد).
- البدء بـ **M1 (أساس DB + المجلدات + أدوار المدرّب + بنك الأسئلة) ثم M2 (واجهة تأليف MCQ/MR/TF)**.

---

## 1. بنية الموقع والبناء والتقنيات والاصطلاحات

| البند | الدليل | الملاحظة |
|---|---|---|
| البناء | `site/build.mjs:1-131` (توثيق)، `main()` `:740` | Node ≥18، بلا npm. صفحات `site/src/pages/*.html` بترويسة `<!--page: slug=…; title=…; desc=…; nav=…-->`، قطع `{{> head}}`، متغيرات `{{root}}` `{{site.*}}`، حلقات `{{#each}}`. الناتج `dist/`. JS/CSS تُنسخ كما هي (لا bundling ولا transpile). |
| النشر | `.github/workflows/deploy.yml:26-104` | push على `main` ← build ← تحقق `dist/index.html` ← `deploy-pages`. أي فشل بناء يمنع النشر. |
| الإعداد العام | `site/data/site.json:16-20` | `basePath: ""`، `supabase.url/key` (publishable) تُحقن في `data-sb-url/data-sb-key` على `<main>` (`site/src/pages/admin.html:6`). |
| العميل المشترك | `site/src/js/platform-api.js` | `window.Platform` (`:900-918`): `auth`، `rest.select/insert/update/upsert/remove/rpc/page/count` (`:353-409`)، `storage.signedUrl` (TTL افتراضي 300s، `:419-428`)، `mail.send` لـ Edge Function (`:564-588`)، `ui.h()` باني DOM آمن بلا innerHTML ويحجب `on*/style/srcdoc` (`:646-669`)، `ui.tabs()` ARIA مع دعم RTL للأسهم (`:761-802`)، `ui.guard()` لمنع الإرسال المزدوج (`:744-758`)، مدقّقات `v.*`. الجلسة في `localStorage['plat_session']` مع تجديد تلقائي (`:204-255`). |
| لوحة المدرب | `site/src/js/admin-core.js:24-34`، `site/src/pages/admin.html:32-42` | `window.Admin` و`A.register(name, {label, render})`؛ كل قسم ملف `admin-*.js` يُحمَّل بـ defer قبل `admin.js`. البوابة `admin.js:70,175` تتطلب `role='admin'` (راحة فقط؛ الحماية في RLS). |
| لوحة المتدرب | `site/src/js/dashboard.js:774-822` | توجيه بالـ hash: `#course=<id>&tab=(files|videos|quiz)` (`:776`). الأسئلة الحالية: تُجلب بلا مفتاح ثم يُجلب المفتاح بعد التسليم (`:667`) — إخفاء على مستوى الواجهة فقط. |
| القيود | — | لا framework، لا خطوة bundling، لا مكتبات npm في المتصفح (يمكن تحميل ملف مكتبة منسوخ داخل `site/src/js/vendor/` إن لزم، مثل SheetJS — قرار). لا CSP في `site/src/layout/head.html` (سكربتات inline موجودة `:9,12`). |

**اصطلاحات يجب أن يتبعها النظام الجديد:** ملف JS لكل قسم + `A.register`؛ `ui.h` حصرًا (لا innerHTML)؛ رسائل خطأ عربية من رموز، لا نص الخادم؛ كل حذف عبر `A.confirm`؛ SQL: `set search_path = ''`، أسماء مؤهلة بالكامل، `(select auth.uid())` في السياسات، سياسة permissive واحدة لكل (role, command)، revoke من `public, anon, authenticated` ثم منح الحد الأدنى (`003_functions_triggers.sql:465-484`).

---

## 2. Auth / الأدوار / الدورات / RLS / التخزين / Edge (أدلة)

### 2.1 الحسابات والأدوار
- `public.profiles(id→auth.users, full_name, phone, country, role, status, last_seen_at…)` (`001:6-16`). القيم الحية: admin=1 active، trainee=3 active.
- الإنشاء بالـ trigger `on_auth_user_created` ← `private.handle_new_user()` دائمًا `trainee` ويتجاهل أي role في metadata (`003:97-122`).
- `private.profiles_guard()` يمنع تغيير `role/id/created_at` من API؛ الدور يُمنح من SQL editor فقط (`003:130-163`)، ومنح الأعمدة يستثني role (`004:11`).
- `private.is_admin()` = `role='admin' and status='active'` من الجدول لا من JWT (`003:26-40`).
- **لا instructor، ولا course_staff**. لا Auth hooks مخصّصة (استعلام حي: لا دوال `*hook*`).

### 2.2 الدورات والاشتراكات
- `courses(id text PK slug regex ≤40, title_ar, title_en, status available|soon, sort, published)` (`001:32-42`) — 6 دورات حية كلها `published`: `pmp, capm, pmi-rmp, pmi-acp, pmi-cp, pmi-pmocp`.
- `course_items` (ملف/فيديو؛ `storage_path` يجب أن يبدأ بـ `<course_id>/` `001:59-60`)، `enrollments(user_id, course_id, status active|revoked, unique(user_id,course_id))` (`001:99-114`).
- `private.has_course_access(course_id)` = اشتراك active + profile active + course published (`003:43-61`). **يُعاد استعماله كما هو** لقرار «هل يحق للمتدرب دخول اختبارات هذه الدورة».
- FKs إلى courses بـ `on update restrict on delete restrict` — حذف دورة لها محتوى ممنوع؛ النظام الجديد يتبع النمط نفسه.
- **لا يوجد trigger على `courses` insert** (قائمة triggers الحية: `courses_set_updated_at` فقط). مجلدات الدورة تحتاج trigger جديدًا.

### 2.3 أنماط قابلة لإعادة الاستعمال
- **Rate limit**: `pg_advisory_xact_lock(hashtextextended(key,0))` ثم `count(*)` في نافذة زمنية ثم `raise 'rate_limited' using errcode='P0001'` (`003:304-322`، `008:64-92`)؛ والعميل يترجم P0001/429 إلى رسالة (`platform-api.js:85,122`).
- **مسار موثوق للـ service role**: `auth.role() = 'service_role'` من JWT موقّع (`008:33-34`).
- **Audit**: `public.audit_log(actor_id, action, entity, entity_id, details)` يُكتب من triggers SECURITY DEFINER فقط، SELECT للمدير (`001:160-171`، `003:340-405`، `004:151-154`).
- **نمط RPC بطبقتين**: `private.fn()` SECURITY DEFINER يتحقق من الصلاحية ويرمي 42501 + `public.fn()` SECURITY INVOKER wrapper للـ REST (`006:12-43`، `007:39-81`).
- **تصحيح خادمي**: `private.quiz_attempts_grade()` BEFORE INSERT يتجاهل score القادم من العميل (`003:227-270`).
- **Storage**: `course-files` خاص، القراءة بـ `has_course_access(foldername[1])`، روابط موقّعة قصيرة يولّدها المستخدم نفسه (`005:34-41`). `blog-media` عام.
- **Edge Function** `send-mail` (`supabase/functions/send-mail/index.ts`): `verify_jwt=false` (حي) مع تحقق JWT يدوي `requireUser()` (`:166-176`)، CORS بأصل واحد `ALLOWED_ORIGIN` (`:43-52, 498-500`)، حد حجم الجسم 20KB (`:95-128`)، أخطاء برموز قصيرة (`:37-41, 526-529`)، service client للكتابة (`:159-163`)، HMAC للـ IP (`:144-151`). **هذه هي القالب لأي Edge Function جديدة.**
- اختبارات أمان SQL داخل transaction تنتهي بـ ROLLBACK (`supabase/tests/rls_security_tests.sql:1-40`) — يُوسَّع بنفس الـ harness.

### 2.4 بيئة القاعدة الحية (SELECT فقط)
- Migrations مطبّقة: 001..008 (تطابق الملفات). الحجم ≈13MB. الامتدادات المثبّتة: `plpgsql, pg_stat_statements, uuid-ossp, pgcrypto, supabase_vault`. متاح غير مثبّت: `pg_cron, pg_net, pgmq, pg_trgm, unaccent, pg_jsonschema`.
- Advisors: security = INFO (`private.app_secrets` بلا سياسات — مقصود) + WARN leaked-password protection معطّل؛ performance = فهرس غير مستعمل `posts_published_idx`. ملاحظة أداء: السياسات تستدعي `private.has_course_access(course_id)` بلا `(select …)` لأنها تعتمد على العمود، فتُقيَّم لكل صف — مقبول للأحجام الحالية، ويُتجنّب في الجداول الكبيرة الجديدة (أسئلة/محاولات) بالاعتماد على RPCs.

---

## 3. ما يُعاد استعماله وما يُبنى جديدًا، والتعارضات

| المتطلب | الموجود | القرار |
|---|---|---|
| عزل لكل دورة بالـ Course ID | `courses.id` text، `has_course_access` | إعادة استعمال؛ كل جدول جديد يحمل `course_id not null` + FK مركّب `(course_id, id)` لمنع خلط الدورات. |
| أدوار admin/instructor/trainee | admin/trainee فقط | **تعارض #1** ← انظر 3.1. |
| بنك أسئلة 15 نوعًا | MCQ واحد بمفتاح مكشوف | **تعارض #2**: جداول جديدة؛ `quiz_questions` يبقى للـ «أسئلة تدريبية» القديمة دون تغيير. ترحيل اختياري لاحقًا (M8) بنسخها إلى البنك الجديد. |
| مفتاح لا يصل للمتصفح | لا يوجد | جديد: جدول مفاتيح بلا أي policy/grant للمتدرب + snapshot المفتاح في `private` غير مكشوف لـ PostgREST. |
| مؤقت خادمي/حفظ/استئناف | لا يوجد | جديد: `deadline_at` في المحاولة وفحص `now()` في كل RPC. |
| Rate limit | نمط advisory lock (003/008) | إعادة الاستعمال كدالة عامة `private.rl_hit(key, window, max)`. |
| سجل أمني/شذوذ | `audit_log` (إداري) | جدول جديد `exam_security_events` (حجم أكبر، فهارس مختلفة)؛ `audit_log` يبقى لتغييرات الصلاحيات/النشر. |
| ملفات الأسئلة | `course-files` + signed URL من المستخدم | **تعارض #3**: توقيع الرابط من المتدرب يتطلب سياسة SELECT تسمح له بكل المسار ← bucket جديد `exam-media` بلا سياسة للمتدرب، والتوقيع عبر Edge Function بالـ service role لعناصر محاولته فقط. |
| مجلدات لكل دورة | لا يوجد trigger على courses | trigger جديد AFTER INSERT + backfill idempotent. |
| واجهة الإدارة | `A.register` | أقسام جديدة: `qbank`, `exams`, `grading`, `exam-security`, `exam-analytics`. |
| واجهة المتدرب | `dashboard.js` tabs `files|videos|quiz` | إضافة tabs (additive للـ regex `:776`) + صفحة مستقلة `exam` للمحاكاة بملء الشاشة. |
| بريد | `send-mail` | لا تغيير؛ إشعارات (نتيجة/تصحيح مقالي) لاحقًا كإجراء جديد اختياري. |

### 3.1 نموذج المدرّب (Instructor) — المقترح
- **لا نغيّر `profiles.role` الآن.** نضيف `public.course_staff(course_id, user_id, staff_role 'instructor', permissions jsonb, active, granted_by, …)`، و«المدرّب» = من لديه صف نشط فيها. السبب: كل السياسات الحالية تعتمد `is_admin()` فيبقى المدرّب **بلا أي صلاحية على الجداول القائمة تلقائيًا** (أمان افتراضي)، ولا حاجة لتعديل CHECK القائم، ويمكن لشخص أن يكون مدرّبًا لدورة ومتدربًا في أخرى.
- دوال جديدة: `private.is_course_staff(course_id)`، `private.has_staff_perm(course_id, perm text)` (admin ⇒ true دائمًا). الصلاحيات المقترحة: `qbank.read, qbank.write, qbank.import, exam.write, exam.publish (وإلا يحتاج approval), grading, analytics.read, security.read`.
- واجهة: بوابة `admin.js:70` تُوسَّع لاحقًا للسماح للمدرّب بأقسام الاختبارات فقط (تغيير صغير additive يُقرّه المالك). بديل: صفحة منفصلة `/instructor/` تعيد استعمال `admin-core.js` — **قرار D1**.

### 3.2 تعارضات أخرى
- **Legacy quiz leak**: قائم ومقصود (README §8). لا نلمسه في هذه المراحل؛ نوصي لاحقًا (قرار D9) إما بسحب منح SELECT عن `correct_index, explanation` وتقديم المفتاح عبر RPC بعد التسليم (يتطلب تعديل `dashboard.js:667`) أو بإيقاف القديم بعد الترحيل.
- `admin_stats()` يحسب `quiz_*` من الجداول القديمة فقط — إحصاءات النظام الجديد في RPCs منفصلة، لا تعديل عليه.

---

## 4. تصميم قاعدة البيانات المقترح

كل الجداول: RLS enabled + forced، `revoke all from anon, authenticated` ثم منح أدنى، triggers `set_updated_at`، أسماء بادئة `qb_` (بنك) و`ex_` (اختبارات/محاولات). Migrations تبدأ من `009_…` وكلها additive.

### 4.1 المجلدات والطاقم
```
course_folders(id uuid, course_id text FK, kind text check in
  ('question_bank','domain_tests','exam_simulations','mistakes_quiz','results_analytics'),
  title_ar, title_en, sort, unique(course_id, kind))
-- trigger AFTER INSERT ON courses -> private.create_course_folders(new.id) ON CONFLICT DO NOTHING
-- backfill في الـ migration نفسها: insert … select from courses cross join kinds on conflict do nothing
course_staff(course_id, user_id FK profiles, staff_role, permissions jsonb default '{}', active bool, granted_by, …, PK(course_id,user_id))
```
المجلدات **منطقية** (حاويات تصنيف في UI + مفتاح للاختبارات: `ex_exams.folder_kind`)، ليست مجلدات Storage.

### 4.2 التصنيف (Taxonomy)
```
qb_taxonomy(id, course_id, parent_id null, level 'domain'|'topic'|'subtopic', code, name_ar, name_en, sort,
  unique(course_id,id), FK (course_id,parent_id) -> (course_id,id))
qb_tags(id, course_id, label, unique(course_id, lower(label)))
```
الصعوبة عمود enum نصي (`easy|medium|hard` أو 1..5 — قرار ثانوي)، والكلمات المفتاحية عبر `qb_question_tags`.

### 4.3 سجل الأنواع (Type registry) — أنواع جديدة بلا تغيير schema
```
qb_question_types(code PK, name_ar, name_en, grading 'auto'|'manual', schema_version int,
  public_schema jsonb, key_schema jsonb, response_schema jsonb, enabled bool)
```
البذور: `mcq_single, multi_response, true_false, numerical, short_answer, essay, ordering, matching,
drag_drop (enhanced matching), cloze (embedded dropdowns), hotspot, graphic (MCQ بصورة/خيارات صورية),
case (سيناريو بسؤال واحد = سؤال عادي + stem_ref)`، و**multi-question scenario** كيان مستقل (4.4).
- الحمولة متعددة الأشكال في `jsonb` بعمودين: `payload` (عام) و`key` (سري)، ويتحقق منها **validator في plpgsql لكل نوع** `private.qb_validate(type, payload, key)` (أو `pg_jsonschema` إن ثُبّت — قرار ثانوي). نوع جديد = صف في السجل + دالة validator + grader + renderer JS؛ **لا migration للجداول**.

### 4.4 البنك والإصدارات والمفاتيح
```
qb_sets(id, course_id, current_version_id, status, …)               -- multi-question scenario
qb_set_versions(id, set_id, version_no, stem jsonb (نص/وسائط), created_by, created_at) -- immutable
qb_questions(id, course_id, set_id null, current_version_id, status 'draft'|'active'|'retired',
  folder 'question_bank', created_by, …, unique(course_id,id))
qb_question_versions(id, question_id, course_id, version_no, type_code FK, payload jsonb,
  taxonomy_id, difficulty, points numeric default 1, weight numeric default 1, lang 'ar'|'en'|'mixed',
  content_hash text, created_by, created_at, unique(question_id,version_no))      -- immutable (trigger يمنع UPDATE)
qb_question_keys(version_id PK FK, course_id, key jsonb, feedback_correct, feedback_incorrect,
  explanation, option_explanations jsonb, reference text)                          -- staff-only
qb_question_tags(question_id, tag_id)
qb_import_jobs(id, course_id, format, file_name, status, totals jsonb, report jsonb, created_by, created_at)
```
- **التحرير = إصدار جديد** (insert version + key)، و`current_version_id` يتحرك. الإصدارات القديمة لا تُحذف ما دامت مرجعًا لمحاولات.
- `content_hash` = sha256 لنص مطبَّع (توحيد الألف/الياء/التاء المربوطة، إزالة التشكيل والمسافات) ← **كشف التكرار** عند الاستيراد (`unique` غير مفروض؛ تحذير + خيار تخطٍّ). `pg_trgm` لاحقًا للتشابه التقريبي.

**RLS:** `qb_*` SELECT/INSERT/UPDATE لـ `has_staff_perm(course_id,'qbank.read'|'qbank.write')`؛ **لا أي policy للمتدرب** على أي جدول `qb_*`. `qb_question_keys` إضافةً لذلك: لا منح لـ anon نهائيًا، واختبار RLS صريح «متدرب مشترك يرى 0 صفوف».

### 4.5 الاختبارات (Exam builder)
```
ex_exams(id, course_id, folder_kind 'domain_tests'|'exam_simulations', title_ar, title_en,
  status 'draft'|'pending_approval'|'published'|'paused'|'archived',
  mode 'fixed'|'random', settings jsonb, approved_by, published_at, created_by, …)
ex_exam_sections(id, exam_id, title, sort, time_limit_sec null)          -- اختياري (أقسام PMP)
ex_exam_items(exam_id, course_id, section_id, question_id, set_id, sort,  -- للوضع اليدوي
  FK (course_id,question_id) -> qb_questions(course_id,id))
ex_exam_rules(id, exam_id, section_id, filter jsonb {taxonomy_ids, difficulty, types, tags}, count int, points_each)
```
`settings` (مُتحقَّق منه بدالة): `duration_sec, window_start/end, max_attempts, passing_score_pct, shuffle_questions, shuffle_options,
review_policy ('none'|'after_submit'|'after_window'|'manual'), show_score, show_correct, show_explanations, feedback_mode,
tools {calculator, whiteboard, translation}, security {fullscreen_required, max_blur_events, on_violation 'log'|'warn'|'flag'|'auto_submit', watermark, single_session},
navigation {allow_back, allow_flag}`.
النشر: `exam.publish` ⇒ `published` مباشرة، وإلا `pending_approval` حتى يعتمد admin (trigger يمنع القفز). كل تغيير حالة ← `audit_log`.

### 4.6 المحاولات مع Snapshot
```
ex_attempts(id, exam_id, course_id, user_id, kind 'official'|'practice'|'mistakes_review',
  status 'in_progress'|'submitted'|'timed_out'|'abandoned'|'under_review'|'graded',
  started_at, deadline_at, submitted_at, last_seen_at, token_hash, settings_snapshot jsonb,
  score, max_score, percent, passed, item_count, seed bigint, client_info jsonb)
ex_attempt_items(id, attempt_id, position, section_id, question_version_id, set_version_id,
  type_code, points, option_map jsonb (معرّفات مموّهة + ترتيب الخلط), -- لا مفاتيح ولا نص هنا
  response jsonb, flagged bool, answered_at, client_seq int, time_spent_ms int,
  auto_score, manual_score, final_score, grader_id, grader_comment, graded_at)
private.ex_key_overrides(attempt_item_id PK, key jsonb, reason, by, at) -- تصحيح خطأ مفتاح لمحاولات محددة فقط
```
- **Snapshot مرجعي (القرار النهائي، انظر 5.2 للحجم):** `exam_start_attempt` يثبّت لكل عنصر `question_version_id` + `option_map` + الترتيب. الإصدارات immutable (trigger يمنع UPDATE/DELETE لإصدار أو مفتاح مُشار إليه من محاولة) ⇒ **تعديل السؤال لاحقًا = إصدار جديد ولا يغيّر أي محاولة سابقة** (المتطلب). `public_payload` يُبنى عند الطلب داخل RPC من `qb_question_versions.payload` بعد التنظيف والخلط، والتصحيح يقرأ `qb_question_keys` للإصدار نفسه (أو `ex_key_overrides` إن وُجد).
- **Per-attempt opaque IDs**: الخيارات تُعاد تسميتها بمعرّفات عشوائية لكل محاولة (`option_map` يحفظ الربط)، فلا يمكن ربط «الخيار c3f…» بين محاولتين أو مستخدمين لتجميع المفاتيح.
- **RLS:** المتدرب SELECT على `ex_attempts` لصفوفه وأعمدة محددة فقط (status/score حسب السياسة تُعرض عبر RPC أفضل)، **لا SELECT على `ex_attempt_items`** (كل القراءة عبر RPC)، لا INSERT/UPDATE لأي منهما. الطاقم: SELECT بـ `has_staff_perm(course_id,'grading'|'analytics.read')`.

### 4.7 Mistakes Quiz
```
ex_mistakes(user_id, course_id, question_id, state 'wrong_not_reviewed'|'reviewed'|'correct_in_review'|'wrong_again'|'mastered',
  wrong_count, correct_streak, last_wrong_attempt_id, last_review_attempt_id, first_wrong_at, updated_at,
  PK(user_id, question_id))                                     -- dedupe بالسؤال لا بالإصدار
ex_mistake_events(id, user_id, question_id, attempt_id, event 'wrong'|'reviewed'|'correct'|'wrong_again'|'mastered', at)
```
- التجميع: عند إنهاء محاولة `official|practice`، كل عنصر `final_score < points` ⇒ upsert (state=`wrong_not_reviewed` أو `wrong_again` إن كان mastered/correct_in_review)، `wrong_count+1`، `correct_streak=0`.
- المراجعة: محاولة `kind='mistakes_review'` بنفس المحرك (اختيار من `ex_mistakes` غير mastered)، نتائجها **منفصلة ولا تعدّل أي محاولة رسمية** (المتطلب).
- سياسة الإتقان لكل دورة في `site_settings`-like جدول `ex_course_settings(course_id, mistakes_policy jsonb default '{"consecutive_correct":2,"separate_attempts":true}')`. صحيح في مراجعة ⇒ `correct_streak+1` (مرة واحدة لكل محاولة) ⇒ `correct_in_review`، وعند بلوغ الحد ⇒ `mastered`. خطأ ⇒ `wrong_again`، streak=0. فتح الشرح ⇒ `reviewed`.

### 4.8 الأمن والحدود
```
ex_security_events(id bigserial, attempt_id, user_id, course_id, kind, severity, details jsonb, client_ts, created_at)
  -- kinds: visibility_hidden, blur, fullscreen_exit, copy_attempt, devtools_heuristic, multi_session,
  --        rate_limited, fetch_too_fast, out_of_window, token_mismatch, reattempt_spam
private.rl_counters(key text, window_start timestamptz, n int, PK(key, window_start))
```
المتدرب لا يكتب مباشرة؛ `exam_log_events(attempt_id, token, events[])` يُدخل دفعة (حد أقصى 50 حدثًا/استدعاء، 10 استدعاءات/دقيقة). الطاقم SELECT بـ `security.read`.

### 4.9 ترجمة (إن اعتُمدت)
`qb_translations(content_hash, source_lang, target_lang, provider, text, created_at, PK(content_hash,target_lang))` — cache مشترك على مستوى نص الحمولة العامة فقط.

### 4.10 حدود RPC / Edge Function

| العملية | الشكل | السبب |
|---|---|---|
| `exam_list_available(course_id)` | RPC SECURITY DEFINER | يفحص `has_course_access`، النافذة، المحاولات المتبقية. |
| `exam_start_attempt(exam_id)` | RPC DEFINER | ذري: قفل advisory على (user, exam)، فحص الحد، اختيار عشوائي حسب القواعد بـ seed، snapshot، `deadline_at = least(now()+duration, window_end)`، يعيد `attempt_id + attempt_token` (يُخزَّن hash فقط) + خريطة تنقّل بلا محتوى. محاولة نشطة موجودة ⇒ resume بدل إنشاء جديدة. |
| `exam_get_items(attempt_id, token, positions int[≤3])` | RPC DEFINER | يعيد `public_payload` + `response/flagged` المحفوظ فقط. يرفض بعد `deadline_at` أو خارج المحاولة. Rate limit + كشف «سرعة جلب غير بشرية». |
| `exam_save_answer(attempt_id, token, position, response, flagged, client_seq, time_ms)` | RPC DEFINER | idempotent (يتجاهل `client_seq` الأقدم)، يتحقق من شكل `response` حسب `response_schema`، حجم ≤ 8KB. |
| `exam_heartbeat(attempt_id, token)` | RPC DEFINER | يعيد `server_now, deadline_at` (المؤقت يعرض الفرق؛ الساعة المحلية للعرض فقط). يحدّث `last_seen_at`. |
| `exam_log_events(...)` | RPC DEFINER | انظر 4.8؛ قد ينفّذ `on_violation` (مثل auto_submit). |
| `exam_submit(attempt_id, token)` | RPC DEFINER | ينهي، يصحّح آليًا كل العناصر من `qb_question_keys` للإصدار المثبّت (أو `private.ex_key_overrides`)، essay ⇒ `under_review`، يحدّث Mistakes. |
| `exam_result(attempt_id)` / `exam_review(attempt_id)` | RPC DEFINER | يطبّق `review_policy`؛ المفاتيح والشروح تُعاد **فقط** إن سمحت السياسة وبعد انتهاء المحاولة (وبعد `window_end` إن كانت `after_window`). |
| انتهاء الوقت | lazy في كل RPC + `pg_cron` كل دقيقة `private.ex_sweep()` | `in_progress` بعد deadline ⇒ تصحيح وحالة `timed_out`؛ بلا نشاط لمدة X وبلا deadline ⇒ `abandoned`. pg_cron متاح غير مثبّت (يتطلب `create extension` — ضمن migration بموافقة). |
| `staff_grade_item(attempt_item_id, score, comment)` | RPC DEFINER + `grading` | يعيد حساب المحاولة، `under_review` ⇒ `graded` عند اكتمال اليدوي. |
| `staff_regrade_question(version_id, new_key, attempt_ids)` | RPC DEFINER + admin | عند خطأ في المفتاح: يكتب `ex_key_overrides` للمحاولات المحددة صراحةً فقط، ويعيد الحساب، ويُسجَّل في audit (الإصدار نفسه لا يتغيّر). |
| CRUD البنك والاختبارات | REST مباشر بـ RLS للطاقم (نمط admin-courses.js) | يطابق الاصطلاح القائم. الكتابة متعددة الجداول (version+key) عبر RPC `qb_save_question(json)` لضمان الذرّية. |
| `qb_import_batch(course_id, items jsonb, options)` | RPC DEFINER | التحليل يتم في المتصفح إلى JSON موحّد؛ الخادم يعيد التحقق لكل عنصر داخل `begin … exception` منفصل (عزل فشل كل سؤال) ويعيد تقريرًا. حد ≤ 200 عنصر/دفعة. |
| `exam-media` | **Edge Function** | تحقق JWT + أن الملف ينتمي لعنصر في محاولة المستخدم النشطة ⇒ signed URL بالـ service role TTL 60–120s. |
| `exam-translate` | **Edge Function** | استدعاء مزوّد خارجي + cache + حدود؛ يُفضَّل الترجمة المسبقة عند النشر (انظر 5.4). |
| `exam-import` (اختياري) | Edge Function | فقط إن احتجنا تحليل ملفات كبيرة/Excel في الخادم؛ الافتراضي تحليل في المتصفح. |

**لماذا RPC لا Edge لعمليات المحاولة:** transaction واحدة ذرّية مع القفل، بلا cold start، ضمن حدود CPU القاعدة لا حدود Edge، ونفس نمط 003/006/007.

### 4.11 التصحيح الخادمي لكل نوع (`private.ex_grade(type, response, key, points, policy)`)
| النوع | key | response | القاعدة |
|---|---|---|---|
| mcq_single / true_false / graphic | `{correct: optId}` | `{choice}` | تطابق ⇒ points. |
| multi_response | `{correct:[ids], scoring:'all_or_nothing'|'partial'|'partial_penalty'}` | `{choices:[]}` | partial = (صحيح−خاطئ)/عدد الصحيح، حد أدنى 0. |
| numerical | `{value, tolerance, tolerance_type 'abs'|'pct', units?}` | `{value}` | ضمن التفاوت؛ أرقام عربية تُحوَّل. |
| short_answer | `{accepted:[{text, score_pct}], case_sensitive, normalize_ar}` | `{text}` | مقارنة بعد التطبيع؛ regex اختياري بحد طول. |
| ordering | `{order:[ids], scoring:'exact'|'per_position'|'pairwise'}` | `{order:[]}` | — |
| matching / drag_drop | `{pairs:{left:right}, distractors}` | `{pairs}` | لكل زوج نسبة أو all-or-nothing. |
| cloze | `{blanks:{b1:optId,…}}` | `{blanks}` | لكل فراغ. |
| hotspot | `{regions:[{shape:'rect'|'circle'|'poly', coords normalized 0..1}], mode single|multi}` | `{points:[[x,y]]}` | point-in-polygon في plpgsql؛ الإحداثيات نسبية للصورة. |
| essay | — (rubric اختيارية) | `{text ≤ N}` | `manual` ⇒ `under_review`. |
| scenario set | كل سؤال ابن يُصحَّح بنوعه | — | الـ set وحدة اختيار وعرض فقط. |

**ما يصل للمتصفح:** فقط `public_payload` (stem، خيارات بمعرّفات مموّهة، صور عبر media ids، ترتيب مخلوط) + ما حفظه المتدرب. لا `key/feedback/explanation/option_explanations/reference`، ولا `question_id`/`version_id` الحقيقي (يُعرض `position` فقط).

### 4.12 مقاومة الاستخراج (طبقات)
1. RLS: المتدرب لا يملك أي policy على `qb_*` (ومنها `qb_question_keys`)، ولا على `ex_attempt_items`، وتصحيحات المفاتيح في `private` غير المكشوف لـ PostgREST.
2. الوصول حصريًا لعناصر محاولته، 1–3 عناصر لكل طلب، بتوكن محاولة (single_session: توكن جديد يُبطل القديم ويُسجَّل `multi_session`).
3. Rate limits: `get_items` ≤ 60/دقيقة و≤ (item_count × 4) للمحاولة؛ `start_attempt` ≤ max_attempts و≤ 5/ساعة؛ `save_answer` ≤ 120/دقيقة.
4. سحب عشوائي من بنك كبير + معرّفات مموّهة لكل محاولة ⇒ المحاولة الواحدة تكشف جزءًا فقط ولا يمكن توحيد المفاتيح.
5. سياسة المراجعة: إظهار الإجابة الصحيحة اختياري (افتراضي مقترح: score فقط للمحاكاة الرسمية).
6. Anomaly: جلب متتابع أسرع من عتبة، محاولات كثيرة مهجورة، أحداث blur/exit، تعدد جلسات ⇒ `ex_security_events` + عرض للمدير.
7. وسائط بروابط موقّعة 60–120s + watermark مرئي (اسم/بريد مختصر + رمز المحاولة) فوق المحتوى.
8. **حدود صريحة:** كل ما يُعرض على الشاشة قابل للتصوير/النسخ اليدوي أو OCR؛ الحماية تقلل الاستخراج الجماعي وترفع كلفته وتترك أثرًا، ولا تمنعه مطلقًا.

---

## 5. المخاطر التقنية والحدود الصادقة

### 5.1 مكافحة الغش من جهة العميل
fullscreen API وvisibilitychange/blur ونسخ/لصق وقائمة السياق: **ردع وتسجيل فقط**. يمكن تجاوزها بجهاز ثانٍ، أو أدوات المطوّر، أو تعطيل JS بعد التحميل، أو أجهزة iOS التي لا تدعم Fullscreen API للعناصر غير الفيديو **[سلوك Safari iOS يجب اختباره]**. لا proctoring بالكاميرا (خارج النطاق، وتكلفة/خصوصية). الإجراءات القابلة للضبط (log/warn/flag/auto_submit) تُنفَّذ خادميًا عند استلام الحدث، لكن غياب الحدث لا يعني غياب المخالفة.

### 5.2 حدود Supabase (الخطة المجانية، **[أرقام تقريبية — تُراجع في لوحة Supabase/الوثائق قبل M1]**)
- DB 500MB (الحالي ≈13MB)، Storage 1GB، egress ~5GB/شهر، المشروع يتوقف بعد ~7 أيام خمول، **لا backups يومية ولا PITR على Free** ⇒ خطر بيانات المحاولات.
- Edge Functions: ~500K استدعاء/شهر، حد CPU ~2s لكل طلب، ذاكرة ~256MB ⇒ لا تصحيح ولا تحليل ملفات كبيرة فيها؛ لهذا التصحيح في SQL.
- حجم تقديري: 2000 سؤال × ~3KB ≈ 6MB؛ snapshot 180 عنصرًا × ~3KB ≈ 0.5MB/محاولة ⇒ 500 محاولة كاملة ≈ 250MB. **يجب** تقليل snapshot: تخزين `question_version_id` فقط + نسخ المفتاح والحمولة عند الحاجة؟ — بديل أخف: الإصدارات immutable أصلًا، فالـ snapshot = مرجع للإصدار + `option_map` + ترتيب (≈200B/عنصر) ويُبنى `public_payload` عند الطلب من الإصدار. **المعتمد: snapshot مرجعي (immutable versions) لا نسخ نصي** (4.6)، بنفس ضمان «التعديل لا يغيّر الماضي» وبحجم أقل بنحو 15 مرة.
- **توصية قوية: Pro plan قبل الإطلاق الفعلي للاختبارات الرسمية** (backups، لا إيقاف، حدود أعلى) — قرار D6.

### 5.3 الترجمة الفورية عربي ← إنجليزي
| الخيار | التكلفة **[تقريبية، تُراجع]** | الجودة/الخصوصية |
|---|---|---|
| A. نسخة إنجليزية يكتبها المؤلف لكل سؤال (حقل `payload.i18n.en`) | 0 | أفضل جودة للمصطلحات (PMP)؛ عمل يدوي. |
| B. Azure Translator | ~2M حرف/شهر مجانًا، ثم ~$10/مليون | لا يحتفظ بالنص افتراضيًا. |
| C. Google Cloud Translation | ~500K حرف/شهر مجانًا، ثم ~$20/مليون | بطاقة دفع على GCP. |
| D. DeepL API | Free 500K/شهر (قد يُستعمل للتدريب في الخطة المجانية)، Pro ~€5/شهر + ~€20/مليون | جودة عالية؛ استعمل Pro لأجل الخصوصية. |

**التوصية:** هجين A + B: ترجمة آلية **مسبقة عند النشر** (لا عند طلب المتدرب) عبر Edge Function `exam-translate` لنص الحمولة العامة فقط، مخزّنة في `qb_translations` بـ `content_hash`، وقابلة للتحرير يدويًا من المؤلف. ثم يُقدَّم النص المترجم ضمن `exam_get_items` إن كان الخيار مفعّلًا للاختبار. التكلفة المتوقعة: بنك 2000 سؤال × ~700 حرف ≈ 1.4M حرف مرة واحدة ⇒ ضمن الحصة المجانية لـ Azure (~$0) أو ~$28 مع Google؛ ولا تكلفة لكل متدرب. **الخصوصية:** نص الأسئلة (ملكية فكرية) يُرسل لمزوّد خارجي — قرار D2. لا تُترجم المفاتيح أبدًا أثناء المحاولة.

### 5.4 مخاطر أخرى
- **سباقات**: بدء محاولتين متوازيتين ⇒ advisory lock على `(user_id, exam_id)`؛ حفظ متزامن من تبويبين ⇒ `client_seq` + single_session؛ submit مع sweep ⇒ `select … for update` على صف المحاولة وفحص الحالة.
- **ساعة العميل**: لا يُوثق بها؛ `deadline_at` خادمي، وأي `save_answer` بعد `deadline_at + 5s grace` يُرفض.
- **انقطاع الشبكة**: autosave مع طابور محلي (localStorage بمفتاح المحاولة، بلا مفاتيح إجابة لأنها غير موجودة أصلًا) وإعادة الإرسال؛ استئناف عبر `exam_start_attempt` الذي يعيد المحاولة النشطة.
- **XSS في محتوى الأسئلة**: المحتوى نص/Markdown محدود يُعرض بـ `ui.h` (textContent) — لا HTML خام من الاستيراد (Moodle XML يحمل HTML ⇒ يُحوَّل إلى نص/تنسيق محدود whitelist عند الاستيراد).
- **Privilege escalation**: المدرّب لا يملك أي policy على الجداول القائمة؛ `course_staff` لا يكتبه إلا admin؛ كل دالة staff تتحقق من `has_staff_perm(course_id_of_target)` وليس من وسيط يرسله العميل.
- **Backward compatibility**: لا تعديل على جداول/دوال/سياسات 001–008؛ الإضافات الوحيدة المقترحة على كود قائم: trigger جديد على `courses` (AFTER INSERT، لا يغيّر السلوك)، و(لاحقًا) توسيع regex تبويبات `dashboard.js:776` وبوابة `admin.js` — كل تغيير منها في milestone مستقل مع اختبار انحدار.

### 5.5 حماية البيانات والرجوع (Rollback) في الإنتاج
1. Migrations **additive فقط** (create table/function/policy/trigger جديدة)؛ ممنوع `drop/alter … type/delete` على القائم. كل migration لها سكربت `down` مقابل يحذف ما أُنشئ فقط (يُحفظ في `supabase/migrations/down/`).
2. قبل كل تطبيق: `pg_dump` (schema+data) عبر Supabase CLI من جهاز المالك (لا backups على Free).
3. بيئة الاختبار: **Supabase Branching** (`list_branches`, `create_branch` بعد `get_cost` و`confirm_cost`) — يتطلب خطة مدفوعة وتكلفة بالساعة لكل فرع **[لم يُستعلم عن التكلفة في هذه المرحلة]**؛ بديل مجاني: مشروع Supabase مجاني ثانٍ كـ staging تُطبَّق عليه نفس الملفات أولًا.
4. اختبارات: توسيع `supabase/tests/rls_security_tests.sql` (ROLLBACK) بحالات: متدرب مشترك لا يرى `qb_*`/المفاتيح، متدرب غير مشترك لا يبدأ محاولة، مدرّب دورة A لا يرى دورة B، المدرّب لا يرى `trainer_notes`/`contact_messages`، get_items خارج المحاولة يفشل، save بعد deadline يفشل، rate limit يعمل، تعديل سؤال لا يغيّر نتيجة محاولة سابقة.
5. Feature flag: `site_settings.key='exams_enabled'` لإظهار الواجهة الجديدة تدريجيًا (الواجهة فقط؛ الصلاحية في RLS).
6. `get_advisors` (security+performance) بعد كل migration.

---

## 6. الخطة المرحلية (Milestones)

> قائمة «المراحل الـ23» للمالك ليست في المستودع **[غير متاحة لي]**؛ الربط أدناه بالموضوع. الحجم: S ≈ 1–2 يوم عمل، M ≈ 3–5، L ≈ 6–10.

| M | النطاق | ملفات/جداول | اختبارات القبول | يعتمد على | الحجم |
|---|---|---|---|---|---|
| **M0** | قرارات المالك + staging + backup | — | قائمة D موقّعة؛ staging يعمل بـ 001–008 | — | S |
| **M1** | أساس DB: `course_staff` + helpers، `course_folders` + trigger + backfill، `qb_question_types` (بذور 15 نوعًا)، taxonomy/tags، questions/versions/keys/sets، `rl_counters` + `rl_hit`، `ex_security_events`، validators لـ MCQ/MR/TF، `qb_save_question` RPC | `supabase/migrations/009_exam_foundation.sql`, `010_qbank.sql`, tests | كل دورة (6 حالية + جديدة تُنشأ) لها 5 مجلدات؛ متدرب مشترك يرى 0 صفوف `qb_*`؛ مدرّب A لا يرى B؛ الإصدار immutable؛ advisors نظيفة؛ لا انحدار في اختبارات 001–008 | M0 | L |
| **M2** | واجهة بنك الأسئلة (admin): تأليف MCQ/MR/TF، taxonomy، tags، إصدارات + مقارنة، معاينة، بحث/تصفية، تعيين المدرّبين وصلاحياتهم | `site/src/js/admin-qbank.js`, `admin-staff.js`, `exam-types.js` (registry: `ExamTypes.register(code,{renderAuthor, renderPlayer, collect, validate})`) | CRUD كامل عبر RLS؛ تعديل ينشئ إصدارًا؛ RTL/LTR للنص المختلط | M1 | M |
| **M3** | Exam builder: يدوي/عشوائي بحصص domain/topic/difficulty/type، أقسام، إعدادات، lifecycle + approval | `011_exams.sql`, `admin-exams.js` | لا نشر بلا صلاحية؛ قواعد الحصص تفشل بوضوح إن لم يكفِ البنك؛ audit لكل تغيير حالة | M1,M2 | L |
| **M4** | محرّك المحاولة: start/get/save/heartbeat/log/submit/result/review، sweep + pg_cron، تصحيح MCQ/MR/TF | `012_attempts.sql`, tests | المفتاح لا يظهر في أي استجابة قبل السياسة؛ resume يعمل؛ timeout خادمي؛ لا محاولتين متوازيتين؛ rate limits | M3 | L |
| **M5** | واجهة المحاكاة: صفحة `exam` (ملء الشاشة)، تنقّل، mark for review، summary، مؤقت خادمي، autosave/طابور offline، RTL/LTR، موبايل، الآلة الحاسبة (parser بلا eval) واللوح (canvas) | `site/src/pages/exam.html`, `exam-engine.js`, `exam-tools.js`, `exam.css`, تبويبات dashboard | اختبار يدوي على Chrome/Firefox/Safari iOS/Android؛ انقطاع الشبكة لا يفقد إجابة؛ لوحة المفاتيح وقارئ الشاشة | M4 | L |
| **M6** | أنواع A: numerical, short_answer (تطبيع عربي), ordering, matching, drag_drop, cloze — تأليف + عرض + grader | validators/graders SQL + `exam-types.js` | جدول حالات تصحيح لكل نوع (golden tests في SQL) | M4,M5 | L |
| **M7** | أنواع B: hotspot, graphic, scenario sets/multi-question, essay + التصحيح اليدوي + `under_review`؛ bucket `exam-media` + Edge `exam-media` | `013_media.sql`, `supabase/functions/exam-media/`, `admin-grading.js` | لا رابط وسائط لغير صاحب المحاولة؛ TTL ≤120s؛ essay لا يُحسب نهائيًا قبل التصحيح | M6 | L |
| **M8** | استيراد/تصدير: Moodle XML (أساسي)، GIFT، Aiken، JSON، CSV (+Excel إن اعتُمد)، معاينة، تحقق، كشف تكرار، عزل فشل كل سؤال، تقرير؛ ترحيل اختياري من `quiz_questions` | `exam-import.js` (DOMParser/parsers)، `qb_import_batch`، `qb_import_jobs` | ملف به 100 سؤال منها 5 تالفة ⇒ 95 تُستورد و5 في التقرير بسبب واضح؛ round-trip تصدير/استيراد بلا فقد | M2,M6,M7 | L |
| **M9** | مراقبة الغش والأمن: fullscreen/visibility/blur/copy، إجراءات قابلة للضبط، watermark، قواعد الشذوذ، شاشة السجل الأمني | `admin-security.js`, `exam-engine.js` | كل حدث يُسجَّل خادميًا؛ auto_submit يعمل؛ لا يتعطل الاختبار عند رفض fullscreen | M5 | M |
| **M10** | Mistakes Quiz | `014_mistakes.sql`، تبويب في dashboard | dedupe بالسؤال؛ الإتقان بعد صحيحين في محاولتين منفصلتين؛ لا أثر على النتائج الرسمية | M4 | M |
| **M11** | التحليلات: المتدرب (domains/تقدّم)، المدرّب/المدير (item analysis: p-value، discrimination، زمن، توزيع الدرجات) | RPCs `ex_analytics_*`, `admin-exam-analytics.js` | الأرقام تطابق حسابًا يدويًا لعيّنة؛ المدرّب يرى دوراته فقط | M4 | M |
| **M12** | الترجمة (إن اعتُمدت) | `supabase/functions/exam-translate/`, `qb_translations` | لا ترجمة لمفاتيح؛ cache hit لا يستدعي المزوّد؛ حد تكلفة شهري | M5, D2 | S–M |
| **M13** | تقوية وإطلاق: اختبارات تحميل خفيفة، advisors، توثيق للمالك (عربي)، backup، feature flag | docs, tests | قائمة تحقق الإطلاق | الكل | M |

**ربط تقريبي بمتطلبات المالك:** بنك الأسئلة/العزل/المجلدات ⇒ M1؛ التأليف اليدوي ⇒ M2/M6/M7؛ التصنيف والإصدارات ⇒ M1/M2؛ الاستيراد/التصدير ⇒ M8؛ Exam builder وحالاته ⇒ M3؛ المؤقت/الحفظ/الاستئناف ⇒ M4؛ واجهة المحاكاة/الآلة/اللوح ⇒ M5؛ الترجمة ⇒ M12؛ الأمن ومقاومة الاستخراج ⇒ M1/M4/M7/M9؛ الأدوار والصلاحيات ⇒ M1/M2/M3؛ المحاولات والتصحيح المقالي ⇒ M4/M7؛ Mistakes ⇒ M10؛ التحليلات ⇒ M11؛ التوافق الخلفي ⇒ كل milestone (اختبارات انحدار).

**أبدأ بـ:** M1 ثم M2 (أساس DB + المجلدات + المدرّبون + CRUD لـ MCQ/MR/TF)، فهي تُنتج قيمة قابلة للاستعمال (بناء البنك) دون أي مخاطرة على المتدربين، وتثبّت نموذج العزل والمفاتيح الذي يعتمد عليه كل ما بعده.

---

## 7. قرارات مطلوبة من المالك

| # | القرار | التوصية |
|---|---|---|
| D1 | نموذج المدرّب: جدول `course_staff` (بلا قيمة role جديدة) أم إضافة `role='instructor'`؛ وواجهته داخل `/admin/` أم صفحة `/instructor/` | `course_staff` + أقسام الاختبارات داخل `/admin/` ببوابة موسّعة |
| D2 | الترجمة: لا شيء / نسخة إنجليزية يدوية / آلية مسبقة (Azure/Google/DeepL Pro) — وقبول إرسال نص الأسئلة لمزوّد خارجي | هجين يدوي + Azure مسبق ومخزّن |
| D3 | Excel: مكتبة SheetJS منسوخة محليًا (~1MB، ترخيص Apache-2.0 للنسخة المجتمعية **[يُراجع]**) أم CSV فقط (يُصدَّر من Excel) | CSV أولًا، Excel لاحقًا إن لزم |
| D4 | تصحيح المقالي: يدوي فقط (مقترح)، rubric؟ من يصحّح (المدير/مدرّب بصلاحية grading)؟ | يدوي + rubric اختيارية |
| D5 | سياسة المراجعة الافتراضية للمحاكاة الرسمية (درجة فقط / إجابات / شروح؛ بعد التسليم أم بعد إغلاق النافذة) | درجة + domains فورًا، الشروح بعد إغلاق النافذة |
| D6 | الانتقال إلى Supabase Pro قبل الاختبارات الرسمية (backups/عدم الإيقاف) وميزانية Branching أو مشروع staging مجاني | Pro قبل الإطلاق؛ staging مجاني الآن |
| D7 | إجراءات المخالفة الافتراضية (log/warn/flag/auto_submit) وعتباتها؛ وهل fullscreen إلزامي (مشكلة iOS) | log + warn، auto_submit اختياري لكل اختبار |
| D8 | مقياس الصعوبة (3 مستويات أم 1–5) وهيكل domains لكل دورة (مثل People/Process/Business Environment لـ PMP) | 3 مستويات؛ بذور domains يدخلها المالك |
| D9 | مصير `quiz_questions` القديم (المفتاح مكشوف عمدًا): يبقى / يُرحَّل ثم يُخفى / يُصلَح كشفه | يبقى الآن، يُرحَّل في M8، يُقرَّر إخفاؤه بعد ذلك |
| D10 | سياسة الإتقان الافتراضية للـ Mistakes (2 متتاليين في محاولتين منفصلتين) قابلة للتغيير لكل دورة؟ | نعم، لكل دورة |
| D11 | تفعيل `pg_cron` (امتداد جديد) للـ sweep، أم الاكتفاء بالفحص الكسول | تفعيله |
| D12 | الاحتفاظ بالبيانات: مدة حفظ أحداث الأمن والمحاولات | أحداث 180 يومًا، المحاولات دائمًا |
