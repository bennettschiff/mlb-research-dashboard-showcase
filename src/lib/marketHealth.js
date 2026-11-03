// ══════════════════════════════════════════════════════════════════════════
// Market-health controller — the closed feedback loop (learning from results).
//
// Every prior "learning" artifact in this repo (feature-lab, mining engine,
// CLV miner, calibration monitor, threshold backtests) terminates at a
// markdown report a human must read and act on. This module is the piece
// that ACTS: scripts/edge-controller.mjs runs daily after grading, computes
// each market's rolling health from mlb_picks, and derives bounded controls
// that the live decision layer consumes (suggested units, weighted P/L
// track, EV lens).
//
// Design constraints (why the rules look like this):
//  - CLV is the primary signal — it converges in tens of picks, cash rate
//    needs hundreds. Sustained negative CLV = betting into steam = the cash
//    rate is luck (project_roi_clv_diagnosis_2026-06-21).
//  - Controls touch SIZING (unit_mult 0 / 0.5 / 1), never the pick gates or
//    saves. Suspended markets keep saving picks in shadow so CLV, grading,
//    and calibration keep accruing — the substrate that lets a market earn
//    its way back is never starved. This also keeps the project rule intact:
//    gates live in score space and are untouched here.
//  - Degradation is immediate, recovery is damped one step per evaluation
//    (suspended → throttled → active on consecutive good days), so a lucky
//    day can't flip a bleeding market straight back on.
//  - Every decision is written to market_health with the reasons that fired
//    — an audit trail you can read months later.
// ══════════════════════════════════════════════════════════════════════════

export const CONTROLLER_VERSION = "2026-07-02";

export const CONTROL_RULES = {
  WINDOW_DAYS: 30,
  // Minimum samples before a rule is allowed to act. Below these the rule
  // abstains (and if ALL rules abstain, the market holds its prior status).
  MIN_N_CLV: 25,
  MIN_N_ROI: 60,
  MIN_N_CALIB: 50,
  // CLV rule (percentage points, avg over window; negative = worse than close)
  CLV_SUSPEND: -3.0,
  CLV_THROTTLE: -1.5,
  // ROI rule (flat units P/L per graded pick over window)
  ROI_SUSPEND: -0.2,
  ROI_THROTTLE: -0.1,
  // Calibration rule (pred − actual, pp; only OVER-confidence is a hazard —
  // an underconfident market prices EV too low, which never buys a bad bet)
  CALIB_THROTTLE: 8.0,
  // Rolling prob-shift correction: log-odds shift bounds and minimum sample
  PROB_SHIFT_MIN_N: 50,
  PROB_SHIFT_CLAMP: 0.6,
};

export const STATUS_UNIT_MULT = { active: 1, throttled: 0.5, suspended: 0 };
const SEVERITY = { active: 0, throttled: 1, suspended: 2 };
const STATUS_BY_SEVERITY = ["active", "throttled", "suspended"];

// Derive today's control for one market from its rolling-window stats and
// yesterday's status. Pure — the whole controller brain is this function.
//   stats: { nGraded, unitsPl, avgClvPp, nClv, predPct, actualPct }
//     (percent fields are 0–100; unitsPl is flat-stake units; avgClvPp is pp)
//   prevStatus: 'active' | 'throttled' | 'suspended' (default 'active')
// Returns { status, unitMult, reasons: string[] }
export function deriveMarketControl(stats, prevStatus = "active") {
  const R = CONTROL_RULES;
  const reasons = [];
  let target = 0;
  let anyRuleActed = false;

  const { nGraded = 0, unitsPl = null, avgClvPp = null, nClv = 0, predPct = null, actualPct = null } = stats || {};

  // CLV rule
  if (avgClvPp != null && nClv >= R.MIN_N_CLV) {
    anyRuleActed = true;
    if (avgClvPp <= R.CLV_SUSPEND) {
      target = Math.max(target, 2);
      reasons.push(`CLV ${fmtPp(avgClvPp)} <= ${R.CLV_SUSPEND}pp over n=${nClv} (suspend)`);
    } else if (avgClvPp <= R.CLV_THROTTLE) {
      target = Math.max(target, 1);
      reasons.push(`CLV ${fmtPp(avgClvPp)} <= ${R.CLV_THROTTLE}pp over n=${nClv} (throttle)`);
    }
  }

  // ROI rule
  if (unitsPl != null && nGraded >= R.MIN_N_ROI) {
    anyRuleActed = true;
    const plPerPick = unitsPl / nGraded;
    if (plPerPick <= R.ROI_SUSPEND) {
      target = Math.max(target, 2);
      reasons.push(`P/L ${plPerPick.toFixed(2)}u/pick <= ${R.ROI_SUSPEND} over n=${nGraded} (suspend)`);
    } else if (plPerPick <= R.ROI_THROTTLE) {
      target = Math.max(target, 1);
      reasons.push(`P/L ${plPerPick.toFixed(2)}u/pick <= ${R.ROI_THROTTLE} over n=${nGraded} (throttle)`);
    }
  }

  // Calibration rule (overconfidence only)
  if (predPct != null && actualPct != null && nGraded >= R.MIN_N_CALIB) {
    anyRuleActed = true;
    const gap = predPct - actualPct;
    if (gap >= R.CALIB_THROTTLE) {
      target = Math.max(target, 1);
      reasons.push(`overconfident ${gap.toFixed(1)}pp (pred ${predPct.toFixed(1)} vs actual ${actualPct.toFixed(1)}) over n=${nGraded} (throttle)`);
    }
  }

  // Winning trumps theory (2026-07-02, same-day amendment): a market with
  // POSITIVE realized units over a real sample never gets zeroed by the CLV
  // or calibration rules — realized P/L is the ground truth this whole
  // system exists to maximize. Negative CLV on a winning market caps it at
  // throttled (half stake, flagged) instead: keep collecting at reduced
  // exposure until the units and the close stop disagreeing. A market
  // LOSING units still suspends regardless of positive CLV (the Ks case) —
  // the same principle pointed the other way.
  if (target === 2 && unitsPl != null && unitsPl > 0 && nGraded >= R.MIN_N_ROI) {
    target = 1;
    reasons.push(`BUT +${unitsPl.toFixed(1)}u realized over n=${nGraded} — winning market never zeroed, capped at throttle`);
  }

  const prev = SEVERITY[prevStatus] ?? 0;

  // No rule had enough data → hold prior status (never act on noise).
  if (!anyRuleActed) {
    return {
      status: STATUS_BY_SEVERITY[prev],
      unitMult: STATUS_UNIT_MULT[STATUS_BY_SEVERITY[prev]],
      reasons: [`insufficient sample (n=${nGraded}, nClv=${nClv}) — holding '${STATUS_BY_SEVERITY[prev]}'`],
    };
  }

  // Degrade immediately; recover one step per evaluation (damped).
  let next;
  if (target >= prev) {
    next = target;
  } else {
    next = prev - 1;
    reasons.push(`recovering: rules say '${STATUS_BY_SEVERITY[target]}', stepping ${STATUS_BY_SEVERITY[prev]} → ${STATUS_BY_SEVERITY[next]} (damped)`);
  }
  if (next === 0 && reasons.length === 0) reasons.push("healthy — all rules clear");

  const status = STATUS_BY_SEVERITY[next];
  return { status, unitMult: STATUS_UNIT_MULT[status], reasons };
}

// ── Rolling probability correction (EV-lens honesty) ────────────────────────
// The per-market calibrations in models.js are constants fit once; the
// calibration monitor shows they drift (tb +13pp, hrr +15.6pp overconfident,
// 2026-06-30). This fits a single bounded log-odds shift on the rolling
// window so the EV/edge lens can use an honest probability WITHOUT touching
// modelImpliedProb (golden tests + gates stay frozen; score space untouched).
//   picks: [{ modelProb (0–1), won (bool) }]
// Returns shift (log-odds, clamped) or null when the sample is too thin.
export function fitProbShift(picks) {
  const R = CONTROL_RULES;
  const usable = (picks || []).filter(p => p && p.modelProb != null && p.modelProb > 0 && p.modelProb < 1 && typeof p.won === "boolean");
  if (usable.length < R.PROB_SHIFT_MIN_N) return null;
  const meanPred = usable.reduce((s, p) => s + Number(p.modelProb), 0) / usable.length;
  const actual = usable.filter(p => p.won).length / usable.length;
  const shift = logit(clamp01(actual)) - logit(clamp01(meanPred));
  const clamped = Math.max(-R.PROB_SHIFT_CLAMP, Math.min(R.PROB_SHIFT_CLAMP, shift));
  return Math.round(clamped * 1000) / 1000;
}

export function applyProbShift(p, shift) {
  if (p == null || shift == null || !Number.isFinite(shift)) return p;
  const x = logit(clamp01(p));
  return 1 / (1 + Math.exp(-(x + shift)));
}

function clamp01(p) { return Math.min(1 - 1e-6, Math.max(1e-6, p)); }
function logit(p) { return Math.log(p / (1 - p)); }
function fmtPp(v) { return `${v > 0 ? "+" : ""}${Number(v).toFixed(1)}pp`; }

// ── Client-side lookup over market_health rows ──────────────────────────────
// Built from the market-health view rows (api/picks.js ?view=market-health) ({ eval_date, market, status,
// unit_mult, prob_shift, ... }). Two views:
//   latest(market)        → most recent control row (for today's sizing/EV)
//   multFor(market, date) → unit_mult in force ON that date (weighted P/L
//                           track). Dates before the controller existed → 1.
// Module-level active lookup. App.jsx fetches the market-health view once on
// mount and installs the lookup here; the sizing functions in picks.js read
// it by default so the deep board-render call sites need no prop threading.
// Null (tests, fetch failure, pre-deploy) → all controls are identity.
let _activeHealth = null;
export function setActiveHealthLookup(lookup) { _activeHealth = lookup; }
export function getActiveHealthLookup() { return _activeHealth; }

export function buildHealthLookup(rows) {
  const byMarket = new Map();
  for (const r of rows || []) {
    if (!r?.market || !r?.eval_date) continue;
    if (!byMarket.has(r.market)) byMarket.set(r.market, []);
    byMarket.get(r.market).push(r);
  }
  for (const list of byMarket.values()) {
    list.sort((a, b) => (a.eval_date < b.eval_date ? -1 : a.eval_date > b.eval_date ? 1 : 0));
  }
  return {
    latest(market) {
      const list = byMarket.get(market);
      return list?.length ? list[list.length - 1] : null;
    },
    multFor(market, date) {
      const list = byMarket.get(market);
      if (!list?.length || !date) return 1;
      // latest row with eval_date <= pick date; none → pre-controller era → 1
      let best = null;
      for (const r of list) {
        if (r.eval_date <= date) best = r; else break;
      }
      return best ? Number(best.unit_mult) : 1;
    },
    markets() { return [...byMarket.keys()]; },
  };
}
