import { launch, BASE, check, summary, uiLogin, openAdmin, SHOTS, sleep } from './lib.mjs';
import path from 'node:path';

const b = await launch();
const p = b.page;
try {
  await uiLogin(p, 'admin');
  check('admin login -> /dashboard/', true);
  check('dashboard shows admin link for admin', await p.eval(`(function(){var a=document.getElementById('dash-admin'); return !!a && !a.hidden && a.getAttribute('href')==='/admin/'})()`));
  await openAdmin(p, 'stats', 2500);
  await p.waitFor(`!document.getElementById('ad-shell').hidden`, 15000, 'shell visible');
  check('admin shell visible for admin', true);
  const stats = await p.eval(`[].map.call(document.querySelectorAll('.ad-stat'),function(s){return s.querySelector('b').textContent+'='+s.querySelector('.big').textContent}).join(' | ')`);
  console.log(stats);
  await p.shot(path.join(SHOTS, 'stats-1280.png'), true);
  console.log('errors:', JSON.stringify(p.errors));
} catch (e) { console.log('ERR', e.message); await p.shot(path.join(SHOTS, 'err.png')); console.log('errors:', JSON.stringify(p.errors)); }
finally { summary(); await b.close(); }
