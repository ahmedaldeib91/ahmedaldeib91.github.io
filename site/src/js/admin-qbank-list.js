/* =====================================================================
   admin-qbank-list.js — تبويب «الأسئلة» في قسم بنك الأسئلة (#qbank/<course>/questions)
   قائمة بصفحات من الخادم (Platform.rest.page: Range + count=exact) للأسئلة الحالية في الدورة المختارة وحدها (course_id في كل طلب):
   بحث في نص السؤال (ilike على payload->stem->>text، أو مطابقة معرّف كامل)، وتصفية بالحالة والنوع والصعوبة والتصنيف (مجال ← موضوع ← فرعي،
   وتشمل الأبناء) والوسم، ومطابقة المحتوى (content_hash) لعرض الأسئلة المكررة. الإصدار الحالي لكل سؤال يُجلب بضمّ مضمَّن
   (qb_question_versions!qb_questions_current_version_fkey!inner) فتعمل تصفية النوع والصعوبة والتصنيف والنص في الخادم قبل الترقيم.
   الإجراءات: تعديل، نسخ (سؤال جديد بإصدار ١)، معاينة بشكل المتدرب (بلا أي علامة إجابة)، تفعيل/تعطيل (status)، حذف نهائي (للمدير فقط في القاعدة).
   البحث يطابق النص كما كُتب (لا توحيد للهمزات والتشكيل في الخادم)؛ الحمولة العامة لا تحوي أي مفتاح إجابة.
   ===================================================================== */
(function () {
  'use strict';

  const A = window.Admin;
  if (!A || !A.qb) return;
  const QB = A.qb;
  const P = A.P;
  const h = A.h;
  const ui = A.ui;
  const PAGE = 20;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const VERSION_EMBED = 'qb_question_versions!qb_questions_current_version_fkey!inner(id,version_no,type_code,difficulty,taxonomy_id,points,weight,lang,content_hash,payload)';

  const verOf = function (row) {
    const v = row.qb_question_versions;
    return Array.isArray(v) ? v[0] : v;
  };
  const stemOf = function (v) { return v && v.payload && v.payload.stem && typeof v.payload.stem.text === 'string' ? v.payload.stem.text : ''; };
  const excerpt = function (s) {
    const a = Array.from(s.replace(/\s+/g, ' ').trim());
    return a.length > 110 ? a.slice(0, 110).join('') + '…' : a.join('');
  };
  /* نص البحث إلى نمط ilike: النجمة محجوزة لـ PostgREST، و% و_ و\ محارف خاصة في LIKE فتُهرَّب لتُطابق حرفيًا */
  const likeTerm = function (s) {
    return String(s == null ? '' : s).replace(/\*/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100).replace(/[\\%_]/g, '\\$&');
  };

  async function renderList(panel, o) {
    const course = o.course;
    const token = o.token;
    const st = { q: '', status: 'all', type: 'all', diff: 'all', dom: '', top: '', sub: '', tag: '', hash: /^h:[0-9a-f]{64}$/.test(o.extra || '') ? o.extra.slice(2) : '', page: 1 };
    panel.appendChild(A.loading('جارٍ تحميل الأسئلة…'));
    let r;
    try { r = await Promise.all([QB.getTypes(), QB.getTax(course, true), QB.getTags(course, true)]); } catch (err) {
      if (A.stale(token)) return;
      QB.loadFail(panel, err, function () { A.clear(panel); renderList(panel, o); });
      return;
    }
    if (A.stale(token)) return;
    const types = r[0];
    let tax = r[1];
    let tags = r[2];
    A.clear(panel);

    const refresh = A.btn('تحديث', { icon: 'refresh', small: true });
    const clearBtn = A.btn('مسح التصفية', { small: true });
    const search = A.input({ type: 'search', max: 100, placeholder: 'ابحث في نص السؤال، أو الصق معرّفه الكامل' });
    const fStatus = A.select([['all', 'كل الحالات']].concat(QB.STATUS), 'all');
    const fType = A.select([['all', 'كل الأنواع']].concat(types.map(function (t) { return [t.code, t.name_ar]; })), 'all');
    const fDiff = A.select([['all', 'كل المستويات']].concat(QB.DIFF), 'all');
    const fDom = A.select([['', 'كل المجالات']], '');
    const fTop = A.select([['', 'كل المواضيع']], '');
    const fSub = A.select([['', 'كل المواضيع الفرعية']], '');
    const fTag = A.select([['', 'كل الوسوم']].concat(tags.rows.map(function (t) { return [t.id, t.label]; })), '');
    const count = h('p', { class: 'ad-count-t', role: 'status' });
    const chips = h('div', { class: 'ad-qb-chips' });
    const out = A.msgBox();
    const box = h('div');

    const ioBox = h('div');
    const openIo = function (kind) {
      const m = QB.mods.io;
      A.clear(ioBox);
      if (!m) { ioBox.appendChild(A.fail('تعذّر تحميل أداة الاستيراد والتصدير. حدّث الصفحة ثم أعد المحاولة.', null)); return; }
      ioBox.appendChild(kind === 'import' ? m.importCard(course, { tax: tax, onDone: load }) : m.exportCard(course, { tax: tax }));
    };
    panel.appendChild(h('div', { class: 'ad-qb-bar' }, A.link('سؤال جديد', QB.href(course, 'new'), { kind: 'p', small: true, icon: 'plus' }),
      A.btn('استيراد', { small: true, icon: 'plus', on: function () { openIo('import'); } }), A.btn('تصدير', { small: true, icon: 'file', on: function () { openIo('export'); } }), refresh, clearBtn));
    panel.appendChild(ioBox);
    panel.appendChild(h('div', { class: 'ad-tools' },
      A.field('بحث', search, 'يطابق النص كما كُتب (دون توحيد الهمزات والتشكيل).'),
      A.field('الحالة', fStatus, null, 'sm'), A.field('النوع', fType, null, 'sm'), A.field('الصعوبة', fDiff, null, 'sm')));
    panel.appendChild(h('div', { class: 'ad-tools' },
      A.field('المجال', fDom, null, 'sm'), A.field('الموضوع', fTop, null, 'sm'), A.field('الموضوع الفرعي', fSub, null, 'sm'), A.field('الوسم', fTag, null, 'sm'), count));
    panel.appendChild(chips);
    panel.appendChild(out);
    panel.appendChild(box);

    const nodeOpt = function (n) { return [n.id, n.name_ar]; };
    function fillTax() {
      QB.setOptions(fDom, [['', 'كل المجالات']].concat(tax.roots.map(nodeOpt)), st.dom);
      QB.setOptions(fTop, [['', 'كل المواضيع']].concat((st.dom ? tax.children(st.dom) : []).map(nodeOpt)), st.top);
      QB.setOptions(fSub, [['', 'كل المواضيع الفرعية']].concat((st.top ? tax.children(st.top) : []).map(nodeOpt)), st.sub);
      fTop.disabled = !st.dom;
      fSub.disabled = !st.top;
    }
    function paintChips() {
      A.clear(chips);
      if (!st.hash) return;
      const b = A.btn('إلغاء هذه التصفية', { small: true });
      b.addEventListener('click', function () { st.hash = ''; st.page = 1; paintChips(); load(); });
      chips.appendChild(A.badge('تصفية: أسئلة بمحتوى مطابق لسؤال محفوظ (للتحقق من التكرار)', 'warn'));
      chips.appendChild(b);
    }

    function query() {
      const q = {
        select: 'id,course_id,status,created_at,updated_at,current_version_id,' + VERSION_EMBED,
        course_id: 'eq.' + course,
        order: 'updated_at.desc,id.asc',
        limit: String(PAGE),
        offset: String((st.page - 1) * PAGE)
      };
      const V = 'qb_question_versions.';
      if (st.status !== 'all') q.status = 'eq.' + st.status;
      if (st.type !== 'all') q[V + 'type_code'] = 'eq.' + st.type;
      if (st.diff !== 'all') q[V + 'difficulty'] = 'eq.' + st.diff;
      const node = st.sub || st.top || st.dom;
      if (node) q[V + 'taxonomy_id'] = 'in.(' + tax.subtree(node).join(',') + ')';
      if (st.hash) q[V + 'content_hash'] = 'eq.' + st.hash;
      if (st.tag) {
        q.select += ',qb_question_tags!inner(tag_id)';
        q['qb_question_tags.tag_id'] = 'eq.' + st.tag;
      }
      const term = st.q.trim();
      if (UUID.test(term)) q.id = 'eq.' + term.toLowerCase();
      else if (likeTerm(term)) q[V + 'payload->stem->>text'] = 'ilike.*' + likeTerm(term) + '*';
      return q;
    }

    /* ---------- صف ---------- */
    function acts(row, v) {
      const sBtn = row.status === 'active';
      const edit = h('a', { class: 'ad-ibtn', href: QB.href(course, 'edit', row.id), 'aria-label': 'تعديل السؤال', title: 'تعديل' }, A.icon('pen'));
      const copy = h('a', { class: 'ad-ibtn', href: QB.href(course, 'copy', row.id), 'aria-label': 'نسخ السؤال إلى سؤال جديد', title: 'نسخ' }, QB.icon('copy'));
      const prev = A.ibtn('eye', 'معاينة السؤال كما يراه المتدرب', function () {
        const holder = h('div', null, QB.preview(v.type_code, v.payload));
        QB.modal('معاينة السؤال', h('div', null,
          h('p', { class: 'ad-sub', text: 'هكذا يراه المتدرب: بلا إجابة صحيحة ولا شرح. معاينة فقط ولا يُحفظ شيء.' }),
          holder));
        if (v.payload && Array.isArray(v.payload.media) && v.payload.media.length) {
          QB.mediaUrls(course, v.payload.media).then(function (urls) {
            if (!holder.isConnected) return;
            A.clear(holder);
            holder.appendChild(QB.preview(v.type_code, v.payload, urls));
          }).catch(function () { /* تبقى المعاينة بلا صور */ });
        }
      });
      const tog = A.ibtn(sBtn ? 'archive' : 'check', sBtn ? 'تعطيل السؤال' : 'تفعيل السؤال', null);
      tog.addEventListener('click', QB.run(tog, out, 'row', async function () {
        ui.clearMsg(out);
        if (sBtn) {
          const ok = await A.confirm({
            title: 'تعطيل السؤال؟',
            message: 'سيصير السؤال «معطّلًا» ولن يُستعمل في الاختبارات الجديدة. يبقى محفوظًا بكل إصداراته ويمكنك تفعيله لاحقًا.',
            detail: excerpt(stemOf(v)), ok: 'تعطيل', danger: true
          });
          if (!ok) return;
        }
        const rows = await P.rest.update('qb_questions', { id: 'eq.' + row.id, course_id: 'eq.' + course }, { status: sBtn ? 'retired' : 'active' });
        if (!rows.length) throw A.noRows();
        A.toast('ok', sBtn ? 'تم تعطيل السؤال.' : 'تم تفعيل السؤال.');
        await load();
      }));
      const del = A.ibtn('trash', 'حذف السؤال نهائيًا', null, 'danger');
      del.addEventListener('click', QB.run(del, out, 'row', async function () {
        ui.clearMsg(out);
        const ok = await A.confirm({
          title: 'حذف السؤال نهائيًا؟',
          message: 'سيُحذف السؤال مع كل إصداراته ومفاتيحه ووسومه. لا يمكن التراجع عن الحذف.',
          detail: excerpt(stemOf(v)) + '\nللإخفاء فقط استعمل «تعطيل السؤال».', ok: 'حذف نهائي', danger: true
        });
        if (!ok) return;
        const rows = await P.rest.remove('qb_questions', { id: 'eq.' + row.id, course_id: 'eq.' + course });
        if (!rows.length) throw A.noRows();
        A.toast('ok', 'تم حذف السؤال.');
        await load();
      }));
      return h('div', { class: 'ad-cell-act ad-qb-acts' }, edit, copy, prev, tog, del);
    }
    function paint(rows, total) {
      A.clear(box);
      count.textContent = total ? 'عدد الأسئلة المطابقة: ' + A.num(total) : 'لا أسئلة مطابقة.';
      const filtered = !!(st.q.trim() || st.status !== 'all' || st.type !== 'all' || st.diff !== 'all' || st.dom || st.tag || st.hash);
      if (!rows.length) {
        box.appendChild(filtered
          ? A.empty('لا نتائج مطابقة', 'غيّر التصفية أو كلمة البحث، أو اضغط «مسح التصفية».')
          : A.empty('لا توجد أسئلة في هذه الدورة بعد', 'ابدأ بإنشاء أول سؤال (اختيار واحد أو متعدد أو صح/خطأ).', A.link('سؤال جديد', QB.href(course, 'new'), { kind: 'p', icon: 'plus' })));
        return;
      }
      const cols = [
        { key: 'q', label: 'السؤال', cls: 'ad-first', cell: function (row) {
          const v = verOf(row);
          return h('div', null,
            h('a', { class: 'ad-name', href: QB.href(course, 'edit', row.id), dir: 'auto', text: excerpt(stemOf(v)) || 'بلا نص' }),
            acts(row, v));
        } },
        { key: 'id', label: 'المعرّف', cls: 'hide-md', cell: function (row) { return h('span', { class: 'ad-qb-id', title: row.id, text: row.id.slice(0, 8) }); } },
        { key: 'type', label: 'النوع', cell: function (row) { return QB.typeLabel(verOf(row).type_code); } },
        { key: 'diff', label: 'الصعوبة', cell: function (row) { const d = verOf(row).difficulty; return A.badge(QB.labelOf(QB.DIFF, d), QB.DIFF_KIND[d] || 'mut'); } },
        { key: 'tax', label: 'التصنيف', cell: function (row) {
          const t = tax.pathText(verOf(row).taxonomy_id);
          return t ? h('span', { class: 'ad-qb-path', dir: 'auto', text: t }) : '—';
        } },
        { key: 'ver', label: 'الإصدار', cls: 'hide-md', cell: function (row) { return h('b', { class: 'ad-ltr', text: 'v' + verOf(row).version_no }); } },
        { key: 'status', label: 'الحالة', cell: function (row) { return A.badge(QB.labelOf(QB.STATUS, row.status), QB.STATUS_KIND[row.status] || 'mut'); } },
        { key: 'upd', label: 'آخر تعديل', cls: 'hide-md', cell: function (row) { return h('span', { class: 'ad-nowrap', text: A.fmtDay(row.updated_at) }); } }
      ];
      box.appendChild(h('div', { class: 'ad-qbt' }, A.dataTable(cols, rows, { caption: 'أسئلة الدورة', rowCls: function (row) { return row.status === 'active' ? null : 'ad-qb-off'; } })));
      const pg = A.pager(total, st.page, PAGE, function (n) { st.page = n; load(); const t = box.querySelector('.ad-tablewrap'); if (t) { t.setAttribute('tabindex', '-1'); t.focus({ preventScroll: false }); } });
      if (pg) box.appendChild(pg);
    }

    let seq = 0;
    async function load() {
      const my = ++seq;
      box.setAttribute('aria-busy', 'true');
      refresh.disabled = true;
      let res;
      try { res = await P.rest.page('qb_questions', query()); } catch (err) {
        if (my !== seq || A.stale(token)) return;
        box.removeAttribute('aria-busy');
        refresh.disabled = false;
        QB.loadFail(box, err, function () { load(); });
        return;
      }
      if (my !== seq || A.stale(token)) return;
      box.removeAttribute('aria-busy');
      refresh.disabled = false;
      const total = res.total === null ? res.rows.length : res.total;
      if (!res.rows.length && st.page > 1 && total > 0) { st.page = Math.max(1, Math.ceil(total / PAGE)); await load(); return; }
      paint(res.rows, total);
    }

    function changed() { st.page = 1; load(); }
    search.addEventListener('input', A.debounce(function () { st.q = search.value; changed(); }, 350));
    fStatus.addEventListener('change', function () { st.status = fStatus.value; changed(); });
    fType.addEventListener('change', function () { st.type = fType.value; changed(); });
    fDiff.addEventListener('change', function () { st.diff = fDiff.value; changed(); });
    fTag.addEventListener('change', function () { st.tag = fTag.value; changed(); });
    fDom.addEventListener('change', function () { st.dom = fDom.value; st.top = ''; st.sub = ''; fillTax(); changed(); });
    fTop.addEventListener('change', function () { st.top = fTop.value; st.sub = ''; fillTax(); changed(); });
    fSub.addEventListener('change', function () { st.sub = fSub.value; changed(); });
    clearBtn.addEventListener('click', function () {
      st.q = ''; st.status = 'all'; st.type = 'all'; st.diff = 'all'; st.dom = ''; st.top = ''; st.sub = ''; st.tag = ''; st.hash = '';
      search.value = ''; fStatus.value = 'all'; fType.value = 'all'; fDiff.value = 'all'; fTag.value = '';
      fillTax(); paintChips(); changed();
    });
    refresh.addEventListener('click', async function () {
      try {
        tax = await QB.getTax(course, true);
        tags = await QB.getTags(course, true);
      } catch (err) { if (A.isSession(err)) { A.lost('expired'); return; } }
      if (A.stale(token)) return;
      if (st.dom && !tax.byId[st.dom]) { st.dom = ''; st.top = ''; st.sub = ''; } else if (st.top && !tax.byId[st.top]) { st.top = ''; st.sub = ''; } else if (st.sub && !tax.byId[st.sub]) st.sub = '';
      if (st.tag && !tags.byId[st.tag]) st.tag = '';
      QB.setOptions(fTag, [['', 'كل الوسوم']].concat(tags.rows.map(function (t) { return [t.id, t.label]; })), st.tag);
      fillTax();
      load();
    });

    fillTax();
    paintChips();
    await load();
  }

  QB.mods.list = { render: renderList };
})();
