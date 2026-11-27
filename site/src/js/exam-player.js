/* =====================================================================
   exam-player.js — اختبارات المتدرب في لوحته (M4b): القائمة، صفحة الاختبار، شاشة المحاولة، النتيجة والمراجعة
   ملف عادي (ES2017) يُحمَّل بـ defer بعد platform-api.js وقبل dashboard.js. يعرّف window.Exams:
     Exams.section(ctx)  عنصر «اختباراتي» للرئيسية (ctx: {active, courseTitle(id)})
     Exams.show(kind, id) kind = exam | attempt | result  (المسارات #exam=<id> و#attempt=<id> و#result=<id>)
     Exams.leave()       تنظيف المؤقتات والمراقبة عند مغادرة الشاشة
   كل شيء عبر RPC الخادم (exam_list_available / exam_start_attempt / exam_get_items / exam_save_answer / exam_submit /
   exam_attempt_result / exam_my_attempts / exam_log_event): لا يصل للمتصفح مفتاح ولا معرّفات خيارات حقيقية.
   الإجابات تُحفظ تلقائيًا بعد كل تغيير (مع إعادة محاولة)، والمؤقت يعتمد ساعة الخادم، وانتهاء الوقت يُسلِّم تلقائيًا.
   كل نص من القاعدة يدخل الصفحة بـ textContent (ui.h) ولا يُفسَّر HTML أبدًا.
   ===================================================================== */
(function () {
  'use strict';

  const P = window.Platform;
  if (!P) return;
  const ui = P.ui;
  const h = ui.h;
  const clear = ui.clear;
  const doc = document;
  const $ = function (id) { return doc.getElementById(id); };
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const KIND = { practice: 'تدريب', simulation: 'محاكاة', final: 'نهائي' };
  const REASON = { not_open_yet: 'لم يفتح بعد', closed: 'أُغلق', no_attempts_left: 'استنفدت محاولاتك' };
  const STATUS = { in_progress: 'جارية', submitted: 'سُلِّمت', timed_out: 'انتهى وقتها', voided: 'أُلغيت' };

  const view = function () { return $('dash-view'); };
  let nav = 0;
  let clockOffset = 0;
  const nowMs = function () { return Date.now() + clockOffset; };
  const syncClock = function (serverNow) { const t = Date.parse(serverNow); if (!isNaN(t)) clockOffset = t - Date.now(); };
  let cleanups = [];
  const onCleanup = function (fn) { cleanups.push(fn); };
  function leave() {
    const list = cleanups;
    cleanups = [];
    list.forEach(function (fn) { try { fn(); } catch (e) { /* تجاهل */ } });
  }

  function errText(err, ctx) {
    if (!(err instanceof P.ApiError)) return P.MSG.other;
    const c = err.code || '';
    if (err.kind === 'network' || err.kind === 'config' || err.kind === 'server') return err.message;
    if (err.kind === 'session') return P.MSG.session;
    if (c === '55000') return ctx === 'start' ? 'لا يمكن بدء الاختبار الآن (قد يكون أُغلق أو استنفدت محاولاتك أو لا يُستأنف). حدّث القائمة.' : 'حالة المحاولة لا تسمح بهذا الإجراء.';
    if (c === '42501' || err.kind === 'forbidden') return 'لا تملك صلاحية هذا الاختبار، أو أن المحاولة لم تعد موجودة.';
    if (c === '22023') return 'إجابة غير صالحة.';
    if (c === 'P0001' || err.kind === 'rate') return P.MSG.rate;
    return err.message || P.MSG.other;
  }
  const isSession = function (err) { return err instanceof P.ApiError && err.kind === 'session'; };
  function fatal(err) {
    if (isSession(err)) { P.goLogin('expired'); return; }
  }
  const rpc = function (fn, args) { return P.rest.rpc(fn, args || {}); };
  const fmtDur = function (min) { return min ? (min >= 60 ? Math.floor(min / 60) + ' س ' + (min % 60 ? (min % 60) + ' د' : '') : min + ' د') : 'بلا مؤقت'; };
  const pad2 = function (n) { return n < 10 ? '0' + n : String(n); };
  const fmtClock = function (sec) { sec = Math.max(0, Math.floor(sec)); const hh = Math.floor(sec / 3600); const mm = Math.floor((sec % 3600) / 60); return (hh ? hh + ':' + pad2(mm) : pad2(mm)) + ':' + pad2(sec % 60); };
  const fail = function (text, retry) {
    const box = h('div', { class: 'pf-block' }, h('p', { class: 'pf-msg err', role: 'alert', text: text }));
    if (retry) box.appendChild(h('button', { type: 'button', class: 'btn s', onclick: retry }, 'إعادة المحاولة'));
    return box;
  };
  const backLink = function () { return h('p', null, h('a', { class: 'btn s', href: '#' }, 'العودة إلى لوحتي')); };

  /* نافذة تأكيد بسيطة (dialog أصلي: حبس تركيز وESC) */
  function confirmDialog(title, message, okLabel) {
    return new Promise(function (resolve) {
      const prev = doc.activeElement;
      const ok = h('button', { type: 'button', class: 'btn p', text: okLabel || 'تأكيد' });
      const cancel = h('button', { type: 'button', class: 'btn s', text: 'متابعة الاختبار' });
      const dlg = h('dialog', { class: 'ex-dlg', 'aria-label': title }, h('h3', { text: title }), h('p', { text: message }), h('div', { class: 'pf-act' }, cancel, ok));
      let done = false;
      function end(v) { if (done) return; done = true; try { dlg.close(); } catch (e) { /* مغلقة */ } dlg.remove(); try { if (prev && prev.focus) prev.focus(); } catch (e) { /* تجاهل */ } resolve(v); }
      ok.addEventListener('click', function () { end(true); });
      cancel.addEventListener('click', function () { end(false); });
      dlg.addEventListener('cancel', function (e) { e.preventDefault(); end(false); });
      doc.body.appendChild(dlg);
      if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
      cancel.focus();
    });
  }

  /* ================================================================== «اختباراتي» في الرئيسية */
  function examCard(e, ctx) {
    const act = h('div', { class: 'pf-act' });
    if (e.in_progress) act.appendChild(h('a', { class: 'btn p', href: '#attempt=' + e.in_progress }, 'تابع المحاولة'));
    else if (e.can_start) act.appendChild(h('a', { class: 'btn p', href: '#exam=' + e.exam_id }, 'ابدأ'));
    else act.appendChild(h('span', { class: 'st soon', text: REASON[e.reason] || 'غير متاح' }));
    act.appendChild(h('a', { class: 'btn s', href: '#exam=' + e.exam_id }, 'التفاصيل'));
    return h('article', { class: 'card pf-course' },
      h('div', { class: 'pf-ct' }, h('h3', { text: e.title_ar }), h('span', { class: 'st ok', text: KIND[e.exam_kind] || '' })),
      h('div', { class: 'pf-en', text: ctx.courseTitle(e.course_id) }),
      h('ul', { class: 'pf-stats' },
        h('li', null, 'الأسئلة ', h('b', { text: String(e.question_count) })),
        h('li', null, 'المدة ', h('b', { text: fmtDur(e.duration_minutes) })),
        h('li', null, 'المحاولات ', h('b', { text: e.attempts_used + (e.max_attempts ? ' / ' + e.max_attempts : '') }))),
      e.close_at ? h('p', { class: 'pf-last', text: 'يُغلق: ' + P.fmtDate(e.close_at) }) : null, act);
  }
  function section(ctx) {
    if (!ctx || !ctx.active) return null;
    const sec = h('section', { class: 'pf-block', id: 'sec-exams', 'aria-labelledby': 'h-exams' }, h('h2', { id: 'h-exams', text: 'اختباراتي' }));
    const body = h('div');
    sec.appendChild(body);
    body.appendChild(h('p', { class: 'pf-loading', role: 'status', text: 'جارٍ تحميل اختباراتك…' }));
    rpc('exam_list_available').then(function (list) {
      clear(body);
      if (!Array.isArray(list) || !list.length) { sec.hidden = true; return; } /* لا اختبارات: لا قسم فارغ في الرئيسية */
      body.appendChild(h('div', { class: 'pf-grid' }, list.map(function (e) { return examCard(e, ctx); })));
    }).catch(function (err) {
      if (isSession(err)) { fatal(err); return; }
      if (err instanceof P.ApiError && (err.kind === 'notfound' || err.status === 404)) { sec.hidden = true; return; } /* الخدمة غير مفعّلة بعد على الخادم: لا نُظهر خطأً للمتدرب */
      clear(body);
      body.appendChild(h('p', { class: 'pf-msg err', role: 'status', text: 'تعذّر تحميل الاختبارات الآن. حدّث الصفحة لاحقًا.' }));
    });
    return sec;
  }

  /* ================================================================== صفحة الاختبار + محاولاتي */
  async function showIntro(id) {
    const token = ++nav;
    const root = view();
    clear(root);
    doc.title = 'الاختبار | لوحة المتدرب';
    root.appendChild(h('p', { class: 'pf-loading', role: 'status', text: 'جارٍ تحميل الاختبار…' }));
    let list;
    let atts;
    try { list = await rpc('exam_list_available'); atts = await rpc('exam_my_attempts', { p_exam_id: id }); } catch (err) {
      if (token !== nav) return;
      if (isSession(err)) { fatal(err); return; }
      clear(root); root.appendChild(fail(errText(err), function () { showIntro(id); })); root.appendChild(backLink());
      return;
    }
    if (token !== nav) return;
    clear(root);
    const e = (Array.isArray(list) ? list : []).filter(function (x) { return x.exam_id === id; })[0];
    root.appendChild(h('div', { class: 'pf-fade' }, backLink()));
    if (!e) {
      root.appendChild(h('p', { class: 'pf-msg err', role: 'status', text: 'هذا الاختبار غير متاح لك. تأكد من اشتراكك في الدورة، أو أنه لا يزال منشورًا.' }));
      appendAttempts(root, Array.isArray(atts) ? atts : []);
      return;
    }
    doc.title = e.title_ar + ' | لوحة المتدرب';
    const out = h('p', { class: 'pf-msg err', role: 'alert', hidden: true });
    const start = h('button', { type: 'button', class: 'btn p' }, e.in_progress ? 'تابع المحاولة' : 'ابدأ الاختبار');
    start.disabled = !e.in_progress && !e.can_start;
    start.addEventListener('click', async function () {
      start.disabled = true;
      out.hidden = true;
      if (e.in_progress) { window.location.hash = '#attempt=' + e.in_progress; return; }
      try {
        const r = await rpc('exam_start_attempt', { p_exam_id: id });
        syncClock(r.server_now);
        const sec = r.settings && r.settings.security;
        if (sec && sec.fullscreen_required && doc.documentElement.requestFullscreen) { try { await doc.documentElement.requestFullscreen(); } catch (x) { /* تُطلب لاحقًا */ } }
        window.location.hash = '#attempt=' + r.attempt_id;
      } catch (err) {
        if (isSession(err)) { fatal(err); return; }
        out.textContent = errText(err, 'start');
        out.hidden = false;
        start.disabled = false;
      }
    });
    root.appendChild(h('section', { class: 'pf-block' },
      h('h1', { text: e.title_ar }),
      h('p', { class: 'pf-en', text: KIND[e.exam_kind] + ' · ' + (ctxCourse(e.course_id)) }),
      h('ul', { class: 'pf-stats' },
        h('li', null, 'عدد الأسئلة ', h('b', { text: String(e.question_count) })),
        h('li', null, 'الدرجة الكلية ', h('b', { text: String(Number(e.total_score)) })),
        h('li', null, 'المدة ', h('b', { text: fmtDur(e.duration_minutes) })),
        h('li', null, 'المحاولات ', h('b', { text: e.attempts_used + (e.max_attempts ? ' من ' + e.max_attempts : ' (غير محدودة)') }))),
      e.open_at ? h('p', { class: 'pf-last', text: 'يفتح: ' + P.fmtDate(e.open_at) }) : null,
      e.close_at ? h('p', { class: 'pf-last', text: 'يُغلق: ' + P.fmtDate(e.close_at) }) : null,
      e.reason && !e.in_progress ? h('p', { class: 'pf-msg err', role: 'status', text: REASON[e.reason] }) : null,
      h('ul', { class: 'ex-rules' },
        h('li', { text: 'تُحفظ إجاباتك تلقائيًا أثناء الإجابة، ويمكنك العودة لمتابعة المحاولة إن انقطع الاتصال.' }),
        h('li', { text: 'عند انتهاء الوقت تُسلَّم المحاولة تلقائيًا بما أجبتَ.' }),
        h('li', { text: 'قد تُسجَّل مغادرة نافذة الاختبار إن فعّل المدرب المراقبة.' })),
      h('div', { class: 'pf-act' }, start), out));
    appendAttempts(root, Array.isArray(atts) ? atts : []);
  }
  let courseTitles = function (id) { return id; };
  function ctxCourse(id) { return courseTitles(id); }
  function appendAttempts(root, atts) {
    if (!atts.length) return;
    root.appendChild(h('section', { class: 'pf-block' }, h('h2', { text: 'محاولاتي' }),
      h('ul', { class: 'ex-attempts' }, atts.map(function (a) {
        const txt = '#' + a.attempt_no + ' — ' + (STATUS[a.status] || a.status) + (a.submitted_at ? ' — ' + P.fmtDate(a.submitted_at) : '') +
          (a.result_visible && a.percent != null ? ' — ' + a.percent + '%' : '');
        return h('li', null, h('span', { text: txt }), ' ',
          a.status === 'in_progress' ? h('a', { class: 'btn p', href: '#attempt=' + a.attempt_id }, 'تابع') : h('a', { class: 'btn s', href: '#result=' + a.attempt_id }, 'النتيجة'));
      }))));
  }

  /* ================================================================== شاشة المحاولة */
  async function showAttempt(id) {
    const token = ++nav;
    const root = view();
    clear(root);
    doc.title = 'اختبار جارٍ | لوحة المتدرب';
    root.appendChild(h('p', { class: 'pf-loading', role: 'status', text: 'جارٍ فتح المحاولة…' }));
    const T = { id: id, items: {}, cur: 1, n: 0, answered: 0, settings: {}, deadline: null, hard: null, saveTimers: {}, pending: {}, warnings: 0, closing: false, lastErr: '' };
    let first;
    try { first = await rpc('exam_get_items', { p_attempt_id: id, p_from: 1, p_count: 5 }); } catch (err) {
      if (token !== nav) return;
      if (isSession(err)) { fatal(err); return; }
      clear(root); root.appendChild(fail(errText(err), function () { showAttempt(id); })); root.appendChild(backLink());
      return;
    }
    if (token !== nav) return;
    syncClock(first.server_now);
    if (first.closed) { window.location.replace('#result=' + id); return; }
    T.n = first.item_count;
    T.answered = first.answered_count;
    T.settings = first.settings || {};
    T.deadline = first.deadline_at ? Date.parse(first.deadline_at) : null;
    T.hard = first.hard_deadline_at ? Date.parse(first.hard_deadline_at) : null;
    (first.items || []).forEach(function (it) { T.items[it.position] = it; });
    T.maxVisited = 1;
    const sec = T.settings.security || {};
    const allowBack = T.settings.allow_back !== false;
    const allowFlag = T.settings.allow_flag !== false;

    clear(root);
    doc.title = (T.settings.title_ar || 'اختبار') + ' | لوحة المتدرب';
    const timerEl = h('span', { class: 'ex-timer', 'aria-label': 'الوقت المتبقي' });
    const statusEl = h('span', { class: 'ex-save', role: 'status', 'aria-live': 'polite' });
    const liveEl = h('p', { class: 'pf-sr', role: 'status', 'aria-live': 'assertive' });
    const bannerEl = h('p', { class: 'pf-msg err', role: 'alert', hidden: true });
    const navEl = h('div', { class: 'ex-navgrid', role: 'group', 'aria-label': 'أسئلة الاختبار' });
    const qBox = h('div', { class: 'ex-qbox' });
    const prevBtn = h('button', { type: 'button', class: 'btn s' }, 'السابق');
    const nextBtn = h('button', { type: 'button', class: 'btn p' }, 'التالي');
    const flagBtn = h('button', { type: 'button', class: 'btn s', 'aria-pressed': 'false' }, 'علّمه للمراجعة');
    const finishBtn = h('button', { type: 'button', class: 'btn p ex-finish' }, 'إنهاء الاختبار');
    const wm = sec.watermark ? h('div', { class: 'ex-wm', 'aria-hidden': 'true' }) : null;
    if (wm) {
      const who = (P.session.get() && P.session.get().user && P.session.get().user.email) || '';
      const label = who + ' · ' + id.slice(0, 8);
      wm.style.setProperty('--wm', '"' + label.replace(/["\\]/g, '') + '"');
      for (let i = 0; i < 40; i++) wm.appendChild(h('span', { text: label }));
    }
    const shell = h('div', { class: 'ex-shell' + (sec.monitoring ? ' ex-nocopy' : '') },
      h('div', { class: 'ex-top' }, h('strong', { text: T.settings.title_ar || 'الاختبار' }), timerEl, statusEl),
      bannerEl, liveEl,
      h('div', { class: 'ex-body' }, h('aside', { class: 'ex-side' }, h('p', { class: 'pf-hint', id: 'ex-prog' }), navEl, finishBtn), h('div', { class: 'ex-main' }, qBox,
        h('div', { class: 'ex-foot' }, allowBack ? prevBtn : null, allowFlag ? flagBtn : null, nextBtn))),
      wm);
    root.appendChild(shell);

    /* ---------- جلب الأسئلة عند الحاجة ---------- */
    async function ensure(pos) {
      if (T.items[pos]) return true;
      try {
        const r = await rpc('exam_get_items', { p_attempt_id: id, p_from: pos, p_count: 5 });
        syncClock(r.server_now);
        if (r.closed) { closeNow(); return false; }
        (r.items || []).forEach(function (it) { if (!T.items[it.position]) T.items[it.position] = it; });
        T.answered = r.answered_count;
        return !!T.items[pos];
      } catch (err) {
        if (isSession(err)) { fatal(err); return false; }
        bannerEl.textContent = errText(err);
        bannerEl.hidden = false;
        return false;
      }
    }
    function closeNow() { if (T.closing) return; T.closing = true; leave(); window.location.replace('#result=' + id); }

    /* ---------- الحفظ التلقائي ---------- */
    function setStatus(kind, text) { statusEl.className = 'ex-save ' + kind; statusEl.textContent = text; }
    async function saveNow(pos) {
      const it = T.items[pos];
      if (!it) return;
      setStatus('busy', 'جارٍ الحفظ…');
      try {
        const r = await rpc('exam_save_answer', { p_attempt_id: id, p_position: pos, p_response: it.response || {}, p_flagged: !!it.flagged });
        syncClock(r.server_now);
        if (r.closed) { closeNow(); return; }
        T.answered = r.answered_count;
        delete T.pending[pos];
        if (r.feedback !== undefined || r.explanation !== undefined || r.correct !== undefined) it.fb = { correct: r.correct, feedback: r.feedback, explanation: r.explanation };
        setStatus('ok', 'تم الحفظ');
        paintNav();
        if (T.cur === pos) paintFeedback(it);
      } catch (err) {
        if (isSession(err)) { fatal(err); return; }
        T.pending[pos] = true;
        setStatus('err', 'تعذّر الحفظ — سنعيد المحاولة');
        clearTimeout(T.saveTimers['r' + pos]);
        T.saveTimers['r' + pos] = setTimeout(function () { if (T.pending[pos]) saveNow(pos); }, 5000);
      }
    }
    function scheduleSave(pos) {
      T.pending[pos] = true;
      clearTimeout(T.saveTimers[pos]);
      T.saveTimers[pos] = setTimeout(function () { saveNow(pos); }, 350);
    }
    async function flush() {
      const ps = Object.keys(T.pending);
      for (let i = 0; i < ps.length; i++) { clearTimeout(T.saveTimers[ps[i]]); await saveNow(Number(ps[i])); }
    }
    onCleanup(function () { Object.keys(T.saveTimers).forEach(function (k) { clearTimeout(T.saveTimers[k]); }); });

    /* ---------- رسم السؤال ---------- */
    const hasAnswer = function (it) { return !!it && !!it.response && Object.keys(it.response).length > 0 && (it.response.choice || (it.response.choices && it.response.choices.length) || (it.response.pairs && Object.keys(it.response.pairs).length)); };
    function paintNav() {
      clear(navEl);
      for (let p = 1; p <= T.n; p++) {
        const it = T.items[p];
        const b = h('button', { type: 'button', class: 'ex-nb' + (p === T.cur ? ' cur' : '') + (hasAnswer(it) ? ' done' : '') + (it && it.flagged ? ' flag' : ''),
          'aria-label': 'السؤال ' + p + (hasAnswer(it) ? ' (مُجاب)' : '') + (it && it.flagged ? ' (معلَّم)' : ''), 'aria-current': p === T.cur ? 'true' : 'false', text: String(p) });
        if (!allowBack && p < T.maxVisited) b.disabled = true;
        b.addEventListener('click', function () { go(p); });
        navEl.appendChild(b);
      }
      $('ex-prog').textContent = 'سؤال ' + T.cur + ' من ' + T.n + ' — مُجاب: ' + T.answered;
      prevBtn.disabled = T.cur <= 1 || !allowBack;
      nextBtn.hidden = T.cur >= T.n;
      const cur = T.items[T.cur];
      flagBtn.setAttribute('aria-pressed', cur && cur.flagged ? 'true' : 'false');
      flagBtn.textContent = cur && cur.flagged ? 'إزالة العلامة' : 'علّمه للمراجعة';
    }
    function paintFeedback(it) {
      const old = qBox.querySelector('.ex-fb');
      if (old) old.remove();
      if (!it.fb) return;
      const f = h('div', { class: 'ex-fb ' + (it.fb.correct ? 'good' : 'bad'), role: 'status' },
        h('b', { text: it.fb.correct ? 'إجابة صحيحة' : 'إجابة غير صحيحة' }),
        it.fb.feedback ? h('p', { text: it.fb.feedback }) : null, it.fb.explanation ? h('p', { text: it.fb.explanation }) : null);
      qBox.appendChild(f);
    }
    function setResp(it, resp) {
      it.response = resp;
      it.fb = null;
      const old = qBox.querySelector('.ex-fb');
      if (old) old.remove();
      paintNav();
      scheduleSave(it.position);
    }
    async function mediaNodes(it) {
      const wrap = h('div', { class: 'ex-media' });
      (it.media || []).forEach(function (m) {
        const img = h('img', { alt: m.alt || '', loading: 'lazy', class: 'ex-img', draggable: 'false' });
        wrap.appendChild(img);
        P.storage.signedUrl('exam-media', m.path, 600).then(function (u) { img.src = u; }).catch(function () { img.replaceWith(h('p', { class: 'pf-hint', text: 'تعذّر تحميل الصورة.' })); });
      });
      return wrap;
    }
    function controls(it) {
      const nm = 'q' + it.position + '-' + Math.random().toString(36).slice(2, 7);
      const t = it.type_code;
      const box = h('div', { class: 'pf-opts' });
      if (t === 'matching') {
        const rights = it.right || [];
        const cur = (it.response && it.response.pairs) || {};
        const sels = [];
        const refresh = function () {
          const used = {};
          sels.forEach(function (s) { if (s.value) used[s.value] = true; });
          sels.forEach(function (s) { Array.prototype.forEach.call(s.options, function (o) { o.disabled = !!(o.value && used[o.value] && o.value !== s.value); }); });
        };
        (it.left || []).forEach(function (l, i) {
          const sid = nm + '-' + i;
          const s = h('select', { class: 'pf-in', id: sid, 'aria-label': 'مطابقة: ' + l.text }, [h('option', { value: '', text: '— اختر —' })].concat(rights.map(function (r) { return h('option', { value: r.id, text: r.text }); })));
          if (cur[l.id]) s.value = cur[l.id];
          sels.push(s);
          s.addEventListener('change', function () {
            const pairs = {};
            sels.forEach(function (x, j) { if (x.value) pairs[it.left[j].id] = x.value; });
            refresh();
            setResp(it, { pairs: pairs });
          });
          box.appendChild(h('div', { class: 'pf-mrow' }, h('label', { for: sid, class: 'pf-mtext', dir: 'auto', text: l.text }), s));
        });
        refresh();
        return box;
      }
      const multi = t === 'multi_response';
      const sel = multi ? (it.response && it.response.choices ? it.response.choices.slice() : []) : (it.response && it.response.choice ? [it.response.choice] : []);
      (it.options || []).forEach(function (o, i) {
        const rid = nm + '-' + i;
        const inp = h('input', { type: multi ? 'checkbox' : 'radio', name: multi ? rid : nm, id: rid, value: o.id });
        inp.checked = sel.indexOf(o.id) !== -1;
        const lab = h('label', { class: 'pf-opt' + (inp.checked ? ' on' : ''), for: rid }, inp, h('span', { class: 'pf-ot', dir: 'auto', text: o.text }));
        inp.addEventListener('change', function () {
          if (multi) {
            const chosen = Array.prototype.map.call(box.querySelectorAll('input:checked'), function (x) { return x.value; });
            Array.prototype.forEach.call(box.querySelectorAll('label'), function (l2) { l2.classList.toggle('on', l2.querySelector('input').checked); });
            setResp(it, { choices: chosen });
          } else {
            Array.prototype.forEach.call(box.querySelectorAll('label'), function (l2) { l2.classList.toggle('on', l2.querySelector('input').checked); });
            setResp(it, { choice: o.id });
          }
        });
        box.appendChild(lab);
      });
      return box;
    }
    async function renderQ() {
      const it = T.items[T.cur];
      clear(qBox);
      if (!it) { qBox.appendChild(h('p', { class: 'pf-loading', role: 'status', text: 'جارٍ تحميل السؤال…' })); return; }
      T.maxVisited = Math.max(T.maxVisited, T.cur);
      let hint = null;
      if (it.type_code === 'multi_response') {
        const mn = it.min_select; const mx = it.max_select;
        hint = h('p', { class: 'pf-hint', text: mn && mx ? 'اختر من ' + mn + ' إلى ' + mx + ' إجابات.' : mn ? 'اختر ' + mn + ' إجابات على الأقل.' : mx ? 'اختر ' + mx + ' إجابات على الأكثر.' : 'اختر كل الإجابات الصحيحة.' });
      } else if (it.type_code === 'matching') hint = h('p', { class: 'pf-hint', text: 'طابق كل عنصر بالخيار المناسب (لا يتكرر خيار).' });
      const clr = h('button', { type: 'button', class: 'btn s sm' }, 'مسح الإجابة');
      clr.addEventListener('click', function () { setResp(it, {}); renderQ(); });
      qBox.appendChild(h('fieldset', { class: 'pf-q' },
        h('legend', null, h('span', { class: 'qn', text: String(it.position) }), h('span', { class: 'pf-qtext', dir: 'auto', text: it.stem || '' }), h('small', { class: 'ex-pts', text: ' (' + Number(it.points) + ' درجة)' })),
        it.media && it.media.length ? await mediaNodes(it) : null, hint, controls(it), h('div', { class: 'pf-act' }, clr)));
      paintFeedback(it);
      paintNav();
    }
    async function go(pos) {
      if (pos < 1 || pos > T.n) return;
      if (!allowBack && pos < T.cur) return;
      await ensure(pos);
      T.cur = pos;
      await renderQ();
      qBox.scrollIntoView({ block: 'start' });
      ensure(Math.min(T.n, pos + 1));
    }
    prevBtn.addEventListener('click', function () { go(T.cur - 1); });
    nextBtn.addEventListener('click', function () { go(T.cur + 1); });
    flagBtn.addEventListener('click', function () { const it = T.items[T.cur]; if (!it) return; it.flagged = !it.flagged; paintNav(); scheduleSave(it.position); });

    /* ---------- التسليم ---------- */
    let submitting = false;
    async function submit(auto) {
      if (submitting) return;
      submitting = true;
      finishBtn.disabled = true;
      setStatus('busy', auto ? 'انتهى الوقت: جارٍ التسليم…' : 'جارٍ التسليم…');
      try {
        await flush();
        await rpc('exam_submit', { p_attempt_id: id });
        closeNow();
      } catch (err) {
        submitting = false;
        finishBtn.disabled = false;
        if (isSession(err)) { fatal(err); return; }
        if (auto) { closeNow(); return; } /* الخادم يغلق المحاولة المنتهية عند أول نداء */
        bannerEl.textContent = errText(err);
        bannerEl.hidden = false;
        setStatus('err', 'تعذّر التسليم');
      }
    }
    finishBtn.addEventListener('click', async function () {
      const un = T.n - T.answered;
      const ok = await confirmDialog('إنهاء الاختبار؟', (un > 0 ? 'لديك ' + un + ' سؤالًا بلا إجابة. ' : 'أجبتَ عن كل الأسئلة. ') + 'بعد الإنهاء لا يمكنك تعديل إجاباتك.', 'إنهاء وتسليم');
      if (ok) submit(false);
    });

    /* ---------- المؤقت ---------- */
    let warned5 = false;
    let warned1 = false;
    function tick() {
      if (T.deadline === null) { timerEl.textContent = 'بلا مؤقت'; return; }
      const left = (T.deadline - nowMs()) / 1000;
      timerEl.textContent = fmtClock(left);
      timerEl.classList.toggle('low', left <= 300);
      if (left <= 300 && !warned5) { warned5 = true; liveEl.textContent = 'تبقّى خمس دقائق.'; }
      if (left <= 60 && !warned1) { warned1 = true; liveEl.textContent = 'تبقّت دقيقة واحدة.'; }
      if (left <= 0) { submit(true); }
    }
    tick();
    const iv = setInterval(tick, 1000);
    onCleanup(function () { clearInterval(iv); });

    /* ---------- المراقبة (إن فعّلها المدرب) ---------- */
    function warn(kind, label) {
      rpc('exam_log_event', { p_attempt_id: id, p_kind: kind, p_details: {} }).catch(function () { /* لا يمنع الاختبار */ });
      T.warnings += 1;
      const max = Number(sec.max_warnings);
      bannerEl.textContent = 'تنبيه (' + T.warnings + (max ? ' من ' + max : '') + '): ' + label;
      bannerEl.hidden = false;
      if (max && T.warnings > max && sec.on_exceed === 'auto_submit') submit(true);
    }
    if (sec.monitoring) {
      const onVis = function () { if (doc.hidden) warn('visibility_hidden', 'غادرتَ نافذة الاختبار.'); };
      const onBlur = function () { if (!doc.hidden) warn('blur', 'فقدت نافذة الاختبار التركيز.'); };
      const onCopy = function (e) { e.preventDefault(); warn('copy_attempt', 'النسخ غير مسموح أثناء الاختبار.'); };
      const onCtx = function (e) { e.preventDefault(); };
      doc.addEventListener('visibilitychange', onVis);
      window.addEventListener('blur', onBlur);
      shell.addEventListener('copy', onCopy);
      shell.addEventListener('cut', onCopy);
      shell.addEventListener('contextmenu', onCtx);
      onCleanup(function () { doc.removeEventListener('visibilitychange', onVis); window.removeEventListener('blur', onBlur); });
      if (sec.fullscreen_required) {
        const gate = h('div', { class: 'ex-gate', role: 'alertdialog', 'aria-label': 'ملء الشاشة مطلوب', hidden: true },
          h('div', null, h('p', { text: 'هذا الاختبار يتطلب وضع ملء الشاشة.' }),
            h('button', { type: 'button', class: 'btn p', onclick: function () { if (doc.documentElement.requestFullscreen) doc.documentElement.requestFullscreen().catch(function () { /* تجاهل */ }); } }, 'الدخول في ملء الشاشة')));
        shell.appendChild(gate);
        const onFs = function () {
          const inFs = !!doc.fullscreenElement;
          gate.hidden = inFs;
          if (!inFs) warn('fullscreen_exit', 'خرجتَ من وضع ملء الشاشة.');
        };
        doc.addEventListener('fullscreenchange', onFs);
        gate.hidden = !!doc.fullscreenElement;
        onCleanup(function () { doc.removeEventListener('fullscreenchange', onFs); });
      }
    }

    /* ---------- حماية المغادرة العرضية ---------- */
    const bu = function (e) { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', bu);
    onCleanup(function () { window.removeEventListener('beforeunload', bu); if (doc.fullscreenElement && doc.exitFullscreen) { try { doc.exitFullscreen(); } catch (e) { /* تجاهل */ } } });

    paintNav();
    await renderQ();
    ensure(Math.min(T.n, 2));
  }

  /* ================================================================== النتيجة والمراجعة */
  async function showResult(id) {
    const token = ++nav;
    const root = view();
    clear(root);
    doc.title = 'نتيجة الاختبار | لوحة المتدرب';
    root.appendChild(h('p', { class: 'pf-loading', role: 'status', text: 'جارٍ تحميل النتيجة…' }));
    let r;
    try { r = await rpc('exam_attempt_result', { p_attempt_id: id }); } catch (err) {
      if (token !== nav) return;
      if (isSession(err)) { fatal(err); return; }
      clear(root);
      if (err instanceof P.ApiError && err.code === '55000') { window.location.replace('#attempt=' + id); return; } /* ما زالت جارية */
      root.appendChild(fail(errText(err), function () { showResult(id); })); root.appendChild(backLink());
      return;
    }
    if (token !== nav) return;
    clear(root);
    root.appendChild(h('div', { class: 'pf-fade' }, backLink()));
    const head = h('section', { class: 'pf-block' }, h('h1', { text: 'نتيجة الاختبار' }));
    if (r.status === 'voided') head.appendChild(h('p', { class: 'pf-msg err', role: 'status', text: 'أُلغيت هذه المحاولة لانتهاء وقتها دون تسليم، ولا تُحسب لك درجة.' }));
    else if (r.result_visible) {
      head.appendChild(h('p', { class: 'ex-score' }, h('b', { text: Number(r.score) + ' / ' + Number(r.max_score) }), '  ', h('span', { text: '(' + r.percent + '%)' })));
      if (r.passed === true) head.appendChild(h('span', { class: 'st ok', text: 'ناجح' }));
      else if (r.passed === false) head.appendChild(h('span', { class: 'st soon', text: 'لم يتحقق حدّ النجاح' }));
      if (r.status === 'timed_out') head.appendChild(h('p', { class: 'pf-hint', text: 'انتهى الوقت فسُلِّمت إجاباتك تلقائيًا.' }));
    } else head.appendChild(h('p', { class: 'pf-msg', role: 'status', text: 'تم تسليم إجاباتك. تُعرض النتيجة لاحقًا بحسب إعدادات هذا الاختبار.' }));
    head.appendChild(h('p', { class: 'pf-hint', text: 'أجبتَ عن ' + r.answered_count + ' من ' + r.item_count + ' سؤالًا.' }));
    head.appendChild(h('div', { class: 'pf-act' }, h('a', { class: 'btn s', href: '#exam=' + r.exam_id }, 'صفحة الاختبار')));
    root.appendChild(head);
    if (Array.isArray(r.review) && r.review.length) {
      root.appendChild(h('section', { class: 'pf-block' }, h('h2', { text: 'مراجعة الإجابات' }), h('ol', { class: 'pf-qlist pf-review' }, r.review.map(reviewItem))));
    }
  }
  function reviewItem(it) {
    const ca = it.correct_answer || {};
    const resp = it.response || {};
    const mark = Number(it.final_score) >= Number(it.points) ? 'good' : (Number(it.final_score) > 0 ? 'part' : 'bad');
    const body = h('div');
    if (it.type_code === 'matching') {
      const rtxt = {};
      (it.right || []).forEach(function (x) { rtxt[x.id] = x.text; });
      (it.left || []).forEach(function (l) {
        const mine = resp.pairs && resp.pairs[l.id];
        const right = ca.pairs && ca.pairs[l.id];
        body.appendChild(h('div', { class: 'pf-mrow' }, h('span', { class: 'pf-mtext', dir: 'auto', text: l.text }),
          h('span', { class: 'pf-opt ' + (mine && mine === right ? 'good' : 'bad') }, h('span', { class: 'pf-ot', dir: 'auto', text: (mine ? rtxt[mine] : 'بلا إجابة') + (mine && mine !== right && right ? '  ←  الصحيح: ' + rtxt[right] : '') }))));
      });
    } else {
      const mine = it.type_code === 'multi_response' ? (resp.choices || []) : (resp.choice ? [resp.choice] : []);
      const right = it.type_code === 'multi_response' ? (ca.choices || []) : (ca.choice ? [ca.choice] : []);
      (it.options || []).forEach(function (o) {
        const isRight = right.indexOf(o.id) !== -1;
        const isMine = mine.indexOf(o.id) !== -1;
        body.appendChild(h('div', { class: 'pf-opt' + (isRight ? ' good' : (isMine ? ' bad' : '')) }, h('span', { class: 'pf-ot', dir: 'auto', text: o.text + (isMine ? '  (اخترتَ)' : '') + (isRight ? '  ✓' : '') })));
      });
    }
    return h('li', { class: 'pf-q ex-rv ' + mark }, h('fieldset', null,
      h('legend', null, h('span', { class: 'qn', text: String(it.position) }), h('span', { class: 'pf-qtext', dir: 'auto', text: it.stem || '' }), h('small', { class: 'ex-pts', text: ' (' + Number(it.final_score) + ' / ' + Number(it.points) + ')' })),
      body,
      it.feedback ? h('p', { class: 'pf-hint', text: it.feedback }) : null,
      it.explanation ? h('div', { class: 'ex-expl' }, h('b', { text: 'الشرح: ' }), it.explanation) : null));
  }

  /* ================================================================== واجهة عامة */
  function show(kind, id) {
    leave();
    if (!UUID.test(id || '')) { clear(view()); view().appendChild(fail('رابط غير صحيح.')); view().appendChild(backLink()); return; }
    if (kind === 'exam') showIntro(id); else if (kind === 'attempt') showAttempt(id); else showResult(id);
  }
  window.Exams = {
    section: section,
    show: show,
    leave: leave,
    setCourseTitles: function (fn) { if (typeof fn === 'function') courseTitles = fn; }
  };
})();
