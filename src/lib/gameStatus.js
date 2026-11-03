// ── Game-status helpers for pick scoring ──────────────────────────────────────
//
// Postponed/cancelled games never produce a box score, so their picks sat
// outcome=pending forever and the daily-picks score-poll burned its whole
// budget waiting on them (2026-06-11: ATL @ CWS postponed → 2 stuck picks →
// 15-min poll timeout → save phase starved → job killed). Both the browser
// auto-scorer (App.jsx scorePicks) and the headless driver
// (scripts/daily-picks.mjs) decide off these helpers so the two can't drift.

// True when the game will never be completed under this gamePk — grade its
// picks "push" (the established no-action outcome, excluded from ROI).
// Suspended games normally resume later under the SAME gamePk (status flips
// back to Live → Final), so suspended only counts as dead when MLB hasn't
// scheduled a resume date.
export function isDeadGame(game) {
  const state = game?.status?.detailedState || "";
  if (/postponed|cancell?ed/i.test(state)) return true;
  if (/suspended/i.test(state) && !game?.resumeDate && !game?.resumeGameDate) return true;
  return false;
}

// True when no scoring pass could grade this game's picks right now: dead, or
// suspended and parked until its resume date. Used by the daily-picks
// score-poll so "only unscoreable picks remain" counts as success instead of
// timing out.
export function isUnscoreableGame(game) {
  if (isDeadGame(game)) return true;
  return /suspended/i.test(game?.status?.detailedState || "");
}

// Schedule-API query suffix the checks above depend on: detailedState for the
// status match, resume fields for the suspended carve-out, and hydrate=team +
// abbreviation so picks that store a team abbr (player props, ml/rl) can be
// mapped to their game. statsapi `fields` is a flat whitelist applied at every
// nesting level, so gamePk/teams/etc. all need to be listed.
export const SCHEDULE_STATUS_PARAMS =
  "&hydrate=team&fields=dates,games,gamePk,teams,home,away,team,abbreviation,status,detailedState,resumeDate,resumeGameDate";

// Abbreviations of both teams in a schedule game (hydrate=team required).
export function gameTeamAbbrs(game) {
  return [game?.teams?.home?.team?.abbreviation, game?.teams?.away?.team?.abbreviation].filter(Boolean);
}

// ── Live game state, independent of the app's session-cached schedule ────────
//
// App fetches the slate once per date through fetchJson, which memoizes by URL
// for the life of the tab. Status therefore freezes at page load: a tab opened
// in the morning believes every game is still "Preview" all night. Anything that
// keys off first pitch — the Golden lock above all — silently never fires.
//
// This is deliberately its own tiny request rather than a refresh of the shared
// `games` array: `games` is a dependency of the props scan, so mutating it on a
// timer would re-run the whole league-wide scan every poll.
export const SCHEDULE_STATE_FIELDS =
  "&fields=dates,games,gamePk,status,abstractGameState,detailedState";

/** { gamePk → abstractGameState }. Always bypasses the session memo. */
export async function fetchGameStates({ fetchJson, date, api }) {
  const d = await fetchJson(
    `${api}/schedule?sportId=1&date=${date}&gameType=R${SCHEDULE_STATE_FIELDS}`,
    15000,
    { bypassCache: true }
  );
  const out = {};
  for (const day of d?.dates || []) {
    for (const g of day.games || []) out[g.gamePk] = g.status?.abstractGameState || "Preview";
  }
  return out;
}

/** Same shape, read off an already-fetched schedule array (seeds the first render). */
export function gameStatesFromGames(games) {
  const out = {};
  for (const g of games || []) {
    if (g?.gamePk != null) out[g.gamePk] = g.status?.abstractGameState || "Preview";
  }
  return out;
}

/** Has the slate begun? Empty/unknown counts as not started — never lock on no data. */
export function anyGameStarted(states) {
  return Object.values(states || {}).some((s) => s && s !== "Preview");
}

/** Nothing left to watch once every game is Final. */
export function allGamesFinal(states) {
  const vals = Object.values(states || {});
  return vals.length > 0 && vals.every((s) => s === "Final");
}

// Regular-season games scheduled on an ET date — the only games we make picks
// on. gameType=R is load-bearing: the unfiltered schedule counts exhibitions,
// and the All-Star Game (gameType "A") is one of them. On 2026-07-14 the raw
// totalGames was 1, so a `totalGames == 0` off-day guard did NOT trip and the
// run demanded picks/scan for a slate that does not exist.
// Throws on network/API failure — callers decide whether an unknown slate size
// should be treated as "games expected" (fail loud) or skipped.
export async function regularSeasonGameCount(date) {
  const r = await fetch(
    `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&gameType=R`
  );
  if (!r.ok) throw new Error(`statsapi schedule ${date}: ${r.status}`);
  return (await r.json()).totalGames ?? 0;
}
