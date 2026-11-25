# نظام الاختبارات — M1: أساس قاعدة البيانات

> الحالة: **ملفات فقط، لم تُطبَّق على أي قاعدة** (لا live ولا staging). الفرع `exams-system`.
> الملفات: `supabase/migrations/009_exams_foundation.sql`، `supabase/migrations/010_question_bank.sql`، `supabase/tests/exams_m1_security_tests.sql`، `docs/exams/rollback-M1.sql`.
> المرجع: `docs/exams/01-analysis-and-plan.md` (§3.1، §4.1–4.4، §4.8، §4.11–4.12). قرارات المالك المطبّقة: D1 = `course_staff` بلا قيمة role جديدة؛ CSV أولًا (لا شيء في M1)؛ الترجمة مؤجلة؛ additive فقط.

---

## 1. ما الذي أُضيف (additive فقط)

| الملف | الكائن | الغرض |
|---|---|---|
| 009 | `public.course_staff` | المدرّب = صف نشط `(course_id, user_id, permissions jsonb, active)`. الكتابة للمدير فقط. |
| 009 | `public.course_folders` | 5 مجلدات منطقية ثابتة لكل دورة: `question_bank, domain_tests, exam_simulations, mistakes_quiz, results_analytics`، `unique(course_id, kind)`. |
| 009 | trigger `courses_create_folders` (AFTER INSERT على `courses`) | ينشئ المجلدات لأي دورة جديدة. **الإضافة الوحيدة على جدول قائم**؛ لا تغيّر أي عمود/سياسة/trigger قائم. |
| 009 | `private.rl_counters` + `private.rl_hit()` / `rl_prune()` | محدِّد معدّل عام بنافذة ثابتة ونمط advisory lock (كما في 003/008). |
| 009 | `public.ex_security_events` + `private.log_security_event()` | سجل أحداث الأمن/الشذوذ (للاستعمال من RPCs في M4/M9). `attempt_id` بلا FK حتى M4. |
| 010 | `public.qb_question_types` | سجل الأنواع: 13 نوعًا مزروعًا، 3 مفعّلة (`mcq_single, multi_response, true_false`) لها validator. |
| 010 | `qb_taxonomy`, `qb_tags` | domain ← topic ← subtopic لكل دورة؛ وسوم بتفرّد غير حساس لحالة الأحرف. |
| 010 | `qb_sets`, `qb_set_versions` | سيناريو متعدد الأسئلة (نص مشترك بإصدارات immutable)، والأسئلة الأبناء ترتبط بـ `qb_questions.set_id`. |
| 010 | `qb_questions`, `qb_question_versions`, `qb_question_keys` | السؤال + إصدارات immutable + **جدول مفاتيح منفصل للطاقم فقط** (key, feedback_correct/incorrect, explanation, option_explanations, reference). |
| 010 | `qb_question_tags`, `qb_media` | ربط وسوم؛ بيانات وصفية للمرفقات فقط (bucket `exam-media` في M7). |
| 010 | `public.qb_save_question(jsonb)` | RPC ذرّي: إنشاء سؤال أو إصدار جديد + مفتاحه. |

لم يُلمس: `quiz_questions`، `quiz_attempts`، أي سياسة/منح/دالة من 001–008 (مُختبَر آليًا).

## 2. نموذج الصلاحيات

- `private.has_staff_perm(course_id, perm)`: **admin ⇒ true دائمًا**؛ وإلا صف `course_staff` نشط + ملف `active` + `permissions[perm] = true`. `qbank.write` يتضمّن `qbank.read`.
- المفاتيح المسموحة (`private.staff_permission_keys()`): `qbank.read, qbank.write, qbank.import, exam.write, exam.publish, grading, analytics.read, security.read`. أي مفتاح آخر أو قيمة غير boolean ⇒ خطأ 22023.
- `private.is_course_staff(course_id)`: صف نشط + ملف نشط (بلا اعتبار للأعلام) — يُستعمل لرؤية المجلدات.
- `private.is_any_course_staff()`: لرؤية سجل الأنواع.
- إيقاف الملف (`suspended`) أو `active=false` في `course_staff` يُسقط كل الصلاحيات فورًا.
- الدور يُقرأ من الجداول لا من JWT (`user_metadata.role=admin` لا يمنح شيئًا — مُختبَر).

## 3. السياسات والمنح (RLS enabled + forced على كل جدول جديد)

القاعدة: `revoke all from public, anon, authenticated` فور الإنشاء، ثم منح أدنى لـ `authenticated` فقط. **anon: صفر امتيازات على كل جداول M1.** **المتدرب: لا أي policy تسمح له بأي صف في أي جدول `qb_*` أو `course_folders` أو `course_staff` (غير صفّه إن كان مدرّبًا) أو `ex_security_events`.**

| الجدول | SELECT | INSERT | UPDATE (أعمدة) | DELETE |
|---|---|---|---|---|
| `course_staff` | صاحب الصف أو admin | admin | admin (`staff_role, permissions, active`) | admin |
| `course_folders` | admin أو `is_course_staff` | trigger فقط | admin (`title_ar, title_en, sort`) | مع الدورة فقط (cascade) |
| `ex_security_events` | admin أو `security.read` | RPC DEFINER فقط | — | — |
| `qb_question_types` | admin أو أي مدرّب نشط | migrations فقط | — | — |
| `qb_taxonomy`, `qb_tags`, `qb_sets`, `qb_media` | `qbank.read` | `qbank.write` | `qbank.write` (أعمدة محددة؛ `course_id` غير قابل للتعديل) | `qbank.write` |
| `qb_set_versions` | `qbank.read` | `qbank.write` (`set_id, stem`؛ `course_id` يُشتق من الـ set) | — (immutable) | — |
| `qb_questions` | `qbank.read` | RPC فقط | `qbank.write` (`status` فقط) | **admin فقط** (cascade للإصدارات والمفاتيح) |
| `qb_question_versions`, `qb_question_keys` | `qbank.read` | RPC فقط | ممنوع (immutable) | فقط cascade من حذف السؤال |
| `qb_question_tags` | `qbank.read` | `qbank.write` | — | `qbank.write` |

**عزل الدورات مرتين:** RLS لكل صف بـ `course_id`، و**FKs مركّبة** `(course_id, id)` في كل علاقة (version→question، version→taxonomy، key→version، question→set، set_version→set، tag-link→question/tag، taxonomy→parent). فحتى دالة DEFINER لا تستطيع ربط صف من دورة A بصف من دورة B (مُختبَر: 23503). الوسائط المشار إليها في `payload.media` يُتحقق أنها من الدورة نفسها داخل الـ RPC.

## 4. الدوال

| الدالة | النوع | EXECUTE | ملاحظة |
|---|---|---|---|
| `private.is_course_staff`, `has_staff_perm`, `is_any_course_staff` | DEFINER, stable | authenticated (للسياسات) | `search_path=''`. |
| `private.ensure_course_folders(course?)` | DEFINER | لا أحد | idempotent، يعيد عدد الصفوف المنشأة؛ يُستدعى من الـ trigger وللـ backfill. |
| `private.rl_hit(key, window_sec, max, raise=true)` | DEFINER | لا أحد (للـ RPCs فقط) | يعيد العدّ؛ عند التجاوز يرمي `rate_limited` (P0001) أو يعيد -1 إن `raise=false`. |
| `private.rl_prune(interval)` | DEFINER | لا أحد | تنظيف (يُجدول بـ pg_cron في M4 إن اعتُمد D11). |
| `private.log_security_event(...)` | DEFINER | لا أحد | يختم `user_id = auth.uid()`. |
| `private.qb_validate(type, payload, key)` | invoker | لا أحد | يقرأ `validator` (نص) من السجل، يحلّه بـ `to_regprocedure()` ثم ينفّذه؛ دالة مفقودة = النوع «غير مفعّل» (22023). |
| `private.qb_question_types_before()` | trigger (invoker) | لا أحد | BEFORE INSERT/UPDATE على `qb_question_types`: validator بصيغة صحيحة لكن دالته غير موجودة ⇒ 22023 `validator function not found`. |
| `private.qb_validate_mcq_single / _multi_response / _true_false` | immutable | لا أحد | عقد السجل: `(payload, key) → text[]` (معرّفات الخيارات) أو 22023. |
| `private.qb_save_question(p)` + `public.qb_save_question(p)` | DEFINER + wrapper invoker | authenticated | يتحقق `qbank.write` على دورة **السؤال المخزّن** (لا يثق بـ course_id القادم)، rate limit 120/دقيقة/مستخدم. |
| `private.qb_normalize_text`, `qb_content_hash` | immutable | لا أحد | تطبيع عربي (تشكيل، تطويل، أ/إ/آ/ٱ→ا، ى→ي، ة→ه، أرقام هندية) + sha256 مع ترتيب الخيارات. |

**الـ validators (M1):**
- عام: `payload` كائن ≤64KB بحقول مسموحة فقط؛ `stem.text` 1..10000؛ **رفض أي حقل إجابة داخل الحمولة العامة في أي عمق** (`correct, answer(s), key, is_correct, explanation(s), feedback, rationale, solution`)؛ `media` ≤10 uuid؛ `key` ≤16KB.
- `mcq_single`: 2..10 خيارات `{id ^[a-z0-9_-]{1,16}$, text 1..2000}` بلا تكرار؛ `key={correct: id}`.
- `multi_response`: 2..15 خيارًا، `min_select/max_select` اختياريان؛ `key={correct:[ids≥1 بلا تكرار ⊆ الخيارات, ضمن min..max], scoring: all_or_nothing|partial|partial_penalty}`.
- `true_false`: `payload={stem, labels?{true,false}}`؛ `key={correct:"true"|"false"}`.
- `option_explanations` مفاتيحها ⊆ معرّفات الخيارات، نصوص ≤4000.

**مدخلات `qb_save_question`:** `question_id?` (غيابه = سؤال جديد)، `course_id` (للجديد)، `type_code`، `payload`، `key`، `feedback_correct?`، `feedback_incorrect?`، `explanation?`، `option_explanations?`، `reference?`، `taxonomy_id?`، `difficulty? (easy|medium|hard)`، `points?`، `weight?`، `lang? (ar|en|mixed)`، `set_id?`، `status?`. عند التعديل: الحقول الاختيارية الغائبة تُورَّث من الإصدار الحالي؛ `payload` و`key` مطلوبان دائمًا. أي حقل غير معروف ⇒ 22023. المخرجات: `{question_id, version_id, version_no, content_hash, duplicates}` (`duplicates` = أسئلة أخرى في الدورة نفس الـ hash الحالي — تحذير لا منع).
**الأخطاء:** `42501` forbidden (يشمل «غير موجود» لمنع كشف الوجود)، `22023` إدخال غير صالح، `23503` صف من دورة أخرى، `P0001` rate_limited.

## 5. الثبات (Immutability) والتدقيق

- `qb_question_versions`, `qb_question_keys`, `qb_set_versions`: trigger يرفض أي UPDATE (حتى من postgres)، ويرفض DELETE المباشر؛ يُسمح فقط بالحذف المتتالي (cascade) من حذف السؤال/الـ set (`pg_trigger_depth() > 1`). التحرير = إصدار جديد و`current_version_id` يتحرك (FK مركّب `(id, current_version_id)` يضمن أنه إصدار للسؤال نفسه).
- `audit_log` (نفس الجدول القائم): `course_staff.granted|updated|deactivated|reactivated|deleted`، `qb_question.created|status_changed|deleted`. الإصدارات نفسها هي سجل التحرير.

## 6. التوافق الخلفي (لماذا cascade في مكانين)

- `course_folders` و`course_staff`: `ON UPDATE/DELETE CASCADE` إلى `courses`، كي يبقى حذف/إعادة تسمية دورة **بلا محتوى** ممكنًا كما قبل 009 (مُختبَر: إنشاء دورة ← 5 مجلدات ← حذفها ينجح؛ إعادة تسمية `id` تنقل المجلدات والطاقم).
- كل جداول `qb_*` و`ex_security_events`: `RESTRICT` كنمط 001 (دورة لها محتوى لا تُحذف).

## 7. الاختبارات

`supabase/tests/exams_m1_security_tests.sql` — 217 حالة داخل transaction تنتهي بـ ROLLBACK، بنفس harness الملف القديم + `expect_state` (SQLSTATE محدد) و`expect_ok` و`keep/idof` لتمرير المعرّفات بين الأدوار. صف ملخّص أخير `ALL PASS`.

الشخصيات: T متدرب مشترك في capm؛ I1 مدرّب capm `{qbank.write}`؛ I2 مدرّب pmp `{qbank.read, security.read}`؛ I3 مدرّب capm بلا أعلام؛ I4 مدرّب capm موقوف الملف؛ AD مدير؛ anon.

التغطية:
1. **البنية:** backfill = 5 × عدد الدورات؛ إعادة الـ backfill = 0؛ تفرّد `(course_id, kind)`؛ RLS forced على 13 جدولًا؛ anon بلا أي امتياز جدول/عمود؛ لا INSERT/UPDATE على الإصدارات/المفاتيح؛ كل دوال `private` بـ `search_path` ثابت؛ anon/authenticated لا ينفّذون الدوال الداخلية.
2. **عدم المساس بالقائم:** سياسات `quiz_questions` (4) و`quiz_attempts` (3) بالأسماء، 37 سياسة على جداول 001، منح `correct_index` كما هو، CHECK الدور `trainee|admin`، triggers على `courses` = القديم + الجديد فقط؛ + تشغيل `rls_security_tests.sql` القديم (111 حالة) بعد 009/010.
3. **anon:** مخفي/ممنوع على كل جدول ودالة.
4. **المتدرب:** 0 صفوف في كل `qb_*` ومنها المفاتيح رغم اشتراكه، لا مجلدات/طاقم/أحداث، RPC ⇒ 42501، لا تعيين ذاتي.
5. **I1:** CRUD التصنيف (قواعد المستويات)، الوسوم، الوسائط (بادئة المسار)، حفظ MCQ/MR/TF، الإصدار 2 لا يغيّر الإصدار 1 ولا مفتاحه، كشف التكرار مع تشكيل/ترتيب مختلف، 15 حالة validator، الـ sets والأسئلة الأبناء، لا تعديل للإصدارات/المفاتيح/`current_version_id`، لا حذف أسئلة، **دورة pmp مخفية وغير قابلة للكتابة** (قراءة/تحديث/حذف/RPC)، لا تصعيد صلاحيات، لا وصول للجداول الإدارية القديمة.
6. **FK المركّب:** taxonomy/set/media/tag من pmp على سؤال capm ⇒ 23503 أو رفض RLS.
7. **أعلام الصلاحيات:** I2 يقرأ ولا يكتب، يرى أحداث pmp فقط؛ I3 بلا أعلام لا يرى البنك؛ I4 الموقوف بلا صلاحيات؛ I1 بعد التعطيل بلا صلاحيات.
8. **admin:** كل شيء، تعيين/تعطيل طاقم، إنشاء دورة ⇒ مجلدات، حذف دورة فارغة، منع حذف دورة لها محتوى، حذف سؤال مع cascade.
9. **Immutability** حتى لـ postgres؛ **rate limit** (1..3 ثم P0001، العدّ يبقى عند الحد، وضع بلا رمي، استقلال المفاتيح، تجاهل النوافذ القديمة، prune، وسائط غير صالحة، وتكامله مع `qb_save_question`)؛ `log_security_event`؛ **audit**.

### طريقة التشغيل على staging (قبل live)
1. طبّق 001..008 ثم 009 ثم 010 على staging (نفس ترتيب الملفات).
2. SQL Editor: الصق `supabase/tests/exams_m1_security_tests.sql` كاملًا وشغّله ⇒ يجب أن يكون الصف الأخير `ALL PASS`.
3. شغّل `supabase/tests/rls_security_tests.sql` ⇒ 111 PASS (لا انحدار).
4. `get_advisors` (security + performance) وراجع أي تحذير جديد.
5. تحقق بعد التشغيل: `select count(*) from public.qb_questions;` = 0 و`select count(*) from public.course_staff;` = 0 (الـ ROLLBACK نظّف كل شيء)، و`select count(*) from public.course_folders;` = 5 × عدد الدورات.

### ما الذي شُغّل فعلًا (محليًا)
- لا يوجد psql/Docker/Postgres على الجهاز. استُعمل **PGlite 0.6.0** (Postgres حقيقي مترجم إلى WASM، يدعم plpgsql وRLS والأدوار) داخل مجلد مُتجاهَل `_tmp_pglite/` مع shim يحاكي Supabase (`auth.uid()/role()`، `auth.users`، `storage.*`، أدوار anon/authenticated/service_role، default privileges كما في Supabase).
- النتيجة: 001..010 تُطبَّق بلا خطأ؛ `rls_security_tests.sql` = 111/111 PASS؛ `exams_m1_security_tests.sql` = 217/217 PASS (بعد تعديل 010 أدناه)؛ بعد الاختبارات لا بقايا.
- حدود هذا التحقق: PGlite يعمل بـ Postgres **19** (الحي 17.12)، و`postgres` فيه superuser (على Supabase هو `bypassrls` لا superuser)، والـ shim ليس Supabase الحقيقي ⇒ **التشغيل على staging إلزامي** قبل live.

## 8. الرجوع (Rollback)

- `docs/exams/rollback-M1.sql`: يحذف كائنات 010 ثم 009 فقط، داخل transaction. يبدأ بسطر GUARD يرمي خطأ عمدًا — يُحذف السطر يدويًا للتشغيل. **مدمّر لبيانات M1** (أسئلة، طاقم، مجلدات، أحداث)؛ لا يلمس 001–008 سوى إزالة الـ trigger المضاف على `courses`؛ صفوف `audit_log` تُترك.
- مُتحقَّق محليًا: الكتالوج (جداول/أعمدة/قيود/فهارس/سياسات/triggers/دوال/منح) بعد الرجوع **مطابق حرفيًا** لحالة ما بعد 008 (595 عنصرًا)؛ والـ GUARD يمنع التشغيل العرضي.
- نسخة مختصرة معلّقة (commented) أسفل كل migration.
- قبل أي تطبيق على live: `pg_dump` من جهاز المالك (لا backups على Free).

## 9. انحرافات عن خطة 01 وأسبابها

| البند | الخطة | المنفَّذ | السبب |
|---|---|---|---|
| عدد الأنواع | «15 نوعًا» | 13 نوعًا + كيان `qb_sets` | الخطة نفسها تعدّد 13 رمزًا + السيناريو متعدد الأسئلة ككيان مستقل. لم أخترع نوعين. **يحتاج تأكيد المالك لقائمة الـ15.** |
| اسم الملف | `009_exam_foundation.sql`, `010_qbank.sql` | `009_exams_foundation.sql`, `010_question_bank.sql` | تسمية المهمة. |
| `qb_import_jobs` | في §4.4 | مؤجَّل إلى M8 | الاستيراد خارج نطاق M1. |
| bucket `exam-media` | M7 | جدول بيانات وصفية `qb_media` فقط | الخطة تضع الـ bucket والتوقيع في M7. |
| `qb_questions.folder` | عمود في §4.4 | غير مضاف | البنك كله في مجلد `question_bank` ضمنيًا؛ ربط المجلدات فعلي مع `ex_exams.folder_kind` في M3. |
| `ON DELETE` للمجلدات/الطاقم | الخطة: restrict كنمط | cascade | حتى لا يُكسر سلوك قائم (حذف/إعادة تسمية دورة فارغة). |
| `qb_set_versions` | لم يحدّد مسار الكتابة | REST مباشر للطاقم + triggers (ترقيم، `course_id` من الـ set، تحريك `current_version_id`) | جدول واحد بلا حاجة لذرّية متعددة الجداول؛ RPC إضافي خارج نطاق M1. |
| الصعوبة | قرار ثانوي D8 | `easy|medium|hard` | توصية D8. |
| validators | plpgsql أو pg_jsonschema | plpgsql + `validator text` في السجل (CHECK للصيغة + trigger للوجود) | لا امتداد جديد؛ `regprocedure` كان يمنع `pg_upgrade` (تحذير advisor). |

## 10. مخاطر/قضايا مفتوحة

1. **المدرّب لا يرى صف الدورة غير المنشورة** في `courses` (السياسة القائمة `published or is_admin`). لم تُعدَّل عمدًا (additive). الحل لاحقًا: RPC `staff_my_courses()` أو سياسة إضافية — قرار للمالك عند M2.
2. **أداء RLS للطاقم:** `has_staff_perm(course_id, …)` يُقيَّم لكل صف للمدرّبين (المدير مختصَر بـ initplan). مقبول لأحجام البنك المتوقعة (آلاف)؛ للقوائم الكبيرة في M2 يُفضَّل التصفية بـ `course_id` دائمًا (الفهارس موجودة).
3. `ex_security_events.course_id` RESTRICT: دورة لها أحداث أمن لا تُحذف (مقصود، كنمط 001).
4. `rl_hit` عند الرمي يتراجع مع الـ transaction (العدّاد يبقى عند الحد؛ السلوك صحيح) — أي حدث أمني يُكتب في نفس الـ transaction يضيع أيضًا؛ RPCs في M4 يجب أن تستعمل `raise=false` ثم تسجّل الحدث ثم ترمي.
5. لا pg_cron بعد (D11)؛ `rl_prune` يدوي حتى M4.
6. سجل الأنواع يكتبه الـ migrations فقط؛ أي نوع جديد = migration صغيرة (صف + دالة)، بلا تغيير جداول.
7. المفاتيح مرئية لكل من يملك `qbank.read` (حسب الخطة §4.4). إن أراد المالك فصل «قراءة البنك» عن «قراءة المفاتيح» فيُضاف علم `qbank.keys` لاحقًا.

## 11. تعديل 010 بعد مراجعة staging (قبل أي تطبيق على live)

- **`qb_question_types.validator`: `regprocedure` ← `text`.** advisor نبّه أن عمود `reg*` (غير regclass/regtype/…) يمنع `pg_upgrade`. الآن: CHECK `qb_question_types_validator_format_chk` (`^private\.qb_validate_[a-z0-9_]+\(jsonb,jsonb\)$`) ⇒ 23514، وtrigger `qb_question_types_before` (BEFORE INSERT/UPDATE، `search_path=''`، EXECUTE مسحوب) يرفض اسمًا صحيح الصيغة لدالة غير موجودة ⇒ 22023. القيد `qb_question_types_enabled_needs_validator_chk` بلا تغيير. الزرع بنصوص عادية.
- **`private.qb_validate`** يحلّ النص بـ `to_regprocedure()` عند كل استدعاء؛ دالة حُذفت لاحقًا = «غير مفعّل» (22023)، والتنفيذ ما زال `format('select %s($1,$2)', oid::regproc)`.
- **فهرس جديد** `qb_question_versions_question_idx (course_id, question_id)` يغطي FK `qb_question_versions_question_fkey` (advisor: unindexed FK).
- **الاختبارات (+17):** فحوص السجل الجديدة (نوع العمود، الدوال المزروعة موجودة، 22023 للدالة المفقودة INSERT/UPDATE، 23514 للصيغة، الـ dispatcher ما زال يشغّل validator الـ MCQ ويرمي أخطاءه)، ونسخ **بدور postgres** (بلا حاجز امتيازات الأعمدة) تثبت أن الـ triggers نفسها هي التي ترفض: تغيير `level`/`course_id` في التصنيف، تغيير `course_id`/`user_id` في `course_staff`، ودورة لها محتوى بنك فقط (بلا `ex_security_events`) لا تُحذف بسبب FKs `qb_*` (23503 حتى PG17، 23001 من PG18). helper جديد `expect_raise` يتحقق من SQLSTATE **والرسالة**.
- `rollback-M1.sql` والكتلة المعلّقة في 010 يحذفان `private.qb_question_types_before()` أيضًا.
- staging أُعيد بناؤه لـ 010 (حذف كائنات 010 + صف سجلّه القديم ثم `apply_migration` للملف المعدّل؛ md5 السجل = md5 الملف): 217/217 + 111/111، advisors بلا WARN وبلا unindexed FK.
