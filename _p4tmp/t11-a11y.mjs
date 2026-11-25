import { launch, BASE, check, summary, uiLogin, openAdmin, TMP, sleep, setVal } from './lib.mjs';
import path from 'node:path';

const SHOTS = path.join(TMP, 'shots');
const adm = await launch({ port: 9335 });
const p = adm.page;
/* real key presses through CDP (Enter/Space need text so that links/buttons activate) */
const press = async (key, opts = {}) => {
  const map = { Enter: { code: 'Enter', vk: 13, text: '\r' }, ' ': { code: 'Space', vk: 32, text: ' ' }, Tab: { code: 'Tab', vk: 9 }, Escape: { code: 'Escape', vk: 27 }, ArrowLeft: { code: 'ArrowLeft', vk: 37 }, ArrowRight: { code: 'ArrowRight', vk: 39 }, Home: { code: 'Home', vk: 36 }, End: { code: 'End', vk: 35 } };
  const m = map[key];
  const base = { key, code: m.code, windowsVirtualKeyCode: m.vk, nativeVirtualKeyCode: m.vk, modifiers: opts.shift ? 8 : 0 };
  await p.send('Input.dispatchKeyEvent', { type: m.text ? 'keyDown' : 'rawKeyDown', ...base, text: m.text });
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  await sleep(120);
};
const active = () => p.eval(`(function(){var a=document.activeElement; return a? {tag:a.tagName.toLowerCase(), id:a.id||'', text:(a.getAttribute('aria-label')||a.textContent||'').trim().slice(0,40), inDialog: !!a.closest('dialog')} : null})()`);
try {
  await uiLogin(p, 'admin');
  await openAdmin(p, 'stats', 1500);
  await p.waitFor(`!document.getElementById('ad-shell').hidden && !!document.querySelector('.ad-stat')`, 20000, 'ready');

  /* landmarks and structure */
  const st = await p.eval(`(function(){var nav=document.getElementById('ad-nav'); return {role:nav.getAttribute('role'), label:nav.getAttribute('aria-label'), h1:document.querySelectorAll('h1').length, main:!!document.querySelector('main#main'), skip:!!document.querySelector('a.skip[href="#main"]'), title:document.getElementById('ad-title').tagName, tabindex:document.getElementById('ad-title').getAttribute('tabindex')}})()`);
  check('navigation landmark has role + aria-label', st.role === 'navigation' && !!st.label, JSON.stringify(st));
  check('single h1, main landmark and skip link exist', st.h1 === 1 && st.main && st.skip);
  check('section heading is an h2 focus target (tabindex=-1)', st.title === 'H2' && st.tabindex === '-1');

  /* keyboard navigation via the section menu */
  await p.eval(`document.querySelector('#ad-nav a[data-sec="trainees"]').focus()`);
  await press('Tab'); /* move off then back to prove natural tab order works */
  await press('Tab', { shift: true });
  let a = await active();
  check('Shift+Tab returns focus to the menu link', a.tag === 'a' && /المتدربون/.test(a.text), JSON.stringify(a));
  await press('Enter');
  await p.waitFor(`document.querySelectorAll('#ad-view .ad-table tbody tr').length>0`, 15000, 'trainees via keyboard');
  await sleep(500);
  a = await active();
  check('Enter on a menu link opens the section and moves focus to its heading', a.id === 'ad-title', JSON.stringify(a));
  check('aria-current="page" follows the opened section', await p.eval(`document.querySelector('#ad-nav a[aria-current=page]').getAttribute('data-sec')==='trainees'`));
  check('route change is announced in the live region', (await p.eval(`document.getElementById('ad-announcer').textContent`)).indexOf('المتدربون') !== -1, await p.eval(`document.getElementById('ad-announcer').textContent`));
  check('page title follows the section', (await p.eval(`document.title`)).indexOf('المتدربون') !== -1, await p.eval(`document.title`));

  /* sortable headers are buttons with aria-sort */
  await p.eval(`document.querySelector('#ad-view .ad-sort[data-key="name"]').focus()`);
  await press('Enter');
  await sleep(300);
  a = await active();
  check('sorting by keyboard keeps focus on the same header button', a.tag === 'button' && /المتدرب/.test(a.text), JSON.stringify(a));
  check('aria-sort is set after sorting', await p.eval(`!!document.querySelector('#ad-view th[aria-sort=ascending], #ad-view th[aria-sort=descending]')`));

  /* course tabs with arrow keys (RTL: ArrowLeft = next) */
  await p.eval(`location.hash='#courses/pmp'`);
  await p.waitFor(`!!document.getElementById('ctab-files')`, 15000, 'course tabs');
  await sleep(500);
  await p.eval(`document.getElementById('ctab-files').focus()`);
  await press('ArrowLeft');
  check('ArrowLeft (RTL next) selects and focuses the next tab', (await p.eval(`document.getElementById('ctab-videos').getAttribute('aria-selected')`)) === 'true' && (await active()).id === 'ctab-videos');
  await press('ArrowLeft');
  await press('ArrowLeft');
  check('arrows wrap around the tablist', (await active()).id === 'ctab-files');
  await press('End');
  check('End jumps to the last tab', (await active()).id === 'ctab-questions');
  await press('Home');
  check('Home jumps to the first tab', (await active()).id === 'ctab-files');
  check('only the selected tab is in the tab order (roving tabindex)', await p.eval(`[].filter.call(document.querySelectorAll('.pf-tabs [role=tab]'),function(t){return t.tabIndex===0}).length===1`));

  /* confirm dialog: keyboard, focus trap, Escape */
  await p.eval(`location.hash='#messages'`);
  await p.waitFor(`document.querySelectorAll('#ad-view .ad-msgrow').length>0`, 15000, 'messages');
  await p.eval(`document.querySelector('#ad-view .ad-msgrow').focus()`);
  await press('Enter');
  await sleep(500);
  const before = await p.eval(`document.querySelectorAll('#ad-view .ad-msgrow').length`);
  await p.eval(`[].filter.call(document.querySelectorAll('#ad-view .ad-msgdetail button'),function(b){return b.textContent.trim()==='حذف'})[0].focus()`);
  await press('Enter');
  await p.waitFor(`!!document.querySelector('dialog.ad-dialog[open]')`, 5000, 'dialog');
  a = await active();
  check('dialog opens modal (showModal) with focus on the SAFE button (إلغاء) for deletions', a.inDialog && /إلغاء/.test(a.text), JSON.stringify(a));
  check('dialog has accessible name and description', await p.eval(`(function(){var d=document.querySelector('dialog.ad-dialog'); return !!document.getElementById(d.getAttribute('aria-labelledby')) && !!document.getElementById(d.getAttribute('aria-describedby'))})()`));
  for (let i = 0; i < 4; i++) { await press('Tab'); a = await active(); if (!a.inDialog) break; }
  check('Tab never leaves the modal dialog (focus trap)', a.inDialog, JSON.stringify(a));
  await press('Escape');
  await sleep(500);
  check('Escape closes the dialog without deleting', (await p.eval(`!document.querySelector('dialog.ad-dialog')`)) && (await p.eval(`document.querySelectorAll('#ad-view .ad-msgrow').length`)) === before);
  a = await active();
  check('focus returns to the button that opened the dialog', a.tag === 'button' && a.text === 'حذف', JSON.stringify(a));

  /* form submission with Enter, and checkbox with Space */
  await p.eval(`location.hash='#settings'`);
  await p.waitFor(`document.querySelectorAll('#ad-view .ad-two form').length>=2`, 15000, 'settings');
  await sleep(600);
  const name = await p.eval(`document.querySelector('#ad-view .ad-two .ad-card:nth-child(2) input[type=text]').value`);
  await p.eval(`document.querySelector('#ad-view .ad-two .ad-card:nth-child(2) input[type=text]').focus()`);
  await press('Enter');
  await p.waitFor(`!!document.querySelector('#ad-view .ad-two .ad-card:nth-child(2) .pf-msg.ok')`, 10000, 'profile saved via Enter');
  check('Enter inside a form field submits it (profile saved, status message shown)', true);
  check('success message is a role=status live region', await p.eval(`document.querySelector('#ad-view .ad-two .ad-card:nth-child(2) .pf-msg.ok').getAttribute('role')==='status'`));
  await p.eval(`document.querySelector('#ad-view .ad-two .ad-card:nth-child(2) input[type=text]').value=''`);
  await p.eval(`document.querySelector('#ad-view .ad-two .ad-card:nth-child(2) input[type=text]').focus()`);
  await press('Enter');
  await sleep(400);
  check('validation error is linked with aria-describedby and aria-invalid', await p.eval(`(function(){var i=document.querySelector('#ad-view .ad-two .ad-card:nth-child(2) input[type=text]'); var e=document.getElementById(i.id+'-err'); return i.getAttribute('aria-invalid')==='true' && !e.hidden && i.getAttribute('aria-describedby').indexOf(e.id)!==-1})()`));
  check('invalid field receives focus after a failed submit', (await active()).tag === 'input');
  await p.eval(`document.querySelector('#ad-view .ad-two .ad-card:nth-child(2) input[type=text]').value=${JSON.stringify(name)}`);
  await p.eval(`location.hash='#enrollments'`);
  await p.waitFor(`document.querySelectorAll('#ad-view .ad-pick input:not(:disabled)').length>0`, 15000, 'picks');
  await p.eval(`document.querySelector('#ad-view .ad-pick input:not(:disabled)').focus()`);
  await press(' ');
  check('Space toggles a trainee checkbox in the enrollment picker', await p.eval(`document.querySelector('#ad-view .ad-pick input:not(:disabled)').checked`));
  check('selected count is announced (role=status text updates)', (await p.eval(`document.querySelector('#ad-view .ad-count-t[role=status]').textContent`)).indexOf('المحدّد') !== -1);

  /* focus ring is visible for keyboard users */
  await p.eval(`document.getElementById('ad-logout').focus()`);
  await press('Tab');
  const ring = await p.eval(`(function(){var a=document.activeElement; var c=getComputedStyle(a); return {w:parseFloat(c.outlineWidth), style:c.outlineStyle, tag:a.tagName}})()`);
  check('keyboard focus ring is drawn (outline >= 2px)', ring.w >= 2 && ring.style !== 'none', JSON.stringify(ring));

  /* accessible names + id uniqueness on every section */
  const routes = ['stats', 'trainees', 'trainees/a4000000-0000-4000-8000-00000000000b', 'enrollments', 'courses', 'courses/pmp', 'courses/pmp/questions', 'messages', 'blog', 'blog/a4300000-0000-4000-8000-000000000001', 'settings'];
  for (const r of routes) {
    await p.eval(`location.hash='#${r}'`);
    await sleep(2300);
    const audit = await p.eval(`(function(){
      var bad=[]; var els=document.querySelectorAll('#main a[href], #main button, #main input:not([type=hidden]), #main select, #main textarea, #main [role=tab]');
      function name(e){
        var n=(e.getAttribute('aria-label')||'').trim(); if(n) return n;
        var lb=e.getAttribute('aria-labelledby'); if(lb){ var t=lb.split(' ').map(function(i){var x=document.getElementById(i); return x? x.textContent:''}).join(' ').trim(); if(t) return t; }
        if(e.id){ var l=document.querySelector('label[for="'+e.id+'"]'); if(l && l.textContent.trim()) return l.textContent.trim(); }
        var wl=e.closest('label'); if(wl && wl.textContent.trim()) return wl.textContent.trim();
        if(e.tagName!=='INPUT' && e.tagName!=='SELECT' && e.tagName!=='TEXTAREA'){ var t2=e.textContent.trim(); if(t2) return t2; }
        return (e.getAttribute('title')||'').trim();
      }
      [].forEach.call(els,function(e){ if(e.closest('[hidden]')) return; if(!name(e)) bad.push(e.tagName.toLowerCase()+'.'+(e.className||'')+'#'+(e.id||'')); });
      var ids={}; var dup=[]; [].forEach.call(document.querySelectorAll('[id]'),function(e){ if(ids[e.id]) dup.push(e.id); ids[e.id]=1; });
      var svgBad=[].filter.call(document.querySelectorAll('#main svg'),function(s){ return s.getAttribute('aria-hidden')!=='true'; }).length;
      var imgBad=[].filter.call(document.querySelectorAll('#main img'),function(i){ return !i.hasAttribute('alt'); }).length;
      var posTab=[].filter.call(document.querySelectorAll('#main [tabindex]'),function(e){ return parseInt(e.getAttribute('tabindex'),10)>0; }).length;
      return {unnamed:bad.slice(0,5), dup:dup.slice(0,5), svgBad:svgBad, imgBad:imgBad, posTab:posTab, count:els.length};
    })()`);
    check(`a11y audit "${r.slice(0, 22)}": all ${audit.count} controls named, ids unique, icons hidden, no positive tabindex`, audit.unnamed.length === 0 && audit.dup.length === 0 && audit.svgBad === 0 && audit.imgBad === 0 && audit.posTab === 0, JSON.stringify(audit));
  }
  const errs = p.errors.filter((e) => !/favicon\.ico/.test(e));
  check('no console errors during the keyboard/a11y run', errs.length === 0, JSON.stringify(errs.slice(0, 3)));
} catch (e) { console.log('ERR', e.message); try { await p.shot(path.join(SHOTS, 'err-a11y.png')); } catch (x) { /* ignore */ } }
summary();
await adm.close();
