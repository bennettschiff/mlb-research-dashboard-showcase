/**
 * Settlement is the one place that answers "what did this pick pay", and it exists
 * because there were three answers. Replaying identical post-April-5 rows through the
 * lab evaluator and the Results page returned Hits -21.06u vs -56.42u and HR -42.73u vs
 * -11.86u — same rows, different arithmetic.
 *
 * The invariant these tests defend: only a price a bookmaker actually offered can settle
 * a wager. Not fair_line (the model's own number), not a flat -110 stand-in, and not the
 * other side's price.
 */
import { describe, it, expect } from "vitest";
import {
  bookQuote, settle, settleAssumed, isUnpricedRow, profitPerUnit, noPrice, PRICE_SOURCE,
} from "./settlement.js";

const row = (o = {}) => ({ prop_type: "hits", outcome: "win", best_odds: null, ...o });

describe("bookQuote — where a settlement price may come from", () => {
  it("prefers the captured best_odds", () => {
    expect(bookQuote(row({ best_odds: -110, dk_odds: 200 })))
      .toEqual({ odds: -110, source: PRICE_SOURCE.QUOTED });
  });

  it("recovers the best per-book price when best_odds is missing", () => {
    expect(bookQuote(row({ fd_odds: -120, dk_odds: 105, hr_odds: -130 })))
      .toEqual({ odds: 105, source: PRICE_SOURCE.RECOVERED });
  });

  it("never returns fair_line", () => {
    expect(bookQuote(row({ fair_line: 250 })))
      .toEqual({ odds: null, source: PRICE_SOURCE.NONE });
  });

  it("treats null, zero and non-numeric as no price", () => {
    for (const v of [null, undefined, 0, "", "abc", NaN]) {
      expect(noPrice(v), String(v)).toBe(true);
      expect(bookQuote(row({ best_odds: v })).odds).toBeNull();
    }
    // ...but a negative price is a real price
    expect(noPrice(-110)).toBe(false);
  });

  it("accepts numeric strings, which is how PostgREST hands back numerics", () => {
    expect(bookQuote(row({ best_odds: "-115" })).odds).toBe(-115);
    expect(bookQuote(row({ dk_odds: "140" })).odds).toBe(140);
  });
});

describe("settle — realized P/L", () => {
  it("pays the payout on a win and the stake on a loss", () => {
    expect(settle(row({ outcome: "win", best_odds: 150 }), 1).units).toBeCloseTo(1.5, 12);
    expect(settle(row({ outcome: "win", best_odds: -110 }), 1).units).toBeCloseTo(10 / 11, 12);
    expect(settle(row({ outcome: "loss", best_odds: 150 }), 2).units).toBe(-2);
  });

  it("scales with stake and puts the same stake in the denominator", () => {
    const s = settle(row({ outcome: "win", best_odds: -200 }), 3);
    expect(s.units).toBeCloseTo(1.5, 12);
    expect(s.staked).toBe(3);
  });

  it("returns nothing and stakes nothing on a push or an ungraded row", () => {
    for (const outcome of ["push", "pending", null, undefined]) {
      const s = settle(row({ outcome, best_odds: -110 }), 2);
      expect(s.units, String(outcome)).toBe(0);
      expect(s.staked, String(outcome)).toBe(0);
    }
  });

  it("pays and stakes nothing when no bookmaker priced the row", () => {
    // The whole point: this is not a -110 approximation of a capture gap, it is a wager
    // that could not have been placed. It scores in W/L elsewhere; it cannot pay.
    const s = settle(row({ outcome: "win", fair_line: 250 }), 1);
    expect(s).toEqual({ units: 0, staked: 0, source: PRICE_SOURCE.NONE });
    expect(isUnpricedRow(row({ fair_line: 250 }))).toBe(true);
    expect(settle(row({ outcome: "loss", fair_line: -250 }), 1).units).toBe(0);
  });

  it("labels the provenance of every settlement", () => {
    expect(settle(row({ best_odds: -110 }), 1).source).toBe(PRICE_SOURCE.QUOTED);
    expect(settle(row({ dk_odds: -110 }), 1).source).toBe(PRICE_SOURCE.RECOVERED);
    expect(settle(row({}), 1).source).toBe(PRICE_SOURCE.NONE);
  });
});

describe("settleAssumed — an explicitly hypothetical scenario", () => {
  it("prices an unpriced row at the assumed number and says so", () => {
    const s = settleAssumed(row({ outcome: "win" }), 1, -110);
    expect(s.units).toBeCloseTo(10 / 11, 12);
    expect(s.source).toBe(PRICE_SOURCE.ASSUMED);
  });

  it("still settles a quoted row at its real quote", () => {
    const s = settleAssumed(row({ outcome: "win", best_odds: 200 }), 1, -110);
    expect(s.units).toBeCloseTo(2, 12);
    expect(s.source).toBe(PRICE_SOURCE.QUOTED);
  });

  it("cannot be mistaken for realized P/L", () => {
    // The guard against the thing that went wrong: an ASSUMED row must never be summed
    // into a realized total. Callers filter on source, so the label has to differ.
    const hypothetical = settleAssumed(row({ outcome: "win" }), 1, -110);
    const realized = settle(row({ outcome: "win" }), 1);
    expect(hypothetical.source).not.toBe(realized.source);
    expect(realized.units).toBe(0);
  });
});

describe("profitPerUnit", () => {
  it("converts American odds to a payout multiple", () => {
    expect(profitPerUnit(100)).toBeCloseTo(1, 12);
    expect(profitPerUnit(-110)).toBeCloseTo(10 / 11, 12);
    expect(profitPerUnit(250)).toBeCloseTo(2.5, 12);
    expect(profitPerUnit(-250)).toBeCloseTo(0.4, 12);
  });
});
