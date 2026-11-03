/**
 * Golden-value tests for the Golden 10 scoring math (src/lib/golden.js).
 * This math is shared by the browser board and the server-side snapshot writer
 * (golden-snapshot.mjs); a drift here silently re-ranks "Yesterday's Golden 10".
 *
 * Run: npx vitest run
 */
import { describe, it, expect } from "vitest";
import { goldenScore, goldenNormFromMarket, GOLDEN_W_CONF, GOLDEN_W_PROB } from "./golden.js";

describe("goldenScore — 0.6 conf / 0.4 prob blend", () => {
  it("weights are a convex blend", () => {
    expect(GOLDEN_W_CONF + GOLDEN_W_PROB).toBeCloseTo(1.0, 10);
  });
  it("corners and midpoint", () => {
    expect(goldenScore(1, 1)).toBeCloseTo(1.0, 10);
    expect(goldenScore(1, 0)).toBeCloseTo(0.6, 10);
    expect(goldenScore(0, 1)).toBeCloseTo(0.4, 10);
    expect(goldenScore(0.5, 0.5)).toBeCloseTo(0.5, 10);
  });
});

describe("goldenNormFromMarket — cross-market normalization to 0..1", () => {
  it("batter markets: conf/10, prob clamped", () => {
    for (const m of ["hits", "hr", "hrr", "tb", "sb", "rbi", "ks"]) {
      expect(goldenNormFromMarket(m, { conf: 10, impliedProb: 0.6 })).toEqual({ confNorm: 1, probNorm: 0.6 });
      // conf above 10 clamps to 1; prob above 1 clamps to 1
      expect(goldenNormFromMarket(m, { conf: 15, impliedProb: 1.4 })).toEqual({ confNorm: 1, probNorm: 1 });
    }
  });
  it("batter markets: missing fields fall back to 0 conf / 0.5 prob", () => {
    expect(goldenNormFromMarket("hits", {})).toEqual({ confNorm: 0, probNorm: 0.5 });
  });
  it("ml: edge maps to PLAY tiers (4%→0.74, 8%→0.98)", () => {
    expect(goldenNormFromMarket("ml", { edge: 0.04, winPct: 0.55 })).toEqual({ confNorm: 0.74, probNorm: 0.55 });
    expect(goldenNormFromMarket("ml", { edge: 0.08, winPct: 0.6 }).confNorm).toBeCloseTo(0.98, 10);
    // confNorm clamps at 1
    expect(goldenNormFromMarket("ml", { edge: 0.20, winPct: 0.7 }).confNorm).toBe(1);
  });
  it("rl: marginEdge maps with a clamped prob heuristic", () => {
    const r = goldenNormFromMarket("rl", { marginEdge: 1.5 });
    expect(r.confNorm).toBeCloseTo(0.905, 10);
    expect(r.probNorm).toBeCloseTo(0.62, 10);
    // probNorm clamped to [0.5, 0.7]
    expect(goldenNormFromMarket("rl", { marginEdge: 100 }).probNorm).toBe(0.7);
  });
  it("ou: |edge| maps; sign is irrelevant", () => {
    const a = goldenNormFromMarket("ou", { ouEdge: 3 });
    const b = goldenNormFromMarket("ou", { ouEdge: -3 });
    expect(a).toEqual(b);
    expect(a.confNorm).toBeCloseTo(0.89, 10);
  });
  it("unknown market scores zero (cannot rank into the Golden 10)", () => {
    expect(goldenNormFromMarket("nope", {})).toEqual({ confNorm: 0, probNorm: 0 });
  });
});
