import { launch, BASE, uiLogin, openAdmin, SHOTS, sleep, setVal, clickText } from './lib.mjs';
import path from 'node:path';
const A_ID = 'a4000000-0000-4000-8000-00000000000a';
const adm = await launch({ port: 9333 });
const p = adm.page;
try {
  await uiLogin(p, 'admin');
  await openAdmin(p, 'trainees/' + A_ID, 2500);
  await p.waitFor(`!!document.querySelector('#ad-view .ad-kv')`, 15000);
  console.log('select options:', await p.eval(`[].map.call(document.querySelectorAll('#ad-view .ad-addenr select option'),function(o){return o.value+':'+o.textContent})`));
  await setVal(p, '#ad-view .ad-addenr select', 'capm');
  console.log('select value:', await p.eval(`document.querySelector('#ad-view .ad-addenr select').value`));
  await clickText(p, '#ad-view .ad-addenr button', 'إضافة الاشتراك');
  await sleep(3500);
  console.log('toast:', await p.eval(`document.getElementById('ad-toast-msg').textContent`));
  console.log('msgs:', await p.eval(`[].map.call(document.querySelectorAll('#ad-view .pf-msg'),function(m){return (m.hidden?'(hidden) ':'')+m.className+': '+m.textContent})`));
  console.log('rows:', await p.eval(`document.querySelectorAll('#ad-view .ad-table tbody tr').length`));
  console.log('reqs:', JSON.stringify(p.requests.filter((r) => /enrollments|audit/.test(r.url)).map((r) => r.method + ' ' + r.status + ' ' + r.url.replace(/^https:\/\/[^/]+/, '').slice(0, 140))));
  console.log('errors:', JSON.stringify(p.errors));
} catch (e) { console.log('ERR', e.message); }
finally { await adm.close(); }
