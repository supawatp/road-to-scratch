import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp, makeEnv, OWNER } from "./helpers.js";
import { CRON } from "../src/jobs.js";
import fs from "node:fs";

const scheduled = (app, env, cron) => app.scheduled({ cron, scheduledTime: Date.now() }, env, null);

test("wrangler.toml cron strings match the job table", () => {
  const toml = fs.readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  const crons = JSON.parse(/crons\s*=\s*(\[.*\])/.exec(toml)[1]);
  assert.deepEqual(crons, [CRON.morning, CRON.evening, CRON.weekly, CRON.jobs]);
});

test("morning job on Friday of week 1 pushes Strength C + Pilates reformer A with video links and writes the coach note", async () => {
  const { app, line } = makeApp("2026-10-23T01:45:00Z");
  const env = makeEnv({ PUBLIC_URL: "https://rts.example.workers.dev" });
  env.DB.raw.prepare("INSERT INTO daily (user_id, date, trained, drinks) VALUES ('U0123456789abcdef0123456789abcdef', '2026-10-22', 0, 1)").run();
  await scheduled(app, env, CRON.morning);
  const pushes = line.pushes();
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].body.to, OWNER);
  const flat = JSON.stringify(pushes[0].body.messages);
  assert.match(flat, /Strength C/);
  assert.match(flat, /Pilates reformer A/);
  assert.equal((flat.match(/youtube\.com\/results/g) || []).length, 3);
  assert.match(flat, /Never miss twice/);
  assert.match(flat, /https:\/\/rts\.example\.workers\.dev\//);
  const coach = env.DB.raw.prepare("SELECT * FROM coach WHERE date = '2026-10-23'").get();
  assert.equal(coach.title, "Week 1 · Fri 23 Oct");
  assert.match(coach.alerts, /Never miss twice/);
});

test("evening job pushes question 1 and skips when today is already logged", async () => {
  const { app, line } = makeApp("2026-10-23T14:30:00Z");
  const env = makeEnv();
  await scheduled(app, env, CRON.evening);
  assert.equal(line.pushes().length, 1);
  assert.match(line.pushes()[0].body.messages[0].text, /1\/9 · Woke on time\?/);
  env.DB.raw.prepare("INSERT INTO daily (user_id, date) VALUES ('U0123456789abcdef0123456789abcdef', '2026-10-23')").run();
  await scheduled(app, env, CRON.evening);
  assert.equal(line.pushes().length, 1, "no second push");
});

test("weekly job pushes the stats (no Claude without ANTHROPIC_API_KEY)", async () => {
  const { app, line } = makeApp("2026-10-25T13:00:00Z");
  const env = makeEnv();
  const ins = env.DB.raw.prepare("INSERT INTO daily (user_id, date, woke, trained, mobility, screens, drinks, practice) VALUES ('U0123456789abcdef0123456789abcdef', ?, 1, 1, 1, 1, ?, ?)");
  ins.run("2026-10-19", 0, 30); ins.run("2026-10-20", 1, 60);
  env.DB.raw.prepare("INSERT INTO rounds (id, user_id, date, front, back, money) VALUES ('r1', 'U0123456789abcdef0123456789abcdef', '2026-10-24', 43, 45, -2000)").run();
  await scheduled(app, env, CRON.weekly);
  const text = line.pushes()[0].body.messages[0].text;
  assert.match(text, /^Week 1 summary \(2026-10-19 to 2026-10-25\)/);
  assert.match(text, /Drinking nights: 1 \(max 3\)/);
  assert.match(text, /practice 90 min/);
  assert.match(text, /Rounds: 1 · avg 88 · money -2,000/);
});

test("monthly push budget: about 65 pushes a month, hard stop at PUSH_MONTHLY_LIMIT", async () => {
  // 31 mornings + 31 evenings + 4-5 Sundays ~= 66-67 worst case, well under ~300.
  const { app, line } = makeApp("2026-10-23T01:45:00Z");
  const env = makeEnv({ PUSH_MONTHLY_LIMIT: "2" });
  for (let i = 0; i < 4; i++) await scheduled(app, env, CRON.morning);
  assert.equal(line.pushes().length, 2);
  const counter = JSON.parse(env.DB.raw.prepare("SELECT json FROM settings WHERE key = 'push_count'").get().json);
  assert.deepEqual(counter, { month: "2026-10", count: 2 });
});
