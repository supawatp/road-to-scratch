// Photos and files sent in LINE: downloaded straight away (LINE keeps content only for a limited time)
// and stored in R2 (binding MEDIA), with a row in `media` for analytics.
import { Buffer } from "node:buffer";

const MAX_BYTES = 25 * 1024 * 1024; // keep big videos out of Worker memory
const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp", "video/mp4": "mp4", "audio/m4a": "m4a",
  "audio/x-m4a": "m4a", "audio/mp4": "m4a", "application/pdf": "pdf" };

/**
 * Downloads a LINE message's content and stores it. Returns { id, key, contentType, size, bytes? } or
 * { skipped: reason }. `bytes` (ArrayBuffer) is returned for images so the coach can look at them.
 */
export async function saveLineContent(ctx, uid, message, nowIso) {
  if (!ctx.env.MEDIA) return { skipped: "R2 bucket (MEDIA) is not bound" };
  if (message.contentProvider && message.contentProvider.type === "external") return { skipped: "external content" };
  const res = await ctx.line.content(message.id);
  const contentType = (res.headers.get("content-type") || "application/octet-stream").split(";")[0];
  const declared = Number(res.headers.get("content-length") || 0);
  if (declared > MAX_BYTES) return { skipped: `too large (${declared} bytes)` };
  const bytes = await res.arrayBuffer();
  if (bytes.byteLength > MAX_BYTES) return { skipped: `too large (${bytes.byteLength} bytes)` };
  const id = crypto.randomUUID();
  const ext = EXT[contentType] || (message.fileName && message.fileName.split(".").pop().slice(0, 8)) || "bin";
  const key = `u/${uid}/${nowIso.slice(0, 7)}/${id}.${ext}`;
  await ctx.env.MEDIA.put(key, bytes, { httpMetadata: { contentType }, customMetadata: { user: uid, lineMessageId: message.id, type: message.type } });
  await ctx.db.base.prepare(`INSERT INTO media (id, user_id, ts, type, content_type, size, r2_key, line_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, uid, nowIso, message.type, contentType, bytes.byteLength, key, message.id).run();
  return { id, key, contentType, size: bytes.byteLength, bytes: message.type === "image" ? bytes : undefined };
}

/** Image block for Claude (base64). Claude accepts images up to 5 MB in these formats. */
export function imageBlock(bytes, contentType) {
  if (!bytes || bytes.byteLength > 5 * 1024 * 1024) return null;
  if (!["image/jpeg", "image/png", "image/gif", "image/webp"].includes(contentType)) return null;
  return { type: "image", source: { type: "base64", media_type: contentType, data: Buffer.from(bytes).toString("base64") } };
}

export async function recordAnalysis(db, uid, mediaId, { category, description, data }) {
  const base = db.base || db;
  await base.prepare("UPDATE media SET category = ?, description = ?, analysis = ? WHERE id = ? AND user_id = ?")
    .bind(category || null, description ? String(description).slice(0, 2000) : null, data ? JSON.stringify(data) : null, mediaId, uid).run();
}

export async function listMedia(db, uid, { limit = 100 } = {}) {
  const base = db.base || db;
  const { results } = await base.prepare("SELECT * FROM media WHERE user_id = ? ORDER BY ts DESC LIMIT ?").bind(uid, Math.min(limit, 500)).all();
  return results.map(r => ({ ...r, analysis: r.analysis ? JSON.parse(r.analysis) : null }));
}

export async function getMedia(db, id) {
  const base = db.base || db;
  return base.prepare("SELECT * FROM media WHERE id = ?").bind(id).first();
}

/** Deletes every stored file of a user (admin "delete user data"). */
export async function deleteUserMedia(env, uid) {
  if (!env.MEDIA) return 0;
  let n = 0, cursor;
  do {
    const page = await env.MEDIA.list({ prefix: `u/${uid}/`, cursor });
    if (page.objects.length) { await env.MEDIA.delete(page.objects.map(o => o.key)); n += page.objects.length; }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return n;
}
