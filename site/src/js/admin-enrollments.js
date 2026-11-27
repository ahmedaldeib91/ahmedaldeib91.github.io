/* =====================================================================
   admin-enrollments.js — قسم «الاشتراكات» (#enrollments) في لوحة المدرب
   (١) إضافة اشتراك: اختر الدورة ثم ابحث عن المتدربين بالاسم أو البريد أو الهاتف وحدّد واحدًا أو أكثر واضغط «اشتراك المحدّدين».
       تُنفَّذ الطلبات واحدًا بعد الآخر (كل منح يُسجَّل في سجل التدقيق)؛ من كان مشتركًا يُتخطى، ومن كان اشتراكه ملغى يُعاد تفعيله،
       وتظهر خلاصة بالأعداد وبأي فشل. ولكل اشتراك جديد يُرسَل بريد ترحيب للمتدرب (وظيفة send-mail) أثناء متابعة بقية المنح، وتدخل
       نتيجته في الخلاصة نفسها (أُرسل كذا وتعذّر كذا)، ولا يُفشل البريدُ الاشتراكَ أبدًا. الدورة المختارة تبقى بين العمليات لتسريع الإضافة المتتابعة.
   (٢) الاشتراكات النشطة: كل الاشتراكات النشطة مع تصفية بالدورة والبحث وترتيب وصفحات، وإلغاء بنافذة تأكيد.
   ===================================================================== */
(function () {
  'use strict';

  const A = window.Admin;
  if (!A) return;
  const P = A.P;
  const h = A.h;
  const ui = A.ui;
  const PAGE = 25;
  const nameOr = function (p) { return (p && p.full_name) || 'بدون اسم'; };

  async function render(root, args, token) {
    const refresh = A.btn('تحديث', { icon: 'refresh', small: true });
    root.appendChild(A.head('الاشتراكات', 'أضف دورة لمتدرب أو لعدة متدربين دفعة واحدة، وراجع كل الاشتراكات النشطة.', [refresh]));
    const body = h('div');
    root.appendChild(body);
    let dir = null;
    const sel = new Set(); /* المتدربون المحدّدون للاشتراك */
    const st = { course: '', q: '', fCourse: 'all', fq: '', sort: 'date', dir: 'desc', page: 1, summary: null };

    const trainees = function () { return dir.profiles.filter(function (p) { return p.role === 'trainee'; }); };
    const emailOf = function (id) { return dir.emails[id] ? dir.emails[id].email : ''; };
    const activeIn = function (course) {
      const s = new Set();
      dir.enrollments.forEach(function (e) { if (e.status === 'active' && e.course_id === course) s.add(e.user_id); });
      return s;
    };
    const matches = function (p, q) {
      if (!q) return true;
      const nq = A.normAr(q);
      const digits = A.latinDigits(q).replace(/\D/g, '');
      if (A.normAr([p.full_name, emailOf(p.id), p.phone].join(' ')).indexOf(nq) !== -1) return true;
      return digits.length >= 3 && A.latinDigits(p.phone || '').replace(/\D/g, '').indexOf(digits) !== -1;
    };

    /* ---------- بطاقة الإضافة ---------- */
    function addCard() {
      const courseSel = A.select(A.S.courses.map(function (c) { return [c.id, c.title_ar]; }), st.course || (A.S.courses[0] && A.S.courses[0].id));
      st.course = courseSel.value;
      const search = A.input({ type: 'search', max: 120, placeholder: 'اسم، بريد أو هاتف (أو اتركه فارغًا لعرض الأحدث)' });
      search.value = st.q;
      const list = h('ul', { class: 'ad-picks', 'aria-label': 'نتائج البحث عن المتدربين' });
      const info = h('p', { class: 'ad-count-t', role: 'status' });
      const out = A.msgBox();
      if (st.summary) { ui.msg(out, st.summary.kind, st.summary.text); st.summary = null; }
      const submit = A.btn('اشتراك المحدّدين', { kind: 'p', small: true, icon: 'plus', disabled: true });
      const all = A.btn('تحديد الكل', { small: true });
      const none = A.btn('إلغاء التحديد', { small: true });

      function visible() {
        const rows = trainees().filter(function (p) { return matches(p, st.q); });
        rows.sort(function (a, b) { return Date.parse(b.created_at) - Date.parse(a.created_at); });
        return rows.slice(0, 20);
      }
      function sync() {
        const n = sel.size;
        info.textContent = n ? 'المحدّد: ' + n + ' متدرب' : 'لم تحدّد أحدًا بعد.';
        submit.disabled = !n || !st.course;
      }
      function paint() {
        A.clear(list);
        const enrolled = activeIn(st.course);
        enrolled.forEach(function (id) { sel.delete(id); });
        const rows = visible();
        if (!rows.length) { list.appendChild(h('li', null, A.empty('لا نتائج', 'لا يوجد متدرب يطابق بحثك.'))); sync(); return; }
        rows.forEach(function (p) {
          const done = enrolled.has(p.id);
          const cb = h('input', { type: 'checkbox', disabled: done, 'aria-label': 'تحديد ' + nameOr(p) });
          cb.checked = sel.has(p.id);
          cb.addEventListener('change', function () { if (cb.checked) sel.add(p.id); else sel.delete(p.id); sync(); });
          list.appendChild(h('li', null, h('label', { class: 'ad-pick' + (done ? ' dis' : '') }, cb,
            h('span', { class: 'ad-pt' }, h('b', { text: nameOr(p) }),
              h('small', { class: 'ad-ltr', text: [emailOf(p.id), p.phone].filter(Boolean).join('  ·  ') || '—' })),
            done ? A.badge('مشترك في هذه الدورة', 'ok') : null,
            p.status !== 'active' ? A.badge('موقوف', 'err') : null)));
        });
        sync();
      }
      courseSel.addEventListener('change', function () { st.course = courseSel.value; paint(); });
      search.addEventListener('input', A.debounce(function () { st.q = search.value; paint(); }, 160));
      all.addEventListener('click', function () {
        const enrolled = activeIn(st.course);
        visible().forEach(function (p) { if (!enrolled.has(p.id)) sel.add(p.id); });
        paint();
      });
      none.addEventListener('click', function () { sel.clear(); paint(); });
      submit.addEventListener('click', A.run(submit, out, async function () {
        ui.clearMsg(out);
        const ids = Array.from(sel);
        const course = st.course;
        const title = A.courseTitle(course);
        const res = { added: 0, reactivated: 0, exists: 0, failed: [], mails: [] };
        for (let i = 0; i < ids.length; i++) {
          if (A.stale(token)) return;
          const info = {};
          try { res[await A.grantEnrollment(ids[i], course, info)] += 1; } catch (err) {
            if (A.isSession(err)) { A.lost('expired'); return; }
            if (A.isForbidden(err)) { A.hooks.forbidden(); }
            res.failed.push(nameOr(dir.byId[ids[i]]));
          }
          if (info.mail) res.mails.push(info.mail); /* بريد الترحيب يُرسَل أثناء متابعة بقية المنح؛ ننتظرها كلها بعد الحلقة ونعرض تنبيهًا واحدًا */
        }
        const mails = await Promise.all(res.mails); /* وعود لا تُرفض أبدًا: {mailed, why} */
        if (A.stale(token)) return;
        const unsent = mails.filter(function (m) { return !m.mailed; });
        const parts = [];
        if (res.added) parts.push('أُضيف ' + res.added);
        if (res.reactivated) parts.push('أُعيد تفعيل ' + res.reactivated);
        if (res.exists) parts.push('كان مشتركًا ' + res.exists);
        if (res.failed.length) parts.push('تعذّر ' + res.failed.length + ' (' + res.failed.join('، ') + ')');
        if (mails.length) {
          const why = unsent.map(function (m) { return m.why; }).filter(function (w, i, all) { return all.indexOf(w) === i; });
          parts.push('بريد الترحيب: أُرسل ' + (mails.length - unsent.length) + (unsent.length ? ' وتعذّر ' + unsent.length + ' (' + why.join('، ') + ')' : ''));
        }
        sel.clear();
        /* فشل البريد وحده لا يُفشل الاشتراك: يظهر التنبيه محايدًا (info) لا أحمر */
        st.summary = { kind: res.failed.length ? 'err' : unsent.length ? 'info' : 'ok', text: 'الدورة «' + title + '»: ' + parts.join(' — ') + '.' };
        A.announce(st.summary.text);
        await reloadData(); /* يعيد بناء البطاقة فتُعرض الخلاصة (st.summary) في الرسالة الجديدة */
      }));
      paint();
      return A.card('إضافة اشتراك', [
        h('p', { class: 'ad-sub', text: 'اختر الدورة، ثم ابحث وحدّد المتدربين. يُعرض أحدث ٢٠ مطابقًا.' }),
        h('div', { class: 'ad-tools' }, A.field('الدورة', courseSel), A.field('بحث عن متدرب', search)),
        h('div', { class: 'ad-act' }, all, none, info),
        list,
        h('div', { class: 'ad-act' }, submit, out)
      ]);
    }

    /* ---------- جدول الاشتراكات النشطة ---------- */
    function listCard() {
      const fCourse = A.select([['all', 'كل الدورات']].concat(A.S.courses.map(function (c) { return [c.id, c.title_ar]; })), st.fCourse);
      const fSearch = A.input({ type: 'search', max: 120, placeholder: 'اسم أو بريد المتدرب' });
      fSearch.value = st.fq;
      const count = h('p', { class: 'ad-count-t', role: 'status' });
      const box = h('div');
      const out = A.msgBox();

      function rows() {
        const list = dir.enrollments.filter(function (e) {
          if (e.status !== 'active') return false;
          if (st.fCourse !== 'all' && e.course_id !== st.fCourse) return false;
          const p = dir.byId[e.user_id];
          return p ? matches(p, st.fq) : !st.fq;
        });
        const f = {
          user: function (a, b) { return nameOr(dir.byId[a.user_id]).localeCompare(nameOr(dir.byId[b.user_id]), 'ar'); },
          course: function (a, b) { return A.courseTitle(a.course_id).localeCompare(A.courseTitle(b.course_id), 'ar'); },
          date: function (a, b) { return Date.parse(a.granted_at) - Date.parse(b.granted_at); }
        }[st.sort];
        const sgn = st.dir === 'asc' ? 1 : -1;
        list.sort(function (a, b) { return f(a, b) * sgn; });
        return list;
      }
      function paint(focusKey) {
        const list = rows();
        const pages = Math.max(1, Math.ceil(list.length / PAGE));
        if (st.page > pages) st.page = pages;
        A.clear(box);
        count.textContent = 'الاشتراكات النشطة: ' + A.num(list.length);
        if (!list.length) { box.appendChild(A.empty('لا اشتراكات نشطة', 'غيّر التصفية أو أضف اشتراكًا من البطاقة أعلاه.')); return; }
        box.appendChild(A.dataTable([
          { key: 'user', label: 'المتدرب', sort: true, cls: 'ad-first', cell: function (e) {
            const p = dir.byId[e.user_id];
            return h('div', null, p ? h('a', { class: 'ad-name', href: '#trainees/' + p.id, text: nameOr(p) }) : h('span', { text: 'حساب محذوف' }), p && emailOf(p.id) ? h('small', { class: 'ad-ltr', text: emailOf(p.id) }) : null);
          } },
          { key: 'course', label: 'الدورة', sort: true, cell: function (e) { return A.courseTitle(e.course_id); } },
          { key: 'date', label: 'منذ', sort: true, cell: function (e) { return h('span', { class: 'ad-nowrap', text: A.fmtDay(e.granted_at) }); } },
          { key: 'by', label: 'بواسطة', cls: 'hide-md', cell: function (e) { return A.who(e.granted_by); } },
          { key: 'act', label: '', cls: 'ad-actcol', cell: function (e) {
            const p = dir.byId[e.user_id];
            const b = A.btn('إلغاء', { small: true, kind: 'danger' });
            b.addEventListener('click', A.run(b, out, async function () {
              ui.clearMsg(out);
              const ok = await A.confirm({
                title: 'إلغاء الاشتراك؟',
                message: 'سيفقد «' + nameOr(p) + '» الوصول إلى «' + A.courseTitle(e.course_id) + '» فورًا.',
                detail: 'يبقى السجل ويمكنك إعادة التفعيل لاحقًا. يُسجَّل الإجراء باسمك.',
                ok: 'إلغاء الاشتراك', danger: true
              });
              if (!ok) return;
              await A.revokeEnrollment(e.id);
              A.toast('ok', 'تم إلغاء الاشتراك.');
              await reloadData();
            }));
            return h('div', { class: 'ad-cell-act' }, b);
          } }
        ], list.slice((st.page - 1) * PAGE, st.page * PAGE), {
          caption: 'الاشتراكات النشطة', sort: { key: st.sort, dir: st.dir },
          onSort: function (key) {
            if (st.sort === key) st.dir = st.dir === 'asc' ? 'desc' : 'asc'; else { st.sort = key; st.dir = key === 'date' ? 'desc' : 'asc'; }
            st.page = 1;
            paint(key);
          }
        }));
        const pg = A.pager(list.length, st.page, PAGE, function (n) { st.page = n; paint(); });
        if (pg) box.appendChild(pg);
        if (focusKey) { const b = box.querySelector('.ad-sort[data-key="' + focusKey + '"]'); if (b) b.focus(); }
      }
      fCourse.addEventListener('change', function () { st.fCourse = fCourse.value; st.page = 1; paint(); });
      fSearch.addEventListener('input', A.debounce(function () { st.fq = fSearch.value; st.page = 1; paint(); }, 160));
      paint();
      return A.card('الاشتراكات النشطة', [h('div', { class: 'ad-tools' }, A.field('الدورة', fCourse), A.field('بحث', fSearch), count), out, box]);
    }

    function build() {
      A.clear(body);
      if (!dir.emailsOk) body.appendChild(h('p', { class: 'ad-note warn', text: 'البحث بالبريد غير متاح الآن: يلزم تطبيق الملف supabase/migrations/006_admin_user_emails.sql. يعمل البحث بالاسم والهاتف.' }));
      body.appendChild(addCard());
      body.appendChild(listCard());
    }
    async function reloadData() {
      try { dir = await A.loadDirectory(); } catch (err) { A.failWith(err); return; }
      if (A.stale(token)) return;
      build();
    }
    async function load() {
      A.clear(body);
      body.appendChild(A.loading('جارٍ تحميل الاشتراكات…'));
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
      build();
    }
    refresh.addEventListener('click', function () { sel.clear(); load(); });
    await load();
  }

  A.register('enrollments', { label: 'الاشتراكات', render: render });
})();
