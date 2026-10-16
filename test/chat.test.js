// LINE coach (Claude) - runs against a fake Anthropic API that replays scripted responses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp, makeEnv, webhookRequest, textEvent, postbackEvent, OWNER } from "./helpers.js";
import { trimMemory, MEMORY_SIZE, TOOLS } from "../src/chat.js";

const FRI = "2026-10-23T04:00:00Z"; // Friday 11:00 Bangkok, week 1

const msg = (content, stop_reason = "end_turn") => ({
  id: "msg_" + Math.random().toString(36).slice(2), type: "message", role: "assistant", model: "claude-opus-5-5",
  content, stop_reason, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 },
});
const say = t => msg([{ type: "thinking", thinking: "", signature: "sig-" + t.length }, { type: "text", text: t }]);
const useTool = (name, input, id = "tu_" + name) => msg([{ type: "thinking", thinking: "", signature: "sig-tool" }, { type: "tool_use", id, name, input }], "tool_use");

/** App whose fetch serves LINE (recorded) and Anthropic (scripted responses, requests recorded). */
function setup(script = [], envOver = {}, { replyFails = false } = {}) {
  const calls = [], claude = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith("https://api.anthropic.com/")) {
      const body = JSON.parse(init.body);
      claude.push({ url: u, body, headers: init.headers });
      const next = script.shift();
      if (!next) throw new Error("no scripted Claude response left");
      if (next.status) return new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }), { status: next.status, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify(next), { headers: { "content-type": "application/json" } });
    }
    calls.push({ url: u, body: init.body ? JSON.parse(init.body) : null });
    if (replyFails && u.endsWith("/reply")) return new Response('{"message":"Invalid reply token"}', { status: 400 });
    return new Response("{}");
  };
  const line = { calls, fetchImpl, replies: () => calls.filter(c => c.url.endsWith("/reply")), pushes: () => calls.filter(c => c.url.endsWith("/push")) };
  const { app, clock } = makeApp(FRI, line);
  const env = makeEnv({ ANTHROPIC_API_KEY: "test-key", ...envOver });
  const send = ev => app.fetch(webhookRequest([ev]), env);
  const lastReply = () => line.replies().at(-1).body.messages.map(m => m.text).join("\n");
  return { app, env, line, claude, send, lastReply, clock, script };
}

test("free text goes to Claude with the program (cached) and today's data; the answer is replied", async () => {
  const t = setup([say("Yes, do the 20-minute version of Strength C and get to bed by 00:15.")]);
  await t.send(textEvent("Slept 5 hours, should I still train?"));
  assert.equal(t.claude.length, 1);
  const req = t.claude[0].body;
  assert.equal(req.model, "claude-opus-5-5");
  assert.equal(req.fallbacks, "default");
  assert.equal(req.output_config.effort, "low");
  assert.equal(req.thinking, undefined, "Opus 5.5 runs adaptive thinking by default");
  assert.deepEqual(req.system[0].cache_control, { type: "ephemeral" }, "stable prompt + program is cached");
  assert.match(req.system[0].text, /Strength C - power \+ golf-specific/);
  assert.match(req.system[1].text, /Today: AM Strength C/);
  assert.deepEqual(req.messages, [{ role: "user", content: "Slept 5 hours, should I still train?" }]);
  assert.deepEqual(req.tools.map(x => x.name), TOOLS.map(x => x.name));
  assert.match(String(t.claude[0].headers["anthropic-beta"] ?? new Headers(t.claude[0].headers).get("anthropic-beta")), /server-side-fallback-2026-07-01/);
  assert.equal(t.lastReply(), "Yes, do the 20-minute version of Strength C and get to bed by 00:15.");
  assert.ok(t.line.calls.some(c => c.url.endsWith("/chat/loading/start") && c.body.chatId === OWNER), "typing animation shown");
});

test("tool loop: Claude logs a body entry; thinking blocks go back verbatim; the result is reported", async () => {
  const t = setup([useTool("log_body", { weight: 79.5 }), say("Saved: weight 79.5 kg for 23 Oct.")]);
  await t.send(textEvent("log my weight 79.5"));
  const b = t.env.DB.raw.prepare("SELECT * FROM body").get();
  assert.deepEqual([b.date, b.weight], ["2026-10-23", 79.5]);
  const second = t.claude[1].body.messages;
  assert.equal(second.length, 3);
  assert.equal(second[1].role, "assistant");
  assert.deepEqual(second[1].content[0], { type: "thinking", thinking: "", signature: "sig-tool" }, "thinking block unchanged");
  assert.equal(second[2].content[0].type, "tool_result");
  assert.equal(second[2].content[0].tool_use_id, "tu_log_body");
  assert.match(second[2].content[0].content, /"weight":79.5/);
  assert.equal(t.lastReply(), "Saved: weight 79.5 kg for 23 Oct.");
});

test("bad tool input comes back to Claude as an error instead of saving junk", async () => {
  const t = setup([useTool("log_body", { weight: 900 }), say("That weight looks wrong. Can you check it?")]);
  await t.send(textEvent("log my weight 900"));
  assert.equal(t.env.DB.raw.prepare("SELECT COUNT(*) n FROM body").get().n, 0);
  const tr = t.claude[1].body.messages[2].content[0];
  assert.equal(tr.is_error, true);
  assert.match(tr.content, /out of range/);
});

test("check-in tool merges into the existing row; round tool needs front and back", async () => {
  const t = setup([
    useTool("log_checkin", { drinks: 0, energy: 4 }), say("Updated today's check-in."),
    useTool("log_round", { front: 44, back: 46, money: -2000, course: "Alpine" }), say("Round saved: 90."),
  ]);
  t.env.DB.raw.prepare("INSERT INTO daily (user_id, date, woke, trained, drinks) VALUES ('U0123456789abcdef0123456789abcdef', '2026-10-23', 1, 1, 2)").run();
  await t.send(textEvent("no drinks today actually, energy 4"));
  const d = t.env.DB.raw.prepare("SELECT * FROM daily WHERE date = '2026-10-23'").get();
  assert.deepEqual([d.woke, d.trained, d.drinks, d.energy, d.week], [1, 1, 0, 4, 1]);
  await t.send(textEvent("played Alpine 44 46, lost 2000"));
  const r = t.env.DB.raw.prepare("SELECT * FROM rounds").get();
  assert.deepEqual([r.front, r.back, r.money, r.course, r.date], [44, 46, -2000, "Alpine", "2026-10-23"]);
});

test("change_day_plan moves a session for one date; `today` shows it", async () => {
  const t = setup([useTool("change_day_plan", { date: "2026-10-23", am: "rest", pm: "strC" }), say("Moved Strength C to this evening.")]);
  await t.send(textEvent("move today's gym to the evening"));
  await t.send(textEvent("today"));
  const txt = t.lastReply();
  assert.match(txt, /After waking: Rest/);
  assert.match(txt, /Evening: Strength C/);
  const ov = JSON.parse(t.env.DB.raw.prepare("SELECT json FROM settings WHERE key = 'u:U0123456789abcdef0123456789abcdef:program_overrides'").get().json);
  assert.deepEqual(ov.days["2026-10-23"], { amKey: "rest", pmKey: "strC" });
});

test("memory: the last 6 text messages are sent back, starting with a user message", async () => {
  const replies = Array.from({ length: 5 }, (_, i) => say(`answer ${i + 1}`));
  const t = setup(replies);
  for (let i = 1; i <= 5; i++) await t.send(textEvent(`question ${i}`));
  const last = t.claude.at(-1).body.messages;
  assert.deepEqual(last.map(m => `${m.role}:${m.content}`), [
    "user:question 2", "assistant:answer 2", "user:question 3", "assistant:answer 3", "user:question 4", "assistant:answer 4", "user:question 5",
  ]);
  const mem = JSON.parse(t.env.DB.raw.prepare("SELECT json FROM settings WHERE key = 'u:U0123456789abcdef0123456789abcdef:chat_memory'").get().json).messages;
  assert.equal(mem.length, MEMORY_SIZE);
  assert.deepEqual(trimMemory([{ role: "assistant", text: "a" }, { role: "user", text: "b" }]), [{ role: "user", text: "b" }]);
});

test("forget clears the memory", async () => {
  const t = setup([say("one"), say("two")]);
  await t.send(textEvent("first question"));
  await t.send(textEvent("forget"));
  assert.match(t.lastReply(), /forgotten/);
  await t.send(textEvent("second question"));
  assert.deepEqual(t.claude.at(-1).body.messages, [{ role: "user", content: "second question" }]);
});

test("commands, check-in and score entry are not sent to Claude", async () => {
  const t = setup([]);
  await t.send(textEvent("plan"));
  await t.send(textEvent("checkin"));
  await t.send(textEvent("I did go to the gym"));
  assert.match(t.lastReply(), /Tap a button to answer \(or type cancel\)/);
  await t.send(postbackEvent("ci:woke:1"));
  await t.send(textEvent("score"));
  await t.send(textEvent("what is this?"));
  assert.match(t.lastReply(), /Tap Today or Yesterday/);
  assert.equal(t.claude.length, 0);
});

test("daily question cap, refusals and API errors give a short reply", async () => {
  const t = setup([say("ok"), msg([], "refusal"), { status: 429 }, { status: 429 }], { CHAT_DAILY_LIMIT: "3" });
  await t.send(textEvent("q1"));
  await t.send(textEvent("q2"));
  assert.match(t.lastReply(), /can't help with that one/);
  await t.send(textEvent("q3"));
  assert.match(t.lastReply(), /busy right now/);
  await t.send(textEvent("q4"));
  assert.match(t.lastReply(), /Daily limit of 3/);
  assert.equal(t.claude.length, 4, "q3: one try + one retry; q4 never calls Claude");
});

test("without ANTHROPIC_API_KEY free text still gets the help text", async () => {
  const t = setup([], { ANTHROPIC_API_KEY: "" });
  await t.send(textEvent("how am I doing?"));
  assert.match(t.lastReply(), /Sorry, I didn't get that/);
  assert.equal(t.claude.length, 0);
});

test("when the reply token has expired, the answer is pushed instead", async () => {
  const t = setup([say("Late answer")], {}, { replyFails: true });
  await t.send(textEvent("long question"));
  const push = t.line.pushes().at(-1);
  assert.equal(push.body.to, OWNER);
  assert.equal(push.body.messages[0].text, "Late answer");
});
