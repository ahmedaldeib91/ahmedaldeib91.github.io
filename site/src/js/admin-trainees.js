/* =====================================================================
   admin-trainees.js — قسم «المتدربون» (#trainees وصفحة المتدرب #trainees/<uuid>) في لوحة المدرب
   القائمة: بحث (يطبّع العربية: التشكيل والألف والياء والتاء المربوطة والأرقام) وترتيب بالأعمدة وتصفية بالحالة وصفحات (٢٥)،
   وتصدير CSV من المتصفح (يحيّد الخلايا التي تبدأ بـ = + - @ بفاصلة عليا، وBOM لـ Excel). البريد من الدالة admin_user_emails
   (الترحيل 006)؛ إن لم تكن متاحة يُعرض الاسم والهاتف فقط ولا يُستعلم أي جدول من auth.
   صفحة المتدرب: بياناته، ملاحظات المدرب (جدول trainer_notes للمدير فقط)، الاشتراكات (منح/إلغاء/إعادة تفعيل)، محاولاته،
   وسجل التدقيق الخاص به. الإيقاف والإلغاء بنافذة تأكيد، وكل الكتابة عبر REST فتقرر RLS في القاعدة.
   ===================================================================== */
(function () {
  'use strict';

  const A = window.Admin;
  if (!A) return;
  const P = A.P;
  const h = A.h;
  const ui = A.ui;
  const PAGE = 25;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const nameOr = function (p) { return p.full_name || 'بدون اسم'; };
  const waLabel = 'مراسلة عبر واتساب';

  /* ================================================================== القائمة */
  async function renderList(root, token) {
    const view = { q: '', status: 'all', sort: 'created', dir: 'desc', page: 1 };
    const csvBtn = A.btn('تصدير CSV', { icon: 'download', small: true, disabled: true });
    const refresh = A.btn('تحديث', { icon: 'refresh', small: true });
    root.appendChild(A.head('المتدربون', 'ابحث في المتدربين وافتح صفحة كل متدرب لإدارة اشتراكاته وملاحظاتك عليه.', [csvBtn, refresh]));
    const body = h('div');
    root.appendChild(body);
    let dir = null;
    let counts = {};

    const trainees = function () { return dir.profiles.filter(function (p) { return p.role === 'trainee'; }); };
    const emailOf = function (p) { return dir.emails[p.id] ? dir.emails[p.id].email : ''; };

    const cmp = {
      name: function (a, b) { return String(a.full_name || '').localeCompare(String(b.full_name || ''), 'ar'); },
      created: function (a, b) { return Date.parse(a.created_at) - Date.parse(b.created_at); },
      seen: function (a, b) { return (a.last_seen_at ? Date.parse(a.last_seen_at) : 0) - (b.last_seen_at ? Date.parse(b.last_seen_at) : 0); },
      status: function (a, b) { return String(a.status).localeCompare(String(b.status)); },
      enr: function (a, b) { return (counts[a.id] || 0) - (counts[b.id] || 0); }
    };
    function filtered() {
      const q = A.normAr(view.q);
      const digits = A.latinDigits(view.q).replace(/\D/g, '');
      const rows = trainees().filter(function (p) {
        if (view.status !== 'all' && p.status !== view.status) return false;
        if (!q) return true;
        const hay = A.normAr([p.full_name, emailOf(p), p.phone, p.country].join(' '));
        if (hay.indexOf(q) !== -1) return true;
        return digits.length >= 3 && A.latinDigits(p.phone || '').replace(/\D/g, '').indexOf(digits) !== -1;
      });
      const f = cmp[view.sort] || cmp.created;
      const sgn = view.dir === 'asc' ? 1 : -1;
      rows.sort(function (a, b) { return (f(a, b) * sgn) || cmp.name(a, b); });
      return rows;
    }

    function exportCsv() {
      const rows = filtered();
      const head = ['الاسم'].concat(dir.emailsOk ? ['البريد الإلكتروني'] : [], ['الهاتف', 'الدولة', 'الحالة', 'تاريخ التسجيل', 'آخر ظهور', 'الاشتراكات النشطة']);
      const lines = [head].concat(rows.map(function (p) {
        return [p.full_name || ''].concat(dir.emailsOk ? [emailOf(p)] : [], [
          p.phone || '', p.country || '', (A.statusMap.profile[p.status] || [p.status])[0], p.created_at || '', p.last_seen_at || '', counts[p.id] || 0]);
      }));
      A.download('trainees-' + new Date().toISOString().slice(0, 10) + '.csv', A.csvBuild(lines), 'text/csv');
      A.toast('ok', 'تم تصدير ' + rows.length + ' متدربًا إلى ملف CSV.');
    }

    function build() {
      A.clear(body);
      if (!dir.emailsOk) {
        body.appendChild(h('p', { class: 'ad-note warn', text: 'بريد المتدربين غير متاح الآن: يلزم تطبيق الملف supabase/migrations/006_admin_user_emails.sql على قاعدة البيانات (واجهة REST لا تقرأ جدول auth). إلى أن يُطبَّق يظهر الاسم والهاتف والدولة فقط.' }));
      }
      const search = A.input({ type: 'search', max: 120, auto: 'off', placeholder: 'اسم، بريد، هاتف أو دولة' });
      search.value = view.q;
      const status = A.select([['all', 'كل الحالات'], ['active', 'نشط'], ['suspended', 'موقوف']], view.status);
      const count = h('p', { class: 'ad-count-t', role: 'status' });
      const tableBox = h('div');

      function paint(focusKey) {
        const rows = filtered();
        const total = rows.length;
        const pages = Math.max(1, Math.ceil(total / PAGE));
        if (view.page > pages) view.page = pages;
        A.clear(tableBox);
        count.textContent = total ? 'عدد النتائج: ' + A.num(total) + ' من ' + A.num(trainees().length) : 'لا نتائج مطابقة.';
        if (!total) {
          tableBox.appendChild(A.empty(trainees().length ? 'لا نتائج مطابقة' : 'لا يوجد متدربون بعد',
            trainees().length ? 'جرّب كلمة بحث أخرى أو غيّر تصفية الحالة.' : 'سيظهر هنا كل من يسجّل حسابًا جديدًا في المنصة.'));
          return;
        }
        const slice = rows.slice((view.page - 1) * PAGE, view.page * PAGE);
        const cols = [
          { key: 'name', label: 'المتدرب', sort: true, cls: 'ad-first', cell: function (p) {
            return h('div', null, h('a', { class: 'ad-name', href: '#trainees/' + p.id, text: nameOr(p) }), emailOf(p) ? h('small', { class: 'ad-ltr', text: emailOf(p) }) : null);
          } },
          { key: 'phone', label: 'الهاتف', cell: function (p) { return p.phone ? h('span', { class: 'ad-ltr ad-nowrap', text: p.phone }) : '—'; } },
          { key: 'country', label: 'الدولة', cls: 'hide-md', cell: function (p) { return p.country || '—'; } },
          { key: 'status', label: 'الحالة', sort: true, cell: function (p) { return A.statusBadge('profile', p.status); } },
          { key: 'created', label: 'التسجيل', sort: true, cell: function (p) { return h('span', { class: 'ad-nowrap', text: A.fmtDay(p.created_at) }); } },
          { key: 'seen', label: 'آخر ظهور', sort: true, cls: 'hide-md', cell: function (p) { return h('span', { class: 'ad-nowrap', text: p.last_seen_at ? A.fmtDay(p.last_seen_at) : '—' }); } },
          { key: 'enr', label: 'الاشتراكات', sort: true, cell: function (p) { return h('b', { class: 'ad-ltr', text: String(counts[p.id] || 0) }); } },
          { key: 'act', label: '', cls: 'ad-actcol', cell: function (p) { return A.link('فتح', '#trainees/' + p.id, { small: true }); } }
        ];
        tableBox.appendChild(A.dataTable(cols, slice, {
          caption: 'قائمة المتدربين', sort: { key: view.sort, dir: view.dir },
          onSort: function (key) {
            if (view.sort === key) view.dir = view.dir === 'asc' ? 'desc' : 'asc'; else { view.sort = key; view.dir = key === 'name' || key === 'status' ? 'asc' : 'desc'; }
            view.page = 1;
            paint(key);
          }
        }));
        const pg = A.pager(total, view.page, PAGE, function (n) { view.page = n; paint(); const t = tableBox.querySelector('.ad-tablewrap'); if (t) { t.setAttribute('tabindex', '-1'); t.focus({ preventScroll: false }); } });
        if (pg) tableBox.appendChild(pg);
        if (focusKey) { const b = tableBox.querySelector('.ad-sort[data-key="' + focusKey + '"]'); if (b) b.focus(); }
      }

      search.addEventListener('input', A.debounce(function () { view.q = search.value; view.page = 1; paint(); }, 160));
      status.addEventListener('change', function () { view.status = status.value; view.page = 1; paint(); });
      body.appendChild(h('div', { class: 'ad-tools' }, A.field('بحث', search), A.field('الحالة', status, null, 'sm'), count));
      body.appendChild(tableBox);
      paint();
    }

    async function load() {
      A.clear(body);
      body.appendChild(A.loading('جارٍ تحميل المتدربين…'));
      refresh.disabled = true;
      try { dir = await A.loadDirectory(); } catch (err) {
        refresh.disabled = false;
        if (A.stale(token)) return;
        if (A.isSession(err)) { A.lost('expired'); return; }
        A.clear(body);
        body.appendChild(A.fail(A.errText(err), load));
        return;
      }
      refresh.disabled = false;
      if (A.stale(token)) return;
      counts = {};
      dir.enrollments.forEach(function (e) { if (e.status === 'active') counts[e.user_id] = (counts[e.user_id] || 0) + 1; });
      csvBtn.disabled = false;
      build();
    }
    refresh.addEventListener('click', load);
    csvBtn.addEventListener('click', function () { if (dir) exportCsv(); });
    await load();
  }

  /* ================================================================== صفحة المتدرب */
  async function loadOne(id) {
    const r = await Promise.all([
      P.rest.select('profiles', { select: 'id,full_name,phone,country,role,status,created_at,last_seen_at', id: 'eq.' + id }),
      P.rest.select('enrollments', { select: 'id,course_id,status,granted_by,granted_at,revoked_at', user_id: 'eq.' + id, order: 'granted_at.desc' }),
      P.rest.select('quiz_attempts', { select: 'id,course_id,score,total,created_at', user_id: 'eq.' + id, order: 'created_at.desc', limit: '200' }),
      P.rest.select('trainer_notes', { select: 'notes,updated_at,updated_by', user_id: 'eq.' + id }),
      P.rest.select('audit_log', {
        select: 'id,actor_id,action,entity,entity_id,details,created_at',
        or: '(and(entity.eq.profiles,entity_id.eq.' + id + '),and(entity.eq.enrollments,details->>user_id.eq.' + id + '))',
        order: 'created_at.desc', limit: '100'
      }),
      A.loadCourses(true),
      A.settle(A.loadEmails())
    ]);
    const d = { profile: r[0][0] || null, enrollments: r[1], attempts: r[2], note: r[3][0] || null, audit: r[4], email: null };
    if (r[6].ok) d.email = r[6].v[id] || null; else if (A.isSession(r[6].e)) throw r[6].e;
    d.emailsOk = r[6].ok;
    const ids = [];
    d.audit.forEach(function (e) { Array.prototype.push.apply(ids, A.auditIds(e)); });
    d.enrollments.forEach(function (e) { ids.push(e.granted_by); });
    if (d.note) ids.push(d.note.updated_by);
    await A.resolveNames(ids);
    return d;
  }

  async function renderOne(root, token, id) {
    root.appendChild(h('div', { class: 'ad-crumb' }, A.link('العودة إلى المتدربين', '#trainees', { icon: 'back', small: true })));
    const headBox = h('div');
    root.appendChild(headBox);
    const body = h('div');
    root.appendChild(body);
    headBox.appendChild(A.head('المتدرب', null, []));
    if (!UUID.test(id)) { body.appendChild(A.empty('المتدرب غير موجود', 'الرابط غير صحيح. ارجع إلى قائمة المتدربين.')); return; }
    body.appendChild(A.loading('جارٍ تحميل بيانات المتدرب…'));

    async function reload(initial) {
      let d;
      try { d = await loadOne(id); } catch (err) {
        if (A.stale(token)) return;
        if (A.isSession(err)) { A.lost('expired'); return; }
        A.clear(body);
        body.appendChild(A.fail(A.errText(err), function () { reload(true); }));
        return;
      }
      if (A.stale(token)) return;
      if (!d.profile) { A.clear(body); body.appendChild(A.empty('المتدرب غير موجود', 'لم نجد هذا الحساب. ربما حُذف. ارجع إلى قائمة المتدربين.')); return; }
      paint(d);
    }

    function paint(d) {
      const p = d.profile;
      const isTrainee = p.role === 'trainee';
      const name = nameOr(p);
      document.title = name + ' | لوحة المدرب';
      const hadTitleFocus = !!(document.activeElement && document.activeElement.id === 'ad-title'); /* العنوان يُعاد إنشاؤه: لا نترك التركيز يضيع */
      A.clear(headBox);
      const wa = A.waUrl(p.phone);
      const statusMsg = A.msgBox();
      const toggle = isTrainee ? A.btn(p.status === 'active' ? 'إيقاف الحساب' : 'تفعيل الحساب', { small: true, kind: p.status === 'active' ? 'danger' : 'p', icon: p.status === 'active' ? 'lock' : 'check' }) : null;
      headBox.appendChild(A.head(name, d.email && d.email.email ? d.email.email : (isTrainee ? 'حساب متدرب' : 'حساب مدرب'), [
        A.statusBadge('profile', p.status),
        wa ? A.ext(waLabel, wa, 'btn s sm') : null,
        toggle
      ]));
      const titleEl = A.$('ad-title');
      const subEl = titleEl && titleEl.nextSibling;
      if (subEl && d.email && d.email.email) subEl.classList.add('ad-ltr'); /* البريد يُعرض من اليسار لليمين */
      headBox.appendChild(statusMsg);
      if (hadTitleFocus) A.focusTitle();

      if (toggle) {
        toggle.addEventListener('click', A.run(toggle, statusMsg, async function () {
          ui.clearMsg(statusMsg);
          const to = p.status === 'active' ? 'suspended' : 'active';
          if (to === 'suspended') {
            const ok = await A.confirm({
              title: 'إيقاف حساب «' + name + '»؟',
              message: 'سيُحجب فورًا كل محتوى الدورات (الملفات والفيديوهات والأسئلة) عن هذا المتدرب حتى لو بقيت اشتراكاته نشطة.',
              detail: 'يمكنك إعادة تفعيل الحساب في أي وقت، ويُسجَّل الإجراء في سجل التدقيق.',
              ok: 'إيقاف الحساب', danger: true
            });
            if (!ok) return;
          }
          const rows = await P.rest.update('profiles', { id: 'eq.' + id }, { status: to });
          if (!rows.length) throw A.noRows();
          A.toast('ok', to === 'suspended' ? 'تم إيقاف الحساب.' : 'تم تفعيل الحساب.');
          await reload();
        }));
      }

      A.clear(body);
      if (!isTrainee) body.appendChild(h('p', { class: 'ad-note', text: 'هذا حساب مدرب. لا تُدار حسابات المدربين من هذه الصفحة، ويُمنح الدور أو يُسحب من قاعدة البيانات فقط.' }));
      body.appendChild(h('div', { class: 'ad-two' }, infoCard(d), isTrainee ? notesCard(d) : null));
      if (isTrainee) body.appendChild(enrollCard(d));
      body.appendChild(attemptsCard(d));
      body.appendChild(auditCard(d));
    }

    function infoCard(d) {
      const p = d.profile;
      const rows = [
        ['الاسم', nameOr(p)],
        d.emailsOk ? ['البريد الإلكتروني', d.email && d.email.email ? h('span', { class: 'ad-ltr', text: d.email.email }) : '—'] : null,
        ['الهاتف', p.phone ? h('span', { class: 'ad-ltr', text: p.phone }) : '—'],
        ['الدولة', p.country || '—'],
        ['الحالة', A.statusBadge('profile', p.status)],
        ['تاريخ التسجيل', A.fmtDate(p.created_at)],
        ['آخر ظهور', p.last_seen_at ? A.fmtDate(p.last_seen_at) : 'لم يدخل لوحته بعد'],
        d.emailsOk ? ['تأكيد البريد', d.email && d.email.confirmed ? A.fmtDate(d.email.confirmed) : 'غير مؤكَّد'] : null,
        d.emailsOk ? ['آخر تسجيل دخول', d.email && d.email.lastSignIn ? A.fmtDate(d.email.lastSignIn) : '—'] : null
      ].filter(Boolean);
      const dl = h('dl', { class: 'ad-kv' });
      rows.forEach(function (r) { dl.appendChild(h('dt', { text: r[0] })); dl.appendChild(h('dd', null, r[1])); });
      const kids = [dl];
      if (!d.emailsOk) kids.push(h('p', { class: 'ad-note warn', text: 'البريد غير متاح: يلزم تطبيق الترحيل 006 (انظر قائمة المتدربين).' }));
      return A.card('بيانات المتدرب', kids, 'ad-c-info');
    }

    function notesCard(d) {
      const ta = A.textarea({ max: 20000, rows: 7, placeholder: 'ملاحظات خاصة بك عن هذا المتدرب. لا يراها هو ولا أي متدرب.' });
      ta.value = d.note ? d.note.notes : '';
      const counter = h('p', { class: 'ad-counter' });
      const upd = function () { counter.textContent = ta.value.length + ' / 20000'; };
      ta.addEventListener('input', upd);
      upd();
      const out = A.msgBox();
      const btn = A.btn('حفظ الملاحظات', { kind: 'p', small: true, type: 'submit' });
      const last = h('p', { class: 'ad-sub' });
      const stamp = function (n) { last.textContent = n ? 'آخر تعديل: ' + A.fmtDate(n.updated_at) + (n.updated_by ? ' — ' + A.who(n.updated_by) : '') : 'لا توجد ملاحظات محفوظة بعد.'; };
      stamp(d.note);
      const form = h('form', { class: 'pf-form', novalidate: true, method: 'post', action: '/admin/' }, A.field('ملاحظات المدرب (للمدرب فقط)', ta), counter, h('div', { class: 'ad-act' }, btn, out), last);
      form.addEventListener('submit', A.run(btn, out, async function () {
        ui.clearMsg(out);
        const rows = await P.rest.upsert('trainer_notes', { user_id: id, notes: ta.value }, 'user_id');
        if (!rows.length) throw A.noRows();
        stamp(rows[0]);
        ui.msg(out, 'ok', 'تم حفظ الملاحظات.');
      }));
      return A.card('ملاحظات المدرب', form, 'ad-c-notes');
    }

    function enrollCard(d) {
      const byCourse = {};
      d.enrollments.forEach(function (e) { byCourse[e.course_id] = e; });
      const kids = [];
      const out = A.msgBox();
      kids.push(out);
      if (!d.enrollments.length) kids.push(A.empty('لا توجد اشتراكات', 'أضف أول اشتراك لهذا المتدرب من الأسفل بعد الاتفاق معه عبر واتساب.'));
      else {
        kids.push(A.dataTable([
          { key: 'c', label: 'الدورة', cls: 'ad-first', cell: function (e) { return h('div', null, h('b', { text: A.courseTitle(e.course_id) }), h('small', { class: 'ad-ltr', text: e.course_id })); } },
          { key: 's', label: 'الحالة', cell: function (e) { return A.statusBadge('enrollment', e.status); } },
          { key: 'g', label: 'منذ', cell: function (e) { return h('span', { class: 'ad-nowrap', text: A.fmtDay(e.granted_at) }); } },
          { key: 'r', label: 'أُلغي في', cls: 'hide-md', cell: function (e) { return e.revoked_at ? h('span', { class: 'ad-nowrap', text: A.fmtDay(e.revoked_at) }) : '—'; } },
          { key: 'b', label: 'بواسطة', cls: 'hide-md', cell: function (e) { return A.who(e.granted_by); } },
          { key: 'a', label: '', cls: 'ad-actcol', cell: function (e) {
            const b = e.status === 'active'
              ? A.btn('إلغاء الاشتراك', { small: true, kind: 'danger' })
              : A.btn('إعادة التفعيل', { small: true, kind: 'p' });
            b.addEventListener('click', A.run(b, out, async function () {
              ui.clearMsg(out);
              if (e.status === 'active') {
                const ok = await A.confirm({
                  title: 'إلغاء الاشتراك؟',
                  message: 'سيفقد «' + nameOr(d.profile) + '» الوصول إلى ملفات وفيديوهات وأسئلة «' + A.courseTitle(e.course_id) + '» فورًا.',
                  detail: 'يبقى السجل، ويمكنك إعادة التفعيل لاحقًا. يُسجَّل الإجراء باسمك وبالوقت.',
                  ok: 'إلغاء الاشتراك', danger: true
                });
                if (!ok) return;
                await A.revokeEnrollment(e.id);
                A.toast('ok', 'تم إلغاء الاشتراك.');
              } else {
                const info = {};
                const r = await A.grantEnrollment(d.profile.id, e.course_id, info);
                const m = info.mail ? await info.mail : null; /* بريد الترحيب: لا يرمي ولا يُفشل الاشتراك */
                A.toast(m && !m.mailed ? 'info' : 'ok', (r === 'exists' ? 'الاشتراك نشط مسبقًا.' : 'تمت إعادة تفعيل الاشتراك.') + (m ? ' ' + A.mailNote(m) : ''));
              }
              await reload();
            }));
            return h('div', { class: 'ad-cell-act' }, b);
          } }
        ], d.enrollments, { caption: 'اشتراكات المتدرب' }));
      }
      /* إضافة اشتراك */
      const opts = [];
      A.S.courses.forEach(function (c) {
        const cur = byCourse[c.id];
        if (cur && cur.status === 'active') return;
        opts.push([c.id, c.title_ar + (cur ? ' — ملغى سابقًا (سيُعاد تفعيله)' : '')]);
      });
      if (!opts.length) kids.push(h('p', { class: 'ad-note', text: 'المتدرب مشترك في كل الدورات.' }));
      else {
        const sel = A.select(opts, opts[0][0]);
        const add = A.btn('إضافة الاشتراك', { kind: 'p', small: true, icon: 'plus' });
        add.addEventListener('click', A.run(add, out, async function () {
          ui.clearMsg(out);
          const info = {};
          const r = await A.grantEnrollment(d.profile.id, sel.value, info);
          const m = info.mail ? await info.mail : null; /* بريد الترحيب: لا يرمي ولا يُفشل الاشتراك */
          A.toast(m && !m.mailed ? 'info' : 'ok', (r === 'reactivated' ? 'تمت إعادة تفعيل الاشتراك.' : r === 'exists' ? 'الاشتراك نشط مسبقًا.' : 'تمت إضافة الاشتراك، ويظهر الآن في «دوراتي» عند المتدرب.') + (m ? ' ' + A.mailNote(m) : ''));
          await reload();
        }));
        kids.push(h('div', { class: 'ad-addenr' }, A.field('إضافة دورة للمتدرب', sel), add));
        kids.push(h('p', { class: 'ad-sub', text: 'إيقاف الحساب يحجب كل المحتوى حتى مع بقاء الاشتراك نشطًا.' }));
      }
      return A.card('الاشتراكات', kids, 'ad-c-enr');
    }

    function attemptsCard(d) {
      if (!d.attempts.length) return A.card('محاولات الأسئلة المحاكية', A.empty('لا توجد محاولات', 'لم يجرّب هذا المتدرب الأسئلة المحاكية بعد.'), 'ad-c-att');
      return A.card('محاولات الأسئلة المحاكية', A.dataTable([
        { key: 'd', label: 'التاريخ', cls: 'ad-first', cell: function (a) { return h('span', { class: 'ad-nowrap', text: A.fmtDate(a.created_at) }); } },
        { key: 'c', label: 'الدورة', cell: function (a) { return A.courseTitle(a.course_id); } },
        { key: 's', label: 'النتيجة', cell: function (a) { return h('b', { class: 'ad-ltr', text: a.score + '/' + a.total }); } },
        { key: 'p', label: 'النسبة', cell: function (a) { return h('b', { class: 'ad-ltr', text: A.pct(a.score, a.total) + '%' }); } }
      ], d.attempts, { caption: 'محاولات الأسئلة المحاكية' }), 'ad-c-att');
    }

    function auditCard(d) {
      if (!d.audit.length) return A.card('سجل التدقيق', A.empty('لا إدخالات بعد', 'تُسجَّل هنا كل عمليات منح الاشتراك وإلغائه وتغيير حالة الحساب.'), 'ad-c-audit');
      return A.card('سجل التدقيق', [h('p', { class: 'ad-sub', text: 'آخر ' + d.audit.length + ' إجراءً على حساب هذا المتدرب واشتراكاته: من فعل ماذا ومتى.' }), A.auditTable(d.audit)], 'ad-c-audit');
    }

    await reload(true);
  }

  A.register('trainees', {
    label: 'المتدربون',
    render: async function (root, args, token) {
      if (args[0]) await renderOne(root, token, args[0]); else await renderList(root, token);
    }
  });
})();
