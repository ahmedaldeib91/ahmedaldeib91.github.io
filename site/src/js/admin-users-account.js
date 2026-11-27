/* =====================================================================
   admin-users-account.js — بطاقتا «تعديل البيانات» و«إدارة الحساب» في صفحة المستخدم (#trainees/<uuid>) (للمدير وحده)
   ملف عادي (ES2017) يُحمَّل بـ defer قبل admin-trainees.js. يعرّف A.userAccount = { profileCard, accountCard }.
   - تعديل البيانات: الاسم والهاتف والدولة عبر REST (تسمح RLS للمدير؛ الدور وid لا يُعدَّلان من REST).
   - إدارة الحساب: عبر وظيفة Supabase «admin-users» (صلاحية Auth Admin، للمدير النشط فقط، وكل إجراء يُسجَّل في سجل التدقيق):
     رابط إعادة تعيين كلمة المرور بالبريد، كلمة مرور مؤقتة تظهر مرة واحدة، تأكيد البريد، تغيير البريد، منع/السماح بالدخول،
     ترقية إلى مدير/تحويل إلى متدرب، حذف الحساب نهائيًا. حواجز الأمان مطبّقة في الوظيفة نفسها، والواجهة تُخفي ما لا يُسمح به.
   - لا تُكتب كلمة المرور في أي سجل ولا تُعرض إلا لمرة واحدة بعد التعيين. كل نص من الخادم يُعرض بـ textContent وبرسائل عربية جاهزة.
   ===================================================================== */
(function () {
  'use strict';

  const A = window.Admin;
  if (!A) return;
  const P = A.P;
  const h = A.h;
  const ui = A.ui;
  const doc = document;

  const FN_TEXT = {
    auth_required: 'انتهت الجلسة. سجّل الدخول من جديد.',
    invalid_token: 'انتهت الجلسة. سجّل الدخول من جديد.',
    forbidden: 'هذا الإجراء للمدير فقط.',
    rate_limited: 'تجاوزتَ حدّ الإجراءات (٣٠ في الدقيقة). انتظر دقيقة ثم أعد المحاولة.',
    user_not_found: 'لم نجد هذا الحساب. حدّث الصفحة.',
    invalid_user_id: 'معرّف الحساب غير صالح.',
    account_has_no_email: 'هذا الحساب لا يحمل بريدًا إلكترونيًا.',
    mail_failed: 'تعذّر إرسال البريد الآن. جرّب كلمة مرور مؤقتة بدلًا منه.',
    weak_password: 'كلمة المرور يجب أن تكون من ٨ إلى ٧٢ حرفًا.',
    invalid_email: 'اكتب بريدًا إلكترونيًا صحيحًا.',
    email_taken: 'هذا البريد مستعمل لحساب آخر.',
    forbidden_on_admin: 'لا يُسمح بهذا الإجراء على حساب مدير آخر.',
    forbidden_on_self: 'لا يُسمح بهذا الإجراء على حسابك أنت.',
    confirm_required: 'يلزم تأكيد هذا الإجراء.',
    invalid_role: 'دور غير صالح.',
    no_change: 'لا تغيير: الحساب بهذا الدور مسبقًا.',
    network: 'تعذّر الاتصال بالخادم. تحقق من الإنترنت ثم أعد المحاولة.',
    not_deployed: 'خدمة إدارة الحسابات غير مفعّلة بعد على الخادم (وظيفة admin-users). انشرها من لوحة Supabase أولًا.',
    server_error: 'حدث خطأ في الخادم. حاول مرة أخرى بعد قليل.',
    other: 'تعذّر تنفيذ الإجراء. حاول مرة أخرى.'
  };
  const fnText = function (r) { return Object.prototype.hasOwnProperty.call(FN_TEXT, r.error) ? FN_TEXT[r.error] : FN_TEXT.other; };

  async function call(action, id, extra) {
    const r = await P.adminFn.call(Object.assign({ action: action, user_id: id }, extra || {}));
    if (!r.ok && (r.error === 'auth_required' || r.error === 'invalid_token')) A.lost('expired');
    return r;
  }

  /* كلمة مرور عشوائية ١٤ حرفًا بلا أحرف ملتبسة (0 O l 1 I) وفيها حرف كبير وصغير ورقم */
  function genPassword() {
    const U = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const L = 'abcdefghijkmnpqrstuvwxyz';
    const D = '23456789';
    const all = U + L + D;
    const buf = new Uint32Array(14);
    window.crypto.getRandomValues(buf);
    const pick = function (set, n) { return set.charAt(n % set.length); };
    const out = [pick(U, buf[0]), pick(L, buf[1]), pick(D, buf[2])];
    for (let i = 3; i < 14; i++) out.push(pick(all, buf[i]));
    for (let i = out.length - 1; i > 0; i--) { const j = buf[i] % (i + 1); const t = out[i]; out[i] = out[j]; out[j] = t; }
    return out.join('');
  }

  /* نافذة بمحتوى مخصّص وزرّي إلغاء/تأكيد؛ تعيد true عند التأكيد. validate() تعيد نص خطأ أو '' */
  function dialog(title, kids, okLabel, o) {
    o = o || {};
    return new Promise(function (resolve) {
      const prev = doc.activeElement;
      const tid = A.nid('dlg-t');
      const err = h('p', { class: 'pf-ferr', role: 'alert', hidden: true });
      const ok = h('button', { type: 'button', class: 'btn p' + (o.danger ? ' ad-dangerp' : ''), text: okLabel });
      const cancel = h('button', { type: 'button', class: 'btn s', text: 'إلغاء' });
      const dlg = h('dialog', { class: 'ad-dialog', 'aria-labelledby': tid },
        h('div', { class: 'ad-dlgbody' }, h('h3', { id: tid, text: title }), kids, err, h('div', { class: 'btns ad-dlgact' }, cancel, ok)));
      let done = false;
      function end(v) {
        if (done) return;
        done = true;
        try { dlg.close(); } catch (e) { /* مغلقة */ }
        dlg.remove();
        try { if (prev && prev.focus) prev.focus(); } catch (e) { /* تجاهل */ }
        resolve(v);
      }
      ok.addEventListener('click', function () {
        const msg = o.validate ? o.validate() : '';
        if (msg) { err.textContent = msg; err.hidden = false; return; }
        end(true);
      });
      cancel.addEventListener('click', function () { end(false); });
      dlg.addEventListener('cancel', function (e) { e.preventDefault(); end(false); });
      doc.body.appendChild(dlg);
      if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
      (o.focus || cancel).focus();
    });
  }

  /* ---------- تعديل البيانات ---------- */
  function profileCard(d, id, reload) {
    const p = d.profile;
    const name = A.input({ max: 120, value: p.full_name || '', aria: 'الاسم' });
    name.setAttribute('dir', 'auto');
    const phone = A.input({ max: 40, value: p.phone || '', ltr: true, inputmode: 'tel', aria: 'الهاتف' });
    const countries = P.COUNTRIES.slice();
    if (p.country && countries.indexOf(p.country) === -1) countries.unshift(p.country);
    const country = A.select([['', '— غير محددة —']].concat(countries.map(function (c) { return [c, c]; })), p.country || '');
    const out = A.msgBox();
    const save = A.btn('حفظ البيانات', { kind: 'p', small: true, type: 'submit' });
    const form = h('form', { class: 'pf-form', novalidate: true, method: 'post', action: '/admin/' },
      h('div', { class: 'ad-cols' }, A.field('الاسم', name), A.field('الهاتف', phone), A.field('الدولة', country)),
      h('div', { class: 'ad-act' }, save, out));
    form.addEventListener('submit', A.run(save, out, async function () {
      ui.clearMsg(out);
      if (Array.from(name.value.trim()).length > 120) { ui.msg(out, 'err', 'الاسم طويل (الحد ١٢٠ حرفًا).'); return; }
      if (Array.from(phone.value.trim()).length > 40) { ui.msg(out, 'err', 'الهاتف طويل (الحد ٤٠ حرفًا).'); return; }
      const rows = await P.rest.update('profiles', { id: 'eq.' + id }, { full_name: name.value.trim(), phone: phone.value.trim() || null, country: country.value || null });
      if (!rows.length) throw A.noRows();
      A.toast('ok', 'تم حفظ بيانات الحساب.');
      await reload();
    }));
    return A.card('تعديل البيانات', form, 'ad-c-edit');
  }

  /* ---------- إدارة الحساب ---------- */
  function accountCard(d, id, reload) {
    const p = d.profile;
    const self = p.id === A.S.uid;
    const isAdmin = p.role === 'admin';
    const name = p.full_name || 'بدون اسم';
    const email = d.email && d.email.email ? d.email.email : '';
    const out = A.msgBox();
    const secret = h('div'); /* كلمة المرور المؤقتة تظهر هنا مرة واحدة */
    const info = h('div', null, h('p', { class: 'ad-sub', text: 'جارٍ قراءة بيانات الدخول…' }));
    const row = h('div', { class: 'ad-acts' });

    function paintInfo(data) {
      A.clear(info);
      const dl = h('dl', { class: 'ad-kv' });
      const kv = function (k, v) { dl.appendChild(h('dt', { text: k })); dl.appendChild(h('dd', null, v)); };
      kv('البريد الإلكتروني', data.email ? h('span', { class: 'ad-ltr', text: data.email }) : '—');
      kv('تأكيد البريد', data.email_confirmed_at ? A.fmtDate(data.email_confirmed_at) : A.badge('غير مؤكَّد', 'warn'));
      kv('آخر تسجيل دخول', data.last_sign_in_at ? A.fmtDate(data.last_sign_in_at) : 'لم يسجّل دخولًا بعد');
      const banned = data.banned_until && Date.parse(data.banned_until) > Date.now();
      kv('الدخول', banned ? A.badge('ممنوع من الدخول', 'err') : A.badge('مسموح', 'ok'));
      info.appendChild(dl);
      info.dataset.banned = banned ? '1' : '';
      info.dataset.confirmed = data.email_confirmed_at ? '1' : '';
      paintButtons();
    }

    function act(label, o, fn) {
      const b = A.btn(label, o);
      b.addEventListener('click', A.run(b, out, async function () {
        ui.clearMsg(out);
        A.clear(secret);
        const r = await fn();
        if (!r) return; /* أُلغي */
        if (!r.ok) { ui.msg(out, 'err', fnText(r)); return; }
        return r;
      }));
      return b;
    }

    function paintButtons() {
      A.clear(row);
      const banned = info.dataset.banned === '1';
      /* رابط إعادة التعيين */
      row.appendChild(act('إرسال رابط إعادة تعيين كلمة المرور', { small: true, icon: 'mail' }, async function () {
        const ok = await A.confirm({ title: 'إرسال رابط إعادة التعيين؟', message: 'سيصل «' + name + '» بريد فيه رابط ليختار كلمة مرور جديدة' + (email ? ' على ' + email : '') + '.', ok: 'إرسال' });
        if (!ok) return null;
        const r = await call('send_reset', id);
        if (r.ok) A.toast('ok', 'أُرسل رابط إعادة التعيين إلى بريد المستخدم.');
        return r;
      }));
      /* كلمة مرور مؤقتة */
      if (!isAdmin || self) {
        row.appendChild(act('تعيين كلمة مرور مؤقتة', { small: true, icon: 'lock', kind: 'p' }, async function () {
          const pw = A.input({ max: 72, value: genPassword(), ltr: true, aria: 'كلمة المرور المؤقتة' });
          pw.setAttribute('autocomplete', 'off');
          const gen = A.btn('توليد أخرى', { small: true, on: function () { pw.value = genPassword(); } });
          const ok = await dialog('كلمة مرور مؤقتة لـ «' + name + '»', h('div', null,
            h('p', { class: 'ad-dlgmsg', text: 'ستحلّ هذه الكلمة محل كلمة مروره الحالية فورًا. سلّمها له بقناة خاصة (واتساب مثلًا) وانصحه بتغييرها بعد الدخول.' }),
            A.field('كلمة المرور (٨ أحرف على الأقل)', pw), gen),
          'تعيين كلمة المرور', { focus: pw, validate: function () { return pw.value.length >= 8 && pw.value.length <= 72 ? '' : 'كلمة المرور من ٨ إلى ٧٢ حرفًا.'; } });
          if (!ok) return null;
          const value = pw.value;
          const r = await call('set_password', id, { password: value });
          if (r.ok) {
            const copy = A.btn('نسخ', { small: true });
            copy.addEventListener('click', function () {
              try { navigator.clipboard.writeText(value).then(function () { A.toast('ok', 'نُسخت كلمة المرور.'); }); } catch (e) { A.toast('err', 'تعذّر النسخ تلقائيًا: انسخها يدويًا.'); }
            });
            secret.appendChild(h('div', { class: 'ad-note' },
              h('p', { text: 'عُيّنت كلمة المرور المؤقتة. تُعرض هنا مرة واحدة فقط ولا تُحفظ في أي مكان:' }),
              h('p', null, h('code', { class: 'ad-ltr', text: value }), ' ', copy)));
            A.announce('عُيّنت كلمة المرور المؤقتة.');
          }
          return r;
        }));
      }
      /* تأكيد البريد */
      if (info.dataset.confirmed !== '1') {
        row.appendChild(act('تأكيد البريد يدويًا', { small: true, icon: 'check' }, async function () {
          const r = await call('confirm_email', id);
          if (r.ok) { A.toast('ok', 'تم تأكيد البريد.'); await reload(); }
          return r;
        }));
      }
      /* منع/السماح بالدخول */
      if (!self && !isAdmin) {
        row.appendChild(act(banned ? 'السماح بالدخول' : 'منع تسجيل الدخول', { small: true, kind: banned ? 'p' : 'danger', icon: banned ? 'check' : 'lock' }, async function () {
          if (!banned) {
            const ok = await A.confirm({ title: 'منع «' + name + '» من تسجيل الدخول؟', message: 'لن يستطيع تسجيل الدخول إلى المنصة إطلاقًا حتى تسمح له من جديد.', detail: 'يختلف هذا عن «إيقاف الحساب» الذي يحجب المحتوى فقط. يُسجَّل الإجراء في سجل التدقيق.', ok: 'منع الدخول', danger: true });
            if (!ok) return null;
          }
          const r = await call(banned ? 'unban' : 'ban', id);
          if (r.ok) { A.toast('ok', banned ? 'سُمح له بالدخول.' : 'مُنع من الدخول.'); await reload(); }
          return r;
        }));
      }
      /* الدور */
      if (!self) {
        row.appendChild(act(isAdmin ? 'تحويل إلى متدرب' : 'ترقية إلى مدير', { small: true, kind: isAdmin ? undefined : 'danger', icon: 'users' }, async function () {
          const ok = await A.confirm({
            title: (isAdmin ? 'سحب صلاحية المدير من «' : 'ترقية «') + name + (isAdmin ? '»؟' : '» إلى مدير؟'),
            message: isAdmin ? 'سيفقد الوصول إلى لوحة المدرب ويصير متدربًا عاديًا.' : 'سيرى كل بيانات المنصة ويتحكم بكل الحسابات والدورات والأسئلة. امنحها لمن تثق به تمامًا.',
            detail: 'يُسجَّل الإجراء في سجل التدقيق.', ok: isAdmin ? 'تحويل إلى متدرب' : 'ترقية إلى مدير', danger: !isAdmin
          });
          if (!ok) return null;
          const r = await call('set_role', id, { role: isAdmin ? 'trainee' : 'admin', confirm: true });
          if (r.ok) { A.toast('ok', isAdmin ? 'تحوّل إلى متدرب.' : 'رُقّي إلى مدير.'); await reload(); }
          return r;
        }));
      }
      /* حذف نهائي */
      if (!self && !isAdmin) {
        row.appendChild(act('حذف الحساب نهائيًا', { small: true, kind: 'danger', icon: 'trash' }, async function () {
          const word = email || name;
          const typed = A.input({ max: 254, ltr: !!email, aria: 'اكتب للتأكيد' });
          const ok = await dialog('حذف حساب «' + name + '» نهائيًا؟', h('div', null,
            h('p', { class: 'ad-dlgmsg', text: 'سيُحذف الحساب وبياناته واشتراكاته ومحاولاته بلا رجعة، ولا يمكن استرجاعها.' }),
            A.field('للتأكيد اكتب: ' + word, typed)),
          'حذف نهائيًا', { danger: true, focus: typed, validate: function () { return typed.value.trim() === word ? '' : 'النص المكتوب لا يطابق «' + word + '».'; } });
          if (!ok) return null;
          const r = await call('delete_user', id, { confirm: true });
          if (r.ok) { A.toast('ok', 'حُذف الحساب.'); window.location.hash = '#trainees'; }
          return r;
        }));
      }
      /* تغيير البريد */
      if (!isAdmin || self) {
        row.appendChild(act('تغيير البريد الإلكتروني', { small: true, icon: 'mail' }, async function () {
          const em = A.input({ type: 'email', max: 254, ltr: true, value: email, aria: 'البريد الجديد' });
          const ok = await dialog('تغيير بريد «' + name + '»', h('div', null,
            h('p', { class: 'ad-dlgmsg', text: 'سيصير هذا البريد هو بريد الدخول فورًا ويُعتبر مؤكَّدًا. أبلغ المستخدم بالتغيير.' }),
            A.field('البريد الجديد', em)),
          'تغيير البريد', { focus: em, validate: function () { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(em.value.trim()) ? '' : 'اكتب بريدًا صحيحًا.'; } });
          if (!ok) return null;
          const r = await call('set_email', id, { email: em.value.trim() });
          if (r.ok) { A.toast('ok', 'تغيّر البريد.'); await reload(); }
          return r;
        }));
      }
    }

    /* قراءة بيانات الدخول من الوظيفة (لا تمنع بقية الصفحة إن لم تكن منشورة) */
    call('get', id).then(function (r) {
      if (!info.isConnected) return;
      if (r.ok) { paintInfo(r.data); return; }
      A.clear(info);
      info.appendChild(h('p', { class: 'ad-note warn', text: fnText(r) }));
      paintButtons();
    });
    paintButtons();

    return A.card('إدارة الحساب وكلمة المرور', [
      h('p', { class: 'ad-sub', text: self ? 'هذا حسابك: بعض الإجراءات الحساسة مخفية.' : 'مشكلة في كلمة المرور؟ أرسل رابط إعادة تعيين أو عيّن كلمة مرور مؤقتة. كل إجراء يُسجَّل في سجل التدقيق.' }),
      info, row, out, secret
    ], 'ad-c-acct');
  }

  A.userAccount = { profileCard: profileCard, accountCard: accountCard, genPassword: genPassword };
})();
