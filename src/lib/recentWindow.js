/**
 * recentWindow.js — "last N games" Statcast metrics for one batter, and where they sit on
 * the league's season distribution.
 *
 * WHY THIS EXISTS. Every Savant leaderboard the app reads is season-only — they accept date
 * parameters and ignore them. statcast_search/csv honours game_date_gt/lt, so a window is
 * reachable only by tallying pitch-level rows ourselves. This module is that tally plus the
 * placement math; the fetch lives in App.jsx and the drawing in components/StatcastCard.jsx.
 *
 * WHAT IT DELIBERATELY DOES NOT COMPUTE. Only metrics whose pitch-level definition is
 * IDENTICAL to the leaderboard's. xwOBA/xBA/xSLG are excluded: Savant computes them per PA
 * (strikeouts contribute zero, walks carry the wOBA weight), while the pitch feed gives
 * per-batted-ball estimates. Averaging those would produce a number that differs from the
 * season figure for definitional reasons and then get displayed as if the gap were form.
 *
 * NOISE. scripts/recent-form-lift.mjs measured SD(Δ)/SD(season) per metric over 10,347
 * batter-days — how far a 15-game window swings relative to real spread between players. A
 * ratio near or above 1 means the window is mostly sampling noise. Those ratios are the
 * NOISE_RATIO table below, and they gate how (or whether) the window is drawn. The same
 * script found the window adds NO predictive lift over season-to-date at any length tested
 * (7/15/30 games, ΔAUC −0.003 to −0.011 walk-forward), which is why season stays the
 * primary number here and the window is strictly secondary context.
 */

/** Metrics a window can carry, with the denominator that governs each one's noise. */
export const WINDOW_METRICS = {
  exitVelo:    { den: 'bbe',        floor: 15, label: 'Exit Velocity' },
  barrelPct:   { den: 'bbe',        floor: 15, label: 'Barrel%' },
  hardHitPct:  { den: 'bbe',        floor: 15, label: 'Hard Hit%' },
  bbPct:       { den: 'pa',         floor: 30, label: 'BB%' },
  kPct:        { den: 'pa',         floor: 30, label: 'K%' },
  whiffPct:    { den: 'swings',     floor: 40, label: 'Whiff%' },
  chasePct:    { den: 'ozPitches',  floor: 40, label: 'Chase%' },
  batSpeed:    { den: 'swings',     floor: 40, label: 'Bat Speed' },
  swingLength: { den: 'swings',     floor: 40, label: 'Swing Length' },
};

/**
 * Measured SD(Δ)/SD(season) at a 15-game window over 18,475 batter-days — see
 * scripts/recent-form-lift.mjs. No tier boundary is close enough to a listed value for a
 * later re-measurement to flip a row silently.
 */
export const NOISE_RATIO = {
  swingLength: 0.27,
  batSpeed:    0.33,
  whiffPct:    0.61,
  chasePct:    0.69,
  exitVelo:    0.77,
  kPct:        0.82,
  hardHitPct:  0.86,
  barrelPct:   0.95,
  bbPct:       1.15,
};

/**
 * How a window value may be drawn.
 *   stable   — swings much less than real between-player spread; show it plainly
 *   marginal — comparable to real spread; show it dimmed, the reader should discount it
 *   thin     — not enough denominator to be a measurement at all; show the value, no marker
 */
export function noiseTier(metric, counts) {
  const spec = WINDOW_METRICS[metric];
  if (!spec) return 'thin';
  const n = counts?.[spec.den] ?? 0;
  if (n < spec.floor) return 'thin';
  const r = NOISE_RATIO[metric];
  if (r == null) return 'marginal';
  return r < 0.75 ? 'stable' : r < 1.25 ? 'marginal' : 'thin';
}

// Savant's own swing set. foul_tip and foul_bunt are contact (the bat touched it), so they
// are swings but not whiffs; missed_bunt is both.
const SWING = new Set(['swinging_strike', 'swinging_strike_blocked', 'foul', 'foul_tip',
                       'foul_bunt', 'missed_bunt', 'hit_into_play', 'bunt_foul_tip']);
const WHIFF = new Set(['swinging_strike', 'swinging_strike_blocked', 'missed_bunt']);

/**
 * The additive fields of a tallyPitchRows result. Day tallies are summed field-wise to
 * build any window, so this list IS the contract between the nightly cache
 * (scripts/batter-window-refresh.mjs) and the fold below. firstDate/lastDate are excluded
 * deliberately — they are bookends, not counts, and are recomputed by the fold.
 */
export const TALLY_SUM_FIELDS = [
  'games', 'pitches', 'pa', 'k', 'bb', 'swings', 'whiffs', 'ozPitches', 'ozSwings',
  'bbe', 'evSum', 'hardHit', 'barrels', 'bsSum', 'bsN', 'slSum', 'slN',
];

/**
 * Sum per-day tallies into one window covering a batter's most recent `maxGames` games.
 *
 * WHY DAYS AND NOT PITCHES. A league-wide window for every batter is ~130 pitch-level CSVs
 * per load, which is not reachable from the browser. One league-wide CSV per DATE gives the
 * same numbers for every batter at once (see scripts/batter-window-refresh.mjs), so the
 * board's window is folded from cached day tallies while the player panel still fetches its
 * own rows. Both paths end at windowMetrics(), so the two windows agree by construction.
 *
 * A day is atomic: the last day admitted is taken whole even when it carries the window past
 * maxGames (a doubleheader can add two). Splitting a day would require the pitch rows this
 * fold exists to avoid re-fetching, and one extra game shifts a 15-game rate by ~7%.
 *
 * @param {Array<{date:string, tally:object}>} days  any order; sorted newest-first here
 * @param {number} maxGames  stop once this many games are covered
 */
export function foldDayTallies(days, maxGames = 15) {
  if (!Array.isArray(days) || !days.length) return null;
  const sorted = [...days].filter(d => d?.tally && d?.date).sort((a, b) => (a.date < b.date ? 1 : -1));
  const out = Object.fromEntries(TALLY_SUM_FIELDS.map(f => [f, 0]));
  out.firstDate = null;
  out.lastDate = null;
  for (const d of sorted) {
    if (out.games >= maxGames) break;
    // A cached day with no games (batter did not appear) contributes nothing and must not
    // consume a slot — otherwise an off-day between starts would truncate the window.
    if (!(d.tally.games > 0)) continue;
    for (const f of TALLY_SUM_FIELDS) out[f] += d.tally[f] || 0;
    if (!out.firstDate || d.date < out.firstDate) out.firstDate = d.date;
    if (!out.lastDate || d.date > out.lastDate) out.lastDate = d.date;
  }
  return out.games > 0 ? out : null;
}

/**
 * Fold statcast_search/csv rows (objects keyed by column name) into window counts.
 * Rows are assumed pre-filtered to one batter and one date range by the query.
 */
export function tallyPitchRows(rows) {
  const t = {
    games: 0, pitches: 0, pa: 0, k: 0, bb: 0, swings: 0, whiffs: 0,
    ozPitches: 0, ozSwings: 0, bbe: 0, evSum: 0, hardHit: 0, barrels: 0,
    bsSum: 0, bsN: 0, slSum: 0, slN: 0, firstDate: null, lastDate: null,
  };
  const seenPa = new Set(), seenGame = new Set();
  const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };

  for (const r of rows) {
    if (!r || !r.game_pk) continue;
    if (!seenGame.has(r.game_pk)) { seenGame.add(r.game_pk); t.games++; }
    const paKey = `${r.game_pk}|${r.at_bat_number}`;
    if (!seenPa.has(paKey)) { seenPa.add(paKey); t.pa++; }
    if (r.game_date) {
      if (!t.firstDate || r.game_date < t.firstDate) t.firstDate = r.game_date;
      if (!t.lastDate || r.game_date > t.lastDate) t.lastDate = r.game_date;
    }

    t.pitches++;
    const desc = r.description || '';
    const isSwing = SWING.has(desc);
    if (isSwing) t.swings++;
    if (WHIFF.has(desc)) t.whiffs++;
    const zone = parseInt(r.zone, 10);
    if (Number.isFinite(zone) && zone > 9) { t.ozPitches++; if (isSwing) t.ozSwings++; }

    // Bat tracking is stamped per competitive swing, independent of contact — which is why
    // these rows carry roughly 4x the sample of the batted-ball rows over the same window.
    const bs = num(r.bat_speed);
    if (bs != null) { t.bsSum += bs; t.bsN++; }
    const sl = num(r.swing_length);
    if (sl != null) { t.slSum += sl; t.slN++; }

    const ev = num(r.launch_speed);
    if (r.bb_type && ev != null) {
      t.bbe++;
      t.evSum += ev;
      if (ev >= 95) t.hardHit++;
      if (r.launch_speed_angle === '6' || r.launch_speed_angle === 6) t.barrels++;
    }

    const ev_ = r.events || '';
    if (ev_ === 'strikeout' || ev_ === 'strikeout_double_play') t.k++;
    if (ev_ === 'walk') t.bb++;
  }
  return t;
}

/** Window counts → the same nine rates the leaderboard publishes, same definitions. */
export function windowMetrics(t) {
  if (!t) return null;
  const rate = (n, d) => (d > 0 ? (100 * n) / d : null);
  return {
    values: {
      exitVelo:    t.bbe > 0 ? t.evSum / t.bbe : null,
      barrelPct:   rate(t.barrels, t.bbe),
      hardHitPct:  rate(t.hardHit, t.bbe),
      bbPct:       rate(t.bb, t.pa),
      kPct:        rate(t.k, t.pa),
      whiffPct:    rate(t.whiffs, t.swings),
      chasePct:    rate(t.ozSwings, t.ozPitches),
      batSpeed:    t.bsN > 0 ? t.bsSum / t.bsN : null,
      swingLength: t.slN > 0 ? t.slSum / t.slN : null,
    },
    counts: { bbe: t.bbe, pa: t.pa, swings: t.swings, ozPitches: t.ozPitches, pitches: t.pitches },
    games: t.games,
    firstDate: t.firstDate,
    lastDate: t.lastDate,
  };
}

/**
 * Percentile of `v` within an ascending sorted league array, in RAW direction
 * (higher value → higher percentile). Returns 1–99 to match Savant's scale, which has no
 * 0th or 100th. Midpoint rule so ties land in the middle of their run rather than an edge.
 */
export function empiricalPercentile(sortedAsc, v) {
  if (!Array.isArray(sortedAsc) || !sortedAsc.length || v == null || !Number.isFinite(v)) return null;
  let lo = 0, hi = sortedAsc.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (sortedAsc[m] < v) lo = m + 1; else hi = m; }
  const below = lo;
  let eq = 0;
  while (below + eq < sortedAsc.length && sortedAsc[below + eq] === v) eq++;
  const pct = (100 * (below + eq / 2)) / sortedAsc.length;
  return Math.max(1, Math.min(99, Math.round(pct)));
}

/**
 * Is this metric one where a LOWER raw value earns a HIGHER Savant percentile (K%, whiff%,
 * chase%)?
 *
 * Inferred rather than hardcoded. A static invert table has to be kept in sync with Savant's
 * choices, and a wrong entry puts the window marker on the opposite side of the bar from the
 * season badge — a silent, plausible-looking error. Instead: place the SEASON value on the
 * league distribution ourselves and see which orientation reproduces Savant's own published
 * percentile for that same player. Whichever is closer is the orientation, so the two markers
 * are consistent by construction. Falls back to raw when the comparison is unavailable.
 */
export function inferInverted(seasonRawPct, savantSeasonPct) {
  if (seasonRawPct == null || savantSeasonPct == null) return false;
  return Math.abs(100 - seasonRawPct - savantSeasonPct) < Math.abs(seasonRawPct - savantSeasonPct);
}

/**
 * Place one metric's window value on the bar the season badge already sits on.
 *
 * The window marker is NOT drawn at its own absolute empirical percentile. Savant's published
 * percentile and one computed from the leaderboard CSV disagree by a few points — different
 * qualification minimums, different rounding — so drawing the season badge from one source and
 * the window marker from the other would render that disagreement as a form change, and put a
 * visible gap on a player whose window exactly matched his season. Instead the window is
 * placed at the season badge plus the SHIFT the league distribution measures between the two
 * values. The offset cancels, so the empirical distribution only has to be right about
 * differences, never about levels — and a zero shift draws no gap, which is the property that
 * makes the marker readable at all.
 *
 * Returns null when the row cannot be drawn honestly (no window value, no league data).
 */
export function placeWindowValue({ metric, windowValue, seasonValue, savantPct, leagueSorted, counts }) {
  if (windowValue == null || !leagueSorted?.length) return null;
  const seasonRaw = empiricalPercentile(leagueSorted, seasonValue);
  const windowRaw = empiricalPercentile(leagueSorted, windowValue);
  if (seasonRaw == null || windowRaw == null) return null;

  const inverted = inferInverted(seasonRaw, savantPct);
  const orient = (p) => (inverted ? 100 - p : p);
  // Shift is in "good" space, so a falling K% reads as improvement exactly like a rising
  // barrel% does, and the connector always points the same way for the same news.
  const shift = orient(windowRaw) - orient(seasonRaw);
  const seasonPct = savantPct != null ? savantPct : orient(seasonRaw);

  return {
    pct: Math.max(1, Math.min(99, Math.round(seasonPct + shift))),
    seasonPct,
    shift,
    delta: windowValue - seasonValue,
    better: shift > 0,
    tier: noiseTier(metric, counts),
    inverted,
  };
}
