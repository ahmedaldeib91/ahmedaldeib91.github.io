import { launch, BASE, check, summary, uiLogin, openAdmin, SHOTS, sleep, setVal, click, clickText, text } from './lib.mjs';
import path from 'node:path';

const A_ID = 'a4000000-0000-4000-8000-00000000000a';
const adm = await launch({ port: 9333 });
const tr = await launch({ port: 9334 });
const p = adm.page, t = tr.page;
const real = (pg) => pg.errors.filter((e) => !/favicon\.ico/.test(e));
const rows = () => p.eval(`document.querySelectorAll('#ad-view .ad-table tbody tr').length`);
const toast = () => p.eval(`(document.getElementById('ad-toast-msg')||{}).textContent||''`);
const confirmDialog = async (label) => { await p.waitFor(`!!document.querySelector('dialog.ad-dialog[open]')`, 5000, 'dialog open'); await clickText(p, 'dialog.ad-dialog button', label); await sleep(700); };
const traineeCourses = async () => { await t.goto(BASE + '/dashboard/', 1500); await t.waitFor(`!!document.querySelector('#sec-mine')`, 15000); return t.eval(`[].map.call(document.querySelectorAll('#sec-mine .pf-course h3'),function(h){return h.textContent})`); };
try {
  await uiLogin(p, 'admin');
  await openAdmin(p, 'trainees', 1000);
  await p.waitFor(`document.querySelectorAll('#ad-view .ad-table tbody tr').length>0`, 15000);
  check('trainees list shows 4 trainees', (await rows()) === 4, await rows());
  check('list shows emails (admin_user_emails works)', await p.eval(`[].some.call(document.querySelectorAll('#ad-view .ad-table small.ad-ltr'),function(s){return s.textContent==='p4-trainee-a@example.com'})`));
  await setVal(p, '#ad-view input[type=search]', 'متدرب أ');
  await sleep(500);
  check('search by Arabic name (أ) -> 1 row', (await rows()) === 1, await text(p, '#ad-view .ad-count-t'));
  await setVal(p, '#ad-view input[type=search]', 'اختبار');
  await sleep(500);
  check('search "اختبار" matches 2 names', (await rows()) === 2);
  await setVal(p, '#ad-view input[type=search]', 'P4-TRAINEE-B@EXAMPLE');
  await sleep(500);
  check('search by email (case-insensitive) -> 1 row', (await rows()) === 1);
  await setVal(p, '#ad-view input[type=search]', '+9665000000');
  await sleep(500);
  check('search by phone digits -> 3 rows', (await rows()) === 3, await rows());
  await setVal(p, '#ad-view input[type=search]', '');
  await sleep(400);
  await clickText(p, '#ad-view .ad-sort', 'المتدرب');
  await sleep(400);
  check('sort by name sets aria-sort=ascending', await p.eval(`!!document.querySelector('#ad-view th[aria-sort=ascending]')`));
  await clickText(p, '#ad-view .ad-sort', 'المتدرب');
  await sleep(400);
  check('second click sorts descending', await p.eval(`!!document.querySelector('#ad-view th[aria-sort=descending]')`));
  await setVal(p, '#ad-view select', 'suspended');
  await sleep(400);
  check('status filter suspended -> empty state', (await rows()) === 0 && (await p.eval(`!!document.querySelector('#ad-view .pf-empty')`)));
  await setVal(p, '#ad-view select', 'all');
  await sleep(400);

  /* CSV export: capture the Blob given to createObjectURL */
  await p.eval(`(function(){var o=URL.createObjectURL; window.__blobs=[]; URL.createObjectURL=function(b){window.__blobs.push(b); return o.call(URL,b)};})()`);
  await clickText(p, '#ad-view .ad-hact button', 'تصدير CSV');
  await sleep(800);
  const csv = await p.eval(`(async function(){var b=window.__blobs[window.__blobs.length-1]; if(!b) return null; var buf=new Uint8Array(await b.arrayBuffer()); return {bom: buf[0]===0xEF&&buf[1]===0xBB&&buf[2]===0xBF, text: await b.text(), type:b.type};})()`);
  check('CSV export produced a Blob', !!csv, JSON.stringify(csv && csv.type));
  if (csv) {
    check('CSV starts with UTF-8 BOM', csv.bom);
    check('CSV has Arabic header', /الاسم/.test(csv.text) && /البريد الإلكتروني/.test(csv.text));
    check('CSV neutralises =HYPERLINK formula with apostrophe', csv.text.includes(`"'=HYPERLINK(""http://evil.test"",""x"")"`), (csv.text.match(/.*HYPERLINK.*/) || [''])[0]);
    check('CSV has no cell that starts with a bare =', !/(^|,)"=/m.test(csv.text.replace(/^﻿/, '')));
    check('CSV neutralises phone starting with + (apostrophe prefix)', csv.text.includes(`"'+966500000002"`));
    check('CSV XSS name kept as inert text (quoted)', csv.text.includes('<img src=x onerror=""window.__xss=1"">'));
    console.log(csv.text.split('\r\n').slice(0, 6).join('\n'));
  }

  /* trainee A page */
  await p.eval(`location.hash='#trainees/${A_ID}'`);
  await p.waitFor(`!!document.querySelector('#ad-view .ad-kv')`, 15000, 'trainee page');
  check('trainee page shows email', await p.eval(`document.querySelector('#ad-view').textContent.indexOf('p4-trainee-a@example.com')!==-1`));
  check('trainee page has no enrollments yet', await p.eval(`!!document.querySelector('#ad-view .pf-empty')`));
  await sleep(300);
  /* add capm */
  await setVal(p, '#ad-view .ad-c-enr .ad-addenr select', 'capm');
  await clickText(p, '#ad-view .ad-c-enr .ad-addenr button', 'إضافة الاشتراك');
  await p.waitFor(`document.querySelectorAll('#ad-view .ad-c-enr .ad-table tbody tr').length===1`, 10000, 'enrollment row');
  check('enrollment added (row shows active)', await p.eval(`document.querySelector('#ad-view .ad-c-enr .ad-table tbody tr').textContent.indexOf('نشط')!==-1`), await toast());
  await uiLogin(t, 'a');
  await t.waitFor(`!!document.querySelector('#sec-mine')`, 15000);
  let courses = await t.eval(`[].map.call(document.querySelectorAll('#sec-mine .pf-course h3'),function(h){return h.textContent})`);
  check('trainee A sees CAPM in "دوراتي" right after enrollment', courses.length === 1 && /CAPM/.test(courses[0]), JSON.stringify(courses));
  /* revoke */
  await clickText(p, '#ad-view .ad-c-enr .ad-table button', 'إلغاء الاشتراك');
  await confirmDialog('إلغاء الاشتراك');
  await p.waitFor(`document.querySelector('#ad-view .ad-c-enr .ad-table tbody tr') && document.querySelector('#ad-view .ad-c-enr .ad-table tbody tr').textContent.indexOf('ملغى')!==-1`, 10000, 'revoked row');
  check('revoke -> row shows ملغى (after confirm dialog)', true, await toast());
  courses = await traineeCourses();
  check('trainee A: CAPM disappears after revoke', courses.length === 0, JSON.stringify(courses));
  await t.eval(`location.hash='#course=capm'`);
  await sleep(1200);
  check('trainee A: direct course view is locked after revoke', await t.eval(`document.getElementById('dash-view').textContent.indexOf('غير مفعّلة')!==-1`));
  /* reactivate */
  await clickText(p, '#ad-view .ad-c-enr .ad-table button', 'إعادة التفعيل');
  await p.waitFor(`document.querySelector('#ad-view .ad-c-enr .ad-table tbody tr') && document.querySelector('#ad-view .ad-c-enr .ad-table tbody tr').textContent.indexOf('نشط')!==-1`, 10000, 'reactivated');
  courses = await traineeCourses();
  check('trainee A: CAPM back after reactivation', courses.length === 1 && /CAPM/.test(courses[0]), JSON.stringify(courses));
  /* suspend */
  await clickText(p, '#ad-view .ad-hact button', 'إيقاف الحساب');
  await confirmDialog('إيقاف الحساب');
  await p.waitFor(`!!document.querySelector('#ad-view .ad-hact .ad-badge.err')`, 10000, 'suspended badge');
  check('suspend -> badge موقوف + button becomes تفعيل', await p.eval(`document.querySelector('#ad-view .ad-hact').textContent.indexOf('تفعيل الحساب')!==-1`), await toast());
  await t.goto(BASE + '/dashboard/#course=capm', 1800);
  await t.waitFor(`document.getElementById('dash-view').textContent.indexOf('حسابك موقوف')!==-1`, 20000, 'suspended notice rendered');
  check('trainee A (suspended): sees suspended notice', await t.eval(`document.getElementById('dash-view').textContent.indexOf('حسابك موقوف')!==-1`));
  check('trainee A (suspended): course content blocked', await t.eval(`!document.querySelector('.pf-list') && !document.querySelector('.pf-qlist')`));
  /* activate again */
  await clickText(p, '#ad-view .ad-hact button', 'تفعيل الحساب');
  await p.waitFor(`!document.querySelector('#ad-view .ad-hact .ad-badge.err')`, 10000, 'active again');
  check('admin re-activates the account', true);
  /* trainer notes */
  await setVal(p, '#ad-view .ad-c-notes textarea', 'ملاحظة اختبار: يفضّل التواصل مساءً. <b>نص</b>');
  await clickText(p, '#ad-view .ad-c-notes button', 'حفظ الملاحظات');
  await p.waitFor(`document.querySelector('#ad-view .pf-msg.ok')`, 10000, 'note saved');
  check('trainer note saved (message shown)', true);
  await p.eval(`location.hash='#trainees/${A_ID}'`);
  await sleep(300);
  await p.eval(`location.reload()`);
  await p.waitFor(`!!document.querySelector('#ad-view .ad-kv')`, 15000);
  check('trainer note persists after reload (text rendered inert)', await p.eval(`document.querySelector('#ad-view .ad-c-notes textarea').value==='ملاحظة اختبار: يفضّل التواصل مساءً. <b>نص</b>'`));
  /* audit */
  const audit = await p.eval(`[].map.call(document.querySelectorAll('#ad-view .ad-c-audit tbody tr'),function(r){return r.textContent.replace(/\\s+/g,' ')})`);
  check('audit log lists enrollment + status changes for this trainee', audit.length >= 5, audit.length + ' rows');
  console.log(audit.slice(0, 6).join('\n'));
  await p.shot(path.join(SHOTS, 'trainee-page.png'), true);
  console.log('trainee errors:', JSON.stringify(real(t)));
  check('trainee browser: no console errors', real(t).length === 0, JSON.stringify(real(t)));
} catch (e) { console.log('ERR', e.message); await p.shot(path.join(SHOTS, 'err-adm.png')); }
finally {
  console.log('admin errors:', JSON.stringify(real(p)));
  summary();
  await adm.close(); await tr.close();
}
