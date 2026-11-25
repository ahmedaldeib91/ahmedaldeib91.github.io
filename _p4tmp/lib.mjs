import fs from 'node:fs';
import path from 'node:path';
import { launch, sleep, TMP } from './cdp.mjs';
export { launch, sleep, TMP };
export const BASE = 'http://localhost:4174';
export const creds = JSON.parse(fs.readFileSync(path.join(TMP, 'creds.json'), 'utf8'));
export const SHOTS = path.join(TMP, 'shots');

let pass = 0, fail = 0;
export const results = [];
export function check(name, ok, detail = '') {
  if (ok) pass++; else fail++;
  results.push({ name, ok, detail });
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  [' + String(detail).slice(0, 300) + ']' : ''));
}
export function summary() { console.log(`\n== ${pass} passed, ${fail} failed ==`); return fail; }

/* real UI login through /account/ (test credentials of throwaway fixtures; never printed) */
export async function uiLogin(page, who) {
  const c = creds[who];
  await page.goto(BASE + '/account/', 800);
  await page.eval(`(function(){var e=document.getElementById('log-email'),p=document.getElementById('log-pass');e.value=${JSON.stringify(c.email)};p.value=${JSON.stringify(c.password)};e.dispatchEvent(new Event('input',{bubbles:true}));p.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('log-submit').click();})()`);
  await page.waitFor(`location.pathname === '/dashboard/'`, 20000, 'login redirect');
}
export async function openAdmin(page, hash = '', wait = 1200) {
  await page.goto(BASE + '/admin/' + (hash ? '#' + hash : ''), wait);
}
export async function logout(page) {
  await page.eval(`(function(){var b=document.getElementById('ad-logout')||document.getElementById('dash-logout'); if(b) b.click();})()`);
  await sleep(1500);
}
/* helper: set value of an input/textarea/select by selector and fire events */
export async function setVal(page, sel, val) {
  await page.eval(`(function(){var e=document.querySelector(${JSON.stringify(sel)}); if(!e) throw new Error('no el ${sel.replace(/'/g, '')}'); e.focus(); e.value=${JSON.stringify(val)}; e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
}
export async function click(page, sel) {
  await page.eval(`(function(){var e=document.querySelector(${JSON.stringify(sel)}); if(!e) throw new Error('no el ${sel.replace(/'/g, '')}'); e.click();})()`);
}
/* click the first element matching selector whose text includes `text` */
export async function clickText(page, sel, text) {
  const ok = await page.eval(`(function(){var l=[].slice.call(document.querySelectorAll(${JSON.stringify(sel)})).filter(function(e){return (e.textContent||'').indexOf(${JSON.stringify(text)})!==-1 && !e.disabled}); if(!l.length) return false; l[0].click(); return true;})()`);
  if (!ok) throw new Error('clickText: no ' + sel + ' with text ' + text);
}
export const text = (page, sel) => page.eval(`(function(){var e=document.querySelector(${JSON.stringify(sel)}); return e? e.textContent.trim():null;})()`);
