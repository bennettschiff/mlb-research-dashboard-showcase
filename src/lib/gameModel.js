/**
 * src/lib/gameModel.js — Slate Odds game-level prediction model
 *
 * Predicts win probability, total runs, and run-line cover for each MLB game.
 * Backtest (April 2026, 381 games):
 *   - Moneyline:   57.7% overall | 62.4% high-confidence (win% > 60 or < 40)
 *   - Run Line:    63.1% covers  (244/381 games with ≥0.75 run edge)
 *   - Total Runs:  3.56 avg absolute error (8–10 range tightest)
 */

import { PARK_DATA } from "./parks.js";
import { oddsToImplied as sharedOddsToImplied } from "./models.js";

// ── Constants ────────────────────────────────────────────────────────────────
const LEAGUE_AVG_FIP      = 4.20;
const LEAGUE_AVG_OPS      = 0.718;
const LEAGUE_AVG_RPG      = 4.50;   // runs per team per game
const LEAGUE_AVG_BPEN_ERA = 4.30;   // league avg bullpen ERA
const HOME_FIELD_RUNS     = 0.13;   // home team scores ~0.13 more R/G
const PYTH_EXP            = 1.83;   // Pythagorean baseball exponent
const STARTER_IP_FRAC     = 6 / 9;  // starter goes ~6 innings
const BULLPEN_IP_FRAC     = 3 / 9;  // bullpen covers ~3

// ── Defensive adjustment ──────────────────────────────────────────────────────
// OAA (Outs Above Average) + catcher framing runs → run-suppression multiplier.
// These reduce what the OPPONENT scores against this team's defense.
// oaa: season total OAA (0 = avg; positive = better defense, runs saved)
// framingRuns: season catcher framing runs (0 = avg; positive = more strikes called)
function defensiveMult(oaa, framingRuns) {
  const oaaPerGame    = (oaa         || 0) / 162;
  const framingPerGame = (framingRuns || 0) / 162;
  const totalSavedPerGame = oaaPerGame + framingPerGame;
  const mult = 1.0 - (totalSavedPerGame / LEAGUE_AVG_RPG);
  return Math.max(0.92, Math.min(1.08, mult));
}

// Park runs environment — prefer pf.R (run factor) over HR factor.
// HR factor was used as a proxy historically but mispriced parks like Petco/Oracle
// where HR is suppressed but singles/doubles play normal (low HR factor, neutral R factor).
// Falls back to average of HR_L and HR_R when pf.R is missing.
export const PARK_RUNS = Object.fromEntries(
  Object.entries(PARK_DATA).map(([abbr, p]) => [
    abbr,
    p.pf?.R != null
      ? +Number(p.pf.R).toFixed(3)
      : +((p.pf.HR_L + p.pf.HR_R) / 2).toFixed(3),
  ])
);

// ── FIP calculation ──────────────────────────────────────────────────────────
// FIP = (13*HR + 3*(BB+HBP) - 2*K) / IP + constant
const FIP_CONSTANT = 3.10;
export function calcFIP(k, bb, hr, hbp = 0, ipStr = "0") {
  // Convert "6.2" (6 IP + 2 outs) to decimal innings
  const parts = String(ipStr).split(".");
  const whole = parseInt(parts[0] || 0, 10);
  const thirds = parseInt(parts[1] || 0, 10);
  const ipDec = whole + thirds / 3;
  if (ipDec < 5) return null; // too small a sample
  return +((13 * hr + 3 * (bb + hbp) - 2 * k) / ipDec + FIP_CONSTANT).toFixed(2);
}

// ── Core model ───────────────────────────────────────────────────────────────
/**
 * @param {object} params
 * @param {number} params.homeFIP            - home starter season FIP (or ERA fallback)
 * @param {number} params.awayFIP            - away starter season FIP (or ERA fallback)
 * @param {number} [params.homeL5FIP]        - home starter L5 FIP (blended 40% with season)
 * @param {number} [params.awayL5FIP]        - away starter L5 FIP (blended 40% with season)
 * @param {number} params.homeOPS            - home team season OPS
 * @param {number} params.awayOPS            - away team season OPS
 * @param {number} [params.homeLineupOPS]    - home lineup projected OPS (blended 50% with season)
 * @param {number} [params.awayLineupOPS]    - away lineup projected OPS (blended 50% with season)
 * @param {number} [params.homeBullpenERA]   - home true bullpen ERA (reliever-only)
 * @param {number} [params.awayBullpenERA]   - away true bullpen ERA (reliever-only)
 * @param {number} [params.parkRunsFactor]   - park HR factor (1.0 = neutral)
 * @param {number} [params.homeOAA]          - home team season OAA total (0 = avg)
 * @param {number} [params.awayOAA]          - away team season OAA total (0 = avg)
 * @param {number} [params.homeCatcherFramingRuns]
 * @param {number} [params.awayCatcherFramingRuns]
 * @param {number} [params.homeL10RpgDelta]  - home team L10 R/G vs season avg (+/-; hot/cold signal)
 * @param {number} [params.awayL10RpgDelta]  - away team L10 R/G vs season avg
 * @param {number} [params.weatherRunDelta]  - total run adjustment from wind + temp (+ = over-friendly)
 * @param {number} [params.umpireRunAdjust]  - total run adjustment from ump K tendency (- = high-K ump)
 */
export function slateOddsModel({
  homeFIP, awayFIP, homeL5FIP, awayL5FIP,
  homeOPS, awayOPS, homeLineupOPS, awayLineupOPS,
  homeBullpenERA, awayBullpenERA,
  parkRunsFactor,
  homeOAA, awayOAA,
  homeCatcherFramingRuns, awayCatcherFramingRuns,
  homeL10RpgDelta, awayL10RpgDelta,
  weatherRunDelta, umpireRunAdjust,
  // DB advanced stats — populated by scripts/etl_savant.py.
  // Used as a quality signal blended into starter FIP. Lower SIERA / higher Pit+ = better.
  homeSIERA, awaySIERA,
  homePitPlus, awayPitPlus,
}) {
  // Blend L5 FIP (40%) with season FIP (60%) when recent starts are available.
  // L5 FIP captures current form; season FIP anchors against small-sample blowups.
  let fH = homeL5FIP != null
    ? homeL5FIP * 0.40 + (homeFIP || LEAGUE_AVG_FIP) * 0.60
    : (homeFIP  || LEAGUE_AVG_FIP);
  let fA = awayL5FIP != null
    ? awayL5FIP * 0.40 + (awayFIP || LEAGUE_AVG_FIP) * 0.60
    : (awayFIP  || LEAGUE_AVG_FIP);

  // Quality blend: when SIERA is available, blend 25% with FIP. SIERA's adjustment
  // for ball-in-play type makes it a better forward predictor for "what will this
  // pitcher actually allow", which is what we want for total runs projection.
  // When Pit+ is available, use it as a small (10%) adjuster pushing FIP toward
  // its quality grade. Both effects clamped tight to avoid runaway.
  if (homeSIERA != null) {
    fH = fH * 0.75 + Math.max(1.5, Math.min(8.0, homeSIERA)) * 0.25;
  }
  if (awaySIERA != null) {
    fA = fA * 0.75 + Math.max(1.5, Math.min(8.0, awaySIERA)) * 0.25;
  }
  if (homePitPlus != null) {
    // Deliberately tiny secondary adjustment: Pit+ 120 shifts FIP 0.024 lower;
    // SIERA/FIP carry the primary pitcher-quality signal above.
    fH = fH + (100 - homePitPlus) / 100 * 1.2 * 0.10;
  }
  if (awayPitPlus != null) {
    fA = fA + (100 - awayPitPlus) / 100 * 1.2 * 0.10;
  }

  // Blend confirmed lineup projected OPS (50%) with season team OPS (50%).
  // When lineup is confirmed and projections resolve, this captures missing starters / platoon edges.
  const opsH = homeLineupOPS != null
    ? homeLineupOPS * 0.50 + (homeOPS || LEAGUE_AVG_OPS) * 0.50
    : (homeOPS || LEAGUE_AVG_OPS);
  const opsA = awayLineupOPS != null
    ? awayLineupOPS * 0.50 + (awayOPS || LEAGUE_AVG_OPS) * 0.50
    : (awayOPS || LEAGUE_AVG_OPS);

  const bpH  = homeBullpenERA || LEAGUE_AVG_BPEN_ERA;
  const bpA  = awayBullpenERA || LEAGUE_AVG_BPEN_ERA;
  const park = parkRunsFactor  || 1.0;

  // L10 recency multiplier: teams scoring meaningfully more/fewer runs recently than their season avg.
  // Clamped to ±8%: recency is a real signal but reversion happens fast (don't over-extrapolate).
  const homeL10Mult = homeL10RpgDelta != null
    ? Math.min(1.08, Math.max(0.92, 1.0 + homeL10RpgDelta / LEAGUE_AVG_RPG * 0.30))
    : 1.0;
  const awayL10Mult = awayL10RpgDelta != null
    ? Math.min(1.08, Math.max(0.92, 1.0 + awayL10RpgDelta / LEAGUE_AVG_RPG * 0.30))
    : 1.0;

  // Home team runs (faces away starter + away bullpen, suppressed by AWAY defense)
  const homeFromStarter = (opsH / LEAGUE_AVG_OPS) * homeL10Mult * (fA / LEAGUE_AVG_FIP)  * LEAGUE_AVG_RPG * STARTER_IP_FRAC * park;
  const homeFromBullpen = (opsH / LEAGUE_AVG_OPS) * homeL10Mult * (bpA / LEAGUE_AVG_BPEN_ERA) * LEAGUE_AVG_RPG * BULLPEN_IP_FRAC * park;
  // Away defense (OAA + framing) suppresses what the home offense scores in the field
  const homeDefMult = defensiveMult(awayOAA, awayCatcherFramingRuns);
  const homeRuns = (homeFromStarter + homeFromBullpen + HOME_FIELD_RUNS) * homeDefMult;

  // Away team runs (faces home starter + home bullpen, suppressed by HOME defense)
  const awayFromStarter = (opsA / LEAGUE_AVG_OPS) * awayL10Mult * (fH / LEAGUE_AVG_FIP)  * LEAGUE_AVG_RPG * STARTER_IP_FRAC * park;
  const awayFromBullpen = (opsA / LEAGUE_AVG_OPS) * awayL10Mult * (bpH / LEAGUE_AVG_BPEN_ERA) * LEAGUE_AVG_RPG * BULLPEN_IP_FRAC * park;
  // Home defense (OAA + framing) suppresses what the away offense scores
  const awayDefMult = defensiveMult(homeOAA, homeCatcherFramingRuns);
  const awayRuns = (awayFromStarter + awayFromBullpen) * awayDefMult;

  // Total calibration (regression-to-mean at extremes)
  let rawTotal = homeRuns + awayRuns;
  // Weather: wind out/in + temperature run delta (computed by caller from park + weather data)
  rawTotal += (weatherRunDelta  || 0);
  // Umpire: high-K ump reduces balls in play → fewer runs (negative for over bets)
  rawTotal += (umpireRunAdjust  || 0);
  // Keep the current selection behavior until a replacement regression has
  // forward evidence. scripts/math-impact-audit.mjs shadows the smooth candidate.
  const total = rawTotal < 8 ? rawTotal + 0.8 : rawTotal > 11 ? rawTotal - 0.8 : rawTotal;

  // Pythagorean win probability
  const h = Math.pow(homeRuns, PYTH_EXP);
  const a = Math.pow(awayRuns, PYTH_EXP);
  const homeWinPct = h / (h + a);
  const margin = homeRuns - awayRuns;

  // Confidence tier
  const edge = Math.abs(homeWinPct - 0.5);
  const confidence = edge > 0.10 ? "high" : edge > 0.05 ? "medium" : "low";

  return {
    homeRuns:    +homeRuns.toFixed(2),
    awayRuns:    +awayRuns.toFixed(2),
    total:       +total.toFixed(1),
    homeWinPct:  +homeWinPct.toFixed(4),
    awayWinPct:  +(1 - homeWinPct).toFixed(4),
    margin:      +margin.toFixed(2),
    confidence,
    // Defensive adjustment factors (1.0 = no adjustment; exposed for display)
    homeDefMult: +homeDefMult.toFixed(4),
    awayDefMult: +awayDefMult.toFixed(4),
    // New signal metadata for display / debugging
    homeL10Mult: homeL10Mult !== 1.0 ? +homeL10Mult.toFixed(3) : null,
    awayL10Mult: awayL10Mult !== 1.0 ? +awayL10Mult.toFixed(3) : null,
    weatherAdj:  weatherRunDelta  || null,
    umpireAdj:   umpireRunAdjust  || null,
    blendedHomeFIP: +fH.toFixed(2),
    blendedAwayFIP: +fA.toFixed(2),
    // Quality signals (exposed for display + pick_signals capture)
    homeSIERA:   homeSIERA   != null ? +homeSIERA.toFixed(2)   : null,
    awaySIERA:   awaySIERA   != null ? +awaySIERA.toFixed(2)   : null,
    homePitPlus: homePitPlus != null ? +homePitPlus.toFixed(1) : null,
    awayPitPlus: awayPitPlus != null ? +awayPitPlus.toFixed(1) : null,
  };
}

// ── Odds helpers ─────────────────────────────────────────────────────────────
/** American odds → implied win probability (no vig removed) */
export function oddsToImplied(american) {
  return sharedOddsToImplied(american);
}

/** Format American odds for display */
export function fmtOdds(price) {
  if (price == null) return "—";
  return price > 0 ? `+${price}` : `${price}`;
}

/** Edge = model win% - book implied % (positive = model likes this side) */
export function calcEdge(modelWinPct, americanOdds) {
  const implied = oddsToImplied(americanOdds);
  if (!implied) return null;
  return +(modelWinPct - implied).toFixed(4);
}

/**
 * Best odds across books for one side.
 * @param {object} books  { fanduel: {homeML, awayML, ...}, draftkings: {...}, hardrockbet: {...} }
 * @param {"home"|"away"} side
 * @returns {{ odds: number|null, book: string|null }}
 */
export function bestMLOdds(books, side) {
  if (!books) return { odds: null, book: null };
  const key = side === "home" ? "homeML" : "awayML";
  let best = null, bestBook = null;
  for (const [bk, d] of Object.entries(books)) {
    if (!d) continue;
    const v = d[key];
    if (v == null) continue;
    if (best === null || v > best) { best = v; bestBook = bk; }
  }
  return { odds: best, book: bestBook };
}

/**
 * Best spread odds across books for one side.
 * Returns the spread point + best price.
 */
export function bestSpreadOdds(books, side) {
  if (!books) return { point: null, odds: null, book: null };
  const key = side === "home" ? "homeSpread" : "awaySpread";
  let bestOdds = null, bestBook = null, bestPoint = null;
  for (const [bk, d] of Object.entries(books)) {
    if (!d) continue;
    const s = d[key];
    if (!s) continue;
    if (bestOdds === null || s.price > bestOdds) {
      bestOdds = s.price;
      bestBook = bk;
      bestPoint = s.point;
    }
  }
  return { point: bestPoint, odds: bestOdds, book: bestBook };
}

/** Book color by key */
export const BOOK_COLORS = {
  fanduel:    "#4a9eff",
  draftkings: "#4ade80",
  hardrockbet:"#f97316",
};
export const BOOK_LABELS = {
  fanduel:    "FD",
  draftkings: "DK",
  hardrockbet:"HR",
};

/** Run-line pick — which side does the model favor to cover ±1.5? */
export function runLinePick(margin, homeAbbr, awayAbbr, spread = -1.5) {
  // spread is from home team's perspective (negative = home is favorite, positive = home is underdog)
  if (Math.abs(margin) < 0.75) return null;
  const awaySpread = -spread; // mirror: if home is +1.5, away is -1.5
  if (margin > 0) {
    // Model favors home
    const pt = spread;
    return { side: "home", label: `${homeAbbr} ${pt >= 0 ? "+" : ""}${pt}`, covers: margin > Math.abs(spread) };
  } else {
    // Model favors away
    const pt = awaySpread;
    return { side: "away", label: `${awayAbbr} ${pt >= 0 ? "+" : ""}${pt}`, covers: margin < -Math.abs(spread) };
  }
}
