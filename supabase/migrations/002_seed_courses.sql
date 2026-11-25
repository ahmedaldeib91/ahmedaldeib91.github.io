-- 002_seed_courses
-- The 6 courses, ids identical to site/data/courses.json (which stays the public display source).
insert into public.courses (id, title_ar, title_en, status, sort, published) values
  ('capm',      'دورة مساعد معتمد في إدارة المشاريع CAPM®',       'Certified Associate in Project Management (CAPM)® Course', 'available', 1, true),
  ('pmp',       'دورة محترف إدارة المشاريع PMP®',                 'Project Management Professional (PMP)® Course',            'available', 2, true),
  ('pmi-rmp',   'دورة محترف إدارة المخاطر PMI-RMP®',              'PMI Risk Management Professional (PMI-RMP)® Course',       'soon',      3, true),
  ('pmi-acp',   'دورة محترف الممارسات الرشيقة PMI-ACP®',          'PMI Agile Certified Practitioner (PMI-ACP)® Course',       'soon',      4, true),
  ('pmi-cp',    'دورة محترف إدارة مشاريع البناء PMI-CP™',         'PMI Construction Professional (PMI-CP)™ Course',           'soon',      5, true),
  ('pmi-pmocp', 'دورة محترف إدارة مكاتب المشاريع PMI-PMOCP™',     'PMI PMO Certified Professional (PMI-PMOCP)™ Course',       'soon',      6, true)
on conflict (id) do update
  set title_ar = excluded.title_ar, title_en = excluded.title_en,
      status = excluded.status, sort = excluded.sort;

-- default dashboard announcement (empty, inactive), readable by signed-in trainees
insert into public.site_settings (key, value, trainee_visible)
values ('dashboard_announcement', '{"text": "", "active": false}'::jsonb, true)
on conflict (key) do nothing;
