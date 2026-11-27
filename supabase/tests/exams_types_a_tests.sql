-- exams_types_a_tests.sql — validators of 012 (graphic + matching), registry, bucket, policies, grants.
-- Run as postgres on a project with 009+010+012 applied. Raises (and prints FAIL notices) on any failure.
do $t$
declare
  v_pass int := 0; v_fail int := 0;
  m uuid := '11111111-1111-4111-8111-111111111111';
  gp jsonb := '{"stem":{"text":"s"},"left":[{"id":"l1","text":"a"},{"id":"l2","text":"b"}],"right":[{"id":"r1","text":"x"},{"id":"r2","text":"y"},{"id":"r3","text":"z"}]}';
  c record;
begin
  begin perform private.qb_validate('matching', gp, '{"pairs":{"l1":"r1","l2":"r2"},"scoring":"partial"}'); v_pass := v_pass + 1;
  exception when others then v_fail := v_fail + 1; raise notice 'FAIL matching good: %', sqlerrm; end;
  for c in select * from (values
    ('missing pair', gp, '{"pairs":{"l1":"r1"}}'::jsonb), ('unknown left', gp, '{"pairs":{"l1":"r1","zz":"r2"}}'),
    ('unknown right', gp, '{"pairs":{"l1":"r1","l2":"zz"}}'), ('duplicate right', gp, '{"pairs":{"l1":"r1","l2":"r1"}}'),
    ('bad scoring', gp, '{"pairs":{"l1":"r1","l2":"r2"},"scoring":"x"}'), ('pairs not object', gp, '{"pairs":["l1"]}'),
    ('extra key field', gp, '{"pairs":{"l1":"r1","l2":"r2"},"x":1}'),
    ('answer leak', gp || '{"answer":"x"}', '{"pairs":{"l1":"r1","l2":"r2"}}')) as x(name, pl, ky) loop
    begin perform private.qb_validate('matching', c.pl, c.ky); v_fail := v_fail + 1; raise notice 'FAIL accepted bad matching: %', c.name;
    exception when sqlstate '22023' then v_pass := v_pass + 1; end;
  end loop;
  begin perform private.qb_validate('graphic', jsonb_build_object('stem', jsonb_build_object('text','s'), 'media', jsonb_build_array(m),
          'options', '[{"id":"a","text":"x"},{"id":"b","text":"y"}]'::jsonb), '{"correct":"a"}'); v_pass := v_pass + 1;
  exception when others then v_fail := v_fail + 1; raise notice 'FAIL graphic good: %', sqlerrm; end;
  for c in select * from (values
    ('no media', '{"stem":{"text":"s"},"options":[{"id":"a","text":"x"},{"id":"b","text":"y"}]}'::jsonb, '{"correct":"a"}'::jsonb),
    ('empty media', '{"stem":{"text":"s"},"media":[],"options":[{"id":"a","text":"x"},{"id":"b","text":"y"}]}', '{"correct":"a"}'),
    ('bad media id', '{"stem":{"text":"s"},"media":["nope"],"options":[{"id":"a","text":"x"},{"id":"b","text":"y"}]}', '{"correct":"a"}'),
    ('bad correct', '{"stem":{"text":"s"},"media":["11111111-1111-4111-8111-111111111111"],"options":[{"id":"a","text":"x"},{"id":"b","text":"y"}]}', '{"correct":"z"}')) as x(name, pl, ky) loop
    begin perform private.qb_validate('graphic', c.pl, c.ky); v_fail := v_fail + 1; raise notice 'FAIL accepted bad graphic: %', c.name;
    exception when sqlstate '22023' then v_pass := v_pass + 1; end;
  end loop;
  if (select count(*) from public.qb_question_types where code in ('graphic','matching') and enabled and validator is not null) = 2 then v_pass := v_pass + 1; else v_fail := v_fail + 1; raise notice 'FAIL registry'; end if;
  if (select count(*) from storage.buckets where id='exam-media' and not public and file_size_limit=10485760) = 1 then v_pass := v_pass + 1; else v_fail := v_fail + 1; raise notice 'FAIL bucket'; end if;
  if (select count(*) from pg_policies where schemaname='storage' and tablename='objects' and policyname like 'p3_exam_media_%') = 3 then v_pass := v_pass + 1; else v_fail := v_fail + 1; raise notice 'FAIL policies'; end if;
  if not exists (select 1 from information_schema.routine_privileges where routine_schema='private'
                 and routine_name in ('qb_validate_graphic','qb_validate_matching','qb_check_id_text_list') and grantee in ('anon','authenticated','PUBLIC')) then v_pass := v_pass + 1; else v_fail := v_fail + 1; raise notice 'FAIL grants'; end if;
  raise notice 'RESULT pass=% fail=%', v_pass, v_fail;
  if v_fail > 0 then raise exception 'tests failed: %', v_fail; end if;
end
$t$;
