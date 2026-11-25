/* =====================================================================
   admin-stats.js — قسم «الإحصاءات» (#stats) في لوحة المدرب
   مصدر الأرقام واحد: دالة القاعدة admin_stats() (للمدير فقط؛ لغيره تُرجع forbidden/42501 فتظهر رسالة صلاحية واضحة).
   الأعداد كلها من الخادم؛ الوحيد المحسوب هنا هو «متوسط الدرجات العام» = متوسط متوسطات الدورات موزونًا بعدد المحاولات.
   الأشرطة عناصر CSS عادية (بلا مكتبات رسوم)، وعرضها يُضبط بـ CSSOM.
   ===================================================================== */
(function () {
  'use strict';

  const A = window.Admin;
  if (!A) return;
  const P = A.P;
  const h = A.h;

  function statCard(label, value, hint, href) {
    const kids = [h('span', { class: 'big', text: value }), h('b', { text: label }), hint ? h('small', { text: hint }) : null];
    return href ? h('a', { class: 'ad-stat', href: href }, kids) : h('div', { class: 'ad-stat' }, kids);
  }
  const n = function (v) { return Number(v) || 0; };

  /* صف شريط: label عنوان، parts = [{cls, pct}]، val عنصر القيمة */
  function barRow(label, sub, parts, val, fills) {
    const bar = h('div', { class: 'ad-cbar', 'aria-hidden': 'true' }, parts.map(function (p) {
      const s = h('span', { class: p.cls });
      fills.push([s, p.pct]);
      return s;
    }));
    return h('li', { class: 'ad-crow' }, h('div', { class: 'ad-clabel' }, label, sub ? h('small', { text: sub }) : null), bar, val);
  }

  async function render(root, args, token) {
    const refresh = A.btn('تحديث', { icon: 'refresh', small: true });
    root.appendChild(A.head('الإحصاءات', 'نظرة سريعة على المتدربين والاشتراكات والأسئلة المحاكية والرسائل والمدونة.', [refresh]));
    const body = h('div', { class: 'ad-statsbody' });
    root.appendChild(body);

    async function load() {
      A.clear(body);
      body.appendChild(A.loading('جارٍ تحميل الإحصاءات…'));
      refresh.disabled = true;
      let st;
      try {
        const r = await Promise.all([P.rest.rpc('admin_stats', {}), A.settle(A.loadCourses(true))]);
        st = r[0];
      } catch (err) {
        refresh.disabled = false;
        if (A.stale(token)) return;
        if (A.isSession(err)) { A.lost('expired'); return; }
        A.clear(body);
        if (A.isForbidden(err)) {
          A.hooks.forbidden();
          body.appendChild(A.fail('ليست لديك صلاحية لعرض الإحصاءات. هذا القسم للمدرب فقط.'));
        } else body.appendChild(A.fail(A.errText(err), load));
        return;
      }
      refresh.disabled = false;
      if (A.stale(token)) return;
      if (!st || typeof st !== 'object') { A.clear(body); body.appendChild(A.fail(P.MSG.server, load)); return; }

      /* متوسط الدرجات العام: موزون بعدد المحاولات في كل دورة */
      let att = 0;
      let sum = 0;
      (Array.isArray(st.quiz_per_course) ? st.quiz_per_course : []).forEach(function (q) {
        if (n(q.attempts) > 0 && q.avg_percent !== null && q.avg_percent !== undefined) { att += n(q.attempts); sum += n(q.avg_percent) * n(q.attempts); }
      });
      const avg = att ? Math.round(sum / att) : null;

      A.clear(body);
      const fills = [];
      body.appendChild(h('div', { class: 'ad-stats' },
        statCard('إجمالي المتدربين', A.num(st.trainees_total), 'كل الحسابات بدور متدرب'),
        statCard('جدد هذا الأسبوع', A.num(st.trainees_new_7d), 'آخر ٧ أيام'),
        statCard('جدد هذا الشهر', A.num(st.trainees_new_30d), 'آخر ٣٠ يومًا'),
        statCard('الحسابات النشطة', A.num(st.trainees_active), 'حالة الحساب «نشط»'),
        statCard('ظهروا خلال ٣٠ يومًا', A.num(st.trainees_seen_30d), 'دخلوا لوحتهم مؤخرًا'),
        statCard('الحسابات الموقوفة', A.num(st.trainees_suspended), 'محتواهم محجوب'),
        statCard('الاشتراكات النشطة', A.num(st.enrollments_active_total), 'في كل الدورات', '#enrollments'),
        statCard('محاولات الأسئلة', A.num(st.quiz_attempts_total), 'الأسئلة المحاكية'),
        statCard('متوسط الدرجات', avg === null ? '—' : avg + '%', avg === null ? 'لا محاولات بعد' : 'على كل المحاولات'),
        statCard('رسائل غير مقروءة', A.num(st.messages_unread), 'من «تواصل معنا»', '#messages'),
        statCard('منشورات منشورة', A.num(st.posts_published), 'في المدونة', '#blog')));

      /* ١) الاشتراكات لكل دورة (نشط وملغى) */
      const per = Array.isArray(st.enrollments_per_course) ? st.enrollments_per_course : [];
      const maxEnr = Math.max(1, Math.max.apply(null, per.map(function (c) { return n(c.active) + n(c.revoked); }).concat([1])));
      const chart1 = h('ul', { class: 'ad-chart', 'aria-label': 'الاشتراكات لكل دورة' }, per.map(function (c) {
        return barRow(String(c.title_ar || c.course_id), String(c.course_id || ''),
          [{ cls: 'a', pct: n(c.active) * 100 / maxEnr }, { cls: 'r', pct: n(c.revoked) * 100 / maxEnr }],
          h('span', { class: 'ad-cval' }, A.num(c.active), n(c.revoked) ? h('small', { text: ' (+' + A.num(c.revoked) + ' ملغى)' }) : null), fills);
      }));

      /* ٢) أكثر الدورات اشتراكًا */
      const top = Array.isArray(st.top_courses) ? st.top_courses : [];
      const maxTop = Math.max(1, Math.max.apply(null, top.map(function (c) { return n(c.active); }).concat([1])));
      const chart2 = top.length
        ? h('ol', { class: 'ad-chart', 'aria-label': 'أكثر الدورات اشتراكًا' }, top.map(function (c, i) {
          return barRow((i + 1) + '. ' + String(c.title_ar || c.course_id), null, [{ cls: 'a', pct: n(c.active) * 100 / maxTop }],
            h('span', { class: 'ad-cval', text: A.num(c.active) }), fills);
        }))
        : A.empty('لا توجد اشتراكات نشطة بعد', 'ستظهر هنا أكثر الدورات اشتراكًا بعد أن تضيف اشتراكات للمتدربين.');

      /* ٣) الأسئلة المحاكية لكل دورة: عدد المحاولات ومتوسط الدرجة */
      const qz = Array.isArray(st.quiz_per_course) ? st.quiz_per_course : [];
      const chart3 = h('ul', { class: 'ad-chart', 'aria-label': 'الأسئلة المحاكية لكل دورة' }, qz.map(function (c) {
        const has = n(c.attempts) > 0 && c.avg_percent !== null && c.avg_percent !== undefined;
        return barRow(A.courseTitle(String(c.course_id)), n(c.attempts) + ' محاولة', [{ cls: 'a', pct: has ? n(c.avg_percent) : 0 }],
          h('span', { class: 'ad-cval', text: has ? n(c.avg_percent) + '%' : '—' }), fills);
      }));

      body.appendChild(h('div', { class: 'ad-two' },
        A.card('الاشتراكات لكل دورة', [
          h('p', { class: 'ad-legend' }, h('span', null, h('i', { class: 'a' }), 'نشط'), h('span', null, h('i', { class: 'r' }), 'ملغى')),
          chart1]),
        A.card('أكثر الدورات اشتراكًا', chart2)));
      body.appendChild(A.card('الأسئلة المحاكية لكل دورة', [
        h('p', { class: 'ad-sub', text: 'طول الشريط = متوسط الدرجات، والرقم تحته عدد المحاولات.' }), chart3]));
      body.appendChild(h('p', { class: 'ad-sub', text: 'آخر تحديث: ' + (st.generated_at ? A.fmtDate(st.generated_at) : '—') }));

      /* الأشرطة تنمو بعد الإدراج (انتقال CSS) */
      window.requestAnimationFrame(function () { window.requestAnimationFrame(function () { fills.forEach(function (f) { f[0].style.width = Math.max(0, Math.min(100, f[1])) + '%'; }); }); });
      A.setBadge(n(st.messages_unread));
    }

    refresh.addEventListener('click', load);
    await load();
  }

  A.register('stats', { label: 'الإحصاءات', render: render });
})();
