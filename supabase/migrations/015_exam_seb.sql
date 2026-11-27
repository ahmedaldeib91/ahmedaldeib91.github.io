-- 015_exam_seb  (Exams system, M4c: optional Safe Exam Browser requirement per exam)
-- Requires 009..014. A staff member opens the exam config in SEB once, reads the SEB "proofs" (Config Key hash and/or
-- Browser Exam Key hash that SEB's JS API returns for the dashboard URL) on the /dashboard/#seb-info page and pastes them
-- into the exam's security settings (security.seb_keys). With security.require_seb = true the server refuses to START an
-- attempt or to SERVE questions (exam_get_items) unless the client sends a matching proof ({config_key, browser_exam_key}).
-- The proofs never reach trainees (they are stripped from the public settings). Limits: a proof is a shared secret
-- (a trainee inside SEB could pass it to another browser); it deters casual use of a normal browser and screenshot-free
-- lockdown comes from SEB itself. Additive: replaces 2 helper functions and 2 REST wrappers (same behavior + optional arg).

-- ---------------------------------------------------------------- security jsonb: + require_seb, seb_keys
create or replace function private.ex_security_ok(s jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
begin
  if s is null or jsonb_typeof(s) <> 'object' then
    return false;
  end if;
  if exists (select 1 from jsonb_object_keys(s) k
             where k not in ('monitoring', 'max_warnings', 'on_exceed', 'fullscreen_required', 'watermark', 'require_seb', 'seb_keys'))
     or jsonb_typeof(s -> 'monitoring') is distinct from 'boolean'
     or jsonb_typeof(s -> 'fullscreen_required') is distinct from 'boolean'
     or jsonb_typeof(s -> 'watermark') is distinct from 'boolean'
     or jsonb_typeof(s -> 'max_warnings') is distinct from 'number'
     or jsonb_typeof(s -> 'on_exceed') is distinct from 'string' then
    return false;
  end if;
  if (s ->> 'max_warnings')::numeric not between 0 and 50
     or (s ->> 'max_warnings')::numeric <> trunc((s ->> 'max_warnings')::numeric)
     or (s ->> 'on_exceed') not in ('log', 'warn', 'flag', 'auto_submit') then
    return false;
  end if;
  if not (s ->> 'monitoring')::boolean
     and ((s ->> 'fullscreen_required')::boolean or (s ->> 'on_exceed') <> 'log') then
    return false;
  end if;
  if s ? 'require_seb' and jsonb_typeof(s -> 'require_seb') is distinct from 'boolean' then
    return false;
  end if;
  if s ? 'seb_keys' then
    if jsonb_typeof(s -> 'seb_keys') is distinct from 'array' or jsonb_array_length(s -> 'seb_keys') > 10
       or exists (select 1 from jsonb_array_elements(s -> 'seb_keys') e
                  where jsonb_typeof(e) <> 'string' or (e #>> '{}') !~ '^[0-9a-f]{64}$') then
      return false;
    end if;
  end if;
  if coalesce((s ->> 'require_seb')::boolean, false)
     and (jsonb_typeof(s -> 'seb_keys') is distinct from 'array' or jsonb_array_length(s -> 'seb_keys') = 0) then
    return false;
  end if;
  return true;
end;
$$;

-- the trainee-facing settings never carry the proofs
create or replace function private.ex_public_settings(s jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object('allow_back', coalesce((s ->> 'allow_back')::boolean, true),
                            'allow_flag', coalesce((s ->> 'allow_flag')::boolean, true),
                            'allow_whiteboard', coalesce((s ->> 'allow_whiteboard')::boolean, false),
                            'allow_calculator', coalesce((s ->> 'allow_calculator')::boolean, false),
                            'allow_translation', coalesce((s ->> 'allow_translation')::boolean, false),
                            'title_ar', s ->> 'title_ar', 'exam_kind', s ->> 'exam_kind', 'security', (s -> 'security') - 'seb_keys');
$$;

-- the list tells the trainee whether the exam needs SEB (a boolean only)
create or replace function private.exam_list_available()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null or not exists (select 1 from public.profiles p where p.id = v_uid and p.status = 'active') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(q.rj order by (q.rj ->> 'close_at') nulls last, q.rj ->> 'title_ar')
    from (
      select jsonb_build_object(
               'exam_id', e.id, 'course_id', e.course_id, 'title_ar', e.title_ar, 'exam_kind', e.exam_kind,
               'duration_minutes', v.settings -> 'duration_minutes', 'question_count', v.question_count, 'total_score', v.total_score,
               'open_at', v.settings -> 'open_at', 'close_at', v.settings -> 'close_at', 'max_attempts', v.settings -> 'max_attempts',
               'require_seb', coalesce((v.settings -> 'security' ->> 'require_seb')::boolean, false),
               'attempts_used', (select count(*) from public.ex_attempts a where a.exam_id = e.id and a.user_id = v_uid and a.status <> 'in_progress'),
               'in_progress', (select a.id from public.ex_attempts a where a.exam_id = e.id and a.user_id = v_uid and a.status = 'in_progress'),
               'can_start', (
                   (nullif(v.settings ->> 'open_at', '') is null or now() >= (v.settings ->> 'open_at')::timestamptz)
                   and (nullif(v.settings ->> 'close_at', '') is null or now() < (v.settings ->> 'close_at')::timestamptz)
                   and (nullif(v.settings ->> 'max_attempts', '') is null
                        or (select count(*) from public.ex_attempts a where a.exam_id = e.id and a.user_id = v_uid and a.status <> 'in_progress') < (v.settings ->> 'max_attempts')::integer)),
               'reason', case
                   when nullif(v.settings ->> 'open_at', '') is not null and now() < (v.settings ->> 'open_at')::timestamptz then 'not_open_yet'
                   when nullif(v.settings ->> 'close_at', '') is not null and now() >= (v.settings ->> 'close_at')::timestamptz then 'closed'
                   when nullif(v.settings ->> 'max_attempts', '') is not null
                        and (select count(*) from public.ex_attempts a where a.exam_id = e.id and a.user_id = v_uid and a.status <> 'in_progress') >= (v.settings ->> 'max_attempts')::integer then 'no_attempts_left'
                   else null end) as rj
      from public.ex_exams e
      join public.ex_exam_versions v on v.id = e.published_version_id
      join public.enrollments en on en.course_id = e.course_id and en.user_id = v_uid and en.status = 'active'
      where e.status = 'published'
    ) q), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------- the guard
-- passes when the exam does not require SEB, or p_seb = {config_key?, browser_exam_key?} matches a stored proof.
-- SQLSTATE SB001 = "SEB required" (the UI maps the code, not the message).
create or replace function private.ex_seb_guard(s jsonb, p_seb jsonb)
returns void
language plpgsql
stable
set search_path = ''
as $$
declare
  v_keys jsonb := s -> 'security' -> 'seb_keys';
  c      text;
  b      text;
begin
  if coalesce((s -> 'security' ->> 'require_seb')::boolean, false) is not true then
    return;
  end if;
  if p_seb is null or jsonb_typeof(p_seb) <> 'object' then
    raise exception 'seb_required' using errcode = 'SB001';
  end if;
  c := lower(coalesce(p_seb ->> 'config_key', ''));
  b := lower(coalesce(p_seb ->> 'browser_exam_key', ''));
  if (c <> '' and v_keys ? c) or (b <> '' and v_keys ? b) then
    return;
  end if;
  raise exception 'seb_required' using errcode = 'SB001';
end;
$$;

create or replace function private.exam_start_attempt_seb(p_exam_id uuid, p_seb jsonb default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  s     jsonb;
  r     jsonb;
begin
  if v_uid is null then
    raise exception 'forbidden: sign-in required' using errcode = '42501';
  end if;
  -- only an enrolled trainee of a published exam is told about the SEB requirement (no existence oracle)
  select v.settings into s
    from public.ex_exams e
    join public.ex_exam_versions v on v.id = e.published_version_id
    join public.enrollments en on en.course_id = e.course_id and en.user_id = v_uid and en.status = 'active'
   where e.id = p_exam_id and e.status = 'published';
  if found then
    perform private.ex_seb_guard(s, p_seb);
  end if;
  r := private.exam_start_attempt(p_exam_id);
  -- 014 returns the raw security object: the proofs must never reach the trainee
  if jsonb_typeof(r #> '{settings,security}') = 'object' then
    r := jsonb_set(r, '{settings,security}', (r #> '{settings,security}') - 'seb_keys');
  end if;
  return r;
end;
$$;

create or replace function private.exam_get_items_guarded(p_attempt_id uuid, p_from integer default 1, p_count integer default 3, p_seb jsonb default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  a public.ex_attempts;
  s jsonb;
begin
  a := private.ex_attempt_for_caller(p_attempt_id);
  if a.status = 'in_progress' then
    select v.settings into s from public.ex_exam_versions v where v.id = a.exam_version_id;
    perform private.ex_seb_guard(s, p_seb);
  end if;
  return private.exam_get_items(p_attempt_id, p_from, p_count);
end;
$$;

-- ---------------------------------------------------------------- REST wrappers: same names, optional p_seb
drop function if exists public.exam_start_attempt(uuid);
drop function if exists public.exam_get_items(uuid, integer, integer);
create or replace function public.exam_start_attempt(p_exam_id uuid, p_seb jsonb default null)
returns jsonb language sql volatile set search_path = '' as $$ select private.exam_start_attempt_seb(p_exam_id, p_seb); $$;
create or replace function public.exam_get_items(p_attempt_id uuid, p_from integer default 1, p_count integer default 3, p_seb jsonb default null)
returns jsonb language sql volatile set search_path = '' as $$ select private.exam_get_items_guarded(p_attempt_id, p_from, p_count, p_seb); $$;

revoke execute on function private.ex_seb_guard(jsonb, jsonb)                              from public, anon, authenticated;
revoke execute on function private.exam_start_attempt_seb(uuid, jsonb)                     from public, anon, authenticated;
revoke execute on function private.exam_get_items_guarded(uuid, integer, integer, jsonb)   from public, anon, authenticated;
revoke execute on function public.exam_start_attempt(uuid, jsonb)                          from public, anon, authenticated;
revoke execute on function public.exam_get_items(uuid, integer, integer, jsonb)            from public, anon, authenticated;
grant execute on function private.exam_start_attempt_seb(uuid, jsonb)                      to authenticated;
grant execute on function private.exam_get_items_guarded(uuid, integer, integer, jsonb)    to authenticated;
grant execute on function public.exam_start_attempt(uuid, jsonb)                           to authenticated;
grant execute on function public.exam_get_items(uuid, integer, integer, jsonb)             to authenticated;

-- ROLLBACK: see docs/exams/rollback-015.sql
