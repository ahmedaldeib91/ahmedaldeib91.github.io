-- 006_admin_user_emails
-- Lets an ADMIN read the e-mail (plus confirmation / last sign-in time) of the platform users.
-- Why: the e-mail lives in auth.users, which the REST API cannot read, so the trainer panel could not tell
-- which e-mail belongs to which trainee (the WhatsApp "subscribe" message carries the trainee e-mail, so the
-- trainer needs to find a trainee by e-mail to enroll him).
-- Same two-layer pattern as is_admin() / admin_stats():
--   private.admin_user_emails()  SECURITY DEFINER (reads auth.users), raises 42501 unless private.is_admin()
--   public.admin_user_emails()   SECURITY INVOKER thin wrapper = /rest/v1/rpc/admin_user_emails
-- EXECUTE is granted to 'authenticated' only (anon and PUBLIC revoked); a non-admin gets "forbidden".
-- Nothing else is granted on schema auth. Returns only these 4 columns, one row per profile.

create or replace function private.admin_user_emails()
returns table (user_id uuid, email text, email_confirmed_at timestamptz, last_sign_in_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_admin() then
    raise exception 'forbidden: admin only' using errcode = '42501';
  end if;
  return query
    select u.id, u.email::text, u.email_confirmed_at, u.last_sign_in_at
    from auth.users u
    join public.profiles p on p.id = u.id
    order by u.created_at, u.id;
end;
$$;

create or replace function public.admin_user_emails()
returns table (user_id uuid, email text, email_confirmed_at timestamptz, last_sign_in_at timestamptz)
language sql
stable
set search_path = ''
as $$
  select * from private.admin_user_emails();
$$;

revoke execute on function private.admin_user_emails() from public, anon, authenticated;
revoke execute on function public.admin_user_emails()  from public, anon, authenticated;
grant  execute on function private.admin_user_emails() to authenticated;
grant  execute on function public.admin_user_emails()  to authenticated;
