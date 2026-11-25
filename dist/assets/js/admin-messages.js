/* =====================================================================
   admin-messages.js — قسم «الرسائل» (#messages و#messages/<uuid>) في لوحة المدرب
   صندوق وارد لرسائل «تواصل معنا» (contact_messages): تصفية (الكل/جديدة/مقروءة/مؤرشفة) وبحث، وتفاصيل الرسالة، وتعليم مقروءة/جديدة،
   وأرشفة، وحذف نهائي بتأكيد. شارة العدد في القائمة تتبع الرسائل الجديدة. كل نص يُعرض نصًا (textContent) ولا يُفسَّر HTML أبدًا.
   الرد: رابط mailto: لا يُبنى إلا لبريد صالح (فحص صارم)، ورابط wa.me برقم دولي أرقامه فقط (من ٨ إلى ١٥ رقمًا وبلا صفر بادئ).
   ===================================================================== */
(function () {
  'use strict';

  const A = window.Admin;
  if (!A) return;
  const P = A.P;
  const h = A.h;
  const ui = A.ui;
  const FILTERS = [['all', 'الكل'], ['new', 'جديدة'], ['read', 'مقروءة'], ['archived', 'مؤرشفة']];

  async function render(root, args, token) {
    const st = { filter: 'all', q: '', sel: /^[0-9a-f-]{36}$/i.test(args[0] || '') ? args[0] : '' };
    const refresh = A.btn('تحديث', { icon: 'refresh', small: true });
    root.appendChild(A.head('الرسائل', 'رسائل نموذج «تواصل معنا». الرسائل الجديدة تظهر كشارة في القائمة.', [refresh]));
    const body = h('div');
    root.appendChild(body);
    let rows = [];

    const setHash = function (id) { try { window.history.pushState(null, '', '#messages' + (id ? '/' + id : '')); } catch (e) { window.location.hash = '#messages' + (id ? '/' + id : ''); } };
    const find = function (id) { return rows.filter(function (m) { return m.id === id; })[0] || null; };
    const unread = function () { return rows.filter(function (m) { return m.status === 'new'; }).length; };

    function visible() {
      const q = A.normAr(st.q);
      return rows.filter(function (m) {
        if (st.filter !== 'all' && m.status !== st.filter) return false;
        return !q || A.normAr([m.name, m.email, m.subject, m.message].join(' ')).indexOf(q) !== -1;
      });
    }

    function build() {
      A.clear(body);
      const chips = h('div', { class: 'ad-chips', role: 'group', 'aria-label': 'تصفية الرسائل' });
      const search = A.input({ type: 'search', max: 120, placeholder: 'ابحث في الاسم أو البريد أو الموضوع أو النص' });
      search.value = st.q;
      const side = h('div', { class: 'ad-msgside' });
      const detailBox = h('div', { class: 'ad-msgdetail-wrap' });
      const inbox = h('div', { class: 'ad-inbox' + (st.sel ? ' sel' : '') }, side, detailBox);

      function paintChips() {
        A.clear(chips);
        FILTERS.forEach(function (f) {
          const n = f[0] === 'all' ? rows.length : rows.filter(function (m) { return m.status === f[0]; }).length;
          const b = h('button', { type: 'button', class: 'ad-chip', 'aria-pressed': st.filter === f[0] ? 'true' : 'false' }, f[1], h('span', { class: 'ad-chipn', text: String(n) }));
          b.addEventListener('click', function () { st.filter = f[0]; paintAll(); const nb = chips.querySelectorAll('.ad-chip')[FILTERS.indexOf(f)]; if (nb) nb.focus(); });
          chips.appendChild(b);
        });
      }
      function paintList() {
        A.clear(side);
        const list = visible();
        if (!rows.length) { side.appendChild(A.empty('لا توجد رسائل بعد', 'تظهر هنا رسائل الزوار القادمة من صفحة «تواصل معنا».')); return; }
        if (!list.length) { side.appendChild(A.empty('لا نتائج', 'غيّر التصفية أو كلمة البحث.')); return; }
        side.appendChild(h('ul', { class: 'ad-msglist', 'aria-label': 'قائمة الرسائل' }, list.map(function (m) {
          const b = h('button', { type: 'button', class: 'ad-msgrow' + (m.status === 'new' ? ' new' : ''), 'aria-current': st.sel === m.id ? 'true' : null },
            h('span', { class: 'top' }, h('b', { dir: 'auto', text: m.name }), A.statusBadge('message', m.status)),
            h('span', { class: 'sub2', dir: 'auto', text: m.subject || m.message.replace(/\s+/g, ' ').slice(0, 90) }),
            h('span', { class: 'when', text: A.fmtDate(m.created_at) }));
          b.addEventListener('click', function () { st.sel = m.id; setHash(m.id); paintAll(); focusDetail(); });
          return h('li', null, b);
        })));
      }
      function focusDetail() { const t = detailBox.querySelector('h3'); if (t) { t.setAttribute('tabindex', '-1'); t.focus(); } }

      function setStatus(m, to, okText) {
        return async function () {
          const r = await P.rest.update('contact_messages', { id: 'eq.' + m.id }, { status: to });
          if (!r.length) throw A.noRows();
          m.status = r[0].status;
          A.toast('ok', okText);
          A.setBadge(unread());
          paintAll();
        };
      }
      function paintDetail() {
        A.clear(detailBox);
        const m = st.sel ? find(st.sel) : null;
        if (!m) {
          detailBox.appendChild(st.sel
            ? A.empty('الرسالة غير موجودة', 'ربما حُذفت. اختر رسالة من القائمة.')
            : A.empty('اختر رسالة', 'اضغط على رسالة من القائمة لعرض تفاصيلها والرد عليها.'));
          return;
        }
        const out = A.msgBox();
        const mail = A.mailto(m.email, 'رد: ' + (m.subject || 'رسالتك إلى م. أحمد الديب'));
        const wa = A.waUrl(m.phone);
        const back = A.btn('العودة إلى القائمة', { small: true, icon: 'back', on: function () { st.sel = ''; setHash(''); paintAll(); } });
        back.classList.add('ad-msgback');
        const acts = h('div', { class: 'ad-act' });
        if (mail) { const a = h('a', { class: 'btn p sm' }, A.icon('mail'), 'الرد بالبريد'); a.setAttribute('href', mail); acts.appendChild(a); }
        if (wa) acts.appendChild(h('a', { class: 'btn s sm', href: wa, target: '_blank', rel: 'noopener noreferrer' }, ui.waIcon(), 'مراسلة عبر واتساب'));
        const mk = function (label, to, okText, kind) {
          const b = A.btn(label, { small: true, kind: kind || 's' });
          b.addEventListener('click', A.run(b, out, async function () { ui.clearMsg(out); await setStatus(m, to, okText)(); }));
          return b;
        };
        if (m.status === 'new') acts.appendChild(mk('تعليم كمقروءة', 'read', 'عُلّمت الرسالة كمقروءة.', 'p'));
        if (m.status === 'read') acts.appendChild(mk('تعليم كجديدة', 'new', 'أُعيدت الرسالة إلى «جديدة».'));
        if (m.status !== 'archived') acts.appendChild(mk('أرشفة', 'archived', 'تمت أرشفة الرسالة.'));
        else acts.appendChild(mk('إلغاء الأرشفة', 'read', 'أُلغيت أرشفة الرسالة.'));
        const del = A.btn('حذف', { small: true, kind: 'danger', icon: 'trash' });
        del.addEventListener('click', A.run(del, out, async function () {
          ui.clearMsg(out);
          const ok = await A.confirm({
            title: 'حذف هذه الرسالة؟', message: 'ستُحذف رسالة «' + m.name + '» نهائيًا من الصندوق.', detail: 'للاحتفاظ بها دون أن تظهر ضمن الجديدة استعمل «أرشفة» بدل الحذف. لا يمكن التراجع عن الحذف.',
            ok: 'حذف نهائي', danger: true
          });
          if (!ok) return;
          const r = await P.rest.remove('contact_messages', { id: 'eq.' + m.id });
          if (!r.length) throw A.noRows();
          rows = rows.filter(function (x) { return x.id !== m.id; });
          st.sel = '';
          setHash('');
          A.toast('ok', 'تم حذف الرسالة.');
          A.setBadge(unread());
          paintAll();
        }));
        acts.appendChild(del);
        const kv = h('dl', { class: 'ad-kv' },
          h('dt', { text: 'البريد' }), h('dd', null, h('span', { class: 'ad-ltr', text: m.email })),
          h('dt', { text: 'الهاتف' }), h('dd', null, m.phone ? h('span', { class: 'ad-ltr', text: m.phone }) : '—'),
          h('dt', { text: 'الوقت' }), h('dd', { text: A.fmtDate(m.created_at) }),
          h('dt', { text: 'الحالة' }), h('dd', null, A.statusBadge('message', m.status)));
        detailBox.appendChild(h('article', { class: 'pf-card ad-msgdetail', 'aria-label': 'تفاصيل الرسالة' },
          back, h('h3', { dir: 'auto', text: m.subject || 'بدون موضوع' }), h('p', { class: 'ad-sub', dir: 'auto', text: 'من: ' + m.name }), kv,
          h('div', { class: 'ad-msgbody', dir: 'auto', text: m.message }), acts, out));
      }
      function paintAll() {
        inbox.className = 'ad-inbox' + (st.sel ? ' sel' : '');
        paintChips();
        paintList();
        paintDetail();
      }
      search.addEventListener('input', A.debounce(function () { st.q = search.value; paintList(); paintChips(); }, 160));
      body.appendChild(h('div', { class: 'ad-tools' }, A.field('بحث', search), chips));
      body.appendChild(inbox);
      paintAll();
    }

    async function load() {
      A.clear(body);
      body.appendChild(A.loading('جارٍ تحميل الرسائل…'));
      refresh.disabled = true;
      try { rows = await A.all('contact_messages', { select: 'id,name,email,phone,subject,message,status,created_at', order: 'created_at.desc,id.asc' }, 3000); } catch (err) {
        refresh.disabled = false;
        if (A.stale(token)) return;
        if (A.isSession(err)) { A.lost('expired'); return; }
        A.clear(body);
        body.appendChild(A.fail(A.errText(err), load));
        return;
      }
      refresh.disabled = false;
      if (A.stale(token)) return;
      A.setBadge(unread());
      build();
    }
    refresh.addEventListener('click', load);
    await load();
  }

  A.register('messages', { label: 'الرسائل', render: render });
})();
