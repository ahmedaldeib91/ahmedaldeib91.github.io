-- 003_functions_triggers
-- Helper functions (private schema, not exposed by the REST API), triggers, admin_stats().
-- Every function: SET search_path = '' and fully-qualified names.
-- SECURITY DEFINER only where the function must read/write rows the caller cannot.

create schema if not exists private;
revoke all on schema private from public;
revoke all on schema private from anon, authenticated;
-- authenticated needs USAGE only to evaluate RLS policies that call private.is_admin()/has_course_access()
grant usage on schema private to authenticated;

-- secret salt for hashing contact-form IPs (generated in the database, never in files)
create table if not exists private.app_secrets (
  key    text primary key,
  value  text not null
);
alter table private.app_secrets enable row level security;
alter table private.app_secrets force row level security;
revoke all on table private.app_secrets from public, anon, authenticated;
insert into private.app_secrets (key, value)
values ('ip_hash_salt', encode(extensions.gen_random_bytes(32), 'hex'))
on conflict (key) do nothing;

-- ================================================================ role helpers
-- is_admin(): role read from public.profiles for auth.uid(); never from JWT user_metadata.
create or replace function private.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = (select auth.uid())
      and p.role = 'admin'
      and p.status = 'active'
  );
$$;

-- has_course_access(course_id): active enrollment AND active profile AND published course.
create or replace function private.has_course_access(p_course_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.enrollments e
    join public.profiles   p on p.id = e.user_id
    join public.courses    c on c.id = e.course_id
    where e.user_id   = (select auth.uid())
      and e.course_id = p_course_id
      and e.status    = 'active'
      and p.status    = 'active'
      and c.published
  );
$$;

-- ================================================================ generic updated_at
create or replace function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger courses_set_updated_at        before update on public.courses        for each row execute function private.set_updated_at();
create trigger course_items_set_updated_at   before update on public.course_items   for each row execute function private.set_updated_at();
create trigger quiz_questions_set_updated_at before update on public.quiz_questions for each row execute function private.set_updated_at();

-- trainer_notes / site_settings: also stamp who changed them
create or replace function private.stamp_updated_by()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  new.updated_by := coalesce((select auth.uid()), new.updated_by);
  return new;
end;
$$;
create trigger trainer_notes_stamp before insert or update on public.trainer_notes for each row execute function private.stamp_updated_by();
create trigger site_settings_stamp before insert or update on public.site_settings for each row execute function private.stamp_updated_by();

-- ================================================================ signup -> profile
-- Always creates the profile as 'trainee' / 'active'. raw_user_meta_data is used ONLY for
-- full_name / phone / country; any "role" key in it is ignored.
create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  m jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
begin
  insert into public.profiles (id, full_name, phone, country, role, status)
  values (
    new.id,
    left(btrim(coalesce(m ->> 'full_name', '')), 120),
    nullif(left(btrim(coalesce(m ->> 'phone', '')), 40), ''),
    nullif(left(btrim(coalesce(m ->> 'country', '')), 80), ''),
    'trainee',
    'active'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- ================================================================ profiles guard
-- API roles (anon/authenticated):
--   * nobody can INSERT a profile (only the signup trigger does);
--   * nobody can change id / role / created_at (role is granted in the SQL editor only);
--   * only an admin can change status, and never his own.
-- Privileged DB roles (postgres / SQL editor / service_role) are not restricted.
create or replace function private.profiles_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      raise exception 'profiles are created by the signup trigger only' using errcode = '42501';
    end if;
    if new.id is distinct from old.id
       or new.role is distinct from old.role
       or new.created_at is distinct from old.created_at then
      raise exception 'id, role and created_at cannot be changed from the API' using errcode = '42501';
    end if;
    if new.status is distinct from old.status then
      if not private.is_admin() then
        raise exception 'only an admin can change status' using errcode = '42501';
      end if;
      if old.id = (select auth.uid()) then
        raise exception 'an admin cannot change his own status' using errcode = '42501';
      end if;
    end if;
  end if;
  if tg_op = 'UPDATE' then
    new.updated_at := now();
  end if;
  return new;
end;
$$;

create trigger profiles_guard
  before insert or update on public.profiles
  for each row execute function private.profiles_guard();

-- ================================================================ enrollments
create or replace function private.enrollments_before()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.granted_by := coalesce((select auth.uid()), new.granted_by);
    new.granted_at := now();
    new.created_at := now();
    new.revoked_at := case when new.status = 'revoked' then now() else null end;
  else
    if new.user_id is distinct from old.user_id or new.course_id is distinct from old.course_id then
      raise exception 'user_id and course_id of an enrollment cannot change' using errcode = '42501';
    end if;
    if new.status is distinct from old.status then
      if new.status = 'revoked' then
        new.revoked_at := now();
      else
        new.revoked_at := null;
        new.granted_at := now();
        new.granted_by := coalesce((select auth.uid()), new.granted_by);
      end if;
    end if;
    new.updated_at := now();
  end if;
  return new;
end;
$$;

create trigger enrollments_before
  before insert or update on public.enrollments
  for each row execute function private.enrollments_before();

-- ================================================================ posts
create or replace function private.posts_before()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.author_id  := coalesce(new.author_id, (select auth.uid()));
    new.created_at := now();
  end if;
  if new.published and new.published_at is null then
    new.published_at := now();
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger posts_before
  before insert or update on public.posts
  for each row execute function private.posts_before();

-- ================================================================ quiz grading
-- Grades the attempt server-side from answers=[{"q":uuid,"a":int}], overwriting any
-- client-supplied score/total. SECURITY DEFINER so it can read correct_index; it only
-- reads published questions of the attempt's own course. Access itself is enforced by RLS.
create or replace function private.quiz_attempts_grade()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_total     integer;
  v_score     integer;
  v_unknown   integer;
  v_distinct  integer;
begin
  if jsonb_typeof(new.answers) <> 'array' or jsonb_array_length(new.answers) = 0 then
    raise exception 'answers must be a non-empty array' using errcode = '22023';
  end if;

  select count(*),
         count(*) filter (where q.id is not null and q.correct_index = (a ->> 'a')::integer),
         count(*) filter (where q.id is null),
         count(distinct a ->> 'q')
    into v_total, v_score, v_unknown, v_distinct
  from jsonb_array_elements(new.answers) as a
  left join public.quiz_questions q
         on q.id = (a ->> 'q')::uuid
        and q.course_id = new.course_id
        and q.published;

  if v_unknown > 0 then
    raise exception 'answers reference unknown questions for this course' using errcode = '22023';
  end if;
  if v_distinct <> v_total then
    raise exception 'duplicate questions in answers' using errcode = '22023';
  end if;

  new.total      := v_total;
  new.score      := v_score;
  new.created_at := now();
  return new;
end;
$$;

create trigger quiz_attempts_grade
  before insert on public.quiz_attempts
  for each row execute function private.quiz_attempts_grade();

-- ================================================================ contact form
-- Rate limit + IP hashing. SECURITY DEFINER: must count all messages (anon cannot read them)
-- and read the private salt. Client values for ip_hash/status/created_at are always overwritten.
create or replace function private.contact_messages_before()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_headers  jsonb;
  v_ip       text;
  v_salt     text;
  v_hash     text;
  v_count    integer;
begin
  begin
    v_headers := nullif(current_setting('request.headers', true), '')::jsonb;
  exception when others then
    v_headers := null;
  end;

  v_ip := coalesce(
    nullif(btrim(v_headers ->> 'cf-connecting-ip'), ''),
    nullif(btrim(split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1)), ''),
    nullif(btrim(v_headers ->> 'x-real-ip'), ''),
    'unknown'
  );

  select s.value into v_salt from private.app_secrets s where s.key = 'ip_hash_salt';
  v_hash := encode(sha256(convert_to(coalesce(v_salt, '') || '|' || v_ip, 'UTF8')), 'hex');

  -- serialize concurrent inserts from the same IP so the count cannot be raced
  perform pg_advisory_xact_lock(hashtextextended('contact_messages:' || v_hash, 0));

  select count(*) into v_count
  from public.contact_messages m
  where m.ip_hash = v_hash
    and m.created_at > now() - interval '1 hour';
  if v_count >= 5 then
    raise exception 'rate_limited: too many messages from this address, try again later'
      using errcode = 'P0001';
  end if;

  -- global safety cap against distributed spam
  select count(*) into v_count
  from public.contact_messages m
  where m.created_at > now() - interval '1 hour';
  if v_count >= 200 then
    raise exception 'rate_limited: contact form temporarily unavailable' using errcode = 'P0001';
  end if;

  new.name       := btrim(new.name);
  new.email      := lower(btrim(new.email));
  new.phone      := nullif(btrim(coalesce(new.phone, '')), '');
  new.subject    := nullif(btrim(coalesce(new.subject, '')), '');
  new.ip_hash    := v_hash;
  new.status     := 'new';
  new.created_at := now();
  return new;
end;
$$;

create trigger contact_messages_before
  before insert on public.contact_messages
  for each row execute function private.contact_messages_before();

-- ================================================================ audit
create or replace function private.audit_enrollments()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_action text;
begin
  if tg_op = 'INSERT' then
    v_action := 'enrollment.granted';
  elsif tg_op = 'DELETE' then
    v_action := 'enrollment.deleted';
  elsif new.status is distinct from old.status then
    v_action := case when new.status = 'revoked' then 'enrollment.revoked' else 'enrollment.reactivated' end;
  else
    v_action := 'enrollment.updated';
  end if;

  insert into public.audit_log (actor_id, action, entity, entity_id, details)
  values (
    (select auth.uid()),
    v_action,
    'enrollments',
    coalesce(new.id, old.id)::text,
    jsonb_build_object(
      'user_id',    coalesce(new.user_id, old.user_id),
      'course_id',  coalesce(new.course_id, old.course_id),
      'old_status', old.status,
      'new_status', new.status
    )
  );
  return null;
end;
$$;

create trigger enrollments_audit
  after insert or update or delete on public.enrollments
  for each row execute function private.audit_enrollments();

create or replace function private.audit_profiles()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status is distinct from old.status then
    insert into public.audit_log (actor_id, action, entity, entity_id, details)
    values ((select auth.uid()), 'profile.status_changed', 'profiles', new.id::text,
            jsonb_build_object('old_status', old.status, 'new_status', new.status));
  end if;
  if new.role is distinct from old.role then
    insert into public.audit_log (actor_id, action, entity, entity_id, details)
    values ((select auth.uid()), 'profile.role_changed', 'profiles', new.id::text,
            jsonb_build_object('old_role', old.role, 'new_role', new.role));
  end if;
  return null;
end;
$$;

create trigger profiles_audit
  after update on public.profiles
  for each row
  when (old.status is distinct from new.status or old.role is distinct from new.role)
  execute function private.audit_profiles();

-- ================================================================ admin_stats
-- SECURITY INVOKER: an admin already sees everything through RLS; non-admins are rejected.
create or replace function public.admin_stats()
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v jsonb;
begin
  if not private.is_admin() then
    raise exception 'forbidden: admin only' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'generated_at',             now(),
    'trainees_total',           (select count(*) from public.profiles where role = 'trainee'),
    'trainees_new_7d',          (select count(*) from public.profiles where role = 'trainee' and created_at >= now() - interval '7 days'),
    'trainees_new_30d',         (select count(*) from public.profiles where role = 'trainee' and created_at >= now() - interval '30 days'),
    'trainees_active',          (select count(*) from public.profiles where role = 'trainee' and status = 'active'),
    'trainees_seen_30d',        (select count(*) from public.profiles where role = 'trainee' and last_seen_at >= now() - interval '30 days'),
    'trainees_suspended',       (select count(*) from public.profiles where role = 'trainee' and status = 'suspended'),
    'enrollments_active_total', (select count(*) from public.enrollments where status = 'active'),
    'enrollments_per_course',   (
      select coalesce(jsonb_agg(jsonb_build_object(
               'course_id', c.id, 'title_ar', c.title_ar,
               'active',  (select count(*) from public.enrollments e where e.course_id = c.id and e.status = 'active'),
               'revoked', (select count(*) from public.enrollments e where e.course_id = c.id and e.status = 'revoked')
             ) order by c.sort), '[]'::jsonb)
      from public.courses c),
    'quiz_attempts_total',      (select count(*) from public.quiz_attempts),
    'quiz_per_course',          (
      select coalesce(jsonb_agg(jsonb_build_object(
               'course_id', c.id,
               'attempts',  (select count(*) from public.quiz_attempts a where a.course_id = c.id),
               'avg_percent', (select round(avg(a.score * 100.0 / nullif(a.total, 0)), 1)
                               from public.quiz_attempts a where a.course_id = c.id)
             ) order by c.sort), '[]'::jsonb)
      from public.courses c),
    'messages_unread',          (select count(*) from public.contact_messages where status = 'new'),
    'posts_published',          (select count(*) from public.posts where published),
    'top_courses',              (
      select coalesce(jsonb_agg(t order by t.active desc, t.sort), '[]'::jsonb)
      from (
        select c.id as course_id, c.title_ar, c.sort, count(e.id) as active
        from public.courses c
        join public.enrollments e on e.course_id = c.id and e.status = 'active'
        group by c.id, c.title_ar, c.sort
        order by count(e.id) desc, c.sort
        limit 5
      ) t)
  ) into v;

  return v;
end;
$$;

-- ================================================================ EXECUTE privileges
-- Default: functions are executable by PUBLIC. Revoke everything, then grant the minimum.
revoke execute on function private.is_admin()                  from public, anon, authenticated;
revoke execute on function private.has_course_access(text)     from public, anon, authenticated;
revoke execute on function private.set_updated_at()            from public, anon, authenticated;
revoke execute on function private.stamp_updated_by()          from public, anon, authenticated;
revoke execute on function private.handle_new_user()           from public, anon, authenticated;
revoke execute on function private.profiles_guard()            from public, anon, authenticated;
revoke execute on function private.enrollments_before()        from public, anon, authenticated;
revoke execute on function private.posts_before()              from public, anon, authenticated;
revoke execute on function private.quiz_attempts_grade()       from public, anon, authenticated;
revoke execute on function private.contact_messages_before()   from public, anon, authenticated;
revoke execute on function private.audit_enrollments()         from public, anon, authenticated;
revoke execute on function private.audit_profiles()            from public, anon, authenticated;
revoke execute on function public.admin_stats()                from public, anon, authenticated;

-- needed by RLS policies (evaluated as the signed-in user) and by admin_stats
grant execute on function private.is_admin()              to authenticated;
grant execute on function private.has_course_access(text) to authenticated;
grant execute on function public.admin_stats()            to authenticated;
