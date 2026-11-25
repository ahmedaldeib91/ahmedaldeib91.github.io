-- rollback-M1.sql  --  undo migrations 010_question_bank + 009_exams_foundation (exams milestone M1).
--
-- DESTRUCTIVE for M1 data only: deletes every question, version, key, taxonomy node, tag, set, media
-- metadata row, staff assignment, folder and security event created by the exams system.
-- It does NOT touch any object of 001..008 except removing the trigger that 009 added to public.courses.
-- audit_log rows written by M1 triggers are kept (history).
--
-- HOW TO RUN (owner decision only):
--   1. take a backup first (pg_dump via Supabase CLI; Free plan has no automatic backups);
--   2. delete the GUARD line below;
--   3. run the whole file in the SQL editor (one transaction; any error => nothing is changed).
-- Verified on PGlite: after this script the catalog (tables, columns, constraints, indexes, policies,
-- triggers, functions, grants) is identical to the state right after 008.

do $$ begin raise exception 'GUARD: rollback-M1.sql is disabled. Remove this line on purpose to run it.'; end $$;

begin;

-- ---------------------------------------------------------------- 010_question_bank
drop function if exists public.qb_save_question(jsonb);
drop function if exists private.qb_save_question(jsonb);

drop table if exists public.qb_question_tags;
drop table if exists public.qb_question_keys;
drop table if exists public.qb_media;
alter table if exists public.qb_questions drop constraint if exists qb_questions_current_version_fkey;
alter table if exists public.qb_sets      drop constraint if exists qb_sets_current_version_fkey;
drop table if exists public.qb_question_versions;
drop table if exists public.qb_questions;
drop table if exists public.qb_set_versions;
drop table if exists public.qb_sets;
drop table if exists public.qb_tags;
drop table if exists public.qb_taxonomy;
drop table if exists public.qb_question_types;

drop function if exists private.audit_qb_questions();
drop function if exists private.qb_set_versions_after();
drop function if exists private.qb_set_versions_before();
drop function if exists private.qb_parent_before();
drop function if exists private.qb_taxonomy_before();
drop function if exists private.qb_immutable();
drop function if exists private.qb_content_hash(jsonb);
drop function if exists private.qb_normalize_text(text);
drop function if exists private.qb_validate(text, jsonb, jsonb);
drop function if exists private.qb_question_types_before();   -- its trigger went with qb_question_types
drop function if exists private.qb_validate_true_false(jsonb, jsonb);
drop function if exists private.qb_validate_multi_response(jsonb, jsonb);
drop function if exists private.qb_validate_mcq_single(jsonb, jsonb);
drop function if exists private.qb_check_options(jsonb, integer, integer);
drop function if exists private.qb_check_public_payload(jsonb, text[]);
drop function if exists private.qb_check_keys(jsonb, text[], text);

-- ---------------------------------------------------------------- 009_exams_foundation
drop trigger if exists courses_create_folders on public.courses;
drop table if exists public.ex_security_events;
drop table if exists public.course_folders;
drop table if exists public.course_staff;
drop table if exists private.rl_counters;

drop function if exists private.log_security_event(text, text, text, jsonb, uuid, timestamptz);
drop function if exists private.rl_prune(interval);
drop function if exists private.rl_hit(text, integer, integer, boolean);
drop function if exists private.courses_create_folders();
drop function if exists private.ensure_course_folders(text);
drop function if exists private.course_folder_kinds();
drop function if exists private.audit_course_staff();
drop function if exists private.course_staff_before();
drop function if exists private.is_any_course_staff();
drop function if exists private.has_staff_perm(text, text);
drop function if exists private.is_course_staff(text);
drop function if exists private.staff_permission_keys();

-- if the migrations were recorded by the Supabase CLI / MCP, also remove their history rows, e.g.:
-- delete from supabase_migrations.schema_migrations where name in ('009_exams_foundation', '010_question_bank');

commit;
