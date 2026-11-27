-- rollback-015: undoes 015_exam_seb.sql (optional Safe Exam Browser requirement). Data-safe: no table is touched.
-- Order matters: first remove the SEB keys from saved exams (the old CHECK rejects unknown keys), then restore functions.
begin;

-- 1) strip SEB settings from drafts and from frozen published versions
update public.ex_exams set security = security - 'require_seb' - 'seb_keys' where security ? 'require_seb' or security ? 'seb_keys';
update public.ex_exam_versions set settings = jsonb_set(settings, '{security}', (settings -> 'security') - 'require_seb' - 'seb_keys')
 where settings -> 'security' ? 'require_seb' or settings -> 'security' ? 'seb_keys';

-- 2) REST wrappers back to their 014 signatures
drop function if exists public.exam_start_attempt(uuid, jsonb);
drop function if exists public.exam_get_items(uuid, integer, integer, jsonb);
create or replace function public.exam_start_attempt(p_exam_id uuid)
returns jsonb language sql volatile set search_path = '' as $$ select private.exam_start_attempt(p_exam_id); $$;
create or replace function public.exam_get_items(p_attempt_id uuid, p_from integer default 1, p_count integer default 3)
returns jsonb language sql volatile set search_path = '' as $$ select private.exam_get_items(p_attempt_id, p_from, p_count); $$;
revoke execute on function public.exam_start_attempt(uuid)                      from public, anon, authenticated;
revoke execute on function public.exam_get_items(uuid, integer, integer)       from public, anon, authenticated;
grant  execute on function public.exam_start_attempt(uuid)                      to authenticated;
grant  execute on function public.exam_get_items(uuid, integer, integer)       to authenticated;

-- 3) drop the 015 helpers
drop function if exists private.exam_get_items_guarded(uuid, integer, integer, jsonb);
drop function if exists private.exam_start_attempt_seb(uuid, jsonb);
drop function if exists private.ex_seb_guard(jsonb, jsonb);
commit;

-- 4) MANUAL: re-run the CREATE OR REPLACE blocks of these functions from the original files (they were only replaced):
--      private.ex_security_ok(jsonb)       -> supabase/migrations/011_exam_builder.sql
--      private.ex_public_settings(jsonb)   -> supabase/migrations/014_exam_attempts.sql
--      private.exam_list_available()       -> supabase/migrations/014_exam_attempts.sql (014 + 'exam_my_attempts' fix: see 014 file)
