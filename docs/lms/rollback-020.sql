-- rollback-020: removes ONLY what 020_assignments_discussions.sql created. Destroys assignments, submissions, grades, discussions.
-- Uploaded files stay in the storage bucket until you delete the bucket contents (Supabase dashboard > Storage > assignment-files).
-- GUARD: delete the next line manually after exporting what you need.
do $$ begin raise exception 'rollback-020 guard: export the data first, then remove this line'; end $$;
begin;
drop policy if exists p20_asg_files_select on storage.objects;
drop policy if exists p20_asg_files_insert on storage.objects;
drop policy if exists p20_asg_files_delete on storage.objects;
drop function if exists public.asg_save_submission(uuid, text, jsonb, boolean), public.asg_grade(uuid, numeric, text, boolean),
  public.dsc_list_threads(text, uuid, integer, integer), public.dsc_get_thread(uuid), public.dsc_create_thread(text, uuid, text, text),
  public.dsc_reply(uuid, text), public.dsc_delete(text, uuid), public.dsc_moderate_thread(uuid, boolean, boolean);
drop function if exists private.asg_save_submission(uuid, text, jsonb, boolean), private.asg_grade(uuid, numeric, text, boolean),
  private.dsc_list_threads(text, uuid, integer, integer), private.dsc_get_thread(uuid), private.dsc_create_thread(text, uuid, text, text),
  private.dsc_reply(uuid, text), private.dsc_delete(text, uuid), private.dsc_moderate_thread(uuid, boolean, boolean), private.dsc_can_read(text);
drop table if exists public.dsc_posts, public.dsc_threads, public.asg_files, public.asg_submissions, public.asg_assignments;
commit;
-- after emptying it: delete from storage.buckets where id = 'assignment-files';
