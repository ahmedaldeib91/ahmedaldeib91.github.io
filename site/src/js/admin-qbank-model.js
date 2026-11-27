/* =====================================================================
   admin-qbank-model.js — منطق نموذج السؤال في بنك الأسئلة: A.qb.model (بلا DOM ولا شبكة ولا حالة عامة)
   ملف عادي (ES2017) يُحمَّل بـ defer بعد admin-qbank.js وقبل admin-qbank-editor.js وadmin.js.
   - حالة النموذج: blank() وfromRows() (من صفوف القاعدة: إصدار + مفتاحه + وسوم) وsnap() (بصمة لكشف التغييرات غير المحفوظة).
   - الطلب إلى qb_save_question: buildRequest(حالة، دورة، معرّف سؤال اختياري) — الحمولة والمفتاح كما تتوقعهما مدقّقات القاعدة private.qb_validate_*.
     الحقول الاختيارية تُرسل دائمًا (null لتفريغها) كي لا يرثها الخادم من الإصدار السابق خطأً.
   - التحقق: validate(حالة، دورة، معرّف) ← [{f: مفتاح الحقل, m: رسالة عربية}] يطابق مدقّقات القاعدة وقيودها (الأطوال بنقاط الترميز كـ Postgres).
   يعتمد وقت الاستدعاء فقط على A.latinDigits وA.normAr وA.num وA.qb.len وA.qb.bytes.
   ===================================================================== */
(function () {
  'use strict';

  const A = window.Admin;
  if (!A || !A.qb) return;
  const QB = A.qb;

  const SUPPORTED = ['mcq_single', 'multi_response', 'true_false', 'graphic', 'matching', 'short_answer', 'numerical', 'essay', 'ordering', 'fill_blank'];
  const RANGE = { mcq_single: [2, 10], multi_response: [2, 15], graphic: [2, 10] };
  const MATCH_RANGE = { left: [2, 10], right: [2, 12] };
  const SINGLE = ['mcq_single', 'graphic']; /* أنواع الإجابة الواحدة من خيارات نصية */
  const MAX = { stem: 10000, opt: 2000, optx: 4000, fb: 4000, expl: 20000, ref: 2000, label: 200, tag: 80 };
  const LIM = { payload: 65536, key: 16384, req: 196608 };
  const MATCH_SCORING = [
    ['all_or_nothing', 'الكل أو لا شيء: درجة كاملة فقط عند مطابقة كل الأزواج صحيحة'],
    ['partial', 'جزئي: درجة تتناسب مع عدد الأزواج الصحيحة'],
    ['partial_penalty', 'جزئي مع خصم: يُخصم من الدرجة عن كل زوج خاطئ']
  ];
  const SCORING = [
    ['all_or_nothing', 'الكل أو لا شيء: درجة كاملة فقط عند اختيار الإجابات الصحيحة كلها بلا زيادة'],
    ['partial', 'جزئي: درجة تتناسب مع عدد الإجابات الصحيحة المختارة'],
    ['partial_penalty', 'جزئي مع خصم: يُخصم من الدرجة عن كل اختيار خاطئ']
  ];

  /* ---------- حالة النموذج ---------- */
  const mkOpt = function (id, text, expl) { return { id: id, text: text || '', expl: expl || '' }; };
  function newOptId(list) {
    const used = {};
    list.forEach(function (o) { used[o.id] = true; });
    for (let i = 0; i < 26; i++) { const c = String.fromCharCode(97 + i); if (!used[c]) return c; }
    for (let n = 1; n < 100; n++) { if (!used['o' + n]) return 'o' + n; }
    return 'x' + Date.now().toString(36).slice(-8);
  }
  function blank() {
    return Object.assign({
      type: 'mcq_single', stem: '', lang: 'ar', options: [mkOpt('a'), mkOpt('b')], correct: [],
      tf: '', tfTrue: '', tfFalse: '', tfExplTrue: '', tfExplFalse: '', min: '', max: '', scoring: 'all_or_nothing',
      left: [mkOpt('l1'), mkOpt('l2')], right: [mkOpt('r1'), mkOpt('r2')], pairs: {},
      points: '1', weight: '1', difficulty: 'medium', dom: '', top: '', sub: '', tagIds: [],
      fbOk: '', fbBad: '', expl: '', ref: '', status: 'draft', media: []
    }, QB.tb ? QB.tb.blankFields() : {});
  }
  /* من صفوف القاعدة (إصدار + مفتاحه) إلى حالة النموذج */
  function fromRows(q, v, k, tagIds, tax, asCopy) {
    const s = blank();
    const payload = v.payload || {};
    const key = k.key || {};
    const oe = k.option_explanations && typeof k.option_explanations === 'object' ? k.option_explanations : {};
    s.type = v.type_code;
    s.stem = payload.stem && typeof payload.stem.text === 'string' ? payload.stem.text : '';
    s.lang = v.lang;
    if (s.type === 'true_false') {
      const lb = payload.labels || {};
      s.tf = key.correct === 'true' || key.correct === 'false' ? key.correct : '';
      s.tfTrue = typeof lb['true'] === 'string' ? lb['true'] : '';
      s.tfFalse = typeof lb['false'] === 'string' ? lb['false'] : '';
      s.tfExplTrue = typeof oe['true'] === 'string' ? oe['true'] : '';
      s.tfExplFalse = typeof oe['false'] === 'string' ? oe['false'] : '';
    } else if (QB.tb && QB.tb.has(s.type)) {
      QB.tb.fromRows(s, payload, key, oe);
    } else if (s.type === 'matching') {
      s.left = (Array.isArray(payload.left) ? payload.left : []).map(function (o) { return mkOpt(String(o.id), String(o.text), typeof oe[o.id] === 'string' ? oe[o.id] : ''); });
      s.right = (Array.isArray(payload.right) ? payload.right : []).map(function (o) { return mkOpt(String(o.id), String(o.text)); });
      s.pairs = key.pairs && typeof key.pairs === 'object' ? Object.assign({}, key.pairs) : {};
      s.scoring = key.scoring || 'all_or_nothing';
    } else {
      s.options = (Array.isArray(payload.options) ? payload.options : []).map(function (o) { return mkOpt(String(o.id), String(o.text), typeof oe[o.id] === 'string' ? oe[o.id] : ''); });
      s.correct = SINGLE.indexOf(s.type) !== -1 ? (typeof key.correct === 'string' ? [key.correct] : []) : (Array.isArray(key.correct) ? key.correct.map(String) : []);
      if (s.type === 'multi_response') {
        s.min = payload.min_select === undefined || payload.min_select === null ? '' : String(payload.min_select);
        s.max = payload.max_select === undefined || payload.max_select === null ? '' : String(payload.max_select);
        s.scoring = key.scoring || 'all_or_nothing';
      }
    }
    s.points = String(Number(v.points));
    s.weight = String(Number(v.weight));
    s.difficulty = v.difficulty;
    const path = v.taxonomy_id ? tax.path(v.taxonomy_id) : [];
    s.dom = path[0] ? path[0].id : '';
    s.top = path[1] ? path[1].id : '';
    s.sub = path[2] ? path[2].id : '';
    s.tagIds = tagIds.slice();
    s.fbOk = k.feedback_correct || '';
    s.fbBad = k.feedback_incorrect || '';
    s.expl = k.explanation || '';
    s.ref = k.reference || '';
    s.status = asCopy ? 'draft' : q.status;
    s.media = Array.isArray(payload.media) ? payload.media.slice() : [];
    return s;
  }
  function snap(s) {
    return JSON.stringify([s.type, s.stem, s.lang, s.options.map(function (o) { return [o.id, o.text, o.expl]; }), s.correct.slice().sort(), s.tf, s.tfTrue, s.tfFalse,
      s.tfExplTrue, s.tfExplFalse, s.min, s.max, s.scoring, s.left.map(function (o) { return [o.id, o.text, o.expl]; }), s.right.map(function (o) { return [o.id, o.text]; }), s.pairs, s.media, s.points, s.weight, s.difficulty, s.dom, s.top, s.sub, s.tagIds.slice().sort(), s.fbOk, s.fbBad, s.expl, s.ref, s.status, QB.tb ? QB.tb.snap(s) : '']);
  }

  /* ---------- أرقام ---------- */
  const decimal = function (str) { /* خانتان عشريتان كحد أقصى (numeric(8,2)): يقبل الأرقام العربية والفاصلة العشرية العربية */
    const t = A.latinDigits(String(str == null ? '' : str)).replace(/[٫,]/g, '.').trim();
    return /^\d{1,6}(\.\d{1,2})?$/.test(t) ? Number(t) : NaN;
  };
  const whole = function (str) {
    const t = A.latinDigits(String(str == null ? '' : str)).trim();
    return /^\d{1,3}$/.test(t) ? Number(t) : NaN;
  };
  const nz = function (t) { t = String(t == null ? '' : t).trim(); return t ? t : null; };

  /* ---------- الطلب إلى qb_save_question (الحمولة والمفتاح كما تتوقعهما مدقّقات القاعدة) ---------- */
  function buildRequest(s, course, qid) {
    const payload = { stem: { text: s.stem.trim() } };
    const key = {};
    const oe = {};
    if (s.type === 'true_false') {
      const labels = {};
      if (s.tfTrue.trim()) labels['true'] = s.tfTrue.trim();
      if (s.tfFalse.trim()) labels['false'] = s.tfFalse.trim();
      if (Object.keys(labels).length) payload.labels = labels;
      key.correct = s.tf;
      if (s.tfExplTrue.trim()) oe['true'] = s.tfExplTrue.trim();
      if (s.tfExplFalse.trim()) oe['false'] = s.tfExplFalse.trim();
    } else if (QB.tb && QB.tb.has(s.type)) {
      QB.tb.build(s, payload, key, oe);
    } else if (s.type === 'matching') {
      payload.left = s.left.map(function (o) { return { id: o.id, text: o.text.trim() }; });
      payload.right = s.right.map(function (o) { return { id: o.id, text: o.text.trim() }; });
      s.left.forEach(function (o) { if (o.expl.trim()) oe[o.id] = o.expl.trim(); });
      key.pairs = {};
      s.left.forEach(function (o) { key.pairs[o.id] = s.pairs[o.id]; });
      key.scoring = s.scoring;
    } else {
      payload.options = s.options.map(function (o) { return { id: o.id, text: o.text.trim() }; });
      s.options.forEach(function (o) { if (o.expl.trim()) oe[o.id] = o.expl.trim(); });
      if (SINGLE.indexOf(s.type) !== -1) key.correct = s.correct[0];
      else {
        if (s.min.trim() !== '') payload.min_select = whole(s.min);
        if (s.max.trim() !== '') payload.max_select = whole(s.max);
        key.correct = s.options.map(function (o) { return o.id; }).filter(function (id) { return s.correct.indexOf(id) !== -1; });
        key.scoring = s.scoring;
      }
    }
    if (s.media.length) payload.media = s.media.slice();
    const req = {
      course_id: course, type_code: s.type, payload: payload, key: key,
      feedback_correct: nz(s.fbOk), feedback_incorrect: nz(s.fbBad), explanation: nz(s.expl), option_explanations: oe, reference: nz(s.ref),
      taxonomy_id: s.sub || s.top || s.dom || null,
      difficulty: s.difficulty, points: decimal(s.points), weight: decimal(s.weight), lang: s.lang, status: s.status
    };
    if (qid) req.question_id = qid;
    return req;
  }

  /* مطابقة: عناصر اليمين واليسار، وزوج صحيح واحد لكل عنصر أيسر، ولا يتكرر عنصر أيمن (يطابق private.qb_validate_matching) */
  function validateMatching(s, add) {
    const lr = MATCH_RANGE.left;
    const rr = MATCH_RANGE.right;
    if (s.left.length < lr[0] || s.left.length > lr[1]) add('left', 'عدد العناصر المراد مطابقتها يجب أن يكون من ' + lr[0] + ' إلى ' + lr[1] + '.');
    if (s.right.length < rr[0] || s.right.length > rr[1]) add('right', 'عدد خيارات المطابقة يجب أن يكون من ' + rr[0] + ' إلى ' + rr[1] + '.');
    if (s.right.length < s.left.length) add('right', 'خيارات المطابقة يجب ألا تقل عن عدد العناصر المراد مطابقتها.');
    const dup = function (list, prefix, noun) {
      const seen = {};
      list.forEach(function (o, i) {
        const t = o.text.trim();
        if (!t) add(prefix + '-' + i, 'اكتب نص ' + noun + ' ' + (i + 1) + '.');
        else {
          if (QB.len(t) > MAX.opt) add(prefix + '-' + i, 'نص ' + noun + ' ' + (i + 1) + ' طويل (الحد ' + A.num(MAX.opt) + ' حرف).');
          const k = A.normAr(t);
          if (seen[k] !== undefined) add(prefix + '-' + i, noun + ' ' + (i + 1) + ' يطابق ' + noun + ' ' + (seen[k] + 1) + ': يجب أن تكون مختلفة.');
          else seen[k] = i;
        }
      });
    };
    dup(s.left, 'lt', 'العنصر');
    dup(s.right, 'rt', 'الخيار');
    s.left.forEach(function (o, i) { if (QB.len(o.expl.trim()) > MAX.optx) add('ltx-' + i, 'شرح العنصر ' + (i + 1) + ' طويل (الحد ' + A.num(MAX.optx) + ' حرف).'); });
    const used = {};
    const rightIds = {};
    s.right.forEach(function (o) { rightIds[o.id] = true; });
    s.left.forEach(function (o, i) {
      const r = s.pairs[o.id];
      if (!r || !rightIds[r]) add('pair-' + i, 'اختر المطابقة الصحيحة للعنصر ' + (i + 1) + '.');
      else if (used[r]) add('pair-' + i, 'هذا الخيار مستعمل لعنصر آخر: لكل عنصر مطابقة مختلفة.');
      else used[r] = true;
    });
    if (MATCH_SCORING.every(function (x) { return x[0] !== s.scoring; })) add('scoring', 'اختر قاعدة التصحيح.');
  }

  /* ---------- التحقق (يطابق private.qb_validate_* والقيود) → [{f: الحقل, m: الرسالة}] ---------- */
  function validate(s, course, qid) {
    const errs = [];
    const add = function (f, m) { errs.push({ f: f, m: m }); };
    const stem = s.stem.trim();
    if (!stem) add('stem', 'اكتب نص السؤال.');
    else if (QB.len(stem) > MAX.stem) add('stem', 'نص السؤال طويل جدًا (الحد ' + A.num(MAX.stem) + ' حرف).');
    if (SUPPORTED.indexOf(s.type) === -1) add('type', 'نوع السؤال غير مدعوم في هذا المحرر.');

    if (s.type === 'graphic' && !s.media.length) add('media', 'أضف صورة واحدة على الأقل: السؤال المصوّر يحتاج صورة.');
    if (s.type === 'mcq_single' || s.type === 'multi_response' || s.type === 'graphic') {
      const rg = RANGE[s.type];
      const n = s.options.length;
      if (n < rg[0] || n > rg[1]) add('options', 'عدد الخيارات يجب أن يكون من ' + rg[0] + ' إلى ' + rg[1] + '.');
      const seen = {};
      s.options.forEach(function (o, i) {
        const t = o.text.trim();
        if (!t) add('opt-' + i, 'اكتب نص الخيار ' + (i + 1) + '.');
        else {
          if (QB.len(t) > MAX.opt) add('opt-' + i, 'نص الخيار ' + (i + 1) + ' طويل (الحد ' + A.num(MAX.opt) + ' حرف).');
          const k = A.normAr(t);
          if (seen[k] !== undefined) add('opt-' + i, 'الخيار ' + (i + 1) + ' يطابق الخيار ' + (seen[k] + 1) + ': يجب أن تكون الخيارات مختلفة.');
          else seen[k] = i;
        }
        if (QB.len(o.expl.trim()) > MAX.optx) add('optx-' + i, 'شرح الخيار ' + (i + 1) + ' طويل (الحد ' + A.num(MAX.optx) + ' حرف).');
      });
      const c = s.correct.length;
      if (SINGLE.indexOf(s.type) !== -1) {
        if (c !== 1) add('correct', 'حدّد الإجابة الصحيحة (واحدة فقط).');
      } else {
        if (c < 1) add('correct', 'حدّد إجابة صحيحة واحدة على الأقل.');
        const hasMin = s.min.trim() !== '';
        const hasMax = s.max.trim() !== '';
        const mn = hasMin ? whole(s.min) : NaN;
        const mx = hasMax ? whole(s.max) : NaN;
        if (hasMin && !(mn >= 1 && mn <= n)) add('min', 'الحد الأدنى للاختيار عدد صحيح من ١ إلى ' + n + ' (عدد الخيارات).');
        if (hasMax && !(mx >= 1 && mx <= n)) add('max', 'الحد الأقصى للاختيار عدد صحيح من ١ إلى ' + n + ' (عدد الخيارات).');
        if (mn >= 1 && mx >= 1 && mn > mx) add('min', 'الحد الأدنى للاختيار يجب ألا يتجاوز الحد الأقصى.');
        const lo = mn >= 1 ? mn : 1;
        const hi = mx >= 1 ? mx : n;
        if (c >= 1 && (c < lo || c > hi)) add('correct', 'عدد الإجابات الصحيحة (' + c + ') خارج المدى المسموح للاختيار (من ' + lo + ' إلى ' + hi + ').');
        if (SCORING.every(function (x) { return x[0] !== s.scoring; })) add('scoring', 'اختر قاعدة التصحيح.');
      }
    } else if (QB.tb && QB.tb.has(s.type)) {
      QB.tb.validate(s, add);
    } else if (s.type === 'matching') {
      validateMatching(s, add);
    } else if (s.type === 'true_false') {
      if (s.tf !== 'true' && s.tf !== 'false') add('tf', 'حدّد الإجابة الصحيحة: صح أو خطأ.');
      if (QB.len(s.tfTrue.trim()) > MAX.label) add('tfTrue', 'نص خيار «صح» طويل (الحد ' + MAX.label + ' حرف).');
      if (QB.len(s.tfFalse.trim()) > MAX.label) add('tfFalse', 'نص خيار «خطأ» طويل (الحد ' + MAX.label + ' حرف).');
      if (QB.len(s.tfExplTrue.trim()) > MAX.optx) add('tfExplTrue', 'الشرح طويل (الحد ' + A.num(MAX.optx) + ' حرف).');
      if (QB.len(s.tfExplFalse.trim()) > MAX.optx) add('tfExplFalse', 'الشرح طويل (الحد ' + A.num(MAX.optx) + ' حرف).');
    }
    const pts = decimal(s.points);
    if (!(pts > 0 && pts <= 1000)) add('points', 'الدرجة رقم أكبر من الصفر وحتى ١٠٠٠ (خانتان عشريتان كحد أقصى).');
    const wt = decimal(s.weight);
    if (!(wt > 0 && wt <= 100)) add('weight', 'الوزن رقم أكبر من الصفر وحتى ١٠٠ (خانتان عشريتان كحد أقصى).');
    if (['easy', 'medium', 'hard'].indexOf(s.difficulty) === -1) add('difficulty', 'اختر مستوى الصعوبة.');
    if (['ar', 'en', 'mixed'].indexOf(s.lang) === -1) add('lang', 'اختر لغة السؤال.');
    if (['draft', 'active', 'retired'].indexOf(s.status) === -1) add('status', 'اختر حالة السؤال.');
    if (QB.len(s.fbOk.trim()) > MAX.fb) add('fbOk', 'التغذية الراجعة للإجابة الصحيحة طويلة (الحد ' + A.num(MAX.fb) + ' حرف).');
    if (QB.len(s.fbBad.trim()) > MAX.fb) add('fbBad', 'التغذية الراجعة للإجابة الخاطئة طويلة (الحد ' + A.num(MAX.fb) + ' حرف).');
    if (QB.len(s.expl.trim()) > MAX.expl) add('expl', 'الشرح طويل (الحد ' + A.num(MAX.expl) + ' حرف).');
    if (QB.len(s.ref.trim()) > MAX.ref) add('ref', 'المرجع طويل (الحد ' + A.num(MAX.ref) + ' حرف).');
    if (!errs.length) { /* حدود الحجم في القاعدة (الحمولة ٦٤KB، المفتاح ١٦KB، الطلب ١٩٢KB) مع هامش لفرق تمثيل jsonb */
      const req = buildRequest(s, course, qid);
      if (QB.bytes(req.payload) > LIM.payload - 1024 || QB.bytes(req.key) > LIM.key - 256 || QB.bytes(req) > LIM.req - 2048) {
        add('size', 'حجم السؤال كبير جدًا (الحمولة العامة حتى ٦٤ كيلوبايت). اختصر النصوص أو قلّل الخيارات.');
      }
    }
    return errs;
  }

  QB.model = {
    SUPPORTED: SUPPORTED, RANGE: RANGE, MATCH_RANGE: MATCH_RANGE, SINGLE: SINGLE, MAX: MAX, LIM: LIM, SCORING: SCORING, MATCH_SCORING: MATCH_SCORING,
    mkOpt: mkOpt, newOptId: newOptId, blank: blank, fromRows: fromRows, snap: snap,
    decimal: decimal, whole: whole, nz: nz, buildRequest: buildRequest, validate: validate
  };
})();
