-- rls_security_tests.sql
-- Security test suite for phase P2. Runs ENTIRELY inside one transaction and ends with ROLLBACK:
-- every fixture (users, enrollments, messages, storage rows...) disappears afterwards.
-- Run it as one script in the Supabase SQL editor (role postgres). Output: one row per test.

begin;

-- ------------------------------------------------------------------ harness
create temp table t_results (n serial primary key, test text, pass boolean, detail text);

create function pg_temp.rec(p_test text, p_pass boolean, p_detail text) returns void
language sql security definer as
$$ insert into pg_temp.t_results (test, pass, detail) values (p_test, p_pass, p_detail) $$;

-- rows returned must equal p_expected
create function pg_temp.expect_count(p_test text, p_sql text, p_expected bigint) returns void
language plpgsql as $$
declare n bigint;
begin
  execute 'select count(*) from (' || p_sql || ') s' into n;
  perform pg_temp.rec(p_test, n = p_expected, format('rows=%s expected=%s', n, p_expected));
exception when others then
  perform pg_temp.rec(p_test, false, 'ERROR ' || sqlstate || ': ' || sqlerrm);
end $$;

-- pass if permission denied OR zero rows visible
create function pg_temp.expect_hidden(p_test text, p_sql text) returns void
language plpgsql as $$
declare n bigint;
begin
  execute 'select count(*) from (' || p_sql || ') s' into n;
  perform pg_temp.rec(p_test, n = 0, format('rows=%s (RLS filtered)', n));
exception when others then
  perform pg_temp.rec(p_test, true, 'denied: ' || sqlstate || ' ' || left(sqlerrm, 120));
end $$;

-- pass if the statement raises an error
create function pg_temp.expect_error(p_test text, p_sql text) returns void
language plpgsql as $$
begin
  execute p_sql;
  perform pg_temp.rec(p_test, false, 'NO ERROR - statement succeeded');
exception when others then
  perform pg_temp.rec(p_test, true, 'blocked: ' || sqlstate || ' ' || left(sqlerrm, 120));
end $$;

-- pass if the statement affects exactly p_expected rows without error
create function pg_temp.expect_affected(p_test text, p_sql text, p_expected bigint) returns void
language plpgsql as $$
declare n bigint;
begin
  execute p_sql;
  get diagnostics n = row_count;
  perform pg_temp.rec(p_test, n = p_expected, format('affected=%s expected=%s', n, p_expected));
exception when others then
  perform pg_temp.rec(p_test, false, 'ERROR ' || sqlstate || ': ' || sqlerrm);
end $$;

-- pass if a boolean SQL expression is true
create function pg_temp.expect_true(p_test text, p_sql text) returns void
language plpgsql as $$
declare b boolean; d text;
begin
  execute 'select (' || p_sql || ')::boolean' into b;
  perform pg_temp.rec(p_test, coalesce(b, false), 'value=' || coalesce(b::text, 'null'));
exception when others then
  perform pg_temp.rec(p_test, false, 'ERROR ' || sqlstate || ': ' || sqlerrm);
end $$;

-- ------------------------------------------------------------------ fixtures (as postgres)
-- A = trainee, B = trainee, D = admin. A's signup metadata tries to claim role=admin.
insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, raw_app_meta_data) values
 ('00000000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
  'p2test-a@example.invalid', '{"full_name":"Trainee A","role":"admin","country":"EG"}', '{}'),
 ('00000000-0000-4000-8000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
  'p2test-b@example.invalid', '{"full_name":"Trainee B"}', '{}'),
 ('00000000-0000-4000-8000-00000000000d', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
  'p2test-admin@example.invalid', '{"full_name":"Admin D"}', '{}');

select pg_temp.expect_true('signup trigger: role=trainee although raw_user_meta_data.role=admin',
  $q$ (select role = 'trainee' and status = 'active' and full_name = 'Trainee A'
       from public.profiles where id = '00000000-0000-4000-8000-00000000000a') $q$);
select pg_temp.expect_count('signup trigger: profile created for each new auth user',
  $q$ select 1 from public.profiles where id::text like '00000000-0000-4000-8000-00000000000%' $q$, 3);

-- promote D exactly like the README (SQL editor, privileged role)
update public.profiles set role = 'admin' where id = '00000000-0000-4000-8000-00000000000d';

insert into public.course_items (id, course_id, kind, title, url, storage_path, published) values
 ('10000000-0000-4000-8000-000000000001', 'capm', 'file',  'CAPM file',       null, 'capm/a.pdf', true),
 ('10000000-0000-4000-8000-000000000002', 'capm', 'video', 'CAPM draft video','https://example.com/v', null, false),
 ('10000000-0000-4000-8000-000000000003', 'pmp',  'file',  'PMP file',        null, 'pmp/b.pdf',  true);
insert into public.quiz_questions (id, course_id, question, options, correct_index, published) values
 ('20000000-0000-4000-8000-000000000001', 'capm', 'Q1', '["a","b","c"]', 0, true),
 ('20000000-0000-4000-8000-000000000002', 'capm', 'Q2', '["a","b"]',     1, true),
 ('20000000-0000-4000-8000-000000000003', 'capm', 'Q3 draft', '["a","b"]', 1, false),
 ('20000000-0000-4000-8000-000000000004', 'pmp',  'P1', '["a","b"]',     0, true);
insert into public.enrollments (user_id, course_id) values ('00000000-0000-4000-8000-00000000000b', 'pmp');
insert into public.quiz_attempts (user_id, course_id, answers) values
 ('00000000-0000-4000-8000-00000000000b', 'pmp', '[{"q":"20000000-0000-4000-8000-000000000004","a":0}]');
insert into public.trainer_notes (user_id, notes) values
 ('00000000-0000-4000-8000-00000000000a', 'secret note about A'),
 ('00000000-0000-4000-8000-00000000000b', 'secret note about B');
insert into public.posts (title, slug, body, published) values
 ('Published post', 'p2test-published', 'x', true),
 ('Draft post',     'p2test-draft',     'y', false);
insert into storage.objects (bucket_id, name) values
 ('course-files', 'capm/a.pdf'), ('course-files', 'pmp/b.pdf'), ('blog-media', 'p2test.png');

-- ================================================================== ANON
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select set_config('request.headers', '{"x-forwarded-for":"198.51.100.1, 10.0.0.1"}', true);

select pg_temp.expect_hidden('anon: cannot read profiles',          'select * from public.profiles');
select pg_temp.expect_hidden('anon: cannot read trainer_notes',     'select * from public.trainer_notes');
select pg_temp.expect_hidden('anon: cannot read enrollments',       'select * from public.enrollments');
select pg_temp.expect_hidden('anon: cannot read course_items',      'select * from public.course_items');
select pg_temp.expect_hidden('anon: cannot read quiz_questions',    'select * from public.quiz_questions');
select pg_temp.expect_hidden('anon: cannot read quiz_attempts',     'select * from public.quiz_attempts');
select pg_temp.expect_hidden('anon: cannot read contact_messages',  'select * from public.contact_messages');
select pg_temp.expect_hidden('anon: cannot read audit_log',         'select * from public.audit_log');
select pg_temp.expect_hidden('anon: cannot read site_settings',     'select * from public.site_settings');
select pg_temp.expect_count ('anon: CAN read the 6 published courses', 'select * from public.courses', 6);
select pg_temp.expect_count ('anon: CAN read published posts only (draft hidden)', 'select * from public.posts where slug like ''p2test-%''', 1);
select pg_temp.expect_affected('anon: CAN insert a contact message',
  $q$ insert into public.contact_messages (name, email, message) values ('Visitor', 'v@example.com', 'hello') $q$, 1);
select pg_temp.expect_hidden('anon: cannot SELECT the contact message back', 'select * from public.contact_messages');
select pg_temp.expect_error ('anon: cannot set ip_hash/status columns on insert',
  $q$ insert into public.contact_messages (name, email, message, status, ip_hash) values ('V', 'v@example.com', 'x', 'read', 'fake') $q$);
select pg_temp.expect_error ('anon: cannot call admin_stats()',      'select public.admin_stats()');
select pg_temp.expect_error ('anon: cannot call private.is_admin()', 'select private.is_admin()');
select pg_temp.expect_error ('anon: cannot call admin_user_emails()',         'select * from public.admin_user_emails()');
select pg_temp.expect_error ('anon: cannot call private.admin_user_emails()', 'select * from private.admin_user_emails()');
select pg_temp.expect_error ('anon: cannot insert enrollment',
  $q$ insert into public.enrollments (user_id, course_id) values ('00000000-0000-4000-8000-00000000000a', 'capm') $q$);
select pg_temp.expect_error ('anon: cannot insert posts', $q$ insert into public.posts (title, slug) values ('x', 'p2test-anon') $q$);
select pg_temp.expect_error ('anon: cannot update courses', $q$ update public.courses set published = false $q$);
select pg_temp.expect_hidden('anon: storage course-files hidden', $q$ select * from storage.objects where bucket_id = 'course-files' $q$);
select pg_temp.expect_hidden('anon: storage blog-media listing hidden', $q$ select * from storage.objects where bucket_id = 'blog-media' $q$);
select pg_temp.expect_error ('anon: cannot upload to storage',
  $q$ insert into storage.objects (bucket_id, name) values ('course-files', 'capm/evil.pdf') $q$);

-- contact form validation + rate limit (new IP)
select set_config('request.headers', '{"x-forwarded-for":"203.0.113.9"}', true);
select pg_temp.expect_error('contact: message > 4000 chars rejected',
  $q$ insert into public.contact_messages (name, email, message) values ('V', 'v@example.com', repeat('x', 4001)) $q$);
select pg_temp.expect_error('contact: name > 120 chars rejected',
  $q$ insert into public.contact_messages (name, email, message) values (repeat('n', 121), 'v@example.com', 'x') $q$);
select pg_temp.expect_error('contact: email > 254 chars rejected',
  $q$ insert into public.contact_messages (name, email, message) values ('V', repeat('e', 250) || '@ex.com', 'x') $q$);
select pg_temp.expect_error('contact: invalid email shape rejected',
  $q$ insert into public.contact_messages (name, email, message) values ('V', 'not-an-email', 'x') $q$);
select pg_temp.expect_error('contact: empty message rejected',
  $q$ insert into public.contact_messages (name, email, message) values ('V', 'v@example.com', '   ') $q$);
select pg_temp.expect_affected('contact rate limit: insert #1 ok', $q$ insert into public.contact_messages (name, email, message) values ('R', 'r@example.com', 'm1') $q$, 1);
select pg_temp.expect_affected('contact rate limit: insert #2 ok', $q$ insert into public.contact_messages (name, email, message) values ('R', 'r@example.com', 'm2') $q$, 1);
select pg_temp.expect_affected('contact rate limit: insert #3 ok', $q$ insert into public.contact_messages (name, email, message) values ('R', 'r@example.com', 'm3') $q$, 1);
select pg_temp.expect_affected('contact rate limit: insert #4 ok', $q$ insert into public.contact_messages (name, email, message) values ('R', 'r@example.com', 'm4') $q$, 1);
select pg_temp.expect_affected('contact rate limit: insert #5 ok', $q$ insert into public.contact_messages (name, email, message) values ('R', 'r@example.com', 'm5') $q$, 1);
select pg_temp.expect_error   ('contact rate limit: insert #6 from same IP BLOCKED',
  $q$ insert into public.contact_messages (name, email, message) values ('R', 'r@example.com', 'm6') $q$);
select set_config('request.headers', '{"x-forwarded-for":"203.0.113.10"}', true);
select pg_temp.expect_affected('contact rate limit: another IP still allowed',
  $q$ insert into public.contact_messages (name, email, message) values ('R2', 'r2@example.com', 'ok') $q$, 1);

-- ================================================================== TRAINEE A (no enrollment)
reset role;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-00000000000a","role":"authenticated","user_metadata":{"role":"admin"},"app_metadata":{"role":"admin"}}', true);
set local role authenticated;

select pg_temp.expect_true ('A: JWT user_metadata/app_metadata role=admin does NOT make is_admin() true', 'not private.is_admin()');
select pg_temp.expect_count('A: sees exactly one profile (own)', 'select * from public.profiles', 1);
select pg_temp.expect_hidden('A: cannot read B profile', $q$ select * from public.profiles where id = '00000000-0000-4000-8000-00000000000b' $q$);
select pg_temp.expect_hidden('A: cannot read B enrollment', $q$ select * from public.enrollments where user_id = '00000000-0000-4000-8000-00000000000b' $q$);
select pg_temp.expect_hidden('A: cannot read B quiz attempts', $q$ select * from public.quiz_attempts where user_id = '00000000-0000-4000-8000-00000000000b' $q$);
select pg_temp.expect_hidden('A: cannot read trainer_notes (even own)', 'select * from public.trainer_notes');
select pg_temp.expect_hidden('A (not enrolled): capm course_items hidden', $q$ select * from public.course_items where course_id = 'capm' $q$);
select pg_temp.expect_hidden('A (not enrolled): capm quiz_questions hidden', $q$ select * from public.quiz_questions where course_id = 'capm' $q$);
select pg_temp.expect_hidden('A: B''s pmp course_items hidden', $q$ select * from public.course_items where course_id = 'pmp' $q$);
select pg_temp.expect_hidden('A: storage course-files hidden', $q$ select * from storage.objects where bucket_id = 'course-files' $q$);
select pg_temp.expect_error ('A: cannot self-enroll',
  $q$ insert into public.enrollments (user_id, course_id) values ('00000000-0000-4000-8000-00000000000a', 'capm') $q$);
select pg_temp.expect_affected('A: cannot activate/alter B''s enrollment (0 rows)',
  $q$ update public.enrollments set status = 'revoked' $q$, 0);
select pg_temp.expect_error ('A: cannot UPDATE own role to admin',
  $q$ update public.profiles set role = 'admin' where id = '00000000-0000-4000-8000-00000000000a' $q$);
select pg_temp.expect_error ('A: cannot UPDATE own status',
  $q$ update public.profiles set status = 'suspended' where id = '00000000-0000-4000-8000-00000000000a' $q$);
select pg_temp.expect_error ('A: cannot INSERT a profile with role=admin',
  $q$ insert into public.profiles (id, full_name, role) values ('00000000-0000-4000-8000-0000000000ff', 'x', 'admin') $q$);
select pg_temp.expect_error ('A: cannot upsert own profile with role=admin',
  $q$ insert into public.profiles (id, full_name, role) values ('00000000-0000-4000-8000-00000000000a', 'x', 'admin')
      on conflict (id) do update set role = 'admin' $q$);
select pg_temp.expect_affected('A: CAN update own full_name/phone/country/last_seen_at',
  $q$ update public.profiles set full_name = 'A renamed', phone = '+20100', country = 'EG', last_seen_at = now()
      where id = '00000000-0000-4000-8000-00000000000a' $q$, 1);
select pg_temp.expect_affected('A: cannot update B''s profile (0 rows)',
  $q$ update public.profiles set full_name = 'hacked' where id = '00000000-0000-4000-8000-00000000000b' $q$, 0);
select pg_temp.expect_error ('A: cannot call admin_stats()', 'select public.admin_stats()');
select pg_temp.expect_error ('A: cannot call admin_user_emails() (forbidden)', 'select * from public.admin_user_emails()');
select pg_temp.expect_error ('A: cannot call private.admin_user_emails() directly', 'select * from private.admin_user_emails()');
select pg_temp.expect_hidden('A: cannot read audit_log', 'select * from public.audit_log');
select pg_temp.expect_hidden('A: cannot read contact_messages', 'select * from public.contact_messages');
select pg_temp.expect_count ('A: CAN read the trainee-visible announcement', $q$ select * from public.site_settings where key = 'dashboard_announcement' $q$, 1);
select pg_temp.expect_error ('A: cannot write site_settings',
  $q$ insert into public.site_settings (key, value) values ('p2test', '{}') $q$);
select pg_temp.expect_affected('A: cannot update courses (0 rows)', $q$ update public.courses set published = false $q$, 0);
select pg_temp.expect_error ('A: cannot insert course_items', $q$ insert into public.course_items (course_id, kind, title, url) values ('capm', 'video', 't', 'https://x.y') $q$);
select pg_temp.expect_error ('A (not enrolled): cannot insert quiz attempt',
  $q$ insert into public.quiz_attempts (course_id, answers) values ('capm', '[{"q":"20000000-0000-4000-8000-000000000001","a":0}]') $q$);
select pg_temp.expect_error ('A: cannot upload to storage',
  $q$ insert into storage.objects (bucket_id, name) values ('course-files', 'capm/evil.pdf') $q$);
select pg_temp.expect_hidden('A: draft posts hidden', $q$ select * from public.posts where slug = 'p2test-draft' $q$);

-- ================================================================== ADMIN grants A -> capm
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000d","role":"authenticated"}', true);
set local role authenticated;
select pg_temp.expect_affected('admin: CAN enroll A in capm',
  $q$ insert into public.enrollments (user_id, course_id) values ('00000000-0000-4000-8000-00000000000a', 'capm') $q$, 1);
select pg_temp.expect_true('admin: granted_by stamped with admin id',
  $q$ (select granted_by = '00000000-0000-4000-8000-00000000000d' from public.enrollments
       where user_id = '00000000-0000-4000-8000-00000000000a' and course_id = 'capm') $q$);

-- ================================================================== TRAINEE A (enrolled)
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
set local role authenticated;
select pg_temp.expect_count('A (enrolled): sees published capm course_items only (draft hidden)', $q$ select * from public.course_items where course_id = 'capm' $q$, 1);
select pg_temp.expect_count('A (enrolled): sees published capm quiz_questions only', $q$ select * from public.quiz_questions where course_id = 'capm' $q$, 2);
select pg_temp.expect_hidden('A (enrolled capm): still cannot see pmp items', $q$ select * from public.course_items where course_id = 'pmp' $q$);
select pg_temp.expect_count('A (enrolled): storage capm/ file visible', $q$ select * from storage.objects where bucket_id = 'course-files' and name like 'capm/%' $q$, 1);
select pg_temp.expect_hidden('A (enrolled capm): storage pmp/ hidden', $q$ select * from storage.objects where bucket_id = 'course-files' and name like 'pmp/%' $q$);
select pg_temp.expect_count('A (enrolled): sees own enrollment', 'select * from public.enrollments', 1);
select pg_temp.expect_error ('A: cannot forge score/total columns on attempt',
  $q$ insert into public.quiz_attempts (course_id, answers, score, total) values ('capm', '[]', 100, 100) $q$);
select pg_temp.expect_error ('A: cannot insert attempt for another user',
  $q$ insert into public.quiz_attempts (user_id, course_id, answers) values ('00000000-0000-4000-8000-00000000000b', 'capm', '[{"q":"20000000-0000-4000-8000-000000000001","a":0}]') $q$);
select pg_temp.expect_error ('A: attempt with a draft/foreign question rejected',
  $q$ insert into public.quiz_attempts (course_id, answers) values ('capm', '[{"q":"20000000-0000-4000-8000-000000000003","a":1}]') $q$);
select pg_temp.expect_affected('A (enrolled): CAN insert own quiz attempt',
  $q$ insert into public.quiz_attempts (course_id, answers) values ('capm',
      '[{"q":"20000000-0000-4000-8000-000000000001","a":0},{"q":"20000000-0000-4000-8000-000000000002","a":0}]') $q$, 1);
select pg_temp.expect_true('A: attempt graded server-side (score 1 / total 2)',
  $q$ (select score = 1 and total = 2 from public.quiz_attempts where course_id = 'capm') $q$);
select pg_temp.expect_count('A (enrolled): sees own attempts only', 'select * from public.quiz_attempts', 1);
select pg_temp.expect_hidden('A (enrolled): still cannot read trainer_notes', 'select * from public.trainer_notes');

-- ================================================================== ADMIN revokes, suspends, full access
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000d","role":"authenticated"}', true);
set local role authenticated;
select pg_temp.expect_affected('admin: CAN revoke A capm (status update)',
  $q$ update public.enrollments set status = 'revoked'
      where user_id = '00000000-0000-4000-8000-00000000000a' and course_id = 'capm' $q$, 1);
select pg_temp.expect_true('admin: revoked_at set on revoke',
  $q$ (select revoked_at is not null from public.enrollments where user_id = '00000000-0000-4000-8000-00000000000a' and course_id = 'capm') $q$);

reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
set local role authenticated;
select pg_temp.expect_hidden('A (revoked): capm course_items hidden again', $q$ select * from public.course_items where course_id = 'capm' $q$);
select pg_temp.expect_hidden('A (revoked): capm quiz_questions hidden again', $q$ select * from public.quiz_questions where course_id = 'capm' $q$);
select pg_temp.expect_hidden('A (revoked): storage capm/ hidden again', $q$ select * from storage.objects where bucket_id = 'course-files' $q$);
select pg_temp.expect_error ('A (revoked): cannot insert attempt',
  $q$ insert into public.quiz_attempts (course_id, answers) values ('capm', '[{"q":"20000000-0000-4000-8000-000000000001","a":0}]') $q$);

reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000d","role":"authenticated"}', true);
set local role authenticated;
select pg_temp.expect_affected('admin: CAN suspend trainee B', $q$ update public.profiles set status = 'suspended' where id = '00000000-0000-4000-8000-00000000000b' $q$, 1);

reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000b","role":"authenticated"}', true);
set local role authenticated;
select pg_temp.expect_hidden('B (suspended, active enrollment): pmp items hidden', $q$ select * from public.course_items where course_id = 'pmp' $q$);
select pg_temp.expect_hidden('B (suspended): storage pmp/ hidden', $q$ select * from storage.objects where bucket_id = 'course-files' $q$);
select pg_temp.expect_error ('B (suspended): cannot re-activate himself',
  $q$ update public.profiles set status = 'active' where id = '00000000-0000-4000-8000-00000000000b' $q$);

reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000d","role":"authenticated"}', true);
set local role authenticated;
select pg_temp.expect_true ('admin: is_admin() true for DB role=admin', 'private.is_admin()');
select pg_temp.expect_count('admin: sees all test profiles', $q$ select * from public.profiles where id::text like '00000000-0000-4000-8000-00000000000%' $q$, 3);
select pg_temp.expect_count('admin: reads trainer_notes', 'select * from public.trainer_notes', 2);
select pg_temp.expect_affected('admin: writes trainer_notes', $q$ update public.trainer_notes set notes = 'updated' where user_id = '00000000-0000-4000-8000-00000000000a' $q$, 1);
select pg_temp.expect_true ('admin: admin_stats() returns the JSON object',
  $q$ (select s ? 'trainees_total' and s ? 'enrollments_per_course' and s ? 'quiz_per_course' and s ? 'top_courses'
              and (s ->> 'trainees_suspended')::int >= 1 and (s ->> 'messages_unread')::int >= 7
       from (select public.admin_stats() s) x) $q$);
select pg_temp.expect_count('admin: admin_user_emails() returns the 3 test users',
  $q$ select * from public.admin_user_emails() where user_id::text like '00000000-0000-4000-8000-00000000000%' $q$, 3);
select pg_temp.expect_true ('admin: admin_user_emails() gives the right e-mail per user',
  $q$ (select count(*) = 3 and bool_and(email = case user_id
                when '00000000-0000-4000-8000-00000000000a' then 'p2test-a@example.invalid'
                when '00000000-0000-4000-8000-00000000000b' then 'p2test-b@example.invalid'
                else 'p2test-admin@example.invalid' end)
       from public.admin_user_emails() where user_id::text like '00000000-0000-4000-8000-00000000000%') $q$);
select pg_temp.expect_true ('admin: contact messages readable, ip stored only as hash',
  $q$ (select count(*) >= 7 and bool_and(ip_hash ~ '^[0-9a-f]{64}$') from public.contact_messages) $q$);
select pg_temp.expect_affected('admin: marks message read', $q$ update public.contact_messages set status = 'read' where name = 'Visitor' $q$, 1);
select pg_temp.expect_true ('admin: audit_log has granted/revoked/status entries',
  $q$ (select count(*) filter (where action = 'enrollment.granted') >= 2
          and count(*) filter (where action = 'enrollment.revoked') = 1
          and count(*) filter (where action = 'profile.status_changed') = 1
       from public.audit_log) $q$);
select pg_temp.expect_count('admin: sees all items incl. drafts', 'select * from public.course_items', 3);
select pg_temp.expect_count('admin: sees all storage test objects', $q$ select * from storage.objects where name in ('capm/a.pdf','pmp/b.pdf','p2test.png') $q$, 3);
select pg_temp.expect_affected('admin: CAN insert course_items', $q$ insert into public.course_items (course_id, kind, title, url, published) values ('pmp', 'video', 'v', 'https://example.com/x', true) $q$, 1);
select pg_temp.expect_affected('admin: CAN publish posts', $q$ update public.posts set published = true where slug = 'p2test-draft' $q$, 1);
select pg_temp.expect_affected('admin: CAN write site_settings', $q$ update public.site_settings set value = '{"text":"t","active":true}' where key = 'dashboard_announcement' $q$, 1);
select pg_temp.expect_error ('admin: role cannot be changed from the API (SQL editor only)',
  $q$ update public.profiles set role = 'admin' where id = '00000000-0000-4000-8000-00000000000a' $q$);
select pg_temp.expect_error ('admin: cannot change own status (lock-out protection)',
  $q$ update public.profiles set status = 'suspended' where id = '00000000-0000-4000-8000-00000000000d' $q$);
select pg_temp.expect_affected('admin: CAN upload to storage', $q$ insert into storage.objects (bucket_id, name) values ('course-files', 'capm/new.pdf') $q$, 1);

-- ------------------------------------------------------------------ report, then undo everything
reset role;
select n, case when pass then 'PASS' else 'FAIL' end as result, test, detail from pg_temp.t_results order by n;

rollback;
