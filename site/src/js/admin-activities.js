/* =====================================================================
   admin-activities.js — تبويبا «الواجبات» و«المناقشات» في مركز الدورة (#courses/<id>/assignments | /discussions) (للمدير)
   الواجبات: إنشاء/تعديل/نشر/حذف (جدول asg_assignments بسياسات المدير)، ثم «التسليمات»: قائمة المتدربين وحالة كل تسليم، فتح نص الإجابة وملفاتها
   (روابط موقّعة قصيرة العمر من دلو assignment-files)، وتصحيح بدرجة وملاحظة أو إعادة للتعديل عبر asg_grade.
   المناقشات: مواضيع الدورة (dsc_list_threads) ← صفحة الموضوع: تثبيت وقفل وحذف الردود والمواضيع (إشراف) والرد باسم المدرب.
   كل نص يدخل الصفحة بـ textContent.
   ===================================================================== */
(function () {
  'use strict';

  const A = window.Admin;
  if (!A) return;
  const P = A.P;
  const h = A.h;
  const ui = A.ui;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const nz = function (s) { s = String(s == null ? '' : s).trim(); return s || null; };
  const pad = function (n) { return n < 10 ? '0' + n : String(n); };
  const toLocal = function (iso) { if (!iso) return ''; const d = new Date(iso); return isNaN(d) ? '' : d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()); };
  const fromLocal = function (v) { if (!v) return null; const d = new Date(v); return isNaN(d) ? undefined : d.toISOString(); };
  const S_LABEL = { draft: ['مسودة', 'mut'], submitted: ['بانتظار التصحيح', 'warn'], graded: ['مُصحَّح', 'ok'], returned: ['أُعيد للتعديل', 'info'] };
  const fmtSize = function (b) { return b >= 1048576 ? (Math.round(b / 104857.6) / 10) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB'; };

  function errMsg(err) {
    if (!(err instanceof P.ApiError)) return P.MSG.other;
    const c = err.code || '';
    if (err.kind === 'network' || err.kind === 'config' || err.kind === 'server' || err.kind === 'storage') return err.message;
    if (c === '42501' || err.kind === 'forbidden') return P.MSG.forbidden;
    if (c === '22023') return 'قيمة غير صالحة: الدرجة بين ٠ والدرجة الكاملة، والنص ضمن الحدود.';
    if (c === '55000') return 'لا يمكن تنفيذ الإجراء في حالة التسليم الحالية.';
    if (c === '23514') return 'قيمة خارج الحدود: الدرجة الكاملة ١–١٠٠٠، وعدد الملفات ١–٥، ويلزم السماح بالنص أو بالملفات.';
    if (c === '23503') return 'لا يمكن حذف هذا الواجب أو العنصر المرتبط به الآن.';
    if (c === 'P0001' || err.kind === 'rate') return P.MSG.rate;
    return err.message || P.MSG.other;
  }
  function run(btn, out, fn) {
    return A.run(btn, out, async function (e) {
      try { await fn(e); } catch (err) { if (A.isSession(err)) { A.lost('expired'); return; } ui.msg(out, 'err', errMsg(err)); }
    });
  }

  /* ================================================================== الواجبات */
  async function renderAssignments(panel, course, token, o) {
    o = o || {};
    const asgId = UUID.test(o.assignment || '') ? o.assignment : '';
    A.clear(panel);
    panel.appendChild(A.loading('جارٍ تحميل الواجبات…'));
    let list;
    let mods;
    try {
      const r = await Promise.all([
        P.rest.select('asg_assignments', { select: '*', course_id: 'eq.' + course, order: 'created_at.desc', limit: '500' }),
        P.rest.select('lms_modules', { select: 'id,title_ar', course_id: 'eq.' + course, order: 'sort.asc,created_at.asc', limit: '500' })
      ]);
      list = r[0]; mods = r[1];
    } catch (err) {
      if (A.stale(token)) return;
      if (A.isSession(err)) { A.lost('expired'); return; }
      A.clear(panel);
      panel.appendChild(A.fail(A.errText(err), function () { renderAssignments(panel, course, token, o); }));
      return;
    }
    if (A.stale(token)) return;
    A.clear(panel);
    const base = '#courses/' + encodeURIComponent(course) + '/assignments';
    const reload = function () { return renderAssignments(panel, course, token, { assignment: asgId }); };
    const cur = asgId ? list.filter(function (x) { return x.id === asgId; })[0] : null;
    if (asgId && !cur) { panel.appendChild(A.empty('الواجب غير موجود', 'لم نجد هذا الواجب في هذه الدورة.', A.link('كل الواجبات', base, { kind: 'p', icon: 'back' }))); return; }
    if (cur) submissionsPage(panel, course, token, cur, base);
    else listPage(panel, course, list, mods, base, reload);
  }

  function assignmentForm(course, mods, a, onDone, onCancel) {
    const f = {};
    f.title = A.input({ max: 300, value: a ? a.title_ar : '', aria: 'عنوان الواجب' });
    f.ins = A.textarea({ rows: 5, max: 10000, value: a && a.instructions_ar || '' });
    f.due = A.input({ type: 'datetime-local', value: a ? toLocal(a.due_at) : '' });
    f.max = A.input({ type: 'number', min: 1, maxv: 1000, step: 'any', inputmode: 'decimal', value: a ? String(Number(a.max_score)) : '100' });
    f.files = A.input({ type: 'number', min: 1, maxv: 5, step: 1, inputmode: 'numeric', value: a ? String(a.max_files) : '3' });
    f.mod = A.select([['', '— بلا وحدة —']].concat(mods.map(function (m) { return [m.id, m.title_ar]; })), a && a.module_id || '');
    const late = A.checkbox('قبول التسليم بعد الموعد (يُعلَّم متأخرًا)', a ? a.allow_late : true);
    const txt = A.checkbox('السماح بإجابة نصية', a ? a.allow_text : true);
    const fil = A.checkbox('السماح برفع ملفات', a ? a.allow_files : true);
    const pub = A.checkbox('منشور: يراه المتدربون المشتركون', a ? a.published : false);
    const out = A.msgBox();
    const save = A.btn(a ? 'حفظ الواجب' : 'إنشاء الواجب', { kind: 'p', small: true, type: 'submit' });
    const form = h('form', { class: 'pf-form', novalidate: true, method: 'post', action: '/admin/' },
      A.field('عنوان الواجب *', f.title), A.field('التعليمات', f.ins),
      h('div', { class: 'ad-tools' }, A.field('الموعد النهائي (اختياري)', f.due), A.field('الدرجة الكاملة', f.max, null, 'sm'), A.field('أقصى عدد ملفات', f.files, '١–٥', 'sm'), A.field('الوحدة (اختياري)', f.mod)),
      h('div', { class: 'ad-tools' }, late.el, txt.el, fil.el), pub.el,
      h('div', { class: 'ad-act' }, save, A.btn('إلغاء', { small: true, on: onCancel }), out));
    form.addEventListener('submit', run(save, out, async function () {
      ui.clearMsg(out);
      const t = f.title.value.trim();
      if (!t) { ui.msg(out, 'err', 'عنوان الواجب مطلوب.'); f.title.focus(); return; }
      const due = fromLocal(f.due.value);
      if (due === undefined) { ui.msg(out, 'err', 'الموعد غير صالح.'); return; }
      const mx = Number(String(f.max.value).replace(',', '.'));
      const nf = Number(f.files.value);
      if (!(mx > 0 && mx <= 1000)) { ui.msg(out, 'err', 'الدرجة الكاملة رقم من ١ إلى ١٠٠٠.'); return; }
      if (!Number.isInteger(nf) || nf < 1 || nf > 5) { ui.msg(out, 'err', 'عدد الملفات من ١ إلى ٥.'); return; }
      if (!txt.input.checked && !fil.input.checked) { ui.msg(out, 'err', 'اسمح بالنص أو بالملفات على الأقل.'); return; }
      const row = { title_ar: t, instructions_ar: nz(f.ins.value), due_at: due, max_score: mx, max_files: nf, module_id: f.mod.value || null,
        allow_late: late.input.checked, allow_text: txt.input.checked, allow_files: fil.input.checked, published: pub.input.checked };
      let rows;
      if (a) rows = await P.rest.update('asg_assignments', { id: 'eq.' + a.id, course_id: 'eq.' + course }, row);
      else rows = await P.rest.insert('asg_assignments', Object.assign({ course_id: course }, row));
      if (!rows.length) throw A.noRows();
      A.toast('ok', a ? 'حُفظ الواجب.' : 'أُنشئ الواجب.');
      onDone();
    }));
    return A.card(a ? 'تعديل الواجب' : 'واجب جديد', form);
  }

  function listPage(panel, course, list, mods, base, reload) {
    const formBox = h('div');
    const out = A.msgBox();
    panel.appendChild(h('p', { class: 'ad-note', text: 'واجبات الدورة: يسلّم المتدرب نصًّا وملفات (حتى ٢٠ ميغابايت للملف)، وتصحّحها من «التسليمات».' }));
    panel.appendChild(h('div', { class: 'ad-qb-bar' },
      A.btn('واجب جديد', { kind: 'p', small: true, icon: 'plus', on: function () { A.clear(formBox); formBox.appendChild(assignmentForm(course, mods, null, reload, function () { A.clear(formBox); })); } }),
      A.btn('تحديث', { small: true, icon: 'refresh', on: reload })));
    panel.appendChild(out);
    panel.appendChild(formBox);
    if (!list.length) { panel.appendChild(A.empty('لا واجبات بعد', 'اضغط «واجب جديد» لإنشاء أول واجب لهذه الدورة.')); return; }
    panel.appendChild(A.dataTable([
      { label: 'الواجب', cls: 'ad-first', cell: function (a) { return h('a', { class: 'ad-name', dir: 'auto', href: base + '/' + a.id, text: a.title_ar }); } },
      { label: 'الموعد', cls: 'hide-md', cell: function (a) { return a.due_at ? A.fmtDate(a.due_at) : '—'; } },
      { label: 'الدرجة', cls: 'hide-md', cell: function (a) { return A.num(Number(a.max_score)); } },
      { label: 'الحالة', cell: function (a) { return A.badge(a.published ? 'منشور' : 'مسودة', a.published ? 'ok' : 'mut'); } },
      { label: '', cls: 'ad-actcol', cell: function (a) {
        return h('div', { class: 'ad-rowact' }, A.link('التسليمات', base + '/' + a.id, { small: true }),
          A.ibtn('edit', 'تعديل الواجب', function () { A.clear(formBox); formBox.appendChild(assignmentForm(course, mods, a, reload, function () { A.clear(formBox); })); formBox.scrollIntoView(); }),
          A.ibtn('trash', 'حذف الواجب', async function () {
            const ok = await A.confirm({ title: 'حذف الواجب؟', message: 'سيُحذف الواجب «' + a.title_ar + '» مع كل تسليمات المتدربين ودرجاتها. لا يمكن التراجع.', ok: 'حذف', danger: true });
            if (!ok) return;
            try { await P.rest.remove('asg_assignments', { id: 'eq.' + a.id }); A.toast('ok', 'حُذف الواجب.'); await reload(); } catch (err) { if (A.isSession(err)) { A.lost('expired'); return; } ui.msg(out, 'err', errMsg(err)); }
          }, 'danger'));
      } }
    ], list, { caption: 'واجبات الدورة' }));
  }

  async function submissionsPage(panel, course, token, a, base) {
    panel.appendChild(h('div', { class: 'ad-crumb' }, A.link('كل الواجبات', base, { icon: 'back', small: true })));
    panel.appendChild(A.head(a.title_ar, (a.due_at ? 'الموعد: ' + A.fmtDate(a.due_at) + ' · ' : '') + 'الدرجة الكاملة ' + A.num(Number(a.max_score)), [A.badge(a.published ? 'منشور' : 'مسودة', a.published ? 'ok' : 'mut')]));
    const body = h('div');
    panel.appendChild(body);
    body.appendChild(A.loading('جارٍ تحميل التسليمات…'));
    let subs;
    let dir;
    try {
      const r = await Promise.all([
        A.all('asg_submissions', { select: '*', assignment_id: 'eq.' + a.id, order: 'submitted_at.asc.nullslast,created_at.asc' }),
        A.loadDirectory()
      ]);
      subs = r[0]; dir = r[1];
    } catch (err) {
      if (A.stale(token)) return;
      if (A.isSession(err)) { A.lost('expired'); return; }
      A.clear(body); body.appendChild(A.fail(A.errText(err), function () { A.clear(panel); submissionsPage(panel, course, token, a, base); }));
      return;
    }
    if (A.stale(token)) return;
    A.clear(body);
    const name = function (id) { const p = dir.byId[id]; return p && p.full_name ? p.full_name : 'بدون اسم'; };
    const enrolled = dir.enrollments.filter(function (e) { return e.course_id === course && e.status === 'active'; });
    const by = {};
    subs.forEach(function (s) { by[s.user_id] = s; });
    const missing = enrolled.filter(function (e) { return !by[e.user_id] || by[e.user_id].status === 'draft'; }).length;
    body.appendChild(h('p', { class: 'ad-count-t', role: 'status', text: 'تسليمات: ' + A.num(subs.filter(function (s) { return s.status !== 'draft'; }).length) + ' · بانتظار التصحيح: ' + A.num(subs.filter(function (s) { return s.status === 'submitted'; }).length) + ' · لم يسلّم: ' + A.num(missing) }));
    const detail = h('div');
    if (!subs.length) { body.appendChild(A.empty('لا تسليمات بعد', 'تظهر هنا تسليمات المتدربين بمجرد أن يبدؤوا.')); return; }
    body.appendChild(A.dataTable([
      { label: 'المتدرب', cls: 'ad-first', cell: function (s) { return h('span', { dir: 'auto', text: name(s.user_id) }); } },
      { label: 'الحالة', cell: function (s) { const l = S_LABEL[s.status] || [s.status, 'mut']; return h('span', null, A.badge(l[0], l[1]), s.is_late ? A.badge('متأخر', 'err') : null); } },
      { label: 'سُلِّم', cls: 'hide-md', cell: function (s) { return s.submitted_at ? A.fmtDate(s.submitted_at) : '—'; } },
      { label: 'الدرجة', cls: 'hide-md', cell: function (s) { return s.score == null ? '—' : A.num(Number(s.score)) + ' / ' + A.num(Number(a.max_score)); } },
      { label: '', cls: 'ad-actcol', cell: function (s) { return s.status === 'draft' ? null : A.btn('فتح وتصحيح', { small: true, on: function () { openSub(s); } }); } }
    ], subs, { caption: 'تسليمات الواجب' }));
    body.appendChild(detail);

    async function openSub(s) {
      A.clear(detail);
      detail.appendChild(A.loading('جارٍ التحميل…'));
      let files;
      try { files = await P.rest.select('asg_files', { select: 'id,storage_path,file_name,size_bytes,mime', submission_id: 'eq.' + s.id, order: 'created_at.asc' }); } catch (err) {
        if (A.isSession(err)) { A.lost('expired'); return; }
        A.clear(detail); detail.appendChild(A.fail(errMsg(err), function () { openSub(s); })); return;
      }
      A.clear(detail);
      const out = A.msgBox();
      const score = A.input({ type: 'number', min: 0, maxv: Number(a.max_score), step: 'any', inputmode: 'decimal', value: s.score == null ? '' : String(Number(s.score)), aria: 'الدرجة' });
      const fb = A.textarea({ rows: 3, max: 5000, value: s.feedback || '' });
      fb.setAttribute('dir', 'auto');
      const ok = A.btn('حفظ الدرجة', { kind: 'p', small: true, type: 'submit' });
      const ret = A.btn('إعادة للتعديل', { small: true });
      const done = function () { A.clear(panel); renderAssignments(panel, course, token, { assignment: a.id }); };
      const form = h('form', { class: 'pf-form', novalidate: true, method: 'post', action: '/admin/' },
        h('div', { class: 'ad-tools' }, A.field('الدرجة (من ' + A.num(Number(a.max_score)) + ')', score, null, 'sm'), A.field('ملاحظة للمتدرب', fb)),
        h('div', { class: 'ad-act' }, ok, ret, out));
      form.addEventListener('submit', run(ok, out, async function () {
        ui.clearMsg(out);
        const v = Number(String(score.value).replace(',', '.'));
        if (String(score.value).trim() === '' || !Number.isFinite(v) || v < 0 || v > Number(a.max_score)) { ui.msg(out, 'err', 'الدرجة رقم من ٠ إلى ' + A.num(Number(a.max_score)) + '.'); score.focus(); return; }
        await P.rest.rpc('asg_grade', { p_submission_id: s.id, p_score: v, p_feedback: nz(fb.value), p_return: false });
        A.toast('ok', 'حُفظت الدرجة.');
        done();
      }));
      ret.addEventListener('click', run(ret, out, async function () {
        ui.clearMsg(out);
        await P.rest.rpc('asg_grade', { p_submission_id: s.id, p_score: null, p_feedback: nz(fb.value), p_return: true });
        A.toast('ok', 'أُعيد الواجب للمتدرب للتعديل.');
        done();
      }));
      detail.appendChild(A.card('تسليم ' + name(s.user_id), [
        s.body ? h('div', null, h('h4', { text: 'نص الإجابة' }), h('div', { class: 'ad-essay', dir: 'auto', text: s.body })) : h('p', { class: 'ad-note', text: 'لا نص في هذا التسليم.' }),
        files.length ? h('div', null, h('h4', { text: 'الملفات' }), h('ul', { class: 'ad-list' }, files.map(function (f) {
          const b = A.btn('فتح', { small: true, icon: 'external' });
          b.addEventListener('click', async function () {
            const w = window.open('', '_blank');
            try { const u = await P.storage.signedUrl('assignment-files', f.storage_path, 300); if (w) w.location.replace(u); } catch (err) { if (w) w.close(); ui.msg(out, 'err', errMsg(err)); }
          });
          return h('li', null, h('span', { dir: 'auto', text: f.file_name + ' (' + fmtSize(Number(f.size_bytes)) + ') ' }), b);
        }))) : h('p', { class: 'ad-note', text: 'لا ملفات مرفقة.' }),
        form]));
      detail.scrollIntoView();
    }
  }

  /* ================================================================== المناقشات */
  async function renderDiscussions(panel, course, token, o) {
    o = o || {};
    const tid = UUID.test(o.thread || '') ? o.thread : '';
    A.clear(panel);
    panel.appendChild(A.loading('جارٍ التحميل…'));
    let data;
    try { data = tid ? await P.rest.rpc('dsc_get_thread', { p_thread_id: tid }) : await P.rest.rpc('dsc_list_threads', { p_course_id: course, p_limit: 100 }); } catch (err) {
      if (A.stale(token)) return;
      if (A.isSession(err)) { A.lost('expired'); return; }
      A.clear(panel); panel.appendChild(A.fail(errMsg(err), function () { renderDiscussions(panel, course, token, o); }));
      return;
    }
    if (A.stale(token)) return;
    A.clear(panel);
    const base = '#courses/' + encodeURIComponent(course) + '/discussions';
    const reload = function () { return renderDiscussions(panel, course, token, { thread: tid }); };
    if (!tid) {
      panel.appendChild(h('p', { class: 'ad-note', text: 'مناقشات الدورة: تُشرف عليها هنا بتثبيت المواضيع وقفلها وحذف المخالف من المواضيع والردود، ويمكنك الرد باسمك.' }));
      panel.appendChild(h('div', { class: 'ad-qb-bar' }, A.btn('تحديث', { small: true, icon: 'refresh', on: reload }), h('p', { class: 'ad-count-t', role: 'status', text: 'المواضيع: ' + A.num(data.length) })));
      if (!data.length) { panel.appendChild(A.empty('لا مناقشات بعد', 'تظهر هنا المواضيع التي يبدؤها المتدربون.')); return; }
      panel.appendChild(A.dataTable([
        { label: 'الموضوع', cls: 'ad-first', cell: function (t) { return h('a', { class: 'ad-name', dir: 'auto', href: base + '/' + t.id, text: (t.pinned ? '📌 ' : '') + t.title }); } },
        { label: 'الكاتب', cls: 'hide-md', cell: function (t) { return h('span', { dir: 'auto', text: t.author + (t.is_staff ? ' (مدرب)' : '') }); } },
        { label: 'الردود', cell: function (t) { return A.num(t.post_count); } },
        { label: 'آخر نشاط', cls: 'hide-md', cell: function (t) { return A.fmtDate(t.last_post_at); } },
        { label: 'الحالة', cell: function (t) { return t.locked ? A.badge('مقفل', 'warn') : A.badge('مفتوح', 'ok'); } }
      ], data, { caption: 'مواضيع الدورة' }));
      return;
    }
    const t = data.thread;
    panel.appendChild(h('div', { class: 'ad-crumb' }, A.link('كل المواضيع', base, { icon: 'back', small: true })));
    panel.appendChild(A.head(t.title, (t.author || 'مستخدم') + (t.is_staff ? ' (مدرب)' : '') + ' · ' + A.fmtDate(t.created_at), [t.pinned ? A.badge('مثبّت', 'info') : null, t.locked ? A.badge('مقفل', 'warn') : null]));
    const out = A.msgBox();
    const act = function (label, fn, danger) {
      const b = A.btn(label, { small: true });
      b.addEventListener('click', run(b, out, async function () {
        if (danger) { const ok = await A.confirm({ title: label + '؟', message: 'سيُخفى المحتوى عن المتدربين.', ok: label, danger: true }); if (!ok) return; }
        await fn();
      }));
      return b;
    };
    panel.appendChild(h('div', { class: 'ad-qb-bar' },
      act(t.pinned ? 'إلغاء التثبيت' : 'تثبيت', async function () { await P.rest.rpc('dsc_moderate_thread', { p_thread_id: t.id, p_pinned: !t.pinned }); await reload(); }),
      act(t.locked ? 'فتح الموضوع' : 'قفل الموضوع', async function () { await P.rest.rpc('dsc_moderate_thread', { p_thread_id: t.id, p_locked: !t.locked }); await reload(); }),
      act('حذف الموضوع', async function () { await P.rest.rpc('dsc_delete', { p_kind: 'thread', p_id: t.id }); window.location.hash = base; }, true)));
    panel.appendChild(out);
    panel.appendChild(A.card('نص الموضوع', h('div', { class: 'ad-essay', dir: 'auto', text: t.body })));
    panel.appendChild(A.card('الردود (' + A.num(data.posts.length) + ')', data.posts.length ? h('ul', { class: 'ad-list' }, data.posts.map(function (p) {
      return h('li', null, h('small', { dir: 'auto', text: p.author + (p.is_staff ? ' (مدرب)' : '') + ' · ' + A.fmtDate(p.created_at) }),
        p.deleted ? h('p', { class: 'ad-note', text: 'محذوف.' }) : h('div', { class: 'ad-essay', dir: 'auto', text: p.body }),
        p.deleted ? null : act('حذف الرد', async function () { await P.rest.rpc('dsc_delete', { p_kind: 'post', p_id: p.id }); await reload(); }, true));
    })) : h('p', { class: 'ad-note', text: 'لا ردود بعد.' })));
    const reply = A.textarea({ rows: 3, max: 10000, value: '' });
    reply.setAttribute('dir', 'auto');
    const send = A.btn('إرسال الرد', { kind: 'p', small: true });
    send.addEventListener('click', run(send, out, async function () {
      ui.clearMsg(out);
      if (!reply.value.trim()) { ui.msg(out, 'err', 'اكتب نص الرد.'); return; }
      await P.rest.rpc('dsc_reply', { p_thread_id: t.id, p_body: reply.value.trim() });
      await reload();
    }));
    panel.appendChild(A.card('رد باسمك', [A.field('الرد', reply), h('div', { class: 'ad-act' }, send)]));
  }

  A.assignments = { render: renderAssignments };
  A.discussions = { render: renderDiscussions };
})();
