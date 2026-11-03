/**
 * Golden / behavioral tests for the pick-selection GATES (src/lib/picks.js).
 *
 * These exist because every silent failure this project has shipped was a GATE
 * bug, not a math-primitive bug:
 *   - HRR 0-pick drought (a degenerate ceiling made conf un-reachable vs the dice gate)
 *   - lock-filter dropping player props before save
 *   - prob-space gates silently retuning under calibration changes
 * models.test.js freezes the math; this file freezes "does a pick actually fire?"
 *
 * PROJECT RULE under test: gates live in SCORE space. A pick fires on
 * conf >= pickThresh (conf is a pure function of model_score), never on a
 * probability threshold that drifts when modelImpliedProb is recalibrated.
 *
 * Run: npx vitest run
 */
import { describe, it, expect } from "vitest";
import {
  BOARD_CONFIGS,
  calcConfidence,
  isOfficialPick,
  isBoardActionable,
  isSbWatch,
  isOfficialKsPick,
  ksPickDirection,
  ksPickUnits,
  ksRoleUncertain,
  ksSignalVsLine,
  KS_ROLE_GAP,
  batterPickUnits,
  pickStakeUnits, MARKET_UNITS,
  gameLineGates,
  pickCurrentConf,
  pickMeetsCurrentThreshold,
} from "./picks.js";
import { activeOverrides } from "./gateOverrides.js";

// Markets that flow through BOARD_CONFIGS + calcConfidence + isOfficialPick.
// rbi is handled separately (it has the extra lineup/gameTotal gate).
const BATTER_MARKETS = ["hits", "hr", "tb", "sb", "hrr"];

/**
 * `want`, pulled inside whatever conf band `market` has promoted today (and
 * never below `floor`, the market's own threshold).
 *
 * Any test asserting a pick FIRES has to do this. A literal conf is a silent bet
 * that the market has no promoted cap above it, and caps are the most common
 * thing this system graduates — they were 8 of the first 14 validated proposals,
 * and hr/tb already carry one. When that bet loses, the suite goes red, the
 * lab-analyst guard reverts the graduation, and it repeats nightly until a human
 * reads the log (2026-09-06). scripts/gate-promotion-sweep.mjs finds these.
 */
function confClearingOverrides(market, want, floor = 0) {
  const o = activeOverrides().find((x) => x.market === market)?.params ?? {};
  let conf = want;
  if (o.conf_max != null) conf = Math.min(conf, o.conf_max);
  if (o.conf_min != null) conf = Math.max(conf, o.conf_min);
  expect(
    conf,
    `${market}'s promoted conf band leaves nothing at/above its own floor ${floor} ` +
      `— check src/lib/gateOverrides.json (${JSON.stringify(o)})`
  ).toBeGreaterThanOrEqual(floor);
  return conf;
}

/**
 * The conf floor actually in force for `market` today: its own pickThresh, raised
 * by any promoted conf_min.
 *
 * The companion to confClearingOverrides, for the other half of the band. A test
 * asserting a pick fires AT the floor, or is rejected just under it, has to ask
 * where the floor is rather than assume it is still pickThresh — a conf_min
 * graduation moves it UP and `isOfficialPick(pickThresh, m)` stops being true.
 * tb has carried a standing conf_min of 9.3, so this is not hypothetical: every
 * boundary assertion in this file was one conf_min graduation away from going red
 * and taking that graduation down with it.
 */
/**
 * `want` as a SCORE (for ks: xK), pulled inside whatever score band `market` has
 * promoted today. The score-space twin of confClearingOverrides: a test asserting a K
 * pick FIRES at a literal xK is a silent bet that ks has no score_min/score_max, and
 * scripts/gate-promotion-sweep.mjs (CI) fails exactly that bet.
 */
function scoreClearingOverrides(market, want) {
  const o = activeOverrides().find((x) => x.market === market)?.params ?? {};
  let s = want;
  if (o.score_max != null) s = Math.min(s, o.score_max);
  if (o.score_min != null) s = Math.max(s, o.score_min);
  return s;
}

function confFloor(market) {
  const base = BOARD_CONFIGS[market]?.pickThresh ?? KS_CONF_FLOOR; // ks runs its own scale
  const o = activeOverrides().find((x) => x.market === market)?.params ?? {};
  return o.conf_min != null ? Math.max(base, o.conf_min) : base;
}

describe("calcConfidence — score-space conviction scale", () => {
  it("returns 4.0 at the display threshold and 9.5 at the ceiling (no pick bonuses)", () => {
    for (const m of [...BATTER_MARKETS, "rbi"]) {
      const { thresh, ceiling } = BOARD_CONFIGS[m];
      // pass pick=undefined so park/form bonuses never fire — pure score scale
      expect(calcConfidence(thresh, m)).toBeCloseTo(4.0, 5);
      expect(calcConfidence(ceiling, m)).toBeCloseTo(9.5, 5);
    }
  });

  // computeSwingTakeHitsMult multiplied hits adjScore by a flat 0.96 on 98.5% of rows
  // until 2026-07-29. thresh/ceiling are compared against adjScore, so removing it
  // required scaling BOTH by 1/0.96 to keep the gate where it was. This asserts that
  // scaling was applied and stays applied: an adjScore that used to be s is now s/0.96,
  // and must yield the SAME confidence. If someone rounds thresh back to 0.260 without
  // touching ceiling (or vice versa), every hits pick silently re-rates.
  it("hits gate is level-preserving across the swing-take removal", () => {
    const OLD_THRESH = 0.260, OLD_CEILING = 0.380, FLOOR = 0.96;
    // calcConfidence rounds to 1dp (parseFloat(conf.toFixed(1))), so the reference has
    // to round identically or this compares a rounded value against an exact one.
    const oldConf = (s) => parseFloat((4.0 + Math.min(Math.max(0, s - OLD_THRESH) / (OLD_CEILING - OLD_THRESH), 1.0) * 5.5).toFixed(1));
    for (const s of [0.26, 0.28, 0.30, 0.32, 0.36, 0.38]) {
      expect(calcConfidence(s / FLOOR, "hits")).toBe(oldConf(s));
    }
    // and the bounds themselves are exactly the old ones rescaled
    expect(BOARD_CONFIGS.hits.thresh).toBeCloseTo(OLD_THRESH / FLOOR, 12);
    expect(BOARD_CONFIGS.hits.ceiling).toBeCloseTo(OLD_CEILING / FLOOR, 12);
  });

  it("is monotonic in score and clamped to [1,10]", () => {
    const { thresh, ceiling } = BOARD_CONFIGS.hits;
    const mid = calcConfidence((thresh + ceiling) / 2, "hits");
    expect(mid).toBeGreaterThan(calcConfidence(thresh, "hits"));
    expect(mid).toBeLessThan(calcConfidence(ceiling, "hits"));
    // way past ceiling clamps at 10, never above
    expect(calcConfidence(ceiling * 5, "hits")).toBeLessThanOrEqual(10.0);
    // far below threshold clamps at 1, never below
    expect(calcConfidence(-100, "hits")).toBeGreaterThanOrEqual(1.0);
  });

  it("unknown board returns the neutral 5.0", () => {
    expect(calcConfidence(1.0, "nope")).toBe(5.0);
  });
});

describe("isOfficialPick — fires iff conf >= pickThresh", () => {
  for (const m of BATTER_MARKETS) {
    it(`${m}: a pick AT the conf floor is official, just under is not`, () => {
      // The floor is pickThresh raised by any promoted conf_min, not pickThresh
      // itself — see confFloor. The invariant is "the gate has a floor and is
      // exclusive below it", which survives a graduation; "the floor is exactly
      // pickThresh" does not.
      const floor = confFloor(m);
      expect(isOfficialPick(floor, m)).toBe(true);
      // "comfortably above the floor" probe — clamped under any live conf_max
      // override so this stays a floor test, not an accidental re-test of
      // a promoted cap (which has its own coverage below).
      const cap = activeOverrides().find((o) => o.market === m)?.params?.conf_max;
      const above = cap != null ? Math.min(floor + 0.5, (floor + cap) / 2) : floor + 0.5;
      expect(isOfficialPick(above, m)).toBe(true);
      expect(isOfficialPick(floor - 0.1, m)).toBe(false);
    });
  }

  it("tb: refuses a 🎲 on a book line the model cannot price", () => {
    // The saved line is the BOOK's line. Only O1.5 and O2.5 have a fitted TB curve; the
    // other rungs used to borrow the nearest one and went 6-40 (O4.5 2-21 at a claimed
    // 33.5%, which is the O2.5 curve pinned at its score cap). A pick carrying no
    // probability must not carry a dice icon either.
    const conf = confFloor("tb"); // pickThresh, raised by any promoted tb conf_min
    expect(isOfficialPick(conf, "tb", { bookLine: 1.5 })).toBe(true);
    expect(isOfficialPick(conf, "tb", { bookLine: 2.5 })).toBe(true);
    for (const line of [0.5, 3.5, 4.5]) {
      expect(isOfficialPick(conf, "tb", { bookLine: line }), `O${line}`).toBe(false);
    }
    // No book line posted → the model falls back to its own best line, which is now
    // always fitted, so this must stay official.
    expect(isOfficialPick(conf, "tb", {})).toBe(true);
    expect(isOfficialPick(conf, "tb", { bookLine: null })).toBe(true);
  });

  it("a ceiling-score pick clears the dice gate for every batter market (HRR-drought regression)", () => {
    // The HRR drought was: max reachable conf < pickThresh, so ZERO picks for 10 days.
    // Guard: the top of each market's conf scale must clear its own pickThresh —
    // this is the actual invariant that drought broke, and it is untouched by
    // promoted overrides (which run downstream of pickThresh in isOfficialPick).
    for (const m of BATTER_MARKETS) {
      const conf = calcConfidence(BOARD_CONFIGS[m].ceiling, m);
      expect(conf).toBeGreaterThanOrEqual(BOARD_CONFIGS[m].pickThresh);
    }

    // isOfficialPick itself should also fire at the ceiling — UNLESS a promoted
    // lab gate (src/lib/gateOverrides.json) deliberately caps that market's top
    // tail. Those caps (conf_max/score_max) exist precisely because the
    // ceiling-conf pick is a validated money-loser on that market (the
    // "priced-in-top" pattern — hr/tb/hits/hrr/ks), so rejecting it there is
    // the intended behavior, not a drought regression. Called with no `pick`
    // arg (score = null), so only a live conf_max can block it here.
    const overridden = new Set(activeOverrides().map((o) => o.market));
    for (const m of BATTER_MARKETS) {
      const conf = calcConfidence(BOARD_CONFIGS[m].ceiling, m);
      const cap = activeOverrides().find((o) => o.market === m)?.params?.conf_max;
      if (overridden.has(m) && cap != null && conf > cap) continue;
      expect(isOfficialPick(conf, m)).toBe(true);
    }
  });

  it("unknown board never fires", () => {
    expect(isOfficialPick(10, "nope")).toBe(false);
  });
});

describe("isOfficialPick — RBI lineup/gameTotal gate", () => {
  // Above the 7.5 pickThresh, but pulled inside any promoted rbi conf band —
  // this test is about the LINEUP gate and must not double as a bet that rbi
  // has no cap. A hardcoded 9.5 would go red the moment
  // `rbi: stack score_min = 1.191 AND conf_max = 8.8` graduates (it is in the
  // shadow queue), and the lab-analyst guard would then revert a graduation
  // that had earned its way in — which is exactly what happened to a different
  // rbi fixture on 2026-09-06. scripts/gate-promotion-sweep.mjs catches this
  // class before it ships.
  const conf = confClearingOverrides("rbi", 9.5, BOARD_CONFIGS.rbi.pickThresh);
  it("fires only when BOTH lineupOrder and gameTotal are present", () => {
    expect(isOfficialPick(conf, "rbi", { result: { lineupOrder: 3, gameTotal: 9 } })).toBe(true);
  });
  it("is blocked by a missing lineup (lineup-blind RBI picks hit ~30%)", () => {
    expect(isOfficialPick(conf, "rbi", { result: { lineupOrder: null, gameTotal: 9 } })).toBe(false);
  });
  it("is blocked by a missing game total", () => {
    expect(isOfficialPick(conf, "rbi", { result: { lineupOrder: 3, gameTotal: null } })).toBe(false);
  });
  it("is blocked when there is no result at all", () => {
    expect(isOfficialPick(conf, "rbi", {})).toBe(false);
    expect(isOfficialPick(conf, "rbi")).toBe(false);
  });
});

describe("isBoardActionable — score-space board membership (no prob-space gates)", () => {
  // helper: build a player/result with arbitrary signal fields
  const mk = (result = {}, hrScore = 0) => ({
    result,
    player: { models: { hr: { adjScore: hrScore } } },
  });

  it("hits / hr / sb gate on score (+ a form floor where applicable)", () => {
    expect(isBoardActionable("hits", 0.246, {})).toBe(true);
    expect(isBoardActionable("hits", 0.245, {})).toBe(false);
    expect(isBoardActionable("hr", 0.06, { recentHRRate: 0.04 })).toBe(true);
    expect(isBoardActionable("hr", 0.06, { recentHRRate: 0.03 })).toBe(false); // form floor
    // 2026-07-06: SB board membership is score-only (recentSBFreq leg dropped —
    // mined noise/inverted 05-24; it was double-gating the research board to ~2 rows).
    expect(isBoardActionable("sb", 0.4, { recentSBFreq: 0.2 })).toBe(true);
    expect(isBoardActionable("sb", 0.4, { recentSBFreq: 0.1 })).toBe(true);
    expect(isBoardActionable("sb", 0.20, {})).toBe(true);
    expect(isBoardActionable("sb", 0.19, {})).toBe(false);
  });

  it("sb watch tier — sub-threshold research rows, never pickable", () => {
    // (a) modest model read: score in [0.10, 0.20)
    expect(isSbWatch(0.12, {})).toBe(true);
    expect(isSbWatch(0.20, {})).toBe(false);      // actionable, not watch
    expect(isSbWatch(0.09, {})).toBe(false);      // no green-light rescue below without signals
  });

  it("tb gate is pure score >= 3.30 (no impliedProb — the 2026-06-15 fix)", () => {
    expect(isBoardActionable("tb", 3.30, {})).toBe(true);
    expect(isBoardActionable("tb", 3.29, {})).toBe(false);
    // a high score with a (hypothetically) low calibrated prob still makes the board:
    // prob can never re-tighten this gate again.
    expect(isBoardActionable("tb", 4.0, {})).toBe(true);
  });

  it("rbi board fills at score >= 0.69 (logistic squash must not empty it)", () => {
    expect(isBoardActionable("rbi", 0.69, {})).toBe(true);
    expect(isBoardActionable("rbi", 0.68, {})).toBe(false);
  });

  it("hrr: dead zone below 1.90, O1.5 form floor in the middle, O2.5 floor up top", () => {
    // below 1.90 → never on board regardless of form
    expect(isBoardActionable("hrr", 1.90, { recentHRRFreq: 1, recentHRR25Freq: 1 }, mk().player)).toBe(false);
    // middle class 1.90–2.70 → O1.5 freq floor (0.38 when hr score is low)
    expect(isBoardActionable("hrr", 2.0, { recentHRRFreq: 0.40 }, mk({}, 0).player)).toBe(true);
    expect(isBoardActionable("hrr", 2.0, { recentHRRFreq: 0.37 }, mk({}, 0).player)).toBe(false);
    // strong companion HR score lowers the floor to 0.35
    expect(isBoardActionable("hrr", 2.0, { recentHRRFreq: 0.36 }, mk({}, 0.08).player)).toBe(true);
    // top tier >= 2.70 → O2.5 3+ HRR floor
    expect(isBoardActionable("hrr", 2.8, { recentHRR25Freq: 0.31 }, mk({}, 0).player)).toBe(true);
    expect(isBoardActionable("hrr", 2.8, { recentHRR25Freq: 0.30 }, mk({}, 0).player)).toBe(false);
  });

  it("default branch reads cfg.field for unswitched boards", () => {
    expect(isBoardActionable("xyz", 0, { yes: true }, null, { field: "yes" })).toBe(true);
    expect(isBoardActionable("xyz", 0, { yes: false }, null, { field: "yes" })).toBe(false);
  });
});

// isOfficialKsPick's own floor. Ks run their own conf scale (calcKConfidence)
// and have no BOARD_CONFIGS entry, so this is the one place it is written down
// on the test side.
const KS_CONF_FLOOR = 8.5;

describe("isOfficialKsPick — overs ≤5.5 + unders re-enabled, conf>=8.5 (2026-06-17)", () => {
  it("accepts a confident over at or below O5.5", () => {
    // 9.0 was hardcoded here, and `ks: conf_max = 8.6` graduated on 09-09 and was
    // auto-reverted because of it — the same literal-conf bet the under test below
    // had already been fixed for on 09-06, two lines away, in the same block. The
    // claim is "a confident over at/below O5.5 fires", not "ks has no cap".
    expect(
      isOfficialKsPick({ conf: confClearingOverrides("ks", 9.0, KS_CONF_FLOOR), signal: "over", line: 5.5 })
    ).toBe(true);
    expect(isOfficialKsPick({ conf: confFloor("ks"), signal: "over", line: 4.5 })).toBe(true);
  });
  it("accepts unders (re-enabled 6/17 — 55-33 +48% ROI real-money backtest)", () => {
    // 9.9 was hardcoded here. `ks: set conf_max = 8.6` is at day 11 of 14 in the
    // shadow slate running +6.5u — on graduation this test would have rejected a
    // 9.9-conf under, gone red, and had that graduation auto-reverted. The claim
    // is "unders are accepted", not "ks has no cap", so take a conf inside
    // whatever is promoted. 8.5 below is ks's own floor and needs no clamp.
    const conf = confClearingOverrides("ks", 9.9, KS_CONF_FLOOR);
    expect(isOfficialKsPick({ conf, signal: "under", line: 4.5 })).toBe(true);
    expect(isOfficialKsPick({ conf: confFloor("ks"), signal: "under", line: 7.5 })).toBe(true);
  });
  it("still rejects overs above O5.5 (O6.5+ is −59% ROI — book is sharp there)", () => {
    // Clamped for a different reason than the two above: a literal 9.9 here still
    // passes under a promoted cap, but only because the CAP rejected it — the line
    // rule this test is about would never have been reached. Take a conf the gate
    // accepts so the rejection can only be O6.5.
    expect(
      isOfficialKsPick({ conf: confClearingOverrides("ks", 9.9, KS_CONF_FLOOR), signal: "over", line: 6.5 })
    ).toBe(false);
  });
  it("rejects sub-8.5 confidence either direction", () => {
    expect(isOfficialKsPick({ conf: 8.4, signal: "over", line: 5.5 })).toBe(false);
    expect(isOfficialKsPick({ conf: 8.4, signal: "under", line: 4.5 })).toBe(false);
  });
  it("ksPickDirection maps signal to direction", () => {
    expect(ksPickDirection({ signal: "under" })).toBe("under");
    expect(ksPickDirection({ signal: "over" })).toBe("over");
  });
  it("ksPickUnits scales overs with conf tier + edge (capped 5); unders flat 2u", () => {
    expect(ksPickUnits({ conf: 9.5, signal: "over", xKEdge: 2.5 })).toBe(5); // 4 base + 2 → cap 5
    expect(ksPickUnits({ conf: 8.6, signal: "over", xKEdge: 0 })).toBe(1);
    expect(ksPickUnits({ conf: 9.0, signal: "over", xKEdge: 1.2 })).toBe(4); // 3 + 1
    // unders never scale with conf/edge (conf is anti-predictive on unders)
    expect(ksPickUnits({ conf: 9.9, signal: "under", xKEdge: 3.0 })).toBe(2);
    expect(ksPickUnits({ conf: 8.5, signal: "under", xKEdge: 0 })).toBe(2);
  });
});

describe("K role/workload guard — |xK − book line| ≥ 2 (post-mortem 02, 2026-10-01)", () => {
  it("fires only against a REAL book line, at a gap of 2+ Ks either way", () => {
    expect(KS_ROLE_GAP).toBe(2);
    expect(ksRoleUncertain({ hasBookLine: true, xK: 6.6, line: 4.5 })).toBe(true);   // 2.1 above
    expect(ksRoleUncertain({ hasBookLine: true, xK: 2.5, line: 4.5 })).toBe(true);   // exactly 2 below
    expect(ksRoleUncertain({ hasBookLine: true, xK: 6.4, line: 4.5 })).toBe(false);  // 1.9 — normal disagreement
    // No book line: `line` is the model's own floor(xK)+0.5, so a gap means nothing.
    expect(ksRoleUncertain({ hasBookLine: false, xK: 9.0, line: 4.5 })).toBe(false);
    expect(ksRoleUncertain({ xK: 9.0, line: 4.5 })).toBe(false);
    expect(ksRoleUncertain({ hasBookLine: true, xK: null, line: 4.5 })).toBe(false);
    expect(ksRoleUncertain(null)).toBe(false);
  });

  it("ksSignalVsLine keeps the old over/under rule and forces neutral when role-uncertain", () => {
    expect(ksSignalVsLine({ xK: 5.4, kEdge: 5.2, line: 4.5, hasBookLine: true }).signal).toBe("over");
    expect(ksSignalVsLine({ xK: 3.9, kEdge: 4.0, line: 4.5, hasBookLine: true }).signal).toBe("under");
    expect(ksSignalVsLine({ xK: 5.4, kEdge: 4.6, line: 4.5, hasBookLine: true }).signal).toBe("neutral"); // models split
    const r = ksSignalVsLine({ xK: 7.0, kEdge: 7.2, line: 4.5, hasBookLine: true });
    expect(r).toMatchObject({ signal: "neutral", roleUncertain: true });
    expect(r.xKEdge).toBeCloseTo(2.5, 6);
    // the same numbers with no book line are a normal over
    expect(ksSignalVsLine({ xK: 7.0, kEdge: 7.2, line: 4.5, hasBookLine: false })).toMatchObject({ signal: "over", roleUncertain: false });
  });

  it("isOfficialKsPick refuses a role-uncertain pitcher that would otherwise fire", () => {
    // conf AND xK are taken inside whatever ks band is promoted (both are gated), and the
    // control row is an UNDER because unders carry no line cap — so the line can always
    // sit just above xK. Only the guard separates the two rows below.
    const conf = confClearingOverrides("ks", 9.0, KS_CONF_FLOOR);
    const xK = scoreClearingOverrides("ks", 5.0);
    const base = { conf, signal: "under", xK, hasBookLine: true };
    expect(isOfficialKsPick({ ...base, line: xK + 0.5 })).toBe(true);               // 0.5 gap — a normal under
    expect(isOfficialKsPick({ ...base, line: xK + KS_ROLE_GAP + 0.5 })).toBe(false); // 2.5 gap — role-uncertain
    // even if a stale row still carries an over/under signal, the guard holds
    expect(isOfficialKsPick({ ...base, signal: "over", line: xK - KS_ROLE_GAP - 0.5 })).toBe(false);
  });
});

describe("gameLineGates — ML / RL / OU score-space edges", () => {
  it("ML: high conf needs >4% edge; medium needs >6%", () => {
    const hi = gameLineGates({ model: { confidence: "high" }, mlPick: { edge: 0.05 } });
    expect(hi.isMLPlay).toBe(true);
    expect(hi.isMLEV).toBeFalsy();

    const hiThin = gameLineGates({ model: { confidence: "high" }, mlPick: { edge: 0.035 } });
    expect(hiThin.isMLPlay).toBeFalsy();
    expect(hiThin.isMLEV).toBe(true); // >3% but not a play

    const medThin = gameLineGates({ model: { confidence: "medium" }, mlPick: { edge: 0.05 } });
    expect(medThin.isMLPlay).toBeFalsy(); // 5% < 6% medium bar
    expect(medThin.isMLEV).toBe(true);

    const medFat = gameLineGates({ model: { confidence: "medium" }, mlPick: { edge: 0.07 } });
    expect(medFat.isMLPlay).toBe(true);
  });

  it("RL: >=0.75-run cover edge and conf not low", () => {
    const base = { model: { confidence: "high" }, mlPick: null, rlPick: { team: "X" } };
    expect(gameLineGates({ ...base, rlMarginEdge: 0.8 }).isRLPlay).toBe(true);
    expect(gameLineGates({ ...base, rlMarginEdge: 0.5 }).isRLPlay).toBeFalsy();
    expect(gameLineGates({ ...base, model: { confidence: "low" }, rlMarginEdge: 1.5 }).isRLPlay).toBe(false);
  });

  it("OU: |edge| >= 1.5 runs, independent of moneyline conf", () => {
    const m = { model: { confidence: "low" }, mlPick: null, rlPick: null };
    expect(gameLineGates({ ...m, ouEdge: 1.6 }).isOUPlay).toBe(true);
    expect(gameLineGates({ ...m, ouEdge: -1.6 }).isOUPlay).toBe(true);
    expect(gameLineGates({ ...m, ouEdge: 1.0 }).isOUPlay).toBe(false);
    expect(gameLineGates({ ...m, ouEdge: null }).isOUPlay).toBe(false);
  });

  it("hasPlay is the OR of the three", () => {
    expect(gameLineGates({ model: {}, mlPick: null, rlPick: null, ouEdge: 1.6 }).hasPlay).toBe(true);
    expect(gameLineGates({ model: {}, mlPick: null, rlPick: null, ouEdge: 0 }).hasPlay).toBeFalsy();
  });
});

describe("batterPickUnits — distance-from-pickThresh sizing", () => {
  it("returns 0 below the gate, scales up above it", () => {
    expect(batterPickUnits(BOARD_CONFIGS.hits.pickThresh - 0.1, "hits")).toBe(0);
    expect(batterPickUnits(BOARD_CONFIGS.hits.pickThresh + 0.2, "hits")).toBe(1);
    expect(batterPickUnits(BOARD_CONFIGS.hits.pickThresh + 1.0, "hits")).toBe(3);
    expect(batterPickUnits(BOARD_CONFIGS.hits.pickThresh + 3.0, "hits")).toBe(5);
  });
  it("caps TB value picks at 2u", () => {
    const conf = BOARD_CONFIGS.tb.pickThresh + 1.0; // would be 3u normally
    expect(batterPickUnits(conf, "tb", { result: { pickKind: "tb_value" } })).toBe(2);
    expect(batterPickUnits(conf, "tb", { result: { pickKind: "tb_stud" } })).toBe(3);
  });
});

describe("pickStakeUnits — Results weighted-track stake by market", () => {
  // 2026-08-27: the schedule was re-based from typical PRICE onto measured edge.
  // hits (2u → 1u) is the biggest consistent loser, −5.1% ROI in both halves;
  // sb (0.5u → 1u) is the only market positive in both halves at +24.4%. The old
  // price-inverse schedule was sizing up the worst market and down the best.
  it("keeps HR at 0.5u — it is the one market whose edge flips sign OOS", () => {
    expect(pickStakeUnits("hr")).toBe(0.5);
  });
  it("stakes hits and sb flat at 1u", () => {
    expect(pickStakeUnits("hits")).toBe(1);
    expect(pickStakeUnits("sb")).toBe(1);
  });
  it("defaults all other markets to 1u", () => {
    for (const m of ["hrr", "tb", "ks", "rbi", "ml", "rl", "ou", "unknown"]) {
      expect(pickStakeUnits(m)).toBe(1);
    }
  });

  // DRIFT GUARD. scripts/lib/lab-core.mjs carries its own copy of this schedule
  // because the lab harness must stay Node-only and picks.js drags in the whole
  // model layer. Two literals means they can silently diverge, and when they do
  // the lab is optimising a bankroll the tracker does not run — every "adds +Xu"
  // in a sweep report would be answering a different question than the Results
  // page. This asserts they are the same map, not merely similar.
  it("stays in sync with the lab harness stake schedule", async () => {
    const { LAB_MARKET_STAKE, SPORTS } = await import("../../scripts/lib/lab-core.mjs");
    expect(LAB_MARKET_STAKE).toEqual(MARKET_UNITS);
    // And the value the harness actually hands each market must equal what the
    // tracker would stake it at — the map being equal is not enough if the
    // fall-through ever changes on one side.
    const cfg = SPORTS.mlb.defaults();
    for (const m of SPORTS.mlb.markets) {
      expect(cfg.markets[m].stake).toBe(pickStakeUnits(m));
    }
  });
});

describe("pickCurrentConf / pickMeetsCurrentThreshold — Results dashboard", () => {
  it("pickCurrentConf returns null for ks and for score-less rows", () => {
    expect(pickCurrentConf({ prop_type: "ks", model_score: 5 })).toBeNull();
    // nrfi conf is edge in pp, not the 0–10 board scale — never map it through
    expect(pickCurrentConf({ prop_type: "nrfi", model_score: 8 })).toBeNull();
    expect(pickCurrentConf({ prop_type: "hits", model_score: 0 })).toBeNull();
    expect(pickCurrentConf({ prop_type: "hits", model_score: BOARD_CONFIGS.hits.ceiling })).toBeCloseTo(9.5, 5);
  });

  it("game lines and ks always meet threshold (gated at save time)", () => {
    for (const t of ["ks", "ml", "rl", "ou", "nrfi"]) {
      expect(pickMeetsCurrentThreshold({ prop_type: t })).toBe(true);
    }
  });

  it("NEW picks gate on stored conf >= pickThresh", () => {
    expect(pickMeetsCurrentThreshold({ prop_type: "hits", conf: 9.0 })).toBe(true);
    expect(pickMeetsCurrentThreshold({ prop_type: "hits", conf: 8.0 })).toBe(false);
  });

  it("LEGACY picks (conf=null) gate on model_score >= display thresh", () => {
    expect(pickMeetsCurrentThreshold({ prop_type: "hr", conf: null, model_score: BOARD_CONFIGS.hr.thresh + 0.01 })).toBe(true);
    expect(pickMeetsCurrentThreshold({ prop_type: "hr", conf: null, model_score: BOARD_CONFIGS.hr.thresh - 0.01 })).toBe(false);
  });

  it("unknown prop types never qualify", () => {
    expect(pickMeetsCurrentThreshold({ prop_type: "nope" })).toBe(false);
  });
});
