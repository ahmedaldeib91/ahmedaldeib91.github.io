import { launch, BASE, check, summary, uiLogin, openAdmin, TMP, sleep, setVal, click, clickText } from './lib.mjs';
import path from 'node:path';

const SHOTS = path.join(TMP, 'shots');
const adm = await launch({ port: 9333 });
const tr = await launch({ port: 9334 });
const p = adm.page, t = tr.page;
const real = (pg) => pg.errors.filter((e) => !/favicon\.ico/.test(e));
const toast = () => p.eval(`(document.getElementById('ad-toast-msg')||{}).textContent||''`);
const confirmDialog = async (label) => { await p.waitFor(`!!document.querySelector('dialog.ad-dialog[open]')`, 5000, 'dialog open'); await clickText(p, 'dialog.ad-dialog button', label); await sleep(1500); };
const badge = () => p.eval(`(function(){var b=document.getElementById('ad-badge'); return b && !b.hidden ? b.firstChild.textContent : '0'})()`);
const traineeHome = async () => { await t.goto(BASE + '/dashboard/', 600); await t.eval('location.reload()'); await t.waitFor(`!!document.querySelector('#sec-mine')`, 20000); await sleep(500); return t.eval(`[].map.call(document.querySelectorAll('#sec-mine .pf-course h3'),function(h){return h.textContent})`); };
try {
  await uiLogin(p, 'admin');
  /* ======================= الاشتراكات ======================= */
  await openAdmin(p, 'enrollments', 1500);
  await p.waitFor(`!!document.querySelector('#ad-view .ad-picks')`, 15000, 'enrollments');
  const E = '#ad-view .ad-card:first-of-type';
  check('add card lists the 4 latest trainees', (await p.eval(`document.querySelectorAll('${E} .ad-pick').length`)) === 4);
  check('submit is disabled until someone is selected', await p.eval(`[].filter.call(document.querySelectorAll('${E} button'),function(b){return b.textContent.indexOf('اشتراك المحدّدين')!==-1})[0].disabled`));
  await setVal(p, E + ' select', 'capm');
  await sleep(300);
  check('trainee already in capm (A) is disabled + badge', await p.eval(`[].some.call(document.querySelectorAll('${E} .ad-pick.dis'),function(l){return l.textContent.indexOf('متدرب أ')!==-1 && l.textContent.indexOf('مشترك في هذه الدورة')!==-1})`));
  /* reactivate B in capm (revoked row) */
  await setVal(p, E + ' input[type=search]', 'p4-trainee-b');
  await sleep(500);
  await p.eval(`document.querySelector('${E} .ad-pick input').click()`);
  await clickText(p, E + ' button', 'اشتراك المحدّدين');
  await p.waitFor(`document.querySelector('${E} .pf-msg.ok')`, 10000, 'summary');
  check('revoked enrollment is reactivated (summary says so)', (await p.eval(`document.querySelector('${E} .pf-msg.ok').textContent`)).indexOf('أُعيد تفعيل 1') !== -1, await p.eval(`document.querySelector('${E} .pf-msg.ok').textContent`));
  let home = await (async () => { await uiLogin(t, 'b'); await t.waitFor(`!!document.querySelector('#sec-mine')`, 15000); await sleep(500); return t.eval(`[].map.call(document.querySelectorAll('#sec-mine .pf-course h3'),function(h){return h.textContent})`); })();
  check('trainee B now sees CAPM + PMP', home.length === 2, JSON.stringify(home));
  /* bulk: select all latest trainees for pmi-acp */
  await setVal(p, E + ' select', 'pmi-acp');
  await setVal(p, E + ' input[type=search]', '');
  await sleep(500);
  await clickText(p, E + ' button', 'تحديد الكل');
  await sleep(300);
  check('"select all" selects the 4 trainees', (await p.eval(`document.querySelectorAll('${E} .ad-pick input:checked').length`)) === 4);
  await clickText(p, E + ' button', 'اشتراك المحدّدين');
  await p.waitFor(`(function(){var m=document.querySelector('${E} .pf-msg.ok'); return m && m.textContent.indexOf('أُضيف 4')!==-1})()`, 20000, 'bulk summary');
  check('bulk enroll: 4 trainees added in one go', true, await p.eval(`document.querySelector('${E} .pf-msg.ok').textContent`));
  check('after bulk, all 4 are disabled for pmi-acp', (await p.eval(`document.querySelectorAll('${E} .ad-pick.dis').length`)) === 4);
  const L = '#ad-view .ad-card:nth-of-type(2)';
  await setVal(p, L + ' select', 'pmi-acp');
  await sleep(500);
  check('active list filtered by course shows 4 rows', (await p.eval(`document.querySelectorAll('${L} tbody tr').length`)) === 4);
  await setVal(p, L + ' input[type=search]', 'p4-csv');
  await sleep(500);
  check('name/e-mail filter in the active list -> 1 row', (await p.eval(`document.querySelectorAll('${L} tbody tr').length`)) === 1);
  await p.eval(`[].filter.call(document.querySelectorAll('${L} tbody button'),function(b){return b.textContent.indexOf('إلغاء')!==-1})[0].click()`);
  await confirmDialog('إلغاء الاشتراك');
  await sleep(800);
  await setVal(p, L + ' input[type=search]', '');
  await sleep(500);
  check('revoke from the list (after confirm): 3 rows remain for pmi-acp', (await p.eval(`document.querySelectorAll('${L} tbody tr').length`)) === 3, await toast());
  await p.shot(path.join(SHOTS, 'enrollments-after.png'), true);

  /* ======================= الرسائل ======================= */
  await p.eval(`location.hash='#messages'`);
  await p.waitFor(`document.querySelectorAll('#ad-view .ad-msgrow').length>0`, 15000, 'messages');
  check('inbox shows 3 messages', (await p.eval(`document.querySelectorAll('#ad-view .ad-msgrow').length`)) === 3);
  check('nav badge shows 3 unread', (await badge()) === '3', await badge());
  check('filter chips show counts (all 3 / new 3)', await p.eval(`(function(){var c=[].map.call(document.querySelectorAll('#ad-view .ad-chip'),function(x){return x.textContent}); return c[0].indexOf('3')!==-1 && c[1].indexOf('3')!==-1})()`));
  /* XSS message */
  await p.eval(`[].filter.call(document.querySelectorAll('#ad-view .ad-msgrow'),function(b){return b.textContent.indexOf('xss')!==-1})[0].click()`);
  await sleep(600);
  check('XSS message: payload shown as text, no <img>/<script> elements created', await p.eval(`(function(){var d=document.querySelector('#ad-view .ad-msgdetail'); return !!d && d.textContent.indexOf('<img src=x onerror')!==-1 && !d.querySelector('img') && !d.querySelector('script') && !window.__xss})()`));
  check('selecting a message updates the URL hash (#messages/<id>)', /^#messages\/[0-9a-f-]{36}$/.test(await p.eval(`location.hash`)));
  /* normal message with phone */
  await p.eval(`[].filter.call(document.querySelectorAll('#ad-view .ad-msgrow'),function(b){return b.textContent.indexOf('زائر اختبار')!==-1})[0].click()`);
  await sleep(600);
  const links = await p.eval(`[].map.call(document.querySelectorAll('#ad-view .ad-msgdetail a'),function(a){return a.getAttribute('href')})`);
  check('reply link is mailto:<valid email>?subject=…', links.some((l) => /^mailto:visitor-p4@example\.com\?subject=/.test(l)), JSON.stringify(links));
  check('wa.me link uses digits only (966501234567)', links.some((l) => l === 'https://wa.me/966501234567'), JSON.stringify(links));
  check('wa.me link opens with rel=noopener noreferrer in a new tab', await p.eval(`(function(){var a=[].filter.call(document.querySelectorAll('#ad-view .ad-msgdetail a'),function(a){return /wa\\.me/.test(a.href)})[0]; return a.target==='_blank' && /noopener/.test(a.rel) && /noreferrer/.test(a.rel)})()`));
  await clickText(p, '#ad-view .ad-msgdetail button', 'تعليم كمقروءة');
  await sleep(1200);
  check('mark read: status becomes مقروءة and badge drops to 2', (await p.eval(`document.querySelector('#ad-view .ad-msgdetail').textContent.indexOf('مقروءة')!==-1`)) && (await badge()) === '2', await badge());
  await clickText(p, '#ad-view .ad-msgdetail button', 'أرشفة');
  await sleep(1200);
  check('archive works (button flips to إلغاء الأرشفة)', await p.eval(`[].some.call(document.querySelectorAll('#ad-view .ad-msgdetail button'),function(b){return b.textContent.indexOf('إلغاء الأرشفة')!==-1})`));
  await clickText(p, '#ad-view .ad-chip', 'مؤرشفة');
  await sleep(500);
  check('archived filter lists exactly the archived one', (await p.eval(`document.querySelectorAll('#ad-view .ad-msgrow').length`)) === 1);
  await clickText(p, '#ad-view .ad-chip', 'الكل');
  await setVal(p, '#ad-view input[type=search]', 'استفسار');
  await sleep(500);
  check('search in messages -> 1 result', (await p.eval(`document.querySelectorAll('#ad-view .ad-msgrow').length`)) === 1);
  await setVal(p, '#ad-view input[type=search]', '');
  await sleep(400);
  /* third message: local phone (leading single zero) -> no wa.me link */
  await p.eval(`[].filter.call(document.querySelectorAll('#ad-view .ad-msgrow'),function(b){return b.textContent.indexOf('زائر ثالث')!==-1})[0].click()`);
  await sleep(500);
  check('local phone number (0501234567) does NOT produce a wa.me link', await p.eval(`![].some.call(document.querySelectorAll('#ad-view .ad-msgdetail a'),function(a){return /wa\\.me/.test(a.href)})`));
  await p.shot(path.join(SHOTS, 'messages-detail.png'), true);
  /* delete third with confirmation */
  await clickText(p, '#ad-view .ad-msgdetail button', 'حذف');
  await confirmDialog('حذف نهائي');
  await sleep(500);
  check('delete message (after confirm): 2 remain', (await p.eval(`document.querySelectorAll('#ad-view .ad-msgrow').length`)) === 2, await toast());
  check('trainee browser: no console errors', real(t).length === 0, JSON.stringify(real(t)));
} catch (e) { console.log('ERR', e.message); try { await p.shot(path.join(SHOTS, 'err-adm.png')); } catch (x) { /* ignore */ } }
check('admin browser: no console errors', real(p).length === 0, JSON.stringify(real(p)));
summary();
await adm.close(); await tr.close();
