-- 023_subscriptions  (admin: subscription lifecycle on public.enrollments)
-- ADDITIVE. No table is created; no row is changed or deleted. Existing enrollments keep working exactly as before
-- (status active/revoked, no dates => unlimited access).
--
--   enrollments.starts_at     optional: access begins at this time (NULL = from the moment it is active)
--   enrollments.expires_at    optional: access ends at this time   (NULL = no end). "Expired" is COMPUTED (active + expires_at passed), never stored.
--   enrollments.kind          paid | free | complimentary (NULL = not specified, e.g. older rows)
--   enrollments.cancel_reason free text, only meaningful when status = 'revoked' (= "cancelled")
--   status                    widened: active | revoked (cancelled) | pending | suspended
--
-- Access rule (single source): private.has_course_access() now also requires starts_at <= now() < expires_at.
-- The three exam entry points that test e.status = 'active' directly are patched the same way (see DO block).
-- Certificates, notifications, groups and reports are NOT changed: an expired trainee stays eligible for a certificate earned earlier.
-- Rollback: docs/lms/rollback-023.sql

begin;

alter table public.enrollments
  add column starts_at     timestamptz,
  add column expires_at    timestamptz,
  add column kind          text check (kind in ('paid', 'free', 'complimentary')),
  add column cancel_reason text check (cancel_reason is null or char_length(cancel_reason) <= 500);

alter table public.enrollments add constraint enrollments_dates_chk
  check (starts_at is null or expires_at is null or expires_at > starts_at);

alter table public.enrollments drop constraint enrollments_status_check;
alter table public.enrollments add constraint enrollments_status_check
  check (status in ('active', 'revoked', 'pending', 'suspended'));

alter table public.enrollments drop constraint enrollments_revoked_at_chk;
alter table public.enrollments add constraint enrollments_revoked_at_chk
  check ((status = 'revoked' and revoked_at is not null) or (status <> 'revoked' and revoked_at is null));

-- the admin may set the new columns (still only through the existing admin-only policies)
grant insert (starts_at, expires_at, kind) on public.enrollments to authenticated;
grant update (starts_at, expires_at, kind, cancel_reason) on public.enrollments to authenticated;

-- ---------------------------------------------------------------- BEFORE trigger (replaces the 003 one)
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
    if new.status <> 'revoked' then new.cancel_reason := null; end if;
  else
    if new.user_id is distinct from old.user_id or new.course_id is distinct from old.course_id then
      raise exception 'user_id and course_id of an enrollment cannot change' using errcode = '42501';
    end if;
    if new.status is distinct from old.status then
      if new.status = 'revoked' then
        new.revoked_at := now();
      else
        new.revoked_at := null;
        new.cancel_reason := null;
        if new.status = 'active' then
          new.granted_at := now();
          new.granted_by := coalesce((select auth.uid()), new.granted_by);
        end if;
      end if;
    end if;
    new.updated_at := now();
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------- audit trigger: name the new transitions
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
    v_action := case new.status
      when 'revoked'   then 'enrollment.revoked'
      when 'suspended' then 'enrollment.suspended'
      when 'pending'   then 'enrollment.pending'
      else case when old.status = 'pending' then 'enrollment.approved' else 'enrollment.reactivated' end
    end;
  elsif new.expires_at is distinct from old.expires_at then
    v_action := 'enrollment.extended';
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
      'user_id',      coalesce(new.user_id, old.user_id),
      'course_id',    coalesce(new.course_id, old.course_id),
      'old_status',   old.status,
      'new_status',   new.status,
      'kind',         coalesce(new.kind, old.kind),
      'starts_at',    coalesce(new.starts_at, old.starts_at),
      'expires_at',   coalesce(new.expires_at, old.expires_at),
      'cancel_reason', coalesce(new.cancel_reason, old.cancel_reason)
    )
  );
  return null;
end;
$$;

-- ---------------------------------------------------------------- access rule (dates)
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
      and (e.starts_at  is null or e.starts_at  <= now())
      and (e.expires_at is null or e.expires_at >  now())
      and p.status    = 'active'
      and c.published
  );
$$;

-- ---------------------------------------------------------------- exam entry points: add the same date test where they test en.status = 'active'
do $$
declare
  v_fn   text;
  v_oid  oid;
  v_def  text;
  v_new  text;
  v_old  constant text := 'en.status = ''active''';
  v_add  constant text := 'en.status = ''active'' and (en.starts_at is null or en.starts_at <= now()) and (en.expires_at is null or en.expires_at > now())';
begin
  foreach v_fn in array array['private.exam_list_available()', 'private.exam_start_attempt(uuid)', 'private.exam_start_attempt_seb(uuid, jsonb)'] loop
    v_oid := v_fn::regprocedure::oid;
    v_def := pg_get_functiondef(v_oid);
    if position(v_old in v_def) = 0 then
      raise exception '023: % does not contain the expected enrollment test', v_fn;
    end if;
    v_new := replace(v_def, v_old, v_add);
    execute v_new;
  end loop;
end $$;

commit;
