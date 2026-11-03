// ── NRFI/YRFI slate builder — shared by the 1st Inning board and the saver ────
//
// The half-inning model (src/lib/nrfi.js) is pure math over a season state and
// a set of per-game inputs. Assembling those inputs from the MLB Stats API is
// the part the UI and the headless pick-saver both need, and the part that
// silently rots if it exists twice. It lives here once.
//
// `fetchJson` is injected because the browser copy (src/lib/utils.js) carries
// the freeze-detector registration and a session cache, while scripts want a
// plain retrying fetch. Everything else is environment-agnostic.

import { buildSeasonState, predictFirstInning } from "./nrfi.js";

export const NRFI_SEASON = 2026;
const SEASON_START_MONTH = 3;

export const NRFI_SCHED_FIELDS =
  "dates,date,games,gamePk,officialDate,status,codedGameState,teams,away,home,team,id,score,probablePitcher,venue,name,linescore,innings,num,runs";

/**
 * Walk the season's completed games and fold their first innings into the
 * model's empirical state (pitcher / team / venue first-inning history).
 * ~1.6 MB of schedule JSON; callers cache the promise per calendar day.
 */
export async function fetchSeasonState({ fetchJson, todayStr, api, season = NRFI_SEASON }) {
  const completed = [];
  const nowMonth = Number(todayStr.slice(5, 7));
  for (let m = SEASON_START_MONTH; m <= nowMonth; m++) {
    const start = `${season}-${String(m).padStart(2, "0")}-01`;
    const end = `${season}-${String(m).padStart(2, "0")}-${new Date(season, m, 0).getDate()}`;
    const d = await fetchJson(
      `${api}/schedule?sportId=1&gameType=R&startDate=${start}&endDate=${end}&hydrate=linescore,probablePitcher&fields=${NRFI_SCHED_FIELDS}`,
      30000
    );
    for (const day of d?.dates || []) {
      for (const g of day.games || []) {
        if (g.status?.codedGameState !== "F") continue;
        const inn1 = g.linescore?.innings?.[0];
        if (inn1?.home?.runs == null || inn1?.away?.runs == null) continue;
        completed.push({
          starterTopId: g.teams?.home?.probablePitcher?.id ?? null,
          starterBotId: g.teams?.away?.probablePitcher?.id ?? null,
          homeId: g.teams?.home?.team?.id,
          awayId: g.teams?.away?.team?.id,
          r1Top: inn1.away.runs,
          r1Bot: inn1.home.runs,
          homeR: g.teams?.home?.score ?? null,
          awayR: g.teams?.away?.score ?? null,
        });
      }
    }
  }
  return { state: buildSeasonState(completed), sampleSize: completed.length };
}

/**
 * Today's prediction-time inputs: confirmed batting orders (MLB posts them on
 * the schedule as `lineups`) plus bulk season lines for every starter and every
 * top-6 batter on the slate.
 *
 * `bustLineups` forces a fresh read of the lineups hydrate. That URL is fixed
 * for the day but its CONTENT fills in game by game as cards are posted, so the
 * browser's session memo (src/lib/utils.js fetchJson) would otherwise pin the
 * board to whatever was posted at page load. The player-stat calls are not
 * busted: their URLs carry the person ids, so newly-posted batters produce new
 * URLs and fetch fresh on their own.
 */
export async function fetchSlateInputs({ fetchJson, dateStr, games, api, season = NRFI_SEASON, bustLineups = false }) {
  // linescore rides along on the same request: the caller's `games` prop is
  // fetched once per date and then memoized for the session, so status and
  // linescore there are frozen at page load and the board can never self-grade.
  // Hydrating both here means one busted request refreshes lineups AND live
  // state together, and they can't disagree about the same game.
  const lu = await fetchJson(`${api}/schedule?sportId=1&date=${dateStr}&hydrate=lineups,linescore`, 15000, { bypassCache: bustLineups });
  const lineupsByPk = {};
  const liveByPk = {};
  for (const day of lu?.dates || []) {
    for (const g of day.games || []) {
      lineupsByPk[g.gamePk] = {
        home: (g.lineups?.homePlayers || []).map((p) => p.id),
        away: (g.lineups?.awayPlayers || []).map((p) => p.id),
      };
      liveByPk[g.gamePk] = { status: g.status, linescore: g.linescore };
    }
  }
  const pitcherIds = [
    ...new Set(
      games
        .flatMap((g) => [g.teams?.home?.probablePitcher?.id, g.teams?.away?.probablePitcher?.id])
        .filter(Boolean)
    ),
  ];
  const batterIds = [
    ...new Set(Object.values(lineupsByPk).flatMap((l) => [...l.home.slice(0, 6), ...l.away.slice(0, 6)])),
  ];
  const bulkStats = async (ids, group) => {
    if (!ids.length) return {};
    const out = {};
    for (let i = 0; i < ids.length; i += 90) {
      const chunk = ids.slice(i, i + 90);
      const d = await fetchJson(
        `${api}/people?personIds=${chunk.join(",")}&hydrate=stats(group=[${group}],type=[season],season=${season})`
      );
      for (const p of d?.people || []) out[p.id] = p.stats?.[0]?.splits?.[0]?.stat || null;
    }
    return out;
  };
  const [pitcherStats, batterStats] = await Promise.all([
    bulkStats(pitcherIds, "pitching"),
    bulkStats(batterIds, "hitting"),
  ]);
  return { lineupsByPk, liveByPk, pitcherStats, batterStats };
}

/** One game → { pred, lineupsPosted, abbrs, probables }. */
export function predictGame(game, { state, inputs }) {
  const homeProb = game.teams?.home?.probablePitcher;
  const awayProb = game.teams?.away?.probablePitcher;
  const lu = inputs.lineupsByPk[game.gamePk] || { home: [], away: [] };
  const pred = predictFirstInning({
    top: {
      pitcherId: homeProb?.id ?? null,
      pitcherStat26: homeProb ? inputs.pitcherStats[homeProb.id] : null,
      offTeamId: game.teams?.away?.team?.id,
      lineupIds: lu.away,
      lineupStats: inputs.batterStats,
    },
    bot: {
      pitcherId: awayProb?.id ?? null,
      pitcherStat26: awayProb ? inputs.pitcherStats[awayProb.id] : null,
      offTeamId: game.teams?.home?.team?.id,
      lineupIds: lu.home,
      lineupStats: inputs.batterStats,
    },
    venueName: game.venue?.name,
    state,
  });
  return {
    pred,
    homeAbbr: game.teams?.home?.team?.abbreviation || "HOME",
    awayAbbr: game.teams?.away?.team?.abbreviation || "AWY",
    homeProb,
    awayProb,
    lineupsPosted: lu.home.length >= 6 && lu.away.length >= 6,
  };
}
