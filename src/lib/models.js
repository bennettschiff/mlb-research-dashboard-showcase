// ── Prediction models (public reference implementation) ─────────────────────
//
// The production model and its calibration are private. This file is a
// structural stand-in: it exports the same functions, with the same inputs and
// the same output shapes, so the rest of the app (boards, panels, settlement,
// tests) runs unchanged. The math here is deliberately simple:
//
//   rate      = Bayesian blend of projection, season and recent form
//   context   = neutral multipliers (1.0) for park / pitcher / arsenal / etc.
//   pricing   = Poisson (counting stats) or Normal (strikeouts) on that rate
//
// The odds / EV / Kelly helpers are textbook and identical to production.
// Every constant below is illustrative, not fitted.
//
// All pure math: no React, no fetch, no browser APIs.
import { batterProjRates, pitcherProjRates } from './projections.js';

// ── Blending ─────────────────────────────────────────────────────────────────

/** Weight on the preseason projection, decaying as games accumulate. */
export function projWeight(gamesPlayed) { return Math.max(0.10, 1.0 - (gamesPlayed / 120)); }

/** Bayesian shrinkage: after `regressionN` trials the observed rate has 50% weight. */
export function bayesRate(observed, trials, priorRate, regressionN) {
  if (trials == null || trials < 0) trials = 0;
  return (observed + priorRate * regressionN) / (trials + regressionN);
}

export function blend(projVal, actualVal, gp) {
  if (projVal == null && actualVal == null) return null;
  if (projVal == null) return actualVal;
  if (actualVal == null) return projVal;
  const pw = projWeight(gp);
  return projVal * pw + actualVal * (1 - pw);
}

/** Batter-vs-pitcher history, trusted in proportion to sample size. */
export function bvpWeighted(bvpVal, baselineVal, bvpABs, threshold = 50) {
  if (bvpVal == null || bvpABs == null || bvpABs === 0) return baselineVal || 0;
  const conf = Math.min(bvpABs / threshold, 1.0);
  return bvpVal * conf + (baselineVal || 0) * (1 - conf);
}

// ── Probability & EV utilities (textbook) ────────────────────────────────────

/** American odds → implied probability (includes vig). */
export function oddsToImplied(american) {
  if (!Number.isFinite(american) || american === 0) return null;
  if (american > 0) return 100 / (american + 100);
  return Math.abs(american) / (Math.abs(american) + 100);
}

/** Probability → fair American odds (no vig). */
export function probToAmericanOdds(prob) {
  if (!Number.isFinite(prob) || prob <= 0 || prob >= 1) return null;
  if (prob >= 0.5) return Math.round(-(prob / (1 - prob)) * 100);
  return Math.round(((1 - prob) / prob) * 100);
}

/** Standard normal CDF (Abramowitz & Stegun 7.1.26). */
export function normalCDF(z) {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-x * x);
  return (1 + sign * y) / 2;
}

export function poissonPMF(lambda, k) {
  if (!(lambda >= 0) || k < 0) return 0;
  let logP = -lambda + k * Math.log(lambda || 1e-12);
  for (let i = 2; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
}

/** Poisson P(X >= k). */
export function poissonGTE(lambda, k) {
  if (!(lambda > 0)) return k <= 0 ? 1 : 0;
  if (k <= 0) return 1;
  let cdf = 0;
  for (let i = 0; i < k; i++) cdf += poissonPMF(lambda, i);
  return Math.max(0, Math.min(1, 1 - cdf));
}

/** Win/push split for a Poisson count against a (possibly whole-number) line. */
export function poissonSideProb(lambda, line, direction = 'over') {
  const isWhole = Number.isInteger(line);
  const push = isWhole ? poissonPMF(lambda, line) : 0;
  const over = poissonGTE(lambda, Math.floor(line) + 1);
  const win = direction === 'over' ? over : 1 - over - push;
  const decided = 1 - push;
  return { win, push, conditional: decided > 0 ? win / decided : null };
}

// Negative binomial (overdispersed counts, e.g. game run totals).
export const OU_NEGBIN_R = 8; // illustrative dispersion

export function negbinPMF(mu, r, k) {
  if (!(mu > 0) || k < 0) return 0;
  const p = r / (r + mu);
  let logC = 0;
  for (let i = 0; i < k; i++) logC += Math.log(r + i) - Math.log(i + 1);
  return Math.exp(logC + r * Math.log(p) + k * Math.log(1 - p));
}

export function negbinGTE(mu, r, k) {
  if (k <= 0) return 1;
  let cdf = 0;
  for (let i = 0; i < k; i++) cdf += negbinPMF(mu, r, i);
  return Math.max(0, Math.min(1, 1 - cdf));
}

export function negbinSideProb(mu, line, direction = 'over', r = OU_NEGBIN_R) {
  const isWhole = Number.isInteger(line);
  const push = isWhole ? negbinPMF(mu, r, line) : 0;
  const over = negbinGTE(mu, r, Math.floor(line) + 1);
  const win = direction === 'over' ? over : 1 - over - push;
  const decided = 1 - push;
  return { win, push, conditional: decided > 0 ? win / decided : null };
}

/** Shrink the model's total toward the market's line before pricing. */
export const OU_EDGE_SHRINK = 0.25; // illustrative

/** Mean whose over/under is a coin flip at this line (bisection). */
export function negbinFairMean(line, r = OU_NEGBIN_R) {
  let lo = 0.1, hi = line * 2 + 5;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const { conditional } = negbinSideProb(mid, line, 'over', r);
    if ((conditional ?? 0) < 0.5) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

export function ouSideProb(modelTotal, line, direction = 'over', k = OU_EDGE_SHRINK, r = OU_NEGBIN_R) {
  if (!Number.isFinite(modelTotal) || !Number.isFinite(line)) return null;
  const fair = negbinFairMean(line, r);
  const mu = fair + k * (modelTotal - line);
  return negbinSideProb(mu, line, direction, r);
}

export function directionalModelProb(score, propType, line, direction = 'over') {
  const pOver = modelImpliedProb(score, propType, line);
  if (pOver == null) return null;
  return direction === 'under' ? 1 - pOver : pOver;
}

// ── Score → probability ──────────────────────────────────────────────────────

export const AVG_PA_PER_GAME = 4.0;
const K_STDDEV = 2.2; // illustrative spread of strikeouts around expectation

/** Logistic map from an RBI rate to P(RBI ≥ 1). Illustrative coefficients. */
export function rbiCalibratedProb(score) {
  if (score == null || !Number.isFinite(score) || score <= 0) return null;
  return 1 - Math.exp(-score);
}

export const TB_FITTED_LINES = new Set([1.5, 2.5]);

export function hasFittedLine(propType, line) {
  return propType === 'tb' ? TB_FITTED_LINES.has(line) : modelImpliedProb(1, propType, line) != null;
}

/**
 * P(over `line`) for a model score. Batter scores are per-AB (hits, HR, 1B, 2B)
 * or per-game (TB, HRR, RBI, SB) rates; pitcher K score is expected strikeouts.
 */
export function modelImpliedProb(score, propType, line = 0.5) {
  if (!score || score <= 0) return null;
  const k = Math.floor(line) + 1;
  switch (propType) {
    case 'hits':
    case 'singles':
    case 'doubles':
    case 'triples':
    case 'hr':
      return poissonGTE(score * AVG_PA_PER_GAME, k);
    case 'tb':
    case 'hrr':
    case 'sb':
      return poissonGTE(score, k);
    case 'rbi':
      return line <= 0.5 ? rbiCalibratedProb(score) : poissonGTE(score, k);
    case 'ks':
      return 1 - normalCDF((line + 0.5 - score) / K_STDDEV);
    default:
      return null;
  }
}

// Optional challenger blend: the public build has no fitted challenger, so these
// fall through to the base model.
export function atomValue(x) {
  const v = (typeof x === 'number' || (typeof x === 'string' && x.trim() !== '')) ? Number(x) : NaN;
  return Number.isFinite(v) ? v : null;
}

export function batterBlendHist(seasonStats, mkt) {
  const games = parseInt(seasonStats?.gamesPlayed) || 0;
  if (!games) return null;
  const h = parseInt(seasonStats?.hits) || 0;
  const r = parseInt(seasonStats?.runs) || 0;
  const bi = parseInt(seasonStats?.rbi) || 0;
  const hr = parseInt(seasonStats?.homeRuns) || 0;
  const tb = parseInt(seasonStats?.totalBases) || 0;
  const sumVal = { hits: h, tb, hr, hrr: h + r + bi, rbi: bi }[mkt];
  if (sumVal == null) return null;
  return { sumVal, games, atBats: parseInt(seasonStats?.atBats) || 0 };
}

export function panelChallengerProb() { return null; }

export function blendedImpliedProb(score, mkt, line) {
  return modelImpliedProb(score, mkt, line);
}

/** Expected value per unit staked. 0.08 = +8%. */
export function calcEVFromOdds(modelProb, americanOdds, pushProb = 0) {
  if (!Number.isFinite(modelProb) || modelProb < 0 || modelProb > 1 || !Number.isFinite(americanOdds) || americanOdds === 0) return null;
  if (!Number.isFinite(pushProb) || pushProb < 0 || pushProb >= 1) return null;
  const payout = americanOdds > 0 ? americanOdds / 100 : 100 / Math.abs(americanOdds);
  return (1 - pushProb) * (modelProb * payout - (1 - modelProb));
}

/**
 * Quarter-Kelly, bucketed to 0–5 units. Opt-in: an uncalibrated probability
 * should never size a stake, so this returns 0 unless `validated` is set.
 */
export function computeKellyUnits(modelProb, americanOdds, { validated = false, maxUnits = 5 } = {}) {
  if (!validated || modelProb == null || americanOdds == null) return 0;
  const p = Number(modelProb);
  const odds = Number(americanOdds);
  if (!Number.isFinite(p) || p <= 0 || p >= 1 || !Number.isFinite(odds) || odds === 0) return 0;
  const b = odds > 0 ? odds / 100 : 100 / Math.abs(odds);
  const fullKelly = (p * b - (1 - p)) / b;
  if (fullKelly <= 0) return 0;
  const qk = fullKelly / 4;
  const units = qk < 0.01 ? 0 : qk < 0.02 ? 1 : qk < 0.04 ? 2 : qk < 0.06 ? 3 : qk < 0.08 ? 4 : 5;
  return Math.min(Math.max(0, Math.floor(maxUnits)), units);
}

const PROP_LINES = {
  hits: [0.5, 1.5, 2.5, 3.5],
  hrr: [1.5, 2.5, 3.5, 4.5, 5.5],
  tb: [1.5, 2.5],
  singles: [0.5, 1.5, 2.5],
  hr: [0.5],
  doubles: [0.5, 1.5],
  sb: [0.5, 1.5],
  rbi: [0.5, 1.5, 2.5],
  ks: [4.5, 5.5, 6.5, 7.5, 8.5, 9.5, 10.5],
};

/** Highest line whose model probability sits in the actionable 50–70% band. */
export function findBestLine(score, propType) {
  const lines = PROP_LINES[propType] || [0.5];
  for (let i = lines.length - 1; i >= 0; i--) {
    const prob = modelImpliedProb(score, propType, lines[i]);
    if (prob != null && prob >= 0.50 && prob <= 0.70) {
      return { line: lines[i], impliedProb: prob, fairLine: probToAmericanOdds(prob) };
    }
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const prob = modelImpliedProb(score, propType, lines[i]);
    if (prob != null && prob >= 0.50) {
      return { line: lines[i], impliedProb: prob, fairLine: probToAmericanOdds(prob) };
    }
  }
  const prob = modelImpliedProb(score, propType, lines[0]);
  return { line: lines[0], impliedProb: prob, fairLine: probToAmericanOdds(prob) };
}

/** Best American price across books for one prop. */
export function bestBookOdds(bookObj) {
  if (!bookObj) return null;
  let best = null;
  for (const price of Object.values(bookObj)) {
    if (price == null) continue;
    if (best === null || price > best) best = price;
  }
  return best;
}

// ── Full line ladder (Brain Trust tab) ───────────────────────────────────────

export const BRAIN_TRUST_LINES = {
  hits: [0.5, 1.5, 2.5, 3.5],
  hrr: [0.5, 1.5, 2.5, 3.5],
  tb: [0.5, 1.5, 2.5, 3.5, 4.5],
  rbi: [0.5, 1.5, 2.5],
  hr: [0.5],
  sb: [0.5, 1.5],
  ks: [1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5, 8.5, 9.5, 10.5],
};

// Which (market, line) pairs are calibrated well enough to size and parlay
// ('trusted') versus rank-order only ('directional').
const TRUSTED_LINES = {
  hits: new Set([0.5, 1.5, 2.5]),
  hrr:  new Set([0.5, 1.5, 2.5, 3.5]),
  tb:   new Set([1.5, 2.5]),
  rbi:  new Set([0.5, 1.5, 2.5]),
  hr:   new Set([0.5]),
  sb:   new Set([0.5]),
  ks:   new Set([1.5, 2.5, 3.5]),
};
export function lineTrust(propType, line) {
  return TRUSTED_LINES[propType]?.has(line) ? 'trusted' : 'directional';
}

export function impliedBreakeven(americanOdds) {
  if (!Number.isFinite(americanOdds) || americanOdds === 0) return null;
  return americanOdds > 0 ? 100 / (americanOdds + 100) : -americanOdds / (-americanOdds + 100);
}

/** Model probability at every line, clamped monotone, with edge/EV when odds exist. */
export function gradeAllLines(score, propType, oddsByLine = null) {
  if (score == null || !Number.isFinite(score) || score <= 0) return [];
  const base = BRAIN_TRUST_LINES[propType] || [0.5];
  const extra = oddsByLine ? Object.keys(oddsByLine).map(Number).filter(Number.isFinite) : [];
  const lines = [...new Set([...base, ...extra])].sort((a, b) => a - b);
  const out = [];
  let prev = 1;
  for (const line of lines) {
    let prob = modelImpliedProb(score, propType, line);
    if (prob == null || !Number.isFinite(prob)) continue;
    prob = Math.min(prob, prev);
    prev = prob;
    const odds = oddsByLine?.[line];
    const hasOdds = Number.isFinite(odds);
    out.push({
      line,
      modelProb: prob,
      trust: lineTrust(propType, line),
      fairOdds: probToAmericanOdds(prob),
      bookOdds: hasOdds ? odds : null,
      edge: hasOdds ? prob - impliedBreakeven(odds) : null,
      ev: hasOdds ? calcEVFromOdds(prob, odds) : null,
    });
  }
  return out;
}

// ── Context multipliers ──────────────────────────────────────────────────────
// Production adjusts for game environment, park, rest, lineup slot, pitch-type
// matchup, plate discipline, batted-ball profile and more. The public build
// keeps every hook but returns a neutral 1.0 (or a neutral object), so the
// pipeline shape is visible without the fitted values.

export function computeGameEnvMult() { return 1.0; }
export function computePullParkMult() { return 1.0; }
export function computePitcherRestMult() { return 1.0; }

/** Days since the pitcher's last appearance, from a StatsAPI game log. */
export function computeRestDays(gameLog, todayStr) {
  const last = (gameLog || []).map(g => g.date).filter(Boolean).sort().pop();
  if (!last || !todayStr) return null;
  const ms = new Date(`${todayStr}T12:00:00Z`) - new Date(`${last}T12:00:00Z`);
  return Number.isFinite(ms) ? Math.round(ms / 86_400_000) : null;
}

/** Plate appearances by lineup slot relative to the league average (~4.2 PA). */
export function battingOrderPAMult(order) {
  if (!Number.isFinite(order) || order < 1 || order > 9) return 1.0;
  return 1 + (5 - order) * 0.025; // leadoff ≈ +10%, ninth ≈ −10%
}

export function batterSeqSignals(lineupSlot) {
  const expectedBattersFaced = 24;
  const seqs = [];
  if (Number.isFinite(lineupSlot)) for (let s = lineupSlot; s <= expectedBattersFaced; s += 9) seqs.push(Math.ceil(s / 9));
  return {
    expectedBattersFaced,
    expectedPAvsStarter: seqs.length,
    avgBatterSeqNum: seqs.length ? seqs.reduce((a, b) => a + b, 0) / seqs.length : 0,
  };
}

/** Shannon entropy (bits) of a pitcher's pitch-usage mix. */
export function pitchMixEntropy(pitcherArsenal) {
  const usage = (pitcherArsenal || []).map(p => Number(p.usage ?? p.pct ?? 0)).filter(u => u > 0);
  const total = usage.reduce((a, b) => a + b, 0);
  if (!total) return null;
  return -usage.reduce((h, u) => h + (u / total) * Math.log2(u / total), 0);
}

export function computeArsenalMatchup(batterPitchData, pitcherArsenal) {
  return {
    mult: 1.0, avgXwoba: null, avgWhiff: null, avgRv100: null, avgXslg: null, avgHardHit: null,
    topPitch: null, coverage: 0, mixEntropy: pitchMixEntropy(pitcherArsenal),
  };
}
export function computeBatterDisciplineMult() { return 1.0; }
export function computeBatterKVulnerability() { return { mult: 1.0, avgKPct: null, coverage: 0 }; }
export function computePitcherDbQualityMult() { return null; }
export function computeHRFBVeloMult() { return 1.0; }
export function computePitcherBattedBallMult() { return 1.0; }
export function computePitcherContactQualityMult() { return 1.0; }
export function computePitcherExtensionMult() { return 1.0; }
export function computePitcherArmAngleMult() { return 1.0; }
export function computeHRLuckMult() { return 1.0; }
export function computeExpectedStatsLuck() { return 1.0; }
export function computeBattedBallHRMult() { return 1.0; }
export function computeBasestealingMult() { return 1.0; }
export function computePitcherHoldingMult() { return 1.0; }

export const LEAGUE_IDEAL_ATTACK_RATE = 0.5;
export const ATTACK_ANGLE_LEVEL = { TB: 1, HR: 1 };
export const HRR_ATTACK_ANGLE_LEVEL = 1;
export function computeAttackAngleMult() { return 1.0; }
export function attackAngleLevelHRR() { return 1.0; }

/** Stolen-base "green light" index from component scores (0–100). */
export function computeSbGreenLight(r) {
  const speed = r?.speed ?? null, intent = r?.intent ?? null, pitcher = r?.pitcher ?? null, catcher = r?.catcher ?? null;
  const parts = [speed, intent, pitcher, catcher].filter(Number.isFinite);
  const index = parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : null;
  return { speed, intent, pitcher, catcher, index };
}

/** Raw per-player inputs, flattened for the feature panel. */
export function extractRawSignals({ batterDiscipline, advancedStats, lineupOrder, gameTotal } = {}) {
  return {
    rawIzContactPct: batterDiscipline?.izContact ?? null,
    rawWhiffPct: batterDiscipline?.whiff ?? null,
    rawXwoba: advancedStats?.xwoba ?? null,
    rawBarrelPct: advancedStats?.barrel_pct ?? null,
    lineupOrder: lineupOrder ?? null,
    gameTotal: gameTotal ?? null,
  };
}

// ── Batter models ────────────────────────────────────────────────────────────

const recent = (games, n = 10) => (games || []).slice(0, n);
const sumStat = (games, key) => games.reduce((s, g) => s + (g.stat?.[key] || 0), 0);
const freq = (games, pred) => (games.length ? games.filter(pred).length / games.length : 0);

/** Per-AB rate: projection + season blended, then shrunk recent form mixed in. */
function perAbRate({ proj, seasonStats, recentGames }, statKey, projRate) {
  const gp = parseInt(seasonStats?.gamesPlayed) || 0;
  const ab = parseInt(seasonStats?.atBats) || 0;
  const seasonRate = ab > 0 ? (parseInt(seasonStats?.[statKey]) || 0) / ab : null;
  const baseline = blend(projRate, seasonRate, gp) || 0;
  const last = recent(recentGames);
  const recentRate = bayesRate(sumStat(last, statKey), sumStat(last, 'atBats'), baseline, 60);
  return { baseline, recentRate, last, score: baseline * 0.6 + recentRate * 0.4 };
}

/** Per-game rate for counting stats (TB, HRR, RBI, SB). */
function perGameRate({ seasonStats, recentGames }, valueOf, projPerGame) {
  const gp = parseInt(seasonStats?.gamesPlayed) || 0;
  const seasonPG = gp > 0 ? valueOf(seasonStats) / gp : null;
  const baseline = blend(projPerGame, seasonPG, gp) || 0;
  const last = recent(recentGames);
  const recentPG = last.length ? last.reduce((s, g) => s + valueOf(g.stat || {}), 0) / last.length : baseline;
  const recentShrunk = bayesRate(recentPG * last.length, last.length, baseline, 10);
  return { baseline, seasonPG, recentPG, last, score: baseline * 0.6 + recentShrunk * 0.4 };
}

const tbOf = s => (s.totalBases != null ? +s.totalBases : (+s.hits || 0) + (+s.doubles || 0) + 2 * (+s.triples || 0) + 3 * (+s.homeRuns || 0));
const hrrOf = s => (+s.hits || 0) + (+s.runs || 0) + (+s.rbi || 0);

function lineFields(score, propType) {
  const best = findBestLine(score, propType);
  return { bestLine: best.line, impliedProb: best.impliedProb, fairLine: best.fairLine };
}

export function modelHits(args) {
  const pr = batterProjRates(args.proj);
  const { baseline, recentRate, last, score: raw } = perAbRate(args, 'hits', pr?.avg || 0.245);
  const bvpABs = args.bvpStats?.atBats || 0;
  const bvpW = bvpWeighted(parseFloat(args.bvpStats?.avg) || 0, baseline, bvpABs);
  const orderMult = battingOrderPAMult(args.lineupOrder);
  const score = raw * orderMult;
  return {
    score, baseline, recentAvg: recentRate, recentHitRate: freq(last, g => (g.stat?.hits || 0) > 0),
    bvpW, bvpABs, handednessAvg: baseline, pitcherFactor: 1.0, arsenalAdj: null, discAdj: null,
    ...batterSeqSignals(args.lineupOrder),
    impliedProb05: modelImpliedProb(score, 'hits', 0.5),
    fairLine05: probToAmericanOdds(modelImpliedProb(score, 'hits', 0.5)),
    ...lineFields(score, 'hits'),
    over05: modelImpliedProb(score, 'hits', 0.5) > 0.6,
    label: 'Hits',
  };
}

export function modelHR(args) {
  const pr = batterProjRates(args.proj);
  const { baseline, recentRate, last, score: raw } = perAbRate(args, 'homeRuns', pr?.hr_rate || 0.033);
  const score = raw * battingOrderPAMult(args.lineupOrder);
  const drySpell = last.length > 0 && last.every(g => !(g.stat?.homeRuns > 0));
  return {
    score, baseline, recentHRRate: recentRate, bvpHR: args.bvpStats?.homeRuns ?? 0,
    bvpABs: args.bvpStats?.atBats || 0, bvpFactor: 1.0, powerMult: 1.0, drySpell,
    ...batterSeqSignals(args.lineupOrder), arsenalAdj: null,
    impliedProb05: modelImpliedProb(score, 'hr', 0.5),
    fairLine05: probToAmericanOdds(modelImpliedProb(score, 'hr', 0.5)),
    over05: modelImpliedProb(score, 'hr', 0.5) > 0.2,
    label: 'Home Run',
  };
}

export function modelSingle(args) {
  const pr = batterProjRates(args.proj);
  const singlesOf = s => (+s.hits || 0) - (+s.doubles || 0) - (+s.triples || 0) - (+s.homeRuns || 0);
  const ab = parseInt(args.seasonStats?.atBats) || 0;
  const seasonRate = ab ? singlesOf(args.seasonStats) / ab : null;
  const baseline = blend(pr?.d1_rate ?? 0.155, seasonRate, parseInt(args.seasonStats?.gamesPlayed) || 0) || 0;
  const last = recent(args.recentGames);
  const recent1BRate = bayesRate(last.reduce((s, g) => s + singlesOf(g.stat || {}), 0), sumStat(last, 'atBats'), baseline, 60);
  const score = baseline * 0.6 + recent1BRate * 0.4;
  const p = modelImpliedProb(score, 'singles', 0.5);
  return {
    score, baseline, recent1BRate, contactMatchup: null, contactAdj: null, pitcherMult: 1.0,
    arsenalAdj: null, discAdj: null, over05: p > 0.55, impliedProb05: p,
    fairLine05: probToAmericanOdds(p), label: 'Single',
  };
}

export function modelDouble(args) {
  const pr = batterProjRates(args.proj);
  const { baseline, recentRate, last, score } = perAbRate(args, 'doubles', pr?.d2_rate ?? 0.045);
  const recentDoubleFreq = freq(last, g => (g.stat?.doubles || 0) > 0);
  const p = modelImpliedProb(score, 'doubles', 0.5);
  return {
    score, baseline, recent2BRate: recentRate, recent2B: sumStat(last, 'doubles'), recentDoubleFreq,
    powerMult: 1.0, pitcherMult: 1.0, over05: p > 0.25, impliedProb05: p,
    fairLine05: probToAmericanOdds(p), label: 'Double',
  };
}

export function modelTriple(args) {
  const pr = batterProjRates(args.proj);
  const { baseline, last, score } = perAbRate(args, 'triples', pr?.d3_rate ?? 0.004);
  const recentTripleFreq = freq(last, g => (g.stat?.triples || 0) > 0);
  return {
    score, baseline, speedFactor: 1.0, projTriples: pr?.d3 || 0,
    season3B: parseInt(args.seasonStats?.triples) || 0, recentTripleFreq, skip: false,
    over05: score > 0.01 && recentTripleFreq > 0.05, label: 'Triple',
  };
}

export function modelTB(args) {
  const pr = batterProjRates(args.proj);
  const { baseline, recentPG, score: raw } = perGameRate(args, tbOf, pr?.tb_per_game ?? 1.45);
  const score = raw * battingOrderPAMult(args.lineupOrder);
  return {
    score, scoreLegacy: score, pitchlabTB: null, baseline, recentTBAvg: recentPG,
    bvpTBFactor: 1.0, powerMult: 1.0, pitcherMult: 1.0, ...batterSeqSignals(args.lineupOrder),
    ...lineFields(score, 'tb'), label: 'Total Bases',
  };
}

export function modelHRR(args) {
  const pr = batterProjRates(args.proj);
  const { baseline, seasonPG, recentPG, last, score: raw } = perGameRate(args, hrrOf, (pr ? (pr.h + pr.r + pr.rbi) / 150 : 1.9));
  const score = raw * battingOrderPAMult(args.lineupOrder);
  return {
    score, baseline, projHRR: pr ? (pr.h + pr.r + pr.rbi) / 150 : null, recentHRRPG: recentPG,
    recentHRRFreq: freq(last, g => hrrOf(g.stat || {}) >= 2),
    recentHRR25Freq: freq(last, g => hrrOf(g.stat || {}) >= 3),
    seasonHRRPG: seasonPG, pitcherMult: 1.0, powerMult: 1.0,
    ...batterSeqSignals(args.lineupOrder), ...lineFields(score, 'hrr'), label: 'H+R+RBI',
  };
}

export function computeRBIModel(args) {
  const pr = batterProjRates(args.proj);
  const { baseline, seasonPG, recentPG, score: raw } = perGameRate(args, s => +s.rbi || 0, (pr ? pr.rbi / 150 : 0.5));
  const score = raw * battingOrderPAMult(args.lineupOrder);
  return {
    score, baseRate: baseline, recentRBIPerGame: recentPG, seasonRBIPerGame: seasonPG,
    projRBIPerGame: pr ? pr.rbi / 150 : null, rispMult: 1.0, rispOPS: null, rispAB: null, rispAvgDelta: null,
    impliedProb05: modelImpliedProb(score, 'rbi', 0.5), label: 'RBI',
  };
}

export function modelSB(args) {
  const pr = batterProjRates(args.proj);
  const { baseline, recentPG, last, score } = perGameRate(args, s => +s.stolenBases || 0, pr?.sb_per_game ?? 0.07);
  return {
    score, baseline, recentSB: sumStat(last, 'stolenBases'), recentSBRate: recentPG,
    recentSBFreq: freq(last, g => (g.stat?.stolenBases || 0) > 0),
    speedMult: 1.0, catcherMult: 1.0, baserunningMult: null,
    greenLight: computeSbGreenLight(null),
    impliedProb05: modelImpliedProb(score, 'sb', 0.5),
    fairLine05: probToAmericanOdds(modelImpliedProb(score, 'sb', 0.5)), label: 'Stolen Base',
  };
}

// ── Pitcher strikeouts ───────────────────────────────────────────────────────

export function modelPitcherK({ proj, seasonStats, recentStarts, line }) {
  const gp = parseInt(seasonStats?.gamesStarted || seasonStats?.gamesPitched) || 0;
  const pr = pitcherProjRates(proj);
  const projKPerStart = pr?.k_per_start ?? null;
  const seasonKPerStart = gp > 0 ? (parseInt(seasonStats?.strikeOuts) || 0) / gp : null;
  const baseline = blend(projKPerStart, seasonKPerStart, gp) || 0;
  const last5 = (recentStarts || []).slice(0, 5);
  const ks = last5.map(g => g.stat?.strikeOuts || 0);
  const recentKAvg = ks.length ? ks.reduce((a, b) => a + b, 0) / ks.length : baseline;
  const recentStddev = ks.length > 1 ? Math.sqrt(ks.reduce((s, k) => s + (k - recentKAvg) ** 2, 0) / ks.length) : 0;
  const lineVal = line || Math.round(baseline) - 0.5;
  const clearingLine = ks.filter(k => k >= Math.ceil(lineVal)).length;
  const consistency = ks.length ? clearingLine / ks.length : null;
  const score = gp > 0 || ks.length ? baseline * 0.6 + recentKAvg * 0.4 : baseline;
  return {
    score, baseline, recentKAvg,
    recentStddev: ks.length > 1 ? recentStddev : null,
    clearingLine, consistency, edge: score - lineVal,
    impliedProb: modelImpliedProb(score, 'ks', lineVal), label: 'Strikeouts',
  };
}

/** Expected strikeouts = projected batters faced × blended K%. */
export function modelPitcherKv2({ proj, seasonStats, gameLog, oppKRate, restDays }) {
  const pr = pitcherProjRates(proj);
  const bf = parseInt(seasonStats?.battersFaced) || 0;
  const seasonKPct = bf > 0 ? (parseInt(seasonStats?.strikeOuts) || 0) / bf : null;
  const projKPct = pr?.k_pct ?? 0.22;
  const kPct = bayesRate((seasonKPct ?? 0) * bf, bf, projKPct, 300);
  const starts = (gameLog || []).filter(g => parseFloat(g.stat?.inningsPitched) >= 3).slice(0, 5);
  const projIP = starts.length ? starts.reduce((s, g) => s + parseFloat(g.stat.inningsPitched), 0) / starts.length : ((pr?.starts ? pr.ip / pr.starts : 5.5));
  const expectedBattersFaced = projIP * 4.25;
  const M1 = Number.isFinite(oppKRate) ? oppKRate / 0.22 : 1.0; // opponent K% vs league
  const xKModel = expectedBattersFaced * kPct;
  const xK = xKModel * M1;
  const ones = { M2: 1, M3: 1, M4: 1, M5: 1, M6: 1, M7: 1, M8: 1, M_VELO: 1, M_UMP: 1, M_REST: computePitcherRestMult(restDays) };
  return {
    xK, xKModel, kEdge: null, M1, ...ones, projIP,
    pitchMixEntropy: null, expectedBattersFaced, kPct,
    confidence: calcKConfidence({ xK }),
    ...lineFields(xK, 'ks'),
  };
}

/** 0–10 confidence for the K model; public build scores on sample size only. */
export function calcKConfidence({ xK, l5Stddev } = {}) {
  if (!Number.isFinite(xK)) return null;
  const spread = Number.isFinite(l5Stddev) ? Math.min(l5Stddev / 3, 1) : 0.5;
  return Math.round((6 - 2 * spread) * 10) / 10;
}

// ── TB score map (production maps a pitch-level model's probabilities onto the
// TB score scale; the public build ships an identity-like illustrative map) ──
const TB_PITCHLAB_SCORE_MAP = [[0.0, 0.0], [0.5, 1.0], [1.0, 3.0]];
export { TB_PITCHLAB_SCORE_MAP };
export function tbScoreFromProb(p) {
  if (!Number.isFinite(p)) return null;
  const m = TB_PITCHLAB_SCORE_MAP;
  for (let i = 1; i < m.length; i++) {
    if (p <= m[i][0]) {
      const [x0, y0] = m[i - 1], [x1, y1] = m[i];
      return y0 + ((p - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return m[m.length - 1][1];
}
