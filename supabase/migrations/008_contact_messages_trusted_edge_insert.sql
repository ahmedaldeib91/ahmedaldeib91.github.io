-- 008_contact_messages_trusted_edge_insert  (APPLIED to the live DB on 2026-11-25)
--
-- Why: the Edge Function `send-mail` inserts contact/interest rows with the service role.
-- The 003 trigger private.contact_messages_before derives the IP from the PostgREST request
-- headers, which for those inserts are the Edge Function's own egress headers, not the
-- visitor's. Without this change every message sent through the function shares ONE ip_hash,
-- so the per-IP limit (5/hour) becomes a site-wide limit and the stored ip_hash is useless.
--
-- What changes (only for inserts whose JWT role is service_role AND that carry a valid
-- 64-hex ip_hash computed by the function from the real client IP):
--   * the provided ip_hash is kept instead of being recomputed;
--   * kind='contact' rows: same per-IP limit as before (5/hour), serialized by advisory lock;
--   * kind='interest' rows: per-user limit (10/hour), serialized by advisory lock;
--     user_id and course_id are mandatory.
-- Everything else is identical to 003 (anon/authenticated direct inserts still get the
-- server-computed hash, the 5/hour per-IP limit and the 200/hour global cap).
-- auth.role() reads the signed JWT claim, so a browser cannot claim service_role.

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
  v_trusted  boolean;
begin
  v_trusted := coalesce((select auth.role()), '') = 'service_role'
               and coalesce(new.ip_hash, '') ~ '^[0-9a-f]{64}$';

  if v_trusted then
    v_hash := new.ip_hash;
  else
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
    -- only the trusted path may write interest rows
    new.kind      := 'contact';
    new.user_id   := null;
    new.course_id := null;
  end if;

  if new.kind = 'interest' then
    if new.user_id is null or new.course_id is null then
      raise exception 'interest messages need user_id and course_id' using errcode = '22023';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('contact_messages:user:' || new.user_id::text, 0));
    select count(*) into v_count
    from public.contact_messages m
    where m.user_id = new.user_id
      and m.kind = 'interest'
      and m.created_at > now() - interval '1 hour';
    if v_count >= 10 then
      raise exception 'rate_limited: too many messages from this account, try again later'
        using errcode = 'P0001';
    end if;
  else
    perform pg_advisory_xact_lock(hashtextextended('contact_messages:' || v_hash, 0));
    select count(*) into v_count
    from public.contact_messages m
    where m.ip_hash = v_hash
      and m.kind = 'contact'
      and m.created_at > now() - interval '1 hour';
    if v_count >= 5 then
      raise exception 'rate_limited: too many messages from this address, try again later'
        using errcode = 'P0001';
    end if;
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

revoke execute on function private.contact_messages_before() from public, anon, authenticated;
