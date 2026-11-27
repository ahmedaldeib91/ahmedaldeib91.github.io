-- rollback-013: removes ONLY what 013_training_groups.sql created. Destroys every group, member, session, attendance row and score.
-- GUARD: delete the next line manually after exporting what you need.
do $$ begin raise exception 'rollback-013 guard: export the data first, then remove this line'; end $$;
begin;
drop table if exists public.grp_attendance, public.grp_assessments, public.grp_sessions, public.grp_members, public.grp_groups;
drop function if exists private.grp_touch(), private.grp_groups_before(), private.grp_members_before(), private.grp_attendance_before();
commit;
