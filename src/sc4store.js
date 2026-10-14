// SC4 storage: shots table, CSV import, cached analysis (settings.sc4_stats, refreshed daily or on change).
import { parseSc4Csv, shotKey, analyze } from "./sc4.js";
import { getSetting, setSetting, listDocs } from "./db.js";

export const SHOT_COLS = ["id", "date", "club", "mode", "swing", "no", "carry", "total", "side", "sideTotal", "toTarget", "clubSpeed",
  "ballSpeed", "launch", "launchDir", "smash", "apex", "spin", "spinAxis", "backSpin", "sideSpin", "created"];
export const SWINGS = ["auto", "full", "3/4"];
const CACHE_KEY = "sc4_stats";

const ready = new WeakSet();
export async function ensureShots(db) {
  if (ready.has(db)) return;
  await db.prepare(`CREATE TABLE IF NOT EXISTS shots (id TEXT PRIMARY KEY, date TEXT, club TEXT, mode TEXT, swing TEXT, no INT, carry REAL,
    total REAL, side REAL, sideTotal REAL, toTarget REAL, clubSpeed REAL, ballSpeed REAL, launch REAL, launchDir REAL, smash REAL, apex REAL,
    spin REAL, spinAxis REAL, backSpin REAL, sideSpin REAL, created TEXT)`).run();
  await db.prepare("CREATE INDEX IF NOT EXISTS shots_club_date ON shots(club, date)").run();
  ready.add(db);
}

async function sha(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].slice(0, 10).map(b => b.toString(16).padStart(2, "0")).join("");
}

export const invalidateSc4 = db => db.prepare("DELETE FROM settings WHERE key = ?").bind(CACHE_KEY).run();

/** Imports one SC4 CSV export. Shots already stored (same file uploaded again) are skipped. */
export async function importCsv(ctx, text, swing = "auto") {
  if (!SWINGS.includes(swing)) throw new Error("swing must be auto, full or 3/4");
  const { mode, shots, skipped } = parseSc4Csv(text);
  if (!shots.length) throw new Error("No shots found in this file.");
  await ensureShots(ctx.db);
  const nowIso = ctx.now().toISOString();
  const sql = `INSERT OR IGNORE INTO shots (${SHOT_COLS.join(", ")}) VALUES (${SHOT_COLS.map(() => "?").join(", ")})`;
  const stmts = [];
  for (const s of shots) {
    const row = { ...s, id: await sha(shotKey(s)), swing, created: nowIso };
    stmts.push(ctx.db.prepare(sql).bind(...SHOT_COLS.map(c => (row[c] === undefined ? null : row[c]))));
  }
  let added = 0;
  for (let i = 0; i < stmts.length; i += 50) {
    const res = await ctx.db.batch(stmts.slice(i, i + 50));
    added += res.reduce((a, r) => a + (r.meta?.changes ?? 0), 0);
  }
  if (added) await invalidateSc4(ctx.db);
  return {
    mode, read: shots.length, added, duplicates: shots.length - added, skipped,
    clubs: [...new Set(shots.map(s => s.club))], dates: [...new Set(shots.map(s => s.date))].sort(),
  };
}

/** Analysis for the dashboard, LINE and Claude. Cached; recomputed once a day or after any change. */
export async function getSc4(ctx, { force = false } = {}) {
  const today = ctx.today();
  if (!force) {
    const cached = await getSetting(ctx.db, CACHE_KEY);
    if (cached && cached.day === today) return cached;
  }
  await ensureShots(ctx.db);
  const { results } = await ctx.db.prepare("SELECT * FROM shots ORDER BY date, rowid").all();
  const manual = ((await getSetting(ctx.db, "yardages")) || {}).clubs || {};
  const first = results.length ? results[0].date : today;
  const daily = new Map((await listDocs(ctx.db, "daily", { since: first })).map(d => [d.date, d]));
  const out = { ...analyze(results, { manual, daily, today }), day: today, updated: ctx.now().toISOString() };
  await setSetting(ctx.db, CACHE_KEY, out);
  return out;
}

/** Marks every shot of one club on one day as full / 3/4 / auto. */
export async function tagSession(ctx, date, club, swing) {
  if (!SWINGS.includes(swing)) throw new Error("swing must be auto, full or 3/4");
  await ensureShots(ctx.db);
  const r = await ctx.db.prepare("UPDATE shots SET swing = ? WHERE date = ? AND club = ?").bind(swing, date, club).run();
  await invalidateSc4(ctx.db);
  return r.meta?.changes ?? 0;
}

export async function deleteSession(ctx, date, club) {
  await ensureShots(ctx.db);
  const r = await ctx.db.prepare("DELETE FROM shots WHERE date = ? AND club = ?").bind(date, club).run();
  await invalidateSc4(ctx.db);
  return r.meta?.changes ?? 0;
}
