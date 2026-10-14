// POST /line/webhook - signature check, owner filter, check-in flow and text commands.
import { verifySignature } from "./line.js";
import {
  QUESTIONS, parsePostback, newState, nextQuestion, applyAnswer, awaitingNote, questionMessage, toDailyRow, summaryText,
} from "./checkin.js";
import { parseRound, parseBody, HELP_TEXT } from "./commands.js";
import {
  newScoreState, nextScoreQuestion, applyScoreAnswer, parseScorePostback, scoreQuestionMessage, toRoundDoc, roundSummary,
} from "./score.js";
import { fullPlanText, weekPlanText, dayPlan } from "./program.js";
import { checkinDate, weekOf } from "./dates.js";
import { loadConvo, saveConvo, clearConvo, putDoc, rememberOrigin } from "./db.js";
import { dashboardUrl } from "./context.js";
import { getSc4 } from "./sc4store.js";
import { clubOptions, pickClub } from "./sc4.js";
import { getSetting } from "./db.js";

const STALE_MS = 18 * 3600 * 1000; // an unfinished check-in older than this starts over

export async function handleWebhook(request, ctx, waitUntil = p => p) {
  const raw = await request.text();
  const ok = await verifySignature(ctx.env.LINE_CHANNEL_SECRET, raw, request.headers.get("x-line-signature"));
  if (!ok) return new Response("invalid signature", { status: 401 });

  let body;
  try { body = JSON.parse(raw); } catch { return new Response("bad request", { status: 400 }); }

  waitUntil(rememberOrigin(ctx.db, new URL(request.url).origin).catch(e => console.error("origin", e)));

  for (const event of body.events || []) {
    try {
      await handleEvent(event, ctx);
    } catch (e) {
      console.error("event failed", event.type, e && e.stack || e);
    }
  }
  return new Response("ok");
}

export async function handleEvent(event, ctx) {
  const userId = event.source && event.source.userId;
  const owner = (ctx.env.OWNER_LINE_USER_ID || "").trim();
  const text = event.type === "message" && event.message && event.message.type === "text" ? event.message.text.trim() : null;
  const reply = msgs => (event.replyToken ? ctx.line.reply(event.replyToken, msgs) : null);

  if (!owner) {
    // Setup mode: tell whoever says "hello" their user ID so it can be saved as OWNER_LINE_USER_ID.
    if (text && /^(hello|hi)\b/i.test(text) && userId) {
      await reply(`Your LINE user ID:\n${userId}\n\nSave it as the OWNER_LINE_USER_ID secret in Cloudflare. Until then I only answer "hello".`);
    }
    return;
  }
  if (userId !== owner) return; // ignore everyone else, silently

  if (event.type === "follow") return reply(`Welcome to Road to Scratch.\n\n${HELP_TEXT}`);
  if (event.type === "postback") return onPostback(event.postback && event.postback.data, userId, ctx, reply);
  if (text != null) return onText(text, userId, ctx, reply);
}

/** The user's unfinished check-in or score entry (null if none, or if it went stale). */
async function currentState(ctx, userId) {
  const s = await loadConvo(ctx.db, userId);
  if (!s || (s.flow !== "checkin" && s.flow !== "score")) return null;
  if (s.updated && ctx.now() - Date.parse(s.updated) > STALE_MS) return null;
  return s;
}

async function onPostback(data, userId, ctx, reply) {
  if (String(data).startsWith("sc:")) {
    const ans = parseScorePostback(data);
    if (!ans) return;
    const state = await currentState(ctx, userId);
    if (!state || state.flow !== "score") return reply('That round entry has finished. Type "score" to log a new round.');
    return scoreAnswer(state, ans.field, ans.raw, userId, ctx, reply);
  }
  const ans = parsePostback(data);
  if (!ans) return;
  const current = await currentState(ctx, userId);
  const state = current && current.flow === "checkin" ? current : newState(checkinDate(ctx.now(), ctx.tz));
  return answer(state, ans.field, ans.value, userId, ctx, reply);
}

async function scoreAnswer(state, field, raw, userId, ctx, reply) {
  const nowIso = ctx.now().toISOString();
  const r = applyScoreAnswer(state, field, raw);
  if (r.error) return reply(scoreQuestionMessage(r.next, `${r.error} (Type "cancel" to stop.)\n`));
  if (!r.done) {
    await saveConvo(ctx.db, userId, r.state, nowIso);
    return reply(scoreQuestionMessage(r.next));
  }
  const doc = toRoundDoc(r.state.draft, nowIso);
  await putDoc(ctx.db, "rounds", crypto.randomUUID(), doc);
  await clearConvo(ctx.db, userId);
  return reply(roundSummary(doc));
}

async function startScore(ctx, userId, reply) {
  const state = newScoreState(ctx.today());
  await saveConvo(ctx.db, userId, state, ctx.now().toISOString());
  return reply(scoreQuestionMessage(nextScoreQuestion(state), 'Log a round. Type "cancel" to stop at any time.\n'));
}

async function answer(state, field, value, userId, ctx, reply) {
  const nowIso = ctx.now().toISOString();
  const { state: next, done, next: q } = applyAnswer(state, field, value);
  if (!done) {
    await saveConvo(ctx.db, userId, next, nowIso);
    return reply(questionMessage(q));
  }
  const program = await ctx.program();
  const row = toDailyRow(next.draft, weekOf(next.draft.date, program.start), nowIso);
  await putDoc(ctx.db, "daily", row.date, row);
  await clearConvo(ctx.db, userId);
  const plan = dayPlan(program, row.date);
  return reply(summaryText(row, { ...plan.sleep, screensOff: plan.screensOff }));
}

async function startCheckin(ctx, userId, reply) {
  const state = newState(checkinDate(ctx.now(), ctx.tz));
  await saveConvo(ctx.db, userId, state, ctx.now().toISOString());
  return reply(questionMessage(QUESTIONS[0], `Check-in for ${state.draft.date}\n`));
}

async function onText(text, userId, ctx, reply) {
  const lower = text.toLowerCase();
  const cmd = lower.split(/\s+/)[0];
  const COMMANDS = ["today", "plan", "help", "dashboard", "checkin", "check-in", "ci", "score", "round", "body", "hello", "quota", "cancel", "club"];
  const state = await currentState(ctx, userId);

  if (cmd === "cancel") {
    if (!state) return reply("Nothing to cancel.");
    await clearConvo(ctx.db, userId);
    return reply(state.flow === "score" ? "Round entry cancelled. Nothing saved." : "Check-in cancelled. Nothing saved.");
  }
  // During a score entry every typed message is an answer (a course could be called "Plan").
  if (state && state.flow === "score") {
    const q = nextScoreQuestion(state);
    return scoreAnswer(state, q.field, text, userId, ctx, reply);
  }

  if (!COMMANDS.includes(cmd)) {
    if (awaitingNote(state)) return answer(state, "note", text, userId, ctx, reply);
    if (state) return reply(questionMessage(nextQuestion(state), "Tap a button to answer:\n"));
    return reply(`Sorry, I didn't get that.\n\n${HELP_TEXT}`);
  }

  const program = await ctx.program();
  const today = ctx.today();
  switch (cmd) {
    case "today": return reply(fullPlanText(dayPlan(program, today)));
    case "plan": return reply(weekPlanText(program, today));
    case "help": return reply(HELP_TEXT);
    case "hello": return reply(`Hi! ${HELP_TEXT}`);
    case "dashboard": {
      const url = await dashboardUrl(ctx);
      return reply(url ? `Dashboard: ${url}` : "Dashboard link not known yet. Set PUBLIC_URL in wrangler.toml.");
    }
    case "checkin": case "check-in": case "ci": return startCheckin(ctx, userId, reply);
    case "score": return startScore(ctx, userId, reply);
    case "club": return reply(await clubReply(ctx, text));
    case "quota": {
      const q = await ctx.line.quota();
      return reply(`Push messages this month: ${q.used}${q.limit != null ? ` of ${q.limit}` : ""} (${q.type}). Replies are free.`);
    }
    case "round": {
      const r = parseRound(text);
      if (!r.ok) return reply(r.error);
      const nowIso = ctx.now().toISOString();
      const doc = { ...r.round, date: today, created: nowIso };
      await putDoc(ctx.db, "rounds", crypto.randomUUID(), doc);
      return reply(roundSummary(doc));
    }
    case "body": {
      const b = parseBody(text);
      if (!b.ok) return reply(b.error);
      await putDoc(ctx.db, "body", crypto.randomUUID(), { ...b.body, date: today, created: ctx.now().toISOString() });
      return reply(`Body saved for ${today}: ${b.body.weight} kg${b.body.waist != null ? `, waist ${b.body.waist} cm` : ""}${b.body.uric != null ? `, uric ${b.body.uric}` : ""}${b.body.flare ? ", flare" : ""}.`);
    }
  }
}

/** `club 145`, `club 145 +1` (into wind / uphill), `club 145 -1` (downwind / downhill). */
export async function clubReply(ctx, text) {
  const m = /^club\s+(\d{2,3})(?:\s*([+-][12]))?\s*$/i.exec(text.trim());
  if (!m) return "Type the yards to the middle of the green, e.g. club 145\nAdd +1 into wind or uphill, +2 strong wind, -1 downwind.";
  const d = Number(m[1]), adj = m[2] ? Number(m[2]) : 0;
  const [sc4, yards] = await Promise.all([getSc4(ctx), getSetting(ctx.db, "yardages")]);
  const options = clubOptions(sc4.clubs, (yards && yards.clubs) || {});
  const r = pickClub(options, d, adj);
  if (r.reason === "none") return "No yardages yet. Upload SC4 data or fill in My yardages on the dashboard (Clubs tab).";
  if (!r.pick) {
    return r.reason === "long"
      ? `${d} yd is beyond your average carry with any club. Lay up to your favourite wedge distance.`
      : `${d} yd is shorter than your shortest stock swing (${r.shortest.label}, ${r.shortest.carry} yd). Use a shorter swing.`;
  }
  const p = r.pick;
  const lines = [`${d} yd${adj ? ` (${adj > 0 ? "+" : ""}${adj} club)` : ""} → ${p.label}`];
  lines.push(p.source === "sc4"
    ? `Carry ${p.carry} yd, usually ${p.lo}–${p.hi} (SC4, last ${p.n} shots)`
    : `Carry ${p.carry} yd (your saved yardage)`);
  if (p.side != null && Math.abs(p.side) >= 5) lines.push(`Misses ${Math.round(Math.abs(p.side))} yd ${p.side > 0 ? "right" : "left"} on average: aim at the ${p.side > 0 ? "left" : "right"} half of the green.`);
  else lines.push("Aim at the middle of the green.");
  if (r.below && !adj) lines.push(`${r.below.label} (${r.below.carry}) only gets there if you flush it.`);
  return lines.join("\n");
}
