/**
 * Tests for projection name-matching + rate derivation (src/lib/projections.js).
 * The name matcher's REFUSE-rather-than-guess behavior is the load-bearing part:
 * a wrong match assigns one player's projection to another (the "Max Muncy (ATH)
 * vs (LAD)" hazard called out in findProjection).
 *
 * Run: npx vitest run
 */
import { describe, it, expect } from "vitest";
import {
  normalizeName, findProjection, getBatterProj,
  batterProjRates, pitcherProjRates, PROJ_BATTERS, PROJ_PITCHERS,
} from "./projections.js";

describe("normalizeName", () => {
  it("strips accents, punctuation, case, and collapses whitespace", () => {
    expect(normalizeName("Aarón  Júdge!")).toBe("aaron judge");
    expect(normalizeName("José Ramírez")).toBe("jose ramirez");
    expect(normalizeName(null)).toBe("");
  });
});

describe("findProjection — match and refusal logic", () => {
  it("matches on exact name + team", () => {
    const p = getBatterProj("Aaron Judge", "NYY");
    expect(p).toBeTruthy();
    expect(p.t).toBe("NYY");
  });
  it("matches a unique name with no team given", () => {
    expect(getBatterProj("Aaron Judge", null)?.t).toBe("NYY");
  });
  it("REFUSES when the name exists only under a different team (wrong player)", () => {
    // Judge is NYY-only in the table; asking for a BOS Judge must not return the NYY one.
    expect(getBatterProj("Aaron Judge", "BOS")).toBeNull();
  });
  it("returns null for an unknown name", () => {
    expect(getBatterProj("Nonexistent Player", "NYY")).toBeNull();
  });
});

describe("batterProjRates", () => {
  it("derives singles, total bases, and SLG from the counting line", () => {
    const judge = getBatterProj("Aaron Judge", "NYY");
    const r = batterProjRates(judge);
    const singles = judge.h - judge.d2 - judge.d3 - judge.hr;
    const tb = singles + judge.d2 * 2 + judge.d3 * 3 + judge.hr * 4;
    expect(r.singles).toBe(singles);
    expect(r.tb).toBe(tb);
    expect(r.slg).toBeCloseTo(tb / judge.ab, 10);
    expect(r.hr_rate).toBeCloseTo(judge.hr / judge.ab, 10);
  });
  it("returns null for a missing player", () => {
    expect(batterProjRates(null)).toBeNull();
  });
});

describe("pitcherProjRates", () => {
  it("derives K/9, BB/9, and batters faced from the projection line", () => {
    const p = PROJ_PITCHERS[0];
    const r = pitcherProjRates(p);
    expect(r.k9).toBeCloseTo(p.k / (p.ip / 9), 10);
    expect(r.bb9).toBeCloseTo(p.bb / (p.ip / 9), 10);
    expect(r.bf).toBeCloseTo(p.ip * 3 + p.h + p.bb, 10);
  });
  it("returns null for a missing pitcher", () => {
    expect(pitcherProjRates(null)).toBeNull();
  });
});

describe("projection data integrity", () => {
  it("every batter has the counting fields the rate math needs (no NaN rates)", () => {
    for (const p of PROJ_BATTERS) {
      for (const k of ["n", "t", "h", "ab", "d2", "d3", "hr"]) {
        expect(p[k], `${p.n} missing ${k}`).not.toBeUndefined();
      }
      expect(p.ab, `${p.n} has zero AB`).toBeGreaterThan(0);
    }
  });
});
