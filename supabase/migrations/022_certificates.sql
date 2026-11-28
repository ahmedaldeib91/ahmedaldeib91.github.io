-- 022_certificates  (LMS phase 5: course-completion certificates + public verification)
-- ADDITIVE: one new table and RPCs. These are the PLATFORM's own course-completion certificates; they are NOT PMI certificates and the UI says so.
--
--   cert_certificates   one row per issued certificate. The holder name and the course title are SNAPSHOTS taken at issue time (a later
--                       rename does not change an issued certificate). Written only by cert_issue / cert_revoke (admin).
--                       A trainee reads his own; admin reads all. A revoked certificate stays in the table (verification shows "revoked").
--   code                public verification code "AD-" + 10 chars from an unambiguous alphabet (32^10 ~ 1e15), generated from gen_random_uuid().
--   cert_verify(code)   callable by anyone (anon): returns whether the code is valid plus holder / course / date / revoked flag. Nothing else.

create table public.cert_certificates (
  id              uuid primary key default gen_random_uuid(),
  code            text not null unique check (code ~ '^AD-[A-Z2-9]{10}$'),
  user_id         uuid not null references public.profiles (id) on delete cascade,
  course_id       text not null references public.courses (id) on update restrict on delete restrict,
  holder_name     text not null check (char_length(btrim(holder_name)) between 1 and 200),
  course_title_ar text not null check (char_length(btrim(course_title_ar)) between 1 and 300),
  note            text check (note is null or char_length(note) <= 500),
  issued_by       uuid references public.profiles (id) on delete set null,
  issued_at       timestamptz not null default now(),
  revoked_at      timestamptz,
  revoke_reason   text check (revoke_reason is null or char_length(revoke_reason) <= 500),
  constraint cert_revoked_chk check ((revoked_at is null and revoke_reason is null) or revoked_at is not null)
);
create unique index cert_one_active_idx on public.cert_certificates (user_id, course_id) where revoked_at is null;
create index cert_course_idx on public.cert_certificates (course_id, issued_at desc);
create index cert_issued_by_idx on public.cert_certificates (issued_by);

alter table public.cert_certificates enable row level security;
alter table public.cert_certificates force row level security;
revoke all on table public.cert_certificates from public, anon, authenticated;
grant select on public.cert_certificates to authenticated;
create policy cert_select on public.cert_certificates for select to authenticated
  using (user_id = (select auth.uid()) or (select private.is_admin()));

create or replace function private.cert_new_code()
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_alpha constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_bytes bytea := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
  v_code  text := 'AD-';
  i       integer;
begin
  for i in 0..9 loop
    v_code := v_code || substr(v_alpha, 1 + (get_byte(v_bytes, i) % 32), 1);
  end loop;
  return v_code;
end;
$$;

create or replace function private.cert_issue(p_user_id uuid, p_course_id text, p_note text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := (select auth.uid());
  v_name  text;
  v_title text;
  c       public.cert_certificates;
  i       integer := 0;
begin
  if v_uid is null or not private.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform private.rl_hit('cert_issue:' || v_uid::text, 3600, 200);
  if not exists (select 1 from public.enrollments e where e.user_id = p_user_id and e.course_id = p_course_id and e.status = 'active') then
    raise exception 'the trainee has no active enrollment in this course' using errcode = '22023';
  end if;
  select nullif(btrim(p.full_name), '') into v_name from public.profiles p where p.id = p_user_id and p.role = 'trainee';
  if v_name is null then
    raise exception 'the trainee needs a name in the profile first' using errcode = '22023';
  end if;
  select c2.title_ar into v_title from public.courses c2 where c2.id = p_course_id;
  if v_title is null then
    raise exception 'unknown course' using errcode = '22023';
  end if;
  if p_note is not null and char_length(p_note) > 500 then
    raise exception 'note too long' using errcode = '22023';
  end if;
  loop
    i := i + 1;
    begin
      insert into public.cert_certificates (code, user_id, course_id, holder_name, course_title_ar, note, issued_by)
      values (private.cert_new_code(), p_user_id, p_course_id, v_name, v_title, nullif(btrim(coalesce(p_note, '')), ''), v_uid)
      returning * into c;
      exit;
    exception when unique_violation then
      if exists (select 1 from public.cert_certificates x where x.user_id = p_user_id and x.course_id = p_course_id and x.revoked_at is null) then
        raise exception 'a certificate was already issued for this course' using errcode = '23505';
      end if;
      if i >= 5 then raise; end if;
    end;
  end loop;
  return jsonb_build_object('id', c.id, 'code', c.code, 'issued_at', c.issued_at);
end;
$$;

create or replace function private.cert_revoke(p_id uuid, p_reason text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null or not private.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_reason is not null and char_length(p_reason) > 500 then
    raise exception 'reason too long' using errcode = '22023';
  end if;
  update public.cert_certificates c set revoked_at = now(), revoke_reason = nullif(btrim(coalesce(p_reason, '')), '')
   where c.id = p_id and c.revoked_at is null;
  if not found then
    raise exception 'certificate not found or already revoked' using errcode = '22023';
  end if;
  return jsonb_build_object('revoked', true);
end;
$$;

-- public verification: anyone may ask; the answer carries only what a verifier needs
create or replace function private.cert_verify(p_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_code text := upper(btrim(coalesce(p_code, '')));
  c      public.cert_certificates;
begin
  if v_code !~ '^AD-[A-Z2-9]{10}$' then
    return jsonb_build_object('found', false, 'valid', false);
  end if;
  select * into c from public.cert_certificates x where x.code = v_code;
  if not found then
    return jsonb_build_object('found', false, 'valid', false);
  end if;
  return jsonb_build_object('found', true, 'valid', c.revoked_at is null, 'code', c.code, 'holder', c.holder_name, 'course', c.course_title_ar,
                            'issued_at', c.issued_at, 'revoked', c.revoked_at is not null, 'revoked_at', c.revoked_at);
end;
$$;

create or replace function public.cert_issue(p_user_id uuid, p_course_id text, p_note text default null)
returns jsonb language sql volatile set search_path = '' as $$ select private.cert_issue(p_user_id, p_course_id, p_note); $$;
create or replace function public.cert_revoke(p_id uuid, p_reason text default null)
returns jsonb language sql volatile set search_path = '' as $$ select private.cert_revoke(p_id, p_reason); $$;
-- SECURITY DEFINER on purpose: the anon role has no access to the private schema; this wrapper only forwards to the read-only verifier
create or replace function public.cert_verify(p_code text)
returns jsonb language sql stable security definer set search_path = '' as $$ select private.cert_verify(p_code); $$;

revoke execute on function private.cert_new_code() from public, anon, authenticated;
revoke execute on function private.cert_issue(uuid, text, text) from public, anon, authenticated;
revoke execute on function private.cert_revoke(uuid, text)      from public, anon, authenticated;
revoke execute on function private.cert_verify(text)            from public, anon, authenticated;
revoke execute on function public.cert_issue(uuid, text, text)  from public, anon, authenticated;
revoke execute on function public.cert_revoke(uuid, text)       from public, anon, authenticated;
revoke execute on function public.cert_verify(text)             from public, anon, authenticated;
grant execute on function private.cert_issue(uuid, text, text)  to authenticated;
grant execute on function private.cert_revoke(uuid, text)       to authenticated;
grant execute on function private.cert_verify(text)             to anon, authenticated;
grant execute on function public.cert_issue(uuid, text, text)   to authenticated;
grant execute on function public.cert_revoke(uuid, text)        to authenticated;
grant execute on function public.cert_verify(text)              to anon, authenticated;

-- ROLLBACK: docs/lms/rollback-022.sql
