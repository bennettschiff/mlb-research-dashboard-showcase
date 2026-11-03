/**
 * Golden-value tests for the game-line model primitives (src/lib/gameModel.js):
 * FIP, odds conversion, edge, best-line selection, run-line pick, park factors,
 * and directional sanity on the full slate model. These feed every ML/RL/OU
 * play gate (see gameLineGates in picks.js).
 *
 * Run: npx vitest run
 */
import { describe, it, expect } from "vitest";
import {
  PARK_RUNS, calcFIP, oddsToImplied, fmtOdds, calcEdge,
  bestMLOdds, bestSpreadOdds, runLinePick, slateOddsModel,
} from "./gameModel.js";

describe("calcFIP", () => {
  it("computes FIP = (13HR + 3(BB+HBP) - 2K)/IP + 3.10", () => {
    // (13*1 + 3*3 - 2*9)/9 + 3.10 = 4/9 + 3.10 = 3.54
    expect(calcFIP(9, 3, 1, 0, "9.0")).toBeCloseTo(3.54, 2);
  });
  it("parses 'X.Y' innings as X + Y/3 outs", () => {
    // 6.2 IP → 6 + 2/3 = 6.667; with 0 events → 3.10 constant exactly
    expect(calcFIP(0, 0, 0, 0, "6.2")).toBeCloseTo(3.1, 2);
  });
  it("returns null below the 5-IP minimum sample", () => {
    expect(calcFIP(5, 2, 1, 0, "4.0")).toBeNull();
  });
});

describe("oddsToImplied / fmtOdds / calcEdge", () => {
  it("implied prob from American odds", () => {
    expect(oddsToImplied(100)).toBeCloseTo(0.5, 10);
    expect(oddsToImplied(-110)).toBeCloseTo(0.5238, 4);
    expect(oddsToImplied(150)).toBeCloseTo(0.4, 10);
    expect(oddsToImplied(null)).toBeNull();
  });
  it("formats odds with explicit + on favorites", () => {
    expect(fmtOdds(150)).toBe("+150");
    expect(fmtOdds(-110)).toBe("-110");
    expect(fmtOdds(null)).toBe("—");
  });
  it("edge = model win% − implied", () => {
    expect(calcEdge(0.55, -110)).toBeCloseTo(0.0262, 4);
    expect(calcEdge(0.5, 100)).toBeCloseTo(0, 10);
  });
});

describe("best-line selection across books", () => {
  it("bestMLOdds picks the highest American price (best payout)", () => {
    const books = { fanduel: { homeML: -110 }, draftkings: { homeML: 105 }, hardrockbet: { homeML: -120 } };
    expect(bestMLOdds(books, "home")).toEqual({ odds: 105, book: "draftkings" });
    expect(bestMLOdds(null, "home")).toEqual({ odds: null, book: null });
  });
  it("bestSpreadOdds returns the point with the best price", () => {
    const books = {
      fanduel: { homeSpread: { point: -1.5, price: -110 } },
      draftkings: { homeSpread: { point: -1.5, price: 100 } },
    };
    expect(bestSpreadOdds(books, "home")).toEqual({ point: -1.5, odds: 100, book: "draftkings" });
  });
});

describe("runLinePick", () => {
  it("returns null when the modeled margin is within 0.75 runs", () => {
    expect(runLinePick(0.5, "NYY", "BOS")).toBeNull();
  });
  it("favors home and flags cover only when margin beats the spread", () => {
    expect(runLinePick(1.0, "NYY", "BOS")).toMatchObject({ side: "home", label: "NYY -1.5", covers: false });
    expect(runLinePick(2.0, "NYY", "BOS")).toMatchObject({ side: "home", covers: true });
  });
  it("favors away with the mirrored +1.5 line", () => {
    expect(runLinePick(-1.2, "NYY", "BOS")).toMatchObject({ side: "away", label: "BOS +1.5", covers: false });
    expect(runLinePick(-2.0, "NYY", "BOS")).toMatchObject({ side: "away", covers: true });
  });
});

describe("PARK_RUNS", () => {
  it("covers all 30 parks with finite factors", () => {
    expect(Object.keys(PARK_RUNS).length).toBe(30);
    expect(Object.values(PARK_RUNS).every(Number.isFinite)).toBe(true);
  });
  it("Coors Field (COL) is the most run-friendly park", () => {
    const max = Math.max(...Object.values(PARK_RUNS));
    expect(PARK_RUNS.COL).toBe(max);
    expect(PARK_RUNS.COL).toBeGreaterThan(1.1);
  });
});

describe("slateOddsModel — directional sanity", () => {
  const base = { homeFIP: 4.0, awayFIP: 4.0, homeOPS: 0.720, awayOPS: 0.720 };

  it("home-field edge gives the home team >50% with otherwise-equal inputs", () => {
    const m = slateOddsModel(base);
    expect(m.homeWinPct).toBeGreaterThan(0.5);
    expect(m.margin).toBeGreaterThan(0);
    expect(m.total).toBeGreaterThan(6);
    expect(m.total).toBeLessThan(13);
    expect(["high", "medium", "low"]).toContain(m.confidence);
  });

  it("a better home starter (lower FIP) raises home win probability", () => {
    const worse = slateOddsModel({ ...base, homeFIP: 5.0 });
    const better = slateOddsModel({ ...base, homeFIP: 2.5 });
    expect(better.homeWinPct).toBeGreaterThan(worse.homeWinPct);
  });

  it("a higher park factor raises the projected total", () => {
    const neutral = slateOddsModel({ ...base, parkRunsFactor: 1.0 });
    const coors = slateOddsModel({ ...base, parkRunsFactor: PARK_RUNS.COL });
    expect(coors.total).toBeGreaterThan(neutral.total);
  });
});
