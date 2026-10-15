// "Ask the coach": free-text LINE messages answered by Claude, with tools to read and update the tracker.
//
// History rules (Opus 5.5 preserved thinking): within one question the assistant turns, including their
// thinking blocks, are appended verbatim to `messages`. Across questions only plain text is remembered
// (the last 6 messages), so dropping old messages never edits a turn that carries thinking.
import Anthropic from "@anthropic-ai/sdk";
import { listDocs, getDoc, putDoc, getSetting, setSetting } from "./db.js";
import { dayPlan, fullPlanText } from "./program.js";
import { addDays, isYmd, mondayOf, weekOf, weekday, fmtDay } from "./dates.js";
import { rangeStats } from "./context.js";
import { getSc4 } from "./sc4store.js";
import { clubOptions, pickClub } from "./sc4.js";

const MODEL = "claude-opus-5-5";
const MEMORY_KEY = "chat_memory";
const COUNT_KEY = "chat_count";
export const MEMORY_SIZE = 6;
const MAX_ROUNDS = 6; // model calls per question (tool loop)
const TIME_BUDGET_MS = 24_000; // Workers keep a request alive ~30 s after the webhook has answered LINE

const STATIC_PROMPT = `You are Supawat's golf and health coach inside LINE, part of the "Road to Scratch" program
(12 weeks, Bangkok). You know the program below and you can read and update his tracker with the tools.

How to answer:
- Reply in the language he writes in (Thai or English). This is a chat app: plain text, no markdown headings or tables,
  short paragraphs or "-" lists, usually under 120 words unless he asks for detail.
- Base advice on his data. Use the tools when the context below is not enough; don't guess numbers.
- Follow the program rules (never miss twice, 20-minute version on bad days, drinking-night limits, round-day protocol,
  sleep targets, gout/uric-acid care, sun protection).
- Health: give general guidance only. For medication, uric-acid treatment, pain or injury, tell him to check with his doctor.

Taking actions:
- When he asks you to log or change something, call the matching tool, then say exactly what was saved (date and values).
- If a value is unclear (which day, which number), ask instead of guessing. Never invent data.
- You cannot delete anything; point him to the dashboard for deletions.

Data notes: carry in yards, speeds in mph, SC4 side: + right / - left. Check-in fields: woke, trained (1 yes, 2 = 20-min
version, 0 no), mobility, screens (screens off on time), drinks, practice (minutes), water (litres), energy (1-5).`;

// ---- tools -------------------------------------------------------------------------------------

const S = (type, description, extra = {}) => ({ type, description, ...extra });
const DATE = S("string", "YYYY-MM-DD (Bangkok). Defaults to today.");

export const TOOLS = [
  {
    name: "get_records",
    description: "Read tracker records: daily check-ins, golf rounds, benchmark tests, body log or coach notes, newest first.",
    input_schema: { type: "object", properties: {
      collection: S("string", "Which records", { enum: ["daily", "rounds", "tests", "body", "coach"] }),
      since: S("string", "First date, YYYY-MM-DD"), until: S("string", "Last date, YYYY-MM-DD"),
      limit: S("integer", "Max records (default 30)"),
    }, required: ["collection"] },
  },
  {
    name: "get_day_plan",
    description: "The planned sessions (with exercises and video links), focus, sleep targets and drink limit for one date.",
    input_schema: { type: "object", properties: { date: DATE }, required: [] },
  },
  {
    name: "get_sc4_stats",
    description: "SC4 launch-monitor analysis: yardage per club (average ± SD after removing outliers), gaps, insights, recent practice sessions.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "find_club",
    description: "Pick a club for a distance to the middle of the green, from SC4 and saved yardages.",
    input_schema: { type: "object", properties: {
      distance: S("integer", "Yards to the middle of the green"),
      adjust: S("integer", "Clubs to add for conditions: 1 into wind/uphill, 2 strong wind, -1 downwind/downhill", { enum: [-1, 0, 1, 2] }),
    }, required: ["distance"] },
  },
  {
    name: "log_checkin",
    description: "Save or update a daily check-in. Only the fields given are changed; others keep their saved values.",
    input_schema: { type: "object", properties: {
      date: DATE,
      woke: S("integer", "Woke on time: 1 yes, 0 no", { enum: [0, 1] }),
      trained: S("integer", "Planned session: 1 yes, 2 the 20-minute version, 0 no", { enum: [0, 1, 2] }),
      mobility: S("integer", "Mobility 10 min: 1 yes, 0 no", { enum: [0, 1] }),
      screens: S("integer", "Screens off on time last night: 1 yes, 0 no", { enum: [0, 1] }),
      drinks: S("integer", "Alcoholic drinks (0-30)"), practice: S("integer", "Golf practice minutes (0-600)"),
      water: S("number", "Water in litres (0-10)"), energy: S("integer", "Energy 1-5"), note: S("string", "Note"),
    }, required: [] },
  },
  {
    name: "log_body",
    description: "Save a body / health entry (weight, waist, uric acid, gout flare).",
    input_schema: { type: "object", properties: {
      date: DATE, weight: S("number", "kg"), waist: S("number", "cm"), uric: S("number", "mg/dL"),
      flare: S("boolean", "Gout flare"), note: S("string", "Note"),
    }, required: [] },
  },
  {
    name: "log_round",
    description: "Save a golf round. front and back are the 9-hole scores; everything else is optional.",
    input_schema: { type: "object", properties: {
      date: DATE, course: S("string", "Course name"), front: S("integer", "Front 9 score"), back: S("integer", "Back 9 score"),
      putts: S("integer", "Total putts"), fw: S("integer", "Fairways hit of 14"), gir: S("integer", "Greens in regulation of 18"),
      penalties: S("integer", "Penalty strokes"), doubles: S("integer", "Double bogeys or worse"),
      apShort: S("integer", "Approaches short of the green"), apLong: S("integer", "Approaches long"),
      money: S("integer", "Money won (+) or lost (-) in baht"), mind: S("integer", "Mind/focus 1-5"), note: S("string", "Note"),
    }, required: ["front", "back"] },
  },
  {
    name: "change_day_plan",
    description: "Change the sessions planned for one date (e.g. move the gym session to the evening, or rest). Use session keys from the program's sessions, or \"rest\". Give only the slot(s) to change. The change shows in LINE plans and on the dashboard.",
    input_schema: { type: "object", properties: {
      date: DATE, am: S("string", "Session key for the morning slot, or \"rest\""), pm: S("string", "Session key for the evening slot, or \"rest\""),
    }, required: ["date"] },
  },
];

const clamp = (v, lo, hi, int = false) => {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi || (int && !Number.isInteger(n))) throw new Error(`value ${v} is out of range (${lo}-${hi})`);
  return n;
};
const dateOr = (ctx, d) => {
  if (d === undefined || d === null || d === "") return ctx.today();
  if (!isYmd(d)) throw new Error(`date "${d}" must be YYYY-MM-DD`);
  return d;
};
const text = (v, n) => (v == null ? undefined : String(v).slice(0, n));
const compact = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ""));

/** Runs one tool call. Returns { result, action? } - `action` is a short description for the log. */
export async function runTool(ctx, name, input = {}) {
  const db = ctx.db;
  switch (name) {
    case "get_records": {
      const coll = input.collection;
      if (!["daily", "rounds", "tests", "body", "coach"].includes(coll)) throw new Error("unknown collection");
      if ((input.since && !isYmd(input.since)) || (input.until && !isYmd(input.until))) throw new Error("dates must be YYYY-MM-DD");
      const limit = Math.min(Math.max(Number(input.limit) || 30, 1), 200);
      const docs = await listDocs(db, coll, { since: input.since, until: input.until, limit });
      return { result: docs.map(d => compact({ ...d, created: undefined, updated: undefined })) };
    }
    case "get_day_plan": {
      const date = dateOr(ctx, input.date);
      return { result: fullPlanText(dayPlan(await ctx.program(), date)).join("\n\n") };
    }
    case "get_sc4_stats": {
      const s = await getSc4(ctx);
      if (!s.totalShots) return { result: "No SC4 data uploaded yet." };
      return { result: { shots: s.totalShots, from: s.firstDate, to: s.lastDate, clubs: s.clubs, gaps: s.gaps, insights: s.insights.map(i => i.text), sessions: s.sessions.slice(-30) } };
    }
    case "find_club": {
      const d = clamp(input.distance, 10, 400, true), adj = clamp(input.adjust ?? 0, -1, 2, true);
      const [s, y] = await Promise.all([getSc4(ctx), getSetting(db, "yardages")]);
      const r = pickClub(clubOptions(s.clubs, (y && y.clubs) || {}), d, adj);
      return { result: r.pick ? { club: r.pick.label, carry: r.pick.carry, usual: r.pick.lo != null ? `${r.pick.lo}-${r.pick.hi}` : null, avgSide: r.pick.side ?? null, source: r.pick.source, nextShorter: r.below ? `${r.below.label} ${r.below.carry}` : null } : { none: r.reason } };
    }
    case "log_checkin": {
      const date = dateOr(ctx, input.date);
      const prev = (await getDoc(db, "daily", date)) || {};
      const upd = compact({
        woke: clamp(input.woke, 0, 1, true), trained: clamp(input.trained, 0, 2, true), mobility: clamp(input.mobility, 0, 1, true),
        screens: clamp(input.screens, 0, 1, true), drinks: clamp(input.drinks, 0, 30, true), practice: clamp(input.practice, 0, 600, true),
        water: clamp(input.water, 0, 10), energy: clamp(input.energy, 1, 5, true), note: text(input.note, 1000),
      });
      if (!Object.keys(upd).length) throw new Error("nothing to save");
      const program = await ctx.program();
      const row = { ...prev, ...upd, date, week: weekOf(date, program.start), updated: ctx.now().toISOString() };
      delete row.id;
      await putDoc(db, "daily", date, row);
      return { result: { saved: { date, ...upd } }, action: `check-in ${date}: ${JSON.stringify(upd)}` };
    }
    case "log_body": {
      const date = dateOr(ctx, input.date);
      const doc = compact({
        weight: clamp(input.weight, 30, 250), waist: clamp(input.waist, 40, 200), uric: clamp(input.uric, 0.5, 20),
        flare: input.flare === undefined ? undefined : !!input.flare, note: text(input.note, 300),
      });
      if (doc.weight == null && doc.waist == null && doc.uric == null && !doc.flare) throw new Error("nothing to save");
      await putDoc(db, "body", crypto.randomUUID(), { ...doc, date, created: ctx.now().toISOString() });
      return { result: { saved: { date, ...doc } }, action: `body ${date}: ${JSON.stringify(doc)}` };
    }
    case "log_round": {
      const date = dateOr(ctx, input.date);
      const doc = compact({
        course: text(input.course, 100), front: clamp(input.front, 25, 90, true), back: clamp(input.back, 25, 90, true),
        putts: clamp(input.putts, 0, 60, true), fw: clamp(input.fw, 0, 14, true), gir: clamp(input.gir, 0, 18, true),
        penalties: clamp(input.penalties, 0, 18, true), doubles: clamp(input.doubles, 0, 18, true),
        apShort: clamp(input.apShort, 0, 18, true), apLong: clamp(input.apLong, 0, 18, true),
        money: clamp(input.money, -10_000_000, 10_000_000, true), mind: clamp(input.mind, 1, 5, true), note: text(input.note, 1000),
      });
      if (doc.front == null || doc.back == null) throw new Error("front and back scores are required");
      await putDoc(db, "rounds", crypto.randomUUID(), { ...doc, date, created: ctx.now().toISOString() });
      return { result: { saved: { date, ...doc, total: doc.front + doc.back } }, action: `round ${date}: ${doc.front + doc.back}` };
    }
    case "change_day_plan": {
      const date = dateOr(ctx, input.date);
      if (date < ctx.today()) throw new Error("only today or future dates can be changed");
      const program = await ctx.program();
      const slot = {};
      for (const s of ["am", "pm"]) {
        const key = input[s];
        if (key === undefined || key === null || key === "") continue;
        if (key !== "rest" && !program.sessions[key]) throw new Error(`unknown session "${key}". Keys: ${Object.keys(program.sessions).join(", ")}, rest`);
        slot[s + "Key"] = key;
      }
      if (!Object.keys(slot).length) throw new Error("give am and/or pm");
      const ov = (await getSetting(ctx.db, "program_overrides")) || {};
      const days = { ...(ov.days || {}) };
      days[date] = { ...(days[date] || {}), ...slot };
      for (const d of Object.keys(days)) if (d < addDays(ctx.today(), -14)) delete days[d]; // keep the list short
      await setSetting(ctx.db, "program_overrides", { ...ov, days, updated: ctx.now().toISOString() });
      ctx._program = null; // reload with the change
      const p = dayPlan(await ctx.program(), date);
      return { result: { date, am: p.am.label, pm: p.pm.label }, action: `plan ${date}: AM ${p.am.label} / PM ${p.pm.label}` };
    }
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

// ---- context ------------------------------------------------------------------------------------

/** Stable, cacheable part of the system prompt: instructions + the full program. */
export function staticSystem(program) {
  return `${STATIC_PROMPT}\n\nPROGRAM (program.json; "||" in an item separates the YouTube search words):\n${JSON.stringify(program)}`;
}

/** Changing part: today's plan and recent data. Built fresh for every question. */
export async function contextText(ctx) {
  const program = await ctx.program();
  const today = ctx.today();
  const plan = dayPlan(program, today);
  const mon = mondayOf(today);
  const [daily, rounds, body, sc4] = await Promise.all([
    listDocs(ctx.db, "daily", { since: addDays(today, -13), until: today }),
    listDocs(ctx.db, "rounds", { limit: 5 }),
    listDocs(ctx.db, "body", { limit: 3 }),
    getSc4(ctx).catch(() => null),
  ]);
  const week = rangeStats(daily, rounds, mon, today);
  const strip = o => compact({ ...o, id: undefined, created: undefined, updated: undefined, week: undefined });
  const lines = [
    `Now: ${fmtDay(today)} ${today}, ${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][weekday(today)]} (Bangkok).`,
    `Program week ${plan.week}${plan.phase ? ` (${plan.phase.name})` : ""}. Focus: ${plan.focus}.`,
    `Today: AM ${plan.am.label} | PM ${plan.pm.label}. Bed ${plan.sleep.bed}, wake ${plan.sleep.wake}, screens off ${plan.screensOff}. Max drinking nights this week: ${plan.drinkLimit}.`,
    `This week so far: habits ${week.habitPct}%, logged ${week.logged} days, workouts ${week.workouts}, drinking nights ${week.drinkNights}, practice ${week.practiceMin} min.`,
    `Check-ins, last 14 days: ${JSON.stringify(daily.map(strip))}`,
    `Latest rounds: ${JSON.stringify(rounds.map(strip))}`,
    `Latest body entries: ${JSON.stringify(body.map(strip))}`,
  ];
  if (sc4 && sc4.totalShots) {
    lines.push(`SC4 yardages (avg ± SD, last 40 shots): ${sc4.clubs.map(c => `${c.club}${c.swing === "full" ? "" : " 3/4"} ${c.carry}±${c.carrySd ?? "?"} side ${c.side}`).join("; ")}`);
    lines.push(`SC4 insights: ${sc4.insights.map(i => i.text).join(" | ")}`);
  }
  return lines.join("\n");
}

// ---- memory and limits --------------------------------------------------------------------------

/** Last MEMORY_SIZE text messages, starting with a user message. */
export function trimMemory(messages, size = MEMORY_SIZE) {
  let m = messages.slice(-size);
  while (m.length && m[0].role !== "user") m = m.slice(1);
  return m;
}

export const clearMemory = ctx => setSetting(ctx.db, MEMORY_KEY, { messages: [] });

async function underDailyLimit(ctx) {
  const limit = Number(ctx.env.CHAT_DAILY_LIMIT || 30);
  const day = ctx.today();
  const c = (await getSetting(ctx.db, COUNT_KEY)) || {};
  const n = c.day === day ? c.count || 0 : 0;
  if (n >= limit) return false;
  await setSetting(ctx.db, COUNT_KEY, { day, count: n + 1 });
  return true;
}

// ---- the conversation ---------------------------------------------------------------------------

/**
 * Answers one LINE message. Returns { text, actions }. Never throws for API problems - those become
 * a short apology so the user always gets a reply.
 */
export async function askCoach(ctx, question) {
  if (!(await underDailyLimit(ctx))) return { text: `Daily limit of ${ctx.env.CHAT_DAILY_LIMIT || 30} coach questions reached. Ask again tomorrow, or use the commands (help).`, actions: [] };
  const started = Date.now();
  const client = new Anthropic({ apiKey: ctx.env.ANTHROPIC_API_KEY, timeout: 20_000, maxRetries: 1, ...(ctx.fetch ? { fetch: ctx.fetch } : {}) });
  const memory = trimMemory(((await getSetting(ctx.db, MEMORY_KEY)) || {}).messages || []);
  const program = await ctx.program();
  const system = [
    { type: "text", text: staticSystem(program), cache_control: { type: "ephemeral" } },
    { type: "text", text: `CURRENT DATA\n${await contextText(ctx)}` },
  ];
  const messages = [...memory.map(m => ({ role: m.role, content: m.text })), { role: "user", content: question }];
  const actions = [];
  let answer = null;

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      if (Date.now() - started > TIME_BUDGET_MS) break;
      const res = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 4000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "low" }, // chat: quick, consolidated answers
        system,
        tools: TOOLS,
        messages,
      });
      console.log("coach usage", JSON.stringify(res.usage));
      if (res.stop_reason === "refusal") { answer = "Sorry, I can't help with that one. Try asking another way."; break; }
      const said = res.content.filter(b => b.type === "text").map(b => b.text).join("").trim();
      if (res.stop_reason === "tool_use") {
        messages.push({ role: "assistant", content: res.content }); // verbatim, thinking blocks included
        const results = [];
        for (const b of res.content.filter(x => x.type === "tool_use")) {
          try {
            const { result, action } = await runTool(ctx, b.name, b.input);
            if (action) actions.push(action);
            results.push({ type: "tool_result", tool_use_id: b.id, content: typeof result === "string" ? result : JSON.stringify(result) });
          } catch (e) {
            results.push({ type: "tool_result", tool_use_id: b.id, content: `Error: ${e.message}`, is_error: true });
          }
        }
        messages.push({ role: "user", content: results });
        continue;
      }
      if (res.stop_reason === "pause_turn") { messages.push({ role: "assistant", content: res.content }); continue; }
      answer = said || (res.stop_reason === "max_tokens" ? "That answer got too long. Ask me something narrower." : "");
      break;
    }
  } catch (e) {
    console.error("coach failed", e && e.status, e && e.message);
    if (e instanceof Anthropic.RateLimitError) answer = "The coach is busy right now. Try again in a minute.";
    else if (e instanceof Anthropic.AuthenticationError) answer = "The coach isn't set up: check the ANTHROPIC_API_KEY secret in Cloudflare.";
    else if (e instanceof Anthropic.APIError) answer = "Sorry, I couldn't reach the coach just now. Try again in a minute.";
    else throw e;
  }
  if (!answer) answer = actions.length ? "Done." : "That took too long. Please ask again, maybe in a shorter way.";
  if (actions.length && !/sav|log|บันทึก|changed|moved|updated/i.test(answer)) answer += `\n\n(Saved: ${actions.join("; ")})`;

  const remembered = trimMemory([...memory, { role: "user", text: question.slice(0, 2000) }, { role: "assistant", text: answer.slice(0, 2000) }]);
  await setSetting(ctx.db, MEMORY_KEY, { messages: remembered, updated: ctx.now().toISOString() });
  return { text: answer, actions };
}
