-- 021_notifications  (LMS phase 4: in-app notifications + upcoming reminders + course announcements)
-- ADDITIVE: one new table, trigger functions on 4 existing tables (AFTER triggers that only INSERT notifications; they never block a write
-- of the source table's own logic), and RPCs. Requires 009, 013, 014+019, 016, 020.
--
--   ntf_notifications   one row per (user, event). Written ONLY by the triggers / ntf_broadcast (no write grant to any API role).
--                       A user reads and marks as read only his own rows.
--   Events:  assignment_new (an assignment is published)           -> every active enrollee of the course
--            assignment_graded / assignment_returned               -> the trainee
--            exam_graded (the last essay of an attempt is graded)  -> the trainee
--            discussion_reply                                      -> the thread author + earlier participants (not the writer)
--            announcement (ntf_broadcast, admin)                   -> every active enrollee of the course
--   Reminders (no cron needed, computed when the trainee opens the dashboard): assignments due within 7 days that are not submitted yet,
--   and scheduled group sessions within 7 days for the groups the trainee belongs to.
-- E-mail delivery is NOT part of this migration (needs the send-mail Edge Function / an external provider).

create table public.ntf_notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  kind       text not null check (kind in ('assignment_new', 'assignment_graded', 'assignment_returned', 'exam_graded', 'discussion_reply', 'announcement')),
  title_ar   text not null check (char_length(btrim(title_ar)) between 1 and 200),
  body_ar    text check (body_ar is null or char_length(body_ar) <= 600),
  link       text check (link is null or link ~ '^#[A-Za-z0-9=&_-]{1,200}$'),
  course_id  text check (course_id is null or char_length(course_id) <= 40),
  created_at timestamptz not null default now(),
  read_at    timestamptz
);
create index ntf_notifications_user_idx   on public.ntf_notifications (user_id, created_at desc);
create index ntf_notifications_unread_idx on public.ntf_notifications (user_id) where read_at is null;

alter table public.ntf_notifications enable row level security;
alter table public.ntf_notifications force row level security;
revoke all on table public.ntf_notifications from public, anon, authenticated;
grant select on public.ntf_notifications to authenticated;
create policy ntf_notifications_select on public.ntf_notifications for select to authenticated using (user_id = (select auth.uid()));

-- ================================================================ triggers (SECURITY DEFINER: the only writers)
create or replace function private.ntf_on_submission()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_title text;
begin
  if new.status in ('graded', 'returned') and new.status is distinct from old.status then
    select a.title_ar into v_title from public.asg_assignments a where a.id = new.assignment_id;
    insert into public.ntf_notifications (user_id, kind, title_ar, body_ar, link, course_id)
    values (new.user_id, case when new.status = 'graded' then 'assignment_graded' else 'assignment_returned' end,
            case when new.status = 'graded' then 'صُحِّح واجبك: ' else 'أُعيد إليك للتعديل: ' end || coalesce(v_title, 'واجب'),
            case when new.status = 'graded' then 'الدرجة: ' || new.score::text else null end,
            '#course=' || new.course_id || '&tab=assignments', new.course_id);
  end if;
  return new;
end;
$$;
create trigger ntf_asg_submission_status after update of status on public.asg_submissions for each row execute function private.ntf_on_submission();

create or replace function private.ntf_on_attempt()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_title text;
begin
  if old.grading_status = 'pending' and new.grading_status = 'done' then
    select e.title_ar into v_title from public.ex_exams e where e.id = new.exam_id;
    insert into public.ntf_notifications (user_id, kind, title_ar, body_ar, link, course_id)
    values (new.user_id, 'exam_graded', 'اكتمل تصحيح اختبارك: ' || coalesce(v_title, 'اختبار'), null, '#result=' || new.id::text, new.course_id);
  end if;
  return new;
end;
$$;
create trigger ntf_attempt_graded after update of grading_status on public.ex_attempts for each row execute function private.ntf_on_attempt();

create or replace function private.ntf_on_post()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_title text;
begin
  select t.title into v_title from public.dsc_threads t where t.id = new.thread_id;
  insert into public.ntf_notifications (user_id, kind, title_ar, body_ar, link, course_id)
  select u.uid, 'discussion_reply', 'رد جديد في: ' || coalesce(v_title, 'موضوع'), null, '#course=' || new.course_id || '&tab=discussions', new.course_id
  from (select distinct x.uid from (
          select t.author_id as uid from public.dsc_threads t where t.id = new.thread_id
          union
          select p.author_id from public.dsc_posts p where p.thread_id = new.thread_id and not p.deleted) x
        where x.uid is not null and x.uid is distinct from new.author_id limit 50) u
  where exists (select 1 from public.profiles pr where pr.id = u.uid and pr.status = 'active');
  return new;
end;
$$;
create trigger ntf_post_reply after insert on public.dsc_posts for each row execute function private.ntf_on_post();

create or replace function private.ntf_on_assignment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.published and (tg_op = 'INSERT' or old.published is distinct from true) then
    insert into public.ntf_notifications (user_id, kind, title_ar, body_ar, link, course_id)
    select e.user_id, 'assignment_new', 'واجب جديد: ' || new.title_ar,
           case when new.due_at is not null then 'آخر موعد: ' || to_char(new.due_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' (UTC)' end,
           '#course=' || new.course_id || '&tab=assignments', new.course_id
    from public.enrollments e join public.profiles p on p.id = e.user_id and p.status = 'active'
    where e.course_id = new.course_id and e.status = 'active';
  end if;
  return new;
end;
$$;
create trigger ntf_assignment_published after insert or update of published on public.asg_assignments for each row execute function private.ntf_on_assignment();

-- ================================================================ RPCs
create or replace function private.ntf_list(p_limit integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'unread', (select count(*) from public.ntf_notifications n where n.user_id = v_uid and n.read_at is null),
    'items', coalesce((select jsonb_agg(jsonb_build_object('id', n.id, 'kind', n.kind, 'title', n.title_ar, 'body', n.body_ar, 'link', n.link,
                'course_id', n.course_id, 'created_at', n.created_at, 'read', n.read_at is not null) order by n.created_at desc)
              from (select * from public.ntf_notifications x where x.user_id = v_uid order by x.created_at desc limit least(greatest(coalesce(p_limit, 30), 1), 100)) n), '[]'::jsonb),
    'upcoming', coalesce((select jsonb_agg(u.j order by u.at) from (
        select a.due_at as at, jsonb_build_object('kind', 'assignment_due', 'title', a.title_ar, 'at', a.due_at, 'course_id', a.course_id,
               'link', '#course=' || a.course_id || '&tab=assignments') as j
          from public.asg_assignments a
         where a.published and a.due_at between now() and now() + interval '7 days' and private.has_course_access(a.course_id)
           and not exists (select 1 from public.asg_submissions s where s.assignment_id = a.id and s.user_id = v_uid and s.status in ('submitted', 'graded'))
        union all
        select s.starts_at, jsonb_build_object('kind', 'session', 'title', s.title, 'at', s.starts_at, 'course_id', s.course_id, 'group', g.name,
               'mode', s.mode, 'location', s.location, 'link', '#course=' || s.course_id)
          from public.grp_sessions s
          join public.grp_groups g on g.id = s.group_id
          join public.grp_members m on m.group_id = s.group_id and m.user_id = v_uid and m.status = 'active'
         where s.status = 'scheduled' and s.starts_at between now() and now() + interval '7 days' and private.has_course_access(s.course_id)
        order by 1 limit 20) u), '[]'::jsonb));
end;
$$;

create or replace function private.ntf_mark_read(p_ids uuid[])
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_ids is null or cardinality(p_ids) > 100 then
    raise exception 'ids must be an array of up to 100' using errcode = '22023';
  end if;
  update public.ntf_notifications n set read_at = now() where n.user_id = v_uid and n.read_at is null and n.id = any (p_ids);
  return (select count(*)::integer from public.ntf_notifications n where n.user_id = v_uid and n.read_at is null);
end;
$$;

create or replace function private.ntf_mark_all_read()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update public.ntf_notifications n set read_at = now() where n.user_id = v_uid and n.read_at is null;
  return 0;
end;
$$;

create or replace function private.ntf_broadcast(p_course_id text, p_title text, p_body text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_n   integer;
begin
  if v_uid is null or not private.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform private.rl_hit('ntf_bcast:' || v_uid::text, 3600, 20);
  if not exists (select 1 from public.courses c where c.id = p_course_id) then
    raise exception 'unknown course' using errcode = '22023';
  end if;
  if char_length(btrim(coalesce(p_title, ''))) not between 1 and 200 or char_length(coalesce(p_body, '')) > 600 then
    raise exception 'title (1..200) is required and body is limited to 600 chars' using errcode = '22023';
  end if;
  insert into public.ntf_notifications (user_id, kind, title_ar, body_ar, link, course_id)
  select e.user_id, 'announcement', btrim(p_title), nullif(btrim(coalesce(p_body, '')), ''), '#course=' || p_course_id, p_course_id
  from public.enrollments e join public.profiles p on p.id = e.user_id and p.status = 'active'
  where e.course_id = p_course_id and e.status = 'active';
  get diagnostics v_n = row_count;
  return jsonb_build_object('sent', v_n);
end;
$$;

create or replace function public.ntf_list(p_limit integer default 30)
returns jsonb language sql stable set search_path = '' as $$ select private.ntf_list(p_limit); $$;
create or replace function public.ntf_mark_read(p_ids uuid[])
returns integer language sql volatile set search_path = '' as $$ select private.ntf_mark_read(p_ids); $$;
create or replace function public.ntf_mark_all_read()
returns integer language sql volatile set search_path = '' as $$ select private.ntf_mark_all_read(); $$;
create or replace function public.ntf_broadcast(p_course_id text, p_title text, p_body text default null)
returns jsonb language sql volatile set search_path = '' as $$ select private.ntf_broadcast(p_course_id, p_title, p_body); $$;

do $$
declare f text;
begin
  foreach f in array array['ntf_list(integer)', 'ntf_mark_read(uuid[])', 'ntf_mark_all_read()', 'ntf_broadcast(text, text, text)'] loop
    execute format('revoke execute on function private.%s from public, anon, authenticated', f);
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function private.%s to authenticated', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
revoke execute on function private.ntf_on_submission() from public, anon, authenticated;
revoke execute on function private.ntf_on_attempt()    from public, anon, authenticated;
revoke execute on function private.ntf_on_post()       from public, anon, authenticated;
revoke execute on function private.ntf_on_assignment() from public, anon, authenticated;

-- ROLLBACK: docs/lms/rollback-021.sql
