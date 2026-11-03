/**
 * MLB innings notation is base-3: the digit after the point counts OUTS.
 *
 * The failure this guards: `parseFloat("5.2")` is 5.2, not 5⅔, and it is wrong in the
 * same direction every time — it always UNDERSTATES innings. Innings is the denominator
 * of every rate the K model computes (K/9, K%, batters faced, IP per start), so
 * understating it inflates the rate. modelKs read StatsAPI innings strings with
 * parseFloat from the day it was written until 2026-09-08, while src/lib/nrfi.js a few
 * hundred lines away had the conversion right and unshared.
 */
import { describe, it, expect } from "vitest";
import { ipToDec, isInningsNotation } from "./innings.js";

describe("ipToDec — MLB innings notation", () => {
  it("reads the fractional digit as outs", () => {
    expect(ipToDec("5.0")).toBe(5);
    expect(ipToDec("5.1")).toBeCloseTo(5 + 1 / 3, 12);
    expect(ipToDec("5.2")).toBeCloseTo(5 + 2 / 3, 12);
  });

  it("handles whole innings in every spelling", () => {
    expect(ipToDec("5")).toBe(5);
    expect(ipToDec(5)).toBe(5);
    expect(ipToDec("0")).toBe(0);
    expect(ipToDec("0.1")).toBeCloseTo(1 / 3, 12);
  });

  it("returns 0 for missing or unparseable input", () => {
    for (const v of [null, undefined, "", "   ", "abc", {}, []]) expect(ipToDec(v)).toBe(0);
  });

  it("sums a season without drifting", () => {
    // The headline arithmetic: ten 5⅔ outings are 56⅔ innings. parseFloat makes them 52,
    // an 8.2% understatement that lands straight in the K/9 denominator.
    const ten = Array.from({ length: 10 }, () => "5.2");
    expect(ten.reduce((s, x) => s + ipToDec(x), 0)).toBeCloseTo(56 + 2 / 3, 10);
    expect(ten.reduce((s, x) => s + parseFloat(x), 0)).toBeCloseTo(52, 10);
  });

  it("puts five strikeouts in a 5.2 outing at the right K/9", () => {
    expect((5 / ipToDec("5.2")) * 9).toBeCloseTo(7.941, 3);
    expect((5 / parseFloat("5.2")) * 9).toBeCloseTo(8.654, 3);
  });

  it("does not re-read an already-decimal value as outs", () => {
    // The realistic failure once one helper is shared: a value that has been converted,
    // or a per-start average, passed through a second time. 5.67 must not become 5+67/3.
    expect(ipToDec(5.666666666666667)).toBeCloseTo(5.666666666666667, 12);
    expect(ipToDec("5.67")).toBeCloseTo(5.67, 12);
    expect(ipToDec("6.25")).toBeCloseTo(6.25, 12);
    // A single digit above 2 is not innings notation either.
    expect(ipToDec("5.5")).toBeCloseTo(5.5, 12);
  });

  it("is idempotent on its own output", () => {
    for (const v of ["0.1", "5.2", "7", "142.1"]) {
      expect(ipToDec(ipToDec(v))).toBeCloseTo(ipToDec(v), 12);
    }
  });

  it("recognises well-formed notation", () => {
    expect(isInningsNotation("5.2")).toBe(true);
    expect(isInningsNotation("142.1")).toBe(true);
    expect(isInningsNotation("7")).toBe(true);
    expect(isInningsNotation("5.3")).toBe(false); // no such thing as .3 innings
    expect(isInningsNotation("5.67")).toBe(false);
    expect(isInningsNotation(null)).toBe(false);
  });
});
