/* =====================================================================
   admin-qbank-io.js — صيغ استيراد وتصدير الأسئلة: A.qb.io (بلا شبكة ولا واجهة؛ DOMParser فقط لقراءة Moodle XML)
   ملف عادي (ES2017) يُحمَّل بـ defer بعد admin-qbank-model.js وقبل admin-qbank-import.js.
   الاستيراد: Aiken وGIFT وMoodle XML وCSV. كل صيغة ← قائمة عناصر {n, title, type, s, errs, warns, fmt}: s = حالة نموذج السؤال
   (نفس حالة المحرر)، فيمرّ كل سؤال بنفس التحقق buildRequest/validate قبل الحفظ، والقاعدة تتحقق مرة ثانية.
   المدعوم الآن: اختيار واحد، اختيار متعدد، صح/خطأ، مطابقة. غير ذلك يظهر في التقرير برسالة صريحة ولا يُستورد (لا يُهمل بصمت).
   التصدير: GIFT وAiken وMoodle XML وCSV بحسب توافق نوع السؤال؛ ما لا تدعمه الصيغة يُعدّ ويُذكر في التقرير.
   النصوص نص عادي: وسوم HTML تُحوَّل إلى أسطر ونص، والصور لا تُستورد (تحذير).
   ===================================================================== */
(function () {
  'use strict';

  const A = window.Admin;
  if (!A || !A.qb || !A.qb.model) return;
  const QB = A.qb;
  const M = QB.model;

  const LIMITS = { bytes: 2 * 1024 * 1024, questions: 500 };
  const LETTERS = 'abcdefghijklmno';
  const hasArabic = function (t) { return /[؀-ۿ]/.test(t); };
  const norm = function (t) { return String(t == null ? '' : t).replace(/\r\n?/g, '\n').replace(/^﻿/, ''); };
  const clip = function (t, n) { const a = Array.from(String(t || '').replace(/\s+/g, ' ').trim()); return a.length > n ? a.slice(0, n).join('') + '…' : a.join(''); };
  const UNSUPPORTED = {
    shortanswer: 'إجابة قصيرة', essay: 'مقالي', numerical: 'رقمي', multianswer: 'ملء الفراغات (Cloze)', cloze: 'ملء الفراغات (Cloze)',
    ddmatch: 'مطابقة بالسحب', ddwtos: 'سحب كلمات', ddimageortext: 'سحب على صورة', ddmarker: 'نقر على صورة', gapselect: 'اختيار فراغات',
    calculated: 'محسوب', calculatedmulti: 'محسوب متعدد', calculatedsimple: 'محسوب', match: 'مطابقة قديمة', ordering: 'ترتيب'
  };

  /* ---------- بناء حالة سؤال ---------- */
  function build(o) {
    const s = M.blank();
    s.type = o.type;
    s.stem = String(o.stem || '').trim();
    s.lang = hasArabic(s.stem) ? 'ar' : 'en';
    s.points = o.points != null ? String(o.points) : '1';
    s.difficulty = o.difficulty || 'medium';
    s.status = 'draft';
    s.fbOk = o.fbOk || '';
    s.fbBad = o.fbBad || '';
    s.expl = o.expl || '';
    s.ref = o.ref || '';
    if (o.type === 'true_false') {
      s.tf = o.tf || '';
    } else if (o.type === 'matching') {
      s.left = []; s.right = []; s.pairs = {};
      (o.pairs || []).forEach(function (p, i) { const id = 'l' + (i + 1); s.left.push(M.mkOpt(id, p[0], p[2] || '')); });
      let r = 0;
      (o.pairs || []).forEach(function (p, i) { r++; const id = 'r' + r; s.right.push(M.mkOpt(id, p[1])); s.pairs['l' + (i + 1)] = id; });
      (o.extraRight || []).forEach(function (t) { r++; s.right.push(M.mkOpt('r' + r, t)); });
      s.scoring = o.scoring || 'all_or_nothing';
    } else {
      s.options = (o.options || []).map(function (t, i) { return M.mkOpt(LETTERS.charAt(i) || ('o' + i), t, (o.expls || [])[i] || ''); });
      s.correct = (o.correct || []).map(function (i) { return LETTERS.charAt(i); });
      if (o.type === 'multi_response') s.scoring = o.scoring || 'all_or_nothing';
    }
    return s;
  }
  function item(n, title, fmt) { return { n: n, title: title || '', type: '', s: null, errs: [], warns: [], fmt: fmt, diffSet: false }; }
  function done(it, o) {
    it.type = o.type;
    it.diffSet = !!o.difficulty;
    it.s = build(o);
    return it;
  }
  function unsupported(it, what) { it.errs.push('نوع غير مدعوم حاليًا في الاستيراد: ' + what + '. لم يُستورد.'); return it; }

  /* ================================================================== Aiken */
  function parseAiken(text) {
    const blocks = norm(text).split(/\n\s*\n+/).map(function (b) { return b.split('\n').map(function (l) { return l.trim(); }).filter(Boolean); }).filter(function (b) { return b.length; });
    return blocks.map(function (lines, bi) {
      const it = item(bi + 1, '', 'aiken');
      const ai = lines.findIndex(function (l) { return /^ANSWER\s*:/i.test(l); });
      const opts = [];
      const stem = [];
      lines.forEach(function (l, i) {
        if (i === ai) return;
        const m = /^\(?([A-Za-z])[.)]\s*(.*)$/.exec(l);
        if (m && (opts.length || /^[Aa]$/.test(m[1]))) opts.push({ k: m[1].toUpperCase(), t: m[2] });
        else if (opts.length) opts[opts.length - 1].t += ' ' + l;
        else stem.push(l);
      });
      it.title = clip(stem.join(' '), 60);
      if (ai < 0) { it.errs.push('لا يوجد سطر «ANSWER: X» في هذا السؤال.'); return it; }
      if (opts.length < 2) { it.errs.push('الخيارات ناقصة: يلزم خياران على الأقل بصيغة «A. نص».'); return it; }
      const ans = lines[ai].replace(/^ANSWER\s*:/i, '').split(/[\s,;]+/).map(function (x) { return x.trim().toUpperCase(); }).filter(Boolean);
      const idx = [];
      for (let i = 0; i < ans.length; i++) {
        const at = opts.findIndex(function (o) { return o.k === ans[i]; });
        if (at < 0) { it.errs.push('الإجابة «' + ans[i] + '» ليست بين الخيارات.'); return it; }
        if (idx.indexOf(at) === -1) idx.push(at);
      }
      if (!idx.length) { it.errs.push('لم تُحدَّد إجابة.'); return it; }
      if (idx.length > 1) it.warns.push('عدة إجابات صحيحة: حُوّل إلى «اختيار متعدد» (Aiken القياسي إجابة واحدة).');
      return done(it, { type: idx.length > 1 ? 'multi_response' : 'mcq_single', stem: stem.join('\n'), options: opts.map(function (o) { return o.t; }), correct: idx });
    });
  }

  /* ================================================================== GIFT */
  const unesc = function (s) { return String(s).replace(/\\(.)/g, function (m, c) { return c === 'n' ? '\n' : c; }); };
  /* مواضع محرف غير مُهرَّب */
  function findUnescaped(t, ch, from) {
    for (let i = from || 0; i < t.length; i++) {
      if (t.charAt(i) === '\\') { i++; continue; }
      if (t.charAt(i) === ch) return i;
    }
    return -1;
  }
  function lastUnescaped(t, ch) {
    let at = -1;
    for (let i = 0; i < t.length; i++) {
      if (t.charAt(i) === '\\') { i++; continue; }
      if (t.charAt(i) === ch) at = i;
    }
    return at;
  }
  function htmlToText(html) {
    const raw = String(html == null ? '' : html);
    if (!/[<&]/.test(raw)) return { text: raw.trim(), images: 0 };
    let doc;
    try { doc = new DOMParser().parseFromString('<div>' + raw.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n') + '</div>', 'text/html'); } catch (e) { return { text: raw.replace(/<[^>]+>/g, ' ').trim(), images: 0 }; }
    const images = doc.querySelectorAll('img').length;
    const text = (doc.body.textContent || '').replace(/ /g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return { text: text, images: images };
  }

  function parseGift(text) {
    const lines = norm(text).split('\n').filter(function (l) { return !/^\s*\/\//.test(l); });
    const blocks = lines.join('\n').split(/\n\s*\n+/).map(function (b) { return b.trim(); }).filter(Boolean);
    const out = [];
    let n = 0;
    blocks.forEach(function (blk) {
      if (/^\$CATEGORY\s*:/i.test(blk)) return; /* سطر الفئة: لا سؤال */
      n++;
      const it = item(n, '', 'gift');
      out.push(it);
      let t = blk;
      let title = '';
      const tm = /^::((?:\\.|[^\\:]|:(?!:))*)::/.exec(t);
      if (tm) { title = unesc(tm[1]).trim(); t = t.slice(tm[0].length).trim(); }
      let isHtml = false;
      const fm = /^\[(html|markdown|plain|moodle)\]/i.exec(t);
      if (fm) { isHtml = fm[1].toLowerCase() === 'html'; t = t.slice(fm[0].length).trim(); }
      const open = findUnescaped(t, '{');
      const close = lastUnescaped(t, '}');
      if (open < 0 || close < open) { it.title = clip(title || t, 60); it.errs.push('لا توجد كتلة إجابات {…} في هذا السؤال.'); return; }
      const pre = t.slice(0, open);
      const post = t.slice(close + 1);
      let body = t.slice(open + 1, close);
      let stem = unesc(pre).trim();
      if (post.trim()) stem = (stem + ' _____ ' + unesc(post).trim()).trim();
      if (isHtml) { const r = htmlToText(stem); stem = r.text; if (r.images) it.warns.push('الصور داخل السؤال لم تُستورد.'); }
      it.title = clip(title || stem, 60);
      if (!stem) { it.errs.push('نص السؤال فارغ.'); return; }

      let general = '';
      const gi = body.indexOf('####');
      if (gi >= 0) { general = unesc(body.slice(gi + 4)).trim(); body = body.slice(0, gi); }
      const b = body.trim();
      if (!b) return unsupported(it, 'مقالي (كتلة إجابات فارغة)');
      if (b.charAt(0) === '#') return unsupported(it, 'رقمي');
      const tf = /^(TRUE|FALSE|T|F)\s*((?:#[\s\S]*)?)$/i.exec(b);
      if (tf) {
        const fbs = tf[2] ? tf[2].split('#').slice(1).map(function (x) { return unesc(x).trim(); }) : [];
        return done(it, { type: 'true_false', stem: stem, tf: /^t/i.test(tf[1]) ? 'true' : 'false', fbBad: fbs[0] || '', fbOk: fbs[1] || '', expl: general });
      }
      /* تقطيع الإجابات: يبدأ كل عنصر بـ = أو ~ غير مُهرَّب */
      const toks = [];
      let cur = null;
      for (let i = 0; i < b.length; i++) {
        const c = b.charAt(i);
        if (c === '\\') { if (cur) cur.t += b.substr(i, 2); i++; continue; }
        if (c === '=' || c === '~') { cur = { k: c, t: '' }; toks.push(cur); continue; }
        if (cur) cur.t += c;
      }
      if (!toks.length) { it.errs.push('تعذّرت قراءة الإجابات (يجب أن تبدأ بـ = أو ~).'); return; }
      const parts = toks.map(function (k) {
        let raw = k.t.trim();
        let w = null;
        const wm = /^%(-?\d+(?:[.,]\d+)?)%/.exec(raw);
        if (wm) { w = Number(wm[1].replace(',', '.')); raw = raw.slice(wm[0].length).trim(); }
        const hi = findUnescaped(raw, '#');
        const fb = hi >= 0 ? unesc(raw.slice(hi + 1)).trim() : '';
        const body2 = hi >= 0 ? raw.slice(0, hi) : raw;
        return { k: k.k, w: w, raw: body2.trim(), fb: fb };
      });
      const arrow = function (p) { const i = p.raw.indexOf('->'); return i; };
      if (parts.every(function (p) { return p.k === '='; }) && parts.some(function (p) { return arrow(p) >= 0; })) {
        const pairs = [];
        const extra = [];
        parts.forEach(function (p) {
          const i = arrow(p);
          if (i < 0) return;
          const l = unesc(p.raw.slice(0, i)).trim();
          const r = unesc(p.raw.slice(i + 2)).trim();
          if (!r) return;
          if (!l) extra.push(r); else pairs.push([l, r, p.fb]);
        });
        if (pairs.length < 2) { it.errs.push('المطابقة تحتاج زوجين على الأقل.'); return; }
        return done(it, { type: 'matching', stem: stem, pairs: pairs, extraRight: extra, expl: general });
      }
      if (parts.every(function (p) { return p.k === '='; })) return unsupported(it, 'إجابة قصيرة');
      const texts = parts.map(function (p) { return unesc(p.raw).trim(); });
      const correct = [];
      let weighted = false;
      parts.forEach(function (p, i) { if (p.w !== null) weighted = true; if (p.k === '=' || (p.w !== null && p.w > 0)) correct.push(i); });
      if (!correct.length) { it.errs.push('لا توجد إجابة صحيحة (= أو وزن موجب).'); return; }
      if (parts.length < 2) { it.errs.push('الخيارات ناقصة.'); return; }
      const multi = correct.length > 1;
      if (multi) it.warns.push('عدة إجابات صحيحة: حُوّل إلى «اختيار متعدد»' + (weighted ? ' بتصحيح جزئي (الأوزان لا تُستورد بقيمها).' : '.'));
      return done(it, { type: multi ? 'multi_response' : 'mcq_single', stem: stem, options: texts, correct: correct, expls: parts.map(function (p) { return p.fb; }), expl: general, scoring: multi && weighted ? 'partial' : 'all_or_nothing' });
    });
    return out;
  }

  /* ================================================================== Moodle XML */
  function parseMoodle(text) {
    let doc;
    try { doc = new DOMParser().parseFromString(norm(text), 'application/xml'); } catch (e) { doc = null; }
    if (!doc || doc.getElementsByTagName('parsererror').length || !doc.documentElement || doc.documentElement.nodeName !== 'quiz') {
      const it = item(1, '', 'moodle');
      it.errs.push('الملف ليس Moodle XML صالحًا (يجب أن يبدأ بالعنصر <quiz>).');
      return [it];
    }
    const kids = function (el, name) { const r = []; for (let c = el.firstElementChild; c; c = c.nextElementSibling) if (c.nodeName === name) r.push(c); return r; };
    const first = function (el, name) { return kids(el, name)[0] || null; };
    const txt = function (el, imgs) {
      const t = el ? first(el, 'text') : null;
      if (!t) return '';
      const fmt = el.getAttribute && el.getAttribute('format');
      const raw = t.textContent || '';
      if (fmt === 'html' || /<[a-z][\s\S]*>/i.test(raw)) { const r = htmlToText(raw); if (imgs) imgs.n += r.images; return r.text; }
      return raw.trim();
    };
    const out = [];
    let n = 0;
    kids(doc.documentElement, 'question').forEach(function (q) {
      const type = q.getAttribute('type') || '';
      if (type === 'category') return;
      n++;
      const it = item(n, '', 'moodle');
      out.push(it);
      const imgs = { n: 0 };
      const stem = txt(first(q, 'questiontext'), imgs);
      const name = txt(first(q, 'name'));
      it.title = clip(name || stem, 60);
      if (type === 'description') { it.errs.push('نص وصفي (ليس سؤالًا): تُجوهل.'); return; }
      if (UNSUPPORTED[type]) return unsupported(it, UNSUPPORTED[type]);
      if (['multichoice', 'truefalse', 'matching'].indexOf(type) === -1) return unsupported(it, type || 'غير معروف');
      if (!stem) { it.errs.push('نص السؤال فارغ.'); return; }
      const general = txt(first(q, 'generalfeedback'), imgs);
      const fbOk = txt(first(q, 'correctfeedback'), imgs);
      const fbBad = txt(first(q, 'incorrectfeedback'), imgs);
      const dg = first(q, 'defaultgrade');
      const pts = dg && /^\d+(\.\d+)?$/.test((dg.textContent || '').trim()) ? Number(dg.textContent.trim()) : 1;
      const base = { stem: stem, expl: general, fbOk: fbOk, fbBad: fbBad, points: pts > 0 && pts <= 1000 ? pts : 1 };
      if (imgs.n) it.warns.push('الصور داخل السؤال أو الإجابات لم تُستورد.');
      if (type === 'multichoice') {
        const ans = kids(q, 'answer');
        const texts = ans.map(function (a) { return txt(a, imgs); });
        const fr = ans.map(function (a) { return Number(a.getAttribute('fraction')) || 0; });
        const fbs = ans.map(function (a) { return txt(first(a, 'feedback'), imgs); });
        const correct = [];
        fr.forEach(function (f, i) { if (f > 0) correct.push(i); });
        if (ans.length < 2) { it.errs.push('الخيارات ناقصة.'); return; }
        if (!correct.length) { it.errs.push('لا توجد إجابة صحيحة (fraction موجب).'); return; }
        const single = ((first(q, 'single') || {}).textContent || '').trim() === 'true';
        const multi = !single || correct.length > 1;
        if (single && correct.length > 1) it.warns.push('سؤال «إجابة واحدة» لكن فيه أكثر من إجابة موجبة: حُوّل إلى اختيار متعدد.');
        return done(it, Object.assign(base, { type: multi ? 'multi_response' : 'mcq_single', options: texts, correct: correct, expls: fbs, scoring: multi ? 'partial' : 'all_or_nothing' }));
      }
      if (type === 'truefalse') {
        const ans = kids(q, 'answer');
        const right = ans.filter(function (a) { return Number(a.getAttribute('fraction')) > 0; })[0];
        const v = right ? txt(right, imgs).toLowerCase() : '';
        if (v !== 'true' && v !== 'false') { it.errs.push('تعذّر تحديد الإجابة (true/false).'); return; }
        return done(it, Object.assign(base, { type: 'true_false', tf: v }));
      }
      /* matching */
      const pairs = [];
      const extra = [];
      kids(q, 'subquestion').forEach(function (sq) {
        const l = txt(sq, imgs);
        const r = txt(first(sq, 'answer'), imgs);
        if (!r) return;
        if (!l) extra.push(r); else pairs.push([l, r, '']);
      });
      if (pairs.length < 2) { it.errs.push('المطابقة تحتاج زوجين على الأقل.'); return; }
      return done(it, Object.assign(base, { type: 'matching', pairs: pairs, extraRight: extra, scoring: 'partial' }));
    });
    if (!out.length) { const it = item(1, '', 'moodle'); it.errs.push('لا توجد أسئلة في الملف.'); return [it]; }
    return out;
  }

  /* ================================================================== CSV */
  const CSV_COLS = ['type', 'question', 'option_a', 'option_b', 'option_c', 'option_d', 'option_e', 'option_f', 'correct', 'explanation', 'feedback_correct', 'feedback_incorrect', 'points', 'difficulty', 'status'];
  function csvRows(text) {
    const t = norm(text);
    const first = t.split('\n', 1)[0];
    const counts = { ',': 0, ';': 0, '\t': 0 };
    let inq = false;
    for (let i = 0; i < first.length; i++) { const c = first.charAt(i); if (c === '"') inq = !inq; else if (!inq && counts[c] !== undefined) counts[c]++; }
    const delim = counts[';'] > counts[','] && counts[';'] >= counts['\t'] ? ';' : (counts['\t'] > counts[','] ? '\t' : ',');
    const rows = [];
    let row = [];
    let cell = '';
    inq = false;
    for (let i = 0; i < t.length; i++) {
      const c = t.charAt(i);
      if (inq) {
        if (c === '"') { if (t.charAt(i + 1) === '"') { cell += '"'; i++; } else inq = false; } else cell += c;
      } else if (c === '"') inq = true;
      else if (c === delim) { row.push(cell); cell = ''; }
      else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (c) { return String(c).trim() !== ''; }); });
  }
  const TYPE_ALIAS = {
    mcq_single: 'mcq_single', single: 'mcq_single', mcq: 'mcq_single', 'اختيار واحد': 'mcq_single', 'اختيار من متعدد': 'mcq_single',
    multi_response: 'multi_response', multiple: 'multi_response', multi: 'multi_response', 'اختيار متعدد': 'multi_response',
    true_false: 'true_false', tf: 'true_false', truefalse: 'true_false', 'صح/خطأ': 'true_false', 'صح أو خطأ': 'true_false',
    matching: 'matching', match: 'matching', 'مطابقة': 'matching'
  };
  const DIFF_ALIAS = { easy: 'easy', medium: 'medium', hard: 'hard', 'سهل': 'easy', 'متوسط': 'medium', 'صعب': 'hard' };
  const TF_ALIAS = { true: 'true', t: 'true', '1': 'true', yes: 'true', 'صح': 'true', 'صحيح': 'true', false: 'false', f: 'false', '0': 'false', no: 'false', 'خطأ': 'false', 'خطا': 'false' };

  function parseCsv(text) {
    const rows = csvRows(text);
    if (rows.length < 2) { const it = item(1, '', 'csv'); it.errs.push('الملف يحتاج صف عناوين وصفًا واحدًا على الأقل من الأسئلة.'); return [it]; }
    const head = rows[0].map(function (c) { return String(c).trim().toLowerCase().replace(/\s+/g, '_'); });
    const col = function (names) { for (let i = 0; i < names.length; i++) { const k = head.indexOf(names[i]); if (k >= 0) return k; } return -1; };
    const ci = {
      type: col(['type', 'النوع']), q: col(['question', 'stem', 'السؤال']), correct: col(['correct', 'answer', 'الإجابة', 'الاجابة']),
      expl: col(['explanation', 'الشرح']), fbOk: col(['feedback_correct']), fbBad: col(['feedback_incorrect']), pts: col(['points', 'الدرجة']),
      diff: col(['difficulty', 'الصعوبة']), status: col(['status', 'الحالة'])
    };
    const optCols = [];
    head.forEach(function (h, i) { const m = /^(?:option|choice|opt)_?([a-o])$/.exec(h) || /^([a-o])$/.exec(h); if (m) optCols.push({ i: i, k: m[1] }); });
    optCols.sort(function (a, b) { return a.k < b.k ? -1 : 1; });
    if (ci.q < 0 || !optCols.length) { const it = item(1, '', 'csv'); it.errs.push('أعمدة غير صحيحة: المطلوب على الأقل question وoption_a وoption_b (راجع القالب).'); return [it]; }
    const cell = function (r, i) { return i >= 0 && i < r.length ? String(r[i]).trim() : ''; };
    const out = [];
    for (let ri = 1; ri < rows.length; ri++) {
      const r = rows[ri];
      const it = item(ri, '', 'csv');
      out.push(it);
      const stem = cell(r, ci.q);
      it.title = clip(stem, 60);
      if (!stem) { it.errs.push('نص السؤال فارغ.'); continue; }
      const opts = optCols.map(function (c) { return cell(r, c.i); }).filter(Boolean);
      const corr = cell(r, ci.correct);
      const tRaw = cell(r, ci.type).toLowerCase();
      let type = tRaw ? TYPE_ALIAS[tRaw] : '';
      if (tRaw && !type) { it.errs.push('نوع غير معروف: «' + cell(r, ci.type) + '» (المسموح: mcq_single, multi_response, true_false, matching).'); continue; }
      if (!type) {
        if (opts.length === 0 && TF_ALIAS[corr.toLowerCase()] !== undefined) type = 'true_false';
        else if (opts.length && opts.every(function (o) { return o.indexOf('=>') > 0; })) type = 'matching';
        else type = /[;,|+]/.test(corr) ? 'multi_response' : 'mcq_single';
      }
      const diffRaw = cell(r, ci.diff).toLowerCase();
      const diff = diffRaw ? DIFF_ALIAS[diffRaw] : '';
      if (diffRaw && !diff) { it.errs.push('صعوبة غير معروفة: «' + cell(r, ci.diff) + '».'); continue; }
      const common = { type: type, stem: stem, expl: cell(r, ci.expl), fbOk: cell(r, ci.fbOk), fbBad: cell(r, ci.fbBad), difficulty: diff || undefined };
      const ps = cell(r, ci.pts);
      if (ps) { const v = M.decimal(ps); if (!(v > 0)) { it.errs.push('الدرجة غير صالحة: «' + ps + '».'); continue; } common.points = v; }
      if (type === 'true_false') {
        const v = TF_ALIAS[corr.toLowerCase()];
        if (!v) { it.errs.push('الإجابة الصحيحة لصح/خطأ: true أو false (أو صح/خطأ).'); continue; }
        done(it, Object.assign(common, { tf: v }));
      } else if (type === 'matching') {
        const pairs = [];
        const extra = [];
        opts.forEach(function (o) { const k = o.indexOf('=>'); if (k < 0) return; const l = o.slice(0, k).trim(); const rr = o.slice(k + 2).trim(); if (!rr) return; if (!l) extra.push(rr); else pairs.push([l, rr, '']); });
        if (pairs.length < 2) { it.errs.push('المطابقة: اكتب كل زوج في عمود بصيغة «العنصر=>المطابق» (زوجان على الأقل).'); continue; }
        done(it, Object.assign(common, { pairs: pairs, extraRight: extra }));
      } else {
        if (opts.length < 2) { it.errs.push('الخيارات ناقصة.'); continue; }
        const picks = corr.split(/[;,|+]/).map(function (x) { return x.trim(); }).filter(Boolean);
        const idx = [];
        let bad = '';
        picks.forEach(function (p) {
          let at = -1;
          if (/^[A-Za-z]$/.test(p)) at = LETTERS.indexOf(p.toLowerCase());
          else if (/^\d{1,2}$/.test(p)) at = Number(p) - 1;
          else at = opts.findIndex(function (o) { return o === p; });
          if (at < 0 || at >= opts.length) bad = p; else if (idx.indexOf(at) === -1) idx.push(at);
        });
        if (bad) { it.errs.push('الإجابة الصحيحة «' + bad + '» ليست بين الخيارات.'); continue; }
        if (!idx.length) { it.errs.push('الإجابة الصحيحة مطلوبة (حرف الخيار مثل A أو أكثر مفصولة بـ ;).'); continue; }
        if (type === 'mcq_single' && idx.length > 1) { type = 'multi_response'; it.warns.push('عدة إجابات صحيحة: حُوّل إلى «اختيار متعدد».'); }
        if (type === 'multi_response' && idx.length === 1) it.warns.push('اختيار متعدد بإجابة صحيحة واحدة.');
        done(it, Object.assign(common, { type: type, options: opts, correct: idx }));
      }
      const st = cell(r, ci.status).toLowerCase();
      if (it.s && (st === 'active' || st === 'draft')) it.statusSet = st;
    }
    return out;
  }

  /* ================================================================== كشف الصيغة والتحقق */
  function detect(text, name) {
    const t = norm(text).trim();
    const ext = /\.([a-z0-9]+)$/i.exec(name || '');
    const e = ext ? ext[1].toLowerCase() : '';
    if (e === 'xml' || /^<\?xml|^<quiz[\s>]/i.test(t)) return 'moodle';
    if (e === 'csv') return 'csv';
    if (e === 'gift') return 'gift';
    if (e === 'aiken') return 'aiken';
    if (/^ANSWER\s*:/im.test(t) && /^\(?[Aa][.)]\s/m.test(t)) return 'aiken';
    const l1 = t.split('\n', 1)[0].toLowerCase();
    if (/question|stem|السؤال/.test(l1) && /[,;\t]/.test(l1)) return 'csv';
    if (/\{[\s\S]*[=~][\s\S]*\}|\{\s*(TRUE|FALSE|T|F)\b/i.test(t)) return 'gift';
    return null;
  }
  const PARSERS = { aiken: parseAiken, gift: parseGift, moodle: parseMoodle, csv: parseCsv };
  function parse(text, fmt) {
    const fn = PARSERS[fmt];
    if (!fn) return [];
    return fn(text);
  }
  /* تحقق كل عنصر بنفس مدقّق المحرر؛ يضيف رسائله إلى errs ويُبطل s عند الفشل */
  function check(items, course) {
    items.forEach(function (it) {
      if (!it.s) return;
      const errs = M.validate(it.s, course, null);
      if (errs.length) { it.errs = it.errs.concat(errs.map(function (e) { return e.m; })); it.s = null; }
    });
    return items;
  }

  /* ================================================================== تصدير */
  const txtOf = function (t) { return String(t == null ? '' : t); };
  const pct = function (x) { return String(Math.round(x * 100000) / 100000); };
  const labelTf = function (s, v) { return (v === 'true' ? s.tfTrue : s.tfFalse).trim() || (v === 'true' ? 'صح' : 'خطأ'); };
  const optsOf = function (s) { return s.type === 'true_false' ? [{ id: 'true', text: labelTf(s, 'true'), expl: s.tfExplTrue }, { id: 'false', text: labelTf(s, 'false'), expl: s.tfExplFalse }] : s.options; };
  const isChoice = function (s) { return s.type === 'mcq_single' || s.type === 'multi_response' || s.type === 'true_false'; };
  const correctIds = function (s) { return s.type === 'true_false' ? [s.tf] : s.correct; };
  function giftEsc(t) { return txtOf(t).replace(/\\/g, '\\\\').replace(/([~=#{}:])/g, '\\$1').replace(/\n/g, '\\n'); }

  function toAiken(states) {
    const out = [];
    let skipped = 0;
    states.forEach(function (s) {
      if (!(s.type === 'mcq_single' || s.type === 'true_false')) { skipped++; return; }
      const o = optsOf(s);
      const ids = correctIds(s);
      if (ids.length !== 1) { skipped++; return; }
      const lines = [txtOf(s.stem).replace(/\n+/g, ' ').trim()];
      o.forEach(function (x, i) { lines.push(String.fromCharCode(65 + i) + '. ' + txtOf(x.text).replace(/\n+/g, ' ').trim()); });
      lines.push('ANSWER: ' + String.fromCharCode(65 + o.findIndex(function (x) { return x.id === ids[0]; })));
      out.push(lines.join('\n'));
    });
    return { text: out.join('\n\n') + (out.length ? '\n' : ''), count: out.length, skipped: skipped, ext: 'txt', mime: 'text/plain' };
  }

  function toGift(states) {
    const out = [];
    let skipped = 0;
    let n = 0;
    states.forEach(function (s) {
      n++;
      const title = '::' + giftEsc(clip(s.stem, 50) || ('سؤال ' + n)) + '::';
      const stem = giftEsc(s.stem);
      let body = '';
      if (s.type === 'true_false') {
        body = s.tf === 'true' ? 'TRUE' : 'FALSE';
        if (s.fbBad || s.fbOk) body += '#' + giftEsc(s.fbBad) + '#' + giftEsc(s.fbOk);
      } else if (s.type === 'mcq_single') {
        body = s.options.map(function (o) { return (s.correct.indexOf(o.id) !== -1 ? '=' : '~') + giftEsc(o.text) + (o.expl ? '#' + giftEsc(o.expl) : ''); }).join(' ');
      } else if (s.type === 'multi_response') {
        const nc = s.correct.length || 1;
        const w = pct(100 / nc);
        body = s.options.map(function (o) {
          const ok = s.correct.indexOf(o.id) !== -1;
          return '~%' + (ok ? w : (s.scoring === 'partial' ? '0' : '-100')) + '%' + giftEsc(o.text) + (o.expl ? '#' + giftEsc(o.expl) : '');
        }).join(' ');
      } else if (s.type === 'matching') {
        body = s.left.map(function (l) { const r = s.right.filter(function (x) { return x.id === s.pairs[l.id]; })[0]; return '=' + giftEsc(l.text) + ' -> ' + giftEsc(r ? r.text : ''); }).join(' ');
      } else { skipped++; return; }
      if (s.expl) body += ' ####' + giftEsc(s.expl);
      out.push(title + ' ' + stem + ' {' + body + '}');
    });
    return { text: out.join('\n\n') + (out.length ? '\n' : ''), count: out.length, skipped: skipped, ext: 'gift', mime: 'text/plain' };
  }

  const xe = function (t) { return txtOf(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
  const cd = function (t) { return '<text><![CDATA[' + txtOf(t).replace(/\]\]>/g, ']]]]><![CDATA[>') + ']]></text>'; };
  const html = function (t) { return '<p>' + xe(t).replace(/\n/g, '<br/>') + '</p>'; };
  function toMoodle(states) {
    const out = [];
    let skipped = 0;
    states.forEach(function (s) {
      const head = '<question type="TYPE"><name><text>' + xe(clip(s.stem, 60)) + '</text></name><questiontext format="html">' + cd(html(s.stem)) + '</questiontext><generalfeedback format="html">' + cd(s.expl ? html(s.expl) : '') + '</generalfeedback><defaultgrade>' + xe(s.points) + '</defaultgrade><penalty>0.3333333</penalty><hidden>0</hidden>';
      const fb = function (t) { return '<feedback format="html">' + cd(t ? html(t) : '') + '</feedback>'; };
      if (s.type === 'mcq_single' || s.type === 'multi_response') {
        const single = s.type === 'mcq_single';
        const nc = s.correct.length || 1;
        const nw = Math.max(1, s.options.length - s.correct.length);
        const parts = [head.replace('TYPE', 'multichoice'), '<single>' + (single ? 'true' : 'false') + '</single><shuffleanswers>1</shuffleanswers><answernumbering>abc</answernumbering>'];
        parts.push('<correctfeedback format="html">' + cd(s.fbOk ? html(s.fbOk) : '') + '</correctfeedback><partiallycorrectfeedback format="html">' + cd('') + '</partiallycorrectfeedback><incorrectfeedback format="html">' + cd(s.fbBad ? html(s.fbBad) : '') + '</incorrectfeedback>');
        s.options.forEach(function (o) {
          const ok = s.correct.indexOf(o.id) !== -1;
          const f = single ? (ok ? '100' : '0') : (ok ? pct(100 / nc) : (s.scoring === 'partial' ? '0' : pct(-100 / nw)));
          parts.push('<answer fraction="' + f + '" format="html">' + cd(html(o.text)) + fb(o.expl) + '</answer>');
        });
        out.push(parts.join('') + '</question>');
      } else if (s.type === 'true_false') {
        out.push(head.replace('TYPE', 'truefalse') + '<answer fraction="' + (s.tf === 'true' ? '100' : '0') + '" format="moodle_auto_format"><text>true</text>' + fb(s.tfExplTrue) + '</answer><answer fraction="' + (s.tf === 'false' ? '100' : '0') + '" format="moodle_auto_format"><text>false</text>' + fb(s.tfExplFalse) + '</answer></question>');
      } else if (s.type === 'matching') {
        const parts = [head.replace('TYPE', 'matching'), '<shuffleanswers>true</shuffleanswers>'];
        s.left.forEach(function (l) { const r = s.right.filter(function (x) { return x.id === s.pairs[l.id]; })[0]; parts.push('<subquestion format="html">' + cd(html(l.text)) + '<answer>' + cd(r ? r.text : '') + '</answer></subquestion>'); });
        s.right.forEach(function (r) { if (s.left.every(function (l) { return s.pairs[l.id] !== r.id; })) parts.push('<subquestion format="html">' + cd('') + '<answer>' + cd(r.text) + '</answer></subquestion>'); });
        out.push(parts.join('') + '</question>');
      } else skipped++;
    });
    return { text: '<?xml version="1.0" encoding="UTF-8"?>\n<quiz>\n' + out.join('\n') + '\n</quiz>\n', count: out.length, skipped: skipped, ext: 'xml', mime: 'application/xml' };
  }

  const csvCell = function (t) { t = txtOf(t); return /[",;\n\r\t]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
  function toCsv(states) {
    const lines = [CSV_COLS.join(',')];
    let skipped = 0;
    states.forEach(function (s) {
      const row = { type: s.type, question: s.stem, explanation: s.expl, feedback_correct: s.fbOk, feedback_incorrect: s.fbBad, points: s.points, difficulty: s.difficulty, status: s.status };
      let opts = [];
      if (s.type === 'true_false') { row.correct = s.tf; }
      else if (s.type === 'matching') { opts = s.left.map(function (l) { const r = s.right.filter(function (x) { return x.id === s.pairs[l.id]; })[0]; return l.text + '=>' + (r ? r.text : ''); }); s.right.forEach(function (r) { if (s.left.every(function (l) { return s.pairs[l.id] !== r.id; })) opts.push('=>' + r.text); }); }
      else if (s.type === 'mcq_single' || s.type === 'multi_response') {
        opts = s.options.map(function (o) { return o.text; });
        row.correct = s.options.map(function (o, i) { return s.correct.indexOf(o.id) !== -1 ? String.fromCharCode(65 + i) : ''; }).filter(Boolean).join(';');
      } else { skipped++; return; }
      if (opts.length > 6) { skipped++; return; } /* القالب 6 أعمدة خيارات */
      for (let i = 0; i < 6; i++) row['option_' + LETTERS.charAt(i)] = opts[i] || '';
      lines.push(CSV_COLS.map(function (c) { return csvCell(row[c]); }).join(','));
    });
    return { text: '﻿' + lines.join('\r\n') + '\r\n', count: lines.length - 1, skipped: skipped, ext: 'csv', mime: 'text/csv' };
  }
  function csvTemplate() {
    const ex = [
      ['mcq_single', 'ما عاصمة ليبيا؟', 'طرابلس', 'بنغازي', 'سبها', '', '', '', 'A', 'طرابلس هي العاصمة.', '', '', '1', 'easy', 'draft'],
      ['multi_response', 'اختر الأعداد الزوجية', '2', '3', '4', '5', '', '', 'A;C', '', '', '', '2', 'medium', 'draft'],
      ['true_false', 'الشمس نجم.', '', '', '', '', '', '', 'true', '', '', '', '1', 'easy', 'draft'],
      ['matching', 'طابق الدولة بعاصمتها', 'ليبيا=>طرابلس', 'مصر=>القاهرة', 'تونس=>تونس', '=>الجزائر', '', '', '', '', '', '', '3', 'medium', 'draft']
    ];
    return '﻿' + CSV_COLS.join(',') + '\r\n' + ex.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n') + '\r\n';
  }

  QB.io = {
    LIMITS: LIMITS, FORMATS: [['aiken', 'Aiken'], ['gift', 'GIFT'], ['moodle', 'Moodle XML'], ['csv', 'CSV']],
    detect: detect, parse: parse, check: check, parseAiken: parseAiken, parseGift: parseGift, parseMoodle: parseMoodle, parseCsv: parseCsv,
    toAiken: toAiken, toGift: toGift, toMoodle: toMoodle, toCsv: toCsv, csvTemplate: csvTemplate, htmlToText: htmlToText
  };
})();
