// ══════════════════════════════════════════════════════════════════════════
// CONVICTION — the number a board displays and ranks on.
//
// WHY THIS EXISTS (2026-08-14). The Total Bases board was showing its top
// eight rows at "10.0" with not one 🎲 among them, and Home Run had the same
// shape. Nothing was broken in the gates; the display was lying:
//
//   • `calcConfidence` is the model's raw conviction. It is what gets stored
//     on a saved pick and what the lab sweeps. Unchanged by this module.
//   • `isOfficialPick` is the dice gate. Since the 2026-08-03 promotions it
//     also consults `gateOverrides.json`, where `tb conf_max = 9.3` and
//     `hr conf_max = 8.2 / score_max = 0.081` cap each market's top tail —
//     validated, money-making gates built on the repeatedly-derived
//     "priced-in top" finding (HR top-conf −66% ROI vs bottom +9%).
//   • The board rendered raw conviction and sorted on it, but drew the dice
//     from the gate. So the rows the gate had *rejected* sorted to the very
//     top of the board, wearing the biggest number on the page.
//
// Measured over the 21 scan days to 2026-08-14 (base conf, no result bonuses,
// so these understate what the live board shows): tb 546 board rows, 27% tied
// at the top of the scale, 28% above the 9.3 cap, and a MEDIAN OF 8 rows you
// had to scroll past before reaching one that could be a pick. hr: 1022 rows,
// 13% above its cap, median 8 blocked at the top too.
//
// ── THE RULE THIS MODULE ENFORCES ──
//
//   A row NEVER displays at or above its market's play line without the 🎲.
//
// If a downstream gate blocks a row that cleared the conviction bar, the row
// does not keep its number and quietly lose the dice — it FOLDS into the band
// just below the play line, carrying a tier that says why. The board keeps
// showing it (markets must never go dark — gateOverrides.js hard rule 1), it
// just stops outranking the plays. Ranking and pickability point the same way
// again, which is the whole point of a conviction number.
//
// Everything here is display/ranking only. calcConfidence, isOfficialPick,
// isOfficialKsPick and gameLineGates are untouched, so the saved `conf`
// column, the pick set and the lab ledger all keep their existing meaning —
// the same reasoning that let the edge controller ship without a
// modelVersions bump (see src/modelVersions.js header).
// ══════════════════════════════════════════════════════════════════════════

import {
  BOARD_CONFIGS,
  calcConfidence,
  isOfficialPick,
  isOfficialKsPick,
  ksRoleUncertain,
  KS_ROLE_GAP,
} from './picks.js';
import { getGateOverride } from './gateOverrides.js';

// ── Tier vocabulary ─────────────────────────────────────────────────────────
// One set of words for every board, so "how strong is this play" reads the
// same on Total Bases, on Ks and on the Slate Odds page.
//   play      — cleared the bar and the gates. Gets the 🎲. Saved to Results.
//   lean      — real signal, short of the line. Research, not a play.
//   research  — on the board because the market is worth watching.
//   priced_in — cleared the bar, then a VALIDATED cap rejected it: this market
//               loses money on its own top tail. Folded, and folded INVERTED
//               (the more extreme the read, the further it sinks).
//   blocked   — cleared the bar, then a requirement we can't satisfy rejected
//               it (a missing confirmed lineup, a line the market is sharp on).
//               Folded with its order preserved: unscorable, not disproven.
export const TIER = {
  play: 'play',
  lean: 'lean',
  research: 'research',
  pricedIn: 'priced_in',
  blocked: 'blocked',
};

export const TIER_META = {
  [TIER.play]:     { label: 'PLAY',      color: '#0f8a44', bg: 'rgba(15,138,68,0.12)' },
  [TIER.lean]:     { label: 'LEAN',      color: '#2569d6', bg: 'rgba(37,105,214,0.10)' },
  [TIER.research]: { label: 'RESEARCH',  color: '#74839d', bg: 'rgba(116,131,157,0.10)' },
  [TIER.pricedIn]: { label: 'PRICED IN', color: '#c2570f', bg: 'rgba(194,87,15,0.12)' },
  [TIER.blocked]:  { label: 'NO PLAY',   color: '#8b6ac9', bg: 'rgba(139,106,201,0.12)' },
};

// How far below the play line a folded row may sink, and the minimum gap that
// keeps it strictly below the line. 1.5 is wide enough that a folded row reads
// as clearly-not-a-play at a glance, narrow enough that it still sorts above
// the genuine low-conviction tail rather than being buried with it.
export const FOLD_BAND = 1.5;
const FOLD_GAP = 0.1;
// A row within this much of the line is a "lean" — close enough to be worth
// the read, not close enough to bet.
export const LEAN_BAND = 1.0;

const round1 = (v) => parseFloat(v.toFixed(1));

// Map a raw conviction that cleared the bar but was blocked downstream into
// [line − FOLD_BAND, line − FOLD_GAP].
//   inverted — true when the block came from a validated cap on the top tail,
//              so "further past the cap" means "worse", not "stronger".
//              false when the block is a data/market requirement, in which
//              case relative order carries no verdict and is preserved.
export function foldBelowLine(raw, line, { inverted = true, ceiling = 10 } = {}) {
  const span = Math.max(0.1, ceiling - line);
  const t = Math.min(1, Math.max(0, (raw - line) / span)); // 0..1 above the line
  const depth = inverted ? t : 1 - t;
  return round1(line - FOLD_GAP - depth * (FOLD_BAND - FOLD_GAP));
}

// The one place the invariant is enforced. Every conviction builder below ends
// here, so no board can accidentally grow a row that outranks the plays.
function settle({ raw, line, plays, block, ceiling = 10 }) {
  if (plays) return { conf: raw, raw, line, tier: TIER.play, reason: null, folded: false };
  if (raw < line) {
    return {
      conf: raw, raw, line, folded: false, reason: block?.reason ?? null,
      tier: raw >= line - LEAN_BAND ? TIER.lean : TIER.research,
    };
  }
  const inverted = block?.inverted ?? false;
  return {
    conf: foldBelowLine(raw, line, { inverted, ceiling }),
    raw, line, folded: true,
    tier: inverted ? TIER.pricedIn : TIER.blocked,
    reason: block?.reason ?? 'blocked by a downstream gate',
  };
}

// ── Batter boards ───────────────────────────────────────────────────────────

// Why did a row that cleared pickThresh not get the dice? Mirrors the order of
// checks inside isOfficialPick so the reason shown is the one that actually
// fired. Returns null when nothing blocks (i.e. the row is a play).
function batterBlockReason(boardKey, pick, conf, score) {
  if (boardKey === 'rbi') {
    const r = pick?.result;
    if (!r) return { reason: 'no model detail for this row', inverted: false };
    if (r.lineupOrder == null) {
      return { reason: 'needs a confirmed lineup — lineup-blind RBI picks hit ~30% vs 56%', inverted: false };
    }
    if (r.gameTotal == null) {
      return { reason: 'needs a posted game total', inverted: false };
    }
  }
  const o = getGateOverride(boardKey);
  if (o) {
    if (o.conf_max != null && conf > o.conf_max) {
      return {
        reason: `promoted cap: ${boardKey} conviction > ${o.conf_max} is a validated loser (priced-in top, ${o.source ?? 'lab'})`,
        inverted: true,
      };
    }
    if (o.score_max != null && score != null && score > o.score_max) {
      return {
        reason: `promoted cap: ${boardKey} model score > ${o.score_max} is a validated loser (priced-in top, ${o.source ?? 'lab'})`,
        inverted: true,
      };
    }
    if (o.conf_min != null && conf < o.conf_min) {
      return { reason: `promoted floor: ${boardKey} needs conviction ≥ ${o.conf_min}`, inverted: false };
    }
    if (o.score_min != null && score != null && score < o.score_min) {
      return { reason: `promoted floor: ${boardKey} needs model score ≥ ${o.score_min}`, inverted: false };
    }
  }
  return null;
}

// The conviction a batter board should display and rank on.
// Returns { conf, raw, line, tier, reason, folded }.
export function boardConviction(score, boardKey, pick) {
  const cfg = BOARD_CONFIGS[boardKey];
  const raw = calcConfidence(score, boardKey, pick);
  if (!cfg || cfg.pickThresh == null) {
    return { conf: raw, raw, line: null, tier: TIER.research, reason: null, folded: false };
  }
  const plays = isOfficialPick(raw, boardKey, pick);
  // Same field the override layer ranges over (see gateOverrides.test.js).
  const scoringScore = pick?.result?.adjScore ?? pick?.result?.score ?? null;
  return settle({
    raw,
    line: cfg.pickThresh,
    plays,
    block: plays ? null : batterBlockReason(boardKey, pick, raw, scoringScore),
  });
}

// ── Pitcher Ks ──────────────────────────────────────────────────────────────
// Ks run their own conviction scale (calcKConfidence) and their own gate, but
// the display rule is identical.
export const KS_PLAY_LINE = 8.5;
export const KS_OVER_LINE_CAP = 5.5;

function ksBlockReason(p) {
  if (ksRoleUncertain(p)) {
    return {
      reason: `book line is ${KS_ROLE_GAP}+ Ks off our projection — usually a role or workload change ` +
              `(opener, bulk day, innings limit) the book already knows; trust the line`,
      inverted: false,
    };
  }
  const signal = p?.signal;
  if (signal !== 'over' && signal !== 'under') {
    return { reason: 'the two K models disagree on direction — no side to bet', inverted: false };
  }
  if (signal === 'over' && (p?.line ?? 0) > KS_OVER_LINE_CAP) {
    return {
      reason: `K overs above O${KS_OVER_LINE_CAP} cash 17–22% at −59% ROI — the book is sharp on marquee K overs`,
      inverted: false,
    };
  }
  const o = getGateOverride('ks');
  if (o?.conf_max != null && (p?.conf ?? 0) > o.conf_max) {
    return { reason: `promoted cap: ks conviction > ${o.conf_max} is a validated loser`, inverted: true };
  }
  if (o?.conf_min != null && (p?.conf ?? 0) < o.conf_min) {
    return { reason: `promoted floor: ks needs conviction ≥ ${o.conf_min}`, inverted: false };
  }
  return { reason: 'blocked by the Ks pick gate', inverted: false };
}

export function ksConviction(p) {
  const raw = round1(p?.conf ?? 0);
  const plays = isOfficialKsPick(p ?? {});
  return settle({ raw, line: KS_PLAY_LINE, plays, block: plays ? null : ksBlockReason(p) });
}

// ── Game lines (Slate Odds: ML / RL / O-U) ──────────────────────────────────
//
// Each of these three markets had its own hand-rolled 1–10 score living inline
// in the JSX, each scaled to a different denominator (edge/0.12, margin/2,
// total/3) and each nudged by the moneyline confidence tier. None of them was
// anchored to its own play gate, so the page routinely showed a 7.6 with no
// dice sitting above a 5.8 with one — the same lie the batter boards told.
//
// The fix is to score each market in units of ITS OWN BAR: how much of the
// required edge does this game actually have? ratio 1.0 is the bar, and the
// bar is 7.0 on every market, on every row, all season.
export const GAME_PLAY_LINE = 7.0;
// The published gate constants, restated here as the denominators they always
// were. Kept in sync with gameLineGates() by conviction.test.js.
export const ML_REQUIRED_EDGE = { high: 0.04, medium: 0.06 };
export const RL_REQUIRED_EDGE = 0.75; // runs of cover over the spread
export const OU_REQUIRED_EDGE = 1.5;  // runs of total edge

// ratio (edge ÷ required edge) → 1–10 conviction, anchored so ratio 1 = the
// play line. Below the bar it falls away linearly to 1.0 at no edge; above it
// it climbs to 10.0 at 2.5× the required edge and stops.
export function ratioToConviction(ratio) {
  if (!Number.isFinite(ratio) || ratio <= 0) return 1.0;
  if (ratio < 1) return round1(1 + (GAME_PLAY_LINE - 1) * ratio);
  return round1(Math.min(10, GAME_PLAY_LINE + 3 * Math.min((ratio - 1) / 1.5, 1)));
}

// Moneyline. `low` model confidence can never produce a play at any edge, so
// it has no bar of its own — score it against the medium bar and let settle()
// fold it, which is exactly what it is: a big price edge on a game the model
// reads as a coin flip.
export function mlConviction({ model, mlPick, isMLPlay }) {
  const edge = mlPick?.edge ?? null;
  if (edge == null) {
    return { conf: null, raw: null, line: GAME_PLAY_LINE, tier: TIER.research, reason: 'no book moneyline', folded: false };
  }
  const tier = model?.confidence;
  const required = ML_REQUIRED_EDGE[tier] ?? ML_REQUIRED_EDGE.medium;
  const raw = ratioToConviction(edge / required);
  const block = tier === 'low'
    ? { reason: 'model reads this game as a coin flip — low confidence never plays the moneyline', inverted: false }
    : { reason: `needs > ${(required * 100).toFixed(0)}% edge at ${tier} confidence`, inverted: false };
  return settle({ raw, line: GAME_PLAY_LINE, plays: !!isMLPlay, block });
}

// Run line. Same shape; low confidence is again a hard block.
export function rlConviction({ model, rlPick, rlMarginEdge, isRLPlay }) {
  if (!rlPick || rlMarginEdge == null) {
    return { conf: null, raw: null, line: GAME_PLAY_LINE, tier: TIER.research, reason: 'no run line posted', folded: false };
  }
  const raw = ratioToConviction(rlMarginEdge / RL_REQUIRED_EDGE);
  const block = model?.confidence === 'low'
    ? { reason: 'low model confidence — the run line needs a game read to stand on', inverted: false }
    : { reason: `needs ≥ ${RL_REQUIRED_EDGE}R of cover over the spread`, inverted: false };
  return settle({ raw, line: GAME_PLAY_LINE, plays: !!isRLPlay, block });
}

// Total. The only one of the three that stands on its own market signal —
// gameLineGates does not consult the moneyline tier here, so neither do we.
export function ouConviction({ ouEdge, gameTotal, isOUPlay }) {
  if (ouEdge == null || gameTotal == null) {
    return { conf: null, raw: null, line: GAME_PLAY_LINE, tier: TIER.research, reason: 'no book total', folded: false };
  }
  const raw = ratioToConviction(Math.abs(ouEdge) / OU_REQUIRED_EDGE);
  return settle({
    raw, line: GAME_PLAY_LINE, plays: !!isOUPlay,
    block: { reason: `needs ≥ ${OU_REQUIRED_EDGE}R between the projection and the market total`, inverted: false },
  });
}

// The row's headline: the strongest scored market on this game, so the slate
// can be scanned in one column instead of three.
export function bestGameConviction(convictions) {
  let best = null;
  for (const [market, c] of Object.entries(convictions)) {
    if (!c || c.conf == null) continue;
    if (!best || c.conf > best.conf) best = { ...c, market };
  }
  return best;
}
