-- 014_exam_attempts  (Exams system, milestone M4a: a trainee takes a published exam; server-side grading)
-- Requires 009..013. ADDITIVE: new tables/functions + one FK on ex_security_events + one storage policy; no existing
-- object is altered. The trainee never receives keys, explanations, real option ids or real question ids before the
-- attempt allows it: everything goes through SECURITY DEFINER RPCs (no table privilege for trainees at all).
--
--   ex_attempts       one attempt of a published exam VERSION (deadline, hard deadline, score, status)
--   ex_attempt_items  the attempt's questions: pinned question_version_id, points, per-attempt opaque option ids
--                     (option_map), the trainee's response, flag, final_score. Never exposed to trainees directly.
--   RPCs (public.* wrappers over private.* definers): exam_list_available, exam_start_attempt, exam_get_items,
--        exam_save_answer, exam_submit, exam_attempt_result, exam_log_event, exam_release_results
--   Graders (auto): mcq_single, graphic, true_false, multi_response (all_or_nothing | partial | partial_penalty),
--        matching (same three scoring modes). Other types are not enabled yet.
--   Storage: a trainee may sign/read exam-media objects ONLY of questions inside one of his own attempts.
-- Rules: one open attempt per (user, exam); attempts limited by max_attempts; window = open_at/close_at; time =
--   duration (+ grace, capped by close_at + grace); expiry finalizes on the next call (timeout_policy
--   auto_submit grades what was answered, void cancels the attempt). Result / review visibility follow the exam's
--   result_policy / review_policy / feedback_policy / explanation_policy (never | after_submit | after_close | manual).

-- ================================================================ 1. tables
create table public.ex_attempts (
  id               uuid primary key default gen_random_uuid(),
  exam_id          uuid not null,
  exam_version_id  uuid not null,
  course_id        text not null,
  user_id          uuid not null references public.profiles (id) on delete cascade,
  attempt_no       integer not null check (attempt_no >= 1),
  status           text not null default 'in_progress' check (status in ('in_progress', 'submitted', 'timed_out', 'voided')),
  seed             text not null,
  item_count       integer not null check (item_count between 1 and 500),
  started_at       timestamptz not null default now(),
  deadline_at      timestamptz,
  hard_deadline_at timestamptz,
  submitted_at     timestamptz,
  last_seen_at     timestamptz,
  score            numeric(10,2),
  max_score        numeric(10,2),
  percent          numeric(5,2),
  passed           boolean,
  result_released  boolean not null default false,
  constraint ex_attempts_exam_fkey foreign key (course_id, exam_id)
    references public.ex_exams (course_id, id) on update restrict on delete restrict,
  constraint ex_attempts_version_fkey foreign key (exam_id, exam_version_id)
    references public.ex_exam_versions (exam_id, id) on update restrict on delete restrict,
  constraint ex_attempts_user_exam_no_key unique (user_id, exam_id, attempt_no)
);
create unique index ex_attempts_one_open_idx on public.ex_attempts (user_id, exam_id) where status = 'in_progress';
create index ex_attempts_exam_idx        on public.ex_attempts (exam_id);
create index ex_attempts_course_user_idx on public.ex_attempts (course_id, user_id);
create index ex_attempts_version_idx     on public.ex_attempts (exam_id, exam_version_id);

create table public.ex_attempt_items (
  attempt_id          uuid not null references public.ex_attempts (id) on delete cascade,
  position            integer not null check (position between 1 and 500),
  course_id           text not null,
  question_id         uuid not null,
  question_version_id uuid not null,
  type_code           text not null references public.qb_question_types (code) on update restrict on delete restrict,
  points              numeric(8,2) not null check (points > 0 and points <= 1000),
  option_map          jsonb not null check (jsonb_typeof(option_map) = 'object'),
  response            jsonb,
  flagged             boolean not null default false,
  answered_at         timestamptz,
  final_score         numeric(8,2),
  constraint ex_attempt_items_pkey primary key (attempt_id, position),
  constraint ex_attempt_items_qversion_fkey foreign key (question_id, question_version_id)
    references public.qb_question_versions (question_id, id) on update restrict on delete restrict
);
create index ex_attempt_items_qversion_idx on public.ex_attempt_items (question_id, question_version_id);
create index ex_attempt_items_type_idx     on public.ex_attempt_items (type_code);

-- M1 left ex_security_events.attempt_id without a FK until attempts existed
alter table public.ex_security_events
  add constraint ex_security_events_attempt_fkey foreign key (attempt_id)
    references public.ex_attempts (id) on update restrict on delete set null;

do $$
declare t text;
begin
  foreach t in array array['ex_attempts', 'ex_attempt_items'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('create policy %I on public.%I for select to authenticated using ((select private.is_admin()) or private.ex_can_read(course_id))', t || '_staff_select', t);
  end loop;
end $$;

-- ================================================================ 2. media: a trainee reads only media of his own attempts
create or replace function private.ex_media_allowed(p_path text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.ex_attempts a
    join public.ex_attempt_items i on i.attempt_id = a.id
    join public.qb_question_versions v on v.id = i.question_version_id
    join public.qb_media m on m.course_id = v.course_id and m.storage_path = p_path
    where a.user_id = (select auth.uid()) and a.status <> 'voided'
      and jsonb_typeof(v.payload -> 'media') = 'array' and (v.payload -> 'media') ? m.id::text);
$$;
create policy p4_exam_media_trainee on storage.objects
  for select to authenticated
  using (bucket_id = 'exam-media' and private.ex_media_allowed(name));

-- ================================================================ 3. internal helpers (no API grant)
-- opaque id: unguessable, per attempt and per question
create or replace function private.ex_opaque()
returns text
language sql
volatile
set search_path = ''
as $$ select 'k' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 10); $$;

-- per-attempt option map: real ids -> opaque ids + display order (shuffled when asked)
create or replace function private.ex_build_option_map(p_type text, p_payload jsonb, p_shuffle boolean)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_list jsonb;
  v_left jsonb;
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
  end if;
  raise exception 'question type "%" is not supported in attempts yet', p_type using errcode = '22023';
end;
$$;

-- client response (opaque ids) -> normalized opaque response + the REAL-id response used for grading.
-- Raises 22023 on a malformed response. Returns {"opaque": ..., "real": ...}; both null when unanswered.
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
begin
  if p_resp is null or jsonb_typeof(p_resp) = 'null' or p_resp = '{}'::jsonb then
    return jsonb_build_object('opaque', null, 'real', null);
  end if;
  if jsonb_typeof(p_resp) <> 'object' or octet_length(p_resp::text) > 4096 then
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
  end if;
  raise exception 'unsupported type' using errcode = '22023';
end;
$$;

-- auto grader: REAL-id response vs key. Returns the score for the question (0..points).
-- scoring: all_or_nothing = full only when exact; partial = proportional to the right picks (multi_response: 0 as soon
-- as a wrong pick exists, so choosing everything never pays; matching: right pairs / total); partial_penalty =
-- (right - wrong) / total, floor 0.
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
begin
  if p_resp is null or p_resp = '{}'::jsonb then
    return 0;
  end if;
  v_scoring := coalesce(p_key ->> 'scoring', 'all_or_nothing');
  if p_type in ('mcq_single', 'graphic', 'true_false') then
    return case when (p_resp ->> 'choice') is not null and (p_resp ->> 'choice') = (p_key ->> 'correct') then p_points else 0 end;
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
    return 0;
  end if;
  r := case v_scoring
         when 'partial' then case when p_type = 'matching' or v_wrong = 0 then v_right::numeric / v_total else 0 end
         when 'partial_penalty' then greatest(0, (v_right - v_wrong)::numeric / v_total)
         else case when v_right = v_total and v_wrong = 0 then 1 else 0 end
       end;
  return round(p_points * r, 2);
end;
$$;

-- result / review / feedback visibility for one policy
create or replace function private.ex_policy_open(p_policy text, p_close_at timestamptz, p_released boolean)
returns boolean
language sql
stable
set search_path = ''
as $$
  select case coalesce(p_policy, 'never')
           when 'always'       then true   -- practice exams show it while answering and afterwards
           when 'after_submit' then true
           when 'after_close'  then p_close_at is not null and now() >= p_close_at
           when 'manual'       then coalesce(p_released, false)
           else false
         end;
$$;

-- grades every item and closes the attempt. p_timed_out: closed by the clock (timeout_policy decides).
create or replace function private.ex_finalize(p_attempt_id uuid, p_timed_out boolean)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  a        public.ex_attempts;
  s        jsonb;
  it       record;
  v_key    jsonb;
  v_chk    jsonb;
  v_score  numeric;
  v_sum    numeric := 0;
  v_max    numeric := 0;
  v_pct    numeric;
  v_pass   boolean;
begin
  select * into a from public.ex_attempts x where x.id = p_attempt_id for update;
  if not found or a.status <> 'in_progress' then
    return;
  end if;
  select v.settings into s from public.ex_exam_versions v where v.id = a.exam_version_id;

  if p_timed_out and coalesce(s ->> 'timeout_policy', 'auto_submit') = 'void' then
    update public.ex_attempts x set status = 'voided', submitted_at = now() where x.id = a.id;
    return;
  end if;

  for it in select i.* from public.ex_attempt_items i where i.attempt_id = a.id order by i.position loop
    select k.key into v_key from public.qb_question_keys k where k.version_id = it.question_version_id;
    v_score := 0;
    if it.response is not null then
      begin
        v_chk := private.ex_check_response(it.type_code, it.option_map, it.response);
        v_score := private.ex_grade(it.type_code, v_chk -> 'real', coalesce(v_key, '{}'::jsonb), it.points);
      exception when others then
        v_score := 0; -- a malformed stored response scores 0, never blocks the close
      end;
    end if;
    update public.ex_attempt_items i set final_score = v_score where i.attempt_id = a.id and i.position = it.position;
    v_sum := v_sum + v_score;
    v_max := v_max + it.points;
  end loop;

  v_pct := case when v_max > 0 then round(v_sum / v_max * 100, 2) else 0 end;
  v_pass := case
              when s ->> 'pass_percent' is not null then v_pct >= (s ->> 'pass_percent')::numeric
              when s ->> 'pass_score' is not null then v_sum >= (s ->> 'pass_score')::numeric
              else null end;
  update public.ex_attempts x
     set status = case when p_timed_out then 'timed_out' else 'submitted' end, submitted_at = now(),
         score = v_sum, max_score = v_max, percent = v_pct, passed = v_pass
   where x.id = a.id;
end;
$$;

-- caller's attempt (never someone else's); an expired open attempt is closed first
create or replace function private.ex_attempt_for_caller(p_attempt_id uuid)
returns public.ex_attempts
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  a public.ex_attempts;
begin
  if (select auth.uid()) is null then
    raise exception 'forbidden: sign-in required' using errcode = '42501';
  end if;
  select * into a from public.ex_attempts x where x.id = p_attempt_id and x.user_id = (select auth.uid());
  if not found then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if a.status = 'in_progress' and a.hard_deadline_at is not null and now() > a.hard_deadline_at then
    perform private.ex_finalize(a.id, true);
    select * into a from public.ex_attempts x where x.id = p_attempt_id;
  end if;
  return a;
end;
$$;

-- what the trainee may see of one question: stem, media, options with OPAQUE ids in the attempt's order. Never a key.
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
  end if;
  return v_out;
end;
$$;

-- result summary (honors result_policy)
create or replace function private.ex_result_json(a public.ex_attempts)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s       jsonb;
  v_close timestamptz;
  v_open  boolean;
  v_ans   integer;
  v_out   jsonb;
begin
  select v.settings into s from public.ex_exam_versions v where v.id = a.exam_version_id;
  v_close := nullif(s ->> 'close_at', '')::timestamptz;
  v_open  := a.status <> 'in_progress' and a.status <> 'voided' and private.ex_policy_open(s ->> 'result_policy', v_close, a.result_released);
  select count(*) into v_ans from public.ex_attempt_items i where i.attempt_id = a.id and i.response is not null;
  v_out := jsonb_build_object('attempt_id', a.id, 'exam_id', a.exam_id, 'status', a.status, 'attempt_no', a.attempt_no,
                              'started_at', a.started_at, 'submitted_at', a.submitted_at, 'item_count', a.item_count,
                              'answered_count', v_ans, 'result_visible', v_open);
  if v_open then
    v_out := v_out || jsonb_build_object('score', a.score, 'max_score', a.max_score, 'percent', a.percent, 'passed', a.passed);
  end if;
  return v_out;
end;
$$;

-- ================================================================ 4. RPC exam_list_available
create or replace function private.exam_list_available()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null or not exists (select 1 from public.profiles p where p.id = v_uid and p.status = 'active') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(q.rj order by (q.rj ->> 'close_at') nulls last, q.rj ->> 'title_ar')
    from (
      select jsonb_build_object(
               'exam_id', e.id, 'course_id', e.course_id, 'title_ar', e.title_ar, 'exam_kind', e.exam_kind,
               'duration_minutes', v.settings -> 'duration_minutes', 'question_count', v.question_count, 'total_score', v.total_score,
               'open_at', v.settings -> 'open_at', 'close_at', v.settings -> 'close_at', 'max_attempts', v.settings -> 'max_attempts',
               'attempts_used', (select count(*) from public.ex_attempts a where a.exam_id = e.id and a.user_id = v_uid and a.status <> 'in_progress'),
               'in_progress', (select a.id from public.ex_attempts a where a.exam_id = e.id and a.user_id = v_uid and a.status = 'in_progress'),
               'can_start', (
                   (nullif(v.settings ->> 'open_at', '') is null or now() >= (v.settings ->> 'open_at')::timestamptz)
                   and (nullif(v.settings ->> 'close_at', '') is null or now() < (v.settings ->> 'close_at')::timestamptz)
                   and (nullif(v.settings ->> 'max_attempts', '') is null
                        or (select count(*) from public.ex_attempts a where a.exam_id = e.id and a.user_id = v_uid and a.status <> 'in_progress') < (v.settings ->> 'max_attempts')::integer)),
               'reason', case
                   when nullif(v.settings ->> 'open_at', '') is not null and now() < (v.settings ->> 'open_at')::timestamptz then 'not_open_yet'
                   when nullif(v.settings ->> 'close_at', '') is not null and now() >= (v.settings ->> 'close_at')::timestamptz then 'closed'
                   when nullif(v.settings ->> 'max_attempts', '') is not null
                        and (select count(*) from public.ex_attempts a where a.exam_id = e.id and a.user_id = v_uid and a.status <> 'in_progress') >= (v.settings ->> 'max_attempts')::integer then 'no_attempts_left'
                   else null end) as rj
      from public.ex_exams e
      join public.ex_exam_versions v on v.id = e.published_version_id
      join public.enrollments en on en.course_id = e.course_id and en.user_id = v_uid and en.status = 'active'
      where e.status = 'published'
    ) q), '[]'::jsonb);
end;
$$;

-- ================================================================ 5. RPC exam_start_attempt
create or replace function private.exam_start_attempt(p_exam_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := (select auth.uid());
  e         public.ex_exams;
  v         public.ex_exam_versions;
  s         jsonb;
  a         public.ex_attempts;
  v_seed    text;
  v_att     uuid;
  v_used    integer;
  v_dur     integer;
  v_grace   integer;
  v_close   timestamptz;
  v_dl      timestamptz;
  v_hard    timestamptz;
  v_shq     boolean;
  v_sho     boolean;
  v_n       integer;
begin
  if v_uid is null or not exists (select 1 from public.profiles p where p.id = v_uid and p.status = 'active') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into e from public.ex_exams x where x.id = p_exam_id and x.status = 'published';
  if not found or not exists (select 1 from public.enrollments en where en.user_id = v_uid and en.course_id = e.course_id and en.status = 'active') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v from public.ex_exam_versions x where x.id = e.published_version_id;
  s := v.settings;
  perform private.rl_hit('ex_start:' || v_uid::text, 3600, 10);

  -- an open attempt: close it if expired, otherwise resume (unless no_resume)
  select * into a from public.ex_attempts x where x.exam_id = e.id and x.user_id = v_uid and x.status = 'in_progress';
  if found then
    if a.hard_deadline_at is not null and now() > a.hard_deadline_at then
      perform private.ex_finalize(a.id, true);
    else
      if coalesce(s ->> 'resume_policy', 'resume_any_device') = 'no_resume' then
        raise exception 'no_resume: this exam cannot be resumed' using errcode = '55000';
      end if;
      return jsonb_build_object('attempt_id', a.id, 'resumed', true, 'item_count', a.item_count, 'started_at', a.started_at,
                                'deadline_at', a.deadline_at, 'hard_deadline_at', a.hard_deadline_at, 'server_now', now());
    end if;
  end if;

  v_close := nullif(s ->> 'close_at', '')::timestamptz;
  if nullif(s ->> 'open_at', '') is not null and now() < (s ->> 'open_at')::timestamptz then
    raise exception 'exam_not_open' using errcode = '55000';
  end if;
  if v_close is not null and now() >= v_close then
    raise exception 'exam_closed' using errcode = '55000';
  end if;
  select count(*) into v_used from public.ex_attempts x where x.exam_id = e.id and x.user_id = v_uid and x.status <> 'in_progress';
  if nullif(s ->> 'max_attempts', '') is not null and v_used >= (s ->> 'max_attempts')::integer then
    raise exception 'no_attempts_left' using errcode = '55000';
  end if;

  v_dur := nullif(s ->> 'duration_minutes', '')::integer;
  v_grace := coalesce(nullif(s ->> 'grace_seconds', '')::integer, 30);
  v_dl := case when v_dur is not null then now() + make_interval(mins => v_dur) end;
  v_hard := case when v_dl is not null then v_dl + make_interval(secs => v_grace) end;
  if v_close is not null then
    v_dl := least(coalesce(v_dl, v_close), v_close);
    v_hard := least(coalesce(v_hard, v_close + make_interval(secs => v_grace)), v_close + make_interval(secs => v_grace));
  end if;
  v_seed := gen_random_uuid()::text;
  v_shq := coalesce((s ->> 'shuffle_questions')::boolean, true);
  v_sho := coalesce((s ->> 'shuffle_options')::boolean, true);

  insert into public.ex_attempts (exam_id, exam_version_id, course_id, user_id, attempt_no, seed, item_count, deadline_at, hard_deadline_at, last_seen_at)
  values (e.id, v.id, e.course_id, v_uid, v_used + 1, v_seed, v.question_count, v_dl, v_hard, now())
  returning id into v_att;

  with src as (
    select 0 as grp, vi.position as ord, vi.question_id as qid, vi.question_version_id as qvid, vi.points as pts
      from public.ex_exam_version_items vi where vi.exam_version_id = v.id
    union all
    select 1, r.rule_no, d.question_id, d.question_version_id, r.points_each
      from public.ex_exam_version_rules r
      cross join lateral (select p.question_id, p.question_version_id from public.ex_exam_version_pool p
                           where p.exam_version_id = r.exam_version_id and p.rule_no = r.rule_no
                           order by md5(v_seed || p.question_id::text) limit r.draw_count) d
     where r.exam_version_id = v.id
  ), ordered as (
    select s2.*, row_number() over (order by case when v_shq then md5(v_seed || 'q' || s2.qid::text) end, s2.grp, s2.ord, md5(v_seed || s2.qid::text)) as pos
      from src s2
  )
  insert into public.ex_attempt_items (attempt_id, position, course_id, question_id, question_version_id, type_code, points, option_map)
  select v_att, o.pos, e.course_id, o.qid, o.qvid, qv.type_code, o.pts, private.ex_build_option_map(qv.type_code, qv.payload, v_sho)
    from ordered o join public.qb_question_versions qv on qv.id = o.qvid;

  select count(*) into v_n from public.ex_attempt_items i where i.attempt_id = v_att;
  if v_n <> v.question_count then
    raise exception 'attempt could not be built (% of % questions)', v_n, v.question_count using errcode = '55000';
  end if;
  return jsonb_build_object('attempt_id', v_att, 'resumed', false, 'item_count', v_n, 'started_at', now(),
                            'deadline_at', v_dl, 'hard_deadline_at', v_hard, 'server_now', now(),
                            'settings', jsonb_build_object('allow_back', coalesce((s ->> 'allow_back')::boolean, true),
                              'allow_flag', coalesce((s ->> 'allow_flag')::boolean, true),
                              'allow_whiteboard', coalesce((s ->> 'allow_whiteboard')::boolean, false),
                              'allow_calculator', coalesce((s ->> 'allow_calculator')::boolean, false),
                              'allow_translation', coalesce((s ->> 'allow_translation')::boolean, false),
                              'title_ar', s ->> 'title_ar', 'exam_kind', s ->> 'exam_kind',
                              'security', s -> 'security'));
end;
$$;

create or replace function private.ex_public_settings(s jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object('allow_back', coalesce((s ->> 'allow_back')::boolean, true),
                            'allow_flag', coalesce((s ->> 'allow_flag')::boolean, true),
                            'allow_whiteboard', coalesce((s ->> 'allow_whiteboard')::boolean, false),
                            'allow_calculator', coalesce((s ->> 'allow_calculator')::boolean, false),
                            'allow_translation', coalesce((s ->> 'allow_translation')::boolean, false),
                            'title_ar', s ->> 'title_ar', 'exam_kind', s ->> 'exam_kind', 'security', s -> 'security');
$$;

-- ================================================================ 6. RPC exam_get_items
create or replace function private.exam_get_items(p_attempt_id uuid, p_from integer default 1, p_count integer default 3)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  a       public.ex_attempts;
  v_items jsonb;
  v_ans   integer;
  v_set   jsonb;
begin
  if p_from is null or p_from < 1 or p_count is null or p_count not between 1 and 10 then
    raise exception 'invalid range' using errcode = '22023';
  end if;
  a := private.ex_attempt_for_caller(p_attempt_id);
  perform private.rl_hit('ex_get:' || a.user_id::text, 60, 120);
  if a.status <> 'in_progress' then
    return jsonb_build_object('closed', true, 'status', a.status, 'server_now', now());
  end if;
  update public.ex_attempts x set last_seen_at = now() where x.id = a.id;
  select private.ex_public_settings(v.settings) into v_set from public.ex_exam_versions v where v.id = a.exam_version_id;
  select coalesce(jsonb_agg(private.ex_public_item(i) order by i.position), '[]'::jsonb) into v_items
    from public.ex_attempt_items i where i.attempt_id = a.id and i.position >= p_from and i.position < p_from + p_count;
  select count(*) into v_ans from public.ex_attempt_items i where i.attempt_id = a.id and i.response is not null;
  return jsonb_build_object('closed', false, 'status', a.status, 'items', v_items, 'item_count', a.item_count,
                            'answered_count', v_ans, 'deadline_at', a.deadline_at, 'hard_deadline_at', a.hard_deadline_at,
                            'server_now', now(), 'settings', v_set);
end;
$$;

-- ================================================================ 7. RPC exam_save_answer
create or replace function private.exam_save_answer(p_attempt_id uuid, p_position integer, p_response jsonb, p_flagged boolean default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  a       public.ex_attempts;
  it      public.ex_attempt_items;
  s       jsonb;
  v_chk   jsonb;
  v_ans   integer;
  v_out   jsonb;
  v_key   public.qb_question_keys;
  v_score numeric;
begin
  a := private.ex_attempt_for_caller(p_attempt_id);
  perform private.rl_hit('ex_save:' || a.user_id::text, 60, 180);
  if a.status <> 'in_progress' then
    return jsonb_build_object('closed', true, 'status', a.status);
  end if;
  select * into it from public.ex_attempt_items i where i.attempt_id = a.id and i.position = p_position for update;
  if not found then
    raise exception 'unknown question position' using errcode = '22023';
  end if;
  v_chk := private.ex_check_response(it.type_code, it.option_map, p_response);
  update public.ex_attempt_items i
     set response = v_chk -> 'opaque',
         answered_at = case when v_chk -> 'opaque' is null then null else now() end,
         flagged = coalesce(p_flagged, i.flagged)
   where i.attempt_id = a.id and i.position = p_position;
  update public.ex_attempts x set last_seen_at = now() where x.id = a.id;
  select count(*) into v_ans from public.ex_attempt_items i where i.attempt_id = a.id and i.response is not null;
  v_out := jsonb_build_object('saved', true, 'answered_count', v_ans, 'server_now', now());

  -- practice exams may show feedback / explanation while answering ('always')
  select v2.settings into s from public.ex_exam_versions v2 where v2.id = a.exam_version_id;
  if s ->> 'exam_kind' = 'practice' and v_chk -> 'real' is not null
     and ((s ->> 'feedback_policy') = 'always' or (s ->> 'explanation_policy') = 'always') then
    select * into v_key from public.qb_question_keys k where k.version_id = it.question_version_id;
    v_score := private.ex_grade(it.type_code, v_chk -> 'real', coalesce(v_key.key, '{}'::jsonb), it.points);
    v_out := v_out || jsonb_build_object('correct', v_score >= it.points, 'score', v_score);
    if (s ->> 'feedback_policy') = 'always' then
      v_out := v_out || jsonb_build_object('feedback', case when v_score >= it.points then v_key.feedback_correct else v_key.feedback_incorrect end);
    end if;
    if (s ->> 'explanation_policy') = 'always' then
      v_out := v_out || jsonb_build_object('explanation', v_key.explanation);
    end if;
  end if;
  return v_out;
end;
$$;

-- ================================================================ 8. RPC exam_submit
create or replace function private.exam_submit(p_attempt_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  a public.ex_attempts;
begin
  a := private.ex_attempt_for_caller(p_attempt_id);
  perform private.rl_hit('ex_submit:' || a.user_id::text, 60, 20);
  if a.status = 'in_progress' then
    perform private.ex_finalize(a.id, false);
    select * into a from public.ex_attempts x where x.id = p_attempt_id;
  end if;
  return private.ex_result_json(a);
end;
$$;

-- ================================================================ 9. RPC exam_attempt_result (+ review when allowed)
create or replace function private.exam_attempt_result(p_attempt_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  a        public.ex_attempts;
  s        jsonb;
  v_close  timestamptz;
  v_rev    boolean;
  v_fb     boolean;
  v_ex     boolean;
  v_out    jsonb;
  v_items  jsonb;
begin
  a := private.ex_attempt_for_caller(p_attempt_id);
  perform private.rl_hit('ex_result:' || a.user_id::text, 60, 60);
  if a.status = 'in_progress' then
    raise exception 'not_finished' using errcode = '55000';
  end if;
  v_out := private.ex_result_json(a);
  if a.status = 'voided' then
    return v_out;
  end if;
  select v.settings into s from public.ex_exam_versions v where v.id = a.exam_version_id;
  v_close := nullif(s ->> 'close_at', '')::timestamptz;
  v_rev := private.ex_policy_open(s ->> 'review_policy', v_close, a.result_released);
  v_fb  := private.ex_policy_open(s ->> 'feedback_policy', v_close, a.result_released);
  v_ex  := private.ex_policy_open(s ->> 'explanation_policy', v_close, a.result_released);
  if v_rev then
    select coalesce(jsonb_agg(
             private.ex_public_item(i) || jsonb_build_object('final_score', i.final_score,
               'correct_answer', (
                 select case i.type_code
                   when 'multi_response' then jsonb_build_object('choices', (select jsonb_agg(o.opq) from jsonb_each_text(i.option_map -> 'opts') o(opq, rid) where (k.key -> 'correct') ? o.rid))
                   when 'matching' then jsonb_build_object('pairs', (select jsonb_object_agg(lo.opq, ro.opq)
                                          from jsonb_each_text(k.key -> 'pairs') kp(l, r)
                                          join jsonb_each_text(i.option_map -> 'left') lo(opq, rid) on lo.rid = kp.l
                                          join jsonb_each_text(i.option_map -> 'right') ro(opq, rid) on ro.rid = kp.r))
                   else jsonb_build_object('choice', (select o.opq from jsonb_each_text(i.option_map -> 'opts') o(opq, rid) where o.rid = k.key ->> 'correct'))
                 end
                 from public.qb_question_keys k where k.version_id = i.question_version_id),
               'feedback', case when v_fb then (select case when coalesce(i.final_score, 0) >= i.points then k.feedback_correct else k.feedback_incorrect end from public.qb_question_keys k where k.version_id = i.question_version_id) end,
               'explanation', case when v_ex then (select k.explanation from public.qb_question_keys k where k.version_id = i.question_version_id) end)
             order by i.position), '[]'::jsonb)
      into v_items
      from public.ex_attempt_items i where i.attempt_id = a.id;
    v_out := v_out || jsonb_build_object('review', v_items);
  end if;
  return v_out;
end;
$$;

-- ================================================================ 10. RPC exam_log_event (client-side signals)
create or replace function private.exam_log_event(p_attempt_id uuid, p_kind text, p_details jsonb default '{}'::jsonb)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  a public.ex_attempts;
begin
  if p_kind is null or p_kind not in ('visibility_hidden', 'blur', 'fullscreen_exit', 'copy_attempt', 'devtools_heuristic', 'other') then
    raise exception 'unknown event kind' using errcode = '22023';
  end if;
  a := private.ex_attempt_for_caller(p_attempt_id);
  perform private.rl_hit('ex_event:' || a.user_id::text, 60, 60);
  if a.status = 'in_progress' then
    perform private.log_security_event(a.course_id, p_kind, 'low', coalesce(case when jsonb_typeof(p_details) = 'object' then p_details end, '{}'::jsonb), a.id, null);
  end if;
end;
$$;

-- ================================================================ 11. RPC exam_release_results (result_policy = manual)
create or replace function private.exam_release_results(p_exam_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_course text;
  v_n      integer;
begin
  select e.course_id into v_course from public.ex_exams e where e.id = p_exam_id;
  if v_course is null or not (private.is_admin() or private.has_staff_perm(v_course, 'exam.publish')) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update public.ex_attempts a set result_released = true
   where a.exam_id = p_exam_id and a.status in ('submitted', 'timed_out') and not a.result_released;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- ================================================================ 12. REST wrappers (SECURITY INVOKER) + privileges
create or replace function public.exam_list_available()
returns jsonb language sql volatile set search_path = '' as $$ select private.exam_list_available(); $$;
create or replace function public.exam_start_attempt(p_exam_id uuid)
returns jsonb language sql volatile set search_path = '' as $$ select private.exam_start_attempt(p_exam_id); $$;
create or replace function public.exam_get_items(p_attempt_id uuid, p_from integer default 1, p_count integer default 3)
returns jsonb language sql volatile set search_path = '' as $$ select private.exam_get_items(p_attempt_id, p_from, p_count); $$;
create or replace function public.exam_save_answer(p_attempt_id uuid, p_position integer, p_response jsonb, p_flagged boolean default null)
returns jsonb language sql volatile set search_path = '' as $$ select private.exam_save_answer(p_attempt_id, p_position, p_response, p_flagged); $$;
create or replace function public.exam_submit(p_attempt_id uuid)
returns jsonb language sql volatile set search_path = '' as $$ select private.exam_submit(p_attempt_id); $$;
create or replace function public.exam_attempt_result(p_attempt_id uuid)
returns jsonb language sql volatile set search_path = '' as $$ select private.exam_attempt_result(p_attempt_id); $$;
create or replace function public.exam_log_event(p_attempt_id uuid, p_kind text, p_details jsonb default '{}'::jsonb)
returns void language sql volatile set search_path = '' as $$ select private.exam_log_event(p_attempt_id, p_kind, p_details); $$;
create or replace function public.exam_release_results(p_exam_id uuid)
returns integer language sql volatile set search_path = '' as $$ select private.exam_release_results(p_exam_id); $$;

revoke execute on function private.ex_opaque()                                         from public, anon, authenticated;
revoke execute on function private.ex_public_settings(jsonb)                       from public, anon, authenticated;
revoke execute on function private.ex_build_option_map(text, jsonb, boolean)           from public, anon, authenticated;
revoke execute on function private.ex_check_response(text, jsonb, jsonb)               from public, anon, authenticated;
revoke execute on function private.ex_grade(text, jsonb, jsonb, numeric)               from public, anon, authenticated;
revoke execute on function private.ex_policy_open(text, timestamptz, boolean)          from public, anon, authenticated;
revoke execute on function private.ex_finalize(uuid, boolean)                          from public, anon, authenticated;
revoke execute on function private.ex_attempt_for_caller(uuid)                         from public, anon, authenticated;
revoke execute on function private.ex_public_item(public.ex_attempt_items)             from public, anon, authenticated;
revoke execute on function private.ex_result_json(public.ex_attempts)                  from public, anon, authenticated;
revoke execute on function private.exam_list_available()                               from public, anon, authenticated;
revoke execute on function private.exam_start_attempt(uuid)                            from public, anon, authenticated;
revoke execute on function private.exam_get_items(uuid, integer, integer)              from public, anon, authenticated;
revoke execute on function private.exam_save_answer(uuid, integer, jsonb, boolean)     from public, anon, authenticated;
revoke execute on function private.exam_submit(uuid)                                   from public, anon, authenticated;
revoke execute on function private.exam_attempt_result(uuid)                           from public, anon, authenticated;
revoke execute on function private.exam_log_event(uuid, text, jsonb)                   from public, anon, authenticated;
revoke execute on function private.exam_release_results(uuid)                          from public, anon, authenticated;
revoke execute on function private.ex_media_allowed(text)                              from public, anon, authenticated;
revoke execute on function public.exam_list_available()                                from public, anon, authenticated;
revoke execute on function public.exam_start_attempt(uuid)                             from public, anon, authenticated;
revoke execute on function public.exam_get_items(uuid, integer, integer)               from public, anon, authenticated;
revoke execute on function public.exam_save_answer(uuid, integer, jsonb, boolean)      from public, anon, authenticated;
revoke execute on function public.exam_submit(uuid)                                    from public, anon, authenticated;
revoke execute on function public.exam_attempt_result(uuid)                            from public, anon, authenticated;
revoke execute on function public.exam_log_event(uuid, text, jsonb)                    from public, anon, authenticated;
revoke execute on function public.exam_release_results(uuid)                           from public, anon, authenticated;
-- the wrappers run as the signed-in user and call these; the storage policy evaluates ex_media_allowed as the user
grant execute on function private.exam_list_available()                               to authenticated;
grant execute on function private.exam_start_attempt(uuid)                            to authenticated;
grant execute on function private.exam_get_items(uuid, integer, integer)              to authenticated;
grant execute on function private.exam_save_answer(uuid, integer, jsonb, boolean)     to authenticated;
grant execute on function private.exam_submit(uuid)                                   to authenticated;
grant execute on function private.exam_attempt_result(uuid)                           to authenticated;
grant execute on function private.exam_log_event(uuid, text, jsonb)                   to authenticated;
grant execute on function private.exam_release_results(uuid)                          to authenticated;
grant execute on function private.ex_media_allowed(text)                              to authenticated;
grant execute on function public.exam_list_available()                                to authenticated;
grant execute on function public.exam_start_attempt(uuid)                             to authenticated;
grant execute on function public.exam_get_items(uuid, integer, integer)               to authenticated;
grant execute on function public.exam_save_answer(uuid, integer, jsonb, boolean)      to authenticated;
grant execute on function public.exam_submit(uuid)                                    to authenticated;
grant execute on function public.exam_attempt_result(uuid)                            to authenticated;
grant execute on function public.exam_log_event(uuid, text, jsonb)                    to authenticated;
grant execute on function public.exam_release_results(uuid)                           to authenticated;

-- ================================================================ 13. RPC exam_my_attempts (the caller's own attempts)
create or replace function private.exam_my_attempts(p_exam_id uuid default null)
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
    raise exception 'forbidden: sign-in required' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(private.ex_result_json(a) || jsonb_build_object('title_ar', e.title_ar, 'exam_kind', e.exam_kind, 'course_id', a.course_id)
                     order by a.started_at desc)
    from (select x.* from public.ex_attempts x where x.user_id = v_uid and (p_exam_id is null or x.exam_id = p_exam_id)
          order by x.started_at desc limit 100) a
    join public.ex_exams e on e.id = a.exam_id), '[]'::jsonb);
end;
$$;
create or replace function public.exam_my_attempts(p_exam_id uuid default null)
returns jsonb language sql stable set search_path = '' as $$ select private.exam_my_attempts(p_exam_id); $$;
revoke execute on function private.exam_my_attempts(uuid) from public, anon, authenticated;
revoke execute on function public.exam_my_attempts(uuid)  from public, anon, authenticated;
grant execute on function private.exam_my_attempts(uuid) to authenticated;
grant execute on function public.exam_my_attempts(uuid)  to authenticated;

-- ================================================================ ROLLBACK (see docs/exams/rollback-014.sql)
