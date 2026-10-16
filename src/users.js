// Users, profiles and sessions.
//
// Status flow:  new (added the OA as a friend) -> pending (signed up in LIFF, consent given)
//   -> onboarding (approved by the admin: questionnaire + program design) -> active (program activated)
//   disabled (by the admin) / left (blocked the OA). The owner is always an active admin.

export const STATUSES = ["new", "pending", "onboarding", "active", "disabled", "left"];
const enc = new TextEncoder();

const parseJson = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

export function userFromRow(r) {
  if (!r) return null;
  return {
    id: r.id, name: r.name, displayName: r.display_name, picture: r.picture, status: r.status, role: r.role,
    golfer: r.golfer === null || r.golfer === undefined ? null : !!r.golfer, lang: r.lang || "en",
    consentAt: r.consent_at, approvedAt: r.approved_at, limits: parseJson(r.limits, {}) || {},
    created: r.created, updated: r.updated, lastSeen: r.last_seen,
  };
}
export const isAdmin = u => !!u && u.role === "admin";

export async function getUser(db, id) {
  const base = db.base || db;
  return userFromRow(await base.prepare("SELECT * FROM users WHERE id = ?").bind(id).first());
}

export async function listUsers(db) {
  const base = db.base || db;
  const { results } = await base.prepare("SELECT * FROM users ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, created").all();
  return results.map(userFromRow);
}

/** Creates the user on first contact (follow / first message). Returns the user. */
export async function touchUser(db, id, nowIso, profile = null) {
  const base = db.base || db;
  await base.prepare(`INSERT OR IGNORE INTO users (id, status, role, lang, created, updated, last_seen) VALUES (?, 'new', 'user', 'en', ?, ?, ?)`)
    .bind(id, nowIso, nowIso, nowIso).run();
  if (profile) {
    await base.prepare("UPDATE users SET display_name = ?, picture = ?, name = COALESCE(name, ?), updated = ? WHERE id = ?")
      .bind(profile.displayName || null, profile.pictureUrl || null, profile.displayName || null, nowIso, id).run();
  }
  await base.prepare("UPDATE users SET last_seen = ? WHERE id = ?").bind(nowIso, id).run();
  return getUser(base, id);
}

const USER_COLS = { name: "name", displayName: "display_name", picture: "picture", status: "status", role: "role", golfer: "golfer",
  lang: "lang", consentAt: "consent_at", approvedAt: "approved_at", limits: "limits" };

export async function updateUser(db, id, fields, nowIso) {
  const base = db.base || db;
  const sets = [], args = [];
  for (const [k, col] of Object.entries(USER_COLS)) {
    if (!(k in fields)) continue;
    let v = fields[k];
    if (k === "status" && !STATUSES.includes(v)) throw new Error(`invalid status ${v}`);
    if (k === "role" && !["admin", "user"].includes(v)) throw new Error(`invalid role ${v}`);
    if (k === "golfer") v = v === null ? null : v ? 1 : 0;
    if (k === "limits") v = JSON.stringify(v || {});
    sets.push(`${col} = ?`); args.push(v ?? null);
  }
  if (!sets.length) return getUser(base, id);
  sets.push("updated = ?"); args.push(nowIso);
  await base.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).bind(...args, id).run();
  return getUser(base, id);
}

/** Active users who should receive the daily messages. */
export async function activeUsers(db) {
  const base = db.base || db;
  const { results } = await base.prepare("SELECT * FROM users WHERE status = 'active' ORDER BY created").all();
  return results.map(userFromRow);
}

// ---- profiles ------------------------------------------------------------------------------------

export async function getProfile(db, uid) {
  const base = db.base || db;
  const r = await base.prepare("SELECT * FROM profiles WHERE user_id = ?").bind(uid).first();
  return r
    ? { answers: parseJson(r.answers, {}), answersVersion: r.answers_version, answeredAt: r.answered_at, notes: r.notes || "", flags: parseJson(r.flags, []), updated: r.updated }
    : { answers: {}, answersVersion: null, answeredAt: null, notes: "", flags: [], updated: null };
}

export async function saveProfile(db, uid, patch, nowIso) {
  const base = db.base || db;
  const cur = await getProfile(base, uid);
  const next = { ...cur, ...patch };
  await base.prepare(`INSERT OR REPLACE INTO profiles (user_id, answers, answers_version, answered_at, notes, flags, updated)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(uid, JSON.stringify(next.answers || {}), next.answersVersion ?? null, next.answeredAt ?? null,
    String(next.notes || "").slice(0, 4000), JSON.stringify(next.flags || []), nowIso).run();
  return next;
}

// ---- sessions (LIFF users) ----------------------------------------------------------------------

const b64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = s => atob(s.replace(/-/g, "+").replace(/_/g, "/"));

async function hmacKey(env) {
  const secret = env.SESSION_SECRET || `session:${env.API_TOKEN || ""}`;
  if (secret.length < 24) throw new Error("SESSION_SECRET or API_TOKEN must be set");
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export const SESSION_COOKIE = "rts_session";
const SESSION_DAYS = 30;

export async function signSession(env, uid, now = Date.now()) {
  const payload = `${b64url(enc.encode(uid))}.${Math.floor(now / 1000) + SESSION_DAYS * 86400}`;
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(env), enc.encode(payload));
  return `${payload}.${b64url(sig)}`;
}

/** Returns the user id from a valid, unexpired session token, else null. */
export async function verifySession(env, token, now = Date.now()) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  const [u, exp, sig] = parts;
  if (!/^\d+$/.test(exp) || Number(exp) * 1000 < now) return null;
  let sigBytes;
  try { sigBytes = Uint8Array.from(fromB64url(sig), c => c.charCodeAt(0)); } catch { return null; }
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(env), sigBytes, enc.encode(`${u}.${exp}`));
  if (!ok) return null;
  try { return fromB64url(u); } catch { return null; }
}

export function sessionCookieHeader(token, secure = true) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? "; Secure" : ""}`;
}

/**
 * Verifies a LIFF ID token with LINE (https://api.line.me/oauth2/v2.1/verify).
 * Returns { sub, name, picture } or throws. `fetchImpl` lets tests fake LINE.
 */
export async function verifyLiffIdToken(env, idToken, fetchImpl = (...a) => fetch(...a)) {
  const clientId = String(env.LINE_LOGIN_CHANNEL_ID || "").trim();
  if (!clientId) throw new Error("LINE_LOGIN_CHANNEL_ID is not configured");
  if (!idToken) throw new Error("missing id token");
  const res = await fetchImpl("https://api.line.me/oauth2/v2.1/verify", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ id_token: idToken, client_id: clientId }).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.sub) throw new Error(`LINE rejected the login (${data.error_description || res.status})`);
  if (data.aud && data.aud !== clientId) throw new Error("token was issued for another channel");
  return { sub: data.sub, name: data.name || null, picture: data.picture || null };
}

// ---- limits ---------------------------------------------------------------------------------------

export function chatLimit(env, user) {
  const own = user && user.limits && Number.isFinite(Number(user.limits.chatDaily)) ? Number(user.limits.chatDaily) : null;
  return own ?? Number(env.CHAT_DAILY_LIMIT || 30);
}
