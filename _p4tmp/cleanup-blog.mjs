import { launch, uiLogin, openAdmin, sleep, clickText } from './lib.mjs';
const adm = await launch({ port: 9333 });
const p = adm.page;
try {
  await uiLogin(p, 'admin');
  await openAdmin(p, 'blog', 1800);
  for (let i = 0; i < 6; i++) {
    await p.waitFor(`document.querySelectorAll('#ad-view .ad-table tbody tr').length>0`, 15000);
    const n = await p.eval(`(function(){var r=[].filter.call(document.querySelectorAll('#ad-view .ad-table tbody tr'),function(r){return r.textContent.indexOf('مقال اختبار P4')!==-1})[0]; if(!r) return 0; [].filter.call(r.querySelectorAll('button'),function(b){return b.textContent.trim()==='حذف'})[0].click(); return 1;})()`);
    if (!n) break;
    await p.waitFor(`!!document.querySelector('dialog.ad-dialog[open]')`, 5000);
    await clickText(p, 'dialog.ad-dialog button', 'حذف نهائي');
    await sleep(2500);
    console.log('deleted one:', await p.eval(`document.getElementById('ad-toast-msg').textContent`));
  }
} catch (e) { console.log('ERR', e.message); }
finally { await adm.close(); }
