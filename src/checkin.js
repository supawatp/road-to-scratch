// Evening check-in state machine (spec section 9). Pure functions: no I/O, easy to test.
// Postback data format: "ci:<field>:<value>". State is stored in the `convo` table between taps.

const yn = [["Yes", "1"], ["No", "0"]];

export const QUESTIONS = [
  { field: "woke", text: "Woke on time?", options: yn },
  { field: "trained", text: "Did the planned session?", options: [["Yes", "1"], ["20-min version", "2"], ["No", "0"]] },
  { field: "mobility", text: "Mobility 10 min?", options: yn },
  { field: "screens", text: "Screens off on time last night?", options: yn },
  { field: "drinks", text: "Drinks today?", options: [["0", "0"], ["1", "1"], ["2", "2"], ["3", "3"], ["4+", "4"]] },
  { field: "practice", text: "Golf practice?", options: [["0", "0"], ["30 min", "30"], ["60 min", "60"], ["90 min", "90"]] },
  { field: "water", text: "Water?", options: [["1 L", "1"], ["2 L", "2"], ["2.5 L", "2.5"], ["3+ L", "3"]] },
  { field: "energy", text: "Energy today?", options: [["1", "1"], ["2", "2"], ["3", "3"], ["4", "4"], ["5", "5"]] },
  { field: "note", text: "Note? Type anything, or tap Skip.", options: [["Skip", "skip"]] },
];

const BY_FIELD = Object.fromEntries(QUESTIONS.map((q, i) => [q.field, { ...q, index: i }]));

/** "ci:drinks:4" -> { field: "drinks", value: 4 }; anything unknown -> null. */
export function parsePostback(data) {
  const m = /^ci:([a-z]+):(.+)$/.exec(String(data || ""));
  if (!m) return null;
  const q = BY_FIELD[m[1]];
  if (!q || !q.options.some(([, v]) => v === m[2])) return null;
  if (q.field === "note") return { field: "note", value: "" };
  return { field: q.field, value: Number(m[2]) };
}

export function newState(date) {
  return { flow: "checkin", step: 0, draft: { date } };
}

/** The first question not answered yet, or null when the check-in is complete. */
export function nextQuestion(state) {
  return QUESTIONS.find(q => !(q.field in state.draft)) || null;
}

/**
 * Records one answer. Taps can arrive out of order (an old button, a double tap):
 * the answer is stored for its own field and we continue with the first unanswered question.
 */
export function applyAnswer(state, field, value) {
  if (!BY_FIELD[field]) throw new Error("unknown field " + field);
  const draft = { ...state.draft, [field]: field === "note" ? String(value ?? "").trim().slice(0, 1000) : value };
  const next = QUESTIONS.find(q => !(q.field in draft)) || null;
  const s = { ...state, draft, step: next ? BY_FIELD[next.field].index : QUESTIONS.length };
  return { state: s, done: !next, next };
}

/** True when the conversation is waiting for a free-text note. */
export const awaitingNote = state => !!state && state.flow === "checkin" && nextQuestion(state)?.field === "note";

export function questionMessage(q, prefix = "") {
  const n = BY_FIELD[q.field].index + 1;
  return {
    type: "text",
    text: `${prefix}${n}/${QUESTIONS.length} · ${q.text}`,
    quickReply: {
      items: q.options.map(([label, value]) => ({
        type: "action",
        action: { type: "postback", label, data: `ci:${q.field}:${value}`, displayText: label },
      })),
    },
  };
}

export function toDailyRow(draft, week, nowIso) {
  return {
    date: draft.date, woke: draft.woke, trained: draft.trained, mobility: draft.mobility, screens: draft.screens,
    drinks: draft.drinks, practice: draft.practice, water: draft.water, energy: draft.energy,
    note: draft.note || "", week, updated: nowIso,
  };
}

/** Same 5 habits as the dashboard: woke, trained (incl. 20-min version), mobility, screens, no drinks. */
export function hits(row) {
  if (!row) return 0;
  return [row.woke, row.trained, row.mobility, row.screens, (row.drinks ?? 0) === 0].filter(Boolean).length;
}

/** "4/5 habits - screens off by 23:45" plus a detail line. targets = { bed, wake, screensOff }. */
export function summaryText(row, targets) {
  const h = hits(row);
  let cue;
  if (!row.screens) cue = `screens off by ${targets.screensOff}`;
  else if (!row.woke) cue = `up at ${targets.wake} tomorrow`;
  else if (!row.trained) cue = "never miss twice - 20-min version tomorrow";
  else if (!row.mobility) cue = "10 min mobility before bed";
  else if ((row.drinks ?? 0) > 0) cue = "alcohol-free tomorrow";
  else cue = `lights out by ${targets.bed}`;
  const detail = [
    row.trained === 2 ? "20-min session" : null,
    `practice ${row.practice ?? 0} min`,
    row.water != null ? `water ${row.water} L` : null,
    row.energy != null ? `energy ${row.energy}/5` : null,
  ].filter(Boolean).join(" · ");
  return `${h}/5 habits - ${cue}\n${detail}\nSaved for ${row.date}.`;
}
