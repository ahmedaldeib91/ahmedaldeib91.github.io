-- 012_question_types_a  (Exams system, question types phase A: graphic + matching + the exam-media bucket)
-- Requires 009 + 010 (+ 011 not required). ADDITIVE: no object of 001..011 is altered except two rows of the
-- type registry (graphic, matching: enabled + validator + schemas) which were seeded disabled by 010.
--
--   1. private bucket "exam-media" (images only) + storage.objects policies for course staff
--      (object path = "<course_id>/<file>"; read = qbank.read, write/delete = qbank.write; admin included
--      through has_staff_perm). No update policy (objects are immutable), no anon access.
--   2. private.qb_check_id_text_list: generic [{id,text}] list checker (ids ^[a-z0-9_-]{1,16}$ unique)
--   3. private.qb_validate_graphic   payload {stem, media[1..10 required], options[2..10]}; key {correct}
--   4. private.qb_validate_matching  payload {stem, left[2..10], right[2..12], media?};
--                                    key {pairs: {leftId: rightId} one-to-one, scoring?}
--   5. registry: enable both types with their validators and documented schemas.
-- Grading / rendering for the trainee comes with M4; this file only validates and stores.

-- ================================================================ 1. exam-media bucket + policies
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('exam-media', 'exam-media', false, 10485760,
        array['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create policy p3_exam_media_select on storage.objects
  for select to authenticated
  using (bucket_id = 'exam-media' and private.has_staff_perm((storage.foldername(name))[1], 'qbank.read'));

create policy p3_exam_media_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'exam-media' and private.has_staff_perm((storage.foldername(name))[1], 'qbank.write'));

create policy p3_exam_media_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'exam-media' and private.has_staff_perm((storage.foldername(name))[1], 'qbank.write'));

-- ================================================================ 2. generic id/text list
-- p_payload -> p_field must be an array of p_min..p_max objects {id, text}; returns the ids in order.
create or replace function private.qb_check_id_text_list(p_payload jsonb, p_field text, p_min integer, p_max integer)
returns text[]
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_list jsonb := p_payload -> p_field;
  v_o    jsonb;
  v_ids  text[] := array[]::text[];
begin
  if jsonb_typeof(v_list) is distinct from 'array' or jsonb_array_length(v_list) not between p_min and p_max then
    raise exception 'payload.% must be an array of % to % items', p_field, p_min, p_max using errcode = '22023';
  end if;
  for v_o in select e from jsonb_array_elements(v_list) e loop
    perform private.qb_check_keys(v_o, array['id', 'text'], p_field || ' item');
    if jsonb_typeof(v_o -> 'id') is distinct from 'string' or (v_o ->> 'id') !~ '^[a-z0-9_-]{1,16}$' then
      raise exception '% item id must match ^[a-z0-9_-]{1,16}$', p_field using errcode = '22023';
    end if;
    if jsonb_typeof(v_o -> 'text') is distinct from 'string'
       or char_length(btrim(v_o ->> 'text')) not between 1 and 2000 then
      raise exception '% item text is required (1..2000 chars)', p_field using errcode = '22023';
    end if;
    if (v_o ->> 'id') = any (v_ids) then
      raise exception 'duplicate % id: %', p_field, v_o ->> 'id' using errcode = '22023';
    end if;
    v_ids := v_ids || (v_o ->> 'id');
  end loop;
  return v_ids;
end;
$$;

-- ================================================================ 3. graphic (image-based multiple choice)
-- payload {stem, media: [uuid x1..10] REQUIRED, options[2..10]}; key {correct: optionId}
create or replace function private.qb_validate_graphic(p_payload jsonb, p_key jsonb)
returns text[]
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_ids text[];
begin
  perform private.qb_check_public_payload(p_payload, array['stem', 'options', 'media']);
  if jsonb_typeof(p_payload -> 'media') is distinct from 'array' or jsonb_array_length(p_payload -> 'media') < 1 then
    raise exception 'a graphic question needs at least one image (payload.media)' using errcode = '22023';
  end if;
  v_ids := private.qb_check_options(p_payload, 2, 10);
  perform private.qb_check_keys(p_key, array['correct'], 'key');
  if jsonb_typeof(p_key -> 'correct') is distinct from 'string' or not ((p_key ->> 'correct') = any (v_ids)) then
    raise exception 'key.correct must be exactly one existing option id' using errcode = '22023';
  end if;
  return v_ids;
end;
$$;

-- ================================================================ 4. matching
-- payload {stem, left[2..10], right[2..12] (extra right items are distractors), media?}
-- key {pairs: {leftId: rightId} (every left item, one-to-one), scoring?: all_or_nothing|partial|partial_penalty}
-- Returns the LEFT ids (option_explanations is keyed by the item being matched).
create or replace function private.qb_validate_matching(p_payload jsonb, p_key jsonb)
returns text[]
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_left  text[];
  v_right text[];
  v_pairs jsonb;
  v_vals  text[];
  v_k     text;
begin
  perform private.qb_check_public_payload(p_payload, array['stem', 'left', 'right', 'media']);
  v_left  := private.qb_check_id_text_list(p_payload, 'left', 2, 10);
  v_right := private.qb_check_id_text_list(p_payload, 'right', 2, 12);
  if cardinality(v_right) < cardinality(v_left) then
    raise exception 'payload.right must have at least as many items as payload.left' using errcode = '22023';
  end if;

  perform private.qb_check_keys(p_key, array['pairs', 'scoring'], 'key');
  v_pairs := p_key -> 'pairs';
  if jsonb_typeof(v_pairs) is distinct from 'object' then
    raise exception 'key.pairs must be an object {leftId: rightId}' using errcode = '22023';
  end if;
  if (select count(*) from jsonb_object_keys(v_pairs)) <> cardinality(v_left) then
    raise exception 'key.pairs must map every left item exactly once' using errcode = '22023';
  end if;
  for v_k in select k from jsonb_object_keys(v_pairs) k loop
    if not (v_k = any (v_left)) then
      raise exception 'key.pairs references an unknown left id' using errcode = '22023';
    end if;
    if jsonb_typeof(v_pairs -> v_k) is distinct from 'string' or not ((v_pairs ->> v_k) = any (v_right)) then
      raise exception 'key.pairs references an unknown right id' using errcode = '22023';
    end if;
    v_vals := coalesce(v_vals, array[]::text[]) || (v_pairs ->> v_k);
  end loop;
  if cardinality(v_vals) <> (select count(distinct x) from unnest(v_vals) x) then
    raise exception 'each right item can be matched at most once' using errcode = '22023';
  end if;
  if p_key ? 'scoring' and coalesce(p_key ->> 'scoring', '') not in ('all_or_nothing', 'partial', 'partial_penalty') then
    raise exception 'key.scoring must be all_or_nothing | partial | partial_penalty' using errcode = '22023';
  end if;
  return v_left;
end;
$$;

-- ================================================================ 5. registry
update public.qb_question_types
   set enabled = true,
       validator = 'private.qb_validate_graphic(jsonb,jsonb)',
       public_schema = '{"stem":{"text":"string"},"media":["uuid (>=1)"],"options":[{"id":"string","text":"string"}]}',
       key_schema = '{"correct":"optionId"}',
       response_schema = '{"choice":"optionId"}'
 where code = 'graphic';

update public.qb_question_types
   set enabled = true,
       validator = 'private.qb_validate_matching(jsonb,jsonb)',
       public_schema = '{"stem":{"text":"string"},"left":[{"id":"string","text":"string"}],"right":[{"id":"string","text":"string"}],"media":["uuid"]}',
       key_schema = '{"pairs":{"leftId":"rightId"},"scoring":"all_or_nothing|partial|partial_penalty"}',
       response_schema = '{"pairs":{"leftId":"rightId"}}'
 where code = 'matching';

-- ================================================================ privileges
revoke execute on function private.qb_check_id_text_list(jsonb, text, integer, integer) from public, anon, authenticated;
revoke execute on function private.qb_validate_graphic(jsonb, jsonb)                    from public, anon, authenticated;
revoke execute on function private.qb_validate_matching(jsonb, jsonb)                   from public, anon, authenticated;

-- ================================================================ ROLLBACK (commented out; see docs/exams/rollback-012.sql)
-- update public.qb_question_types set enabled = false, validator = null, public_schema = '{}', key_schema = '{}',
--   response_schema = '{}' where code in ('graphic', 'matching');   -- only if no graphic/matching question exists
-- drop function if exists private.qb_validate_graphic(jsonb, jsonb), private.qb_validate_matching(jsonb, jsonb),
--   private.qb_check_id_text_list(jsonb, text, integer, integer);
-- drop policy if exists p3_exam_media_select on storage.objects;
-- drop policy if exists p3_exam_media_insert on storage.objects;
-- drop policy if exists p3_exam_media_delete on storage.objects;
-- delete from storage.buckets where id = 'exam-media';             -- only when the bucket holds no objects
