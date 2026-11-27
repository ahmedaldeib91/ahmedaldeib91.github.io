/* =====================================================================
   admin-qbank-taxonomy.js — تبويب «التصنيف» في قسم بنك الأسئلة (#qbank/<course>/taxonomy)
   (١) شجرة التصنيف لكل دورة: مجال (domain) ← موضوع (topic) ← موضوع فرعي (subtopic) في جدول qb_taxonomy: إضافة، تعديل (الاسمان والرمز)،
       ترتيب (أعلى/أسفل بين الإخوة، يعيد ترقيم sort)، وحذف. المستوى والدورة لا يتغيران بعد الإنشاء (يمنعه مشغّل القاعدة)، والنقل بين الآباء غير مدعوم هنا.
       الحذف له حارسان: محليًا لا يُحذف عنصر له أبناء، ومن القاعدة (مفتاح أجنبي RESTRICT) لا يُحذف عنصر مرتبط بإصدارات أسئلة (23503 ← رسالة واضحة).
   (٢) وسوم الدورة (qb_tags): إضافة وإعادة تسمية وحذف؛ التفرّد لا يُفرّق بين حالتَي الأحرف. حذف الوسم يفكّ ارتباطه بالأسئلة (cascade) فيُعرض عدد أسئلته قبل التأكيد.
   كل الطلبات تحمل course_id، والكتابة بصلاحية qbank.write (المدير دائمًا) تقررها سياسات RLS.
   ===================================================================== */
(function () {
  'use strict';

  const A = window.Admin;
  if (!A || !A.qb) return;
  const QB = A.qb;
  const P = A.P;
  const h = A.h;
  const ui = A.ui;
  const CODE_RE = /^[A-Za-z0-9._-]{1,40}$/;
  const CHILD = { domain: 'topic', topic: 'subtopic' };

  async function renderTaxonomy(panel, o) {
    const course = o.course;
    const token = o.token;
    const refresh = A.btn('تحديث', { icon: 'refresh', small: true });
    panel.appendChild(h('div', { class: 'ad-qb-bar' }, refresh));
    const body = h('div');
    panel.appendChild(body);
    let tax = null;
    let tags = null;
    let usage = {};

    async function fetchAll() {
      const r = await Promise.all([
        QB.getTax(course, true),
        QB.getTags(course, true),
        A.all('qb_question_tags', { select: 'tag_id', course_id: 'eq.' + course, order: 'question_id.asc,tag_id.asc' })
      ]);
      tax = r[0];
      tags = r[1];
      usage = {};
      r[2].forEach(function (x) { usage[x.tag_id] = (usage[x.tag_id] || 0) + 1; });
    }
    async function reload() {
      try { await fetchAll(); } catch (err) { if (!A.stale(token)) QB.loadFail(body, err, load); return; }
      if (A.stale(token)) return;
      paint();
    }
    async function load() {
      A.clear(body);
      body.appendChild(A.loading('جارٍ تحميل التصنيف والوسوم…'));
      refresh.disabled = true;
      try { await fetchAll(); } catch (err) {
        refresh.disabled = false;
        if (A.stale(token)) return;
        QB.loadFail(body, err, load);
        return;
      }
      refresh.disabled = false;
      if (A.stale(token)) return;
      paint();
    }

    /* ---------- نموذج الاسم/الرمز (للإضافة والتعديل) ---------- */
    function nameForm(cfg) {
      const nameAr = A.input({ max: 300, value: cfg.name_ar || '', placeholder: cfg.placeholder || '', required: true });
      nameAr.setAttribute('dir', 'auto');
      const nameEn = A.input({ max: 300, value: cfg.name_en || '', ltr: true, placeholder: 'اختياري' });
      const code = A.input({ max: 40, value: cfg.code || '', ltr: true, placeholder: 'اختياري' });
      const out = A.msgBox();
      const btn = A.btn(cfg.submit, { kind: 'p', small: true, type: 'submit' });
      const kids = [
        h('div', { class: 'ad-cols' }, A.field('الاسم بالعربية', nameAr), A.field('الاسم بالإنجليزية', nameEn)),
        A.field('الرمز', code, 'اختياري: حروف لاتينية وأرقام و . _ - فقط (حتى ٤٠)، ويجب ألا يتكرر في الدورة.'),
        h('div', { class: 'ad-act' }, btn, cfg.onCancel ? A.btn('إلغاء', { small: true, on: cfg.onCancel }) : null, out)
      ];
      if (cfg.title) kids.unshift(h('h4', { text: cfg.title }));
      const form = h('form', { class: 'pf-form ad-qform', novalidate: true, method: 'post', action: '/admin/' }, kids);
      A.clearInvalidOnInput(form);
      form.addEventListener('submit', QB.run(btn, out, 'tax', async function () {
        ui.clearMsg(out);
        const bag = {};
        const ar = ui.check(nameAr, A.textLen(nameAr.value, 1, 300, 'اكتب الاسم بالعربية (حتى ٣٠٠ حرف).'), bag);
        const en = ui.check(nameEn, A.textLen(nameEn.value, 0, 300, 'الاسم الإنجليزي طويل (الحد ٣٠٠ حرف).'), bag);
        const cd = ui.check(code, A.textLen(code.value, 0, 40, 'الرمز طويل (الحد ٤٠ حرفًا).'), bag);
        if (cd && !CODE_RE.test(cd)) { ui.fieldError(code, 'الرمز: حروف لاتينية وأرقام و . _ - فقط.'); if (!bag.first) bag.first = code; }
        if (bag.first) { bag.first.focus(); return; }
        await cfg.onSubmit({ name_ar: ar, name_en: en || null, code: cd || null });
      }));
      return form;
    }

    async function createNode(parent, level, v) {
      const row = { course_id: course, parent_id: parent ? parent.id : null, level: level, name_ar: v.name_ar, sort: QB.nextSort(tax.children(parent ? parent.id : null)) };
      if (v.name_en) row.name_en = v.name_en;
      if (v.code) row.code = v.code;
      const rows = await P.rest.insert('qb_taxonomy', row);
      if (!rows.length) throw A.noRows();
    }

    /* ---------- عقدة ---------- */
    function nodeItem(node, siblings, i) {
      const li = h('li', { class: 'ad-qb-node' });
      const out = A.msgBox();
      const holder = h('div', { class: 'ad-edit', hidden: true });
      const kids = tax.children(node.id);
      const childLevel = CHILD[node.level];
      let showing = '';
      function show(kind, build) {
        if (showing === kind) { showing = ''; holder.hidden = true; A.clear(holder); return; }
        showing = kind;
        A.clear(holder);
        holder.hidden = false;
        holder.appendChild(build());
        const f = holder.querySelector('input');
        if (f) f.focus();
      }
      function close() { showing = ''; holder.hidden = true; A.clear(holder); }

      const up = A.ibtn('up', 'تحريك «' + node.name_ar + '» للأعلى', null);
      const down = A.ibtn('down', 'تحريك «' + node.name_ar + '» للأسفل', null);
      up.disabled = i === 0;
      down.disabled = i === siblings.length - 1;
      [[up, -1], [down, 1]].forEach(function (pair) {
        pair[0].addEventListener('click', QB.run(pair[0], out, 'tax', async function () {
          ui.clearMsg(out);
          const ord = siblings.slice();
          const t = ord.splice(i, 1)[0];
          ord.splice(i + pair[1], 0, t);
          await QB.applyOrder('qb_taxonomy', course, ord);
          await reload();
        }));
      });
      const add = childLevel ? A.btn('إضافة ' + QB.LEVELS[childLevel], { small: true, icon: 'plus' }) : null;
      if (add) {
        add.addEventListener('click', function () {
          show('add', function () {
            return nameForm({
              title: QB.LEVELS[childLevel] + ' جديد تحت «' + node.name_ar + '»', submit: 'إضافة', onCancel: close,
              onSubmit: async function (v) { await createNode(node, childLevel, v); A.toast('ok', 'تمت الإضافة.'); await reload(); }
            });
          });
        });
      }
      const edit = A.btn('تعديل', { small: true });
      edit.addEventListener('click', function () {
        show('edit', function () {
          return nameForm({
            title: 'تعديل «' + node.name_ar + '»', submit: 'حفظ', name_ar: node.name_ar, name_en: node.name_en, code: node.code, onCancel: close,
            onSubmit: async function (v) {
              const rows = await P.rest.update('qb_taxonomy', { id: 'eq.' + node.id, course_id: 'eq.' + course }, v);
              if (!rows.length) throw A.noRows();
              A.toast('ok', 'تم حفظ التعديل.');
              await reload();
            }
          });
        });
      });
      const del = A.ibtn('trash', 'حذف «' + node.name_ar + '»', null, 'danger');
      del.addEventListener('click', QB.run(del, out, 'taxdel', async function () {
        ui.clearMsg(out);
        if (kids.length) { ui.msg(out, 'err', 'لا يمكن حذف «' + node.name_ar + '» لأن تحته ' + A.num(kids.length) + ' عنصرًا فرعيًا. احذف الفروع أولًا.'); return; }
        const ok = await A.confirm({
          title: 'حذف «' + node.name_ar + '»؟',
          message: 'سيُحذف هذا العنصر من تصنيف الدورة.',
          detail: 'لا يُحذف إن كانت أسئلة مرتبطة به (انقلها إلى تصنيف آخر أولًا). لا يمكن التراجع عن الحذف.', ok: 'حذف', danger: true
        });
        if (!ok) return;
        const rows = await P.rest.remove('qb_taxonomy', { id: 'eq.' + node.id, course_id: 'eq.' + course });
        if (!rows.length) throw A.noRows();
        A.toast('ok', 'تم حذف العنصر.');
        await reload();
      }));

      li.appendChild(h('div', { class: 'ad-qb-nodehead' },
        h('div', { class: 'ad-qb-nodet' },
          h('b', { dir: 'auto', text: node.name_ar }),
          node.name_en ? h('small', { class: 'ad-ltr', text: node.name_en }) : null,
          node.code ? A.badge(node.code, 'info') : null,
          A.badge(QB.LEVELS[node.level], 'mut'),
          kids.length ? h('small', { class: 'ad-muted', text: A.num(kids.length) + ' فرعي' }) : null),
        h('div', { class: 'ad-iact' }, up, down, add, edit, del)));
      li.appendChild(out);
      li.appendChild(holder);
      if (kids.length) li.appendChild(h('ul', { class: 'ad-qb-tree' }, kids.map(function (c, j) { return nodeItem(c, kids, j); })));
      return li;
    }

    function treeCard() {
      const kids = [
        h('p', { class: 'ad-sub', text: 'مجال ← موضوع ← موضوع فرعي. يُصنَّف السؤال بأعمق مستوى تختاره في المحرر، وتشمل تصفية قائمة الأسئلة أبناء العنصر المختار.' }),
        nameForm({
          title: 'مجال جديد', submit: 'إضافة مجال', placeholder: 'مثال: إدارة النطاق',
          onSubmit: async function (v) { await createNode(null, 'domain', v); A.toast('ok', 'تمت إضافة المجال.'); await reload(); }
        })
      ];
      if (!tax.roots.length) kids.push(A.empty('لا توجد مجالات بعد', 'أضف أول مجال ثم أنشئ تحته مواضيع ومواضيع فرعية.'));
      else kids.push(h('ul', { class: 'ad-qb-tree', 'aria-label': 'شجرة تصنيف الدورة' }, tax.roots.map(function (n, i) { return nodeItem(n, tax.roots, i); })));
      return A.card('التصنيف', kids);
    }

    /* ---------- الوسوم ---------- */
    function tagRow(t) {
      const out = A.msgBox();
      const holder = h('div', { class: 'ad-edit', hidden: true });
      const n = usage[t.id] || 0;
      const edit = A.btn('إعادة تسمية', { small: true });
      edit.addEventListener('click', function () {
        if (!holder.hidden) { holder.hidden = true; A.clear(holder); return; }
        holder.hidden = false;
        A.clear(holder);
        const label = A.input({ max: 80, value: t.label });
        label.setAttribute('dir', 'auto');
        const msg = A.msgBox();
        const save = A.btn('حفظ', { kind: 'p', small: true, type: 'submit' });
        const f = h('form', { class: 'pf-form', novalidate: true, method: 'post', action: '/admin/' },
          A.field('اسم الوسم', label), h('div', { class: 'ad-act' }, save, A.btn('إلغاء', { small: true, on: function () { holder.hidden = true; A.clear(holder); } }), msg));
        A.clearInvalidOnInput(f);
        f.addEventListener('submit', QB.run(save, msg, 'tag', async function () {
          ui.clearMsg(msg);
          const bag = {};
          const v = ui.check(label, A.textLen(label.value, 1, 80, 'اكتب اسم الوسم (حتى ٨٠ حرفًا).'), bag);
          if (bag.first) { bag.first.focus(); return; }
          const rows = await P.rest.update('qb_tags', { id: 'eq.' + t.id, course_id: 'eq.' + course }, { label: v });
          if (!rows.length) throw A.noRows();
          A.toast('ok', 'تمت إعادة تسمية الوسم.');
          await reload();
        }));
        holder.appendChild(f);
        label.focus();
      });
      const del = A.ibtn('trash', 'حذف الوسم «' + t.label + '»', null, 'danger');
      del.addEventListener('click', QB.run(del, out, 'tagdel', async function () {
        ui.clearMsg(out);
        const ok = await A.confirm({
          title: 'حذف الوسم «' + t.label + '»؟',
          message: n ? 'سيُزال هذا الوسم من ' + A.num(n) + ' سؤالًا. الأسئلة نفسها لا تُحذف.' : 'هذا الوسم غير مستعمل في أي سؤال.',
          detail: 'لا يمكن التراجع عن الحذف.', ok: 'حذف الوسم', danger: true
        });
        if (!ok) return;
        const rows = await P.rest.remove('qb_tags', { id: 'eq.' + t.id, course_id: 'eq.' + course });
        if (!rows.length) throw A.noRows();
        A.toast('ok', 'تم حذف الوسم.');
        await reload();
      }));
      return h('li', { class: 'ad-qb-tagrow' },
        h('div', { class: 'ad-qb-tagmain' }, h('b', { dir: 'auto', text: t.label }), A.badge(A.num(n) + ' سؤال', n ? 'info' : 'mut'), h('div', { class: 'ad-iact' }, edit, del)),
        out, holder);
    }

    function tagsCard() {
      const label = A.input({ max: 80, placeholder: 'مثال: PMBOK أو Scope' });
      label.setAttribute('dir', 'auto');
      const out = A.msgBox();
      const btn = A.btn('إضافة وسم', { kind: 'p', small: true, type: 'submit', icon: 'plus' });
      const form = h('form', { class: 'pf-form ad-addenr', novalidate: true, method: 'post', action: '/admin/' }, A.field('وسم جديد', label), btn);
      A.clearInvalidOnInput(form);
      form.addEventListener('submit', QB.run(btn, out, 'tag', async function () {
        ui.clearMsg(out);
        const bag = {};
        const v = ui.check(label, A.textLen(label.value, 1, 80, 'اكتب اسم الوسم (حتى ٨٠ حرفًا).'), bag);
        if (bag.first) { bag.first.focus(); return; }
        const rows = await P.rest.insert('qb_tags', { course_id: course, label: v });
        if (!rows.length) throw A.noRows();
        A.toast('ok', 'تمت إضافة الوسم.');
        await reload();
      }));
      const kids = [
        h('p', { class: 'ad-sub', text: 'وسوم حرّة (كلمات مفتاحية) تُلصق بالأسئلة وتُستعمل في التصفية.' }),
        form, out
      ];
      if (!tags.rows.length) kids.push(A.empty('لا توجد وسوم بعد', 'أضف وسمًا من الحقل أعلاه، أو أنشئ وسومًا مباشرة من محرر السؤال.'));
      else kids.push(h('ul', { class: 'ad-list ad-qb-tags', 'aria-label': 'وسوم الدورة' }, tags.rows.map(tagRow)));
      return A.card('الوسوم (الكلمات المفتاحية)', kids);
    }

    function paint() {
      A.clear(body);
      body.appendChild(treeCard());
      body.appendChild(tagsCard());
    }

    refresh.addEventListener('click', load);
    await load();
  }

  QB.mods.taxonomy = { render: renderTaxonomy };
})();
