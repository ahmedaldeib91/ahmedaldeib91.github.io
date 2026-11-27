// admin-users — Supabase Edge Function (Deno)
// Account-level controls for the trainer panel that need the Auth Admin API (service role):
//   get | send_reset | set_password | confirm_email | set_email | ban | unban | set_role | delete_user
// ADMIN ONLY. Deploy with verify_jwt = false (the project uses publishable keys); the caller's JWT is verified
// in code and the caller must be an ACTIVE admin in public.profiles. Every call is written to audit_log
// (never with passwords) and rate-limited (30 actions / minute / admin, counted from audit_log).
// Guard rails (enforced here, not only in the UI):
//   * set_password / set_email: only on non-admin accounts or on the caller himself
//   * ban / unban / delete_user: never on admins, never on the caller
//   * set_role: only trainee -> admin (needs { confirm: true }); never on the caller, never on an admin (no API demotion)
//   * delete_user needs { confirm: true }
// See README.md in this folder for the API contract and the deploy steps.

import { createClient } from "npm:@supabase/supabase-js@2.49.1";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ALLOWED_ORIGIN = (Deno.env.get("ALLOWED_ORIGIN") ?? "").trim() || "https://ahmedaldeib91.github.io";
const SITE_URL = (Deno.env.get("SITE_URL") ?? "").trim() || "https://ahmedaldeib91.github.io";

const MAX_BODY_BYTES = 4 * 1024;
const ACTIONS_PER_MINUTE = 30;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"']+@[^\s@<>()[\]\\,;:"']+\.[^\s@<>()[\]\\,;:"']{2,}$/;
const BAN_FOREVER = "876000h"; // ~100 years

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

function reply(status: number, body: Json, origin: string | null): Response {
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

async function readJsonBody(req: Request): Promise<Json> {
  const ctype = (req.headers.get("content-type") ?? "").toLowerCase();
  if (!ctype.startsWith("application/json")) throw new HttpError(415, "content_type_must_be_json");
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, "body_too_large");
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, "body_too_large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid_json");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HttpError(400, "invalid_json");
  return parsed as Json;
}

function bearer(req: Request): string {
  const m = /^Bearer\s+([A-Za-z0-9._-]{20,4096})$/.exec(req.headers.get("authorization") ?? "");
  if (!m) throw new HttpError(401, "auth_required");
  return m[1];
}

Deno.serve(async (req: Request): Promise<Response> => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (req.method !== "POST") return reply(405, { ok: false, error: "method_not_allowed" }, origin);
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) return reply(500, { ok: false, error: "server_error" }, origin);

  try {
    const token = bearer(req);
    const body = await readJsonBody(req);

    // --- who is calling: verify the JWT, then require an ACTIVE admin profile
    const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: u, error: uerr } = await anon.auth.getUser(token);
    if (uerr || !u?.user?.id) throw new HttpError(401, "invalid_token");
    const callerId = u.user.id;

    const svc = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: me } = await svc.from("profiles").select("id, role, status").eq("id", callerId).maybeSingle();
    if (!me || me.role !== "admin" || me.status !== "active") throw new HttpError(403, "forbidden");

    // --- rate limit (from audit_log)
    const since = new Date(Date.now() - 60_000).toISOString();
    const { count } = await svc.from("audit_log").select("id", { count: "exact", head: true })
      .eq("actor_id", callerId).like("action", "admin_user.%").gte("created_at", since);
    if ((count ?? 0) >= ACTIONS_PER_MINUTE) throw new HttpError(429, "rate_limited");

    // --- request
    const action = typeof body.action === "string" ? body.action : "";
    const target = typeof body.user_id === "string" ? body.user_id : "";
    if (!["get", "send_reset", "set_password", "confirm_email", "set_email", "ban", "unban", "set_role", "delete_user"].includes(action)) {
      throw new HttpError(400, "invalid_action");
    }
    if (!UUID_RE.test(target)) throw new HttpError(400, "invalid_user_id");
    const self = target === callerId;

    const { data: tp } = await svc.from("profiles").select("id, role, status").eq("id", target).maybeSingle();
    if (!tp) throw new HttpError(404, "user_not_found");
    const targetIsAdmin = tp.role === "admin";
    const { data: au, error: aerr } = await svc.auth.admin.getUserById(target);
    if (aerr || !au?.user) throw new HttpError(404, "user_not_found");
    const authUser = au.user;

    const audit = async (details: Json) => {
      await svc.from("audit_log").insert({
        actor_id: callerId, action: `admin_user.${action}`, entity: "users", entity_id: target, details,
      });
    };
    const fail = (code: string, status = 403) => { throw new HttpError(status, code); };

    let data: Json = {};

    if (action === "get") {
      data = {
        email: authUser.email ?? null,
        email_confirmed_at: authUser.email_confirmed_at ?? null,
        last_sign_in_at: authUser.last_sign_in_at ?? null,
        banned_until: (authUser as unknown as { banned_until?: string | null }).banned_until ?? null,
        created_at: authUser.created_at ?? null,
        role: tp.role,
        status: tp.status,
      };
      // reading is not audited (no change); everything below is
    } else if (action === "send_reset") {
      if (!authUser.email) fail("account_has_no_email", 400);
      const { error } = await anon.auth.resetPasswordForEmail(authUser.email!, { redirectTo: `${SITE_URL}/account/` });
      if (error) fail("mail_failed", 502);
      await audit({});
    } else if (action === "set_password") {
      if (targetIsAdmin && !self) fail("forbidden_on_admin");
      const pw = typeof body.password === "string" ? body.password : "";
      if (pw.length < 8 || pw.length > 72) fail("weak_password", 400);
      const { error } = await svc.auth.admin.updateUserById(target, { password: pw });
      if (error) fail("server_error", 502);
      await audit({}); // never the password
    } else if (action === "confirm_email") {
      const { error } = await svc.auth.admin.updateUserById(target, { email_confirm: true });
      if (error) fail("server_error", 502);
      await audit({});
    } else if (action === "set_email") {
      if (targetIsAdmin && !self) fail("forbidden_on_admin");
      const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      if (email.length < 6 || email.length > 254 || !EMAIL_RE.test(email)) fail("invalid_email", 400);
      const { error } = await svc.auth.admin.updateUserById(target, { email, email_confirm: true });
      if (error) fail(/already|registered|exists/i.test(error.message) ? "email_taken" : "server_error", /already|registered|exists/i.test(error.message) ? 409 : 502);
      await audit({ old_email: authUser.email ?? null, new_email: email });
    } else if (action === "ban" || action === "unban") {
      if (self) fail("forbidden_on_self");
      if (targetIsAdmin) fail("forbidden_on_admin");
      const { error } = await svc.auth.admin.updateUserById(target, { ban_duration: action === "ban" ? BAN_FOREVER : "none" });
      if (error) fail("server_error", 502);
      await audit({});
    } else if (action === "set_role") {
      if (self) fail("forbidden_on_self");
      // an admin can never be demoted through the API: otherwise one admin could demote another and then
      // reset that account's password/e-mail (account takeover). Demotion stays a deliberate database operation.
      if (targetIsAdmin) fail("forbidden_on_admin");
      const role = body.role === "admin" || body.role === "trainee" ? body.role : "";
      if (!role) fail("invalid_role", 400);
      if (role === "admin" && body.confirm !== true) fail("confirm_required", 400);
      if (role === tp.role) fail("no_change", 400);
      const { error } = await svc.from("profiles").update({ role }).eq("id", target);
      if (error) fail("server_error", 502);
      await audit({ old_role: tp.role, new_role: role });
    } else if (action === "delete_user") {
      if (self) fail("forbidden_on_self");
      if (targetIsAdmin) fail("forbidden_on_admin");
      if (body.confirm !== true) fail("confirm_required", 400);
      const { error } = await svc.auth.admin.deleteUser(target);
      if (error) fail("server_error", 502);
      await audit({ email: authUser.email ?? null });
    }

    return reply(200, { ok: true, data }, origin);
  } catch (e) {
    if (e instanceof HttpError) return reply(e.status, { ok: false, error: e.code }, origin);
    console.error("admin-users unexpected error", e instanceof Error ? e.message : String(e));
    return reply(500, { ok: false, error: "server_error" }, origin);
  }
});
