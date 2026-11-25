-- 004_rls_policies_grants
-- Table privileges (minimum per API role) + explicit RLS policies.
-- RLS is already ENABLED and FORCED on every table (001). Policies use (select ...) wrappers
-- so auth.uid()/is_admin() are evaluated once per statement (initplan), not per row.
-- Each (role, command) has exactly one permissive policy.

-- ================================================================ profiles
grant select on public.profiles to authenticated;
-- role / id / created_at are NOT updatable from the API at all (column privilege);
-- status is further restricted to admins by private.profiles_guard().
grant update (full_name, phone, country, last_seen_at, status) on public.profiles to authenticated;

create policy profiles_select on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or (select private.is_admin()));

create policy profiles_update on public.profiles
  for update to authenticated
  using (id = (select auth.uid()) or (select private.is_admin()))
  with check (id = (select auth.uid()) or (select private.is_admin()));
-- no INSERT / DELETE policy: profiles are created by the signup trigger and removed with auth.users.

-- ================================================================ trainer_notes (admin only)
grant select, insert, update, delete on public.trainer_notes to authenticated;

create policy trainer_notes_admin_all on public.trainer_notes
  for all to authenticated
  using ((select private.is_admin()))
  with check ((select private.is_admin()));

-- ================================================================ courses
grant select on public.courses to anon;
grant select, insert, update, delete on public.courses to authenticated;

create policy courses_select_anon on public.courses
  for select to anon
  using (published);

create policy courses_select_auth on public.courses
  for select to authenticated
  using (published or (select private.is_admin()));

create policy courses_insert_admin on public.courses
  for insert to authenticated with check ((select private.is_admin()));
create policy courses_update_admin on public.courses
  for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));
create policy courses_delete_admin on public.courses
  for delete to authenticated using ((select private.is_admin()));

-- ================================================================ course_items (never anon)
grant select, insert, update, delete on public.course_items to authenticated;

create policy course_items_select on public.course_items
  for select to authenticated
  using ((select private.is_admin()) or (published and private.has_course_access(course_id)));
create policy course_items_insert_admin on public.course_items
  for insert to authenticated with check ((select private.is_admin()));
create policy course_items_update_admin on public.course_items
  for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));
create policy course_items_delete_admin on public.course_items
  for delete to authenticated using ((select private.is_admin()));

-- ================================================================ quiz_questions (never anon)
grant select, insert, update, delete on public.quiz_questions to authenticated;

create policy quiz_questions_select on public.quiz_questions
  for select to authenticated
  using ((select private.is_admin()) or (published and private.has_course_access(course_id)));
create policy quiz_questions_insert_admin on public.quiz_questions
  for insert to authenticated with check ((select private.is_admin()));
create policy quiz_questions_update_admin on public.quiz_questions
  for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));
create policy quiz_questions_delete_admin on public.quiz_questions
  for delete to authenticated using ((select private.is_admin()));

-- ================================================================ quiz_attempts
grant select, delete on public.quiz_attempts to authenticated;
-- score/total are computed by the grading trigger; the client may only send these columns
grant insert (user_id, course_id, answers) on public.quiz_attempts to authenticated;

create policy quiz_attempts_select on public.quiz_attempts
  for select to authenticated
  using ((select private.is_admin())
         or (user_id = (select auth.uid()) and private.has_course_access(course_id)));
create policy quiz_attempts_insert_own on public.quiz_attempts
  for insert to authenticated
  with check (user_id = (select auth.uid()) and private.has_course_access(course_id));
create policy quiz_attempts_delete_admin on public.quiz_attempts
  for delete to authenticated using ((select private.is_admin()));

-- ================================================================ enrollments (admin writes)
grant select, delete on public.enrollments to authenticated;
grant insert (user_id, course_id, status) on public.enrollments to authenticated;
grant update (status) on public.enrollments to authenticated;

create policy enrollments_select on public.enrollments
  for select to authenticated
  using (user_id = (select auth.uid()) or (select private.is_admin()));
create policy enrollments_insert_admin on public.enrollments
  for insert to authenticated with check ((select private.is_admin()));
create policy enrollments_update_admin on public.enrollments
  for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));
create policy enrollments_delete_admin on public.enrollments
  for delete to authenticated using ((select private.is_admin()));

-- ================================================================ contact_messages
-- visitors: INSERT only (no SELECT => use Prefer: return=minimal from the client)
grant insert (name, email, phone, subject, message) on public.contact_messages to anon, authenticated;
grant select, delete on public.contact_messages to authenticated;
grant update (status) on public.contact_messages to authenticated;

-- the BEFORE trigger always sets status='new' and ip_hash, so this holds for every legit insert
create policy contact_messages_insert on public.contact_messages
  for insert to anon, authenticated
  with check (status = 'new' and ip_hash is not null);
create policy contact_messages_select_admin on public.contact_messages
  for select to authenticated using ((select private.is_admin()));
create policy contact_messages_update_admin on public.contact_messages
  for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));
create policy contact_messages_delete_admin on public.contact_messages
  for delete to authenticated using ((select private.is_admin()));

-- ================================================================ posts
grant select on public.posts to anon;
grant select, insert, update, delete on public.posts to authenticated;

create policy posts_select_anon on public.posts
  for select to anon using (published);
create policy posts_select_auth on public.posts
  for select to authenticated using (published or (select private.is_admin()));
create policy posts_insert_admin on public.posts
  for insert to authenticated with check ((select private.is_admin()));
create policy posts_update_admin on public.posts
  for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));
create policy posts_delete_admin on public.posts
  for delete to authenticated using ((select private.is_admin()));

-- ================================================================ site_settings
grant select, insert, update, delete on public.site_settings to authenticated;

create policy site_settings_select on public.site_settings
  for select to authenticated using (trainee_visible or (select private.is_admin()));
create policy site_settings_insert_admin on public.site_settings
  for insert to authenticated with check ((select private.is_admin()));
create policy site_settings_update_admin on public.site_settings
  for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));
create policy site_settings_delete_admin on public.site_settings
  for delete to authenticated using ((select private.is_admin()));

-- ================================================================ audit_log (read by admin, written by triggers only)
grant select on public.audit_log to authenticated;

create policy audit_log_select_admin on public.audit_log
  for select to authenticated using ((select private.is_admin()));
