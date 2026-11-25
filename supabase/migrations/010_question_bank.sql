-- 010_question_bank  (Exams system, milestone M1 part 2/2)  -- NOT APPLIED to any database yet.
-- Design spec: docs/exams/01-analysis-and-plan.md sections 4.2, 4.3, 4.4, 4.11, 4.12. Requires 009.
--
-- ADDITIVE ONLY. quiz_questions / quiz_attempts (legacy, key readable by enrolled trainees on purpose)
-- are NOT touched.
--
-- Contents
--   1. type registry  public.qb_question_types (13 question types seeded, 3 enabled with validators)
--      + validators private.qb_validate_mcq_single / _multi_response / _true_false (+ shared checks)
--   2. taxonomy       public.qb_taxonomy (domain > topic > subtopic, per course), public.qb_tags
--   3. bank           public.qb_sets + qb_set_versions (multi-question scenario stem)
--                     public.qb_questions + qb_question_versions (IMMUTABLE) + qb_question_keys (staff only)
--                     public.qb_question_tags, public.qb_media (attachment metadata; bucket comes in M7)
--   4. RPC            public.qb_save_question(jsonb)  (atomic: new version + its key)
--   5. audit, grants, RLS
--
-- Security model (plan 4.4 / 4.12):
--   * NO policy for trainees on any qb_* table. Read = has_staff_perm(course,'qbank.read'),
--     write = has_staff_perm(course,'qbank.write'); admin always (inside has_staff_perm).
--   * anon: no privilege at all on any qb_* table.
--   * Course isolation is enforced twice: RLS (per row course_id) AND composite FKs (course_id, id), so a
--     row of course A can never point to a taxonomy node / tag / set / question / media of course B.
--   * Versions, keys and set versions are immutable (UPDATE always rejected; DELETE only as a cascade
--     of deleting the parent question/set, which is admin-only for questions).
--   * Versions + keys are written ONLY by the qb_save_question RPC (no INSERT privilege).

-- ================================================================ 1. validators (shared checks)
-- All raise errcode 22023 with an English message; the UI maps codes, not messages.

-- object keys must be a subset of p_allowed
create or replace function private.qb_check_keys(p_obj jsonb, p_allowed text[], p_what text)
returns void
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_bad text;
begin
  if jsonb_typeof(p_obj) is distinct from 'object' then
    raise exception '% must be a JSON object', p_what using errcode = '22023';
  end if;
  select k into v_bad from jsonb_object_keys(p_obj) k where not (k = any (p_allowed)) limit 1;
  if v_bad is not null then
    raise exception '% has an unknown field: %', p_what, v_bad using errcode = '22023';
  end if;
end;
$$;

-- payload = public part sent to the browser later. It must never carry answer material.
create or replace function private.qb_check_public_payload(p_payload jsonb, p_allowed text[])
returns void
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_name text;
begin
  perform private.qb_check_keys(p_payload, p_allowed, 'payload');
  if octet_length(p_payload::text) > 65536 then
    raise exception 'payload too large (max 64KB)' using errcode = '22023';
  end if;
  foreach v_name in array array['correct', 'correct_answer', 'answer', 'answers', 'key', 'is_correct',
                                'explanation', 'explanations', 'feedback', 'rationale', 'solution'] loop
    if jsonb_path_exists(p_payload, ('$.**."' || v_name || '"')::jsonpath) then
      raise exception 'payload must not contain answer data (field "%"); put it in the key', v_name
        using errcode = '22023';
    end if;
  end loop;

  if jsonb_typeof(p_payload -> 'stem') is distinct from 'object'
     or jsonb_typeof(p_payload -> 'stem' -> 'text') is distinct from 'string'
     or char_length(btrim(p_payload -> 'stem' ->> 'text')) not between 1 and 10000 then
    raise exception 'payload.stem.text is required (1..10000 chars)' using errcode = '22023';
  end if;
  perform private.qb_check_keys(p_payload -> 'stem', array['text', 'lang'], 'payload.stem');

  if p_payload ? 'media' then
    if jsonb_typeof(p_payload -> 'media') <> 'array' or jsonb_array_length(p_payload -> 'media') > 10
       or jsonb_path_exists(p_payload -> 'media',
            '$[*] ? (@.type() != "string" || !(@ like_regex "^[0-9a-fA-F-]{36}$"))') then
      raise exception 'payload.media must be an array of up to 10 media ids (uuid)' using errcode = '22023';
    end if;
  end if;
end;
$$;

-- options: array of {id, text}, ids ^[a-z0-9_-]{1,16}$ unique. Returns the ids in order.
create or replace function private.qb_check_options(p_payload jsonb, p_min integer, p_max integer)
returns text[]
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_opts jsonb := p_payload -> 'options';
  v_o    jsonb;
  v_ids  text[] := array[]::text[];
begin
  if jsonb_typeof(v_opts) is distinct from 'array' or jsonb_array_length(v_opts) not between p_min and p_max then
    raise exception 'payload.options must be an array of % to % options', p_min, p_max using errcode = '22023';
  end if;
  for v_o in select e from jsonb_array_elements(v_opts) e loop
    perform private.qb_check_keys(v_o, array['id', 'text'], 'option');
    if jsonb_typeof(v_o -> 'id') is distinct from 'string' or (v_o ->> 'id') !~ '^[a-z0-9_-]{1,16}$' then
      raise exception 'option.id must match ^[a-z0-9_-]{1,16}$' using errcode = '22023';
    end if;
    if jsonb_typeof(v_o -> 'text') is distinct from 'string'
       or char_length(btrim(v_o ->> 'text')) not between 1 and 2000 then
      raise exception 'option.text is required (1..2000 chars)' using errcode = '22023';
    end if;
    if (v_o ->> 'id') = any (v_ids) then
      raise exception 'duplicate option id: %', v_o ->> 'id' using errcode = '22023';
    end if;
    v_ids := v_ids || (v_o ->> 'id');
  end loop;
  return v_ids;
end;
$$;

-- ---------------------------------------------------------------- per-type validators
-- Signature contract (registry): (payload jsonb, key jsonb) RETURNS text[] = the option ids that
-- option_explanations may reference (empty array if the type has none). Must raise 22023 if invalid.

-- mcq_single: payload {stem, options[2..10], media?}; key {correct: optionId}
create or replace function private.qb_validate_mcq_single(p_payload jsonb, p_key jsonb)
returns text[]
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_ids text[];
begin
  perform private.qb_check_public_payload(p_payload, array['stem', 'options', 'media']);
  v_ids := private.qb_check_options(p_payload, 2, 10);
  perform private.qb_check_keys(p_key, array['correct'], 'key');
  if jsonb_typeof(p_key -> 'correct') is distinct from 'string' or not ((p_key ->> 'correct') = any (v_ids)) then
    raise exception 'key.correct must be exactly one existing option id' using errcode = '22023';
  end if;
  return v_ids;
end;
$$;

-- multi_response: payload {stem, options[2..15], min_select?, max_select?, media?}
--                 key {correct: [optionId, ...] (>=1, unique), scoring?: all_or_nothing|partial|partial_penalty}
create or replace function private.qb_validate_multi_response(p_payload jsonb, p_key jsonb)
returns text[]
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_ids  text[];
  v_cor  text[];
  v_min  integer;
  v_max  integer;
begin
  perform private.qb_check_public_payload(p_payload, array['stem', 'options', 'min_select', 'max_select', 'media']);
  v_ids := private.qb_check_options(p_payload, 2, 15);

  if p_payload ? 'min_select' and jsonb_typeof(p_payload -> 'min_select') is distinct from 'number'
     or p_payload ? 'max_select' and jsonb_typeof(p_payload -> 'max_select') is distinct from 'number' then
    raise exception 'min_select/max_select must be integers' using errcode = '22023';
  end if;
  v_min := coalesce((p_payload ->> 'min_select')::numeric, 1)::integer;
  v_max := coalesce((p_payload ->> 'max_select')::numeric, cardinality(v_ids))::integer;
  if v_min < 1 or v_max > cardinality(v_ids) or v_min > v_max then
    raise exception 'invalid min_select/max_select range' using errcode = '22023';
  end if;

  perform private.qb_check_keys(p_key, array['correct', 'scoring'], 'key');
  if jsonb_typeof(p_key -> 'correct') is distinct from 'array' or jsonb_array_length(p_key -> 'correct') < 1
     or jsonb_path_exists(p_key -> 'correct', '$[*] ? (@.type() != "string")') then
    raise exception 'key.correct must be a non-empty array of option ids' using errcode = '22023';
  end if;
  select array_agg(e) into v_cor from jsonb_array_elements_text(p_key -> 'correct') e;
  if cardinality(v_cor) <> (select count(distinct x) from unnest(v_cor) x) then
    raise exception 'key.correct has duplicate ids' using errcode = '22023';
  end if;
  if not (v_cor <@ v_ids) then
    raise exception 'key.correct references an unknown option id' using errcode = '22023';
  end if;
  if cardinality(v_cor) < v_min or cardinality(v_cor) > v_max then
    raise exception 'number of correct options is outside min_select..max_select' using errcode = '22023';
  end if;
  if p_key ? 'scoring' and coalesce(p_key ->> 'scoring', '') not in ('all_or_nothing', 'partial', 'partial_penalty') then
    raise exception 'key.scoring must be all_or_nothing | partial | partial_penalty' using errcode = '22023';
  end if;
  return v_ids;
end;
$$;

-- true_false: payload {stem, labels?: {true: text, false: text}, media?}; key {correct: "true"|"false"}
-- The two option ids are fixed ("true", "false"); the player maps them to per-attempt opaque ids (M4).
create or replace function private.qb_validate_true_false(p_payload jsonb, p_key jsonb)
returns text[]
language plpgsql
immutable
set search_path = ''
as $$
begin
  perform private.qb_check_public_payload(p_payload, array['stem', 'labels', 'media']);
  if p_payload ? 'labels' then
    perform private.qb_check_keys(p_payload -> 'labels', array['true', 'false'], 'payload.labels');
    if jsonb_path_exists(p_payload -> 'labels', '$.* ? (@.type() != "string")')
       or char_length(coalesce(p_payload -> 'labels' ->> 'true', '')) > 200
       or char_length(coalesce(p_payload -> 'labels' ->> 'false', '')) > 200 then
      raise exception 'payload.labels values must be strings (max 200)' using errcode = '22023';
    end if;
  end if;
  perform private.qb_check_keys(p_key, array['correct'], 'key');
  if jsonb_typeof(p_key -> 'correct') is distinct from 'string' or (p_key ->> 'correct') not in ('true', 'false') then
    raise exception 'key.correct must be "true" or "false"' using errcode = '22023';
  end if;
  return array['true', 'false'];
end;
$$;

-- ================================================================ 1b. type registry
-- A new type = one row + one validator (+ grader in M4/M6 + JS renderer). No table migration needed.
-- validator is the TEXT signature 'private.qb_validate_<name>(jsonb,jsonb)' (not regprocedure: a reg*
-- column other than regclass/regtype/... blocks pg_upgrade). The CHECK fixes the format; the BEFORE
-- trigger below requires the function to exist at write time; private.qb_validate() resolves it with
-- to_regprocedure() at call time and treats a missing function as "not enabled".
-- Rows are maintained by migrations only (no API write privilege).
create or replace function private.qb_question_types_before()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- a value that fails the format CHECK is left to the CHECK (23514); only well-formed names are resolved
  if new.validator is not null
     and new.validator ~ '^private\.qb_validate_[a-z0-9_]+\(jsonb,jsonb\)$'
     and to_regprocedure(new.validator) is null then
    raise exception 'validator function not found: %', new.validator using errcode = '22023';
  end if;
  return new;
end;
$$;

create table public.qb_question_types (
  code             text primary key check (code ~ '^[a-z][a-z0-9_]{1,39}$'),
  name_ar          text not null check (char_length(name_ar) between 1 and 100),
  name_en          text not null check (char_length(name_en) between 1 and 100),
  grading          text not null check (grading in ('auto', 'manual')),
  schema_version   integer not null default 1 check (schema_version >= 1),
  public_schema    jsonb not null default '{}'::jsonb check (jsonb_typeof(public_schema) = 'object'),
  key_schema       jsonb not null default '{}'::jsonb check (jsonb_typeof(key_schema) = 'object'),
  response_schema  jsonb not null default '{}'::jsonb check (jsonb_typeof(response_schema) = 'object'),
  validator        text,
  enabled          boolean not null default false,
  sort             integer not null default 0,
  created_at       timestamptz not null default now(),
  constraint qb_question_types_validator_format_chk
    check (validator is null or validator ~ '^private\.qb_validate_[a-z0-9_]+\(jsonb,jsonb\)$'),
  constraint qb_question_types_enabled_needs_validator_chk check (not enabled or validator is not null)
);

create trigger qb_question_types_before before insert or update on public.qb_question_types
  for each row execute function private.qb_question_types_before();

insert into public.qb_question_types
  (code, name_ar, name_en, grading, sort, enabled, validator, public_schema, key_schema, response_schema)
values
  ('mcq_single',     'اختيار من متعدد (إجابة واحدة)', 'Multiple choice (single)', 'auto',   1, true,
   'private.qb_validate_mcq_single(jsonb,jsonb)',
   '{"stem":{"text":"string"},"options":[{"id":"string","text":"string"}],"media":["uuid"]}',
   '{"correct":"optionId"}', '{"choice":"optionId"}'),
  ('multi_response', 'اختيار متعدد (أكثر من إجابة)', 'Multiple response',        'auto',   2, true,
   'private.qb_validate_multi_response(jsonb,jsonb)',
   '{"stem":{"text":"string"},"options":[{"id":"string","text":"string"}],"min_select":"int?","max_select":"int?"}',
   '{"correct":["optionId"],"scoring":"all_or_nothing|partial|partial_penalty"}', '{"choices":["optionId"]}'),
  ('true_false',     'صح / خطأ',                     'True / False',             'auto',   3, true,
   'private.qb_validate_true_false(jsonb,jsonb)',
   '{"stem":{"text":"string"},"labels":{"true":"string?","false":"string?"}}',
   '{"correct":"true|false"}', '{"choice":"true|false"}'),
  -- registered but disabled until their validator/grader/renderer ship (M6/M7):
  ('numerical',      'إجابة رقمية',                   'Numerical',                'auto',   4, false, null, '{}', '{}', '{}'),
  ('short_answer',   'إجابة قصيرة',                   'Short answer',             'auto',   5, false, null, '{}', '{}', '{}'),
  ('essay',          'مقالي',                         'Essay',                    'manual', 6, false, null, '{}', '{}', '{}'),
  ('ordering',       'ترتيب',                         'Ordering',                 'auto',   7, false, null, '{}', '{}', '{}'),
  ('matching',       'مطابقة',                        'Matching',                 'auto',   8, false, null, '{}', '{}', '{}'),
  ('drag_drop',      'سحب وإفلات',                    'Drag and drop',            'auto',   9, false, null, '{}', '{}', '{}'),
  ('cloze',          'ملء الفراغات (قوائم منسدلة)',   'Cloze (embedded dropdowns)','auto',  10, false, null, '{}', '{}', '{}'),
  ('hotspot',        'نقطة ساخنة على صورة',            'Hotspot',                  'auto',  11, false, null, '{}', '{}', '{}'),
  ('graphic',        'سؤال مصوّر / خيارات صور',         'Graphic',                  'auto',  12, false, null, '{}', '{}', '{}'),
  ('case',           'حالة (سيناريو بسؤال واحد)',       'Case (single-question scenario)', 'auto', 13, false, null, '{}', '{}', '{}')
on conflict (code) do nothing;
-- Multi-question scenarios are NOT a type: they are the qb_sets entity below (children are normal questions).

-- dispatcher: looks up the registry and runs the type's validator; returns option ids.
create or replace function private.qb_validate(p_type text, p_payload jsonb, p_key jsonb)
returns text[]
language plpgsql
stable
set search_path = ''
as $$
declare
  v_sig text;
  v_fn  regprocedure;
  v_on  boolean;
  v_ids text[];
begin
  select t.validator, t.enabled into v_sig, v_on from public.qb_question_types t where t.code = p_type;
  -- resolve the stored signature now; a validator that no longer exists counts as "not enabled"
  -- (an unknown type leaves v_sig/v_on null, so it falls into the same error)
  if v_sig is not null then
    v_fn := to_regprocedure(v_sig);
  end if;
  if v_on is not true or v_fn is null then
    raise exception 'question type "%" is unknown or not enabled', p_type using errcode = '22023';
  end if;
  if p_payload is null or p_key is null then
    raise exception 'payload and key are required' using errcode = '22023';
  end if;
  if octet_length(p_key::text) > 16384 then
    raise exception 'key too large (max 16KB)' using errcode = '22023';
  end if;
  execute format('select %s($1, $2)', v_fn::oid::regproc) into v_ids using p_payload, p_key;
  return coalesce(v_ids, array[]::text[]);
end;
$$;

-- ---------------------------------------------------------------- duplicate detection
-- Arabic-aware normalization: drop tashkeel/tatweel, unify alef/ya/ta-marbuta, Arabic-Indic digits,
-- lower-case, collapse spaces.
create or replace function private.qb_normalize_text(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select btrim(regexp_replace(
           translate(lower(regexp_replace(coalesce(p, ''), '[ً-ْٰـ]', '', 'g')),
                     'أإآٱىة٠١٢٣٤٥٦٧٨٩', 'اااايه0123456789'),
           '\s+', ' ', 'g'));
$$;

-- content_hash = sha256(normalized stem || sorted normalized option texts): option order does not matter.
create or replace function private.qb_content_hash(p_payload jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(sha256(convert_to(
           private.qb_normalize_text(p_payload -> 'stem' ->> 'text') || '||' ||
           coalesce((select string_agg(private.qb_normalize_text(o ->> 'text'), '|'
                                       order by private.qb_normalize_text(o ->> 'text'))
                     from jsonb_array_elements(case when jsonb_typeof(p_payload -> 'options') = 'array'
                                                    then p_payload -> 'options' else '[]'::jsonb end) o), ''),
           'UTF8')), 'hex');
$$;

-- ================================================================ 2. taxonomy + tags
create table public.qb_taxonomy (
  id          uuid primary key default gen_random_uuid(),
  course_id   text not null references public.courses (id) on update restrict on delete restrict,
  parent_id   uuid,
  level       text not null check (level in ('domain', 'topic', 'subtopic')),
  code        text check (code is null or (code ~ '^[A-Za-z0-9._-]{1,40}$')),
  name_ar     text not null check (char_length(btrim(name_ar)) between 1 and 300),
  name_en     text check (name_en is null or char_length(name_en) <= 300),
  sort        integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint qb_taxonomy_course_id_id_key unique (course_id, id),
  constraint qb_taxonomy_parent_fkey foreign key (course_id, parent_id)
    references public.qb_taxonomy (course_id, id) on update restrict on delete restrict,
  constraint qb_taxonomy_root_chk check ((level = 'domain') = (parent_id is null))
);
create index qb_taxonomy_parent_idx on public.qb_taxonomy (course_id, parent_id, sort);
create unique index qb_taxonomy_course_code_key on public.qb_taxonomy (course_id, code) where code is not null;

create table public.qb_tags (
  id          uuid primary key default gen_random_uuid(),
  course_id   text not null references public.courses (id) on update restrict on delete restrict,
  label       text not null check (char_length(btrim(label)) between 1 and 80),
  created_at  timestamptz not null default now(),
  constraint qb_tags_course_id_id_key unique (course_id, id)
);
create unique index qb_tags_course_label_key on public.qb_tags (course_id, lower(btrim(label)));

-- ================================================================ 3. sets (multi-question scenarios)
create table public.qb_sets (
  id                  uuid primary key default gen_random_uuid(),
  course_id           text not null references public.courses (id) on update restrict on delete restrict,
  title               text check (title is null or char_length(title) <= 300),
  status              text not null default 'draft' check (status in ('draft', 'active', 'retired')),
  current_version_id  uuid,
  created_by          uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint qb_sets_course_id_id_key unique (course_id, id)
);
create index qb_sets_created_by_idx on public.qb_sets (created_by);

create table public.qb_set_versions (
  id          uuid primary key default gen_random_uuid(),
  set_id      uuid not null,
  course_id   text not null,
  version_no  integer not null check (version_no >= 1),
  stem        jsonb not null check (jsonb_typeof(stem) = 'object'
                                    and jsonb_typeof(stem -> 'text') = 'string'
                                    and char_length(btrim(stem ->> 'text')) between 1 and 20000
                                    and octet_length(stem::text) <= 65536),
  created_by  uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  constraint qb_set_versions_set_no_key unique (set_id, version_no),
  constraint qb_set_versions_set_id_id_key unique (set_id, id),
  constraint qb_set_versions_set_fkey foreign key (course_id, set_id)
    references public.qb_sets (course_id, id) on update restrict on delete cascade
);
create index qb_set_versions_course_set_idx on public.qb_set_versions (course_id, set_id);
create index qb_set_versions_created_by_idx on public.qb_set_versions (created_by);

alter table public.qb_sets
  add constraint qb_sets_current_version_fkey foreign key (id, current_version_id)
    references public.qb_set_versions (set_id, id) on update restrict on delete restrict;
create index qb_sets_current_version_idx on public.qb_sets (id, current_version_id);

-- ================================================================ 3b. questions / versions / keys
create table public.qb_questions (
  id                  uuid primary key default gen_random_uuid(),
  course_id           text not null references public.courses (id) on update restrict on delete restrict,
  set_id              uuid,
  current_version_id  uuid,
  status              text not null default 'draft' check (status in ('draft', 'active', 'retired')),
  created_by          uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint qb_questions_course_id_id_key unique (course_id, id),
  constraint qb_questions_set_fkey foreign key (course_id, set_id)
    references public.qb_sets (course_id, id) on update restrict on delete restrict
);
create index qb_questions_course_status_idx on public.qb_questions (course_id, status);
create index qb_questions_set_idx           on public.qb_questions (course_id, set_id);
create index qb_questions_created_by_idx    on public.qb_questions (created_by);

create table public.qb_question_versions (
  id            uuid primary key default gen_random_uuid(),
  question_id   uuid not null,
  course_id     text not null,
  version_no    integer not null check (version_no >= 1),
  type_code     text not null references public.qb_question_types (code) on update restrict on delete restrict,
  payload       jsonb not null check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 65536),
  taxonomy_id   uuid,
  difficulty    text not null default 'medium' check (difficulty in ('easy', 'medium', 'hard')),
  points        numeric(8,2) not null default 1 check (points > 0 and points <= 1000),
  weight        numeric(6,2) not null default 1 check (weight > 0 and weight <= 100),
  lang          text not null default 'ar' check (lang in ('ar', 'en', 'mixed')),
  content_hash  text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  created_by    uuid references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now(),
  constraint qb_question_versions_q_no_key    unique (question_id, version_no),
  constraint qb_question_versions_q_id_key    unique (question_id, id),
  constraint qb_question_versions_course_id_id_key unique (course_id, id),
  constraint qb_question_versions_question_fkey foreign key (course_id, question_id)
    references public.qb_questions (course_id, id) on update restrict on delete cascade,
  constraint qb_question_versions_taxonomy_fkey foreign key (course_id, taxonomy_id)
    references public.qb_taxonomy (course_id, id) on update restrict on delete restrict
);
create index qb_question_versions_course_hash_idx on public.qb_question_versions (course_id, content_hash);
create index qb_question_versions_taxonomy_idx    on public.qb_question_versions (course_id, taxonomy_id);
create index qb_question_versions_type_idx        on public.qb_question_versions (type_code);
create index qb_question_versions_created_by_idx  on public.qb_question_versions (created_by);
-- covers the composite FK qb_question_versions_question_fkey (course_id, question_id)
create index qb_question_versions_question_idx    on public.qb_question_versions (course_id, question_id);

alter table public.qb_questions
  add constraint qb_questions_current_version_fkey foreign key (id, current_version_id)
    references public.qb_question_versions (question_id, id) on update restrict on delete restrict;
create index qb_questions_current_version_idx on public.qb_questions (id, current_version_id);

-- STAFF-ONLY answer material for exactly one version.
create table public.qb_question_keys (
  version_id           uuid primary key,
  course_id            text not null,
  key                  jsonb not null check (jsonb_typeof(key) = 'object' and octet_length(key::text) <= 16384),
  feedback_correct     text check (feedback_correct   is null or char_length(feedback_correct)   <= 4000),
  feedback_incorrect   text check (feedback_incorrect is null or char_length(feedback_incorrect) <= 4000),
  explanation          text check (explanation        is null or char_length(explanation)        <= 20000),
  option_explanations  jsonb not null default '{}'::jsonb
                       check (jsonb_typeof(option_explanations) = 'object'
                              and octet_length(option_explanations::text) <= 65536),
  reference            text check (reference is null or char_length(reference) <= 2000),
  created_at           timestamptz not null default now(),
  constraint qb_question_keys_version_fkey foreign key (course_id, version_id)
    references public.qb_question_versions (course_id, id) on update restrict on delete cascade
);
create index qb_question_keys_course_version_idx on public.qb_question_keys (course_id, version_id);

create table public.qb_question_tags (
  course_id    text not null,
  question_id  uuid not null,
  tag_id       uuid not null,
  created_at   timestamptz not null default now(),
  constraint qb_question_tags_pkey primary key (question_id, tag_id),
  constraint qb_question_tags_question_fkey foreign key (course_id, question_id)
    references public.qb_questions (course_id, id) on update restrict on delete cascade,
  constraint qb_question_tags_tag_fkey foreign key (course_id, tag_id)
    references public.qb_tags (course_id, id) on update restrict on delete cascade
);
create index qb_question_tags_tag_idx on public.qb_question_tags (course_id, tag_id);
create index qb_question_tags_question_idx on public.qb_question_tags (course_id, question_id);

-- Attachment METADATA only. The private bucket "exam-media" + signing Edge Function arrive in M7
-- (plan 4.10 / M7); until then no object can be served to anyone but via staff tools.
create table public.qb_media (
  id            uuid primary key default gen_random_uuid(),
  course_id     text not null references public.courses (id) on update restrict on delete restrict,
  bucket_id     text not null default 'exam-media' check (bucket_id = 'exam-media'),
  storage_path  text not null check (char_length(storage_path) <= 1024 and position('..' in storage_path) = 0),
  mime_type     text not null check (mime_type in ('image/png', 'image/jpeg', 'image/webp', 'image/gif',
                                                   'image/svg+xml', 'audio/mpeg', 'video/mp4', 'application/pdf')),
  byte_size     bigint check (byte_size is null or (byte_size > 0 and byte_size <= 52428800)),
  width         integer check (width  is null or width  between 1 and 20000),
  height        integer check (height is null or height between 1 and 20000),
  sha256        text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  alt_ar        text check (alt_ar is null or char_length(alt_ar) <= 1000),
  alt_en        text check (alt_en is null or char_length(alt_en) <= 1000),
  created_by    uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now(),
  constraint qb_media_course_id_id_key unique (course_id, id),
  constraint qb_media_path_key unique (bucket_id, storage_path),
  -- same layout rule as course_items: objects of a course live under "<course_id>/"
  constraint qb_media_path_prefix_chk check (left(storage_path, char_length(course_id) + 1) = course_id || '/')
);
create index qb_media_created_by_idx on public.qb_media (created_by);

-- lock down immediately
do $$
declare t text;
begin
  foreach t in array array['qb_question_types', 'qb_taxonomy', 'qb_tags', 'qb_sets', 'qb_set_versions',
                           'qb_questions', 'qb_question_versions', 'qb_question_keys', 'qb_question_tags',
                           'qb_media'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
  end loop;
end $$;

-- ================================================================ 3c. triggers
-- immutability: versions, keys, set versions. UPDATE never; DELETE only via FK cascade from the
-- parent (pg_trigger_depth() > 1), i.e. deleting the whole question/set.
create or replace function private.qb_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception '% rows are immutable: save a new version instead', tg_table_name using errcode = '42501';
  end if;
  if pg_trigger_depth() <= 1 then
    raise exception '% rows cannot be deleted directly (delete the parent question/set)', tg_table_name
      using errcode = '42501';
  end if;
  return old;
end;
$$;

create trigger qb_question_versions_immutable before update or delete on public.qb_question_versions
  for each row execute function private.qb_immutable();
create trigger qb_question_keys_immutable     before update or delete on public.qb_question_keys
  for each row execute function private.qb_immutable();
create trigger qb_set_versions_immutable      before update or delete on public.qb_set_versions
  for each row execute function private.qb_immutable();

-- taxonomy: level must follow the parent (domain > topic > subtopic); level and course are fixed.
create or replace function private.qb_taxonomy_before()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_parent_level text;
begin
  if tg_op = 'UPDATE' then
    if new.course_id is distinct from old.course_id or new.level is distinct from old.level then
      raise exception 'course_id and level of a taxonomy node cannot change' using errcode = '42501';
    end if;
    new.created_at := old.created_at;
  end if;
  if new.parent_id is not null then
    select t.level into v_parent_level
    from public.qb_taxonomy t where t.course_id = new.course_id and t.id = new.parent_id;
    -- a parent of another course is not found here (and the composite FK rejects it anyway)
    if v_parent_level is null then
      raise exception 'parent taxonomy node not found in this course' using errcode = '23503';
    end if;
    if (new.level = 'topic' and v_parent_level <> 'domain')
       or (new.level = 'subtopic' and v_parent_level <> 'topic') then
      raise exception 'a % must be under a %', new.level,
        case new.level when 'topic' then 'domain' else 'topic' end using errcode = '22023';
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger qb_taxonomy_before before insert or update on public.qb_taxonomy
  for each row execute function private.qb_taxonomy_before();

-- questions / sets: course_id fixed; updated_at
create or replace function private.qb_parent_before()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.course_id is distinct from old.course_id then
      raise exception 'course_id cannot change' using errcode = '42501';
    end if;
    new.created_at := old.created_at;
    new.created_by := old.created_by;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger qb_questions_before before insert or update on public.qb_questions
  for each row execute function private.qb_parent_before();
create trigger qb_sets_before      before insert or update on public.qb_sets
  for each row execute function private.qb_parent_before();

-- set versions are inserted through REST by staff: number them and move the set's current version.
-- SECURITY DEFINER because the caller has no privilege on qb_sets.current_version_id.
-- course_id always comes from the set (client value ignored); RLS WITH CHECK then verifies the
-- caller has qbank.write on THAT course.
create or replace function private.qb_set_versions_before()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_course text;
begin
  select s.course_id into v_course from public.qb_sets s where s.id = new.set_id for update;
  if v_course is null then
    raise exception 'set not found' using errcode = '23503';
  end if;
  new.course_id  := v_course;
  new.version_no := coalesce((select max(v.version_no) from public.qb_set_versions v where v.set_id = new.set_id), 0) + 1;
  new.created_by := (select auth.uid());
  new.created_at := now();
  return new;
end;
$$;

create or replace function private.qb_set_versions_after()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.qb_sets set current_version_id = new.id where id = new.set_id;
  return null;
end;
$$;

create trigger qb_set_versions_before before insert on public.qb_set_versions
  for each row execute function private.qb_set_versions_before();
create trigger qb_set_versions_after  after insert on public.qb_set_versions
  for each row execute function private.qb_set_versions_after();

-- audit: question created / status changed / deleted (versions themselves are the edit history)
create or replace function private.audit_qb_questions()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_action text;
begin
  if tg_op = 'INSERT' then
    v_action := 'qb_question.created';
  elsif tg_op = 'DELETE' then
    v_action := 'qb_question.deleted';
  else
    v_action := 'qb_question.status_changed';
  end if;
  insert into public.audit_log (actor_id, action, entity, entity_id, details)
  values ((select auth.uid()), v_action, 'qb_questions', coalesce(new.id, old.id)::text,
          jsonb_build_object('course_id', coalesce(new.course_id, old.course_id),
                             'old_status', old.status, 'new_status', new.status));
  return null;
end;
$$;

create trigger qb_questions_audit_insert_delete after insert or delete on public.qb_questions
  for each row execute function private.audit_qb_questions();
create trigger qb_questions_audit_status after update on public.qb_questions
  for each row when (old.status is distinct from new.status)
  execute function private.audit_qb_questions();

-- ================================================================ 4. RPC qb_save_question
-- Creates a question (p.question_id absent/null) or a NEW VERSION of an existing one, plus its key,
-- atomically. Course and permission are derived from the stored question, never trusted from input.
-- Input (jsonb):
--   question_id?, course_id (new only), type_code (new; edit defaults to current), payload, key,
--   feedback_correct?, feedback_incorrect?, explanation?, option_explanations?, reference?,
--   taxonomy_id?, difficulty?, points?, weight?, lang?, set_id?, status?
--   On edit, an omitted optional field is inherited from the current version.
-- Output: {question_id, version_id, version_no, content_hash, duplicates}
-- Errors: 42501 forbidden (also for "not found", to avoid an existence oracle), 22023 invalid input,
--         23503 foreign row of another course, P0001 rate_limited.
create or replace function private.qb_save_question(p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid      uuid := (select auth.uid());
  v_qid      uuid;
  v_course   text;
  v_prev     public.qb_question_versions%rowtype;
  v_prevkey  public.qb_question_keys%rowtype;
  v_type     text;
  v_ids      text[];
  v_oe       jsonb;
  v_vid      uuid;
  v_no       integer;
  v_hash     text;
  v_status   text;
  v_set      uuid;
  v_dups     integer;
  v_bad      text;
begin
  if v_uid is null then
    raise exception 'forbidden: sign-in required' using errcode = '42501';
  end if;
  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception 'request must be a JSON object' using errcode = '22023';
  end if;
  if octet_length(p::text) > 196608 then
    raise exception 'request too large' using errcode = '22023';
  end if;
  perform private.qb_check_keys(p, array['question_id', 'course_id', 'type_code', 'payload', 'key',
    'feedback_correct', 'feedback_incorrect', 'explanation', 'option_explanations', 'reference',
    'taxonomy_id', 'difficulty', 'points', 'weight', 'lang', 'set_id', 'status'], 'request');

  if nullif(p ->> 'question_id', '') is not null then
    v_qid := (p ->> 'question_id')::uuid;
    select q.course_id into v_course from public.qb_questions q where q.id = v_qid for update;
  else
    v_course := nullif(p ->> 'course_id', '');
  end if;

  if v_course is null or not private.has_staff_perm(v_course, 'qbank.write') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_qid is not null and p ? 'course_id' and (p ->> 'course_id') is distinct from v_course then
    raise exception 'course_id does not match the question' using errcode = '22023';
  end if;

  perform private.rl_hit('qb_save:' || v_uid::text, 60, 120);

  if v_qid is not null then
    select v.* into v_prev from public.qb_question_versions v
    join public.qb_questions q on q.current_version_id = v.id where q.id = v_qid;
    select k.* into v_prevkey from public.qb_question_keys k where k.version_id = v_prev.id;
  end if;

  v_type := coalesce(nullif(p ->> 'type_code', ''), v_prev.type_code);
  v_ids  := private.qb_validate(v_type, p -> 'payload', p -> 'key');

  -- option_explanations: {optionId: text}
  v_oe := case when p ? 'option_explanations' then coalesce(p -> 'option_explanations', '{}'::jsonb)
               else coalesce(v_prevkey.option_explanations, '{}'::jsonb) end;
  if jsonb_typeof(v_oe) <> 'object' then
    raise exception 'option_explanations must be an object' using errcode = '22023';
  end if;
  select k into v_bad from jsonb_each(v_oe) e(k, val)
  where not (k = any (v_ids)) or jsonb_typeof(val) <> 'string' or char_length(val #>> '{}') > 4000 limit 1;
  if v_bad is not null then
    raise exception 'option_explanations: unknown option id or invalid text (%)', v_bad using errcode = '22023';
  end if;

  -- media referenced by the payload must belong to the same course
  if jsonb_typeof(p -> 'payload' -> 'media') = 'array' and exists (
       select 1 from jsonb_array_elements_text(p -> 'payload' -> 'media') m(id)
       where not exists (select 1 from public.qb_media x where x.course_id = v_course and x.id = m.id::uuid)) then
    raise exception 'payload.media references media that does not exist in this course' using errcode = '23503';
  end if;

  v_hash := private.qb_content_hash(p -> 'payload');

  if v_qid is null then
    v_status := coalesce(nullif(p ->> 'status', ''), 'draft');
    insert into public.qb_questions (course_id, set_id, status, created_by)
    values (v_course, nullif(p ->> 'set_id', '')::uuid, v_status, v_uid)
    returning id into v_qid;
    v_no := 1;
  else
    update public.qb_questions q
       set set_id = case when p ? 'set_id' then nullif(p ->> 'set_id', '')::uuid else q.set_id end,
           status = coalesce(nullif(p ->> 'status', ''), q.status)
     where q.id = v_qid;
    select coalesce(max(v.version_no), 0) + 1 into v_no from public.qb_question_versions v where v.question_id = v_qid;
  end if;

  insert into public.qb_question_versions
    (question_id, course_id, version_no, type_code, payload, taxonomy_id, difficulty, points, weight, lang,
     content_hash, created_by)
  values (
    v_qid, v_course, v_no, v_type, p -> 'payload',
    case when p ? 'taxonomy_id' then nullif(p ->> 'taxonomy_id', '')::uuid else v_prev.taxonomy_id end,
    coalesce(nullif(p ->> 'difficulty', ''), v_prev.difficulty, 'medium'),
    coalesce((p ->> 'points')::numeric, v_prev.points, 1),
    coalesce((p ->> 'weight')::numeric, v_prev.weight, 1),
    coalesce(nullif(p ->> 'lang', ''), v_prev.lang, 'ar'),
    v_hash, v_uid)
  returning id into v_vid;

  insert into public.qb_question_keys
    (version_id, course_id, key, feedback_correct, feedback_incorrect, explanation, option_explanations, reference)
  values (
    v_vid, v_course, p -> 'key',
    case when p ? 'feedback_correct'   then p ->> 'feedback_correct'   else v_prevkey.feedback_correct   end,
    case when p ? 'feedback_incorrect' then p ->> 'feedback_incorrect' else v_prevkey.feedback_incorrect end,
    case when p ? 'explanation'        then p ->> 'explanation'        else v_prevkey.explanation        end,
    v_oe,
    case when p ? 'reference'          then p ->> 'reference'          else v_prevkey.reference          end);

  update public.qb_questions set current_version_id = v_vid where id = v_qid;

  select count(*) into v_dups
  from public.qb_question_versions v
  join public.qb_questions q on q.current_version_id = v.id
  where v.course_id = v_course and v.content_hash = v_hash and v.question_id <> v_qid;

  return jsonb_build_object('question_id', v_qid, 'version_id', v_vid, 'version_no', v_no,
                            'content_hash', v_hash, 'duplicates', v_dups);
end;
$$;

-- REST wrapper (/rest/v1/rpc/qb_save_question), SECURITY INVOKER like 006/007
create or replace function public.qb_save_question(p jsonb)
returns jsonb
language sql
volatile
set search_path = ''
as $$
  select private.qb_save_question(p);
$$;

-- ================================================================ 5. grants + RLS
-- Read policies short-circuit for admins with an initplan; has_staff_perm() is evaluated per row
-- for staff (it depends on course_id). Writes: qbank.write. No trainee/anon policy anywhere.

-- type registry: readable by admin and by any active instructor; written by migrations only.
grant select on public.qb_question_types to authenticated;
create policy qb_question_types_select on public.qb_question_types
  for select to authenticated
  using ((select private.is_admin()) or (select private.is_any_course_staff()));

-- taxonomy
grant select, delete on public.qb_taxonomy to authenticated;
grant insert (course_id, parent_id, level, code, name_ar, name_en, sort) on public.qb_taxonomy to authenticated;
grant update (parent_id, code, name_ar, name_en, sort) on public.qb_taxonomy to authenticated;
create policy qb_taxonomy_select on public.qb_taxonomy for select to authenticated
  using ((select private.is_admin()) or private.has_staff_perm(course_id, 'qbank.read'));
create policy qb_taxonomy_insert on public.qb_taxonomy for insert to authenticated
  with check (private.has_staff_perm(course_id, 'qbank.write'));
create policy qb_taxonomy_update on public.qb_taxonomy for update to authenticated
  using (private.has_staff_perm(course_id, 'qbank.write')) with check (private.has_staff_perm(course_id, 'qbank.write'));
create policy qb_taxonomy_delete on public.qb_taxonomy for delete to authenticated
  using (private.has_staff_perm(course_id, 'qbank.write'));

-- tags
grant select, delete on public.qb_tags to authenticated;
grant insert (course_id, label) on public.qb_tags to authenticated;
grant update (label) on public.qb_tags to authenticated;
create policy qb_tags_select on public.qb_tags for select to authenticated
  using ((select private.is_admin()) or private.has_staff_perm(course_id, 'qbank.read'));
create policy qb_tags_insert on public.qb_tags for insert to authenticated
  with check (private.has_staff_perm(course_id, 'qbank.write'));
create policy qb_tags_update on public.qb_tags for update to authenticated
  using (private.has_staff_perm(course_id, 'qbank.write')) with check (private.has_staff_perm(course_id, 'qbank.write'));
create policy qb_tags_delete on public.qb_tags for delete to authenticated
  using (private.has_staff_perm(course_id, 'qbank.write'));

-- sets
grant select, delete on public.qb_sets to authenticated;
grant insert (course_id, title, status) on public.qb_sets to authenticated;
grant update (title, status) on public.qb_sets to authenticated;
create policy qb_sets_select on public.qb_sets for select to authenticated
  using ((select private.is_admin()) or private.has_staff_perm(course_id, 'qbank.read'));
create policy qb_sets_insert on public.qb_sets for insert to authenticated
  with check (private.has_staff_perm(course_id, 'qbank.write'));
create policy qb_sets_update on public.qb_sets for update to authenticated
  using (private.has_staff_perm(course_id, 'qbank.write')) with check (private.has_staff_perm(course_id, 'qbank.write'));
create policy qb_sets_delete on public.qb_sets for delete to authenticated
  using (private.has_staff_perm(course_id, 'qbank.write'));

-- set versions: insert only (immutable)
grant select on public.qb_set_versions to authenticated;
grant insert (set_id, stem) on public.qb_set_versions to authenticated;
create policy qb_set_versions_select on public.qb_set_versions for select to authenticated
  using ((select private.is_admin()) or private.has_staff_perm(course_id, 'qbank.read'));
create policy qb_set_versions_insert on public.qb_set_versions for insert to authenticated
  with check (private.has_staff_perm(course_id, 'qbank.write'));

-- questions: created via RPC; REST may change status; delete = admin only (cascades its versions)
grant select, delete on public.qb_questions to authenticated;
grant update (status) on public.qb_questions to authenticated;
create policy qb_questions_select on public.qb_questions for select to authenticated
  using ((select private.is_admin()) or private.has_staff_perm(course_id, 'qbank.read'));
create policy qb_questions_update on public.qb_questions for update to authenticated
  using (private.has_staff_perm(course_id, 'qbank.write')) with check (private.has_staff_perm(course_id, 'qbank.write'));
create policy qb_questions_delete_admin on public.qb_questions for delete to authenticated
  using ((select private.is_admin()));

-- versions + keys: read only (written by qb_save_question)
grant select on public.qb_question_versions to authenticated;
create policy qb_question_versions_select on public.qb_question_versions for select to authenticated
  using ((select private.is_admin()) or private.has_staff_perm(course_id, 'qbank.read'));

grant select on public.qb_question_keys to authenticated;
create policy qb_question_keys_select on public.qb_question_keys for select to authenticated
  using ((select private.is_admin()) or private.has_staff_perm(course_id, 'qbank.read'));

-- question <-> tag
grant select, delete on public.qb_question_tags to authenticated;
grant insert (course_id, question_id, tag_id) on public.qb_question_tags to authenticated;
create policy qb_question_tags_select on public.qb_question_tags for select to authenticated
  using ((select private.is_admin()) or private.has_staff_perm(course_id, 'qbank.read'));
create policy qb_question_tags_insert on public.qb_question_tags for insert to authenticated
  with check (private.has_staff_perm(course_id, 'qbank.write'));
create policy qb_question_tags_delete on public.qb_question_tags for delete to authenticated
  using (private.has_staff_perm(course_id, 'qbank.write'));

-- media metadata
grant select, delete on public.qb_media to authenticated;
grant insert (course_id, storage_path, mime_type, byte_size, width, height, sha256, alt_ar, alt_en)
  on public.qb_media to authenticated;
grant update (alt_ar, alt_en) on public.qb_media to authenticated;
create policy qb_media_select on public.qb_media for select to authenticated
  using ((select private.is_admin()) or private.has_staff_perm(course_id, 'qbank.read'));
create policy qb_media_insert on public.qb_media for insert to authenticated
  with check (private.has_staff_perm(course_id, 'qbank.write'));
create policy qb_media_update on public.qb_media for update to authenticated
  using (private.has_staff_perm(course_id, 'qbank.write')) with check (private.has_staff_perm(course_id, 'qbank.write'));
create policy qb_media_delete on public.qb_media for delete to authenticated
  using (private.has_staff_perm(course_id, 'qbank.write'));

-- EXECUTE privileges
revoke execute on function private.qb_check_keys(jsonb, text[], text)          from public, anon, authenticated;
revoke execute on function private.qb_check_public_payload(jsonb, text[])      from public, anon, authenticated;
revoke execute on function private.qb_check_options(jsonb, integer, integer)   from public, anon, authenticated;
revoke execute on function private.qb_validate_mcq_single(jsonb, jsonb)        from public, anon, authenticated;
revoke execute on function private.qb_validate_multi_response(jsonb, jsonb)    from public, anon, authenticated;
revoke execute on function private.qb_validate_true_false(jsonb, jsonb)        from public, anon, authenticated;
revoke execute on function private.qb_validate(text, jsonb, jsonb)             from public, anon, authenticated;
revoke execute on function private.qb_question_types_before()                  from public, anon, authenticated;
revoke execute on function private.qb_normalize_text(text)                     from public, anon, authenticated;
revoke execute on function private.qb_content_hash(jsonb)                      from public, anon, authenticated;
revoke execute on function private.qb_immutable()                              from public, anon, authenticated;
revoke execute on function private.qb_taxonomy_before()                        from public, anon, authenticated;
revoke execute on function private.qb_parent_before()                          from public, anon, authenticated;
revoke execute on function private.qb_set_versions_before()                    from public, anon, authenticated;
revoke execute on function private.qb_set_versions_after()                     from public, anon, authenticated;
revoke execute on function private.audit_qb_questions()                        from public, anon, authenticated;
revoke execute on function private.qb_save_question(jsonb)                     from public, anon, authenticated;
revoke execute on function public.qb_save_question(jsonb)                      from public, anon, authenticated;
-- the RPC (forbidden unless qbank.write on the target course)
grant execute on function private.qb_save_question(jsonb) to authenticated;
grant execute on function public.qb_save_question(jsonb)  to authenticated;
-- (trigger functions need no EXECUTE grant: PostgreSQL checks it at CREATE TRIGGER time only)

-- ================================================================ ROLLBACK (commented out; see docs/exams/rollback-M1.sql)
-- Removes ONLY what this file created. Run BEFORE 009's rollback. Destroys all question-bank data.
-- drop function if exists public.qb_save_question(jsonb);
-- drop function if exists private.qb_save_question(jsonb);
-- drop table if exists public.qb_question_tags, public.qb_question_keys, public.qb_media cascade;
-- alter table if exists public.qb_questions drop constraint if exists qb_questions_current_version_fkey;
-- alter table if exists public.qb_sets drop constraint if exists qb_sets_current_version_fkey;
-- drop table if exists public.qb_question_versions, public.qb_questions, public.qb_set_versions,
--                      public.qb_sets, public.qb_tags, public.qb_taxonomy, public.qb_question_types cascade;
-- drop function if exists private.audit_qb_questions(), private.qb_set_versions_after(),
--   private.qb_set_versions_before(), private.qb_parent_before(), private.qb_taxonomy_before(),
--   private.qb_immutable(), private.qb_content_hash(jsonb), private.qb_normalize_text(text),
--   private.qb_validate(text, jsonb, jsonb), private.qb_question_types_before(),
--   private.qb_validate_true_false(jsonb, jsonb),
--   private.qb_validate_multi_response(jsonb, jsonb), private.qb_validate_mcq_single(jsonb, jsonb),
--   private.qb_check_options(jsonb, integer, integer), private.qb_check_public_payload(jsonb, text[]),
--   private.qb_check_keys(jsonb, text[], text);
