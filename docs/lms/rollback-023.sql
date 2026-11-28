-- rollback-023: restores the 003 behaviour of enrollments (status active/revoked only, no dates).
-- GUARD: rows that use pending/suspended or carry dates/kind/reason would lose that information or violate the old checks.
-- Delete the next line manually after reviewing: select status, count(*) from public.enrollments group by 1;
do $$ begin raise exception 'rollback-023 guard: review enrollments (pending/suspended rows, dates, kind) then remove this line'; end $$;
begin;
update public.enrollments set status = 'revoked', revoked_at = coalesce(revoked_at, now()) where status in ('pending', 'suspended');

create or replace function private.has_course_access(p_course_id text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.enrollments e
    join public.profiles p on p.id = e.user_id
    join public.courses c on c.id = e.course_id
    where e.user_id = (select auth.uid()) and e.course_id = p_course_id
      and e.status = 'active' and p.status = 'active' and c.published
  );
$$;

do $$
declare v_fn text; v_def text;
begin
  foreach v_fn in array array['private.exam_list_available()', 'private.exam_start_attempt(uuid)', 'private.exam_start_attempt_seb(uuid, jsonb)'] loop
    v_def := pg_get_functiondef(v_fn::regprocedure::oid);
    v_def := replace(v_def, 'en.status = ''active'' and (en.starts_at is null or en.starts_at <= now()) and (en.expires_at is null or en.expires_at > now())', 'en.status = ''active''');
    execute v_def;
  end loop;
end $$;

alter table public.enrollments drop constraint enrollments_dates_chk, drop constraint enrollments_revoked_at_chk, drop constraint enrollments_status_check;
alter table public.enrollments add constraint enrollments_status_check check (status in ('active', 'revoked'));
alter table public.enrollments add constraint enrollments_revoked_at_chk
  check ((status = 'active' and revoked_at is null) or (status = 'revoked' and revoked_at is not null));
revoke insert (starts_at, expires_at, kind) on public.enrollments from authenticated;
revoke update (starts_at, expires_at, kind, cancel_reason) on public.enrollments from authenticated;
alter table public.enrollments drop column starts_at, drop column expires_at, drop column kind, drop column cancel_reason;
-- NOTE: the 003 versions of private.enrollments_before() and private.audit_enrollments() should be re-applied from 003_functions_triggers.sql if you need the exact old trigger bodies.
commit;
