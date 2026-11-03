/**
 * Golden tests for the market-health controller (src/lib/marketHealth.js).
 *
 * These freeze the RULES of the closed feedback loop — the daily
 * edge-controller run derives real sizing decisions from them, so a silent
 * behavior change here changes what gets bet. If a test fails because you
 * INTENTIONALLY retuned a rule, update the golden in the same commit that
 * bumps CONTROLLER_VERSION.
 */
import { describe, it, expect } from "vitest";
import {
  deriveMarketControl,
  fitProbShift,
  applyProbShift,
  buildHealthLookup,
  CONTROL_RULES,
  STATUS_UNIT_MULT,
} from "./marketHealth.js";

describe("deriveMarketControl — rule table", () => {
  it("suspends on sustained negative CLV", () => {
    const c = deriveMarketControl({ nGraded: 100, unitsPl: 0, avgClvPp: -4.0, nClv: 40, predPct: 50, actualPct: 50 });
    expect(c.status).toBe("suspended");
    expect(c.unitMult).toBe(0);
    expect(c.reasons.join(" ")).toMatch(/CLV/);
  });

  it("throttles on mildly negative CLV", () => {
    const c = deriveMarketControl({ nGraded: 100, unitsPl: 0, avgClvPp: -2.0, nClv: 40, predPct: 50, actualPct: 50 });
    expect(c.status).toBe("throttled");
    expect(c.unitMult).toBe(0.5);
  });

  it("suspends on bleeding ROI even when CLV is positive (the Ks case)", () => {
    // ks 2026-06: CLV +1.3pp but -0.35u/pick and pred 60.8 vs actual 45.4
    const c = deriveMarketControl({ nGraded: 108, unitsPl: -37.6, avgClvPp: 1.3, nClv: 30, predPct: 60.8, actualPct: 45.4 });
    expect(c.status).toBe("suspended");
    expect(c.reasons.join(" ")).toMatch(/P\/L/);
  });

  it("winning trumps theory: positive realized units caps CLV suspension at throttle (the Hits case)", () => {
    // hits 2026-07: +17.6u over 323 picks but CLV -11.7pp — a market that is
    // MAKING money never gets zeroed on closing-line theory alone.
    const c = deriveMarketControl({ nGraded: 323, unitsPl: 17.6, avgClvPp: -11.7, nClv: 57, predPct: 75.6, actualPct: 70.9 });
    expect(c.status).toBe("throttled");
    expect(c.unitMult).toBe(0.5);
    expect(c.reasons.join(" ")).toMatch(/winning market never zeroed/);
  });

  it("the winning cap needs a real sample — thin winners still suspend on terrible CLV", () => {
    const c = deriveMarketControl({ nGraded: 30, unitsPl: 4, avgClvPp: -6.0, nClv: 30 });
    expect(c.status).toBe("suspended");
  });

  it("throttles on overconfidence alone", () => {
    const c = deriveMarketControl({ nGraded: 80, unitsPl: -4, avgClvPp: 0.5, nClv: 40, predPct: 60, actualPct: 50 });
    expect(c.status).toBe("throttled");
    expect(c.reasons.join(" ")).toMatch(/overconfident/);
  });

  it("underconfidence is NOT a hazard", () => {
    const c = deriveMarketControl({ nGraded: 80, unitsPl: 0, avgClvPp: 0.5, nClv: 40, predPct: 40, actualPct: 55 });
    expect(c.status).toBe("active");
    expect(c.unitMult).toBe(1);
  });

  it("holds prior status when every rule lacks sample", () => {
    const held = deriveMarketControl({ nGraded: 10, unitsPl: -9, avgClvPp: -8, nClv: 5 }, "suspended");
    expect(held.status).toBe("suspended");
    expect(held.reasons.join(" ")).toMatch(/insufficient sample/);
    const fresh = deriveMarketControl({ nGraded: 3, nClv: 0 });
    expect(fresh.status).toBe("active");
  });

  it("degrades immediately, recovers one step per evaluation (damped)", () => {
    // active + terrible CLV → straight to suspended
    expect(deriveMarketControl({ nGraded: 100, unitsPl: 0, avgClvPp: -5, nClv: 40 }, "active").status).toBe("suspended");
    // suspended + rules now clear → only steps to throttled
    const step1 = deriveMarketControl({ nGraded: 100, unitsPl: 5, avgClvPp: 0.5, nClv: 40, predPct: 50, actualPct: 50 }, "suspended");
    expect(step1.status).toBe("throttled");
    expect(step1.reasons.join(" ")).toMatch(/recovering/);
    // next clean evaluation → active
    const step2 = deriveMarketControl({ nGraded: 100, unitsPl: 5, avgClvPp: 0.5, nClv: 40, predPct: 50, actualPct: 50 }, "throttled");
    expect(step2.status).toBe("active");
  });

  it("unit multipliers match statuses", () => {
    expect(STATUS_UNIT_MULT).toEqual({ active: 1, throttled: 0.5, suspended: 0 });
  });
});

describe("fitProbShift / applyProbShift — rolling EV-lens correction", () => {
  const mk = (n, prob, winRate) =>
    Array.from({ length: n }, (_, i) => ({ modelProb: prob, won: i < Math.round(n * winRate) }));

  it("returns null below the minimum sample", () => {
    expect(fitProbShift(mk(CONTROL_RULES.PROB_SHIFT_MIN_N - 1, 0.5, 0.4))).toBeNull();
  });

  it("fits a negative shift for an overconfident market and corrects probs toward actual", () => {
    // predicted 51%, cashed 38% — the live TB gap (calibration monitor 2026-06-30)
    const shift = fitProbShift(mk(200, 0.511, 0.381));
    expect(shift).toBeLessThan(0);
    const corrected = applyProbShift(0.511, shift);
    expect(corrected).toBeCloseTo(0.381, 2);
  });

  it("clamps extreme shifts", () => {
    const shift = fitProbShift(mk(200, 0.9, 0.1));
    expect(Math.abs(shift)).toBeLessThanOrEqual(CONTROL_RULES.PROB_SHIFT_CLAMP);
  });

  it("applyProbShift is identity when shift is null", () => {
    expect(applyProbShift(0.42, null)).toBe(0.42);
    expect(applyProbShift(null, -0.3)).toBeNull();
  });
});

describe("buildHealthLookup — per-date unit multiplier for the weighted P/L track", () => {
  const rows = [
    { eval_date: "2026-07-02", market: "tb", status: "suspended", unit_mult: 0 },
    { eval_date: "2026-07-05", market: "tb", status: "throttled", unit_mult: 0.5 },
    { eval_date: "2026-07-02", market: "sb", status: "active", unit_mult: 1 },
  ];
  const lookup = buildHealthLookup(rows);

  it("latest() returns the newest row per market", () => {
    expect(lookup.latest("tb").status).toBe("throttled");
    expect(lookup.latest("nope")).toBeNull();
  });

  it("multFor() uses the control in force on the pick date; pre-controller dates get 1", () => {
    expect(lookup.multFor("tb", "2026-06-15")).toBe(1);   // before controller era
    expect(lookup.multFor("tb", "2026-07-03")).toBe(0);   // suspended window
    expect(lookup.multFor("tb", "2026-07-06")).toBe(0.5); // after recovery step
    expect(lookup.multFor("hits", "2026-07-06")).toBe(1); // market never evaluated
  });
});
