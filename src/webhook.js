// POST /line/webhook - signature check, users and sign-up status, chat log, photos, check-in flow,
// text commands and the coach.
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
import { loadConvo, saveConvo, clearConvo, putDoc, rememberOrigin, getSetting } from "./db.js";
import { dashboardUrl, guardedPush } from "./context.js";
import { askCoach, clearMemory } from "./chat.js";
import { getSc4 } from "./sc4store.js";
import { clubOptions, pickClub } from "./sc4.js";
import { getUser, touchUser, updateUser, getProfile, isAdmin } from "./users.js";
import { logIncoming } from "./msglog.js";
import { saveLineContent, imageBlock } from "./media.js";
import { activeProgram, getProgram, setProgramStatus } from "./programs.js";
import { notifyAdmins } from "./jobs.js";

const STALE_MS = 18 * 3600 * 1000; // an unfinished check-in older than this starts over
const MEDIA_TYPES = ["image", "video", "audio", "file"];

/**
 * `defer` is ExecutionContext.waitUntil when running on Workers: events are then handled after LINE
 * has its 200 (coach answers can take a while). Without it (tests) the events are awaited.
 */
export async function handleWebhook(request, ctx, waitUntil = p => p, defer = null) {
  const raw = await request.text();
  const ok = await verifySignature(ctx.env.LINE_CHANNEL_SECRET, raw, request.headers.get("x-line-signature"));
  if (!ok) return new Response("invalid signature", { status: 401 });

  let body;
  try { body = JSON.parse(raw); } catch { return new Response("bad request", { status: 400 }); }

  waitUntil(rememberOrigin(ctx.db, new URL(request.url).origin).catch(e => console.error("origin", e)));

  const work = (async () => {
    for (const event of body.events || []) {
      try {
        await handleEvent(event, ctx);
      } catch (e) {
        console.error("event failed", event.type, e && e.stack || e);
      }
    }
  })();
  if (defer) defer(work);
  else await work;
  return new Response("ok");
}

const liffUrl = (ctx, path) => (ctx.env.LIFF_ID ? `https://liff.line.me/${ctx.env.LIFF_ID}/${path}` : null);
const t = (user, en, th) => (user && user.lang === "th" ? th : en);

function signUpMessage(ctx) {
  const url = liffUrl(ctx, "signup");
  const text = "Welcome to Road to Scratch, a personal health & golf coach in LINE.\nยินดีต้อนรับสู่ Road to Scratch โค้ชสุขภาพและกอล์ฟส่วนตัวใน LINE";
  if (!url) return `${text}\n\nSign-up opens soon. / เปิดรับสมัครเร็ว ๆ นี้`;
  return { type: "template", altText: "Sign up / สมัครใช้งาน",
    template: { type: "buttons", text: "Tap to sign up.\nแตะเพื่อสมัครใช้งาน", actions: [{ type: "uri", label: "Sign up / สมัคร", uri: url }] } };
}

function questionnaireMessage(ctx, user) {
  const url = liffUrl(ctx, "onboarding");
  const text = t(user, "You're approved! First, a 5-minute questionnaire so your program fits you.", "ได้รับการอนุมัติแล้ว! เริ่มจากแบบสอบถาม 5 นาที เพื่อให้แผนเหมาะกับคุณ");
  if (!url) return text;
  return { type: "template", altText: text.slice(0, 100),
    template: { type: "buttons", text: text.slice(0, 160), actions: [{ type: "uri", label: t(user, "Start questionnaire", "เริ่มแบบสอบถาม"), uri: url }] } };
}

/** Status a returning (re-followed) user goes back to. */
async function statusAfterRefollow(ctx, user) {
  if (isAdmin(user)) return "active";
  if (user.approvedAt) return (await activeProgram(ctx.db, user.id)) ? "active" : "onboarding";
  return user.consentAt ? "pending" : "new";
}

export async function handleEvent(event, base) {
  const userId = event.source && event.source.userId;
  if (!userId || (event.source.type && event.source.type !== "user")) return; // 1:1 chats only
  const owner = (base.env.OWNER_LINE_USER_ID || "").trim();
  const text = event.type === "message" && event.message && event.message.type === "text" ? event.message.text.trim() : null;

  if (!owner) {
    // Setup mode: tell whoever says "hello" their user ID so it can be saved as OWNER_LINE_USER_ID.
    if (text && /^(hello|hi)\b/i.test(text) && event.replyToken) {
      await base.line.reply(event.replyToken, [`Your LINE user ID:\n${userId}\n\nSave it as the OWNER_LINE_USER_ID secret in Cloudflare. Until then I only answer "hello".`]);
    }
    return;
  }

  const nowIso = base.now().toISOString();
  let known = await getUser(base.db, userId);
  let lineProfile = null;
  if (!known || event.type === "follow" || !known.displayName) lineProfile = await base.line.profile(userId).catch(() => null);
  let user = await touchUser(base.db, userId, nowIso, lineProfile);
  const ctx = base.forUser(user);

  // Photos and files: save before LINE's copy expires.
  let media = null;
  if (event.type === "message" && MEDIA_TYPES.includes(event.message.type)) {
    media = await saveLineContent(ctx, userId, event.message, nowIso).catch(e => { console.error("media save", e.message); return { skipped: e.message }; });
  }
  await logIncoming(ctx.db, userId, event, nowIso, { mediaId: media && media.id }).catch(e => console.error("log in", e));
  const reply = (msgs, meta) => (event.replyToken ? ctx.reply(event.replyToken, msgs, meta) : null);

  if (event.type === "unfollow") {
    if (!isAdmin(user)) await updateUser(base.db, userId, { status: "left" }, nowIso);
    return;
  }
  if (event.type === "follow" && user.status === "left") {
    user = await updateUser(base.db, userId, { status: await statusAfterRefollow(ctx, user) }, nowIso);
    ctx.user = user;
  }

  switch (user.status) {
    case "disabled": case "left": return;
    case "new":
      return reply([signUpMessage(ctx)]);
    case "pending":
      if (event.type === "follow" || text != null) return reply([t(user, "Thanks for signing up! Your coach will approve your account soon.", "ขอบคุณที่สมัคร! โค้ชจะอนุมัติบัญชีของคุณเร็ว ๆ นี้")]);
      return;
    case "onboarding":
      return onOnboarding(event, ctx, text, media, reply);
    default:
      break;
  }

  if (event.type === "follow") return reply([`Welcome back to Road to Scratch.\n\n${HELP_TEXT}`]);
  if (event.type === "postback") {
    const data = event.postback && event.postback.data;
    if (String(data).startsWith("prog:")) return onProgramPostback(data, ctx, reply);
    return onPostback(data, userId, ctx, reply);
  }
  if (event.type === "message" && event.message.type === "image") return photoReply(ctx, userId, media, reply);
  if (text != null) return onText(text, userId, ctx, reply);
}

/** Approved but not active yet: questionnaire, follow-up chat with the coach, program drafts. */
async function onOnboarding(event, ctx, text, media, reply) {
  const user = ctx.user;
  if (event.type === "postback" && String(event.postback && event.postback.data).startsWith("prog:")) return onProgramPostback(event.postback.data, ctx, reply);
  const profile = await getProfile(ctx.db, user.id);
  if (!profile.answeredAt) {
    if (event.type === "follow" || text != null) return reply([questionnaireMessage(ctx, user)]);
    return;
  }
  if (text == null) return media ? reply([t(user, "Got it, saved.", "ได้รับแล้ว บันทึกไว้แล้ว")]) : undefined;
  if (!ctx.env.ANTHROPIC_API_KEY) return reply([t(user, "Thanks! Your coach will be in touch about your program.", "ขอบคุณ! โค้ชจะติดต่อเรื่องแผนของคุณ")]);
  ctx.line.startLoading(user.id, 30).catch(() => {});
  const res = await askCoach(ctx, text, { onboarding: true });
  await sendCoachAnswer(ctx, res, reply);
  if (res.accepted) await notifyAdmins(ctx, `${user.name || user.displayName || user.id} accepted program v${res.accepted.version}. Review and activate it in the admin portal.`);
}

async function onProgramPostback(data, ctx, reply) {
  const [, action, id] = String(data).split(":");
  const p = id ? await getProgram(ctx.db, id) : null;
  const user = ctx.user;
  if (!p || p.userId !== user.id) return reply([t(user, "That draft is no longer available.", "ร่างนี้ไม่มีแล้ว")]);
  if (action === "accept") {
    if (p.status !== "proposed") return reply([t(user, "This draft was already handled.", "ร่างนี้ดำเนินการไปแล้ว")]);
    await setProgramStatus(ctx.db, p.id, "accepted", ctx.now().toISOString());
    await notifyAdmins(ctx, `${user.name || user.displayName || user.id} accepted program v${p.version}. Review and activate it in the admin portal.`);
    return reply([t(user, "Great! Your coach will give it a final check and let you know when it starts.", "เยี่ยม! โค้ชจะตรวจสอบครั้งสุดท้าย และแจ้งเมื่อเริ่มแผน")]);
  }
  if (action === "change") return reply([t(user, "Sure. What would you like to change?", "ได้เลย อยากเปลี่ยนอะไรบ้าง")]);
}

async function sendCoachAnswer(ctx, res, reply) {
  const meta = { model: res.usage && res.usage.model, tokensIn: res.usage && res.usage.tokensIn, tokensOut: res.usage && res.usage.tokensOut, tools: res.actions && res.actions.length ? res.actions : undefined };
  try {
    return await reply([res.text], meta);
  } catch (e) {
    // The reply token may have expired while Claude was thinking: send it as a push instead.
    console.warn("reply failed, pushing instead", e.message);
    return guardedPush(ctx, [res.text], meta);
  }
}

async function photoReply(ctx, userId, media, reply) {
  if (!media || !media.id) return reply([t(ctx.user, "I couldn't save that photo. Please try again.", "บันทึกรูปไม่สำเร็จ ลองส่งใหม่อีกครั้ง")]);
  const block = imageBlock(media.bytes, media.contentType);
  if (!ctx.env.ANTHROPIC_API_KEY || !block) return reply([t(ctx.user, "Photo saved.", "บันทึกรูปแล้ว")]);
  ctx.line.startLoading(userId, 30).catch(() => {});
  const res = await askCoach(ctx, "", { image: block, photoId: media.id });
  return sendCoachAnswer(ctx, res, reply);
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
  const COMMANDS = ["today", "plan", "help", "dashboard", "checkin", "check-in", "ci", "score", "round", "body", "hello", "quota", "cancel", "club", "forget"];
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
    if (state) return reply(questionMessage(nextQuestion(state), "Tap a button to answer (or type cancel):\n"));
    return coachReply(ctx, userId, text, reply);
  }

  if (!ctx.isGolfer() && ["score", "round", "club"].includes(cmd)) return reply(t(ctx.user, "Golf features are switched off for your program.", "ฟีเจอร์กอล์ฟปิดอยู่สำหรับแผนของคุณ"));
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
    case "forget": await clearMemory(ctx); return reply("Done. The coach has forgotten our earlier messages.");
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
    ? `Carry ${p.carry} yd, usually ${p.lo}–${p.hi} (SC4 average ± 1 SD, last ${p.n} shots)`
    : `Carry ${p.carry} yd (your saved yardage)`);
  if (p.side != null && Math.abs(p.side) >= 5) lines.push(`Misses ${Math.round(Math.abs(p.side))} yd ${p.side > 0 ? "right" : "left"} on average: aim at the ${p.side > 0 ? "left" : "right"} half of the green.`);
  else lines.push("Aim at the middle of the green.");
  if (r.below && !adj) lines.push(`${r.below.label} (${r.below.carry}) only gets there if you flush it.`);
  return lines.join("\n");
}

/** Free text goes to Claude when ANTHROPIC_API_KEY is set; otherwise the help text. */
async function coachReply(ctx, userId, text, reply) {
  if (!ctx.env.ANTHROPIC_API_KEY) return reply(`Sorry, I didn't get that.\n\n${HELP_TEXT}`);
  ctx.line.startLoading(userId, 30).catch(e => console.warn("loading animation", e.message));
  return sendCoachAnswer(ctx, await askCoach(ctx, text), reply);
}
