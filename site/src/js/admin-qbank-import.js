/* =====================================================================
   admin-qbank-import.js — واجهة استيراد وتصدير الأسئلة في «بنك الأسئلة»: A.qb.mods.io
   تُفتح من أزرار «استيراد» و«تصدير» في تبويب الأسئلة (admin-qbank-list.js). الصيغ والتحويل في admin-qbank-io.js.
   الاستيراد: اختيار الملف ← تحليل ومعاينة ← استيراد الصالح فقط ← تقرير نهائي. كل سؤال يمرّ بمدقّق المحرر نفسه ثم بـ qb_save_question
   (الحفظ سؤالًا سؤالًا، فلا يُفقد الصالح بسبب غير الصالح). الحد: ٢ ميغابايت و٥٠٠ سؤال في الملف الواحد، وحدّ الحفظ في القاعدة ١٢٠ في الدقيقة (يُبطَّأ تلقائيًا).
   الأسئلة المستوردة تُنشأ «مسودة» افتراضيًا. التصدير: أسئلة الدورة الحالية فقط (بتصفية الحالة والمجلد).
   كل نص يدخل الصفحة بـ textContent.
   ===================================================================== */
(function () {
  'use strict';

  const A = window.Admin;
  if (!A || !A.qb || !A.qb.io) return;
  const QB = A.qb;
  const P = A.P;
  const h = A.h;
  const ui = A.ui;
  const M = QB.model;
  const IO = QB.io;
  const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  const FORMAT_HELP = {
    aiken: 'Aiken: سؤال ثم خياراته «A. …» ثم «ANSWER: B»، وسطر فارغ بين الأسئلة. إجابة واحدة (أكثر من إجابة تتحول إلى اختيار متعدد).',
    gift: 'GIFT: ‎{=الصحيح ~خاطئ}‎ للاختيار، ‎{TRUE}‎ لصح/خطأ، ‎{=س -> ص}‎ للمطابقة. الأنواع الأخرى (قصير، مقالي، رقمي) تُعرض في التقرير ولا تُستورد.',
    moodle: 'Moodle XML: أسئلة multichoice وtruefalse وmatching. وسوم HTML تتحول إلى نص عادي والصور لا تُستورد.',
    csv: 'CSV (UTF-8): الأعمدة type وquestion وoption_a… وcorrect وexplanation وpoints وdifficulty. حمّل القالب للتفاصيل. لملف Excel: احفظه بصيغة CSV UTF-8.'
  };
  const fmtLabel = function (f) { return IO.FORMATS.filter(function (x) { return x[0] === f; }).map(function (x) { return x[1]; })[0] || f; };

  /* ================================================================== استيراد */
  function importCard(course, o) {
    const tax = o.tax;
    const file = h('input', { type: 'file', class: 'ad-file', accept: '.txt,.gift,.aiken,.xml,.csv,text/plain,text/csv,application/xml,text/xml', 'aria-label': 'ملف الأسئلة' });
    const fmt = A.select([['auto', 'تحديد تلقائي']].concat(IO.FORMATS), 'auto');
    const folder = A.select([['', '— بلا مجلد —']].concat(tax.rows.map(function (n) { return [n.id, tax.pathText(n.id)]; })), '');
    const status = A.select([['draft', 'مسودة (موصى به)'], ['active', 'مفعّل']], 'draft');
    const diff = A.select(QB.DIFF, 'medium');
    const out = A.msgBox();
    const help = h('p', { class: 'ad-note', role: 'note' });
    const analyze = A.btn('تحليل الملف ومعاينته', { kind: 'p', small: true, icon: 'search' });
    const tpl = A.btn('قالب CSV', { small: true, icon: 'file', on: function () { A.download('questions-template.csv', IO.csvTemplate(), 'text/csv'); } });
    const preview = h('div');
    const body = h('div');
    let items = [];
    let used = 'aiken';

    const showHelp = function () { const f = fmt.value === 'auto' ? '' : fmt.value; help.textContent = f ? FORMAT_HELP[f] : 'الصيغ المدعومة: Aiken وGIFT وMoodle XML وCSV. يُحدَّد النوع تلقائيًا من امتداد الملف ومحتواه.'; };
    fmt.addEventListener('change', showHelp);
    showHelp();

    analyze.addEventListener('click', A.run(analyze, out, async function () {
      ui.clearMsg(out);
      A.clear(preview);
      items = [];
      const f = file.files && file.files[0];
      if (!f) { ui.msg(out, 'err', 'اختر ملف الأسئلة أولًا.'); return; }
      if (f.size > IO.LIMITS.bytes) { ui.msg(out, 'err', 'الملف أكبر من ٢ ميغابايت. قسّمه إلى ملفات أصغر.'); return; }
      const text = await f.text();
      if (text.indexOf('�') >= 0) ui.msg(out, 'warn', 'يبدو أن ترميز الملف ليس UTF-8: قد تظهر الحروف العربية مشوّهة. احفظه بترميز UTF-8 وأعد المحاولة.');
      used = fmt.value === 'auto' ? IO.detect(text, f.name) : fmt.value;
      if (!used) { ui.msg(out, 'err', 'تعذّر تحديد صيغة الملف. اخترها من القائمة يدويًا.'); return; }
      items = IO.check(IO.parse(text, used), course);
      if (items.length > IO.LIMITS.questions) { ui.msg(out, 'err', 'الملف يحتوي ' + A.num(items.length) + ' سؤالًا والحد ' + A.num(IO.LIMITS.questions) + ' في الملف الواحد. قسّمه.'); items = []; return; }
      paintPreview();
    }));

    function paintPreview() {
      A.clear(preview);
      const ready = items.filter(function (i) { return i.s; });
      const bad = items.filter(function (i) { return !i.s; });
      preview.appendChild(h('p', { class: 'ad-count-t', role: 'status', text: 'الصيغة: ' + fmtLabel(used) + ' · إجمالي ' + A.num(items.length) + ' · جاهز ' + A.num(ready.length) + ' · بأخطاء ' + A.num(bad.length) }));
      const shown = items.slice(0, 300);
      if (items.length > shown.length) preview.appendChild(h('p', { class: 'ad-note', text: 'تُعرض أول ٣٠٠ نتيجة فقط؛ الاستيراد يشمل كل الأسئلة الجاهزة.' }));
      preview.appendChild(A.dataTable([
        { label: '#', cell: function (it) { return A.num(it.n); } },
        { label: 'السؤال', cls: 'ad-first', cell: function (it) { return h('span', { dir: 'auto', text: it.title || '—' }); } },
        { label: 'النوع', cls: 'hide-md', cell: function (it) { return it.type ? QB.typeLabel(it.type) : '—'; } },
        { label: 'الحالة', cell: function (it) {
          if (!it.s) return h('div', null, A.badge('خطأ', 'err'), h('div', { class: 'ad-note' }, it.errs.map(function (e) { return h('div', { dir: 'auto', text: e }); })));
          return h('div', null, A.badge(it.warns.length ? 'جاهز مع تنبيه' : 'جاهز', it.warns.length ? 'warn' : 'ok'), it.warns.length ? h('div', { class: 'ad-note' }, it.warns.map(function (e) { return h('div', { dir: 'auto', text: e }); })) : null);
        } }
      ], shown, { caption: 'معاينة الأسئلة المستوردة' }));
      if (!ready.length) { preview.appendChild(A.empty('لا أسئلة صالحة للاستيراد', 'صحّح الأخطاء أعلاه في الملف ثم حلّله من جديد.')); return; }
      const go = A.btn('استيراد ' + A.num(ready.length) + ' سؤالًا صالحًا' + (bad.length ? ' (وتجاهل ' + A.num(bad.length) + ' بأخطاء)' : ''), { kind: 'p', small: true, icon: 'plus' });
      const cancel = A.btn('إيقاف', { small: true });
      cancel.hidden = true;
      const prog = h('p', { class: 'ad-count-t', role: 'status' });
      preview.appendChild(h('div', { class: 'ad-act' }, go, cancel, prog));
      const rep = h('div');
      preview.appendChild(rep);
      let stop = false;
      cancel.addEventListener('click', function () { stop = true; cancel.disabled = true; });
      go.addEventListener('click', A.run(go, out, async function () {
        ui.clearMsg(out);
        stop = false;
        cancel.hidden = false;
        cancel.disabled = false;
        const failed = [];
        let ok = 0;
        let dups = 0;
        let done = 0;
        for (let i = 0; i < ready.length && !stop; i++) {
          const it = ready[i];
          const s = Object.assign({}, it.s, { status: it.statusSet || status.value, difficulty: it.diffSet ? it.s.difficulty : diff.value });
          const req = M.buildRequest(s, course, null);
          req.taxonomy_id = folder.value || null;
          let tries = 0;
          for (;;) {
            try {
              const res = await P.rest.rpc('qb_save_question', { p: req });
              ok++;
              if (res && res.duplicates > 0) dups++;
              break;
            } catch (err) {
              if (A.isSession(err)) { A.lost('expired'); return; }
              if ((err && (err.code === 'P0001' || err.kind === 'rate')) && tries < 3) { tries++; prog.textContent = 'بلغنا حدّ الحفظ في الدقيقة: انتظار قصير ثم المتابعة…'; await sleep(30000); continue; }
              failed.push({ it: it, msg: QB.errMsg(err, 'save') });
              break;
            }
          }
          done++;
          prog.textContent = 'تقدّم الاستيراد: ' + A.num(done) + ' / ' + A.num(ready.length);
          await sleep(550);
        }
        cancel.hidden = true;
        go.hidden = true;
        QB.drop(course);
        A.clear(rep);
        const lines = [h('p', { role: 'status', class: 'ad-count-t', text: (stop ? 'أُوقف الاستيراد. ' : '') + 'تم استيراد ' + A.num(ok) + ' من ' + A.num(ready.length) + ' سؤالًا صالحًا.' })];
        if (dups) lines.push(h('p', { class: 'ad-note', text: A.num(dups) + ' سؤالًا منها يطابق محتواه سؤالًا موجودًا في البنك (تحقق من التكرار بتصفية «المحتوى المطابق»).' }));
        if (stop) lines.push(h('p', { class: 'ad-note', text: 'الأسئلة التي لم تُعالَج لم تُستورد؛ أعد تحليل الملف لاستيراد الباقي (قد تتكرر المستوردة).' }));
        if (bad.length) lines.push(h('p', { class: 'ad-note', text: A.num(bad.length) + ' سؤالًا لم يُستورد بسبب أخطاء في الملف (مذكورة في المعاينة أعلاه).' }));
        if (failed.length) {
          lines.push(h('p', { class: 'ad-note', text: 'فشل حفظ ' + A.num(failed.length) + ' سؤالًا:' }));
          lines.push(h('ul', { class: 'ad-list' }, failed.map(function (f) { return h('li', { dir: 'auto', text: '#' + f.it.n + ' ' + f.it.title + ' — ' + f.msg }); })));
        }
        rep.appendChild(A.card('تقرير الاستيراد', lines));
        A.toast(ok ? 'ok' : 'err', 'استُورد ' + A.num(ok) + ' سؤالًا.');
        if (o.onDone) o.onDone();
      }));
    }

    body.appendChild(help);
    body.appendChild(h('div', { class: 'ad-tools' }, A.field('الملف', file, 'حتى ٢ ميغابايت و٥٠٠ سؤال.'), A.field('الصيغة', fmt, null, 'sm')));
    body.appendChild(h('div', { class: 'ad-tools' },
      A.field('المجلد المستهدف', folder, 'تُنسب إليه كل الأسئلة المستوردة.'), A.field('الحالة', status, 'المسودة لا تدخل الاختبارات قبل تفعيلها.', 'sm'), A.field('الصعوبة الافتراضية', diff, 'لما لا تحدده الصيغة.', 'sm')));
    body.appendChild(h('div', { class: 'ad-act' }, analyze, tpl, out));
    body.appendChild(preview);
    return A.card('استيراد أسئلة', body);
  }

  /* ================================================================== تصدير */
  function exportCard(course, o) {
    const tax = o.tax;
    const fmt = A.select([['gift', 'GIFT'], ['moodle', 'Moodle XML'], ['aiken', 'Aiken'], ['csv', 'CSV']], 'gift');
    const status = A.select([['all', 'كل الحالات']].concat(QB.STATUS), 'all');
    const folder = A.select([['', 'كل الأسئلة']].concat(tax.rows.map(function (n) { return [n.id, tax.pathText(n.id)]; })), '');
    const out = A.msgBox();
    const go = A.btn('تصدير', { kind: 'p', small: true, icon: 'file' });
    const note = h('p', { class: 'ad-note', text: 'يُصدَّر الإصدار الحالي لكل سؤال بإجاباته الصحيحة وشرحه؛ احفظ الملف في مكان آمن. الأنواع غير المدعومة في الصيغة (والصور) تُعدّ في الرسالة ولا تُصدَّر.' });
    go.addEventListener('click', A.run(go, out, async function () {
      ui.clearMsg(out);
      const q = {
        select: 'id,status,qb_question_versions!qb_questions_current_version_fkey!inner(id,type_code,payload,lang,points,weight,difficulty,taxonomy_id)',
        course_id: 'eq.' + course, order: 'created_at.asc,id.asc'
      };
      if (status.value !== 'all') q.status = 'eq.' + status.value;
      if (folder.value) q['qb_question_versions.taxonomy_id'] = 'in.(' + tax.subtree(folder.value).join(',') + ')';
      let rows;
      let keys;
      try {
        rows = await A.all('qb_questions', q);
        keys = await A.all('qb_question_keys', { select: 'version_id,key,feedback_correct,feedback_incorrect,explanation,option_explanations,reference', course_id: 'eq.' + course, order: 'version_id.asc' });
      } catch (err) {
        if (A.isSession(err)) { A.lost('expired'); return; }
        ui.msg(out, 'err', QB.errMsg(err, 'list'));
        return;
      }
      const kBy = {};
      keys.forEach(function (k) { kBy[k.version_id] = k; });
      const states = [];
      let unsupported = 0;
      rows.forEach(function (r) {
        const v = Array.isArray(r.qb_question_versions) ? r.qb_question_versions[0] : r.qb_question_versions;
        const k = v ? kBy[v.id] : null;
        if (!v || !k || M.SUPPORTED.indexOf(v.type_code) === -1 || v.type_code === 'graphic') { unsupported++; return; }
        try { states.push(M.fromRows(r, v, k, [], tax)); } catch (e) { unsupported++; }
      });
      if (!states.length) { ui.msg(out, 'err', 'لا توجد أسئلة قابلة للتصدير بهذه التصفية.'); return; }
      const res = { gift: IO.toGift, moodle: IO.toMoodle, aiken: IO.toAiken, csv: IO.toCsv }[fmt.value](states);
      if (!res.count) { ui.msg(out, 'err', 'لا توجد أسئلة تدعمها صيغة ' + fmtLabel(fmt.value) + ' بهذه التصفية.'); return; }
      const d = new Date();
      const stamp = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
      A.download('questions-' + course + '-' + stamp + '.' + res.ext, res.text, res.mime);
      const skipped = res.skipped + unsupported;
      ui.msg(out, 'ok', 'صُدّر ' + A.num(res.count) + ' سؤالًا بصيغة ' + fmtLabel(fmt.value) + (skipped ? '، وتخطّى ' + A.num(skipped) + ' (نوع غير مدعوم في الصيغة أو سؤال مصوّر).' : '.'));
    }));
    return A.card('تصدير أسئلة', [
      note,
      h('div', { class: 'ad-tools' }, A.field('الصيغة', fmt, null, 'sm'), A.field('الحالة', status, null, 'sm'), A.field('المجلد', folder)),
      h('div', { class: 'ad-act' }, go, out)
    ]);
  }

  QB.mods.io = { importCard: importCard, exportCard: exportCard };
})();
