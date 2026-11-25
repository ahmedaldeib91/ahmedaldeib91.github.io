/* =====================================================================
   main.js — السلوك المشترك في كل صفحات الموقع (ملف عادي: بلا وحدات ولا مكتبات)
   يُحمَّل بـ defer من head.html في كل صفحة، فلا يفترض وجود أي عنصر معيّن:
   كل بحث في الصفحة محروس ضد null، ويعمل الملف كما هو على أي صفحة.

   1) الظهور عند التمرير: .reveal يأخذ .show عند دخوله الشاشة (IntersectionObserver).
      أما .rv فحركة CSS تعمل وحدها لأن <main> في كل صفحة هو class="page on" (انظر shared-extra.css).
   2) الوضع الفاتح/الداكن: زر #theme، ويُحفَظ في localStorage باسم theme (الافتراضي داكن).
      سكربت صغير في head.html يطبّق القيمة المحفوظة قبل أول رسم لمنع الوميض.
   3) شريط التقدّم #prog أعلى الصفحة.
   4) بقعة الضوء #spot خلف المؤشر.
   5) ميل البطاقات (.tilt): يُعطَّل مع «تقليل الحركة» وعلى اللمس.

   لا يلمس زر اللغة #lang (محرّك الترجمة في T9) ولا حلقة الدورات (T5) ولا الانتقال بين الصفحات (T6).
   ===================================================================== */
(function () {
  'use strict';

  var doc = document;
  var root = doc.documentElement;
  var raf = window.requestAnimationFrame || function (f) { return setTimeout(f, 16); };
  var reduceMq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

  function reduced() { return !!(reduceMq && reduceMq.matches); }
  function byId(id) { return doc.getElementById(id); }

  /* ---------- 1) reveal on scroll ---------- */
  function initReveal() {
    var list = doc.querySelectorAll('.reveal:not(.show)');
    var i;
    if (!list.length) return;

    /* no observer support, or reduced motion: show everything now
       (.show is still needed: the bars and the timeline dots are keyed on it) */
    if (reduced() || !('IntersectionObserver' in window)) {
      for (i = 0; i < list.length; i++) list[i].classList.add('show');
      return;
    }

    var io = new IntersectionObserver(function (entries) {
      var n = 0;
      for (var k = 0; k < entries.length; k++) {
        if (!entries[k].isIntersecting) continue;
        reveal(entries[k].target, n++ * 70); /* stagger within one batch */
        io.unobserve(entries[k].target);
      }
    }, { threshold: 0.12 });
    for (i = 0; i < list.length; i++) io.observe(list[i]);

    function reveal(el, delay) {
      el.style.transitionDelay = delay + 'ms';
      el.classList.add('show');
      /* the stagger delay must not outlive the reveal, or it would also lag the hover tilt */
      setTimeout(function () { el.style.transitionDelay = ''; }, delay + 1200);
    }
  }

  /* ---------- 2) light / dark theme ---------- */
  function savedTheme() {
    var t = null;
    try { t = localStorage.getItem('theme'); } catch (e) { /* storage blocked: default */ }
    return t === 'light' ? 'light' : 'dark';
  }
  function setTheme(t, save) {
    root.setAttribute('data-theme', t);
    if (save) {
      try { localStorage.setItem('theme', t); } catch (e) { /* storage blocked: not persisted */ }
    }
  }
  function initTheme() {
    setTheme(savedTheme(), false);
    var btn = byId('theme');
    if (btn) {
      btn.addEventListener('click', function () {
        setTheme(root.getAttribute('data-theme') === 'light' ? 'dark' : 'light', true);
      });
    }
    /* keep other open tabs, and pages restored from the back/forward cache, in step */
    window.addEventListener('storage', function (e) {
      if (e.key === 'theme' || e.key === null) setTheme(savedTheme(), false);
    });
    window.addEventListener('pageshow', function (e) {
      if (e.persisted) setTheme(savedTheme(), false);
    });
  }

  /* ---------- 3) scroll progress bar ---------- */
  function initProgress() {
    var bar = byId('prog');
    if (!bar) return;
    var queued = false;
    function paint() {
      queued = false;
      var max = root.scrollHeight - root.clientHeight;
      var y = window.pageYOffset || root.scrollTop || 0;
      var p = max > 0 ? y / max * 100 : 0;
      bar.style.width = (p < 0 ? 0 : p > 100 ? 100 : p) + '%';
    }
    function queue() { if (!queued) { queued = true; raf(paint); } }
    window.addEventListener('scroll', queue, { passive: true });
    window.addEventListener('resize', queue);
    window.addEventListener('load', queue);
    paint();
  }

  /* ---------- 4) pointer spotlight + 5) card tilt (one pointermove handler, one paint per frame) ---------- */
  function initPointer() {
    var spot = byId('spot');
    var px = 0, py = 0, target = null, ptype = 'mouse', queued = false, tilted = null;

    function release() {
      if (tilted) { tilted.style.transform = ''; tilted = null; }
    }
    function paint() {
      queued = false;
      if (spot) {
        spot.style.setProperty('--mx', px + 'px');
        spot.style.setProperty('--my', py + 'px');
      }
      var card = null;
      if (ptype !== 'touch' && !reduced() && target && target.closest) card = target.closest('.tilt');
      if (tilted && tilted !== card) release();
      if (!card) return;
      var r = card.getBoundingClientRect();
      var x = (px - r.left) / (r.width || 1) - 0.5;
      var y = (py - r.top) / (r.height || 1) - 0.5;
      card.style.transform = 'perspective(700px) rotateY(' + (x * 14) + 'deg) rotateX(' + (-y * 14) + 'deg) translateZ(8px)';
      tilted = card;
    }

    doc.addEventListener('pointermove', function (e) {
      px = e.clientX; py = e.clientY; target = e.target; ptype = e.pointerType;
      if (!queued) { queued = true; raf(paint); }
    }, { passive: true });
    root.addEventListener('pointerleave', release); /* pointer left the page: flatten the card */
  }

  /* each feature is isolated: a failure in one must never leave the .reveal content hidden */
  function safe(name, fn) {
    try { fn(); } catch (err) {
      if (window.console && console.error) console.error('main.js [' + name + ']', err);
    }
  }
  function init() {
    safe('reveal', initReveal);
    safe('theme', initTheme);
    safe('progress', initProgress);
    safe('pointer', initPointer);
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init);
  else init();
})();
