# admin-users (Edge Function)

Account controls for the trainer panel that need the Auth Admin API. **Admin only.**

- Endpoint: `POST /functions/v1/admin-users`, JSON body `{ action, user_id, ...}`, `Authorization: Bearer <admin session JWT>`.
- Deploy with **verify_jwt = false** (the JWT is verified in code and the caller must be an ACTIVE admin in `public.profiles`).
- Secrets: none to add. `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` are provided by Supabase. Optional: `ALLOWED_ORIGIN`, `SITE_URL` (default `https://ahmedaldeib91.github.io`).
- Password reset by e-mail uses the project's Auth e-mail settings (set a custom SMTP before heavy use).

## Actions
| action | body | notes |
|---|---|---|
| `get` | – | email, confirmed, last sign-in, banned_until, role, status (not audited) |
| `send_reset` | – | e-mail with a reset link to `<SITE_URL>/account/` |
| `set_password` | `password` (8..72) | only non-admin targets or the caller; never logged |
| `confirm_email` | – | marks the e-mail confirmed |
| `set_email` | `email` | only non-admin targets or the caller; marks confirmed |
| `ban` / `unban` | – | blocks / allows sign-in; never admins, never the caller |
| `set_role` | `role: admin`, `confirm: true` | promote a trainee only; never the caller, never an existing admin (demotion is a database operation by design) |
| `delete_user` | `confirm: true` | never admins, never the caller |

Responses: `{ ok: true, data }` or `{ ok: false, error: <code> }` (codes: auth_required, invalid_token, forbidden, rate_limited, invalid_action, invalid_user_id, user_not_found, account_has_no_email, mail_failed, weak_password, invalid_email, email_taken, forbidden_on_admin, forbidden_on_self, confirm_required, invalid_role, no_change, server_error).

Every changing action writes `audit_log` (`action = admin_user.<action>`, `entity = users`, never the password). Rate limit: 30 actions / minute / admin (counted from `audit_log`).

Deploy: Supabase Dashboard → Edge Functions → New function `admin-users` (paste `index.ts`, JWT verification OFF), or `supabase functions deploy admin-users --no-verify-jwt`.
