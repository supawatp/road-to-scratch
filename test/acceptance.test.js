// Spec section 11 acceptance tests, run against the real router with an in-memory D1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp, makeEnv, webhookRequest, textEvent, postbackEvent, OWNER, TOKEN } from "./helpers.js";
import { QUESTIONS } from "../src/checkin.js";

const FRI_2135 = "2026-10-23T14:35:00Z"; // Friday 21:35 Bangkok, week 1
const STRANGER = "Uffffffffffffffffffffffffffffffff";

const lastReply = line => line.replies().at(-1).body.messages;

test("non-owner users are ignored (no reply, no data)", async () => {
  const { app, line } = makeApp(FRI_2135);
  const env = makeEnv();
  const res = await app.fetch(webhookRequest([textEvent("hello", STRANGER), textEvent("today", STRANGER), postbackEvent("ci:woke:1", STRANGER)]), env);
  assert.equal(res.status, 200);
  assert.equal(line.calls.length, 0);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) n FROM convo").get().n, 0);
});

test("'hello' returns the user ID only before OWNER_LINE_USER_ID is set", async () => {
  const before = makeApp(FRI_2135);
  await before.app.fetch(webhookRequest([textEvent("hello", STRANGER), textEvent("today", STRANGER)]), makeEnv({ OWNER_LINE_USER_ID: "" }));
  assert.equal(before.line.replies().length, 1, "only hello gets an answer in setup mode");
  assert.match(lastReply(before.line)[0].text, new RegExp(STRANGER));

  const after = makeApp(FRI_2135);
  await after.app.fetch(webhookRequest([textEvent("hello")]), makeEnv());
  assert.equal(after.line.replies().length, 1);
  assert.doesNotMatch(lastReply(after.line)[0].text, new RegExp(OWNER));
});

async function fullCheckin(app, env, answers, note) {
  for (const data of answers) await app.fetch(webhookRequest([postbackEvent(data)]), env);
  return app.fetch(webhookRequest([note == null ? postbackEvent("ci:note:skip") : textEvent(note)]), env);
}

test("full check-in by buttons creates the daily row; repeating it updates the same row", async () => {
  const { app, line } = makeApp(FRI_2135);
  const env = makeEnv();
  await app.fetch(webhookRequest([textEvent("checkin")]), env);
  assert.match(lastReply(line)[0].text, /1\/9 · Woke on time\?/);

  await fullCheckin(app, env, ["ci:woke:1", "ci:trained:1", "ci:mobility:1", "ci:screens:0", "ci:drinks:0", "ci:practice:30", "ci:water:2", "ci:energy:4"], "good session");
  let rows = env.DB.raw.prepare("SELECT * FROM daily").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].date, "2026-10-23");
  assert.equal(rows[0].week, 1);
  assert.equal(rows[0].note, "good session");
  assert.equal(lastReply(line)[0].text.split("\n")[0], "4/5 habits - screens off by 23:45");
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) n FROM convo").get().n, 0, "conversation cleared");

  await fullCheckin(app, env, ["ci:woke:1", "ci:trained:2", "ci:mobility:1", "ci:screens:1", "ci:drinks:2", "ci:practice:0", "ci:water:3", "ci:energy:3"]);
  rows = env.DB.raw.prepare("SELECT * FROM daily").all();
  assert.equal(rows.length, 1, "same day -> same row");
  assert.equal(rows[0].trained, 2);
  assert.equal(rows[0].drinks, 2);
  assert.equal(rows[0].note, "");
  assert.equal(line.pushes().length, 0, "check-in uses free replies only");
});

test("typing text mid check-in re-asks the current question", async () => {
  const { app, line } = makeApp(FRI_2135);
  const env = makeEnv();
  await app.fetch(webhookRequest([postbackEvent("ci:woke:1")]), env);
  await app.fetch(webhookRequest([textEvent("yes I did")]), env);
  const m = lastReply(line)[0];
  assert.match(m.text, /2\/9 · Did the planned session\?/);
  assert.equal(m.quickReply.items.length, 3);
});

test("text commands: today, plan, round, body, help, unclear round", async () => {
  const { app, line } = makeApp(FRI_2135);
  const env = makeEnv();
  await app.fetch(webhookRequest([textEvent("today")]), env);
  assert.match(lastReply(line).map(m => m.text).join("\n"), /Strength C[\s\S]*youtube\.com/);
  await app.fetch(webhookRequest([textEvent("plan")]), env);
  assert.match(lastReply(line)[0].text, /^Week 1: Baseline week/);
  await app.fetch(webhookRequest([textEvent("round 42 45 putts 33 pen 1 dbl 2 short 4 long 0 money -5000")]), env);
  const r = env.DB.raw.prepare("SELECT * FROM rounds").get();
  assert.deepEqual([r.front, r.back, r.putts, r.penalties, r.doubles, r.apShort, r.apLong, r.money, r.date], [42, 45, 33, 1, 2, 4, 0, -5000, "2026-10-23"]);
  assert.match(lastReply(line)[0].text, /87 \(42\/45\)/);
  await app.fetch(webhookRequest([textEvent("round 42 45 putts thirty")]), env);
  assert.match(lastReply(line)[0].text, /needs a number/);
  await app.fetch(webhookRequest([textEvent("round 42 45 birdies 2")]), env);
  assert.match(lastReply(line)[0].text, /don't know "birdies"/);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) n FROM rounds").get().n, 1, "unclear rounds are not saved");
  await app.fetch(webhookRequest([textEvent("body 80 82")]), env);
  const b = env.DB.raw.prepare("SELECT * FROM body").get();
  assert.deepEqual([b.weight, b.waist, b.flare], [80, 82, 0]);
  await app.fetch(webhookRequest([textEvent("quota")]), env);
  assert.match(lastReply(line)[0].text, /12 of 300/);
});

const api = (app, env, path, { method = "GET", body, token = TOKEN, cookie } = {}) => app.fetch(new Request("https://rts.example.workers.dev" + path, {
  method, body: body ? JSON.stringify(body) : undefined,
  headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json" } : {}) },
}), env);

test("API without a token returns 401; wrong token 401; dashboard redirects to login", async () => {
  const { app } = makeApp(FRI_2135);
  const env = makeEnv();
  assert.equal((await api(app, env, "/api/v1/daily", { token: null })).status, 401);
  assert.equal((await api(app, env, "/api/v1/daily", { token: "wrong-token-wrong-token" })).status, 401);
  assert.equal((await api(app, env, "/api/v1/summary", { token: null })).status, 401);
  const dash = await app.fetch(new Request("https://rts.example.workers.dev/"), env);
  assert.equal(dash.status, 303);
  assert.match(dash.headers.get("location"), /\/login$/);
  assert.equal((await api(app, makeEnv({ API_TOKEN: "" }), "/api/v1/daily", { token: "" })).status, 401, "unset token denies all");
});

test("login sets an HttpOnly cookie that opens the dashboard and the API", async () => {
  const { app } = makeApp(FRI_2135);
  const env = makeEnv();
  const bad = await app.fetch(new Request("https://rts.example.workers.dev/login", { method: "POST", body: new URLSearchParams({ token: "nope" }) }), env);
  assert.equal(bad.status, 401);
  const res = await app.fetch(new Request("https://rts.example.workers.dev/login", { method: "POST", body: new URLSearchParams({ token: TOKEN }) }), env);
  assert.equal(res.status, 303);
  const setCookie = res.headers.get("set-cookie");
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Strict/);
  const cookie = setCookie.split(";")[0];
  const dash = await app.fetch(new Request("https://rts.example.workers.dev/", { headers: { cookie } }), env);
  assert.equal(dash.status, 200);
  assert.equal(await dash.text(), "<html>dashboard</html>");
  assert.equal((await api(app, env, "/api/v1/daily", { token: null, cookie })).status, 200);
});

test("dashboard writes (shim calls) and LINE check-in see the same data through the API", async () => {
  const { app } = makeApp(FRI_2135);
  const env = makeEnv();
  // dashboard check-in: PUT daily/<date> with booleans
  let r = await api(app, env, "/api/v1/daily/2026-10-22", { method: "PUT", body: { date: "2026-10-22", woke: true, trained: false, mobility: true, screens: true, drinks: 0, practice: 30, water: 2, energy: 3, note: "" } });
  assert.equal(r.status, 200);
  // LINE check-in for 2026-10-23
  await fullCheckin(app, env, ["ci:woke:1", "ci:trained:1", "ci:mobility:1", "ci:screens:1", "ci:drinks:0", "ci:practice:60", "ci:water:3", "ci:energy:5"]);
  const list = await (await api(app, env, "/api/v1/daily")).json();
  assert.deepEqual(list.items.map(d => d.id), ["2026-10-23", "2026-10-22"]);
  assert.equal(list.items[1].woke, 1);
  assert.equal(list.items[1].week, 1, "server fills the week");
  // rounds: POST then DELETE
  r = await api(app, env, "/api/v1/rounds", { method: "POST", body: { date: "2026-10-24", front: 44, back: 46, money: 1000, created: "x" } });
  assert.equal(r.status, 201);
  const { id } = await r.json();
  assert.ok(id);
  assert.equal((await (await api(app, env, `/api/v1/rounds/${id}`)).json()).front, 44);
  assert.equal((await api(app, env, `/api/v1/rounds/${id}`, { method: "DELETE" })).status, 204);
  assert.equal((await api(app, env, `/api/v1/rounds/${id}`)).status, 404);
  // settings docs used by the dashboard
  await api(app, env, "/api/v1/settings/main", { method: "PUT", body: { cap: 3000 } });
  assert.equal((await (await api(app, env, "/api/v1/settings/main")).json()).cap, 3000);
  // coach alerts round-trip as an array
  await api(app, env, "/api/v1/coach/2026-10-23", { method: "PUT", body: { title: "T", message: "M", alerts: ["a", "b"] } });
  assert.deepEqual((await (await api(app, env, "/api/v1/coach/2026-10-23")).json()).alerts, ["a", "b"]);
  // summary for Claude
  const s = await (await api(app, env, "/api/v1/summary?days=14")).json();
  assert.equal(s.today, "2026-10-23");
  assert.equal(s.week, 1);
  assert.equal(s.daily.length, 2);
  assert.equal(s.stats.logged, 2);
});

test("API input validation", async () => {
  const { app } = makeApp(FRI_2135);
  const env = makeEnv();
  assert.equal((await api(app, env, "/api/v1/daily/not-a-date", { method: "PUT", body: {} })).status, 400);
  assert.equal((await api(app, env, "/api/v1/convo")).status, 404, "conversation state is not exposed");
  assert.equal((await api(app, env, "/api/v1/settings/push_count")).status, 400, "internal settings are hidden");
  assert.equal((await app.fetch(new Request("https://rts.example.workers.dev/api/v1/rounds", { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: "{oops" }), env)).status, 400);
});

test("?missing=null returns 200 null for documents that don't exist yet", async () => {
  const { app } = makeApp(FRI_2135);
  const env = makeEnv();
  const r = await api(app, env, "/api/v1/settings/yardages?missing=null");
  assert.equal(r.status, 200);
  assert.equal(await r.json(), null);
});

test("setup-mode hello tolerates punctuation and capitals", async () => {
  const { app, line } = makeApp(FRI_2135);
  await app.fetch(webhookRequest([textEvent("Hello!", STRANGER)]), makeEnv({ OWNER_LINE_USER_ID: "" }));
  assert.match(lastReply(line)[0].text, new RegExp(STRANGER));
});
