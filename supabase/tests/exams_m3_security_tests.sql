-- exams_m3_security_tests.sql
-- Security / behavior tests for exams milestone M3a (migration 011_exam_builder). Requires 001..011.
-- Same harness as exams_m1_security_tests.sql: ONE transaction ending in ROLLBACK (every fixture disappears).
-- Run as one script in the SQL editor (role postgres) of STAGING. Output: one row per test + a summary row.
-- Expected: every row PASS. Re-run rls_security_tests.sql and exams_m1_security_tests.sql too (regression).

begin;

-- ------------------------------------------------------------------ harness (same helpers as M1)
create temp table t_results (n serial primary key, test text, pass boolean, detail text);
create temp table t_ids (name text primary key, id uuid not null);
create temp table t_json (name text primary key, j jsonb);
grant select on t_json to public;
grant select on t_ids to public;

create function pg_temp.rec(p_test text, p_pass boolean, p_detail text) returns void
language sql security definer as
$$ insert into pg_temp.t_results (test, pass, detail) values (p_test, p_pass, p_detail) $$;
create function pg_temp.keep(p_name text, p_id uuid) returns uuid
language sql security definer as
$$ insert into pg_temp.t_ids (name, id) values (p_name, p_id)
   on conflict (name) do update set id = excluded.id returning id $$;
create function pg_temp.idof(p_name text) returns uuid
language sql stable security definer as
$$ select id from pg_temp.t_ids where name = p_name $$;
create function pg_temp.keepj(p_name text, p_j jsonb) returns jsonb
language sql security definer as
$$ insert into pg_temp.t_json (name, j) values (p_name, p_j)
   on conflict (name) do update set j = excluded.j returning j $$;
create function pg_temp.jof(p_name text) returns jsonb
language sql stable security definer as
$$ select j from pg_temp.t_json where name = p_name $$;

-- evaluates the direct-publish helper for the CURRENT jwt user (helper itself is not granted to the API)
create function pg_temp.direct(p_course text) returns boolean
language sql security definer as
$$ select private.ex_can_publish_direct(p_course) $$;

create function pg_temp.expect_count(p_test text, p_sql text, p_expected bigint) returns void
language plpgsql as $$
declare n bigint;
begin
  execute 'select count(*) from (' || p_sql || ') s' into n;
  perform pg_temp.rec(p_test, n = p_expected, format('rows=%s expected=%s', n, p_expected));
exception when others then
  perform pg_temp.rec(p_test, false, 'ERROR ' || sqlstate || ': ' || sqlerrm);
end $$;
create function pg_temp.expect_hidden(p_test text, p_sql text) returns void
language plpgsql as $$
declare n bigint;
begin
  execute 'select count(*) from (' || p_sql || ') s' into n;
  perform pg_temp.rec(p_test, n = 0, format('rows=%s (RLS filtered)', n));
exception when others then
  perform pg_temp.rec(p_test, true, 'denied: ' || sqlstate || ' ' || left(sqlerrm, 120));
end $$;
create function pg_temp.expect_error(p_test text, p_sql text) returns void
language plpgsql as $$
begin
  execute p_sql;
  perform pg_temp.rec(p_test, false, 'NO ERROR - statement succeeded');
exception when others then
  perform pg_temp.rec(p_test, true, 'blocked: ' || sqlstate || ' ' || left(sqlerrm, 120));
end $$;
create function pg_temp.expect_state(p_test text, p_sql text, p_state text) returns void
language plpgsql as $$
begin
  execute p_sql;
  perform pg_temp.rec(p_test, false, 'NO ERROR - statement succeeded');
exception when others then
  perform pg_temp.rec(p_test, sqlstate = any (string_to_array(p_state, '|')),
                      format('sqlstate=%s expected=%s: %s', sqlstate, p_state, left(sqlerrm, 140)));
end $$;
create function pg_temp.expect_raise(p_test text, p_sql text, p_state text, p_msg_like text) returns void
language plpgsql as $$
begin
  execute p_sql;
  perform pg_temp.rec(p_test, false, 'NO ERROR - statement succeeded');
exception when others then
  perform pg_temp.rec(p_test, sqlstate = any (string_to_array(p_state, '|')) and sqlerrm like p_msg_like,
                      format('sqlstate=%s expected=%s msg~%s: %s', sqlstate, p_state, p_msg_like, left(sqlerrm, 160)));
end $$;
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

create temp table t_m3_tables (t text primary key);
insert into t_m3_tables values ('ex_course_settings'), ('ex_exams'), ('ex_exam_items'), ('ex_exam_rules'),
  ('ex_exam_versions'), ('ex_exam_version_items'), ('ex_exam_version_rules'), ('ex_exam_version_pool');
grant select on t_m3_tables to public;

-- ================================================================== STRUCTURE (as postgres)
select pg_temp.expect_true('RLS enabled AND forced on every M3 table',
  $q$ (select bool_and(c.relrowsecurity and c.relforcerowsecurity) and count(*) = 8
       from pg_class c join pg_temp.t_m3_tables t on c.oid = ('public.' || t.t)::regclass) $q$);
select pg_temp.expect_true('anon: NO table/column privilege at all on any M3 table',
  $q$ (select bool_and(not has_table_privilege('anon', 'public.' || t, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
                   and not has_any_column_privilege('anon', 'public.' || t, 'SELECT,INSERT,UPDATE,REFERENCES'))
       from pg_temp.t_m3_tables) $q$);
select pg_temp.expect_true('authenticated: no INSERT/UPDATE on exams/items/rules/versions (RPC only)',
  $q$ (select bool_and(not has_table_privilege('authenticated', 'public.' || t, 'INSERT,UPDATE,TRUNCATE')
                   and not has_any_column_privilege('authenticated', 'public.' || t, 'INSERT,UPDATE'))
       from pg_temp.t_m3_tables where t <> 'ex_course_settings')
      and not has_table_privilege('authenticated', 'public.ex_exam_versions', 'DELETE')
      and not has_table_privilege('authenticated', 'public.ex_exam_items', 'DELETE')
      and not has_column_privilege('authenticated', 'public.ex_course_settings', 'updated_by', 'INSERT') $q$);
select pg_temp.expect_true('no new staff permission key (exam.write / exam.publish reused, 8 keys)',
  $q$ private.staff_permission_keys() = array['qbank.read','qbank.write','qbank.import','exam.write','exam.publish',
                                               'grading','analytics.read','security.read'] $q$);
select pg_temp.expect_true('every M3 function has a fixed search_path; public wrappers are SECURITY INVOKER',
  $q$ not exists (select 1 from pg_proc p where p.pronamespace in ('private'::regnamespace, 'public'::regnamespace)
                  and (p.proname like 'ex\_%' or p.proname like 'exam\_%' or p.proname like 'audit\_ex\_%')
                  and not coalesce(array_to_string(p.proconfig, ',') like '%search_path=%', false))
      and (select count(*) = 12 and bool_and(not prosecdef) from pg_proc
           where pronamespace = 'public'::regnamespace and proname like 'exam\_%') $q$);
select pg_temp.expect_true('anon cannot EXECUTE any M3 function',
  $q$ not exists (select 1 from pg_proc p where p.pronamespace in ('private'::regnamespace, 'public'::regnamespace)
                  and (p.proname like 'ex\_%' or p.proname like 'exam\_%' or p.proname like 'audit\_ex\_%')
                  and has_function_privilege('anon', p.oid, 'EXECUTE')) $q$);
select pg_temp.expect_true('authenticated EXECUTE only on the RPCs + ex_can_read (internal helpers denied)',
  $q$ (select array_agg(n.nspname || '.' || p.proname order by n.nspname || '.' || p.proname)
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('private', 'public')
         and (p.proname like 'ex\_%' or p.proname like 'exam\_%' or p.proname like 'audit\_ex\_%')
         and has_function_privilege('authenticated', p.oid, 'EXECUTE'))
      = (select array_agg(x order by x) from unnest(array['private.ex_can_read', 'private.ex_transition',
           'private.exam_preview_pool', 'private.exam_save', 'public.exam_approve', 'public.exam_archive',
           'public.exam_pause', 'public.exam_preview_pool', 'public.exam_publish', 'public.exam_reject',
           'public.exam_request_approval', 'public.exam_resume', 'public.exam_save', 'public.exam_unarchive',
           'public.exam_unpublish', 'public.exam_withdraw']) x) $q$);

-- ---------------------------------------------- no impact on 001..010 (fingerprints taken on 010-only DBs:
-- PGlite AND staging gave identical values before 011 was applied)
create temp table t_fp as
with
pol as (select md5(string_agg(tablename || '.' || policyname || ':' || cmd || ':' || permissive || ':' || roles::text
                   || ':' || coalesce(qual, '') || ':' || coalesce(with_check, ''), '|' order by tablename, policyname)) fp, count(*) n
        from pg_policies where schemaname in ('public', 'private')
          and tablename not in (select t from pg_temp.t_m3_tables)),
fn as (select md5(string_agg(n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || '):'
                  || md5(p.prosrc) || ':' || p.prosecdef || ':' || coalesce(array_to_string(p.proconfig, ','), ''),
                  '|' order by n.nspname, p.proname, pg_get_function_identity_arguments(p.oid))) fp, count(*) n
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('public', 'private')
         and not (n.nspname = 'private' and (p.proname like 'ex\_%' or p.proname like 'exam\_%' or p.proname like 'audit\_ex\_%'))
         and not (n.nspname = 'public' and p.proname like 'exam\_%')),
fnacl as (select md5(string_agg(n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || '):'
                     || has_function_privilege('anon', p.oid, 'EXECUTE') || has_function_privilege('authenticated', p.oid, 'EXECUTE'),
                     '|' order by n.nspname, p.proname, pg_get_function_identity_arguments(p.oid))) fp
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname in ('public', 'private')
            and not (n.nspname = 'private' and (p.proname like 'ex\_%' or p.proname like 'exam\_%' or p.proname like 'audit\_ex\_%'))
            and not (n.nspname = 'public' and p.proname like 'exam\_%')),
tg as (select md5(string_agg(c.relname || '.' || t.tgname || ':' || t.tgenabled::text || ':' || pr.proname, '|' order by c.relname, t.tgname)) fp
       from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_proc pr on pr.oid = t.tgfoid
       where not t.tgisinternal and c.relnamespace in ('public'::regnamespace, 'private'::regnamespace)
         and c.relname not in (select t from pg_temp.t_m3_tables)),
tblpriv as (select md5(string_agg(c.relname || ':' || r.rol || ':' || pv.p || ':' || has_table_privilege(r.rol, c.oid, pv.p), '|'
                       order by c.relname, r.rol, pv.p)) fp
            from pg_class c cross join (values ('anon'), ('authenticated')) r(rol)
            cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) pv(p)
            where c.relnamespace in ('public'::regnamespace, 'private'::regnamespace) and c.relkind in ('r', 'v', 'm')
              and c.relname not in (select t from pg_temp.t_m3_tables)),
colpriv as (select md5(string_agg(c.relname || '.' || a.attname || ':' || r.rol || ':' || pv.p || ':'
                       || has_column_privilege(r.rol, c.oid, a.attnum, pv.p), '|' order by c.relname, a.attnum, r.rol, pv.p)) fp
            from pg_class c join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
            cross join (values ('anon'), ('authenticated')) r(rol) cross join (values ('SELECT'), ('INSERT'), ('UPDATE')) pv(p)
            where c.relnamespace in ('public'::regnamespace, 'private'::regnamespace) and c.relkind = 'r'
              and c.relname not in (select t from pg_temp.t_m3_tables)),
cols as (select md5(string_agg(c.relname || '.' || a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull, '|'
                    order by c.relname, a.attnum)) fp
         from pg_class c join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
         where c.relnamespace in ('public'::regnamespace, 'private'::regnamespace) and c.relkind = 'r'
           and c.relname not in (select t from pg_temp.t_m3_tables)),
cons as (select md5(string_agg(c.relname || '.' || k.conname || ':' || k.contype::text, '|' order by c.relname, k.conname)) fp
         from pg_constraint k join pg_class c on c.oid = k.conrelid
         where c.relnamespace in ('public'::regnamespace, 'private'::regnamespace) and k.contype <> 'n'
           and c.relname not in (select t from pg_temp.t_m3_tables)),
rls as (select md5(string_agg(c.relname || ':' || c.relrowsecurity || c.relforcerowsecurity, '|' order by c.relname)) fp
        from pg_class c where c.relnamespace in ('public'::regnamespace, 'private'::regnamespace) and c.relkind = 'r'
          and c.relname not in (select t from pg_temp.t_m3_tables))
select pol.fp pol, pol.n pol_n, fn.fp fn, fn.n fn_n, fnacl.fp fnacl, tg.fp tg, tblpriv.fp tblpriv, colpriv.fp colpriv,
       cols.fp cols, cons.fp cons, rls.fp rls
from pol, fn, fnacl, tg, tblpriv, colpriv, cols, cons, rls;
grant select on t_fp to public;

select pg_temp.expect_true('no impact: 71 policies of 001..010 identical (names, commands, roles, USING/CHECK text)',
  $q$ (select pol = '2b571157e4fd292d578da04d3c7ba239' and pol_n = 71 from pg_temp.t_fp) $q$);
select pg_temp.expect_true('no impact: 47 functions of 001..010 identical (body md5, definer flag, config)',
  $q$ (select fn = '10c2cdff03d1a8d90bf80bc2dfe67a8b' and fn_n = 47 from pg_temp.t_fp) $q$);
select pg_temp.expect_true('no impact: EXECUTE grants (anon/authenticated) of old functions identical',
  $q$ (select fnacl = '98d7ed61d780b6078f2ec388bf062737' from pg_temp.t_fp) $q$);
select pg_temp.expect_true('no impact: triggers on old tables identical (27, none added to courses/qb_*)',
  $q$ (select tg = '8d49a979980d7250f4192b26306f6b3a' from pg_temp.t_fp) $q$);
select pg_temp.expect_true('no impact: table privileges (anon/authenticated) on old tables identical',
  $q$ (select tblpriv = '0edaf2a0f95b8375311c250c98572431' from pg_temp.t_fp) $q$);
select pg_temp.expect_true('no impact: column privileges (anon/authenticated) on old tables identical',
  $q$ (select colpriv = '61f46324aa62857434d4097958e4c037' from pg_temp.t_fp) $q$);
select pg_temp.expect_true('no impact: columns of old tables identical',
  $q$ (select cols = '29fd842f5e2c3235aae591e7d137a46c' from pg_temp.t_fp) $q$);
select pg_temp.expect_true('no impact: constraints of old tables identical (FKs point INTO them only)',
  $q$ (select cons = '2c12891d9a62b14a14a0ad64718757be' from pg_temp.t_fp) $q$);
select pg_temp.expect_true('no impact: RLS enabled/forced flags of old tables identical',
  $q$ (select rls = '410e8ef1ed10d9dd02a065f9d33a6631' from pg_temp.t_fp) $q$);

-- ------------------------------------------------------------------ fixtures (as postgres)
-- T  = trainee enrolled in capm            W = capm {exam.write, qbank.read}     P = capm {exam.write, exam.publish}
-- R  = capm {exam.publish} (publish only)  X = pmp {exam.write, exam.publish}    N = capm {qbank.write} (no exam flag)
-- AD = admin
insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, raw_app_meta_data) values
 ('00000000-0000-4000-8000-0000000000f1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'm3test-t@example.invalid',  '{"full_name":"Trainee T"}', '{}'),
 ('00000000-0000-4000-8000-0000000000f2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'm3test-w@example.invalid',  '{"full_name":"Writer W"}', '{}'),
 ('00000000-0000-4000-8000-0000000000f3', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'm3test-p@example.invalid',  '{"full_name":"Publisher P"}', '{}'),
 ('00000000-0000-4000-8000-0000000000f4', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'm3test-r@example.invalid',  '{"full_name":"Reviewer R"}', '{}'),
 ('00000000-0000-4000-8000-0000000000f5', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'm3test-x@example.invalid',  '{"full_name":"PMP X"}', '{}'),
 ('00000000-0000-4000-8000-0000000000f6', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'm3test-n@example.invalid',  '{"full_name":"Bank N"}', '{}'),
 ('00000000-0000-4000-8000-0000000000f7', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'm3test-ad@example.invalid', '{"full_name":"Admin AD"}', '{}');
update public.profiles set role = 'admin' where id = '00000000-0000-4000-8000-0000000000f7';
insert into public.enrollments (user_id, course_id) values ('00000000-0000-4000-8000-0000000000f1', 'capm');
insert into public.course_staff (course_id, user_id, permissions) values
 ('capm', '00000000-0000-4000-8000-0000000000f2', '{"exam.write":true,"qbank.read":true}'),
 ('capm', '00000000-0000-4000-8000-0000000000f3', '{"exam.write":true,"exam.publish":true}'),
 ('capm', '00000000-0000-4000-8000-0000000000f4', '{"exam.publish":true}'),
 ('pmp',  '00000000-0000-4000-8000-0000000000f5', '{"exam.write":true,"exam.publish":true}'),
 ('capm', '00000000-0000-4000-8000-0000000000f6', '{"qbank.write":true}');

-- bank, created by the admin through the M1 RPC
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000f7","role":"authenticated"}', true);
with i as (insert into public.qb_taxonomy (course_id, level, code, name_ar) values ('capm', 'domain', 'M3D1', 'D1') returning id) select pg_temp.keep('D1', id) from i;
with i as (insert into public.qb_taxonomy (course_id, parent_id, level, name_ar) values ('capm', pg_temp.idof('D1'), 'topic', 'D1T1') returning id) select pg_temp.keep('D1T1', id) from i;
with i as (insert into public.qb_taxonomy (course_id, parent_id, level, name_ar) values ('capm', pg_temp.idof('D1T1'), 'subtopic', 'D1T1S1') returning id) select pg_temp.keep('D1T1S1', id) from i;
with i as (insert into public.qb_taxonomy (course_id, level, code, name_ar) values ('capm', 'domain', 'M3D2', 'D2') returning id) select pg_temp.keep('D2', id) from i;
with i as (insert into public.qb_tags (course_id, label) values ('capm', 'm3 tag') returning id) select pg_temp.keep('tagA', id) from i;
with i as (insert into public.qb_sets (course_id, title) values ('capm', 'm3 set') returning id) select pg_temp.keep('setA', id) from i;
with i as (insert into public.qb_taxonomy (course_id, level, code, name_ar) values ('pmp', 'domain', 'M3P1', 'P1') returning id) select pg_temp.keep('taxB', id) from i;
with i as (insert into public.qb_tags (course_id, label) values ('pmp', 'm3 pmp tag') returning id) select pg_temp.keep('tagB', id) from i;

create function pg_temp.mkq(p_name text, p_course text, p_tax text, p_diff text, p_type text, p_status text,
                            p_points numeric, p_set text default null) returns uuid language sql as $$
  select pg_temp.keep(p_name, (private.qb_save_question(jsonb_build_object(
    'course_id', p_course, 'type_code', p_type, 'taxonomy_id', pg_temp.idof(p_tax), 'difficulty', p_diff,
    'status', p_status, 'points', p_points, 'set_id', pg_temp.idof(p_set),
    'payload', case when p_type = 'true_false' then jsonb_build_object('stem', jsonb_build_object('text', 'M3Q secret stem ' || p_name))
                    else jsonb_build_object('stem', jsonb_build_object('text', 'M3Q secret stem ' || p_name),
                                            'options', '[{"id":"a","text":"M3Q opt A"},{"id":"b","text":"M3Q opt B"}]'::jsonb) end,
    'key', case when p_type = 'true_false' then '{"correct":"true"}'::jsonb else '{"correct":"a"}'::jsonb end,
    'explanation', 'M3Q secret explanation')) ->> 'question_id')::uuid) $$;
-- eligible capm pool: q1..q6 (D1 subtree, easy, 1pt) + h1..h4 (D2, hard, true_false, 2pt) = 10
select pg_temp.mkq('q1', 'capm', 'D1T1S1', 'easy', 'mcq_single', 'active', 1);
select pg_temp.mkq('q2', 'capm', 'D1T1S1', 'easy', 'mcq_single', 'active', 1);
select pg_temp.mkq('q3', 'capm', 'D1T1S1', 'easy', 'mcq_single', 'active', 1);
select pg_temp.mkq('q4', 'capm', 'D1T1S1', 'easy', 'mcq_single', 'active', 1);
select pg_temp.mkq('q5', 'capm', 'D1T1',   'easy', 'mcq_single', 'active', 1);
select pg_temp.mkq('q6', 'capm', 'D1T1',   'easy', 'mcq_single', 'active', 1);
select pg_temp.mkq('h1', 'capm', 'D2', 'hard', 'true_false', 'active', 2);
select pg_temp.mkq('h2', 'capm', 'D2', 'hard', 'true_false', 'active', 2);
select pg_temp.mkq('h3', 'capm', 'D2', 'hard', 'true_false', 'active', 2);
select pg_temp.mkq('h4', 'capm', 'D2', 'hard', 'true_false', 'active', 2);
select pg_temp.mkq('qdraft', 'capm', 'D1', 'easy', 'mcq_single', 'draft', 1);           -- not active
select pg_temp.mkq('qset',   'capm', 'D1', 'easy', 'mcq_single', 'active', 1, 'setA');  -- scenario child
select pg_temp.mkq('qB',     'pmp',  'taxB', 'easy', 'mcq_single', 'active', 1);
insert into public.qb_question_tags (course_id, question_id, tag_id) values
 ('capm', pg_temp.idof('q1'), pg_temp.idof('tagA')), ('capm', pg_temp.idof('q2'), pg_temp.idof('tagA'));
select pg_temp.keep('q1_v1', (select current_version_id from public.qb_questions where id = pg_temp.idof('q1')));
select set_config('request.jwt.claims', '', true);

select pg_temp.expect_true('fixture: 12 capm + 1 pmp questions, default security json valid',
  $q$ (select count(*) = 12 from public.qb_questions where course_id = 'capm' and id in (select id from pg_temp.t_ids))
      and private.ex_security_ok('{"monitoring":false,"max_warnings":3,"on_exceed":"log","fullscreen_required":false,"watermark":false}') $q$);

-- ================================================================== ANON
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select pg_temp.expect_hidden('anon: ex_course_settings hidden',    'select * from public.ex_course_settings');
select pg_temp.expect_hidden('anon: ex_exams hidden',              'select * from public.ex_exams');
select pg_temp.expect_hidden('anon: ex_exam_items hidden',         'select * from public.ex_exam_items');
select pg_temp.expect_hidden('anon: ex_exam_rules hidden',         'select * from public.ex_exam_rules');
select pg_temp.expect_hidden('anon: ex_exam_versions hidden',      'select * from public.ex_exam_versions');
select pg_temp.expect_hidden('anon: ex_exam_version_items hidden', 'select * from public.ex_exam_version_items');
select pg_temp.expect_hidden('anon: ex_exam_version_rules hidden', 'select * from public.ex_exam_version_rules');
select pg_temp.expect_hidden('anon: ex_exam_version_pool hidden',  'select * from public.ex_exam_version_pool');
select pg_temp.expect_error('anon: cannot call exam_save()',
  $q$ select public.exam_save('{"course_id":"capm","folder_kind":"domain_tests","exam_kind":"practice","title_ar":"x"}') $q$);
select pg_temp.expect_error('anon: cannot call exam_preview_pool()', $q$ select public.exam_preview_pool('{"course_id":"capm","rules":[]}') $q$);
select pg_temp.expect_error('anon: cannot call exam_publish()', $q$ select public.exam_publish('00000000-0000-4000-8000-00000000dead') $q$);
select pg_temp.expect_error('anon: cannot call private.ex_pool()', $q$ select * from private.ex_pool('capm', null, '[{"position":1}]', null) $q$);

-- ================================================================== W (capm exam.write + qbank.read)
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000f2","role":"authenticated"}', true);
set local role authenticated;
select pg_temp.expect_true('W: ex_can_read(capm) true, (pmp) false; cannot publish directly',
  $q$ private.ex_can_read('capm') and not private.ex_can_read('pmp') $q$);
select pg_temp.expect_error('W: cannot call internal helpers (ex_pool / ex_collect_errors / ex_freeze)',
  $q$ select private.ex_collect_errors('00000000-0000-4000-8000-00000000dead') $q$);
select pg_temp.expect_error('W: cannot call private.ex_freeze()', $q$ select private.ex_freeze('00000000-0000-4000-8000-00000000dead', null) $q$);

select pg_temp.expect_ok('W: CAN create simulation exam A (items + rules), totals computed server-side',
  $q$ select pg_temp.keep('A', (pg_temp.keepj('saveA', public.exam_save(jsonb_build_object(
        'course_id', 'capm', 'folder_kind', 'exam_simulations', 'exam_kind', 'simulation', 'title_ar', 'محاكاة A',
        'duration_minutes', 60, 'pass_percent', 60, 'review_policy', 'after_submit', 'feedback_policy', 'after_submit',
        'security', jsonb_build_object('monitoring', true, 'fullscreen_required', true, 'on_exceed', 'warn'),
        'items', jsonb_build_array(jsonb_build_object('question_id', pg_temp.idof('q1'), 'points', 3),
                                   jsonb_build_object('question_id', pg_temp.idof('h1'))),
        'rules', jsonb_build_array(jsonb_build_object('taxonomy_id', pg_temp.idof('D1'), 'difficulty', 'easy', 'count', 3),
                                   jsonb_build_object('difficulty', 'hard', 'count', 2, 'points_each', 2))))) ->> 'exam_id')::uuid) $q$);
select pg_temp.expect_true('totals: A = 3 (override) + 2 (h1 version points) + 3x1 + 2x2 = 12; 7 questions',
  $q$ (pg_temp.jof('saveA') ->> 'total_score')::numeric = 12 and (pg_temp.jof('saveA') ->> 'question_count')::int = 7
      and (select total_score = 12 and question_count = 7 and status = 'draft' and created_by = '00000000-0000-4000-8000-0000000000f2'
           from public.ex_exams where id = pg_temp.idof('A')) $q$);
select pg_temp.expect_true('settings stored typed; security merged with defaults',
  $q$ (select duration_minutes = 60 and pass_percent = 60 and shuffle_questions and grace_seconds = 30
              and security = '{"monitoring":true,"max_warnings":3,"on_exceed":"warn","fullscreen_required":true,"watermark":false}'::jsonb
       from public.ex_exams where id = pg_temp.idof('A')) $q$);
select pg_temp.expect_count('W: sees exam A items (2) and rules (2)',
  $q$ select position from public.ex_exam_items where exam_id = pg_temp.idof('A')
      union all select position from public.ex_exam_rules where exam_id = pg_temp.idof('A') $q$, 4);
select pg_temp.expect_raise('client cannot send total_score (unknown field)',
  $q$ select public.exam_save(jsonb_build_object('exam_id', pg_temp.idof('A'), 'total_score', 999)) $q$, '22023', '%unknown field: total_score%');
select pg_temp.expect_raise('client cannot send status (unknown field)',
  $q$ select public.exam_save(jsonb_build_object('exam_id', pg_temp.idof('A'), 'status', 'published')) $q$, '22023', '%unknown field: status%');
select pg_temp.expect_error('W: cannot INSERT into ex_exams by REST',
  $q$ insert into public.ex_exams (course_id, folder_kind, exam_kind, title_ar) values ('capm', 'domain_tests', 'practice', 'x') $q$);
select pg_temp.expect_error('W: cannot UPDATE ex_exams by REST',
  $q$ update public.ex_exams set title_ar = 'x' where id = pg_temp.idof('A') $q$);
select pg_temp.expect_error('W: cannot INSERT ex_exam_items by REST',
  $q$ insert into public.ex_exam_items (exam_id, course_id, position, question_id) values (pg_temp.idof('A'), 'capm', 9, pg_temp.idof('q2')) $q$);

-- scratch exam V for validation tests
select pg_temp.expect_ok('W: CAN create practice exam V',
  $q$ select pg_temp.keep('V', (public.exam_save('{"course_id":"capm","folder_kind":"domain_tests","exam_kind":"practice","title_ar":"V"}') ->> 'exam_id')::uuid) $q$);

-- CHECK constraints / input validation
select pg_temp.expect_state('CHECK: pass_percent > 100 rejected',
  $q$ select public.exam_save(jsonb_build_object('exam_id', pg_temp.idof('V'), 'pass_percent', 150)) $q$, '23514');
select pg_temp.expect_state('CHECK: pass_percent and pass_score together rejected',
  $q$ select public.exam_save(jsonb_build_object('exam_id', pg_temp.idof('V'), 'pass_percent', 50, 'pass_score', 5)) $q$, '23514');
select pg_temp.expect_state('CHECK: close_at before open_at rejected',
  $q$ select public.exam_save(jsonb_build_object('exam_id', pg_temp.idof('V'), 'open_at', '2031-01-02T00:00:00Z', 'close_at', '2031-01-01T00:00:00Z')) $q$, '23514');
select pg_temp.expect_state('CHECK: duration 0 rejected',
  $q$ select public.exam_save(jsonb_build_object('exam_id', pg_temp.idof('V'), 'duration_minutes', 0)) $q$, '23514');
select pg_temp.expect_state('CHECK: unknown review_policy rejected',
  $q$ select public.exam_save(jsonb_build_object('exam_id', pg_temp.idof('V'), 'review_policy', 'sometimes')) $q$, '23514');
select pg_temp.expect_state('CHECK: folder_kind question_bank rejected (exam folders only)',
  $q$ select public.exam_save(jsonb_build_object('exam_id', pg_temp.idof('V'), 'folder_kind', 'question_bank')) $q$, '23514');
select pg_temp.expect_state('CHECK: feedback "always" only for practice exams',
  $q$ select public.exam_save(jsonb_build_object('exam_id', pg_temp.idof('V'), 'exam_kind', 'final', 'feedback_policy', 'always')) $q$, '23514');
select pg_temp.expect_ok('practice exam MAY use feedback/explanation "always"',
  $q$ select public.exam_save(jsonb_build_object('exam_id', pg_temp.idof('V'), 'feedback_policy', 'always', 'explanation_policy', 'always')) $q$);
select pg_temp.expect_state('CHECK: security with unknown key rejected',
  $q$ select public.exam_save(jsonb_build_object('exam_id', pg_temp.idof('V'), 'security', '{"camera":true}'::jsonb)) $q$, '23514');
select pg_temp.expect_state('CHECK: fullscreen_required without monitoring rejected',
  $q$ select public.exam_save(jsonb_build_object('exam_id', pg_temp.idof('V'), 'security', '{"monitoring":false,"fullscreen_required":true}'::jsonb)) $q$, '23514');
select pg_temp.expect_state('CHECK: max_warnings out of range rejected',
  $q$ select public.exam_save(jsonb_build_object('exam_id', pg_temp.idof('V'), 'security', '{"monitoring":true,"max_warnings":99}'::jsonb)) $q$, '23514');
select pg_temp.expect_state('input: non-boolean shuffle value rejected (22023)',
  $q$ select public.exam_save(jsonb_build_object('exam_id', pg_temp.idof('V'), 'shuffle_questions', 'maybe')) $q$, '22023');
select pg_temp.expect_state('input: bad timestamp rejected (22023)',
  $q$ select public.exam_save(jsonb_build_object('exam_id', pg_temp.idof('V'), 'open_at', 'tomorrow-ish')) $q$, '22023');
select pg_temp.expect_state('input: rule count 0 rejected', $q$ select public.exam_save(jsonb_build_object('exam_id', pg_temp.idof('V'), 'rules', '[{"count":0}]'::jsonb)) $q$, '22023');
select pg_temp.expect_state('input: rule bad difficulty rejected', $q$ select public.exam_save(jsonb_build_object('exam_id', pg_temp.idof('V'), 'rules', '[{"count":1,"difficulty":"insane"}]'::jsonb)) $q$, '22023');
select pg_temp.expect_state('input: rule unknown type rejected', $q$ select public.exam_save(jsonb_build_object('exam_id', pg_temp.idof('V'), 'rules', '[{"count":1,"type_code":"nope"}]'::jsonb)) $q$, '22023');
select pg_temp.expect_state('input: rule unknown field rejected', $q$ select public.exam_save(jsonb_build_object('exam_id', pg_temp.idof('V'), 'rules', '[{"count":1,"seed":42}]'::jsonb)) $q$, '22023');
select pg_temp.expect_state('input: duplicate question in items rejected',
  $q$ select public.exam_save(jsonb_build_object('exam_id', pg_temp.idof('V'), 'items',
        jsonb_build_array(jsonb_build_object('question_id', pg_temp.idof('q2')), jsonb_build_object('question_id', pg_temp.idof('q2'))))) $q$, '22023');
select pg_temp.expect_true('a failed save changed nothing (V still has 0 items, no pass rule)',
  $q$ (select count(*) = 0 from public.ex_exam_items where exam_id = pg_temp.idof('V'))
      and (select pass_percent is null and pass_score is null from public.ex_exams where id = pg_temp.idof('V')) $q$);

-- course isolation (composite FKs + in-course checks; same 23503 for absent and foreign rows)
select pg_temp.expect_state('isolation: item = pmp question rejected (23503)',
  $q$ select public.exam_save(jsonb_build_object('exam_id', pg_temp.idof('V'), 'items', jsonb_build_array(jsonb_build_object('question_id', pg_temp.idof('qB'))))) $q$, '23503');
select pg_temp.expect_state('isolation: rule taxonomy of pmp rejected (23503)',
  $q$ select public.exam_save(jsonb_build_object('exam_id', pg_temp.idof('V'), 'rules', jsonb_build_array(jsonb_build_object('taxonomy_id', pg_temp.idof('taxB'), 'count', 1)))) $q$, '23503');
select pg_temp.expect_state('isolation: rule tag of pmp rejected (23503)',
  $q$ select public.exam_save(jsonb_build_object('exam_id', pg_temp.idof('V'), 'rules', jsonb_build_array(jsonb_build_object('tag_id', pg_temp.idof('tagB'), 'count', 1)))) $q$, '23503');
select pg_temp.expect_state('isolation: scope taxonomy of pmp rejected (23503)',
  $q$ select public.exam_save(jsonb_build_object('exam_id', pg_temp.idof('V'), 'scope_taxonomy_id', pg_temp.idof('taxB'))) $q$, '23503');
select pg_temp.expect_state('isolation: unknown question id gives the same 23503',
  $q$ select public.exam_save(jsonb_build_object('exam_id', pg_temp.idof('V'), 'items', '[{"question_id":"00000000-0000-4000-8000-00000000dead"}]'::jsonb)) $q$, '23503');
select pg_temp.expect_state('W: cannot create an exam in pmp (forbidden)',
  $q$ select public.exam_save('{"course_id":"pmp","folder_kind":"domain_tests","exam_kind":"practice","title_ar":"x"}') $q$, '42501');
select pg_temp.expect_state('W: course_id in an edit must match the exam',
  $q$ select public.exam_save(jsonb_build_object('exam_id', pg_temp.idof('V'), 'course_id', 'pmp')) $q$, '22023');
select pg_temp.expect_state('W: unknown exam id => forbidden (no existence oracle)',
  $q$ select public.exam_save('{"exam_id":"00000000-0000-4000-8000-00000000dead","title_ar":"x"}') $q$, '42501');

-- preview (counts only)
select pg_temp.expect_ok('W: preview exam A',
  $q$ select pg_temp.keepj('pvA', public.exam_preview_pool(jsonb_build_object('exam_id', pg_temp.idof('A')))) $q$);
select pg_temp.expect_true('preview A: rule1 5/5 (D1 easy minus fixed q1), rule2 3/3 (hard minus h1), eligible 8, total 12, no errors',
  $q$ (select j -> 'rules' = '[{"ok":true,"position":1,"requested":3,"matching":5,"available":5},
                               {"ok":true,"position":2,"requested":2,"matching":3,"available":3}]'::jsonb
              and (j ->> 'eligible')::int = 8 and (j ->> 'fixed_items')::int = 2 and (j ->> 'total_score')::numeric = 12
              and j -> 'errors' = '[]'::jsonb
       from pg_temp.t_json where name = 'pvA') $q$);
select pg_temp.expect_ok('W: preview unsaved overlapping rules (builder mode)',
  $q$ select pg_temp.keepj('pvB', public.exam_preview_pool(jsonb_build_object('course_id', 'capm',
        'rules', jsonb_build_array(jsonb_build_object('taxonomy_id', pg_temp.idof('D1'), 'count', 1),
                                   jsonb_build_object('difficulty', 'easy', 'count', 1),
                                   jsonb_build_object('tag_id', pg_temp.idof('tagA'), 'count', 1)),
        'exclude_question_ids', jsonb_build_array(pg_temp.idof('q3'))))) $q$);
select pg_temp.expect_true('preview: first-match-wins (rule2/rule3 match but get 0), exclude honored, eligible 9',
  $q$ (select j -> 'rules' = '[{"ok":true,"position":1,"requested":1,"matching":5,"available":5},
                               {"ok":false,"position":2,"requested":1,"matching":5,"available":0},
                               {"ok":false,"position":3,"requested":1,"matching":2,"available":0}]'::jsonb
              and (j ->> 'eligible')::int = 9 and not (j ? 'errors')
       from pg_temp.t_json where name = 'pvB') $q$);
select pg_temp.expect_true('preview: no question text, ids, version ids or answers leak',
  $q$ (select bool_and(not (j::text like '%M3Q%') and not (j::text like '%correct%') and not (j::text like '%explanation%')
                       and not exists (select 1 from pg_temp.t_ids i where i.name ~ '^(q|h)' and j::text like '%' || i.id::text || '%'))
       from pg_temp.t_json where name in ('pvA', 'pvB')) $q$);
select pg_temp.expect_true('preview: an empty/NULL entry in exclude_question_ids does not empty the pool',
  $q$ (select (public.exam_preview_pool('{"course_id":"capm","rules":[{"count":1}],"exclude_question_ids":[""]}') ->> 'eligible')::int = 10) $q$);
select pg_temp.expect_state('preview: pmp taxonomy in builder mode rejected (23503)',
  $q$ select public.exam_preview_pool(jsonb_build_object('course_id', 'capm', 'rules', jsonb_build_array(jsonb_build_object('taxonomy_id', pg_temp.idof('taxB'), 'count', 1)))) $q$, '23503');
select pg_temp.expect_state('preview: pmp course forbidden for W', $q$ select public.exam_preview_pool('{"course_id":"pmp","rules":[]}') $q$, '42501');
select pg_temp.expect_state('preview: exam_id mode refuses extra rules', $q$ select public.exam_preview_pool(jsonb_build_object('exam_id', pg_temp.idof('A'), 'rules', '[]'::jsonb)) $q$, '22023');

-- publish validations (each on the draft V, via request_approval which runs the full validation)
reset role;
delete from private.rl_counters where key like 'ex\_%';
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000f2","role":"authenticated"}', true);
set local role authenticated;
select pg_temp.expect_raise('validation: empty exam => no_questions',
  $q$ select public.exam_request_approval(pg_temp.idof('V')) $q$, '22023', 'exam_invalid:%no_questions%');
select pg_temp.expect_raise('validation: rule asks 50, pool has fewer => rule_insufficient',
  $q$ select public.exam_save(jsonb_build_object('exam_id', pg_temp.idof('V'), 'rules', '[{"count":50}]'::jsonb));
      select public.exam_request_approval(pg_temp.idof('V')) $q$, '22023', 'exam_invalid:%rule_insufficient%');
select pg_temp.expect_raise('validation: inactive (draft) question as fixed pick => item_inactive',
  $q$ select public.exam_save(jsonb_build_object('exam_id', pg_temp.idof('V'), 'rules', '[]'::jsonb,
        'items', jsonb_build_array(jsonb_build_object('question_id', pg_temp.idof('qdraft')))));
      select public.exam_request_approval(pg_temp.idof('V')) $q$, '22023', 'exam_invalid:%item_inactive%');
select pg_temp.expect_raise('validation: scenario-set child as fixed pick => item_in_set',
  $q$ select public.exam_save(jsonb_build_object('exam_id', pg_temp.idof('V'), 'items', jsonb_build_array(jsonb_build_object('question_id', pg_temp.idof('qset')))));
      select public.exam_request_approval(pg_temp.idof('V')) $q$, '22023', 'exam_invalid:%item_in_set%');
select pg_temp.expect_raise('validation: fixed pick outside the exam scope => item_out_of_scope',
  $q$ select public.exam_save(jsonb_build_object('exam_id', pg_temp.idof('V'), 'scope_taxonomy_id', pg_temp.idof('D2'),
        'items', jsonb_build_array(jsonb_build_object('question_id', pg_temp.idof('q1')))));
      select public.exam_request_approval(pg_temp.idof('V')) $q$, '22023', 'exam_invalid:%item_out_of_scope%');
select pg_temp.expect_true('scope: rule pools are limited to the scope subtree (D2 scope => only hard D2 questions)',
  $q$ (select (public.exam_preview_pool(jsonb_build_object('course_id', 'capm', 'scope_taxonomy_id', pg_temp.idof('D2'),
              'rules', '[{"count":1}]'::jsonb)) ->> 'eligible')::int = 4) $q$);
select pg_temp.expect_raise('validation: pass_score above the computed total => pass_score_exceeds_total',
  $q$ select public.exam_save(jsonb_build_object('exam_id', pg_temp.idof('V'), 'scope_taxonomy_id', null, 'pass_score', 100));
      select public.exam_request_approval(pg_temp.idof('V')) $q$, '22023', 'exam_invalid:%pass_score_exceeds_total%');
select pg_temp.expect_raise('validation: window already closed => window_closed',
  $q$ select public.exam_save(jsonb_build_object('exam_id', pg_temp.idof('V'), 'pass_score', null,
        'open_at', now() - interval '2 days', 'close_at', now() - interval '1 day'));
      select public.exam_request_approval(pg_temp.idof('V')) $q$, '22023', 'exam_invalid:%window_closed%');
select pg_temp.expect_raise('validation: remaining window shorter than duration => window_shorter_than_duration',
  $q$ select public.exam_save(jsonb_build_object('exam_id', pg_temp.idof('V'), 'duration_minutes', 60,
        'open_at', null, 'close_at', now() + interval '30 minutes'));
      select public.exam_request_approval(pg_temp.idof('V')) $q$, '22023', 'exam_invalid:%window_shorter_than_duration%');
select pg_temp.expect_raise('validation: after_close policy without close_at => after_close_needs_close_at',
  $q$ select public.exam_save(jsonb_build_object('exam_id', pg_temp.idof('V'), 'close_at', null, 'feedback_policy', 'never',
        'explanation_policy', 'never', 'review_policy', 'after_close'));
      select public.exam_request_approval(pg_temp.idof('V')) $q$, '22023', 'exam_invalid:%after_close_needs_close_at%');
select pg_temp.expect_raise('validation: review never but feedback after_submit => feedback_needs_review',
  $q$ select public.exam_save(jsonb_build_object('exam_id', pg_temp.idof('V'), 'review_policy', 'never', 'feedback_policy', 'after_submit'));
      select public.exam_request_approval(pg_temp.idof('V')) $q$, '22023', 'exam_invalid:%feedback_needs_review%');
select pg_temp.expect_raise('validation: final without duration/pass/max_attempts => all three codes',
  $q$ select public.exam_save(jsonb_build_object('exam_id', pg_temp.idof('V'), 'exam_kind', 'final', 'feedback_policy', 'never',
        'explanation_policy', 'never', 'duration_minutes', null));
      select public.exam_request_approval(pg_temp.idof('V')) $q$, '22023', 'exam_invalid:%duration_required%max_attempts_required%pass_required%');
select pg_temp.expect_true('validation failures left V a draft',
  $q$ (select status = 'draft' from public.ex_exams where id = pg_temp.idof('V')) $q$);

-- approval flow (W has no exam.publish => publish is routed to approval)
select pg_temp.expect_true('W: exam_publish without direct right => pending_approval (routed)',
  $q$ (select r ->> 'status' = 'pending_approval' and r ->> 'action' = 'request_approval' and r ->> 'published_version_id' is null
       from (select public.exam_publish(pg_temp.idof('A')) r) s) $q$);
select pg_temp.expect_state('freeze: W cannot edit A while pending (55000)',
  $q$ select public.exam_save(jsonb_build_object('exam_id', pg_temp.idof('A'), 'title_ar', 'hack')) $q$, '55000');
select pg_temp.expect_state('W: cannot approve (admin only)', $q$ select public.exam_approve(pg_temp.idof('A')) $q$, '42501');
select pg_temp.expect_state('W: cannot reject (admin only)',  $q$ select public.exam_reject(pg_temp.idof('A'), 'no') $q$, '42501');
select pg_temp.expect_state('W: cannot resume (needs direct publish right)', $q$ select public.exam_resume(pg_temp.idof('A')) $q$, '42501');
select pg_temp.expect_true('W: CAN withdraw his request => draft',
  $q$ (select public.exam_withdraw(pg_temp.idof('A')) ->> 'status' = 'draft') $q$);
select pg_temp.expect_true('W: request approval again => pending',
  $q$ (select public.exam_request_approval(pg_temp.idof('A'), 'please review') ->> 'status' = 'pending_approval') $q$);
select pg_temp.expect_state('invalid transition: archive a pending exam (55000)', $q$ select public.exam_archive(pg_temp.idof('A')) $q$, '55000');
select pg_temp.expect_state('invalid transition: unarchive a draft (55000)', $q$ select public.exam_unarchive(pg_temp.idof('V')) $q$, '55000');
select pg_temp.expect_state('unknown action rejected', $q$ select private.ex_transition(pg_temp.idof('V'), 'teleport') $q$, '22023');
select pg_temp.expect_hidden('W: pmp exams hidden (none yet, and RLS)', $q$ select * from public.ex_exams where course_id = 'pmp' $q$);

-- ================================================================== ADMIN reviews
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000f7","role":"authenticated"}', true);
set local role authenticated;
select pg_temp.expect_state('admin: reject needs a reason', $q$ select public.exam_reject(pg_temp.idof('A'), '  ') $q$, '22023');
select pg_temp.expect_true('admin: reject => draft',
  $q$ (select public.exam_reject(pg_temp.idof('A'), 'fix pass rule') ->> 'status' = 'draft') $q$);
select pg_temp.expect_true('admin: rejection note + reviewer stored',
  $q$ (select review_note = 'fix pass rule' and reviewed_by = '00000000-0000-4000-8000-0000000000f7' from public.ex_exams where id = pg_temp.idof('A')) $q$);
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000f2","role":"authenticated"}', true);
set local role authenticated;
select pg_temp.expect_ok('W: re-requests approval of A', $q$ select public.exam_request_approval(pg_temp.idof('A')) $q$);
-- exam B: fixed pick q6, requested now, q6 retired before approval
select pg_temp.expect_ok('W: creates + requests exam B (fixed q6)',
  $q$ select pg_temp.keep('B', (public.exam_save(jsonb_build_object('course_id', 'capm', 'folder_kind', 'domain_tests',
        'exam_kind', 'practice', 'title_ar', 'B', 'items', jsonb_build_array(jsonb_build_object('question_id', pg_temp.idof('q6'))))) ->> 'exam_id')::uuid);
      select public.exam_request_approval(pg_temp.idof('B')) $q$);
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000f7","role":"authenticated"}', true);
set local role authenticated;
select pg_temp.expect_true('admin: approve A => published, version 1',
  $q$ (select r ->> 'status' = 'published' and (r ->> 'version_no')::int = 1 and r ->> 'action' = 'approve'
       from (select public.exam_approve(pg_temp.idof('A'), 'ok') r) s) $q$);
select pg_temp.expect_true('version 1: approved_by admin, requested_by W, frozen totals 12 / 7, settings snapshot',
  $q$ (select v.approved_by = '00000000-0000-4000-8000-0000000000f7' and v.requested_by = '00000000-0000-4000-8000-0000000000f2'
              and v.published_by = '00000000-0000-4000-8000-0000000000f7' and v.total_score = 12 and v.question_count = 7
              and v.fixed_count = 2 and v.settings ->> 'title_ar' = 'محاكاة A' and (v.settings ->> 'duration_minutes')::int = 60
              and not (v.settings ? 'status') and e.published_version_id = v.id
       from public.ex_exam_versions v join public.ex_exams e on e.id = v.exam_id where v.exam_id = pg_temp.idof('A')) $q$);
select pg_temp.expect_true('version 1: fixed picks pinned to current question versions with effective points',
  $q$ (select array_agg(vi.points order by vi.position) = array[3, 2]::numeric[]
              and bool_and(vi.question_version_id = q.current_version_id)
       from public.ex_exam_version_items vi join public.qb_questions q on q.id = vi.question_id
       where vi.exam_version_id = (select published_version_id from public.ex_exams where id = pg_temp.idof('A'))) $q$);
select pg_temp.expect_true('version 1: frozen rules pool sizes 5 and 3; pool = 8 disjoint rows, no fixed pick inside',
  $q$ (select array_agg(pool_size order by rule_no) = array[5, 3] from public.ex_exam_version_rules
       where exam_version_id = (select published_version_id from public.ex_exams where id = pg_temp.idof('A')))
      and (select count(*) = 8 and count(distinct question_id) = 8
                  and not bool_or(question_id in (pg_temp.idof('q1'), pg_temp.idof('h1')))
           from public.ex_exam_version_pool where exam_version_id = (select published_version_id from public.ex_exams where id = pg_temp.idof('A'))) $q$);
-- retire q6 (bank admin action) then approve B: approval re-validates against the bank NOW
select pg_temp.expect_affected('admin: retires q6 (used by pending exam B)',
  $q$ update public.qb_questions set status = 'retired' where id = pg_temp.idof('q6') $q$, 1);
select pg_temp.expect_raise('approval re-validates: B now has an inactive pick => item_inactive',
  $q$ select public.exam_approve(pg_temp.idof('B')) $q$, '22023', 'exam_invalid:%item_inactive%');
select pg_temp.expect_true('B stays pending after the failed approval',
  $q$ (select status = 'pending_approval' and published_version_id is null from public.ex_exams where id = pg_temp.idof('B')) $q$);
select pg_temp.expect_state('admin: invalid transition resume of a draft (55000)', $q$ select public.exam_resume(pg_temp.idof('V')) $q$, '55000');

-- bank edit after publish does not touch the frozen exam
select pg_temp.expect_ok('admin: edits q1 in the bank (new version 2)',
  $q$ select public.qb_save_question(jsonb_build_object('question_id', pg_temp.idof('q1'),
        'payload', '{"stem":{"text":"M3Q q1 v2"},"options":[{"id":"a","text":"x"},{"id":"b","text":"y"}]}'::jsonb, 'key', '{"correct":"b"}'::jsonb, 'points', 9)) $q$);
select pg_temp.expect_true('snapshot: A version 1 still pins q1 version 1 with 3 points; total still 12',
  $q$ (select vi.question_version_id = pg_temp.idof('q1_v1') and vi.points = 3
       from public.ex_exam_version_items vi where vi.question_id = pg_temp.idof('q1')
         and vi.exam_version_id = (select published_version_id from public.ex_exams where id = pg_temp.idof('A')))
      and (select total_score = 12 and status = 'published' from public.ex_exams where id = pg_temp.idof('A')) $q$);
select pg_temp.expect_error('pinned bank question can no longer be deleted (version FK restrict)',
  $q$ delete from public.qb_questions where id = pg_temp.idof('h2') $q$);

-- per-course direct-publish setting
select pg_temp.expect_hidden('default: capm has no settings row (approval required)', $q$ select * from public.ex_course_settings where course_id = 'capm' $q$);

-- ================================================================== P (exam.write + exam.publish) with approval required
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000f3","role":"authenticated"}', true);
set local role authenticated;
select pg_temp.expect_true('P: exam.publish alone does not bypass approval by default', $q$ not pg_temp.direct('capm') $q$);
select pg_temp.expect_ok('P: creates exam C (1 fixed + rule of 1 hard)',
  $q$ select pg_temp.keep('C', (public.exam_save(jsonb_build_object('course_id', 'capm', 'folder_kind', 'domain_tests',
        'exam_kind', 'practice', 'title_ar', 'C', 'items', jsonb_build_array(jsonb_build_object('question_id', pg_temp.idof('q2'))),
        'rules', '[{"difficulty":"hard","count":1}]'::jsonb)) ->> 'exam_id')::uuid) $q$);
select pg_temp.expect_true('P: exam_publish => pending_approval (course requires approval)',
  $q$ (select public.exam_publish(pg_temp.idof('C')) ->> 'status' = 'pending_approval') $q$);
select pg_temp.expect_error('P: cannot create course settings (admin only)',
  $q$ insert into public.ex_course_settings (course_id, publish_requires_approval) values ('capm', false) $q$);
select pg_temp.expect_state('P: cannot approve his own request (admin only)', $q$ select public.exam_approve(pg_temp.idof('C')) $q$, '42501');
select pg_temp.expect_count('P: sees capm exams A, V, B, C', $q$ select id from public.ex_exams where id in (pg_temp.idof('A'), pg_temp.idof('V'), pg_temp.idof('B'), pg_temp.idof('C')) $q$, 4);

reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000f7","role":"authenticated"}', true);
set local role authenticated;
select pg_temp.expect_affected('admin: sets capm publish_requires_approval = false',
  $q$ insert into public.ex_course_settings (course_id, publish_requires_approval) values ('capm', false) $q$, 1);
select pg_temp.expect_true('settings row stamped updated_by = admin',
  $q$ (select updated_by = '00000000-0000-4000-8000-0000000000f7' from public.ex_course_settings where course_id = 'capm') $q$);

reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000f3","role":"authenticated"}', true);
set local role authenticated;
select pg_temp.expect_true('P: now a direct publisher', $q$ pg_temp.direct('capm') $q$);
select pg_temp.expect_true('P: publishing his pending C => published directly, version approved_by = P (from pending)',
  $q$ (select public.exam_publish(pg_temp.idof('C')) ->> 'status' = 'published') $q$);
select pg_temp.expect_ok('P: unpublish C then publish from draft', $q$ select public.exam_unpublish(pg_temp.idof('C')); select public.exam_publish(pg_temp.idof('C')) $q$);
select pg_temp.expect_true('C: versions 1 and 2; v2 published directly (approved_by null), v1 untouched',
  $q$ (select array_agg(version_no order by version_no) = array[1, 2]
              and bool_and((version_no = 2) = (approved_by is null))
       from public.ex_exam_versions where exam_id = pg_temp.idof('C'))
      and (select v.version_no = 2 from public.ex_exams e join public.ex_exam_versions v on v.id = e.published_version_id where e.id = pg_temp.idof('C')) $q$);
select pg_temp.expect_error('P: cannot edit course settings (0 rows or denied)',
  $q$ do $d$ begin update public.ex_course_settings set publish_requires_approval = true;
      if not found then raise exception 'no rows'; end if; end $d$ $q$);

-- W still cannot publish directly (no exam.publish)
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000f2","role":"authenticated"}', true);
set local role authenticated;
select pg_temp.expect_true('W: still routed to approval even when the course allows direct publish',
  $q$ not pg_temp.direct('capm') $q$);

-- ================================================================== R (exam.publish only)
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000f4","role":"authenticated"}', true);
set local role authenticated;
select pg_temp.expect_count('R: reads capm exams (exam.publish implies read)', $q$ select id from public.ex_exams where id in (pg_temp.idof('A'), pg_temp.idof('C')) $q$, 2);
select pg_temp.expect_state('R: cannot edit (no exam.write)', $q$ select public.exam_save(jsonb_build_object('exam_id', pg_temp.idof('V'), 'title_ar', 'x')) $q$, '42501');
select pg_temp.expect_true('R: CAN pause C', $q$ (select public.exam_pause(pg_temp.idof('C'), 'incident') ->> 'status' = 'paused') $q$);
select pg_temp.expect_state('freeze: paused C composition cannot change either (save 42501 for R)', $q$ select public.exam_save(jsonb_build_object('exam_id', pg_temp.idof('C'), 'title_ar', 'x')) $q$, '42501');
select pg_temp.expect_true('R: CAN resume C (direct publisher) => same version 2',
  $q$ (select r ->> 'status' = 'published' and (r ->> 'version_no')::int = 2 from (select public.exam_resume(pg_temp.idof('C')) r) s) $q$);
select pg_temp.expect_state('R: cannot archive (needs exam.write)', $q$ select public.exam_archive(pg_temp.idof('C')) $q$, '42501');
select pg_temp.expect_state('R: cannot request approval (needs exam.write)', $q$ select public.exam_request_approval(pg_temp.idof('V')) $q$, '42501');

-- ================================================================== freeze of published A (W)
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000f2","role":"authenticated"}', true);
set local role authenticated;
select pg_temp.expect_state('freeze: W cannot edit published A (55000)', $q$ select public.exam_save(jsonb_build_object('exam_id', pg_temp.idof('A'), 'title_ar', 'x')) $q$, '55000');
select pg_temp.expect_affected('W: cannot delete published A (policy: drafts only, 0 rows)', $q$ delete from public.ex_exams where id = pg_temp.idof('A') $q$, 0);
select pg_temp.expect_true('W: CAN pause A', $q$ (select public.exam_pause(pg_temp.idof('A')) ->> 'status' = 'paused') $q$);
select pg_temp.expect_state('W: cannot resume A (approval course setting ignored: W lacks exam.publish)', $q$ select public.exam_resume(pg_temp.idof('A')) $q$, '42501');
select pg_temp.expect_true('W: CAN unpublish A => draft, last version kept', $q$ (select public.exam_unpublish(pg_temp.idof('A')) ->> 'status' = 'draft') $q$);
select pg_temp.expect_ok('W: edits draft A (title)', $q$ select public.exam_save(jsonb_build_object('exam_id', pg_temp.idof('A'), 'title_ar', 'محاكاة A v2')) $q$);
select pg_temp.expect_true('W: archive then unarchive A', $q$ (select public.exam_archive(pg_temp.idof('A')) ->> 'status' = 'archived')
      and (select public.exam_unarchive(pg_temp.idof('A')) ->> 'status' = 'draft') $q$);
select pg_temp.expect_error('W: draft A with versions cannot be deleted (FK keeps history)', $q$ delete from public.ex_exams where id = pg_temp.idof('A') $q$);
select pg_temp.expect_ok('W: request approval of A v2', $q$ select public.exam_request_approval(pg_temp.idof('A')) $q$);

reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000f7","role":"authenticated"}', true);
set local role authenticated;
select pg_temp.expect_true('admin approves A v2 => version 2',
  $q$ (select (public.exam_approve(pg_temp.idof('A')) ->> 'version_no')::int = 2) $q$);
select pg_temp.expect_true('version 1 snapshot keeps the old title, version 2 has the new one',
  $q$ (select settings ->> 'title_ar' = 'محاكاة A' from public.ex_exam_versions where exam_id = pg_temp.idof('A') and version_no = 1)
      and (select settings ->> 'title_ar' = 'محاكاة A v2' from public.ex_exam_versions where exam_id = pg_temp.idof('A') and version_no = 2) $q$);
select pg_temp.expect_true('A v2 pins q1 version 2 (current at publish) with override points 3; total 12',
  $q$ (select vi.question_version_id <> pg_temp.idof('q1_v1') and vi.points = 3
       from public.ex_exam_version_items vi join public.ex_exams e on e.published_version_id = vi.exam_version_id
       where e.id = pg_temp.idof('A') and vi.question_id = pg_temp.idof('q1'))
      and (select total_score = 12 from public.ex_exams where id = pg_temp.idof('A')) $q$);
select pg_temp.expect_ok('admin: rejects B', $q$ select public.exam_reject(pg_temp.idof('B'), 'q6 retired') $q$);
select pg_temp.expect_true('admin: reads every exam / version of capm', $q$ (select count(*) >= 3 from public.ex_exam_versions) $q$);

-- ================================================================== X (pmp staff) / N (bank only) / T (trainee)
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000f5","role":"authenticated"}', true);
set local role authenticated;
select pg_temp.expect_hidden('X: capm exams hidden',         $q$ select * from public.ex_exams where course_id = 'capm' $q$);
select pg_temp.expect_hidden('X: capm items/rules hidden',   $q$ select exam_id from public.ex_exam_items union all select exam_id from public.ex_exam_rules $q$);
select pg_temp.expect_hidden('X: capm versions/pool hidden', $q$ select exam_version_id from public.ex_exam_version_items union all select exam_version_id from public.ex_exam_version_pool $q$);
select pg_temp.expect_hidden('X: capm settings row hidden',  $q$ select * from public.ex_course_settings $q$);
select pg_temp.expect_state('X: cannot preview capm',        $q$ select public.exam_preview_pool(jsonb_build_object('exam_id', pg_temp.idof('A'))) $q$, '42501');
select pg_temp.expect_state('X: cannot edit capm exam',      $q$ select public.exam_save(jsonb_build_object('exam_id', pg_temp.idof('V'), 'title_ar', 'x')) $q$, '42501');
select pg_temp.expect_state('X: cannot pause capm exam',     $q$ select public.exam_pause(pg_temp.idof('A')) $q$, '42501');
select pg_temp.expect_state('X: cannot publish capm exam',   $q$ select public.exam_publish(pg_temp.idof('V')) $q$, '42501');
select pg_temp.expect_affected('X: cannot delete capm draft (0 rows)', $q$ delete from public.ex_exams where id = pg_temp.idof('V') $q$, 0);
select pg_temp.expect_ok('X: CAN create a pmp exam', $q$ select public.exam_save('{"course_id":"pmp","folder_kind":"domain_tests","exam_kind":"practice","title_ar":"pmp"}') $q$);
select pg_temp.expect_state('X: pmp exam cannot pick a capm question (23503)',
  $q$ select public.exam_save(jsonb_build_object('course_id', 'pmp', 'folder_kind', 'domain_tests', 'exam_kind', 'practice', 'title_ar', 'x',
        'items', jsonb_build_array(jsonb_build_object('question_id', pg_temp.idof('q2'))))) $q$, '23503');

reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000f6","role":"authenticated"}', true);
set local role authenticated;
select pg_temp.expect_hidden('N (qbank only): exams hidden', 'select * from public.ex_exams');
select pg_temp.expect_state('N: exam_save forbidden', $q$ select public.exam_save('{"course_id":"capm","folder_kind":"domain_tests","exam_kind":"practice","title_ar":"x"}') $q$, '42501');
select pg_temp.expect_state('N: preview forbidden', $q$ select public.exam_preview_pool('{"course_id":"capm","rules":[]}') $q$, '42501');

reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000f1","role":"authenticated"}', true);
set local role authenticated;
select pg_temp.expect_true('T: enrolled in capm (sanity) but no exam permission', $q$ private.has_course_access('capm') and not private.ex_can_read('capm') $q$);
select pg_temp.expect_hidden('T: ex_exams hidden (published A included)', 'select * from public.ex_exams');
select pg_temp.expect_hidden('T: items/rules hidden',  $q$ select exam_id from public.ex_exam_items union all select exam_id from public.ex_exam_rules $q$);
select pg_temp.expect_hidden('T: versions hidden',     'select * from public.ex_exam_versions');
select pg_temp.expect_hidden('T: version items/rules/pool hidden',
  $q$ select exam_version_id from public.ex_exam_version_items union all select exam_version_id from public.ex_exam_version_rules
      union all select exam_version_id from public.ex_exam_version_pool $q$);
select pg_temp.expect_hidden('T: course settings hidden', 'select * from public.ex_course_settings');
select pg_temp.expect_state('T: exam_save forbidden', $q$ select public.exam_save('{"course_id":"capm","folder_kind":"domain_tests","exam_kind":"practice","title_ar":"x"}') $q$, '42501');
select pg_temp.expect_state('T: preview forbidden (exam mode)', $q$ select public.exam_preview_pool(jsonb_build_object('exam_id', pg_temp.idof('A'))) $q$, '42501');
select pg_temp.expect_state('T: preview forbidden (builder mode)', $q$ select public.exam_preview_pool('{"course_id":"capm","rules":[{"count":1}]}') $q$, '42501');
select pg_temp.expect_state('T: publish/pause/approve forbidden',
  $q$ select public.exam_pause(pg_temp.idof('A')) $q$, '42501');
select pg_temp.expect_state('T: approve forbidden', $q$ select public.exam_approve(pg_temp.idof('B')) $q$, '42501');
select pg_temp.expect_affected('T: cannot delete exams (0 rows)', 'delete from public.ex_exams', 0);
select pg_temp.expect_error('T: cannot write course settings', $q$ insert into public.ex_course_settings (course_id) values ('pmp') $q$);

-- ================================================================== PRIVILEGED (postgres): triggers hold without grants
reset role;
select set_config('request.jwt.claims', '', true);
select pg_temp.expect_raise('trigger (postgres): published A content cannot be updated',
  $q$ update public.ex_exams set title_ar = 'x' where id = pg_temp.idof('A') $q$, '42501', 'exam is locked%');
select pg_temp.expect_raise('trigger (postgres): published A items cannot be added',
  $q$ insert into public.ex_exam_items (exam_id, course_id, position, question_id) values (pg_temp.idof('A'), 'capm', 50, pg_temp.idof('q3')) $q$,
  '42501', 'exam composition is locked%');
select pg_temp.expect_raise('trigger (postgres): published A rules cannot be deleted',
  $q$ delete from public.ex_exam_rules where exam_id = pg_temp.idof('A') $q$, '42501', 'exam composition is locked%');
select pg_temp.expect_raise('trigger (postgres): versions are immutable (UPDATE)',
  $q$ update public.ex_exam_versions set total_score = 1 where exam_id = pg_temp.idof('A') $q$, '42501', '%immutable%');
select pg_temp.expect_raise('trigger (postgres): versions are immutable (DELETE)',
  $q$ delete from public.ex_exam_versions where exam_id = pg_temp.idof('V') or exam_id = pg_temp.idof('A') $q$, '42501', '%immutable%');
select pg_temp.expect_raise('trigger (postgres): frozen pool is immutable',
  $q$ delete from public.ex_exam_version_pool $q$, '42501', '%immutable%');
select pg_temp.expect_raise('trigger (postgres): pinned version items are immutable',
  $q$ update public.ex_exam_version_items set points = 1000 $q$, '42501', '%immutable%');
select pg_temp.expect_raise('trigger (postgres): draft -> published without a frozen version rejected',
  $q$ update public.ex_exams set status = 'published' where id = pg_temp.idof('V') $q$, '55000', 'publishing requires a new frozen version%');
select pg_temp.expect_raise('trigger (postgres): illegal jump archived/draft -> paused rejected',
  $q$ update public.ex_exams set status = 'paused' where id = pg_temp.idof('V') $q$, '55000', 'invalid status transition%');
select pg_temp.expect_raise('trigger (postgres): version pointer of a published exam cannot be moved',
  $q$ update public.ex_exams set published_version_id = (select id from public.ex_exam_versions where exam_id = pg_temp.idof('A') and version_no = 1)
      where id = pg_temp.idof('A') $q$, '55000', 'published_version_id changes only%');
select pg_temp.expect_raise('trigger (postgres): a new exam cannot be inserted as published',
  $q$ insert into public.ex_exams (course_id, folder_kind, exam_kind, title_ar, status) values ('capm', 'domain_tests', 'practice', 'x', 'published') $q$,
  '42501', 'a new exam must start as a draft%');
select pg_temp.expect_raise('trigger (postgres): course_id of an exam cannot change',
  $q$ update public.ex_exams set course_id = 'pmp' where id = pg_temp.idof('V') $q$, '42501|23503', '%');
select pg_temp.expect_state('composite FK (postgres): capm exam item cannot reference a pmp question',
  $q$ insert into public.ex_exam_items (exam_id, course_id, position, question_id) values (pg_temp.idof('V'), 'capm', 1, pg_temp.idof('qB')) $q$, '23503');
select pg_temp.expect_state('composite FK (postgres): item row cannot claim another course than its exam',
  $q$ insert into public.ex_exam_items (exam_id, course_id, position, question_id) values (pg_temp.idof('V'), 'pmp', 1, pg_temp.idof('qB')) $q$, '23503');
select pg_temp.expect_state('composite FK (postgres): capm rule cannot use a pmp taxonomy node',
  $q$ insert into public.ex_exam_rules (exam_id, course_id, position, taxonomy_id, draw_count) values (pg_temp.idof('V'), 'capm', 1, pg_temp.idof('taxB'), 1) $q$, '23503');
select pg_temp.expect_state('composite FK (postgres): exam folder must exist for the course',
  $q$ insert into public.ex_exams (course_id, folder_kind, exam_kind, title_ar) values ('m3-nofolder', 'domain_tests', 'practice', 'x') $q$, '23503');
select pg_temp.expect_state('composite FK (postgres): pool row cannot pin a version of another question',
  $q$ insert into public.ex_exam_version_pool (exam_version_id, course_id, rule_no, question_id, question_version_id)
      select v.id, 'capm', 1, pg_temp.idof('q3'), pg_temp.idof('q1_v1') from public.ex_exam_versions v where v.exam_id = pg_temp.idof('C') and v.version_no = 1 $q$, '23503');
select pg_temp.expect_error('restrict: taxonomy node used by a published rule cannot be deleted',
  $q$ delete from public.qb_taxonomy where id = pg_temp.idof('D1') $q$);

-- W deletes a never-published draft (V) through REST
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000f2","role":"authenticated"}', true);
set local role authenticated;
select pg_temp.expect_affected('W: CAN delete never-published draft V (items/rules cascade)', $q$ delete from public.ex_exams where id = pg_temp.idof('V') $q$, 1);

-- rate limits (counters put at the limit for the current window)
reset role;
select set_config('request.jwt.claims', '', true);
insert into private.rl_counters (key, window_start, n)
select k || '00000000-0000-4000-8000-0000000000f2', to_timestamp(floor(extract(epoch from now()) / 60) * 60), m
from (values ('ex_save:', 60), ('ex_preview:', 60), ('ex_status:', 30)) v(k, m)
on conflict (key, window_start) do update set n = excluded.n;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000f2","role":"authenticated"}', true);
set local role authenticated;
select pg_temp.expect_state('rate limit: exam_save 61st call in a minute => P0001',
  $q$ select public.exam_save('{"course_id":"capm","folder_kind":"domain_tests","exam_kind":"practice","title_ar":"x"}') $q$, 'P0001');
select pg_temp.expect_state('rate limit: exam_preview_pool => P0001', $q$ select public.exam_preview_pool('{"course_id":"capm","rules":[]}') $q$, 'P0001');
select pg_temp.expect_state('rate limit: status transitions => P0001', $q$ select public.exam_pause(pg_temp.idof('A')) $q$, 'P0001');
select pg_temp.expect_true('rate limit: the rejected pause changed nothing', $q$ (select status = 'published' from public.ex_exams where id = pg_temp.idof('A')) $q$);

-- audit
reset role;
select set_config('request.jwt.claims', '', true);
select pg_temp.expect_true('audit: created / request_approval / withdraw / reject / approve / publish / pause / resume / unpublish / archive / unarchive / deleted logged',
  $q$ (select count(*) filter (where action = 'ex_exam.created') >= 5
          and count(*) filter (where action = 'ex_exam.request_approval') >= 4
          and count(*) filter (where action = 'ex_exam.withdraw') = 1
          and count(*) filter (where action = 'ex_exam.reject') = 2
          and count(*) filter (where action = 'ex_exam.approve') = 2
          and count(*) filter (where action = 'ex_exam.publish') = 2
          and count(*) filter (where action = 'ex_exam.pause') = 2
          and count(*) filter (where action = 'ex_exam.resume') = 1
          and count(*) filter (where action = 'ex_exam.unpublish') = 2
          and count(*) filter (where action = 'ex_exam.archive') = 1
          and count(*) filter (where action = 'ex_exam.unarchive') = 1
          and count(*) filter (where action = 'ex_exam.deleted') = 1
       from public.audit_log where entity = 'ex_exams') $q$);
select pg_temp.expect_true('audit: approve row carries actor, version and note; reject carries the reason',
  $q$ exists (select 1 from public.audit_log where action = 'ex_exam.approve' and actor_id = '00000000-0000-4000-8000-0000000000f7'
              and details ->> 'note' = 'ok' and details ->> 'published_version_id' is not null and details ->> 'new_status' = 'published')
      and exists (select 1 from public.audit_log where action = 'ex_exam.reject' and details ->> 'note' = 'fix pass rule') $q$);
select pg_temp.expect_true('audit: course setting change logged',
  $q$ exists (select 1 from public.audit_log where action = 'ex_course_settings.insert' and entity_id = 'capm'
              and details ->> 'new_publish_requires_approval' = 'false') $q$);

-- ------------------------------------------------------------------ report, then undo everything
reset role;
select n, case when pass then 'PASS' else 'FAIL' end as result, test, detail from pg_temp.t_results
union all
select 100000, case when bool_and(pass) then 'ALL PASS' else 'FAILURES: ' || count(*) filter (where not pass) end,
       'SUMMARY (' || count(*) || ' tests)', null from pg_temp.t_results
order by 1;

rollback;
