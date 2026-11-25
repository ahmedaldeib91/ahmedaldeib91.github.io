import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'files');
fs.mkdirSync(dir, { recursive: true });
const pdf = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n';
fs.writeFileSync(path.join(dir, 'p4 test (1).pdf'), pdf);
fs.writeFileSync(path.join(dir, 'p4-test.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
fs.writeFileSync(path.join(dir, 'مستند عربي.pdf'), pdf);
fs.writeFileSync(path.join(dir, 'bad.exe'), 'MZ-not-allowed');
fs.writeFileSync(path.join(dir, 'empty.pdf'), '');
fs.writeFileSync(path.join(dir, 'big.pdf'), Buffer.alloc(52428801)); /* 50 MiB + 1 byte */
fs.writeFileSync(path.join(dir, 'p4-media.webm'), Buffer.from('1A45DFA3', 'hex')); /* tiny fake webm header, only used for client-side type checks */
fs.writeFileSync(path.join(dir, 'p4-img.gif'), Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
console.log(fs.readdirSync(dir).map((f) => f + ' ' + fs.statSync(path.join(dir, f)).size).join('\n'));
