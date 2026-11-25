/* =====================================================================
   admin-blog.js — قسم «المدونة» (#blog و#blog/new و#blog/<uuid>) في لوحة المدرب
   - القائمة: مسودات ومنشورات، بحث وتصفية، نشر/إلغاء نشر سريع، حذف بتأكيد (ومعه كائنه في التخزين).
   - المحرر: العنوان، الرابط (slug) يُولَّد من العنوان ما لم يعدّله المدرب وتُفحص فرادته (وعند التعارض في الوضع التلقائي يُضاف رقم)،
     النص (نص عادي، الفقرات بسطر فارغ، ولا يُفسَّر HTML أبدًا)، والوسائط: لا شيء/صورة/فيديو برابط https أو برفع إلى الدلو العام blog-media
     (png/jpg/webp/gif للصور وmp4/webm للفيديو، ≤ ٥٠MB، بشريط تقدّم). يُرفع الملف عند الحفظ فقط (لا كائنات يتيمة إن تُرك المحرر)،
     ويُحذف الكائن المرفوع إن فشلت الكتابة في القاعدة، ويُحذف الكائن القديم عند استبداله إن لم يشر إليه مقال آخر.
   - النشر: published=true يضع الوقت تلقائيًا (مشغّل القاعدة)، وإلغاء النشر يصفّر published_at لتُختم الدفعة التالية بوقتها الجديد.
   - معاينة حيّة مصغّرة بجانب المحرر: العنوان والفقرات والوسائط (الفيديو المضمَّن من المضيفين المسموحين فقط).
   ===================================================================== */
(function () {
  'use strict';

  const A = window.Admin;
  if (!A) return;
  const P = A.P;
  const h = A.h;
  const ui = A.ui;
  const BUCKET = 'blog-media';
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const SLUG_OK = /^[^\s/?#%]+$/;
  const KIND_LABEL = { none: 'بلا وسائط', image: 'صورة', video: 'فيديو' };

  /* حذف كائن الوسائط من الدلو العام إن كان رابطه يخص مشروعنا ولم يعد يشير إليه أي مقال. يعيد true إن حُذف أو لم يلزم */
  async function dropMedia(url) {
    const path = url ? P.storage.publicPath(url, BUCKET) : null;
    if (!path) return true;
    const still = await P.rest.select('posts', { select: 'id', media_url: 'eq.' + url, limit: '1' });
    if (still.length) return true;
    const gone = await P.storage.remove(BUCKET, [path]);
    return gone.length > 0;
  }
  /* حذف مقال (بتأكيد) ثم وسائطه. يعيد true إن حُذف */
  async function deletePost(post) {
    const ok = await A.confirm({
      title: 'حذف «' + post.title + '»؟',
      message: 'سيُحذف المقال نهائيًا' + (post.media_url && P.storage.publicPath(post.media_url, BUCKET) ? '، ويُحذف ملف وسائطه من التخزين أيضًا.' : '.'),
      detail: 'لا يمكن التراجع عن الحذف. إن أردت إخفاءه فقط فاستعمل «إلغاء النشر».', ok: 'حذف نهائي', danger: true
    });
    if (!ok) return false;
    const rows = await P.rest.remove('posts', { id: 'eq.' + post.id });
    if (!rows.length) throw A.noRows();
    let warn = false;
    try { warn = !(await dropMedia(post.media_url)); } catch (err) { if (A.isSession(err)) throw err; warn = true; }
    A.toast(warn ? 'info' : 'ok', warn ? 'حُذف المقال لكن تعذّر حذف ملف وسائطه من التخزين. راجع التخزين يدويًا إن لزم.' : 'تم حذف المقال.');
    return true;
  }
  async function freeSlug(base, selfId) {
    const q = { select: 'slug', slug: 'like.' + base.replace(/[%*]/g, '') + '*', limit: '300' };
    if (selfId) q.id = 'neq.' + selfId;
    const used = new Set((await P.rest.select('posts', q)).map(function (r) { return r.slug; }));
    if (!used.has(base)) return base;
    for (let i = 2; i < 500; i++) { const c = base.slice(0, 190) + '-' + i; if (!used.has(c)) return c; }
    return base.slice(0, 180) + '-' + A.uuid().slice(0, 6);
  }
  const paragraphs = function (s) { return String(s || '').split(/\n{2,}/).map(function (x) { return x.trim(); }).filter(Boolean); };

  /* ================================================================== القائمة */
  async function renderList(root, token) {
    const st = { q: '', f: 'all' };
    const refresh = A.btn('تحديث', { icon: 'refresh', small: true });
    root.appendChild(A.head('المدونة', 'أنشئ مقالات نصية أو بصور وفيديو قصير، وانشرها أو احتفظ بها كمسودات.', [A.link('مقال جديد', '#blog/new', { kind: 'p', small: true, icon: 'plus' }), refresh]));
    const body = h('div');
    root.appendChild(body);
    let rows = [];

    function build() {
      A.clear(body);
      const search = A.input({ type: 'search', max: 120, placeholder: 'ابحث في العنوان أو الرابط' });
      search.value = st.q;
      const filt = A.select([['all', 'الكل'], ['published', 'منشورة'], ['draft', 'مسودات']], st.f);
      const count = h('p', { class: 'ad-count-t', role: 'status' });
      const box = h('div');
      const out = A.msgBox();
      function paint() {
        A.clear(box);
        const q = A.normAr(st.q);
        const list = rows.filter(function (p) {
          if (st.f === 'published' && !p.published) return false;
          if (st.f === 'draft' && p.published) return false;
          return !q || A.normAr(p.title + ' ' + p.slug).indexOf(q) !== -1;
        });
        count.textContent = 'عدد المقالات: ' + A.num(list.length) + ' من ' + A.num(rows.length);
        if (!rows.length) { box.appendChild(A.empty('لا توجد مقالات بعد', 'اضغط «مقال جديد» لكتابة أول مقال.', A.link('مقال جديد', '#blog/new', { kind: 'p', icon: 'plus' }))); return; }
        if (!list.length) { box.appendChild(A.empty('لا نتائج', 'غيّر التصفية أو كلمة البحث.')); return; }
        box.appendChild(A.dataTable([
          { key: 't', label: 'المقال', cls: 'ad-first', cell: function (p) {
            return h('div', null, h('a', { class: 'ad-name', href: '#blog/' + p.id, dir: 'auto', text: p.title }), h('small', { class: 'ad-ltr', text: p.slug }));
          } },
          { key: 's', label: 'الحالة', cell: function (p) { return A.badge(p.published ? 'منشور' : 'مسودة', p.published ? 'ok' : 'mut'); } },
          { key: 'm', label: 'الوسائط', cls: 'hide-md', cell: function (p) { return KIND_LABEL[p.media_kind] || p.media_kind; } },
          { key: 'd', label: 'التاريخ', cell: function (p) { return h('span', { class: 'ad-nowrap', text: p.published && p.published_at ? A.fmtDay(p.published_at) : 'عُدّل ' + A.fmtDay(p.updated_at) }); } },
          { key: 'a', label: '', cls: 'ad-actcol', cell: function (p) {
            const pub = A.btn(p.published ? 'إلغاء النشر' : 'نشر', { small: true, kind: p.published ? 's' : 'p' });
            pub.addEventListener('click', A.run(pub, out, async function () {
              ui.clearMsg(out);
              const patch = p.published ? { published: false, published_at: null } : { published: true };
              const r = await P.rest.update('posts', { id: 'eq.' + p.id }, patch);
              if (!r.length) throw A.noRows();
              Object.assign(p, r[0]);
              A.toast('ok', p.published ? 'نُشر المقال.' : 'أُلغي نشر المقال وعاد مسودة.');
              paint();
            }));
            const del = A.btn('حذف', { small: true, kind: 'danger' });
            del.addEventListener('click', A.run(del, out, async function () {
              ui.clearMsg(out);
              if (await deletePost(p)) { rows = rows.filter(function (x) { return x.id !== p.id; }); paint(); }
            }));
            return h('div', { class: 'ad-cell-act' }, A.link('تعديل', '#blog/' + p.id, { small: true }), pub, del);
          } }
        ], list, { caption: 'مقالات المدونة' }));
      }
      search.addEventListener('input', A.debounce(function () { st.q = search.value; paint(); }, 160));
      filt.addEventListener('change', function () { st.f = filt.value; paint(); });
      body.appendChild(h('div', { class: 'ad-tools' }, A.field('بحث', search), A.field('الحالة', filt, null, 'sm'), count));
      body.appendChild(out);
      body.appendChild(box);
      paint();
    }
    async function load() {
      A.clear(body);
      body.appendChild(A.loading('جارٍ تحميل المقالات…'));
      refresh.disabled = true;
      try { rows = await A.all('posts', { select: 'id,title,slug,media_kind,media_url,published,published_at,created_at,updated_at', order: 'created_at.desc,id.asc' }); } catch (err) {
        refresh.disabled = false;
        if (A.stale(token)) return;
        if (A.isSession(err)) { A.lost('expired'); return; }
        A.clear(body);
        body.appendChild(A.fail(A.errText(err), load));
        return;
      }
      refresh.disabled = false;
      if (A.stale(token)) return;
      build();
    }
    refresh.addEventListener('click', load);
    await load();
  }

  /* ================================================================== المحرر */
  async function renderEditor(root, token, idArg) {
    const isNew = idArg === 'new';
    root.appendChild(h('div', { class: 'ad-crumb' }, A.link('العودة إلى المدونة', '#blog', { icon: 'back', small: true })));
    root.appendChild(A.head(isNew ? 'مقال جديد' : 'تعديل المقال', null, []));
    const body = h('div');
    root.appendChild(body);
    let post = null;
    if (!isNew) {
      if (!UUID.test(idArg)) { body.appendChild(A.empty('المقال غير موجود', 'الرابط غير صحيح. ارجع إلى قائمة المقالات.')); return; }
      body.appendChild(A.loading('جارٍ تحميل المقال…'));
      try { post = (await P.rest.select('posts', { select: '*', id: 'eq.' + idArg }))[0] || null; } catch (err) {
        if (A.stale(token)) return;
        if (A.isSession(err)) { A.lost('expired'); return; }
        A.clear(body);
        body.appendChild(A.fail(A.errText(err), function () { A.route(); }));
        return;
      }
      if (A.stale(token)) return;
      if (!post) { A.clear(body); body.appendChild(A.empty('المقال غير موجود', 'لم نجد هذا المقال. ربما حُذف.')); return; }
      A.clear(body);
    }

    /* ---------- الحقول ---------- */
    const title = A.input({ max: 300, value: post ? post.title : '', placeholder: 'عنوان المقال' });
    title.setAttribute('dir', 'auto');
    const slug = A.input({ max: 200, value: post ? post.slug : '', ltr: true, placeholder: 'رابط-المقال' });
    let slugAuto = isNew;
    const slugBtn = A.btn('توليد من العنوان', { small: true, on: function () { slug.value = A.slugify(title.value); slugAuto = true; ui.fieldError(slug, ''); } });
    const bodyTa = A.textarea({ max: 100000, rows: 14, value: post ? post.body : '', placeholder: 'اكتب نص المقال. افصل الفقرات بسطر فارغ.' });
    bodyTa.setAttribute('dir', 'auto');

    /* الوسائط */
    const cur = { kind: post ? post.media_kind : 'none', url: post ? post.media_url : null };
    const kindId = A.nid('mk');
    const kindRadios = {};
    const kindGroup = h('fieldset', { class: 'ad-radios' }, h('legend', { text: 'الوسائط' }));
    ['none', 'image', 'video'].forEach(function (k) {
      const i = h('input', { type: 'radio', name: kindId, value: k });
      i.checked = cur.kind === k;
      kindRadios[k] = i;
      kindGroup.appendChild(h('label', null, i, h('span', { text: KIND_LABEL[k] })));
    });
    const srcId = A.nid('ms');
    const srcUpload = h('input', { type: 'radio', name: srcId, value: 'upload' });
    const srcUrl = h('input', { type: 'radio', name: srcId, value: 'url' });
    const hasOwn = !!(cur.url && P.storage.publicPath(cur.url, BUCKET));
    srcUpload.checked = !cur.url;
    srcUrl.checked = !!cur.url;
    const srcGroup = h('fieldset', { class: 'ad-radios' }, h('legend', { text: 'مصدر الوسائط' }),
      h('label', null, srcUpload, h('span', { text: 'رفع ملف' })), h('label', null, srcUrl, h('span', { text: 'رابط https' })));
    const urlIn = A.input({ type: 'url', max: 2000, ltr: true, value: cur.url || '', placeholder: 'https://…' });
    const urlField = A.field('رابط الوسائط (https)', urlIn, 'صورة مباشرة، أو فيديو mp4/webm مباشر، أو رابط YouTube/Vimeo/Bunny يُعرض مضمَّنًا.');
    let chooser = null;
    const chooserBox = h('div');
    const prog = A.progress();
    const cancel = A.btn('إلغاء الرفع', { small: true, kind: 'danger' });
    cancel.hidden = true;
    let abort = null;
    const mediaBox = h('div');
    function mkChooser() {
      const kind = selectedKind();
      A.clear(chooserBox);
      chooser = kind === 'none' ? null : A.fileChooser({
        types: kind === 'image' ? A.IMAGE_TYPES : A.VIDEO_TYPES, label: kind === 'image' ? 'ملف الصورة' : 'ملف الفيديو',
        hint: (kind === 'image' ? 'PNG أو JPG أو WEBP أو GIF' : 'MP4 أو WEBM') + '، بحد أقصى ٥٠ ميغابايت. يُرفع عند الضغط على «حفظ».', onChange: function () { paintMedia(); }
      });
      if (chooser) chooserBox.appendChild(chooser.el);
      chooserBox.appendChild(prog.el);
      chooserBox.appendChild(cancel);
    }
    const selectedKind = function () { return kindRadios.image.checked ? 'image' : kindRadios.video.checked ? 'video' : 'none'; };
    function syncMedia() {
      const k = selectedKind();
      mediaBox.hidden = k === 'none';
      chooserBox.hidden = !srcUpload.checked;
      urlField.hidden = !srcUrl.checked;
    }
    Object.keys(kindRadios).forEach(function (k) { kindRadios[k].addEventListener('change', function () { mkChooser(); syncMedia(); paintMedia(); }); });
    srcUpload.addEventListener('change', function () { syncMedia(); paintMedia(); });
    srcUrl.addEventListener('change', function () { syncMedia(); paintMedia(); });
    mkChooser();
    mediaBox.appendChild(srcGroup);
    mediaBox.appendChild(chooserBox);
    mediaBox.appendChild(urlField);
    if (hasOwn) mediaBox.appendChild(h('p', { class: 'pf-hint', text: 'الوسائط الحالية مرفوعة في تخزين الموقع. لاستبدالها اختر «رفع ملف» وملفًا جديدًا (يُحذف القديم بعد الحفظ)، أو اختر «بلا وسائط» لإزالتها.' }));

    cancel.addEventListener('click', function () { if (abort) abort.abort(); });
    const out = A.msgBox();
    const statusLine = h('p', { class: 'ad-sub' });
    const btnSave = A.btn('حفظ', { kind: 'p', small: true, type: 'button', icon: 'check' });
    const btnPub = post && post.published ? A.btn('إلغاء النشر', { small: true }) : A.btn('حفظ ونشر', { kind: 'p', small: true });
    const btnDel = post ? A.btn('حذف المقال', { small: true, kind: 'danger', icon: 'trash' }) : null;

    function paintStatus() {
      statusLine.textContent = !post ? 'مقال جديد: يُحفظ كمسودة حتى تنشره.' : post.published ? 'منشور' + (post.published_at ? ' منذ ' + A.fmtDate(post.published_at) : '') + '.' : 'مسودة غير منشورة.';
    }
    paintStatus();

    const form = h('form', { class: 'pf-form', novalidate: true, method: 'post', action: '/admin/' },
      A.field('العنوان', title),
      h('div', { class: 'ad-slugrow' }, A.field('الرابط (slug)', slug, 'يُولَّد من العنوان تلقائيًا ما لم تعدّله. يجب ألا يتكرر ولا يحوي مسافات أو / ? # %.', 'ad-grow'), slugBtn),
      A.field('النص', bodyTa, 'نص عادي: افصل الفقرات بسطر فارغ. لا يُسمح بـ HTML (يُعرض كما كتبته نصًا).'),
      kindGroup, mediaBox, statusLine,
      h('div', { class: 'ad-act' }, btnSave, btnPub, btnDel, out));
    A.clearInvalidOnInput(form);
    syncMedia();

    /* ---------- معاينة حيّة: النص يُعاد رسمه مع كل حرف، والوسائط عند تغيّرها فقط (كي لا يُعاد تحميل الصورة/الفيديو) ---------- */
    const pvTitle = h('h3', { dir: 'auto' });
    const pvMeta = h('p', { class: 'meta' });
    const pvMedia = h('div');
    const pvText = h('div');
    const previewBox = h('div', { class: 'ad-pv' }, pvTitle, pvMeta, pvMedia, pvText);
    let pendingFile = null;
    let pendingUrl = null;
    const dropLocal = function () { if (pendingUrl) URL.revokeObjectURL(pendingUrl); pendingUrl = null; pendingFile = null; };
    const localUrl = function (file) { /* رابط blob: واحد لكل ملف مختار */
      if (file !== pendingFile) { if (pendingUrl) URL.revokeObjectURL(pendingUrl); pendingFile = file; pendingUrl = URL.createObjectURL(file); }
      return pendingUrl;
    };
    function paintText() {
      pvTitle.textContent = title.value.trim() || 'عنوان المقال';
      pvMeta.textContent = post && post.published ? 'منشور' : 'مسودة';
      A.clear(pvText);
      const ps = paragraphs(bodyTa.value);
      if (!ps.length) pvText.appendChild(h('p', { class: 'ad-sub', text: 'ستظهر هنا فقرات المقال أثناء كتابتك.' }));
      ps.forEach(function (x) { pvText.appendChild(h('p', { dir: 'auto', text: x })); });
    }
    function paintMedia() {
      A.clear(pvMedia);
      const k = selectedKind();
      if (k === 'none') { dropLocal(); return; }
      let src = null;
      if (srcUpload.checked) {
        const pk = chooser && chooser.get();
        if (pk) src = localUrl(pk.file);
        else { dropLocal(); if (cur.url && cur.kind === k) src = cur.url; }
      } else { dropLocal(); if (A.isHttps(urlIn.value)) src = A.cleanUrl(urlIn.value); }
      if (!src) { pvMedia.appendChild(h('p', { class: 'ad-sub', text: 'لم تُحدَّد وسائط بعد.' })); return; }
      const failed = function () { A.clear(pvMedia); pvMedia.appendChild(h('p', { class: 'ad-sub', text: 'تعذّر تحميل الوسائط من هذا الرابط.' })); };
      const emb = k === 'video' && /^https:/.test(src) ? P.videoEmbed(src) : null;
      let node;
      if (emb) {
        node = h('div', { class: 'pf-frame' }, h('iframe', { src: emb.src, title: 'معاينة الفيديو', loading: 'lazy', sandbox: 'allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox', allow: 'encrypted-media; picture-in-picture; fullscreen', referrerpolicy: 'strict-origin-when-cross-origin' }));
      } else if (k === 'image') {
        node = h('img', { alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' });
        node.setAttribute('src', src); /* h() لا يقبل blob: فيُضبط مباشرة؛ الرابط إما https تحقّقنا منه أو blob: أنشأناه */
        node.addEventListener('error', failed);
      } else {
        node = h('video', { controls: true, preload: 'metadata', playsinline: true });
        node.setAttribute('src', src);
        node.addEventListener('error', failed);
      }
      pvMedia.appendChild(node);
    }
    title.addEventListener('input', function () { if (slugAuto) slug.value = A.slugify(title.value); paintText(); });
    slug.addEventListener('input', function () { slugAuto = false; });
    bodyTa.addEventListener('input', paintText);
    urlIn.addEventListener('input', A.debounce(paintMedia, 500));
    paintText();
    paintMedia();
    window.addEventListener('hashchange', dropLocal, { once: true });

    /* ---------- الحفظ ---------- */
    /* mode: 'keep' (يبقي حالة النشر) | 'publish' | 'unpublish' */
    async function save(mode) {
      ui.clearMsg(out);
      const bag = {};
      const t = ui.check(title, A.textLen(title.value, 1, 300, 'اكتب عنوان المقال (حتى ٣٠٠ حرف).'), bag);
      let s = slug.value.trim();
      if (!s && slugAuto) s = A.slugify(title.value);
      if (!s) s = 'post-' + A.uuid().slice(0, 8);
      if (s.length > 200 || !SLUG_OK.test(s)) { ui.fieldError(slug, 'الرابط يجب ألا يتجاوز ٢٠٠ حرف ولا يحوي مسافات أو / ? # %.'); if (!bag.first) bag.first = slug; } else ui.fieldError(slug, '');
      const bd = ui.check(bodyTa, A.textLen(bodyTa.value, 0, 100000, 'النص طويل جدًا (الحد ١٠٠٠٠٠ حرف).'), bag);
      const kind = selectedKind();
      let picked = null;
      let mediaUrl = null;
      if (kind !== 'none') {
        if (srcUpload.checked) {
          picked = chooser ? chooser.get() : null;
          if (!picked) {
            if (cur.url && cur.kind === kind) mediaUrl = cur.url; /* لا ملف جديدًا: تبقى الوسائط الحالية */
            else { if (chooser) chooser.error('اختر ملفًا للرفع أو اختر «رابط https».'); if (!bag.first && chooser) bag.first = chooser.input; }
          }
        } else if (!A.isHttps(urlIn.value)) { ui.fieldError(urlIn, 'اكتب رابطًا صحيحًا يبدأ بـ https://'); if (!bag.first) bag.first = urlIn; } else { ui.fieldError(urlIn, ''); mediaUrl = A.cleanUrl(urlIn.value); }
      }
      if (bag.first || t === null) { if (bag.first) bag.first.focus(); return; }
      if (kind !== 'none' && !picked && !mediaUrl) return;

      /* فرادة الرابط قبل أي رفع */
      const free = await freeSlug(s, post ? post.id : '');
      if (free !== s) {
        if (slugAuto) { s = free; slug.value = free; } else { ui.fieldError(slug, 'هذا الرابط مستخدم في مقال آخر. جرّب: ' + free); slug.focus(); return; }
      }

      let uploadedPath = null;
      if (picked) {
        uploadedPath = 'posts/' + A.uuid() + '-' + A.safeFileName(picked.file.name);
        abort = typeof AbortController === 'function' ? new AbortController() : null;
        cancel.hidden = false;
        prog.set(0, 1);
        try {
          await P.storage.upload(BUCKET, uploadedPath, picked.file, { contentType: picked.contentType, onProgress: prog.set, signal: abort ? abort.signal : undefined });
        } catch (err) { uploadedPath = null; throw err; } finally { cancel.hidden = true; prog.reset(); abort = null; }
        mediaUrl = P.storage.publicUrl(BUCKET, uploadedPath);
      }
      const publish = mode === 'publish' ? true : mode === 'unpublish' ? false : (post ? post.published : false);
      const payload = { title: t, slug: s, body: bd, media_kind: kind, media_url: kind === 'none' ? null : mediaUrl, published: publish };
      if (mode === 'unpublish') payload.published_at = null;
      let rows;
      try {
        rows = post ? await P.rest.update('posts', { id: 'eq.' + post.id }, payload) : await P.rest.insert('posts', payload);
        if (!rows.length) throw A.noRows();
      } catch (err) {
        if (uploadedPath) { try { await P.storage.remove(BUCKET, [uploadedPath]); } catch (e) { /* يتيم غير ظاهر */ } }
        if (err instanceof P.ApiError && err.code === '23505') { ui.fieldError(slug, 'هذا الرابط مستخدم في مقال آخر. غيّره ثم احفظ.'); slug.focus(); return; }
        throw err;
      }
      const saved = rows[0];
      /* استبدال أو إزالة وسائط مرفوعة سابقًا: يُحذف القديم إن لم يعد مستعملًا */
      if (post && post.media_url && post.media_url !== saved.media_url) {
        try { await dropMedia(post.media_url); } catch (err) { if (A.isSession(err)) throw err; A.toast('info', 'حُفظ المقال لكن تعذّر حذف الملف القديم من التخزين.'); }
      }
      A.toast('ok', mode === 'publish' ? 'تم حفظ المقال ونشره.' : mode === 'unpublish' ? 'أُلغي نشر المقال وعاد مسودة.' : 'تم حفظ المقال.');
      if (isNew) { try { window.history.replaceState(null, '', '#blog/' + saved.id); } catch (e) { /* تجاهل */ } }
      dropLocal();
      /* إعادة رسم المحرر بالنسخة المحفوظة (يُعاد تحميلها من القاعدة) */
      A.route();
    }
    btnSave.addEventListener('click', A.run(btnSave, out, function () { return save('keep'); }));
    btnPub.addEventListener('click', A.run(btnPub, out, function () { return save(post && post.published ? 'unpublish' : 'publish'); }));
    if (btnDel) {
      btnDel.addEventListener('click', A.run(btnDel, out, async function () {
        ui.clearMsg(out);
        if (await deletePost(post)) { try { window.history.replaceState(null, '', '#blog'); } catch (e) { /* تجاهل */ } A.route(); }
      }));
    }
    form.addEventListener('submit', function (e) { e.preventDefault(); });

    body.appendChild(h('div', { class: 'ad-editor' }, A.card(post ? 'بيانات المقال' : 'مقال جديد', form), h('div', { class: 'ad-preview' }, A.card('معاينة مصغّرة', previewBox))));
  }

  A.register('blog', {
    label: 'المدونة',
    render: async function (root, args, token) {
      if (args[0]) await renderEditor(root, token, args[0]); else await renderList(root, token);
    }
  });
})();
