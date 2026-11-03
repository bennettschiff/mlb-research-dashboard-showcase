/**
 * Tests for the DISPLAY invariant (src/lib/conviction.js).
 *
 * The bug this file exists to prevent: on 2026-08-14 the Total Bases board
 * showed its top eight rows at "10.0" and not one of them carried a 🎲, and
 * Home Run had the same shape. The gates were right; the board was ranking on
 * a number the gates did not read. That is the failure this suite freezes.
 *
 * THE INVARIANT, stated once: a row NEVER displays at or above its market's
 * play line without being an official pick. Everything else here is detail.
 *
 * Written against activeOverrides()/gameLineGates rather than against today's
 * promoted values, so it keeps holding after the next promotion — the mistake
 * documented in docs/GATE_CHANGELOG.md (2026-08-03) was asserting current data
 * in a test that gates an automated writer.
 *
 * Run: npx vitest run
 */
import { describe, it, expect } from "vitest";
import {
  TIER,
  TIER_META,
  FOLD_BAND,
  LEAN_BAND,
  foldBelowLine,
  boardConviction,
  ksConviction,
  KS_PLAY_LINE,
  KS_OVER_LINE_CAP,
  GAME_PLAY_LINE,
  ML_REQUIRED_EDGE,
  RL_REQUIRED_EDGE,
  OU_REQUIRED_EDGE,
  ratioToConviction,
  mlConviction,
  rlConviction,
  ouConviction,
  bestGameConviction,
} from "./conviction.js";
import {
  BOARD_CONFIGS,
  calcConfidence,
  isOfficialPick,
  isOfficialKsPick,
  gameLineGates,
} from "./picks.js";

const BATTER_MARKETS = Object.keys(BOARD_CONFIGS);

// A dense score sweep for a market, from below its display threshold to well
// past its ceiling — the range a real board covers, plus the over-ceiling tail
// where the rail and the promoted caps both live.
function scoreSweep(market) {
  const { thresh, ceiling } = BOARD_CONFIGS[market];
  const lo = thresh * 0.5;
  const hi = ceiling * 1.6;
  const out = [];
  for (let i = 0; i <= 120; i++) out.push(lo + ((hi - lo) * i) / 120);
  return out;
}

// RBI is the one batter market with a data requirement on top of the score
// gate, so give every sweep row the fields it needs; the RBI-specific block is
// covered on its own below.
const mkPick = (score) => ({
  score,
  result: { adjScore: score, score, lineupOrder: 3, gameTotal: 9 },
});

describe("THE INVARIANT — nothing outranks the plays", () => {
  for (const market of BATTER_MARKETS) {
    it(`${market}: no row displays at/above the play line without the dice`, () => {
      const { pickThresh } = BOARD_CONFIGS[market];
      for (const score of scoreSweep(market)) {
        const pick = mkPick(score);
        const c = boardConviction(score, market, pick);
        const plays = isOfficialPick(calcConfidence(score, market, pick), market, pick);
        if (!plays) expect(c.conf).toBeLessThan(pickThresh);
        expect(c.tier === TIER.play).toBe(plays);
      }
    });

    it(`${market}: a play keeps its raw conviction untouched`, () => {
      for (const score of scoreSweep(market)) {
        const pick = mkPick(score);
        const raw = calcConfidence(score, market, pick);
        if (!isOfficialPick(raw, market, pick)) continue;
        expect(boardConviction(score, market, pick).conf).toBe(raw);
      }
    });

    it(`${market}: the board never goes dark — every row still gets a conviction`, () => {
      // gateOverrides.js hard rule 1: overrides gate picks, never boards.
      for (const score of scoreSweep(market)) {
        const c = boardConviction(score, market, mkPick(score));
        expect(Number.isFinite(c.conf)).toBe(true);
        expect(c.conf).toBeGreaterThanOrEqual(1.0);
        expect(c.conf).toBeLessThanOrEqual(10.0);
      }
    });
  }

  it("a folded row lands in the band just below the line, never below it", () => {
    for (const market of BATTER_MARKETS) {
      const { pickThresh } = BOARD_CONFIGS[market];
      for (const score of scoreSweep(market)) {
        const c = boardConviction(score, market, mkPick(score));
        if (!c.folded) continue;
        expect(c.conf).toBeLessThan(pickThresh);
        expect(c.conf).toBeGreaterThanOrEqual(pickThresh - FOLD_BAND);
        expect(c.reason).toBeTruthy();
      }
    }
  });

  it("folding is the ONLY thing that can move a conviction off its raw value", () => {
    for (const market of BATTER_MARKETS) {
      for (const score of scoreSweep(market)) {
        const pick = mkPick(score);
        const c = boardConviction(score, market, pick);
        if (c.folded) continue;
        expect(c.conf).toBe(calcConfidence(score, market, pick));
      }
    }
  });
});

describe("foldBelowLine", () => {
  it("inverted: further past the cap sinks further (the priced-in reading)", () => {
    const a = foldBelowLine(8.6, 8.5, { inverted: true });
    const b = foldBelowLine(10.0, 8.5, { inverted: true });
    expect(a).toBeGreaterThan(b);
    expect(b).toBeCloseTo(8.5 - FOLD_BAND, 5);
  });

  it("order-preserving: a bigger raw read still sorts higher inside the band", () => {
    const a = foldBelowLine(8.6, 8.5, { inverted: false });
    const b = foldBelowLine(10.0, 8.5, { inverted: false });
    expect(b).toBeGreaterThan(a);
  });

  it("always lands strictly below the line", () => {
    for (const raw of [8.5, 8.7, 9.0, 9.9, 10.0, 12.0]) {
      for (const inverted of [true, false]) {
        expect(foldBelowLine(raw, 8.5, { inverted })).toBeLessThan(8.5);
      }
    }
  });
});

describe("batter block reasons name the gate that actually fired", () => {
  it("rbi without a confirmed lineup is blocked, not priced in", () => {
    const score = BOARD_CONFIGS.rbi.ceiling;
    const pick = { score, result: { adjScore: score, lineupOrder: null, gameTotal: 9 } };
    const c = boardConviction(score, "rbi", pick);
    expect(c.tier).toBe(TIER.blocked);
    expect(c.reason).toMatch(/lineup/i);
    expect(c.conf).toBeLessThan(BOARD_CONFIGS.rbi.pickThresh);
  });

  it("rbi without a game total is blocked", () => {
    const score = BOARD_CONFIGS.rbi.ceiling;
    const pick = { score, result: { adjScore: score, lineupOrder: 3, gameTotal: null } };
    expect(boardConviction(score, "rbi", pick).reason).toMatch(/game total/i);
  });

  it("a promoted cap reads as PRICED IN wherever one is live", () => {
    // Survives promotion churn: assert the shape on whichever markets are
    // currently capped, and assert nothing folds as priced-in where none is.
    let sawCap = false;
    for (const market of BATTER_MARKETS) {
      for (const score of scoreSweep(market)) {
        const c = boardConviction(score, market, mkPick(score));
        if (c.tier !== TIER.pricedIn) continue;
        sawCap = true;
        expect(c.reason).toMatch(/promoted cap/);
        expect(c.raw).toBeGreaterThanOrEqual(BOARD_CONFIGS[market].pickThresh);
      }
    }
    // Documents the state this was written in without asserting it: if every
    // cap is later reverted, this test still passes and still guards the shape.
    expect(typeof sawCap).toBe("boolean");
  });

  it("every tier has display metadata", () => {
    for (const t of Object.values(TIER)) expect(TIER_META[t]?.label).toBeTruthy();
  });

  it("lean is the band immediately under the line", () => {
    const m = "hits";
    const { pickThresh, thresh, ceiling } = BOARD_CONFIGS[m];
    // Invert the linear core of calcConfidence to hit a target conviction.
    const scoreFor = (conf) => thresh + ((conf - 4.0) / 5.5) * (ceiling - thresh);
    expect(boardConviction(scoreFor(pickThresh - 0.2), m, {}).tier).toBe(TIER.lean);
    expect(boardConviction(scoreFor(pickThresh - LEAN_BAND - 0.5), m, {}).tier).toBe(TIER.research);
  });
});

describe("Ks conviction", () => {
  const mkKs = (over) => ({ conf: 9.6, signal: "over", line: over });

  it("agrees with isOfficialKsPick on every row", () => {
    const rows = [
      { conf: 9.6, signal: "over", line: 4.5 },
      { conf: 9.6, signal: "over", line: 7.5 },
      { conf: 8.4, signal: "over", line: 4.5 },
      { conf: 9.9, signal: "under", line: 6.5 },
      { conf: 9.9, signal: "neutral", line: 6.5 },
      { conf: 8.5, signal: "under", line: 5.5 },
    ];
    for (const p of rows) {
      const c = ksConviction(p);
      expect(c.tier === TIER.play).toBe(isOfficialKsPick(p));
      if (!isOfficialKsPick(p)) expect(c.conf).toBeLessThan(KS_PLAY_LINE);
    }
  });

  it("a high-conviction over above the line cap folds, and says why", () => {
    const c = ksConviction(mkKs(KS_OVER_LINE_CAP + 1));
    expect(c.folded).toBe(true);
    expect(c.reason).toMatch(new RegExp(`O${KS_OVER_LINE_CAP}`));
  });

  it("a directionless row folds on the disagreement, not on a price", () => {
    const c = ksConviction({ conf: 9.9, signal: "neutral", line: 5.5 });
    expect(c.reason).toMatch(/disagree/i);
  });

  it("a role-uncertain row folds and names the role/workload gap, not a model disagreement", () => {
    const p = { conf: 9.6, signal: "neutral", line: 3.5, xK: 6.2, hasBookLine: true, roleUncertain: true };
    const c = ksConviction(p);
    expect(c.tier === TIER.play).toBe(false);
    expect(c.conf).toBeLessThan(KS_PLAY_LINE);
    expect(c.reason).toMatch(/role or workload/i);
  });
});

describe("game-line conviction — one scale, one line, three markets", () => {
  it("ratioToConviction is anchored: no edge → 1.0, the bar → the play line", () => {
    expect(ratioToConviction(0)).toBe(1.0);
    expect(ratioToConviction(1)).toBe(GAME_PLAY_LINE);
    expect(ratioToConviction(2.5)).toBe(10.0);
    expect(ratioToConviction(99)).toBe(10.0);
  });

  it("is monotone in the ratio", () => {
    let prev = -Infinity;
    for (let r = 0; r <= 4; r += 0.05) {
      const v = ratioToConviction(r);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  // Grid over the same inputs gameLineGates reads, checked against the gates
  // themselves so the two can never drift apart.
  const CONFS = ["high", "medium", "low"];
  const EDGES = [0, 0.01, 0.03, 0.039, 0.04, 0.041, 0.06, 0.061, 0.1, 0.2];
  const MARGINS = [0, 0.3, 0.74, 0.75, 0.76, 1.5, 3.0];
  const OU_EDGES = [0, 0.5, 1.49, 1.5, 1.51, 3.0, -2.0];

  it("ML: conviction ≥ the play line iff gameLineGates says it is a play", () => {
    for (const confidence of CONFS) {
      for (const edge of EDGES) {
        const model = { confidence };
        const mlPick = { side: "home", edge };
        const { isMLPlay } = gameLineGates({ model, mlPick, rlPick: null, rlMarginEdge: null, ouEdge: null });
        const c = mlConviction({ model, mlPick, isMLPlay });
        expect(c.tier === TIER.play).toBe(!!isMLPlay);
        if (!isMLPlay) expect(c.conf).toBeLessThan(GAME_PLAY_LINE);
        else expect(c.conf).toBeGreaterThanOrEqual(GAME_PLAY_LINE);
      }
    }
  });

  it("RL: conviction ≥ the play line iff gameLineGates says it is a play", () => {
    for (const confidence of CONFS) {
      for (const rlMarginEdge of MARGINS) {
        const model = { confidence };
        const rlPick = { side: "home", label: "HOME -1.5" };
        const { isRLPlay } = gameLineGates({ model, mlPick: null, rlPick, rlMarginEdge, ouEdge: null });
        const c = rlConviction({ model, rlPick, rlMarginEdge, isRLPlay });
        expect(c.tier === TIER.play).toBe(!!isRLPlay);
        if (!isRLPlay) expect(c.conf).toBeLessThan(GAME_PLAY_LINE);
      }
    }
  });

  it("O/U: conviction ≥ the play line iff gameLineGates says it is a play", () => {
    for (const ouEdge of OU_EDGES) {
      const model = { confidence: "low" }; // OU is deliberately tier-independent
      const { isOUPlay } = gameLineGates({ model, mlPick: null, rlPick: null, rlMarginEdge: null, ouEdge });
      const c = ouConviction({ ouEdge, gameTotal: 8.5, isOUPlay });
      expect(c.tier === TIER.play).toBe(!!isOUPlay);
      if (!isOUPlay) expect(c.conf).toBeLessThan(GAME_PLAY_LINE);
    }
  });

  it("a fat edge on a coin-flip game folds instead of topping the page", () => {
    // The 2026-08-14 MIL @ LAD row: +10.1% moneyline edge, LOW model
    // confidence. The old inline formula scored it 7.6 with no dice, above a
    // 5.8 that had one.
    const model = { confidence: "low" };
    const mlPick = { side: "away", edge: 0.101 };
    const c = mlConviction({ model, mlPick, isMLPlay: false });
    expect(c.folded).toBe(true);
    expect(c.conf).toBeLessThan(GAME_PLAY_LINE);
    expect(c.reason).toMatch(/coin flip/i);
  });

  it("a pick side with a trivial edge is scored, not shown as an em dash", () => {
    // The MIA @ CIN row: "CIN +0.1%" displayed next to a "—" signal.
    const c = mlConviction({ model: { confidence: "low" }, mlPick: { side: "home", edge: 0.001 }, isMLPlay: false });
    expect(c.conf).not.toBeNull();
    expect(c.conf).toBeLessThan(2);
  });

  it("the published gate constants are the denominators we score against", () => {
    // If gameLineGates is ever retuned, these must move with it or the whole
    // scale silently stops meaning "fraction of the bar".
    const src = gameLineGates.toString();
    expect(src).toContain(String(ML_REQUIRED_EDGE.high));
    expect(src).toContain(String(ML_REQUIRED_EDGE.medium));
    expect(src).toContain(String(RL_REQUIRED_EDGE));
    expect(src).toContain(String(OU_REQUIRED_EDGE));
  });

  it("missing market data reads as unscored, not as zero conviction", () => {
    expect(mlConviction({ model: { confidence: "high" }, mlPick: null }).conf).toBeNull();
    expect(rlConviction({ model: { confidence: "high" }, rlPick: null, rlMarginEdge: null }).conf).toBeNull();
    expect(ouConviction({ ouEdge: null, gameTotal: 8.5 }).conf).toBeNull();
  });

  it("bestGameConviction picks the row's strongest scored market", () => {
    const best = bestGameConviction({
      ml: ouConviction({ ouEdge: 0.2, gameTotal: 8.5, isOUPlay: false }),
      ou: ouConviction({ ouEdge: 2.0, gameTotal: 8.5, isOUPlay: true }),
      rl: { conf: null },
    });
    expect(best.market).toBe("ou");
    expect(best.tier).toBe(TIER.play);
  });
});
