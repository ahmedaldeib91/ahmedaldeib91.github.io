/* =====================================================================
   platform-api.js — العميل المشترك لمنصة المتدربين (Supabase عبر fetch فقط)
   ملف عادي بلا وحدات ولا مكتبات. يُحمَّل بـ defer قبل account.js وdashboard.js ويعرّف window.Platform.
   يحتاج fetch وasync/await (ES2017): المتصفحات نفسها التي تدعم fetch.

   1) الإعداد: خصائص data على عنصر <main> (يملؤها البناء من data/site.json، فلا قيمة مكتوبة هنا):
        data-sb-url  عنوان المشروع (https)          data-sb-key  المفتاح العام publishable (ترويسة apikey)
        data-wa      رابط واتساب الأساسي (https://wa.me/...)
      المفتاح العام آمن في المتصفح (تحميه سياسات RLS في قاعدة البيانات). مفتاح service_role لا يوضع هنا أبدًا.
   2) الجلسة: localStorage بمفتاح واحد هو plat_session = {access_token, refresh_token, expires_at, user:{id,email}}.
      تُجدَّد تلقائيًا قبل انتهائها بدقيقة، وعند 401 يُجدَّد مرة ثم يُعاد الطلب، وإن فشل التجديد نهائيًا تُمسح الجلسة
      ويُرمى خطأ kind="session" (تحوّل الصفحة صاحبة الطلب إلى /account/). لا يُكتب أي توكن في السجل ولا في الرابط.
   3) الأخطاء: كل خطأ يُحوَّل إلى ApiError برسالة عربية جاهزة للعرض (message) وبتصنيف kind؛ لا يظهر للمستخدم
      أي نص قادم من الخادم.
   4) الواجهة: دوال بناء DOM آمنة (h) لا تستعمل innerHTML أبدًا، وتبويبات ARIA، ورسائل ومدقّقات مدخلات مشتركة.
   5) (P4) إضافات لوحة المدرب /admin/: rest.upsert/remove/rpc/count، وstorage.upload (XMLHttpRequest لأنه الوحيد الذي يعطي تقدّم الرفع)
      وstorage.remove/publicUrl/publicPath، وvideoEmbed (انتقلت إلى هنا من dashboard.js لتتشارك فيها اللوحتان)، وconfig.url.
      كلها تمر بالجلسة نفسها (تجديد تلقائي وإعادة محاولة)، والصلاحية الحقيقية تقررها سياسات RLS في القاعدة لا هذا الملف.
   ===================================================================== */
(function () {
  'use strict';

  const doc = document;
  const win = window;

  const SESSION_KEY = 'plat_session';
  const SKEW = 60;           /* ثوانٍ: تُجدَّد الجلسة قبل انتهائها بهذه المدة */
  const TIMEOUT_MS = 20000;  /* مهلة كل طلب */

  /* ---------- 1) الإعداد ---------- */
  function readConfig() {
    const out = { ok: false, url: '', key: '', whatsapp: '' };
    const el = doc.querySelector('[data-sb-url]');
    if (!el) return out;
    try {
      const u = new URL(el.getAttribute('data-sb-url') || '');
      if (u.protocol === 'https:' && !u.username && !u.password) out.url = u.origin;
    } catch (e) { /* عنوان غير صالح */ }
    const k = (el.getAttribute('data-sb-key') || '').trim();
    if (/^[A-Za-z0-9._-]{20,400}$/.test(k)) out.key = k;
    try {
      const w = new URL(el.getAttribute('data-wa') || '');
      if (w.protocol === 'https:' && (w.hostname === 'wa.me' || w.hostname === 'api.whatsapp.com')) out.whatsapp = w.origin + w.pathname;
    } catch (e) { /* بلا واتساب */ }
    out.ok = !!(out.url && out.key);
    return out;
  }
  const cfg = readConfig();

  /* ---------- 2) الأخطاء ---------- */
  const MSG = {
    network: 'تعذّر الاتصال بالخادم. تحقّق من اتصالك بالإنترنت ثم أعد المحاولة.',
    session: 'انتهت جلسة الدخول. سجّل الدخول من جديد.',
    rate: 'تجاوزتَ عدد المحاولات المسموح به. انتظر بضع دقائق ثم أعد المحاولة.',
    forbidden: 'ليست لديك صلاحية لتنفيذ هذا الإجراء.',
    notfound: 'العنصر المطلوب غير موجود.',
    validation: 'تعذّر تنفيذ الطلب. تحقّق من البيانات المدخلة وحاول مجددًا.',
    server: 'الخدمة غير متاحة مؤقتًا. حاول بعد قليل.',
    config: 'إعدادات المنصة غير مكتملة. تواصل مع المدرب.',
    storage: 'المتصفح يمنع حفظ بيانات الدخول (التخزين المحلي). فعّله أو اخرج من وضع التصفح الخاص ثم أعد المحاولة.',
    other: 'حدث خطأ غير متوقع. حاول مرة أخرى.'
  };
  /* رمز الخطأ القادم من Auth/REST/Storage ← [التصنيف، الرسالة] */
  const CODES = {
    invalid_credentials: ['auth', 'البريد الإلكتروني أو كلمة المرور غير صحيحة.'],
    email_not_confirmed: ['auth', 'لم يُؤكَّد بريدك الإلكتروني بعد. افتح رسالة التأكيد التي وصلتك واضغط الرابط الموجود فيها، ثم سجّل الدخول.'],
    user_banned: ['auth', 'هذا الحساب موقوف حاليًا. تواصل مع المدرب.'],
    weak_password: ['validation', 'كلمة المرور ضعيفة. اختر كلمة أقوى: ٨ أحرف على الأقل تجمع بين الحروف والأرقام.'],
    same_password: ['validation', 'كلمة المرور الجديدة يجب أن تختلف عن الحالية.'],
    email_address_invalid: ['validation', 'عنوان البريد الإلكتروني غير صالح.'],
    validation_failed: ['validation', MSG.validation],
    bad_json: ['validation', MSG.validation],
    signup_disabled: ['forbidden', 'التسجيل مغلق حاليًا. تواصل مع المدرب.'],
    user_already_exists: ['validation', 'تعذّر إنشاء الحساب بهذه البيانات.'],
    email_exists: ['validation', 'تعذّر إنشاء الحساب بهذه البيانات.'],
    reauthentication_needed: ['auth', 'لأسباب أمنية سجّل الدخول من جديد ثم أعد المحاولة.'],
    reauthentication_not_valid: ['auth', 'لأسباب أمنية سجّل الدخول من جديد ثم أعد المحاولة.'],
    otp_expired: ['auth', 'الرابط غير صالح أو انتهت صلاحيته. اطلب رابطًا جديدًا.'],
    over_request_rate_limit: ['rate', MSG.rate],
    over_email_send_rate_limit: ['rate', 'أُرسلت رسائل كثيرة إلى هذا البريد. انتظر بضع دقائق ثم أعد المحاولة.'],
    over_sms_send_rate_limit: ['rate', MSG.rate],
    session_expired: ['session', MSG.session],
    session_not_found: ['session', MSG.session],
    refresh_token_not_found: ['session', MSG.session],
    refresh_token_already_used: ['session', MSG.session],
    bad_jwt: ['session', MSG.session],
    no_authorization: ['session', MSG.session],
    PGRST301: ['session', MSG.session],
    PGRST303: ['session', MSG.session],
    '42501': ['forbidden', MSG.forbidden],
    '22023': ['validation', 'تعذّر حفظ المحاولة. حدّث الصفحة ثم أعد المحاولة.'],
    '23505': ['validation', 'هذا العنصر موجود مسبقًا.']
  };

  class ApiError extends Error {
    constructor(kind, message, status, code) {
      super(message);
      this.name = 'ApiError';
      this.kind = kind;            /* network | session | auth | rate | forbidden | notfound | validation | server | config | storage | other */
      this.status = status || 0;
      this.code = code || '';
    }
  }
  const sessionError = () => new ApiError('session', MSG.session, 401, 'session');

  function toError(status, body) {
    let code = '';
    if (body && typeof body === 'object') {
      if (typeof body.error_code === 'string') code = body.error_code;
      else if (typeof body.code === 'string') code = body.code;
    }
    if (code && Object.prototype.hasOwnProperty.call(CODES, code)) return new ApiError(CODES[code][0], CODES[code][1], status, code);
    if (status === 401) return sessionError();
    if (status === 403) return new ApiError('forbidden', MSG.forbidden, status, code);
    if (status === 404) return new ApiError('notfound', MSG.notfound, status, code);
    if (status === 429) return new ApiError('rate', MSG.rate, status, code);
    if (status >= 500) return new ApiError('server', MSG.server, status, code);
    if (status === 400 || status === 409 || status === 422) return new ApiError('validation', MSG.validation, status, code);
    return new ApiError('other', MSG.other, status, code);
  }

  /* ---------- 3) الجلسة ---------- */
  const nowSec = () => Math.floor(Date.now() / 1000);

  function loadSession() {
    try {
      const raw = win.localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      if (!s || typeof s.access_token !== 'string' || typeof s.refresh_token !== 'string' ||
          !s.user || typeof s.user.id !== 'string' || typeof s.expires_at !== 'number') return null;
      return s;
    } catch (e) { return null; }
  }
  function saveSession(s) {
    try {
      win.localStorage.setItem(SESSION_KEY, JSON.stringify({
        access_token: s.access_token, refresh_token: s.refresh_token, expires_at: s.expires_at,
        user: { id: s.user.id, email: s.user.email }
      }));
    } catch (e) { return false; }
    const back = loadSession();
    return !!(back && back.access_token === s.access_token);
  }
  function clearSession() {
    try { win.localStorage.removeItem(SESSION_KEY); } catch (e) { /* التخزين محجوب */ }
  }
  /* جلسة من استجابة Auth (الاستجابة تحمل user كاملًا؛ نحفظ المعرّف والبريد فقط) */
  function toSession(j) {
    if (!j || typeof j.access_token !== 'string' || typeof j.refresh_token !== 'string' || !j.user || typeof j.user.id !== 'string') return null;
    const exp = Number(j.expires_at) || (nowSec() + (Number(j.expires_in) || 3600));
    return { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: exp, user: { id: j.user.id, email: String(j.user.email || '') } };
  }

  /* ---------- 4) الطلبات ---------- */
  function buildUrl(path, query) {
    const u = new URL(cfg.url + path);
    if (query) {
      Object.keys(query).forEach(function (k) {
        if (query[k] !== undefined && query[k] !== null) u.searchParams.set(k, String(query[k]));
      });
    }
    return u.toString();
  }

  /* طلب واحد بلا منطق جلسة. يرمي ApiError(network) عند انقطاع الاتصال أو انتهاء المهلة. */
  async function request(method, path, o) {
    o = o || {};
    if (!cfg.ok) throw new ApiError('config', MSG.config, 0, 'config');
    const headers = { apikey: cfg.key, Accept: 'application/json' };
    if (o.body !== undefined) headers['Content-Type'] = 'application/json';
    if (o.token) headers.Authorization = 'Bearer ' + o.token;
    if (o.headers) Object.assign(headers, o.headers);
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(function () { ctl.abort(); }, o.timeout || TIMEOUT_MS) : 0;
    try {
      const res = await fetch(buildUrl(path, o.query), {
        method: method,
        headers: headers,
        body: o.body === undefined ? undefined : JSON.stringify(o.body),
        signal: ctl ? ctl.signal : undefined,
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer'
      });
      const text = await res.text();
      let json = null;
      if (text) { try { json = JSON.parse(text); } catch (e) { json = null; } }
      return { status: res.status, ok: res.ok, json: json, headers: res.headers };
    } catch (e) {
      throw new ApiError('network', MSG.network, 0, 'network');
    } finally {
      clearTimeout(timer);
    }
  }

  /* تجديد الجلسة: طلب واحد في الوقت نفسه، ومراعاة تبويب آخر جدّد الجلسة قبلنا */
  let refreshing = null;
  function refreshSession(failedToken) {
    if (refreshing) return refreshing;
    const p = doRefresh(failedToken);
    refreshing = p;
    const done = function () { if (refreshing === p) refreshing = null; };
    p.then(done, done);
    return p;
  }
  async function doRefresh(failedToken) {
    const s = loadSession();
    if (!s) throw sessionError();
    if (s.expires_at - nowSec() > SKEW && s.access_token !== failedToken) return s; /* تبويب آخر جدّدها */
    const res = await request('POST', '/auth/v1/token', { query: { grant_type: 'refresh_token' }, body: { refresh_token: s.refresh_token } });
    if (res.ok) {
      const ns = toSession(res.json);
      if (!ns) throw new ApiError('server', MSG.server, res.status, 'bad_response');
      saveSession(ns);
      return ns;
    }
    const cur = loadSession();
    if (cur && cur.refresh_token !== s.refresh_token) return cur; /* تبويب آخر بدّل التوكن أثناء انتظارنا */
    if (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404) {
      clearSession(); /* التوكن مرفوض نهائيًا */
      throw sessionError();
    }
    throw toError(res.status, res.json); /* 429 أو 5xx: تبقى الجلسة كما هي */
  }

  async function accessToken() {
    const s = loadSession();
    if (!s) throw sessionError();
    if (s.expires_at - nowSec() > SKEW) return s.access_token;
    return (await refreshSession(null)).access_token;
  }

  /* طلب بتوكن المستخدم: عند 401 يُجدَّد التوكن مرة واحدة ثم يُعاد الطلب */
  async function authed(method, path, o) {
    o = o || {};
    let token = await accessToken();
    let res = await request(method, path, Object.assign({}, o, { token: token }));
    if (res.status === 401) {
      token = (await refreshSession(token)).access_token;
      res = await request(method, path, Object.assign({}, o, { token: token }));
      if (res.status === 401) { clearSession(); throw sessionError(); }
    }
    if (!res.ok) throw toError(res.status, res.json);
    return res;
  }

  /* ---------- 5) Auth ---------- */
const callbackUrl = () => win.location.origin +
  (doc.documentElement.getAttribute('data-base-path') || '') + '/account/';
  const auth = {
    /* دخول بكلمة المرور؛ يحفظ الجلسة ويعيدها */
    async signIn(email, password) {
      const res = await request('POST', '/auth/v1/token', { query: { grant_type: 'password' }, body: { email: email, password: password } });
      if (!res.ok) throw toError(res.status, res.json);
      const s = toSession(res.json);
      if (!s) throw new ApiError('server', MSG.server, res.status, 'bad_response');
      if (!saveSession(s)) throw new ApiError('storage', MSG.storage, 0, 'storage');
      return s;
    },
    /* تسجيل جديد. لا تُحفظ أي جلسة تعود في الاستجابة (لا دخول قبل تأكيد البريد). */
    async signUp(email, password, data) {
      const res = await request('POST', '/auth/v1/signup', { query: { redirect_to: callbackUrl() }, body: { email: email, password: password, data: data } });
      if (!res.ok) throw toError(res.status, res.json);
      return { sessionIgnored: !!(res.json && res.json.access_token) };
    },
    async recover(email) {
      const res = await request('POST', '/auth/v1/recover', { query: { redirect_to: callbackUrl() }, body: { email: email } });
      if (!res.ok) throw toError(res.status, res.json);
    },
    async resend(email) {
      const res = await request('POST', '/auth/v1/resend', { query: { redirect_to: callbackUrl() }, body: { type: 'signup', email: email } });
      if (!res.ok) throw toError(res.status, res.json);
    },
    /* التحقق من توكن (يعيد {id,email}) */
    async getUser(token) {
      const res = await request('GET', '/auth/v1/user', { token: token });
      if (!res.ok) throw toError(res.status, res.json);
      if (!res.json || typeof res.json.id !== 'string') throw new ApiError('server', MSG.server, res.status, 'bad_response');
      return { id: res.json.id, email: String(res.json.email || '') };
    },
    /* تغيير كلمة المرور. token اختياري: بدونه تُستعمل جلسة المستخدم المحفوظة. */
    async updatePassword(password, token) {
      const res = token
        ? await request('PUT', '/auth/v1/user', { token: token, body: { password: password } })
        : await authed('PUT', '/auth/v1/user', { body: { password: password } });
      if (!res.ok) throw toError(res.status, res.json);
    },
    /* تبنّي جلسة جاءت من رابط التأكيد: نتحقق من التوكن عند الخادم ثم نحفظه */
    async adopt(t) {
      const user = await auth.getUser(t.access_token);
      const exp = Number(t.expires_at) || (nowSec() + (Number(t.expires_in) || 3600));
      const s = { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: exp, user: user };
      if (!saveSession(s)) throw new ApiError('storage', MSG.storage, 0, 'storage');
      return s;
    },
    /* خروج: إبطال الجلسة عند الخادم (محاولة بلا انتظار طويل) ثم مسح التخزين دائمًا */
    async signOut() {
      const s = loadSession();
      clearSession();
      if (!s || !cfg.ok) return;
      try {
        await request('POST', '/auth/v1/logout', { query: { scope: 'local' }, token: s.access_token, timeout: 4000 });
      } catch (e) { /* الخروج المحلي يكفي */ }
    },
    /* رابط العودة من البريد: #access_token=…&type=signup أو #error=… ؛ يعيد null إن لم يكن رابط Auth */
    parseHash(hash) {
      const raw = String(hash || '').replace(/^#/, '');
      if (!/(^|&)(access_token|error|error_code)=/.test(raw)) return null;
      const p = new URLSearchParams(raw);
      return {
        type: p.get('type') || '',
        access_token: p.get('access_token') || '',
        refresh_token: p.get('refresh_token') || '',
        expires_in: p.get('expires_in') || '',
        expires_at: p.get('expires_at') || '',
        error: p.get('error') || '',
        error_code: p.get('error_code') || ''
      };
    }
  };

  /* ---------- 6) REST (PostgREST) ---------- */
  const TABLE_RE = /^[a-z_]+$/;
  const hasFilter = function (q) { return !!q && typeof q === 'object' && Object.keys(q).some(function (k) { return q[k] !== undefined && q[k] !== null && q[k] !== ''; }); };
  const rest = {
    async select(table, query) {
      if (!TABLE_RE.test(table)) throw new ApiError('other', MSG.other, 0, 'bad_table');
      const r = await authed('GET', '/rest/v1/' + table, { query: query });
      return Array.isArray(r.json) ? r.json : [];
    },
    async insert(table, row) {
      if (!TABLE_RE.test(table)) throw new ApiError('other', MSG.other, 0, 'bad_table');
      const r = await authed('POST', '/rest/v1/' + table, { body: row, headers: { Prefer: 'return=representation' } });
      return Array.isArray(r.json) ? r.json : [];
    },
    async update(table, query, patch) {
      if (!TABLE_RE.test(table)) throw new ApiError('other', MSG.other, 0, 'bad_table');
      const r = await authed('PATCH', '/rest/v1/' + table, { query: query, body: patch, headers: { Prefer: 'return=representation' } });
      return Array.isArray(r.json) ? r.json : [];
    },
    /* (P4) إدراج أو تحديث بمفتاح تعارض واحد: onConflict اسم العمود الفريد */
    async upsert(table, row, onConflict) {
      if (!TABLE_RE.test(table) || !/^[a-z_]+$/.test(onConflict || '')) throw new ApiError('other', MSG.other, 0, 'bad_table');
      const r = await authed('POST', '/rest/v1/' + table, { query: { on_conflict: onConflict }, body: row, headers: { Prefer: 'return=representation,resolution=merge-duplicates' } });
      return Array.isArray(r.json) ? r.json : [];
    },
    /* (P4) حذف: يرفض بلا شرط تصفية، ويعيد الصفوف المحذوفة فعلًا (قائمة فارغة = لم يُحذف شيء، غالبًا بسبب الصلاحيات) */
    async remove(table, query) {
      if (!TABLE_RE.test(table) || !hasFilter(query)) throw new ApiError('other', MSG.other, 0, 'bad_table');
      const r = await authed('DELETE', '/rest/v1/' + table, { query: query, headers: { Prefer: 'return=representation' } });
      return Array.isArray(r.json) ? r.json : [];
    },
    /* (P4) استدعاء دالة قاعدة البيانات (RPC)؛ query اختياري لـ limit/offset/order على الدوال التي تعيد جدولًا */
    async rpc(fn, args, query) {
      if (!/^[a-z_]+$/.test(fn || '')) throw new ApiError('other', MSG.other, 0, 'bad_fn');
      const r = await authed('POST', '/rest/v1/rpc/' + fn, { query: query, body: args || {} });
      return r.json;
    },
    /* (P4) صفحة من الصفوف مع العدد الكلي المطابق {rows, total} (total=null إن لم تصل ترويسة Content-Range) */
    async page(table, query) {
      if (!TABLE_RE.test(table)) throw new ApiError('other', MSG.other, 0, 'bad_table');
      const r = await authed('GET', '/rest/v1/' + table, { query: query, headers: { Prefer: 'count=exact' } });
      const m = /\/(\d+)\s*$/.exec((r.headers && r.headers.get('content-range')) || '');
      return { rows: Array.isArray(r.json) ? r.json : [], total: m ? Number(m[1]) : null };
    },
    /* (P4) عدد الصفوف المطابقة بلا جلبها (Prefer: count=exact من ترويسة Content-Range) */
    async count(table, query) {
      if (!TABLE_RE.test(table)) throw new ApiError('other', MSG.other, 0, 'bad_table');
      const r = await authed('GET', '/rest/v1/' + table, { query: Object.assign({ select: 'id', limit: '1' }, query || {}), headers: { Prefer: 'count=exact' } });
      const m = /\/(\d+)\s*$/.exec((r.headers && r.headers.get('content-range')) || '');
      return m ? Number(m[1]) : (Array.isArray(r.json) ? r.json.length : 0);
    }
  };

  /* ---------- 7) Storage: رابط موقّع قصير العمر لملف في دلو خاص، ورفع وحذف (للمدير) ---------- */
  const encPath = function (p) { return p.split('/').map(encodeURIComponent).join('/'); };
  function checkPath(bucket, objectPath) {
    if (!/^[a-z0-9-]+$/.test(bucket) || typeof objectPath !== 'string' || !objectPath || objectPath.indexOf('..') !== -1 ||
        objectPath.charAt(0) === '/' || /[\u0000-\u001F\u007F\\]/.test(objectPath)) {
      throw new ApiError('other', MSG.other, 0, 'bad_path');
    }
  }
  async function signedUrl(bucket, objectPath, expiresIn) {
    checkPath(bucket, objectPath);
    const r = await authed('POST', '/storage/v1/object/sign/' + bucket + '/' + encPath(objectPath), { body: { expiresIn: expiresIn || 300 } });
    const rel = r.json && (r.json.signedURL || r.json.signedUrl);
    if (typeof rel !== 'string') throw new ApiError('server', MSG.server, 0, 'bad_response');
    let full;
    try { full = new URL(cfg.url + '/storage/v1' + (rel.charAt(0) === '/' ? rel : '/' + rel)); } catch (e) { throw new ApiError('server', MSG.server, 0, 'bad_response'); }
    if (full.origin !== cfg.url) throw new ApiError('server', MSG.server, 0, 'bad_response');
    return full.toString();
  }

  /* (P4) رابط الملف في دلو عام (blog-media) وعكسه: من رابط عام يخص مشروعنا إلى مسار الكائن، وإلا null */
  function publicUrl(bucket, objectPath) {
    checkPath(bucket, objectPath);
    return cfg.url + '/storage/v1/object/public/' + bucket + '/' + encPath(objectPath);
  }
  function publicPath(url, bucket) {
    try {
      const u = new URL(String(url || ''));
      const pre = '/storage/v1/object/public/' + bucket + '/';
      if (u.origin !== cfg.url || u.pathname.indexOf(pre) !== 0 || u.search || u.hash) return null;
      const p = decodeURIComponent(u.pathname.slice(pre.length));
      return p && p.indexOf('..') === -1 ? p : null;
    } catch (e) { return null; }
  }

  const SIZE_MSG = 'حجم الملف أكبر من الحد المسموح (٥٠ ميغابايت).';
  function storageError(status, body) {
    const st = Number(body && (body.statusCode || body.status_code)) || status;
    const text = String((body && (body.message || body.error)) || '').toLowerCase();
    if (st === 413 || /exceeded the maximum|payload too large/.test(text)) return new ApiError('validation', SIZE_MSG, status, '413');
    if (st === 415 || /mime type|invalid_mime/.test(text)) return new ApiError('validation', 'نوع الملف غير مسموح به في هذا المكان.', status, '415');
    if (st === 409 || /duplicate|already exists/.test(text)) return new ApiError('validation', 'يوجد ملف بالاسم نفسه. أعد المحاولة.', status, '409');
    if (st === 403 || /row-level security|unauthorized/.test(text)) return new ApiError('forbidden', MSG.forbidden, status, '403');
    if (st === 404) return new ApiError('notfound', MSG.notfound, status, '404');
    return toError(status, body);
  }
  const isAuthFail = function (res) {
    return res.status === 401 || (res.status === 400 && /jwt|token|expired/i.test(String((res.json && (res.json.message || res.json.error)) || '')));
  };
  /* رفع واحد بـ XMLHttpRequest (وحده يعطي تقدّم الرفع). o: {contentType, onProgress(loaded,total), signal} */
  function xhrUpload(bucket, objectPath, file, token, o) {
    return new Promise(function (resolve, reject) {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', cfg.url + '/storage/v1/object/' + bucket + '/' + encPath(objectPath));
      xhr.setRequestHeader('apikey', cfg.key);
      xhr.setRequestHeader('Authorization', 'Bearer ' + token);
      xhr.setRequestHeader('Content-Type', o.contentType || file.type || 'application/octet-stream');
      xhr.setRequestHeader('x-upsert', 'false');
      xhr.setRequestHeader('cache-control', 'max-age=3600');
      xhr.timeout = 15 * 60 * 1000;
      if (xhr.upload && o.onProgress) xhr.upload.onprogress = function (e) { if (e.lengthComputable) o.onProgress(e.loaded, e.total); };
      xhr.onload = function () {
        let json = null;
        try { json = xhr.responseText ? JSON.parse(xhr.responseText) : null; } catch (e) { json = null; }
        resolve({ status: xhr.status, json: json });
      };
      xhr.onerror = xhr.ontimeout = function () { reject(new ApiError('network', MSG.network, 0, 'network')); };
      xhr.onabort = function () { reject(new ApiError('other', 'أُلغي الرفع.', 0, 'aborted')); };
      if (o.signal) {
        if (o.signal.aborted) { reject(new ApiError('other', 'أُلغي الرفع.', 0, 'aborted')); return; }
        o.signal.addEventListener('abort', function () { xhr.abort(); });
      }
      xhr.send(file);
    });
  }
  async function upload(bucket, objectPath, file, o) {
    o = o || {};
    if (!cfg.ok) throw new ApiError('config', MSG.config, 0, 'config');
    checkPath(bucket, objectPath);
    let token = await accessToken();
    let res = await xhrUpload(bucket, objectPath, file, token, o);
    if (isAuthFail(res)) { /* تجديد الجلسة مرة واحدة ثم إعادة الرفع */
      token = (await refreshSession(token)).access_token;
      res = await xhrUpload(bucket, objectPath, file, token, o);
      if (isAuthFail(res)) { clearSession(); throw sessionError(); }
    }
    if (res.status < 200 || res.status >= 300) throw storageError(res.status, res.json);
    return { path: objectPath };
  }
  /* حذف كائنات من دلو. يعيد الكائنات المحذوفة فعلًا (فارغة = لم يُحذف شيء) */
  async function removeObjects(bucket, paths) {
    if (!Array.isArray(paths) || !paths.length) return [];
    paths.forEach(function (p) { checkPath(bucket, p); });
    const r = await authed('DELETE', '/storage/v1/object/' + bucket, { body: { prefixes: paths } });
    return Array.isArray(r.json) ? r.json : [];
  }

  /* ---------- 8) أدوات مشتركة ---------- */
  const COUNTRIES = ['السعودية', 'الإمارات', 'الكويت', 'قطر', 'البحرين', 'عُمان', 'اليمن', 'العراق', 'سوريا', 'لبنان', 'الأردن', 'فلسطين',
    'مصر', 'السودان', 'ليبيا', 'تونس', 'الجزائر', 'المغرب', 'موريتانيا', 'الصومال', 'جيبوتي', 'جزر القمر', 'أخرى'];

  /* رابط يُسمح بوضعه في href/src: مسار داخلي أو http(s) فقط (لا javascript: ولا data:) */
  function safeUrl(u) {
    u = String(u == null ? '' : u).trim();
    if (!u) return null;
    if (u.charAt(0) === '#') return u;
    if (u.charAt(0) === '/' && u.charAt(1) !== '/' && u.charAt(1) !== '\\') return u;
    try {
      const p = new URL(u);
      if (p.protocol === 'https:' || p.protocol === 'http:') return p.href;
    } catch (e) { /* ليس رابطًا مطلقًا */ }
    return null;
  }

  /* رابط واتساب برسالة جاهزة (القاعدة من الإعداد، والنص يُرمَّز) */
  function waLink(text) {
    if (!cfg.whatsapp) return null;
    return cfg.whatsapp + '?text=' + encodeURIComponent(text);
  }

  /* الفيديو: التضمين فقط من مضيفين مسموحين، بعد تطبيع الرابط (يستعمله dashboard.js ولوحة المدرب admin-courses.js وadmin-blog.js).
     يعيد {src} بعنوان تضمين آمن، أو null إن لم يكن المضيف أو شكل الرابط من المسموح */
  function videoEmbed(raw) {
    let u;
    try { u = new URL(raw); } catch (e) { return null; }
    if (u.protocol !== 'https:') return null;
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const path = u.pathname;
    let m;
    let yt = '';
    if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtube-nocookie.com') {
      if (path === '/watch') yt = u.searchParams.get('v') || '';
      else if ((m = /^\/(?:embed|shorts|live|v)\/([A-Za-z0-9_-]{11})\/?$/.exec(path))) yt = m[1];
    } else if (host === 'youtu.be') {
      if ((m = /^\/([A-Za-z0-9_-]{11})\/?$/.exec(path))) yt = m[1];
    }
    if (/^[A-Za-z0-9_-]{11}$/.test(yt)) return { src: 'https://www.youtube-nocookie.com/embed/' + yt + '?rel=0' };
    if (host === 'player.vimeo.com' || host === 'vimeo.com') {
      m = host === 'vimeo.com' ? /^\/(\d{5,12})(?:\/([A-Za-z0-9]{6,20}))?\/?$/.exec(path) : /^\/video\/(\d{5,12})\/?$/.exec(path);
      if (m) {
        const hash = m[2] || u.searchParams.get('h') || '';
        return { src: 'https://player.vimeo.com/video/' + m[1] + (/^[A-Za-z0-9]{6,20}$/.test(hash) ? '?h=' + hash : '') };
      }
      return null;
    }
    if (host === 'iframe.mediadelivery.net') {
      m = /^\/(?:embed|play)\/(\d{1,10})\/([A-Za-z0-9-]{8,64})\/?$/.exec(path);
      if (m) return { src: 'https://iframe.mediadelivery.net/embed/' + m[1] + '/' + m[2] };
    }
    return null;
  }

  /* --- DOM آمن: النص دائمًا textContent، ولا معالجات مضمّنة ولا style نصي ولا srcdoc --- */
  const BLOCKED_ATTR = /^(on|style$|srcdoc$|formaction$)/i;
  function append(el, kid) {
    if (kid === null || kid === undefined || kid === false) return;
    if (Array.isArray(kid)) { kid.forEach(function (k) { append(el, k); }); return; }
    el.appendChild(kid && kid.nodeType ? kid : doc.createTextNode(String(kid)));
  }
  function h(tag, attrs, ...kids) {
    const el = doc.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        const v = attrs[k];
        if (v === undefined || v === null || v === false) return;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = String(v);
        else if (k === 'on') Object.keys(v).forEach(function (ev) { el.addEventListener(ev, v[ev]); });
        else if (k === 'dataset') Object.keys(v).forEach(function (d) { el.dataset[d] = String(v[d]); });
        else if (BLOCKED_ATTR.test(k)) return;
        else if (k === 'href' || k === 'src' || k === 'action') { const u = safeUrl(v); if (u) el.setAttribute(k, u); }
        else el.setAttribute(k, v === true ? '' : String(v));
      });
    }
    kids.forEach(function (k) { append(el, k); });
    return el;
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

  const SVGNS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z M14 3v5h5 M9 13h6 M9 17h6',
    video: 'M3 7a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M15 10l6-3v10l-6-3',
    quiz: 'M9 11l3 3 8-8 M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9',
    lock: 'M5 11h14a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z M8 11V8a4 4 0 0 1 8 0v3',
    back: 'M4 12h16 M14 6l6 6-6 6',
    logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4 M16 17l5-5-5-5 M21 12H9',
    external: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6 M15 3h6v6 M10 14L21 3',
    check: 'M5 12l5 5 9-10',
    x: 'M6 6l12 12 M18 6L6 18',
    user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2 M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
    megaphone: 'M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1z M15 9a4 4 0 0 1 0 6 M18 6.5a8 8 0 0 1 0 11',
    shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z'
  };
  function icon(name, cls) {
    const s = doc.createElementNS(SVGNS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('focusable', 'false');
    s.setAttribute('class', 'pf-ic' + (cls ? ' ' + cls : ''));
    if (ICONS[name]) {
      const p = doc.createElementNS(SVGNS, 'path');
      p.setAttribute('d', ICONS[name]);
      s.appendChild(p);
    }
    return s;
  }
  /* أيقونة واتساب من مجموعة الأيقونات المضمّنة في الترويسة (#i-wa) */
  function waIcon() {
    const s = doc.createElementNS(SVGNS, 'svg');
    s.setAttribute('class', 'si');
    s.setAttribute('aria-hidden', 'true');
    const u = doc.createElementNS(SVGNS, 'use');
    u.setAttribute('href', '#i-wa');
    s.appendChild(u);
    return s;
  }

  /* رسالة نموذج: kind = ok | err | info */
  function msg(el, kind, text) {
    if (!el) return;
    el.className = 'pf-msg ' + kind;
    el.setAttribute('role', kind === 'err' ? 'alert' : 'status');
    el.textContent = text;
    el.hidden = false;
  }
  function clearMsg(el) {
    if (!el) return;
    el.hidden = true;
    el.textContent = '';
  }
  /* خطأ حقل: عنصر الرسالة معرّفه <id الحقل>-err ويشير إليه الحقل بـ aria-describedby في الصفحة */
  function fieldError(input, text) {
    const e = doc.getElementById(input.id + '-err');
    if (text) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
    if (e) { e.textContent = text || ''; e.hidden = !text; }
  }
  function setBusy(btn, busy) {
    if (!btn) return;
    btn.disabled = !!busy;
    if (busy) btn.setAttribute('aria-busy', 'true'); else btn.removeAttribute('aria-busy');
  }
  /* نتيجة مدقّق (v.*) على حقل: يعرض الخطأ تحت الحقل ويسجّل أول حقل خاطئ في bag.first، ويعيد القيمة السليمة أو null */
  function check(input, res, bag) {
    if (res.error) { fieldError(input, res.error); if (!bag.first) bag.first = input; return null; }
    fieldError(input, '');
    return res.value;
  }
  /* معالج إرسال نموذج بلا تكرار: يعطّل الزر أثناء الطلب. يبقى معطّلًا إن أعاد fn القيمة true (انتقال الصفحة جارٍ).
     أي استثناء غير متوقع يُظهر رسالة عامة في out بدل أن يُبتلع. للمعالج الناتج دالة reset() تُعيد الزر لحاله. */
  function guard(btn, out, fn) {
    let busy = false;
    const handler = async function (e) {
      if (e && e.preventDefault) e.preventDefault();
      if (busy) return;
      busy = true;
      setBusy(btn, true);
      let keep = false;
      try { keep = (await fn(e)) === true; } catch (err) { msg(out, 'err', MSG.other); } finally {
        if (!keep) { busy = false; setBusy(btn, false); }
      }
    };
    handler.reset = function () { busy = false; setBusy(btn, false); };
    return handler;
  }

  /* تبويبات ARIA: أزرار [role=tab] تشير بـ aria-controls إلى لوحات [role=tabpanel] تُخفى بـ hidden */
  function tabs(list, opts) {
    opts = opts || {};
    const all = Array.prototype.slice.call(list.querySelectorAll('[role="tab"]'));
    function select(tab, focus) {
      all.forEach(function (t) {
        const on = t === tab;
        t.setAttribute('aria-selected', on ? 'true' : 'false');
        t.tabIndex = on ? 0 : -1;
        const p = doc.getElementById(t.getAttribute('aria-controls'));
        if (p) p.hidden = !on;
      });
      if (focus) tab.focus();
      if (opts.onSelect) opts.onSelect(tab.getAttribute('data-tab'), tab);
    }
    list.addEventListener('click', function (e) {
      const t = e.target.closest ? e.target.closest('[role="tab"]') : null;
      if (t && all.indexOf(t) !== -1) select(t, false);
    });
    list.addEventListener('keydown', function (e) {
      const i = all.indexOf(doc.activeElement);
      if (i === -1) return;
      const rtl = win.getComputedStyle(list).direction === 'rtl';
      let n = -1;
      if (e.key === (rtl ? 'ArrowLeft' : 'ArrowRight')) n = (i + 1) % all.length;
      else if (e.key === (rtl ? 'ArrowRight' : 'ArrowLeft')) n = (i - 1 + all.length) % all.length;
      else if (e.key === 'Home') n = 0;
      else if (e.key === 'End') n = all.length - 1;
      if (n === -1) return;
      e.preventDefault();
      select(all[n], true);
    });
    return {
      select: function (name, focus) {
        const t = all.filter(function (x) { return x.getAttribute('data-tab') === name; })[0];
        if (t) select(t, !!focus);
      },
      current: function () {
        const t = all.filter(function (x) { return x.getAttribute('aria-selected') === 'true'; })[0];
        return t ? t.getAttribute('data-tab') : '';
      }
    };
  }

  /* ---------- 9) مدقّقات المدخلات (تعيد {value} أو {error}) ---------- */
  function latinDigits(s) {
    return String(s).replace(/[٠-٩]/g, function (c) { return String(c.charCodeAt(0) - 0x0660); })
      .replace(/[۰-۹]/g, function (c) { return String(c.charCodeAt(0) - 0x06F0); });
  }
  const COMMON_PW = ['12345678', '123456789', '1234567890', '87654321', '11111111', '00000000', 'password', 'password1', 'qwertyui', 'qwerty123', 'abc12345', 'iloveyou', '12341234'];
  const LEVELS = ['', 'ضعيفة', 'مقبولة', 'جيدة', 'قوية'];
  function strength(pw) {
    pw = String(pw || '');
    if (!pw) return { level: 0, label: '' };
    const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(function (r) { return r.test(pw); }).length;
    let level;
    if (pw.length < 8 || COMMON_PW.indexOf(pw.toLowerCase()) !== -1 || /^(.)\1+$/.test(pw)) level = 1;
    else {
      level = 2;
      if (pw.length >= 12 || (classes >= 3 && pw.length >= 10)) level = 3;
      if (pw.length >= 12 && classes >= 3) level = 4;
      if (classes === 1 && pw.length < 12) level = 1;
    }
    return { level: level, label: LEVELS[level] };
  }
  const v = {
    name: function (s) {
      s = String(s == null ? '' : s).replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
      if (s.length < 2) return { error: 'اكتب اسمك الكامل (حرفان على الأقل).' };
      if (s.length > 120) return { error: 'الاسم طويل جدًا (الحد الأقصى ١٢٠ حرفًا).' };
      return { value: s };
    },
    email: function (s) {
      s = String(s == null ? '' : s).trim().toLowerCase();
      if (!s || s.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)) return { error: 'اكتب بريدًا إلكترونيًا صحيحًا، مثل ⁦name@example.com⁩.' };
      return { value: s };
    },
    phone: function (s) {
      let d = latinDigits(String(s == null ? '' : s)).replace(/[\s\-().‎‏]/g, '');
      if (d.indexOf('00') === 0) d = '+' + d.slice(2);
      if (!/^\+?\d{8,15}$/.test(d)) return { error: 'اكتب رقم هاتف صحيحًا مع رمز الدولة، مثل ⁦+966501234567⁩.' };
      return { value: d };
    },
    password: function (s) {
      s = String(s == null ? '' : s);
      if (s.length < 8) return { error: 'كلمة المرور يجب ألا تقل عن ٨ أحرف.' };
      if (s.length > 72) return { error: 'كلمة المرور طويلة جدًا (الحد الأقصى ٧٢ حرفًا).' };
      if (strength(s).level <= 1 && (COMMON_PW.indexOf(s.toLowerCase()) !== -1 || /^(.)\1+$/.test(s))) return { error: 'كلمة المرور هذه شائعة وسهلة التخمين. اختر غيرها.' };
      return { value: s };
    },
    country: function (s) {
      s = String(s == null ? '' : s).trim();
      if (!s) return { error: 'اختر دولتك.' };
      if (s.length > 80) return { error: 'اسم الدولة طويل جدًا.' };
      return { value: s };
    }
  };

  /* مؤشر قوة كلمة المرور: bar عنصر .pf-meter (يأخذ data-level) وlabel نص التسمية */
  function bindStrength(input, bar, label) {
    function paint() {
      const s = strength(input.value);
      bar.setAttribute('data-level', String(s.level));
      label.textContent = s.label ? 'قوة كلمة المرور: ' + s.label : '';
    }
    input.addEventListener('input', paint);
    paint();
  }
  /* زر إظهار/إخفاء كلمة المرور */
  function bindReveal(btn, input) {
    btn.addEventListener('click', function () {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.setAttribute('aria-pressed', show ? 'true' : 'false');
      btn.setAttribute('aria-label', show ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور');
      btn.textContent = show ? 'إخفاء' : 'إظهار';
    });
  }

  /* ---------- 10) تنسيق ---------- */
  function fmtDate(iso) {
    try {
      return new Intl.DateTimeFormat('ar-EG-u-nu-latn', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
    } catch (e) { return String(iso || '').slice(0, 10); }
  }
  const pct = (score, total) => (total > 0 ? Math.round(score * 100 / total) : 0);

  /* تحويل إلى صفحة الدخول (reason: expired | out) */
  function goLogin(reason) {
    win.location.replace('/account/' + (reason ? '?reason=' + encodeURIComponent(reason) : ''));
  }

  const session = Object.freeze({
    key: SESSION_KEY,
    get: loadSession,
    has: function () { return !!loadSession(); },
    clear: clearSession
  });

  win.Platform = Object.freeze({
    config: Object.freeze({ ok: cfg.ok, whatsapp: cfg.whatsapp, url: cfg.url }),
    MSG: MSG, ApiError: ApiError,
    session: session,
    auth: Object.freeze(auth),
    rest: Object.freeze(rest),
    storage: Object.freeze({ signedUrl: signedUrl, upload: upload, remove: removeObjects, publicUrl: publicUrl, publicPath: publicPath }),
    COUNTRIES: COUNTRIES,
    ui: Object.freeze({ h: h, clear: clear, icon: icon, waIcon: waIcon, msg: msg, clearMsg: clearMsg, fieldError: fieldError, setBusy: setBusy, check: check, guard: guard, tabs: tabs, bindStrength: bindStrength, bindReveal: bindReveal }),
    v: Object.freeze(v),
    strength: strength,
    safeUrl: safeUrl,
    waLink: waLink,
    videoEmbed: videoEmbed,
    fmtDate: fmtDate,
    pct: pct,
    goLogin: goLogin
  });
})();
