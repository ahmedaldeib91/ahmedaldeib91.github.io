/* =====================================================================
   admin-enrollments.js — قسم «الاشتراكات» (#enrollments) في لوحة المدرب، وتبويب «الاشتراكات» داخل مركز الدورة
   (١) إضافة اشتراك: اختر الدورة ثم ابحث عن المتدربين بالاسم أو البريد أو الهاتف وحدّد واحدًا أو أكثر واضغط «اشتراك المحدّدين».
       تُنفَّذ الطلبات واحدًا بعد الآخر (كل منح يُسجَّل في سجل التدقيق)؛ من كان مشتركًا يُتخطى، ومن كان اشتراكه ملغى/معلّقًا/موقوفًا يُعاد تفعيله.
       ولكل اشتراك جديد يُرسَل بريد ترحيب للمتدرب (وظيفة send-mail) أثناء متابعة بقية المنح، ولا يُفشل البريدُ الاشتراكَ أبدًا.
       مع الترحيل 023 (dir.ext): نوع الاشتراك (مدفوع/مجاني/مجاملة) وتاريخا البداية والنهاية يُطبَّقان على الدفعة كلها.
   (٢) كل الاشتراكات: تصفية بالحالة (نشط، معلّق، موقوف، منتهٍ، لم يبدأ، ملغى) والدورة والنوع والبحث، وترتيب وصفحات، وعدّادات الحالات،
       وإجراءات حسب الحالة: قبول المعلّق، تمديد/تعديل المدة والنوع، إيقاف/استئناف، إلغاء بسبب (إلزامي)، إعادة تفعيل. وتصدير CSV لما يطابق التصفية.
       «منتهٍ» و«لم يبدأ» حالتان محسوبتان من التواريخ (A.enrState) والمخزَّن active؛ وصلاحية الوصول تقرّرها القاعدة (private.has_course_access).
   بدون الترحيل 023 تعمل الصفحة كما كانت (نشط/ملغى فقط، بلا تواريخ) ولا تظهر عناصر المدة والنوع.
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
  const KINDS = [['', 'غير محدد'], ['paid', 'مدفوع'], ['free', 'مجاني'], ['complimentary', 'مجاملة']];
  const kindLabel = function (k) { return { paid: 'مدفوع', free: 'مجاني', complimentary: 'مجاملة' }[k] || '—'; };
  const STATES = [['all', 'كل الحالات'], ['active', 'نشط'], ['pending', 'معلّق'], ['suspended', 'موقوف'], ['expired', 'منتهٍ'], ['upcoming', 'لم يبدأ'], ['revoked', 'ملغى']];
  const stateLabel = function (k) { return (STATES.filter(function (s) { return s[0] === k; })[0] || [0, k])[1]; };
  const pad = function (n) { return (n < 10 ? '0' : '') + n; };
  const toDay = function (iso) { if (!iso) return ''; const d = new Date(iso); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  const dayStart = function (v) { return v ? new Date(v + 'T00:00:00').toISOString() : null; };
  const dayEnd = function (v) { return v ? new Date(v + 'T23:59:59').toISOString() : null; };
  const addDays = function (iso, n) { const d = iso ? new Date(iso) : new Date(); d.setDate(d.getDate() + n); return toDay(d.toISOString()); };

  /* نافذة نموذج بسيطة: تعيد true عند الحفظ (بعد validate()) وfalse عند الإلغاء */
  function formDialog(o) {
    return new Promise(function (resolve) {
      const prev = document.activeElement;
      const err = h('p', { class: 'pf-msg err', role: 'alert', hidden: true });
      const ok = h('button', { type: 'button', class: 'btn p' + (o.danger ? ' ad-dangerp' : ''), text: o.ok || 'حفظ' });
      const cancel = h('button', { type: 'button', class: 'btn s', text: 'إلغاء' });
      const dlg = h('dialog', { class: 'ad-dialog', 'aria-label': o.title },
        h('div', { class: 'ad-dlgbody' },
          h('h3', { text: o.title }),
          o.message ? h('p', { class: 'ad-dlgmsg', text: o.message }) : null,
          h('div', null, o.nodes || []),
          err,
          h('div', { class: 'btns ad-dlgact' }, cancel, ok)));
      let done = false;
      function close(v) {
        if (done) return;
        done = true;
        try { dlg.close(); } catch (e) { /* مغلقة */ }
        dlg.remove();
        try { if (prev && prev.focus) prev.focus(); } catch (e) { /* تجاهل */ }
        resolve(v);
      }
      ok.addEventListener('click', function () {
        const bad = o.validate ? o.validate() : '';
        if (bad) { err.textContent = bad; err.hidden = false; return; }
        close(true);
      });
      cancel.addEventListener('click', function () { close(false); });
      dlg.addEventListener('cancel', function (e) { e.preventDefault(); close(false); });
      dlg.addEventListener('click', function (e) { if (e.target === dlg) close(false); });
      document.body.appendChild(dlg);
      dlg.showModal();
      if (o.focus) o.focus.focus(); else cancel.focus();
    });
  }

  async function render(root, args, token, opts) {
    const lock = (opts && opts.course) || ''; /* داخل مركز الدورة: الدورة مثبّتة ولا يظهر اختيارها */
    const refresh = A.btn('تحديث', { icon: 'refresh', small: true });
    if (lock) root.appendChild(h('div', { class: 'ad-qb-bar' }, refresh));
    else root.appendChild(A.head('الاشتراكات', 'أضف دورة لمتدرب أو لعدة متدربين، وتابع حالة كل اشتراك ومدته: تمديد وإيقاف وإلغاء بسبب.', [refresh]));
    const body = h('div');
    root.appendChild(body);
    let dir = null;
    const sel = new Set(); /* المتدربون المحدّدون للاشتراك */
    const st = { course: lock, q: '', fCourse: lock || 'all', fState: 'all', fKind: 'all', fq: '', sort: 'date', dir: 'desc', page: 1, summary: null, kind: '', start: '', end: '' };

    const ext = function () { return !!(dir && dir.ext); };
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
      if (!lock) st.course = courseSel.value;
      const search = A.input({ type: 'search', max: 120, placeholder: 'اسم، بريد أو هاتف (أو اتركه فارغًا لعرض الأحدث)' });
      search.value = st.q;
      const kindSel = A.select(KINDS, st.kind);
      const startIn = A.input({ type: 'date' });
      const endIn = A.input({ type: 'date' });
      startIn.value = st.start;
      endIn.value = st.end;
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
      if (!lock) courseSel.addEventListener('change', function () { st.course = courseSel.value; paint(); });
      search.addEventListener('input', A.debounce(function () { st.q = search.value; paint(); }, 160));
      kindSel.addEventListener('change', function () { st.kind = kindSel.value; });
      startIn.addEventListener('change', function () { st.start = startIn.value; });
      endIn.addEventListener('change', function () { st.end = endIn.value; });
      all.addEventListener('click', function () {
        const enrolled = activeIn(st.course);
        visible().forEach(function (p) { if (!enrolled.has(p.id)) sel.add(p.id); });
        paint();
      });
      none.addEventListener('click', function () { sel.clear(); paint(); });
      submit.addEventListener('click', A.run(submit, out, async function () {
        ui.clearMsg(out);
        if (ext() && st.start && st.end && st.end <= st.start) { ui.msg(out, 'err', 'تاريخ النهاية يجب أن يكون بعد تاريخ البداية.'); return; }
        if (ext() && st.end && Date.parse(dayEnd(st.end)) <= Date.now()) { ui.msg(out, 'err', 'تاريخ النهاية في الماضي: سيكون الاشتراك منتهيًا فورًا.'); return; }
        const ids = Array.from(sel);
        const course = st.course;
        const title = A.courseTitle(course);
        const res = { added: 0, reactivated: 0, exists: 0, failed: [], mails: [] };
        for (let i = 0; i < ids.length; i++) {
          if (A.stale(token)) return;
          const info = { opts: ext() ? { kind: st.kind, starts_at: dayStart(st.start), expires_at: dayEnd(st.end) } : null };
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
        h('p', { class: 'ad-sub', text: lock ? 'ابحث وحدّد المتدربين لاشتراكهم في هذه الدورة. يُعرض أحدث ٢٠ مطابقًا.' : 'اختر الدورة، ثم ابحث وحدّد المتدربين. يُعرض أحدث ٢٠ مطابقًا.' }),
        h('div', { class: 'ad-tools' }, lock ? null : A.field('الدورة', courseSel), A.field('بحث عن متدرب', search)),
        ext() ? h('div', { class: 'ad-tools' }, A.field('نوع الاشتراك', kindSel), A.field('بداية الاشتراك (اختياري)', startIn), A.field('نهاية الاشتراك (اختياري)', endIn, 'اتركها فارغة لاشتراك مفتوح بلا نهاية.')) : null,
        h('div', { class: 'ad-act' }, all, none, info),
        list,
        h('div', { class: 'ad-act' }, submit, out)
      ]);
    }

    /* ---------- حوارات الإجراءات ---------- */
    async function editDialog(e) {
      const p = dir.byId[e.user_id];
      const startIn = A.input({ type: 'date' });
      const endIn = A.input({ type: 'date' });
      const kindSel = A.select(KINDS, e.kind || '');
      startIn.value = toDay(e.starts_at);
      endIn.value = toDay(e.expires_at);
      const quick = [30, 90, 365].map(function (n) {
        const b = h('button', { type: 'button', class: 'btn s', text: '+' + n + ' يومًا' });
        b.addEventListener('click', function () {
          const base = e.expires_at && Date.parse(e.expires_at) > Date.now() ? e.expires_at : null; /* التمديد من نهاية الاشتراك الحالية إن لم تنقضِ، وإلا من اليوم */
          endIn.value = addDays(base, n);
        });
        return b;
      });
      const ok = await formDialog({
        title: 'تعديل مدة الاشتراك',
        message: nameOr(p) + ' — ' + A.courseTitle(e.course_id),
        ok: 'حفظ',
        focus: endIn,
        nodes: [A.field('نوع الاشتراك', kindSel), A.field('البداية', startIn), A.field('النهاية (فارغة = بلا نهاية)', endIn), h('div', { class: 'ad-act' }, quick)],
        validate: function () {
          if (startIn.value && endIn.value && endIn.value <= startIn.value) return 'تاريخ النهاية يجب أن يكون بعد البداية.';
          return '';
        }
      });
      if (!ok) return false;
      await A.updateEnrollment(e.id, { kind: kindSel.value || null, starts_at: dayStart(startIn.value), expires_at: dayEnd(endIn.value) });
      return true;
    }
    async function cancelDialog(e, rejecting) {
      const p = dir.byId[e.user_id];
      const reason = A.textarea({ max: 500, rows: 3 });
      const ok = await formDialog({
        title: rejecting ? 'رفض طلب الاشتراك' : 'إلغاء الاشتراك',
        message: 'سيُسجَّل الإجراء باسمك: «' + nameOr(p) + '» — «' + A.courseTitle(e.course_id) + '». يبقى السجل ويمكن إعادة التفعيل لاحقًا.',
        ok: rejecting ? 'رفض' : 'إلغاء الاشتراك',
        danger: true,
        focus: reason,
        nodes: [A.field('سبب ' + (rejecting ? 'الرفض' : 'الإلغاء') + ' (إلزامي)', reason)],
        validate: function () { const v = reason.value.trim(); return v.length < 3 ? 'اكتب السبب (٣ أحرف على الأقل).' : v.length > 500 ? 'السبب أطول من ٥٠٠ حرف.' : ''; }
      });
      if (!ok) return false;
      await A.revokeEnrollment(e.id, reason.value.trim());
      return true;
    }

    /* ---------- جدول الاشتراكات ---------- */
    function listCard() {
      const fCourse = A.select([['all', 'كل الدورات']].concat(A.S.courses.map(function (c) { return [c.id, c.title_ar]; })), st.fCourse);
      const fState = A.select(STATES, st.fState);
      const fKind = A.select([['all', 'كل الأنواع']].concat(KINDS.slice(1)), st.fKind);
      const fSearch = A.input({ type: 'search', max: 120, placeholder: 'اسم أو بريد المتدرب' });
      fSearch.value = st.fq;
      const count = h('p', { class: 'ad-count-t', role: 'status' });
      const counters = h('div', { class: 'ad-stats' });
      const box = h('div');
      const out = A.msgBox();
      const exportBtn = A.btn('تصدير CSV (Excel)', { small: true, icon: 'download' });

      function base() { /* بعد تصفية الدورة والبحث والنوع، قبل تصفية الحالة (للعدّادات) */
        return dir.enrollments.filter(function (e) {
          if (!ext() && e.status !== 'active') return false;
          if (st.fCourse !== 'all' && e.course_id !== st.fCourse) return false;
          if (ext() && st.fKind !== 'all' && e.kind !== st.fKind) return false;
          const p = dir.byId[e.user_id];
          return p ? matches(p, st.fq) : !st.fq;
        });
      }
      function rows() {
        const list = base().filter(function (e) { return st.fState === 'all' || A.enrState(e) === st.fState; });
        const f = {
          user: function (a, b) { return nameOr(dir.byId[a.user_id]).localeCompare(nameOr(dir.byId[b.user_id]), 'ar'); },
          course: function (a, b) { return A.courseTitle(a.course_id).localeCompare(A.courseTitle(b.course_id), 'ar'); },
          status: function (a, b) { return stateLabel(A.enrState(a)).localeCompare(stateLabel(A.enrState(b)), 'ar'); },
          end: function (a, b) { return (a.expires_at ? Date.parse(a.expires_at) : 9e15) - (b.expires_at ? Date.parse(b.expires_at) : 9e15); },
          date: function (a, b) { return Date.parse(a.granted_at) - Date.parse(b.granted_at); }
        }[st.sort];
        const sgn = st.dir === 'asc' ? 1 : -1;
        list.sort(function (a, b) { return f(a, b) * sgn; });
        return list;
      }
      function paintCounters() {
        A.clear(counters);
        if (!ext()) return;
        const b = base();
        const n = function (k) { return b.filter(function (e) { return A.enrState(e) === k; }).length; };
        [['الإجمالي', b.length], ['نشط', n('active')], ['معلّق', n('pending')], ['موقوف', n('suspended')], ['منتهٍ', n('expired')], ['ملغى', n('revoked')]].forEach(function (x) {
          counters.appendChild(h('div', { class: 'ad-stat' }, h('span', { class: 'big', text: A.num(x[1]) }), h('b', { text: x[0] })));
        });
      }
      function actions(e) {
        const state = A.enrState(e);
        const p = dir.byId[e.user_id];
        const wrap = h('div', { class: 'ad-cell-act' });
        function act(label, kind, fn) {
          const b = A.btn(label, { small: true, kind: kind });
          b.addEventListener('click', A.run(b, out, async function () { ui.clearMsg(out); if (await fn()) await reloadData(); }));
          wrap.appendChild(b);
        }
        const setStatus = function (status, msg) { return async function () { await A.updateEnrollment(e.id, { status: status }); A.toast('ok', msg); return true; }; };
        if (!ext()) { act('إلغاء', 'danger', async function () {
          const ok = await A.confirm({ title: 'إلغاء الاشتراك؟', message: 'سيفقد «' + nameOr(p) + '» الوصول إلى «' + A.courseTitle(e.course_id) + '» فورًا.', detail: 'يبقى السجل ويمكنك إعادة التفعيل لاحقًا. يُسجَّل الإجراء باسمك.', ok: 'إلغاء الاشتراك', danger: true });
          if (!ok) return false;
          await A.revokeEnrollment(e.id);
          A.toast('ok', 'تم إلغاء الاشتراك.');
          return true;
        }); return wrap; }
        if (state === 'pending') {
          act('قبول', 'p', setStatus('active', 'تم قبول الاشتراك.'));
          act('رفض', 'danger', async function () { const ok = await cancelDialog(e, true); if (ok) A.toast('ok', 'تم رفض الطلب.'); return ok; });
        } else if (state === 'revoked') {
          act('إعادة تفعيل', 'p', setStatus('active', 'تمت إعادة التفعيل.'));
        } else {
          act(state === 'expired' ? 'تجديد' : 'تمديد', state === 'expired' ? 'p' : null, async function () { const ok = await editDialog(e); if (ok) A.toast('ok', 'تم حفظ مدة الاشتراك.'); return ok; });
          if (e.status === 'suspended') act('استئناف', 'p', setStatus('active', 'تم استئناف الاشتراك.'));
          else act('إيقاف', null, async function () {
            const ok = await A.confirm({ title: 'إيقاف الاشتراك؟', message: 'سيُمنع «' + nameOr(p) + '» من «' + A.courseTitle(e.course_id) + '» حتى تستأنفه.', detail: 'لا يُحذف شيء ويمكنك الاستئناف لاحقًا.', ok: 'إيقاف', danger: true });
            if (!ok) return false;
            await A.updateEnrollment(e.id, { status: 'suspended' });
            A.toast('ok', 'تم إيقاف الاشتراك.');
            return true;
          });
          act('إلغاء', 'danger', async function () { const ok = await cancelDialog(e, false); if (ok) A.toast('ok', 'تم إلغاء الاشتراك.'); return ok; });
        }
        return wrap;
      }
      function paint(focusKey) {
        const list = rows();
        const pages = Math.max(1, Math.ceil(list.length / PAGE));
        if (st.page > pages) st.page = pages;
        A.clear(box);
        paintCounters();
        count.textContent = (ext() ? 'الاشتراكات: ' : 'الاشتراكات النشطة: ') + A.num(list.length);
        if (!list.length) { box.appendChild(A.empty('لا اشتراكات', 'غيّر التصفية أو أضف اشتراكًا من البطاقة أعلاه.')); return; }
        const cols = [
          { key: 'user', label: 'المتدرب', sort: true, cls: 'ad-first', cell: function (e) {
            const p = dir.byId[e.user_id];
            return h('div', null, p ? h('a', { class: 'ad-name', href: '#trainees/' + p.id, text: nameOr(p) }) : h('span', { text: 'حساب محذوف' }), p && emailOf(p.id) ? h('small', { class: 'ad-ltr', text: emailOf(p.id) }) : null);
          } }
        ];
        if (!lock) cols.push({ key: 'course', label: 'الدورة', sort: true, cell: function (e) { return A.courseTitle(e.course_id); } });
        if (ext()) {
          cols.push({ key: 'status', label: 'الحالة', sort: true, cell: function (e) {
            const k = A.enrState(e);
            return h('div', null, A.statusBadge('enrollment', k), e.status === 'revoked' && e.cancel_reason ? h('small', { text: e.cancel_reason }) : null);
          } });
          cols.push({ key: 'kind', label: 'النوع', cls: 'hide-md', cell: function (e) { return kindLabel(e.kind); } });
          cols.push({ key: 'start', label: 'البداية', cls: 'hide-md', cell: function (e) { return h('span', { class: 'ad-nowrap', text: e.starts_at ? A.fmtDay(e.starts_at) : '—' }); } });
          cols.push({ key: 'end', label: 'النهاية', sort: true, cell: function (e) { return h('span', { class: 'ad-nowrap', text: e.expires_at ? A.fmtDay(e.expires_at) : 'مفتوح' }); } });
        }
        cols.push({ key: 'date', label: 'منذ', sort: true, cls: 'hide-md', cell: function (e) { return h('span', { class: 'ad-nowrap', text: A.fmtDay(e.granted_at) }); } });
        cols.push({ key: 'by', label: 'بواسطة', cls: 'hide-md', cell: function (e) { return A.who(e.granted_by); } });
        cols.push({ key: 'act', label: '', cls: 'ad-actcol', cell: actions });
        box.appendChild(A.dataTable(cols, list.slice((st.page - 1) * PAGE, st.page * PAGE), {
          caption: 'الاشتراكات', sort: { key: st.sort, dir: st.dir },
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
      exportBtn.addEventListener('click', function () {
        const list = rows();
        const head = ['المتدرب', 'البريد', 'الدورة', 'الحالة', 'النوع', 'البداية', 'النهاية', 'تاريخ الاشتراك', 'سبب الإلغاء'];
        const data = list.map(function (e) {
          const p = dir.byId[e.user_id];
          return [nameOr(p), p ? emailOf(p.id) : '', A.courseTitle(e.course_id), stateLabel(A.enrState(e)), ext() ? kindLabel(e.kind) : '', e.starts_at ? toDay(e.starts_at) : '', e.expires_at ? toDay(e.expires_at) : '', toDay(e.granted_at), e.cancel_reason || ''];
        });
        A.download('subscriptions' + (lock ? '-' + lock : '') + '.csv', A.csvBuild([head].concat(data)));
      });
      if (!lock) fCourse.addEventListener('change', function () { st.fCourse = fCourse.value; st.page = 1; paint(); });
      fState.addEventListener('change', function () { st.fState = fState.value; st.page = 1; paint(); });
      fKind.addEventListener('change', function () { st.fKind = fKind.value; st.page = 1; paint(); });
      fSearch.addEventListener('input', A.debounce(function () { st.fq = fSearch.value; st.page = 1; paint(); }, 160));
      paint();
      return A.card(ext() ? 'كل الاشتراكات' : 'الاشتراكات النشطة', [
        counters,
        h('div', { class: 'ad-tools' }, lock ? null : A.field('الدورة', fCourse), ext() ? A.field('الحالة', fState) : null, ext() ? A.field('النوع', fKind) : null, A.field('بحث', fSearch), count, exportBtn),
        out, box]);
    }

    function build() {
      A.clear(body);
      if (!dir.emailsOk) body.appendChild(h('p', { class: 'ad-note warn', text: 'البحث بالبريد غير متاح الآن: يلزم تطبيق الملف supabase/migrations/006_admin_user_emails.sql. يعمل البحث بالاسم والهاتف.' }));
      if (!dir.ext) body.appendChild(h('p', { class: 'ad-note warn', text: 'مدة الاشتراك ونوعه وحالات «معلّق/موقوف» تتطلب تطبيق الملف supabase/migrations/023_subscriptions.sql. تعمل الصفحة الآن بالحالتين نشط/ملغى فقط.' }));
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

  A.enrollRender = render; /* يستعمله مركز الدورة: A.enrollRender(panel, [], token, {course}) */
  A.register('enrollments', { label: 'الاشتراكات', render: render });
})();
