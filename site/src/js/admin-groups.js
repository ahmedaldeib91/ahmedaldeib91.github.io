/* =====================================================================
   admin-groups.js — تبويب «المجموعات» في مركز الدورة (#courses/<id>/groups[/<groupId>[/<قسم>]]) (للمدير)
   مجموعات تدريبية لكل دورة على حدة: المجموعات، المتدربون (من مشتركي الدورة النشطين فقط)، الجلسات (مع إنشاء متكرر)،
   الحضور (حاضر/متأخر/غائب/بعذر)، التقييم القبلي والبعدي (درجات بالنسبة المئوية + ربط اختياري باختبار من الدورة)، والتقارير مع تصدير CSV.
   كل البيانات من جداول grp_* (الترحيل 013) عبر REST بسياسات RLS للمدير وحده؛ والحدود (سعة المجموعة، اشتراك المتدرب، تطابق الدورة)
   تفرضها القاعدة. كل نص من القاعدة أو المستخدم يدخل الصفحة بـ textContent.
   نسبة الحضور = (حاضر + متأخر) ÷ (الجلسات المعقودة − جلسات الإعذار). تقدّم المتدرب = البعدي − القبلي.
   ===================================================================== */
(function () {
  'use strict';

  const A = window.Admin;
  if (!A) return;
  const P = A.P;
  const h = A.h;
  const ui = A.ui;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const G_STATUS = [['planned', 'مخططة'], ['active', 'جارية'], ['completed', 'مكتملة'], ['cancelled', 'ملغاة']];
  const G_KIND = { planned: 'info', active: 'ok', completed: 'mut', cancelled: 'err' };
  const MODE = [['online', 'عن بُعد'], ['in_person', 'حضوري'], ['hybrid', 'مدمج']];
  const M_STATUS = [['active', 'نشط'], ['dropped', 'منسحب'], ['completed', 'أنهى']];
  const S_STATUS = [['scheduled', 'مجدولة'], ['held', 'عُقدت'], ['cancelled', 'أُلغيت']];
  const ATT = [['present', 'حاضر'], ['late', 'متأخر'], ['absent', 'غائب'], ['excused', 'بعذر']];
  const SECTIONS = [['overview', 'نظرة عامة'], ['members', 'المتدربون'], ['sessions', 'الجلسات'], ['attendance', 'الحضور'], ['assess', 'التقييم القبلي والبعدي'], ['reports', 'التقارير']];

  const lbl = function (list, v) { for (let i = 0; i < list.length; i++) if (list[i][0] === v) return list[i][1]; return String(v == null ? '' : v); };
  const nz = function (s) { s = String(s == null ? '' : s).trim(); return s || null; };
  const pad = function (n) { return n < 10 ? '0' + n : String(n); };
  const toLocal = function (iso) { if (!iso) return ''; const d = new Date(iso); return isNaN(d) ? '' : d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()); };
  const fromLocal = function (v) { if (!v) return null; const d = new Date(v); return isNaN(d) ? undefined : d.toISOString(); };
  const intOr = function (v) { const s = String(v == null ? '' : v).trim(); if (!s) return null; const n = Number(s); return Number.isInteger(n) ? n : NaN; };
  const pctOr = function (v) { const s = String(v == null ? '' : v).trim().replace(',', '.'); if (!s) return null; const n = Number(s); return Number.isFinite(n) ? n : NaN; };
  const r1 = function (n) { return Math.round(n * 10) / 10; };
  const nameOf = function (dir, id) { const p = dir.byId[id]; return p && p.full_name ? p.full_name : 'بدون اسم'; };
  const emailOf = function (dir, id) { return dir.emails && dir.emails[id] ? dir.emails[id].email : ''; };

  /* أخطاء القاعدة بحسب السياق (نص الخادم لا يصل للواجهة) */
  function errMsg(err, ctx) {
    if (!(err instanceof P.ApiError)) return P.MSG.other;
    const c = err.code || '';
    if (err.kind === 'network' || err.kind === 'config' || err.kind === 'server') return err.message;
    if (c === '42501' || err.kind === 'forbidden') return P.MSG.forbidden;
    if (c === '23505') return ctx === 'group' ? 'يوجد مجموعة بالاسم نفسه في هذه الدورة. اختر اسمًا مختلفًا.' : 'هذا العنصر موجود مسبقًا.';
    if (c === '23514') {
      if (ctx === 'member') return 'تعذّرت الإضافة: تأكد أن المتدرب مشترك نشط في هذه الدورة وأن سعة المجموعة لم تكتمل.';
      if (ctx === 'group') return 'قيمة غير صالحة: تاريخ النهاية قبل البداية، أو السعة خارج ١–١٠٠٠.';
      if (ctx === 'session') return 'قيمة غير صالحة: المدة من ٥ إلى ١٤٤٠ دقيقة.';
      if (ctx === 'score') return 'الدرجة يجب أن تكون من ٠ إلى ١٠٠.';
      return 'قيمة خارج الحدود المسموحة.';
    }
    if (c === '23503' || c === '23001') return 'العنصر المرتبط لم يعد موجودًا. حدّث الصفحة ثم أعد المحاولة.';
    return err.message || P.MSG.other;
  }
  function run(btn, out, ctx, fn) {
    return A.run(btn, out, async function (e) {
      try { await fn(e); } catch (err) {
        if (A.isSession(err)) { A.lost('expired'); return; }
        ui.msg(out, 'err', errMsg(err, ctx));
      }
    });
  }

  async function loadAll(course) {
    const r = await Promise.all([
      P.rest.select('grp_groups', { select: '*', course_id: 'eq.' + course, order: 'created_at.desc', limit: '500' }),
      A.all('grp_members', { select: '*', course_id: 'eq.' + course, order: 'group_id.asc,joined_at.asc,user_id.asc' }),
      A.all('grp_sessions', { select: '*', course_id: 'eq.' + course, order: 'starts_at.asc,id.asc' }),
      A.all('grp_assessments', { select: '*', course_id: 'eq.' + course, order: 'group_id.asc,kind.asc' }),
      A.loadDirectory(),
      A.loadCourses()
    ]);
    const D = { groups: r[0], members: r[1], sessions: r[2], assess: r[3], dir: r[4], attendance: [], exams: null };
    if (D.groups.length) {
      D.attendance = await A.all('grp_attendance', { select: 'session_id,group_id,user_id,status,note', group_id: 'in.(' + D.groups.map(function (g) { return g.id; }).join(',') + ')', order: 'session_id.asc,user_id.asc' });
    }
    return D;
  }

  /* إحصاءات مجموعة: حضور كل متدرب ومتوسطات */
  function stats(D, g) {
    const members = D.members.filter(function (m) { return m.group_id === g.id; });
    const held = D.sessions.filter(function (s) { return s.group_id === g.id && s.status === 'held'; });
    const heldIds = {};
    held.forEach(function (s) { heldIds[s.id] = true; });
    const per = {};
    members.forEach(function (m) { per[m.user_id] = { present: 0, late: 0, absent: 0, excused: 0 }; });
    D.attendance.forEach(function (a) { if (a.group_id === g.id && heldIds[a.session_id] && per[a.user_id]) per[a.user_id][a.status] += 1; });
    const rows = members.map(function (m) {
      const c = per[m.user_id];
      const den = held.length - c.excused;
      const rate = den > 0 ? ((c.present + c.late) / den) * 100 : null;
      const gain = m.pre_score != null && m.post_score != null ? Number(m.post_score) - Number(m.pre_score) : null;
      return { m: m, c: c, rate: rate, gain: gain };
    });
    const avg = function (xs) { const v = xs.filter(function (x) { return x != null; }); return v.length ? v.reduce(function (a, b) { return a + b; }, 0) / v.length : null; };
    return {
      members: members, held: held, rows: rows,
      rate: avg(rows.filter(function (r) { return r.m.status !== 'dropped'; }).map(function (r) { return r.rate; })),
      pre: avg(members.map(function (m) { return m.pre_score == null ? null : Number(m.pre_score); })),
      post: avg(members.map(function (m) { return m.post_score == null ? null : Number(m.post_score); })),
      gain: avg(rows.map(function (r) { return r.gain; }))
    };
  }

  /* ================================================================== العرض */
  async function render(panel, course, token, o) {
    o = o || {};
    const secName = String(o.section || '').split('?')[0]; /* قد يحمل الرابط ?s=<جلسة> */
    const cur = { group: UUID.test(o.group || '') ? o.group : '', section: SECTIONS.some(function (s) { return s[0] === secName; }) ? secName : 'overview' };
    const base = '#courses/' + encodeURIComponent(course) + '/groups';
    A.clear(panel);
    panel.appendChild(A.loading('جارٍ تحميل المجموعات…'));
    let D;
    try { D = await loadAll(course); } catch (err) {
      if (A.stale(token)) return;
      if (A.isSession(err)) { A.lost('expired'); return; }
      A.clear(panel);
      panel.appendChild(A.fail(A.errText(err), function () { render(panel, course, token, o); }));
      return;
    }
    if (A.stale(token)) return;
    const reload = function () { return render(panel, course, token, { group: cur.group, section: cur.section }); };
    A.clear(panel);
    const g = cur.group ? D.groups.filter(function (x) { return x.id === cur.group; })[0] : null;
    if (cur.group && !g) {
      panel.appendChild(A.empty('المجموعة غير موجودة', 'لم نجد هذه المجموعة في هذه الدورة.', A.link('كل المجموعات', base, { kind: 'p', icon: 'back' })));
      return;
    }
    if (g) groupPage(panel, course, token, D, g, cur, base, reload); else listPage(panel, course, token, D, base, reload);
  }

  /* ---------- قائمة المجموعات ---------- */
  function listPage(panel, course, token, D, base, reload) {
    const out = A.msgBox();
    const fStatus = A.select([['all', 'كل الحالات']].concat(G_STATUS), 'all');
    const formBox = h('div');
    const table = h('div');
    const add = A.btn('مجموعة جديدة', { kind: 'p', small: true, icon: 'plus' });
    add.addEventListener('click', function () { A.clear(formBox); formBox.appendChild(groupForm(course, D, null, function () { A.clear(formBox); }, reload)); });
    panel.appendChild(h('div', { class: 'ad-qb-bar' }, add, A.btn('تحديث', { small: true, icon: 'refresh', on: reload })));
    panel.appendChild(h('div', { class: 'ad-tools' }, A.field('الحالة', fStatus, null, 'sm'), h('p', { class: 'ad-count-t', role: 'status', text: 'عدد المجموعات: ' + A.num(D.groups.length) })));
    panel.appendChild(out);
    panel.appendChild(formBox);
    panel.appendChild(table);
    function paint() {
      A.clear(table);
      const rows = D.groups.filter(function (g) { return fStatus.value === 'all' || g.status === fStatus.value; });
      if (!rows.length) { table.appendChild(A.empty('لا توجد مجموعات', D.groups.length ? 'غيّر التصفية.' : 'أنشئ أول مجموعة لهذه الدورة: عدّ فيها المتدربين وجدول الجلسات والحضور والتقييم.')); return; }
      table.appendChild(A.dataTable([
        { label: 'المجموعة', cls: 'ad-first', cell: function (g) { return h('div', null, h('a', { class: 'ad-name', href: base + '/' + g.id + '/overview', text: g.name }), g.start_date ? h('small', { text: A.fmtDay(g.start_date) + (g.end_date ? ' → ' + A.fmtDay(g.end_date) : '') }) : null); } },
        { label: 'الحالة', cell: function (g) { return A.badge(lbl(G_STATUS, g.status), G_KIND[g.status]); } },
        { label: 'النمط', cls: 'hide-md', cell: function (g) { return lbl(MODE, g.mode); } },
        { label: 'المتدربون', cell: function (g) { const n = D.members.filter(function (m) { return m.group_id === g.id && m.status === 'active'; }).length; return A.num(n) + (g.capacity ? ' / ' + A.num(g.capacity) : ''); } },
        { label: 'الجلسات', cell: function (g) { const s = D.sessions.filter(function (x) { return x.group_id === g.id; }); return A.num(s.filter(function (x) { return x.status === 'held'; }).length) + ' / ' + A.num(s.length); } },
        { label: 'الحضور', cell: function (g) { const st = stats(D, g); return st.rate == null ? '—' : r1(st.rate) + '%'; } },
        { label: 'المدرب', cls: 'hide-md', cell: function (g) { return g.instructor_id ? nameOf(D.dir, g.instructor_id) : '—'; } },
        { label: '', cls: 'ad-actcol', cell: function (g) { return A.link('فتح', base + '/' + g.id + '/overview', { small: true }); } }
      ], rows, { caption: 'مجموعات الدورة' }));
    }
    fStatus.addEventListener('change', paint);
    paint();
  }

  /* ---------- نموذج مجموعة (جديدة/تعديل) ---------- */
  function groupForm(course, D, g, onCancel, reload) {
    const f = {};
    f.name = A.input({ max: 120, value: g ? g.name : '', aria: 'اسم المجموعة' });
    f.status = A.select(G_STATUS, g ? g.status : 'planned');
    f.mode = A.select(MODE, g ? g.mode : 'online');
    f.location = A.input({ max: 500, value: g && g.location || '', placeholder: 'القاعة أو رابط الاجتماع' });
    f.start = A.input({ type: 'date', value: g && g.start_date || '' });
    f.end = A.input({ type: 'date', value: g && g.end_date || '' });
    f.cap = A.input({ type: 'number', min: 1, maxv: 1000, step: 1, inputmode: 'numeric', value: g && g.capacity || '' });
    const admins = D.dir.profiles.filter(function (p) { return p.role === 'admin'; });
    f.inst = A.select([['', '— بلا —']].concat(admins.map(function (p) { return [p.id, nameOf(D.dir, p.id)]; })), g && g.instructor_id || '');
    f.sched = A.input({ max: 1000, value: g && g.schedule_note || '', placeholder: 'مثال: الأحد والثلاثاء ٨ مساءً' });
    f.desc = A.textarea({ rows: 3, max: 2000, value: g && g.description || '' });
    const out = A.msgBox();
    const save = A.btn(g ? 'حفظ التعديلات' : 'إنشاء المجموعة', { kind: 'p', small: true, type: 'submit' });
    const kids = [
      h('div', { class: 'ad-tools' }, A.field('اسم المجموعة *', f.name), A.field('الحالة', f.status, null, 'sm'), A.field('النمط', f.mode, null, 'sm')),
      h('div', { class: 'ad-tools' }, A.field('المكان / الرابط', f.location), A.field('البداية', f.start, null, 'sm'), A.field('النهاية', f.end, null, 'sm'), A.field('السعة', f.cap, 'فارغ = بلا حد.', 'sm')),
      h('div', { class: 'ad-tools' }, A.field('المدرب', f.inst), A.field('جدول الانعقاد', f.sched)),
      A.field('وصف', f.desc),
      h('div', { class: 'ad-act' }, save, g ? null : A.btn('إلغاء', { small: true, on: onCancel }), out)
    ];
    const form = h('form', { class: 'pf-form', novalidate: true, method: 'post', action: '/admin/' }, kids);
    form.addEventListener('submit', run(save, out, 'group', async function () {
      ui.clearMsg(out);
      const name = f.name.value.trim();
      if (!name) { ui.msg(out, 'err', 'اسم المجموعة مطلوب.'); f.name.focus(); return; }
      const cap = intOr(f.cap.value);
      if (Number.isNaN(cap) || (cap !== null && (cap < 1 || cap > 1000))) { ui.msg(out, 'err', 'السعة عدد صحيح من ١ إلى ١٠٠٠.'); return; }
      if (f.start.value && f.end.value && f.end.value < f.start.value) { ui.msg(out, 'err', 'تاريخ النهاية قبل البداية.'); return; }
      const row = { name: name, status: f.status.value, mode: f.mode.value, location: nz(f.location.value), start_date: f.start.value || null, end_date: f.end.value || null,
        capacity: cap, instructor_id: f.inst.value || null, schedule_note: nz(f.sched.value), description: nz(f.desc.value) };
      let rows;
      if (g) rows = await P.rest.update('grp_groups', { id: 'eq.' + g.id, course_id: 'eq.' + course }, row);
      else rows = await P.rest.insert('grp_groups', Object.assign({ course_id: course }, row));
      if (!rows.length) throw A.noRows();
      A.toast('ok', g ? 'حُفظت المجموعة.' : 'أُنشئت المجموعة.');
      if (!g) { window.location.hash = '#courses/' + encodeURIComponent(course) + '/groups/' + rows[0].id + '/members'; return; }
      await reload();
    }));
    return A.card(g ? 'بيانات المجموعة' : 'مجموعة جديدة', form);
  }

  /* ---------- صفحة المجموعة ---------- */
  function groupPage(panel, course, token, D, g, cur, base, reload) {
    const st = stats(D, g);
    panel.appendChild(h('div', { class: 'ad-crumb' }, A.link('كل المجموعات', base, { icon: 'back', small: true })));
    panel.appendChild(A.head(g.name, [lbl(MODE, g.mode), g.start_date ? A.fmtDay(g.start_date) + (g.end_date ? ' → ' + A.fmtDay(g.end_date) : '') : ''].filter(Boolean).join(' · '),
      [A.badge(lbl(G_STATUS, g.status), G_KIND[g.status]), A.badge(A.num(st.members.filter(function (m) { return m.status === 'active'; }).length) + (g.capacity ? ' / ' + A.num(g.capacity) : '') + ' متدرب', 'info')]));
    const tabsEl = h('div', { class: 'pf-tabs ad-tabbar', role: 'tablist', 'aria-label': 'أقسام المجموعة' },
      SECTIONS.map(function (s) { return h('button', { type: 'button', role: 'tab', id: 'gtab-' + s[0], 'data-tab': s[0], 'aria-controls': 'gpanel-' + s[0], 'aria-selected': 'false', tabindex: '-1', text: s[1] }); }));
    panel.appendChild(tabsEl);
    const builders = {
      overview: function () { return overview(course, D, g, st, base, reload); },
      members: function () { return membersSection(course, D, g, st, reload); },
      sessions: function () { return sessionsSection(course, D, g, st, reload, base); },
      attendance: function () { return attendanceSection(course, D, g, st, reload, cur); },
      assess: function () { return assessSection(course, D, g, st, reload); },
      reports: function () { return reportsSection(D, g, st); }
    };
    const boxes = {};
    SECTIONS.forEach(function (s) { boxes[s[0]] = h('div', { role: 'tabpanel', id: 'gpanel-' + s[0], 'aria-labelledby': 'gtab-' + s[0], hidden: true }); panel.appendChild(boxes[s[0]]); });
    const built = {};
    const ctl = ui.tabs(tabsEl, {
      onSelect: function (name) {
        cur.section = name;
        try { window.history.replaceState(null, '', base + '/' + g.id + '/' + name); } catch (e) { /* تجاهل */ }
        if (built[name]) return;
        built[name] = true;
        boxes[name].appendChild(builders[name]());
      }
    });
    ctl.select(cur.section, false);
  }

  function overview(course, D, g, st, base, reload) {
    const box = h('div');
    box.appendChild(h('div', { class: 'ad-grid' },
      kpi('المتدربون النشطون', A.num(st.members.filter(function (m) { return m.status === 'active'; }).length) + (g.capacity ? ' من ' + A.num(g.capacity) : '')),
      kpi('الجلسات المعقودة', A.num(st.held.length) + ' من ' + A.num(D.sessions.filter(function (s) { return s.group_id === g.id; }).length)),
      kpi('متوسط الحضور', st.rate == null ? '—' : r1(st.rate) + '%'),
      kpi('متوسط التقدّم (بعدي − قبلي)', st.gain == null ? '—' : (st.gain > 0 ? '+' : '') + r1(st.gain) + ' نقطة')));
    box.appendChild(groupForm(course, D, g, null, reload));
    const out = A.msgBox();
    const del = A.btn('حذف المجموعة', { small: true, kind: 'danger', icon: 'trash' });
    del.addEventListener('click', run(del, out, 'group', async function () {
      ui.clearMsg(out);
      const ok = await A.confirm({ title: 'حذف المجموعة «' + g.name + '»؟', message: 'ستُحذف معها كل جلساتها وسجلات حضورها ودرجات تقييمها، ولا يمكن استرجاعها.', detail: 'لا يتأثر اشتراك المتدربين في الدورة.', ok: 'حذف نهائيًا', danger: true });
      if (!ok) return;
      const rows = await P.rest.remove('grp_groups', { id: 'eq.' + g.id, course_id: 'eq.' + course });
      if (!rows.length) throw A.noRows();
      A.toast('ok', 'حُذفت المجموعة.');
      window.location.hash = base;
    }));
    box.appendChild(A.card('إجراءات خطرة', [h('div', { class: 'ad-act' }, del, out)]));
    return box;
  }
  const kpi = function (title, value) { return h('article', { class: 'pf-card ad-ccard' }, h('h3', { text: title }), h('p', { class: 'ad-kpi', text: value })); };

  /* ---------- المتدربون ---------- */
  function membersSection(course, D, g, st, reload) {
    const box = h('div');
    const out = A.msgBox();
    const dir = D.dir;
    const inGroup = {};
    st.members.forEach(function (m) { inGroup[m.user_id] = true; });
    /* إضافة: مشتركو الدورة النشطون غير الموجودين في المجموعة */
    const enrolled = dir.enrollments.filter(function (e) { return e.course_id === course && e.status === 'active' && dir.byId[e.user_id] && dir.byId[e.user_id].role === 'trainee' && !inGroup[e.user_id]; })
      .map(function (e) { return dir.byId[e.user_id]; });
    enrolled.sort(function (a, b) { return String(a.full_name || '').localeCompare(String(b.full_name || ''), 'ar'); });
    const sel = new Set();
    const search = A.input({ type: 'search', max: 120, placeholder: 'ابحث في مشتركي الدورة (اسم أو بريد أو هاتف)' });
    const list = h('ul', { class: 'ad-picks', 'aria-label': 'مشتركو الدورة' });
    const info = h('p', { class: 'ad-count-t', role: 'status' });
    const addBtn = A.btn('إضافة المحدّدين للمجموعة', { kind: 'p', small: true, icon: 'plus', disabled: true });
    function paintPick() {
      A.clear(list);
      const q = A.normAr(search.value);
      const rows = enrolled.filter(function (p) { return !q || A.normAr([p.full_name, emailOf(dir, p.id), p.phone].join(' ')).indexOf(q) !== -1; }).slice(0, 30);
      if (!rows.length) list.appendChild(h('li', null, A.empty('لا نتائج', enrolled.length ? 'لا يطابق بحثك أحد.' : 'لا يوجد مشتركون نشطون خارج هذه المجموعة. أضف اشتراكات من تبويب «الاشتراكات» أولًا.')));
      rows.forEach(function (p) {
        const cb = h('input', { type: 'checkbox', 'aria-label': 'تحديد ' + nameOf(dir, p.id) });
        cb.checked = sel.has(p.id);
        cb.addEventListener('change', function () { if (cb.checked) sel.add(p.id); else sel.delete(p.id); sync(); });
        list.appendChild(h('li', null, h('label', { class: 'ad-pick' }, cb, h('span', { class: 'ad-pt' }, h('b', { text: nameOf(dir, p.id) }), h('small', { class: 'ad-ltr', text: [emailOf(dir, p.id), p.phone].filter(Boolean).join('  ·  ') || '—' })))));
      });
      sync();
    }
    function sync() { info.textContent = sel.size ? 'المحدّد: ' + sel.size : 'لم تحدّد أحدًا.'; addBtn.disabled = !sel.size; }
    search.addEventListener('input', A.debounce(paintPick, 160));
    addBtn.addEventListener('click', run(addBtn, out, 'member', async function () {
      ui.clearMsg(out);
      const rows = Array.from(sel).map(function (id) { return { group_id: g.id, course_id: course, user_id: id }; });
      await P.rest.insert('grp_members', rows);
      A.toast('ok', 'أُضيف ' + rows.length + ' متدربًا إلى المجموعة.');
      await reload();
    }));
    box.appendChild(A.card('إضافة متدربين', [
      h('p', { class: 'ad-sub', text: 'يظهر هنا مشتركو هذه الدورة النشطون فقط. لا تتجاوز الإضافة سعة المجموعة.' }),
      h('div', { class: 'ad-tools' }, A.field('بحث', search)), list, h('div', { class: 'ad-act' }, addBtn, info)]));
    box.appendChild(out);
    /* جدول الأعضاء */
    if (!st.members.length) box.appendChild(A.empty('لا متدربين في المجموعة بعد', 'أضف متدربين من البطاقة أعلاه.'));
    else {
      box.appendChild(A.card('متدربو المجموعة (' + A.num(st.members.length) + ')', A.dataTable([
        { label: 'المتدرب', cls: 'ad-first', cell: function (m) { return h('div', null, h('a', { class: 'ad-name', href: '#trainees/' + m.user_id, text: nameOf(dir, m.user_id) }), emailOf(dir, m.user_id) ? h('small', { class: 'ad-ltr', text: emailOf(dir, m.user_id) }) : null); } },
        { label: 'الحالة', cell: function (m) {
          const s = A.select(M_STATUS, m.status, { aria: 'حالة ' + nameOf(dir, m.user_id) });
          s.addEventListener('change', run(s, out, 'member', async function () {
            ui.clearMsg(out);
            const rows = await P.rest.update('grp_members', { group_id: 'eq.' + g.id, user_id: 'eq.' + m.user_id }, { status: s.value });
            if (!rows.length) throw A.noRows();
            A.toast('ok', 'تحدّثت الحالة.');
            await reload();
          }));
          return s;
        } },
        { label: 'ملاحظة', cls: 'hide-md', cell: function (m) {
          const n = A.input({ max: 2000, value: m.note || '', aria: 'ملاحظة ' + nameOf(dir, m.user_id), placeholder: 'ملاحظة…' });
          n.setAttribute('dir', 'auto');
          n.addEventListener('change', run(n, out, 'member', async function () {
            const rows = await P.rest.update('grp_members', { group_id: 'eq.' + g.id, user_id: 'eq.' + m.user_id }, { note: nz(n.value) });
            if (!rows.length) throw A.noRows();
            m.note = nz(n.value);
            A.toast('ok', 'حُفظت الملاحظة.');
          }));
          return n;
        } },
        { label: '', cls: 'ad-actcol', cell: function (m) {
          const b = A.btn('إزالة', { small: true, kind: 'danger' });
          b.addEventListener('click', run(b, out, 'member', async function () {
            const ok = await A.confirm({ title: 'إزالة «' + nameOf(dir, m.user_id) + '» من المجموعة؟', message: 'ستُحذف سجلات حضوره ودرجاته في هذه المجموعة. لا يتأثر اشتراكه في الدورة.', ok: 'إزالة', danger: true });
            if (!ok) return;
            const rows = await P.rest.remove('grp_members', { group_id: 'eq.' + g.id, user_id: 'eq.' + m.user_id });
            if (!rows.length) throw A.noRows();
            A.toast('ok', 'أُزيل من المجموعة.');
            await reload();
          }));
          return b;
        } }
      ], st.members, { caption: 'متدربو المجموعة' })));
    }
    paintPick();
    return box;
  }

  /* ---------- الجلسات ---------- */
  function sessionsSection(course, D, g, st, reload, base) {
    const box = h('div');
    const out = A.msgBox();
    const sessions = D.sessions.filter(function (s) { return s.group_id === g.id; });
    const formBox = h('div');
    const counts = function (s) {
      const c = { present: 0, late: 0, absent: 0, excused: 0 };
      D.attendance.forEach(function (a) { if (a.session_id === s.id) c[a.status] += 1; });
      return c;
    };
    function sessionForm(s) {
      const title = A.input({ max: 200, value: s ? s.title : '', aria: 'عنوان الجلسة' });
      const when = A.input({ type: 'datetime-local', value: s ? toLocal(s.starts_at) : '' });
      const dur = A.input({ type: 'number', min: 5, maxv: 1440, step: 1, inputmode: 'numeric', value: s ? s.duration_minutes : 60 });
      const mode = A.select(MODE, s ? s.mode : (g.mode || 'online'));
      const loc = A.input({ max: 500, value: s && s.location || g.location || '', placeholder: 'القاعة أو الرابط' });
      const notes = A.textarea({ rows: 2, max: 2000, value: s && s.notes || '' });
      const o2 = A.msgBox();
      const save = A.btn(s ? 'حفظ الجلسة' : 'إضافة الجلسة', { kind: 'p', small: true, type: 'submit' });
      const form = h('form', { class: 'pf-form', novalidate: true, method: 'post', action: '/admin/' },
        h('div', { class: 'ad-tools' }, A.field('العنوان *', title), A.field('الموعد *', when), A.field('المدة (دقيقة)', dur, null, 'sm'), A.field('النمط', mode, null, 'sm')),
        h('div', { class: 'ad-tools' }, A.field('المكان / الرابط', loc), A.field('ملاحظات', notes)),
        h('div', { class: 'ad-act' }, save, A.btn('إلغاء', { small: true, on: function () { A.clear(formBox); } }), o2));
      form.addEventListener('submit', run(save, o2, 'session', async function () {
        ui.clearMsg(o2);
        const at = fromLocal(when.value);
        const d = intOr(dur.value);
        if (!title.value.trim()) { ui.msg(o2, 'err', 'عنوان الجلسة مطلوب.'); return; }
        if (!at) { ui.msg(o2, 'err', 'حدّد موعد الجلسة.'); return; }
        if (d === null || Number.isNaN(d) || d < 5 || d > 1440) { ui.msg(o2, 'err', 'المدة من ٥ إلى ١٤٤٠ دقيقة.'); return; }
        const row = { title: title.value.trim(), starts_at: at, duration_minutes: d, mode: mode.value, location: nz(loc.value), notes: nz(notes.value) };
        const rows = s ? await P.rest.update('grp_sessions', { id: 'eq.' + s.id, group_id: 'eq.' + g.id }, row) : await P.rest.insert('grp_sessions', Object.assign({ group_id: g.id, course_id: course }, row));
        if (!rows.length) throw A.noRows();
        A.toast('ok', s ? 'حُفظت الجلسة.' : 'أُضيفت الجلسة.');
        await reload();
      }));
      return A.card(s ? 'تعديل الجلسة' : 'جلسة جديدة', form);
    }
    function repeatForm() {
      const title = A.input({ max: 190, value: 'الجلسة', aria: 'بادئة العنوان' });
      const when = A.input({ type: 'datetime-local' });
      const count = A.input({ type: 'number', min: 1, maxv: 30, step: 1, value: 8 });
      const every = A.input({ type: 'number', min: 1, maxv: 30, step: 1, value: 7 });
      const dur = A.input({ type: 'number', min: 5, maxv: 1440, step: 1, value: 60 });
      const o2 = A.msgBox();
      const go = A.btn('إنشاء الجلسات', { kind: 'p', small: true, type: 'submit' });
      const form = h('form', { class: 'pf-form', novalidate: true, method: 'post', action: '/admin/' },
        h('div', { class: 'ad-tools' }, A.field('بادئة العنوان', title, 'يُرقَّم تلقائيًا: «الجلسة ١»، «الجلسة ٢»…'), A.field('موعد الأولى *', when), A.field('عدد الجلسات', count, '١–٣٠', 'sm'), A.field('كل كم يوم', every, '١–٣٠', 'sm'), A.field('المدة (دقيقة)', dur, null, 'sm')),
        h('div', { class: 'ad-act' }, go, A.btn('إلغاء', { small: true, on: function () { A.clear(formBox); } }), o2));
      form.addEventListener('submit', run(go, o2, 'session', async function () {
        ui.clearMsg(o2);
        const start = fromLocal(when.value);
        const n = intOr(count.value);
        const ev = intOr(every.value);
        const d = intOr(dur.value);
        if (!start) { ui.msg(o2, 'err', 'حدّد موعد أول جلسة.'); return; }
        if (!(n >= 1 && n <= 30) || !(ev >= 1 && ev <= 30) || !(d >= 5 && d <= 1440)) { ui.msg(o2, 'err', 'تحقق من العدد (١–٣٠) والتكرار (١–٣٠ يومًا) والمدة (٥–١٤٤٠ دقيقة).'); return; }
        const rows = [];
        for (let i = 0; i < n; i++) {
          const t = new Date(new Date(start).getTime() + i * ev * 86400000);
          rows.push({ group_id: g.id, course_id: course, title: (title.value.trim() || 'الجلسة') + ' ' + (sessions.length + i + 1), starts_at: t.toISOString(), duration_minutes: d, mode: g.mode, location: g.location });
        }
        await P.rest.insert('grp_sessions', rows);
        A.toast('ok', 'أُنشئت ' + n + ' جلسة.');
        await reload();
      }));
      return A.card('إنشاء جلسات متكررة', form);
    }
    box.appendChild(h('div', { class: 'ad-qb-bar' },
      A.btn('جلسة جديدة', { kind: 'p', small: true, icon: 'plus', on: function () { A.clear(formBox); formBox.appendChild(sessionForm(null)); } }),
      A.btn('جلسات متكررة', { small: true, icon: 'clock', on: function () { A.clear(formBox); formBox.appendChild(repeatForm()); } })));
    box.appendChild(out);
    box.appendChild(formBox);
    if (!sessions.length) box.appendChild(A.empty('لا جلسات بعد', 'أضف جلسة أو أنشئ جدولًا متكررًا.'));
    else {
      box.appendChild(A.dataTable([
        { label: 'الجلسة', cls: 'ad-first', cell: function (s) { return h('div', null, h('b', { text: s.title }), h('small', { text: A.fmtDate(s.starts_at) + ' · ' + A.num(s.duration_minutes) + ' د' })); } },
        { label: 'الحالة', cell: function (s) {
          const sel = A.select(S_STATUS, s.status, { aria: 'حالة الجلسة' });
          sel.addEventListener('change', run(sel, out, 'session', async function () {
            const rows = await P.rest.update('grp_sessions', { id: 'eq.' + s.id, group_id: 'eq.' + g.id }, { status: sel.value });
            if (!rows.length) throw A.noRows();
            A.toast('ok', 'تحدّثت حالة الجلسة.');
            await reload();
          }));
          return sel;
        } },
        { label: 'الحضور', cell: function (s) { const c = counts(s); const t = c.present + c.late + c.absent + c.excused; return t ? A.num(c.present + c.late) + ' من ' + A.num(t) : '—'; } },
        { label: '', cls: 'ad-actcol', cell: function (s) {
          const att = A.btn('الحضور', { small: true, kind: 'p' });
          att.addEventListener('click', function () { window.location.hash = base + '/' + g.id + '/attendance?s=' + s.id; });
          const ed = A.btn('تعديل', { small: true, on: function () { A.clear(formBox); formBox.appendChild(sessionForm(s)); formBox.scrollIntoView(); } });
          const del = A.ibtn('trash', 'حذف الجلسة', null, 'danger');
          del.addEventListener('click', run(del, out, 'session', async function () {
            const ok = await A.confirm({ title: 'حذف «' + s.title + '»؟', message: 'ستُحذف معها سجلات حضورها.', ok: 'حذف', danger: true });
            if (!ok) return;
            const rows = await P.rest.remove('grp_sessions', { id: 'eq.' + s.id, group_id: 'eq.' + g.id });
            if (!rows.length) throw A.noRows();
            A.toast('ok', 'حُذفت الجلسة.');
            await reload();
          }));
          return h('div', { class: 'ad-cell-act' }, att, ed, del);
        } }
      ], sessions, { caption: 'جلسات المجموعة' }));
    }
    return box;
  }

  /* ---------- الحضور ---------- */
  function attendanceSection(course, D, g, st, reload, cur) {
    const box = h('div');
    const out = A.msgBox();
    const sessions = D.sessions.filter(function (s) { return s.group_id === g.id && s.status !== 'cancelled'; });
    const members = st.members.filter(function (m) { return m.status === 'active'; });
    if (!sessions.length) return A.empty('لا جلسات لتسجيل الحضور', 'أضف جلسات من تبويب «الجلسات» أولًا.');
    if (!members.length) return A.empty('لا متدربين نشطين', 'أضف متدربين من تبويب «المتدربون» أولًا.');
    const m = /[?&]s=([0-9a-f-]{36})/i.exec(window.location.hash);
    let sid = m && sessions.some(function (s) { return s.id === m[1]; }) ? m[1] : (sessions.filter(function (s) { return s.status === 'scheduled' && Date.parse(s.starts_at) <= Date.now(); }).pop() || sessions[sessions.length - 1]).id;
    const pick = A.select(sessions.map(function (s) { return [s.id, s.title + ' — ' + A.fmtDate(s.starts_at)]; }), sid);
    const table = h('div');
    const markHeld = A.checkbox('علّم الجلسة «عُقدت» عند الحفظ', true);
    const save = A.btn('حفظ الحضور', { kind: 'p', small: true, icon: 'check' });
    const allPresent = A.btn('الكل حاضر', { small: true });
    let ctrl = {};
    function paint() {
      A.clear(table);
      ctrl = {};
      const existing = {};
      D.attendance.forEach(function (a) { if (a.session_id === sid) existing[a.user_id] = a; });
      table.appendChild(A.dataTable([
        { label: 'المتدرب', cls: 'ad-first', cell: function (mm) { return nameOf(D.dir, mm.user_id); } },
        { label: 'الحالة', cell: function (mm) {
          const s = A.select([['', '— لم يُسجَّل —']].concat(ATT), existing[mm.user_id] ? existing[mm.user_id].status : '', { aria: 'حضور ' + nameOf(D.dir, mm.user_id) });
          const n = A.input({ max: 500, value: existing[mm.user_id] && existing[mm.user_id].note || '', aria: 'ملاحظة', placeholder: 'ملاحظة…' });
          n.setAttribute('dir', 'auto');
          ctrl[mm.user_id] = { s: s, n: n };
          return h('div', { class: 'ad-pairrow' }, s, n);
        } }
      ], members, { caption: 'حضور الجلسة' }));
    }
    pick.addEventListener('change', function () { sid = pick.value; paint(); ui.clearMsg(out); });
    allPresent.addEventListener('click', function () { Object.keys(ctrl).forEach(function (k) { ctrl[k].s.value = 'present'; }); });
    save.addEventListener('click', run(save, out, 'session', async function () {
      ui.clearMsg(out);
      const rows = [];
      const toDelete = [];
      Object.keys(ctrl).forEach(function (uid) {
        if (ctrl[uid].s.value) rows.push({ session_id: sid, group_id: g.id, user_id: uid, status: ctrl[uid].s.value, note: nz(ctrl[uid].n.value) });
        else toDelete.push(uid);
      });
      if (rows.length) await P.rest.upsert('grp_attendance', rows, 'session_id,user_id');
      for (let i = 0; i < toDelete.length; i++) await P.rest.remove('grp_attendance', { session_id: 'eq.' + sid, user_id: 'eq.' + toDelete[i] });
      if (markHeld.input.checked) {
        const s = sessions.filter(function (x) { return x.id === sid; })[0];
        if (s && s.status === 'scheduled') await P.rest.update('grp_sessions', { id: 'eq.' + sid, group_id: 'eq.' + g.id }, { status: 'held' });
      }
      A.toast('ok', 'حُفظ الحضور (' + rows.length + ' مسجَّل).');
      cur.section = 'attendance';
      await reload();
    }));
    box.appendChild(A.card('تسجيل الحضور', [
      h('div', { class: 'ad-tools' }, A.field('الجلسة', pick)),
      h('div', { class: 'ad-qb-bar' }, allPresent), table,
      markHeld.el, h('div', { class: 'ad-act' }, save, out)]));
    paint();
    return box;
  }

  /* ---------- التقييم القبلي والبعدي ---------- */
  function assessSection(course, D, g, st, reload) {
    const box = h('div');
    const out = A.msgBox();
    const mine = {};
    D.assess.forEach(function (a) { if (a.group_id === g.id) mine[a.kind] = a; });
    const examsBox = { list: [] };
    function defCard(kind, title) {
      const a = mine[kind];
      const t = A.input({ max: 200, value: a ? a.title : title, aria: 'عنوان التقييم' });
      const when = A.input({ type: 'date', value: a && a.held_on || '' });
      const exam = A.select([['', '— بلا ربط —']], a && a.exam_id || '');
      const note = A.input({ max: 1000, value: a && a.note || '', placeholder: 'ملاحظة (اختياري)' });
      const o2 = A.msgBox();
      const save = A.btn('حفظ ' + (kind === 'pre' ? 'التقييم القبلي' : 'التقييم البعدي'), { kind: 'p', small: true, type: 'submit' });
      P.rest.select('ex_exams', { select: 'id,title_ar,status', course_id: 'eq.' + course, order: 'updated_at.desc', limit: '200' }).then(function (rows) {
        if (!exam.isConnected) return;
        A.clear(exam);
        exam.appendChild(h('option', { value: '', text: '— بلا ربط —' }));
        rows.forEach(function (x) { exam.appendChild(h('option', { value: x.id, text: x.title_ar + (x.status === 'published' ? '' : ' (' + x.status + ')') })); });
        exam.value = a && a.exam_id || '';
      }).catch(function () { /* الربط اختياري */ });
      const form = h('form', { class: 'pf-form', novalidate: true, method: 'post', action: '/admin/' },
        h('div', { class: 'ad-tools' }, A.field('عنوان التقييم', t), A.field('تاريخ الانعقاد', when, null, 'sm'), A.field('اختبار مرتبط (اختياري)', exam, 'يربط التقييم باختبار من اختبارات هذه الدورة؛ ملء الدرجات تلقائيًا من محاولاته يأتي مع M4.')),
        A.field('ملاحظة', note), h('div', { class: 'ad-act' }, save, o2));
      form.addEventListener('submit', run(save, o2, 'group', async function () {
        ui.clearMsg(o2);
        if (!t.value.trim()) { ui.msg(o2, 'err', 'عنوان التقييم مطلوب.'); return; }
        const rows = await P.rest.upsert('grp_assessments', { group_id: g.id, course_id: course, kind: kind, title: t.value.trim(), held_on: when.value || null, exam_id: exam.value || null, note: nz(note.value) }, 'group_id,kind');
        if (!rows.length) throw A.noRows();
        A.toast('ok', 'حُفظ التقييم.');
        await reload();
      }));
      return A.card(kind === 'pre' ? 'التقييم القبلي' : 'التقييم البعدي', form);
    }
    box.appendChild(h('div', { class: 'ad-two' }, defCard('pre', 'التقييم القبلي'), defCard('post', 'التقييم البعدي')));
    /* الدرجات */
    if (!st.members.length) { box.appendChild(A.empty('لا متدربين', 'أضف متدربين لتسجيل درجاتهم.')); return box; }
    const inputs = {};
    const gainCell = function (r) { return r.gain == null ? '—' : h('b', { class: r.gain >= 0 ? 'ad-ok' : 'ad-err', text: (r.gain > 0 ? '+' : '') + r1(r.gain) }); };
    const save = A.btn('حفظ الدرجات', { kind: 'p', small: true, icon: 'check' });
    box.appendChild(A.card('درجات المتدربين (من ٠ إلى ١٠٠)', [
      h('p', { class: 'ad-sub', text: 'أدخل نسبة كل متدرب في القبلي والبعدي. التقدّم = البعدي − القبلي.' }),
      A.dataTable([
        { label: 'المتدرب', cls: 'ad-first', cell: function (r) { return nameOf(D.dir, r.m.user_id); } },
        { label: 'قبلي %', cell: function (r) { const i = A.input({ type: 'number', min: 0, maxv: 100, step: 'any', inputmode: 'decimal', value: r.m.pre_score == null ? '' : Number(r.m.pre_score), aria: 'قبلي ' + nameOf(D.dir, r.m.user_id) }); (inputs[r.m.user_id] = inputs[r.m.user_id] || {}).pre = i; return i; } },
        { label: 'بعدي %', cell: function (r) { const i = A.input({ type: 'number', min: 0, maxv: 100, step: 'any', inputmode: 'decimal', value: r.m.post_score == null ? '' : Number(r.m.post_score), aria: 'بعدي ' + nameOf(D.dir, r.m.user_id) }); (inputs[r.m.user_id] = inputs[r.m.user_id] || {}).post = i; return i; } },
        { label: 'التقدّم', cell: gainCell }
      ], st.rows, { caption: 'درجات التقييم' }),
      h('p', { class: 'ad-sub', text: 'المتوسطات: قبلي ' + (st.pre == null ? '—' : r1(st.pre) + '%') + ' · بعدي ' + (st.post == null ? '—' : r1(st.post) + '%') + ' · التقدّم ' + (st.gain == null ? '—' : (st.gain > 0 ? '+' : '') + r1(st.gain)) }),
      h('div', { class: 'ad-act' }, save, out)]));
    save.addEventListener('click', run(save, out, 'score', async function () {
      ui.clearMsg(out);
      const jobs = [];
      for (let i = 0; i < st.rows.length; i++) {
        const m = st.rows[i].m;
        const pre = pctOr(inputs[m.user_id].pre.value);
        const post = pctOr(inputs[m.user_id].post.value);
        if ((pre !== null && (Number.isNaN(pre) || pre < 0 || pre > 100)) || (post !== null && (Number.isNaN(post) || post < 0 || post > 100))) { ui.msg(out, 'err', 'درجات «' + nameOf(D.dir, m.user_id) + '» يجب أن تكون من ٠ إلى ١٠٠.'); return; }
        const was = [m.pre_score == null ? null : Number(m.pre_score), m.post_score == null ? null : Number(m.post_score)];
        if (pre !== was[0] || post !== was[1]) jobs.push([m.user_id, { pre_score: pre, post_score: post }]);
      }
      for (let i = 0; i < jobs.length; i++) {
        const rows = await P.rest.update('grp_members', { group_id: 'eq.' + g.id, user_id: 'eq.' + jobs[i][0] }, jobs[i][1]);
        if (!rows.length) throw A.noRows();
      }
      A.toast('ok', jobs.length ? 'حُفظت درجات ' + jobs.length + ' متدربًا.' : 'لا تغييرات للحفظ.');
      await reload();
    }));
    return box;
  }

  /* ---------- التقارير ---------- */
  function reportsSection(D, g, st) {
    const box = h('div');
    const csv = A.btn('تصدير التقرير CSV', { small: true, icon: 'download' });
    csv.addEventListener('click', function () {
      const lines = [['المتدرب', 'البريد', 'الحالة', 'حاضر', 'متأخر', 'غائب', 'بعذر', 'نسبة الحضور %', 'قبلي %', 'بعدي %', 'التقدّم']];
      st.rows.forEach(function (r) {
        lines.push([nameOf(D.dir, r.m.user_id), emailOf(D.dir, r.m.user_id), lbl(M_STATUS, r.m.status), r.c.present, r.c.late, r.c.absent, r.c.excused,
          r.rate == null ? '' : r1(r.rate), r.m.pre_score == null ? '' : Number(r.m.pre_score), r.m.post_score == null ? '' : Number(r.m.post_score), r.gain == null ? '' : r1(r.gain)]);
      });
      A.download('group-' + new Date().toISOString().slice(0, 10) + '.csv', A.csvBuild(lines), 'text/csv');
      A.toast('ok', 'تم تصدير تقرير المجموعة.');
    });
    box.appendChild(h('div', { class: 'ad-grid' },
      kpi('الجلسات المعقودة', A.num(st.held.length)),
      kpi('متوسط الحضور', st.rate == null ? '—' : r1(st.rate) + '%'),
      kpi('متوسط القبلي', st.pre == null ? '—' : r1(st.pre) + '%'),
      kpi('متوسط البعدي', st.post == null ? '—' : r1(st.post) + '%'),
      kpi('متوسط التقدّم', st.gain == null ? '—' : (st.gain > 0 ? '+' : '') + r1(st.gain) + ' نقطة')));
    if (!st.rows.length) { box.appendChild(A.empty('لا متدربين', 'أضف متدربين لعرض التقرير.')); return box; }
    box.appendChild(A.card('تقرير المتدربين', [h('div', { class: 'ad-qb-bar' }, csv),
      A.dataTable([
        { label: 'المتدرب', cls: 'ad-first', cell: function (r) { return nameOf(D.dir, r.m.user_id); } },
        { label: 'الحالة', cls: 'hide-md', cell: function (r) { return lbl(M_STATUS, r.m.status); } },
        { label: 'حاضر', cell: function (r) { return A.num(r.c.present); } },
        { label: 'متأخر', cell: function (r) { return A.num(r.c.late); } },
        { label: 'غائب', cell: function (r) { return A.num(r.c.absent); } },
        { label: 'بعذر', cls: 'hide-md', cell: function (r) { return A.num(r.c.excused); } },
        { label: 'الحضور', cell: function (r) { return r.rate == null ? '—' : r1(r.rate) + '%'; } },
        { label: 'قبلي → بعدي', cell: function (r) { return (r.m.pre_score == null ? '—' : Number(r.m.pre_score)) + ' → ' + (r.m.post_score == null ? '—' : Number(r.m.post_score)); } },
        { label: 'التقدّم', cell: function (r) { return r.gain == null ? '—' : (r.gain > 0 ? '+' : '') + r1(r.gain); } }
      ], st.rows, { caption: 'تقرير المجموعة' })]));
    return box;
  }

  A.groups = { render: render };
})();
