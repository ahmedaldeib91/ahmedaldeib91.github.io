/* =====================================================================
   admin-qbank.js — قسم «بنك الأسئلة» (#qbank ...) في لوحة المدرب: النواة والتوجيه واختيار الدورة والتبويبات
   ملف عادي (ES2017) يُحمَّل بـ defer بعد admin-core.js وقبل ملفات الأجزاء (admin-qbank-list / -taxonomy / -editor / -staff.js)
   وقبل admin.js. يعرّف A.qb (ثوابت وجلب التصنيف والوسوم وأنواع الأسئلة وترجمة الأخطاء ومعاينة السؤال)، ويسجّل القسم بـ A.register.
   الأجزاء تضع نفسها في A.qb.mods وتُستدعى وقت العرض فقط، فلا يهم ترتيب تحميلها بينها.

   المسارات (hash)
     #qbank                                    الدورة الأخيرة (أو الأولى) + تبويب الأسئلة
     #qbank/<course>/questions[/h:<sha256>]    قائمة الأسئلة (الجزء الاختياري: تصفية بالأسئلة ذات المحتوى المطابق لسؤال محفوظ)
     #qbank/<course>/taxonomy                  التصنيف (مجال ← موضوع ← موضوع فرعي) والوسوم
     #qbank/<course>/staff                     فريق مدرّبي الدورة وصلاحياتهم
     #qbank/<course>/new | /edit/<uuid> | /copy/<uuid>      المحرر (عرض كامل: الدورة ثابتة)

   القواعد (نفس قواعد platform-README.txt)
   - كل نص قادم من القاعدة أو من المستخدم يدخل الصفحة بـ ui.h (textContent) فقط. نص السؤال نص عادي بأسطر فقط ولا يُفسَّر HTML أبدًا.
   - كل استعلام عن بيانات البنك يحمل course_id=eq.<الدورة المختارة>. الصلاحية الحقيقية لسياسات RLS والدالة qb_save_question.
   - لا يُكتب أي محتوى سؤال أو إجابة في console ولا في التخزين المحلي.
   ===================================================================== */
(function () {
  'use strict';

  const A = window.Admin;
  if (!A) return;
  const P = A.P;
  const h = A.h;
  const ui = A.ui;
  const doc = document;
  const COURSE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
  const SVGNS = 'http://www.w3.org/2000/svg';

  const QB = A.qb = { mods: {}, cache: {}, types: null, flash: null, last: '' };

  /* ---------- ثوابت ---------- */
  QB.DIFF = [['easy', 'سهل'], ['medium', 'متوسط'], ['hard', 'صعب']];
  QB.DIFF_KIND = { easy: 'ok', medium: 'info', hard: 'warn' };
  QB.STATUS = [['draft', 'مسودة'], ['active', 'مفعّل'], ['retired', 'معطّل']]; /* الحالات في القاعدة: draft | active | retired */
  QB.STATUS_KIND = { draft: 'info', active: 'ok', retired: 'mut' };
  QB.LEVELS = { domain: 'مجال', topic: 'موضوع', subtopic: 'موضوع فرعي' };
  QB.LANGS = [['ar', 'العربية'], ['en', 'الإنجليزية'], ['mixed', 'مختلطة']];
  QB.TYPE_SHORT = { mcq_single: 'اختيار واحد', multi_response: 'اختيار متعدد', true_false: 'صح / خطأ' };
  /* مفاتيح صلاحيات المدرّب = private.staff_permission_keys() في القاعدة: [المفتاح، التسمية، الشرح، الاسم المختصر] */
  QB.PERMS = [
    ['qbank.read', 'قراءة بنك الأسئلة', 'عرض الأسئلة ومفاتيحها وتصنيفها. تُمنح ضمنًا مع «كتابة بنك الأسئلة».', 'قراءة'],
    ['qbank.write', 'كتابة بنك الأسئلة', 'إنشاء الأسئلة وتعديلها وتعطيلها وإدارة التصنيف والوسوم. تتضمن القراءة.', 'كتابة'],
    ['qbank.import', 'استيراد الأسئلة', 'تُستعمل عند إضافة الاستيراد (مرحلة لاحقة).', 'استيراد'],
    ['exam.write', 'إنشاء الاختبارات وتعديلها', 'تُستعمل عند إضافة بناء الاختبارات (مرحلة لاحقة).', 'اختبارات'],
    ['exam.publish', 'نشر الاختبارات', 'تُستعمل عند إضافة بناء الاختبارات (مرحلة لاحقة).', 'نشر'],
    ['grading', 'تصحيح المحاولات', 'تُستعمل مع محاولات المتدربين (مرحلة لاحقة).', 'تصحيح'],
    ['analytics.read', 'عرض التحليلات', 'تُستعمل مع التحليلات (مرحلة لاحقة).', 'تحليلات'],
    ['security.read', 'عرض سجل الأمن', 'تُستعمل مع مراقبة الاختبارات (مرحلة لاحقة).', 'أمن']
  ];

  QB.labelOf = function (list, value, fallback) {
    for (let i = 0; i < list.length; i++) if (list[i][0] === value) return list[i][1];
    return fallback === undefined ? String(value == null ? '' : value) : fallback;
  };
  /* قوائم بنك الأسئلة داخل مركز الدورة (#courses/<c>/questions/<فرعي>)؛ المحرر (new/edit/copy) صفحة كاملة على #qbank */
  const HUB_SUB = { questions: 'bank', taxonomy: 'folders', staff: 'team' };
  QB.href = function (course, view, extra) {
    const c = encodeURIComponent(course);
    if (Object.prototype.hasOwnProperty.call(HUB_SUB, view)) return '#courses/' + c + '/questions/' + HUB_SUB[view] + (extra ? '/' + encodeURIComponent(extra) : '');
    return '#qbank/' + c + '/' + view + (extra ? '/' + encodeURIComponent(extra) : '');
  };
  QB.nextSort = function (list) { return list.reduce(function (m, x) { return Math.max(m, Number(x.sort) || 0); }, 0) + 10; };
  QB.len = function (s) { return Array.from(String(s == null ? '' : s)).length; }; /* عدد المحارف كما يعدّها Postgres (نقاط ترميز لا وحدات UTF-16) */
  QB.bytes = function (v) {
    const s = JSON.stringify(v);
    try { return new TextEncoder().encode(s).length; } catch (e) { return s.length * 3; }
  };
  QB.replaceHash = function (hash) { try { window.history.replaceState(null, '', hash); } catch (e) { /* تجاهل */ } };

  /* أيقونات: ما لا تعرفه A.icon يُرسم هنا (نسخ) */
  const ICONS = { copy: 'M9 9h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1z M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1' };
  QB.icon = function (name) {
    if (!Object.prototype.hasOwnProperty.call(ICONS, name)) return A.icon(name);
    const s = doc.createElementNS(SVGNS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('focusable', 'false');
    s.setAttribute('class', 'pf-ic');
    const p = doc.createElementNS(SVGNS, 'path');
    p.setAttribute('d', ICONS[name]);
    s.appendChild(p);
    return s;
  };

  /* قائمة منسدلة: يعيد ملء الخيارات [[value,label]] ويحدّد القيمة الحالية (أو الأولى إن لم توجد) */
  QB.setOptions = function (sel, opts, current) {
    A.clear(sel);
    opts.forEach(function (o) { sel.appendChild(h('option', { value: o[0], text: o[1] })); });
    const want = current === undefined || current === null ? '' : String(current);
    sel.value = want;
    if (sel.value !== want) sel.selectedIndex = 0;
  };

  /* ---------- أخطاء ----------
     نص الخادم لا يصل إلى ApiError عمدًا (يبقى الرمز فقط)، فتُترجم الرموز هنا بحسب السياق:
     save (qb_save_question) | row (تفعيل/تعطيل/حذف سؤال) | tax | taxdel | tag | tagdel | staff | list */
  QB.errMsg = function (err, ctx) {
    if (!(err instanceof P.ApiError)) return P.MSG.other;
    const code = err.code || '';
    if (err.kind === 'network' || err.kind === 'config' || err.kind === 'storage' || err.kind === 'server') return err.message;
    if (code === 'P0001' || err.kind === 'rate' || err.status === 429) {
      return ctx === 'save'
        ? 'تجاوزتَ حدّ الحفظ المسموح (١٢٠ عملية حفظ في الدقيقة). انتظر دقيقة ثم أعد المحاولة؛ لم يُحفظ شيء.'
        : P.MSG.rate;
    }
    if (code === '42501' || err.kind === 'forbidden') {
      return ctx === 'save'
        ? 'لا تملك صلاحية الكتابة في بنك أسئلة هذه الدورة، أو أن السؤال لم يعد موجودًا. حدّث الصفحة ثم أعد المحاولة.'
        : P.MSG.forbidden;
    }
    if (code === '22023') {
      if (ctx === 'save') return 'رفض الخادم محتوى السؤال لأنه لا يطابق شروط نوعه (عدد الخيارات أو الإجابة الصحيحة أو الأطوال أو الحقول). راجع النموذج ثم أعد المحاولة.';
      if (ctx === 'tax') return 'قيمة غير صالحة: تأكد من تسلسل المستويات (مجال ← موضوع ← موضوع فرعي) ومن صيغة الرمز.';
      if (ctx === 'staff') return 'الصلاحيات المرسلة غير صالحة. حدّث الصفحة ثم أعد المحاولة.';
      return 'قيمة غير صالحة. راجع المدخلات ثم أعد المحاولة.';
    }
    if (code === '23503' || code === '23001') { /* 23001 = restrict_violation: ما يرميه Postgres 18+ بدل 23503 عند ON DELETE RESTRICT */
      if (ctx === 'save') return 'أحد العناصر المختارة (التصنيف أو الوسم أو المرفق) لا يتبع هذه الدورة أو حُذف. حدّث الصفحة ثم اختر من جديد.';
      if (ctx === 'taxdel') return 'لا يمكن حذف هذا العنصر لأنه يحتوي عناصر فرعية أو مرتبط بأسئلة. انقل الأسئلة إلى تصنيف آخر أو احذف الفروع أولًا.';
      if (ctx === 'row') return 'لا يمكن حذف هذا السؤال لأنه مرتبط ببيانات أخرى (اختبارات أو محاولات). عطّله بدلًا من حذفه.';
      if (ctx === 'tax') return 'العنصر الأب غير موجود في هذه الدورة. حدّث الصفحة ثم أعد المحاولة.';
      return 'العنصر مرتبط ببيانات أخرى أو لم يعد موجودًا. حدّث الصفحة ثم أعد المحاولة.';
    }
    if (code === '23505') {
      if (ctx === 'tag') return 'يوجد وسم بالاسم نفسه في هذه الدورة (لا يُفرَّق بين الحروف الكبيرة والصغيرة).';
      if (ctx === 'tax') return 'الرمز مستعمل لعنصر آخر في هذه الدورة. اختر رمزًا مختلفًا.';
      if (ctx === 'staff') return 'هذا المستخدم معيَّن مسبقًا مدرّبًا لهذه الدورة.';
      return 'هذا العنصر موجود مسبقًا.';
    }
    if (code === '23514') return 'قيمة خارج الحدود المسموحة. راجع المدخلات.';
    if (code === '22P02') return 'معرّف غير صالح. حدّث الصفحة ثم أعد المحاولة.';
    return err.message || P.MSG.other;
  };
  QB.say = function (out, err, ctx) {
    const text = QB.errMsg(err, ctx);
    if (out) ui.msg(out, 'err', text); else A.toast('err', text);
  };
  /* معالج نقر بلا تكرار (A.run) مع ترجمة أخطاء هذا القسم بدل رسائل الواجهة العامة */
  QB.run = function (btn, out, ctx, fn) {
    return A.run(btn, out, async function (e) {
      try { await fn(e); } catch (err) {
        if (A.isSession(err)) { A.lost('expired'); return; }
        if (A.isForbidden(err) || (err && err.code === '42501')) A.hooks.forbidden();
        QB.say(out, err, ctx);
      }
    });
  };
  /* خطأ أثناء تحميل جزء من الشاشة: الجلسة المنتهية تحوّل إلى الدخول، وغيرها بطاقة خطأ مع إعادة المحاولة */
  QB.loadFail = function (box, err, retry, ctx) {
    if (A.isSession(err)) { A.lost('expired'); return; }
    if (A.isForbidden(err)) A.hooks.forbidden();
    A.clear(box);
    box.appendChild(A.fail(QB.errMsg(err, ctx || 'list'), retry));
  };

  /* ---------- بيانات مشتركة ---------- */
  const cacheFor = function (course) { return QB.cache[course] || (QB.cache[course] = {}); };
  QB.drop = function (course) { delete QB.cache[course]; };

  /* أنواع الأسئلة المفعّلة في السجل (qb_question_types.enabled = true) */
  QB.getTypes = async function (force) {
    if (QB.types && !force) return QB.types;
    QB.types = await P.rest.select('qb_question_types', { select: 'code,name_ar,name_en,grading,sort', enabled: 'eq.true', order: 'sort.asc,code.asc' });
    return QB.types;
  };
  QB.typeLabel = function (code, long) {
    if (!long && Object.prototype.hasOwnProperty.call(QB.TYPE_SHORT, code)) return QB.TYPE_SHORT[code];
    const t = (QB.types || []).filter(function (x) { return x.code === code; })[0];
    return t ? t.name_ar : String(code || '—');
  };

  /* التصنيف: شجرة من الصفوف المسطّحة. path(id) = العقد من الجذر إلى العقدة؛ subtree(id) = المعرّف نفسه وكل أبنائه */
  QB.buildTax = function (rows) {
    const byId = {};
    const kids = {};
    const roots = [];
    const cmp = function (a, b) {
      return ((Number(a.sort) || 0) - (Number(b.sort) || 0)) || String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id));
    };
    rows.forEach(function (r) { byId[r.id] = r; });
    rows.forEach(function (r) {
      if (!r.parent_id) roots.push(r);
      else if (byId[r.parent_id]) (kids[r.parent_id] = kids[r.parent_id] || []).push(r);
    });
    roots.sort(cmp);
    Object.keys(kids).forEach(function (k) { kids[k].sort(cmp); });
    const tax = { rows: rows, byId: byId, roots: roots };
    tax.children = function (id) { return id ? (kids[id] || []) : roots; };
    tax.path = function (id) {
      const out = [];
      let cur = id ? byId[id] : null;
      while (cur && out.length < 5) { out.unshift(cur); cur = cur.parent_id ? byId[cur.parent_id] : null; }
      return out;
    };
    tax.pathText = function (id) { return tax.path(id).map(function (n) { return n.name_ar; }).join(' › '); };
    tax.subtree = function (id) {
      const ids = [];
      const walk = function (x) { ids.push(x); (kids[x] || []).forEach(function (c) { walk(c.id); }); };
      if (byId[id]) walk(id);
      return ids;
    };
    return tax;
  };
  QB.getTax = async function (course, force) {
    const c = cacheFor(course);
    if (c.tax && !force) return c.tax;
    const rows = await A.all('qb_taxonomy', { select: 'id,course_id,parent_id,level,code,name_ar,name_en,sort,created_at', course_id: 'eq.' + course, order: 'sort.asc,created_at.asc,id.asc' });
    c.tax = QB.buildTax(rows);
    return c.tax;
  };
  QB.getTags = async function (course, force) {
    const c = cacheFor(course);
    if (c.tags && !force) return c.tags;
    const rows = await A.all('qb_tags', { select: 'id,course_id,label,created_at', course_id: 'eq.' + course, order: 'label.asc,id.asc' });
    const byId = {};
    rows.forEach(function (t) { byId[t.id] = t; });
    c.tags = { rows: rows, byId: byId };
    return c.tags;
  };

  /* يعيد ترقيم قائمة مرتبة (١٠، ٢٠، …) ويحدّث الصفوف التي تغيّر ترتيبها فقط (٤ طلبات متوازية) */
  QB.applyOrder = async function (table, course, ordered) {
    const jobs = [];
    ordered.forEach(function (it, i) { const s = (i + 1) * 10; if (Number(it.sort) !== s) jobs.push([it.id, s]); });
    for (let i = 0; i < jobs.length; i += 4) {
      await Promise.all(jobs.slice(i, i + 4).map(function (j) {
        return P.rest.update(table, { id: 'eq.' + j[0], course_id: 'eq.' + course }, { sort: j[1] }).then(function (rows) { if (!rows.length) throw A.noRows(); });
      }));
    }
  };

  /* ---------- نافذة (معاينة وغيرها): dialog أصلي بحبس تركيز وESC وإغلاق بالنقر خارجها ---------- */
  QB.modal = function (title, body, o) {
    o = o || {};
    const prev = doc.activeElement;
    const tid = A.nid('dlg-t');
    const close = h('button', { type: 'button', class: 'btn s', text: o.close || 'إغلاق' });
    const dlg = h('dialog', { class: 'ad-dialog ad-qb-modal', 'aria-labelledby': tid },
      h('div', { class: 'ad-dlgbody' }, h('h3', { id: tid, text: title }), body, h('div', { class: 'btns ad-dlgact' }, close)));
    let done = false;
    function end() {
      if (done) return;
      done = true;
      try { dlg.close(); } catch (e) { /* مغلقة */ }
      dlg.remove();
      try { if (prev && prev.focus) prev.focus(); } catch (e) { /* تجاهل */ }
    }
    close.addEventListener('click', end);
    dlg.addEventListener('cancel', function (e) { e.preventDefault(); end(); });
    dlg.addEventListener('click', function (e) { if (e.target === dlg) end(); });
    doc.body.appendChild(dlg);
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
    close.focus();
    return end;
  };

  /* ---------- معاينة السؤال كما يراه المتدرب ----------
     تُبنى من الحمولة العامة (payload) وحدها: لا مفتاح ولا شرح ولا أي علامة على الإجابة الصحيحة. التصحيح غير مفعّل هنا.
     النص نص عادي (الأسطر تُحفظ بـ white-space:pre-line في CSS) ولا يُفسَّر HTML أبدًا. */
  QB.preview = function (type, payload, urls) {
    payload = payload && typeof payload === 'object' ? payload : {};
    const stem = payload.stem && typeof payload.stem.text === 'string' ? payload.stem.text : '';
    const multi = type === 'multi_response';
    const nm = A.nid('qbpv');
    /* الصور: تُعرض إن توفّرت روابطها الموقّعة (urls: معرّف ← {url, alt})؛ وإلا يُذكر عددها فقط */
    const ids = Array.isArray(payload.media) ? payload.media : [];
    const shown = ids.filter(function (id) { return urls && urls[id] && urls[id].url; });
    const figs = shown.length ? h('div', { class: 'ad-qb-pvimgs' }, shown.map(function (id) {
      return h('img', { class: 'ad-qb-pvimg', src: urls[id].url, alt: urls[id].alt || '', loading: 'lazy' });
    })) : null;
    const hidden = ids.length - shown.length;
    const mediaNote = hidden > 0 ? h('p', { class: 'pf-hint', text: 'يحتوي السؤال على ' + hidden + ' مرفق لا يُعرض في هذه المعاينة.' }) : null;
    if (type === 'matching') {
      const right = Array.isArray(payload.right) ? payload.right : [];
      const left = Array.isArray(payload.left) ? payload.left : [];
      const rows = left.map(function (it, i) {
        const sid = nm + '-m' + i;
        const sel = h('select', { class: 'pf-in', id: sid, 'aria-label': 'مطابقة العنصر ' + (i + 1) },
          [h('option', { value: '', text: '— اختر —' })].concat(right.map(function (r) { return h('option', { value: String(r.id), text: String(r.text || '—') }); })));
        return h('li', { class: 'pf-mrow' }, h('label', { for: sid, class: 'pf-mtext', dir: 'auto', text: String(it.text || '—') }), sel);
      });
      return h('div', { class: 'ad-qb-pv' },
        h('ol', { class: 'pf-qlist' }, h('li', { class: 'pf-q' }, h('fieldset', null,
          h('legend', null, h('span', { class: 'qn', text: '1' }), h('span', { class: 'pf-qtext', dir: 'auto', text: stem || '—' })),
          figs, h('p', { class: 'pf-hint', text: 'طابق كل عنصر بالخيار المناسب.' }), h('ol', { class: 'pf-match' }, rows)))),
        mediaNote);
    }
    let items = [];
    if (type === 'true_false') {
      const lb = payload.labels && typeof payload.labels === 'object' ? payload.labels : {};
      items = [{ id: 'true', text: typeof lb['true'] === 'string' && lb['true'] ? lb['true'] : 'صح' }, { id: 'false', text: typeof lb['false'] === 'string' && lb['false'] ? lb['false'] : 'خطأ' }];
    } else if (Array.isArray(payload.options)) {
      items = payload.options.map(function (x) { return { id: String(x && x.id), text: String((x && x.text) || '') }; });
    }
    const opts = h('div', { class: 'pf-opts' });
    items.forEach(function (it, i) {
      const rid = nm + '-' + i;
      const inp = h('input', { type: multi ? 'checkbox' : 'radio', name: multi ? rid : nm, id: rid, value: it.id });
      opts.appendChild(h('label', { class: 'pf-opt', for: rid }, inp, h('span', { class: 'pf-ot', dir: 'auto', text: it.text || '—' })));
    });
    opts.addEventListener('change', function () {
      Array.prototype.forEach.call(opts.querySelectorAll('input'), function (x) { x.parentNode.classList.toggle('on', x.checked); });
    });
    let hint = null;
    if (multi) {
      const mn = Number(payload.min_select);
      const mx = Number(payload.max_select);
      const hasMn = payload.min_select !== undefined && payload.min_select !== null && Number.isInteger(mn);
      const hasMx = payload.max_select !== undefined && payload.max_select !== null && Number.isInteger(mx);
      let t = 'اختر كل الإجابات الصحيحة.';
      if (hasMn && hasMx) t = mn === mx ? 'اختر ' + mn + ' إجابات.' : 'اختر من ' + mn + ' إلى ' + mx + ' إجابات.';
      else if (hasMn) t = 'اختر ' + mn + ' إجابات على الأقل.';
      else if (hasMx) t = 'اختر ' + mx + ' إجابات على الأكثر.';
      hint = h('p', { class: 'pf-hint', text: t });
    }
    return h('div', { class: 'ad-qb-pv' },
      h('ol', { class: 'pf-qlist' }, h('li', { class: 'pf-q' }, h('fieldset', null,
        h('legend', null, h('span', { class: 'qn', text: '1' }), h('span', { class: 'pf-qtext', dir: 'auto', text: stem || '—' })),
        figs, hint, opts))),
      mediaNote);
  };

  /* روابط موقّعة (ساعة) لصور سؤال من دلو exam-media: معرّف ← {url, alt}. لا تُحفظ ولا تُسجَّل */
  QB.mediaUrls = async function (course, ids) {
    const out = {};
    if (!ids.length) return out;
    const rows = await P.rest.select('qb_media', { select: 'id,storage_path,alt_ar', course_id: 'eq.' + course, id: 'in.(' + ids.join(',') + ')' });
    await Promise.all(rows.map(async function (r) {
      try { out[r.id] = { url: await P.storage.signedUrl('exam-media', r.storage_path, 3600), alt: r.alt_ar || '' }; } catch (e) { /* بلا صورة */ }
    }));
    return out;
  };

  /* ---------- القسم ---------- */
  const modOf = function (name) {
    const m = QB.mods[name];
    if (!m) throw new P.ApiError('other', 'تعذّر تحميل جزء من قسم بنك الأسئلة. حدّث الصفحة ثم أعد المحاولة.', 0, 'module');
    return m;
  };
  QB.mod = modOf;

  function mountPanel(panel, name, o) {
    let p;
    try { p = Promise.resolve(modOf(name).render(panel, o)); } catch (err) { p = Promise.reject(err); }
    p.catch(function (err) {
      if (A.stale(o.token)) return;
      QB.loadFail(panel, err, function () { A.clear(panel); mountPanel(panel, name, o); });
    });
  }

  async function render(root, args, token) {
    const courses = await A.loadCourses();
    if (A.stale(token)) return;
    if (!courses.length) {
      root.appendChild(A.head('بنك الأسئلة', null, []));
      root.appendChild(A.empty('لا توجد دورات', 'لا توجد دورات في قاعدة البيانات بعد.'));
      return;
    }
    let course = args[0] || '';
    let view = args[1] || 'questions';
    if (!course) {
      course = QB.last && A.courseById(QB.last) ? QB.last : courses[0].id;
      view = 'questions';
      QB.replaceHash(QB.href(course, 'questions'));
    }
    if (!COURSE_RE.test(course) || !A.courseById(course)) {
      root.appendChild(A.head('بنك الأسئلة', null, []));
      root.appendChild(A.empty('الدورة غير موجودة', 'لم نجد دورة بهذا المعرّف. اختر دورة من القائمة.', A.link('اختيار دورة', '#qbank', { kind: 'p', icon: 'back' })));
      return;
    }
    QB.last = course;
    if (view === 'new' || view === 'edit' || view === 'copy') {
      await modOf('editor').render(root, { course: course, mode: view, id: args[2] || '', token: token });
      return;
    }
    if (view !== 'questions' && view !== 'taxonomy' && view !== 'staff') view = 'questions';
    window.location.replace(QB.href(course, view, args[2] || '')); /* القوائم صارت في مركز الدورة */
  }

  function renderTabs(root, courses, course, view, extra, token) {
    const row = A.courseById(course);
    root.appendChild(A.head('بنك الأسئلة', 'أسئلة كل دورة منفصلة تمامًا عن غيرها. اختر الدورة ثم أدر أسئلتها وتصنيفها ووسومها وفريق مدرّبيها.', []));
    const sel = A.select(courses.map(function (c) { return [c.id, c.title_ar + (c.published ? '' : ' (غير منشورة)')]; }), course);
    sel.addEventListener('change', function () { window.location.hash = QB.href(sel.value, ctl.current() || 'questions'); });
    root.appendChild(h('div', { class: 'ad-tools' },
      A.field('الدورة', sel, 'كل ما في الأقسام التالية يخص هذه الدورة وحدها.'),
      h('div', { class: 'ad-badges' }, A.badge(row.published ? 'منشورة' : 'غير منشورة', row.published ? 'ok' : 'mut'), h('span', { class: 'ad-ltr ad-muted', text: row.id }))));

    const names = { questions: 'الأسئلة', taxonomy: 'التصنيف', staff: 'الفريق' };
    const icons = { questions: 'quiz', taxonomy: 'book', staff: 'users' };
    const tabsEl = h('div', { class: 'pf-tabs ad-tabbar', role: 'tablist', 'aria-label': 'أقسام بنك الأسئلة' },
      Object.keys(names).map(function (n) {
        return h('button', { type: 'button', role: 'tab', id: 'qbt-' + n, 'data-tab': n, 'aria-controls': 'qbp-' + n, 'aria-selected': 'false', tabindex: '-1' }, A.icon(icons[n]), names[n]);
      }));
    root.appendChild(tabsEl);
    const panels = {};
    Object.keys(names).forEach(function (n) {
      panels[n] = h('div', { role: 'tabpanel', id: 'qbp-' + n, 'aria-labelledby': 'qbt-' + n, hidden: true });
      root.appendChild(panels[n]);
    });
    const mounted = {};
    let first = true;
    const ctl = ui.tabs(tabsEl, {
      onSelect: function (name) {
        if (!(first && extra)) QB.replaceHash(QB.href(course, name)); /* التبويب الأول يحافظ على الجزء الاختياري من الرابط (h:...) */
        first = false;
        if (mounted[name]) return;
        mounted[name] = true;
        const o = { course: course, token: token, extra: name === view ? extra : '' };
        mountPanel(panels[name], name === 'questions' ? 'list' : name, o);
      }
    });
    ctl.select(view, false);
  }

  A.register('qbank', { label: 'بنك الأسئلة', render: render });
})();
