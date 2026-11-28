# PROJECT_CONTEXT — منصة Ahmed Aldeib (مرجع مختصر، حُدّث 2026-11-28)

## الأساس
- موقع ثابت: `node site/build.mjs` يقرأ `site/src` + `site/data` + `site/content` ويكتب `dist/`؛ GitHub Pages من `main`. لا إطار عمل: JS عادي (ES2017) بـ defer، CSS في `site/src/css`.
- Supabase: staging `zvxbuykqzfkcascbzfve`، إنتاج `rlfwkdvecypdjnijhojz`. المفاتيح العامة في `site/data/site.json` (supabase.url/key). Edge functions: `admin-users`, `send-mail`.
- ترحيلات `supabase/migrations/001–022` (+ rollback في docs). وثائق المراحل: `docs/exams`, `docs/lms`. حالة التسليم: `docs/HANDOVER.md` (غير مُلتزَم به).
- قواعد المستخدم: لا commit/push/نشر ولا تغيير على الإنتاج دون موافقة؛ هو يدمج الـ PR (gh غير مسجّل). ردود قصيرة بالعربية. `ui.h` يتجاهل `onclick:` ← استعمل `on:{click:fn}`.

## الصفحات العامة (`site/src/pages`)
index, about, trainer, courses, pmp, capm, pmi, knowledge, blog, faq, contact, privacy, terms, verify, account (دخول/تسجيل), dashboard (المتدرب), admin (المدير). `site/data/courses.json` فيه 6 دورات (pmp, capm, pmi-rmp, pmi-acp, pmi-cp, pmi-pmocp) لكن لا صفحات HTML إلا لـ pmp وcapm (يُتحقق في المرحلة 3). المدونة: `site/content/blog`. القوالب: `site/src/layout` (header, footer, head, bento-card, icons).
- قائمة الهيدر الحالية: الرئيسية، عن، الدورات، PMI، المعرفة، تواصل، الحساب. الفوتر: صفحات + trainer/faq/blog/verify.

## بيانات Supabase (جداول `public`)
profiles, enrollments(active/revoked), courses, course_items(file/video), course_folders, course_staff, site_settings, posts, contact_messages, audit_log, trainer_notes, quiz_attempts/quiz_questions (محاكاة قديمة)، qb_* (بنك الأسئلة: questions, versions, taxonomy, tags, sets, media, types, keys)، ex_* (اختبارات، نسخ، محاولات، أمان SEB، إعدادات الدورة)، lms_* (modules, lessons, lesson_files, progress)، grp_* (مجموعات، جلسات، حضور، تقييمات)، asg_* (واجبات)، dsc_* (مناقشات)، ntf_notifications، cert_certificates. RLS مفعّل؛ الإدارة عبر `role='admin'` في profiles.

## لوحة المدير (`/admin/`)
`admin-core.js` (مساعدات A.*) + `admin.js` (الإقلاع والتوجيه بالـ hash والشريط: 10 أقسام قابلة للطي) + وحدات `admin-*.js`. مركز الدورة `#courses/<id>/<tab>` بتبويبات: subs, lessons, files, videos, questions(bank/folders/team/quick), exams, grading, assignments, discussions, certificates, groups. `admin-lms.js`: learning/reports/certs + شاشات بمنتقي دورة (lessons, groups, assignments, grading, discussions, certissue, qfolders, qteam, cfiles, cvideos). عناصر «قريبًا» = بلا منطق خلفي.
## لوحة المتدرب: `dashboard.html` + `dashboard.js` + `exam-player.js` + `lms-activities.js`.

## الحالة
- مدموج: PR #20 (إعادة تنظيم شريط المدير). المرحلة الحالية: انظر `RESTRUCTURE_PROGRESS.md`.
- معلّق على الإنتاج (قرار منفصل): ترحيلات 021 و022.
