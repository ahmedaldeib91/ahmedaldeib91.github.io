/* nav-menu.js — القوائم المنسدلة في الهيدر: نقر/لمس يفتح ويغلق (aria-expanded)، Esc والنقر خارجًا يغلقان. بلا اعتماد على غيره. */
(function () {
  'use strict';
  var dds = document.querySelectorAll('#nav .dd');
  if (!dds.length) return;
  function closeAll(except) {
    Array.prototype.forEach.call(dds, function (d) {
      if (d === except) return;
      d.classList.remove('open');
      d.querySelector('.ddb').setAttribute('aria-expanded', 'false');
    });
  }
  Array.prototype.forEach.call(dds, function (d) {
    var b = d.querySelector('.ddb');
    b.addEventListener('click', function () {
      var open = !d.classList.contains('open');
      closeAll(d);
      d.classList.toggle('open', open);
      b.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  });
  document.addEventListener('click', function (e) { if (!e.target.closest || !e.target.closest('#nav .dd')) closeAll(null); });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    var o = document.querySelector('#nav .dd.open .ddb');
    closeAll(null);
    if (o) o.focus();
  });
})();
