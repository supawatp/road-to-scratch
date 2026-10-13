// API token auth: `Authorization: Bearer <API_TOKEN>` (Claude, scripts) or the `rts_token`
// HttpOnly cookie set by the login page (dashboard).

export const COOKIE = "rts_token";
const enc = new TextEncoder();

async function digest(s) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}

/** Constant-time string comparison (hash both sides so lengths always match). */
export async function safeEqual(a, b) {
  const [x, y] = await Promise.all([digest(String(a)), digest(String(b))]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export function readCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function presentedToken(request) {
  const auth = request.headers.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m ? m[1].trim() : readCookie(request, COOKIE);
}

export async function isAuthorized(request, env) {
  const expected = env.API_TOKEN;
  if (!expected || expected.length < 16) return false; // not configured -> deny everything
  const got = presentedToken(request);
  return !!got && (await safeEqual(got, expected));
}

export function sessionCookie(token, secure = true) {
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=7776000${secure ? "; Secure" : ""}`;
}

export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Secure`;

const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function loginPage(error = "") {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Road to Scratch</title><meta name="robots" content="noindex">
<style>
:root{--bg:#fff;--ink:#17201b;--muted:#737d77;--line:#e4e7e2;--accent:#1f4d3a;--bad:#b3402f}
@media (prefers-color-scheme:dark){:root{--bg:#111613;--ink:#e8ece9;--muted:#9aa49e;--line:#2a322d;--accent:#5fae86;--bad:#e07a68}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 -apple-system,"Segoe UI",Roboto,sans-serif;display:grid;place-items:center;min-height:100vh;padding:0 16px}
form{width:100%;max-width:360px}h1{font-family:Georgia,serif;font-weight:400;margin:0 0 4px}p{color:var(--muted);margin:0 0 20px}
input{width:100%;box-sizing:border-box;padding:12px;border:1px solid var(--line);border-radius:8px;background:transparent;color:var(--ink);font:inherit}
button{margin-top:12px;width:100%;padding:12px;border:0;border-radius:8px;background:var(--accent);color:#fff;font:inherit;cursor:pointer}
.err{color:var(--bad);margin-top:12px}
</style></head><body>
<form method="post" action="/login">
<h1>Road to Scratch</h1><p>Enter your API token to open the tracker.</p>
<input type="password" name="token" autocomplete="current-password" aria-label="API token" required autofocus>
<button type="submit">Open dashboard</button>
${error ? `<div class="err" role="alert">${esc(error)}</div>` : ""}
</form></body></html>`;
}
