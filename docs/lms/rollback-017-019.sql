-- rollback-017-019: undoes LMS phase 2b (5 new question types + manual grading).
-- DESTRUCTIVE: removes grading data (grader, notes, grading_status). Existing questions/answers of the new types must be exported or removed first.
-- GUARD: delete the next line manually after exporting what you need.
do $$ begin raise exception 'rollback-017-019 guard: export first, then remove this line'; end $$;
begin;
-- 1) no attempt/question may use the new types
do $$ begin
  if exists (select 1 from public.qb_question_versions where type_code in ('short_answer', 'numerical', 'essay', 'ordering', 'fill_blank'))
     or exists (select 1 from public.ex_attempt_items where type_code in ('short_answer', 'numerical', 'essay', 'ordering', 'fill_blank')) then
    raise exception 'questions or attempts of the new types exist: delete them first';
  end if;
end $$;

-- 2) 019: staff RPCs, grading columns
drop function if exists public.exam_grading_queue(text, uuid), public.exam_grading_get(uuid), public.exam_grade_item(uuid, integer, numeric, text);
drop function if exists private.exam_grading_queue(text, uuid), private.exam_grading_get(uuid), private.exam_grade_item(uuid, integer, numeric, text), private.ex_apply_totals(uuid);
drop index if exists public.ex_attempts_pending_idx, public.ex_attempt_items_grader_idx;
alter table public.ex_attempt_items drop column if exists manual, drop column if exists grader_id, drop column if exists graded_at, drop column if exists grader_note;
alter table public.ex_attempts drop column if exists grading_status;

-- 3) 017: registry + validators
update public.qb_question_types set enabled = false, validator = null, public_schema = '{}', key_schema = '{}', response_schema = '{}'
 where code in ('short_answer', 'numerical', 'essay', 'ordering');
delete from public.qb_question_types where code = 'fill_blank';
drop function if exists private.qb_validate_short_answer(jsonb, jsonb), private.qb_validate_numerical(jsonb, jsonb), private.qb_validate_essay(jsonb, jsonb),
  private.qb_validate_ordering(jsonb, jsonb), private.qb_validate_fill_blank(jsonb, jsonb), private.qb_check_text_list(jsonb, integer, integer, text), private.ex_parse_number(text);
commit;

-- 4) MANUAL: re-run the CREATE OR REPLACE blocks from 014_exam_attempts.sql for the functions 018/019 replaced:
--    private.ex_build_option_map, private.ex_check_response, private.ex_grade, private.ex_public_item, private.ex_finalize,
--    private.ex_result_json, private.exam_save_answer, private.exam_attempt_result  (and re-add 015's SEB-aware wrappers are unaffected).
