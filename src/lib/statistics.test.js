import { describe, expect, it } from 'vitest';
import { rocAuc } from './statistics.js';

describe('rocAuc', () => {
  it('counts tied scores as half-concordant', () => {
    expect(rocAuc([{ p: 0.5, win: true }, { p: 0.5, win: false }])).toBe(0.5);
  });
  it('is one for perfect ranking and zero for perfectly inverted ranking', () => {
    expect(rocAuc([{ p: 0.9, win: true }, { p: 0.1, win: false }])).toBe(1);
    expect(rocAuc([{ p: 0.1, win: true }, { p: 0.9, win: false }])).toBe(0);
  });
  it('returns null when only one outcome class exists', () => {
    expect(rocAuc([{ p: 0.9, win: true }])).toBeNull();
  });
});
