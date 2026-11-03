import { describe, it, expect } from "vitest";
import { isSettled, sortSlateRows } from "./FirstInning.jsx";

// The conviction sort partitioned on `row.result` being truthy, but
// firstInningResult returns {pending:true} for a game sitting in a scoreless
// 1st — an object, so truthy. Those rows were demoted into the graded group
// while still rendering as live picks, which put the slate's HIGHEST-conviction
// game (LAD@AZ, edge .0989, in the 1st) below its lowest (HOU@SD, edge .0296).
// Reproduced against the 2026-08-09 slate; the fixture is that slate's shape.

const row = (name, edge, result, time = 0) => ({ name, pred: { edge }, result, time });

const PENDING = { pending: true };
const CLINCHED = { yrfi: true, live: true };
const FINAL = { yrfi: true, runs: 2 };

describe("1st Inning conviction sort", () => {
  it("keeps a scoreless-1st game with the live picks, not the graded ones", () => {
    const rows = [
      row("HOU@SD", 0.0296, null),        // Preview
      row("LAD@AZ", 0.0989, PENDING),     // in the 1st, no run yet
      row("BAL@TEX", 0.0593, FINAL),      // graded
      row("DET@SF", 0.0394, PENDING),     // in the 1st, no run yet
    ];
    expect(sortSlateRows(rows, "edge").map((r) => r.name))
      .toEqual(["LAD@AZ", "DET@SF", "HOU@SD", "BAL@TEX"]);
  });

  it("ranks everything still in play by conviction, descending", () => {
    const rows = [row("lo", 0.01, null), row("hi", 0.09, null), row("mid", 0.05, PENDING)];
    expect(sortSlateRows(rows, "edge").map((r) => r.name)).toEqual(["hi", "mid", "lo"]);
  });

  it("sinks settled games below every unsettled one regardless of conviction", () => {
    const rows = [row("bigGraded", 0.20, FINAL), row("smallLive", 0.001, PENDING)];
    expect(sortSlateRows(rows, "edge").map((r) => r.name)).toEqual(["smallLive", "bigGraded"]);
  });

  it("treats a run already in as settled — the grade can no longer change", () => {
    const rows = [row("clinched", 0.09, CLINCHED), row("open", 0.01, PENDING)];
    expect(sortSlateRows(rows, "edge").map((r) => r.name)).toEqual(["open", "clinched"]);
  });

  it("orders by first pitch when sorting by time, ignoring settlement", () => {
    const rows = [row("late", 0.09, null, 300), row("early", 0.01, FINAL, 100)];
    expect(sortSlateRows(rows, "time").map((r) => r.name)).toEqual(["early", "late"]);
  });

  it("does not mutate the caller's array", () => {
    const rows = [row("a", 0.01, FINAL), row("b", 0.09, null)];
    sortSlateRows(rows, "edge");
    expect(rows.map((r) => r.name)).toEqual(["a", "b"]);
  });

  it("isSettled is the single definition the row rendering also uses", () => {
    expect(isSettled({ result: null })).toBe(false);
    expect(isSettled({ result: PENDING })).toBe(false);
    expect(isSettled({ result: CLINCHED })).toBe(true);
    expect(isSettled({ result: FINAL })).toBe(true);
  });
});
