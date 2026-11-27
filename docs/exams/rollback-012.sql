-- rollback-012: removes ONLY what 012_question_types_a.sql created (graphic + matching + exam-media bucket policies).
-- GUARD: delete the next line manually after checking the notes below.
do $$ begin raise exception 'rollback-012 guard: read the notes and remove this line'; end $$;
-- Notes: (1) refuses to run if graphic/matching questions exist (they would become invalid);
--        (2) the bucket row is deleted only when it holds no objects (delete the files from the dashboard first).
begin;
do $$
begin
  if exists (select 1 from public.qb_question_versions where type_code in ('graphic', 'matching')) then
    raise exception 'graphic/matching question versions exist: archive/export them first';
  end if;
  if exists (select 1 from storage.objects where bucket_id = 'exam-media') then
    raise exception 'exam-media holds objects: remove them first';
  end if;
end $$;
update public.qb_question_types set enabled = false, validator = null, public_schema = '{}', key_schema = '{}', response_schema = '{}'
 where code in ('graphic', 'matching');
drop function if exists private.qb_validate_graphic(jsonb, jsonb), private.qb_validate_matching(jsonb, jsonb),
  private.qb_check_id_text_list(jsonb, text, integer, integer);
drop policy if exists p3_exam_media_select on storage.objects;
drop policy if exists p3_exam_media_insert on storage.objects;
drop policy if exists p3_exam_media_delete on storage.objects;
delete from storage.buckets where id = 'exam-media';
commit;
