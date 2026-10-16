// Personal programs: versions per user (draft -> proposed -> accepted -> active -> archived), the format
// Claude designs them in, validation, and conversion to the program.json shape the rest of the app uses.
import Anthropic from "@anthropic-ai/sdk";
import { addDays, weekday, fmtDay } from "./dates.js";

const parseJson = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
export const PROGRAM_STATUSES = ["draft", "proposed", "accepted", "active", "archived", "rejected"];

function programFromRow(r) {
  if (!r) return null;
  return { id: r.id, userId: r.user_id, version: r.version, status: r.status, program: parseJson(r.json), summary: r.summary, changes: r.changes, created: r.created, updated: r.updated };
}

export async function activeProgram(db, uid) {
  const base = db.base || db;
  return programFromRow(await base.prepare("SELECT * FROM programs WHERE user_id = ? AND status = 'active' ORDER BY version DESC LIMIT 1").bind(uid).first());
}
export async function latestProgram(db, uid) {
  const base = db.base || db;
  return programFromRow(await base.prepare("SELECT * FROM programs WHERE user_id = ? ORDER BY version DESC LIMIT 1").bind(uid).first());
}
export async function getProgram(db, id) {
  const base = db.base || db;
  return programFromRow(await base.prepare("SELECT * FROM programs WHERE id = ?").bind(id).first());
}
export async function listPrograms(db, uid) {
  const base = db.base || db;
  const { results } = await base.prepare("SELECT id, user_id, version, status, summary, changes, created, updated FROM programs WHERE user_id = ? ORDER BY version DESC").bind(uid).all();
  return results.map(r => ({ id: r.id, version: r.version, status: r.status, summary: r.summary, changes: r.changes, created: r.created, updated: r.updated }));
}

export async function saveProgramVersion(db, uid, program, { status = "proposed", summary = "", changes = "" }, nowIso) {
  const base = db.base || db;
  const last = await base.prepare("SELECT MAX(version) v FROM programs WHERE user_id = ?").bind(uid).first();
  const version = (last && last.v ? last.v : 0) + 1;
  const id = crypto.randomUUID();
  // a new proposal replaces older unaccepted ones
  await base.prepare("UPDATE programs SET status = 'archived', updated = ? WHERE user_id = ? AND status IN ('draft', 'proposed')").bind(nowIso, uid).run();
  await base.prepare("INSERT INTO programs (id, user_id, version, status, json, summary, changes, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, uid, version, status, JSON.stringify(program), summary, changes, nowIso, nowIso).run();
  return { id, version };
}

export async function setProgramStatus(db, id, status, nowIso) {
  if (!PROGRAM_STATUSES.includes(status)) throw new Error(`invalid program status ${status}`);
  const base = db.base || db;
  await base.prepare("UPDATE programs SET status = ?, updated = ? WHERE id = ?").bind(status, nowIso, id).run();
}

/** The Monday a newly activated program starts: today if it is Monday, otherwise the next one. */
export const nextMonday = today => addDays(today, (8 - weekday(today)) % 7);

/** Makes `id` the user's active program, starting on `start`; archives the previous active one. */
export async function activateProgram(db, id, start, today, nowIso) {
  const base = db.base || db;
  const p = await getProgram(base, id);
  if (!p) throw new Error("program not found");
  const program = { ...p.program, start, week0: { ...(p.program.week0 || {}), dates: start === today ? "" : `${fmtDay(today)} - ${fmtDay(addDays(start, -1))}` } };
  await base.batch([
    base.prepare("UPDATE programs SET status = 'archived', updated = ? WHERE user_id = ? AND status = 'active'").bind(nowIso, p.userId),
    base.prepare("UPDATE programs SET status = 'active', json = ?, updated = ? WHERE id = ?").bind(JSON.stringify(program), nowIso, id),
  ]);
  return { ...p, status: "active", program };
}

// ---- the format Claude writes (arrays instead of maps, so it can be a strict JSON schema) --------

const STR = { type: "string" };
const STRS = { type: "array", items: STR };
const INT = { type: "integer" };
const obj = (properties) => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });

export const DESIGN_SCHEMA = obj({
  title: STR,
  summary: { type: "string", description: "Short LINE message (max ~600 characters) describing the plan in the user's language" },
  changes: { type: "string", description: "What changed compared with the previous draft; empty for the first draft" },
  golf: { type: "boolean", description: "true only if the user plays golf and wants golf in the program" },
  week0: obj({ title: STR, items: { ...STRS, description: "Setup tasks before week 1 (doctor check if flagged, equipment, booking...)" } }),
  phases: { type: "array", items: obj({ name: STR, firstWeek: INT, lastWeek: INT, goal: STR, body: STR, golf: STR, habits: STR }) },
  weeks: { type: "array", description: "Exactly 12 weeks, n = 1..12", items: obj({ n: INT, focus: STR, sleep: { type: "string", description: "Bed / wake as HH:MM / HH:MM" }, drinks: { type: "integer", description: "Max drinking nights that week (0-7)" }, tasks: STRS }) },
  template: { type: "array", description: "Exactly 7 days, weekday 0 = Sunday ... 6 = Saturday", items: obj({ weekday: INT, am: STR, amKey: { type: "string", description: "A session key, or \"rest\"" }, pm: STR, pmKey: { type: "string", description: "A session key, or \"rest\"" } }) },
  sessions: { type: "array", items: obj({ key: { type: "string", description: "Short camelCase id, e.g. strA, walk, mob" }, title: STR, time: STR, items: { ...STRS, description: "Exercises as 'Name - sets x reps||english youtube search words'" }, note: STR }) },
  tests: obj({ title: STR, items: STRS }),
  rules: obj({ mind: STRS, money: STRS, food: STRS, course: STRS, sun: STRS }),
});

const SLEEP = /^\d{2}:\d{2} \/ \d{2}:\d{2}$/;

/** Checks a design for the things the app relies on. Returns a list of problems (empty = OK). */
export function validateDesign(d) {
  const errs = [];
  if (!d || typeof d !== "object") return ["not an object"];
  const keys = new Set((d.sessions || []).map(s => s.key));
  if (!Array.isArray(d.sessions) || !d.sessions.length) errs.push("sessions must not be empty");
  for (const s of d.sessions || []) {
    if (!/^[a-zA-Z][a-zA-Z0-9]{0,23}$/.test(s.key || "") || s.key === "rest") errs.push(`session key "${s.key}" must be a short camelCase id (not "rest")`);
    if (!Array.isArray(s.items) || !s.items.length) errs.push(`session ${s.key} has no items`);
  }
  if (keys.size !== (d.sessions || []).length) errs.push("session keys must be unique");
  if (!Array.isArray(d.weeks) || d.weeks.length !== 12) errs.push("weeks must have exactly 12 entries");
  (d.weeks || []).forEach((w, i) => {
    if (w.n !== i + 1) errs.push(`weeks[${i}].n must be ${i + 1}`);
    if (!SLEEP.test(w.sleep || "")) errs.push(`week ${w.n} sleep must look like "23:30 / 07:30"`);
    if (!Number.isInteger(w.drinks) || w.drinks < 0 || w.drinks > 7) errs.push(`week ${w.n} drinks must be 0-7`);
  });
  const days = new Set((d.template || []).map(t => t.weekday));
  if (!Array.isArray(d.template) || d.template.length !== 7 || days.size !== 7 || [...days].some(x => x < 0 || x > 6)) errs.push("template must have one entry for each weekday 0-6");
  for (const t of d.template || []) {
    for (const s of ["amKey", "pmKey"]) if (t[s] !== "rest" && !keys.has(t[s])) errs.push(`template weekday ${t.weekday} ${s} "${t[s]}" is not a session key or "rest"`);
  }
  const covered = new Set();
  for (const p of d.phases || []) {
    if (!(p.firstWeek >= 1 && p.lastWeek <= 12 && p.firstWeek <= p.lastWeek)) errs.push(`phase "${p.name}" weeks must be within 1-12`);
    for (let w = p.firstWeek; w <= p.lastWeek; w++) covered.add(w);
  }
  if (covered.size !== 12) errs.push("phases must cover weeks 1-12");
  return errs;
}

/** Design (arrays) -> program.json shape (maps), ready for dayPlan(). `start` is set on activation. */
export function designToProgram(d, start = null) {
  return {
    title: d.title, summary: d.summary, golf: !!d.golf, start,
    week0: { title: d.week0.title || "Setup week", dates: "", items: d.week0.items || [] },
    phases: d.phases.map(p => ({ name: p.name, weeks: [p.firstWeek, p.lastWeek], goal: p.goal, body: p.body, golf: p.golf, habits: p.habits })),
    weeks: d.weeks.map(w => ({ n: w.n, focus: w.focus, sleep: w.sleep, drinks: w.drinks, tasks: w.tasks })),
    template: Object.fromEntries(d.template.map(t => [String(t.weekday), { am: t.am, amKey: t.amKey, pm: t.pm, pmKey: t.pmKey }])),
    sessions: Object.fromEntries(d.sessions.map(s => [s.key, { title: s.title, time: s.time, items: s.items, ...(s.note ? { note: s.note } : {}) }])),
    tests: d.tests,
    mind: d.rules.mind, money: d.rules.money, food: d.rules.food, course: d.rules.course, sun: d.rules.sun,
  };
}

/** program.json shape -> design arrays (to show Claude the previous draft). */
export function programToDesign(p) {
  return {
    title: p.title || "Road to Scratch", summary: p.summary || "", changes: "", golf: p.golf !== false,
    week0: { title: p.week0.title, items: p.week0.items },
    phases: p.phases.map(x => ({ name: x.name, firstWeek: x.weeks[0], lastWeek: x.weeks[1], goal: x.goal, body: x.body, golf: x.golf, habits: x.habits })),
    weeks: p.weeks.map(w => ({ n: w.n, focus: w.focus, sleep: w.sleep, drinks: w.drinks, tasks: w.tasks })),
    template: Object.entries(p.template).map(([wd, t]) => ({ weekday: Number(wd), am: t.am, amKey: t.amKey, pm: t.pm, pmKey: t.pmKey })),
    sessions: Object.entries(p.sessions).map(([key, s]) => ({ key, title: s.title, time: s.time || "", items: s.items, note: s.note || "" })),
    tests: p.tests || { title: "Benchmarks", items: [] },
    rules: { mind: p.mind || [], money: p.money || [], food: p.food || [], course: p.course || [], sun: p.sun || [] },
  };
}

// ---- designing with Claude ----------------------------------------------------------------------

const DESIGNER = `You design personal 12-week health (and, for golfers, golf) programs for a LINE coaching app in Bangkok.
The program drives daily LINE messages: a morning plan (AM and PM session for the weekday), a 21:30 check-in on five habits
(woke on time, did the planned session, 10 min mobility, screens off on time, no alcohol), and a weekly summary.

Design rules:
- Fit the person's goals, schedule, equipment, current activity level and preferences. Be realistic: a plan they will follow
  beats an ideal one. Use "rest" for slots with nothing planned.
- Safety first. If the health screening has any flag (heart, chest pain, dizziness, joints, blood pressure, pregnancy,
  conditions like gout or diabetes), keep intensity conservative, put "see your doctor before starting" in week 0, and
  build up slowly. Never prescribe medication. Pain means stop and check.
- Progress across three phases. Sleep targets move gradually (about 15 minutes per week) toward a healthy routine; drinking
  limits come down gradually from their current level.
- Sessions list concrete exercises with sets/reps or minutes. Add English YouTube search words after "||" for anything that
  needs a demonstration (e.g. "Goblet squat - 3 x 10||goblet squat proper form").
- Golf content only if golf is true. Rules lists may be empty when not relevant.
- Write all text (titles, items, summary) in the user's language; keep session keys and search words in English.
- The example program shows the expected format and level of detail; it belongs to a different person.`;

export async function designProgram(ctx, { user, profile, conversation, previous, feedback, example }) {
  const client = new Anthropic({ apiKey: ctx.env.ANTHROPIC_API_KEY, maxRetries: 2, ...(ctx.fetch ? { fetch: ctx.fetch } : {}) });
  const input = {
    person: { name: user.name, language: user.lang === "th" ? "Thai" : "English", golfer: user.golfer },
    questionnaire: profile.answers, healthFlags: profile.flags, coachNotes: profile.notes,
    onboardingConversation: conversation,
    previousDraft: previous ? programToDesign(previous) : null,
    requestedChanges: feedback || null,
  };
  const messages = [{ role: "user", content: `EXAMPLE PROGRAM (format reference only):\n${JSON.stringify(programToDesign(example))}\n\nDESIGN FOR THIS PERSON:\n${JSON.stringify(input)}` }];
  for (let attempt = 0; attempt < 2; attempt++) {
    const stream = client.beta.messages.stream({
      model: "claude-opus-5-5", max_tokens: 32000,
      betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
      output_config: { effort: "high", format: { type: "json_schema", schema: DESIGN_SCHEMA } },
      system: DESIGNER, messages,
    });
    const res = await stream.finalMessage();
    console.log("design usage", JSON.stringify(res.usage));
    if (res.stop_reason === "refusal") throw new Error("Claude declined to design this program");
    if (res.stop_reason === "max_tokens") throw new Error("program design was cut off");
    const text = res.content.filter(b => b.type === "text").map(b => b.text).join("");
    const design = JSON.parse(text);
    const errs = validateDesign(design);
    if (!errs.length) return { design, program: designToProgram(design), usage: res.usage };
    messages.push({ role: "assistant", content: res.content }, { role: "user", content: `Fix these problems and return the whole program again:\n- ${errs.join("\n- ")}` });
  }
  throw new Error("the program design did not pass validation");
}

/** LINE message offering a proposed program: summary + Accept / Change buttons. */
export function proposalMessage(lang, summary, programId, dashboardUrl) {
  const th = lang === "th";
  const text = `${summary}\n\n${th ? "ดูแผนเต็มได้ที่" : "Full plan:"} ${dashboardUrl || (th ? "แดชบอร์ด" : "your dashboard")}\n${th ? "พิมพ์บอกได้เลยถ้าอยากเปลี่ยนอะไร" : "Tell me anything you'd like to change, or tap Accept."}`;
  return {
    type: "text", text: text.slice(0, 4900),
    quickReply: { items: [
      { type: "action", action: { type: "postback", label: th ? "ยอมรับแผนนี้" : "Accept", data: `prog:accept:${programId}`, displayText: th ? "ยอมรับแผนนี้" : "Accept" } },
      { type: "action", action: { type: "postback", label: th ? "ขอแก้ไข" : "Change something", data: `prog:change:${programId}`, displayText: th ? "ขอแก้ไข" : "Change something" } },
    ] },
  };
}
