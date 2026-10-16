// Cron jobs (spec section 8). Cron strings must match wrangler.toml exactly.
import { dayPlan, morningAlerts, morningFlex, morningNoteText } from "./program.js";
import { addDays, mondayOf, weekOf } from "./dates.js";
import { getDoc, putDoc, listDocs, getSetting, setSetting } from "./db.js";
import { QUESTIONS, questionMessage } from "./checkin.js";
import { guardedPush, dashboardUrl, rangeStats, buildSummary } from "./context.js";
import { weeklyReview, toOverrides } from "./claude.js";
import { getSc4 } from "./sc4store.js";
import { activeUsers, getUser, getProfile, listUsers } from "./users.js";
import { claimJob, finishJob, retryLater } from "./jobqueue.js";
import { designProgram, saveProgramVersion, getProgram, proposalMessage } from "./programs.js";
import { listMessages } from "./msglog.js";

export const CRON = {
  morning: "45 1 * * *", // 08:45 Bangkok
  evening: "30 14 * * *", // 21:30 Bangkok
  weekly: "0 13 * * SUN", // Sunday 20:00 Bangkok
  jobs: "* * * * *", // background jobs (program design)
};

/** Runs `fn` for every active user that has a program; one user's failure doesn't stop the others. */
async function forEachActiveUser(base, fn) {
  const results = [];
  for (const user of await activeUsers(base.db)) {
    const ctx = base.forUser(user);
    try {
      if (!(await ctx.program())) continue;
      results.push(await fn(ctx));
    } catch (e) {
      console.error("job failed for user", user.id, e && e.stack || e);
    }
  }
  return results;
}

export async function runScheduled(cron, base) {
  switch (cron) {
    case CRON.morning: return forEachActiveUser(base, morningJob);
    case CRON.evening: return forEachActiveUser(base, eveningJob);
    case CRON.weekly: case "0 13 * * 0": return forEachActiveUser(base, weeklyJob);
    case CRON.jobs: return runJobs(base);
    default: console.warn("unknown cron", cron);
  }
}

/** Sends a push to every admin (e.g. "new sign-up"). */
export async function notifyAdmins(base, text) {
  for (const u of await listUsers(base.db)) {
    if (u.role === "admin" && u.status === "active") await guardedPush(base.forUser(u), [text], { tools: ["admin-notice"] }).catch(e => console.error("notify admin", e));
  }
}

/** Runs the oldest waiting background job, if any. */
export async function runJobs(base) {
  const job = await claimJob(base.db, base.now().getTime());
  if (!job) return null;
  const nowIso = () => base.now().toISOString();
  try {
    if (job.kind === "design") await runDesignJob(base, job);
    else throw new Error(`unknown job kind ${job.kind}`);
    await finishJob(base.db, job.id, { ok: true }, nowIso());
    return { id: job.id, ok: true };
  } catch (e) {
    console.error("background job failed", job.kind, job.id, e && e.stack || e);
    if (job.attempts < 2) await retryLater(base.db, job.id, e.message, nowIso());
    else {
      await finishJob(base.db, job.id, { ok: false, error: e.message }, nowIso());
      const user = await getUser(base.db, job.user_id);
      if (user) await guardedPush(base.forUser(user), [user.lang === "th" ? "ขออภัย ตอนนี้ร่างแผนไม่สำเร็จ โค้ชจะตรวจสอบและติดต่อกลับ" : "Sorry, I couldn't finish your program draft. Your coach will look into it."]).catch(() => {});
      await notifyAdmins(base, `Program design failed for ${user ? user.name || user.id : job.user_id}: ${e.message}`);
    }
    return { id: job.id, ok: false, error: e.message };
  }
}

async function runDesignJob(base, job) {
  const user = await getUser(base.db, job.user_id);
  if (!user) throw new Error("user not found");
  const ctx = base.forUser(user);
  const profile = await getProfile(ctx.db, user.id);
  const conversation = (await listMessages(base.db, user.id, { limit: 40 })).reverse()
    .filter(m => m.text && (m.type === "text" || m.dir === "out")).map(m => `${m.dir === "in" ? "User" : "Coach"}: ${m.text}`).slice(-30);
  const previous = job.payload.previousId ? await getProgram(base.db, job.payload.previousId) : null;
  const feedback = [job.payload.brief, job.payload.changes].filter(Boolean).join("\n");
  const { design, program } = await designProgram(ctx, { user, profile, conversation, previous: previous && previous.program, feedback, example: base.bundledProgram });
  const { id } = await saveProgramVersion(ctx.db, user.id, program, { status: "proposed", summary: design.summary, changes: design.changes }, base.now().toISOString());
  await guardedPush(ctx, [proposalMessage(user.lang, design.summary, id, await dashboardUrl(ctx))], { model: "claude-opus-5-5", tools: ["design_program"] });
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
  // No convo row is written here: tapping a button starts the check-in, so a round entry
  // that happens to be in progress at 21:30 is not wiped.
  return guardedPush(ctx, [questionMessage(QUESTIONS[0], "Check-in time. 9 quick taps.\n")]);
}

export async function weeklyJob(ctx) {
  const today = ctx.today();
  const mon = mondayOf(today);
  const program = await ctx.program();
  const golfer = ctx.isGolfer();
  const [daily, rounds] = await Promise.all([
    listDocs(ctx.db, "daily", { since: mon, until: today }),
    golfer ? listDocs(ctx.db, "rounds", { since: mon, until: today }) : [],
  ]);
  const s = rangeStats(daily, rounds, mon, today);
  const week = weekOf(today, program.start);
  const limit = (program.weeks[week - 1] || {}).drinks;
  const lines = [
    `Week ${week} summary (${mon} to ${today})`,
    `Habits: ${s.habitPct}% · logged ${s.logged}/7 days`,
    `Workouts: ${s.workouts}/5 · practice ${s.practiceMin} min`,
    `Drinking nights: ${s.drinkNights}${limit != null ? ` (max ${limit})` : ""}`,
  ];
  if (golfer) lines.push(`Rounds: ${s.rounds}${s.rounds ? ` · avg ${s.avgScore} · money ${s.money.toLocaleString("en-US")}` : ""}`);
  const sc4 = golfer ? await getSc4(ctx).catch(e => { console.error("sc4 weekly", e); return null; }) : null;
  if (sc4 && sc4.totalShots) {
    const wk = sc4.sessions.filter(x => x.date >= mon && x.date <= today);
    const shots = wk.reduce((a, x) => a + x.n, 0);
    const days = new Set(wk.map(x => x.date)).size;
    lines.push(`SC4: ${shots ? `${shots} shots, ${days} practice day${days === 1 ? "" : "s"}` : "no uploads this week"}`);
    const top = sc4.insights.filter(i => i.level !== "info").slice(0, 2);
    if (top.length) lines.push(...top.map(i => `- ${i.text}`));
  }
  const messages = [lines.join("\n")];

  if (ctx.env.ANTHROPIC_API_KEY) {
    const nextMonday = addDays(today, 1);
    const nextWeek = weekOf(nextMonday, program.start);
    try {
      const summary = await buildSummary(ctx, 14);
      const review = await weeklyReview({ apiKey: ctx.env.ANTHROPIC_API_KEY, summary, program, nextWeek, user: ctx.user, fetch: ctx.fetch });
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
