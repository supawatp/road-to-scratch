// Background jobs for work longer than a webhook can wait (e.g. designing a program with Claude).
// A cron trigger every minute runs at most one job; scheduled handlers may run for several minutes.

const STUCK_MS = 15 * 60 * 1000;

export async function enqueueJob(db, kind, uid, payload, nowIso) {
  const base = db.base || db;
  const id = crypto.randomUUID();
  await base.prepare("INSERT INTO jobs (id, kind, user_id, status, payload, attempts, created, updated) VALUES (?, ?, ?, 'pending', ?, 0, ?, ?)")
    .bind(id, kind, uid, JSON.stringify(payload || {}), nowIso, nowIso).run();
  return id;
}

/** A job of this kind for this user that hasn't finished yet. */
export async function pendingJob(db, uid, kind) {
  const base = db.base || db;
  return base.prepare("SELECT id, status FROM jobs WHERE user_id = ? AND kind = ? AND status IN ('pending', 'running') LIMIT 1").bind(uid, kind).first();
}

/** Takes the oldest runnable job (pending, or running but stuck). Returns it or null. */
export async function claimJob(db, now) {
  const base = db.base || db;
  const stuckBefore = new Date(now - STUCK_MS).toISOString();
  const row = await base.prepare(`SELECT * FROM jobs WHERE (status = 'pending') OR (status = 'running' AND updated < ?) ORDER BY created LIMIT 1`)
    .bind(stuckBefore).first();
  if (!row) return null;
  const nowIso = new Date(now).toISOString();
  const r = await base.prepare("UPDATE jobs SET status = 'running', attempts = attempts + 1, updated = ? WHERE id = ? AND updated = ?")
    .bind(nowIso, row.id, row.updated).run();
  if (!r.meta || !r.meta.changes) return null; // another run took it
  return { ...row, attempts: row.attempts + 1, payload: row.payload ? JSON.parse(row.payload) : {} };
}

export async function finishJob(db, id, { ok, result, error }, nowIso) {
  const base = db.base || db;
  await base.prepare("UPDATE jobs SET status = ?, result = ?, error = ?, updated = ? WHERE id = ?")
    .bind(ok ? "done" : "failed", result ? JSON.stringify(result) : null, error ? String(error).slice(0, 1000) : null, nowIso, id).run();
}

export async function retryLater(db, id, error, nowIso) {
  const base = db.base || db;
  await base.prepare("UPDATE jobs SET status = 'pending', error = ?, updated = ? WHERE id = ?").bind(String(error).slice(0, 1000), nowIso, id).run();
}
