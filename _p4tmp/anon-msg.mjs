import fs from 'node:fs';
const site = JSON.parse(fs.readFileSync('C:/Users/MICEOSOF/Desktop/Website/site/data/site.json', 'utf8'));
const url = site.supabase.url + '/rest/v1/contact_messages';
const msgs = [
  { name: 'زائر اختبار P4', email: 'visitor-p4@example.com', phone: '+966 50 123 4567', subject: 'استفسار عن دورة PMP', message: 'السلام عليكم، أريد معرفة موعد الدفعة القادمة.\nشكرًا لكم.' },
  { name: '<img src=x onerror="window.__xss=4">', email: 'xss-p4@example.com', phone: null, subject: '<script>window.__xss=5</script>', message: '<b>نص عريض</b> <img src=x onerror="window.__xss=6"> javascript:alert(1)' },
  { name: 'زائر ثالث P4', email: 'third-p4@example.com', phone: '0501234567', subject: null, message: 'رسالة ثالثة بلا موضوع.' }
];
for (const m of msgs) {
  const r = await fetch(url, { method: 'POST', headers: { apikey: site.supabase.key, 'Content-Type': 'application/json', Prefer: 'return=minimal', 'x-forwarded-for': '203.0.113.77' }, body: JSON.stringify(m) });
  console.log(r.status, (await r.text()).slice(0, 200));
}
