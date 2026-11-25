/* =====================================================================
   transition.js — انتقال «بوابة الشارة» بين صفحات الموقع (T6) (ملف عادي: ES5 بلا وحدات ولا مكتبات)
   يُحمَّل بـ defer من head.html في كل صفحة. كل صفحة مستند مستقل، فالانتقال في مرحلتين تربطهما sessionStorage:

   1) الصفحة القديمة («in»): نقر على رابط داخلي ← تُحدَّد نقطة النقر (--x/--y) وصورة الوجهة وعنوانها ←
      يتوسّع الدائرة (class="portal in") ← وبعد 650ms يُفتح الرابط. وقبلها يُكتب في sessionStorage المفتاح portal:
      {to, ts, img, cls, t} (مسار الوجهة، الوقت، صورة البوابة وصنفها وعنوانها).
   2) الصفحة الجديدة («out»): سكربت صغير في head.html يعمل قبل أول رسم؛ إن وجد portal عمره أقل من 4 ثوانٍ لهذا
      المسار نفسه أضاف class portal-pending إلى <html> فتظهر البوابة مغطّية كل شيء (shared-extra.css)، وينسخ صورة
      البوابة القديمة وعنوانها إلى بوابة الصفحة الجديدة فور أن ينشئها المحلّل (MutationObserver قبل أول رسم) ويحمّل الصورة
      مسبقًا. ثم يفتح هذا الملف الدائرة (class="portal out") حين تجهز الخطوط (حدّ أقصى 350ms)، ويمسح المفتاح، وينقل
      التركيز إلى <main>. لا ينتظر حدث load: صور الصفحة تظهر أثناء انغلاق الدائرة كما في أي تحميل عادي.
   الزمن الاسمي: 650ms (in) + جهوزية الصفحة الجديدة + 500ms (out) ≈ 1.3 ثانية مع تخزين مؤقت سليم (المعاينة 2.1)،
   ولا وميض للصفحة بين المرحلتين.

   لا ينتقل (تنقّل عادي فوري) في هذه الحالات: «تقليل الحركة»، نقر مع Ctrl/Meta/Shift/Alt أو بزر غير الأيسر (والنقر
   الأوسط لا يُسمّى click أصلًا)، target غير _self، download، روابط mailto: وtel: وغيرها من غير http(s)، موقع آخر،
   ملف (pdf وصورة وxml)، رابط الصفحة الحالية أو قفزة #hash فيها، تعذّر sessionStorage (try/catch)، أو تعطيل
   JavaScript (الروابط عادية). والرجوع/التقدّم: لا portal-pending عند back_forward، وإن عادت الصفحة من
   الذاكرة السريعة (bfcache) يُزال غطاؤها في pageshow. ولا تُشغَّل المرحلة الثانية إن فُتحت الصفحة بلا انتقال
   (أول زيارة، أو من موقع آخر، أو من عنوان مباشر).

   الأمان: إن لم يتم التنقّل خلال 3 ثوانٍ يُزال الغطاء من الصفحة القديمة؛ وفي الصفحة الجديدة يزيل CSS الغطاء ذاتيًا
   بعد 3 ثوانٍ حتى لو لم يعمل هذا الملف. فلا تُحجب الصفحة أبدًا.

   العناوين عربية الآن؛ وتترجمها لاحقًا الدالة window.__portalTitle(ar) (الافتراضية تُرجع النص كما هو) التي يعرّفها
   محرّك الترجمة (T9) بلا أي تعديل هنا. وبعد التحميل تُحمَّل مسبقًا صور البوابة (إلا مع توفير البيانات أو 2G).
   ===================================================================== */
(function () {
  'use strict';

  var doc = document;
  var win = window;
  var root = doc.documentElement;

  var KEY = 'portal';
  var HOLD = 650;
  var SAFETY = 3000;
  var OUT_MS = 500;
  var FONT_WAIT = 350;
  var BASE = root.getAttribute('data-base-path') || '';
  var BADGES = BASE + '/assets/badges/';
  var REDUCE_Q = '(prefers-reduced-motion: reduce)';

  /* destination page -> [image in /assets/badges, Arabic title, class of the image: pn = pulsing badge, pl = white card] */
var PAGES = {};
PAGES[BASE + '/'] = ['nav-home.png', 'الرئيسية', 'pn'];
PAGES[BASE + '/about/'] = ['nav-about.png', 'عن الموقع', 'pn'];
PAGES[BASE + '/pmi/'] = ['pmi-logo.jpg', 'معهد إدارة المشاريع PMI', 'pl'];
PAGES[BASE + '/trainer/'] = ['nav-trainer.png', 'م. أحمد الديب', 'pn'];
PAGES[BASE + '/courses/'] = ['nav-courses.png', 'الدورات', 'pn'];
PAGES[BASE + '/courses/capm/'] = ['badge-capm.webp', 'CAPM®', 'pn'];
PAGES[BASE + '/courses/pmp/'] = ['badge-pmp.png', 'PMP®', 'pn'];
PAGES[BASE + '/blog/'] = ['nav-blog.png', 'المدونة', 'pn'];
PAGES[BASE + '/faq/'] = ['nav-faq.png', 'الأسئلة الشائعة', 'pn'];
PAGES[BASE + '/contact/'] = ['nav-contact.png', 'تواصل معنا', 'pn'];

  var portal = doc.getElementById('cur');
  var pimg = doc.getElementById('pimg');
  var ptitle = doc.getElementById('pt');
  if (!portal || !pimg || !ptitle) return; /* the page has no portal markup: plain navigation everywhere */

  var fallbackImg = portal.getAttribute('data-atp') || pimg.getAttribute('src') || '';
  var busy = false, navTimer = 0, safeTimer = 0;

  /* translation hook for T9: the engine replaces this function; until then the Arabic title is used as it is */
  if (typeof win.__portalTitle !== 'function') win.__portalTitle = function (ar) { return ar; };
  function title(ar) {
    try { return String(win.__portalTitle(ar)); } catch (e) { return ar; }
  }
  function reduced() { return !!(win.matchMedia && win.matchMedia(REDUCE_Q).matches); }
  /* same rule as head.html: no index.html, always a trailing slash */
  function norm(p) { return String(p).replace(/index\.html?$/i, '').replace(/\/?$/, '/'); }

  function describe(to) {
    var e = PAGES[to];
    if (e) return { img: BADGES + e[0], cls: e[2], t: title(e[1]) };
    return { img: fallbackImg, cls: 'pn', t: '' }; /* a page without its own badge: the ATP badge, no title */
  }

  /* is this link a page of this site that should open through the portal? */
  function eligible(a) {
    var href = a.getAttribute('href'), target = a.getAttribute('target'), loc = win.location;
    if (typeof a.pathname !== 'string') return false;
    if (!href || href.charAt(0) === '#') return false;
    if (target && target !== '_self') return false;
    if (a.hasAttribute('download')) return false;
    if (a.protocol !== 'http:' && a.protocol !== 'https:') return false;
    if (a.host !== loc.host) return false;
    if (/\.[a-z0-9]{1,6}$/i.test(a.pathname) && !/\.html?$/i.test(a.pathname)) return false;
    if (norm(a.pathname) === norm(loc.pathname) && a.search === loc.search) return false;
    return true;
  }

  function forget() {
    try { win.sessionStorage.removeItem(KEY); } catch (e) { /* storage blocked */ }
  }

  /* take the cover off: the circle closes (animated) or snaps shut (a page restored from the back/forward cache) */
  function reset(animated) {
    win.clearTimeout(navTimer);
    win.clearTimeout(safeTimer);
    busy = false;
    root.classList.remove('portal-pending');
    forget();
    if (animated) {
      portal.className = 'portal out';
      win.setTimeout(function () { if (!busy) portal.className = 'portal'; }, OUT_MS + 150);
    } else {
      portal.className = 'portal';
    }
  }

  /* ---------- 1) this page: the "in" phase ---------- */
  function onClick(e) {
    var a, to, dest, x, y, r;
    if (busy || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a || !eligible(a) || reduced()) return;

    to = norm(a.pathname);
    dest = describe(to);
    try {
      win.sessionStorage.setItem(KEY, JSON.stringify({ to: to, ts: Date.now(), img: dest.img, cls: dest.cls, t: dest.t }));
    } catch (err) {
      return; /* the next page could not be told about the transition: plain navigation */
    }
    e.preventDefault();

    x = e.clientX; y = e.clientY;
    if (!x && !y) { /* a keyboard click reports 0,0: open from the middle of the link instead */
      r = a.getBoundingClientRect();
      x = r.left + r.width / 2;
      y = r.top + r.height / 2;
    }
    portal.style.setProperty('--x', Math.round(x) + 'px');
    portal.style.setProperty('--y', Math.round(y) + 'px');
    pimg.src = dest.img;
    pimg.className = dest.cls;
    ptitle.textContent = dest.t;
    portal.className = 'portal in';

    busy = true;
    navTimer = win.setTimeout(function () { win.location.href = a.href; }, HOLD);
    safeTimer = win.setTimeout(function () { reset(true); }, SAFETY);
  }

  /* ---------- 2) the new page: the "out" phase ---------- */
  /* the page is parsed when a deferred script runs; what is left to wait for is the fonts of the text under the cover */
  function whenReady(fn) {
    var done = false;
    function once() { if (!done) { done = true; fn(); } }
    void doc.body.offsetHeight; /* lay the page out now, so the browser starts requesting the fonts it needs */
    if (doc.fonts && doc.fonts.ready && doc.fonts.ready.then) doc.fonts.ready.then(once, once);
    else once();
    win.setTimeout(once, FONT_WAIT);
  }
  /* head.html copies the hand-off into the portal as the parser creates it; this only repairs a page where that did not happen */
  function syncHandoff() {
  var p = win.__portalIn;
  if (!p) return;

  if (
    typeof p.img === 'string' &&
    p.img.indexOf(BADGES) === 0 &&
    /^[\w.-]+$/.test(p.img.slice(BADGES.length)) &&
    pimg.getAttribute('src') !== p.img
  ) {
    pimg.src = p.img;
  }

  if (/^(pn|pl|ph)$/.test(p.cls) && pimg.className !== p.cls) {
    pimg.className = p.cls;
  }

  if (ptitle.textContent !== String(p.t || '')) {
    ptitle.textContent = String(p.t || '');
  }
}
  function arrive() {
    if (!root.classList.contains('portal-pending')) return;
    syncHandoff();
    whenReady(function () {
      var m;
      void portal.offsetWidth; /* compute the covered look first, so the swap below is a transition and not a jump */
      root.classList.remove('portal-pending');
      portal.className = 'portal out';
      forget();
      m = doc.getElementById('main');
      if (m) {
        m.setAttribute('tabindex', '-1');
        try { m.focus({ preventScroll: true }); } catch (err) { m.focus(); }
      }
      win.setTimeout(function () { if (!busy) portal.className = 'portal'; }, OUT_MS + 150);
    });
  }

  /* ---------- 3) preload the portal images, once the page itself is done ---------- */
  var held = [];
  function preload() {
    var c = win.navigator && win.navigator.connection, seen = {}, urls = [fallbackImg], k, i, im;
    if (c && (c.saveData || /(^|-)2g$/.test(c.effectiveType || ''))) return;
    for (k in PAGES) if (Object.prototype.hasOwnProperty.call(PAGES, k)) urls.push(BADGES + PAGES[k][0]);
    for (i = 0; i < urls.length; i++) {
      if (!urls[i] || seen[urls[i]]) continue;
      seen[urls[i]] = true;
      im = new win.Image();
      im.src = urls[i];
      held.push(im);
    }
  }
  function schedulePreload() {
    if (win.requestIdleCallback) win.requestIdleCallback(preload, { timeout: 4000 });
    else win.setTimeout(preload, 800);
  }

  doc.addEventListener('click', onClick);
  /* restored from the back/forward cache: the old page is still in its covered state, uncover it */
  win.addEventListener('pageshow', function (e) { if (e.persisted) reset(false); });
  arrive();
  if (doc.readyState === 'complete') schedulePreload();
  else win.addEventListener('load', schedulePreload);
})();
