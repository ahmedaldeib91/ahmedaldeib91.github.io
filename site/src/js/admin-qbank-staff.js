/* =====================================================================
   admin-qbank-staff.js — تبويب «الفريق» في قسم بنك الأسئلة (#qbank/<course>/staff)
   مدرّبو الدورة المختارة (جدول course_staff: صف نشط = مدرّب، والكتابة للمدير وحده بسياسات RLS):
   عرض المعيَّنين مع صلاحياتهم، وإضافة مستخدم بالبحث في الأسماء والبريد والهاتف (من دليل المدير نفسه A.loadDirectory كما في الاشتراكات)،
   وتعديل أعلام الصلاحيات (المفاتيح الثمانية الثابتة private.staff_permission_keys فقط، قيمها منطقية)، وتعطيل/تفعيل الصف، وإزالته.
   التدقيق (audit_log: course_staff.granted|updated|deactivated|reactivated|deleted) يكتبه مشغّل القاعدة، فلا يُكتب شيء من هنا.
   تنبيه ثابت في الواجهة: دخول المدرّب إلى /admin/ غير مفعّل بعد (البوابة للمدير فقط)، فالصلاحيات هنا تُخزَّن لتُستعمل لاحقًا.
   ===================================================================== */
(function () {
  'use strict';

  const A = window.Admin;
  if (!A || !A.qb) return;
  const QB = A.qb;
  const P = A.P;
  const h = A.h;
  const ui = A.ui;
  const nameOr = function (p) { return (p && p.full_name) || 'بدون اسم'; };

  /* عناوين مقروءة لإدخالات سجل التدقيق الجديدة في جدول التدقيق العام (الإعدادات وصفحة المتدرب) */
  if (A.AUDIT && typeof A.AUDIT === 'object') {
    Object.assign(A.AUDIT, {
      'course_staff.granted': 'تعيين مدرّب لدورة', 'course_staff.updated': 'تعديل صلاحيات مدرّب', 'course_staff.deactivated': 'تعطيل مدرّب',
      'course_staff.reactivated': 'إعادة تفعيل مدرّب', 'course_staff.deleted': 'إزالة مدرّب من دورة',
      'qb_question.created': 'إنشاء سؤال في البنك', 'qb_question.status_changed': 'تغيير حالة سؤال', 'qb_question.deleted': 'حذف سؤال من البنك'
    });
  }

  /* صلاحيات صفّ: كائن بالمفاتيح الثمانية كلها قيمًا منطقية صريحة (qbank.write تفرض qbank.read) */
  function permsOf(boxes) {
    const out = {};
    QB.PERMS.forEach(function (p) { out[p[0]] = !!boxes[p[0]].input.checked; });
    if (out['qbank.write']) out['qbank.read'] = true;
    return out;
  }
  function permBoxes(current, idleHint) {
    const boxes = {};
    const wrap = h('div', { class: 'ad-qb-perms' });
    QB.PERMS.forEach(function (p) {
      const cb = A.checkbox(p[1], !!(current && current[p[0]]), p[2]);
      boxes[p[0]] = cb;
      wrap.appendChild(cb.el);
    });
    boxes['qbank.write'].input.addEventListener('change', function () { if (boxes['qbank.write'].input.checked) boxes['qbank.read'].input.checked = true; });
    if (idleHint) wrap.appendChild(h('p', { class: 'pf-hint', text: idleHint }));
    return { boxes: boxes, el: wrap };
  }
  const permBadges = function (perms) {
    const on = QB.PERMS.filter(function (p) { return perms && perms[p[0]] === true; });
    if (!on.length) return h('span', { class: 'ad-muted', text: 'بلا صلاحيات' });
    return h('div', { class: 'ad-badges' }, on.map(function (p) { return A.badge(p[3], p[0].indexOf('qbank') === 0 ? 'info' : 'mut'); }));
  };

  async function renderStaff(panel, o) {
    const course = o.course;
    const token = o.token;
    const refresh = A.btn('تحديث', { icon: 'refresh', small: true });
    panel.appendChild(h('div', { class: 'ad-qb-bar' }, refresh));
    panel.appendChild(h('p', { class: 'ad-note warn', text: 'ملاحظة: تعيين المدرّب هنا يخزّن صلاحياته في قاعدة البيانات فقط. دخول المدرّبين إلى لوحة /admin/ غير مفعّل بعد (البوابة الحالية للمدير وحده)، لذلك لن يستطيع المدرّب المعيَّن استعمال هذه الأقسام الآن. المدير يملك كل الصلاحيات تلقائيًا ولا يحتاج إلى تعيين.' }));
    const body = h('div');
    panel.appendChild(body);
    let rows = [];
    let dir = null;

    async function fetchRows() {
      rows = await A.all('course_staff', { select: 'user_id,staff_role,permissions,active,granted_by,created_at,updated_at', course_id: 'eq.' + course, order: 'created_at.asc,user_id.asc' });
    }
    async function reload() {
      try { await fetchRows(); } catch (err) { if (!A.stale(token)) QB.loadFail(body, err, load); return; }
      if (A.stale(token)) return;
      paint();
    }
    async function load(force) {
      A.clear(body);
      body.appendChild(A.loading('جارٍ تحميل فريق الدورة…'));
      refresh.disabled = true;
      try {
        const r = await Promise.all([fetchRows(), force || !A.S.dir ? A.loadDirectory() : Promise.resolve(A.S.dir)]);
        dir = r[1];
      } catch (err) {
        refresh.disabled = false;
        if (A.stale(token)) return;
        QB.loadFail(body, err, load);
        return;
      }
      refresh.disabled = false;
      if (A.stale(token)) return;
      paint();
    }

    const profileOf = function (id) { return dir && dir.byId[id] ? dir.byId[id] : null; };
    const emailOf = function (id) { return dir && dir.emails[id] ? dir.emails[id].email : ''; };
    const matches = function (p, q) {
      if (!q) return true;
      const nq = A.normAr(q);
      const digits = A.latinDigits(q).replace(/\D/g, '');
      if (A.normAr([p.full_name, emailOf(p.id), p.phone].join(' ')).indexOf(nq) !== -1) return true;
      return digits.length >= 3 && A.latinDigits(p.phone || '').replace(/\D/g, '').indexOf(digits) !== -1;
    };

    /* ---------- صف مدرّب ---------- */
    function staffRow(r) {
      const p = profileOf(r.user_id);
      const out = A.msgBox();
      const holder = h('div', { class: 'ad-edit', hidden: true });
      const label = nameOr(p);
      const eBtn = A.btn('الصلاحيات', { small: true });
      eBtn.addEventListener('click', function () {
        if (!holder.hidden) { holder.hidden = true; A.clear(holder); return; }
        holder.hidden = false;
        A.clear(holder);
        const pb = permBoxes(r.permissions);
        const msg = A.msgBox();
        const save = A.btn('حفظ الصلاحيات', { kind: 'p', small: true });
        save.addEventListener('click', QB.run(save, msg, 'staff', async function () {
          ui.clearMsg(msg);
          const rowsUp = await P.rest.update('course_staff', { course_id: 'eq.' + course, user_id: 'eq.' + r.user_id }, { permissions: permsOf(pb.boxes) });
          if (!rowsUp.length) throw A.noRows();
          A.toast('ok', 'تم حفظ صلاحيات «' + label + '».');
          await reload();
        }));
        holder.appendChild(h('div', { class: 'pf-form' }, h('h4', { text: 'صلاحيات «' + label + '» في هذه الدورة' }), pb.el, h('div', { class: 'ad-act' }, save, A.btn('إلغاء', { small: true, on: function () { holder.hidden = true; A.clear(holder); } }), msg)));
      });
      const tBtn = A.btn(r.active ? 'تعطيل' : 'تفعيل', { small: true, kind: r.active ? 'danger' : 'p' });
      tBtn.addEventListener('click', QB.run(tBtn, out, 'staff', async function () {
        ui.clearMsg(out);
        if (r.active) {
          const ok = await A.confirm({
            title: 'تعطيل «' + label + '»؟',
            message: 'سيفقد كل صلاحياته في هذه الدورة فورًا، وتبقى صلاحياته محفوظة لتعيد تفعيله لاحقًا.',
            detail: 'يُسجَّل الإجراء في سجل التدقيق باسمك.', ok: 'تعطيل', danger: true
          });
          if (!ok) return;
        }
        const up = await P.rest.update('course_staff', { course_id: 'eq.' + course, user_id: 'eq.' + r.user_id }, { active: !r.active });
        if (!up.length) throw A.noRows();
        A.toast('ok', r.active ? 'تم تعطيل المدرّب.' : 'تمت إعادة تفعيل المدرّب.');
        await reload();
      }));
      const del = A.btn('إزالة', { small: true, kind: 'danger' });
      del.addEventListener('click', QB.run(del, out, 'staff', async function () {
        ui.clearMsg(out);
        const ok = await A.confirm({
          title: 'إزالة «' + label + '» من فريق الدورة؟',
          message: 'سيُحذف تعيينه وصلاحياته في هذه الدورة نهائيًا. لا يتأثر حسابه ولا اشتراكاته.',
          detail: 'إن أردت إيقاف صلاحياته مؤقتًا فاستعمل «تعطيل».', ok: 'إزالة', danger: true
        });
        if (!ok) return;
        const gone = await P.rest.remove('course_staff', { course_id: 'eq.' + course, user_id: 'eq.' + r.user_id });
        if (!gone.length) throw A.noRows();
        A.toast('ok', 'تمت إزالة المدرّب من الدورة.');
        await reload();
      }));
      return h('li', { class: 'ad-qb-staff' + (r.active ? '' : ' ad-qb-off') },
        h('div', { class: 'ad-qb-staffhead' },
          h('div', { class: 'ad-qb-nodet' },
            h('b', { dir: 'auto', text: label }),
            emailOf(r.user_id) ? h('small', { class: 'ad-ltr', text: emailOf(r.user_id) }) : null,
            A.badge(r.active ? 'نشط' : 'معطّل', r.active ? 'ok' : 'mut'),
            p && p.status !== 'active' ? A.badge('الحساب موقوف: لا صلاحيات فعلية', 'err') : null),
          h('div', { class: 'ad-iact' }, eBtn, tBtn, del)),
        h('div', { class: 'ad-qb-staffperm' }, permBadges(r.permissions), h('small', { class: 'ad-muted', text: 'منذ ' + A.fmtDay(r.created_at) })),
        out, holder);
    }

    /* ---------- إضافة مدرّب ---------- */
    function addCard() {
      const search = A.input({ type: 'search', max: 120, placeholder: 'اسم أو بريد أو هاتف (أو اتركه فارغًا لعرض الأحدث)' });
      const list = h('ul', { class: 'ad-picks', 'aria-label': 'نتائج البحث عن المستخدمين' });
      const permHost = h('div');
      const rid = A.nid('stf');
      let picked = null;
      const taken = new Set(rows.map(function (r) { return r.user_id; }));

      function paintPerm() {
        A.clear(permHost);
        if (!picked) return;
        const pb = permBoxes({ 'qbank.read': true }, 'تُحفظ كل المفاتيح الثمانية قيمًا صريحة. يمكن تعديلها لاحقًا.');
        const msg = A.msgBox();
        const add = A.btn('تعيين كمدرّب لهذه الدورة', { kind: 'p', small: true, icon: 'plus' });
        add.addEventListener('click', QB.run(add, msg, 'staff', async function () {
          ui.clearMsg(msg);
          const who = picked;
          const ins = await P.rest.insert('course_staff', { course_id: course, user_id: who.id, staff_role: 'instructor', permissions: permsOf(pb.boxes), active: true });
          if (!ins.length) throw A.noRows();
          picked = null;
          A.toast('ok', 'تم تعيين «' + nameOr(who) + '» مدرّبًا لهذه الدورة.');
          await reload();
        }));
        permHost.appendChild(h('div', { class: 'ad-qform' }, h('h4', { text: 'صلاحيات «' + nameOr(picked) + '»' }), pb.el, h('div', { class: 'ad-act' }, add, msg)));
      }
      function paintList() {
        A.clear(list);
        const q = search.value.trim();
        const found = dir.profiles.filter(function (p) { return p.role !== 'admin' && matches(p, q); });
        found.sort(function (a, b) { return Date.parse(b.created_at) - Date.parse(a.created_at); });
        if (!found.length) { list.appendChild(h('li', null, A.empty('لا نتائج', 'لا يوجد مستخدم (غير مدير) يطابق بحثك.'))); return; }
        found.slice(0, 8).forEach(function (p) {
          const dis = taken.has(p.id) || p.status !== 'active';
          const radio = h('input', { type: 'radio', name: rid, value: p.id, disabled: dis, 'aria-label': 'اختيار ' + nameOr(p) });
          radio.checked = !!picked && picked.id === p.id;
          radio.addEventListener('change', function () { if (radio.checked) { picked = p; paintPerm(); } });
          list.appendChild(h('li', null, h('label', { class: 'ad-pick' + (dis ? ' dis' : '') }, radio,
            h('span', { class: 'ad-pt' }, h('b', { dir: 'auto', text: nameOr(p) }), h('small', { class: 'ad-ltr', text: [emailOf(p.id), p.phone].filter(Boolean).join('  ·  ') || '—' })),
            taken.has(p.id) ? A.badge('مدرّب بالفعل', 'ok') : null,
            p.status !== 'active' ? A.badge('موقوف', 'err') : null)));
        });
      }
      search.addEventListener('input', A.debounce(paintList, 160));
      paintList();
      const kids = [
        h('p', { class: 'ad-sub', text: 'ابحث عن المستخدم ثم اختره وحدّد صلاحياته. يُعرض أحدث ٨ مطابقين، والمديرون مستثنون لأن لهم كل الصلاحيات.' }),
        A.field('بحث عن مستخدم', search), list, permHost
      ];
      if (!dir.emailsOk) kids.unshift(h('p', { class: 'ad-note warn', text: 'البحث بالبريد غير متاح الآن: يلزم تطبيق الملف supabase/migrations/006_admin_user_emails.sql. يعمل البحث بالاسم والهاتف.' }));
      return A.card('تعيين مدرّب جديد', kids);
    }

    function paint() {
      A.clear(body);
      const kids = [h('p', { class: 'ad-sub', text: 'المدرّبون المعيَّنون لهذه الدورة وصلاحياتهم. التغييرات تُسجَّل في سجل التدقيق باسمك.' })];
      if (!rows.length) kids.push(A.empty('لا مدرّبين معيَّنين لهذه الدورة', 'عيّن مدرّبًا من البطاقة التالية.'));
      else kids.push(h('ul', { class: 'ad-list ad-qb-stafflist', 'aria-label': 'مدرّبو الدورة' }, rows.map(staffRow)));
      body.appendChild(A.card('مدرّبو الدورة (' + A.num(rows.length) + ')', kids));
      body.appendChild(addCard());
    }

    refresh.addEventListener('click', function () { load(true); });
    await load(false);
  }

  QB.mods.staff = { render: renderStaff };
})();
