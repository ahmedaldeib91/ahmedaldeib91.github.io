/* Minimal Chrome DevTools Protocol helper (no libraries). Test tooling only, deleted at the end. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

export const TMP = path.dirname(fileURLToPath(import.meta.url));
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export { sleep };

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

export class Page {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = []; this.logs = []; this.errors = []; this.requests = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
      } else if (m.method) {
        this.handlers.forEach((h) => h(m));
        if (m.method === 'Runtime.consoleAPICalled') {
          const t = m.params.type;
          const text = (m.params.args || []).map((a) => a.value !== undefined ? String(a.value) : (a.description || a.type)).join(' ');
          this.logs.push({ type: t, text });
          if (t === 'error' || t === 'assert') this.errors.push('console.' + t + ': ' + text);
        } else if (m.method === 'Runtime.exceptionThrown') {
          const d = m.params.exceptionDetails;
          this.errors.push('exception: ' + (d.exception && d.exception.description || d.text));
        } else if (m.method === 'Log.entryAdded') {
          const e = m.params.entry;
          if (e.level === 'error') this.errors.push('log.error: ' + e.text + ' ' + (e.url || ''));
        } else if (m.method === 'Network.requestWillBeSent') {
          this.requests.push({ id: m.params.requestId, method: m.params.request.method, url: m.params.request.url, headers: m.params.request.headers });
        } else if (m.method === 'Network.responseReceived') {
          const r = this.requests.find((x) => x.id === m.params.requestId);
          if (r) r.status = m.params.response.status;
        }
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(fn) { this.handlers.push(fn); }
  async init() {
    await this.send('Page.enable'); await this.send('Runtime.enable'); await this.send('Log.enable'); await this.send('Network.enable'); await this.send('DOM.enable');
  }
  async eval(expr, awaitPromise = true) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('eval failed: ' + (d.exception && (d.exception.description || d.exception.value) || d.text));
    }
    return r.result.value;
  }
  async goto(url, wait = 1500) {
    await this.send('Page.navigate', { url });
    for (let i = 0; i < 100; i++) { await sleep(100); try { if (await this.eval('document.readyState') === 'complete') break; } catch (e) { /* navigating */ } }
    await sleep(wait);
  }
  async waitFor(expr, timeout = 15000, label = '') {
    const t0 = Date.now();
    let last;
    while (Date.now() - t0 < timeout) {
      try { last = await this.eval(expr); if (last) return last; } catch (e) { last = e.message; }
      await sleep(150);
    }
    throw new Error('waitFor timeout: ' + (label || expr) + ' (last=' + String(last).slice(0, 200) + ')');
  }
  async viewport(w, h, mobile = false) {
    await this.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
  }
  async shot(file, fullPage = false) {
    if (fullPage) { await this.eval(`(function(){try{window.scrollTo({top:0,left:0,behavior:'instant'})}catch(e){window.scrollTo(0,0)}})()`); await sleep(250); }
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: fullPage });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  }
  async key(key, code, mods = 0) {
    const base = { key, code: code || key, modifiers: mods, windowsVirtualKeyCode: KEYCODES[key] || 0 };
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: key.length === 1 ? key : undefined });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }
  async typeText(text) { for (const ch of text) { await this.send('Input.insertText', { text: ch }); } }
  async setFiles(selector, files) {
    const doc = await this.send('DOM.getDocument', { depth: 1 });
    const q = await this.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
    if (!q.nodeId) throw new Error('no node for ' + selector);
    await this.send('DOM.setFileInputFiles', { nodeId: q.nodeId, files });
  }
}
const KEYCODES = { Tab: 9, Enter: 13, Escape: 27, ' ': 32, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35 };

export async function launch({ port = 9333, width = 1280, height = 900 } = {}) {
  const userData = fs.mkdtempSync(path.join(TMP, 'profile-'));
  const proc = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`, '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking', '--disable-sync', `--window-size=${width},${height}`, 'about:blank'
  ], { stdio: 'ignore' });
  let ver = null;
  for (let i = 0; i < 60; i++) { await sleep(250); try { ver = await getJson(`http://127.0.0.1:${port}/json/version`); break; } catch (e) { /* not yet */ } }
  if (!ver) { proc.kill(); throw new Error('chrome did not start'); }
  const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
  const t = targets.find((x) => x.type === 'page');
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const page = new Page(ws);
  await page.init();
  await page.viewport(width, height);
  return {
    page,
    async close() { try { ws.close(); } catch (e) { /* ok */ } proc.kill(); await sleep(500); try { fs.rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (e) { /* ok */ } }
  };
}
