/**
 * Tests for the promoted-lab-gate layer (src/lib/gateOverrides.js) and its
 * integration into isOfficialPick.
 *
 * WHY THESE ARE STRICT. This layer is the only part of the codebase that lets
 * an automated process change which picks fire. Everything else a script writes
 * (blendParams, nrfiParams, market_health) affects math or sizing; this affects
 * SELECTION. The two invariants below are the ones that keep it from becoming
 * the next silent-gate bug:
 *
 *   1. Overrides can only ever SUBTRACT. If a promoted gate could admit a pick
 *      the base gates rejected, a bad graduation would widen the board instead
 *      of narrowing it — and widening failures are the ones that cost money
 *      quietly, because the picks look normal.
 *   2. Board membership is never consulted. A market must keep surfacing its
 *      research board no matter what is promoted (standing user constraint);
 *      only the 🎲 is at stake.
 *
 * Run: npx vitest run
 */
import { describe, it, expect } from "vitest";
import { passesGateOverrides, activeOverrides, getGateOverride } from "./gateOverrides.js";
import { isOfficialPick, isOfficialKsPick, isBoardActionable, BOARD_CONFIGS } from "./picks.js";
import OVERRIDES_JSON from "./gateOverrides.json" with { type: "json" };

/**
 * Inputs that clear whatever `market` has promoted TODAY, so a test about some
 * OTHER gate can't be knocked over by an unrelated graduation.
 *
 * This exists because of 2026-09-06: the rbi test below hardcoded
 * `adjScore: 1.0`, `rbi.score_min = 1.206` graduated overnight, 1.0 fell under
 * the new floor, and the suite went red for a promotion that had done
 * everything right — 14 days of shadow, 20 picks, +1.35u over the incumbent.
 * The lab-analyst guard then reverted it, which is exactly the deadlock this
 * file's header warns about, reintroduced by one fixture.
 */
function passingInputs(market) {
  const { pickThresh } = BOARD_CONFIGS[market];
  const o = getGateOverride(market) ?? {};
  // conf must clear pickThresh AND sit inside any promoted conf band.
  const conf = o.conf_min != null ? Math.max(pickThresh, o.conf_min) : pickThresh;
  // score just has to sit inside any promoted score band; 1.0 when unbounded.
  let score = 1.0;
  if (o.score_min != null) score = Math.max(score, o.score_min);
  if (o.score_max != null) score = Math.min(score, o.score_max);
  // A band that admits nothing is a broken promotion, not a fixture problem —
  // say which, rather than failing somewhere downstream as a mystery.
  expect(
    passesGateOverrides(market, conf, score),
    `${market}'s promoted gate admits no pick at/above pickThresh — ` +
      `check src/lib/gateOverrides.json (${JSON.stringify(o)})`
  ).toBe(true);
  return { conf, score };
}

// These assert INVARIANTS, never "nothing is promoted".
//
// The first draft of this file asserted the shipped JSON was empty — which was
// true when written and would have deadlocked the system permanently. The
// lab-analyst workflow runs `npm test` after the promotion gate and reverts
// gateOverrides.json if the suite goes red. So the first successful promotion
// would have turned the suite red, been auto-reverted, and retried every night
// forever, silently. A test that encodes today's data as an expectation becomes
// a tripwire against the system working. Caught 2026-07-20 by installing a
// fake promoted gate and re-running; that fixture check is the last block here.
describe("passesGateOverrides — invariants that hold at any promotion state", () => {
  const unpromoted = Object.keys(BOARD_CONFIGS).filter((m) => !getGateOverride(m));

  it("is a no-op for every market with no promoted gate", () => {
    for (const m of unpromoted) {
      expect(passesGateOverrides(m, 9.9, 99)).toBe(true);
      expect(passesGateOverrides(m, -5, -5)).toBe(true);
    }
  });

  it("returns null for a market with no promoted gate", () => {
    for (const m of unpromoted) expect(getGateOverride(m)).toBeNull();
  });

  it("reports exactly the markets that carry an enforceable promoted param", () => {
    const reported = activeOverrides().map((o) => o.market).sort();
    const expected = Object.keys(BOARD_CONFIGS)
      .concat("ks")
      .filter((m) => {
        const o = getGateOverride(m);
        return o && ["conf_min", "conf_max", "score_min", "score_max"].some((k) => o[k] != null);
      })
      .sort();
    expect(reported).toEqual(expected);
  });

  it("every reported override enforces at least one bound", () => {
    for (const { market, params } of activeOverrides()) {
      expect(Object.keys(params).length, `${market} reported with no enforceable param`).toBeGreaterThan(0);
    }
  });

  it("tolerates null conf/score without throwing", () => {
    for (const m of Object.keys(BOARD_CONFIGS)) {
      expect(() => passesGateOverrides(m, null, null)).not.toThrow();
    }
  });

  it("an unknown market is always a no-op", () => {
    expect(passesGateOverrides("not_a_market", 9.9, 99)).toBe(true);
  });
});

// Exercise the enforcement semantics against a synthetic override table rather
// than whatever is shipped. (This comment used to say "the shipped JSON is
// empty" — it has not been empty since 2026-08-03, and a stale claim like that
// is how the rbi fixture below came to assume rbi was ungated.)
describe("override enforcement semantics", () => {
  const check = (o, conf, score) => {
    if (conf != null) {
      if (o.conf_min != null && conf < o.conf_min) return false;
      if (o.conf_max != null && conf > o.conf_max) return false;
    }
    if (score != null) {
      if (o.score_min != null && score < o.score_min) return false;
      if (o.score_max != null && score > o.score_max) return false;
    }
    return true;
  };

  it("conf_max caps the top tail (the priced-in-top finding)", () => {
    const o = { conf_max: 9.3 };
    expect(check(o, 9.2, null)).toBe(true);
    expect(check(o, 9.3, null)).toBe(true);   // inclusive — matches lab qualifies()
    expect(check(o, 9.4, null)).toBe(false);
  });

  it("score_max caps on the model score, not the confidence", () => {
    const o = { score_max: 0.081 };
    expect(check(o, 9.9, 0.080)).toBe(true);
    expect(check(o, 1.0, 0.082)).toBe(false);
  });

  it("floors and caps compose into a band", () => {
    const o = { conf_min: 8.0, conf_max: 9.0 };
    expect(check(o, 7.9, null)).toBe(false);
    expect(check(o, 8.5, null)).toBe(true);
    expect(check(o, 9.1, null)).toBe(false);
  });

  it("inclusive bounds match the lab's qualifies() exactly", () => {
    // lab-core qualifies(): conf < conf_min || conf > conf_max → reject.
    // A pick sitting exactly on a promoted bound must survive, or the shadow
    // slate's measured lift would not be the lift that ships.
    const o = { conf_min: 8.0, conf_max: 9.0 };
    expect(check(o, 8.0, null)).toBe(true);
    expect(check(o, 9.0, null)).toBe(true);
  });
});

describe("integration — overrides subtract from isOfficialPick, never add", () => {
  const mkPick = (score) => ({ result: { adjScore: score } });

  it("a pick below pickThresh stays rejected regardless of overrides", () => {
    // Even a maximally permissive override cannot resurrect a sub-threshold
    // pick, because the override check runs LAST and only returns false.
    const cfg = BOARD_CONFIGS.hr;
    expect(isOfficialPick(cfg.pickThresh - 0.1, "hr", mkPick(0.07))).toBe(false);
  });

  it("a pick at/above pickThresh fires, given the market's own promoted gate", () => {
    // Written to survive an hr promotion: assert isOfficialPick agrees with the
    // override layer rather than assuming hr is ungated.
    const cfg = BOARD_CONFIGS.hr;
    const conf = cfg.pickThresh, score = 0.07;
    const expected = passesGateOverrides("hr", conf, score);
    expect(isOfficialPick(conf, "hr", mkPick(score))).toBe(expected);
  });

  it("rbi keeps its lineup/gameTotal gate ahead of any override", () => {
    // Derived, never hardcoded — see passingInputs() above for what hardcoding
    // cost on 2026-09-06. The claim under test is about ORDERING: rbi's extra
    // lineup/gameTotal requirement is applied independently of the override
    // layer. Both halves are therefore written against the override layer's own
    // verdict rather than against a literal, so a graduation can move the
    // verdict without moving the claim.
    const { conf, score } = passingInputs("rbi");

    // No lineup data → rejected, even though the override layer passes this
    // pick. That is the ordering: the lineup gate is not something a promoted
    // gate can get in front of.
    expect(isOfficialPick(conf, "rbi", { result: { adjScore: score } })).toBe(false);

    // With lineup data → the override layer is the only thing left deciding.
    expect(isOfficialPick(conf, "rbi", {
      result: { adjScore: score, lineupOrder: 3, gameTotal: 9 },
    })).toBe(passesGateOverrides("rbi", conf, score));
  });

  it("reads adjScore in preference to score (the scoring score)", () => {
    // Documents which field the score_min/score_max bounds range over — if this
    // ever flips to raw score, promoted score gates would silently mean
    // something different than what the shadow slate measured.
    const conf = BOARD_CONFIGS.hr.pickThresh;
    const p = { result: { adjScore: 0.09, score: 0.02 } };
    // If the two fields were swapped, the override layer would be handed 0.02
    // and a promoted hr score bound would bite differently. Assert against
    // adjScore explicitly so the contract holds whatever is promoted.
    expect(isOfficialPick(conf, "hr", p)).toBe(passesGateOverrides("hr", conf, 0.09));
  });
});

describe("board membership is never gated by overrides", () => {
  it("isBoardActionable does not consult the override layer", () => {
    // A market must keep surfacing its research board no matter what is
    // promoted. If someone later wires passesGateOverrides into
    // isBoardActionable, this test is the tripwire.
    const src = isBoardActionable.toString();
    expect(src).not.toMatch(/passesGateOverrides|GateOverride/);
  });

  it("hr board membership is unchanged by a hypothetical hr cap", () => {
    const result = { recentHRRate: 0.05 };
    expect(isBoardActionable("hr", 0.09, result, {}, BOARD_CONFIGS.hr)).toBe(true);
  });
});

// A promoted gate that the runtime cannot enforce is worse than no gate: it graduates a
// shadow slate, gets written into gateOverrides.json, appears in GATE_CHANGELOG.md, and
// then cuts nothing at save time. Ks shipped in exactly that state until 2026-09-08 —
// isOfficialKsPick passed a hard `null` for score, and gateOverrides.js reads null as "no
// score to test", so score_min/score_max were inert for the one market whose gate call is
// hand-written rather than going through isOfficialPick. promotion-gate.mjs meanwhile
// advertises both bounds as enforceable for every market.
//
// These install a fake promotion on the imported JSON (same module instance the runtime
// reads) and restore it, so they assert the wiring rather than today's promotion state.
describe("ks score gates reach the runtime (lab/runtime parity)", () => {
  function withKsOverride(o, fn) {
    const had = Object.prototype.hasOwnProperty.call(OVERRIDES_JSON.mlb, "ks");
    const saved = OVERRIDES_JSON.mlb.ks;
    OVERRIDES_JSON.mlb.ks = o;
    try { return fn(); } finally {
      if (had) OVERRIDES_JSON.mlb.ks = saved; else delete OVERRIDES_JSON.mlb.ks;
    }
  }

  // The lab's own predicate (scripts/lib/lab-core.mjs `qualifies`) is
  // `score < score_min || score > score_max -> reject`, ranging over the feed's `score`
  // column, which is mlb_picks.model_score, which App.jsx savePitchers writes as xK.
  const labRejects = (o, score) =>
    (o.score_min != null && score < o.score_min) || (o.score_max != null && score > o.score_max);

  // A pick that clears every base ks gate, so only the override decides.
  const ksPick = (xK) => ({ conf: 9, signal: "under", line: 4.5, xK });

  it("a score_min the lab would reject also rejects at save time", () => {
    withKsOverride({ score_min: 6.0 }, () => {
      expect(labRejects({ score_min: 6.0 }, 4)).toBe(true);
      expect(isOfficialKsPick(ksPick(4))).toBe(false);
      expect(isOfficialKsPick(ksPick(7))).toBe(true);
    });
  });

  it("a score_max the lab would reject also rejects at save time", () => {
    withKsOverride({ score_max: 6.0 }, () => {
      expect(labRejects({ score_max: 6.0 }, 8)).toBe(true);
      expect(isOfficialKsPick(ksPick(8))).toBe(false);
      expect(isOfficialKsPick(ksPick(5))).toBe(true);
    });
  });

  it("agrees with the lab predicate across a band, both bounds live", () => {
    const o = { score_min: 4.5, score_max: 7.5 };
    withKsOverride(o, () => {
      for (const xK of [3, 4.4, 4.5, 5, 6, 7.5, 7.6, 9]) {
        expect(isOfficialKsPick(ksPick(xK)), `xK=${xK}`).toBe(!labRejects(o, xK));
      }
    });
  });

  it("an impossible floor cuts everything (the fixture that used to pass)", () => {
    // Astra's reproduction: score_min 1000 accepted an xK=4 pick.
    withKsOverride({ score_min: 1000 }, () => {
      expect(isOfficialKsPick(ksPick(4))).toBe(false);
    });
  });

  it("a missing xK still clears a score gate rather than throwing", () => {
    // Absent score means "cannot test", same as every other market — it must not
    // hard-fail the save path, and it must not be silently treated as zero.
    withKsOverride({ score_min: 6.0 }, () => {
      expect(() => isOfficialKsPick({ conf: 9, signal: "under", line: 4.5 })).not.toThrow();
      expect(isOfficialKsPick({ conf: 9, signal: "under", line: 4.5 })).toBe(true);
    });
  });

  it("conf gates still bite, and the two bounds are independent", () => {
    withKsOverride({ conf_max: 8.0, score_min: 6.0 }, () => {
      expect(isOfficialKsPick({ conf: 9, signal: "under", line: 4.5, xK: 7 })).toBe(false); // conf
      expect(isOfficialKsPick({ conf: 7.9, signal: "under", line: 4.5, xK: 4 })).toBe(false); // conf base gate
    });
  });
});

describe("the shipped gateOverrides.json stays a generated artifact", () => {
  it("declares no enforceable gate by hand", async () => {
    const json = (await import("./gateOverrides.json", { with: { type: "json" } })).default;
    const mlb = json.mlb ?? {};
    for (const [market, o] of Object.entries(mlb)) {
      // Anything present must carry its provenance — a hand-added gate with no
      // shadow record is exactly what this system exists to prevent.
      expect(o.source, `${market} override is missing its source proposal id`).toBeTruthy();
      expect(o.promoted, `${market} override is missing its promotion date`).toBeTruthy();
    }
  });
});
