// Cron jobs (spec section 8). Cron strings must match wrangler.toml exactly.
import { dayPlan, morningAlerts, morningFlex, morningNoteText } from "./program.js";
import { addDays, mondayOf, weekOf } from "./dates.js";
import { getDoc, putDoc, listDocs, getSetting, setSetting } from "./db.js";
import { QUESTIONS, questionMessage } from "./checkin.js";
import { guardedPush, dashboardUrl, rangeStats, buildSummary } from "./context.js";
import { weeklyReview, toOverrides } from "./claude.js";

export const CRON = {
  morning: "45 1 * * *", // 08:45 Bangkok
  evening: "30 14 * * *", // 21:30 Bangkok
  weekly: "0 13 * * SUN", // Sunday 20:00 Bangkok
};

export async function runScheduled(cron, ctx) {
  switch (cron) {
    case CRON.morning: return morningJob(ctx);
    case CRON.evening: return eveningJob(ctx);
    case CRON.weekly: case "0 13 * * 0": return weeklyJob(ctx);
    default: console.warn("unknown cron", cron);
  }
}

/** Builds the morning message without sending it (used by the job and by tests). */
export async function buildMorning(ctx) {
  const program = await ctx.program();
  const today = ctx.today();
  const plan = dayPlan(program, today);
  const yesterday = addDays(today, -1);
  const mon = mondayOf(today);
  const [yesterdayRow, weekRows, coach, url] = await Promise.all([
    getDoc(ctx.db, "daily", yesterday),
    mon < today ? listDocs(ctx.db, "daily", { since: mon, until: yesterday }) : [],
    getDoc(ctx.db, "coach", today),
    dashboardUrl(ctx),
  ]);
  const alerts = morningAlerts(plan, { yesterdayRow, weekRows });
  const flex = morningFlex(plan, { alerts, coachMessage: coach ? coach.message : "", dashboardUrl: url });
  return { plan, alerts, flex, coach };
}

export async function morningJob(ctx) {
  const { plan, alerts, flex, coach } = await buildMorning(ctx);
  // Mirror the note into the dashboard's coach card (keep a note Claude already wrote for today).
  if (!coach) {
    await putDoc(ctx.db, "coach", plan.date, { title: plan.title, message: morningNoteText(plan), alerts, created: ctx.now().toISOString() });
  } else if (alerts.length) {
    const merged = [...new Set([...(Array.isArray(coach.alerts) ? coach.alerts : []), ...alerts])];
    await putDoc(ctx.db, "coach", plan.date, { ...coach, alerts: merged });
  }
  return guardedPush(ctx, [flex]);
}

export async function eveningJob(ctx) {
  const today = ctx.today();
  if (await getDoc(ctx.db, "daily", today)) return false; // already logged (dashboard or earlier check-in)
  if (!ctx.env.OWNER_LINE_USER_ID) return false;
  // No convo row is written here: tapping a button starts the check-in, so a round entry
  // that happens to be in progress at 21:30 is not wiped.
  return guardedPush(ctx, [questionMessage(QUESTIONS[0], "Check-in time. 9 quick taps.\n")]);
}

export async function weeklyJob(ctx) {
  const today = ctx.today();
  const mon = mondayOf(today);
  const program = await ctx.program();
  const [daily, rounds] = await Promise.all([
    listDocs(ctx.db, "daily", { since: mon, until: today }),
    listDocs(ctx.db, "rounds", { since: mon, until: today }),
  ]);
  const s = rangeStats(daily, rounds, mon, today);
  const week = weekOf(today, program.start);
  const limit = (program.weeks[week - 1] || {}).drinks;
  const lines = [
    `Week ${week} summary (${mon} to ${today})`,
    `Habits: ${s.habitPct}% · logged ${s.logged}/7 days`,
    `Workouts: ${s.workouts}/5 · practice ${s.practiceMin} min`,
    `Drinking nights: ${s.drinkNights}${limit != null ? ` (max ${limit})` : ""}`,
    `Rounds: ${s.rounds}${s.rounds ? ` · avg ${s.avgScore} · money ${s.money.toLocaleString("en-US")}` : ""}`,
  ];
  const messages = [lines.join("\n")];

  if (ctx.env.ANTHROPIC_API_KEY) {
    const nextMonday = addDays(today, 1);
    const nextWeek = weekOf(nextMonday, program.start);
    try {
      const summary = await buildSummary(ctx, 14);
      const review = await weeklyReview({ apiKey: ctx.env.ANTHROPIC_API_KEY, summary, program, nextWeek });
      const nowIso = ctx.now().toISOString();
      await putDoc(ctx.db, "coach", nextMonday, {
        title: review.coach_note.title, message: review.coach_note.message,
        alerts: (review.coach_note.alerts || []).slice(0, 3), created: nowIso,
      });
      if (nextWeek >= 1) {
        const existing = await getSetting(ctx.db, "program_overrides");
        await setSetting(ctx.db, "program_overrides", toOverrides(existing, nextWeek, review, nowIso));
      }
      messages.push(`Coach: ${review.coach_note.title}\n${review.coach_note.message}`);
    } catch (e) {
      console.error("weekly review failed", e && e.stack || e);
      messages.push("(Claude review failed this week - check the Worker logs.)");
    }
  }
  return guardedPush(ctx, messages);
}
