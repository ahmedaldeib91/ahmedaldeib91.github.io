import { launch, BASE, check, summary, uiLogin, openAdmin, SHOTS, sleep, text } from './lib.mjs';
import path from 'node:path';

const b = await launch();
const p = b.page;
const real = () => p.errors.filter((e) => !/favicon\.ico/.test(e));
try {
  await uiLogin(p, 'admin');
  check('dashboard shows admin link for admin', await p.waitFor(`(function(){var a=document.getElementById('dash-admin'); return !!a && !a.hidden && a.getAttribute('href')==='/admin/'})()`, 15000));
  await openAdmin(p, 'stats', 800);
  await p.waitFor(`!document.getElementById('ad-shell').hidden`, 15000, 'shell visible');
  const sections = ['stats', 'trainees', 'enrollments', 'courses', 'messages', 'blog', 'settings'];
  for (const s of sections) {
    await p.eval(`location.hash='#${s}'`);
    await sleep(2200);
    const info = await p.eval(`(function(){var v=document.getElementById('ad-view'); var t=document.getElementById('ad-title'); return {title:t?t.textContent:null, len:v.textContent.length, loading:!!v.querySelector('.pf-loading'), fail:!!v.querySelector('.pf-fail'), cur:(document.querySelector('#ad-nav a[aria-current=page]')||{}).textContent}})()`);
    check('section ' + s + ' renders', info.title && !info.loading && !info.fail && info.len > 100, JSON.stringify(info));
    await p.shot(path.join(SHOTS, 'sec-' + s + '-1280.png'), true);
  }
  console.log('errors:', JSON.stringify(real()));
  check('no console errors', real().length === 0, JSON.stringify(real()));
} catch (e) { console.log('ERR', e.message); await p.shot(path.join(SHOTS, 'err.png')); console.log('errors:', JSON.stringify(p.errors)); }
finally { summary(); await b.close(); }
