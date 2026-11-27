/* =====================================================================
   admin-certificates.js — تبويب «الشهادات» في مركز الدورة (#courses/<id>/certificates) (للمدير)
   مشتركو الدورة النشطون: تقدّمهم في الدروس المنشورة (من lms_progress)، وحالة شهادتهم، وإصدار الشهادة (cert_issue) أو إلغاؤها (cert_revoke).
   «مؤهل» = أكمل كل الدروس المنشورة (إن وُجدت دروس)؛ والإصدار يدوي دائمًا بقرار المدير. شهادات المنصة لإتمام الدورة وليست شهادات PMI.
   كل نص يدخل الصفحة بـ textContent.
   ===================================================================== */
(function () {
  'use strict';

  const A = window.Admin;
  if (!A) return;
  const P = A.P;
  const h = A.h;
  const ui = A.ui;

  function errMsg(err) {
    if (!(err instanceof P.ApiError)) return P.MSG.other;
    const c = err.code || '';
    if (err.kind === 'network' || err.kind === 'config' || err.kind === 'server') return err.message;
    if (c === '42501' || err.kind === 'forbidden') return P.MSG.forbidden;
    if (c === '23505') return 'صدرت شهادة لهذا المتدرب في هذه الدورة مسبقًا.';
    if (c === '22023') return 'تعذّر الإصدار: يلزم اشتراك نشط واسم في ملف المتدرب.';
    if (c === 'P0001' || err.kind === 'rate') return P.MSG.rate;
    return err.message || P.MSG.other;
  }

  async function render(panel, course, token) {
    A.clear(panel);
    panel.appendChild(A.loading('جارٍ التحميل…'));
    let certs; let lessons; let prog; let dir;
    try {
      const r = await Promise.all([
        A.all('cert_certificates', { select: '*', course_id: 'eq.' + course, order: 'issued_at.desc,id.asc' }),
        P.rest.select('lms_lessons', { select: 'id,published', course_id: 'eq.' + course, published: 'eq.true', limit: '2000' }),
        A.all('lms_progress', { select: 'user_id,lesson_id', course_id: 'eq.' + course, completed: 'eq.true', order: 'user_id.asc,lesson_id.asc' }),
        A.loadDirectory()
      ]);
      certs = r[0]; lessons = r[1]; prog = r[2]; dir = r[3];
    } catch (err) {
      if (A.stale(token)) return;
      if (A.isSession(err)) { A.lost('expired'); return; }
      A.clear(panel); panel.appendChild(A.fail(A.errText(err), function () { render(panel, course, token); }));
      return;
    }
    if (A.stale(token)) return;
    A.clear(panel);
    const reload = function () { return render(panel, course, token); };
    const out = A.msgBox();
    const pubIds = {};
    lessons.forEach(function (l) { pubIds[l.id] = true; });
    const done = {};
    prog.forEach(function (p) { if (pubIds[p.lesson_id]) done[p.user_id] = (done[p.user_id] || 0) + 1; });
    const active = {};
    certs.forEach(function (c) { if (!c.revoked_at) active[c.user_id] = c; });
    const total = lessons.length;
    const rows = dir.enrollments.filter(function (e) { return e.course_id === course && e.status === 'active'; }).map(function (e) {
      const p = dir.byId[e.user_id] || {};
      const n = done[e.user_id] || 0;
      return { uid: e.user_id, name: p.full_name || 'بدون اسم', done: n, eligible: total > 0 && n >= total, cert: active[e.user_id] || null };
    }).sort(function (a, b) { return (b.eligible - a.eligible) || a.name.localeCompare(b.name, 'ar'); });
    let onlyEl = false;
    const tbl = h('div');
    const only = A.checkbox('المؤهلون فقط (أكملوا كل الدروس)', false);
    only.input.addEventListener('change', function () { onlyEl = only.input.checked; paint(); });
    panel.appendChild(h('p', { class: 'ad-note', text: 'شهادة إتمام تصدرها المنصة بقرارك (وليست شهادة PMI). لكل شهادة رمز تحقق عام يُدخَل في صفحة «التحقق من شهادة».' }));
    panel.appendChild(h('div', { class: 'ad-tools' }, only.el, A.btn('تحديث', { small: true, icon: 'refresh', on: reload }),
      h('p', { class: 'ad-count-t', role: 'status', text: 'صادرة: ' + A.num(Object.keys(active).length) + ' · مؤهلون بلا شهادة: ' + A.num(rows.filter(function (r) { return r.eligible && !r.cert; }).length) })));
    panel.appendChild(out);
    panel.appendChild(tbl);

    function paint() {
      A.clear(tbl);
      const list = rows.filter(function (r) { return !onlyEl || r.eligible; });
      if (!list.length) { tbl.appendChild(A.empty('لا مشتركين', onlyEl ? 'لا أحد أكمل كل الدروس بعد.' : 'لا مشتركين نشطين في هذه الدورة.')); return; }
      tbl.appendChild(A.dataTable([
        { label: 'المتدرب', cls: 'ad-first', cell: function (r) { return h('span', { dir: 'auto', text: r.name }); } },
        { label: 'الدروس', cls: 'hide-md', cell: function (r) { return total ? A.num(r.done) + ' / ' + A.num(total) : '—'; } },
        { label: 'التأهّل', cell: function (r) { return r.eligible ? A.badge('مؤهل', 'ok') : A.badge(total ? 'غير مكتمل' : 'بلا دروس', 'mut'); } },
        { label: 'الشهادة', cell: function (r) { return r.cert ? h('span', { class: 'ad-ltr', text: r.cert.code }) : '—'; } },
        { label: '', cls: 'ad-actcol', cell: function (r) {
          if (r.cert) {
            const url = window.location.origin + '/verify/?code=' + r.cert.code;
            return h('div', { class: 'ad-rowact' }, A.link('صفحة التحقق', '/verify/?code=' + r.cert.code, { small: true }),
              A.btn('نسخ الرابط', { small: true, on: function () { try { navigator.clipboard.writeText(url); A.toast('ok', 'نُسخ رابط التحقق.'); } catch (e) { A.toast('err', url); } } }),
              A.btn('إلغاء الشهادة', { small: true, on: async function () {
                const reason = window.prompt('سبب الإلغاء (اختياري):', '');
                if (reason === null) return;
                const ok = await A.confirm({ title: 'إلغاء الشهادة؟', message: 'ستظهر الشهادة «مُلغاة» في التحقق وتختفي من قائمة المتدرب.', ok: 'إلغاء الشهادة', danger: true });
                if (!ok) return;
                try { await P.rest.rpc('cert_revoke', { p_id: r.cert.id, p_reason: reason.trim() || null }); A.toast('ok', 'أُلغيت الشهادة.'); await reload(); } catch (err) { if (A.isSession(err)) { A.lost('expired'); return; } ui.msg(out, 'err', errMsg(err)); }
              } }));
          }
          return A.btn('إصدار الشهادة', { small: true, kind: r.eligible ? 'p' : undefined, on: async function () {
            const ok = await A.confirm({ title: 'إصدار شهادة؟', message: 'ستُصدَر شهادة إتمام «' + course + '» باسم ' + r.name + (r.eligible ? '.' : ' رغم أنه لم يكمل كل الدروس.'), ok: 'إصدار' });
            if (!ok) return;
            try { const res = await P.rest.rpc('cert_issue', { p_user_id: r.uid, p_course_id: course, p_note: null }); A.toast('ok', 'صدرت الشهادة: ' + res.code); await reload(); } catch (err) { if (A.isSession(err)) { A.lost('expired'); return; } ui.msg(out, 'err', errMsg(err)); }
          } });
        } }
      ], list, { caption: 'مشتركو الدورة وشهاداتهم' }));
    }
    paint();
  }

  A.certificates = { render: render };
})();
