-- rollback-021: removes ONLY what 021_notifications.sql created. Destroys all notifications (they are derived data; nothing else depends on them).
-- GUARD: delete the next line manually after you decide to proceed.
do $$ begin raise exception 'rollback-021 guard: remove this line to proceed'; end $$;
begin;
drop trigger if exists ntf_asg_submission_status on public.asg_submissions;
drop trigger if exists ntf_attempt_graded on public.ex_attempts;
drop trigger if exists ntf_post_reply on public.dsc_posts;
drop trigger if exists ntf_assignment_published on public.asg_assignments;
drop function if exists public.ntf_list(integer), public.ntf_mark_read(uuid[]), public.ntf_mark_all_read(), public.ntf_broadcast(text, text, text);
drop function if exists private.ntf_list(integer), private.ntf_mark_read(uuid[]), private.ntf_mark_all_read(), private.ntf_broadcast(text, text, text),
  private.ntf_on_submission(), private.ntf_on_attempt(), private.ntf_on_post(), private.ntf_on_assignment();
drop table if exists public.ntf_notifications;
commit;
