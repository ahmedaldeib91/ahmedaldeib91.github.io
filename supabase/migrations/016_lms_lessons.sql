-- 016_lms_lessons  (LMS phase 1: modules, lessons, lesson files, per-trainee progress)
-- ADDITIVE: new tables only; course_items (videos/files) is NOT altered or moved. A lesson POINTS to an existing video item
-- (course_items.kind='video') and to existing file items, so no content is duplicated and every current link keeps working.
-- Items not attached to any lesson stay visible to trainees exactly as before (the UI shows them under "other materials").
--
--   lms_modules       unit of a course (title, description, sort, published)
--   lms_lessons       lesson inside a module (video item, duration, sort, published)
--   lms_lesson_files  files attached to a lesson (existing course_items of kind 'file')
--   lms_progress      one row per (trainee, lesson): resume position + completed. Written ONLY through lms_save_progress().
-- Access: admin full; a trainee reads published rows of courses they can access (private.has_course_access).

-- ================================================================ 1. modules
create table public.lms_modules (
  id             uuid primary key default gen_random_uuid(),
  course_id      text not null references public.courses (id) on update restrict on delete restrict,
  title_ar       text not null check (char_length(btrim(title_ar)) between 1 and 300),
  description_ar text check (description_ar is null or char_length(description_ar) <= 3000),
  sort           integer not null default 0,
  published      boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint lms_modules_course_id_id_key unique (course_id, id)
);
create index lms_modules_course_sort_idx on public.lms_modules (course_id, sort);

-- ================================================================ 2. lessons
create table public.lms_lessons (
  id               uuid primary key default gen_random_uuid(),
  course_id        text not null,
  module_id        uuid not null,
  title_ar         text not null check (char_length(btrim(title_ar)) between 1 and 300),
  description_ar   text check (description_ar is null or char_length(description_ar) <= 5000),
  video_item_id    uuid references public.course_items (id) on update restrict on delete set null,
  duration_seconds integer check (duration_seconds is null or duration_seconds between 1 and 86400),
  sort             integer not null default 0,
  published        boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint lms_lessons_course_id_id_key unique (course_id, id),
  constraint lms_lessons_module_fkey foreign key (course_id, module_id)
    references public.lms_modules (course_id, id) on update restrict on delete restrict
);
create index lms_lessons_module_sort_idx on public.lms_lessons (course_id, module_id, sort);
create index lms_lessons_video_idx       on public.lms_lessons (video_item_id);

-- ================================================================ 3. lesson files
create table public.lms_lesson_files (
  lesson_id  uuid not null references public.lms_lessons (id) on update restrict on delete cascade,
  item_id    uuid not null references public.course_items (id) on update restrict on delete cascade,
  sort       integer not null default 0,
  created_at timestamptz not null default now(),
  constraint lms_lesson_files_pkey primary key (lesson_id, item_id)
);
create index lms_lesson_files_item_idx on public.lms_lesson_files (item_id);

-- ================================================================ 4. progress
create table public.lms_progress (
  user_id          uuid not null references public.profiles (id) on delete cascade,
  lesson_id        uuid not null,
  course_id        text not null,
  position_seconds integer not null default 0 check (position_seconds between 0 and 86400),
  completed        boolean not null default false,
  completed_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint lms_progress_pkey primary key (user_id, lesson_id),
  constraint lms_progress_lesson_fkey foreign key (course_id, lesson_id)
    references public.lms_lessons (course_id, id) on update restrict on delete cascade,
  constraint lms_progress_done_chk check ((completed and completed_at is not null) or (not completed))
);
create index lms_progress_course_user_idx on public.lms_progress (course_id, user_id);

-- ================================================================ 5. triggers
create trigger lms_modules_set_updated_at  before update on public.lms_modules  for each row execute function private.set_updated_at();
create trigger lms_lessons_set_updated_at  before update on public.lms_lessons  for each row execute function private.set_updated_at();

-- a lesson's video/file items must belong to the SAME course and have the right kind
create or replace function private.lms_lessons_before()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and (new.course_id is distinct from old.course_id or new.module_id is distinct from old.module_id)
     and not exists (select 1 from public.lms_modules m where m.id = new.module_id and m.course_id = new.course_id) then
    raise exception 'module does not belong to the lesson course' using errcode = '23514';
  end if;
  if new.video_item_id is not null and not exists (
       select 1 from public.course_items i where i.id = new.video_item_id and i.course_id = new.course_id and i.kind = 'video') then
    raise exception 'video item must be a video of the same course' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger lms_lessons_before before insert or update on public.lms_lessons for each row execute function private.lms_lessons_before();

create or replace function private.lms_lesson_files_before()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (select 1 from public.lms_lessons l join public.course_items i on i.course_id = l.course_id
                  where l.id = new.lesson_id and i.id = new.item_id and i.kind = 'file') then
    raise exception 'file item must be a file of the same course as the lesson' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger lms_lesson_files_before before insert or update on public.lms_lesson_files for each row execute function private.lms_lesson_files_before();

-- ================================================================ 6. RLS
do $$
declare t text;
begin
  foreach t in array array['lms_modules', 'lms_lessons', 'lms_lesson_files', 'lms_progress'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
  end loop;
end $$;

grant select, insert, update, delete on public.lms_modules, public.lms_lessons, public.lms_lesson_files to authenticated;
grant select on public.lms_progress to authenticated;   -- writes only via lms_save_progress()

create policy lms_modules_select on public.lms_modules for select to authenticated
  using ((select private.is_admin()) or (published and private.has_course_access(course_id)));
create policy lms_modules_insert on public.lms_modules for insert to authenticated with check ((select private.is_admin()));
create policy lms_modules_update on public.lms_modules for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));
create policy lms_modules_delete on public.lms_modules for delete to authenticated using ((select private.is_admin()));

create policy lms_lessons_select on public.lms_lessons for select to authenticated
  using ((select private.is_admin())
         or (published and private.has_course_access(course_id)
             and exists (select 1 from public.lms_modules m where m.id = module_id and m.published)));
create policy lms_lessons_insert on public.lms_lessons for insert to authenticated with check ((select private.is_admin()));
create policy lms_lessons_update on public.lms_lessons for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));
create policy lms_lessons_delete on public.lms_lessons for delete to authenticated using ((select private.is_admin()));

create policy lms_lesson_files_select on public.lms_lesson_files for select to authenticated
  using ((select private.is_admin()) or exists (select 1 from public.lms_lessons l where l.id = lesson_id));
create policy lms_lesson_files_insert on public.lms_lesson_files for insert to authenticated with check ((select private.is_admin()));
create policy lms_lesson_files_update on public.lms_lesson_files for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));
create policy lms_lesson_files_delete on public.lms_lesson_files for delete to authenticated using ((select private.is_admin()));

create policy lms_progress_select on public.lms_progress for select to authenticated
  using (user_id = (select auth.uid()) or (select private.is_admin()));

-- ================================================================ 7. save progress (the only write path)
-- Position is clamped, "completed" is sticky (once true it never goes back), rows exist only for lessons the caller may see.
create or replace function private.lms_save_progress(p_lesson_id uuid, p_position integer, p_completed boolean default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  l     public.lms_lessons;
  pr    public.lms_progress;
  v_pos integer;
begin
  if v_uid is null or not exists (select 1 from public.profiles p where p.id = v_uid and p.status = 'active') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into l from public.lms_lessons x where x.id = p_lesson_id;
  if not found or not l.published
     or not exists (select 1 from public.lms_modules m where m.id = l.module_id and m.published)
     or not private.has_course_access(l.course_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_position is null or p_position < 0 then
    raise exception 'invalid position' using errcode = '22023';
  end if;
  v_pos := least(p_position, coalesce(l.duration_seconds, 86400), 86400);
  insert into public.lms_progress as t (user_id, lesson_id, course_id, position_seconds, completed, completed_at)
  values (v_uid, l.id, l.course_id, v_pos, coalesce(p_completed, false), case when coalesce(p_completed, false) then now() end)
  on conflict (user_id, lesson_id) do update
    set position_seconds = excluded.position_seconds,
        completed = t.completed or excluded.completed,
        completed_at = case when t.completed then t.completed_at when excluded.completed then now() end,
        updated_at = now()
  returning * into pr;
  return jsonb_build_object('lesson_id', pr.lesson_id, 'position_seconds', pr.position_seconds, 'completed', pr.completed);
end;
$$;

create or replace function public.lms_save_progress(p_lesson_id uuid, p_position integer, p_completed boolean default null)
returns jsonb language sql volatile set search_path = '' as $$ select private.lms_save_progress(p_lesson_id, p_position, p_completed); $$;

revoke execute on function private.lms_lessons_before()                                from public, anon, authenticated;
revoke execute on function private.lms_lesson_files_before()                           from public, anon, authenticated;
revoke execute on function private.lms_save_progress(uuid, integer, boolean)           from public, anon, authenticated;
revoke execute on function public.lms_save_progress(uuid, integer, boolean)            from public, anon, authenticated;
grant  execute on function private.lms_save_progress(uuid, integer, boolean)           to authenticated;
grant  execute on function public.lms_save_progress(uuid, integer, boolean)            to authenticated;

-- ROLLBACK: docs/lms/rollback-016.sql
