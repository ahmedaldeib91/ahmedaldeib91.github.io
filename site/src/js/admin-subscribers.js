/* =====================================================================
   admin-subscribers.js — قسم «المشتركون» (#subscribers) في لوحة المدرب
   تقرير بكل المتدربين: الاسم والبريد والهاتف والدولة والدورات المشترَك فيها وتاريخ التسجيل وآخر دخول.
   مصدر البيانات واحد: دالة القاعدة admin_subscribers_report() (الترحيل 007، للمدير فقط؛ لغيره تُرجع 42501 فتظهر رسالة صلاحية).
   تُجلب الصفوف بصفحات (limit/offset) حتى تأتي صفحة فارغة، فلا يضيع أحد إن كان سقف الخادم أقل من حجم الصفحة؛ والبحث والتصفية
   والترتيب والأرقام العلوية تُحسب كلها في المتصفح. بريد المتدربين وهواتفهم بيانات شخصية: لا يُسجَّل شيء منها في console ولا يُخزَّن.
   التصدير: CSV من المتصفح لكل ما يطابق التصفية الحالية (لا الصفحة المعروضة فقط)، بـ BOM لـ Excel العربي. الخلية التي تبدأ بـ = + - @
   (أو بمسافة/تبويب/سطر جديد) تُسبق بفاصلة عليا ' فتصير نصًا لا صيغة؛ والتنسيق والاقتباس من A.csvBuild.
   البريد والهاتف رابطا mailto:/tel: فقط إن اجتازا فحصًا صارمًا؛ وإلا يُعرضان نصًا عاديًا. كل نص من القاعدة يدخل بـ textContent.
   ===================================================================== */
(function () {
  'use strict';

  const A = window.Admin;
  if (!A) return;
  const P = A.P;
  const h = A.h;
  const PAGE = 25;             /* صفوف الجدول في الصفحة الواحدة */
  const FETCH = 1000;          /* حجم الصفحة المطلوبة من الخادم (حدّ Supabase الافتراضي) */
  const MAX_ROWS = 50000;      /* سقف أمان لحلقة الجلب */
  const DAY = 86400000;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const text = function (v) { return v === null || v === undefined ? '' : String(v).trim(); };
  const ms = function (iso) { const t = Date.parse(iso); return isNaN(t) ? 0 : t; };
  const z2 = function (n) { return (n < 10 ? '0' : '') + n; };
  /* «YYYY-MM-DD HH:mm» بتوقيت المتصفح (كما يظهر في الجدول)، أو '' إن لم يوجد تاريخ صالح. يقبله Excel تاريخًا */
  const stamp = function (iso) {
    const t = Date.parse(iso);
    if (isNaN(t)) return '';
    const d = new Date(t);
    return d.getFullYear() + '-' + z2(d.getMonth() + 1) + '-' + z2(d.getDate()) + ' ' + z2(d.getHours()) + ':' + z2(d.getMinutes());
  };
  /* تحييد الخلية التي تبدأ بتبويب أو رجوع سطر أو سطر جديد. أما = + - @ (ومعها مسافة/تحكم قبلها) فيتكفل بها A.csvCell،
     ولا تتكرر الفاصلة العليا لأن A.csvCell لا يلمس خلية تبدأ بها */
  const guard = function (v) {
    const s = v === null || v === undefined ? '' : String(v);
    return /^[\t\r\n]/.test(s) ? "'" + s : s;
  };

  /* رقم هاتف صالح لرابط tel: (+ اختيارية ثم ٧ إلى ١٥ رقمًا بعد حذف الفواصل المعتادة)، أو '' */
  function telOf(phone) {
    const s = A.latinDigits(phone).replace(/[\s().\-]/g, '');
    return /^\+?[0-9]{7,15}$/.test(s) ? s : '';
  }

  /* ---------- البيانات ---------- */
  /* كل صفوف التقرير بصفحات حتى تفرغ الصفحة. offset يتبع ما استلمناه فعلًا (لا ما أضفناه بعد حذف التكرار)،
     وصفحة بلا جديد (خادم يتجاهل offset مثلًا) توقف الحلقة */
  async function fetchAll() {
    const out = [];
    const seen = new Set();
    let offset = 0;
    while (offset < MAX_ROWS) {
      const page = await P.rest.rpc('admin_subscribers_report', {}, { limit: String(FETCH), offset: String(offset) });
      if (!Array.isArray(page)) throw new P.ApiError('server', P.MSG.server, 0, 'bad_response');
      if (!page.length) break;
      offset += page.length;
      let added = 0;
      page.forEach(function (r) {
        const id = r && typeof r.user_id === 'string' ? r.user_id : '';
        if (id) { if (seen.has(id)) return; seen.add(id); }
        out.push(r);
        added += 1;
      });
      if (!added) break;
    }
    return out;
  }

  /* صف التقرير → صف مطبَّع آمن (لا نثق في شكل الاستجابة) مع حقول محسوبة للبحث والترتيب */
  function normalize(src) {
    const r = src && typeof src === 'object' ? src : {};
    const courses = (Array.isArray(r.courses) ? r.courses : []).filter(function (c) { return c && typeof c === 'object'; }).map(function (c) {
      const id = text(c.course_id);
      return { id: id, title: text(c.title_ar) || text(c.title_en) || id, active: c.status === 'active' };
    }).filter(function (c) { return c.id || c.title; }); /* مدخل بلا معرّف ولا عنوان لا يُعرض شارةً فارغة */
    const activeIds = new Set();
    courses.forEach(function (c) { if (c.active && c.id) activeIds.add(c.id); });
    const n = r.active_courses;
    const row = {
      id: text(r.user_id), name: text(r.full_name), email: text(r.email), phone: text(r.phone), country: text(r.country),
      status: text(r.account_status), joined: r.joined_at || null, seen: r.last_sign_in_at || null,
      active: typeof n === 'number' && isFinite(n) && n >= 0 ? Math.floor(n) : courses.filter(function (c) { return c.active; }).length,
      courses: courses, activeIds: activeIds
    };
    row.joinedMs = ms(row.joined);
    row.seenMs = ms(row.seen);
    row.hay = A.normAr([row.name, row.email, row.phone].join(' '));
    row.phoneDigits = A.latinDigits(row.phone).replace(/\D/g, '');
    return row;
  }

  /* ---------- خلايا الجدول ---------- */
  function nameCell(r) {
    const label = r.name || 'بدون اسم';
    const link = UUID.test(r.id) ? h('a', { class: 'ad-name', href: '#trainees/' + r.id, text: label }) : h('b', { text: label });
    return h('div', null, link, r.status && r.status !== 'active' ? [' ', A.statusBadge('profile', r.status)] : null);
  }
  /* mailto: لا يُبنى إلا لبريد اجتاز A.validEmail؛ ui.h يحذف هذا النوع من الروابط، فنضبط href بعد الفحص */
  function emailCell(r) {
    if (!r.email) return '—';
    const href = A.mailto(r.email);
    if (!href) return h('span', { class: 'ad-ltr', text: r.email });
    const a = h('a', { class: 'pf-link ad-ltr', text: r.email });
    a.setAttribute('href', href);
    return a;
  }
  function phoneCell(r) {
    if (!r.phone) return '—';
    const tel = telOf(r.phone);
    if (!tel) return h('span', { class: 'ad-ltr', text: r.phone });
    const a = h('a', { class: 'pf-link ad-ltr ad-nowrap', text: r.phone });
    a.setAttribute('href', 'tel:' + tel);
    return a;
  }
  /* الدورة الملغاة تظهر بعبارة «ملغى» وبحدّ متقطّع (CSS)، فلا يعتمد التمييز على اللون وحده */
  function courseChips(r) {
    if (!r.courses.length) return h('span', { class: 'ad-muted', text: 'لا دورات' });
    return h('div', { class: 'ad-sbc' }, r.courses.map(function (c) {
      return A.badge(c.active ? c.title : c.title + ' (ملغى)', c.active ? 'ok' : 'mut');
    }));
  }

  function statCard(label, value, hint) {
    return h('div', { class: 'ad-stat' }, h('span', { class: 'big', text: A.num(value) }), h('b', { text: label }), hint ? h('small', { text: hint }) : null);
  }

  /* ثمانية أعمدة في ٩٣٨ بكسل (أقصى عرض للمحتوى) لا تتسع: الدولة تختفي تحت ١٣٠٠ بكسل (hide-lg) وهي والتاريخان تختفي تحت ١١٨٠ (hide-md)،
     وكلها تظهر في بطاقات الجوال. الأصناف ad-sbn وad-sbcol وhide-lg في admin.css (قسم المشتركون) */
  const COLS = [
    { key: 'name', label: 'الاسم', sort: true, cls: 'ad-first ad-sbn', cell: nameCell },
    { key: 'email', label: 'البريد الإلكتروني', cell: emailCell },
    { key: 'phone', label: 'الهاتف', cell: phoneCell },
    { key: 'country', label: 'الدولة', cls: 'hide-lg', cell: function (r) { return r.country || '—'; } },
    { key: 'courses', label: 'الدورات', cls: 'ad-sbcol', cell: courseChips },
    { key: 'active', label: 'النشطة', sort: true, cell: function (r) { return h('b', { class: 'ad-ltr', text: String(r.active) }); } },
    { key: 'joined', label: 'التسجيل', sort: true, cls: 'hide-md', cell: function (r) { return h('span', { class: 'ad-nowrap', text: A.fmtDay(r.joined) }); } },
    { key: 'seen', label: 'آخر دخول', sort: true, cls: 'hide-md', cell: function (r) { return h('span', { class: 'ad-nowrap', text: r.seen ? A.fmtDay(r.seen) : '—' }); } }
  ];
  const CMP = {
    name: function (a, b) { return a.name.localeCompare(b.name, 'ar'); },
    active: function (a, b) { return a.active - b.active; },
    joined: function (a, b) { return a.joinedMs - b.joinedMs; },
    seen: function (a, b) { return a.seenMs - b.seenMs; }
  };

  async function render(root, args, token) {
    const view = { q: '', course: 'all', status: 'all', sort: 'joined', dir: 'desc', page: 1 };
    const csvBtn = A.btn('تصدير CSV', { icon: 'download', small: true, disabled: true });
    const refresh = A.btn('تحديث', { icon: 'refresh', small: true });
    root.appendChild(A.head('المشتركون', 'كل المتدربين المسجّلين مع بريدهم وهاتفهم والدورات المشترَك فيها. ابحث وصفِّ ثم صدّر القائمة إلى Excel.', [csvBtn, refresh]));
    const body = h('div');
    root.appendChild(body);
    let rows = [];

    function stats() {
      const since = Date.now() - 30 * DAY;
      const s = { total: rows.length, withCourses: 0, without: 0, active: 0, new30: 0, seen30: 0 };
      rows.forEach(function (r) {
        if (r.active > 0) s.withCourses += 1; else s.without += 1;
        if (r.status === 'active') s.active += 1;
        if (r.joinedMs >= since) s.new30 += 1;
        if (r.seenMs >= since) s.seen30 += 1;
      });
      return s;
    }

    /* خيارات تصفية الدورة من واقع التقرير نفسه، مرتبة بعدد المشتركين النشطين (يظهر بين قوسين) */
    function courseOptions() {
      const map = new Map();
      rows.forEach(function (r) {
        r.courses.forEach(function (c) {
          if (!c.id) return;
          let e = map.get(c.id);
          if (!e) { e = { id: c.id, title: c.title, n: 0 }; map.set(c.id, e); }
          if (c.active) e.n += 1;
        });
      });
      const list = Array.from(map.values()).sort(function (a, b) { return (b.n - a.n) || a.title.localeCompare(b.title, 'ar'); });
      return [['all', 'كل الدورات'], ['none', 'بلا دورات نشطة']].concat(list.map(function (e) { return ['c:' + e.id, e.title + ' (' + e.n + ')']; }));
    }

    function filtered() {
      const q = A.normAr(view.q);
      const digits = A.latinDigits(view.q).replace(/\D/g, '');
      const cid = view.course.indexOf('c:') === 0 ? view.course.slice(2) : '';
      const out = rows.filter(function (r) {
        if (view.status !== 'all' && r.status !== view.status) return false;
        if (view.course === 'none' && r.active > 0) return false;
        if (cid && !r.activeIds.has(cid)) return false;
        if (!q) return true;
        if (r.hay.indexOf(q) !== -1) return true;
        return digits.length >= 3 && r.phoneDigits.indexOf(digits) !== -1;
      });
      const f = CMP[view.sort] || CMP.joined;
      const sgn = view.dir === 'asc' ? 1 : -1;
      out.sort(function (a, b) { return (f(a, b) * sgn) || CMP.name(a, b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); });
      return out;
    }

    /* التصدير يشمل كل الصفوف المطابقة للتصفية (لا الصفحة الحالية فقط) */
    function exportCsv() {
      const list = filtered();
      if (!list.length) { A.toast('info', 'لا توجد صفوف مطابقة للتصدير.'); return; }
      const titles = function (r, active) { return r.courses.filter(function (c) { return c.active === active; }).map(function (c) { return c.title; }).join(' | '); };
      const head = ['الاسم', 'البريد الإلكتروني', 'الهاتف', 'الدولة', 'حالة الحساب', 'عدد الدورات النشطة', 'الدورات النشطة', 'الدورات الملغاة', 'تاريخ التسجيل', 'آخر تسجيل دخول'];
      const lines = [head].concat(list.map(function (r) {
        return [r.name, r.email, r.phone, r.country, (A.statusMap.profile[r.status] || [r.status])[0], r.active, titles(r, true), titles(r, false), stamp(r.joined), stamp(r.seen)];
      })).map(function (line) { return line.map(guard); });
      A.download('subscribers-' + stamp(new Date().toISOString()).slice(0, 10) + '.csv', A.csvBuild(lines), 'text/csv');
      A.toast('ok', 'تم تصدير ملف CSV (عدد المتدربين: ' + A.num(list.length) + ').');
    }

    function build() {
      A.clear(body);
      const st = stats();
      body.appendChild(h('div', { class: 'ad-stats' },
        statCard('إجمالي المتدربين', st.total, 'كل الحسابات بدور متدرب'),
        statCard('لديهم دورات نشطة', st.withCourses, 'اشتراك نشط واحد على الأقل'),
        statCard('بلا دورات نشطة', st.without, 'سجّلوا ولا اشتراك نشط لهم'),
        statCard('الحسابات النشطة', st.active, 'حالة الحساب «نشط»'),
        statCard('جدد خلال ٣٠ يومًا', st.new30, 'سجّلوا حسابًا في آخر ٣٠ يومًا'),
        statCard('دخلوا خلال ٣٠ يومًا', st.seen30, 'آخر تسجيل دخول خلال ٣٠ يومًا')));
      if (!rows.length) {
        csvBtn.disabled = true;
        body.appendChild(A.empty('لا يوجد متدربون بعد', 'سيظهر هنا كل من يسجّل حسابًا جديدًا في المنصة.'));
        return;
      }
      const search = A.input({ type: 'search', max: 120, auto: 'off', placeholder: 'اسم، بريد أو هاتف' });
      search.value = view.q;
      const opts = courseOptions();
      if (!opts.some(function (o) { return o[0] === view.course; })) view.course = 'all'; /* دورة لم تعد في التقرير بعد التحديث */
      const courseSel = A.select(opts, view.course);
      const statusSel = A.select([['all', 'كل الحالات'], ['active', 'نشط'], ['suspended', 'موقوف']], view.status);
      const count = h('p', { class: 'ad-count-t', role: 'status' });
      const tableBox = h('div', { class: 'ad-sbt' });

      function paint(focusKey) {
        const list = filtered();
        const total = list.length;
        const pages = Math.max(1, Math.ceil(total / PAGE));
        if (view.page > pages) view.page = pages;
        A.clear(tableBox);
        csvBtn.disabled = !total;
        count.textContent = total ? 'عدد النتائج: ' + A.num(total) + ' من ' + A.num(rows.length) : 'لا نتائج مطابقة.';
        if (!total) {
          tableBox.appendChild(A.empty('لا نتائج مطابقة', 'جرّب كلمة بحث أخرى أو غيّر تصفية الدورة أو حالة الحساب.'));
          return;
        }
        tableBox.appendChild(A.dataTable(COLS, list.slice((view.page - 1) * PAGE, view.page * PAGE), {
          caption: 'تقرير المشتركين', sort: { key: view.sort, dir: view.dir },
          onSort: function (key) {
            if (view.sort === key) view.dir = view.dir === 'asc' ? 'desc' : 'asc'; else { view.sort = key; view.dir = key === 'name' ? 'asc' : 'desc'; }
            view.page = 1;
            paint(key);
          }
        }));
        const pg = A.pager(total, view.page, PAGE, function (n) {
          view.page = n;
          paint();
          const t = tableBox.querySelector('.ad-tablewrap');
          if (t) { t.setAttribute('tabindex', '-1'); t.focus({ preventScroll: false }); }
        });
        if (pg) tableBox.appendChild(pg);
        if (focusKey) { const b = tableBox.querySelector('.ad-sort[data-key="' + focusKey + '"]'); if (b) b.focus(); }
      }

      search.addEventListener('input', A.debounce(function () { view.q = search.value; view.page = 1; paint(); }, 160));
      courseSel.addEventListener('change', function () { view.course = courseSel.value; view.page = 1; paint(); });
      statusSel.addEventListener('change', function () { view.status = statusSel.value; view.page = 1; paint(); });
      body.appendChild(h('div', { class: 'ad-tools' }, A.field('بحث', search), A.field('الدورة', courseSel), A.field('حالة الحساب', statusSel, null, 'sm'), count));
      body.appendChild(h('p', { class: 'ad-sub', text: 'تصفية الدورة تعرض المشتركين النشطين فيها فقط. الدورة التي أُلغي اشتراكها تظهر بجوار المتدرب بعبارة «ملغى».' }));
      body.appendChild(tableBox);
      paint();
    }

    async function load() {
      A.clear(body);
      body.appendChild(A.loading('جارٍ تحميل تقرير المشتركين…'));
      refresh.disabled = true;
      csvBtn.disabled = true;
      let data;
      try { data = await fetchAll(); } catch (err) {
        refresh.disabled = false;
        if (A.stale(token)) return;
        if (A.isSession(err)) { A.lost('expired'); return; }
        A.clear(body);
        if (A.isForbidden(err)) {
          A.hooks.forbidden();
          body.appendChild(A.fail('ليست لديك صلاحية لعرض تقرير المشتركين. هذا القسم للمدرب فقط.'));
        } else if (err instanceof P.ApiError && err.kind === 'notfound') {
          body.appendChild(A.fail('تقرير المشتركين غير متاح الآن: يلزم تطبيق الملف supabase/migrations/007_interest_messages_and_subscribers_report.sql على قاعدة البيانات.', load));
        } else body.appendChild(A.fail(A.errText(err), load));
        return;
      }
      refresh.disabled = false;
      if (A.stale(token)) return;
      rows = data.map(normalize);
      build();
    }

    refresh.addEventListener('click', load);
    csvBtn.addEventListener('click', function () { if (rows.length) exportCsv(); });
    await load();
  }

  A.register('subscribers', { label: 'المشتركون', render: render });
})();
