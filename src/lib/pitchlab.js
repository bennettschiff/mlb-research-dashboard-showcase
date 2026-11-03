/**
 * src/lib/pitchlab.js — runtime for the Pitch Lab models (post-mortems 02–04).
 *
 * The models run in Python each in-season morning (scripts/pitchlab/score.py, workflow
 * pitchlab.yml) on 2.1M raw pitches the browser never sees, and publish one row per slate
 * date to Supabase `pitchlab_predictions` (db/migrations/019), read via
 * /api/picks?view=pitchlab&date=YYYY-MM-DD. This module is the pure math that turns that
 * payload into board rows. It never reimplements a model.
 *
 * Distributions arrive as LADDERS: ge[k] = P(stat ≥ k). `ge` is calibrated (display,
 * model_prob); `ge_raw` is the uncalibrated model score. Official-pick gates read ge_raw
 * against the raw cut stored with the models (meta.gates), so a recalibration can never
 * silently tighten a gate (CLAUDE.md: gates live in score space).
 */

// Odds API market keys for the four pitcher props the app did not model before 2026-10.
export const PITCHER_PROPS = {
  outs:         { key: "outs", label: "Outs",          std: "pitcher_outs",          alt: null,                               stat: "outs" },
  hits_allowed: { key: "h",    label: "Hits allowed",  std: "pitcher_hits_allowed",  alt: "pitcher_hits_allowed_alternate",   stat: "hits" },
  walks:        { key: "bb",   label: "Walks",         std: "pitcher_walks",         alt: "pitcher_walks_alternate",          stat: "baseOnBalls" },
  er:           { key: "er",   label: "Earned runs",   std: "pitcher_earned_runs",   alt: "pitcher_earned_runs_alternate",    stat: "earnedRuns" },
};

const clamp01 = (p) => Math.min(1, Math.max(0, p));

/** P(stat ≥ k) from a ladder; k past the end is the last rung's tail (0 if beyond). */
function geAt(ge, k) {
  if (!Array.isArray(ge) || !ge.length) return null;
  if (k <= 0) return 1;
  return k < ge.length ? ge[k] : 0;
}

/**
 * Over / under probabilities at a book line. A half line (4.5) never pushes: over = P(≥5).
 * A whole line (5) can push: over = P(≥6), under = P(≤4), push = P(=5), and the two
 * sides are reported conditional on no push (that is how the wager settles).
 */
export function sideProbs(ge, line) {
  if (ge == null || line == null || !Number.isFinite(line)) return null;
  if (Number.isInteger(line)) {
    const over = geAt(ge, line + 1), atLeast = geAt(ge, line);
    if (over == null || atLeast == null) return null;
    const under = 1 - atLeast, push = atLeast - over;
    const live = over + under;
    if (live <= 0) return null;
    return { over: clamp01(over / live), under: clamp01(under / live), push: clamp01(push) };
  }
  const over = geAt(ge, Math.ceil(line));
  if (over == null) return null;
  return { over: clamp01(over), under: clamp01(1 - over), push: 0 };
}

/** Line nearest the distribution's median (k − 0.5 where P(≥k) is closest to ½) — the fallback display line. */
export function medianLine(ge) {
  if (!Array.isArray(ge) || ge.length < 2) return null;
  let best = 1;
  for (let k = 1; k < ge.length; k++) if (Math.abs(ge[k] - 0.5) < Math.abs(ge[best] - 0.5)) best = k;
  return best - 0.5;
}

/**
 * One pitcher-prop call against a line.
 * @param dist  { ge, ge_raw } from the payload
 * @param line  the book line (or null → medianLine, display only)
 * @param gate  raw-confidence cut from payload.gates[key]
 * @param hasBookLine  official picks need a real book line
 * @returns { line, side, prob, probOver, rawConf, official } or null
 */
export function pitcherPropCall(dist, line, gate, hasBookLine) {
  if (!dist?.ge) return null;
  const L = line ?? medianLine(dist.ge);
  const cal = sideProbs(dist.ge, L);
  const raw = sideProbs(dist.ge_raw ?? dist.ge, L);
  if (!cal || !raw) return null;
  const side = raw.over >= raw.under ? "over" : "under";
  const rawConf = Math.max(raw.over, raw.under);
  return {
    line: L,
    side,
    prob: side === "over" ? cal.over : cal.under,
    probOver: cal.over,
    rawConf,
    official: !!hasBookLine && gate != null && rawConf >= gate,
  };
}

/** Expected value of the ladder (Σ P(X ≥ k), k ≥ 1). */
export function ladderMean(ge) {
  if (!Array.isArray(ge)) return null;
  let s = 0;
  for (let k = 1; k < ge.length; k++) s += ge[k];
  return s;
}

/** Fetch one date's payload through the picks proxy; null when the morning job has not run. */
export async function loadPitchlab(date, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`/api/picks?view=pitchlab&date=${encodeURIComponent(date)}`);
    if (!res.ok) return null;
    const row = await res.json();
    return row?.payload ?? null;
  } catch {
    return null;
  }
}
