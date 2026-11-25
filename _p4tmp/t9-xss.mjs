import { launch, BASE, check, summary, uiLogin, openAdmin, TMP, sleep, setVal, click, clickText } from './lib.mjs';
import path from 'node:path';

const SHOTS = path.join(TMP, 'shots');
const adm = await launch({ port: 9333 });
const tr = await launch({ port: 9334 });
const p = adm.page, t = tr.page;
const real = (pg) => pg.errors.filter((e) => !/favicon\.ico/.test(e));
const PAY1 = '<img src=x onerror="window.__xss=11">';
const PAY2 = '<svg onload=window.__xss=12></svg><script>window.__xss=13</script>';
const inert = (pg, scope) => pg.eval(`(function(){var r=document.querySelector(${JSON.stringify(scope)}); return !!r && !r.querySelector('img[src="x"]') && !r.querySelector('svg[onload]') && !r.querySelector('script') && document.querySelectorAll('[onerror],[onload]').length===0 && !window.__xss})()`);
try {
  await uiLogin(t, 'a');
  await uiLogin(p, 'admin');
  await openAdmin(p, 'courses/capm/videos', 1800);
  await p.waitFor(`!!document.querySelector('#cpanel-videos form.ad-qform')`, 15000);
  await click(p, '#ctab-videos');
  const V = '#cpanel-videos form.ad-qform';
  await setVal(p, V + ' input[type=text]', PAY1);
  await setVal(p, V + ' input[type=url]', 'https://example.com/xss-video');
  await clickText(p, V + ' button', 'إضافة الفيديو');
  await p.waitFor(`document.querySelectorAll('#cpanel-videos .ad-list > li').length===1`, 15000);
  check('admin: XSS video title is shown as text (no element created)', (await inert(p, '#cpanel-videos')) && (await p.eval(`document.querySelector('#cpanel-videos .ad-list h4').textContent`)) === PAY1);
  /* question with payloads in text, option and explanation */
  await click(p, '#ctab-questions');
  await clickText(p, '#cpanel-questions button', 'إضافة سؤال');
  await sleep(300);
  const QF = '#cpanel-questions form.ad-qform';
  await setVal(p, QF + ' textarea', PAY1 + ' ما هو؟');
  await p.eval(`(function(){var inp=document.querySelectorAll(${JSON.stringify(QF + ' .ad-optrow input[type=text]')}); function s(i,v){i.value=v;i.dispatchEvent(new Event('input',{bubbles:true}));} s(inp[0], ${JSON.stringify(PAY2)}); s(inp[1],'خيار عادي'); var ta=document.querySelectorAll(${JSON.stringify(QF + ' textarea')}); ta[1].value=${JSON.stringify(PAY1)}; ta[1].dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await clickText(p, QF + ' button', 'إضافة السؤال');
  await p.waitFor(`document.querySelectorAll('#cpanel-questions .ad-list > li').length===1`, 15000);
  check('admin: XSS question/option/explanation are inert text', await inert(p, '#cpanel-questions'));
  await clickText(p, '#cpanel-questions button', 'معاينة كمتدرب');
  await sleep(500);
  check('admin: "preview as trainee" renders the payload inert too', await inert(p, '#cpanel-questions .ad-qprev'));
  /* trainee A view (capm) */
  await t.goto(BASE + '/dashboard/#course=capm&tab=videos', 600);
  await t.eval('location.reload()');
  await t.waitFor(`!!document.querySelector('.pf-tabs')`, 20000);
  await sleep(800);
  check('trainee: XSS video title inert in the course view', await inert(t, '#cpanel-videos'));
  await t.eval(`document.getElementById('ctab-quiz').click()`);
  await sleep(400);
  check('trainee: XSS question + option inert in the quiz tab', await inert(t, '#cpanel-quiz'));
  /* trainee name payloads in lists (fixture D) */
  await p.eval(`location.hash='#trainees'`);
  await sleep(1800);
  check('admin: trainee with HTML/XSS name is inert in the list', await inert(p, '#ad-view'));
  await p.eval(`[].filter.call(document.querySelectorAll('#ad-view .ad-table a.ad-name'),function(a){return a.textContent.indexOf('<img')!==-1})[0].click()`);
  await p.waitFor(`!!document.querySelector('#ad-view .ad-kv')`, 15000);
  check('admin: trainee page (name, country HTML) is inert', (await inert(p, '#ad-view')) && (await p.eval(`document.getElementById('ad-title').textContent.indexOf('<img')!==-1`)));
  await p.eval(`location.hash='#enrollments'`);
  await sleep(1800);
  check('admin: enrollments picker lists the XSS-named trainee as text', await inert(p, '#ad-view'));
  /* trainer note with payload round-trips as text */
  await p.eval(`location.hash='#trainees/a4000000-0000-4000-8000-00000000000d'`);
  await p.waitFor(`!!document.querySelector('#ad-view .ad-c-notes textarea')`, 15000);
  await setVal(p, '#ad-view .ad-c-notes textarea', PAY1 + PAY2);
  await clickText(p, '#ad-view .ad-c-notes button', 'حفظ الملاحظات');
  await p.waitFor(`document.querySelector('#ad-view .ad-c-notes .pf-msg.ok')`, 10000);
  await sleep(500);
  check('admin: trainer note with payload stays inert after save', await inert(p, '#ad-view'));
  console.log('admin errors:', JSON.stringify(real(p)), 'trainee errors:', JSON.stringify(real(t)));
  check('no console errors in both browsers', real(p).length === 0 && real(t).length === 0);
} catch (e) { console.log('ERR', e.message); try { await p.shot(path.join(SHOTS, 'err-xss.png')); } catch (x) { /* ignore */ } }
summary();
await adm.close(); await tr.close();
