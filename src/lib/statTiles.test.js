import { describe, it, expect } from 'vitest';
import { buildTile, buildTiles, getTileById, TILE_SETS, MIN_HEAT_SHIFT } from './statTiles.js';
import { foldDayTallies } from './recentWindow.js';

/** A board pick row, shaped like the scan cache's byModel entries. */
const row = (o = {}) => ({
  name: 'Batter', playerId: 1, team: 'NYY', teamId: 147,
  opponent: 'ATL', oppPitcher: 'Some Arm',
  seasonAvg: 0.270, seasonAB: 400,
  bookOdds: null,
  result: {},
  ...o,
});

/** A tile definition with everything the builder can use, overridable per test. */
const tile = (o = {}) => ({
  id: 't', label: 'T', emoji: '·', unit: '',
  value: r => r.result?.v ?? null,
  matchupTerms: [],
  fmt: v => (v == null ? null : String(v)),
  why: 'because',
  ...o,
});

describe('buildTile — ranking', () => {
  it('ranks by value descending and formats the display', () => {
    const t = buildTile(tile(), [
      row({ name: 'A', playerId: 1, result: { v: 5 } }),
      row({ name: 'B', playerId: 2, result: { v: 9 } }),
      row({ name: 'C', playerId: 3, result: { v: 7 } }),
    ]);
    expect(t.rows.map(r => r.name)).toEqual(['B', 'C', 'A']);
    expect(t.rows[0].display).toBe('9');
  });

  it('ranks an inverted axis lowest-first', () => {
    const t = buildTile(tile({ invert: true }), [
      row({ name: 'A', playerId: 1, result: { v: 5 } }),
      row({ name: 'B', playerId: 2, result: { v: 9 } }),
      row({ name: 'C', playerId: 3, result: { v: 7 } }),
    ]);
    expect(t.rows.map(r => r.name)).toEqual(['A', 'C', 'B']);
  });

  it('drops rows with no value rather than ranking them as zero', () => {
    const t = buildTile(tile(), [
      row({ name: 'A', playerId: 1, result: { v: 5 } }),
      row({ name: 'B', playerId: 2, result: {} }),
    ]);
    expect(t.rows.map(r => r.name)).toEqual(['A']);
  });

  it('returns null when the axis has no data at all on the slate', () => {
    expect(buildTile(tile(), [row({ result: {} })])).toBeNull();
  });
});

describe('buildTile — matchup adjustment', () => {
  it('promotes a lesser bat in a better spot', () => {
    const t = buildTile(tile({ matchupTerms: ['pitBattedBallAdj'] }), [
      row({ name: 'Star', playerId: 1, result: { v: 10, pitBattedBallAdj: 0.80 } }),
      row({ name: 'Ordinary', playerId: 2, result: { v: 9, pitBattedBallAdj: 1.25 } }),
    ]);
    // 10 x 0.80 = 8.0 vs 9 x 1.25 = 11.25 — the matchup flips the order.
    expect(t.rows[0].name).toBe('Ordinary');
    // The RAW value is still what the tile displays; only the ranking is adjusted.
    expect(t.rows[0].display).toBe('9');
  });

  it('moves an inverted axis the same direction a favourable matchup should', () => {
    // Lower is better, so a favourable (>1) matchup must DIVIDE, improving the number.
    const t = buildTile(tile({ invert: true, matchupTerms: ['m'] }), [
      row({ name: 'A', playerId: 1, result: { v: 10, m: 1.0 } }),
      row({ name: 'B', playerId: 2, result: { v: 11, m: 1.3 } }),
    ]);
    expect(t.rows[0].name).toBe('B'); // 11/1.3 = 8.46 beats 10/1.0
  });

  it('clamps a runaway product of adjustment terms', () => {
    const t = buildTile(tile({ matchupTerms: ['a', 'b', 'c', 'd'] }), [
      row({ name: 'A', playerId: 1, result: { v: 10, a: 1.3, b: 1.3, c: 1.3, d: 1.3 } }),
    ]);
    expect(t.rows[0].matchup).toBeCloseTo(1.35, 5); // 2.86 unclamped
  });

  it('treats a missing or no-op term as neutral', () => {
    const t = buildTile(tile({ matchupTerms: ['absent'] }), [
      row({ name: 'A', playerId: 1, result: { v: 10 } }),
    ]);
    expect(t.rows[0].matchup).toBe(1);
    expect(t.rows[0].adjusted).toBe(10);
  });
});

describe('buildTile — one row per subject', () => {
  it('collapses a pitcher tile to one row per pitcher, not per hitter', () => {
    const t = buildTile(tile({ perPitcher: true }), [
      row({ name: 'H1', playerId: 1, oppPitcher: 'Arm A', result: { v: 9 } }),
      row({ name: 'H2', playerId: 2, oppPitcher: 'Arm A', result: { v: 9 } }),
      row({ name: 'H3', playerId: 3, oppPitcher: 'Arm B', result: { v: 4 } }),
    ]);
    expect(t.rows.map(r => r.name)).toEqual(['Arm A', 'Arm B']);
    expect(t.subject).toBe('pitcher');
  });

  it('collapses a team tile to one row per opponent', () => {
    const t = buildTile(tile({ perTeam: true }), [
      row({ playerId: 1, opponent: 'ATL', result: { v: 2 } }),
      row({ playerId: 2, opponent: 'ATL', result: { v: 2 } }),
      row({ playerId: 3, opponent: 'BOS', result: { v: 5 } }),
    ]);
    expect(t.rows.map(r => r.name)).toEqual(['BOS', 'ATL']);
  });

  it('keeps one row per batter when the same batter appears twice', () => {
    const t = buildTile(tile(), [
      row({ name: 'A', playerId: 1, result: { v: 5 } }),
      row({ name: 'A', playerId: 1, result: { v: 5 } }),
    ]);
    expect(t.rows).toHaveLength(1);
  });
});

describe('buildTile — season sample floor', () => {
  it('refuses to rank a hitter whose rate comes from a handful of at-bats', () => {
    const t = buildTile(tile(), [
      // 100% on 10 AB is not a measurement — it wins leaderboards because it is unbounded.
      row({ name: 'Callup', playerId: 1, seasonAB: 10, result: { v: 100 } }),
      row({ name: 'Regular', playerId: 2, seasonAB: 400, result: { v: 12 } }),
    ]);
    expect(t.rows.map(r => r.name)).toEqual(['Regular']);
  });

  it('keeps a part-season hitter — the floor cuts the unmeasurable, not the unfamiliar', () => {
    const t = buildTile(tile(), [
      row({ name: 'Rookie', playerId: 1, seasonAB: 115, result: { v: 30 } }),
      row({ name: 'Regular', playerId: 2, seasonAB: 400, result: { v: 12 } }),
    ]);
    expect(t.rows[0].name).toBe('Rookie');
  });

  it('applies an innings floor to a pitcher row', () => {
    const t = buildTile(tile(), [
      row({ name: 'Spot', playerId: 1, seasonAB: undefined, seasonIP: 4, result: { v: 99 } }),
      row({ name: 'Starter', playerId: 2, seasonAB: undefined, seasonIP: 120, result: { v: 30 } }),
    ]);
    expect(t.rows.map(r => r.name)).toEqual(['Starter']);
  });

  it('does not sample-gate a tile describing the opposition', () => {
    // The value is the opposing pitcher's season rate; the scanned row's own AB is irrelevant.
    const t = buildTile(tile({ perPitcher: true }), [
      row({ name: 'Callup', playerId: 1, seasonAB: 10, oppPitcher: 'Arm A', result: { v: 9 } }),
    ]);
    expect(t.rows.map(r => r.name)).toEqual(['Arm A']);
  });
});

describe('buildTile — heating rows', () => {
  const win = (shift) => ({
    // Season distribution 1..100 makes a percentile ≈ the value, so a window value of
    // (season + shift) produces a shift of about `shift` percentile points.
    seasonLeague: { f: Array.from({ length: 100 }, (_, i) => i + 1) },
    batters: {
      2: { values: { barrelPct: 50 + shift }, counts: { bbe: 40 }, games: 15 },
    },
  });
  const heatTile = tile({ leagueField: 'f', windowMetric: 'barrelPct' });

  it('appends movers after the season leaders', () => {
    const t = buildTile(heatTile, [
      row({ name: 'Lead1', playerId: 11, result: { v: 90 } }),
      row({ name: 'Lead2', playerId: 12, result: { v: 85 } }),
      row({ name: 'Lead3', playerId: 13, result: { v: 80 } }),
      row({ name: 'Mover', playerId: 2, result: { v: 50 } }),
    ], { window: win(25) });
    expect(t.rows.map(r => r.rank)).toEqual(['best', 'best', 'best', 'heating']);
    expect(t.rows[3].name).toBe('Mover');
    expect(t.rows[3].window.shift).toBeGreaterThanOrEqual(MIN_HEAT_SHIFT);
  });

  it('places the bar where the window sits, not where the season does', () => {
    const t = buildTile(heatTile, [
      row({ name: 'Lead1', playerId: 11, result: { v: 90 } }),
      row({ name: 'Lead2', playerId: 12, result: { v: 85 } }),
      row({ name: 'Lead3', playerId: 13, result: { v: 80 } }),
      row({ name: 'Mover', playerId: 2, result: { v: 50 } }),
    ], { window: win(25) });
    const mover = t.rows.find(r => r.rank === 'heating');
    // Season ≈ 50th percentile, window shifted +25 → the bar must read ≈75, not ≈50.
    expect(mover.window.pct).toBeGreaterThan(mover.leaguePct);
    expect(Math.abs(mover.window.pct - (mover.leaguePct + mover.window.shift))).toBeLessThanOrEqual(1);
  });

  it('ignores a window that has barely moved', () => {
    const t = buildTile(heatTile, [
      row({ name: 'Lead1', playerId: 11, result: { v: 90 } }),
      row({ name: 'Mover', playerId: 2, result: { v: 50 } }),
    ], { window: win(2) });
    expect(t.rows.every(r => r.rank === 'best')).toBe(true);
  });

  it('refuses to rank a window below its denominator floor', () => {
    const thin = win(30);
    thin.batters[2].counts = { bbe: 3 };  // barrelPct floor is 15 BBE
    const t = buildTile(heatTile, [
      row({ name: 'Lead1', playerId: 11, result: { v: 90 } }),
      row({ name: 'Mover', playerId: 2, result: { v: 50 } }),
    ], { window: thin });
    expect(t.rows.find(r => r.rank === 'heating')).toBeUndefined();
  });

  it('does not repeat a batter who is already a season leader', () => {
    const w = win(30);
    w.batters[11] = { values: { barrelPct: 95 }, counts: { bbe: 40 }, games: 15 };
    const t = buildTile(heatTile, [
      row({ name: 'Lead1', playerId: 11, result: { v: 60 } }),
      row({ name: 'Mover', playerId: 2, result: { v: 50 } }),
    ], { window: w });
    expect(t.rows.filter(r => r.name === 'Lead1')).toHaveLength(1);
  });

  it('orients the shift so a falling inverted metric reads as improvement', () => {
    const w = {
      seasonLeague: { f: Array.from({ length: 100 }, (_, i) => i + 1) },
      batters: { 2: { values: { whiffPct: 20 }, counts: { swings: 80 }, games: 15 } },
    };
    const t = buildTile(
      tile({ invert: true, leagueField: 'f', windowMetric: 'whiffPct' }),
      [row({ name: 'A', playerId: 1, result: { v: 10 } }),
       row({ name: 'Mover', playerId: 2, result: { v: 50 } })],
      { window: w });
    // Whiff fell 50 → 20, which is better, so the shift must be POSITIVE.
    const mover = t.rows.find(r => r.name === 'Mover');
    expect(mover.window.shift).toBeGreaterThan(0);
  });
});

describe('buildTile — value mode (price residual)', () => {
  const odds = (american) => ({ bookOdds: { draftkings: american } });
  const rows = [
    // Elite metric, short price → the market already knows.
    row({ name: 'Priced', playerId: 1, result: { v: 100 }, ...odds(-150) }),
    // Elite metric, long price → the residual the mode exists to find.
    row({ name: 'Sleeper', playerId: 2, result: { v: 95 }, ...odds(900) }),
    row({ name: 'C', playerId: 3, result: { v: 40 }, ...odds(200) }),
    row({ name: 'D', playerId: 4, result: { v: 20 }, ...odds(-110) }),
  ];

  it('ranks the long price with the strong profile first', () => {
    const t = buildTile(tile(), rows, { mode: 'value' });
    expect(t.rows[0].name).toBe('Sleeper');
    expect(t.rows[0].residual).toBeGreaterThan(0);
  });

  it('reports an empty tile rather than silently falling back', () => {
    const t = buildTile(tile(), [
      row({ name: 'A', playerId: 1, result: { v: 5 } }),
      row({ name: 'B', playerId: 2, result: { v: 9 } }),
    ], { mode: 'value' });
    expect(t.rows).toEqual([]);
    expect(t.empty).toMatch(/odds/);
  });

  it('leaves the residual undefined for a pitcher axis with no per-row market', () => {
    const t = buildTile(tile({ perPitcher: true }), rows);
    expect(t.rows.every(r => r.residual == null)).toBe(true);
  });
});

describe('buildTile — percentile scale', () => {
  it('uses the league distribution when the axis has one', () => {
    const t = buildTile(tile({ leagueField: 'f' }), [
      row({ playerId: 1, result: { v: 50 } }),
    ], { window: { seasonLeague: { f: Array.from({ length: 100 }, (_, i) => i + 1) } } });
    expect(t.scale).toBe('league');
    expect(t.rows[0].leaguePct).toBeGreaterThan(40);
    expect(t.rows[0].leaguePct).toBeLessThan(60);
  });

  it('falls back to a slate-relative rank for a derived axis', () => {
    const t = buildTile(tile(), [
      row({ playerId: 1, result: { v: 1 } }),
      row({ playerId: 2, result: { v: 2 } }),
    ]);
    expect(t.scale).toBe('slate');
    expect(t.rows[0].leaguePct).toBe(t.rows[0].slatePct);
  });
});

describe('buildTiles', () => {
  it('builds a strip for every configured board and drops empty tiles', () => {
    for (const key of Object.keys(TILE_SETS)) {
      expect(buildTiles(key, [])).toEqual([]);
    }
    const strip = buildTiles('hr', [
      row({ playerId: 1, result: { rawBarrelPct: 12, rawHardHitPct: 50 } }),
      row({ playerId: 2, result: { rawBarrelPct: 8, rawHardHitPct: 42 } }),
    ]);
    // barrel + hard-hit have data; split SLG / arsenal damage / bat speed / pull-air do not.
    expect(strip.map(t => t.id).sort()).toEqual(['barrel', 'hardhit']);
  });

  // Two axes correlated at |r| >= 0.80 tell the reader one thing, so a strip that carries
  // both prints the same leaderboard twice. The sets were re-picked one-per-cluster on
  // 2026-08-11 (scripts/tile-rank.mjs); this pins the weaker property that no set repeats an
  // axis outright, which is the failure a careless edit would actually reintroduce.
  it('gives every board a set of distinct axes', () => {
    for (const [board, defs] of Object.entries(TILE_SETS)) {
      expect(defs.length, board).toBeGreaterThanOrEqual(5);
      const ids = defs.map(d => d.id);
      expect(new Set(ids).size, board).toBe(ids.length);
      for (const d of defs) {
        expect(typeof d.value, `${board}/${d.id}`).toBe('function');
        expect(d.why, `${board}/${d.id}`).toBeTruthy();
      }
    }
  });
});

describe('value formatting', () => {
  // Baseball's leading-dot form is only correct below 1.000. A live slate put OPS vs Hand at
  // 1.138 and RISP OPS at 1.406, which the old formatter rendered ".1138" and ".1406".
  it('drops the leading dot once a rate passes 1.000', () => {
    const ops = getTileById('tb', 'splitops');
    expect(ops.fmt(0.729)).toBe('.729');
    expect(ops.fmt(1.138)).toBe('1.138');
    expect(getTileById('rbi', 'rispops').fmt(1.406)).toBe('1.406');
  });

  // Two pitcher atoms that look alike and are not: topped rate arrives as a percentage,
  // blasts allowed as a fraction. Reading the fraction with the shared percent formatter
  // printed "0.1%" for a slate-leading 13.5%.
  it('scales the pitcher atoms that arrive as fractions', () => {
    const blast = getTileById('tb', 'pitblast');
    expect(blast.value({ result: { rawPitBlastAllowed: 0.1349 } })).toBeCloseTo(13.49, 6);
    expect(getTileById('tb', 'pittopped').value({ result: { rawPitToppedPct: 26.6 } })).toBe(26.6);
    // Same trap on the SB board: a rate difference of ±0.17 rendered to one decimal is "+0.1".
    expect(getTileById('sb', 'xbaggro').value({ result: { rawXbAttAboveAvg: 0.1188 } })).toBeCloseTo(11.88, 6);
  });
});

describe('matchup labels', () => {
  // A pitcher-subject row names an arm. Without the label there is nothing on the row that
  // says whose hitters that arm is being ranked on behalf of, which is the only reason the
  // row is on a batter board — so the label flips perspective with the subject.
  const rows = [
    row({ playerId: 1, name: 'Judge', team: 'NYY', opponent: 'ATL', oppPitcher: 'Spencer Strider', result: { v: 5 } }),
    row({ playerId: 2, name: 'Soto', team: 'NYY', opponent: 'ATL', oppPitcher: 'Spencer Strider', result: { v: 3 } }),
  ];

  it('names the team and the opposing starter on a batter row', () => {
    const t = buildTile(tile(), rows);
    expect(t.rows[0].matchupLabel).toBe('NYY vs Strider');
  });

  it('names the pitcher\'s own club and the lineup he faces on a pitcher row', () => {
    const t = buildTile(tile({ perPitcher: true }), rows);
    expect(t.rows).toHaveLength(1);              // one row per arm, not one per hitter
    expect(t.rows[0].name).toBe('Spencer Strider');
    expect(t.rows[0].matchupLabel).toBe('ATL · vs NYY');
  });

  it('falls back to the opponent when there is no opposing starter (Ks board rows)', () => {
    const t = buildTile(tile(), [
      { name: 'Skubal', pitcherId: 9, team: 'DET', opponent: 'CLE', result: { v: 5 } },
      { name: 'Bibee', pitcherId: 8, team: 'CLE', opponent: 'DET', result: { v: 3 } },
    ]);
    expect(t.rows[0].matchupLabel).toBe('DET vs CLE');
  });

  it('returns nothing for a board with no tile set', () => {
    expect(buildTiles('nope', [row()])).toEqual([]);
  });
});

describe('foldDayTallies', () => {
  const day = (date, o) => ({ date, tally: { games: 1, pa: 4, bbe: 2, barrels: 1, ...o } });

  it('sums the most recent N games, newest first', () => {
    const out = foldDayTallies([
      day('2026-08-01'), day('2026-08-03'), day('2026-08-02'),
    ], 2);
    expect(out.games).toBe(2);
    expect(out.pa).toBe(8);
    expect(out.lastDate).toBe('2026-08-03');
    expect(out.firstDate).toBe('2026-08-02');
  });

  it('does not let a day the batter sat out consume a window slot', () => {
    const out = foldDayTallies([
      day('2026-08-03'), { date: '2026-08-02', tally: { games: 0, pa: 0 } }, day('2026-08-01'),
    ], 2);
    expect(out.games).toBe(2);
    expect(out.firstDate).toBe('2026-08-01');
  });

  it('takes a doubleheader whole rather than splitting a day', () => {
    const out = foldDayTallies([day('2026-08-03', { games: 2, pa: 8 })], 1);
    expect(out.games).toBe(2);
    expect(out.pa).toBe(8);
  });

  it('returns null when there is nothing to fold', () => {
    expect(foldDayTallies([])).toBeNull();
    expect(foldDayTallies([{ date: '2026-08-01', tally: { games: 0 } }])).toBeNull();
  });
});
