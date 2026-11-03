import { describe, it, expect } from 'vitest';
import { normalizeRWAbbr, rwNameFromHref, matchPitcherByName } from './rotowire.js';

const P = (id, fullName, abbr = "P") => ({ person: { id, fullName }, position: { abbreviation: abbr } });

describe('normalizeRWAbbr', () => {
  it('maps the abbreviations that differ from the MLB API', () => {
    expect(normalizeRWAbbr("CHW")).toBe("CWS");
    expect(normalizeRWAbbr("SDP")).toBe("SD");
    expect(normalizeRWAbbr("ARI")).toBe("AZ");
  });
  it('passes through abbreviations that already match', () => {
    expect(normalizeRWAbbr("SD")).toBe("SD");
    expect(normalizeRWAbbr("BOS")).toBe("BOS");
  });
});

describe('rwNameFromHref', () => {
  it('recovers the full name from a player slug', () => {
    expect(rwNameFromHref("/baseball/player/joe-musgrove-12185")).toBe("joe musgrove");
    expect(rwNameFromHref("/baseball/player/connor-prielipp-17945")).toBe("connor prielipp");
  });
  it('handles multi-part surnames and trailing slashes/queries', () => {
    expect(rwNameFromHref("/baseball/player/lance-mccullers-jr-11111/")).toBe("lance mccullers jr");
    expect(rwNameFromHref("/baseball/player/tyler-glasnow-13032?src=lineups")).toBe("tyler glasnow");
  });
  it('returns null for non-player hrefs and missing input', () => {
    expect(rwNameFromHref("/baseball/daily-lineups.php")).toBeNull();
    expect(rwNameFromHref(null)).toBeNull();
    expect(rwNameFromHref(undefined)).toBeNull();
  });
});

describe('matchPitcherByName', () => {
  const staff = [P(1, "Joe Musgrove"), P(2, "Dylan Cease"), P(3, "Michael King")];

  it('matches on the exact normalized full name', () => {
    expect(matchPitcherByName("joe musgrove", staff)?.person.id).toBe(1);
    expect(matchPitcherByName("Joe Musgrove", staff)?.person.id).toBe(1);
  });

  it('matches an abbreviated Rotowire first name by unique last name', () => {
    expect(matchPitcherByName("J. Musgrove", staff)?.person.id).toBe(1);
  });

  it('refuses an ambiguous last name rather than guessing', () => {
    const ambiguous = [...staff, P(4, "Tucker Musgrove")];
    expect(matchPitcherByName("J. Musgrove", ambiguous)).toBeNull();
    // ...but an exact full name still resolves out of the same pool.
    expect(matchPitcherByName("Joe Musgrove", ambiguous)?.person.id).toBe(1);
  });

  it('normalizes accents and suffixes on both sides', () => {
    const accented = [P(5, "Jesús Luzardo"), P(6, "Lance McCullers Jr.")];
    expect(matchPitcherByName("Jesus Luzardo", accented)?.person.id).toBe(5);
    expect(matchPitcherByName("lance mccullers jr", accented)?.person.id).toBe(6);
  });

  it('returns null on empty name or empty candidate pool', () => {
    expect(matchPitcherByName("", staff)).toBeNull();
    expect(matchPitcherByName(null, staff)).toBeNull();
    expect(matchPitcherByName("Joe Musgrove", [])).toBeNull();
    expect(matchPitcherByName("Joe Musgrove", undefined)).toBeNull();
  });
});
