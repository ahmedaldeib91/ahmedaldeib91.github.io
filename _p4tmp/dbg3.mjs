import { launch, BASE, uiLogin, sleep, SHOTS } from './lib.mjs';
import path from 'node:path';
const adm = await launch({ port: 9333 });
const p = adm.page;
try {
  await uiLogin(p, 'admin');
  await p.viewport(390, 800, true);
  await p.goto(BASE + '/admin/#trainees', 300);
  await p.eval('location.reload()');
  await p.waitFor(`!document.getElementById('ad-shell').hidden && document.querySelectorAll('#ad-view .ad-table tbody tr').length>0`, 25000);
  await sleep(800);
  console.log(JSON.stringify(await p.eval(`(function(){var s=document.getElementById('ad-shell'), n=document.getElementById('ad-nav'), m=s.querySelector('.ad-main'); function r(e){var b=e.getBoundingClientRect(); return [Math.round(b.left),Math.round(b.top+scrollY),Math.round(b.width),Math.round(b.height)]}; return {vw:innerWidth, grid:getComputedStyle(s).gridTemplateColumns, navPos:getComputedStyle(n).position, shell:r(s), nav:r(n), main:r(m), ul: getComputedStyle(n.querySelector('ul')).gridTemplateColumns}})()`)));
  await p.eval(`window.scrollTo(0, 400)`);
  await sleep(300);
  await p.shot(path.join(SHOTS, 'dbg3-390-view.png'), false);
} catch (e) { console.log('ERR', e.message); }
finally { await adm.close(); }
