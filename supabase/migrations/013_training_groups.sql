-- 013_training_groups  (Training groups per course: members, sessions, attendance, pre/post assessments)
-- ADDITIVE: new tables only; nothing of 001..012 is altered. Admin only for now (RLS default-deny: only
-- private.is_admin() reads/writes; anon and trainees get nothing). Every group belongs to ONE course; members must be
-- trainees with an ACTIVE enrollment in that course at the time they are added; sessions and attendance are tied to the
-- group by composite foreign keys, so rows of other groups/courses can never be mixed.
--
--   grp_groups       the group (name, status, dates, mode/location, capacity, instructor, schedule note)
--   grp_members      trainee in a group (status, pre_score / post_score in percent, note)
--   grp_sessions     a meeting of the group (starts_at, duration, topic, mode/location, status)
--   grp_attendance   one row per (session, member): present | absent | late | excused (+ note)
--   grp_assessments  the pre / post assessment of a group (title, date, optional link to an exam of the same course;
--                    scores are entered per member now and can be filled from exam attempts once M4 ships)

-- ================================================================ 1. groups
create table public.grp_groups (
  id            uuid primary key default gen_random_uuid(),
  course_id     text not null references public.courses (id) on update restrict on delete restrict,
  name          text not null check (char_length(btrim(name)) between 1 and 120),
  description   text check (description is null or char_length(description) <= 2000),
  status        text not null default 'planned' check (status in ('planned', 'active', 'completed', 'cancelled')),
  mode          text not null default 'online' check (mode in ('online', 'in_person', 'hybrid')),
  location      text check (location is null or char_length(location) <= 500),
  start_date    date,
  end_date      date,
  capacity      integer check (capacity is null or capacity between 1 and 1000),
  instructor_id uuid references public.profiles (id) on delete set null,
  schedule_note text check (schedule_note is null or char_length(schedule_note) <= 1000),
  created_by    uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint grp_groups_course_id_id_key unique (course_id, id),
  constraint grp_groups_course_name_key unique (course_id, name),
  constraint grp_groups_dates_chk check (start_date is null or end_date is null or end_date >= start_date)
);
create index grp_groups_course_status_idx on public.grp_groups (course_id, status);
create index grp_groups_instructor_idx    on public.grp_groups (instructor_id);
create index grp_groups_created_by_idx    on public.grp_groups (created_by);

-- ================================================================ 2. members
create table public.grp_members (
  group_id   uuid not null,
  course_id  text not null,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  status     text not null default 'active' check (status in ('active', 'dropped', 'completed')),
  pre_score  numeric(5,2) check (pre_score is null or pre_score between 0 and 100),
  post_score numeric(5,2) check (post_score is null or post_score between 0 and 100),
  note       text check (note is null or char_length(note) <= 2000),
  joined_at  timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint grp_members_pkey primary key (group_id, user_id),
  constraint grp_members_group_fkey foreign key (course_id, group_id)
    references public.grp_groups (course_id, id) on update restrict on delete cascade
);
create index grp_members_course_group_idx on public.grp_members (course_id, group_id);
create index grp_members_user_idx         on public.grp_members (user_id);

-- ================================================================ 3. sessions
create table public.grp_sessions (
  id               uuid primary key default gen_random_uuid(),
  group_id         uuid not null,
  course_id        text not null,
  title            text not null check (char_length(btrim(title)) between 1 and 200),
  starts_at        timestamptz not null,
  duration_minutes integer not null default 60 check (duration_minutes between 5 and 1440),
  mode             text not null default 'online' check (mode in ('online', 'in_person', 'hybrid')),
  location         text check (location is null or char_length(location) <= 500),
  notes            text check (notes is null or char_length(notes) <= 2000),
  status           text not null default 'scheduled' check (status in ('scheduled', 'held', 'cancelled')),
  created_by       uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint grp_sessions_group_id_id_key unique (group_id, id),
  constraint grp_sessions_group_fkey foreign key (course_id, group_id)
    references public.grp_groups (course_id, id) on update restrict on delete cascade
);
create index grp_sessions_course_group_idx on public.grp_sessions (course_id, group_id, starts_at);
create index grp_sessions_created_by_idx   on public.grp_sessions (created_by);

-- ================================================================ 4. attendance
create table public.grp_attendance (
  session_id uuid not null,
  group_id   uuid not null,
  user_id    uuid not null,
  status     text not null check (status in ('present', 'absent', 'late', 'excused')),
  note       text check (note is null or char_length(note) <= 500),
  marked_by  uuid references public.profiles (id) on delete set null,
  marked_at  timestamptz not null default now(),
  constraint grp_attendance_pkey primary key (session_id, user_id),
  constraint grp_attendance_session_fkey foreign key (group_id, session_id)
    references public.grp_sessions (group_id, id) on update restrict on delete cascade,
  constraint grp_attendance_member_fkey foreign key (group_id, user_id)
    references public.grp_members (group_id, user_id) on update restrict on delete cascade
);
create index grp_attendance_member_idx    on public.grp_attendance (group_id, user_id);
create index grp_attendance_marked_by_idx on public.grp_attendance (marked_by);

-- ================================================================ 5. pre / post assessments
create table public.grp_assessments (
  group_id  uuid not null,
  course_id text not null,
  kind      text not null check (kind in ('pre', 'post')),
  title     text not null check (char_length(btrim(title)) between 1 and 200),
  held_on   date,
  exam_id   uuid,
  note      text check (note is null or char_length(note) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint grp_assessments_pkey primary key (group_id, kind),
  constraint grp_assessments_group_fkey foreign key (course_id, group_id)
    references public.grp_groups (course_id, id) on update restrict on delete cascade,
  -- the exam must belong to the SAME course
  constraint grp_assessments_exam_fkey foreign key (course_id, exam_id)
    references public.ex_exams (course_id, id) on update restrict on delete restrict
);
create index grp_assessments_exam_idx on public.grp_assessments (course_id, exam_id);

-- ================================================================ 6. triggers
create or replace function private.grp_touch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    new.updated_at := now();
  end if;
  return new;
end;
$$;

create trigger grp_groups_touch      before update on public.grp_groups      for each row execute function private.grp_touch();
create trigger grp_sessions_touch    before update on public.grp_sessions    for each row execute function private.grp_touch();
create trigger grp_assessments_touch before update on public.grp_assessments for each row execute function private.grp_touch();

-- a group never moves to another course
create or replace function private.grp_groups_before()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.course_id is distinct from old.course_id then
    raise exception 'course_id of a group cannot change' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger grp_groups_before before update on public.grp_groups for each row execute function private.grp_groups_before();

-- members: trainees with an ACTIVE enrollment in the group's course; capacity counts ACTIVE members
create or replace function private.grp_members_before()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_cap integer;
  v_cnt integer;
begin
  if tg_op = 'UPDATE' then
    if new.group_id is distinct from old.group_id or new.user_id is distinct from old.user_id
       or new.course_id is distinct from old.course_id then
      raise exception 'group_id, course_id and user_id of a member cannot change' using errcode = '42501';
    end if;
    new.updated_at := now();
  else
    if not exists (select 1 from public.profiles p where p.id = new.user_id and p.role = 'trainee') then
      raise exception 'only trainee accounts can join a group' using errcode = '23514';
    end if;
    if not exists (select 1 from public.enrollments e
                   where e.user_id = new.user_id and e.course_id = new.course_id and e.status = 'active') then
      raise exception 'the trainee has no active enrollment in this course' using errcode = '23514';
    end if;
  end if;
  if new.status = 'active' and (tg_op = 'INSERT' or old.status is distinct from 'active') then
    select g.capacity into v_cap from public.grp_groups g where g.id = new.group_id;
    if v_cap is not null then
      select count(*) into v_cnt from public.grp_members m
       where m.group_id = new.group_id and m.status = 'active' and m.user_id <> new.user_id;
      if v_cnt >= v_cap then
        raise exception 'group capacity reached (%)', v_cap using errcode = '23514';
      end if;
    end if;
  end if;
  return new;
end;
$$;
create trigger grp_members_before before insert or update on public.grp_members for each row execute function private.grp_members_before();

-- attendance: who/when is stamped by the server
create or replace function private.grp_attendance_before()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.marked_by := coalesce((select auth.uid()), new.marked_by);
  new.marked_at := now();
  return new;
end;
$$;
create trigger grp_attendance_before before insert or update on public.grp_attendance for each row execute function private.grp_attendance_before();

-- ================================================================ 7. lock down + RLS (admin only)
do $$
declare t text;
begin
  foreach t in array array['grp_groups', 'grp_members', 'grp_sessions', 'grp_attendance', 'grp_assessments'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('create policy %I on public.%I for all to authenticated using ((select private.is_admin())) with check ((select private.is_admin()))', t || '_admin', t);
  end loop;
end $$;

revoke execute on function private.grp_touch()             from public, anon, authenticated;
revoke execute on function private.grp_groups_before()     from public, anon, authenticated;
revoke execute on function private.grp_members_before()    from public, anon, authenticated;
revoke execute on function private.grp_attendance_before() from public, anon, authenticated;

-- ================================================================ ROLLBACK (see docs/exams/rollback-013.sql)
-- drop table if exists public.grp_attendance, public.grp_assessments, public.grp_sessions, public.grp_members, public.grp_groups;
-- drop function if exists private.grp_touch(), private.grp_groups_before(), private.grp_members_before(), private.grp_attendance_before();
