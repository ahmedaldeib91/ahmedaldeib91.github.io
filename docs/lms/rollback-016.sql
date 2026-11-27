-- rollback-016: removes ONLY what 016_lms_lessons.sql created. Destroys modules, lessons and trainee progress.
-- course_items (videos/files) are untouched. GUARD: delete the next line manually after exporting what you need.
do $$ begin raise exception 'rollback-016 guard: export the data first, then remove this line'; end $$;
begin;
drop function if exists public.lms_save_progress(uuid, integer, boolean);
drop function if exists private.lms_save_progress(uuid, integer, boolean);
drop table if exists public.lms_progress, public.lms_lesson_files, public.lms_lessons, public.lms_modules;
drop function if exists private.lms_lessons_before(), private.lms_lesson_files_before();
commit;
