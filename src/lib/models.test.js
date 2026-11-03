// Tests for the public reference model. The production model is private and has
// its own golden suite; these pin the contracts the rest of the app relies on.
import { describe, it, expect } from "vitest";
import {
  oddsToImplied, probToAmericanOdds, normalCDF, poissonGTE, poissonSideProb,
  negbinSideProb, negbinFairMean, calcEVFromOdds, computeKellyUnits,
  modelImpliedProb, findBestLine, gradeAllLines, bayesRate, blend,
  modelHits, modelTB, modelPitcherK, modelPitcherKv2, battingOrderPAMult,
} from "./models.js";

describe("odds math", () => {
  it("round-trips American odds and probability", () => {
    expect(oddsToImplied(-110)).toBeCloseTo(0.5238, 4);
    expect(oddsToImplied(150)).toBeCloseTo(0.4, 6);
    expect(probToAmericanOdds(0.6)).toBe(-150);
    expect(probToAmericanOdds(0.4)).toBe(150);
    expect(oddsToImplied(0)).toBeNull();
  });

  it("prices EV and refuses to size an unvalidated model", () => {
    expect(calcEVFromOdds(0.55, -110)).toBeCloseTo(0.55 * (100 / 110) - 0.45, 6);
    expect(computeKellyUnits(0.6, 100)).toBe(0);
    expect(computeKellyUnits(0.6, 100, { validated: true })).toBeGreaterThan(0);
    expect(computeKellyUnits(0.4, -200, { validated: true })).toBe(0);
  });
});

describe("distributions", () => {
  it("normalCDF is symmetric", () => {
    expect(normalCDF(0)).toBeCloseTo(0.5, 6);
    expect(normalCDF(1.96)).toBeCloseTo(0.975, 3);
    expect(normalCDF(-1) + normalCDF(1)).toBeCloseTo(1, 6);
  });

  it("poisson tail and push split are consistent", () => {
    expect(poissonGTE(1, 1)).toBeCloseTo(1 - Math.exp(-1), 6);
    const { win, push } = poissonSideProb(2, 2, "over");
    const under = poissonSideProb(2, 2, "under").win;
    expect(win + push + under).toBeCloseTo(1, 6);
  });

  it("negbinFairMean makes the line a coin flip", () => {
    const mu = negbinFairMean(8.5);
    expect(negbinSideProb(mu, 8.5).conditional).toBeCloseTo(0.5, 3);
  });
});

describe("blending", () => {
  it("leans on the projection early and the season late", () => {
    expect(blend(0.300, 0.200, 0)).toBeCloseTo(0.300, 6);
    expect(blend(0.300, 0.200, 200)).toBeCloseTo(0.3 * 0.1 + 0.2 * 0.9, 6);
    expect(bayesRate(0, 0, 0.25, 100)).toBe(0.25);
  });

  it("gives leadoff hitters more plate appearances than the nine-hole", () => {
    expect(battingOrderPAMult(1)).toBeGreaterThan(battingOrderPAMult(9));
    expect(battingOrderPAMult(null)).toBe(1);
  });
});

describe("model contracts", () => {
  const season = { gamesPlayed: 100, atBats: 400, hits: 120, doubles: 25, triples: 2, homeRuns: 20, totalBases: 209, runs: 60, rbi: 65, stolenBases: 8 };
  const games = Array.from({ length: 10 }, () => ({ stat: { atBats: 4, hits: 1, totalBases: 2, homeRuns: 0, runs: 1, rbi: 1 } }));

  it("modelImpliedProb is monotone in score and in line", () => {
    expect(modelImpliedProb(0.30, "hits", 0.5)).toBeGreaterThan(modelImpliedProb(0.20, "hits", 0.5));
    expect(modelImpliedProb(2.0, "tb", 1.5)).toBeGreaterThan(modelImpliedProb(2.0, "tb", 2.5));
    expect(modelImpliedProb(6.5, "ks", 5.5)).toBeGreaterThan(0.5);
    expect(modelImpliedProb(0, "hits")).toBeNull();
  });

  it("returns the fields the boards render", () => {
    const h = modelHits({ seasonStats: season, recentGames: games, lineupOrder: 2 });
    expect(h.score).toBeGreaterThan(0.2);
    expect(h.impliedProb05).toBeGreaterThan(0.5);
    const tb = modelTB({ seasonStats: season, recentGames: games });
    expect(tb.score).toBeGreaterThan(1);
    expect([1.5, 2.5]).toContain(tb.bestLine);
  });

  it("findBestLine and gradeAllLines agree on probabilities", () => {
    const best = findBestLine(2.2, "tb");
    const row = gradeAllLines(2.2, "tb").find((r) => r.line === best.line);
    expect(row.modelProb).toBeCloseTo(best.impliedProb, 6);
  });

  it("gradeAllLines is non-increasing in line and attaches edge when priced", () => {
    const rows = gradeAllLines(6.2, "ks", { 5.5: -120 });
    for (let i = 1; i < rows.length; i++) expect(rows[i].modelProb).toBeLessThanOrEqual(rows[i - 1].modelProb);
    expect(rows.find((r) => r.line === 5.5).edge).not.toBeNull();
  });

  it("pitcher K models produce an expectation near the pitcher's rate", () => {
    const starts = Array.from({ length: 5 }, () => ({ stat: { strikeOuts: 7, inningsPitched: "6.0" } }));
    const k1 = modelPitcherK({ seasonStats: { gamesStarted: 20, strikeOuts: 140 }, recentStarts: starts, line: 6.5 });
    expect(k1.score).toBeCloseTo(7, 0);
    const k2 = modelPitcherKv2({ seasonStats: { battersFaced: 500, strikeOuts: 130 }, gameLog: starts });
    expect(k2.xK).toBeGreaterThan(5);
    expect(k2.xK).toBeLessThan(8);
  });
});
