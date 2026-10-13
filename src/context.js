// Shared helpers that need the database: program loading, stats, summary, guarded pushes.
import { applyOverrides, dayPlan } from "./program.js";
import { DEFAULT_TZ, localDate, addDays, mondayOf, monthKey } from "./dates.js";
import { getSetting, setSetting, listDocs } from "./db.js";
import { LineClient } from "./line.js";
import { hits } from "./checkin.js";

export function makeContext(env, { program, fetchImpl, now } = {}) {
  const tz = env.TZ || DEFAULT_TZ;
  return {
    env, tz, db: env.DB,
    line: new LineClient(env.LINE_CHANNEL_ACCESS_TOKEN, fetchImpl),
    bundledProgram: program,
    now: now || (() => new Date()),
    today() { return localDate(this.now(), tz); },
    _program: null,
    async program() {
      if (!this._program) {
        const [stored, overrides] = await Promise.all([getSetting(this.db, "program"), getSetting(this.db, "program_overrides")]);
        const base = stored && Array.isArray(stored.weeks) && stored.template && stored.sessions ? stored : this.bundledProgram;
        this._program = applyOverrides(base, overrides);
      }
      return this._program;
    },
  };
}

export async function dashboardUrl(ctx) {
  const base = (ctx.env.PUBLIC_URL || (await getSetting(ctx.db, "origin")) || "").replace(/\/+$/, "");
  return /^https:\/\//.test(base) ? base + "/" : "";
}

/**
 * Push to the owner unless this month's push count has reached PUSH_MONTHLY_LIMIT.
 * Returns true if sent. Replies are free and are not counted.
 */
export async function guardedPush(ctx, messages) {
  const to = ctx.env.OWNER_LINE_USER_ID;
  if (!to) return false;
  const limit = Number(ctx.env.PUSH_MONTHLY_LIMIT || 250);
  const month = monthKey(ctx.today());
  const counter = (await getSetting(ctx.db, "push_count")) || {};
  const count = counter.month === month ? counter.count || 0 : 0;
  if (count >= limit) {
    console.warn(`push skipped: ${count} pushes already sent in ${month} (limit ${limit})`);
    return false;
  }
  await ctx.line.push(to, messages);
  await setSetting(ctx.db, "push_count", { month, count: count + 1 });
  return true;
}

/** Habit/practice/round stats for an inclusive date range. */
export function rangeStats(dailyRows, rounds, from, to) {
  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  const byDate = new Map(dailyRows.map(r => [r.date, r]));
  const logs = days.map(d => byDate.get(d)).filter(Boolean);
  const weekdayLogs = days.filter(d => { const wd = new Date(d + "T00:00:00Z").getUTCDay(); return wd >= 1 && wd <= 5; })
    .map(d => byDate.get(d)).filter(Boolean);
  const rs = rounds.filter(r => r.date >= from && r.date <= to);
  return {
    from, to, days: days.length, logged: logs.length,
    habitPct: days.length ? Math.round((logs.reduce((a, r) => a + hits(r), 0) / (days.length * 5)) * 100) : 0,
    drinkNights: logs.filter(r => (r.drinks || 0) > 0).length,
    workouts: weekdayLogs.filter(r => r.trained).length,
    practiceMin: logs.reduce((a, r) => a + (r.practice || 0), 0),
    rounds: rs.length,
    money: rs.reduce((a, r) => a + (r.money || 0), 0),
    avgScore: rs.length ? Math.round((rs.reduce((a, r) => a + (r.front || 0) + (r.back || 0), 0) / rs.length) * 10) / 10 : null,
  };
}

/** Compact JSON for Claude reviews (GET /api/v1/summary?days=14). */
export async function buildSummary(ctx, days = 14) {
  const to = ctx.today();
  const from = addDays(to, -(days - 1));
  const program = await ctx.program();
  const [daily, rounds, tests, body] = await Promise.all([
    listDocs(ctx.db, "daily", { since: from, until: to }),
    listDocs(ctx.db, "rounds", { since: from, until: to }),
    listDocs(ctx.db, "tests", { since: from, until: to }),
    listDocs(ctx.db, "body", { since: from, until: to }),
  ]);
  const plan = dayPlan(program, to);
  const strip = o => Object.fromEntries(Object.entries(o).filter(([k, v]) => v != null && v !== "" && k !== "id" && k !== "created" && k !== "updated"));
  return {
    generated: ctx.now().toISOString(), tz: ctx.tz, today: to, week: plan.week,
    phase: plan.phase ? plan.phase.name : null, focus: plan.focus, sleep: plan.sleep, drinkLimit: plan.drinkLimit,
    stats: rangeStats(daily, rounds, from, to),
    thisWeek: rangeStats(daily, rounds, mondayOf(to), to),
    daily: daily.map(strip).sort((a, b) => a.date.localeCompare(b.date)),
    rounds: rounds.map(strip), tests: tests.map(strip), body: body.map(strip),
  };
}
