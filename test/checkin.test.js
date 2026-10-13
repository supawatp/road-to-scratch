import { test } from "node:test";
import assert from "node:assert/strict";
import {
  QUESTIONS, parsePostback, newState, nextQuestion, applyAnswer, awaitingNote, questionMessage, toDailyRow, hits, summaryText,
} from "../src/checkin.js";

const FULL = [["woke", 1], ["trained", 2], ["mobility", 1], ["screens", 0], ["drinks", 0], ["practice", 60], ["water", 2.5], ["energy", 4], ["note", "felt good"]];

test("nine questions in the spec order", () => {
  assert.deepEqual(QUESTIONS.map(q => q.field), ["woke", "trained", "mobility", "screens", "drinks", "practice", "water", "energy", "note"]);
});

test("postback data ci:<field>:<value> is parsed and validated", () => {
  assert.deepEqual(parsePostback("ci:woke:1"), { field: "woke", value: 1 });
  assert.deepEqual(parsePostback("ci:trained:2"), { field: "trained", value: 2 });
  assert.deepEqual(parsePostback("ci:drinks:4"), { field: "drinks", value: 4 });
  assert.deepEqual(parsePostback("ci:water:2.5"), { field: "water", value: 2.5 });
  assert.deepEqual(parsePostback("ci:note:skip"), { field: "note", value: "" });
  for (const bad of ["ci:woke:2", "ci:drinks:9", "ci:energy:0", "ci:sql:1", "ci:woke", "xx:woke:1", "", null]) {
    assert.equal(parsePostback(bad), null, String(bad));
  }
});

test("every quick-reply button round-trips through parsePostback", () => {
  for (const q of QUESTIONS) {
    const msg = questionMessage(q);
    assert.ok(msg.quickReply.items.length <= 13);
    for (const item of msg.quickReply.items) {
      assert.ok(item.action.label.length <= 20, item.action.label);
      const p = parsePostback(item.action.data);
      assert.ok(p, item.action.data);
      assert.equal(p.field, q.field);
    }
  }
});

test("walks through all questions in order and finishes on the note", () => {
  let s = newState("2026-10-23");
  assert.equal(nextQuestion(s).field, "woke");
  for (let i = 0; i < FULL.length; i++) {
    const [field, value] = FULL[i];
    const r = applyAnswer(s, field, value);
    s = r.state;
    if (i < FULL.length - 1) {
      assert.equal(r.done, false);
      assert.equal(r.next.field, FULL[i + 1][0]);
      assert.equal(s.step, i + 1);
    } else {
      assert.equal(r.done, true);
      assert.equal(r.next, null);
    }
  }
  assert.equal(s.draft.date, "2026-10-23");
  assert.equal(s.draft.note, "felt good");
});

test("awaitingNote is true only at the last step", () => {
  let s = newState("2026-10-23");
  assert.equal(awaitingNote(s), false);
  for (const [f, v] of FULL.slice(0, 8)) s = applyAnswer(s, f, v).state;
  assert.equal(awaitingNote(s), true);
  assert.equal(awaitingNote(null), false);
});

test("out-of-order and repeated taps: answer is kept, flow continues at the first gap", () => {
  let s = newState("2026-10-23");
  s = applyAnswer(s, "drinks", 2).state;            // old button from further down
  assert.equal(nextQuestion(s).field, "woke");
  s = applyAnswer(s, "woke", 1).state;
  s = applyAnswer(s, "woke", 0).state;              // double tap changes the answer
  assert.equal(s.draft.woke, 0);
  assert.equal(nextQuestion(s).field, "trained");
});

test("state is not mutated in place", () => {
  const s = newState("2026-10-23");
  applyAnswer(s, "woke", 1);
  assert.deepEqual(s.draft, { date: "2026-10-23" });
});

test("skip note stores an empty note; long notes are capped", () => {
  let s = newState("2026-10-23");
  for (const [f, v] of FULL.slice(0, 8)) s = applyAnswer(s, f, v).state;
  assert.equal(applyAnswer(s, "note", "").state.draft.note, "");
  assert.equal(applyAnswer(s, "note", "x".repeat(5000)).state.draft.note.length, 1000);
});

test("daily row, habit count and summary text", () => {
  let s = newState("2026-10-23");
  for (const [f, v] of FULL) s = applyAnswer(s, f, v).state;
  const row = toDailyRow(s.draft, 1, "2026-10-23T14:35:00.000Z");
  assert.deepEqual(row, {
    date: "2026-10-23", woke: 1, trained: 2, mobility: 1, screens: 0, drinks: 0, practice: 60, water: 2.5, energy: 4,
    note: "felt good", week: 1, updated: "2026-10-23T14:35:00.000Z",
  });
  assert.equal(hits(row), 4); // the 20-minute version counts as trained
  const text = summaryText(row, { bed: "00:15", wake: "08:45", screensOff: "23:45" });
  assert.equal(text.split("\n")[0], "4/5 habits - screens off by 23:45");
  assert.match(text, /20-min session · practice 60 min · water 2.5 L · energy 4\/5/);
});

test("summary cue for a perfect day", () => {
  const row = { date: "2026-10-23", woke: 1, trained: 1, mobility: 1, screens: 1, drinks: 0, practice: 0 };
  assert.match(summaryText(row, { bed: "00:15", wake: "08:45", screensOff: "23:45" }), /^5\/5 habits - lights out by 00:15/);
});
