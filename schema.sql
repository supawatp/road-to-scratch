-- Road to Scratch - D1 schema (spec section 6). Safe to run more than once.
CREATE TABLE IF NOT EXISTS daily   (date TEXT PRIMARY KEY, woke INT, trained INT, mobility INT, screens INT,
                                    drinks INT, practice INT, water REAL, energy INT, note TEXT, week INT, updated TEXT);
CREATE TABLE IF NOT EXISTS rounds  (id TEXT PRIMARY KEY, date TEXT, course TEXT, tee TEXT, sleep REAL, drinks INT,
                                    front INT, back INT, fw INT, gir INT, putts INT, threePutts INT, penalties INT,
                                    doubles INT, apShort INT, apLong INT, money INT, mind INT, note TEXT, created TEXT);
CREATE TABLE IF NOT EXISTS tests   (id TEXT PRIMARY KEY, date TEXT, dSpeed REAL, dCarry REAL, dDir REAL, iSpeed REAL,
                                    iBall REAL, iCarry REAL, iSpread REAL, iDir REAL, wedge INT, p6 INT, lag INT,
                                    note TEXT, created TEXT);
CREATE TABLE IF NOT EXISTS body    (id TEXT PRIMARY KEY, date TEXT, weight REAL, waist REAL, uric REAL, flare INT,
                                    note TEXT, created TEXT);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, json TEXT);   -- program, program_overrides, main (cap), yardages, origin, push_count
CREATE TABLE IF NOT EXISTS coach   (date TEXT PRIMARY KEY, title TEXT, message TEXT, alerts TEXT, created TEXT);
CREATE TABLE IF NOT EXISTS convo   (user_id TEXT PRIMARY KEY, flow TEXT, step INT, draft TEXT, updated TEXT);

CREATE INDEX IF NOT EXISTS rounds_date ON rounds(date);
CREATE INDEX IF NOT EXISTS tests_date  ON tests(date);
CREATE INDEX IF NOT EXISTS body_date   ON body(date);
