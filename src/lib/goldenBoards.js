// ── Golden boards: three ranked top-10 tables over one per-line surface ──────
//
// Replaces the single goldenScore board (src/lib/golden.js), which ranked saved
// official picks by 0.6*conf + 0.4*prob. That blend never looked at price, so it
// filled 76% of its slots with Hits O0.5 chalk at an average of -238 (breakeven
// 69.2%) and returned -5.2% ROI over 57 days while winning 63.8% of the time.
// Worse, probNorm was raw event probability, so a market's ceiling was its own
// base rate: HR picks topped out at gs 0.647 against a ~0.83 cut and could never
// qualify no matter how good the pick was.
//
// The substrate here is instead the Brain Trust per-line surface
// (brain_trust_snapshots.predictions — see scripts/brain-trust-snapshot.mjs),
// which prices EVERY line on the ladder from daily_odds standard + alternate
// markets and attaches modelProb / edge / ev / trust per row. Boards then differ
// only in which slice of that surface they draw from and how they sort it.
//
// Backtest, 37 graded days 2026-06-17 → 2026-08-04 (scratch harness over the
// same predictions rows these configs read):
//   likely  208-86  70.7%  +0.15u   +0.1% ROI
//   lines   106-169 38.5%  +17.55u  +6.4% ROI
//   value    98-190 34.0%  -38.24u  -13.3% ROI   ← research-only, see RESEARCH
//
// Every board is gated to trust === 'trusted' (models.js lineTrust). That gate is
// load-bearing, not hygiene: ungated, the value board fills 49% of its slots with
// tb O4.5 — a line the logistic was never fitted at, which reports a median EV of
// +1.00 — and runs 17.9% / -11.4% ROI.

// A market's primary posted line, i.e. the one the official pick boards bet.
// Everything else on the ladder is an alternate.
export const MAIN_LINES = {
  hits: [0.5],
  tb:   [1.5],
  hrr:  [1.5],
  rbi:  [0.5],
  hr:   [0.5],
  sb:   [0.5],
  ks:   [4.5, 5.5],
};

export function isMainLine(market, line) {
  return (MAIN_LINES[market] || []).includes(line);
}

// Odds guardrails. Chosen to keep -10000 chalk and +1400 lottery tickets off
// every board; the exact bounds are the operator's call (2026-08-06).
export const ODDS_FLOOR_LIKELY = -300;
export const ODDS_FLOOR_PRICED = -175;
export const ODDS_CEIL = 500;

// Max rows any single (market, line) may claim on a board. Without it the likely
// board is 83% hrr O0.5 — the same monoculture failure the old goldenScore had
// with hits, just relocated. Capping at 3 costs nothing and returns +0.1% vs
// -0.6% ROI; capping at 2 over-constrains and drops to -5.0%.
export const MARKET_LINE_CAP = 3;

// ── The play line ────────────────────────────────────────────────────────────
// `playLimit` splits a board into the ranks you BET and the ranks you only
// TRACK. The board still selects and stores all 10 — the record stays unbroken
// and the research stays visible — but only ranks <= playLimit carry the play
// marker.
//
// WHY RANK AND NOT PROBABILITY. Bucketing `likely` by modelProb over 52 days
// gives a clean gradient (<0.65 = -17.4% ROI, 0.75+ = +4.8%), and the obvious
// move is to gate on modelProb >= 0.75. That gate is forbidden here: CLAUDE.md's
// standing rule is that gates live in SCORE space, never probability space,
// because a prob threshold silently retunes the moment modelImpliedProb is
// recalibrated — exactly what caused the HRR 0-pick drought in 2026-06. Rank is
// ordinal and immune to that: recalibrating every probability in the book cannot
// change which pick is 3rd.
//
// It is also simply better. Measured on 508 graded picks over 52 days, cumulative
// top-N on `likely` (split train <= 2026-07-31 / test after):
//
//   top 3   +11.44u  +7.4% ROI   train +6.4%  test +8.4%   ← both halves positive
//   top 5    +2.60u  +1.0%       train +1.9%  test +0.1%
//   top 7    +1.48u  +0.4%       train +0.6%  test +0.2%
//   top 10  -18.12u  -3.6%       train -0.8%  test -6.4%
//
// top 3 beats the modelProb >= 0.75 filter (+4.5%) while needing no calibration
// assumption at all. Ranks 4-10 are where the board's entire loss lives.
//
// `lines` and `value` get NO play line: `lines` has no stable rank cut (its top 3
// is its WORST slice at -19.6%, and the tail that looks good flips sign out of
// sample), and `value` is research-only. A null playLimit means "no play tier" —
// it is not a synonym for 10.
export const PLAY_LIMIT_LIKELY = 3;

export const GOLDEN_BOARDS = [
  {
    key: "likely",
    label: "10 Most Likely",
    blurb: "Highest model probability, any line. Prediction-driven markets included.",
    research: false,
    // Ranks 1-3 are the play tier; 4-10 stay on the board as tracked research.
    playLimit: PLAY_LIMIT_LIKELY,
    oddsFloor: ODDS_FLOOR_LIKELY,
    oddsCeil: ODDS_CEIL,
    lineScope: "any",
    minEdge: null,
    // This board ranks on model conviction alone, so a price is a GUARDRAIL, not
    // an input. Markets we model but never price — NRFI/YRFI, which The Odds API
    // does not post — are ranked on the same footing rather than barred for a
    // missing field. The other two boards rank by edge vs. the book, which is
    // arithmetically undefined without a price, so they stay priced-only.
    requiresPrice: false,
    sortBy: (p) => p.modelProb,
    sortLabel: "model probability",
  },
  {
    key: "lines",
    label: "10 Best Lines",
    blurb: "Biggest edge on each market's main line — TB 1.5, RBI 0.5, HRR 1.5, Ks.",
    research: false,
    // No play line: this board's rank order carries no usable signal. Its top 3
    // is its worst slice (-19.6% ROI over 52 days) — the biggest computed edge on
    // a main line is most often a stale or mis-modelled price, not the best bet —
    // and the mid-tail that looks good (ranks 4-8, +6.8% train) flips to -1.3%
    // out of sample. The whole board is +0.1% ROI; there is nothing to cut to.
    playLimit: null,
    oddsFloor: ODDS_FLOOR_PRICED,
    oddsCeil: ODDS_CEIL,
    lineScope: "main",
    minEdge: 0,
    requiresPrice: true,
    sortBy: (p) => p.edge,
    sortLabel: "edge vs. book",
  },
  // RESEARCH-ONLY. Alternate lines are where "2 hits at +320" lives, and it is
  // the one board the data does not support: -13.3% ROI over the window, and
  // every variant tried (EV sort, edge sort, edge>0, +100..+500, prob floors)
  // landed between -13% and -17%. Tracked anyway so it accumulates a real live
  // record — if alt-line calibration improves it earns promotion, and if it
  // keeps losing there are receipts. Do NOT present it as a play board.
  {
    key: "value",
    label: "10 Best Value",
    blurb: "Biggest edge on alternate lines. Research only — negative ROI in backtest.",
    research: true,
    // Research-only boards have no play tier by definition — nothing here is bet.
    playLimit: null,
    oddsFloor: ODDS_FLOOR_PRICED,
    oddsCeil: ODDS_CEIL,
    lineScope: "alt",
    minEdge: null,
    requiresPrice: true,
    sortBy: (p) => p.edge,
    sortLabel: "edge vs. book",
  },
];

export const GOLDEN_BOARD_KEYS = GOLDEN_BOARDS.map((b) => b.key);
export const getBoardConfig = (key) => GOLDEN_BOARDS.find((b) => b.key === key) || null;

/** This board's play line, or null if it has no play tier. */
export const boardPlayLimit = (key) => getBoardConfig(key)?.playLimit ?? null;

/**
 * Is this rank inside its board's play tier?
 *
 * A board with no play line returns FALSE for every rank, not true — "no play
 * tier" means nothing on it is a play, which is the correct reading for the
 * research board and for `lines`, where no cut beat the whole board. Callers
 * that want "play tier, or the whole board when there is no line" must say so.
 */
export const isPlayPick = (boardKey, rank) => {
  const lim = boardPlayLimit(boardKey);
  return lim != null && Number.isFinite(rank) && rank <= lim;
};

function inScope(scope, market, line) {
  if (scope === "any") return true;
  const main = isMainLine(market, line);
  return scope === "main" ? main : !main;
}

// Markets we model but never get a price for. They carry a modelProb and grade
// normally, so a probability-ranked board can rank them; they simply have no
// edge, no EV and no realisable units.
export const UNPRICED_MARKETS = new Set(["nrfi"]);
export const isUnpriced = (market) => UNPRICED_MARKETS.has(market);

/**
 * Pick one board's top 10 from a Brain Trust predictions surface.
 *
 * @param predictions rows of { name, market, line, modelProb, bookOdds, edge, ev, trust, ... }
 * @param boardKey    'likely' | 'lines' | 'value'
 * @param limit       slots to fill (default 10)
 * @returns up to `limit` rows, ranked, each tagged { board, rank }
 *
 * Selection order is deterministic: filter → sort by the board's metric desc →
 * walk the pool taking a row only if its player is unclaimed on THIS board and
 * its (market, line) is under the cap. A player may appear on more than one
 * board (Judge O0.5 on likely, Judge O1.5 on value is informative, not a dupe),
 * but never twice on the same one.
 */
export function selectBoard(predictions, boardKey, limit = 10) {
  const cfg = getBoardConfig(boardKey);
  if (!cfg || !Array.isArray(predictions)) return [];

  const pool = predictions.filter((p) => {
    if (!p || p.trust !== "trusted") return false;
    // An unpriced market skips the odds guardrail on a board that does not need a
    // price. It must still clear every other filter, and a board that ranks by
    // edge rejects it below because cfg.sortBy returns null.
    const unpriced = isUnpriced(p.market) && !Number.isFinite(p.bookOdds);
    if (!unpriced || cfg.requiresPrice) {
      if (!Number.isFinite(p.bookOdds)) return false;
      if (p.bookOdds < cfg.oddsFloor || p.bookOdds > cfg.oddsCeil) return false;
    }
    if (!inScope(cfg.lineScope, p.market, p.line)) return false;
    if (cfg.minEdge != null && !(p.edge > cfg.minEdge)) return false;
    const metric = cfg.sortBy(p);
    return Number.isFinite(metric);
  });

  // Sort by the board metric, then by modelProb as a stable tiebreak so two rows
  // with identical edge don't order on array position (which varies with the
  // scan's player order and would make snapshots non-reproducible).
  pool.sort((a, b) => (cfg.sortBy(b) - cfg.sortBy(a)) || (b.modelProb - a.modelProb));

  const claimedPlayers = new Set();
  const perMarketLine = new Map();
  const out = [];
  for (const p of pool) {
    if (out.length >= limit) break;
    if (claimedPlayers.has(p.name)) continue;
    const ml = `${p.market}|${p.line}`;
    if ((perMarketLine.get(ml) || 0) >= MARKET_LINE_CAP) continue;
    claimedPlayers.add(p.name);
    perMarketLine.set(ml, (perMarketLine.get(ml) || 0) + 1);
    const rank = out.length + 1;
    // `play` is stored on the snapshot so a day's play tier is a fact of the
    // record, not something re-derived later from a playLimit that may have
    // moved. If the line is retuned, history keeps the tier it was actually run
    // with — same reason the weighted P/L track reads the controller multiplier
    // in force on the pick's own date.
    out.push({ ...p, board: cfg.key, rank, play: isPlayPick(cfg.key, rank) });
  }
  return out;
}

/** Build all three boards at once. Returns { likely: [...], lines: [...], value: [...] }. */
export function selectAllBoards(predictions, limit = 10) {
  const out = {};
  for (const b of GOLDEN_BOARDS) out[b.key] = selectBoard(predictions, b.key, limit);
  return out;
}
