// D1 access for the tracker collections. Documents are plain objects; `id` is the primary key
// (the date for daily/coach, the key for settings, a UUID for rounds/tests/body).

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
};

// Settings that the Worker manages internally and the public API must not expose.
const INTERNAL_SETTINGS = new Set(["push_count", "origin"]);

export const isCollection = name => Object.prototype.hasOwnProperty.call(COLLECTIONS, name);

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

/** Row -> document `{ id, ...fields }`. */
export function fromRow(coll, row) {
  const c = COLLECTIONS[coll];
  if (coll === "settings") {
    let data = {};
    try { data = JSON.parse(row.json); } catch { /* keep {} */ }
    return { ...(data && typeof data === "object" && !Array.isArray(data) ? data : { value: data }), id: row.key };
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
  if (coll !== "settings") {
    if (since) { where.push("date >= ?"); args.push(since); }
    if (until) { where.push("date <= ?"); args.push(until); }
  } else {
    where.push(`key NOT IN (${[...INTERNAL_SETTINGS].map(() => "?").join(",")})`);
    args.push(...INTERNAL_SETTINGS);
  }
  let sql = `SELECT * FROM ${coll}${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY ${c.order}`;
  if (limit) { sql += " LIMIT ?"; args.push(limit); }
  const { results } = await db.prepare(sql).bind(...args).all();
  return results.map(r => fromRow(coll, r));
}

export async function getDoc(db, coll, id) {
  const c = COLLECTIONS[coll];
  const row = await db.prepare(`SELECT * FROM ${coll} WHERE ${c.pk} = ?`).bind(id).first();
  return row ? fromRow(coll, row) : null;
}

/** Insert or fully replace a document. */
export async function putDoc(db, coll, id, doc) {
  const row = toRow(coll, id, doc);
  const cols = Object.keys(row);
  await db.prepare(`INSERT OR REPLACE INTO ${coll} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
    .bind(...cols.map(k => row[k])).run();
  return fromRow(coll, row);
}

export async function deleteDoc(db, coll, id) {
  const c = COLLECTIONS[coll];
  const r = await db.prepare(`DELETE FROM ${coll} WHERE ${c.pk} = ?`).bind(id).run();
  return (r.meta?.changes ?? 0) > 0;
}

export const isInternalSetting = key => INTERNAL_SETTINGS.has(key);

// ---- settings helpers -------------------------------------------------------------------------

export async function getSetting(db, key) {
  const row = await db.prepare("SELECT json FROM settings WHERE key = ?").bind(key).first();
  if (!row) return null;
  try { return JSON.parse(row.json); } catch { return null; }
}

export async function setSetting(db, key, value) {
  await db.prepare("INSERT OR REPLACE INTO settings (key, json) VALUES (?, ?)").bind(key, JSON.stringify(value)).run();
}

/** Remember the public origin (for dashboard links in cron messages); writes only when it changes. */
export async function rememberOrigin(db, origin) {
  await db.prepare("INSERT INTO settings (key, json) VALUES ('origin', ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json WHERE settings.json <> excluded.json")
    .bind(JSON.stringify(origin)).run();
}

// ---- conversation state -----------------------------------------------------------------------

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
