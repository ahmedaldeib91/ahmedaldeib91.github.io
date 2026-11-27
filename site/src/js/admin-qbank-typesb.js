/* =====================================================================
   admin-qbank-typesb.js — أنواع الأسئلة الخمسة الجديدة في محرر بنك الأسئلة (الترحيل 017): A.qb.tb
   short_answer (إجابة قصيرة) · numerical (رقمي بهامش قبول) · essay (مقالي يصحّحه المدرب) · ordering (ترتيب) · fill_blank (ملء الفراغات بالكتابة).
   ملف عادي (ES2017) يُحمَّل بـ defer بعد admin-qbank-model.js وقبل admin-qbank-editor.js. يربط النموذج بالمحرر بخطافات صغيرة:
     has(type) · blankFields() · ensure(s, type) · fromRows(s, payload, key, oe) · build(s, payload, key, oe) · validate(s, add) · snap(s)
     block(type, ctx) واجهة الحقول في المحرر · preview(type, payload, stem, figs, note) المعاينة بشكل المتدرب.
   حقول الحالة كلها بالبادئة tb كي ينظّفها المحرر بنمط واحد. الحمولة والمفتاح كما تتوقعهما مدقّقات القاعدة private.qb_validate_*.
   كل نص يدخل الصفحة بـ textContent.
   ===================================================================== */
(function () {
  'use strict';

  const A = window.Admin;
  if (!A || !A.qb || !A.qb.model) return;
  const QB = A.qb;
  const h = A.h;
  const ui = A.ui;
  const M = QB.model;

  const TYPES = ['short_answer', 'numerical', 'essay', 'ordering', 'fill_blank'];
  const has = function (t) { return TYPES.indexOf(t) !== -1; };
  const lines = function (t) { return String(t == null ? '' : t).split('\n').map(function (x) { return x.trim(); }).filter(Boolean); };
  const MARK = /\{\{([^{}]*)\}\}/g;
  const GOOD = /^[a-z0-9_-]{1,16}$/;
  const SC2 = [['all_or_nothing', 'الكل أو لا شيء: درجة كاملة فقط عند الصواب الكامل'], ['partial', 'جزئي: درجة تتناسب مع الصواب']];
  const numStr = function (t) { return A.latinDigits(String(t == null ? '' : t)).replace(/[٫,]/g, '.').replace(/\s+/g, '').trim(); };
  const numOk = function (t) { return /^[+-]?\d{1,12}(\.\d{1,10})?$/.test(t); };
  const whole = function (t) { const s = A.latinDigits(String(t == null ? '' : t)).trim(); return /^\d{1,4}$/.test(s) ? Number(s) : NaN; };

  function markersOf(stem) {
    const out = [];
    const bad = [];
    String(stem || '').replace(MARK, function (m, id) { if (GOOD.test(id)) out.push(id); else bad.push(m); return m; });
    return { ids: out, bad: bad };
  }
  function uniq(ids) { const seen = {}; return ids.filter(function (x) { if (seen[x]) return false; seen[x] = true; return true; }); }

  const blankFields = function () {
    return { tbAnswers: '', tbCase: false, tbMaxc: '', tbValue: '', tbTol: '', tbMode: 'absolute', tbUnit: '', tbMinw: '', tbMaxw: '', tbRubric: '', tbModel: '', tbFill: {} };
  };
  function ensure(s, t) {
    if (t === 'ordering') { while (s.options.length < 2) s.options.push(M.mkOpt(M.newOptId(s.options))); if (s.scoring !== 'partial') s.scoring = 'all_or_nothing'; }
    if (t === 'fill_blank' && s.scoring !== 'partial') s.scoring = 'all_or_nothing';
  }

  function fromRows(s, payload, key, oe) {
    Object.assign(s, blankFields());
    if (s.type === 'short_answer') {
      s.tbAnswers = (Array.isArray(key.answers) ? key.answers : []).join('\n');
      s.tbCase = !!key.case_sensitive;
      s.tbMaxc = payload.max_chars == null ? '' : String(payload.max_chars);
    } else if (s.type === 'numerical') {
      s.tbValue = key.value == null ? '' : String(key.value);
      s.tbTol = key.tolerance == null ? '' : String(key.tolerance);
      s.tbMode = key.tolerance_mode === 'percent' ? 'percent' : 'absolute';
      s.tbUnit = typeof payload.unit === 'string' ? payload.unit : '';
    } else if (s.type === 'essay') {
      s.tbMinw = payload.min_words == null ? '' : String(payload.min_words);
      s.tbMaxw = payload.max_words == null ? '' : String(payload.max_words);
      s.tbRubric = typeof key.rubric === 'string' ? key.rubric : '';
      s.tbModel = typeof key.model_answer === 'string' ? key.model_answer : '';
    } else if (s.type === 'ordering') {
      const items = Array.isArray(payload.items) ? payload.items : [];
      const byId = {};
      items.forEach(function (o) { byId[String(o.id)] = o; });
      const order = Array.isArray(key.order) ? key.order.map(String) : items.map(function (o) { return String(o.id); });
      s.options = order.filter(function (id) { return byId[id]; }).map(function (id) { return M.mkOpt(id, String(byId[id].text), typeof oe[id] === 'string' ? oe[id] : ''); });
      s.scoring = key.scoring === 'partial' ? 'partial' : 'all_or_nothing';
    } else if (s.type === 'fill_blank') {
      const kb = key.blanks && typeof key.blanks === 'object' ? key.blanks : {};
      Object.keys(kb).forEach(function (id) { s.tbFill[id] = (Array.isArray(kb[id]) ? kb[id] : []).join('\n'); });
      s.tbCase = !!key.case_sensitive;
      s.scoring = key.scoring === 'partial' ? 'partial' : 'all_or_nothing';
    }
  }

  /* يملأ payload/key/oe للطلب إلى qb_save_question */
  function build(s, payload, key, oe) {
    if (s.type === 'short_answer') {
      if (s.tbMaxc.trim() !== '') payload.max_chars = whole(s.tbMaxc);
      key.answers = lines(s.tbAnswers);
      key.case_sensitive = !!s.tbCase;
    } else if (s.type === 'numerical') {
      key.value = Number(numStr(s.tbValue));
      if (s.tbTol.trim() !== '') { key.tolerance = Number(numStr(s.tbTol)); key.tolerance_mode = s.tbMode; }
      if (s.tbUnit.trim()) payload.unit = s.tbUnit.trim();
    } else if (s.type === 'essay') {
      if (s.tbMinw.trim() !== '') payload.min_words = whole(s.tbMinw);
      if (s.tbMaxw.trim() !== '') payload.max_words = whole(s.tbMaxw);
      if (s.tbRubric.trim()) key.rubric = s.tbRubric.trim();
      if (s.tbModel.trim()) key.model_answer = s.tbModel.trim();
    } else if (s.type === 'ordering') {
      payload.items = s.options.map(function (o) { return { id: o.id, text: o.text.trim() }; });
      key.order = s.options.map(function (o) { return o.id; });
      key.scoring = s.scoring;
      s.options.forEach(function (o) { if (o.expl.trim()) oe[o.id] = o.expl.trim(); });
    } else if (s.type === 'fill_blank') {
      const ids = uniq(markersOf(s.stem).ids);
      payload.blanks = ids.map(function (id) { return { id: id }; });
      key.blanks = {};
      ids.forEach(function (id) { key.blanks[id] = lines(s.tbFill[id]); });
      key.case_sensitive = !!s.tbCase;
      key.scoring = s.scoring;
    }
  }

  function validate(s, add) {
    const len = QB.len;
    if (s.type === 'short_answer') {
      const a = lines(s.tbAnswers);
      if (!a.length) add('tbAnswers', 'اكتب إجابة مقبولة واحدة على الأقل (واحدة في كل سطر).');
      else if (a.length > 20) add('tbAnswers', 'الحد الأقصى ٢٠ إجابة مقبولة.');
      else if (a.some(function (x) { return len(x) > 200; })) add('tbAnswers', 'كل إجابة مقبولة حتى ٢٠٠ حرف.');
      if (s.tbMaxc.trim() !== '') { const n = whole(s.tbMaxc); if (!(n >= 1 && n <= 500)) add('tbMaxc', 'أقصى عدد أحرف: عدد صحيح من ١ إلى ٥٠٠.'); }
    } else if (s.type === 'numerical') {
      if (!numOk(numStr(s.tbValue))) add('tbValue', 'اكتب القيمة الصحيحة كرقم (مثل ٣٫١٤ أو -٢٥).');
      if (s.tbTol.trim() !== '') {
        const t = numStr(s.tbTol);
        if (!/^\d{1,12}(\.\d{1,10})?$/.test(t)) add('tbTol', 'هامش القبول رقم موجب أو صفر.');
        else if (s.tbMode === 'percent' && Number(t) > 100) add('tbTol', 'النسبة المئوية لا تتجاوز ١٠٠.');
      }
      if (len(s.tbUnit.trim()) > 30) add('tbUnit', 'الوحدة حتى ٣٠ حرفًا.');
    } else if (s.type === 'essay') {
      const mn = s.tbMinw.trim() === '' ? 0 : whole(s.tbMinw);
      const mx = s.tbMaxw.trim() === '' ? 5000 : whole(s.tbMaxw);
      if (s.tbMinw.trim() !== '' && !(mn >= 0 && mn <= 5000)) add('tbMinw', 'أقل عدد كلمات: عدد صحيح من ٠ إلى ٥٠٠٠.');
      if (s.tbMaxw.trim() !== '' && !(mx >= 1 && mx <= 5000)) add('tbMaxw', 'أكبر عدد كلمات: عدد صحيح من ١ إلى ٥٠٠٠.');
      if (mn >= 0 && mx >= 1 && mn > mx) add('tbMinw', 'أقل عدد كلمات يجب ألا يتجاوز الأكبر.');
      if (len(s.tbRubric) > 4000) add('tbRubric', 'معيار التصحيح حتى ٤٠٠٠ حرف.');
      if (len(s.tbModel) > 8000) add('tbModel', 'الإجابة النموذجية حتى ٨٠٠٠ حرف.');
    } else if (s.type === 'ordering') {
      if (s.options.length < 2 || s.options.length > 10) add('options', 'عدد العناصر من ٢ إلى ١٠.');
      const seen = {};
      s.options.forEach(function (o, i) {
        const t = o.text.trim();
        if (!t) add('opt-' + i, 'اكتب نص العنصر ' + (i + 1) + '.');
        else {
          if (len(t) > M.MAX.opt) add('opt-' + i, 'نص العنصر ' + (i + 1) + ' طويل.');
          const k = A.normAr(t);
          if (seen[k] !== undefined) add('opt-' + i, 'العنصر ' + (i + 1) + ' يطابق العنصر ' + (seen[k] + 1) + '.'); else seen[k] = i;
        }
      });
    } else if (s.type === 'fill_blank') {
      const mk = markersOf(s.stem);
      if (mk.bad.length) add('stem', 'علامة فراغ غير صالحة: ' + mk.bad[0] + ' (استعمل {{b1}} بحروف إنجليزية صغيرة وأرقام).');
      else if (!mk.ids.length) add('stem', 'أضف فراغًا واحدًا على الأقل في نص السؤال بصيغة {{b1}} (زر «إدراج فراغ»).');
      else if (uniq(mk.ids).length !== mk.ids.length) add('stem', 'كل علامة فراغ تظهر مرة واحدة فقط.');
      else if (mk.ids.length > 10) add('stem', 'الحد الأقصى ١٠ فراغات.');
      uniq(mk.ids).forEach(function (id) {
        const a = lines(s.tbFill[id]);
        if (!a.length) add('tbFill-' + id, 'اكتب إجابة مقبولة للفراغ ' + id + '.');
        else if (a.length > 10 || a.some(function (x) { return len(x) > 200; })) add('tbFill-' + id, 'حتى ١٠ إجابات، كل منها حتى ٢٠٠ حرف.');
      });
    }
  }
  const snap = function (s) { return JSON.stringify([s.tbAnswers, s.tbCase, s.tbMaxc, s.tbValue, s.tbTol, s.tbMode, s.tbUnit, s.tbMinw, s.tbMaxw, s.tbRubric, s.tbModel, s.tbFill]); };

  /* ================================================================== واجهة المحرر */
  function block(type, c) {
    const s = c.s;
    const box = h('div');
    const check = function (label, key, hint) {
      const cb = A.checkbox(label, !!s[key], hint);
      cb.input.addEventListener('change', function () { s[key] = cb.input.checked; c.changed(); });
      return cb.el;
    };
    const sel = function (key, list) { const x = A.select(list, s[key]); c.F[key] = x; x.addEventListener('change', function () { s[key] = x.value; c.changed(); }); return x; };
    if (type === 'short_answer') {
      box.appendChild(h('p', { class: 'ad-note', text: 'يُقارَن جواب المتدرب بالإجابات المقبولة بعد توحيد الهمزات والتشكيل والتاء المربوطة والأرقام والمسافات، فلا تكتب صيغها المتعددة إلا إن اختلفت فعلًا.' }));
      box.appendChild(c.lblArea('الإجابات المقبولة (واحدة في كل سطر) *', 'tbAnswers', 4000, 4));
      box.appendChild(check('مطابقة حالة الأحرف (للإنجليزية)', 'tbCase', 'إن فُعّلت فـ A تختلف عن a.'));
      box.appendChild(c.lblInput('أقصى عدد أحرف للإجابة (اختياري)', 'tbMaxc', { max: 3, inputmode: 'numeric', ltr: true, hint: 'من ١ إلى ٥٠٠.' }));
    } else if (type === 'numerical') {
      box.appendChild(h('div', { class: 'ad-cols' }, c.lblInput('القيمة الصحيحة *', 'tbValue', { max: 25, inputmode: 'decimal', ltr: true }),
        c.lblInput('هامش القبول (اختياري)', 'tbTol', { max: 25, inputmode: 'decimal', ltr: true, hint: 'مثال: ٠٫٠١ يقبل ±٠٫٠١.' })));
      box.appendChild(h('div', { class: 'ad-cols' }, A.field('نوع الهامش', sel('tbMode', [['absolute', 'مطلق (±)'], ['percent', 'نسبة مئوية من القيمة (%)']])),
        c.lblInput('الوحدة (تظهر للمتدرب، اختياري)', 'tbUnit', { max: 30 })));
    } else if (type === 'essay') {
      box.appendChild(h('p', { class: 'ad-note', text: 'السؤال المقالي يصحّحه المدرب يدويًا من «التصحيح» في مركز الدورة؛ تظهر نتيجة المحاولة للمتدرب بعد اكتمال التصحيح.' }));
      box.appendChild(h('div', { class: 'ad-cols' }, c.lblInput('أقل عدد كلمات (اختياري)', 'tbMinw', { max: 4, inputmode: 'numeric', ltr: true }), c.lblInput('أكبر عدد كلمات (اختياري)', 'tbMaxw', { max: 4, inputmode: 'numeric', ltr: true })));
      box.appendChild(c.lblArea('معيار التصحيح (للمصحّح فقط)', 'tbRubric', 4000, 3));
      box.appendChild(c.lblArea('إجابة نموذجية (للمصحّح، وتظهر للمتدرب في المراجعة إن سُمحت)', 'tbModel', 8000, 3));
    } else if (type === 'ordering') {
      box.appendChild(h('p', { class: 'ad-optlegend', text: 'اكتب العناصر بالترتيب الصحيح من الأول إلى الأخير (٢–١٠). يُعرض للمتدرب مخلوطًا دائمًا.' }));
      const list = h('div', { class: 'ad-qb-opts' });
      s.options.forEach(function (o, i) {
        const txt = A.input({ max: M.MAX.opt, value: o.text, aria: 'العنصر ' + (i + 1) });
        txt.setAttribute('dir', 'auto');
        c.F['opt-' + i] = txt;
        txt.addEventListener('input', function () { o.text = txt.value; c.changed(); });
        const ex = A.input({ max: M.MAX.optx, value: o.expl, placeholder: 'شرح (اختياري)', aria: 'شرح العنصر ' + (i + 1) });
        ex.addEventListener('input', function () { o.expl = ex.value; c.changed(); });
        const move = function (d) { return function () { const j = i + d; if (j < 0 || j >= s.options.length) return; s.options.splice(j, 0, s.options.splice(i, 1)[0]); c.repaint(); c.changed(); }; };
        const rm = A.ibtn('trash', 'حذف العنصر ' + (i + 1), function () { if (s.options.length <= 2) return; s.options.splice(i, 1); c.repaint(); c.changed(); }, 'danger');
        rm.disabled = s.options.length <= 2;
        list.appendChild(h('div', { class: 'ad-qb-opt', 'data-oid': o.id }, h('span', { class: 'qn', text: String(i + 1) }), txt, ex,
          h('div', { class: 'ad-rowact' }, A.ibtn('up', 'تحريك لأعلى', move(-1)), A.ibtn('down', 'تحريك لأسفل', move(1)), rm)));
      });
      box.appendChild(list);
      box.appendChild(c.gerr('options'));
      const add = A.btn('إضافة عنصر', { small: true, icon: 'plus', disabled: s.options.length >= 10 });
      add.addEventListener('click', function () { s.options.push(M.mkOpt(M.newOptId(s.options))); c.repaint(); c.changed(); });
      box.appendChild(h('div', { class: 'ad-act' }, add));
      box.appendChild(A.field('قاعدة التصحيح', sel('scoring', SC2)));
    } else if (type === 'fill_blank') {
      box.appendChild(h('p', { class: 'ad-note', text: 'اكتب نص السؤال واضغط «إدراج فراغ» عند المكان المطلوب (تُضاف علامة مثل {{b1}}). ثم اكتب الإجابات المقبولة لكل فراغ أدناه.' }));
      const ins = A.btn('إدراج فراغ في نص السؤال', { small: true, icon: 'plus' });
      const slot = h('div');
      function paintBlanks() {
        A.clear(slot);
        Object.keys(c.F).forEach(function (k) { if (/^tbFill-/.test(k)) delete c.F[k]; });
        const ids = uniq(markersOf(s.stem).ids);
        if (!ids.length) { slot.appendChild(h('p', { class: 'pf-hint', text: 'لا فراغات بعد في نص السؤال.' })); return; }
        ids.forEach(function (id) {
          const ta = A.textarea({ max: 2000, rows: 2, value: s.tbFill[id] || '' });
          ta.setAttribute('dir', 'auto');
          c.F['tbFill-' + id] = ta;
          ta.addEventListener('input', function () { s.tbFill[id] = ta.value; c.changed(); });
          slot.appendChild(A.field('الإجابات المقبولة للفراغ {{' + id + '}} (واحدة في كل سطر) *', ta));
        });
      }
      ins.addEventListener('click', function () {
        const used = {};
        markersOf(s.stem).ids.forEach(function (x) { used[x] = true; });
        let n = 1;
        while (used['b' + n]) n++;
        const el = c.stemEl;
        const at = typeof el.selectionStart === 'number' ? el.selectionStart : el.value.length;
        el.value = el.value.slice(0, at) + '{{b' + n + '}}' + el.value.slice(at);
        s.stem = el.value;
        el.dispatchEvent(new Event('input'));
        el.focus();
      });
      if (c.stemEl._tbh) c.stemEl.removeEventListener('input', c.stemEl._tbh);
      c.stemEl._tbh = function () { if (s.type === 'fill_blank' && slot.isConnected) paintBlanks(); };
      c.stemEl.addEventListener('input', c.stemEl._tbh);
      box.appendChild(h('div', { class: 'ad-act' }, ins));
      box.appendChild(slot);
      paintBlanks();
      box.appendChild(check('مطابقة حالة الأحرف (للإنجليزية)', 'tbCase'));
      box.appendChild(A.field('قاعدة التصحيح', sel('scoring', SC2)));
    }
    return box;
  }

  /* ================================================================== معاينة بشكل المتدرب */
  function preview(type, payload, stem, figs, note) {
    const nm = A.nid('qbtb');
    const head = h('legend', null, h('span', { class: 'qn', text: '1' }), h('span', { class: 'pf-qtext', dir: 'auto', text: stem || '—' }));
    let body = null;
    if (type === 'short_answer') {
      body = h('input', { class: 'pf-in', type: 'text', maxlength: String(payload.max_chars || 500), 'aria-label': 'إجابتك', placeholder: 'اكتب إجابتك' });
    } else if (type === 'numerical') {
      body = h('div', { class: 'pf-numrow' }, h('input', { class: 'pf-in ltr', type: 'text', inputmode: 'decimal', 'aria-label': 'إجابتك الرقمية', placeholder: '0' }), payload.unit ? h('span', { class: 'pf-unit', text: String(payload.unit) }) : null);
    } else if (type === 'essay') {
      const lim = [payload.min_words ? 'الحد الأدنى ' + payload.min_words + ' كلمة' : '', payload.max_words ? 'الحد الأقصى ' + payload.max_words + ' كلمة' : ''].filter(Boolean).join(' · ');
      body = h('div', null, h('textarea', { class: 'pf-in', rows: '7', 'aria-label': 'إجابتك', placeholder: 'اكتب إجابتك هنا' }), lim ? h('p', { class: 'pf-hint', text: lim }) : null);
    } else if (type === 'ordering') {
      const items = Array.isArray(payload.items) ? payload.items : [];
      body = h('div', null, h('p', { class: 'pf-hint', text: 'رتّب العناصر بالترتيب الصحيح.' }),
        h('ol', { class: 'pf-ord' }, items.map(function (o, i) { return h('li', { class: 'pf-orditem' }, h('span', { class: 'qn', text: String(i + 1) }), h('span', { dir: 'auto', text: String(o.text || '—') })); })));
    } else {
      const parts = String(stem || '').split(MARK);
      const row = h('p', { class: 'pf-fillrow', dir: 'auto' });
      parts.forEach(function (t, i) {
        if (i % 2 === 0) row.appendChild(document.createTextNode(t));
        else row.appendChild(h('input', { class: 'pf-in pf-blank', type: 'text', 'aria-label': 'الفراغ ' + ((i + 1) / 2), size: '10' }));
      });
      return h('div', { class: 'ad-qb-pv' }, h('ol', { class: 'pf-qlist' }, h('li', { class: 'pf-q' }, h('fieldset', null, h('legend', null, h('span', { class: 'qn', text: '1' }), h('span', { class: 'pf-qtext', text: 'املأ الفراغات' })), figs, row))), note);
    }
    return h('div', { class: 'ad-qb-pv' }, h('ol', { class: 'pf-qlist' }, h('li', { class: 'pf-q' }, h('fieldset', null, head, figs, body))), note);
  }

  QB.tb = { TYPES: TYPES, has: has, blankFields: blankFields, ensure: ensure, fromRows: fromRows, build: build, validate: validate, snap: snap, block: block, preview: preview, markers: markersOf };
})();
