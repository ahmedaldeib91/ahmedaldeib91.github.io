-- 007_interest_messages_and_subscribers_report
-- Applied to the live DB as version 20261125125337 (name 007_interest_messages_and_subscribers_report).
-- This file mirrors the statements recorded in supabase_migrations.schema_migrations for that version.
--
-- 1) contact_messages gains:
--      kind      'contact' (form "تواصل معنا") | 'interest' (button "سجّل اهتمامًا/اشترك")
--      course_id the course a trainee is interested in (interest rows only; no FK on purpose:
--                the row is a message, it must survive course renames/removals)
--      user_id   the signed-in trainee who sent the interest (interest rows only; no FK, same reason)
--    These columns are NOT granted to anon/authenticated for INSERT (004 grants only
--    name, email, phone, subject, message). Interest rows are written by the Edge Function
--    `send-mail` with the service role. Admins read them through the existing table-level
--    SELECT grant + contact_messages_select_admin policy.
--    RLS on contact_messages is unchanged from 004:
--      contact_messages_insert        INSERT anon,authenticated  WITH CHECK (status = 'new' and ip_hash is not null)
--      contact_messages_select_admin  SELECT authenticated       USING (private.is_admin())
--      contact_messages_update_admin  UPDATE authenticated       USING/CHECK (private.is_admin())
--      contact_messages_delete_admin  DELETE authenticated       USING (private.is_admin())
--    The before-insert trigger private.contact_messages_before (003) is unchanged.
--
-- 2) public.admin_subscribers_report(): one row per trainee with email/phone/courses, admin only.
--    Two layers like 006: private SECURITY DEFINER (reads auth.users, checks is_admin()) +
--    public SECURITY INVOKER wrapper for REST (POST/GET /rest/v1/rpc/admin_subscribers_report).

-- 007: رسائل «سجّل اهتمامًا/اشترك» + تقرير المشتركين للمدرب
alter table public.contact_messages
  add column if not exists kind text not null default 'contact',
  add column if not exists course_id text,
  add column if not exists user_id uuid;

alter table public.contact_messages
  drop constraint if exists contact_messages_kind_check;
alter table public.contact_messages
  add constraint contact_messages_kind_check check (kind in ('contact','interest'));

create index if not exists contact_messages_kind_created_idx on public.contact_messages (kind, created_at desc);

-- تقرير المشتركين: متدرب واحد لكل صف مع بريده وهاتفه ودوراته (للمدير فقط)
create or replace function private.admin_subscribers_report()
returns table(
  user_id uuid, full_name text, email text, phone text, country text,
  account_status text, joined_at timestamptz, last_sign_in_at timestamptz,
  active_courses integer, courses jsonb
)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.is_admin() then
    raise exception 'forbidden: admin only' using errcode = '42501';
  end if;
  return query
    select p.id, p.full_name, u.email::text, p.phone, p.country, p.status,
           p.created_at, u.last_sign_in_at,
           (select count(*)::int from public.enrollments e where e.user_id = p.id and e.status = 'active'),
           coalesce((
             select jsonb_agg(jsonb_build_object(
                      'course_id', e.course_id, 'title_ar', c.title_ar, 'title_en', c.title_en,
                      'status', e.status, 'granted_at', e.granted_at)
                    order by e.granted_at desc nulls last)
             from public.enrollments e join public.courses c on c.id = e.course_id
             where e.user_id = p.id), '[]'::jsonb)
    from public.profiles p
    join auth.users u on u.id = p.id
    where p.role = 'trainee'
    order by p.created_at desc, p.id;
end;
$$;

create or replace function public.admin_subscribers_report()
returns table(
  user_id uuid, full_name text, email text, phone text, country text,
  account_status text, joined_at timestamptz, last_sign_in_at timestamptz,
  active_courses integer, courses jsonb
)
language sql stable set search_path = ''
as $$ select * from private.admin_subscribers_report(); $$;

revoke all on function public.admin_subscribers_report() from public, anon;
grant execute on function public.admin_subscribers_report() to authenticated;
revoke all on function private.admin_subscribers_report() from public, anon;
grant execute on function private.admin_subscribers_report() to authenticated;
