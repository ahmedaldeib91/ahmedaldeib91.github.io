/* =====================================================================
   carousel.js — حلقة الدورات ثلاثية الأبعاد (T5) وأرقام الهيرو (ملف عادي: ES5 بلا وحدات ولا مكتبات)
   يُحمَّل بـ defer من الصفحة الرئيسية وصفحة الدورات فقط (في آخر <main> بعد #courses-data).
   كل بحث في الصفحة محروس ضد null، فإن غابت الحاويات أو البيانات لا يحدث شيء.

   البيانات: من <script type="application/json" id="courses-data"> وحده (يولّده البناء من data/courses.json):
   id, status (available|soon), badge, titleAr, subtitleEn, categoryAr, categoryEn, page (اختياري).
   ترتيب الحلقة هو ترتيب القائمة، والدورة النشطة عند الفتح هي id=pmp إن وُجدت وإلا الأولى.
   رابط واتساب يُقرأ من الصفحة نفسها (أول رابط يبدأ بـ https://wa.me/)، وليس مكتوبًا هنا.

   الحاويات (فارغة في HTML ويملؤها هذا الملف): الحلقة #arcH/#arcC، ومعلومات الدورة تحتها #infoH/#infoC،
   والأسهم والنقاط #ctlH/#ctlC. وتحت الحلقة تعمل الأرقام: أي عنصر فيه data-count="total" يأخذ عدد الدورات،
   وdata-count="available" عدد المتاحة الآن (الرقم المكتوب في HTML يولّده البناء بالقيمة نفسها).

   السلوك (منقول من المعاينة): سحب بقصور ذاتي، نقر على شارة لتقديمها، ونقر على الشارة النشطة التي لها صفحة
   يفتح /courses/<page>/، أسهم الشاشة، أسهم لوحة المفاتيح، عجلة أفقية (خطوة واحدة لكل حركة)، نقاط، ميل منظوري
   مع المؤشر، لون توهّج لكل دورة، وكتلة معلومات (التصنيف، العنوان، العنوان الإنجليزي، الحالة، واتساب، تفاصيل الدورة).

   ما أُضيف على المعاينة
   - خطوة الأسهم والعجلة تُحسب من الشارة التي تتجه إليها الحلقة (لا من الظاهرة الآن)، فتتراكم الضغطات السريعة، وكذلك
     الضغطات أثناء نوم حلقة الرسم (ما كانت المعاينة لتحتاج ذلك لأن حلقتها لا تنام).
   - النقر على الشارات الجانبية: في سياق ثلاثي الأبعاد يُختبَر مستوى .stage قبل أي شارة خلفه (z سالب)، فلم تكن غير الشارة
     الأمامية تستقبل النقر. يمنع shared-extra.css الأحداث عن .stage ويمنحها للشارات.
   - «تقليل الحركة»: لا قصور ذاتي ولا ميل، فتنقر الحلقة على الدورة مباشرة (والسحب باليد يتبع الإصبع).
   - توفير الأداء: حلقة الرسم requestAnimationFrame لا تدور إلا وهي ظاهرة على الشاشة (IntersectionObserver)
     والتبويب ظاهر، وتتوقف أيضًا حين تستقر الحلقة، وتعود عند أي إدخال.
   - الوصول: role=group وaria-label للحلقة، وaria-live=polite لكتلة المعلومات، وaria-current للنقطة والشارة النشطتين،
     وأسماء للأزرار، والتحكم كله بلوحة المفاتيح (سهم يمين/يسار على الحلقة، Tab إلى الأزرار والروابط).
   - اللمس: السحب الأفقي يدير الحلقة، والتمرير العمودي يمرّر الصفحة (touch-action: pan-y في CSS) فإن أخذه المتصفح
     أُلغي السحب بلا اختيار خاطئ.
   - نقر الشارة النشطة يمرّ عبر رابط «تفاصيل الدورة» نفسه، فيعمل معه انتقال البوابة (transition.js) إن وُجد.
   ===================================================================== */
(function () {
  'use strict';

  var doc = document;
  var win = window;

  var BADGES = '/assets/badges/';
  var REDUCE_Q = '(prefers-reduced-motion: reduce)';
  var STATUS_AR = { available: 'متاحة الآن', soon: 'قريبًا' };
  var CTA_AR = { available: 'احجز مقعدك عبر واتساب', soon: 'سجّل اهتمامك عبر واتساب' };
  /* glow behind the ring: cyan for CAPM, violet for the other available courses, copper for the coming ones */
  var GLOW = { capm: '#18C8E4', available: '#9B6BFF', soon: '#D08A5A' };
  var START_ID = 'pmp';
  var MOVED_MAX = 6; /* px: a press that moved less than this is a click */

  function byId(id) { return doc.getElementById(id); }
  function mk(tag, cls, text) {
    var e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  function statusOf(c) { return c.status === 'available' ? 'available' : 'soon'; }
  function reduced() { return !!(win.matchMedia && win.matchMedia(REDUCE_Q).matches); }
  /* looked up at call time (not cached) so the loop can be traced and tested from outside */
  function nextFrame(fn) { return win.requestAnimationFrame ? win.requestAnimationFrame(fn) : win.setTimeout(fn, 16); }
  function cancelFrame(id) { if (win.cancelAnimationFrame) win.cancelAnimationFrame(id); else win.clearTimeout(id); }
  function r2(x) { return Math.round(x * 100) / 100; }

  /* ---------- data ---------- */
  function readCourses() {
    var node = byId('courses-data');
    var raw, list = [], i, c;
    if (!node) return list;
    try { raw = JSON.parse(node.textContent); } catch (e) { return list; }
    if (!raw || typeof raw.length !== 'number') return list;
    for (i = 0; i < raw.length; i++) {
      c = raw[i];
      if (c && c.id && c.badge && c.titleAr) list.push(c);
    }
    return list;
  }

  /* ---------- hero numbers: the static HTML already holds the same values, this keeps them tied to the JSON ---------- */
  function initCounts(list) {
    var els = doc.querySelectorAll('[data-count]');
    var total = list.length, avail = 0, i, kind;
    for (i = 0; i < list.length; i++) if (statusOf(list[i]) === 'available') avail++;
    for (i = 0; i < els.length; i++) {
      kind = els[i].getAttribute('data-count');
      if (kind === 'total') els[i].textContent = String(total);
      else if (kind === 'available') els[i].textContent = String(avail);
    }
  }

  /* ---------- the ring ---------- */
  function initRing(list, arcId, infoId, ctlId, waUrl) {
    var el = byId(arcId), info = byId(infoId), ctl = byId(ctlId);
    if (!el || !info || !ctl || !list.length) return;

    var n = list.length, step = 360 / n, i, start = 0;
    for (i = 0; i < n; i++) if (list[i].id === START_ID) { start = i; break; }

    var ang = -start * step, tgt = ang, vel = 0; /* ring angle now / wanted, last drag speed (deg per move) */
    var drag = false, moved = 0, lx = 0, pid = null, downEl = null;
    var tx = 0, ty = 0, cx = 0, cy = 0;          /* parallax tilt: wanted / eased (deg) */
    var act = -1, W = 0, R = 330;
    var visible = true, frameId = 0, calm = reduced();
    var wheelAt = 0, wheelStepped = false;
    var items = [], dots = [];

    /* ----- build the DOM ----- */
    el.tabIndex = 0;
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', 'دوّار الدورات: اسحب أو استخدم الأسهم');
    var stage = mk('div', 'stage');
    for (i = 0; i < n; i++) {
      var c = list[i], d = mk('div', 'it'), img = mk('img');
      img.setAttribute('draggable', 'false');
      img.decoding = 'async';
      img.src = BADGES + c.badge;
      img.alt = c.titleAr;
      d.appendChild(img);
      d.appendChild(mk('span', 'tg' + (statusOf(c) === 'available' ? ' ok' : ''), STATUS_AR[statusOf(c)]));
      stage.appendChild(d);
      items.push(d);
    }
    el.appendChild(stage);

    ctl.textContent = '';
    var prev = mk('button', 'ar', '›'), next = mk('button', 'ar', '‹'), dotBox = mk('span', 'dots');
    prev.type = 'button'; prev.setAttribute('aria-label', 'السابق');
    next.type = 'button'; next.setAttribute('aria-label', 'التالي');
    dotBox.setAttribute('role', 'group');
    dotBox.setAttribute('aria-label', 'اختر الدورة');
    for (i = 0; i < n; i++) {
      var b = mk('button', 'dot');
      b.type = 'button';
      b.setAttribute('aria-label', list[i].titleAr);
      b.addEventListener('click', dotHandler(i));
      dotBox.appendChild(b);
      dots.push(b);
    }
    ctl.appendChild(prev); ctl.appendChild(dotBox); ctl.appendChild(next);

    function dotHandler(k) { return function () { go(k); }; }

    /* ----- state ----- */
    function snap(k) { k = ((k % n) + n) % n; tgt = -k * step + 360 * Math.round((ang + k * step) / 360); }
    function cur() { return (((Math.round(-ang / step)) % n) + n) % n; }   /* the badge in front right now (what a click on "the active badge" means) */
    function want() { return (((Math.round(-tgt / step)) % n) + n) % n; }  /* the badge the ring is heading for: arrows and wheel step from here, so quick presses (or presses while the loop sleeps) add up */
    function go(k) { snap(k); wake(); }

    function settled() {
      return !drag && Math.abs(tgt - ang) < 0.02 && Math.abs(tx - cx) < 0.02 && Math.abs(ty - cy) < 0.02;
    }

    /* ----- the info block under the ring ----- */
    function setInfo(k) {
      var c = list[k], s = statusOf(c), j;
      el.style.setProperty('--g', s === 'available' ? (GLOW[c.id] || GLOW.available) : GLOW.soon);
      info.textContent = '';
      info.appendChild(mk('div', 'eyebrow', c.categoryAr + ' | ' + c.categoryEn));
      info.appendChild(mk('h2', null, c.titleAr));
      var sub = mk('div', 'sub-en', c.subtitleEn);
      sub.setAttribute('dir', 'ltr');
      info.appendChild(sub);
      info.appendChild(mk('span', 'st ' + (s === 'available' ? 'ok' : 'soon'), STATUS_AR[s]));
      var acts = mk('div', 'acts'), wa = mk('a', 'btn p', CTA_AR[s]);
      wa.href = waUrl;
      if (/^https?:/i.test(waUrl)) { wa.target = '_blank'; wa.rel = 'noopener'; }
      acts.appendChild(wa);
      if (c.page) {
        var det = mk('a', 'btn s', 'تفاصيل الدورة');
        det.href = '/courses/' + c.page + '/';
        det.setAttribute('data-details', '');
        acts.appendChild(det);
      }
      info.appendChild(acts);
      for (j = 0; j < n; j++) {
        dots[j].className = 'dot' + (j === k ? ' on' : '');
        dots[j].setAttribute('aria-current', j === k ? 'true' : 'false');
        if (j === k) items[j].setAttribute('aria-current', 'true'); else items[j].removeAttribute('aria-current');
      }
    }

    /* ----- one paint of the ring ----- */
    function measure() {
      var narrow = (win.innerWidth || doc.documentElement.clientWidth) <= 820; /* same breakpoint as the CSS (.arc is 300px high) */
      var w = narrow ? 150 : 210;
      R = narrow ? 170 : 330;
      if (w !== W) { W = w; el.style.setProperty('--w', w + 'px'); }
    }
    function render() {
      var j, th, c, s, front, k;
      if (!el.offsetParent && el.offsetWidth === 0) return; /* display:none: nothing to lay out */
      if (calm) { if (!drag) ang = tgt; tx = ty = cx = cy = 0; }
      else {
        if (!drag) ang += (tgt - ang) * 0.1;
        cx += (tx - cx) * 0.08;
        cy += (ty - cy) * 0.08;
      }
      stage.style.transform = 'rotateX(' + r2(-9 + cx) + 'deg) rotateY(' + r2(cy) + 'deg)';
      for (j = 0; j < n; j++) {
        th = (j * step + ang) * Math.PI / 180;
        c = Math.cos(th);
        s = Math.sin(th);
        front = (c + 1) / 2;
        items[j].style.transform = 'translate3d(' + r2(s * R * 1.15) + 'px,' + r2(-c * 26) + 'px,' + r2((c - 1) * R * 0.7) + 'px) rotateY(' + r2(-s * 38) + 'deg) scale(' + r2(0.72 + 0.38 * front) + ')';
        items[j].style.opacity = (0.3 + 0.7 * front).toFixed(3);
        items[j].style.zIndex = String(Math.round(front * 100));
        items[j].style.filter = 'brightness(' + (0.55 + 0.45 * front).toFixed(3) + ')';
      }
      k = cur();
      if (k !== act) { act = k; setInfo(k); }
    }

    /* ----- the frame loop: runs only while something moves, the ring is on screen and the tab is visible ----- */
    function tick() {
      frameId = 0;
      render();
      if (!settled()) schedule();
    }
    function schedule() {
      if (!frameId && visible && !doc.hidden) frameId = nextFrame(tick);
    }
    /* something changed (input, resize, back on screen): re-read "reduced motion" and make sure a frame is coming */
    function wake() {
      calm = reduced();
      schedule();
    }
    function sleep() {
      if (frameId) { cancelFrame(frameId); frameId = 0; }
    }

    /* ----- input ----- */
    prev.addEventListener('click', function () { go(want() - 1); });
    next.addEventListener('click', function () { go(want() + 1); });

    el.addEventListener('keydown', function (e) {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === 'ArrowLeft' || e.key === 'Left') { go(want() + 1); e.preventDefault(); }
      else if (e.key === 'ArrowRight' || e.key === 'Right') { go(want() - 1); e.preventDefault(); }
    });

    /* horizontal wheel / trackpad swipe: one step per gesture (a pause of 160ms ends a gesture), vertical scroll untouched */
    el.addEventListener('wheel', function (e) {
      var d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : 0, now;
      if (!d) return;
      e.preventDefault();
      now = Date.now();
      if (now - wheelAt > 160) wheelStepped = false;
      wheelAt = now;
      if (wheelStepped) return;
      wheelStepped = true;
      go(want() + (d > 0 ? 1 : -1));
    }, { passive: false });

    el.addEventListener('pointerdown', function (e) {
      if (pid !== null) return;                                  /* a second finger is ignored */
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      pid = e.pointerId;
      drag = true; moved = 0; lx = e.clientX; vel = 0;
      downEl = e.target;                                         /* with pointer capture, pointerup reports the ring itself */
      try { el.setPointerCapture(pid); } catch (err) { /* synthetic pointer: no capture, drag still works inside the ring */ }
      wake();
    });
    el.addEventListener('pointermove', function (e) {
      var r, dx;
      if (e.pointerType !== 'touch' && !calm) {
        r = el.getBoundingClientRect();
        ty = ((e.clientX - r.left) / (r.width || 1) - 0.5) * 18;
        tx = -((e.clientY - r.top) / (r.height || 1) - 0.5) * 12;
      }
      if (drag && e.pointerId === pid) {
        dx = e.clientX - lx;
        lx = e.clientX;
        moved += Math.abs(dx);
        ang += dx * 0.45;
        vel = dx * 0.45;
        tgt = ang;
      }
      schedule();
    });
    function release(e, cancelled) {
      var from = downEl, hit, k;
      if (!drag || e.pointerId !== pid) return;
      drag = false; pid = null; downEl = null;
      try { el.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
      if (cancelled) { snap(cur()); }
      else if (moved < MOVED_MAX) {
        hit = from && from.closest ? from.closest('.it') : null;
        k = hit ? items.indexOf(hit) : -1;
        if (k < 0) snap(cur());
        else if (k === cur() && list[k].page) { snap(k); openPage(e); }
        else snap(k);
      } else {
        snap(Math.round(-(ang + vel * 9) / step));              /* fling: land where the speed would carry the ring */
      }
      wake();
    }
    el.addEventListener('pointerup', function (e) { release(e, false); });
    el.addEventListener('pointercancel', function (e) { release(e, true); }); /* the browser took the gesture (vertical scroll) */
    el.addEventListener('pointerleave', function (e) {
      if (e.pointerType === 'touch') return;
      tx = 0; ty = 0; schedule();
    });

    /* the active badge was clicked: follow the "تفاصيل الدورة" link itself, so the page transition (transition.js) handles it */
    function openPage(e) {
      var a = info.querySelector('a[data-details]'), ev = null;
      if (!a) return;
      try { ev = new win.MouseEvent('click', { bubbles: true, cancelable: true, view: win, clientX: e.clientX, clientY: e.clientY }); } catch (err) { ev = null; }
      if (ev) a.dispatchEvent(ev); else win.location.href = a.href;
    }

    /* ----- when to run ----- */
    if ('IntersectionObserver' in win) {
      new win.IntersectionObserver(function (entries) {
        visible = entries[entries.length - 1].isIntersecting;
        if (visible) wake(); else sleep();
      }, { rootMargin: '150px 0px' }).observe(el);
    }
    doc.addEventListener('visibilitychange', function () { if (doc.hidden) sleep(); else wake(); });
    win.addEventListener('resize', function () { measure(); wake(); });
    win.addEventListener('pageshow', function (e) { if (e.persisted) wake(); });
    try {
      var mq = win.matchMedia(REDUCE_Q);
      if (mq.addEventListener) mq.addEventListener('change', wake); else if (mq.addListener) mq.addListener(wake);
    } catch (err) { /* no matchMedia: the loop still works */ }

    /* first paint is synchronous, so the ring is already placed even if it starts off screen */
    measure();
    render();
    info.setAttribute('aria-live', 'polite');   /* set after the first fill: the opening content is not announced */
    info.setAttribute('aria-atomic', 'true');
    wake();
  }

  /* each feature is isolated: a failure in one must never break the rest of the page */
  function safe(name, fn) {
    try { fn(); } catch (err) {
      if (win.console && console.error) console.error('carousel.js [' + name + ']', err);
    }
  }
  function init() {
    var list = readCourses(), a, wa;
    if (!list.length) return;
    a = doc.querySelector('a[href^="https://wa.me/"]');
    wa = a ? a.getAttribute('href') : '/contact/';
    safe('counts', function () { initCounts(list); });
    safe('ring home', function () { initRing(list, 'arcH', 'infoH', 'ctlH', wa); });
    safe('ring courses', function () { initRing(list, 'arcC', 'infoC', 'ctlC', wa); });
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init);
  else init();
})();
