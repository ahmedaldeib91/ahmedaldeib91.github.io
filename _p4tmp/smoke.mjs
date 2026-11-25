import { launch } from './cdp.mjs';
const b = await launch();
try {
  await b.page.goto('http://localhost:4174/account/');
  console.log('title:', await b.page.eval('document.title'));
  console.log('ua:', await b.page.eval('navigator.userAgent'));
  console.log('dialog support:', await b.page.eval('typeof HTMLDialogElement'));
} finally { await b.close(); }
