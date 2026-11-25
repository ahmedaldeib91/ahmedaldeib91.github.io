import { launch, BASE, uiLogin, openAdmin, sleep, clickText } from './lib.mjs';
const adm = await launch({ port: 9333 });
const p = adm.page;
try {
  await uiLogin(p, 'admin');
  await openAdmin(p, 'courses/capm/questions', 2000);
  await p.waitFor(`!!document.querySelector('#cpanel-questions')`, 15000);
  await p.eval(`document.getElementById('ctab-questions').click()`);
  await sleep(500);
  console.log('lis:', await p.eval(`[].map.call(document.querySelectorAll('#cpanel-questions .ad-list > li'),function(l){return l.textContent.slice(0,80)+' | buttons: '+[].map.call(l.querySelectorAll('button'),function(b){return (b.getAttribute('aria-label')||b.textContent)+(b.disabled?'(dis)':'')}).join(' ; ')})`));
  const r = await p.eval(`(function(){var li=document.querySelector('#cpanel-questions .ad-list > li'); var b=[].filter.call(li.querySelectorAll('button'),function(x){return (x.getAttribute('aria-label')||'').indexOf('حذف')!==-1})[0]; if(!b) return 'nobtn'; b.click(); return 'clicked';})()`);
  console.log('click:', r);
  await sleep(1500);
  console.log('dialog open:', await p.eval(`!!document.querySelector('dialog.ad-dialog[open]')`), 'dialogs in DOM:', await p.eval(`document.querySelectorAll('dialog').length`));
  console.log('toast:', await p.eval(`(document.getElementById('ad-toast-msg')||{}).textContent||''`));
  console.log('errors:', JSON.stringify(p.errors));
} catch (e) { console.log('ERR', e.message); }
finally { await adm.close(); }
