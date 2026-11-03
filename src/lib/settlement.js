// ══════════════════════════════════════════════════════════════════════════
// ONE definition of "what did this pick pay".
//
// There were three, and they disagreed. Replaying the SAME post-April-5 rows
// through the lab evaluator and through the Results page returned Hits -21.06u
// vs -56.42u and HR -42.73u vs -11.86u — not different filters, different
// arithmetic on identical rows:
//
//   src/lib/results.js      best_odds || fair_line || -110
//   api/_sheets-feed.js     best_odds, else rebuild from the per-book columns,
//                           else leave the row BLANK
//   scripts/lib/lab-core    blank rows priced at the fallback_price slider
//
// THE RULE: only a price a bookmaker actually offered can settle a wager.
//
// `fair_line` is NOT such a price. It is the model's own fair value, derived
// from the same probability the pick was made on, so settling at it books
// winnings at a number the model invented for itself — and it is worse than a
// flat assumption, because the model assigns its FAVOURITE picks the most
// generous fair prices. 18.1% of graded picks (1,279 of 7,061) carry fair_line
// and no quote, and results.js was paying every one of them at it.
//
// A row with no quote is a row you could not have bet. It contributes 0 units
// and stays OUT of the ROI denominator, while still counting toward W/L — the
// model's accuracy on it is real, only the money is fictional. That is exactly
// the reasoning the 2026-08-27 NRFI fix established (93 August NRFI picks
// fabricated at -110 printed +29.2u and turned a -30u month into +9.2u); this
// generalises it from "markets The Odds API never posts" to "any row we never
// captured a price for", which is the same defect with a wider blast radius.
//
// A hypothetical price is still useful for research — "what would this have
// returned at -110" is a fair question. It just is not P/L. settleAssumed()
// answers it and labels itself, so a scenario can never be added to a realized
// total by accident.
// ══════════════════════════════════════════════════════════════════════════

import { bestBookOdds } from "./models.js";

/** Where a settlement price came from. Only QUOTED and RECOVERED are real money. */
export const PRICE_SOURCE = {
  QUOTED: "quoted", // best_odds — the price captured at pick time
  RECOVERED: "recovered", // rebuilt from the per-book columns on the row
  ASSUMED: "assumed", // a scenario price the caller supplied; never realized P/L
  NONE: "none", // no bookmaker price exists for this row
};

/** The per-book price columns, best-first is irrelevant — bestBookOdds picks. */
const BOOK_COLUMNS = ["fd_odds", "dk_odds", "fn_odds", "hr_odds"];

// Number(null) is 0, not NaN, so a bare Number.isFinite() reports every null price as a
// perfectly finite 0 and a naive check never fires. Zero is not a real American price
// either. (Same trap results.js already documents on its CLV line.)
export const noPrice = (v) => v == null || !Number.isFinite(Number(v)) || Number(v) === 0;

/**
 * The bookmaker price this pick can be settled at, and where it came from.
 * Never returns fair_line. Returns { odds: null, source: NONE } when nothing real exists.
 */
export function bookQuote(pick) {
  if (!pick) return { odds: null, source: PRICE_SOURCE.NONE };
  if (!noPrice(pick.best_odds)) {
    return { odds: Number(pick.best_odds), source: PRICE_SOURCE.QUOTED };
  }
  const recovered = bestBookOdds(
    Object.fromEntries(
      BOOK_COLUMNS.map((c) => [c, noPrice(pick[c]) ? null : Number(pick[c])])
    )
  );
  if (recovered != null) return { odds: recovered, source: PRICE_SOURCE.RECOVERED };
  return { odds: null, source: PRICE_SOURCE.NONE };
}

/** True when no bookmaker price is available, so the row cannot be settled for money. */
export const isUnpricedRow = (pick) => bookQuote(pick).odds == null;

/** Profit multiple on a 1u stake at an American price. -150 -> 0.667, +120 -> 1.2. */
export const profitPerUnit = (odds) => (odds > 0 ? odds / 100 : 100 / Math.abs(odds));

const isSettled = (o) => o === "win" || o === "loss";

/**
 * Realized settlement for one graded pick.
 *
 * Returns { units, staked, source }. `staked` is what belongs in the ROI denominator:
 * 0 for a push (stake returned) and 0 for an unpriced row (nothing was ever at risk).
 * Callers count W/L separately — an unpriced row is still a right or wrong prediction.
 */
export function settle(pick, stakeUnits = 1) {
  const outcome = pick?.outcome;
  if (!isSettled(outcome)) return { units: 0, staked: 0, source: bookQuote(pick).source };
  const { odds, source } = bookQuote(pick);
  if (odds == null) return { units: 0, staked: 0, source };
  const units = outcome === "win" ? profitPerUnit(odds) * stakeUnits : -stakeUnits;
  return { units, staked: stakeUnits, source };
}

/**
 * HYPOTHETICAL settlement: what this row would have returned at `assumedOdds`, for rows
 * that carry no quote. Explicitly separate from settle() so a scenario cannot be summed
 * into a realized total. Rows that DO carry a quote settle at the quote, as normal.
 */
export function settleAssumed(pick, stakeUnits = 1, assumedOdds = -110) {
  const outcome = pick?.outcome;
  if (!isSettled(outcome)) return { units: 0, staked: 0, source: bookQuote(pick).source };
  const { odds, source } = bookQuote(pick);
  if (odds != null) return settle(pick, stakeUnits);
  if (noPrice(assumedOdds)) return { units: 0, staked: 0, source };
  const units = outcome === "win" ? profitPerUnit(Number(assumedOdds)) * stakeUnits : -stakeUnits;
  return { units, staked: stakeUnits, source: PRICE_SOURCE.ASSUMED };
}
