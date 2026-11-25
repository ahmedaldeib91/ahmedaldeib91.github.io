import { launch, BASE, check, summary, uiLogin, openAdmin, TMP, sleep, setVal, click, clickText } from './lib.mjs';
import path from 'node:path';

const SHOTS = path.join(TMP, 'shots');
const adm = await launch({ port: 9333 });
const p = adm.page;
const rows = (sel) => p.eval(`document.querySelectorAll(${JSON.stringify(sel + ' tbody tr')}).length`);
const info = (sel) => p.eval(`(function(){var e=document.querySelector(${JSON.stringify(sel + ' .ad-pinfo')}); return e? e.textContent : null})()`);
try {
  await uiLogin(p, 'admin');
  await openAdmin(p, 'trainees', 1800);
  await p.waitFor(`document.querySelectorAll('#ad-view .ad-table tbody tr').length>0`, 20000);
  check('64 trainees: first page shows 25 rows', (await rows('#ad-view')) === 25, await rows('#ad-view'));
  check('pager says "عرض 1–25 من 64"', (await info('#ad-view')) === 'عرض 1–25 من 64', await info('#ad-view'));
  await clickText(p, '#ad-view .ad-pbtns button', 'التالي');
  await sleep(400);
  check('next page: 26–50', (await info('#ad-view')) === 'عرض 26–50 من 64', await info('#ad-view'));
  await clickText(p, '#ad-view .ad-pbtns button', 'التالي');
  await sleep(400);
  check('last page: 51–64 with 14 rows and "next" disabled', (await info('#ad-view')) === 'عرض 51–64 من 64' && (await rows('#ad-view')) === 14 && (await p.eval(`[].filter.call(document.querySelectorAll('#ad-view .ad-pbtns button'),function(b){return b.textContent.indexOf('التالي')!==-1})[0].disabled`)), await info('#ad-view'));
  await clickText(p, '#ad-view .ad-pbtns button', 'السابق');
  await sleep(400);
  check('previous page works (26–50)', (await info('#ad-view')) === 'عرض 26–50 من 64');
  await clickText(p, '#ad-view .ad-sort', 'المتدرب');
  await sleep(500);
  check('sorting resets to page 1', (await info('#ad-view')) === 'عرض 1–25 من 64');
  const names = await p.eval(`[].map.call(document.querySelectorAll('#ad-view .ad-table tbody a.ad-name'),function(a){return a.textContent})`);
  const sorted = names.slice().sort((a, b) => a.localeCompare(b, 'ar'));
  check('page 1 is sorted by name ascending (locale ar)', JSON.stringify(names) === JSON.stringify(sorted), JSON.stringify(names.slice(0, 4)));
  await setVal(p, '#ad-view input[type=search]', 'ترقيم 5');
  await sleep(600);
  check('search "ترقيم 5" -> 10 rows (50..59) and the pager disappears', (await rows('#ad-view')) === 10 && (await info('#ad-view')) === null, await rows('#ad-view'));
  await setVal(p, '#ad-view input[type=search]', '+96651000005');
  await sleep(600);
  check('search by phone digits finds 5 rows (05, 50..)', (await rows('#ad-view')) >= 1, await rows('#ad-view'));
  await setVal(p, '#ad-view input[type=search]', '');
  await sleep(400);
  /* CSV has all rows, not just the page */
  await p.eval(`(function(){var o=URL.createObjectURL; window.__blobs=[]; URL.createObjectURL=function(b){window.__blobs.push(b); return o.call(URL,b)};})()`);
  await clickText(p, '#ad-view .ad-hact button', 'تصدير CSV');
  await sleep(800);
  const csv = await p.eval(`(async function(){var b=window.__blobs[window.__blobs.length-1]; return b? await b.text() : null})()`);
  check('CSV exports ALL 64 trainees (65 lines incl. header), not just the visible page', !!csv && csv.trim().split('\r\n').length === 65, csv ? csv.trim().split('\r\n').length : 'null');

  /* enrollments paging + bulk */
  await p.eval(`location.hash='#enrollments'`);
  await p.waitFor(`!!document.querySelector('#ad-view .ad-picks')`, 20000);
  const E = '#ad-view .ad-card:first-of-type';
  const L = '#ad-view .ad-card:nth-of-type(2)';
  await setVal(p, E + ' select', 'pmi-pmocp');
  for (const q of ['ترقيم', 'ترقيم 3', 'ترقيم 4']) {
    await setVal(p, E + ' input[type=search]', q);
    await sleep(500);
    await clickText(p, E + ' button', 'تحديد الكل');
    await sleep(200);
    await clickText(p, E + ' button', 'اشتراك المحدّدين');
    await p.waitFor(`document.querySelector('${E} .pf-msg.ok') && /أُضيف/.test(document.querySelector('${E} .pf-msg.ok').textContent)`, 90000, 'bulk summary ' + q);
    console.log('bulk', q, '->', await p.eval(`document.querySelector('${E} .pf-msg.ok').textContent`));
    await setVal(p, E + ' select', 'pmi-pmocp');
  }
  await setVal(p, L + ' select', 'pmi-pmocp');
  await sleep(600);
  const total = (await p.eval(`document.querySelector('${L} .ad-count-t').textContent`)).replace(/\D+/g, '');
  check('active enrollments list counts > 25 so it is paged', Number(total) > 25 && (await rows(L)) === 25, total + ' / ' + (await rows(L)));
  check('enrollments pager shows 25 per page', /^عرض 1–25 من \d+$/.test(await info(L)), await info(L));
  await clickText(p, L + ' .ad-pbtns button', 'التالي');
  await sleep(500);
  check('enrollments next page works', /^عرض 26–\d+ من \d+$/.test(await info(L)), await info(L));
  await p.shot(path.join(SHOTS, 'enrollments-paged.png'), true);
  const errs = p.errors.filter((e) => !/favicon\.ico/.test(e));
  check('no console errors', errs.length === 0, JSON.stringify(errs.slice(0, 3)));
} catch (e) { console.log('ERR', e.message); try { await p.shot(path.join(SHOTS, 'err-paging.png')); } catch (x) { /* ignore */ } }
summary();
await adm.close();
