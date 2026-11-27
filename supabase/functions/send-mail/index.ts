// send-mail — Supabase Edge Function (Deno)
// Single POST endpoint, JSON body, three actions: contact | interest | welcome.
// Mail goes through Gmail SMTP (smtp.gmail.com:465, TLS) with an App Password.
// Deploy with verify_jwt = false: `contact` is anonymous; `interest` and `welcome` verify the
// caller's JWT in code. See README.md in this folder for the API contract and secrets.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.49.1";
import nodemailer from "npm:nodemailer@6.9.16";

// ------------------------------------------------------------------ config
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const GMAIL_USER = (Deno.env.get("GMAIL_USER") ?? "").trim();
const GMAIL_APP_PASSWORD = (Deno.env.get("GMAIL_APP_PASSWORD") ?? "").replace(/\s+/g, "");
const MAIL_TO = (Deno.env.get("MAIL_TO") ?? "").trim() || GMAIL_USER;
const ALLOWED_ORIGIN = (Deno.env.get("ALLOWED_ORIGIN") ?? "").trim() || "https://ahmedaldeib91.github.io";
const IP_HASH_SALT = Deno.env.get("IP_HASH_SALT") ?? "";

const SITE_URL = "https://ahmedaldeib91.github.io";
const DASHBOARD_URL = `${SITE_URL}/dashboard/`;
const SENDER_NAME = "منصة أحمد الديب للتدريب";

const MAX_BODY_BYTES = 20 * 1024;
const CONTACT_PER_IP_PER_HOUR = 5;
const INTEREST_PER_USER_PER_HOUR = 10;
const INTEREST_DEDUPE_MINUTES = 10;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COURSE_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// stricter than the DB check (no spaces, quotes, brackets, commas, CR/LF)
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"']+@[^\s@<>()[\]\\,;:"']+\.[^\s@<>()[\]\\,;:"']{2,}$/;

// ------------------------------------------------------------------ helpers
type Json = Record<string, unknown>;

class HttpError extends Error {
  constructor(public status: number, public code: string) {
    super(code);
  }
}

function corsHeaders(origin: string | null): Record<string, string> {
  const h: Record<string, string> = { "Vary": "Origin" };
  if (origin && origin === ALLOWED_ORIGIN) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Methods"] = "POST, OPTIONS";
    h["Access-Control-Allow-Headers"] = "authorization, apikey, content-type, x-client-info";
    h["Access-Control-Max-Age"] = "86400";
  }
  return h;
}

function json(status: number, body: Json, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(origin),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// removes control chars (keeps \n and \t when multiline) and bidi override/isolate chars
function cleanText(v: unknown, multiline = false): string {
  if (typeof v !== "string") return "";
  let s = v.normalize("NFC").replace(/\r\n?/g, "\n");
  s = s.replace(/[‪-‮⁦-⁩‎‏؜]/g, "");
  s = multiline
    ? s.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "")
    : s.replace(/[\u0000-\u001F\u007F]/g, " ");
  return s.trim();
}

// for anything that ends up in a mail header (subject, display names)
function headerSafe(s: string, max: number): string {
  return s.replace(/[\r\n\u0000-\u001F\u007F]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, max);
}

function isEmail(s: string): boolean {
  return s.length >= 6 && s.length <= 254 && EMAIL_RE.test(s);
}

async function readJsonBody(req: Request): Promise<Json> {
  const ctype = (req.headers.get("content-type") ?? "").toLowerCase();
  if (!ctype.startsWith("application/json")) throw new HttpError(415, "content_type_must_be_json");

  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, "body_too_large");
  if (!req.body) throw new HttpError(400, "invalid_json");

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      try { await reader.cancel(); } catch { /* ignore */ }
      throw new HttpError(413, "body_too_large");
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buf));
  } catch {
    throw new HttpError(400, "invalid_json");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HttpError(400, "invalid_json");
  return parsed as Json;
}

// Client IP. cf-connecting-ip is set by Cloudflare and overwrites any client-supplied value,
// so it is preferred. x-forwarded-for's first entry can be supplied by the client, so it is
// only a fallback (the DB global cap still bounds abuse in that case).
function clientIp(req: Request): string {
  const cf = (req.headers.get("cf-connecting-ip") ?? "").trim();
  if (cf) return cf.slice(0, 64);
  const real = (req.headers.get("x-real-ip") ?? "").trim();
  if (real) return real.slice(0, 64);
  const xff = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim();
  return (xff || "unknown").slice(0, 64);
}

// HMAC-SHA256(ip). Key = IP_HASH_SALT secret, or (fallback) the service-role key, which is
// always present server-side and never leaves it. Output: 64 lowercase hex chars.
async function ipHash(ip: string): Promise<string> {
  const keyMaterial = IP_HASH_SALT || `send-mail-ip-pepper|${SUPABASE_SERVICE_ROLE_KEY}`;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(keyMaterial), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`ip|${ip}`));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function bearer(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+([A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+)$/.exec(h.trim());
  return m ? m[1] : null;
}

function serviceClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Verifies the user JWT with Supabase Auth and returns the user plus a client scoped to it.
async function requireUser(req: Request) {
  const token = bearer(req);
  if (!token) throw new HttpError(401, "auth_required");
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await userClient.auth.getUser(token);
  if (error || !data?.user) throw new HttpError(401, "invalid_token");
  return { user: data.user, userClient };
}

function isRateLimitError(e: { code?: string; message?: string } | null): boolean {
  return !!e && (e.code === "P0001" || (e.message ?? "").startsWith("rate_limited"));
}

// ------------------------------------------------------------------ mail
type MailResult = { mailed: true } | { mailed: false; reason: "mail_not_configured" | "mail_failed" };

let transporter: ReturnType<typeof nodemailer.createTransport> | null = null;

function mailConfigured(): boolean {
  return !!GMAIL_USER && !!GMAIL_APP_PASSWORD && isEmail(GMAIL_USER) && isEmail(MAIL_TO);
}

async function sendMail(opts: {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: { name: string; address: string };
}): Promise<MailResult> {
  if (!mailConfigured()) return { mailed: false, reason: "mail_not_configured" };
  try {
    transporter ??= nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
    await transporter.sendMail({
      from: { name: SENDER_NAME, address: GMAIL_USER },
      to: opts.to,
      replyTo: opts.replyTo
        ? { name: headerSafe(opts.replyTo.name, 100), address: opts.replyTo.address }
        : undefined,
      subject: headerSafe(opts.subject, 200),
      text: opts.text,
      html: opts.html,
      textEncoding: "base64",
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    return { mailed: true };
  } catch (e) {
    transporter = null;
    console.error("send-mail: smtp failure", (e as { code?: string })?.code ?? "unknown");
    return { mailed: false, reason: "mail_failed" };
  }
}

// RTL, UTF-8 mail layout. Every dynamic value must already be HTML-escaped by the caller.
function layout(titleHtml: string, rowsHtml: string, footerHtml = ""): string {
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"></head>` +
    `<body style="margin:0;padding:24px;background:#f4f6f8;font-family:Tahoma,Arial,sans-serif;direction:rtl;text-align:right;color:#1f2933">` +
    `<div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:10px;padding:24px;border:1px solid #e4e7eb">` +
    `<h2 style="margin:0 0 16px;font-size:20px;color:#0b4f6c">${titleHtml}</h2>${rowsHtml}${footerHtml}` +
    `</div></body></html>`;
}

function row(labelAr: string, valueHtml: string): string {
  return `<p style="margin:0 0 10px;line-height:1.7"><strong>${escapeHtml(labelAr)}:</strong> ` +
    `<span dir="auto">${valueHtml}</span></p>`;
}

function block(labelAr: string, text: string): string {
  return `<p style="margin:16px 0 6px"><strong>${escapeHtml(labelAr)}:</strong></p>` +
    `<div dir="auto" style="white-space:pre-wrap;line-height:1.8;background:#f8fafc;border:1px solid #e4e7eb;border-radius:8px;padding:12px">${escapeHtml(text)}</div>`;
}

// ------------------------------------------------------------------ actions
async function handleContact(req: Request, body: Json, origin: string | null): Promise<Response> {
  // honeypot: bots fill every field. Pretend success, store nothing, send nothing.
  if (typeof body.website === "string" ? body.website.trim() !== "" : body.website != null) {
    return json(200, { ok: true, mailed: false }, origin);
  }

  const name = cleanText(body.name);
  const email = cleanText(body.email).toLowerCase();
  const subject = cleanText(body.subject);
  const message = cleanText(body.message, true);

  if (!isEmail(email)) throw new HttpError(400, "invalid_email");
  if (name.length > 100) throw new HttpError(400, "invalid_name");
  if (subject.length > 150) throw new HttpError(400, "invalid_subject");
  if (message.length < 10 || message.length > 2000) throw new HttpError(400, "invalid_message");

  const db = serviceClient();
  const hash = await ipHash(clientIp(req));

  const since = new Date(Date.now() - 3600_000).toISOString();
  const { count, error: cErr } = await db
    .from("contact_messages")
    .select("id", { count: "exact", head: true })
    .eq("ip_hash", hash)
    .eq("kind", "contact")
    .gte("created_at", since);
  if (cErr) {
    console.error("send-mail: contact count failed", cErr.code);
    throw new HttpError(500, "server_error");
  }
  if ((count ?? 0) >= CONTACT_PER_IP_PER_HOUR) throw new HttpError(429, "rate_limited");

  const displayName = name || "زائر";
  const { error: iErr } = await db.from("contact_messages").insert({
    kind: "contact",
    name: displayName,
    email,
    subject: subject || null,
    message,
    status: "new",
    ip_hash: hash,
  });
  if (iErr) {
    if (isRateLimitError(iErr)) throw new HttpError(429, "rate_limited");
    console.error("send-mail: contact insert failed", iErr.code);
    throw new HttpError(500, "server_error");
  }

  const mailSubject = `رسالة تواصل جديدة: ${subject || displayName}`;
  const html = layout(
    "رسالة جديدة من نموذج «تواصل معنا»",
    row("الاسم", escapeHtml(displayName)) +
      row("البريد", escapeHtml(email)) +
      (subject ? row("الموضوع", escapeHtml(subject)) : "") +
      block("الرسالة", message),
    `<p style="margin:20px 0 0;color:#616e7c;font-size:13px">الرد على هذه الرسالة يصل مباشرة إلى المرسل.</p>`,
  );
  const text = `رسالة جديدة من نموذج تواصل معنا\nالاسم: ${displayName}\nالبريد: ${email}\n` +
    (subject ? `الموضوع: ${subject}\n` : "") + `\n${message}\n`;

  const mail = await sendMail({
    to: MAIL_TO, subject: mailSubject, html, text,
    replyTo: { name: displayName, address: email },
  });
  return json(200, { ok: true, ...mail }, origin);
}

async function handleInterest(req: Request, body: Json, origin: string | null): Promise<Response> {
  const { user } = await requireUser(req);

  const courseId = cleanText(body.course_id);
  if (!courseId || courseId.length > 40 || !COURSE_ID_RE.test(courseId)) throw new HttpError(400, "invalid_course_id");

  const db = serviceClient();

  const { data: profile, error: pErr } = await db
    .from("profiles").select("full_name, phone, status").eq("id", user.id).maybeSingle();
  if (pErr) {
    console.error("send-mail: profile read failed", pErr.code);
    throw new HttpError(500, "server_error");
  }
  if (!profile) throw new HttpError(401, "invalid_token");
  if (profile.status !== "active") throw new HttpError(403, "account_suspended");

  const email = cleanText(user.email ?? "").toLowerCase();
  if (!isEmail(email)) throw new HttpError(400, "account_has_no_email");

  const { data: course, error: crErr } = await db
    .from("courses").select("id, title_ar, title_en, published").eq("id", courseId).maybeSingle();
  if (crErr) {
    console.error("send-mail: course read failed", crErr.code);
    throw new HttpError(500, "server_error");
  }
  if (!course || !course.published) throw new HttpError(400, "unknown_course");

  // dedupe: same user + course within 10 minutes -> return the stored message, no second mail
  const dedupeSince = new Date(Date.now() - INTEREST_DEDUPE_MINUTES * 60_000).toISOString();
  const { data: recent, error: dErr } = await db
    .from("contact_messages").select("message")
    .eq("kind", "interest").eq("user_id", user.id).eq("course_id", courseId)
    .gte("created_at", dedupeSince)
    .order("created_at", { ascending: false }).limit(1);
  if (dErr) {
    console.error("send-mail: dedupe read failed", dErr.code);
    throw new HttpError(500, "server_error");
  }
  if (recent && recent.length > 0) {
    return json(200, { ok: true, message: recent[0].message, mailed: false, reason: "duplicate" }, origin);
  }

  const hourSince = new Date(Date.now() - 3600_000).toISOString();
  const { count, error: cErr } = await db
    .from("contact_messages").select("id", { count: "exact", head: true })
    .eq("kind", "interest").eq("user_id", user.id).gte("created_at", hourSince);
  if (cErr) {
    console.error("send-mail: interest count failed", cErr.code);
    throw new HttpError(500, "server_error");
  }
  if ((count ?? 0) >= INTEREST_PER_USER_PER_HOUR) throw new HttpError(429, "rate_limited");

  const fullName = cleanText(profile.full_name).slice(0, 120) || email.split("@")[0].slice(0, 120) || "متدرب";
  const phone = cleanText(profile.phone ?? "").slice(0, 40);
  const titleAr = cleanText(course.title_ar);
  const titleEn = cleanText(course.title_en);

  const message =
    `مرحبًا أ. أحمد،\n` +
    `أرغب في الاشتراك في دورة: ${titleAr} (${titleEn})\n` +
    `الاسم: ${fullName}\n` +
    `البريد: ${email}\n` +
    `الهاتف: ${phone || "غير مسجل"}\n` +
    `رمز الدورة: ${courseId}`;
  const subject = `اهتمام بدورة: ${titleAr}`.slice(0, 200);

  const { error: iErr } = await db.from("contact_messages").insert({
    kind: "interest",
    course_id: courseId,
    user_id: user.id,
    name: fullName,
    email,
    phone: phone || null,
    subject,
    message,
    status: "new",
    ip_hash: await ipHash(clientIp(req)),
  });
  if (iErr) {
    if (isRateLimitError(iErr)) throw new HttpError(429, "rate_limited");
    console.error("send-mail: interest insert failed", iErr.code);
    throw new HttpError(500, "server_error");
  }

  const html = layout(
    "طلب اشتراك/اهتمام بدورة",
    row("الدورة", `${escapeHtml(titleAr)} (${escapeHtml(titleEn)})`) +
      row("رمز الدورة", escapeHtml(courseId)) +
      row("اسم المتدرب", escapeHtml(fullName)) +
      row("البريد", escapeHtml(email)) +
      row("الهاتف", escapeHtml(phone || "غير مسجل")) +
      block("نص الرسالة", message),
    `<p style="margin:20px 0 0;color:#616e7c;font-size:13px">لتفعيل الدورة: لوحة المدرب ← الاشتراكات. الرد على هذه الرسالة يصل إلى المتدرب.</p>`,
  );
  const mail = await sendMail({
    to: MAIL_TO,
    subject: `${subject} — ${fullName}`,
    html,
    text: `${message}\n`,
    replyTo: { name: fullName, address: email },
  });
  return json(200, { ok: true, message, ...mail }, origin);
}

async function handleWelcome(req: Request, body: Json, origin: string | null): Promise<Response> {
  const targetId = cleanText(body.user_id);
  const courseId = cleanText(body.course_id);

  const { user, userClient } = await requireUser(req);

  // Admin check evaluated AS THE CALLER (RLS: a user reads only his own profile row).
  // Same rule as private.is_admin(): profiles.role = 'admin' and status = 'active'.
  const { data: me, error: meErr } = await userClient
    .from("profiles").select("role, status").eq("id", user.id).maybeSingle();
  if (meErr) {
    console.error("send-mail: admin check failed", meErr.code);
    throw new HttpError(500, "server_error");
  }
  if (!me || me.role !== "admin" || me.status !== "active") throw new HttpError(403, "forbidden");

  if (!UUID_RE.test(targetId)) throw new HttpError(400, "invalid_user_id");
  if (!courseId || courseId.length > 40 || !COURSE_ID_RE.test(courseId)) throw new HttpError(400, "invalid_course_id");

  const db = serviceClient();
  const { data: enr, error: eErr } = await db
    .from("enrollments").select("id")
    .eq("user_id", targetId).eq("course_id", courseId).eq("status", "active").maybeSingle();
  if (eErr) {
    console.error("send-mail: enrollment read failed", eErr.code);
    throw new HttpError(500, "server_error");
  }
  if (!enr) throw new HttpError(400, "no_active_enrollment");

  const [{ data: course, error: cErr }, { data: prof, error: pErr }, { data: au, error: uErr }] = await Promise.all([
    db.from("courses").select("title_ar, title_en").eq("id", courseId).maybeSingle(),
    db.from("profiles").select("full_name").eq("id", targetId).maybeSingle(),
    db.auth.admin.getUserById(targetId),
  ]);
  if (cErr || pErr || uErr || !course || !au?.user) {
    console.error("send-mail: welcome lookup failed", cErr?.code ?? pErr?.code ?? uErr?.status ?? "missing");
    throw new HttpError(500, "server_error");
  }
  const to = cleanText(au.user.email ?? "").toLowerCase();
  if (!isEmail(to)) return json(200, { ok: true, mailed: false, reason: "trainee_has_no_email" }, origin);

  const name = cleanText(prof?.full_name ?? "").slice(0, 120);
  const titleAr = cleanText(course.title_ar);
  const titleEn = cleanText(course.title_en);
  const greeting = name ? `أهلًا ${name}،` : "أهلًا بك،";

  const html = layout(
    `تم تفعيل دورتك: ${escapeHtml(titleAr)}`,
    `<p style="margin:0 0 12px;line-height:1.8">${escapeHtml(greeting)}</p>` +
      `<p style="margin:0 0 12px;line-height:1.8">يسعدني إبلاغك بأنه تم تفعيل اشتراكك في دورة ` +
      `<strong>${escapeHtml(titleAr)}</strong> <span dir="ltr">(${escapeHtml(titleEn)})</span>. ` +
      `تجد ملفات الدورة وفيديوهاتها وأسئلتها في لوحة المتدرب.</p>` +
      `<p style="margin:20px 0"><a href="${escapeHtml(DASHBOARD_URL)}" ` +
      `style="display:inline-block;background:#0b4f6c;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px">الدخول إلى لوحة المتدرب</a></p>` +
      `<p style="margin:0 0 8px;color:#616e7c;font-size:13px" dir="ltr">${escapeHtml(DASHBOARD_URL)}</p>`,
    `<p style="margin:20px 0 0;line-height:1.8">بالتوفيق،<br>أحمد الديب</p>`,
  );
  const text = `${greeting}\nتم تفعيل اشتراكك في دورة ${titleAr} (${titleEn}).\n` +
    `ادخل إلى لوحة المتدرب: ${DASHBOARD_URL}\n\nبالتوفيق،\nأحمد الديب\n`;

  const mail = await sendMail({
    to,
    subject: `تم تفعيل دورتك: ${titleAr}`,
    html,
    text,
    replyTo: isEmail(MAIL_TO) ? { name: "أحمد الديب", address: MAIL_TO } : undefined,
  });
  return json(200, { ok: true, ...mail }, origin);
}

// ------------------------------------------------------------------ entry
Deno.serve(async (req: Request): Promise<Response> => {
  const origin = req.headers.get("origin");

  // Browsers always send Origin on cross-origin requests; refuse other sites outright.
  if (origin !== null && origin !== ALLOWED_ORIGIN) {
    return json(403, { ok: false, error: "origin_not_allowed" }, null);
  }
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (req.method !== "POST") {
    const r = json(405, { ok: false, error: "method_not_allowed" }, origin);
    r.headers.set("Allow", "POST, OPTIONS");
    return r;
  }
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("send-mail: missing platform env");
    return json(500, { ok: false, error: "server_error" }, origin);
  }

  try {
    const body = await readJsonBody(req);
    switch (body.action) {
      case "contact":
        return await handleContact(req, body, origin);
      case "interest":
        return await handleInterest(req, body, origin);
      case "welcome":
        return await handleWelcome(req, body, origin);
      default:
        throw new HttpError(400, "invalid_action");
    }
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { ok: false, error: e.code }, origin);
    console.error("send-mail: unexpected", (e as Error)?.name ?? "error");
    return json(500, { ok: false, error: "server_error" }, origin);
  }
});
