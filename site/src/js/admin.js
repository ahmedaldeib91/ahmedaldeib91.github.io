/* =====================================================================
   admin.js — صفحة /admin/ (لوحة المدرب): الإقلاع والحارس والتوجيه
   ملف عادي (ES2017) يُحمَّل بـ defer آخر الملفات (بعد platform-api.js وadmin-core.js وملفات الأقسام admin-*.js).

   الوصول
   - بلا جلسة محفوظة: تحويل إلى /account/. ومع جلسة: يُقرأ صفّ المستخدم من profiles، ولا تُعرض اللوحة ولا يُطلب أي شيء من بياناتها
     إلا إن كان role = admin وstatus = active، وإلا يُحوَّل إلى /dashboard/ (replace). هذا للراحة فقط: الحماية الحقيقية سياسات RLS
     في القاعدة، فلو تجاوزها أحدهم في المتصفح لما أعطته القاعدة شيئًا.
   - عند أي خطأ صلاحية (403/42501) يُعاد قراءة الدور، فإن سُحب الدور يُحوَّل إلى /dashboard/.
   - انتهاء الجلسة نهائيًا ← /account/?reason=expired . الخروج ← يُفرَّغ المحتوى أولًا ثم يُبطَل التوكن ثم /account/?reason=out
     (وكذلك عند الخروج من تبويب آخر أو عودة الصفحة من الذاكرة السريعة بلا جلسة).

   التوجيه (hash): #stats #trainees #trainees/<uuid> #enrollments #subscribers #courses #courses/<id>[/videos|/questions] #messages[/<uuid>]
   #blog #blog/new #blog/<uuid> #settings #qbank[/<course>/questions|taxonomy|staff|new|edit/<uuid>|copy/<uuid>] (انظر admin-qbank.js).
   قائمة الأقسام روابط <nav aria-label> مع aria-current="page" (والتبويبات الداخلية
   في الدورات بـ ARIA tablist)، وبعد كل انتقال يُنقل التركيز إلى عنوان القسم ويُعلَن للقارئ الشاشي.
   ===================================================================== */
(function () {
  'use strict';

  const $ = function (id) { return document.getElementById(id); };
  const gate = $('ad-gate');
  const P = window.Platform;
  const A = window.Admin;

  if (!P || !A) {
    gate.className = 'pf-msg err';
    gate.textContent = 'تعذّر تحميل لوحة المدرب. حدّث الصفحة ثم أعد المحاولة.';
    return;
  }
  const ui = P.ui;
  const h = ui.h;
  const S = A.S;

  const NAV = [
    ['stats', 'الإحصاءات', 'chart'],
    ['trainees', 'المتدربون', 'users'],
    ['enrollments', 'الاشتراكات', 'userplus'],
    ['subscribers', 'المشتركون', 'file'],
    ['courses', 'الدورات', 'book'],
    ['qbank', 'بنك الأسئلة', 'quiz'],
    ['messages', 'الرسائل', 'mail'],
    ['blog', 'المدونة', 'pen'],
    ['settings', 'الإعدادات', 'gear']
  ];
  let first = true;

  /* ---------- حالة الصفحة ---------- */
  function wipe() { /* تفريغ كل ما يخص اللوحة (عند الخروج أو فقدان الجلسة أو سحب الدور) */
    S.nav++;
    S.me = null;
    S.dir = null;
    S.courses = [];
    S.names = {};
    A.clear($('ad-view'));
    A.clear($('ad-nav'));
    $('ad-shell').hidden = true;
    $('ad-hello').textContent = '';
    document.title = TITLE;
  }
  const TITLE = document.title;
  A.hooks.wipe = wipe;

  function toDashboard() { wipe(); window.location.replace('/dashboard/'); }

  let rechecking = false;
  A.hooks.forbidden = function () { /* بعد خطأ صلاحية: هل ما زال الدور مدربًا؟ */
    if (rechecking || !S.me) return;
    rechecking = true;
    readMe().then(function (me) {
      rechecking = false;
      if (!me || me.role !== 'admin' || me.status !== 'active') toDashboard();
    }, function (err) { rechecking = false; if (A.isSession(err)) A.lost('expired'); });
  };

  async function readMe() {
    const rows = await P.rest.select('profiles', { select: 'id,full_name,phone,country,role,status', id: 'eq.' + S.uid });
    return rows[0] || null;
  }

  /* ---------- شارة الرسائل الجديدة ---------- */
  function setBadge(n) {
    const b = $('ad-badge');
    if (!b) return;
    b.hidden = !(n > 0);
    A.clear(b);
    if (n > 0) {
      b.appendChild(h('span', { 'aria-hidden': 'true', text: n > 99 ? '99+' : String(n) }));
      b.appendChild(h('span', { class: 'ad-sr', text: n + ' رسائل جديدة' }));
    }
  }
  A.setBadge = setBadge;
  A.refreshBadge = async function () {
    try { setBadge(await P.rest.count('contact_messages', { status: 'eq.new' })); } catch (err) { if (A.isSession(err)) A.lost('expired'); }
  };

  /* ---------- القائمة ---------- */
  function buildNav() {
    const nav = $('ad-nav');
    A.clear(nav);
    nav.appendChild(h('ul', null, NAV.map(function (n) {
      return h('li', null, h('a', { href: '#' + n[0], 'data-sec': n[0] },
        A.icon(n[2]), h('span', { class: 'ad-navt', text: n[1] }),
        n[0] === 'messages' ? h('span', { class: 'ad-count', id: 'ad-badge', hidden: true }) : null));
    })));
  }
  function markNav(name) {
    Array.prototype.forEach.call($('ad-nav').querySelectorAll('a'), function (a) {
      if (a.getAttribute('data-sec') === name) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
  }

  /* ---------- التوجيه ---------- */
  function parseHash() {
    const raw = window.location.hash.replace(/^#\/?/, '');
    const parts = raw ? raw.split('/') : [];
    const dec = parts.map(function (p) { try { return decodeURIComponent(p); } catch (e) { return p; } });
    return { name: dec[0] || 'stats', args: dec.slice(1) };
  }
  function route() {
    if (!S.me) return;
    const r = parseHash();
    const known = NAV.some(function (n) { return n[0] === r.name; });
    if (!known) { try { window.history.replaceState(null, '', '#stats'); } catch (e) { /* تجاهل */ } r.name = 'stats'; r.args = []; }
    const sec = A.sections[r.name];
    const root = $('ad-view');
    const token = ++S.nav;
    markNav(r.name);
    A.clear(root);
    if (!sec) { root.appendChild(A.fail('تعذّر تحميل هذا القسم. حدّث الصفحة ثم أعد المحاولة.')); return; }
    document.title = sec.label + ' | لوحة المدرب';
    /* الاستدعاء متزامن (دالة async لا ترمي بشكل متزامن) كي يوجد عنوان القسم #ad-title فور العودة فننقل التركيز إليه */
    const p = sec.render(root, r.args, token);
    p.catch(function (err) {
      if (A.stale(token)) return;
      if (A.isSession(err)) { A.lost('expired'); return; }
      if (A.isForbidden(err)) A.hooks.forbidden();
      A.clear(root);
      root.appendChild(A.fail(A.errText(err), route));
    });
    if (!first) {
      A.scrollTop();
      A.focusTitle();
      A.announce('تم فتح قسم ' + sec.label);
    }
    first = false;
    A.refreshBadge();
  }
  A.route = route;

  /* ---------- الإقلاع ---------- */
  function gateFail(text, retry) {
    A.clear(gate);
    gate.hidden = false;
    gate.className = 'pf-fail pf-card';
    gate.removeAttribute('role');
    gate.appendChild(h('p', { class: 'pf-msg err', role: 'alert', text: text }));
    if (retry) gate.appendChild(h('div', { class: 'btns' }, h('button', { type: 'button', class: 'btn p', on: { click: retry } }, 'إعادة المحاولة')));
  }
  async function boot() {
    if (!P.config.ok) { gateFail(P.MSG.config); return; }
    const s = P.session.get();
    if (!s) { P.goLogin(''); return; }
    S.uid = s.user.id;
    S.email = s.user.email;
    gate.className = 'pf-loading';
    gate.setAttribute('role', 'status');
    A.clear(gate);
    gate.appendChild(h('span', { class: 'pf-spin', 'aria-hidden': 'true' }));
    gate.appendChild(document.createTextNode('جارٍ التحقق من الصلاحية…'));
    let me;
    try { me = await readMe(); } catch (err) {
      if (A.isSession(err)) { P.goLogin('expired'); return; }
      gateFail(A.errText(err), boot);
      return;
    }
    if (!me || me.role !== 'admin' || me.status !== 'active') { window.location.replace('/dashboard/'); return; }
    S.me = me;
    gate.hidden = true;
    $('ad-hello').textContent = 'مرحبًا، ' + (me.full_name || S.email);
    $('ad-shell').hidden = false;
    buildNav();
    route();
  }

  $('ad-logout').addEventListener('click', async function () {
    const btn = $('ad-logout');
    if (btn.disabled) return;
    ui.setBusy(btn, true);
    wipe();
    gate.className = 'pf-loading';
    gate.setAttribute('role', 'status');
    A.clear(gate);
    gate.appendChild(h('span', { class: 'pf-spin', 'aria-hidden': 'true' }));
    gate.appendChild(document.createTextNode('جارٍ تسجيل الخروج…'));
    gate.hidden = false;
    await P.auth.signOut();
    P.goLogin('out');
  });

  /* حارس مغادرة اختياري (A.leaveGuard) يضعه من يملك تغييرات غير محفوظة (محرر السؤال): يُستدعى قبل كل توجيه ناتج عن تغيّر الـhash ويعيد true لإيقافه.
     استدعاءات A.route() المباشرة لا يعترضها. لا نعتمد على ترتيب مستمعي hashchange الأخرى. */
  A.leaveGuard = null;
  window.addEventListener('hashchange', function () {
    if (typeof A.leaveGuard === 'function' && A.leaveGuard() === true) return;
    route();
  });
  window.addEventListener('storage', function (e) { /* خروج في تبويب آخر */
    if ((e.key === P.session.key || e.key === null) && !P.session.has()) { wipe(); P.goLogin('out'); }
  });
  window.addEventListener('pageshow', function (e) { /* عودة من الذاكرة السريعة بعد خروج: لا تبقى لوحة مقروءة */
    if (e.persisted && !P.session.has()) { wipe(); P.goLogin('out'); }
  });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && S.me && !P.session.has()) { wipe(); P.goLogin('out'); }
  });

  boot();
})();
