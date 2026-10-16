-- Road to Scratch - D1 schema version 2 (multi-user). Safe to run more than once.
-- The Worker also creates these tables itself and migrates a version-1 (single-user) database on first start.
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT, display_name TEXT, picture TEXT, status TEXT, role TEXT,
    golfer INT, lang TEXT, consent_at TEXT, approved_at TEXT, limits TEXT, created TEXT, updated TEXT, last_seen TEXT);
CREATE TABLE IF NOT EXISTS profiles (user_id TEXT PRIMARY KEY, answers TEXT, answers_version INT, answered_at TEXT,
    notes TEXT, flags TEXT, updated TEXT);
CREATE TABLE IF NOT EXISTS programs (id TEXT PRIMARY KEY, user_id TEXT, version INT, status TEXT, json TEXT, summary TEXT,
    changes TEXT, created TEXT, updated TEXT);
CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, user_id TEXT, ts TEXT, dir TEXT, kind TEXT, type TEXT, text TEXT,
    data TEXT, media_id TEXT, line_id TEXT, model TEXT, tokens_in INT, tokens_out INT);
CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, user_id TEXT, ts TEXT, type TEXT, content_type TEXT, size INT, r2_key TEXT,
    category TEXT, description TEXT, analysis TEXT, line_id TEXT);
CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, kind TEXT, user_id TEXT, status TEXT, payload TEXT, result TEXT, error TEXT,
    attempts INT, created TEXT, updated TEXT);
CREATE TABLE IF NOT EXISTS daily (user_id TEXT NOT NULL, date TEXT NOT NULL, woke INT, trained INT, mobility INT, screens INT,
    drinks INT, practice INT, water REAL, energy INT, note TEXT, week INT, updated TEXT, PRIMARY KEY (user_id, date));
CREATE TABLE IF NOT EXISTS rounds (id TEXT PRIMARY KEY, user_id TEXT, date TEXT, course TEXT, tee TEXT, sleep REAL, drinks INT,
    front INT, back INT, fw INT, gir INT, putts INT, threePutts INT, penalties INT, doubles INT, apShort INT, apLong INT, money INT,
    mind INT, note TEXT, created TEXT);
CREATE TABLE IF NOT EXISTS tests (id TEXT PRIMARY KEY, user_id TEXT, date TEXT, dSpeed REAL, dCarry REAL, dDir REAL, iSpeed REAL,
    iBall REAL, iCarry REAL, iSpread REAL, iDir REAL, wedge INT, p6 INT, lag INT, note TEXT, created TEXT);
CREATE TABLE IF NOT EXISTS body (id TEXT PRIMARY KEY, user_id TEXT, date TEXT, weight REAL, waist REAL, uric REAL, flare INT,
    note TEXT, created TEXT);
CREATE TABLE IF NOT EXISTS coach (user_id TEXT NOT NULL, date TEXT NOT NULL, title TEXT, message TEXT, alerts TEXT, created TEXT,
    PRIMARY KEY (user_id, date));
CREATE TABLE IF NOT EXISTS shots (id TEXT PRIMARY KEY, user_id TEXT, date TEXT, club TEXT, mode TEXT, swing TEXT, no INT, carry REAL,
    total REAL, side REAL, sideTotal REAL, toTarget REAL, clubSpeed REAL, ballSpeed REAL, launch REAL, launchDir REAL, smash REAL,
    apex REAL, spin REAL, spinAxis REAL, backSpin REAL, sideSpin REAL, created TEXT);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, json TEXT);   -- global keys + per-user keys "u:<user id>:<key>"
CREATE TABLE IF NOT EXISTS convo (user_id TEXT PRIMARY KEY, flow TEXT, step INT, draft TEXT, updated TEXT);

CREATE INDEX IF NOT EXISTS rounds_user_date ON rounds(user_id, date);
CREATE INDEX IF NOT EXISTS tests_user_date ON tests(user_id, date);
CREATE INDEX IF NOT EXISTS body_user_date ON body(user_id, date);
CREATE INDEX IF NOT EXISTS shots_user_club_date ON shots(user_id, club, date);
CREATE INDEX IF NOT EXISTS messages_user_ts ON messages(user_id, ts);
CREATE INDEX IF NOT EXISTS media_user_ts ON media(user_id, ts);
CREATE INDEX IF NOT EXISTS programs_user ON programs(user_id, status);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status, created);

INSERT OR IGNORE INTO settings (key, json) VALUES ('schema_version', '2');
