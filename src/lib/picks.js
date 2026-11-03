// ══════════════════════════════════════════════════════════════════════════
// Pick-selection gates — the score-space logic that decides which board plays
// become OFFICIAL picks (🎲) and get saved to Results.
//
// Extracted from App.jsx so the gates are pure, importable, and TESTABLE. Every
// silent failure that has bitten this project was a GATE/pipeline bug, not a
// math-primitive bug (HRR 0-pick drought, lock-filter dropping props at save,
// headless 0-score). models.test.js freezes the math; picks.test.js freezes
// these gates.
//
// PROJECT RULE (CLAUDE.md): gates live in SCORE space, never probability space.
// Probability calibrations (modelImpliedProb) retune; a gate written as
// `prob >= X` silently tightens when calibration changes. Keep gates on
// `conf >= pickThresh` / `score >= thresh`.
// ══════════════════════════════════════════════════════════════════════════

import { AVG_PA_PER_GAME, modelImpliedProb, bestBookOdds, calcEVFromOdds, computeSbGreenLight, hasFittedLine } from './models.js';
import { getActiveHealthLookup, applyProbShift } from './marketHealth.js';
import { passesGateOverrides } from './gateOverrides.js';

// ── PROPS DASHBOARD — board configs (gate params + display metadata) ──
export const BOARD_CONFIGS = {
  // 2026-06-02 (PM): reverted to the WIDE conf scale (uniform slope 5.5 in calcConfidence → top ≈ 9.5)
  // so the most-confident picks read in the 8s–9s. Ceilings set to each market's ~p90–p95 score so
  // scores spread instead of railing; per-market pickThresh restores selectivity. hr/hrr/tb ceilings
  // corrected (hr 0.110 was unreachable → maxed 7.0; hrr 3.5 / tb 3.20 were below the board median →
  // everything railed to 9.5). Probability calibration (modelImpliedProb) is unchanged & independent.
  //
  // 2026-06-11: hrr ceiling 4.5 → 3.5 and pickThresh 8.5 → 8.25 (the pre-06-02 pair). The 4.5
  // ceiling was itself a degenerate ceiling: modelHRR hard-caps score at 3.5 (park/luck adjScore
  // mults only stretch it to ~3.9), so base conf maxed at 7.3 and the 8.5 dice gate was
  // unreachable — zero official HRR picks for 10 straight days (06-02..06-11). The "hrr board
  // median above 3.5" that motivated 4.5 was an artifact of the broken prob-space board gate
  // (see the hrr case in isActionable), which admitted only the ≥3.12 score tail.
  // hits thresh/ceiling rescaled by 1/0.96 on 2026-07-29 when computeSwingTakeHitsMult
  // was removed. That term multiplied adjScore by a flat 0.96 on 98.5% of scanned rows,
  // and thresh/ceiling are compared against adjScore (see scoringScore below), so
  // dropping it without rescaling would have made the gate ~4% easier for the 94% of
  // rows that carried the term. conf = 4.0 + ((score-thresh)/(ceiling-thresh))*5.5, so
  // scaling BOTH bounds by the same 1/0.96 leaves confidence exactly unchanged for
  // those rows — and correctly removes the ~4% edge the 5.6% of rows WITHOUT swing-take
  // data were quietly enjoying. Guarded by src/lib/picks.test.js.
  hits:   { label: "Hits O/U 0.5",    emoji: "🎯", field: "over05", thresh: 0.2708333333333333, ceiling: 0.3958333333333333, projLabel: "xH",   projFn: s => (s * AVG_PA_PER_GAME).toFixed(1),                             pickThresh: 8.5 },
  hr:     { label: "Home Run",        emoji: "💣", field: "yes",    thresh: 0.055, ceiling: 0.090, projLabel: "HR/AB", projFn: s => s > 0 ? "1 per " + (1 / s).toFixed(1) + " AB" : "—",         pickThresh: 8.0 },
  tb:     { label: "Total Bases",     emoji: "📊", field: "yes",    thresh: 1.80,  ceiling: 5.00,  projLabel: "xTB",  projFn: s => s.toFixed(1),                                                 pickThresh: 8.5 },
  sb:     { label: "Stolen Base",     emoji: "🏃", field: "over05", thresh: 0.35,  ceiling: 0.55,  projLabel: "xSB",  projFn: s => (s * 100).toFixed(0) + "%",                                   pickThresh: 7.0 },
  hrr:    { label: "H+R+RBI",        emoji: "🔥", field: "yes",    thresh: 2.0,   ceiling: 3.5,   projLabel: "xHRR", projFn: s => s.toFixed(1),                                                 pickThresh: 8.25 },
  // RBI: ceiling 1.30 (score cap). pickThresh 7.5 — RBI scores top out lower than other markets, so it
  // needs a lower gate than hits/tb/hrr to surface its ~5 confirmed picks (the lineup+gameTotal gate
  // still applies). projFn shows the logistic-calibrated P(RBI≥1). See the 2026-06-02 calibration pass.
  rbi:    { label: "RBI O/U 0.5",     emoji: "🏅", field: "over05", thresh: 0.69,  ceiling: 1.30,  projLabel: "xRBI", projFn: s => ((modelImpliedProb(Math.max(0, s), "rbi", 0.5) ?? 0) * 100).toFixed(0) + "%",     pickThresh: 7.5 },
};

// ── Confidence score: 1.0–10.0 scale ──
// Factors: (1) how far above threshold, (2) park boost, (3) recent form signal strength
export function calcConfidence(score, boardKey, pick) {
  const cfg = BOARD_CONFIGS[boardKey];
  if (!cfg) return 5.0;
  const { thresh, ceiling } = cfg;

  // ── Conviction scale (wide, 2026-06-02 PM) ──
  // conf = 4.0 (at thresh) → 9.5 (at ceiling), uniform slope 5.5 across markets. Per-market
  // ceilings are set to ~p90–p95 of each market's score distribution, so most-confident picks
  // read in the 8s–9s and per-market pickThresh stays selective. SCORE is comparable across
  // markets as "how far into this market's actionable range." (Probability/EV honesty lives
  // separately in modelImpliedProb.) ks uses its own calcKConfidence.
  const range = ceiling - thresh;
  const above = Math.max(0, score - thresh);
  const pctAbove = range > 0 ? Math.min(above / range, 1.0) : 0;
  let conf = 4.0 + pctAbove * (cfg.convictionSlope ?? 5.5);

  // NOTE: removed the old TB >3.6 regression penalty (2026-06-02 PM) — it was tuned to the
  // compressed-scale era and, with the new ceiling 5.0, fired on nearly every TB pick, fighting
  // the wide scale. The "top-TB regresses" finding is still real; revisit as a score-cap or a
  // ceiling-shape tweak on clean @2026-06-02 data rather than a flat conf subtraction.

  // Boost for park factor alignment — skip HR (park already baked into adjScore/scoringScore)
  // and TB (park feature-mined at r=−0.05 vs cash; the dampened parkMult inside score is enough).
  const pm = pick?.parkMult || 1.0;
  if (boardKey !== "hr" && boardKey !== "tb") {
    if (pm > 1.03) conf += 0.3;
    else if (pm < 0.97) conf -= 0.3;
  }

  // Boost for strong recent form (if result has recentHitRate, recentHRRate etc)
  const r = pick?.result;
  if (r) {
    if (r.recentHitRate > 0.80) conf += 0.2;
    if (r.recentHRRate > 0.070) conf += 0.3;
    if (r.recentAvg > 0.320) conf += 0.2;
    // Penalize if barely clearing threshold
    if (pctAbove < 0.05) conf -= 0.3;
  }

  // HRR-specific form signals — modelHRR returns different field names than modelHits/modelHR.
  // Without this block these bonuses NEVER fired for HRR picks (wrong field names).
  if (boardKey === 'hrr' && r) {
    if ((r.recentHRRFreq ?? 0) > 0.50)     conf += 0.3;  // hitting 2+ HRR in 50%+ of recent games
    if ((r.recentHRR25Freq ?? 0) > 0.35)   conf += 0.2;  // also hitting 3+ in 35%+ of recent games
    if ((r.recentHRRPG ?? 0) > 3.0)        conf += 0.2;  // blazing recent pace
    if ((r.wrcAdj ?? 1.0) > 1.06)          conf += 0.2;  // elite wRC+ (130+) boosted the score
    if ((r.powerCeilingAdj ?? 1.0) > 1.15) conf += 0.15; // elite barrel/hard-hit profile
    // Opposing full-pen HR/9 — the one FDR-significant retro-mined HRR signal (q=0.004,
    // Q1→Q4 +22pp cash; project_bullpen_mining_2026-05-29). The model score rails at its
    // 3.5 cap for every elite slugger, so near the pick threshold this is real
    // discrimination the score itself can't provide.
    const penHR9 = r.bullpen?.hrPer9;
    if (penHR9 != null) {
      if (penHR9 >= 1.15)      conf += 0.3;  // homer-prone pen (~Q4)
      else if (penHR9 <= 0.85) conf -= 0.3;  // stingy pen (~Q1)
    }
  }

  // TB-specific form signals — weighted by feature-mining (N=2661) Q1→Q4 spread on cash@O1.5.
  // Bonuses sized so 3-4 firing together = ~+1.0 conf (a real lean), all firing = ~+1.8.
  // Conf base is compressed (cap ~7.5), so peak elite picks land in the 8.5-9.5 band, not 10s.
  if (boardKey === 'tb' && r) {
    // Tier 1 — empirically the strongest signals
    if ((r.pitDbQualityAdj ?? 1.0) > 1.04) conf += 0.20; // +24pp Q1→Q4: bad pitcher is #1 driver
    if ((r.powerArsenalSynergyAdj ?? 1.0) > 1.0) conf += 0.18; // 47% cash interaction n=249
    if ((r.isoAdj          ?? 1.0) > 1.05) conf += 0.15; // +18pp Q1→Q4: pure extra-base rate
    if ((r.powerMult       ?? 1.0) > 1.30) conf += 0.15; // +17pp Q1→Q4
    if ((r.arsenalTBAdj    ?? 1.0) > 1.05) conf += 0.15; // +15pp Q1→Q4
    if ((r.baseline ?? 0)         > 2.0)  conf += 0.12; // +15pp Q1→Q4
    if ((r.wrcTBAdj        ?? 1.0) > 1.05) conf += 0.12; // +11pp Q1→Q4: league-adj quality
    // Tier 2 — moderate signals
    if ((r.tbCeilingAdj    ?? 1.0) > 1.15) conf += 0.08; // +8pp Q1→Q4
    if ((r.gameEnvAdj      ?? 1.0) > 1.04) conf += 0.08; // +8pp Q1→Q4
    if ((r.paAdj           ?? 1.0) > 1.03) conf += 0.05; // PA opportunity
    if ((r.pullParkTBAdj   ?? 1.0) > 1.03) conf += 0.05; // pull% × short porch
    // Tier 3 — applied but empirically flat (luckMult −2pp, attackAngle +5pp small). Small/none.
    // 1.05 → 1.036 on 2026-09-12 with the attack-angle recentre (models.js
    // LEAGUE_IDEAL_ATTACK_RATE): same 73.6% fire rate on the qualified panel, so the conf
    // distribution does not shift under the score-space gates. Solved by
    // scripts/attack-angle-centre-test.mjs --solve. At 1.05 it would fire on ~half.
    if ((r.attackAngleMult ?? 1.0) > 1.036) conf += 0.05;
    if (r.pickKind === 'tb_stud')          conf += 0.12; // O2.5 selectivity
  }

  // SB bonuses: sprint speed is the ONLY signal that separated hits (1.30) from misses
  // (1.18) in the backtest. recentSBFreq, basestealingMult, catcherMult were flat or
  // INVERTED on outcomes, so they no longer add confidence (they were re-inflating picks
  // the compressed scale is meant to hold down). Keep speed only, and small.
  if (boardKey === 'sb' && r) {
    if ((r.speedMult ?? 1.0) > 1.20) conf += 0.3;  // elite sprint speed (28+ ft/s)
    if ((r.speedMult ?? 1.0) > 1.30) conf += 0.2;  // bolt speed (29+ ft/s)
  }

  // Pitcher quality bonus (general — applies to hits/HR/TB/HRR/RBI picks where pitDbQualityAdj fires)
  // A bad opposing pitcher (Pit+ < 90 → mult > 1.06) is genuine signal the model already used,
  // but the bonus here gives the conf scoring credit for trusting it.
  // 2026-06-12: hrr added to the list — SYNTHESIS-2026-06-11 §5 shows pitDbQualityAdj is
  // significant in EVERY batter market pool (hrr O2.5 +21.7pp q=0.0015), and hrr was the
  // only one missing the bonus despite the comment above claiming otherwise.
  if (r && (boardKey === 'hits' || boardKey === 'hr' || boardKey === 'tb' || boardKey === 'hrr' || boardKey === 'rbi')) {
    if ((r.pitDbQualityAdj ?? 1.0) > 1.04) conf += 0.15;  // bad pitcher confirms hitter edge
  }
  // Mined cross-market interactions (SYNTHESIS-2026-06-11 §5): bad pitcher × hot batter
  // compounds far beyond either alone. Pool Q-cuts: pitDbQualityAdj×recentAvg = 53.1%
  // cash on hits O1.5 (base 21.3%); ×recentHRR25Freq = 54.1% on HRR O2.5 (base 29.0%).
  // Fires for only ~0–3 board candidates/day per market (checked 6/08–6/11 blobs).
  // Score-weight promotion (TB-style 1.6× amplification) deliberately deferred — it
  // shifts score distributions and would invalidate the fresh hits/hrr calibrations;
  // do it behind a replay + recalibration pass.
  if (boardKey === 'hits' && r && (r.pitDbQualityAdj ?? 1.0) > 1.04 && (r.recentAvg ?? 0) > 0.300) conf += 0.2;
  if (boardKey === 'hrr' && r && (r.pitDbQualityAdj ?? 1.0) > 1.04 && (r.recentHRR25Freq ?? 0) > 0.30) conf += 0.2;
  // HR-specific: low-velo pitcher = HR gift
  if (boardKey === 'hr' && r) {
    if ((r.pitFBVeloAdj ?? 1.0) > 1.04) conf += 0.2;  // sub-92 mph FB → +HR allowance
  }

  return Math.max(1.0, Math.min(10.0, parseFloat(conf.toFixed(1))));
}

// ── Edge-controller (market_health) integration ─────────────────────────────
// The daily edge-controller run (scripts/edge-controller.mjs) writes bounded
// per-market controls learned from rolling graded results: unit_mult
// (1 / 0.5 / 0) and prob_shift (rolling calibration correction for the EV
// lens). Sizing functions below consume them via the module store installed
// by App.jsx; a missing lookup (tests, fetch failure) means identity. This
// deliberately does NOT touch pick gates or saves — suspended markets keep
// recording picks in shadow so they can earn their way back.
function healthFor(market) {
  return getActiveHealthLookup()?.latest?.(market) ?? null;
}
// Integer-preserving throttle so PICK_UNIT_COLORS keys stay valid:
// suspended → 0, throttled → ceil(base/2), active → base.
function applyUnitMult(base, health) {
  if (!health || base <= 0) return base;
  const mult = Number(health.unit_mult);
  if (!Number.isFinite(mult) || mult >= 1) return base;
  if (mult <= 0) return 0;
  return Math.max(1, Math.ceil(base * mult));
}

// Score-driven sizing for batter picks. Units scale with how far conf is above each
// board's pickThresh — normalizes across boards regardless of their different thresholds.
// EV bonus: when the book line is mispriced by ≥15% vs model, add +1u (capped at 5).
export function batterPickUnits(conf, boardKey, pick) {
  const cfg = BOARD_CONFIGS[boardKey];
  if (!cfg || cfg.pickThresh == null) return 0;
  const dist = conf - cfg.pickThresh;
  if (dist < 0) return 0;
  let base = dist < 0.5 ? 1 : dist < 1.0 ? 2 : dist < 1.5 ? 3 : dist < 2.0 ? 4 : 5;
  // TB value picks (O1.5 floor) are higher-probability/lower-payout — cap at 2u so a
  // string of -200 favorites can't drain bankroll. Stud picks (O2.5) size normally.
  if (boardKey === 'tb' && pick?.result?.pickKind === 'tb_value') {
    base = Math.min(base, 2);
  }
  const health = healthFor(boardKey);
  // EV bonus: strong mispricing by book adds one unit. Probability runs through
  // the controller's rolling calibration correction so a stale-hot market
  // (e.g. TB pred 51% / actual 38%, 2026-06-30) can't buy bonus units.
  const bestOdds = bestBookOdds(pick?.bookOdds);
  const pAdj = applyProbShift(pick?.impliedProb, health?.prob_shift);
  const ev = pAdj != null && bestOdds != null ? calcEVFromOdds(pAdj, bestOdds) : null;
  if (ev != null && ev >= 0.15) base = Math.min(5, base + 1);
  return applyUnitMult(base, health);
}

// Unit count → display color (index = units). Lives here so PropsBoard and the
// Results views share one scale with the sizing functions that produce the units.
export const PICK_UNIT_COLORS = ["", "#7a8fa8", "#4a9eff", "#fbbf24", "#fb923c", "#4ade80"];

// ── Results-tracker stake weighting ───────────────────────────────────────────
// The flat 1u-per-pick track stays the model-quality metric (every pick equal
// weight → clean win-rate/CLV signal). This MARKET_UNITS track is the "how I'd
// actually size it" bankroll view.
//
// 2026-08-27: RE-BASED FROM PRICE ONTO MEASURED EDGE. The original schedule
// sized inversely to each market's typical price — hits are −300/−600 favorites
// so they went to 2u "so the low payout still moves the bankroll", and HR/SB are
// +250/+600 longshots so they went to 0.5u "to cap variance". Internally
// consistent, and it happened to size UP the worst market and size DOWN the best
// one. Measured over 4,953 graded picks on the clean substrate (see below):
//
//   sb    n=174   +24.4% ROI   train +27.9%  test +12.8%   ← was staked 0.5u
//   hits  n=949    −5.1% ROI   train  −4.9%  test  −5.6%   ← was staked 2.0u
//
// sb is the only market positive in both halves; hits is the largest consistent
// loser and was carrying double weight. Moving both to 1u beats the old schedule
// in BOTH halves (train −103.6u vs −150.6u, test −84.8u vs −107.8u).
//
// hr deliberately STAYS at 0.5u. It reads +3.3% ROI overall, which argues for a
// raise, but that is train +6.8% / test −9.1% — it flips sign out of sample, and
// it is a genuine +250/+600 longshot where the variance rationale still holds.
// Sizing up a market whose OOS edge is negative is how you turn a measurement
// into a loss.
//
// "Clean substrate" = picks after 2026-04-03. The 1,725 rows dated 03-25→04-03
// are a pre-save-gate bulk scan dump (216 picks/day vs 38 now, and every one of
// them has an empty `conf`), not a betting record.
//
// Keyed by prop_type; unlisted markets (hrr/tb/ks/rbi/ml/rl/ou) fall through to 1.
export const MARKET_UNITS = { hr: 0.5 };

// healthLookup/pickDate (optional): scale the stake by the edge-controller
// multiplier that was IN FORCE on the pick's date, so the weighted track is
// an honest simulation of following the controller (suspended market → 0u
// that day). Pre-controller dates and unevaluated markets stay at 1×.
export function pickStakeUnits(propType, healthLookup, pickDate) {
  const base = MARKET_UNITS[propType] ?? 1;
  if (!healthLookup?.multFor) return base;
  return base * healthLookup.multFor(propType, pickDate);
}

// ── Official pick gate: determines which board plays get 🎲 and get saved to Results ──
export function isOfficialPick(conf, boardKey, pick) {
  const cfg = BOARD_CONFIGS[boardKey];
  if (!cfg || cfg.pickThresh == null) return false;
  if (conf < cfg.pickThresh) return false;
  // NOTE (2026-06-02): EV is deliberately NOT a gate. Models are outcome-focused; a pick fires on
  // model conviction (conf >= pickThresh) regardless of price. The EV column stays as an
  // information/learning lens. (Removed the old pickRequiresPosEV gate on HR/TB.)
  // RBI: 115-pick replay (rbi-replay.mjs) showed picks without confirmed lineup or
  // gameTotal hit 30-32%, vs 56%/52% when both signals are present. The model defaults
  // those mults to 1.0 and is structurally over-confident on lineup-blind picks.
  // TB: the saved line is the BOOK's line (App.jsx savedLine = p.bookLine ?? …), and only
  // O1.5 and O2.5 have a fitted calibration. A book posting O3.5 or O4.5 used to get a
  // probability borrowed from the O2.5 curve, and those picks went 6-40 (O3.5 4-19 at a
  // claimed 33.5%, O4.5 2-21 at the same claimed 33.5%). The conf that clears this gate
  // describes the hitter's base accumulation, not the specific rung: the same score is a
  // coin flip at O1.5 and a 9% shot at O4.5. Now that modelImpliedProb refuses to price
  // those lines, a pick on one carries no probability at all — so it must not carry a 🎲
  // either. Board membership is untouched; the row still shows on the TB board.
  if (boardKey === 'tb') {
    const line = pick?.bookLine;
    if (line != null && !hasFittedLine('tb', Number(line))) return false;
  }
  if (boardKey === 'rbi') {
    const r = pick?.result;
    if (!r) return false;
    if (r.lineupOrder == null) return false;
    if (r.gameTotal == null)   return false;
  }
  // Promoted lab gates (src/lib/gateOverrides.json) — conf/score caps and
  // floors that graduated a shadow slate. Applied LAST so they can only ever
  // subtract from the pick set, never admit a pick the base gates rejected.
  // Board membership is deliberately not consulted here: a capped pick still
  // shows on its research board, it just loses the 🎲.
  const r2 = pick?.result;
  const score = r2?.adjScore ?? r2?.score ?? null;
  if (!passesGateOverrides(boardKey, conf, score)) return false;
  return true;
}

// ── Board membership gate: which players appear on each research board ──────
// Upstream of isOfficialPick — controls board display; isOfficialPick (conf >=
// pickThresh) then decides which of those get 🎲 + saved. ALL cutoffs run in
// SCORE space (the λ), never probability space: the HRR drought (and the TB gate
// fixed 2026-06-15) were prob-space board gates that silently retuned under
// calibration. If a board ever empties, check these cutoffs vs the score cap first.
//   bk           — board key (BOARD_CONFIGS key, or the special "hits15")
//   scoringScore — result.adjScore ?? result.score
//   result       — player.models[modelKey]
//   player       — full player (hrr reads the companion hr score)
//   cfg          — BOARD_CONFIGS[bk] (default branch reads cfg.field)
export function isBoardActionable(bk, scoringScore, result, player, cfg) {
  switch (bk) {
    case "hits":
      return scoringScore > 0.245;
    case "hits15":
      return scoringScore > 0.290 && (result.recentHitRate ?? 0) > 0.80 && (result.recentAvg ?? 0) > 0.290;
    case "hr":
      return scoringScore > 0.050 && (result.recentHRRate ?? 0) > 0.038;
    case "tb":
      // Board membership runs on SCORE (the λ), not the calibrated prob —
      // same pattern as hrr/rbi below. The old gate was
      // `scoringScore > 2.2 && bestLine.impliedProb >= 0.50`, but the prob
      // half was the binding constraint AND it silently retunes when the TB
      // calibration changes — the exact failure mode that killed the HRR
      // board for 10 days (06-02..06-11). Frozen to its score-space
      // equivalent: findBestLine's prob crosses 0.50 at score ≈ 3.30 under
      // the current calibration (the 2.2 floor never bound). Converted 2026-06-15.
      return scoringScore >= 3.30;
    case "hrr": {
      // Board membership runs on SCORE (the λ), not the calibrated prob — same
      // pattern as RBI below. These branch cutoffs were originally written as
      // raw-Poisson probability gates (p25>=0.50 ⇔ score>=2.67, p15>=0.55 ⇔
      // score>=1.84) and silently retuned themselves when the 2026-06-02 λ-shrink
      // (HRR_CALIBRATION 0.59) made modelImpliedProb honest: p15>=0.55 became
      // score>=3.12 (board collapsed to the top tail) and p25>=0.50 became
      // score>=4.53 — unreachable (model caps at 3.5) — so every star bypassed
      // the strict recentHRR25Freq floor and zero picks cleared the dice gate
      // for 10 straight days (mlb_picks 06-02..06-11). Converted 2026-06-11.
      //
      // Dead-zone fix preserved: the high tier routes to the 3+ HRR form floor
      // only at the old "O2.5 actually actionable" score (2.70); the 1.90–2.70
      // middle class stays on the O1.5 gate.
      if (scoringScore <= 1.90) return false; // ≈ old raw p15 >= 0.55 cutoff
      const hrScore = player.models?.hr?.adjScore ?? player.models?.hr?.score ?? 0;
      const freqFloor = hrScore > 0.075 ? 0.35 : 0.38;
      if (scoringScore >= 2.70) { // old raw p25 >= 0.50 cutoff in score space
        return (result.recentHRR25Freq ?? 0) > 0.30;
      }
      return (result.recentHRRFreq ?? 0) >= freqFloor;
    }
    case "sb":
      // 2026-07-06 board reopen: research membership runs on score alone. The old
      // gate was `score >= 0.35 && recentSBFreq > 0.15` — but the 05-24 backtest
      // showed recent-SB activity does NOT separate outcomes (slightly inverted:
      // chasing mean-reverting streaks), which is why it carries no score weight
      // and no conf bonus. Keeping it as a hard membership gate was the same class
      // of bug as the HRR drought: filtering on a signal we'd already concluded is
      // noise. And because recentSBFreq is bayes-shrunk (n=50) it was effectively
      // a SECOND season-rate gate stacked on the 0.35 floor — the board showed ~2
      // rows on a full slate. 0.20 ≈ Poisson P(SB≥1) of 18% — wide enough to
      // research, far below the 🎲 gate (over05 + conf ≥ 7.0), which is unchanged.
      return scoringScore >= 0.20;
    case "rbi":
      // Board membership runs on score (λ), not the calibrated prob. The logistic
      // recalibration squashed P(RBI≥1) to ~32–42%, so a prob>=0.50 gate would empty
      // the board. score>=0.69 = the old Poisson-0.50 cutoff, keeping the research view full.
      return scoringScore >= 0.69;
    default:
      return !!result[cfg.field];
  }
}

// ── SB watch-list gate (2026-07-06) ─────────────────────────────────────────
// Sub-threshold SB rows worth a research look. NEVER pickable: rows tagged
// `watch: true` are excluded from official-pick saves, golden candidates,
// board counts, and best-pick lookups — they exist only for the grey watch
// tier on the SB board. Two ways in:
//   (a) score in [0.10, board floor) — a real-but-modest model read, or
//   (b) Green-Light Index ≥ 70 with any nonzero base rate — the matchup is
//       screaming (elite speed/intent vs weak battery) even though the season
//       rate keeps the composite down. These are the fun surprises.
export function isSbWatch(scoringScore, result) {
  if (!result || result.skip) return false;
  if (scoringScore >= 0.20) return false;           // board-actionable, not watch
  if (scoringScore >= 0.10) return true;
  if (scoringScore < 0.05) return false;
  const gl = computeSbGreenLight(result);
  return (gl?.index ?? 0) >= 70;
}

// ── Pitcher-K role/workload guard (2026 post-mortem 02, docs/postmortem/02-strikeout-model.md) ──
// When the BOOK's line sits ≥ 2 Ks from our projection, the gap is almost never the
// pitcher's talent — it is a role or workload change the book already knows about:
// an opener, a bulk day, an innings limit, a piggyback, a September call-up. Over
// Jun–Sep 2026, 110 starts had |xK − book line| ≥ 2; in 105 the line sat BELOW xK and
// 59 of those went under, while the live board signalled 109 of them (105 overs) at
// 44.9% / −16.9u. The production isRoleChange flag caught only 25 of the 110 (most were
// nominal "starts" cut short). The line is the better role signal: trust it, show the
// pitcher as role-uncertain, and never make it a pick.
//
// Applies only against a REAL book line. Without one, `line` is model-derived
// (floor(xK) + 0.5 in the scan), so the gap is meaningless by construction.
export const KS_ROLE_GAP = 2.0;
export function ksRoleUncertain(p) {
  if (!p?.hasBookLine || p.xK == null || p.line == null) return false;
  return Math.abs(p.xK - p.line) >= KS_ROLE_GAP;
}

// Edge + over/under signal against a line, with the role guard applied. A role-uncertain
// pitcher gets signal "neutral": the board shows no side, and isOfficialKsPick (which
// requires over/under) cannot fire — the explicit guard below is a second lock.
export function ksSignalVsLine({ xK, kEdge, line, hasBookLine }) {
  const xKEdge = xK - line;
  const kEdgeEdge = kEdge - line;
  const roleUncertain = ksRoleUncertain({ xK, line, hasBookLine });
  const signal = roleUncertain ? "neutral"
    : xKEdge > 0.3 && kEdgeEdge > 0.3 ? "over"
    : xKEdge < -0.3 && kEdgeEdge < -0.3 ? "under" : "neutral";
  return { xKEdge, kEdgeEdge, signal, roleUncertain };
}

// ── Pitcher-K official gate (separate scale — Ks use calcKConfidence, not BOARD_CONFIGS) ──
export function isOfficialKsPick(p) {
  if (ksRoleUncertain(p)) return false;
  if ((p.conf || 0) < 8.5) return false;
  // Unders RE-ENABLED 2026-06-17 after a full-board backtest (scripts/
  // ks-throttle-backtest.mjs). The 88 real saved Ks unders went 55-33 (+48% ROI
  // at their actual −73 avg odds — strikeout unders are structurally cashy and
  // only lightly juiced), and board unders kept winning through the post-6/12
  // regime (11-3). The blanket 6/12 suspension over-corrected to a ~28-pick
  // early-June blip. CONF IS ANTI-PREDICTIVE here (low-conf unders cash MORE), so
  // sizing must NOT scale with conf — see ksPickUnits. Watching CLV (live since
  // 6/12); revert if the live sample regresses. The original collapse reasoning
  // (residual → 0, conviction inversion) is preserved in modelVersions + memory.
  // Promoted lab gates for ks (e.g. a validated conf cap on the top tail).
  // Ks run their own conf scale (calcKConfidence), but it is the same `conf`
  // column the lab feed sweeps, so the override applies directly.
  //
  // SCORE IS xK, and passing it is not optional. This call used to hand the score
  // argument a hard `null`, which gateOverrides.js reads as "no score to test" and
  // skips score_min/score_max entirely — while promotion-gate.mjs advertises both as
  // enforceable for every market and the proposal queue has carried K score
  // candidates. A K score gate could therefore graduate a shadow slate, be written
  // into gateOverrides.json, show up in the changelog, and cut exactly nothing at
  // save time. xK is what the save path stores as model_score (App.jsx savePitchers)
  // and therefore what the lab's score_min/score_max range over, so it is the only
  // value that makes the runtime gate mean what the lab measured.
  if (!passesGateOverrides("ks", p.conf ?? null, p.xK ?? null)) return false;
  if (p.signal === "under") return true;
  // Overs only at O5.5 and below. The 6/17 backtest confirmed O6.5+ at 17–22%
  // cash / −59% ROI — the book is genuinely sharp on marquee K overs — while the
  // ≤5.5 conf≥8.5 slice is the only profitable over bucket (+25% ROI). So this
  // cap keeps the strong overs and drops only proven losers, not overs wholesale.
  return p.signal === "over" && (p.line ?? 0) <= 5.5;
}
export function ksPickDirection(p) {
  return p.signal === "under" ? "under" : "over";
}

// Score-driven sizing (1–5u) for official K picks only.
// Base units from conf tier; edge magnitude adds bonus on top.
export function ksPickUnits(p) {
  const conf = p.conf || 0;
  const edge = Math.abs(p.xKEdge || 0);
  const health = healthFor('ks');
  // Unders: conf/edge are anti-predictive (high disagreement = worse) and the
  // live post-regime sample is still small (N≈14), so size flat-small (2u)
  // regardless of conf — never let a high-conviction under draw a big stake
  // while we confirm the edge forward via CLV.
  if (p.signal === "under") return applyUnitMult(2, health);
  const base = conf >= 9.5 ? 4 : conf >= 9.0 ? 3 : conf >= 8.7 ? 2 : 1;
  const edgeBonus = edge >= 2.0 ? 2 : edge >= 1.0 ? 1 : 0;
  return applyUnitMult(Math.min(5, base + edgeBonus), health);
}

// ── Game-line official play gates (ML / RL / O-U) ──────────────────────────
// Pure extraction of the inline gates in the games table. SCORE-space style:
// edges are run/probability margins the model produces, gated by fixed cutoffs.
//   ML: high conf needs a 4% edge, medium needs a fatter 6% edge to compensate
//   RL: 0.75-run cover edge — drops the high-conf gate (margin magnitude IS the conf)
//   OU: own-market signal — 1.5-run edge stands on its own regardless of moneyline conf
export function gameLineGates({ model, mlPick, rlPick, rlMarginEdge, ouEdge }) {
  const isMLPlay = mlPick && (
    (model.confidence === "high"   && mlPick.edge > 0.04) ||
    (model.confidence === "medium" && mlPick.edge > 0.06)
  );
  // +EV ML: edge > 3% but doesn't clear the PLAY bar
  const isMLEV   = mlPick && mlPick.edge > 0.03 && !isMLPlay;
  const isRLPlay = rlPick && rlMarginEdge !== null && rlMarginEdge >= 0.75 && model.confidence !== "low";
  const isOUPlay = ouEdge !== null && Math.abs(ouEdge) >= 1.5;
  const hasPlay  = isMLPlay || isRLPlay || isOUPlay;
  return { isMLPlay, isMLEV, isRLPlay, isOUPlay, hasPlay };
}

// ── DB-stored pick helpers (Results dashboard) ─────────────────────────────
// Recompute confidence for a DB-stored pick using current BOARD_CONFIGS thresholds/ceilings.
// Returns null for Ks picks (full conf requires pitcher model inputs not stored in DB).
// Returns null for `nrfi` too: its conf is the model's edge in percentage points
// (7.0 = the strong cut), NOT the 0–10 board scale calcConfidence produces, so
// mapping it through would put it in confidence tiers it doesn't belong to.
export function pickCurrentConf(p) {
  if (!p.model_score || !p.prop_type || p.prop_type === "ks" || p.prop_type === "nrfi") return null;
  return calcConfidence(p.model_score, p.prop_type);
}

// True if this pick would qualify under the current per-prop threshold.
// Ks picks are assumed valid (they passed isOfficialKsPick at save time; xKEdge not stored).
// For NEW picks (conf stored in DB): check conf >= pickThresh exactly.
// For LEGACY picks (saved before threshold system, conf=null): gate on model_score >= display
// thresh so entire prop categories (HR, Hits) aren't retroactively excluded.
export function pickMeetsCurrentThreshold(p) {
  if (p.prop_type === "ks") return true;
  // Game-keyed markets (ml/rl/ou/nrfi) have no BOARD_CONFIGS entry — they gate at
  // save time on their own model edge, not a board conf. Without this passthrough
  // the `cfg` miss below silently drops every one of them out of Results.
  if (p.prop_type === "ml" || p.prop_type === "rl" || p.prop_type === "ou" || p.prop_type === "nrfi") return true;
  const cfg = BOARD_CONFIGS[p.prop_type];
  if (!cfg) return false;
  // New save: conf column was stored at save time — pick already passed the official gate
  if (p.conf != null) return p.conf >= (cfg.pickThresh ?? Infinity);
  // Legacy save: recompute conf; use display thresh as floor (not strict pickThresh)
  // to avoid wiping out entire prop categories from historical record
  const conf = pickCurrentConf(p);
  if (conf == null) return false;
  return (p.model_score ?? 0) >= cfg.thresh;
}
