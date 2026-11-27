-- rollback-M3a.sql  --  undo migration 011_exam_builder (exams milestone M3a, exam builder DB side).
--
-- DESTRUCTIVE for M3a data only: deletes every exam, item, rule, published version, frozen pool and
-- per-course exam setting. It does NOT touch any object of 001..010 (no trigger or column was added to them;
-- 011 only created FKs pointing INTO them, which go away with the dropped tables).
-- audit_log rows written by M3a triggers are kept (history).
-- Must run BEFORE rollback-M1.sql if both are ever needed (011 depends on 009/010).
--
-- HOW TO RUN (owner decision only):
--   1. take a backup first (pg_dump via Supabase CLI; Free plan has no automatic backups);
--   2. delete the GUARD line below;
--   3. run the whole file in the SQL editor (one transaction; any error => nothing is changed).
-- Verified on PGlite: after this script the catalog (tables, columns, constraints, indexes, policies,
-- triggers, functions, grants) is identical to the state right after 010.

do $$ begin raise exception 'GUARD: rollback-M3a.sql is disabled. Remove this line on purpose to run it.'; end $$;

begin;

drop function if exists public.exam_save(jsonb);
drop function if exists public.exam_preview_pool(jsonb);
drop function if exists public.exam_publish(uuid);
drop function if exists public.exam_request_approval(uuid, text);
drop function if exists public.exam_withdraw(uuid);
drop function if exists public.exam_approve(uuid, text);
drop function if exists public.exam_reject(uuid, text);
drop function if exists public.exam_pause(uuid, text);
drop function if exists public.exam_resume(uuid);
drop function if exists public.exam_unpublish(uuid, text);
drop function if exists public.exam_archive(uuid);
drop function if exists public.exam_unarchive(uuid);

drop function if exists private.ex_transition(uuid, text, text);
drop function if exists private.exam_preview_pool(jsonb);
drop function if exists private.exam_save(jsonb);
drop function if exists private.ex_freeze(uuid, uuid);
drop function if exists private.ex_raise_invalid(jsonb);
drop function if exists private.ex_collect_errors(uuid);
drop function if exists private.ex_compute_totals(uuid);
drop function if exists private.ex_rules_json(uuid);
drop function if exists private.ex_pool(text, uuid, jsonb, uuid[]);
drop function if exists private.ex_normalize_rules(text, jsonb);
drop function if exists private.ex_uuid(text, text);

alter table if exists public.ex_exams drop constraint if exists ex_exams_published_version_fkey;
drop table if exists public.ex_exam_version_pool;
drop table if exists public.ex_exam_version_rules;
drop table if exists public.ex_exam_version_items;
drop table if exists public.ex_exam_versions;
drop table if exists public.ex_exam_rules;
drop table if exists public.ex_exam_items;
drop table if exists public.ex_exams;            -- its CHECK uses private.ex_security_ok: drop the table first
drop table if exists public.ex_course_settings;

drop function if exists private.audit_ex_course_settings();
drop function if exists private.audit_ex_exams();
drop function if exists private.ex_immutable();
drop function if exists private.ex_composition_guard();
drop function if exists private.ex_exams_before();
drop function if exists private.ex_workflow_columns();
drop function if exists private.ex_course_settings_before();
drop function if exists private.ex_can_publish_direct(text);
drop function if exists private.ex_publish_requires_approval(text);
drop function if exists private.ex_can_read(text);
drop function if exists private.ex_security_ok(jsonb);

-- if the migration was recorded by the Supabase CLI / MCP, also remove its history row:
-- delete from supabase_migrations.schema_migrations where name = '011_exam_builder';

commit;
