import { test } from "node:test";
import assert from "node:assert/strict";
import { dayPlan, morningAlerts, morningFlex, fullPlanText, weekPlanText, applyOverrides, splitItem } from "../src/program.js";
import { program } from "./helpers.js";

test("Friday of week 1: Strength C + Pilates reformer A with 3 video links", () => {
  const p = dayPlan(program, "2026-10-23");
  assert.equal(p.week, 1);
  assert.equal(p.title, "Week 1 · Fri 23 Oct");
  assert.match(p.am.label, /^Strength C/);
  assert.match(p.pm.label, /^Pilates reformer A/);
  assert.equal(p.videos.length, 3);
  for (const v of p.videos) assert.match(v.url, /^https:\/\/www\.youtube\.com\/results\?search_query=/);
  assert.equal(p.sleep.bed, "00:15");
  assert.equal(p.screensOff, "23:45");
});

test("morning flex message has both sessions, video buttons and the two footer buttons", () => {
  const p = dayPlan(program, "2026-10-23");
  const msg = morningFlex(p, { alerts: [], dashboardUrl: "https://rts.example.workers.dev/" });
  const flat = JSON.stringify(msg);
  assert.equal(msg.type, "flex");
  assert.match(flat, /Strength C/);
  assert.match(flat, /Pilates reformer A/);
  assert.equal((flat.match(/youtube\.com\/results/g) || []).length, 3);
  const footer = msg.contents.footer.contents.map(b => b.action.label);
  assert.deepEqual(footer, ["Open dashboard", "Today's full plan"]);
  for (const b of msg.contents.body.contents.filter(c => c.type === "button")) assert.ok(b.action.label.length <= 40);
  assert.ok(msg.altText.length <= 400);
});

test("no dashboard button until the URL is known", () => {
  const msg = morningFlex(dayPlan(program, "2026-10-23"));
  assert.deepEqual(msg.contents.footer.contents.map(b => b.action.label), ["Today's full plan"]);
});

test("`today` lists every item with its video link", () => {
  const parts = fullPlanText(dayPlan(program, "2026-10-23"));
  const all = parts.join("\n");
  const expected = [...program.sessions.strC.items, ...program.sessions.pilA.items].filter(i => i.includes("||")).length;
  assert.equal((all.match(/youtube\.com\/results/g) || []).length, expected);
});

test("weekend uses the round template; setup week before the start", () => {
  assert.equal(dayPlan(program, "2026-10-24").am.key, "round");
  const setup = dayPlan(program, "2026-10-15");
  assert.equal(setup.week, 0);
  assert.ok(setup.setupItems.length > 0);
  assert.match(weekPlanText(program, "2026-10-15"), /Week 1 starts Mon 19 Oct/);
});

test("`plan` shows the week focus and all 7 days", () => {
  const t = weekPlanText(program, "2026-10-21");
  assert.match(t, /^Week 1: Baseline week · Foundation/);
  for (const d of ["Mon 19", "Tue 20", "Wed 21", "Thu 22", "Fri 23", "Sat 24", "Sun 25"]) assert.ok(t.includes(d), d);
});

test("alerts: drinking-night limit and never miss twice", () => {
  const fri = dayPlan(program, "2026-10-23");
  const rows = [{ drinks: 1 }, { drinks: 2 }, { drinks: 0 }, { drinks: 1 }];
  const a = morningAlerts(fri, { yesterdayRow: { trained: 0 }, weekRows: rows });
  assert.equal(a.length, 2);
  assert.match(a[0], /3 of 3 used/);
  assert.match(a[1], /Never miss twice/);
  assert.deepEqual(morningAlerts(fri, { yesterdayRow: { trained: 1 }, weekRows: [] }), []);
  // Monday: yesterday was Sunday, not a training day
  assert.deepEqual(morningAlerts(dayPlan(program, "2026-10-26"), { yesterdayRow: { trained: 0 } }), []);
});

test("weekly overrides change targets and swap a session; junk is ignored", () => {
  const p = applyOverrides(program, { weeks: { 2: {
    focusCue: "Wedges inside 5 yd", sleep: "23:45 / 08:15", drinks: 2, extraTasks: ["Book a lesson"],
    template: { 5: { pmKey: "mob" }, 9: { amKey: "x" } },
  }, 99: { drinks: 1 } } });
  const fri = dayPlan(p, "2026-10-30");
  assert.equal(fri.focus, "Wedges inside 5 yd");
  assert.equal(fri.sleep.bed, "23:45");
  assert.equal(fri.drinkLimit, 2);
  assert.equal(fri.pm.key, "mob");
  assert.equal(fri.am.key, "strC");
  assert.ok(p.weeks[1].tasks.includes("Book a lesson"));
  assert.equal(program.weeks[1].drinks, 3, "original program untouched");
  assert.equal(applyOverrides(program, { weeks: { 2: { sleep: "late", drinks: 40 } } }).weeks[1].sleep, program.weeks[1].sleep);
});

test("splitItem", () => {
  assert.deepEqual(splitItem("Kettlebell swing - 4 x 10||kettlebell swing proper form"), {
    text: "Kettlebell swing - 4 x 10", query: "kettlebell swing proper form",
    url: "https://www.youtube.com/results?search_query=kettlebell%20swing%20proper%20form",
  });
  assert.equal(splitItem("Warm-up").url, null);
});
