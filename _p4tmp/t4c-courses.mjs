import { launch, BASE, check, summary, uiLogin, openAdmin, TMP, sleep, setVal, click, clickText } from './lib.mjs';
import path from 'node:path';

const SHOTS = path.join(TMP, 'shots');
const adm = await launch({ port: 9333 });
const tr = await launch({ port: 9334 });
const p = adm.page, t = tr.page;
const real = (pg) => pg.errors.filter((e) => !/favicon\.ico/.test(e));
const toast = () => p.eval(`(document.getElementById('ad-toast-msg')||{}).textContent||''`);
const items = (panel) => p.eval(`[].map.call(document.querySelectorAll('#cpanel-${panel} .ad-list > li h4, #cpanel-${panel} .ad-list > li .ad-qtext'),function(h){return h.textContent})`);
const confirmDialog = async (label) => { await p.waitFor(`!!document.querySelector('dialog.ad-dialog[open]')`, 5000, 'dialog open'); await clickText(p, 'dialog.ad-dialog button', label); await sleep(1500); };
const itemBtn = (panel, title, match) => p.eval(`(function(){var li=[].filter.call(document.querySelectorAll('#cpanel-${panel} .ad-list > li'),function(l){return l.textContent.indexOf(${JSON.stringify(title)})!==-1})[0]; if(!li) return 'noitem'; var b=[].filter.call(li.querySelectorAll('button'),function(x){return ((x.getAttribute('aria-label')||'')+' '+x.textContent).indexOf(${JSON.stringify(match)})!==-1 && !x.disabled})[0]; if(!b) return 'nobtn'; b.click(); return 'ok'})()`);
const traineeSees = async (tab) => {
  await t.goto(BASE + '/dashboard/#course=capm&tab=' + tab, 600);
  await t.eval('location.reload()');
  await t.waitFor(`!!document.querySelector('.pf-tabs') || !!document.querySelector('.pf-empty')`, 20000, 'trainee course view');
  await sleep(700);
  return t.eval(`(function(){return {vlinks:[].map.call(document.querySelectorAll('#cpanel-videos .pf-vlink'),function(a){return a.href})}})()`);
};
try {
  await uiLogin(t, 'a');
  await uiLogin(p, 'admin');
  await openAdmin(p, 'courses/capm/questions', 1800);
  await p.waitFor(`!!document.querySelector('#cpanel-questions')`, 15000);
  await p.eval(`document.getElementById('ctab-questions').click()`);
  await sleep(500);
  let n = (await items('questions')).length;
  while (n > 0) {
    const r = await itemBtn('questions', '', 'حذف');
    console.log('delete click:', r);
    await confirmDialog('حذف نهائي');
    const m = (await items('questions')).length;
    check('question deleted after confirmation dialog (' + n + ' -> ' + m + ')', m === n - 1, await toast());
    n = m;
  }
  check('no questions left', (await items('questions')).length === 0);

  await p.eval(`document.getElementById('ctab-videos').click()`);
  await sleep(400);
  const V = '#cpanel-videos form.ad-qform';
  await setVal(p, V + ' input[type=text]', 'فيديو معياري P4');
  await setVal(p, V + ' input[type=url]', 'https://www.youtube.com/watch?v=aaaaaaaaaaa&si=SHARE&t=10s');
  await clickText(p, V + ' button', 'إضافة الفيديو');
  await sleep(1800);
  const seen = await traineeSees('videos');
  check('stored YouTube URL is canonical (no si=/t= tracking params)', seen.vlinks.some((l) => l === 'https://www.youtube.com/watch?v=aaaaaaaaaaa'), JSON.stringify(seen.vlinks));

  /* delete every capm item via the UI (confirmation) -> storage objects must be deleted too */
  await p.eval(`document.getElementById('ctab-files').click()`);
  await sleep(300);
  for (const n2 of await items('files')) {
    await p.eval(`(function(){var e=document.getElementById('ad-toast-msg'); e.textContent=''; e.hidden=true;})()`);
    const r = await itemBtn('files', n2, 'حذف');
    await confirmDialog('حذف نهائي');
    await p.waitFor(`/حُذف|تم حذف العنصر/.test(document.getElementById('ad-toast-msg').textContent)`, 30000, 'delete toast'); const msg = await toast();
    check('deleted file item "' + n2 + '"', r === 'ok' && /تم حذف العنصر/.test(msg), r + ' / ' + msg);
  }
  await p.eval(`document.getElementById('ctab-videos').click()`);
  await sleep(300);
  for (const n2 of await items('videos')) {
    const r = await itemBtn('videos', n2, 'حذف');
    await confirmDialog('حذف نهائي');
    check('deleted video item "' + n2 + '"', r === 'ok');
  }
  check('capm has no items left in the UI', (await items('files')).length === 0 && (await items('videos')).length === 0);
  await p.shot(path.join(SHOTS, 'courses-capm-empty.png'), true);
  check('trainee browser: no console errors', real(t).length === 0, JSON.stringify(real(t)));
} catch (e) { console.log('ERR', e.message); try { await p.shot(path.join(SHOTS, 'err-adm.png')); } catch (x) { /* ignore */ } }
check('admin browser: no console errors', real(p).length === 0, JSON.stringify(real(p)));
summary();
await adm.close(); await tr.close();
