// Date and week logic. Everything is computed in the program's time zone (Asia/Bangkok)
// and passed around as "YYYY-MM-DD" strings so it never depends on the Worker's UTC clock.

export const DEFAULT_TZ = "Asia/Bangkok";
const DAY_MS = 864e5;
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const fmtCache = new Map();
function formatter(tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(tz, new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }));
  }
  return fmtCache.get(tz);
}

/** Wall-clock date/time in `tz` for the instant `now`. */
export function zonedParts(now = new Date(), tz = DEFAULT_TZ) {
  const p = Object.fromEntries(formatter(tz).formatToParts(now).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute) };
}

export const localDate = (now = new Date(), tz = DEFAULT_TZ) => zonedParts(now, tz).date;

export function isYmd(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const toUtc = ymd => Date.parse(ymd + "T00:00:00Z");

export function addDays(ymd, n) {
  return new Date(toUtc(ymd) + n * DAY_MS).toISOString().slice(0, 10);
}

/** 0 = Sunday ... 6 = Saturday (same as Date#getDay and the program template keys). */
export const weekday = ymd => new Date(toUtc(ymd)).getUTCDay();

export const daysBetween = (a, b) => Math.round((toUtc(b) - toUtc(a)) / DAY_MS);

/** Program week number: 0 before the start date, then 1, 2, ... (week 1 = start Monday + 6 days). Matches the dashboard. */
export function weekOf(ymd, start) {
  const diff = daysBetween(start, ymd);
  return diff < 0 ? 0 : Math.floor(diff / 7) + 1;
}

export const mondayOf = ymd => addDays(ymd, -((weekday(ymd) + 6) % 7));

/**
 * The day a check-in belongs to. Answers given after midnight but before `cutoffHour`
 * still count for the previous evening.
 */
export function checkinDate(now = new Date(), tz = DEFAULT_TZ, cutoffHour = 5) {
  const p = zonedParts(now, tz);
  return p.hour < cutoffHour ? addDays(p.date, -1) : p.date;
}

/** "00:15" minus 30 -> "23:45" (wraps around midnight). */
export function minusMinutes(hhmm, mins) {
  const [h, m] = hhmm.split(":").map(Number);
  const t = (((h * 60 + m - mins) % 1440) + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

/** Bedtime / wake targets for a program week (same fallbacks as the dashboard). */
export function sleepTargets(program, week) {
  let s;
  if (week < 1) s = "00:30 / 09:00";
  else s = (program.weeks[week - 1] || {}).sleep || "23:30 / 07:30";
  const [bed, wake] = s.split("/").map(x => x.trim());
  return { bed, wake };
}

export function drinkLimit(program, week) {
  const wi = program.weeks[week - 1];
  return wi ? wi.drinks : (week < 1 ? 3 : 2);
}

/** "2026-10-23" -> "Fri 23 Oct" */
export function fmtDay(ymd) {
  const d = new Date(toUtc(ymd));
  return `${WD[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
}

export const monthKey = ymd => ymd.slice(0, 7);
