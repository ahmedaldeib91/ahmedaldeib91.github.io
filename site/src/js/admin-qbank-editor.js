/* =====================================================================
   admin-qbank-editor.js — محرر السؤال (عرض كامل): #qbank/<course>/new و/edit/<uuid> و/copy/<uuid>
   - الدورة ثابتة (من الرابط) ولا تُغيَّر. الأنواع المتاحة = المفعّلة في qb_question_types والتي يدعمها هذا المحرر:
     mcq_single (اختيار واحد: ٢–١٠ خيارات وإجابة صحيحة واحدة) وmulti_response (٢–١٥ خيارًا، إجابة أو أكثر، حدّ أدنى/أقصى للاختيار، وقاعدة تصحيح)
     وtrue_false (صح/خطأ بنصَّي خيارين اختياريين). النوع يُثبَّت عند التعديل (يتغيّر في الجديد والنسخ فقط).
   - الحفظ: Platform.rest.rpc('qb_save_question', {p: {...}}) — إنشاء سؤال، أو إصدار جديد لسؤال موجود (التعديل لا يغيّر الإصدارات السابقة).
     الحقول الاختيارية تُرسل دائمًا بقيمها الحالية (null لتفريغها) فلا يرثها الخادم من الإصدار السابق خطأً. نص الخادم لا يصل إلى الواجهة، فالتحقق
     الذي يطابق مدقّقات القاعدة (private.qb_validate_*) يتم قبل الإرسال وبرسائل عربية، وترجمة رموز الأخطاء في A.qb.errMsg.
   - المنطق الخالص (حالة النموذج، بناء الطلب، التحقق) في admin-qbank-model.js (A.qb.model) ويجب تحميله قبل هذا الملف؛ هنا العرض والأحداث فقط.
   - المحرر لا يعرض الإجابة الصحيحة في المعاينة: تُبنى المعاينة من الحمولة العامة وحدها.
   - الوسوم تُحفظ بعد نجاح الـRPC بمقارنة المحدّد بالمخزَّن (qb_question_tags). المرفقات (payload.media) تُحفظ كما هي ولا تُعدَّل (لا دلو exam-media قبل M7).
   - حماية التغييرات غير المحفوظة: beforeunload + نافذة تأكيد عند النقر على أي رابط داخلي + اعتراض الرجوع/التقدّم وتعديل الرابط (A.leaveGuard الذي يستدعيه موجّه admin.js).
   - النص نص عادي (الأسطر فقط) ويدخل الصفحة عبر ui.h وtextContent وقيَم الحقول؛ لا innerHTML. لا يُكتب محتوى سؤال في console أو التخزين المحلي.
   ===================================================================== */
(function () {
  'use strict';

  const A = window.Admin;
  if (!A || !A.qb) return;
  const QB = A.qb;
  const P = A.P;
  const h = A.h;
  const ui = A.ui;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const M = QB.model;
  if (!M) return; /* admin-qbank-model.js غير محمَّل: لا يُسجَّل المحرر (يظهر خطأ «تعذّر تحميل جزء» عند فتحه) */
  const SUPPORTED = M.SUPPORTED;
  const RANGE = M.RANGE;
  const MAX = M.MAX;
  const SCORING = M.SCORING;
  const mkOpt = M.mkOpt;
  const newOptId = M.newOptId;
  const blank = M.blank;
  const fromRows = M.fromRows;
  const snap = M.snap;
  const whole = M.whole;
  const buildRequest = M.buildRequest;
  const validate = M.validate;

  /* ================================================================== العرض */
  async function render(root, o) {
    const course = o.course;
    const token = o.token;
    const mode = o.mode;
    const row = A.courseById(course);
    const backHref = QB.href(course, 'questions');
    const titles = { new: 'سؤال جديد', edit: 'تعديل السؤال', copy: 'نسخ سؤال' };
    root.appendChild(h('div', { class: 'ad-crumb' }, A.link('العودة إلى أسئلة الدورة', backHref, { icon: 'back', small: true })));
    const headBox = h('div');
    root.appendChild(headBox);
    const body = h('div');
    root.appendChild(body);
    headBox.appendChild(A.head(titles[mode], row.title_ar, []));
    body.appendChild(A.loading('جارٍ تحميل المحرر…'));

    if (mode !== 'new' && !UUID.test(o.id || '')) { A.clear(body); body.appendChild(A.empty('السؤال غير موجود', 'الرابط غير صحيح. ارجع إلى قائمة الأسئلة.', A.link('قائمة الأسئلة', backHref, { kind: 'p', icon: 'back' }))); return; }

    const r0 = await Promise.all([QB.getTypes(), QB.getTax(course, true), QB.getTags(course, true)]);
    if (A.stale(token)) return;
    const types = r0[0];
    const tax = r0[1];
    let tags = r0[2];
    let q = null;
    let ver = null;
    let keyRow = null;
    let origTags = [];
    let versions = [];
    if (mode !== 'new') {
      const qs = await P.rest.select('qb_questions', { select: 'id,course_id,set_id,status,current_version_id,created_at,updated_at', id: 'eq.' + o.id, course_id: 'eq.' + course });
      if (A.stale(token)) return;
      q = qs[0] || null;
      if (!q || !q.current_version_id) {
        A.clear(body);
        body.appendChild(A.empty('السؤال غير موجود في هذه الدورة', 'لم نجد هذا السؤال ضمن الدورة المختارة. ربما حُذف أو يتبع دورة أخرى.', A.link('قائمة الأسئلة', backHref, { kind: 'p', icon: 'back' })));
        return;
      }
      const r1 = await Promise.all([
        P.rest.select('qb_question_versions', { select: '*', id: 'eq.' + q.current_version_id, course_id: 'eq.' + course }),
        P.rest.select('qb_question_keys', { select: '*', version_id: 'eq.' + q.current_version_id, course_id: 'eq.' + course }),
        P.rest.select('qb_question_tags', { select: 'tag_id', question_id: 'eq.' + q.id, course_id: 'eq.' + course }),
        mode === 'edit'
          ? P.rest.select('qb_question_versions', { select: 'id,version_no,created_at,created_by,difficulty,points,weight', question_id: 'eq.' + q.id, course_id: 'eq.' + course, order: 'version_no.desc', limit: '50' })
          : Promise.resolve([])
      ]);
      if (A.stale(token)) return;
      ver = r1[0][0] || null;
      keyRow = r1[1][0] || null;
      origTags = r1[2].map(function (x) { return x.tag_id; });
      versions = r1[3];
      if (!ver || !keyRow) {
        A.clear(body);
        body.appendChild(A.fail('تعذّر قراءة إصدار السؤال أو مفتاحه. تحقق من صلاحياتك (قراءة بنك الأسئلة) ثم أعد المحاولة.', function () { A.route(); }));
        return;
      }
      await A.resolveNames(versions.map(function (v) { return v.created_by; }));
      if (A.stale(token)) return;
    }
    const avail = types.filter(function (t) { return SUPPORTED.indexOf(t.code) !== -1; });
    if (ver && SUPPORTED.indexOf(ver.type_code) === -1) {
      A.clear(body);
      body.appendChild(A.empty('نوع السؤال غير مدعوم في المحرر', 'هذا السؤال من النوع «' + QB.typeLabel(ver.type_code, true) + '» وسيُدعم في مرحلة لاحقة. يمكنك معاينته من القائمة.', A.link('قائمة الأسئلة', backHref, { kind: 'p', icon: 'back' })));
      return;
    }
    if (!avail.length) {
      A.clear(body);
      body.appendChild(A.empty('لا توجد أنواع أسئلة مفعّلة', 'لا يوجد في سجل الأنواع (qb_question_types) نوع مفعّل يدعمه المحرر.', A.link('قائمة الأسئلة', backHref, { kind: 'p', icon: 'back' })));
      return;
    }

    const s = ver ? fromRows(q, ver, keyRow, origTags, tax, mode === 'copy') : blank();
    if (!ver) s.type = avail[0].code;
    let saved = snap(s);
    let attempted = false;
    let saving = false;
    let qid = mode === 'edit' ? q.id : null;
    const here = window.location.hash;
    const F = {}; /* مفتاح الحقل ← عنصر الإدخال (لعرض أخطاء التحقق تحته) */
    const G = {}; /* مفتاح مجموعة ← عنصر رسالة الخطأ */
    const isDirty = function () { return snap(s) !== saved; };
    const alive = function () { return form.isConnected && !A.stale(token); };

    /* ---------- رأس الصفحة ---------- */
    function paintHead() {
      const had = !!(document.activeElement && document.activeElement.id === 'ad-title');
      A.clear(headBox);
      const acts = [];
      if (mode === 'edit') {
        acts.push(A.badge(QB.labelOf(QB.STATUS, q.status), QB.STATUS_KIND[q.status] || 'mut'));
        acts.push(A.badge('الإصدار الحالي: ' + ver.version_no, 'info'));
        acts.push(A.link('نسخ كسؤال جديد', QB.href(course, 'copy', q.id), { small: true, icon: 'plus' }));
      }
      const sub = mode === 'copy' ? row.title_ar + ' — نسخ من سؤال موجود'
        : mode === 'edit' ? row.title_ar + ' — يُنشئ كل حفظ إصدارًا جديدًا ولا يغيّر الإصدارات السابقة'
          : row.title_ar;
      headBox.appendChild(A.head(titles[mode], sub, acts));
      document.title = titles[mode] + ' | لوحة المدرب';
      if (had) A.focusTitle();
    }
    paintHead();

    /* ---------- أدوات الحقول ---------- */
    function gerr(key) {
      const p = h('p', { class: 'pf-ferr', role: 'alert', hidden: true, tabindex: '-1' });
      G[key] = p;
      return p;
    }
    function showErrors(errs) {
      Object.keys(F).forEach(function (k) { if (F[k] && F[k].isConnected) ui.fieldError(F[k], ''); });
      Object.keys(G).forEach(function (k) { G[k].hidden = true; G[k].textContent = ''; });
      let first = null;
      const per = {}; /* قد تفشل عدة قواعد في حقل واحد: تُجمع رسائلها تحته بدل أن تطمس الأخيرة ما قبلها */
      errs.forEach(function (e) {
        if (F[e.f] && F[e.f].isConnected) { per[e.f] = per[e.f] ? per[e.f] + ' ' + e.m : e.m; if (!first) first = F[e.f]; return; }
        const g = G[e.f] || G.size; /* خطأ بلا حقل خاص يظهر عند أزرار الحفظ */
        g.textContent = g.textContent ? g.textContent + ' ' + e.m : e.m;
        g.hidden = false;
        if (!first) first = g;
      });
      Object.keys(per).forEach(function (f) { ui.fieldError(F[f], per[f]); });
      return first;
    }
    function changed() {
      paintPreview();
      if (attempted) showErrors(validate(s, course, qid));
    }
    const bind = function (el, key, f) {
      el.addEventListener('input', function () { s[key] = el.value; if (f) f(); changed(); });
      return el;
    };
    function lblInput(label, key, o2) {
      const el = A.input(Object.assign({ value: s[key] }, o2 || {}));
      if (!(o2 && o2.ltr)) el.setAttribute('dir', 'auto');
      F[key] = el;
      bind(el, key);
      return A.field(label, el, o2 && o2.hint);
    }
    function lblArea(label, key, max, rows, hint) {
      const el = A.textarea({ max: max, rows: rows || 3, value: s[key] });
      el.setAttribute('dir', 'auto');
      F[key] = el;
      bind(el, key);
      return A.field(label, el, hint);
    }

    /* ---------- نوع السؤال والنص واللغة ---------- */
    const typeSel = A.select(avail.map(function (t) { return [t.code, t.name_ar]; }), s.type);
    typeSel.addEventListener('change', function () { setType(typeSel.value); });
    const stem = A.textarea({ max: MAX.stem, rows: 5, value: s.stem, placeholder: 'اكتب نص السؤال…' });
    stem.setAttribute('dir', 'auto');
    F.stem = stem;
    const stemCount = h('p', { class: 'ad-counter' });
    const updCount = function () { stemCount.textContent = QB.len(stem.value) + ' / ' + MAX.stem; };
    stem.addEventListener('input', function () { s.stem = stem.value; updCount(); changed(); });
    updCount();
    const langSel = A.select(QB.LANGS, s.lang);
    F.lang = langSel;
    langSel.addEventListener('change', function () { s.lang = langSel.value; changed(); });

    function setType(t) {
      if (t === s.type) return;
      s.type = t;
      if (t === 'mcq_single') s.correct = s.correct.slice(0, 1);
      while ((t === 'mcq_single' || t === 'multi_response') && s.options.length < 2) s.options.push(mkOpt(newOptId(s.options)));
      paintTypeBox();
      changed();
    }

    /* ---------- الخيارات (اختيار واحد/متعدد) ---------- */
    const typeBox = h('div');
    function focusOpt(id, act) {
      const el = typeBox.querySelector('[data-oid="' + id + '"] [data-act="' + act + '"]');
      if (el && !el.disabled) el.focus(); else { const any = typeBox.querySelector('[data-oid="' + id + '"] input[type="text"]'); if (any) any.focus(); }
    }
    function optRow(o, i, multi, gid) {
      const rg = RANGE[s.type];
      const ctl = h('input', { type: multi ? 'checkbox' : 'radio', name: multi ? gid + '-' + o.id : gid, value: o.id, 'aria-label': 'الخيار ' + (i + 1) + (multi ? ': إجابة صحيحة' : ': هو الإجابة الصحيحة') });
      ctl.checked = s.correct.indexOf(o.id) !== -1;
      ctl.addEventListener('change', function () {
        if (multi) {
          s.correct = s.correct.filter(function (x) { return x !== o.id; });
          if (ctl.checked) s.correct.push(o.id);
        } else s.correct = [o.id];
        row.classList.toggle('ok', ctl.checked);
        if (!multi) Array.prototype.forEach.call(typeBox.querySelectorAll('.ad-qb-opt'), function (r) { r.classList.toggle('ok', r.getAttribute('data-oid') === o.id); });
        changed();
      });
      const txt = A.input({ max: MAX.opt, value: o.text, aria: 'نص الخيار ' + (i + 1), placeholder: 'نص الخيار ' + (i + 1) });
      txt.setAttribute('dir', 'auto');
      F['opt-' + i] = txt;
      const err = h('p', { class: 'pf-ferr', id: txt.id + '-err', hidden: true });
      txt.setAttribute('aria-describedby', err.id);
      txt.addEventListener('input', function () { o.text = txt.value; changed(); });
      const ex = A.textarea({ max: MAX.optx, rows: 2, value: o.expl, placeholder: 'شرح هذا الخيار (اختياري): لماذا هو صحيح أو خاطئ؟', aria: 'شرح الخيار ' + (i + 1) });
      ex.setAttribute('dir', 'auto');
      F['optx-' + i] = ex;
      const errx = h('p', { class: 'pf-ferr', id: ex.id + '-err', hidden: true });
      ex.setAttribute('aria-describedby', errx.id);
      ex.addEventListener('input', function () { o.expl = ex.value; changed(); });
      const move = function (delta) {
        return function () {
          const j = i + delta;
          if (j < 0 || j >= s.options.length) return;
          const t = s.options.splice(i, 1)[0];
          s.options.splice(j, 0, t);
          paintTypeBox();
          changed();
          focusOpt(o.id, delta < 0 ? 'up' : 'down');
        };
      };
      const up = A.ibtn('up', 'تحريك الخيار ' + (i + 1) + ' للأعلى', move(-1));
      const down = A.ibtn('down', 'تحريك الخيار ' + (i + 1) + ' للأسفل', move(1));
      up.setAttribute('data-act', 'up');
      down.setAttribute('data-act', 'down');
      up.disabled = i === 0;
      down.disabled = i === s.options.length - 1;
      const rm = A.ibtn('trash', 'حذف الخيار ' + (i + 1), function () {
        s.options.splice(i, 1);
        s.correct = s.correct.filter(function (x) { return x !== o.id; });
        paintTypeBox();
        changed();
        const nxt = s.options[Math.min(i, s.options.length - 1)];
        if (nxt) focusOpt(nxt.id, 'up');
      }, 'danger');
      rm.setAttribute('data-act', 'rm');
      rm.disabled = s.options.length <= rg[0];
      const row = h('div', { class: 'ad-qb-opt' + (ctl.checked ? ' ok' : ''), 'data-oid': o.id },
        h('div', { class: 'ad-qb-ocheck' }, ctl),
        h('div', { class: 'ad-qb-obody' }, txt, err, ex, errx),
        h('div', { class: 'ad-qb-obtns' }, up, down, rm));
      return row;
    }
    function multiSettings() {
      const mn = A.input({ max: 3, value: s.min, inputmode: 'numeric', ltr: true, placeholder: 'اختياري' });
      const mx = A.input({ max: 3, value: s.max, inputmode: 'numeric', ltr: true, placeholder: 'اختياري' });
      F.min = mn;
      F.max = mx;
      bind(mn, 'min');
      bind(mx, 'max');
      const sc = A.select(SCORING, s.scoring);
      F.scoring = sc;
      sc.addEventListener('change', function () { s.scoring = sc.value; changed(); });
      return h('div', { class: 'ad-qb-multi' },
        h('div', { class: 'ad-cols' },
          A.field('أقل عدد يختاره المتدرب', mn, 'اتركه فارغًا لتكون القيمة ١.'),
          A.field('أكبر عدد يختاره المتدرب', mx, 'اتركه فارغًا لتكون القيمة عدد الخيارات.')),
        A.field('قاعدة التصحيح', sc, 'تُطبَّق عند تصحيح المحاولات في مرحلة لاحقة؛ تُحفظ الآن مع مفتاح الإجابة.'));
    }
    function optsBlock() {
      const multi = s.type === 'multi_response';
      const rg = RANGE[s.type];
      const gid = A.nid('qbo');
      const box = h('div');
      box.appendChild(h('p', { class: 'ad-optlegend', id: gid + '-l', text: 'الخيارات (من ' + rg[0] + ' إلى ' + rg[1] + ')، ' + (multi ? 'وحدّد مربّع كل إجابة صحيحة' : 'وحدّد الدائرة بجانب الإجابة الصحيحة') }));
      box.appendChild(h('div', { class: 'ad-qb-opts', role: multi ? 'group' : 'radiogroup', 'aria-labelledby': gid + '-l' }, s.options.map(function (o, i) { return optRow(o, i, multi, gid); })));
      box.appendChild(gerr('options'));
      box.appendChild(gerr('correct'));
      const add = A.btn('إضافة خيار', { small: true, icon: 'plus', disabled: s.options.length >= rg[1] });
      add.addEventListener('click', function () {
        const o = mkOpt(newOptId(s.options));
        s.options.push(o);
        paintTypeBox();
        changed();
        const inp = typeBox.querySelector('[data-oid="' + o.id + '"] input[type="text"]');
        if (inp) inp.focus();
      });
      box.appendChild(h('div', { class: 'ad-act' }, add));
      if (multi) box.appendChild(multiSettings());
      return box;
    }

    /* ---------- صح / خطأ ---------- */
    function tfBlock() {
      const gid = A.nid('qbtf');
      const box = h('div');
      box.appendChild(h('p', { class: 'ad-optlegend', id: gid + '-l', text: 'الإجابة الصحيحة' }));
      const grp = h('div', { class: 'ad-radios', role: 'radiogroup', 'aria-labelledby': gid + '-l' });
      [['true', 'صح'], ['false', 'خطأ']].forEach(function (p) {
        const r = h('input', { type: 'radio', name: gid, value: p[0] });
        r.checked = s.tf === p[0];
        r.addEventListener('change', function () { if (r.checked) { s.tf = p[0]; changed(); } });
        grp.appendChild(h('label', null, r, h('span', { text: p[1] })));
      });
      box.appendChild(grp);
      box.appendChild(gerr('tf'));
      box.appendChild(h('div', { class: 'ad-cols' },
        lblInput('نص خيار «صح» (اختياري)', 'tfTrue', { max: MAX.label, hint: 'اتركه فارغًا ليظهر «صح».' }),
        lblInput('نص خيار «خطأ» (اختياري)', 'tfFalse', { max: MAX.label, hint: 'اتركه فارغًا ليظهر «خطأ».' })));
      box.appendChild(h('div', { class: 'ad-cols' },
        lblArea('شرح اختيار «صح» (اختياري)', 'tfExplTrue', MAX.optx, 2),
        lblArea('شرح اختيار «خطأ» (اختياري)', 'tfExplFalse', MAX.optx, 2)));
      return box;
    }

    function paintTypeBox() {
      Object.keys(F).forEach(function (k) { if (/^(opt|optx)-\d+$|^(min|max|scoring|tfTrue|tfFalse|tfExplTrue|tfExplFalse)$/.test(k)) delete F[k]; });
      ['options', 'correct', 'tf'].forEach(function (k) { delete G[k]; });
      A.clear(typeBox);
      typeBox.appendChild(s.type === 'true_false' ? tfBlock() : optsBlock());
      if (typeSel.value !== s.type) typeSel.value = s.type;
    }

    /* ---------- التصنيف ---------- */
    const domSel = A.select([['', '— بلا تصنيف —']], '');
    const topSel = A.select([['', '—']], '');
    const subSel = A.select([['', '—']], '');
    const nodeOpt = function (n) { return [n.id, n.name_ar]; };
    function fillTax() {
      if (s.dom && !tax.byId[s.dom]) { s.dom = ''; s.top = ''; s.sub = ''; }
      QB.setOptions(domSel, [['', '— بلا تصنيف —']].concat(tax.roots.map(nodeOpt)), s.dom);
      const tops = s.dom ? tax.children(s.dom) : [];
      QB.setOptions(topSel, [['', tops.length ? '— بلا موضوع —' : '—']].concat(tops.map(nodeOpt)), s.top);
      const subs = s.top ? tax.children(s.top) : [];
      QB.setOptions(subSel, [['', subs.length ? '— بلا موضوع فرعي —' : '—']].concat(subs.map(nodeOpt)), s.sub);
      topSel.disabled = !tops.length;
      subSel.disabled = !subs.length;
    }
    domSel.addEventListener('change', function () { s.dom = domSel.value; s.top = ''; s.sub = ''; fillTax(); changed(); });
    topSel.addEventListener('change', function () { s.top = topSel.value; s.sub = ''; fillTax(); changed(); });
    subSel.addEventListener('change', function () { s.sub = subSel.value; changed(); });

    /* ---------- الوسوم ---------- */
    const tagBox = h('div', { class: 'ad-qb-tagbox' });
    function paintTags() {
      A.clear(tagBox);
      const chips = h('div', { class: 'ad-qb-chips' });
      s.tagIds.forEach(function (id) {
        const t = tags.byId[id];
        if (!t) return;
        const x = h('button', { type: 'button', class: 'ad-qb-chipx', 'aria-label': 'إزالة الوسم ' + t.label, title: 'إزالة' }, A.icon('x'));
        x.addEventListener('click', function () { s.tagIds = s.tagIds.filter(function (v) { return v !== id; }); paintTags(); changed(); });
        chips.appendChild(h('span', { class: 'ad-qb-chip' }, h('span', { dir: 'auto', text: t.label }), x));
      });
      if (!chips.firstChild) chips.appendChild(h('span', { class: 'ad-muted', text: 'لا وسوم محدّدة.' }));
      const free = tags.rows.filter(function (t) { return s.tagIds.indexOf(t.id) === -1; });
      const pick = A.select([['', free.length ? '— اختر وسمًا موجودًا —' : '— لا وسوم أخرى —']].concat(free.map(function (t) { return [t.id, t.label]; })), '');
      pick.disabled = !free.length;
      const add = A.btn('إضافة', { small: true });
      add.addEventListener('click', function () {
        if (!pick.value) return;
        s.tagIds.push(pick.value);
        paintTags();
        changed();
      });
      const fresh = A.input({ max: MAX.tag, placeholder: 'وسم جديد' });
      fresh.setAttribute('dir', 'auto');
      const tout = A.msgBox();
      const create = A.btn('إنشاء وإضافة', { small: true, icon: 'plus' });
      create.addEventListener('click', QB.run(create, tout, 'tag', async function () {
        ui.clearMsg(tout);
        const lab = fresh.value.trim();
        if (!lab || QB.len(lab) > MAX.tag) { ui.msg(tout, 'err', 'اكتب اسم الوسم (حتى ' + MAX.tag + ' حرفًا).'); return; }
        const same = tags.rows.filter(function (t) { return t.label.trim().toLowerCase() === lab.toLowerCase(); })[0];
        let id = same ? same.id : '';
        if (!id) {
          const rows = await P.rest.insert('qb_tags', { course_id: course, label: lab });
          if (!rows.length) throw A.noRows();
          id = rows[0].id;
          tags = await QB.getTags(course, true);
        }
        if (s.tagIds.indexOf(id) === -1) s.tagIds.push(id);
        paintTags();
        changed();
      }));
      tagBox.appendChild(chips);
      tagBox.appendChild(h('div', { class: 'ad-tools' }, A.field('وسم موجود', pick), add));
      tagBox.appendChild(h('div', { class: 'ad-tools' }, A.field('وسم جديد', fresh, 'يُنشأ فورًا في الدورة ثم يُلصق بالسؤال عند الحفظ.'), create));
      tagBox.appendChild(tout);
    }

    /* ---------- المعاينة (بشكل المتدرب: بلا إجابة صحيحة ولا شرح) ---------- */
    const pvBox = h('div');
    function paintPreview() {
      const p = { stem: { text: s.stem } };
      if (s.type === 'true_false') p.labels = { 'true': s.tfTrue.trim(), 'false': s.tfFalse.trim() };
      else {
        p.options = s.options.map(function (o) { return { id: o.id, text: o.text }; });
        if (s.type === 'multi_response') {
          if (s.min.trim() !== '' && whole(s.min) >= 1) p.min_select = whole(s.min);
          if (s.max.trim() !== '' && whole(s.max) >= 1) p.max_select = whole(s.max);
        }
      }
      if (s.media.length) p.media = s.media;
      A.clear(pvBox);
      pvBox.appendChild(QB.preview(s.type, p));
    }

    /* ---------- بقية الحقول ---------- */
    const diffSel = A.select(QB.DIFF, s.difficulty);
    F.difficulty = diffSel;
    diffSel.addEventListener('change', function () { s.difficulty = diffSel.value; changed(); });
    const statusSel = A.select(QB.STATUS, s.status);
    F.status = statusSel;
    statusSel.addEventListener('change', function () { s.status = statusSel.value; changed(); });
    const pointsIn = A.input({ max: 9, value: s.points, inputmode: 'decimal', ltr: true });
    const weightIn = A.input({ max: 6, value: s.weight, inputmode: 'decimal', ltr: true });
    F.points = pointsIn;
    F.weight = weightIn;
    bind(pointsIn, 'points');
    bind(weightIn, 'weight');

    const out = A.msgBox();
    const sizeErr = gerr('size');
    const btnSave = A.btn('حفظ', { kind: 'p', small: true, icon: 'check' });
    const btnBack = A.btn('حفظ والعودة إلى القائمة', { small: true });
    const lockBtns = function (on) { btnSave.disabled = on; btnBack.disabled = on; };

    const form = h('form', { class: 'pf-form', novalidate: true, method: 'post', action: '/admin/' });
    form.addEventListener('submit', function (e) { e.preventDefault(); });

    const typeField = mode === 'edit'
      ? A.field('نوع السؤال', h('input', { class: 'pf-in', id: A.nid('qt'), type: 'text', readonly: true, value: QB.typeLabel(s.type, true) }), 'يُثبَّت النوع بعد إنشاء السؤال. لتغييره انسخ السؤال كسؤال جديد.')
      : A.field('نوع السؤال', typeSel, 'تظهر الحقول التالية تلقائيًا بحسب النوع.');
    const card1 = A.card('النص والإجابات', [
      h('div', { class: 'ad-cols' }, typeField, A.field('لغة نص السؤال', langSel, 'العربية للنص العربي. نص إنجليزي ثانٍ غير مدعوم بعد.')),
      A.field('نص السؤال', stem, 'نص عادي: الأسطر الجديدة تُحفظ ولا يُفسَّر HTML.'), stemCount,
      typeBox,
      s.media.length ? h('p', { class: 'ad-note', text: 'يرتبط هذا السؤال بـ ' + s.media.length + ' مرفق. تُحفظ المرفقات كما هي مع كل إصدار جديد ولا تُعدَّل من هذا المحرر. رفع المرفقات الجديدة غير مدعوم بعد.' }) : h('p', { class: 'pf-hint', text: 'المرفقات (الصور والملفات) غير مدعومة بعد في هذا المحرر.' })
    ]);
    const card2 = A.card('التصنيف والدرجة والوسوم', [
      h('div', { class: 'ad-cols' }, A.field('الصعوبة', diffSel), A.field('الدرجة', pointsIn, 'الدرجة التي يحصل عليها المتدرب عند الإجابة الصحيحة.'), A.field('الوزن', weightIn, 'يُستعمل في اختيار الأسئلة وحساب النتائج لاحقًا (من ٠ إلى ١٠٠).')),
      h('div', { class: 'ad-cols' }, A.field('المجال', domSel), A.field('الموضوع', topSel), A.field('الموضوع الفرعي', subSel)),
      tax.rows.length ? null : h('p', { class: 'pf-hint' }, 'لا يوجد تصنيف لهذه الدورة بعد. ', h('a', { class: 'pf-link', href: QB.href(course, 'taxonomy'), text: 'أضف مجالات من تبويب التصنيف' }), '.'),
      h('b', { text: 'الوسوم (الكلمات المفتاحية)' }), tagBox
    ]);
    const card3 = A.card('الشرح والتغذية الراجعة (للمدرّب ولما بعد التصحيح)', [
      lblArea('تغذية راجعة عند الإجابة الصحيحة', 'fbOk', MAX.fb, 2),
      lblArea('تغذية راجعة عند الإجابة الخاطئة', 'fbBad', MAX.fb, 2),
      lblArea('الشرح العام', 'expl', MAX.expl, 4, 'لا تُرسل هذه الحقول إلى المتدرب قبل التسليم؛ تُخزَّن مع المفتاح في جدول خاص بالطاقم.'),
      lblInput('المرجع', 'ref', { max: MAX.ref, hint: 'مثل: PMBOK 7 — القسم ٢.٣ (اختياري).' })
    ]);
    const card4 = A.card('الحالة والحفظ', [
      A.field('الحالة', statusSel, 'مسودة: غير جاهز. مفعّل: يصلح للاستعمال في الاختبارات. معطّل: محفوظ لكن لا يُستعمل.'),
      sizeErr,
      h('div', { class: 'ad-act' }, btnSave, btnBack, A.link('إلغاء', backHref, { small: true }), out)
    ]);
    form.appendChild(card1);
    form.appendChild(card2);
    form.appendChild(card3);
    form.appendChild(card4);

    const vCard = mode === 'edit' ? A.card('الإصدارات', [
      h('p', { class: 'ad-sub', text: 'كل حفظ ينشئ إصدارًا جديدًا غير قابل للتعديل. تبقى الإصدارات السابقة محفوظة كما كانت.' }),
      A.dataTable([
        { key: 'v', label: 'الإصدار', cls: 'ad-first', cell: function (v) { return h('div', null, h('b', { class: 'ad-ltr', text: 'v' + v.version_no }), v.id === ver.id ? A.badge('الحالي', 'ok') : null); } },
        { key: 'd', label: 'التاريخ', cell: function (v) { return h('span', { class: 'ad-nowrap', text: A.fmtDate(v.created_at) }); } },
        { key: 'w', label: 'بواسطة', cell: function (v) { return A.who(v.created_by); } },
        { key: 'g', label: 'الصعوبة', cls: 'hide-md', cell: function (v) { return QB.labelOf(QB.DIFF, v.difficulty); } },
        { key: 'p', label: 'الدرجة', cls: 'hide-md', cell: function (v) { return h('span', { class: 'ad-ltr', text: String(Number(v.points)) }); } }
      ], versions, { caption: 'إصدارات السؤال' })
    ]) : null;

    const banner = h('div');
    if (QB.flash) {
      const f = QB.flash;
      QB.flash = null;
      banner.appendChild(h('p', { class: 'pf-msg ' + f.kind, role: 'status', text: f.text }));
      if (f.dup) {
        banner.appendChild(h('div', { class: 'ad-note warn' },
          h('b', { text: 'تنبيه تكرار: ' }),
          'يوجد ' + A.num(f.dup.n) + ' سؤال آخر في هذه الدورة بمحتوى مطابق لهذا السؤال (بعد توحيد التشكيل والهمزات وترتيب الخيارات). راجعه قبل اعتماد الاثنين. ',
          A.link('عرض الأسئلة المتطابقة', QB.href(course, 'questions', 'h:' + f.dup.hash), { small: true })));
      }
      A.announce(f.text);
    }
    if (mode === 'copy') banner.appendChild(h('p', { class: 'ad-note', text: 'هذه نسخة من سؤال موجود: تُحفظ كسؤال جديد مستقل (إصدار ١) بحالة مسودة. عدّل النص قبل الحفظ كي لا يُعدّ مكررًا.' }));

    A.clear(body);
    body.appendChild(banner);
    body.appendChild(h('div', { class: 'ad-editor' },
      h('div', { class: 'ad-qb-formcol' }, form, vCard),
      h('div', { class: 'ad-preview' }, A.card('معاينة كما يراها المتدرب', [
        h('p', { class: 'ad-sub', text: 'تتحدّث أثناء الكتابة. لا تُعرض الإجابة الصحيحة ولا الشرح.' }), pvBox
      ]))));
    paintTypeBox();
    fillTax();
    paintTags();
    paintPreview();

    /* ---------- الحفظ ---------- */
    async function save(back) {
      ui.clearMsg(out);
      attempted = true;
      const errs = validate(s, course, qid);
      const first = showErrors(errs);
      if (errs.length) {
        ui.msg(out, 'err', 'يوجد ' + errs.length + (errs.length > 10 ? ' خطأً' : errs.length === 1 ? ' خطأ' : ' أخطاء') + ' في النموذج. صحّحها ثم أعد الحفظ.');
        if (first) { try { first.scrollIntoView({ block: 'center' }); first.focus(); } catch (e) { /* تجاهل */ } }
        return;
      }
      const res = await P.rest.rpc('qb_save_question', { p: buildRequest(s, course, qid) });
      if (!res || typeof res !== 'object' || !UUID.test(String(res.question_id)) || !Number(res.version_no)) throw new P.ApiError('server', P.MSG.server, 0, 'bad_response');
      const id = String(res.question_id);
      let tagFail = false;
      try { await syncTags(id); } catch (err) { if (A.isSession(err)) throw err; tagFail = true; }
      saved = snap(s);
      const dup = Number(res.duplicates) > 0 ? { n: Number(res.duplicates), hash: String(res.content_hash || '') } : null;
      const text = 'تم حفظ السؤال — الإصدار ' + res.version_no + (mode === 'edit' ? ' (إصدار جديد؛ السابق محفوظ كما هو).' : '.') + (tagFail ? ' لكن تعذّر تحديث الوسوم؛ أعد الحفظ.' : '');
      disarm();
      if (back && !tagFail) {
        A.toast(dup ? 'info' : 'ok', text + (dup ? ' تنبيه: يوجد ' + A.num(dup.n) + ' سؤال بمحتوى مطابق في الدورة.' : ''));
        window.location.hash = backHref;
        return;
      }
      QB.flash = { kind: tagFail ? 'info' : 'ok', text: text, dup: dup && /^[0-9a-f]{64}$/.test(dup.hash) ? dup : null };
      QB.replaceHash(QB.href(course, 'edit', id));
      A.route();
    }
    async function syncTags(id) {
      const base = qid ? origTags : [];
      const add = s.tagIds.filter(function (t) { return base.indexOf(t) === -1; });
      const del = base.filter(function (t) { return s.tagIds.indexOf(t) === -1; });
      if (del.length) await P.rest.remove('qb_question_tags', { course_id: 'eq.' + course, question_id: 'eq.' + id, tag_id: 'in.(' + del.join(',') + ')' });
      if (add.length) await P.rest.insert('qb_question_tags', add.map(function (t) { return { course_id: course, question_id: id, tag_id: t }; }));
    }
    const saver = function (back) {
      return QB.run(back ? btnBack : btnSave, out, 'save', async function () {
        if (saving) { setTimeout(function () { if (saving) lockBtns(true); }, 0); return; } /* ضغطة على الزر الآخر أثناء الحفظ: يعيد حارس الزر تفعيله فنعيد تعطيله */
        saving = true;
        lockBtns(true);
        try { await save(back); } finally { saving = false; lockBtns(false); }
      });
    };
    btnSave.addEventListener('click', saver(false));
    btnBack.addEventListener('click', saver(true));

    /* ---------- حماية التغييرات غير المحفوظة ---------- */
    const ASK = { title: 'تغييرات غير محفوظة', message: 'لديك تعديلات لم تُحفظ في هذا السؤال. إن غادرت الآن فستضيع.', ok: 'مغادرة دون حفظ', cancel: 'البقاء في المحرر', danger: true };
    function onUnload(e) {
      if (!alive() || !isDirty()) return undefined;
      e.preventDefault();
      e.returnValue = '';
      return '';
    }
    function onClick(e) {
      if (!alive()) { disarm(); return; }
      if (!isDirty() || e.defaultPrevented || e.button || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      const href = a ? a.getAttribute('href') || '' : '';
      if (href.charAt(0) !== '#' || href === window.location.hash) return;
      e.preventDefault();
      e.stopPropagation();
      A.confirm(ASK).then(function (ok) { if (ok) { disarm(); window.location.hash = href; } });
    }
    /* الرجوع/التقدّم في سجل المتصفح أو تعديل الرابط: يستدعيه موجّه admin.js (A.leaveGuard) قبل كل توجيه ناتج عن تغيّر الـhash؛ true = أُوقف التوجيه.
       لا نعتمد على ترتيب مستمعي hashchange (Chrome يشغّل مستمعي window بترتيب التسجيل ولو كان أحدهم في طور الالتقاط، والموجّه سُجّل أولًا).
       يُسأل المستخدم ويُستعاد رابط المحرر في الشريط؛ عند التأكيد ينتقل إلى الرابط المطلوب. */
    function onHash() {
      if (!alive()) { disarm(); return false; }
      if (!isDirty()) return false;
      const target = window.location.hash;
      QB.replaceHash(here);
      A.confirm(ASK).then(function (ok) { if (ok) { disarm(); window.location.hash = target; } });
      return true;
    }
    function arm() {
      window.addEventListener('beforeunload', onUnload);
      document.addEventListener('click', onClick, true);
      A.leaveGuard = onHash;
    }
    function disarm() {
      window.removeEventListener('beforeunload', onUnload);
      document.removeEventListener('click', onClick, true);
      if (A.leaveGuard === onHash) A.leaveGuard = null;
    }
    arm();
  }

  QB.mods.editor = { render: render };
})();
