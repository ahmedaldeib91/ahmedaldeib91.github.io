# نظام الاختبارات — M3a: قاعدة بيانات منشئ الاختبارات (Exam builder)

> الحالة: `supabase/migrations/011_exam_builder.sql` **مطبَّق على staging فقط** (`zvxbuykqzfkcascbzfve`، md5 السجل = md5 الملف `869a2e3b30e5e352b7e2b9f22b65e7a9`). **لم يُلمس live**. لا commit.
> الملفات: `011_exam_builder.sql`، `supabase/tests/exams_m3_security_tests.sql`، `docs/exams/rollback-M3a.sql`. المرجع: `01-analysis-and-plan.md` §4.5، §4.10، §5.4.

## 1. ما الذي أُضيف (additive فقط)

| الكائن | الغرض |
|---|---|
| `ex_course_settings(course_id PK, publish_requires_approval default true)` | إعداد لكل دورة؛ غياب الصف = الموافقة مطلوبة. الكتابة للمدير فقط. |
| `ex_exams` | مسودة الاختبار + الإعدادات بأعمدة typed و CHECK + حالة سير العمل. `(course_id, folder_kind)` → `course_folders(course_id, kind)`؛ `scope_taxonomy_id` اختياري (FK مركّب). |
| `ex_exam_items` | اختيار ثابت: `position`، `question_id` (FK مركّب `(course_id, question_id)`)، `points` (null = نقاط الإصدار)، `weight`. |
| `ex_exam_rules` | حصص عشوائية: `taxonomy_id` (العقدة وكل ما تحتها)، `difficulty`، `type_code`، `tag_id` (كلها اختيارية = «أي»)، `draw_count`، `points_each`. |
| `ex_exam_versions` | **لقطة نشر immutable**: `settings jsonb` مجمّد، `total_score`، `question_count`، `requested_by/approved_by/published_by`. |
| `ex_exam_version_items` | الاختيارات الثابتة **مثبّتة على `question_version_id`** وقت النشر بالنقاط الفعلية. |
| `ex_exam_version_rules` / `ex_exam_version_pool` | القواعد المجمّدة + **pool مجمّد ومنفصل لكل قاعدة** (`unique(exam_version_id, question_id)`). |
| 12 RPC | `exam_save`، `exam_preview_pool`، `exam_publish`، `exam_request_approval`، `exam_withdraw`، `exam_approve`، `exam_reject`، `exam_pause`، `exam_resume`، `exam_unpublish`، `exam_archive`، `exam_unarchive`. |

لم يُعدَّل أي كائن من 001–010: لا عمود ولا trigger ولا سياسة ولا منح (مُثبت بـ 9 بصمات md5 متطابقة قبل/بعد على PGlite وstaging). الأثر الوحيد على القائم: FKs جديدة **تشير إلى** `qb_questions/qb_question_versions/qb_taxonomy/qb_tags/course_folders` بـ RESTRICT ⇒ سؤال/عقدة/وسم مستعمل في اختبار لا يُحذف (مقصود).

## 2. الإعدادات (أعمدة + CHECK)

`duration_minutes 1..1440|null`، `open_at/close_at` (`close_at > open_at`)، `grace_seconds 0..600`، `max_attempts 1..100|null`، `pass_percent (0,100]` أو `pass_score > 0` (واحد فقط)، `shuffle_questions/options`، `allow_back/flag`، `allow_whiteboard/calculator/translation`، `timeout_policy auto_submit|void`، `resume_policy resume_any_device|resume_same_session|no_resume`.
السياسات: `review_policy` و`result_policy` ∈ `never|after_submit|after_close|manual`؛ `feedback_policy` و`explanation_policy` ∈ نفسها + `always` (أثناء المحاولة، **practice فقط** — CHECK). الافتراضي الأكثر أمانًا: review/feedback/explanation = `never`، result = `after_submit`.
`security jsonb` = بالضبط `{monitoring, max_warnings 0..50, on_exceed log|warn|flag|auto_submit, fullscreen_required, watermark}`؛ `fullscreen_required` أو `on_exceed≠log` يتطلبان `monitoring` (CHECK عبر `private.ex_security_ok`). الحفظ يدمج الجزئي مع القائم.
`total_score` و`question_count` **يحسبهما الخادم** (`ex_compute_totals`)؛ إرسالهما أو `status` من العميل ⇒ 22023.

## 3. نموذج الصلاحيات

- لا مفاتيح جديدة؛ يُعاد استعمال `exam.write` و`exam.publish`. القراءة = admin أو `exam.write` أو `exam.publish` على الدورة (`private.ex_can_read`).
- **نشر مباشر** = admin، أو `exam.publish` **و** `ex_course_settings.publish_requires_approval = false`. غير ذلك: `exam_publish` من صاحب `exam.write` يتحوّل إلى `pending_approval`.
- approve/reject = **admin فقط**؛ الموافقة تعيد كل التحققات على البنك الحالي.

| الإجراء | من | من → إلى |
|---|---|---|
| `exam_save` | exam.write | draft فقط (غيره 55000) |
| `request_approval` | exam.write | draft → pending (بعد تحقق كامل) |
| `withdraw` | exam.write | pending → draft |
| `approve` / `reject(سبب إلزامي)` | admin | pending → published (تجميد) / draft |
| `publish` | ناشر مباشر | draft\|pending → published (تجميد) |
| `pause` | exam.write أو exam.publish | published → paused |
| `resume` | ناشر مباشر | paused → published (نفس الإصدار) |
| `unpublish` | exam.write أو ناشر مباشر | published\|paused → draft (الإصدارات تبقى) |
| `archive` / `unarchive` | exam.write | draft\|published\|paused → archived / archived → draft |
| حذف REST | exam.write | draft لم يُنشر قط (FK يمنع حذف ما له إصدارات) |

المتدرب وanon: **لا شيء** (لا سياسة، لا RPC، لا قراءة لأي جدول M3a). الأخطاء: 42501 ممنوع (يشمل «غير موجود»)، 55000 حالة غير صالحة/مقفل، 22023 إدخال/`exam_invalid:<codes>`، 23503 صف من دورة أخرى (نفس الرسالة للغائب)، 23514 CHECK، P0001 rate_limited. الحدود: save 60/د، preview 60/د، الانتقالات 30/د لكل مستخدم.

## 4. التجميد والإصدارات

- triggers تعمل حتى على postgres: محتوى `ex_exams` (كل عمود عدا أعمدة سير العمل) وعناصره وقواعده **مقفلة** خارج `draft`؛ الانتقالات المسموحة فقط؛ `published_version_id` لا يتحرك إلا عند draft/pending → published **بإصدار جديد**؛ الإصدارات وأبناؤها لا UPDATE ولا DELETE.
- التعديل بعد النشر: unpublish ← تحرير ← نشر ⇒ `version_no+1`؛ الإصدار السابق يبقى كما هو. تعديل سؤال في البنك لا يغيّر الإصدار المنشور (مثبّت على `question_version_id`).

## 5. التحقق قبل النشر (`ex_collect_errors`)

رموز: `no_questions`، `too_many_questions (>500)`، `item_inactive`، `item_in_set`، `item_type_disabled`، `item_out_of_scope`، `rule_insufficient {position, requested, available}`، `duration_required` (simulation/final)، `pass_required` و`max_attempts_required` (final)، `pass_score_exceeds_total`، `window_closed`، `window_shorter_than_duration` (المتبقي من النافذة < المدة)، `after_close_needs_close_at`، `feedback_needs_review` (review=never مع feedback/explanation مؤجَّل). سؤال من دورة أخرى لا يُحفظ أصلًا (23503).

**الأهلية للـ pool:** نفس الدورة، `active`، ليس ابن scenario set، نوع الإصدار الحالي مفعّل، ليس اختيارًا ثابتًا، داخل `scope` إن وُجد. **First-match-wins:** السؤال المطابق لأكثر من قاعدة يذهب لأولها ترتيبًا ⇒ pools منفصلة.

`exam_preview_pool` (أعداد فقط): `{exam_id}` أو `{course_id, rules, scope_taxonomy_id?, exclude_question_ids?}` ⇒ `{eligible, rules:[{position, requested, matching, available, ok}], fixed_items?, question_count?, total_score?, errors?}`. لا نصوص ولا معرّفات أسئلة ولا مفاتيح (مُختبَر).

## 6. كيف سيستهلك M4 القواعد

`exam_start_attempt`: اختبار `status='published'` ⇒ `published_version_id` ⇒ `ex_exam_versions.settings` (لقطة الإعدادات)، العناصر الثابتة من `ex_exam_version_items` (إصدار السؤال مثبّت)، ولكل صف في `ex_exam_version_rules`: سحب `draw_count` من `ex_exam_version_pool` لنفس `(exam_version_id, rule_no)` بترتيب عشوائي آمن (`order by gen_random_uuid()` = CSPRNG، أو `extensions.gen_random_bytes`) — لا تكرار لأن الـ pools منفصلة ولا تحتوي الثوابت. ثم خلط المواضع إن `shuffle_questions`. `pool_size >= draw_count` مضمون بـ CHECK. المحاولة تحفظ `exam_version_id` + `question_version_id` لكل عنصر.

## 7. الاختبارات والنتائج

- `exams_m3_security_tests.sql`: **207 حالة** (بنية، 9 بصمات «بلا أثر»، anon، متدرب، 6 شخصيات طاقم، CHECKs، عزل الدورات بـ FK مركّب، المعاينة بلا تسريب، 13 رمز تحقق، مسار الموافقة وإعادة التحقق، النشر المباشر حسب إعداد الدورة، التجميد حتى لـ postgres، الإصدار 2، rate limits، audit).
- PGlite (001..011): `rls_security_tests` 111/111، `exams_m1` 217/217، `exams_m3` 207/207؛ بلا بقايا.
- staging: `exams_m3` **207/207 ALL PASS**؛ بقايا = 0 (users/exams/versions/settings/counters/audit rows)، folders = 30. (`rls` و`exams_m1` لم يُعاد تشغيلهما على staging في هذه الجولة؛ بصمات M3 على staging تثبت أن كتالوج 001–010 لم يتغيّر.)
- advisors staging: security = نفس INFO السابقين فقط؛ performance = INFO `unused_index` فقط (جداول فارغة)؛ **لا WARN، لا unindexed FK**.

## 8. الرجوع

`docs/exams/rollback-M3a.sql` (سطر GUARD يُحذف يدويًا، transaction واحدة، يُشغَّل قبل `rollback-M1.sql`). مُتحقَّق على PGlite: الكتالوج بعده **مطابق حرفيًا** لما بعد 010 (945 عنصرًا)، وإعادة تطبيق 011 بعده تعطي الكتالوج نفسه. نسخة مختصرة معلّقة أسفل 011.

## 9. انحرافات عن الخطة

| البند | الخطة | المنفَّذ | السبب |
|---|---|---|---|
| `settings jsonb` | jsonb واحد | أعمدة typed + CHECK؛ `security` فقط jsonb مُتحقَّق | طلب المالك CHECK constraints |
| `mode fixed|random` | عمود | يُستنتج (عناصر و/أو قواعد معًا) | مرونة؛ اختبار مختلط ممكن |
| `ex_exam_sections` | اختيارية | مؤجلة | خارج متطلبات M3a |
| `review_policy` | `none|after_submit|after_window|manual` | `never|after_submit|after_close|manual` (+ `always` للـ feedback/explanation) | توحيد مع صياغة المالك |
| pool | سحب حيّ من البنك | **pool مجمّد عند النشر** | تجميد حقيقي، قابلية إعادة الإنتاج، تحقق التوفر يبقى صحيحًا |
| scenario sets | — | مستبعدة من القواعد ومرفوضة كعناصر ثابتة | تعرض M7 |
| `exam_publish` بلا حق مباشر | — | يتحوّل إلى طلب موافقة | الخطة §4.5 |

## 10. قرارات مفتوحة للمالك

1. **`weight`** مخزّن ومجمّد لكنه **لا يدخل في `total_score`** (المجموع = Σ points). هل يُستعمل كمضاعِف للنسبة في M4 أم للتحليلات فقط؟
2. **pool مجمّد:** أسئلة جديدة في البنك لا تدخل اختبارًا منشورًا حتى إعادة نشره (unpublish→publish). هل هذا المطلوب؟ (وسؤال retired بعد النشر يبقى في الـ pool المجمّد — هل يُستبعد عند السحب في M4؟)
3. من يعتمد الطلبات: admin فقط الآن. هل يُسمح لصاحب `exam.publish` بالاعتماد في دورته؟
4. `pass_required` و`max_attempts_required` مفروضان لـ `final` فقط؛ هل تُفرض على `simulation` أيضًا؟ ولا ربط بين `folder_kind` و`exam_kind`.
5. `resume` يتطلب حق النشر المباشر؛ مدرّب `exam.write` يستطيع الإيقاف لا الاستئناف (تحفّظ أمني).
6. إعادة تشغيل `rls_security_tests` و`exams_m1` على staging بعد 011 (موصى به قبل live).
