import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = path.dirname(fileURLToPath(import.meta.url));
const pw = () => 'P4' + crypto.randomBytes(15).toString('base64url') + '!x9';
const creds = {
  admin: { email: 'p4-admin@example.com', password: pw() },
  a: { email: 'p4-trainee-a@example.com', password: pw() },
  b: { email: 'p4-trainee-b@example.com', password: pw() }
};
fs.writeFileSync(path.join(dir, 'creds.json'), JSON.stringify(creds, null, 2));
console.log(JSON.stringify({ admin: creds.admin.password, a: creds.a.password, b: creds.b.password }));
