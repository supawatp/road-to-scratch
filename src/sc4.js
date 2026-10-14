// SC4 Pro launch-monitor data: CSV parsing and analysis (yardages, gaps, trends, insights).
// Pure functions only - storage lives in sc4store.js.
import { addDays, daysBetween, fmtDay } from "./dates.js";

// ---- CSV -------------------------------------------------------------------------------------

function splitCsvLine(line) {
  if (!line.includes('"')) return line.split(",");
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/** "7i - " -> "7i", "Dr" -> "D", "4 Hybrid" -> "4H", "sw" -> "SW". */
export function normalizeClub(raw) {
  const s = String(raw || "").replace(/[\s-]+$/g, "").replace(/^\s+/, "");
  let m;
  if (/^(dr|driver|1w)$/i.test(s)) return "D";
  if ((m = /^(\d{1,2})\s*i(ron)?$/i.exec(s))) return `${m[1]}i`;
  if ((m = /^(\d)\s*h(ybrid)?$/i.exec(s))) return `${m[1]}H`;
  if ((m = /^(\d{1,2})\s*w(ood)?$/i.exec(s))) return `${m[1]}W`;
  if (/^(pw|gw|sw|lw|aw)$/i.test(s)) return s.toUpperCase();
  return s.slice(0, 12);
}

const num = v => {
  const t = String(v ?? "").trim();
  if (!t || t === "--") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};
/** "L 3.2" -> -3.2, "R 3.2" -> 3.2 (left is negative). */
const signed = v => {
  const t = String(v ?? "").trim();
  const m = /^([LR])\s*([\d.]+)$/i.exec(t);
  if (m) return (m[1].toUpperCase() === "L" ? -1 : 1) * Number(m[2]);
  return num(t);
};
function normDate(s) {
  const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(String(s || "").trim());
  return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : null;
}

/**
 * Parses an SC4 Pro "Stats" CSV export (StatsTargetTable / StatsPracticeTable).
 * Returns { mode, shots, skipped } or throws if the header is not recognised.
 */
export function parseSc4Csv(text) {
  const lines = String(text).replace(/^﻿/, "").split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) throw new Error("The file is empty.");
  const head = splitCsvLine(lines[0]).map(h => h.trim());
  const col = (...names) => {
    for (const n of names) { const i = head.findIndex(h => h.toUpperCase().startsWith(n)); if (i >= 0) return i; }
    return -1;
  };
  const c = {
    no: col("NO"), club: col("CLUB"), date: col("DATE"), target: col("TO TARGET"),
    carry: col("CARRY"), total: col("TOTAL"), side: col("SIDE CARRY"), sideTotal: col("SIDE TOTAL"),
    clubSpeed: col("CLUB SPEED"), ballSpeed: col("BALL SPEED"), launch: col("LAUNCH ANGLE"), launchDir: col("LAUNCH DIRECTION"),
    smash: col("SMASH"), apex: col("APEX"), spin: col("SPIN RPM", "SPIN"), spinAxis: col("SPIN AXIS"), backSpin: col("BACK SPIN"), sideSpin: col("SIDE SPIN"),
  };
  if (c.club < 0 || c.date < 0 || c.carry < 0) throw new Error("This doesn't look like an SC4 stats export (needs CLUB, DATE and CARRY columns).");
  const metres = /\bm\b|\(m\)/i.test(head[c.carry]) && !/yd/i.test(head[c.carry]);
  const kmh = c.clubSpeed >= 0 && /km/i.test(head[c.clubSpeed]);
  const yd = v => (v == null ? null : metres ? Math.round(v * 1.09361 * 10) / 10 : v);
  const mph = v => (v == null ? null : kmh ? Math.round((v / 1.609344) * 10) / 10 : v);
  const mode = c.target >= 0 ? "target" : "practice";
  const shots = []; let skipped = 0;
  for (const line of lines.slice(1)) {
    const f = splitCsvLine(line);
    const get = i => (i >= 0 ? f[i] : undefined);
    const date = normDate(get(c.date));
    const carry = yd(num(get(c.carry)));
    const club = normalizeClub(get(c.club));
    if (!date || carry == null || !club || /^avg/i.test(String(get(c.no) || ""))) { skipped++; continue; }
    shots.push({
      no: num(get(c.no)), club, date, mode, carry,
      total: yd(num(get(c.total))), side: yd(signed(get(c.side))), sideTotal: yd(signed(get(c.sideTotal))),
      toTarget: yd(num(get(c.target))), clubSpeed: mph(num(get(c.clubSpeed))), ballSpeed: mph(num(get(c.ballSpeed))),
      launch: num(get(c.launch)), launchDir: signed(get(c.launchDir)), smash: num(get(c.smash)), apex: num(get(c.apex)),
      spin: num(get(c.spin)), spinAxis: num(get(c.spinAxis)), backSpin: num(get(c.backSpin)), sideSpin: num(get(c.sideSpin)),
    });
  }
  return { mode, shots, skipped };
}

/** Stable identity for a shot, so uploading the same file twice adds nothing. */
export const shotKey = s => [s.date, s.club, s.mode, s.no, s.carry, s.ballSpeed, s.spin, s.side].join("|");

// ---- small stats ----------------------------------------------------------------------------

const vals = (xs, k) => xs.map(x => x[k]).filter(v => v != null && Number.isFinite(v));
export const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
export function sd(xs) {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, v) => a + (v - m) ** 2, 0) / xs.length);
}
export function quantile(xs, p) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const k = (s.length - 1) * p, f = Math.floor(k), c = Math.min(f + 1, s.length - 1);
  return s[f] + (s[c] - s[f]) * (k - f);
}
/**
 * Removes extreme outliers (Tukey's fences): values more than 1.5 x the interquartile range
 * below the 25th or above the 75th percentile. Mishits go; normal variation stays.
 * Fewer than 5 values are returned unchanged.
 */
export function withoutOutliers(xs) {
  if (xs.length < 5) return xs;
  const q1 = quantile(xs, 0.25), q3 = quantile(xs, 0.75), k = 1.5 * (q3 - q1);
  return xs.filter(v => v >= q1 - k && v <= q3 + k);
}
/** Values of `k` with outliers removed - every average and standard deviation is computed on these. */
const clean = (xs, k) => withoutOutliers(vals(xs, k));
const r0 = v => (v == null ? null : Math.round(v) + 0); // + 0 turns -0 into 0
const r1 = v => (v == null ? null : Math.round(v * 10) / 10 + 0);
const r2 = v => (v == null ? null : Math.round(v * 100) / 100 + 0);

// ---- swing length -----------------------------------------------------------------------------

export const isWedge = club => /^(PW|GW|SW|LW|AW)$/.test(club);

/**
 * Best two-group split of club speeds (minimum within-group variance). Returns the threshold
 * only when the groups are clearly apart (>= minGap mph) and both have enough shots.
 */
export function speedSplit(speeds, minGap = 6) {
  const v = [...speeds].sort((a, b) => a - b);
  const n = v.length;
  if (n < 12) return null;
  const minSize = Math.max(4, Math.ceil(n * 0.1));
  const pre = [0]; const pre2 = [0];
  for (const x of v) { pre.push(pre.at(-1) + x); pre2.push(pre2.at(-1) + x * x); }
  const ss = (a, b) => { const k = b - a, s = pre[b] - pre[a]; return pre2[b] - pre2[a] - (s * s) / k; };
  let best = null;
  for (let k = minSize; k <= n - minSize; k++) {
    const cost = ss(0, k) + ss(k, n);
    if (!best || cost < best.cost) best = { k, cost };
  }
  if (!best) return null;
  const lo = (pre[best.k]) / best.k, hi = (pre[n] - pre[best.k]) / (n - best.k);
  if (hi - lo < minGap) return null;
  return { threshold: (v[best.k - 1] + v[best.k]) / 2, low: r1(lo), high: r1(hi) };
}

/**
 * Adds `swing` ('full' | '3/4') to every shot. Shots tagged on upload/in the dashboard keep their tag;
 * 'auto' wedge shots are split by club speed when there are clearly two swing lengths.
 */
export function classifySwings(shots) {
  const splits = {};
  const byClub = {};
  for (const s of shots) (byClub[s.club] ||= []).push(s);
  for (const [club, ss] of Object.entries(byClub)) {
    if (!isWedge(club)) continue;
    splits[club] = speedSplit(ss.filter(s => (s.swing || "auto") === "auto" && s.clubSpeed != null).map(s => s.clubSpeed));
  }
  return {
    splits,
    shots: shots.map(s => {
      const tag = s.swing || "auto";
      let swing = tag === "auto" ? "full" : tag;
      if (tag === "auto" && splits[s.club] && s.clubSpeed != null && s.clubSpeed < splits[s.club].threshold) swing = "3/4";
      return { ...s, tag, swing };
    }),
  };
}

// ---- yardages, gaps, sessions -------------------------------------------------------------------

export const CLUB_NAMES = {
  D: "Driver", "3W": "3-wood", "5W": "5-wood", "7W": "7-wood", "3H": "3-hybrid", "4H": "4-hybrid", "5H": "5-hybrid",
  "3i": "3-iron", "4i": "4-iron", "5i": "5-iron", "6i": "6-iron", "7i": "7-iron", "8i": "8-iron", "9i": "9-iron",
  PW: "Pitching wedge", GW: "Gap wedge", SW: "Sand wedge", LW: "Lob wedge", AW: "Approach wedge",
};
export const clubName = k => CLUB_NAMES[k] || k;
const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

/** Per-metric average and standard deviation after removing that metric's outliers. Usual range = average ± 1 SD. */
function summarize(ss) {
  const carry = clean(ss, "carry"), side = clean(ss, "side");
  const m = mean(carry), d = sd(carry) ?? 0;
  return {
    n: ss.length, outliers: vals(ss, "carry").length - carry.length,
    carry: r0(m), carrySd: r1(sd(carry)), lo: r0(m - d), hi: r0(m + d),
    side: r1(mean(side)), sideSpread: r1(sd(side)),
    right10: side.length ? r0((side.filter(v => v > 10).length / side.length) * 100) : null,
    left10: side.length ? r0((side.filter(v => v < -10).length / side.length) * 100) : null,
    clubSpeed: r1(mean(clean(ss, "clubSpeed"))), ballSpeed: r1(mean(clean(ss, "ballSpeed"))), smash: r2(mean(clean(ss, "smash"))),
    launch: r1(mean(clean(ss, "launch"))), launchDir: r1(mean(clean(ss, "launchDir"))), spin: r0(mean(clean(ss, "spin"))),
    spinAxis: r1(mean(clean(ss, "spinAxis"))),
  };
}

/** Yardage per club and swing from each group's most recent `recent` shots (outliers removed), longest first. */
export function clubStats(classified, recent = 40) {
  const groups = {};
  for (const s of classified) (groups[`${s.club}|${s.swing}`] ||= []).push(s);
  return Object.entries(groups).map(([k, ss]) => {
    const [club, swing] = k.split("|");
    const sample = [...ss].sort(byDate).slice(-recent);
    return { club, swing, ...summarize(sample), total: ss.length, from: sample[0].date, to: sample.at(-1).date };
  }).filter(s => s.carry != null).sort((a, b) => b.carry - a.carry);
}

/** One row per club per practice day (full swings only for the metrics; 3/4 swings counted). Outliers removed per metric. */
export function sessionsOf(classified) {
  const groups = {};
  for (const s of classified) (groups[`${s.club}|${s.date}`] ||= []).push(s);
  return Object.entries(groups).map(([k, ss]) => {
    const [club, date] = k.split("|");
    const full = ss.filter(s => s.swing === "full");
    const m = full.length ? full : ss;
    const carry = clean(m, "carry"), side = clean(m, "side");
    const tags = [...new Set(ss.map(s => s.tag))];
    return {
      club, date, n: ss.length, n34: ss.length - full.length, tag: tags.length === 1 ? tags[0] : "mixed",
      carry: r0(mean(carry)), carrySpread: r1(sd(carry)), side: r1(mean(side)),
      offline10: side.length ? r0((side.filter(v => Math.abs(v) > 10).length / side.length) * 100) : null,
      clubSpeed: r1(mean(clean(m, "clubSpeed"))), smash: r2(mean(clean(m, "smash"))),
    };
  }).sort((a, b) => byDate(a, b) || a.club.localeCompare(b.club));
}

/** Carry gaps between neighbouring full-swing clubs (longest first). */
export function gapsOf(stats) {
  const full = stats.filter(s => s.swing === "full" && s.n >= 10).sort((a, b) => b.carry - a.carry); // thin clubs give noisy gaps
  return full.slice(0, -1).map((s, i) => {
    const next = full[i + 1], gap = s.carry - next.carry;
    return { long: s.club, short: next.club, longCarry: s.carry, shortCarry: next.carry, gap, flag: gap < 5 ? "overlap" : gap > 18 ? "big" : null };
  });
}

/**
 * Distance options for the club picker: SC4 numbers when there are enough shots,
 * otherwise the yardages typed in on the dashboard (settings/yardages). Shortest first.
 */
export function clubOptions(stats, manual = {}) {
  const out = [];
  const sc4 = (club, swing, min) => stats.find(s => s.club === club && s.swing === swing && s.n >= min);
  const clubs = new Set([...Object.keys(manual || {}), ...stats.map(s => s.club)]);
  for (const club of clubs) {
    const m = (manual && manual[club]) || {};
    const f = sc4(club, "full", 10);
    if (f) out.push({ club, label: clubName(club), carry: f.carry, lo: f.lo, hi: f.hi, side: f.side, n: f.n, full: true, source: "sc4" });
    else if (m.full != null) out.push({ club, label: clubName(club), carry: m.full, full: true, source: "manual" });
    const q = sc4(club, "3/4", 6);
    if (q) out.push({ club, label: `${clubName(club)} · 3/4 swing`, carry: q.carry, lo: q.lo, hi: q.hi, side: q.side, n: q.n, source: "sc4" });
    else if (m.h1030 != null) out.push({ club, label: `${clubName(club)} · 3/4 swing`, carry: m.h1030, source: "manual" });
    if (m.h9 != null) out.push({ club, label: `${clubName(club)} · 1/2 swing`, carry: m.h9, source: "manual" });
  }
  return out.sort((a, b) => a.carry - b.carry);
}

/** Same rules as the dashboard picker: the first option that reaches the middle; adj shifts by whole clubs. */
export function pickClub(options, distance, adj = 0) {
  const fulls = options.filter(o => o.full);
  if (!options.length || !fulls.length) return { pick: null, reason: "none" };
  let pick, below;
  if (adj === 0) {
    const i = options.findIndex(o => o.carry >= distance);
    pick = i >= 0 ? options[i] : null;
    below = i > 0 ? options[i - 1] : i < 0 ? options.at(-1) : null;
  } else {
    let i = fulls.findIndex(o => o.carry >= distance); if (i < 0) i = fulls.length;
    const j = i + adj;
    pick = j >= 0 && j < fulls.length ? fulls[j] : null;
    below = j - 1 >= 0 && j - 1 < fulls.length ? fulls[j - 1] : null;
  }
  if (!pick) return { pick: null, reason: adj < 0 || distance < options[0].carry ? "short" : "long", shortest: options[0] };
  return { pick, below };
}

// ---- insights ----------------------------------------------------------------------------------

const dir = v => (v > 0 ? "right" : "left");
const yd1 = v => `${Math.round(Math.abs(v))} yd ${dir(v)}`;

/**
 * Plain-language observations about what's going on. `daily` maps date -> check-in row,
 * `manual` is settings/yardages.clubs. Ordered: warnings, improvements, info.
 */
export function insightsOf({ stats, sessions, options, manual = {}, daily = new Map(), today }) {
  const out = [];
  const full = stats.filter(s => s.swing === "full");
  if (!full.length) return out;

  // 1. Overlapping clubs
  for (const g of gapsOf(stats).filter(g => g.flag === "overlap")) {
    const a = full.find(s => s.club === g.long), b = full.find(s => s.club === g.short);
    // Tighter group = smaller combined spread of distance and direction (both after outlier removal).
    const spread = c => Math.hypot(c.carrySd ?? 0, c.sideSpread ?? 0);
    const [best, other] = spread(a) <= spread(b) ? [a, b] : [b, a];
    out.push({ level: "warn", kind: "overlap", text: `${a.club} (${a.carry} yd) and ${b.club} (${b.carry} yd) carry almost the same. For that distance, take the ${best.club}: its shots land in a tighter group (±${Math.round(best.carrySd ?? 0)} yd long/short, against ±${Math.round(other.carrySd ?? 0)} for the ${other.club}). Ask your coach about the ${other.club} strike.` });
  }

  // 2. Scoring-zone distances nothing covers (wedges and short irons, any swing length)
  for (let i = 1; i < options.length; i++) {
    const s = options[i - 1], l = options[i];
    if (l.carry - s.carry > 15 && s.carry >= 40 && l.carry <= 130) {
      out.push({ level: "warn", kind: "hole", text: `Nothing covers ${s.carry + 1}–${l.carry - 1} yd: ${s.label} goes ${s.carry}, ${l.label} goes ${l.carry}. Practise a stock swing for the middle of that gap.` });
    }
  }
  // ...and big jumps between longer full-swing clubs
  for (const g of gapsOf(stats).filter(g => g.flag === "big" && g.longCarry > 130)) {
    out.push({ level: "info", kind: "gap", text: `${g.long} (${g.longCarry} yd) to ${g.short} (${g.shortCarry} yd) is a ${g.gap}-yd jump. For distances in between, grip down on the ${g.long}.` });
  }

  // 3. Direction bias
  const biased = full.filter(s => s.n >= 15 && s.side != null && Math.abs(s.side) >= 7);
  const sameWay = biased.length >= 3 && biased.every(s => Math.sign(s.side) === Math.sign(biased[0].side));
  if (sameWay) {
    const ld = mean(biased.map(s => s.launchDir).filter(v => v != null)), ax = mean(biased.map(s => s.spinAxis).filter(v => v != null));
    const start = ld != null && Math.abs(ld) >= 1 ? `start about ${r1(Math.abs(ld))}° ${dir(ld)}` : null;
    const curve = ax != null && Math.abs(ax) >= 2 ? `curve ${dir(ax)}` : null;
    const why = [start, curve].filter(Boolean).join(" and ");
    out.push({ level: "warn", kind: "bias", text: `Most misses go ${dir(biased[0].side)}: ${biased.map(s => `${s.club} ${Math.round(Math.abs(s.side))}`).join(", ")} yd on average.${why ? ` Shots ${why}.` : ""} Aim at the ${dir(-biased[0].side)} half of the green until the start line improves.` });
  } else {
    for (const s of biased.slice(0, 3)) {
      out.push({ level: "warn", kind: "bias", text: `${s.club} finishes ${yd1(s.side)} on average (${s[s.side > 0 ? "right10" : "left10"]}% of shots more than 10 yd ${dir(s.side)}). Aim at the ${dir(-s.side)} half of the green with it.` });
    }
  }

  // 4. Trends per club: last session vs earlier sessions (full swings, 8+ shots)
  const trends = [];
  const clubs = [...new Set(sessions.map(s => s.club))];
  for (const club of clubs) {
    const ss = sessions.filter(s => s.club === club && s.n - s.n34 >= 8);
    if (ss.length < 2) continue;
    const last = ss.at(-1), prev = ss.slice(0, -1);
    const w = k => { const xs = prev.filter(p => p[k] != null); const n = xs.reduce((a, p) => a + p.n, 0); return n ? xs.reduce((a, p) => a + p[k] * p.n, 0) / n : null; };
    const pSide = w("side"), pSpread = w("carrySpread");
    if (last.side != null && pSide != null) {
      const d = Math.abs(last.side) - Math.abs(pSide);
      if (d >= 5) trends.push({ score: d, level: "warn", kind: "trend", text: `${club} is drifting ${dir(last.side)}: ${yd1(last.side)} on ${fmtDay(last.date)}, against ${yd1(pSide)} before.` });
      if (d <= -5) trends.push({ score: -d, level: "good", kind: "trend", text: `${club} is straighter: ${yd1(last.side)} on ${fmtDay(last.date)}, against ${yd1(pSide)} before.` });
    }
    if (last.carrySpread != null && pSpread != null) {
      const d = last.carrySpread - pSpread;
      if (d >= 3) trends.push({ score: d, level: "warn", kind: "trend", text: `${club} distance control slipped: carry SD ${Math.round(last.carrySpread)} yd on ${fmtDay(last.date)}, against ${Math.round(pSpread)} before.` });
      if (d <= -3) trends.push({ score: -d, level: "good", kind: "trend", text: `${club} distances are tighter: carry SD ${Math.round(last.carrySpread)} yd on ${fmtDay(last.date)}, against ${Math.round(pSpread)} before.` });
    }
  }
  out.push(...trends.sort((a, b) => b.score - a.score).slice(0, 3).map(({ score, ...t }) => t));

  // 5. Speed on the latest practice day, linked to the check-in
  const lastDate = sessions.reduce((a, s) => (s.date > a ? s.date : a), "");
  const diffs = [];
  for (const club of clubs) {
    const ss = sessions.filter(s => s.club === club && s.clubSpeed != null && s.n - s.n34 >= 8);
    const day = ss.find(s => s.date === lastDate), others = ss.filter(s => s.date !== lastDate);
    if (!day || !others.length) continue;
    const n = others.reduce((a, s) => a + s.n, 0);
    diffs.push({ club, d: day.clubSpeed - others.reduce((a, s) => a + s.clubSpeed * s.n, 0) / n });
  }
  if (diffs.length >= 2) {
    const avg = mean(diffs.map(x => x.d));
    if (Math.abs(avg) >= 3) {
      const ci = daily.get(lastDate), before = daily.get(addDays(lastDate, -1));
      const ctx = [];
      if (ci && ci.energy != null && ci.energy <= 2) ctx.push(`energy ${ci.energy}/5 that day`);
      if (before && (before.drinks || 0) > 0) ctx.push(`${before.drinks}${before.drinks >= 4 ? "+" : ""} drinks the night before`);
      if (ci && ci.screens === 0) ctx.push("screens off late the night before");
      const tail = avg < 0
        ? (ctx.length ? ` Check-in: ${ctx.join(", ")}.` : (ci || before) ? " Your check-in looks normal, so it may have been effort or warm-up." : " Log a check-in on practice days so speed can be linked to sleep and drinks.")
        : "";
      out.push({
        level: avg < 0 ? "warn" : "good", kind: "speed",
        text: `Club speed was ${avg < 0 ? "down" : "up"} ${Math.round(Math.abs(avg))} mph on ${fmtDay(lastDate)} (${diffs.map(x => x.club).join(", ")}), and carry ${avg < 0 ? "dropped" : "rose"} with it.${tail}`,
      });
    }
  }

  // 6. Saved yardages that disagree with the data
  const mism = full.filter(s => s.n >= 10 && manual[s.club] && manual[s.club].full != null && Math.abs(manual[s.club].full - s.carry) >= 4);
  if (mism.length) out.push({ level: "info", kind: "yardage", text: `Saved yardages differ from SC4: ${mism.map(s => `${s.club} saved ${manual[s.club].full}, SC4 ${s.carry}`).join("; ")}. The club picker uses the SC4 numbers.` });

  // 7. Thin data
  const thin = full.filter(s => s.n < 10);
  if (thin.length) out.push({ level: "info", kind: "thin", text: `Not enough shots yet for ${thin.map(s => `${s.club} (${s.n})`).join(", ")}. Hit 10 or more with each for a reliable yardage.` });

  // 8. Stale data
  if (today && lastDate && daysBetween(lastDate, today) >= 14) {
    out.push({ level: "info", kind: "stale", text: `Latest SC4 data is from ${fmtDay(lastDate)}. Upload new sessions to keep yardages current.` });
  }

  const rank = { warn: 0, good: 1, info: 2 };
  return out.sort((a, b) => rank[a.level] - rank[b.level]).slice(0, 10);
}

/** Everything the dashboard, LINE and the weekly review need, from raw shot rows. */
export function analyze(rows, { manual = {}, daily = new Map(), today, recent = 40 } = {}) {
  const { shots, splits } = classifySwings(rows);
  const stats = clubStats(shots, recent);
  const sessions = sessionsOf(shots);
  const options = clubOptions(stats, manual);
  const dates = shots.map(s => s.date).sort();
  return {
    totalShots: shots.length, firstDate: dates[0] || null, lastDate: dates.at(-1) || null,
    splits, clubs: stats, gaps: gapsOf(stats), sessions,
    insights: insightsOf({ stats, sessions, options, manual, daily, today }),
  };
}
