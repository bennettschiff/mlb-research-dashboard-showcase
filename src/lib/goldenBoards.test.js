import { describe, it, expect } from "vitest";
import {
  selectBoard, selectAllBoards, isMainLine, getBoardConfig,
  GOLDEN_BOARDS, GOLDEN_BOARD_KEYS, MARKET_LINE_CAP,
  ODDS_FLOOR_LIKELY, ODDS_FLOOR_PRICED, ODDS_CEIL,
  isPlayPick, boardPlayLimit, PLAY_LIMIT_LIKELY,
} from "./goldenBoards.js";

// Minimal Brain Trust prediction row.
const row = (o = {}) => ({
  name: o.name ?? "Player A",
  market: o.market ?? "hits",
  line: o.line ?? 0.5,
  modelProb: o.modelProb ?? 0.6,
  bookOdds: o.bookOdds ?? -150,
  edge: o.edge ?? 0.05,
  ev: o.ev ?? 0.05,
  trust: o.trust ?? "trusted",
});

describe("board config", () => {
  it("exposes exactly the three boards, keyed and unique", () => {
    expect(GOLDEN_BOARD_KEYS).toEqual(["likely", "lines", "value"]);
    expect(new Set(GOLDEN_BOARD_KEYS).size).toBe(3);
    for (const b of GOLDEN_BOARDS) expect(typeof b.key).toBe("string");
  });

  it("marks only the value board as research-only", () => {
    expect(getBoardConfig("likely").research).toBe(false);
    expect(getBoardConfig("lines").research).toBe(false);
    expect(getBoardConfig("value").research).toBe(true);
  });

  it("returns null for an unknown board and selects nothing", () => {
    expect(getBoardConfig("nope")).toBeNull();
    expect(selectBoard([row()], "nope")).toEqual([]);
  });
});

describe("main vs alternate lines", () => {
  it("knows each market's primary line", () => {
    expect(isMainLine("tb", 1.5)).toBe(true);
    expect(isMainLine("tb", 2.5)).toBe(false);
    expect(isMainLine("rbi", 0.5)).toBe(true);
    expect(isMainLine("hrr", 1.5)).toBe(true);
    expect(isMainLine("hits", 0.5)).toBe(true);
    expect(isMainLine("hits", 1.5)).toBe(false);
    expect(isMainLine("ks", 4.5)).toBe(true);
    expect(isMainLine("ks", 5.5)).toBe(true);
    expect(isMainLine("ks", 2.5)).toBe(false);
  });

  it("treats an unknown market as having no main line", () => {
    expect(isMainLine("nrfi", 0.5)).toBe(false);
  });
});

describe("the trust gate", () => {
  // Load-bearing: ungated, tb O4.5 (never fitted, reports EV +1.00) took 49% of
  // the value board and dragged it to -11.4% ROI.
  it("drops every non-trusted row on all three boards", () => {
    const preds = [
      row({ name: "Trusted", edge: 0.01, modelProb: 0.4, line: 2.5, market: "tb", bookOdds: 200 }),
      row({ name: "Directional", edge: 0.99, modelProb: 0.99, line: 4.5, market: "tb", bookOdds: 300, trust: "directional" }),
    ];
    for (const k of GOLDEN_BOARD_KEYS) {
      expect(selectBoard(preds, k).every((p) => p.trust === "trusted")).toBe(true);
    }
    expect(selectBoard(preds, "value").map((p) => p.name)).toEqual(["Trusted"]);
  });
});

describe("odds guardrails", () => {
  it("excludes chalk below the floor and lottery above the ceiling", () => {
    const preds = [
      row({ name: "TooChalky", bookOdds: ODDS_FLOOR_LIKELY - 1, modelProb: 0.99 }),
      row({ name: "AtFloor", bookOdds: ODDS_FLOOR_LIKELY, modelProb: 0.98 }),
      row({ name: "AtCeil", bookOdds: ODDS_CEIL, modelProb: 0.97 }),
      row({ name: "TooLong", bookOdds: ODDS_CEIL + 1, modelProb: 0.96 }),
    ];
    expect(selectBoard(preds, "likely").map((p) => p.name)).toEqual(["AtFloor", "AtCeil"]);
  });

  it("uses the tighter -175 floor on the priced boards", () => {
    const preds = [
      row({ name: "Chalk", market: "tb", line: 1.5, bookOdds: ODDS_FLOOR_PRICED - 1, edge: 0.9 }),
      row({ name: "Fine", market: "tb", line: 1.5, bookOdds: ODDS_FLOOR_PRICED, edge: 0.1 }),
    ];
    expect(selectBoard(preds, "lines").map((p) => p.name)).toEqual(["Fine"]);
  });

  it("ignores rows with a missing or non-numeric price", () => {
    // Built literally — the `row()` helper's ?? defaults would fill a null price.
    const bare = { market: "hits", line: 0.5, modelProb: 0.6, edge: 0.05, ev: 0.05, trust: "trusted" };
    const preds = [
      { ...bare, name: "NoPrice", bookOdds: null },
      { ...bare, name: "NaNPrice", bookOdds: NaN },
      { ...bare, name: "MissingPrice" },
    ];
    expect(selectBoard(preds, "likely")).toEqual([]);
  });
});

describe("line scope partitions lines vs value", () => {
  const preds = [
    row({ name: "MainGuy", market: "tb", line: 1.5, bookOdds: 110, edge: 0.08 }),
    row({ name: "AltGuy", market: "tb", line: 2.5, bookOdds: 260, edge: 0.07 }),
  ];
  it("lines takes only main lines", () => {
    expect(selectBoard(preds, "lines").map((p) => p.name)).toEqual(["MainGuy"]);
  });
  it("value takes only alternates", () => {
    expect(selectBoard(preds, "value").map((p) => p.name)).toEqual(["AltGuy"]);
  });
  it("likely takes both", () => {
    expect(selectBoard(preds, "likely").map((p) => p.name).sort()).toEqual(["AltGuy", "MainGuy"]);
  });
  it("lines and value never return the same row", () => {
    const { lines, value } = selectAllBoards(preds);
    const k = (p) => `${p.name}|${p.market}|${p.line}`;
    const overlap = lines.map(k).filter((x) => value.map(k).includes(x));
    expect(overlap).toEqual([]);
  });
});

describe("sorting", () => {
  it("likely ranks by model probability, not edge", () => {
    const preds = [
      row({ name: "LowProbBigEdge", modelProb: 0.30, edge: 0.40, bookOdds: 250 }),
      row({ name: "HighProbNoEdge", modelProb: 0.80, edge: 0.01, bookOdds: -250 }),
    ];
    expect(selectBoard(preds, "likely").map((p) => p.name)).toEqual(["HighProbNoEdge", "LowProbBigEdge"]);
  });

  it("lines ranks by edge, not probability", () => {
    const preds = [
      row({ name: "BigEdge", market: "rbi", line: 0.5, modelProb: 0.35, edge: 0.20, bookOdds: 150 }),
      row({ name: "HighProb", market: "rbi", line: 0.5, modelProb: 0.70, edge: 0.02, bookOdds: -150 }),
    ];
    expect(selectBoard(preds, "lines").map((p) => p.name)).toEqual(["BigEdge", "HighProb"]);
  });

  it("breaks edge ties on model probability so snapshots are reproducible", () => {
    const preds = [
      row({ name: "TieLowProb", market: "rbi", line: 0.5, edge: 0.10, modelProb: 0.31, bookOdds: 150 }),
      row({ name: "TieHighProb", market: "rbi", line: 0.5, edge: 0.10, modelProb: 0.44, bookOdds: 150 }),
    ];
    expect(selectBoard(preds, "lines").map((p) => p.name)).toEqual(["TieHighProb", "TieLowProb"]);
    // and the reverse input order gives the identical ranking
    expect(selectBoard([...preds].reverse(), "lines").map((p) => p.name)).toEqual(["TieHighProb", "TieLowProb"]);
  });

  it("lines requires a strictly positive edge", () => {
    const preds = [
      row({ name: "Zero", market: "rbi", line: 0.5, edge: 0, bookOdds: 120 }),
      row({ name: "Neg", market: "rbi", line: 0.5, edge: -0.05, bookOdds: 120 }),
      row({ name: "Pos", market: "rbi", line: 0.5, edge: 0.001, bookOdds: 120 }),
    ];
    expect(selectBoard(preds, "lines").map((p) => p.name)).toEqual(["Pos"]);
  });
});

describe("dedupe and caps", () => {
  it("takes a player at most once per board", () => {
    const preds = [
      row({ name: "Judge", market: "hits", line: 0.5, modelProb: 0.75 }),
      row({ name: "Judge", market: "tb", line: 1.5, modelProb: 0.70 }),
      row({ name: "Soto", market: "hits", line: 0.5, modelProb: 0.65 }),
    ];
    const got = selectBoard(preds, "likely");
    expect(got.map((p) => p.name)).toEqual(["Judge", "Soto"]);
  });

  it("lets the same player appear on two different boards", () => {
    const preds = [
      row({ name: "Judge", market: "tb", line: 1.5, modelProb: 0.62, edge: 0.09, bookOdds: 110 }),
      row({ name: "Judge", market: "tb", line: 2.5, modelProb: 0.33, edge: 0.06, bookOdds: 270 }),
    ];
    const { lines, value } = selectAllBoards(preds);
    expect(lines.map((p) => p.line)).toEqual([1.5]);
    expect(value.map((p) => p.line)).toEqual([2.5]);
  });

  it("caps any one market+line at MARKET_LINE_CAP rows", () => {
    // 6 hrr O0.5 all with the top probabilities — without the cap they'd sweep.
    const preds = [
      ...Array.from({ length: 6 }, (_, i) =>
        row({ name: `HRR${i}`, market: "hrr", line: 0.5, modelProb: 0.90 - i * 0.01, bookOdds: -200 })),
      ...Array.from({ length: 6 }, (_, i) =>
        row({ name: `HIT${i}`, market: "hits", line: 0.5, modelProb: 0.70 - i * 0.01, bookOdds: -200 })),
    ];
    const got = selectBoard(preds, "likely");
    const hrrCount = got.filter((p) => p.market === "hrr").length;
    expect(hrrCount).toBe(MARKET_LINE_CAP);
    expect(got).toHaveLength(6); // 3 hrr + 3 hits
  });

  it("counts the cap per line, not per market", () => {
    const preds = [
      ...Array.from({ length: 4 }, (_, i) =>
        row({ name: `A${i}`, market: "ks", line: 4.5, modelProb: 0.8 - i * 0.01, bookOdds: -140 })),
      ...Array.from({ length: 4 }, (_, i) =>
        row({ name: `B${i}`, market: "ks", line: 5.5, modelProb: 0.7 - i * 0.01, bookOdds: -140 })),
    ];
    const got = selectBoard(preds, "likely");
    expect(got.filter((p) => p.line === 4.5)).toHaveLength(MARKET_LINE_CAP);
    expect(got.filter((p) => p.line === 5.5)).toHaveLength(MARKET_LINE_CAP);
  });
});

describe("output shape", () => {
  it("fills at most `limit` slots and tags board + 1-based rank", () => {
    const preds = Array.from({ length: 40 }, (_, i) =>
      row({ name: `P${i}`, market: i % 2 ? "hits" : "tb", line: i % 2 ? 0.5 : 1.5, modelProb: 0.9 - i * 0.01 }));
    const got = selectBoard(preds, "likely", 10);
    expect(got.length).toBeLessThanOrEqual(10);
    expect(got.map((p) => p.rank)).toEqual(got.map((_, i) => i + 1));
    expect(new Set(got.map((p) => p.board))).toEqual(new Set(["likely"]));
  });

  it("returns fewer than 10 rather than padding when supply is short", () => {
    expect(selectBoard([row({ name: "Only" })], "likely")).toHaveLength(1);
  });

  it("handles empty / missing / malformed input without throwing", () => {
    expect(selectBoard([], "likely")).toEqual([]);
    expect(selectBoard(null, "likely")).toEqual([]);
    expect(selectBoard(undefined, "likely")).toEqual([]);
    expect(selectBoard([null, undefined], "likely")).toEqual([]);
    expect(Object.keys(selectAllBoards([]))).toEqual(GOLDEN_BOARD_KEYS);
  });

  it("does not mutate the input rows", () => {
    const preds = [row({ name: "X" })];
    const snapshot = JSON.stringify(preds);
    selectAllBoards(preds);
    expect(JSON.stringify(preds)).toBe(snapshot);
  });
});

describe("unpriced markets (NRFI/YRFI)", () => {
  // NRFI is modelled and fully graded but never priced — The Odds API posts no
  // first-inning market. It is ranked on the probability board on the same
  // footing as everything else, and is arithmetically unrankable on the two
  // edge-sorted boards.
  const nrfi = (o = {}) => ({
    name: o.name ?? "SF @ TEX", market: "nrfi", line: 0.5,
    direction: o.direction ?? "over", modelProb: o.modelProb ?? 0.59,
    bookOdds: null, fairOdds: null, edge: null, ev: null, trust: "trusted",
  });

  it("ranks NRFI on the likely board despite having no price", () => {
    const got = selectBoard([nrfi()], "likely");
    expect(got).toHaveLength(1);
    expect(got[0].market).toBe("nrfi");
    expect(got[0].bookOdds).toBeNull();
  });

  it("keeps NRFI off both edge-sorted boards — edge is undefined without a book", () => {
    expect(selectBoard([nrfi()], "lines")).toEqual([]);
    expect(selectBoard([nrfi()], "value")).toEqual([]);
  });

  it("does not let NRFI jump the queue — it ranks strictly on probability", () => {
    const preds = [
      row({ name: "HighProb", modelProb: 0.75, bookOdds: -200 }),
      nrfi({ modelProb: 0.59 }),
      row({ name: "LowProb", market: "tb", line: 1.5, modelProb: 0.45, bookOdds: 120 }),
    ];
    expect(selectBoard(preds, "likely").map((p) => p.name)).toEqual(["HighProb", "SF @ TEX", "LowProb"]);
  });

  it("still enforces the trust gate on unpriced rows", () => {
    expect(selectBoard([{ ...nrfi(), trust: "directional" }], "likely")).toEqual([]);
  });

  it("requires a usable probability — a null-prob NRFI row is dropped", () => {
    expect(selectBoard([{ ...nrfi(), modelProb: null }], "likely")).toEqual([]);
  });

  it("does not exempt a PRICED market that happens to be missing its price", () => {
    // Only markets in UNPRICED_MARKETS bypass the guardrail; a hits row with a
    // null price is a data gap and must still be dropped.
    const bare = { name: "Ghost", market: "hits", line: 0.5, modelProb: 0.9, edge: 0.2, ev: 0.2, trust: "trusted", bookOdds: null };
    expect(selectBoard([bare], "likely")).toEqual([]);
  });
});

// ── The play line ────────────────────────────────────────────────────────────
// Ranks 1-3 of the likely board are the tier that gets bet; 4-10 stay on the
// board as tracked research. Defined on RANK, never on modelProb, so
// recalibrating the probability model cannot move it (CLAUDE.md: gates live in
// score space, never probability space).
describe("play line", () => {
  it("puts the likely board's play line at rank 3", () => {
    expect(PLAY_LIMIT_LIKELY).toBe(3);
    expect(boardPlayLimit("likely")).toBe(3);
    expect(isPlayPick("likely", 1)).toBe(true);
    expect(isPlayPick("likely", 3)).toBe(true);
    expect(isPlayPick("likely", 4)).toBe(false);
    expect(isPlayPick("likely", 10)).toBe(false);
  });

  // A board with no play line has NO plays — it must never fall back to "all of
  // them". lines has no stable rank cut and value is research-only; treating
  // null as 10 would silently promote both boards to fully played.
  it("returns no plays for a board with no play line", () => {
    for (const key of ["lines", "value"]) {
      expect(boardPlayLimit(key)).toBeNull();
      for (const rank of [1, 2, 3, 5, 10]) expect(isPlayPick(key, rank)).toBe(false);
    }
  });

  it("is false for an unknown board and for a non-numeric rank", () => {
    expect(isPlayPick("nope", 1)).toBe(false);
    expect(isPlayPick("likely", undefined)).toBe(false);
    expect(isPlayPick("likely", null)).toBe(false);
  });

  it("stamps play onto selected rows so the tier is a fact of the record", () => {
    const preds = Array.from({ length: 10 }, (_, i) => ({
      name: `P${i}`, market: "hrr", line: [0.5, 1.5, 2.5, 3.5][i % 4],
      modelProb: 0.9 - i * 0.01, edge: 0.05, ev: 0.05, trust: "trusted", bookOdds: -200,
    }));
    const board = selectBoard(preds, "likely", 10);
    expect(board.length).toBeGreaterThanOrEqual(4);
    for (const p of board) expect(p.play).toBe(p.rank <= 3);
  });

  it("marks nothing as a play on the boards with no line", () => {
    const preds = Array.from({ length: 6 }, (_, i) => ({
      name: `Q${i}`, market: "tb", line: 1.5,
      modelProb: 0.6, edge: 0.2 - i * 0.01, ev: 0.1, trust: "trusted", bookOdds: -150,
    }));
    for (const p of selectBoard(preds, "lines", 10)) expect(p.play).toBe(false);
  });
});
