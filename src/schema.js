// Database schema (version 2: multi-user) and the one-time migration from version 1 (single user).
// ensureSchema() runs once per Worker isolate: it creates missing tables, migrates old data to the
// owner's user id, and makes sure the owner exists as the admin.

export const SCHEMA_VERSION = 2;

// Tracker tables (user_id first). Kept in the same order as schema.sql.
export const TABLES = {
  users: `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT, display_name TEXT, picture TEXT, status TEXT, role TEXT,
    golfer INT, lang TEXT, consent_at TEXT, approved_at TEXT, limits TEXT, created TEXT, updated TEXT, last_seen TEXT)`,
  profiles: `CREATE TABLE IF NOT EXISTS profiles (user_id TEXT PRIMARY KEY, answers TEXT, answers_version INT, answered_at TEXT,
    notes TEXT, flags TEXT, updated TEXT)`,
  programs: `CREATE TABLE IF NOT EXISTS programs (id TEXT PRIMARY KEY, user_id TEXT, version INT, status TEXT, json TEXT, summary TEXT,
    changes TEXT, created TEXT, updated TEXT)`,
  messages: `CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, user_id TEXT, ts TEXT, dir TEXT, kind TEXT, type TEXT, text TEXT,
    data TEXT, media_id TEXT, line_id TEXT, model TEXT, tokens_in INT, tokens_out INT)`,
  media: `CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, user_id TEXT, ts TEXT, type TEXT, content_type TEXT, size INT, r2_key TEXT,
    category TEXT, description TEXT, analysis TEXT, line_id TEXT)`,
  jobs: `CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, kind TEXT, user_id TEXT, status TEXT, payload TEXT, result TEXT, error TEXT,
    attempts INT, created TEXT, updated TEXT)`,
  daily: `CREATE TABLE IF NOT EXISTS daily (user_id TEXT NOT NULL, date TEXT NOT NULL, woke INT, trained INT, mobility INT, screens INT,
    drinks INT, practice INT, water REAL, energy INT, note TEXT, week INT, updated TEXT, PRIMARY KEY (user_id, date))`,
  rounds: `CREATE TABLE IF NOT EXISTS rounds (id TEXT PRIMARY KEY, user_id TEXT, date TEXT, course TEXT, tee TEXT, sleep REAL, drinks INT,
    front INT, back INT, fw INT, gir INT, putts INT, threePutts INT, penalties INT, doubles INT, apShort INT, apLong INT, money INT,
    mind INT, note TEXT, created TEXT)`,
  tests: `CREATE TABLE IF NOT EXISTS tests (id TEXT PRIMARY KEY, user_id TEXT, date TEXT, dSpeed REAL, dCarry REAL, dDir REAL, iSpeed REAL,
    iBall REAL, iCarry REAL, iSpread REAL, iDir REAL, wedge INT, p6 INT, lag INT, note TEXT, created TEXT)`,
  body: `CREATE TABLE IF NOT EXISTS body (id TEXT PRIMARY KEY, user_id TEXT, date TEXT, weight REAL, waist REAL, uric REAL, flare INT,
    note TEXT, created TEXT)`,
  coach: `CREATE TABLE IF NOT EXISTS coach (user_id TEXT NOT NULL, date TEXT NOT NULL, title TEXT, message TEXT, alerts TEXT, created TEXT,
    PRIMARY KEY (user_id, date))`,
  shots: `CREATE TABLE IF NOT EXISTS shots (id TEXT PRIMARY KEY, user_id TEXT, date TEXT, club TEXT, mode TEXT, swing TEXT, no INT, carry REAL,
    total REAL, side REAL, sideTotal REAL, toTarget REAL, clubSpeed REAL, ballSpeed REAL, launch REAL, launchDir REAL, smash REAL,
    apex REAL, spin REAL, spinAxis REAL, backSpin REAL, sideSpin REAL, created TEXT)`,
  settings: `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, json TEXT)`,
  convo: `CREATE TABLE IF NOT EXISTS convo (user_id TEXT PRIMARY KEY, flow TEXT, step INT, draft TEXT, updated TEXT)`,
};

export const INDEXES = [
  "CREATE INDEX IF NOT EXISTS rounds_user_date ON rounds(user_id, date)",
  "CREATE INDEX IF NOT EXISTS tests_user_date ON tests(user_id, date)",
  "CREATE INDEX IF NOT EXISTS body_user_date ON body(user_id, date)",
  "CREATE INDEX IF NOT EXISTS shots_user_club_date ON shots(user_id, club, date)",
  "CREATE INDEX IF NOT EXISTS messages_user_ts ON messages(user_id, ts)",
  "CREATE INDEX IF NOT EXISTS media_user_ts ON media(user_id, ts)",
  "CREATE INDEX IF NOT EXISTS programs_user ON programs(user_id, status)",
  "CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status, created)",
];

// Per-user settings that version 1 stored under plain keys.
const V1_USER_SETTINGS = ["yardages", "main", "program", "program_overrides", "chat_memory", "chat_count", "sc4_stats"];

async function hasColumn(db, table, column) {
  try { await db.prepare(`SELECT ${column} FROM ${table} LIMIT 0`).all(); return true; } catch { return false; }
}
async function tableExists(db, table) {
  const r = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").bind(table).first();
  return !!r;
}

/** Statements that turn a version-1 database into version 2, giving every existing row to `ownerId`. */
export async function migrationV1toV2(db, ownerId) {
  const s = [];
  const newTables = ["users", "profiles", "programs", "messages", "media", "jobs"].map(t => TABLES[t]);
  s.push(...newTables);
  // daily and coach change their primary key -> rebuild
  const daily = TABLES.daily.replace("IF NOT EXISTS daily", "daily_v2");
  s.push(daily, `INSERT INTO daily_v2 (user_id, date, woke, trained, mobility, screens, drinks, practice, water, energy, note, week, updated)
    SELECT ?, date, woke, trained, mobility, screens, drinks, practice, water, energy, note, week, updated FROM daily`, "DROP TABLE daily",
    "ALTER TABLE daily_v2 RENAME TO daily");
  const coach = TABLES.coach.replace("IF NOT EXISTS coach", "coach_v2");
  s.push(coach, "INSERT INTO coach_v2 (user_id, date, title, message, alerts, created) SELECT ?, date, title, message, alerts, created FROM coach",
    "DROP TABLE coach", "ALTER TABLE coach_v2 RENAME TO coach");
  // other tables just gain a user_id column
  if (!(await tableExists(db, "shots"))) s.push(TABLES.shots.replace(", user_id TEXT", ""));
  for (const t of ["rounds", "tests", "body", "shots"]) {
    s.push(`ALTER TABLE ${t} ADD COLUMN user_id TEXT`, `UPDATE ${t} SET user_id = ? WHERE user_id IS NULL`);
  }
  // per-user settings move under u:<owner>:<key>
  for (const k of V1_USER_SETTINGS) s.push(`UPDATE settings SET key = 'u:' || ? || ':' || key WHERE key = '${k}'`);
  s.push(...INDEXES);
  const needsOwner = sql => /SELECT \?|SET user_id = \?|'u:' \|\| \?/.test(sql);
  return s.map(sql => (needsOwner(sql) ? db.prepare(sql).bind(ownerId) : db.prepare(sql)));
}

const done = new WeakSet();

/**
 * Makes the database current. Safe to call on every request (cheap after the first time per isolate).
 * Returns the schema version.
 */
export async function ensureSchema(db, env, nowIso = new Date().toISOString()) {
  const base = db.base || db;
  if (done.has(base)) return SCHEMA_VERSION;
  const owner = (env.OWNER_LINE_USER_ID || "").trim();
  await base.prepare(TABLES.settings).run();
  const v = await base.prepare("SELECT json FROM settings WHERE key = 'schema_version'").first();
  let version = v ? Number(JSON.parse(v.json)) : 0;

  if (version < 2) {
    const oldDaily = (await tableExists(base, "daily")) && !(await hasColumn(base, "daily", "user_id"));
    if (oldDaily) {
      if (!owner) throw new Error("OWNER_LINE_USER_ID must be set before the multi-user migration can run");
      try {
        await base.batch(await migrationV1toV2(base, owner)); // D1 runs a batch as one transaction
        console.log("migrated database to schema v2 for owner", owner);
      } catch (e) {
        // Another request may have migrated at the same moment.
        if (!(await hasColumn(base, "daily", "user_id"))) throw e;
      }
    }
    await base.batch([...Object.values(TABLES), ...INDEXES].map(sql => base.prepare(sql)));
    await base.prepare("INSERT OR REPLACE INTO settings (key, json) VALUES ('schema_version', ?)").bind(String(SCHEMA_VERSION)).run();
    version = SCHEMA_VERSION;
  }
  if (owner) {
    await base.prepare(`INSERT OR IGNORE INTO users (id, name, status, role, golfer, lang, consent_at, approved_at, created, updated)
      VALUES (?, 'Owner', 'active', 'admin', 1, 'en', ?, ?, ?, ?)`).bind(owner, nowIso, nowIso, nowIso, nowIso).run();
    await base.prepare("UPDATE users SET role = 'admin', status = CASE WHEN status IN ('active','disabled') THEN status ELSE 'active' END WHERE id = ?").bind(owner).run();
  }
  done.add(base);
  return version;
}
