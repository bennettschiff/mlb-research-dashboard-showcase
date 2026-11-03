import { describe, it, expect } from 'vitest';
import {
  tallyPitchRows, windowMetrics, empiricalPercentile, inferInverted,
  noiseTier, placeWindowValue,
} from './recentWindow.js';

/** One pitch row shaped like statcast_search/csv, with sane defaults. */
const pitch = (o = {}) => ({
  game_pk: '1', at_bat_number: '1', game_date: '2026-08-01', description: 'ball',
  zone: '5', events: '', bb_type: '', launch_speed: '', launch_speed_angle: '',
  bat_speed: '', swing_length: '', ...o,
});

describe('tallyPitchRows', () => {
  it('counts games and PAs by identity, not by row', () => {
    const t = tallyPitchRows([
      pitch({ game_pk: '1', at_bat_number: '1' }),
      pitch({ game_pk: '1', at_bat_number: '1' }),
      pitch({ game_pk: '1', at_bat_number: '2' }),
      pitch({ game_pk: '2', at_bat_number: '1' }),
    ]);
    expect(t.pitches).toBe(4);
    expect(t.pa).toBe(3);
    expect(t.games).toBe(2);
  });

  it('separates swings from whiffs — foul tips are contact', () => {
    const t = tallyPitchRows([
      pitch({ description: 'swinging_strike' }),
      pitch({ description: 'foul_tip' }),
      pitch({ description: 'foul' }),
      pitch({ description: 'called_strike' }),
      pitch({ description: 'hit_into_play' }),
    ]);
    expect(t.swings).toBe(4);   // everything but called_strike
    expect(t.whiffs).toBe(1);   // foul_tip made contact
  });

  it('counts chase against out-of-zone pitches only (zone > 9)', () => {
    const t = tallyPitchRows([
      pitch({ zone: '11', description: 'foul' }),
      pitch({ zone: '13', description: 'ball' }),
      pitch({ zone: '5', description: 'foul' }),
    ]);
    expect(t.ozPitches).toBe(2);
    expect(t.ozSwings).toBe(1);
  });

  it('tallies batted balls, hard hits and barrels', () => {
    const t = tallyPitchRows([
      pitch({ bb_type: 'fly_ball', launch_speed: '104.2', launch_speed_angle: '6' }),
      pitch({ bb_type: 'ground_ball', launch_speed: '95.0', launch_speed_angle: '2' }),
      pitch({ bb_type: 'popup', launch_speed: '80.1', launch_speed_angle: '3' }),
      pitch({ bb_type: '', launch_speed: '' }),
    ]);
    expect(t.bbe).toBe(3);
    expect(t.barrels).toBe(1);
    expect(t.hardHit).toBe(2);           // 104.2 and 95.0 (>= 95 is hard hit)
    expect(t.evSum).toBeCloseTo(279.3, 5);
  });

  it('averages bat tracking over swings that carry it, not over all pitches', () => {
    const t = tallyPitchRows([
      pitch({ bat_speed: '72.0', swing_length: '7.0' }),
      pitch({ bat_speed: '68.0', swing_length: '7.4' }),
      pitch({ bat_speed: '', swing_length: '' }),
    ]);
    expect(t.bsN).toBe(2);
    expect(windowMetrics(t).values.batSpeed).toBeCloseTo(70.0, 6);
    expect(windowMetrics(t).values.swingLength).toBeCloseTo(7.2, 6);
  });
});

describe('windowMetrics', () => {
  it('reproduces the leaderboard definitions', () => {
    const t = tallyPitchRows([
      ...Array.from({ length: 4 }, () => pitch({ bb_type: 'line_drive', launch_speed: '100', launch_speed_angle: '6' })),
      ...Array.from({ length: 4 }, () => pitch({ bb_type: 'ground_ball', launch_speed: '80', launch_speed_angle: '2' })),
      pitch({ at_bat_number: '9', events: 'strikeout', description: 'swinging_strike' }),
      pitch({ at_bat_number: '10', events: 'walk' }),
    ]);
    const m = windowMetrics(t).values;
    expect(m.exitVelo).toBeCloseTo(90, 6);        // (4*100 + 4*80) / 8
    expect(m.barrelPct).toBeCloseTo(50, 6);       // 4 of 8 BBE
    expect(m.hardHitPct).toBeCloseTo(50, 6);      // only the 100s clear 95
  });

  it('returns null rather than 0 for a rate with no denominator', () => {
    const m = windowMetrics(tallyPitchRows([pitch()])).values;
    expect(m.barrelPct).toBeNull();
    expect(m.exitVelo).toBeNull();
    expect(m.batSpeed).toBeNull();
  });
});

describe('empiricalPercentile', () => {
  const league = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  it('places a value by how much of the league it beats', () => {
    expect(empiricalPercentile(league, 0)).toBe(1);    // clamped, Savant has no 0th
    expect(empiricalPercentile(league, 100)).toBe(99);  // clears the field, clamped to 99
    expect(empiricalPercentile(league, 5)).toBe(45);   // 4 below + half of the tie
  });
  it('is null on missing input rather than silently 0', () => {
    expect(empiricalPercentile([], 5)).toBeNull();
    expect(empiricalPercentile(league, null)).toBeNull();
    expect(empiricalPercentile(league, NaN)).toBeNull();
  });
  it('handles ties by midpoint', () => {
    expect(empiricalPercentile([5, 5, 5, 5], 5)).toBe(50);
  });
});

describe('inferInverted', () => {
  it('detects a lower-is-better metric from Savant disagreeing with raw order', () => {
    // A 12% K rate is 10th percentile raw (few players are lower) but Savant publishes 90th.
    expect(inferInverted(10, 90)).toBe(true);
  });
  it('leaves a higher-is-better metric alone', () => {
    expect(inferInverted(85, 87)).toBe(false);
  });
  it('falls back to raw when Savant has no percentile for the row', () => {
    expect(inferInverted(40, null)).toBe(false);
  });
});

describe('noiseTier', () => {
  it('trusts swing-measured rows and discounts batted-ball rows', () => {
    expect(noiseTier('batSpeed',   { swings: 105 })).toBe('stable');
    expect(noiseTier('swingLength',{ swings: 105 })).toBe('stable');
    expect(noiseTier('barrelPct',  { bbe: 27 })).toBe('marginal');
    expect(noiseTier('bbPct',      { pa: 60 })).toBe('marginal');
  });
  it('calls a row thin when the denominator cannot support a rate', () => {
    expect(noiseTier('barrelPct', { bbe: 3 })).toBe('thin');
    expect(noiseTier('whiffPct',  { swings: 10 })).toBe('thin');
    expect(noiseTier('batSpeed',  {})).toBe('thin');
  });
  it('is thin for a metric with no measured noise ratio', () => {
    expect(noiseTier('somethingElse', { bbe: 500 })).toBe('thin');
  });
});

describe('placeWindowValue', () => {
  const league = Array.from({ length: 100 }, (_, i) => i + 1);  // 1..100

  it('puts an improving higher-is-better metric above its season badge', () => {
    const r = placeWindowValue({
      metric: 'barrelPct', windowValue: 80, seasonValue: 50,
      savantPct: 50, leagueSorted: league, counts: { bbe: 27 },
    });
    expect(r.inverted).toBe(false);
    expect(r.pct).toBeGreaterThan(r.seasonPct);
    expect(r.better).toBe(true);
    expect(r.delta).toBe(30);
    expect(r.tier).toBe('marginal');
  });

  it('reads a FALLING lower-is-better metric as improvement', () => {
    // Savant says 90th for a season value that sits 20th raw → inverted metric.
    const r = placeWindowValue({
      metric: 'whiffPct', windowValue: 10, seasonValue: 20,
      savantPct: 90, leagueSorted: league, counts: { swings: 105 },
    });
    expect(r.inverted).toBe(true);
    expect(r.better).toBe(true);       // whiffing less is better
    expect(r.delta).toBe(-10);
    expect(r.tier).toBe('stable');
  });

  it('anchors the season marker on Savant and offsets the window by the measured shift', () => {
    // Savant says 43rd; our own estimate of the same season value says 50th. The window is
    // 10 points higher than season on our scale, so it must land 10 above Savant's 43 — not
    // at its own absolute 60th, which would render that 7-point disagreement as form.
    const r = placeWindowValue({
      metric: 'exitVelo', windowValue: 60, seasonValue: 50,
      savantPct: 43, leagueSorted: league, counts: { bbe: 30 },
    });
    expect(r.seasonPct).toBe(43);
    expect(r.shift).toBe(10);
    expect(r.pct).toBe(53);
  });

  it('draws no gap when the window exactly matches the season', () => {
    const r = placeWindowValue({
      metric: 'batSpeed', windowValue: 50, seasonValue: 50,
      savantPct: 43, leagueSorted: league, counts: { swings: 100 },
    });
    expect(r.shift).toBe(0);
    expect(r.pct).toBe(r.seasonPct);
    expect(r.better).toBe(false);
  });

  it('declines to place a row with no window value or no league data', () => {
    const base = { metric: 'barrelPct', seasonValue: 50, savantPct: 50, counts: { bbe: 27 } };
    expect(placeWindowValue({ ...base, windowValue: null, leagueSorted: league })).toBeNull();
    expect(placeWindowValue({ ...base, windowValue: 80, leagueSorted: [] })).toBeNull();
  });

  it('clamps to the drawable 1–99 range', () => {
    const r = placeWindowValue({
      metric: 'batSpeed', windowValue: 1e6, seasonValue: 50,
      savantPct: 50, leagueSorted: league, counts: { swings: 100 },
    });
    expect(r.pct).toBeLessThanOrEqual(99);
    expect(r.pct).toBeGreaterThanOrEqual(1);
  });
});
