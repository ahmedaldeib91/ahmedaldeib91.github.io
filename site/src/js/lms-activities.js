/* =====================================================================
   lms-activities.js — الواجبات والمناقشات في بيئة تعلم المتدرب (الترحيل 020): window.LmsAct
     LmsAct.assignments(courseId, uid)  عنصر «الواجبات»: القائمة ← صفحة الواجب (نص + ملفات، حفظ مسودة، تسليم، الدرجة والملاحظات)
     LmsAct.discussions(courseId)       عنصر «المناقشات»: المواضيع ← صفحة الموضوع والردود، موضوع جديد، حذف ما كتبه المتدرب
   ملف عادي (ES2017) يُحمَّل بـ defer بعد platform-api.js وقبل dashboard.js. الكتابة كلها عبر دوال القاعدة (asg_save_submission, dsc_*)؛
   الملفات تُرفع إلى دلو assignment-files الخاص في مجلد المتدرب نفسه ثم تُسجَّل بالدالة (التي تتحقق من وجودها ونوعها وحجمها وعددها).
   كل نص من القاعدة يدخل الصفحة بـ textContent.
   ===================================================================== */
(function () {
  'use strict';

  const P = window.Platform;
  if (!P) return;
  const ui = P.ui;
  const h = ui.h;
  const clear = ui.clear;
  const BUCKET = 'assignment-files';
  const MAX_BYTES = 20971520;
  const TYPES = { pdf: 'application/pdf', zip: 'application/zip', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', txt: 'text/plain',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };
  const ST = { none: ['لم تُسلِّم بعد', 'soon'], draft: ['مسودة محفوظة', 'soon'], submitted: ['سُلِّم', 'ok'], graded: ['مُصحَّح', 'ok'], returned: ['أُعيد إليك للتعديل', 'soon'] };

  function errText(err, ctx) {
    if (!(err instanceof P.ApiError)) return P.MSG.other;
    const c = err.code || '';
    if (err.kind === 'network' || err.kind === 'config' || err.kind === 'server' || err.kind === 'storage') return err.message;
    if (err.kind === 'session') return P.MSG.session;
    if (c === '55000') return ctx === 'discuss' ? 'هذا الموضوع مقفل ولا يقبل ردودًا جديدة.' : 'لا يمكن تعديل هذا الواجب الآن: إما أنه مُصحَّح أو أُغلق التسليم بعد الموعد.';
    if (c === '22023') return ctx === 'discuss' ? 'اكتب نصًّا صالحًا (العنوان حتى ٢٠٠ حرف، والنص حتى ١٠٠٠٠).' : 'بيانات التسليم غير صالحة: تحقق من عدد الملفات ونوعها وحجمها، ومن أن التسليم ليس فارغًا.';
    if (c === 'P0001' || err.kind === 'rate') return P.MSG.rate;
    if (c === '42501' || err.kind === 'forbidden') return 'ليست لديك صلاحية لهذا الإجراء.';
    return err.message || P.MSG.other;
  }
  const isSession = function (err) { return err instanceof P.ApiError && err.kind === 'session'; };
  const sessionOut = function () { P.goLogin('expired'); };
  const rpc = function (fn, args) { return P.rest.rpc(fn, args || {}); };
  const fmtSize = function (b) { return b >= 1048576 ? (Math.round(b / 104857.6) / 10) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB'; };
  const safeName = function (n) { return String(n).normalize('NFC').replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^\.+/, '').slice(0, 80) || 'file'; };
  const extOf = function (n) { const m = /\.([A-Za-z0-9]{2,5})$/.exec(n || ''); return m ? m[1].toLowerCase() : ''; };
  const note = function (text, kind) { return h('p', { class: 'pf-msg' + (kind ? ' ' + kind : ''), role: 'status', text: text }); };
  const loading = function (t) { return h('p', { class: 'pf-loading', role: 'status', text: t }); };
  const failBox = function (text, retry) {
    const b = h('div', { class: 'pf-block' }, h('p', { class: 'pf-msg err', role: 'alert', text: text }));
    if (retry) b.appendChild(h('button', { type: 'button', class: 'btn s', on: { click: retry } }, 'إعادة المحاولة'));
    return b;
  };
  const dateOnly = function (iso) { return iso ? P.fmtDate(iso) : ''; };

  /* ================================================================== الواجبات */
  function assignments(courseId, uid) {
    const root = h('div');
    async function showList() {
      clear(root);
      root.appendChild(loading('جارٍ تحميل الواجبات…'));
      let list;
      let subs;
      try {
        list = await P.rest.select('asg_assignments', { select: 'id,title_ar,instructions_ar,due_at,max_score,allow_late,allow_text,allow_files,max_files', course_id: 'eq.' + courseId, published: 'eq.true', order: 'due_at.asc.nullslast,created_at.asc' });
        subs = await P.rest.select('asg_submissions', { select: 'id,assignment_id,status,score,feedback,is_late,submitted_at,body', course_id: 'eq.' + courseId, user_id: 'eq.' + uid });
      } catch (err) { if (isSession(err)) { sessionOut(); return; } clear(root); root.appendChild(failBox(errText(err), showList)); return; }
      clear(root);
      const by = {};
      subs.forEach(function (s) { by[s.assignment_id] = s; });
      if (!list.length) { root.appendChild(h('div', { class: 'pf-empty' }, h('b', { text: 'لا توجد واجبات بعد' }), h('p', { text: 'سيضيف المدرب الواجبات لهذه الدورة قريبًا.' }))); return; }
      root.appendChild(h('ul', { class: 'pf-list' }, list.map(function (a) {
        const s = by[a.id];
        const st = ST[s ? s.status : 'none'];
        const late = a.due_at && new Date(a.due_at) < new Date() && (!s || s.status === 'draft' || s.status === 'returned');
        return h('li', { class: 'pf-item' },
          h('div', { class: 'pf-ibody' }, h('h3', { dir: 'auto', text: a.title_ar }),
            h('small', { text: [a.due_at ? 'الموعد: ' + dateOnly(a.due_at) : 'بلا موعد محدد', s && s.status === 'graded' ? 'الدرجة: ' + Number(s.score) + ' / ' + Number(a.max_score) : '', late ? (a.allow_late ? 'تجاوز الموعد (يُقبل متأخرًا)' : 'أُغلق التسليم') : ''].filter(Boolean).join(' · ') })),
          h('span', { class: 'st ' + st[1], text: st[0] }),
          h('button', { type: 'button', class: s && (s.status === 'graded') ? 'btn s' : 'btn p', on: { click: function () { showAssignment(a, s || null); } } }, s && s.status === 'graded' ? 'عرض' : 'فتح'));
      })));
    }

    async function showAssignment(a, s) {
      clear(root);
      root.appendChild(loading('جارٍ التحميل…'));
      let files = [];
      if (s) {
        try { files = await P.rest.select('asg_files', { select: 'id,storage_path,file_name,size_bytes,mime', submission_id: 'eq.' + s.id, order: 'created_at.asc' }); } catch (err) { if (isSession(err)) { sessionOut(); return; } clear(root); root.appendChild(failBox(errText(err), function () { showAssignment(a, s); })); return; }
      }
      clear(root);
      const locked = !!s && s.status === 'graded';
      const closed = !!(a.due_at && new Date(a.due_at) < new Date() && !a.allow_late);
      const out = h('p', { class: 'pf-msg', role: 'status', hidden: true });
      const back = h('button', { type: 'button', class: 'btn s', on: { click: showList } }, ui.icon('back'), 'كل الواجبات');
      const state = { files: files.map(function (f) { return { path: f.storage_path, name: f.file_name, size: Number(f.size_bytes), mime: f.mime, saved: true }; }) };
      const body = h('textarea', { class: 'pf-in', rows: '8', maxlength: '20000', dir: 'auto', 'aria-label': 'نص الإجابة', disabled: locked });
      body.value = s && s.body ? s.body : '';
      const fileList = h('ul', { class: 'pf-list pf-afiles' });
      const picker = h('input', { type: 'file', class: 'pf-in', 'aria-label': 'إرفاق ملف', accept: Object.keys(TYPES).map(function (k) { return '.' + k; }).join(','), disabled: locked });
      const paintFiles = function () {
        clear(fileList);
        state.files.forEach(function (f, i) {
          const open = h('button', { type: 'button', class: 'btn s sm' }, 'فتح');
          open.addEventListener('click', async function () {
            if (!f.saved) return;
            const w = window.open('', '_blank');
            try { const u = await P.storage.signedUrl(BUCKET, f.path, 300); if (w) w.location.replace(u); } catch (err) { if (w) w.close(); out.textContent = errText(err); out.hidden = false; }
          });
          const rm = h('button', { type: 'button', class: 'btn s sm', 'aria-label': 'إزالة ' + f.name }, 'إزالة');
          rm.addEventListener('click', function () { state.files.splice(i, 1); paintFiles(); });
          fileList.appendChild(h('li', { class: 'pf-item' }, h('div', { class: 'pf-ibody' }, h('h3', { dir: 'auto', text: f.name }), h('small', { text: fmtSize(f.size) + (f.saved ? '' : ' · لم يُحفظ بعد') })), f.saved ? open : null, locked ? null : rm));
        });
      };
      paintFiles();
      picker.addEventListener('change', function () {
        const f = picker.files && picker.files[0];
        picker.value = '';
        out.hidden = true;
        if (!f) return;
        const mime = TYPES[extOf(f.name)];
        if (!mime) { out.textContent = 'نوع الملف غير مسموح. المسموح: PDF وWord وExcel وPowerPoint وZIP وصور PNG/JPG ونص.'; out.hidden = false; return; }
        if (f.size > MAX_BYTES) { out.textContent = 'حجم الملف أكبر من ٢٠ ميغابايت.'; out.hidden = false; return; }
        if (state.files.length >= a.max_files) { out.textContent = 'الحد الأقصى ' + a.max_files + ' ملفات لهذا الواجب.'; out.hidden = false; return; }
        state.files.push({ file: f, name: f.name, size: f.size, mime: mime, saved: false });
        paintFiles();
      });

      async function send(submit) {
        out.hidden = true;
        const text = body.value.trim();
        if (submit && !text && !state.files.length) { out.className = 'pf-msg err'; out.textContent = 'أضف نصًّا أو ملفًا قبل التسليم.'; out.hidden = false; return; }
        const payload = [];
        for (let i = 0; i < state.files.length; i++) {
          const f = state.files[i];
          if (!f.saved) {
            const path = courseId + '/' + a.id + '/' + uid + '/' + (window.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + i) + '-' + safeName(f.name);
            await P.storage.upload(BUCKET, path, f.file, { contentType: f.mime });
            f.path = path;
          }
          payload.push({ path: f.path, name: f.name, size: f.size, mime: f.mime });
        }
        const r = await rpc('asg_save_submission', { p_assignment_id: a.id, p_body: text, p_files: payload, p_submit: !!submit });
        return r;
      }
      const draftBtn = h('button', { type: 'button', class: 'btn s', disabled: locked }, 'حفظ مسودة');
      const submitBtn = h('button', { type: 'button', class: 'btn p', disabled: locked || closed }, s && s.status === 'submitted' ? 'إعادة التسليم' : 'تسليم الواجب');
      const act = function (btn, submit) {
        btn.addEventListener('click', async function () {
          if (btn.disabled) return;
          draftBtn.disabled = true; submitBtn.disabled = true;
          try {
            await send(submit);
            const subs = await P.rest.select('asg_submissions', { select: 'id,assignment_id,status,score,feedback,is_late,submitted_at,body', assignment_id: 'eq.' + a.id, user_id: 'eq.' + uid });
            await showAssignment(a, subs[0] || null);
            const m = root.querySelector('.pf-amsg');
            if (m) { m.textContent = submit ? 'تم تسليم الواجب بنجاح.' : 'حُفظت المسودة.'; m.hidden = false; m.className = 'pf-msg ok pf-amsg'; }
          } catch (err) {
            if (isSession(err)) { sessionOut(); return; }
            out.className = 'pf-msg err'; out.textContent = errText(err); out.hidden = false;
            draftBtn.disabled = false; submitBtn.disabled = locked || closed;
          }
        });
      };
      act(draftBtn, false);
      act(submitBtn, true);
      const stt = ST[s ? s.status : 'none'];
      root.appendChild(h('div', { class: 'pf-fade' },
        h('div', { class: 'pf-crumb' }, back),
        h('h3', { dir: 'auto', text: a.title_ar }),
        h('p', { class: 'pf-hint', text: (a.due_at ? 'الموعد: ' + dateOnly(a.due_at) + (closed ? ' — أُغلق التسليم' : (a.allow_late ? ' (يُقبل التسليم المتأخر)' : '')) : 'بلا موعد محدد') + ' · الدرجة الكاملة ' + Number(a.max_score) }),
        a.instructions_ar ? h('div', { class: 'ex-expl', dir: 'auto', text: a.instructions_ar }) : null,
        h('p', null, h('span', { class: 'st ' + stt[1], text: stt[0] }), s && s.is_late ? h('span', { class: 'st soon', text: ' مُسلَّم متأخرًا' }) : null),
        s && s.status === 'graded' ? h('div', { class: 'pf-result' }, h('b', { text: 'درجتك: ' + Number(s.score) + ' / ' + Number(a.max_score) }), s.feedback ? h('p', { dir: 'auto', text: 'ملاحظات المدرب: ' + s.feedback }) : null) : null,
        s && s.status === 'returned' ? h('p', { class: 'pf-msg err', role: 'status', dir: 'auto', text: 'أعاد المدرب الواجب للتعديل' + (s.feedback ? ': ' + s.feedback : '.') + ' عدّل وسلّم من جديد.' }) : null,
        h('p', { class: 'pf-msg pf-amsg', role: 'status', hidden: true }),
        a.allow_text ? h('div', { class: 'pf-field' }, h('label', { text: 'إجابتك' }), body) : null,
        a.allow_files ? h('div', { class: 'pf-field' }, h('label', { text: 'الملفات المرفقة (حتى ' + a.max_files + '، كل ملف حتى ٢٠ ميغابايت)' }), fileList, locked ? null : picker) : null,
        h('div', { class: 'pf-qact' }, draftBtn, submitBtn, out)));
    }

    showList();
    return root;
  }

  /* ================================================================== المناقشات */
  function discussions(courseId) {
    const root = h('div');
    async function showList() {
      clear(root);
      root.appendChild(loading('جارٍ تحميل المناقشات…'));
      let list;
      try { list = await rpc('dsc_list_threads', { p_course_id: courseId }); } catch (err) { if (isSession(err)) { sessionOut(); return; } clear(root); root.appendChild(failBox(errText(err, 'discuss'), showList)); return; }
      clear(root);
      const out = h('p', { class: 'pf-msg err', role: 'alert', hidden: true });
      const title = h('input', { class: 'pf-in', type: 'text', maxlength: '200', dir: 'auto', 'aria-label': 'عنوان الموضوع', placeholder: 'عنوان السؤال أو الموضوع' });
      const text = h('textarea', { class: 'pf-in', rows: '4', maxlength: '10000', dir: 'auto', 'aria-label': 'نص الموضوع', placeholder: 'اكتب سؤالك أو فكرتك' });
      const go = h('button', { type: 'button', class: 'btn p' }, 'نشر الموضوع');
      go.addEventListener('click', async function () {
        out.hidden = true;
        if (!title.value.trim() || !text.value.trim()) { out.textContent = 'اكتب العنوان والنص.'; out.hidden = false; return; }
        go.disabled = true;
        try { const r = await rpc('dsc_create_thread', { p_course_id: courseId, p_lesson_id: null, p_title: title.value.trim(), p_body: text.value.trim() }); showThread(r.thread_id); } catch (err) {
          if (isSession(err)) { sessionOut(); return; }
          out.textContent = errText(err, 'discuss'); out.hidden = false; go.disabled = false;
        }
      });
      const det = h('details', { class: 'pf-newthread' }, h('summary', { text: 'موضوع جديد' }), h('div', { class: 'pf-field' }, title), h('div', { class: 'pf-field' }, text), h('div', { class: 'pf-qact' }, go, out));
      root.appendChild(det);
      if (!list.length) { root.appendChild(h('div', { class: 'pf-empty' }, h('b', { text: 'لا توجد مناقشات بعد' }), h('p', { text: 'ابدأ أول موضوع: اسأل أو شارك فكرة مع زملائك ومدرّبك.' }))); return; }
      root.appendChild(h('ul', { class: 'pf-list' }, list.map(function (t) {
        return h('li', { class: 'pf-item' },
          h('div', { class: 'pf-ibody' }, h('h3', { dir: 'auto', text: (t.pinned ? '📌 ' : '') + t.title }),
            h('small', { dir: 'auto', text: t.author + (t.is_staff ? ' (مدرب)' : '') + ' · ' + t.post_count + ' رد · آخر نشاط ' + dateOnly(t.last_post_at) + (t.locked ? ' · مقفل' : '') })),
          h('button', { type: 'button', class: 'btn s', on: { click: function () { showThread(t.id); } } }, 'فتح'));
      })));
    }

    async function showThread(id) {
      clear(root);
      root.appendChild(loading('جارٍ التحميل…'));
      let d;
      try { d = await rpc('dsc_get_thread', { p_thread_id: id }); } catch (err) { if (isSession(err)) { sessionOut(); return; } clear(root); root.appendChild(failBox(errText(err, 'discuss'), function () { showThread(id); })); root.appendChild(h('button', { type: 'button', class: 'btn s', on: { click: showList } }, 'كل المواضيع')); return; }
      clear(root);
      const t = d.thread;
      const out = h('p', { class: 'pf-msg err', role: 'alert', hidden: true });
      const del = function (kind, pid) {
        return h('button', { type: 'button', class: 'btn s sm', on: { click: async function () {
          if (!window.confirm('حذف هذا المحتوى؟')) return;
          try { await rpc('dsc_delete', { p_kind: kind, p_id: pid }); if (kind === 'thread') showList(); else showThread(id); } catch (err) { if (isSession(err)) { sessionOut(); return; } out.textContent = errText(err, 'discuss'); out.hidden = false; }
        } } }, 'حذف');
      };
      const who = function (x) { return x.author + (x.is_staff ? ' (مدرب)' : '') + ' · ' + dateOnly(x.created_at); };
      const reply = h('textarea', { class: 'pf-in', rows: '4', maxlength: '10000', dir: 'auto', 'aria-label': 'ردّك', placeholder: 'اكتب ردّك' });
      const send = h('button', { type: 'button', class: 'btn p' }, 'إرسال الرد');
      send.addEventListener('click', async function () {
        out.hidden = true;
        if (!reply.value.trim()) { out.textContent = 'اكتب نص الرد.'; out.hidden = false; return; }
        send.disabled = true;
        try { await rpc('dsc_reply', { p_thread_id: id, p_body: reply.value.trim() }); showThread(id); } catch (err) { if (isSession(err)) { sessionOut(); return; } out.textContent = errText(err, 'discuss'); out.hidden = false; send.disabled = false; }
      });
      root.appendChild(h('div', { class: 'pf-fade' },
        h('div', { class: 'pf-crumb' }, h('button', { type: 'button', class: 'btn s', on: { click: showList } }, ui.icon('back'), 'كل المواضيع')),
        h('h3', { dir: 'auto', text: (t.pinned ? '📌 ' : '') + t.title }),
        h('p', { class: 'pf-hint', dir: 'auto', text: who({ author: t.author || 'مستخدم', is_staff: t.is_staff, created_at: t.created_at }) + (t.locked ? ' · مقفل' : '') }),
        h('div', { class: 'ex-expl', dir: 'auto', text: t.body }),
        t.mine || d.can_moderate ? h('div', { class: 'pf-act' }, del('thread', t.id)) : null,
        h('h4', { text: 'الردود (' + d.posts.length + ')' }),
        h('ul', { class: 'pf-list' }, d.posts.map(function (p) {
          return h('li', { class: 'pf-item pf-post' }, h('div', { class: 'pf-ibody' },
            h('small', { dir: 'auto', text: who(p) }),
            p.deleted ? h('p', { class: 'pf-hint', text: 'حُذف هذا الرد.' }) : h('p', { dir: 'auto', class: 'pf-posttext', text: p.body })),
            !p.deleted && (p.mine || d.can_moderate) ? del('post', p.id) : null);
        })),
        t.locked && !d.can_moderate ? note('هذا الموضوع مقفل ولا يقبل ردودًا جديدة.') : h('div', null, h('div', { class: 'pf-field' }, reply), h('div', { class: 'pf-qact' }, send, out)),
        t.locked && !d.can_moderate ? out : null));
    }

    showList();
    return root;
  }

  window.LmsAct = { assignments: assignments, discussions: discussions };
})();
