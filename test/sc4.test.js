import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseSc4Csv, normalizeClub, speedSplit, classifySwings, withoutOutliers, clubStats, sessionsOf, gapsOf, clubOptions, pickClub, insightsOf, analyze,
} from "../src/sc4.js";
import { makeApp, makeEnv, webhookRequest, textEvent, TOKEN } from "./helpers.js";
import { CRON } from "../src/jobs.js";

const TARGET_HEAD = "﻿No.,CLUB,DATE,EQ,TO TARGET yd,CARRY yd,TOTAL yd,SIDE CARRY yd,SIDE TOTAL yd,CLUB SPEED mph,BALL SPEED mph,LAUNCH ANGLE deg,LAUNCH DIRECTION deg,SMASH FACTOR (deg),APEX ft,SPIN rpm,SPIN AXIS deg,BACK SPIN rpm,SIDE SPIN rpm";
const PRACTICE_HEAD = "No.,CLUB,DATE,EQ,CARRY yd,TOTAL yd,SIDE CARRY yd,SIDE TOTAL yd,CLUB SPEED mph,BALL SPEED mph,LAUNCH ANGLE deg,LAUNCH DIRECTION deg,SMASH FACTOR,APEX ft,SPIN rpm,SPIN AXIS deg,BACK SPIN rpm,SIDE SPIN rpm";

/** Builds an SC4 target-table CSV: shots = [{ club, date, carry, side, speed }] */
function targetCsv(shots) {
  const lines = [TARGET_HEAD, "avg,CLUB,DATE,EQ,20.0,130.9,139.7,9.6,11.0,76.2,96.2,22.3,1.4,1.3,75.2,6747.3,6.2,6675.1,785.0"];
  shots.forEach((s, i) => {
    const side = s.side == null ? "--" : `${s.side < 0 ? "L" : "R"} ${Math.abs(s.side).toFixed(1)}`;
    lines.push(`${i + 1},${s.club} - ,${s.date},X,15.0,${s.carry.toFixed(1)},${(s.carry + 8).toFixed(1)},${side},${side},${s.speed.toFixed(1)},${(s.speed * 1.28).toFixed(1)},22.0,R 1.5,1.3,80.0,${6500 + i},4.0,6400.0,500.0`);
  });
  return lines.join("\r\n");
}
const series = (club, date, n, carry, side, speed, spreadYd = 4) =>
  Array.from({ length: n }, (_, i) => ({ club, date, carry: carry + ((i % 5) - 2) * spreadYd / 2, side: side + ((i % 3) - 1), speed: speed + ((i % 3) - 1) * 0.5 }));

test("parses SC4 target and practice exports (BOM, avg row, L/R sides, '--')", () => {
  const t = parseSc4Csv(targetCsv([{ club: "8i", date: "2026-09-21", carry: 125.5, side: 17.8, speed: 74 }, { club: "8i", date: "2026-09-21", carry: 130, side: -2.5, speed: 75 }, { club: "8i", date: "2026-09-21", carry: 129, side: null, speed: 75 }]));
  assert.equal(t.mode, "target");
  assert.equal(t.skipped, 1, "avg row skipped");
  assert.equal(t.shots.length, 3);
  assert.deepEqual([t.shots[0].club, t.shots[0].date, t.shots[0].carry, t.shots[0].side, t.shots[0].launchDir, t.shots[0].toTarget], ["8i", "2026-09-21", 125.5, 17.8, 1.5, 15]);
  assert.equal(t.shots[1].side, -2.5, "left is negative");
  assert.equal(t.shots[2].side, null, "'--' is missing");
  const p = parseSc4Csv([PRACTICE_HEAD, "avg, , , ,156.8,167.7,7.3,8.4,82.6,107.2,18.8,1.0,1.3,76.5,5622.0,3.5,5587.2,272.5",
    "1,7i - ,2026-08-19,X,138.8,147.0,R 10.2,R 11.0,78.8,99.6,22.2,R 3.8,1.3,80.5,6471.0,0.0,6471.0,0.0"].join("\n"));
  assert.equal(p.mode, "practice");
  assert.deepEqual([p.shots[0].club, p.shots[0].carry, p.shots[0].clubSpeed, p.shots[0].toTarget], ["7i", 138.8, 78.8, null]);
  assert.throws(() => parseSc4Csv("name,score\nbob,3"), /SC4/);
});

test("club names are normalised", () => {
  assert.deepEqual(["7i - ", "Dr", "Driver", "4H", "4 Hybrid", "sw", "PW - ", "3W"].map(normalizeClub), ["7i", "D", "D", "4H", "4H", "SW", "PW", "3W"]);
});

test("outliers are removed with Tukey's fences before averaging; normal spread is kept", () => {
  assert.deepEqual(withoutOutliers([100, 140, 141, 142, 143, 144, 145, 146, 147, 190]), [140, 141, 142, 143, 144, 145, 146, 147]);
  const normal = [130, 133, 136, 139, 142, 145, 148, 151];
  assert.deepEqual(withoutOutliers(normal), normal, "no outliers -> nothing removed");
  assert.deepEqual(withoutOutliers([100, 150, 200]), [100, 150, 200], "fewer than 5 values are used as they are");
});

test("yardage = average ± 1 SD after removing mishits, and the mishit count is reported", () => {
  const shots = [...series("7i", "2026-09-01", 20, 146, 0, 80), { club: "7i", date: "2026-09-01", carry: 95, side: 40, speed: 80 }]
    .map(s => ({ ...s, clubSpeed: s.speed, swing: "auto" }));
  const [seven] = clubStats(classifySwings(shots).shots);
  assert.equal(seven.n, 21);
  assert.equal(seven.outliers, 1, "the 95-yd thin shot");
  assert.equal(seven.carry, 146);
  assert.equal(seven.carrySd, 2.8);
  assert.deepEqual([seven.lo, seven.hi], [143, 149]);
  assert.equal(seven.side, 0, "the 40-yd slice does not pull the direction average");
});

test("speedSplit separates full and 3/4 swings only when there are clearly two speeds", () => {
  const two = [...Array(10).fill(0).map((_, i) => 57 + (i % 4)), ...Array(14).fill(0).map((_, i) => 66 + (i % 4))];
  const s = speedSplit(two);
  assert.ok(s && s.threshold > 60 && s.threshold < 66, JSON.stringify(s));
  assert.equal(speedSplit(Array(30).fill(0).map((_, i) => 66 + (i % 8))), null, "one group");
  assert.equal(speedSplit([55, 56, 70, 71]), null, "too few shots");
});

test("wedge shots are labelled full / 3/4; tags and irons are respected", () => {
  const rows = [
    ...series("SW", "2026-08-10", 12, 60, 0, 58).map(s => ({ ...s, clubSpeed: s.speed, swing: "auto" })),
    ...series("SW", "2026-08-10", 14, 78, 0, 67).map(s => ({ ...s, clubSpeed: s.speed, swing: "auto" })),
    ...series("GW", "2026-08-11", 10, 80, 0, 60).map(s => ({ ...s, clubSpeed: s.speed, swing: "full" })),
    ...series("8i", "2026-08-11", 20, 120, 0, 60).map(s => ({ ...s, clubSpeed: s.speed + (s.carry > 120 ? 10 : 0), swing: "auto" })),
  ];
  const { shots } = classifySwings(rows);
  const count = (club, swing) => shots.filter(s => s.club === club && s.swing === swing).length;
  assert.equal(count("SW", "3/4"), 12);
  assert.equal(count("SW", "full"), 14);
  assert.equal(count("GW", "full"), 10, "explicit tag kept");
  assert.equal(count("8i", "3/4"), 0, "irons are never split");
});

const BASE = [
  ...series("7i", "2026-08-09", 20, 146, 1, 80),
  ...series("6i", "2026-08-09", 20, 148, -2, 79),
  ...series("8i", "2026-08-09", 20, 134, 3, 77),
  ...series("8i", "2026-09-21", 20, 128, 14, 73, 10),
  ...series("9i", "2026-08-09", 20, 124, 8, 75),
  ...series("9i", "2026-09-21", 20, 121, 9, 72),
  ...series("5i", "2026-08-09", 20, 160, 10, 81),
].map(s => ({ ...s, clubSpeed: s.speed, swing: "auto" }));

test("yardages use the most recent shots; gaps flag overlapping clubs", () => {
  const { shots } = classifySwings(BASE);
  const stats = clubStats(shots, 20);
  const eight = stats.find(s => s.club === "8i");
  assert.equal(eight.carry, 128, "last 20 shots only");
  assert.equal(eight.n, 20);
  assert.equal(eight.total, 40);
  assert.equal(stats[0].club, "5i", "longest first");
  const gap = gapsOf(stats).find(g => g.flag === "overlap");
  assert.deepEqual([gap.long, gap.short], ["6i", "7i"]);
  const sess = sessionsOf(shots).filter(s => s.club === "8i");
  assert.deepEqual(sess.map(s => s.date), ["2026-08-09", "2026-09-21"]);
});

test("insights: overlap, one-sided misses, drift, slower speed linked to the check-in, thin and stale data", () => {
  const rows = [...BASE, ...series("4i", "2026-08-09", 5, 167, 9, 82).map(s => ({ ...s, clubSpeed: s.speed, swing: "auto" }))];
  const daily = new Map([["2026-09-21", { energy: 2 }], ["2026-09-20", { drinks: 3 }]]);
  const a = analyze(rows, { daily, today: "2026-10-14", recent: 20, manual: { "7i": { full: 152 } } });
  const text = a.insights.map(i => `[${i.level}] ${i.text}`).join("\n");
  assert.match(text, /\[warn\] 6i \(148 yd\) and 7i \(146 yd\) carry almost the same\. For that distance, take the (6i|7i): its shots land in a tighter group/);
  assert.match(text, /\[warn\] Most misses go right: .*8i/);
  assert.match(text, /\[warn\] 8i is drifting right/);
  assert.match(text, /\[warn\] Club speed was down \d mph on Mon 21 Sep \(8i, 9i\).*energy 2\/5 that day, 3 drinks the night before/);
  assert.match(text, /\[info\] Saved yardages differ from SC4: 7i saved 152, SC4 146/);
  assert.match(text, /\[info\] Not enough shots yet for 4i \(5\)/);
  assert.match(text, /\[info\] Latest SC4 data is from Mon 21 Sep/);
  assert.equal(a.insights[0].level, "warn", "warnings first");
});

test("scoring-zone holes are flagged; long-club jumps are only info", () => {
  const stats = [
    { club: "PW", swing: "full", n: 30, carry: 109, lo: 105, hi: 114, side: 0 },
    { club: "PW", swing: "3/4", n: 20, carry: 93, lo: 88, hi: 98, side: 0 },
    { club: "5i", swing: "full", n: 30, carry: 160, lo: 152, hi: 166, side: 0 },
    { club: "4H", swing: "full", n: 30, carry: 179, lo: 175, hi: 184, side: 0 },
  ];
  const options = clubOptions(stats, {});
  const ins = insightsOf({ stats, sessions: [], options, today: "2026-09-22" });
  assert.ok(ins.some(i => i.kind === "hole" && /94–108 yd/.test(i.text)));
  assert.ok(ins.some(i => i.kind === "gap" && i.level === "info" && /4H \(179 yd\) to 5i \(160 yd\)/.test(i.text)));
});

test("club picker: SC4 numbers win over saved ones once a club has 10 shots; saved ones fill the gaps", () => {
  const stats = [
    { club: "7i", swing: "full", n: 40, carry: 146, lo: 140, hi: 151, side: 1 },
    { club: "8i", swing: "full", n: 40, carry: 134, lo: 125, hi: 139, side: 10 },
    { club: "4i", swing: "full", n: 5, carry: 167, lo: 150, hi: 172, side: 9 },
  ];
  const opts = clubOptions(stats, { "7i": { full: 150 }, D: { full: 225 }, "4i": { full: 170 } });
  assert.deepEqual(opts.map(o => `${o.club}:${o.carry}:${o.source}`), ["8i:134:sc4", "7i:146:sc4", "4i:170:manual", "D:225:manual"]);
  assert.equal(pickClub(opts, 140).pick.club, "7i");
  assert.equal(pickClub(opts, 140).below.club, "8i");
  assert.equal(pickClub(opts, 140, 1).pick.club, "4i", "+1 club into wind");
  assert.equal(pickClub(opts, 260).reason, "long");
  assert.equal(pickClub([], 140).reason, "none");
});

// ---- API + LINE -----------------------------------------------------------------------------

const call = (app, env, path, { method = "GET", body, type, token = TOKEN } = {}) => app.fetch(new Request("https://rts.example.workers.dev" + path, {
  method, body, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(type ? { "content-type": type } : {}) },
}), env);

const CSV_8I = targetCsv([...series("8i", "2026-09-21", 20, 128, 12, 73), ...series("8i", "2026-09-03", 20, 131, 13, 76)]);
const CSV_7I = targetCsv(series("7i", "2026-09-01", 20, 146, 0, 80));

test("upload: CSV import, re-upload adds nothing, stats, re-label and delete a session", async () => {
  const { app } = makeApp("2026-10-14T05:00:00Z");
  const env = makeEnv();
  assert.equal((await call(app, env, "/api/v1/sc4/import", { method: "POST", body: CSV_8I, token: null })).status, 401);
  let r = await (await call(app, env, "/api/v1/sc4/import", { method: "POST", body: CSV_8I, type: "text/csv" })).json();
  assert.deepEqual([r.mode, r.read, r.added, r.duplicates, r.dates], ["target", 40, 40, 0, ["2026-09-03", "2026-09-21"]]);
  r = await (await call(app, env, "/api/v1/sc4/import", { method: "POST", body: CSV_8I, type: "text/csv" })).json();
  assert.deepEqual([r.added, r.duplicates], [0, 40], "same file twice");
  await call(app, env, "/api/v1/sc4/import", { method: "POST", body: CSV_7I, type: "text/csv" });

  let stats = await (await call(app, env, "/api/v1/sc4/stats")).json();
  assert.equal(stats.id, "stats");
  assert.equal(stats.totalShots, 60);
  assert.deepEqual(stats.clubs.map(c => c.club), ["7i", "8i"]);
  assert.ok(stats.insights.some(i => /right/.test(i.text)));
  assert.equal((await call(app, env, "/api/v1/settings")).status, 200);
  assert.ok(!(await (await call(app, env, "/api/v1/settings")).json()).items.some(i => i.id === "sc4_stats"), "cache is internal");

  r = await (await call(app, env, "/api/v1/sc4/session", { method: "PUT", body: JSON.stringify({ date: "2026-09-01", club: "7i", swing: "3/4" }), type: "application/json" })).json();
  assert.equal(r.updated, 20);
  stats = await (await call(app, env, "/api/v1/sc4/stats")).json();
  assert.ok(stats.clubs.some(c => c.club === "7i" && c.swing === "3/4"), "cache refreshed after re-label");
  assert.equal(stats.sessions.find(s => s.club === "7i").tag, "3/4");

  r = await (await call(app, env, "/api/v1/sc4/session?date=2026-09-01&club=7i", { method: "DELETE" })).json();
  assert.equal(r.deleted, 20);
  stats = await (await call(app, env, "/api/v1/sc4/stats")).json();
  assert.equal(stats.totalShots, 40);

  assert.equal((await call(app, env, "/api/v1/sc4/import", { method: "POST", body: "a,b\n1,2", type: "text/csv" })).status, 400);
  assert.equal((await call(app, env, "/api/v1/sc4/import?swing=half", { method: "POST", body: CSV_7I, type: "text/csv" })).status, 400);
  assert.equal((await call(app, env, "/api/v1/sc4/session", { method: "PUT", body: JSON.stringify({ date: "x", club: "7i", swing: "full" }), type: "application/json" })).status, 400);
});

test("LINE: club 145 picks from SC4 data and explains the aim", async () => {
  const { app, line } = makeApp("2026-10-14T05:00:00Z");
  const env = makeEnv();
  const send = t => app.fetch(webhookRequest([textEvent(t)]), env);
  await send("club 140");
  assert.match(line.replies().at(-1).body.messages[0].text, /No yardages yet/);
  await call(app, env, "/api/v1/sc4/import", { method: "POST", body: CSV_8I, type: "text/csv" });
  await call(app, env, "/api/v1/sc4/import", { method: "POST", body: CSV_7I, type: "text/csv" });
  await send("club 140");
  const t = line.replies().at(-1).body.messages[0].text;
  assert.match(t, /^140 yd → 7-iron\nCarry 146 yd, usually \d+–\d+ \(SC4 average ± 1 SD, last 20 shots\)\nAim at the middle of the green\.\n8-iron \(\d+\) only gets there if you flush it\./);
  await send("club 125");
  assert.match(line.replies().at(-1).body.messages[0].text, /8-iron[\s\S]*Misses 1\d yd right on average: aim at the left half/);
  await send("club 125 +1");
  assert.match(line.replies().at(-1).body.messages[0].text, /^125 yd \(\+1 club\) → 7-iron/);
  await send("club 140 +1");
  assert.match(line.replies().at(-1).body.messages[0].text, /beyond your average carry/, "nothing longer than the 7i");
  await send("club far");
  assert.match(line.replies().at(-1).body.messages[0].text, /e\.g\. club 145/);
});

test("Sunday summary includes SC4 sessions and the top insights; Claude summary carries SC4 data", async () => {
  const { app, line } = makeApp("2026-09-27T13:00:00Z"); // Sunday 20:00 Bangkok
  const env = makeEnv();
  await call(app, env, "/api/v1/sc4/import", { method: "POST", body: targetCsv(series("8i", "2026-09-24", 20, 128, 12, 73)), type: "text/csv" });
  await call(app, env, "/api/v1/sc4/import", { method: "POST", body: CSV_8I, type: "text/csv" });
  await app.scheduled({ cron: CRON.weekly }, env, null);
  const text = line.pushes()[0].body.messages[0].text;
  assert.match(text, /SC4: 40 shots, 2 practice days/); // 21 and 24 Sep
  assert.match(text, /- .*right/);
  const summary = await (await call(app, env, "/api/v1/summary?days=14")).json();
  assert.equal(summary.sc4.shots, 60);
  assert.ok(summary.sc4.recentSessions.length >= 2);
});
