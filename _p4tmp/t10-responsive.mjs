import { launch, BASE, check, summary, uiLogin, TMP, sleep } from './lib.mjs';
import path from 'node:path';

const SHOTS = path.join(TMP, 'shots', 'resp');
const adm = await launch({ port: 9333 });
const p = adm.page;
const B_ID = 'a4000000-0000-4000-8000-00000000000b';
const POST_ID = 'a4300000-0000-4000-8000-000000000001';
const STATES = [
  { n: 'stats', h: 'stats' },
  { n: 'trainees', h: 'trainees' },
  { n: 'trainee-page', h: 'trainees/' + B_ID },
  { n: 'enrollments', h: 'enrollments' },
  { n: 'courses', h: 'courses' },
  { n: 'course-files', h: 'courses/pmp' },
  { n: 'course-videos', h: 'courses/pmp/videos' },
  { n: 'course-questions', h: 'courses/pmp/questions' },
  { n: 'messages', h: 'messages' },
  { n: 'message-detail', h: 'messages', act: `(function(){var b=document.querySelector('#ad-view .ad-msgrow'); if(b) b.click();})()` },
  { n: 'blog', h: 'blog' },
  { n: 'blog-editor', h: 'blog/' + POST_ID },
  { n: 'settings', h: 'settings' }
];
const MEASURE = `(function(){
  var de=document.documentElement; var vw=de.clientWidth; var main=document.getElementById('main');
  var over=[];
  [].forEach.call(document.querySelectorAll('.ad-app *'),function(e){
    if(e.closest('thead') && getComputedStyle(e.closest('thead')).position==='absolute') return;
    if(e.closest('.ad-tablewrap') && e.closest('.ad-tablewrap')!==e){ var w=e.closest('.ad-tablewrap'); if(getComputedStyle(w).overflowX==='auto' && w.scrollWidth>w.clientWidth) return; }
    var r=e.getBoundingClientRect(); if(r.width>0 && r.height>0 && (r.right>vw+1 || r.left<-1)) over.push(e.tagName.toLowerCase()+'.'+String(e.getAttribute('class')||'').split(' ')[0]+' ['+Math.round(r.left)+','+Math.round(r.right)+']');
  });
  var tw=document.querySelector('.ad-tablewrap'); var twScroll = tw? (tw.scrollWidth>tw.clientWidth) : false;
  return {sw:de.scrollWidth, cw:vw, bsw:document.body.scrollWidth, mainSw: main? main.scrollWidth:0, mainCw: main? main.clientWidth:0, over: over.slice(0,6), tableScroll: twScroll};
})()`;
let total = 0, bad = 0;
try {
  await uiLogin(p, 'admin');
  for (const theme of ['dark', 'light']) {
    for (const [w, hgt, mobile] of [[320, 700, true], [390, 800, true], [768, 900, false], [1280, 900, false]]) {
      await p.viewport(w, hgt, mobile);
      await p.goto(BASE + '/admin/#stats', 300);
      await p.eval(`localStorage.setItem('theme', ${JSON.stringify(theme)})`);
      await p.eval('location.reload()');
      await p.waitFor(`!document.getElementById('ad-shell').hidden && !!document.querySelector('.ad-stat')`, 25000, 'admin ready at ' + w);
      await sleep(600);
      const themeNow = await p.eval(`document.documentElement.dataset.theme`);
      for (const s of STATES) {
        await p.eval(`location.hash='#${s.h}'`);
        await sleep(1700);
        await p.waitFor(`!document.querySelector('#ad-view .pf-loading')`, 15000, 'loaded ' + s.n).catch(() => {});
        if (s.act) { await p.eval(s.act); await sleep(700); }
        await sleep(300);
        const m = await p.eval(MEASURE);
        total++;
        const ok = m.sw <= m.cw && m.bsw <= m.cw + 0 && m.over.length === 0;
        if (!ok) bad++;
        check(`${theme} ${w}px ${s.n}: no horizontal page overflow`, ok, JSON.stringify(m));
        if ((w === 390 || w === 320) && ['stats', 'trainees', 'course-questions', 'messages', 'message-detail', 'blog-editor'].includes(s.n)) await p.shot(path.join(SHOTS, `${theme}-${w}-${s.n}.png`), true);
        if (w === 1280 && theme === 'light' && ['stats', 'trainees', 'course-files', 'settings'].includes(s.n)) await p.shot(path.join(SHOTS, `${theme}-${w}-${s.n}.png`), true);
        if (w === 768 && theme === 'dark' && ['trainees', 'enrollments', 'blog'].includes(s.n)) await p.shot(path.join(SHOTS, `${theme}-${w}-${s.n}.png`), true);
      }
    }
  }
  console.log(`checked ${total} states, ${bad} with overflow`);
} catch (e) { console.log('ERR', e.message); try { await p.shot(path.join(SHOTS, 'err.png')); } catch (x) { /* ignore */ } }
const errs = p.errors.filter((e) => !/favicon\.ico/.test(e));
check('no console errors while visiting every state', errs.length === 0, JSON.stringify(errs.slice(0, 3)));
summary();
await adm.close();
