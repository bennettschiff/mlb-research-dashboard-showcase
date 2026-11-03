// Rotowire daily-lineups helpers — pure string/matching logic, no DOM, no fetch.
// Lives here (rather than inline in App.jsx) so the name-resolution rules that decide
// whether a Rotowire probable becomes a real MLB player id are unit-testable.

import { normName } from './utils.js';

// Rotowire abbreviation → MLB API abbreviation (only differences listed)
export const RW_ABBR_MAP = { CHW: "CWS", KCR: "KC", TBR: "TB", SDP: "SD", SFG: "SF", WSN: "WSH", ARI: "AZ" };
export const normalizeRWAbbr = a => RW_ABBR_MAP[a] || a;

// "/baseball/player/joe-musgrove-12185" → "joe musgrove".
// The starting-pitcher highlight anchor carries no title= attribute (unlike the batter
// rows), and its text is frequently abbreviated ("T. Yesavage"), which leaves only a
// last-name match to work with. The href slug always spells the name out, so it is the
// most reliable full name on the page. Returns null for anything that isn't a player link.
export function rwNameFromHref(href) {
  const slug = /\/baseball\/player\/([a-z0-9-]+?)-\d+\/?(?:[?#].*)?$/i.exec(href || "")?.[1];
  return slug ? slug.replace(/-/g, " ") : null;
}

// Match a Rotowire probable-pitcher name against a list of MLB roster entries.
// Candidates must already be filtered to pitchers by the caller — a stray last-name
// collision with a position player (e.g. the only "Sullivan" on COL being a catcher)
// must never get plugged in as a starter.
// Returns the matching roster entry, or null when the name is ambiguous or absent.
export function matchPitcherByName(rwName, pitchers) {
  const target = normName(rwName);
  if (!target || !pitchers?.length) return null;
  // 1) exact normalized full-name match
  const exact = pitchers.find(p => normName(p.person?.fullName) === target);
  if (exact) return exact;
  // 2) unique last-name match (Rotowire abbreviates first names when they run long)
  const targetLast = target.split(" ").slice(-1)[0];
  const byLast = pitchers.filter(p => normName(p.person?.fullName).split(" ").slice(-1)[0] === targetLast);
  return byLast.length === 1 ? byLast[0] : null;
}
