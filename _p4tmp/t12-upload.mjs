import { launch, BASE, check, summary, uiLogin, openAdmin, TMP, sleep, setVal, click, clickText } from './lib.mjs';
import fs from 'node:fs';
import path from 'node:path';

const SHOTS = path.join(TMP, 'shots');
const big = path.join(TMP, 'files', 'big20.pdf').replace(/\\/g, '/');
fs.writeFileSync(big, Buffer.alloc(20 * 1024 * 1024, 0x41)); /* 20 MiB */
const adm = await launch({ port: 9333 });
const p = adm.page;
const confirmDialog = async (label) => { await p.waitFor(`!!document.querySelector('dialog.ad-dialog[open]')`, 5000, 'dialog open'); await clickText(p, 'dialog.ad-dialog button', label); await sleep(2500); };
try {
  await uiLogin(p, 'admin');
  await openAdmin(p, 'courses/capm', 1800);
  await p.waitFor(`!!document.querySelector('#cpanel-files form.ad-qform')`, 15000);
  const FP = '#cpanel-files form.ad-qform';
  await p.eval(`window.__vals=[]; window.__iv=setInterval(function(){var b=document.querySelector('${FP} .ad-prog'); if(b && !b.parentNode.hidden){ var v=b.getAttribute('aria-valuenow'); if(window.__vals[window.__vals.length-1]!==v) window.__vals.push(v);} },60);`);
  await setVal(p, FP + ' input[type=text]', 'ملف كبير 20MB P4');
  await p.setFiles(FP + ' input[type=file]', [big]);
  await sleep(500);
  check('20 MB file accepted by the chooser (<= 50 MB)', (await p.eval(`document.querySelector('${FP} .pf-hint').parentNode.textContent`)).indexOf('20.0 MB') !== -1);
  await clickText(p, FP + ' button', 'إضافة الملف');
  await sleep(400);
  check('progress bar is shown while uploading and the cancel button appears', await p.eval(`(function(){var w=document.querySelector('${FP} .ad-progwrap'); var c=[].filter.call(document.querySelectorAll('${FP} button'),function(b){return b.textContent.indexOf('إلغاء الرفع')!==-1})[0]; return (!w.hidden || window.__vals.length>0) && (!!c)})()`));
  await p.waitFor(`document.querySelectorAll('#cpanel-files .ad-list > li').length===1`, 120000, 'big upload done');
  const vals = await p.eval(`window.__vals`);
  const nums = vals.map(Number);
  check('progress bar reported intermediate values (0 < v < 100) during the upload', nums.some((v) => v > 0 && v < 100), JSON.stringify(vals));
  check('progress reached 100 and the item is listed', nums.includes(100) || (await p.eval(`document.querySelectorAll('#cpanel-files .ad-list > li').length`)) === 1, JSON.stringify(vals));
  /* second upload: cancel it midway -> no item, no object */
  await setVal(p, FP + ' input[type=text]', 'ملف سيُلغى رفعه P4');
  await p.setFiles(FP + ' input[type=file]', [big]);
  await sleep(400);
  await clickText(p, FP + ' button', 'إضافة الملف');
  await p.waitFor(`(function(){var c=[].filter.call(document.querySelectorAll('${FP} button'),function(b){return b.textContent.indexOf('إلغاء الرفع')!==-1 && !b.hidden})[0]; return !!c && c.offsetParent!==null})()`, 15000, 'cancel visible');
  await sleep(700);
  await clickText(p, FP + ' button', 'إلغاء الرفع');
  await sleep(2500);
  check('cancelled upload: no new item was created (still 1)', (await p.eval(`document.querySelectorAll('#cpanel-files .ad-list > li').length`)) === 1);
  check('cancelled upload: user sees the "أُلغي الرفع" message', (await p.eval(`(document.querySelector('${FP} .pf-msg')||{}).textContent||''`)).indexOf('أُلغي الرفع') !== -1, await p.eval(`(document.querySelector('${FP} .pf-msg')||{}).textContent||''`));
  /* delete the big one via UI (confirmation) so the object is removed */
  await p.eval(`(function(){var li=document.querySelector('#cpanel-files .ad-list > li'); [].filter.call(li.querySelectorAll('button'),function(b){return (b.getAttribute('aria-label')||'').indexOf('حذف')===0})[0].click();})()`);
  await confirmDialog('حذف نهائي');
  check('big file item deleted (after confirm)', (await p.eval(`document.querySelectorAll('#cpanel-files .ad-list > li').length`)) === 0);
  const errs = p.errors.filter((e) => !/favicon\.ico|net::ERR_ABORTED/.test(e));
  check('no unexpected console errors', errs.length === 0, JSON.stringify(errs.slice(0, 3)));
} catch (e) { console.log('ERR', e.message); try { await p.shot(path.join(SHOTS, 'err-upload.png')); } catch (x) { /* ignore */ } }
try { fs.rmSync(big, { force: true }); } catch (e) { /* ignore */ }
summary();
await adm.close();
