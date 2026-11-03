// ── Slate Odds — the game-line board (moneyline / run line / total) ─────────
// Extracted from App.jsx 2026-08-14 (project rule: any component meaningfully
// edited inside App.jsx moves to src/components in the same commit). Its pure
// odds reshaping went to src/lib/gameOdds.js at the same time; the three Savant
// / MLB-API loaders it needs stay in App.jsx, which owns their promise caches
// (see the 2026-06-26 "Savant CSV storm" — duplicating those caches is how the
// page froze), and are injected through `dataSources`.
//
// WHAT CHANGED WITH THE MOVE — the three 1–10 "Sig" scores were hand-rolled
// inline in the JSX, each against a different denominator (edge/0.12,
// margin/2, total/3) and each nudged by the moneyline confidence tier, while
// the 🎲 came from gameLineGates. Nothing tied the number to the gate, so on
// 2026-08-14 the page showed MIL @ LAD at ML Sig 7.6 with NO dice (+10.1% edge
// but LOW model confidence, which can never play) sitting above STL @ CHC at
// 5.8 WITH one — and MIA @ CIN showed a named ML pick next to a "—" score.
//
// Now every market is scored in units of ITS OWN BAR (src/lib/conviction.js):
// how much of the edge this market requires does the game actually have?
// 1.0× the bar is 7.0 on all three markets, the 🎲 sits exactly there, and a
// row the gates rejected folds below the line carrying the reason. Same gates,
// same saved picks — gameLineGates is untouched — but the number on screen and
// the dice finally point the same way.
import { useState, useEffect } from "react";
import {
  slateOddsModel, calcFIP, PARK_RUNS, calcEdge, fmtOdds,
  bestMLOdds, bestSpreadOdds, runLinePick,
  BOOK_COLORS as GAME_BOOK_COLORS, BOOK_LABELS as GAME_BOOK_LABELS,
} from "../lib/gameModel.js";
import { gameLineGates } from "../lib/picks.js";
import {
  mlConviction, rlConviction, ouConviction, bestGameConviction,
  GAME_PLAY_LINE, ML_REQUIRED_EDGE, RL_REQUIRED_EDGE, OU_REQUIRED_EDGE,
  TIER, TIER_META,
} from "../lib/conviction.js";
import { getGameOdds, BOOK_URLS } from "../lib/gameOdds.js";
import { API, getTodayInAppTimeZone } from "../lib/utils.js";
import { PROJ_BATTERS, findProjection } from "../lib/projections.js";
import { getParkCoords, getParkCfBearing, getParkData } from "../lib/parks.js";
import { getNWSForecast, getGameWeather, isWeatherNeutral } from "../lib/weather.js";
import { fetchGameUmpires, fetchUmpireSeasonStats, buildUmpireInfo } from "../lib/umpires.js";
import ConvictionCell from "./ConvictionCell.jsx";

const MARKET_LABEL = { ml: "MONEYLINE", rl: "RUN LINE", ou: "TOTAL" };

export default function SlateOdds({ games, oddsData, season, onGamePicksReady, lineupData = {}, dataSources = {}, probableFor = null }) {
  // Probable starter for one side: StatsAPI first, then the slate-wide Rotowire
  // resolution App passes down. Reading probablePitcher directly meant a game
  // StatsAPI still had as TBD priced its ML/RL/OU with no starter FIP and no L5
  // form on that side — the model fell through to league defaults for half the game.
  const starterFor = (g, side) => (probableFor
    ? probableFor(g, side)
    : g?.teams?.[side]?.probablePitcher) || null;
  const { getTeamOAAMap, fetchAllTeamBullpenERAs, fetchAdvancedStatsBulk } = dataSources;
  const [teamStats, setTeamStats]     = useState({}); // abbr → { ops, runsPerGame, bullpenERA }
  const [pitcherFIP, setPitcherFIP]   = useState({}); // mlbamId → { fip, era, name }
  const [teamOAA, setTeamOAA]         = useState({}); // abbr → season OAA total
  const [bullpenByTeam, setBullpenByTeam] = useState({}); // abbr → reliever-only ERA
  const [teamL10, setTeamL10]         = useState({}); // abbr → { l10Rpg, delta }
  const [pitcherL5FIP, setPitcherL5FIP] = useState({}); // mlbamId → l5Fip
  const [pitcherAdv,   setPitcherAdv]   = useState({}); // mlbamId → { siera, pit_plus, fastball_velo, ... }
  const [slateUmpires, setSlateUmpires] = useState({}); // gamePk → { name, mult }
  const [weatherByGame, setWeatherByGame] = useState({}); // gamePk → weather object
  const [loading, setLoading]         = useState(true);
  // Default sort is the row's strongest conviction, not first pitch: this page
  // exists to answer "what should I bet tonight", and time order buries the
  // answer in the middle of the slate.
  const [sortKey, setSortKey]         = useState("play");
  const [sortDir, setSortDir]         = useState(-1);
  const [filterConf, setFilterConf]   = useState("plays"); // "all" | "high" | "medium" | "plays"

  // Load team + pitcher stats once on mount
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        // 1. Team ID → abbreviation map
        const teamsRes = await fetch(`${API}/teams?sportId=1&season=${season}`).then(r => r.json());
        const idToAbbr = {};
        for (const t of teamsRes.teams || []) idToAbbr[t.id] = t.abbreviation;

        // 2. Team hitting stats
        const hitRes = await fetch(`${API}/teams/stats?stats=season&group=hitting&season=${season}&sportId=1`).then(r => r.json());
        const stats = {};
        for (const s of hitRes.stats?.[0]?.splits || []) {
          const abbr = idToAbbr[s.team.id];
          if (abbr) stats[abbr] = { ops: parseFloat(s.stat.ops || 0.718), runsPerGame: +(s.stat.runs / s.stat.gamesPlayed).toFixed(2) };
        }

        // 3. Team pitching stats (full team ERA — kept for fallback)
        const pitchRes = await fetch(`${API}/teams/stats?stats=season&group=pitching&season=${season}&sportId=1`).then(r => r.json());
        for (const s of pitchRes.stats?.[0]?.splits || []) {
          const abbr = idToAbbr[s.team.id];
          if (abbr && stats[abbr]) stats[abbr].teamERA = parseFloat(s.stat.era || 4.30);
        }
        if (!cancelled) setTeamStats(stats);

        // 3b. True bullpen ERA — reliever-only per-team aggregation via getTeamBullpen
        // (MLB Stats API rejects playerPool=RELIEF; loop the 30 team rosters instead).
        const abbrToId = {};
        for (const [tid, abbr] of Object.entries(idToAbbr)) abbrToId[abbr] = tid;
        fetchAllTeamBullpenERAs?.(abbrToId, season)
          .then(bpERA => { if (!cancelled) setBullpenByTeam(bpERA); })
          .catch(() => {});

        // 3c. Team OAA from Savant — aggregated by team abbreviation for defensive adjustment
        getTeamOAAMap?.(parseInt(season)).then(oaaMap => {
          if (!cancelled) setTeamOAA(oaaMap);
        }).catch(() => {}); // non-blocking

        // 3d. Team L10 run totals — last 14 days of schedule (scores available without hydration)
        const today = getTodayInAppTimeZone();
        const d14 = new Date(new Date(today) - 14 * 86400000).toISOString().slice(0, 10);
        fetch(`${API}/schedule?sportId=1&startDate=${d14}&endDate=${today}&gameType=R&season=${season}`)
          .then(r => r.json())
          .then(sched => {
            const hist = {}; // abbr → [runScores...]
            for (const dt of sched.dates || []) {
              for (const g of dt.games || []) {
                if (g.status?.detailedState !== 'Final') continue;
                const hAbbr = g.teams?.home?.team?.abbreviation;
                const aAbbr = g.teams?.away?.team?.abbreviation;
                const hScore = g.teams?.home?.score;
                const aScore = g.teams?.away?.score;
                if (hScore == null || aScore == null) continue;
                if (hAbbr) { if (!hist[hAbbr]) hist[hAbbr] = []; hist[hAbbr].push(hScore); }
                if (aAbbr) { if (!hist[aAbbr]) hist[aAbbr] = []; hist[aAbbr].push(aScore); }
              }
            }
            const l10data = {};
            for (const [abbr, runs] of Object.entries(hist)) {
              const last10 = runs.slice(-10);
              if (last10.length < 5) continue;
              const l10Rpg = last10.reduce((s, r) => s + r, 0) / last10.length;
              const seasonRpg = stats[abbr]?.runsPerGame ?? 4.5;
              l10data[abbr] = { l10Rpg: +l10Rpg.toFixed(2), delta: +(l10Rpg - seasonRpg).toFixed(2) };
            }
            if (!cancelled) setTeamL10(l10data);
          }).catch(() => {});

        // 3e. Umpire data for game-level run suppression
        Promise.all([fetchGameUmpires(today), fetchUmpireSeasonStats(season)])
          .then(([umps, umpStats]) => {
            if (!umps || !umpStats) return;
            const umpMap = {};
            for (const g of games) {
              const info = buildUmpireInfo(g.gamePk, umps, umpStats);
              if (info) umpMap[g.gamePk] = info;
            }
            if (!cancelled) setSlateUmpires(umpMap);
          }).catch(() => {});

        // 3f. Weather per game — non-blocking, updates state when all resolve
        Promise.all(games.map(async g => {
          const homeAbbr = g.teams?.home?.team?.abbreviation;
          const coords   = getParkCoords(g.venue?.name, homeAbbr);
          const cfBear   = getParkCfBearing(g.venue?.name, homeAbbr);
          if (!coords) return null;
          let w = null;
          try { w = await getNWSForecast(coords[0], coords[1], g.gameDate, cfBear); } catch { /* NWS optional */ }
          if (!w) { try { w = await getGameWeather(g.gamePk); } catch { /* MLB weather optional */ } }
          return w ? { gamePk: g.gamePk, weather: w } : null;
        })).then(results => {
          const wMap = {};
          for (const r of results) { if (r) wMap[r.gamePk] = r.weather; }
          if (!cancelled) setWeatherByGame(wMap);
        }).catch(() => {});

        // 4. Pitcher FIP + L5 game log for today's starters
        const starterIds = [...new Set(
          games.flatMap(g => [starterFor(g, "home")?.id, starterFor(g, "away")?.id].filter(Boolean))
        )];
        if (starterIds.length > 0) {
          const BATCH = 50;
          const fipMap = {}, l5Map = {};
          for (let i = 0; i < starterIds.length; i += BATCH) {
            const ids = starterIds.slice(i, i + BATCH).join(",");
            // Fetch season + game log in one call
            const pRes = await fetch(`${API}/people?personIds=${ids}&hydrate=stats(group=[pitching],type=[season,gameLog],season=${season})`).then(r => r.json());
            for (const p of pRes.people || []) {
              // Season stats
              const seasonStat = p.stats?.find(s => s.type?.displayName === 'statsSingleSeason');
              const spl = seasonStat?.splits?.[0]?.stat;
              if (spl) {
                const k   = parseInt(spl.strikeOuts  || 0);
                const bb  = parseInt(spl.baseOnBalls || 0);
                const hr  = parseInt(spl.homeRuns    || 0);
                const hbp = parseInt(spl.hitByPitch  || 0);
                const ip  = spl.inningsPitched || "0";
                const era = parseFloat(spl.era || 99);
                const fip = calcFIP(k, bb, hr, hbp, ip);
                fipMap[p.id] = { fip: fip ?? era, era, name: p.fullName };
              }
              // L5 FIP from game log
              const glStat = p.stats?.find(s => s.type?.displayName === 'log');
              const starts = (glStat?.splits || [])
                .filter(s => (parseInt(s.stat?.gamesStarted) || 0) > 0 || (parseFloat(s.stat?.inningsPitched) || 0) >= 3)
                .slice(0, 5);
              if (starts.length >= 2) {
                const l5K = starts.reduce((s, g) => s + parseInt(g.stat?.strikeOuts || 0), 0);
                const l5BB = starts.reduce((s, g) => s + parseInt(g.stat?.baseOnBalls || 0), 0);
                const l5HR = starts.reduce((s, g) => s + parseInt(g.stat?.homeRuns || 0), 0);
                const l5HBP = starts.reduce((s, g) => s + parseInt(g.stat?.hitByPitch || 0), 0);
                const l5IP = starts.reduce((s, g) => {
                  const v = g.stat?.inningsPitched || "0";
                  const pts = String(v).split(".");
                  return s + parseInt(pts[0] || 0) + parseInt(pts[1] || 0) / 3;
                }, 0);
                if (l5IP >= 10) {
                  const l5fip = calcFIP(l5K, l5BB, l5HR, l5HBP, String(Math.floor(l5IP)) + "." + Math.round((l5IP % 1) * 3));
                  if (l5fip != null) l5Map[p.id] = l5fip;
                }
              }
            }
          }
          if (!cancelled) { setPitcherFIP(fipMap); setPitcherL5FIP(l5Map); }
        }

        // 5. Pitcher advanced stats (Pit+, SIERA, FB velo) from Supabase
        try {
          const advMaps = await fetchAdvancedStatsBulk?.(season);
          if (!cancelled) setPitcherAdv(advMaps?.pitchers || {});
        } catch (e) {
          console.warn("[SlateOdds] pitcher advanced stats fetch failed:", e.message);
        }
      } catch (e) {
        console.warn("[SlateOdds] load error:", e.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [season, games.length, probableFor]); // eslint-disable-line react-hooks/exhaustive-deps

  // Build rows
  const allRows = games.map(g => {
    const home     = g.teams?.home;
    const away     = g.teams?.away;
    const homeAbbr = home?.team?.abbreviation;
    const awayAbbr = away?.team?.abbreviation;
    const homeP    = starterFor(g, "home");
    const awayP    = starterFor(g, "away");
    const gamePk   = g.gamePk;
    const gameTime = g.gameDate ? new Date(g.gameDate) : null;
    const status   = g.status?.abstractGameState || "Preview";

    const homePData = pitcherFIP[homeP?.id] || {};
    const awayPData = pitcherFIP[awayP?.id] || {};
    const homeTeam  = teamStats[homeAbbr]   || {};
    const awayTeam  = teamStats[awayAbbr]   || {};

    // ── New signals ────────────────────────────────────────────────────────────
    // True reliever-only ERA (falls back to full-team ERA, then league avg)
    const homeBPERA = bullpenByTeam[homeAbbr] ?? homeTeam.teamERA ?? 4.30;
    const awayBPERA = bullpenByTeam[awayAbbr] ?? awayTeam.teamERA ?? 4.30;

    // L5 FIP for each starter
    const homeL5FIP = homeP?.id ? pitcherL5FIP[homeP.id] ?? null : null;
    const awayL5FIP = awayP?.id ? pitcherL5FIP[awayP.id] ?? null : null;

    // Team L10 run delta (hot/cold team recency signal)
    const homeL10RpgDelta = teamL10[homeAbbr]?.delta ?? null;
    const awayL10RpgDelta = teamL10[awayAbbr]?.delta ?? null;

    // Lineup-specific projected OPS — confirmed lineups only (blend with season OPS in model)
    const computeLineupOPS = (abbr) => {
      const ld = lineupData[abbr];
      if (!ld?.confirmed || !ld.batters?.length) return null;
      const opsList = [];
      for (const b of ld.batters.slice(0, 9)) {
        const proj = findProjection(b.name, abbr, PROJ_BATTERS);
        if (proj?.ops) opsList.push(parseFloat(proj.ops));
      }
      return opsList.length >= 5 ? opsList.reduce((s, v) => s + v, 0) / opsList.length : null;
    };
    const homeLineupOPS = computeLineupOPS(homeAbbr);
    const awayLineupOPS = computeLineupOPS(awayAbbr);

    // Weather run delta — wind direction + temperature effect on total runs
    const weather  = weatherByGame[gamePk] ?? null;
    const homePark = getParkData(homeAbbr);
    let weatherRunDelta = 0;
    if (weather && homePark && !isWeatherNeutral(homePark, weather)) {
      const tempDelta = weather.temp != null ? (weather.temp - 72) * 0.028 : 0;
      const wDir = (weather.windDir || "").toLowerCase();
      const isOut = wDir.includes("out to"), isIn = wDir.includes("in from");
      const windDelta = isOut ? (weather.windSpeed || 0) * 0.038 : isIn ? -(weather.windSpeed || 0) * 0.032 : 0;
      weatherRunDelta = Math.min(2.5, Math.max(-2.5, tempDelta + windDelta));
    }

    // Umpire run adjustment — high-K ump suppresses scoring (~0.3 runs per SD above avg ump)
    const umpInfo = slateUmpires[gamePk] ?? null;
    const umpireRunAdjust = umpInfo?.mult != null ? -(umpInfo.mult - 1.0) * 3.0 : 0;

    // DB advanced stats for both starters (SIERA + Pit+ → quality blend in slateOddsModel)
    const homeAdv = homeP?.id ? pitcherAdv[homeP.id] : null;
    const awayAdv = awayP?.id ? pitcherAdv[awayP.id] : null;

    const model = slateOddsModel({
      homeFIP:           homePData.fip || 4.20,
      awayFIP:           awayPData.fip || 4.20,
      homeL5FIP,
      awayL5FIP,
      homeOPS:           homeTeam.ops  || 0.718,
      awayOPS:           awayTeam.ops  || 0.718,
      homeLineupOPS,
      awayLineupOPS,
      homeBullpenERA:    homeBPERA,
      awayBullpenERA:    awayBPERA,
      parkRunsFactor:    PARK_RUNS[homeAbbr]  || 1.0,
      homeOAA:           teamOAA[homeAbbr]    ?? 0,
      awayOAA:           teamOAA[awayAbbr]    ?? 0,
      homeL10RpgDelta,
      awayL10RpgDelta,
      weatherRunDelta:   weatherRunDelta || null,
      umpireRunAdjust:   umpireRunAdjust || null,
      // Quality signals from Supabase advanced stats (G-7 partial — platoon-adjusted FIP still TBD)
      homeSIERA:         homeAdv?.siera    ?? null,
      awaySIERA:         awayAdv?.siera    ?? null,
      homePitPlus:       homeAdv?.pit_plus ?? null,
      awayPitPlus:       awayAdv?.pit_plus ?? null,
    });

    const odds       = oddsData.length ? getGameOdds(oddsData, away?.team?.name, home?.team?.name) : null;
    const homeMLBest = bestMLOdds(odds?.books, "home");
    const awayMLBest = bestMLOdds(odds?.books, "away");
    const homeSpBest = bestSpreadOdds(odds?.books, "home");
    const awaySpBest = bestSpreadOdds(odds?.books, "away");
    const homeMLEdge = calcEdge(model.homeWinPct, homeMLBest.odds);
    const awayMLEdge = calcEdge(model.awayWinPct, awayMLBest.odds);

    // Best ML side by edge
    const mlPick = homeMLEdge !== null && awayMLEdge !== null
      ? (homeMLEdge >= awayMLEdge ? { side: "home", edge: homeMLEdge } : { side: "away", edge: awayMLEdge })
      : null;

    // Run line — determine spread point from books (default -1.5)
    const spreadPoint = homeSpBest.point ?? -1.5;
    const rlPick = runLinePick(model.margin, homeAbbr, awayAbbr, spreadPoint);
    const rlBest = rlPick ? bestSpreadOdds(odds?.books, rlPick.side) : null;

    // Spread edge: model win probability vs implied spread odds
    // For RL, we use a simple margin vs spread comparison as the edge signal
    const rlMarginEdge = rlPick ? Math.abs(model.margin) - Math.abs(spreadPoint) : null; // how many runs over the spread

    // ── Over/Under pick ──────────────────────────────────────────────────────
    const gameTotal = odds?.gameTotal ?? null;
    const ouEdge = gameTotal != null ? +(model.total - gameTotal).toFixed(2) : null;
    const ouDirection = ouEdge != null ? (ouEdge > 0 ? "over" : "under") : null;
    const bookKeys2 = ["fanduel", "draftkings", "hardrockbet"];
    const ouOddsEntries = ouDirection === "over"
      ? bookKeys2.map(bk => [bk, odds?.books?.[bk]?.overOdds ?? null])
      : bookKeys2.map(bk => [bk, odds?.books?.[bk]?.underOdds ?? null]);
    const ouBest = ouOddsEntries.filter(([, o]) => o != null).sort((a, b) => b[1] - a[1])[0] ?? null;

    // ── Official play gates (per-market) — see gameLineGates in lib/picks.js ──
    const { isMLPlay, isMLEV, isRLPlay, isOUPlay, hasPlay } = gameLineGates({ model, mlPick, rlPick, rlMarginEdge, ouEdge });

    // ── Conviction (display + ranking) — src/lib/conviction.js ───────────────
    // Same gates, restated as "how much of this market's required edge is
    // actually here". conv.ml/rl/ou can never read ≥ the play line without the
    // corresponding isXPlay being true; conviction.test.js grids that.
    const conv = {
      ml: mlConviction({ model, mlPick, isMLPlay }),
      rl: rlConviction({ model, rlPick, rlMarginEdge, isRLPlay }),
      ou: ouConviction({ ouEdge, gameTotal, isOUPlay }),
    };
    const best = bestGameConviction(conv);

    return {
      gamePk, gameTime, status, homeAbbr, awayAbbr,
      homePName: homeP?.fullName || homePData.name || "TBD",
      awayPName: awayP?.fullName || awayPData.name || "TBD",
      homeFIP: +(homePData.fip || 4.20).toFixed(2),
      awayFIP: +(awayPData.fip || 4.20).toFixed(2),
      homeL5FIP, awayL5FIP,
      model, odds, mlPick,
      homeMLBest, awayMLBest,
      homeMLEdge, awayMLEdge,
      homeSpBest, awaySpBest,
      rlPick, rlBest, rlMarginEdge, spreadPoint,
      isMLPlay, isMLEV, isRLPlay, hasPlay,
      gameTotal, ouEdge, ouDirection, ouBest, isOUPlay,
      conv, best,
      // new signal metadata for display
      weather, umpInfo,
      homeL10: teamL10[homeAbbr] ?? null,
      awayL10: teamL10[awayAbbr] ?? null,
      homeLineupOPS, awayLineupOPS,
      weatherRunDelta: weatherRunDelta || null,
      umpireRunAdjust: umpireRunAdjust || null,
    };
  });

  const rows = allRows.filter(r => r.status !== "Final");

  // Expose ALL rows (including Final games) to parent for pick-saving so end-of-day saves work
  useEffect(() => {
    if (!loading && onGamePicksReady) onGamePicksReady(allRows);
  }, [loading, allRows.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sort — unscored rows ("—" in the display) always sink to the bottom regardless of direction.
  // Every conviction case now sorts on exactly the number its cell prints, so the
  // order on screen and the order of the numbers can no longer disagree.
  const sortedRows = [...rows].sort((a, b) => {
    let av, bv, aHas, bHas;
    switch (sortKey) {
      case "time":
        av = a.gameTime?.getTime() || 0; bv = b.gameTime?.getTime() || 0;
        aHas = bHas = true; break;
      case "play":
        aHas = a.best != null; bHas = b.best != null;
        av = a.best?.conf ?? 0; bv = b.best?.conf ?? 0; break;
      case "conf":
        av = Math.abs(a.model.homeWinPct - 0.5); bv = Math.abs(b.model.homeWinPct - 0.5);
        aHas = bHas = true; break;
      case "edge":
        aHas = a.conv.ml.conf != null; bHas = b.conv.ml.conf != null;
        av = a.conv.ml.conf ?? 0; bv = b.conv.ml.conf ?? 0; break;
      case "total":
        av = a.model.total; bv = b.model.total;
        aHas = bHas = true; break;
      case "rlSig":
        aHas = a.conv.rl.conf != null; bHas = b.conv.rl.conf != null;
        av = a.conv.rl.conf ?? 0; bv = b.conv.rl.conf ?? 0; break;
      case "ouSig":
        aHas = a.conv.ou.conf != null; bHas = b.conv.ou.conf != null;
        av = a.conv.ou.conf ?? 0; bv = b.conv.ou.conf ?? 0; break;
      default:
        av = 0; bv = 0; aHas = bHas = true;
    }
    if (aHas !== bHas) return aHas ? -1 : 1; // scored rows first, always
    return (bv - av) * sortDir;
  });

  const filteredRows = filterConf === "all"    ? sortedRows
    : filterConf === "plays"  ? sortedRows.filter(r => r.hasPlay)
    : sortedRows.filter(r => r.model.confidence === filterConf);

  const SortTh = ({ col, label, center, title }) => (
    <th onClick={() => { if (sortKey === col) setSortDir(d => -d); else { setSortKey(col); setSortDir(-1); } }}
      title={title}
      style={{ padding: "8px 10px", fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1,
        color: sortKey === col ? "#2062c8" : "#8b99b0", cursor: "pointer", whiteSpace: "nowrap",
        borderBottom: "1px solid rgba(32,98,200,0.192)", textAlign: center ? "center" : "left" }}>
      {label}{sortKey === col ? (sortDir === -1 ? " ↓" : " ↑") : ""}
    </th>
  );
  const Th = ({ label, center, title }) => (
    <th title={title} style={{ padding: "8px 10px", fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1,
      color: "#8b99b0", borderBottom: "1px solid rgba(32,98,200,0.192)", textAlign: center ? "center" : "left", whiteSpace: "nowrap" }}>
      {label}
    </th>
  );

  if (loading) return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 200, color: "#8b99b0", gap: 10 }}>
      <span style={{ fontSize: 20 }}>⏳</span>
      <span style={{ fontSize: 13 }}>Loading team + pitcher stats…</span>
    </div>
  );

  const playsCount = rows.filter(r => r.hasPlay).length;
  // Rows the model liked on some market and the gates then rejected. Counting
  // these out loud is the point: a quiet slate and a slate full of blocked
  // edges are very different nights, and the page used to look identical.
  const foldedCount = rows.reduce(
    (n, r) => n + Object.values(r.conv).filter(c => c?.folded).length, 0);

  return (
    <div style={{ padding: "16px 20px", maxWidth: 1400, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, flexWrap: "wrap", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 22 }}>🎰</span>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: "#16233c" }}>Slate Odds</div>
            <div style={{ fontSize: 11, color: "#74839d" }}>
              FIP · Team OPS · Park · OAA Defense · {rows.length} game{rows.length !== 1 ? "s" : ""}
              <span style={{ marginLeft: 8, color: "#8b99b0" }}>
                · Conviction 1–10, <span style={{ color: "#0f8a44", fontWeight: 700 }}>🎲 play line {GAME_PLAY_LINE.toFixed(1)}</span> on every market
              </span>
            </div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {[
            { key: "all",    label: "All Games" },
            { key: "plays",  label: `🎲 Plays${playsCount > 0 ? ` (${playsCount})` : ""}` },
            { key: "high",   label: "High Conf" },
            { key: "medium", label: "Med Conf" },
          ].map(f => (
            <button key={f.key} onClick={() => setFilterConf(f.key)} style={{
              padding: "5px 11px", fontSize: 10, borderRadius: 6, cursor: "pointer", fontWeight: filterConf === f.key ? 700 : 500,
              background: filterConf === f.key
                ? (f.key === "plays" ? "rgba(15,138,68,0.15)" : "rgba(32,98,200,0.24)")
                : "transparent",
              color: filterConf === f.key
                ? (f.key === "plays" ? "#0f8a44" : "#2062c8")
                : "#8b99b0",
              border: filterConf === f.key
                ? (f.key === "plays" ? "1px solid rgba(15,138,68,0.35)" : "1px solid rgba(32,98,200,0.3)")
                : "1px solid rgba(32,98,200,0.128)",
            }}>
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* How to read the page — one scale, one line, three markets */}
      <div style={{
        marginBottom: 12, padding: "10px 14px", borderRadius: 10, fontSize: 10, lineHeight: 1.8,
        background: "rgba(32,98,200,0.05)", border: "1px solid rgba(32,98,200,0.14)", color: "#5d6f8b",
      }}>
        <div>
          Each market is scored in units of <strong>its own bar</strong> — how much of the edge it needs does this
          game actually have. <strong style={{ color: "#0f8a44" }}>{GAME_PLAY_LINE.toFixed(1)} = 1.0× the bar</strong>,
          so 🎲 <strong style={{ color: "#0f8a44" }}>PLAY</strong> is exactly "conviction {GAME_PLAY_LINE.toFixed(1)}+"
          on all three, and 10.0 is 2.5× the bar. The bars:{" "}
          <span style={{ fontFamily: "'JetBrains Mono',monospace" }}>
            ML {(ML_REQUIRED_EDGE.high * 100).toFixed(0)}% edge at high conf / {(ML_REQUIRED_EDGE.medium * 100).toFixed(0)}% at medium
            · RL {RL_REQUIRED_EDGE}R of cover · O/U {OU_REQUIRED_EDGE}R of total
          </span>.
        </div>
        <div style={{ marginTop: 3 }}>
          A market can never read {GAME_PLAY_LINE.toFixed(1)}+ without the dice. When the model likes a price but the
          gate says no — a fat moneyline edge on a game it reads as a coin flip, say — the number{" "}
          <em>folds below the line</em> and wears{" "}
          <span style={{ color: TIER_META[TIER.blocked].color, fontWeight: 700 }}>NO PLAY</span>, with the reason on
          hover. <span style={{ color: "#a16207", fontWeight: 700 }}>+EV</span> is a price note only (ML edge &gt;3%),
          never a play.
          {foldedCount > 0 && (
            <span style={{ color: TIER_META[TIER.blocked].color, fontWeight: 700 }}>
              {" "}Tonight: {foldedCount} market{foldedCount !== 1 ? "s" : ""} folded.
            </span>
          )}
        </div>
      </div>

      {filteredRows.length === 0 ? (
        <div style={{ textAlign: "center", color: "#8b99b0", padding: 40, fontSize: 13 }}>
          {filterConf === "plays" ? "No official plays today — check All Games for the leans." : "No games match the current filter."}
        </div>
      ) : (
        <div className="hscroll">
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ background: "rgba(213,222,237,0.7)" }}>
                <SortTh col="time"  label="Time" />
                <Th label="Matchup" />
                <SortTh col="play"  label="Best Play" center title="The strongest scored market on this game — what to look at first" />
                <Th label="Starters · FIP" />
                <Th label="Defense" center />
                <Th label="Proj R" center />
                <SortTh col="conf"  label="Win%" center />
                <Th label="Moneyline" center />
                <SortTh col="edge"  label="ML" center title={`Moneyline conviction — edge ÷ the edge this confidence tier requires. 🎲 at ${GAME_PLAY_LINE.toFixed(1)}`} />
                <Th label="ML Pick" center />
                <SortTh col="rlSig" label="Run Line" center title={`Run-line conviction — runs of cover ÷ the ${RL_REQUIRED_EDGE}R bar. 🎲 at ${GAME_PLAY_LINE.toFixed(1)}`} />
                <Th label="Spread Bet" center />
                <SortTh col="total" label="Total" center />
                <SortTh col="ouSig" label="O/U" center title={`Total conviction — runs of edge ÷ the ${OU_REQUIRED_EDGE}R bar. 🎲 at ${GAME_PLAY_LINE.toFixed(1)}`} />
                <Th label="O/U Bet" center />
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((r, i) => {
                const isHome = r.mlPick?.side === "home";
                const pickAbbr = isHome ? r.homeAbbr : r.awayAbbr;
                const pickEdge = r.mlPick?.edge;
                const pickBest = isHome ? r.homeMLBest : r.awayMLBest;
                const rowBg = i % 2 === 0 ? "rgba(213,222,237,0.35)" : "rgba(225,231,242,0.15)";
                const playGlow = r.hasPlay ? { boxShadow: "inset 3px 0 0 #0f8a44" } : {};

                // Format game time
                const timeStr = r.gameTime
                  ? r.gameTime.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York", hour12: true }).replace(":00", "").toLowerCase()
                  : "—";

                // Per-book ML odds
                const bookKeys = ["fanduel", "draftkings", "hardrockbet"];
                const mlByBook = bookKeys.map(bk => {
                  const d = r.odds?.books?.[bk];
                  return { bk, homeML: d?.homeML ?? null, awayML: d?.awayML ?? null, homeMLLink: d?.homeMLLink ?? null, awayMLLink: d?.awayMLLink ?? null };
                });

                // What the Best Play column names, in words.
                const bestSide = r.best?.market === "ml" ? pickAbbr
                  : r.best?.market === "rl" ? r.rlPick?.label
                  : r.best?.market === "ou" ? `${r.ouDirection === "over" ? "OVER" : "UNDER"} ${r.gameTotal}`
                  : null;

                return (
                  <tr key={r.gamePk} style={{ background: rowBg, borderBottom: "1px solid rgba(32,98,200,0.08)", ...playGlow }}>

                    {/* Time */}
                    <td style={{ padding: "10px 10px", whiteSpace: "nowrap" }}>
                      <div style={{ fontSize: 12, fontFamily: "'JetBrains Mono', monospace", color: "#3c4f6d" }}>{timeStr}</div>
                      {r.status === "Live" && <div style={{ fontSize: 9, color: "#c2570f", fontWeight: 700 }}>LIVE</div>}
                    </td>

                    {/* Matchup */}
                    <td style={{ padding: "10px 10px", whiteSpace: "nowrap" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                        <span style={{ fontSize: 12, color: "#5d6f8b" }}>{r.awayAbbr}</span>
                        <span style={{ fontSize: 10, color: "#b6c5dc" }}>@</span>
                        <span style={{ fontSize: 13, fontWeight: 700, color: "#16233c" }}>{r.homeAbbr}</span>
                      </div>
                    </td>

                    {/* Best Play — the row in one cell */}
                    <td style={{ padding: "10px 10px", textAlign: "center", whiteSpace: "nowrap" }}>
                      {r.best && bestSide ? (
                        <div style={{ display: "inline-flex", flexDirection: "column", alignItems: "center", gap: 1 }}>
                          <span style={{ fontSize: 8, color: "#b6c5dc", letterSpacing: 0.5 }}>{MARKET_LABEL[r.best.market]}</span>
                          <span style={{
                            fontSize: 12, fontWeight: 700,
                            color: r.best.tier === TIER.play ? "#0f8a44" : "#5d6f8b",
                          }}>{bestSide}</span>
                          <ConvictionCell c={r.best} size={13} />
                        </div>
                      ) : <span style={{ color: "#b6c5dc", fontSize: 11 }}>—</span>}
                    </td>

                    {/* Starters + FIP */}
                    <td style={{ padding: "10px 10px", whiteSpace: "nowrap" }}>
                      <div style={{ fontSize: 11, color: "#5d6f8b" }}>
                        {r.awayPName.split(" ").pop()}
                        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: "#8b99b0", marginLeft: 4 }}>{r.awayFIP}</span>
                      </div>
                      <div style={{ fontSize: 11, color: "#3c4f6d", marginTop: 2 }}>
                        {r.homePName.split(" ").pop()}
                        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: "#8b99b0", marginLeft: 4 }}>{r.homeFIP}</span>
                      </div>
                    </td>

                    {/* Defensive adjustment (OAA-based) */}
                    <td style={{ padding: "10px 8px", textAlign: "center" }}>
                      {(() => {
                        const hasOAA = Object.keys(teamOAA).length > 0;
                        if (!hasOAA) return <span style={{ color: "#c9d5e8", fontSize: 9 }}>—</span>;
                        // homeDefMult applied to homeRuns (away defense suppresses home scoring)
                        // awayDefMult applied to awayRuns (home defense suppresses away scoring)
                        const awayDefAdj = ((1 - r.model.homeDefMult) * 100); // positive = away D is good
                        const homeDefAdj = ((1 - r.model.awayDefMult) * 100); // positive = home D is good
                        const fmtAdj = (adj, label) => {
                          const abs = Math.abs(adj);
                          if (abs < 0.15) return (
                            <div style={{ display:"flex", alignItems:"center", gap:3 }}>
                              <span style={{ fontSize:8, color:"#b6c5dc", width:10 }}>{label}</span>
                              <span style={{ fontSize:9, color:"#b6c5dc", fontFamily:"'JetBrains Mono',monospace" }}>—</span>
                            </div>
                          );
                          const color = adj > 0 ? "#0f8a44" : "#d03131";
                          return (
                            <div style={{ display:"flex", alignItems:"center", gap:3 }}>
                              <span style={{ fontSize:8, color:"#b6c5dc", width:10 }}>{label}</span>
                              <span style={{ fontSize:9, fontWeight:700, color, fontFamily:"'JetBrains Mono',monospace" }}>
                                {adj > 0 ? "+" : ""}{adj.toFixed(1)}%
                              </span>
                            </div>
                          );
                        };
                        return (
                          <div style={{ display:"flex", flexDirection:"column", gap:2 }} title="Defensive run suppression via OAA. Positive = above-avg defense (fewer runs allowed).">
                            {fmtAdj(awayDefAdj, "A")}
                            {fmtAdj(homeDefAdj, "H")}
                          </div>
                        );
                      })()}
                    </td>

                    {/* Projected runs */}
                    <td style={{ padding: "10px 10px", textAlign: "center", fontFamily: "'JetBrains Mono', monospace" }}>
                      <div style={{ fontSize: 11, color: "#5d6f8b" }}>{r.model.awayRuns}</div>
                      <div style={{ fontSize: 11, color: "#3c4f6d", marginTop: 2 }}>{r.model.homeRuns}</div>
                    </td>

                    {/* Win % + confidence */}
                    <td style={{ padding: "10px 10px", textAlign: "center" }}>
                      <div style={{ fontSize: 11, color: "#5d6f8b" }}>{(r.model.awayWinPct * 100).toFixed(0)}%</div>
                      <div style={{ fontSize: 11, color: "#3c4f6d", marginTop: 2 }}>{(r.model.homeWinPct * 100).toFixed(0)}%</div>
                      <div style={{ fontSize: 9, marginTop: 3, fontWeight: 700, textTransform: "uppercase",
                        color: r.model.confidence === "high" ? "#0f8a44" : r.model.confidence === "medium" ? "#a16207" : "#b6c5dc" }}>
                        {r.model.confidence}
                      </div>
                    </td>

                    {/* Moneyline by book (away / home) — clickable to sportsbook */}
                    <td style={{ padding: "10px 10px", textAlign: "center" }}>
                      <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
                        {mlByBook.map(({ bk, homeML, awayML, homeMLLink, awayMLLink }) => (
                          <div key={bk} style={{ textAlign: "center", minWidth: 34 }}>
                            <a href={awayMLLink || homeMLLink || BOOK_URLS[bk]} target="_blank" rel="noopener noreferrer"
                              style={{ fontSize: 8, color: GAME_BOOK_COLORS[bk], fontWeight: 700, display: "block", marginBottom: 2, textDecoration: "none" }}>
                              {GAME_BOOK_LABELS[bk]}
                            </a>
                            <a href={awayMLLink || BOOK_URLS[bk]} target="_blank" rel="noopener noreferrer"
                              style={{ fontSize: 10, fontFamily: "'JetBrains Mono', monospace", color: "#5d6f8b", display: "block", textDecoration: "none" }}
                              onMouseEnter={e => e.target.style.color = "#3c4f6d"} onMouseLeave={e => e.target.style.color = "#5d6f8b"}>
                              {fmtOdds(awayML)}
                            </a>
                            <a href={homeMLLink || BOOK_URLS[bk]} target="_blank" rel="noopener noreferrer"
                              style={{ fontSize: 10, fontFamily: "'JetBrains Mono', monospace", color: "#3c4f6d", display: "block", textDecoration: "none" }}
                              onMouseEnter={e => e.target.style.color = "#16233c"} onMouseLeave={e => e.target.style.color = "#3c4f6d"}>
                              {fmtOdds(homeML)}
                            </a>
                          </div>
                        ))}
                      </div>
                    </td>

                    {/* ML conviction */}
                    <td style={{ padding: "10px 8px", textAlign: "center", whiteSpace: "nowrap" }}>
                      <div style={{ display: "inline-flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
                        <ConvictionCell c={r.conv.ml} size={18} stack />
                        <span style={{ fontSize: 8, color: "#b6c5dc", textTransform: "uppercase", letterSpacing: 0.5 }}>
                          {r.model.confidence} conf
                        </span>
                      </div>
                    </td>

                    {/* ML Pick — team, edge, best clickable odds. +EV is a price note, not a play. */}
                    <td style={{ padding: "10px 10px", textAlign: "center", whiteSpace: "nowrap" }}>
                      {r.mlPick ? (
                        <div>
                          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 4 }}>
                            <span style={{ fontSize: 12, fontWeight: 700,
                              color: r.isMLPlay ? "#0f8a44" : r.isMLEV ? "#a16207" : "#5d6f8b" }}>
                              {pickAbbr}
                            </span>
                            <span style={{ fontSize: 10, fontFamily: "'JetBrains Mono', monospace",
                              color: r.isMLPlay ? "#0f8a44" : r.isMLEV ? "#a16207" : "#74839d" }}>
                              {pickEdge != null ? `${pickEdge > 0 ? "+" : ""}${(pickEdge * 100).toFixed(1)}%` : ""}
                            </span>
                            {r.isMLPlay && <span title="Official ML play" style={{ fontSize: 11, lineHeight: 1 }}>🎲</span>}
                            {r.isMLEV && !r.isMLPlay && (
                              <span title="Price note only: the model's edge clears 3% but not this confidence tier's play bar. Not a play, not saved to Results."
                                style={{ fontSize: 9, color: "#a16207", fontWeight: 700, background: "rgba(161,98,7,0.1)", border: "1px solid rgba(161,98,7,0.2)", borderRadius: 3, padding: "0 4px", cursor: "help" }}>+EV</span>
                            )}
                          </div>
                          {pickBest.odds != null && (
                            <a href={(isHome ? r.odds?.books?.[pickBest.book]?.homeMLLink : r.odds?.books?.[pickBest.book]?.awayMLLink) || BOOK_URLS[pickBest.book] || "#"} target="_blank" rel="noopener noreferrer"
                              style={{ fontSize: 10, fontFamily: "'JetBrains Mono', monospace", marginTop: 2, display: "inline-block",
                                color: GAME_BOOK_COLORS[pickBest.book] || "#8b99b0", textDecoration: "none" }}>
                              {fmtOdds(pickBest.odds)}
                              <span style={{ fontSize: 8, color: "#8b99b0", marginLeft: 3 }}>{GAME_BOOK_LABELS[pickBest.book]}</span>
                            </a>
                          )}
                        </div>
                      ) : <span style={{ color: "#b6c5dc", fontSize: 11 }}>—</span>}
                    </td>

                    {/* Run-line conviction */}
                    <td style={{ padding: "10px 8px", textAlign: "center", whiteSpace: "nowrap" }}>
                      {r.conv.rl.conf == null ? <span style={{ color: "#b6c5dc", fontSize: 10 }}>—</span> : (
                        <div style={{ display: "inline-flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
                          <ConvictionCell c={r.conv.rl} size={18} stack />
                          <span style={{ fontSize: 9, color: "#5d6f8b", fontFamily: "'JetBrains Mono', monospace", fontWeight: 600 }}>
                            {r.model.margin > 0 ? "+" : ""}{r.model.margin.toFixed(1)}R proj
                          </span>
                          <span style={{ fontSize: 8, color: "#8b99b0" }}>
                            {Math.abs(r.model.margin) > Math.abs(r.spreadPoint ?? -1.5) ? "covers" : "misses"}{" "}
                            {(r.spreadPoint ?? -1.5) > 0 ? "+" : ""}{(r.spreadPoint ?? -1.5).toFixed(1)} line
                          </span>
                        </div>
                      )}
                    </td>

                    {/* Spread Bet — per-book spread odds for RL pick side */}
                    <td style={{ padding: "10px 10px", textAlign: "center", whiteSpace: "nowrap" }}>
                      {r.rlPick ? (
                        <div>
                          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 4, marginBottom: 3 }}>
                            <span style={{ fontSize: 12, fontWeight: 700, color: r.isRLPlay ? "#a16207" : "#3c4f6d" }}>
                              {r.rlPick.label}
                            </span>
                            {r.isRLPlay && <span title="Official RL play" style={{ fontSize: 11, lineHeight: 1 }}>🎲</span>}
                          </div>
                          <div style={{ display: "flex", gap: 7, justifyContent: "center" }}>
                            {bookKeys.map(bk => {
                              const d = r.odds?.books?.[bk];
                              const spr = r.rlPick.side === "home" ? d?.homeSpread : d?.awaySpread;
                              if (!spr) return null;
                              return (
                                <div key={bk} style={{ textAlign: "center" }}>
                                  <div style={{ fontSize: 8, color: GAME_BOOK_COLORS[bk], fontWeight: 700, marginBottom: 1 }}>{GAME_BOOK_LABELS[bk]}</div>
                                  <a href={spr.link || BOOK_URLS[bk]} target="_blank" rel="noopener noreferrer"
                                    style={{ fontSize: 10, fontFamily: "'JetBrains Mono', monospace", color: "#4c5f7d", textDecoration: "none" }}
                                    onMouseEnter={e => e.target.style.color = "#16233c"} onMouseLeave={e => e.target.style.color = "#4c5f7d"}>
                                    {fmtOdds(spr.price)}
                                  </a>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ) : <span style={{ color: "#b6c5dc", fontSize: 11 }}>—</span>}
                    </td>

                    {/* Projected total */}
                    <td style={{ padding: "10px 10px", textAlign: "center", fontFamily: "'JetBrains Mono', monospace" }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: "#a16207" }}>{r.model.total}</span>
                    </td>

                    {/* O/U conviction */}
                    <td style={{ padding: "10px 8px", textAlign: "center", whiteSpace: "nowrap" }}>
                      {r.conv.ou.conf == null ? <span style={{ color: "#b6c5dc", fontSize: 10 }}>—</span> : (
                        <div style={{ display: "inline-flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
                          <ConvictionCell c={r.conv.ou} size={18} stack />
                          <span style={{ fontSize: 9, color: "#5d6f8b", fontFamily: "'JetBrains Mono', monospace", fontWeight: 600 }}>
                            {r.ouDirection === "over" ? "▲" : "▼"} proj {(r.gameTotal + r.ouEdge).toFixed(1)}R
                          </span>
                          <span style={{ fontSize: 8, color: "#8b99b0" }}>vs mkt {r.gameTotal}</span>
                        </div>
                      )}
                    </td>

                    {/* O/U Bet — per-book over/under odds */}
                    <td style={{ padding: "10px 10px", textAlign: "center", whiteSpace: "nowrap" }}>
                      {r.ouEdge != null && r.gameTotal != null ? (
                        <div>
                          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 4, marginBottom: 3 }}>
                            <span style={{ fontSize: 12, fontWeight: 700, color: r.isOUPlay ? "#6d4fd0" : "#3c4f6d" }}>
                              {r.ouDirection === "over" ? "OVER" : "UNDER"} {r.gameTotal}
                            </span>
                            {r.isOUPlay && <span title="Official O/U play" style={{ fontSize: 11, lineHeight: 1 }}>🎲</span>}
                          </div>
                          <div style={{ display: "flex", gap: 7, justifyContent: "center" }}>
                            {bookKeys.map(bk => {
                              const d = r.odds?.books?.[bk];
                              const odds2 = r.ouDirection === "over" ? d?.overOdds : d?.underOdds;
                              const link = r.ouDirection === "over" ? d?.overLink : d?.underLink;
                              if (odds2 == null) return null;
                              return (
                                <div key={bk} style={{ textAlign: "center" }}>
                                  <div style={{ fontSize: 8, color: GAME_BOOK_COLORS[bk], fontWeight: 700, marginBottom: 1 }}>{GAME_BOOK_LABELS[bk]}</div>
                                  <a href={link || BOOK_URLS[bk]} target="_blank" rel="noopener noreferrer"
                                    style={{ fontSize: 10, fontFamily: "'JetBrains Mono', monospace", color: "#4c5f7d", textDecoration: "none" }}
                                    onMouseEnter={e => e.target.style.color = "#16233c"} onMouseLeave={e => e.target.style.color = "#4c5f7d"}>
                                    {fmtOdds(odds2)}
                                  </a>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ) : <span style={{ color: "#b6c5dc", fontSize: 11 }}>—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Footer */}
      <div style={{ marginTop: 14, fontSize: 10, color: "#b6c5dc", lineHeight: 1.7 }}>
        Model: starter FIP (from MLB API K/BB/HR/IP) + team season OPS + park HR factor + bullpen ERA proxy. Backtest: April 2026, 381 games.
        Gates are unchanged from the pre-conviction page — only the number you rank on moved.
        Spread odds populate after next morning cron if not shown.
      </div>
    </div>
  );
}
