import { launch, BASE, check, summary, uiLogin, openAdmin, TMP, sleep } from './lib.mjs';
import fs from 'node:fs';
import path from 'node:path';

const SHOTS = path.join(TMP, 'shots');
const flag = path.join(TMP, 'go1.flag');
try { fs.rmSync(flag, { force: true }); } catch (e) { /* none */ }
const adm = await launch({ port: 9333 });
const p = adm.page;
try {
  await uiLogin(p, 'admin');
  await openAdmin(p, 'stats', 1500);
  await p.waitFor(`!document.getElementById('ad-shell').hidden && !!document.querySelector('.ad-stat')`, 20000, 'stats ready');
  console.log('READY-FOR-SQL');
  for (let i = 0; i < 240 && !fs.existsSync(flag); i++) await sleep(500);
  if (!fs.existsSync(flag)) throw new Error('flag not created');
  /* the role was changed to trainee in the DB: the UI still shows the panel until an API call reveals it */
  await p.eval(`[].filter.call(document.querySelectorAll('#ad-view button'),function(b){return b.textContent.indexOf('تحديث')!==-1})[0].click()`);
  await p.waitFor(`location.pathname==='/dashboard/'`, 20000, 'redirect to dashboard');
  check('role revoked mid-session: next admin call is forbidden, panel wipes itself and redirects to /dashboard/', true, await p.eval(`location.pathname`));
  await sleep(1500);
  check('dashboard no longer offers the admin link', await p.eval(`(function(){var a=document.getElementById('dash-admin'); return !a || a.hidden || !a.getAttribute('href')})()`));
  await p.goto(BASE + '/admin/', 3000);
  check('re-opening /admin/ as the demoted user redirects again', (await p.eval(`location.pathname`)) === '/dashboard/');
} catch (e) { console.log('ERR', e.message); try { await p.shot(path.join(SHOTS, 'err-role.png')); } catch (x) { /* ignore */ } }
summary();
await adm.close();
