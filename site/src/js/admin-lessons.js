/* =====================================================================
   admin-lessons.js — تبويب «الدروس» في مركز الدورة (#courses/<id>/lessons) (للمدير)
   وحدات الدورة ودروسها: كل درس يشير إلى فيديو من «الفيديوهات» ويرفق به ملفات من «الملفات» (لا نسخ للمحتوى).
   العناصر غير المرتبطة بدرس تبقى ظاهرة للمتدرب كما كانت. البيانات من lms_* (الترحيل 016) عبر REST بسياسات RLS للمدير؛
   وسلامة الربط (نفس الدورة، نوع العنصر) تفرضها القاعدة. كل نص يدخل الصفحة بـ textContent.
   ===================================================================== */
(function () {
  'use strict';

  const A = window.Admin;
  if (!A) return;
  const P = A.P;
  const h = A.h;
  const ui = A.ui;

  const nz = function (s) { s = String(s == null ? '' : s).trim(); return s || null; };
  const fmtDur = function (sec) { if (!sec) return '—'; const m = Math.floor(sec / 60); const s = sec % 60; return A.num(m) + ':' + (s < 10 ? '0' : '') + A.num(s) + ' د'; };

  function errMsg(err, ctx) {
    if (!(err instanceof P.ApiError)) return P.MSG.other;
    const c = err.code || '';
    if (err.kind === 'network' || err.kind === 'config' || err.kind === 'server') return err.message;
    if (c === '42501' || err.kind === 'forbidden') return P.MSG.forbidden;
    if (c === '23503') return ctx === 'del-module' ? 'لا يمكن حذف وحدة فيها دروس. انقل دروسها أو احذفها أولًا.' : 'العنصر المرتبط لم يعد موجودًا. حدّث الصفحة ثم أعد المحاولة.';
    if (c === '23514') return 'الفيديو أو الملف المختار لا يخص هذه الدورة أو من نوع غير مناسب.';
    if (c === '23505') return 'هذا الملف مرفق بالدرس مسبقًا.';
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
      P.rest.select('lms_modules', { select: '*', course_id: 'eq.' + course, order: 'sort.asc,created_at.asc', limit: '500' }),
      P.rest.select('lms_lessons', { select: '*', course_id: 'eq.' + course, order: 'sort.asc,created_at.asc', limit: '2000' }),
      P.rest.select('course_items', { select: 'id,kind,title,published', course_id: 'eq.' + course, order: 'sort.asc,created_at.asc', limit: '2000' })
    ]);
    const lessons = r[1];
    let files = [];
    if (lessons.length) files = await A.all('lms_lesson_files', { select: 'lesson_id,item_id,sort', order: 'lesson_id.asc,sort.asc,item_id.asc' });
    const ids = {};
    lessons.forEach(function (l) { ids[l.id] = true; });
    return { modules: r[0], lessons: lessons, items: r[2], files: files.filter(function (f) { return ids[f.lesson_id]; }) };
  }

  /* إعادة ترقيم قائمة بعد تبديل موضعين: لا يُحدَّث إلا ما تغيّر رقمه */
  async function reorder(table, list, i, j) {
    if (j < 0 || j >= list.length) return;
    const arr = list.slice();
    arr.splice(j, 0, arr.splice(i, 1)[0]);
    for (let k = 0; k < arr.length; k++) {
      const want = (k + 1) * 10;
      if (arr[k].sort !== want) await P.rest.update(table, { id: 'eq.' + arr[k].id }, { sort: want });
    }
  }

  async function render(panel, course, token) {
    A.clear(panel);
    panel.appendChild(A.loading('جارٍ تحميل الدروس…'));
    let D;
    try { D = await loadAll(course); } catch (err) {
      if (A.stale(token)) return;
      if (A.isSession(err)) { A.lost('expired'); return; }
      A.clear(panel);
      panel.appendChild(A.fail(A.errText(err), function () { render(panel, course, token); }));
      return;
    }
    if (A.stale(token)) return;
    const reload = function () { return render(panel, course, token); };
    A.clear(panel);

    const videos = D.items.filter(function (i) { return i.kind === 'video'; });
    const fileItems = D.items.filter(function (i) { return i.kind === 'file'; });
    const itemTitle = function (id) { const x = D.items.filter(function (i) { return i.id === id; })[0]; return x ? x.title : ''; };
    const out = A.msgBox();
    const formBox = h('div');

    panel.appendChild(h('p', { class: 'ad-note', text: 'قسّم الدورة إلى وحدات ودروس. الدرس يشير إلى فيديو من «الفيديوهات» ويرفق به ملفات من «الملفات»؛ يظهر للمتدرب بالترتيب مع متابعة مشاهدته. ما لم تربطه بدرس يبقى ظاهرًا للمتدرب في تبويبي «الملفات» و«الفيديوهات» كما كان.' }));
    panel.appendChild(h('div', { class: 'ad-qb-bar' },
      A.btn('وحدة جديدة', { kind: 'p', small: true, icon: 'plus', on: function () { A.clear(formBox); formBox.appendChild(moduleForm(null)); } }),
      A.btn('تحديث', { small: true, icon: 'refresh', on: reload })));
    panel.appendChild(out);
    panel.appendChild(formBox);

    /* ---------- نموذج وحدة ---------- */
    function moduleForm(m) {
      const title = A.input({ max: 300, value: m ? m.title_ar : '', aria: 'عنوان الوحدة' });
      const desc = A.textarea({ rows: 3, max: 3000, value: m && m.description_ar || '' });
      const pub = A.checkbox('منشورة: تظهر للمتدربين المشتركين', m ? m.published : false);
      const o = A.msgBox();
      const save = A.btn(m ? 'حفظ الوحدة' : 'إنشاء الوحدة', { kind: 'p', small: true, type: 'submit' });
      const form = h('form', { class: 'pf-form', novalidate: true, method: 'post', action: '/admin/' },
        A.field('عنوان الوحدة *', title), A.field('وصف', desc), pub.el,
        h('div', { class: 'ad-act' }, save, A.btn('إلغاء', { small: true, on: function () { A.clear(formBox); if (m) reload(); } }), o));
      form.addEventListener('submit', run(save, o, 'module', async function () {
        ui.clearMsg(o);
        const t = title.value.trim();
        if (!t) { ui.msg(o, 'err', 'عنوان الوحدة مطلوب.'); title.focus(); return; }
        const row = { title_ar: t, description_ar: nz(desc.value), published: pub.input.checked };
        let rows;
        if (m) rows = await P.rest.update('lms_modules', { id: 'eq.' + m.id, course_id: 'eq.' + course }, row);
        else rows = await P.rest.insert('lms_modules', Object.assign({ course_id: course, sort: (D.modules.length + 1) * 10 }, row));
        if (!rows.length) throw A.noRows();
        A.toast('ok', m ? 'حُفظت الوحدة.' : 'أُنشئت الوحدة.');
        await reload();
      }));
      return A.card(m ? 'تعديل الوحدة' : 'وحدة جديدة', form);
    }

    /* ---------- نموذج درس ---------- */
    function lessonForm(m, l) {
      const title = A.input({ max: 300, value: l ? l.title_ar : '', aria: 'عنوان الدرس' });
      const desc = A.textarea({ rows: 3, max: 5000, value: l && l.description_ar || '' });
      const vid = A.select([['', '— بلا فيديو —']].concat(videos.map(function (v) { return [v.id, v.title + (v.published ? '' : ' (مسودة)')]; })), l && l.video_item_id || '');
      const dur = A.input({ type: 'number', min: 0, step: 'any', inputmode: 'decimal', value: l && l.duration_seconds ? String(Math.round(l.duration_seconds / 6) / 10) : '', placeholder: 'بالدقائق' });
      const pub = A.checkbox('منشور: يظهر للمتدربين', l ? l.published : false);
      const attached = {};
      D.files.forEach(function (f) { if (l && f.lesson_id === l.id) attached[f.item_id] = true; });
      const boxes = fileItems.map(function (f) { const c = A.checkbox(f.title + (f.published ? '' : ' (مسودة)'), !!attached[f.id]); c.item = f; return c; });
      const o = A.msgBox();
      const save = A.btn(l ? 'حفظ الدرس' : 'إنشاء الدرس', { kind: 'p', small: true, type: 'submit' });
      const form = h('form', { class: 'pf-form', novalidate: true, method: 'post', action: '/admin/' },
        A.field('عنوان الدرس *', title),
        h('div', { class: 'ad-tools' }, A.field('الفيديو', vid, videos.length ? 'من فيديوهات هذه الدورة.' : 'أضف فيديوهات من تبويب «الفيديوهات» أولًا.'), A.field('المدة (دقائق)', dur, 'تُستعمل لحساب التقدم؛ اتركها فارغة إن لم تعرفها.', 'sm')),
        A.field('وصف الدرس', desc),
        fileItems.length ? h('fieldset', { class: 'pf-fieldset' }, h('legend', { text: 'ملفات الدرس' }), boxes.map(function (c) { return c.el; })) : h('p', { class: 'ad-note', text: 'لا ملفات في هذه الدورة بعد لإرفاقها.' }),
        pub.el,
        h('div', { class: 'ad-act' }, save, A.btn('إلغاء', { small: true, on: function () { A.clear(formBox); if (l) reload(); } }), o));
      form.addEventListener('submit', run(save, o, 'lesson', async function () {
        ui.clearMsg(o);
        const t = title.value.trim();
        if (!t) { ui.msg(o, 'err', 'عنوان الدرس مطلوب.'); title.focus(); return; }
        let secs = null;
        if (String(dur.value).trim() !== '') {
          const mins = Number(String(dur.value).replace(',', '.'));
          secs = Math.round(mins * 60);
          if (!Number.isFinite(mins) || secs < 1 || secs > 86400) { ui.msg(o, 'err', 'المدة من دقيقة إلى ٢٤ ساعة (أو اتركها فارغة).'); dur.focus(); return; }
        }
        const siblings = D.lessons.filter(function (x) { return x.module_id === m.id; });
        const row = { title_ar: t, description_ar: nz(desc.value), video_item_id: vid.value || null, duration_seconds: secs, published: pub.input.checked };
        let rows;
        if (l) rows = await P.rest.update('lms_lessons', { id: 'eq.' + l.id, course_id: 'eq.' + course }, row);
        else rows = await P.rest.insert('lms_lessons', Object.assign({ course_id: course, module_id: m.id, sort: (siblings.length + 1) * 10 }, row));
        if (!rows.length) throw A.noRows();
        const lid = rows[0].id;
        const want = boxes.filter(function (c) { return c.input.checked; }).map(function (c) { return c.item.id; });
        const had = Object.keys(attached);
        for (let i = 0; i < had.length; i++) if (want.indexOf(had[i]) === -1) await P.rest.remove('lms_lesson_files', { lesson_id: 'eq.' + lid, item_id: 'eq.' + had[i] });
        for (let i = 0; i < want.length; i++) if (!attached[want[i]]) await P.rest.insert('lms_lesson_files', { lesson_id: lid, item_id: want[i], sort: (i + 1) * 10 });
        A.toast('ok', l ? 'حُفظ الدرس.' : 'أُنشئ الدرس.');
        await reload();
      }));
      return A.card(l ? 'تعديل الدرس' : 'درس جديد في «' + m.title_ar + '»', form);
    }

    /* ---------- قائمة الوحدات ---------- */
    if (!D.modules.length) {
      panel.appendChild(A.empty('لا وحدات بعد', 'اضغط «وحدة جديدة» ثم أضف إليها الدروس.'));
      return;
    }
    D.modules.forEach(function (m, mi) {
      const lessons = D.lessons.filter(function (l) { return l.module_id === m.id; });
      const act = h('div', { class: 'ad-rowact' },
        A.ibtn('up', 'تحريك الوحدة لأعلى', function () { reorder('lms_modules', D.modules, mi, mi - 1).then(reload, fail); }),
        A.ibtn('down', 'تحريك الوحدة لأسفل', function () { reorder('lms_modules', D.modules, mi, mi + 1).then(reload, fail); }),
        A.ibtn('edit', 'تعديل الوحدة', function () { A.clear(formBox); formBox.appendChild(moduleForm(m)); formBox.scrollIntoView(); }),
        A.ibtn('trash', 'حذف الوحدة', async function () {
          const ok = await A.confirm({ title: 'حذف الوحدة؟', message: 'ستُحذف الوحدة «' + m.title_ar + '». لا يمكن حذفها إن كان فيها دروس.', ok: 'حذف', danger: true });
          if (!ok) return;
          try { await P.rest.remove('lms_modules', { id: 'eq.' + m.id }); A.toast('ok', 'حُذفت الوحدة.'); await reload(); } catch (err) { fail(err, 'del-module'); }
        }, 'danger'));
      const body = h('div');
      if (m.description_ar) body.appendChild(h('p', { class: 'ad-note', dir: 'auto', text: m.description_ar }));
      body.appendChild(h('div', { class: 'ad-tools' },
        A.btn('درس جديد', { small: true, icon: 'plus', on: function () { A.clear(formBox); formBox.appendChild(lessonForm(m, null)); formBox.scrollIntoView(); } }),
        h('p', { class: 'ad-count-t', role: 'status', text: 'عدد الدروس: ' + A.num(lessons.length) })));
      if (lessons.length) {
        body.appendChild(A.dataTable([
          { label: '#', cell: function (l, i) { return A.num(i + 1); } },
          { label: 'الدرس', cls: 'ad-first', cell: function (l) { return h('span', { dir: 'auto', text: l.title_ar }); } },
          { label: 'الفيديو', cls: 'hide-md', cell: function (l) { return l.video_item_id ? itemTitle(l.video_item_id) || '—' : '—'; } },
          { label: 'المدة', cls: 'hide-md', cell: function (l) { return fmtDur(l.duration_seconds); } },
          { label: 'الملفات', cls: 'hide-md', cell: function (l) { return A.num(D.files.filter(function (f) { return f.lesson_id === l.id; }).length); } },
          { label: 'الحالة', cell: function (l) { return A.badge(l.published ? 'منشور' : 'مسودة', l.published ? 'ok' : 'mut'); } },
          { label: '', cls: 'ad-actcol', cell: function (l, i) {
            return h('div', { class: 'ad-rowact' },
              A.ibtn('up', 'تحريك لأعلى', function () { reorder('lms_lessons', lessons, i, i - 1).then(reload, fail); }),
              A.ibtn('down', 'تحريك لأسفل', function () { reorder('lms_lessons', lessons, i, i + 1).then(reload, fail); }),
              A.ibtn('edit', 'تعديل الدرس', function () { A.clear(formBox); formBox.appendChild(lessonForm(m, l)); formBox.scrollIntoView(); }),
              A.ibtn('trash', 'حذف الدرس', async function () {
                const ok = await A.confirm({ title: 'حذف الدرس؟', message: 'سيُحذف الدرس «' + l.title_ar + '» وتقدّم المتدربين فيه. الفيديو والملفات نفسها لا تُحذف.', ok: 'حذف', danger: true });
                if (!ok) return;
                try { await P.rest.remove('lms_lessons', { id: 'eq.' + l.id }); A.toast('ok', 'حُذف الدرس.'); await reload(); } catch (err) { fail(err, 'del-lesson'); }
              }, 'danger'));
          } }
        ], lessons, { caption: 'دروس الوحدة' }));
      }
      panel.appendChild(A.card(m.title_ar, [h('div', { class: 'ad-tools' }, A.badge(m.published ? 'منشورة' : 'مسودة', m.published ? 'ok' : 'mut'), act), body]));
    });

    function fail(err, ctx) {
      if (A.isSession(err)) { A.lost('expired'); return; }
      ui.msg(out, 'err', errMsg(err, ctx));
    }
  }

  A.lessons = { render: render };
})();
