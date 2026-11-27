/* =====================================================================
   admin-courses.js — قسم «الدورات» (#courses و#courses/<id>[/videos|/questions]) في لوحة المدرب
   - القائمة: الدورات الست (من جدول courses) بحالتها وأعداد ملفاتها وفيديوهاتها وأسئلتها واشتراكاتها.
   - صفحة الدورة: الإعدادات (العنوانان والحالة متاحة/قريبًا والنشر) كما تسمح السياسات. تنبيه: صفحة الدورات العامة في الموقع مصدرها
     data/courses.json ولا تتغير من هنا؛ الجدول يخدم لوحة المتدرب والاشتراكات فقط.
   - الملفات: رفع إلى الدلو الخاص course-files بمسار <course_id>/<uuid>-<اسم آمن> (تحقق من النوع pdf/zip/docx/pptx/xlsx/png/jpg ومن الحجم ≤ ٥٠MB
     وشريط تقدّم وإمكانية الإلغاء، ويُحذف الكائن المرفوع إن فشل إدراج الصف)، أو رابط https خارجي.
   - الفيديوهات: رابط https فقط؛ YouTube وVimeo وBunny تُعرض مضمَّنة بنفس دالة لوحة المتدرب (Platform.videoEmbed) وغيرها رابط عادي.
   - الأسئلة: إضافة وتعديل وحذف وترتيب، من ٢ إلى ٦ خيارات، ورقم الإجابة الصحيحة والشرح والنشر، ومعاينة بشكل المتدرب (بلا حفظ).
   - الترتيب: أزرار أعلى/أسفل تعيد ترقيم الدورة بأكملها (١٠، ٢٠، ٣٠…) وتحدّث الصفوف التي تغيّر ترتيبها فقط.
   - الحذف: بنافذة تأكيد؛ يُحذف الصف ثم كائنه من التخزين (إن فشل حذف الكائن يُنبَّه المدرب).
   ===================================================================== */
(function () {
  'use strict';

  const A = window.Admin;
  if (!A) return;
  const P = A.P;
  const h = A.h;
  const ui = A.ui;
  const BUCKET = 'course-files';
  const HOSTS = { 'youtube.com': 'YouTube', 'm.youtube.com': 'YouTube', 'youtu.be': 'YouTube', 'youtube-nocookie.com': 'YouTube', 'vimeo.com': 'Vimeo', 'player.vimeo.com': 'Vimeo', 'iframe.mediadelivery.net': 'Bunny' };
  const hostLabel = function (u) { const host = A.hostOf(u).replace(/^www\./, ''); return HOSTS[host] || host; };

  /* ترتيب: يعيد ترقيم القائمة (١٠، ٢٠، …) ويحدّث ما تغيّر فقط (٤ طلبات متوازية) */
  async function applyOrder(table, ordered) {
    const jobs = [];
    ordered.forEach(function (it, i) { const s = (i + 1) * 10; if (it.sort !== s) jobs.push([it.id, s]); });
    for (let i = 0; i < jobs.length; i += 4) {
      await Promise.all(jobs.slice(i, i + 4).map(function (j) {
        return P.rest.update(table, { id: 'eq.' + j[0] }, { sort: j[1] }).then(function (rows) { if (!rows.length) throw A.noRows(); });
      }));
    }
  }
  const nextSort = function (list) { return list.reduce(function (m, x) { return Math.max(m, Number(x.sort) || 0); }, 0) + 10; };
  function ilink(icon, label, href) {
    return h('a', { class: 'ad-ibtn', href: href, target: '_blank', rel: 'noopener noreferrer', 'aria-label': label, title: label }, A.icon(icon));
  }

  /* ================================================================== قائمة الدورات */
  async function renderList(root, token) {
    const refresh = A.btn('تحديث', { icon: 'refresh', small: true });
    root.appendChild(A.head('الدورات', 'اختر دورة لإدارة اشتراكاتها وملفاتها وفيديوهاتها وبنك أسئلتها ومجلداته واختباراتها. كل دورة منفصلة عن غيرها.', [refresh]));
    const body = h('div');
    root.appendChild(body);

    async function load() {
      A.clear(body);
      body.appendChild(A.loading('جارٍ تحميل الدورات…'));
      refresh.disabled = true;
      let r;
      try {
        r = await Promise.all([
          A.loadCourses(true),
          A.all('course_items', { select: 'id,course_id,kind,published', order: 'id.asc' }),
          A.all('quiz_questions', { select: 'id,course_id,published', order: 'id.asc' }),
          A.all('enrollments', { select: 'id,course_id', status: 'eq.active', order: 'id.asc' })
        ]);
      } catch (err) {
        refresh.disabled = false;
        if (A.stale(token)) return;
        if (A.isSession(err)) { A.lost('expired'); return; }
        A.clear(body);
        body.appendChild(A.fail(A.errText(err), load));
        return;
      }
      refresh.disabled = false;
      if (A.stale(token)) return;
      const n = function (list, id, f) { return list.filter(function (x) { return x.course_id === id && (!f || f(x)); }).length; };
      A.clear(body);
      body.appendChild(h('p', { class: 'ad-note', text: 'تنبيه: عناوين الدورات في صفحة «الدورات» العامة بالموقع تأتي من الملف data/courses.json، أما جدول القاعدة هذا فيربط الاشتراكات والمحتوى ولوحة المتدرب بالمعرّف نفسه.' }));
      body.appendChild(h('div', { class: 'ad-grid' }, r[0].map(function (c) {
        const files = n(r[1], c.id, function (x) { return x.kind === 'file'; });
        const vids = n(r[1], c.id, function (x) { return x.kind === 'video'; });
        const qs = n(r[2], c.id);
        return h('article', { class: 'pf-card ad-ccard' },
          h('h3', { text: c.title_ar }),
          h('div', { class: 'pf-en', text: c.title_en }),
          h('div', { class: 'ad-badges' },
            A.badge(c.published ? 'منشورة' : 'مسودة', c.published ? 'ok' : 'mut'),
            A.badge(c.status === 'available' ? 'متاحة الآن' : 'قريبًا', c.status === 'available' ? 'info' : 'mut')),
          h('ul', { class: 'pf-stats' },
            h('li', null, 'الملفات ', h('b', { text: String(files) })), h('li', null, 'الفيديوهات ', h('b', { text: String(vids) })),
            h('li', null, 'الأسئلة ', h('b', { text: String(qs) + (n(r[2], c.id, function (x) { return x.published; }) !== qs ? ' (' + n(r[2], c.id, function (x) { return x.published; }) + ' منشور)' : '') })),
            h('li', null, 'مشتركون ', h('b', { text: String(n(r[3], c.id)) }))),
          h('div', { class: 'ad-act' }, A.link('إدارة الدورة', '#courses/' + c.id, { kind: 'p', small: true })));
      })));
    }
    refresh.addEventListener('click', load);
    await load();
  }

  /* ================================================================== صفحة الدورة */
  const HUB_TABS = ['subs', 'lessons', 'files', 'videos', 'questions', 'exams', 'grading', 'groups'];
  const Q_SUBS = ['bank', 'folders', 'team', 'quick'];
  async function renderCourse(root, token, id, tabArg, subArg, extraArg) {
    const tab = HUB_TABS.indexOf(tabArg) !== -1 ? tabArg : 'subs';
    root.appendChild(h('div', { class: 'ad-crumb' }, A.link('العودة إلى الدورات', '#courses', { icon: 'back', small: true })));
    const headBox = h('div');
    root.appendChild(headBox);
    headBox.appendChild(A.head('الدورة', null, []));
    const body = h('div');
    root.appendChild(body);
    body.appendChild(A.loading('جارٍ تحميل الدورة…'));
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id) || id.length > 40) { A.clear(body); body.appendChild(A.empty('الدورة غير موجودة', 'الرابط غير صحيح.')); return; }

    const D = { items: [], questions: [] };
    let course = null;
    try {
      const r = await Promise.all([
        A.loadCourses(true),
        P.rest.select('course_items', { select: 'id,course_id,kind,title,url,storage_path,sort,published,created_at', course_id: 'eq.' + id, order: 'sort.asc,created_at.asc' }),
        P.rest.select('quiz_questions', { select: 'id,course_id,question,options,correct_index,explanation,sort,published,created_at', course_id: 'eq.' + id, order: 'sort.asc,created_at.asc' })
      ]);
      course = A.courseById(id);
      D.items = r[1];
      D.questions = r[2];
    } catch (err) {
      if (A.stale(token)) return;
      if (A.isSession(err)) { A.lost('expired'); return; }
      A.clear(body);
      body.appendChild(A.fail(A.errText(err), function () { A.route(); }));
      return;
    }
    if (A.stale(token)) return;
    if (!course) { A.clear(body); body.appendChild(A.empty('الدورة غير موجودة', 'لم نجد هذه الدورة. ارجع إلى قائمة الدورات.')); return; }

    function paintHead() {
      const hadTitleFocus = !!(document.activeElement && document.activeElement.id === 'ad-title');
      A.clear(headBox);
      headBox.appendChild(A.head(course.title_ar, null, [
        A.badge(course.published ? 'منشورة' : 'مسودة', course.published ? 'ok' : 'mut'),
        A.badge(course.status === 'available' ? 'متاحة الآن' : 'قريبًا', course.status === 'available' ? 'info' : 'mut')]));
      const t = A.$('ad-title');
      const sub = h('p', { class: 'sub ad-ltr', text: course.title_en + '  ·  ' + course.id });
      if (t && t.parentNode) t.parentNode.appendChild(sub);
      document.title = course.title_ar + ' | لوحة المدرب';
      if (hadTitleFocus) A.focusTitle();
    }
    paintHead();

    /* ---------- إعدادات الدورة ---------- */
    function settingsCard() {
      const tAr = A.input({ max: 300, value: course.title_ar, required: true });
      const tEn = A.input({ max: 300, value: course.title_en, required: true, ltr: true });
      const status = A.select([['available', 'متاحة الآن'], ['soon', 'قريبًا']], course.status);
      const pub = A.checkbox('منشورة: تظهر الدورة وفقًا لاشتراك المتدرب', course.published, 'إلغاء النشر يحجب محتوى الدورة عن كل المتدربين المشتركين فيها حتى يُعاد نشرها.');
      const out = A.msgBox();
      const btn = A.btn('حفظ الإعدادات', { kind: 'p', small: true, type: 'submit' });
      const form = h('form', { class: 'pf-form', novalidate: true, method: 'post', action: '/admin/' },
        h('div', { class: 'ad-cols' }, A.field('عنوان الدورة بالعربية', tAr), A.field('عنوان الدورة بالإنجليزية', tEn)),
        h('div', { class: 'ad-cols' }, A.field('حالة العرض', status, 'متاحة الآن = يظهر زر «اشترك»، قريبًا = «سجّل اهتمامك».'), pub.el),
        h('div', { class: 'ad-act' }, btn, out));
      A.clearInvalidOnInput(form);
      form.addEventListener('submit', A.run(btn, out, async function () {
        ui.clearMsg(out);
        const bag = {};
        const ar = ui.check(tAr, A.textLen(tAr.value, 1, 300, 'اكتب عنوان الدورة بالعربية (حتى ٣٠٠ حرف).'), bag);
        const en = ui.check(tEn, A.textLen(tEn.value, 1, 300, 'اكتب عنوان الدورة بالإنجليزية (حتى ٣٠٠ حرف).'), bag);
        if (bag.first) { bag.first.focus(); return; }
        if (course.published && !pub.input.checked) {
          const ok = await A.confirm({
            title: 'إلغاء نشر الدورة؟',
            message: 'سيُحجب فورًا كل محتوى «' + course.title_ar + '» (الملفات والفيديوهات والأسئلة) عن جميع المتدربين المشتركين فيها.',
            detail: 'تبقى اشتراكاتهم كما هي، ويعود المحتوى لهم عند إعادة النشر.', ok: 'إلغاء النشر', danger: true
          });
          if (!ok) { pub.input.checked = true; return; }
        }
        const rows = await P.rest.update('courses', { id: 'eq.' + id }, { title_ar: ar, title_en: en, status: status.value, published: pub.input.checked });
        if (!rows.length) throw A.noRows();
        Object.assign(course, rows[0]);
        paintHead();
        ui.msg(out, 'ok', 'تم حفظ إعدادات الدورة.');
      }));
      return A.card('إعدادات الدورة', form);
    }

    /* ---------- ملفات وفيديوهات ---------- */
    async function reloadItems() {
      D.items = await P.rest.select('course_items', { select: 'id,course_id,kind,title,url,storage_path,sort,published,created_at', course_id: 'eq.' + id, order: 'sort.asc,created_at.asc' });
      panels.files.paint();
      panels.videos.paint();
      counts();
    }
    async function reloadQuestions() {
      D.questions = await P.rest.select('quiz_questions', { select: 'id,course_id,question,options,correct_index,explanation,sort,published,created_at', course_id: 'eq.' + id, order: 'sort.asc,created_at.asc' });
      panels.questions.paint();
      counts();
    }

    function itemsPanel(kind) {
      const wrap = h('div');
      const list = function () { return D.items.filter(function (i) { return i.kind === kind; }); };

      function addForm() {
        const title = A.input({ max: 300, placeholder: kind === 'file' ? 'مثال: ملخص الفصل الأول' : 'مثال: شرح مجالات المعرفة' });
        const pub = A.checkbox('نشر فورًا للمتدربين المشتركين', true);
        const out = A.msgBox();
        const prog = A.progress();
        const cancel = A.btn('إلغاء الرفع', { small: true, kind: 'danger' });
        cancel.hidden = true;
        const btn = A.btn(kind === 'file' ? 'إضافة الملف' : 'إضافة الفيديو', { kind: 'p', small: true, type: 'submit', icon: 'plus' });
        let abort = null;
        let srcRadios = null;
        let chooser = null;
        const urlIn = A.input({ type: 'url', max: 2000, ltr: true, placeholder: 'https://…' });
        const urlField = A.field(kind === 'file' ? 'رابط الملف (https)' : 'رابط الفيديو (https)', urlIn,
          kind === 'file' ? 'رابط مباشر لملف على الإنترنت يفتحه المتدرب في تبويب جديد.' : 'YouTube (غير مدرج) أو Vimeo أو Bunny تُعرض مضمَّنة داخل لوحة المتدرب، وأي مضيف آخر يظهر رابطًا عاديًا.');
        const detect = h('p', { class: 'pf-hint', role: 'status' });
        urlIn.addEventListener('input', function () {
          const v = urlIn.value.trim();
          if (kind !== 'video' || !v) { detect.textContent = ''; return; }
          if (!A.isHttps(v)) { detect.textContent = 'الرابط يجب أن يبدأ بـ https://'; return; }
          detect.textContent = P.videoEmbed(A.cleanUrl(v)) ? 'سيُعرض مضمَّنًا من ' + hostLabel(v) + ' داخل لوحة المتدرب.' : 'مضيف «' + hostLabel(v) + '» غير مدعوم للتضمين: سيظهر رابطًا يُفتح في تبويب جديد.';
        });
        const kids = [h('p', { class: 'ad-sub', text: kind === 'file' ? 'أضف ملفًا للدورة برفعه أو برابط خارجي.' : 'أضف فيديو بإدخال رابطه.' }), A.field('العنوان', title)];
        let uploadBox = null;
        if (kind === 'file') {
          chooser = A.fileChooser({ types: A.COURSE_FILE_TYPES, label: 'الملف', hint: 'PDF أو ZIP أو DOCX أو PPTX أو XLSX أو PNG أو JPG، بحد أقصى ٥٠ ميغابايت.' });
          const rid = A.nid('src');
          const mk = function (value, label, on) {
            const i = h('input', { type: 'radio', name: rid, value: value });
            i.checked = on;
            return { i: i, el: h('label', null, i, h('span', { text: label })) };
          };
          const r1 = mk('upload', 'رفع ملف', true);
          const r2 = mk('url', 'رابط خارجي', false);
          srcRadios = [r1.i, r2.i];
          uploadBox = h('div', null, chooser.el, prog.el, cancel);
          urlField.hidden = true;
          const sync = function () { uploadBox.hidden = !r1.i.checked; urlField.hidden = !r2.i.checked; };
          r1.i.addEventListener('change', sync);
          r2.i.addEventListener('change', sync);
          kids.push(h('fieldset', { class: 'ad-radios' }, h('legend', { text: 'مصدر الملف' }), r1.el, r2.el), uploadBox, urlField);
        } else {
          kids.push(urlField, detect);
        }
        kids.push(pub.el, h('div', { class: 'ad-act' }, btn, out));
        const form = h('form', { class: 'pf-form ad-qform', novalidate: true, method: 'post', action: '/admin/' }, kids);
        A.clearInvalidOnInput(form);
        cancel.addEventListener('click', function () { if (abort) abort.abort(); });

        form.addEventListener('submit', A.run(btn, out, async function () {
          ui.clearMsg(out);
          const bag = {};
          const t = ui.check(title, A.textLen(title.value, 1, 300, 'اكتب عنوانًا (حتى ٣٠٠ حرف).'), bag);
          const mode = kind === 'file' ? (srcRadios[0].checked ? 'upload' : 'url') : 'url';
          let picked = null;
          let url = null;
          if (mode === 'upload') {
            picked = chooser.get();
            if (!picked) { chooser.error('اختر ملفًا للرفع.'); if (!bag.first) bag.first = chooser.input; }
          } else if (!A.isHttps(urlIn.value)) {
            ui.fieldError(urlIn, 'اكتب رابطًا صحيحًا يبدأ بـ https://');
            if (!bag.first) bag.first = urlIn;
          } else { ui.fieldError(urlIn, ''); url = kind === 'video' ? A.canonVideoUrl(A.cleanUrl(urlIn.value)) : A.cleanUrl(urlIn.value); }
          if (bag.first || !t) { if (bag.first) bag.first.focus(); return; }

          let path = null;
          let uploaded = false;
          if (picked) {
            path = id + '/' + A.uuid() + '-' + A.safeFileName(picked.file.name);
            abort = typeof AbortController === 'function' ? new AbortController() : null;
            cancel.hidden = false;
            prog.set(0, 1);
            try {
              await P.storage.upload(BUCKET, path, picked.file, { contentType: picked.contentType, onProgress: prog.set, signal: abort ? abort.signal : undefined });
              uploaded = true;
            } finally { cancel.hidden = true; prog.reset(); abort = null; }
          }
          try {
            const rows = await P.rest.insert('course_items', {
              course_id: id, kind: kind, title: t, url: picked ? null : url, storage_path: picked ? path : null,
              sort: nextSort(list()), published: pub.input.checked
            });
            if (!rows.length) throw A.noRows();
          } catch (err) {
            if (uploaded) { try { await P.storage.remove(BUCKET, [path]); } catch (e) { /* تعذّر التراجع: يبقى كائن يتيم غير ظاهر لأحد */ } }
            throw err;
          }
          title.value = '';
          urlIn.value = '';
          pub.input.checked = true;
          if (chooser) chooser.clear();
          detect.textContent = '';
          A.toast('ok', kind === 'file' ? 'تمت إضافة الملف إلى الدورة.' : 'تمت إضافة الفيديو إلى الدورة.');
          await reloadItems(); /* يعيد بناء النموذج */
        }));
        return form;
      }

      function row(it, i, arr) {
        const out = A.msgBox();
        const li = h('li', { class: 'ad-item' + (it.published ? '' : ' off') });
        const src = it.storage_path ? h('span', { class: 'ad-ltr', text: it.storage_path.split('/').slice(1).join('/') }) : h('span', { class: 'ad-ltr', text: hostLabel(it.url || '') });
        li.appendChild(h('span', { class: 'pf-ico' }, A.icon(kind === 'file' ? 'file' : 'video')));
        li.appendChild(h('div', { class: 'ad-ibody' }, h('h4', { text: it.title }),
          h('div', { class: 'meta' }, A.badge(it.published ? 'منشور' : 'مسودة', it.published ? 'ok' : 'mut'), src, h('span', { text: 'الترتيب ' + (i + 1) }))));
        const act = h('div', { class: 'ad-iact' });
        const holder = h('div', { class: 'ad-edit', hidden: true });
        const prev = h('div', { class: 'ad-prev', hidden: true });

        const up = A.ibtn('up', 'تحريك «' + it.title + '» للأعلى', null);
        const down = A.ibtn('down', 'تحريك «' + it.title + '» للأسفل', null);
        up.disabled = i === 0;
        down.disabled = i === arr.length - 1;
        const move = function (delta) {
          return A.run(delta < 0 ? up : down, out, async function () {
            ui.clearMsg(out);
            const o = arr.slice();
            const t = o.splice(i, 1)[0];
            o.splice(i + delta, 0, t);
            /* ترقيم كل عناصر هذا النوع، فيبقى ترتيب النوعين مستقلًا */
            await applyOrder('course_items', o);
            await reloadItems();
          });
        };
        up.addEventListener('click', move(-1));
        down.addEventListener('click', move(1));
        act.appendChild(up);
        act.appendChild(down);

        /* فتح/معاينة */
        if (it.storage_path) {
          const open = A.ibtn('external', 'فتح الملف («' + it.title + '») كما يفتحه المتدرب', null);
          open.addEventListener('click', A.run(open, out, async function () {
            ui.clearMsg(out);
            const w = window.open('', '_blank');
            if (w) { try { w.opener = null; } catch (e) { /* تجاهل */ } }
            try {
              const url = await P.storage.signedUrl(BUCKET, it.storage_path, 300);
              if (w) w.location.replace(url); else ui.msg(out, 'info', 'حُجبت النافذة المنبثقة. اسمح بها ثم أعد المحاولة.');
            } catch (err) { if (w) w.close(); throw err; }
          }));
          act.appendChild(open);
        } else if (it.url && A.isHttps(it.url)) {
          if (kind === 'video' && P.videoEmbed(it.url)) {
            const pv = A.ibtn('eye', 'معاينة «' + it.title + '» كما يراها المتدرب', null);
            pv.addEventListener('click', function () {
              prev.hidden = !prev.hidden;
              if (!prev.hidden && !prev.firstChild) {
                const emb = P.videoEmbed(it.url);
                prev.appendChild(h('div', { class: 'pf-frame' }, h('iframe', {
                  src: emb.src, title: it.title, loading: 'lazy',
                  sandbox: 'allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox',
                  allow: 'encrypted-media; picture-in-picture; fullscreen', referrerpolicy: 'strict-origin-when-cross-origin'
                })));
              }
            });
            act.appendChild(pv);
          }
          act.appendChild(ilink('external', 'فتح الرابط في تبويب جديد', it.url));
        }

        /* نشر / إخفاء */
        const pubBtn = A.btn(it.published ? 'إخفاء' : 'نشر', { small: true, kind: it.published ? 's' : 'p' });
        pubBtn.addEventListener('click', A.run(pubBtn, out, async function () {
          ui.clearMsg(out);
          const rows = await P.rest.update('course_items', { id: 'eq.' + it.id }, { published: !it.published });
          if (!rows.length) throw A.noRows();
          A.toast('ok', it.published ? 'أُخفي العنصر عن المتدربين.' : 'نُشر العنصر للمتدربين المشتركين.');
          await reloadItems();
        }));
        act.appendChild(pubBtn);

        /* تعديل */
        const editBtn = A.btn('تعديل', { small: true });
        editBtn.addEventListener('click', function () {
          if (!holder.hidden) { holder.hidden = true; A.clear(holder); return; }
          holder.hidden = false;
          A.clear(holder);
          holder.appendChild(editForm(it, function () { holder.hidden = true; A.clear(holder); }));
          const first = holder.querySelector('input');
          if (first) first.focus();
        });
        act.appendChild(editBtn);

        /* حذف */
        const del = A.ibtn('trash', 'حذف «' + it.title + '»', null, 'danger');
        del.addEventListener('click', A.run(del, out, async function () {
          ui.clearMsg(out);
          const ok = await A.confirm({
            title: 'حذف «' + it.title + '»؟',
            message: kind === 'file' ? 'سيُحذف الملف من الدورة نهائيًا' + (it.storage_path ? '، ويُحذف أيضًا من التخزين.' : '.') : 'سيُحذف الفيديو من الدورة نهائيًا.',
            detail: 'لا يمكن التراجع عن الحذف.', ok: 'حذف نهائي', danger: true
          });
          if (!ok) return;
          const rows = await P.rest.remove('course_items', { id: 'eq.' + it.id });
          if (!rows.length) throw A.noRows();
          let warn = false;
          if (it.storage_path) {
            try { const gone = await P.storage.remove(BUCKET, [it.storage_path]); warn = !gone.length; } catch (err) { if (A.isSession(err)) throw err; warn = true; }
          }
          A.toast(warn ? 'info' : 'ok', warn ? 'حُذف العنصر لكن تعذّر حذف ملفه من التخزين. راجع التخزين يدويًا إن لزم.' : 'تم حذف العنصر.');
          await reloadItems();
        }));
        act.appendChild(del);
        li.appendChild(act);
        li.appendChild(out);
        li.appendChild(prev);
        li.appendChild(holder);
        return li;
      }

      function editForm(it, done) {
        const title = A.input({ max: 300, value: it.title });
        const sort = A.input({ type: 'number', min: '0', maxv: '100000', step: '1', value: it.sort, ltr: true });
        const pub = A.checkbox('منشور', it.published);
        const urlIn = it.storage_path ? null : A.input({ type: 'url', max: 2000, ltr: true, value: it.url || '' });
        const out = A.msgBox();
        const btn = A.btn('حفظ', { kind: 'p', small: true, type: 'submit' });
        const cancel = A.btn('إلغاء', { small: true, on: done });
        const form = h('form', { class: 'pf-form', novalidate: true, method: 'post', action: '/admin/' },
          h('div', { class: 'ad-cols' }, A.field('العنوان', title), A.field('الترتيب (رقم أصغر = أعلى)', sort)),
          urlIn ? A.field('الرابط (https)', urlIn) : h('p', { class: 'ad-sub', text: 'الملف مرفوع إلى التخزين الخاص ولا يُغيَّر مصدره من هنا؛ احذف العنصر وأضف غيره لاستبداله.' }),
          pub.el,
          h('div', { class: 'ad-act' }, btn, cancel, out));
        A.clearInvalidOnInput(form);
        form.addEventListener('submit', A.run(btn, out, async function () {
          ui.clearMsg(out);
          const bag = {};
          const t = ui.check(title, A.textLen(title.value, 1, 300, 'اكتب عنوانًا (حتى ٣٠٠ حرف).'), bag);
          const sv = Number(sort.value);
          if (!Number.isInteger(sv) || sv < 0 || sv > 100000) { ui.fieldError(sort, 'اكتب رقم ترتيب صحيحًا (٠ إلى ١٠٠٠٠٠).'); if (!bag.first) bag.first = sort; } else ui.fieldError(sort, '');
          const patch = { title: t, sort: sv, published: pub.input.checked };
          if (urlIn) {
            if (!A.isHttps(urlIn.value)) { ui.fieldError(urlIn, 'اكتب رابطًا صحيحًا يبدأ بـ https://'); if (!bag.first) bag.first = urlIn; } else { ui.fieldError(urlIn, ''); patch.url = it.kind === 'video' ? A.canonVideoUrl(A.cleanUrl(urlIn.value)) : A.cleanUrl(urlIn.value); }
          }
          if (bag.first || !t) { if (bag.first) bag.first.focus(); return; }
          const rows = await P.rest.update('course_items', { id: 'eq.' + it.id }, patch);
          if (!rows.length) throw A.noRows();
          A.toast('ok', 'تم حفظ التعديلات.');
          await reloadItems();
        }));
        return form;
      }

      function paint() {
        A.clear(wrap);
        wrap.appendChild(addForm());
        const arr = list();
        if (!arr.length) wrap.appendChild(A.empty(kind === 'file' ? 'لا توجد ملفات في هذه الدورة بعد' : 'لا توجد فيديوهات في هذه الدورة بعد', 'أضف أول عنصر من النموذج أعلاه.'));
        else wrap.appendChild(h('ul', { class: 'ad-list', 'aria-label': kind === 'file' ? 'ملفات الدورة' : 'فيديوهات الدورة' }, arr.map(function (it, i) { return row(it, i, arr); })));
      }
      return { el: wrap, paint: paint };
    }

    /* ---------- الأسئلة المحاكية ---------- */
    function questionsPanel() {
      const wrap = h('div');
      const st = { editing: null, preview: false }; /* editing: null | 'new' | معرّف السؤال */

      function qForm(q) {
        const gid = A.nid('correct');
        const text = A.textarea({ max: 4000, rows: 3, value: q ? q.question : '', placeholder: 'نص السؤال' });
        const expl = A.textarea({ max: 4000, rows: 3, value: q && q.explanation ? q.explanation : '', placeholder: 'شرح الإجابة الصحيحة (يظهر للمتدرب بعد التصحيح)' });
        const pub = A.checkbox('منشور (يراه المتدربون المشتركون)', q ? q.published : true);
        let options = q ? q.options.slice() : ['', ''];
        let correct = q ? q.correct_index : 0;
        const optBox = h('div');
        const out = A.msgBox();
        const btn = A.btn(q ? 'حفظ السؤال' : 'إضافة السؤال', { kind: 'p', small: true, type: 'submit' });
        const cancel = A.btn('إلغاء', { small: true, on: function () { st.editing = null; paint(); } });

        function paintOpts() {
          A.clear(optBox);
          optBox.appendChild(h('p', { class: 'ad-optlegend', id: gid + '-l', text: 'الخيارات (من ٢ إلى ٦)، وحدّد الدائرة بجانب الإجابة الصحيحة' }));
          const grp = h('div', { role: 'radiogroup', 'aria-labelledby': gid + '-l' });
          options.forEach(function (o, i) {
            const radio = h('input', { type: 'radio', name: gid, value: String(i), 'aria-label': 'الخيار ' + (i + 1) + ' هو الإجابة الصحيحة' });
            radio.checked = i === correct;
            radio.addEventListener('change', function () { correct = i; });
            const inp = A.input({ max: 500, value: o, aria: 'نص الخيار ' + (i + 1) });
            inp.addEventListener('input', function () { options[i] = inp.value; });
            const rm = A.ibtn('trash', 'حذف الخيار ' + (i + 1), function () {
              options.splice(i, 1);
              if (correct === i) correct = 0; else if (correct > i) correct -= 1;
              paintOpts();
            }, 'danger');
            rm.disabled = options.length <= 2;
            grp.appendChild(h('div', { class: 'ad-optrow' }, radio, inp, rm));
          });
          optBox.appendChild(grp);
          optBox.appendChild(A.btn('إضافة خيار', { small: true, icon: 'plus', disabled: options.length >= 6, on: function () { options.push(''); paintOpts(); const ins = optBox.querySelectorAll('.ad-optrow input[type="text"]'); if (ins.length) ins[ins.length - 1].focus(); } }));
        }
        paintOpts();

        const form = h('form', { class: 'pf-form ad-qform', novalidate: true, method: 'post', action: '/admin/' },
          h('h4', { text: q ? 'تعديل السؤال' : 'سؤال جديد' }),
          A.field('نص السؤال', text), optBox, A.field('الشرح (اختياري)', expl), pub.el,
          h('div', { class: 'ad-act' }, btn, cancel, out));
        A.clearInvalidOnInput(form);
        form.addEventListener('submit', A.run(btn, out, async function () {
          ui.clearMsg(out);
          const bag = {};
          const qt = ui.check(text, A.textLen(text.value, 1, 4000, 'اكتب نص السؤال (حتى ٤٠٠٠ حرف).'), bag);
          const ex = ui.check(expl, A.textLen(expl.value, 0, 4000, 'الشرح طويل (الحد ٤٠٠٠ حرف).'), bag);
          if (bag.first) { bag.first.focus(); return; }
          const opts = options.map(function (o) { return String(o).trim(); });
          if (opts.length < 2 || opts.length > 6) { ui.msg(out, 'err', 'عدد الخيارات يجب أن يكون من ٢ إلى ٦.'); return; }
          if (opts.some(function (o) { return !o; })) { ui.msg(out, 'err', 'اكتب نصًا لكل خيار أو احذف الخيار الفارغ.'); return; }
          if (new Set(opts.map(function (o) { return A.normAr(o); })).size !== opts.length) { ui.msg(out, 'err', 'الخيارات يجب أن تكون مختلفة عن بعضها.'); return; }
          if (!(correct >= 0 && correct < opts.length)) { ui.msg(out, 'err', 'حدّد الإجابة الصحيحة.'); return; }
          const row = { question: qt, options: opts, correct_index: correct, explanation: ex || null, published: pub.input.checked };
          let rows;
          if (q) rows = await P.rest.update('quiz_questions', { id: 'eq.' + q.id }, row);
          else rows = await P.rest.insert('quiz_questions', Object.assign({ course_id: id, sort: nextSort(D.questions) }, row));
          if (!rows.length) throw A.noRows();
          st.editing = null;
          A.toast('ok', q ? 'تم حفظ السؤال.' : 'تمت إضافة السؤال.');
          await reloadQuestions();
        }));
        return form;
      }

      /* معاينة بشكل المتدرب: الأسئلة المنشورة فقط، بتصحيح محلي لا يُحفظ (نفس أصناف لوحة المتدرب) */
      function previewBlock() {
        const qs = D.questions.filter(function (q) { return q.published; });
        const box = h('div', { class: 'ad-qprev' }, h('h4', { text: 'معاينة كما يراها المتدرب (الأسئلة المنشورة فقط — لا تُحفظ أي نتيجة)' }));
        if (!qs.length) { box.appendChild(h('p', { class: 'ad-sub', text: 'لا توجد أسئلة منشورة لتُعرض.' })); return box; }
        const nn = A.nid('pv');
        const list = h('ol', { class: 'pf-qlist' });
        qs.forEach(function (q, i) {
          const opts = h('div', { class: 'pf-opts' });
          q.options.forEach(function (o, j) {
            const rid = A.nid('pq');
            opts.appendChild(h('label', { class: 'pf-opt', for: rid }, h('input', { type: 'radio', name: nn + '-' + i, id: rid, value: String(j) }), h('span', { class: 'pf-ot', dir: 'auto', text: o })));
          });
          list.appendChild(h('li', { class: 'pf-q' }, h('fieldset', null,
            h('legend', null, h('span', { class: 'qn', text: String(i + 1) }), h('span', { class: 'pf-qtext', dir: 'auto', text: q.question })), opts)));
        });
        list.addEventListener('change', function (e) {
          const r = e.target;
          if (!r || r.type !== 'radio') return;
          Array.prototype.forEach.call(list.querySelectorAll('input[name="' + r.name + '"]'), function (x) { x.parentNode.classList.toggle('on', x.checked); });
        });
        const result = h('div', { hidden: true });
        const out = A.msgBox();
        const btn = A.btn('إنهاء وتصحيح (معاينة)', { kind: 'p', small: true, type: 'submit' });
        const form = h('form', { class: 'pf-form', novalidate: true, method: 'post', action: '/admin/' }, list, h('div', { class: 'ad-act' }, btn, out));
        form.addEventListener('submit', function (e) {
          e.preventDefault();
          const picks = qs.map(function (q, i) { const s = list.querySelector('input[name="' + nn + '-' + i + '"]:checked'); return s ? Number(s.value) : -1; });
          const missing = picks.filter(function (v) { return v < 0; }).length;
          if (missing) { ui.msg(out, 'err', 'أجب عن جميع الأسئلة قبل التصحيح. المتبقي: ' + missing + '.'); return; }
          ui.clearMsg(out);
          let score = 0;
          const review = h('ol', { class: 'pf-qlist pf-review' });
          qs.forEach(function (q, i) {
            const right = picks[i] === q.correct_index;
            if (right) score += 1;
            const opts = h('div', { class: 'pf-opts' });
            q.options.forEach(function (o, j) {
              const isKey = j === q.correct_index;
              const mine = j === picks[i];
              opts.appendChild(h('div', { class: 'pf-opt' + (isKey ? ' good' : '') + (mine && !isKey ? ' bad' : '') },
                h('span', { class: 'pf-ot', dir: 'auto', text: o }),
                mine ? h('span', { class: 'pf-tag ' + (isKey ? 'ok' : 'no'), text: 'إجابتك' }) : null,
                isKey ? h('span', { class: 'pf-tag ok', text: 'الإجابة الصحيحة' }) : null));
            });
            review.appendChild(h('li', { class: 'pf-q ' + (right ? 'right' : 'wrong') },
              h('p', { class: 'pf-qverdict ' + (right ? 'ok' : 'no'), text: right ? 'إجابتك صحيحة' : 'إجابتك غير صحيحة' }),
              h('div', { class: 'pf-qhead' }, h('span', { class: 'qn', text: String(i + 1) }), h('span', { class: 'pf-qtext', dir: 'auto', text: q.question })),
              opts, q.explanation ? h('div', { class: 'pf-expl' }, h('b', { text: 'الشرح: ' }), q.explanation) : null));
          });
          const pc = P.pct(score, qs.length);
          A.clear(result);
          result.appendChild(h('section', { class: 'pf-result' }, h('div', { class: 'big', text: score + ' / ' + qs.length }), h('b', { text: 'نتيجة المعاينة: ' + pc + '%' }), h('p', { text: 'معاينة فقط: لم تُحفظ هذه المحاولة.' })));
          result.appendChild(review);
          result.hidden = false;
          form.hidden = true;
          const again = A.btn('إعادة المعاينة', { small: true, on: function () { st.preview = true; paint(); } });
          result.appendChild(h('div', { class: 'ad-act' }, again));
        });
        box.appendChild(form);
        box.appendChild(result);
        return box;
      }

      function card(q, i, arr) {
        const out = A.msgBox();
        const el = h('li', { class: 'ad-qcard' + (q.published ? '' : ' off') });
        const opts = h('ul', { class: 'ad-qopts' }, q.options.map(function (o, j) {
          const ok = j === q.correct_index;
          return h('li', { class: 'ad-qopt' + (ok ? ' ok' : '') }, h('span', { class: 'ot', dir: 'auto', text: o }), ok ? h('span', { class: 'pf-tag ok', text: 'الصحيحة' }) : null);
        }));
        const up = A.ibtn('up', 'تحريك السؤال ' + (i + 1) + ' للأعلى', null);
        const down = A.ibtn('down', 'تحريك السؤال ' + (i + 1) + ' للأسفل', null);
        up.disabled = i === 0;
        down.disabled = i === arr.length - 1;
        [[up, -1], [down, 1]].forEach(function (pair) {
          pair[0].addEventListener('click', A.run(pair[0], out, async function () {
            ui.clearMsg(out);
            const o = arr.slice();
            const t = o.splice(i, 1)[0];
            o.splice(i + pair[1], 0, t);
            await applyOrder('quiz_questions', o);
            await reloadQuestions();
          }));
        });
        const pubBtn = A.btn(q.published ? 'إخفاء' : 'نشر', { small: true, kind: q.published ? 's' : 'p' });
        pubBtn.addEventListener('click', A.run(pubBtn, out, async function () {
          ui.clearMsg(out);
          const rows = await P.rest.update('quiz_questions', { id: 'eq.' + q.id }, { published: !q.published });
          if (!rows.length) throw A.noRows();
          A.toast('ok', q.published ? 'أُخفي السؤال عن المتدربين.' : 'نُشر السؤال للمتدربين المشتركين.');
          await reloadQuestions();
        }));
        const edit = A.btn('تعديل', { small: true, on: function () { st.editing = q.id; paint(); const f = wrap.querySelector('.ad-qform textarea'); if (f) f.focus(); } });
        const del = A.ibtn('trash', 'حذف السؤال ' + (i + 1), null, 'danger');
        del.addEventListener('click', A.run(del, out, async function () {
          ui.clearMsg(out);
          const ok = await A.confirm({ title: 'حذف السؤال ' + (i + 1) + '؟', message: q.question.slice(0, 160) + (q.question.length > 160 ? '…' : ''), detail: 'سيُحذف نهائيًا من الأسئلة المحاكية. لا يمكن التراجع.', ok: 'حذف نهائي', danger: true });
          if (!ok) return;
          const rows = await P.rest.remove('quiz_questions', { id: 'eq.' + q.id });
          if (!rows.length) throw A.noRows();
          A.toast('ok', 'تم حذف السؤال.');
          await reloadQuestions();
        }));
        el.appendChild(h('div', { class: 'ad-qhead' }, h('span', { class: 'qn', text: String(i + 1) }), h('p', { class: 'ad-qtext', dir: 'auto', text: q.question })));
        el.appendChild(opts);
        if (q.explanation) el.appendChild(h('div', { class: 'ad-qexp' }, h('b', { text: 'الشرح: ' }), q.explanation));
        el.appendChild(h('div', { class: 'ad-qfoot' }, A.badge(q.published ? 'منشور' : 'مسودة', q.published ? 'ok' : 'mut'), h('div', { class: 'ad-iact' }, up, down, pubBtn, edit, del)));
        el.appendChild(out);
        return el;
      }

      function paint() {
        A.clear(wrap);
        const pubN = D.questions.filter(function (q) { return q.published; }).length;
        const add = A.btn('إضافة سؤال', { kind: 'p', small: true, icon: 'plus', on: function () { st.editing = 'new'; st.preview = false; paint(); const f = wrap.querySelector('.ad-qform textarea'); if (f) f.focus(); } });
        const prev = A.btn(st.preview ? 'إخفاء المعاينة' : 'معاينة كمتدرب', { small: true, icon: 'eye', on: function () { st.preview = !st.preview; paint(); } });
        wrap.appendChild(h('div', { class: 'ad-tools' }, add, prev, h('p', { class: 'ad-count-t', role: 'status', text: D.questions.length + ' سؤال (' + pubN + ' منشور)' })));
        if (st.preview) wrap.appendChild(previewBlock());
        if (st.editing === 'new') wrap.appendChild(qForm(null));
        else if (st.editing) {
          const q = D.questions.filter(function (x) { return x.id === st.editing; })[0];
          if (q) wrap.appendChild(qForm(q)); else st.editing = null;
        }
        if (!D.questions.length) wrap.appendChild(A.empty('لا توجد أسئلة محاكية بعد', 'اضغط «إضافة سؤال» لإنشاء أول سؤال اختيار من متعدد بتصحيح وشرح.'));
        else wrap.appendChild(h('ol', { class: 'ad-list', 'aria-label': 'الأسئلة المحاكية' }, D.questions.map(function (q, i) { return card(q, i, D.questions); })));
      }
      return { el: wrap, paint: paint };
    }

    /* ================= مركز الدورة: أقسام الدورة الواحدة =================
       الاشتراكات | الملفات | الفيديوهات | الأسئلة (بنك الأسئلة، المجلدات، الفريق، الأسئلة السريعة) | الاختبارات | المجموعات.
       الأقسام الثقيلة تُحمَّل عند أول فتح فقط. كل قسم يخص هذه الدورة وحدها. المسار: #courses/<id>/<قسم>[/<فرعي>[/<إضافي>]] */
    const panels = { files: itemsPanel('file'), videos: itemsPanel('video'), quick: questionsPanel() };
    const tabLabels = {};
    function tabButton(prefix, name, label, ic, withCount) {
      const c = h('span', { class: 'pf-count' });
      if (withCount) tabLabels[name] = c;
      return h('button', { type: 'button', role: 'tab', id: prefix + 'tab-' + name, 'data-tab': name, 'aria-controls': prefix + 'panel-' + name, 'aria-selected': 'false', tabindex: '-1' }, A.icon(ic), label, withCount ? c : null);
    }
    function counts() {
      tabLabels.files.textContent = '(' + D.items.filter(function (i) { return i.kind === 'file'; }).length + ')';
      tabLabels.videos.textContent = '(' + D.items.filter(function (i) { return i.kind === 'video'; }).length + ')';
      if (tabLabels.quick) tabLabels.quick.textContent = '(' + D.questions.length + ')'; /* يوجد بعد فتح قسم الأسئلة */
    }
    const MAIN = [['subs', 'الاشتراكات', 'userplus'], ['lessons', 'الدروس', 'book'], ['files', 'الملفات', 'file', true], ['videos', 'الفيديوهات', 'video', true],
      ['questions', 'الأسئلة', 'quiz'], ['exams', 'الاختبارات', 'check'], ['grading', 'التصحيح', 'pen'], ['groups', 'المجموعات', 'users']];
    const tabsEl = h('div', { class: 'pf-tabs ad-tabbar', role: 'tablist', 'aria-label': 'أقسام الدورة' },
      MAIN.map(function (t) { return tabButton('c', t[0], t[1], t[2], t[3]); }));
    const holders = {};
    HUB_TABS.forEach(function (n) { holders[n] = h('div'); });
    holders.files.appendChild(panels.files.el);
    holders.videos.appendChild(panels.videos.el);
    A.clear(body);
    body.appendChild(settingsCard());
    body.appendChild(tabsEl);
    HUB_TABS.forEach(function (n) { body.appendChild(h('div', { role: 'tabpanel', id: 'cpanel-' + n, 'aria-labelledby': 'ctab-' + n, hidden: true }, holders[n])); });
    panels.files.paint();
    panels.videos.paint();
    panels.quick.paint();
    counts();

    /* تحميل كسول مع بطاقة خطأ وإعادة محاولة */
    const mounted = {};
    function lazy(key, box, fn) {
      if (mounted[key]) return;
      mounted[key] = true;
      const run = function () {
        A.clear(box);
        let p;
        try { p = Promise.resolve(fn()); } catch (e) { p = Promise.reject(e); }
        p.catch(function (err) {
          if (A.stale(token)) return;
          if (A.isSession(err)) { A.lost('expired'); return; }
          A.clear(box);
          box.appendChild(A.fail(A.errText(err), run));
        });
      };
      run();
    }

    /* الأسئلة: أقسام فرعية. بنك الأسئلة/المجلدات/الفريق من وحدات بنك الأسئلة؛ «الأسئلة السريعة» أسئلة المحاكاة الحالية في لوحة المتدرب */
    const Q_NAMES = { bank: 'بنك الأسئلة', folders: 'المجلدات', team: 'الفريق', quick: 'الأسئلة السريعة' };
    const Q_ICONS = { bank: 'quiz', folders: 'book', team: 'users', quick: 'file' };
    const Q_MOD = { bank: 'list', folders: 'taxonomy', team: 'staff' };
    let qSub = Q_SUBS.indexOf(subArg) !== -1 ? subArg : 'bank';
    function mountQuestions() {
      if (mounted.questions) return;
      mounted.questions = true;
      const qTabs = h('div', { class: 'pf-tabs ad-tabbar', role: 'tablist', 'aria-label': 'أقسام الأسئلة' },
        Q_SUBS.map(function (n) { return tabButton('cq', n, Q_NAMES[n], Q_ICONS[n], n === 'quick'); }));
      const qHold = {};
      Q_SUBS.forEach(function (n) { qHold[n] = h('div', { role: 'tabpanel', id: 'cqpanel-' + n, 'aria-labelledby': 'cqtab-' + n, hidden: true }); });
      qHold.quick.appendChild(panels.quick.el);
      holders.questions.appendChild(h('p', { class: 'ad-note', text: 'بنك أسئلة هذه الدورة منفصل عن بقية الدورات. أنشئ المجلدات والمجلدات الفرعية من «المجلدات»، ثم أضف أسئلتك ووزّعها عليها من «بنك الأسئلة».' }));
      holders.questions.appendChild(qTabs);
      Q_SUBS.forEach(function (n) { holders.questions.appendChild(qHold[n]); });
      counts();
      const qctl = ui.tabs(qTabs, {
        onSelect: function (name) {
          qSub = name;
          try { window.history.replaceState(null, '', '#courses/' + id + '/questions/' + name); } catch (e) { /* تجاهل */ }
          if (name === 'quick') return;
          lazy('q-' + name, qHold[name], function () {
            const QB = A.qb;
            if (!QB || !QB.mods[Q_MOD[name]]) throw new P.ApiError('other', 'تعذّر تحميل قسم بنك الأسئلة. حدّث الصفحة ثم أعد المحاولة.', 0, 'module');
            return QB.mods[Q_MOD[name]].render(qHold[name], { course: id, token: token, extra: name === 'bank' ? (extraArg || '') : '' });
          });
        }
      });
      qctl.select(qSub, false);
    }

    const ctl = ui.tabs(tabsEl, {
      onSelect: function (name) {
        if (name === 'questions') {
          mountQuestions();
          try { window.history.replaceState(null, '', '#courses/' + id + '/questions/' + qSub); } catch (e) { /* تجاهل */ }
          return;
        }
        try { window.history.replaceState(null, '', '#courses/' + id + '/' + name); } catch (e) { /* تجاهل */ }
        if (name === 'groups') {
          lazy('groups', holders.groups, function () {
            if (!A.groups) throw new P.ApiError('other', 'تعذّر تحميل قسم المجموعات. حدّث الصفحة ثم أعد المحاولة.', 0, 'module');
            return A.groups.render(holders.groups, id, token, { group: subArg, section: extraArg });
          });
        } else if (name === 'grading') {
          lazy('grading', holders.grading, function () {
            if (!A.grading) throw new P.ApiError('other', 'تعذّر تحميل قسم التصحيح. حدّث الصفحة ثم أعد المحاولة.', 0, 'module');
            return A.grading.render(holders.grading, id, token, { attempt: subArg });
          });
        } else if (name === 'lessons') {
          lazy('lessons', holders.lessons, function () {
            if (!A.lessons) throw new P.ApiError('other', 'تعذّر تحميل قسم الدروس. حدّث الصفحة ثم أعد المحاولة.', 0, 'module');
            return A.lessons.render(holders.lessons, id, token);
          });
        } else if (name === 'subs') lazy('subs', holders.subs, function () { return A.enrollRender(holders.subs, [], token, { course: id }); });
        else if (name === 'exams') {
          lazy('exams', holders.exams, function () {
            if (!A.ex || !A.ex.renderList) throw new P.ApiError('other', 'تعذّر تحميل قسم الاختبارات. حدّث الصفحة ثم أعد المحاولة.', 0, 'module');
            return A.ex.renderList(holders.exams, id, token);
          });
        }
      }
    });
    ctl.select(tab, false);
  }

  A.register('courses', {
    label: 'الدورات',
    render: async function (root, args, token) {
      if (args[0]) await renderCourse(root, token, args[0], args[1], args[2], args[3]); else await renderList(root, token);
    }
  });
})();
