// MLB Stats API statSplits normalization.
//
// For a player who changed teams mid-season, /stats?stats=statSplits returns ONE
// ROW PER TEAM for every sitCode, plus a combined season row carrying `numTeams`
// and no `team`. Example (Jameson Taillon, 2026, sitCodes=vl,vr):
//
//   vs Left   team=112  AB=151
//   vs Left   team=141  AB=7
//   vs Left   team=—    AB=158   numTeams=2   <- the season line
//
// Consumers that render every row showed "vs LHB" three times on the splits
// table; consumers that call `.find(s => s.split.code === 'vl')` silently read
// the FIRST team's partial line as if it were the season. Collapse to one row
// per (split code, sport) so both classes of consumer see the season total.
export function dedupeSplitRows(splits) {
  if (!Array.isArray(splits)) return [];
  const byKey = new Map();
  for (const s of splits) {
    const key = `${s?.split?.code ?? s?.split?.description ?? "?"}|${s?.sport?.id ?? ""}`;
    const prev = byKey.get(key);
    if (!prev || betterSplitRow(s, prev)) byKey.set(key, s);
  }
  return [...byKey.values()];
}

// The multi-team row is the season total and always wins. Absent one (a player
// who never changed teams has a single row), fall back to the largest sample so
// a stray duplicate resolves to the dominant stint rather than to whichever row
// the API happened to list first.
function betterSplitRow(a, b) {
  const aggA = (a?.numTeams ?? 0) > 1, aggB = (b?.numTeams ?? 0) > 1;
  if (aggA !== aggB) return aggA;
  return sampleSize(a) > sampleSize(b);
}

function sampleSize(s) {
  const st = s?.stat || {};
  return Number(st.battersFaced ?? st.plateAppearances ?? st.atBats ?? 0) || 0;
}
