/**
 * src/lib/nrfi.js — 1st Inning (NRFI/YRFI) model runtime
 *
 * Pure math for the 1st Inning tab. The trained model ships in
 * src/lib/nrfiParams.json (written by `node scripts/nrfi-backtest.mjs
 * --export-params`): a half-inning gradient-boosted-stumps model + Platt
 * calibration, plus everything FIXED from the 2025 prior season (league
 * rates, per-pitcher/team first-inning priors, per-player season lines,
 * empirical venue first-inning factors).
 *
 * Current-season state (pitcher first-inning history, team first-inning
 * offense, team R/G) is rebuilt by the caller from season linescores via
 * buildSeasonState() — the same walk-forward substrate the backtest used.
 *
 * Backtest evidence (scripts/feature-lab/nrfi-backtest-2026-07-17.md):
 * rolling-origin OOS May–Jul pooled AUC 0.543, positive every month;
 * 56.9% accuracy on the ~27% of games with |p−0.5| ≥ 0.04 (majority
 * baseline 52.5%). Confidence tiers here mirror those cuts.
 *
 * Feature formulas MUST stay bit-identical to scripts/nrfi-backtest.mjs —
 * retrain + re-export rather than editing constants here.
 */

// Import attribute is required for plain `node` to load this module (Vite and
// vitest are fine either way) — scripts/nrfi-picks.mjs runs the same model
// server-side to save graded picks.
import PARAMS from "./nrfiParams.json" with { type: "json" };

const { league: L, shrink: S } = PARAMS;

// ── Small math ───────────────────────────────────────────────────────────────
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
export const nrfiLogit = (p) =>
  Math.log(clamp(p, 1e-6, 1 - 1e-6) / (1 - clamp(p, 1e-6, 1 - 1e-6)));
const sigmoid = (z) => 1 / (1 + Math.exp(-z));

// Innings notation moved to src/lib/innings.js on 2026-09-08 so modelKs could share it
// (it had been parseFloat-ing the same StatsAPI strings). Re-exported here because this
// is where every nrfi caller already imports it from. Behaviour on real StatsAPI values
// — the only ones nrfi sees — is identical; the shared version additionally refuses to
// re-read an already-decimal number as outs.
import { ipToDec } from "./innings.js";
export { ipToDec };

// ── Current-season state from linescore sweep ───────────────────────────────
/**
 * @param {Array} completed  Completed regular-season games, each:
 *   { starterTopId, starterBotId, homeId, awayId, r1Top, r1Bot, homeR, awayR }
 *   (starterTopId = home starter — pitches the top half; away offense bats top)
 * @returns state consumed by predictFirstInning
 */
export function buildSeasonState(completed) {
  const pit = new Map(),
    team = new Map(),
    rpg = new Map();
  const bump = (m, k, zero, runs) => {
    if (k == null) return;
    const s = m.get(String(k)) || { n: 0, zero: 0 };
    s.n++;
    s.zero += zero ? 1 : 0;
    m.set(String(k), s);
  };
  for (const g of completed) {
    bump(pit, g.starterTopId, g.r1Top === 0);
    bump(pit, g.starterBotId, g.r1Bot === 0);
    bump(team, g.awayId, g.r1Top === 0); // away bats top
    bump(team, g.homeId, g.r1Bot === 0);
    for (const [id, r] of [
      [g.homeId, g.homeR],
      [g.awayId, g.awayR],
    ]) {
      if (id == null || r == null) continue;
      const s = rpg.get(String(id)) || { n: 0, runs: 0 };
      s.n++;
      s.runs += r;
      rpg.set(String(id), s);
    }
  }
  return { pit, team, rpg };
}

// ── Feature builders (mirror scripts/nrfi-backtest.mjs exactly) ─────────────
function shrunkP0(cur, prior, priorWeight, k) {
  const pn = prior ? prior[0] : 0;
  const pz = prior ? prior[1] : 0;
  const n = (cur?.n || 0) + priorWeight * pn;
  const z = (cur?.zero || 0) + priorWeight * pz;
  return (z + k * L.L0_HALF) / (n + k);
}

export function pitcherInnDev(state, pid) {
  const p0 = shrunkP0(
    state.pit.get(String(pid)),
    PARAMS.priors.pitcherFirstInn[pid],
    S.W_PRIOR_PIT,
    S.K_PIT
  );
  return nrfiLogit(p0) - nrfiLogit(L.L0_HALF);
}

export function teamInnDev(state, teamId) {
  const p0 = shrunkP0(
    state.team.get(String(teamId)),
    PARAMS.priors.teamFirstInn[teamId],
    S.W_PRIOR_TEAM,
    S.K_TEAM
  );
  return nrfiLogit(p0) - nrfiLogit(L.L0_HALF);
}

export function teamRpgDev(state, teamId) {
  const cur = state.rpg.get(String(teamId)) || { n: 0, runs: 0 };
  const pr = PARAMS.priors.teamRpg[teamId] || [0, 0];
  const n = cur.n + S.W_PRIOR_TEAM * pr[0];
  const runs = cur.runs + S.W_PRIOR_TEAM * pr[1];
  return (runs + 25 * L.LEAGUE_RPG) / (n + 25) - L.LEAGUE_RPG;
}

/** stat26: MLB season pitching stat object (or null early season). */
export function pitcherQualDev(pid, stat26) {
  let ip = stat26 ? ipToDec(stat26.inningsPitched) : 0;
  let k = stat26?.strikeOuts || 0;
  let bb = stat26?.baseOnBalls || 0;
  let hr = stat26?.homeRuns || 0;
  let hbp = stat26?.hitBatsmen || 0;
  let bf = stat26?.battersFaced || 0;
  const pr = PARAMS.priors.pitcherSeason[pid];
  if (pr) {
    ip += 0.5 * pr.ip;
    k += 0.5 * pr.k;
    bb += 0.5 * pr.bb;
    hr += 0.5 * pr.hr;
    hbp += 0.5 * pr.hbp;
    bf += 0.5 * pr.bf;
  }
  if (ip < 5 || bf < 20) return { fipDev: 0, kbbDev: 0 };
  const fip = (13 * hr + 3 * (bb + hbp) - 2 * k) / ip + L.FIP_C;
  const kbb = (k - bb) / bf;
  const sh = ip / (ip + 40);
  return {
    fipDev: sh * (clamp(fip, 1.5, 8) - L.LEAGUE_FIP),
    kbbDev: sh * (clamp(kbb, -0.1, 0.45) - L.LEAGUE_KBB),
  };
}

/** stat26: MLB season hitting stat object (or null). */
export function batterOpsDev(bid, stat26) {
  let ab = stat26?.atBats || 0;
  let h = stat26?.hits || 0;
  let bb = stat26?.baseOnBalls || 0;
  let hbp = stat26?.hitByPitch || 0;
  let sf = stat26?.sacFlies || 0;
  let tb = stat26?.totalBases || 0;
  let pa = stat26?.plateAppearances || 0;
  const pr = PARAMS.priors.batterSeason[bid];
  if (pr) {
    ab += S.W_PRIOR_BAT * pr.ab;
    h += S.W_PRIOR_BAT * pr.h;
    bb += S.W_PRIOR_BAT * pr.bb;
    hbp += S.W_PRIOR_BAT * pr.hbp;
    sf += S.W_PRIOR_BAT * pr.sf;
    tb += S.W_PRIOR_BAT * pr.tb;
    pa += S.W_PRIOR_BAT * pr.pa;
  }
  if (pa < 30 || ab < 20) return 0;
  const obp = (h + bb + hbp) / Math.max(1, ab + bb + hbp + sf);
  const slg = tb / ab;
  const sh = pa / (pa + 120);
  return sh * (clamp(obp + slg, 0.35, 1.35) - L.LEAGUE_OPS);
}

/** batterDevs: per-slot OPS devs for the top of the order (≤6 entries). */
export function lineupOpsDev(batterDevs) {
  if (!batterDevs?.length) return 0;
  let s = 0,
    w = 0;
  batterDevs.forEach((d, i) => {
    const wt = S.LINEUP_W[i] ?? 0.2;
    s += wt * d;
    w += wt;
  });
  return w ? s / w : 0;
}

// ── Model evaluation ─────────────────────────────────────────────────────────
function gbmPredict(x) {
  const { base, lr, trees } = PARAMS.gbm;
  let f = nrfiLogit(base);
  for (const t of trees) f += lr * (x[t.j] <= t.t ? t.vL : t.vR);
  return sigmoid(f);
}

/**
 * Predict the first inning of one game.
 * half inputs: { pitcherId, pitcherStat26, offTeamId, lineupIds?, lineupStats? }
 * lineupStats: Map/obj of batterId → season hitting stat (only needs top 6).
 */
export function predictFirstInning({ top, bot, venueName, state }) {
  const halfFeatures = (h, isBottom) => {
    const q = pitcherQualDev(h.pitcherId, h.pitcherStat26);
    const devs = (h.lineupIds || []).slice(0, 6).map((bid) => batterOpsDev(bid, h.lineupStats?.[bid]));
    return [
      isBottom ? 1 : 0,
      h.pitcherId != null ? pitcherInnDev(state, h.pitcherId) : 0,
      teamInnDev(state, h.offTeamId),
      q.fipDev,
      q.kbbDev,
      lineupOpsDev(devs),
      teamRpgDev(state, h.offTeamId),
      PARAMS.venueDev[venueName] ?? 0,
    ];
  };
  const pTopRaw = gbmPredict(halfFeatures(top, false));
  const pBotRaw = gbmPredict(halfFeatures(bot, true));
  const raw = 1 - (1 - pTopRaw) * (1 - pBotRaw);
  const pYrfi = sigmoid(PARAMS.platt[0] + PARAMS.platt[1] * nrfiLogit(raw));
  // Calibrated half probs (scale each half by the same Platt shift ratio) —
  // display-only; the game-level pYrfi is the calibrated quantity.
  const scale = raw > 0 ? pYrfi / raw : 1;
  const pTop = clamp(pTopRaw * scale, 0.02, 0.98);
  const pBot = clamp(pBotRaw * scale, 0.02, 0.98);
  const projRuns = pTop * L.runsGivenRunTop + pBot * L.runsGivenRunBot;
  const { lean, tier, edge } = nrfiTier(pYrfi);
  return {
    pYrfi: +pYrfi.toFixed(4),
    pTop: +pTop.toFixed(4),
    pBot: +pBot.toFixed(4),
    projRuns: +projRuns.toFixed(2),
    lean,
    tier,
    edge: +edge.toFixed(4),
  };
}

// ── Tiers ───────────────────────────────────────────────────────────────────
/**
 * Side + confidence tier for a calibrated pYrfi.
 *
 * Cuts come from PARAMS.tiers — quantiles of the model's own out-of-fold
 * prediction distribution, written by the same run that fits the calibration.
 * They are NOT fixed offsets from 0.5, and that distinction is the whole point.
 *
 * The 2026-07-17 build used `|p - 0.5| >= 0.07` for strong. The live pYrfi
 * distribution turned out to run 0.431–0.620 centred on 0.519, so the NRFI
 * strong cut (p <= 0.43) was unreachable: 0 of 244 walk-forward games cleared
 * it and all 37 saved picks were YRFI — the under was not disfavoured, it was
 * impossible. Same class of bug as the 2026-06 HRR drought, where a gate
 * written in probability space silently stopped firing when the calibration
 * moved (see CLAUDE.md: gates live in score space, never probability space).
 * Quantile cuts are defined ON the distribution, so both sides stay reachable
 * by construction and move automatically whenever the model is refit.
 *
 * The 0.5 midpoint is deliberately NOT used to choose the side either — the
 * distribution's own median is, for the same reason.
 */
export function nrfiTier(pYrfi) {
  const T = PARAMS.tiers;
  // Pre-quantile params (≤ 2026-07-17) have no tiers block. Fall back to the
  // old fixed cuts rather than silently mis-tiering.
  if (!T) {
    const edge = Math.abs(pYrfi - 0.5);
    return {
      lean: pYrfi >= 0.5 ? "YRFI" : "NRFI",
      tier: edge >= 0.07 ? "strong" : edge >= 0.04 ? "lean" : "pass",
      edge,
    };
  }
  const mid = T.median;
  const isYrfi = pYrfi >= mid;
  const tier =
    pYrfi <= T.nrfiStrong || pYrfi >= T.yrfiStrong ? "strong"
    : pYrfi <= T.nrfiLean || pYrfi >= T.yrfiLean ? "lean"
    : "pass";
  return { lean: isYrfi ? "YRFI" : "NRFI", tier, edge: Math.abs(pYrfi - mid) };
}

export const NRFI_TIERS = PARAMS.tiers ?? null;

export const NRFI_PARAMS_VERSION = PARAMS.version;
export const NRFI_LEAGUE = L;
