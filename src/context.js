// Shared helpers that need the database: program loading, stats, summary, guarded pushes.
import { applyOverrides, dayPlan } from "./program.js";
import { DEFAULT_TZ, localDate, addDays, mondayOf, monthKey } from "./dates.js";
import { getSetting, setSetting, listDocs, scopedDb } from "./db.js";
import { LineClient, toMessages } from "./line.js";
import { isAdmin } from "./users.js";
import { logOutgoing } from "./msglog.js";
import { activeProgram } from "./programs.js";
import { hits } from "./checkin.js";
import { getSc4 } from "./sc4store.js";

/**
 * Base context for one request or cron run. `forUser(user)` returns a child context whose `db` is
 * scoped to that user, with that user's program, replies and pushes (all logged to `messages`).
 */
export function makeContext(env, { program, fetchImpl, now } = {}) {
  const tz = env.TZ || DEFAULT_TZ;
  return {
    env, tz, db: env.DB, uid: null, user: null,
    line: new LineClient(env.LINE_CHANNEL_ACCESS_TOKEN, fetchImpl),
    fetch: fetchImpl, // also used for the Anthropic API and LINE Login (tests inject a fake)
    bundledProgram: program,
    now: now || (() => new Date()),
    today() { return localDate(this.now(), tz); },
    forUser(user) { return userContext(this, user); },
  };
}

function userContext(base, user) {
  const ctx = Object.create(base);
  ctx.user = user;
  ctx.uid = user.id;
  ctx.db = scopedDb(base.env.DB, user.id);
  ctx._loaded = false;
  ctx._program = null;
  /** This user's program (active version, or the bundled program for the admin), with overrides. Null if none yet. */
  ctx.program = async function () {
    if (!this._loaded) {
      let program = null;
      const active = await activeProgram(this.db, this.uid);
      if (active) program = active.program;
      else if (isAdmin(this.user)) {
        const stored = await getSetting(this.db, "program");
        program = stored && Array.isArray(stored.weeks) && stored.template && stored.sessions ? stored : this.bundledProgram;
      }
      this._program = program ? applyOverrides(program, await getSetting(this.db, "program_overrides")) : null;
      this._loaded = true;
    }
    return this._program;
  };
  ctx.resetProgram = function () { this._loaded = false; this._program = null; };
  ctx.isGolfer = function () { return this.user.golfer !== false; };
  /** Reply (free) and log it. */
  ctx.reply = async function (replyToken, messages, meta = {}) {
    const msgs = toMessages(messages);
    await this.line.reply(replyToken, msgs);
    await logOutgoing(this.db, this.uid, msgs.slice(0, 5), this.now().toISOString(), { ...meta, kind: "reply" }).catch(e => console.error("log out", e));
  };
  return ctx;
}

export async function dashboardUrl(ctx) {
  if (ctx.user && !isAdmin(ctx.user) && ctx.env.LIFF_ID) return `https://liff.line.me/${ctx.env.LIFF_ID}/app`;
  const base = (ctx.env.PUBLIC_URL || (await getSetting(ctx.db, "origin")) || "").replace(/\/+$/, "");
  return /^https:\/\//.test(base) ? base + "/" : "";
}

/**
 * Push to this context's user unless the OA's push count this month has reached PUSH_MONTHLY_LIMIT
 * (the LINE quota is shared by all users). Returns true if sent. Replies are free and not counted.
 */
export async function guardedPush(ctx, messages, meta = {}) {
  const to = ctx.uid;
  if (!to) return false;
  const limit = Number(ctx.env.PUSH_MONTHLY_LIMIT || 250);
  const month = monthKey(ctx.today());
  const counter = (await getSetting(ctx.db, "push_count")) || {};
  const count = counter.month === month ? counter.count || 0 : 0;
  if (count >= limit) {
    console.warn(`push skipped: ${count} pushes already sent in ${month} (limit ${limit})`);
    return false;
  }
  const msgs = toMessages(messages);
  await ctx.line.push(to, msgs);
  await setSetting(ctx.db, "push_count", { month, count: count + 1 });
  await logOutgoing(ctx.db, to, msgs.slice(0, 5), ctx.now().toISOString(), { ...meta, kind: "push" }).catch(e => console.error("log out", e));
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
  const plan = program ? dayPlan(program, to) : null;
  const sc4 = await getSc4(ctx).catch(e => { console.error("sc4 summary", e); return null; });
  const strip = o => Object.fromEntries(Object.entries(o).filter(([k, v]) => v != null && v !== "" && k !== "id" && k !== "created" && k !== "updated"));
  return {
    generated: ctx.now().toISOString(), tz: ctx.tz, today: to, user: ctx.user ? { name: ctx.user.name, golfer: ctx.user.golfer } : null,
    week: plan ? plan.week : null, phase: plan && plan.phase ? plan.phase.name : null, focus: plan ? plan.focus : null,
    sleep: plan ? plan.sleep : null, drinkLimit: plan ? plan.drinkLimit : null,
    stats: rangeStats(daily, rounds, from, to),
    thisWeek: rangeStats(daily, rounds, mondayOf(to), to),
    daily: daily.map(strip).sort((a, b) => a.date.localeCompare(b.date)),
    rounds: rounds.map(strip), tests: tests.map(strip), body: body.map(strip),
    sc4: sc4 && sc4.totalShots ? {
      shots: sc4.totalShots, from: sc4.firstDate, to: sc4.lastDate,
      clubs: sc4.clubs.map(c => ({ club: c.club, swing: c.swing, n: c.n, carry: c.carry, range: [c.lo, c.hi], side: c.side, clubSpeed: c.clubSpeed, smash: c.smash })),
      recentSessions: sc4.sessions.filter(s => s.date >= from),
      insights: sc4.insights.map(i => i.text),
    } : null,
  };
}
