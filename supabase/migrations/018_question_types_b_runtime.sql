-- 018_question_types_b_runtime  (LMS phase 2b, part 2/3: attempts runtime for the new types)
-- Replaces 4 internal helpers of 014 (same signatures, same behavior for the 6 existing types) and adds the new branches:
--   ex_build_option_map  ordering: items get opaque ids and are ALWAYS shuffled; fill_blank: blank ids (not secret)
--   ex_check_response    validates + normalizes each response (essay allows a larger body); returns {opaque, real}
--   ex_grade             short_answer (Arabic-aware text match), numerical (tolerance), ordering, fill_blank; essay = manual (019)
--   ex_public_item       what the trainee sees for each new type (never a key)
-- Requires 014 + 017. Apply 018 and 019 together (essay answers are graded by staff in 019).

create or replace function private.ex_parse_number(p text)
returns numeric
language plpgsql
immutable
set search_path = ''
as $$
declare
  t text;
begin
  t := replace(btrim(translate(coalesce(p, ''), '٠١٢٣٤٥٦٧٨٩٫٬،', '0123456789.,,')), ' ', '');
  if position('.' in t) > 0 then t := replace(t, ',', ''); else t := replace(t, ',', '.'); end if;
  if t !~ '^[+-]?[0-9]{1,15}(\.[0-9]{1,10})?$' then
    raise exception 'not a number' using errcode = '22023';
  end if;
  return t::numeric;
end;
$$;

-- ---------------------------------------------------------------- option map
create or replace function private.ex_build_option_map(p_type text, p_payload jsonb, p_shuffle boolean)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_list  jsonb;
  v_left  jsonb;
  v_right jsonb;
begin
  if p_type in ('mcq_single', 'multi_response', 'graphic') then
    select jsonb_build_object('opts', jsonb_object_agg(x.opq, x.rid), 'order', jsonb_agg(x.opq order by case when p_shuffle then random() else x.ord::float8 end))
      into v_list
      from (select e ->> 'id' as rid, private.ex_opaque() as opq, o as ord
            from jsonb_array_elements(p_payload -> 'options') with ordinality as t(e, o)) x;
    return v_list;
  elsif p_type = 'true_false' then
    select jsonb_build_object('opts', jsonb_object_agg(x.opq, x.rid), 'order', jsonb_agg(x.opq order by case when p_shuffle then random() else x.ord::float8 end))
      into v_list
      from (select rid, private.ex_opaque() as opq, ord from (values ('true', 1), ('false', 2)) v(rid, ord)) x;
    return v_list;
  elsif p_type = 'matching' then
    select jsonb_build_object('left', jsonb_object_agg(x.opq, x.rid), 'left_order', jsonb_agg(x.opq order by case when p_shuffle then random() else x.ord::float8 end))
      into v_left
      from (select e ->> 'id' as rid, private.ex_opaque() as opq, o as ord
            from jsonb_array_elements(p_payload -> 'left') with ordinality as t(e, o)) x;
    select jsonb_build_object('right', jsonb_object_agg(x.opq, x.rid), 'right_order', jsonb_agg(x.opq order by case when p_shuffle then random() else x.ord::float8 end))
      into v_right
      from (select e ->> 'id' as rid, private.ex_opaque() as opq, o as ord
            from jsonb_array_elements(p_payload -> 'right') with ordinality as t(e, o)) x;
    return v_left || v_right;
  elsif p_type = 'ordering' then
    -- always shuffled: the authored order IS the answer
    select jsonb_build_object('items', jsonb_object_agg(x.opq, x.rid), 'order', jsonb_agg(x.opq order by random()))
      into v_list
      from (select e ->> 'id' as rid, private.ex_opaque() as opq
            from jsonb_array_elements(p_payload -> 'items') as t(e)) x;
    return v_list;
  elsif p_type = 'fill_blank' then
    return jsonb_build_object('blanks', (select jsonb_agg(e ->> 'id') from jsonb_array_elements(p_payload -> 'blanks') e));
  elsif p_type in ('short_answer', 'numerical', 'essay') then
    return '{}'::jsonb;
  end if;
  raise exception 'question type "%" is not supported in attempts yet', p_type using errcode = '22023';
end;
$$;

-- ---------------------------------------------------------------- response check
create or replace function private.ex_check_response(p_type text, p_map jsonb, p_resp jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_ids   text[];
  v_real  jsonb;
  v_pairs jsonb;
  k       text;
  v       text;
  seen    text[] := array[]::text[];
  t       text;
  v_ans   jsonb;
begin
  if p_resp is null or jsonb_typeof(p_resp) = 'null' or p_resp = '{}'::jsonb then
    return jsonb_build_object('opaque', null, 'real', null);
  end if;
  if jsonb_typeof(p_resp) <> 'object' or octet_length(p_resp::text) > (case when p_type = 'essay' then 65536 else 4096 end) then
    raise exception 'response must be a small JSON object' using errcode = '22023';
  end if;
  if p_type in ('mcq_single', 'graphic', 'true_false') then
    perform private.qb_check_keys(p_resp, array['choice'], 'response');
    if p_resp -> 'choice' is null or jsonb_typeof(p_resp -> 'choice') = 'null' then
      return jsonb_build_object('opaque', null, 'real', null);
    end if;
    if jsonb_typeof(p_resp -> 'choice') <> 'string' or not (p_map -> 'opts' ? (p_resp ->> 'choice')) then
      raise exception 'unknown option' using errcode = '22023';
    end if;
    return jsonb_build_object('opaque', jsonb_build_object('choice', p_resp -> 'choice'),
                              'real', jsonb_build_object('choice', p_map -> 'opts' -> (p_resp ->> 'choice')));
  elsif p_type = 'multi_response' then
    perform private.qb_check_keys(p_resp, array['choices'], 'response');
    if jsonb_typeof(p_resp -> 'choices') is distinct from 'array' or jsonb_array_length(p_resp -> 'choices') > 20 then
      raise exception 'choices must be an array' using errcode = '22023';
    end if;
    select array_agg(x) into v_ids from jsonb_array_elements_text(p_resp -> 'choices') x;
    if v_ids is null then
      return jsonb_build_object('opaque', null, 'real', null);
    end if;
    if cardinality(v_ids) <> (select count(distinct x) from unnest(v_ids) x) then
      raise exception 'duplicate choices' using errcode = '22023';
    end if;
    select jsonb_agg(p_map -> 'opts' -> x) into v_real from unnest(v_ids) x;
    if exists (select 1 from unnest(v_ids) x where not (p_map -> 'opts' ? x)) then
      raise exception 'unknown option' using errcode = '22023';
    end if;
    return jsonb_build_object('opaque', jsonb_build_object('choices', to_jsonb(v_ids)), 'real', jsonb_build_object('choices', v_real));
  elsif p_type = 'matching' then
    perform private.qb_check_keys(p_resp, array['pairs'], 'response');
    if jsonb_typeof(p_resp -> 'pairs') is distinct from 'object' then
      raise exception 'pairs must be an object' using errcode = '22023';
    end if;
    v_pairs := '{}'::jsonb;
    for k, v in select e.key, e.value from jsonb_each_text(p_resp -> 'pairs') e loop
      if not (p_map -> 'left' ? k) or not (p_map -> 'right' ? v) then
        raise exception 'unknown item' using errcode = '22023';
      end if;
      if v = any (seen) then
        raise exception 'an option can be matched once' using errcode = '22023';
      end if;
      seen := seen || v;
      v_pairs := v_pairs || jsonb_build_object(p_map -> 'left' ->> k, p_map -> 'right' ->> v);
    end loop;
    if v_pairs = '{}'::jsonb then
      return jsonb_build_object('opaque', null, 'real', null);
    end if;
    return jsonb_build_object('opaque', jsonb_build_object('pairs', p_resp -> 'pairs'), 'real', jsonb_build_object('pairs', v_pairs));
  elsif p_type in ('short_answer', 'essay') then
    perform private.qb_check_keys(p_resp, array['text'], 'response');
    if p_resp -> 'text' is null or jsonb_typeof(p_resp -> 'text') = 'null' then
      return jsonb_build_object('opaque', null, 'real', null);
    end if;
    if jsonb_typeof(p_resp -> 'text') <> 'string' then
      raise exception 'text must be a string' using errcode = '22023';
    end if;
    t := btrim(p_resp ->> 'text');
    if t = '' then
      return jsonb_build_object('opaque', null, 'real', null);
    end if;
    if char_length(t) > (case when p_type = 'essay' then 20000 else 500 end) then
      raise exception 'answer too long' using errcode = '22023';
    end if;
    return jsonb_build_object('opaque', jsonb_build_object('text', t), 'real', jsonb_build_object('text', t));
  elsif p_type = 'numerical' then
    perform private.qb_check_keys(p_resp, array['value'], 'response');
    if p_resp -> 'value' is null or jsonb_typeof(p_resp -> 'value') = 'null' then
      return jsonb_build_object('opaque', null, 'real', null);
    end if;
    if jsonb_typeof(p_resp -> 'value') not in ('string', 'number') then
      raise exception 'value must be a number' using errcode = '22023';
    end if;
    t := btrim(p_resp ->> 'value');
    if t = '' then
      return jsonb_build_object('opaque', null, 'real', null);
    end if;
    return jsonb_build_object('opaque', jsonb_build_object('value', t), 'real', jsonb_build_object('value', private.ex_parse_number(t)));
  elsif p_type = 'ordering' then
    perform private.qb_check_keys(p_resp, array['order'], 'response');
    if jsonb_typeof(p_resp -> 'order') is distinct from 'array' then
      raise exception 'order must be an array' using errcode = '22023';
    end if;
    if jsonb_array_length(p_resp -> 'order') = 0 then
      return jsonb_build_object('opaque', null, 'real', null);
    end if;
    if exists (select 1 from jsonb_array_elements(p_resp -> 'order') e where jsonb_typeof(e) <> 'string') then
      raise exception 'order must contain item ids' using errcode = '22023';
    end if;
    select array_agg(x) into v_ids from jsonb_array_elements_text(p_resp -> 'order') x;
    if cardinality(v_ids) <> (select count(*) from jsonb_object_keys(p_map -> 'items'))
       or cardinality(v_ids) <> (select count(distinct x) from unnest(v_ids) x)
       or exists (select 1 from unnest(v_ids) x where not (p_map -> 'items' ? x)) then
      raise exception 'order must list every item exactly once' using errcode = '22023';
    end if;
    select jsonb_agg(p_map -> 'items' ->> x) into v_real from unnest(v_ids) x;
    return jsonb_build_object('opaque', jsonb_build_object('order', to_jsonb(v_ids)), 'real', jsonb_build_object('order', v_real));
  elsif p_type = 'fill_blank' then
    perform private.qb_check_keys(p_resp, array['answers'], 'response');
    if jsonb_typeof(p_resp -> 'answers') is distinct from 'object' then
      raise exception 'answers must be an object' using errcode = '22023';
    end if;
    v_ans := '{}'::jsonb;
    for k, v in select e.key, e.value from jsonb_each_text(p_resp -> 'answers') e loop
      if not (p_map -> 'blanks' ? k) then
        raise exception 'unknown blank' using errcode = '22023';
      end if;
      if jsonb_typeof(p_resp -> 'answers' -> k) <> 'string' or char_length(v) > 200 then
        raise exception 'blank answers must be texts up to 200 chars' using errcode = '22023';
      end if;
      if btrim(v) <> '' then
        v_ans := v_ans || jsonb_build_object(k, btrim(v));
      end if;
    end loop;
    if v_ans = '{}'::jsonb then
      return jsonb_build_object('opaque', null, 'real', null);
    end if;
    return jsonb_build_object('opaque', jsonb_build_object('answers', v_ans), 'real', jsonb_build_object('answers', v_ans));
  end if;
  raise exception 'unsupported type' using errcode = '22023';
end;
$$;

-- ---------------------------------------------------------------- auto grader
create or replace function private.ex_grade(p_type text, p_resp jsonb, p_key jsonb, p_points numeric)
returns numeric
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_correct text[];
  v_chosen  text[];
  v_right   integer;
  v_wrong   integer;
  v_total   integer;
  v_scoring text;
  r         numeric;
  v_cs      boolean;
  v_tol     numeric;
  v_val     numeric;
  v_in      numeric;
  v_ord     text[];
  v_got     text[];
  b         text;
begin
  if p_resp is null or p_resp = '{}'::jsonb then
    return 0;
  end if;
  v_scoring := coalesce(p_key ->> 'scoring', 'all_or_nothing');
  v_cs := coalesce((p_key ->> 'case_sensitive')::boolean, false);
  if p_type in ('mcq_single', 'graphic', 'true_false') then
    return case when (p_resp ->> 'choice') is not null and (p_resp ->> 'choice') = (p_key ->> 'correct') then p_points else 0 end;
  elsif p_type = 'short_answer' then
    return case when exists (
        select 1 from jsonb_array_elements_text(p_key -> 'answers') a
         where case when v_cs then btrim(regexp_replace(a, '\s+', ' ', 'g')) = btrim(regexp_replace(p_resp ->> 'text', '\s+', ' ', 'g'))
                    else private.qb_normalize_text(a) = private.qb_normalize_text(p_resp ->> 'text') end)
      then p_points else 0 end;
  elsif p_type = 'numerical' then
    v_val := (p_key ->> 'value')::numeric;
    v_in := (p_resp ->> 'value')::numeric;
    v_tol := coalesce((p_key ->> 'tolerance')::numeric, 0);
    if coalesce(p_key ->> 'tolerance_mode', 'absolute') = 'percent' then v_tol := abs(v_val) * v_tol / 100; end if;
    return case when abs(v_in - v_val) <= v_tol then p_points else 0 end;
  elsif p_type = 'ordering' then
    select array_agg(x order by o) into v_ord from jsonb_array_elements_text(p_key -> 'order') with ordinality as t(x, o);
    select array_agg(x order by o) into v_got from jsonb_array_elements_text(coalesce(p_resp -> 'order', '[]'::jsonb)) with ordinality as t(x, o);
    v_total := coalesce(cardinality(v_ord), 0);
    if v_total = 0 then return 0; end if;
    v_right := (select count(*) from generate_subscripts(v_ord, 1) i where v_got[i] is not distinct from v_ord[i]);
    r := case when v_scoring = 'partial' then v_right::numeric / v_total else case when v_right = v_total then 1 else 0 end end;
    return round(p_points * r, 2);
  elsif p_type = 'fill_blank' then
    v_total := (select count(*) from jsonb_object_keys(p_key -> 'blanks'));
    if v_total = 0 then return 0; end if;
    v_right := 0;
    for b in select k from jsonb_object_keys(p_key -> 'blanks') k loop
      if (p_resp -> 'answers' ->> b) is not null and exists (
           select 1 from jsonb_array_elements_text(p_key -> 'blanks' -> b) a
            where case when v_cs then btrim(regexp_replace(a, '\s+', ' ', 'g')) = btrim(regexp_replace(p_resp -> 'answers' ->> b, '\s+', ' ', 'g'))
                       else private.qb_normalize_text(a) = private.qb_normalize_text(p_resp -> 'answers' ->> b) end) then
        v_right := v_right + 1;
      end if;
    end loop;
    r := case when v_scoring = 'partial' then v_right::numeric / v_total else case when v_right = v_total then 1 else 0 end end;
    return round(p_points * r, 2);
  elsif p_type = 'multi_response' then
    select array_agg(x) into v_correct from jsonb_array_elements_text(p_key -> 'correct') x;
    select coalesce(array_agg(x), array[]::text[]) into v_chosen from jsonb_array_elements_text(coalesce(p_resp -> 'choices', '[]'::jsonb)) x;
    v_total := coalesce(cardinality(v_correct), 0);
    if v_total = 0 then return 0; end if;
    v_right := (select count(*) from unnest(v_chosen) c where c = any (v_correct));
    v_wrong := cardinality(v_chosen) - v_right;
  elsif p_type = 'matching' then
    v_total := (select count(*) from jsonb_object_keys(p_key -> 'pairs'));
    if v_total = 0 then return 0; end if;
    v_right := (select count(*) from jsonb_each_text(coalesce(p_resp -> 'pairs', '{}'::jsonb)) e where (p_key -> 'pairs' ->> e.key) = e.value);
    v_wrong := (select count(*) from jsonb_each_text(coalesce(p_resp -> 'pairs', '{}'::jsonb))) - v_right;
  else
    return 0;   -- essay and anything manual: scored by staff (019)
  end if;
  r := case v_scoring
         when 'partial' then case when p_type = 'matching' or v_wrong = 0 then v_right::numeric / v_total else 0 end
         when 'partial_penalty' then greatest(0, (v_right - v_wrong)::numeric / v_total)
         else case when v_right = v_total and v_wrong = 0 then 1 else 0 end
       end;
  return round(p_points * r, 2);
end;
$$;

-- ---------------------------------------------------------------- what the trainee sees
create or replace function private.ex_public_item(p_item public.ex_attempt_items)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v        public.qb_question_versions;
  p        jsonb;
  m        jsonb;
  v_media  jsonb;
  v_out    jsonb;
begin
  select * into v from public.qb_question_versions x where x.id = p_item.question_version_id;
  p := v.payload;
  m := p_item.option_map;
  select coalesce(jsonb_agg(jsonb_build_object('path', mm.storage_path, 'alt', coalesce(mm.alt_ar, ''))), '[]'::jsonb) into v_media
    from public.qb_media mm
   where mm.course_id = v.course_id and jsonb_typeof(p -> 'media') = 'array' and (p -> 'media') ? mm.id::text;
  v_out := jsonb_build_object('position', p_item.position, 'type_code', p_item.type_code, 'points', p_item.points,
                              'stem', p -> 'stem' ->> 'text', 'media', v_media,
                              'response', p_item.response, 'flagged', p_item.flagged);
  if p_item.type_code in ('mcq_single', 'multi_response', 'graphic') then
    v_out := v_out || jsonb_build_object('options', (
      select jsonb_agg(jsonb_build_object('id', o.opq, 'text', (select e ->> 'text' from jsonb_array_elements(p -> 'options') e where e ->> 'id' = m -> 'opts' ->> o.opq)) order by o.ord)
      from jsonb_array_elements_text(m -> 'order') with ordinality as o(opq, ord)));
    if p_item.type_code = 'multi_response' then
      v_out := v_out || jsonb_strip_nulls(jsonb_build_object('min_select', p -> 'min_select', 'max_select', p -> 'max_select'));
    end if;
  elsif p_item.type_code = 'true_false' then
    v_out := v_out || jsonb_build_object('options', (
      select jsonb_agg(jsonb_build_object('id', o.opq, 'text',
               coalesce(nullif(p -> 'labels' ->> (m -> 'opts' ->> o.opq), ''), case m -> 'opts' ->> o.opq when 'true' then 'صح' else 'خطأ' end)) order by o.ord)
      from jsonb_array_elements_text(m -> 'order') with ordinality as o(opq, ord)));
  elsif p_item.type_code = 'matching' then
    v_out := v_out || jsonb_build_object(
      'left', (select jsonb_agg(jsonb_build_object('id', o.opq, 'text', (select e ->> 'text' from jsonb_array_elements(p -> 'left') e where e ->> 'id' = m -> 'left' ->> o.opq)) order by o.ord)
               from jsonb_array_elements_text(m -> 'left_order') with ordinality as o(opq, ord)),
      'right', (select jsonb_agg(jsonb_build_object('id', o.opq, 'text', (select e ->> 'text' from jsonb_array_elements(p -> 'right') e where e ->> 'id' = m -> 'right' ->> o.opq)) order by o.ord)
                from jsonb_array_elements_text(m -> 'right_order') with ordinality as o(opq, ord)));
  elsif p_item.type_code = 'ordering' then
    v_out := v_out || jsonb_build_object('items', (
      select jsonb_agg(jsonb_build_object('id', o.opq, 'text', (select e ->> 'text' from jsonb_array_elements(p -> 'items') e where e ->> 'id' = m -> 'items' ->> o.opq)) order by o.ord)
      from jsonb_array_elements_text(m -> 'order') with ordinality as o(opq, ord)));
  elsif p_item.type_code = 'fill_blank' then
    v_out := v_out || jsonb_build_object('blanks', p -> 'blanks');
  elsif p_item.type_code = 'short_answer' then
    v_out := v_out || jsonb_strip_nulls(jsonb_build_object('max_chars', p -> 'max_chars'));
  elsif p_item.type_code = 'numerical' then
    v_out := v_out || jsonb_strip_nulls(jsonb_build_object('unit', p -> 'unit'));
  elsif p_item.type_code = 'essay' then
    v_out := v_out || jsonb_strip_nulls(jsonb_build_object('min_words', p -> 'min_words', 'max_words', p -> 'max_words'));
  end if;
  return v_out;
end;
$$;

revoke execute on function private.ex_parse_number(text) from public, anon, authenticated;
