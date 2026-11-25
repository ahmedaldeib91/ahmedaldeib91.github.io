import { launch, BASE, check, summary, uiLogin, openAdmin, TMP, sleep, setVal, click, clickText, text } from './lib.mjs';
import path from 'node:path';

const SHOTS = path.join(TMP, 'shots');
const F = (n) => path.join(TMP, 'files', n).replace(/\\/g, '/');
const adm = await launch({ port: 9333 });
const tr = await launch({ port: 9334 });
const p = adm.page, t = tr.page;
const real = (pg) => pg.errors.filter((e) => !/favicon\.ico/.test(e));
const toast = () => p.eval(`(document.getElementById('ad-toast-msg')||{}).textContent||''`);
const items = (panel) => p.eval(`[].map.call(document.querySelectorAll('#cpanel-${panel} .ad-list > li h4, #cpanel-${panel} .ad-list > li .ad-qtext'),function(h){return h.textContent})`);
const ferrs = (scope) => p.eval(`[].map.call(document.querySelectorAll(${JSON.stringify(scope + ' .pf-ferr:not([hidden])')}),function(e){return e.textContent})`);
const confirmDialog = async (label) => { await p.waitFor(`!!document.querySelector('dialog.ad-dialog[open]')`, 5000, 'dialog open'); await clickText(p, 'dialog.ad-dialog button', label); await sleep(900); };
const itemBtn = (panel, title, match) => p.eval(`(function(){var li=[].filter.call(document.querySelectorAll('#cpanel-${panel} .ad-list > li'),function(l){return l.textContent.indexOf(${JSON.stringify(title)})!==-1})[0]; if(!li) return 'noitem'; var b=[].filter.call(li.querySelectorAll('button'),function(x){return ((x.getAttribute('aria-label')||'')+' '+x.textContent).indexOf(${JSON.stringify(match)})!==-1 && !x.disabled})[0]; if(!b) return 'nobtn'; b.click(); return 'ok'})()`);
const gotoCourse = async (tab) => { await p.eval(`location.hash='#courses/capm${tab && tab !== 'files' ? '/' + tab : ''}'`); await p.waitFor(`!!document.querySelector('#cpanel-files')`, 15000, 'capm page'); await sleep(700); };
const traineeSees = async (tab) => {
  await t.goto(BASE + '/dashboard/#course=capm&tab=' + tab, 600);
  await t.eval('location.reload()');
  await t.waitFor(`!!document.querySelector('.pf-tabs') || !!document.querySelector('.pf-empty')`, 20000, 'trainee course view');
  await sleep(700);
  return t.eval(`(function(){return {files:[].map.call(document.querySelectorAll('#cpanel-files .pf-item h3'),function(h){return h.textContent}), videos:[].map.call(document.querySelectorAll('#cpanel-videos .pf-video h3'),function(h){return h.textContent}), iframes:[].map.call(document.querySelectorAll('#cpanel-videos iframe'),function(f){return f.src}), vlinks:[].map.call(document.querySelectorAll('#cpanel-videos .pf-vlink'),function(a){return a.href}), questions:document.querySelectorAll('#cpanel-quiz .pf-q').length, counts:[].map.call(document.querySelectorAll('.pf-tabs .pf-count'),function(c){return c.textContent}), locked: !!document.querySelector('.pf-empty')}})()`);
};
const traineeHome = async () => { await t.goto(BASE + '/dashboard/', 600); await t.eval('location.reload()'); await t.waitFor(`!!document.querySelector('#sec-mine')`, 20000); await sleep(500); return t.eval(`[].map.call(document.querySelectorAll('#sec-mine .pf-course h3'),function(h){return h.textContent})`); };
const form = (panel) => `#cpanel-${panel} form.ad-qform`;
try {
  await uiLogin(t, 'a');
  await uiLogin(p, 'admin');

  /* ---------------- list + pmp page ---------------- */
  await openAdmin(p, 'courses', 1200);
  await p.waitFor(`document.querySelectorAll('#ad-view .ad-ccard').length>=6`, 15000, 'course cards');
  check('courses list shows the 6 courses', (await p.eval(`document.querySelectorAll('#ad-view .ad-ccard').length`)) === 6);
  const pmpCard = await p.eval(`[].filter.call(document.querySelectorAll('#ad-view .ad-ccard'),function(c){return c.textContent.indexOf('PMP')!==-1 && c.textContent.indexOf('PMI-')===-1})[0].textContent.replace(/\\s+/g,' ')`);
  check('pmp card shows counts (1 file, 1 video, 3 questions, 1 subscriber)', /الملفات 1/.test(pmpCard) && /الفيديوهات 1/.test(pmpCard) && /الأسئلة 3/.test(pmpCard) && /مشتركون 1/.test(pmpCard), pmpCard.slice(0, 200));
  await p.eval(`location.hash='#courses/pmp'`);
  await p.waitFor(`!!document.querySelector('#cpanel-files .ad-list')`, 15000, 'pmp page');
  check('pmp files tab lists the external-URL file', (await items('files')).some((x) => /دليل PMP/.test(x)), JSON.stringify(await items('files')));
  await click(p, '#ctab-videos');
  await sleep(300);
  check('pmp videos tab lists the YouTube video', (await items('videos')).some((x) => /فيديو تعريفي/.test(x)));
  await p.eval(`document.querySelector('#cpanel-videos .ad-iact button[aria-label^="معاينة"]').click()`);
  await sleep(500);
  const emb = await p.eval(`(document.querySelector('#cpanel-videos .ad-prev iframe')||{}).src||null`);
  check('video preview embeds youtube-nocookie only', !!emb && emb.indexOf('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ') === 0, emb);
  check('video preview iframe is sandboxed', await p.eval(`!!document.querySelector('#cpanel-videos .ad-prev iframe[sandbox]')`));
  await click(p, '#ctab-questions');
  await sleep(300);
  check('pmp questions tab lists 3 questions (1 draft)', (await items('questions')).length === 3);
  await clickText(p, '#cpanel-questions button', 'معاينة كمتدرب');
  await sleep(400);
  check('preview as trainee shows only the 2 published questions', (await p.eval(`document.querySelectorAll('#cpanel-questions .ad-qprev .pf-q').length`)) === 2);
  await p.eval(`(function(){var q=document.querySelectorAll('#cpanel-questions .ad-qprev .pf-q'); q[0].querySelectorAll('input')[0].click(); q[1].querySelectorAll('input')[0].click();})()`);
  await clickText(p, '#cpanel-questions .ad-qprev button', 'إنهاء وتصحيح');
  await sleep(400);
  check('preview grades locally (2/2) and says it is not saved', await p.eval(`(function(){var r=document.querySelector('#cpanel-questions .ad-qprev .pf-result'); return !!r && r.textContent.indexOf('2 / 2')!==-1 && r.textContent.indexOf('لم تُحفظ')!==-1})()`));
  await p.shot(path.join(SHOTS, 'courses-pmp-questions.png'), true);

  /* ---------------- capm: settings + publish ---------------- */
  await gotoCourse('files');
  const S = '#ad-view .ad-card:first-of-type form';
  const origEn = await p.eval(`document.querySelectorAll(${JSON.stringify(S + ' input[type=text]')})[1].value`);
  await p.eval(`(function(){var i=document.querySelectorAll(${JSON.stringify(S + ' input[type=text]')})[1]; i.value=i.value+' X'; i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await clickText(p, S + ' button', 'حفظ الإعدادات');
  await p.waitFor(`document.querySelector(${JSON.stringify(S + ' .pf-msg.ok')})`, 8000, 'settings saved');
  check('course settings saved (title_en edited)', (await p.eval(`document.querySelector('#ad-view .ad-headt .sub').textContent`)).indexOf(origEn + ' X') !== -1);
  await p.eval(`(function(){var i=document.querySelectorAll(${JSON.stringify(S + ' input[type=text]')})[1]; i.value=${JSON.stringify(origEn)}; i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await clickText(p, S + ' button', 'حفظ الإعدادات');
  await sleep(1200);
  check('course settings reverted', (await p.eval(`document.querySelector('#ad-view .ad-headt .sub').textContent`)).indexOf(origEn + ' X') === -1);
  await setVal(p, S + ' input[type=text]', '');
  await clickText(p, S + ' button', 'حفظ الإعدادات');
  await sleep(500);
  check('empty Arabic title is rejected with a field error', (await ferrs(S)).length >= 1, JSON.stringify(await ferrs(S)));
  await setVal(p, S + ' input[type=text]', 'دورة مساعد معتمد في إدارة المشاريع CAPM®');
  /* unpublish: cancel first, then confirm */
  await p.eval(`document.querySelector(${JSON.stringify(S + ' input[type=checkbox]')}).click()`);
  await clickText(p, S + ' button', 'حفظ الإعدادات');
  await confirmDialog('إلغاء'); /* "إلغاء" = cancel button of the dialog */
  await sleep(500);
  check('cancelling the unpublish dialog keeps the course published', await p.eval(`document.querySelector(${JSON.stringify(S + ' input[type=checkbox]')}).checked`));
  let home = await traineeHome();
  check('trainee A still sees CAPM (cancelled unpublish)', home.length === 1, JSON.stringify(home));
  await p.eval(`document.querySelector(${JSON.stringify(S + ' input[type=checkbox]')}).click()`);
  await clickText(p, S + ' button', 'حفظ الإعدادات');
  await confirmDialog('إلغاء النشر');
  await p.waitFor(`document.querySelector(${JSON.stringify(S + ' .pf-msg.ok')})`, 8000, 'unpublish saved');
  check('course unpublished (badge مسودة)', await p.eval(`document.querySelector('#ad-view .ad-hact').textContent.indexOf('مسودة')!==-1`));
  home = await traineeHome();
  check('trainee A no longer sees the unpublished CAPM', home.length === 0, JSON.stringify(home));
  await p.eval(`document.querySelector(${JSON.stringify(S + ' input[type=checkbox]')}).click()`);
  await clickText(p, S + ' button', 'حفظ الإعدادات');
  await p.waitFor(`document.querySelector('#ad-view .ad-hact').textContent.indexOf('منشورة')!==-1`, 8000, 'republished');
  home = await traineeHome();
  check('republished: trainee A sees CAPM again', home.length === 1, JSON.stringify(home));

  /* ---------------- videos ---------------- */
  await gotoCourse('videos');
  await click(p, '#ctab-videos');
  const V = form('videos');
  await setVal(p, V + ' input[type=text]', 'فيديو اختبار P4');
  await setVal(p, V + ' input[type=url]', 'http://example.com/insecure');
  await clickText(p, V + ' button', 'إضافة الفيديو');
  await sleep(500);
  check('http:// video URL rejected', (await ferrs(V)).length >= 1, JSON.stringify(await ferrs(V)));
  await setVal(p, V + ' input[type=url]', 'javascript:alert(1)');
  await clickText(p, V + ' button', 'إضافة الفيديو');
  await sleep(400);
  check('javascript: video URL rejected', (await ferrs(V)).length >= 1);
  await setVal(p, V + ' input[type=url]', 'https://youtu.be/dQw4w9WgXcQ?si=track123');
  await sleep(300);
  check('detect hint says it will be embedded from YouTube', (await p.eval(`document.querySelector(${JSON.stringify(V + ' .pf-hint[role=status]')}).textContent`)).indexOf('YouTube') !== -1);
  await clickText(p, V + ' button', 'إضافة الفيديو');
  await p.waitFor(`document.querySelectorAll('#cpanel-videos .ad-list > li').length===1`, 10000, 'video added');
  check('YouTube video added', (await items('videos')).includes('فيديو اختبار P4'), await toast());
  await setVal(p, V + ' input[type=text]', 'فيديو رابط خارجي P4');
  await setVal(p, V + ' input[type=url]', 'https://example.com/video-page');
  await sleep(300);
  check('detect hint warns that unknown host is a plain link', (await p.eval(`document.querySelector(${JSON.stringify(V + ' .pf-hint[role=status]')}).textContent`)).indexOf('غير مدعوم') !== -1);
  await clickText(p, V + ' button', 'إضافة الفيديو');
  await p.waitFor(`document.querySelectorAll('#cpanel-videos .ad-list > li').length===2`, 10000, 'second video added');
  let seen = await traineeSees('videos');
  check('trainee sees both videos', seen.videos.length === 2, JSON.stringify(seen.videos));
  check('trainee embeds ONLY the YouTube one (youtube-nocookie)', seen.iframes.length === 1 && seen.iframes[0].indexOf('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ') === 0, JSON.stringify(seen.iframes));
  check('trainee gets plain https link for the unknown host', seen.vlinks.some((l) => l.indexOf('https://example.com/video-page') === 0), JSON.stringify(seen.vlinks));

  /* ---------------- files ---------------- */
  await gotoCourse('files');
  const FP = form('files');
  await p.eval(`(function(){var f=document.querySelector(${JSON.stringify(FP + ' input[type=file]')}); window.__fi=f;})()`);
  for (const [name, expect] of [['bad.exe', 'غير مسموح'], ['big.pdf', 'أكبر من الحد'], ['empty.pdf', 'فارغ']]) {
    await p.setFiles(FP + ' input[type=file]', [F(name)]);
    await sleep(500);
    const errs = await ferrs(FP);
    check('file chooser rejects ' + name + ' (' + expect + ')', errs.some((e) => e.indexOf(expect) !== -1), JSON.stringify(errs));
  }
  await setVal(p, FP + ' input[type=text]', 'ملف PDF مرفوع P4');
  await p.setFiles(FP + ' input[type=file]', [F('p4 test (1).pdf')]);
  await sleep(500);
  check('valid PDF accepted by the chooser (hint shows name and size)', (await p.eval(`document.querySelector(${JSON.stringify(FP + ' .pf-hint')}).parentNode.textContent`)).indexOf('p4 test (1).pdf') !== -1);
  await clickText(p, FP + ' button', 'إضافة الملف');
  await p.waitFor(`document.querySelectorAll('#cpanel-files .ad-list > li').length===1`, 30000, 'pdf uploaded');
  check('PDF uploaded to course-files and listed', (await items('files')).includes('ملف PDF مرفوع P4'), await toast());
  const meta1 = await p.eval(`document.querySelector('#cpanel-files .ad-list > li .meta').textContent`);
  check('stored file name is sanitised (ASCII, uuid-prefixed on the server path)', /p4-test-1\.pdf/.test(meta1), meta1);
  /* Arabic file name -> "file.pdf", and a PNG */
  await setVal(p, FP + ' input[type=text]', 'ملف عربي الاسم P4');
  await p.setFiles(FP + ' input[type=file]', [F('مستند عربي.pdf')]);
  await clickText(p, FP + ' button', 'إضافة الملف');
  await p.waitFor(`document.querySelectorAll('#cpanel-files .ad-list > li').length===2`, 30000, 'arabic-name pdf uploaded');
  await setVal(p, FP + ' input[type=text]', 'صورة PNG P4');
  await p.setFiles(FP + ' input[type=file]', [F('p4-test.png')]);
  await clickText(p, FP + ' button', 'إضافة الملف');
  await p.waitFor(`document.querySelectorAll('#cpanel-files .ad-list > li').length===3`, 30000, 'png uploaded');
  check('3 uploaded files listed', (await items('files')).length === 3, JSON.stringify(await items('files')));
  /* external URL file */
  await p.eval(`document.querySelectorAll(${JSON.stringify(FP + ' input[type=radio]')})[1].click()`);
  await sleep(300);
  await setVal(p, FP + ' input[type=text]', 'ملف رابط خارجي P4');
  await setVal(p, FP + ' input[type=url]', 'https://example.com/doc.pdf');
  await clickText(p, FP + ' button', 'إضافة الملف');
  await p.waitFor(`document.querySelectorAll('#cpanel-files .ad-list > li').length===4`, 15000, 'external file added');
  /* trainee */
  seen = await traineeSees('files');
  check('trainee sees the 4 files', seen.files.length === 4, JSON.stringify(seen.files));
  const sig = await t.eval(`(async function(){var P=window.Platform; var rows=await P.rest.select('course_items',{select:'storage_path,title',course_id:'eq.capm',kind:'eq.file',storage_path:'not.is.null',order:'sort.asc'}); var out=[]; for (var i=0;i<rows.length;i++){ var u=await P.storage.signedUrl('course-files', rows[i].storage_path, 60); var r=await fetch(u); var b=await r.arrayBuffer(); out.push({path:rows[i].storage_path, status:r.status, type:r.headers.get('content-type'), size:b.byteLength}); } return out;})()`);
  console.log(JSON.stringify(sig));
  check('trainee gets working signed URLs for the 3 uploaded files (200)', sig.length === 3 && sig.every((x) => x.status === 200), JSON.stringify(sig.map((x) => x.status + ' ' + x.type + ' ' + x.size)));
  check('stored object paths start with "capm/<uuid>-" and sanitised names', sig.every((x) => /^capm\/[0-9a-f-]{36}-[a-z0-9._-]+$/.test(x.path)), JSON.stringify(sig.map((x) => x.path)));
  /* publish toggle + reorder + edit */
  await gotoCourse('files');
  await itemBtn('files', 'صورة PNG P4', 'إخفاء');
  await sleep(1200);
  seen = await traineeSees('files');
  check('unpublished file is hidden from the trainee', seen.files.length === 3 && !seen.files.includes('صورة PNG P4'), JSON.stringify(seen.files));
  await gotoCourse('files');
  await itemBtn('files', 'صورة PNG P4', 'نشر');
  await sleep(1200);
  const before = await items('files');
  await itemBtn('files', 'ملف رابط خارجي P4', 'للأعلى');
  await sleep(1500);
  const after = await items('files');
  check('move up changes the order (last item moved up)', after.indexOf('ملف رابط خارجي P4') === before.indexOf('ملف رابط خارجي P4') - 1, JSON.stringify(before) + ' -> ' + JSON.stringify(after));
  seen = await traineeSees('files');
  check('trainee list follows the new order', JSON.stringify(seen.files) === JSON.stringify(after), JSON.stringify(seen.files));
  await gotoCourse('files');
  await itemBtn('files', 'ملف عربي الاسم P4', 'تعديل');
  await sleep(300);
  await setVal(p, '#cpanel-files .ad-edit input[type=text]', 'ملف عربي بعد التعديل P4');
  await clickText(p, '#cpanel-files .ad-edit button', 'حفظ');
  await sleep(1500);
  check('edit title saved', (await items('files')).includes('ملف عربي بعد التعديل P4'), JSON.stringify(await items('files')));
  await p.shot(path.join(SHOTS, 'courses-capm-files.png'), true);

  console.log('trainee errors:', JSON.stringify(real(t)));
  check('trainee browser: no console errors', real(t).length === 0, JSON.stringify(real(t)));
} catch (e) { console.log('ERR', e.message); try { await p.shot(path.join(SHOTS, 'err-adm.png')); } catch (x) { /* ignore */ } }
console.log('admin errors:', JSON.stringify(real(p)));
check('admin browser: no console errors', real(p).length === 0, JSON.stringify(real(p)));
summary();
await adm.close(); await tr.close();
