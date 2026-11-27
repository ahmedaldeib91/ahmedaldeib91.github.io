-- rollback-014: removes ONLY what 014_exam_attempts.sql created. Destroys every attempt, answer and score.
-- GUARD: delete the next line manually after exporting what you need.
do $$ begin raise exception 'rollback-014 guard: export the data first, then remove this line'; end $$;
begin;
drop policy if exists p4_exam_media_trainee on storage.objects;
alter table public.ex_security_events drop constraint if exists ex_security_events_attempt_fkey;
drop function if exists public.exam_list_available(), public.exam_start_attempt(uuid), public.exam_get_items(uuid, integer, integer),
  public.exam_save_answer(uuid, integer, jsonb, boolean), public.exam_submit(uuid), public.exam_attempt_result(uuid),
  public.exam_log_event(uuid, text, jsonb), public.exam_release_results(uuid);
drop function if exists private.exam_list_available(), private.exam_start_attempt(uuid), private.exam_get_items(uuid, integer, integer),
  private.exam_save_answer(uuid, integer, jsonb, boolean), private.exam_submit(uuid), private.exam_attempt_result(uuid),
  private.exam_log_event(uuid, text, jsonb), private.exam_release_results(uuid), private.ex_media_allowed(text),
  private.ex_result_json(public.ex_attempts), private.ex_public_item(public.ex_attempt_items), private.ex_attempt_for_caller(uuid),
  private.ex_finalize(uuid, boolean), private.ex_policy_open(text, timestamptz, boolean), private.ex_grade(text, jsonb, jsonb, numeric),
  private.ex_check_response(text, jsonb, jsonb), private.ex_build_option_map(text, jsonb, boolean), private.ex_opaque();
drop table if exists public.ex_attempt_items, public.ex_attempts;
commit;
