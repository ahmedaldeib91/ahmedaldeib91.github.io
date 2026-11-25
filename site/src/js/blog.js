/* =====================================================================
   blog.js — صفحة /blog/ العامة: قائمة المقالات المنشورة وعرض المقال الواحد
   ملف عادي (ES2017) يُحمَّل بـ defer بعد platform-api.js في هذه الصفحة وحدها، بلا مكتبات ولا صفحات مولَّدة للمقالات.

   1) القراءة بلا جلسة (دور anon) عبر Platform.rest.selectPublic. سياسة RLS (posts_select_anon) تُظهر المنشور فقط،
      ويُكتب المرشّح published=eq.true صراحةً أيضًا. القائمة تجلب الأعمدة اللازمة لها وحدها (بلا النص الكامل)،
      والمقال يُجلب برابطه (slug) عند فتحه ويُحفظ في الذاكرة.
   2) التوجيه بـ hash: /blog/ ← القائمة، و/blog/#/<slug> ← المقال (الـ slug بعد encodeURIComponent). يتابع hashchange فيعمل
      الرجوع والتقدّم. أي hash لا يبدأ بـ #/ (مثل رابط التخطي #main) لا يغيّر العرض. عنوان التبويب يتبدّل مع العرض ويعود في القائمة.
      بعد كل تبديل ينتقل التركيز إلى h1 العرض الجديد (لا في أول تحميل) ويُستعاد موضع التمرير في القائمة عند الرجوع.
   3) الأمان: كل نص من القاعدة (العنوان والنص والروابط) يدخل DOM عبر Platform.ui.h (textContent وcreateElement)، ولا innerHTML أبدًا.
      رابط الوسائط يلزم أن يكون https بلا اسم مستخدم أو كلمة مرور وإلا تُهمَل الوسائط. الصورة <img> بلا referrer.
      الفيديو: Platform.videoEmbed (YouTube وVimeo وBunny فقط)، أو <video controls> لملف في دلو blog-media العام لمشروعنا،
      وما سواهما رابط عادي يُفتح في تبويب جديد.
   4) النص: الفقرات تُفصل بسطر فارغ، والأسطر المفردة داخل الفقرة تبقى (white-space:pre-line في blog.css)، ولا يُفسَّر HTML.
   ===================================================================== */
(function () {
  'use strict';

  const win = window;
  const doc = document;
  const P = win.Platform;
  const $ = function (id) { return doc.getElementById(id); };

  const V = { head: $('bl-head'), loading: $('bl-loading'), error: $('bl-error'), empty: $('bl-empty'), list: $('bl-list'), post: $('bl-post') };
  if (!V.head || !V.loading || !V.error || !V.empty || !V.list || !V.post) return;

  const BASE_TITLE = doc.title;
  const BUCKET = 'blog-media';
  const LIST_QUERY = { select: 'title,slug,published_at,media_kind', published: 'eq.true', order: 'published_at.desc.nullslast,created_at.desc' };
  const POST_COLUMNS = 'title,slug,body,published_at,media_kind,media_url';
  const SLUG_OK = /^[^\s\/?#%\u0000-\u001F\u007F]{1,200}$/; /* قيد القاعدة نفسه: بلا مسافات أو / ? # % وحتى ٢٠٠ حرف */
  const FMT = (function () {
    try { return new Intl.DateTimeFormat('ar-LY-u-nu-latn', { year: 'numeric', month: 'long', day: 'numeric' }); } catch (e) { return null; }
  })();

  let posts = null;          /* قائمة المقالات بعد أول تحميل (تُعاد من الذاكرة عند الرجوع إليها) */
  const opened = new Map();  /* مقالات فُتحت: slug ← صف */
  let seq = 0;               /* رقم آخر طلب عرض: ردّ متأخر لعرض سابق يُهمَل */
  let cur = '';              /* العرض الظاهر الآن: loading | error | empty | list | post */
  let listY = 0;             /* موضع التمرير في القائمة قبل فتح مقال (يُستعاد عند الرجوع) */
  let started = false;       /* بعد أول عرض ينتقل التركيز مع كل تبديل (لا نسرقه عند أول تحميل) */

  /* ---------- العرض ---------- */
  /* يُظهر منطقة واحدة ويخفي البقية. hideHead: في المقال (وأثناء تحميله) يحلّ عنوانه h1 محل رأس القائمة */
  function view(name, hideHead) {
    ['loading', 'error', 'empty', 'list', 'post'].forEach(function (k) { V[k].hidden = k !== name; });
    V.head.hidden = !!hideHead;
    cur = name;
  }
  function setTitle(t) { doc.title = t ? t + ' | ' + BASE_TITLE : BASE_TITLE; }
  function jump(y) {
    try { win.scrollTo({ top: y, left: 0, behavior: 'instant' }); } catch (e) { win.scrollTo(0, y); }
  }
  /* بعد عرض جديد: التمرير (أعلى المقال أو موضع القائمة السابق) ونقل التركيز إلى h1 */
  function arrive(listView) {
    if (!started) { started = true; return; }
    jump(listView ? listY : 0);
    const t = (listView ? V.head : V.post).querySelector('h1');
    if (t) { try { t.focus({ preventScroll: true }); } catch (e) { t.focus(); } }
  }

  $('bl-retry').addEventListener('click', function () { if (P) route(); else win.location.reload(); });
  if (!P) { view('error', false); return; } /* platform-api.js لم يُحمَّل: تبقى رسالة الخطأ الافتراضية */
  const h = P.ui.h;

  function fail(err, inPost) {
    $('bl-error-text').textContent = err && (err.kind === 'network' || err.kind === 'config') ? err.message
      : inPost ? 'تعذّر تحميل المقال الآن. حاول مرة أخرى بعد قليل.' : 'تعذّر تحميل المقالات الآن. حاول مرة أخرى بعد قليل.';
    view('error', false);
  }

  /* ---------- أدوات صغيرة ---------- */
  function when(iso) {
    const d = new Date(String(iso || '').replace(/(\.\d{3})\d+/, '$1')); /* Safari لا يقبل أحيانًا أكثر من ٣ خانات كسرية */
    if (isNaN(d.getTime())) return null;
    return h('time', { datetime: d.toISOString(), text: FMT ? FMT.format(d) : d.toISOString().slice(0, 10) });
  }
  function kindChip(k) {
    const t = k === 'image' ? 'صورة' : k === 'video' ? 'فيديو' : '';
    return t ? h('span', { class: 'bl-kind', text: t }) : null;
  }
  function paragraphs(s) {
    return String(s == null ? '' : s).replace(/\r\n?/g, '\n').split(/\n\s*\n/).map(function (x) { return x.trim(); }).filter(Boolean);
  }
  function httpsUrl(raw) {
    try {
      const u = new URL(String(raw == null ? '' : raw).trim());
      return u.protocol === 'https:' && !u.username && !u.password ? u.href : null;
    } catch (e) { return null; }
  }
  function hostOf(u) { try { return new URL(u).hostname; } catch (e) { return ''; } }
  /* عند فشل تحميل الوسائط يُستبدل العنصر برسالة قصيرة */
  function onFail(node, text) {
    node.addEventListener('error', function () { node.replaceWith(h('p', { class: 'callout', text: text })); });
    return node;
  }

  /* ---------- الوسائط ---------- */
  function mediaNode(p, title) {
    const url = httpsUrl(p.media_url);
    if (!url) return null;
    if (p.media_kind === 'image') {
      return onFail(h('img', { src: url, alt: 'صورة المقال: ' + title, decoding: 'async', referrerpolicy: 'no-referrer' }), 'تعذّر تحميل صورة المقال.');
    }
    if (p.media_kind !== 'video') return null;
    const emb = P.videoEmbed(url);
    if (emb) {
      return h('div', { class: 'bl-frame' }, h('iframe', {
        src: emb.src, title: 'فيديو المقال: ' + title, loading: 'lazy',
        sandbox: 'allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox',
        allow: 'encrypted-media; picture-in-picture; fullscreen',
        referrerpolicy: 'strict-origin-when-cross-origin'
      }));
    }
    if (P.storage.publicPath(url, BUCKET)) {
      return onFail(h('video', { src: url, controls: true, preload: 'metadata', playsinline: true }), 'تعذّر تحميل الفيديو.');
    }
    return h('a', { class: 'bl-vlink', href: url, target: '_blank', rel: 'noopener noreferrer' }, 'فتح الفيديو في تبويب جديد', ' ', h('span', { class: 'bl-vhost', text: hostOf(url) }));
  }

  /* ---------- البناء ---------- */
  function card(p) {
    const title = String(p.title || '');
    const href = '#/' + encodeURIComponent(String(p.slug || ''));
    return h('article', { class: 'card bl-card rv' },
      h('p', { class: 'bl-meta' }, when(p.published_at), kindChip(p.media_kind)),
      h('h2', { dir: 'auto' }, h('a', { href: href, text: title })),
      h('a', { class: 'btn s', href: href, tabindex: '-1', 'aria-hidden': 'true', text: 'اقرأ المقال' })); /* نسخة بصرية من رابط العنوان: خارج ترتيب التبويب وقارئ الشاشة */
  }
  function back(cls) {
    return h('div', { class: cls }, h('a', { class: 'btn s', href: '#/' }, h('span', { 'aria-hidden': 'true', text: '→' }), ' العودة إلى المدونة'));
  }
  /* هيكل صفحة المقال: رابط العودة، العنوان h1 (يستلم التركيز)، المحتوى، رابط العودة */
  function article(title, extra, content) {
    P.ui.clear(V.post);
    V.post.appendChild(back('bl-top'));
    V.post.appendChild(h('header', { class: 'bl-phead' }, h('div', { class: 'eyebrow', text: 'المدونة' }), h('h1', { dir: 'auto', tabindex: '-1', text: title }), extra));
    V.post.appendChild(content);
    V.post.appendChild(back('bl-foot'));
    setTitle(title);
    view('post', true);
    arrive(false);
  }
  function renderPost(p) {
    const title = String(p.title || '');
    const t = when(p.published_at);
    const media = mediaNode(p, title);
    article(title, t ? h('p', { class: 'bl-meta' }, t) : null, h('div', null,
      media ? h('figure', { class: 'bl-media' }, media) : null,
      h('div', { class: 'bl-body' }, paragraphs(p.body).map(function (x) { return h('p', { dir: 'auto', text: x }); }))));
  }
  function renderMissing() {
    article('المقال غير موجود', h('p', { class: 'sub', text: 'لم نجد هذا المقال. ربما حُذف أو لم يُنشر بعد.' }), h('div'));
  }

  /* ---------- التحميل والتوجيه ---------- */
  async function showList(token) {
    setTitle('');
    if (!posts) {
      view('loading', false);
      try { posts = await P.rest.selectPublic('posts', LIST_QUERY); } catch (err) { if (token === seq) fail(err, false); return; }
      if (token !== seq) return;
    }
    P.ui.clear(V.list);
    posts.forEach(function (p) { V.list.appendChild(card(p)); });
    view(posts.length ? 'list' : 'empty', false);
    arrive(true);
  }
  async function showPost(slug, token) {
    if (!SLUG_OK.test(slug)) { renderMissing(); return; } /* رابط لا يمكن أن يوجد في القاعدة: لا طلب */
    let p = opened.get(slug);
    if (!p) {
      view('loading', true);
      try {
        const rows = await P.rest.selectPublic('posts', { select: POST_COLUMNS, slug: 'eq.' + slug, published: 'eq.true', limit: '1' });
        p = rows[0] || null;
      } catch (err) { if (token === seq) fail(err, true); return; }
      if (token !== seq) return;
      if (!p) { renderMissing(); return; }
      opened.set(slug, p);
    }
    renderPost(p);
  }
  /* null = hash لا يخص المدونة (مثل #main): لا يغيّر العرض */
  function parseRoute() {
    const hash = win.location.hash;
    if (hash === '' || hash === '#' || hash === '#/') return { kind: 'list' };
    if (hash.slice(0, 2) !== '#/') return null;
    let slug;
    try { slug = decodeURIComponent(hash.slice(2).replace(/\/+$/, '')); } catch (e) { return { kind: 'missing' }; }
    return slug ? { kind: 'post', slug: slug } : { kind: 'list' };
  }
  function route() {
    const r = parseRoute() || (cur ? null : { kind: 'list' }); /* أول عرض: أي hash غير معروف يعني القائمة */
    if (!r) return;
    if (cur === 'list') listY = win.pageYOffset;
    const token = ++seq;
    if (r.kind === 'missing') { renderMissing(); return; }
    (r.kind === 'post' ? showPost(r.slug, token) : showList(token)).catch(function () { if (token === seq) fail(null, r.kind === 'post'); });
  }

  win.addEventListener('hashchange', route);
  route();
})();
