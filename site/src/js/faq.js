/* =====================================================================
   faq.js — خانة البحث في صفحة الأسئلة الشائعة (ملف عادي: بلا وحدات ولا مكتبات)
   يُحمَّل بـ defer من صفحة faq فقط (في آخر <main>)، وسلوكه منقول من المعاينة كما هو.
   الأسئلة السبعة والعشرون مكتوبة في HTML ثابت (لمحركات البحث)، وهذا الملف لا يضيف
   محتوى: يُظهر ويُخفي ويفتح فقط. فبلا JavaScript تبقى الأسئلة كلها ظاهرة وتُفتح بالنقر.

   عناصر الصفحة التي يقرؤها (كل بحث محروس ضد null): الحقل #faqq، والقائمة #faqList
   (مجموعات .fg في كل منها عناصر <details>)، ورسالة #faqNone.

   السلوك (كما في المعاينة)
   - النص المكتوب يُقصّ من الفراغات ويُحوَّل إلى أحرف صغيرة، والسؤال يطابقه إن ورد النص
     في أي موضع من نص السؤال وجوابه (ورقمه أيضًا).
   - المطابِق يظهر ويُفتح، وغير المطابِق يُخفى ويُغلق.
   - المجموعة التي لا يظهر فيها أي سؤال تُخفى كلها.
   - إن لم يطابق أي سؤال تظهر الرسالة «لا توجد نتائج مطابقة.».
   - الحقل الفارغ يُظهر الأسئلة كلها ولا يغيّر حالة الفتح (كما في المعاينة).
   - يضع autocomplete="off" على الحقل لئلا يستعيد المتصفح النص القديم عند الرجوع إلى الصفحة
     فيبقى الحقل مكتوبًا والقائمة غير مصفّاة.
   ===================================================================== */
(function () {
  'use strict';

  var input = document.getElementById('faqq');
  var list = document.getElementById('faqList');
  var none = document.getElementById('faqNone');
  if (!input || !list) return;

  var items = list.querySelectorAll('details');
  var groups = list.querySelectorAll('.fg');
  var haystack = [];
  var i;

  /* the list is static, so each question's searchable text (question + answer) is read once */
  for (i = 0; i < items.length; i++) haystack.push((items[i].textContent || '').toLowerCase());

  function filter() {
    var q = input.value.trim().toLowerCase();
    var shown = 0;
    var k, j, match, any, inGroup;

    for (k = 0; k < items.length; k++) {
      match = !q || haystack[k].indexOf(q) > -1;
      items[k].style.display = match ? '' : 'none';
      if (q) items[k].open = match;
      if (match) shown++;
    }

    for (k = 0; k < groups.length; k++) {
      inGroup = groups[k].querySelectorAll('details');
      any = false;
      for (j = 0; j < inGroup.length; j++) {
        if (inGroup[j].style.display !== 'none') { any = true; break; }
      }
      groups[k].style.display = any ? '' : 'none';
    }

    if (none) none.style.display = shown ? 'none' : 'block';
  }

  input.addEventListener('input', filter);

  /* on back/forward the browser restores the typed text without firing "input", which would leave the field and the list out of step;
     autocomplete="off" makes the field start empty on every visit */
  input.setAttribute('autocomplete', 'off');
})();
