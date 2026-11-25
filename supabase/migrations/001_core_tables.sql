-- 001_core_tables
-- Core tables of the trainee/trainer platform (phase P2).
-- RLS, grants and policies are applied in 004; functions/triggers in 003.

-- ---------------------------------------------------------------- profiles
create table public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  full_name     text not null default '' check (char_length(full_name) <= 120),
  phone         text check (phone is null or char_length(phone) <= 40),
  country       text check (country is null or char_length(country) <= 80),
  role          text not null default 'trainee' check (role in ('trainee', 'admin')),
  status        text not null default 'active' check (status in ('active', 'suspended')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  last_seen_at  timestamptz
);
create index profiles_role_status_idx on public.profiles (role, status);
create index profiles_created_at_idx  on public.profiles (created_at);

-- trainer notes live in their own admin-only table (never in profiles),
-- so no trainee query can ever return them.
create table public.trainer_notes (
  user_id     uuid primary key references public.profiles (id) on delete cascade,
  notes       text not null default '' check (char_length(notes) <= 20000),
  updated_by  uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index trainer_notes_updated_by_idx on public.trainer_notes (updated_by);

-- ---------------------------------------------------------------- courses
create table public.courses (
  id          text primary key
              check (id ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(id) <= 40),
  title_ar    text not null check (char_length(title_ar) between 1 and 300),
  title_en    text not null check (char_length(title_en) between 1 and 300),
  status      text not null default 'soon' check (status in ('available', 'soon')),
  sort        integer not null default 0,
  published   boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index courses_sort_idx on public.courses (sort);

create table public.course_items (
  id            uuid primary key default gen_random_uuid(),
  course_id     text not null references public.courses (id) on update restrict on delete restrict,
  kind          text not null check (kind in ('file', 'video')),
  title         text not null check (char_length(btrim(title)) between 1 and 300),
  url           text check (url is null or (url ~* '^https://' and char_length(url) <= 2000)),
  storage_path  text check (storage_path is null
                           or (char_length(storage_path) <= 1024 and position('..' in storage_path) = 0)),
  sort          integer not null default 0,
  published     boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint course_items_source_chk check (url is not null or storage_path is not null),
  -- objects of a course must live under "<course_id>/" in the course-files bucket
  constraint course_items_path_prefix_chk
    check (storage_path is null or left(storage_path, char_length(course_id) + 1) = course_id || '/')
);
create index course_items_course_sort_idx on public.course_items (course_id, sort);

create table public.quiz_questions (
  id             uuid primary key default gen_random_uuid(),
  course_id      text not null references public.courses (id) on update restrict on delete restrict,
  question       text not null check (char_length(btrim(question)) between 1 and 4000),
  options        jsonb not null
                 check (jsonb_typeof(options) = 'array'
                        and jsonb_array_length(options) between 2 and 10
                        and not jsonb_path_exists(options, '$[*] ? (@.type() != "string")')
                        and octet_length(options::text) <= 20000),
  correct_index  integer not null check (correct_index >= 0),
  explanation    text check (explanation is null or char_length(explanation) <= 4000),
  sort           integer not null default 0,
  published      boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint quiz_questions_correct_in_range_chk check (correct_index < jsonb_array_length(options))
);
create index quiz_questions_course_sort_idx on public.quiz_questions (course_id, sort);

-- answers format (graded server-side by trigger, see 003):
--   [{"q": "<quiz_question uuid>", "a": <chosen option index>}, ...]
create table public.quiz_attempts (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  course_id   text not null references public.courses (id) on update restrict on delete restrict,
  score       integer not null default 0 check (score >= 0),
  total       integer not null default 0 check (total >= 0),
  answers     jsonb not null default '[]'::jsonb
              check (jsonb_typeof(answers) = 'array' and jsonb_array_length(answers) <= 500),
  created_at  timestamptz not null default now(),
  constraint quiz_attempts_score_le_total_chk check (score <= total)
);
create index quiz_attempts_user_created_idx on public.quiz_attempts (user_id, created_at desc);
create index quiz_attempts_course_idx       on public.quiz_attempts (course_id);

create table public.enrollments (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles (id) on delete cascade,
  course_id   text not null references public.courses (id) on update restrict on delete restrict,
  status      text not null default 'active' check (status in ('active', 'revoked')),
  granted_by  uuid references public.profiles (id) on delete set null,
  granted_at  timestamptz not null default now(),
  revoked_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint enrollments_user_course_key unique (user_id, course_id),
  constraint enrollments_revoked_at_chk
    check ((status = 'active' and revoked_at is null) or (status = 'revoked' and revoked_at is not null))
);
create index enrollments_course_status_idx on public.enrollments (course_id, status);
create index enrollments_granted_by_idx    on public.enrollments (granted_by);

-- ---------------------------------------------------------------- contact
create table public.contact_messages (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(btrim(name)) between 1 and 120),
  email       text not null check (char_length(email) <= 254 and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]{2,}$'),
  phone       text check (phone is null or char_length(phone) <= 40),
  subject     text check (subject is null or char_length(subject) <= 200),
  message     text not null check (char_length(btrim(message)) between 1 and 4000),
  status      text not null default 'new' check (status in ('new', 'read', 'archived')),
  ip_hash     text,
  created_at  timestamptz not null default now()
);
create index contact_messages_ip_created_idx     on public.contact_messages (ip_hash, created_at);
create index contact_messages_status_created_idx on public.contact_messages (status, created_at desc);
create index contact_messages_created_idx        on public.contact_messages (created_at);

-- ---------------------------------------------------------------- blog
create table public.posts (
  id            uuid primary key default gen_random_uuid(),
  title         text not null check (char_length(btrim(title)) between 1 and 300),
  slug          text not null unique check (char_length(slug) <= 200 and slug ~ '^[^\s/?#%]+$'),
  body          text not null default '' check (char_length(body) <= 100000),
  media_url     text check (media_url is null or (media_url ~* '^https://' and char_length(media_url) <= 2000)),
  media_kind    text not null default 'none' check (media_kind in ('none', 'image', 'video')),
  published     boolean not null default false,
  published_at  timestamptz,
  author_id     uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint posts_media_chk check (media_kind = 'none' or media_url is not null)
);
create index posts_published_idx on public.posts (published, published_at desc);
create index posts_author_idx    on public.posts (author_id);

-- ---------------------------------------------------------------- settings / audit
create table public.site_settings (
  key              text primary key check (key ~ '^[a-z0-9_]+$' and char_length(key) <= 64),
  value            jsonb not null default '{}'::jsonb check (octet_length(value::text) <= 20000),
  trainee_visible  boolean not null default false,
  updated_by       uuid references public.profiles (id) on delete set null,
  updated_at       timestamptz not null default now()
);
create index site_settings_updated_by_idx on public.site_settings (updated_by);

create table public.audit_log (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid,
  action      text not null,
  entity      text not null,
  entity_id   text,
  details     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index audit_log_created_idx on public.audit_log (created_at desc);
create index audit_log_entity_idx  on public.audit_log (entity, entity_id);
create index audit_log_actor_idx   on public.audit_log (actor_id);

-- ---------------------------------------------------------------- lock down immediately
-- RLS on (and forced) + no API privileges until 004 grants exactly what is needed.
do $$
declare t text;
begin
  foreach t in array array['profiles','trainer_notes','courses','course_items','quiz_questions',
                           'quiz_attempts','enrollments','contact_messages','posts','site_settings','audit_log']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
  end loop;
end $$;
