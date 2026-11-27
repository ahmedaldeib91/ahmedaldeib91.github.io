-- 017_question_types_b  (LMS phase 2b, part 1/3: validators + registry for 5 new question types)
-- Types: short_answer, numerical, essay, ordering, fill_blank (text blanks). The registry rows short_answer / numerical / essay /
-- ordering already exist (disabled, seeded in 010); fill_blank is new. Runtime (attempts/grading) is 018; manual grading is 019.
-- ADDITIVE: new functions + registry rows only. Existing questions and attempts are untouched.
--
--   short_answer  payload {stem, media?, max_chars?}                      key {answers:[1..20 text], case_sensitive?}
--   numerical     payload {stem, media?, unit?}                           key {value, tolerance?, tolerance_mode? absolute|percent}
--   essay         payload {stem, media?, min_words?, max_words?}          key {rubric?, model_answer?}   (graded by staff)
--   ordering      payload {stem, items[2..10] {id,text}, media?}          key {order:[ids, a permutation], scoring? all_or_nothing|partial}
--   fill_blank    payload {stem with {{id}} markers, blanks:[{id}] 1..10, media?}
--                                                                         key {blanks:{id:[1..10 accepted text]}, case_sensitive?, scoring?}
-- Every validator returns the ids option_explanations may reference (ordering: item ids, fill_blank: blank ids, others: none).

create or replace function private.qb_check_text_list(p_list jsonb, p_min integer, p_max integer, p_what text)
returns void
language plpgsql
immutable
set search_path = ''
as $$
declare
  v text;
begin
  if jsonb_typeof(p_list) is distinct from 'array' or jsonb_array_length(p_list) not between p_min and p_max then
    raise exception '% must be an array of % to % texts', p_what, p_min, p_max using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_list) e
             where jsonb_typeof(e) <> 'string' or char_length(btrim(e #>> '{}')) not between 1 and 200) then
    raise exception '% items must be texts of 1..200 chars', p_what using errcode = '22023';
  end if;
end;
$$;

-- ---------------------------------------------------------------- short_answer
create or replace function private.qb_validate_short_answer(p_payload jsonb, p_key jsonb)
returns text[]
language plpgsql
immutable
set search_path = ''
as $$
begin
  perform private.qb_check_public_payload(p_payload, array['stem', 'media', 'max_chars']);
  if p_payload ? 'max_chars' and (jsonb_typeof(p_payload -> 'max_chars') <> 'number'
     or (p_payload ->> 'max_chars')::numeric not between 1 and 500 or (p_payload ->> 'max_chars')::numeric <> trunc((p_payload ->> 'max_chars')::numeric)) then
    raise exception 'payload.max_chars must be an integer 1..500' using errcode = '22023';
  end if;
  perform private.qb_check_keys(p_key, array['answers', 'case_sensitive'], 'key');
  perform private.qb_check_text_list(p_key -> 'answers', 1, 20, 'key.answers');
  if p_key ? 'case_sensitive' and jsonb_typeof(p_key -> 'case_sensitive') <> 'boolean' then
    raise exception 'key.case_sensitive must be a boolean' using errcode = '22023';
  end if;
  return array[]::text[];
end;
$$;

-- ---------------------------------------------------------------- numerical
create or replace function private.qb_validate_numerical(p_payload jsonb, p_key jsonb)
returns text[]
language plpgsql
immutable
set search_path = ''
as $$
begin
  perform private.qb_check_public_payload(p_payload, array['stem', 'media', 'unit']);
  if p_payload ? 'unit' and (jsonb_typeof(p_payload -> 'unit') <> 'string' or char_length(btrim(p_payload ->> 'unit')) not between 1 and 30) then
    raise exception 'payload.unit must be a text of 1..30 chars' using errcode = '22023';
  end if;
  perform private.qb_check_keys(p_key, array['value', 'tolerance', 'tolerance_mode'], 'key');
  if jsonb_typeof(p_key -> 'value') is distinct from 'number' or abs((p_key ->> 'value')::numeric) > 1e12 then
    raise exception 'key.value must be a number (|x| <= 1e12)' using errcode = '22023';
  end if;
  if p_key ? 'tolerance' and (jsonb_typeof(p_key -> 'tolerance') <> 'number' or (p_key ->> 'tolerance')::numeric not between 0 and 1e12) then
    raise exception 'key.tolerance must be a number >= 0' using errcode = '22023';
  end if;
  if p_key ? 'tolerance_mode' and coalesce(p_key ->> 'tolerance_mode', '') not in ('absolute', 'percent') then
    raise exception 'key.tolerance_mode must be absolute | percent' using errcode = '22023';
  end if;
  if coalesce(p_key ->> 'tolerance_mode', 'absolute') = 'percent' and coalesce((p_key ->> 'tolerance')::numeric, 0) > 100 then
    raise exception 'a percent tolerance cannot exceed 100' using errcode = '22023';
  end if;
  return array[]::text[];
end;
$$;

-- ---------------------------------------------------------------- essay (manual grading)
create or replace function private.qb_validate_essay(p_payload jsonb, p_key jsonb)
returns text[]
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_min numeric := coalesce((p_payload ->> 'min_words')::numeric, 0);
  v_max numeric := coalesce((p_payload ->> 'max_words')::numeric, 5000);
begin
  perform private.qb_check_public_payload(p_payload, array['stem', 'media', 'min_words', 'max_words']);
  if p_payload ? 'min_words' and (jsonb_typeof(p_payload -> 'min_words') <> 'number' or v_min not between 0 and 5000 or v_min <> trunc(v_min)) then
    raise exception 'payload.min_words must be an integer 0..5000' using errcode = '22023';
  end if;
  if p_payload ? 'max_words' and (jsonb_typeof(p_payload -> 'max_words') <> 'number' or v_max not between 1 and 5000 or v_max <> trunc(v_max)) then
    raise exception 'payload.max_words must be an integer 1..5000' using errcode = '22023';
  end if;
  if v_min > v_max then
    raise exception 'payload.min_words cannot exceed max_words' using errcode = '22023';
  end if;
  perform private.qb_check_keys(p_key, array['rubric', 'model_answer'], 'key');
  if p_key ? 'rubric' and (jsonb_typeof(p_key -> 'rubric') <> 'string' or char_length(p_key ->> 'rubric') > 4000) then
    raise exception 'key.rubric must be a text (max 4000 chars)' using errcode = '22023';
  end if;
  if p_key ? 'model_answer' and (jsonb_typeof(p_key -> 'model_answer') <> 'string' or char_length(p_key ->> 'model_answer') > 8000) then
    raise exception 'key.model_answer must be a text (max 8000 chars)' using errcode = '22023';
  end if;
  return array[]::text[];
end;
$$;

-- ---------------------------------------------------------------- ordering
create or replace function private.qb_validate_ordering(p_payload jsonb, p_key jsonb)
returns text[]
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_ids text[];
  v_ord text[];
begin
  perform private.qb_check_public_payload(p_payload, array['stem', 'items', 'media']);
  v_ids := private.qb_check_id_text_list(p_payload, 'items', 2, 10);
  perform private.qb_check_keys(p_key, array['order', 'scoring'], 'key');
  if jsonb_typeof(p_key -> 'order') is distinct from 'array' then
    raise exception 'key.order must be an array of item ids' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_key -> 'order') e where jsonb_typeof(e) <> 'string') then
    raise exception 'key.order must contain item ids (strings)' using errcode = '22023';
  end if;
  select array_agg(x) into v_ord from jsonb_array_elements_text(p_key -> 'order') x;
  if v_ord is null or cardinality(v_ord) <> cardinality(v_ids)
     or (select count(distinct x) from unnest(v_ord) x) <> cardinality(v_ids)
     or exists (select 1 from unnest(v_ord) x where not (x = any (v_ids))) then
    raise exception 'key.order must list every item exactly once' using errcode = '22023';
  end if;
  if p_key ? 'scoring' and coalesce(p_key ->> 'scoring', '') not in ('all_or_nothing', 'partial') then
    raise exception 'key.scoring must be all_or_nothing | partial' using errcode = '22023';
  end if;
  return v_ids;
end;
$$;

-- ---------------------------------------------------------------- fill_blank
create or replace function private.qb_validate_fill_blank(p_payload jsonb, p_key jsonb)
returns text[]
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_ids   text[] := array[]::text[];
  v_b     jsonb;
  v_stem  text;
  v_id    text;
  v_marks text[];
begin
  perform private.qb_check_public_payload(p_payload, array['stem', 'blanks', 'media']);
  if jsonb_typeof(p_payload -> 'blanks') is distinct from 'array' or jsonb_array_length(p_payload -> 'blanks') not between 1 and 10 then
    raise exception 'payload.blanks must be an array of 1 to 10 blanks' using errcode = '22023';
  end if;
  for v_b in select e from jsonb_array_elements(p_payload -> 'blanks') e loop
    perform private.qb_check_keys(v_b, array['id'], 'blank');
    if jsonb_typeof(v_b -> 'id') is distinct from 'string' or (v_b ->> 'id') !~ '^[a-z0-9_-]{1,16}$' then
      raise exception 'blank.id must match ^[a-z0-9_-]{1,16}$' using errcode = '22023';
    end if;
    if (v_b ->> 'id') = any (v_ids) then
      raise exception 'duplicate blank id: %', v_b ->> 'id' using errcode = '22023';
    end if;
    v_ids := v_ids || (v_b ->> 'id');
  end loop;
  -- the stem must hold every {{id}} marker exactly once and no other marker
  v_stem := p_payload -> 'stem' ->> 'text';
  select array_agg(m[1]) into v_marks from regexp_matches(v_stem, '\{\{([^{}]*)\}\}', 'g') m;
  if v_marks is null or cardinality(v_marks) <> cardinality(v_ids)
     or (select count(distinct x) from unnest(v_marks) x) <> cardinality(v_marks) then
    raise exception 'payload.stem must contain each {{id}} marker exactly once' using errcode = '22023';
  end if;
  foreach v_id in array v_marks loop
    if not (v_id = any (v_ids)) then
      raise exception 'payload.stem has an unknown marker {{%}}', v_id using errcode = '22023';
    end if;
  end loop;

  perform private.qb_check_keys(p_key, array['blanks', 'case_sensitive', 'scoring'], 'key');
  if jsonb_typeof(p_key -> 'blanks') is distinct from 'object'
     or (select count(*) from jsonb_object_keys(p_key -> 'blanks')) <> cardinality(v_ids) then
    raise exception 'key.blanks must map every blank id to its accepted answers' using errcode = '22023';
  end if;
  for v_id in select k from jsonb_object_keys(p_key -> 'blanks') k loop
    if not (v_id = any (v_ids)) then
      raise exception 'key.blanks references an unknown blank id' using errcode = '22023';
    end if;
    perform private.qb_check_text_list(p_key -> 'blanks' -> v_id, 1, 10, 'key.blanks.' || v_id);
  end loop;
  if p_key ? 'case_sensitive' and jsonb_typeof(p_key -> 'case_sensitive') <> 'boolean' then
    raise exception 'key.case_sensitive must be a boolean' using errcode = '22023';
  end if;
  if p_key ? 'scoring' and coalesce(p_key ->> 'scoring', '') not in ('all_or_nothing', 'partial') then
    raise exception 'key.scoring must be all_or_nothing | partial' using errcode = '22023';
  end if;
  return v_ids;
end;
$$;

-- ---------------------------------------------------------------- registry
update public.qb_question_types set enabled = true, grading = 'auto',
  validator = 'private.qb_validate_short_answer(jsonb,jsonb)',
  public_schema = '{"stem":{"text":"string"},"max_chars":"int?","media":["uuid"]}',
  key_schema = '{"answers":["text"],"case_sensitive":"bool?"}', response_schema = '{"text":"string"}'
 where code = 'short_answer';
update public.qb_question_types set enabled = true, grading = 'auto',
  validator = 'private.qb_validate_numerical(jsonb,jsonb)',
  public_schema = '{"stem":{"text":"string"},"unit":"string?","media":["uuid"]}',
  key_schema = '{"value":"number","tolerance":"number?","tolerance_mode":"absolute|percent"}', response_schema = '{"value":"string|number"}'
 where code = 'numerical';
update public.qb_question_types set enabled = true, grading = 'manual',
  validator = 'private.qb_validate_essay(jsonb,jsonb)',
  public_schema = '{"stem":{"text":"string"},"min_words":"int?","max_words":"int?","media":["uuid"]}',
  key_schema = '{"rubric":"string?","model_answer":"string?"}', response_schema = '{"text":"string"}'
 where code = 'essay';
update public.qb_question_types set enabled = true, grading = 'auto',
  validator = 'private.qb_validate_ordering(jsonb,jsonb)',
  public_schema = '{"stem":{"text":"string"},"items":[{"id":"string","text":"string"}],"media":["uuid"]}',
  key_schema = '{"order":["itemId"],"scoring":"all_or_nothing|partial"}', response_schema = '{"order":["itemId"]}'
 where code = 'ordering';
insert into public.qb_question_types (code, name_ar, name_en, grading, sort, enabled, validator, public_schema, key_schema, response_schema)
values ('fill_blank', 'ملء الفراغات (كتابة)', 'Fill in the blanks', 'auto', 14, true, 'private.qb_validate_fill_blank(jsonb,jsonb)',
  '{"stem":{"text":"string with {{id}} markers"},"blanks":[{"id":"string"}],"media":["uuid"]}',
  '{"blanks":{"blankId":["text"]},"case_sensitive":"bool?","scoring":"all_or_nothing|partial"}', '{"answers":{"blankId":"string"}}')
on conflict (code) do nothing;

revoke execute on function private.qb_check_text_list(jsonb, integer, integer, text) from public, anon, authenticated;
revoke execute on function private.qb_validate_short_answer(jsonb, jsonb)            from public, anon, authenticated;
revoke execute on function private.qb_validate_numerical(jsonb, jsonb)               from public, anon, authenticated;
revoke execute on function private.qb_validate_essay(jsonb, jsonb)                   from public, anon, authenticated;
revoke execute on function private.qb_validate_ordering(jsonb, jsonb)                from public, anon, authenticated;
revoke execute on function private.qb_validate_fill_blank(jsonb, jsonb)              from public, anon, authenticated;

-- ROLLBACK: docs/lms/rollback-017-019.sql
