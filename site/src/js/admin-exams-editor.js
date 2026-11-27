/* =====================================================================
   admin-exams-editor.js — محرر الاختبار (#exams/<course>/new | /edit/<uuid>) (M3b)
   ملف عادي (ES2017) يُحمَّل بـ defer بعد admin-exams.js. يضع نفسه في A.ex.mods.editor.

   يحرّر المسودة وحدها (الاختبار المنشور مجمَّد في القاعدة): الأساسيات والنافذة والتصحيح والعرض والأمن، والأسئلة الثابتة
   (من بنك الدورة: المفعّلة فقط، بنقاط اختيارية تتجاوز نقاط السؤال)، وقواعد السحب العشوائي (تصنيف/صعوبة/نوع/وسم + العدد + نقاط كل سؤال)،
   ثم يحفظ الكل بنداء واحد exam_save (استبدال كامل للأسئلة والقواعد). مجموع الأسئلة والدرجات يحسبهما الخادم.
   «فحص التوفر» يستدعي exam_preview_pool بأعداد فقط (لا نصوص ولا معرّفات أسئلة).
   ===================================================================== */
(function () {
  'use strict';

  const A = window.Admin;
  if (!A || !A.ex || !A.qb) return;
  const EX = A.ex;
  const QB = A.qb;
  const P = A.P;
  const h = A.h;
  const ui = A.ui;
  const VERSION_EMBED = 'qb_question_versions!qb_questions_current_version_fkey!inner(type_code,difficulty,points,payload)';
  const MAX_ITEMS = 500;
  const MAX_RULES = 50;

  const verOf = function (row) { const v = row.qb_question_versions; return Array.isArray(v) ? v[0] : v; };
  const stemOf = function (v) { return v && v.payload && v.payload.stem && typeof v.payload.stem.text === 'string' ? v.payload.stem.text : ''; };
  const excerpt = function (s) { const a = Array.from(String(s || '').replace(/\s+/g, ' ').trim()); return a.length > 90 ? a.slice(0, 90).join('') + '…' : a.join('') || '—'; };
  const likeTerm = function (s) { return String(s == null ? '' : s).replace(/\*/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100).replace(/[\\%_]/g, '\\$&'); };
  const pad = function (n) { return n < 10 ? '0' + n : String(n); };
  const toLocal = function (iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return isNaN(d) ? '' : d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  };
  const fromLocal = function (v) { if (!v) return null; const d = new Date(v); return isNaN(d) ? undefined : d.toISOString(); };
  const optInt = function (v) { const s = String(v == null ? '' : v).trim(); if (!s) return null; const n = Number(s); return Number.isInteger(n) ? n : NaN; };
  const optNum = function (v) { const s = String(v == null ? '' : v).trim().replace(',', '.'); if (!s) return null; const n = Number(s); return Number.isFinite(n) ? n : NaN; };

  /* خيارات التصنيف مسطّحة بمسافات بادئة بحسب العمق */
  function taxOptions(tax, first) {
    const out = [['', first]];
    const walk = function (nodes, depth) {
      nodes.forEach(function (n) {
        out.push([n.id, new Array(depth + 1).join('— ') + n.name_ar]);
        walk(tax.children(n.id), depth + 1);
      });
    };
    walk(tax.roots, 0);
    return out;
  }

  async function loadExam(course, id) {
    const rows = await P.rest.select('ex_exams', { select: '*', id: 'eq.' + id, course_id: 'eq.' + course, limit: '1' });
    if (!rows.length) return null;
    const r = await Promise.all([
      P.rest.select('ex_exam_items', { select: 'position,question_id,points,weight', exam_id: 'eq.' + id, order: 'position.asc', limit: '500' }),
      P.rest.select('ex_exam_rules', { select: 'position,taxonomy_id,difficulty,type_code,tag_id,draw_count,points_each', exam_id: 'eq.' + id, order: 'position.asc', limit: '50' })
    ]);
    const items = r[0];
    const info = {};
    if (items.length) {
      const qs = await P.rest.select('qb_questions', { select: 'id,status,' + VERSION_EMBED, course_id: 'eq.' + course, id: 'in.(' + items.map(function (i) { return i.question_id; }).join(',') + ')', limit: '500' });
      qs.forEach(function (q) { info[q.id] = q; });
    }
    return { exam: rows[0], items: items, rules: r[1], info: info };
  }

  function itemFrom(q) {
    const v = verOf(q) || {};
    return { question_id: q.id, points: '', weight: 1, stem: stemOf(v), type: v.type_code, diff: v.difficulty, qpoints: v.points, status: q.status };
  }

  async function render(root, o) {
    const course = o.course;
    const token = o.token;
    const editing = o.mode === 'edit';
    const back = EX.href(course, 'list');
    root.appendChild(A.loading('جارٍ تحميل المحرر…'));
    let types;
    let tax;
    let tags;
    let loaded = null;
    try {
      const r = await Promise.all([QB.getTypes(), QB.getTax(course, true), QB.getTags(course, true), editing ? loadExam(course, o.id) : null]);
      types = r[0]; tax = r[1]; tags = r[2]; loaded = r[3];
    } catch (err) {
      if (A.stale(token)) return;
      A.clear(root);
      EX.loadFail(root, err, function () { A.clear(root); render(root, o); });
      return;
    }
    if (A.stale(token)) return;
    A.clear(root);
    if (editing && !loaded) {
      root.appendChild(A.head('اختبار غير موجود', null, []));
      root.appendChild(A.empty('لم نجد هذا الاختبار', 'قد يكون حُذف أو يتبع دورة أخرى.', A.link('العودة للقائمة', back, { kind: 'p', icon: 'back' })));
      return;
    }
    const ex = loaded ? loaded.exam : null;
    if (ex && ex.status !== 'draft') {
      root.appendChild(A.head(ex.title_ar, null, []));
      root.appendChild(A.empty('الاختبار مقفل', 'حالته «' + EX.label(EX.STATUS, ex.status) + '»: لا يُعدَّل إلا وهو مسودة. من القائمة استعمل «سحب من النشر» ثم عدّله وانشره بإصدار جديد.',
        A.link('العودة للقائمة', back, { kind: 'p', icon: 'back' })));
      return;
    }

    root.appendChild(A.head(ex ? 'تعديل اختبار' : 'اختبار جديد', 'دورة: ' + A.courseTitle(course) + '. المجاميع تُحسب في الخادم عند الحفظ.', [A.link('العودة للقائمة', back, { small: true, icon: 'back' })]));
    const out = A.msgBox();

    /* ---------- الأساسيات ---------- */
    const f = {};
    const val = function (k, d) { return ex && ex[k] != null ? ex[k] : d; };
    f.title_ar = A.input({ max: 300, value: val('title_ar', ''), required: true });
    f.title_en = A.input({ max: 300, value: val('title_en', ''), ltr: true });
    f.description_ar = A.textarea({ rows: 3, max: 5000, value: val('description_ar', '') });
    f.description_en = A.textarea({ rows: 3, max: 5000, value: val('description_en', ''), dir: 'ltr' });
    f.exam_kind = A.select(EX.KIND, val('exam_kind', 'practice'));
    f.folder_kind = A.select(EX.FOLDER, val('folder_kind', 'domain_tests'));
    f.scope = A.select(taxOptions(tax, 'كل بنك الدورة'), val('scope_taxonomy_id', ''));
    const basics = A.card('الأساسيات', [
      h('div', { class: 'ad-tools' }, A.field('العنوان (عربي) *', f.title_ar), A.field('العنوان (إنجليزي)', f.title_en)),
      h('div', { class: 'ad-tools' }, A.field('الوصف (عربي)', f.description_ar), A.field('الوصف (إنجليزي)', f.description_en)),
      h('div', { class: 'ad-tools' },
        A.field('نوع الاختبار', f.exam_kind, 'التدريب يسمح بإظهار الإجابة أثناء المحاولة؛ المحاكاة والنهائي يتطلبان مدة؛ النهائي يتطلب حدّ نجاح وعدد محاولات.'),
        A.field('المجلد', f.folder_kind),
        A.field('نطاق التصنيف', f.scope, 'اختياري: يحصر أسئلة الاختبار (الثابتة والعشوائية) في هذا الفرع.'))
    ]);

    /* ---------- النافذة والنجاح ---------- */
    f.duration = A.input({ type: 'number', min: 1, maxv: 1440, step: 1, inputmode: 'numeric', value: val('duration_minutes', '') });
    f.open_at = A.input({ type: 'datetime-local', value: toLocal(val('open_at', null)) });
    f.close_at = A.input({ type: 'datetime-local', value: toLocal(val('close_at', null)) });
    f.grace = A.input({ type: 'number', min: 0, maxv: 600, step: 1, inputmode: 'numeric', value: val('grace_seconds', 30) });
    f.attempts = A.input({ type: 'number', min: 1, maxv: 100, step: 1, inputmode: 'numeric', value: val('max_attempts', '') });
    const passMode = ex && ex.pass_percent != null ? 'percent' : (ex && ex.pass_score != null ? 'score' : 'none');
    f.passMode = A.select([['none', 'بلا حدّ نجاح'], ['percent', 'نسبة مئوية'], ['score', 'درجة']], passMode);
    f.passVal = A.input({ type: 'number', min: 0, step: 'any', inputmode: 'decimal', value: ex ? (ex.pass_percent != null ? ex.pass_percent : (ex.pass_score != null ? ex.pass_score : '')) : '' });
    const timing = A.card('الوقت والمحاولات والنجاح', [
      h('div', { class: 'ad-tools' },
        A.field('المدة (دقيقة)', f.duration, 'فارغ = بلا مؤقت (للتدريب فقط).'),
        A.field('فتح الاختبار', f.open_at, 'فارغ = مفتوح فورًا.'),
        A.field('إغلاق الاختبار', f.close_at, 'فارغ = بلا إغلاق.')),
      h('div', { class: 'ad-tools' },
        A.field('مهلة التسليم (ثانية)', f.grace, 'سماحية بعد انتهاء الوقت (٠–٦٠٠).'),
        A.field('عدد المحاولات', f.attempts, 'فارغ = غير محدود.'),
        A.field('حدّ النجاح', f.passMode), A.field('قيمة حدّ النجاح', f.passVal, 'نسبة ١–١٠٠ أو درجة موجبة.'))
    ]);

    /* ---------- العرض والنتائج ---------- */
    const cb = {
      shuffle_questions: A.checkbox('ترتيب الأسئلة عشوائيًا', val('shuffle_questions', true)),
      shuffle_options: A.checkbox('ترتيب الخيارات عشوائيًا', val('shuffle_options', true)),
      allow_back: A.checkbox('السماح بالرجوع للسؤال السابق', val('allow_back', true)),
      allow_flag: A.checkbox('السماح بوضع علامة للمراجعة', val('allow_flag', true)),
      allow_whiteboard: A.checkbox('إتاحة السبّورة', val('allow_whiteboard', false)),
      allow_calculator: A.checkbox('إتاحة الآلة الحاسبة', val('allow_calculator', false)),
      allow_translation: A.checkbox('إتاحة الترجمة', val('allow_translation', false), 'تُفعَّل وظيفتها في مرحلة لاحقة.')
    };
    f.review = A.select(EX.POLICY, val('review_policy', 'never'));
    f.result = A.select(EX.POLICY, val('result_policy', 'after_submit'));
    f.feedback = A.select(EX.POLICY_LIVE, val('feedback_policy', 'never'));
    f.explanation = A.select(EX.POLICY_LIVE, val('explanation_policy', 'never'));
    f.timeout = A.select(EX.TIMEOUT, val('timeout_policy', 'auto_submit'));
    f.resume = A.select(EX.RESUME, val('resume_policy', 'resume_any_device'));
    const delivery = A.card('العرض والنتائج', [
      h('div', { class: 'ad-tools' }, cb.shuffle_questions.el, cb.shuffle_options.el, cb.allow_back.el, cb.allow_flag.el),
      h('div', { class: 'ad-tools' }, cb.allow_whiteboard.el, cb.allow_calculator.el, cb.allow_translation.el),
      h('div', { class: 'ad-tools' },
        A.field('مراجعة الإجابات', f.review, 'متى يرى المتدرب إجاباته بعد المحاولة.'),
        A.field('النتيجة', f.result),
        A.field('ملاحظات الإجابة', f.feedback, '«أثناء المحاولة» للتدريب فقط.'),
        A.field('الشرح', f.explanation, '«أثناء المحاولة» للتدريب فقط.')),
      h('div', { class: 'ad-tools' }, A.field('عند انتهاء الوقت', f.timeout), A.field('استئناف المحاولة', f.resume))
    ]);

    /* ---------- الأمن ---------- */
    const sec = (ex && ex.security) || {};
    const sMon = A.checkbox('تفعيل المراقبة (تسجيل مغادرة النافذة وغيرها)', !!sec.monitoring, 'مراقبة من جهة المتصفح تردع ولا تمنع الغش تمامًا.');
    const sFull = A.checkbox('إلزام ملء الشاشة', !!sec.fullscreen_required, 'يتطلب تفعيل المراقبة.');
    const sMark = A.checkbox('علامة مائية باسم المتدرب', !!sec.watermark);
    f.sWarn = A.input({ type: 'number', min: 0, maxv: 50, step: 1, inputmode: 'numeric', value: sec.max_warnings != null ? sec.max_warnings : 3 });
    f.sExceed = A.select(EX.ON_EXCEED, sec.on_exceed || 'log');
    const sSeb = A.checkbox('اشتراط Safe Exam Browser', !!sec.require_seb, 'لا يبدأ المتدرب ولا تُعرض له الأسئلة إلا من داخل SEB ببصمة مطابقة.');
    f.sKeys = A.textarea({ rows: 3, max: 800, dir: 'ltr', value: Array.isArray(sec.seb_keys) ? sec.seb_keys.join('\n') : '', placeholder: 'بصمة واحدة في كل سطر (64 حرفًا سداسيًا)' });
    const security = A.card('الأمن', [
      h('div', { class: 'ad-tools' }, sMon.el, sFull.el, sMark.el),
      h('div', { class: 'ad-tools' }, A.field('الحد الأقصى للتحذيرات', f.sWarn, '٠–٥٠.'), A.field('عند تجاوز الحد', f.sExceed, 'غير «تسجيل فقط» يتطلب تفعيل المراقبة.')),
      h('div', { class: 'ad-tools' }, sSeb.el),
      A.field('بصمات SEB المسموحة', f.sKeys, 'افتح ملف إعداد SEB ثم صفحة ‎/dashboard/#seb-info‎ من داخله، وانسخ بصمة «مفتاح الإعداد» أو «مفتاح المتصفح». حتى عشر بصمات.')
    ]);

    /* ---------- الأسئلة الثابتة ---------- */
    const items = loaded ? loaded.items.map(function (it) {
      const q = loaded.info[it.question_id];
      const base = q ? itemFrom(q) : { question_id: it.question_id, stem: '(سؤال غير متاح)', type: '', diff: '', qpoints: null, status: 'unknown' };
      base.points = it.points == null ? '' : String(it.points);
      base.weight = it.weight == null ? 1 : it.weight;
      return base;
    }) : [];
    const itemsBox = h('div');
    const itemsCount = h('p', { class: 'ad-count-t', role: 'status' });
    function paintItems() {
      A.clear(itemsBox);
      itemsCount.textContent = items.length ? 'عدد الأسئلة الثابتة: ' + A.num(items.length) + ' (الحد ٥٠٠).' : 'لا أسئلة ثابتة. يمكنك الاكتفاء بقواعد السحب العشوائي.';
      if (!items.length) return;
      const cols = [
        { label: '#', cell: function (r, i) { return A.num(i + 1); } },
        { label: 'السؤال', cell: function (r) {
          return h('div', null, h('span', { dir: 'auto', text: excerpt(r.stem) }),
            r.status && r.status !== 'active' ? h('div', null, A.badge(r.status === 'unknown' ? 'غير متاح' : 'غير مفعّل: لن يُنشر الاختبار قبل تفعيله أو حذفه', 'warn')) : null);
        } },
        { label: 'النوع / الصعوبة', cell: function (r) { return (r.type ? QB.typeLabel(r.type) : '—') + ' · ' + QB.labelOf(QB.DIFF, r.diff, '—'); } },
        { label: 'النقاط', cell: function (r) {
          const inp = A.input({ type: 'number', min: 0, step: 'any', inputmode: 'decimal', value: r.points, placeholder: r.qpoints != null ? 'من السؤال: ' + r.qpoints : 'من السؤال', aria: 'نقاط السؤال' });
          inp.addEventListener('input', function () { r.points = inp.value; });
          return inp;
        } },
        { label: 'ترتيب', cell: function (r, i) {
          return h('div', { class: 'ad-rowact' },
            A.ibtn('up', 'تحريك لأعلى', function () { if (i > 0) { items.splice(i - 1, 0, items.splice(i, 1)[0]); paintItems(); } }),
            A.ibtn('down', 'تحريك لأسفل', function () { if (i < items.length - 1) { items.splice(i + 1, 0, items.splice(i, 1)[0]); paintItems(); } }),
            A.ibtn('trash', 'إزالة من الاختبار', function () { items.splice(i, 1); paintItems(); }, 'danger'));
        } }
      ];
      itemsBox.appendChild(A.dataTable(cols, items, { caption: 'الأسئلة الثابتة' }));
    }
    function openPicker() {
      const term = A.input({ type: 'search', max: 100, placeholder: 'ابحث في نص السؤال (فارغ = الأحدث)' });
      const go = A.btn('بحث', { small: true, icon: 'search' });
      const list = h('div');
      const add = A.btn('إضافة المحدد', { kind: 'p', small: true });
      const pickMsg = A.msgBox();
      let found = [];
      const chosen = {};
      function paintFound() {
        A.clear(list);
        const have = {};
        items.forEach(function (i) { have[i.question_id] = true; });
        const rows = found.filter(function (q) { return !have[q.id]; });
        if (!rows.length) { list.appendChild(h('p', { class: 'ad-muted', text: 'لا نتائج جديدة (الأسئلة المضافة مسبقًا لا تظهر).' })); return; }
        rows.forEach(function (q) {
          const v = verOf(q) || {};
          const c = h('input', { type: 'checkbox', id: A.nid('pk') });
          c.checked = !!chosen[q.id];
          c.addEventListener('change', function () { if (c.checked) chosen[q.id] = q; else delete chosen[q.id]; });
          list.appendChild(h('label', { class: 'pf-check', for: c.id }, c, h('span', { dir: 'auto', text: excerpt(stemOf(v)) + ' — ' + QB.typeLabel(v.type_code) + ' · ' + QB.labelOf(QB.DIFF, v.difficulty, '') })));
        });
      }
      async function search() {
        const q = { select: 'id,status,' + VERSION_EMBED, course_id: 'eq.' + course, status: 'eq.active', order: 'updated_at.desc,id.asc', limit: '30' };
        const t = likeTerm(term.value);
        if (t) q['qb_question_versions.payload->stem->>text'] = 'ilike.*' + t + '*';
        found = await P.rest.select('qb_questions', q);
        paintFound();
      }
      go.addEventListener('click', EX.run(go, pickMsg, 'list', search));
      term.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); go.click(); } });
      const body = h('div', { class: 'ad-qb-pick' }, h('div', { class: 'ad-tools' }, A.field('بحث', term), go), pickMsg, list, h('div', { class: 'ad-act' }, add));
      const end = QB.modal('إضافة أسئلة من بنك الدورة', body);
      add.addEventListener('click', function () {
        const picks = Object.keys(chosen).map(function (k) { return chosen[k]; });
        if (!picks.length) { ui.msg(pickMsg, 'err', 'اختر سؤالًا واحدًا على الأقل.'); return; }
        if (items.length + picks.length > MAX_ITEMS) { ui.msg(pickMsg, 'err', 'الحد الأقصى ' + MAX_ITEMS + ' سؤال ثابت في الاختبار.'); return; }
        picks.forEach(function (q) { items.push(itemFrom(q)); });
        paintItems();
        end();
      });
      search().catch(function (err) { if (A.isSession(err)) A.lost('expired'); else EX.say(pickMsg, err, 'list'); });
    }
    const addBtn = A.btn('إضافة أسئلة من البنك', { kind: 'p', small: true, icon: 'plus', on: openPicker });
    const fixed = A.card('الأسئلة الثابتة', [
      h('p', { class: 'ad-muted', text: 'تُثبَّت على إصدار السؤال وقت النشر، فتعديل السؤال لاحقًا في البنك لا يغيّر الاختبار المنشور. تظهر الأسئلة المفعّلة وحدها في الاختيار.' }),
      h('div', { class: 'ad-qb-bar' }, addBtn), itemsCount, itemsBox
    ]);

    /* ---------- قواعد السحب العشوائي ---------- */
    const rules = loaded ? loaded.rules.map(function (r) {
      return { taxonomy_id: r.taxonomy_id || '', difficulty: r.difficulty || '', type_code: r.type_code || '', tag_id: r.tag_id || '', count: String(r.draw_count), points_each: r.points_each == null ? '1' : String(r.points_each), avail: null };
    }) : [];
    const rulesBox = h('div');
    const rulesMsg = A.msgBox();
    const taxOpts = taxOptions(tax, 'أي تصنيف');
    function paintRules() {
      A.clear(rulesBox);
      if (!rules.length) { rulesBox.appendChild(h('p', { class: 'ad-muted', text: 'لا قواعد سحب عشوائي.' })); return; }
      rules.forEach(function (r, i) {
        const sTax = A.select(taxOpts, r.taxonomy_id);
        const sDiff = A.select([['', 'أي صعوبة']].concat(QB.DIFF), r.difficulty);
        const sType = A.select([['', 'أي نوع']].concat(types.map(function (t) { return [t.code, t.name_ar]; })), r.type_code);
        const sTag = A.select([['', 'أي وسم']].concat(tags.rows.map(function (t) { return [t.id, t.label]; })), r.tag_id);
        const nCnt = A.input({ type: 'number', min: 1, maxv: 500, step: 1, inputmode: 'numeric', value: r.count });
        const nPts = A.input({ type: 'number', min: 0, step: 'any', inputmode: 'decimal', value: r.points_each });
        sTax.addEventListener('change', function () { r.taxonomy_id = sTax.value; r.avail = null; });
        sDiff.addEventListener('change', function () { r.difficulty = sDiff.value; r.avail = null; });
        sType.addEventListener('change', function () { r.type_code = sType.value; r.avail = null; });
        sTag.addEventListener('change', function () { r.tag_id = sTag.value; r.avail = null; });
        nCnt.addEventListener('input', function () { r.count = nCnt.value; });
        nPts.addEventListener('input', function () { r.points_each = nPts.value; });
        const rm = A.ibtn('trash', 'حذف القاعدة ' + (i + 1), function () { rules.splice(i, 1); paintRules(); }, 'danger');
        const st = r.avail ? A.badge('المتاح ' + r.avail.available + ' من المطلوب ' + r.avail.requested, r.avail.ok ? 'ok' : 'warn') : null;
        rulesBox.appendChild(h('div', { class: 'ad-qb-rule' },
          h('strong', { text: 'القاعدة ' + A.num(i + 1) }),
          h('div', { class: 'ad-tools' }, A.field('التصنيف', sTax), A.field('الصعوبة', sDiff, null, 'sm'), A.field('النوع', sType, null, 'sm'), A.field('الوسم', sTag, null, 'sm')),
          h('div', { class: 'ad-tools' }, A.field('عدد الأسئلة', nCnt, null, 'sm'), A.field('نقاط كل سؤال', nPts, null, 'sm'), rm, st)));
      });
    }
    function rulePayload() {
      const out2 = [];
      for (let i = 0; i < rules.length; i++) {
        const r = rules[i];
        const cnt = optInt(r.count);
        const pts = optNum(r.points_each);
        if (cnt === null || Number.isNaN(cnt) || cnt < 1 || cnt > 500) return { error: 'القاعدة ' + (i + 1) + ': عدد الأسئلة يجب أن يكون عددًا صحيحًا من ١ إلى ٥٠٠.' };
        if (pts !== null && (Number.isNaN(pts) || pts <= 0 || pts > 1000)) return { error: 'القاعدة ' + (i + 1) + ': نقاط كل سؤال يجب أن تكون أكبر من صفر وحتى ١٠٠٠.' };
        out2.push({ taxonomy_id: r.taxonomy_id || null, difficulty: r.difficulty || null, type_code: r.type_code || null, tag_id: r.tag_id || null, count: cnt, points_each: pts === null ? 1 : pts });
      }
      return { rules: out2 };
    }
    const prevBtn = A.btn('فحص توفر الأسئلة', { small: true, icon: 'refresh' });
    prevBtn.addEventListener('click', EX.run(prevBtn, rulesMsg, 'act', async function () {
      ui.clearMsg(rulesMsg);
      const rp = rulePayload();
      if (rp.error) { ui.msg(rulesMsg, 'err', rp.error); return; }
      if (!rp.rules.length) { ui.msg(rulesMsg, 'err', 'أضف قاعدة أولًا.'); return; }
      const req = { course_id: course, rules: rp.rules, exclude_question_ids: items.map(function (i) { return i.question_id; }) };
      if (f.scope.value) req.scope_taxonomy_id = f.scope.value;
      const r = await P.rest.rpc('exam_preview_pool', { p: req });
      (r.rules || []).forEach(function (x) { if (rules[x.position - 1]) rules[x.position - 1].avail = x; });
      paintRules();
      const bad = (r.rules || []).filter(function (x) { return !x.ok; }).length;
      ui.msg(rulesMsg, bad ? 'err' : 'ok', bad ? 'بعض القواعد لا يكفيها بنك الدورة (' + bad + ').' : 'كل القواعد متاحة. الأسئلة المؤهلة في النطاق: ' + A.num(r.eligible) + '.');
    }));
    const addRule = A.btn('إضافة قاعدة', { kind: 'p', small: true, icon: 'plus', on: function () {
      if (rules.length >= MAX_RULES) { ui.msg(rulesMsg, 'err', 'الحد الأقصى ' + MAX_RULES + ' قاعدة.'); return; }
      rules.push({ taxonomy_id: '', difficulty: '', type_code: '', tag_id: '', count: '5', points_each: '1', avail: null });
      paintRules();
    } });
    const random = A.card('السحب العشوائي', [
      h('p', { class: 'ad-muted', text: 'كل قاعدة تسحب عددًا من أسئلة البنك المفعّلة المطابقة لشروطها. السؤال المطابق لأكثر من قاعدة يُحسب لأولها، ولا يتكرر مع الأسئلة الثابتة. تُجمَّد المجموعة المؤهلة عند النشر.' }),
      h('div', { class: 'ad-qb-bar' }, addRule, prevBtn), rulesMsg, rulesBox
    ]);

    /* ---------- الحفظ ---------- */
    const clear = function () { ui.clearMsg(out); };
    function collect() {
      const fail = function (msg, el) { return { error: msg, el: el }; };
      const title = f.title_ar.value.trim();
      if (!title) return fail('العنوان بالعربية مطلوب.', f.title_ar);
      const dur = optInt(f.duration.value);
      if (Number.isNaN(dur) || (dur !== null && (dur < 1 || dur > 1440))) return fail('المدة يجب أن تكون عددًا صحيحًا من ١ إلى ١٤٤٠ دقيقة.', f.duration);
      const grace = optInt(f.grace.value);
      if (grace === null || Number.isNaN(grace) || grace < 0 || grace > 600) return fail('مهلة التسليم عدد صحيح من ٠ إلى ٦٠٠ ثانية.', f.grace);
      const att = optInt(f.attempts.value);
      if (Number.isNaN(att) || (att !== null && (att < 1 || att > 100))) return fail('عدد المحاولات عدد صحيح من ١ إلى ١٠٠.', f.attempts);
      const openAt = fromLocal(f.open_at.value);
      const closeAt = fromLocal(f.close_at.value);
      if (openAt === undefined || closeAt === undefined) return fail('تاريخ الفتح أو الإغلاق غير صالح.', f.open_at);
      if (openAt && closeAt && closeAt <= openAt) return fail('وقت الإغلاق يجب أن يكون بعد وقت الفتح.', f.close_at);
      let passPct = null;
      let passScore = null;
      if (f.passMode.value !== 'none') {
        const pv = optNum(f.passVal.value);
        if (pv === null || Number.isNaN(pv) || pv <= 0) return fail('أدخل قيمة حدّ النجاح (رقمًا أكبر من صفر).', f.passVal);
        if (f.passMode.value === 'percent') { if (pv > 100) return fail('نسبة النجاح لا تتجاوز ١٠٠٪.', f.passVal); passPct = pv; } else passScore = pv;
      }
      const kind = f.exam_kind.value;
      if (kind !== 'practice' && (f.feedback.value === 'always' || f.explanation.value === 'always')) return fail('«أثناء المحاولة» لملاحظات الإجابة والشرح متاح للتدريب فقط.', f.feedback);
      const warns = optInt(f.sWarn.value);
      if (warns === null || Number.isNaN(warns) || warns < 0 || warns > 50) return fail('الحد الأقصى للتحذيرات عدد صحيح من ٠ إلى ٥٠.', f.sWarn);
      if ((sFull.input.checked || f.sExceed.value !== 'log') && !sMon.input.checked) return fail('إلزام ملء الشاشة أو إجراء غير «التسجيل فقط» يتطلب تفعيل المراقبة.', sMon.input);
      const sebKeys = String(f.sKeys.value || '').split(/[\s,;]+/).map(function (k) { return k.trim().toLowerCase(); }).filter(Boolean);
      if (sebKeys.some(function (k) { return !/^[0-9a-f]{64}$/.test(k); })) return fail('كل بصمة SEB يجب أن تكون 64 حرفًا سداسيًا (0-9 وa-f).', f.sKeys);
      if (sebKeys.length > 10) return fail('الحد الأقصى عشر بصمات SEB.', f.sKeys);
      if (sSeb.input.checked && !sebKeys.length) return fail('اشتراط SEB يتطلب بصمة واحدة على الأقل.', f.sKeys);
      const rp = rulePayload();
      if (rp.error) return fail(rp.error, null);
      const its = [];
      for (let i = 0; i < items.length; i++) {
        const pts = optNum(items[i].points);
        if (Number.isNaN(pts) || (pts !== null && pts <= 0)) return fail('السؤال ' + (i + 1) + ': النقاط يجب أن تكون أكبر من صفر (أو فارغة لاستعمال نقاط السؤال).', null);
        its.push({ question_id: items[i].question_id, points: pts, weight: items[i].weight == null ? 1 : items[i].weight });
      }
      const nz = function (s) { s = String(s || '').trim(); return s || null; };
      const p = {
        folder_kind: f.folder_kind.value, exam_kind: kind, title_ar: title, title_en: nz(f.title_en.value),
        description_ar: nz(f.description_ar.value), description_en: nz(f.description_en.value), scope_taxonomy_id: f.scope.value || null,
        duration_minutes: dur, open_at: openAt, close_at: closeAt, grace_seconds: grace, max_attempts: att, pass_percent: passPct, pass_score: passScore,
        shuffle_questions: cb.shuffle_questions.input.checked, shuffle_options: cb.shuffle_options.input.checked,
        allow_back: cb.allow_back.input.checked, allow_flag: cb.allow_flag.input.checked,
        review_policy: f.review.value, result_policy: f.result.value, feedback_policy: f.feedback.value, explanation_policy: f.explanation.value,
        allow_whiteboard: cb.allow_whiteboard.input.checked, allow_calculator: cb.allow_calculator.input.checked, allow_translation: cb.allow_translation.input.checked,
        timeout_policy: f.timeout.value, resume_policy: f.resume.value,
        security: { monitoring: sMon.input.checked, max_warnings: warns, on_exceed: f.sExceed.value, fullscreen_required: sFull.input.checked, watermark: sMark.input.checked, require_seb: sSeb.input.checked, seb_keys: sebKeys },
        items: its, rules: rp.rules
      };
      if (ex) p.exam_id = ex.id; else p.course_id = course;
      return { payload: p };
    }
    function saver(btn, goBack) {
      return EX.run(btn, out, 'save', async function () {
        clear();
        const c = collect();
        if (c.error) {
          ui.msg(out, 'err', c.error);
          if (c.el) { try { c.el.focus(); } catch (e) { /* تجاهل */ } }
          return;
        }
        const r = await P.rest.rpc('exam_save', { p: c.payload });
        const text = 'حُفظت المسودة: ' + A.num(r.question_count) + ' سؤالًا، المجموع ' + EX.num(r.total_score) + ' درجة.';
        A.toast('ok', text);
        if (goBack) { window.location.hash = back; return; }
        if (!ex) { window.location.hash = EX.href(course, 'edit', r.exam_id); return; }
        ui.msg(out, 'ok', text);
      });
    }
    const save = A.btn('حفظ', { kind: 'p', icon: 'check' });
    const saveBack = A.btn('حفظ والعودة للقائمة');
    save.addEventListener('click', saver(save, false));
    saveBack.addEventListener('click', saver(saveBack, true));
    const form = h('form', { class: 'pf-form', novalidate: '' }, basics, timing, delivery, security, fixed, random, out,
      h('div', { class: 'ad-act' }, save, saveBack, A.link('إلغاء', back)));
    form.addEventListener('submit', function (e) { e.preventDefault(); });
    root.appendChild(form);
    paintItems();
    paintRules();
    A.focusTitle();
  }

  EX.mods.editor = { render: render };
})();
