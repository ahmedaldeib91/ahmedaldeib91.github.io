-- 020_assignments_discussions  (LMS phase 3: assignments with file submissions + course discussions)
-- ADDITIVE: new tables, a private storage bucket and RPCs only. Requires 009 (has_staff_perm, rl_hit) and 016 (lms_modules/lessons).
--
-- ASSIGNMENTS   asg_assignments (admin writes; trainees read the published ones of their courses)
--               asg_submissions (one per trainee per assignment) + asg_files (uploads to the private bucket "assignment-files")
--   Trainees NEVER write the tables directly: asg_save_submission() validates everything (enrollment, deadline, file paths/counts/sizes/types,
--   that each object really exists) and asg_grade() (staff with the 'grading' permission, or admin) scores / returns a submission.
--   status: draft -> submitted -> graded | returned (returned = staff asks for a revision; the trainee edits and resubmits).
--   A graded submission is locked. Late submissions are flagged (is_late) or refused when allow_late = false.
--   Files: path "<course_id>/<assignment_id>/<user_id>/<uuid>-<name>"; a trainee reads/uploads/deletes only inside his own folder;
--   grading staff read every folder of their course.
-- DISCUSSIONS   dsc_threads / dsc_posts: tables are closed (admin read only); everything goes through RPCs that return author NAMES
--   (profiles are not readable by other trainees) and enforce access (enrolled trainee, or staff), locks, rate limits and soft deletion.

-- ================================================================ 1. assignments
create table public.asg_assignments (
  id              uuid primary key default gen_random_uuid(),
  course_id       text not null references public.courses (id) on update restrict on delete restrict,
  module_id       uuid,
  title_ar        text not null check (char_length(btrim(title_ar)) between 1 and 300),
  instructions_ar text check (instructions_ar is null or char_length(instructions_ar) <= 10000),
  due_at          timestamptz,
  max_score       numeric(6,2) not null default 100 check (max_score > 0 and max_score <= 1000),
  allow_late      boolean not null default true,
  allow_text      boolean not null default true,
  allow_files     boolean not null default true,
  max_files       integer not null default 3 check (max_files between 1 and 5),
  published       boolean not null default false,
  created_by      uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint asg_assignments_course_id_id_key unique (course_id, id),
  constraint asg_assignments_mode_chk check (allow_text or allow_files),
  constraint asg_assignments_module_fkey foreign key (course_id, module_id)
    references public.lms_modules (course_id, id) on update restrict on delete set null (module_id)
);
create index asg_assignments_course_idx on public.asg_assignments (course_id, due_at);
create index asg_assignments_created_by_idx on public.asg_assignments (created_by);

create table public.asg_submissions (
  id            uuid primary key default gen_random_uuid(),
  assignment_id uuid not null,
  course_id     text not null,
  user_id       uuid not null references public.profiles (id) on delete cascade,
  body          text check (body is null or char_length(body) <= 20000),
  status        text not null default 'draft' check (status in ('draft', 'submitted', 'graded', 'returned')),
  submitted_at  timestamptz,
  is_late       boolean not null default false,
  score         numeric(6,2) check (score is null or score >= 0),
  feedback      text check (feedback is null or char_length(feedback) <= 5000),
  graded_by     uuid references public.profiles (id) on delete set null,
  graded_at     timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint asg_submissions_user_assignment_key unique (assignment_id, user_id),
  constraint asg_submissions_assignment_fkey foreign key (course_id, assignment_id)
    references public.asg_assignments (course_id, id) on update restrict on delete cascade
);
create index asg_submissions_course_status_idx on public.asg_submissions (course_id, status);
create index asg_submissions_user_idx on public.asg_submissions (user_id);
create index asg_submissions_graded_by_idx on public.asg_submissions (graded_by);

create table public.asg_files (
  id            uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.asg_submissions (id) on delete cascade,
  storage_path  text not null unique check (char_length(storage_path) <= 600 and position('..' in storage_path) = 0),
  file_name     text not null check (char_length(file_name) between 1 and 200),
  size_bytes    bigint not null check (size_bytes between 1 and 20971520),
  mime          text not null check (char_length(mime) <= 120),
  created_at    timestamptz not null default now()
);
create index asg_files_submission_idx on public.asg_files (submission_id);

create trigger asg_assignments_set_updated_at before update on public.asg_assignments for each row execute function private.set_updated_at();
create trigger asg_submissions_set_updated_at before update on public.asg_submissions for each row execute function private.set_updated_at();

-- ================================================================ 2. discussions
create table public.dsc_threads (
  id           uuid primary key default gen_random_uuid(),
  course_id    text not null references public.courses (id) on update restrict on delete restrict,
  lesson_id    uuid,
  title        text not null check (char_length(btrim(title)) between 1 and 200),
  body         text not null check (char_length(btrim(body)) between 1 and 10000),
  author_id    uuid references public.profiles (id) on delete set null,
  pinned       boolean not null default false,
  locked       boolean not null default false,
  deleted      boolean not null default false,
  post_count   integer not null default 0,
  last_post_at timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  constraint dsc_threads_course_id_id_key unique (course_id, id),
  constraint dsc_threads_lesson_fkey foreign key (course_id, lesson_id)
    references public.lms_lessons (course_id, id) on update restrict on delete set null (lesson_id)
);
create index dsc_threads_course_idx on public.dsc_threads (course_id, pinned desc, last_post_at desc);
create index dsc_threads_author_idx on public.dsc_threads (author_id);

create table public.dsc_posts (
  id         uuid primary key default gen_random_uuid(),
  thread_id  uuid not null,
  course_id  text not null,
  author_id  uuid references public.profiles (id) on delete set null,
  body       text not null check (char_length(btrim(body)) between 1 and 10000),
  deleted    boolean not null default false,
  created_at timestamptz not null default now(),
  constraint dsc_posts_thread_fkey foreign key (course_id, thread_id)
    references public.dsc_threads (course_id, id) on update restrict on delete cascade
);
create index dsc_posts_thread_idx on public.dsc_posts (thread_id, created_at);
create index dsc_posts_author_idx on public.dsc_posts (author_id);

-- ================================================================ 3. RLS
do $$
declare t text;
begin
  foreach t in array array['asg_assignments', 'asg_submissions', 'asg_files', 'dsc_threads', 'dsc_posts'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;
grant insert, update, delete on public.asg_assignments to authenticated;

create policy asg_assignments_select on public.asg_assignments for select to authenticated
  using ((select private.is_admin()) or private.has_staff_perm(course_id, 'grading') or (published and private.has_course_access(course_id)));
create policy asg_assignments_insert on public.asg_assignments for insert to authenticated with check ((select private.is_admin()));
create policy asg_assignments_update on public.asg_assignments for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));
create policy asg_assignments_delete on public.asg_assignments for delete to authenticated using ((select private.is_admin()));

create policy asg_submissions_select on public.asg_submissions for select to authenticated
  using (user_id = (select auth.uid()) or private.has_staff_perm(course_id, 'grading'));
create policy asg_files_select on public.asg_files for select to authenticated
  using (exists (select 1 from public.asg_submissions s where s.id = submission_id
                 and (s.user_id = (select auth.uid()) or private.has_staff_perm(s.course_id, 'grading'))));
create policy dsc_threads_admin_select on public.dsc_threads for select to authenticated using ((select private.is_admin()));
create policy dsc_posts_admin_select on public.dsc_posts for select to authenticated using ((select private.is_admin()));

-- ================================================================ 4. storage bucket
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('assignment-files', 'assignment-files', false, 20971520,
        array['application/pdf', 'application/zip', 'image/png', 'image/jpeg', 'text/plain',
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              'application/vnd.openxmlformats-officedocument.presentationml.presentation'])
on conflict (id) do update
  set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create policy p20_asg_files_select on storage.objects for select to authenticated
  using (bucket_id = 'assignment-files'
         and (((storage.foldername(name))[3] = (select auth.uid())::text and private.has_course_access((storage.foldername(name))[1]))
              or private.has_staff_perm((storage.foldername(name))[1], 'grading')));
create policy p20_asg_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'assignment-files'
              and (storage.foldername(name))[3] = (select auth.uid())::text
              and private.has_course_access((storage.foldername(name))[1])
              and exists (select 1 from public.asg_assignments a
                          where a.id::text = (storage.foldername(name))[2] and a.course_id = (storage.foldername(name))[1] and a.published));
-- the owner may delete only objects that no submitted/graded submission references (evidence of a submission cannot be destroyed)
create policy p20_asg_files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'assignment-files' and (storage.foldername(name))[3] = (select auth.uid())::text
         and not exists (select 1 from public.asg_files f join public.asg_submissions sb on sb.id = f.submission_id
                         where f.storage_path = name and sb.status in ('submitted', 'graded')));

-- ================================================================ 5. assignments RPCs
create or replace function private.asg_save_submission(p_assignment_id uuid, p_body text, p_files jsonb default '[]'::jsonb, p_submit boolean default false)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := (select auth.uid());
  a       public.asg_assignments;
  s       public.asg_submissions;
  v_body  text := nullif(btrim(coalesce(p_body, '')), '');
  v_pref  text;
  v_f     jsonb;
  v_late  boolean;
  v_paths text[] := array[]::text[];
  v_mimes constant text[] := array['application/pdf', 'application/zip', 'image/png', 'image/jpeg', 'text/plain',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation'];
  v_n     integer;
begin
  if v_uid is null or not exists (select 1 from public.profiles p where p.id = v_uid and p.status = 'active') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into a from public.asg_assignments x where x.id = p_assignment_id;
  if not found or not a.published or not private.has_course_access(a.course_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform private.rl_hit('asg_save:' || v_uid::text, 60, 60);
  select * into s from public.asg_submissions x where x.assignment_id = a.id and x.user_id = v_uid for update;
  if found and s.status = 'graded' then
    raise exception 'this submission is graded and locked' using errcode = '55000';
  end if;
  if v_body is not null and (not a.allow_text or char_length(v_body) > 20000) then
    raise exception 'text is not allowed or too long' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_files, '[]'::jsonb)) <> 'array' then
    raise exception 'files must be an array' using errcode = '22023';
  end if;
  v_n := jsonb_array_length(coalesce(p_files, '[]'::jsonb));
  if v_n > a.max_files or (v_n > 0 and not a.allow_files) then
    raise exception 'too many files or files not allowed' using errcode = '22023';
  end if;
  v_pref := a.course_id || '/' || a.id::text || '/' || v_uid::text || '/';
  for v_f in select e from jsonb_array_elements(coalesce(p_files, '[]'::jsonb)) e loop
    if jsonb_typeof(v_f) <> 'object' or jsonb_typeof(v_f -> 'path') is distinct from 'string'
       or jsonb_typeof(v_f -> 'name') is distinct from 'string' or jsonb_typeof(v_f -> 'size') is distinct from 'number'
       or jsonb_typeof(v_f -> 'mime') is distinct from 'string' then
      raise exception 'invalid file entry' using errcode = '22023';
    end if;
    if left(v_f ->> 'path', char_length(v_pref)) <> v_pref or position('..' in v_f ->> 'path') > 0
       or char_length(v_f ->> 'path') > 600 or (v_f ->> 'path') = any (v_paths)
       or char_length(btrim(v_f ->> 'name')) not between 1 and 200
       or (v_f ->> 'size')::numeric not between 1 and 20971520 or (v_f ->> 'size')::numeric <> trunc((v_f ->> 'size')::numeric)
       or not ((v_f ->> 'mime') = any (v_mimes)) then
      raise exception 'invalid file entry' using errcode = '22023';
    end if;
    if not exists (select 1 from storage.objects o where o.bucket_id = 'assignment-files' and o.name = v_f ->> 'path') then
      raise exception 'file was not uploaded' using errcode = '22023';
    end if;
    v_paths := v_paths || (v_f ->> 'path');
  end loop;
  if p_submit and v_body is null and v_n = 0 then
    raise exception 'nothing to submit' using errcode = '22023';
  end if;
  v_late := a.due_at is not null and now() > a.due_at;
  -- past the deadline with late work refused: no save of any kind (draft or edit of a submitted one); a returned one may be fixed
  if v_late and not a.allow_late and (s.id is null or s.status <> 'returned') then
    raise exception 'assignment is closed' using errcode = '55000';
  end if;

  if s.id is null then
    insert into public.asg_submissions (assignment_id, course_id, user_id, body, status, submitted_at, is_late)
    values (a.id, a.course_id, v_uid, v_body, case when p_submit then 'submitted' else 'draft' end,
            case when p_submit then now() end, p_submit and v_late)
    returning * into s;
  else
    update public.asg_submissions x
       set body = v_body,
           status = case when p_submit then 'submitted' else x.status end,
           submitted_at = case when p_submit then now() else x.submitted_at end,
           is_late = case when p_submit then v_late else (x.is_late or (x.status = 'submitted' and v_late)) end,  -- content changed after the deadline
           score = case when p_submit then null else x.score end,
           graded_by = case when p_submit then null else x.graded_by end,
           graded_at = case when p_submit then null else x.graded_at end
     where x.id = s.id returning * into s;
  end if;
  delete from public.asg_files f where f.submission_id = s.id and not (f.storage_path = any (v_paths));
  for v_f in select e from jsonb_array_elements(coalesce(p_files, '[]'::jsonb)) e loop
    insert into public.asg_files (submission_id, storage_path, file_name, size_bytes, mime)
    values (s.id, v_f ->> 'path', btrim(v_f ->> 'name'), (v_f ->> 'size')::bigint, v_f ->> 'mime')
    on conflict (storage_path) do nothing;
  end loop;
  return jsonb_build_object('submission_id', s.id, 'status', s.status, 'is_late', s.is_late, 'files', v_n);
end;
$$;

create or replace function private.asg_grade(p_submission_id uuid, p_score numeric, p_feedback text default null, p_return boolean default false)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  s     public.asg_submissions;
  a     public.asg_assignments;
begin
  select * into s from public.asg_submissions x where x.id = p_submission_id for update;
  if not found or v_uid is null or not private.has_staff_perm(s.course_id, 'grading') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform private.rl_hit('asg_grade:' || v_uid::text, 60, 300);
  if s.status = 'draft' then
    raise exception 'the trainee has not submitted yet' using errcode = '55000';
  end if;
  if p_feedback is not null and char_length(p_feedback) > 5000 then
    raise exception 'feedback too long' using errcode = '22023';
  end if;
  select * into a from public.asg_assignments x where x.id = s.assignment_id;
  if p_return then
    update public.asg_submissions x set status = 'returned', score = null, feedback = nullif(btrim(coalesce(p_feedback, '')), ''),
           graded_by = v_uid, graded_at = now() where x.id = s.id returning * into s;
  else
    if p_score is null or p_score < 0 or p_score > a.max_score then
      raise exception 'score must be between 0 and %', a.max_score using errcode = '22023';
    end if;
    update public.asg_submissions x set status = 'graded', score = round(p_score, 2), feedback = nullif(btrim(coalesce(p_feedback, '')), ''),
           graded_by = v_uid, graded_at = now() where x.id = s.id returning * into s;
  end if;
  return jsonb_build_object('submission_id', s.id, 'status', s.status, 'score', s.score, 'max_score', a.max_score);
end;
$$;

-- ================================================================ 6. discussions RPCs
create or replace function private.dsc_can_read(p_course_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
     and (private.has_course_access(p_course_id) or private.has_staff_perm(p_course_id, 'grading'));
$$;

create or replace function private.dsc_list_threads(p_course_id text, p_lesson_id uuid default null, p_limit integer default 50, p_offset integer default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.dsc_can_read(p_course_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(q.j order by q.pinned desc, q.last_post_at desc)
    from (select t.pinned, t.last_post_at, jsonb_build_object(
            'id', t.id, 'title', t.title, 'lesson_id', t.lesson_id, 'pinned', t.pinned, 'locked', t.locked, 'post_count', t.post_count,
            'last_post_at', t.last_post_at, 'created_at', t.created_at,
            'author', coalesce(nullif(p.full_name, ''), 'مستخدم'), 'is_staff', coalesce(p.role = 'admin', false),
            'mine', t.author_id = (select auth.uid())) as j
          from public.dsc_threads t left join public.profiles p on p.id = t.author_id
          where t.course_id = p_course_id and not t.deleted and (p_lesson_id is null or t.lesson_id = p_lesson_id)
          order by t.pinned desc, t.last_post_at desc
          limit least(greatest(coalesce(p_limit, 50), 1), 100) offset greatest(coalesce(p_offset, 0), 0)) q), '[]'::jsonb);
end;
$$;

create or replace function private.dsc_get_thread(p_thread_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  t public.dsc_threads;
begin
  select * into t from public.dsc_threads x where x.id = p_thread_id and not x.deleted;
  if not found or not private.dsc_can_read(t.course_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'thread', jsonb_build_object('id', t.id, 'course_id', t.course_id, 'lesson_id', t.lesson_id, 'title', t.title, 'body', t.body,
       'pinned', t.pinned, 'locked', t.locked, 'created_at', t.created_at, 'post_count', t.post_count,
       'author', (select coalesce(nullif(p.full_name, ''), 'مستخدم') from public.profiles p where p.id = t.author_id),
       'is_staff', coalesce((select p.role = 'admin' from public.profiles p where p.id = t.author_id), false),
       'mine', t.author_id = (select auth.uid())),
    'can_moderate', private.has_staff_perm(t.course_id, 'grading'),
    'posts', coalesce((
      select jsonb_agg(jsonb_build_object('id', x.id, 'body', case when x.deleted then null else x.body end, 'deleted', x.deleted, 'created_at', x.created_at,
             'author', coalesce(nullif(p.full_name, ''), 'مستخدم'), 'is_staff', coalesce(p.role = 'admin', false),
             'mine', x.author_id = (select auth.uid())) order by x.created_at)
      from (select * from public.dsc_posts d where d.thread_id = t.id order by d.created_at limit 500) x
      left join public.profiles p on p.id = x.author_id), '[]'::jsonb));
end;
$$;

create or replace function private.dsc_create_thread(p_course_id text, p_lesson_id uuid, p_title text, p_body text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_id  uuid;
begin
  if v_uid is null or not exists (select 1 from public.profiles p where p.id = v_uid and p.status = 'active') or not private.dsc_can_read(p_course_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform private.rl_hit('dsc_thread:' || v_uid::text, 3600, 10);
  if char_length(btrim(coalesce(p_title, ''))) not between 1 and 200 or char_length(btrim(coalesce(p_body, ''))) not between 1 and 10000 then
    raise exception 'title (1..200) and body (1..10000) are required' using errcode = '22023';
  end if;
  if p_lesson_id is not null and not exists (select 1 from public.lms_lessons l where l.id = p_lesson_id and l.course_id = p_course_id) then
    raise exception 'unknown lesson' using errcode = '22023';
  end if;
  insert into public.dsc_threads (course_id, lesson_id, title, body, author_id)
  values (p_course_id, p_lesson_id, btrim(p_title), btrim(p_body), v_uid) returning id into v_id;
  return jsonb_build_object('thread_id', v_id);
end;
$$;

create or replace function private.dsc_reply(p_thread_id uuid, p_body text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  t     public.dsc_threads;
  v_id  uuid;
begin
  select * into t from public.dsc_threads x where x.id = p_thread_id and not x.deleted for update;
  if not found or v_uid is null or not exists (select 1 from public.profiles p where p.id = v_uid and p.status = 'active') or not private.dsc_can_read(t.course_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform private.rl_hit('dsc_post:' || v_uid::text, 600, 30);
  if t.locked and not private.has_staff_perm(t.course_id, 'grading') then
    raise exception 'thread is locked' using errcode = '55000';
  end if;
  if char_length(btrim(coalesce(p_body, ''))) not between 1 and 10000 then
    raise exception 'body (1..10000) is required' using errcode = '22023';
  end if;
  insert into public.dsc_posts (thread_id, course_id, author_id, body) values (t.id, t.course_id, v_uid, btrim(p_body)) returning id into v_id;
  update public.dsc_threads x set post_count = x.post_count + 1, last_post_at = now() where x.id = t.id;
  return jsonb_build_object('post_id', v_id);
end;
$$;

-- soft delete: the author (own thread/post) or grading staff
create or replace function private.dsc_delete(p_kind text, p_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  t     public.dsc_threads;
  po    public.dsc_posts;
begin
  if v_uid is null then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_kind = 'thread' then
    select * into t from public.dsc_threads x where x.id = p_id for update;
    if not found or not (t.author_id = v_uid or private.has_staff_perm(t.course_id, 'grading')) then raise exception 'forbidden' using errcode = '42501'; end if;
    update public.dsc_threads x set deleted = true where x.id = t.id;
  elsif p_kind = 'post' then
    select * into po from public.dsc_posts x where x.id = p_id for update;
    if not found or not (po.author_id = v_uid or private.has_staff_perm(po.course_id, 'grading')) then raise exception 'forbidden' using errcode = '42501'; end if;
    update public.dsc_posts x set deleted = true where x.id = po.id;
  else
    raise exception 'kind must be thread | post' using errcode = '22023';
  end if;
  return jsonb_build_object('deleted', true);
end;
$$;

create or replace function private.dsc_moderate_thread(p_thread_id uuid, p_pinned boolean default null, p_locked boolean default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  t public.dsc_threads;
begin
  select * into t from public.dsc_threads x where x.id = p_thread_id for update;
  if not found or (select auth.uid()) is null or not private.has_staff_perm(t.course_id, 'grading') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update public.dsc_threads x set pinned = coalesce(p_pinned, x.pinned), locked = coalesce(p_locked, x.locked) where x.id = t.id returning * into t;
  return jsonb_build_object('pinned', t.pinned, 'locked', t.locked);
end;
$$;

-- ================================================================ 7. REST wrappers + privileges
create or replace function public.asg_save_submission(p_assignment_id uuid, p_body text, p_files jsonb default '[]'::jsonb, p_submit boolean default false)
returns jsonb language sql volatile set search_path = '' as $$ select private.asg_save_submission(p_assignment_id, p_body, p_files, p_submit); $$;
create or replace function public.asg_grade(p_submission_id uuid, p_score numeric, p_feedback text default null, p_return boolean default false)
returns jsonb language sql volatile set search_path = '' as $$ select private.asg_grade(p_submission_id, p_score, p_feedback, p_return); $$;
create or replace function public.dsc_list_threads(p_course_id text, p_lesson_id uuid default null, p_limit integer default 50, p_offset integer default 0)
returns jsonb language sql stable set search_path = '' as $$ select private.dsc_list_threads(p_course_id, p_lesson_id, p_limit, p_offset); $$;
create or replace function public.dsc_get_thread(p_thread_id uuid)
returns jsonb language sql stable set search_path = '' as $$ select private.dsc_get_thread(p_thread_id); $$;
create or replace function public.dsc_create_thread(p_course_id text, p_lesson_id uuid, p_title text, p_body text)
returns jsonb language sql volatile set search_path = '' as $$ select private.dsc_create_thread(p_course_id, p_lesson_id, p_title, p_body); $$;
create or replace function public.dsc_reply(p_thread_id uuid, p_body text)
returns jsonb language sql volatile set search_path = '' as $$ select private.dsc_reply(p_thread_id, p_body); $$;
create or replace function public.dsc_delete(p_kind text, p_id uuid)
returns jsonb language sql volatile set search_path = '' as $$ select private.dsc_delete(p_kind, p_id); $$;
create or replace function public.dsc_moderate_thread(p_thread_id uuid, p_pinned boolean default null, p_locked boolean default null)
returns jsonb language sql volatile set search_path = '' as $$ select private.dsc_moderate_thread(p_thread_id, p_pinned, p_locked); $$;

do $$
declare f text;
begin
  foreach f in array array[
    'asg_save_submission(uuid, text, jsonb, boolean)', 'asg_grade(uuid, numeric, text, boolean)',
    'dsc_list_threads(text, uuid, integer, integer)', 'dsc_get_thread(uuid)', 'dsc_create_thread(text, uuid, text, text)',
    'dsc_reply(uuid, text)', 'dsc_delete(text, uuid)', 'dsc_moderate_thread(uuid, boolean, boolean)'] loop
    execute format('revoke execute on function private.%s from public, anon, authenticated', f);
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function private.%s to authenticated', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
revoke execute on function private.dsc_can_read(text) from public, anon, authenticated;
-- dsc_can_read is only called from inside the SECURITY DEFINER RPCs above (no grant needed)

-- ROLLBACK: docs/lms/rollback-020.sql
