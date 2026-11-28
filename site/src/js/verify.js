/* =====================================================================
   verify.js — صفحة /verify/ العامة: التحقق من شهادة إتمام دورة برمزها (الترحيل 022)
   الاستدعاء بلا جلسة: Platform.rest.rpcPublic('cert_verify', {p_code}) (دور anon). الدالة تعيد الاسم والدورة والتاريخ وحالة الإلغاء فقط.
   يُقبل الرمز من الحقل أو من الرابط ‎?code=AD-XXXXXXXXXX‎ (يُتحقق منه تلقائيًا). كل نص يدخل الصفحة بـ textContent.
   ===================================================================== */
(function () {
  'use strict';

  const P = window.Platform;
  if (!P) return;
  const h = P.ui.h;
  const form = document.getElementById('vf');
  const input = document.getElementById('vcode');
  const go = document.getElementById('vgo');
  const res = document.getElementById('vres');
  if (!form || !input || !res) return;
  const RE = /^AD-[A-Z2-9]{10}$/;
  let busy = false;

  function show(node) { while (res.firstChild) res.removeChild(res.firstChild); if (node) res.appendChild(node); }
  const box = function (cls, children) { return h('div', { class: 'pf-block ' + cls }, children); };

  async function check(raw) {
    const code = String(raw || '').trim().toUpperCase();
    input.value = code;
    if (!RE.test(code)) { show(box('', [h('p', { class: 'pf-msg err', role: 'alert', text: 'الرمز غير صحيح الصيغة. يبدأ بـ AD- ثم ١٠ أحرف وأرقام.' })])); return; }
    if (busy) return;
    busy = true;
    go.disabled = true;
    show(box('', [h('p', { class: 'pf-loading', role: 'status', text: 'جارٍ التحقق…' })]));
    try {
      const r = await P.rest.rpcPublic('cert_verify', { p_code: code });
      if (!r || !r.found) {
        show(box('', [h('p', { class: 'pf-msg err', role: 'alert', text: 'لا توجد شهادة بهذا الرمز. تأكد من كتابته كما هو مطبوع على الشهادة.' })]));
      } else if (r.valid) {
        show(box('pf-result', [
          h('b', { text: 'شهادة صحيحة ✓' }),
          h('p', { dir: 'auto' }, 'تشهد المنصة بأن ', h('b', { text: r.holder }), ' أتمّ دورة ', h('b', { text: r.course }), '.'),
          h('p', { class: 'pf-hint', text: 'تاريخ الإصدار: ' + P.fmtDate(r.issued_at) + ' · الرمز: ' + r.code }),
          h('p', { class: 'pf-hint', text: 'شهادة إتمام دورة صادرة من منصة م. أحمد الديب، وليست شهادة صادرة عن PMI.' })]));
      } else {
        show(box('', [h('p', { class: 'pf-msg err', role: 'alert' }, 'هذه الشهادة ', h('b', { text: 'مُلغاة' }), ' ولم تعد صالحة.'),
          h('p', { class: 'pf-hint', dir: 'auto', text: r.holder + ' · ' + r.course + ' · أُلغيت في ' + P.fmtDate(r.revoked_at) })]));
      }
    } catch (err) {
      show(box('', [h('p', { class: 'pf-msg err', role: 'alert', text: err instanceof P.ApiError ? err.message : P.MSG.other })]));
    } finally {
      busy = false;
      go.disabled = false;
    }
  }

  form.addEventListener('submit', function (e) { e.preventDefault(); check(input.value); });
  try {
    const q = new URLSearchParams(window.location.search).get('code');
    if (q) check(q);
  } catch (e) { /* تجاهل */ }
})();
