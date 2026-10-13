// REST API: /api/v1/:collection[/:id] and /api/v1/summary. Bearer API_TOKEN or login cookie.
import { isAuthorized } from "./auth.js";
import { COLLECTIONS, isCollection, listDocs, getDoc, putDoc, deleteDoc, isInternalSetting } from "./db.js";
import { buildSummary } from "./context.js";
import { isYmd, weekOf } from "./dates.js";

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});
const error = (status, message, code) => json({ error: message, ...(code ? { code } : {}) }, status);

async function readJson(request) {
  const text = await request.text();
  if (text.length > 256 * 1024) throw new Error("body too large");
  const data = JSON.parse(text || "{}");
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("body must be a JSON object");
  return data;
}

function validId(coll, id) {
  if (COLLECTIONS[coll].pk === "date") return isYmd(id);
  if (coll === "settings") return /^[a-z0-9_-]{1,64}$/i.test(id) && !isInternalSetting(id);
  return /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

/** Fills server-side fields (date, week, timestamps) before a write. */
async function prepare(ctx, coll, id, doc) {
  const nowIso = ctx.now().toISOString();
  if (coll === "daily") {
    const program = await ctx.program();
    return { ...doc, date: id, week: weekOf(id, program.start), updated: doc.updated || nowIso };
  }
  if (coll === "coach") return { ...doc, date: id, created: doc.created || nowIso };
  if (coll === "settings") return doc;
  if (doc.date != null && !isYmd(doc.date)) throw new Error("date must be YYYY-MM-DD");
  return { ...doc, created: doc.created || nowIso };
}

export async function handleApi(request, ctx, url) {
  if (!(await isAuthorized(request, ctx.env))) return error(401, "unauthorized", "unauthenticated");
  const parts = url.pathname.replace(/^\/api\/v1\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  const method = request.method;

  if (parts[0] === "summary" && parts.length === 1) {
    if (method !== "GET") return error(405, "method not allowed");
    const days = Math.min(Math.max(parseInt(url.searchParams.get("days") || "14", 10) || 14, 1), 120);
    return json(await buildSummary(ctx, days));
  }

  const [coll, id] = parts;
  if (!isCollection(coll) || parts.length > 2) return error(404, "not found");

  try {
    if (!id) {
      if (method === "GET") {
        const since = url.searchParams.get("since"), until = url.searchParams.get("until");
        const limit = parseInt(url.searchParams.get("limit") || "0", 10) || undefined;
        if ((since && !isYmd(since)) || (until && !isYmd(until))) return error(400, "since/until must be YYYY-MM-DD", "invalid_argument");
        return json({ items: await listDocs(ctx.db, coll, { since, until, limit: limit && Math.min(limit, 5000) }) });
      }
      if (method === "POST") {
        const doc = await readJson(request);
        const pk = COLLECTIONS[coll].pk;
        const newId = pk === "date" ? doc.date : pk === "key" ? doc.key : crypto.randomUUID();
        if (!newId || !validId(coll, newId)) return error(400, `a valid "${pk}" is required`, "invalid_argument");
        const saved = await putDoc(ctx.db, coll, newId, await prepare(ctx, coll, newId, doc));
        return json(saved, 201);
      }
      return error(405, "method not allowed");
    }

    if (!validId(coll, id)) return error(400, "invalid id", "invalid_argument");
    if (method === "GET") {
      const doc = await getDoc(ctx.db, coll, id);
      if (doc) return json(doc);
      // ?missing=null lets the dashboard poll documents that don't exist yet without 404 noise.
      return url.searchParams.get("missing") === "null" ? json(null) : error(404, "not found");
    }
    if (method === "PUT") {
      const doc = await readJson(request);
      return json(await putDoc(ctx.db, coll, id, await prepare(ctx, coll, id, doc)));
    }
    if (method === "DELETE") {
      const ok = await deleteDoc(ctx.db, coll, id);
      return ok ? new Response(null, { status: 204 }) : error(404, "not found");
    }
    return error(405, "method not allowed");
  } catch (e) {
    if (e instanceof SyntaxError || /body|date must/.test(e.message)) return error(400, e.message, "invalid_argument");
    throw e;
  }
}
