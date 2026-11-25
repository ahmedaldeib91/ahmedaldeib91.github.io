import { launch, BASE, check, summary, uiLogin, openAdmin, TMP, sleep, setVal, click, clickText } from './lib.mjs';
import path from 'node:path';

const SHOTS = path.join(TMP, 'shots');
const F = (n) => path.join(TMP, 'files', n).replace(/\\/g, '/');
const adm = await launch({ port: 9333 });
const tr = await launch({ port: 9334 });
const p = adm.page, t = tr.page;
const real = (pg) => pg.errors.filter((e) => !/favicon\.ico/.test(e));
const toast = () => p.eval(`(document.getElementById('ad-toast-msg')||{}).textContent||''`);
const confirmDialog = async (label) => { await p.waitFor(`!!document.querySelector('dialog.ad-dialog[open]')`, 5000, 'dialog open'); await clickText(p, 'dialog.ad-dialog button', label); await sleep(1800); };
const anon = (pathq) => p.eval(`(async function(){var m=document.querySelector('[data-sb-url]'); var r=await fetch(m.getAttribute('data-sb-url')+${JSON.stringify(pathq)},{headers:{apikey:m.getAttribute('data-sb-key')}}); var j=null; try{j=await r.json()}catch(e){} return {status:r.status, json:j};})()`);
const head = (url) => p.eval(`(async function(){var r=await fetch(${JSON.stringify(url)}); var b=await r.arrayBuffer(); return {status:r.status,type:r.headers.get('content-type'),size:b.byteLength};})()`);
const E = '#ad-view .ad-editor';
const fill = (sel, v) => setVal(p, sel, v);
const clearToast = () => p.eval(`(function(){var e=document.getElementById('ad-toast-msg'); e.textContent=''; e.hidden=true;})()`);
/* click a form button, wait for the success toast, then for the editor to finish reloading */
const saveWait = async (label) => {
  await clearToast();
  await clickText(p, E + ' form button', label);
  await p.waitFor(`(function(){var e=document.getElementById('ad-toast-msg'); return !e.hidden && e.textContent.length>0 && e.className.indexOf('err')===-1})()`, 40000, 'success toast');
  await p.waitFor(`!document.querySelector('#ad-view .pf-loading') && !!document.querySelector('${E} form')`, 20000, 'editor reloaded');
  await sleep(500);
};
try {
  await uiLogin(t, 'a');
  await uiLogin(p, 'admin');

  /* ======================= settings: announcement ======================= */
  await openAdmin(p, 'settings', 1500);
  await p.waitFor(`document.querySelectorAll('#ad-view .ad-two textarea').length>0`, 15000, 'settings');
  const AC = '#ad-view .ad-two .ad-card:first-child';
  await fill(AC + ' textarea', 'إعلان اختبار P4: تبدأ الدفعة السبت. <b>نص عريض</b>');
  await click(p, AC + ' input[type=checkbox]');
  await clickText(p, AC + ' button', 'حفظ الإعلان');
  await p.waitFor(`document.querySelector('${AC} .pf-msg.ok')`, 10000, 'announcement saved');
  check('announcement saved (active)', true, await p.eval(`document.querySelector('${AC} .pf-msg.ok').textContent`));
  await t.goto(BASE + '/dashboard/', 600);
  await t.eval('location.reload()');
  await t.waitFor(`!!document.querySelector('#sec-mine')`, 20000);
  await sleep(500);
  const ann = await t.eval(`(function(){var a=document.getElementById('dash-announce'); return {hidden:a.hidden, text:document.getElementById('dash-announce-text').textContent, hasB: !!a.querySelector('b')}})()`);
  check('announcement shows on the trainee dashboard (as plain text)', !ann.hidden && ann.text.indexOf('إعلان اختبار P4') !== -1 && ann.text.indexOf('<b>نص عريض</b>') !== -1 && !ann.hasB, JSON.stringify(ann));
  /* empty text + active -> rejected */
  await fill(AC + ' textarea', '');
  await clickText(p, AC + ' button', 'حفظ الإعلان');
  await sleep(500);
  check('active announcement with empty text is rejected', await p.eval(`!!document.querySelector('${AC} .pf-ferr:not([hidden])')`));
  /* restore original value: empty + inactive */
  await click(p, AC + ' input[type=checkbox]');
  await clickText(p, AC + ' button', 'حفظ الإعلان');
  await p.waitFor(`document.querySelector('${AC} .pf-msg.ok') && document.querySelector('${AC} .pf-msg.ok').textContent.indexOf('معطّل')!==-1`, 10000, 'announcement off');
  await t.eval('location.reload()');
  await t.waitFor(`!!document.querySelector('#sec-mine')`, 20000);
  await sleep(500);
  check('announcement hidden again after disabling', await t.eval(`document.getElementById('dash-announce').hidden`));
  /* profile */
  const PC = '#ad-view .ad-two .ad-card:nth-child(2)';
  const origName = await p.eval(`document.querySelector('${PC} input[type=text]').value`);
  await fill(PC + ' input[type=text]', 'مدرب الاختبار P4 (معدّل)');
  await clickText(p, PC + ' button', 'حفظ بياناتي');
  await p.waitFor(`document.querySelector('${PC} .pf-msg.ok')`, 10000, 'profile saved');
  check('trainer profile name saved + header greeting updated', (await p.eval(`document.getElementById('ad-hello').textContent`)).indexOf('(معدّل)') !== -1);
  await fill(PC + ' input[type=text]', origName);
  await fill(PC + ' input[type=tel]', 'abc');
  await clickText(p, PC + ' button', 'حفظ بياناتي');
  await sleep(500);
  check('invalid phone rejected', await p.eval(`!!document.querySelector('${PC} .pf-ferr:not([hidden])')`));
  await fill(PC + ' input[type=tel]', '+966500000000');
  await clickText(p, PC + ' button', 'حفظ بياناتي');
  await sleep(1500);
  check('profile restored', (await p.eval(`document.getElementById('ad-hello').textContent`)).indexOf(origName) !== -1);
  check('audit log card lists entries (read-only)', (await p.eval(`document.querySelectorAll('#ad-view .ad-card:last-of-type tbody tr').length`)) > 5, await p.eval(`document.querySelectorAll('#ad-view .ad-card:last-of-type tbody tr').length`));
  await p.shot(path.join(SHOTS, 'settings-after.png'), true);

  /* ======================= blog ======================= */
  await p.eval(`location.hash='#blog'`);
  await p.waitFor(`document.querySelectorAll('#ad-view .ad-table tbody tr').length>0`, 15000, 'blog list');
  check('blog list shows the 3 fixture posts', (await p.eval(`document.querySelectorAll('#ad-view .ad-table tbody tr').length`)) === 3);
  await setVal(p, '#ad-view select', 'published');
  await sleep(400);
  check('filter "منشورة" shows 1', (await p.eval(`document.querySelectorAll('#ad-view .ad-table tbody tr').length`)) === 1);
  await setVal(p, '#ad-view select', 'draft');
  await sleep(400);
  check('XSS post title is shown as inert text in the list', await p.eval(`(function(){var t=document.querySelector('#ad-view .ad-table'); return t.textContent.indexOf('<script>window.__xss=2</script>')!==-1 && !t.querySelector('script') && !window.__xss})()`));
  await setVal(p, '#ad-view select', 'all');
  /* quick publish / unpublish of the draft */
  const row = (slug) => `[].filter.call(document.querySelectorAll('#ad-view .ad-table tbody tr'),function(r){return r.textContent.indexOf(${JSON.stringify(slug)})!==-1})[0]`;
  await p.eval(`[].filter.call(${row('p4-draft')}.querySelectorAll('button'),function(b){return b.textContent.indexOf('نشر')!==-1})[0].click()`);
  await sleep(1500);
  let r = await anon('/rest/v1/posts?select=slug,published_at&slug=eq.p4-draft');
  check('quick publish: anon (public) can now read p4-draft with published_at set', r.json && r.json.length === 1 && !!r.json[0].published_at, JSON.stringify(r.json));
  await p.eval(`[].filter.call(${row('p4-draft')}.querySelectorAll('button'),function(b){return b.textContent.indexOf('إلغاء النشر')!==-1})[0].click()`);
  await sleep(1500);
  r = await anon('/rest/v1/posts?select=slug&slug=eq.p4-draft');
  check('quick unpublish: anon cannot read it any more', r.json && r.json.length === 0, JSON.stringify(r.json));

  /* new post with image upload */
  await p.eval(`location.hash='#blog/new'`);
  await p.waitFor(`!!document.querySelector('${E} form')`, 15000, 'editor');
  await fill(E + ' form input[type=text]', 'مقال اختبار P4 الأول');
  check('slug auto-generated from the title (Arabic kept, hyphens)', (await p.eval(`document.querySelector('${E} .ad-slugrow input').value`)) === 'مقال-اختبار-p4-الأول', await p.eval(`document.querySelector('${E} .ad-slugrow input').value`));
  await fill(E + ' textarea', 'الفقرة الأولى من المقال.\n\nالفقرة الثانية <script>window.__xss=9</script> نص.');
  await sleep(300);
  check('live preview renders 2 paragraphs from blank-line separation', (await p.eval(`document.querySelectorAll('${E} .ad-pv > div:last-child > p').length`)) === 2);
  check('preview keeps raw HTML as inert text (no script element)', await p.eval(`!document.querySelector('${E} .ad-pv script') && document.querySelector('${E} .ad-pv').textContent.indexOf('<script>')!==-1 && !window.__xss`));
  await p.eval(`document.querySelectorAll('${E} fieldset input[type=radio]')[1].click()`); /* kind=image */
  await sleep(300);
  await p.setFiles(E + ' input[type=file]', [F('bad.exe')]);
  await sleep(400);
  check('image kind rejects .exe', await p.eval(`!!document.querySelector('${E} .pf-ferr:not([hidden])')`));
  await p.setFiles(E + ' input[type=file]', [F('p4-media.webm')]);
  await sleep(400);
  check('image kind rejects a video file (.webm)', await p.eval(`!!document.querySelector('${E} .pf-ferr:not([hidden])')`));
  await p.setFiles(E + ' input[type=file]', [F('p4-test.png')]);
  await sleep(600);
  check('local preview shows the chosen image (blob:)', await p.eval(`(function(){var i=document.querySelector('${E} .ad-pv img'); return !!i && i.getAttribute('src').indexOf('blob:')===0})()`));
  await saveWait('حفظ');
  await p.waitFor(`/^#blog\\/[0-9a-f-]{36}$/.test(location.hash)`, 30000, 'hash replaced with the new id');
  check('new post saved as draft; editor reopened on #blog/<id>', true, await toast());
  const id1 = await p.eval(`location.hash.slice(6)`);
  const url1 = await p.eval(`document.querySelector('${E} input[type=url]').value`);
  check('media URL is a public blog-media URL under posts/', /\/storage\/v1\/object\/public\/blog-media\/posts\/[0-9a-f-]{36}-p4-test\.png$/.test(url1), url1);
  let h = await head(url1);
  check('uploaded image is publicly reachable (200, image/png, 70 bytes)', h.status === 200 && h.type === 'image/png' && h.size === 70, JSON.stringify(h));
  r = await anon('/rest/v1/posts?select=slug&slug=eq.' + encodeURIComponent('مقال-اختبار-p4-الأول'));
  check('draft is NOT visible to the public', r.json && r.json.length === 0, JSON.stringify(r.json));
  await saveWait('حفظ ونشر');
  r = await anon('/rest/v1/posts?select=slug,published,published_at,media_kind&slug=eq.' + encodeURIComponent('مقال-اختبار-p4-الأول'));
  check('publish: public can read it (published_at stamped, media_kind=image)', r.json && r.json.length === 1 && r.json[0].published === true && !!r.json[0].published_at && r.json[0].media_kind === 'image', JSON.stringify(r.json));
  await saveWait('إلغاء النشر');
  r = await anon('/rest/v1/posts?select=slug&slug=eq.' + encodeURIComponent('مقال-اختبار-p4-الأول'));
  check('unpublish: hidden from the public again', r.json && r.json.length === 0, JSON.stringify(r.json));
  /* replace media with a gif: old object must be deleted */
  await p.eval(`document.querySelectorAll('${E} fieldset')[1].querySelectorAll('input[type=radio]')[0].click()`); /* source: upload */
  await sleep(300);
  await p.setFiles(E + ' input[type=file]', [F('p4-img.gif')]);
  await sleep(500);
  await saveWait('حفظ');
  const url2 = await p.eval(`document.querySelector('${E} input[type=url]').value`);
  check('media replaced: new gif URL differs', url2 !== url1 && /\.gif$/.test(url2), url2);
  h = await head(url1);
  check('old PNG object was deleted from storage after replacement (public URL no longer 200)', h.status !== 200, JSON.stringify(h));
  h = await head(url2);
  check('new GIF object is reachable (200, image/gif)', h.status === 200 && h.type === 'image/gif', JSON.stringify(h));
  /* http:// media url rejected */
  await p.eval(`document.querySelectorAll('${E} fieldset')[1].querySelectorAll('input[type=radio]')[1].click()`);
  await fill(E + ' input[type=url]', 'http://example.com/a.png');
  await clickText(p, E + ' form button', 'حفظ');
  await sleep(500);
  check('http:// media URL rejected', await p.eval(`!!document.querySelector('${E} .pf-ferr:not([hidden])')`));
  /* video via YouTube URL -> embed preview; old gif object deleted on save */
  await p.eval(`document.querySelectorAll('${E} fieldset')[0].querySelectorAll('input[type=radio]')[2].click()`); /* kind=video */
  await sleep(300);
  await p.eval(`document.querySelectorAll('${E} fieldset')[1].querySelectorAll('input[type=radio]')[1].click()`); /* source=url */
  await fill(E + ' input[type=url]', 'https://youtu.be/dQw4w9WgXcQ');
  await sleep(900);
  check('video preview embeds youtube-nocookie (sandboxed iframe)', await p.eval(`(function(){var f=document.querySelector('${E} .ad-pv iframe'); return !!f && f.src.indexOf('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ')===0 && f.hasAttribute('sandbox')})()`));
  await saveWait('حفظ');
  h = await head(url2);
  check('old GIF object deleted after switching media to a video URL', h.status !== 200, JSON.stringify(h));
  /* second post with the same title -> unique slug -2 */
  await p.eval(`location.hash='#blog/new'`);
  await p.waitFor(`!!document.querySelector('${E} form') && !document.querySelector('${E} form input[type=text]').value`, 15000, 'editor 2');
  await fill(E + ' form input[type=text]', 'مقال اختبار P4 الأول');
  await clickText(p, E + ' form button', 'حفظ');
  await p.waitFor(`/^#blog\\/[0-9a-f-]{36}$/.test(location.hash) && location.hash.slice(6)!==${JSON.stringify(id1)} && !!document.querySelector('${E} .ad-slugrow input')`, 20000, 'second saved');
  check('duplicate title gets a unique slug automatically (-2)', (await p.eval(`document.querySelector('${E} .ad-slugrow input').value`)) === 'مقال-اختبار-p4-الأول-2', await p.eval(`document.querySelector('${E} .ad-slugrow input').value`));
  /* manual slug conflict -> error with suggestion */
  await fill(E + ' .ad-slugrow input', 'p4-published');
  await clickText(p, E + ' form button', 'حفظ');
  await sleep(1200);
  check('manual slug that already exists is refused with a suggestion', (await p.eval(`(document.querySelector('${E} .ad-slugrow .pf-ferr:not([hidden])')||{}).textContent||''`)).indexOf('جرّب') !== -1);
  await fill(E + ' .ad-slugrow input', 'bad slug/with?chars');
  await clickText(p, E + ' form button', 'حفظ');
  await sleep(600);
  check('slug with spaces / ? is refused', (await p.eval(`(document.querySelector('${E} .ad-slugrow .pf-ferr:not([hidden])')||{}).textContent||''`)).indexOf('مسافات') !== -1);
  await p.shot(path.join(SHOTS, 'blog-editor.png'), true);
  /* delete both created posts through the UI (confirmation) */
  for (let i = 0; i < 2; i++) {
    await p.eval(`location.hash='#blog'`);
    await sleep(1500);
    await p.eval(`(function(){var r=[].filter.call(document.querySelectorAll('#ad-view .ad-table tbody tr'),function(r){return r.textContent.indexOf('مقال اختبار P4 الأول')!==-1})[0]; [].filter.call(r.querySelectorAll('button'),function(b){return b.textContent.trim()==='حذف'})[0].click();})()`);
    await confirmDialog('حذف نهائي');
    check('deleted test post #' + (i + 1) + ' (after confirm)', /تم حذف المقال/.test(await toast()), await toast());
  }
  /* XSS fixture post opens in the editor as inert text */
  await p.eval(`location.hash='#blog'`);
  await sleep(1500);
  await p.eval(`[].filter.call(document.querySelectorAll('#ad-view .ad-table tbody tr a'),function(a){return a.textContent.indexOf('script')!==-1})[0].click()`);
  await p.waitFor(`!!document.querySelector('${E} form')`, 15000, 'xss editor');
  await sleep(500);
  check('XSS post in editor/preview is inert (no script/img elements, window.__xss undefined)', await p.eval(`!document.querySelector('${E} .ad-pv script') && !document.querySelector('${E} .ad-pv img') && !window.__xss && document.querySelector('${E} .ad-pv').textContent.indexOf('<img src=x')!==-1`));
  check('trainee browser: no console errors', real(t).length === 0, JSON.stringify(real(t)));
} catch (e) { console.log('ERR', e.message); try { await p.shot(path.join(SHOTS, 'err-adm.png')); } catch (x) { /* ignore */ } }
check('admin browser: no console errors', real(p).length === 0, JSON.stringify(real(p)));
summary();
await adm.close(); await tr.close();
