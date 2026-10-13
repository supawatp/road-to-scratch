import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SCORE_QUESTIONS, newScoreState, nextScoreQuestion, applyScoreAnswer, parseScorePostback, scoreQuestionMessage, toRoundDoc, roundSummary,
} from "../src/score.js";
import { makeApp, makeEnv, webhookRequest, textEvent, postbackEvent } from "./helpers.js";
import { CRON } from "../src/jobs.js";

test("questions: day, course, front, back, stats, money, mind, then the comment last", () => {
  assert.deepEqual(SCORE_QUESTIONS.map(q => q.field),
    ["date", "course", "front", "back", "putts", "fw", "gir", "penalties", "doubles", "apShort", "apLong", "money", "mind", "note"]);
});

test("every button is a valid postback and fits LINE's limits", () => {
  for (const q of SCORE_QUESTIONS) {
    const items = scoreQuestionMessage(q).quickReply?.items || [];
    assert.ok(items.length <= 13);
    for (const it of items) {
      assert.ok(it.action.label.length <= 20);
      assert.ok(parseScorePostback(it.action.data), it.action.data);
    }
  }
  assert.equal(parseScorePostback("sc:front:skip"), null, "front has no buttons");
  assert.equal(parseScorePostback("sc:penalties:99"), null);
  assert.equal(parseScorePostback("ci:woke:1"), null);
});

test("typed numbers, skips, yesterday and the comment build the round", () => {
  let s = newScoreState("2026-10-25");
  const answers = [["date", "yesterday"], ["course", "Royal Gems"], ["front", "42"], ["back", "45"], ["putts", "33"], ["fw", "skip"],
    ["gir", "6"], ["penalties", "1"], ["doubles", "2"], ["apShort", "4"], ["apLong", "0"], ["money", "-5,000"], ["mind", "4"], ["note", "Lost focus on 15"]];
  for (const [f, v] of answers) {
    assert.equal(nextScoreQuestion(s).field, f);
    const r = applyScoreAnswer(s, f, v);
    assert.equal(r.error, undefined, f);
    s = r.state;
  }
  const doc = toRoundDoc(s.draft, "2026-10-25T12:00:00.000Z");
  assert.deepEqual(doc, {
    created: "2026-10-25T12:00:00.000Z", date: "2026-10-24", course: "Royal Gems", front: 42, back: 45, putts: 33, gir: 6,
    penalties: 1, doubles: 2, apShort: 4, apLong: 0, money: -5000, mind: 4, note: "Lost focus on 15",
  });
  assert.equal(roundSummary(doc), "Round saved for Sat 24 Oct at Royal Gems: 87 (42/45) · 33 putts · 6/18 GIR · 1 pen · 2 dbl+ · money -5,000");
});

test("bad answers are rejected and the same question is asked again", () => {
  const s = applyScoreAnswer(applyScoreAnswer(newScoreState("2026-10-25"), "date", "today").state, "course", "skip").state;
  for (const bad of ["forty", "4.5", "12", "120", "skip"]) {
    const r = applyScoreAnswer(s, "front", bad);
    assert.ok(r.error, bad);
    assert.equal(r.next.field, "front");
    assert.equal(r.state, s);
  }
  assert.ok(applyScoreAnswer(s, "date", "tomorrow").error);
  assert.match(applyScoreAnswer(s, "mind", "7").error, /between 1 and 5/);
});

const FRI = "2026-10-23T11:00:00Z"; // 18:00 Bangkok
const last = line => line.replies().at(-1).body.messages[0];

test("LINE: score asks one by one and saves the round with the comment", async () => {
  const { app, line } = makeApp(FRI);
  const env = makeEnv();
  const send = ev => app.fetch(webhookRequest([ev]), env);
  await send(textEvent("score"));
  assert.match(last(line).text, /Round 1\/14 · Which day/);
  await send(postbackEvent("sc:date:today"));
  await send(textEvent("Plan B Golf Club"));       // looks like a command, but it's the course name
  await send(textEvent("44"));
  await send(textEvent("hello"));                  // not a number
  assert.match(last(line).text, /whole number[\s\S]*Round 4\/14 · Back 9/);
  await send(textEvent("46"));
  for (const d of ["sc:putts:skip", "sc:fw:skip", "sc:gir:skip", "sc:penalties:0", "sc:doubles:1", "sc:apShort:2", "sc:apLong:0", "sc:money:0", "sc:mind:3"]) {
    await send(postbackEvent(d));
  }
  assert.match(last(line).text, /Round 14\/14 · Comment/);
  await send(textEvent("Windy, good wedges"));
  const r = env.DB.raw.prepare("SELECT * FROM rounds").get();
  assert.deepEqual([r.date, r.course, r.front, r.back, r.putts, r.doubles, r.money, r.mind, r.note],
    ["2026-10-23", "Plan B Golf Club", 44, 46, null, 1, 0, 3, "Windy, good wedges"]);
  assert.match(last(line).text, /^Round saved for Fri 23 Oct at Plan B Golf Club: 90 \(44\/46\)/);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) n FROM convo").get().n, 0);
});

test("LINE: cancel stops without saving; stale score buttons don't save", async () => {
  const { app, line } = makeApp(FRI);
  const env = makeEnv();
  const send = ev => app.fetch(webhookRequest([ev]), env);
  await send(textEvent("score"));
  await send(postbackEvent("sc:date:today"));
  await send(textEvent("cancel"));
  assert.match(last(line).text, /Round entry cancelled/);
  await send(postbackEvent("sc:penalties:1"));
  assert.match(last(line).text, /has finished/);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) n FROM rounds").get().n, 0);
});

test("the 21:30 check-in push does not wipe a round entry in progress", async () => {
  const { app, line, clock } = makeApp("2026-10-23T14:20:00Z");
  const env = makeEnv();
  const send = ev => app.fetch(webhookRequest([ev]), env);
  await send(textEvent("score"));
  await send(postbackEvent("sc:date:today"));
  clock.now = new Date("2026-10-23T14:30:00Z");
  await app.scheduled({ cron: CRON.evening }, env, null);
  assert.equal(line.pushes().length, 1);
  await send(textEvent("Alpine"));
  assert.match(last(line).text, /Round 3\/14 · Front 9/);
});
