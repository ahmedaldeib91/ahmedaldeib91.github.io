-- exams_m1_security_tests.sql
-- Security / behavior tests for exams milestone M1 (migrations 009_exams_foundation + 010_question_bank).
-- Same harness style as rls_security_tests.sql: ONE transaction, ends with ROLLBACK, so every fixture
-- (users, staff rows, questions, counters...) disappears. Run as one script in the SQL editor (role postgres)
-- of the STAGING project first. Output: one row per test (PASS/FAIL) + a summary row.
-- Expected: every row PASS. Also re-run supabase/tests/rls_security_tests.sql afterwards (regression 001..008).

begin;

-- ------------------------------------------------------------------ harness
create temp table t_results (n serial primary key, test text, pass boolean, detail text);
create temp table t_ids (name text primary key, id uuid not null);

create function pg_temp.rec(p_test text, p_pass boolean, p_detail text) returns void
language sql security definer as
$$ insert into pg_temp.t_results (test, pass, detail) values (p_test, p_pass, p_detail) $$;

-- remember / look up a generated id across role switches
create function pg_temp.keep(p_name text, p_id uuid) returns uuid
language sql security definer as
$$ insert into pg_temp.t_ids (name, id) values (p_name, p_id)
   on conflict (name) do update set id = excluded.id returning id $$;
create function pg_temp.idof(p_name text) returns uuid
language sql stable security definer as
$$ select id from pg_temp.t_ids where name = p_name $$;

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

-- pass if the statement raises an error (any SQLSTATE)
create function pg_temp.expect_error(p_test text, p_sql text) returns void
language plpgsql as $$
begin
  execute p_sql;
  perform pg_temp.rec(p_test, false, 'NO ERROR - statement succeeded');
exception when others then
  perform pg_temp.rec(p_test, true, 'blocked: ' || sqlstate || ' ' || left(sqlerrm, 120));
end $$;

-- pass if the statement raises an error with exactly this SQLSTATE
create function pg_temp.expect_state(p_test text, p_sql text, p_state text) returns void
language plpgsql as $$
begin
  execute p_sql;
  perform pg_temp.rec(p_test, false, 'NO ERROR - statement succeeded');
exception when others then
  perform pg_temp.rec(p_test, sqlstate = p_state,
                      format('sqlstate=%s expected=%s: %s', sqlstate, p_state, left(sqlerrm, 120)));
end $$;

-- pass if the statement raises this SQLSTATE AND the message matches (proves WHICH guard fired,
-- e.g. a trigger rather than a column privilege or another FK). p_state may list alternatives 'a|b'.
create function pg_temp.expect_raise(p_test text, p_sql text, p_state text, p_msg_like text) returns void
language plpgsql as $$
begin
  execute p_sql;
  perform pg_temp.rec(p_test, false, 'NO ERROR - statement succeeded');
exception when others then
  perform pg_temp.rec(p_test, sqlstate = any (string_to_array(p_state, '|')) and sqlerrm like p_msg_like,
                      format('sqlstate=%s expected=%s msg~%s: %s', sqlstate, p_state, p_msg_like, left(sqlerrm, 140)));
end $$;

-- pass if the statement runs without error
create function pg_temp.expect_ok(p_test text, p_sql text) returns void
language plpgsql as $$
begin
  execute p_sql;
  perform pg_temp.rec(p_test, true, 'ok');
exception when others then
  perform pg_temp.rec(p_test, false, 'ERROR ' || sqlstate || ': ' || sqlerrm);
end $$;

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

create function pg_temp.expect_true(p_test text, p_sql text) returns void
language plpgsql as $$
declare b boolean;
begin
  execute 'select (' || p_sql || ')::boolean' into b;
  perform pg_temp.rec(p_test, coalesce(b, false), 'value=' || coalesce(b::text, 'null'));
exception when others then
  perform pg_temp.rec(p_test, false, 'ERROR ' || sqlstate || ': ' || sqlerrm);
end $$;

-- the M1 tables (used by the loops below)
create temp table t_new_tables (t text primary key);
insert into t_new_tables values
 ('course_staff'), ('course_folders'), ('ex_security_events'), ('qb_question_types'), ('qb_taxonomy'),
 ('qb_tags'), ('qb_sets'), ('qb_set_versions'), ('qb_questions'), ('qb_question_versions'),
 ('qb_question_keys'), ('qb_question_tags'), ('qb_media');
grant select on t_new_tables to public;

-- ================================================================== STRUCTURE (as postgres)
select pg_temp.expect_true('folders: backfill gave every existing course exactly 5 folders',
  $q$ (select count(*) from public.course_folders) = 5 * (select count(*) from public.courses)
      and not exists (select 1 from public.courses c
                      where (select count(distinct f.kind) from public.course_folders f where f.course_id = c.id) <> 5) $q$);
select pg_temp.expect_true('folders: ensure_course_folders() re-run is idempotent (0 new rows)',
  'private.ensure_course_folders() = 0');
select pg_temp.expect_state('folders: duplicate (course_id, kind) rejected by unique constraint',
  $q$ insert into public.course_folders (course_id, kind, title_ar, title_en) values ('capm', 'question_bank', 'x', 'x') $q$, '23505');
select pg_temp.expect_state('folders: unknown kind rejected',
  $q$ insert into public.course_folders (course_id, kind, title_ar, title_en) values ('capm', 'other', 'x', 'x') $q$, '23514');

select pg_temp.expect_true('registry: 13 question types seeded, exactly mcq_single/multi_response/true_false enabled',
  $q$ (select count(*) = 13 from public.qb_question_types)
      and (select array_agg(code order by code) = array['mcq_single','multi_response','true_false']
           from public.qb_question_types where enabled) $q$);
select pg_temp.expect_state('registry: enabled type without validator rejected',
  $q$ insert into public.qb_question_types (code, name_ar, name_en, grading, enabled) values ('m1test_x', 'x', 'x', 'auto', true) $q$, '23514');
select pg_temp.expect_ok('registry: extensible - a new disabled type is just a row (no schema change)',
  $q$ insert into public.qb_question_types (code, name_ar, name_en, grading) values ('m1test_new_type', 'x', 'x', 'manual') $q$);
select pg_temp.expect_true('registry: validator column is text (no reg* column that blocks pg_upgrade)',
  $q$ (select atttypid = 'text'::regtype from pg_attribute
       where attrelid = 'public.qb_question_types'::regclass and attname = 'validator')
      and not exists (select 1 from pg_attribute a join pg_class c on c.oid = a.attrelid
                      where c.relnamespace in ('public'::regnamespace, 'private'::regnamespace)
                        and c.relname like any (array['qb\_%', 'course\_%', 'ex\_%', 'rl\_%'])
                        and a.attnum > 0 and not a.attisdropped
                        and a.atttypid in ('regproc'::regtype, 'regprocedure'::regtype, 'regoper'::regtype,
                                           'regoperator'::regtype, 'regcollation'::regtype)) $q$);
select pg_temp.expect_true('registry: every seeded validator resolves to an existing function',
  $q$ (select bool_and(to_regprocedure(validator) is not null) from public.qb_question_types where validator is not null) $q$);
select pg_temp.expect_raise('registry: well-formed validator naming a nonexistent function rejected (trigger)',
  $q$ insert into public.qb_question_types (code, name_ar, name_en, grading, validator)
      values ('m1test_nofn', 'x', 'x', 'auto', 'private.qb_validate_does_not_exist(jsonb,jsonb)') $q$,
  '22023', 'validator function not found%');
select pg_temp.expect_raise('registry: UPDATE to a nonexistent validator rejected (trigger)',
  $q$ update public.qb_question_types set validator = 'private.qb_validate_nope(jsonb,jsonb)' where code = 'mcq_single' $q$,
  '22023', 'validator function not found%');
select pg_temp.expect_state('registry: validator outside private.qb_validate_*(jsonb,jsonb) rejected (format CHECK)',
  $q$ insert into public.qb_question_types (code, name_ar, name_en, grading, validator)
      values ('m1test_badfmt', 'x', 'x', 'auto', 'public.qb_save_question(jsonb)') $q$, '23514');
select pg_temp.expect_state('registry: existing function with a wrong signature format rejected (format CHECK)',
  $q$ insert into public.qb_question_types (code, name_ar, name_en, grading, validator)
      values ('m1test_badfmt2', 'x', 'x', 'auto', 'private.qb_validate(text,jsonb,jsonb)') $q$, '23514');
select pg_temp.expect_ok('registry: a new type with an existing validator function is accepted',
  $q$ insert into public.qb_question_types (code, name_ar, name_en, grading, validator)
      values ('m1test_reuse', 'x', 'x', 'auto', 'private.qb_validate_true_false(jsonb,jsonb)') $q$);
select pg_temp.expect_true('registry: dispatcher runs the registered validator (mcq returns option ids)',
  $q$ private.qb_validate('mcq_single', '{"stem":{"text":"q"},"options":[{"id":"a","text":"1"},{"id":"b","text":"2"}]}', '{"correct":"b"}')
      = array['a','b'] $q$);
select pg_temp.expect_state('registry: dispatcher still raises the MCQ validator errors (22023)',
  $q$ select private.qb_validate('mcq_single', '{"stem":{"text":"q"},"options":[{"id":"a","text":"1"},{"id":"b","text":"2"}]}', '{"correct":"z"}') $q$, '22023');
select pg_temp.expect_state('registry: disabled type with a valid validator is still not dispatched',
  $q$ select private.qb_validate('m1test_reuse', '{"stem":{"text":"q"}}', '{"correct":"true"}') $q$, '22023');

select pg_temp.expect_true('RLS enabled AND forced on every M1 table',
  $q$ (select bool_and(c.relrowsecurity and c.relforcerowsecurity)
       from pg_class c join pg_temp.t_new_tables t on c.oid = ('public.' || t.t)::regclass) $q$);
select pg_temp.expect_true('private.rl_counters: RLS forced, no API privilege',
  $q$ (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'private.rl_counters'::regclass)
      and not has_table_privilege('authenticated', 'private.rl_counters', 'SELECT,INSERT,UPDATE,DELETE')
      and not has_table_privilege('anon', 'private.rl_counters', 'SELECT,INSERT,UPDATE,DELETE') $q$);
select pg_temp.expect_true('anon: NO table privilege at all on any M1 table',
  $q$ (select bool_and(not has_table_privilege('anon', 'public.' || t, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
                   and not has_any_column_privilege('anon', 'public.' || t, 'SELECT,INSERT,UPDATE,REFERENCES'))
       from pg_temp.t_new_tables) $q$);
select pg_temp.expect_true('authenticated: cannot INSERT/UPDATE/DELETE versions or keys (RPC only)',
  $q$ not has_table_privilege('authenticated', 'public.qb_question_versions', 'INSERT,UPDATE,DELETE,TRUNCATE')
      and not has_table_privilege('authenticated', 'public.qb_question_keys', 'INSERT,UPDATE,DELETE,TRUNCATE')
      and not has_any_column_privilege('authenticated', 'public.qb_question_keys', 'INSERT,UPDATE')
      and not has_table_privilege('authenticated', 'public.qb_questions', 'INSERT,TRUNCATE')
      and not has_table_privilege('authenticated', 'public.qb_question_types', 'INSERT,UPDATE,DELETE') $q$);
select pg_temp.expect_true('every function in schema private has a fixed search_path',
  $q$ not exists (select 1 from pg_proc p where p.pronamespace = 'private'::regnamespace
                  and not coalesce(array_to_string(p.proconfig, ',') like '%search_path=%', false)) $q$);
select pg_temp.expect_true('anon cannot EXECUTE any M1 function',
  $q$ not exists (select 1 from pg_proc p
                  where p.oid in ('private.is_course_staff(text)'::regprocedure, 'private.has_staff_perm(text,text)'::regprocedure,
                                  'private.is_any_course_staff()'::regprocedure, 'private.ensure_course_folders(text)'::regprocedure,
                                  'private.rl_hit(text,integer,integer,boolean)'::regprocedure, 'private.rl_prune(interval)'::regprocedure,
                                  'private.log_security_event(text,text,text,jsonb,uuid,timestamptz)'::regprocedure,
                                  'private.qb_save_question(jsonb)'::regprocedure, 'public.qb_save_question(jsonb)'::regprocedure,
                                  'private.qb_validate(text,jsonb,jsonb)'::regprocedure, 'private.staff_permission_keys()'::regprocedure)
                    and has_function_privilege('anon', p.oid, 'EXECUTE')) $q$);
select pg_temp.expect_true('authenticated cannot EXECUTE internal helpers (rl_hit, ensure_folders, log_event, validators)',
  $q$ not has_function_privilege('authenticated', 'private.rl_hit(text,integer,integer,boolean)', 'EXECUTE')
      and not has_function_privilege('authenticated', 'private.ensure_course_folders(text)', 'EXECUTE')
      and not has_function_privilege('authenticated', 'private.log_security_event(text,text,text,jsonb,uuid,timestamptz)', 'EXECUTE')
      and not has_function_privilege('authenticated', 'private.qb_validate(text,jsonb,jsonb)', 'EXECUTE')
      and not has_function_privilege('authenticated', 'private.rl_prune(interval)', 'EXECUTE') $q$);

-- existing objects untouched (backward compatibility)
select pg_temp.expect_true('legacy: quiz_questions policies unchanged (same 4 names/commands)',
  $q$ (select array_agg(policyname::text || ':' || cmd order by policyname) from pg_policies
       where schemaname = 'public' and tablename = 'quiz_questions')
      = array['quiz_questions_delete_admin:DELETE','quiz_questions_insert_admin:INSERT',
              'quiz_questions_select:SELECT','quiz_questions_update_admin:UPDATE'] $q$);
select pg_temp.expect_true('legacy: quiz_attempts policies unchanged (same 3)',
  $q$ (select array_agg(policyname::text order by policyname) from pg_policies
       where schemaname = 'public' and tablename = 'quiz_attempts')
      = array['quiz_attempts_delete_admin','quiz_attempts_insert_own','quiz_attempts_select'] $q$);
select pg_temp.expect_true('legacy: 37 policies on the 11 tables of 001 (none added/removed)',
  $q$ (select count(*) from pg_policies where schemaname = 'public' and tablename in
       ('profiles','trainer_notes','courses','course_items','quiz_questions','quiz_attempts','enrollments',
        'contact_messages','posts','site_settings','audit_log')) = 37 $q$);
select pg_temp.expect_true('legacy: quiz_questions.correct_index privilege for authenticated unchanged (still SELECT)',
  $q$ has_column_privilege('authenticated', 'public.quiz_questions', 'correct_index', 'SELECT') $q$);
select pg_temp.expect_true('legacy: profiles.role CHECK still trainee|admin (no instructor role value)',
  $q$ (select bool_and(pg_get_constraintdef(oid) like '%trainee%' and pg_get_constraintdef(oid) like '%admin%'
                       and pg_get_constraintdef(oid) not like '%instructor%')
       from pg_constraint where conrelid = 'public.profiles'::regclass and contype = 'c'
         and pg_get_constraintdef(oid) like '%role%') $q$);
select pg_temp.expect_true('legacy: triggers on courses = old updated_at trigger + new folder trigger only',
  $q$ (select array_agg(tgname::text order by tgname) from pg_trigger
       where tgrelid = 'public.courses'::regclass and not tgisinternal)
      = array['courses_create_folders','courses_set_updated_at'] $q$);

-- ------------------------------------------------------------------ fixtures (as postgres)
-- T  = trainee enrolled in capm           I1 = instructor capm {qbank.write}  (=> read)
-- I2 = instructor pmp {qbank.read, security.read}                             I3 = instructor capm {} (no perms)
-- I4 = instructor capm {qbank.write} but SUSPENDED profile                    AD = admin
insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, raw_app_meta_data) values
 ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'm1test-t@example.invalid',  '{"full_name":"Trainee T"}', '{}'),
 ('00000000-0000-4000-8000-0000000000e2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'm1test-i1@example.invalid', '{"full_name":"Instr I1","role":"admin"}', '{}'),
 ('00000000-0000-4000-8000-0000000000e3', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'm1test-i2@example.invalid', '{"full_name":"Instr I2"}', '{}'),
 ('00000000-0000-4000-8000-0000000000e4', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'm1test-i3@example.invalid', '{"full_name":"Instr I3"}', '{}'),
 ('00000000-0000-4000-8000-0000000000e5', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'm1test-ad@example.invalid', '{"full_name":"Admin AD"}', '{}'),
 ('00000000-0000-4000-8000-0000000000e6', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'm1test-i4@example.invalid', '{"full_name":"Instr I4"}', '{}');
update public.profiles set role = 'admin'       where id = '00000000-0000-4000-8000-0000000000e5';
update public.profiles set status = 'suspended' where id = '00000000-0000-4000-8000-0000000000e6';
insert into public.enrollments (user_id, course_id) values ('00000000-0000-4000-8000-0000000000e1', 'capm');
insert into public.course_staff (course_id, user_id, permissions) values
 ('capm', '00000000-0000-4000-8000-0000000000e2', '{"qbank.write":true}'),
 ('pmp',  '00000000-0000-4000-8000-0000000000e3', '{"qbank.read":true,"security.read":true}'),
 ('capm', '00000000-0000-4000-8000-0000000000e4', '{}'),
 ('capm', '00000000-0000-4000-8000-0000000000e6', '{"qbank.write":true}');

select pg_temp.expect_state('course_staff: unknown permission flag rejected',
  $q$ insert into public.course_staff (course_id, user_id, permissions) values ('pmp', '00000000-0000-4000-8000-0000000000e1', '{"qbank.everything":true}') $q$, '22023');
select pg_temp.expect_state('course_staff: non-boolean permission value rejected',
  $q$ insert into public.course_staff (course_id, user_id, permissions) values ('pmp', '00000000-0000-4000-8000-0000000000e1', '{"qbank.read":"yes"}') $q$, '22023');
select pg_temp.expect_state('course_staff: staff_role other than instructor rejected',
  $q$ insert into public.course_staff (course_id, user_id, staff_role) values ('pmp', '00000000-0000-4000-8000-0000000000e1', 'admin') $q$, '23514');

-- course B (pmp) content, created by the admin through the RPC (auth.uid() = admin)
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000e5","role":"authenticated"}', true);
with i as (insert into public.qb_taxonomy (course_id, level, code, name_ar) values ('pmp', 'domain', 'P1', 'People') returning id)
select pg_temp.keep('taxB', id) from i;
with i as (insert into public.qb_tags (course_id, label) values ('pmp', 'B tag') returning id)
select pg_temp.keep('tagB', id) from i;
with i as (insert into public.qb_sets (course_id, title) values ('pmp', 'B scenario') returning id)
select pg_temp.keep('setB', id) from i;
with i as (insert into public.qb_media (course_id, storage_path, mime_type) values ('pmp', 'pmp/q1.png', 'image/png') returning id)
select pg_temp.keep('mediaB', id) from i;
select pg_temp.keep('qB', (private.qb_save_question(jsonb_build_object(
  'course_id', 'pmp', 'type_code', 'mcq_single', 'taxonomy_id', pg_temp.idof('taxB'),
  'payload', '{"stem":{"text":"PMP secret question"},"options":[{"id":"a","text":"A"},{"id":"b","text":"B"}]}'::jsonb,
  'key', '{"correct":"b"}'::jsonb, 'explanation', 'PMP secret explanation')) ->> 'question_id')::uuid);
insert into public.ex_security_events (course_id, user_id, kind, severity) values
 ('pmp',  '00000000-0000-4000-8000-0000000000e1', 'blur', 'low'),
 ('capm', '00000000-0000-4000-8000-0000000000e1', 'fullscreen_exit', 'medium');
select set_config('request.jwt.claims', '', true);

-- ================================================================== ANON
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select pg_temp.expect_hidden('anon: course_staff hidden',          'select * from public.course_staff');
select pg_temp.expect_hidden('anon: course_folders hidden',        'select * from public.course_folders');
select pg_temp.expect_hidden('anon: ex_security_events hidden',    'select * from public.ex_security_events');
select pg_temp.expect_hidden('anon: qb_question_types hidden',     'select * from public.qb_question_types');
select pg_temp.expect_hidden('anon: qb_taxonomy hidden',           'select * from public.qb_taxonomy');
select pg_temp.expect_hidden('anon: qb_tags hidden',               'select * from public.qb_tags');
select pg_temp.expect_hidden('anon: qb_sets hidden',               'select * from public.qb_sets');
select pg_temp.expect_hidden('anon: qb_set_versions hidden',       'select * from public.qb_set_versions');
select pg_temp.expect_hidden('anon: qb_questions hidden',          'select * from public.qb_questions');
select pg_temp.expect_hidden('anon: qb_question_versions hidden',  'select * from public.qb_question_versions');
select pg_temp.expect_hidden('anon: qb_question_keys hidden',      'select * from public.qb_question_keys');
select pg_temp.expect_hidden('anon: qb_question_tags hidden',      'select * from public.qb_question_tags');
select pg_temp.expect_hidden('anon: qb_media hidden',              'select * from public.qb_media');
select pg_temp.expect_error ('anon: cannot call qb_save_question()',
  $q$ select public.qb_save_question('{"course_id":"pmp","type_code":"true_false","payload":{"stem":{"text":"x"}},"key":{"correct":"true"}}') $q$);
select pg_temp.expect_error ('anon: cannot call private.has_staff_perm()', $q$ select private.has_staff_perm('pmp', 'qbank.read') $q$);
select pg_temp.expect_error ('anon: cannot call private.rl_hit()',         $q$ select private.rl_hit('x', 60, 1) $q$);
select pg_temp.expect_error ('anon: cannot insert qb_taxonomy',
  $q$ insert into public.qb_taxonomy (course_id, level, name_ar) values ('capm', 'domain', 'x') $q$);
select pg_temp.expect_count ('anon: still reads the published courses (unchanged behavior)',
  'select * from public.courses where published', 6);

-- ================================================================== I1 (instructor capm, qbank.write)
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000e2","role":"authenticated","user_metadata":{"role":"admin"}}', true);
set local role authenticated;

select pg_temp.expect_true('I1: JWT metadata role=admin does NOT make him admin', 'not private.is_admin()');
select pg_temp.expect_true('I1: is_course_staff(capm) true, (pmp) false', $q$ private.is_course_staff('capm') and not private.is_course_staff('pmp') $q$);
select pg_temp.expect_true('I1: qbank.write implies qbank.read on capm', $q$ private.has_staff_perm('capm', 'qbank.read') $q$);
select pg_temp.expect_true('I1: no grading / security.read / exam.publish flags => false',
  $q$ not private.has_staff_perm('capm', 'grading') and not private.has_staff_perm('capm', 'security.read')
      and not private.has_staff_perm('capm', 'exam.publish') $q$);
select pg_temp.expect_true('I1: no permission at all on pmp', $q$ not private.has_staff_perm('pmp', 'qbank.read') $q$);
select pg_temp.expect_count('I1: sees only his own course_staff row', 'select * from public.course_staff', 1);
select pg_temp.expect_count('I1: sees the 5 capm folders only', 'select * from public.course_folders', 5);
select pg_temp.expect_count('I1: sees the type registry (13 + 2 test rows)', 'select * from public.qb_question_types', 15);

-- taxonomy
select pg_temp.expect_ok('I1: CAN create a domain in capm',
  $q$ with i as (insert into public.qb_taxonomy (course_id, level, code, name_ar) values ('capm', 'domain', 'D1', 'المجال 1') returning id)
      select pg_temp.keep('taxA', id) from i $q$);
select pg_temp.expect_ok('I1: CAN create a topic under it',
  $q$ with i as (insert into public.qb_taxonomy (course_id, parent_id, level, name_ar) values ('capm', pg_temp.idof('taxA'), 'topic', 'موضوع') returning id)
      select pg_temp.keep('taxA_topic', id) from i $q$);
select pg_temp.expect_ok('I1: CAN create a subtopic under the topic',
  $q$ insert into public.qb_taxonomy (course_id, parent_id, level, name_ar) values ('capm', pg_temp.idof('taxA_topic'), 'subtopic', 'فرعي') $q$);
select pg_temp.expect_state('taxonomy: topic without parent rejected',
  $q$ insert into public.qb_taxonomy (course_id, level, name_ar) values ('capm', 'topic', 'x') $q$, '23514');
select pg_temp.expect_state('taxonomy: subtopic directly under a domain rejected',
  $q$ insert into public.qb_taxonomy (course_id, parent_id, level, name_ar) values ('capm', pg_temp.idof('taxA'), 'subtopic', 'x') $q$, '22023');
select pg_temp.expect_state('taxonomy: level of a node cannot change',
  $q$ update public.qb_taxonomy set level = 'topic' where id = pg_temp.idof('taxA') $q$, '42501');
select pg_temp.expect_error('I1: cannot create taxonomy in pmp (RLS WITH CHECK)',
  $q$ insert into public.qb_taxonomy (course_id, level, name_ar) values ('pmp', 'domain', 'x') $q$);
select pg_temp.expect_error('composite FK: capm topic cannot have a pmp parent',
  $q$ insert into public.qb_taxonomy (course_id, parent_id, level, name_ar) values ('capm', pg_temp.idof('taxB'), 'topic', 'x') $q$);
select pg_temp.expect_ok('I1: CAN create a tag in capm',
  $q$ with i as (insert into public.qb_tags (course_id, label) values ('capm', 'Scope') returning id) select pg_temp.keep('tagA', id) from i $q$);
select pg_temp.expect_state('tags: duplicate label (case/space-insensitive) rejected',
  $q$ insert into public.qb_tags (course_id, label) values ('capm', ' scope') $q$, '23505');
select pg_temp.expect_ok('I1: CAN register capm media metadata',
  $q$ with i as (insert into public.qb_media (course_id, storage_path, mime_type) values ('capm', 'capm/q1.png', 'image/png') returning id) select pg_temp.keep('mediaA', id) from i $q$);
select pg_temp.expect_error('media: path outside "<course_id>/" rejected',
  $q$ insert into public.qb_media (course_id, storage_path, mime_type) values ('capm', 'pmp/x.png', 'image/png') $q$);

-- questions through the RPC
select pg_temp.expect_ok('I1: CAN save an MCQ in capm (version 1 + key)',
  $q$ select pg_temp.keep('qA', (public.qb_save_question(jsonb_build_object(
        'course_id', 'capm', 'type_code', 'mcq_single', 'taxonomy_id', pg_temp.idof('taxA_topic'), 'difficulty', 'hard',
        'payload', jsonb_build_object('stem', jsonb_build_object('text', 'ما أهم مخرجات تخطيط النطاق؟'),
                                      'options', '[{"id":"a","text":"خطة إدارة النطاق"},{"id":"b","text":"ميثاق المشروع"},{"id":"c","text":"سجل المخاطر"}]'::jsonb,
                                      'media', jsonb_build_array(pg_temp.idof('mediaA'))),
        'key', '{"correct":"a"}'::jsonb, 'explanation', 'secret explanation v1',
        'option_explanations', '{"b":"charter is an input"}'::jsonb, 'reference', 'PMBOK')) ->> 'question_id')::uuid) $q$);
select pg_temp.expect_true('qA: version 1, current_version set, key stored separately',
  $q$ (select q.current_version_id = v.id and v.version_no = 1 and v.course_id = 'capm' and v.difficulty = 'hard'
              and k.key ->> 'correct' = 'a' and k.explanation = 'secret explanation v1'
              and not (v.payload::text like '%secret%')
       from public.qb_questions q join public.qb_question_versions v on v.question_id = q.id
       join public.qb_question_keys k on k.version_id = v.id where q.id = pg_temp.idof('qA')) $q$);
select pg_temp.expect_ok('I1: editing qA creates version 2 (inherits taxonomy/difficulty)',
  $q$ select pg_temp.keep('qA_v2', (public.qb_save_question(jsonb_build_object('question_id', pg_temp.idof('qA'),
        'payload', '{"stem":{"text":"ما أهم مخرجات تخطيط النطاق؟ (معدّل)"},"options":[{"id":"a","text":"خطة إدارة النطاق"},{"id":"b","text":"ميثاق المشروع"}]}'::jsonb,
        'key', '{"correct":"b"}'::jsonb, 'explanation', 'secret explanation v2')) ->> 'version_id')::uuid) $q$);
select pg_temp.expect_true('versioning: v2 is current, v1 payload + key untouched',
  $q$ (select q.current_version_id = pg_temp.idof('qA_v2') from public.qb_questions q where q.id = pg_temp.idof('qA'))
      and (select count(*) = 2 from public.qb_question_versions where question_id = pg_temp.idof('qA'))
      and (select k.key ->> 'correct' = 'a' and k.explanation = 'secret explanation v1'
                  and jsonb_array_length(v.payload -> 'options') = 3
           from public.qb_question_versions v join public.qb_question_keys k on k.version_id = v.id
           where v.question_id = pg_temp.idof('qA') and v.version_no = 1)
      and (select v.version_no = 2 and v.taxonomy_id = pg_temp.idof('taxA_topic') and v.difficulty = 'hard'
                  and k.key ->> 'correct' = 'b' and k.reference = 'PMBOK'
           from public.qb_question_versions v join public.qb_question_keys k on k.version_id = v.id
           where v.id = pg_temp.idof('qA_v2')) $q$);
select pg_temp.expect_true('duplicates: same text (diacritics/option order differ) is reported',
  $q$ (public.qb_save_question('{"course_id":"capm","type_code":"mcq_single","payload":{"stem":{"text":"ما أهمّ مخرجات تخطيط النطاق؟ (معدّل)"},"options":[{"id":"x","text":"ميثاق المشروع"},{"id":"y","text":"خطة إدارة النطاق"}]},"key":{"correct":"x"}}') ->> 'duplicates')::int >= 1 $q$);
select pg_temp.expect_ok('I1: CAN save a valid multi_response',
  $q$ select public.qb_save_question('{"course_id":"capm","type_code":"multi_response","payload":{"stem":{"text":"اختر اثنين"},"options":[{"id":"a","text":"1"},{"id":"b","text":"2"},{"id":"c","text":"3"}],"min_select":2,"max_select":2},"key":{"correct":["a","c"],"scoring":"partial"}}') $q$);
select pg_temp.expect_ok('I1: CAN save a valid true_false',
  $q$ select pg_temp.keep('qA_tf', (public.qb_save_question('{"course_id":"capm","type_code":"true_false","payload":{"stem":{"text":"الميثاق يصدره الراعي"},"labels":{"true":"صح","false":"خطأ"}},"key":{"correct":"true"},"option_explanations":{"true":"نعم"}}') ->> 'question_id')::uuid) $q$);

-- validators (all 22023)
select pg_temp.expect_state('validator mcq: key.correct not an option id',
  $q$ select public.qb_save_question('{"course_id":"capm","type_code":"mcq_single","payload":{"stem":{"text":"q"},"options":[{"id":"a","text":"1"},{"id":"b","text":"2"}]},"key":{"correct":"z"}}') $q$, '22023');
select pg_temp.expect_state('validator mcq: duplicate option ids',
  $q$ select public.qb_save_question('{"course_id":"capm","type_code":"mcq_single","payload":{"stem":{"text":"q"},"options":[{"id":"a","text":"1"},{"id":"a","text":"2"}]},"key":{"correct":"a"}}') $q$, '22023');
select pg_temp.expect_state('validator mcq: only one option',
  $q$ select public.qb_save_question('{"course_id":"capm","type_code":"mcq_single","payload":{"stem":{"text":"q"},"options":[{"id":"a","text":"1"}]},"key":{"correct":"a"}}') $q$, '22023');
select pg_temp.expect_state('validator: answer data inside payload (option.is_correct) rejected',
  $q$ select public.qb_save_question('{"course_id":"capm","type_code":"mcq_single","payload":{"stem":{"text":"q"},"options":[{"id":"a","text":"1","is_correct":true},{"id":"b","text":"2"}]},"key":{"correct":"a"}}') $q$, '22023');
select pg_temp.expect_state('validator: payload.explanation rejected (belongs to the key table)',
  $q$ select public.qb_save_question('{"course_id":"capm","type_code":"mcq_single","payload":{"stem":{"text":"q"},"explanation":"x","options":[{"id":"a","text":"1"},{"id":"b","text":"2"}]},"key":{"correct":"a"}}') $q$, '22023');
select pg_temp.expect_state('validator: empty stem rejected',
  $q$ select public.qb_save_question('{"course_id":"capm","type_code":"true_false","payload":{"stem":{"text":"  "}},"key":{"correct":"true"}}') $q$, '22023');
select pg_temp.expect_state('validator mr: invalid scoring',
  $q$ select public.qb_save_question('{"course_id":"capm","type_code":"multi_response","payload":{"stem":{"text":"q"},"options":[{"id":"a","text":"1"},{"id":"b","text":"2"}]},"key":{"correct":["a"],"scoring":"bonus"}}') $q$, '22023');
select pg_temp.expect_state('validator mr: duplicate correct ids',
  $q$ select public.qb_save_question('{"course_id":"capm","type_code":"multi_response","payload":{"stem":{"text":"q"},"options":[{"id":"a","text":"1"},{"id":"b","text":"2"}]},"key":{"correct":["a","a"]}}') $q$, '22023');
select pg_temp.expect_state('validator mr: correct count outside min/max_select',
  $q$ select public.qb_save_question('{"course_id":"capm","type_code":"multi_response","payload":{"stem":{"text":"q"},"options":[{"id":"a","text":"1"},{"id":"b","text":"2"},{"id":"c","text":"3"}],"max_select":1},"key":{"correct":["a","b"]}}') $q$, '22023');
select pg_temp.expect_state('validator tf: correct must be "true"/"false"',
  $q$ select public.qb_save_question('{"course_id":"capm","type_code":"true_false","payload":{"stem":{"text":"q"}},"key":{"correct":"yes"}}') $q$, '22023');
select pg_temp.expect_state('registry: disabled type (essay) cannot be saved yet',
  $q$ select public.qb_save_question('{"course_id":"capm","type_code":"essay","payload":{"stem":{"text":"q"}},"key":{}}') $q$, '22023');
select pg_temp.expect_state('registry: unknown type rejected',
  $q$ select public.qb_save_question('{"course_id":"capm","type_code":"nope","payload":{"stem":{"text":"q"}},"key":{}}') $q$, '22023');
select pg_temp.expect_state('rpc: unknown request field rejected',
  $q$ select public.qb_save_question('{"course_id":"capm","type_code":"true_false","payload":{"stem":{"text":"q"}},"key":{"correct":"true"},"score":5}') $q$, '22023');
select pg_temp.expect_state('rpc: option_explanations for an unknown option rejected',
  $q$ select public.qb_save_question('{"course_id":"capm","type_code":"true_false","payload":{"stem":{"text":"q"}},"key":{"correct":"true"},"option_explanations":{"maybe":"x"}}') $q$, '22023');
select pg_temp.expect_state('rpc: course_id in an edit must match the stored question',
  $q$ select public.qb_save_question(jsonb_build_object('question_id', pg_temp.idof('qA'), 'course_id', 'pmp',
        'payload', '{"stem":{"text":"q"},"options":[{"id":"a","text":"1"},{"id":"b","text":"2"}]}'::jsonb, 'key', '{"correct":"a"}'::jsonb)) $q$, '22023');

-- course isolation through composite FKs (the RPC is DEFINER, so only the FKs stand in the way here)
select pg_temp.expect_state('composite FK: capm question cannot use a pmp taxonomy node',
  $q$ select public.qb_save_question(jsonb_build_object('course_id', 'capm', 'type_code', 'true_false', 'taxonomy_id', pg_temp.idof('taxB'),
        'payload', '{"stem":{"text":"q"}}'::jsonb, 'key', '{"correct":"true"}'::jsonb)) $q$, '23503');
select pg_temp.expect_state('composite FK: capm question cannot join a pmp scenario set',
  $q$ select public.qb_save_question(jsonb_build_object('course_id', 'capm', 'type_code', 'true_false', 'set_id', pg_temp.idof('setB'),
        'payload', '{"stem":{"text":"q"}}'::jsonb, 'key', '{"correct":"true"}'::jsonb)) $q$, '23503');
select pg_temp.expect_state('course isolation: capm question cannot reference pmp media',
  $q$ select public.qb_save_question(jsonb_build_object('course_id', 'capm', 'type_code', 'true_false',
        'payload', jsonb_build_object('stem', '{"text":"q"}'::jsonb, 'media', jsonb_build_array(pg_temp.idof('mediaB'))),
        'key', '{"correct":"true"}'::jsonb)) $q$, '23503');
select pg_temp.expect_error('composite FK: tagging a capm question with a pmp tag (course_id=capm) rejected',
  $q$ insert into public.qb_question_tags (course_id, question_id, tag_id) values ('capm', pg_temp.idof('qA'), pg_temp.idof('tagB')) $q$);
select pg_temp.expect_error('composite FK/RLS: same link declared as course_id=pmp rejected',
  $q$ insert into public.qb_question_tags (course_id, question_id, tag_id) values ('pmp', pg_temp.idof('qA'), pg_temp.idof('tagB')) $q$);
select pg_temp.expect_affected('I1: CAN tag his capm question with a capm tag',
  $q$ insert into public.qb_question_tags (course_id, question_id, tag_id) values ('capm', pg_temp.idof('qA'), pg_temp.idof('tagA')) $q$, 1);

-- scenario sets + child linkage
select pg_temp.expect_ok('I1: CAN create a capm scenario set',
  $q$ with i as (insert into public.qb_sets (course_id, title) values ('capm', 'سيناريو') returning id) select pg_temp.keep('setA', id) from i $q$);
select pg_temp.expect_affected('I1: CAN add set version 1 (stem)',
  $q$ insert into public.qb_set_versions (set_id, stem) values (pg_temp.idof('setA'), '{"text":"نص السيناريو"}') $q$, 1);
select pg_temp.expect_affected('I1: CAN add set version 2',
  $q$ insert into public.qb_set_versions (set_id, stem) values (pg_temp.idof('setA'), '{"text":"نص السيناريو 2"}') $q$, 1);
select pg_temp.expect_true('sets: versions numbered 1,2 and current_version moved to v2',
  $q$ (select s.current_version_id = v.id and v.version_no = 2 and v.course_id = 'capm'
       from public.qb_sets s join public.qb_set_versions v on v.set_id = s.id
       where s.id = pg_temp.idof('setA') and v.version_no = 2) $q$);
select pg_temp.expect_error('I1: cannot add a version to the pmp set (course taken from set, RLS rejects)',
  $q$ insert into public.qb_set_versions (set_id, stem) values (pg_temp.idof('setB'), '{"text":"x"}') $q$);
select pg_temp.expect_ok('I1: CAN save a child question linked to his set',
  $q$ select pg_temp.keep('qA_child', (public.qb_save_question(jsonb_build_object('course_id', 'capm', 'type_code', 'true_false',
        'set_id', pg_temp.idof('setA'), 'payload', '{"stem":{"text":"سؤال تابع"}}'::jsonb, 'key', '{"correct":"false"}'::jsonb)) ->> 'question_id')::uuid) $q$);
select pg_temp.expect_true('sets: child question carries set_id',
  $q$ (select set_id = pg_temp.idof('setA') from public.qb_questions where id = pg_temp.idof('qA_child')) $q$);

-- immutability / write limits for staff
select pg_temp.expect_error('I1: cannot UPDATE a version', $q$ update public.qb_question_versions set difficulty = 'easy' where question_id = pg_temp.idof('qA') $q$);
select pg_temp.expect_error('I1: cannot UPDATE a key',     $q$ update public.qb_question_keys set explanation = 'x' $q$);
select pg_temp.expect_error('I1: cannot DELETE a key',     $q$ delete from public.qb_question_keys $q$);
select pg_temp.expect_error('I1: cannot UPDATE a set version', $q$ update public.qb_set_versions set stem = '{"text":"x"}' $q$);
select pg_temp.expect_error('I1: cannot move current_version_id by REST',
  $q$ update public.qb_questions set current_version_id = null where id = pg_temp.idof('qA') $q$);
select pg_temp.expect_affected('I1: CAN change status of his capm question', $q$ update public.qb_questions set status = 'active' where id = pg_temp.idof('qA') $q$, 1);
select pg_temp.expect_affected('I1: cannot delete questions (admin only, 0 rows)', $q$ delete from public.qb_questions where id = pg_temp.idof('qA') $q$, 0);

-- course B is invisible / unwritable
select pg_temp.expect_hidden('I1: pmp taxonomy hidden',  $q$ select * from public.qb_taxonomy where course_id = 'pmp' $q$);
select pg_temp.expect_hidden('I1: pmp questions hidden', $q$ select * from public.qb_questions where course_id = 'pmp' $q$);
select pg_temp.expect_hidden('I1: pmp versions hidden',  $q$ select * from public.qb_question_versions where course_id = 'pmp' $q$);
select pg_temp.expect_hidden('I1: pmp keys hidden',      $q$ select * from public.qb_question_keys where course_id = 'pmp' $q$);
select pg_temp.expect_hidden('I1: pmp tags/sets/media hidden',
  $q$ select id from public.qb_tags where course_id = 'pmp' union all select id from public.qb_sets where course_id = 'pmp'
      union all select id from public.qb_media where course_id = 'pmp' $q$);
select pg_temp.expect_hidden('I1: pmp folders hidden',   $q$ select * from public.course_folders where course_id = 'pmp' $q$);
select pg_temp.expect_affected('I1: cannot update pmp question status (0 rows)', $q$ update public.qb_questions set status = 'retired' where course_id = 'pmp' $q$, 0);
select pg_temp.expect_affected('I1: cannot rename pmp taxonomy (0 rows)', $q$ update public.qb_taxonomy set name_ar = 'x' where course_id = 'pmp' $q$, 0);
select pg_temp.expect_affected('I1: cannot delete pmp tags (0 rows)', $q$ delete from public.qb_tags where course_id = 'pmp' $q$, 0);
select pg_temp.expect_state('I1: cannot add a version to the pmp question (forbidden)',
  $q$ select public.qb_save_question(jsonb_build_object('question_id', pg_temp.idof('qB'),
        'payload', '{"stem":{"text":"hijack"},"options":[{"id":"a","text":"1"},{"id":"b","text":"2"}]}'::jsonb, 'key', '{"correct":"a"}'::jsonb)) $q$, '42501');
select pg_temp.expect_state('I1: cannot create a question in pmp (forbidden)',
  $q$ select public.qb_save_question('{"course_id":"pmp","type_code":"true_false","payload":{"stem":{"text":"x"}},"key":{"correct":"true"}}') $q$, '42501');
select pg_temp.expect_state('I1: unknown question id gives the same forbidden (no existence oracle)',
  $q$ select public.qb_save_question('{"question_id":"00000000-0000-4000-8000-00000000dead","payload":{"stem":{"text":"x"}},"key":{"correct":"true"}}') $q$, '42501');

-- staff cannot escalate
select pg_temp.expect_error('I1: cannot grant himself staff on pmp',
  $q$ insert into public.course_staff (course_id, user_id, permissions) values ('pmp', '00000000-0000-4000-8000-0000000000e2', '{"qbank.write":true}') $q$);
select pg_temp.expect_affected('I1: cannot raise his own permissions (0 rows)',
  $q$ update public.course_staff set permissions = '{"qbank.write":true,"exam.publish":true,"security.read":true}' $q$, 0);
select pg_temp.expect_affected('I1: cannot rename folders (0 rows)', $q$ update public.course_folders set title_ar = 'x' $q$, 0);
select pg_temp.expect_hidden('I1: capm security events hidden (no security.read)', 'select * from public.ex_security_events');
select pg_temp.expect_error('I1: cannot call private.rl_hit()',              $q$ select private.rl_hit('x', 60, 1) $q$);
select pg_temp.expect_error('I1: cannot call private.ensure_course_folders()', $q$ select private.ensure_course_folders() $q$);
select pg_temp.expect_error('I1: cannot call private.log_security_event()',  $q$ select private.log_security_event('capm', 'blur') $q$);
select pg_temp.expect_error('I1: cannot write ex_security_events directly',
  $q$ insert into public.ex_security_events (course_id, kind) values ('capm', 'blur') $q$);
select pg_temp.expect_hidden('I1: still no access to legacy admin-only tables (trainer_notes, contact_messages)',
  $q$ select user_id::text from public.trainer_notes union all select id::text from public.contact_messages $q$);

-- ================================================================== TRAINEE T (enrolled in capm)
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000e1","role":"authenticated"}', true);
set local role authenticated;
select pg_temp.expect_true('T: has_course_access(capm) true (sanity)', $q$ private.has_course_access('capm') $q$);
select pg_temp.expect_true('T: no staff permission anywhere', $q$ not private.has_staff_perm('capm', 'qbank.read') and not private.is_course_staff('capm') $q$);
select pg_temp.expect_hidden('T: qb_question_keys hidden (answer key)', 'select * from public.qb_question_keys');
select pg_temp.expect_hidden('T: qb_question_versions hidden', 'select * from public.qb_question_versions');
select pg_temp.expect_hidden('T: qb_questions hidden',         'select * from public.qb_questions');
select pg_temp.expect_hidden('T: qb_taxonomy hidden',          'select * from public.qb_taxonomy');
select pg_temp.expect_hidden('T: qb_tags hidden',              'select * from public.qb_tags');
select pg_temp.expect_hidden('T: qb_question_tags hidden',     'select * from public.qb_question_tags');
select pg_temp.expect_hidden('T: qb_sets hidden',              'select * from public.qb_sets');
select pg_temp.expect_hidden('T: qb_set_versions hidden',      'select * from public.qb_set_versions');
select pg_temp.expect_hidden('T: qb_media hidden',             'select * from public.qb_media');
select pg_temp.expect_hidden('T: qb_question_types hidden',    'select * from public.qb_question_types');
select pg_temp.expect_hidden('T: course_folders hidden',       'select * from public.course_folders');
select pg_temp.expect_hidden('T: course_staff hidden',         'select * from public.course_staff');
select pg_temp.expect_hidden('T: own security events hidden',  'select * from public.ex_security_events');
select pg_temp.expect_state ('T: qb_save_question forbidden',
  $q$ select public.qb_save_question('{"course_id":"capm","type_code":"true_false","payload":{"stem":{"text":"x"}},"key":{"correct":"true"}}') $q$, '42501');
select pg_temp.expect_error ('T: cannot insert taxonomy', $q$ insert into public.qb_taxonomy (course_id, level, name_ar) values ('capm', 'domain', 'x') $q$);
select pg_temp.expect_affected('T: cannot update questions (0 rows)', $q$ update public.qb_questions set status = 'retired' $q$, 0);
select pg_temp.expect_error ('T: cannot self-assign as staff',
  $q$ insert into public.course_staff (course_id, user_id, permissions) values ('capm', '00000000-0000-4000-8000-0000000000e1', '{"qbank.read":true}') $q$);

-- ================================================================== I2 (pmp: qbank.read + security.read)
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000e3","role":"authenticated"}', true);
set local role authenticated;
select pg_temp.expect_count('I2: reads the pmp question',  'select * from public.qb_questions', 1);
select pg_temp.expect_count('I2: reads its key (staff with qbank.read)', $q$ select * from public.qb_question_keys where course_id = 'pmp' $q$, 1);
select pg_temp.expect_hidden('I2: capm keys hidden',       $q$ select * from public.qb_question_keys where course_id = 'capm' $q$);
select pg_temp.expect_hidden('I2: capm questions hidden',  $q$ select * from public.qb_questions where course_id = 'capm' $q$);
select pg_temp.expect_state('I2: read-only => cannot save in pmp',
  $q$ select public.qb_save_question('{"course_id":"pmp","type_code":"true_false","payload":{"stem":{"text":"x"}},"key":{"correct":"true"}}') $q$, '42501');
select pg_temp.expect_error('I2: read-only => cannot insert pmp taxonomy',
  $q$ insert into public.qb_taxonomy (course_id, level, name_ar) values ('pmp', 'domain', 'x') $q$);
select pg_temp.expect_affected('I2: read-only => cannot change pmp question status (0 rows)', $q$ update public.qb_questions set status = 'active' $q$, 0);
select pg_temp.expect_count('I2: security.read => sees the pmp security event only', 'select * from public.ex_security_events', 1);

-- ================================================================== I3 (capm staff, no flags)
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000e4","role":"authenticated"}', true);
set local role authenticated;
select pg_temp.expect_true('I3: is staff of capm but has no qbank permission', $q$ private.is_course_staff('capm') and not private.has_staff_perm('capm', 'qbank.read') $q$);
select pg_temp.expect_count('I3: sees capm folders (staff)', 'select * from public.course_folders', 5);
select pg_temp.expect_hidden('I3: no flags => capm questions hidden', 'select * from public.qb_questions');
select pg_temp.expect_hidden('I3: no flags => capm keys hidden',      'select * from public.qb_question_keys');
select pg_temp.expect_state('I3: no flags => save forbidden',
  $q$ select public.qb_save_question('{"course_id":"capm","type_code":"true_false","payload":{"stem":{"text":"x"}},"key":{"correct":"true"}}') $q$, '42501');

-- ================================================================== I4 (capm qbank.write, SUSPENDED profile)
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000e6","role":"authenticated"}', true);
set local role authenticated;
select pg_temp.expect_true('I4 (suspended): flags ignored', $q$ not private.has_staff_perm('capm', 'qbank.write') and not private.is_course_staff('capm') $q$);
select pg_temp.expect_hidden('I4 (suspended): capm questions hidden', 'select * from public.qb_questions');
select pg_temp.expect_state('I4 (suspended): save forbidden',
  $q$ select public.qb_save_question('{"course_id":"capm","type_code":"true_false","payload":{"stem":{"text":"x"}},"key":{"correct":"true"}}') $q$, '42501');

-- ================================================================== ADMIN
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000e5","role":"authenticated"}', true);
set local role authenticated;
select pg_temp.expect_true('admin: has_staff_perm true for any course/flag without a staff row',
  $q$ private.has_staff_perm('capm', 'qbank.write') and private.has_staff_perm('pmp', 'grading') and not private.is_course_staff('pmp') $q$);
select pg_temp.expect_true('admin: reads questions + keys of both courses',
  $q$ (select count(distinct course_id) = 2 from public.qb_questions) and (select count(distinct course_id) = 2 from public.qb_question_keys) $q$);
select pg_temp.expect_count('admin: reads all course_staff rows (4 fixtures)',
  $q$ select * from public.course_staff where user_id::text like '00000000-0000-4000-8000-0000000000e%' $q$, 4);
select pg_temp.expect_true('admin: reads all security events', '(select count(*) >= 2 from public.ex_security_events)');
select pg_temp.expect_ok('admin: CAN add a version to the pmp question',
  $q$ select public.qb_save_question(jsonb_build_object('question_id', pg_temp.idof('qB'),
        'payload', '{"stem":{"text":"PMP secret question v2"},"options":[{"id":"a","text":"A"},{"id":"b","text":"B"}]}'::jsonb, 'key', '{"correct":"a"}'::jsonb)) $q$);
select pg_temp.expect_affected('admin: CAN assign a trainee as pmp instructor (read-only)',
  $q$ insert into public.course_staff (course_id, user_id, permissions) values ('pmp', '00000000-0000-4000-8000-0000000000e1', '{"qbank.read":true}') $q$, 1);
select pg_temp.expect_true('admin: granted_by stamped with admin id',
  $q$ (select granted_by = '00000000-0000-4000-8000-0000000000e5' from public.course_staff where course_id = 'pmp' and user_id = '00000000-0000-4000-8000-0000000000e1') $q$);
select pg_temp.expect_state('admin: staff row key (course_id) cannot be changed',
  $q$ update public.course_staff set course_id = 'capm' where course_id = 'pmp' and user_id = '00000000-0000-4000-8000-0000000000e1' $q$, '42501');
select pg_temp.expect_affected('admin: CAN deactivate I1', $q$ update public.course_staff set active = false where user_id = '00000000-0000-4000-8000-0000000000e2' $q$, 1);
select pg_temp.expect_affected('admin: CAN rename a folder', $q$ update public.course_folders set title_ar = 'بنك أسئلة CAPM' where course_id = 'capm' and kind = 'question_bank' $q$, 1);
select pg_temp.expect_ok('admin: creating a course (REST) auto-creates its 5 folders',
  $q$ insert into public.courses (id, title_ar, title_en) values ('m1test-new', 'دورة اختبار', 'Test course') $q$);
select pg_temp.expect_true('folders trigger: new course has exactly the 5 kinds',
  $q$ (select array_agg(kind order by sort) from public.course_folders where course_id = 'm1test-new')
      = array['question_bank','domain_tests','exam_simulations','mistakes_quiz','results_analytics'] $q$);
select pg_temp.expect_affected('backward compat: admin can still delete an empty course (folders cascade)',
  $q$ delete from public.courses where id = 'm1test-new' $q$, 1);
select pg_temp.expect_hidden('backward compat: its folders are gone', $q$ select * from public.course_folders where course_id = 'm1test-new' $q$);
select pg_temp.expect_error('admin: a course WITH bank content cannot be deleted (restrict, like 001)',
  $q$ delete from public.courses where id = 'pmp' $q$);
select pg_temp.expect_affected('admin: CAN delete a question (versions + keys cascade)',
  $q$ delete from public.qb_questions where id = pg_temp.idof('qA') $q$, 1);
select pg_temp.expect_true('admin: qA versions and keys removed with it',
  $q$ not exists (select 1 from public.qb_question_versions where question_id = pg_temp.idof('qA'))
      and not exists (select 1 from public.qb_question_keys where version_id = pg_temp.idof('qA_v2')) $q$);
select pg_temp.expect_error('admin: cannot UPDATE a key either (no privilege, immutable)',
  $q$ update public.qb_question_keys set explanation = 'x' $q$);

-- I1 after deactivation
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000e2","role":"authenticated"}', true);
set local role authenticated;
select pg_temp.expect_hidden('I1 (deactivated): capm questions hidden', 'select * from public.qb_questions');
select pg_temp.expect_hidden('I1 (deactivated): folders hidden',        'select * from public.course_folders');
select pg_temp.expect_state ('I1 (deactivated): save forbidden',
  $q$ select public.qb_save_question('{"course_id":"capm","type_code":"true_false","payload":{"stem":{"text":"x"}},"key":{"correct":"true"}}') $q$, '42501');

-- ================================================================== PRIVILEGED (postgres): immutability, rate limit, audit
reset role;
select set_config('request.jwt.claims', '', true);
select pg_temp.expect_state('immutable: even postgres cannot UPDATE a version',
  $q$ update public.qb_question_versions set difficulty = 'easy' where question_id = pg_temp.idof('qB') $q$, '42501');
select pg_temp.expect_state('immutable: a version cannot be deleted directly',
  $q$ delete from public.qb_question_versions where question_id = pg_temp.idof('qB') $q$, '42501');
select pg_temp.expect_state('immutable: a key cannot be deleted directly',
  $q$ delete from public.qb_question_keys where course_id = 'pmp' $q$, '42501');
select pg_temp.expect_state('immutable: a set version cannot be updated',
  $q$ update public.qb_set_versions set stem = '{"text":"x"}' where set_id = pg_temp.idof('setA') $q$, '42501');

-- the same guards WITHOUT the column-privilege shield: postgres has full UPDATE privilege, so only the
-- triggers / FKs can stop these (the authenticated-role variants above may be stopped by grants first)
select pg_temp.expect_raise('trigger (postgres): taxonomy level change rejected by qb_taxonomy_before',
  $q$ update public.qb_taxonomy set level = 'topic' where id = pg_temp.idof('taxA') $q$,
  '42501', 'course_id and level of a taxonomy node cannot change%');
select pg_temp.expect_raise('trigger (postgres): taxonomy course_id change rejected by qb_taxonomy_before',
  $q$ update public.qb_taxonomy set course_id = 'pmp' where id = pg_temp.idof('taxA') $q$,
  '42501', 'course_id and level of a taxonomy node cannot change%');
select pg_temp.expect_raise('trigger (postgres): course_staff course_id change rejected by course_staff_before',
  $q$ update public.course_staff set course_id = 'capm'
      where course_id = 'pmp' and user_id = '00000000-0000-4000-8000-0000000000e1' $q$,
  '42501', 'course_id and user_id of a staff row cannot change%');
select pg_temp.expect_raise('trigger (postgres): course_staff user_id change rejected by course_staff_before',
  $q$ update public.course_staff set user_id = '00000000-0000-4000-8000-0000000000e4'
      where course_id = 'pmp' and user_id = '00000000-0000-4000-8000-0000000000e1' $q$,
  '42501', 'course_id and user_id of a staff row cannot change%');
-- a course whose ONLY dependants are bank rows (no ex_security_events, no 001 content): qb_* FKs restrict.
-- ON DELETE RESTRICT reports 23503 up to PG17 and 23001 (restrict_violation) from PG18 on: accept both.
insert into public.courses (id, title_ar, title_en) values ('m1test-tax', 'x', 'x'), ('m1test-q', 'x', 'x');
insert into public.qb_taxonomy (course_id, level, name_ar) values ('m1test-tax', 'domain', 'x');
insert into public.qb_questions (course_id) values ('m1test-q');
select pg_temp.expect_true('fixture: the two bank-only courses have no security events and no 001 content',
  $q$ not exists (select 1 from public.ex_security_events where course_id in ('m1test-tax', 'm1test-q'))
      and not exists (select 1 from public.course_items where course_id in ('m1test-tax', 'm1test-q'))
      and not exists (select 1 from public.enrollments where course_id in ('m1test-tax', 'm1test-q')) $q$);
select pg_temp.expect_raise('FK restrict (postgres): course with only taxonomy cannot be deleted (qb_taxonomy FK)',
  $q$ delete from public.courses where id = 'm1test-tax' $q$, '23503|23001', '%on table "qb_taxonomy"%');
select pg_temp.expect_raise('FK restrict (postgres): course with only a question cannot be deleted (qb_questions FK)',
  $q$ delete from public.courses where id = 'm1test-q' $q$, '23503|23001', '%on table "qb_questions"%');

select pg_temp.expect_true('rate limit: call 1 within max=3 allowed (returns 1)', $q$ private.rl_hit('m1test:k', 60, 3) = 1 $q$);
select pg_temp.expect_true('rate limit: call 2 allowed (returns 2)',              $q$ private.rl_hit('m1test:k', 60, 3) = 2 $q$);
select pg_temp.expect_true('rate limit: call 3 allowed (returns 3)',              $q$ private.rl_hit('m1test:k', 60, 3) = 3 $q$);
select pg_temp.expect_state('rate limit: call 4 raises rate_limited (P0001)', $q$ select private.rl_hit('m1test:k', 60, 3) $q$, 'P0001');
select pg_temp.expect_true('rate limit: counter stayed at max after the rejected call',
  $q$ (select n = 3 from private.rl_counters where key = 'm1test:k') $q$);
select pg_temp.expect_true('rate limit: non-raising mode, first call allowed', $q$ private.rl_hit('m1test:soft', 60, 1, false) = 1 $q$);
select pg_temp.expect_true('rate limit: non-raising mode returns -1 when over the limit', $q$ private.rl_hit('m1test:soft', 60, 1, false) = -1 $q$);
select pg_temp.expect_true('rate limit: keys are independent', $q$ private.rl_hit('m1test:other', 60, 3) = 1 $q$);
insert into private.rl_counters (key, window_start, n) values ('m1test:old', now() - interval '2 hours', 99);
select pg_temp.expect_true('rate limit: an old window does not count', $q$ private.rl_hit('m1test:old', 60, 3) = 1 $q$);
select pg_temp.expect_true('rate limit: rl_prune removes old windows', $q$ private.rl_prune(interval '1 hour') >= 1 $q$);
select pg_temp.expect_state('rate limit: invalid arguments rejected', $q$ select private.rl_hit('', 0, 0) $q$, '22023');
-- put the admin's qb_save counter at the limit for the current window, then save as admin
insert into private.rl_counters (key, window_start, n)
values ('qb_save:00000000-0000-4000-8000-0000000000e5', to_timestamp(floor(extract(epoch from now()) / 60) * 60), 120)
on conflict (key, window_start) do update set n = 120;

reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000e5","role":"authenticated"}', true);
set local role authenticated;
select pg_temp.expect_state('rate limit: qb_save_question rejects the 121st save in a minute (P0001)',
  $q$ select public.qb_save_question('{"course_id":"pmp","type_code":"true_false","payload":{"stem":{"text":"x"}},"key":{"correct":"true"}}') $q$, 'P0001');

reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000e1","role":"authenticated"}', true);
select pg_temp.expect_ok('log_security_event (called as from a DEFINER RPC) inserts an event',
  $q$ select private.log_security_event('capm', 'multi_session', 'high', '{"n":2}') $q$);
select pg_temp.expect_true('log_security_event stamps user_id = auth.uid()',
  $q$ exists (select 1 from public.ex_security_events where kind = 'multi_session' and severity = 'high'
              and user_id = '00000000-0000-4000-8000-0000000000e1' and details ->> 'n' = '2') $q$);
select set_config('request.jwt.claims', '', true);

select pg_temp.expect_true('audit: course_staff grant/deactivate logged',
  $q$ (select count(*) filter (where action = 'course_staff.granted') >= 5
          and count(*) filter (where action = 'course_staff.deactivated') = 1
       from public.audit_log where entity = 'course_staff') $q$);
select pg_temp.expect_true('audit: question created / status_changed / deleted logged',
  $q$ (select count(*) filter (where action = 'qb_question.created') >= 6
          and count(*) filter (where action = 'qb_question.status_changed') >= 1
          and count(*) filter (where action = 'qb_question.deleted') = 1
       from public.audit_log where entity = 'qb_questions') $q$);

-- ------------------------------------------------------------------ report, then undo everything
reset role;
select n, case when pass then 'PASS' else 'FAIL' end as result, test, detail from pg_temp.t_results
union all
select 100000, case when bool_and(pass) then 'ALL PASS' else 'FAILURES: ' || count(*) filter (where not pass) end,
       'SUMMARY (' || count(*) || ' tests)', null from pg_temp.t_results
order by 1;

rollback;
