import { test } from "node:test";
import assert from "node:assert/strict";
import {
  zonedParts, localDate, weekOf, weekday, mondayOf, addDays, checkinDate, minusMinutes, sleepTargets, drinkLimit, fmtDay, isYmd,
} from "../src/dates.js";
import { program } from "./helpers.js";

const START = program.start; // 2026-10-19 (Monday)

test("program week 1 starts Monday 2026-10-19", () => {
  assert.equal(START, "2026-10-19");
  assert.equal(weekday(START), 1);
});

test("Bangkok date is UTC+7, not the Worker's UTC date", () => {
  assert.equal(localDate(new Date("2026-10-18T16:59:59Z")), "2026-10-18"); // 23:59:59 BKK Sunday
  assert.equal(localDate(new Date("2026-10-18T17:00:00Z")), "2026-10-19"); // 00:00 BKK Monday
  assert.deepEqual(zonedParts(new Date("2026-10-23T01:45:00Z")), { date: "2026-10-23", hour: 8, minute: 45 });
});

test("cron times map to the right Bangkok times", () => {
  assert.equal(zonedParts(new Date("2026-10-23T01:45:00Z")).hour, 8);   // 45 1 * * *  -> 08:45
  assert.equal(zonedParts(new Date("2026-10-23T14:30:00Z")).hour, 21);  // 30 14 * * * -> 21:30
  const sun = new Date("2026-10-25T13:00:00Z");                          // 0 13 * * SUN -> Sun 20:00
  assert.equal(zonedParts(sun).hour, 20);
  assert.equal(weekday(localDate(sun)), 0);
});

test("weekOf: 0 before the start, 1 for the first 7 days, then +1 every Monday", () => {
  assert.equal(weekOf("2026-10-13", START), 0);
  assert.equal(weekOf("2026-10-18", START), 0);
  assert.equal(weekOf("2026-10-19", START), 1);
  assert.equal(weekOf("2026-10-25", START), 1);
  assert.equal(weekOf("2026-10-26", START), 2);
  assert.equal(weekOf("2027-01-10", START), 12); // program ends Sunday 10 Jan 2027
  assert.equal(weekOf("2027-01-11", START), 13);
});

test("weekOf at the Bangkok midnight boundary", () => {
  assert.equal(weekOf(localDate(new Date("2026-10-18T16:30:00Z")), START), 0); // 23:30 Sun BKK
  assert.equal(weekOf(localDate(new Date("2026-10-18T17:30:00Z")), START), 1); // 00:30 Mon BKK
});

test("weekday / mondayOf / addDays across month and year ends", () => {
  assert.equal(weekday("2026-10-23"), 5);
  assert.equal(mondayOf("2026-10-25"), "2026-10-19");
  assert.equal(mondayOf("2026-10-19"), "2026-10-19");
  assert.equal(addDays("2026-10-31", 1), "2026-11-01");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2027-03-01", -1), "2027-02-28");
});

test("check-ins after midnight (before 05:00 Bangkok) belong to the previous day", () => {
  assert.equal(checkinDate(new Date("2026-10-23T14:30:00Z")), "2026-10-23"); // 21:30
  assert.equal(checkinDate(new Date("2026-10-23T17:30:00Z")), "2026-10-23"); // 00:30 next day
  assert.equal(checkinDate(new Date("2026-10-23T21:59:00Z")), "2026-10-23"); // 04:59
  assert.equal(checkinDate(new Date("2026-10-23T22:00:00Z")), "2026-10-24"); // 05:00
});

test("screens-off time is bedtime minus 30 minutes, wrapping midnight", () => {
  assert.equal(minusMinutes("00:15", 30), "23:45");
  assert.equal(minusMinutes("23:30", 30), "23:00");
  assert.equal(minusMinutes("00:00", 30), "23:30");
});

test("sleep targets and drink limits come from program.weeks[n-1]", () => {
  assert.deepEqual(sleepTargets(program, 1), { bed: "00:15", wake: "08:45" });
  assert.deepEqual(sleepTargets(program, 2), { bed: "00:00", wake: "08:30" });
  assert.deepEqual(sleepTargets(program, 0), { bed: "00:30", wake: "09:00" });
  assert.deepEqual(sleepTargets(program, 13), { bed: "23:30", wake: "07:30" });
  assert.equal(drinkLimit(program, 1), 3);
  assert.equal(drinkLimit(program, 0), 3);
  assert.equal(drinkLimit(program, 13), 2);
});

test("formatting and validation", () => {
  assert.equal(fmtDay("2026-10-23"), "Fri 23 Oct");
  assert.equal(isYmd("2026-10-23"), true);
  for (const bad of ["2026-02-30", "2026-1-01", "20261023", "", null, "2026-10-23'; DROP"]) assert.equal(isYmd(bad), false, String(bad));
});
