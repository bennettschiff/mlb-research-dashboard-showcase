// Parlay construction for the Brain Trust tab.
//
// A parlay multiplies your edge AND your vig. So legs are admitted ONLY from backtest-trusted,
// edge-positive lines, and a slip ships ONLY if its COMBINED model probability beats the combined
// book price (positive parlay EV). Cross-game legs are treated as independent (joint = product);
// SAME-game legs are positively correlated and the book prices regular parlays as independent, so
// we DROP same-game combos rather than overstate or guess the correlation. Pure + testable; the
// UI passes in already-graded legs and renders the result.

const decimal = a => (a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a));
const toAmerican = d => (d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)));

function* combinations(arr, k, start = 0, acc = []) {
  if (acc.length === k) { yield acc.slice(); return; }
  for (let i = start; i <= arr.length - (k - acc.length); i++) {
    acc.push(arr[i]);
    yield* combinations(arr, k, i + 1, acc);
    acc.pop();
  }
}

/**
 * Build 2–3 leg parlays from graded legs.
 * leg: { id, player, gamePk, market, line, modelProb, bookOdds, trust }
 * opts:
 *   minLegs/maxLegs        slip size bounds (default 2..3)
 *   minEv                  combined-EV floor (default +0.05). Set to -1 to disable (Safe mode).
 *   minJointProb           combined hit-probability floor (default 0). Used by Safe mode.
 *   requireTrusted         only backtest-trusted lines (default true)
 *   minLegProb/maxLegProb  per-leg sanity band (default 0.45..0.97)
 *   rankBy                 'ev' (Value) or 'jointProb' (Safe). Drives both the per-player-market
 *                          line choice AND the final sort.
 *   minCombinedDecimal     combined-odds floor (default 1 = none). Safe sets ~2.0 so a "safe" slip
 *                          still pays plus-money — excludes the -900 stacks of juiced favorites.
 *   haircut                shrink each leg's prob toward the book-implied prob by this fraction
 *                          (0 = raw model, 1 = full market) BEFORE combining. Discounts tail-
 *                          overconfidence: a slip selected for max edge concentrates the model's
 *                          biggest disagreements, exactly where it over-reaches. Slip math
 *                          (jointProb/ev/edge) uses the hedged prob; each leg carries probUsed.
 *   maxResults             cap returned slips (default 12)
 *
 * Two intended presets:
 *   VALUE: { rankBy:'ev', minEv:0.05, minLegProb:0.45 }                  — beat the price, higher odds
 *   SAFE:  { rankBy:'jointProb', minEv:-1, minLegProb:0.55,              — most likely to HIT, still
 *            minJointProb:0.33, minCombinedDecimal:2.0 }                   plus-money; EV shown not gated
 */
export function buildParlays(legs, {
  minLegs = 2, maxLegs = 3, minEv = 0.05, minJointProb = 0, requireTrusted = true,
  minLegProb = 0.45, maxLegProb = 0.97, rankBy = 'ev', minCombinedDecimal = 1, haircut = 0, maxResults = 12,
} = {}) {
  // Effective (hedged) leg probability used for all slip math; raw model prob stays on the leg.
  const pEff = l => { const p = l.modelProb, mkt = 1 / decimal(l.bookOdds); return p + haircut * (mkt - p); };
  const eligible = (legs || []).filter(l =>
    l && Number.isFinite(l.modelProb) && Number.isFinite(l.bookOdds) &&
    l.modelProb >= minLegProb && l.modelProb <= maxLegProb &&
    (!requireTrusted || l.trust === 'trusted')
  );
  // Score a leg by the active objective so dedup and sort agree: Value→EV, Safe→hit probability.
  const legScore = l => (rankBy === 'jointProb' ? l.modelProb : l.modelProb * decimal(l.bookOdds) - 1);
  // One leg per (player, market): keep the best line by the active objective so a slip never
  // stacks two lines of the same player-market (perfectly correlated, double-counts one read).
  const best = new Map();
  for (const l of eligible) {
    const key = `${l.player}|${l.market}`;
    const s = legScore(l);
    const prev = best.get(key);
    if (!prev || s > prev._score) best.set(key, { ...l, _score: s });
  }
  const pool = [...best.values()];

  const slips = [];
  for (let k = Math.max(2, minLegs); k <= maxLegs; k++) {
    if (pool.length < k) break;
    for (const combo of combinations(pool, k)) {
      // independence guard: every leg from a distinct game
      const games = new Set(combo.map(l => l.gamePk));
      if (games.size !== combo.length) continue;
      const jointProb = combo.reduce((p, l) => p * pEff(l), 1);     // hedged joint
      const jointProbRaw = combo.reduce((p, l) => p * l.modelProb, 1);
      const combDecimal = combo.reduce((d, l) => d * decimal(l.bookOdds), 1);
      const ev = jointProb * combDecimal - 1;
      if (ev < minEv) continue;
      if (jointProb < minJointProb) continue;
      if (combDecimal < minCombinedDecimal) continue;
      const bookImplied = 1 / combDecimal;
      slips.push({
        legs: combo.map(l => ({ ...l, probUsed: pEff(l) })),
        legCount: k,
        jointProb,
        jointProbRaw,
        combinedDecimal: combDecimal,
        combinedAmerican: toAmerican(combDecimal),
        bookImpliedProb: bookImplied,
        edge: jointProb - bookImplied,
        ev,
      });
    }
  }
  slips.sort((a, b) => (rankBy === 'jointProb' ? b.jointProb - a.jointProb : b.ev - a.ev));
  return slips.slice(0, maxResults);
}

export const _internal = { decimal, toAmerican, combinations };
