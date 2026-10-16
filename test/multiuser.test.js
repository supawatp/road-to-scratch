// Multi-user: migration, isolation, sign-up -> onboarding -> program design -> activation, photos, chat log, admin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import { createApp } from "../src/app.js";
import { ensureSchema } from "../src/schema.js";
import { signSession, verifySession } from "../src/users.js";
import { validateDesign, programToDesign, designToProgram, nextMonday } from "../src/programs.js";
import { cleanAnswers, healthFlags } from "../src/questionnaire.js";
import { CRON } from "../src/jobs.js";
import { program, makeEnv, sign, OWNER, TOKEN } from "./helpers.js";

const FRIEND = "Ufriend0000000000000000000000000";
const T0 = "2026-10-20T05:00:00Z"; // Tue 20 Oct 12:00 Bangkok

// ---- fakes ---------------------------------------------------------------------------------------

function fakeR2() {
  const store = new Map();
  return {
    store,
    async put(key, bytes, opts) { store.set(key, { bytes, opts }); },
    async get(key) { const o = store.get(key); return o ? { body: o.bytes } : null; },
    async list({ prefix }) { return { objects: [...store.keys()].filter(k => k.startsWith(prefix)).map(key => ({ key })), truncated: false }; },
    async delete(keys) { for (const k of [].concat(keys)) store.delete(k); },
  };
}

const msg = (content, stop_reason = "end_turn") => ({ id: "msg_" + Math.random().toString(36).slice(2), type: "message", role: "assistant", model: "claude-opus-5-5",
  content, stop_reason, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 20 } });
const say = text => msg([{ type: "text", text }]);
const useTool = (name, input) => msg([{ type: "thinking", thinking: "", signature: "sig" }, { type: "tool_use", id: "tu_" + name, name, input }], "tool_use");

/** Server-sent events for the streaming API (used by the program designer). */
function sse(m) {
  const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  let out = ev("message_start", { message: { ...m, content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 0 } } });
  m.content.forEach((b, index) => {
    out += ev("content_block_start", { index, content_block: { type: "text", text: "" } });
    out += ev("content_block_delta", { index, delta: { type: "text_delta", text: b.text } });
    out += ev("content_block_stop", { index });
  });
  out += ev("message_delta", { delta: { stop_reason: m.stop_reason, stop_sequence: null }, usage: { output_tokens: 500 } });
  out += ev("message_stop", {});
  return new Response(out, { headers: { "content-type": "text/event-stream" } });
}

function setup({ at = T0, script = [], env: envOver = {} } = {}) {
  const calls = [], claude = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith("https://api.anthropic.com/")) {
      const body = JSON.parse(init.body);
      claude.push(body);
      const next = script.shift();
      if (!next) throw new Error("no scripted Claude response");
      return body.stream ? sse(next) : new Response(JSON.stringify(next), { headers: { "content-type": "application/json" } });
    }
    if (u.startsWith("https://api.line.me/oauth2/v2.1/verify")) {
      const p = new URLSearchParams(init.body);
      if (p.get("id_token") === "good-token-friend") return new Response(JSON.stringify({ sub: FRIEND, name: "Somchai", aud: p.get("client_id") }));
      return new Response(JSON.stringify({ error: "invalid_request", error_description: "Invalid IdToken." }), { status: 400 });
    }
    if (u.startsWith("https://api-data.line.me/v2/bot/message/")) {
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]), { headers: { "content-type": "image/jpeg", "content-length": "8" } });
    }
    calls.push({ url: u, method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null });
    if (u.includes("/v2/bot/profile/")) return new Response(JSON.stringify({ displayName: u.includes(FRIEND) ? "Somchai LINE" : "Supawat", pictureUrl: "https://example/p.jpg" }));
    return new Response("{}");
  };
  const clock = { now: new Date(at) };
  const app = createApp({ program, dashboardHtml: "<html><script>/*app*/</script></html>", fetchImpl, now: () => clock.now });
  const env = makeEnv({ ANTHROPIC_API_KEY: "test-key", LIFF_ID: "2000000000-abcdefgh", LINE_LOGIN_CHANNEL_ID: "2000000000", MEDIA: fakeR2(), ...envOver });
  const pushesTo = id => calls.filter(c => c.url.endsWith("/message/push") && c.body.to === id);
  const repliesText = () => calls.filter(c => c.url.endsWith("/reply")).map(c => JSON.stringify(c.body.messages));
  return { app, env, calls, claude, clock, script, pushesTo, repliesText };
}

let n = 0;
const ev = (userId, extra) => ({ replyToken: "rt" + ++n, source: { type: "user", userId }, timestamp: Date.now(), ...extra });
const text = (userId, t) => ev(userId, { type: "message", message: { type: "text", id: "m" + n, text: t } });
const follow = userId => ev(userId, { type: "follow" });
const postback = (userId, data) => ev(userId, { type: "postback", postback: { data } });
const image = userId => ev(userId, { type: "message", message: { type: "image", id: "img" + n, contentProvider: { type: "line" } } });

function hook(t, events) {
  const body = JSON.stringify({ destination: "x", events: [].concat(events) });
  return t.app.fetch(new Request("https://rts.example.workers.dev/line/webhook", { method: "POST", body, headers: { "x-line-signature": sign(body) } }), t.env);
}
function req(t, path, { method = "GET", body, cookie, token } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  return t.app.fetch(new Request("https://rts.example.workers.dev" + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), t.env);
}
async function liffLogin(t) {
  const r = await req(t, "/auth/liff", { method: "POST", body: { idToken: "good-token-friend" } });
  assert.equal(r.status, 200);
  return r.headers.get("set-cookie").split(";")[0];
}
const q = (t, sql, ...a) => t.env.DB.raw.prepare(sql).get(...a);
const all = (t, sql, ...a) => t.env.DB.raw.prepare(sql).all(...a);

const ANSWERS = {
  name: "Somchai", age: 41, sex: "male", height: 172, weight: 84, goals: ["lose_weight", "fitness"], target: "lose 6 kg",
  heart: false, chest_pain: false, dizzy: false, bp_meds: false, joints: true, pregnant: false, conditions: ["knee"],
  exercise_days: "1-2", activities: ["walk"], fitness: 2, days: ["1", "3", "5", "6"], minutes: "45", when: "evening",
  places: ["gym", "home"], bedtime: "00:30", waketime: "07:30", drink_nights: "3-4", plays_golf: false, strictness: 3, lang: "en",
};

// ---- migration ------------------------------------------------------------------------------------

test("a version-1 (single-user) database is migrated to the owner, keeping every row", async () => {
  const raw = new DatabaseSync(":memory:");
  raw.exec(`CREATE TABLE daily (date TEXT PRIMARY KEY, woke INT, trained INT, mobility INT, screens INT, drinks INT, practice INT, water REAL, energy INT, note TEXT, week INT, updated TEXT);
    CREATE TABLE rounds (id TEXT PRIMARY KEY, date TEXT, course TEXT, tee TEXT, sleep REAL, drinks INT, front INT, back INT, fw INT, gir INT, putts INT, threePutts INT, penalties INT, doubles INT, apShort INT, apLong INT, money INT, mind INT, note TEXT, created TEXT);
    CREATE TABLE tests (id TEXT PRIMARY KEY, date TEXT, dSpeed REAL, dCarry REAL, dDir REAL, iSpeed REAL, iBall REAL, iCarry REAL, iSpread REAL, iDir REAL, wedge INT, p6 INT, lag INT, note TEXT, created TEXT);
    CREATE TABLE body (id TEXT PRIMARY KEY, date TEXT, weight REAL, waist REAL, uric REAL, flare INT, note TEXT, created TEXT);
    CREATE TABLE settings (key TEXT PRIMARY KEY, json TEXT);
    CREATE TABLE coach (date TEXT PRIMARY KEY, title TEXT, message TEXT, alerts TEXT, created TEXT);
    CREATE TABLE convo (user_id TEXT PRIMARY KEY, flow TEXT, step INT, draft TEXT, updated TEXT);
    INSERT INTO daily (date, woke, drinks, note) VALUES ('2026-10-13', 1, 3, 'Walking for 20 mins');
    INSERT INTO rounds (id, date, front, back) VALUES ('r1', '2026-10-11', 44, 46);
    INSERT INTO coach (date, title) VALUES ('2026-10-13', 'Local test');
    INSERT INTO settings VALUES ('yardages', '{"clubs":{"7i":{"full":150}}}'), ('chat_memory', '{"messages":[]}'), ('push_count', '{"month":"2026-10","count":5}'), ('origin', '"https://x"');`);
  const helpers = await import("./helpers.js"); // same D1 adapter the other tests use
  const wrap = helpers.wrapD1(raw);
  await ensureSchema(wrap, { OWNER_LINE_USER_ID: OWNER }, "2026-10-14T00:00:00Z");
  assert.deepEqual(raw.prepare("SELECT user_id, date, note FROM daily").all().map(r => ({ ...r })), [{ user_id: OWNER, date: "2026-10-13", note: "Walking for 20 mins" }]);
  assert.equal(raw.prepare("SELECT user_id FROM rounds").get().user_id, OWNER);
  assert.equal(raw.prepare("SELECT user_id FROM coach").get().user_id, OWNER);
  const keys = raw.prepare("SELECT key FROM settings ORDER BY key").all().map(r => r.key);
  assert.ok(keys.includes(`u:${OWNER}:yardages`) && keys.includes(`u:${OWNER}:chat_memory`));
  assert.ok(keys.includes("push_count") && keys.includes("origin") && keys.includes("schema_version"), "global settings stay global");
  assert.deepEqual({ ...raw.prepare("SELECT role, status FROM users WHERE id = ?").get(OWNER) }, { role: "admin", status: "active" });
  // two users can now have a check-in on the same day
  raw.prepare("INSERT INTO daily (user_id, date) VALUES ('Uother', '2026-10-13')").run();
  // running again (new isolate) changes nothing
  await ensureSchema(helpers.wrapD1(raw), { OWNER_LINE_USER_ID: OWNER });
  assert.equal(raw.prepare("SELECT COUNT(*) n FROM daily").get().n, 2);
});

test("schema.sql creates the same tables and columns as the Worker", async () => {
  const fromSql = new DatabaseSync(":memory:");
  fromSql.exec(fs.readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const fromCode = new DatabaseSync(":memory:");
  const { wrapD1 } = await import("./helpers.js");
  await ensureSchema(wrapD1(fromCode), {});
  const shape = d => Object.fromEntries(d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
    .map(t => [t.name, d.prepare(`PRAGMA table_info(${t.name})`).all().map(c => `${c.name}:${c.type}:${c.pk}`)]));
  assert.deepEqual(shape(fromSql), shape(fromCode));
});

// ---- sessions -------------------------------------------------------------------------------------

test("session tokens: valid, tampered, expired", async () => {
  const env = { API_TOKEN: TOKEN };
  const tok = await signSession(env, FRIEND, Date.parse(T0));
  assert.equal(await verifySession(env, tok, Date.parse(T0)), FRIEND);
  assert.equal(await verifySession(env, tok.replace(/.$/, c => (c === "A" ? "B" : "A")), Date.parse(T0)), null);
  assert.equal(await verifySession(env, tok, Date.parse(T0) + 31 * 86400e3), null, "expired after 30 days");
  assert.equal(await verifySession({ API_TOKEN: "another-token-0123456789" }, tok, Date.parse(T0)), null, "other key");
});

test("LIFF login: LINE-verified ID token -> session cookie; bad token -> 401", async () => {
  const t = setup();
  assert.equal((await req(t, "/auth/liff", { method: "POST", body: { idToken: "forged" } })).status, 401);
  const cookie = await liffLogin(t);
  assert.match(cookie, /^rts_session=/);
  const me = await (await req(t, "/api/v1/me", { cookie })).json();
  assert.equal(me.user.id, FRIEND);
  assert.equal(me.user.status, "new");
  assert.ok(me.questionnaire.sections.length >= 8);
});

// ---- the whole journey ------------------------------------------------------------------------------

test("journey: follow -> sign up -> approve -> questionnaire -> interview -> design -> accept -> activate -> daily plan", async () => {
  const design = programToDesign({ ...program, golf: false, title: "Somchai 12 weeks", summary: "3 gym days, walks, bed by 23:30." });
  design.summary = "3 gym days + 2 walks; bedtime moves to 23:30.";
  const t = setup({ script: [
    say("Welcome Somchai! Which movements hurt your knee: stairs, squats or running?"), // after questionnaire
    useTool("design_program", { brief: "Knee hurts on stairs only; prefers evening gym." }), say("Great - drafting your program now. It will arrive in a few minutes."),
    design && msg([{ type: "text", text: JSON.stringify(design) }]), // the design job (streaming)
  ] });

  // 1. add friend -> sign-up button with the LIFF link
  await hook(t, follow(FRIEND));
  assert.match(t.repliesText().at(-1), /liff\.line\.me\/2000000000-abcdefgh\/signup/);
  assert.equal(q(t, "SELECT display_name FROM users WHERE id = ?", FRIEND).display_name, "Somchai LINE");

  // 2. sign up in LIFF (consent) -> pending, admin notified
  const cookie = await liffLogin(t);
  assert.equal((await req(t, "/api/v1/me/signup", { method: "POST", cookie, body: { name: "Somchai", lang: "en", consent: false } })).status, 400);
  let r = await (await req(t, "/api/v1/me/signup", { method: "POST", cookie, body: { name: "Somchai", lang: "en", consent: true } })).json();
  assert.equal(r.user.status, "pending");
  assert.match(JSON.stringify(t.pushesTo(OWNER).at(-1).body), /New sign-up: Somchai/);
  assert.equal((await req(t, "/api/v1/daily", { cookie })).status, 403, "pending users can't use the tracker");
  await hook(t, text(FRIEND, "hi"));
  assert.match(t.repliesText().at(-1), /approve your account soon/);

  // 3. admin approves -> onboarding, questionnaire link pushed
  assert.equal((await req(t, `/api/v1/admin/users/${FRIEND}/approve`, { method: "POST", cookie })).status, 403, "users are not admins");
  r = await (await req(t, `/api/v1/admin/users/${FRIEND}/approve`, { method: "POST", token: TOKEN })).json();
  assert.equal(r.user.status, "onboarding");
  assert.match(JSON.stringify(t.pushesTo(FRIEND).at(-1).body), /liff\.line\.me\/2000000000-abcdefgh\/onboarding/);

  // 4. questionnaire -> profile + flags, interview starts in LINE
  const bad = await req(t, "/api/v1/me/questionnaire", { method: "POST", cookie, body: { answers: { ...ANSWERS, age: 7 } } });
  assert.equal(bad.status, 400);
  r = await (await req(t, "/api/v1/me/questionnaire", { method: "POST", cookie, body: { answers: ANSWERS } })).json();
  assert.deepEqual(r.flags, ["joints", "knee"]);
  assert.equal(q(t, "SELECT golfer FROM users WHERE id = ?", FRIEND).golfer, 0);
  assert.match(JSON.stringify(t.pushesTo(FRIEND).at(-1).body), /Which movements hurt your knee/);
  assert.match(t.claude[0].system[0].text, /getting to know Somchai/);

  // 5. reply in LINE -> Claude calls design_program -> job queued
  await hook(t, text(FRIEND, "Only stairs. I like the gym in the evening."));
  assert.match(t.repliesText().at(-1), /drafting your program/);
  assert.equal(q(t, "SELECT status FROM jobs WHERE user_id = ?", FRIEND).status, "pending");
  assert.match(q(t, "SELECT notes FROM profiles WHERE user_id = ?", FRIEND).notes || "", /^$/); // notes untouched (no tool call)

  // 6. minute cron runs the job -> proposed program pushed with Accept / Change buttons
  await t.app.scheduled({ cron: CRON.jobs }, t.env, null);
  assert.equal(q(t, "SELECT status FROM jobs WHERE user_id = ?", FRIEND).status, "done");
  const prog = q(t, "SELECT id, status, version FROM programs WHERE user_id = ?", FRIEND);
  assert.deepEqual([prog.status, prog.version], ["proposed", 1]);
  const offer = t.pushesTo(FRIEND).at(-1).body.messages[0];
  assert.match(offer.text, /3 gym days \+ 2 walks/);
  assert.deepEqual(offer.quickReply.items.map(i => i.action.data), [`prog:accept:${prog.id}`, `prog:change:${prog.id}`]);
  const designReq = t.claude.at(-1);
  assert.equal(designReq.stream, true);
  assert.equal(designReq.output_config.format.type, "json_schema");
  assert.match(designReq.messages[0].content, /"healthFlags":\["joints","knee"\]/);

  // 7. user taps Accept -> admin told
  await hook(t, postback(FRIEND, `prog:accept:${prog.id}`));
  assert.equal(q(t, "SELECT status FROM programs WHERE id = ?", prog.id).status, "accepted");
  assert.match(JSON.stringify(t.pushesTo(OWNER).at(-1).body), /Somchai accepted program v1/);

  // 8. admin activates -> starts next Monday, user active
  r = await (await req(t, `/api/v1/admin/users/${FRIEND}/activate`, { method: "POST", token: TOKEN, body: {} })).json();
  assert.equal(r.start, "2026-10-26");
  assert.equal(r.user.status, "active");
  assert.match(JSON.stringify(t.pushesTo(FRIEND).at(-1).body), /starts Mon 26 Oct/);

  // 9. on Monday 26 Oct the 08:45 job sends each active user their own plan
  t.clock.now = new Date("2026-10-26T01:45:00Z");
  await t.app.scheduled({ cron: CRON.morning }, t.env, null);
  const mine = JSON.stringify(t.pushesTo(OWNER).at(-1).body), theirs = JSON.stringify(t.pushesTo(FRIEND).at(-1).body);
  assert.match(mine, /Week 2 · Mon 26 Oct/);
  assert.match(theirs, /Week 1 · Mon 26 Oct/);

  // 10. golf is off for this user
  await hook(t, text(FRIEND, "score"));
  assert.match(t.repliesText().at(-1), /Golf features are switched off/);

  // 11. dashboard: their own program
  const dash = await (await req(t, "/", { cookie })).text();
  assert.match(dash, /window\.RTS = .*"golfer":false/);
  assert.match(dash, /Somchai 12 weeks/);
});

// ---- isolation ------------------------------------------------------------------------------------

async function activeFriend(t) {
  t.env.DB.raw.prepare("INSERT INTO users (id, name, status, role, golfer, lang, created, updated) VALUES (?, 'Somchai', 'active', 'user', 0, 'en', ?, ?)").run(FRIEND, T0, T0);
  t.env.DB.raw.prepare("INSERT INTO programs (id, user_id, version, status, json, created, updated) VALUES ('p1', ?, 1, 'active', ?, ?, ?)")
    .run(FRIEND, JSON.stringify({ ...program, golf: false, start: "2026-10-19" }), T0, T0);
}

test("each user sees only their own data; the admin sees everyone's", async () => {
  const t = setup();
  await req(t, "/health");
  await req(t, "/api/v1/daily/2026-10-20", { method: "PUT", token: TOKEN, body: { woke: 1, note: "owner" } });
  await activeFriend(t);
  const cookie = await liffLogin(t);
  await req(t, "/api/v1/daily/2026-10-20", { method: "PUT", cookie, body: { woke: 0, note: "friend" } });
  const theirs = (await (await req(t, "/api/v1/daily", { cookie })).json()).items;
  const mine = (await (await req(t, "/api/v1/daily", { token: TOKEN })).json()).items;
  assert.deepEqual(theirs.map(d => d.note), ["friend"]);
  assert.deepEqual(mine.map(d => d.note), ["owner"]);
  const asFriend = (await (await req(t, `/api/v1/daily?as=${FRIEND}`, { token: TOKEN })).json()).items;
  assert.deepEqual(asFriend.map(d => d.note), ["friend"], "admin can look at a user's data");
  assert.equal((await req(t, `/api/v1/daily?as=${OWNER}`, { cookie })).status, 200);
  assert.deepEqual((await (await req(t, `/api/v1/daily?as=${OWNER}`, { cookie })).json()).items.map(d => d.note), ["friend"], "?as is ignored for users");
  assert.equal((await req(t, "/api/v1/admin/users", { cookie })).status, 403);
  const users = (await (await req(t, "/api/v1/admin/users", { token: TOKEN })).json()).items;
  assert.deepEqual(users.map(u => u.id), [OWNER, FRIEND]);
});

// ---- photos and chat log ----------------------------------------------------------------------------

test("photos are stored in R2, shown to the coach and analysed; every message is logged", async () => {
  const t = setup({ script: [useTool("record_photo", { category: "meal", description: "Rice with fried chicken", data: { items: ["rice", "fried chicken"] } }), say("Nice plate - go lighter on the fried chicken.")] });
  await activeFriend(t);
  await hook(t, image(FRIEND));
  const m = q(t, "SELECT * FROM media WHERE user_id = ?", FRIEND);
  assert.match(m.r2_key, new RegExp(`^u/${FRIEND}/2026-10/.+\\.jpg$`));
  assert.ok(t.env.MEDIA.store.has(m.r2_key));
  assert.deepEqual([m.category, m.description, JSON.parse(m.analysis).items[1]], ["meal", "Rice with fried chicken", "fried chicken"]);
  const sent = t.claude[0].messages[0].content;
  assert.equal(sent[0].type, "image");
  assert.equal(sent[0].source.media_type, "image/jpeg");
  assert.ok(t.claude[0].tools.some(x => x.name === "record_photo"));
  assert.ok(!t.claude[0].tools.some(x => x.name === "log_round"), "no golf tools for non-golfers");
  const log = all(t, "SELECT dir, type, media_id, model, tokens_out FROM messages WHERE user_id = ? ORDER BY ts, dir", FRIEND);
  assert.equal(log[0].dir, "in");
  assert.equal(log[0].type, "image");
  assert.equal(log[0].media_id, m.id);
  const out = log.find(x => x.dir === "out");
  assert.equal(out.model, "claude-opus-5-5");
  assert.equal(out.tokens_out, 40);
  // the user can open their photo; another user can't
  const cookie = await liffLogin(t);
  assert.equal((await req(t, `/media/${m.id}`, { cookie })).status, 200);
  t.env.DB.raw.prepare("UPDATE media SET user_id = 'Usomeoneelse' WHERE id = ?").run(m.id);
  assert.equal((await req(t, `/media/${m.id}`, { cookie })).status, 404);
  assert.equal((await req(t, `/media/${m.id}`, { token: TOKEN })).status, 200, "admin can open any photo");
});

// ---- admin --------------------------------------------------------------------------------------

test("admin: export and delete a user (rows, settings and R2 files)", async () => {
  const t = setup({ script: [say("ok")] });
  await activeFriend(t);
  await hook(t, image(FRIEND));
  await hook(t, text(FRIEND, "hello coach"));
  const exp = await (await req(t, `/api/v1/admin/users/${FRIEND}/export`, { token: TOKEN })).json();
  assert.equal(exp.user.id, FRIEND);
  assert.ok(exp.messages.length >= 3 && exp.media.length === 1 && exp.programs.length === 1);
  assert.equal((await req(t, `/api/v1/admin/users/${FRIEND}`, { method: "DELETE", token: TOKEN })).status, 400, "needs confirm");
  const del = await (await req(t, `/api/v1/admin/users/${FRIEND}?confirm=${FRIEND}`, { method: "DELETE", token: TOKEN })).json();
  assert.equal(del.files, 1);
  for (const table of ["users", "messages", "media", "programs"]) {
    assert.equal(q(t, `SELECT COUNT(*) n FROM ${table} WHERE ${table === "users" ? "id" : "user_id"} = ?`, FRIEND).n, 0, table);
  }
  assert.equal(t.env.MEDIA.store.size, 0);
  assert.equal((await req(t, `/api/v1/admin/users/${OWNER}?confirm=${OWNER}`, { method: "DELETE", token: TOKEN })).status, 400, "admin can't delete themselves");
});

test("unfollow marks the user as left; following again restores them", async () => {
  const t = setup();
  await activeFriend(t);
  t.env.DB.raw.prepare("UPDATE users SET approved_at = ? WHERE id = ?").run(T0, FRIEND);
  await hook(t, ev(FRIEND, { type: "unfollow" }));
  assert.equal(q(t, "SELECT status FROM users WHERE id = ?", FRIEND).status, "left");
  t.clock.now = new Date("2026-10-26T01:45:00Z");
  await t.app.scheduled({ cron: CRON.morning }, t.env, null);
  assert.equal(t.pushesTo(FRIEND).length, 0, "no pushes to people who left");
  await hook(t, follow(FRIEND));
  assert.equal(q(t, "SELECT status FROM users WHERE id = ?", FRIEND).status, "active");
});

// ---- program format -----------------------------------------------------------------------------

test("the design format round-trips the real program and catches broken designs", () => {
  const d = programToDesign(program);
  assert.deepEqual(validateDesign(d), []);
  const back = designToProgram(d, program.start);
  assert.deepEqual(Object.keys(back.sessions), Object.keys(program.sessions));
  assert.deepEqual(back.template, program.template);
  const broken = JSON.parse(JSON.stringify(d));
  broken.weeks.pop(); broken.template[0].amKey = "nope"; broken.weeks[0].sleep = "late";
  const errs = validateDesign(broken).join(" | ");
  assert.match(errs, /exactly 12/);
  assert.match(errs, /"nope" is not a session key/);
  assert.match(errs, /sleep must look like/);
  assert.equal(nextMonday("2026-10-20"), "2026-10-26");
  assert.equal(nextMonday("2026-10-26"), "2026-10-26");
});

test("questionnaire cleaning and health flags", () => {
  const { answers, errors } = cleanAnswers({ ...ANSWERS, weight: "84", heart: "yes", plays_golf: false, handicap: "12", goals: ["x", "fitness"] });
  assert.deepEqual(errors, []);
  assert.equal(answers.weight, 84);
  assert.equal(answers.heart, true);
  assert.equal(answers.handicap, undefined, "golf questions are dropped for non-golfers");
  assert.deepEqual(answers.goals, ["fitness"]);
  assert.deepEqual(healthFlags(answers), ["heart", "joints", "knee"]);
  assert.match(cleanAnswers({}).errors.join(","), /name is required/);
});
