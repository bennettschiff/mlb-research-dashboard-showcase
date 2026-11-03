// Golden-value tests for the Results math. Every number the Results surface
// shows routes through these functions, so a silent drift here misreports P/L
// on the page that decides whether a model change ships.
import { describe, it, expect } from "vitest";
import {
  pickProfitUnits, wilson, rollup, rollupBoth, FLAT,
  pickLabel, pickInWindow, windowBounds, shiftDays, daysBetween,
  dailySeries, equitySeries, byMarket, recentDots, hotCold,
  byTier, calibrationBuckets, byOddsBand, byPlayer, alarms, priorWindow,
  overhaulSplit, monthGrid, marketOrder, MIN_N_VERDICT,
  fmtUnits, fmtRecord, fmtMoney, ALARM_GROUPS,
  pickStakedUnits, pickIsUnpriced,
} from "./results.js";

// Minimal pick factory — only the columns the math reads.
const pick = (o = {}) => ({
  pick_date: "2026-08-01", player_name: "Test Player", prop_type: "hits",
  direction: "over", outcome: "win", best_odds: -110, model_prob: 0.6,
  model_score: 5, conf: 9.0, clv_pct: null, ...o,
});

describe("pickProfitUnits — payout in units", () => {
  it("pays the vig-adjusted amount on a −110 winner", () => {
    expect(pickProfitUnits(pick({ outcome: "win", best_odds: -110 }), 1)).toBeCloseTo(10 / 11, 10);
  });
  it("pays the plus-money amount on a +150 winner", () => {
    expect(pickProfitUnits(pick({ outcome: "win", best_odds: 150 }), 1)).toBeCloseTo(1.5, 10);
  });
  it("loses exactly the stake", () => {
    expect(pickProfitUnits(pick({ outcome: "loss", best_odds: 150 }), 2)).toBe(-2);
  });
  it("returns the stake on a push and on a pending pick", () => {
    expect(pickProfitUnits(pick({ outcome: "push" }), 1)).toBe(0);
    expect(pickProfitUnits(pick({ outcome: "pending" }), 1)).toBe(0);
  });
  it("scales linearly with stake", () => {
    expect(pickProfitUnits(pick({ best_odds: -200 }), 2)).toBeCloseTo(1.0, 10);
  });
  // 2026-09-08: fair_line NEVER settles. It is the model's own fair value, derived from
  // the same probability the pick was made on, so paying a winner at it books profit at a
  // number the model chose for itself — and the model is most generous exactly where it is
  // most confident. 1,279 of 7,061 graded picks (18.1%) carry fair_line and no quote and
  // were being paid at it.
  it("refuses to settle at fair_line", () => {
    expect(pickProfitUnits(pick({ best_odds: null, fair_line: 200, outcome: "win" }), 1)).toBe(0);
    expect(pickProfitUnits(pick({ best_odds: null, fair_line: 200, outcome: "loss" }), 1)).toBe(0);
  });

  it("recovers a real quote from the per-book columns before giving up", () => {
    // The sheets feed has always done this and Results never did — same row, two answers.
    expect(pickProfitUnits(pick({ best_odds: null, dk_odds: 150, outcome: "win" }), 1))
      .toBeCloseTo(1.5, 10);
    // best of the books present, not the first one found
    expect(pickProfitUnits(pick({ best_odds: null, fd_odds: -120, hr_odds: 105, outcome: "win" }), 1))
      .toBeCloseTo(1.05, 10);
    // a zero is not a price
    expect(pickProfitUnits(pick({ best_odds: 0, fd_odds: 0, outcome: "win" }), 1)).toBe(0);
  });

  // Regression: NRFI has no price on ANY row (The Odds API never posts it), so
  // the −110 fallback invents a price that was never obtainable. In August 2026
  // that booked +29.2u of unrealisable profit off 93 picks and made a −30u month
  // display as +9.2u. An unpriced market must pay and risk exactly nothing.
  it("pays zero on a structurally unpriced market, win or loss", () => {
    const nrfi = { prop_type: "nrfi", best_odds: null, fair_line: null };
    expect(pickProfitUnits(pick({ ...nrfi, outcome: "win" }), 1)).toBe(0);
    expect(pickProfitUnits(pick({ ...nrfi, outcome: "loss" }), 1)).toBe(0);
    expect(pickProfitUnits(pick({ ...nrfi, outcome: "win" }), 5)).toBe(0);
  });
  it("still pays a priced NRFI row normally if a price ever appears", () => {
    expect(pickProfitUnits(pick({ prop_type: "nrfi", outcome: "win", best_odds: -150 }), 1))
      .toBeCloseTo(2 / 3, 10);
  });
  // The old version of this test asserted the opposite — that a priced market with a
  // missing price still fell back to −110, because a null there was read as "a capture
  // gap" rather than "a row you could not have bet". Both are unbettable in the only
  // sense that matters to a P/L column: no price was ever obtained, so no money could
  // have been placed and none can be booked. The 08-27 NRFI reasoning was correct and
  // merely scoped too narrowly to the markets nobody quotes.
  it("pays zero on ANY market when no bookmaker price exists", () => {
    for (const mkt of ["hits", "hr", "tb", "ks", "nrfi"]) {
      const p = { prop_type: mkt, best_odds: null, fair_line: null };
      expect(pickProfitUnits(pick({ ...p, outcome: "win" }), 1), `${mkt} win`).toBe(0);
      expect(pickProfitUnits(pick({ ...p, outcome: "loss" }), 1), `${mkt} loss`).toBe(0);
    }
  });

  it("keeps an unpriced row out of the ROI denominator but still scores it", () => {
    const p = pick({ prop_type: "hits", outcome: "win", best_odds: null, fair_line: 200 });
    expect(pickStakedUnits(p, 3)).toBe(0);
    expect(pickIsUnpriced(p)).toBe(true);
    // and a quoted row stakes normally
    const q = pick({ prop_type: "hits", outcome: "win", best_odds: -110 });
    expect(pickStakedUnits(q, 3)).toBe(3);
    expect(pickIsUnpriced(q)).toBe(false);
  });
});

describe("rollup — unpriced picks score but do not stake", () => {
  const nrfiPick = (outcome) => pick({ prop_type: "nrfi", best_odds: null, fair_line: null, outcome });
  it("counts an unpriced pick in w/l but not in units, staked or ROI", () => {
    const r = rollup([nrfiPick("win"), nrfiPick("win"), nrfiPick("loss")], FLAT);
    expect(r.w).toBe(2);
    expect(r.l).toBe(1);
    expect(r.winPct).toBeCloseTo(200 / 3, 10);
    expect(r.units).toBe(0);
    expect(r.staked).toBe(0);
    expect(r.roiPct).toBeNull();   // nothing was ever at risk
    expect(r.unpricedN).toBe(3);
  });
  it("reports ROI on only the bettable remainder of a mixed set", () => {
    const r = rollup([
      nrfiPick("win"), nrfiPick("win"),
      pick({ prop_type: "hits", outcome: "win", best_odds: 100 }),
      pick({ prop_type: "hits", outcome: "loss", best_odds: 100 }),
    ], FLAT);
    expect(r.w).toBe(3);
    expect(r.l).toBe(1);
    expect(r.units).toBeCloseTo(0, 10);   // +1 and −1 on the two priced rows
    expect(r.staked).toBe(2);             // only the two hits rows risked anything
    expect(r.unpricedN).toBe(2);
  });
});

describe("wilson — interval on a rate", () => {
  it("matches the published interval for 5/10", () => {
    const { lo, hi, p } = wilson(5, 10);
    expect(p).toBe(0.5);
    expect(lo).toBeCloseTo(0.2366, 4);
    expect(hi).toBeCloseTo(0.7634, 4);
  });
  it("is wide on a tiny sample — the whole reason it exists", () => {
    // The "17%" a 6-pick market prints is consistent with anything from 3% to 56%.
    const { lo, hi } = wilson(1, 6);
    expect(lo).toBeCloseTo(0.03005, 5);
    expect(hi).toBeCloseTo(0.56351, 5);
  });
  it("tightens as n grows at a fixed rate", () => {
    const small = wilson(30, 60), big = wilson(300, 600);
    expect(big.hi - big.lo).toBeLessThan(small.hi - small.lo);
  });
  it("returns nulls on an empty sample", () => {
    expect(wilson(0, 0)).toEqual({ lo: null, hi: null, p: null });
  });
});

describe("rollup", () => {
  const set = [
    pick({ outcome: "win",  best_odds: -110 }),
    pick({ outcome: "win",  best_odds: -110 }),
    pick({ outcome: "loss", best_odds: -110 }),
    pick({ outcome: "push", best_odds: -110 }),
    pick({ outcome: "pending" }),
  ];
  it("counts outcomes and excludes pending entirely", () => {
    const r = rollup(set, FLAT);
    expect(r.w).toBe(2); expect(r.l).toBe(1); expect(r.pu).toBe(1);
    expect(r.n).toBe(4); expect(r.decided).toBe(3);
  });
  it("computes units, staked and ROI off decided picks only", () => {
    const r = rollup(set, FLAT);
    expect(r.units).toBeCloseTo(0.818181, 5); // 2×0.90909 − 1
    expect(r.staked).toBe(3);                  // push stakes nothing
    expect(r.roiPct).toBeCloseTo(27.2727, 3);
  });
  it("respects a weighted stake function", () => {
    const r = rollup(set, () => 2);
    expect(r.staked).toBe(6);
    expect(r.units).toBeCloseTo(1.636363, 5);
    expect(r.roiPct).toBeCloseTo(27.2727, 3); // ROI is stake-invariant at constant stake
  });
  // Regression: Number(null) === 0, so filtering on Number.isFinite alone counts
  // an unpriced pick as 0pp CLV instead of excluding it.
  it("averages CLV over priced picks only, treating null as absent not zero", () => {
    const r = rollup([pick({ clv_pct: 0.02 }), pick({ clv_pct: -0.01 }), pick({ clv_pct: null })], FLAT);
    expect(r.avgCLV).toBeCloseTo(0.005, 10);
    expect(r.clvN).toBe(2);
  });
  it("flags a thin sample below the verdict threshold", () => {
    expect(rollup([pick()], FLAT).thin).toBe(true);
    expect(rollup(Array.from({ length: MIN_N_VERDICT }, () => pick()), FLAT).thin).toBe(false);
  });
  it("returns null rates rather than NaN on an empty set", () => {
    const r = rollup([], FLAT);
    expect(r.winPct).toBeNull(); expect(r.roiPct).toBeNull(); expect(r.units).toBe(0);
  });
  it("rollupBoth carries flat and weighted side by side", () => {
    const b = rollupBoth(set, () => 2);
    expect(b.flat.staked).toBe(3);
    expect(b.weighted.staked).toBe(6);
  });
});

describe("pickLabel — direction-aware market keys", () => {
  it("splits Ks over from Ks under", () => {
    expect(pickLabel(pick({ prop_type: "ks", direction: "over" }))).toBe("Strikeouts");
    expect(pickLabel(pick({ prop_type: "ks", direction: "under" }))).toBe("Ks UNDER");
  });
  it("splits NRFI from YRFI", () => {
    expect(pickLabel(pick({ prop_type: "nrfi", direction: "under" }))).toBe("NRFI");
    expect(pickLabel(pick({ prop_type: "nrfi", direction: "over" }))).toBe("YRFI");
  });
  it("splits the two sides of a game total", () => {
    expect(pickLabel(pick({ prop_type: "ou", direction: "over" }))).toBe("Line - Over");
    expect(pickLabel(pick({ prop_type: "ou", direction: "under" }))).toBe("Line - Under");
  });
  it("passes an unknown prop_type through unchanged", () => {
    expect(pickLabel(pick({ prop_type: "wildcard" }))).toBe("wildcard");
  });
});

describe("date windows", () => {
  it("shifts across a month boundary in UTC", () => {
    expect(shiftDays("2026-08-01", -1)).toBe("2026-07-31");
    expect(shiftDays("2026-02-28", 1)).toBe("2026-03-01"); // 2026 is not a leap year
    expect(daysBetween("2026-07-31", "2026-08-10")).toBe(10);
  });
  it("makes a 7d window inclusive of today — 7 calendar days, not 8", () => {
    const { from } = windowBounds("7d", "2026-08-10");
    expect(from).toBe("2026-08-04");
    expect(daysBetween(from, "2026-08-10")).toBe(6);
  });
  it("bounds 30d, revamp and all-time", () => {
    expect(windowBounds("30d", "2026-08-10").from).toBe("2026-07-12");
    expect(windowBounds("v2", "2026-08-10").from).toBe("2026-05-20");
    expect(windowBounds("all", "2026-08-10")).toEqual({ from: null, to: null });
  });
  it("honors a custom range on both ends", () => {
    const c = { from: "2026-07-01", to: "2026-07-05" };
    expect(pickInWindow(pick({ pick_date: "2026-07-03" }), "custom", "2026-08-10", c)).toBe(true);
    expect(pickInWindow(pick({ pick_date: "2026-07-06" }), "custom", "2026-08-10", c)).toBe(false);
    expect(pickInWindow(pick({ pick_date: "2026-06-30" }), "custom", "2026-08-10", c)).toBe(false);
  });
  it("treats a single custom day as that day only", () => {
    const c = { from: "2026-07-04", to: null };
    expect(pickInWindow(pick({ pick_date: "2026-07-04" }), "custom", "2026-08-10", c)).toBe(true);
    expect(pickInWindow(pick({ pick_date: "2026-07-05" }), "custom", "2026-08-10", c)).toBe(false);
  });
});

describe("priorWindow", () => {
  const ps = [
    pick({ pick_date: "2026-08-08" }), // inside the 7d window (08-04 → 08-10)
    pick({ pick_date: "2026-08-03" }), // inside the preceding 7d (07-28 → 08-03)
    pick({ pick_date: "2026-07-27" }), // one day older than the preceding window
  ];
  it("returns the equal-length window immediately before the selected one", () => {
    const prior = priorWindow(ps, "7d", "2026-08-10");
    expect(prior.map(p => p.pick_date)).toEqual(["2026-08-03"]);
  });
  it("has no comparison for open-ended windows", () => {
    expect(priorWindow(ps, "all", "2026-08-10")).toBeNull();
    expect(priorWindow(ps, "v2", "2026-08-10")).not.toBeNull(); // v2 is bounded at its start
  });
  it("mirrors the length of a custom range", () => {
    const prior = priorWindow(ps, "custom", "2026-08-10", { from: "2026-08-04", to: "2026-08-10" });
    expect(prior.map(p => p.pick_date)).toEqual(["2026-08-03"]);
  });
});

describe("daily and equity series", () => {
  const ps = [
    pick({ pick_date: "2026-08-02", outcome: "loss" }),
    pick({ pick_date: "2026-08-01", outcome: "win" }),
    pick({ pick_date: "2026-08-01", outcome: "win" }),
  ];
  it("groups by date oldest → newest", () => {
    const d = dailySeries(ps, FLAT);
    expect(d.map(x => x.date)).toEqual(["2026-08-01", "2026-08-02"]);
    expect(d[0].flat.w).toBe(2);
    expect(d[1].flat.l).toBe(1);
  });
  it("accumulates units across days", () => {
    const e = equitySeries(dailySeries(ps, FLAT));
    expect(e[0].flat).toBeCloseTo(1.818181, 5);
    expect(e[1].flat).toBeCloseTo(0.818181, 5);
    expect(e[1].dayFlat).toBe(-1);
  });
});

describe("byMarket", () => {
  const ps = [
    pick({ prop_type: "ks", direction: "over", outcome: "win" }),
    pick({ prop_type: "ks", direction: "under", outcome: "loss" }),
    pick({ prop_type: "hits", outcome: "win" }),
  ];
  it("keeps the two sides of a market apart so one cannot hide inside the other", () => {
    const rows = byMarket(ps, FLAT);
    const ksOver = rows.find(r => r.market === "Strikeouts");
    const ksUnder = rows.find(r => r.market === "Ks UNDER");
    expect(ksOver.flat.w).toBe(1); expect(ksOver.flat.l).toBe(0);
    expect(ksUnder.flat.w).toBe(0); expect(ksUnder.flat.l).toBe(1);
  });
  it("sorts by display order", () => {
    expect(byMarket(ps, FLAT).map(r => r.market)).toEqual(["Hits", "Strikeouts", "Ks UNDER"]);
    expect(marketOrder("Hits")).toBeLessThan(marketOrder("NRFI"));
    expect(marketOrder("not a market")).toBe(Number.MAX_SAFE_INTEGER);
  });
  it("attaches the prior-window rollup when one is supplied", () => {
    const prior = [pick({ prop_type: "hits", outcome: "loss" })];
    const row = byMarket(ps, FLAT, prior).find(r => r.market === "Hits");
    expect(row.prior.l).toBe(1);
    expect(byMarket(ps, FLAT).find(r => r.market === "Hits").prior).toBeNull();
  });
});

describe("recentDots", () => {
  it("returns the last N settled outcomes oldest → newest, skipping pending", () => {
    const ps = [
      pick({ pick_date: "2026-08-01", outcome: "win" }),
      pick({ pick_date: "2026-08-02", outcome: "loss" }),
      pick({ pick_date: "2026-08-03", outcome: "pending" }),
      pick({ pick_date: "2026-08-04", outcome: "push" }),
    ];
    expect(recentDots(ps, 10)).toEqual(["win", "loss", "push"]);
    expect(recentDots(ps, 2)).toEqual(["loss", "push"]);
  });
});

describe("hotCold — recent P/L against each market's own baseline", () => {
  it("ranks a market that improved on itself above one that decayed", () => {
    const old = (mkt, outcome, n) => Array.from({ length: n }, () =>
      pick({ prop_type: mkt, pick_date: "2026-06-01", outcome }));
    const recent = (mkt, outcome, n) => Array.from({ length: n }, () =>
      pick({ prop_type: mkt, pick_date: "2026-08-08", outcome }));
    const ps = [
      ...old("hits", "loss", 20), ...recent("hits", "win", 10),  // improving
      ...old("tb", "win", 20),    ...recent("tb", "loss", 10),   // decaying
    ];
    const rows = hotCold(ps, "2026-08-10", { days: 14, minN: 8 });
    expect(rows[0].market).toBe("Hits");
    expect(rows[0].delta).toBeGreaterThan(0);
    expect(rows[rows.length - 1].market).toBe("Total Bases");
    expect(rows[rows.length - 1].delta).toBeLessThan(0);
  });
  it("drops markets under the minimum recent sample", () => {
    const ps = Array.from({ length: 3 }, () => pick({ pick_date: "2026-08-09" }));
    expect(hotCold(ps, "2026-08-10", { minN: 8 })).toHaveLength(0);
  });
});

describe("byTier", () => {
  it("buckets by current-calibration confidence and drops empty tiers", () => {
    const ps = [
      pick({ prop_type: "ks", outcome: "win" }),                 // pinned at 9.0
      pick({ prop_type: "ks", outcome: "loss" }),
    ];
    const tiers = byTier(ps, FLAT);
    expect(tiers).toHaveLength(1);
    expect(tiers[0].label).toBe("9.0–9.5");
    expect(tiers[0].flat.decided).toBe(2);
  });
});

describe("calibrationBuckets", () => {
  it("compares stated probability to realized rate", () => {
    const ps = [
      ...Array.from({ length: 6 }, () => pick({ model_prob: 0.72, outcome: "win" })),
      ...Array.from({ length: 4 }, () => pick({ model_prob: 0.72, outcome: "loss" })),
    ];
    const [b] = calibrationBuckets(ps);
    expect(b.lo).toBeCloseTo(0.7, 10);
    expect(b.predicted).toBeCloseTo(0.72, 10);
    expect(b.actual).toBeCloseTo(0.6, 10);
    expect(b.gap).toBeCloseTo(-0.12, 10); // overconfident by 12pp
  });
  it("ignores picks with no stored probability or no settlement", () => {
    expect(calibrationBuckets([pick({ model_prob: null }), pick({ outcome: "pending" })])).toHaveLength(0);
  });
});

describe("byOddsBand", () => {
  it("bands by price and drops empty bands", () => {
    const rows = byOddsBand([pick({ best_odds: -300 }), pick({ best_odds: 400 })], FLAT);
    expect(rows.map(r => r.key)).toEqual(["heavy", "long"]);
  });
  it("puts a −110 pick in the short band, not the pick-em band", () => {
    expect(byOddsBand([pick({ best_odds: -110 })], FLAT)[0].key).toBe("short");
  });
});

describe("byPlayer", () => {
  it("requires a minimum decided count and sorts by win rate", () => {
    const ps = [
      pick({ player_name: "A", outcome: "win" }), pick({ player_name: "A", outcome: "win" }),
      pick({ player_name: "B", outcome: "loss" }), pick({ player_name: "B", outcome: "loss" }),
      pick({ player_name: "C", outcome: "win" }),
    ];
    const rows = byPlayer(ps, 2);
    expect(rows.map(r => r.name)).toEqual(["A", "B"]); // C has one pick
    expect(rows[0].winPct).toBe(100);
  });
});

describe("alarms", () => {
  const today = "2026-08-10";
  const many = (n, o) => Array.from({ length: n }, (_, i) =>
    pick({ pick_date: shiftDays(today, -(i % 20)), ...o }));

  it("flags a market that is losing money at a decisive sample", () => {
    const ps = many(30, { prop_type: "hr", outcome: "loss" });
    const a = alarms(ps, ps, today, FLAT, "30d");
    expect(a.some(x => x.key === "alarm:hr" || x.key === "losing:HR")).toBe(true);
  });

  it("does NOT indict a market that is merely thin", () => {
    const ps = many(5, { prop_type: "hr", outcome: "loss" });
    const a = alarms(ps, ps, today, FLAT, "30d");
    expect(a.some(x => x.key === "losing:HR")).toBe(false);
    expect(a.some(x => x.key === "thin")).toBe(true);
  });

  it("flags a market that stopped producing picks — the HRR-drought class", () => {
    // 15 picks 30→11 days ago, nothing since.
    const stalled = Array.from({ length: 15 }, (_, i) =>
      pick({ prop_type: "hrr", pick_date: shiftDays(today, -(11 + (i % 20))) }));
    const live = many(12, { prop_type: "hits" });
    const all = [...stalled, ...live];
    const a = alarms(all, all, today, FLAT, "30d");
    const s = a.find(x => x.key === "stalled:H+R+RBI");
    expect(s).toBeTruthy();
    expect(s.level).toBe("alarm");
  });

  it("does not call a market stalled while it is still producing", () => {
    const ps = many(20, { prop_type: "hits" });
    expect(alarms(ps, ps, today, FLAT, "30d").some(x => x.key.startsWith("stalled:"))).toBe(false);
  });

  it("flags negative CLV separately from P/L", () => {
    const ps = many(30, { prop_type: "tb", outcome: "win", best_odds: 200, clv_pct: -0.03 });
    const a = alarms(ps, ps, today, FLAT, "30d");
    expect(a.some(x => x.key === "clv:Total Bases")).toBe(true);
    expect(a.some(x => x.key === "losing:Total Bases")).toBe(false); // winning on P/L, still losing the close
  });

  it("sorts alarms above warnings above info", () => {
    const losing = many(30, { prop_type: "hr", outcome: "loss" });
    const thin = many(3, { prop_type: "sb", outcome: "loss" });
    const all = [...losing, ...thin];
    const levels = alarms(all, all, today, FLAT, "30d").map(x => x.level);
    expect(levels.indexOf("alarm")).toBeLessThan(levels.lastIndexOf("info"));
  });

  it("ranks same-level alarms by units lost, not market iteration order", () => {
    // HR bleeds ~30u over 30 losses; TB bleeds ~14u over 26 (12 wins at +100).
    // Sorting on level alone left this to whichever market byMarket emitted
    // first, so the worst bleeder was not reliably at the top of the rail.
    const hr = many(30, { prop_type: "hr", outcome: "loss" });
    const tb = [
      ...many(26, { prop_type: "tb", outcome: "loss" }),
      ...many(12, { prop_type: "tb", outcome: "win", best_odds: 100 }),
    ];
    const all = [...tb, ...hr];
    const losing = alarms(all, all, today, FLAT, "30d").filter(x => x.group === "losing");
    expect(losing.length).toBe(2);
    expect(losing[0].market).toBe("HR");
    expect(losing[0].weight).toBeGreaterThan(losing[1].weight);
  });

  it("tags every alarm with a group the rail knows how to render", () => {
    const losing = many(30, { prop_type: "hr", outcome: "loss" });
    const clv = many(30, { prop_type: "tb", outcome: "win", best_odds: 200, clv_pct: -0.03 });
    const thin = many(3, { prop_type: "sb", outcome: "loss" });
    const all = [...losing, ...clv, ...thin];
    const known = new Set(ALARM_GROUPS.map(g => g.key));
    const got = alarms(all, all, today, FLAT, "30d");
    expect(got.length).toBeGreaterThan(2);
    for (const a of got) expect(known.has(a.group)).toBe(true);
  });
});

describe("overhaulSplit", () => {
  it("splits the affected markets on the cutoff date", () => {
    const ps = [
      pick({ prop_type: "tb", pick_date: "2026-05-27", outcome: "loss" }),
      pick({ prop_type: "tb", pick_date: "2026-05-29", outcome: "win" }),
      pick({ prop_type: "hits", pick_date: "2026-05-29", outcome: "win" }), // wrong market
    ];
    const s = overhaulSplit(ps, ["tb"], "2026-05-28", FLAT);
    expect(s.before.flat.l).toBe(1);
    expect(s.after.flat.w).toBe(1);
    expect(s.after.flat.n).toBe(1);
  });
});

describe("monthGrid", () => {
  it("pads the first week to the weekday of the 1st", () => {
    const g = monthGrid(2026, 1); // 2026-01-01 is a Thursday
    expect(g[0]).toEqual([null, null, null, null, "2026-01-01", "2026-01-02", "2026-01-03"]);
    expect(g).toHaveLength(5);        // 4 lead + 31 days fills exactly 5 rows
    expect(g[4][6]).toBe("2026-01-31");
  });
  it("emits every day of the month exactly once", () => {
    const days = monthGrid(2026, 2).flat().filter(Boolean);
    expect(days).toHaveLength(28); // 2026 is not a leap year
    expect(new Set(days).size).toBe(28);
    expect(days[27]).toBe("2026-02-28");
  });
});

describe("formatters", () => {
  it("signs units with a true minus and one decimal", () => {
    expect(fmtUnits(2.34)).toBe("+2.3u");
    expect(fmtUnits(-2.35)).toBe("−2.4u");
    expect(fmtUnits(null)).toBe("—");
  });
  it("renders a record with pushes only when there are pushes", () => {
    expect(fmtRecord({ w: 3, l: 2, pu: 0, n: 5 })).toBe("3-2");
    expect(fmtRecord({ w: 3, l: 2, pu: 1, n: 6 })).toBe("3-2-1");
    expect(fmtRecord({ w: 0, l: 0, pu: 0, n: 0 })).toBe("—");
  });

  describe("fmtMoney", () => {
    it("converts units to dollars at the given rate", () => {
      expect(fmtMoney(14.2, 5)).toBe("+$71.00");
      expect(fmtMoney(-18.9, 1.23)).toBe("−$23.25");
      expect(fmtMoney(0, 25)).toBe("+$0.00");
    });

    it("drops cents past a thousand and groups thousands", () => {
      expect(fmtMoney(-52.4, 25)).toBe("−$1,310");
      expect(fmtMoney(999, 1)).toBe("+$999.00");
      expect(fmtMoney(1000, 1)).toBe("+$1,000");
    });

    it("falls back to 1u = $1 rather than rendering NaN on a bad rate", () => {
      // A JSX `perUnit` shorthand passes the boolean `true`. That silently
      // multiplied by 1 on the headline cards for as long as each panel
      // inlined its own conversion; the guard keeps the degraded case
      // readable now that every panel shares this one formatter.
      expect(fmtMoney(14.2, true)).toBe("+$14.20");
      expect(fmtMoney(14.2, undefined)).toBe("+$14.20");
      expect(fmtMoney(14.2, 0)).toBe("+$14.20");
    });

    it("returns a dash for a missing or non-finite unit count", () => {
      expect(fmtMoney(null, 5)).toBe("—");
      expect(fmtMoney(undefined, 5)).toBe("—");
      expect(fmtMoney(NaN, 5)).toBe("—");
    });
  });
});
