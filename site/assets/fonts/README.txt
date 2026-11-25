الخطوط المحلية (assets\fonts)
==============================

الموقع يخدم خطوطه الأربعة بنفسه: لا يتصل متصفح الزائر بخوادم Google لتحميلها (لا fonts.googleapis.com ولا fonts.gstatic.com).
تُنسخ ملفات هذا المجلد كما هي إلى dist\assets\fonts عند تشغيل build.bat، عدا هذا الملف README.txt فلا يُنسخ.
تعريفات @font-face كلها في src\css\fonts.css، ويحمّله src\layout\head.html قبل tokens.css. ويحمّل head.html مسبقًا (preload) ملف readex-pro-arabic.woff2 وحده لأنه خط العناوين العربية.
لا تغيّر اسم أي ملف هنا إلا إذا غيّرت اسمه كذلك في src\css\fonts.css (وفي سطر preload في head.html إن كان readex-pro-arabic.woff2).

الخطوط الأربعة
---------------
Readex Pro            خط العناوين والقوائم والأزرار (المتغيّر --fd في tokens.css). خط متغيّر: ملف واحد لكل نطاق يغطي الأوزان 400 إلى 700.
IBM Plex Sans Arabic  خط نص الصفحات (--fb). ثلاثة أوزان ثابتة 400 و500 و600: ملف لكل وزن ولكل نطاق.
Space Grotesk         الأرقام والنصوص الإنجليزية (--fn). خط متغيّر يغطي الأوزان 500 إلى 700.
Unbounded             شعار الموقع wordmark (الصنف .wm في base.css). خط متغيّر يغطي الأوزان 600 إلى 800.

الملفات (الأحجام وقت التنزيل، والمجموع 313.5 ك.ب لكل الملفات العشرة)
----------------------------------------------------------------------
readex-pro-arabic.woff2                22.3 ك.ب   Readex Pro، النطاق arabic (يُحمَّل مسبقًا)
readex-pro-latin.woff2                 30.7 ك.ب   Readex Pro، النطاق latin
ibm-plex-sans-arabic-400-arabic.woff2  41.8 ك.ب   IBM Plex Sans Arabic، وزن 400، النطاق arabic
ibm-plex-sans-arabic-400-latin.woff2   18.7 ك.ب   IBM Plex Sans Arabic، وزن 400، النطاق latin
ibm-plex-sans-arabic-500-arabic.woff2  44.2 ك.ب   IBM Plex Sans Arabic، وزن 500، النطاق arabic
ibm-plex-sans-arabic-500-latin.woff2   19.6 ك.ب   IBM Plex Sans Arabic، وزن 500، النطاق latin
ibm-plex-sans-arabic-600-arabic.woff2  44.6 ك.ب   IBM Plex Sans Arabic، وزن 600، النطاق arabic
ibm-plex-sans-arabic-600-latin.woff2   20.0 ك.ب   IBM Plex Sans Arabic، وزن 600، النطاق latin
space-grotesk-latin.woff2              21.8 ك.ب   Space Grotesk، النطاق latin
unbounded-latin.woff2                  49.7 ك.ب   Unbounded، النطاق latin
لا تحمّل الصفحة منها إلا ما تحتاجه أحرفها فعلًا (المتصفح يختار الملف بحسب unicode-range)، فالصفحة العادية تحمّل جزءًا من هذه الملفات لا كلها.

ما الذي حُفظ وما الذي حُذف
----------------------------
تقسّم Google كل خط إلى نطاقات (subsets) بحسب unicode-range.
حُفظ: arabic وlatin لـ Readex Pro وIBM Plex Sans Arabic. وlatin فقط لـ Space Grotesk وUnbounded لأنهما يُستعملان للحروف اللاتينية والأرقام.
حُذف: latin-ext وvietnamese وcyrillic وcyrillic-ext. فإن ظهرت في الموقع أحرف من هذه النطاقات (مثل حرف لاتيني مُشكَّل أو نص روسي أو فيتنامي) فسيعرضها المتصفح بخط بديل من النظام إلى أن تُضاف كتلتها وملفها (انظر «طريقة التحديث»).

الترخيص
--------
الخطوط الأربعة مرخّصة برخصة الخطوط المفتوحة SIL Open Font License الإصدار 1.1 (OFL 1.1)، كما تعرضها Google Fonts.
ملخص غير ملزم: تسمح الرخصة باستعمال الخطوط واستضافتها وتضمينها في المواقع، التجارية منها أيضًا، دون مقابل، بشرطين أساسيين: ألّا تُباع ملفات الخطوط وحدها، وأن يبقى إشعار حقوق النشر والرخصة مرافقًا للملفات. والنص الكامل المعتمد هو الذي في الرابط التالي.
نص الرخصة: https://openfontlicense.org
إشعارات حقوق النشر المضمّنة داخل ملفات الخطوط نفسها (في حقول name الداخلية، فلا تحذفها):
  IBM Plex Sans Arabic : Copyright 2019 IBM Corp. All rights reserved.
  Readex Pro           : Copyright 2019 The Readex Pro Project Authors (https://github.com/ThomasJockin/readexpro)
  Space Grotesk        : Copyright 2020 The Space Grotesk Project Authors (https://github.com/floriankarsten/space-grotesk)
  Unbounded            : Copyright 2022 The Unbounded Project Authors (https://github.com/googlefonts/unbounded)

المصدر والتاريخ
----------------
المصدر: Google Fonts (https://fonts.google.com) عبر واجهة CSS2 (fonts.googleapis.com/css2)، والملفات من fonts.gstatic.com بصيغة woff2.
تاريخ التنزيل: 2026-11-23.
إصدارات الخطوط وقت التنزيل: IBM Plex Sans Arabic 1.101 (v15 في روابط Google) ، Readex Pro 1.205 (v27) ، Space Grotesk 2.000 (v22) ، Unbounded 1.701 (v12).
الرابط الذي استُخرجت منه الكتل والملفات (افتحه في متصفح Chrome حديث ليعرض كتل @font-face بصيغة woff2 مقسّمة بحسب النطاق):
https://fonts.googleapis.com/css2?family=Readex+Pro:wght@400..700&family=IBM+Plex+Sans+Arabic:wght@400;500;600&family=Space+Grotesk:wght@500..700&family=Unbounded:wght@600..800&display=swap

طريقة التحديث (نسخة جديدة من الخطوط، أو إضافة نطاق أو وزن)
-------------------------------------------------------------
1) افتح الرابط أعلاه في Chrome (عدّل فيه الأوزان إن لزم: wght@400..700 مدى لخط متغيّر، وwght@400;500;600 قائمة أوزان لخط ثابت). ستجد كتلة @font-face لكل نطاق، يسبقها تعليق باسم النطاق مثل /* arabic */ و/* latin */.
2) لكل كتلة تحتاجها: افتح الرابط الذي في src لتنزيل ملف woff2، واحفظه في هذا المجلد باسم واضح على نمط: اسم-الخط-النطاق.woff2 للخط المتغيّر، واسم-الخط-الوزن-النطاق.woff2 للخط الثابت (مثل readex-pro-latin.woff2 وibm-plex-sans-arabic-400-arabic.woff2).
3) انسخ الكتلة إلى src\css\fonts.css، وغيّر src إلى url(/assets/fonts/الاسم.woff2) format('woff2') وأبقِ font-display: swap وانسخ unicode-range كما هو. واحذف من fonts.css ومن هذا المجلد كل كتلة وملف لم يعودا مستعملين.
4) شغّل build.bat ثم serve.bat وافتح الموقع. من أدوات المطوّر في المتصفح (تبويب Network) تأكد أن ملفات woff2 تُحمَّل من الموقع نفسه بحالة 200، وأنه لا يوجد أي طلب إلى fonts.googleapis.com أو fonts.gstatic.com.
لا تعِد إضافة رابط Google Fonts إلى src\layout\head.html: يكفي تعريف الخطوط في fonts.css.
