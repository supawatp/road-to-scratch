// POST /line/webhook - signature check, owner filter, check-in flow and text commands.
import { verifySignature } from "./line.js";
import {
  QUESTIONS, parsePostback, newState, nextQuestion, applyAnswer, awaitingNote, questionMessage, toDailyRow, summaryText,
} from "./checkin.js";
import { parseRound, parseBody, HELP_TEXT } from "./commands.js";
import { fullPlanText, weekPlanText, dayPlan } from "./program.js";
import { checkinDate, weekOf } from "./dates.js";
import { loadConvo, saveConvo, clearConvo, putDoc, rememberOrigin } from "./db.js";
import { dashboardUrl } from "./context.js";

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
    if (text && /^hello$/i.test(text) && userId) {
      await reply(`Your LINE user ID:\n${userId}\n\nSave it as the OWNER_LINE_USER_ID secret in Cloudflare. Until then I only answer "hello".`);
    }
    return;
  }
  if (userId !== owner) return; // ignore everyone else, silently

  if (event.type === "follow") return reply(`Welcome to Road to Scratch.\n\n${HELP_TEXT}`);
  if (event.type === "postback") return onPostback(event.postback && event.postback.data, userId, ctx, reply);
  if (text != null) return onText(text, userId, ctx, reply);
}

async function currentState(ctx, userId) {
  const s = await loadConvo(ctx.db, userId);
  if (!s || s.flow !== "checkin") return null;
  if (s.updated && ctx.now() - Date.parse(s.updated) > STALE_MS) return null;
  return s;
}

async function onPostback(data, userId, ctx, reply) {
  const ans = parsePostback(data);
  if (!ans) return;
  const state = (await currentState(ctx, userId)) || newState(checkinDate(ctx.now(), ctx.tz));
  return answer(state, ans.field, ans.value, userId, ctx, reply);
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
  const COMMANDS = ["today", "plan", "help", "dashboard", "checkin", "check-in", "ci", "round", "body", "hello", "quota"];

  if (!COMMANDS.includes(cmd)) {
    const state = await currentState(ctx, userId);
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
      const total = doc.front + doc.back;
      const bits = [`Round saved for ${today}: ${total} (${doc.front}/${doc.back})`];
      if (doc.putts != null) bits.push(`${doc.putts} putts`);
      if (doc.penalties != null) bits.push(`${doc.penalties} pen`);
      if (doc.doubles != null) bits.push(`${doc.doubles} dbl`);
      if (doc.money != null) bits.push(`money ${doc.money.toLocaleString("en-US")}`);
      return reply(bits.join(" · "));
    }
    case "body": {
      const b = parseBody(text);
      if (!b.ok) return reply(b.error);
      await putDoc(ctx.db, "body", crypto.randomUUID(), { ...b.body, date: today, created: ctx.now().toISOString() });
      return reply(`Body saved for ${today}: ${b.body.weight} kg${b.body.waist != null ? `, waist ${b.body.waist} cm` : ""}${b.body.uric != null ? `, uric ${b.body.uric}` : ""}${b.body.flare ? ", flare" : ""}.`);
    }
  }
}
