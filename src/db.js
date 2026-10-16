// D1 access. Every tracker record belongs to a user (`user_id`). Functions take either a user-scoped
// handle from scopedDb(db, uid) - the normal case - or the raw binding for global/admin work.
// Documents are plain objects; `id` is the primary key within the user (the date for daily/coach,
// the key for settings, a UUID for rounds/tests/body/shots).

export const COLLECTIONS = {
  daily: {
    pk: "date",
    cols: ["date", "woke", "trained", "mobility", "screens", "drinks", "practice", "water", "energy", "note", "week", "updated"],
    order: "date DESC",
  },
  rounds: {
    pk: "id",
    cols: ["id", "date", "course", "tee", "sleep", "drinks", "front", "back", "fw", "gir", "putts", "threePutts", "penalties",
      "doubles", "apShort", "apLong", "money", "mind", "note", "created"],
    order: "date DESC, created DESC",
  },
  tests: {
    pk: "id",
    cols: ["id", "date", "dSpeed", "dCarry", "dDir", "iSpeed", "iBall", "iCarry", "iSpread", "iDir", "wedge", "p6", "lag", "note", "created"],
    order: "date DESC, created DESC",
  },
  body: { pk: "id", cols: ["id", "date", "weight", "waist", "uric", "flare", "note", "created"], order: "date DESC, created DESC" },
  coach: { pk: "date", cols: ["date", "title", "message", "alerts", "created"], json: ["alerts"], order: "date DESC" },
  settings: { pk: "key", cols: ["key", "json"], order: "key" },
  shots: {
    pk: "id",
    cols: ["id", "date", "club", "mode", "swing", "no", "carry", "total", "side", "sideTotal", "toTarget", "clubSpeed", "ballSpeed",
      "launch", "launchDir", "smash", "apex", "spin", "spinAxis", "backSpin", "sideSpin", "created"],
    order: "date DESC, club",
  },
};

// Settings shared by everyone (not per user).
export const GLOBAL_SETTINGS = new Set(["origin", "push_count", "schema_version"]);
// Per-user settings the Worker manages internally; the REST API never exposes them.
const INTERNAL_SETTINGS = new Set(["push_count", "origin", "schema_version", "sc4_stats", "chat_memory", "chat_count", "program"]);

export const isCollection = name => Object.prototype.hasOwnProperty.call(COLLECTIONS, name);
export const isInternalSetting = key => INTERNAL_SETTINGS.has(key);

/** A D1 handle bound to one user. Passes queries through and carries `uid` for the helpers below. */
export function scopedDb(db, uid) {
  const base = db.base || db;
  return { prepare: sql => base.prepare(sql), batch: stmts => base.batch(stmts), uid, base };
}

function uidOf(db) {
  if (!db.uid) throw new Error("this query needs a user-scoped database handle");
  return db.uid;
}
export const userKey = (uid, key) => `u:${uid}:${key}`;
const settingKey = (db, key) => (db.uid && !GLOBAL_SETTINGS.has(key) ? userKey(db.uid, key) : key);

function toSql(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** Document -> column values for `coll` (unknown fields are dropped). */
export function toRow(coll, id, doc) {
  const c = COLLECTIONS[coll];
  if (coll === "settings") return { key: id, json: JSON.stringify(doc ?? {}) };
  const row = {};
  for (const col of c.cols) {
    let v = col === c.pk ? id : doc[col];
    if (c.json && c.json.includes(col) && v != null) v = JSON.stringify(v);
    row[col] = toSql(v);
  }
  return row;
}

/** Row -> document `{ id, ...fields }` (user_id is not part of the document). */
export function fromRow(coll, row, stripPrefix = "") {
  const c = COLLECTIONS[coll];
  if (coll === "settings") {
    let data = {};
    try { data = JSON.parse(row.json); } catch { /* keep {} */ }
    const id = stripPrefix && row.key.startsWith(stripPrefix) ? row.key.slice(stripPrefix.length) : row.key;
    return { ...(data && typeof data === "object" && !Array.isArray(data) ? data : { value: data }), id };
  }
  const doc = { id: row[c.pk] };
  for (const col of c.cols) {
    if (col === "id") continue;
    let v = row[col];
    if (c.json && c.json.includes(col) && typeof v === "string") { try { v = JSON.parse(v); } catch { /* leave as text */ } }
    doc[col] = v;
  }
  return doc;
}

export async function listDocs(db, coll, { since, until, limit } = {}) {
  const c = COLLECTIONS[coll];
  const where = [], args = [];
  if (coll === "settings") {
    const prefix = userKey(uidOf(db), "");
    where.push("key LIKE ?"); args.push(prefix.replace(/[%_]/g, "") + "%");
    const { results } = await db.prepare(`SELECT * FROM settings WHERE ${where.join(" AND ")} ORDER BY key`).bind(...args).all();
    return results.filter(r => r.key.startsWith(prefix) && !INTERNAL_SETTINGS.has(r.key.slice(prefix.length)))
      .map(r => fromRow("settings", r, prefix));
  }
  where.push("user_id = ?"); args.push(uidOf(db));
  if (since) { where.push("date >= ?"); args.push(since); }
  if (until) { where.push("date <= ?"); args.push(until); }
  let sql = `SELECT * FROM ${coll} WHERE ${where.join(" AND ")} ORDER BY ${c.order}`;
  if (limit) { sql += " LIMIT ?"; args.push(limit); }
  const { results } = await db.prepare(sql).bind(...args).all();
  return results.map(r => fromRow(coll, r));
}

export async function getDoc(db, coll, id) {
  if (coll === "settings") {
    const key = settingKey(db, id);
    const row = await db.prepare("SELECT * FROM settings WHERE key = ?").bind(key).first();
    return row ? fromRow("settings", row, db.uid ? userKey(db.uid, "") : "") : null;
  }
  const c = COLLECTIONS[coll];
  const row = await db.prepare(`SELECT * FROM ${coll} WHERE user_id = ? AND ${c.pk} = ?`).bind(uidOf(db), id).first();
  return row ? fromRow(coll, row) : null;
}

/** Insert or fully replace a document. */
export async function putDoc(db, coll, id, doc) {
  if (coll === "settings") {
    await setSetting(db, id, doc ?? {});
    return { ...(doc || {}), id };
  }
  const row = { user_id: uidOf(db), ...toRow(coll, id, doc) };
  const cols = Object.keys(row);
  await db.prepare(`INSERT OR REPLACE INTO ${coll} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
    .bind(...cols.map(k => row[k])).run();
  const { user_id, ...plain } = row;
  return fromRow(coll, plain);
}

export async function deleteDoc(db, coll, id) {
  if (coll === "settings") {
    const r = await db.prepare("DELETE FROM settings WHERE key = ?").bind(settingKey(db, id)).run();
    return (r.meta?.changes ?? 0) > 0;
  }
  const c = COLLECTIONS[coll];
  const r = await db.prepare(`DELETE FROM ${coll} WHERE user_id = ? AND ${c.pk} = ?`).bind(uidOf(db), id).run();
  return (r.meta?.changes ?? 0) > 0;
}

// ---- settings helpers (per user on a scoped handle, global keys always global) ----------------

export async function getSetting(db, key) {
  const row = await db.prepare("SELECT json FROM settings WHERE key = ?").bind(settingKey(db, key)).first();
  if (!row) return null;
  try { return JSON.parse(row.json); } catch { return null; }
}

export async function setSetting(db, key, value) {
  await db.prepare("INSERT OR REPLACE INTO settings (key, json) VALUES (?, ?)").bind(settingKey(db, key), JSON.stringify(value)).run();
}

export async function deleteSetting(db, key) {
  await db.prepare("DELETE FROM settings WHERE key = ?").bind(settingKey(db, key)).run();
}

/** Remember the public origin (for dashboard links in cron messages); writes only when it changes. */
export async function rememberOrigin(db, origin) {
  await db.prepare("INSERT INTO settings (key, json) VALUES ('origin', ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json WHERE settings.json <> excluded.json")
    .bind(JSON.stringify(origin)).run();
}

// ---- conversation state (check-in / score flows) ------------------------------------------------

export async function loadConvo(db, userId) {
  const row = await db.prepare("SELECT * FROM convo WHERE user_id = ?").bind(userId).first();
  if (!row || !row.flow) return null;
  let draft = {};
  try { draft = JSON.parse(row.draft || "{}"); } catch { /* reset */ }
  return { flow: row.flow, step: row.step, draft, updated: row.updated };
}

export async function saveConvo(db, userId, state, nowIso) {
  await db.prepare("INSERT OR REPLACE INTO convo (user_id, flow, step, draft, updated) VALUES (?, ?, ?, ?, ?)")
    .bind(userId, state.flow, state.step, JSON.stringify(state.draft), nowIso).run();
}

export async function clearConvo(db, userId) {
  await db.prepare("DELETE FROM convo WHERE user_id = ?").bind(userId).run();
}
