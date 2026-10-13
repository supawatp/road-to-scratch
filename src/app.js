// Request router. Kept separate from index.js so tests can inject the program, HTML and fetch.
import { makeContext } from "./context.js";
import { handleApi } from "./api.js";
import { handleWebhook } from "./webhook.js";
import { runScheduled } from "./jobs.js";
import { isAuthorized, safeEqual, sessionCookie, clearCookie, loginPage } from "./auth.js";

const html = (body, status = 200, headers = {}) => new Response(body, {
  status,
  headers: {
    "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
    "x-frame-options": "DENY", "referrer-policy": "same-origin", "x-robots-tag": "noindex", ...headers,
  },
});

export function createApp({ program, dashboardHtml, fetchImpl, now } = {}) {
  const ctxFor = env => makeContext(env, { program, fetchImpl, now });

  async function fetch(request, env, ectx) {
    const url = new URL(request.url);
    const ctx = ctxFor(env);
    const waitUntil = p => (ectx && ectx.waitUntil ? ectx.waitUntil(p) : p);
    try {
      if (url.pathname === "/line/webhook") {
        if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
        return await handleWebhook(request, ctx, waitUntil);
      }
      if (url.pathname.startsWith("/api/v1")) return await handleApi(request, ctx, url);

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
        return new Response(null, { status: 303, headers: { location: "/login", "set-cookie": clearCookie() } });
      }
      if (url.pathname === "/" || url.pathname === "/index.html") {
        if (request.method !== "GET" && request.method !== "HEAD") return new Response("method not allowed", { status: 405 });
        if (!(await isAuthorized(request, env))) return Response.redirect(url.origin + "/login", 303);
        return html(dashboardHtml);
      }
      if (url.pathname === "/health") return new Response("ok");
      return new Response("not found", { status: 404 });
    } catch (e) {
      console.error("request failed", url.pathname, e && e.stack || e);
      return new Response("internal error", { status: 500 });
    }
  }

  async function scheduled(event, env, ectx) {
    const ctx = ctxFor(env);
    const job = runScheduled(event.cron, ctx).catch(e => console.error("cron failed", event.cron, e && e.stack || e));
    if (ectx && ectx.waitUntil) ectx.waitUntil(job);
    return job;
  }

  return { fetch, scheduled };
}
