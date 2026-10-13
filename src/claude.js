// Optional weekly review by Claude (only runs when ANTHROPIC_API_KEY is set).
import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-opus-5-5";

const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["coach_note", "next_week"],
  properties: {
    coach_note: {
      type: "object",
      additionalProperties: false,
      required: ["title", "message", "alerts"],
      properties: {
        title: { type: "string", description: "Short headline for next Monday's coach card" },
        message: { type: "string", description: "3-6 short sentences: what went well, the one thing to fix, the plan for next week" },
        alerts: { type: "array", items: { type: "string" }, description: "0-3 short warnings" },
      },
    },
    next_week: {
      type: "object",
      additionalProperties: false,
      required: ["focus_cue", "sleep", "drinks", "extra_tasks"],
      properties: {
        focus_cue: { type: "string", description: "One-line focus cue for next week" },
        sleep: { type: "string", description: "Bed / wake target as 'HH:MM / HH:MM'. Repeat the planned value if no change." },
        drinks: { type: "integer", description: "Max drinking nights next week. Repeat the planned value if no change." },
        extra_tasks: { type: "array", items: { type: "string" }, description: "0-3 extra tasks to add to next week" },
      },
    },
  },
};

const SYSTEM = `You are a practical golf and health coach for Supawat (Bangkok). Each Sunday you review the last 14 days of tracker data
against the 12-week Road to Scratch program and write next week's coach note and small plan tweaks.
Be specific and brief. Respect the program's rules (gout: uric acid, alcohol limits, never miss twice, round-day protocol).
Only tighten or loosen targets when the data clearly supports it; otherwise repeat the planned values.`;

/** Strips session exercise lists so the prompt stays small. */
function programBrief(program, nextWeek) {
  return {
    start: program.start,
    phases: program.phases,
    nextWeek: program.weeks[nextWeek - 1] || null,
    template: program.template,
    sessions: Object.fromEntries(Object.entries(program.sessions).map(([k, s]) => [k, s.title])),
    rules: { mind: program.mind, course: program.course, money: program.money, food: program.food },
  };
}

export async function weeklyReview({ apiKey, summary, program, nextWeek }) {
  const client = new Anthropic({ apiKey });
  const res = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium", format: { type: "json_schema", schema: REVIEW_SCHEMA } },
    system: SYSTEM,
    messages: [{
      role: "user",
      content: `Week ${nextWeek} starts tomorrow.\n\nPROGRAM:\n${JSON.stringify(programBrief(program, nextWeek))}\n\nTRACKER SUMMARY (last 14 days):\n${JSON.stringify(summary)}`,
    }],
  });
  if (res.stop_reason === "refusal") throw new Error("Claude declined the weekly review");
  if (res.stop_reason === "max_tokens") throw new Error("Claude review was cut off");
  const text = res.content.filter(b => b.type === "text").map(b => b.text).join("");
  return JSON.parse(text);
}

/** Converts Claude's `next_week` block into the settings.program_overrides shape used by applyOverrides. */
export function toOverrides(existing, nextWeek, review, nowIso) {
  const nw = review.next_week || {};
  const weeks = { ...((existing && existing.weeks) || {}) };
  weeks[nextWeek] = {
    focusCue: String(nw.focus_cue || "").slice(0, 200),
    sleep: nw.sleep,
    drinks: nw.drinks,
    extraTasks: (nw.extra_tasks || []).slice(0, 3).map(t => String(t).slice(0, 300)),
  };
  return { weeks, updated: nowIso, source: "claude-weekly-review" };
}
