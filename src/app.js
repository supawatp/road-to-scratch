// Request router. Kept separate from index.js so tests can inject the program, HTML and fetch.
import { makeContext } from "./context.js";
import { handleApi, authenticate } from "./api.js";
import { handleWebhook } from "./webhook.js";
import { runScheduled } from "./jobs.js";
import { isAuthorized, safeEqual, sessionCookie, clearCookie, loginPage } from "./auth.js";
import { ensureSchema } from "./schema.js";
import { verifyLiffIdToken, touchUser, signSession, sessionCookieHeader, SESSION_COOKIE, isAdmin } from "./users.js";
import { latestProgram } from "./programs.js";
import { getMedia } from "./media.js";
import { liffPage } from "./pages/liff.js";
import { adminPage } from "./pages/admin.js";

const html = (body, status = 200, headers = {}) => new Response(body, {
  status,
  headers: {
    "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
    "x-frame-options": "DENY", "referrer-policy": "same-origin", "x-robots-tag": "noindex", ...headers,
  },
});
const jsonResponse = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

/** Puts a user's program (and a little about them) in front of the dashboard script. */
function personalDashboard(dashboardHtml, program, user) {
  const data = JSON.stringify({ program, user: { name: user.name || user.displayName, golfer: user.golfer, status: user.status, admin: isAdmin(user) } }).replace(/</g, "\\u003c");
  return dashboardHtml.replace("<script>", () => `<script>window.RTS = ${data}; window.RTS_PROGRAM = window.RTS.program;</script>\n<script>`);
}

export function createApp({ program, dashboardHtml, fetchImpl, now } = {}) {
  const ctxFor = env => makeContext(env, { program, fetchImpl, now });

  async function fetch(request, env, ectx) {
    // Without a Workers ExecutionContext (tests), background work is awaited before responding.
    const pending = [];
    const waitUntil = p => (ectx && ectx.waitUntil ? ectx.waitUntil(p) : pending.push(Promise.resolve(p).catch(e => console.error("background", e))));
    const res = await route(request, env, ectx, waitUntil);
    if (pending.length) await Promise.all(pending);
    return res;
  }

  async function route(request, env, ectx, waitUntil) {
    const url = new URL(request.url);
    const ctx = ctxFor(env);
    try {
      if (url.pathname === "/health") return new Response("ok");
      await ensureSchema(env.DB, env, ctx.now().toISOString());

      if (url.pathname === "/line/webhook") {
        if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
        return await handleWebhook(request, ctx, waitUntil, ectx && ectx.waitUntil ? p => ectx.waitUntil(p) : null);
      }
      if (url.pathname.startsWith("/api/v1")) return await handleApi(request, ctx, url, waitUntil);

      // LIFF: LINE login -> session cookie
      if (url.pathname === "/auth/liff" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        let who;
        try { who = await verifyLiffIdToken(env, body.idToken, fetchImpl); } catch (e) { return jsonResponse({ error: e.message }, 401); }
        const user = await touchUser(env.DB, who.sub, ctx.now().toISOString(), { displayName: who.name, pictureUrl: who.picture });
        if (["disabled", "left"].includes(user.status)) return jsonResponse({ error: "account disabled" }, 403);
        const token = await signSession(env, user.id, ctx.now().getTime());
        return jsonResponse({ ok: true, status: user.status }, 200, { "set-cookie": sessionCookieHeader(token, url.protocol === "https:") });
      }
      if (url.pathname === "/liff" || url.pathname.startsWith("/liff/")) return html(liffPage(env));

      if (url.pathname === "/admin") {
        if (!(await isAuthorized(request, env))) return Response.redirect(url.origin + "/login", 303);
        return html(adminPage());
      }
      if (url.pathname.startsWith("/media/")) {
        const auth = await authenticate(request, env, null);
        if (!auth) return new Response("unauthorized", { status: 401 });
        const m = await getMedia(env.DB, decodeURIComponent(url.pathname.slice(7)));
        if (!m || (!auth.admin && (!auth.user || m.user_id !== auth.user.id))) return new Response("not found", { status: 404 });
        const obj = env.MEDIA ? await env.MEDIA.get(m.r2_key) : null;
        if (!obj) return new Response("not found", { status: 404 });
        return new Response(obj.body, { headers: { "content-type": m.content_type || "application/octet-stream", "cache-control": "private, max-age=3600" } });
      }

      if (url.pathname === "/login") {
        if (request.method === "POST") {
          const form = await request.formData();
          const token = String(form.get("token") || "");
          if (env.API_TOKEN && env.API_TOKEN.length >= 16 && (await safeEqual(token, env.API_TOKEN))) {
            return new Response(null, { status: 303, headers: { location: "/", "set-cookie": sessionCookie(token, url.protocol === "https:") } });
          }
          return html(loginPage(env.API_TOKEN ? "That token is not right." : "API_TOKEN is not set on the Worker yet."), 401);
        }
        return html(loginPage());
      }
      if (url.pathname === "/logout") {
        const headers = new Headers({ location: "/login" });
        headers.append("set-cookie", clearCookie());
        headers.append("set-cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure`);
        return new Response(null, { status: 303, headers });
      }
      if (url.pathname === "/" || url.pathname === "/index.html") {
        if (request.method !== "GET" && request.method !== "HEAD") return new Response("method not allowed", { status: 405 });
        const auth = await authenticate(request, env, null);
        if (!auth || !auth.user) return Response.redirect(url.origin + "/login", 303);
        const uctx = ctx.forUser(auth.user);
        let p = await uctx.program();
        if (!p) { const latest = await latestProgram(uctx.db, auth.user.id); p = latest ? latest.program : null; }
        if (!p) {
          return html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Road to Scratch</title>
<body style="font:16px/1.5 -apple-system,sans-serif;max-width:520px;margin:40px auto;padding:0 16px"><h1 style="font:400 28px Georgia,serif">Road to Scratch</h1>
<p>Your program isn't ready yet. Your coach will message you in LINE.</p><p>แผนของคุณยังไม่พร้อม โค้ชจะส่งข้อความใน LINE</p></body>`);
        }
        return html(personalDashboard(dashboardHtml, p, auth.user));
      }
      return new Response("not found", { status: 404 });
    } catch (e) {
      console.error("request failed", url.pathname, e && e.stack || e);
      return new Response("internal error", { status: 500 });
    }
  }

  async function scheduled(event, env, ectx) {
    const ctx = ctxFor(env);
    const job = ensureSchema(env.DB, env, ctx.now().toISOString())
      .then(() => runScheduled(event.cron, ctx))
      .catch(e => console.error("cron failed", event.cron, e && e.stack || e));
    if (ectx && ectx.waitUntil) ectx.waitUntil(job);
    return job;
  }

  return { fetch, scheduled };
}
