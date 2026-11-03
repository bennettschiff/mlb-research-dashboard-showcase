import { describe, it, expect } from "vitest";
import {
  toDecimal, goldenOdds, goldenProb, summarizePicks, finishTotals, totalsFromResults,
  addTotals, emptyTotals, rollupGoldenPicks, goldenBoardRows, byRankSlice,
  byGoldenMarket, byGoldenOddsBand, bestMoneySlice, worstMarket, decimalToAmerican,
  goldenEquity,
} from "./goldenResults.js";

const pick = (o) => ({ rank: 1, market: "hits", line: 0.5, modelProb: 0.7, bookOdds: -200, won: true, ...o });

// ── Play tier ────────────────────────────────────────────────────────────────
// The play counters have to be summable across days (a window is the sum of its
// day blobs), survive a round trip through the stored results blob, and read
// null — never the board-wide figure — when a board has no play line.
describe("play tier rollup", () => {
  const lk = (o) => pick({ board: "likely", ...o });

  it("counts only the play ranks into the play counters", () => {
    const r = summarizePicks([
      lk({ rank: 1, won: true, bookOdds: 100 }),
      lk({ rank: 2, won: false, bookOdds: 100 }),
      lk({ rank: 3, won: true, bookOdds: 100 }),
      lk({ rank: 4, won: false, bookOdds: 100 }),   // outside the line
      lk({ rank: 9, won: false, bookOdds: 100 }),   // outside the line
    ]);
    expect(r.wins).toBe(2);
    expect(r.losses).toBe(3);
    expect(r.units).toBeCloseTo(-1, 10);            // +1 +1 -1 -1 -1
    expect(r.playWins).toBe(2);
    expect(r.playLosses).toBe(1);
    expect(r.playPricedN).toBe(3);
    expect(r.playUnits).toBeCloseTo(1, 10);         // +1 -1 +1
  });

  it("prefers a stored play flag over re-deriving it from the rank", () => {
    // If the line is ever retuned, a historical day must keep the tier it was
    // actually run with rather than being rewritten by today's config.
    const r = summarizePicks([
      lk({ rank: 7, won: true, bookOdds: 100, play: true }),   // stored: was a play
      lk({ rank: 1, won: true, bookOdds: 100, play: false }),  // stored: was not
    ]);
    expect(r.playWins).toBe(1);
    expect(r.playUnits).toBeCloseTo(1, 10);
  });

  it("records no plays for a board with no play line", () => {
    const r = summarizePicks([
      pick({ board: "lines", rank: 1, won: true, bookOdds: 100 }),
      pick({ board: "value", rank: 2, won: true, bookOdds: 100 }),
    ]);
    expect(r.wins).toBe(2);
    expect(r.playWins).toBe(0);
    expect(r.playPricedN).toBe(0);
    expect(finishTotals(totalsFromResults(r)).playRoiPct).toBeNull();
    expect(finishTotals(totalsFromResults(r)).playGap).toBeNull();
  });

  it("sums play counters across days and derives the play record", () => {
    const d1 = summarizePicks([lk({ rank: 1, won: true, bookOdds: 100 }), lk({ rank: 5, won: false, bookOdds: 100 })]);
    const d2 = summarizePicks([lk({ rank: 2, won: true, bookOdds: 100 }), lk({ rank: 3, won: false, bookOdds: 100 })]);
    const t = addTotals(totalsFromResults(d1), totalsFromResults(d2));
    const f = finishTotals(t);
    expect(f.wins).toBe(2);
    expect(f.playDecided).toBe(3);
    expect(f.playWins).toBe(2);
    expect(f.playWinPct).toBeCloseTo(200 / 3, 10);
    expect(f.playBreakeven).toBeCloseTo(50, 10);    // all legs +100
    expect(f.playUnits).toBeCloseTo(1, 10);
    expect(f.playRoiPct).toBeCloseTo(100 / 3, 10);
  });

  // Blobs written before 2026-08-27 carry no play counters. They must abstain,
  // not read as a play tier that went 0-0 — same convention as pre-breakeven
  // rows abstaining from sumDec.
  it("abstains for legacy blobs with no play counters", () => {
    const legacy = { wins: 6, losses: 4, pushes: 0, pending: 0, pricedN: 10, units: 1.2, sumDec: 19, sumProb: 7, probN: 10 };
    const f = finishTotals(totalsFromResults(legacy));
    expect(f.wins).toBe(6);
    expect(f.playDecided).toBe(0);
    expect(f.playWinPct).toBeNull();
    expect(f.playRoiPct).toBeNull();
    expect(f.playGap).toBeNull();
  });
});

describe("odds primitives", () => {
  it("converts american to decimal", () => {
    expect(toDecimal(100)).toBeCloseTo(2, 10);
    expect(toDecimal(-200)).toBeCloseTo(1.5, 10);
    expect(toDecimal(150)).toBeCloseTo(2.5, 10);
  });
  it("round-trips back to american", () => {
    expect(decimalToAmerican(2)).toBe(100);
    expect(decimalToAmerican(1.5)).toBe(-200);
    expect(decimalToAmerican(1)).toBeNull();
  });
  it("reads bookOdds on live rows and bestOdds on legacy rows", () => {
    expect(goldenOdds({ bookOdds: -140 })).toBe(-140);
    expect(goldenOdds({ bestOdds: -140 })).toBe(-140);
    // bookOdds wins when both are present.
    expect(goldenOdds({ bookOdds: -140, bestOdds: 999 })).toBe(-140);
    expect(goldenOdds({ bookOdds: null })).toBeNull();
  });
  it("reads modelProb on live rows and impliedProb on legacy rows", () => {
    expect(goldenProb({ modelProb: 0.7 })).toBe(0.7);
    expect(goldenProb({ impliedProb: 0.61 })).toBe(0.61);
    expect(goldenProb({})).toBeNull();
  });
});

describe("summarizePicks", () => {
  it("computes the record, units and the sums breakeven needs", () => {
    const r = summarizePicks([
      pick({ won: true, bookOdds: -200 }),   // +0.50u, dec 1.5
      pick({ won: false, bookOdds: -200 }),  // -1.00u, dec 1.5
      pick({ won: true, bookOdds: 150 }),    // +1.50u, dec 2.5
    ]);
    expect(r.wins).toBe(2);
    expect(r.losses).toBe(1);
    expect(r.n).toBe(3);
    expect(r.winRate).toBeCloseTo(2 / 3, 10);
    expect(r.units).toBeCloseTo(1.0, 10);
    expect(r.pricedN).toBe(3);
    expect(r.sumDec).toBeCloseTo(5.5, 6);
    expect(r.roi).toBeCloseTo(1 / 3, 4);
  });

  it("counts an unpriced pick in the record but never in units", () => {
    const r = summarizePicks([
      pick({ market: "nrfi", bookOdds: null, won: true }),
      pick({ won: false, bookOdds: -110 }),
    ]);
    expect(r.wins).toBe(1);
    expect(r.losses).toBe(1);
    expect(r.pricedN).toBe(1);
    expect(r.units).toBeCloseTo(-1, 10);
    expect(r.sumDec).toBeCloseTo(toDecimal(-110), 6);
  });

  it("keeps a scratched pick out of the record entirely", () => {
    const r = summarizePicks([pick({ won: null }), pick({ won: true, bookOdds: 100 })]);
    expect(r.pending).toBe(1);
    expect(r.wins).toBe(1);
    expect(r.losses).toBe(0);
    expect(r.n).toBe(1);
  });

  it("treats a push as no action — third slot of the record, zero units", () => {
    const r = summarizePicks([
      pick({ push: true, won: null, bookOdds: -110 }),
      pick({ won: true, bookOdds: 100 }),
      pick({ won: false, bookOdds: 100 }),
    ]);
    expect(r.pushes).toBe(1);
    expect(r.wins).toBe(1);
    expect(r.losses).toBe(1);
    expect(r.n).toBe(3);
    expect(r.winRate).toBeCloseTo(0.5, 10);   // pushes out of the denominator
    expect(r.pricedN).toBe(2);
    expect(r.units).toBeCloseTo(0, 10);
  });
});

describe("finishTotals — breakeven is the headline", () => {
  it("prices the win rate a set of bets actually needs", () => {
    // Ten bets at -200 (decimal 1.5): breakeven is exactly 1/1.5 = 66.7%.
    const picks = Array.from({ length: 10 }, (_, i) => pick({ bookOdds: -200, won: i < 7 }));
    const r = rollupGoldenPicks(picks);
    expect(r.winPct).toBeCloseTo(70, 10);
    expect(r.breakeven).toBeCloseTo(200 / 3, 6);
    expect(r.gap).toBeCloseTo(70 - 200 / 3, 6);
    expect(r.units).toBeCloseTo(7 * 0.5 - 3, 10);
    expect(r.avgOdds).toBe(-200);
  });

  it("calls a 68% board at -237 a loser", () => {
    // The live 'likely' board's actual shape: a great win rate at a worse price.
    const picks = Array.from({ length: 100 }, (_, i) => pick({ bookOdds: -237, won: i < 68 }));
    const r = rollupGoldenPicks(picks);
    expect(r.winPct).toBeCloseTo(68, 10);
    expect(r.breakeven).toBeGreaterThan(70);
    expect(r.gap).toBeLessThan(0);
    expect(r.units).toBeLessThan(0);
  });

  it("weights breakeven by pick, not by day", () => {
    // One bet at +900 and nine at -200 must not average to "roughly +250".
    const picks = [pick({ bookOdds: 900, won: false }),
      ...Array.from({ length: 9 }, () => pick({ bookOdds: -200, won: true }))];
    const r = rollupGoldenPicks(picks);
    const expected = 10 / (toDecimal(900) + 9 * toDecimal(-200));
    expect(r.breakeven).toBeCloseTo(expected * 100, 6);
  });

  it("reports calibration error as model-minus-actual", () => {
    const picks = [pick({ modelProb: 0.8, won: true }), pick({ modelProb: 0.8, won: false })];
    const r = rollupGoldenPicks(picks);
    expect(r.modelPct).toBeCloseTo(80, 10);
    expect(r.winPct).toBeCloseTo(50, 10);
    expect(r.calibErr).toBeCloseTo(30, 10);
  });

  it("abstains rather than dividing by zero on an all-unpriced set", () => {
    const r = rollupGoldenPicks([pick({ bookOdds: null, won: true })]);
    expect(r.breakeven).toBeNull();
    expect(r.gap).toBeNull();
    expect(r.roiPct).toBeNull();
    expect(r.avgOdds).toBeNull();
    expect(r.winPct).toBeCloseTo(100, 10);
  });
});

describe("totals are additive across days", () => {
  it("summing two days equals grading both days at once", () => {
    const d1 = [pick({ won: true, bookOdds: -150 }), pick({ won: false, bookOdds: 200 })];
    const d2 = [pick({ won: true, bookOdds: 120 }), pick({ won: true, bookOdds: -110 })];
    const both = rollupGoldenPicks([...d1, ...d2]);
    const summed = finishTotals(
      addTotals(totalsFromResults(summarizePicks(d1)), totalsFromResults(summarizePicks(d2)))
    );
    expect(summed.wins).toBe(both.wins);
    expect(summed.losses).toBe(both.losses);
    expect(summed.units).toBeCloseTo(both.units, 6);
    expect(summed.breakeven).toBeCloseTo(both.breakeven, 6);
    expect(summed.winPct).toBeCloseTo(both.winPct, 6);
  });

  it("a pre-breakeven results row still contributes its record", () => {
    // Rows graded before sumDec existed must not poison the window's breakeven.
    const legacyShape = { n: 2, wins: 1, losses: 1, pending: 0, winRate: 0.5, pricedN: 2, units: -0.5, roi: -0.25 };
    const t = finishTotals(addTotals(emptyTotals(), totalsFromResults(legacyShape)));
    expect(t.wins).toBe(1);
    expect(t.units).toBeCloseTo(-0.5, 10);
    expect(t.breakeven).toBeNull();
    expect(t.gap).toBeNull();
  });
});

describe("goldenBoardRows", () => {
  const rows = [
    { pick_date: "2026-08-01", board: "likely", results: summarizePicks([pick({ won: true, bookOdds: -200 }), pick({ won: true, bookOdds: -200 })]) },
    { pick_date: "2026-08-02", board: "likely", results: summarizePicks([pick({ won: false, bookOdds: -200 })]) },
    { pick_date: "2026-08-02", board: "lines", results: summarizePicks([pick({ won: true, bookOdds: 250 })]) },
    { pick_date: "2026-08-03", board: "likely", results: summarizePicks([]) },  // written, nothing settled
  ];

  it("groups by board, in display order, with a per-day strip", () => {
    const out = goldenBoardRows(rows);
    expect(out.map(r => r.board)).toEqual(["likely", "lines"]);
    const likely = out[0];
    expect(likely.days.map(d => d.date)).toEqual(["2026-08-01", "2026-08-02"]);  // empty day dropped
    expect(likely.wins).toBe(2);
    expect(likely.losses).toBe(1);
    expect(likely.greenDays).toBe(1);
    expect(likely.redDays).toBe(1);
    expect(likely.label).toBe("10 Most Likely");
  });

  it("honours the window bounds", () => {
    const out = goldenBoardRows(rows, { from: "2026-08-02", to: "2026-08-02" });
    expect(out.find(r => r.board === "likely").days).toHaveLength(1);
    expect(out.find(r => r.board === "likely").wins).toBe(0);
  });

  it("marks the retired OG board closed", () => {
    const out = goldenBoardRows([
      { pick_date: "2026-08-01", board: "legacy", results: summarizePicks([pick({ won: true, bestOdds: -300 })]) },
    ]);
    expect(out[0].closed).toBe(true);
    expect(out[0].pricedN).toBe(1);   // graded off bestOdds, not bookOdds
  });

  it("builds a cumulative equity series over the day strip", () => {
    const [likely] = goldenBoardRows(rows);
    const eq = goldenEquity(likely.days);
    expect(eq).toHaveLength(2);
    expect(eq[1].flat).toBeCloseTo(likely.units, 6);
  });
});

describe("drill-down slices", () => {
  // A board that is profitable at the top and bleeding at the tail — the shape
  // the rank slice exists to expose.
  const picks = [
    ...Array.from({ length: 6 }, (_, i) => pick({ rank: (i % 3) + 1, won: true, bookOdds: -150, market: "hrr" })),
    ...Array.from({ length: 6 }, (_, i) => pick({ rank: 7 + (i % 4), won: false, bookOdds: -150, market: "ks" })),
  ];

  it("splits by rank slice and drops empty slices", () => {
    const s = byRankSlice(picks);
    expect(s.map(x => x.key)).toEqual(["top", "tail"]);
    expect(s[0].units).toBeGreaterThan(0);
    expect(s[1].units).toBeLessThan(0);
  });

  it("orders markets worst-first so the drag is on top", () => {
    const m = byGoldenMarket(picks);
    expect(m[0].key).toBe("ks");
    expect(m[0].units).toBeLessThan(0);
  });

  it("buckets by price band", () => {
    const b = byGoldenOddsBand([pick({ bookOdds: -300 }), pick({ bookOdds: 400 })]);
    expect(b.map(x => x.key)).toEqual(["heavy", "long"]);
  });

  it("names the market to cut, and what the board does without it", () => {
    const w = worstMarket(picks);
    expect(w.market).toBe("ks");
    expect(w.without.units).toBeGreaterThan(0);
  });

  it("refuses to recommend a rank cut off a thin sample", () => {
    expect(bestMoneySlice(picks)).toBeNull();
  });

  it("recommends the deepest cut still ahead of breakeven", () => {
    // Ranks 1-3 clear -150 (breakeven 60%); ranks 4-10 do not.
    const big = [
      ...Array.from({ length: 60 }, (_, i) => pick({ rank: (i % 3) + 1, bookOdds: -150, won: i % 10 < 8 })),
      ...Array.from({ length: 60 }, (_, i) => pick({ rank: 4 + (i % 7), bookOdds: -150, won: i % 10 < 3 })),
    ];
    const best = bestMoneySlice(big);
    expect(best.depth).toBe(3);
    expect(best.gap).toBeGreaterThan(0);
  });
});
