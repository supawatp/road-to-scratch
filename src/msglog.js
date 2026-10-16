// Chat log: every LINE message in and out is stored in `messages` (per user), for history and analytics.

const short = (s, n = 4000) => (s == null ? null : String(s).slice(0, n));

/** Text shown in the log for an outgoing LINE message object. */
export function outText(m) {
  if (typeof m === "string") return m;
  if (m.type === "text") return m.text;
  if (m.type === "flex") return m.altText;
  return `[${m.type}]`;
}

/** Records an incoming webhook event. Returns the message row id. */
export async function logIncoming(db, uid, event, nowIso, extra = {}) {
  const base = db.base || db;
  const id = crypto.randomUUID();
  let type = event.type, text = null, data = null, lineId = null;
  if (event.type === "message") {
    const m = event.message || {};
    type = m.type; lineId = m.id || null;
    if (m.type === "text") text = m.text;
    else if (m.type === "sticker") data = { packageId: m.packageId, stickerId: m.stickerId, keywords: m.keywords };
    else if (m.type === "location") { text = m.address || m.title || null; data = { lat: m.latitude, lng: m.longitude, title: m.title }; }
    else if (["image", "video", "audio", "file"].includes(m.type)) data = { fileName: m.fileName, fileSize: m.fileSize, duration: m.duration };
  } else if (event.type === "postback") {
    text = event.postback && event.postback.displayText || null;
    data = { postback: event.postback && event.postback.data };
  }
  await base.prepare(`INSERT INTO messages (id, user_id, ts, dir, kind, type, text, data, media_id, line_id) VALUES (?, ?, ?, 'in', ?, ?, ?, ?, ?, ?)`)
    .bind(id, uid, nowIso, event.type, type, short(text), data ? JSON.stringify(data) : null, extra.mediaId || null, lineId).run();
  return id;
}

/** Records outgoing messages (reply or push). meta: { kind: 'reply'|'push', model, tokensIn, tokensOut, tools } */
export async function logOutgoing(db, uid, messages, nowIso, meta = {}) {
  const base = db.base || db;
  const list = [].concat(messages);
  const stmts = list.map(m => base.prepare(`INSERT INTO messages (id, user_id, ts, dir, kind, type, text, data, model, tokens_in, tokens_out)
    VALUES (?, ?, ?, 'out', ?, ?, ?, ?, ?, ?, ?)`).bind(crypto.randomUUID(), uid, nowIso, meta.kind || "reply",
    typeof m === "string" ? "text" : m.type, short(outText(m)), meta.tools ? JSON.stringify({ tools: meta.tools }) : null,
    meta.model || null, meta.tokensIn ?? null, meta.tokensOut ?? null));
  if (stmts.length) await base.batch(stmts);
}

/** Admin portal: one user's history, newest first. */
export async function listMessages(db, uid, { before, limit = 100 } = {}) {
  const base = db.base || db;
  const args = [uid];
  let sql = "SELECT * FROM messages WHERE user_id = ?";
  if (before) { sql += " AND ts < ?"; args.push(before); }
  sql += " ORDER BY ts DESC LIMIT ?"; args.push(Math.min(Math.max(limit, 1), 500));
  const { results } = await base.prepare(sql).bind(...args).all();
  return results.map(r => ({ ...r, data: r.data ? JSON.parse(r.data) : null }));
}
