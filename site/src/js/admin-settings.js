/* =====================================================================
   admin-settings.js — قسم «الإعدادات» (#settings) في لوحة المدرب
   (١) إعلان لوحة المتدرب: site_settings بالمفتاح dashboard_announcement وقيمته {"text","active"} (وtrainee_visible=true كي يقرأه المتدربون)،
       مع معاينة بشكله في لوحة المتدرب. (٢) بياناتك الشخصية: الاسم والهاتف فقط (الدور لا يتغير من الواجهة أبدًا).
   (٣) سجل التدقيق: آخر الإجراءات (منح/إلغاء اشتراك وتغيير حالة حساب) للقراءة فقط، ٥٠ إدخالًا في كل دفعة.
   ===================================================================== */
(function () {
  'use strict';

  const A = window.Admin;
  if (!A) return;
  const P = A.P;
  const h = A.h;
  const ui = A.ui;
  const KEY = 'dashboard_announcement';
  const AUDIT_PAGE = 50;

  async function render(root, args, token) {
    const refresh = A.btn('تحديث', { icon: 'refresh', small: true });
    root.appendChild(A.head('الإعدادات', 'إعلان لوحة المتدرب وبياناتك الشخصية وسجل التدقيق.', [refresh]));
    const body = h('div');
    root.appendChild(body);

    /* ---------- الإعلان ---------- */
    function announceCard(row) {
      const v = row && row.value && typeof row.value === 'object' ? row.value : {};
      const ta = A.textarea({ max: 600, rows: 4, value: typeof v.text === 'string' ? v.text : '', placeholder: 'مثال: تبدأ الدفعة الجديدة من دورة PMP يوم السبت القادم. للحجز تواصل معنا عبر واتساب.' });
      const act = A.checkbox('تفعيل الإعلان: يظهر أعلى لوحة كل متدرب', v.active === true);
      const counter = h('p', { class: 'ad-counter' });
      const pvText = h('p');
      const pv = h('div', { class: 'pf-announce' }, ui.icon('megaphone'), pvText);
      const pvWrap = h('div', null, h('p', { class: 'ad-sub', text: 'معاينة كما يراها المتدرب:' }), pv);
      function upd() {
        counter.textContent = ta.value.length + ' / 600';
        pvText.textContent = ta.value.trim() || 'اكتب نص الإعلان ليظهر هنا.';
        pvWrap.className = act.input.checked ? '' : 'ad-off';
      }
      ta.addEventListener('input', upd);
      act.input.addEventListener('change', upd);
      upd();
      const out = A.msgBox();
      const btn = A.btn('حفظ الإعلان', { kind: 'p', small: true, type: 'submit' });
      const form = h('form', { class: 'pf-form', novalidate: true, method: 'post', action: '/admin/' },
        A.field('نص الإعلان', ta, 'يظهر نصًا عاديًا. اتركه معطّلًا ليختفي الإعلان من اللوحات.'), counter, act.el, pvWrap, h('div', { class: 'ad-act' }, btn, out));
      A.clearInvalidOnInput(form);
      form.addEventListener('submit', A.run(btn, out, async function () {
        ui.clearMsg(out);
        const text = ta.value.trim();
        const active = act.input.checked;
        if (active && !text) { ui.fieldError(ta, 'اكتب نص الإعلان أو عطّل التفعيل.'); ta.focus(); return; }
        ui.fieldError(ta, '');
        const value = { text: text, active: active };
        let rows;
        if (row) rows = await P.rest.update('site_settings', { key: 'eq.' + KEY }, { value: value });
        else rows = await P.rest.insert('site_settings', { key: KEY, value: value, trainee_visible: true });
        if (!rows.length) throw A.noRows();
        row = rows[0];
        ui.msg(out, 'ok', active ? 'تم حفظ الإعلان وهو ظاهر الآن في لوحات المتدربين.' : 'تم حفظ الإعلان وهو معطّل (غير ظاهر).');
      }));
      return A.card('إعلان لوحة المتدرب', form);
    }

    /* ---------- بياناتي ---------- */
    function profileCard() {
      const me = A.S.me;
      const name = A.input({ max: 120, value: me.full_name || '', auto: 'name', required: true });
      const phone = A.input({ type: 'tel', max: 40, value: me.phone || '', ltr: true, auto: 'tel', inputmode: 'tel' });
      const out = A.msgBox();
      const btn = A.btn('حفظ بياناتي', { kind: 'p', small: true, type: 'submit' });
      const form = h('form', { class: 'pf-form', novalidate: true, method: 'post', action: '/admin/' },
        A.field('الاسم', name), A.field('رقم الهاتف (اختياري)', phone, 'مع رمز الدولة، مثل +966501234567.'),
        h('p', { class: 'ad-sub', text: 'البريد الإلكتروني والدور لا يتغيران من هنا.' }), h('div', { class: 'ad-act' }, btn, out));
      A.clearInvalidOnInput(form);
      form.addEventListener('submit', A.run(btn, out, async function () {
        ui.clearMsg(out);
        const bag = {};
        const n = ui.check(name, P.v.name(name.value), bag);
        let ph = null;
        if (phone.value.trim()) ph = ui.check(phone, P.v.phone(phone.value), bag); else ui.fieldError(phone, '');
        if (bag.first) { bag.first.focus(); return; }
        const rows = await P.rest.update('profiles', { id: 'eq.' + A.S.uid }, { full_name: n, phone: ph });
        if (!rows.length) throw A.noRows();
        Object.assign(A.S.me, rows[0]);
        const hello = A.$('ad-hello');
        if (hello) hello.textContent = 'مرحبًا، ' + (A.S.me.full_name || A.S.email);
        name.value = A.S.me.full_name || '';
        phone.value = A.S.me.phone || '';
        ui.msg(out, 'ok', 'تم حفظ بياناتك.');
      }));
      return A.card('بياناتي', form);
    }

    /* ---------- سجل التدقيق ---------- */
    function auditCard() {
      const list = h('div');
      const more = A.btn('تحميل المزيد', { small: true });
      const info = h('p', { class: 'ad-sub', role: 'status' });
      const box = h('div');
      let entries = [];
      let total = null;
      let busy = false;

      async function loadMore(first) {
        if (busy) return;
        busy = true;
        more.disabled = true;
        try {
          const r = await P.rest.page('audit_log', { select: 'id,actor_id,action,entity,entity_id,details,created_at', order: 'created_at.desc,id.asc', limit: String(AUDIT_PAGE), offset: String(entries.length) });
          const ids = [];
          r.rows.forEach(function (e) { Array.prototype.push.apply(ids, A.auditIds(e)); });
          await A.resolveNames(ids);
          if (A.stale(token)) return;
          entries = entries.concat(r.rows);
          total = r.total;
          A.clear(list);
          if (!entries.length) list.appendChild(A.empty('لا إدخالات بعد', 'تُسجَّل هنا عمليات منح الاشتراكات وإلغائها وتغيير حالات الحسابات.'));
          else list.appendChild(A.auditTable(entries));
          info.textContent = entries.length ? 'المعروض: ' + A.num(entries.length) + (total !== null ? ' من ' + A.num(total) : '') : '';
          more.hidden = total !== null ? entries.length >= total : r.rows.length < AUDIT_PAGE;
        } catch (err) {
          if (A.stale(token)) return;
          if (A.isSession(err)) { A.lost('expired'); return; }
          if (first) { A.clear(list); list.appendChild(A.fail(A.errText(err), function () { loadMore(true); })); } else A.failWith(err);
        } finally { busy = false; more.disabled = false; }
      }
      more.addEventListener('click', function () { loadMore(false); });
      list.appendChild(A.loading('جارٍ تحميل السجل…'));
      box.appendChild(list);
      box.appendChild(h('div', { class: 'ad-act' }, more, info));
      loadMore(true);
      return A.card('سجل التدقيق (للقراءة فقط)', [h('p', { class: 'ad-sub', text: 'من فعل ماذا ومتى: الأحدث أولًا.' }), box]);
    }

    async function load() {
      A.clear(body);
      body.appendChild(A.loading('جارٍ تحميل الإعدادات…'));
      refresh.disabled = true;
      let row = null;
      try {
        await A.loadCourses(false);
        row = (await P.rest.select('site_settings', { select: 'key,value,trainee_visible,updated_at', key: 'eq.' + KEY }))[0] || null;
      } catch (err) {
        refresh.disabled = false;
        if (A.stale(token)) return;
        if (A.isSession(err)) { A.lost('expired'); return; }
        A.clear(body);
        body.appendChild(A.fail(A.errText(err), load));
        return;
      }
      refresh.disabled = false;
      if (A.stale(token)) return;
      A.clear(body);
      body.appendChild(h('div', { class: 'ad-two' }, announceCard(row), profileCard()));
      body.appendChild(auditCard());
    }
    refresh.addEventListener('click', load);
    await load();
  }

  A.register('settings', { label: 'الإعدادات', render: render });
})();
