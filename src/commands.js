// Parsers for the quick-log text commands. They never guess: anything unclear returns an error
// so the bot can ask again.

export const ROUND_USAGE = "round 42 45 putts 33 pen 1 dbl 2 short 4 long 0 money -5000\n(front, back, then any of: putts pen dbl short long money fw gir 3p mind sleep drinks)";
export const BODY_USAGE = "body 80 82  (weight kg, waist cm; optional: uric 7.1, flare)";

const ROUND_KEYS = {
  putts: ["putts", 0, 60], putt: ["putts", 0, 60],
  pen: ["penalties", 0, 18], penalties: ["penalties", 0, 18],
  dbl: ["doubles", 0, 18], doubles: ["doubles", 0, 18],
  short: ["apShort", 0, 18], long: ["apLong", 0, 18],
  money: ["money", -10_000_000, 10_000_000],
  fw: ["fw", 0, 14], gir: ["gir", 0, 18],
  "3p": ["threePutts", 0, 18], "3putts": ["threePutts", 0, 18], threeputts: ["threePutts", 0, 18],
  mind: ["mind", 1, 5], sleep: ["sleep", 0, 14], drinks: ["drinks", 0, 30],
};
const INT_FIELDS = new Set(["putts", "penalties", "doubles", "apShort", "apLong", "money", "fw", "gir", "threePutts", "mind", "drinks"]);

function num(s) {
  const t = String(s).replace(/,/g, "");
  if (!/^[+-]?\d+(\.\d+)?$/.test(t)) return null;
  return Number(t);
}

/** "round 42 45 putts 33 ..." -> { ok, round } | { ok: false, error } */
export function parseRound(text) {
  const tokens = text.trim().split(/\s+/).slice(1);
  const front = num(tokens[0]), back = num(tokens[1]);
  const nine = v => Number.isInteger(v) && v >= 25 && v <= 90;
  if (!nine(front) || !nine(back)) {
    return { ok: false, error: `I need the front-nine and back-nine scores first.\nExample: ${ROUND_USAGE}` };
  }
  const round = { front, back };
  for (let i = 2; i < tokens.length; i += 2) {
    const key = tokens[i].toLowerCase();
    const spec = ROUND_KEYS[key];
    if (!spec) return { ok: false, error: `I don't know "${tokens[i]}". Nothing saved.\nExample: ${ROUND_USAGE}` };
    const [field, lo, hi] = spec;
    if (field in round) return { ok: false, error: `"${key}" appears twice. Nothing saved.` };
    const v = num(tokens[i + 1]);
    if (v == null || v < lo || v > hi || (INT_FIELDS.has(field) && !Number.isInteger(v))) {
      return { ok: false, error: `"${key}" needs a number${tokens[i + 1] ? `, not "${tokens[i + 1]}"` : ""}. Nothing saved.` };
    }
    round[field] = v;
  }
  return { ok: true, round };
}

/** "body 80 82 uric 7.1 flare" -> { ok, body } | { ok: false, error } */
export function parseBody(text) {
  const tokens = text.trim().split(/\s+/).slice(1);
  const weight = num(tokens[0]);
  if (weight == null || weight < 30 || weight > 250) return { ok: false, error: `I need your weight in kg first.\nExample: ${BODY_USAGE}` };
  const body = { weight, flare: false };
  let i = 1;
  if (tokens[i] != null && num(tokens[i]) != null) {
    const waist = num(tokens[i]);
    if (waist < 40 || waist > 200) return { ok: false, error: `Waist ${tokens[i]} cm looks wrong. Nothing saved.` };
    body.waist = waist; i++;
  }
  for (; i < tokens.length; i++) {
    const k = tokens[i].toLowerCase();
    if (k === "flare") { body.flare = true; continue; }
    if (k === "uric") {
      const v = num(tokens[i + 1]);
      if (v == null || v <= 0 || v > 20) return { ok: false, error: "uric needs a value in mg/dL, e.g. uric 7.1. Nothing saved." };
      body.uric = v; i++; continue;
    }
    return { ok: false, error: `I don't know "${tokens[i]}". Nothing saved.\nExample: ${BODY_USAGE}` };
  }
  return { ok: true, body };
}

export const HELP_TEXT = [
  "Commands:",
  "today - full plan with video links",
  "plan - this week",
  "checkin - tonight's check-in",
  "score - log a round, question by question",
  "club 145 - which club for 145 yd (+1 into wind)",
  "body 80 82 - log weight (kg) and waist (cm)",
  "dashboard - link to the tracker",
  "quota - push messages used this month",
  "cancel - stop a check-in or round entry",
  "help - this list",
].join("\n");
