/* =====================================================================
   admin-core.js — نواة لوحة المدرب /admin/: أدوات مشتركة تستعملها أقسام اللوحة (admin-*.js)
   ملف عادي (ES2017) يُحمَّل بـ defer بعد platform-api.js وقبل ملفات الأقسام وadmin.js، ويعرّف window.Admin.
   لا يبني أي واجهة بنفسه ولا يتصل بالشبكة عند التحميل.

   القواعد (نفس قواعد platform-README.txt)
   - كل نص قادم من قاعدة البيانات أو من المستخدم يدخل الصفحة بـ textContent/createElement عبر ui.h فقط، فلا innerHTML ولا خاصية style نصية.
   - كل طلب بتوكن المستخدم يمر بـ Platform.rest/storage (تجديد وإعادة محاولة تلقائيان)، ولا يُقرأ plat_session مباشرة ولا يُسجَّل توكن.
   - إخفاء أجزاء من الواجهة عن غير المدير راحة استعمال فقط؛ الصلاحية الحقيقية تقررها سياسات RLS في القاعدة.
   - كل حذف أو إيقاف أو إلغاء يمر بنافذة تأكيد (A.confirm).
   ===================================================================== */
(function () {
  'use strict';

  const P = window.Platform;
  if (!P) return; /* admin.js يعرض رسالة الخطأ */
  const ui = P.ui;
  const h = ui.h;
  const doc = document;
  const win = window;

  /* حالة الصفحة: nav = رقم الانتقال الحالي (تُهمَل نتائج الطلبات المتأخرة بعد الانتقال إلى قسم آخر) */
  const S = { uid: '', email: '', me: null, nav: 0, courses: [], dir: null, names: {} };
  const A = {
    P: P, ui: ui, h: h, S: S,
    sections: {}, order: [],
    hooks: { wipe: function () {}, forbidden: function () {} } /* يضبطهما admin.js */
  };

  A.$ = function (id) { return doc.getElementById(id); };
  A.clear = ui.clear;
  A.settle = function (p) { return p.then(function (v) { return { ok: true, v: v }; }, function (e) { return { ok: false, e: e }; }); };
  A.stale = function (token) { return token !== S.nav; };
  A.register = function (name, def) { def.name = name; A.sections[name] = def; A.order.push(name); };
  let seq = 0;
  A.nid = function (p) { seq += 1; return (p || 'ad') + '-' + seq; };

  /* ---------- أخطاء ---------- */
  A.errText = function (err) { return err instanceof P.ApiError ? err.message : P.MSG.other; };
  A.isSession = function (err) { return err instanceof P.ApiError && err.kind === 'session'; };
  A.isForbidden = function (err) { return err instanceof P.ApiError && err.kind === 'forbidden'; };
  A.noRows = function () { return new P.ApiError('forbidden', P.MSG.forbidden, 403, 'no_rows'); };
  A.lost = function (reason) { A.hooks.wipe(); P.goLogin(reason || 'expired'); };
  /* خطأ أثناء عملية: الجلسة المنتهية تحوّل إلى الدخول، وغيرها يظهر في out (أو في التنبيه العام إن لم يوجد) */
  A.failWith = function (err, out) {
    if (A.isSession(err)) { A.lost('expired'); return; }
    if (A.isForbidden(err)) A.hooks.forbidden();
    if (out) ui.msg(out, 'err', A.errText(err)); else A.toast('err', A.errText(err));
  };
  /* إدارة التركيز بعد إعادة رسم المحتوى (لمستعملي لوحة المفاتيح): نحفظ رقم العنصر القابل للتركيز داخل #ad-view قبل العملية
     (يُعطَّل الزر أثناءها فيفقد التركيز)، وبعدها إن لم يبقَ التركيز على عنصر صالح نعيده إلى العنصر بالرقم نفسه */
  const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled])';
  A.focusSnapshot = function () {
    const v = A.$('ad-view');
    const a = doc.activeElement;
    if (!v || !a || a === doc.body || !v.contains(a)) return -1;
    return Array.prototype.indexOf.call(v.querySelectorAll(FOCUSABLE), a);
  };
  A.focusRestore = function (idx) {
    if (idx < 0) return;
    const a = doc.activeElement;
    if (a && a !== doc.body && a.isConnected) return;
    const v = A.$('ad-view');
    if (!v) return;
    const list = v.querySelectorAll(FOCUSABLE);
    const el = list[Math.min(idx, list.length - 1)];
    if (el) { try { el.focus(); } catch (e) { /* تجاهل */ } }
  };
  /* معالج نقر/إرسال بلا تكرار ومع ترجمة الأخطاء. fn تعيد قيمة ولا ترمي أخطاء متوقعة بنفسها */
  A.run = function (btn, out, fn) {
    const guarded = ui.guard(btn, out, async function (e) {
      try { await fn(e); } catch (err) { A.failWith(err, out); }
      return false;
    });
    const wrapped = async function (e) {
      const snap = A.focusSnapshot();
      await guarded(e); /* preventDefault يجري داخلها بشكل متزامن */
      A.focusRestore(snap);
    };
    wrapped.reset = guarded.reset;
    return wrapped;
  };

  /* ---------- تنبيهات ---------- */
  let toastTimer = 0;
  A.toast = function (kind, text) {
    const el = A.$('ad-toast-msg');
    if (!el) return;
    ui.msg(el, kind, text);
    clearTimeout(toastTimer);
    if (kind !== 'err') toastTimer = setTimeout(function () { ui.clearMsg(el); }, 6000);
  };
  A.announce = function (text) { /* منطقة حيّة مخفية بصريًا للقارئ الشاشي */
    const el = A.$('ad-announcer');
    if (!el) return;
    el.textContent = '';
    setTimeout(function () { el.textContent = text; }, 40);
  };

  /* ---------- أيقونات ---------- */
  const SVGNS = 'http://www.w3.org/2000/svg';
  const IC = {
    chart: 'M4 20h16 M7 20v-9 M12 20V5 M17 20v-6',
    users: 'M17 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2 M10 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M21 21v-2a4 4 0 0 0-3-3.9 M16 3.1a4 4 0 0 1 0 7.8',
    userplus: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M19 8v6 M22 11h-6',
    book: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20 M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z',
    mail: 'M4 6h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z M3 7l9 6 9-6',
    pen: 'M12 20h9 M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
    gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
    trash: 'M3 6h18 M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2 M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6 M10 11v6 M14 11v6',
    plus: 'M12 5v14 M5 12h14',
    up: 'M12 19V5 M5 12l7-7 7 7',
    down: 'M12 5v14 M19 12l-7 7-7-7',
    search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z M21 21l-4.3-4.3',
    download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M7 10l5 5 5-5 M12 15V3',
    upload: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M17 8l-5-5-5 5 M12 3v12',
    eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    refresh: 'M3 12a9 9 0 0 1 15.5-6.2L21 8 M21 3v5h-5 M21 12a9 9 0 0 1-15.5 6.2L3 16 M3 21v-5h5',
    clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 7v5l3 2',
    inbox: 'M22 12h-6l-2 3h-4l-2-3H2 M5.5 5.1L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.7 4H7.3a2 2 0 0 0-1.8 1.1z',
    archive: 'M21 8v13H3V8 M1 3h22v5H1z M10 12h4'
  };
  A.icon = function (name, cls) {
    if (!Object.prototype.hasOwnProperty.call(IC, name)) return ui.icon(name, cls);
    const s = doc.createElementNS(SVGNS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('focusable', 'false');
    s.setAttribute('class', 'pf-ic' + (cls ? ' ' + cls : ''));
    const p = doc.createElementNS(SVGNS, 'path');
    p.setAttribute('d', IC[name]);
    s.appendChild(p);
    return s;
  };

  /* ---------- مكوّنات صغيرة ---------- */
  A.loading = function (text) {
    return h('div', { class: 'pf-loading', role: 'status' }, h('span', { class: 'pf-spin', 'aria-hidden': 'true' }), text || 'جارٍ التحميل…');
  };
  A.fail = function (text, retry) {
    return h('div', { class: 'pf-fail pf-card' },
      h('p', { class: 'pf-msg err', role: 'alert', text: text }),
      retry ? h('div', { class: 'btns' }, h('button', { type: 'button', class: 'btn p', on: { click: retry } }, 'إعادة المحاولة')) : null);
  };
  A.empty = function (title, text, extra) {
    return h('div', { class: 'pf-empty' }, h('b', { text: title }), text ? h('p', { text: text }) : null, extra || null);
  };
  A.card = function (title, kids, cls) {
    return h('section', { class: 'pf-card ad-card' + (cls ? ' ' + cls : '') }, title ? h('h3', { text: title }) : null, kids);
  };
  /* رأس القسم: العنوان h2 هو هدف التركيز بعد كل انتقال (#ad-title) */
  A.head = function (title, sub, actions) {
    return h('div', { class: 'ad-head' },
      h('div', { class: 'ad-headt' }, h('h2', { class: 'ad-h2', id: 'ad-title', tabindex: '-1', text: title }), sub ? h('p', { class: 'sub', text: sub }) : null),
      actions && actions.length ? h('div', { class: 'ad-hact' }, actions) : null);
  };
  A.badge = function (text, kind) { return h('span', { class: 'ad-badge' + (kind ? ' ' + kind : ''), text: text }); };
  /* أزرار: kind = p (رئيسي) | s (ثانوي) | danger (ثانوي أحمر) | dangerp (رئيسي أحمر) */
  A.btn = function (label, o) {
    o = o || {};
    let cls = 'btn';
    if (o.kind === 'p') cls += ' p';
    else if (o.kind === 'dangerp') cls += ' p ad-dangerp';
    else cls += ' s' + (o.kind === 'danger' ? ' ad-danger' : '');
    if (o.small) cls += ' sm';
    const b = h('button', { type: o.type || 'button', class: cls, disabled: o.disabled, title: o.title }, o.icon ? A.icon(o.icon) : null, label);
    if (o.on) b.addEventListener('click', o.on);
    return b;
  };
  /* زر أيقونة فقط (٤٤ بكسل على الأقل) بتسمية للقارئ الشاشي */
  A.ibtn = function (icon, label, onClick, kind) {
    const b = h('button', { type: 'button', class: 'ad-ibtn' + (kind === 'danger' ? ' ad-danger' : ''), 'aria-label': label, title: label }, A.icon(icon));
    if (onClick) b.addEventListener('click', onClick);
    return b;
  };
  A.link = function (label, href, o) { /* رابط داخلي بشكل زر */
    o = o || {};
    return h('a', { class: 'btn ' + (o.kind === 'p' ? 'p' : 's') + (o.small ? ' sm' : ''), href: href }, o.icon ? A.icon(o.icon) : null, label);
  };

  /* ---------- حقول النماذج (المعرّفات فريدة تلقائيًا؛ رسالة الخطأ #<id>-err تخدم ui.fieldError) ---------- */
  A.input = function (o) {
    o = o || {};
    const id = o.id || A.nid('in');
    const a = {
      class: 'pf-in' + (o.ltr ? ' ltr' : '') + (o.cls ? ' ' + o.cls : ''), id: id, name: o.name || id, type: o.type || 'text',
      value: o.value == null ? '' : o.value, maxlength: o.max, min: o.min, max: o.maxv, step: o.step, inputmode: o.inputmode, autocomplete: o.auto || 'off',
      placeholder: o.placeholder, readonly: o.readonly, required: o.required, 'aria-label': o.aria
    };
    if (o.ltr) a.dir = 'ltr';
    return h('input', a);
  };
  A.textarea = function (o) {
    o = o || {};
    const id = o.id || A.nid('ta');
    const t = h('textarea', {
      class: 'pf-in ad-ta' + (o.cls ? ' ' + o.cls : ''), id: id, name: id, rows: o.rows || 4, maxlength: o.max, placeholder: o.placeholder,
      required: o.required, autocomplete: 'off', 'aria-label': o.aria
    });
    t.value = o.value == null ? '' : o.value;
    if (o.dir) t.setAttribute('dir', o.dir);
    return t;
  };
  /* قائمة منسدلة: opts = [[value,label],...] */
  A.select = function (opts, current, o) {
    o = o || {};
    const id = o.id || A.nid('sel');
    const sel = h('select', { class: 'pf-in' + (o.cls ? ' ' + o.cls : ''), id: id, name: id, required: o.required, 'aria-label': o.aria });
    opts.forEach(function (p) { sel.appendChild(h('option', { value: p[0], text: p[1] })); });
    if (current !== undefined && current !== null) sel.value = String(current);
    return sel;
  };
  A.field = function (label, control, hint, cls) {
    const id = control.id;
    control.setAttribute('aria-describedby', (hint ? id + '-hint ' : '') + id + '-err');
    return h('div', { class: 'pf-field' + (cls ? ' ' + cls : '') },
      h('label', { for: id, text: label }),
      control,
      hint ? h('p', { class: 'pf-hint', id: id + '-hint', text: hint }) : null,
      h('p', { class: 'pf-ferr', id: id + '-err', hidden: true }));
  };
  A.checkbox = function (label, checked, hint) {
    const id = A.nid('cb');
    const input = h('input', { type: 'checkbox', id: id, name: id, 'aria-describedby': (hint ? id + '-hint ' : '') + id + '-err' });
    input.checked = !!checked;
    return {
      input: input,
      el: h('div', { class: 'pf-field' },
        h('label', { class: 'pf-check', for: id }, input, h('span', { text: label })),
        hint ? h('p', { class: 'pf-hint', id: id + '-hint', text: hint }) : null,
        h('p', { class: 'pf-ferr', id: id + '-err', hidden: true }))
    };
  };
  A.clearInvalidOnInput = function (form) {
    Array.prototype.forEach.call(form.querySelectorAll('.pf-in'), function (inp) {
      const ev = inp.type === 'checkbox' || inp.tagName === 'SELECT' ? 'change' : 'input';
      inp.addEventListener(ev, function () { if (inp.getAttribute('aria-invalid')) ui.fieldError(inp, ''); });
    });
  };
  A.msgBox = function () { return h('div', { class: 'pf-msg', hidden: true }); };

  /* ---------- نافذة تأكيد (dialog أصلي: حبس تركيز وESC وإغلاق بالنقر خارجها). الافتراضي في الحذف هو «إلغاء» ---------- */
  A.confirm = function (o) {
    return new Promise(function (resolve) {
      if (typeof HTMLDialogElement !== 'function') { resolve(win.confirm((o.title ? o.title + '\n\n' : '') + (o.message || ''))); return; }
      const prev = doc.activeElement;
      const tid = A.nid('dlg-t');
      const did = A.nid('dlg-d');
      const ok = h('button', { type: 'button', class: 'btn p' + (o.danger ? ' ad-dangerp' : ''), text: o.ok || 'تأكيد' });
      const cancel = h('button', { type: 'button', class: 'btn s', text: o.cancel || 'إلغاء' });
      const dlg = h('dialog', { class: 'ad-dialog', 'aria-labelledby': tid, 'aria-describedby': did },
        h('div', { class: 'ad-dlgbody' },
          h('h3', { id: tid, text: o.title || 'تأكيد' }),
          h('p', { id: did, class: 'ad-dlgmsg', text: o.message || '' }),
          o.detail ? h('p', { class: 'ad-dlgdetail', text: o.detail }) : null,
          h('div', { class: 'btns ad-dlgact' }, cancel, ok)));
      let done = false;
      function close(v) {
        if (done) return;
        done = true;
        try { dlg.close(); } catch (e) { /* مغلقة */ }
        dlg.remove();
        try { if (prev && prev.focus) prev.focus(); } catch (e) { /* تجاهل */ }
        resolve(v);
      }
      ok.addEventListener('click', function () { close(true); });
      cancel.addEventListener('click', function () { close(false); });
      dlg.addEventListener('cancel', function (e) { e.preventDefault(); close(false); });
      dlg.addEventListener('click', function (e) { if (e.target === dlg) close(false); });
      dlg.addEventListener('keydown', function (e) { /* حبس التركيز بين الزرّين (الإطار الأصلي يسمح بالخروج إلى واجهة المتصفح) */
        if (e.key !== 'Tab') return;
        const f = [cancel, ok];
        const i = f.indexOf(doc.activeElement);
        if (e.shiftKey ? i <= 0 : i === f.length - 1) { e.preventDefault(); f[e.shiftKey ? f.length - 1 : 0].focus(); }
      });
      doc.body.appendChild(dlg);
      dlg.showModal();
      (o.danger ? cancel : ok).focus();
    });
  };

  /* ---------- تنسيق ---------- */
  A.fmtDate = P.fmtDate;
  A.fmtDay = function (iso) {
    if (!iso) return '—';
    try { return new Intl.DateTimeFormat('ar-EG-u-nu-latn', { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(iso)); } catch (e) { return String(iso).slice(0, 10); }
  };
  const nf = (function () { try { return new Intl.NumberFormat('en-US'); } catch (e) { return null; } })();
  A.num = function (n) { n = Number(n) || 0; return nf ? nf.format(n) : String(n); };
  A.pct = P.pct;
  A.sizeText = function (n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  };
  A.latinDigits = function (s) {
    return String(s == null ? '' : s).replace(/[٠-٩]/g, function (c) { return String(c.charCodeAt(0) - 0x0660); })
      .replace(/[۰-۹]/g, function (c) { return String(c.charCodeAt(0) - 0x06F0); });
  };
  /* تطبيع نص عربي للبحث: يزيل التشكيل والتطويل ويوحّد الألف والياء والتاء المربوطة والأرقام */
  A.normAr = function (s) {
    return A.latinDigits(String(s == null ? '' : s)).toLowerCase()
      .replace(/[ً-ٰٟـ]/g, '')
      .replace(/[آأإ]/g, 'ا')
      .replace(/ى/g, 'ي')
      .replace(/ة/g, 'ه')
      .replace(/\s+/g, ' ').trim();
  };
  A.statusMap = {
    profile: { active: ['نشط', 'ok'], suspended: ['موقوف', 'err'] },
    enrollment: { active: ['نشط', 'ok'], revoked: ['ملغى', 'mut'] },
    message: { new: ['جديدة', 'warn'], read: ['مقروءة', 'info'], archived: ['مؤرشفة', 'mut'] }
  };
  A.statusBadge = function (group, value) {
    const m = A.statusMap[group] && A.statusMap[group][value];
    return A.badge(m ? m[0] : String(value || '—'), m ? m[1] : 'mut');
  };

  /* ---------- أدوات نصوص وروابط ---------- */
  A.uuid = function () {
    const c = win.crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    const b = new Uint8Array(16);
    c.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const x = Array.prototype.map.call(b, function (v) { return ('0' + v.toString(16)).slice(-2); }).join('');
    return x.slice(0, 8) + '-' + x.slice(8, 12) + '-' + x.slice(12, 16) + '-' + x.slice(16, 20) + '-' + x.slice(20);
  };
  /* اسم ملف آمن للتخزين: ASCII صغير وشرطات فقط. الاسم العربي يصير «file» (العنوان المقروء يبقى في العمود title) */
  A.safeFileName = function (name) {
    const raw = String(name || '').split(/[\\/]/).pop();
    const dot = raw.lastIndexOf('.');
    let base = dot > 0 ? raw.slice(0, dot) : raw;
    const ext = dot > 0 ? raw.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) : '';
    base = base.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/\.{2,}/g, '.').replace(/-{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60);
    if (!base) base = 'file';
    return base.toLowerCase() + (ext ? '.' + ext : '');
  };
  /* رابط المقال من العنوان: يبقي الحروف (عربية ولاتينية) والأرقام، والباقي شرطة. لا مسافات ولا / ? # % (قيد القاعدة) */
  A.slugify = function (title) {
    let s = String(title == null ? '' : title).normalize('NFKC').toLowerCase().replace(/[ً-ٰٟـ]/g, '');
    let re;
    try { re = new RegExp('[^\\p{L}\\p{N}]+', 'gu'); } catch (e) { re = /[^a-z0-9؀-ۿ]+/g; }
    s = s.replace(re, '-').replace(/^-+|-+$/g, '');
    if (s.length > 80) s = s.slice(0, 80).replace(/-+$/, '');
    return s;
  };
  /* مدقّق نص بطول (للاستعمال مع ui.check): يقصّ الأطراف ويعيد {value} أو {error: msg} */
  A.textLen = function (s, min, max, msg) {
    s = String(s == null ? '' : s).replace(/\u0000/g, '').trim();
    return s.length < min || s.length > max ? { error: msg } : { value: s };
  };
  A.isHttps = function (u) {
    u = String(u == null ? '' : u).trim();
    if (!u || u.length > 2000) return false;
    try { const p = new URL(u); return p.protocol === 'https:' && !p.username && !p.password && !!p.hostname; } catch (e) { return false; }
  };
  A.cleanUrl = function (u) { return new URL(String(u).trim()).href; }; /* بعد التحقق: الصيغة المعيارية */
  /* رابط الفيديو المخزَّن: لمضيفات التضمين المسموحة (YouTube وVimeo وBunny فقط) صيغة معيارية بلا معلمات تتبّع (مثل si=)،
     وأي مضيف آخر يبقى كما كُتب (رابطًا عاديًا). المتدرب يشتق التضمين من الرابط المخزَّن بالدالة نفسها (Platform.videoEmbed). */
  A.canonVideoUrl = function (url) {
    const emb = P.videoEmbed(url);
    if (!emb) return url;
    let m = /^https:\/\/www\.youtube-nocookie\.com\/embed\/([A-Za-z0-9_-]{11})/.exec(emb.src);
    if (m) return 'https://www.youtube.com/watch?v=' + m[1];
    m = /^https:\/\/player\.vimeo\.com\/video\/(\d+)(?:\?h=([A-Za-z0-9]+))?$/.exec(emb.src);
    if (m) return 'https://vimeo.com/' + m[1] + (m[2] ? '/' + m[2] : '');
    return emb.src; /* Bunny: لا صفحة مشاهدة، فصيغة التضمين نفسها */
  };
  A.hostOf = function (u) { try { return new URL(u).hostname; } catch (e) { return ''; } };
  A.validEmail = function (e) { e = String(e == null ? '' : e).trim(); return e.length <= 254 && /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/.test(e); };
  A.mailto = function (email, subject) {
    if (!A.validEmail(email)) return null;
    return 'mailto:' + email.trim() + (subject ? '?subject=' + encodeURIComponent(subject) : '');
  };
  /* رقم دولي بلا + ولا أصفار للاستعمال في wa.me، أو '' إن لم يكن صالحًا */
  A.phoneDigits = function (phone) {
    let d = A.latinDigits(String(phone == null ? '' : phone)).replace(/[^\d+]/g, '');
    if (d.charAt(0) === '+') d = d.slice(1);
    else if (d.indexOf('00') === 0) d = d.slice(2);
    d = d.replace(/\D/g, '');
    return d.length >= 8 && d.length <= 15 && /^[1-9]/.test(d) ? d : '';
  };
  A.waUrl = function (phone) { const d = A.phoneDigits(phone); return d ? 'https://wa.me/' + d : null; };
  /* رابط خارجي آمن */
  A.ext = function (label, href, cls) {
    return h('a', { class: cls || 'pf-link', href: href, target: '_blank', rel: 'noopener noreferrer' }, label);
  };

  /* ---------- CSV (تصدير من المتصفح): تحييد الصيغ + BOM لعربي سليم في Excel ---------- */
  A.csvCell = function (v) {
    let s = v === null || v === undefined ? '' : String(v);
    s = s.replace(/\r\n?/g, '\n');
    if (/^[\s\u0000-\u001F]*[=+\-@]/.test(s)) s = "'" + s; /* خلية تبدأ بـ = + - @ (أو مسافة/تحكم ثم أحدها) تصير نصًا لا صيغة */
    return '"' + s.replace(/"/g, '""') + '"';
  };
  A.csvBuild = function (rows) {
    return '﻿' + rows.map(function (r) { return r.map(A.csvCell).join(','); }).join('\r\n') + '\r\n';
  };
  A.download = function (filename, text, mime) {
    const blob = new Blob([text], { type: (mime || 'text/csv') + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { download: filename });
    a.setAttribute('href', url);
    a.setAttribute('rel', 'noopener');
    doc.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
  };

  /* ---------- ملفات: أنواع مسموحة وتحقق وواجهة اختيار ورفع ---------- */
  A.MAX_UPLOAD = 52428800; /* ٥٠ ميغابايت: حد الدلوين في القاعدة */
  A.COURSE_FILE_TYPES = {
    pdf: 'application/pdf', zip: 'application/zip',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg'
  };
  A.IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
  A.VIDEO_TYPES = { mp4: 'video/mp4', webm: 'video/webm' };
  /* يعيد {ext, contentType} أو {error}. النوع الفعلي يُحدَّد من الامتداد (لا من file.type الذي يختلف بين الأنظمة) */
  A.checkFile = function (file, types) {
    if (!file) return { error: 'اختر ملفًا.' };
    const m = /\.([A-Za-z0-9]{1,8})$/.exec(file.name || '');
    const ext = m ? m[1].toLowerCase() : '';
    if (!ext || !Object.prototype.hasOwnProperty.call(types, ext)) {
      return { error: 'نوع الملف غير مسموح. المسموح: ' + Object.keys(types).map(function (e) { return e.toUpperCase(); }).join('، ') + '.' };
    }
    if (!(file.size > 0)) return { error: 'الملف فارغ.' };
    if (file.size > A.MAX_UPLOAD) return { error: 'حجم الملف (' + A.sizeText(file.size) + ') أكبر من الحد المسموح (٥٠ ميغابايت).' };
    return { ext: ext, contentType: types[ext] };
  };
  /* منتقي ملف مع تحقق فوري. o: {types, label, hint, onChange(picked|null)} ؛ get() يعيد {file, ext, contentType} أو null */
  A.fileChooser = function (o) {
    const id = A.nid('file');
    const accept = Object.keys(o.types).map(function (e) { return '.' + e; }).join(',');
    const input = h('input', { type: 'file', class: 'pf-in ad-file', id: id, name: id, accept: accept, 'aria-describedby': id + '-hint ' + id + '-err' });
    const hint = h('p', { class: 'pf-hint', id: id + '-hint', text: o.hint || '' });
    const err = h('p', { class: 'pf-ferr', id: id + '-err', hidden: true });
    let picked = null;
    function showErr(text) {
      err.textContent = text || '';
      err.hidden = !text;
      if (text) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
    }
    input.addEventListener('change', function () {
      const f = input.files && input.files[0];
      picked = null;
      hint.textContent = o.hint || '';
      if (!f) { showErr(''); if (o.onChange) o.onChange(null); return; }
      const res = A.checkFile(f, o.types);
      if (res.error) { input.value = ''; showErr(res.error); if (o.onChange) o.onChange(null); return; }
      picked = { file: f, ext: res.ext, contentType: res.contentType };
      showErr('');
      hint.textContent = f.name + ' — ' + A.sizeText(f.size);
      if (o.onChange) o.onChange(picked);
    });
    return {
      input: input,
      el: h('div', { class: 'pf-field' }, h('label', { for: id, text: o.label }), input, hint, err),
      get: function () { return picked; },
      error: showErr,
      clear: function () { input.value = ''; picked = null; hint.textContent = o.hint || ''; showErr(''); }
    };
  };
  /* شريط تقدّم الرفع (progressbar) */
  A.progress = function () {
    const fill = h('span');
    const text = h('span', { class: 'ad-prog-t', text: '0%' });
    const bar = h('div', { class: 'ad-prog', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0', 'aria-label': 'تقدّم الرفع' }, fill);
    const el = h('div', { class: 'ad-progwrap', hidden: true }, bar, text);
    return {
      el: el,
      set: function (loaded, total) {
        const p = total ? Math.min(100, Math.round(loaded * 100 / total)) : 0;
        fill.style.width = p + '%';
        bar.setAttribute('aria-valuenow', String(p));
        text.textContent = p + '%';
        el.hidden = false;
      },
      reset: function () { fill.style.width = '0%'; bar.setAttribute('aria-valuenow', '0'); text.textContent = '0%'; el.hidden = true; }
    };
  };

  /* ---------- جدول بيانات ----------
     cols = [{key, label, cls, sort, cell(row, i)}] ؛ o = {caption, sort:{key,dir}, onSort(key), rowCls(row)}
     تحت ٩٠٠ بكسل يتحول كل صف إلى بطاقة بتسميات data-label (CSS)، فلا تمدّد أفقي في الصفحة. */
  A.dataTable = function (cols, rows, o) {
    o = o || {};
    const head = h('tr');
    cols.forEach(function (c) {
      const th = h('th', { scope: 'col', class: c.cls || null });
      if (c.sort && o.onSort) {
        const on = !!o.sort && o.sort.key === c.key;
        th.setAttribute('aria-sort', on ? (o.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none');
        th.appendChild(h('button', { type: 'button', class: 'ad-sort', 'data-key': c.key, on: { click: function () { o.onSort(c.key); } } },
          c.label, h('span', { class: 'ad-sorti', 'aria-hidden': 'true', text: on ? (o.sort.dir === 'asc' ? '▲' : '▼') : '↕' })));
      } else th.appendChild(doc.createTextNode(c.label));
      head.appendChild(th);
    });
    const body = h('tbody');
    rows.forEach(function (r, i) {
      const tr = h('tr', { class: o.rowCls ? o.rowCls(r) : null });
      cols.forEach(function (c) { tr.appendChild(h('td', { 'data-label': c.label, class: c.cls || null }, c.cell(r, i))); });
      body.appendChild(tr);
    });
    return h('div', { class: 'ad-tablewrap' },
      h('table', { class: 'ad-table' }, o.caption ? h('caption', { class: 'ad-sr', text: o.caption }) : null, h('thead', null, head), body));
  };
  A.pager = function (total, page, size, onPage) {
    if (total <= size) return null;
    const pages = Math.max(1, Math.ceil(total / size));
    return h('div', { class: 'ad-pager' },
      h('span', { class: 'ad-pinfo', text: 'عرض ' + ((page - 1) * size + 1) + '–' + Math.min(total, page * size) + ' من ' + total }),
      h('div', { class: 'ad-pbtns' },
        A.btn('السابق', { small: true, disabled: page <= 1, on: function () { onPage(page - 1); } }),
        h('span', { class: 'ad-pnum', text: page + ' / ' + pages }),
        A.btn('التالي', { small: true, disabled: page >= pages, on: function () { onPage(page + 1); } })));
  };

  /* ---------- البيانات ---------- */
  /* كل صفوف استعلام (بصفحات من ١٠٠٠). يجب أن يحمل query ترتيبًا ثابتًا (order) */
  A.all = async function (table, query, cap) {
    const max = cap || 20000;
    const out = [];
    let total = null;
    while (out.length < max) {
      const r = await P.rest.page(table, Object.assign({}, query, { limit: '1000', offset: String(out.length) }));
      Array.prototype.push.apply(out, r.rows);
      if (total === null) total = r.total;
      if (!r.rows.length || (total !== null && out.length >= total)) break;
    }
    return out;
  };
  A.loadCourses = async function (force) {
    if (!force && S.courses.length) return S.courses;
    S.courses = await P.rest.select('courses', { select: 'id,title_ar,title_en,status,sort,published,updated_at', order: 'sort.asc' });
    return S.courses;
  };
  A.courseById = function (id) { return S.courses.filter(function (c) { return c.id === id; })[0] || null; };
  A.courseTitle = function (id) { const c = A.courseById(id); return c ? c.title_ar : id; };

  /* بريد المتدربين: دالة القاعدة admin_user_emails (الترحيل 006) وهي للمدير فقط. إن لم تُطبَّق تفشل بـ notfound فتُعدّ غير متاحة */
  A.loadEmails = async function () {
    const map = {};
    let off = 0;
    for (;;) {
      const rows = await P.rest.rpc('admin_user_emails', {}, { limit: '1000', offset: String(off) });
      if (!Array.isArray(rows)) throw new P.ApiError('server', P.MSG.server, 0, 'bad_response');
      rows.forEach(function (r) {
        if (r && typeof r.user_id === 'string') map[r.user_id] = { email: String(r.email || ''), confirmed: r.email_confirmed_at || null, lastSignIn: r.last_sign_in_at || null };
      });
      if (rows.length < 1000) break;
      off += rows.length;
    }
    return map;
  };
  /* الدليل: كل الملفات الشخصية والاشتراكات والبريد والدورات (للقوائم والبحث) */
  A.loadDirectory = async function () {
    const r = await Promise.all([
      A.all('profiles', { select: 'id,full_name,phone,country,role,status,created_at,last_seen_at', order: 'created_at.desc,id.asc' }),
      A.all('enrollments', { select: 'id,user_id,course_id,status,granted_by,granted_at,revoked_at', order: 'granted_at.desc,id.asc' }),
      A.loadCourses(true),
      A.settle(A.loadEmails())
    ]);
    const dir = { profiles: r[0], enrollments: r[1], byId: {}, emails: {}, emailsOk: false };
    r[0].forEach(function (p) { dir.byId[p.id] = p; });
    if (r[3].ok) { dir.emails = r[3].v; dir.emailsOk = true; } else if (A.isSession(r[3].e)) throw r[3].e;
    S.dir = dir;
    return dir;
  };
  A.emailOf = function (id) {
    const d = S.dir;
    return d && d.emails[id] ? d.emails[id].email : '';
  };
  A.nameOf = function (id) {
    if (!id) return '';
    const p = S.dir && S.dir.byId[id];
    if (p) return p.full_name || '';
    return S.names[id] || '';
  };
  A.known = function (id) { return !!(S.dir && S.dir.byId[id]) || typeof S.names[id] === 'string'; };
  /* يجلب أسماء من لا نعرفهم بعد (للسجل والاشتراكات) ويخزنها؛ null = لا ملف بهذا المعرّف (حساب محذوف) */
  A.resolveNames = async function (ids) {
    const need = [];
    ids.forEach(function (id) {
      if (typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id) && need.indexOf(id) === -1 && !(S.dir && S.dir.byId[id]) && !(id in S.names)) need.push(id);
    });
    for (let i = 0; i < need.length; i += 80) {
      const part = need.slice(i, i + 80);
      const rows = await P.rest.select('profiles', { select: 'id,full_name', id: 'in.(' + part.join(',') + ')' });
      part.forEach(function (id) { S.names[id] = null; });
      rows.forEach(function (r) { S.names[r.id] = r.full_name || ''; });
    }
  };
  A.who = function (id) {
    if (!id) return 'النظام';
    return A.nameOf(id) || (A.known(id) ? 'بدون اسم' : 'مستخدم محذوف');
  };

  /* اشتراكات: منح (يعيد صفًا ملغى إلى نشط، ويتخطى النشط) وإلغاء. النتيجة 'added' | 'reactivated' | 'exists' */
  A.grantEnrollment = async function (userId, courseId) {
    const cur = await P.rest.select('enrollments', { select: 'id,status', user_id: 'eq.' + userId, course_id: 'eq.' + courseId });
    if (cur.length && cur[0].status === 'active') return 'exists';
    if (cur.length) {
      const up = await P.rest.update('enrollments', { id: 'eq.' + cur[0].id }, { status: 'active' });
      if (!up.length) throw A.noRows();
      return 'reactivated';
    }
    try {
      const rows = await P.rest.insert('enrollments', { user_id: userId, course_id: courseId, status: 'active' });
      if (!rows.length) throw A.noRows();
    } catch (err) {
      if (err instanceof P.ApiError && err.code === '23505') return 'exists'; /* سباق مع تبويب آخر */
      throw err;
    }
    return 'added';
  };
  A.revokeEnrollment = async function (id) {
    const rows = await P.rest.update('enrollments', { id: 'eq.' + id }, { status: 'revoked' });
    if (!rows.length) throw A.noRows();
  };

  /* ---------- سجل التدقيق: نص مقروء لكل إدخال ---------- */
  A.AUDIT = {
    'enrollment.granted': 'منح اشتراك', 'enrollment.revoked': 'إلغاء اشتراك', 'enrollment.reactivated': 'إعادة تفعيل اشتراك',
    'enrollment.deleted': 'حذف اشتراك', 'enrollment.updated': 'تعديل اشتراك',
    'profile.status_changed': 'تغيير حالة الحساب', 'profile.role_changed': 'تغيير دور الحساب'
  };
  const WORDS = { active: 'نشط', revoked: 'ملغى', suspended: 'موقوف', trainee: 'متدرب', admin: 'مدرب' };
  const word = function (v) { return Object.prototype.hasOwnProperty.call(WORDS, v) ? WORDS[v] : String(v == null ? '' : v).slice(0, 40); };
  A.auditTitle = function (e) { return Object.prototype.hasOwnProperty.call(A.AUDIT, e.action) ? A.AUDIT[e.action] : String(e.action || '').slice(0, 60); };
  A.auditIds = function (e) { /* معرّفات المستخدمين المذكورة في الإدخال (لجلب أسمائهم) */
    const d = e.details && typeof e.details === 'object' ? e.details : {};
    return [e.actor_id, d.user_id, e.entity === 'profiles' ? e.entity_id : null];
  };
  const change = function (o, n) {
    if (o && n) return word(o) + ' ← ' + word(n);
    if (n) return 'الحالة: ' + word(n);
    if (o) return 'كانت: ' + word(o);
    return '';
  };
  A.auditDetail = function (e) {
    const d = e.details && typeof e.details === 'object' ? e.details : {};
    const parts = [];
    if (e.entity === 'enrollments') {
      if (d.user_id) parts.push('المتدرب: ' + A.who(d.user_id));
      if (d.course_id) parts.push('الدورة: ' + A.courseTitle(String(d.course_id)));
      parts.push(change(d.old_status, d.new_status));
    } else if (e.entity === 'profiles') {
      parts.push('الحساب: ' + A.who(e.entity_id));
      parts.push(change(d.old_status, d.new_status));
      parts.push(change(d.old_role, d.new_role));
    }
    return parts.filter(Boolean).join(' — ');
  };
  /* جدول سجل التدقيق (يُستعمل في صفحة المتدرب وفي الإعدادات) */
  A.auditTable = function (entries) {
    return A.dataTable([
      { key: 'at', label: 'الوقت', cell: function (e) { return h('span', { class: 'ad-nowrap', text: A.fmtDate(e.created_at) }); } },
      { key: 'who', label: 'بواسطة', cell: function (e) { return A.who(e.actor_id); } },
      { key: 'act', label: 'الإجراء', cell: function (e) { return h('b', { text: A.auditTitle(e) }); } },
      { key: 'det', label: 'التفاصيل', cell: function (e) { return A.auditDetail(e) || '—'; } }
    ], entries, { caption: 'سجل التدقيق' });
  };

  /* ---------- أدوات واجهة عامة ---------- */
  A.scrollTop = function () {
    const shell = A.$('ad-shell');
    const y = shell ? Math.max(0, shell.getBoundingClientRect().top + win.pageYOffset - 96) : 0;
    try { win.scrollTo({ top: y, left: 0, behavior: 'instant' }); } catch (e) { win.scrollTo(0, y); }
  };
  A.focusTitle = function () {
    const t = A.$('ad-title');
    if (t) { try { t.focus({ preventScroll: true }); } catch (e) { t.focus(); } }
  };
  /* بحث نصي حيّ مع تأخير قصير. يعيد حقل الإدخال */
  A.debounce = function (fn, ms) {
    let t = 0;
    return function () { const a = arguments; clearTimeout(t); t = setTimeout(function () { fn.apply(null, a); }, ms); };
  };

  win.Admin = A;
})();
