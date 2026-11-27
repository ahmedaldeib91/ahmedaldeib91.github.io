-- 019_manual_grading  (LMS phase 2b, part 3/3: essay answers are graded by staff)
-- Requires 014 + 017 + 018. Adds the grading state to attempts and items, rewrites the finalize / result / review / save-answer
-- functions of 014 (same behavior for auto-graded exams) and adds 3 staff RPCs guarded by the 'grading' permission:
--   exam_grading_queue(course, exam?)         attempts waiting for grading
--   exam_grading_get(attempt)                 the essay answers of one attempt (+ rubric / model answer, staff only)
--   exam_grade_item(attempt, position, score, note?)   score one essay; the attempt total is computed when none is pending
-- A trainee whose attempt has a pending essay sees "grading pending" (no score / review) until every essay is graded.

alter table public.ex_attempts
  add column grading_status text not null default 'none' check (grading_status in ('none', 'pending', 'done'));
alter table public.ex_attempt_items
  add column manual      boolean not null default false,
  add column grader_id   uuid references public.profiles (id) on delete set null,
  add column graded_at   timestamptz,
  add column grader_note text check (grader_note is null or char_length(grader_note) <= 2000);
create index ex_attempt_items_grader_idx on public.ex_attempt_items (grader_id);
create index ex_attempts_pending_idx on public.ex_attempts (course_id, submitted_at) where grading_status = 'pending';

-- ---------------------------------------------------------------- totals (used when the last pending essay is graded)
create or replace function private.ex_apply_totals(p_attempt_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  a       public.ex_attempts;
  s       jsonb;
  v_sum   numeric;
  v_max   numeric;
  v_pct   numeric;
  v_pass  boolean;
begin
  select * into a from public.ex_attempts x where x.id = p_attempt_id for update;
  if not found then return; end if;
  select v.settings into s from public.ex_exam_versions v where v.id = a.exam_version_id;
  select coalesce(sum(i.final_score), 0), coalesce(sum(i.points), 0) into v_sum, v_max
    from public.ex_attempt_items i where i.attempt_id = a.id;
  v_pct := case when v_max > 0 then round(v_sum / v_max * 100, 2) else 0 end;
  v_pass := case
              when s ->> 'pass_percent' is not null then v_pct >= (s ->> 'pass_percent')::numeric
              when s ->> 'pass_score' is not null then v_sum >= (s ->> 'pass_score')::numeric
              else null end;
  update public.ex_attempts x set score = v_sum, max_score = v_max, percent = v_pct, passed = v_pass, grading_status = 'done' where x.id = a.id;
end;
$$;

-- ---------------------------------------------------------------- finalize (essays with an answer wait for staff)
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
  v_manual boolean := false;
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
    v_max := v_max + it.points;
    if it.type_code = 'essay' and it.response is not null then
      update public.ex_attempt_items i set final_score = null, manual = true where i.attempt_id = a.id and i.position = it.position;
      v_manual := true;
      continue;
    end if;
    select k.key into v_key from public.qb_question_keys k where k.version_id = it.question_version_id;
    v_score := 0;
    if it.response is not null and it.type_code <> 'essay' then
      begin
        v_chk := private.ex_check_response(it.type_code, it.option_map, it.response);
        v_score := private.ex_grade(it.type_code, v_chk -> 'real', coalesce(v_key, '{}'::jsonb), it.points);
      exception when others then
        v_score := 0; -- a malformed stored response scores 0, never blocks the close
      end;
    end if;
    update public.ex_attempt_items i set final_score = v_score where i.attempt_id = a.id and i.position = it.position;
    v_sum := v_sum + v_score;
  end loop;

  if v_manual then
    update public.ex_attempts x
       set status = case when p_timed_out then 'timed_out' else 'submitted' end, submitted_at = now(),
           score = null, max_score = v_max, percent = null, passed = null, grading_status = 'pending'
     where x.id = a.id;
    return;
  end if;
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

-- ---------------------------------------------------------------- result summary
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
  v_open  := a.status <> 'in_progress' and a.status <> 'voided' and a.grading_status <> 'pending'
             and private.ex_policy_open(s ->> 'result_policy', v_close, a.result_released);
  select count(*) into v_ans from public.ex_attempt_items i where i.attempt_id = a.id and i.response is not null;
  v_out := jsonb_build_object('attempt_id', a.id, 'exam_id', a.exam_id, 'status', a.status, 'attempt_no', a.attempt_no,
                              'started_at', a.started_at, 'submitted_at', a.submitted_at, 'item_count', a.item_count,
                              'answered_count', v_ans, 'result_visible', v_open, 'grading_pending', a.grading_status = 'pending');
  if v_open then
    v_out := v_out || jsonb_build_object('score', a.score, 'max_score', a.max_score, 'percent', a.percent, 'passed', a.passed);
  end if;
  return v_out;
end;
$$;

-- ---------------------------------------------------------------- save answer (practice feedback never applies to essays)
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
  if s ->> 'exam_kind' = 'practice' and v_chk -> 'real' is not null and it.type_code <> 'essay'
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

-- ---------------------------------------------------------------- result + review
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
  if a.status = 'voided' or a.grading_status = 'pending' then
    return v_out;
  end if;
  select v.settings into s from public.ex_exam_versions v where v.id = a.exam_version_id;
  v_close := nullif(s ->> 'close_at', '')::timestamptz;
  v_rev := private.ex_policy_open(s ->> 'review_policy', v_close, a.result_released);
  v_fb  := private.ex_policy_open(s ->> 'feedback_policy', v_close, a.result_released);
  v_ex  := private.ex_policy_open(s ->> 'explanation_policy', v_close, a.result_released);
  if v_rev then
    select coalesce(jsonb_agg(
             private.ex_public_item(i) || jsonb_build_object('final_score', i.final_score, 'manual', i.manual,
               'grader_note', i.grader_note,
               'correct_answer', (
                 select case i.type_code
                   when 'multi_response' then jsonb_build_object('choices', (select jsonb_agg(o.opq) from jsonb_each_text(i.option_map -> 'opts') o(opq, rid) where (k.key -> 'correct') ? o.rid))
                   when 'matching' then jsonb_build_object('pairs', (select jsonb_object_agg(lo.opq, ro.opq)
                                          from jsonb_each_text(k.key -> 'pairs') kp(l, r)
                                          join jsonb_each_text(i.option_map -> 'left') lo(opq, rid) on lo.rid = kp.l
                                          join jsonb_each_text(i.option_map -> 'right') ro(opq, rid) on ro.rid = kp.r))
                   when 'ordering' then jsonb_build_object('order', (select jsonb_agg(o.opq order by ko.ord)
                                          from jsonb_array_elements_text(k.key -> 'order') with ordinality as ko(rid, ord)
                                          join jsonb_each_text(i.option_map -> 'items') o(opq, rid2) on o.rid2 = ko.rid))
                   when 'short_answer' then jsonb_build_object('answers', k.key -> 'answers')
                   when 'numerical' then jsonb_strip_nulls(jsonb_build_object('value', k.key -> 'value', 'tolerance', k.key -> 'tolerance', 'mode', k.key -> 'tolerance_mode'))
                   when 'fill_blank' then jsonb_build_object('blanks', k.key -> 'blanks')
                   when 'essay' then jsonb_strip_nulls(jsonb_build_object('model_answer', k.key -> 'model_answer'))
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

-- ================================================================ staff RPCs
create or replace function private.exam_grading_queue(p_course_id text, p_exam_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null or not private.has_staff_perm(p_course_id, 'grading') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(q.j order by q.sub)
    from (select a.submitted_at as sub, jsonb_build_object(
            'attempt_id', a.id, 'exam_id', a.exam_id, 'exam_title', e.title_ar, 'user_id', a.user_id,
            'trainee', coalesce(nullif(p.full_name, ''), '—'), 'submitted_at', a.submitted_at, 'attempt_no', a.attempt_no,
            'pending', (select count(*) from public.ex_attempt_items i where i.attempt_id = a.id and i.manual and i.final_score is null)) as j
          from public.ex_attempts a
          join public.ex_exams e on e.id = a.exam_id
          join public.profiles p on p.id = a.user_id
          where a.course_id = p_course_id and a.grading_status = 'pending' and (p_exam_id is null or a.exam_id = p_exam_id)
          order by a.submitted_at limit 500) q), '[]'::jsonb);
end;
$$;

create or replace function private.exam_grading_get(p_attempt_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  a public.ex_attempts;
begin
  select * into a from public.ex_attempts x where x.id = p_attempt_id;
  if not found or (select auth.uid()) is null or not private.has_staff_perm(a.course_id, 'grading') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'attempt_id', a.id, 'exam_id', a.exam_id, 'status', a.status, 'grading_status', a.grading_status, 'attempt_no', a.attempt_no,
    'trainee', (select coalesce(nullif(p.full_name, ''), '—') from public.profiles p where p.id = a.user_id),
    'submitted_at', a.submitted_at, 'score', a.score, 'max_score', a.max_score, 'percent', a.percent, 'passed', a.passed,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'position', i.position, 'points', i.points, 'stem', v.payload -> 'stem' ->> 'text',
               'min_words', v.payload -> 'min_words', 'max_words', v.payload -> 'max_words',
               'response', i.response ->> 'text', 'final_score', i.final_score, 'grader_note', i.grader_note, 'graded_at', i.graded_at,
               'rubric', k.key ->> 'rubric', 'model_answer', k.key ->> 'model_answer') order by i.position)
      from public.ex_attempt_items i
      join public.qb_question_versions v on v.id = i.question_version_id
      left join public.qb_question_keys k on k.version_id = i.question_version_id
      where i.attempt_id = a.id and i.manual), '[]'::jsonb));
end;
$$;

create or replace function private.exam_grade_item(p_attempt_id uuid, p_position integer, p_score numeric, p_note text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := (select auth.uid());
  a       public.ex_attempts;
  it      public.ex_attempt_items;
  v_left  integer;
begin
  select * into a from public.ex_attempts x where x.id = p_attempt_id for update;
  if not found or v_uid is null or not private.has_staff_perm(a.course_id, 'grading') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform private.rl_hit('ex_grade:' || v_uid::text, 60, 300);
  if a.status not in ('submitted', 'timed_out') or a.grading_status = 'none' then
    raise exception 'this attempt has nothing to grade' using errcode = '55000';
  end if;
  select * into it from public.ex_attempt_items i where i.attempt_id = a.id and i.position = p_position for update;
  if not found or not it.manual then
    raise exception 'this question is not graded manually' using errcode = '22023';
  end if;
  if p_score is null or p_score < 0 or p_score > it.points then
    raise exception 'score must be between 0 and %', it.points using errcode = '22023';
  end if;
  if p_note is not null and char_length(p_note) > 2000 then
    raise exception 'note too long (max 2000)' using errcode = '22023';
  end if;
  update public.ex_attempt_items i
     set final_score = round(p_score, 2), grader_id = v_uid, graded_at = now(), grader_note = nullif(btrim(coalesce(p_note, '')), '')
   where i.attempt_id = a.id and i.position = p_position;
  select count(*) into v_left from public.ex_attempt_items i where i.attempt_id = a.id and i.manual and i.final_score is null;
  if v_left = 0 then
    perform private.ex_apply_totals(a.id);
  end if;
  select * into a from public.ex_attempts x where x.id = p_attempt_id;
  return jsonb_build_object('pending_left', v_left, 'done', v_left = 0, 'score', a.score, 'max_score', a.max_score, 'percent', a.percent, 'passed', a.passed);
end;
$$;

-- ================================================================ REST wrappers + privileges
create or replace function public.exam_grading_queue(p_course_id text, p_exam_id uuid default null)
returns jsonb language sql stable set search_path = '' as $$ select private.exam_grading_queue(p_course_id, p_exam_id); $$;
create or replace function public.exam_grading_get(p_attempt_id uuid)
returns jsonb language sql stable set search_path = '' as $$ select private.exam_grading_get(p_attempt_id); $$;
create or replace function public.exam_grade_item(p_attempt_id uuid, p_position integer, p_score numeric, p_note text default null)
returns jsonb language sql volatile set search_path = '' as $$ select private.exam_grade_item(p_attempt_id, p_position, p_score, p_note); $$;

revoke execute on function private.ex_apply_totals(uuid)                                from public, anon, authenticated;
revoke execute on function private.exam_grading_queue(text, uuid)                       from public, anon, authenticated;
revoke execute on function private.exam_grading_get(uuid)                               from public, anon, authenticated;
revoke execute on function private.exam_grade_item(uuid, integer, numeric, text)        from public, anon, authenticated;
revoke execute on function public.exam_grading_queue(text, uuid)                        from public, anon, authenticated;
revoke execute on function public.exam_grading_get(uuid)                                from public, anon, authenticated;
revoke execute on function public.exam_grade_item(uuid, integer, numeric, text)         from public, anon, authenticated;
grant  execute on function private.exam_grading_queue(text, uuid)                       to authenticated;
grant  execute on function private.exam_grading_get(uuid)                               to authenticated;
grant  execute on function private.exam_grade_item(uuid, integer, numeric, text)        to authenticated;
grant  execute on function public.exam_grading_queue(text, uuid)                        to authenticated;
grant  execute on function public.exam_grading_get(uuid)                                to authenticated;
grant  execute on function public.exam_grade_item(uuid, integer, numeric, text)         to authenticated;

-- ROLLBACK: docs/lms/rollback-017-019.sql
