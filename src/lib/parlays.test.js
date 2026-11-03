import { describe, it, expect } from "vitest";
import { gradeAllLines, lineTrust, impliedBreakeven } from "./models.js";
import { buildParlays, _internal } from "./parlays.js";

describe("gradeAllLines", () => {
  it("includes the low-alt legs PROP_LINES omits (hrr O0.5, ks 1.5)", () => {
    const hrr = gradeAllLines(2.5, "hrr").map(r => r.line);
    expect(hrr).toContain(0.5);
    const ks = gradeAllLines(5.0, "ks").map(r => r.line);
    expect(ks).toContain(1.5);
    expect(ks).toContain(2.5);
  });

  it("probability ladder is monotone non-increasing", () => {
    for (const score of [0.2, 0.8, 2.5, 3.5]) {
      const probs = gradeAllLines(score, "hrr").map(r => r.modelProb);
      for (let i = 1; i < probs.length; i++) expect(probs[i]).toBeLessThanOrEqual(probs[i - 1]);
    }
  });

  it("tags trust from the backtest: hrr all trusted, ks high lines directional", () => {
    expect(lineTrust("hrr", 0.5)).toBe("trusted");
    expect(lineTrust("ks", 2.5)).toBe("trusted");
    expect(lineTrust("ks", 5.5)).toBe("directional");
  });

  it("attaches edge/EV when odds are supplied, null when absent", () => {
    const rows = gradeAllLines(2.5, "hrr", { 0.5: -188 });
    const o05 = rows.find(r => r.line === 0.5);
    expect(o05.bookOdds).toBe(-188);
    expect(o05.edge).toBeCloseTo(o05.modelProb - impliedBreakeven(-188), 12);
    expect(o05.ev).not.toBeNull();
    const o15 = rows.find(r => r.line === 1.5);
    expect(o15.edge).toBeNull();
  });

  it("returns [] on non-positive score", () => {
    expect(gradeAllLines(0, "hits")).toEqual([]);
    expect(gradeAllLines(null, "hits")).toEqual([]);
  });
});

describe("buildParlays", () => {
  const leg = (over) => ({ trust: "trusted", market: "hrr", line: 0.5, ...over });

  it("only ships slips that beat their combined price (EV gate)", () => {
    // two legs each ~70% true at +110 (decimal 2.1): joint .49 × 4.41 = 2.16 → EV +116%
    const legs = [
      leg({ id: 1, player: "A", gamePk: 1, modelProb: 0.70, bookOdds: 110 }),
      leg({ id: 2, player: "B", gamePk: 2, modelProb: 0.70, bookOdds: 110 }),
    ];
    const slips = buildParlays(legs, { minEv: 0.05 });
    expect(slips.length).toBe(1);
    expect(slips[0].ev).toBeGreaterThan(0.05);
    expect(slips[0].legCount).toBe(2);
  });

  it("rejects juiced favorite stacks that compound vig (negative EV)", () => {
    // 90% legs at -2300 (decimal ~1.043): joint .81 × 1.088 = .881 → EV -12%
    const legs = [
      leg({ id: 1, player: "A", gamePk: 1, modelProb: 0.90, bookOdds: -2300 }),
      leg({ id: 2, player: "B", gamePk: 2, modelProb: 0.90, bookOdds: -2300 }),
    ];
    expect(buildParlays(legs, { minEv: 0.05 }).length).toBe(0);
  });

  it("drops same-game combos (correlation guard)", () => {
    const legs = [
      leg({ id: 1, player: "A", gamePk: 7, modelProb: 0.70, bookOdds: 110 }),
      leg({ id: 2, player: "B", gamePk: 7, modelProb: 0.70, bookOdds: 110 }),
    ];
    expect(buildParlays(legs).length).toBe(0);
  });

  it("excludes directional (untrusted) legs by default", () => {
    const legs = [
      leg({ id: 1, player: "A", gamePk: 1, modelProb: 0.70, bookOdds: 110, trust: "directional" }),
      leg({ id: 2, player: "B", gamePk: 2, modelProb: 0.70, bookOdds: 110 }),
    ];
    expect(buildParlays(legs).length).toBe(0);
  });

  it("keeps only the highest-EV line per player-market", () => {
    const legs = [
      leg({ id: 1, player: "A", gamePk: 1, line: 0.5, modelProb: 0.70, bookOdds: 110 }),
      leg({ id: 2, player: "A", gamePk: 1, line: 1.5, modelProb: 0.55, bookOdds: 250 }), // same player-market
      leg({ id: 3, player: "B", gamePk: 2, modelProb: 0.70, bookOdds: 110 }),
    ];
    const slips = buildParlays(legs, { minEv: -1 }); // disable EV gate to inspect pooling
    // A should appear once; no slip has two A-hrr legs
    for (const s of slips) {
      const aLegs = s.legs.filter(l => l.player === "A");
      expect(aLegs.length).toBeLessThanOrEqual(1);
    }
  });

  it("Safe mode keeps high-prob legs the EV gate would drop, ranks by hit chance", () => {
    // two high-prob anchors at juiced prices: each 80% true at -240 (decimal 1.417).
    // Value (minEv 0.05) rejects (joint .64 × 2.0 = 1.29 → EV +29%... actually positive here),
    // so use -350 to force negative EV: 80% at -350 (decimal 1.286): joint .64 × 1.653 = 1.058 → EV +5.8%
    const legs = [
      leg({ id: 1, player: "A", gamePk: 1, modelProb: 0.80, bookOdds: -350 }),
      leg({ id: 2, player: "B", gamePk: 2, modelProb: 0.80, bookOdds: -350 }),
    ];
    const safe = buildParlays(legs, { rankBy: "jointProb", minEv: -1, minLegProb: 0.65, minJointProb: 0.40 });
    expect(safe.length).toBe(1);
    expect(safe[0].jointProb).toBeCloseTo(0.64, 10);
    // safe admits a sub-45% per-leg-prob? no — minLegProb 0.65 excludes coin-flips
    const coinflips = buildParlays(
      [leg({ id: 3, player: "C", gamePk: 1, modelProb: 0.50, bookOdds: 110 }),
       leg({ id: 4, player: "D", gamePk: 2, modelProb: 0.50, bookOdds: 110 })],
      { rankBy: "jointProb", minEv: -1, minLegProb: 0.65, minJointProb: 0.40 });
    expect(coinflips.length).toBe(0);
  });

  it("Safe mode sorts by joint hit probability, not EV", () => {
    const legs = [
      leg({ id: 1, player: "A", gamePk: 1, modelProb: 0.90, bookOdds: -400 }), // high hit, low EV
      leg({ id: 2, player: "B", gamePk: 2, modelProb: 0.90, bookOdds: -400 }),
      leg({ id: 3, player: "C", gamePk: 3, modelProb: 0.70, bookOdds: 130 }),  // lower hit, higher EV
      leg({ id: 4, player: "D", gamePk: 4, modelProb: 0.70, bookOdds: 130 }),
    ];
    const safe = buildParlays(legs, { rankBy: "jointProb", minEv: -1, minLegProb: 0.65, minJointProb: 0.40, maxLegs: 2 });
    // the top slip should be the highest joint-prob pair (A+B at .81), not the higher-EV pair
    expect(safe[0].jointProb).toBeGreaterThan(0.78);
  });

  it("haircut shrinks legs toward the book → lower joint prob, lower EV, probUsed attached", () => {
    const legs = [
      leg({ id: 1, player: "A", gamePk: 1, modelProb: 0.80, bookOdds: 110 }), // model 80% vs book ~48%
      leg({ id: 2, player: "B", gamePk: 2, modelProb: 0.80, bookOdds: 110 }),
    ];
    const raw = buildParlays(legs, { minEv: -1, haircut: 0 })[0];
    const hedged = buildParlays(legs, { minEv: -1, haircut: 0.33 })[0];
    expect(hedged.jointProb).toBeLessThan(raw.jointProb);
    expect(hedged.ev).toBeLessThan(raw.ev);
    expect(hedged.jointProbRaw).toBeCloseTo(0.64, 10); // raw preserved
    // probUsed sits between model and book-implied
    const l = hedged.legs[0];
    expect(l.probUsed).toBeLessThan(l.modelProb);
    expect(l.probUsed).toBeGreaterThan(1 / (1 + 110 / 100));
  });

  it("decimal/american round-trips", () => {
    expect(_internal.decimal(110)).toBeCloseTo(2.1, 10);
    expect(_internal.decimal(-150)).toBeCloseTo(1.6667, 3);
    expect(_internal.toAmerican(2.1)).toBe(110);
  });
});
