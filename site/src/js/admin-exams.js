/* =====================================================================
   admin-exams.js — قسم «الاختبارات» (#exams ...) في لوحة المدرب: النواة والقائمة وسير العمل (M3b)
   ملف عادي (ES2017) يُحمَّل بـ defer بعد ملفات بنك الأسئلة (admin-qbank*.js) وقبل admin-exams-editor.js وقبل admin.js.
   يعتمد على A.qb (التصنيف والوسوم والأنواع والنوافذ وترجمة الأخطاء) ويسجّل القسم بـ A.register.

   المسارات (hash)
     #exams                         الدورة الأخيرة (أو الأولى) + قائمة اختباراتها
     #exams/<course>/list           القائمة
     #exams/<course>/new            محرر اختبار جديد (admin-exams-editor.js)
     #exams/<course>/edit/<uuid>    تعديل مسودة

   القواعد
   - كل نص من القاعدة أو من المستخدم يدخل الصفحة بـ textContent فقط (h/ui.h).
   - كل انتقال حالة عبر RPC (exam_publish ... exam_unarchive)؛ الصلاحية الحقيقية للقاعدة، والواجهة للراحة فقط (لوحة المدرب للمدير وحده).
   - قبل النشر/طلب الموافقة/الاعتماد يُستدعى exam_preview_pool({exam_id}) لعرض أخطاء التحقق بالعربية (نص خطأ الخادم لا يصل للواجهة).
   - الاختبار المنشور مجمَّد: لتعديله يُسحب من النشر (مسودة) ثم يُعدَّل ويُنشر بإصدار جديد.
   ===================================================================== */
(function () {
  'use strict';

  const A = window.Admin;
  if (!A || !A.qb) return;
  const QB = A.qb;
  const P = A.P;
  const h = A.h;
  const ui = A.ui;
  const doc = document;
  const COURSE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

  const EX = A.ex = { mods: {}, last: '' };

  /* ---------- ثوابت ---------- */
  EX.KIND = [['practice', 'تدريب'], ['simulation', 'محاكاة'], ['final', 'نهائي']];
  EX.FOLDER = [['domain_tests', 'اختبارات المجالات'], ['exam_simulations', 'محاكاة الامتحان']];
  EX.STATUS = [['draft', 'مسودة'], ['pending_approval', 'بانتظار الاعتماد'], ['published', 'منشور'], ['paused', 'متوقف مؤقتًا'], ['archived', 'مؤرشف']];
  EX.STATUS_KIND = { draft: 'info', pending_approval: 'warn', published: 'ok', paused: 'warn', archived: 'mut' };
  EX.POLICY = [['never', 'لا يُعرض'], ['after_submit', 'بعد التسليم'], ['after_close', 'بعد إغلاق الاختبار'], ['manual', 'يدويًا من المدرب']];
  EX.POLICY_LIVE = EX.POLICY.concat([['always', 'أثناء المحاولة (للتدريب فقط)']]);
  EX.TIMEOUT = [['auto_submit', 'تسليم تلقائي عند انتهاء الوقت'], ['void', 'إلغاء المحاولة عند انتهاء الوقت']];
  EX.RESUME = [['resume_any_device', 'استئناف من أي جهاز'], ['resume_same_session', 'استئناف من الجهاز نفسه'], ['no_resume', 'بلا استئناف']];
  EX.ON_EXCEED = [['log', 'تسجيل فقط'], ['warn', 'تحذير المتدرب'], ['flag', 'وسم المحاولة للمراجعة'], ['auto_submit', 'تسليم تلقائي']];
  EX.CODES = {
    no_questions: 'الاختبار بلا أسئلة: أضف أسئلة ثابتة أو قاعدة سحب عشوائي.',
    too_many_questions: 'عدد الأسئلة يتجاوز ٥٠٠.',
    item_inactive: 'يحتوي الاختبار سؤالًا غير مفعّل (مسودة أو معطّل). فعّله أو احذفه من الاختبار.',
    item_in_set: 'يحتوي الاختبار سؤالًا تابعًا لمجموعة سيناريو (غير مدعوم بعد).',
    item_type_disabled: 'يحتوي الاختبار سؤالًا من نوع معطّل.',
    item_out_of_scope: 'يحتوي الاختبار سؤالًا خارج نطاق التصنيف المحدد للاختبار.',
    rule_insufficient: 'أسئلة بنك الدورة لا تكفي إحدى قواعد السحب العشوائي.',
    duration_required: 'مدة الاختبار مطلوبة للمحاكاة والاختبار النهائي.',
    pass_required: 'حدّ النجاح مطلوب للاختبار النهائي (نسبة أو درجة).',
    max_attempts_required: 'عدد المحاولات مطلوب للاختبار النهائي.',
    pass_score_exceeds_total: 'درجة النجاح أكبر من مجموع درجات الاختبار.',
    window_closed: 'وقت الإغلاق مضى. عدّل نافذة الاختبار.',
    window_shorter_than_duration: 'نافذة الاختبار (من الفتح إلى الإغلاق) أقصر من مدة الاختبار.',
    after_close_needs_close_at: 'اخترتَ سياسة «بعد الإغلاق» دون تحديد وقت إغلاق.',
    feedback_needs_review: 'عرض الملاحظات أو الشرح بعد التسليم يتطلب السماح بمراجعة الإجابات.'
  };

  EX.href = function (course, view, extra) { return '#exams/' + encodeURIComponent(course) + '/' + view + (extra ? '/' + encodeURIComponent(extra) : ''); };
  EX.label = function (list, v) { return QB.labelOf(list, v); };
  EX.num = function (n) { const x = Number(n); return Number.isFinite(x) ? A.num(Math.round(x * 100) / 100) : '—'; };

  /* ---------- أخطاء ---------- */
  EX.errMsg = function (err, ctx) {
    if (!(err instanceof P.ApiError)) return P.MSG.other;
    const code = err.code || '';
    if (code === '55000') return ctx === 'save'
      ? 'الاختبار مقفل: يمكن تعديل المسودة وحدها. اسحب الاختبار من النشر أولًا ثم عدّله.'
      : 'حالة الاختبار لا تسمح بهذا الإجراء. حدّث الصفحة ثم أعد المحاولة.';
    if (code === '42501' || err.kind === 'forbidden') return 'لا تملك صلاحية هذا الإجراء على اختبارات هذه الدورة، أو أن الاختبار لم يعد موجودًا.';
    if (code === '22023') return ctx === 'save'
      ? 'رفض الخادم بعض القيم (مدة أو درجات أو سياسات أو أسئلة). راجع النموذج، وتذكّر أن «أثناء المحاولة» للتدريب فقط وأن المراقبة لازمة لخيارات الأمن.'
      : 'تعذّر تنفيذ الإجراء لأن الاختبار غير صالح. استعمل «فحص الاختبار» لمعرفة السبب.';
    if (code === '23503' || code === '23001') return 'أحد العناصر المختارة (سؤال أو تصنيف أو وسم) لا يتبع هذه الدورة أو حُذف. حدّث الصفحة ثم اختر من جديد.';
    if (code === '23514') return ctx === 'save'
      ? 'قيمة خارج الحدود المسموحة (مثلًا: وقت الإغلاق قبل الفتح، أو نسبة النجاح وأيضًا درجة النجاح معًا، أو خيارات الأمن).'
      : 'قيمة خارج الحدود المسموحة.';
    return QB.errMsg(err, ctx);
  };
  EX.say = function (out, err, ctx) {
    const text = EX.errMsg(err, ctx);
    if (out) ui.msg(out, 'err', text); else A.toast('err', text);
  };
  EX.run = function (btn, out, ctx, fn) {
    return A.run(btn, out, async function (e) {
      try { await fn(e); } catch (err) {
        if (A.isSession(err)) { A.lost('expired'); return; }
        if (A.isForbidden(err) || (err && err.code === '42501')) { EX.say(out, err, ctx); return; }
        EX.say(out, err, ctx);
      }
    });
  };
  EX.loadFail = function (box, err, retry) {
    if (A.isSession(err)) { A.lost('expired'); return; }
    A.clear(box);
    box.appendChild(A.fail(EX.errMsg(err, 'list'), retry));
  };

  /* قائمة أخطاء التحقق (من exam_preview_pool) كنص عربي: [{code, ...}] */
  EX.errorLines = function (errors) {
    return (errors || []).map(function (e) {
      const base = Object.prototype.hasOwnProperty.call(EX.CODES, e.code) ? EX.CODES[e.code] : 'خطأ في الاختبار (' + String(e.code) + ').';
      if (e.code === 'rule_insufficient') return 'القاعدة ' + e.position + ': المطلوب ' + e.requested + ' والمتاح ' + e.available + ' فقط. ' + base;
      if (e.code === 'pass_score_exceeds_total') return base + ' (النجاح ' + e.pass_score + ' من ' + e.total_score + ').';
      return base;
    });
  };

  /* فحص الاختبار المحفوظ: يعيد {ok, errors[], count, total} */
  EX.check = async function (examId) {
    const r = await P.rest.rpc('exam_preview_pool', { p: { exam_id: examId } });
    const errors = r && Array.isArray(r.errors) ? r.errors : [];
    return { ok: errors.length === 0, errors: errors, count: r && r.question_count, total: r && r.total_score, raw: r };
  };

  /* نافذة إدخال نص: تعيد النص أو null عند الإلغاء */
  EX.ask = function (o) {
    return new Promise(function (resolve) {
      const prev = doc.activeElement;
      const tid = A.nid('dlg-t');
      const ta = A.textarea({ rows: 3, max: 2000, aria: o.label });
      const err = h('p', { class: 'pf-ferr', hidden: true });
      const ok = h('button', { type: 'button', class: 'btn p' + (o.danger ? ' ad-dangerp' : ''), text: o.ok || 'تأكيد' });
      const cancel = h('button', { type: 'button', class: 'btn s', text: 'إلغاء' });
      const dlg = h('dialog', { class: 'ad-dialog', 'aria-labelledby': tid },
        h('div', { class: 'ad-dlgbody' }, h('h3', { id: tid, text: o.title }),
          o.message ? h('p', { class: 'ad-dlgmsg', text: o.message }) : null,
          A.field(o.label, ta), err,
          h('div', { class: 'btns ad-dlgact' }, cancel, ok)));
      let done = false;
      function end(v) {
        if (done) return;
        done = true;
        try { dlg.close(); } catch (e) { /* مغلقة */ }
        dlg.remove();
        try { if (prev && prev.focus) prev.focus(); } catch (e) { /* تجاهل */ }
        resolve(v);
      }
      ok.addEventListener('click', function () {
        const v = ta.value.trim();
        if (o.required && !v) { err.textContent = 'هذا الحقل مطلوب.'; err.hidden = false; ta.focus(); return; }
        end(v);
      });
      cancel.addEventListener('click', function () { end(null); });
      dlg.addEventListener('cancel', function (e) { e.preventDefault(); end(null); });
      doc.body.appendChild(dlg);
      if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
      ta.focus();
    });
  };

  /* عرض أخطاء التحقق في نافذة */
  EX.showErrors = function (title, errors) {
    const lines = EX.errorLines(errors);
    QB.modal(title, h('ul', { class: 'ad-list' }, lines.map(function (t) { return h('li', { text: t }); })));
  };

  /* ---------- الإجراءات (سير العمل) ---------- */
  /* [مفتاح، التسمية، RPC، يحتاج فحصًا قبله، نوع الزر]. الحالة → الإجراءات المتاحة */
  const ACTIONS = {
    request: ['طلب اعتماد', 'exam_request_approval', true],
    withdraw: ['سحب الطلب', 'exam_withdraw', false],
    approve: ['اعتماد ونشر', 'exam_approve', true],
    reject: ['رفض', 'exam_reject', false],
    publish: ['نشر', 'exam_publish', true],
    pause: ['إيقاف مؤقت', 'exam_pause', false],
    resume: ['استئناف', 'exam_resume', false],
    unpublish: ['سحب من النشر', 'exam_unpublish', false],
    archive: ['أرشفة', 'exam_archive', false],
    unarchive: ['إلغاء الأرشفة', 'exam_unarchive', false]
  };
  const BY_STATUS = {
    draft: ['publish', 'request', 'archive'],
    pending_approval: ['approve', 'reject', 'withdraw'],
    published: ['pause', 'unpublish', 'archive'],
    paused: ['resume', 'unpublish', 'archive'],
    archived: ['unarchive']
  };
  const DONE = {
    exam_request_approval: 'أُرسل الاختبار للاعتماد.', exam_withdraw: 'سُحب الطلب وعاد الاختبار مسودة.',
    exam_approve: 'اعتُمد الاختبار ونُشر بإصدار جديد.', exam_reject: 'رُفض الاختبار وعاد مسودة.',
    exam_publish: 'نُشر الاختبار بإصدار جديد.', exam_pause: 'أُوقف الاختبار مؤقتًا.', exam_resume: 'استؤنف الاختبار.',
    exam_unpublish: 'سُحب الاختبار من النشر وعاد مسودة (الإصدارات السابقة محفوظة).', exam_archive: 'أُرشف الاختبار.', exam_unarchive: 'أُلغيت الأرشفة وعاد الاختبار مسودة.'
  };

  async function runAction(key, row, reload) {
    const def = ACTIONS[key];
    const fn = def[1];
    if (def[2]) {
      const c = await EX.check(row.id);
      if (!c.ok) { EX.showErrors('لا يمكن تنفيذ «' + def[0] + '» قبل إصلاح ما يلي', c.errors); return; }
    }
    const args = { p_exam_id: row.id };
    if (key === 'reject') {
      const reason = await EX.ask({ title: 'رفض الاختبار', label: 'سبب الرفض (إلزامي، يراه صاحب الطلب)', required: true, ok: 'رفض', danger: true });
      if (reason === null) return;
      args.p_reason = reason;
    } else if (key === 'approve' || key === 'request' || key === 'pause' || key === 'unpublish') {
      const note = await EX.ask({ title: def[0] + ': «' + row.title_ar + '»', label: 'ملاحظة (اختيارية)', ok: def[0] });
      if (note === null) return;
      if (note) args.p_note = note;
    } else if (key === 'publish') {
      const ok = await A.confirm({ title: 'نشر الاختبار', message: 'سيُجمَّد محتوى «' + row.title_ar + '» في إصدار جديد، ولا يمكن تعديله إلا بسحبه من النشر.', ok: 'نشر' });
      if (!ok) return;
    } else if (key === 'archive') {
      const ok = await A.confirm({ title: 'أرشفة الاختبار', message: 'سيُخفى «' + row.title_ar + '» عن المتدربين.', ok: 'أرشفة' });
      if (!ok) return;
    }
    await P.rest.rpc(fn, args);
    A.toast('ok', DONE[fn]);
    reload();
  }

  /* ---------- القائمة ---------- */
  async function renderList(panel, course, token) {
    panel.appendChild(A.loading('جارٍ تحميل الاختبارات…'));
    let rows;
    try {
      rows = await P.rest.select('ex_exams', {
        select: 'id,title_ar,exam_kind,folder_kind,status,question_count,total_score,duration_minutes,review_note,updated_at,published_at',
        course_id: 'eq.' + course, order: 'updated_at.desc,id.asc', limit: '300'
      });
    } catch (err) {
      if (A.stale(token)) return;
      EX.loadFail(panel, err, function () { A.clear(panel); renderList(panel, course, token); });
      return;
    }
    if (A.stale(token)) return;
    A.clear(panel);
    const reload = function () { A.clear(panel); renderList(panel, course, token); };
    const out = A.msgBox();
    panel.appendChild(h('div', { class: 'ad-qb-bar' }, A.link('اختبار جديد', EX.href(course, 'new'), { kind: 'p', small: true, icon: 'plus' }),
      A.btn('تحديث', { icon: 'refresh', small: true, on: reload })));
    panel.appendChild(out);
    if (!rows.length) {
      panel.appendChild(A.empty('لا توجد اختبارات بعد', 'أنشئ أول اختبار لهذه الدورة من أسئلة بنكها.'));
      return;
    }
    const cols = [
      { label: 'الاختبار', cell: function (r) {
        return h('div', null, h('strong', { text: r.title_ar }),
          r.review_note ? h('div', { class: 'ad-muted', text: 'ملاحظة المراجعة: ' + r.review_note }) : null);
      } },
      { label: 'النوع', cell: function (r) { return EX.label(EX.KIND, r.exam_kind) + ' · ' + EX.label(EX.FOLDER, r.folder_kind); } },
      { label: 'الحالة', cell: function (r) { return A.badge(EX.label(EX.STATUS, r.status), EX.STATUS_KIND[r.status]); } },
      { label: 'الأسئلة / الدرجة', cell: function (r) { return A.num(r.question_count) + ' / ' + EX.num(r.total_score); } },
      { label: 'آخر تعديل', cell: function (r) { return A.fmtDate(r.updated_at); } },
      { label: 'إجراءات', cell: function (r) {
        const box = h('div', { class: 'ad-rowact' });
        if (r.status === 'draft') box.appendChild(A.link('تعديل', EX.href(course, 'edit', r.id), { small: true, icon: 'pen' }));
        const chk = A.btn('فحص', { small: true, title: 'فحص صلاحية الاختبار للنشر' });
        chk.addEventListener('click', EX.run(chk, out, 'act', async function () {
          const c = await EX.check(r.id);
          if (c.ok) ui.msg(out, 'ok', '«' + r.title_ar + '» صالح للنشر: ' + A.num(c.count) + ' سؤالًا، المجموع ' + EX.num(c.total) + ' درجة.');
          else EX.showErrors('«' + r.title_ar + '» غير جاهز للنشر', c.errors);
        }));
        box.appendChild(chk);
        (BY_STATUS[r.status] || []).forEach(function (k) {
          const b = A.btn(ACTIONS[k][0], { small: true, kind: k === 'reject' || k === 'archive' ? 'danger' : undefined });
          b.addEventListener('click', EX.run(b, out, 'act', function () { return runAction(k, r, reload); }));
          box.appendChild(b);
        });
        return box;
      } }
    ];
    panel.appendChild(A.dataTable(cols, rows, { caption: 'اختبارات الدورة' }));
  }

  /* ---------- القسم ---------- */
  async function render(root, args, token) {
    const courses = await A.loadCourses();
    if (A.stale(token)) return;
    if (!courses.length) {
      root.appendChild(A.head('الاختبارات', null, []));
      root.appendChild(A.empty('لا توجد دورات', 'لا توجد دورات في قاعدة البيانات بعد.'));
      return;
    }
    let course = args[0] || '';
    let view = args[1] || 'list';
    if (!course) {
      course = EX.last && A.courseById(EX.last) ? EX.last : courses[0].id;
      view = 'list';
      QB.replaceHash(EX.href(course, 'list'));
    }
    if (!COURSE_RE.test(course) || !A.courseById(course)) {
      root.appendChild(A.head('الاختبارات', null, []));
      root.appendChild(A.empty('الدورة غير موجودة', 'لم نجد دورة بهذا المعرّف. اختر دورة من القائمة.', A.link('اختيار دورة', '#exams', { kind: 'p', icon: 'back' })));
      return;
    }
    EX.last = course;
    if (view === 'new' || view === 'edit') {
      const m = EX.mods.editor;
      if (!m) throw new P.ApiError('other', 'تعذّر تحميل محرر الاختبارات. حدّث الصفحة ثم أعد المحاولة.', 0, 'module');
      await m.render(root, { course: course, mode: view, id: args[2] || '', token: token });
      return;
    }
    root.appendChild(A.head('الاختبارات', 'ابنِ اختبارات كل دورة من أسئلة بنكها: أسئلة ثابتة و/أو سحب عشوائي بقواعد، ثم انشرها بإصدار مجمَّد.', []));
    const sel = A.select(courses.map(function (c) { return [c.id, c.title_ar + (c.published ? '' : ' (غير منشورة)')]; }), course);
    sel.addEventListener('change', function () { window.location.hash = EX.href(sel.value, 'list'); });
    root.appendChild(h('div', { class: 'ad-tools' }, A.field('الدورة', sel, 'اختبارات كل دورة منفصلة عن غيرها.')));
    const panel = h('div');
    root.appendChild(panel);
    await renderList(panel, course, token);
  }

  A.register('exams', { label: 'الاختبارات', render: render });
})();
