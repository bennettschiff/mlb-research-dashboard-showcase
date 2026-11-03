// ── Golden board results math ────────────────────────────────────────────────
//
// One rollup shared by the grader (scripts/golden-snapshot.mjs, which writes the
// per-day `results` blob) and the Results tab (components/results/GoldenTable),
// so a board's record is computed in exactly one place.
//
// WHY THIS EXISTS AS ITS OWN ROLLUP. results.js works on `mlb_picks` rows —
// outcome strings, best_odds, prop_type. Board picks are a different shape
// entirely (won booleans, bookOdds/bestOdds, rank, modelProb) and live in
// golden_snapshots, so they cannot go through rollup(). More importantly they
// need a number results.js never computes: BREAKEVEN.
//
// Breakeven is the whole point of this file. The "10 Most Likely" board wins
// 68.4% of its picks — which reads like a monster — at an average price of −237,
// where you need 70.3% just to stay level. Win rate alone says the board is
// great; win rate MINUS breakeven says it is 1.9 points underwater and has cost
// 16.5u over 50 days. Every board row leads with that gap for that reason.
//
// Everything here is additive across days: a window's record is the sum of its
// days' `results` blobs, which is why the table can render a full board record
// without ever loading a single pick.

import { ODDS_BANDS } from "./results.js";
import { isPlayPick } from "./goldenBoards.js";

export const toDecimal = (a) => (a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a));

// Board picks changed shape when the single Golden 10 was split into three
// (2026-08-06): the live boards carry bookOdds/modelProb, the archived 'legacy'
// rows carry bestOdds/impliedProb. Read through one accessor so a slice never
// silently drops half the sample.
export const goldenOdds = (p) => {
  const o = Number.isFinite(p?.bookOdds) ? p.bookOdds : p?.bestOdds;
  return Number.isFinite(Number(o)) && Number(o) !== 0 ? Number(o) : null;
};
export const goldenProb = (p) => {
  const v = Number.isFinite(p?.modelProb) ? p.modelProb : p?.impliedProb;
  return Number.isFinite(Number(v)) ? Number(v) : null;
};

// ── Board display metadata ───────────────────────────────────────────────────
// Board CONFIG (what each board selects, and how) lives in goldenBoards.js. This
// is only how a board presents in the results table, plus the one board that
// config no longer describes: 'legacy', the original Golden 10, closed 2026-08-17.
export const GOLDEN_RESULT_BOARDS = [
  { key: "likely", label: "10 Most Likely", short: "Likely", closed: false, research: false,
    note: "Highest model probability, any line — the chalk board" },
  { key: "lines", label: "10 Best Lines", short: "Lines", closed: false, research: false,
    note: "Biggest edge on each market's main line" },
  { key: "value", label: "10 Best Value", short: "Value", closed: false, research: true,
    note: "Biggest edge on alternate lines" },
  { key: "legacy", label: "OG Golden 10", short: "OG", closed: true, research: false,
    note: "The original goldenScore board (0.6·conf + 0.4·prob). Retired 2026-08-17 — browser-locked, so its days are sporadic" },
];
export const goldenBoardMeta = (key) =>
  GOLDEN_RESULT_BOARDS.find((b) => b.key === key) || { key, label: key, short: key, closed: false, research: false, note: "" };
export const goldenBoardOrder = (key) => {
  const i = GOLDEN_RESULT_BOARDS.findIndex((b) => b.key === key);
  return i === -1 ? 99 : i;
};

// ── Totals ───────────────────────────────────────────────────────────────────
// The additive core. `sumDec` and `sumProb` are carried so breakeven and
// calibration survive summation — averaging two days' average prices would
// weight a 2-pick day the same as a 10-pick one.
// The play-tier counters mirror the board-wide ones and stay FLAT rather than
// nested, because every one of them has to survive addTotals() unchanged — a
// window's record is the sum of its days, and a nested block would need its own
// merge path. See goldenBoards.PLAY_LIMIT_LIKELY for what the tier is and why it
// is defined on rank instead of probability.
export const emptyTotals = () => ({
  wins: 0, losses: 0, pushes: 0, pending: 0,
  pricedN: 0, units: 0, sumDec: 0, sumProb: 0, probN: 0, dayCount: 0,
  playWins: 0, playLosses: 0, playPricedN: 0, playUnits: 0, playSumDec: 0,
});

export function addTotals(a, b) {
  return {
    wins: a.wins + (b.wins || 0),
    losses: a.losses + (b.losses || 0),
    pushes: a.pushes + (b.pushes || 0),
    pending: a.pending + (b.pending || 0),
    pricedN: a.pricedN + (b.pricedN || 0),
    units: a.units + (b.units || 0),
    sumDec: a.sumDec + (b.sumDec || 0),
    sumProb: a.sumProb + (b.sumProb || 0),
    probN: a.probN + (b.probN || 0),
    dayCount: a.dayCount + (b.dayCount || 0),
    playWins: a.playWins + (b.playWins || 0),
    playLosses: a.playLosses + (b.playLosses || 0),
    playPricedN: a.playPricedN + (b.playPricedN || 0),
    playUnits: a.playUnits + (b.playUnits || 0),
    playSumDec: a.playSumDec + (b.playSumDec || 0),
  };
}

/** One stored `results` blob → the additive totals shape. */
export const totalsFromResults = (r) =>
  !r ? emptyTotals() : {
    wins: r.wins || 0,
    losses: r.losses || 0,
    pushes: r.pushes || 0,
    pending: r.pending || 0,
    pricedN: r.pricedN || 0,
    units: r.units || 0,
    // Rows graded before breakeven was tracked carry no sums. They contribute
    // their W-L and units and simply abstain from the price/calibration columns,
    // which is why those read from their own denominators (pricedN/probN) rather
    // than from the record.
    sumDec: r.sumDec || 0,
    sumProb: r.sumProb || 0,
    probN: r.probN || 0,
    dayCount: 1,
    // Blobs written before the play line existed (pre 2026-08-27) carry no play
    // counters. They contribute 0 and abstain from the play columns, exactly as
    // pre-breakeven rows abstain from sumDec — a day with no play record must not
    // read as a day the play tier went 0-0.
    playWins: r.playWins || 0,
    playLosses: r.playLosses || 0,
    playPricedN: r.playPricedN || 0,
    playUnits: r.playUnits || 0,
    playSumDec: r.playSumDec || 0,
  };

/**
 * Totals → every derived number the table shows.
 *
 * decided excludes pushes (a push is no action, not a coin flip resolved badly).
 * breakeven is the stake-weighted implied probability of the prices actually
 * taken: sum(1u staked) / sum(decimal payout) — i.e. the win rate at which this
 * exact set of bets returns exactly zero.
 */
export function finishTotals(t) {
  const decided = t.wins + t.losses;
  const settled = decided + t.pushes;
  const winPct = decided ? (t.wins / decided) * 100 : null;
  const playDecided = (t.playWins || 0) + (t.playLosses || 0);
  // sumDec counts pushes too when they were priced, so the denominator has to be
  // the same set. Grading excludes pushes from both, keeping this consistent.
  const breakeven = t.sumDec > 0 ? (t.pricedN / t.sumDec) * 100 : null;
  return {
    ...t,
    decided, settled,
    n: settled,
    winPct,
    breakeven,
    // The single number that says whether a board makes money. Positive = the
    // board beats the prices it is actually getting.
    gap: winPct == null || breakeven == null ? null : winPct - breakeven,
    roiPct: t.pricedN > 0 ? (t.units / t.pricedN) * 100 : null,
    avgOdds: t.pricedN > 0 ? decimalToAmerican(t.sumDec / t.pricedN) : null,
    // Model-said vs actually-happened. Positive = the board's probabilities are
    // optimistic, which is a model problem the board inherits.
    modelPct: t.probN > 0 ? (t.sumProb / t.probN) * 100 : null,
    calibErr: t.probN > 0 && winPct != null ? (t.sumProb / t.probN) * 100 - winPct : null,
    // ── Play tier: the same numbers over just the ranks that get bet ──────────
    // A board can be underwater overall and profitable where it counts; on
    // `likely` that is the whole story (top 3 +7.4% ROI, all 10 -3.6%). These
    // read null on a board with no play line rather than echoing the board-wide
    // figures, so "no play tier" never masquerades as a play record.
    playDecided,
    playWinPct: playDecided ? (t.playWins / playDecided) * 100 : null,
    playBreakeven: t.playSumDec > 0 ? (t.playPricedN / t.playSumDec) * 100 : null,
    playGap:
      playDecided && t.playSumDec > 0
        ? (t.playWins / playDecided) * 100 - (t.playPricedN / t.playSumDec) * 100
        : null,
    playRoiPct: t.playPricedN > 0 ? (t.playUnits / t.playPricedN) * 100 : null,
  };
}

export function decimalToAmerican(d) {
  if (!Number.isFinite(d) || d <= 1) return null;
  return d >= 2 ? Math.round((d - 1) * 100) : -Math.round(100 / (d - 1));
}

// ── Grading one pick ─────────────────────────────────────────────────────────
// `won` is written by the grader. This only turns a settled pick into P/L, so
// the UI and the grader agree on what a push and an unpriced pick are worth.
export function pickUnits(p) {
  if (p?.won == null || p?.push) return 0;
  const odds = goldenOdds(p);
  if (odds == null) return 0;
  return p.won ? toDecimal(odds) - 1 : -1;
}

/**
 * Settle one board pick against the stat it was written on.
 *
 * DIRECTION-AWARE ON PURPOSE. Every live board pick is an over — the Brain Trust
 * surface only prices overs — so a bare `actual > line` happened to be correct
 * for them. The archived OG board is not: it carries 44 Ks unders and 5 total
 * unders, and an over-only comparison grades every one of those backwards.
 *
 * A whole-number line the stat lands exactly on is a PUSH, not a loss. The prop
 * boards run half-lines and can never push; the OG board's game totals (O/U 8,
 * 13) can.
 */
export function settlePick(pick, actual) {
  const v = Number(actual);
  const line = Number(pick?.line);
  if (!Number.isFinite(v) || !Number.isFinite(line)) {
    return { actual: Number.isFinite(v) ? v : null, won: null, push: false };
  }
  if (v === line) return { actual: v, won: null, push: true };
  const under = (pick?.direction || "over") === "under";
  return { actual: v, won: under ? v < line : v > line, push: false };
}

/** A set of graded board picks → the stored `results` shape. */
export function summarizePicks(picks) {
  const t = emptyTotals();
  t.dayCount = 1;
  for (const p of picks || []) {
    if (p.push) { t.pushes++; continue; }
    if (p.won == null) { t.pending++; continue; }
    if (p.won) t.wins++; else t.losses++;
    // Trust the stored `play` flag when the snapshot carries one, and fall back
    // to re-deriving it from (board, rank) for rows written before the flag
    // existed. Stored wins: if the play line is ever retuned, a historical day
    // keeps the tier it was actually run with instead of being retroactively
    // rewritten by today's config.
    const isPlay = typeof p.play === "boolean" ? p.play : isPlayPick(p.board, p.rank);
    if (isPlay) { if (p.won) t.playWins++; else t.playLosses++; }
    const prob = goldenProb(p);
    if (prob != null) { t.sumProb += prob; t.probN++; }
    const odds = goldenOdds(p);
    if (odds == null) continue;
    t.pricedN++;
    t.sumDec += toDecimal(odds);
    t.units += p.won ? toDecimal(odds) - 1 : -1;
    if (isPlay) {
      t.playPricedN++;
      t.playSumDec += toDecimal(odds);
      t.playUnits += p.won ? toDecimal(odds) - 1 : -1;
    }
  }
  const decided = t.wins + t.losses;
  return {
    // Keys GoldenBoards.jsx already renders — shape preserved exactly.
    n: decided + t.pushes,
    wins: t.wins,
    losses: t.losses,
    pushes: t.pushes,
    pending: t.pending,
    winRate: decided ? t.wins / decided : null,
    pricedN: t.pricedN,
    units: +t.units.toFixed(4),
    roi: t.pricedN ? +(t.units / t.pricedN).toFixed(4) : null,
    // Added 2026-08-25 so a window's breakeven and calibration are derivable
    // from the day rows alone, without loading every pick.
    sumDec: +t.sumDec.toFixed(6),
    sumProb: +t.sumProb.toFixed(6),
    probN: t.probN,
    // Added 2026-08-27 with the play line, for the same reason: the played
    // record has to be summable from the day rows alone.
    playWins: t.playWins,
    playLosses: t.playLosses,
    playPricedN: t.playPricedN,
    playUnits: +t.playUnits.toFixed(4),
    playSumDec: +t.playSumDec.toFixed(6),
  };
}

/** Rollup straight from picks — used by every drill-down slice. */
export const rollupGoldenPicks = (picks) => finishTotals(totalsFromResults(summarizePicks(picks)));

// ── Board rows ───────────────────────────────────────────────────────────────

/** Inclusive date filter. `from`/`to` may be null for an open end. */
export const inDateRange = (date, from, to) =>
  !!date && (!from || date >= from) && (!to || date <= to);

/**
 * Snapshot rows ({ pick_date, board, results }) → one row per board, plus the
 * per-day record strip the table renders as "8-2 · +2.8u".
 *
 * Days with no settled pick are dropped rather than shown as 0-0: a board that
 * was written but never graded is not a day the board went even.
 */
export function goldenBoardRows(rows, { from = null, to = null } = {}) {
  const byBoard = new Map();
  for (const r of rows || []) {
    if (!r?.board || !r?.results) continue;
    if (!inDateRange(r.pick_date, from, to)) continue;
    const day = { ...finishTotals(totalsFromResults(r.results)), date: r.pick_date };
    if (day.settled === 0) continue;
    if (!byBoard.has(r.board)) byBoard.set(r.board, []);
    byBoard.get(r.board).push(day);
  }
  return [...byBoard.entries()]
    .map(([board, days]) => {
      days.sort((a, b) => (a.date < b.date ? -1 : 1));
      const totals = finishTotals(days.reduce((acc, d) => addTotals(acc, d), emptyTotals()));
      return {
        board,
        ...goldenBoardMeta(board),
        days,
        ...totals,
        greenDays: days.filter((d) => d.units > 0).length,
        redDays: days.filter((d) => d.units < 0).length,
        firstDate: days[0]?.date ?? null,
        lastDate: days[days.length - 1]?.date ?? null,
      };
    })
    .sort((a, b) => goldenBoardOrder(a.board) - goldenBoardOrder(b.board));
}

/** Cumulative units by day, for the board's equity sparkline. */
export function goldenEquity(days) {
  let c = 0;
  return days.map((d) => { c += d.units; return { date: d.date, flat: c, weighted: c, dayFlat: d.units, dayWeighted: d.units }; });
}

// ── Drill-down slices ────────────────────────────────────────────────────────

// The slice that answers "how far down the board should real money go". On the
// likely board ranks 1-3 run +7.1% ROI while ranks 7-10 run −10.1%, so the board
// is not one thing — it is a profitable top and a losing tail.
export const RANK_SLICES = [
  { key: "top", label: "Ranks 1-3", test: (r) => r >= 1 && r <= 3 },
  { key: "mid", label: "Ranks 4-6", test: (r) => r >= 4 && r <= 6 },
  { key: "tail", label: "Ranks 7-10", test: (r) => r >= 7 },
];

export function byRankSlice(picks) {
  return RANK_SLICES.map((s) => {
    const ps = (picks || []).filter((p) => Number.isFinite(p.rank) && s.test(p.rank));
    return { ...s, picks: ps, ...rollupGoldenPicks(ps) };
  }).filter((s) => s.settled > 0);
}

export function byGoldenMarket(picks) {
  const groups = new Map();
  for (const p of picks || []) {
    const k = p.market || "—";
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }
  return [...groups.entries()]
    .map(([market, ps]) => ({ key: market, label: market, picks: ps, ...rollupGoldenPicks(ps) }))
    .filter((m) => m.settled > 0)
    .sort((a, b) => a.units - b.units);
}

export function byGoldenOddsBand(picks) {
  return ODDS_BANDS.map((band) => {
    const ps = (picks || []).filter((p) => {
      const o = goldenOdds(p);
      return o != null && band.test(o);
    });
    return { ...band, picks: ps, ...rollupGoldenPicks(ps) };
  }).filter((b) => b.settled > 0);
}

/**
 * The board's best real-money slice: the deepest rank cut that is still ahead of
 * its own breakeven, plus the market most responsible for the damage.
 *
 * Deliberately conservative — it returns null under MIN_SLICE_N rather than
 * pointing real money at a 12-pick sample. This is the one number on the page
 * that is an instruction rather than a record, so it has to be earned.
 */
export const MIN_SLICE_N = 40;

export function bestMoneySlice(picks) {
  const cuts = [3, 5, 10];
  let best = null;
  for (const depth of cuts) {
    const ps = (picks || []).filter((p) => Number.isFinite(p.rank) && p.rank <= depth);
    const r = rollupGoldenPicks(ps);
    if (r.decided < MIN_SLICE_N || r.gap == null) continue;
    if (!best || r.roiPct > best.roiPct) best = { depth, ...r };
  }
  return best && best.gap > 0 ? best : null;
}

/** The market dragging a board down hardest, and what the board does without it. */
export function worstMarket(picks) {
  const markets = byGoldenMarket(picks);
  if (markets.length < 2) return null;
  const worst = markets[0];
  if (worst.units >= 0) return null;
  const without = rollupGoldenPicks((picks || []).filter((p) => p.market !== worst.key));
  return { market: worst.key, ...worst, without };
}
