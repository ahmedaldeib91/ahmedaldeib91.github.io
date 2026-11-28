/* =====================================================================
   admin-lms.js — ثلاثة أقسام عامة (عبر كل الدورات) للقراءة فقط، من جداول موجودة (بلا ترحيل ولا RPC جديد):
   #learning  إدارة التعلم: تقدم المتدربين وإكمالهم وأهلية الشهادات والواجبات (lms_lessons / lms_progress / enrollments / asg_*)
   #reports   التقارير والتحليلات: أداء الدورات وتقرير المتدربين، تصدير CSV (يفتح في Excel) وطباعة/حفظ PDF
   #certs     الشهادات: سجل كل الشهادات (سارية وملغاة) مع رابط التحقق العام (cert_certificates)
   الإصدار والإلغاء يبقيان في تبويب «الشهادات» داخل الدورة. كل نص يدخل الصفحة بـ textContent عبر h().
   ===================================================================== */
(function () {
  'use strict';
  const A = window.Admin;
  if (!A) return;
  const h = A.h;

  function blank(id, title) { return { id: id, title: title, lessons: 0, active: 0, revoked: 0, done: 0, sum: 0, certs: 0, asg: 0, sub: 0, graded: 0 }; }

  async function load() {
    const dir = await A.loadDirectory();
    const r = await Promise.all([
      A.all('lms_lessons', { select: 'id,course_id', published: 'eq.true', order: 'id.asc' }),
      A.all('lms_progress', { select: 'user_id,lesson_id,course_id', completed: 'eq.true', order: 'user_id.asc,lesson_id.asc' }),
      A.all('cert_certificates', { select: 'id,code,user_id,course_id,holder_name,course_title_ar,issued_at,revoked_at,revoke_reason', order: 'issued_at.desc,id.asc' }),
      A.all('asg_assignments', { select: 'id,course_id', published: 'eq.true', order: 'id.asc' }),
      A.all('asg_submissions', { select: 'id,course_id,status', order: 'id.asc' })
    ]);
    const D = { dir: dir, certs: r[2], courses: {}, learners: [] };
    A.S.courses.forEach(function (c) { D.courses[c.id] = blank(c.id, c.title_ar); });
    function C(id) { return D.courses[id] || (D.courses[id] = blank(id, id)); }
    r[0].forEach(function (l) { C(l.course_id).lessons++; });
    const prog = {};
    r[1].forEach(function (p) { const k = p.user_id + '|' + p.course_id; prog[k] = (prog[k] || 0) + 1; });
    const certd = {};
    r[2].forEach(function (c) { if (!c.revoked_at) { certd[c.user_id + '|' + c.course_id] = true; C(c.course_id).certs++; } });
    r[3].forEach(function (a) { C(a.course_id).asg++; });
    r[4].forEach(function (s) { const c = C(s.course_id); if (s.status !== 'draft') c.sub++; if (s.status === 'graded') c.graded++; });
    dir.enrollments.forEach(function (e) {
      const c = C(e.course_id);
      if (e.status !== 'active') { c.revoked++; return; }
      c.active++;
      const k = e.user_id + '|' + e.course_id;
      const n = Math.min(prog[k] || 0, c.lessons);
      const pct = c.lessons ? Math.round(n * 100 / c.lessons) : 0;
      c.sum += pct;
      const ok = !!c.lessons && n >= c.lessons;
      if (ok) c.done++;
      D.learners.push({ user: e.user_id, course: e.course_id, pct: pct, eligible: ok, cert: !!certd[k] });
    });
    return D;
  }

  const avg = function (c) { return c.active ? Math.round(c.sum / c.active) : 0; };
  const rate = function (c) { return c.active ? Math.round(c.done * 100 / c.active) : 0; };
  function stat(value, label, hint) { return h('div', { class: 'ad-stat' }, h('span', { class: 'big', text: value }), h('b', { text: label }), hint ? h('small', { text: hint }) : null); }
  function bar(p) { const s = h('span', { class: 'a' }); s.style.width = p + '%'; return h('div', { class: 'ad-cbar', 'aria-hidden': 'true' }, s); }
  function coursesList(D) { return Object.keys(D.courses).map(function (k) { return D.courses[k]; }); }
  function csvDown(name, rows) { A.download(name, A.csvBuild(rows)); }
  function courseCols() {
    return [
      { label: 'الدورة', cell: function (c) { return h('a', { href: '#courses/' + c.id, text: c.title }); } },
      { label: 'المشتركون', cell: function (c) { return A.num(c.active); } },
      { label: 'الدروس', cell: function (c) { return A.num(c.lessons); } },
      { label: 'متوسط التقدم', cell: function (c) { return h('span', null, bar(avg(c)), avg(c) + '%'); } },
      { label: 'أكملوا', cell: function (c) { return A.num(c.done) + ' (' + rate(c) + '%)'; } },
      { label: 'الشهادات', cell: function (c) { return A.num(c.certs); } },
      { label: 'الواجبات / التسليمات', cell: function (c) { return A.num(c.asg) + ' / ' + A.num(c.sub); } }
    ];
  }
  /* يعرض التحميل ثم يعيد البيانات (أو undefined إن تغيّر القسم) ويفرّغ الجذر */
  async function boot(root, token) {
    root.appendChild(A.loading('جارٍ التحميل…'));
    const D = await load();
    if (A.stale(token)) return null;
    A.clear(root);
    return D;
  }

  /* ---------- إدارة التعلم ---------- */
  const LSUB = 'تقدم المتدربين وتتبع الإكمال وأهلية الشهادات والواجبات عبر كل الدورات. التفاصيل والإصدار داخل كل دورة.';
  A.register('learning', {
    label: 'إدارة التعلم',
    render: async function (root, args, token) {
      root.appendChild(A.head('إدارة التعلم', LSUB, []));
      const D = await boot(root, token);
      if (!D) return;
      root.appendChild(A.head('إدارة التعلم', LSUB, []));
      const cs = coursesList(D);
      const act = D.learners.length;
      const done = D.learners.filter(function (l) { return l.eligible; }).length;
      const pend = D.learners.filter(function (l) { return l.eligible && !l.cert; }).length;
      root.appendChild(h('div', { class: 'ad-stats' },
        stat(A.num(act), 'اشتراكات نشطة'),
        stat(A.num(done), 'أكملوا كل الدروس', act ? Math.round(done * 100 / act) + '%' : ''),
        stat(A.num(pend), 'مؤهلون بلا شهادة'),
        stat(A.num(cs.reduce(function (s, c) { return s + c.sub; }, 0)), 'تسليمات الواجبات')));
      root.appendChild(A.card('التقدم حسب الدورة', A.dataTable(courseCols(), cs, { caption: 'التقدم حسب الدورة' })));
      const sel = A.select([['', 'كل الدورات']].concat(cs.map(function (c) { return [c.id, c.title]; })), '');
      const holder = h('div');
      function draw() {
        A.clear(holder);
        const rows = D.learners.filter(function (l) { return !sel.value || l.course === sel.value; }).sort(function (a, b) { return b.pct - a.pct; }).slice(0, 300);
        holder.appendChild(rows.length ? A.dataTable([
          { label: 'المتدرب', cell: function (l) { return A.nameOf(l.user); } },
          { label: 'الدورة', cell: function (l) { return A.courseTitle(l.course); } },
          { label: 'التقدم', cell: function (l) { return h('span', null, bar(l.pct), l.pct + '%'); } },
          { label: 'الأهلية', cell: function (l) { return l.cert ? A.badge('حصل على شهادة', 'ok') : l.eligible ? A.badge('مؤهل', 'ok') : A.badge('قيد التقدم', 'mut'); } }
        ], rows, { caption: 'تقدم المتدربين' }) : A.empty('لا توجد اشتراكات', 'لا يوجد متدربون مشتركون في هذا الاختيار.'));
      }
      sel.addEventListener('change', draw);
      root.appendChild(A.card('تقدم المتدربين (أعلى 300)', [A.field('الدورة', sel), holder]));
      draw();
    }
  });

  /* ---------- التقارير والتحليلات ---------- */
  const RSUB = 'أداء الدورات وتقارير المتدربين، مع تصدير CSV (يفتح في Excel) وحفظ PDF بالطباعة.';
  A.register('reports', {
    label: 'التقارير والتحليلات',
    render: async function (root, args, token) {
      root.appendChild(A.head('التقارير والتحليلات', RSUB, []));
      const D = await boot(root, token);
      if (!D) return;
      const cs = coursesList(D);
      root.appendChild(A.head('التقارير والتحليلات', RSUB, [
        A.btn('تصدير الدورات (Excel)', { small: true, on: function () { csvDown('courses-report.csv', [['الدورة', 'المشتركون', 'الدروس', 'متوسط التقدم %', 'أكملوا', 'الشهادات', 'الواجبات', 'التسليمات']].concat(cs.map(function (c) { return [c.title, c.active, c.lessons, avg(c), c.done, c.certs, c.asg, c.sub]; }))); } }),
        A.btn('تصدير المتدربين (Excel)', { small: true, on: function () { csvDown('trainees-report.csv', [['المتدرب', 'الدورة', 'التقدم %', 'مؤهل', 'شهادة']].concat(D.learners.map(function (l) { return [A.nameOf(l.user), A.courseTitle(l.course), l.pct, l.eligible ? 'نعم' : 'لا', l.cert ? 'نعم' : 'لا']; }))); } }),
        A.btn('حفظ PDF / طباعة', { small: true, on: function () { window.print(); } })
      ]));
      root.appendChild(h('div', { class: 'ad-stats' },
        stat(A.num(cs.length), 'الدورات'),
        stat(A.num(cs.reduce(function (s, c) { return s + c.active; }, 0)), 'اشتراكات نشطة'),
        stat(A.num(cs.reduce(function (s, c) { return s + c.done; }, 0)), 'إكمالات'),
        stat(A.num(D.certs.filter(function (c) { return !c.revoked_at; }).length), 'شهادات سارية')));
      root.appendChild(A.card('أداء الدورات والتسجيل والإكمال', A.dataTable(courseCols(), cs, { caption: 'أداء الدورات' })));
      root.appendChild(A.card('قريبًا', h('p', { class: 'ad-muted', text: 'تقارير أداء الاختبارات والمدربين والتقرير المالي والتقارير المخصصة تُضاف لاحقًا.' })));
    }
  });

  /* ---------- الشهادات ---------- */
  const CSUB = 'سجل كل الشهادات الصادرة والملغاة مع رابط التحقق العام. الإصدار والإلغاء من تبويب «الشهادات» داخل الدورة.';
  A.register('certs', {
    label: 'الشهادات',
    render: async function (root, args, token) {
      root.appendChild(A.head('الشهادات', CSUB, []));
      const D = await boot(root, token);
      if (!D) return;
      root.appendChild(A.head('الشهادات', CSUB, [A.link('صفحة التحقق', '/verify/')]));
      const sel = A.select([['all', 'الكل'], ['active', 'سارية'], ['revoked', 'ملغاة']], 'all');
      const q = A.input({ type: 'search' });
      const holder = h('div');
      function draw() {
        A.clear(holder);
        const t = A.normAr(q.value || '');
        const rows = D.certs.filter(function (c) {
          if (sel.value === 'active' && c.revoked_at) return false;
          if (sel.value === 'revoked' && !c.revoked_at) return false;
          return !t || A.normAr(c.holder_name + ' ' + c.course_title_ar + ' ' + c.code).indexOf(t) !== -1;
        }).slice(0, 300);
        holder.appendChild(rows.length ? A.dataTable([
          { label: 'الاسم', cell: function (c) { return c.holder_name; } },
          { label: 'الدورة', cell: function (c) { return c.course_title_ar; } },
          { label: 'الرمز', cls: 'ad-ltr', cell: function (c) { return h('a', { href: '/verify/?code=' + encodeURIComponent(c.code), text: c.code }); } },
          { label: 'التاريخ', cell: function (c) { return A.fmtDay(c.issued_at); } },
          { label: 'الحالة', cell: function (c) { return c.revoked_at ? A.badge('ملغاة', 'mut') : A.badge('سارية', 'ok'); } },
          { label: 'سبب الإلغاء', cell: function (c) { return c.revoke_reason || '—'; } }
        ], rows, { caption: 'سجل الشهادات' }) : A.empty('لا شهادات', 'لا توجد شهادات مطابقة.'));
      }
      sel.addEventListener('change', draw);
      q.addEventListener('input', A.debounce(draw, 200));
      root.appendChild(A.card(null, [h('div', { class: 'ad-tools' }, A.field('الحالة', sel), A.field('بحث', q)), holder]));
      draw();
    }
  });

  /* ---------- أقسام عامة بمنتقي دورة: تعرض وحدات مركز الدورة نفسها دون تكرار منطقها ---------- */
  let lastCourse = '';
  const MISSING = 'تعذّر تحميل هذا القسم. حدّث الصفحة ثم أعد المحاولة.';
  function scoped(name, label, sub, mount) {
    A.register(name, {
      label: label,
      render: async function (root, args, token) {
        root.appendChild(A.head(label, sub, []));
        const courses = await A.loadCourses();
        if (A.stale(token)) return;
        if (!courses.length) { root.appendChild(A.empty('لا توجد دورات', 'أنشئ دورة أولًا من «إدارة الدورات».')); return; }
        let id = args[0] && A.courseById(args[0]) ? args[0] : (lastCourse && A.courseById(lastCourse) ? lastCourse : courses[0].id);
        lastCourse = id;
        const sel = A.select(courses.map(function (c) { return [c.id, c.title_ar + (c.published ? '' : ' (غير منشورة)')]; }), id);
        sel.addEventListener('change', function () { window.location.hash = '#' + name + '/' + encodeURIComponent(sel.value); });
        root.appendChild(h('div', { class: 'ad-tools' }, A.field('الدورة', sel, 'كل ما في هذا القسم يخص الدورة المختارة وحدها.')));
        const box = h('div');
        root.appendChild(box);
        box.appendChild(A.loading('جارٍ التحميل…'));
        try { A.clear(box); await mount(box, id, token, args[1] || '', args[2] || ''); } catch (err) {
          if (A.stale(token)) return;
          if (A.isSession(err) || A.isForbidden(err)) throw err;
          A.clear(box);
          box.appendChild(A.fail(A.errText(err)));
        }
      }
    });
  }
  function need(m) { if (!m) throw new A.P.ApiError('other', MISSING, 0, 'module'); return m; }
  scoped('lessons', 'الدروس والمحتوى', 'وحدات الدورة ودروسها ومواردها.', function (b, id, t) { return need(A.lessons).render(b, id, t); });
  scoped('groups', 'المجموعات', 'مجموعات التدريب في الدورة وأعضاؤها.', function (b, id, t, g, s) { return need(A.groups).render(b, id, t, { group: g, section: s }); });
  scoped('assignments', 'الواجبات', 'واجبات الدورة وتسليمات المتدربين وتقييمها.', function (b, id, t, x) { return need(A.assignments).render(b, id, t, { assignment: x }); });
  scoped('grading', 'التصحيح', 'طابور تصحيح محاولات الاختبارات اليدوي.', function (b, id, t, x) { return need(A.grading).render(b, id, t, { attempt: x }); });
  scoped('discussions', 'المناقشات', 'نقاشات المتدربين في الدورة.', function (b, id, t, x) { return need(A.discussions).render(b, id, t, { thread: x }); });
  function qmod(k) { const q = A.qb; return need(q && q.mods && q.mods[k]); }
  scoped('qfolders', 'مجلدات بنك الأسئلة', 'تنظيم أسئلة الدورة في مجلدات ومجلدات فرعية وتصنيفات.', function (b, id, t) { return qmod('taxonomy').render(b, { course: id, token: t, extra: '' }); });
  scoped('qteam', 'فريق بنك الأسئلة', 'من يملك صلاحية العمل على بنك أسئلة الدورة.', function (b, id, t) { return qmod('staff').render(b, { course: id, token: t, extra: '' }); });
  /* ملفات الدورة وفيديوهاتها تُدار في مركز الدورة (الرفع والترتيب والروابط): هنا قائمة الدورات بروابط مباشرة إلى التبويب */
  function picker(name, label, sub, tab, noun) {
    A.register(name, {
      label: label,
      render: async function (root, args, token) {
        root.appendChild(A.head(label, sub, []));
        const courses = await A.loadCourses();
        if (A.stale(token)) return;
        root.appendChild(courses.length ? A.card(null, A.dataTable([
          { label: 'الدورة', cell: function (c) { return c.title_ar; } },
          { label: 'الحالة', cell: function (c) { return c.published ? A.badge('منشورة', 'ok') : A.badge('غير منشورة', 'mut'); } },
          { label: noun, cell: function (c) { return A.link('فتح', '#courses/' + encodeURIComponent(c.id) + '/' + tab, { small: true }); } }
        ], courses, { caption: label })) : A.empty('لا توجد دورات', 'أنشئ دورة أولًا من «كل الدورات».'));
      }
    });
  }
  picker('cfiles', 'ملفات الدورات', 'رفع ملفات الدورة (PDF وغيرها) وترتيبها وإدارتها. اختر الدورة لفتح مكتبة ملفاتها.', 'files', 'مكتبة الملفات');
  picker('cvideos', 'فيديوهات الدورات', 'إضافة فيديوهات الدورة وترتيبها وإدارتها. اختر الدورة لفتح مكتبة فيديوهاتها.', 'videos', 'مكتبة الفيديوهات');
  scoped('certissue', 'إصدار الشهادات', 'مشتركو الدورة وأهليتهم، وإصدار الشهادة أو إلغاؤها.', function (b, id, t) { return need(A.certificates).render(b, id, t); });
})();
