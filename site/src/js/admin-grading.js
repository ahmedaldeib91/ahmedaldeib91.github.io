/* =====================================================================
   admin-grading.js — تبويب «التصحيح» في مركز الدورة (#courses/<id>/grading) (للمدير أو المصحّح بصلاحية grading)
   المحاولات المسلَّمة وفيها أسئلة مقالية بانتظار الدرجة (الترحيل 019): قائمة الانتظار ← صفحة المحاولة: لكل مقال نص إجابة المتدرب مع معيار
   التصحيح والإجابة النموذجية (للمصحّح وحده)، وخانة درجة (٠ إلى درجة السؤال) وملاحظة. عند تصحيح آخر مقال تُحسب درجة المحاولة ونتيجتها
   وتظهر للمتدرب بحسب سياسة النتائج. يمكن إعادة تعديل درجة مقال بعد اكتمال التصحيح (تُعاد الحسبة).
   عبر RPC: exam_grading_queue / exam_grading_get / exam_grade_item. كل نص يدخل الصفحة بـ textContent.
   ===================================================================== */
(function () {
  'use strict';

  const A = window.Admin;
  if (!A) return;
  const P = A.P;
  const h = A.h;
  const ui = A.ui;
  const words = function (t) { const m = String(t || '').trim().match(/\S+/g); return m ? m.length : 0; };

  function errMsg(err) {
    if (!(err instanceof P.ApiError)) return P.MSG.other;
    const c = err.code || '';
    if (err.kind === 'network' || err.kind === 'config' || err.kind === 'server') return err.message;
    if (c === '42501' || err.kind === 'forbidden') return 'لا تملك صلاحية التصحيح في هذه الدورة.';
    if (c === '22023') return 'الدرجة يجب أن تكون بين ٠ ودرجة السؤال، والملاحظة حتى ٢٠٠٠ حرف.';
    if (c === '55000') return 'لا يوجد ما يُصحَّح في هذه المحاولة.';
    if (c === 'P0001' || err.kind === 'rate') return P.MSG.rate;
    return err.message || P.MSG.other;
  }
  const num = function (v) { return v == null ? '—' : A.num(Number(v)); };

  async function render(panel, course, token, o) {
    o = o || {};
    const attemptId = /^[0-9a-f-]{36}$/i.test(o.attempt || '') ? o.attempt : '';
    A.clear(panel);
    panel.appendChild(A.loading('جارٍ التحميل…'));
    let data;
    try { data = attemptId ? await P.rest.rpc('exam_grading_get', { p_attempt_id: attemptId }) : await P.rest.rpc('exam_grading_queue', { p_course_id: course }); } catch (err) {
      if (A.stale(token)) return;
      if (A.isSession(err)) { A.lost('expired'); return; }
      A.clear(panel);
      panel.appendChild(A.fail(errMsg(err), function () { render(panel, course, token, o); }));
      return;
    }
    if (A.stale(token)) return;
    A.clear(panel);
    const base = '#courses/' + encodeURIComponent(course) + '/grading';
    if (attemptId) detail(panel, course, token, data, base);
    else queue(panel, data, base, function () { render(panel, course, token, {}); });
  }

  function queue(panel, rows, base, reload) {
    panel.appendChild(h('p', { class: 'ad-note', text: 'محاولات المتدربين التي تنتظر تصحيح أسئلة مقالية. لا تظهر نتيجة المحاولة للمتدرب قبل اكتمال تصحيحها.' }));
    panel.appendChild(h('div', { class: 'ad-qb-bar' }, A.btn('تحديث', { small: true, icon: 'refresh', on: reload }), h('p', { class: 'ad-count-t', role: 'status', text: 'بانتظار التصحيح: ' + A.num(rows.length) })));
    if (!rows.length) { panel.appendChild(A.empty('لا محاولات بانتظار التصحيح', 'تظهر هنا المحاولات التي تتضمن أسئلة مقالية بعد تسليمها.')); return; }
    panel.appendChild(A.dataTable([
      { label: 'المتدرب', cls: 'ad-first', cell: function (r) { return h('span', { dir: 'auto', text: r.trainee }); } },
      { label: 'الاختبار', cell: function (r) { return h('span', { dir: 'auto', text: r.exam_title + ' (محاولة ' + A.num(r.attempt_no) + ')' }); } },
      { label: 'سُلِّمت', cls: 'hide-md', cell: function (r) { return A.fmtDate(r.submitted_at); } },
      { label: 'مقالات متبقية', cell: function (r) { return A.badge(A.num(r.pending), 'warn'); } },
      { label: '', cls: 'ad-actcol', cell: function (r) { return A.link('تصحيح', base + '/' + r.attempt_id, { kind: 'p', small: true }); } }
    ], rows, { caption: 'محاولات بانتظار التصحيح' }));
  }

  function detail(panel, course, token, d, base) {
    panel.appendChild(h('div', { class: 'ad-crumb' }, A.link('كل المحاولات', base, { icon: 'back', small: true })));
    panel.appendChild(A.head('تصحيح محاولة', d.trainee + ' · محاولة ' + A.num(d.attempt_no), [
      A.badge(d.grading_status === 'pending' ? 'بانتظار التصحيح' : 'مكتمل', d.grading_status === 'pending' ? 'warn' : 'ok'),
      d.score != null ? A.badge(num(d.score) + ' / ' + num(d.max_score) + ' (' + num(d.percent) + '%)', d.passed === false ? 'err' : 'ok') : null]));
    const status = h('p', { class: 'ad-count-t', role: 'status' });
    panel.appendChild(status);
    (d.items || []).forEach(function (it) {
      const score = A.input({ type: 'number', min: 0, maxv: it.points, step: 'any', inputmode: 'decimal', value: it.final_score == null ? '' : String(it.final_score), aria: 'درجة السؤال ' + it.position });
      const note = A.textarea({ rows: 3, max: 2000, value: it.grader_note || '' });
      note.setAttribute('dir', 'auto');
      const out = A.msgBox();
      const save = A.btn(it.final_score == null ? 'حفظ الدرجة' : 'تحديث الدرجة', { kind: 'p', small: true, type: 'submit' });
      const w = words(it.response);
      const lim = [it.min_words ? 'الحد الأدنى ' + it.min_words : '', it.max_words ? 'الحد الأقصى ' + it.max_words : ''].filter(Boolean).join(' · ');
      const form = h('form', { class: 'pf-form', novalidate: true, method: 'post', action: '/admin/' },
        h('div', { class: 'ad-tools' }, A.field('الدرجة (من ' + num(it.points) + ')', score, null, 'sm'), A.field('ملاحظة للمتدرب (اختيارية)', note)),
        h('div', { class: 'ad-act' }, save, out));
      form.addEventListener('submit', A.run(save, out, async function () {
        ui.clearMsg(out);
        const v = Number(String(score.value).replace(',', '.'));
        if (String(score.value).trim() === '' || !Number.isFinite(v) || v < 0 || v > Number(it.points)) { ui.msg(out, 'err', 'الدرجة رقم من ٠ إلى ' + num(it.points) + '.'); score.focus(); return; }
        try {
          const r = await P.rest.rpc('exam_grade_item', { p_attempt_id: d.attempt_id, p_position: it.position, p_score: v, p_note: note.value.trim() || null });
          ui.msg(out, 'ok', 'حُفظت الدرجة.');
          save.lastChild.textContent = 'تحديث الدرجة';
          if (r && r.done) { status.textContent = 'اكتمل تصحيح المحاولة: ' + num(r.score) + ' / ' + num(r.max_score) + ' (' + num(r.percent) + '%).'; A.toast('ok', 'اكتمل تصحيح المحاولة.'); }
          else if (r) status.textContent = 'مقالات متبقية: ' + A.num(r.pending_left);
        } catch (err) {
          if (A.isSession(err)) { A.lost('expired'); return; }
          ui.msg(out, 'err', errMsg(err));
        }
      }));
      panel.appendChild(A.card('السؤال ' + A.num(it.position), [
        h('p', { class: 'ad-qstem', dir: 'auto', text: it.stem }),
        h('h4', { text: 'إجابة المتدرب (' + A.num(w) + ' كلمة' + (lim ? ' — ' + lim : '') + ')' }),
        h('div', { class: 'ad-essay', dir: 'auto', text: it.response || '' }),
        it.rubric ? h('details', null, h('summary', { text: 'معيار التصحيح' }), h('p', { dir: 'auto', class: 'ad-essay', text: it.rubric })) : null,
        it.model_answer ? h('details', null, h('summary', { text: 'الإجابة النموذجية' }), h('p', { dir: 'auto', class: 'ad-essay', text: it.model_answer })) : null,
        form]));
    });
  }

  A.grading = { render: render };
})();
