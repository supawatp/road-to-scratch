// Turns program.json into a day plan, LINE messages and plain-text plans.
import { weekOf, weekday, sleepTargets, drinkLimit, minusMinutes, fmtDay, addDays, mondayOf } from "./dates.js";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export const videoUrl = q => "https://www.youtube.com/results?search_query=" + encodeURIComponent(q);

/** "Kettlebell swing - 4 x 10||kettlebell swing proper form" -> { text, query, url } */
export function splitItem(item) {
  const [text, query] = String(item).split("||");
  return { text: text.trim(), query: query ? query.trim() : null, url: query ? videoUrl(query.trim()) : null };
}

/**
 * Applies weekly plan tweaks (settings.program_overrides) on top of program.json.
 * Shape: { weeks: { "<n>": { focusCue, sleep, drinks, extraTasks: [], template: { "<weekday>": { am, amKey, pm, pmKey } } } } }
 */
export function applyOverrides(program, overrides) {
  if (!overrides || typeof overrides !== "object" || !overrides.weeks) return program;
  const p = { ...program, weeks: program.weeks.map(w => ({ ...w })) };
  for (const [n, o] of Object.entries(overrides.weeks)) {
    const w = p.weeks[Number(n) - 1];
    if (!w || !o) continue;
    if (typeof o.focusCue === "string" && o.focusCue.trim()) w.focusCue = o.focusCue.trim();
    if (typeof o.sleep === "string" && /^\d{2}:\d{2} \/ \d{2}:\d{2}$/.test(o.sleep)) w.sleep = o.sleep;
    if (Number.isInteger(o.drinks) && o.drinks >= 0 && o.drinks <= 7) w.drinks = o.drinks;
    if (Array.isArray(o.extraTasks)) w.tasks = [...w.tasks, ...o.extraTasks.filter(t => typeof t === "string" && t.trim())];
    if (o.template && typeof o.template === "object") {
      const t = {};
      for (const [wd, slot] of Object.entries(o.template)) {
        if (!/^[0-6]$/.test(wd) || !slot) continue;
        const clean = {};
        for (const s of ["am", "pm"]) {
          const key = slot[s + "Key"];
          if (key && p.sessions[key]) { clean[s + "Key"] = key; clean[s] = slot[s] || p.sessions[key].title; }
        }
        if (Object.keys(clean).length) t[wd] = clean;
      }
      if (Object.keys(t).length) w.template = t;
    }
  }
  return p;
}

const phaseOf = (program, w) => program.phases.find(p => w >= p.weeks[0] && w <= p.weeks[1]) || null;

/** Everything the morning message, the `today` command and the check-in summary need for one date. */
export function dayPlan(program, ymd) {
  const week = weekOf(ymd, program.start);
  const wi = program.weeks[week - 1] || null;
  const wd = weekday(ymd);
  const tpl = { ...program.template[wd], ...((wi && wi.template && wi.template[wd]) || {}) };
  const slot = s => {
    const key = tpl[s + "Key"];
    const session = program.sessions[key] || null;
    return { key, label: tpl[s], session, items: session ? session.items.map(splitItem) : [] };
  };
  const am = slot("am"), pm = slot("pm");
  const videos = [...am.items, ...pm.items].filter(i => i.url).slice(0, 3);
  const sleep = sleepTargets(program, week);
  const phase = phaseOf(program, week);
  let title;
  if (week < 1) title = `${program.week0.title} · ${fmtDay(ymd)}`;
  else if (week > program.weeks.length) title = `Maintenance · ${fmtDay(ymd)}`;
  else title = `Week ${week} · ${fmtDay(ymd)}`;
  let focus;
  if (week < 1) focus = `${program.week0.title}: Week 1 starts ${fmtDay(program.start)}`;
  else if (wi) focus = wi.focusCue || `${wi.focus}${phase ? ` (${phase.name})` : ""}`;
  else focus = "Hold the routine";
  return {
    date: ymd, week, weekday: wd, title, focus, phase, weekInfo: wi, am, pm, videos,
    sleep, screensOff: minusMinutes(sleep.bed, 30), drinkLimit: drinkLimit(program, week),
    setupItems: week < 1 ? program.week0.items : [],
  };
}

const isTrainDay = wd => wd >= 1 && wd <= 5;

/**
 * Morning alerts: drinking-night limit and "never miss twice".
 * weekRows = daily rows from Monday up to yesterday; yesterdayRow may be null (not logged).
 */
export function morningAlerts(plan, { yesterdayRow, weekRows = [] }) {
  const alerts = [];
  if (plan.week >= 1) {
    const used = weekRows.filter(r => (r.drinks || 0) > 0).length;
    if (used >= plan.drinkLimit) alerts.push(`Drinking nights: ${used} of ${plan.drinkLimit} used this week - none tonight.`);
    else if (used === plan.drinkLimit - 1) alerts.push(`Drinking nights: ${used} of ${plan.drinkLimit} used - one left this week.`);
  }
  const yWd = (plan.weekday + 6) % 7;
  if (isTrainDay(yWd) && isTrainDay(plan.weekday) && yesterdayRow && !yesterdayRow.trained) {
    alerts.push("Yesterday's session was missed. Never miss twice: do at least the 20-minute version today.");
  }
  return alerts;
}

function sessionBlock(slotName, s) {
  const lines = [`${slotName}: ${s.label || "-"}`];
  if (s.session) {
    if (s.session.time) lines.push(`(${s.session.time})`);
    for (const i of s.items) lines.push(`- ${i.text}${i.url ? `\n  ${i.url}` : ""}`);
    if (s.session.note) lines.push(s.session.note);
  }
  return lines.join("\n");
}

/** Reply to the `today` command: both sessions with every video link. */
export function fullPlanText(plan) {
  const parts = [
    `${plan.title}\nFocus: ${plan.focus}\nBed ${plan.sleep.bed} · wake ${plan.sleep.wake} · screens off ${plan.screensOff}`,
    sessionBlock("After waking", plan.am),
    sessionBlock("Evening", plan.pm),
  ];
  if (plan.setupItems.length) parts.push("Setup week tasks:\n" + plan.setupItems.map(t => `- ${t}`).join("\n"));
  parts.push("Bad day = 20-minute version. Never miss twice.");
  return parts;
}

/** Reply to the `plan` command: this week's focus, targets, tasks and daily template. */
export function weekPlanText(program, ymd) {
  const week = weekOf(ymd, program.start);
  const mon = mondayOf(ymd);
  const lines = [];
  if (week < 1) {
    lines.push(`${program.week0.title} (${program.week0.dates})`, ...program.week0.items.map(t => `- ${t}`));
    lines.push("", `Week 1 starts ${fmtDay(program.start)}.`);
    return lines.join("\n");
  }
  const wi = program.weeks[week - 1];
  const phase = phaseOf(program, week);
  if (wi) {
    lines.push(`Week ${week}: ${wi.focus}${phase ? ` · ${phase.name}` : ""}`);
    if (wi.focusCue) lines.push(`Focus: ${wi.focusCue}`);
    lines.push(`Bed / wake: ${wi.sleep} · max ${wi.drinks} drinking nights`, "", "Key tasks:", ...wi.tasks.map(t => `- ${t}`));
  } else {
    lines.push(`Week ${week}: program complete - hold the routine.`);
  }
  lines.push("", "This week:");
  for (let i = 0; i < 7; i++) {
    const d = addDays(mon, i);
    const p = dayPlan(program, d);
    lines.push(`${DAY_NAMES[p.weekday]} ${d.slice(8)}: ${p.am.label} / ${p.pm.label}`);
  }
  return lines.join("\n");
}

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const txt = (text, extra = {}) => ({ type: "text", text, wrap: true, size: "sm", ...extra });

/** LINE Flex message for the 08:45 push. */
export function morningFlex(plan, { alerts = [], coachMessage = "", dashboardUrl = "" } = {}) {
  const body = [
    txt(plan.focus, { weight: "bold", color: "#1f4d3a" }),
    { type: "separator", margin: "md" },
    txt(`AM  ${plan.am.label}`, { margin: "md" }),
    txt(`PM  ${plan.pm.label}`),
    txt(`Tonight: screens off ${plan.screensOff} · bed ${plan.sleep.bed}`, { margin: "md", color: "#4a544e" }),
  ];
  if (coachMessage) body.push(txt(clip(coachMessage, 600), { margin: "md" }));
  if (alerts.length) {
    body.push({ type: "separator", margin: "md" });
    for (const a of alerts) body.push(txt(`! ${a}`, { color: "#b3402f" }));
  }
  if (plan.videos.length) {
    body.push(txt("Videos", { margin: "md", weight: "bold", size: "xs", color: "#737d77" }));
    for (const v of plan.videos) {
      body.push({ type: "button", style: "link", height: "sm", action: { type: "uri", label: clip(v.text, 40), uri: v.url } });
    }
  }
  const footer = [];
  if (dashboardUrl) footer.push({ type: "button", style: "primary", color: "#1f4d3a", height: "sm", action: { type: "uri", label: "Open dashboard", uri: dashboardUrl } });
  footer.push({ type: "button", style: "secondary", height: "sm", action: { type: "message", label: "Today's full plan", text: "today" } });
  return {
    type: "flex",
    altText: clip(`${plan.title}: ${plan.am.label} / ${plan.pm.label}`, 400),
    contents: {
      type: "bubble",
      header: { type: "box", layout: "vertical", contents: [txt(plan.title, { weight: "bold", size: "lg" })] },
      body: { type: "box", layout: "vertical", spacing: "sm", contents: body },
      footer: { type: "box", layout: "vertical", spacing: "sm", contents: footer },
    },
  };
}

/** Short text version of the morning note, stored in the `coach` table for the dashboard card. */
export function morningNoteText(plan) {
  return [`AM: ${plan.am.label}`, `PM: ${plan.pm.label}`, `Focus: ${plan.focus}`,
    `Screens off ${plan.screensOff}, bed ${plan.sleep.bed}, wake ${plan.sleep.wake}.`].join("\n");
}
