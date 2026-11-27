/* =====================================================================
   dashboard.js — صفحة /dashboard/ (لوحة المتدرب)
   ملف عادي (ES2017) يُحمَّل بـ defer بعد platform-api.js. يبني كل الواجهة بـ createElement/textContent (دالة h)،
   فلا يدخل أي نص من قاعدة البيانات في innerHTML ولا في أي خاصية مضمّنة. الروابط الخارجية تمر بفحص http/https فقط
   وتُفتح بـ rel="noopener noreferrer"، والفيديو لا يُضمَّن إلا من المضيفين المسموحين (انظر videoEmbed).

   التدفق
   - بلا جلسة محفوظة: تحويل فوري إلى /account/. ومع جلسة: تجديد تلقائي عند الحاجة (platform-api.js)، وإن رُفض التجديد
     نهائيًا تُمسح الجلسة ويُحوَّل إلى /account/?reason=expired.
   - التحميل: ملف المتدرب أولًا (profiles)، ثم بالتوازي: الدورات المنشورة، اشتراكاته النشطة، إعلان اللوحة، وأعداد الملفات
     والفيديوهات والأسئلة ومحاولاته (هذه الأربعة ثانوية: فشلها لا يمنع العرض). كل الاستعلامات بتوكن المتدرب،
     فتقرر سياسات RLS في قاعدة البيانات ما يراه (المحتوى لا يظهر إلا لمن له اشتراك نشط).
   - المسارات بـ hash: «#» = الرئيسية، و«#course=<id>» أو «#course=<id>&tab=files|videos|quiz» = عرض الدورة. تعمل أزرار
     الرجوع والتقدّم في المتصفح، وتُحفظ الدورة المفتوحة عند التحديث.
   - طلب الاشتراك: زر «اشترك» أو «سجّل اهتمامك» (في بطاقة الدورة وفي صندوق «غير مفعّلة») يستدعي Platform.mail.send({action:'interest'})
     فيحفظ الخادم الطلب ويبلّغ المدرب بالبريد ويعيد نص رسالة جاهزة. تظهر لوحة تأكيد فيها الرسالة في مربع للقراءة فقط وزر «نسخ الرسالة»
     وزر «تواصل مع المدرب» (رابط واتساب الشخصي لا يقبل نصًا جاهزًا في الرابط، ولذلك زر النسخ). عند أي عطل غير انتهاء الجلسة تبقى
     الطريقة القديمة: رابط واتساب برسالة جاهزة (subscribeText)، فلا يعلق المتدرب. الزر يُعطَّل أثناء الإرسال فلا يتكرر الطلب.
   - الخروج: تُفرَّغ الواجهة أولًا (فلا يبقى شيء من البيانات في لقطة الذاكرة السريعة bfcache)، ثم POST /auth/v1/logout
     ويُمسح التخزين، ثم تحويل بـ replace إلى /account/?reason=out. وعند عودة الصفحة من bfcache (pageshow) أو خروج في
     تبويب آخر (حدث storage) أو عودة التبويب إلى الظهور بلا جلسة: تُفرَّغ الواجهة ويُحوَّل إلى /account/.
   ===================================================================== */
(function () {
  'use strict';

  const P = window.Platform;
  const $ = function (id) { return document.getElementById(id); };
  const view = $('dash-view');
  const TITLE = document.title;

  if (!P) { view.textContent = 'تعذّر تحميل المنصة. حدّث الصفحة ثم أعد المحاولة.'; return; }
  const ui = P.ui;
  const h = ui.h;
  const icon = ui.icon;
  const clear = ui.clear;
  const errText = function (err) { return err instanceof P.ApiError ? err.message : P.MSG.other; };
  const isSession = function (err) { return err instanceof P.ApiError && err.kind === 'session'; };
  const settle = function (p) { return p.then(function (v) { return { ok: true, v: v }; }, function (e) { return { ok: false, e: e }; }); };

  /* حالة الصفحة */
  const S = {
    uid: '', email: '', profile: null, announce: '',
    courses: [], enrolled: {}, items: [], questions: [], attempts: [], statsOk: false,
    nav: 0, view: ''
  };
  const canOpen = function (id) { return !!S.enrolled[id] && !!S.profile && S.profile.status === 'active'; };
  const courseById = function (id) { return S.courses.filter(function (c) { return c.id === id; })[0] || null; };
  const subscribeText = function (c) { return 'السلام عليكم، أرغب بالاشتراك في دورة «' + c.title_ar + '». بريدي في المنصة: ' + S.email; };
  const TRAINER_WA = 'https://wa.me/message/WFY6JB3E3WVLL1'; /* احتياطي إن خلا data-wa من الإعداد: صفحة تواصل المدرب الشخصية على واتساب */
  const trainerUrl = function () { return P.safeUrl(P.config.whatsapp || TRAINER_WA); };
  const interestLabel = function (c) { return c.status !== 'available' ? 'سجّل اهتمامك' : 'اشترك'; };
  let intSeq = 0; /* يميّز معرّفات عناصر لوحات الطلب المتعددة في الصفحة */

  /* ---------- مكوّنات صغيرة ---------- */
  function loadingBlock(text) {
    return h('div', { class: 'pf-loading', role: 'status' }, h('span', { class: 'pf-spin', 'aria-hidden': 'true' }), text);
  }
  function failBlock(text, onRetry) {
    return h('div', { class: 'pf-fail pf-card' },
      h('p', { class: 'pf-msg err', role: 'alert', text: text }),
      onRetry ? h('div', { class: 'btns' }, h('button', { type: 'button', class: 'btn p', on: { click: onRetry } }, 'إعادة المحاولة')) : null);
  }
  function emptyBox(title, text, extra) {
    return h('div', { class: 'pf-empty' }, h('b', { text: title }), h('p', { text: text }), extra || null);
  }
  function field(id, label, control, hint) {
    return h('div', { class: 'pf-field' },
      h('label', { for: id, text: label }),
      control,
      hint ? h('p', { class: 'pf-hint', id: id + '-hint', text: hint }) : null,
      h('p', { class: 'pf-ferr', id: id + '-err', hidden: true }));
  }
  function textInput(id, o) {
    const a = {
      class: 'pf-in' + (o.ltr ? ' ltr' : ''), id: id, name: id, type: o.type || 'text', value: o.value || '',
      autocomplete: o.auto, maxlength: o.max, inputmode: o.inputmode, readonly: o.readonly, required: o.required,
      'aria-describedby': (o.hint ? id + '-hint ' : '') + id + '-err'
    };
    if (o.ltr) a.dir = 'ltr';
    return h('input', a);
  }
  function countrySelect(id, current) {
    const sel = h('select', { class: 'pf-in', id: id, name: id, autocomplete: 'country-name', required: true, 'aria-describedby': id + '-err' });
    const list = P.COUNTRIES.slice();
    const cur = String(current || '').trim();
    if (cur && list.indexOf(cur) === -1) list.unshift(cur);
    sel.appendChild(h('option', { value: '', text: 'اختر دولتك' }));
    list.forEach(function (c) { sel.appendChild(h('option', { value: c, text: c })); });
    sel.value = cur;
    return sel;
  }
  function passwordField(id, label, o) {
    const input = h('input', {
      class: 'pf-in ltr', dir: 'ltr', id: id, name: id, type: 'password', autocomplete: o.auto, maxlength: 72, required: true,
      'aria-describedby': (o.hint ? id + '-hint ' : '') + (o.meter ? id + '-meter-label ' : '') + id + '-err'
    });
    const reveal = h('button', { type: 'button', class: 'pf-reveal', 'aria-label': 'إظهار كلمة المرور', 'aria-pressed': 'false', text: 'إظهار' });
    ui.bindReveal(reveal, input);
    const kids = [h('label', { for: id, text: label }), h('div', { class: 'pf-pw' }, input, reveal)];
    if (o.meter) {
      const bar = h('div', { class: 'pf-meter', 'data-level': '0', 'aria-hidden': 'true' }, h('span'), h('span'), h('span'), h('span'));
      const lab = h('p', { class: 'pf-meter-label', id: id + '-meter-label' });
      ui.bindStrength(input, bar, lab);
      kids.push(bar, lab);
    }
    if (o.hint) kids.push(h('p', { class: 'pf-hint', id: id + '-hint', text: o.hint }));
    kids.push(h('p', { class: 'pf-ferr', id: id + '-err', hidden: true }));
    return { el: h('div', { class: 'pf-field' }, kids), input: input };
  }
  function clearInvalidOnInput(form) {
    Array.prototype.forEach.call(form.querySelectorAll('.pf-in'), function (inp) {
      inp.addEventListener('input', function () { if (inp.getAttribute('aria-invalid')) ui.fieldError(inp, ''); });
    });
  }

  /* ---------- طلب الاشتراك / تسجيل الاهتمام (وظيفة send-mail، الإجراء interest) ---------- */
  /* نسخ نص إلى الحافظة: واجهة الحافظة الحديثة أولًا (تحتاج سياقًا آمنًا: https أو localhost)، ثم تحديد النص وexecCommand بديلًا.
     عند فشل الاثنين يبقى النص محدّدًا في المربع فينسخه المتدرب يدويًا. */
  async function copyText(text, ta) {
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function' && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* ممنوع أو غير مدعوم: ننتقل إلى البديل */ }
    try {
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      return !!document.execCommand('copy');
    } catch (e) { return false; }
  }

  /* يعيد {btn, slot}: الزر يوضع حيث يريد المستدعي، وslot (الحالة واللوحة) يوضع بعده مباشرة وهو مخفي حتى يوجد ما يُعرض.
     رسائل الحالة والخطأ بـ ui.msg (role=status للتقدّم وrole=alert للخطأ كبقية الصفحة)، ولوحة النجاح تأخذ التركيز فتُقرأ فورًا. */
  function interestControl(c) {
    const live = h('div', { class: 'pf-msg', hidden: true });
    const extra = h('div', { class: 'pf-int-extra' });
    const slot = h('div', { class: 'pf-int', hidden: true }, live, extra);
    const btn = h('button', { type: 'button', class: 'btn p' }, ui.waIcon(), interestLabel(c));
    const say = function (kind, text) {
      slot.hidden = false;
      ui.msg(live, kind, text);
    };

    /* الطريق القديم عند الفشل: رابط واتساب برسالة جاهزة، كي لا يعلق المتدرب */
    function showFallback() {
      const wa = P.waLink(subscribeText(c));
      if (!wa) return;
      extra.appendChild(h('div', { class: 'pf-int-fb' },
        h('p', { class: 'pf-int-sub', text: 'يمكنك مراسلة المدرب مباشرة برسالة جاهزة على واتساب:' }),
        h('div', { class: 'pf-int-act' }, h('a', { class: 'btn s', href: wa, target: '_blank', rel: 'noopener noreferrer' }, ui.waIcon(), 'اكتب للمدرب عبر واتساب'))));
    }

    function showResult(res) {
      const n = ++intSeq;
      const headId = 'int-h-' + n;
      const taId = 'int-ta-' + n;
      const sub = res.mailed
        ? 'لتسريع الاتفاق أرسل للمدرب الرسالة نفسها عبر واتساب: انسخها ثم افتح المحادثة والصقها.'
        : res.reason === 'duplicate'
          ? 'سبق أن أرسلتَ طلبًا لهذه الدورة قبل قليل فلم نكرّره. يمكنك نسخ الرسالة وإرسالها للمدرب عبر واتساب.'
          : 'حُفظ طلبك لدينا. وللتأكد من وصوله أرسل للمدرب الرسالة نفسها عبر واتساب: انسخها ثم افتح المحادثة والصقها.';
      const head = h('p', { class: 'pf-int-h', id: headId, tabindex: '-1' }, icon('check'), res.mailed ? 'تم إرسال طلبك إلى المدرب' : 'تم حفظ طلبك');
      /* النص يأتي جاهزًا من الخادم (value لا HTML)؛ وإن غاب نركّب الرسالة القديمة محليًا */
      const ta = h('textarea', { class: 'pf-in pf-int-ta', id: taId, readonly: true, rows: 6, 'aria-describedby': headId });
      ta.value = res.message || subscribeText(c);
      const state = h('p', { class: 'pf-int-state', role: 'status', 'aria-live': 'polite' });
      const copy = h('button', { type: 'button', class: 'btn s' }, 'نسخ الرسالة');
      copy.addEventListener('click', async function () {
        const ok = await copyText(ta.value, ta);
        state.className = 'pf-int-state' + (ok ? '' : ' err');
        state.textContent = ok ? 'تم نسخ الرسالة. الصقها في محادثة واتساب مع المدرب.' : 'تعذّر النسخ تلقائيًا. الرسالة محدّدة الآن، فانسخها يدويًا.';
      });
      const wa = trainerUrl();
      const contact = wa ? h('a', { class: 'btn p', href: wa, target: '_blank', rel: 'noopener noreferrer' }, ui.waIcon(), 'تواصل مع المدرب') : null;
      const close = h('button', { type: 'button', class: 'btn s' }, 'إغلاق');
      close.addEventListener('click', function () {
        clear(extra);
        slot.hidden = true;
        btn.hidden = false;
        try { btn.focus(); } catch (e) { /* تجاهل */ }
      });
      ui.clearMsg(live);
      clear(extra);
      slot.hidden = false;
      extra.appendChild(h('div', { class: 'pf-int-panel', role: 'group', 'aria-labelledby': headId },
        head,
        h('p', { class: 'pf-int-sub', text: sub }),
        h('label', { class: 'pf-lab', for: taId, text: 'نص الرسالة الجاهز' }),
        ta, state,
        h('div', { class: 'pf-int-act' }, copy, contact, close)));
      btn.hidden = true;
      ta.style.height = 'auto'; /* يتمدّد المربع ليظهر النص كاملًا بلا شريط تمرير داخلي (بحدّ أقصى) ويبقى قابلًا للسحب رأسيًا */
      ta.style.height = Math.min(ta.scrollHeight + 2, 360) + 'px';
      try { head.focus(); } catch (e) { /* تجاهل */ }
    }

    const send = ui.guard(btn, live, async function () {
      clear(extra);
      say('info', 'جارٍ إرسال طلبك إلى المدرب…');
      const res = await P.mail.send({ action: 'interest', course_id: c.id });
      if (!slot.isConnected) return false; /* تبدّل العرض أو خرج المتدرب أثناء الطلب */
      if (res.ok) { showResult(res); return false; }
      if (res.error === 'auth_required' || res.error === 'invalid_token') { wipe(); P.goLogin('expired'); return false; }
      say('err', P.mail.text(res));
      showFallback();
      return false;
    });
    btn.addEventListener('click', async function (e) {
      await send(e); /* بعد انتهاء المعالج يكون الزر قد فُكّ تعطيله */
      if (!slot.isConnected || btn.hidden) return;
      const a = document.activeElement;
      if (!a || a === document.body) { try { btn.focus(); } catch (err) { /* تجاهل */ } } /* التعطيل يُسقط التركيز: نعيده لمن يستعمل لوحة المفاتيح */
    });
    return { btn: btn, slot: slot };
  }

  /* خطأ أثناء عملية: انتهاء الجلسة يحوّل إلى الدخول، وغيره يظهر في عنصر الرسالة */
  function failWith(err, out) {
    if (isSession(err)) { wipe(); P.goLogin('expired'); return; }
    ui.msg(out, 'err', errText(err));
  }

  /* تفريغ كل ما يخص المتدرب من الصفحة (عند الخروج أو فقدان الجلسة) */
  function wipe() {
    S.nav++;
    S.view = '';
    S.profile = null; S.announce = ''; S.courses = []; S.enrolled = {}; S.items = []; S.questions = []; S.attempts = [];
    clear(view);
    $('dash-hello').textContent = '';
    $('dash-announce').hidden = true;
    $('dash-announce-text').textContent = '';
    $('dash-admin').hidden = true;
    $('dash-admin').removeAttribute('href');
    $('dash-jump').hidden = true;
    document.title = TITLE;
  }

  /* ---------- التحميل ---------- */
  async function loadAll() {
    const uid = S.uid;
    const prof = await P.rest.select('profiles', { select: 'id,full_name,phone,country,role,status,last_seen_at', id: 'eq.' + uid });
    if (!prof.length) throw new P.ApiError('notfound', 'تعذّر العثور على ملفك الشخصي. تواصل مع المدرب.', 404, 'no_profile');
    S.profile = prof[0];
    const r = await Promise.all([
      settle(P.rest.select('courses', { select: 'id,title_ar,title_en,status,sort', published: 'eq.true', order: 'sort.asc' })),
      settle(P.rest.select('enrollments', { select: 'course_id', user_id: 'eq.' + uid, status: 'eq.active' })),
      settle(P.rest.select('site_settings', { select: 'value', key: 'eq.dashboard_announcement' })),
      settle(P.rest.select('course_items', { select: 'id,course_id,kind', published: 'eq.true' })),
      settle(P.rest.select('quiz_questions', { select: 'id,course_id', published: 'eq.true' })),
      settle(P.rest.select('quiz_attempts', { select: 'id,course_id,score,total,created_at', user_id: 'eq.' + uid, order: 'created_at.desc', limit: '200' }))
    ]);
    r.forEach(function (x) { if (!x.ok && isSession(x.e)) throw x.e; });
    if (!r[0].ok) throw r[0].e;
    if (!r[1].ok) throw r[1].e;
    S.courses = r[0].v;
    S.enrolled = {};
    r[1].v.forEach(function (e) { S.enrolled[e.course_id] = true; });
    S.announce = '';
    if (r[2].ok && r[2].v[0] && r[2].v[0].value) {
      const a = r[2].v[0].value;
      if (a.active === true && typeof a.text === 'string' && a.text.trim()) S.announce = a.text.trim();
    }
    S.statsOk = r[3].ok && r[4].ok;
    S.items = r[3].ok ? r[3].v : [];
    S.questions = r[4].ok ? r[4].v : [];
    S.attempts = r[5].ok ? r[5].v : [];
  }

  /* آخر ظهور: يُسجَّل مرة كل نصف ساعة على الأكثر، وفشله لا يهم */
  function touchSeen() {
    const last = S.profile.last_seen_at ? Date.parse(S.profile.last_seen_at) : 0;
    if (Date.now() - last < 30 * 60 * 1000) return;
    P.rest.update('profiles', { id: 'eq.' + S.uid }, { last_seen_at: new Date().toISOString() }).then(function (rows) {
      if (rows[0] && S.profile) S.profile.last_seen_at = rows[0].last_seen_at;
    }, function () { /* تجاهل */ });
  }

  function renderHeader() {
    const p = S.profile;
    $('dash-hello').textContent = 'مرحبًا، ' + (p.full_name || S.email);
    const admin = $('dash-admin');
    if (p.role === 'admin') { admin.setAttribute('href', '/admin/'); admin.hidden = false; } else { admin.removeAttribute('href'); admin.hidden = true; }
    const box = $('dash-announce');
    if (S.announce) { $('dash-announce-text').textContent = S.announce; box.hidden = false; } else { box.hidden = true; }
  }

  /* ---------- الرئيسية ---------- */
  function stats(id) {
    const o = { files: 0, videos: 0, questions: 0 };
    S.items.forEach(function (i) { if (i.course_id === id) { if (i.kind === 'file') o.files++; else if (i.kind === 'video') o.videos++; } });
    S.questions.forEach(function (q) { if (q.course_id === id) o.questions++; });
    return o;
  }
  function stat(label, n) { return h('li', null, label + ' ', h('b', { text: String(n) })); }

  function cardMine(c) {
    const st = S.statsOk ? stats(c.id) : null;
    const last = S.attempts.filter(function (a) { return a.course_id === c.id; })[0];
    return h('article', { class: 'card pf-course' },
      h('div', { class: 'pf-ct' }, h('h3', { text: c.title_ar }), h('span', { class: 'st ok', text: 'مشترك' })),
      h('div', { class: 'pf-en', text: c.title_en }),
      st ? h('ul', { class: 'pf-stats' }, stat('الملفات', st.files), stat('الفيديوهات', st.videos), stat('الأسئلة', st.questions)) : null,
      h('p', { class: 'pf-last' }, last
        ? ['آخر نتيجة في الأسئلة المحاكية: ', h('b', { text: last.score + '/' + last.total + ' (' + P.pct(last.score, last.total) + '%)' }), ' — ' + P.fmtDate(last.created_at)]
        : 'لم تجرّب الأسئلة المحاكية بعد.'),
      h('div', { class: 'pf-act' }, h('a', { class: 'btn p', href: '#course=' + c.id }, 'افتح الدورة')));
  }
  function cardAvail(c) {
    const enrolled = !!S.enrolled[c.id];
    const soon = c.status !== 'available';
    let act = null;
    let slot = null; /* حالة طلب الاشتراك ولوحة الرسالة الجاهزة (تظهر تحت الزر) */
    if (enrolled) act = h('a', { class: 'btn p', href: '#course=' + c.id }, 'افتح الدورة');
    else {
      const ctl = interestControl(c);
      act = ctl.btn;
      slot = ctl.slot;
    }
    return h('article', { class: 'card pf-course' },
      h('div', { class: 'pf-ct' },
        h('h3', { text: c.title_ar }),
        enrolled ? h('span', { class: 'st ok', text: 'مشترك' }) : h('span', { class: soon ? 'st soon' : 'st ok', text: soon ? 'قريبًا' : 'متاحة الآن' })),
      h('div', { class: 'pf-en', text: c.title_en }),
      h('div', { class: 'pf-act' }, act),
      slot);
  }

  function sectionMine() {
    const mine = S.courses.filter(function (c) { return S.enrolled[c.id]; });
    const sec = h('section', { class: 'pf-block', id: 'sec-mine', 'aria-labelledby': 'h-mine' }, h('h2', { id: 'h-mine', text: 'دوراتي' }));
    if (!mine.length) {
      sec.appendChild(emptyBox('لم تشترك في أي دورة بعد',
        'تصفّح الدورات المتاحة أدناه. وبعد اتفاقك مع المدرب عبر واتساب يفعّل الدورة في حسابك فتظهر هنا بملفاتها وفيديوهاتها وأسئلتها.',
        h('a', { class: 'btn s', href: '#sec-avail' }, 'تصفّح الدورات المتاحة')));
    } else {
      sec.appendChild(h('div', { class: 'pf-grid' }, mine.map(cardMine)));
    }
    return sec;
  }
  function sectionAvail() {
    const sec = h('section', { class: 'pf-block', id: 'sec-avail', 'aria-labelledby': 'h-avail' },
      h('h2', { id: 'h-avail', text: 'الدورات المتاحة' }),
      h('p', { class: 'sub', text: 'اضغط «اشترك» أو «سجّل اهتمامك» فيصل طلبك إلى المدرب مع رسالة جاهزة تنسخها وترسلها له عبر واتساب، وبعد الاتفاق يفعّل الدورة في حسابك.' }));
    if (!S.courses.length) sec.appendChild(emptyBox('لا توجد دورات متاحة حاليًا', 'ستظهر هنا الدورات فور نشرها.'));
    else sec.appendChild(h('div', { class: 'pf-grid' }, S.courses.map(cardAvail)));
    return sec;
  }

  function profileCard() {
    const p = S.profile;
    const nameI = textInput('dp-name', { value: p.full_name, auto: 'name', max: 120, required: true });
    const emailI = textInput('dp-email', { value: S.email, type: 'email', ltr: true, readonly: true, hint: true });
    const phoneI = textInput('dp-phone', { value: p.phone, type: 'tel', ltr: true, auto: 'tel', max: 40, inputmode: 'tel', required: true, hint: true });
    const countryS = countrySelect('dp-country', p.country);
    const out = h('div', { class: 'pf-msg', hidden: true });
    const btn = h('button', { type: 'submit', class: 'btn p' }, 'حفظ التغييرات');
    const form = h('form', { class: 'pf-form', novalidate: true, method: 'post', action: '/dashboard/' },
      out,
      field('dp-name', 'الاسم الكامل', nameI),
      field('dp-email', 'البريد الإلكتروني', emailI, 'لا يمكن تغيير البريد من هنا.'),
      field('dp-phone', 'رقم الهاتف / واتساب', phoneI, 'مع رمز الدولة، ليتواصل معك المدرب.'),
      field('dp-country', 'الدولة', countryS),
      btn);
    clearInvalidOnInput(form);
    form.addEventListener('submit', ui.guard(btn, out, async function () {
      ui.clearMsg(out);
      const bag = {};
      const name = ui.check(nameI, P.v.name(nameI.value), bag);
      const phone = ui.check(phoneI, P.v.phone(phoneI.value), bag);
      const country = ui.check(countryS, P.v.country(countryS.value), bag);
      if (bag.first) { bag.first.focus(); return false; }
      try {
        const rows = await P.rest.update('profiles', { id: 'eq.' + S.uid }, { full_name: name, phone: phone, country: country });
        if (!rows.length) throw new P.ApiError('forbidden', P.MSG.forbidden, 403, 'no_rows');
        Object.assign(S.profile, rows[0]);
      } catch (err) { failWith(err, out); return false; }
      nameI.value = S.profile.full_name || '';
      phoneI.value = S.profile.phone || '';
      renderHeader();
      ui.msg(out, 'ok', 'تم حفظ التغييرات.');
      return false;
    }));
    return h('div', { class: 'pf-card' }, h('h3', { text: 'بياناتي' }), form);
  }

  function passwordCard() {
    const cur = passwordField('pw-cur', 'كلمة المرور الحالية', { auto: 'current-password' });
    const nw = passwordField('pw-new', 'كلمة المرور الجديدة', { auto: 'new-password', meter: true, hint: '٨ أحرف على الأقل، ويفضّل أن تجمع بين الحروف والأرقام والرموز.' });
    const nw2 = passwordField('pw-new2', 'تأكيد كلمة المرور الجديدة', { auto: 'new-password' });
    const out = h('div', { class: 'pf-msg', hidden: true });
    const btn = h('button', { type: 'submit', class: 'btn p' }, 'تغيير كلمة المرور');
    const form = h('form', { class: 'pf-form', novalidate: true, method: 'post', action: '/dashboard/' }, out, cur.el, nw.el, nw2.el, btn);
    clearInvalidOnInput(form);
    form.addEventListener('submit', ui.guard(btn, out, async function () {
      ui.clearMsg(out);
      const bag = {};
      ui.check(cur.input, cur.input.value ? { value: cur.input.value } : { error: 'اكتب كلمة المرور الحالية.' }, bag);
      const pw = ui.check(nw.input, P.v.password(nw.input.value), bag);
      const same = nw2.input.value === nw.input.value;
      ui.fieldError(nw2.input, same ? '' : 'كلمتا المرور غير متطابقتين.');
      if (!same && !bag.first) bag.first = nw2.input;
      if (pw && cur.input.value && pw === cur.input.value) { ui.fieldError(nw.input, 'كلمة المرور الجديدة يجب أن تختلف عن الحالية.'); if (!bag.first) bag.first = nw.input; }
      if (bag.first) { bag.first.focus(); return false; }
      try {
        /* نتحقق من كلمة المرور الحالية بإعادة تسجيل الدخول، فلا يكفي توكن مسروق وحده لتغيير كلمة المرور */
        try { await P.auth.signIn(S.email, cur.input.value); } catch (err) {
          if (err instanceof P.ApiError && err.code === 'invalid_credentials') {
            ui.fieldError(cur.input, 'كلمة المرور الحالية غير صحيحة.');
            cur.input.focus();
            return false;
          }
          throw err;
        }
        await P.auth.updatePassword(pw);
      } catch (err) { failWith(err, out); return false; }
      form.reset();
      nw.input.dispatchEvent(new Event('input'));
      ui.msg(out, 'ok', 'تم تغيير كلمة المرور بنجاح.');
      return false;
    }));
    return h('div', { class: 'pf-card' }, h('h3', { text: 'تغيير كلمة المرور' }), form);
  }

  function deleteCard() {
    const wa = P.waLink('السلام عليكم، أرغب بحذف حسابي وبياناتي من المنصة. بريدي في المنصة: ' + S.email);
    return h('div', { class: 'pf-card pf-del' },
      h('h3', { text: 'حذف الحساب' }),
      h('p', { class: 'pf-note', text: 'لحذف حسابك وبياناتك من المنصة، تواصل مع المدرب عبر واتساب وسيتولى تنفيذ الطلب.' }),
      wa ? h('a', { class: 'btn s', href: wa, target: '_blank', rel: 'noopener noreferrer' }, ui.waIcon(), 'طلب حذف الحساب') : null);
  }

  function sectionInfo() {
    return h('section', { class: 'pf-block', id: 'sec-info', 'aria-labelledby': 'h-info' },
      h('h2', { id: 'h-info', text: 'معلوماتي' }),
      h('div', { class: 'pf-two' }, profileCard(), passwordCard()),
      deleteCard());
  }

  function showHome() {
    S.nav++;
    S.view = 'home';
    document.title = TITLE;
    clear(view);
    view.appendChild(h('div', { class: 'pf-fade' },
      S.profile.status !== 'active'
        ? h('p', { class: 'pf-msg err pf-warn', role: 'status', text: 'حسابك موقوف حاليًا، فلا يظهر لك محتوى الدورات. تواصل مع المدرب لمعرفة السبب.' })
        : null,
      sectionMine(),
      window.Exams ? window.Exams.section({ active: S.profile.status === 'active', courseTitle: function (id) { const c = courseById(id); return c ? c.title_ar : id; } }) : null,
      sectionAvail(), sectionInfo()));
    $('dash-jump').hidden = false;
  }

  /* ---------- الفيديو: التضمين فقط من مضيفين مسموحين، بعد تطبيع الرابط ---------- */
  /* الدالة في platform-api.js (P.videoEmbed) لتتشارك فيها لوحة المدرب: تعيد {src} بعنوان تضمين آمن، أو null إن لم يكن المضيف أو شكل الرابط من المسموح */
  const videoEmbed = P.videoEmbed;
  const httpUrl = function (u) { const s = P.safeUrl(u); return s && /^https?:\/\//i.test(s) ? s : null; };
  function hostOf(u) { try { return new URL(u).hostname; } catch (e) { return ''; } }
  function extOf(it) {
    let name = it.storage_path || '';
    if (!name && it.url) { try { name = new URL(it.url).pathname; } catch (e) { name = ''; } }
    const m = /\.([A-Za-z0-9]{2,5})$/.exec(name);
    return m ? m[1].toUpperCase() : '';
  }

  /* فتح ملف من التخزين الخاص برابط موقّع قصير العمر. تُفتح نافذة فارغة أثناء نقرة المستخدم (لئلا يحجبها المتصفح)
     ثم توجَّه إلى الرابط الموقّع؛ وإن حُجبت النافذة يظهر رابط يضغطه المستخدم بنفسه. */
  async function openStored(it, btn, note) {
    if (btn.disabled) return;
    clear(note);
    ui.setBusy(btn, true);
    const w = window.open('', '_blank');
    if (w) { try { w.opener = null; } catch (e) { /* تجاهل */ } }
    try {
      const url = await P.storage.signedUrl('course-files', it.storage_path, 300);
      if (w) w.location.replace(url);
      else note.appendChild(h('a', { class: 'pf-link', href: url, target: '_blank', rel: 'noopener noreferrer' }, 'اضغط هنا لفتح الملف'));
    } catch (err) {
      if (w) w.close();
      if (isSession(err)) { wipe(); P.goLogin('expired'); return; }
      note.appendChild(h('span', { text: errText(err) }));
    } finally {
      ui.setBusy(btn, false);
    }
  }

  function openButton(it, note) {
    const btn = h('button', { type: 'button', class: 'btn p' }, icon('external'), 'فتح');
    btn.addEventListener('click', function () { openStored(it, btn, note); });
    return btn;
  }

  /* ---------- عرض الدورة ---------- */
  function lockedBox(c) {
    const suspended = S.profile.status !== 'active';
    const ctl = suspended ? null : interestControl(c);
    return h('div', { class: 'pf-empty' },
      icon('lock'),
      h('b', { text: suspended ? 'حسابك موقوف حاليًا' : 'هذه الدورة غير مفعّلة في حسابك' }),
      h('p', { text: suspended
        ? 'تواصل مع المدرب لمعرفة السبب وإعادة تفعيل حسابك.'
        : 'للاشتراك فيها اضغط «' + interestLabel(c) + '» فيصل طلبك إلى المدرب مع رسالة جاهزة ترسلها له عبر واتساب، وبعد الاتفاق يفعّلها في حسابك فتظهر لك ملفاتها وفيديوهاتها وأسئلتها المحاكية.' }),
      ctl ? ctl.btn : null,
      ctl ? ctl.slot : null);
  }

  function fileItem(it) {
    const ext = extOf(it);
    const note = it.storage_path ? h('div', { class: 'pf-fallback' }) : null;
    let act = null;
    if (it.storage_path) act = openButton(it, note);
    else {
      const u = httpUrl(it.url);
      act = u ? h('a', { class: 'btn p', href: u, target: '_blank', rel: 'noopener noreferrer' }, icon('external'), 'فتح')
              : h('span', { class: 'pf-fallback', text: 'رابط الملف غير صالح.' });
    }
    return h('li', { class: 'pf-item' },
      h('span', { class: 'pf-ico' }, icon('file')),
      h('div', { class: 'pf-ibody' }, h('h3', { text: it.title }), ext ? h('small', { text: ext }) : null, note),
      act);
  }
  function videoItem(it) {
    const emb = it.url ? videoEmbed(it.url) : null;
    const ext = it.url ? httpUrl(it.url) : null;
    const note = h('div', { class: 'pf-fallback' });
    const box = h('article', { class: 'pf-video' }, h('h3', { text: it.title }));
    if (emb) {
      box.appendChild(h('div', { class: 'pf-frame' }, h('iframe', {
        src: emb.src, title: it.title, loading: 'lazy',
        sandbox: 'allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox',
        allow: 'accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture; fullscreen',
        allowfullscreen: '',
        referrerpolicy: 'strict-origin-when-cross-origin'
      })));
    }
    /* الفيديو المضمَّن يُشغَّل داخل المنصة بكامل خياراته (سرعة وجودة وترجمة وملء الشاشة وصورة داخل صورة) بلا رابط خارجي؛
       الرابط الخارجي يظهر فقط للمضيفات غير المدعومة للتضمين */
    if (ext && !emb) {
      box.appendChild(h('a', { class: 'pf-vlink', href: ext, target: '_blank', rel: 'noopener noreferrer' },
        icon('external'), 'فتح الفيديو', ' ', h('span', { class: 'pf-vhost', text: hostOf(ext) })));
    } else if (!ext && it.storage_path) {
      box.appendChild(openButton(it, note));
      box.appendChild(note);
    } else if (!emb) {
      box.appendChild(h('p', { class: 'pf-fallback', text: 'رابط الفيديو غير صالح.' }));
    }
    return h('li', null, box);
  }

  function quizList(qs) {
    const list = h('ol', { class: 'pf-qlist' });
    qs.forEach(function (q, i) {
      const opts = h('div', { class: 'pf-opts' });
      q.options.forEach(function (o, j) {
        const rid = 'q' + i + 'o' + j;
        opts.appendChild(h('label', { class: 'pf-opt', for: rid },
          h('input', { type: 'radio', name: 'q' + i, id: rid, value: String(j) }),
          h('span', { class: 'pf-ot', dir: 'auto', text: o })));
      });
      list.appendChild(h('li', { class: 'pf-q' }, h('fieldset', null,
        h('legend', null, h('span', { class: 'qn', text: String(i + 1) }), h('span', { class: 'pf-qtext', dir: 'auto', text: q.question })),
        opts)));
    });
    list.addEventListener('change', function (e) {
      const r = e.target;
      if (!r || r.type !== 'radio') return;
      Array.prototype.forEach.call(list.querySelectorAll('input[name="' + r.name + '"]'), function (x) { x.parentNode.classList.toggle('on', x.checked); });
    });
    return list;
  }

  /* تصحيح تفصيلي: يُجلب مفتاح الإجابات (correct_index وexplanation) بعد التسليم فقط، فلا يُحمَّل قبل المحاولة */
  function reviewList(qs, answers, key) {
    const kmap = {};
    (key || []).forEach(function (k) { kmap[k.id] = k; });
    const list = h('ol', { class: 'pf-qlist pf-review' });
    qs.forEach(function (q, i) {
      const a = answers[i].a;
      const k = kmap[q.id];
      const right = k ? a === k.correct_index : null;
      const opts = h('div', { class: 'pf-opts' });
      q.options.forEach(function (o, j) {
        const isKey = !!k && j === k.correct_index;
        const mine = j === a;
        const cls = 'pf-opt' + (isKey ? ' good' : '') + (mine && k && !isKey ? ' bad' : '');
        opts.appendChild(h('div', { class: cls },
          h('span', { class: 'pf-ot', dir: 'auto', text: o }),
          mine ? h('span', { class: 'pf-tag ' + (k && !isKey ? 'no' : 'ok'), text: 'إجابتك' }) : null,
          isKey ? h('span', { class: 'pf-tag ok', text: 'الإجابة الصحيحة' }) : null));
      });
      list.appendChild(h('li', { class: 'pf-q' + (right === null ? '' : right ? ' right' : ' wrong') },
        right === null ? null : h('p', { class: 'pf-qverdict ' + (right ? 'ok' : 'no'), text: right ? 'إجابتك صحيحة' : 'إجابتك غير صحيحة' }),
        h('div', { class: 'pf-qhead' }, h('span', { class: 'qn', text: String(i + 1) }), h('span', { class: 'pf-qtext', dir: 'auto', text: q.question })),
        opts,
        k && k.explanation ? h('div', { class: 'pf-expl' }, h('b', { text: 'الشرح: ' }), k.explanation) : null));
    });
    return list;
  }

  function historyList(attempts) {
    const box = h('section', { class: 'pf-hist', 'aria-labelledby': 'hist-h' }, h('h3', { id: 'hist-h', text: 'محاولاتي السابقة' }));
    if (!attempts.length) {
      box.appendChild(h('p', { class: 'pf-note', text: 'لا توجد محاولات سابقة بعد.' }));
      return box;
    }
    box.appendChild(h('ol', { class: 'tbl' }, attempts.map(function (a) {
      return h('li', { class: 'tr' }, h('span', { text: P.fmtDate(a.created_at) }), h('b', { text: a.score + '/' + a.total + ' · ' + P.pct(a.score, a.total) + '%' }));
    })));
    return box;
  }

  function quizPanel(c, data) {
    const qs = data.questions;
    const hist = { attempts: data.attempts.slice() };
    const histSlot = h('div');
    const paintHist = function () { clear(histSlot); histSlot.appendChild(historyList(hist.attempts)); };
    paintHist();
    if (!qs.length) {
      return h('div', null, emptyBox('لا توجد أسئلة محاكية منشورة بعد', 'سيضيف المدرب الأسئلة المحاكية لهذه الدورة قريبًا.'), histSlot);
    }

    const out = h('div', { class: 'pf-msg', hidden: true });
    const btn = h('button', { type: 'submit', class: 'btn p' }, 'إنهاء وتصحيح');
    const list = quizList(qs);
    const form = h('form', { class: 'pf-form', novalidate: true, method: 'post', action: '/dashboard/' },
      h('p', { class: 'pf-qmeta', text: 'عدد الأسئلة: ' + qs.length + '. اختر إجابة واحدة لكل سؤال ثم اضغط «إنهاء وتصحيح»، وسيظهر التصحيح والشرح فورًا.' }),
      list,
      h('div', { class: 'pf-qact' }, btn, out));
    const resultSlot = h('div', { hidden: true });

    function retry() {
      form.reset();
      Array.prototype.forEach.call(list.querySelectorAll('.pf-opt.on'), function (l) { l.classList.remove('on'); });
      ui.clearMsg(out);
      clear(resultSlot);
      resultSlot.hidden = true;
      form.hidden = false;
      const first = form.querySelector('input[type="radio"]');
      if (first) first.focus();
    }

    form.addEventListener('submit', ui.guard(btn, out, async function () {
      ui.clearMsg(out);
      const answers = [];
      let missing = 0;
      let firstMissing = null;
      qs.forEach(function (q, i) {
        const sel = form.querySelector('input[name="q' + i + '"]:checked');
        if (sel) answers.push({ q: q.id, a: Number(sel.value) });
        else { missing++; if (!firstMissing) firstMissing = form.querySelector('input[name="q' + i + '"]'); }
      });
      if (missing) {
        ui.msg(out, 'err', 'أجب عن جميع الأسئلة قبل التصحيح. المتبقي: ' + missing + '.');
        if (firstMissing) firstMissing.focus();
        return false;
      }
      let row = null;
      try {
        row = (await P.rest.insert('quiz_attempts', { user_id: S.uid, course_id: c.id, answers: answers }))[0] || null;
        if (!row) row = (await P.rest.select('quiz_attempts', { select: 'id,score,total,created_at', course_id: 'eq.' + c.id, user_id: 'eq.' + S.uid, order: 'created_at.desc', limit: '1' }))[0] || null;
      } catch (err) { failWith(err, out); return false; }
      if (!row || typeof row.score !== 'number' || typeof row.total !== 'number') { ui.msg(out, 'err', P.MSG.other); return false; }

      const rec = { id: row.id, course_id: c.id, score: row.score, total: row.total, created_at: row.created_at };
      S.attempts.unshift(rec);
      hist.attempts.unshift(rec);
      paintHist();

      let key = null;
      try { key = await P.rest.select('quiz_questions', { select: 'id,correct_index,explanation', course_id: 'eq.' + c.id, published: 'eq.true' }); } catch (err) {
        if (isSession(err)) { wipe(); P.goLogin('expired'); return false; }
        key = null;
      }

      const pc = P.pct(row.score, row.total);
      const bar = h('div', { class: 'bar', role: 'img', 'aria-label': 'نسبة الإجابات الصحيحة ' + pc + '%' }, h('span'));
      const retryBtn = h('button', { type: 'button', class: 'btn s', on: { click: retry } }, 'إعادة المحاولة');
      const box = h('section', { class: 'pf-result', tabindex: '-1', 'aria-labelledby': 'res-h' },
        h('div', { class: 'big', text: row.score + ' / ' + row.total }),
        h('b', { id: 'res-h', text: 'نتيجتك: ' + pc + '%' }),
        bar,
        h('p', { text: 'حُفظت هذه المحاولة في سجلّك.' }),
        retryBtn);
      clear(resultSlot);
      resultSlot.appendChild(box);
      if (key) resultSlot.appendChild(reviewList(qs, answers, key));
      else resultSlot.appendChild(h('p', { class: 'pf-msg info', text: 'تعذّر عرض تفاصيل التصحيح الآن، لكن نتيجتك محفوظة.' }));
      form.hidden = true;
      resultSlot.hidden = false;
      window.requestAnimationFrame(function () { bar.firstChild.style.width = pc + '%'; });
      box.focus();
      return false;
    }));

    return h('div', null, form, resultSlot, histSlot);
  }

  /* ---------- الدروس: وحدات ودروس مع متابعة الإتمام والاستئناف (الترحيل 016) ----------
     الفيديو والملفات هي نفسها عناصر الدورة (videoItem/fileItem). التقدم يُحفظ عبر lms_save_progress فقط (إتمام الدرس لا يُلغى).
     فتح الدرس يسجّله «آخر درس» فيُستأنف منه عند العودة. */
  function lessonsPanel(c, data) {
    const L = data.lms;
    const byId = {};
    data.items.forEach(function (i) { byId[i.id] = i; });
    const prog = {};
    L.progress.forEach(function (p) { prog[p.lesson_id] = p; });
    const ordered = [];
    L.modules.forEach(function (m) { L.lessons.filter(function (l) { return l.module_id === m.id; }).forEach(function (l) { ordered.push(l); }); });
    const root = h('div');
    const total = ordered.length;
    const doneCount = function () { return ordered.filter(function (l) { return prog[l.id] && prog[l.id].completed; }).length; };
    const fmtMin = function (s) { return s ? Math.max(1, Math.round(s / 60)) + ' د' : ''; };
    const saveRpc = function (lesson, completed) {
      const args = { p_lesson_id: lesson.id, p_position: 0 };
      if (completed) args.p_completed = true;
      return P.rest.rpc('lms_save_progress', args).then(function (r) {
        const old = prog[lesson.id];
        prog[lesson.id] = { lesson_id: lesson.id, completed: !!(r && r.completed) || !!(old && old.completed), updated_at: new Date().toISOString() };
        return prog[lesson.id];
      });
    };
    const lastViewed = function () {
      const rows = Object.keys(prog).map(function (k) { return prog[k]; }).filter(function (p) { return ordered.some(function (l) { return l.id === p.lesson_id; }); });
      rows.sort(function (a, b) { return String(b.updated_at || '').localeCompare(String(a.updated_at || '')); });
      return rows.length ? ordered.filter(function (l) { return l.id === rows[0].lesson_id; })[0] : null;
    };

    function showList() {
      clear(root);
      const pc = total ? Math.round((doneCount() / total) * 100) : 0;
      const bar = h('div', { class: 'bar', role: 'img', 'aria-label': 'تقدمك في الدروس ' + pc + '%' }, h('span'));
      bar.firstChild.style.width = pc + '%';
      const resume = lastViewed();
      const next = resume ? (doneCount() === total ? ordered[0] : resume) : ordered[0];
      root.appendChild(h('div', { class: 'pf-lprog' },
        h('p', { class: 'pf-qmeta', role: 'status', text: 'أكملت ' + doneCount() + ' من ' + total + ' درسًا (' + pc + '%).' }), bar,
        next ? h('button', { type: 'button', class: 'btn p', on: { click: function () { showLesson(next); } } }, resume && doneCount() < total ? 'تابع: ' + next.title_ar : 'ابدأ الدورة') : null));
      L.modules.forEach(function (m) {
        const ls = L.lessons.filter(function (l) { return l.module_id === m.id; });
        if (!ls.length) return;
        root.appendChild(h('section', { class: 'pf-lmod', 'aria-label': m.title_ar },
          h('h3', { text: m.title_ar }),
          m.description_ar ? h('p', { class: 'pf-note', dir: 'auto', text: m.description_ar }) : null,
          h('ul', { class: 'pf-list' }, ls.map(function (l) {
            const done = prog[l.id] && prog[l.id].completed;
            return h('li', { class: 'pf-item' },
              h('span', { class: 'pf-ico' }, icon(done ? 'check' : 'video')),
              h('div', { class: 'pf-ibody' }, h('h3', { dir: 'auto', text: l.title_ar }), h('small', { text: [done ? 'مكتمل' : '', fmtMin(l.duration_seconds)].filter(Boolean).join(' · ') })),
              h('button', { type: 'button', class: done ? 'btn s' : 'btn p', on: { click: function () { showLesson(l); } } }, done ? 'مراجعة' : 'افتح'));
          }))));
      });
    }

    function showLesson(l) {
      clear(root);
      saveRpc(l, false).catch(function (err) { if (isSession(err)) { wipe(); P.goLogin('expired'); } });
      const idx = ordered.indexOf(l);
      const out = h('div', { class: 'pf-msg', hidden: true });
      const back = h('button', { type: 'button', class: 'btn s', on: { click: showList } }, icon('back'), 'كل الدروس');
      const vid = l.video_item_id ? byId[l.video_item_id] : null;
      const files = L.files.filter(function (f) { return f.lesson_id === l.id; }).sort(function (a, b) { return a.sort - b.sort; })
        .map(function (f) { return byId[f.item_id]; }).filter(Boolean);
      const mod = L.modules.filter(function (m) { return m.id === l.module_id; })[0];
      const isDone = function () { return prog[l.id] && prog[l.id].completed; };
      const doneBtn = h('button', { type: 'button', class: 'btn p' }, icon('check'), 'أكملت هذا الدرس');
      const paintDone = function () { doneBtn.disabled = !!isDone(); doneBtn.lastChild.textContent = isDone() ? 'الدرس مكتمل' : 'أكملت هذا الدرس'; };
      paintDone();
      doneBtn.addEventListener('click', ui.guard(doneBtn, out, async function () {
        ui.clearMsg(out);
        try { await saveRpc(l, true); } catch (err) { failWith(err, out); return false; }
        paintDone();
        if (idx + 1 < total) ui.msg(out, 'ok', 'تم تسجيل إكمال الدرس. انتقل إلى الدرس التالي.');
        else ui.msg(out, 'ok', 'أحسنت! أنهيت دروس هذه الدورة.');
        return false;
      }));
      const nextBtn = idx + 1 < total ? h('button', { type: 'button', class: 'btn s', on: { click: function () { showLesson(ordered[idx + 1]); window.scrollTo(0, 0); } } }, 'الدرس التالي') : null;
      const prevBtn = idx > 0 ? h('button', { type: 'button', class: 'btn s', on: { click: function () { showLesson(ordered[idx - 1]); window.scrollTo(0, 0); } } }, 'الدرس السابق') : null;
      root.appendChild(h('div', { class: 'pf-fade' },
        h('div', { class: 'pf-crumb' }, back),
        h('div', { class: 'eyebrow', text: (mod ? mod.title_ar + ' · ' : '') + 'الدرس ' + (idx + 1) + ' من ' + total }),
        h('h3', { dir: 'auto', text: l.title_ar, tabindex: '-1' }),
        vid ? h('ul', { class: 'pf-list' }, videoItem(vid)) : null,
        l.description_ar ? h('p', { class: 'pf-note', dir: 'auto', text: l.description_ar }) : null,
        files.length ? h('section', { 'aria-label': 'ملفات الدرس' }, h('h3', { text: 'ملفات الدرس' }), h('ul', { class: 'pf-list' }, files.map(fileItem))) : null,
        h('div', { class: 'pf-qact' }, doneBtn, prevBtn, nextBtn), out));
    }

    showList();
    return root;
  }

  function validQuestion(q) {
    return q && typeof q.id === 'string' && typeof q.question === 'string' && Array.isArray(q.options) && q.options.length >= 2 &&
      q.options.every(function (o) { return typeof o === 'string'; });
  }
  async function loadCourse(id) {
    const r = await Promise.all([
      P.rest.select('course_items', { select: 'id,kind,title,url,storage_path,sort', course_id: 'eq.' + id, published: 'eq.true', order: 'sort.asc,created_at.asc' }),
      P.rest.select('quiz_questions', { select: 'id,question,options,sort', course_id: 'eq.' + id, published: 'eq.true', order: 'sort.asc,created_at.asc' }),
      P.rest.select('quiz_attempts', { select: 'id,score,total,created_at', course_id: 'eq.' + id, user_id: 'eq.' + S.uid, order: 'created_at.desc', limit: '20' })
    ]);
    /* الدروس اختيارية: إن لم يُطبَّق الترحيل 016 بعد أو فشل الجلب تبقى الدورة بتبويباتها القديمة */
    let lms = { modules: [], lessons: [], files: [], progress: [] };
    try {
      const m = await Promise.all([
        P.rest.select('lms_modules', { select: 'id,title_ar,description_ar,sort', course_id: 'eq.' + id, order: 'sort.asc,created_at.asc', limit: '500' }),
        P.rest.select('lms_lessons', { select: 'id,module_id,title_ar,description_ar,video_item_id,duration_seconds,sort', course_id: 'eq.' + id, order: 'sort.asc,created_at.asc', limit: '2000' }),
        P.rest.select('lms_progress', { select: 'lesson_id,completed,updated_at', course_id: 'eq.' + id, user_id: 'eq.' + S.uid, limit: '2000' })
      ]);
      lms = { modules: m[0], lessons: m[1], files: [], progress: m[2] };
      if (lms.lessons.length) lms.files = await P.rest.select('lms_lesson_files', { select: 'lesson_id,item_id,sort', lesson_id: 'in.(' + lms.lessons.map(function (x) { return x.id; }).join(',') + ')', limit: '5000' });
    } catch (err) {
      if (isSession(err)) throw err;
      lms = { modules: [], lessons: [], files: [], progress: [] };
    }
    return { items: r[0], questions: r[1].filter(validQuestion), attempts: r[2], lms: lms };
  }

  function tabButton(name, label, count, ic) {
    return h('button', { type: 'button', role: 'tab', id: 'ctab-' + name, 'data-tab': name, 'aria-controls': 'cpanel-' + name, 'aria-selected': 'false', tabindex: '-1' },
      icon(ic), label, h('span', { class: 'pf-count', text: '(' + count + ')' }));
  }
  function plainTab(name, label, ic) {
    return h('button', { type: 'button', role: 'tab', id: 'ctab-' + name, 'data-tab': name, 'aria-controls': 'cpanel-' + name, 'aria-selected': 'false', tabindex: '-1' }, icon(ic), label);
  }
  function tabPanel(name, content) {
    return h('div', { role: 'tabpanel', id: 'cpanel-' + name, 'aria-labelledby': 'ctab-' + name, hidden: true }, content);
  }
  function renderCourseBody(body, c, data, tab) {
    const files = data.items.filter(function (i) { return i.kind === 'file'; });
    const videos = data.items.filter(function (i) { return i.kind === 'video'; });
    const hasLessons = data.lms.lessons.length > 0;
    const tabsEl = h('div', { class: 'pf-tabs', role: 'tablist', 'aria-label': 'أقسام الدورة' },
      hasLessons ? tabButton('lessons', 'الدروس', data.lms.lessons.length, 'book') : null,
      tabButton('files', 'ملفات الدورة', files.length, 'file'),
      tabButton('videos', 'الفيديوهات التعليمية', videos.length, 'video'),
      tabButton('quiz', 'الأسئلة المحاكية', data.questions.length, 'quiz'),
      window.LmsAct ? plainTab('assignments', 'الواجبات', 'file') : null,
      window.LmsAct ? plainTab('discussions', 'المناقشات', 'user') : null);
    body.appendChild(tabsEl);
    const holders = { assignments: h('div'), discussions: h('div') };
    const mountedAct = {};
    if (hasLessons) body.appendChild(tabPanel('lessons', lessonsPanel(c, data)));
    body.appendChild(tabPanel('files', files.length
      ? h('ul', { class: 'pf-list' }, files.map(fileItem))
      : emptyBox('لا توجد ملفات منشورة بعد', 'سيضيف المدرب ملفات هذه الدورة قريبًا.')));
    body.appendChild(tabPanel('videos', videos.length
      ? h('ul', { class: 'pf-list' }, videos.map(videoItem))
      : emptyBox('لا توجد فيديوهات منشورة بعد', 'سيضيف المدرب الفيديوهات التعليمية لهذه الدورة قريبًا.')));
    body.appendChild(tabPanel('quiz', quizPanel(c, data)));
    if (window.LmsAct) { body.appendChild(tabPanel('assignments', holders.assignments)); body.appendChild(tabPanel('discussions', holders.discussions)); }
    const ctl = ui.tabs(tabsEl, {
      onSelect: function (name) {
        try { window.history.replaceState(null, '', '#course=' + c.id + '&tab=' + name); } catch (e) { /* تجاهل */ }
        if (window.LmsAct && (name === 'assignments' || name === 'discussions') && !mountedAct[name]) {
          mountedAct[name] = true;
          holders[name].appendChild(name === 'assignments' ? window.LmsAct.assignments(c.id, S.uid) : window.LmsAct.discussions(c.id));
        }
      }
    });
    ctl.select(tab && (tab !== 'lessons' || hasLessons) ? tab : (hasLessons ? 'lessons' : 'files'), false);
  }

  async function showCourse(id, tab) {
    const token = ++S.nav;
    S.view = 'course';
    $('dash-jump').hidden = true;
    clear(view);
    const back = h('a', { class: 'btn s', href: '#sec-mine' }, icon('back'), 'العودة إلى لوحتي');
    const c = courseById(id);
    if (!c) {
      document.title = TITLE;
      view.appendChild(h('div', { class: 'pf-fade' }, h('div', { class: 'pf-crumb' }, back), emptyBox('الدورة غير موجودة', 'لم نجد هذه الدورة. ارجع إلى لوحتك واختر دورة من القائمة.')));
      return;
    }
    document.title = c.title_ar + ' | م. أحمد الديب';
    const heading = h('h2', { tabindex: '-1', text: c.title_ar });
    const wrap = h('div', { class: 'pf-fade' },
      h('div', { class: 'pf-crumb' }, back),
      h('div', { class: 'pf-chead' }, h('div', { class: 'eyebrow', text: 'دورتي' }), heading, h('div', { class: 'pf-en', text: c.title_en })));
    view.appendChild(wrap);
    window.scrollTo(0, 0);
    try { heading.focus({ preventScroll: true }); } catch (e) { /* تجاهل */ }

    if (!canOpen(id)) { wrap.appendChild(lockedBox(c)); return; }
    const body = h('div', { class: 'pf-cbody' }, loadingBlock('جارٍ تحميل محتوى الدورة…'));
    wrap.appendChild(body);
    let data;
    try { data = await loadCourse(id); } catch (err) {
      if (token !== S.nav) return;
      if (isSession(err)) { wipe(); P.goLogin('expired'); return; }
      clear(body);
      body.appendChild(failBlock(errText(err), function () { showCourse(id, tab); }));
      return;
    }
    if (token !== S.nav) return;
    clear(body);
    renderCourseBody(body, c, data, tab);
  }

  /* ---------- المسارات ---------- */
  function route() {
    if (!S.profile) return;
    const ex = /^#(exam|attempt|result)=([0-9a-f-]{36})$/i.exec(window.location.hash);
    const sebRoute = window.location.hash === '#seb-info';
    if (S.view === 'exam' && !ex && !sebRoute && window.Exams) window.Exams.leave();
    if (sebRoute && window.Exams) {
      S.nav++;
      S.view = 'exam';
      $('dash-jump').hidden = true;
      window.scrollTo(0, 0);
      window.Exams.show('seb', null);
      return;
    }
    if (ex && window.Exams) {
      S.nav++;
      S.view = 'exam';
      $('dash-jump').hidden = true;
      window.scrollTo(0, 0);
      window.Exams.show(ex[1].toLowerCase(), ex[2]);
      return;
    }
    const m = /^#course=([a-z0-9-]{1,40})(?:&tab=(lessons|files|videos|quiz|assignments|discussions))?$/.exec(window.location.hash);
    if (m) showCourse(m[1], m[2] || '');
    else if (S.view !== 'home') {
      showHome();
      let target = null;
      try { target = window.location.hash.length > 1 ? $(decodeURIComponent(window.location.hash.slice(1))) : null; } catch (e) { target = null; }
      if (target) target.scrollIntoView();
      else window.scrollTo(0, 0);
    }
  }

  /* ---------- الإقلاع والخروج ---------- */
  function renderFail(text, retry) {
    S.view = '';
    clear(view);
    view.appendChild(failBlock(text, retry ? boot : null));
  }
  function handleFatal(err) {
    if (isSession(err)) { wipe(); P.goLogin('expired'); return; }
    renderFail(errText(err), true);
  }
  async function boot() {
    if (!P.config.ok) { renderFail(P.MSG.config, false); return; }
    const s = P.session.get();
    if (!s) { P.goLogin(''); return; }
    S.uid = s.user.id;
    S.email = s.user.email;
    clear(view);
    view.appendChild(loadingBlock('جارٍ تحميل لوحتك…'));
    try { await loadAll(); } catch (err) { handleFatal(err); return; }
    /* المدير يُوجَّه إلى لوحته مرة واحدة في الجلسة بعد الدخول (ويبقى رابط «لوحة المدرب» لمن أراد لوحة المتدرب) */
    try {
      if (S.profile.role === 'admin' && !window.location.hash && !window.sessionStorage.getItem('plat_landed')) {
        window.sessionStorage.setItem('plat_landed', '1');
        window.location.replace('/admin/');
        return;
      }
    } catch (e) { /* التخزين محجوب: تبقى لوحة المتدرب */ }
    renderHeader();
    if (window.Exams) window.Exams.setCourseTitles(function (id) { const c = courseById(id); return c ? c.title_ar : id; });
    touchSeen();
    route();
    if (!S.view) showHome();
  }

  $('dash-logout').addEventListener('click', async function () {
    const btn = $('dash-logout');
    if (btn.disabled) return;
    ui.setBusy(btn, true);
    wipe();
    view.appendChild(loadingBlock('جارٍ تسجيل الخروج…'));
    await P.auth.signOut();
    P.goLogin('out');
  });

  window.addEventListener('hashchange', route);
  window.addEventListener('storage', function (e) { /* خروج في تبويب آخر */
    if ((e.key === P.session.key || e.key === null) && !P.session.has()) { wipe(); P.goLogin('out'); }
  });
  window.addEventListener('pageshow', function (e) { /* عودة من الذاكرة السريعة بعد خروج: لا تبقى لوحة مقروءة */
    if (e.persisted && !P.session.has()) { wipe(); P.goLogin('out'); }
  });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && S.profile && !P.session.has()) { wipe(); P.goLogin('out'); }
  });

  boot();
})();
