-- 009_exams_foundation  (Exams system, milestone M1 part 1/2)  -- NOT APPLIED to any database yet.
-- Design spec: docs/exams/01-analysis-and-plan.md (sections 3.1, 4.1, 4.8). Docs: docs/exams/02-M1-database.md.
--
-- ADDITIVE ONLY. Nothing in 001..008 is altered or dropped. The only object attached to an existing
-- table is a new AFTER INSERT trigger on public.courses (creates the 5 exam folders of a new course;
-- it does not change any column, policy or existing trigger of courses).
--
-- Contents
--   1. public.course_staff          instructor model (owner decision D1: NO new profiles.role value)
--   2. private.is_course_staff / private.has_staff_perm / private.is_any_course_staff  (admin override)
--   3. public.course_folders        5 fixed logical folders per course, trigger on courses + idempotent backfill
--   4. private.rl_counters + private.rl_hit()   generic fixed-window rate limiter (advisory-lock pattern of 003/008)
--   5. public.ex_security_events    exam security / anomaly log + private.log_security_event()
--   6. audit_log hooks for course_staff
--   7. grants + RLS policies (default deny; anon gets nothing on any new table)
--
-- Conventions (same as 003/004): SET search_path = '' and fully-qualified names in every function,
-- SECURITY DEFINER only where needed, EXECUTE revoked from public/anon/authenticated then granted minimally,
-- (select ...) wrappers in policies, one permissive policy per (role, command).

-- ================================================================ 1. course_staff
-- An "instructor" = a user with an ACTIVE row here for a given course. Writing this table is admin-only.
-- permissions: JSON object of boolean flags, keys limited to private.staff_permission_keys().
-- FK actions: cascade on course delete/rename, so an existing course without content can still be
-- deleted/renamed exactly as before this migration.
create table public.course_staff (
  course_id    text not null references public.courses (id) on update cascade on delete cascade,
  user_id      uuid not null references public.profiles (id) on delete cascade,
  staff_role   text not null default 'instructor' check (staff_role in ('instructor')),
  permissions  jsonb not null default '{}'::jsonb
               check (jsonb_typeof(permissions) = 'object' and octet_length(permissions::text) <= 2000),
  active       boolean not null default true,
  granted_by   uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint course_staff_pkey primary key (course_id, user_id)
);
create index course_staff_user_idx       on public.course_staff (user_id);
create index course_staff_granted_by_idx on public.course_staff (granted_by);

-- ================================================================ 3. course_folders (table first; functions below)
-- Logical containers (UI categories + key for future ex_exams.folder_kind). NOT storage folders.
-- Cascade on course delete/rename for the same backward-compatibility reason as course_staff.
create table public.course_folders (
  id          uuid primary key default gen_random_uuid(),
  course_id   text not null references public.courses (id) on update cascade on delete cascade,
  kind        text not null check (kind in ('question_bank', 'domain_tests', 'exam_simulations',
                                            'mistakes_quiz', 'results_analytics')),
  title_ar    text not null check (char_length(btrim(title_ar)) between 1 and 200),
  title_en    text not null check (char_length(btrim(title_en)) between 1 and 200),
  sort        integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint course_folders_course_kind_key unique (course_id, kind),
  constraint course_folders_course_id_id_key unique (course_id, id)
);

-- ================================================================ 4. rate-limit counters (private, not exposed)
create table private.rl_counters (
  key           text not null check (char_length(key) between 1 and 200),
  window_start  timestamptz not null,
  n             integer not null default 0 check (n >= 0),
  constraint rl_counters_pkey primary key (key, window_start)
);
create index rl_counters_window_idx on private.rl_counters (window_start);

-- ================================================================ 5. ex_security_events
-- attempt_id has no FK yet: ex_attempts arrives in M4 (the FK is added there).
create table public.ex_security_events (
  id          bigint generated always as identity primary key,
  attempt_id  uuid,
  user_id     uuid references public.profiles (id) on delete set null,
  course_id   text not null references public.courses (id) on update cascade on delete restrict,
  kind        text not null check (kind in ('visibility_hidden', 'blur', 'fullscreen_exit', 'copy_attempt',
                                            'devtools_heuristic', 'multi_session', 'rate_limited',
                                            'fetch_too_fast', 'out_of_window', 'token_mismatch',
                                            'reattempt_spam', 'other')),
  severity    text not null default 'info' check (severity in ('info', 'low', 'medium', 'high', 'critical')),
  details     jsonb not null default '{}'::jsonb
              check (jsonb_typeof(details) = 'object' and octet_length(details::text) <= 4000),
  client_ts   timestamptz,
  created_at  timestamptz not null default now()
);
create index ex_security_events_course_created_idx  on public.ex_security_events (course_id, created_at desc);
create index ex_security_events_user_created_idx    on public.ex_security_events (user_id, created_at desc);
create index ex_security_events_attempt_idx         on public.ex_security_events (attempt_id);

-- lock down immediately (Supabase default privileges grant ALL on new public tables/sequences)
do $$
declare t text;
begin
  foreach t in array array['course_staff', 'course_folders', 'ex_security_events'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
  end loop;
end $$;
alter table private.rl_counters enable row level security;
alter table private.rl_counters force row level security;
revoke all on table private.rl_counters from public, anon, authenticated;
revoke all on sequence public.ex_security_events_id_seq from public, anon, authenticated;

-- ================================================================ 2. staff helpers
create or replace function private.staff_permission_keys()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['qbank.read', 'qbank.write', 'qbank.import', 'exam.write', 'exam.publish',
               'grading', 'analytics.read', 'security.read']::text[];
$$;

-- is_course_staff(course): caller has an ACTIVE staff row for the course AND an active profile.
-- (Admins are not "staff"; use has_staff_perm() for authorization, it includes the admin override.)
create or replace function private.is_course_staff(p_course_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.course_staff s
    join public.profiles     p on p.id = s.user_id
    where s.user_id   = (select auth.uid())
      and s.course_id = p_course_id
      and s.active
      and p.status    = 'active'
  );
$$;

-- has_staff_perm(course, perm): admin => true; else active staff row whose permissions[perm] = true.
-- 'qbank.write' implies 'qbank.read' (writing needs row visibility). Unknown perm => false (except admin).
create or replace function private.has_staff_perm(p_course_id text, p_perm text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_admin()
      or exists (
        select 1
        from public.course_staff s
        join public.profiles     p on p.id = s.user_id
        where s.user_id   = (select auth.uid())
          and s.course_id = p_course_id
          and s.active
          and p.status    = 'active'
          and (   s.permissions -> p_perm = 'true'::jsonb
               or (p_perm = 'qbank.read' and s.permissions -> 'qbank.write' = 'true'::jsonb))
      );
$$;

-- is_any_course_staff(): caller is an active instructor of at least one course (used for shared,
-- non-course-scoped staff data such as the question-type registry).
create or replace function private.is_any_course_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.course_staff s
    join public.profiles     p on p.id = s.user_id
    where s.user_id = (select auth.uid())
      and s.active
      and p.status  = 'active'
  );
$$;

-- course_staff guard: validates permissions, stamps granted_by/updated_at, keeps the key immutable.
create or replace function private.course_staff_before()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_bad text;
begin
  select k into v_bad
  from jsonb_each(new.permissions) as e(k, v)
  where not (k = any (private.staff_permission_keys())) or jsonb_typeof(v) <> 'boolean'
  limit 1;
  if v_bad is not null then
    raise exception 'invalid permission flag: % (allowed keys: %, values must be boolean)',
      v_bad, array_to_string(private.staff_permission_keys(), ', ') using errcode = '22023';
  end if;

  if tg_op = 'INSERT' then
    new.granted_by := coalesce((select auth.uid()), new.granted_by);
    new.created_at := now();
  else
    if new.course_id is distinct from old.course_id or new.user_id is distinct from old.user_id then
      -- a course rename arrives here through ON UPDATE CASCADE (pg_trigger_depth() > 1): allowed
      if pg_trigger_depth() <= 1 then
        raise exception 'course_id and user_id of a staff row cannot change' using errcode = '42501';
      end if;
    end if;
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger course_staff_before
  before insert or update on public.course_staff
  for each row execute function private.course_staff_before();

-- ================================================================ 6. audit hooks (course_staff)
create or replace function private.audit_course_staff()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_action text;
begin
  if tg_op = 'INSERT' then
    v_action := 'course_staff.granted';
  elsif tg_op = 'DELETE' then
    v_action := 'course_staff.deleted';
  elsif new.active is distinct from old.active then
    v_action := case when new.active then 'course_staff.reactivated' else 'course_staff.deactivated' end;
  else
    v_action := 'course_staff.updated';
  end if;

  insert into public.audit_log (actor_id, action, entity, entity_id, details)
  values (
    (select auth.uid()),
    v_action,
    'course_staff',
    coalesce(new.course_id, old.course_id) || ':' || coalesce(new.user_id, old.user_id)::text,
    jsonb_build_object(
      'course_id',       coalesce(new.course_id, old.course_id),
      'user_id',         coalesce(new.user_id, old.user_id),
      'old_permissions', old.permissions,
      'new_permissions', new.permissions,
      'old_active',      old.active,
      'new_active',      new.active
    )
  );
  return null;
end;
$$;

create trigger course_staff_audit
  after insert or update or delete on public.course_staff
  for each row execute function private.audit_course_staff();

-- ================================================================ 3b. folders: kinds, ensure, trigger, backfill
create or replace function private.course_folder_kinds()
returns table (kind text, title_ar text, title_en text, sort integer)
language sql
immutable
set search_path = ''
as $$
  values ('question_bank',     'بنك الأسئلة',          'Question Bank',        1),
         ('domain_tests',      'اختبارات المجالات',     'Domain Tests',         2),
         ('exam_simulations',  'محاكاة الاختبار',       'Exam Simulations',     3),
         ('mistakes_quiz',     'اختبار الأخطاء',        'Mistakes Quiz',        4),
         ('results_analytics', 'النتائج والتحليلات',    'Results & Analytics',  5);
$$;

-- ensure_course_folders(course or NULL = all courses): idempotent, returns the number of rows created.
-- SECURITY DEFINER: called from the courses trigger while the caller (admin via REST) has no
-- INSERT privilege on course_folders.
create or replace function private.ensure_course_folders(p_course_id text default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  insert into public.course_folders (course_id, kind, title_ar, title_en, sort)
  select c.id, k.kind, k.title_ar, k.title_en, k.sort
  from public.courses c
  cross join private.course_folder_kinds() k
  where p_course_id is null or c.id = p_course_id
  on conflict (course_id, kind) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

create or replace function private.courses_create_folders()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.ensure_course_folders(new.id);
  return null;
end;
$$;

create trigger courses_create_folders
  after insert on public.courses
  for each row execute function private.courses_create_folders();

create trigger course_folders_set_updated_at
  before update on public.course_folders
  for each row execute function private.set_updated_at();

-- backfill every existing course (6 live courses -> 30 rows). Safe to re-run.
select private.ensure_course_folders();

-- ================================================================ 4b. rate limiter
-- rl_hit(key, window_sec, max, raise): fixed window counter. Serialized per key by an advisory xact
-- lock (same pattern as 003/008). Increments, then:
--   * count <= max  -> returns the new count
--   * count >  max  -> p_raise: raise 'rate_limited' (P0001, the client already maps it);
--                      otherwise returns -1 and the increment is kept.
-- NOTE: when it raises, the caller's transaction (incl. this increment) is rolled back; the stored
-- count stays at max, so every further call in the window is still rejected.
-- Not granted to any API role: only SECURITY DEFINER RPCs call it.
create or replace function private.rl_hit(p_key text, p_window_sec integer, p_max integer,
                                          p_raise boolean default true)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_start timestamptz;
  v_n     integer;
begin
  if p_key is null or char_length(p_key) not between 1 and 200
     or p_window_sec is null or p_window_sec not between 1 and 86400
     or p_max is null or p_max < 1 then
    raise exception 'rl_hit: invalid arguments' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('rl:' || p_key, 0));

  v_start := to_timestamp(floor(extract(epoch from now()) / p_window_sec) * p_window_sec);
  insert into private.rl_counters as r (key, window_start, n)
  values (p_key, v_start, 1)
  on conflict (key, window_start) do update set n = r.n + 1
  returning r.n into v_n;

  if v_n > p_max then
    if p_raise then
      raise exception 'rate_limited: too many requests, try again later' using errcode = 'P0001';
    end if;
    return -1;
  end if;
  return v_n;
end;
$$;

-- housekeeping (to be scheduled by pg_cron in M4 if D11 is approved)
create or replace function private.rl_prune(p_older_than interval default interval '1 day')
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  delete from private.rl_counters where window_start < now() - p_older_than;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- ================================================================ 5b. security event writer (RPC-internal)
create or replace function private.log_security_event(p_course_id text, p_kind text,
                                                      p_severity text default 'info',
                                                      p_details jsonb default '{}'::jsonb,
                                                      p_attempt_id uuid default null,
                                                      p_client_ts timestamptz default null)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id bigint;
begin
  insert into public.ex_security_events (attempt_id, user_id, course_id, kind, severity, details, client_ts)
  values (p_attempt_id, (select auth.uid()), p_course_id, p_kind, coalesce(p_severity, 'info'),
          coalesce(p_details, '{}'::jsonb), p_client_ts)
  returning id into v_id;
  return v_id;
end;
$$;

-- ================================================================ 7. grants + RLS
-- course_staff: admin manages; an instructor reads ONLY his own rows (to know his permissions).
grant select, delete on public.course_staff to authenticated;
grant insert (course_id, user_id, staff_role, permissions, active) on public.course_staff to authenticated;
grant update (staff_role, permissions, active) on public.course_staff to authenticated;

create policy course_staff_select on public.course_staff
  for select to authenticated
  using (user_id = (select auth.uid()) or (select private.is_admin()));
create policy course_staff_insert_admin on public.course_staff
  for insert to authenticated with check ((select private.is_admin()));
create policy course_staff_update_admin on public.course_staff
  for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));
create policy course_staff_delete_admin on public.course_staff
  for delete to authenticated using ((select private.is_admin()));

-- course_folders: read = admin or staff of the course; rename/reorder = admin; created by trigger only;
-- removed only with the course (cascade). Trainee access is added later (M4/M5) if needed.
grant select on public.course_folders to authenticated;
grant update (title_ar, title_en, sort) on public.course_folders to authenticated;

create policy course_folders_select on public.course_folders
  for select to authenticated
  using ((select private.is_admin()) or private.is_course_staff(course_id));
create policy course_folders_update_admin on public.course_folders
  for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));

-- ex_security_events: read = admin or staff with security.read; written only by DEFINER RPCs.
grant select on public.ex_security_events to authenticated;

create policy ex_security_events_select on public.ex_security_events
  for select to authenticated
  using ((select private.is_admin()) or private.has_staff_perm(course_id, 'security.read'));

-- EXECUTE privileges
revoke execute on function private.staff_permission_keys()              from public, anon, authenticated;
revoke execute on function private.is_course_staff(text)                from public, anon, authenticated;
revoke execute on function private.has_staff_perm(text, text)           from public, anon, authenticated;
revoke execute on function private.is_any_course_staff()                from public, anon, authenticated;
revoke execute on function private.course_staff_before()                from public, anon, authenticated;
revoke execute on function private.audit_course_staff()                 from public, anon, authenticated;
revoke execute on function private.course_folder_kinds()                from public, anon, authenticated;
revoke execute on function private.ensure_course_folders(text)          from public, anon, authenticated;
revoke execute on function private.courses_create_folders()             from public, anon, authenticated;
revoke execute on function private.rl_hit(text, integer, integer, boolean) from public, anon, authenticated;
revoke execute on function private.rl_prune(interval)                   from public, anon, authenticated;
revoke execute on function private.log_security_event(text, text, text, jsonb, uuid, timestamptz)
                                                                        from public, anon, authenticated;
-- needed by RLS policies evaluated as the signed-in user
grant execute on function private.is_course_staff(text)      to authenticated;
grant execute on function private.has_staff_perm(text, text) to authenticated;
grant execute on function private.is_any_course_staff()      to authenticated;
-- course_staff_before() runs as the invoker (admin via REST) and calls this immutable helper
grant execute on function private.staff_permission_keys()    to authenticated;

-- ================================================================ ROLLBACK (commented out; see docs/exams/rollback-M1.sql)
-- Run 010's rollback first. Removes ONLY what this file created; 001..008 objects are untouched.
-- drop trigger if exists courses_create_folders on public.courses;
-- drop table if exists public.ex_security_events;
-- drop table if exists public.course_folders;
-- drop table if exists public.course_staff;
-- drop table if exists private.rl_counters;
-- drop function if exists private.log_security_event(text, text, text, jsonb, uuid, timestamptz);
-- drop function if exists private.rl_prune(interval);
-- drop function if exists private.rl_hit(text, integer, integer, boolean);
-- drop function if exists private.courses_create_folders();
-- drop function if exists private.ensure_course_folders(text);
-- drop function if exists private.course_folder_kinds();
-- drop function if exists private.audit_course_staff();
-- drop function if exists private.course_staff_before();
-- drop function if exists private.is_any_course_staff();
-- drop function if exists private.has_staff_perm(text, text);
-- drop function if exists private.is_course_staff(text);
-- drop function if exists private.staff_permission_keys();
-- (audit_log rows written by these triggers are kept on purpose.)
