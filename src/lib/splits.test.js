import { describe, it, expect } from 'vitest';
import { dedupeSplitRows } from './splits.js';

/** One statSplits row as the MLB Stats API shapes it. */
const row = (code, o = {}) => ({
  season: '2026',
  split: { code, description: code === 'vl' ? 'vs Left' : code === 'vr' ? 'vs Right' : code },
  sport: { id: 1, abbreviation: 'MLB' },
  team: o.team ? { id: o.team } : undefined,
  numTeams: o.numTeams,
  stat: { atBats: o.ab ?? 0, strikeOuts: o.k ?? 0 },
});

describe('dedupeSplitRows', () => {
  // Jameson Taillon, 2026 — traded PIT→TOR mid-season.
  it('keeps the multi-team season row and drops the per-team stints', () => {
    const out = dedupeSplitRows([
      row('vl', { team: 112, ab: 151 }),
      row('vl', { team: 141, ab: 7 }),
      row('vl', { numTeams: 2, ab: 158 }),
      row('vr', { team: 112, ab: 146 }),
      row('vr', { team: 141, ab: 11 }),
      row('vr', { numTeams: 2, ab: 157 }),
    ]);
    expect(out.map(s => [s.split.code, s.stat.atBats])).toEqual([['vl', 158], ['vr', 157]]);
  });

  // Josh Smith, 2026 (TEX -> BOS) — the per-team rows do NOT arrive
  // largest-first, and not even in a consistent order across sitCodes: his vs
  // Right rows are 10 AB then 115 AB then the 125 AB aggregate, while vs Left
  // runs 21, 4, 25. So the old `.find(code)` read a TEN at-bat sample as his
  // season handedness split. Nothing may depend on row order.
  it('takes the aggregate even when the first per-team row is the small stint', () => {
    const out = dedupeSplitRows([
      row('vr', { team: 141, ab: 10 }),
      row('vr', { team: 140, ab: 115 }),
      row('vr', { numTeams: 2, ab: 125 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].stat.atBats).toBe(125);
  });

  it('leaves a single-team player untouched', () => {
    const rows = [row('vl', { team: 112, ab: 151 }), row('vr', { team: 112, ab: 146 })];
    expect(dedupeSplitRows(rows)).toEqual(rows);
  });

  it('preserves API row order', () => {
    const out = dedupeSplitRows([
      row('h', { team: 112, ab: 152 }),
      row('a', { team: 112, ab: 145 }),
      row('a', { numTeams: 2, ab: 163 }),
      row('vl', { team: 112, ab: 151 }),
    ]);
    expect(out.map(s => s.split.code)).toEqual(['h', 'a', 'vl']);
  });

  // A code the traded player only logged with one club (e.g. no night starts
  // after the trade) comes back as a lone per-team row with no aggregate.
  it('falls back to the largest sample when no aggregate row exists', () => {
    const out = dedupeSplitRows([
      row('n', { team: 112, ab: 12 }),
      row('n', { team: 141, ab: 146 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].stat.atBats).toBe(146);
  });

  it('keeps different sports apart', () => {
    const mlb = row('vl', { numTeams: 2, ab: 158 });
    const aaa = { ...row('vl', { team: 999, ab: 40 }), sport: { id: 11, abbreviation: 'AAA' } };
    expect(dedupeSplitRows([mlb, aaa])).toHaveLength(2);
  });

  it('tolerates junk input', () => {
    expect(dedupeSplitRows(null)).toEqual([]);
    expect(dedupeSplitRows(undefined)).toEqual([]);
    expect(dedupeSplitRows([])).toEqual([]);
  });
});
