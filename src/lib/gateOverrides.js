// ══════════════════════════════════════════════════════════════════════════
// Promoted lab gates — the bridge from lab/<sport>/ledger.jsonl to live picks.
//
// WHY THIS EXISTS (2026-07-20): the lab loop had been validating proposals for
// weeks and shipping none of them. Two reasons. (1) Nobody had wired a
// promotion step. (2) More subtly: the lab's config space is WIDER than
// picks.js. `conf_min` maps onto BOARD_CONFIGS.pickThresh, but `conf_max` and
// `score_max` — CAPS — had no live analog at all, and caps were 8 of the first
// 14 validated proposals. They came from a real, repeated finding: on several
// markets the most-confident picks underperform the middle of the distribution
// (HR top-conf −66% ROI vs bottom +9%; the same "priced-in top" shape later
// showed up in tb/hits/hrr/ks). Without a cap layer that finding was
// unshippable, so it just kept getting re-derived.
//
// ── HARD RULES ──
//
// 1. OVERRIDES GATE PICKS, NEVER BOARDS. These are consulted by isOfficialPick
//    ONLY. isBoardActionable is untouched, so every market keeps surfacing its
//    full research board no matter what is promoted here. A capped pick still
//    appears — it just doesn't get the 🎲 and doesn't get saved to Results.
//    This is a standing user constraint: never make a market go dark.
//
// 2. SCORE SPACE ONLY. Same rule as the rest of picks.js (CLAUDE.md): a gate
//    written in probability space silently retunes when modelImpliedProb is
//    recalibrated — that is what caused the HRR 0-pick drought. The promotion
//    gate refuses to graduate a prob-space proposal that has no score-space
//    twin, so nothing prob-space should ever reach this file. The runtime
//    guard below enforces it a second time anyway.
//
// 3. GENERATED, NOT AUTHORED. scripts/promotion-gate.mjs writes the JSON.
//    Hand-edits get clobbered. To remove a gate, run the gate with --revert so
//    the removal is recorded in docs/GATE_CHANGELOG.md.
// ══════════════════════════════════════════════════════════════════════════

// The import attribute is required: Vite bundles JSON for the browser without
// it, but api/picks.js pulls this in as raw Node ESM, which hard-fails the
// module load without it (FUNCTION_INVOCATION_FAILED on every /api/picks).
import OVERRIDES from './gateOverrides.json' with { type: 'json' };

// Params this layer knows how to enforce. Anything else in the JSON is data
// for the changelog/report and is deliberately inert at runtime — a config key
// the lab can express but picks.js cannot honor must NOT silently do nothing
// under a name that looks like it works.
const ENFORCEABLE = new Set(['conf_min', 'conf_max', 'score_min', 'score_max']);

export function getGateOverride(boardKey, sport = 'mlb') {
  return OVERRIDES?.[sport]?.[boardKey] ?? null;
}

// True if this pick clears the promoted lab gates for its market.
// `score` is the model's scoring score (result.adjScore ?? result.score) —
// the same λ the lab's score_min/score_max range over.
export function passesGateOverrides(boardKey, conf, score, sport = 'mlb') {
  const o = getGateOverride(boardKey, sport);
  if (!o) return true;
  if (conf != null) {
    if (o.conf_min != null && conf < o.conf_min) return false;
    if (o.conf_max != null && conf > o.conf_max) return false;
  }
  if (score != null) {
    if (o.score_min != null && score < o.score_min) return false;
    if (o.score_max != null && score > o.score_max) return false;
  }
  return true;
}

// Introspection for the UI + tests: which markets currently carry a promoted
// gate, and what does it do. Surfaced so a capped-out pick can explain itself
// on the board rather than just quietly losing its dice.
export function activeOverrides(sport = 'mlb') {
  const out = [];
  for (const [market, o] of Object.entries(OVERRIDES?.[sport] ?? {})) {
    const params = Object.entries(o).filter(([k]) => ENFORCEABLE.has(k));
    if (params.length) out.push({ market, params: Object.fromEntries(params), meta: o });
  }
  return out;
}

export const OVERRIDES_VERSION = OVERRIDES?.version ?? null;
