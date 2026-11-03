// Lab core — the shared evaluation substrate for the lab loop.
//
// Extracted from lab-analyst.mjs (2026-07-20) so the PROMOTION GATE scores a
// config with byte-identical semantics to the analyst that validated it. When
// the two diverged (they would have, as duplicated code), a proposal could
// validate under one interpretation of the sheet's Tuner rules and ship under
// another — the silent-gate-bug class this project keeps getting bitten by.
//
// Everything here is pure: no CLI parsing, no fs, no top-level side effects.
// `qualifies` + `plRow` mirror Fragments.qbase_mkt + globals_rest in
// build-lab-workbook.py — the Google Sheets workbook is the spec.

export const num = (v) => (v === "" || v == null ? null : Number(v));
export const N = (v) => (v == null ? 0 : v); // sheet N("") = 0 semantics

// Per-market stake for the lab's weighted units. Kept byte-identical to
// MARKET_UNITS in src/lib/picks.js (guarded by a test there); see the comment at
// the stake line in SPORTS.mlb.defaults for why it is duplicated rather than
// imported. 2026-08-27: hits 2 → 1 and sb 0.5 → 1, re-basing the schedule from
// typical price onto measured edge.
export const LAB_MARKET_STAKE = { hr: 0.5 };
export const clone = (o) => JSON.parse(JSON.stringify(o));

// A row scored by a formula still in production. "pre-tagging" rows (the
// 2026-03-25..06-01 pre-save-gate dump, graded before per-run model_version
// tagging existed) sit on a since-replaced score/conf scale, much wider than
// anything the live model produces (e.g. MLB hits: pre-tagging 0.245-0.489 vs
// the live floor ~0.349). `date_start` alone doesn't catch them — pre-tagging
// rows run through 2026-06-01, well past the 2026-04-05 default. A diagnostic
// that draws candidate thresholds from them (lab-analyst.mjs's sweep grid) can
// propose a threshold below the live floor that scores a strong train+test
// delta while actually dropping the whole market — a kill switch dressed as a
// validated gate, not a gate. Exported so the exclusion is a single tested
// primitive rather than a filter reimplemented (and potentially missed) at
// each call site.
export const isLiveModelRow = (r) => r.version !== "pre-tagging";

export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQ = false;
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift();
  return rows
    .filter((r) => r.length === header.length)
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

export const SPORTS = {
  mlb: {
    adapt: (r) => ({
      id: r.pick_id ?? null, player: r.player_name ?? null, line: num(r.line),
      date: r.pick_date, market: r.prop_type, dir: r.direction,
      score: num(r.model_score), prob: num(r.model_prob), conf: num(r.conf),
      used: num(r.used_odds), implied: num(r.implied_prob),
      profit: num(r.win_profit_per_unit), clv: num(r.clv_pct),
      win: num(r.is_win), push: num(r.is_push), graded: num(r.is_graded),
      version: r.model_version,
    }),
    markets: ["hits", "hits15", "hr", "hrr", "ks", "ml", "ou", "rbi", "rl", "sb", "tb"],
    defaults: () => ({
      // 2026-04-05, NOT the season opener. The 1,725 graded rows dated
      // 2026-03-25 → 04-03 are a pre-save-gate bulk scan dump — 216 picks/day
      // against ~38 now — and every one of them has an empty `conf`.
      //
      // That combination is a proposal generator. N("") is 0 (sheet semantics,
      // see N above), so `conf` reads as 0 on all 1,725 rows and ANY conf_min or
      // score_min above 0 deletes the entire block. The gate then books the
      // block's whole loss as its own train-side lift without touching a single
      // pick anyone would bet. It is a date filter wearing a gate costume, and
      // it is the mechanical reason the ledger accumulated 38 validated
      // proposals of which 2 ever survived promotion.
      //
      // Starting the default window after the dump makes a `*_min` gate earn its
      // lift on real picks. Sweeps that genuinely want the early block can still
      // set date_start explicitly.
      date_start: "2026-04-05", date_end: "2026-12-31",
      odds_min: -10000, odds_max: 10000, fallback_price: -110,
      // "realized" = only rows carrying a real bookmaker quote pay or stake anything.
      // "assumed"  = unpriced rows are priced at fallback_price (a SCENARIO).
      //
      // MLB defaults to realized as of 2026-09-08. It used to be unconditionally
      // "assumed", which is how the lab and the Results page came to disagree about
      // the same rows (Hits -21.06u here vs -56.42u there). Worse, the hypothetical
      // money was not neutral: across all graded picks, pricing the unpriced rows at
      // -110 moves HR by -98u and TB by -89u, so a market's whole verdict could turn
      // on wagers that were never available. Unpriced rows still count in n/w/l —
      // the model was right or wrong either way — they just cannot pay.
      //
      // WNBA stays "assumed" and must: it has no odds feed at all, every row is
      // unpriced by construction, and realized mode would zero the entire sport.
      price_mode: "realized",
      include_no_odds: 1, prob_shift: 1.0, edge_min_pp: -999, ev_min_pct: -999,
      dir_filter: "all",
      markets: Object.fromEntries(SPORTS.mlb.markets.map((m) => [m, {
        // Mirrors MARKET_UNITS in src/lib/picks.js — the lab has to size a pick
        // the way the tracker does or its units answer a different question than
        // the one the Results page asks. The two are separate literals because
        // picks.js drags in the whole model layer (models.js, marketHealth.js)
        // and this harness must stay Node-only; src/lib/picks.test.js asserts
        // they stay identical.
        include: 1, conf_min: -999, conf_max: 999, score_min: -999, score_max: 999,
        stake: LAB_MARKET_STAKE[m] ?? 1,
      }])),
    }),
    qualifies: (r, c) => {
      if (!r.graded || r.date < c.date_start || r.date > c.date_end) return false;
      if (c.dir_filter !== "all" && r.dir !== c.dir_filter) return false;
      const m = c.markets[r.market];
      if (!m || !m.include) return false;
      if (N(r.conf) < m.conf_min || N(r.conf) > m.conf_max) return false;
      if (N(r.score) < m.score_min || N(r.score) > m.score_max) return false;
      if (r.used != null) {
        if (r.used < c.odds_min || r.used > c.odds_max) return false;
      } else if (!c.include_no_odds) return false;
      const fbProfit = c.fallback_price > 0 ? c.fallback_price / 100 : 100 / -c.fallback_price;
      const profitEff = r.profit ?? fbProfit;
      if ((N(r.prob) * c.prob_shift - N(r.implied)) * 100 < c.edge_min_pp) return false;
      if ((N(r.prob) * c.prob_shift * (1 + profitEff) - 1) * 100 < c.ev_min_pct) return false;
      return true;
    },
    plRow: (r, c) => {
      // In realized mode an unpriced row pays nothing (and evalConfig keeps it out of
      // the ROI denominator). Only a real quote settles — see src/lib/settlement.js.
      if (r.profit == null && c.price_mode !== "assumed") return 0;
      const fbProfit = c.fallback_price > 0 ? c.fallback_price / 100 : 100 / -c.fallback_price;
      const profitEff = r.profit ?? fbProfit;
      return N(r.win) * profitEff - (1 - N(r.win) - N(r.push));
    },
    // Whether this row can be settled for money under the active price mode. Drives
    // the ROI denominator so hypothetical rows dilute nothing.
    isPriced: (r, c) => r.profit != null || c.price_mode === "assumed",
    gateParams: [
      { key: "conf_min", vec: "conf", kind: "floor", space: "score" },
      { key: "conf_max", vec: "conf", kind: "cap", space: "score" },
      { key: "score_min", vec: "score", kind: "floor", space: "score" },
      { key: "score_max", vec: "score", kind: "cap", space: "score" },
    ],
    probField: "prob",
    calib: { lo: 0, hi: 1, step: 0.05 },
  },

  wnba: {
    adapt: (r) => ({
      date: r.game_date, market: r.stat, dir: r.side,
      prob: num(r.prob_side), edge: num(r.proj_edge), sigma: num(r.sigma),
      gp: num(r.gp), win: num(r.is_win), push: num(r.is_push),
      graded: num(r.is_graded), version: r.model_version,
      used: null, profit: null,
    }),
    markets: ["ast", "fg3m", "pra", "pts", "reb", "sb"],
    defaults: () => ({
      date_start: "2026-06-25", date_end: "2026-12-31",
      // WNBA has no odds feed — every row is unpriced by construction, so the
      // fallback price is the only price there has ever been. See the MLB note.
      price_mode: "assumed",
      fallback_price: -110, gp_min: 0, sigma_max: 999, dir_filter: "all",
      markets: Object.fromEntries(SPORTS.wnba.markets.map((m) => [m, {
        include: 1, prob_min: 0, prob_max: 1, edge_min: -99, stake: 1,
      }])),
    }),
    qualifies: (r, c) => {
      if (!r.graded || r.date < c.date_start || r.date > c.date_end) return false;
      if (c.dir_filter !== "all" && r.dir !== c.dir_filter) return false;
      const m = c.markets[r.market];
      if (!m || !m.include) return false;
      if (N(r.prob) < m.prob_min || N(r.prob) > m.prob_max) return false;
      if (N(r.edge) < m.edge_min) return false;
      if (N(r.gp) < c.gp_min || N(r.sigma) > c.sigma_max) return false;
      return true;
    },
    plRow: (r, c) => {
      const fbProfit = c.fallback_price > 0 ? c.fallback_price / 100 : 100 / -c.fallback_price;
      return N(r.win) * fbProfit - (1 - N(r.win) - N(r.push));
    },
    // Every WNBA row is priced at the fallback, so all of them stake. Present so
    // evalConfig does not have to special-case a sport.
    isPriced: () => true,
    gateParams: [
      { key: "prob_min", vec: "prob", kind: "floor", space: "prob" },
      { key: "prob_max", vec: "prob", kind: "cap", space: "prob" },
      { key: "edge_min", vec: "edge", kind: "floor", space: "score" },
    ],
    probField: "prob",
    calib: { lo: 0.3, hi: 1, step: 0.05 },
  },
};

export function evalConfig(S, rows, cfg) {
  let n = 0, w = 0, l = 0, p = 0, units = 0, unitsStaked = 0, stakeSum = 0;
  let nPriced = 0, nUnpriced = 0;
  for (const r of rows) {
    if (!S.qualifies(r, cfg)) continue;
    n++;
    if (r.push) p++;
    else if (r.win) w++;
    else l++;
    // A row with no obtainable price counts as a prediction but not as a wager: it
    // pays nothing and, crucially, stakes nothing. Leaving it in the denominator
    // would drag every ROI toward zero with money that was never at risk — the
    // mirror of the -110 fabrication that inflated August NRFI by +29.2u.
    const priced = S.isPriced ? S.isPriced(r, cfg) : true;
    if (!priced) { nUnpriced++; continue; }
    nPriced++;
    const pl = S.plRow(r, cfg);
    const stake = cfg.markets[r.market]?.stake ?? 1;
    units += pl;
    unitsStaked += pl * stake;
    stakeSum += stake;
  }
  return {
    n, w, l, p,
    winRate: w + l ? +(w / (w + l)).toFixed(4) : null,
    units: +units.toFixed(2),
    // ROI is per BETTABLE row, not per qualified row.
    roi: nPriced ? +(units / nPriced).toFixed(4) : null,
    unitsStaked: +unitsStaked.toFixed(2),
    roiStaked: stakeSum ? +(unitsStaked / stakeSum).toFixed(4) : null,
    // Surfaced so a result built mostly on unpriced rows can be recognised as one:
    // a high nUnpriced means the win rate is real and the ROI describes only the
    // bettable remainder.
    nPriced, nUnpriced,
  };
}

// ── gate composition + same-cut detection ─────────────────────────────────────
// Lives here rather than in promotion-gate.mjs for the reason the file header
// gives: this is evaluation semantics, and the analyst and the gate must never
// hold two versions of it. Pure — callers pass S, the sport defaults, and rows.

// base + one {market, param, value} patch. The unit a promoted gate ships as.
export function stackConfig(base, ch) {
  const cfg = clone(base);
  cfg.markets[ch.market] = { ...(cfg.markets[ch.market] || {}), [ch.param]: ch.value };
  return cfg;
}

// Sport defaults with every currently-promoted override applied — the real
// incumbent. Scoring a proposal against bare defaults instead of this is what
// let two overlapping hr caps each report a clean win in 2026-08-03's run.
export function liveConfig(dflt, overrides, enforceable) {
  const cfg = clone(dflt);
  for (const [market, o] of Object.entries(overrides || {})) {
    if (!cfg.markets[market]) continue;
    for (const [param, value] of Object.entries(o)) {
      if (enforceable[param]) cfg.markets[market][param] = value;
    }
  }
  return cfg;
}

// STABLE PICK IDENTITY.
//
// This used to be `date|market|dir|score|conf|prob` because the feed carried no id.
// Those fields do NOT identify a pick: two players can share a market, a direction and
// a rounded score/conf/prob on the same slate, and when they do the two rows collapse
// into one. Measured on the supported markets after April 5: 121 collision groups
// swallowing 253 distinct rows. Every consumer of this key is a SET operation —
// cutOf's cut membership, cutOverlap's Jaccard, the duplicate-gate detection that
// stops two gates shipping the same cut — so a collision quietly understates how much
// two gates overlap, which is the exact direction that lets a redundant gate ship.
//
// The feed now emits pick_id (mlb_picks.id). The composite is kept as a fallback for
// rows predating that column, widened with player and line so it collides far less.
export const rowKey = (r) =>
  r.id != null
    ? `id:${r.id}`
    : `${r.date}|${r.market}|${r.dir}|${r.player ?? ""}|${r.line ?? ""}|${r.score}|${r.conf}|${r.prob}`;

// Which markets a config actually changes, relative to the defaults. `stake` is
// excluded for the same reason diffConfig excludes it: it is sizing, not a lever.
//
// This is what a proposal is ABOUT, and it is the population its verdict has to be
// earned on. forwardValidate used to mature a proposal on the ALL-MARKET out-of-sample
// count, so an hr cap could be called after two days on 60 rows of which none were hr.
export function changedMarkets(cfg, dflt) {
  const out = new Set();
  for (const [m, params] of Object.entries(cfg.markets || {})) {
    for (const [p, v] of Object.entries(params)) {
      if (p === "stake") continue;
      if (JSON.stringify(v) !== JSON.stringify(dflt.markets?.[m]?.[p])) out.add(m);
    }
  }
  return [...out];
}

/** A copy of `cfg` with every market outside `markets` excluded. */
export function restrictToMarkets(cfg, markets) {
  const out = clone(cfg);
  const keep = new Set(markets);
  for (const m of Object.keys(out.markets || {})) {
    if (!keep.has(m)) out.markets[m].include = 0;
  }
  return out;
}

/** Rows `base` keeps that `cfg` rejects — the population a proposal's delta comes from. */
export function affectedRows(S, rows, base, cfg) {
  return rows.filter((r) => S.qualifies(r, base) && !S.qualifies(r, cfg));
}

// The rows `base` keeps and `base + ch` rejects: one gate's own cut, isolated
// from every other gate.
export function cutOf(S, rows, base, ch) {
  const withCh = stackConfig(base, ch);
  const out = new Set();
  for (const r of rows) {
    if (r.market !== ch.market) continue;
    if (S.qualifies(r, base) && !S.qualifies(r, withCh)) out.add(rowKey(r));
  }
  return out;
}

export const cutSide = (param) =>
  param.endsWith("_max") ? "max" : param.endsWith("_min") ? "min" : null;

// How much two same-side gates on one market overlap, measured on `rows`.
// Returns null when the pair isn't comparable (different market, same param,
// opposite sides, or too thin a sample to mean anything).
//   { overlap, subsumes, aCut, bCut, extra }
//     overlap  — Jaccard of the two cuts
//     subsumes — every pick `ch` cuts is already cut by `other`: it adds nothing
export function cutOverlap(S, dflt, rows, ch, other, { minSample = 5 } = {}) {
  if (other.market !== ch.market) return null;
  if (other.param === ch.param) return null;
  if (cutSide(ch.param) !== cutSide(other.param)) return null;
  const A = cutOf(S, rows, dflt, ch);
  const B = cutOf(S, rows, dflt, other);
  const union = new Set([...A, ...B]).size;
  if (!A.size || !B.size || union < minSample) return null;
  const inter = [...A].filter((k) => B.has(k)).length;
  return {
    overlap: inter / union,
    subsumes: inter === A.size,
    aCut: A.size,
    bCut: B.size,
    extra: A.size - inter,
  };
}

export const configHash = (cfg) => {
  // stable stringify (sorted keys) → short hash
  const stable = (v) => Array.isArray(v) ? v.map(stable)
    : v && typeof v === "object"
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])]))
      : v;
  const s = JSON.stringify(stable(cfg));
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
};

export function deepMerge(base, patch) {
  const out = clone(base);
  for (const [k, v] of Object.entries(patch || {})) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object"
      ? deepMerge(out[k], v)
      : v;
  }
  return out;
}

export function validatePartialConfig(partial, dflt) {
  const known = new Set(Object.keys(dflt));
  for (const k of Object.keys(partial)) {
    if (!known.has(k)) throw new Error(`Unknown config key "${k}" (known: ${[...known].join(", ")})`);
  }
  for (const [m, params] of Object.entries(partial.markets || {})) {
    if (!dflt.markets[m]) throw new Error(`Unknown market "${m}" (known: ${Object.keys(dflt.markets).join(", ")})`);
    for (const p of Object.keys(params)) {
      if (!(p in dflt.markets[m])) throw new Error(`Unknown market param "${p}" for ${m} (known: ${Object.keys(dflt.markets[m]).join(", ")})`);
    }
  }
}

export function trainTestSplit(graded) {
  const dates = [...new Set(graded.map((r) => r.date))].sort();
  const cut = dates[Math.max(0, Math.floor(dates.length * 0.7) - 1)];
  return { cut, train: graded.filter((r) => r.date <= cut), test: graded.filter((r) => r.date > cut) };
}

export function scoreConfig(S, graded, cfg, dflt) {
  const { cut, train, test } = trainTestSplit(graded);
  const res = {};
  for (const [name, slice] of [["all", graded], ["train", train], ["test", test]]) {
    const base = evalConfig(S, slice, dflt), prop = evalConfig(S, slice, cfg);
    res[name] = { proposal: prop, incumbent: base, delta_units: +(prop.units - base.units).toFixed(2) };
  }
  res.train_through = cut;
  return res;
}

// ── ledger io ────────────────────────────────────────────────────────────────

export function readJsonl(p, fs) {
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

export function writeJsonl(p, entries, fs, path) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

// ── cross-process file locking ────────────────────────────────────────────────
// Several independent scheduled routines (lab-analyst.mjs's own cron run, the
// lab-analyst-mlb Claude panel's --file-proposal calls, lab-tuner-mlb's) read-
// modify-write the SAME ledger.jsonl/shadow.jsonl in the SAME working directory.
// Their nominal schedules don't overlap, but dispatch delays in this environment
// are unbounded in practice (observed 2026-08-03: a 4:35 AM ET routine and a
// 5:40 AM ET routine both actually landing around 08:00 the same morning) — so
// two overlapping read-whole-file -> mutate -> write-whole-file cycles can
// interleave and silently drop whichever wrote first (lost update).
// withFileLock serializes a whole read+mutate+write span across processes using
// an atomic directory-create as the lock — portable, no extra dependency, and
// mkdir is atomic on every filesystem this project runs on.
export async function withFileLock(lockDir, fn, fs, path, opts = {}) {
  const { timeoutMs = 60000, staleMs = 5 * 60000, pollMs = 150 } = opts;
  const start = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      let age = 0;
      try { age = Date.now() - fs.statSync(lockDir).mtimeMs; } catch { /* released between our EEXIST and this stat */ }
      if (age > staleMs) {
        // Almost certainly a crashed/killed process's lock, not a live holder —
        // reclaim it rather than wedge the pipeline forever.
        try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch { /* lost the race to reclaim; loop and retry */ }
        continue;
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error(`withFileLock: ${lockDir} still held after ${timeoutMs}ms — another run may be stuck`);
      }
      await new Promise((r) => setTimeout(r, pollMs));
      continue;
    }
  }
  try {
    fs.writeFileSync(path.join(lockDir, "owner"), `pid=${process.pid} ${new Date().toISOString()}\n`);
  } catch { /* best-effort debugging aid only */ }
  try {
    return await fn();
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}
