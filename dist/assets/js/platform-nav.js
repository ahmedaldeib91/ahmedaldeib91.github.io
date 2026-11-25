/* =====================================================================
   platform-nav.js — رابط الحساب في الترويسة والفوتر (ملف عادي: ES5 بلا وحدات ولا مكتبات)
   يُحمَّل بـ defer من head.html في كل صفحة. كل عنصر يحمل data-auth-link:
     - بلا جلسة دخول:  «التسجيل / الدخول»  ←  /account/   (هذا هو المكتوب في القالب أصلًا)
     - مع جلسة دخول:   «لوحتي»              ←  /dashboard/
   يقرأ مفتاح الجلسة plat_session من localStorage للتحقق من وجودها فقط (لا يستعمل التوكن ولا يتصل بالشبكة)،
   ويتابع تسجيل الدخول والخروج في تبويبات أخرى (حدث storage) وعودة الصفحة من الذاكرة السريعة (pageshow).
   إن حُجب التخزين بقي الرابط على حاله: «التسجيل / الدخول».
   ===================================================================== */
(function () {
  'use strict';

  var KEY = 'plat_session'; /* المفتاح نفسه في platform-api.js */
  var OFF = { text: 'التسجيل / الدخول', href: '/account/' };
  var ON = { text: 'لوحتي', href: '/dashboard/' };

  function signedIn() {
    try {
      var s = JSON.parse(window.localStorage.getItem(KEY));
      return !!(s && typeof s.access_token === 'string' && typeof s.refresh_token === 'string');
    } catch (e) { return false; }
  }

  function apply() {
    var v = signedIn() ? ON : OFF;
    var list = document.querySelectorAll('[data-auth-link]');
    for (var i = 0; i < list.length; i++) {
      if (list[i].textContent !== v.text) list[i].textContent = v.text;
      if (list[i].getAttribute('href') !== v.href) list[i].setAttribute('href', v.href);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply);
  else apply();
  window.addEventListener('storage', function (e) { if (e.key === KEY || e.key === null) apply(); });
  window.addEventListener('pageshow', function (e) { if (e.persisted) apply(); });
})();
