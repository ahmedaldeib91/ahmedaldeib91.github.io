-- 011_exam_builder  (Exams system, milestone M3a: database side of the exam builder)
-- Design spec: docs/exams/01-analysis-and-plan.md sections 3.1, 4.5, 4.10, 5.4. Docs: docs/exams/04-M3a-database.md.
-- Requires 009 + 010.
--
-- ADDITIVE ONLY. No object of 001..010 is altered or dropped. New FKs point INTO existing tables
-- (courses, course_folders, qb_questions, qb_question_versions, qb_taxonomy, qb_tags, qb_question_types,
-- profiles) with ON DELETE RESTRICT, so a bank row used by an exam can no longer be deleted (intended).
-- No new staff permission key: exam.write / exam.publish already exist in private.staff_permission_keys().
--
-- Contents
--   1. public.ex_course_settings      per-course config (publish_requires_approval, default TRUE)
--   2. public.ex_exams                draft header + typed settings (CHECK constraints) + workflow state
--      public.ex_exam_items           fixed picks (question_id, position, points override, weight)
--      public.ex_exam_rules           random quotas (taxonomy subtree / difficulty / type / tag, count, points_each)
--   3. public.ex_exam_versions        IMMUTABLE publish snapshot (frozen settings + totals)
--      public.ex_exam_version_items   fixed picks pinned to the question VERSION current at publish time
--      public.ex_exam_version_rules   frozen rules + pool size
--      public.ex_exam_version_pool    frozen, rule-disjoint candidate pool M4 draws from at attempt start
--   4. triggers: freeze (a non-draft exam and its composition cannot change), legal status transitions,
--      immutability of versions, audit_log
--   5. RPCs (SECURITY DEFINER private.* + SECURITY INVOKER public.* wrappers, rate-limited):
--      exam_save, exam_preview_pool (counts only), exam_publish, exam_request_approval, exam_approve,
--      exam_reject, exam_withdraw, exam_pause, exam_resume, exam_unpublish, exam_archive, exam_unarchive
--   6. grants + RLS: default deny; admin + course staff with exam.write|exam.publish read; all writes via
--      RPC (except admin config and deleting a never-published draft). Trainees and anon: nothing.
--
-- Publishing model
--   * Editing happens only in status 'draft'. Publishing FREEZES the exam into a new ex_exam_versions row
--     (version_no 1, 2, ...). The draft row stays locked while pending_approval / published / paused.
--     To change a published exam: unpublish (-> draft), edit, publish again (-> version n+1). Attempts
--     (M4) reference a version, so earlier attempts never change.
--   * "Can publish directly" = admin, OR staff with exam.publish on a course whose
--     ex_course_settings.publish_requires_approval = false (no row = true = approval required).
--     Anyone else with exam.write who calls exam_publish is routed to pending_approval.
--   * Approve / reject = admin only. Approval re-runs every validation against the bank as it is NOW.
--   * Random rules use FIRST-MATCH-WINS: a question matching several rules belongs to the first one
--     (by position) only, and fixed picks are excluded from every pool, so the frozen pools are disjoint
--     and M4 can draw each rule independently without duplicates.

-- ================================================================ 1. per-course exam settings
create table public.ex_course_settings (
  course_id                  text primary key references public.courses (id) on update cascade on delete cascade,
  publish_requires_approval  boolean not null default true,
  updated_by                 uuid references public.profiles (id) on delete set null,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now()
);
create index ex_course_settings_updated_by_idx on public.ex_course_settings (updated_by);

-- ================================================================ 2. exams (draft + settings + workflow)
-- security jsonb: exactly {monitoring bool, max_warnings int 0..50, on_exceed log|warn|flag|auto_submit,
-- fullscreen_required bool, watermark bool}; fullscreen_required or on_exceed<>'log' need monitoring.
create or replace function private.ex_security_ok(s jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
begin
  if s is null or jsonb_typeof(s) <> 'object' then
    return false;
  end if;
  if exists (select 1 from jsonb_object_keys(s) k
             where k not in ('monitoring', 'max_warnings', 'on_exceed', 'fullscreen_required', 'watermark'))
     or jsonb_typeof(s -> 'monitoring') is distinct from 'boolean'
     or jsonb_typeof(s -> 'fullscreen_required') is distinct from 'boolean'
     or jsonb_typeof(s -> 'watermark') is distinct from 'boolean'
     or jsonb_typeof(s -> 'max_warnings') is distinct from 'number'
     or jsonb_typeof(s -> 'on_exceed') is distinct from 'string' then
    return false;
  end if;
  if (s ->> 'max_warnings')::numeric not between 0 and 50
     or (s ->> 'max_warnings')::numeric <> trunc((s ->> 'max_warnings')::numeric)
     or (s ->> 'on_exceed') not in ('log', 'warn', 'flag', 'auto_submit') then
    return false;
  end if;
  if not (s ->> 'monitoring')::boolean
     and ((s ->> 'fullscreen_required')::boolean or (s ->> 'on_exceed') <> 'log') then
    return false;
  end if;
  return true;
end;
$$;

-- Policies (who sees what, when):  never | always (during the attempt, practice only) | after_submit |
-- after_close (after close_at) | manual (released by staff, M4+).
create table public.ex_exams (
  id                   uuid primary key default gen_random_uuid(),
  course_id            text not null references public.courses (id) on update restrict on delete restrict,
  folder_kind          text not null check (folder_kind in ('domain_tests', 'exam_simulations')),
  exam_kind            text not null check (exam_kind in ('practice', 'simulation', 'final')),
  title_ar             text not null check (char_length(btrim(title_ar)) between 1 and 300),
  title_en             text check (title_en is null or char_length(title_en) <= 300),
  description_ar       text check (description_ar is null or char_length(description_ar) <= 5000),
  description_en       text check (description_en is null or char_length(description_en) <= 5000),
  scope_taxonomy_id    uuid,
  status               text not null default 'draft'
                       check (status in ('draft', 'pending_approval', 'published', 'paused', 'archived')),
  -- timing / attempts / passing
  duration_minutes     integer check (duration_minutes is null or duration_minutes between 1 and 1440),
  open_at              timestamptz,
  close_at             timestamptz,
  grace_seconds        integer not null default 30 check (grace_seconds between 0 and 600),
  max_attempts         integer check (max_attempts is null or max_attempts between 1 and 100),
  pass_percent         numeric(5,2) check (pass_percent is null or (pass_percent > 0 and pass_percent <= 100)),
  pass_score           numeric(10,2) check (pass_score is null or pass_score > 0),
  -- delivery
  shuffle_questions    boolean not null default true,
  shuffle_options      boolean not null default true,
  allow_back           boolean not null default true,
  allow_flag           boolean not null default true,
  review_policy        text not null default 'never'
                       check (review_policy in ('never', 'after_submit', 'after_close', 'manual')),
  result_policy        text not null default 'after_submit'
                       check (result_policy in ('never', 'after_submit', 'after_close', 'manual')),
  feedback_policy      text not null default 'never'
                       check (feedback_policy in ('never', 'always', 'after_submit', 'after_close', 'manual')),
  explanation_policy   text not null default 'never'
                       check (explanation_policy in ('never', 'always', 'after_submit', 'after_close', 'manual')),
  allow_whiteboard     boolean not null default false,
  allow_calculator     boolean not null default false,
  allow_translation    boolean not null default false,
  security             jsonb not null default
                       '{"monitoring":false,"max_warnings":3,"on_exceed":"log","fullscreen_required":false,"watermark":false}'::jsonb,
  timeout_policy       text not null default 'auto_submit' check (timeout_policy in ('auto_submit', 'void')),
  resume_policy        text not null default 'resume_any_device'
                       check (resume_policy in ('resume_any_device', 'resume_same_session', 'no_resume')),
  -- derived (server-computed, never client-written)
  question_count       integer not null default 0 check (question_count >= 0),
  total_score          numeric(10,2) not null default 0 check (total_score >= 0),
  -- workflow
  published_version_id uuid,
  published_at         timestamptz,
  published_by         uuid references public.profiles (id) on delete set null,
  requested_by         uuid references public.profiles (id) on delete set null,
  requested_at         timestamptz,
  reviewed_by          uuid references public.profiles (id) on delete set null,
  reviewed_at          timestamptz,
  review_note          text check (review_note is null or char_length(review_note) <= 2000),
  created_by           uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint ex_exams_course_id_id_key unique (course_id, id),
  -- the exam lives in one of the course's logical folders (course_folders.unique(course_id, kind))
  constraint ex_exams_folder_fkey foreign key (course_id, folder_kind)
    references public.course_folders (course_id, kind) on update restrict on delete restrict,
  constraint ex_exams_scope_fkey foreign key (course_id, scope_taxonomy_id)
    references public.qb_taxonomy (course_id, id) on update restrict on delete restrict,
  constraint ex_exams_window_chk check (open_at is null or close_at is null or close_at > open_at),
  constraint ex_exams_one_pass_rule_chk check (num_nonnulls(pass_percent, pass_score) <= 1),
  constraint ex_exams_always_practice_chk
    check (exam_kind = 'practice' or (feedback_policy <> 'always' and explanation_policy <> 'always')),
  constraint ex_exams_security_chk check (private.ex_security_ok(security))
);
create index ex_exams_course_status_idx on public.ex_exams (course_id, status);
create index ex_exams_folder_idx        on public.ex_exams (course_id, folder_kind);
create index ex_exams_scope_idx         on public.ex_exams (course_id, scope_taxonomy_id);
create index ex_exams_created_by_idx    on public.ex_exams (created_by);
create index ex_exams_published_by_idx  on public.ex_exams (published_by);
create index ex_exams_requested_by_idx  on public.ex_exams (requested_by);
create index ex_exams_reviewed_by_idx   on public.ex_exams (reviewed_by);

create table public.ex_exam_items (
  exam_id      uuid not null,
  course_id    text not null,
  position     integer not null check (position between 1 and 500),
  question_id  uuid not null,
  points       numeric(8,2) check (points is null or (points > 0 and points <= 1000)),   -- null = version points
  weight       numeric(6,2) not null default 1 check (weight > 0 and weight <= 100),
  created_at   timestamptz not null default now(),
  constraint ex_exam_items_pkey primary key (exam_id, position),
  constraint ex_exam_items_exam_question_key unique (exam_id, question_id),
  constraint ex_exam_items_exam_fkey foreign key (course_id, exam_id)
    references public.ex_exams (course_id, id) on update restrict on delete cascade,
  constraint ex_exam_items_question_fkey foreign key (course_id, question_id)
    references public.qb_questions (course_id, id) on update restrict on delete restrict
);
create index ex_exam_items_course_exam_idx     on public.ex_exam_items (course_id, exam_id);
create index ex_exam_items_course_question_idx on public.ex_exam_items (course_id, question_id);

-- one rule = a conjunctive filter; every NULL filter column means "any". taxonomy_id matches the node
-- and all its descendants (domain > topic > subtopic).
create table public.ex_exam_rules (
  id           uuid primary key default gen_random_uuid(),
  exam_id      uuid not null,
  course_id    text not null,
  position     integer not null check (position between 1 and 50),
  taxonomy_id  uuid,
  difficulty   text check (difficulty is null or difficulty in ('easy', 'medium', 'hard')),
  type_code    text references public.qb_question_types (code) on update restrict on delete restrict,
  tag_id       uuid,
  draw_count   integer not null check (draw_count between 1 and 500),
  points_each  numeric(8,2) not null default 1 check (points_each > 0 and points_each <= 1000),
  created_at   timestamptz not null default now(),
  constraint ex_exam_rules_exam_position_key unique (exam_id, position),
  constraint ex_exam_rules_exam_fkey foreign key (course_id, exam_id)
    references public.ex_exams (course_id, id) on update restrict on delete cascade,
  constraint ex_exam_rules_taxonomy_fkey foreign key (course_id, taxonomy_id)
    references public.qb_taxonomy (course_id, id) on update restrict on delete restrict,
  constraint ex_exam_rules_tag_fkey foreign key (course_id, tag_id)
    references public.qb_tags (course_id, id) on update restrict on delete restrict
);
create index ex_exam_rules_course_exam_idx on public.ex_exam_rules (course_id, exam_id);
create index ex_exam_rules_taxonomy_idx    on public.ex_exam_rules (course_id, taxonomy_id);
create index ex_exam_rules_tag_idx         on public.ex_exam_rules (course_id, tag_id);
create index ex_exam_rules_type_idx        on public.ex_exam_rules (type_code);

-- ================================================================ 3. immutable publish snapshot
create table public.ex_exam_versions (
  id              uuid primary key default gen_random_uuid(),
  exam_id         uuid not null,
  course_id       text not null,
  version_no      integer not null check (version_no >= 1),
  settings        jsonb not null check (jsonb_typeof(settings) = 'object'),
  total_score     numeric(10,2) not null check (total_score > 0),
  question_count  integer not null check (question_count between 1 and 500),
  fixed_count     integer not null check (fixed_count >= 0),
  requested_by    uuid references public.profiles (id) on delete set null,
  approved_by     uuid references public.profiles (id) on delete set null,   -- null = published directly
  published_by    uuid references public.profiles (id) on delete set null,
  published_at    timestamptz not null default now(),
  constraint ex_exam_versions_exam_no_key unique (exam_id, version_no),
  constraint ex_exam_versions_exam_id_id_key unique (exam_id, id),
  constraint ex_exam_versions_course_id_id_key unique (course_id, id),
  constraint ex_exam_versions_exam_fkey foreign key (course_id, exam_id)
    references public.ex_exams (course_id, id) on update restrict on delete restrict
);
create index ex_exam_versions_course_exam_idx  on public.ex_exam_versions (course_id, exam_id);
create index ex_exam_versions_requested_by_idx on public.ex_exam_versions (requested_by);
create index ex_exam_versions_approved_by_idx  on public.ex_exam_versions (approved_by);
create index ex_exam_versions_published_by_idx on public.ex_exam_versions (published_by);

alter table public.ex_exams
  add constraint ex_exams_published_version_fkey foreign key (id, published_version_id)
    references public.ex_exam_versions (exam_id, id) on update restrict on delete restrict;
create index ex_exams_published_version_idx on public.ex_exams (id, published_version_id);

create table public.ex_exam_version_items (
  exam_version_id      uuid not null,
  course_id            text not null,
  position             integer not null check (position between 1 and 500),
  question_id          uuid not null,
  question_version_id  uuid not null,
  points               numeric(8,2) not null check (points > 0 and points <= 1000),
  weight               numeric(6,2) not null check (weight > 0 and weight <= 100),
  constraint ex_exam_version_items_pkey primary key (exam_version_id, position),
  constraint ex_exam_version_items_question_key unique (exam_version_id, question_id),
  constraint ex_exam_version_items_version_fkey foreign key (course_id, exam_version_id)
    references public.ex_exam_versions (course_id, id) on update restrict on delete cascade,
  constraint ex_exam_version_items_question_fkey foreign key (course_id, question_id)
    references public.qb_questions (course_id, id) on update restrict on delete restrict,
  -- the pinned version must be a version OF that question
  constraint ex_exam_version_items_qversion_fkey foreign key (question_id, question_version_id)
    references public.qb_question_versions (question_id, id) on update restrict on delete restrict
);
create index ex_exam_version_items_course_version_idx  on public.ex_exam_version_items (course_id, exam_version_id);
create index ex_exam_version_items_course_question_idx on public.ex_exam_version_items (course_id, question_id);
create index ex_exam_version_items_qversion_idx        on public.ex_exam_version_items (question_id, question_version_id);

create table public.ex_exam_version_rules (
  exam_version_id  uuid not null,
  course_id        text not null,
  rule_no          integer not null check (rule_no between 1 and 50),
  taxonomy_id      uuid,
  difficulty       text check (difficulty is null or difficulty in ('easy', 'medium', 'hard')),
  type_code        text references public.qb_question_types (code) on update restrict on delete restrict,
  tag_id           uuid,
  draw_count       integer not null check (draw_count between 1 and 500),
  points_each      numeric(8,2) not null check (points_each > 0 and points_each <= 1000),
  pool_size        integer not null check (pool_size >= draw_count),
  constraint ex_exam_version_rules_pkey primary key (exam_version_id, rule_no),
  constraint ex_exam_version_rules_version_fkey foreign key (course_id, exam_version_id)
    references public.ex_exam_versions (course_id, id) on update restrict on delete cascade,
  constraint ex_exam_version_rules_taxonomy_fkey foreign key (course_id, taxonomy_id)
    references public.qb_taxonomy (course_id, id) on update restrict on delete restrict,
  constraint ex_exam_version_rules_tag_fkey foreign key (course_id, tag_id)
    references public.qb_tags (course_id, id) on update restrict on delete restrict
);
create index ex_exam_version_rules_course_version_idx on public.ex_exam_version_rules (course_id, exam_version_id);
create index ex_exam_version_rules_taxonomy_idx       on public.ex_exam_version_rules (course_id, taxonomy_id);
create index ex_exam_version_rules_tag_idx            on public.ex_exam_version_rules (course_id, tag_id);
create index ex_exam_version_rules_type_idx           on public.ex_exam_version_rules (type_code);

-- unique (exam_version_id, question_id): pools are disjoint across rules (first-match-wins).
create table public.ex_exam_version_pool (
  exam_version_id      uuid not null,
  course_id            text not null,
  rule_no              integer not null,
  question_id          uuid not null,
  question_version_id  uuid not null,
  constraint ex_exam_version_pool_pkey primary key (exam_version_id, rule_no, question_id),
  constraint ex_exam_version_pool_question_key unique (exam_version_id, question_id),
  constraint ex_exam_version_pool_rule_fkey foreign key (exam_version_id, rule_no)
    references public.ex_exam_version_rules (exam_version_id, rule_no) on update restrict on delete cascade,
  constraint ex_exam_version_pool_version_fkey foreign key (course_id, exam_version_id)
    references public.ex_exam_versions (course_id, id) on update restrict on delete cascade,
  constraint ex_exam_version_pool_question_fkey foreign key (course_id, question_id)
    references public.qb_questions (course_id, id) on update restrict on delete restrict,
  constraint ex_exam_version_pool_qversion_fkey foreign key (question_id, question_version_id)
    references public.qb_question_versions (question_id, id) on update restrict on delete restrict
);
create index ex_exam_version_pool_course_version_idx  on public.ex_exam_version_pool (course_id, exam_version_id);
create index ex_exam_version_pool_course_question_idx on public.ex_exam_version_pool (course_id, question_id);
create index ex_exam_version_pool_qversion_idx        on public.ex_exam_version_pool (question_id, question_version_id);

-- lock down immediately (Supabase default privileges grant ALL on new public tables)
do $$
declare t text;
begin
  foreach t in array array['ex_course_settings', 'ex_exams', 'ex_exam_items', 'ex_exam_rules', 'ex_exam_versions',
                           'ex_exam_version_items', 'ex_exam_version_rules', 'ex_exam_version_pool'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
  end loop;
end $$;

-- ================================================================ 4. permission helpers
-- read exams of a course: admin, or staff with exam.write or exam.publish
create or replace function private.ex_can_read(p_course_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.has_staff_perm(p_course_id, 'exam.write') or private.has_staff_perm(p_course_id, 'exam.publish');
$$;

-- no settings row => approval required (safe default)
create or replace function private.ex_publish_requires_approval(p_course_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select s.publish_requires_approval from public.ex_course_settings s where s.course_id = p_course_id), true);
$$;

create or replace function private.ex_can_publish_direct(p_course_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_admin()
      or (private.has_staff_perm(p_course_id, 'exam.publish') and not private.ex_publish_requires_approval(p_course_id));
$$;

-- ================================================================ 4b. triggers
create or replace function private.ex_course_settings_before()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
  else
    new.created_at := old.created_at;
  end if;
  new.updated_by := coalesce((select auth.uid()), new.updated_by);
  new.updated_at := now();
  return new;
end;
$$;

create trigger ex_course_settings_before before insert or update on public.ex_course_settings
  for each row execute function private.ex_course_settings_before();

-- columns that are NOT exam content (may change while the exam is locked, through the RPCs only)
create or replace function private.ex_workflow_columns()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['status', 'published_version_id', 'published_at', 'published_by', 'requested_by', 'requested_at',
               'reviewed_by', 'reviewed_at', 'review_note', 'updated_at', 'total_score', 'question_count']::text[];
$$;

-- freeze + legal status transitions. Runs for every writer, including postgres.
create or replace function private.ex_exams_before()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' or new.published_version_id is not null then
      raise exception 'a new exam must start as a draft without a published version' using errcode = '42501';
    end if;
    new.created_at := now();
    new.updated_at := now();
    return new;
  end if;

  if new.course_id is distinct from old.course_id then
    raise exception 'course_id of an exam cannot change' using errcode = '42501';
  end if;
  new.created_at := old.created_at;
  new.created_by := old.created_by;

  if old.status <> 'draft'
     and (to_jsonb(new) - private.ex_workflow_columns()) is distinct from (to_jsonb(old) - private.ex_workflow_columns()) then
    raise exception 'exam is locked (status %): unpublish it to edit (a new version is created on publish)', old.status
      using errcode = '42501';
  end if;

  if new.status is distinct from old.status then
    if (old.status, new.status) not in (('draft', 'pending_approval'), ('draft', 'published'), ('draft', 'archived'),
                                        ('pending_approval', 'draft'), ('pending_approval', 'published'),
                                        ('published', 'paused'), ('published', 'draft'), ('published', 'archived'),
                                        ('paused', 'published'), ('paused', 'draft'), ('paused', 'archived'),
                                        ('archived', 'draft')) then
      raise exception 'invalid status transition % -> %', old.status, new.status using errcode = '55000';
    end if;
  end if;

  -- a (re)publication must come with a NEW frozen version; nothing else may move the version pointer
  if new.published_version_id is distinct from old.published_version_id
     and not (old.status in ('draft', 'pending_approval') and new.status = 'published') then
    raise exception 'published_version_id changes only when a draft is published' using errcode = '55000';
  end if;
  if new.status = 'published' and old.status in ('draft', 'pending_approval')
     and new.published_version_id is not distinct from old.published_version_id then
    raise exception 'publishing requires a new frozen version' using errcode = '55000';
  end if;
  if new.status in ('published', 'paused') and new.published_version_id is null then
    raise exception 'a published exam needs a published version' using errcode = '55000';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

create trigger ex_exams_before before insert or update on public.ex_exams
  for each row execute function private.ex_exams_before();

-- items/rules change only while the exam is a draft (cascade delete of the whole exam excepted)
create or replace function private.ex_composition_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_status text;
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;
  end if;
  select e.status into v_status from public.ex_exams e
  where e.id = case when tg_op = 'DELETE' then old.exam_id else new.exam_id end;
  if v_status is not null and v_status <> 'draft' then
    raise exception 'exam composition is locked (status %)', v_status using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and new.exam_id is distinct from old.exam_id then
    raise exception 'exam_id cannot change' using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger ex_exam_items_guard before insert or update or delete on public.ex_exam_items
  for each row execute function private.ex_composition_guard();
create trigger ex_exam_rules_guard before insert or update or delete on public.ex_exam_rules
  for each row execute function private.ex_composition_guard();

-- versions and their children: never updated, never deleted (history for attempts / analytics)
create or replace function private.ex_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% rows are immutable (published exam snapshot)', tg_table_name using errcode = '42501';
end;
$$;

create trigger ex_exam_versions_immutable      before update or delete on public.ex_exam_versions
  for each row execute function private.ex_immutable();
create trigger ex_exam_version_items_immutable before update or delete on public.ex_exam_version_items
  for each row execute function private.ex_immutable();
create trigger ex_exam_version_rules_immutable before update or delete on public.ex_exam_version_rules
  for each row execute function private.ex_immutable();
create trigger ex_exam_version_pool_immutable  before update or delete on public.ex_exam_version_pool
  for each row execute function private.ex_immutable();

-- audit: created / deleted / every status change (action + note come from the RPC via tx-local GUCs)
create or replace function private.audit_ex_exams()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_action text;
begin
  if tg_op = 'INSERT' then
    v_action := 'ex_exam.created';
  elsif tg_op = 'DELETE' then
    v_action := 'ex_exam.deleted';
  else
    v_action := 'ex_exam.' || coalesce(nullif(current_setting('ex.action', true), ''), 'status_changed');
  end if;
  insert into public.audit_log (actor_id, action, entity, entity_id, details)
  values ((select auth.uid()), v_action, 'ex_exams', coalesce(new.id, old.id)::text,
          jsonb_build_object('course_id', coalesce(new.course_id, old.course_id),
                             'old_status', old.status, 'new_status', new.status,
                             'published_version_id', coalesce(new.published_version_id, old.published_version_id),
                             'note', nullif(current_setting('ex.note', true), '')));
  return null;
end;
$$;

create trigger ex_exams_audit_insert_delete after insert or delete on public.ex_exams
  for each row execute function private.audit_ex_exams();
create trigger ex_exams_audit_status after update on public.ex_exams
  for each row when (old.status is distinct from new.status)
  execute function private.audit_ex_exams();

create or replace function private.audit_ex_course_settings()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.audit_log (actor_id, action, entity, entity_id, details)
  values ((select auth.uid()), 'ex_course_settings.' || lower(tg_op), 'ex_course_settings',
          coalesce(new.course_id, old.course_id),
          jsonb_build_object('old_publish_requires_approval', old.publish_requires_approval,
                             'new_publish_requires_approval', new.publish_requires_approval));
  return null;
end;
$$;

create trigger ex_course_settings_audit after insert or update or delete on public.ex_course_settings
  for each row execute function private.audit_ex_course_settings();

-- ================================================================ 5. internal helpers (no API grant)
create or replace function private.ex_uuid(p text, p_what text)
returns uuid
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p is null or p = '' then
    return null;
  end if;
  return p::uuid;
exception when invalid_text_representation then
  raise exception '% must be a uuid', p_what using errcode = '22023';
end;
$$;

-- validates a rules array for a course and returns it normalized:
-- [{position, taxonomy_id, difficulty, type_code, tag_id, count, points_each}]
-- References of another course => 23503 (same message whether absent or foreign: no existence oracle).
create or replace function private.ex_normalize_rules(p_course_id text, p_rules jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_out  jsonb := '[]'::jsonb;
  v_e    jsonb;
  v_i    integer := 0;
  v_tax  uuid;
  v_tag  uuid;
  v_typ  text;
  v_diff text;
  v_cnt  numeric;
  v_pts  numeric;
begin
  if p_rules is null or jsonb_typeof(p_rules) <> 'array' or jsonb_array_length(p_rules) > 50 then
    raise exception 'rules must be an array of at most 50 rules' using errcode = '22023';
  end if;
  for v_e in select e from jsonb_array_elements(p_rules) e loop
    v_i := v_i + 1;
    perform private.qb_check_keys(v_e, array['taxonomy_id', 'difficulty', 'type_code', 'tag_id', 'count', 'points_each'], 'rule');
    v_tax := private.ex_uuid(v_e ->> 'taxonomy_id', 'rule.taxonomy_id');
    if v_tax is not null and not exists (select 1 from public.qb_taxonomy t where t.course_id = p_course_id and t.id = v_tax) then
      raise exception 'rule %: taxonomy node not found in this course', v_i using errcode = '23503';
    end if;
    v_tag := private.ex_uuid(v_e ->> 'tag_id', 'rule.tag_id');
    if v_tag is not null and not exists (select 1 from public.qb_tags g where g.course_id = p_course_id and g.id = v_tag) then
      raise exception 'rule %: tag not found in this course', v_i using errcode = '23503';
    end if;
    v_typ := nullif(v_e ->> 'type_code', '');
    if v_typ is not null and not exists (select 1 from public.qb_question_types t where t.code = v_typ) then
      raise exception 'rule %: unknown question type', v_i using errcode = '22023';
    end if;
    v_diff := nullif(v_e ->> 'difficulty', '');
    if v_diff is not null and v_diff not in ('easy', 'medium', 'hard') then
      raise exception 'rule %: difficulty must be easy | medium | hard', v_i using errcode = '22023';
    end if;
    if jsonb_typeof(v_e -> 'count') is distinct from 'number' then
      raise exception 'rule %: count is required (integer 1..500)', v_i using errcode = '22023';
    end if;
    v_cnt := (v_e ->> 'count')::numeric;
    if v_cnt <> trunc(v_cnt) or v_cnt not between 1 and 500 then
      raise exception 'rule %: count must be an integer 1..500', v_i using errcode = '22023';
    end if;
    if v_e ? 'points_each' and jsonb_typeof(v_e -> 'points_each') <> 'null' then
      if jsonb_typeof(v_e -> 'points_each') <> 'number' then
        raise exception 'rule %: points_each must be a number', v_i using errcode = '22023';
      end if;
      v_pts := (v_e ->> 'points_each')::numeric;
      if v_pts <= 0 or v_pts > 1000 then
        raise exception 'rule %: points_each must be > 0 and <= 1000', v_i using errcode = '22023';
      end if;
    else
      v_pts := 1;
    end if;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'position', v_i, 'taxonomy_id', v_tax, 'difficulty', v_diff, 'type_code', v_typ, 'tag_id', v_tag,
      'count', v_cnt::integer, 'points_each', v_pts));
  end loop;
  return v_out;
end;
$$;

-- Candidate pool. Eligible = question of the course, status active, not part of a scenario set, current
-- version of an ENABLED type, not in p_exclude (fixed picks), inside p_scope's subtree if given.
-- Returns every (rule, question) match; first_match = this rule is the lowest position matching the
-- question (first-match-wins => disjoint pools). Taxonomy depth is fixed (domain > topic > subtopic), so
-- "in subtree" = the node is the question's node, its parent or its grandparent.
create or replace function private.ex_pool(p_course_id text, p_scope uuid, p_rules jsonb, p_exclude uuid[])
returns table (rule_pos integer, qid uuid, vid uuid, first_match boolean)
language sql
stable
set search_path = ''
as $$
  with r as (
    select (e ->> 'position')::integer as pos,
           nullif(e ->> 'taxonomy_id', '')::uuid as tax,
           nullif(e ->> 'difficulty', '') as diff,
           nullif(e ->> 'type_code', '') as typ,
           nullif(e ->> 'tag_id', '')::uuid as tag
    from jsonb_array_elements(coalesce(p_rules, '[]'::jsonb)) e
  ), q as (
    select q.id as q_id, v.id as v_id, v.difficulty as q_diff, v.type_code as q_typ,
           v.taxonomy_id as n0, t1.parent_id as n1, t2.parent_id as n2
    from public.qb_questions q
    join public.qb_question_versions v on v.id = q.current_version_id
    join public.qb_question_types ty on ty.code = v.type_code and ty.enabled
    left join public.qb_taxonomy t1 on t1.course_id = v.course_id and t1.id = v.taxonomy_id
    left join public.qb_taxonomy t2 on t2.course_id = t1.course_id and t2.id = t1.parent_id
    where q.course_id = p_course_id
      and q.status = 'active'
      and q.set_id is null
      and not coalesce(q.id = any (p_exclude), false)   -- NULL-safe (a NULL element must not empty the pool)
      and (p_scope is null or p_scope in (v.taxonomy_id, t1.parent_id, t2.parent_id))
  ), m as (
    select r.pos, q.q_id, q.v_id
    from r join q
      on (r.tax  is null or r.tax in (q.n0, q.n1, q.n2))
     and (r.diff is null or r.diff = q.q_diff)
     and (r.typ  is null or r.typ = q.q_typ)
     and (r.tag  is null or exists (select 1 from public.qb_question_tags g
                                    where g.course_id = p_course_id and g.question_id = q.q_id and g.tag_id = r.tag))
  )
  select m.pos, m.q_id, m.v_id, m.pos = min(m.pos) over (partition by m.q_id)
  from m;
$$;

-- stored rules of an exam in the normalized jsonb shape
create or replace function private.ex_rules_json(p_exam_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('position', r.position, 'taxonomy_id', r.taxonomy_id,
                                               'difficulty', r.difficulty, 'type_code', r.type_code,
                                               'tag_id', r.tag_id, 'count', r.draw_count,
                                               'points_each', r.points_each) order by r.position), '[]'::jsonb)
  from public.ex_exam_rules r where r.exam_id = p_exam_id;
$$;

-- server-side totals (never trusted from the client): fixed picks use the override or the CURRENT
-- version's points; rules use draw_count * points_each.
create or replace function private.ex_compute_totals(p_exam_id uuid, out o_count integer, out o_total numeric)
language sql
stable
set search_path = ''
as $$
  select ((select count(*) from public.ex_exam_items i where i.exam_id = p_exam_id)
          + coalesce((select sum(r.draw_count) from public.ex_exam_rules r where r.exam_id = p_exam_id), 0))::integer,
         coalesce((select sum(coalesce(i.points, v.points))
                   from public.ex_exam_items i
                   join public.qb_questions q on q.course_id = i.course_id and q.id = i.question_id
                   left join public.qb_question_versions v on v.id = q.current_version_id
                   where i.exam_id = p_exam_id), 0)
         + coalesce((select sum(r.draw_count * r.points_each) from public.ex_exam_rules r where r.exam_id = p_exam_id), 0);
$$;

-- every reason this exam cannot be published right now: [{code, ...}] (no question text, ids or answers)
create or replace function private.ex_collect_errors(p_exam_id uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  e       public.ex_exams;
  v_err   jsonb := '[]'::jsonb;
  v_cnt   integer;
  v_tot   numeric;
  r       record;
begin
  select * into e from public.ex_exams x where x.id = p_exam_id;
  if not found then
    return jsonb_build_array(jsonb_build_object('code', 'exam_not_found'));
  end if;

  -- fixed picks
  for r in
    select i.position, q.status, q.set_id, q.current_version_id, coalesce(ty.enabled, false) as type_on,
           v.taxonomy_id as n0, t1.parent_id as n1, t2.parent_id as n2
    from public.ex_exam_items i
    join public.qb_questions q on q.course_id = i.course_id and q.id = i.question_id
    left join public.qb_question_versions v on v.id = q.current_version_id
    left join public.qb_question_types ty on ty.code = v.type_code
    left join public.qb_taxonomy t1 on t1.course_id = v.course_id and t1.id = v.taxonomy_id
    left join public.qb_taxonomy t2 on t2.course_id = t1.course_id and t2.id = t1.parent_id
    where i.exam_id = p_exam_id
    order by i.position
  loop
    if r.status <> 'active' or r.current_version_id is null then
      v_err := v_err || jsonb_build_array(jsonb_build_object('code', 'item_inactive', 'position', r.position));
    end if;
    if r.set_id is not null then
      v_err := v_err || jsonb_build_array(jsonb_build_object('code', 'item_in_set', 'position', r.position));
    end if;
    if not r.type_on then
      v_err := v_err || jsonb_build_array(jsonb_build_object('code', 'item_type_disabled', 'position', r.position));
    end if;
    if e.scope_taxonomy_id is not null
       and e.scope_taxonomy_id is distinct from r.n0 and e.scope_taxonomy_id is distinct from r.n1
       and e.scope_taxonomy_id is distinct from r.n2 then
      v_err := v_err || jsonb_build_array(jsonb_build_object('code', 'item_out_of_scope', 'position', r.position));
    end if;
  end loop;

  -- random rules: exclusive availability (first-match-wins, fixed picks excluded)
  for r in
    with rl as (
      select private.ex_rules_json(p_exam_id) as j
    ), pl as (
      select p.rule_pos, count(*) filter (where p.first_match) as avail
      from rl, private.ex_pool(e.course_id, e.scope_taxonomy_id, rl.j,
                               array(select i.question_id from public.ex_exam_items i where i.exam_id = p_exam_id)) p
      group by p.rule_pos
    )
    select (x ->> 'position')::integer as pos, (x ->> 'count')::integer as cnt, coalesce(pl.avail, 0) as avail
    from rl cross join lateral jsonb_array_elements(rl.j) x
    left join pl on pl.rule_pos = (x ->> 'position')::integer
  loop
    if r.avail < r.cnt then
      v_err := v_err || jsonb_build_array(jsonb_build_object('code', 'rule_insufficient', 'position', r.pos,
                                                             'requested', r.cnt, 'available', r.avail));
    end if;
  end loop;

  select t.o_count, t.o_total into v_cnt, v_tot from private.ex_compute_totals(p_exam_id) t;
  if v_cnt = 0 then
    v_err := v_err || '[{"code":"no_questions"}]'::jsonb;
  elsif v_cnt > 500 then
    v_err := v_err || '[{"code":"too_many_questions"}]'::jsonb;
  end if;
  if e.exam_kind in ('simulation', 'final') and e.duration_minutes is null then
    v_err := v_err || '[{"code":"duration_required"}]'::jsonb;
  end if;
  if e.exam_kind = 'final' and e.pass_percent is null and e.pass_score is null then
    v_err := v_err || '[{"code":"pass_required"}]'::jsonb;
  end if;
  if e.exam_kind = 'final' and e.max_attempts is null then
    v_err := v_err || '[{"code":"max_attempts_required"}]'::jsonb;
  end if;
  if e.pass_score is not null and e.pass_score > v_tot then
    v_err := v_err || jsonb_build_array(jsonb_build_object('code', 'pass_score_exceeds_total',
                                                           'pass_score', e.pass_score, 'total_score', v_tot));
  end if;
  if e.close_at is not null and e.close_at <= now() then
    v_err := v_err || '[{"code":"window_closed"}]'::jsonb;
  elsif e.close_at is not null and e.duration_minutes is not null
        and e.close_at - greatest(coalesce(e.open_at, now()), now()) < make_interval(mins => e.duration_minutes) then
    v_err := v_err || '[{"code":"window_shorter_than_duration"}]'::jsonb;
  end if;
  if e.close_at is null and 'after_close' in (e.review_policy, e.result_policy, e.feedback_policy, e.explanation_policy) then
    v_err := v_err || '[{"code":"after_close_needs_close_at"}]'::jsonb;
  end if;
  if e.review_policy = 'never'
     and (e.feedback_policy in ('after_submit', 'after_close', 'manual')
          or e.explanation_policy in ('after_submit', 'after_close', 'manual')) then
    v_err := v_err || '[{"code":"feedback_needs_review"}]'::jsonb;
  end if;
  return v_err;
end;
$$;

create or replace function private.ex_raise_invalid(p_errors jsonb)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if jsonb_array_length(p_errors) > 0 then
    raise exception 'exam_invalid: %',
      (select string_agg(distinct x ->> 'code', ',') from jsonb_array_elements(p_errors) x)
      using errcode = '22023', detail = p_errors::text;
  end if;
end;
$$;

-- FREEZE: validates, then writes the immutable version + pinned items + frozen rules + disjoint pools and
-- flips the exam to published. Caller (ex_transition) holds the row lock and has checked permissions.
create or replace function private.ex_freeze(p_exam_id uuid, p_approver uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  e       public.ex_exams;
  v_vid   uuid;
  v_no    integer;
  v_cnt   integer;
  v_tot   numeric;
  v_rules jsonb;
  v_excl  uuid[];
begin
  select * into e from public.ex_exams x where x.id = p_exam_id;
  perform private.ex_raise_invalid(private.ex_collect_errors(p_exam_id));

  select t.o_count, t.o_total into v_cnt, v_tot from private.ex_compute_totals(p_exam_id) t;
  v_rules := private.ex_rules_json(p_exam_id);
  v_excl  := array(select i.question_id from public.ex_exam_items i where i.exam_id = p_exam_id);
  v_no    := coalesce((select max(x.version_no) from public.ex_exam_versions x where x.exam_id = p_exam_id), 0) + 1;

  insert into public.ex_exam_versions (exam_id, course_id, version_no, settings, total_score, question_count,
                                       fixed_count, requested_by, approved_by, published_by)
  values (p_exam_id, e.course_id, v_no,
          to_jsonb(e) - private.ex_workflow_columns() - array['created_at', 'created_by'],
          v_tot, v_cnt, cardinality(v_excl),
          case when p_approver is not null then e.requested_by end, p_approver, (select auth.uid()))
  returning id into v_vid;

  insert into public.ex_exam_version_items (exam_version_id, course_id, position, question_id, question_version_id, points, weight)
  select v_vid, e.course_id, i.position, i.question_id, q.current_version_id, coalesce(i.points, v.points), i.weight
  from public.ex_exam_items i
  join public.qb_questions q on q.course_id = i.course_id and q.id = i.question_id
  join public.qb_question_versions v on v.id = q.current_version_id
  where i.exam_id = p_exam_id;

  with pool as materialized (
    select p.rule_pos, p.qid, p.vid
    from private.ex_pool(e.course_id, e.scope_taxonomy_id, v_rules, v_excl) p
    where p.first_match
  ), rules as (
    insert into public.ex_exam_version_rules (exam_version_id, course_id, rule_no, taxonomy_id, difficulty, type_code,
                                              tag_id, draw_count, points_each, pool_size)
    select v_vid, e.course_id, r.position, r.taxonomy_id, r.difficulty, r.type_code, r.tag_id, r.draw_count,
           r.points_each, (select count(*) from pool where pool.rule_pos = r.position)
    from public.ex_exam_rules r where r.exam_id = p_exam_id
    returning rule_no
  )
  insert into public.ex_exam_version_pool (exam_version_id, course_id, rule_no, question_id, question_version_id)
  select v_vid, e.course_id, pool.rule_pos, pool.qid, pool.vid
  from pool join rules on rules.rule_no = pool.rule_pos;

  update public.ex_exams x
     set status = 'published', published_version_id = v_vid, published_at = now(), published_by = (select auth.uid()),
         total_score = v_tot, question_count = v_cnt,
         reviewed_by = case when p_approver is not null then p_approver else x.reviewed_by end,
         reviewed_at = case when p_approver is not null then now() else x.reviewed_at end
   where x.id = p_exam_id;
  return v_vid;
end;
$$;

-- ================================================================ 5b. RPC exam_save
-- Create (no exam_id) or update a DRAFT. Patch semantics: absent keys keep their value, explicit null
-- clears a nullable setting. items / rules, when present, REPLACE the whole list (order = position).
-- Input keys: exam_id?, course_id (new), folder_kind, exam_kind, title_ar (new: required), title_en,
--   description_ar, description_en, scope_taxonomy_id, duration_minutes, open_at, close_at, grace_seconds,
--   max_attempts, pass_percent, pass_score, shuffle_questions, shuffle_options, allow_back, allow_flag,
--   review_policy, result_policy, feedback_policy, explanation_policy, allow_whiteboard, allow_calculator,
--   allow_translation, timeout_policy, resume_policy, security {partial, merged},
--   items [{question_id, points?, weight?}], rules [{taxonomy_id?, difficulty?, type_code?, tag_id?, count, points_each?}]
-- status / total_score / question_count are NOT accepted (unknown field => 22023).
-- Output: {exam_id, status, question_count, total_score}
-- Errors: 42501 forbidden (incl. unknown exam), 55000 exam not a draft, 22023 invalid, 23503 row of another
--         course, 23514 CHECK constraint, P0001 rate_limited.
create or replace function private.exam_save(p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c_fields constant text[] := array['folder_kind', 'exam_kind', 'title_ar', 'title_en', 'description_ar',
    'description_en', 'scope_taxonomy_id', 'duration_minutes', 'open_at', 'close_at', 'grace_seconds',
    'max_attempts', 'pass_percent', 'pass_score', 'shuffle_questions', 'shuffle_options', 'allow_back',
    'allow_flag', 'review_policy', 'result_policy', 'feedback_policy', 'explanation_policy',
    'allow_whiteboard', 'allow_calculator', 'allow_translation', 'timeout_policy', 'resume_policy'];
  v_uid    uuid := (select auth.uid());
  v_id     uuid;
  v_course text;
  v_row    public.ex_exams;
  v_new    public.ex_exams;
  v_patch  jsonb;
  v_e      jsonb;
  v_i      integer;
  v_qid    uuid;
  v_pts    numeric;
  v_w      numeric;
  v_rules  jsonb;
  v_cnt    integer;
  v_tot    numeric;
begin
  if v_uid is null then
    raise exception 'forbidden: sign-in required' using errcode = '42501';
  end if;
  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception 'request must be a JSON object' using errcode = '22023';
  end if;
  if octet_length(p::text) > 262144 then
    raise exception 'request too large' using errcode = '22023';
  end if;
  perform private.qb_check_keys(p, array['exam_id', 'course_id', 'security', 'items', 'rules'] || c_fields, 'request');

  if nullif(p ->> 'exam_id', '') is not null then
    v_id := private.ex_uuid(p ->> 'exam_id', 'exam_id');
    select * into v_row from public.ex_exams x where x.id = v_id for update;
    v_course := v_row.course_id;
  else
    v_course := nullif(p ->> 'course_id', '');
  end if;
  if v_course is null or not private.has_staff_perm(v_course, 'exam.write') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_id is not null and p ? 'course_id' and (p ->> 'course_id') is distinct from v_course then
    raise exception 'course_id does not match the exam' using errcode = '22023';
  end if;

  perform private.rl_hit('ex_save:' || v_uid::text, 60, 60);

  if v_id is not null and v_row.status <> 'draft' then
    raise exception 'exam_locked: only a draft can be edited (status %); unpublish it first', v_row.status
      using errcode = '55000';
  end if;

  if v_id is null then
    if nullif(p ->> 'folder_kind', '') is null or nullif(p ->> 'exam_kind', '') is null
       or nullif(p ->> 'title_ar', '') is null then
      raise exception 'folder_kind, exam_kind and title_ar are required for a new exam' using errcode = '22023';
    end if;
    insert into public.ex_exams (course_id, folder_kind, exam_kind, title_ar, created_by)
    values (v_course, p ->> 'folder_kind', p ->> 'exam_kind', p ->> 'title_ar', v_uid)
    returning * into v_row;
    v_id := v_row.id;
  end if;

  -- settings patch (typed by the table row; bad types => 22023, out-of-range => CHECK 23514)
  v_patch := (select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) from jsonb_each(p) as x(k, v) where k = any (c_fields));
  begin
    v_new := jsonb_populate_record(v_row, v_patch);
  exception
    when invalid_text_representation or invalid_datetime_format or datetime_field_overflow
         or numeric_value_out_of_range or invalid_parameter_value or string_data_right_truncation then
      raise exception 'invalid value in request: %', sqlerrm using errcode = '22023';
  end;
  if p ? 'security' then
    if jsonb_typeof(p -> 'security') is distinct from 'object' then
      raise exception 'security must be a JSON object' using errcode = '22023';
    end if;
    v_new.security := v_row.security || (p -> 'security');
  end if;
  if v_new.scope_taxonomy_id is not null
     and not exists (select 1 from public.qb_taxonomy t where t.course_id = v_course and t.id = v_new.scope_taxonomy_id) then
    raise exception 'scope taxonomy node not found in this course' using errcode = '23503';
  end if;

  update public.ex_exams x set
    folder_kind = v_new.folder_kind, exam_kind = v_new.exam_kind, title_ar = v_new.title_ar,
    title_en = v_new.title_en, description_ar = v_new.description_ar, description_en = v_new.description_en,
    scope_taxonomy_id = v_new.scope_taxonomy_id, duration_minutes = v_new.duration_minutes,
    open_at = v_new.open_at, close_at = v_new.close_at, grace_seconds = v_new.grace_seconds,
    max_attempts = v_new.max_attempts, pass_percent = v_new.pass_percent, pass_score = v_new.pass_score,
    shuffle_questions = v_new.shuffle_questions, shuffle_options = v_new.shuffle_options,
    allow_back = v_new.allow_back, allow_flag = v_new.allow_flag, review_policy = v_new.review_policy,
    result_policy = v_new.result_policy, feedback_policy = v_new.feedback_policy,
    explanation_policy = v_new.explanation_policy, allow_whiteboard = v_new.allow_whiteboard,
    allow_calculator = v_new.allow_calculator, allow_translation = v_new.allow_translation,
    security = v_new.security, timeout_policy = v_new.timeout_policy, resume_policy = v_new.resume_policy
  where x.id = v_id;

  -- fixed picks (full replace)
  if p ? 'items' then
    if jsonb_typeof(p -> 'items') is distinct from 'array' or jsonb_array_length(p -> 'items') > 500 then
      raise exception 'items must be an array of at most 500 entries' using errcode = '22023';
    end if;
    delete from public.ex_exam_items i where i.exam_id = v_id;
    v_i := 0;
    for v_e in select e from jsonb_array_elements(p -> 'items') e loop
      v_i := v_i + 1;
      perform private.qb_check_keys(v_e, array['question_id', 'points', 'weight'], 'item');
      v_qid := private.ex_uuid(v_e ->> 'question_id', 'item.question_id');
      if v_qid is null then
        raise exception 'item %: question_id is required', v_i using errcode = '22023';
      end if;
      if not exists (select 1 from public.qb_questions q where q.course_id = v_course and q.id = v_qid) then
        raise exception 'item %: question not found in this course', v_i using errcode = '23503';
      end if;
      if exists (select 1 from public.ex_exam_items i where i.exam_id = v_id and i.question_id = v_qid) then
        raise exception 'item %: duplicate question', v_i using errcode = '22023';
      end if;
      v_pts := null;
      if v_e ? 'points' and jsonb_typeof(v_e -> 'points') <> 'null' then
        if jsonb_typeof(v_e -> 'points') <> 'number' then
          raise exception 'item %: points must be a number', v_i using errcode = '22023';
        end if;
        v_pts := (v_e ->> 'points')::numeric;
      end if;
      v_w := 1;
      if v_e ? 'weight' and jsonb_typeof(v_e -> 'weight') <> 'null' then
        if jsonb_typeof(v_e -> 'weight') <> 'number' then
          raise exception 'item %: weight must be a number', v_i using errcode = '22023';
        end if;
        v_w := (v_e ->> 'weight')::numeric;
      end if;
      insert into public.ex_exam_items (exam_id, course_id, position, question_id, points, weight)
      values (v_id, v_course, v_i, v_qid, v_pts, v_w);
    end loop;
  end if;

  -- random rules (full replace)
  if p ? 'rules' then
    v_rules := private.ex_normalize_rules(v_course, p -> 'rules');
    delete from public.ex_exam_rules r where r.exam_id = v_id;
    insert into public.ex_exam_rules (exam_id, course_id, position, taxonomy_id, difficulty, type_code, tag_id,
                                      draw_count, points_each)
    select v_id, v_course, (e ->> 'position')::integer, (e ->> 'taxonomy_id')::uuid, e ->> 'difficulty',
           e ->> 'type_code', (e ->> 'tag_id')::uuid, (e ->> 'count')::integer, (e ->> 'points_each')::numeric
    from jsonb_array_elements(v_rules) e;
  end if;

  select t.o_count, t.o_total into v_cnt, v_tot from private.ex_compute_totals(v_id) t;
  update public.ex_exams x set question_count = v_cnt, total_score = v_tot where x.id = v_id;

  return jsonb_build_object('exam_id', v_id, 'status', 'draft', 'question_count', v_cnt, 'total_score', v_tot);
end;
$$;

-- ================================================================ 5c. RPC exam_preview_pool (COUNTS ONLY)
-- Mode A {exam_id}: the stored rules/items/scope of the exam (+ the publish errors list).
-- Mode B {course_id, rules, scope_taxonomy_id?, exclude_question_ids?}: unsaved builder state.
-- Output: {course_id, eligible, rules:[{position, requested, matching, available, ok}],
--          fixed_items?, question_count?, total_score?, errors?}
-- Never returns question text, ids, versions or answers.
create or replace function private.exam_preview_pool(p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := (select auth.uid());
  v_exam   public.ex_exams;
  v_course text;
  v_scope  uuid;
  v_rules  jsonb;
  v_excl   uuid[];
  v_out    jsonb;
  v_cnt    integer;
  v_tot    numeric;
begin
  if v_uid is null then
    raise exception 'forbidden: sign-in required' using errcode = '42501';
  end if;
  if p is null or jsonb_typeof(p) <> 'object' or octet_length(p::text) > 65536 then
    raise exception 'request must be a JSON object (max 64KB)' using errcode = '22023';
  end if;
  perform private.qb_check_keys(p, array['exam_id', 'course_id', 'scope_taxonomy_id', 'rules', 'exclude_question_ids'], 'request');

  if nullif(p ->> 'exam_id', '') is not null then
    if p ? 'rules' or p ? 'scope_taxonomy_id' or p ? 'exclude_question_ids' then
      raise exception 'exam_id mode takes no rules/scope/exclude (they come from the exam)' using errcode = '22023';
    end if;
    select * into v_exam from public.ex_exams x where x.id = private.ex_uuid(p ->> 'exam_id', 'exam_id');
    v_course := v_exam.course_id;
  else
    v_course := nullif(p ->> 'course_id', '');
  end if;
  if v_course is null or not private.ex_can_read(v_course) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_exam.id is not null and p ? 'course_id' and (p ->> 'course_id') is distinct from v_course then
    raise exception 'course_id does not match the exam' using errcode = '22023';
  end if;

  perform private.rl_hit('ex_preview:' || v_uid::text, 60, 60);

  if v_exam.id is not null then
    v_scope := v_exam.scope_taxonomy_id;
    v_rules := private.ex_rules_json(v_exam.id);
    v_excl  := array(select i.question_id from public.ex_exam_items i where i.exam_id = v_exam.id);
  else
    v_scope := private.ex_uuid(p ->> 'scope_taxonomy_id', 'scope_taxonomy_id');
    if v_scope is not null and not exists (select 1 from public.qb_taxonomy t where t.course_id = v_course and t.id = v_scope) then
      raise exception 'scope taxonomy node not found in this course' using errcode = '23503';
    end if;
    v_rules := private.ex_normalize_rules(v_course, coalesce(p -> 'rules', '[]'::jsonb));
    if p ? 'exclude_question_ids' then
      if jsonb_typeof(p -> 'exclude_question_ids') <> 'array' or jsonb_array_length(p -> 'exclude_question_ids') > 500 then
        raise exception 'exclude_question_ids must be an array of at most 500 uuids' using errcode = '22023';
      end if;
      v_excl := array(select private.ex_uuid(x, 'exclude_question_ids[]')
                      from jsonb_array_elements_text(p -> 'exclude_question_ids') x);
    end if;
  end if;

  select jsonb_build_object(
           'course_id', v_course,
           'eligible', (select count(*) from private.ex_pool(v_course, v_scope, '[{"position":0}]'::jsonb, v_excl)),
           'rules', coalesce((
             select jsonb_agg(jsonb_build_object(
                      'position', (x ->> 'position')::integer,
                      'requested', (x ->> 'count')::integer,
                      'matching', coalesce(s.matching, 0),
                      'available', coalesce(s.available, 0),
                      'ok', coalesce(s.available, 0) >= (x ->> 'count')::integer)
                    order by (x ->> 'position')::integer)
             from jsonb_array_elements(v_rules) x
             left join (select pl.rule_pos, count(*) as matching, count(*) filter (where pl.first_match) as available
                        from private.ex_pool(v_course, v_scope, v_rules, v_excl) pl group by pl.rule_pos) s
               on s.rule_pos = (x ->> 'position')::integer), '[]'::jsonb))
    into v_out;

  if v_exam.id is not null then
    select t.o_count, t.o_total into v_cnt, v_tot from private.ex_compute_totals(v_exam.id) t;
    v_out := v_out || jsonb_build_object('exam_id', v_exam.id, 'status', v_exam.status,
                                         'fixed_items', cardinality(v_excl), 'question_count', v_cnt,
                                         'total_score', v_tot, 'errors', private.ex_collect_errors(v_exam.id));
  end if;
  return v_out;
end;
$$;

-- ================================================================ 5d. RPC status transitions
-- actions: publish | request_approval | withdraw | approve | reject | pause | resume | unpublish | archive | unarchive
--   publish          direct publisher (admin, or exam.publish + course without approval): draft|pending -> published (freeze)
--                    exam.write without direct right: draft -> pending_approval (same as request_approval)
--   request_approval exam.write: draft -> pending_approval (full validation first)
--   withdraw         exam.write: pending_approval -> draft
--   approve          admin: pending_approval -> published (re-validates against the current bank, freeze)
--   reject           admin: pending_approval -> draft (note required)
--   pause            exam.write or exam.publish: published -> paused
--   resume           direct publisher: paused -> published (same frozen version)
--   unpublish        exam.write or direct publisher: published|paused -> draft (versions kept)
--   archive          exam.write: draft|published|paused -> archived
--   unarchive        exam.write: archived -> draft
-- Errors: 42501 forbidden (incl. unknown exam), 55000 invalid transition, 22023 exam_invalid / bad input,
--         P0001 rate_limited.
create or replace function private.ex_transition(p_exam_id uuid, p_action text, p_note text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := (select auth.uid());
  e        public.ex_exams;
  v_w      boolean;
  v_pub    boolean;
  v_adm    boolean;
  v_direct boolean;
  v_action text := p_action;
  v_vid    uuid;
begin
  if v_uid is null then
    raise exception 'forbidden: sign-in required' using errcode = '42501';
  end if;
  if p_action is null or p_action not in ('publish', 'request_approval', 'withdraw', 'approve', 'reject', 'pause',
                                          'resume', 'unpublish', 'archive', 'unarchive') then
    raise exception 'unknown action' using errcode = '22023';
  end if;
  if p_note is not null and char_length(p_note) > 2000 then
    raise exception 'note too long (max 2000)' using errcode = '22023';
  end if;

  select * into e from public.ex_exams x where x.id = p_exam_id for update;
  if not found or not private.ex_can_read(e.course_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  v_adm    := private.is_admin();
  v_w      := private.has_staff_perm(e.course_id, 'exam.write');
  v_pub    := private.has_staff_perm(e.course_id, 'exam.publish');
  v_direct := private.ex_can_publish_direct(e.course_id);

  if v_action = 'publish' and not v_direct then
    if not v_w then
      raise exception 'forbidden' using errcode = '42501';
    end if;
    v_action := 'request_approval';   -- plan 4.5: without a direct publish right, publishing asks for approval
  end if;

  if (v_action in ('request_approval', 'withdraw', 'archive', 'unarchive') and not v_w)
     or (v_action in ('approve', 'reject') and not v_adm)
     or (v_action in ('publish', 'resume') and not v_direct)
     or (v_action = 'pause' and not (v_w or v_pub))
     or (v_action = 'unpublish' and not (v_w or v_direct)) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  perform private.rl_hit('ex_status:' || v_uid::text, 60, 30);

  if not (   (v_action = 'publish'          and e.status in ('draft', 'pending_approval'))
          or (v_action = 'request_approval' and e.status = 'draft')
          or (v_action in ('withdraw', 'approve', 'reject') and e.status = 'pending_approval')
          or (v_action = 'pause'            and e.status = 'published')
          or (v_action = 'resume'           and e.status = 'paused')
          or (v_action = 'unpublish'        and e.status in ('published', 'paused'))
          or (v_action = 'archive'          and e.status in ('draft', 'published', 'paused'))
          or (v_action = 'unarchive'        and e.status = 'archived')) then
    raise exception 'invalid_transition: cannot % an exam in status %', v_action, e.status using errcode = '55000';
  end if;
  if v_action = 'reject' and nullif(btrim(coalesce(p_note, '')), '') is null then
    raise exception 'a rejection reason is required' using errcode = '22023';
  end if;

  perform set_config('ex.action', v_action, true);
  perform set_config('ex.note', coalesce(p_note, ''), true);

  if v_action = 'publish' then
    v_vid := private.ex_freeze(p_exam_id, case when e.status = 'pending_approval' then v_uid end);
  elsif v_action = 'approve' then
    v_vid := private.ex_freeze(p_exam_id, v_uid);
  elsif v_action = 'request_approval' then
    perform private.ex_raise_invalid(private.ex_collect_errors(p_exam_id));
    update public.ex_exams x set status = 'pending_approval', requested_by = v_uid, requested_at = now(),
                                 reviewed_by = null, reviewed_at = null, review_note = null
     where x.id = p_exam_id;
  elsif v_action = 'reject' then
    update public.ex_exams x set status = 'draft', reviewed_by = v_uid, reviewed_at = now(), review_note = p_note
     where x.id = p_exam_id;
  else
    update public.ex_exams x
       set status = case v_action when 'withdraw' then 'draft' when 'pause' then 'paused' when 'resume' then 'published'
                                  when 'unpublish' then 'draft' when 'archive' then 'archived' else 'draft' end
     where x.id = p_exam_id;
  end if;

  perform set_config('ex.action', '', true);
  perform set_config('ex.note', '', true);

  select * into e from public.ex_exams x where x.id = p_exam_id;
  return jsonb_build_object('exam_id', e.id, 'action', v_action, 'status', e.status,
                            'published_version_id', e.published_version_id,
                            'version_no', (select v.version_no from public.ex_exam_versions v where v.id = e.published_version_id),
                            'question_count', e.question_count, 'total_score', e.total_score);
end;
$$;

-- ================================================================ 5e. REST wrappers (SECURITY INVOKER, like 006/007/010)
create or replace function public.exam_save(p jsonb)
returns jsonb language sql volatile set search_path = '' as $$ select private.exam_save(p); $$;
create or replace function public.exam_preview_pool(p jsonb)
returns jsonb language sql volatile set search_path = '' as $$ select private.exam_preview_pool(p); $$;
create or replace function public.exam_publish(p_exam_id uuid)
returns jsonb language sql volatile set search_path = '' as $$ select private.ex_transition(p_exam_id, 'publish'); $$;
create or replace function public.exam_request_approval(p_exam_id uuid, p_note text default null)
returns jsonb language sql volatile set search_path = '' as $$ select private.ex_transition(p_exam_id, 'request_approval', p_note); $$;
create or replace function public.exam_withdraw(p_exam_id uuid)
returns jsonb language sql volatile set search_path = '' as $$ select private.ex_transition(p_exam_id, 'withdraw'); $$;
create or replace function public.exam_approve(p_exam_id uuid, p_note text default null)
returns jsonb language sql volatile set search_path = '' as $$ select private.ex_transition(p_exam_id, 'approve', p_note); $$;
create or replace function public.exam_reject(p_exam_id uuid, p_reason text)
returns jsonb language sql volatile set search_path = '' as $$ select private.ex_transition(p_exam_id, 'reject', p_reason); $$;
create or replace function public.exam_pause(p_exam_id uuid, p_note text default null)
returns jsonb language sql volatile set search_path = '' as $$ select private.ex_transition(p_exam_id, 'pause', p_note); $$;
create or replace function public.exam_resume(p_exam_id uuid)
returns jsonb language sql volatile set search_path = '' as $$ select private.ex_transition(p_exam_id, 'resume'); $$;
create or replace function public.exam_unpublish(p_exam_id uuid, p_note text default null)
returns jsonb language sql volatile set search_path = '' as $$ select private.ex_transition(p_exam_id, 'unpublish', p_note); $$;
create or replace function public.exam_archive(p_exam_id uuid)
returns jsonb language sql volatile set search_path = '' as $$ select private.ex_transition(p_exam_id, 'archive'); $$;
create or replace function public.exam_unarchive(p_exam_id uuid)
returns jsonb language sql volatile set search_path = '' as $$ select private.ex_transition(p_exam_id, 'unarchive'); $$;

-- ================================================================ 6. grants + RLS
-- Read: admin (initplan) or staff with exam.write | exam.publish on the row's course. No trainee/anon policy.
grant select on public.ex_course_settings to authenticated;
grant insert (course_id, publish_requires_approval) on public.ex_course_settings to authenticated;
grant update (publish_requires_approval) on public.ex_course_settings to authenticated;
create policy ex_course_settings_select on public.ex_course_settings for select to authenticated
  using ((select private.is_admin()) or private.is_course_staff(course_id));
create policy ex_course_settings_insert_admin on public.ex_course_settings for insert to authenticated
  with check ((select private.is_admin()));
create policy ex_course_settings_update_admin on public.ex_course_settings for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));

-- exams: written by RPC only; a draft can be deleted by exam.write (FK keeps exams that have versions)
grant select, delete on public.ex_exams to authenticated;
create policy ex_exams_select on public.ex_exams for select to authenticated
  using ((select private.is_admin()) or private.ex_can_read(course_id));
create policy ex_exams_delete_draft on public.ex_exams for delete to authenticated
  using (status = 'draft' and private.has_staff_perm(course_id, 'exam.write'));

grant select on public.ex_exam_items to authenticated;
create policy ex_exam_items_select on public.ex_exam_items for select to authenticated
  using ((select private.is_admin()) or private.ex_can_read(course_id));
grant select on public.ex_exam_rules to authenticated;
create policy ex_exam_rules_select on public.ex_exam_rules for select to authenticated
  using ((select private.is_admin()) or private.ex_can_read(course_id));
grant select on public.ex_exam_versions to authenticated;
create policy ex_exam_versions_select on public.ex_exam_versions for select to authenticated
  using ((select private.is_admin()) or private.ex_can_read(course_id));
grant select on public.ex_exam_version_items to authenticated;
create policy ex_exam_version_items_select on public.ex_exam_version_items for select to authenticated
  using ((select private.is_admin()) or private.ex_can_read(course_id));
grant select on public.ex_exam_version_rules to authenticated;
create policy ex_exam_version_rules_select on public.ex_exam_version_rules for select to authenticated
  using ((select private.is_admin()) or private.ex_can_read(course_id));
grant select on public.ex_exam_version_pool to authenticated;
create policy ex_exam_version_pool_select on public.ex_exam_version_pool for select to authenticated
  using ((select private.is_admin()) or private.ex_can_read(course_id));

-- EXECUTE privileges
revoke execute on function private.ex_security_ok(jsonb)                          from public, anon, authenticated;
revoke execute on function private.ex_can_read(text)                              from public, anon, authenticated;
revoke execute on function private.ex_publish_requires_approval(text)             from public, anon, authenticated;
revoke execute on function private.ex_can_publish_direct(text)                    from public, anon, authenticated;
revoke execute on function private.ex_course_settings_before()                    from public, anon, authenticated;
revoke execute on function private.ex_workflow_columns()                          from public, anon, authenticated;
revoke execute on function private.ex_exams_before()                              from public, anon, authenticated;
revoke execute on function private.ex_composition_guard()                         from public, anon, authenticated;
revoke execute on function private.ex_immutable()                                 from public, anon, authenticated;
revoke execute on function private.audit_ex_exams()                               from public, anon, authenticated;
revoke execute on function private.audit_ex_course_settings()                     from public, anon, authenticated;
revoke execute on function private.ex_uuid(text, text)                            from public, anon, authenticated;
revoke execute on function private.ex_normalize_rules(text, jsonb)                from public, anon, authenticated;
revoke execute on function private.ex_pool(text, uuid, jsonb, uuid[])             from public, anon, authenticated;
revoke execute on function private.ex_rules_json(uuid)                            from public, anon, authenticated;
revoke execute on function private.ex_compute_totals(uuid)                        from public, anon, authenticated;
revoke execute on function private.ex_collect_errors(uuid)                        from public, anon, authenticated;
revoke execute on function private.ex_raise_invalid(jsonb)                        from public, anon, authenticated;
revoke execute on function private.ex_freeze(uuid, uuid)                          from public, anon, authenticated;
revoke execute on function private.exam_save(jsonb)                               from public, anon, authenticated;
revoke execute on function private.exam_preview_pool(jsonb)                       from public, anon, authenticated;
revoke execute on function private.ex_transition(uuid, text, text)                from public, anon, authenticated;
revoke execute on function public.exam_save(jsonb)                                from public, anon, authenticated;
revoke execute on function public.exam_preview_pool(jsonb)                        from public, anon, authenticated;
revoke execute on function public.exam_publish(uuid)                              from public, anon, authenticated;
revoke execute on function public.exam_request_approval(uuid, text)               from public, anon, authenticated;
revoke execute on function public.exam_withdraw(uuid)                             from public, anon, authenticated;
revoke execute on function public.exam_approve(uuid, text)                        from public, anon, authenticated;
revoke execute on function public.exam_reject(uuid, text)                         from public, anon, authenticated;
revoke execute on function public.exam_pause(uuid, text)                          from public, anon, authenticated;
revoke execute on function public.exam_resume(uuid)                               from public, anon, authenticated;
revoke execute on function public.exam_unpublish(uuid, text)                      from public, anon, authenticated;
revoke execute on function public.exam_archive(uuid)                              from public, anon, authenticated;
revoke execute on function public.exam_unarchive(uuid)                            from public, anon, authenticated;
-- needed by RLS policies evaluated as the signed-in user
grant execute on function private.ex_can_read(text) to authenticated;
-- CHECK constraint ex_exams_security_chk is evaluated as the writer (RPC owner or postgres); no API grant needed.
-- the RPCs (each checks the caller's course permission itself)
grant execute on function private.exam_save(jsonb)                to authenticated;
grant execute on function private.exam_preview_pool(jsonb)        to authenticated;
grant execute on function private.ex_transition(uuid, text, text) to authenticated;
grant execute on function public.exam_save(jsonb)                 to authenticated;
grant execute on function public.exam_preview_pool(jsonb)         to authenticated;
grant execute on function public.exam_publish(uuid)               to authenticated;
grant execute on function public.exam_request_approval(uuid, text) to authenticated;
grant execute on function public.exam_withdraw(uuid)              to authenticated;
grant execute on function public.exam_approve(uuid, text)         to authenticated;
grant execute on function public.exam_reject(uuid, text)          to authenticated;
grant execute on function public.exam_pause(uuid, text)           to authenticated;
grant execute on function public.exam_resume(uuid)                to authenticated;
grant execute on function public.exam_unpublish(uuid, text)       to authenticated;
grant execute on function public.exam_archive(uuid)               to authenticated;
grant execute on function public.exam_unarchive(uuid)             to authenticated;

-- ================================================================ ROLLBACK (commented out; see docs/exams/rollback-M3a.sql)
-- Removes ONLY what this file created; 001..010 objects are untouched. Destroys every exam and version.
-- drop function if exists public.exam_save(jsonb), public.exam_preview_pool(jsonb), public.exam_publish(uuid),
--   public.exam_request_approval(uuid, text), public.exam_withdraw(uuid), public.exam_approve(uuid, text),
--   public.exam_reject(uuid, text), public.exam_pause(uuid, text), public.exam_resume(uuid),
--   public.exam_unpublish(uuid, text), public.exam_archive(uuid), public.exam_unarchive(uuid);
-- drop function if exists private.ex_transition(uuid, text, text), private.exam_preview_pool(jsonb),
--   private.exam_save(jsonb), private.ex_freeze(uuid, uuid), private.ex_raise_invalid(jsonb),
--   private.ex_collect_errors(uuid), private.ex_compute_totals(uuid), private.ex_rules_json(uuid),
--   private.ex_pool(text, uuid, jsonb, uuid[]), private.ex_normalize_rules(text, jsonb), private.ex_uuid(text, text);
-- alter table if exists public.ex_exams drop constraint if exists ex_exams_published_version_fkey;
-- drop table if exists public.ex_exam_version_pool, public.ex_exam_version_rules, public.ex_exam_version_items,
--   public.ex_exam_versions, public.ex_exam_rules, public.ex_exam_items, public.ex_exams, public.ex_course_settings;
-- drop function if exists private.audit_ex_course_settings(), private.audit_ex_exams(), private.ex_immutable(),
--   private.ex_composition_guard(), private.ex_exams_before(), private.ex_workflow_columns(),
--   private.ex_course_settings_before(), private.ex_can_publish_direct(text),
--   private.ex_publish_requires_approval(text), private.ex_can_read(text), private.ex_security_ok(jsonb);
-- (audit_log rows written by these triggers are kept on purpose.)
