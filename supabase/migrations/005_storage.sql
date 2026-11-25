-- 005_storage
-- Buckets + storage.objects policies.
--   course-files : PRIVATE. Object path must be "<course_id>/<file>". Read: admin, or a trainee
--                  with has_course_access(<course_id>). Write: admin only. Downloads use
--                  short-lived signed URLs created by the signed-in user.
--   blog-media   : PUBLIC bucket (files served by public URL without RLS). Listing/write: admin only.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('course-files', 'course-files', false, 52428800, array[
     'application/pdf',
     'application/zip',
     'application/x-zip-compressed',
     'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
     'application/vnd.openxmlformats-officedocument.presentationml.presentation',
     'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
     'image/png',
     'image/jpeg'
  ]),
  ('blog-media', 'blog-media', true, 52428800, array[
     'image/png',
     'image/jpeg',
     'image/webp',
     'image/gif',
     'video/mp4',
     'video/webm'
  ])
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- one permissive policy per command, all scoped to authenticated (anon gets nothing)
create policy p2_objects_select on storage.objects
  for select to authenticated
  using (
    (bucket_id = 'course-files'
       and ((select private.is_admin())
            or private.has_course_access((storage.foldername(name))[1])))
    or (bucket_id = 'blog-media' and (select private.is_admin()))
  );

create policy p2_objects_insert_admin on storage.objects
  for insert to authenticated
  with check (bucket_id in ('course-files', 'blog-media') and (select private.is_admin()));

create policy p2_objects_update_admin on storage.objects
  for update to authenticated
  using (bucket_id in ('course-files', 'blog-media') and (select private.is_admin()))
  with check (bucket_id in ('course-files', 'blog-media') and (select private.is_admin()));

create policy p2_objects_delete_admin on storage.objects
  for delete to authenticated
  using (bucket_id in ('course-files', 'blog-media') and (select private.is_admin()));
