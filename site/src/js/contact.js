/* =====================================================================
   contact.js — صفحة /contact/: نموذج «أرسل لنا رسالة» للزوّار (بلا تسجيل دخول)
   ملف عادي (ES2017) يُحمَّل بـ defer بعد platform-api.js في هذه الصفحة وحدها، بلا مكتبات.

   1) الإرسال: Platform.mail.send({action:'contact', name, email, subject, message, website:''}) إلى وظيفة send-mail
      (POST /functions/v1/send-mail بالمفتاح العام وحده، بلا Authorization ولا جلسة). لا يُرمى خطأ: النتيجة كائن {ok, error, mailed}.
      الرسالة تُحفظ في قاعدة البيانات (وتظهر في لوحة المدرب) حتى لو تعذّر البريد، فيُعدّ ذلك نجاحًا عند الزائر.
   2) التحقق في المتصفح يطابق قواعد الخادم: التنظيف نفسه (NFC، حذف رموز الاتجاه والتحكم، قصّ الأطراف)، والبريد بالصيغة نفسها
      (٦–٢٥٤ حرفًا)، والاسم حتى ١٠٠ والموضوع حتى ١٥٠ والوصف من ١٠ إلى ٢٠٠٠. والخادم يعيد التحقق، فما يرفضه يظهر تحت الحقل المعني.
   3) حقل المصيدة website: إن ملأه روبوت تُعرض رسالة نجاح بلا أي طلب (كصفحة التسجيل). وفي الطلب الحقيقي يُرسَل فارغًا دائمًا.
   4) الإتاحة: منطقة حالة حيّة (aria-live) دائمة الوجود، والتركيز إلى أول حقل خاطئ وإلى رسالة النجاح بعد الإرسال.
      الزر يُعطَّل أثناء الطلب (ui.guard) فلا إرسال مزدوج. كل نص يدخل DOM بـ textContent أو Platform.ui.h، ولا innerHTML أبدًا.
   5) عند الفشل (شبكة، حدّ الإرسال، خطأ خادم) تظهر رسالة عربية ودودة مع رابط واتساب بديلًا، فلا يعلق الزائر.
   ===================================================================== */
(function () {
  'use strict';

  const win = window;
  const doc = document;
  const P = win.Platform;
  const $ = function (id) { return doc.getElementById(id); };

  const form = $('ct-form');
  const status = $('ct-status');
  const btn = $('ct-submit');
  if (!form || !status || !btn) return;

  const FIELDS = ['ct-name', 'ct-email', 'ct-subject', 'ct-message'];
  const MAX_MESSAGE = 2000;
  const TXT = {
    ok: 'تم إرسال رسالتك إلى المدرب. سيرد عليك على بريدك الإلكتروني في أقرب وقت.',
    saved: 'تم استلام رسالتك وحفظها. سيطّلع عليها المدرب ويرد عليك على بريدك الإلكتروني في أقرب وقت.',
    noPlatform: 'تعذّر تحميل الصفحة بالكامل. حدّث الصفحة ثم أعد المحاولة، أو تواصل معنا عبر واتساب.',
    msgShort: 'اكتب وصفًا لاستفسارك (١٠ أحرف على الأقل).',
    msgLong: 'الوصف طويل جدًا (الحد الأقصى ٢٠٠٠ حرف).'
  };

  /* ---------- الحالة (aria-live) ---------- */
  const waUrl = function () { return P && P.config && P.config.whatsapp ? P.safeUrl(P.config.whatsapp) : null; };
  /* kind: ok | err | info ؛ withWa يضيف رابط واتساب في سطر مستقل تحت النص (بديل عند الفشل) */
  function say(kind, text, withWa) {
    status.className = 'pf-msg ' + kind;
    status.textContent = text;
    const u = withWa ? waUrl() : null;
    if (u) status.appendChild(P.ui.h('span', { class: 'ct-wa' }, P.ui.h('a', { href: u, target: '_blank', rel: 'noopener noreferrer' }, 'أو تواصل معنا مباشرة عبر واتساب')));
    status.hidden = false;
  }
  function clearStatus() {
    status.hidden = true;
    status.textContent = '';
    status.className = 'pf-msg';
  }

  if (!P) { say('err', TXT.noPlatform); btn.disabled = true; return; } /* platform-api.js لم يُحمَّل */
  if (!P.config.ok) { say('err', P.MSG.config, true); btn.disabled = true; return; }

  /* ---------- التحقق (مطابق لدالة cleanText وقواعد handleContact في وظيفة send-mail) ---------- */
  const BIDI = /[‪-‮⁦-⁩‎‏؜]/g;
  const EMAIL_RE = /^[^\s@<>()[\]\\,;:"']+@[^\s@<>()[\]\\,;:"']+\.[^\s@<>()[\]\\,;:"']{2,}$/;
  function clean(v, multiline) {
    let s = String(v == null ? '' : v).normalize('NFC').replace(/\r\n?/g, '\n').replace(BIDI, '');
    s = multiline ? s.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '') : s.replace(/[\u0000-\u001F\u007F]/g, ' ');
    return s.trim();
  }
  const T = function (code) { return P.mail.text({ error: code }); };
  const rules = {
    name: function (raw) { const s = clean(raw); return s.length > 100 ? { error: T('invalid_name') } : { value: s }; },
    email: function (raw) {
      const s = clean(raw).toLowerCase();
      return s.length >= 6 && s.length <= 254 && EMAIL_RE.test(s) ? { value: s } : { error: T('invalid_email') };
    },
    subject: function (raw) { const s = clean(raw); return s.length > 150 ? { error: T('invalid_subject') } : { value: s }; },
    message: function (raw) {
      const s = clean(raw, true);
      if (s.length < 10) return { error: TXT.msgShort };
      if (s.length > MAX_MESSAGE) return { error: TXT.msgLong };
      return { value: s };
    }
  };
  /* رمز خطأ الخادم ← الحقل الذي يُعرض تحته الخطأ */
  const FIELD_OF = { invalid_name: 'ct-name', invalid_email: 'ct-email', invalid_subject: 'ct-subject', invalid_message: 'ct-message' };

  /* ---------- الواجهة ---------- */
  const msgEl = $('ct-message');
  const count = $('ct-count');
  const paintCount = function () { count.textContent = msgEl.value.length + ' / ' + MAX_MESSAGE; };
  msgEl.addEventListener('input', paintCount);
  paintCount();
  FIELDS.forEach(function (id) {
    const inp = $(id);
    inp.addEventListener('input', function () { if (inp.getAttribute('aria-invalid')) P.ui.fieldError(inp, ''); });
  });

  const delay = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  /* نجاح: نفرّغ النموذج (فلا تُرسَل الرسالة مرتين) ونُظهر التأكيد وننقل التركيز إليه */
  function finish(mailed) {
    form.reset();
    paintCount();
    FIELDS.forEach(function (id) { P.ui.fieldError($(id), ''); });
    say('ok', mailed ? TXT.ok : TXT.saved);
    try { status.focus(); } catch (e) { /* تجاهل */ }
  }

  /* فشل: خطأ حقل يظهر تحته مع التركيز عليه، وغيره رسالة عامة مع رابط واتساب */
  function fail(res) {
    const id = Object.prototype.hasOwnProperty.call(FIELD_OF, res.error) ? FIELD_OF[res.error] : '';
    if (id) {
      const el = $(id);
      P.ui.fieldError(el, P.mail.text(res));
      el.focus();
      return;
    }
    say('err', P.mail.text(res), true);
  }

  const onSubmit = P.ui.guard(btn, status, async function () {
    clearStatus();
    if ($('ct-site').value.trim() !== '') { /* حقل المصيدة: روبوت. نُظهر النجاح دون أي طلب */
      await delay(700);
      finish(true);
      return false;
    }
    const bag = {};
    const name = P.ui.check($('ct-name'), rules.name($('ct-name').value), bag);
    const email = P.ui.check($('ct-email'), rules.email($('ct-email').value), bag);
    const subject = P.ui.check($('ct-subject'), rules.subject($('ct-subject').value), bag);
    const message = P.ui.check($('ct-message'), rules.message($('ct-message').value), bag);
    if (bag.first) { bag.first.focus(); return false; }
    const res = await P.mail.send({ action: 'contact', name: name, email: email, subject: subject, message: message, website: '' });
    if (res.ok) finish(res.mailed); else fail(res);
    return false;
  });
  form.addEventListener('submit', onSubmit);

  /* عودة الصفحة من الذاكرة السريعة (bfcache): نفكّ الزر إن كان معلّقًا */
  win.addEventListener('pageshow', function (e) { if (e.persisted) onSubmit.reset(); });
})();
