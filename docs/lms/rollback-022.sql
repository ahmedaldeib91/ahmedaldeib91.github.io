-- rollback-022: removes ONLY what 022_certificates.sql created. Destroys all issued certificates (verification links stop working).
-- GUARD: delete the next line manually after exporting what you need.
do $$ begin raise exception 'rollback-022 guard: export the certificates first, then remove this line'; end $$;
begin;
drop function if exists public.cert_issue(uuid, text, text), public.cert_revoke(uuid, text), public.cert_verify(text);
drop function if exists private.cert_issue(uuid, text, text), private.cert_revoke(uuid, text), private.cert_verify(text), private.cert_new_code();
drop table if exists public.cert_certificates;
commit;
