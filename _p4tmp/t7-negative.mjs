import { launch, BASE, check, summary, uiLogin, openAdmin, TMP, sleep, creds } from './lib.mjs';
import path from 'node:path';

const SHOTS = path.join(TMP, 'shots');
const tr = await launch({ port: 9334 });
const t = tr.page;
const real = (pg) => pg.errors.filter((e) => !/favicon\.ico|Failed to load resource: the server responded with a status of (401|403|404|409)/.test(e));
const A_ID = 'a4000000-0000-4000-8000-00000000000a';
try {
  /* ============ 1) unauthenticated visitor on /admin/ ============ */
  await t.goto(BASE + '/admin/', 2500);
  check('visitor without session is redirected from /admin/ to /account/', await t.eval(`location.pathname`) === '/account/', await t.eval(`location.pathname`));
  check('admin shell never shown to the visitor', await t.eval(`document.getElementById('ad-shell')===null || document.getElementById('ad-shell').hidden`));

  /* ============ 2) trainee on /admin/ ============ */
  await uiLogin(t, 'a');
  t.requests.length = 0;
  await t.goto(BASE + '/admin/', 3000);
  check('trainee opening /admin/ is redirected to /dashboard/', await t.eval(`location.pathname`) === '/dashboard/', await t.eval(`location.pathname`));
  const adminOnly = t.requests.filter((r) => /contact_messages|admin_stats|admin_user_emails|audit_log|trainer_notes|rpc\//.test(r.url));
  check('trainee page made NO admin-only API request before the redirect', adminOnly.length === 0, JSON.stringify(adminOnly.map((r) => r.url.slice(-60))));
  const shellState = await (async () => { await t.goto(BASE + '/admin/', 200); return t.eval(`(function(){var s=document.getElementById('ad-shell'); return s? s.hidden : 'noshell'})()`); })();
  check('admin shell stays hidden while the role is being checked', shellState === true || shellState === 'noshell', String(shellState));
  await t.goto(BASE + '/dashboard/', 1500);
  check('trainee dashboard has NO link to /admin/', await t.eval(`(function(){var a=document.getElementById('dash-admin'); return !a || a.hidden || !a.getAttribute('href')})()`));

  /* ============ 3) direct REST attempts with the trainee token ============ */
  const api = (method, p, body, headers) => t.eval(`(async function(){
    var s=JSON.parse(localStorage.getItem('plat_session'));
    var el=document.querySelector('[data-sb-url]'); var base=el.getAttribute('data-sb-url'); var key=el.getAttribute('data-sb-key');
    var h={apikey:key, Authorization:'Bearer '+s.access_token};
    var extra=${JSON.stringify(headers || {})}; Object.keys(extra).forEach(function(k){h[k]=extra[k]});
    var opt={method:${JSON.stringify(method)}, headers:h};
    var body=${JSON.stringify(body === undefined ? null : body)};
    if(body!==null){ h['Content-Type']=h['Content-Type']||'application/json'; opt.body = typeof body==='string'? body : JSON.stringify(body); }
    var r=await fetch(base+${JSON.stringify(p)}, opt); var txt=await r.text(); var j=null; try{j=JSON.parse(txt)}catch(e){}
    return {status:r.status, code:j&&(j.code||j.statusCode||j.error)||null, rows:Array.isArray(j)?j.length:null, msg: j&&(j.message||'')};
  })()`);
  let r = await api('POST', '/rest/v1/enrollments', { user_id: A_ID, course_id: 'pmi-cp', status: 'active' }, { Prefer: 'return=representation' });
  check('trainee CANNOT enroll himself (POST enrollments)', r.status === 403 || r.status === 401, JSON.stringify(r));
  r = await api('POST', '/rest/v1/posts', { title: 'x', slug: 'p4-evil', body: 'x' }, { Prefer: 'return=representation' });
  check('trainee CANNOT write posts', r.status === 403 || r.status === 401, JSON.stringify(r));
  r = await api('GET', '/rest/v1/contact_messages?select=id,name,email,message', undefined);
  check('trainee reading contact_messages gets NO rows (RLS: 200 + [])', (r.status === 200 && r.rows === 0) || r.status === 401 || r.status === 403, JSON.stringify(r));
  r = await api('POST', '/rest/v1/rpc/admin_stats', {});
  check('trainee calling admin_stats gets 403 forbidden', r.status === 403 || r.status === 401, JSON.stringify(r));
  r = await api('POST', '/rest/v1/rpc/admin_user_emails', {});
  check('trainee calling admin_user_emails gets 403 forbidden', r.status === 403 || r.status === 401, JSON.stringify(r));
  r = await api('GET', '/rest/v1/audit_log?select=id', undefined);
  check('trainee reading audit_log gets NO rows', (r.status === 200 && r.rows === 0) || r.status === 403 || r.status === 401, JSON.stringify(r));
  r = await api('GET', '/rest/v1/trainer_notes?select=*', undefined);
  check('trainee reading trainer_notes gets NO rows', (r.status === 200 && r.rows === 0) || r.status === 403 || r.status === 401, JSON.stringify(r));
  r = await api('POST', '/rest/v1/trainer_notes', { user_id: A_ID, notes: 'self-note' }, { Prefer: 'return=representation' });
  check('trainee CANNOT write trainer_notes', r.status === 403 || r.status === 401, JSON.stringify(r));
  r = await api('PATCH', '/rest/v1/profiles?id=eq.' + A_ID, { role: 'admin' }, { Prefer: 'return=representation' });
  check('trainee CANNOT promote himself (PATCH profiles.role)', r.status === 403 || r.status === 401, JSON.stringify(r));
  r = await api('PATCH', '/rest/v1/profiles?id=eq.' + A_ID, { status: 'suspended' }, { Prefer: 'return=representation' });
  check('trainee CANNOT change his own status', r.status === 403 || r.status === 401, JSON.stringify(r));
  r = await api('PATCH', '/rest/v1/courses?id=eq.capm', { published: false }, { Prefer: 'return=representation' });
  check('trainee CANNOT edit courses (0 rows / forbidden)', (r.status === 200 && r.rows === 0) || r.status === 403 || r.status === 401, JSON.stringify(r));
  r = await api('POST', '/rest/v1/course_items', { course_id: 'capm', kind: 'video', title: 'x', url: 'https://example.com/x' }, { Prefer: 'return=representation' });
  check('trainee CANNOT add course items', r.status === 403 || r.status === 401, JSON.stringify(r));
  r = await api('POST', '/rest/v1/quiz_questions', { course_id: 'capm', question: 'x', options: ['a', 'b'], correct_index: 0 }, { Prefer: 'return=representation' });
  check('trainee CANNOT add quiz questions', r.status === 403 || r.status === 401, JSON.stringify(r));
  r = await api('POST', '/rest/v1/site_settings', { key: 'evil', value: {} }, { Prefer: 'return=representation' });
  check('trainee CANNOT write site_settings', r.status === 403 || r.status === 401, JSON.stringify(r));
  r = await api('DELETE', '/rest/v1/enrollments?user_id=eq.' + A_ID, undefined, { Prefer: 'return=representation' });
  check('trainee CANNOT delete enrollments (0 rows / forbidden)', (r.status === 200 && r.rows === 0) || r.status === 403 || r.status === 401, JSON.stringify(r));
  r = await api('POST', '/storage/v1/object/course-files/capm/evil.pdf', 'x', { 'Content-Type': 'application/pdf' });
  check('trainee CANNOT upload to course-files', r.status === 403 || r.status === 401 || r.status === 400, JSON.stringify(r));
  r = await api('POST', '/storage/v1/object/blog-media/posts/evil.png', 'x', { 'Content-Type': 'image/png' });
  check('trainee CANNOT upload to blog-media', r.status === 403 || r.status === 401 || r.status === 400, JSON.stringify(r));
  r = await api('GET', '/rest/v1/profiles?select=id,full_name&id=neq.' + A_ID, undefined);
  check('trainee sees no other profile (RLS)', r.status === 200 && r.rows === 0, JSON.stringify(r));
  /* anonymous (publishable key only) */
  const anon = (method, p, body, headers) => t.eval(`(async function(){
    var el=document.querySelector('[data-sb-url]'); var base=el.getAttribute('data-sb-url'); var key=el.getAttribute('data-sb-key');
    var h={apikey:key}; var extra=${JSON.stringify(headers || {})}; Object.keys(extra).forEach(function(k){h[k]=extra[k]});
    var opt={method:${JSON.stringify(method)}, headers:h}; var body=${JSON.stringify(body === undefined ? null : body)};
    if(body!==null){ h['Content-Type']='application/json'; opt.body=JSON.stringify(body); }
    var r=await fetch(base+${JSON.stringify(p)}, opt); var txt=await r.text(); var j=null; try{j=JSON.parse(txt)}catch(e){}
    return {status:r.status, rows:Array.isArray(j)?j.length:null, code:j&&j.code||null};
  })()`);
  r = await anon('GET', '/rest/v1/contact_messages?select=id');
  check('anon reading contact_messages is refused (401/403)', r.status === 401 || r.status === 403, JSON.stringify(r));
  r = await anon('POST', '/rest/v1/rpc/admin_stats', {});
  check('anon calling admin_stats is refused (401/403)', r.status === 401 || r.status === 403, JSON.stringify(r));
  r = await anon('POST', '/rest/v1/rpc/admin_user_emails', {});
  check('anon calling admin_user_emails is refused (401/403)', r.status === 401 || r.status === 403, JSON.stringify(r));
  r = await anon('GET', '/rest/v1/profiles?select=id');
  check('anon reading profiles is refused (401/403)', r.status === 401 || r.status === 403, JSON.stringify(r));
  r = await anon('POST', '/rest/v1/enrollments', { user_id: A_ID, course_id: 'pmi-cp' });
  check('anon cannot enroll anyone', r.status === 401 || r.status === 403, JSON.stringify(r));
  check('trainee browser: no unexpected console errors', real(t).length === 0, JSON.stringify(real(t)));
} catch (e) { console.log('ERR', e.message); try { await t.shot(path.join(SHOTS, 'err-neg.png')); } catch (x) { /* ignore */ } }
summary();
await tr.close();
