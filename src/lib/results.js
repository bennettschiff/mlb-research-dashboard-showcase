// ── Results math ─────────────────────────────────────────────────────────────
// Every number the Results surface displays is computed here. The UI renders;
// it never re-derives a rate, a payout or a window. Two reasons this matters:
//
//   1. Before the 2026-08 revamp, the Dashboard and Windows sub-tabs each
//      carried their own copy of the same aggregation and their own window
//      state, and they disagreed — the same picks read differently depending
//      on which tab you were standing in.
//   2. P/L is the arbiter for this project. A payout formula duplicated across
//      five call sites is a payout formula that drifts.
//
// Stake convention. Every P/L function takes `stakeOf(pick) -> units`. The two
// tracks the UI shows side by side are just two stakeOf functions:
//   flat     — () => 1                  (model-quality view, controller-blind)
//   weighted — pickStakeUnits(...)      (honest sim of following the controller:
//                                        Hits 2u, HR/SB 0.5u, × the edge-controller
//                                        multiplier in force on the pick's date,
//                                        so a suspended market stakes 0u)
// Profit comes back in UNITS. Dollars are always units × $/unit, computed at
// the edge in the UI — never threaded through this module.
import { pickCurrentConf } from "./picks.js";

// ── Labels & ordering ────────────────────────────────────────────────────────
export const PROP_LABELS_R = {
  hits: "Hits", hrr: "H+R+RBI", hr: "HR", tb: "Total Bases", sb: "SB",
  rbi: "RBI", ks: "Strikeouts", ks_under: "Ks UNDER", ml: "Moneyline",
  rl: "Spread", ou: "O/U", nrfi: "1st Inning",
};

export const PROP_DISPLAY_ORDER = [
  "🏆 Golden 10", "Hits", "HR", "RBI", "H+R+RBI", "Total Bases", "SB",
  "Strikeouts", "Ks UNDER", "Spread", "Moneyline", "Line - Over",
  "Line - Under", "YRFI", "NRFI",
];

export const OU_PROP_TYPES = new Set(["Line - Over", "Line - Under"]);

export const OUTCOME_COLORS = { win: "#0f8a44", loss: "#d03131", push: "#a16207", pending: "#74839d" };

// Market key for a pick. Deliberately direction-aware: Ks Over and Ks Under are
// different bets with different edges, and averaging them into one "Strikeouts"
// row lets a losing side hide inside a winning one. Same for NRFI/YRFI and the
// two sides of a game total.
export const pickLabel = (p) => {
  if (p.prop_type === "ks" && p.direction === "under") return "Ks UNDER";
  if (p.prop_type === "ou") return p.direction === "under" ? "Line - Under" : "Line - Over";
  if (p.prop_type === "nrfi") return p.direction === "under" ? "NRFI" : "YRFI";
  return PROP_LABELS_R[p.prop_type] || p.prop_type;
};

export const marketOrder = (name) => {
  const i = PROP_DISPLAY_ORDER.indexOf(name);
  return i === -1 ? Number.MAX_SAFE_INTEGER : i;
};

// ── Confidence tiers ─────────────────────────────────────────────────────────
export const CONF_TIERS = [
  { label: "9.5+",    min: 9.5, max: Infinity },
  { label: "9.0–9.5", min: 9.0, max: 9.5 },
  { label: "8.5–9.0", min: 8.5, max: 9.0 },
  { label: "8.0–8.5", min: 8.0, max: 8.5 },
];

// Ks confidence isn't reconstructable from stored columns (xKEdge isn't saved),
// so it's pinned at 9.0 for tiering — same convention the pre-revamp tab used.
export const tierConf = (p) => (p.prop_type === "ks" ? 9.0 : (pickCurrentConf(p) ?? 0));

// ── Model-era boundaries ─────────────────────────────────────────────────────
// v2 = the first big cluster of overhauls (HRR + multi-model audit + pick_signals
// capture). Picks before this reflect model logic that no longer exists.
export const REVAMP_DATE = "2026-05-20";

// Per-market overhauls — each a logic change that may have moved hit-rate for
// the affected markets. Drives the before/after splits and the equity-curve
// markers, so a model change is visible as a slope change rather than prose.
export const OVERHAULS = [
  { key: "hrr_2026_05_20", date: "2026-05-20", label: "HRR overhaul",
    markets: ["hrr"], summary: "freqMod bug, wRC+ weight, Savant signals, pickThresh 7.5" },
  { key: "multi_2026_05_20", date: "2026-05-20", label: "Multi-model audit",
    markets: ["hits","hr","sb","ks","ml","rl","ou"], summary: "SB gate ordering, Pit+/Loc+/k_bb_pct, PARK_RUNS fix" },
  { key: "sb_2026_05_24", date: "2026-05-24", label: "SB recalibration",
    markets: ["sb"], summary: "Prob ×0.55, reweighted composite, conf capped ~7" },
  { key: "rbi_2026_05_27", date: "2026-05-27", label: "RBI lineup gate",
    markets: ["rbi"], summary: "Confirmed lineup + gameTotal gate required for picks" },
  { key: "tb_2026_05_28", date: "2026-05-28", label: "TB calibration",
    markets: ["tb"], summary: "Promoted to picks-grade: compressed conf, score>3.6 regression penalty, dampened park, ISO+wRC+ added, pickThresh 7.7 (50.5% backtest)" },
  { key: "tb_2026_05_29", date: "2026-05-29", label: "TB promotion+threshold tighten",
    markets: ["tb"], summary: "After 1-9 first slate: o25IsMain now requires score>=3.35 AND p15>=0.51 (was p15>=0.50 only); pickThresh 7.7 → 8.3" },
];

// ── Date helpers ─────────────────────────────────────────────────────────────
// All date math is UTC-on-a-YYYY-MM-DD-string. pick_date is a calendar date, not
// an instant; going through local time would shift days for anyone west of UTC.
export const ymdToUTC = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); };
export const shiftDays = (s, n) => { const d = ymdToUTC(s); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export const daysBetween = (a, b) => Math.round((ymdToUTC(b) - ymdToUTC(a)) / 86400000);

export const WINDOWS = [
  { key: "7d",  label: "7d",           days: 7 },
  { key: "14d", label: "14d",          days: 14 },
  { key: "30d", label: "30d",          days: 30 },
  { key: "v2",  label: "Since Revamp", days: null },
  { key: "all", label: "All Time",     days: null },
];

// Inclusive [from, to] date bounds for a named window. `custom` carries its own
// range. Returns null bounds for open-ended windows.
export function windowBounds(window, todayStr, custom = null) {
  if (window === "custom" && custom?.from) return { from: custom.from, to: custom.to || custom.from };
  if (window === "all") return { from: null, to: null };
  if (window === "v2")  return { from: REVAMP_DATE, to: null };
  const spec = WINDOWS.find(w => w.key === window);
  if (spec?.days) return { from: shiftDays(todayStr, -(spec.days - 1)), to: null };
  return { from: null, to: null };
}

export function pickInWindow(p, window, todayStr, custom = null) {
  const { from, to } = windowBounds(window, todayStr, custom);
  if (from && p.pick_date < from) return false;
  if (to && p.pick_date > to) return false;
  return true;
}

export const filterWindow = (picks, window, todayStr, custom = null) =>
  picks.filter(p => pickInWindow(p, window, todayStr, custom));

// The equal-length window immediately before the selected one, for Δ columns.
// Open-ended windows (all time, since revamp) have nothing to compare against
// and return null rather than an arbitrary slice.
export function priorWindow(picks, window, todayStr, custom = null) {
  const { from, to } = windowBounds(window, todayStr, custom);
  if (!from) return null;
  const end = to || todayStr;
  const len = daysBetween(from, end) + 1;
  const prevTo = shiftDays(from, -1);
  const prevFrom = shiftDays(prevTo, -(len - 1));
  return picks.filter(p => p.pick_date >= prevFrom && p.pick_date <= prevTo);
}

// ── P/L primitives ───────────────────────────────────────────────────────────
// Settlement lives in src/lib/settlement.js, shared with api/_sheets-feed.js and
// scripts/lib/lab-core.mjs, because these three had three different answers for the
// same row (Hits -21.06u in the lab vs -56.42u here on identical post-April-5 picks).
//
// The 2026-08-27 NRFI carve-out that used to live here is now the general rule. It was
// right, and it was scoped too narrowly: it only refused to invent a price for markets
// The Odds API never posts. But `best_odds || fair_line || -110` was inventing prices
// everywhere else too, and the fair_line leg is the worst of the three — it is the
// MODEL'S OWN fair value, so a win gets paid at a number the model chose for itself,
// and the model is most generous exactly where it is most confident. 1,279 of 7,061
// graded picks (18.1%) carry fair_line and no quote and were being settled at it.
//
// Now: only a real bookmaker price settles. No quote means the row contributes 0 units
// and stays out of the ROI denominator — nothing was ever at risk — while still
// counting toward W/L, because the model was right or wrong regardless of whether we
// could have bet it. Across all graded picks that moves the book from -634.87u on 6,547
// staked (-9.70%) to -301.76u on 5,266 staked (-5.73%): 333u of booked profit and loss
// that no quote ever supported. It moves HR the furthest, -96.31u to +1.68u.
import { settle, isUnpricedRow, PRICE_SOURCE, bookQuote } from "./settlement.js";

export { PRICE_SOURCE, bookQuote };

// Kept as the name the Results components already import. It now means "no bookmaker
// price for this row", which subsumes the old structural-market test: a market nobody
// prices has no quote on any row.
export const pickIsUnpriced = (p) => isUnpricedRow(p);

export function pickProfitUnits(p, stakeUnits) {
  return settle(p, stakeUnits).units;
}

/** Units at risk — 0 for a push and for an unpriced row. The ROI denominator. */
export function pickStakedUnits(p, stakeUnits) {
  return settle(p, stakeUnits).staked;
}

export const FLAT = () => 1;

// Wilson score interval for a binomial proportion. Used instead of a bare win%
// because this app routinely displays rates off 5–20 picks, where the point
// estimate carries almost no information — a 6-pick market printing "17%" reads
// as a finding when it's noise. Returns fractions in [0,1].
export function wilson(wins, n, z = 1.96) {
  if (!n) return { lo: null, hi: null, p: null };
  const p = wins / n;
  const d = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return { p, lo: Math.max(0, (center - spread) / d), hi: Math.min(1, (center + spread) / d) };
}

// Below this many graded picks, a rate is displayed but never colored, and no
// alarm fires off it. Chosen so a market needs roughly a week of daily volume
// before it can indict itself.
export const MIN_N_VERDICT = 25;

// ── Core rollup ──────────────────────────────────────────────────────────────
// One settled-pick set → every headline number, on one stake track.
export function rollup(picks, stakeOf = FLAT) {
  let w = 0, l = 0, pu = 0, units = 0, staked = 0, unpricedN = 0;
  for (const p of picks) {
    if (p.outcome === "win") w++;
    else if (p.outcome === "loss") l++;
    else if (p.outcome === "push") { pu++; continue; }
    else continue;
    const s = stakeOf(p);
    units += pickProfitUnits(p, s);
    // An unpriced pick risks nothing, so it must stay out of the ROI denominator
    // too — counting it as staked would dilute ROI toward zero with money that
    // was never at risk. It still counts in w/l above: the model was right or
    // wrong, only the payout is unavailable.
    if (pickIsUnpriced(p)) unpricedN++;
    else staked += s;
  }
  const decided = w + l;
  // The null check has to come BEFORE Number(): Number(null) is 0, not NaN, so
  // the pre-revamp version of this line counted every unpriced pick as exactly
  // 0pp CLV. That both inflated the n and pulled the average toward zero —
  // a market genuinely losing the close looked flat.
  const clvVals = picks
    .filter(p => p.clv_pct != null)
    .map(p => Number(p.clv_pct))
    .filter(v => Number.isFinite(v));
  const avgCLV = clvVals.length ? clvVals.reduce((a, b) => a + b, 0) / clvVals.length : null;
  const ci = wilson(w, decided);
  return {
    w, l, pu, n: w + l + pu, decided,
    winPct: decided ? (w / decided) * 100 : null,
    ci,
    units, staked,
    roiPct: staked > 0 ? (units / staked) * 100 : null,
    avgCLV, clvN: clvVals.length,
    thin: decided > 0 && decided < MIN_N_VERDICT,
    // Settled picks in this set that carry no obtainable price. They score in
    // w/l but stake and pay nothing, so a set with a high unpricedN has a real
    // win rate and an ROI that describes only the bettable remainder.
    unpricedN,
  };
}

// Both tracks at once — what the headline strip and every table row render.
export const rollupBoth = (picks, weightedStakeOf) => ({
  flat: rollup(picks, FLAT),
  weighted: rollup(picks, weightedStakeOf),
});

// ── Per-day series ───────────────────────────────────────────────────────────
// Feeds both the calendar heat map and the equity curve. Sorted oldest → newest.
export function dailySeries(picks, weightedStakeOf) {
  const byDate = new Map();
  for (const p of picks) {
    if (!byDate.has(p.pick_date)) byDate.set(p.pick_date, []);
    byDate.get(p.pick_date).push(p);
  }
  return [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, ps]) => ({ date, picks: ps, ...rollupBoth(ps, weightedStakeOf) }));
}

// Cumulative units by day, both tracks, for the equity curve.
export function equitySeries(daily) {
  let cf = 0, cw = 0;
  return daily.map(d => {
    cf += d.flat.units;
    cw += d.weighted.units;
    return { date: d.date, flat: cf, weighted: cw, dayFlat: d.flat.units, dayWeighted: d.weighted.units };
  });
}

// ── Per-market ───────────────────────────────────────────────────────────────
// `compareTo` is the immediately-preceding equal-length window; its rollup rides
// along on each row so the table can show a Δ without the UI re-slicing dates.
export function byMarket(picks, weightedStakeOf, compareTo = null) {
  const groups = new Map();
  for (const p of picks) {
    const k = pickLabel(p);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }
  const prev = new Map();
  if (compareTo) {
    for (const p of compareTo) {
      const k = pickLabel(p);
      if (!prev.has(k)) prev.set(k, []);
      prev.get(k).push(p);
    }
  }
  return [...groups.entries()]
    .map(([market, ps]) => ({
      market,
      picks: ps,
      ...rollupBoth(ps, weightedStakeOf),
      recent: recentDots(ps, 10),
      prior: prev.has(market) ? rollup(prev.get(market), FLAT) : null,
    }))
    .sort((a, b) => marketOrder(a.market) - marketOrder(b.market) || a.market.localeCompare(b.market));
}

// Last-N settled outcomes, oldest → newest, for the streak dots.
export function recentDots(picks, n = 10) {
  return [...picks]
    .filter(p => p.outcome && p.outcome !== "pending")
    .sort((a, b) => (a.pick_date < b.pick_date ? -1 : a.pick_date > b.pick_date ? 1 : 0))
    .slice(-n)
    .map(p => p.outcome);
}

// ── Hot / cold ───────────────────────────────────────────────────────────────
// A market is "hot" when its recent per-pick P/L beats its own longer-run
// baseline — not when its raw win% is high. Absolute win% ranks Hits (heavy
// chalk) above everything forever; this ranks against each market's own norm,
// which is the question actually being asked.
export function hotCold(allScored, todayStr, { days = 14, minN = 8, baselineFrom = REVAMP_DATE } = {}) {
  const recentFrom = shiftDays(todayStr, -(days - 1));
  const groups = new Map();
  for (const p of allScored) {
    if (p.pick_date < baselineFrom) continue;
    const k = pickLabel(p);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }
  const rows = [];
  for (const [market, ps] of groups) {
    const recent = ps.filter(p => p.pick_date >= recentFrom);
    const rr = rollup(recent, FLAT);
    if (rr.decided < minN) continue;
    const base = rollup(ps, FLAT);
    const recentPer = rr.staked > 0 ? rr.units / rr.staked : 0;
    const basePer = base.staked > 0 ? base.units / base.staked : 0;
    rows.push({
      market, recent: rr, baseline: base,
      perPick: recentPer,
      delta: recentPer - basePer,
      dots: recentDots(recent, 10),
    });
  }
  return rows.sort((a, b) => b.perPick - a.perPick);
}

// ── Confidence tiers & deciles ───────────────────────────────────────────────
export function byTier(picks, weightedStakeOf) {
  return CONF_TIERS.map(tier => {
    const ps = picks.filter(p => { const c = tierConf(p); return c >= tier.min && c < tier.max; });
    return { ...tier, picks: ps, ...rollupBoth(ps, weightedStakeOf) };
  }).filter(t => t.flat.n > 0);
}

// ── Calibration ──────────────────────────────────────────────────────────────
// Buckets picks by stored model_prob and compares predicted to realized. A model
// that says 70% and hits 55% is miscalibrated even while it's profitable, and
// that gap is what eventually shows up as a losing month.
export function calibrationBuckets(picks, bucketSize = 0.05) {
  const buckets = new Map();
  for (const p of picks) {
    const mp = Number(p.model_prob);
    if (!Number.isFinite(mp) || mp <= 0 || mp >= 1) continue;
    if (p.outcome !== "win" && p.outcome !== "loss") continue;
    const b = Math.min(0.95, Math.floor(mp / bucketSize) * bucketSize);
    if (!buckets.has(b)) buckets.set(b, { lo: b, hi: b + bucketSize, w: 0, n: 0, sumPred: 0 });
    const e = buckets.get(b);
    e.n++; e.sumPred += mp;
    if (p.outcome === "win") e.w++;
  }
  return [...buckets.values()]
    .map(e => ({ ...e, predicted: e.sumPred / e.n, actual: e.w / e.n, gap: e.w / e.n - e.sumPred / e.n, ci: wilson(e.w, e.n) }))
    .sort((a, b) => a.lo - b.lo);
}

// ── Odds bands ───────────────────────────────────────────────────────────────
export const ODDS_BANDS = [
  { key: "heavy", label: "≤ −250",      test: o => o <= -250 },
  { key: "chalk", label: "−249 to −150", test: o => o > -250 && o <= -150 },
  { key: "short", label: "−149 to −110", test: o => o > -150 && o <= -110 },
  { key: "near",  label: "−109 to +109", test: o => o > -110 && o < 110 },
  { key: "plus",  label: "+110 to +249", test: o => o >= 110 && o < 250 },
  { key: "long",  label: "+250 or more", test: o => o >= 250 },
];

export function byOddsBand(picks, weightedStakeOf) {
  return ODDS_BANDS.map(band => {
    const ps = picks.filter(p => {
      const o = p.best_odds ?? p.fair_line;
      return Number.isFinite(Number(o)) && band.test(Number(o));
    });
    return { ...band, picks: ps, ...rollupBoth(ps, weightedStakeOf) };
  }).filter(b => b.flat.n > 0);
}

// ── Players ──────────────────────────────────────────────────────────────────
export function byPlayer(picks, minDecided = 2) {
  const groups = new Map();
  for (const p of picks) {
    if (!groups.has(p.player_name)) groups.set(p.player_name, { picks: [], props: new Set() });
    const g = groups.get(p.player_name);
    g.picks.push(p);
    g.props.add(pickLabel(p));
  }
  return [...groups.entries()]
    .map(([name, g]) => ({ name, propList: [...g.props].join(", "), ...rollup(g.picks, FLAT) }))
    .filter(r => r.decided >= minDecided)
    .sort((a, b) => b.winPct - a.winPct || b.decided - a.decided);
}

// ── Alarms ───────────────────────────────────────────────────────────────────
// Derived, never hand-maintained. The point is that a problem announces itself
// on the page the day it starts rather than the week someone thinks to go check.
//
// STALLED deserves a note: it fires when a market that was producing picks stops
// producing them. Nothing in this app surfaced that before, which is how the HRR
// gate collapse (2026-06) and the two-week lab-analyst outage (2026-08) both ran
// silently — an empty market and a healthy one look identical on a results page
// that only ever renders what exists.
export function alarms(allScored, allPicks, todayStr, weightedStakeOf, window = "30d", custom = null) {
  const out = [];
  const windowed = filterWindow(allScored, window, todayStr, custom);
  const markets = byMarket(windowed, weightedStakeOf);

  for (const m of markets) {
    // Judged on the FLAT track: the question is whether the market itself is
    // broken, and flat is the controller-blind view of that. The weighted
    // number rides along so this can't be read against the weighted figures
    // shown elsewhere on the page and look like a contradiction.
    if (m.flat.decided >= MIN_N_VERDICT && m.flat.units < 0) {
      out.push({
        level: "alarm", key: `losing:${m.market}`, market: m.market,
        group: "losing", weight: Math.abs(m.flat.units),
        title: `${m.market} is losing money`,
        detail: `${m.flat.w}-${m.flat.l} · ${m.flat.units.toFixed(1)}u flat (${m.weighted.units.toFixed(1)}u weighted) · ` +
          `${m.flat.roiPct.toFixed(1)}% ROI over ${m.flat.decided} graded picks in this window.`,
      });
    }
    if (m.flat.avgCLV != null && m.flat.clvN >= MIN_N_VERDICT && m.flat.avgCLV < 0) {
      out.push({
        level: "warn", key: `clv:${m.market}`, market: m.market,
        group: "clv", weight: Math.abs(m.flat.avgCLV) * 100,
        title: `${m.market} is losing the close`,
        detail: `Average CLV ${(m.flat.avgCLV * 100).toFixed(1)}pp across ${m.flat.clvN} priced picks — the market is moving away from these.`,
      });
    }
  }

  // Top-conviction inversion: the highest-confidence third earning less per pick
  // than the lowest third. This is the shape that cost real money on HR in
  // 2026-06 (top-conf −66% ROI vs bottom +9%) and it recurs whenever a market
  // gets priced in, so it is checked continuously rather than rediscovered.
  for (const m of markets) {
    const graded = m.picks.filter(p => p.outcome === "win" || p.outcome === "loss");
    const withConf = graded.map(p => ({ p, c: tierConf(p) })).filter(x => x.c > 0).sort((a, b) => a.c - b.c);
    if (withConf.length < 30) continue;
    const third = Math.floor(withConf.length / 3);
    const bottom = rollup(withConf.slice(0, third).map(x => x.p), FLAT);
    const top = rollup(withConf.slice(-third).map(x => x.p), FLAT);
    const topPer = top.staked ? top.units / top.staked : 0;
    const botPer = bottom.staked ? bottom.units / bottom.staked : 0;
    if (topPer < botPer - 0.10) {
      out.push({
        level: "alarm", key: `inversion:${m.market}`, market: m.market,
        group: "inversion", weight: (botPer - topPer) * 100,
        title: `${m.market} conviction is inverted`,
        detail: `Top third by confidence returns ${(topPer * 100).toFixed(1)}% per unit vs ${(botPer * 100).toFixed(1)}% for the bottom third (n=${third} each) — the model's best picks are its worst bets.`,
      });
    }
  }

  // Stalled markets — produced picks in the prior 30 days, none in the last 10.
  const recentFrom = shiftDays(todayStr, -9);
  const priorFrom = shiftDays(todayStr, -39);
  const seenRecent = new Set(allPicks.filter(p => p.pick_date >= recentFrom).map(pickLabel));
  const priorCounts = new Map();
  for (const p of allPicks) {
    if (p.pick_date < priorFrom || p.pick_date >= recentFrom) continue;
    const k = pickLabel(p);
    priorCounts.set(k, (priorCounts.get(k) || 0) + 1);
  }
  for (const [market, count] of priorCounts) {
    if (count >= 10 && !seenRecent.has(market)) {
      out.push({
        level: "alarm", key: `stalled:${market}`, market,
        group: "stalled", weight: count,
        title: `${market} has stopped producing picks`,
        detail: `${count} picks in the preceding 30 days, zero in the last 10. Check the gate — a market that goes quiet looks identical to a healthy one here.`,
      });
    }
  }

  // Thin samples, stated out loud so silence isn't read as health.
  const thin = markets.filter(m => m.flat.thin).map(m => `${m.market} (${m.flat.decided})`);
  if (thin.length) {
    out.push({
      level: "info", key: "thin", market: null,
      group: "thin", weight: 0,
      title: `${thin.length} market${thin.length === 1 ? "" : "s"} below ${MIN_N_VERDICT} graded picks`,
      detail: `${thin.join(", ")}. Rates shown for these are uncolored on purpose — they carry no verdict.`,
    });
  }

  // Rank within a level by how much the item actually costs, not by the order
  // markets happened to iterate. Sorting on level alone put Hits (−17.4u over
  // 233 picks) above RBI (−16.1u over 50 at −32% ROI) purely by position.
  const order = { alarm: 0, warn: 1, info: 2 };
  return out.sort((a, b) => order[a.level] - order[b.level] || (b.weight ?? 0) - (a.weight ?? 0));
}

// Alarm classes, in the order a reader should work through them. The rail groups
// by these so seven repetitions of "X is losing money" read as one finding with
// seven instances rather than seven separate emergencies.
export const ALARM_GROUPS = [
  { key: "losing",    label: "Losing money",            noun: "market" },
  { key: "inversion", label: "Conviction inverted",     noun: "market" },
  { key: "stalled",   label: "Stopped producing picks", noun: "market" },
  { key: "clv",       label: "Losing the close",        noun: "market" },
  { key: "thin",      label: "Thin samples",            noun: "note" },
];

// ── Overhaul before/after ────────────────────────────────────────────────────
export function overhaulSplit(allScored, markets, cutoffDate, weightedStakeOf) {
  const inMarket = allScored.filter(p => markets.includes(p.prop_type));
  return {
    before: rollupBoth(inMarket.filter(p => p.pick_date < cutoffDate), weightedStakeOf),
    after: rollupBoth(inMarket.filter(p => p.pick_date >= cutoffDate), weightedStakeOf),
  };
}

// ── Calendar layout ──────────────────────────────────────────────────────────
// Weeks of a month as 7-slot rows (Sun-first), nulls padding the edges. Pure so
// the heat map component stays a renderer.
export function monthGrid(year, month /* 1-12 */) {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const lead = first.getUTCDay();
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push(`${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
  }
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

// ── Formatters shared across the Results components ──────────────────────────
export const fmtUnits = (u) => (u == null ? "—" : `${u >= 0 ? "+" : "−"}${Math.abs(u).toFixed(1)}u`);

// The single money formatter for the whole Results surface. Every panel routes
// through here rather than inlining `$${(u * perUnit).toFixed(2)}` — seven
// hand-rolled copies of that expression are how a `perUnit` that was silently
// arriving as `true` (JSX shorthand, so ×1) survived on the headline cards while
// every other panel converted correctly.
//
// The rate guard is deliberate: a non-numeric perUnit falls back to 1u = $1
// rather than rendering NaN across the page.
export const fmtMoney = (u, perUnit = 1) => {
  if (u == null || !Number.isFinite(u)) return "—";
  const rate = Number.isFinite(perUnit) && perUnit > 0 ? perUnit : 1;
  const v = Math.abs(u * rate);
  // Cents carry information at $47.31 and none at $1,310.84 — past a thousand
  // they're four digits of noise in a column you're scanning for magnitude.
  const body = v >= 1000
    ? v.toLocaleString("en-US", { maximumFractionDigits: 0 })
    : v.toFixed(2);
  return `${u >= 0 ? "+" : "−"}$${body}`;
};
export const fmtPct = (v, digits = 1) => (v == null ? "—" : `${v.toFixed(digits)}%`);
export const fmtSigned = (v, digits = 1) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`);
export const fmtOdds = (v) => (v == null ? "—" : v > 0 ? `+${v}` : `${v}`);
export const fmtRecord = (r) => (r.n === 0 ? "—" : `${r.w}-${r.l}${r.pu > 0 ? `-${r.pu}` : ""}`);
