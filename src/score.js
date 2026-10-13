// Guided round entry ("score"): one question at a time, typed numbers or quick-reply buttons.
// Postback data format: "sc:<field>:<value>". Pure functions; the webhook stores state in `convo`.
import { addDays, fmtDay } from "./dates.js";

const SKIP = ["Skip", "skip"];
const counts = n => Array.from({ length: n + 1 }, (_, i) => [String(i), String(i)]);

export const SCORE_QUESTIONS = [
  { field: "date", text: "Which day was the round?", options: [["Today", "today"], ["Yesterday", "yesterday"]] },
  { field: "course", text: "Course? Type the name, or tap Skip.", input: "text", options: [SKIP] },
  { field: "front", text: "Front 9 score? Type a number, e.g. 42.", input: "number", min: 25, max: 90, required: true },
  { field: "back", text: "Back 9 score?", input: "number", min: 25, max: 90, required: true },
  { field: "putts", text: "Total putts? Type a number, or tap Skip.", input: "number", min: 0, max: 60, options: [SKIP] },
  { field: "fw", text: "Fairways hit (of 14)?", input: "number", min: 0, max: 14, options: [SKIP] },
  { field: "gir", text: "Greens in regulation (of 18)?", input: "number", min: 0, max: 18, options: [SKIP] },
  { field: "penalties", text: "Penalty strokes?", input: "number", min: 0, max: 18, options: [...counts(4), SKIP] },
  { field: "doubles", text: "Double bogeys or worse?", input: "number", min: 0, max: 18, options: [...counts(5), SKIP] },
  { field: "apShort", text: "Approach shots that finished short of the green?", input: "number", min: 0, max: 18, options: [...counts(5), SKIP] },
  { field: "apLong", text: "Approach shots that finished long?", input: "number", min: 0, max: 18, options: [...counts(5), SKIP] },
  { field: "money", text: "Money won or lost? Type e.g. -5000 or 2000.", input: "number", min: -10_000_000, max: 10_000_000, options: [["0", "0"], SKIP] },
  { field: "mind", text: "Mind and focus today (1 = poor, 5 = great)?", input: "number", min: 1, max: 5, options: [...counts(5).slice(1), SKIP] },
  { field: "note", text: "Comment? Type anything, or tap Skip.", input: "text", options: [SKIP] },
];

const BY_FIELD = Object.fromEntries(SCORE_QUESTIONS.map((q, i) => [q.field, { ...q, index: i }]));

export function newScoreState(today) {
  return { flow: "score", step: 0, draft: { _today: today } };
}

export function nextScoreQuestion(state) {
  return SCORE_QUESTIONS.find(q => !(q.field in state.draft)) || null;
}

/** Turns a typed or tapped answer into a stored value (null = skipped). Returns { value } or { error }. */
export function parseScoreAnswer(field, raw, draft) {
  const q = BY_FIELD[field];
  if (!q) return { error: "Unknown question." };
  const s = String(raw ?? "").trim();
  if (s.toLowerCase() === "skip") {
    return q.required || field === "date" ? { error: "This one is needed." } : { value: null };
  }
  if (field === "date") {
    if (s === "today") return { value: draft._today };
    if (s === "yesterday") return { value: addDays(draft._today, -1) };
    return { error: "Tap Today or Yesterday." };
  }
  if (q.input === "text") return { value: s.slice(0, field === "note" ? 1000 : 100) };
  const t = s.replace(/,/g, "").replace(/^\+/, "");
  if (!/^-?\d+$/.test(t)) return { error: `Please type a whole number${q.required ? "" : ", or tap Skip"}.` };
  const v = Number(t);
  if (v < q.min || v > q.max) return { error: `That should be between ${q.min} and ${q.max}.` };
  return { value: v };
}

/** "sc:penalties:2" -> { field, raw } ; anything else -> null. Values are checked by parseScoreAnswer. */
export function parseScorePostback(data) {
  const m = /^sc:([A-Za-z]+):(.+)$/.exec(String(data || ""));
  if (!m || !BY_FIELD[m[1]]) return null;
  if (!BY_FIELD[m[1]].options?.some(([, v]) => v === m[2])) return null;
  return { field: m[1], raw: m[2] };
}

/**
 * Records one answer for `field` (taps from older messages are accepted for their own field).
 * Returns { state, done, next } or { error, next } when the answer is not valid.
 */
export function applyScoreAnswer(state, field, raw) {
  const parsed = parseScoreAnswer(field, raw, state.draft);
  if (parsed.error) return { error: parsed.error, state, next: BY_FIELD[field] };
  const draft = { ...state.draft, [field]: parsed.value };
  const next = SCORE_QUESTIONS.find(q => !(q.field in draft)) || null;
  return { state: { ...state, draft, step: next ? BY_FIELD[next.field].index : SCORE_QUESTIONS.length }, done: !next, next };
}

export function scoreQuestionMessage(q, prefix = "") {
  const n = BY_FIELD[q.field].index + 1;
  const msg = { type: "text", text: `${prefix}Round ${n}/${SCORE_QUESTIONS.length} · ${q.text}` };
  if (q.options && q.options.length) {
    msg.quickReply = {
      items: q.options.map(([label, value]) => ({
        type: "action",
        action: { type: "postback", label, data: `sc:${q.field}:${value}`, displayText: label },
      })),
    };
  }
  return msg;
}

/** Draft -> rounds document (skipped answers are left out). */
export function toRoundDoc(draft, nowIso) {
  const doc = { created: nowIso };
  for (const q of SCORE_QUESTIONS) {
    const v = draft[q.field];
    if (v != null && v !== "") doc[q.field] = v;
  }
  return doc;
}

export function roundSummary(doc) {
  const bits = [`Round saved for ${fmtDay(doc.date)}${doc.course ? ` at ${doc.course}` : ""}: ${doc.front + doc.back} (${doc.front}/${doc.back})`];
  if (doc.putts != null) bits.push(`${doc.putts} putts`);
  if (doc.fw != null) bits.push(`${doc.fw}/14 fairways`);
  if (doc.gir != null) bits.push(`${doc.gir}/18 GIR`);
  if (doc.penalties != null) bits.push(`${doc.penalties} pen`);
  if (doc.doubles != null) bits.push(`${doc.doubles} dbl+`);
  if (doc.money != null) bits.push(`money ${doc.money.toLocaleString("en-US")}`);
  return bits.join(" · ");
}
