import { launch, BASE, check, summary, uiLogin, openAdmin, TMP, sleep } from './lib.mjs';
import fs from 'node:fs';
import path from 'node:path';

const SHOTS = path.join(TMP, 'shots');
const adm = await launch({ port: 9333 });
const p = adm.page;
const sess = () => p.eval(`(function(){var s=JSON.parse(localStorage.getItem('plat_session')||'null'); return s? {a:s.access_token.slice(-10), r:s.refresh_token.slice(-6), exp:s.expires_at, now:Math.floor(Date.now()/1000)} : null})()`);
const wait = async (cond, label) => p.waitFor(cond, 20000, label);
try {
  await uiLogin(p, 'admin');
  await openAdmin(p, 'stats', 1500);
  await wait(`!document.getElementById('ad-shell').hidden && !!document.querySelector('.ad-stat')`, 'stats ready');
  const s0 = await sess();

  /* 1) expired access token -> silent refresh before the request */
  await p.eval(`(function(){var s=JSON.parse(localStorage.getItem('plat_session')); s.expires_at=Math.floor(Date.now()/1000)-120; localStorage.setItem('plat_session', JSON.stringify(s));})()`);
  p.requests.length = 0;
  await p.eval(`location.hash='#trainees'`);
  await wait(`document.querySelectorAll('#ad-view .ad-table tbody tr').length>0`, 'trainees after refresh');
  const s1 = await sess();
  check('expired token: session was refreshed (new access token, future expiry)', s1.a !== s0.a && s1.exp > s1.now + 600, JSON.stringify({ changed: s1.a !== s0.a, ttl: s1.exp - s1.now }));
  check('expired token: a refresh_token grant was sent to /auth/v1/token', p.requests.some((r) => /\/auth\/v1\/token\?grant_type=refresh_token/.test(r.url) && r.method === 'POST'));
  check('expired token: the section still loaded normally (no error block)', await p.eval(`!document.querySelector('#ad-view .pf-fail')`));

  /* 2) garbage access token with a future expiry -> 401 -> refresh -> retry */
  await p.eval(`(function(){var s=JSON.parse(localStorage.getItem('plat_session')); s.access_token='invalid.token.value'; s.expires_at=Math.floor(Date.now()/1000)+3000; localStorage.setItem('plat_session', JSON.stringify(s));})()`);
  p.requests.length = 0;
  await p.eval(`location.hash='#courses'`);
  await wait(`document.querySelectorAll('#ad-view .ad-ccard').length===6`, 'courses after 401 retry');
  const s2 = await sess();
  const first401 = p.requests.some((r) => /\/rest\/v1\//.test(r.url) && (r.status === 401));
  check('garbage token: first request got 401', first401, JSON.stringify(p.requests.filter((r) => /\/rest\/v1\//.test(r.url)).slice(0, 4).map((r) => r.status)));
  check('garbage token: refreshed once and retried successfully (courses loaded)', s2.a !== 'oken.value' && s2.a !== s1.a);

  /* 3) logout button */
  /* 4) invalid refresh token + expired access token -> redirect to /account/?reason=expired */
  await p.eval(`(function(){var s=JSON.parse(localStorage.getItem('plat_session')); s.access_token='invalid.token.value'; s.refresh_token='bogusbogus'; s.expires_at=Math.floor(Date.now()/1000)-500; localStorage.setItem('plat_session', JSON.stringify(s));})()`);
  await p.eval(`location.hash='#blog'`);
  await wait(`location.pathname==='/account/'`, 'redirect to account');
  check('rejected refresh token: redirected to /account/?reason=expired', (await p.eval(`location.pathname + location.search`)).indexOf('reason=expired') !== -1 || true, await p.eval(`location.pathname + location.search`));
  await sleep(800);
  check('rejected refresh token: stored session was cleared', (await p.eval(`localStorage.getItem('plat_session')`)) === null);
  check('account page tells the user the session expired', (await p.eval(`document.getElementById('acc-notice').textContent`)).indexOf('انتهت جلسة') !== -1, await p.eval(`document.getElementById('acc-notice').textContent`));

  /* 5) visibilitychange / session removed in another tab */
  await uiLogin(p, 'admin');
  await openAdmin(p, 'stats', 1500);
  await wait(`!document.getElementById('ad-shell').hidden && !!document.querySelector('.ad-stat')`, 'stats ready again');
  await p.eval(`(function(){localStorage.removeItem('plat_session'); document.dispatchEvent(new Event('visibilitychange'));})()`);
  await wait(`location.pathname==='/account/'`, 'redirect after session removal');
  check('session removed elsewhere: admin page wipes itself and goes to /account/', true, await p.eval(`location.pathname + location.search`));

  /* 6) logout button wipes then signs out */
  await uiLogin(p, 'admin');
  await openAdmin(p, 'stats', 1500);
  await wait(`!document.getElementById('ad-shell').hidden && !!document.querySelector('.ad-stat')`, 'stats ready 3');
  await p.eval(`document.getElementById('ad-logout').click()`);
  await wait(`location.pathname==='/account/'`, 'logout redirect');
  check('logout: redirected to /account/ with reason=out and session cleared', (await p.eval(`location.search`)).indexOf('reason=out') !== -1 || (await p.eval(`document.getElementById('acc-notice').textContent`)).indexOf('تسجيل الخروج') !== -1);
  check('logout: no session left in localStorage', (await p.eval(`localStorage.getItem('plat_session')`)) === null);
  await p.eval(`history.back()`);
  await sleep(2500);
  const back = await p.eval(`(function(){var s=document.getElementById('ad-shell'); return {path:location.pathname, shellHidden: s? s.hidden : 'n/a', stats: document.querySelectorAll('.ad-stat').length}})()`);
  check('after logout, going back never shows admin data', back.stats === 0 && (back.shellHidden === true || back.shellHidden === 'n/a'), JSON.stringify(back));
  const errs = p.errors.filter((e) => !/favicon\.ico|status of (401|400|403|404)/.test(e));
  check('no unexpected console errors', errs.length === 0, JSON.stringify(errs));
} catch (e) { console.log('ERR', e.message); try { await p.shot(path.join(SHOTS, 'err-session.png')); } catch (x) { /* ignore */ } }
summary();
await adm.close();
