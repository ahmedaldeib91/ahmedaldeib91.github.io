/* =====================================================================
   account.js — صفحة /account/: تسجيل جديد، دخول، نسيت كلمة المرور، وإعادة التعيين من رابط البريد
   ملف عادي (ES2017) يُحمَّل بـ defer بعد platform-api.js، ولا يحتاج شيئًا غيره. كل نص قادم من الخادم أو من المستخدم
   يُعرض بـ textContent فقط؛ ورسائل الأخطاء كلها عربية جاهزة من platform-api.js.

   السلوك
   - ثلاثة تبويبات ARIA (تسجيل جديد / تسجيل الدخول / نسيت كلمة المرور) تعمل بالأسهم وHome وEnd. الافتراضي هو الدخول،
     والروابط #register و#login و#forgot تفتح التبويب المطلوب.
   - التسجيل: تحقق من الحقول في المتصفح، حقل مصيدة (honeypot) تُتجاهل معه الإرسالية بصمت، ثم POST /auth/v1/signup
     بالبيانات {full_name, phone, country}. تظهر دائمًا الرسالة المحايدة نفسها «تحقّق من بريدك لتأكيد الحساب» (حتى لو كان
     البريد مسجّلًا، فلا نكشف وجوده)، ولا تُحفظ أي جلسة قبل تأكيد البريد.
   - الدخول: POST /auth/v1/token?grant_type=password ثم الانتقال إلى /dashboard/.
   - نسيت كلمة المرور: POST /auth/v1/recover، والرد محايد دائمًا. ورابط البريد (#access_token=…&type=recovery) يفتح نموذج
     «كلمة مرور جديدة» → PUT /auth/v1/user. ورابط التأكيد (#access_token=…&type=signup) يتحقق من التوكن ويحفظ الجلسة
     ثم يفتح /dashboard/. يُمسح الجزء بعد # من الرابط فور قراءته كي لا تبقى التوكنات في العنوان ولا في السجل.
   - من لديه جلسة محفوظة يُحوَّل مباشرة إلى /dashboard/ (وكذلك عند عودة الصفحة من الذاكرة السريعة bfcache، حيث تُفرَّغ
     الحقول وتُفكّ الأزرار المعلّقة).
   - زر الإرسال يُعطَّل أثناء الطلب ولا يقبل إرسالًا مزدوجًا.
   ===================================================================== */
(function () {
  'use strict';

  const P = window.Platform;
   const BASE = document.documentElement.getAttribute('data-base-path') || '';
  const $ = function (id) { return document.getElementById(id); };
  const notice = $('acc-notice');

  if (!P) { /* platform-api.js لم يُحمَّل */
    if (notice) { notice.className = 'pf-msg err'; notice.textContent = 'تعذّر تحميل المنصة. حدّث الصفحة ثم أعد المحاولة.'; notice.hidden = false; }
    return;
  }
  const ui = P.ui;
  const delay = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  const errText = function (err) { return err instanceof P.ApiError ? err.message : P.MSG.other; };
  const note = function (kind, text) { ui.msg(notice, kind, text); };

  const tablist = $('acc-tabs');
  const TAB_NAMES = ['register', 'login', 'forgot'];
  const special = { reset: $('panel-reset'), done: $('panel-done') };
  let recovery = null; /* توكنات رابط الاستعادة: في الذاكرة فقط حتى يُحفظ الطلب */

  const tabCtl = ui.tabs(tablist, { onSelect: function () { ui.clearMsg(notice); } });

  /* ---------- عرض اللوحات ---------- */
  function showSpecial(name) {
    tablist.hidden = true;
    TAB_NAMES.forEach(function (t) { $('panel-' + t).hidden = true; });
    Object.keys(special).forEach(function (k) { special[k].hidden = k !== name; });
    const head = $(name === 'reset' ? 'reset-h' : 'done-h');
    if (head) head.focus();
  }
  function showTabs(name, focusField) {
    Object.keys(special).forEach(function (k) { special[k].hidden = true; });
    tablist.hidden = false;
    tabCtl.select(name || 'login', false);
    if (focusField) {
      const f = $('panel-' + (name || 'login')).querySelector('input:not([tabindex="-1"]),select');
      if (f) f.focus();
    }
  }

  /* ---------- تسجيل جديد ---------- */
  const onRegister = ui.guard($('reg-submit'), $('reg-msg'), async function () {
    const out = $('reg-msg');
    ui.clearMsg(out);
    if ($('reg-site').value.trim() !== '') { /* حقل المصيدة: روبوت. نُظهر النجاح دون أي طلب */
      await delay(700);
      showSpecial('done');
      return false;
    }
    const bag = {};
    const name = ui.check($('reg-name'), P.v.name($('reg-name').value), bag);
    const email = ui.check($('reg-email'), P.v.email($('reg-email').value), bag);
    const pass = ui.check($('reg-pass'), P.v.password($('reg-pass').value), bag);
    const phone = ui.check($('reg-phone'), P.v.phone($('reg-phone').value), bag);
    const country = ui.check($('reg-country'), P.v.country($('reg-country').value), bag);
    const agreed = $('reg-consent').checked;
    ui.fieldError($('reg-consent'), agreed ? '' : 'يجب الموافقة على سياسة الخصوصية وشروط الاستخدام للمتابعة.');
    if (!agreed && !bag.first) bag.first = $('reg-consent');
    if (bag.first) { bag.first.focus(); return false; }
    try {
      await P.auth.signUp(email, pass, { full_name: name, phone: phone, country: country });
    } catch (err) {
      /* البريد المسجّل مسبقًا يأخذ الرسالة المحايدة نفسها فلا نكشف وجوده */
      if (!(err instanceof P.ApiError && (err.code === 'user_already_exists' || err.code === 'email_exists'))) {
        ui.msg(out, 'err', errText(err));
        return false;
      }
    }
    $('f-register').reset();
    $('reg-pass').dispatchEvent(new Event('input'));
    showSpecial('done');
    return false;
  });

  /* ---------- تسجيل الدخول ---------- */
  const onLogin = ui.guard($('log-submit'), $('log-msg'), async function () {
    const out = $('log-msg');
    ui.clearMsg(out);
    ui.clearMsg(notice);
    const bag = {};
    const email = ui.check($('log-email'), P.v.email($('log-email').value), bag);
    const pass = $('log-pass').value;
    ui.check($('log-pass'), pass ? { value: pass } : { error: 'اكتب كلمة المرور.' }, bag);
    if (bag.first) { bag.first.focus(); return false; }
    try {
      await P.auth.signIn(email, pass);
    } catch (err) {
      ui.msg(out, 'err', errText(err));
      return false;
    }
    window.location.assign('/dashboard/');
    return true; /* يبقى الزر معطّلًا حتى تنتقل الصفحة */
  });

  /* ---------- نسيت كلمة المرور ---------- */
  const onForgot = ui.guard($('for-submit'), $('for-msg'), async function () {
    const out = $('for-msg');
    ui.clearMsg(out);
    const bag = {};
    const email = ui.check($('for-email'), P.v.email($('for-email').value), bag);
    if (bag.first) { bag.first.focus(); return false; }
    try {
      await P.auth.recover(email);
    } catch (err) {
      /* الأعطال العامة تُعرض؛ وغيرها يأخذ الرد المحايد نفسه فلا نكشف إن كان البريد مسجّلًا */
      if (err instanceof P.ApiError && ['rate', 'network', 'server', 'config'].indexOf(err.kind) !== -1) {
        ui.msg(out, 'err', err.message);
        return false;
      }
    }
    ui.msg(out, 'ok', 'إن كان هذا البريد مسجّلًا لدينا فسيصلك رابط لاستعادة كلمة المرور خلال دقائق. تحقّق من مجلد الرسائل غير المرغوبة أيضًا.');
    return false;
  });

  /* ---------- كلمة مرور جديدة (من رابط الاستعادة) ---------- */
  const onReset = ui.guard($('res-submit'), $('res-msg'), async function () {
    const out = $('res-msg');
    ui.clearMsg(out);
    if (!recovery) { showTabs('forgot'); note('err', 'انتهت صلاحية الرابط. اطلب رابطًا جديدًا.'); return false; }
    const bag = {};
    const pass = ui.check($('res-pass'), P.v.password($('res-pass').value), bag);
    const same = $('res-pass2').value === $('res-pass').value;
    ui.fieldError($('res-pass2'), same ? '' : 'كلمتا المرور غير متطابقتين.');
    if (!same && !bag.first) bag.first = $('res-pass2');
    if (bag.first) { bag.first.focus(); return false; }
    try {
      await P.auth.updatePassword(pass, recovery.access_token);
    } catch (err) {
      ui.msg(out, 'err', errText(err));
      return false;
    }
    const tokens = recovery;
    recovery = null;
    $('f-reset').reset();
    try {
      await P.auth.adopt(tokens);
      window.location.assign('/dashboard/');
      return true;
    } catch (err) {
      showTabs('login', true);
      note('ok', 'تم تغيير كلمة المرور. سجّل الدخول بها الآن.');
      return false;
    }
  });

  $('f-register').addEventListener('submit', onRegister);
  $('f-login').addEventListener('submit', onLogin);
  $('f-forgot').addEventListener('submit', onForgot);
  $('f-reset').addEventListener('submit', onReset);

  /* ---------- العودة من رابط البريد (#access_token=… أو #error=…) ---------- */
  async function handleCallback(cb) {
    try { window.history.replaceState(null, '', window.location.pathname + window.location.search); } catch (e) { /* تجاهل */ }
    showTabs('login');
    if (cb.error || cb.error_code || !cb.access_token) {
      note('err', cb.error_code === 'otp_expired'
        ? 'رابط التأكيد أو الاستعادة منتهي الصلاحية أو سبق استعماله. اطلب رابطًا جديدًا.'
        : 'تعذّر إكمال العملية عبر الرابط. اطلب رابطًا جديدًا ثم أعد المحاولة.');
      return;
    }
    note('info', 'جارٍ التحقق من الرابط…');
    try {
      if (cb.type === 'recovery') {
        const user = await P.auth.getUser(cb.access_token);
        recovery = cb;
        $('reset-who').textContent = user.email;
        ui.clearMsg(notice);
        showSpecial('reset');
      } else {
        if (!cb.refresh_token) throw new P.ApiError('auth', P.MSG.other, 0, 'no_refresh');
        await P.auth.adopt(cb);
        window.location.replace('/dashboard/');
      }
    } catch (err) {
      showTabs('login');
      note('err', err instanceof P.ApiError && err.kind === 'storage'
        ? err.message
        : 'رابط التأكيد أو الاستعادة غير صالح أو انتهت صلاحيته. اطلب رابطًا جديدًا من تبويب «نسيت كلمة المرور».');
    }
  }

  /* ---------- التهيئة ---------- */
  function fillCountries() {
    const sel = $('reg-country');
    sel.appendChild(ui.h('option', { value: '', text: 'اختر دولتك' }));
    P.COUNTRIES.forEach(function (c) { sel.appendChild(ui.h('option', { value: c, text: c })); });
  }
  function wire() {
    ui.bindStrength($('reg-pass'), $('reg-meter'), $('reg-meter-label'));
    ui.bindStrength($('res-pass'), $('res-meter'), $('res-meter-label'));
    ui.bindReveal($('reg-reveal'), $('reg-pass'));
    ui.bindReveal($('log-reveal'), $('log-pass'));
    ui.bindReveal($('res-reveal'), $('res-pass'));
    Array.prototype.forEach.call(document.querySelectorAll('.pf-in,#reg-consent'), function (inp) {
      inp.addEventListener(inp.type === 'checkbox' ? 'change' : 'input', function () { if (inp.getAttribute('aria-invalid')) ui.fieldError(inp, ''); });
    });
    document.querySelector('.pf-card').addEventListener('click', function (e) {
      const b = e.target.closest ? e.target.closest('[data-goto]') : null;
      if (b) showTabs(b.getAttribute('data-goto'), true);
    });
  }
  function resetAll() { /* عودة الصفحة من الذاكرة السريعة: لا نترك كلمات مرور ولا أزرارًا معلّقة */
    ['f-register', 'f-login', 'f-forgot', 'f-reset'].forEach(function (id) { $(id).reset(); });
    [onRegister, onLogin, onForgot, onReset].forEach(function (g) { g.reset(); });
    $('reg-pass').dispatchEvent(new Event('input'));
    $('res-pass').dispatchEvent(new Event('input'));
  }

  function init() {
    if (!P.config.ok) {
      note('err', P.MSG.config);
      document.querySelector('.pf-card').hidden = true;
      return;
    }
    fillCountries();
    wire();

    const cb = P.auth.parseHash(window.location.hash);
    if (cb) { handleCallback(cb); return; }

    const reason = new URLSearchParams(window.location.search).get('reason');
    const want = window.location.hash.replace('#', '');
    if (reason !== 'expired' && reason !== 'out' && P.session.has()) {
      window.location.replace('/dashboard/');
      return;
    }
    if (TAB_NAMES.indexOf(want) !== -1) tabCtl.select(want, false);
    if (reason === 'expired' || reason === 'out') {
      P.session.clear(); /* يمنع حلقة الدخول ← اللوحة ← الدخول إن بقيت جلسة تالفة */
      note(reason === 'out' ? 'ok' : 'info', reason === 'out' ? 'تم تسجيل الخروج بنجاح.' : 'انتهت جلسة الدخول. سجّل الدخول من جديد.');
      try { window.history.replaceState(null, '', '/account/' + window.location.hash); } catch (e) { /* تجاهل */ }
    }
  }

  window.addEventListener('pageshow', function (e) {
    if (!e.persisted) return;
    if (P.session.has()) window.location.replace('/dashboard/');
    else resetAll();
  });
  /* رابط بريد يُفتح في هذا التبويب نفسه دون إعادة تحميل (تغيّر الجزء بعد # فقط) */
  window.addEventListener('hashchange', function () {
    const cb = P.config.ok ? P.auth.parseHash(window.location.hash) : null;
    if (cb) handleCallback(cb);
  });

  init();
})();
