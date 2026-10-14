// REST API: /api/v1/:collection[/:id] and /api/v1/summary. Bearer API_TOKEN or login cookie.
import { isAuthorized } from "./auth.js";
import { COLLECTIONS, isCollection, listDocs, getDoc, putDoc, deleteDoc, isInternalSetting } from "./db.js";
import { buildSummary } from "./context.js";
import { isYmd, weekOf } from "./dates.js";
import { ensureShots, importCsv, getSc4, tagSession, deleteSession, invalidateSc4 } from "./sc4store.js";

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

  if (parts[0] === "sc4") return handleSc4(request, ctx, url, parts.slice(1));

  const [coll, id] = parts;
  if (!isCollection(coll) || parts.length > 2) return error(404, "not found");
  if (coll === "shots") await ensureShots(ctx.db);

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
        if (coll === "shots") await invalidateSc4(ctx.db);
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
      const saved = await putDoc(ctx.db, coll, id, await prepare(ctx, coll, id, doc));
      if ((coll === "settings" && id === "yardages") || coll === "shots") await invalidateSc4(ctx.db); // analysis inputs
      return json(saved);
    }
    if (method === "DELETE") {
      const ok = await deleteDoc(ctx.db, coll, id);
      if (ok && coll === "shots") await invalidateSc4(ctx.db);
      return ok ? new Response(null, { status: 204 }) : error(404, "not found");
    }
    return error(405, "method not allowed");
  } catch (e) {
    if (e instanceof SyntaxError || /body|date must/.test(e.message)) return error(400, e.message, "invalid_argument");
    throw e;
  }
}

/**
 * SC4 routes:
 *   GET    /api/v1/sc4/stats                     yardages, gaps, sessions, insights (cached)
 *   POST   /api/v1/sc4/import?swing=auto|full|3/4  body: one SC4 CSV export (text)
 *   PUT    /api/v1/sc4/session                   { date, club, swing } - re-label a session
 *   DELETE /api/v1/sc4/session?date=&club=       remove a session's shots
 */
async function handleSc4(request, ctx, url, parts) {
  const method = request.method;
  try {
    if (parts[0] === "stats" && parts.length === 1 && method === "GET") {
      return json({ id: "stats", ...(await getSc4(ctx, { force: url.searchParams.get("refresh") === "1" })) });
    }
    if (parts[0] === "import" && parts.length === 1 && method === "POST") {
      const text = await request.text();
      if (text.length > 2 * 1024 * 1024) return error(413, "file too large (max 2 MB)", "invalid_argument");
      return json(await importCsv(ctx, text, url.searchParams.get("swing") || "auto"));
    }
    if (parts[0] === "session" && parts.length === 1) {
      if (method === "PUT") {
        const { date, club, swing } = await readJson(request);
        if (!isYmd(date) || !club) return error(400, "date and club are required", "invalid_argument");
        return json({ updated: await tagSession(ctx, date, String(club), swing) });
      }
      if (method === "DELETE") {
        const date = url.searchParams.get("date"), club = url.searchParams.get("club");
        if (!isYmd(date) || !club) return error(400, "date and club are required", "invalid_argument");
        return json({ deleted: await deleteSession(ctx, date, club) });
      }
    }
    return error(404, "not found");
  } catch (e) {
    if (e instanceof SyntaxError || /SC4|swing must|No shots|empty|body/.test(e.message)) return error(400, e.message, "invalid_argument");
    throw e;
  }
}
