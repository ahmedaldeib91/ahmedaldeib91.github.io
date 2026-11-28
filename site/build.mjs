/* =====================================================================
   build.mjs — سكربت بناء موقع م. أحمد الديب (موقع ثابت)
   Node فقط (الإصدار 18 فما فوق)، بلا أي حزم خارجية، ولا ينشئ node_modules.

   التشغيل
     node build.mjs            من مجلد site (أو انقر مرتين على build.bat)
     node build.mjs --strict   تُعامَل التنبيهات كأخطاء (للفحص قبل النشر)

   الناتج
     مجلد dist في جذر المشروع (بجانب مجلد site، لا بداخله). يُفرَّغ ويُعاد
     إنشاؤه في كل تشغيل، فلا تعدّل ملفاته يدويًا. وإن فشل البناء في مرحلة القراءة
     والتحقق بقي dist القديم كما هو.

   المصادر (كلها داخل site)
     src/pages/*.html     صفحة لكل ملف
     src/layout/*.html    القطع المشتركة (head, header, footer) وicons.svg
     src/css  src/js      تُنسخ إلى dist/assets/css و dist/assets/js
     assets/              تُنسخ إلى dist/assets (عدا README.txt)
     data/*.json          البيانات (site.json و courses.json)

   ---------------------------------------------------------------------
   1) ترويسة الصفحة — السطر الأول من كل ملف في src/pages
   ---------------------------------------------------------------------
     <!--page: slug=pmi; title=معهد PMI | م. أحمد الديب; desc=وصف الصفحة; nav=pmi-->

     slug    رابط الصفحة. الرئيسية هي slug=index (وتُقبل home) فتصير dist/index.html.
             وغيرها dist/<slug>/index.html (مثل courses/capm). أحرف لاتينية صغيرة
             وأرقام وشرطة فقط، وتُفصل المستويات بـ /
     title   عنوان التبويب كاملًا كما سيظهر، فلا يضيف القالب شيئًا إليه
     desc    وصف الصفحة لمحركات البحث
     nav     مفتاح عنصر التنقل الذي يُميَّز لهذه الصفحة (مثل courses لصفحتي CAPM وPMP)
     الحقول الأربعة إلزامية. الفاصل بينها ; وإن احتاجت القيمة إلى ; فاكتبها عادية
     (لا حاجة لتهريب). اكتب النص عاديًا: يُهرَّب (&, <, >, ") تلقائيًا عند الإدراج.
     تُحذف الترويسة من الناتج.

   ---------------------------------------------------------------------
   2) هيكل المستند — نمطان، والأول هو المعتمد
   ---------------------------------------------------------------------
     أ) نمط الجزء (الافتراضي): الصفحة بعد الترويسة هي محتوى فقط، عادةً <main>…</main>،
        والبناء يلفّها هكذا:
            {{> head}}  {{> header}}  <الصفحة>  {{> footer}}  </body></html>
        فـ head.html يفتح <!doctype> و<html lang="ar" dir="rtl"> و<head> ويغلق
        </head> ويفتح <body>. ولا تكتب أنت أي وسم هيكلي.
     ب) نمط المستند الكامل: إن ورد {{> head}} داخل الصفحة (أو بدأت بـ <!doctype>)
        اعتُبرت مستندًا كاملًا ولا يلفّها البناء، فتكتب الترتيب بنفسك:
            {{> head}}
            {{> header}}
            <main id="main"> … </main>
            {{> footer}}
            </body></html>

   ---------------------------------------------------------------------
   3) القطع المشتركة والمتغيرات (تعمل داخل الصفحات والقطع نفسها)
   ---------------------------------------------------------------------
     {{> name}}            يُدرج src/layout/name.html (وإن لم يوجد فـ name.svg).
                           تُسمح القطع المتداخلة (مثل {{> icons}} داخل header.html).
{{root}}              بادئة مسارات الموقع الداخلية والأصول. تكون /Ahmed-aldeib-platform
                       على GitHub Pages، وفارغة عند النشر على جذر النطاق.
                       اكتب الروابط هكذا: {{root}}/assets/... و {{root}}/pmi/
                       {{title}} {{desc}}    من ترويسة الصفحة
     {{canonical}}         النطاق من site.json + رابط الصفحة، مثل https://example.com/pmi/
     {{slug}} {{nav}} {{url}}   الـ slug ومفتاح التنقل ومسار الصفحة (/pmi/)
     {{site.whatsapp}}     أي مفتاح من data/site.json (والمتداخل بنقاط: {{site.socials.linkedin}})
     {{courses.courses.0.id}}   وكذلك أي ملف آخر في data (اسم الملف أولًا)
     تمييز الصفحة الحالية: أي وسم يحمل data-nav="x" يساوي nav الصفحة يُضاف إليه تلقائيًا
     aria-current="page" (مثال: <a href="/pmi/" data-nav="pmi">…</a>).

   ---------------------------------------------------------------------
   4) الحلقات والشروط ودالة json (لتوليد الصفحات من data/*.json)
   ---------------------------------------------------------------------
     {{#each courses.courses}} … {{/each}}
         يكرّر ما بين الوسمين لكل عنصر في قائمة من ملف بيانات (أول جزء في المسار هو
         اسم الملف داخل data). ويصح أن تحتوي الحلقة على {{#if}} و{{#ifeq}} وعلى حلقة
         أخرى. وداخلها تعمل هذه المتغيرات:
           {{this.titleAr}}   حقل من العنصر الحالي (this.id و this.status و this.page …).
                              غياب الحقل خطأ صريح بذكر الملف والسطر، إلا إن كُتب داخل
                              {{#if this.page}} … {{/if}} فلا يُقرأ إلا حين يوجد.
           {{@index}}         رقم العنصر ويبدأ من 0       {{@number}}   ويبدأ من 1
           {{@statusAr}}      بحسب this.status:  «متاحة الآن»  أو  «قريبًا»
           {{@ctaAr}}         «احجز مقعدك عبر واتساب»  أو  «سجّل اهتمامك عبر واتساب»
           {{@ctaShortAr}}    «احجز مقعدك»  أو  «سجّل اهتمامك»
         ويصح استعمال متغيرات @ بعد {{#if}} و{{#ifeq}} و{{json}} (مثل {{#ifeq @index "0"}}).
         والقطعة المشتركة {{> name}} المُدرجة داخل حلقة ترى this و@index أيضًا.
     {{#if this.page}} … {{else}} … {{/if}}
         يُعرض ما قبل {{else}} إن كانت قيمة الحقل صحيحة، وإلا فما بعدها ({{else}} اختيارية).
         تُعدّ القيمة غير صحيحة إن كانت غير موجودة أو null أو false أو 0 أو نصًا فارغًا
         أو قائمة فارغة، فالحقل الناقص هنا ليس خطأً. ويصلح خارج الحلقات بمسار بيانات
         مثل {{#if site.socials.youtube}} … {{/if}}
     {{#ifeq this.status "available"}} … {{else}} … {{/ifeq}}
         يقارن نص الحقل بقيمة بين علامتي اقتباس (" أو ') ويعرض الفرع المناسب.
     {{json courses.courses}}
         يطبع البيانات JSON مضغوطًا يصلح داخل <script type="application/json" id="…">،
         وتُستبدل فيه < و> و& بـ \u003c و\u003e و\u0026 فلا يمكنه إغلاق وسم script.
         لا يُهرَّب بـ HTML لأن محتوى script نص خام، فلا يوضع في خاصية ولا في نص عادي.
     {{count courses.courses}}
         يطبع عدد عناصر القائمة (مثل 6)، لأرقام ثابتة في الصفحة يجب أن تتبع البيانات.
     {{count courses.courses status "available"}}
         يطبع عدد العناصر التي يساوي فيها الحقل (هنا status) القيمة المكتوبة بين علامتي اقتباس
         (" أو ')، مثل عدد الدورات المتاحة الآن (2)، وتُقارَن كنص مثل {{#ifeq}}. العنصر الذي لا يحمل
         الحقل لا يُعدّ، وليس ذلك خطأً. وفي الحالتين يجب أن يشير المسار إلى قائمة (وإلا توقف البناء)،
         ويصح داخل الحلقات بمسار this.حقل. مثال في الصفحة الرئيسية:
         <b data-count="available">{{count courses.courses status "available"}}</b>
         فإن قلبت status لدورة في courses.json تغيّر الرقم عند البناء التالي دون أي تعديل في الصفحة.
     تُغلق كل كتلة داخل الملف نفسه الذي فُتحت فيه (صفحة أو قطعة). وأسطر وسوم الكتل
     تبقى في الناتج فارغة كما هي، فاكتب الوسوم متجاورة إن أردت ناتجًا مضغوطًا.
     مثال:
         <ul>
         {{#each courses.courses}}
           <li data-id="{{this.id}}" class="{{this.status}}">
             {{@number}}. {{this.titleAr}} ({{@statusAr}})
             {{#if this.page}}<a href="{{root}}/courses/{{this.page}}/">{{@ctaShortAr}}</a>
             {{else}}<a href="{{site.whatsapp}}">{{@ctaAr}}</a>{{/if}}
           </li>
         {{/each}}
         </ul>
         <script type="application/json" id="courses-data">{{json courses.courses}}</script>

   ---------------------------------------------------------------------
   5) الإخفاق الواضح والتنبيهات
   ---------------------------------------------------------------------
     يتوقف البناء برسالة عربية وخروج غير صفري عند: قطعة مشتركة أو مفتاح بيانات أو
     ملف/مجلد ناقص، ترويسة صفحة ناقصة أو خاطئة، JSON غير صالح، رابط slug مكرر،
     قيمة status غير available/soon في courses.json، أو شارة دورة غير موجودة.
     وكذلك عند خلل في القوالب: كتلة {{#each}} أو {{#if}} أو {{#ifeq}} لم تُغلق أو
     أُغلقت بما لا يطابقها، {{else}} في غير موضعها، this أو @ خارج حلقة، مسار
     {{#each}} أو {{count}} لا يشير إلى قائمة، صيغة {{count}} غير صحيحة، أو حقل ناقص
     داخل حلقة. وتذكر الرسالة الملف والسطر وما كان متوقعًا.
     وتُطبع تنبيهات لا توقف البناء (وتوقفه مع --strict): النطاق المؤقت example.com،
     مجلد css غير موجود بعد، ملف يُشار إليه من HTML ولا وجود له في dist، رابط
     نسبي (لا يبدأ بـ /)، صفحة فيها h1 أكثر أو أقل من واحد.
   ===================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* ---------- المسارات والثوابت ---------- */
const SITE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SITE_DIR, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const P = {
  layout: path.join(SITE_DIR, 'src', 'layout'),
  pages: path.join(SITE_DIR, 'src', 'pages'),
  css: path.join(SITE_DIR, 'src', 'css'),
  js: path.join(SITE_DIR, 'src', 'js'),
  data: path.join(SITE_DIR, 'data'),
  assets: path.join(SITE_DIR, 'assets'),
};
const STRICT = process.argv.includes('--strict');

const PAGE_KEYS = ['slug', 'title', 'desc', 'nav'];
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/;
const NAV_RE = /^[a-z0-9-]+$/;
const COURSE_STATUS = ['available', 'soon'];
const COURSE_FIELDS = ['id', 'status', 'order', 'badge', 'titleAr', 'titleEn', 'subtitleEn', 'categoryAr', 'categoryEn'];
const SKIP_FILES = new Set(['readme.txt', '.gitkeep', 'thumbs.db', 'desktop.ini', '.ds_store']);
const TPL_TAG_SRC = String.raw`\{\{([^{}]*)\}\}`; // أي وسم {{ ... }}، ويصنّفه parseTemplate (قطعة، متغير، كتلة، else، json)
const BLOCKS = ['each', 'if', 'ifeq']; // الكتل المدعومة: {{#each}} و{{#if}} و{{#ifeq}}
const HELPERS = ['index', 'number', 'statusAr', 'ctaAr', 'ctaShortAr']; // متغيرات {{@...}} داخل الحلقات
const STATUS_TEXT = { // نصوص حالة الدورة التي يشتقها {{@statusAr}} و{{@ctaAr}} و{{@ctaShortAr}} من this.status
  available: { statusAr: 'متاحة الآن', ctaAr: 'احجز مقعدك عبر واتساب', ctaShortAr: 'احجز مقعدك' },
  soon: { statusAr: 'قريبًا', ctaAr: 'سجّل اهتمامك عبر واتساب', ctaShortAr: 'سجّل اهتمامك' },
};
const REF_RE = /^(?:@[A-Za-z]+|[A-Za-z0-9_.-]+)$/; // مرجع في {{#each}} و{{#if}} و{{json}}: متغير @ أو this.حقل أو ملف.مفتاح
const TAG_RE = /<[a-zA-Z][^\s>/]*(?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>=`]+))?)*\s*\/?>/g;
const ATTR_RE_SRC = String.raw`\s([^\s"'<>/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>=` + '`' + String.raw`]+))`;
const REF_ATTRS = new Set(['href', 'src', 'poster', 'action', 'data-src']);

/* ---------- أدوات الإبلاغ ---------- */
const rel = (p) => path.relative(ROOT_DIR, p); // مثل site\src\pages\pmi.html
const log = (...a) => console.log(...a);
const warnings = [];
const warn = (msg) => warnings.push(msg);
let diskPhase = false; // هل بدأنا الكتابة في dist؟

class BuildError extends Error {
  constructor(message, details = []) {
    super(message);
    this.details = details;
  }
}
const fail = (message, ...details) => {
  throw new BuildError(message, details.flat().filter(Boolean));
};
/** ينفّذ عملية ملفات وإن فشلت تُحوَّل إلى رسالة عربية واضحة. */
function io(what, fn) {
  try {
    return fn();
  } catch (e) {
    if (e instanceof BuildError) throw e;
    fail(`تعذّر ${what}`, `السبب: ${e.message}`, 'تلميح: أغلق أي برنامج يفتح ملفات dist (المتصفح أو مستكشف الملفات أو المعاينة) ثم أعد المحاولة.');
  }
}

/* ---------- أدوات الملفات ---------- */
const exists = (p) => fs.existsSync(p);
function requireDir(dir, what) {
  let st = null;
  try { st = fs.statSync(dir); } catch { /* غير موجود */ }
  if (!st || !st.isDirectory()) fail(`المجلد غير موجود: ${what}`, `المسار المتوقع: ${rel(dir)}`);
}
function readText(file, what) {
  try {
    return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  } catch (e) {
    if (e.code === 'ENOENT') fail(`الملف غير موجود: ${what}`, `المسار المتوقع: ${rel(file)}`);
    fail(`تعذّرت قراءة الملف: ${what}`, `المسار: ${rel(file)}`, `السبب: ${e.message}`);
  }
}
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort(byName)) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}
function copyTree(srcDir, destDir) {
  let n = 0;
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true }).sort(byName)) {
    const s = path.join(srcDir, entry.name);
    const d = path.join(destDir, entry.name);
    if (entry.isDirectory()) n += copyTree(s, d);
    else if (entry.isFile() && !SKIP_FILES.has(entry.name.toLowerCase())) {
      fs.copyFileSync(s, d);
      n++;
    }
  }
  return n;
}

/* ---------- نصوص ---------- */
const escapeHtml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const escapeXml = escapeHtml;
const countNewlines = (s) => (s.match(/\n/g) || []).length;
const lineOf = (text, index) => countNewlines(text.slice(0, index)) + 1;
const visibleKeys = (obj) => Object.keys(obj).filter((k) => !k.startsWith('_'));

/* ---------- 1) البيانات ---------- */
function loadData() {
  requireDir(P.data, 'مجلد البيانات');
  const data = {};
  for (const name of fs.readdirSync(P.data).sort()) {
    if (!name.toLowerCase().endsWith('.json')) continue;
    const file = path.join(P.data, name);
    const text = readText(file, `ملف البيانات ${name}`);
    try {
      data[name.slice(0, -5)] = JSON.parse(text);
    } catch (e) {
      fail(`ملف البيانات ليس JSON صالحًا: ${rel(file)}`, `التفاصيل: ${e.message}`, 'تلميح: راجع الفواصل بين العناصر والأقواس وعلامات الاقتباس المزدوجة "".');
    }
  }
  for (const required of ['site', 'courses']) {
    if (!(required in data)) fail(`ملف البيانات المطلوب غير موجود: ${rel(path.join(P.data, required + '.json'))}`);
  }
  return data;
}

/** يتحقق من domain ويعيد أصل الموقع بلا / في النهاية. */
function normalizeDomain(site) {
  const file = rel(path.join(P.data, 'site.json'));
  const d = site && site.domain;
  if (typeof d !== 'string' || !d.trim()) fail(`الحقل domain غير موجود أو فارغ في ${file}`, 'مثال: "domain": "https://www.example.com"');
  let u;
  try { u = new URL(d.trim()); } catch { fail(`قيمة domain في ${file} ليست رابطًا صالحًا`, `القيمة الحالية: ${d}`, 'اكتبها كاملة مع https:// ثم اسم النطاق، مثل: https://www.example.com'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') fail(`قيمة domain في ${file} يجب أن تبدأ بـ https://`, `القيمة الحالية: ${d}`);
  if (/(^|\.)example\.(com|org|net)$/i.test(u.hostname)) {
    warn(`النطاق في ${file} ما زال المؤقت (${u.hostname}). غيّره إلى النطاق الحقيقي قبل النشر، فهو يدخل في canonical وsitemap.xml وrobots.txt.`);
  }
  return u.origin + u.pathname.replace(/\/+$/, '');
}

/** يتحقق من courses.json (الحقل الذي يعدّله صاحب الموقع هو status). */
function validateCourses(coursesData, pageSlugs) {
  const file = rel(path.join(P.data, 'courses.json'));
  const list = coursesData && coursesData.courses;
  if (!Array.isArray(list) || list.length === 0) fail(`المفتاح "courses" في ${file} يجب أن يكون قائمة غير فارغة من الدورات.`);
  const ids = new Set();
  list.forEach((c, i) => {
    const who = `الدورة رقم ${i + 1}${c && c.id ? ` (${c.id})` : ''}`;
    if (!c || typeof c !== 'object') fail(`${who} في ${file} ليست كائنًا صالحًا.`);
    for (const f of COURSE_FIELDS) {
      if (c[f] === undefined || c[f] === null || c[f] === '') fail(`الحقل "${f}" ناقص في ${who} داخل ${file}`);
    }
    if (!COURSE_STATUS.includes(c.status)) {
      fail(`قيمة status غير صالحة في ${who} داخل ${file}`, `القيمة الحالية: "${c.status}"`, 'المسموح فقط: available (متاحة الآن) أو soon (قريبًا) بأحرف صغيرة وبين علامتي اقتباس.');
    }
    if (ids.has(c.id)) fail(`المعرّف id مكرر في ${file}: ${c.id}`);
    ids.add(c.id);
    const badge = path.join(P.assets, 'badges', String(c.badge));
    if (!exists(badge)) fail(`ملف شارة الدورة ${c.id} غير موجود: ${c.badge}`, `المسار المتوقع: ${rel(badge)}`);
    if (c.page && !pageSlugs.has(`courses/${c.page}`)) {
      fail(`صفحة الدورة ${c.id} غير موجودة: courses/${c.page}`, `الحقل page في ${file} يشير إلى صفحة ترويستها slug=courses/${c.page}`);
    }
  });
}

/* ---------- 2) القطع المشتركة ---------- */
function loadPartials() {
  requireDir(P.layout, 'مجلد القطع المشتركة');
  const map = new Map();
  for (const ext of ['html', 'svg']) { // html له الأولوية
    for (const name of fs.readdirSync(P.layout).sort()) {
      const m = /^([A-Za-z0-9_-]+)\.(html|svg)$/.exec(name);
      if (!m || m[2] !== ext || map.has(m[1])) continue;
      const file = path.join(P.layout, name);
      map.set(m[1], { file, text: readText(file, `القطعة المشتركة ${name}`) });
    }
  }
  return map;
}

/* ---------- 3) الصفحات ---------- */
function parsePageHeader(raw, file) {
  const m = /^\s*<!--\s*page\s*:([\s\S]*?)-->/.exec(raw);
  const where = `الملف: ${rel(file)}`;
  if (!m) fail('الصفحة لا تبدأ بسطر الترويسة <!--page: ...-->', where, 'مثال: <!--page: slug=pmi; title=معهد PMI; desc=وصف الصفحة; nav=pmi-->');
  const fields = {};
  let current = null;
  for (const part of m[1].split(';')) {
    const kv = /^\s*([A-Za-z_][\w-]*)\s*=([\s\S]*)$/.exec(part);
    if (kv) {
      const key = kv[1].toLowerCase();
      if (!PAGE_KEYS.includes(key)) fail(`حقل غير معروف في ترويسة الصفحة: ${kv[1]}`, where, `الحقول المسموحة: ${PAGE_KEYS.join(' ، ')}`);
      if (key in fields) fail(`الحقل ${key} مكرر في ترويسة الصفحة`, where);
      fields[key] = kv[2];
      current = key;
    } else if (current) {
      fields[current] += ';' + part; // فاصلة منقوطة داخل القيمة
    } else if (part.trim()) {
      fail(`ترويسة الصفحة غير مفهومة قرب: «${part.trim()}»`, where, 'كل حقل بصيغة اسم=قيمة ويفصل بينها ;');
    }
  }
  for (const k of PAGE_KEYS) {
    fields[k] = (fields[k] ?? '').trim();
    if (!fields[k]) fail(`الحقل ${k} ناقص أو فارغ في ترويسة الصفحة`, where);
  }
  return { fields, headerLength: m[0].length };
}

function loadPages(origin) {
  requireDir(P.pages, 'مجلد الصفحات');
  const files = walk(P.pages).filter((f) => f.toLowerCase().endsWith('.html'));
  if (files.length === 0) fail('لا توجد أي صفحة داخل المجلد', `المسار: ${rel(P.pages)}`);
  const pages = [];
  const seen = new Map();
  for (const file of files) {
    const raw = readText(file, `الصفحة ${path.basename(file)}`);
    const { fields, headerLength } = parsePageHeader(raw, file);
    const where = `الملف: ${rel(file)}`;

    let slug = fields.slug.replace(/^\/+|\/+$/g, '');
    if (slug === 'home') slug = 'index';
    if (slug !== 'index' && !SLUG_RE.test(slug)) {
      fail(`قيمة slug غير صالحة: ${fields.slug}`, where, 'المسموح: أحرف لاتينية صغيرة وأرقام وشرطة (-)، وتُفصل المستويات بـ / مثل courses/capm');
    }
    if (slug === 'assets' || slug.startsWith('assets/')) fail('قيمة slug لا يجوز أن تبدأ بـ assets لأنه مجلد الأصول', where);
    if (!NAV_RE.test(fields.nav)) fail(`قيمة nav غير صالحة: ${fields.nav}`, where, 'المسموح: أحرف لاتينية صغيرة وأرقام وشرطة (-)');

    const isHome = slug === 'index';
    const outFile = isHome ? path.join(DIST_DIR, 'index.html') : slug === '404' ? path.join(DIST_DIR, '404.html') : path.join(DIST_DIR, ...slug.split('/'), 'index.html'); /* 404: يخدمها GitHub Pages لأي رابط غير موجود */
    const urlPath = isHome ? '/' : `/${slug}/`;
    if (seen.has(urlPath)) fail(`صفحتان لهما الرابط نفسه ${urlPath}`, `الأولى: ${rel(seen.get(urlPath))}`, `الثانية: ${rel(file)}`);
    seen.set(urlPath, file);

    const afterHeader = raw.slice(headerLength);
    const body = afterHeader.replace(/^(?:[ \t]*\n)+/, '');
    const lineBase = countNewlines(raw.slice(0, raw.length - body.length));
    const isFull = /^(?:\s|<!--[\s\S]*?-->)*<!doctype/i.test(body) || /\{\{\s*>\s*head\s*\}\}/.test(body);
    pages.push({ file, label: rel(file), slug, nav: fields.nav, title: fields.title, desc: fields.desc, urlPath, outFile, canonical: origin + urlPath, body, lineBase, isFull });
  }
  pages.sort((a, b) => (a.slug === 'index' ? -1 : b.slug === 'index' ? 1 : a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  return pages;
}

/* ---------- 4) القوالب ---------- */
const TAG_FORMS = 'الصيغ المدعومة: {{#each مسار}} … {{/each}} ، {{#if مسار}} … {{else}} … {{/if}} ، {{#ifeq مسار "قيمة"}} … {{/ifeq}} ، {{json مسار}} ، {{count مسار}} ، {{count مسار حقل "قيمة"}} ، {{@index}}';
const COUNT_FORMS = 'الصيغتان الصحيحتان: {{count مسار}} لعدد عناصر قائمة، و{{count مسار حقل "قيمة"}} لعدد العناصر التي يساوي فيها الحقل القيمة، مثل {{count courses.courses status "available"}}';
const isObj = (v) => v !== null && typeof v === 'object';
const typeName = (v) => (v === undefined ? 'غير موجودة' : v === null ? 'فارغة (null)' : Array.isArray(v) ? 'قائمة' : isObj(v) ? 'مجموعة مفاتيح' : typeof v === 'string' ? 'نص' : typeof v === 'number' ? 'رقم' : 'قيمة منطقية');
/** موضع وسم داخل قالب (الملف والسطر)؛ لا يُحسب رقم السطر إلا عند الحاجة إليه. */
const whereOf = (tpl, offset) => `الموضع: ${tpl.label} (السطر ${tpl.lineBase + lineOf(tpl.text, offset)})`;
/** وصف الحلقة والعنصر الحالي لرسائل الخطأ (رقم العنصر يبدأ من 1 مثل {{@number}}). */
const loopInfo = (s) => `الحلقة: ${s.shown} (العنصر رقم ${s.index + 1}${isObj(s.item) && typeof s.item.id === 'string' ? ` ، id: ${s.item.id}` : ''})`;
/** صحة القيمة في {{#if}}: غير صحيحة إن كانت غير موجودة أو null أو false أو 0 أو نصًا فارغًا أو قائمة فارغة. */
const isTruthy = (v) => (Array.isArray(v) ? v.length > 0 : Boolean(v));
const equalsText = (v, literal) => v !== undefined && v !== null && typeof v !== 'object' && String(v) === literal;
/** JSON مضغوط آمن داخل <script type="application/json">: تُستبدل < و> و& (وفاصلا السطر U+2028 وU+2029) برموز \uXXXX فلا يُغلق وسم script أبدًا. */
const jsonForScript = (value) => JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

/** يحوّل نص القالب إلى شجرة عقد، ويتحقق من الكتل (فتح وإغلاق وelse) فيفشل برسالة عربية بالملف والسطر. */
function parseTemplate(text, label, lineBase) {
  const tpl = { text, label, lineBase, nodes: null };
  const at = (offset) => whereOf(tpl, offset);
  const lineNo = (offset) => lineBase + lineOf(text, offset);
  const frames = [{ nodes: [] }]; // الأول جذر القالب، ولكل كتلة مفتوحة إطار فوقه
  const cur = () => frames[frames.length - 1];
  const addText = (from, to) => {
    if (to <= from) return;
    const value = text.slice(from, to);
    const bad = /\{\{\s*[#\/@]/.exec(value); // بداية وسم كتلة أو متغير @ لم يُغلق بـ }}
    if (bad) fail('وسم قالب غير مكتمل (ينقصه }} أو فيه أقواس معقوفة زائدة)', at(from + bad.index), `قرب: ${value.slice(bad.index, bad.index + 40).replace(/\s+/g, ' ')}`, TAG_FORMS);
    cur().nodes.push({ type: 'text', value });
  };
  const checkRef = (ref, shown, offset) => {
    if (ref[0] === '@' && !HELPERS.includes(ref.slice(1))) {
      fail(`متغير مساعد غير معروف: ${shown}`, at(offset), `المتاحة داخل الحلقات: ${HELPERS.map((h) => `{{@${h}}}`).join(' ، ')}`);
    }
  };

  const re = new RegExp(TPL_TAG_SRC, 'g');
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    addText(last, m.index);
    last = m.index + m[0].length;
    const offset = m.index;
    const body = m[1].trim();
    const shown = `{{${body}}}`;
    const parent = cur();
    let mm;
    if ((mm = /^>\s*([A-Za-z0-9_-]+)$/.exec(body))) {
      parent.nodes.push({ type: 'partial', name: mm[1], offset });
    } else if (body === 'else') {
      if (frames.length === 1 || parent.kind === 'each') {
        fail('{{else}} في غير موضعها', at(offset),
          frames.length === 1 ? 'لا توجد كتلة {{#if}} أو {{#ifeq}} مفتوحة قبلها.' : `أقرب كتلة مفتوحة هي ${parent.shown} (السطر ${lineNo(parent.offset)}) ولا تدعم {{else}}.`,
          'المتوقع: {{else}} داخل {{#if}} أو {{#ifeq}} فقط.');
      }
      if (parent.inElse) fail('{{else}} مكررة في الكتلة نفسها', at(offset), `الكتلة: ${parent.shown} (السطر ${lineNo(parent.offset)})`, 'يُسمح بفرع {{else}} واحد فقط لكل كتلة.');
      parent.inElse = true;
      parent.nodes = parent.node.else;
    } else if (/^else\s/.test(body)) {
      fail(`الصيغة ${shown} غير مدعومة`, at(offset), 'اكتب {{else}} وحدها، وللشرط المتسلسل ضع {{#if}} جديدة داخل الفرع.');
    } else if (body === 'json') {
      fail('المسار ناقص في {{json}}', at(offset), 'الصيغة الصحيحة: {{json مسار}} مثل {{json courses.courses}}');
    } else if (body === 'count') {
      fail('المسار ناقص في {{count}}', at(offset), COUNT_FORMS);
    } else if (/^[A-Za-z0-9_.-]+$/.test(body)) {
      parent.nodes.push({ type: 'var', ref: body, offset });
    } else if (body[0] === '@') {
      if (!/^@[A-Za-z]+$/.test(body)) fail(`صيغة المتغير المساعد غير صحيحة: ${shown}`, at(offset), `المتاحة داخل الحلقات: ${HELPERS.map((h) => `{{@${h}}}`).join(' ، ')}`);
      checkRef(body, shown, offset);
      parent.nodes.push({ type: 'var', ref: body, offset });
    } else if (/^json\s/.test(body)) {
      const ref = body.slice(4).trim();
      if (!REF_RE.test(ref)) fail(`صيغة {{json}} غير صحيحة: ${shown}`, at(offset), 'الصيغة الصحيحة: {{json مسار}} مثل {{json courses.courses}}');
      checkRef(ref, shown, offset);
      parent.nodes.push({ type: 'json', ref, offset });
    } else if (/^count\s/.test(body)) {
      const cm = /^count\s+([A-Za-z0-9_.-]+)(?:\s+([A-Za-z0-9_-]+)\s+(?:"([^"]*)"|'([^']*)'))?$/.exec(body);
      if (!cm) fail(`صيغة {{count}} غير صحيحة: ${shown}`, at(offset), COUNT_FORMS);
      parent.nodes.push({ type: 'count', ref: cm[1], field: cm[2] ?? null, literal: cm[3] ?? cm[4] ?? '', offset });
    } else if (body[0] === '#') {
      const mo = /^#([A-Za-z]+)(?:\s+([\s\S]*))?$/.exec(body);
      if (!mo || !BLOCKS.includes(mo[1])) {
        fail(`كتلة غير معروفة أو صيغتها غير صحيحة: ${shown}`, at(offset), `الكتل المدعومة: ${BLOCKS.map((b) => `{{#${b} …}}`).join(' ، ')}`, TAG_FORMS);
      }
      const kind = mo[1];
      const args = (mo[2] ?? '').trim();
      let node;
      if (kind === 'ifeq') {
        const am = /^(@[A-Za-z]+|[A-Za-z0-9_.-]+)\s+(?:"([^"]*)"|'([^']*)')$/.exec(args);
        if (!am) fail(`صيغة {{#ifeq}} غير صحيحة: ${shown}`, at(offset), 'الصيغة الصحيحة: {{#ifeq مسار "قيمة"}} مثل {{#ifeq this.status "available"}} (القيمة بين علامتي اقتباس).');
        checkRef(am[1], shown, offset);
        node = { type: 'ifeq', ref: am[1], literal: am[2] ?? am[3], then: [], else: [], offset };
      } else {
        if (!REF_RE.test(args)) fail(`صيغة {{#${kind}}} غير صحيحة: ${shown}`, at(offset), `الصيغة الصحيحة: {{#${kind} مسار}} مثل ${kind === 'each' ? '{{#each courses.courses}}' : '{{#if this.page}}'}`);
        checkRef(args, shown, offset);
        node = kind === 'each' ? { type: 'each', ref: args, body: [], offset } : { type: 'if', ref: args, then: [], else: [], offset };
      }
      parent.nodes.push(node);
      frames.push({ kind, node, nodes: node.body ?? node.then, offset, shown, inElse: false });
    } else if (body[0] === '/') {
      const kind = body.slice(1);
      if (!BLOCKS.includes(kind)) fail(`وسم إغلاق غير معروف: ${shown}`, at(offset), `المسموح: ${BLOCKS.map((b) => `{{/${b}}}`).join(' ، ')}`);
      if (frames.length === 1) fail(`إغلاق بلا فتح: ${shown}`, at(offset), `لا توجد كتلة مفتوحة قبله. المتوقع أن يسبقه {{#${kind} …}} في الملف نفسه، أو احذف هذا الإغلاق.`);
      if (parent.kind !== kind) fail(`الإغلاق ${shown} لا يطابق الكتلة المفتوحة ${parent.shown}`, at(offset), `الكتلة المفتوحة بدأت في السطر ${lineNo(parent.offset)}`, `المتوقع هنا: {{/${parent.kind}}} (أغلق الكتل الداخلية أولًا).`);
      frames.pop();
    } else {
      parent.nodes.push({ type: 'text', value: m[0] }); // وسم غير معروف يبقى نصًا كما كان، ويلتقطه فحص الناتج
    }
  }
  addText(last, text.length);
  if (frames.length > 1) {
    const open = cur();
    fail(`الكتلة ${open.shown} لم تُغلق`, at(open.offset),
      `المتوقع: {{/${open.kind}}} قبل نهاية الملف (تُغلق كل كتلة داخل الملف الذي فُتحت فيه).`,
      frames.length > 2 ? `وهناك ${frames.length - 2} كتلة أخرى لم تُغلق قبلها.` : '');
  }
  tpl.nodes = frames[0].nodes;
  return tpl;
}

/** قيمة متغير @ داخل الحلقة. statusAr وctaAr وctaShortAr تُشتق من this.status. */
function helperValue(name, shown, scope, where) {
  if (!scope) fail(`المتغير ${shown} لا يعمل إلا داخل {{#each}}`, where(), 'ضعه بين {{#each مسار}} و{{/each}}، أو اكتب المسار الكامل من ملف البيانات خارج الحلقة.');
  if (name === 'index') return scope.index;
  if (name === 'number') return scope.index + 1;
  const status = isObj(scope.item) && Object.hasOwn(scope.item, 'status') ? scope.item.status : undefined;
  const allowed = `المسموح فقط: ${Object.keys(STATUS_TEXT).join(' أو ')} بأحرف صغيرة.`;
  if (status === undefined) fail(`الحقل status ناقص في عنصر الحلقة، وهو لازم لـ ${shown}`, where(), loopInfo(scope), scope.file ? `الملف: ${scope.file}` : '', allowed);
  if (!Object.hasOwn(STATUS_TEXT, status)) fail(`قيمة status غير صالحة لـ ${shown}`, where(), loopInfo(scope), `القيمة الحالية: "${status}"`, allowed);
  return STATUS_TEXT[status][name];
}

/**
 * يحلّ مرجعًا ويعيد قيمته الخام: @helper، أو this.حقل داخل الحلقة، أو متغير جاهز، أو ملف.مفتاح من data.
 * optional=true (للشروط): الحقل الناقص يعيد undefined بدل الخطأ، أما الاسم الأول المجهول فخطأ دائمًا.
 */
function resolveRef(ref, shown, ctx, scope, where, optional = false) {
  if (ref[0] === '@') return helperValue(ref.slice(1), shown, scope, where);
  if (Object.hasOwn(ctx.vars, ref)) return ctx.vars[ref];
  const segs = ref.split('.');
  const top = segs[0];
  let cur;
  if (top === 'this') {
    if (!scope) fail(`${shown} لا تعمل إلا داخل {{#each}}`, where(), 'خارج الحلقة اكتب المسار الكامل من ملف البيانات، مثل {{site.whatsapp}} أو {{courses.courses.0.titleAr}}');
    cur = scope.item;
  } else if (Object.hasOwn(ctx.data, top)) {
    cur = ctx.data[top];
  } else {
    fail(`متغير غير معروف: ${shown}`, where(), `المتغيرات الجاهزة: ${Object.keys(ctx.vars).join(' ، ')}`, `وملفات البيانات: ${Object.keys(ctx.data).join(' ، ')} (مثل {{site.whatsapp}})`,
      scope && isObj(scope.item) && Object.hasOwn(scope.item, top) ? `تلميح: داخل الحلقة اكتب this.${top} لقراءة حقل العنصر الحالي.` : '');
  }
  let walked = top;
  for (const seg of segs.slice(1)) {
    if (isObj(cur) && Object.hasOwn(cur, seg)) {
      cur = cur[seg];
      walked += '.' + seg;
    } else if (optional) {
      return undefined;
    } else {
      const avail = isObj(cur) ? visibleKeys(cur).join(' ، ') : '';
      if (top === 'this') {
        fail(`الحقل غير موجود في عنصر الحلقة: ${shown}`, where(), loopInfo(scope), scope.file ? `الملف: ${scope.file}` : '',
          `المفتاح الناقص: ${seg}${walked === 'this' ? '' : ` (بعد ${walked})`}`, avail ? `المفاتيح المتاحة هنا: ${avail}` : '',
          `إن كان الحقل اختياريًا في بعض العناصر فاحمه بـ {{#if ${ref}}} … {{/if}}، وإلا فأضفه أو صحّح اسمه في ملف البيانات.`);
      }
      fail(`مفتاح غير موجود في البيانات: ${shown}`, where(), `الملف: ${rel(path.join(P.data, top + '.json'))}`, `المفتاح الناقص: ${seg} (بعد ${walked})`, avail ? `المفاتيح المتاحة هناك: ${avail}` : '');
    }
  }
  return cur;
}

/** يحوّل قيمة إلى نص للإدراج المباشر: النص والرقم والقيمة المنطقية فقط (لا null ولا قائمة ولا كائن). */
function scalarText(value, shown, where) {
  if (value === null || typeof value === 'object') {
    fail(`القيمة ${shown} ليست نصًا أو رقمًا (فارغة أو مجموعة مفاتيح)`, where(), 'اكتب المفتاح الكامل الذي يحمل نصًا، مثل {{site.socials.linkedin}}');
  }
  return String(value);
}

/** يعرض عقد القالب. scope هو الحلقة الحالية { item, index, shown, file } أو null خارج الحلقات. */
function renderNodes(tpl, nodes, ctx, stack, scope) {
  let out = '';
  for (const n of nodes) {
    if (n.type === 'text') { out += n.value; continue; }
    const where = () => whereOf(tpl, n.offset);
    if (n.type === 'partial') {
      const p = ctx.partials.get(n.name);
      if (!p) {
        fail(`القطعة المشتركة غير موجودة: {{> ${n.name}}}`, where(),
          `الملف المتوقع: ${rel(path.join(P.layout, n.name + '.html'))} (أو ${n.name}.svg)`,
          `القطع المتاحة: ${[...ctx.partials.keys()].join(' ، ') || 'لا شيء'}`);
      }
      if (stack.includes(n.name) || stack.length >= 10) fail(`قطعة مشتركة تستدعي نفسها (حلقة لا نهائية): ${[...stack, n.name].join(' > ')}`, where());
      p.tpl ??= parseTemplate(p.text.replace(/\n+$/, ''), rel(p.file), 0);
      out += renderNodes(p.tpl, p.tpl.nodes, ctx, [...stack, n.name], scope); // القطعة داخل حلقة ترى this و@index
    } else if (n.type === 'var') {
      const shown = `{{${n.ref}}}`;
      out += escapeHtml(scalarText(resolveRef(n.ref, shown, ctx, scope, where), shown, where));
    } else if (n.type === 'json') {
      out += jsonForScript(resolveRef(n.ref, `{{json ${n.ref}}}`, ctx, scope, where));
    } else if (n.type === 'count') {
      const shown = n.field === null ? `{{count ${n.ref}}}` : `{{count ${n.ref} ${n.field} "${n.literal}"}}`;
      const list = resolveRef(n.ref, shown, ctx, scope, where);
      if (!Array.isArray(list)) fail(`المسار ${shown} لا يشير إلى قائمة`, where(), `نوع القيمة الحالية: ${typeName(list)}`, 'المطلوب: قائمة (مصفوفة) في ملف البيانات، مثل {{count courses.courses}}');
      out += String(n.field === null ? list.length : list.filter((item) => isObj(item) && Object.hasOwn(item, n.field) && equalsText(item[n.field], n.literal)).length);
    } else if (n.type === 'each') {
      const shown = `{{#each ${n.ref}}}`;
      const list = resolveRef(n.ref, shown, ctx, scope, where);
      if (!Array.isArray(list)) fail(`المسار ${shown} لا يشير إلى قائمة`, where(), `نوع القيمة الحالية: ${typeName(list)}`, 'المطلوب: قائمة (مصفوفة) في ملف البيانات، مثل {{#each courses.courses}}');
      const top = n.ref.split('.')[0];
      const file = top === 'this' ? (scope ? scope.file : null) : Object.hasOwn(ctx.data, top) ? rel(path.join(P.data, top + '.json')) : null;
      list.forEach((item, index) => { out += renderNodes(tpl, n.body, ctx, stack, { item, index, shown, file }); });
    } else { // if أو ifeq: الحقل الناقص يعني «غير صحيح» وليس خطأ
      const shown = n.type === 'if' ? `{{#if ${n.ref}}}` : `{{#ifeq ${n.ref} "${n.literal}"}}`;
      const v = resolveRef(n.ref, shown, ctx, scope, where, true);
      const yes = n.type === 'if' ? isTruthy(v) : equalsText(v, n.literal);
      out += renderNodes(tpl, yes ? n.then : n.else, ctx, stack, scope);
    }
  }
  return out;
}

/** يحلّل القالب ثم يعرضه (مستوى الصفحة والقطع). */
function render(text, label, ctx, stack, lineBase) {
  const tpl = parseTemplate(text, label, lineBase);
  return renderNodes(tpl, tpl.nodes, ctx, stack, null);
}

/** يضيف aria-current="page" لكل وسم data-nav يطابق nav الصفحة. */
function markCurrentNav(html, nav) {
  return html.replace(TAG_RE, (tag) => {
    const m = /\sdata-nav\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(tag);
    if (!m || (m[1] ?? m[2]) !== nav || /\saria-current\s*=/.test(tag)) return tag;
    return tag.replace(/\s*(\/?)>$/, ' aria-current="page"$1>');
  });
}

function renderPage(page, data, partials) {
  const ctx = {
    data,
    partials,
    vars: {
      root: data.site.basePath || '',
      title: page.title,
      desc: page.desc,
      canonical: page.canonical,
      slug: page.slug,
      nav: page.nav,
      url: page.urlPath
    },
  };

  const source = page.isFull
    ? page.body
    : '{{> head}}\n{{> header}}\n' +
      page.body +
      '\n{{> footer}}\n</body></html>';

  let html = render(source, page.label, ctx, [], page.lineBase);

  html = markCurrentNav(html, page.nav);



  /* فحوص سلامة المستند الناتج */
  const loc = `الصفحة: ${page.label}`;
  const count = (re) => (html.match(re) || []).length;
  if (!/^(?:\s|<!--[\s\S]*?-->)*<!doctype html>/i.test(html)) fail('المستند الناتج لا يبدأ بـ <!doctype html>', loc, 'تأكد أن القطعة head.html تبدأ به وأن {{> head}} أول شيء في الصفحة.');
  if (count(/<!doctype/gi) !== 1) fail('وُجد أكثر من <!doctype> واحد في المستند الناتج', loc, 'غالبًا استُدعيت {{> head}} مرتين، أو كُتب <!doctype> داخل صفحة تُلفّ تلقائيًا.');
  if (count(/<\/html>/gi) !== 1) fail('المستند الناتج يجب أن ينتهي بـ </html> مرة واحدة فقط', loc, 'في نمط المستند الكامل اختم الصفحة بـ </body></html>.');
  const stray = /\{\{\s*[>\w]/.exec(html);
  if (stray) fail('علامة قالب غير مكتملة أو خاطئة ظلّت في الناتج', loc, `قرب: ${html.slice(stray.index, stray.index + 40).replace(/\s+/g, ' ')}`, 'الصيغ الصحيحة: {{> name}} و {{site.key}} بلا مسافات داخل الاسم.');
  const h1 = count(/<h1[\s>]/gi);
  if (h1 !== 1) warn(`في الصفحة ${page.label} عدد عناوين h1 هو ${h1} (المطلوب واحد بالضبط).`);
  return html;
}

/* ---------- 5) الكتابة والنسخ والتوليد ---------- */
function wipeDist() {
  io('تفريغ مجلد dist', () => {
    fs.mkdirSync(DIST_DIR, { recursive: true });
    for (const name of fs.readdirSync(DIST_DIR)) {
      fs.rmSync(path.join(DIST_DIR, name), { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
    }
  });
}

function sitemapXml(pages, origin) {
  const urls = pages.filter((p) => p.slug !== '404').map((p) => `  <url><loc>${escapeXml(origin + p.urlPath)}</loc></url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}
const robotsTxt = (origin) => `User-agent: *\nAllow: /\n\nSitemap: ${origin}/sitemap.xml\n`;


/** يفحص الملفات المشار إليها من HTML داخل dist (تنبيهات فقط). */
function checkReferences(pages, basePath = '') {
  const missing = new Map();
  const relative = new Map();
  const add = (map, url, page) => (map.get(url) ?? map.set(url, new Set()).get(url)).add(page.slug);

  const base = String(basePath || '').replace(/\/+$/, '');

  for (const page of pages) {
    for (const tag of page.html.match(TAG_RE) || []) {
      const attrs = new RegExp(ATTR_RE_SRC, 'g');
      let m;

      while ((m = attrs.exec(tag))) {
        const name = m[1].toLowerCase();
        const value = (m[2] ?? m[3] ?? m[4] ?? '').trim();
        const urls = name === 'srcset'
          ? value.split(',').map((s) => s.trim().split(/\s+/)[0])
          : REF_ATTRS.has(name) ? [value] : [];

        for (const u of urls) {
          if (!u || /^[a-z][a-z0-9+.-]*:/i.test(u) || u.startsWith('//') || u.startsWith('#') || u.startsWith('?')) continue;
          if (!u.startsWith('/')) {
            add(relative, u, page);
            continue;
          }

          let p = u.split(/[?#]/)[0];
          try { p = decodeURIComponent(p); } catch { /* يبقى كما هو */ }

          if (base && (p === base || p.startsWith(base + '/'))) {
            p = p.slice(base.length) || '/';
          }

          const segs = p.split('/').filter(Boolean);
          const target = path.join(DIST_DIR, ...segs.filter((s) => s !== '..'));

          const ok = !segs.includes('..') && (
            p.endsWith('/') || segs.length === 0
              ? exists(path.join(target, 'index.html'))
              : exists(target) && (
                  fs.statSync(target).isFile() ||
                  exists(path.join(target, 'index.html'))
                )
          );

          if (!ok) add(missing, u, page);
        }
      }
    }
  }

  const where = (set) => {
    const l = [...set];
    return `${l.length} صفحة: ${l.slice(0, 3).join('، ')}${l.length > 3 ? '، …' : ''}`;
  };

  for (const [u, set] of missing) {
    warn(`ملف أو صفحة مُشار إليها غير موجودة في dist: ${u} (مذكورة في ${where(set)})`);
  }

  for (const [u, set] of relative) {
    warn(`رابط نسبي لا يبدأ بـ / وسيتعطل داخل المجلدات الفرعية: ${u} (مذكور في ${where(set)})`);
  }
}

/* ---------- 6) البرنامج ---------- */
function main() {
  const t0 = Date.now();
  log('جارٍ بناء الموقع ...');

  /* مرحلة القراءة والتحقق والتوليد في الذاكرة (لا تلمس dist) */
  const data = loadData();
  const origin = normalizeDomain(data.site);
  const partials = loadPartials();
  const pages = loadPages(origin);
  requireDir(P.assets, 'مجلد الأصول');
  validateCourses(data.courses, new Set(pages.map((p) => p.slug)));
  for (const p of pages) p.html = renderPage(p, data, partials);
  const hasCss = exists(P.css);
  const hasJs = exists(P.js);
  if (!hasCss) warn(`المجلد ${rel(P.css)} غير موجود بعد، فلن تُنسخ ملفات CSS (تُنشأ في المهمة T2).`);
  if (!hasJs) warn(`المجلد ${rel(P.js)} غير موجود، فلن تُنسخ ملفات JavaScript.`);

  /* مرحلة الكتابة */
  diskPhase = true;
  wipeDist();
  for (const p of pages) {
    io(`كتابة ${rel(p.outFile)}`, () => {
      fs.mkdirSync(path.dirname(p.outFile), { recursive: true });
      fs.writeFileSync(p.outFile, p.html, 'utf8');
    });
  }
  const nAssets = io('نسخ مجلد assets', () => copyTree(P.assets, path.join(DIST_DIR, 'assets')));
  const nCss = hasCss ? io('نسخ ملفات CSS', () => copyTree(P.css, path.join(DIST_DIR, 'assets', 'css'))) : 0;
  const nJs = hasJs ? io('نسخ ملفات JavaScript', () => copyTree(P.js, path.join(DIST_DIR, 'assets', 'js'))) : 0;
  io('كتابة sitemap.xml وrobots.txt', () => {
    fs.writeFileSync(path.join(DIST_DIR, 'sitemap.xml'), sitemapXml(pages, origin), 'utf8');
    fs.writeFileSync(path.join(DIST_DIR, 'robots.txt'), robotsTxt(origin), 'utf8');
  });
checkReferences(pages, data.site.basePath || '');
  /* الملخص */
  log('');
  log('تم البناء بنجاح.');
  log(`  عدد الصفحات المبنية: ${pages.length}`);
  for (const p of pages) log(`    ${p.urlPath.padEnd(18)} ->  ${rel(p.outFile)}`);
  log(`  ملفات منسوخة: ${nAssets} من assets ، ${nCss} من css ، ${nJs} من js`);
  log('  ملفات مولَّدة: sitemap.xml ، robots.txt');
  log(`  المجلد الناتج: ${rel(DIST_DIR)}`);
  log(`  زمن البناء: ${((Date.now() - t0) / 1000).toFixed(2)} ثانية`);
  if (warnings.length) {
    log('');
    log(`تنبيهات (${warnings.length}) ${STRICT ? '— الوضع الصارم: تُعدّ أخطاء' : '— لا تمنع البناء لكن يُنصح بمعالجتها'}:`);
    for (const w of warnings) log(`  - ${w}`);
    if (STRICT) process.exitCode = 1;
  }
}

function printError(e) {
  console.error('');
  console.error(`خطأ: ${e.message}`);
  for (const d of e.details) console.error(`  ${d}`);
  console.error('');
  if (diskPhase) console.error('توقف البناء أثناء كتابة مجلد dist فقد يكون ناقصًا. أصلح الخطأ ثم أعد التشغيل.');
  else if (exists(DIST_DIR)) console.error('لم يُمسّ مجلد dist: بقيت نسخته السابقة كما هي. أصلح الخطأ ثم أعد التشغيل.');
  else console.error('لم يُنشأ مجلد dist. أصلح الخطأ ثم أعد التشغيل.');
}

try {
  main();
} catch (e) {
  if (e instanceof BuildError) {
    printError(e);
  } else {
    console.error('');
    console.error('خطأ غير متوقع في سكربت البناء نفسه (وليس في ملفات الموقع غالبًا).');
    console.error(`  السبب: ${e && e.message ? e.message : e}`);
    if (e && e.stack) console.error(e.stack);
  }
  process.exitCode = 1;
}
