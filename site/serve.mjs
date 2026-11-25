/* serve.mjs — خادم محلي بسيط لمعاينة مجلد dist (للتطوير فقط، وليس جزءًا من الموقع المنشور).
   التشغيل: node serve.mjs (أو انقر serve.bat) ثم افتح http://localhost:4174/
   لا يبني الموقع: شغّل build.bat أولًا، وأعد البناء بعد كل تعديل ثم حدّث الصفحة.
   روابط نظيفة كما في الاستضافة: /pmi/ تفتح dist/pmi/index.html، و /pmi تُحوَّل إلى /pmi/ .
   Node فقط بلا أي حزم. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const PORT = 4174;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.pdf': 'application/pdf',
};

const statOrNull = (p) => { try { return fs.statSync(p); } catch { return null; } };

function sendText(res, status, body, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  res.end(body);
}

function sendFile(req, res, file, st, status = 200) {
  res.writeHead(status, {
    'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': st.size,
    'Cache-Control': 'no-store',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

function notFound(req, res) {
  console.log(`[404] ${req.url}`);
  const page = path.join(ROOT, '404.html');
  const st = statOrNull(page);
  if (st && st.isFile()) return sendFile(req, res, page, st, 404);
  sendText(res, 404, 'الصفحة غير موجودة (404)\nNot found');
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });

  let url, pathname;
  try {
    url = new URL(req.url, 'http://localhost');
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return sendText(res, 400, 'Bad Request');
  }
  if (pathname.includes('\0') || pathname.includes(':')) return sendText(res, 400, 'Bad Request');

  const target = path.join(ROOT, pathname);
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) return sendText(res, 403, 'Forbidden');

  let file = target;
  let st = statOrNull(file);
  if (st && st.isDirectory()) {
    if (!url.pathname.endsWith('/')) {
      res.writeHead(301, { Location: url.pathname + '/' + url.search, 'Cache-Control': 'no-store' });
      return res.end();
    }
    file = path.join(target, 'index.html');
    st = statOrNull(file);
  }
  if (!st || !st.isFile()) return notFound(req, res);
  sendFile(req, res, file, st);
});

if (!statOrNull(ROOT)) {
  console.error('مجلد dist غير موجود بعد. شغّل build.bat أولًا ثم أعد تشغيل المعاينة.');
  process.exit(1);
}
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`المنفذ ${PORT} مستخدم من برنامج آخر (ربما المعاينة تعمل في نافذة أخرى). أغلقها ثم أعد المحاولة.`);
  else console.error(`تعذّر تشغيل المعاينة: ${e.message}`);
  process.exit(1);
});
server.listen(PORT, () => {
  console.log('معاينة الموقع تعمل الآن.');
  console.log(`  الرابط: http://localhost:${PORT}/`);
  console.log(`  المجلد: ${ROOT}`);
  console.log('  لإيقاف المعاينة اضغط Ctrl+C أو أغلق هذه النافذة.');
});
