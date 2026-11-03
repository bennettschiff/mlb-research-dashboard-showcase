import { useState, useEffect, useCallback, useRef, useMemo, Component } from "react";

// ── Extracted modules ──────────────────────────────────────────────────────────
import { API, APP_TIME_ZONE, formatDateInTimeZone, getTodayInAppTimeZone, getHourInTimeZone, fetchJson, formatOdds, normName, getTeamColor } from './lib/utils.js';
import { sbGet, sbGetAllPages, sbPost, sbPatch, apiFreshUrl } from './lib/supa.js';
import { isDeadGame, gameTeamAbbrs, SCHEDULE_STATUS_PARAMS } from './lib/gameStatus.js';
import { postScanResults, isScanCacheable, loadCachedScan } from './lib/scanCache.js';
import { PROJ_BATTERS, PROJ_PITCHERS, normalizeName, findProjection, getBatterProj, getPitcherProj, pitcherProjRates } from './lib/projections.js';
import { PARK_DATA, PARK_COORDS, PARK_CF_BEARING, PARK_CITIES, METRO_AREAS, _ABBREV_ALIASES, getParkData, getParkCoords, getParkCfBearing, computePlayerFlags } from './lib/parks.js';
import { getGameWeather, getNWSForecast, tempFactor, windFactor, isWeatherNeutral, getRoofStatus, parkWeatherMult, PARK_MODEL_BY_MARKET } from './lib/weather.js';
import { bayesRate, blend, bvpWeighted, oddsToImplied, probToAmericanOdds, normalCDF, poissonGTE, ouSideProb, directionalModelProb, modelImpliedProb, computeArsenalMatchup, computeBatterDisciplineMult, computeBatterKVulnerability, computeGameEnvMult, computePullParkMult, computeRestDays, battingOrderPAMult, modelHits, modelHR, modelSingle, modelDouble, modelTriple, modelPitcherK, modelPitcherKv2, modelSB, modelTB, modelHRR, computeRBIModel, findBestLine, calcEVFromOdds, bestBookOdds, calcKConfidence, computeExpectedStatsLuck, computeBattedBallHRMult, computeHRLuckMult, computeAttackAngleMult, attackAngleLevelHRR } from './lib/models.js';
import { BOARD_CONFIGS, calcConfidence, batterPickUnits, isOfficialPick, isBoardActionable, isSbWatch, isOfficialKsPick, ksPickDirection, ksPickUnits, ksSignalVsLine, PICK_UNIT_COLORS } from './lib/picks.js';
import { savedPicksParams } from './lib/pickQueries.js';
import { ipToDec } from './lib/innings.js';
import { normalizeRWAbbr, rwNameFromHref, matchPitcherByName } from './lib/rotowire.js';
import { fetchGameUmpires, fetchUmpireSeasonStats, buildUmpireInfo, computeUmpireMult } from './lib/umpires.js';
// The rest of the game-line surface (slateOddsModel, calcFIP, calcEdge, book
// colors, runLinePick, gameLineGates) left with SlateOddsTab — see
// src/components/SlateOdds.jsx.
import { getGameOdds } from './lib/gameOdds.js';
import { tagPick } from './modelVersions.js';
import { buildHealthLookup, setActiveHealthLookup, getActiveHealthLookup, applyProbShift } from './lib/marketHealth.js';
import BaserunningCard from './components/BaserunningCard.jsx';
import PlayerHeadshot from './components/PlayerHeadshot.jsx';
import SportSwitcher from './components/SportSwitcher.jsx';
import Loader from './components/Loader.jsx';
import LeadersBoard from './components/LeadersBoard.jsx';
import GoldenBoard from './components/GoldenBoard.jsx';
import PayrollBoard from './components/PayrollBoard.jsx';
import ModelBreakdown from './components/ModelBreakdown.jsx';
import ModelGate from './components/ModelGate.jsx';
import PasswordGate from './components/PasswordGate.jsx';
import KellyBadge from './components/KellyBadge.jsx';
import ControllerStatus from './components/ControllerStatus.jsx';
import PipelineHealth from './components/PipelineHealth.jsx';
import BrainTrust from './components/BrainTrust.jsx';
import ResultsTab from './components/results/ResultsTab.jsx';
import BatterBoardTabs, { BATTER_BOARDS } from './components/BatterBoardTabs.jsx';
import KsBoard from './components/KsBoard.jsx';
import PitcherPropsBoard from './components/PitcherPropsBoard.jsx';
import { loadPitchlab, pitcherPropCall, PITCHER_PROPS, ladderMean, sideProbs } from './lib/pitchlab.js';
import BatterArsenalSummary from './components/BatterArsenalSummary.jsx';
import { usePlayerInjury, InjuryBadge, InjuryLine } from './components/InjuryStatus.jsx';
import PlayerFlagBadges from './components/PlayerFlagBadges.jsx';
import OddsLink, { BOOK_COLORS, BOOK_ABBR, BOOK_NAMES } from './components/OddsLink.jsx';
import PropsBoard from './components/PropsBoard.jsx';
import SlateOdds from './components/SlateOdds.jsx';
import FirstInning from './components/FirstInning.jsx';
import PitcherKProjection from './components/PitcherKProjection.jsx';
import StatcastCard from './components/StatcastCard.jsx';
import PROMOTIONS from './data/promotions.json';
import BatterPanel from './components/BatterPanel.jsx';
import { BEAT_REPORTERS, CollapsibleSection, ContractLine, GameLogTable, MLB_TEAM_IDS, MatchupZoneChart, MiniStat, PITCH_COLORS, PITCH_COLORS_ZONE, PITCH_LABELS, PitchBreakdownTable, PitchMovementChart, PlayerGiveaways, PropBarChart, Section, SplitsTable, StatBox, ZONE_PITCH_LABELS, _timeAgo, fmtAvg, useIsMobile } from './components/PanelKit.jsx';
import { PITCH_TYPE_TO_CUSTOM_COL, _getPitcherStatcastCsv, _normPropName, _proxiedFetch, fetchText, getBasestealingRunValue, getBattedBall, getBatterBaserunning, getBatterHotZones, getBatterPowerStats, getBatterSprintStats, getCatcherPopTimesMap, getExpectedStats, getGameLog, getGameLogStat, getHomeRunStats, getPitchArsenal, getPitcherPitchLocations, getPitcherRunningGame, getPlateDiscipline, getPlayerBio, getPlayerNews, getSeasonStats, getSplits, getStatcastBatterVsPitch, getStatcastBatterVsPitchByHand, getSwingPathAttackAngle, getSwingTake, getTeamBullpenHold, getTeamRoster, getVsPitcher, parseCSVText } from './lib/mlbData.js';

// PICK_UNIT_COLORS moved to src/lib/picks.js (imported above) — 2026-07-06 PropsBoard extraction.

// ── Error Boundary ───────────────────────────────────────────────────────────
// One bad API payload in one section shouldn't white-screen the whole dashboard.
// resetKey (e.g. the current page) auto-clears the error when the user navigates away.
class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error(`[ErrorBoundary] ${this.props.label || "section"} crashed:`, error, info?.componentStack);
  }
  componentDidUpdate(prevProps) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ margin: 20, padding: 20, background: "#eef1f8", border: "1px solid #d0313155", borderRadius: 12 }}>
          <div style={{ fontWeight: 700, marginBottom: 6, color: "#d03131" }}>
            ⚠️ {this.props.label || "This section"} hit an error
          </div>
          <div style={{ fontSize: 12, color: "#5d6f8b", marginBottom: 10, fontFamily: "'JetBrains Mono',monospace" }}>
            {String(this.state.error?.message || this.state.error)}
          </div>
          <button onClick={() => this.setState({ error: null })}
            style={{ background: "#dde5f2", color: "#243247", border: "1px solid #b6c5dc", borderRadius: 8, padding: "6px 14px", cursor: "pointer", fontSize: 13 }}>
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ── SUPABASE ──────────────────────────────────────────────────────────────────
// sbFetch/sbGet/sbPost/sbPatch + apiFreshUrl moved to src/lib/supa.js
// 2026-08-10, for the same reason accessCodeHeader moved to utils in 2026-08:
// extracted components need to read and write without importing back into App.

// Emoji flag badges rendered next to player names
// PlayerFlagBadges moved to src/components/PlayerFlagBadges.jsx (2026-07-06 dissolution).



// ══════════════════════════════════════════════════════════
// ── HELPERS & UI COMPONENTS ──
// ══════════════════════════════════════════════════════════

const fmt = (v, d = 3) => (v != null && v !== "" ? Number(v).toFixed(d) : "—");
const getSeason = (dateStr) => parseInt(dateStr.split("-")[0], 10);
const CLIENT_MARKET_TTL = 5 * 60 * 1000; // per-tab memory only; reloads ask our server again

async function fetchApiJson(path, fallback) {
  try {
    const res = await fetch(apiFreshUrl(path), {
      cache: "no-store",
      headers: { "Cache-Control": "no-cache" },
    });
    return res.ok ? res.json() : fallback;
  } catch {
    return fallback;
  }
}

// ── The Odds API — moneyline & spread for MLB games ──
const _oddsCache = new Map();
const ODDS_TTL = CLIENT_MARKET_TTL;
async function fetchMLBOdds() {
  const dateKey = getTodayInAppTimeZone();
  // Check in-memory cache first
  const mem = _oddsCache.get("mlb");
  if (mem?.dateKey === dateKey && Date.now() - mem.ts < ODDS_TTL) return mem.data;
  // Fetch fresh
  try {
    const data = await fetchApiJson("/api/odds?type=games", []);
    const entry = { dateKey, ts: Date.now(), data };
    _oddsCache.set("mlb", entry);
    return data;
  } catch { return []; }
}
// getGameOdds + BOOK_URLS moved to src/lib/gameOdds.js (2026-08-14 SlateOdds extraction).
// formatOdds moved to src/lib/utils.js (2026-07-06 PropsBoard extraction).

// ── Player Props Odds API integration ──────────────────────────────────────────
// Prop type → Odds API market keys (standard + alternate)
const PROP_MARKET_KEYS = {
  hits:   { std: "batter_hits",           alt: "batter_hits_alternate" },
  hits15: { std: "batter_hits",           alt: "batter_hits_alternate" },
  hr:     { std: "batter_home_runs",      alt: "batter_home_runs_alternate" },
  tb:     { std: "batter_total_bases",    alt: "batter_total_bases_alternate" },
  hrr:    { std: "batter_hits_runs_rbis", alt: "batter_hits_runs_rbis_alternate" },
  sb:     { std: "batter_stolen_bases",   alt: "batter_stolen_bases_alternate" },
  rbi:    { std: "batter_rbis",           alt: "batter_rbis_alternate" },
  ks:     { std: "pitcher_strikeouts",    alt: "pitcher_strikeouts_alternate" },
};
const PROP_PROPS_TTL = CLIENT_MARKET_TTL;

// Build map: normName → marketKey → line → { fanduel, draftkings, hardrockbet }
// Over prices stored under marketKey; Under prices under marketKey + "__under"
function buildPropOddsMap(eventsData) {
  const map = {};
  for (const event of (eventsData || [])) {
    for (const bookmaker of (event.bookmakers || [])) {
      const bk = bookmaker.key;
      for (const market of (bookmaker.markets || [])) {
        const mk = market.key;
        for (const outcome of (market.outcomes || [])) {
          const isOver = outcome.name === "Over";
          const isUnder = outcome.name === "Under";
          if (!isOver && !isUnder) continue;
          const nn = _normPropName(outcome.description);
          const line = outcome.point;
          if (line == null) continue;
          if (!map[nn]) map[nn] = { __displayName: outcome.description };
          // Deepest available link wins: outcome → market → event → null
          const link = outcome.link || market.link || event.link || null;
          if (isOver) {
            if (!map[nn][mk]) map[nn][mk] = {};
            if (!map[nn][mk][line]) map[nn][mk][line] = {};
            map[nn][mk][line][bk] = { price: outcome.price, link, sid: outcome.sid || null };
          } else {
            // Store under prices in parallel namespace: marketKey + "__under"
            const underKey = mk + "__under";
            if (!map[nn][underKey]) map[nn][underKey] = {};
            if (!map[nn][underKey][line]) map[nn][underKey][line] = {};
            map[nn][underKey][line][bk] = { price: outcome.price, link, sid: outcome.sid || null };
          }
        }
      }
    }
  }
  return map;
}

// Fallback URLs per book+prop when API doesn't provide a deeplink
const DK_SUBCATEGORY = {
  hits: "hits", hits15: "hits", hr: "home-runs", tb: "total-bases",
  hrr: "hits-runs-and-rbis", sb: "stolen-bases", rbi: "rbis", ks: "pitcher-strikeouts",
};
function buildBookFallbackUrl(bookKey, boardKey) {
  switch (bookKey) {
    case "fanduel":    return "https://sportsbook.fanduel.com/baseball/mlb";
    case "draftkings": {
      const sub = DK_SUBCATEGORY[boardKey];
      return sub
        ? `https://sportsbook.draftkings.com/leagues/baseball/mlb?category=player-props&subcategory=${sub}`
        : "https://sportsbook.draftkings.com/leagues/baseball/mlb?category=player-props";
    }
    case "hardrockbet":return "https://www.hardrockbet.com/sports/baseball";
    default:           return null;
  }
}

// Look up book odds (prices) for a player/line given standard+alternate market keys
function lookupBookOdds(propOddsMap, playerName, stdKey, altKey, line) {
  if (!propOddsMap || !playerName) return null;
  const nn = _normPropName(playerName);
  const pd = propOddsMap[nn];
  if (!pd) return null;
  const BOOKS = ["fanduel", "draftkings", "hardrockbet"];
  const result = {};
  let any = false;
  for (const bk of BOOKS) {
    let entry = pd[stdKey]?.[line]?.[bk] ?? null;
    if (entry == null && altKey) entry = pd[altKey]?.[line]?.[bk] ?? null;
    // entry is { price, link } or null
    const price = entry?.price ?? null;
    result[bk] = price;
    if (price != null) any = true;
  }
  return any ? result : null;
}

// Look up UNDER book odds for a player/line (for K unders and future use)
function lookupUnderBookOdds(propOddsMap, playerName, stdKey, altKey, line) {
  if (!propOddsMap || !playerName) return null;
  const nn = _normPropName(playerName);
  const pd = propOddsMap[nn];
  if (!pd) return null;
  const BOOKS = ["fanduel", "draftkings", "hardrockbet"];
  const result = {};
  let any = false;
  for (const bk of BOOKS) {
    let entry = pd[stdKey + "__under"]?.[line]?.[bk] ?? null;
    if (entry == null && altKey) entry = pd[altKey + "__under"]?.[line]?.[bk] ?? null;
    const price = entry?.price ?? null;
    result[bk] = price;
    if (price != null) any = true;
  }
  return any ? result : null;
}

// Find the actual book line for a player from propOddsMap — picks the line with most book coverage
// Used to override the model-derived line (Math.floor(xK)+0.5) with the real market line
function findActualBookLine(propOddsMap, playerName, stdKey, altKey) {
  const nn = _normPropName(playerName || "");
  const pd = propOddsMap?.[nn];
  if (!pd) return null;
  const BOOKS = ["fanduel", "draftkings", "hardrockbet"];
  const lineVotes = {};
  for (const mk of [stdKey, altKey].filter(Boolean)) {
    const mkData = pd[mk] || {};
    for (const [lineStr, bookData] of Object.entries(mkData)) {
      const line = parseFloat(lineStr);
      if (isNaN(line)) continue;
      const count = BOOKS.filter(b => bookData[b]?.price != null).length;
      if (count > 0) lineVotes[line] = (lineVotes[line] || 0) + count;
    }
  }
  const entries = Object.entries(lineVotes);
  if (entries.length === 0) return null;
  // Return the line with the most book coverage (ties broken by lower line = standard market)
  return parseFloat(entries.sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0]);
}

// Look up API deeplinks for a player/line — falls back to book's prop category page.
// side="over" (default) reads stdKey/altKey; side="under" reads the parallel "__under" namespace
// populated by buildPropOddsMap so the user lands on the correct over/under bet slip.
function lookupBookLinks(propOddsMap, playerName, stdKey, altKey, line, boardKey, side = "over") {
  const nn = _normPropName(playerName || "");
  const pd = propOddsMap?.[nn];
  const BOOKS = ["fanduel", "draftkings", "hardrockbet"];
  const suffix = side === "under" ? "__under" : "";
  const stdK = stdKey ? stdKey + suffix : null;
  const altK = altKey ? altKey + suffix : null;
  const result = {};
  for (const bk of BOOKS) {
    let entry = stdK ? (pd?.[stdK]?.[line]?.[bk] ?? null) : null;
    if (entry == null && altK) entry = pd?.[altK]?.[line]?.[bk] ?? null;

    if (bk === "hardrockbet") {
      // Hard Rock: use sid to build their working deeplink scheme
      const sid = entry?.sid;
      result[bk] = sid
        ? `https://share.hardrock.bet/Pt0T/bet?deep_link_value=hardrock://betslip/${sid}`
        : entry?.link || buildBookFallbackUrl(bk, boardKey);
    } else {
      // FanDuel, DraftKings: use API link, fall back to prop category page
      result[bk] = entry?.link || buildBookFallbackUrl(bk, boardKey);
    }
  }
  return result;
}

// Find all lines a book has for a player (standard + alternate merged)
function getAllLinesFromMap(propOddsMap, playerName, stdKey, altKey) {
  if (!propOddsMap || !playerName) return [];
  const nn = _normPropName(playerName);
  const pd = propOddsMap[nn];
  if (!pd) return [];
  const lineSet = new Set();
  for (const mk of [stdKey, altKey]) {
    if (!mk || !pd[mk]) continue;
    for (const line of Object.keys(pd[mk])) lineSet.add(parseFloat(line));
  }
  return [...lineSet].sort((a, b) => a - b);
}

async function fetchMLBPlayerProps() {
  const dateKey = getTodayInAppTimeZone();
  // Memory cache
  const mem = _oddsCache.get("mlb_props");
  if (mem?.dateKey === dateKey && Date.now() - mem.ts < PROP_PROPS_TTL) return mem.data;

  try {
    const propResponses = await fetchApiJson("/api/odds?type=props", []);
    const data = buildPropOddsMap(propResponses.filter(Boolean));
    const entry = { dateKey, ts: Date.now(), data };
    _oddsCache.set("mlb_props", entry);
    return data;
  } catch { return {}; }
}

// A game counts as "started" only once a pitch has actually been thrown.
// The MLB Stats API flips abstractGameState to "Live" during "Warmup"
// (statusCode "PW", ~10-15 min BEFORE first pitch), so testing
// abstractGameState !== "Preview" hides games that haven't started yet.
// Treat Warmup as not started UNTIL its scheduled first pitch passes — MLB
// also leaves games in "Warmup" at and just after first pitch, so a pure
// detailedState check would keep just-started games visible (and hide the
// Hide-Started toggle, since startedCount stays 0). gameDate breaks the tie.
function isGameStarted(status, gameDate) {
  const abs = status?.abstractGameState;
  if (abs === "Final") return true;
  if (abs !== "Live") return false; // Preview: Scheduled / Pre-Game / Delayed Start
  // abstractGameState === "Live":
  if (status?.detailedState !== "Warmup") return true; // In Progress / etc.
  // Warmup: only "started" once the scheduled first pitch time has passed,
  // so the pre-first-pitch warmup window stays visible but a lingering-Warmup
  // game that has actually begun is still counted.
  return gameDate != null && Date.now() >= new Date(gameDate).getTime();
}

// Enrich scanData picks with bookOdds from propOddsMap
function isGameLocked(player) {
  return isGameStarted(player?.game?.status, player?.game?.gameDate);
}

// Pitch Lab pitcher props (outs / hits allowed / walks / ER) against today's book lines.
// One call per prop: the line with the most book coverage, both sides' prices, and
// pitcherPropCall's side + calibrated probability + raw-score official flag.
function buildPitcherProps(p, propOddsMap) {
  const pl = p.pitchlabProps;
  if (!pl) return null;
  const out = {};
  for (const [propType, mk] of Object.entries(PITCHER_PROPS)) {
    const dist = pl[mk.key];
    if (!dist) continue;
    const bookLine = propOddsMap ? findActualBookLine(propOddsMap, p.name, mk.std, mk.alt) : null;
    const call = pitcherPropCall(dist, bookLine, pl.gates?.[mk.key], bookLine != null);
    if (!call) continue;
    const overOdds = bookLine != null ? lookupBookOdds(propOddsMap, p.name, mk.std, mk.alt, bookLine) : null;
    const underOdds = bookLine != null ? lookupUnderBookOdds(propOddsMap, p.name, mk.std, mk.alt, bookLine) : null;
    out[propType] = {
      ...call, hasBookLine: bookLine != null, mean: dist.mean ?? ladderMean(dist.ge),
      overOdds, underOdds, sideOdds: call.side === "under" ? underOdds : overOdds,
    };
  }
  return Object.keys(out).length ? out : null;
}

function enrichScanData(scanData, propOddsMap) {
  if (!scanData || !propOddsMap || Object.keys(propOddsMap).length === 0) return scanData;

  // Line to use per board key
  const boardLine = (boardKey, p) => {
    switch (boardKey) {
      case "hits":   return 0.5;
      case "hits15": return 1.5;
      case "hr":     return 0.5;
      case "tb":     return p.bestLine?.line ?? findBestLine(p.score, 'tb').line;
      case "hrr":    return p.bestLine?.line ?? findBestLine(p.score, 'hrr').line;
      case "sb":     return 0.5;
      case "rbi":    return 0.5;
      default:       return findBestLine(p.score, boardKey).line;
    }
  };

  // Enrich every pick (no lock filter) so saveTodayPicks can capture the full
  // slate even when the auto-save fires after games have started. The display
  // (byModel) gets the locked-game filter applied afterward; byModelAll keeps
  // every enriched pick so save flows are independent of when they fire.
  const enrichedByModel = {};
  for (const [boardKey, picks] of Object.entries(scanData.byModel || {})) {
    const mkt = PROP_MARKET_KEYS[boardKey];
    enrichedByModel[boardKey] = (picks || []).map(p => {
      if (!mkt) return p;

      // HRR: determine the actual market line (O1.5 vs O2.5) then optionally
      // override with O1.5 if the model shows a strong EV edge there.
      // HRR + TB lines are never O0.5 — books always post O1.5 or O2.5 as the main line.
      //
      // Market line detection (in priority order):
      //   1. HardRock oracle — HR only posts the main/primary line, never alts.
      //      Check O1.5 first, then O2.5; whichever HR has = market line.
      //   2. FD+DK coverage count — line with more book postings wins; O1.5 wins ties.
      //   3. Model -180 proxy fallback (no odds available at all).
      //
      // EV override: if market line is O2.5 but model has valid probability data and
      // O1.5 EV is higher, switch to O1.5 (the "ease my mind" scenario).
      if (boardKey === "hrr" || boardKey === "tb") {
        const nn = _normPropName(p.name);
        const pd = propOddsMap[nn];

        // Step 1: HardRock oracle
        let marketLine = null;
        if (pd) {
          for (const line of [1.5, 2.5]) {
            for (const mk of [mkt.std, mkt.alt]) {
              if (pd[mk]?.[line]?.hardrockbet?.price != null) { marketLine = line; break; }
            }
            if (marketLine != null) break;
          }
        }

        // Step 2: FD+DK coverage count (ignore O0.5)
        if (marketLine == null && pd) {
          const votes = {};
          for (const mk of [mkt.std, mkt.alt]) {
            for (const [ls, bookData] of Object.entries(pd[mk] || {})) {
              const l = parseFloat(ls);
              if (isNaN(l) || l < 1.0) continue;
              const n = ["fanduel", "draftkings"].filter(b => bookData[b]?.price != null).length;
              if (n > 0) votes[l] = (votes[l] || 0) + n;
            }
          }
          if (Object.keys(votes).length) {
            marketLine = Object.entries(votes).reduce((best, [l, n]) => {
              const line = parseFloat(l);
              if (!best || n > best.n || (n === best.n && line < best.line)) return { line, n };
              return best;
            }, null)?.line ?? null;
          }
        }

        // Step 3: model -180 proxy fallback
        if (marketLine == null) marketLine = p.bestLine?.line ?? 1.5;

        // EV override: if market is O2.5 and model data is valid, check if O1.5 is better value
        let selectedLine = marketLine;
        if (marketLine === 2.5 && p.impliedProb15 != null && p.impliedProb25 != null) {
          const odds15 = lookupBookOdds(propOddsMap, p.name, mkt.std, mkt.alt, 1.5);
          const odds25 = lookupBookOdds(propOddsMap, p.name, mkt.std, mkt.alt, 2.5);
          const best15 = bestBookOdds(odds15);
          const best25 = bestBookOdds(odds25);
          if (best15 != null && best25 != null) {
            const ev15 = calcEVFromOdds(p.impliedProb15, best15);
            const ev25 = calcEVFromOdds(p.impliedProb25, best25);
            if (ev15 > ev25) selectedLine = 1.5;
          }
        }

        const selectedOdds = lookupBookOdds(propOddsMap, p.name, mkt.std, mkt.alt, selectedLine);
        const selectedImpliedProb = selectedLine === 1.5 ? p.impliedProb15 : p.impliedProb25;

        const bookLinks = lookupBookLinks(propOddsMap, p.name, mkt.std, mkt.alt, selectedLine, boardKey);
        return {
          ...p,
          ...(selectedOdds ? { bookOdds: selectedOdds } : {}),
          bookLinks,
          bookLine: selectedLine,
          impliedProb: selectedImpliedProb ?? p.impliedProb,
        };
      }

      const line = boardLine(boardKey, p);
      const bookOdds = lookupBookOdds(propOddsMap, p.name, mkt.std, mkt.alt, line);
      const bookLinks = lookupBookLinks(propOddsMap, p.name, mkt.std, mkt.alt, line, boardKey);
      if (!bookOdds) return { ...p, bookLinks, bookLine: line };
      return { ...p, bookOdds, bookLinks, bookLine: line };
    });
  }

  const enrichedPitchers = (scanData.pitchers || []).map(p => {
    const mkt = PROP_MARKET_KEYS.ks;
    // Use the actual book line (most-covered line across books) instead of model-derived floor+0.5.
    // Falls back to the model-derived line when no book odds exist yet.
    const actualLine = findActualBookLine(propOddsMap, p.name, mkt.std, mkt.alt);
    const bookLine = actualLine ?? p.line;
    const bookOdds = lookupBookOdds(propOddsMap, p.name, mkt.std, mkt.alt, bookLine);
    const bookUnderOdds = lookupUnderBookOdds(propOddsMap, p.name, mkt.std, mkt.alt, bookLine);
    const bookLinks = lookupBookLinks(propOddsMap, p.name, mkt.std, mkt.alt, bookLine, "ks", "over");
    const bookUnderLinks = lookupBookLinks(propOddsMap, p.name, mkt.std, mkt.alt, bookLine, "ks", "under");
    // Recompute edge and signal against the real line; a ≥2-K gap to a real book line
    // marks the pitcher role-uncertain (ksSignalVsLine in src/lib/picks.js).
    const hasBookLine = actualLine != null;
    const { xKEdge, kEdgeEdge, signal, roleUncertain } = ksSignalVsLine({ xK: p.xK, kEdge: p.kEdge, line: bookLine, hasBookLine });
    const pitcherProps = buildPitcherProps(p, propOddsMap);
    return { ...p, ...(bookOdds ? { bookOdds } : {}), ...(bookUnderOdds ? { bookUnderOdds } : {}), bookLinks, bookUnderLinks, line: bookLine, hasBookLine, xKEdge, kEdgeEdge, signal, roleUncertain, ...(pitcherProps ? { pitcherProps } : {}) };
  });

  // Display copy: hide picks for in-progress / final games (cosmetic only).
  const newByModel = {};
  for (const [boardKey, picks] of Object.entries(enrichedByModel)) {
    newByModel[boardKey] = (picks || []).filter(p => !isGameLocked(p));
  }
  const newPitchers = enrichedPitchers.filter(p => !isGameLocked(p));

  return {
    ...scanData,
    byModel: newByModel,
    pitchers: newPitchers,
    // Unfiltered save substrate — saveTodayPicks reads these so late auto-saves
    // still capture picks from games that already started.
    byModelAll: enrichedByModel,
    pitchersAll: enrichedPitchers,
  };
}
function bestML(gameOdds, side) {
  if (!gameOdds) return null;
  let best = null;
  for (const [bk, d] of Object.entries(gameOdds.books)) {
    if (!d) continue;
    const price = d[side];
    if (price == null) continue;
    if (!best || price > best.price) best = { book: bk, price };
  }
  return best;
}
// BOOK_COLORS/ABBR/NAMES + odds popup/toast + OddsLink moved to
// src/components/OddsLink.jsx (2026-07-06 PropsBoard extraction).

async function getSchedule(date) {
  const d = await fetchJson(`${API}/schedule?sportId=1&date=${date}&hydrate=probablePitcher(note),linescore,team`);
  return d?.dates?.[0]?.games || [];
}
async function getRoster(teamId, season) {
  const d = await fetchJson(`${API}/teams/${teamId}/roster?rosterType=active&season=${season}`);
  return d?.roster || [];
}
// 40-man roster — a superset of the active roster that also carries players on the
// 60-day IL. Used only to resolve a Rotowire probable starter the active roster can't
// see (see resolveRotowirePitcher); never used to build batter jobs.
async function getRoster40Man(teamId, season) {
  const d = await fetchJson(`${API}/teams/${teamId}/roster?rosterType=40Man&season=${season}`);
  return d?.roster || [];
}
async function getTeamManager(teamId) {
  const d = await fetchJson(`${API}/teams/${teamId}/coaches`);
  const mgr = (d?.roster || []).find(c => c.title === "Manager");
  return mgr?.person?.fullName ?? null;
}
async function getPitcherStats(pitcherId, season) {
  const mlbUrl = `${API}/people/${pitcherId}?hydrate=stats(group=[pitching],type=[season,gameLog],season=${season}),currentTeam`;
  const d = await fetchJson(`/api/proxy?url=${encodeURIComponent(mlbUrl)}&ttl=7200`);
  const p = d?.people?.[0]; if (!p) return null;
  const stats = p.stats || [];
  return {
    info: p,
    season: stats.find(s => s.type?.displayName === "season")?.splits?.[0]?.stat || {},
    gameLog: [...(stats.find(s => s.type?.displayName === "gameLog")?.splits || [])].reverse().slice(0, 30),
  };
}

// Bulk player bios — MLB /people accepts many personIds per call. Returns id→bio.
// Used by the Today tab's Birthdays / Near-Hometown tables so they can read the
// active rosters of teams playing today (the source of truth) cheaply, without
// depending on the projection-gated model scan.
async function getBulkBios(ids) {
  const uniq = [...new Set((ids || []).filter(Boolean))];
  const out = {};
  const CHUNK = 100;
  for (let i = 0; i < uniq.length; i += CHUNK) {
    const batch = uniq.slice(i, i + CHUNK);
    const d = await fetchJson(`${API}/people?personIds=${batch.join(",")}`);
    for (const p of d?.people || []) {
      out[p.id] = {
        birthDate: p.birthDate || null,
        birthCity: p.birthCity || null,
        birthState: p.birthStateProvince || null,
        batSide: p.batSide || null,
        pitchHand: p.pitchHand || null,
        primaryNumber: p.primaryNumber || null,
        primaryPosition: p.primaryPosition || null,
      };
    }
  }
  return out;
}

// Extended pitcher stats including career baseline for K-Edge model
async function getPitcherKData(pitcherId, season) {
  // Career fetch uses no season filter (all-time) — separate call to avoid type conflicts
  const [seasonD, careerD] = await Promise.all([
    fetchJson(`/api/proxy?url=${encodeURIComponent(`${API}/people/${pitcherId}?hydrate=stats(group=[pitching],type=[season,gameLog],season=${season}),currentTeam`)}&ttl=7200`),
    fetchJson(`${API}/people/${pitcherId}?hydrate=stats(group=[pitching],type=[career])`),
  ]);
  const p = seasonD?.people?.[0]; if (!p) return null;
  const stats = p.stats || [];
  const careerStats = careerD?.people?.[0]?.stats || [];
  // displayName for career can vary ("career", "Career Regular Season", etc.)
  const careerSplit = careerStats.find(s => s.type?.displayName?.toLowerCase().includes("career"))?.splits?.[0]?.stat || {};
  return {
    info: p,
    season:  stats.find(s => s.type?.displayName === "season")?.splits?.[0]?.stat || {},
    career:  careerSplit,
    gameLog: [...(stats.find(s => s.type?.displayName === "gameLog")?.splits || [])].reverse().slice(0, 30),
  };
}

async function getStatcastArsenal(pitcherId, year) {
  try {
    const url = `https://baseballsavant.mlb.com/leaderboard/pitch-arsenal-stats?type=pitcher&pitchType=&year=${year}&run_value_type=per100&min=1&csv=true`;
    // 2026-06 schema drift: avg_speed/avg_spin vanished from the pitch-arsenal-stats
    // CSV (silently nulling arsenal velo + the Ks M6 breaking-spin term). Velo/spin
    // now join from the pitcher custom leaderboard's per-pitch-type wide columns
    // (ff_avg_speed, sl_avg_spin, …) — same cached fetch getPitcherStatcast uses.
    const [text, { rows: customRows }] = await Promise.all([
      fetchText(url),
      _getPitcherStatcastCsv(year),
    ]);
    const rows = parseCSVText(text);
    const customRow = customRows.find(r => String(r.player_id) === String(pitcherId)) || {};
    const numOrNull = (v) => { const n = parseFloat(v); return isNaN(n) ? null : n; };
    const map = {};
    for (const row of rows) {
      if (row.player_id !== String(pitcherId)) continue;
      const col = PITCH_TYPE_TO_CUSTOM_COL[row.pitch_type];
      map[row.pitch_type] = {
        whiff:   parseFloat(row.whiff_percent) || 0,
        putAway: parseFloat(row.put_away) || 0,
        kPct:    parseFloat(row.k_percent) || 0,
        rv100:   row.run_value_per_100 !== '' ? parseFloat(row.run_value_per_100) : null,
        usage:   parseFloat(row.pitch_usage) || null,
        velo:    col ? numOrNull(customRow[`${col}_avg_speed`]) : null,
        spin:    col ? numOrNull(customRow[`${col}_avg_spin`])  : null,  // avg spin rate (RPM)
      };
    }
    return map;
  } catch { return {}; }
}

// Pitcher-allowed bat tracking: the bat-tracking leaderboard with type=pitcher
// returns rows keyed by pitcher, holding the avg bat speed / squared-up / blast
// rates that opposing hitters generated AGAINST that pitcher — i.e. contact-quality
// suppression. Keyed by `id` (same as the batter bat-tracking CSV). Capture-only for
// now (mined Q1→Q4 before any Ks/HR-allowed model weight).
const _pitBatTrackingCsvCache = {}; // season → Promise<{ rows, lgAvg }>  (promise-cached, race-proof)
function _getPitcherBatTrackingCsv(season) {
  if (!_pitBatTrackingCsvCache[season]) _pitBatTrackingCsvCache[season] = _loadPitcherBatTrackingCsv(season);
  return _pitBatTrackingCsvCache[season];
}
async function _loadPitcherBatTrackingCsv(season) {
  try {
    const url = `https://baseballsavant.mlb.com/leaderboard/bat-tracking?type=pitcher&year=${season}&team=&min_pa=1&csv=true`;
    const rows = parseCSVText(await fetchText(url));
    const lgKeys = ["avg_bat_speed", "squared_up_per_swing", "blast_per_swing", "hard_swing_rate"];
    const lgAvg = {};
    for (const k of lgKeys) {
      let s = 0, n = 0;
      for (const r of rows) { const v = parseFloat(r[k]); if (!isNaN(v)) { s += v; n++; } }
      lgAvg[k] = n > 0 ? s / n : null;
    }
    return { rows, lgAvg };
  } catch { return { rows: [], lgAvg: {} }; }
}

// Avg release extension (ft) from statcast_search event CSV — the only remaining
// source after Savant dropped release_extension from the custom leaderboard (2026-06).
// 45-day window keeps the payload to one pitcher's last ~8 starts. Promise-cached per
// pitcher+season so a scan slate costs one fetch per pitcher, not one per batter job.
const _pitcherExtensionCache = new Map(); // `${id}|${season}` → Promise<number|null>
function getPitcherExtension(pitcherId, season) {
  const key = `${pitcherId}|${season}`;
  if (_pitcherExtensionCache.has(key)) return _pitcherExtensionCache.get(key);
  const p = (async () => {
    try {
      const since = new Date(Date.now() - 45 * 86400e3).toISOString().slice(0, 10);
      const url = `https://baseballsavant.mlb.com/statcast_search/csv?all=true&type=details&player_type=pitcher&hfSea=${season}%7C&pitchers_lookup%5B%5D=${pitcherId}&game_date_gt=${since}&min_pitches=0&group_by=name`;
      const rows = parseCSVText(await fetchText(url, 20000));
      let s = 0, n = 0;
      for (const r of rows) {
        const v = parseFloat(r.release_extension);
        if (!isNaN(v)) { s += v; n++; }
      }
      return n >= 50 ? s / n : null; // <50 pitches = too noisy, treat as missing
    } catch { return null; }
  })();
  _pitcherExtensionCache.set(key, p);
  return p;
}

async function getPitcherStatcast(pitcherId, season) {
  try {
    const [{ rows, lgAvg }, btCsv] = await Promise.all([
      _getPitcherStatcastCsv(season),
      _getPitcherBatTrackingCsv(season),
    ]);
    const numOrNull = (v) => { const n = parseFloat(v); return isNaN(n) ? null : n; };
    const row = rows.find(r => String(r.player_id) === String(pitcherId));
    if (!row) return null;
    const btRow = btCsv.rows.find(r => String(r.id) === String(pitcherId));
    // Only fetched for pitchers present in the leaderboard (i.e. after the row check)
    const extension = await getPitcherExtension(pitcherId, season);

    return {
      // Run prevention
      xera:      numOrNull(row.xera),
      xba:       numOrNull(row.xba),
      xslg:      numOrNull(row.xslg),
      xwoba:     numOrNull(row.xwoba),
      // Stuff & command
      whiff:     numOrNull(row.whiff_percent),
      chasePct:  numOrNull(row.oz_swing_percent),
      kPct:      numOrNull(row.k_percent),
      bbPct:     numOrNull(row.bb_percent),
      // Contact
      hardHit:   numOrNull(row.hard_hit_percent),
      barrel:    numOrNull(row.barrel_batted_rate),
      exitVelo:  numOrNull(row.exit_velocity_avg),
      launchAngle: numOrNull(row.launch_angle_avg),
      // Batted-ball direction
      pullPct:        numOrNull(row.pull_percent),
      straightPct:    numOrNull(row.straightaway_percent),
      oppoPct:        numOrNull(row.opposite_percent),
      // Batted-ball type (Savant uses long-form names: groundballs_percent, etc.)
      gbPct:          numOrNull(row.groundballs_percent),
      fbPct:          numOrNull(row.flyballs_percent),
      ldPct:          numOrNull(row.linedrives_percent),
      puPct:          numOrNull(row.popups_percent),
      airPct:         (() => {
        const fb = numOrNull(row.flyballs_percent), ld = numOrNull(row.linedrives_percent), pu = numOrNull(row.popups_percent);
        return [fb,ld,pu].some(v => v != null) ? (fb||0) + (ld||0) + (pu||0) : null;
      })(),
      // Quality of contact (Savant six-bucket: poorly* prefix for weak/topped/under)
      weakPct:        numOrNull(row.poorlyweak_percent),
      toppedPct:      numOrNull(row.poorlytopped_percent),
      underPct:       numOrNull(row.poorlyunder_percent),
      flareBurnerPct: numOrNull(row.flareburner_percent),
      solidPct:       numOrNull(row.solidcontact_percent),
      // Barrels-per-PA isn't exposed in custom-leaderboard CSV (only barrel_batted_rate). Skip.
      barrelPerPA:    null,
      // Release extension: Savant removed the column from the custom leaderboard
      // (2026-06 audit — empty for every year under every alias). Fetched separately
      // from statcast_search by getPitcherExtension and attached here.
      extension:      extension,
      // Bat-tracking ALLOWED (type=pitcher) — contact quality opposing hitters
      // generated vs this pitcher. Capture-only; no model weight until mined.
      batSpeedAllowed:        btRow ? numOrNull(btRow.avg_bat_speed)         : null,
      squaredUpAllowedPerSwing: btRow ? numOrNull(btRow.squared_up_per_swing): null,
      blastAllowedPerSwing:   btRow ? numOrNull(btRow.blast_per_swing)       : null,
      hardSwingRateAllowed:   btRow ? numOrNull(btRow.hard_swing_rate)       : null,
      // League averages (same CSV, all pitchers)
      lgAvg: {
        xera:        lgAvg.xera,
        xba:         lgAvg.xba,
        xslg:        lgAvg.xslg,
        xwoba:       lgAvg.xwoba,
        whiff:       lgAvg.whiff_percent,
        chasePct:    lgAvg.oz_swing_percent,
        kPct:        lgAvg.k_percent,
        bbPct:       lgAvg.bb_percent,
        hardHit:     lgAvg.hard_hit_percent,
        barrel:      lgAvg.barrel_batted_rate,
        exitVelo:    lgAvg.exit_velocity_avg,
        launchAngle: lgAvg.launch_angle_avg,
        pullPct:     lgAvg.pull_percent,
        straightPct: lgAvg.straightaway_percent,
        oppoPct:     lgAvg.opposite_percent,
        gbPct:       lgAvg.groundballs_percent,
        fbPct:       lgAvg.flyballs_percent,
        ldPct:       lgAvg.linedrives_percent,
        puPct:       lgAvg.popups_percent,
        airPct:      (lgAvg.flyballs_percent || 0) + (lgAvg.linedrives_percent || 0) + (lgAvg.popups_percent || 0) || null,
        weakPct:     lgAvg.poorlyweak_percent,
        toppedPct:   lgAvg.poorlytopped_percent,
        underPct:    lgAvg.poorlyunder_percent,
        flareBurnerPct: lgAvg.flareburner_percent,
        solidPct:    lgAvg.solidcontact_percent,
        barrelPerPA: null,
        // League avg release extension ≈ 6.4 ft (hardcoded — the custom-leaderboard
        // column is gone, and averaging statcast_search league-wide is too heavy).
        extension:   6.4,
        batSpeedAllowed:          btCsv.lgAvg.avg_bat_speed,
        squaredUpAllowedPerSwing: btCsv.lgAvg.squared_up_per_swing,
        blastAllowedPerSwing:     btCsv.lgAvg.blast_per_swing,
        hardSwingRateAllowed:     btCsv.lgAvg.hard_swing_rate,
      },
    };
  } catch { return null; }
}

// ── League-average pitch movement per pitch type × handedness ──
// Aggregates the same pitch-movement leaderboard CSV that getPitcherPitchLocations uses
// so the polar movement chart can overlay hatched MLB-avg ellipses (matching Savant's view).
// Returns { R: { FF: { px, pz, speed }, ... }, L: { ... } } — averaged across all pitchers
// for that hand, weighted by pitches_thrown.
const _lgMoveCache = {};
async function getLeagueAvgPitchMovement(year) {
  if (_lgMoveCache[year]) return _lgMoveCache[year];
  const tryYear = async (yr) => {
    try {
      const url = `https://baseballsavant.mlb.com/leaderboard/pitch-movement?pitchYear=${yr}&team=&min=1&pitch_hand=&type=pa&csv=true`;
      const text = await fetchText(url);
      const rows = parseCSVText(text);
      const buckets = { R: {}, L: {} };  // { hand: { pt: { sx, sz, sv, n } } }
      for (const row of rows) {
        const hand = (row.pitch_hand || row.p_throws || "").toUpperCase().startsWith("L") ? "L" : "R";
        const pt = row.pitch_type;
        if (!pt) continue;
        const bx = parseFloat(row.pitcher_break_x);
        const bz = parseFloat(row.pitcher_break_z_induced);
        const sp = parseFloat(row.avg_speed);
        const n  = parseInt(row.pitches_thrown) || 0;
        if (isNaN(bx) || isNaN(bz) || n <= 0) continue;
        if (!buckets[hand][pt]) buckets[hand][pt] = { sx:0, sz:0, sv:0, vn:0, n:0 };
        const b = buckets[hand][pt];
        b.sx += bx * n; b.sz += bz * n; b.n += n;
        if (!isNaN(sp)) { b.sv += sp * n; b.vn += n; }
      }
      const out = { R: {}, L: {} };
      for (const hand of ["R","L"]) {
        for (const pt of Object.keys(buckets[hand])) {
          const b = buckets[hand][pt];
          out[hand][pt] = {
            px: b.n > 0 ? b.sx / b.n : null,
            pz: b.n > 0 ? b.sz / b.n : null,
            speed: b.vn > 0 ? b.sv / b.vn : null,
            n: b.n,
          };
        }
      }
      return out;
    } catch { return null; }
  };
  const v = await tryYear(year);
  if (v) { _lgMoveCache[year] = v; return v; }
  if (year > 2024) {
    const fb = await tryYear(year - 1);
    if (fb) { _lgMoveCache[year] = fb; return fb; }
  }
  return { R: {}, L: {} };
}

// Pitcher Statcast percentile rankings
async function getPitcherStatcastPercentiles(pitcherId, season) {
  const tryYear = async (yr) => {
    try {
      const url = `https://baseballsavant.mlb.com/leaderboard/percentile-rankings?type=pitcher&year=${yr}&min=1&csv=true`;
      const text = await fetchText(url);
      const rows = parseCSVText(text);
      const row = rows.find(r => String(r.player_id) === String(pitcherId));
      if (!row) return null;
      const p = (k) => { const v = parseFloat(row[k]); return isNaN(v) ? null : v; };
      return {
        xwoba: p("xwoba"), xba: p("xba"), xslg: p("xslg"), xera: p("xera"),
        k_percent: p("k_percent"), bb_percent: p("bb_percent"),
        whiff_percent: p("whiff_percent"), chase_percent: p("chase_percent"),
        hard_hit_percent: p("hard_hit_percent"), brl_percent: p("brl_percent"),
        exit_velocity: p("exit_velocity"), fb_velocity: p("fb_velocity"),
        fb_spin: p("fb_spin"), curve_spin: p("curve_spin"),
      };
    } catch { return null; }
  };
  try {
    const v = await tryYear(season);
    if (v) return v;
    if (season > 2024) return await tryYear(season - 1);
    return null;
  } catch { return null; }
}

// Pitcher arm angles: ball release angle, shoulder position
// League-wide arm-angles leaderboard — identical per year for every pitcher. Cache the
// parsed rows per year so a scan slate makes one fetch instead of one per pitcher
// (~30 identical requests that compounded the Savant request storm). See
// _getPlateDisciplineCsv above for the same rationale.
const _armAnglesCsvCache = new Map(); // year → Promise<rows[]>
function _getArmAnglesCsv(yr) {
  if (_armAnglesCsvCache.has(yr)) return _armAnglesCsvCache.get(yr);
  const p = (async () => {
    const url = `https://baseballsavant.mlb.com/leaderboard/pitcher-arm-angles?year=${yr}&min=1&csv=true`;
    try { return parseCSVText(await fetchText(url)); } catch { return []; }
  })();
  _armAnglesCsvCache.set(yr, p);
  return p;
}
async function getPitcherArmAngles(pitcherId, season) {
  const tryYear = async (yr) => {
    try {
      const rows = await _getArmAnglesCsv(yr);
      const row = rows.find(r => String(r.pitcher) === String(pitcherId));
      if (!row) return null;
      const pf = (k) => { const v = parseFloat(row[k]); return isNaN(v) ? null : v; };
      return {
        nPitches:   parseInt(row.n_pitches) || 0,
        ballAngle:  pf("ball_angle"),
        releaseX:   pf("relative_release_ball_x"),
        releaseZ:   pf("release_ball_z"),
        shoulderX:  pf("relative_shoulder_x"),
        shoulderZ:  pf("shoulder_z"),
        pitchHand:  row.pitch_hand || null,
      };
    } catch { return null; }
  };
  try {
    const v = await tryYear(season);
    if (v?.nPitches > 0) return v;
    if (season > 2024) return await tryYear(season - 1);
    return null;
  } catch { return null; }
}

// Active spin efficiency per pitch type
async function getActiveSpin(pitcherId, season) {
  const tryYear = async (yr) => {
    try {
      const url = `https://baseballsavant.mlb.com/leaderboard/active-spin?year=${yr}&min=1&csv=true`;
      const text = await fetchText(url);
      const rows = parseCSVText(text);
      const row = rows.find(r => String(r.entity_id) === String(pitcherId));
      if (!row) return null;
      const pf = (k) => { const v = parseFloat(row[k]); return isNaN(v) ? null : v; };
      return {
        fourseam: pf("active_spin_fourseam"),
        sinker:   pf("active_spin_sinker"),
        cutter:   pf("active_spin_cutter"),
        changeup: pf("active_spin_changeup"),
        splitter: pf("active_spin_splitter"),
        curve:    pf("active_spin_curve"),
        slider:   pf("active_spin_slider"),
        sweeper:  pf("active_spin_sweeper"),
        slurve:   pf("active_spin_slurve"),
      };
    } catch { return null; }
  };
  try {
    const v = await tryYear(season);
    if (v) return v;
    if (season > 2024) return await tryYear(season - 1);
    return null;
  } catch { return null; }
}

// Team OAA map from Savant outs_above_average leaderboard — aggregated by team abbreviation.
// Returns { "NYY": totalOAA, "LAD": totalOAA, ... }
async function getTeamOAAMap(season) {
  const tryYear = async (yr) => {
    try {
      const url = `https://baseballsavant.mlb.com/leaderboard/outs_above_average?type=Fielder&team=&range=year&min=q&pos=&roles=&viz=show&year=${yr}&csv=true`;
      const text = await fetchText(url);
      const rows = parseCSVText(text);
      const teamMap = {};
      for (const row of rows) {
        const team = (row.display_team_name || '').trim().toUpperCase();
        if (!team) continue;
        const oaa = parseFloat(row.outs_above_average) || 0;
        teamMap[team] = (teamMap[team] || 0) + oaa;
      }
      return teamMap;
    } catch { return {}; }
  };
  try {
    const v = await tryYear(season);
    if (Object.keys(v).length > 10) return v; // expect 30 teams
    if (season > 2024) return await tryYear(season - 1);
    return {};
  } catch { return {}; }
}

// ── End new Savant fetch functions ────────────────────────────────────────────

// Convert catcher pop-time data into a SB multiplier (0.80–1.20)
// Lower pop time = harder to steal = lower mult. Higher = easier to steal = higher mult.
function computeCatcherMult(catcherData) {
  if (!catcherData || catcherData.popTime2b == null) return 1.0;
  const LEAGUE_POP2B   = 1.93;  // seconds — league avg pop time to 2B
  const LEAGUE_EXCH    = 0.646; // seconds — league avg exchange time
  const LEAGUE_ARM     = 79.6;  // mph    — league avg arm speed to 2B
  const LEAGUE_EST_CS  = 0.199; // estimated CS% league avg
  let mult = 1.0;
  mult += (catcherData.popTime2b - LEAGUE_POP2B) / LEAGUE_POP2B * 1.4;
  if (catcherData.exchange != null)
    mult += (catcherData.exchange - LEAGUE_EXCH) / LEAGUE_EXCH * 0.6;
  if (catcherData.armSpeed != null)
    mult += (LEAGUE_ARM - catcherData.armSpeed) / LEAGUE_ARM * 0.4; // inverted: faster arm = lower mult
  // Est. CS%: controls for runner speed/distance — cleaner signal than raw pop time alone
  if (catcherData.estCsPct != null)
    mult -= (catcherData.estCsPct - LEAGUE_EST_CS) / LEAGUE_EST_CS * 0.3; // inverted: higher CS% = harder to steal
  // Outcome anchor: CS above average per throw (league avg ≈ 0.026). Directly measures whether
  // this catcher actually throws runners out beyond what pop/arm predict. Elite (+0.10) → harder.
  const LEAGUE_CS_AA_THROW = 0.026;
  if (catcherData.csAaPerThrow != null)
    mult -= (catcherData.csAaPerThrow - LEAGUE_CS_AA_THROW) * 1.5; // inverted: more CS = harder to steal
  return Math.min(1.20, Math.max(0.80, mult));
}

// Fetch all reliever season stats for a team (roster + per-player stats)
async function getTeamBullpen(teamId, season) {
  try {
    const roster = await getTeamRoster(teamId, season, "pitcher");
    const all = await Promise.all(
      roster.map(async p => {
        const stat = await getSeasonStats(p.person.id, season, "pitching");
        const bf = stat.battersFaced || 0;
        // Base-3 notation (src/lib/innings.js). This one is not display-only: the
        // bullpen-vector capture below weights xERA/hard-hit/barrel BY these innings
        // and sums them into totalIp, so parseFloat was quietly down-weighting every
        // reliever whose innings ended in ⅓ or ⅔ — two thirds of them.
        const ip = ipToDec(stat.inningsPitched);
        const gs = stat.gamesStarted || 0;
        const gp = stat.gamesPitched || 0;
        if (gs > 3 || gp < 1) return null; // filter starters + arms who haven't appeared
        const so = stat.strikeOuts || 0;
        const bb = stat.baseOnBalls || 0;
        const ir = stat.inheritedRunners || 0;
        const irs = stat.inheritedRunnersScored || 0;
        return {
          id: p.person.id,
          name: p.person.fullName,
          jerseyNumber: p.jerseyNumber || "",
          era:          parseFloat(stat.era) || null,
          whip:         parseFloat(stat.whip) || null,
          ip,
          games:        gp,
          gamesStarted: gs,
          gamesFinished: stat.gamesFinished || 0,
          saves:        stat.saves || 0,
          saveOpps:     stat.saveOpportunities || 0,
          holds:        stat.holds || 0,
          blownSaves:   stat.blownSaves || 0,
          strikeOuts:   so,
          baseOnBalls:  bb,
          hits:         stat.hits || 0,
          homeRuns:     stat.homeRuns || 0,
          earnedRuns:   stat.earnedRuns || 0,
          battersFaced: bf,
          inheritedRunners:       ir,
          inheritedRunnersScored: irs,
          // computed rate stats for sorting
          kPct:      bf > 0 ? (so / bf) * 100 : null,
          bbPct:     bf > 0 ? (bb / bf) * 100 : null,
          strandPct: ir > 0 ? ((ir - irs) / ir) * 100 : null,
        };
      })
    );
    return all.filter(Boolean);
  } catch { return []; }
}

// Fetch Baseball Savant pitcher leaderboard → player_id map
async function getBullpenSavant(season) {
  try {
    const fields = "xera,xwoba,whiff_percent,hard_hit_percent,barrel_batted_rate,exit_velocity_avg,k_percent,bb_percent";
    const url = `https://baseballsavant.mlb.com/leaderboard/custom?year=${season}&type=pitcher&filter=&min=1&selections=${fields}&csv=true`;
    const text = await fetchText(url); // 15s timeout + by-URL cache; throws on !ok → caught below
    const rows = parseCSVText(text);
    const map = {};
    for (const row of rows) {
      map[String(row.player_id)] = {
        xera:     parseFloat(row.xera)              || null,
        xwoba:    parseFloat(row.xwoba)             || null,
        whiff:    parseFloat(row.whiff_percent)     || null,
        hardHit:  parseFloat(row.hard_hit_percent)  || null,
        barrel:   parseFloat(row.barrel_batted_rate)|| null,
        exitVelo: parseFloat(row.exit_velocity_avg) || null,
        svKPct:   parseFloat(row.k_percent)       || null,
        svBbPct:  parseFloat(row.bb_percent)      || null,
      };
    }
    return map;
  } catch { return {}; }
}

// ── Bullpen vectors for forward capture (Stage 1 of bullpen mining) ─────────
// Returns { teamAbbr → { hrPer9, xera, hardhit, barrel, xwoba, nArms } }.
// Reuses getTeamBullpen (reliever roster + season stats) for each team in the
// slate and joins to the Savant pitcher leaderboard. Stamped onto
// models.hrr/rbi/tb at scan time so pick_signals captures it for future mining.
// Failure → {}; capture is non-blocking. Memoized per (season, date) within a
// session so repeated scans on the same day reuse the vectors.
const _bullpenVectorCache = new Map(); // key: `${season}|${YYYY-MM-DD}` → vectors
async function fetchBullpenVectorsForScan(teamMap, season) {
  // teamMap: { abbr → teamId } for teams in this slate (oppTeams only)
  if (!teamMap || !Object.keys(teamMap).length) return {};
  const dateKey = getTodayInAppTimeZone();
  const cacheKey = `${season}|${dateKey}`;
  if (_bullpenVectorCache.has(cacheKey)) return _bullpenVectorCache.get(cacheKey);

  try {
    const savantMap = await getBullpenSavant(parseInt(season));
    const entries = Object.entries(teamMap);
    const CONC = 6;
    const out = {};
    for (let i = 0; i < entries.length; i += CONC) {
      const slice = entries.slice(i, i + CONC);
      const built = await Promise.all(slice.map(async ([abbr, teamId]) => {
        try {
          const relievers = await getTeamBullpen(teamId, season); // existing helper
          const stable = (relievers || []).filter(r => (r.ip || 0) >= 5);
          if (!stable.length) return [abbr, null];
          const ipW = (acc) => {
            let num = 0, den = 0;
            for (const r of stable) {
              const v = acc(r);
              if (v == null || !Number.isFinite(v)) continue;
              num += v * r.ip; den += r.ip;
            }
            return den > 0 ? +(num / den).toFixed(4) : null;
          };
          const totalIp = stable.reduce((s, r) => s + r.ip, 0);
          const totalHr = stable.reduce((s, r) => s + (r.homeRuns || 0), 0);
          const sv = (r) => savantMap[String(r.id)] || {};
          return [abbr, {
            hrPer9:  totalIp > 0 ? +((totalHr / totalIp) * 9).toFixed(3) : null,
            xera:    ipW(r => sv(r).xera),
            hardhit: ipW(r => sv(r).hardHit),
            barrel:  ipW(r => sv(r).barrel),
            xwoba:   ipW(r => sv(r).xwoba),
            nArms:   stable.length,
          }];
        } catch { return [abbr, null]; }
      }));
      for (const [abbr, vec] of built) if (vec) out[abbr] = vec;
    }
    _bullpenVectorCache.set(cacheKey, out);
    return out;
  } catch { return {}; }
}

// ── Reliever-only ERA per team (replaces broken playerPool=RELIEF endpoint) ──
// MLB Stats API does not accept playerPool=RELIEF on /stats?group=pitching
// (returns 400). Loop the 30 teams via getTeamBullpen (which filters gs ≤ 3)
// and compute IP-weighted ERA per team. Memoized per (season, date).
const _bullpenERACache = new Map();
async function fetchAllTeamBullpenERAs(teamMap, season) {
  if (!teamMap || !Object.keys(teamMap).length) return {};
  const dateKey = getTodayInAppTimeZone();
  const cacheKey = `${season}|${dateKey}`;
  if (_bullpenERACache.has(cacheKey)) return _bullpenERACache.get(cacheKey);

  try {
    const entries = Object.entries(teamMap);
    const CONC = 6;
    const out = {};
    for (let i = 0; i < entries.length; i += CONC) {
      const slice = entries.slice(i, i + CONC);
      const built = await Promise.all(slice.map(async ([abbr, teamId]) => {
        try {
          const relievers = await getTeamBullpen(teamId, season);
          if (!relievers || !relievers.length) return [abbr, null];
          let er = 0, ip = 0;
          for (const r of relievers) {
            er += r.earnedRuns || 0;
            ip += r.ip || 0;
          }
          if (ip < 5) return [abbr, null];
          return [abbr, +((er * 9) / ip).toFixed(2)];
        } catch { return [abbr, null]; }
      }));
      for (const [abbr, era] of built) if (era != null) out[abbr] = era;
    }
    _bullpenERACache.set(cacheKey, out);
    return out;
  } catch { return {}; }
}

// All active MLB teams sorted by name
async function getTeams() {
  const d = await fetchJson(`${API}/teams?sportId=1&season=2026`);
  return (d?.teams || []).filter(t => t.sport?.id === 1 && t.active).sort((a, b) => a.name.localeCompare(b.name));
}
// Pitcher's MLB Stats API arsenal: usage %, avg velocity, pitch type per pitch
async function getPitcherArsenalMlb(pitcherId, season) {
  const d = await fetchJson(`${API}/people/${pitcherId}?hydrate=stats(group=[pitching],type=[pitchArsenal],season=${season})`);
  const stats = d?.people?.[0]?.stats || [];
  const s = stats.find(s => s.type?.displayName === "pitchArsenal");
  return s?.splits || [];
}

// ── Advanced stats bulk fetch (FanGraphs + Savant via Supabase) ───────────────
// Returns { batters: { mlbam_id → stats }, pitchers: { mlbam_id → stats } }
// Called once per scan; results are keyed by player MLBAM ID for O(1) lookup.
async function fetchAdvancedStatsBulk(season) {
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch(`/api/advanced-stats?season=${season}`, { signal: ctrl.signal });
    clearTimeout(tid);
    if (!res.ok) return { batters: {}, pitchers: {} };
    const json = await res.json();
    const batters = {};
    const pitchers = {};
    for (const row of (json.batters || [])) {
      if (row.mlbam_id) batters[row.mlbam_id] = row;
    }
    for (const row of (json.pitchers || [])) {
      if (row.mlbam_id) pitchers[row.mlbam_id] = row;
    }
    return { batters, pitchers };
  } catch {
    return { batters: {}, pitchers: {} };
  }
}

// ── Running-game bulk fetch (catcher throwing + pitcher hold + runner basestealing) ──
// DB fallback for the live Baseball Savant CSVs. Maps each table back to the exact shape
// the live fetchers return, so downstream model code is identical whether data is live or DB.
async function fetchRunningGameBulk(season) {
  const empty = { catcherByTeam: {}, pitchers: {}, batters: {} };
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch(`/api/running-game?season=${season}`, { signal: ctrl.signal });
    clearTimeout(tid);
    if (!res.ok) return empty;
    const json = await res.json();
    // Catchers → by-team map, keeping the primary catcher (most attempts) per team.
    const catcherByTeam = {};
    for (const row of (json.catchers || [])) {
      const team = (row.team || "").trim().toUpperCase();
      if (!team) continue;
      const attempts = row.sb_attempts || 0;
      if (!catcherByTeam[team] || attempts > (catcherByTeam[team].attempts || 0)) {
        catcherByTeam[team] = {
          popTime2b:    row.pop_time,
          exchange:     row.exchange_time,
          armSpeed:     row.arm_strength,
          estCsPct:     row.est_cs_pct,
          csAboveAvg:   row.cs_above_avg,
          csAaPerThrow: row.cs_aa_per_throw,
          stealingRuns: row.catcher_stealing_runs,
          attempts,
          name:         row.player_name || "",
        };
      }
    }
    const pitchers = {};
    for (const row of (json.pitchers || [])) {
      if (!row.mlbam_id) continue;
      pitchers[row.mlbam_id] = {
        runsPrevented: row.runs_prevented, rateSbx: row.rate_sbx,
        nSb: row.n_sb || 0, nCs: row.n_cs || 0, nPk: row.n_pk || 0,
        primaryLead: row.primary_lead, secondaryLead: row.secondary_lead,
      };
    }
    const batters = {};
    for (const row of (json.batters || [])) {
      if (!row.mlbam_id) continue;
      const nSb = row.n_sb || 0, nCs = row.n_cs || 0, nPk = row.n_pk || 0, nInit = row.n_init || 0;
      batters[row.mlbam_id] = {
        runsStolen: row.runs_stolen, rateSbx: row.rate_sbx,
        nSb, nCs, nPk, nInit,
        attemptRate: nInit > 0 ? (nSb + nCs + nPk) / nInit : null,
        successRate: (nSb + nCs) > 0 ? nSb / (nSb + nCs) : null,
        primaryLead: row.primary_lead, secondaryLead: row.secondary_lead,
        leadDiff: row.sec_minus_prim_lead,
        primaryLeadSbx: row.primary_lead_sbx ?? null,
        secondaryLeadSbx: row.secondary_lead_sbx ?? null,
        leadDiffSbx: row.sec_minus_prim_lead_sbx ?? null,
      };
    }
    return { catcherByTeam, pitchers, batters };
  } catch {
    return empty;
  }
}

// Batter's MLB Stats API arsenal: avg velocity of pitches seen per pitch type
async function getBatterArsenalMlb(batterId, season) {
  const d = await fetchJson(`${API}/people/${batterId}?hydrate=stats(group=[hitting],type=[pitchArsenal],season=${season})`);
  const stats = d?.people?.[0]?.stats || [];
  const s = stats.find(s => s.type?.displayName === "pitchArsenal");
  return s?.splits || [];
}

// Opponent team K% vs L or R starter (M3 input)
async function getOppTeamKRate(teamId, season, hand) {
  if (!teamId) return null;
  try {
    const sitCode = hand === "L" ? "vls" : "vrs";
    const d = await fetchJson(`${API}/teams/${teamId}/stats?stats=statSplits&season=${season}&group=hitting&sitCodes=${sitCode}`);
    const stat = d?.stats?.[0]?.splits?.[0]?.stat;
    if (stat?.strikeOuts && stat?.plateAppearances) return stat.strikeOuts / stat.plateAppearances;
    return null;
  } catch { return null; }
}

// Lineup-specific batter K profile — per-batter discipline + vs-pitch K% for today's lineup
// Returns null if < 3 batters resolved from roster, or batters list is empty.
// vsPitchProfiles is kept in the return object so the caller can compute arsenalKMult
// once the pitcher's savantArsenal is resolved (avoid double-fetching batter data).
async function computeLineupKProfile(lineupBatters, oppTeamId, season, rosterCache) {
  if (!lineupBatters?.length || !oppTeamId) return null;
  try {
    const roster = rosterCache?.[oppTeamId] || [];
    const byNorm = {}, byLast = {};
    for (const p of roster) {
      const norm = normalizeName(p.person.fullName);
      byNorm[norm] = p.person.id;
      const last = norm.split(" ").pop();
      if (last && !byLast[last]) byLast[last] = p.person.id;
    }
    const findId = name => {
      const norm = normalizeName(name);
      return byNorm[norm] || byLast[norm.split(" ").pop()] || null;
    };
    const resolved = lineupBatters.slice(0, 9)
      .map(b => ({ name: b.name, id: findId(b.name) }))
      .filter(b => b.id != null);
    if (resolved.length < 3) return null;

    const profiles = await Promise.all(resolved.map(async b => {
      const [disc, vsPitch] = await Promise.all([
        getPlateDiscipline(b.id, season, "batter").catch(() => null),
        getStatcastBatterVsPitch(b.id, season).catch(() => ({})),
      ]);
      return { id: b.id, disc, vsPitch: vsPitch || {} };
    }));

    let wWhiff = 0, wOzSwing = 0, wIzContact = 0, discCount = 0;
    for (const b of profiles) {
      if (!b.disc) continue;
      if (b.disc.whiff    != null) wWhiff    += b.disc.whiff;
      if (b.disc.ozSwing  != null) wOzSwing  += b.disc.ozSwing;
      if (b.disc.izContact != null) wIzContact += b.disc.izContact;
      discCount++;
    }
    return {
      lineupWhiff:    discCount > 0 ? wWhiff    / discCount : 24.0,
      lineupOzSwing:  discCount > 0 ? wOzSwing  / discCount : 29.0,
      lineupIzContact:discCount > 0 ? wIzContact / discCount : 85.0,
      arsenalKMult: 1.0,   // filled in by caller once savantArsenal is resolved
      vsPitchProfiles: profiles,
      coverage: resolved.length / Math.min(9, lineupBatters.length),
      sampleSize: discCount,
    };
  } catch { return null; }
}

// Sportsbook K line — returns null (falls back to half-integer in caller).
// Future: hook in The Odds API key here for live market lines.
async function getPitcherKLine(/* pitcherName */) { return null; }

// ── Promotions / giveaways helpers ──
// Drop a leading player name from a giveaway title so the player column isn't echoed
// in the giveaway column: "Aaron Judge MVP Bobblehead Day" → "MVP Bobblehead Day".
function trimPromoName(promo, playerName) {
  if (!promo || !playerName) return promo;
  const trimmed = promo.replace(new RegExp(`^${playerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'?s?\\s+`, "i"), "").trim();
  return trimmed || promo;
}

const _rwLineupCache = { ts: 0, data: null };
const _RW_TTL = 15 * 60 * 1000;

// `force` is the manual-refresh path. Busting only the TTL above is not enough:
// the request then lands on /api/proxy's own 30-min cache and comes back a HIT,
// so the button re-parsed the same HTML it already had. `force` carries through
// to the proxy so a refresh actually reaches Rotowire.
async function fetchRotowireLineups({ force = false } = {}) {
  if (!force && _rwLineupCache.data && Date.now() - _rwLineupCache.ts < _RW_TTL) return _rwLineupCache.data;
  try {
    // No explicit ceiling: lineups are the one fetch worth waiting on (a miss
    // silently downgrades confirmed cards to PROJECTED), so let each proxy run
    // its own budget rather than clamping ours to below its own success case.
    const html = await _proxiedFetch("https://www.rotowire.com/baseball/daily-lineups.php", undefined, { fresh: force });
    if (!html) return _rwLineupCache.data || {};
    const doc = new DOMParser().parseFromString(html, "text/html");
    const result = {};
    doc.querySelectorAll(".lineup__box").forEach(box => {
      const abbrs = box.querySelectorAll(".lineup__abbr");
      const visitAbbr = normalizeRWAbbr(abbrs[0]?.textContent?.trim());
      const homeAbbr  = normalizeRWAbbr(abbrs[1]?.textContent?.trim());
      box.querySelectorAll(".lineup__list").forEach(list => {
        const isHome = list.classList.contains("is-home");
        const abbr = isHome ? homeAbbr : visitAbbr;
        if (!abbr) return;
        const pitcherEl = list.querySelector(".lineup__player-highlight-name a");
        const pitcher = pitcherEl?.textContent?.trim() || null;
        // Full name, used to resolve the Rotowire probable to a real MLB player id for the
        // detail view. textContent is often abbreviated ("T. Yesavage") and — unlike the
        // batter rows — the starter's highlight anchor carries no title=, so the href slug
        // (/baseball/player/joe-musgrove-12185) is the only reliable full name on the page.
        const pitcherFull = pitcherEl?.getAttribute("title")?.trim()
          || rwNameFromHref(pitcherEl?.getAttribute("href")) || pitcher;
        const statusEl = list.querySelector(".lineup__status");
        const confirmed = !!statusEl?.textContent?.toLowerCase().includes("confirmed");
        const batters = [];
        list.querySelectorAll("li.lineup__player").forEach((li, idx) => {
          const name = li.querySelector("a")?.getAttribute("title")?.trim() || li.querySelector("a")?.textContent?.trim() || null;
          const pos  = li.querySelector(".lineup__pos")?.textContent?.trim() || null;
          const bats = li.querySelector(".lineup__bats")?.textContent?.trim() || null;
          if (name) batters.push({ order: idx + 1, name, pos, bats });
        });
        result[abbr] = { confirmed, pitcher, pitcherFull, batters };
      });
    });
    _rwLineupCache.data = result;
    _rwLineupCache.ts = Date.now();
    return result;
  } catch {
    return _rwLineupCache.data || {};
  }
}

// Rate of games clearing threshold in last n games (0–1 or null if no data)
function computeRateSeries(gameLog, propKey, threshold, n) {
  const games = (gameLog || []).slice(0, n);
  if (games.length === 0) return null;
  return games.filter(g => getGameLogStat(g, propKey) > threshold).length / games.length;
}

// Consecutive most-recent games WITHOUT clearing threshold (0 = cleared last game)
function computeDrought(gameLog, propKey, threshold) {
  let count = 0;
  for (const entry of (gameLog || [])) {
    if (getGameLogStat(entry, propKey) > threshold) break;
    count++;
  }
  return count;
}

// Heat-map background+color for a rate value (0–1)
function heatCell(rate) {
  if (rate == null) return {};
  if (rate >= 0.75) return { background: "rgba(15,138,68,0.22)", color: "#0f8a44" };
  if (rate >= 0.60) return { background: "rgba(15,138,68,0.1)", color: "#1c9a50" };
  if (rate >= 0.50) return { background: "rgba(161,98,7,0.1)", color: "#a16207" };
  if (rate >= 0.35) return { background: "rgba(208,49,49,0.1)", color: "#d03131" };
  return { background: "rgba(208,49,49,0.2)", color: "#c62828" };
}

function PaceRow({ label, projected, actual, games, invert }) {
  if (projected == null || projected === 0) return null;
  const pace = games > 0 ? (actual / games) * 150 : null;
  const pacePct = pace != null ? pace / projected : null;
  let status, statusColor;
  if (pacePct == null) { status = "—"; statusColor = "#6d7c96"; }
  else if (invert) {
    status = pacePct < 0.90 ? "🟢 Ahead" : pacePct <= 1.10 ? "🟡 Track" : "🔴 Behind";
    statusColor = pacePct < 0.90 ? "#0f8a44" : pacePct <= 1.10 ? "#a16207" : "#d03131";
  } else {
    status = pacePct > 1.10 ? "🟢 Ahead" : pacePct >= 0.90 ? "🟡 Track" : "🔴 Behind";
    statusColor = pacePct > 1.10 ? "#0f8a44" : pacePct >= 0.90 ? "#a16207" : "#d03131";
  }
  return (
    <tr style={{ borderBottom: "1px solid rgba(32,98,200,0.08)" }}>
      <td style={{ padding: "5px 8px", fontSize: 12, color: "#5d6f8b", fontWeight: 500 }}>{label}</td>
      <td className="mono" style={{ fontSize: 12 }}>{projected}</td>
      <td className="mono" style={{ fontSize: 12 }}>{actual}</td>
      <td className="mono" style={{ fontSize: 12 }}>{pace != null ? Math.round(pace) : "—"}</td>
      <td className="mono" style={{ fontSize: 12 }}>{pacePct != null ? (pacePct * 100).toFixed(0) + "%" : "—"}</td>
      <td style={{ padding: "5px 8px", fontSize: 11, color: statusColor, fontWeight: 600, textAlign: "center" }}>{status}</td>
    </tr>
  );
}

function SplitRow({ label, stat, showPitching }) {
  if (!stat) return null;
  if (showPitching) return (
    <tr style={{ borderBottom: "1px solid rgba(32,98,200,0.096)" }}>
      <td style={{ padding: "7px 12px", color: "#3c4f6d", fontSize: 13, fontWeight: 500 }}>{label}</td>
      <td className="mono">{fmt(stat.era, 2)}</td><td className="mono">{stat.inningsPitched || "—"}</td>
      <td className="mono">{stat.strikeOuts ?? "—"}</td><td className="mono">{stat.baseOnBalls ?? "—"}</td>
      <td className="mono">{fmtAvg(stat.whip)}</td><td className="mono">{fmtAvg(stat.avg)}</td>
    </tr>
  );
  return (
    <tr style={{ borderBottom: "1px solid rgba(32,98,200,0.096)" }}>
      <td style={{ padding: "7px 12px", color: "#3c4f6d", fontSize: 13, fontWeight: 500 }}>{label}</td>
      <td className="mono">{stat.atBats ?? "—"}</td><td className="mono">{stat.hits ?? "—"}</td>
      <td className="mono">{stat.homeRuns ?? "—"}</td><td className="mono">{fmtAvg(stat.avg)}</td>
      <td className="mono">{fmtAvg(stat.obp)}</td><td className="mono">{fmtAvg(stat.ops)}</td>
      <td className="mono">{stat.strikeOuts ?? "—"}</td>
    </tr>
  );
}

// ── Pitcher Batted Ball Profile + Quality of Contact tables ──
// Mirrors Savant pitcher-page tables (pic 1, sections 2 & 3): pitcher's allowed
// contact distribution + 6-bucket quality of contact, both with player vs MLB rows.
// Source: getPitcherStatcast() — single CSV pull, league avgs from same fetch.

// Color helper: lower-is-better metrics get inverse coloring (e.g. higher Barrel%
// against a pitcher = WORSE for him → red).
function _scLowerBetter(v, lg, scale = 1.2) {
  if (v == null || lg == null) return "#4c5f7d";
  const delta = (v - lg) / lg;
  if (delta < -0.15 * scale) return "#0f8a44";  // much lower than lg = great
  if (delta < -0.05 * scale) return "#65a30d";
  if (delta < 0.05 * scale)  return "#4c5f7d";
  if (delta < 0.15 * scale)  return "#a16207";
  return "#d03131";
}
// For metrics where higher = pitcher-positive (e.g. GB% allowed = good for him).
function _scHigherBetter(v, lg, scale = 1.2) {
  if (v == null || lg == null) return "#4c5f7d";
  const delta = (v - lg) / lg;
  if (delta > 0.15 * scale) return "#0f8a44";
  if (delta > 0.05 * scale) return "#65a30d";
  if (delta > -0.05 * scale) return "#4c5f7d";
  if (delta > -0.15 * scale) return "#a16207";
  return "#d03131";
}

function PitcherBattedBallTable({ stats, year, playerName }) {
  if (!stats) return null;
  const lg = stats.lgAvg || {};
  const lastName = playerName ? playerName.trim().split(" ").slice(-1)[0] : "Pitcher";
  const fmtP = (v) => v == null ? "—" : v.toFixed(1);
  // Pitcher-allowed: high GB% = good (suppresses HR/TB). Low FB%/PU% = good.
  // For display, color the player value; MLB row is neutral grey.
  const cols = [
    { key:"gbPct",   label:"GB%",    color:(v) => _scHigherBetter(v, lg.gbPct) },
    { key:"airPct",  label:"AIR%",   color:(v) => _scLowerBetter(v, lg.airPct) },
    { key:"fbPct",   label:"FB%",    color:(v) => _scLowerBetter(v, lg.fbPct) },
    { key:"ldPct",   label:"LD%",    color:(v) => _scLowerBetter(v, lg.ldPct) },
    { key:"puPct",   label:"PU%",    color:(v) => _scHigherBetter(v, lg.puPct) },
    { key:"pullPct", label:"Pull%",  color:() => "#4c5f7d" },
    { key:"straightPct", label:"Straight%", color:() => "#4c5f7d" },
    { key:"oppoPct", label:"Oppo%",  color:() => "#4c5f7d" },
  ];
  return (
    <div style={{ background:"rgba(222,226,241,0.7)", borderRadius:8, border:"1px solid rgba(32,98,200,0.128)", overflow:"hidden", marginBottom:14 }}>
      <div style={{ padding:"6px 12px", borderBottom:"1px solid rgba(32,98,200,0.16)", background:"rgba(210,217,236,0.6)", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
        <span style={{ fontSize:10, fontWeight:700, color:"#c2570f", textTransform:"uppercase", letterSpacing:1 }}>
          🎯 Batted Ball Profile · {year}
        </span>
        <span style={{ fontSize:8, color:"#b6c5dc", fontStyle:"italic" }}>pitcher allowed</span>
      </div>
      {/* Header row */}
      <div style={{ display:"grid", gridTemplateColumns:`90px repeat(${cols.length}, 1fr)`, padding:"5px 10px", borderBottom:"1px solid rgba(32,98,200,0.128)" }}>
        <div style={{ fontSize:8.5, color:"#8b99b0", textTransform:"uppercase", letterSpacing:0.6, fontWeight:700 }}>Source</div>
        {cols.map(c => (
          <div key={c.key} style={{ fontSize:8.5, color:"#8b99b0", textTransform:"uppercase", letterSpacing:0.6, fontWeight:700, textAlign:"center" }}>{c.label}</div>
        ))}
      </div>
      {/* Player row */}
      <div style={{ display:"grid", gridTemplateColumns:`90px repeat(${cols.length}, 1fr)`, padding:"6px 10px", alignItems:"center", background:"rgba(32,98,200,0.064)" }}>
        <div style={{ fontSize:11, fontWeight:700, color:"#9333ea" }}>{lastName}</div>
        {cols.map(c => (
          <div key={c.key} style={{ fontSize:11, fontWeight:700, color: c.color(stats[c.key]), fontFamily:"'JetBrains Mono',monospace", textAlign:"center" }}>
            {fmtP(stats[c.key])}
          </div>
        ))}
      </div>
      {/* MLB row */}
      <div style={{ display:"grid", gridTemplateColumns:`90px repeat(${cols.length}, 1fr)`, padding:"6px 10px", alignItems:"center" }}>
        <div style={{ fontSize:11, fontWeight:600, color:"#64748d" }}>MLB</div>
        {cols.map(c => (
          <div key={c.key} style={{ fontSize:11, fontWeight:600, color:"#64748d", fontFamily:"'JetBrains Mono',monospace", textAlign:"center" }}>
            {fmtP(lg[c.key])}
          </div>
        ))}
      </div>
      <div style={{ padding:"4px 10px 5px", fontSize:8, color:"#c9d5e8", borderTop:"1px solid rgba(32,98,200,0.08)" }}>
        GB = ground ball · AIR = FB+LD+PU · Pull/Straight/Oppo from pitcher perspective · Savant
      </div>
    </div>
  );
}

function PitcherQualityOfContactTable({ stats, year, playerName }) {
  if (!stats) return null;
  const lg = stats.lgAvg || {};
  const lastName = playerName ? playerName.trim().split(" ").slice(-1)[0] : "Pitcher";
  const fmtP = (v) => v == null ? "—" : v.toFixed(1);
  // For a pitcher: Weak/Topped/Under = good (soft contact); Flare/Solid/Barrel = bad
  const cols = [
    { key:"weakPct",        label:"Weak%",   color:(v) => _scHigherBetter(v, lg.weakPct) },
    { key:"toppedPct",      label:"Topped%", color:(v) => _scHigherBetter(v, lg.toppedPct) },
    { key:"underPct",       label:"Under%",  color:(v) => _scHigherBetter(v, lg.underPct) },
    { key:"flareBurnerPct", label:"Flare%",  color:(v) => _scLowerBetter(v, lg.flareBurnerPct) },
    { key:"solidPct",       label:"Solid%",  color:(v) => _scLowerBetter(v, lg.solidPct) },
    { key:"barrel",         label:"Barrel%", color:(v) => _scLowerBetter(v, lg.barrel, 1.4) },
  ];
  return (
    <div style={{ background:"rgba(222,226,241,0.7)", borderRadius:8, border:"1px solid rgba(32,98,200,0.128)", overflow:"hidden", marginBottom:14 }}>
      <div style={{ padding:"6px 12px", borderBottom:"1px solid rgba(32,98,200,0.16)", background:"rgba(210,217,236,0.6)", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
        <span style={{ fontSize:10, fontWeight:700, color:"#6d4fd0", textTransform:"uppercase", letterSpacing:1 }}>
          💥 Quality of Contact · {year}
        </span>
        <span style={{ fontSize:8, color:"#b6c5dc", fontStyle:"italic" }}>pitcher allowed</span>
      </div>
      <div style={{ display:"grid", gridTemplateColumns:`90px repeat(${cols.length}, 1fr)`, padding:"5px 10px", borderBottom:"1px solid rgba(32,98,200,0.128)" }}>
        <div style={{ fontSize:8.5, color:"#8b99b0", textTransform:"uppercase", letterSpacing:0.6, fontWeight:700 }}>Source</div>
        {cols.map(c => (
          <div key={c.key} style={{ fontSize:8.5, color:"#8b99b0", textTransform:"uppercase", letterSpacing:0.6, fontWeight:700, textAlign:"center" }}>{c.label}</div>
        ))}
      </div>
      <div style={{ display:"grid", gridTemplateColumns:`90px repeat(${cols.length}, 1fr)`, padding:"6px 10px", alignItems:"center", background:"rgba(32,98,200,0.064)" }}>
        <div style={{ fontSize:11, fontWeight:700, color:"#9333ea" }}>{lastName}</div>
        {cols.map(c => (
          <div key={c.key} style={{ fontSize:11, fontWeight:700, color: c.color(stats[c.key]), fontFamily:"'JetBrains Mono',monospace", textAlign:"center" }}>
            {fmtP(stats[c.key])}
          </div>
        ))}
      </div>
      <div style={{ display:"grid", gridTemplateColumns:`90px repeat(${cols.length}, 1fr)`, padding:"6px 10px", alignItems:"center" }}>
        <div style={{ fontSize:11, fontWeight:600, color:"#64748d" }}>MLB</div>
        {cols.map(c => (
          <div key={c.key} style={{ fontSize:11, fontWeight:600, color:"#64748d", fontFamily:"'JetBrains Mono',monospace", textAlign:"center" }}>
            {fmtP(lg[c.key])}
          </div>
        ))}
      </div>
      <div style={{ padding:"4px 10px 5px", fontSize:8, color:"#c9d5e8", borderTop:"1px solid rgba(32,98,200,0.08)" }}>
        Weak/Topped/Under = soft contact (pitcher-positive) · Flare/Solid/Barrel = hard contact · Savant
      </div>
    </div>
  );
}

// ── Statcast Percentile Bar ──
// ── League average stat values (for Statcast context) ──
const STATCAST_LEAGUE_AVG = {
  "Exit Velocity":  "88.5 mph",
  "Barrel%":        "8%",
  "Hard Hit%":      "36%",
  "xwOBA":          ".310",
  "xBA":            ".240",
  "BB%":            "8.5%",
  "K%":             "22.5%",
  "Whiff%":         "24%",
  "Chase%":         "28%",
  "Bat Speed":      "71 mph",
  "Sprint Speed":   "27 ft/s",
};

// ── Pitcher Statcast Percentile Card ──
// Mirrors StatcastCard's Savant-style PctBar + TableSection layout (see memory: project-statcast-card-pattern).
// `rawStats` comes from getPitcherStatcast (custom leaderboard CSV); `percentiles` from getPitcherStatcastPercentiles.
function PitcherStatcastCard({ percentiles, rawStats, playerName, hintsEnabled = false }) {
  if (!percentiles) {
    return (
      <div style={{ textAlign:"center", padding:40, color:"#b6c5dc", fontSize:12 }}>
        Loading Statcast data…
      </div>
    );
  }
  const p = percentiles;
  const r = rawStats || {};
  const fmt1 = (v) => v != null ? v.toFixed(1) : null;
  const fmt2 = (v) => v != null ? v.toFixed(2) : null;
  const fmtPct = (v) => v != null ? v.toFixed(1) + "%" : null;
  const fmtOBA = (v) => v != null ? "." + Math.round(v * 1000).toString().padStart(3,"0") : null;
  const rankColor = (rr) => rr == null ? "#74839d" : rr >= 80 ? "#0f8a44" : rr >= 60 ? "#65a30d" : rr >= 40 ? "#a16207" : rr >= 20 ? "#c2570f" : "#d03131";
  const lastName = playerName ? playerName.trim().split(" ").slice(-1)[0] : "Pitcher";

  // Identical PctBar / TableSection from StatcastCard — copied verbatim per the project pattern.
  const PctBar = ({ rank }) => {
    const rr = rank != null ? Math.round(rank) : null;
    const col = rankColor(rr);
    const pos = rr != null ? Math.max(3, Math.min(97, rr)) : 0;
    return (
      <div style={{ position:"relative", width:"100%", height:18, display:"flex", alignItems:"center" }}>
        <div style={{ position:"absolute", left:0, right:0, top:"50%", transform:"translateY(-50%)", height:6, background:"rgba(32,98,200,0.128)", borderRadius:3 }} />
        <div style={{ position:"absolute", left:"50%", top:"50%", transform:"translate(-50%, -50%)", width:1, height:10, background:"rgba(93,111,139,0.35)" }} />
        <div style={{ position:"absolute", left:"25%", top:"50%", transform:"translate(-50%, -50%)", width:1, height:6, background:"rgba(93,111,139,0.18)" }} />
        <div style={{ position:"absolute", left:"75%", top:"50%", transform:"translate(-50%, -50%)", width:1, height:6, background:"rgba(93,111,139,0.18)" }} />
        {rr != null && (
          <>
            <div style={{ position:"absolute", left:0, top:"50%", transform:"translateY(-50%)", height:6, width:`${pos}%`, background:col, opacity:0.5, borderRadius:3 }} />
            <div style={{ position:"absolute", left:`${pos}%`, top:"50%", transform:"translate(-50%, -50%)", minWidth:18, height:18, padding:"0 4px", borderRadius:9, background:col, border:"1.5px solid #eef1f8", display:"flex", alignItems:"center", justifyContent:"center", boxShadow:`0 0 4px ${col}55` }}>
              <span style={{ fontSize:9, fontWeight:800, color:"#eef1f8", fontFamily:"system-ui" }}>{rr}</span>
            </div>
          </>
        )}
      </div>
    );
  };

  const LABEL_W = 92;
  const VAL_W   = 70;
  const LG_W    = 60;

  const TableSection = ({ title, rows }) => {
    const validRows = rows.filter(rw => rw.pct != null);
    if (!validRows.length) return null;
    const showPlayerCol = validRows.some(rw => rw.rawVal);
    return (
      <div style={{ marginBottom:14 }}>
        <div style={{ display:"flex", alignItems:"center", paddingBottom:5, borderBottom:"1px solid rgba(32,98,200,0.16)", marginBottom:6, gap:8 }}>
          <span style={{ fontSize:9, fontWeight:700, color:"#2062c8", textTransform:"uppercase", letterSpacing:1, width:LABEL_W }}>{title}</span>
          <div style={{ flex:1, display:"flex", justifyContent:"space-between", fontSize:8, color:"#b6c5dc", textTransform:"uppercase", letterSpacing:0.5, padding:"0 2px" }}>
            <span>Poor</span><span>Avg</span><span>Great</span>
          </div>
          {showPlayerCol && (
            <div style={{ width:VAL_W, textAlign:"right", fontSize:9, fontWeight:700, color:"#9333ea", textTransform:"uppercase", letterSpacing:0.5 }}>{lastName}</div>
          )}
          <div style={{ width:LG_W, textAlign:"right", fontSize:9, fontWeight:700, color:"#5d6f8b", textTransform:"uppercase", letterSpacing:0.5 }}>Lg Avg</div>
        </div>
        <div>
          {validRows.map(({ label, pct, rawVal, lgAvg, hint }, i) => {
            const rr = Math.round(pct);
            return (
              <div key={label} title={hintsEnabled && hint ? hint : undefined} style={{ display:"flex", alignItems:"center", padding:"5px 0", borderBottom: i < validRows.length - 1 ? "1px solid rgba(32,98,200,0.096)" : "none", gap:8 }}>
                <span style={{ fontSize:11, color:"#5d6f8b", width:LABEL_W }}>{label}</span>
                <div style={{ flex:1, minWidth:80 }}>
                  <PctBar rank={rr} />
                </div>
                {showPlayerCol && (
                  <span style={{ width:VAL_W, textAlign:"right", fontSize:11, fontWeight:700, color:"#16233c", fontFamily:"'JetBrains Mono',monospace" }}>{rawVal || "—"}</span>
                )}
                <span style={{ width:LG_W, textAlign:"right", fontSize:10, fontWeight:600, color:"#64748d", fontFamily:"'JetBrains Mono',monospace" }}>{lgAvg || "—"}</span>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  // Savant's pitcher percentile CSV is already pre-oriented so 99 = best for the pitcher
  // (verified: Skenes xera=96, Brown xera=83 → high percentile = elite). Use percentiles directly.
  return (
    <div>
      <TableSection title="Run Prevention" rows={[
        { label:"xERA",  pct: p.xera,  rawVal: r.xera != null ? fmt2(r.xera) : null, lgAvg:"4.10", hint:"Expected ERA from contact quality — luck-adjusted. 99 = best." },
        { label:"xwOBA", pct: p.xwoba, rawVal: fmtOBA(r.xwoba),                      lgAvg:".315", hint:"Expected wOBA allowed. Best single luck-adjusted run-prevention metric. 99 = best." },
        { label:"xBA",   pct: p.xba,   rawVal: fmtOBA(r.xba),                        lgAvg:".240", hint:"Expected batting average allowed. 99 = lowest allowed." },
        { label:"xSLG",  pct: p.xslg,  rawVal: fmtOBA(r.xslg),                       lgAvg:".400", hint:"Expected slugging allowed. 99 = lowest allowed." },
      ]} />
      <TableSection title="Stuff & Command" rows={[
        { label:"K%",     pct: p.k_percent,     rawVal: fmtPct(r.kPct),     lgAvg:"22.5%", hint:"Strikeout rate. 99 = elite swing-and-miss." },
        { label:"BB%",    pct: p.bb_percent,    rawVal: fmtPct(r.bbPct),    lgAvg:"8.5%",  hint:"Walk rate. 99 = elite command (fewest walks)." },
        { label:"Whiff%", pct: p.whiff_percent, rawVal: fmtPct(r.whiff),    lgAvg:"24%",   hint:"Swings-and-misses per swing. 99 = elite swing/miss stuff." },
        { label:"Chase%", pct: p.chase_percent, rawVal: fmtPct(r.chasePct), lgAvg:"28%",   hint:"Out-of-zone swing rate induced. Higher = better command outside zone." },
      ]} />
      <TableSection title="Contact Allowed" rows={[
        { label:"Exit Velo", pct: p.exit_velocity,    rawVal: fmt1(r.exitVelo) ? fmt1(r.exitVelo)+" mph" : null, lgAvg:"88.5 mph", hint:"Avg exit velocity allowed. 99 = softest contact allowed." },
        { label:"Hard Hit%", pct: p.hard_hit_percent, rawVal: fmtPct(r.hardHit),                                  lgAvg:"36%",      hint:"Hard contact (95+ mph) allowed. 99 = least hard contact allowed." },
        { label:"Barrel%",   pct: p.brl_percent,      rawVal: fmtPct(r.barrel),                                   lgAvg:"8%",       hint:"Barrel rate allowed. 99 = least barrels allowed." },
      ]} />
      <TableSection title="Velocity & Spin" rows={[
        { label:"FB Velo",    pct: p.fb_velocity, rawVal: null, lgAvg:"93.5 mph", hint:"Fastball velocity percentile vs MLB pitchers." },
        { label:"FB Spin",    pct: p.fb_spin,     rawVal: null, lgAvg:"2300 rpm", hint:"Fastball spin rate percentile — drives carry/movement." },
        { label:"Curve Spin", pct: p.curve_spin,  rawVal: null, lgAvg:"2500 rpm", hint:"Breaking-ball spin percentile." },
      ]} />
      <div style={{ fontSize:9, color:"#c9d5e8", marginTop:4 }}>
        Percentile ranks vs all MLB pitchers · Source: Baseball Savant · 99 = best, 1 = worst
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════
// ── PITCHER PANEL (full slide-in, like BatterPanel) ──
// ══════════════════════════════════════════════════════════

// Shown above tabs on PitcherPanel — opposing team season offense w/ league ranks (1=best, 30=worst).
// Mirrors the BatterPanel BvP card layout: orange section header + venue on right, StatBox cards below.
function OppOffenseStrip({ data, venueName }) {
  const { team, stats, ranks } = data;
  if (!stats) return null;
  const rankColor = (r) => {
    if (r == null) return "#74839d";
    if (r <= 8)  return "#0f8a44";  // top third = green (tough offense)
    if (r >= 23) return "#d03131";  // bottom third = red (weak offense — easier matchup)
    return "#4c5f7d";
  };
  const fmt3 = v => v != null ? v.toFixed(3).replace(/^0/, "") : "—";
  const fmt1 = v => v != null ? v.toFixed(1) : "—";
  const fmt2 = v => v != null ? v.toFixed(2) : "—";
  const rankSub = (r) => r != null ? (
    <span style={{ color: rankColor(r), fontWeight: 700, fontFamily: "'JetBrains Mono',monospace" }}>#{r}</span>
  ) : null;
  return (
    <div style={{ padding: "12px 20px", borderBottom: "1px solid rgba(32,98,200,0.128)", background: "rgba(194,87,15,0.04)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
        <div style={{ fontSize: 10, color: "#c2570f", textTransform: "uppercase", letterSpacing: 1 }}>
          vs {team} Offense
        </div>
        {venueName && (
          <div style={{ fontSize: 10, color: "#5d6f8b", display: "flex", alignItems: "center", gap: 4 }}>
            <span>🏟️</span><span>{venueName}</span>
          </div>
        )}
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <StatBox label="K%"  value={fmt1(stats.kPct) + "%"}  sub={rankSub(ranks?.kPct)} />
        <StatBox label="BB%" value={fmt1(stats.bbPct) + "%"} sub={rankSub(ranks?.bbPct)} />
        <StatBox label="AVG" value={fmt3(stats.avg)}         sub={rankSub(ranks?.avg)} />
        <StatBox label="OBP" value={fmt3(stats.obp)}         sub={rankSub(ranks?.obp)} />
        <StatBox label="SLG" value={fmt3(stats.slg)}         sub={rankSub(ranks?.slg)} />
        <StatBox label="OPS" value={fmt3(stats.ops)}         sub={rankSub(ranks?.ops)} />
        <StatBox label="R/G" value={fmt2(stats.rpg)}         sub={rankSub(ranks?.rpg)} />
      </div>
    </div>
  );
}

function PitcherPanel({ pitcher, pitcherTeam, season, onClose, pitcherScanData, propOddsMap, fullPageMode = false, opponentTeam = null, lineupData = {}, venueName = null }) {
  const isMobile = useIsMobile();
  const [tab, setTab] = useState("statsplits");
  const [loading, setLoading] = useState(true);
  const [seasonData, setSeasonData] = useState(null);
  const [splitsYear, setSplitsYear] = useState(parseInt(season));
  const [splitsCache, setSplitsCache] = useState({});
  const [arsenalYear, setArsenalYear] = useState(2026);
  const [arsenalCache, setArsenalCache] = useState({});  // year → splits[]
  const [statcastCache, setStatcastCache] = useState({}); // year → { pitchCode → metrics }
  const [arsenalLoading, setArsenalLoading] = useState(false);
  const [disciplineCache, setDisciplineCache] = useState({}); // year → plate discipline metrics
  const [bio, setBio] = useState(null);
  const [news, setNews] = useState(null);
  const [newsLoading, setNewsLoading] = useState(true);
  const [activePeriod, setActivePeriod] = useState("L20");
  const [activeFilters, setActiveFilters] = useState(new Set());
  const [gameLog2025, setGameLog2025] = useState(null);
  const [loading2025, setLoading2025] = useState(false);
  const [pitcherStatcast, setPitcherStatcast] = useState(null);
  const [pitcherPercentiles, setPitcherPercentiles] = useState(undefined); // Savant percentile rankings
  const [pitcherArmAngles, setPitcherArmAngles]     = useState(undefined); // arm angle / release data
  const [pitcherRunningGame, setPitcherRunningGame]  = useState(undefined); // SB allowed / holding data
  const [lineupBvpCache, setLineupBvpCache] = useState({}); // batterId → bvp data | "loading"
  const [oppRosterById, setOppRosterById] = useState({}); // normalized name → { id, ...}
  const [bhSortCol, setBhSortCol] = useState(null);  // Batter History sort col
  const [bhSortDir, setBhSortDir] = useState("desc");
  const [headerStatsYear, setHeaderStatsYear] = useState(parseInt(season) || 2026);
  const [pitcherStats2025, setPitcherStats2025] = useState(null);
  // Zone matchup tab (pitcher side)
  const [pitcherPitchLocs, setPitcherPitchLocs] = useState(null); // null=not loaded
  const [lgPitchMove, setLgPitchMove] = useState(null);  // { R: { FF: {px,pz,speed} }, L: {...} }
  const [pZoneMetric, setPZoneMetric] = useState("ops");
  const [pZoneOverlay, setPZoneOverlay] = useState(true);
  const [pZoneActivePitches, setPZoneActivePitches] = useState(null);
  const [pZoneSelectedBatter, setPZoneSelectedBatter] = useState(null); // batterId for hot zones
  const [pZoneBatterHotZones, setPZoneBatterHotZones] = useState({}); // batterId → hot zones
  const [oppOffense, setOppOffense] = useState(null); // { team, stats:{k_pct,bb_pct,avg,obp,slg,ops,rpg}, ranks:{...} }
  const injury = usePlayerInjury(pitcher?.id, season); // null unless currently on the IL

  // Resolve opponent team abbreviation from any of: scanData, prop, lineupData
  const resolvedOppAbbr = (() => {
    const fromScan = pitcherScanData?.opponent;
    if (fromScan) return fromScan;
    if (opponentTeam) return opponentTeam;
    const pitcherTeamAbbrev = pitcherTeam || "";
    const ldKeys = Object.keys(lineupData || {});
    if (ldKeys.length === 2 && ldKeys.includes(pitcherTeamAbbrev)) return ldKeys.find(k => k !== pitcherTeamAbbrev) || null;
    return null;
  })();

  // Opponent team offense — league-wide hitting stats fetched once, then ranks computed for the opp team.
  useEffect(() => {
    if (!resolvedOppAbbr) { setOppOffense(null); return; }
    const oppId = MLB_TEAM_IDS[resolvedOppAbbr.toUpperCase()];
    if (!oppId) { setOppOffense(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchJson(`${API}/teams/stats?stats=season&group=hitting&season=${season}&sportId=1`);
        const splits = res?.stats?.[0]?.splits || [];
        const rows = splits.map(s => {
          const st = s.stat || {};
          const pa = parseInt(st.plateAppearances) || 0;
          const g  = parseInt(st.gamesPlayed)      || 0;
          return {
            id:      s.team?.id,
            kPct:    pa > 0 ? (parseInt(st.strikeOuts) || 0) / pa * 100 : null,
            bbPct:   pa > 0 ? (parseInt(st.baseOnBalls) || 0) / pa * 100 : null,
            avg:     parseFloat(st.avg) || null,
            obp:     parseFloat(st.obp) || null,
            slg:     parseFloat(st.slg) || null,
            ops:     parseFloat(st.ops) || null,
            rpg:     g > 0 ? (parseInt(st.runs) || 0) / g : null,
          };
        }).filter(r => r.id);
        const me = rows.find(r => r.id === oppId);
        if (!me) { if (!cancelled) setOppOffense({ team: resolvedOppAbbr, stats: null, ranks: null }); return; }
        // Rank: 1 = best (highest for AVG/OBP/SLG/OPS/BB%/R/G, LOWEST for K%)
        const rankBy = (field, asc) => {
          const vals = rows.map(r => r[field]).filter(v => v != null);
          if (!vals.length) return null;
          const sorted = [...vals].sort((a, b) => asc ? a - b : b - a);
          const myV = me[field];
          if (myV == null) return null;
          return sorted.indexOf(myV) + 1;
        };
        const ranks = {
          kPct:  rankBy("kPct",  true),   // low K% = good for offense → asc
          bbPct: rankBy("bbPct", false),
          avg:   rankBy("avg",   false),
          obp:   rankBy("obp",   false),
          slg:   rankBy("slg",   false),
          ops:   rankBy("ops",   false),
          rpg:   rankBy("rpg",   false),
        };
        if (!cancelled) setOppOffense({ team: resolvedOppAbbr, stats: me, ranks });
      } catch (_) {
        if (!cancelled) setOppOffense(null);
      }
    })();
    return () => { cancelled = true; };
  }, [resolvedOppAbbr, season]);

  // Main data load
  useEffect(() => {
    if (!pitcher?.id) return;
    let cancelled = false;
    setLoading(true); setSeasonData(null); setBio(null);
    setPitcherPitchLocs(null); setPZoneActivePitches(null); setPZoneSelectedBatter(null); setPZoneBatterHotZones({});
    setNews(null); setNewsLoading(true); setArsenalCache({}); setStatcastCache({}); setDisciplineCache({}); setSplitsCache({});
    setGameLog2025(null); setLoading2025(false); setPitcherStatcast(null);
    setPitcherPercentiles(undefined); setPitcherArmAngles(undefined); setPitcherRunningGame(undefined);

    const playerName = pitcher.fullName || "";
    async function load() {
      const [kData, splitsRaw, bioData] = await Promise.all([
        getPitcherKData(pitcher.id, season),
        getSplits(pitcher.id, "vl,vr,h,a,d,n", season, "pitching"),
        getPlayerBio(pitcher.id),
      ]);
      if (cancelled) return;
      const labelMap = { "vs Left": "vs LHB", "vs Right": "vs RHB", "Home Games": "Home", "Away Games": "Away", "Day Games": "Day", "Night Games": "Night" };
      setSeasonData(kData);
      const mapped = splitsRaw.map(s => ({ ...s, label: labelMap[s.split?.description] || s.split?.description }));
      setSplitsCache({ [parseInt(season)]: mapped });
      setBio(bioData);
      setLoading(false);
    }
    async function loadNews() {
      if (!playerName) { setNewsLoading(false); return; }
      try {
        const articles = await getPlayerNews(playerName);
        if (!cancelled) { setNews(articles); setNewsLoading(false); }
      } catch { if (!cancelled) { setNews([]); setNewsLoading(false); } }
    }
    load();
    loadNews();
    return () => { cancelled = true; };
  }, [pitcher?.id, season]); // eslint-disable-line react-hooks/exhaustive-deps

  // Year-based splits fetch (also fires in fullPageMode when splitsYear changes)
  useEffect(() => {
    if (!fullPageMode && tab !== "statsplits") return;
    if (!pitcher?.id) return;
    const yr = splitsYear;
    if (splitsCache[yr]) return;
    let cancelled = false;
    getSplits(pitcher.id, "vl,vr,h,a,d,n", yr, "pitching").then(raw => {
      if (cancelled) return;
      const labelMap = { "vs Left": "vs LHB", "vs Right": "vs RHB", "Home Games": "Home", "Away Games": "Away", "Day Games": "Day", "Night Games": "Night" };
      setSplitsCache(c => ({ ...c, [yr]: raw.map(s => ({ ...s, label: labelMap[s.split?.description] || s.split?.description })) }));
    });
    return () => { cancelled = true; };
  }, [tab, splitsYear, pitcher?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Lazy-load pitcher plate discipline + Statcast from Baseball Savant when stats/arsenal tab opens
  useEffect(() => {
    if (!pitcher?.id) return;
    if (!fullPageMode && tab !== "stats" && tab !== "arsenal" && tab !== "statcast") return;
    if (disciplineCache[arsenalYear] === undefined) {
      getPlateDiscipline(pitcher.id, arsenalYear, "pitcher").then(data => {
        setDisciplineCache(c => ({ ...c, [arsenalYear]: data }));
      });
    }
    if (pitcherStatcast === null) {
      getPitcherStatcast(pitcher.id, arsenalYear).then(data => setPitcherStatcast(data));
    }
  }, [tab, pitcher?.id, arsenalYear, fullPageMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Lazy-load pitcher Savant percentile rankings + arm angles + running game when statsplits opens
  useEffect(() => {
    if (!pitcher?.id) return;
    if (!fullPageMode && tab !== "statsplits" && tab !== "statcast") return;
    const yr = parseInt(season);
    if (pitcherPercentiles === undefined) {
      setPitcherPercentiles(null);
      getPitcherStatcastPercentiles(pitcher.id, yr).then(v => setPitcherPercentiles(v ?? null)).catch(() => setPitcherPercentiles(null));
    }
    if (pitcherArmAngles === undefined) {
      setPitcherArmAngles(null);
      getPitcherArmAngles(pitcher.id, yr).then(v => setPitcherArmAngles(v ?? null)).catch(() => setPitcherArmAngles(null));
    }
    if (pitcherRunningGame === undefined) {
      setPitcherRunningGame(null);
      getPitcherRunningGame(pitcher.id, yr).then(v => setPitcherRunningGame(v ?? null)).catch(() => setPitcherRunningGame(null));
    }
  }, [tab, pitcher?.id, season, fullPageMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Lazy-load pitch arsenal + Statcast metrics when tab opened
  useEffect(() => {
    if (!pitcher?.id) return;
    if (!fullPageMode && tab !== "arsenal") return;
    if (arsenalCache[arsenalYear] !== undefined) return; // already cached
    let cancelled = false;
    setArsenalLoading(true);
    Promise.all([
      getPitchArsenal(pitcher.id, arsenalYear),
      getStatcastArsenal(pitcher.id, arsenalYear),
    ]).then(([splits, statcast]) => {
      if (!cancelled) {
        setArsenalCache(c => ({ ...c, [arsenalYear]: splits }));
        setStatcastCache(c => ({ ...c, [arsenalYear]: statcast }));
        setArsenalLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [tab, pitcher?.id, arsenalYear, fullPageMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch opposing team's roster to resolve Rotowire batter names → MLB player IDs
  useEffect(() => {
    if (!pitcher?.id || (!fullPageMode && tab !== "vl")) return;
    const resolvedOpp = pitcherScanData?.opponent || opponentTeam || (() => {
      const pitcherTeamAbbrev = pitcherTeam || "";
      const ldKeys = Object.keys(lineupData || {});
      if (ldKeys.length === 2 && ldKeys.includes(pitcherTeamAbbrev)) return ldKeys.find(k => k !== pitcherTeamAbbrev);
      return null;
    })();
    if (!resolvedOpp || Object.keys(oppRosterById).length > 0) return;
    const teamId = MLB_TEAM_IDS[resolvedOpp?.toUpperCase()];
    if (!teamId) return;
    getRoster(teamId, season).then(roster => {
      const byNorm = {};
      const byLast = {};
      (roster || []).forEach(p => {
        const norm = _normName(p.person?.fullName || "");
        if (norm) {
          const enriched = { ...p.person, posType: p.position?.type, posAbbr: p.position?.abbreviation };
          byNorm[norm] = enriched;
          const last = norm.split(" ").pop();
          if (last && !byLast[last]) byLast[last] = enriched;
        }
      });
      setOppRosterById({ ...byNorm, __byLast: byLast });
    }).catch(() => {});
  }, [tab, pitcher?.id, pitcherScanData?.opponent, opponentTeam, pitcherTeam, fullPageMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch BvP (career stats vs pitcher) for each batter in opposing lineup
  useEffect(() => {
    if (!pitcher?.id || (!fullPageMode && tab !== "vl")) return;
    // Derive opponent team: prefer scanData.opponent, then prop opponentTeam, fall back to 2-key lineupData check
    const resolvedOpp = pitcherScanData?.opponent || opponentTeam || (() => {
      const pitcherTeamAbbrev = pitcherTeam || "";
      const ldKeys = Object.keys(lineupData || {});
      if (ldKeys.length === 2 && ldKeys.includes(pitcherTeamAbbrev)) return ldKeys.find(k => k !== pitcherTeamAbbrev);
      return null;
    })();
    if (!resolvedOpp) return;
    const batters = lineupData[resolvedOpp]?.batters || [];
    const isRosterFallback = batters.length === 0;
    const effectiveBatters = isRosterFallback
      ? Object.entries(oppRosterById)
          .filter(([k, v]) => k !== "__byLast" && v?.posType !== "Pitcher")
          .map(([, person]) => ({ id: person.id, fullName: person.fullName, pos: person.posAbbr, isRosterFallback: true }))
      : batters.slice(0, 9);
    effectiveBatters.slice(0, 14).forEach(b => {
      // Lineup batters from Rotowire only have name/pos — resolve to MLB player ID via roster
      const directId = b.id || b.person?.id;
      const norm = _normName(b.name || b.fullName || "");
      const byLast = oppRosterById.__byLast || {};
      const rosterPerson = directId ? null : (oppRosterById[norm] || byLast[norm.split(" ").pop()] || null);
      const id = directId || rosterPerson?.id;
      if (!id || lineupBvpCache[id] !== undefined) return;
      setLineupBvpCache(c => ({ ...c, [id]: "loading" }));
      getVsPitcher(id, pitcher.id, season).then(data => {
        setLineupBvpCache(c => ({ ...c, [id]: data }));
      }).catch(() => {
        setLineupBvpCache(c => ({ ...c, [id]: null }));
      });
    });
  }, [JSON.stringify(Object.keys(lineupData || {})), pitcher?.id, fullPageMode, tab, Object.keys(oppRosterById).length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Lazy-load pitcher pitch locations + optional batter hot zones for Zones/Arsenal tabs
  useEffect(() => {
    if ((tab !== "zones" && tab !== "arsenal") || !pitcher?.id) return;
    // Pitcher pitch locations + league-avg movement (one cache-friendly aggregate fetch)
    if (pitcherPitchLocs === null) {
      getPitcherPitchLocations(pitcher.id, parseInt(season)).then(locs => {
        setPitcherPitchLocs(locs || {});
        setPZoneActivePitches(null);
      }).catch(() => setPitcherPitchLocs({}));
    }
    if (lgPitchMove === null) {
      getLeagueAvgPitchMovement(parseInt(season)).then(v => setLgPitchMove(v || { R:{}, L:{} }))
        .catch(() => setLgPitchMove({ R:{}, L:{} }));
    }
    // Selected batter's hot zones
    if (pZoneSelectedBatter && pZoneBatterHotZones[pZoneSelectedBatter] === undefined) {
      getPZoneHotZones(pZoneSelectedBatter, season);
    }
  }, [tab, pitcher?.id, pZoneSelectedBatter]); // eslint-disable-line react-hooks/exhaustive-deps

  function getPZoneHotZones(batterId, yr) {
    setPZoneBatterHotZones(c => ({ ...c, [batterId]: "loading" }));
    getBatterHotZones(batterId, yr).then(z => {
      setPZoneBatterHotZones(c => ({ ...c, [batterId]: z || {} }));
    }).catch(() => setPZoneBatterHotZones(c => ({ ...c, [batterId]: {} })));
  }

  // Fetch 2025 stats for header year toggle
  useEffect(() => {
    if (headerStatsYear === parseInt(season) || !pitcher?.id || pitcherStats2025) return;
    getPitcherKData(pitcher.id, headerStatsYear).then(data => {
      setPitcherStats2025(data);
    });
  }, [headerStatsYear, pitcher?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Lazy-fetch 2025 game log + splits when "2025" period is selected
  useEffect(() => {
    if (activePeriod !== "2025" || !pitcher?.id || gameLog2025 !== null) return;
    let cancelled = false;
    setLoading2025(true);
    const labelMap = { "vs Left": "vs LHB", "vs Right": "vs RHB", "Home Games": "Home", "Away Games": "Away", "Day Games": "Day", "Night Games": "Night" };
    Promise.all([
      getGameLog(pitcher.id, 2025, "pitching", 40),
      splitsCache[2025] ? Promise.resolve(null) : getSplits(pitcher.id, "vl,vr,h,a,d,n", 2025, "pitching"),
    ]).then(([gl, splitsRaw]) => {
      if (cancelled) return;
      setGameLog2025(gl || []);
      if (splitsRaw) {
        setSplitsCache(c => ({ ...c, 2025: splitsRaw.map(s => ({ ...s, label: labelMap[s.split?.description] || s.split?.description })) }));
      }
      setLoading2025(false);
    }).catch(() => { if (!cancelled) { setGameLog2025([]); setLoading2025(false); } });
    return () => { cancelled = true; };
  }, [activePeriod, pitcher?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const pitcherProj = useMemo(() => getPitcherProj(pitcher?.fullName), [pitcher?.fullName]);
  const ppr = useMemo(() => pitcherProjRates(pitcherProj), [pitcherProj]);
  const kModel = useMemo(() => {
    if (!seasonData) return null;
    return modelPitcherK({ proj: pitcherProj, seasonStats: seasonData.season, recentStarts: seasonData.gameLog, line: null });
  }, [seasonData, pitcherProj]);

  const hand = seasonData?.info?.pitchHand?.code || pitcher?.pitchHand?.code || "?";
  const s = seasonData?.season || {};
  const c = seasonData?.career || {};

  const filteredGameLog = useMemo(() => {
    let gl = activePeriod === "2025" ? (gameLog2025 || []) : (seasonData?.gameLog || []);
    if (activePeriod === "L5") gl = gl.slice(0, 5);
    else if (activePeriod === "L10") gl = gl.slice(0, 10);
    else if (activePeriod === "L20") gl = gl.slice(0, 20);
    if (activeFilters.has("home")) gl = gl.filter(g => g.isHome === true);
    if (activeFilters.has("away")) gl = gl.filter(g => g.isHome === false);
    if (activeFilters.has("day")) gl = gl.filter(g => g.game?.dayNight === "day");
    if (activeFilters.has("night")) gl = gl.filter(g => g.game?.dayNight === "night");
    return gl;
  }, [seasonData, gameLog2025, activePeriod, activeFilters]);

  const tabStyle = (active) => ({
    padding: "8px 12px", fontSize: 11, fontWeight: 600, letterSpacing: 0.5,
    background: active ? "rgba(32,98,200,0.24)" : "transparent",
    color: active ? "#2062c8" : "#74839d",
    border: active ? "1px solid rgba(32,98,200,0.3)" : "1px solid transparent",
    borderRadius: 6, cursor: "pointer", textTransform: "uppercase", transition: "all 0.15s",
  });

  // ── FULL-PAGE MODE ──────────────────────────────────────────────────
  if (fullPageMode) {
    const sd = pitcherScanData;
    const signal = sd?.signal;
    const kThresh = sd?.line ?? 4.5;
    const pitcherTeamAbbrev = pitcherTeam || "";
    // Opposing batters = lineup for the team the pitcher is NOT on
    // Prefer scanData.opponent (reliable), fall back to 2-key lineupData check
    const opposingTeamKey = pitcherScanData?.opponent || opponentTeam || (() => {
      const ldKeys = Object.keys(lineupData || {});
      if (ldKeys.length === 2 && ldKeys.includes(pitcherTeamAbbrev)) return ldKeys.find(k => k !== pitcherTeamAbbrev) || "";
      return "";
    })();
    const hasMatchupLineup = !!(opposingTeamKey && lineupData[opposingTeamKey]?.batters?.length);
    const opposingBatters = lineupData[opposingTeamKey]?.batters || [];
    const pillStyle = (active) => ({
      padding: "5px 14px", borderRadius: 20, fontSize: 11, fontWeight: 700,
      cursor: "pointer", border: "1px solid",
      background: active ? "rgba(194,87,15,0.18)" : "rgba(210,217,236,0.5)",
      borderColor: active ? "rgba(194,87,15,0.6)" : "rgba(32,98,200,0.24)",
      color: active ? "#cf6c1c" : "#74839d", transition: "all 0.15s",
    });
    const periodBtnStyle = (active) => ({
      padding: "4px 12px", borderRadius: 4, fontSize: 10, fontWeight: 600, cursor: "pointer",
      background: active ? "rgba(32,98,200,0.18)" : "transparent",
      border: active ? "1px solid rgba(32,98,200,0.4)" : "1px solid rgba(32,98,200,0.16)",
      color: active ? "#2062c8" : "#8b99b0",
    });
    const filterBtnStyle = (key) => {
      const on = activeFilters.has(key);
      return {
        padding: "4px 10px", borderRadius: 4, fontSize: 10, fontWeight: 600, cursor: "pointer",
        background: on ? "rgba(32,98,200,0.24)" : "transparent",
        border: on ? "1px solid rgba(32,98,200,0.35)" : "1px solid rgba(32,98,200,0.128)",
        color: on ? "#2062c8" : "#8b99b0",
      };
    };
    const toggleFilter = (key) => {
      setActiveFilters(prev => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key); else next.add(key);
        return next;
      });
    };

    return (
      <div style={{
        position: "fixed", top: 0, left: 0, width: "100vw",
        // 100dvh, not 100vh: on iOS Safari 100vh is taller than the visible
        // viewport while the URL bar is shown, so a fixed 100vh overlay hides
        // its own bottom and thrashes on every scroll-driven chrome resize.
        height: "100dvh",
        background: "linear-gradient(135deg, #e9edf5 0%, #f2f5fb 100%)", zIndex: 1000,
        overflowY: "auto", display: "flex", flexDirection: "column",
        WebkitOverflowScrolling: "touch", overscrollBehavior: "contain",
      }}>
        {loading ? (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Loader text="Loading pitcher data..." />
          </div>
        ) : (
          <div style={{ flex: 1, display: "grid", gridTemplateColumns: isMobile ? "1fr" : "64fr 36fr", maxWidth: 1400, margin: "0 auto", width: "100%", gap: 0, minHeight: "100dvh" }}>
            {/* ── LEFT COLUMN ── */}
            <div style={{ padding: "0 0 60px 0", borderRight: isMobile ? "none" : "1px solid rgba(32,98,200,0.128)" }}>
              {/* Sticky header */}
              <div style={{ position: "sticky", top: 0, zIndex: 10, background: "rgba(222,228,241,0.97)", borderBottom: "1px solid rgba(32,98,200,0.16)", padding: "12px 24px 10px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 8 }}>
                  <button onClick={onClose} style={{
                    background: "rgba(22,44,80,0.06)", border: "1px solid rgba(22,44,80,0.1)",
                    color: "#5d6f8b", borderRadius: 8, padding: "6px 12px", cursor: "pointer",
                    fontSize: 13, display: "flex", alignItems: "center", gap: 6,
                  }}>← Back</button>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 11, color: "#c2570f", textTransform: "uppercase", letterSpacing: 1.2 }}>Pitcher Profile</div>
                    <div style={{ fontSize: 22, fontWeight: 700, color: "#16233c", lineHeight: 1.2, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      {pitcher.fullName}
                      <InjuryBadge inj={injury} size={16} />
                    </div>
                    <div style={{ fontSize: 12, color: "#6d7c96" }}>
                      {hand}HP · {pitcherTeamAbbrev}{ppr?.type === "SP" ? " · SP" : ppr?.type === "RP" ? " · RP" : ""}
                      {bio?.birthDate && (() => {
                        const age = Math.floor((Date.now() - new Date(bio.birthDate + "T12:00:00")) / (365.25*24*3600*1000));
                        return ` · Age ${age}`;
                      })()}
                    </div>
                    <ContractLine playerId={pitcher?.id} />
                    <InjuryLine inj={injury} />
                  </div>
                  {sd && (
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: 10, color: "#8b99b0", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 2 }}>K Signal</div>
                      <div style={{
                        fontSize: 13, fontWeight: 700, fontFamily: "'JetBrains Mono',monospace",
                        color: signal === "over" ? "#0f8a44" : signal === "under" ? "#d03131" : "#74839d",
                        padding: "4px 10px", borderRadius: 6,
                        background: signal === "over" ? "rgba(15,138,68,0.1)" : signal === "under" ? "rgba(208,49,49,0.1)" : "rgba(116,131,157,0.1)",
                        border: `1px solid ${signal === "over" ? "rgba(15,138,68,0.3)" : signal === "under" ? "rgba(208,49,49,0.3)" : "rgba(116,131,157,0.15)"}`,
                      }}>
                        {signal === "over" ? "▲ OVER" : signal === "under" ? "▼ UNDER" : "—"} · O{kThresh}
                      </div>
                    </div>
                  )}
                </div>
                {/* Stat pills row 1 — season stats with year toggle */}
                {(() => {
                  const displayS = headerStatsYear === parseInt(season) ? s : (pitcherStats2025?.season || {});
                  const yrToggle = (yr) => ({
                    fontSize: 9, padding: "2px 7px", borderRadius: 3, cursor: "pointer", fontWeight: 700,
                    background: headerStatsYear === yr ? "rgba(194,87,15,0.15)" : "transparent",
                    color: headerStatsYear === yr ? "#c2570f" : "#b6c5dc",
                    border: headerStatsYear === yr ? "1px solid rgba(194,87,15,0.3)" : "1px solid transparent",
                  });
                  return (
                    <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 4, alignItems: "center" }}>
                      <div style={{ display: "flex", gap: 2, marginRight: 4 }}>
                        {[2025, 2026].map(yr => <button key={yr} onClick={() => setHeaderStatsYear(yr)} style={yrToggle(yr)}>{yr}</button>)}
                      </div>
                      {[
                        { label: "ERA", val: fmt(displayS.era, 2), accent: Number(displayS.era)<3?"#0f8a44":Number(displayS.era)>5?"#d03131":undefined },
                        { label: "WHIP", val: fmt(displayS.whip, 2), accent: Number(displayS.whip)<1.1?"#0f8a44":Number(displayS.whip)>1.5?"#d03131":undefined },
                        { label: "K", val: displayS.strikeOuts ?? "—" },
                        { label: "K/9", val: fmt(displayS.strikeoutsPer9Inn, 1) },
                        { label: "BB/9", val: fmt(displayS.walksPer9Inn, 1) },
                        { label: "IP", val: displayS.inningsPitched || "—" },
                        { label: "W-L", val: `${displayS.wins??0}-${displayS.losses??0}` },
                      ].map(({ label, val, accent }) => (
                        <div key={label} style={{ padding: "3px 10px", borderRadius: 12, background: "rgba(210,217,236,0.7)", border: "1px solid rgba(32,98,200,0.192)", display: "flex", gap: 5, alignItems: "center" }}>
                          <span style={{ fontSize: 9, color: "#8b99b0", textTransform: "uppercase", letterSpacing: 0.6 }}>{label}</span>
                          <span style={{ fontSize: 12, fontWeight: 700, color: accent || "#16233c", fontFamily: "'JetBrains Mono',monospace" }}>{val}</span>
                        </div>
                      ))}
                    </div>
                  );
                })()}
                {/* Stat pills row 2 — Statcast (loads async) */}
                {pitcherStatcast && (
                  <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                    {[
                      { label: "xERA",    val: pitcherStatcast.xera    != null ? fmt(pitcherStatcast.xera, 2) : "—",   accent: pitcherStatcast.xera < 3.5 ? "#0f8a44" : pitcherStatcast.xera > 5 ? "#d03131" : "#4c5f7d" },
                      { label: "Whiff%",  val: pitcherStatcast.whiff   != null ? pitcherStatcast.whiff.toFixed(1)+"%" : "—",  accent: pitcherStatcast.whiff > 28 ? "#0f8a44" : pitcherStatcast.whiff < 18 ? "#d03131" : "#4c5f7d" },
                      { label: "HardHit%",val: pitcherStatcast.hardHit != null ? pitcherStatcast.hardHit.toFixed(1)+"%" : "—", accent: pitcherStatcast.hardHit < 35 ? "#0f8a44" : pitcherStatcast.hardHit > 45 ? "#d03131" : "#4c5f7d" },
                      { label: "Barrel%", val: pitcherStatcast.barrel  != null ? pitcherStatcast.barrel.toFixed(1)+"%" : "—",  accent: pitcherStatcast.barrel < 6 ? "#0f8a44" : pitcherStatcast.barrel > 10 ? "#d03131" : "#4c5f7d" },
                      { label: "K%",      val: pitcherStatcast.kPct    != null ? pitcherStatcast.kPct.toFixed(1)+"%" : "—",    accent: pitcherStatcast.kPct > 27 ? "#0f8a44" : pitcherStatcast.kPct < 18 ? "#d03131" : "#4c5f7d" },
                      { label: "BB%",     val: pitcherStatcast.bbPct   != null ? pitcherStatcast.bbPct.toFixed(1)+"%" : "—",   accent: pitcherStatcast.bbPct < 7 ? "#0f8a44" : pitcherStatcast.bbPct > 12 ? "#d03131" : "#4c5f7d" },
                      { label: "EvA",     val: pitcherStatcast.exitVelo!= null ? pitcherStatcast.exitVelo.toFixed(1) : "—",    accent: pitcherStatcast.exitVelo < 87 ? "#0f8a44" : pitcherStatcast.exitVelo > 92 ? "#d03131" : "#4c5f7d" },
                    ].map(({ label, val, accent }) => (
                      <div key={label} style={{ padding: "2px 8px", borderRadius: 10, background: "rgba(32,98,200,0.096)", border: "1px solid rgba(32,98,200,0.16)", display: "flex", gap: 4, alignItems: "center" }}>
                        <span style={{ fontSize: 8, color: "#8b99b0", textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</span>
                        <span style={{ fontSize: 11, fontWeight: 700, color: accent || "#16233c", fontFamily: "'JetBrains Mono',monospace" }}>{val}</span>
                      </div>
                    ))}
                    <span style={{ fontSize: 8, color: "#c9d5e8", alignSelf: "center" }}>Statcast</span>
                  </div>
                )}
                {/* Stat pills row 3 — FanGraphs advanced (from DB) */}
                {sd?.advancedStats && (() => {
                  const adv = sd.advancedStats;
                  const fmtPct = (v) => v != null ? v.toFixed(1) + "%" : null;
                  const fmtF = (v, d = 2) => v != null ? v.toFixed(d) : null;
                  const fmtN = (v) => v != null ? Math.round(v).toString() : null;
                  const pills = [
                    { label:"SIERA",  val: fmtF(adv.siera),  accent: adv.siera != null ? (adv.siera < 3.5 ? "#0f8a44" : adv.siera > 4.5 ? "#d03131" : "#4c5f7d") : "#4c5f7d", hint:"Skill-Interactive ERA. Best ERA estimator accounting for HR/FB, K%, BB%. Lower = better." },
                    { label:"FIP",    val: fmtF(adv.fip),    accent: adv.fip   != null ? (adv.fip   < 3.5 ? "#0f8a44" : adv.fip   > 4.5 ? "#d03131" : "#4c5f7d") : "#4c5f7d", hint:"Fielding Independent Pitching. Only K, BB, HR. Lower = better quality." },
                    { label:"xFIP",   val: fmtF(adv.xfip),   accent: adv.xfip  != null ? (adv.xfip  < 3.5 ? "#0f8a44" : adv.xfip  > 4.5 ? "#d03131" : "#4c5f7d") : "#4c5f7d", hint:"Expected FIP. Regresses HR/FB to league-average rate. Most stable ERA predictor." },
                    { label:"K-BB%",  val: fmtPct(adv.k_bb_pct), accent: adv.k_bb_pct != null ? (adv.k_bb_pct > 15 ? "#0f8a44" : adv.k_bb_pct < 5 ? "#d03131" : "#4c5f7d") : "#4c5f7d", hint:"K% minus BB%. Best single command/stuff measure. 20%+ = elite. 5% = replacement-level." },
                    { label:"CSW%",   val: fmtPct(adv.csw_pct),  accent: adv.csw_pct  != null ? (adv.csw_pct  > 32 ? "#0f8a44" : adv.csw_pct  < 25 ? "#d03131" : "#4c5f7d") : "#4c5f7d", hint:"Called Strike + Whiff %. Best single pitch quality metric. 32%+ = elite stuff. 25% = below avg." },
                    { label:"Stf+",   val: fmtN(adv.stf_plus),   accent: adv.stf_plus != null ? (adv.stf_plus > 115 ? "#0f8a44" : adv.stf_plus < 85 ? "#d03131" : "#4c5f7d") : "#4c5f7d", hint:"FanGraphs Stuff+. 100 = league avg raw stuff. Measures pitch movement, velocity, spin relative to league." },
                    { label:"Loc+",   val: fmtN(adv.loc_plus),   accent: adv.loc_plus != null ? (adv.loc_plus > 115 ? "#0f8a44" : adv.loc_plus < 85 ? "#d03131" : "#4c5f7d") : "#4c5f7d", hint:"FanGraphs Location+. 100 = avg command. Higher = pitches land where they're meant to, generating weak contact and Ks." },
                    { label:"Pit+",   val: fmtN(adv.pit_plus),   accent: adv.pit_plus != null ? (adv.pit_plus > 115 ? "#0f8a44" : adv.pit_plus < 85 ? "#d03131" : "#4c5f7d") : "#4c5f7d", hint:"FanGraphs Pitching+ (Stuff + Location combined). Best overall pitcher quality composite. 100 = avg." },
                    { label:"FB Velo",val: adv.fastball_velo != null ? adv.fastball_velo.toFixed(1) + " mph" : null, accent: adv.fastball_velo != null ? (adv.fastball_velo > 97 ? "#0f8a44" : adv.fastball_velo < 91 ? "#d03131" : "#4c5f7d") : "#4c5f7d", hint:"Average fastball velocity. 97+ mph = elite heat. Below 91 = soft-tosser with command focus." },
                  ].filter(p => p.val != null);
                  if (!pills.length) return null;
                  return (
                    <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                      {pills.map(({ label, val, accent, hint }) => (
                        <div key={label} title={hint} style={{ padding: "2px 8px", borderRadius: 10, background: "rgba(194,87,15,0.06)", border: "1px solid rgba(194,87,15,0.12)", display: "flex", gap: 4, alignItems: "center", cursor: "help" }}>
                          <span style={{ fontSize: 8, color: "#c06020", textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</span>
                          <span style={{ fontSize: 11, fontWeight: 700, color: accent || "#16233c", fontFamily: "'JetBrains Mono',monospace" }}>{val}</span>
                        </div>
                      ))}
                      <span style={{ fontSize: 8, color: "#c9d5e8", alignSelf: "center" }}>FanGraphs · hover for hints</span>
                    </div>
                  );
                })()}
              </div>

              {/* Period + filter controls */}
              <div style={{ padding: "8px 24px 6px", display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                <span style={{ fontSize: 10, color: "#8b99b0", textTransform: "uppercase", letterSpacing: 0.6 }}>Period:</span>
                {["2026","2025","L5","L10","L20"].map(p => (
                  <button key={p} onClick={() => setActivePeriod(p)} style={periodBtnStyle(activePeriod===p)}>{p}</button>
                ))}
                <span style={{ marginLeft: 8, fontSize: 10, color: "#8b99b0", textTransform: "uppercase", letterSpacing: 0.6 }}>Filter:</span>
                {[["home","Home"],["away","Away"],["day","Day"],["night","Night"]].map(([k,l]) => (
                  <button key={k} onClick={() => toggleFilter(k)} style={filterBtnStyle(k)}>{l}</button>
                ))}
              </div>

              {/* K Bar Chart */}
              <div style={{ padding: "6px 24px 12px" }}>
                <div style={{ fontSize: 10, color: "#8b99b0", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 8, display: "flex", alignItems: "center", gap: 8 }}>
                  <span>K Chart · {activePeriod}</span>
                  {sd && <span style={{ color: "#a16207", fontWeight: 700 }}>O{kThresh} line</span>}
                </div>
                {activePeriod === "2025" && loading2025 ? (
                  <div style={{ height: 140, display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <Loader text="Loading 2025 game log..." />
                  </div>
                ) : (
                  <PropBarChart gameLog={filteredGameLog} propKey="ks" threshold={kThresh} />
                )}
              </div>

              {/* K Projection Box */}
              {sd && (
                <div style={{ margin: "0 24px 12px", padding: "14px 16px", background: "rgba(15,138,68,0.04)", borderRadius: 10, border: "1px solid rgba(15,138,68,0.12)" }}>
                  <div style={{ fontSize: 10, color: "#0f8a44", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, marginBottom: 10 }}>K Projection Model</div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
                    <div style={{ background: "rgba(32,98,200,0.128)", borderRadius: 6, padding: "8px 10px", textAlign: "center" }}>
                      <div style={{ fontSize: 9, color: "#2062c8", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 4 }}>xK (Regression)</div>
                      <div style={{ fontSize: 22, fontWeight: 700, color: "#2062c8", fontFamily: "'JetBrains Mono',monospace" }}>{(sd.xK||0).toFixed(1)}</div>
                    </div>
                    <div style={{ background: "rgba(60,80,110,0.06)", borderRadius: 6, padding: "8px 10px", textAlign: "center" }}>
                      <div style={{ fontSize: 9, color: "#4c5f7d", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 4 }}>K-Edge</div>
                      <div style={{ fontSize: 22, fontWeight: 700, color: "#4c5f7d", fontFamily: "'JetBrains Mono',monospace" }}>{(sd.kEdge||0).toFixed(1)}</div>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <MiniStat label="Proj IP" value={(sd.projIP||0).toFixed(1)} />
                    <MiniStat label="SwStr%" value={sd.swStrPct != null ? sd.swStrPct.toFixed(1)+"%" : "—"} accent={sd.swStrPct > 12 ? "#0f8a44" : sd.swStrPct < 9 ? "#d03131" : undefined} />
                    <MiniStat label="Opp K%" value={sd.oppKRatePct != null ? sd.oppKRatePct.toFixed(1)+"%" : "—"} accent={sd.oppKRatePct > 24 ? "#0f8a44" : undefined} />
                    <MiniStat label="Edge" value={(sd.xKEdge>=0?"+":"")+(sd.xKEdge||0).toFixed(1)} accent={sd.xKEdge > 0 ? "#0f8a44" : "#d03131"} />
                    <MiniStat label="±σ L5" value={"±"+(sd.l5Stddev||0).toFixed(1)} />
                    <MiniStat label="Conf" value={(sd.conf||0).toFixed(1)} accent={(sd.conf||0) >= 7.5 ? "#0f8a44" : undefined} />
                    <MiniStat label="M1 Arsenal" value={"×"+(sd.M1||1).toFixed(2)} accent={sd.M1 > 1.05 ? "#0f8a44" : sd.M1 < 0.95 ? "#d03131" : undefined} />
                    <MiniStat label="M3 Opp" value={"×"+(sd.M3||1).toFixed(2)} accent={sd.M3 > 1.05 ? "#0f8a44" : sd.M3 < 0.95 ? "#d03131" : undefined} />
                    {sd.M7 != null && sd.M7 !== 1.0 && (
                      <MiniStat label="M7 Lineup" value={"×"+(sd.M7||1).toFixed(2)} accent={sd.M7 > 1.05 ? "#0f8a44" : sd.M7 < 0.95 ? "#d03131" : undefined} title="Lineup K% vulnerability vs pitcher's pitch mix" />
                    )}
                    {sd.lineupCoverage != null && (
                      <MiniStat label="Lineup" value={Math.round((sd.lineupCoverage||0)*100)+"%"} accent={(sd.lineupCoverage||0) >= 0.55 ? "#0f8a44" : "#4c5f7d"} title="Lineup coverage used for M3/M7" />
                    )}
                  </div>
                </div>
              )}

              {/* Opposing Lineup with career BvP stats */}
              {hasMatchupLineup && opposingBatters.length > 0 && (
                <div style={{ margin: "0 24px 16px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                    <span style={{ fontSize: 10, color: "#8b99b0", textTransform: "uppercase", letterSpacing: 0.8 }}>
                      {opposingTeamKey} Lineup {lineupData[opposingTeamKey]?.confirmed ? "✓" : "·Proj"} vs {pitcher.fullName?.split(" ").pop()}
                    </span>
                    <span style={{ fontSize: 9, color: "#c9d5e8" }}>Career stats</span>
                  </div>
                  <div style={{ background: "rgba(210,217,236,0.4)", borderRadius: 8, border: "1px solid rgba(32,98,200,0.128)", overflow: "hidden" }}>
                    {/* Header row */}
                    <div style={{ display: "grid", gridTemplateColumns: "18px 1fr 28px 28px 30px 38px 26px 26px 28px", padding: "4px 10px", borderBottom: "1px solid rgba(32,98,200,0.16)", gap: 3 }}>
                      {["#","NAME","POS","H","AB","AVG","HR","K",""].map((h, i) => (
                        <span key={i} style={{ fontSize: 8, color: "#c9d5e8", fontWeight: 700, textAlign: h === "NAME" ? "left" : "right" }}>{h}</span>
                      ))}
                    </div>
                    {opposingBatters.slice(0, 9).map((b, i) => {
                      const bName = b.fullName || b.name || String(b);
                      const bHand = b.batSide?.code || b.batSide || b.bats || "";
                      const bPos = b.position?.abbreviation || b.pos || "";
                      const bid = b.id || b.person?.id;
                      const bvpEntry = bid ? lineupBvpCache[bid] : undefined;
                      const cs = (bvpEntry && bvpEntry !== "loading") ? (bvpEntry?.career?.[0]?.stat || bvpEntry?.season?.[0]?.stat || {}) : {};
                      const hasStats = !!cs.atBats;
                      return (
                        <div key={i} style={{ display: "grid", gridTemplateColumns: "18px 1fr 28px 28px 30px 38px 26px 26px 28px", padding: "5px 10px", borderBottom: i < 8 ? "1px solid rgba(32,98,200,0.064)" : "none", gap: 3, alignItems: "center" }}>
                          <span style={{ fontSize: 9, color: "#c9d5e8", textAlign: "right", fontFamily: "'JetBrains Mono',monospace" }}>{b.order || i+1}</span>
                          <span style={{ fontSize: 11, color: "#223350", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{bName}</span>
                          <span style={{ fontSize: 9, color: "#8b99b0", textAlign: "right" }}>{bPos}</span>
                          <span style={{ fontSize: 9, color: "#2062c8", textAlign: "right", fontFamily: "'JetBrains Mono',monospace" }}>{hasStats ? cs.hits : "—"}</span>
                          <span style={{ fontSize: 9, color: "#b6c5dc", textAlign: "right", fontFamily: "'JetBrains Mono',monospace" }}>{bvpEntry === "loading" ? "…" : hasStats ? cs.atBats : "—"}</span>
                          <span style={{ fontSize: 9, textAlign: "right", fontFamily: "'JetBrains Mono',monospace", color: hasStats ? (parseFloat(cs.avg) >= 0.300 ? "#0f8a44" : parseFloat(cs.avg) <= 0.200 ? "#d03131" : "#4c5f7d") : "#c9d5e8", fontWeight: hasStats ? 700 : 400 }}>{hasStats ? cs.avg : "—"}</span>
                          <span style={{ fontSize: 9, color: hasStats && (cs.homeRuns > 0) ? "#c2570f" : "#c9d5e8", textAlign: "right" }}>{hasStats ? cs.homeRuns : "—"}</span>
                          <span style={{ fontSize: 9, color: "#b6c5dc", textAlign: "right" }}>{hasStats ? cs.strikeOuts : "—"}</span>
                          <span style={{ fontSize: 9, textAlign: "right" }}>
                            {bHand && <span style={{ color: "#2062c8", background: "rgba(32,98,200,0.128)", padding: "0 3px", borderRadius: 2 }}>{bHand}</span>}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Season vs Career table */}
              {Object.keys(c).length > 0 && (
                <div style={{ margin: "0 24px 16px" }}>
                  <div style={{ fontSize: 10, color: "#8b99b0", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 8 }}>Season vs Career</div>
                  <div style={{ background: "rgba(210,217,236,0.4)", borderRadius: 8, border: "1px solid rgba(32,98,200,0.128)", overflow: "hidden" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse" }}>
                      <thead><tr style={{ borderBottom: "1px solid rgba(32,98,200,0.16)" }}>
                        <th style={{ textAlign: "left", padding: "5px 10px", fontSize: 10, color: "#74839d", textTransform: "uppercase" }}>Stat</th>
                        <th style={{ textAlign: "center", padding: "5px 10px", fontSize: 10, color: "#2062c8", textTransform: "uppercase" }}>{season}</th>
                        <th style={{ textAlign: "center", padding: "5px 10px", fontSize: 10, color: "#c2570f", textTransform: "uppercase" }}>Career</th>
                      </tr></thead>
                      <tbody>
                        {[["ERA",fmt(s.era,2),fmt(c.era,2)],["WHIP",fmt(s.whip,2),fmt(c.whip,2)],["K/9",fmt(s.strikeoutsPer9Inn,1),fmt(c.strikeoutsPer9Inn,1)],["BB/9",fmt(s.walksPer9Inn,1),fmt(c.walksPer9Inn,1)],["BAA",fmtAvg(s.avg),fmtAvg(c.avg)]].map(([label,sv,cv]) => (
                          <tr key={label} style={{ borderBottom: "1px solid rgba(32,98,200,0.064)" }}>
                            <td style={{ padding: "6px 10px", fontSize: 12, color: "#5d6f8b", fontWeight: 600 }}>{label}</td>
                            <td style={{ padding: "6px 10px", textAlign: "center", fontSize: 13, color: "#16233c", fontFamily: "'JetBrains Mono',monospace", fontWeight: 600 }}>{sv}</td>
                            <td style={{ padding: "6px 10px", textAlign: "center", fontSize: 12, color: "#74839d", fontFamily: "'JetBrains Mono',monospace" }}>{cv}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>

            {/* ── RIGHT COLUMN ── */}
            <div style={{ padding: "20px 20px 60px", overflowY: isMobile ? undefined : "auto", maxHeight: isMobile ? undefined : "100vh", position: isMobile ? undefined : "sticky", top: 0, borderTop: isMobile ? "1px solid rgba(32,98,200,0.16)" : "none" }}>
              {/* Book Odds: K Ladder */}
              <CollapsibleSection title="Book Odds · K Ladder" defaultOpen={true} accent="#a16207">
                {(() => {
                  const BOOKS = ["fanduel","draftkings","hardrockbet"];
                  const nn = _normPropName(pitcher?.fullName || "");
                  const pd = propOddsMap?.[nn] || {};
                  const modelSignal = pitcherScanData?.signal || null;
                  const lineMap = {};
                  for (const [mk, books] of Object.entries(pd)) {
                    if (!mk.includes("strikeout")) continue;
                    const isUnder = mk.endsWith("__under");
                    for (const [line, bkData] of Object.entries(books)) {
                      if (!lineMap[line]) lineMap[line] = { over: {}, under: {} };
                      const side = isUnder ? "under" : "over";
                      for (const bk of BOOKS) {
                        if (bkData[bk]?.price != null && !lineMap[line][side][bk]) {
                          lineMap[line][side][bk] = { price: bkData[bk].price, link: bkData[bk].link, sid: bkData[bk].sid };
                        }
                      }
                    }
                  }
                  const sortedLines = Object.keys(lineMap).map(Number).sort((a,b) => a-b);
                  if (sortedLines.length === 0) return <div style={{ padding: "16px 0", textAlign: "center", color: "#8b99b0", fontSize: 12 }}>No strikeout odds available</div>;

                  const xKForKelly = pitcherScanData?.xK ?? null;
                  const renderSideRow = (line, side, entry, isSignal, isTarget) => {
                    const isOver = side === "over";
                    const allPrices = BOOKS.map(bk => entry[bk]?.price).filter(p => p != null);
                    const bestPrice = allPrices.length > 0 ? Math.max(...allPrices) : null;
                    const hasAny = allPrices.length > 0;
                    const labelColor = isTarget ? "#a16207" : (hasAny ? (isOver ? "#0f8a44" : "#d03131") : "#b6c5dc");
                    const overProb = xKForKelly != null ? modelImpliedProb(xKForKelly, "ks", line) : null;
                    const sideProb = isOver ? overProb : (overProb != null ? 1 - overProb : null);
                    return (
                      <div key={`${line}-${side}`} style={{ display: "grid", gridTemplateColumns: "62px 1fr 1fr 1fr auto", padding: "5px 10px", borderBottom: "1px solid rgba(32,98,200,0.048)", alignItems: "center",
                        background: isSignal ? (isOver ? "rgba(15,138,68,0.04)" : "rgba(208,49,49,0.04)") : isTarget ? "rgba(161,98,7,0.03)" : "transparent" }}
                        onMouseEnter={e => e.currentTarget.style.background = isSignal ? (isOver ? "rgba(15,138,68,0.07)" : "rgba(208,49,49,0.07)") : "rgba(32,98,200,0.064)"}
                        onMouseLeave={e => e.currentTarget.style.background = isSignal ? (isOver ? "rgba(15,138,68,0.04)" : "rgba(208,49,49,0.04)") : isTarget ? "rgba(161,98,7,0.03)" : "transparent"}>
                        <span style={{ fontSize: 11, fontWeight: 700, fontFamily: "'JetBrains Mono',monospace", color: labelColor, display: "flex", alignItems: "center", gap: 3 }}>
                          {isOver ? "O" : "U"}{line}
                          {isSignal && <span style={{ fontSize: 8, fontWeight: 800, padding: "1px 3px", borderRadius: 2, background: isOver ? "rgba(15,138,68,0.2)" : "rgba(208,49,49,0.2)", color: labelColor }}>★</span>}
                        </span>
                        {BOOKS.map(bk => {
                          const e = entry[bk];
                          let url = null;
                          if (e && bk === "hardrockbet" && e.sid) url = `https://share.hardrock.bet/Pt0T/bet?deep_link_value=hardrock://betslip/${e.sid}`;
                          else if (e) url = e.link;
                          const isBest = e?.price != null && e.price === bestPrice;
                          return <span key={bk} style={{ textAlign: "right" }}><OddsLink price={e?.price ?? null} url={url} isBest={isBest} bk={bk} style={{ fontSize: 11 }} /></span>;
                        })}
                        <span style={{ paddingLeft: 8, textAlign: "right" }}>
                          <KellyBadge modelProb={sideProb} americanOdds={bestPrice} />
                        </span>
                      </div>
                    );
                  };

                  return (
                    <div style={{ background: "rgba(210,217,236,0.5)", borderRadius: 8, border: "1px solid rgba(32,98,200,0.128)", overflow: "hidden" }}>
                      <div style={{ display: "grid", gridTemplateColumns: "62px 1fr 1fr 1fr auto", padding: "5px 10px", borderBottom: "1px solid rgba(32,98,200,0.128)" }}>
                        <span style={{ fontSize: 9, color: "#8b99b0", fontWeight: 700 }}>LINE</span>
                        {BOOKS.map(bk => <span key={bk} style={{ fontSize: 9, fontWeight: 700, color: BOOK_COLORS[bk], textAlign: "right" }}>{BOOK_ABBR[bk]}</span>)}
                        <span style={{ fontSize: 9, color: "#8b99b0", fontWeight: 700, textAlign: "right", paddingLeft: 8 }}>SIZE</span>
                      </div>
                      {sortedLines.map(line => {
                        const { over, under } = lineMap[line];
                        const isTarget = sd?.line != null && Math.abs(line - sd.line) < 0.01;
                        return (
                          <div key={line} style={{ borderBottom: "1px solid rgba(32,98,200,0.096)" }}>
                            {renderSideRow(line, "over",  over,  modelSignal === "over",  isTarget)}
                            {renderSideRow(line, "under", under, modelSignal === "under", isTarget)}
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}
              </CollapsibleSection>

              {/* Pitcher Splits */}
              <CollapsibleSection title={`Pitcher Splits · ${splitsYear}`} defaultOpen={true} accent="#2569d6">
                {(() => {
                  const yrBtn = (yr) => ({
                    fontSize: 9, padding: "2px 7px", borderRadius: 3, cursor: "pointer", fontWeight: 700,
                    background: splitsYear === yr ? "rgba(37,105,214,0.15)" : "transparent",
                    color: splitsYear === yr ? "#2569d6" : "#b6c5dc",
                    border: splitsYear === yr ? "1px solid rgba(37,105,214,0.3)" : "1px solid transparent",
                  });
                  return (
                    <div>
                      <div style={{ display: "flex", gap: 3, marginBottom: 10, justifyContent: "flex-end" }}>
                        {[2025, 2026].map(yr => <button key={yr} onClick={() => setSplitsYear(yr)} style={yrBtn(yr)}>{yr}</button>)}
                      </div>
                      {loading ? <Loader text="Loading splits..." /> : splitsCache[splitsYear]
                        ? <SplitsTable splits={splitsCache[splitsYear]} isPitching />
                        : <div style={{ padding: "10px 0", fontSize: 12, color: "#8b99b0", textAlign: "center" }}>
                            {splitsYear === 2025 ? "Loading 2025 splits…" : "No split data"}
                          </div>}
                    </div>
                  );
                })()}
              </CollapsibleSection>

              {/* Pitch Arsenal */}
              <CollapsibleSection title={`Pitch Arsenal · ${arsenalYear}`} defaultOpen={false} accent="#b45309">
                {(() => {
                  const yrBtn = (yr) => ({
                    fontSize: 9, padding: "2px 7px", borderRadius: 3, cursor: "pointer", fontWeight: 700,
                    background: arsenalYear === yr ? "rgba(180,83,9,0.15)" : "transparent",
                    color: arsenalYear === yr ? "#b45309" : "#b6c5dc",
                    border: arsenalYear === yr ? "1px solid rgba(180,83,9,0.3)" : "1px solid transparent",
                  });
                  return (
                    <div>
                      <div style={{ display: "flex", gap: 3, marginBottom: 10, justifyContent: "flex-end" }}>
                        {[2025, 2026].map(yr => <button key={yr} onClick={() => setArsenalYear(yr)} style={yrBtn(yr)}>{yr}</button>)}
                      </div>
                      {arsenalLoading && arsenalCache[arsenalYear] === undefined
                        ? <Loader text="Loading arsenal..." />
                        : arsenalCache[arsenalYear]?.length > 0
                        ? (() => {
                    const arsenal = arsenalCache[arsenalYear];
                    const scMap = statcastCache[arsenalYear] || {};
                    const sorted = [...arsenal].sort((a,b) => (parseFloat(b.stat?.percentage)||0)-(parseFloat(a.stat?.percentage)||0));
                    return (
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        {sorted.map((split, i) => {
                          const code = split.stat?.type?.code || split.split?.pitchType?.code || "XX";
                          const name = split.stat?.type?.description || PITCH_LABELS[code] || code;
                          const usage = (parseFloat(split.stat?.percentage)||0)*100;
                          const vel = parseFloat(split.stat?.averageSpeed) || 0;
                          const color = PITCH_COLORS[code] || "#2062c8";
                          const sc = scMap[code];
                          const rvColor = sc?.rv100 != null ? (sc.rv100 <= 0 ? "#0f8a44" : "#d03131") : "#4c5f7d";
                          return (
                            <div key={i} style={{ background: "rgba(210,217,236,0.5)", borderRadius: 8, padding: "10px 12px", border: `1px solid ${color}22` }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                                <span style={{ fontSize: 10, fontWeight: 700, color, background: `${color}18`, padding: "1px 6px", borderRadius: 3 }}>{code}</span>
                                <span style={{ fontSize: 12, fontWeight: 600, color: "#223350", flex: 1 }}>{name}</span>
                                <span style={{ fontSize: 12, fontWeight: 700, color, fontFamily: "'JetBrains Mono',monospace" }}>{usage.toFixed(1)}%</span>
                              </div>
                              <div style={{ height: 4, borderRadius: 2, background: "rgba(22,44,80,0.05)", marginBottom: 8 }}>
                                <div style={{ height: "100%", width: `${Math.min(usage,100)}%`, background: color, borderRadius: 2 }} />
                              </div>
                              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                                <div style={{ fontSize: 10, color: "#4c5f7d" }}>{vel > 0 ? vel.toFixed(1)+" mph" : "—"}</div>
                                {sc && <>
                                  <div style={{ fontSize: 10, color: sc.whiff > 28 ? "#0f8a44" : sc.whiff < 18 ? "#d03131" : "#6d4fd0" }}>Whiff {sc.whiff.toFixed(1)}%</div>
                                  <div style={{ fontSize: 10, color: sc.putAway > 20 ? "#0f8a44" : sc.putAway < 12 ? "#d03131" : "#5d6f8b" }}>PutAway {sc.putAway != null ? sc.putAway.toFixed(1)+"%" : "—"}</div>
                                  <div style={{ fontSize: 10, color: sc.kPct > 27 ? "#0f8a44" : sc.kPct < 18 ? "#d03131" : "#5d6f8b" }}>K% {sc.kPct != null ? sc.kPct.toFixed(1)+"%" : "—"}</div>
                                  <div style={{ fontSize: 10, color: rvColor }}>RV/100 {sc.rv100 != null ? (sc.rv100>0?"+":"")+sc.rv100.toFixed(1) : "—"}</div>
                                </>}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    );
                        })()
                        : <div style={{ padding: "12px 0", textAlign: "center", color: "#8b99b0", fontSize: 12 }}>No arsenal data available</div>
                      }
                    </div>
                  );
                })()}
              </CollapsibleSection>

              {/* Plate Discipline */}
              {disciplineCache[arsenalYear] && (
                <CollapsibleSection title="Plate Discipline" defaultOpen={false} accent="#2569d6">
                  {(() => {
                    const d = disciplineCache[arsenalYear];
                    const fp = v => v != null ? v.toFixed(1)+"%" : "—";
                    return (
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
                        {[
                          { label: "F-Strike%", val: fp(d.fStrike), color: d.fStrike > 65 ? "#0f8a44" : d.fStrike < 55 ? "#d03131" : "#4c5f7d" },
                          { label: "Chase%", val: fp(d.ozSwing), color: d.ozSwing > 32 ? "#0f8a44" : d.ozSwing < 22 ? "#d03131" : "#4c5f7d" },
                          { label: "Whiff%", val: fp(d.whiff), color: d.whiff > 28 ? "#0f8a44" : d.whiff < 18 ? "#d03131" : "#4c5f7d" },
                          { label: "Edge%", val: fp(d.edge), color: d.edge > 45 ? "#0f8a44" : d.edge < 35 ? "#d03131" : "#4c5f7d" },
                          { label: "Zone Sw%", val: fp(d.zSwing), color: "#4c5f7d" },
                          { label: "Zone Con%", val: fp(d.izContact), color: d.izContact > 88 ? "#d03131" : d.izContact < 78 ? "#0f8a44" : "#4c5f7d" },
                        ].map(({ label, val, color }) => (
                          <div key={label} style={{ background: "rgba(210,217,236,0.5)", borderRadius: 6, padding: "8px 10px", textAlign: "center", border: "1px solid rgba(37,105,214,0.08)" }}>
                            <div style={{ fontSize: 9, color: "#74839d", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 3, lineHeight: 1.3 }}>{label}</div>
                            <div style={{ fontSize: 16, fontWeight: 700, color, fontFamily: "'JetBrains Mono',monospace" }}>{val}</div>
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                </CollapsibleSection>
              )}

              {/* News */}
              <CollapsibleSection title="News" defaultOpen={false} accent="#2062c8">
                {newsLoading
                  ? <Loader text="Loading news..." />
                  : news?.length > 0
                  ? <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                    {news.slice(0,6).map((a, i) => (
                      <a key={i} href={a.link || "#"} target="_blank" rel="noopener noreferrer"
                        style={{ display: "block", textDecoration: "none", padding: "8px 10px", borderRadius: 6,
                          background: a.isRotowire ? "rgba(161,98,7,0.06)" : "rgba(210,217,236,0.4)",
                          border: `1px solid ${a.isRotowire ? "rgba(161,98,7,0.2)" : "rgba(32,98,200,0.128)"}`,
                        }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: "#223350", lineHeight: 1.35, marginBottom: 3 }}>{a.title}</div>
                        <div style={{ fontSize: 10, color: a.isRotowire ? "#a16207" : "#2062c8" }}>{a.source}{a.pubDate && ` · ${_timeAgo(a.pubDate)}`}</div>
                      </a>
                    ))}
                  </div>
                  : <div style={{ padding: "12px 0", textAlign: "center", color: "#8b99b0", fontSize: 12 }}>No recent news</div>
                }
              </CollapsibleSection>
            </div>
          </div>
        )}
      </div>
    );
  }
  // ── END FULL-PAGE MODE ───────────────────────────────────────────────

  return (
    <div style={{
      position: "fixed", top: 0, right: 0, width: "min(680px, 100vw)", height: "100dvh",
      background: "linear-gradient(135deg, #ffffff 0%, #edf2fa 100%)", zIndex: 1000,
      borderLeft: "1px solid rgba(32,98,200,0.2)", overflowY: "auto",
      WebkitOverflowScrolling: "touch", overscrollBehavior: "contain",
      boxShadow: "-20px 0 60px rgba(0,0,0,0.175)", animation: "slideIn 0.25s ease-out",
    }}>
      {/* Header */}
      <div style={{ padding: "16px 20px", borderBottom: "1px solid rgba(32,98,200,0.192)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
          <PlayerHeadshot personId={pitcher?.id} size={72} alt={pitcher?.fullName || ""} />
          <div>
            <div style={{ fontSize: 11, color: "#c2570f", textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 4 }}>Pitcher Profile</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: "#16233c", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              {pitcher.fullName}
              <InjuryBadge inj={injury} size={18} />
            </div>
            <div style={{ fontSize: 12, color: "#6d7c96", marginTop: 2 }}>
              {hand}HP · {pitcherTeam || ""}
              {ppr?.type === "SP" ? " · Starting Pitcher" : ppr?.type === "RP" ? " · Relief Pitcher" : ""}
            </div>
            <ContractLine playerId={pitcher?.id} />
            <InjuryLine inj={injury} />
            {seasonData?.season && Object.keys(seasonData.season).length > 0 ? (
              <div style={{ fontSize: 10, color: "#0f8a44", marginTop: 4, display: "flex", alignItems: "center", gap: 4, fontFamily: "'JetBrains Mono',monospace" }}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#0f8a44", display: "inline-block", flexShrink: 0 }} />
                {parseInt(seasonData.season.wins) || 0}-{parseInt(seasonData.season.losses) || 0}
                {" · "}{parseInt(seasonData.season.strikeOuts) || 0}K
                {" · "}{parseFloat(seasonData.season.inningsPitched) > 0 ? parseFloat(seasonData.season.inningsPitched).toFixed(1) + "IP" : "0.0IP"}
                {(parseInt(seasonData.season.gamesStarted) || 0) > 0 && <span style={{ marginLeft: 4 }}>{seasonData.season.gamesStarted}GS</span>}
                {seasonData.season.era && <span style={{ marginLeft: 4, color: "#3b74cf" }}>{seasonData.season.era} ERA</span>}
              </div>
            ) : !loading ? (
              <div style={{ fontSize: 10, color: "#8b99b0", marginTop: 4 }}>No 2026 stats yet</div>
            ) : null}
            {bio?.birthDate && (() => {
              const bday = new Date(bio.birthDate + "T12:00:00");
              const age = Math.floor((Date.now() - bday) / (365.25 * 24 * 3600 * 1000));
              const bdayStr = bday.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
              const birthPlace = [bio.birthCity, bio.birthState].filter(Boolean).join(", ");
              return (
                <div style={{ fontSize: 10, color: "#8b99b0", marginTop: 5 }}>
                  🎂 {bdayStr} · Age {age}{birthPlace && ` · Born: ${birthPlace}`}
                </div>
              );
            })()}
          </div>
          </div>
          <button onClick={onClose} style={{
            background: "rgba(22,44,80,0.05)", border: "1px solid rgba(22,44,80,0.1)",
            color: "#5d6f8b", borderRadius: 8, width: 36, height: 36, cursor: "pointer",
            fontSize: 18, display: "flex", alignItems: "center", justifyContent: "center",
          }}>✕</button>
        </div>
      </div>

      {/* vs Opponent strip — opposing team offense w/ ranks (1 = best, 30 = worst) */}
      {oppOffense?.stats && <OppOffenseStrip data={oppOffense} venueName={venueName || pitcherScanData?.venue} />}

      {/* Tabs — split into two rows: row 1 = primary stats, row 2 = Statcast, Arsenal, News */}
      <div style={{ padding: "12px 20px 12px", borderBottom: "1px solid rgba(32,98,200,0.128)" }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button onClick={() => setTab("statsplits")} style={tabStyle(tab==="statsplits")}>Stats & Splits</button>
          <button onClick={() => setTab("bookodds")} style={tabStyle(tab==="bookodds")}>📖 Book Odds</button>
          <button onClick={() => setTab("log")} style={tabStyle(tab==="log")}>Game Log</button>
          <button onClick={() => setTab("vl")} style={tabStyle(tab==="vl")}>📋 Batter History</button>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
          <button onClick={() => setTab("statcast")} style={tabStyle(tab==="statcast")}>📊 Statcast</button>
          <button onClick={() => setTab("arsenal")} style={tabStyle(tab==="arsenal")}>Pitch Arsenal</button>
          <button onClick={() => setTab("news")} style={{ ...tabStyle(tab==="news"), position: "relative" }}>
            News{newsLoading ? <span style={{ position: "absolute", top: 2, right: 2, width: 5, height: 5, borderRadius: "50%", background: "#2062c8", animation: "pulse 1s infinite" }} /> : news?.length > 0 ? <span style={{ position: "absolute", top: 2, right: 2, width: 5, height: 5, borderRadius: "50%", background: "#0f8a44" }} /> : null}
          </button>
        </div>
      </div>

      {loading ? <div style={{ padding: 24 }}><Loader text="Loading pitcher data..." /></div> : (
        <div style={{ padding: "12px 20px 40px" }}>

          {/* ── STATS & SPLITS TAB ── */}
          {tab === "statsplits" && (() => {
            const gp = parseInt(s.gamesStarted || s.gamesPitched) || 0;
            const careerGS = parseInt(c.gamesStarted) || 0;
            return (
              <><div>
                {/* Right/Left splits lead the tab — the most-read table on this panel */}
                <Section title="Right / Left Splits" accent="#2062c8">
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 11, color: "#5d6f8b" }}>Season:</span>
                    {[2024, 2025, 2026].map(yr => (
                      <button key={yr} onClick={() => setSplitsYear(yr)} style={{
                        padding: "3px 10px", fontSize: 11, borderRadius: 4, cursor: "pointer",
                        border: splitsYear === yr ? "1px solid #2062c8" : "1px solid #c6cdd9",
                        background: splitsYear === yr ? "#d7e6fa" : "#e8edf6",
                        color: splitsYear === yr ? "#2062c8" : "#5d6f8b",
                        fontWeight: splitsYear === yr ? 700 : 400,
                      }}>{yr}</button>
                    ))}
                  </div>
                  {splitsCache[splitsYear]
                    ? <SplitsTable splits={splitsCache[splitsYear]} isPitching only="handedness" />
                    : <Loader text={`Loading ${splitsYear} splits…`} />
                  }
                </Section>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginBottom: 16 }}>
                  {[
                    ["ERA", fmt(s.era, 2), Number(s.era)<3 ? "#0f8a44" : Number(s.era)>5 ? "#d03131" : undefined],
                    ["W-L", `${s.wins??0}-${s.losses??0}`, undefined],
                    ["IP", s.inningsPitched || "—", undefined],
                    ["K", s.strikeOuts ?? "—", undefined],
                    ["BB", s.baseOnBalls ?? "—", undefined],
                    ["WHIP", fmt(s.whip, 2), Number(s.whip)<1.1 ? "#0f8a44" : Number(s.whip)>1.5 ? "#d03131" : undefined],
                    ["BAA", fmtAvg(s.avg), undefined],
                    ["K/9", fmt(s.strikeoutsPer9Inn, 1), undefined],
                    ["BB/9", fmt(s.walksPer9Inn, 1), undefined],
                  ].map(([label, val, accent]) => (
                    <div key={label} style={{ background: "rgba(210,217,236,0.5)", borderRadius: 8, padding: "10px 12px", textAlign: "center", border: "1px solid rgba(32,98,200,0.128)" }}>
                      <div style={{ fontSize: 10, color: "#74839d", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 4 }}>{label}</div>
                      <div style={{ fontSize: 16, fontWeight: 700, color: accent || "#16233c", fontFamily: "'JetBrains Mono', monospace" }}>{val}</div>
                    </div>
                  ))}
                </div>

                {/* ── FANGRAPHS ADVANCED METRICS (from DB) ── */}
                {pitcherScanData?.advancedStats && (() => {
                  const adv = pitcherScanData.advancedStats;
                  const fmtPct = (v) => v != null ? v.toFixed(1) + "%" : "—";
                  const fmtF = (v, d = 2) => v != null ? v.toFixed(d) : "—";
                  const fmtN = (v) => v != null ? Math.round(v) : "—";
                  const hasSomeData = [adv.siera, adv.fip, adv.xfip, adv.k_bb_pct, adv.csw_pct, adv.stf_plus].some(v => v != null);
                  if (!hasSomeData) return null;
                  return (
                    <div style={{ marginBottom: 16, padding: "12px 14px", background: "rgba(194,87,15,0.04)", borderRadius: 10, border: "1px solid rgba(194,87,15,0.14)" }}>
                      <div style={{ fontSize: 9, fontWeight: 700, color: "#c2570f", textTransform: "uppercase", letterSpacing: 1, marginBottom: 10 }}>📐 FanGraphs Advanced</div>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
                        {[
                          { label: "SIERA", val: fmtF(adv.siera), accent: adv.siera != null ? (adv.siera < 3.5 ? "#0f8a44" : adv.siera > 4.5 ? "#d03131" : "#16233c") : "#16233c", hint: "Best ERA estimator. Lower = better." },
                          { label: "FIP",   val: fmtF(adv.fip),   accent: adv.fip   != null ? (adv.fip   < 3.5 ? "#0f8a44" : adv.fip   > 4.5 ? "#d03131" : "#16233c") : "#16233c", hint: "Fielding Independent Pitching." },
                          { label: "xFIP",  val: fmtF(adv.xfip),  accent: adv.xfip  != null ? (adv.xfip  < 3.5 ? "#0f8a44" : adv.xfip  > 4.5 ? "#d03131" : "#16233c") : "#16233c", hint: "Most stable ERA predictor. Regresses HR/FB." },
                          { label: "K-BB%", val: fmtPct(adv.k_bb_pct), accent: adv.k_bb_pct != null ? (adv.k_bb_pct > 15 ? "#0f8a44" : adv.k_bb_pct < 5 ? "#d03131" : "#16233c") : "#16233c", hint: "K% - BB%. Best command/stuff combo. 20%+ = elite." },
                          { label: "CSW%",  val: fmtPct(adv.csw_pct),  accent: adv.csw_pct  != null ? (adv.csw_pct  > 32 ? "#0f8a44" : adv.csw_pct  < 25 ? "#d03131" : "#16233c") : "#16233c", hint: "Called Strike + Whiff%. 32%+ = elite pitch quality." },
                          { label: "Stf+",  val: fmtN(adv.stf_plus),   accent: adv.stf_plus != null ? (adv.stf_plus > 115 ? "#0f8a44" : adv.stf_plus < 85 ? "#d03131" : "#16233c") : "#16233c", hint: "Stuff+ (100 = avg). Raw pitch quality (velo, movement, spin)." },
                          { label: "Loc+",  val: fmtN(adv.loc_plus),   accent: adv.loc_plus != null ? (adv.loc_plus > 115 ? "#0f8a44" : adv.loc_plus < 85 ? "#d03131" : "#16233c") : "#16233c", hint: "Location+ (100 = avg). Command quality." },
                          { label: "Pit+",  val: fmtN(adv.pit_plus),   accent: adv.pit_plus != null ? (adv.pit_plus > 115 ? "#0f8a44" : adv.pit_plus < 85 ? "#d03131" : "#16233c") : "#16233c", hint: "Pitching+ composite (Stuff + Location). 100 = avg." },
                          { label: "FB Velo",val: adv.fastball_velo != null ? adv.fastball_velo.toFixed(1) : "—", accent: adv.fastball_velo != null ? (adv.fastball_velo > 97 ? "#0f8a44" : adv.fastball_velo < 91 ? "#d03131" : "#16233c") : "#16233c", hint: "Average fastball velocity." },
                        ].map(({ label, val, accent, hint }) => (
                          <div key={label} title={hint} style={{ background: "rgba(210,217,236,0.6)", borderRadius: 6, padding: "7px 8px", textAlign: "center", cursor: "help" }}>
                            <div style={{ fontSize: 8, color: "#c06020", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 3 }}>{label}</div>
                            <div style={{ fontSize: 14, fontWeight: 700, color: accent, fontFamily: "'JetBrains Mono', monospace" }}>{val}</div>
                          </div>
                        ))}
                      </div>
                      {/* Percentile ranks */}
                      {(adv.k_pct_rank != null || adv.bb_pct_rank != null || adv.whiff_rank != null || adv.fastball_velo_rank != null) && (
                        <div style={{ marginTop: 10, display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                          <span style={{ fontSize: 8, color: "#8b99b0" }}>Savant %ile:</span>
                          {[
                            { label: "K%", rank: adv.k_pct_rank },
                            { label: "BB%", rank: adv.bb_pct_rank },
                            { label: "Whiff", rank: adv.whiff_rank },
                            { label: "FB Velo", rank: adv.fastball_velo_rank },
                          ].filter(x => x.rank != null).map(({ label, rank }) => {
                            const rankColor = rank >= 80 ? "#0f8a44" : rank >= 60 ? "#65a30d" : rank >= 40 ? "#a16207" : rank >= 20 ? "#c2570f" : "#d03131";
                            return (
                              <div key={label} style={{ display: "flex", alignItems: "center", gap: 4, padding: "3px 7px", background: "rgba(213,221,237,0.7)", borderRadius: 5, border: `1px solid ${rankColor}30` }}>
                                <span style={{ fontSize: 9, color: "#74839d" }}>{label}</span>
                                <span style={{ fontSize: 11, fontWeight: 800, color: rankColor, fontFamily: "'JetBrains Mono', monospace" }}>{rank}</span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                      <div style={{ fontSize: 7, color: "#c9d5e8", marginTop: 6 }}>Source: FanGraphs + Baseball Savant · hover for metric explanations</div>
                    </div>
                  );
                })()}

              </div>
              <Section title={`Home / Away · Day / Night · ${splitsYear}`} accent="#2062c8">
                {splitsCache[splitsYear]
                  ? <SplitsTable splits={splitsCache[splitsYear]} isPitching only="breakdown" />
                  : <Loader text={`Loading ${splitsYear} splits…`} />
                }
              </Section>

              <div style={{ fontSize:9, color:"#b6c5dc", marginTop:8 }}>
                Full Statcast breakdown → 📊 Statcast tab
              </div>
            </>
            );
          })()}

          {/* ── GAME LOG TAB ── */}
          {tab === "log" && (
            <Section title="Recent Starts" accent="#0f8a44">
              <GameLogTable logs={seasonData?.gameLog || []} isPitching />
            </Section>
          )}

          {/* ── PITCHER STATCAST TAB ── */}
          {tab === "statcast" && (() => {
            const isLoadingPct = pitcherPercentiles === null;
            const hasPct = pitcherPercentiles && Object.keys(pitcherPercentiles).length > 0;
            return (
              <div>
                <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:16 }}>
                  <span style={{ fontSize:22 }}>📊</span>
                  <div>
                    <div style={{ fontSize:14, fontWeight:700, color:"#16233c" }}>Statcast Rankings</div>
                    <div style={{ fontSize:11, color:"#74839d", marginTop:1 }}>
                      Percentile vs all MLB pitchers · Baseball Savant
                    </div>
                  </div>
                </div>
                {(pitcherPercentiles === undefined || isLoadingPct) ? (
                  <div style={{ padding:32, textAlign:"center" }}>
                    <Loader text="Loading Statcast data…" />
                  </div>
                ) : !hasPct ? (
                  <div style={{ padding:24, textAlign:"center", color:"#b6c5dc", fontSize:12 }}>
                    <div style={{ fontSize:32, marginBottom:8 }}>📊</div>
                    <div>No Statcast percentile data found for this pitcher.</div>
                    <div style={{ fontSize:10, color:"#c9d5e8", marginTop:4 }}>
                      Requires 2+ IP to appear in Savant leaderboard. Showing {parseInt(season)-1} data if early season.
                    </div>
                  </div>
                ) : (
                  <div style={{ maxWidth:460 }}>
                    <PitcherStatcastCard percentiles={pitcherPercentiles} rawStats={pitcherStatcast} playerName={pitcher.fullName} hintsEnabled={true} />
                  </div>
                )}

                {/* ── Plate Discipline ── */}
                {disciplineCache[arsenalYear] && (() => {
                  const d = disciplineCache[arsenalYear];
                  const fp = v => v != null ? v.toFixed(1) + "%" : "—";
                  const items = [
                    { label: "F-Strike%",       val: fp(d.fStrike),       lgAvg:"61%",  color: d.fStrike > 65 ? "#0f8a44" : d.fStrike < 55 ? "#d03131" : "#4c5f7d" },
                    { label: "Chase% Induced",  val: fp(d.ozSwing),       lgAvg:"28%",  color: d.ozSwing > 32 ? "#0f8a44" : d.ozSwing < 22 ? "#d03131" : "#4c5f7d" },
                    { label: "Whiff%",          val: fp(d.whiff),         lgAvg:"24%",  color: d.whiff > 28 ? "#0f8a44" : d.whiff < 18 ? "#d03131" : "#4c5f7d" },
                    { label: "Edge%",           val: fp(d.edge),          lgAvg:"40%",  color: d.edge > 45 ? "#0f8a44" : d.edge < 35 ? "#d03131" : "#4c5f7d" },
                    { label: "Meatball%",       val: fp(d.meatball),      lgAvg:"8%",   color: d.meatball > 10 ? "#d03131" : d.meatball < 6 ? "#0f8a44" : "#4c5f7d" },
                    { label: "Meatball Swing%", val: fp(d.meatballSwing), lgAvg:"72%",  color: d.meatballSwing > 80 ? "#d03131" : d.meatballSwing < 65 ? "#0f8a44" : "#4c5f7d" },
                    { label: "Zone Swing%",     val: fp(d.zSwing),        lgAvg:"65%",  color: "#4c5f7d" },
                    { label: "Zone Contact%",   val: fp(d.izContact),     lgAvg:"84%",  color: d.izContact > 88 ? "#d03131" : d.izContact < 78 ? "#0f8a44" : "#4c5f7d" },
                    { label: "Chase Contact%",  val: fp(d.ozContact),     lgAvg:"58%",  color: d.ozContact > 65 ? "#d03131" : d.ozContact < 50 ? "#0f8a44" : "#4c5f7d" },
                  ];
                  return (
                    <div style={{ marginBottom:16, padding:"14px 16px", background:"rgba(210,217,236,0.6)", borderRadius:10, border:"1px solid rgba(37,105,214,0.12)" }}>
                      <div style={{ fontSize:10, fontWeight:700, color:"#2569d6", textTransform:"uppercase", letterSpacing:1, marginBottom:12 }}>
                        Plate Discipline · {arsenalYear}
                      </div>
                      <div>
                        {items.map(({ label, val, lgAvg, color }, i) => (
                          <div key={label} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"5px 0", borderBottom: i < items.length - 1 ? "1px solid rgba(32,98,200,0.096)" : "none" }}>
                            <span style={{ fontSize:11, color:"#5d6f8b" }}>{label}</span>
                            <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                              <span style={{ fontSize:9, color:"#8b99b0" }}>lg: {lgAvg}</span>
                              <span style={{ fontSize:12, fontWeight:700, color, minWidth:54, textAlign:"right", fontFamily:"'JetBrains Mono',monospace" }}>{val}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                      <div style={{ marginTop:8, fontSize:8, color:"#c9d5e8" }}>
                        F-Strike% first pitch strikes · Edge% zone border · Meatball% heart of zone · Chase% out-of-zone swing rate induced · via Baseball Savant
                      </div>
                    </div>
                  );
                })()}

                {/* ── Arm Angle / Release ── */}
                {pitcherArmAngles && pitcherArmAngles.nPitches > 0 && (() => {
                  const aa = pitcherArmAngles;
                  const hand = aa.pitchHand || "R";
                  const angleColor = a => a == null ? "#5d6f8b" : a < -30 ? "#c2570f" : a < 0 ? "#a16207" : a < 30 ? "#2062c8" : "#0f8a44";
                  return (
                    <div style={{ marginBottom:16, padding:"14px 16px", background:"rgba(210,217,236,0.6)", borderRadius:10, border:"1px solid rgba(147,51,234,0.12)" }}>
                      <div style={{ fontSize:10, fontWeight:700, color:"#9333ea", textTransform:"uppercase", letterSpacing:1, marginBottom:12, display:"flex", alignItems:"center", gap:6 }}>
                        <span>💪</span> Arm Angle · Release Profile
                        <span style={{ fontSize:9, color:"#b6c5dc", fontWeight:400, textTransform:"none", marginLeft:4 }}>
                          {aa.nPitches?.toLocaleString()} pitches · {hand === "L" ? "LHP" : "RHP"}
                        </span>
                      </div>
                      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"6px 20px" }}>
                        {[
                          { label:"Ball Angle",  val: aa.ballAngle  != null ? aa.ballAngle.toFixed(1)+"°"  : "—", color: angleColor(aa.ballAngle),  hint:"Ball release angle. Negative = low arm slot (submarine/sidearm). Positive = high 3/4 or over-the-top." },
                          { label:"Release X",   val: aa.releaseX   != null ? aa.releaseX.toFixed(2)+"ft"  : "—", color: "#4c5f7d", hint:"Horizontal release point." },
                          { label:"Release Z",   val: aa.releaseZ   != null ? aa.releaseZ.toFixed(2)+"ft"  : "—", color: "#4c5f7d", hint:"Vertical release height (feet off ground)." },
                          { label:"Shoulder Z",  val: aa.shoulderZ  != null ? aa.shoulderZ.toFixed(2)+"ft" : "—", color: "#4c5f7d", hint:"Shoulder height at release." },
                        ].map(({ label, val, color, hint }) => (
                          <div key={label} title={hint} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"4px 0", borderBottom:"1px solid rgba(32,98,200,0.096)" }}>
                            <span style={{ fontSize:11, color:"#5d6f8b" }}>{label}</span>
                            <span style={{ fontSize:12, fontWeight:700, color, fontFamily:"'JetBrains Mono',monospace" }}>{val}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}

                {/* ── Running Game Allowed ── */}
                {pitcherRunningGame && (() => {
                  const rg = pitcherRunningGame;
                  const totalSBA = (rg.nSb || 0) + (rg.nCs || 0);
                  const sbPct = totalSBA > 0 ? rg.nSb / totalSBA : null;
                  return (
                    <div style={{ padding:"14px 16px", background:"rgba(210,217,236,0.6)", borderRadius:10, border:"1px solid rgba(194,87,15,0.12)" }}>
                      <div style={{ fontSize:10, fontWeight:700, color:"#c2570f", textTransform:"uppercase", letterSpacing:1, marginBottom:12, display:"flex", alignItems:"center", gap:6 }}>
                        <span>🏃</span> Running Game Allowed
                        <span style={{ fontSize:9, color:"#b6c5dc", fontWeight:400, textTransform:"none", marginLeft:4 }}>
                          {totalSBA} SBA · pitcher's ability to hold runners
                        </span>
                      </div>
                      <div style={{ display:"flex", gap:12, flexWrap:"wrap" }}>
                        {[
                          { label:"SB Allow", val: rg.nSb || 0,   color:"#d03131" },
                          { label:"CS",       val: rg.nCs || 0,   color:"#0f8a44" },
                          ...(rg.nPk > 0 ? [{ label:"PK", val: rg.nPk, color:"#a16207" }] : []),
                          ...(sbPct != null ? [{ label:"SB%", val: (sbPct*100).toFixed(0)+"%", color: sbPct > 0.80 ? "#d03131" : sbPct > 0.65 ? "#a16207" : "#0f8a44" }] : []),
                          ...(rg.runsPrevented != null ? [{ label:"Runs Prev", val: (rg.runsPrevented > 0 ? "+" : "") + rg.runsPrevented.toFixed(1), color: rg.runsPrevented > 0 ? "#0f8a44" : "#d03131" }] : []),
                        ].map(({ label, val, color }) => (
                          <div key={label} style={{ textAlign:"center", padding:"6px 14px", background:"rgba(32,98,200,0.096)", borderRadius:6 }}>
                            <div style={{ fontSize:9, color:"#8b99b0", textTransform:"uppercase", letterSpacing:0.6, marginBottom:3 }}>{label}</div>
                            <div style={{ fontSize:18, fontWeight:800, color, fontFamily:"'JetBrains Mono',monospace" }}>{val}</div>
                          </div>
                        ))}
                      </div>
                      <div style={{ fontSize:8, color:"#c9d5e8", marginTop:6 }}>Runs prevented on running attempts · Used in SB prop model · Source: Baseball Savant</div>
                    </div>
                  );
                })()}
              </div>
            );
          })()}

          {/* ── ZONES TAB (pitcher, no longer linked) ── */}
          {tab === "zones_disabled" && (() => {
            const locsLoaded = pitcherPitchLocs !== null && pitcherPitchLocs !== "loading";
            const pitchLocs = locsLoaded ? pitcherPitchLocs : null;
            const allPT = pitchLocs ? Object.keys(pitchLocs) : [];
            const activePT = pZoneActivePitches ?? new Set(allPT);
            const pitcherArsenal = pitchLocs
              ? Object.fromEntries(Object.entries(pitchLocs).map(([pt, v]) => [pt, { usage: (v.n / Math.max(Object.values(pitchLocs).reduce((s,x) => s+x.n,0),1))*100 }]))
              : {};

            // Selected batter hot zones for overlay
            const rawBHz = pZoneSelectedBatter ? pZoneBatterHotZones[pZoneSelectedBatter] : null;
            const batterHz = (rawBHz && rawBHz !== "loading") ? rawBHz : null;
            const batterHzLoading = rawBHz === "loading";

            // Build lineup batter list
            const lineupBatters = Object.entries(lineupData || {}).map(([k, v]) => ({ id: k, name: v?.name || k }));

            return (
              <div>
                <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:14 }}>
                  <span style={{ fontSize:22 }}>🎯</span>
                  <div>
                    <div style={{ fontSize:14, fontWeight:700, color:"#16233c" }}>Pitch Location Chart</div>
                    <div style={{ fontSize:11, color:"#74839d", marginTop:1 }}>Avg pitch location by type · select a batter to overlay their hot zones</div>
                  </div>
                </div>

                {/* Controls */}
                <div style={{ display:"flex", gap:8, marginBottom:12, flexWrap:"wrap", alignItems:"center" }}>
                  <div style={{ display:"flex", background:"rgba(210,217,236,0.6)", borderRadius:8, border:"1px solid rgba(32,98,200,0.24)", overflow:"hidden" }}>
                    {["ops","avg"].map(m => (
                      <button key={m} onClick={() => setPZoneMetric(m)} style={{
                        padding:"5px 14px", fontSize:11, fontWeight:700, cursor:"pointer", border:"none",
                        background: pZoneMetric===m ? "rgba(32,98,200,0.2)" : "transparent",
                        color: pZoneMetric===m ? "#2062c8" : "#8b99b0",
                      }}>{m.toUpperCase()}</button>
                    ))}
                  </div>
                  {batterHz && (
                    <button onClick={() => setPZoneOverlay(v => !v)} style={{
                      padding:"5px 14px", fontSize:11, fontWeight:700, cursor:"pointer", borderRadius:8,
                      background: pZoneOverlay ? "rgba(194,87,15,0.12)" : "rgba(210,217,236,0.5)",
                      color: pZoneOverlay ? "#c2570f" : "#8b99b0",
                      border: pZoneOverlay ? "1px solid rgba(194,87,15,0.3)" : "1px solid rgba(32,98,200,0.16)",
                    }}>
                      {pZoneOverlay ? "● Hot Zones ON" : "○ Hot Zones OFF"}
                    </button>
                  )}
                </div>

                {/* Pitch type filter */}
                {allPT.length > 0 && (
                  <div style={{ display:"flex", flexWrap:"wrap", gap:5, marginBottom:12 }}>
                    {allPT.map(pt => {
                      const active = activePT.has(pt);
                      const color = PITCH_COLORS_ZONE[pt] || "#5d6b82";
                      const usage = pitcherArsenal[pt]?.usage || 0;
                      return (
                        <button key={pt} onClick={() => {
                          setPZoneActivePitches(prev => {
                            const s = new Set(prev ?? allPT);
                            if (s.has(pt)) s.delete(pt); else s.add(pt);
                            return new Set(s);
                          });
                        }} style={{
                          padding:"3px 10px", fontSize:10, fontWeight:700, cursor:"pointer", borderRadius:12,
                          background: active ? `${PITCH_COLORS_ZONE[pt]||"#5d6b82"}22` : "rgba(210,217,236,0.5)",
                          color: active ? color : "#b6c5dc",
                          border: `1px solid ${active ? color+"55" : "rgba(32,98,200,0.16)"}`,
                        }}>
                          {pt} {usage > 0 ? `${usage.toFixed(0)}%` : ""}
                        </button>
                      );
                    })}
                  </div>
                )}

                {/* Chart + legend */}
                <div style={{ display:"flex", gap:16, alignItems:"flex-start", flexWrap:"wrap" }}>
                  <div>
                    {pitcherPitchLocs === null ? (
                      <div style={{ width:210, height:255, display:"flex", alignItems:"center", justifyContent:"center" }}>
                        <Loader text="Loading…" />
                      </div>
                    ) : (
                      <MatchupZoneChart
                        hotZones={pZoneOverlay && batterHz ? batterHz : {}}
                        pitchLocations={pitchLocs}
                        arsenalData={pitcherArsenal}
                        metric={pZoneMetric}
                        overlay={true}
                        activePitchTypes={activePT}
                      />
                    )}
                    {!locsLoaded && pitcherPitchLocs !== null && (
                      <div style={{ fontSize:10, color:"#8b99b0", textAlign:"center", marginTop:4 }}>Loading…</div>
                    )}
                    {locsLoaded && allPT.length === 0 && (
                      <div style={{ fontSize:10, color:"#b6c5dc", textAlign:"center", marginTop:4 }}>
                        Pitch location data unavailable
                      </div>
                    )}
                    <div style={{ fontSize:9, color:"#c9d5e8", textAlign:"center", marginTop:4 }}>
                      Catcher's perspective · Dot size = usage %
                    </div>
                  </div>

                  <div style={{ flex:1, minWidth:120 }}>
                    {/* Pitch legend */}
                    {allPT.length > 0 && (
                      <div style={{ marginBottom:12 }}>
                        <div style={{ fontSize:10, color:"#c2570f", fontWeight:700, textTransform:"uppercase", letterSpacing:0.8, marginBottom:6 }}>
                          {pitcher.fullName?.split(" ").pop()} Arsenal
                        </div>
                        {Object.entries(pitchLocs||{}).sort((a,b)=>b[1].n-a[1].n).map(([pt, loc]) => {
                          const color = PITCH_COLORS_ZONE[pt] || "#5d6b82";
                          const usage = pitcherArsenal[pt]?.usage || 0;
                          return (
                            <div key={pt} style={{ display:"flex", alignItems:"center", gap:6, marginBottom:4 }}>
                              <div style={{ width:10, height:10, borderRadius:"50%", background:color, flexShrink:0 }} />
                              <div>
                                <span style={{ fontSize:9, color, fontWeight:700 }}>{pt}</span>
                                <span style={{ fontSize:9, color:"#74839d", marginLeft:4 }}>{ZONE_PITCH_LABELS[pt] || pt}</span>
                                {usage > 0 && <span style={{ fontSize:9, color:"#8b99b0", marginLeft:4 }}>{usage.toFixed(0)}%</span>}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* Batter selector */}
                    {lineupBatters.length > 0 && (
                      <div>
                        <div style={{ fontSize:10, color:"#0f8a44", fontWeight:700, textTransform:"uppercase", letterSpacing:0.8, marginBottom:6 }}>
                          Overlay Batter Zones
                        </div>
                        <div style={{ display:"flex", flexWrap:"wrap", gap:4 }}>
                          <button onClick={() => setPZoneSelectedBatter(null)} style={{
                            padding:"2px 8px", fontSize:10, borderRadius:12, cursor:"pointer",
                            background: pZoneSelectedBatter === null ? "rgba(15,138,68,0.12)" : "rgba(210,217,236,0.5)",
                            color: pZoneSelectedBatter === null ? "#0f8a44" : "#b6c5dc",
                            border: pZoneSelectedBatter === null ? "1px solid rgba(15,138,68,0.3)" : "1px solid rgba(32,98,200,0.128)",
                          }}>None</button>
                          {lineupBatters.map(b => {
                            const isSel = pZoneSelectedBatter === b.id;
                            return (
                              <button key={b.id} onClick={() => { setPZoneSelectedBatter(b.id); setPZoneOverlay(true); }} style={{
                                padding:"2px 8px", fontSize:10, borderRadius:12, cursor:"pointer",
                                background: isSel ? "rgba(15,138,68,0.12)" : "rgba(210,217,236,0.5)",
                                color: isSel ? "#0f8a44" : "#b6c5dc",
                                border: isSel ? "1px solid rgba(15,138,68,0.3)" : "1px solid rgba(32,98,200,0.128)",
                              }}>
                                {b.name?.split(" ").pop() || b.id}
                                {batterHzLoading && isSel && " …"}
                              </button>
                            );
                          })}
                        </div>
                        {pZoneSelectedBatter && batterHz && (
                          <div style={{ marginTop:8 }}>
                            {(() => {
                              const vals = Object.values(batterHz).map(z => pZoneMetric==="ops" ? z.ops : z.avg).filter(v=>v!=null);
                              if (!vals.length) return null;
                              const best = Math.max(...vals), worst = Math.min(...vals);
                              const ZONE_NAMES = {1:"Up-In",2:"Up-Mid",3:"Up-Out",4:"Mid-In",5:"Heart",6:"Mid-Out",7:"Low-In",8:"Low-Mid",9:"Low-Out",11:"Chase-TL",12:"Chase-TR",13:"Chase-BL",14:"Chase-BR"};
                              const hotZ = Object.entries(batterHz).find(([,z])=>(pZoneMetric==="ops"?z.ops:z.avg)===best);
                              const coldZ = Object.entries(batterHz).find(([,z])=>(pZoneMetric==="ops"?z.ops:z.avg)===worst);
                              return (
                                <>
                                  <div style={{ fontSize:10, color:"#0f8a44", marginBottom:2 }}>🔥 Best: {ZONE_NAMES[hotZ?.[0]]} ({best?.toFixed(3).replace(/^0/,"")})</div>
                                  <div style={{ fontSize:10, color:"#d03131" }}>🥶 Worst: {ZONE_NAMES[coldZ?.[0]]} ({worst?.toFixed(3).replace(/^0/,"")})</div>
                                </>
                              );
                            })()}
                          </div>
                        )}
                      </div>
                    )}
                    {lineupBatters.length === 0 && (
                      <div style={{ fontSize:10, color:"#b6c5dc" }}>
                        Open from a game matchup to select a batter for hot zone overlay
                      </div>
                    )}

                    {/* Scale legend */}
                    {pZoneSelectedBatter && batterHz && (
                      <div style={{ marginTop:12 }}>
                        <div style={{ fontSize:10, color:"#2062c8", fontWeight:700, textTransform:"uppercase", letterSpacing:0.8, marginBottom:6 }}>
                          {pZoneMetric.toUpperCase()} Scale
                        </div>
                        {[
                          { color:"rgba(200,20,20,0.85)",  label: pZoneMetric==="ops" ? "≥1.000" : "≥.320 Hot" },
                          { color:"rgba(182,126,32,0.85)", label: pZoneMetric==="ops" ? ".820–.950" : ".260–.300" },
                          { color:"rgba(41,102,174,0.85)", label: pZoneMetric==="ops" ? ".720–.820" : ".220–.260" },
                          { color:"rgba(20,60,160,0.85)",  label: pZoneMetric==="ops" ? "< .600 Cold" : "< .170" },
                        ].map(({ color, label }) => (
                          <div key={label} style={{ display:"flex", alignItems:"center", gap:6, marginBottom:3 }}>
                            <div style={{ width:14, height:10, background:color, borderRadius:2, flexShrink:0 }} />
                            <span style={{ fontSize:9, color:"#6d7c96" }}>{label}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })()}

          {/* ── PITCH ARSENAL TAB ── */}
          {tab === "arsenal" && (
            <div>
              {/* Year selector */}
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
                <span style={{ fontSize: 11, color: "#5d6f8b" }}>Season:</span>
                {[2024, 2025, 2026].map(yr => (
                  <button key={yr} onClick={() => setArsenalYear(yr)} style={{
                    padding: "3px 10px", fontSize: 11, borderRadius: 4, cursor: "pointer",
                    border: arsenalYear === yr ? "1px solid #b45309" : "1px solid #c6cdd9",
                    background: arsenalYear === yr ? "rgba(180,83,9,0.15)" : "#e8edf6",
                    color: arsenalYear === yr ? "#b45309" : "#5d6f8b",
                    fontWeight: arsenalYear === yr ? 700 : 400,
                  }}>{yr}</button>
                ))}
              </div>
              {arsenalLoading && arsenalCache[arsenalYear] === undefined && <Loader text="Loading pitch arsenal..." />}
              {!arsenalLoading && arsenalCache[arsenalYear] !== undefined && arsenalCache[arsenalYear].length === 0 && (
                <div style={{ padding: "24px 0", textAlign: "center", color: "#74839d", fontSize: 13 }}>
                  No pitch arsenal data available for {arsenalYear}.
                </div>
              )}
              {arsenalCache[arsenalYear]?.length > 0 && (() => {
                const arsenal = arsenalCache[arsenalYear];
                const scMap = statcastCache[arsenalYear] || {};
                const hasStatcast = Object.keys(scMap).length > 0;
                const sorted = [...arsenal].sort((a, b) => (parseFloat(b.stat?.percentage)||0) - (parseFloat(a.stat?.percentage)||0));
                const hasPitchLocs = pitcherPitchLocs && Object.keys(pitcherPitchLocs).length > 0;
                return (
                  <div>
                    {/* ── Movement Chart + Breakdown Table ── */}
                    {(hasPitchLocs || pitcherPitchLocs === null) && (
                      <div style={{ marginBottom:20 }}>
                        <div style={{ fontSize:10, color:"#c2570f", fontWeight:700, textTransform:"uppercase",
                          letterSpacing:1, marginBottom:10 }}>
                          ⚾ Pitch Movement · {arsenalYear}
                        </div>
                        <div style={{ display:"flex", gap:16, alignItems:"flex-start", flexWrap:"wrap" }}>
                          {/* Polar movement chart (Savant-style) */}
                          <div style={{ flexShrink:0 }}>
                            {pitcherPitchLocs === null ? (
                              <div style={{ width:360, height:360, display:"flex", alignItems:"center",
                                justifyContent:"center", background:"rgba(222,226,241,0.95)", borderRadius:8,
                                border:"1px solid rgba(32,98,200,0.128)" }}>
                                <Loader text="Loading movement…" />
                              </div>
                            ) : (
                              <PitchMovementChart
                                pitchLocs={pitcherPitchLocs}
                                lgPitchMove={lgPitchMove}
                                pitcherHand={pitcher?.pitchHand?.code || pitcherArmAngles?.pitchHand || "R"}
                                armAngle={pitcherArmAngles?.ballAngle ?? null}
                                year={arsenalYear}
                              />
                            )}
                          </div>
                          {/* Breakdown table */}
                          {hasPitchLocs && (
                            <div style={{ flex:1, minWidth:200 }}>
                              <div style={{ fontSize:9, color:"#8b99b0", textTransform:"uppercase",
                                letterSpacing:0.8, marginBottom:6, fontWeight:700 }}>
                                Movement Profile
                              </div>
                              <PitchBreakdownTable
                                pitchLocs={pitcherPitchLocs}
                                arsenalSplits={arsenal}
                                statcastData={scMap}
                              />
                            </div>
                          )}
                        </div>
                        <div style={{ height:1, background:"rgba(32,98,200,0.128)", margin:"16px 0" }} />
                      </div>
                    )}

                    {/* Pitcher batted-ball + quality-of-contact tables (Savant pic 1 sections 2 & 3) */}
                    {pitcherStatcast && (
                      <>
                        <PitcherBattedBallTable stats={pitcherStatcast} year={arsenalYear} playerName={pitcher.fullName} />
                        <PitcherQualityOfContactTable stats={pitcherStatcast} year={arsenalYear} playerName={pitcher.fullName} />
                      </>
                    )}

                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                      <div style={{ fontSize: 10, color: "#6d7c96", textTransform: "uppercase", letterSpacing: 1.2 }}>
                        Pitch Mix · {arsenalYear} Season
                      </div>
                      {hasStatcast && <span style={{ fontSize: 9, color: "#0f8a44", background: "rgba(15,138,68,0.08)", padding: "1px 6px", borderRadius: 3, border: "1px solid rgba(15,138,68,0.15)" }}>+ Statcast</span>}
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                      {sorted.map((split, i) => {
                        const code = split.stat?.type?.code || split.split?.pitchType?.code || "XX";
                        const name = split.stat?.type?.description || split.split?.pitchType?.description || PITCH_LABELS[code] || code;
                        const usage = (parseFloat(split.stat?.percentage) || 0) * 100;
                        const vel = parseFloat(split.stat?.averageSpeed) || 0;
                        const count = parseInt(split.stat?.count) || 0;
                        const color = PITCH_COLORS[code] || "#2062c8";
                        const sc = scMap[code];
                        // RV/100: negative = good for pitcher (green), positive = bad (red)
                        const rvColor = sc?.rv100 != null ? (sc.rv100 <= 0 ? "#0f8a44" : "#d03131") : "#4c5f7d";
                        const rvVal = sc?.rv100 != null ? (sc.rv100 > 0 ? "+" : "") + sc.rv100.toFixed(1) : null;
                        return (
                          <div key={i} style={{ background: "rgba(210,217,236,0.5)", borderRadius: 10, padding: "12px 14px", border: `1px solid ${color}22` }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                              <span style={{ fontSize: 10, fontWeight: 700, color, background: `${color}18`, padding: "2px 7px", borderRadius: 4, minWidth: 30, textAlign: "center" }}>{code}</span>
                              <span style={{ fontSize: 13, fontWeight: 600, color: "#223350", flex: 1 }}>{name}</span>
                              <span style={{ fontSize: 12, fontWeight: 700, color, fontFamily: "'JetBrains Mono', monospace" }}>{usage.toFixed(1)}%</span>
                            </div>
                            <div style={{ height: 5, borderRadius: 3, background: "rgba(22,44,80,0.05)", marginBottom: 10, overflow: "hidden" }}>
                              <div style={{ height: "100%", width: `${Math.min(usage, 100)}%`, background: color, borderRadius: 3 }} />
                            </div>
                            <div style={{ display: "grid", gridTemplateColumns: sc ? "repeat(3, 1fr)" : "repeat(2, 1fr)", gap: 6 }}>
                              {[
                                ["Velocity", vel > 0 ? vel.toFixed(1)+" mph" : "—", undefined],
                                ["Pitches", count > 0 ? count.toLocaleString() : "—", undefined],
                                ...(sc ? [
                                  ["Whiff%", sc.whiff.toFixed(1)+"%", "#6d4fd0"],
                                  ["Put-Away%", sc.putAway.toFixed(1)+"%", "#2569d6"],
                                  ["K%", sc.kPct.toFixed(1)+"%", "#b45309"],
                                  ["RV/100", rvVal ?? "—", rvColor],
                                ] : []),
                              ].map(([label, val, accent]) => (
                                <div key={label} style={{ textAlign: "center" }}>
                                  <div style={{ fontSize: 9, color: "#74839d", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 2 }}>{label}</div>
                                  <div style={{ fontSize: 12, fontWeight: 600, color: accent || "#4c5f7d", fontFamily: "'JetBrains Mono', monospace" }}>{val}</div>
                                </div>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    <div style={{ marginTop: 12, padding: "8px 12px", background: "rgba(210,217,236,0.3)", borderRadius: 8, border: "1px solid rgba(32,98,200,0.096)" }}>
                      <div style={{ fontSize: 9, color: "#8b99b0", lineHeight: 1.8 }}>
                        {hasStatcast
                          ? <><strong style={{ color: "#74839d" }}>Whiff%</strong> = swings-and-misses / swings · <strong style={{ color: "#74839d" }}>Put-Away%</strong> = K rate with 2 strikes · <strong style={{ color: "#74839d" }}>RV/100</strong> run value per 100 pitches, negative = better for pitcher · via Baseball Savant</>
                          : <>Usage % and velocity via MLB Stats API · Statcast metrics unavailable for {arsenalYear}</>
                        }
                      </div>
                    </div>
                  </div>
                );
              })()}
            </div>
          )}

          {/* ── BOOK ODDS TAB ── */}
          {tab === "bookodds" && (
            <PitcherKProjection pitcherScanData={pitcherScanData} kModel={kModel} ppr={ppr} />
          )}
          {tab === "bookodds" && (() => {
            const BOOKS = ["fanduel","draftkings","hardrockbet"];
            const nn = _normPropName(pitcher?.fullName || "");
            const pd = propOddsMap?.[nn] || {};
            const modelSignal = pitcherScanData?.signal || null; // "over" | "under" | "neutral"

            // Collect both over and under odds per line
            const lineMap = {};
            for (const [mk, books] of Object.entries(pd)) {
              if (!mk.includes("strikeout")) continue;
              const isUnder = mk.endsWith("__under");
              for (const [line, bkData] of Object.entries(books)) {
                if (!lineMap[line]) lineMap[line] = { over: {}, under: {} };
                const side = isUnder ? "under" : "over";
                for (const bk of BOOKS) {
                  if (bkData[bk]?.price != null && !lineMap[line][side][bk]) {
                    lineMap[line][side][bk] = { price: bkData[bk].price, link: bkData[bk].link, sid: bkData[bk].sid };
                  }
                }
              }
            }
            const sortedLines = Object.keys(lineMap).map(Number).sort((a, b) => a - b);

            if (sortedLines.length === 0) return (
              <div style={{ padding: "40px 0", textAlign: "center", color: "#8b99b0", fontSize: 13 }}>
                No strikeout odds available — click <strong>Odds</strong> to fetch live lines
              </div>
            );

            const _xKFP = pitcherScanData?.xK ?? null;
            const renderSideRow = (line, side, entry, isSignal) => {
              const allPrices = BOOKS.map(bk => entry[bk]?.price).filter(p => p != null);
              const bestPrice = allPrices.length > 0 ? Math.max(...allPrices) : null;
              const toImpl = p => p > 0 ? 100/(p+100) : Math.abs(p)/(Math.abs(p)+100);
              const avgImpl = allPrices.length ? allPrices.reduce((s,p) => s + toImpl(p), 0) / allPrices.length : null;
              const fairProb = avgImpl ? avgImpl / 1.045 : null;
              const rowEV = fairProb != null && bestPrice != null ? calcEVFromOdds(fairProb, bestPrice) : null;
              const isOver = side === "over";
              const labelColor = isOver ? "#0f8a44" : "#d03131";
              const hasAny = allPrices.length > 0;
              const overProb = _xKFP != null ? modelImpliedProb(_xKFP, "ks", line) : null;
              const sideProb = isOver ? overProb : (overProb != null ? 1 - overProb : null);
              return (
                <div key={`${line}-${side}`} style={{ display: "grid", gridTemplateColumns: "72px 1fr 1fr 1fr 52px auto", gap: 0, padding: "6px 12px", borderBottom: "1px solid rgba(32,98,200,0.048)", alignItems: "center",
                  background: isSignal ? (isOver ? "rgba(15,138,68,0.04)" : "rgba(208,49,49,0.04)") : "transparent" }}
                  onMouseEnter={e => e.currentTarget.style.background = isSignal ? (isOver ? "rgba(15,138,68,0.07)" : "rgba(208,49,49,0.07)") : "rgba(32,98,200,0.064)"}
                  onMouseLeave={e => e.currentTarget.style.background = isSignal ? (isOver ? "rgba(15,138,68,0.04)" : "rgba(208,49,49,0.04)") : "transparent"}>
                  <span style={{ fontSize: 12, fontWeight: 700, fontFamily: "'JetBrains Mono',monospace", color: hasAny ? labelColor : "#b6c5dc", display: "flex", alignItems: "center", gap: 4 }}>
                    {isOver ? "O" : "U"}{line}
                    {isSignal && <span style={{ fontSize: 9, fontWeight: 800, padding: "1px 4px", borderRadius: 3, background: isOver ? "rgba(15,138,68,0.2)" : "rgba(208,49,49,0.2)", color: labelColor }}>PICK</span>}
                  </span>
                  {BOOKS.map(bk => {
                    const e = entry[bk];
                    let url = null;
                    if (e && bk === "hardrockbet" && e.sid) url = `https://share.hardrock.bet/Pt0T/bet?deep_link_value=hardrock://betslip/${e.sid}`;
                    else if (e) url = e.link;
                    const isBest = e?.price != null && e.price === bestPrice;
                    return (
                      <span key={bk} style={{ textAlign: "right" }}>
                        <OddsLink price={e?.price ?? null} url={url} isBest={isBest} bk={bk} style={{ fontSize: 12 }} />
                      </span>
                    );
                  })}
                  <span style={{ textAlign: "right" }}>
                    {rowEV != null ? (
                      <span style={{ fontSize: 11, fontWeight: 700, fontFamily: "'JetBrains Mono',monospace",
                        color: rowEV > 0 ? "#8b2fc9" : "#8b99b0" }}>
                        {rowEV > 0 ? "+" : ""}{(rowEV * 100).toFixed(0)}%
                      </span>
                    ) : <span style={{ fontSize: 10, color: "#b6c5dc" }}>—</span>}
                  </span>
                  <span style={{ paddingLeft: 10, textAlign: "right" }}>
                    <KellyBadge modelProb={sideProb} americanOdds={bestPrice} />
                  </span>
                </div>
              );
            };

            return (
              <div>
                <div style={{ fontSize: 11, color: "#8b99b0", marginBottom: 16 }}>
                  All available K lines from all books. Click any odds to share the bet slip link.
                </div>
                <div style={{ background: "rgba(210,217,236,0.5)", borderRadius: 8, border: "1px solid rgba(32,98,200,0.128)", overflow: "hidden" }}>
                  {/* Header */}
                  <div style={{ display: "grid", gridTemplateColumns: "72px 1fr 1fr 1fr 52px auto", gap: 0, borderBottom: "1px solid rgba(32,98,200,0.128)", padding: "6px 12px" }}>
                    <span style={{ fontSize: 10, color: "#8b99b0", fontWeight: 700 }}>LINE</span>
                    {BOOKS.map(bk => (
                      <span key={bk} style={{ fontSize: 10, fontWeight: 700, color: BOOK_COLORS[bk], textAlign: "right" }}>{BOOK_ABBR[bk]}</span>
                    ))}
                    <span style={{ fontSize: 10, fontWeight: 700, color: "#8b2fc9", textAlign: "right" }}>EV</span>
                    <span style={{ fontSize: 10, fontWeight: 700, color: "#8b99b0", textAlign: "right", paddingLeft: 10 }}>SIZE</span>
                  </div>
                  {sortedLines.map(line => {
                    const { over, under } = lineMap[line];
                    const overIsSignal = modelSignal === "over";
                    const underIsSignal = modelSignal === "under";
                    return (
                      <div key={line} style={{ borderBottom: "1px solid rgba(32,98,200,0.096)" }}>
                        {renderSideRow(line, "over",  over,  overIsSignal)}
                        {renderSideRow(line, "under", under, underIsSignal)}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })()}

          {/* ── BATTER HISTORY TAB ── */}
          {tab === "vl" && (() => {
            // Derive opponent team: scanData.opponent > lineupData 2-team check
            const oppKey = pitcherScanData?.opponent || opponentTeam || (() => {
              const pitcherTeamAbbrev = pitcherTeam || "";
              const ldKeys = Object.keys(lineupData || {});
              if (ldKeys.length === 2 && ldKeys.includes(pitcherTeamAbbrev)) return ldKeys.find(k => k !== pitcherTeamAbbrev);
              return "";
            })();
            const hasLineup = !!(oppKey && lineupData[oppKey]?.batters?.length);
            const opposingBatters = lineupData[oppKey]?.batters || [];
            const isConfirmed = lineupData[oppKey]?.confirmed;
            // When lineup not announced, fall back to active roster (non-pitchers)
            const rosterFallbackBatters = !hasLineup && oppKey
              ? Object.entries(oppRosterById)
                  .filter(([k, v]) => k !== "__byLast" && v?.posType !== "Pitcher")
                  .map(([, person]) => ({ id: person.id, fullName: person.fullName, pos: person.posAbbr, isRosterFallback: true }))
              : [];
            const isRosterFallback = !hasLineup && rosterFallbackBatters.length > 0;
            const effectiveBatters = hasLineup ? opposingBatters.slice(0, 9) : rosterFallbackBatters.slice(0, 14);
            const pitcherLast = pitcher?.fullName?.split(" ").slice(1).join(" ") || pitcher?.fullName || "Pitcher";

            const statCols = [
              { key: "hits",        label: "H",   color: v => v > 0 ? "#0f8a44" : "#b6c5dc" },
              { key: "atBats",      label: "AB",  color: () => "#74839d" },
              { key: "avg",         label: "AVG", color: v => { const f = parseFloat(v); return f >= 0.300 ? "#0f8a44" : f <= 0.200 ? "#d03131" : "#4c5f7d"; }, fmt: fmtAvg },
              { key: "homeRuns",    label: "HR",  color: v => v > 0 ? "#c2570f" : "#b6c5dc" },
              { key: "rbi",         label: "RBI", color: () => "#4c5f7d" },
              { key: "baseOnBalls", label: "BB",  color: () => "#4c5f7d" },
              { key: "strikeOuts",  label: "K",   color: v => v > 5 ? "#d03131" : "#4c5f7d" },
              { key: "obp",         label: "OBP", color: () => "#4c5f7d", fmt: fmtAvg },
              { key: "ops",         label: "OPS", color: v => { const f = parseFloat(v); return f >= 0.900 ? "#0f8a44" : f < 0.600 ? "#d03131" : "#4c5f7d"; }, fmt: fmtAvg },
            ];

            return (
              <div>
                {/* Header */}
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
                  <span style={{ fontSize: 22 }}>📋</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: "#a16207" }}>
                      {oppKey || "Lineup"} · Batter History vs {pitcherLast}
                    </div>
                    <div style={{ fontSize: 11, color: "#74839d", marginTop: 2 }}>
                      Career stats · {isRosterFallback ? "⭐ Active roster — lineup TBD" : isConfirmed ? "⭐ Confirmed lineup" : "PROJ lineup"}
                    </div>
                  </div>
                  {isRosterFallback ? (
                    <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 7px", borderRadius: 4,
                      background: "rgba(109,79,208,0.12)", color: "#6d4fd0", border: "1px solid rgba(109,79,208,0.3)" }}>
                      ROSTER
                    </span>
                  ) : isConfirmed != null && (
                    <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 7px", borderRadius: 4,
                      background: isConfirmed ? "rgba(15,138,68,0.12)" : "rgba(161,98,7,0.12)",
                      color: isConfirmed ? "#0f8a44" : "#a16207", border: `1px solid ${isConfirmed ? "rgba(15,138,68,0.3)" : "rgba(161,98,7,0.3)"}` }}>
                      {isConfirmed ? "CONFIRMED" : "PROJECTED"}
                    </span>
                  )}
                </div>

                {effectiveBatters.length === 0 ? (
                  <div style={{ padding: "40px 0", textAlign: "center" }}>
                    <div style={{ fontSize: 13, color: "#b6c5dc" }}>No lineup data available</div>
                    <div style={{ fontSize: 11, color: "#c9d5e8", marginTop: 6 }}>
                      {oppKey ? `${oppKey} lineup not yet announced` : "Select a game with lineup data"}
                    </div>
                  </div>
                ) : (
                  <div style={{ background: "rgba(210,217,236,0.5)", borderRadius: 10, border: "1px solid rgba(161,98,7,0.12)", overflow: "hidden" }}>
                    {/* Table header */}
                    {(() => {
                      const handleBhSort = col => {
                        if (bhSortCol === col) setBhSortDir(d => d === "desc" ? "asc" : "desc");
                        else { setBhSortCol(col); setBhSortDir("desc"); }
                      };
                      return (
                        <div style={{ display: "grid", gridTemplateColumns: "20px 1fr 26px " + statCols.map(() => "34px").join(" ") + " 24px",
                          padding: "6px 12px", borderBottom: "1px solid rgba(161,98,7,0.15)", background: "rgba(161,98,7,0.04)", gap: 4, alignItems: "center" }}>
                          <span style={{ fontSize: 8, color: "#b6c5dc", fontWeight: 700 }}>#</span>
                          <span style={{ fontSize: 8, color: "#74839d", fontWeight: 700 }}>BATTER</span>
                          <span style={{ fontSize: 8, color: "#74839d", fontWeight: 700, textAlign: "right" }}>POS</span>
                          {statCols.map(c => {
                            const active = bhSortCol === c.key;
                            return (
                              <span key={c.key} onClick={() => handleBhSort(c.key)}
                                style={{ fontSize: 8, fontWeight: 700, textAlign: "right", cursor: "pointer", userSelect: "none",
                                  color: active ? "#2062c8" : c.key === "avg" || c.key === "ops" ? "#a16207" : "#74839d" }}>
                                {c.label}{active ? (bhSortDir === "desc" ? "↓" : "↑") : ""}
                              </span>
                            );
                          })}
                          <span style={{ fontSize: 8, color: "#74839d", fontWeight: 700, textAlign: "right" }}>B</span>
                        </div>
                      );
                    })()}
                    {/* Rows */}
                    {(bhSortCol == null ? effectiveBatters : [...effectiveBatters].sort((a, b) => {
                      const getVal = (batter) => {
                        const nm = _normName(batter.fullName || batter.name || "");
                        const byLast2 = oppRosterById.__byLast || {};
                        const rp = batter.isRosterFallback ? null : (oppRosterById[nm] || byLast2[nm.split(" ").pop()] || null);
                        const bid2 = batter.id || batter.person?.id || rp?.id;
                        const ent = bid2 ? lineupBvpCache[bid2] : undefined;
                        if (!ent || ent === "loading") return -1;
                        const cs2 = ent?.career?.[0]?.stat || ent?.season?.[0]?.stat || {};
                        const raw = cs2[bhSortCol];
                        return raw != null ? (typeof raw === "string" ? parseFloat(raw) || 0 : raw) : -1;
                      };
                      const av = getVal(a), bv = getVal(b);
                      return bhSortDir === "desc" ? bv - av : av - bv;
                    })).map((b, i) => {
                      const bName = b.fullName || b.name || "—";
                      const bPos = b.pos || b.position?.abbreviation || b.posAbbr || "";
                      const bHand = b.batSide?.code || b.batSide || b.bats || "";
                      const bIsRosterFallback = !!b.isRosterFallback;
                      // Resolve MLB player ID: direct from lineup data, or via roster lookup
                      const norm = _normName(bName);
                      const byLast = oppRosterById.__byLast || {};
                      const rosterPerson = bIsRosterFallback ? null : (oppRosterById[norm] || byLast[norm.split(" ").pop()] || null);
                      const bid = b.id || b.person?.id || rosterPerson?.id;
                      const entry = bid ? lineupBvpCache[bid] : undefined;
                      const isLoading = entry === "loading";
                      const cs = (entry && entry !== "loading") ? (entry?.career?.[0]?.stat || entry?.season?.[0]?.stat || {}) : {};
                      const hasStats = !!cs.atBats;
                      const handColor = bHand === "L" ? "#0f8a44" : bHand === "S" ? "#6d4fd0" : "#2569d6";
                      const lastIdx = effectiveBatters.length - 1;
                      return (
                        <div key={bid || i} style={{
                          display: "grid", gridTemplateColumns: "20px 1fr 26px " + statCols.map(() => "34px").join(" ") + " 24px",
                          padding: "7px 12px", gap: 4, alignItems: "center",
                          borderBottom: i < lastIdx ? "1px solid rgba(32,98,200,0.064)" : "none",
                          background: i % 2 === 0 ? "transparent" : "rgba(32,98,200,0.024)",
                        }}
                          onMouseEnter={e => e.currentTarget.style.background = "rgba(161,98,7,0.04)"}
                          onMouseLeave={e => e.currentTarget.style.background = i % 2 === 0 ? "transparent" : "rgba(32,98,200,0.024)"}>
                          {/* Slot: batting order # for confirmed, ⭐ PROJ for roster/projected */}
                          {bIsRosterFallback ? (
                            <span style={{ fontSize: 7, color: "#6d4fd0", fontWeight: 700, fontFamily: "'JetBrains Mono',monospace" }}>⭐</span>
                          ) : (
                            <span style={{ fontSize: 10, color: "#c9d5e8", fontFamily: "'JetBrains Mono',monospace" }}>{b.order || i+1}</span>
                          )}
                          <span style={{ fontSize: 12, color: "#223350", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: 4 }}>
                            {bName}
                            {bIsRosterFallback
                              ? <span style={{ fontSize: 7, color: "#6d4fd0", background: "rgba(109,79,208,0.1)", padding: "1px 3px", borderRadius: 2, fontWeight: 700, flexShrink: 0 }}>PROJ</span>
                              : isConfirmed
                                ? <span style={{ fontSize: 9 }}>⭐</span>
                                : <span style={{ fontSize: 7, color: "#a16207", background: "rgba(161,98,7,0.1)", padding: "1px 3px", borderRadius: 2, fontWeight: 700, flexShrink: 0 }}>PROJ</span>}
                          </span>
                          <span style={{ fontSize: 9, color: "#8b99b0", textAlign: "right" }}>{bPos}</span>
                          {statCols.map(col => {
                            let raw = cs[col.key];
                            const val = col.fmt ? (raw != null ? col.fmt(raw) : null) : raw;
                            const color = hasStats && val != null ? col.color(val) : "#c9d5e8";
                            return (
                              <span key={col.key} style={{ fontSize: 10, textAlign: "right", fontFamily: "'JetBrains Mono',monospace", color, fontWeight: col.key === "avg" || col.key === "ops" ? 700 : 400 }}>
                                {isLoading ? "…" : (hasStats && val != null ? val : "—")}
                              </span>
                            );
                          })}
                          <span style={{ fontSize: 9, textAlign: "right", color: handColor, fontWeight: 700 }}>{bHand || "—"}</span>
                        </div>
                      );
                    })}
                    {/* Summary footer */}
                    <div style={{ padding: "8px 12px", borderTop: "1px solid rgba(161,98,7,0.1)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span style={{ fontSize: 9, color: "#c9d5e8" }}>Career stats only · Season may differ</span>
                      <span style={{ fontSize: 9, color: "#c9d5e8" }}>
                        {effectiveBatters.filter(b => { const id = b.id || b.person?.id; const e = lineupBvpCache[id]; return e && e !== "loading" && e?.career?.[0]?.stat?.atBats; }).length} / {effectiveBatters.length} with data
                        {isRosterFallback && <span style={{ color: "#6d4fd0", marginLeft: 6 }}>· Active roster</span>}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            );
          })()}

          {tab === "news" && (
            <div>
              {/* Season giveaway schedule for this player */}
              <PlayerGiveaways playerId={pitcher.id} />
              <div style={{ fontSize: 10, color: "#6d7c96", textTransform: "uppercase", letterSpacing: 1.2, marginBottom: 10 }}>
                Latest News · Google News + Rotowire
              </div>
              {newsLoading && <Loader text="Fetching latest news..." />}
              {!newsLoading && (!news || news.length === 0) && (
                <div style={{ padding: "24px 0", textAlign: "center", color: "#74839d", fontSize: 13 }}>No recent news found.</div>
              )}
              {!newsLoading && news?.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {news.map((a, i) => (
                    <a key={i} href={a.link || "#"} target="_blank" rel="noopener noreferrer"
                      style={{ display: "block", textDecoration: "none", padding: "10px 12px", borderRadius: 8,
                        background: a.isRotowire ? "rgba(161,98,7,0.06)" : "rgba(210,217,236,0.4)",
                        border: `1px solid ${a.isRotowire ? "rgba(161,98,7,0.2)" : "rgba(32,98,200,0.128)"}`,
                      }}
                      onMouseEnter={e => e.currentTarget.style.borderColor = a.isRotowire ? "rgba(161,98,7,0.4)" : "rgba(32,98,200,0.25)"}
                      onMouseLeave={e => e.currentTarget.style.borderColor = a.isRotowire ? "rgba(161,98,7,0.2)" : "rgba(32,98,200,0.128)"}
                    >
                      <div style={{ display: "flex", alignItems: "flex-start", gap: 6, marginBottom: 4 }}>
                        {a.isRotowire && <span style={{ fontSize: 11, flexShrink: 0, marginTop: 1 }}>🚨</span>}
                        <span style={{ fontSize: 13, fontWeight: 600, color: "#223350", lineHeight: 1.35 }}>{a.title}</span>
                      </div>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <span style={{ fontSize: 10, color: a.isRotowire ? "#a16207" : "#2062c8", fontWeight: 600 }}>{a.source}</span>
                        {a.pubDate && <span style={{ fontSize: 10, color: "#8b99b0" }}>{_timeAgo(a.pubDate)}</span>}
                        <span style={{ fontSize: 10, color: "#b6c5dc", marginLeft: "auto" }}>↗</span>
                      </div>
                    </a>
                  ))}
                </div>
              )}
              {pitcherTeam && BEAT_REPORTERS[pitcherTeam] && (
                <div style={{ paddingTop: 16, borderTop: "1px solid rgba(32,98,200,0.128)", marginTop: 12 }}>
                  <div style={{ fontSize: 10, color: "#6d7c96", textTransform: "uppercase", letterSpacing: 1.2, marginBottom: 8 }}>
                    {pitcherTeam} Beat Writers
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {BEAT_REPORTERS[pitcherTeam].map((rep, i) => (
                      <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0",
                        borderBottom: i < BEAT_REPORTERS[pitcherTeam].length-1 ? "1px solid rgba(32,98,200,0.08)" : "none" }}>
                        <span style={{ fontSize: 11, color: "#c2570f", background: "rgba(194,87,15,0.1)", padding: "1px 6px", borderRadius: 4, minWidth: 90, textAlign: "center", flexShrink: 0 }}>{rep.o}</span>
                        <span style={{ fontSize: 12, color: "#5d6f8b" }}>{rep.r}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════
// ── PITCHER CARD (compact — opens PitcherPanel on Details) ──
// ══════════════════════════════════════════════════════════

function PitcherCard({ pitcher, teamColor, season, onDetails }) {
  const [data, setData] = useState(null);

  useEffect(() => {
    if (!pitcher?.id) return;
    setData(null);
    getPitcherStats(pitcher.id, season).then(setData);
  }, [pitcher?.id, season]);

  const pitcherProj = useMemo(() => getPitcherProj(pitcher?.fullName), [pitcher?.fullName]);

  if (!pitcher?.id) return <div style={{ color: "#74839d", fontSize: 13, padding: 16 }}>TBD</div>;
  const s = data?.season || {};
  const hand = data?.info?.pitchHand?.code || "?";

  return (
    <div style={{ background: "rgba(210,217,236,0.5)", borderRadius: 12, padding: 16, border: `1px solid ${teamColor}33` }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div>
          <span
            onClick={() => onDetails && onDetails(pitcher)}
            style={{ fontSize: 16, fontWeight: 700, color: "#2062c8", cursor: "pointer", textDecoration: "none" }}
            onMouseEnter={e => e.currentTarget.style.textDecoration = "underline"}
            onMouseLeave={e => e.currentTarget.style.textDecoration = "none"}
          >{pitcher.fullName}</span>
          <span style={{ fontSize: 12, color: "#6d7c96", marginLeft: 8 }}>({hand}HP)</span>
          {pitcherProj && <span style={{ fontSize: 9, color: "#0f8a44", marginLeft: 6, verticalAlign: "super" }}>PROJ ✓</span>}
          {pitcher._rwResolved && <span title="Probable per Rotowire — not yet confirmed by MLB" style={{ fontSize: 9, color: "#a16207", marginLeft: 6, verticalAlign: "super" }}>RW</span>}
        </div>
      </div>

      {data ? (<>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <StatBox label="W-L" value={`${s.wins??0}-${s.losses??0}`} />
          <StatBox label="ERA" value={fmt(s.era, 2)} accent={Number(s.era) < 3 ? "#0f8a44" : Number(s.era) > 5 ? "#d03131" : undefined} />
          <StatBox label="IP" value={s.inningsPitched || "—"} />
          <StatBox label="K" value={s.strikeOuts ?? "—"} />
          <StatBox label="WHIP" value={fmt(s.whip, 2)} />
          <StatBox label="BAA" value={fmtAvg(s.avg)} />
        </div>

        {/* K Projection removed from Games tab — available on Ks board */}
      </>) : <Loader text="Loading pitcher stats..." />}
    </div>
  );
}

// ══════════════════════════════════════════════════════════
// ── LINEUP / GAME CARD / DATE PICKER / NO GAMES ──
// ══════════════════════════════════════════════════════════

// Module-level name normalizer: strips accents, punctuation, suffixes — used by LineupPanel + PropsBoard
// Moved to src/lib/utils.js as normName (2026-07-06 PropsBoard extraction);
// local alias keeps the historical name for App.jsx call sites.
const _normName = normName;

// Resolve a Rotowire probable-pitcher name to a real MLB player when StatsAPI hasn't
// posted a probablePitcher yet (the detail header would otherwise show TBD, the opposing
// lineup would have no batter-vs-pitcher matchup history, and — because the scan reads
// this too — every hitter in the game would be scored with NO opposing starter and the
// pitcher would get no Ks row at all).
//
// Candidates are RESTRICTED to pitchers, so a stray last-name collision with a position
// player (e.g. the only "Sullivan" on COL being a catcher) can never get plugged in.
//
// The active roster is tried first, then the 40-man. The active roster alone is not
// enough for exactly the case Rotowire is most useful for — a starter making his first
// appearance of the season. A pitcher activated off the 60-day IL is announced by
// Rotowire (and priced by the books) hours before he appears on the MLB active roster,
// so the active-roster-only lookup missed him and the game silently stayed TBD.
// (2026-08-21: Joe Musgrove, SD, 60-day IL, expected vs MIN — card said "Musgrove RW",
// detail panel said TBD.) The 40-man is the narrowest roster that carries 60-day IL
// players; fullRoster would also drag in minor-leaguers and reintroduce collisions
// (SD's fullRoster has both Joe and Tucker Musgrove; its 40-man has only Joe).
// No pitcher match on either roster → null, and the UI correctly stays TBD.
async function resolveRotowirePitcher(team, rwInfo, season) {
  if (team?.probablePitcher?.id) return null;       // StatsAPI already has it
  const rwName = rwInfo?.pitcherFull || rwInfo?.pitcher;
  const teamId = team?.team?.id;
  if (!rwName || !teamId) return null;
  const pitchersOf = roster => (roster || []).filter(r => r.position?.abbreviation === "P");
  let match = null;
  for (const fetchRoster of [getRoster, getRoster40Man]) {
    let roster;
    try { roster = await fetchRoster(teamId, season); } catch { continue; }
    match = matchPitcherByName(rwName, pitchersOf(roster));
    if (match) break;
  }
  return match ? { id: match.person.id, fullName: match.person.fullName, _rwResolved: true } : null;
}

// Module-level cache for batter season stats to avoid re-fetching on re-renders
const _lineupStatsCache = {}; // key: `${playerId}-${season}`

function LineupPanel({ teamId, teamName, teamColor, homeTeamAbbrev, pitcherId, pitcherName, season, lineupPlayers, babyBumpIds = new Set(), onSelectBatter }) {
  const [roster, setRoster] = useState(null);
  const [bioFlags, setBioFlags] = useState({});
  const [batterStats, setBatterStats] = useState({}); // playerId → { avg, homeRuns, rbi, stolenBases, hits, atBats }
  useEffect(() => { setRoster(null); setBioFlags({}); setBatterStats({}); getRoster(teamId, season).then(setRoster); }, [teamId, season]);

  // Batch-fetch bios once roster loads
  useEffect(() => {
    if (!roster) return;
    const players = roster.filter(p => p.status?.code === "A" && p.position?.type !== "Pitcher");
    const today = getTodayInAppTimeZone();
    Promise.all(players.map(async p => {
      const bio = await getPlayerBio(p.person.id);
      const flags = computePlayerFlags({ bio, homeAvg: null, awayAvg: null, parkAbbrev: homeTeamAbbrev, today });
      if (babyBumpIds.has(p.person.id)) flags.babyBump = true;
      return [p.person.id, flags];
    })).then(entries => setBioFlags(Object.fromEntries(entries)));
  }, [roster, homeTeamAbbrev]); // eslint-disable-line react-hooks/exhaustive-deps

  // Batch-fetch season stats (with module-level cache to survive re-renders)
  useEffect(() => {
    if (!roster) return;
    const players = roster.filter(p => p.status?.code === "A" && p.position?.type !== "Pitcher");
    Promise.all(players.map(async p => {
      const cacheKey = `${p.person.id}-${season}`;
      if (_lineupStatsCache[cacheKey]) return [p.person.id, _lineupStatsCache[cacheKey]];
      const st = await getSeasonStats(p.person.id, season);
      const result = st && (st.hits != null || st.avg != null) ? {
        avg: st.avg ? parseFloat(st.avg).toFixed(3) : null,
        hr:  st.homeRuns ?? null,
        rbi: st.rbi ?? null,
        sb:  st.stolenBases ?? null,
        h:   st.hits ?? null,
        ab:  st.atBats ?? null,
      } : null;
      _lineupStatsCache[cacheKey] = result;
      return [p.person.id, result];
    })).then(entries => setBatterStats(Object.fromEntries(entries)));
  }, [roster, season]);

  if (!roster) return <Loader text={`Loading ${teamName} roster...`} />;

  const hasLineup = lineupPlayers?.batters?.length > 0;
  const POS_ORDER = { C:1,"1B":2,"2B":3,"3B":4,SS:5,LF:6,CF:7,RF:8,DH:9 };

  // Build roster lookups: by full normalized name AND by last name
  const rosterByNorm = {};
  const rosterByLast = {};
  roster.forEach(p => {
    const norm = _normName(p.person.fullName);
    rosterByNorm[norm] = p;
    const last = norm.split(" ").pop();
    if (last && !rosterByLast[last]) rosterByLast[last] = p;
  });

  const findRosterPlayer = (rwName) => {
    const norm = _normName(rwName);
    if (rosterByNorm[norm]) return rosterByNorm[norm];
    const last = norm.split(" ").pop();
    return rosterByLast[last] || null;
  };

  const PlayerRow = ({ rosterPlayer, lineupOrder, lineupPos, lineupBats, fallbackName, isLineupPlayer = false, lineupConfirmed = false }) => {
    const p = rosterPlayer;
    const flags = p ? bioFlags[p.person.id] : null;
    const pos = lineupPos || p?.position?.abbreviation || "?";
    const jerseyNum = p?.jerseyNumber;
    const displayName = p?.person.fullName || fallbackName || "Unknown";
    const st = p ? batterStats[p.person.id] : null;
    const bats = lineupBats || p?.person?.batSide?.code || p?.batSide?.code || null;
    const handColor = bats === "L" ? "#0f8a44" : bats === "S" ? "#6d4fd0" : "#2569d6";

    const btn = (
      <button
        onClick={() => p && onSelectBatter({ ...p.person, position: p.position, jerseyNumber: p.jerseyNumber })}
        style={{
          display: "flex", alignItems: "center", gap: 8, padding: "7px 12px",
          background: "rgba(210,217,236,0.3)", border: "1px solid transparent",
          borderRadius: 8, cursor: p ? "pointer" : "default", textAlign: "left", width: "100%", transition: "all 0.15s",
        }}
        onMouseEnter={e => { if (p) { e.currentTarget.style.background = "rgba(32,98,200,0.128)"; e.currentTarget.style.borderColor = "rgba(32,98,200,0.2)"; } }}
        onMouseLeave={e => { e.currentTarget.style.background = "rgba(210,217,236,0.3)"; e.currentTarget.style.borderColor = "transparent"; }}
      >
        {/* Order number */}
        {lineupOrder != null && (
          <span style={{ fontSize: 11, fontWeight: 700, color: "#6d7c96", minWidth: 16, textAlign: "center", flexShrink: 0 }}>{lineupOrder}</span>
        )}
        {/* Position badge */}
        <span style={{ fontSize: 10, fontWeight: 700, color: teamColor, background: `${teamColor}15`, padding: "2px 5px", borderRadius: 4, minWidth: 26, textAlign: "center", flexShrink: 0 }}>{pos}</span>
        {/* Jersey # — left of name */}
        {jerseyNum && (
          <span style={{ fontSize: 10, color: "#8b99b0", minWidth: 24, flexShrink: 0 }}>#{jerseyNum}</span>
        )}
        {/* Batting hand */}
        {bats && (
          <span style={{ fontSize: 9, fontWeight: 700, color: handColor, background: `${handColor}1a`, padding: "2px 4px", borderRadius: 3, minWidth: 16, textAlign: "center", flexShrink: 0 }}>{bats}</span>
        )}
        {/* Player name + flags */}
        <span style={{ fontSize: 13, color: "#3c4f6d", fontWeight: 500, flexShrink: 0 }}>
          {displayName}{flags && <PlayerFlagBadges flags={flags} size={12} />}
        </span>
        {isLineupPlayer && (lineupConfirmed
          ? <span style={{ fontSize: 10, flexShrink: 0 }}>⭐</span>
          : <span style={{ fontSize: 8, color: "#a16207", background: "rgba(161,98,7,0.1)", padding: "1px 4px", borderRadius: 3, fontWeight: 700, flexShrink: 0 }}>PROJ</span>
        )}
        {/* Season stats — inline, fills remaining space */}
        {st && (
          <div style={{ display: "flex", gap: 8, marginLeft: 4, flex: 1, flexWrap: "nowrap", alignItems: "center", overflow: "hidden" }}>
            {[
              { lbl: "AVG", val: st.avg != null ? st.avg : null },
              { lbl: "HR",  val: st.hr  != null ? st.hr  : null },
              { lbl: "RBI", val: st.rbi != null ? st.rbi : null },
              { lbl: "SB",  val: st.sb  != null ? st.sb  : null },
              { lbl: "H/AB",val: st.h != null && st.ab != null ? `${st.h}/${st.ab}` : null },
            ].filter(x => x.val != null).map(({ lbl, val }) => (
              <span key={lbl} style={{ fontSize: 10, whiteSpace: "nowrap" }}>
                <span style={{ color: "#b6c5dc", fontSize: 9 }}>{lbl} </span>
                <span style={{ color: "#4c749c", fontFamily: "'JetBrains Mono',monospace", fontWeight: 600 }}>{val}</span>
              </span>
            ))}
          </div>
        )}
        {/* Arrow */}
        {p && <span style={{ fontSize: 11, color: "#2062c8", flexShrink: 0, marginLeft: "auto" }}>→</span>}
      </button>
    );
    return btn;
  };

  if (hasLineup) {
    const { confirmed, batters } = lineupPlayers;
    // Match each lineup player to the roster using normalized name + last-name fallback
    const lineupInOrder = batters.map(lp => ({
      ...lp,
      rosterPlayer: findRosterPlayer(lp.name),
    }));
    // Roster players NOT in the lineup (bench / reserves)
    const lineupNames = new Set(batters.map(lp => _normName(lp.name)));
    const bench = roster
      .filter(p => p.status?.code === "A" && p.position?.type !== "Pitcher" && !lineupNames.has(_normName(p.person.fullName)))
      .sort((a, b) => (POS_ORDER[a.position?.abbreviation]||10) - (POS_ORDER[b.position?.abbreviation]||10));

    return (
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <div style={{ fontSize: 10, color: "#6d7c96", textTransform: "uppercase", letterSpacing: 1.2 }}>
            {confirmed ? "Confirmed Lineup" : "Projected Lineup"}
          </div>
          <span style={{
            fontSize: 8, fontWeight: 700, padding: "2px 5px", borderRadius: 3,
            background: confirmed ? "rgba(15,138,68,0.12)" : "rgba(161,98,7,0.12)",
            color: confirmed ? "#0f8a44" : "#a16207",
          }}>{confirmed ? "CONFIRMED" : "PROJECTED"}</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 2, marginBottom: bench.length ? 16 : 0 }}>
          {lineupInOrder.map((lp, i) => (
            <PlayerRow key={i} rosterPlayer={lp.rosterPlayer} lineupOrder={lp.order} lineupPos={lp.pos} lineupBats={lp.bats} fallbackName={lp.name} isLineupPlayer={true} lineupConfirmed={confirmed} />
          ))}
        </div>
        {bench.length > 0 && (
          <>
            <div style={{ fontSize: 10, color: "#a3b2c9", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6, marginTop: 4, paddingTop: 10, borderTop: "1px solid rgba(32,98,200,0.096)" }}>
              Not in Lineup ({bench.length})
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 2, opacity: 0.55 }}>
              {bench.map(p => <PlayerRow key={p.person.id} rosterPlayer={p} lineupOrder={null} lineupPos={null} lineupBats={null} />)}
            </div>
          </>
        )}
      </div>
    );
  }

  // Fallback: no lineup data yet — roster sorted by position
  const positionPlayers = roster
    .filter(p => p.status?.code === "A" && p.position?.type !== "Pitcher")
    .sort((a, b) => {
      const aProj = getBatterProj(a.person.fullName) ? 0 : 1;
      const bProj = getBatterProj(b.person.fullName) ? 0 : 1;
      if (aProj !== bProj) return aProj - bProj;
      return (POS_ORDER[a.position?.abbreviation]||10) - (POS_ORDER[b.position?.abbreviation]||10);
    });
  return (
    <div>
      <div style={{ fontSize: 10, color: "#6d7c96", textTransform: "uppercase", letterSpacing: 1.2, marginBottom: 8 }}>
        Active Roster — Lineup TBD ({positionPlayers.length})
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {positionPlayers.map(p => <PlayerRow key={p.person.id} rosterPlayer={p} lineupOrder={null} lineupPos={null} lineupBats={null} />)}
      </div>
    </div>
  );
}

function GameCard({ game, isSelected, onClick, lineupData = {} }) {
  const away = game.teams.away, home = game.teams.home;
  const awayColor = getTeamColor(away.team.id)[0], homeColor = getTeamColor(home.team.id)[0];
  const status = game.status?.detailedState || "Scheduled";
  const gameTime = game.gameDate ? new Date(game.gameDate).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true }) : "";

  // Pitcher display: prefer MLB API probablePitcher, fall back to Rotowire lineup pitcher
  function pitcherName(teamSide, teamAbbr) {
    const apiName = teamSide.probablePitcher?.lastName;
    if (apiName) return apiName;
    const rwPitcher = lineupData[teamAbbr]?.pitcher;
    if (rwPitcher) {
      // Extract last name (everything after last space), flag as Rotowire source
      const parts = rwPitcher.trim().split(" ");
      return parts[parts.length - 1];
    }
    return "TBD";
  }

  const awayPitcher = pitcherName(away, away.team.abbreviation);
  const homePitcher = pitcherName(home, home.team.abbreviation);
  const hasRwData = !away.probablePitcher?.lastName && lineupData[away.team.abbreviation]?.pitcher
                 || !home.probablePitcher?.lastName && lineupData[home.team.abbreviation]?.pitcher;

  return (
    <button onClick={onClick} style={{
      display: "flex", flexDirection: "column", padding: "14px 16px",
      background: isSelected ? "rgba(32,98,200,0.16)" : "rgba(210,217,236,0.4)",
      border: isSelected ? "1px solid rgba(32,98,200,0.3)" : "1px solid rgba(32,98,200,0.128)",
      borderRadius: 12, cursor: "pointer", minWidth: 200, flexShrink: 0, transition: "all 0.15s",
    }}
    onMouseEnter={e => { if (!isSelected) e.currentTarget.style.borderColor = "rgba(32,98,200,0.2)"; }}
    onMouseLeave={e => { if (!isSelected) e.currentTarget.style.borderColor = "rgba(32,98,200,0.128)"; }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ width: 4, height: 16, background: awayColor, borderRadius: 2 }} />
          <span style={{ fontSize: 14, fontWeight: 700, color: "#16233c" }}>{away.team.abbreviation}</span>
          {away.leagueRecord && (
            <span style={{ fontSize: 9, color: "#8b99b0", fontFamily: "'JetBrains Mono',monospace" }}>
              {away.leagueRecord.wins}-{away.leagueRecord.losses}
            </span>
          )}
        </div>
        <span style={{ fontSize: 11, color: "#74839d" }}>{status === "Final" ? "F" : gameTime}</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ width: 4, height: 16, background: homeColor, borderRadius: 2 }} />
        <span style={{ fontSize: 14, fontWeight: 700, color: "#16233c" }}>{home.team.abbreviation}</span>
        {home.leagueRecord && (
          <span style={{ fontSize: 9, color: "#8b99b0", fontFamily: "'JetBrains Mono',monospace" }}>
            {home.leagueRecord.wins}-{home.leagueRecord.losses}
          </span>
        )}
      </div>
      <div style={{ fontSize: 10, marginTop: 8, display: "flex", gap: 6, alignItems: "center" }}>
        <span style={{ color: awayPitcher === "TBD" ? "#c9d5e8" : "#4e6f9e" }}>{awayPitcher}</span>
        <span style={{ color: "#c9d5e8" }}>vs</span>
        <span style={{ color: homePitcher === "TBD" ? "#c9d5e8" : "#4e6f9e" }}>{homePitcher}</span>
        {hasRwData && <span title="From Rotowire lineup" style={{ fontSize: 8, color: "#8b99b0", marginLeft: 2 }}>RW</span>}
      </div>
    </button>
  );
}

function DatePicker({ value, onChange }) {
  const shift = (days) => {
    const d = new Date(value + "T12:00:00");
    d.setDate(d.getDate() + days);
    onChange(formatDateInTimeZone(d));
  };
  const btnStyle = { background: "rgba(125,182,255,0.12)", border: "1px solid rgba(125,182,255,0.28)", color: "#7db6ff", borderRadius: 6, padding: "6px 10px", cursor: "pointer", fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center", width: 32, height: 32 };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <button onClick={() => shift(-1)} style={btnStyle}>◀</button>
      <input type="date" value={value} onChange={e => onChange(e.target.value)}
        style={{ background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.16)", color: "#eef2f9", borderRadius: 8, padding: "6px 12px", fontSize: 13, fontFamily: "'JetBrains Mono', monospace", cursor: "pointer", colorScheme: "dark" }} />
      <button onClick={() => shift(1)} style={btnStyle}>▶</button>
    </div>
  );
}

function NoGames({ date }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "80px 20px", color: "#74839d" }}>
      <div style={{ fontSize: 48, marginBottom: 16 }}>⚾</div>
      <div style={{ fontSize: 18, fontWeight: 600, color: "#5d6f8b", marginBottom: 8 }}>No Games Found</div>
      <div style={{ fontSize: 13, textAlign: "center", maxWidth: 400 }}>
        No MLB games scheduled for {new Date(date+"T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}.
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════
// ── MAIN APP ──
// ══════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════
// ── PROPS DASHBOARD — Top picks across ALL games ──
// ══════════════════════════════════════════════════════════

// BOARD_CONFIGS, calcConfidence, batterPickUnits, isOfficialPick → src/lib/picks.js

// ── Official pick gate for Ks board ──
// Official play: conf ≥ 8.5 AND signal is directional (both models agree on direction).
// The signal gate already requires xKEdge > 0.3 (over) or < -0.5 (under) from both models,
// so this naturally enforces a minimum edge without the old asymmetric -1.0 under threshold.
// isOfficialKsPick, ksPickDirection, ksPickUnits → src/lib/picks.js

// ── Scan-cache slimming: shrink payload below Vercel's 4.5 MB serverless limit ──
// Sources of bloat in the raw scan result:
//   1. `game` metadata (~5.4 KB) is duplicated across every player + pitcher + byModel pick
//      in the same game. Dedupe to a top-level `games` array keyed by gamePk.
//   2. byModel picks carry `result` which is identical to players[].models[market].
//      Drop it from cache; rehydrate from the players array on load.
//   3. `extraSignals` (wide-capture mining bundle: raw_signals + model_intermediates +
//      game_context, ~55 Savant atoms × 200 batters) was the bloat that pushed the
//      payload past Vercel's 4.5 MB limit, causing the scan-results POST to 413
//      starting 2026-05-28. The cache is consumed only by the cache-first display
//      path — picks-save now captures extraSignals inline via the `_snapshot` sidecar
//      on each pick row, so we can safely strip it from the cached payload.
// Also strip gameLog + re-derivable bio fields. Net: ~5-10 MB → ~1.5-3 MB.
function slimScanResults(results) {
  if (!results) return results;
  const gamesByPk = {};
  const collectGame = (g) => {
    if (g?.gamePk && !gamesByPk[g.gamePk]) gamesByPk[g.gamePk] = g;
  };
  const slimEntity = (e) => {
    if (!e) return e;
    collectGame(e.game);
    const { game, gameLog, birthCity, birthDate, extraSignals, ...rest } = e; // eslint-disable-line no-unused-vars
    return { ...rest, gamePk: e.game?.gamePk ?? e.gamePk };
  };
  const players  = (results.players  || []).map(slimEntity);
  const pitchers = (results.pitchers || []).map(slimEntity);
  const byModel = {};
  for (const [market, picks] of Object.entries(results.byModel || {})) {
    byModel[market] = (picks || []).map(p => {
      collectGame(p.game);
      const { result, game, gameLog, ...rest } = p; // eslint-disable-line no-unused-vars
      return { ...rest, gamePk: p.game?.gamePk ?? p.gamePk };
    });
  }
  return {
    players,
    pitchers,
    byModel,
    games: Object.values(gamesByPk),
    _slim: true,
  };
}

function rehydrateScanResults(results) {
  if (!results || !results._slim) return results;
  const gamesByPk = {};
  for (const g of results.games || []) if (g?.gamePk) gamesByPk[g.gamePk] = g;
  const playerModelsById = {};
  for (const p of results.players || []) {
    if (p.gamePk && gamesByPk[p.gamePk]) p.game = gamesByPk[p.gamePk];
    if (p.playerId) playerModelsById[p.playerId] = p.models;
  }
  for (const p of results.pitchers || []) {
    if (p.gamePk && gamesByPk[p.gamePk]) p.game = gamesByPk[p.gamePk];
  }
  for (const [market, picks] of Object.entries(results.byModel || {})) {
    for (const pick of picks) {
      if (pick.gamePk && gamesByPk[pick.gamePk]) pick.game = gamesByPk[pick.gamePk];
      if (pick.playerId && playerModelsById[pick.playerId]) {
        const modelKey = market === "hits15" ? "hits" : market;
        const m = playerModelsById[pick.playerId][modelKey];
        if (m) pick.result = m;
      }
    }
  }
  return results;
}

// ── Statcast reference bundle for the board tile strips ─────────────────────
// One request for three whole-league reference sets: every batter's last-15-game window
// (folded from the nightly per-day tally cache), plus the batter and pitcher season
// distributions the tiles state percentiles against. All three are day-stable, so this is
// fetched once per session and is independent of the slate scan.
//
// Failure is silent and non-fatal by design: the tiles fall back to slate-relative ranking
// with no window, which is strictly less information but never a broken board. The strip
// says "season only — window unavailable" so the absence is visible rather than implied.
function useStatcastReference(season) {
  const [data, setData] = useState(null);
  useEffect(() => {
    if (!season) return;
    let cancelled = false;
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 20000);
    // Served by api/advanced-stats.js's ?window branch, not its own route — the Hobby plan
    // caps a deployment at 12 Serverless Functions and this project sits exactly on it.
    fetch(`/api/advanced-stats?season=${season}&window=15`, { signal: ctrl.signal })
      .then(r => (r.ok ? r.json() : null))
      .then(j => { if (!cancelled && j && !j.error) setData(j); })
      .catch(() => {})
      .finally(() => clearTimeout(tid));
    return () => { cancelled = true; ctrl.abort(); clearTimeout(tid); };
  }, [season]);
  return data;
}

// ── Preload engine: scans all games once, runs all models, caches results ──
function usePropsScan(games, season, lineupData, oddsData) {
  const [scanData, setScanData] = useState(null); // { players: [], byModel: { hits: [...], hr: [...], ... } }
  const [scanProgress, setScanProgress] = useState({ phase: "idle", done: 0, total: 0, playerName: "" });
  const [scanComplete, setScanComplete] = useState(false);
  const cancelRef = useRef(false);
  const cacheLoadedRef = useRef(false); // true when we loaded from server cache
  // Keep a ref to lineup data so the async pitcher scan always reads the latest
  // value without being a useEffect dependency (avoids re-triggering the full scan).
  const lineupDataRef = useRef(lineupData || {});
  useEffect(() => { lineupDataRef.current = lineupData || {}; }, [lineupData]);
  // Keep a ref to odds data so the async batter scan reads the latest value.
  const oddsDataRef = useRef(oddsData || []);
  useEffect(() => { oddsDataRef.current = oddsData || []; }, [oddsData]);

  // ── Cache-first: try loading today's pre-computed results on mount ───────────
  // The guards, and the two-phase metadata-then-blob fetch they gate, live in
  // src/lib/scanCache.js — the blob is ~5.2 MB and most mounts reject it, so it
  // is not fetched until every guard has already passed.
  useEffect(() => {
    const today = getTodayInAppTimeZone();
    loadCachedScan({ date: today, fetchApiJson, sbGet, savedPicksParams })
      .then(cached => {
        if (!cached) return; // guards said no — browser scan runs
        console.log(`⚡ Loaded ${cached.player_count} players from scan cache (${cached.scanned_at})`);
        // Rehydrate slimmed payload (re-attach game refs + pick.result) before render.
        // No-op on pre-slim caches (returns input unchanged when results._slim is falsy).
        const rehydrated = rehydrateScanResults(cached.results);
        setScanData(rehydrated);
        setScanComplete(true);
        setScanProgress({ phase: "complete", done: cached.player_count, total: cached.player_count, playerName: "" });
        cacheLoadedRef.current = true;
      })
      .catch(() => {}); // silent — browser scan is the fallback
  }, []); // run once on mount

  useEffect(() => {
    // Skip browser scan if we already loaded from cache
    if (cacheLoadedRef.current) return;
    cancelRef.current = false;
    setScanData(null);
    setScanComplete(false);
    if (!games || games.length === 0) { setScanProgress({ phase: "idle", done: 0, total: 0, playerName: "" }); return; }

    setScanProgress({ phase: "Loading rosters...", done: 0, total: games.length * 2, playerName: "" });

    async function scan() {
      // ── Phase 0: probable starters, StatsAPI first and Rotowire second ────────
      // The scan used to read game.teams[side].probablePitcher and nothing else, so a
      // game StatsAPI still had as TBD was scanned with NO opposing starter: no arsenal
      // matchup, no pitcher-quality adjustment, no pitcher hand — every hitter in it
      // scored blind. It also meant that starter never got a Ks row at all. On
      // 2026-08-18 that was the whole CWS @ CHC game (Erick Fedde was Rotowire-only).
      //
      // Resolved HERE, before jobs are built, because oppPitcher feeds every downstream
      // pitcher-dependent term. Lineup data is read from the ref when the app already
      // has it and fetched directly otherwise, so the scan never races the App's own
      // Rotowire fetch — the headless daily driver starts the scan the moment the
      // schedule lands, well before that effect resolves.
      const needsRw = games.some(gm =>
        !gm.teams?.away?.probablePitcher?.id || !gm.teams?.home?.probablePitcher?.id);
      const rwProbableByGame = {};
      if (needsRw) {
        let rwLineups = lineupDataRef.current;
        if (!Object.keys(rwLineups || {}).length) {
          rwLineups = await fetchRotowireLineups().catch(() => ({})) || {};
        }
        await Promise.all(games.map(async gm => {
          const a = gm.teams?.away, h = gm.teams?.home;
          const [away, home] = await Promise.all([
            resolveRotowirePitcher(a, rwLineups?.[a?.team?.abbreviation], season).catch(() => null),
            resolveRotowirePitcher(h, rwLineups?.[h?.team?.abbreviation], season).catch(() => null),
          ]);
          rwProbableByGame[gm.gamePk] = { away, home };
        }));
        const resolved = Object.values(rwProbableByGame)
          .reduce((n, p) => n + (p.away ? 1 : 0) + (p.home ? 1 : 0), 0);
        if (resolved) console.log(`[scan] ${resolved} Rotowire starter(s) resolved for TBD games`);
      }
      const probableOf = (game, side) => game?.teams?.[side]?.probablePitcher?.id
        ? game.teams[side].probablePitcher
        : (rwProbableByGame[game?.gamePk]?.[side] || null);

      // Phase 1: Collect all batter jobs from all games
      const batterJobs = [];
      const teamsSeen = new Set();
      const rosterCache = {};

      for (const game of games) {
        for (const side of ["home", "away"]) {
          const teamData = game.teams[side];
          const oppSide = side === "home" ? "away" : "home";
          const oppPitcher = probableOf(game, oppSide);
          const oppTeam = game.teams[oppSide]?.team;
          const teamId = teamData.team.id;
          const teamAbbrev = teamData.team.abbreviation;

          if (!teamsSeen.has(teamId)) {
            teamsSeen.add(teamId);
            try {
              const roster = await getRoster(teamId, season);
              rosterCache[teamId] = roster;
            } catch { rosterCache[teamId] = []; }
          }

          const roster = rosterCache[teamId] || [];
          const batters = roster.filter(p => p.status?.code === "A" && p.position?.type !== "Pitcher");

          for (const player of batters) {
            const batterProj = getBatterProj(player.person.fullName, teamAbbrev);
            if (!batterProj) continue;
            batterJobs.push({
              player, batterProj, teamData, teamAbbrev,
              oppPitcher, oppTeam, game, side,
              pitcherProj: oppPitcher ? getPitcherProj(oppPitcher.fullName, oppTeam?.abbreviation) : null,
            });
          }
        }
        if (cancelRef.current) return;
      }

      setScanProgress({ phase: "Scanning batters...", done: 0, total: batterJobs.length, playerName: "" });

      // Pre-fetch advanced stats + catcher pop times + umpire data BEFORE starting scans.
      // advPitchers is used inside the pitcher scan closure — fetching it first avoids
      // a temporal dead zone ReferenceError when pitcher API calls resolve faster than
      // fetchAdvancedStatsBulk, which would silently null out all pitcher results.
      const scanDate = getTodayInAppTimeZone();
      const [catcherPopTimesLive, advancedStatsMaps, gameUmpires, umpireSeasonStats, runningGameDb, pitchlab] = await Promise.all([
        getCatcherPopTimesMap(season),
        fetchAdvancedStatsBulk(season),
        fetchGameUmpires(scanDate),           // MLB Stats API: HP ump per gamePk
        fetchUmpireSeasonStats(season),       // UmpScorecards: season K%/BB% per umpire
        fetchRunningGameBulk(season),         // DB fallback for catcher/pitcher/runner SB signals
        // Pitch Lab morning scores (src/lib/pitchlab.js). null when the job has not run:
        // every model then falls back to its legacy path, so the scan never depends on it.
        loadPitchlab(scanDate),
      ]);
      const advBatters  = advancedStatsMaps.batters;   // mlbam_id → batter advanced stats
      const advPitchers = advancedStatsMaps.pitchers;  // mlbam_id → pitcher advanced stats
      // Live Savant CSV is primary; fall back to the DB snapshot when it returns nothing.
      const catcherPopTimes = Object.keys(catcherPopTimesLive).length ? catcherPopTimesLive : runningGameDb.catcherByTeam;

      // Kick off pitcher scan in parallel with batter processing
      const pitcherScanPromise = (async () => {
        const pitchersSeen = new Set();
        const pJobs = [];
        for (const game of games) {
          for (const side of ["home", "away"]) {
            // Same Rotowire fallback as the batter jobs — without it a RW-only starter
            // produced no Ks row whatsoever, so the market simply lost that game.
            const pitcher = probableOf(game, side);
            if (!pitcher?.id || pitchersSeen.has(pitcher.id)) continue;
            pitchersSeen.add(pitcher.id);
            const oppSide = side === "home" ? "away" : "home";
            pJobs.push({
              pitcher, isHome: side === "home",
              teamAbbrev: game.teams[side]?.team?.abbreviation,
              oppTeam: game.teams[oppSide]?.team,
              homeAbbrev: game.teams.home?.team?.abbreviation,
              game,
            });
          }
        }
        const results = await Promise.all(pJobs.map(async (job) => {
          if (cancelRef.current) return null;
          try {
            const stats = await getPitcherKData(job.pitcher.id, season);
            const hand  = stats?.info?.pitchHand?.code || "R";
            const oppAbbrev = job.oppTeam?.abbreviation;
            const [arsenal, splits, oppKRate, discipline, savantArsenal, lineupKProfile] = await Promise.all([
              getPitchArsenal(job.pitcher.id, season),
              getSplits(job.pitcher.id, "h,a", season, "pitching"),
              getOppTeamKRate(job.oppTeam?.id, season, hand),
              getPlateDiscipline(job.pitcher.id, season, "pitcher"),
              getStatcastArsenal(job.pitcher.id, season),
              computeLineupKProfile(
                lineupDataRef.current[oppAbbrev]?.batters || [],
                job.oppTeam?.id, season, rosterCache
              ),
            ]);
            // Arsenal K mult: pitcher usage × (batter kPct 55% + batter whiff% 45%) vs each pitch type.
            // kPct captures actual K outcomes; whiff% captures swing-and-miss vulnerability independent
            // of count situation. Both weighted by how heavily the pitcher throws that pitch.
            if (lineupKProfile?.vsPitchProfiles?.length && savantArsenal) {
              const LEAGUE_BK = 22.0;  // batter K% vs pitch type league avg
              const LEAGUE_BW = 24.0;  // batter whiff% vs pitch type league avg
              let matchupSum = 0, wTot = 0;
              for (const [pt, pd] of Object.entries(savantArsenal)) {
                if (!pd.usage || pd.usage < 5) continue;
                let kSum = 0, whiffSum = 0, kCnt = 0, whiffCnt = 0;
                for (const bp of lineupKProfile.vsPitchProfiles) {
                  const bvp = bp.vsPitch?.[pt];
                  if (bvp?.pa >= 3) {
                    if (bvp.kPct  != null) { kSum     += bvp.kPct;  kCnt++;     }
                    if (bvp.whiff != null) { whiffSum += bvp.whiff; whiffCnt++; }
                  }
                }
                const kDelta    = kCnt     > 0 ? (kSum     / kCnt     - LEAGUE_BK) / LEAGUE_BK * 0.55 : 0;
                const whiffDelta = whiffCnt > 0 ? (whiffSum / whiffCnt - LEAGUE_BW) / LEAGUE_BW * 0.45 : 0;
                matchupSum += (kDelta + whiffDelta) * pd.usage;
                wTot += pd.usage;
              }
              lineupKProfile.arsenalKMult = wTot > 0
                ? Math.min(1.18, Math.max(0.88, 1.0 + matchupSum / wTot))
                : 1.0;
            }
            const proj = getPitcherProj(job.pitcher.fullName);
            const pitAdvStats = advPitchers[job.pitcher.id] || null;
            // Pitcher Savant batted-ball / contact-quality / extension / arm-angle profile.
            // Used by modelPitcherKv2 for the extension perceived-velo bonus (M1 atom).
            const _pitBase = await getPitcherStatcast(job.pitcher.id, season).catch(() => null);
            const _pitAA   = await getPitcherArmAngles(job.pitcher.id, season).catch(() => null);
            const pitStatcast = _pitBase ? {
              ..._pitBase,
              armAngle: _pitAA?.ballAngle ?? null,
              pitcherHand: hand,
            } : null;
            // Umpire: build mult from pre-fetched HP ump assignment + season stats
            const umpInfo = buildUmpireInfo(job.game.gamePk, gameUmpires, umpireSeasonStats);
            const umpMult = umpInfo?.mult ?? 1.0;
            // Rest days: compute from game log (starts only, IP ≥ 2)
            const restDays = computeRestDays(stats?.gameLog, scanDate);
            const kModels = modelPitcherKv2({
              proj, seasonStats: stats?.season, careerStats: stats?.career,
              gameLog: stats?.gameLog, arsenal, pitcherKSplits: splits,
              oppKRate, isHome: job.isHome, parkAbbrev: job.homeAbbrev, hand,
              discipline, savantArsenal, lineupKProfile,
              advancedStats: pitAdvStats,   // FanGraphs: SIERA, FIP, xFIP, K-BB%, CSW%, Stf+, Loc+, Pit+
              pitStatcast,                  // Savant: extension, batted-ball, contact-quality, arm angle
              umpireMult: umpMult,          // HP umpire K tendency (0.88–1.15)
              restDays,                    // days since last start — affects stuff + IP projection
            });
            // Pitch Lab K model (post-mortem 02: MAE 1.80 vs 1.98 live on the Sept holdout, openers
            // 1.96 vs 3.63) replaces xK when the morning job scored this starter. The legacy
            // projection is kept as xKLegacy; kEdge (the second model in ksSignalVsLine) stays.
            // The full P(K ≥ k) ladder rides along so saved picks carry the model's own probability.
            const plRow = pitchlab?.pitchers?.[String(job.pitcher.id)] ?? null;
            if (plRow?.ks?.mu != null) {
              kModels.xKLegacy = kModels.xK;
              kModels.xK = plRow.ks.mu;
              kModels.kLadder = plRow.ks.ge;
              kModels.kLadderRaw = plRow.ks.ge_raw;
            }
            const line = Math.floor(kModels.xK) + 0.5;
            const xKEdge    = kModels.xK    - line;
            const kEdgeEdge = kModels.kEdge - line;
            const signal = xKEdge > 0.3 && kEdgeEdge > 0.3 ? "over"
                         : xKEdge < -0.3 && kEdgeEdge < -0.3 ? "under" : "neutral";
            const conf = calcKConfidence({ ...kModels, xKEdge });
            const _kgl = stats?.gameLog || [];
            const _kthresh = line;
            const ss = stats?.season || {};

            // Wide-capture bundle for pitcher K picks (Layer 1 — see migration 002).
            const extraSignalsKs = {
              raw_signals: {
                pitcher_arsenal:      savantArsenal,
                pitcher_statcast:     pitStatcast,
                pitcher_running_game: null,  // not fetched in pitcher path
                lineup_k_profile:     lineupKProfile,
                discipline:           discipline,
                arsenal_splits:       arsenal,
              },
              model_intermediates: kModels,  // every Mx atom (M1..M8) + composites
              game_context: {
                park_abbrev:    job.homeAbbrev,
                venue:          job.game.venue?.name,
                is_home:        job.isHome,
                opp_team:       job.oppTeam?.abbreviation,
                opp_team_id:    job.oppTeam?.id,
                opp_k_rate:     oppKRate,
                umpire:         umpInfo,
                rest_days:      restDays,
                game_pk:        job.game.gamePk,
                game_date:      job.game.gameDate,
              },
            };

            return {
              pitcherId: job.pitcher.id, name: job.pitcher.fullName,
              team: job.teamAbbrev, hand,
              opponent: job.oppTeam?.abbreviation || "?",
              isHome: job.isHome, gamePk: job.game.gamePk,
              venue: job.game.venue?.name || "",
              parkAbbrev: job.homeAbbrev, proj, game: job.game,
              // Season stats for display
              seasonW:  parseInt(ss.wins)             || 0,
              seasonL:  parseInt(ss.losses)           || 0,
              seasonSO: parseInt(ss.strikeOuts)       || 0,
              // DISPLAY ONLY, and deliberately left in raw MLB notation: KsBoard renders
              // it as `${seasonIP.toFixed(1)}IP`, where 34.2 is the correct baseball
              // reading and the converted 34.667 would print an impossible "34.7IP".
              // modelPitcherKv2 does NOT use this — it derives its own innings through
              // ipToDec (src/lib/innings.js). Anything computing a RATE from this field
              // (it is captured into pick_signals) must call ipToDec on it first.
              seasonIP: parseFloat(ss.inningsPitched) || 0,
              seasonGS: parseInt(ss.gamesStarted)     || 0,
              ...kModels, line, xKEdge, kEdgeEdge, signal, conf,
              // Pitch Lab outs / hits / walks / ER ladders + raw-score gates → enrichScanData
              // prices them against the book lines (PITCHER_PROPS in src/lib/pitchlab.js).
              pitchlabProps: plRow ? { outs: plRow.outs, h: plRow.h, bb: plRow.bb, er: plRow.er, gates: pitchlab.gates } : null,
              advancedStats: pitAdvStats,  // pass through for PitcherPanel display
              umpireInfo: umpInfo,         // { name, mult, k_pct, bb_pct } for display
              restDays,                    // days of rest for display
              extraSignals: extraSignalsKs, // wide-capture bundle (Layer 1)
              rateL5:  computeRateSeries(_kgl, 'ks', _kthresh, 5),
              rateL10: computeRateSeries(_kgl, 'ks', _kthresh, 10),
              rateL20: computeRateSeries(_kgl, 'ks', _kthresh, 20),
              drought: computeDrought(_kgl, 'ks', _kthresh),
            };
          } catch { return null; }
        }));
        return results.filter(Boolean);
      })();

      // Phase 2: Fetch stats + run all models for each batter
      const allResults = [];
      let scanFailCount = 0;

      // Pre-fetch opp-bullpen vectors once for the whole scan (Stage-1 capture, HRR/RBI/TB only).
      // Slate teams only (faster than all-30). Failure → empty map; capture is non-blocking.
      const slateOppTeams = {};
      for (const j of batterJobs) {
        const abbr = j.oppTeam?.abbreviation;
        const id = j.oppTeam?.id;
        if (abbr && id && !slateOppTeams[abbr]) slateOppTeams[abbr] = id;
      }
      const bullpenByTeam = await fetchBullpenVectorsForScan(slateOppTeams, season);

      const BATCH_SIZE = 4;
      for (let i = 0; i < batterJobs.length; i += BATCH_SIZE) {
        if (cancelRef.current) return;
        const batch = batterJobs.slice(i, i + BATCH_SIZE);

        const batchResults = await Promise.all(batch.map(async (job) => {
          try {
            const pitcherId = job.oppPitcher?.id || null;

            const [gl, ss, bio, splitsRaw, pitcherBio,
                   batterPitchData, pitcherArsenal, batDiscipline,
                   batPowerStats, batSprintStats, batBaserunning,
                   batExpectedStats, batBattedBall, batSwingTake,
                   batBasestealingRVLive, pitcherRunningGameLive,
                   batHomeRunStats, batAttackAngle, oppBullpenHold] = await Promise.all([
              getGameLog(job.player.person.id, season),
              getSeasonStats(job.player.person.id, season),
              getPlayerBio(job.player.person.id),
              getSplits(job.player.person.id, "vl,vr,h,a,risp", season),
              pitcherId ? fetchJson(`${API}/people/${pitcherId}`).catch(() => null) : Promise.resolve(null),
              getStatcastBatterVsPitch(job.player.person.id, season),
              pitcherId ? getStatcastArsenal(pitcherId, season) : Promise.resolve({}),
              getPlateDiscipline(job.player.person.id, season, "batter"),
              // Savant power profile: barrel%, hard_hit%, exit_velo, launch_angle, xBA, batSpeed
              getBatterPowerStats(job.player.person.id, season),
              // Savant sprint speed (ft/s) + hp_to_1b (90-ft home-to-first) + bolts — SB inputs
              getBatterSprintStats(job.player.person.id, season),
              // Savant running splits: first_to_third%, extra_base%, br_runs_above_avg
              getBatterBaserunning(job.player.person.id, season),
              // Expected statistics (xBA/xwOBA diffs — luck/regression signal)
              getExpectedStats(job.player.person.id, season, "batter"),
              // Batted ball profile (GB%, pull_air_rate — HR corridor signal)
              getBattedBall(job.player.person.id, season),
              // Swing-take zone run values (chase discipline → hits signal)
              getSwingTake(job.player.person.id, season, "Batter"),
              // Basestealing run value (runner aggressiveness → SB signal)
              getBasestealingRunValue(job.player.person.id, season),
              // Pitcher running game (how well pitcher holds runners → SB signal)
              pitcherId ? getPitcherRunningGame(pitcherId, season) : Promise.resolve(null),
              // xHR vs actual HR (luck regression signal for HR model)
              getHomeRunStats(job.player.person.id, season, "batter"),
              // Swing path attack angle (ideal launch angle zone rate → HR/TB signal)
              getSwingPathAttackAngle(job.player.person.id, season),
              // Opposing BULLPEN hold aggregate (relievers throw the late steal-prone innings the
              // starter's numbers miss) — cached league-wide, so this is a Map hit per batter.
              getTeamBullpenHold(job.oppTeam?.abbreviation, season),
            ]);

            // SB running-game signals: live Savant CSV is primary; DB snapshot is the fallback.
            const batBasestealingRV = batBasestealingRVLive ?? runningGameDb.batters[job.player.person.id] ?? null;
            const pitcherRunningGame = pitcherRunningGameLive ?? (pitcherId ? runningGameDb.pitchers[pitcherId] : null) ?? null;

            // Parse pitcher hand for correct handedness split
            const pitcherHand = pitcherBio?.people?.[0]?.pitchHand?.code || "R";
            const handCode = pitcherHand === "L" ? "vl" : "vr";

            // Pitcher Savant batted-ball / quality-of-contact / extension / arm-angle profile.
            // _getPitcherStatcastCsv caches the CSV per season, so this is effectively a
            // single global fetch shared by every batter in the slate.
            const _pitStatcastBase = pitcherId ? await getPitcherStatcast(pitcherId, season) : null;
            const _pitArmAngle = pitcherId
              ? await getPitcherArmAngles(pitcherId, season).catch(() => null)
              : null;
            const pitStatcast = _pitStatcastBase ? {
              ..._pitStatcastBase,
              armAngle: _pitArmAngle?.ballAngle ?? null,
              pitcherHand,
            } : null;

            // Parse splits into model-ready object
            const handSplit = splitsRaw?.find(s => s.split?.code === handCode)?.stat || {};
            const homeSplit = splitsRaw?.find(s => s.split?.description === "Home Games")?.stat || {};
            const awaySplit = splitsRaw?.find(s => s.split?.description === "Away Games")?.stat || {};
            const haSplit   = job.side === "home" ? homeSplit : awaySplit;
            const rispSplit = splitsRaw?.find(s => s.split?.code === "risp" || s.split?.description?.toLowerCase().includes("scoring position"))?.stat || null;

            // Compute pitch-type arsenal matchup (xwOBA-based, batter models)
            const arsenalMatchup = computeArsenalMatchup(batterPitchData, pitcherArsenal);
            // K vulnerability: batter K rate vs pitcher's specific pitch types weighted by usage
            const kVuln = computeBatterKVulnerability(batterPitchData, pitcherArsenal);

            // Pull advanced stats from pre-fetched bulk maps
            const batAdvStats = advBatters[job.player.person.id] || null;
            // Pitcher DB advanced stats (Pit+, k_bb_pct, SIERA, FB velo) — keyed by oppPitcher id
            const pitAdvStats = pitcherId ? (advPitchers[pitcherId] || null) : null;

            // Game O/U total: extracted from odds data → signals run-scoring environment
            const gameOdds = getGameOdds(
              oddsDataRef.current,
              job.game.teams?.away?.team?.name,
              job.game.teams?.home?.team?.name
            );
            const gameTotal = gameOdds?.gameTotal ?? null;

            // Lineup batting order: look up by player name in lineupDataRef for this team
            const teamLineup = lineupDataRef.current[job.teamAbbrev]?.batters || [];
            const normPlayerName = (s) => (s || "").toLowerCase().replace(/[^a-z]/g, "");
            const playerNorm = normPlayerName(job.player.person.fullName);
            const lineupSlot = teamLineup.find(b => normPlayerName(b.name) === playerNorm);
            const lineupOrder = lineupSlot?.order ?? null;

            // OBPs of confirmed batters ahead in the lineup — feeds RBI RISP opportunity model.
            // Uses projection data (h+bb)/(ab+bb) as a proxy; falls back to league avg 0.315.
            const predecessorOBPs = lineupOrder != null && lineupOrder > 1
              ? teamLineup
                  .filter(b => b.order != null && b.order < lineupOrder)
                  .map(b => {
                    const p = findProjection(b.name, job.teamAbbrev, PROJ_BATTERS);
                    if (p) {
                      const h = p.h || 0, bb = p.bb || 0, ab = Math.max(p.ab || 550, 1);
                      return (h + bb) / (ab + bb);
                    }
                    return 0.315;
                  })
              : null;

            // Pull% × park short wall: adjusts HR projection for extreme pull hitters at band-box parks
            const park = getParkData(job.game.venue?.name, job.game.teams?.home?.team?.abbreviation);
            const hand = job.player.person?.batSide?.code || null;
            const pullParkMult = computePullParkMult(batAdvStats?.pull_pct ?? null, hand, park);

            const inputs = {
              proj: job.batterProj, seasonStats: ss, recentGames: gl, bvpStats: null,
              splits: {
                handedness: handSplit,
                homeAway: haSplit,
                dayNight: {},
                isHome: job.side === "home",
                risp: rispSplit,
              },
              pitcherProj: job.pitcherProj,
              arsenalMatchup,
              batterDiscipline: batDiscipline,
              powerStats: batPowerStats,       // barrel%, hard_hit%, exit_velo, launch_angle, xBA, xwoba, batSpeed
              sprintSpeed: batSprintStats?.speed ?? null,  // ft/s from Savant sprint speed leaderboard
              sbSprintStats: batSprintStats,   // { speed, hp1b (90-ft home-to-1B), bolts } — capture-only atoms
              baserunningData: batBaserunning, // XB attempt/safe rates + runner runs (+lgAvg)
              basestealingData: batBasestealingRV,   // SB-1 fix: pass into modelSB inputs (was post-hoc extMult)
              pitcherRunningGame,              // SB-1 fix: pass into modelSB inputs (was post-hoc extMult)
              pitcherHand,                     // L/R → LHP hold prior in computePitcherHoldingMult
              oppBullpenHold,                  // team reliever hold aggregate (capture-first atom)
              kVuln,                           // K vulnerability vs this pitcher's arsenal
              catcherData: computeCatcherMult(catcherPopTimes[job.oppTeam?.abbreviation?.toUpperCase()] || null),
              advancedStats: batAdvStats,      // FanGraphs + Savant DB: wRC+, ISO, BABIP, HR/FB%, xSLG, sprint_speed, etc.
              pitAdvStats,                     // opposing pitcher DB stats: pit_plus, k_bb_pct, siera, fastball_velo
              pitStatcast,                     // Savant pitcher: GB/FB/PU%, barrel%, solid/weak/topped/under%, extension, arm angle (+ lgAvg)
              gameTotal,                       // O/U game total from odds → environment signal
              lineupOrder,                     // batting order slot → PA opportunity adjustment
              predecessorOBPs,                 // OBPs of batters ahead in lineup → RISP frequency model
              pullParkMult,                    // pull% × park wall proximity → HR adjustment
            };

            const hrResult = modelHR(inputs);
            const models = {
              hits: modelHits(inputs), hr: hrResult,
              sb: modelSB(inputs),
              tb: modelTB({ ...inputs, pitchlab: pitchlab?.batters?.[String(job.player.person.id)] ?? null }),
              hrr: modelHRR(inputs),
              // impliedProb05Raw: keep RBI's hrBoost on the pure calibration so the
              // 2026-07-05 panel blend can't shift RBI's score-space gates.
              rbi: computeRBIModel({ ...inputs, hrImpliedProb: hrResult?.impliedProb05Raw ?? hrResult?.impliedProb05 ?? 0 }),
            };

            // Stage-1 bullpen capture: stamp opp-pen vector + lineupOrder onto HRR/RBI/TB
            // model outputs so pick_signals snapshots them. NOT a model input yet — purely
            // for forward data collection (HRR is the validated target; RBI/TB are
            // secondary "watch" markets). See memory/project_bullpen_mining_2026-05-29.md.
            const oppBullpen = bullpenByTeam[job.oppTeam?.abbreviation] || null;
            for (const mk of ['hrr', 'rbi', 'tb']) {
              const m = models[mk];
              if (m && !m.skip) {
                if (oppBullpen) m.bullpen = oppBullpen;
                if (lineupOrder != null) m.lineupOrder = lineupOrder;
              }
            }

            // Apply park multipliers + extended Savant signals
            const modelKeyMap = PARK_MODEL_BY_MARKET;   // was missing `hrr` — see weather.js
            for (const [k, result] of Object.entries(models)) {
              if (!result || result.skip) continue;
              // Pitch Lab TB already carries park, weather and swing shape, and its score is mapped
              // straight onto the board's scoring scale (models.js tbScoreFromProb) — no multipliers.
              if (k === 'tb' && result.pitchlabTB) { result.parkMult = 1; result.adjScore = result.score; continue; }
              result.parkMult = parkWeatherMult(park, null, hand, modelKeyMap[k]);
              if (result.score != null) {
                result.adjScore = result.score * result.parkMult;
                if (k === 'hr') result.adjScore = Math.min(result.adjScore, 0.085);
              }
              // Extended Savant signals on top of park mult
              let extMult = 1.0;
              if (k === 'hits') {
                const lm = computeExpectedStatsLuck(batExpectedStats?.xbaDiff, null, 'H');
                if (lm !== 1.0) { result.luckMult = lm; extMult *= lm; }
                // swing-take multiplier REMOVED 2026-07-29 — see models.js:170.
                // This is the pick-WRITING copy; the panel copy is at ~line 4961.
              }
              if (k === 'tb') {
                const lm = computeExpectedStatsLuck(null, batExpectedStats?.xwobaDiff, 'TB');
                if (lm !== 1.0) { result.luckMult = lm; extMult *= lm; }
                const aam = computeAttackAngleMult(batAttackAngle, 'TB');
                if (aam !== 1.0) { result.attackAngleMult = aam; extMult *= aam; }
              }
              if (k === 'hr') {
                const bm = computeBattedBallHRMult(batBattedBall);
                if (bm !== 1.0) { result.battedBallMult = bm; extMult *= bm; }
                const hlm = computeHRLuckMult(batHomeRunStats);
                if (hlm !== 1.0) { result.hrLuckMult = hlm; extMult *= hlm; }
                const aam = computeAttackAngleMult(batAttackAngle, 'HR');
                if (aam !== 1.0) { result.attackAngleMult = aam; extMult *= aam; }
              }
              // SB: basestealingMult + pitcherHoldingMult moved INTO modelSB inputs (SB-1 fix).
              // No post-hoc extMult here — the model now applies them pre-gate so over05 evaluates correctly.
              if (k === 'hrr') {
                const lm = computeExpectedStatsLuck(batExpectedStats?.xbaDiff, batExpectedStats?.xwobaDiff, 'HRR');
                if (lm !== 1.0) { result.luckMult = lm; extMult *= lm; }
                // Attack angle: level only, no signal — see models.js attackAngleLevelHRR.
                extMult *= attackAngleLevelHRR(batAttackAngle);
              }
              if (extMult !== 1.0 && result.adjScore != null) {
                result.adjScore = result.adjScore * extMult;
                if (k === 'hr') result.adjScore = Math.min(result.adjScore, 0.085);
                result.extMult = extMult;
              }
            }

            // Compute personal flags (use already-parsed splits)
            const homeHA = homeSplit;
            const awayHA = awaySplit;
            const homeAbbrev = job.game.teams?.home?.team?.abbreviation;
            const flags = computePlayerFlags({
              bio,
              homeAvg: homeHA?.avg ? parseFloat(homeHA.avg) : null,
              awayAvg: awayHA?.avg ? parseFloat(awayHA.avg) : null,
              parkAbbrev: homeAbbrev,
              today: getTodayInAppTimeZone(),
            });

            // ── Wide-capture bundles for the mining substrate ─────────────────
            // Curated atoms already flow via extractRawSignals into the model's
            // return object (= pick_signals.signals). This block captures the
            // FULL raw Savant fetcher payloads + every model intermediate + the
            // full game context, so future mining can ask questions we haven't
            // curated for. picks.js reads `extraSignals` and writes to the JSONB
            // columns added in migration 002.
            const oppPenVec = bullpenByTeam[job.oppTeam?.abbreviation] || null;
            const extraSignals = {
              raw_signals: {
                pitcher_arsenal:      pitcherArsenal,
                pitcher_statcast:     pitStatcast,
                pitcher_running_game: pitcherRunningGame,
                batter_pitch_data:    batterPitchData,
                batter_power_stats:   batPowerStats,
                batter_baserunning:   batBaserunning,
                batter_sprint_speed:  batSprintStats?.speed ?? null,
                batter_swing_take:    batSwingTake,
                batter_batted_ball:   batBattedBall,
                batter_attack_angle:  batAttackAngle,
                batter_home_run_stats: batHomeRunStats,
                batter_expected_stats: batExpectedStats,
                batter_basestealing_rv: batBasestealingRV,
                bullpen_vector:       oppPenVec,
                catcher_pop_time:     catcherPopTimes[job.oppTeam?.abbreviation?.toUpperCase()] || null,
                splits_handedness:    handSplit,
                splits_homeaway:      haSplit,
                splits_risp:          rispSplit,
                arsenal_matchup:      arsenalMatchup,
                k_vuln:               kVuln,
              },
              // models already carries every Adj/Mult (named return fields). We
              // store it in model_intermediates for mining queries keyed by model
              // name (parallel to signals which is flattened per market in picks.js).
              model_intermediates: models,
              game_context: {
                park_abbrev:      job.homeAbbrev,
                venue:            job.game.venue?.name,
                is_home:          job.side === "home",
                game_total:       gameTotal,
                lineup_order:     lineupOrder,
                predecessor_obps: predecessorOBPs,
                pull_park_mult:   pullParkMult,
                opp_team:         job.oppTeam?.abbreviation,
                opp_pitcher_id:   job.oppPitcher?.id,
                opp_pitcher_hand: pitcherHand,
                game_pk:          job.game.gamePk,
                game_date:        job.game.gameDate,
              },
            };

            return {
              name: job.player.person.fullName,
              playerId: job.player.person.id,
              team: job.teamAbbrev,
              teamId: job.teamData.team.id,
              position: job.player.position?.abbreviation || "?",
              batSide: job.player.person?.batSide?.code || null,
              opponent: job.oppTeam?.abbreviation || "?",
              oppPitcher: job.oppPitcher?.fullName || "TBD",
              oppPitcherId: job.oppPitcher?.id || null,
              oppPitcherHand: pitcherHand,
              venue: job.game.venue?.name || "",
              game: job.game,
              isHome: job.side === "home",
              flags,
              lineupOrder,                          // batting slot 1-9 → retro mining substrate
              birthDate: bio?.birthDate || null,   // stored so TodayBoard can re-check at render time
              birthCity: bio?.birthCity || null,
              models,
              extraSignals,                 // wide-capture bundles for mining substrate (Layer 1)
              gameLog: gl,
              advancedStats: batAdvStats,  // FanGraphs + Savant DB metrics for BatterPanel display
              // Current season stats for display in boards
              seasonAvg: ss?.avg ? parseFloat(ss.avg) : null,
              seasonH:   parseInt(ss?.hits)         || 0,
              seasonAB:  parseInt(ss?.atBats)        || 0,
              seasonHR:  parseInt(ss?.homeRuns)      || 0,
              seasonRBI: parseInt(ss?.rbi)           || 0,
              seasonSB:  parseInt(ss?.stolenBases)   || 0,
            };
          } catch (e) { console.error("⚾ scan fail:", job.player.person.fullName, e?.message || e); return null; }
        }));

        for (const r of batchResults) {
          if (r) allResults.push(r);
          else scanFailCount++;
        }
        setScanProgress(p => ({ ...p, done: Math.min(i + BATCH_SIZE, batterJobs.length), playerName: batch[batch.length - 1]?.player?.person?.fullName || "", failed: scanFailCount }));
      }

      if (cancelRef.current) return;

      // Bio retry pass — any player whose bio fetch silently failed (bio=null) gets one more try.
      // Both birthDate and birthCity will be null together only when bio was null (not a partial success).
      // This ensures birthday/hometown display in TodayBoard works even when the first fetch fails.
      const missingBio = allResults.filter(p => p.birthDate === null && p.birthCity === null);
      if (missingBio.length > 0) {
        await Promise.all(missingBio.map(async p => {
          const bio = await getPlayerBio(p.playerId);
          if (!bio) return;
          p.birthDate = bio.birthDate || null;
          p.birthCity = bio.birthCity || null;
          // Re-compute only birthday + hometown flags (home/road advantage already set from splits)
          const homeAbbrev = p.game?.teams?.home?.team?.abbreviation;
          const todayStr = getTodayInAppTimeZone();
          if (bio.birthDate) {
            if (bio.birthDate.slice(5) === todayStr.slice(5)) p.flags.birthday = true;
          }
          if (bio.birthCity && homeAbbrev) {
            const ab = _ABBREV_ALIASES[homeAbbrev] || homeAbbrev;
            const parkCity = (PARK_CITIES[ab] || "").toLowerCase().trim();
            const bc = bio.birthCity.toLowerCase().trim();
            if (parkCity) {
              const direct = bc === parkCity || parkCity.includes(bc) || bc.includes(parkCity);
              if (direct) { p.flags.hometown = true; }
              else {
                for (const [metro, cities] of Object.entries(METRO_AREAS)) {
                  const parkInMetro = parkCity === metro || cities.some(c => parkCity.includes(c));
                  const birthInMetro = bc === metro || cities.some(c => bc.includes(c) || c.includes(bc));
                  if (parkInMetro && birthInMetro) { p.flags.hometown = true; break; }
                }
              }
            }
          }
        }));
      }

      if (cancelRef.current) return;

      // Phase 3: Build per-model pick lists
      const byModel = {};
      const boardKeys = Object.keys(BOARD_CONFIGS);

      for (const bk of boardKeys) {
        const cfg = BOARD_CONFIGS[bk];
        // Map board key to model result key
        const modelKey = bk === "hits15" ? "hits" : bk;
        const picks = [];

        for (const player of allResults) {
          const result = player.models[modelKey];
          if (!result || result.skip) continue;
          const scoringScore = result.adjScore ?? result.score;
          const bestLine = (bk === "tb" || bk === "hrr")
            ? findBestLine(scoringScore, bk)
            : (() => {
                const staticLine = bk === "hits15" ? 1.5 : 0.5;
                const propType = bk === "hits15" ? "hits" : bk;
                const prob = modelImpliedProb(scoringScore, propType, staticLine);
                return { line: staticLine, impliedProb: prob, fairLine: probToAmericanOdds(prob) };
              })();
          const isActionable = isBoardActionable(bk, scoringScore, result, player, cfg);
          // SB watch tier (2026-07-06): sub-threshold rows ride along tagged
          // `watch: true` — the SB board renders them as a grey research tier;
          // every pick-adjacent consumer (saves, golden, counts, best-pick,
          // search tags, threshold backtests) skips them via !watch guards.
          const isWatch = !isActionable && bk === "sb" && isSbWatch(scoringScore, result);
          if (!isActionable && !isWatch) continue;

          // 2026-07-05 panel blend: model results already carry the blended prob at the
          // fitted lines (hits 0.5/1.5, hr 0.5, rbi 0.5, tb/hrr 1.5/2.5) — read those
          // instead of re-deriving from the raw calibration. findBestLine's LINE choice
          // is untouched; only the reported prob at that line upgrades. singles/doubles/sb
          // are unblended (sb validated worse; singles/doubles have no fitted challenger).
          //
          // The `?? modelImpliedProb(scoringScore, ...)` arms are DEFENSIVE FALLBACKS and
          // must stay that way. scoringScore is adjScore (score × parkMult × extMult),
          // but every calibration is fitted on the model's OWN raw score — so a fallback
          // that actually fired would silently apply a score-fitted curve to an adjusted
          // score. Measured 2026-07-29 over 10 scan days: hits/hr/hrr/rbi/tb/sb carry
          // their own prob on 100% of rows (2017 each), so this never fires today. If a
          // model ever stops emitting impliedProb*, fix THAT rather than letting these
          // arms become the live path.
          const primaryImplied = (() => {
            switch (bk) {
              case 'hits':   return result.impliedProb05 ?? modelImpliedProb(scoringScore, 'hits', 0.5);
              case 'hits15': return result.impliedProb15 ?? modelImpliedProb(scoringScore, 'hits', 1.5);
              case 'hr':     return result.impliedProb05 ?? modelImpliedProb(scoringScore, 'hr', 0.5);
              case 'singles':return modelImpliedProb(scoringScore, 'singles', 0.5);
              case 'doubles':return modelImpliedProb(scoringScore, 'doubles', 0.5);
              case 'tb':
              case 'hrr': {
                const atLine = bestLine?.line === 1.5 ? result.impliedProb15
                  : bestLine?.line === 2.5 ? result.impliedProb25 : null;
                return atLine ?? bestLine?.impliedProb ?? modelImpliedProb(scoringScore, bk, 1.5);
              }
              case 'sb':     return modelImpliedProb(scoringScore, 'sb', 0.5);
              case 'rbi':    return result.impliedProb05 ?? modelImpliedProb(scoringScore, 'rbi', 0.5);
              default:       return result.impliedProb05 ?? null;
            }
          })();
          const primaryFairLine = primaryImplied != null
            ? probToAmericanOdds(primaryImplied)
            : (result.fairLine05 ?? null);
          const _gl = player.gameLog || [];
          const _thresh = bk === 'hits15' ? 1.5
            : (bk === 'tb' || bk === 'hrr') ? (bestLine?.line ?? 1.5)
            : 0.5;
          picks.push({
            ...(isWatch ? { watch: true } : {}),
            name: player.name, playerId: player.playerId,
            team: player.team, teamId: player.teamId,
            position: player.position, batSide: player.batSide,
            opponent: player.opponent,
            oppPitcher: player.oppPitcher, oppPitcherId: player.oppPitcherId,
            oppPitcherHand: player.oppPitcherHand,
            venue: player.venue, isHome: player.isHome,
            flags: player.flags || {},
            seasonAvg: player.seasonAvg, seasonH: player.seasonH,
            seasonAB: player.seasonAB, seasonHR: player.seasonHR,
            seasonRBI: player.seasonRBI, seasonSB: player.seasonSB,
            score: scoringScore,
            rawScore: result.score, parkMult: result.parkMult,
            impliedProb: primaryImplied,
            fairLine: primaryFairLine,
            bestLine,
            result, game: player.game,
            rateL5:  computeRateSeries(_gl, bk, _thresh, 5),
            rateL10: computeRateSeries(_gl, bk, _thresh, 10),
            rateL20: computeRateSeries(_gl, bk, _thresh, 20),
            drought: computeDrought(_gl, bk, _thresh),
          });
        }

        // Deduplicate by playerId — keep highest-scoring entry (handles doubleheaders)
        const deduped = new Map();
        for (const p of picks) {
          const existing = deduped.get(p.playerId);
          if (!existing || (p.score || 0) > (existing.score || 0)) deduped.set(p.playerId, p);
        }
        const dedupedPicks = [...deduped.values()];
        dedupedPicks.sort((a, b) => (b.score || 0) - (a.score || 0));
        byModel[bk] = dedupedPicks;
      }

      const pitcherResults = await pitcherScanPromise;
      const finalResults = { players: allResults, byModel, pitchers: pitcherResults || [] };
      setScanData(finalResults);
      setScanComplete(true);
      setScanProgress(p => ({ ...p, phase: "complete", failed: scanFailCount }));
      if (scanFailCount > 0) console.warn(`⚾ Scan complete: ${allResults.length} ok, ${scanFailCount} failed`);

      // ── Save results to server cache (fire-and-forget) ────────────────────────
      // Only cache complete scans: need enough batters AND pitchers so stale/
      // interrupted scans don't poison future loads for other users.
      const scanHourET = (() => {
        try {
          return parseInt(new Intl.DateTimeFormat("en-US", {
            timeZone: "America/New_York", hour: "2-digit", hour12: false,
          }).format(new Date()), 10);
        } catch { return 12; }
      })();
      // Thresholds scale with the slate — see isScanCacheable. A fixed 40-batter /
      // 3-pitcher gate silently assumed a full slate and could never pass on
      // 2026-07-16's 1-game slate, so the scan was never cached.
      const scanIsComplete = isScanCacheable({
        gameCount: games.length,
        batters: allResults.length,
        pitchers: pitcherResults?.length || 0,
        hourET: scanHourET,
      });
      if (scanIsComplete) {
        try {
          const today = getTodayInAppTimeZone();
          // Slim payload: dedupe game metadata, drop duplicated pick.result, strip re-derivable
          // bio fields. Net ~5-10 MB → ~1.5-3 MB.
          const slim = slimScanResults(finalResults);
          // Then gzip: slimming alone still lands at 4.4-5.5 MB on a full slate, which
          // straddles Vercel's 4.5 MB body cap — over it the POST dies as 413 before the
          // handler runs. gzip takes it to ~0.5 MB (~91% smaller). See api/scan-results.js.
          postScanResults({
            date: today,
            results: slim,
            player_count: allResults.length,
            version: "1",
          });
        } catch (e) { console.error("[scan-results] save skipped:", e?.message || e); }
      } else if (games.length >= 1 && scanHourET >= 10) {
        console.warn(
          `[scan-results] scan not cached: ${allResults.length} batters, ` +
          `${pitcherResults?.length || 0} pitchers (${games.length}-game slate)`
        );
      }
    }

    scan();
    return () => { cancelRef.current = true; };
  }, [games, season]);

  return { scanData, scanProgress, scanComplete };
}

// Golden 10 moved out 2026-08-09: the board is src/components/GoldenBoard.jsx,
// its ranking math src/lib/golden.js, its snapshot persistence
// src/lib/goldenSnapshot.js (shared with the Results tracker below).


// ── Loading overlay shown during initial scan ──
// ── Consolidated Props Table (Phase 1) ──
const PROP_OPTIONS = [
  { key: "hits",   label: "Hits",        emoji: "🎯" },
  { key: "hrr",    label: "H+R+RBI",     emoji: "🔥" },
  { key: "hr",     label: "Home Runs",   emoji: "💣" },
  { key: "tb",     label: "Total Bases", emoji: "📊" },
  { key: "sb",     label: "Stolen Bases",emoji: "🏃" },
  { key: "rbi",    label: "RBI",         emoji: "🏅" },
  { key: "ks",     label: "Pitcher Ks",  emoji: "⚾" },
];

function ConsolidatedPropsTable({ enrichedScanData, games, onSelectBatter, onSelectPitcher }) {
  const [selectedProp, setSelectedProp] = useState("hits");
  const [selectedGame, setSelectedGame] = useState("all");
  const [sortCol, setSortCol]   = useState("conf");
  const [sortDir, setSortDir]   = useState("desc");
  const [lineFilter, setLineFilter] = useState("all");

  const isPitcher = selectedProp === "ks";

  const rawPicks = isPitcher
    ? (enrichedScanData?.pitchers || [])
    : (enrichedScanData?.byModel?.[selectedProp] || []).filter(p => !p.watch);

  const gameFiltered = useMemo(() => {
    if (selectedGame === "all") return rawPicks;
    return rawPicks.filter(p => String(p.game?.gamePk || p.gamePk) === selectedGame);
  }, [rawPicks, selectedGame]);

  // Collect distinct lines for line filter (only meaningful when multiple lines exist)
  const availableLines = useMemo(() => {
    if (isPitcher) {
      const lines = [...new Set(gameFiltered.map(p => p.line).filter(l => l != null))].sort((a,b)=>a-b);
      return lines;
    }
    const lines = [...new Set(gameFiltered.map(p => (p.bookLine ?? p.bestLine?.line)).filter(l => l != null))].sort((a,b)=>a-b);
    return lines;
  }, [gameFiltered, isPitcher]);

  const picks = useMemo(() => {
    if (lineFilter === "all") return gameFiltered;
    const lf = parseFloat(lineFilter);
    if (isPitcher) return gameFiltered.filter(p => p.line === lf);
    return gameFiltered.filter(p => (p.bookLine ?? p.bestLine?.line) === lf);
  }, [gameFiltered, lineFilter, isPitcher]);

  const sorted = useMemo(() => {
    const dir = sortDir === "desc" ? -1 : 1;
    const confOf = p => isPitcher
      ? (p.conf ?? 0)
      : (calcConfidence(p.score, selectedProp, p) ?? 0);
    return [...picks].sort((a, b) => {
      const va = sortCol === "conf"    ? confOf(a)
               : sortCol === "score"   ? (a.score ?? a.xK ?? 0)
               : sortCol === "rateL5"  ? (a.rateL5  ?? -1)
               : sortCol === "rateL10" ? (a.rateL10 ?? -1)
               : sortCol === "rateL20" ? (a.rateL20 ?? -1)
               : sortCol === "drought" ? (a.drought  ?? 0)
               : sortCol === "line"    ? (a.line     ?? 0)
               : sortCol === "xKEdge" ? (a.xKEdge   ?? -99)
               : 0;
      const vb = sortCol === "conf"    ? confOf(b)
               : sortCol === "score"   ? (b.score ?? b.xK ?? 0)
               : sortCol === "rateL5"  ? (b.rateL5  ?? -1)
               : sortCol === "rateL10" ? (b.rateL10 ?? -1)
               : sortCol === "rateL20" ? (b.rateL20 ?? -1)
               : sortCol === "drought" ? (b.drought  ?? 0)
               : sortCol === "line"    ? (b.line     ?? 0)
               : sortCol === "xKEdge" ? (b.xKEdge   ?? -99)
               : 0;
      return dir * (vb - va);
    });
  }, [picks, sortCol, sortDir, isPitcher, selectedProp]);

  const gameOptions = useMemo(() => {
    const opts = [{ value: "all", label: "All Games" }];
    for (const g of (games || [])) {
      const away = g.teams?.away?.team?.abbreviation;
      const home = g.teams?.home?.team?.abbreviation;
      if (away && home) opts.push({ value: String(g.gamePk), label: `${away} @ ${home}` });
    }
    return opts;
  }, [games]);

  const fmtRate = r => r == null ? "—" : (r * 100).toFixed(0) + "%";

  const SortTh = ({ col, label, align = "center", className }) => {
    const active = sortCol === col;
    return (
      <th className={className} onClick={() => { if (active) setSortDir(d => d === "desc" ? "asc" : "desc"); else { setSortCol(col); setSortDir("desc"); }}}
        style={{ padding: "9px 8px", textAlign: align, color: active ? "#2062c8" : "#8b99b0", fontWeight: 700, fontSize: 10, cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" }}>
        {label}{active ? (sortDir === "desc" ? " ↓" : " ↑") : ""}
      </th>
    );
  };

  const dropStyle = {
    background: "#edf2fa", border: "1px solid rgba(32,98,200,0.2)", color: "#16233c",
    borderRadius: 6, padding: "7px 10px", fontSize: 12, cursor: "pointer", outline: "none",
  };

  return (
    <div style={{ padding: "16px 20px" }}>
      {/* Filters */}
      <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
        <select value={selectedProp} onChange={e => { setSelectedProp(e.target.value); setSortCol("score"); setLineFilter("all"); }} style={dropStyle}>
          {PROP_OPTIONS.map(o => <option key={o.key} value={o.key}>{o.emoji} {o.label}</option>)}
        </select>
        <select value={selectedGame} onChange={e => { setSelectedGame(e.target.value); setLineFilter("all"); }} style={dropStyle}>
          {gameOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        {availableLines.length > 1 && (
          <select value={lineFilter} onChange={e => setLineFilter(e.target.value)}
            style={{ ...dropStyle, color: lineFilter !== "all" ? "#2062c8" : "#16233c" }}>
            <option value="all">All Lines</option>
            {availableLines.map(l => <option key={l} value={String(l)}>O{l}</option>)}
          </select>
        )}
        <span style={{ fontSize: 11, color: "#8b99b0", marginLeft: 4 }}>{sorted.length} picks</span>
      </div>

      {sorted.length === 0 ? (
        <div style={{ padding: "60px 0", textAlign: "center", color: "#8b99b0", fontSize: 13 }}>No picks for this prop type.</div>
      ) : (
        <div className="hscroll">
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: "2px solid rgba(32,98,200,0.192)" }}>
                <th style={{ padding: "9px 8px", textAlign: "left",  color: "#8b99b0", fontWeight: 700, fontSize: 10, width: 28 }}>#</th>
                <th style={{ padding: "9px 8px", textAlign: "left",  color: "#8b99b0", fontWeight: 700, fontSize: 10 }}>PLAYER</th>
                <th style={{ padding: "9px 8px", textAlign: "left",  color: "#8b99b0", fontWeight: 700, fontSize: 10 }}>TEAM</th>
                <th style={{ padding: "9px 8px", textAlign: "left",  color: "#8b99b0", fontWeight: 700, fontSize: 10 }}>OPP</th>
                <SortTh col="score"   label={isPitcher ? "xK" : "AVG"}   align="right" />
                {isPitcher && <SortTh col="line"   label="LINE"   align="right" />}
                {isPitcher && <SortTh col="xKEdge" label="K EDGE" align="right" />}
                {isPitcher && <th style={{ padding: "9px 8px", textAlign: "center", color: "#8b99b0", fontWeight: 700, fontSize: 10 }}>SIGNAL</th>}
                <th style={{ padding: "9px 8px", textAlign: "right", color: BOOK_COLORS.fanduel,    fontWeight: 700, fontSize: 10 }}>FD</th>
                <th style={{ padding: "9px 8px", textAlign: "right", color: BOOK_COLORS.draftkings, fontWeight: 700, fontSize: 10 }}>DK</th>
                <th style={{ padding: "9px 8px", textAlign: "right", color: BOOK_COLORS.hardrockbet,fontWeight: 700, fontSize: 10 }}>HR</th>
                <SortTh col="rateL5"  label="L5" />
                <SortTh col="rateL10" label="L10" className="hide-mobile" />
                <SortTh col="rateL20" label="L20" className="hide-mobile" />
                {!isPitcher && <SortTh col="drought" label="DROUGHT" className="hide-mobile" />}
              </tr>
            </thead>
            <tbody>
              {sorted.map((pick, i) => {
                const cfg = BOARD_CONFIGS[selectedProp];
                const proj = isPitcher
                  ? (pick.xK?.toFixed(1) ?? "—")
                  : pick.seasonAvg != null ? pick.seasonAvg.toFixed(3).replace(/^0/, "") : "—";
                const books = ["fanduel","draftkings","hardrockbet"];
                const bo = pick.bookOdds || {};
                const bl = pick.bookLinks || {};
                const allPrices = books.map(b => bo[b]).filter(p => p != null);
                const bestPrice = allPrices.length ? Math.max(...allPrices) : null;
                const drought = pick.drought ?? 0;
                const droughtColor = drought >= 10 ? "#0f8a44" : drought >= 7 ? "#1c9a50" : drought >= 5 ? "#a16207" : "#6d7c96";
                const oppLabel = isPitcher
                  ? pick.opponent
                  : pick.oppPitcher ? `${pick.opponent} · ${pick.oppPitcher.split(" ").slice(-1)[0]}` : pick.opponent;

                return (
                  <tr key={pick.playerId || pick.pitcherId || i}
                    onClick={() => isPitcher
                      ? onSelectPitcher({ pitcher: { id: pick.pitcherId, fullName: pick.name, pitchHand: { code: pick.hand } }, pitcherTeam: pick.team, pitcherScanData: pick })
                      : onSelectBatter(pick)}
                    style={{ borderBottom: "1px solid rgba(32,98,200,0.08)", cursor: "pointer" }}
                    onMouseEnter={e => e.currentTarget.style.background = "rgba(32,98,200,0.064)"}
                    onMouseLeave={e => e.currentTarget.style.background = ""}>
                    <td style={{ padding: "10px 8px", color: "#8b99b0", fontSize: 11 }}>{i + 1}</td>
                    <td style={{ padding: "10px 8px" }}>
                      <div style={{ fontWeight: 700, color: "#16233c", fontSize: 12 }}>{pick.name}</div>
                      {!isPitcher && <div style={{ fontSize: 9, color: "#b6c5dc", marginTop: 2 }}>{pick.position}</div>}
                    </td>
                    <td style={{ padding: "10px 8px", color: "#5d6f8b", fontSize: 11, fontWeight: 600 }}>{pick.team}</td>
                    <td style={{ padding: "10px 8px", color: "#6d7c96", fontSize: 11 }}>{oppLabel}</td>
                    <td style={{ padding: "10px 8px", textAlign: "right", color: "#2062c8", fontWeight: 700, fontFamily: "'JetBrains Mono',monospace" }}>{proj}</td>
                    {isPitcher && (
                      <td style={{ padding: "10px 8px", textAlign: "right", fontFamily: "'JetBrains Mono',monospace", fontSize: 11, color: "#a16207", fontWeight: 700 }}>
                        {pick.line != null ? `O${pick.line}` : "—"}
                      </td>
                    )}
                    {isPitcher && (() => {
                      const edge = pick.xKEdge;
                      const edgeColor = edge == null ? "#8b99b0" : edge > 0.5 ? "#0f8a44" : edge > 0 ? "#1c9a50" : edge > -0.5 ? "#d03131" : "#c62828";
                      return (
                        <td style={{ padding: "10px 8px", textAlign: "right", fontFamily: "'JetBrains Mono',monospace", fontSize: 11, color: edgeColor, fontWeight: 700 }}>
                          {edge == null ? "—" : (edge > 0 ? "+" : "") + edge.toFixed(2)}
                        </td>
                      );
                    })()}
                    {isPitcher && (() => {
                      const sig = pick.signal;
                      const sigStyle = sig === "over"
                        ? { color: "#0f8a44", background: "rgba(15,138,68,0.12)" }
                        : sig === "under"
                        ? { color: "#d03131", background: "rgba(208,49,49,0.12)" }
                        : { color: "#6d7c96", background: "transparent" };
                      return (
                        <td style={{ padding: "10px 8px", textAlign: "center" }}>
                          <span style={{ fontSize: 10, fontWeight: 700, borderRadius: 4, padding: "2px 6px", letterSpacing: 0.5, ...sigStyle }}>
                            {sig === "over" ? "▲ OVER" : sig === "under" ? "▼ UNDER" : "—"}
                          </span>
                        </td>
                      );
                    })()}
                    {books.map(bk => (
                      <td key={bk} style={{ padding: "10px 8px", textAlign: "right" }} onClick={e => e.stopPropagation()}>
                        <OddsLink price={bo[bk] ?? null} url={bl[bk] ?? null} isBest={bo[bk] != null && bo[bk] === bestPrice} bk={bk} />
                      </td>
                    ))}
                    {[pick.rateL5, pick.rateL10, pick.rateL20].map((r, ri) => (
                      <td key={ri} className={ri > 0 ? "hide-mobile" : undefined} style={{ padding: "10px 8px", textAlign: "center" }}>
                        <span style={{ fontSize: 11, fontWeight: 600, borderRadius: 4, padding: "2px 7px", ...heatCell(r) }}>{fmtRate(r)}</span>
                      </td>
                    ))}
                    {!isPitcher && (
                      <td className="hide-mobile" style={{ padding: "10px 8px", textAlign: "center" }}>
                        {drought === 0
                          ? <span style={{ fontSize: 10, color: "#c9d5e8" }}>—</span>
                          : <span style={{ fontSize: 11, fontWeight: 700, color: droughtColor, fontFamily: "'JetBrains Mono',monospace" }}>{drought}G</span>}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ScanOverlay({ progress, gameCount }) {
  const pct = progress.total > 0 ? (progress.done / progress.total * 100) : 0;
  return (
    <div style={{
      position: "fixed", top: 0, left: 0, width: "100vw", height: "100dvh", zIndex: 2000,
      background: "linear-gradient(160deg, #e3e9f3 0%, #eaeef6 40%, #eef2f9 100%)",
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 24,
    }}>
      <div style={{ width: 56, height: 56, borderRadius: 14, background: "linear-gradient(135deg, #2062c8, #2563eb)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28 }}>⚾</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: "#16233c" }}>MLB Research Dashboard</div>
      <div style={{ fontSize: 13, color: "#6d7c96", textAlign: "center", maxWidth: 360 }}>
        Scanning {gameCount} games · Running all models on every projected batter
      </div>

      <div style={{ width: 320, marginTop: 12 }}>
        <div style={{ height: 6, background: "rgba(203,212,233,0.8)", borderRadius: 3, overflow: "hidden", marginBottom: 8 }}>
          <div style={{ width: `${pct}%`, height: "100%", background: "linear-gradient(90deg, #2563eb, #2062c8)", borderRadius: 3, transition: "width 0.3s" }} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 12, color: "#2062c8", fontFamily: "'JetBrains Mono', monospace" }}>
            {progress.done}/{progress.total}
          </span>
          <span style={{ fontSize: 11, color: "#74839d" }}>{progress.phase}</span>
        </div>
        {progress.playerName && (
          <div style={{ fontSize: 11, color: "#8b99b0", marginTop: 4, textAlign: "center" }}>
            {progress.playerName}
          </div>
        )}
      </div>

      <div style={{ fontSize: 11, color: "#b6c5dc", marginTop: 20, textAlign: "center", maxWidth: 280 }}>
        This runs once per date · All tabs will be instant after loading
      </div>
    </div>
  );
}

// ── Weather Report — park + weather adjustment table for Today tab ──
function WeatherReport({ games }) {
  const isMobile = useIsMobile();
  const [weatherMap, setWeatherMap] = useState({});
  const [loaded, setLoaded] = useState(false);
  const [sortCol, setSortCol] = useState(null);   // null | "temp"|"wind"|"hr"|"xtra"|"h1b"|"runs"
  const [sortDir, setSortDir] = useState("desc");
  const [viewMode, setViewMode] = useState("weather"); // "weather" | "parkfactors"

  const handleSort = col => {
    if (sortCol === col) {
      setSortDir(d => d === "desc" ? "asc" : "desc");
    } else {
      setSortCol(col);
      setSortDir("desc");
    }
  };

  const pkList = (games || []).map(g => g.gamePk).join(",");
  useEffect(() => {
    if (!games?.length) { setLoaded(true); return; }
    setLoaded(false);
    Promise.all(
      games.map(async g => {
        const homeAbbrev = g.teams?.home?.team?.abbreviation;
        const coords     = getParkCoords(g.venue?.name, homeAbbrev);
        const cfBearing  = getParkCfBearing(g.venue?.name, homeAbbrev);
        let w = null;
        if (coords) {
          w = await getNWSForecast(coords[0], coords[1], g.gameDate, cfBearing).catch(() => null);
        }
        // Fall back to live feed if NWS failed (e.g. TOR, or after first pitch)
        if (!w) {
          w = await Promise.race([
            getGameWeather(g.gamePk).catch(() => null),
            new Promise(r => setTimeout(() => r(null), 4000)),
          ]);
        }
        return [g.gamePk, w];
      })
    ).then(results => {
      const m = {};
      for (const [pk, w] of results) m[pk] = w;
      setWeatherMap(m);
      setLoaded(true);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pkList]);

  // % delta display
  const fmtPct = v => {
    const p = Math.round((v - 1) * 100);
    const color = p >= 8 ? "#0f8a44" : p >= 3 ? "#1c9a50" : p <= -8 ? "#d03131" : p <= -3 ? "#c25555" : "#6d7c96";
    return { label: p === 0 ? "—" : `${p > 0 ? "+" : ""}${p}%`, color };
  };

  // Wind arrow(s) + speed label
  const windLabel = (speed, dir) => {
    if (!speed || speed < 3) return { arrow: "∼", label: "Calm", color: "#8b99b0" };
    const d = (dir || "").toLowerCase();
    const strong = speed >= 12;
    let arrow, friendly;
    if (d.includes("out to cf"))   { arrow = strong ? "↑↑" : "↑"; friendly = "Out"; }
    else if (d.includes("in from cf")) { arrow = strong ? "↓↓" : "↓"; friendly = "In"; }
    else if (d.includes("l to r"))  { arrow = "→"; friendly = "L→R"; }
    else if (d.includes("r to l"))  { arrow = "←"; friendly = "R→L"; }
    else if (d.includes("out"))     { arrow = "↗"; friendly = "Out"; }
    else if (d.includes("in"))      { arrow = "↙"; friendly = "In"; }
    else                            { arrow = "↔"; friendly = dir || ""; }
    const color = (friendly === "Out" || friendly === "L→R" || friendly === "R→L") && strong ? "#a16207"
                : friendly === "Out" ? "#1c9a50"
                : friendly === "In" && strong ? "#d03131"
                : friendly === "In" ? "#c25555"
                : "#4c5f7d";
    return { arrow, label: `${speed}mph ${friendly}`, color };
  };

  // Condition icon
  const condIcon = cond => {
    if (!cond) return "";
    const c = cond.toLowerCase();
    if (c.includes("clear") || c.includes("sunny")) return "☀️";
    if (c.includes("cloud") || c.includes("overcast")) return "⛅";
    if (c.includes("rain") || c.includes("shower")) return "🌧";
    if (c.includes("fog") || c.includes("mist")) return "🌫";
    if (c.includes("thunder")) return "⛈";
    if (c.includes("wind")) return "💨";
    return "🌤";
  };

  if (!games?.length) return null;

  const rows = (games || []).map(g => {
    const homeAbbrev = g.teams?.home?.team?.abbreviation;
    const awayAbbrev = g.teams?.away?.team?.abbreviation;
    const park = getParkData(g.venue?.name, homeAbbrev);
    const weather = weatherMap[g.gamePk] || null;
    const neutral = park ? isWeatherNeutral(park, weather) : false;
    const roofStat = park ? getRoofStatus(park, weather) : null;
    const gameTime = g.gameDate
      ? new Date(g.gameDate).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })
      : "";

    // Compute multipliers (average L/R for HR since we don't know batting side here)
    const hrL  = parkWeatherMult(park, weather, "L", "HR");
    const hrR  = parkWeatherMult(park, weather, "R", "HR");
    const hrM  = (hrL + hrR) / 2;
    const dbM  = parkWeatherMult(park, weather, "R", "2B");
    const tbM  = parkWeatherMult(park, weather, "R", "3B");
    const xbaM = parkWeatherMult(park, weather, "R", "H");
    // 2B/3B blend: weight 3/4 toward 2B since triples are rare
    const xtraM = dbM * 0.75 + tbM * 0.25;
    // Runs composite: HR 30% + 2B 20% + 1B 40% + elev/temp residual 10%
    const runsM = hrM * 0.30 + xtraM * 0.20 + xbaM * 0.40 + (hrM * 0.10);

    // Park-factor-only multipliers (no weather) — shown when outdoor to isolate PF contribution
    const hrPF  = parkWeatherMult(park, null, "R", "HR");
    const xtraPF = (parkWeatherMult(park, null, "R", "2B") * 0.75 + parkWeatherMult(park, null, "R", "3B") * 0.25);
    const xbaPF  = parkWeatherMult(park, null, "R", "H");

    const wind = neutral ? null : windLabel(weather?.windSpeed, weather?.windDir);

    return { g, park, weather, neutral, roofStat, gameTime, awayAbbrev, homeAbbrev,
      hrM, xtraM, xbaM, runsM, hrPF, xtraPF, xbaPF, wind };
  });

  // Apply sort
  const sortedRows = sortCol == null ? rows : [...rows].sort((a, b) => {
    let av, bv;
    if (sortCol === "temp")  { av = a.weather?.temp ?? -999; bv = b.weather?.temp ?? -999; }
    if (sortCol === "wind")  { av = a.weather?.windSpeed ?? 0; bv = b.weather?.windSpeed ?? 0; }
    if (sortCol === "hr")    { av = a.hrM; bv = b.hrM; }
    if (sortCol === "xtra")  { av = a.xtraM; bv = b.xtraM; }
    if (sortCol === "h1b")   { av = a.xbaM; bv = b.xbaM; }
    if (sortCol === "runs")  { av = a.runsM; bv = b.runsM; }
    return sortDir === "desc" ? bv - av : av - bv;
  });

  const thBase = (align = "center") => ({
    textAlign: align, padding: "5px 10px", fontSize: 9, fontWeight: 700,
    letterSpacing: 1, textTransform: "uppercase", color: "#8b99b0", whiteSpace: "nowrap",
  });
  const Th = ({ col, align = "center", children }) => {
    const active = sortCol === col;
    return (
      <th onClick={col ? () => handleSort(col) : undefined}
          style={{ ...thBase(align), cursor: col ? "pointer" : "default",
            color: active ? "#2062c8" : "#8b99b0",
            userSelect: "none" }}>
        {children}{active ? (sortDir === "desc" ? " ↓" : " ↑") : ""}
      </th>
    );
  };

  return (
    <div style={{ background: "rgba(210,217,236,0.6)", border: "1px solid rgba(32,98,200,0.16)", borderRadius: 10, overflow: "hidden" }}>
      {/* Title row */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px 6px", borderBottom: "1px solid rgba(32,98,200,0.128)", flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1.2, color: "#2062c8" }}>🌤 Park &amp; Weather</span>
        <span style={{ fontSize: 9, color: "#7e8ca6", marginLeft: 4, flex: 1 }}>NWS forecast · park factors + temp/wind · retractable roofs auto-detected</span>
        {!loaded && <span style={{ fontSize: 10, color: "#b6c5dc" }}>Loading…</span>}
        {isMobile && (
          <div style={{ display: "flex", gap: 3, marginLeft: "auto" }}>
            {[["weather", "Weather"], ["parkfactors", "Park Factors"]].map(([mode, label]) => (
              <button key={mode} onClick={() => setViewMode(mode)} style={{
                padding: "2px 8px", fontSize: 9, fontWeight: 700, borderRadius: 6, cursor: "pointer",
                background: viewMode === mode ? "rgba(32,98,200,0.18)" : "rgba(22,44,80,0.04)",
                border: `1px solid ${viewMode === mode ? "rgba(32,98,200,0.4)" : "rgba(32,98,200,0.16)"}`,
                color: viewMode === mode ? "#2062c8" : "#8b99b0",
              }}>{label}</button>
            ))}
          </div>
        )}
      </div>
      <div className="hscroll">
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ background: "rgba(213,219,237,0.8)" }}>
            <Th align="left">Game</Th>
            {!isMobile ? <>
              <Th col="temp">Temp</Th>
              <Th col="wind">Wind</Th>
              <Th>Direction</Th>
              <Th>Roof</Th>
              <Th col="hr">HR</Th>
              <Th col="xtra">2B/3B</Th>
              <Th col="h1b">1B</Th>
              <Th col="runs">Runs Env</Th>
            </> : viewMode === "weather" ? <>
              <Th col="temp">Temp</Th>
              <Th col="wind">Wind</Th>
              <Th>Direction</Th>
              <Th>Roof</Th>
            </> : <>
              <Th col="hr">HR</Th>
              <Th col="xtra">2B/3B</Th>
              <Th col="h1b">1B</Th>
              <Th col="runs">Runs Env</Th>
            </>}
          </tr>
        </thead>
        <tbody>
          {sortedRows.map(({ g, park, weather, neutral, roofStat, gameTime, awayAbbrev, homeAbbrev, hrM, xtraM, xbaM, runsM, hrPF, xtraPF, xbaPF, wind }, i) => {
            const hr   = fmtPct(hrM);
            const xtra = fmtPct(xtraM);
            const h1b  = fmtPct(xbaM);
            const runs = fmtPct(runsM);
            // For indoor/neutral parks show PF-only delta in muted style
            const hrPFd  = fmtPct(hrPF);
            const xtraPFd = fmtPct(xtraPF);
            const xbaPFd  = fmtPct(xbaPF);
            const srcBadge = !loaded && !weather ? "—"
              : weather?.source === "nws_forecast" ? "FCST" : weather ? "LIVE" : "—";
            const srcColor = srcBadge === "LIVE" ? "#0f8a44" : srcBadge === "FCST" ? "#7e8ca6" : "#c9d5e8";
            // Weather effect columns: for outdoor parks show full mult; for indoor show PF-only in muted style
            const showWeather = !neutral;
            return (
              <tr key={g.gamePk} style={{ borderTop: "1px solid rgba(32,98,200,0.08)", background: i % 2 === 0 ? "rgba(210,217,236,0.25)" : "transparent" }}>
                {/* Game */}
                <td style={{ padding: "7px 14px", minWidth: 150 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: "#3c4f6d" }}>
                      {park?.name || g.venue?.name || `${awayAbbrev} @ ${homeAbbrev}`}
                    </span>
                    {gameTime && <span style={{ fontSize: 10, color: "#8b99b0" }}>{gameTime}</span>}
                  </div>
                  <div style={{ fontSize: 10, color: "#b6c5dc", marginTop: 1 }}>
                    <span style={{ color: "#56748f" }}>{awayAbbrev} @ {homeAbbrev}</span>
                    <span style={{ marginLeft: 6, fontSize: 9, color: srcColor }}>{srcBadge}</span>
                  </div>
                </td>
                {/* Weather columns — shown when: desktop (always) OR mobile weather tab */}
                {(!isMobile || viewMode === "weather") && <>
                  {/* Temp */}
                  <td style={{ textAlign: "center", padding: "7px 10px", whiteSpace: "nowrap" }}>
                    {neutral ? (
                      <span style={{ fontSize: 10, color: "#b6c5dc" }}>—</span>
                    ) : weather?.temp != null ? (
                      <span style={{ fontSize: 12, fontWeight: 600, fontFamily: "'JetBrains Mono',monospace",
                        color: weather.temp >= 85 ? "#c2570f" : weather.temp >= 72 ? "#4c5f7d" : weather.temp >= 55 ? "#2569d6" : "#3b74cf" }}>
                        {weather.temp}°F
                      </span>
                    ) : <span style={{ color: "#c9d5e8" }}>—</span>}
                  </td>
                  {/* Wind speed */}
                  <td style={{ textAlign: "center", padding: "7px 10px", whiteSpace: "nowrap" }}>
                    {neutral ? (
                      <span style={{ fontSize: 10, color: "#b6c5dc" }}>—</span>
                    ) : weather?.windSpeed >= 3 ? (
                      <span style={{ fontSize: 12, fontWeight: 700, color: wind?.color || "#4c5f7d", fontFamily: "'JetBrains Mono',monospace" }}>
                        {wind?.arrow} {weather.windSpeed}
                        <span style={{ fontSize: 9, color: "#6d7c96", fontWeight: 400 }}> mph</span>
                      </span>
                    ) : <span style={{ fontSize: 11, color: "#7e8ca6" }}>Calm</span>}
                  </td>
                  {/* Wind direction */}
                  <td style={{ textAlign: "center", padding: "7px 10px", whiteSpace: "nowrap" }}>
                    {neutral || !weather || weather.windSpeed < 3 ? (
                      <span style={{ color: "#c9d5e8" }}>—</span>
                    ) : (
                      <span style={{ fontSize: 11, fontWeight: 600, color: wind?.color || "#4c5f7d" }}>
                        {weather.windDir || weather.windDirRaw || "—"}
                      </span>
                    )}
                  </td>
                  {/* Roof status */}
                  <td style={{ textAlign: "center", padding: "7px 8px", whiteSpace: "nowrap" }}>
                    {roofStat ? (
                      <span title={roofStat.note || ""} style={{
                        fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 4,
                        color: roofStat.color,
                        background: roofStat.color === "#0f8a44" ? "rgba(15,138,68,0.1)"
                                  : roofStat.color === "#a16207" ? "rgba(161,98,7,0.12)"
                                  : "rgba(37,105,214,0.12)",
                        cursor: roofStat.note ? "help" : "default",
                      }}>
                        {roofStat.label}
                      </span>
                    ) : <span style={{ color: "#c9d5e8" }}>—</span>}
                  </td>
                </>}
                {/* Park factor columns — shown when: desktop (always) OR mobile park factors tab */}
                {(!isMobile || viewMode === "parkfactors") && <>
                  {showWeather ? (
                    [hr, xtra, h1b, runs].map((col, ci) => (
                      <td key={ci} style={{ textAlign: "center", padding: "7px 8px", fontFamily: "'JetBrains Mono',monospace", fontSize: 13, fontWeight: 700, color: col.color }}>
                        {col.label}
                      </td>
                    ))
                  ) : (
                    [hrPFd, xtraPFd, xbaPFd, fmtPct(hrPF * 0.30 + xtraPF * 0.20 + xbaPF * 0.50)].map((col, ci) => (
                      <td key={ci} style={{ textAlign: "center", padding: "7px 8px" }}>
                        <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 12, fontWeight: 700,
                          color: col.label === "—" ? "#c9d5e8" : col.color, opacity: 0.65 }}>
                          {col.label}
                        </span>
                        {col.label !== "—" && (
                          <span style={{ fontSize: 8, color: "#b6c5dc", marginLeft: 2, fontWeight: 400 }}>PF</span>
                        )}
                      </td>
                    ))
                  )}
                </>}
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>{/* end overflow scroll wrapper */}
      {/* Legend */}
      <div style={{ padding: "6px 14px", borderTop: "1px solid rgba(32,98,200,0.08)", display: "flex", gap: 16, flexWrap: "wrap" }}>
        <span style={{ fontSize: 9, color: "#7e8ca6" }}>
          <span style={{ color: "#0f8a44", fontWeight: 700 }}>Open</span> = weather applied (PF × temp × wind) &nbsp;·&nbsp;
          <span style={{ color: "#2569d6", fontWeight: 700 }}>Dome/Closed</span> = park factor only &nbsp;·&nbsp;
          <span style={{ color: "#a16207", fontWeight: 700 }}>Open?</span> = retractable, status unknown &nbsp;·&nbsp;
          <span style={{ color: "#56748f" }}>PF</span> superscript = no weather effect applied
        </span>
      </div>
    </div>
  );
}

// Pitcher Strikeouts tile for Today tab — same grid tile as TopFiveCard
function TodayPitcherCard({ pitchers, cell, onSelectPitcher }) {
  const [pitcherSort, setPitcherSort] = useState("proj");
  const sorted = [...pitchers]
    .sort((a, b) => pitcherSort === "conf" ? (b.conf||0) - (a.conf||0) : (b.xK||0) - (a.xK||0))
    .slice(0, 5);
  const btnStyle = (mode) => ({
    padding: "1px 6px", fontSize: 9, fontWeight: 600, borderRadius: 6,
    background: pitcherSort === mode ? "rgba(32,98,200,0.18)" : "rgba(22,44,80,0.04)",
    border: "1px solid rgba(32,98,200,0.24)",
    color: pitcherSort === mode ? "#2062c8" : "#8b99b0", cursor: "pointer",
  });
  const BOOKS = ["fanduel","draftkings","hardrockbet"];
  return (
    <div style={{ ...cell, padding: "12px 14px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{ fontSize: 14 }}>⚾</span>
          <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, color: "#2062c8" }}>Strikeouts</span>
        </div>
        <div style={{ display: "flex", gap: 3 }}>
          <button style={btnStyle("proj")} onClick={() => setPitcherSort("proj")}>Proj</button>
          <button style={btnStyle("conf")} onClick={() => setPitcherSort("conf")}>Conf</button>
        </div>
      </div>
      {/* Column headers */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "0 6px", marginBottom: 4 }}>
        <span style={{ width: 12 }} />
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 9, color: "#b6c5dc", fontFamily: "'JetBrains Mono',monospace", minWidth: 38 }}>xK</span>
        <span style={{ fontSize: 9, color: "#b6c5dc", fontFamily: "'JetBrains Mono',monospace", minWidth: 22, textAlign: "right" }}>Conf</span>
        {BOOKS.map(bk => (
          <span key={bk} style={{ fontSize: 9, color: BOOK_COLORS[bk], minWidth: 30, textAlign: "right", fontWeight: 700 }}>{BOOK_ABBR[bk]}</span>
        ))}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {sorted.map((p, i) => {
          // Use the K line closest to xK for EV: prefer 6.5, then 7.5, then 5.5
          const lineKey = p.xK >= 7.0 ? "65" : p.xK >= 6.0 ? "65" : "55";
          const impliedProbK = p[`impliedProb${lineKey}`] ?? p.impliedProb65;
          const bookPrices = BOOKS.map(bk => p.bookOdds?.[bk] ?? null);
          const bestPrice = bookPrices.reduce((best, price) => (price != null && (best === null || price > best) ? price : best), null);
          const evVal = impliedProbK != null && bestPrice != null ? calcEVFromOdds(impliedProbK, bestPrice) : null;
          const isEV = evVal != null && evVal > 0.03;
          return (
            <div key={p.pitcherId || i}
              onClick={() => onSelectPitcher && onSelectPitcher(p)}
              style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 6px", borderRadius: 6, transition: "background 0.15s", cursor: onSelectPitcher ? "pointer" : "default" }}
              onMouseEnter={e => e.currentTarget.style.background = "rgba(32,98,200,0.128)"}
              onMouseLeave={e => e.currentTarget.style.background = ""}>
              <span style={{ fontSize: 10, color: "#b6c5dc", fontFamily: "'JetBrains Mono',monospace", width: 12 }}>{i + 1}</span>
              <span style={{ flex: 1, fontSize: 11, color: "#3c4f6d", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {p.name} <span style={{ color: "#74839d", fontWeight: 400, fontSize: 10 }}>({p.hand})</span>
              </span>
              <span style={{ fontSize: 10, fontFamily: "'JetBrains Mono',monospace", color: "#2062c8", minWidth: 38 }}>
                xK {(p.xK||0).toFixed(1)}
                {isEV && <span style={{ fontSize: 8, color: "#a16207", fontWeight: 700, background: "rgba(161,98,7,0.15)", borderRadius: 3, padding: "0 3px", marginLeft: 3 }}>EV</span>}
              </span>
              <span style={{ fontSize: 9, fontFamily: "'JetBrains Mono',monospace", minWidth: 22, textAlign: "right",
                color: (p.conf||0) >= 7.5 ? "#0f8a44" : (p.conf||0) >= 6 ? "#4c5f7d" : "#74839d" }}>{(p.conf||0).toFixed(1)}</span>
              {BOOKS.map(bk => {
                const price = p.bookOdds?.[bk] ?? null;
                const isBest = price != null && price === bestPrice && bestPrice != null;
                return (
                  <span key={bk} style={{ minWidth: 30, textAlign: "right" }}>
                    <OddsLink price={price} url={p.bookLinks?.[bk]} isBest={isBest} bk={bk} style={{ fontSize: 9 }} />
                  </span>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Today tab — birthday/hometown tables + top-5 snapshot per board ──
function TodayBoard({ scanData, scanComplete, scanProgress, games, season, onSelectBatter, onSelectPitcher, lineupData, babyBumpPlayers = [], probableFor = null }) {
  const isMobile = useIsMobile();
  const BOARD_ORDER = ["hits","hrr","hits15","hr","tb","sb","rbi"];
  const players = scanData?.players || [];
  const lineupActive = lineupData && Object.keys(lineupData).length > 0;

  const [elapsed, setElapsed] = useState(0);
  const scanStartRef = useRef(null);
  useEffect(() => {
    if (scanComplete) return;
    if (!scanStartRef.current) scanStartRef.current = Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - scanStartRef.current) / 1000)), 1000);
    return () => clearInterval(id);
  }, [scanComplete]);

  const inLineup = (name, team) => {
    if (!lineupActive) return true;
    const tl = lineupData[team];
    if (!tl?.batters?.length || tl.batters.length < 8) return true; // incomplete lineup — keep all
    return tl.batters.some(b => _normName(b.name) === _normName(name));
  };

  // ── Birthdays / Near-Hometown: read directly from the active rosters of teams
  // playing today (the same source the Games view & BatterPanel use), bulk-fetching
  // bios. Independent of the model scan — the scan only covers players who have a
  // projection AND races lineup load, which silently dropped lineup players like a
  // backup C/DH the projection file doesn't carry. Entries are enriched with the
  // player's scan pick (Proj/Conf/L5) when one exists.
  const [flagPlayers, setFlagPlayers] = useState({ birthday: [], hometown: [], promos: [] });
  const gameKey = (games || []).map(g => g.gamePk).join(",");
  useEffect(() => {
    if (!games || games.length === 0 || !season) { setFlagPlayers({ birthday: [], hometown: [], promos: [] }); return; }
    let cancelled = false;
    (async () => {
      const todayStr = getTodayInAppTimeZone();
      // One slot per team playing today, tagged with its game + side.
      const teamSlots = [];
      const seen = new Set();
      for (const game of games) {
        for (const side of ["home", "away"]) {
          const teamId = game.teams?.[side]?.team?.id;
          if (!teamId || seen.has(teamId)) continue;
          seen.add(teamId);
          teamSlots.push({ teamId, teamAbbrev: game.teams[side].team.abbreviation, game, side });
        }
      }
      const rosters = await Promise.all(teamSlots.map(async s => {
        try { return { ...s, roster: await getRoster(s.teamId, season) }; }
        catch { return { ...s, roster: [] }; }
      }));
      const candidates = [];
      for (const s of rosters) {
        for (const r of s.roster) {
          if (r.status?.code !== "A" || r.position?.type === "Pitcher") continue;
          candidates.push({ slot: s, person: r.person, position: r.position });
        }
      }
      const bioById = await getBulkBios(candidates.map(c => c.person.id));
      if (cancelled) return;
      const scanById = new Map((scanData?.players || []).map(p => [p.playerId, p]));
      const birthday = [], hometown = [];
      for (const c of candidates) {
        const bio = bioById[c.person.id];
        if (!bio) continue;
        const homeAbbrev = c.slot.game.teams?.home?.team?.abbreviation;
        const flags = computePlayerFlags({ bio, homeAvg: null, awayAvg: null, parkAbbrev: homeAbbrev, today: todayStr });
        if (!flags.birthday && !flags.hometown) continue;
        const scanned = scanById.get(c.person.id);
        const oppSide = c.slot.side === "home" ? "away" : "home";
        const oppTeam = c.slot.game.teams?.[oppSide]?.team;
        // probableFor folds in the Rotowire-resolved starter when StatsAPI still says TBD.
        // Scanned players carry a null oppPitcherId in that case (the scan only reads
        // StatsAPI), so patch them too — otherwise the row shows no starter and the panel
        // opens with no matchup.
        const oppPitcher = probableFor
          ? probableFor(c.slot.game, oppSide)
          : c.slot.game.teams?.[oppSide]?.probablePitcher;
        const entry = scanned
          ? {
              ...scanned,
              flags: { ...scanned.flags, ...flags },
              oppPitcher:   (scanned.oppPitcher && scanned.oppPitcher !== "TBD") ? scanned.oppPitcher : (oppPitcher?.fullName || "TBD"),
              oppPitcherId: scanned.oppPitcherId ?? oppPitcher?.id ?? null,
            }
          : {
              name: c.person.fullName,
              playerId: c.person.id,
              team: c.slot.teamAbbrev,
              position: c.position?.abbreviation || "?",
              batSide: bio.batSide?.code || null,
              opponent: oppTeam?.abbreviation || "?",
              oppPitcher: oppPitcher?.fullName || "TBD",
              oppPitcherId: oppPitcher?.id || null,
              isHome: c.slot.side === "home",
              venue: c.slot.game.venue?.name || "",
              game: c.slot.game,
              flags,
            };
        if (flags.birthday) birthday.push(entry);
        if (flags.hometown) hometown.push(entry);
      }

      // 🎁 Promo Night — giveaways tied to a specific player who is on the home
      // team's active roster today (status A). The honored player is always on the
      // home club, so we match each home game's date against the static promo data
      // and keep only items whose resolved player is active and thus playing today.
      const promos = [];
      for (const game of games) {
        const homeTeam = game.teams?.home?.team;
        if (!homeTeam?.abbreviation) continue;
        const rec = (PROMOTIONS.teams?.[homeTeam.abbreviation] || []).find(r => r.date === todayStr);
        if (!rec?.items?.length) continue;
        const homeRoster = rosters.find(s => s.teamId === homeTeam.id)?.roster || [];
        const activeById = new Map(homeRoster.filter(r => r.status?.code === "A").map(r => [r.person.id, r]));
        const oppTeam = game.teams?.away?.team;
        const oppPitcher = probableFor ? probableFor(game, "away") : game.teams?.away?.probablePitcher;
        for (const it of rec.items) {
          const rosterEntry = it.playerId ? activeById.get(it.playerId) : null;
          if (!rosterEntry) continue; // player-tied + active only
          promos.push({
            playerId: it.playerId,
            name: it.player,
            promo: it.name,
            pitcher: !!it.pitcher,
            team: homeTeam.abbreviation,
            opp: oppTeam?.abbreviation || "",
            position: rosterEntry.position?.abbreviation || "?",
            oppPitcher: oppPitcher?.fullName || "TBD",
            oppPitcherId: oppPitcher?.id || null,
            hand: rosterEntry.person?.pitchHand?.code || null,
            isHome: true,
            venue: game.venue?.name || "",
            game,
          });
        }
      }
      setFlagPlayers({ birthday, hometown, promos });
    })();
    return () => { cancelled = true; };
  }, [gameKey, season, scanComplete, probableFor]); // eslint-disable-line react-hooks/exhaustive-deps

  const birthdayPlayers = flagPlayers.birthday;
  const hometownPlayers = flagPlayers.hometown;

  // Merge baby bump transaction data with scan player data
  const babyBumpDisplay = babyBumpPlayers.map(bp => {
    const scanPlayer = players.find(p => p.playerId === bp.playerId);
    if (scanPlayer) return { ...scanPlayer, babyBump: true, gamesRemaining: bp.gamesRemaining, pitcher: bp.pitcher, hand: bp.hand };
    return { playerId: bp.playerId, name: bp.name, team: bp.teamName, opponent: null, flags: {}, babyBump: true, gamesRemaining: bp.gamesRemaining, pitcher: bp.pitcher, position: bp.position, hand: bp.hand };
  });

  // 🎁 Promo Night — player-tied giveaways for active players playing today. Built
  // in the flag effect above (needs rosters for the active-player gate). Static
  // seasonal promo data lives in scripts/scrape-promotions.mjs → promotions.json.
  const promoToday = flagPlayers.promos;

  const cell = { background: "rgba(210,217,236,0.6)", border: "1px solid rgba(32,98,200,0.16)", borderRadius: 10, padding: "14px 16px" };
  const secTitle = { fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1.2, color: "#2062c8", marginBottom: 10 };

  // Helper: find a player's best-scoring board pick from byModel
  function getBestPick(player) {
    let best = null;
    for (const [bk, picks] of Object.entries(scanData?.byModel || {})) {
      const pick = picks.find(p => p.playerId === player.playerId && !p.watch);
      if (!pick) continue;
      if (!best || (pick.score || 0) > (best.score || 0)) best = { ...pick, boardKey: bk };
    }
    return best;
  }

  function FlagTable({ emoji, title, list, emptyMsg }) {
    return (
      <div style={cell}>
        <div style={secTitle}>{emoji} {title}</div>
        {list.length === 0 ? (
          <div style={{ fontSize: 12, color: "#b6c5dc", textAlign: "center", padding: "12px 0" }}>{emptyMsg}</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th className="th-sm" style={{ textAlign: "left" }}>Player</th>
                <th className="th-sm">Team</th>
                <th className="th-sm">Opp</th>
              </tr>
            </thead>
            <tbody>
              {list.map((p, i) => {
                const bp = getBestPick(p);
                return (
                  <tr key={p.playerId || i} onClick={() => p.pitcher
                      ? onSelectPitcher({ pitcherId: p.playerId, name: p.name, hand: p.hand, team: p.team })
                      : onSelectBatter(bp || p)} style={{ cursor: "pointer", transition: "background 0.15s" }}
                    onMouseEnter={e => e.currentTarget.style.background = "rgba(32,98,200,0.112)"}
                    onMouseLeave={e => e.currentTarget.style.background = ""}>
                    <td className="td-sm" style={{ textAlign: "left", color: "#3c4f6d", fontWeight: 600 }}>
                      {p.babyBump && <span style={{ marginRight: 4 }}>👶</span>}{p.name}
                      <PlayerFlagBadges flags={p.flags} size={12} />
                    </td>
                    <td className="td-sm">{p.team}</td>
                    <td className="td-sm" style={{ fontSize: 11 }}>
                      <div>{p.opponent ? `${p.isHome === false ? "@" : ""}${p.opponent}` : "—"}</div>
                      {p.oppPitcher && p.oppPitcher !== "TBD" && (
                        <div style={{ fontSize: 9, color: "#8b99b0" }}>{p.oppPitcher.split(" ").pop()}{p.oppPitcherHand ? ` (${p.oppPitcherHand})` : ""}</div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    );
  }

  function PromoCard({ list }) {
    const openPromo = (r) => {
      if (r.pitcher) onSelectPitcher({ pitcherId: r.playerId, name: r.name, hand: r.hand, team: r.team });
      else onSelectBatter({ playerId: r.playerId, name: r.name, position: r.position, team: r.team,
        oppPitcherId: r.oppPitcherId, oppPitcher: r.oppPitcher, opponent: r.opp, isHome: r.isHome, game: r.game, venue: r.venue });
    };
    return (
      <div style={cell}>
        <div style={secTitle}>🎁 Promo Night</div>
        {list.length === 0 ? (
          <div style={{ fontSize: 12, color: "#b6c5dc", textAlign: "center", padding: "12px 0" }}>No giveaways today</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th className="th-sm" style={{ textAlign: "left" }}>Player</th>
                <th className="th-sm hide-mobile">Tm</th>
                <th className="th-sm hide-mobile">Opp</th>
                <th className="th-sm" style={{ textAlign: "left" }}>Giveaway</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r, i) => (
                <tr key={r.playerId || i} onClick={() => openPromo(r)} style={{ cursor: "pointer", transition: "background 0.15s" }}
                  onMouseEnter={e => e.currentTarget.style.background = "rgba(32,98,200,0.112)"}
                  onMouseLeave={e => e.currentTarget.style.background = ""}>
                  <td className="td-sm" style={{ textAlign: "left", color: "#3c4f6d", fontWeight: 600, verticalAlign: "top" }}>{r.name}</td>
                  <td className="td-sm hide-mobile" style={{ verticalAlign: "top" }}>{r.team}</td>
                  <td className="td-sm hide-mobile" style={{ verticalAlign: "top" }}>{r.opp || "—"}</td>
                  <td className="td-sm" style={{ textAlign: "left", color: "#2c3d5c", fontSize: 11, lineHeight: 1.3 }}>{trimPromoName(r.promo, r.name)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    );
  }

  function TopFiveCard({ boardKey }) {
    const cfg = BOARD_CONFIGS[boardKey];
    const [cardSort, setCardSort] = useState("proj"); // per-card toggle
    if (!cfg) return null;
    const allPicks = (scanData?.byModel?.[boardKey] || []).filter(p => !p.watch && inLineup(p.name, p.team));
    const picks = [...allPicks].sort((a, b) =>
      cardSort === "conf"
        ? calcConfidence(b.score, boardKey, b) - calcConfidence(a.score, boardKey, a)
        : (b.score || 0) - (a.score || 0)
    ).slice(0, 5);
    const btnStyle = (mode) => ({
      padding: "1px 6px", fontSize: 9, fontWeight: 600, borderRadius: 6,
      background: cardSort === mode ? "rgba(32,98,200,0.18)" : "rgba(22,44,80,0.04)",
      border: "1px solid rgba(32,98,200,0.24)",
      color: cardSort === mode ? "#2062c8" : "#8b99b0", cursor: "pointer",
    });
    return (
      <div style={{ ...cell, padding: "12px 14px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ fontSize: 14 }}>{cfg.emoji}</span>
            <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, color: "#2062c8" }}>{cfg.label}</span>
          </div>
          <div style={{ display: "flex", gap: 3 }}>
            <button style={btnStyle("proj")} onClick={() => setCardSort("proj")}>Proj</button>
            <button style={btnStyle("conf")} onClick={() => setCardSort("conf")}>Conf</button>
          </div>
        </div>
        {picks.length === 0 ? (
          <div style={{ fontSize: 11, color: "#b6c5dc", textAlign: "center", padding: "8px 0" }}>No picks yet</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            {/* Column headers */}
            <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "0 6px", marginBottom: 4 }}>
              <span style={{ width: 12, flexShrink: 0 }} />
              <span style={{ flex: 1, minWidth: 0 }} />
              <span style={{ fontSize: 9, color: "#b6c5dc", fontFamily: "'JetBrains Mono',monospace", minWidth: 28, flexShrink: 0 }}>L5</span>
              <span style={{ fontSize: 9, color: "#b6c5dc", fontFamily: "'JetBrains Mono',monospace", minWidth: 38, flexShrink: 0 }}>PROJ</span>
              <span style={{ fontSize: 9, color: "#b6c5dc", fontFamily: "'JetBrains Mono',monospace", minWidth: 22, textAlign: "right", flexShrink: 0 }}>CONF</span>
              {["fanduel","draftkings","hardrockbet"].map(bk => (
                <span key={bk} style={{ fontSize: 9, color: BOOK_COLORS[bk], minWidth: 30, textAlign: "right", flexShrink: 0, fontWeight: 700 }}>{BOOK_ABBR[bk]}</span>
              ))}
            </div>
            {picks.map((p, i) => {
              const conf = calcConfidence(p.score, boardKey, p);
              const books = ["fanduel","draftkings","hardrockbet"];
              const allPrices = books.map(b => p.bookOdds?.[b]).filter(v => v != null);
              const bestPrice = allPrices.length > 0 ? Math.max(...allPrices) : null;
              const impliedProb = p.impliedProb ?? null;
              const evVal = impliedProb != null && bestPrice != null ? calcEVFromOdds(impliedProb, bestPrice) : null;
              const isEV = evVal != null && evVal > 0.03;
              const l5 = p.rateL5;
              const bestLine = p.bestLine;
              const displayLine = p.bookLine ?? bestLine?.line;
              return (
                <div key={p.playerId || i} onClick={() => onSelectBatter(p)}
                  style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 6px", borderRadius: 6, cursor: "pointer", transition: "background 0.15s" }}
                  onMouseEnter={e => e.currentTarget.style.background = "rgba(32,98,200,0.128)"}
                  onMouseLeave={e => e.currentTarget.style.background = ""}>
                  <span style={{ fontSize: 10, color: "#b6c5dc", fontFamily: "'JetBrains Mono',monospace", width: 12, flexShrink: 0 }}>{i + 1}</span>
                  <div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
                    <div style={{ fontSize: 11, color: "#3c4f6d", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {p.name}
                    </div>
                    {displayLine != null && (
                      <div style={{ fontSize: 9, color: "#a16207", marginTop: 1 }}>O{displayLine}</div>
                    )}
                  </div>
                  {/* L5 hit rate */}
                  <span style={{ fontSize: 10, fontFamily: "'JetBrains Mono',monospace", minWidth: 28, flexShrink: 0,
                    color: l5 != null ? (l5 >= 0.6 ? "#0f8a44" : l5 >= 0.4 ? "#a16207" : "#d03131") : "#b6c5dc" }}>
                    {l5 != null ? (l5 * 100).toFixed(0) + "%" : "—"}
                  </span>
                  <span style={{ fontSize: 10, fontFamily: "'JetBrains Mono',monospace", color: "#2062c8", minWidth: 38, flexShrink: 0 }}>
                    {cfg.projFn(p.score)}
                    {isEV && <span style={{ fontSize: 8, color: "#a16207", fontWeight: 700, background: "rgba(161,98,7,0.15)", borderRadius: 3, padding: "0 3px", marginLeft: 3 }}>EV</span>}
                  </span>
                  <span style={{ fontSize: 9, fontFamily: "'JetBrains Mono',monospace", minWidth: 22, textAlign: "right", flexShrink: 0,
                    color: conf >= 8 ? "#0f8a44" : conf >= 6 ? "#4c5f7d" : "#74839d" }}>{conf.toFixed(1)}</span>
                  {books.map(bk => {
                    const price = p.bookOdds?.[bk] ?? null;
                    const isBest = price != null && price === bestPrice && bestPrice != null;
                    return (
                      <span key={bk} style={{ minWidth: 30, textAlign: "right", flexShrink: 0 }}>
                        <OddsLink price={price} url={p.bookLinks?.[bk]} isBest={isBest} bk={bk} style={{ fontSize: 9 }} />
                      </span>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  if (!scanComplete) {
    const pct = Math.round((scanProgress?.done / Math.max(scanProgress?.total || 1, 1)) * 100);
    return (
      <div style={{ padding: "40px 20px", textAlign: "center" }}>
        <div style={{ fontSize: 28, marginBottom: 12 }}>📅</div>
        <div style={{ fontSize: 16, fontWeight: 600, color: "#3c4f6d", marginBottom: 8 }}>Loading Today's Data</div>
        <div style={{ fontSize: 12, color: "#74839d", marginBottom: 20 }}>Scanning {games.length} game{games.length !== 1 ? "s" : ""} — {scanProgress?.done || 0} / {scanProgress?.total || "?"} players ({pct}%)</div>
        <div style={{ width: 240, height: 4, background: "rgba(32,98,200,0.16)", borderRadius: 2, margin: "0 auto" }}>
          <div style={{ height: "100%", width: `${pct}%`, background: "linear-gradient(90deg,#2062c8,#2563eb)", borderRadius: 2, transition: "width 0.3s" }} />
        </div>
        <div style={{ fontSize: 11, color: "#b6c5dc", marginTop: 16 }}>
          {(() => {
            if (pct <= 0 || elapsed < 2) return "Estimating time…";
            const totalEst = Math.round(elapsed / (pct / 100));
            const remaining = Math.max(0, totalEst - elapsed);
            if (remaining === 0) return "Almost done…";
            return `~${remaining} Second${remaining !== 1 ? "s" : ""} Left`;
          })()}
        </div>
      </div>
    );
  }

  // Sort boards: those with picks first (preserve BOARD_ORDER within each group)
  const orderedBoards = [...BOARD_ORDER].sort((a, b) => {
    const aLen = scanData?.byModel?.[a]?.filter(p => !p.watch).length || 0;
    const bLen = scanData?.byModel?.[b]?.filter(p => !p.watch).length || 0;
    if (aLen > 0 && bLen === 0) return -1;
    if (aLen === 0 && bLen > 0) return 1;
    return 0;
  });

  return (
    <div className="fade-up" style={{ padding: isMobile ? "12px" : "20px" }}>
      {/* Birthday + Hometown + Baby Bump + Promo Night — top of page, 4-across on desktop */}
      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr 1fr 1fr", gap: 16, marginBottom: 16 }}>
        <FlagTable emoji="🎂" title="Birthdays Today" list={birthdayPlayers} emptyMsg="No birthdays today" />
        <FlagTable emoji="👨‍👩‍👧" title="Playing Near Hometown" list={hometownPlayers} emptyMsg="No hometown games today" />
        <FlagTable emoji="👶" title="Baby Bump" list={babyBumpDisplay} emptyMsg="No new dads this week" />
        <PromoCard list={promoToday} />
      </div>

      {/* Weather Report — full width below flags */}
      <WeatherReport games={games} />
    </div>
  );
}


// ══════════════════════════════════════════════════════════
// ── MATCHUP EVALUATOR ──
// Scout-style batter vs pitcher analysis with arsenal breakdown
// ══════════════════════════════════════════════════════════

function MatchupEdgeBadge({ score }) {
  if (score > 1.5)  return <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 7px", borderRadius: 10, background: "rgba(15,138,68,0.15)", color: "#0f8a44", letterSpacing: 0.5 }}>BATTER ADV</span>;
  if (score > 0.4)  return <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 7px", borderRadius: 10, background: "rgba(15,138,68,0.08)", color: "#1c9a50", letterSpacing: 0.5 }}>slight batter</span>;
  if (score < -1.5) return <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 7px", borderRadius: 10, background: "rgba(208,49,49,0.15)", color: "#d03131", letterSpacing: 0.5 }}>PITCHER ADV</span>;
  if (score < -0.4) return <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 7px", borderRadius: 10, background: "rgba(208,49,49,0.08)", color: "#c25555", letterSpacing: 0.5 }}>slight pitcher</span>;
  return <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 7px", borderRadius: 10, background: "rgba(100,116,139,0.15)", color: "#6d7c96", letterSpacing: 0.5 }}>neutral</span>;
}

function ScoutInsight({ icon, category, text, edge }) {
  const edgeColors = { batter: "#0f8a44", pitcher: "#d03131", neutral: "#6d7c96", home: "#2569d6", road: "#6d4fd0" };
  const edgeLabels = { batter: "BATTER ADV", pitcher: "PITCHER ADV", neutral: "NEUTRAL", home: "HOME BOOST", road: "ROAD EDGE" };
  const c = edgeColors[edge] || edgeColors.neutral;
  return (
    <div style={{ background: "rgba(210,217,236,0.5)", borderLeft: `3px solid ${c}`, borderRadius: "0 8px 8px 0", padding: "10px 14px", display: "flex", alignItems: "flex-start", gap: 12 }}>
      <span style={{ fontSize: 16, flexShrink: 0 }}>{icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 10, color: c, textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 3, fontWeight: 600 }}>{category}</div>
        <div style={{ fontSize: 12, color: "#3c4f6d", lineHeight: 1.6 }}>{text}</div>
      </div>
      <div style={{ fontSize: 9, fontWeight: 700, color: c, letterSpacing: 0.5, flexShrink: 0, textTransform: "uppercase", paddingTop: 2 }}>{edgeLabels[edge] || ""}</div>
    </div>
  );
}

function StatMini({ label, value, color }) {
  return (
    <div style={{ textAlign: "center", minWidth: 40 }}>
      <div style={{ fontSize: 9, color: "#8b99b0", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 700, color: color || "#16233c" }}>{value ?? "—"}</div>
    </div>
  );
}

function MatchupArsenalRow({ code, name, usage, velo, savant, bvp, batterVelo }) {
  const col = PITCH_COLORS[code] || "#6d7c96";
  // Edge score: positive = batter advantage
  let edgeScore = 0;
  if (bvp?.rv100 != null)  edgeScore += bvp.rv100 * 0.5;
  if (bvp?.woba != null)   edgeScore += (bvp.woba - 0.320) * 5;
  if (bvp?.whiff != null)  edgeScore -= (bvp.whiff - 25) * 0.08;

  const batAVG  = bvp?.ba != null ? bvp.ba.toFixed(3) : null;
  const batWOBA = bvp?.woba != null ? bvp.woba.toFixed(3) : null;
  const batWhiff = bvp?.whiff != null ? bvp.whiff.toFixed(1) + "%" : null;
  const batHH   = bvp?.hardHit != null ? bvp.hardHit.toFixed(1) + "%" : null;
  const batXW   = bvp?.xwoba != null ? bvp.xwoba.toFixed(3) : null;
  const batRV   = bvp?.rv100 != null ? (bvp.rv100 > 0 ? "+" : "") + bvp.rv100.toFixed(1) : null;

  // Velocity delta: pitcher's velo vs what batter typically faces for this pitch type
  const veloDelta = batterVelo != null && velo > 0 ? (velo - batterVelo) : null;
  const veloNote = veloDelta != null ? `${veloDelta > 0 ? "+" : ""}${veloDelta.toFixed(1)} mph vs avg seen` : null;

  return (
    <div style={{ background: "rgba(210,217,236,0.55)", border: `1px solid ${col}22`, borderRadius: 10, padding: "14px 16px", marginBottom: 8 }}>
      {/* Header row */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ background: col + "22", border: `1px solid ${col}66`, color: col, borderRadius: 4, padding: "2px 7px", fontSize: 11, fontWeight: 700, fontFamily: "monospace" }}>{code}</span>
          <span style={{ fontSize: 14, fontWeight: 700, color: "#16233c" }}>{name || PITCH_LABELS[code] || code}</span>
          <span style={{ fontSize: 11, color: "#74839d" }}>{usage.toFixed(1)}% usage</span>
          {velo > 0 && <span style={{ fontSize: 11, color: "#5d6f8b" }}>· {velo.toFixed(1)} mph{veloNote ? <span style={{ color: veloDelta > 0.8 ? "#c2570f" : veloDelta < -0.8 ? "#0f8a44" : "#6d7c96", marginLeft: 4 }}>({veloNote})</span> : ""}</span>}
        </div>
        <MatchupEdgeBadge score={edgeScore} />
      </div>
      {/* Usage bar */}
      <div style={{ height: 3, background: "#e8edf6", borderRadius: 2, marginBottom: 12 }}>
        <div style={{ height: "100%", width: `${Math.min(usage * 2, 100)}%`, background: col + "88", borderRadius: 2 }} />
      </div>
      {/* Two-column stats */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        {/* Pitcher side */}
        <div style={{ background: "rgba(208,49,49,0.06)", borderRadius: 7, padding: "8px 12px" }}>
          <div style={{ fontSize: 9, color: "#d03131", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 8, fontWeight: 600 }}>Pitcher (all batters)</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
            {savant?.whiff  != null && <StatMini label="Whiff%" value={savant.whiff.toFixed(1) + "%"} color={savant.whiff > 28 ? "#d03131" : "#16233c"} />}
            {savant?.kPct   != null && <StatMini label="K%" value={savant.kPct.toFixed(1) + "%"} color="#16233c" />}
            {savant?.putAway!= null && <StatMini label="Put-Away" value={savant.putAway.toFixed(1) + "%"} color="#16233c" />}
            {savant?.rv100  != null && <StatMini label="RV/100" value={(savant.rv100 < 0 ? "" : "+") + savant.rv100.toFixed(1)} color={savant.rv100 < -1 ? "#0f8a44" : savant.rv100 > 1 ? "#d03131" : "#16233c"} />}
          </div>
        </div>
        {/* Batter side */}
        <div style={{ background: "rgba(32,98,200,0.096)", borderRadius: 7, padding: "8px 12px" }}>
          <div style={{ fontSize: 9, color: "#2062c8", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 8, fontWeight: 600 }}>Batter (vs this pitch)</div>
          {bvp ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
              {batAVG  && <StatMini label="BA" value={batAVG}  color={bvp.ba > 0.300 ? "#0f8a44" : bvp.ba < 0.200 ? "#d03131" : "#16233c"} />}
              {batWOBA && <StatMini label="wOBA" value={batWOBA} color={bvp.woba > 0.380 ? "#0f8a44" : bvp.woba < 0.300 ? "#d03131" : "#16233c"} />}
              {batXW   && <StatMini label="xwOBA" value={batXW} color="#6d4fd0" />}
              {batWhiff && <StatMini label="Whiff%" value={batWhiff} color={bvp.whiff > 30 ? "#d03131" : bvp.whiff < 15 ? "#0f8a44" : "#16233c"} />}
              {batHH   && <StatMini label="HardHit" value={batHH} color={bvp.hardHit > 45 ? "#0f8a44" : "#16233c"} />}
              {batRV   && <StatMini label="RV/100" value={batRV} color={bvp.rv100 > 2 ? "#0f8a44" : bvp.rv100 < 0 ? "#d03131" : "#16233c"} />}
              {bvp.pa  > 0 && <StatMini label="PA" value={bvp.pa} color="#6d7c96" />}
            </div>
          ) : <div style={{ fontSize: 11, color: "#b6c5dc", paddingTop: 4 }}>No data for this pitch type</div>}
        </div>
      </div>
    </div>
  );
}

function MatchupReport({ batter, pitcher, batterBio, pitcherBio, batterSplits, pitcherSplits, batterStats, pitcherStats, pitcherMlbArsenal, savantArsenal, bvPitch, batterMlbArsenal, h2h, year }) {
  const bHand = batterBio?.batSide?.code || "?";
  const pHand = pitcherBio?.pitchHand?.code || "?";
  const batterRelevantCode = pHand === "L" ? "vl" : "vr";
  const pitcherRelevantCode = bHand === "L" ? "vl" : "vr";

  const bHandSplit  = batterSplits?.find(s => s.split?.code === batterRelevantCode)?.stat;
  const pHandSplit  = pitcherSplits?.find(s => s.split?.code === pitcherRelevantCode)?.stat;
  const bHomeSplit  = batterSplits?.find(s => s.split?.code === "h")?.stat;
  const bAwaySplit  = batterSplits?.find(s => s.split?.code === "a")?.stat;
  const pHomeSplit  = pitcherSplits?.find(s => s.split?.code === "h")?.stat;
  const pAwaySplit  = pitcherSplits?.find(s => s.split?.code === "a")?.stat;

  // Build batter avg velocity seen per pitch type map for velocity delta
  const batterVeloMap = {};
  for (const split of (batterMlbArsenal || [])) {
    const code = split.stat?.type?.code;
    const avgSpd = split.stat?.averageSpeed;
    if (code && avgSpd) batterVeloMap[code] = parseFloat(avgSpd);
  }

  // Build arsenal matchup rows sorted by usage descending
  const arsenalRows = (pitcherMlbArsenal || [])
    .map(split => ({
      code: split.stat?.type?.code,
      name: split.stat?.type?.description,
      usage: (split.stat?.percentage || 0) * 100,
      velo: split.stat?.averageSpeed || 0,
      savant: savantArsenal?.[split.stat?.type?.code] || {},
      bvp: bvPitch?.[split.stat?.type?.code] || null,
      batterVelo: batterVeloMap[split.stat?.type?.code] || null,
    }))
    .filter(r => r.code)
    .sort((a, b) => b.usage - a.usage);

  // Scout insights
  const insights = [];
  const matchupLabel = `${bHand}HB vs ${pHand}HP`;

  if (bHandSplit && pHandSplit) {
    const bOPS = parseFloat(bHandSplit.ops);
    const pBAA = parseFloat(pHandSplit.avg);
    const pERA = parseFloat(pHandSplit.era);
    const bStrong = bOPS > 0.820, bWeak = bOPS < 0.700;
    const pStrong = pBAA < 0.230 || pERA < 3.00, pWeak = pBAA > 0.265 || pERA > 4.50;
    let edge = "neutral", text = "";
    if (bStrong && !pStrong)      { edge = "batter"; text = `${batter?.person?.fullName} is dangerous in ${matchupLabel} matchups, posting ${!isNaN(bOPS) ? bOPS.toFixed(3) + " OPS" : "strong numbers"} vs ${pHand === "L" ? "left" : "right"}-handers.`; }
    else if (pStrong && !bWeak)   { edge = "pitcher"; text = `${pitcher?.person?.fullName} dominates ${bHand === "L" ? "left" : "right"}-handed batters: ${!isNaN(pBAA) ? pBAA.toFixed(3) + " BAA" : ""}${!isNaN(pERA) ? ", " + pERA.toFixed(2) + " ERA" : ""} in this split.`; }
    else if (bWeak && pStrong)    { edge = "pitcher"; text = `Double pitcher edge: batter struggles vs ${pHand === "L" ? "LHP" : "RHP"} (${!isNaN(bOPS) ? bOPS.toFixed(3) + " OPS" : "—"}) and pitcher dominates ${bHand === "L" ? "LHB" : "RHB"} (${!isNaN(pBAA) ? pBAA.toFixed(3) + " BAA" : "—"}).`; }
    else                           { edge = "neutral"; text = `Relatively even ${matchupLabel}: batter at ${!isNaN(bOPS) ? bOPS.toFixed(3) + " OPS" : "—"} vs ${pHand === "L" ? "LHP" : "RHP"}, pitcher at ${!isNaN(pBAA) ? pBAA.toFixed(3) + " BAA" : "—"} vs ${bHand === "L" ? "LHB" : "RHB"}.`; }
    insights.push({ icon: "⚔️", category: matchupLabel, text, edge });
  }

  // Home/Away edge
  const bHomeOPS = parseFloat(bHomeSplit?.ops), bAwayOPS = parseFloat(bAwaySplit?.ops);
  if (!isNaN(bHomeOPS) && !isNaN(bAwayOPS) && Math.abs(bHomeOPS - bAwayOPS) > 0.075) {
    const home = bHomeOPS > bAwayOPS;
    insights.push({ icon: "🏠", category: "Venue Factor", text: `${batter?.person?.fullName} hits notably ${home ? "better at home" : "better on the road"}: ${bHomeOPS.toFixed(3)} OPS home vs ${bAwayOPS.toFixed(3)} away.`, edge: home ? "home" : "road" });
  }

  // Pitcher's best weapon vs this batter
  const weaponPitch = arsenalRows.filter(r => r.bvp?.whiff > 27 && r.usage > 7).sort((a, b) => b.bvp.whiff - a.bvp.whiff)[0];
  if (weaponPitch) {
    const freq = weaponPitch.usage > 20 ? "primary pitch" : "secondary weapon";
    insights.push({ icon: "🎯", category: "Pitcher's Weapon", text: `${weaponPitch.name || weaponPitch.code} is the key pitch — batter misses ${weaponPitch.bvp.whiff.toFixed(1)}% of attempts. Used ${weaponPitch.usage.toFixed(1)}% of the time (${freq}). Watch for this early in counts.`, edge: "pitcher" });
  }

  // Batter's sweet spot
  const sweetSpot = arsenalRows.filter(r => r.bvp?.woba > 0.375 && r.usage > 7).sort((a, b) => (b.bvp?.woba || 0) - (a.bvp?.woba || 0))[0];
  if (sweetSpot) {
    insights.push({ icon: "💪", category: "Batter's Sweet Spot", text: `${sweetSpot.name || sweetSpot.code} is where ${batter?.person?.fullName} thrives: ${sweetSpot.bvp.ba?.toFixed(3) || "—"} BA, ${sweetSpot.bvp.woba?.toFixed(3) || "—"} wOBA. Makes up ${sweetSpot.usage.toFixed(1)}% of this pitcher's arsenal.`, edge: "batter" });
  }

  // Velocity context
  const veloRows = arsenalRows.filter(r => r.batterVelo != null && r.velo > 0 && Math.abs(r.velo - r.batterVelo) > 0.7);
  if (veloRows.length > 0) {
    const above = veloRows.filter(r => r.velo - r.batterVelo > 0.7);
    const below = veloRows.filter(r => r.batterVelo - r.velo > 0.7);
    if (above.length > 0) insights.push({ icon: "🔥", category: "Velocity Edge", text: `${pitcher?.person?.fullName} throws ${above.map(r => `${r.code} at ${r.velo.toFixed(1)} mph (${(r.velo - r.batterVelo).toFixed(1)} above avg seen)`).join("; ")} — potential velocity advantage.`, edge: "pitcher" });
    if (below.length > 0) insights.push({ icon: "🌊", category: "Velocity Concern", text: `${below.map(r => `${r.code} at ${r.velo.toFixed(1)} mph (${(r.batterVelo - r.velo).toFixed(1)} below avg the batter faces)`).join("; ")} — batter may be sitting on this velocity.`, edge: "batter" });
  }

  // H2H
  const h2hStat = h2h?.career?.[0]?.stat;
  if (h2hStat?.atBats >= 5) {
    const avg = parseFloat(h2hStat.avg);
    insights.push({ icon: "📋", category: "Career H2H", text: `${h2hStat.atBats} career AB: ${h2hStat.avg} AVG, ${h2hStat.homeRuns || 0} HR, ${h2hStat.strikeOuts || 0} K, ${h2hStat.baseOnBalls || 0} BB. ${h2hStat.atBats >= 15 ? "Meaningful sample." : "Small sample — use as context only."}`, edge: avg > 0.275 ? "batter" : avg < 0.175 ? "pitcher" : "neutral" });
  }

  // Overall composite edge
  const batEdgeCount = arsenalRows.filter(r => { let s = 0; if (r.bvp?.rv100 != null) s += r.bvp.rv100 * 0.5; if (r.bvp?.woba) s += (r.bvp.woba - 0.32) * 5; return s > 0.5; }).length;
  const pitEdgeCount = arsenalRows.filter(r => { let s = 0; if (r.bvp?.rv100 != null) s += r.bvp.rv100 * 0.5; if (r.bvp?.woba) s += (r.bvp.woba - 0.32) * 5; return s < -0.5; }).length;

  const sectionStyle = { marginBottom: 20 };
  const headerStyle = { fontSize: 10, color: "#6d7c96", textTransform: "uppercase", letterSpacing: 1.2, marginBottom: 10, fontWeight: 600 };

  return (
    <div>
      {/* Matchup header */}
      <div style={{ background: "linear-gradient(135deg, rgba(32,98,200,0.112), rgba(208,49,49,0.07))", border: "1px solid rgba(32,98,200,0.24)", borderRadius: 12, padding: "18px 20px", marginBottom: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
          <div>
            <div style={{ fontSize: 22, fontWeight: 800, color: "#16233c", marginBottom: 4 }}>
              <span style={{ color: "#2062c8" }}>{batter?.person?.fullName || "Batter"}</span>
              <span style={{ color: "#8b99b0", fontWeight: 400, margin: "0 10px" }}>vs</span>
              <span style={{ color: "#d03131" }}>{pitcher?.person?.fullName || "Pitcher"}</span>
            </div>
            <div style={{ fontSize: 12, color: "#6d7c96" }}>
              {bHand}HB · Bats {bHand === "L" ? "Left" : bHand === "S" ? "Switch" : "Right"} · #{batter?.jerseyNumber || "—"}
              &nbsp;&nbsp;|&nbsp;&nbsp;
              {pHand}HP · Throws {pHand === "L" ? "Left" : "Right"} · #{pitcher?.jerseyNumber || "—"}
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 10, color: "#8b99b0", textTransform: "uppercase", letterSpacing: 1 }}>{year} Season</div>
            <div style={{ fontSize: 13, color: "#5d6f8b", marginTop: 3, fontWeight: 600 }}>{matchupLabel}</div>
            <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", marginTop: 6 }}>
              {batEdgeCount > pitEdgeCount && <span style={{ fontSize: 10, background: "rgba(15,138,68,0.15)", color: "#0f8a44", padding: "2px 8px", borderRadius: 8, fontWeight: 700 }}>Batter Favored ({batEdgeCount}/{arsenalRows.length} pitches)</span>}
              {pitEdgeCount > batEdgeCount && <span style={{ fontSize: 10, background: "rgba(208,49,49,0.15)", color: "#d03131", padding: "2px 8px", borderRadius: 8, fontWeight: 700 }}>Pitcher Favored ({pitEdgeCount}/{arsenalRows.length} pitches)</span>}
              {batEdgeCount === pitEdgeCount && <span style={{ fontSize: 10, background: "rgba(100,116,139,0.15)", color: "#6d7c96", padding: "2px 8px", borderRadius: 8, fontWeight: 700 }}>Even Matchup</span>}
            </div>
          </div>
        </div>
      </div>

      {/* Scout Brief */}
      {insights.length > 0 && (
        <div style={sectionStyle}>
          <div style={headerStyle}>Scout Brief</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            {insights.map((ins, i) => <ScoutInsight key={i} {...ins} />)}
          </div>
        </div>
      )}

      {/* Splits grid */}
      <div style={sectionStyle}>
        <div style={headerStyle}>Splits Comparison</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          {/* Batter */}
          <div style={{ background: "rgba(32,98,200,0.08)", border: "1px solid rgba(32,98,200,0.192)", borderRadius: 10, padding: 14 }}>
            <div style={{ fontSize: 10, color: "#2062c8", textTransform: "uppercase", letterSpacing: 1, marginBottom: 10, fontWeight: 600 }}>
              {batter?.person?.fullName?.split(" ").pop()} — Hitting
            </div>
            {[
              { label: `vs ${pHand === "L" ? "LHP" : "RHP"} (this matchup)`, stat: bHandSplit },
              { label: "Home", stat: bHomeSplit },
              { label: "Away", stat: bAwaySplit },
            ].map(({ label, stat }) => (
              <div key={label} style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 9, color: "#8b99b0", textTransform: "uppercase", letterSpacing: 0.7, marginBottom: 4 }}>{label}</div>
                {stat ? (
                  <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 12, color: "#16233c" }}>{stat.avg || "—"} AVG</span>
                    <span style={{ fontSize: 13, fontWeight: 700, color: parseFloat(stat.ops) > 0.850 ? "#0f8a44" : parseFloat(stat.ops) < 0.650 ? "#d03131" : "#16233c" }}>{stat.ops || "—"} OPS</span>
                    <span style={{ fontSize: 11, color: "#6d7c96" }}>{stat.homeRuns ?? 0} HR · {stat.strikeOuts ?? 0} K</span>
                  </div>
                ) : <div style={{ fontSize: 11, color: "#c9d5e8" }}>No data</div>}
              </div>
            ))}
            {batterStats && Object.keys(batterStats).length > 0 && (
              <div style={{ borderTop: "1px solid rgba(32,98,200,0.128)", paddingTop: 8, marginTop: 4 }}>
                <div style={{ fontSize: 9, color: "#8b99b0", textTransform: "uppercase", letterSpacing: 0.7, marginBottom: 4 }}>Full Season {year}</div>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 12, color: "#16233c" }}>{batterStats.avg || "—"} AVG</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: "#16233c" }}>{batterStats.ops || "—"} OPS</span>
                  <span style={{ fontSize: 11, color: "#6d7c96" }}>{batterStats.homeRuns || 0} HR · {batterStats.plateAppearances || 0} PA</span>
                </div>
              </div>
            )}
          </div>
          {/* Pitcher */}
          <div style={{ background: "rgba(208,49,49,0.05)", border: "1px solid rgba(208,49,49,0.12)", borderRadius: 10, padding: 14 }}>
            <div style={{ fontSize: 10, color: "#d03131", textTransform: "uppercase", letterSpacing: 1, marginBottom: 10, fontWeight: 600 }}>
              {pitcher?.person?.fullName?.split(" ").pop()} — Pitching
            </div>
            {[
              { label: `vs ${bHand === "L" ? "LHB" : "RHB"} (this matchup)`, stat: pHandSplit },
              { label: "Home", stat: pHomeSplit },
              { label: "Away", stat: pAwaySplit },
            ].map(({ label, stat }) => (
              <div key={label} style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 9, color: "#8b99b0", textTransform: "uppercase", letterSpacing: 0.7, marginBottom: 4 }}>{label}</div>
                {stat ? (
                  <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: parseFloat(stat.era) < 3.00 ? "#0f8a44" : parseFloat(stat.era) > 5.00 ? "#d03131" : "#16233c" }}>{stat.era || "—"} ERA</span>
                    <span style={{ fontSize: 12, color: "#16233c" }}>{stat.whip || "—"} WHIP</span>
                    <span style={{ fontSize: 11, color: "#6d7c96" }}>{stat.avg || "—"} BAA · {stat.strikeOuts ?? 0} K</span>
                  </div>
                ) : <div style={{ fontSize: 11, color: "#c9d5e8" }}>No data</div>}
              </div>
            ))}
            {pitcherStats && Object.keys(pitcherStats).length > 0 && (
              <div style={{ borderTop: "1px solid rgba(208,49,49,0.08)", paddingTop: 8, marginTop: 4 }}>
                <div style={{ fontSize: 9, color: "#8b99b0", textTransform: "uppercase", letterSpacing: 0.7, marginBottom: 4 }}>Full Season {year}</div>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: parseFloat(pitcherStats.era) < 3.00 ? "#0f8a44" : parseFloat(pitcherStats.era) > 5.00 ? "#d03131" : "#16233c" }}>{pitcherStats.era || "—"} ERA</span>
                  <span style={{ fontSize: 12, color: "#16233c" }}>{pitcherStats.whip || "—"} WHIP</span>
                  <span style={{ fontSize: 11, color: "#6d7c96" }}>{pitcherStats.strikeOuts || 0} K · {pitcherStats.inningsPitched || 0} IP</span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* H2H */}
      {h2hStat?.atBats >= 3 && (
        <div style={{ ...sectionStyle, background: "rgba(161,98,7,0.05)", border: "1px solid rgba(161,98,7,0.15)", borderRadius: 10, padding: 14 }}>
          <div style={{ ...headerStyle, color: "#a16207" }}>Head to Head (Career)</div>
          <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
            {[["AB", h2hStat.atBats], ["H", h2hStat.hits], ["HR", h2hStat.homeRuns], ["BB", h2hStat.baseOnBalls], ["K", h2hStat.strikeOuts], ["AVG", h2hStat.avg], ["OBP", h2hStat.obp], ["OPS", h2hStat.ops]].map(([l, v]) => (
              <div key={l} style={{ textAlign: "center" }}>
                <div style={{ fontSize: 9, color: "#74839d", textTransform: "uppercase" }}>{l}</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: "#16233c" }}>{v ?? "—"}</div>
              </div>
            ))}
          </div>
          {h2hStat.atBats < 15 && <div style={{ fontSize: 10, color: "#cdb589", marginTop: 6 }}>⚠ Small sample ({h2hStat.atBats} AB) — use as context only</div>}
        </div>
      )}

      {/* Arsenal breakdown */}
      {arsenalRows.length > 0 && (
        <div style={sectionStyle}>
          <div style={headerStyle}>Arsenal Breakdown — How Batter Fares vs Each Pitch</div>
          {arsenalRows.map(row => <MatchupArsenalRow key={row.code} {...row} />)}
          <div style={{ marginTop: 8, padding: "8px 12px", background: "rgba(210,217,236,0.3)", borderRadius: 8, fontSize: 10, color: "#b6c5dc" }}>
            RV/100 = run value per 100 pitches. Positive (batter side) = favorable for batter. Velocity delta = pitcher's avg vs what this batter typically sees across all pitchers.
          </div>
        </div>
      )}
    </div>
  );
}

// ── DAILY BRIEFING ──

const BRIEFING_EXAMPLE = {
  date: "Opening Day 2026",
  games: 15,
  headline: "Season Opener: 15 Games Across the Slate — All Eyes on Ohtani & The Return of Soto",

  hotBats: [
    { name: "Juan Soto",    team: "NYM", pos: "RF",  recent: ".412 / .538 / .882",  note: "12-for-29 in spring, 5 BB — elite plate discipline primed to carry over", score: 94, streak: "Spring: 12-for-29" },
    { name: "Bobby Witt Jr.", team: "KC", pos: "SS", recent: ".381 / .421 / .762",  note: "Hit .303 last year with 37 SB — best all-around player not named Ohtani entering 2026", score: 91, streak: "Proj .303 AVG" },
    { name: "Aaron Judge",  team: "NYY", pos: "RF",  recent: ".333 / .500 / .867",  note: "Back from injury, reported fully healthy in camp — .309 Proj avg with 53 HR upside", score: 89, streak: "Camp: 10-for-30" },
    { name: "Shohei Ohtani",team: "LAD", pos: "DH",  recent: ".295 / .402 / .797",  note: "Full season as two-way returns — proj .287 avg, 50 HR, 20+ W as pitcher. MLB's marquee event", score: 97, streak: "Season Projection" },
  ],

  coldBats: [
    { name: "Matt Olson",   team: "ATL", pos: "1B",  note: "Slow spring (.198 avg in Grapefruit League), mechanical questions flagged by scouts", flag: "Watch" },
    { name: "Mookie Betts", team: "LAD", pos: "RF",  note: "Hand injury in late spring — listed as day-to-day, batting order spot uncertain for opener", flag: "Injury" },
    { name: "Byron Buxton", team: "MIN", pos: "CF",  note: "Missed final 2 weeks of spring, hamstring tightness. Questionable for opener", flag: "Injury" },
  ],

  matchupEdges: [
    {
      type: "batter",
      player: "Kyle Schwarber",
      team: "PHI",
      opponent: "vs RHP",
      edge: ".289 / .405 / .612 career vs RHP — elite ISO, 43 HR projection",
      context: "Facing a debut RHP starter in opener — first look matchup favors veteran eye",
      score: 88,
      emoji: "🏏",
    },
    {
      type: "pitcher",
      player: "Kodai Senga",
      team: "NYM",
      opponent: "vs MIL Lineup",
      edge: "Ghost fork generated 42% whiff rate in 2024 — MIL K'd 24.3% of PA vs RHP",
      context: "Milwaukee lineup rebuilt in offseason, facing one of NL's nastiest arsenal openers",
      score: 86,
      emoji: "⚾",
    },
    {
      type: "batter",
      player: "Yordan Alvarez",
      team: "HOU",
      opponent: "vs LHP",
      edge: ".341 / .453 / .701 career vs LHP — one of baseball's most dominant lefty killers",
      context: "Projected opponent opens with a southpaw — textbook platoon advantage",
      score: 91,
      emoji: "🏏",
    },
    {
      type: "pitcher",
      player: "Zack Wheeler",
      team: "PHI",
      opponent: "vs ATL Lineup",
      edge: "2.58 ERA vs ATL last 3 years — familiar foes, Wheeler has dominated this club",
      context: "Opening series rivalry matchup. Wheeler's sinker-cutter combo has puzzled Braves bats historically",
      score: 83,
      emoji: "⚾",
    },
    {
      type: "batter",
      player: "Francisco Lindor",
      team: "NYM",
      opponent: "vs Debut Starters",
      edge: ".282 career avg on Opening Day — 6 HR in 8 career openers, elevated in big moments",
      context: "Lindor historically elevates performance in spotlight games — Opening Day track record is elite",
      score: 80,
      emoji: "🏏",
    },
  ],

  analystNotes: [
    { icon: "📈", title: "Pitcher-Friendly Conditions Across Midwest",   body: "Low temperatures and heavier air in Chicago, Cleveland, and Kansas City suppress exit velocity — expect lower-scoring games in those markets today. Under bets may have value." },
    { icon: "⚡", title: "Closer Landscape Is Wide Open",                body: "At least 8 teams enter 2026 without a locked-in closer — expect bullpen-by-committee early. K-props for middle-inning arms could be undervalued while roles shake out." },
    { icon: "🌡️", title: "Coors Stays a Launching Pad",                  body: "Denver projects 72°F with low humidity for the Rockies opener. Ball carries exceptionally well — over bets and HR props deserve a premium vs projections." },
    { icon: "🔄", title: "League-Wide Rule Changes: Pitch Timer Year 3",  body: "Games averaged 2h 39m in 2025, down from 3h 3m pre-timer. Pace-of-play continues to favor relievers less in-between-inning recovery time — K rates for relief arms may dip slightly in April." },
    { icon: "👁️", title: "Prospect Watch: Jackson Holliday Era Begins",    body: "Holliday enters as Baltimore's projected leadoff man after a dominant spring. First MLB full season for a generational talent — track his on-base numbers closely." },
  ],

  commissionerPicks: [
    { player: "Shohei Ohtani",  team: "LAD", type: "Two-Way",     why: "Opening Day is Ohtani's stage. Taking the mound + batting 2nd — full spectacle. HR prop and K prop both in play.",         confidence: "MUST WATCH" },
    { player: "Juan Soto",      team: "NYM", type: "Batter",       why: "Entering his prime at 27, new lineup protection, facing a shaky bullpen late. Over 0.5 hits has high probability from any opener.",  confidence: "HIGH" },
    { player: "Aaron Judge",    team: "NYY", type: "Power",        why: "53 HR projection with return to full health. First AB of the year in Yankee Stadium — if healthy, this is a legitimate 600-foot threat.",  confidence: "HIGH" },
  ],
};

function DailyBriefing({ games = [], date }) {
  const ex = BRIEFING_EXAMPLE;

  const ScorePill = ({ score, size = "sm" }) => {
    const color = score >= 88 ? "#0f8a44" : score >= 78 ? "#2569d6" : score >= 68 ? "#a16207" : "#c2570f";
    const bg = score >= 88 ? "rgba(15,138,68,0.12)" : score >= 78 ? "rgba(37,105,214,0.12)" : score >= 68 ? "rgba(161,98,7,0.12)" : "rgba(194,87,15,0.12)";
    return (
      <span style={{
        fontSize: size === "lg" ? 13 : 10, fontWeight: 700, color, background: bg,
        padding: size === "lg" ? "3px 10px" : "2px 7px", borderRadius: 6,
        border: `1px solid ${color}33`, fontFamily: "'JetBrains Mono', monospace",
      }}>{score}</span>
    );
  };

  return (
    <div style={{ padding: "0 0 40px", maxWidth: 980, margin: "0 auto" }}>

      {/* Coming Soon Banner */}
      <div style={{
        background: "linear-gradient(135deg, rgba(194,87,15,0.15), rgba(161,98,7,0.1))",
        border: "1px solid rgba(194,87,15,0.3)", borderRadius: 0,
        padding: "10px 24px", display: "flex", alignItems: "center", gap: 10,
        borderBottom: "1px solid rgba(194,87,15,0.25)",
      }}>
        <span style={{ fontSize: 14 }}>🚧</span>
        <div>
          <span style={{ fontSize: 11, fontWeight: 700, color: "#c2570f", textTransform: "uppercase", letterSpacing: 1 }}>Preview Mode</span>
          <span style={{ fontSize: 11, color: "#c1a178", marginLeft: 8 }}>— Daily Briefing goes live once the 2026 season begins. Showing example layout below.</span>
        </div>
      </div>

      <div style={{ padding: "24px 24px 0" }}>
        {/* Header */}
        <div style={{ marginBottom: 24 }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
            <div>
              <div style={{ fontSize: 10, color: "#c2570f", textTransform: "uppercase", letterSpacing: 2, marginBottom: 4, fontWeight: 700 }}>
                Commissioner's Daily Briefing · {ex.date}
              </div>
              <div style={{ fontSize: 22, fontWeight: 800, color: "#16233c", lineHeight: 1.2, maxWidth: 680 }}>{ex.headline}</div>
              <div style={{ fontSize: 12, color: "#8b99b0", marginTop: 6 }}>
                {ex.games} games on the slate · Prepared by MLB Research Dashboard · Auto-generated analysis
              </div>
            </div>
            <div style={{ background: "rgba(32,98,200,0.096)", border: "1px solid rgba(32,98,200,0.24)", borderRadius: 10, padding: "10px 16px", textAlign: "center", minWidth: 100 }}>
              <div style={{ fontSize: 28, fontWeight: 800, color: "#2062c8" }}>{ex.games}</div>
              <div style={{ fontSize: 10, color: "#8b99b0", textTransform: "uppercase", letterSpacing: 1 }}>Games Today</div>
            </div>
          </div>
        </div>

        {/* Commissioner's Top Picks (full width) */}
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 10, color: "#c2570f", textTransform: "uppercase", letterSpacing: 1.5, fontWeight: 700, marginBottom: 12, display: "flex", alignItems: "center", gap: 6 }}>
            <span>⭐</span> Commissioner's Top Picks
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
            {ex.commissionerPicks.map((p, i) => {
              const confColor = p.confidence === "MUST WATCH" ? "#c2570f" : "#2062c8";
              const confBg    = p.confidence === "MUST WATCH" ? "rgba(194,87,15,0.12)" : "rgba(32,98,200,0.16)";
              return (
                <div key={i} style={{ background: "rgba(213,221,237,0.5)", border: "1px solid rgba(32,98,200,0.192)", borderRadius: 12, padding: 16, position: "relative", overflow: "hidden" }}>
                  <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: confColor, opacity: 0.6 }} />
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                    <div>
                      <span style={{ fontSize: 13, fontWeight: 800, color: "#16233c" }}>{p.player}</span>
                      <span style={{ fontSize: 10, color: "#8b99b0", marginLeft: 6 }}>{p.team} · {p.type}</span>
                    </div>
                    <span style={{ fontSize: 9, fontWeight: 700, color: confColor, background: confBg, padding: "2px 7px", borderRadius: 4, border: `1px solid ${confColor}33` }}>{p.confidence}</span>
                  </div>
                  <div style={{ fontSize: 11, color: "#64748d", lineHeight: 1.5 }}>{p.why}</div>
                </div>
              );
            })}
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 24 }}>
          {/* Hot Bats */}
          <div>
            <div style={{ fontSize: 10, color: "#0f8a44", textTransform: "uppercase", letterSpacing: 1.5, fontWeight: 700, marginBottom: 12, display: "flex", alignItems: "center", gap: 6 }}>
              <span>🔥</span> Hot Hand Report
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {ex.hotBats.map((p, i) => (
                <div key={i} style={{ background: "rgba(213,221,237,0.5)", border: "1px solid rgba(15,138,68,0.1)", borderRadius: 10, padding: "12px 14px", display: "flex", gap: 12, alignItems: "flex-start" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: "#16233c" }}>{p.name}</span>
                      <span style={{ fontSize: 10, color: "#8b99b0" }}>{p.team} · {p.pos}</span>
                    </div>
                    <div style={{ fontSize: 10, color: "#0f8a44", fontFamily: "'JetBrains Mono', monospace", marginBottom: 4 }}>{p.streak} · {p.recent}</div>
                    <div style={{ fontSize: 11, color: "#74839d", lineHeight: 1.4 }}>{p.note}</div>
                  </div>
                  <ScorePill score={p.score} />
                </div>
              ))}
            </div>
          </div>

          {/* Matchup Edges */}
          <div>
            <div style={{ fontSize: 10, color: "#2569d6", textTransform: "uppercase", letterSpacing: 1.5, fontWeight: 700, marginBottom: 12, display: "flex", alignItems: "center", gap: 6 }}>
              <span>🎯</span> Matchup Edges
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {ex.matchupEdges.map((m, i) => {
                const typeColor = m.type === "batter" ? "#2062c8" : "#c2570f";
                return (
                  <div key={i} style={{ background: "rgba(213,221,237,0.5)", border: `1px solid ${typeColor}18`, borderRadius: 10, padding: "12px 14px" }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontSize: 12 }}>{m.emoji}</span>
                        <span style={{ fontSize: 13, fontWeight: 700, color: "#16233c" }}>{m.player}</span>
                        <span style={{ fontSize: 10, color: "#8b99b0" }}>{m.team}</span>
                        <span style={{ fontSize: 9, color: typeColor, background: `${typeColor}15`, padding: "1px 6px", borderRadius: 4, fontWeight: 600, textTransform: "uppercase" }}>{m.type}</span>
                      </div>
                      <ScorePill score={m.score} />
                    </div>
                    <div style={{ fontSize: 10, color: "#2569d6", fontFamily: "'JetBrains Mono', monospace", marginBottom: 3 }}>{m.opponent}</div>
                    <div style={{ fontSize: 10, color: "#0f8a44", marginBottom: 3 }}>{m.edge}</div>
                    <div style={{ fontSize: 10, color: "#a3b2c9", lineHeight: 1.4 }}>{m.context}</div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
          {/* Analyst Notes */}
          <div>
            <div style={{ fontSize: 10, color: "#a16207", textTransform: "uppercase", letterSpacing: 1.5, fontWeight: 700, marginBottom: 12, display: "flex", alignItems: "center", gap: 6 }}>
              <span>📋</span> Analyst's Notes
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {ex.analystNotes.map((n, i) => (
                <div key={i} style={{ background: "rgba(213,221,237,0.4)", border: "1px solid rgba(161,98,7,0.08)", borderRadius: 10, padding: "12px 14px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 5 }}>
                    <span style={{ fontSize: 14 }}>{n.icon}</span>
                    <span style={{ fontSize: 11, fontWeight: 700, color: "#9c8412" }}>{n.title}</span>
                  </div>
                  <div style={{ fontSize: 11, color: "#74839d", lineHeight: 1.5 }}>{n.body}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Caution Flags */}
          <div>
            <div style={{ fontSize: 10, color: "#c62828", textTransform: "uppercase", letterSpacing: 1.5, fontWeight: 700, marginBottom: 12, display: "flex", alignItems: "center", gap: 6 }}>
              <span>🧊</span> Caution Flags
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {ex.coldBats.map((p, i) => {
                const fc = p.flag === "Injury" ? "#c62828" : "#c2570f";
                return (
                  <div key={i} style={{ background: "rgba(213,221,237,0.4)", border: "1px solid rgba(198,40,40,0.1)", borderRadius: 10, padding: "12px 14px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 5 }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: "#16233c" }}>{p.name}</span>
                      <span style={{ fontSize: 10, color: "#8b99b0" }}>{p.team} · {p.pos}</span>
                      <span style={{ fontSize: 9, fontWeight: 700, color: fc, background: `${fc}18`, padding: "1px 6px", borderRadius: 4, border: `1px solid ${fc}30` }}>{p.flag}</span>
                    </div>
                    <div style={{ fontSize: 11, color: "#74839d", lineHeight: 1.4 }}>{p.note}</div>
                  </div>
                );
              })}
            </div>

            {/* Data sources note */}
            <div style={{ marginTop: 16, background: "rgba(32,98,200,0.064)", border: "1px solid rgba(32,98,200,0.128)", borderRadius: 10, padding: "12px 14px" }}>
              <div style={{ fontSize: 10, color: "#2062c8", fontWeight: 700, marginBottom: 6, textTransform: "uppercase", letterSpacing: 1 }}>📡 When Live, This Page Will Pull:</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {["Last 7 / 14 / 30-day rolling batter stats", "Real-time pitcher injury & lineup statuses", "Park factor + weather adjustment overlays", "Historical batter vs pitcher matchup data", "Bullpen fatigue & usage flags"].map((item, i) => (
                  <div key={i} style={{ fontSize: 10, color: "#b0c2da", display: "flex", alignItems: "center", gap: 6 }}>
                    <div style={{ width: 4, height: 4, borderRadius: "50%", background: "#bccbdf" }} />
                    {item}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── BULLPEN SCORING HELPERS ──────────────────────────────────────────────────

function getRelieverRole(p) {
  if ((p.saves || 0) >= 5 && (p.gamesFinished || 0) >= 8) return "Closer";
  if ((p.holds || 0) >= 5 || ((p.gamesFinished || 0) >= 3 && (p.saves || 0) < 5)) return "Setup";
  return "Middle Relief";
}

// Shared z-score normalizer: returns 0-100 where 50 = MLB average
function bullpenNorm(val, avg, sd, higherBetter) {
  if (val == null) return null;
  const z = (val - avg) / sd;
  return Math.max(0, Math.min(100, 50 + (higherBetter ? z : -z) * 25));
}

// MLB reliever averages (calibrated to recent seasons)
const BPAvg = { xera: 4.2, kPct: 23, bbPct: 9.0, whiff: 27, hardHit: 37 };
const BPSd  = { xera: 0.8, kPct: 4,  bbPct: 1.8, whiff: 4,  hardHit: 5  };

function calcBullpenScore(enriched) {
  if (!enriched.length) return null;
  let totBF = 0, totK = 0, totBB = 0, totIR = 0, totIRS = 0;
  // IP-weighted Savant averages — workhorse relievers count proportionally more
  let xeraW = 0, xeraIP = 0, whiffW = 0, whiffIP = 0;
  let hhW = 0, hhIP = 0, xwobaW = 0, xwobaIP = 0;
  for (const p of enriched) {
    const ip = p.ip || 0;
    totBF  += p.battersFaced || 0;
    totK   += p.strikeOuts   || 0;
    totBB  += p.baseOnBalls  || 0;
    totIR  += p.inheritedRunners || 0;
    totIRS += p.inheritedRunnersScored || 0;
    if (p.xera    != null && ip > 0) { xeraW  += p.xera    * ip; xeraIP  += ip; }
    if (p.whiff   != null && ip > 0) { whiffW += p.whiff   * ip; whiffIP += ip; }
    if (p.hardHit != null && ip > 0) { hhW    += p.hardHit * ip; hhIP    += ip; }
    if (p.xwoba   != null && ip > 0) { xwobaW += p.xwoba   * ip; xwobaIP += ip; }
  }
  const kPct       = totBF > 0 ? (totK / totBF) * 100 : null;
  const bbPct      = totBF > 0 ? (totBB / totBF) * 100 : null;
  const strandRate = totIR > 0 ? ((totIR - totIRS) / totIR) * 100 : null;
  const avgXera    = xeraIP  > 0 ? xeraW  / xeraIP  : null;
  const avgWhiff   = whiffIP > 0 ? whiffW / whiffIP : null;
  const avgHardHit = hhIP    > 0 ? hhW    / hhIP    : null;
  const avgXwoba   = xwobaIP > 0 ? xwobaW / xwobaIP : null;

  const kScore       = bullpenNorm(kPct,       BPAvg.kPct,   BPSd.kPct,   true);
  const bbScore      = bullpenNorm(bbPct,       BPAvg.bbPct,  BPSd.bbPct,  false);
  const xeraScore    = bullpenNorm(avgXera,     BPAvg.xera,   BPSd.xera,   false);
  const whiffScore   = bullpenNorm(avgWhiff,    BPAvg.whiff,  BPSd.whiff,  true);
  const hardHitScore = bullpenNorm(avgHardHit,  BPAvg.hardHit,BPSd.hardHit,false);

  // Strand rate shown as context but not scored (too luck-influenced for aggregates)
  const weights = [
    [xeraScore, 0.30], [kScore, 0.22], [bbScore, 0.18],
    [whiffScore, 0.15], [hardHitScore, 0.15],
  ];
  let wSum = 0, wTot = 0;
  for (const [v, w] of weights) { if (v != null) { wSum += v * w; wTot += w; } }
  const score = wTot > 0 ? Math.round(wSum / wTot) : null;
  return {
    score, kPct, bbPct, strandRate, avgXera, avgWhiff, avgHardHit, avgXwoba,
    kScore, bbScore, xeraScore, whiffScore, hardHitScore,
    count: enriched.length,
  };
}

// Per-pitcher composite score (requires ≥10 IP)
function calcPitcherScore(p) {
  if (!p || (p.ip || 0) < 10) return null;
  const scores = [
    [bullpenNorm(p.xera,    BPAvg.xera,    BPSd.xera,    false), 0.30],
    [bullpenNorm(p.kPct,    BPAvg.kPct,    BPSd.kPct,    true),  0.22],
    [bullpenNorm(p.bbPct,   BPAvg.bbPct,   BPSd.bbPct,   false), 0.18],
    [bullpenNorm(p.whiff,   BPAvg.whiff,   BPSd.whiff,   true),  0.15],
    [bullpenNorm(p.hardHit, BPAvg.hardHit, BPSd.hardHit, false), 0.15],
  ];
  let wSum = 0, wTot = 0;
  for (const [v, w] of scores) { if (v != null) { wSum += v * w; wTot += w; } }
  return wTot > 0 ? Math.round(wSum / wTot) : null;
}

function bullpenGrade(score) {
  if (score == null) return "–";
  if (score >= 88) return "A+"; if (score >= 80) return "A"; if (score >= 73) return "A-";
  if (score >= 67) return "B+"; if (score >= 61) return "B"; if (score >= 55) return "B-";
  if (score >= 49) return "C+"; if (score >= 43) return "C"; if (score >= 37) return "C-";
  if (score >= 31) return "D+"; if (score >= 25) return "D"; return "F";
}

function bullpenGradeColor(score) {
  if (score == null) return "#6d7c96";
  if (score >= 67) return "#0f8a44";
  if (score >= 49) return "#a16207";
  if (score >= 37) return "#c2570f";
  return "#c62828";
}

// ── BULLPEN PANEL ─────────────────────────────────────────────────────────────

// Results constants and math (PROP_LABELS_R, pickLabel, CONF_TIERS, OVERHAULS,
// window helpers, computeDashboardStats) moved to src/lib/results.js in the
// 2026-08-10 Results revamp; the UI is src/components/results/.

// SlateOddsTab moved to src/components/SlateOdds.jsx (2026-08-14). Its pure odds
// reshaping and the book landing pages went to src/lib/gameOdds.js; its three
// Savant/MLB-API loaders stay here (this module owns their promise caches) and
// are injected through the `dataSources` prop.

// ── FINDINGS TAB ── (mining-cron output dashboard)
// ══════════════════════════════════════════════════════════
// Browses mining_findings — the living catalog of statistical patterns the
// daily mining cron has discovered. Each row is one (cycle × market × feature × type)
// finding with effect size, BH-FDR q-value, lifecycle status, and drift vs prior cycle.
// Sortable / filterable by market, status, type. Clicking a row expands raw_data.
function FindingsTab() {
  const [findings, setFindings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [market, setMarket] = useState("all");
  const [status, setStatus] = useState("active");
  const [type, setType] = useState("all");
  const [sort, setSort] = useState("effect"); // effect | q | recent
  const [expandedId, setExpandedId] = useState(null);

  useEffect(() => {
    setLoading(true); setErr(null);
    const params = new URLSearchParams();
    if (market !== "all") params.set("market", market);
    if (status !== "all") params.set("status", status);
    if (type !== "all")   params.set("type",   type);
    params.set("limit", "500");
    fetch(`/api/findings?${params.toString()}`)
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(data => setFindings(data || []))
      .catch(e => setErr(String(e)))
      .finally(() => setLoading(false));
  }, [market, status, type]);

  const sorted = useMemo(() => {
    if (!findings) return [];
    const arr = [...findings];
    if (sort === "effect") arr.sort((a, b) => Math.abs(b.effect_size || 0) - Math.abs(a.effect_size || 0));
    else if (sort === "q") arr.sort((a, b) => (a.q_value ?? 1) - (b.q_value ?? 1));
    else if (sort === "recent") arr.sort((a, b) => (b.cycle_id || "").localeCompare(a.cycle_id || ""));
    return arr;
  }, [findings, sort]);

  const MARKETS = ["all", "hits", "hr", "tb", "hrr", "sb", "rbi", "ks", "ml", "rl", "ou"];
  const STATUSES = ["all", "active", "stale", "promoted", "rejected", "inactive"];
  const TYPES = ["all", "univariate", "interaction", "cluster"];

  const fmtEffect = (e) => e == null ? "—" : (e >= 0 ? "+" : "") + (e * 100).toFixed(1) + "pp";
  const fmtQ = (q) => q == null ? "—" : q < 0.001 ? q.toExponential(1) : q.toFixed(3);
  const fmtDelta = (d) => d == null ? null : (d >= 0 ? "+" : "") + (d * 100).toFixed(1) + "pp";
  const statusColor = (s) => ({
    active:   "#0f8a44",
    stale:    "#5d6b82",
    promoted: "#6d4fd0",
    rejected: "#d03131",
    inactive: "#74839d",
  }[s] || "#4c5f7d");

  return (
    <div style={{ padding: "20px 16px", maxWidth: 1400, margin: "0 auto" }}>
      <div style={{ marginBottom: 18 }}>
        <h2 style={{ fontSize: 18, color: "#16233c", margin: 0, fontWeight: 700, display: "flex", alignItems: "center", gap: 8 }}>
          <span>🔍</span> Mining Findings
          <span style={{ fontSize: 11, color: "#74839d", fontWeight: 400 }}>· daily pattern-discovery output</span>
        </h2>
        <div style={{ fontSize: 11, color: "#74839d", marginTop: 4, lineHeight: 1.6 }}>
          Univariate Q1→Q4 cash spreads, pairwise interactions, and k=4 cluster lifts across every captured Savant atom + model intermediate.
          BH-FDR-adjusted q-values keep multiple-comparison noise in check. Status transitions: <strong>active</strong> (q ≤ 0.10) →
          <strong> stale</strong> (unseen 7d+) → <strong>promoted</strong> (wired into models.js).
        </div>
      </div>

      {/* Filter bar */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16, padding: "10px 12px", background: "rgba(210,217,236,0.4)", borderRadius: 8, border: "1px solid rgba(32,98,200,0.128)" }}>
        <Filter label="Market" value={market} options={MARKETS} onChange={setMarket} />
        <Filter label="Status" value={status} options={STATUSES} onChange={setStatus} />
        <Filter label="Type"   value={type}   options={TYPES}    onChange={setType} />
        <Filter label="Sort"   value={sort}   options={["effect", "q", "recent"]} onChange={setSort} />
      </div>

      {loading && <Loader text="Loading findings…" />}
      {err && <div style={{ color: "#d03131", fontSize: 12 }}>Error: {err}</div>}
      {!loading && findings && findings.length === 0 && (
        <div style={{ color: "#74839d", textAlign: "center", padding: "40px 0", fontSize: 12 }}>
          No findings match the current filters. {status === "active" && "Try widening to all statuses or wait for the next mining cycle (daily 11 AM ET)."}
        </div>
      )}

      {!loading && sorted.length > 0 && (
        <div style={{ background: "rgba(222,226,241,0.7)", borderRadius: 8, border: "1px solid rgba(32,98,200,0.128)", overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: "55px 110px 70px 1fr 70px 90px 70px 70px 110px 70px", padding: "8px 12px", background: "rgba(210,217,236,0.6)", borderBottom: "1px solid rgba(32,98,200,0.16)", fontSize: 9, color: "#8b99b0", textTransform: "uppercase", letterSpacing: 0.6, fontWeight: 700 }}>
            <div>Market</div>
            <div>Cycle</div>
            <div>Type</div>
            <div>Feature</div>
            <div style={{ textAlign: "right" }}>N</div>
            <div style={{ textAlign: "right" }}>Effect</div>
            <div style={{ textAlign: "right" }}>Δ prev</div>
            <div style={{ textAlign: "right" }}>q</div>
            <div style={{ textAlign: "center" }}>Direction</div>
            <div style={{ textAlign: "center" }}>Status</div>
          </div>
          {sorted.map(f => {
            const isExp = expandedId === f.id;
            return (
              <div key={f.id}>
                <div onClick={() => setExpandedId(isExp ? null : f.id)} style={{
                  display: "grid", gridTemplateColumns: "55px 110px 70px 1fr 70px 90px 70px 70px 110px 70px",
                  padding: "7px 12px", borderBottom: isExp ? "none" : "1px solid rgba(32,98,200,0.064)",
                  alignItems: "center", cursor: "pointer", fontSize: 11,
                  background: isExp ? "rgba(32,98,200,0.064)" : "transparent",
                }}>
                  <div style={{ fontWeight: 700, color: "#2062c8", textTransform: "uppercase", fontSize: 10 }}>{f.market}</div>
                  <div style={{ color: "#64748d", fontFamily: "'JetBrains Mono',monospace", fontSize: 10 }}>{f.cycle_id}</div>
                  <div style={{ color: "#4c5f7d", fontSize: 9, textTransform: "uppercase" }}>{f.finding_type.slice(0, 5)}</div>
                  <div style={{ color: "#16233c", fontFamily: "'JetBrains Mono',monospace", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={f.feature}>{f.feature}</div>
                  <div style={{ textAlign: "right", color: "#5d6f8b", fontFamily: "'JetBrains Mono',monospace" }}>{f.n}</div>
                  <div style={{ textAlign: "right", fontWeight: 700, color: f.effect_size >= 0 ? "#0f8a44" : "#d03131", fontFamily: "'JetBrains Mono',monospace" }}>{fmtEffect(f.effect_size)}</div>
                  <div style={{ textAlign: "right", color: f.effect_delta == null ? "#b6c5dc" : f.effect_delta >= 0 ? "#65a30d" : "#a16207", fontFamily: "'JetBrains Mono',monospace", fontSize: 10 }}>{fmtDelta(f.effect_delta) || "—"}</div>
                  <div style={{ textAlign: "right", color: f.q_value != null && f.q_value < 0.05 ? "#0f8a44" : "#5d6f8b", fontFamily: "'JetBrains Mono',monospace", fontSize: 10 }}>{fmtQ(f.q_value)}</div>
                  <div style={{ textAlign: "center", color: "#4c5f7d", fontSize: 9, textTransform: "uppercase" }}>{f.direction || "—"}</div>
                  <div style={{ textAlign: "center", fontSize: 9, textTransform: "uppercase", fontWeight: 700, color: statusColor(f.status) }}>{f.status}</div>
                </div>
                {isExp && (
                  <div style={{ padding: "10px 14px 14px", background: "rgba(32,98,200,0.064)", borderBottom: "1px solid rgba(32,98,200,0.096)", fontSize: 10, color: "#4c5f7d", lineHeight: 1.6 }}>
                    <div style={{ fontSize: 9, color: "#8b99b0", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 6, fontWeight: 700 }}>Raw analysis output</div>
                    <pre style={{ background: "rgba(222,226,241,0.9)", padding: 10, borderRadius: 6, overflowX: "auto", fontSize: 10, color: "#3c4f6d", margin: 0 }}>
                      {JSON.stringify(f.raw_data, null, 2)}
                    </pre>
                    <div style={{ marginTop: 8, fontSize: 9, color: "#74839d" }}>
                      First seen: <strong style={{ color: "#4c5f7d" }}>{f.first_seen || "—"}</strong>
                      {" · "}Last seen: <strong style={{ color: "#4c5f7d" }}>{f.last_seen || "—"}</strong>
                      {f.prior_effect != null && (<>{" · "}Prior effect: <strong style={{ color: "#4c5f7d" }}>{fmtEffect(f.prior_effect)}</strong></>)}
                      {f.monotonic && (<>{" · "}<span style={{ color: "#0f8a44" }}>monotonic Q1→Q4 ✓</span></>)}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Small filter chip set used by FindingsTab.
function Filter({ label, value, options, onChange }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span style={{ fontSize: 10, color: "#74839d", textTransform: "uppercase", letterSpacing: 0.6, fontWeight: 700 }}>{label}</span>
      <div style={{ display: "flex", gap: 4 }}>
        {options.map(o => (
          <button key={o} onClick={() => onChange(o)} style={{
            padding: "3px 9px", fontSize: 10, borderRadius: 4, cursor: "pointer",
            border: value === o ? "1px solid #2062c8" : "1px solid #c9d5e8",
            background: value === o ? "rgba(32,98,200,0.24)" : "rgba(210,217,236,0.4)",
            color: value === o ? "#2062c8" : "#5d6f8b",
            fontWeight: value === o ? 700 : 400,
            textTransform: "uppercase", letterSpacing: 0.4,
          }}>{o}</button>
        ))}
      </div>
    </div>
  );
}


function BullpenPanel({ season }) {
  const [teams, setTeams]         = useState([]);
  const [teamId, setTeamId]       = useState("");
  const [bullpenYear, setBullpenYear] = useState(2026);
  const [loading, setLoading]     = useState(false);
  const [data, setData]           = useState(null);
  const [sortCol, setSortCol]     = useState("pitcherScore");
  const [sortDir, setSortDir]     = useState("desc");

  useEffect(() => { getTeams().then(setTeams); }, []);

  const analyze = async () => {
    if (!teamId || loading) return;
    setLoading(true); setData(null);
    const [relievers, savantMap] = await Promise.all([
      getTeamBullpen(teamId, bullpenYear),
      getBullpenSavant(bullpenYear),
    ]);
    const enriched = relievers.map(p => {
      const merged = { ...p, ...(savantMap[String(p.id)] || {}) };
      merged.pitcherScore = calcPitcherScore(merged);
      return merged;
    });
    const scoreObj = calcBullpenScore(enriched);
    setData({ enriched, scoreObj, year: bullpenYear });
    setLoading(false);
  };

  const handleSort = col => {
    if (sortCol === col) setSortDir(d => d === "desc" ? "asc" : "desc");
    else { setSortCol(col); setSortDir("desc"); }
  };

  const sorted = useMemo(() => {
    if (!data?.enriched) return [];
    return [...data.enriched].sort((a, b) => {
      const av = a[sortCol] ?? (sortDir === "desc" ? -Infinity : Infinity);
      const bv = b[sortCol] ?? (sortDir === "desc" ? -Infinity : Infinity);
      return sortDir === "desc" ? bv - av : av - bv;
    });
  }, [data, sortCol, sortDir]);

  const teamInfo = teams.find(t => String(t.id) === String(teamId));
  const selStyle = { padding: "7px 10px", background: "#ffffff", color: "#16233c", border: "1px solid #c6cdd9", borderRadius: 7, fontSize: 12, cursor: "pointer" };
  const yearBtnStyle = active => ({
    padding: "3px 10px", fontSize: 11, borderRadius: 4, cursor: "pointer",
    border: active ? "1px solid #0f8a44" : "1px solid #c6cdd9",
    background: active ? "rgba(15,138,68,0.15)" : "#ffffff",
    color: active ? "#0f8a44" : "#5d6f8b", fontWeight: active ? 700 : 400,
  });

  const fmt    = (v, d = 1) => v != null ? v.toFixed(d) : "–";
  const fmtPct = v => v != null ? `${v.toFixed(1)}%` : "–";

  const thStyle = {
    padding: "7px 10px", fontSize: 10, fontWeight: 700, textTransform: "uppercase",
    letterSpacing: 0.8, textAlign: "right", userSelect: "none", whiteSpace: "nowrap",
  };
  const tdStyle = { padding: "7px 10px", fontSize: 11, textAlign: "right", borderBottom: "1px solid rgba(32,98,200,0.064)" };

  const cellColor = (col, p) => {
    switch (col) {
      case "era":       return p.era      != null ? (p.era      < 3.0  ? "#0f8a44" : p.era      > 5.0 ? "#c62828" : "#16233c") : "#16233c";
      case "xera":      return p.xera     != null ? (p.xera     < 3.0  ? "#0f8a44" : p.xera     > 5.0 ? "#c62828" : "#16233c") : "#16233c";
      case "whip":      return p.whip     != null ? (p.whip     < 1.1  ? "#0f8a44" : p.whip     > 1.5 ? "#c62828" : "#16233c") : "#16233c";
      case "kPct":      return p.kPct     != null ? (p.kPct     > 27   ? "#0f8a44" : p.kPct     < 18  ? "#c62828" : "#16233c") : "#16233c";
      case "bbPct":     return p.bbPct    != null ? (p.bbPct    < 6.5  ? "#0f8a44" : p.bbPct    > 12  ? "#c62828" : "#16233c") : "#16233c";
      case "whiff":     return p.whiff    != null ? (p.whiff    > 30   ? "#0f8a44" : p.whiff    < 20  ? "#c62828" : "#16233c") : "#16233c";
      case "hardHit":   return p.hardHit  != null ? (p.hardHit  < 32   ? "#0f8a44" : p.hardHit  > 42  ? "#c62828" : "#16233c") : "#16233c";
      case "xwoba":     return p.xwoba    != null ? (p.xwoba    < 0.29 ? "#0f8a44" : p.xwoba    > 0.36? "#c62828" : "#16233c") : "#16233c";
      case "strandPct": return p.strandPct!= null ? (p.strandPct> 80   ? "#0f8a44" : p.strandPct< 65  ? "#c62828" : "#16233c") : "#16233c";
      case "blownSaves":return p.blownSaves > 3 ? "#c62828" : "#16233c";
      default: return "#16233c";
    }
  };

  const TABLE_COLS = [
    { key: "name",         label: "Pitcher",  align: "left",  sortable: false, fmt: p => p.name },
    { key: "role",         label: "Role",     align: "left",  sortable: false, fmt: p => getRelieverRole(p) },
    { key: "pitcherScore", label: "Score",    align: "center", fmt: p => p.pitcherScore != null
        ? `${p.pitcherScore} ${bullpenGrade(p.pitcherScore)}` : p.ip < 10 ? "—" : "–" },
    { key: "games",        label: "G",        fmt: p => p.games },
    { key: "ip",         label: "IP",       fmt: p => fmt(p.ip) },
    { key: "era",        label: "ERA",      fmt: p => fmt(p.era, 2) },
    { key: "xera",       label: "xERA",     fmt: p => p.xera != null ? fmt(p.xera, 2) : "–" },
    { key: "whip",       label: "WHIP",     fmt: p => fmt(p.whip, 2) },
    { key: "kPct",       label: "K%",       fmt: p => fmtPct(p.kPct) },
    { key: "bbPct",      label: "BB%",      fmt: p => fmtPct(p.bbPct) },
    { key: "whiff",      label: "Whiff%",   fmt: p => fmtPct(p.whiff) },
    { key: "hardHit",    label: "HH%",      fmt: p => fmtPct(p.hardHit) },
    { key: "xwoba",      label: "xwOBA",    fmt: p => p.xwoba != null ? p.xwoba.toFixed(3) : "–" },
    { key: "strandPct",  label: "Strand%",  fmt: p => fmtPct(p.strandPct) },
    { key: "saves",      label: "SV",       fmt: p => p.saves },
    { key: "holds",      label: "HLD",      fmt: p => p.holds },
    { key: "blownSaves", label: "BS",       fmt: p => p.blownSaves },
  ];

  const scoreObj = data?.scoreObj;
  const sc = scoreObj?.score;
  const grade = bullpenGrade(sc);
  const gColor = bullpenGradeColor(sc);
  const r = 52, circ = 2 * Math.PI * r;
  const dashOffset = sc != null ? circ * (1 - sc / 100) : circ;

  const AGG_METRICS = [
    { label: "xERA",      val: fmt(scoreObj?.avgXera, 2),     score: scoreObj?.xeraScore },
    { label: "K%",        val: fmtPct(scoreObj?.kPct),        score: scoreObj?.kScore },
    { label: "BB%",       val: fmtPct(scoreObj?.bbPct),       score: scoreObj?.bbScore },
    { label: "Whiff%",    val: fmtPct(scoreObj?.avgWhiff),    score: scoreObj?.whiffScore },
    { label: "Hard Hit%", val: fmtPct(scoreObj?.avgHardHit),  score: scoreObj?.hardHitScore },
    { label: "Strand%",   val: fmtPct(scoreObj?.strandRate),  score: null },  // informational only
    { label: "xwOBA",     val: scoreObj?.avgXwoba != null ? scoreObj.avgXwoba.toFixed(3) : "–", score: null },
    { label: "Relievers", val: scoreObj?.count ?? "–", score: null },
  ];

  return (
    <div style={{ padding: "20px 24px", maxWidth: 1060, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 11, color: "#0f8a44", textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 4 }}>Bullpen Analyzer</div>
        <div style={{ fontSize: 20, fontWeight: 800, color: "#16233c" }}>Relief Corps Scouting Report</div>
        <div style={{ fontSize: 12, color: "#8b99b0", marginTop: 3 }}>Evaluate any team's bullpen — K%, BB%, strand rate, xERA, whiff rate, and contact quality</div>
      </div>

      {/* Controls */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 24, flexWrap: "wrap" }}>
        <select value={teamId} onChange={e => { setTeamId(e.target.value); setData(null); }} style={{ ...selStyle, minWidth: 190 }}>
          <option value="">— Select Team —</option>
          {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span style={{ fontSize: 11, color: "#6d7c96" }}>Season:</span>
          {[2024, 2025, 2026].map(yr => (
            <button key={yr} onClick={() => { setBullpenYear(yr); setData(null); }} style={yearBtnStyle(bullpenYear === yr)}>{yr}</button>
          ))}
        </div>
        <button onClick={analyze} disabled={!teamId || loading} style={{
          padding: "7px 18px", fontSize: 12, borderRadius: 7,
          cursor: teamId && !loading ? "pointer" : "not-allowed",
          background: teamId && !loading ? "rgba(15,138,68,0.15)" : "rgba(22,44,80,0.03)",
          color: teamId && !loading ? "#0f8a44" : "#b6c5dc",
          border: teamId && !loading ? "1px solid rgba(15,138,68,0.3)" : "1px solid #ccd2de",
          fontWeight: 700, transition: "all 0.15s",
        }}>
          {loading ? "⟳ Loading…" : "Analyze Bullpen →"}
        </button>
      </div>

      {loading && <Loader text={`Fetching ${teamInfo?.name || ""} bullpen data…`} />}

      {!loading && data && (<>
        {/* Score card + aggregate stats */}
        <div style={{ display: "grid", gridTemplateColumns: "200px 1fr", gap: 16, marginBottom: 24, alignItems: "stretch" }}>
          {/* Score circle */}
          <div style={{
            background: "rgba(213,221,237,0.6)", border: `1px solid ${gColor}44`, borderRadius: 14,
            padding: "20px 16px", display: "flex", flexDirection: "column", alignItems: "center",
            justifyContent: "center", gap: 6,
          }}>
            <svg width="130" height="130" viewBox="0 0 130 130">
              <circle cx="65" cy="65" r={r} fill="none" stroke="rgba(32,98,200,0.128)" strokeWidth="10" />
              <circle
                cx="65" cy="65" r={r} fill="none" stroke={gColor} strokeWidth="10" strokeLinecap="round"
                strokeDasharray={circ} strokeDashoffset={dashOffset}
                style={{ transform: "rotate(-90deg)", transformOrigin: "65px 65px", transition: "stroke-dashoffset 0.8s ease" }}
              />
              <text x="65" y="57" textAnchor="middle" fill={gColor} fontSize="28" fontWeight="800" fontFamily="system-ui">{sc ?? "–"}</text>
              <text x="65" y="76" textAnchor="middle" fill={gColor} fontSize="17" fontWeight="700" fontFamily="system-ui">{grade}</text>
              <text x="65" y="93" textAnchor="middle" fill="#b6c5dc" fontSize="9" fontFamily="system-ui">/ 100</text>
            </svg>
            <div style={{ fontSize: 10, color: "#b6c5dc", textAlign: "center", lineHeight: 1.5 }}>
              <div style={{ color: "#74839d", fontWeight: 600 }}>{teamInfo?.name}</div>
              <div>{scoreObj?.count} relievers · {data.year}</div>
            </div>
          </div>

          {/* Aggregate metric tiles */}
          <div style={{
            background: "rgba(213,221,237,0.4)", border: "1px solid rgba(32,98,200,0.16)", borderRadius: 14,
            padding: "16px 20px", display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10,
          }}>
            {AGG_METRICS.map(m => {
              const mc = m.score != null ? bullpenGradeColor(m.score) : "#5d6f8b";
              return (
                <div key={m.label} style={{ background: "rgba(219,225,240,0.5)", borderRadius: 10, padding: "10px 14px", border: "1px solid rgba(32,98,200,0.096)" }}>
                  <div style={{ fontSize: 9, color: "#8b99b0", textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>{m.label}</div>
                  <div style={{ fontSize: 20, fontWeight: 800, color: mc }}>{m.val}</div>
                  {m.score != null && (
                    <div style={{ marginTop: 5, height: 3, borderRadius: 2, background: "rgba(22,44,80,0.06)", overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${m.score}%`, background: mc, borderRadius: 2, transition: "width 0.6s ease" }} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Individual pitcher table */}
        <div style={{ background: "rgba(213,221,237,0.4)", border: "1px solid rgba(32,98,200,0.16)", borderRadius: 14, overflow: "hidden" }}>
          <div style={{ padding: "12px 20px", borderBottom: "1px solid rgba(32,98,200,0.128)", display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ fontSize: 10, color: "#0f8a44", textTransform: "uppercase", letterSpacing: 1.5, fontWeight: 700 }}>Individual Breakdown</div>
            <div style={{ fontSize: 10, color: "#c9d5e8" }}>· click headers to sort · green = elite · red = below avg</div>
          </div>
          <div className="hscroll">
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: "rgba(219,225,240,0.6)" }}>
                  {TABLE_COLS.map(col => (
                    <th
                      key={col.key}
                      onClick={() => col.sortable !== false && handleSort(col.key)}
                      style={{
                        ...thStyle,
                        textAlign: col.align || "right",
                        color: sortCol === col.key ? "#0f8a44" : "#8b99b0",
                        cursor: col.sortable !== false ? "pointer" : "default",
                      }}
                    >
                      {col.label}
                      {col.sortable !== false && sortCol === col.key ? (sortDir === "desc" ? " ↓" : " ↑") : ""}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sorted.map((p, i) => {
                  const role = getRelieverRole(p);
                  const roleColor = role === "Closer" ? "#c2570f" : role === "Setup" ? "#a16207" : "#2062c8";
                  const rowBg = i % 2 === 0 ? "transparent" : "rgba(22,44,80,0.012)";
                  return (
                    <tr key={p.id} style={{ background: rowBg }}
                      onMouseEnter={e => e.currentTarget.style.background = "rgba(32,98,200,0.064)"}
                      onMouseLeave={e => e.currentTarget.style.background = rowBg}>
                      <td style={{ ...tdStyle, textAlign: "left", color: "#16233c", fontWeight: 600, whiteSpace: "nowrap" }}>
                        {p.jerseyNumber && <span style={{ fontSize: 9, color: "#c9d5e8", marginRight: 5 }}>#{p.jerseyNumber}</span>}
                        {p.name}
                      </td>
                      <td style={{ ...tdStyle, textAlign: "left" }}>
                        <span style={{ fontSize: 10, color: roleColor, background: `${roleColor}15`, padding: "2px 7px", borderRadius: 4, fontWeight: 600, whiteSpace: "nowrap" }}>{role}</span>
                      </td>
                      <td style={{ ...tdStyle, textAlign: "center" }}>
                        {p.pitcherScore != null ? (
                          <span style={{
                            fontWeight: 700, fontSize: 12, color: bullpenGradeColor(p.pitcherScore),
                            fontFamily: "'JetBrains Mono', monospace",
                          }}>
                            {p.pitcherScore}
                            <span style={{ fontSize: 10, marginLeft: 3, opacity: 0.85 }}>{bullpenGrade(p.pitcherScore)}</span>
                          </span>
                        ) : <span style={{ color: "#c9d5e8", fontSize: 10 }}>—</span>}
                      </td>
                      <td style={tdStyle}>{p.games}</td>
                      <td style={tdStyle}>{fmt(p.ip)}</td>
                      <td style={{ ...tdStyle, color: cellColor("era", p) }}>{fmt(p.era, 2)}</td>
                      <td style={{ ...tdStyle, color: cellColor("xera", p) }}>{p.xera != null ? fmt(p.xera, 2) : "–"}</td>
                      <td style={{ ...tdStyle, color: cellColor("whip", p) }}>{fmt(p.whip, 2)}</td>
                      <td style={{ ...tdStyle, color: cellColor("kPct", p) }}>{fmtPct(p.kPct)}</td>
                      <td style={{ ...tdStyle, color: cellColor("bbPct", p) }}>{fmtPct(p.bbPct)}</td>
                      <td style={{ ...tdStyle, color: cellColor("whiff", p) }}>{fmtPct(p.whiff)}</td>
                      <td style={{ ...tdStyle, color: cellColor("hardHit", p) }}>{fmtPct(p.hardHit)}</td>
                      <td style={{ ...tdStyle, color: cellColor("xwoba", p) }}>{p.xwoba != null ? p.xwoba.toFixed(3) : "–"}</td>
                      <td style={{ ...tdStyle, color: cellColor("strandPct", p) }}>{fmtPct(p.strandPct)}</td>
                      <td style={tdStyle}>{p.saves}</td>
                      <td style={tdStyle}>{p.holds}</td>
                      <td style={{ ...tdStyle, color: cellColor("blownSaves", p) }}>{p.blownSaves}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={{ padding: "10px 20px", fontSize: 10, color: "#c9d5e8", borderTop: "1px solid rgba(32,98,200,0.08)" }}>
            Statcast data (xERA, xwOBA, Whiff%, HH%) via Baseball Savant · Stats API season pitching · Reliever filter: ≤3 starts, ≥3 appearances · Score = z-score vs MLB reliever averages (weighted composite)
          </div>
        </div>
      </>)}
    </div>
  );
}

function MatchupEvaluator({ season }) {
  const [teams, setTeams]         = useState([]);
  const [teamA, setTeamA]         = useState("");
  const [teamB, setTeamB]         = useState("");
  const [rosterA, setRosterA]     = useState([]);
  const [rosterB, setRosterB]     = useState([]);
  const [batterId, setBatterId]   = useState("");
  const [pitcherId, setPitcherId] = useState("");
  const [evalYear, setEvalYear]   = useState(2026);
  const [loading, setLoading]     = useState(false);
  const [report, setReport]       = useState(null);

  useEffect(() => { getTeams().then(ts => setTeams(ts)); }, []);

  useEffect(() => {
    if (!teamA) { setRosterA([]); setBatterId(""); return; }
    getTeamRoster(teamA, 2026, "batter").then(r => { setRosterA(r); setBatterId(""); });
  }, [teamA]);

  useEffect(() => {
    if (!teamB) { setRosterB([]); setPitcherId(""); return; }
    getTeamRoster(teamB, 2026, "pitcher").then(r => { setRosterB(r); setPitcherId(""); });
  }, [teamB]);

  const runAnalysis = async () => {
    if (!batterId || !pitcherId) return;
    setLoading(true); setReport(null);
    const yr = evalYear;
    const [batterSplits, pitcherSplits, batterStats, pitcherStats, pitcherMlbArsenal, savantArsenal, bvPitch, batterMlbArsenal, batterBio, pitcherBio, h2h] = await Promise.all([
      getSplits(batterId, "vl,vr,h,a", yr, "hitting"),
      getSplits(pitcherId, "vl,vr,h,a", yr, "pitching"),
      getSeasonStats(batterId, yr, "hitting"),
      getSeasonStats(pitcherId, yr, "pitching"),
      getPitcherArsenalMlb(pitcherId, yr),
      getStatcastArsenal(pitcherId, yr),
      getStatcastBatterVsPitch(batterId, yr),
      getBatterArsenalMlb(batterId, yr),
      getPlayerBio(batterId),
      getPlayerBio(pitcherId),
      getVsPitcher(batterId, pitcherId, yr).catch(() => null),
    ]);
    setReport({ batterSplits, pitcherSplits, batterStats, pitcherStats, pitcherMlbArsenal, savantArsenal, bvPitch, batterMlbArsenal, batterBio, pitcherBio, h2h, year: yr });
    setLoading(false);
  };

  const batter  = rosterA.find(p => String(p.person.id) === String(batterId));
  const pitcher = rosterB.find(p => String(p.person.id) === String(pitcherId));
  const canRun  = batterId && pitcherId && !loading;

  const selStyle = { width: "100%", padding: "7px 10px", background: "#ffffff", color: "#16233c", border: "1px solid #c6cdd9", borderRadius: 7, fontSize: 12, cursor: "pointer" };

  return (
    <div style={{ padding: "20px 24px", maxWidth: 860, margin: "0 auto" }}>
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 11, color: "#c2570f", textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 4 }}>Matchup Evaluator</div>
        <div style={{ fontSize: 20, fontWeight: 800, color: "#16233c" }}>Scout Report Generator</div>
        <div style={{ fontSize: 12, color: "#8b99b0", marginTop: 3 }}>Select a batter and pitcher to generate a comprehensive scouting analysis</div>
      </div>

      {/* Year selector */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 18 }}>
        <span style={{ fontSize: 11, color: "#6d7c96" }}>Data year:</span>
        {[2024, 2025, 2026].map(yr => (
          <button key={yr} onClick={() => { setEvalYear(yr); setReport(null); }} style={{ padding: "3px 10px", fontSize: 11, borderRadius: 4, cursor: "pointer", border: evalYear === yr ? "1px solid #c2570f" : "1px solid #c6cdd9", background: evalYear === yr ? "rgba(194,87,15,0.15)" : "#ffffff", color: evalYear === yr ? "#c2570f" : "#5d6f8b", fontWeight: evalYear === yr ? 700 : 400 }}>{yr}</button>
        ))}
      </div>

      {/* Player selector grid */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 44px 1fr", gap: 12, alignItems: "start", marginBottom: 20 }}>
        {/* Batter */}
        <div style={{ background: "rgba(32,98,200,0.08)", border: "1px solid rgba(32,98,200,0.24)", borderRadius: 10, padding: 16 }}>
          <div style={{ fontSize: 10, color: "#2062c8", textTransform: "uppercase", letterSpacing: 1.2, marginBottom: 10, fontWeight: 600 }}>🏏 Batter</div>
          <select value={teamA} onChange={e => setTeamA(e.target.value)} style={{ ...selStyle, marginBottom: 10 }}>
            <option value="">— Select Team —</option>
            {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <select value={batterId} onChange={e => setBatterId(e.target.value)} disabled={!teamA || rosterA.length === 0} style={{ ...selStyle, color: batterId ? "#16233c" : "#6d7c96" }}>
            <option value="">— Select Batter —</option>
            {rosterA.map(p => <option key={p.person.id} value={p.person.id}>{p.person.fullName}{p.jerseyNumber ? ` #${p.jerseyNumber}` : ""} · {p.position?.abbreviation || "OF"}</option>)}
          </select>
          {batter && <div style={{ marginTop: 8, fontSize: 11, color: "#8b99b0" }}>#{batter.jerseyNumber} · {batter.position?.name || batter.status?.description}</div>}
        </div>

        {/* VS */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700, color: "#8b99b0", paddingTop: 36 }}>VS</div>

        {/* Pitcher */}
        <div style={{ background: "rgba(208,49,49,0.05)", border: "1px solid rgba(208,49,49,0.15)", borderRadius: 10, padding: 16 }}>
          <div style={{ fontSize: 10, color: "#d03131", textTransform: "uppercase", letterSpacing: 1.2, marginBottom: 10, fontWeight: 600 }}>⚾ Pitcher</div>
          <select value={teamB} onChange={e => setTeamB(e.target.value)} style={{ ...selStyle, marginBottom: 10 }}>
            <option value="">— Select Team —</option>
            {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <select value={pitcherId} onChange={e => setPitcherId(e.target.value)} disabled={!teamB || rosterB.length === 0} style={{ ...selStyle, color: pitcherId ? "#16233c" : "#6d7c96" }}>
            <option value="">— Select Pitcher —</option>
            {rosterB.map(p => <option key={p.person.id} value={p.person.id}>{p.person.fullName}{p.jerseyNumber ? ` #${p.jerseyNumber}` : ""} · {p.position?.abbreviation || "P"}</option>)}
          </select>
          {pitcher && <div style={{ marginTop: 8, fontSize: 11, color: "#8b99b0" }}>#{pitcher.jerseyNumber} · {pitcher.position?.name || "Pitcher"}</div>}
        </div>
      </div>

      {/* Analyze button */}
      <div style={{ textAlign: "center", marginBottom: 28 }}>
        <button onClick={runAnalysis} disabled={!canRun} style={{ padding: "11px 40px", fontSize: 13, fontWeight: 700, borderRadius: 8, background: canRun ? "linear-gradient(135deg, #c2410c, #c2570f)" : "#e8edf6", color: canRun ? "#fff" : "#8b99b0", border: "none", cursor: canRun ? "pointer" : "default", letterSpacing: 0.5, boxShadow: canRun ? "0 4px 20px rgba(194,87,15,0.3)" : "none" }}>
          {loading ? "⏳ Analyzing…" : "▶ Generate Scout Report"}
        </button>
      </div>

      {loading && <Loader text="Fetching splits, arsenal, and matchup data…" />}
      {report && !loading && (
        <MatchupReport
          batter={batter} pitcher={pitcher}
          batterBio={report.batterBio} pitcherBio={report.pitcherBio}
          batterSplits={report.batterSplits} pitcherSplits={report.pitcherSplits}
          batterStats={report.batterStats} pitcherStats={report.pitcherStats}
          pitcherMlbArsenal={report.pitcherMlbArsenal} savantArsenal={report.savantArsenal}
          bvPitch={report.bvPitch} batterMlbArsenal={report.batterMlbArsenal}
          h2h={report.h2h} year={report.year}
        />
      )}
    </div>
  );
}


// Lines allowed per prop type in the Cracked board — tighter than PROP_LINES
// to avoid cluttering with unrealistic alternate-market lines.
const CRACKED_VALID_LINES = {
  hits:   [0.5, 1.5],
  hits15: [1.5],
  hr:     [0.5],
  tb:     [0.5, 1.5, 2.5, 3.5, 4.5],
  hrr:    [0.5, 1.5, 2.5, 3.5, 4.5],
  sb:     [0.5],
  rbi:    [0.5, 1.5],
  ks:     [4.5, 5.5, 6.5, 7.5, 8.5, 9.5, 10.5],
};
const CRACKED_PROP_KEYS = ["hits", "hr", "hrr", "tb", "sb", "rbi", "ks"];

// ── Cracked Board — cross-book line/odds discrepancy finder ──
function CrackedBoard({ propOddsMap, enrichedScanData }) {
  const BOOKS = ["fanduel", "draftkings", "hardrockbet"];
  const BOOK_COL = { fanduel: "#1866cf", draftkings: "#0f8a44", hardrockbet: "#d03131" };
  const PROP_LABEL = { hits: "Hits", hr: "HR", hrr: "H+R+RBI", tb: "Tot Bases", sb: "SB", rbi: "RBI", ks: "Ks" };

  const [minSpread, setMinSpread]     = useState(20);
  const [filterEV, setFilterEV]       = useState(false);
  const [sortCol, setSortCol]         = useState("ev");
  const [sortDir, setSortDir]         = useState("desc");
  const [activePropKeys, setActivePropKeys] = useState(new Set(CRACKED_PROP_KEYS));

  const toggleProp = key => setActivePropKeys(prev => {
    const next = new Set(prev);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  });

  const handleSort = col => {
    if (sortCol === col) {
      setSortDir(d => d === "desc" ? "asc" : "desc");
    } else {
      setSortCol(col);
      setSortDir("desc");
    }
  };

  const modelLookup = useMemo(() => {
    const map = {};
    for (const p of enrichedScanData?.players  || []) map[_normPropName(p.name)] = { type: "batter",  data: p };
    for (const p of enrichedScanData?.pitchers || []) map[_normPropName(p.name)] = { type: "pitcher", data: p };
    return map;
  }, [enrichedScanData]);

  // Build raw cracked rows — no sort, filter in render
  const cracked = useMemo(() => {
    if (!propOddsMap) return [];
    const results = [];
    for (const [normName, playerOdds] of Object.entries(propOddsMap)) {
      for (const [propKey, { std, alt }] of Object.entries(PROP_MARKET_KEYS)) {
        if (!CRACKED_PROP_KEYS.includes(propKey)) continue;
        const validSet = new Set(CRACKED_VALID_LINES[propKey] || []);
        if (validSet.size === 0) continue;

        // Merge std + alt into line → book map
        const lineMap = {};
        for (const mk of [std, alt].filter(Boolean)) {
          for (const [lineStr, bookData] of Object.entries(playerOdds[mk] || {})) {
            const line = parseFloat(lineStr);
            if (isNaN(line) || !validSet.has(line)) continue;
            if (!lineMap[line]) lineMap[line] = {};
            for (const bk of BOOKS) {
              if (bookData[bk]?.price != null && lineMap[line][bk] == null)
                lineMap[line][bk] = bookData[bk];
            }
          }
        }

        for (const [lineStr, bookData] of Object.entries(lineMap)) {
          const line = parseFloat(lineStr);
          const booksOn = BOOKS.filter(b => bookData[b]?.price != null);
          if (booksOn.length < 2) continue;
          const priceSorted = booksOn.map(b => ({ book: b, price: bookData[b].price })).sort((a, b) => b.price - a.price);
          const bestBook  = priceSorted[0].book;
          const bestPrice = priceSorted[0].price;
          // Spread = FanDuel vs DraftKings only; Hard Rock shown as-is but doesn't affect spread
          const fdDkPrices = ["fanduel","draftkings"].filter(b => bookData[b]?.price != null).map(b => bookData[b].price);
          const spread = fdDkPrices.length >= 2 ? Math.max(...fdDkPrices) - Math.min(...fdDkPrices) : 0;
          if (spread < 1) continue;

          const entry = modelLookup[normName];
          let modelProb = null, displayName = playerOdds.__displayName || normName, team = null, opponent = null;
          if (entry) {
            displayName = entry.data.name; team = entry.data.team; opponent = entry.data.opponent;
            if (entry.type === "pitcher" && propKey === "ks") {
              modelProb = modelImpliedProb(entry.data.xK, "ks", line);
            } else if (entry.type === "batter") {
              const res = entry.data.models?.[propKey];
              if (res) modelProb = modelImpliedProb(res.adjScore ?? res.score, propKey, line);
            }
          }
          const ev = modelProb != null ? calcEVFromOdds(modelProb, bestPrice) : null;

          const bestEntry = bookData[bestBook];
          let bestLink = null;
          if (bestBook === "hardrockbet" && bestEntry?.sid)
            bestLink = `https://share.hardrock.bet/Pt0T/bet?deep_link_value=hardrock://betslip/${bestEntry.sid}`;
          else bestLink = bestEntry?.link || null;

          results.push({ normName, displayName, team, opponent, propKey, line,
            bestBook, bestPrice, spread, allBookData: bookData, modelProb, ev, bestLink });
        }
      }
    }
    return results;
  }, [propOddsMap, modelLookup]);

  const fmtOdds = p => p > 0 ? `+${p}` : `${p}`;
  const fmtEV   = ev => ev == null ? "—" : `${ev >= 0 ? "+" : ""}${(ev * 100).toFixed(1)}%`;
  const evColor = ev => ev == null ? "#8b99b0" : ev >= 0.08 ? "#0f8a44" : ev >= 0 ? "#65a30d" : ev >= -0.05 ? "#a16207" : "#d03131";
  const spreadColor = s => s >= 80 ? "#0f8a44" : s >= 50 ? "#65a30d" : s >= 30 ? "#a16207" : "#5d6f8b";

  // Filter then sort
  const filtered = useMemo(() => {
    const rows = cracked.filter(r =>
      r.spread >= minSpread &&
      activePropKeys.has(r.propKey) &&
      (!filterEV || (r.ev != null && r.ev > 0))
    );
    rows.sort((a, b) => {
      let av, bv;
      const dir = sortDir === "asc" ? 1 : -1;
      switch (sortCol) {
        case "name":        return dir * (a.displayName || "").localeCompare(b.displayName || "");
        case "prop":        return dir * (`${a.propKey}${a.line}`).localeCompare(`${b.propKey}${b.line}`);
        case "spread":      av = a.spread;    bv = b.spread;    break;
        case "fanduel":     av = a.allBookData.fanduel?.price    ?? -9999; bv = b.allBookData.fanduel?.price    ?? -9999; break;
        case "draftkings":  av = a.allBookData.draftkings?.price ?? -9999; bv = b.allBookData.draftkings?.price ?? -9999; break;
        case "hardrockbet": av = a.allBookData.hardrockbet?.price ?? -9999; bv = b.allBookData.hardrockbet?.price ?? -9999; break;
        case "model":       av = a.modelProb ?? -1; bv = b.modelProb ?? -1; break;
        case "ev":          av = a.ev ?? -9999;    bv = b.ev ?? -9999;    break;
        default:            av = a.spread; bv = b.spread;
      }
      return dir * (bv - av);
    });
    return rows;
  }, [cracked, minSpread, activePropKeys, filterEV, sortCol, sortDir]);

  const positiveEV = filtered.filter(r => r.ev != null && r.ev > 0).length;

  const SortTh = ({ col, label, align = "center", color }) => {
    const active = sortCol === col;
    return (
      <th onClick={() => handleSort(col)} style={{
        padding: "7px 10px", textAlign: align, fontSize: 9, fontWeight: 700,
        letterSpacing: 1, textTransform: "uppercase", cursor: "pointer", userSelect: "none",
        color: active ? "#2062c8" : (color || "#8b99b0"),
        whiteSpace: "nowrap",
      }}>
        {label} {active ? (sortDir === "desc" ? "▼" : "▲") : <span style={{ opacity: 0.3 }}>⇅</span>}
      </th>
    );
  };

  if (!propOddsMap || Object.keys(propOddsMap).length === 0) {
    return (
      <div style={{ padding: "60px 20px", textAlign: "center", color: "#74839d" }}>
        <div style={{ fontSize: 36, marginBottom: 12 }}>💥</div>
        <div style={{ fontSize: 15, fontWeight: 600, color: "#5d6f8b", marginBottom: 8 }}>Odds not loaded</div>
        <div style={{ fontSize: 12 }}>Fetch odds from the header to detect cross-book discrepancies.</div>
      </div>
    );
  }

  return (
    <div style={{ padding: "0 0 40px" }}>
      {/* Header */}
      <div style={{ padding: "12px 20px 10px", display: "flex", alignItems: "center", gap: 12, borderBottom: "1px solid rgba(32,98,200,0.128)", flexWrap: "wrap" }}>
        <span style={{ fontSize: 17, fontWeight: 800, color: "#16233c" }}>💥 Cracked Lines</span>
        <span style={{ fontSize: 11, color: "#74839d" }}>{filtered.length} props · {positiveEV} EV+</span>
        <div style={{ display: "flex", gap: 6, alignItems: "center", marginLeft: "auto", flexWrap: "wrap" }}>
          <span style={{ fontSize: 10, color: "#8b99b0" }}>Spread ≥</span>
          {[10, 20, 30, 50].map(v => (
            <button key={v} onClick={() => setMinSpread(v)} style={{
              padding: "3px 9px", fontSize: 10, fontWeight: 700, borderRadius: 4, cursor: "pointer",
              background: minSpread === v ? "rgba(32,98,200,0.18)" : "rgba(22,44,80,0.04)",
              border: `1px solid ${minSpread === v ? "rgba(32,98,200,0.4)" : "rgba(22,44,80,0.08)"}`,
              color: minSpread === v ? "#2062c8" : "#74839d",
            }}>{v}</button>
          ))}
          <button onClick={() => setFilterEV(v => !v)} style={{
            padding: "3px 9px", fontSize: 10, fontWeight: 700, borderRadius: 4, cursor: "pointer",
            background: filterEV ? "rgba(15,138,68,0.15)" : "rgba(22,44,80,0.04)",
            border: `1px solid ${filterEV ? "rgba(15,138,68,0.4)" : "rgba(22,44,80,0.08)"}`,
            color: filterEV ? "#0f8a44" : "#74839d",
          }}>EV+ Only</button>
        </div>
      </div>

      {/* Prop type filter */}
      <div style={{ padding: "8px 20px", display: "flex", gap: 6, alignItems: "center", borderBottom: "1px solid rgba(32,98,200,0.096)", flexWrap: "wrap" }}>
        <span style={{ fontSize: 10, color: "#8b99b0", marginRight: 2 }}>Props:</span>
        {CRACKED_PROP_KEYS.map(key => {
          const on = activePropKeys.has(key);
          return (
            <button key={key} onClick={() => toggleProp(key)} style={{
              padding: "2px 10px", fontSize: 10, fontWeight: 700, borderRadius: 10, cursor: "pointer",
              background: on ? "rgba(32,98,200,0.24)" : "rgba(22,44,80,0.03)",
              border: `1px solid ${on ? "rgba(32,98,200,0.35)" : "rgba(22,44,80,0.07)"}`,
              color: on ? "#2062c8" : "#b6c5dc",
            }}>{PROP_LABEL[key]}</button>
          );
        })}
        {activePropKeys.size < CRACKED_PROP_KEYS.length && (
          <button onClick={() => setActivePropKeys(new Set(CRACKED_PROP_KEYS))} style={{
            padding: "2px 8px", fontSize: 9, fontWeight: 700, borderRadius: 10, cursor: "pointer",
            background: "transparent", border: "1px solid rgba(22,44,80,0.06)", color: "#b6c5dc",
          }}>All</button>
        )}
        <span style={{ fontSize: 10, color: "#c9d5e8", marginLeft: 8 }}>
          Best book highlighted · Spread = FD vs DK gap · HR listed as-is · Click column header to sort
        </span>
      </div>

      {filtered.length === 0 ? (
        <div style={{ padding: "40px 20px", textAlign: "center", color: "#74839d" }}>
          <div style={{ fontSize: 13 }}>No lines cracked at current filters — try lowering the spread or toggling EV+.</div>
        </div>
      ) : (
        <div className="hscroll">
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "rgba(210,217,236,0.6)", borderBottom: "1px solid rgba(32,98,200,0.24)" }}>
                <SortTh col="name"        label="Player"  align="left" />
                <SortTh col="prop"        label="Prop"    align="left" />
                <SortTh col="spread"      label="Spread"  />
                <SortTh col="fanduel"     label="FD"      color={BOOK_COL.fanduel} />
                <SortTh col="draftkings"  label="DK"      color={BOOK_COL.draftkings} />
                <SortTh col="hardrockbet" label="HR"      color={BOOK_COL.hardrockbet} />
                <SortTh col="model"       label="Model%" />
                <SortTh col="ev"          label="EV" />
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, 100).map((row, i) => (
                <tr key={`${row.normName}-${row.propKey}-${row.line}-${i}`}
                  style={{ borderBottom: "1px solid rgba(32,98,200,0.08)", background: i % 2 === 0 ? "rgba(210,217,236,0.25)" : "transparent" }}>
                  <td style={{ padding: "7px 10px", minWidth: 130 }}>
                    <div style={{ fontWeight: 600, color: "#3c4f6d", fontSize: 12, whiteSpace: "nowrap" }}>{row.displayName}</div>
                    {(row.team || row.opponent) && <div style={{ fontSize: 10, color: "#8b99b0" }}>{row.team}{row.opponent ? ` vs ${row.opponent}` : ""}</div>}
                  </td>
                  <td style={{ padding: "7px 10px" }}>
                    <span style={{ fontSize: 11, fontWeight: 600, color: "#4c5f7d", background: "rgba(32,98,200,0.128)", padding: "2px 8px", borderRadius: 4, whiteSpace: "nowrap" }}>
                      {PROP_LABEL[row.propKey]} O{row.line}
                    </span>
                  </td>
                  <td style={{ padding: "7px 10px", textAlign: "center" }}>
                    <span style={{ fontWeight: 800, color: spreadColor(row.spread), fontFamily: "'JetBrains Mono',monospace", fontSize: 13 }}>+{row.spread}</span>
                  </td>
                  {BOOKS.map(bk => {
                    const entry = row.allBookData[bk];
                    const price = entry?.price ?? null;
                    const isBest = bk === row.bestBook;
                    let link = null;
                    if (isBest && row.bestLink) link = row.bestLink;
                    else if (bk === "hardrockbet" && entry?.sid) link = `https://share.hardrock.bet/Pt0T/bet?deep_link_value=hardrock://betslip/${entry.sid}`;
                    else if (entry?.link) link = entry.link;
                    const chip = price == null ? (
                      <span style={{ color: "#c9d5e8", fontSize: 11 }}>—</span>
                    ) : (
                      <span style={{
                        fontFamily: "'JetBrains Mono',monospace", fontSize: isBest ? 13 : 12, fontWeight: isBest ? 800 : 500,
                        color: isBest ? "#0f8a44" : "#6d7c96",
                        background: isBest ? "rgba(15,138,68,0.13)" : "transparent",
                        padding: isBest ? "2px 7px" : "2px 3px", borderRadius: isBest ? 4 : 0,
                        border: isBest ? "1px solid rgba(15,138,68,0.35)" : "none", display: "inline-block",
                      }}>{fmtOdds(price)}</span>
                    );
                    return (
                      <td key={bk} style={{ padding: "5px 8px", textAlign: "center" }}>
                        {link && price != null ? <a href={link} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none" }}>{chip}</a> : chip}
                      </td>
                    );
                  })}
                  <td style={{ padding: "7px 10px", textAlign: "center", fontFamily: "'JetBrains Mono',monospace", fontSize: 12, color: row.modelProb != null ? "#4c5f7d" : "#c9d5e8" }}>
                    {row.modelProb != null ? `${(row.modelProb * 100).toFixed(0)}%` : "—"}
                  </td>
                  <td style={{ padding: "7px 12px", textAlign: "center" }}>
                    <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 12, fontWeight: 700, color: evColor(row.ev) }}>{fmtEV(row.ev)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length > 100 && (
            <div style={{ padding: "10px 20px", textAlign: "center", fontSize: 11, color: "#8b99b0" }}>
              Showing 100 of {filtered.length} — use filters above to narrow
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Pitcher Strikeout Board — dual model (xK + K-Edge) ──

// PropsBoard + BATTER_COLS_DEFAULT moved to src/components/PropsBoard.jsx
// (2026-07-06 dissolution — SB green-light/watch-tier rework).

function PlayerSearch({ enrichedScanData, rostersByTeam, onSelectBatter, onSelectPitcher, onClose }) {
  const [query, setQuery] = useState("");
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const allPlayers = useMemo(() => {
    const map = new Map();
    // ALL scanned batters from today's lineup scan (have playerId)
    for (const p of (enrichedScanData?.players || [])) {
      const id = p.playerId || p.name;
      if (!map.has(id)) map.set(id, { ...p, type: "batter", boards: [] });
    }
    // Board-qualified batters — add board tags (watch rows aren't board-qualified)
    for (const [boardKey, players] of Object.entries(enrichedScanData?.byModel || {})) {
      for (const p of (players || [])) {
        if (p.watch) continue;
        const id = p.playerId || p.name;
        if (!map.has(id)) map.set(id, { ...p, type: "batter", boards: [] });
        const entry = map.get(id);
        if (!entry.boards.includes(boardKey)) entry.boards.push(boardKey);
      }
    }
    // Pitchers from scan
    for (const p of (enrichedScanData?.pitchers || [])) {
      const id = p.pitcherId || p.name;
      if (!map.has(id)) map.set(id, { ...p, type: "pitcher", boards: ["ks"] });
    }
    // Active roster players for all today's teams — fills in anyone not in confirmed lineup
    for (const [teamAbbr, roster] of Object.entries(rostersByTeam || {})) {
      for (const rp of (roster || [])) {
        if (rp.status?.code !== "A") continue;
        const id = rp.person?.id;
        if (!id || map.has(id)) continue;
        const isPitcher = rp.position?.type === "Pitcher";
        map.set(id, {
          name: rp.person.fullName,
          team: teamAbbr,
          playerId: id,
          position: rp.position?.abbreviation,
          type: isPitcher ? "pitcher" : "batter",
          boards: [],
        });
      }
    }
    return [...map.values()].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  }, [enrichedScanData, rostersByTeam]);

  const results = query.length >= 2
    ? allPlayers.filter(p => (p.name || "").toLowerCase().includes(query.toLowerCase())).slice(0, 12)
    : [];

  const BOARD_LABELS = { hits: "Hits", hits15: "2+H", hr: "HR", hrr: "H+R+RBI", tb: "TB", sb: "SB", rbi: "RBI", ks: "Ks" };

  const handleSelect = (p) => {
    if (p.type === "pitcher") {
      onSelectPitcher?.({ pitcher: { id: p.pitcherId || p.playerId, fullName: p.name, pitchHand: { code: p.hand } }, pitcherTeam: p.team, pitcherScanData: p });
      onClose?.();
      return;
    }
    onSelectBatter?.(p);
    onClose?.();
  };

  return (
    <div style={{
      position: "fixed", top: 0, left: 0, right: 0, bottom: 0, zIndex: 999,
      background: "rgba(0,0,0,0.175)", backdropFilter: "blur(2px)",
      display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: 80,
    }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{
        width: 440, maxWidth: "calc(100vw - 32px)",
        background: "#ffffff", border: "1px solid rgba(32,98,200,0.25)",
        borderRadius: 14, boxShadow: "0 20px 60px rgba(0,0,0,0.245)",
        overflow: "hidden",
      }}>
        {/* Search input */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderBottom: "1px solid rgba(32,98,200,0.16)" }}>
          <span style={{ fontSize: 16, opacity: 0.5 }}>🔍</span>
          <input ref={inputRef} value={query} onChange={e => setQuery(e.target.value)}
            placeholder="Search players… (e.g. Schwarber, Ohtani)"
            style={{
              flex: 1, background: "none", border: "none", outline: "none",
              fontSize: 14, color: "#16233c", fontFamily: "inherit",
            }} />
          {query && <button onClick={() => setQuery("")} style={{ background: "none", border: "none", color: "#74839d", cursor: "pointer", fontSize: 16, lineHeight: 1 }}>✕</button>}
        </div>

        {/* Results */}
        {query.length < 2 && (
          <div style={{ padding: "16px", fontSize: 12, color: "#8b99b0", textAlign: "center" }}>
            {Object.keys(rostersByTeam || {}).length === 0
              ? "Loading rosters…"
              : "Type 2+ letters to search batters and pitchers"}
          </div>
        )}
        {query.length >= 2 && results.length === 0 && (
          <div style={{ padding: "16px", fontSize: 12, color: "#8b99b0", textAlign: "center" }}>
            No players found for "{query}"
          </div>
        )}
        {results.length > 0 && (
          <div style={{ maxHeight: 360, overflowY: "auto" }}>
            {results.map((p, i) => {
              const tc = getTeamColor(p.teamId);
              return (
                <div key={p.playerId || p.pitcherId || i} onClick={() => handleSelect(p)}
                  style={{
                    display: "flex", alignItems: "center", gap: 10, padding: "10px 16px",
                    borderBottom: "1px solid rgba(32,98,200,0.08)",
                    cursor: "pointer", transition: "background 0.1s",
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = "rgba(32,98,200,0.128)"}
                  onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                  <span style={{ fontSize: 18 }}>{p.type === "pitcher" ? "⚾" : "🏏"}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#16233c" }}>{p.name}</div>
                    <div style={{ fontSize: 11, color: "#74839d" }}>
                      {p.position || (p.type === "pitcher" ? "P" : "")}
                      {p.type === "pitcher" ? ` · xK ${(p.xK || 0).toFixed(1)} · Score ${(p.conf || 0).toFixed(1)}` : ""}
                    </div>
                  </div>
                  <span style={{ fontSize: 11, fontWeight: 700, color: tc?.[0] || "#5d6f8b", background: `${tc?.[0] || "#5d6f8b"}15`, padding: "2px 8px", borderRadius: 4 }}>
                    {p.team}
                  </span>
                  <div style={{ display: "flex", gap: 3, flexWrap: "wrap", justifyContent: "flex-end", maxWidth: 90 }}>
                    {(p.boards || []).map(bk => (
                      <span key={bk} style={{ fontSize: 9, fontWeight: 700, padding: "1px 4px", borderRadius: 3, background: "rgba(32,98,200,0.192)", color: "#2569d6" }}>
                        {BOARD_LABELS[bk] || bk}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Footer */}
        <div style={{ padding: "8px 16px", borderTop: "1px solid rgba(32,98,200,0.096)", fontSize: 10, color: "#b6c5dc", textAlign: "center" }}>
          Click a player to open their stats panel · Press Esc to close
        </div>
      </div>
    </div>
  );
}

function AppInner() {
  const isMobile = useIsMobile();
  const [date, setDate] = useState(getTodayInAppTimeZone());
  const [games, setGames] = useState([]);
  const [selectedGame, setSelectedGame] = useState(null);
  const [selectedBatter, setSelectedBatter] = useState(null);
  const [selectedPitcher, setSelectedPitcher] = useState(null); // { pitcher, pitcherTeam }
  const [loading, setLoading] = useState(true);
  const [gameWeather, setGameWeather] = useState(null);
  // Rotowire-resolved probable starters for EVERY game on the slate, keyed by gamePk.
  // { [gamePk]: { away: {id, fullName, _rwResolved}|null, home: ... } }
  const [rwProbables, setRwProbables] = useState({});
  const [page, setPage] = useState("today"); // "today" | "games" | board key
  // Which batter board the condensed "Batter Props" tab reopens to. Updated
  // whenever a batter sub-tab is selected so the parent tab remembers the
  // user's last market across visits to other top-level tabs.
  const [lastBatterBoard, setLastBatterBoard] = useState("hits");
  const [playerSearchOpen, setPlayerSearchOpen] = useState(false);
  const [rostersByTeam, setRostersByTeam] = useState({});
  // Sabermetric hints toggle — persisted to localStorage
  const [sabHints, setSabHints] = useState(() => {
    try { return localStorage.getItem("mlb_sab_hints") !== "false"; } catch { return true; }
  });
  const toggleSabHints = () => setSabHints(h => {
    const next = !h;
    try { localStorage.setItem("mlb_sab_hints", next ? "true" : "false"); } catch {}
    return next;
  });
  // Hide started games on the Games tab
  const [hideStarted, setHideStarted] = useState(true);
  const season = getSeason(date);

  // Baby Bump: paternity list reinstatements — fetched once at app load
  // Odds API credit usage — fetched once on load, shown below date bar
  const [oddsCredits, setOddsCredits] = useState(null);
  useEffect(() => {
    fetch("/api/odds?type=credits")
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d && (d.used != null || d.remaining != null)) setOddsCredits(d); })
      .catch(() => {});
  }, []);

  const [babyBumpPlayers, setBabyBumpPlayers] = useState([]);
  useEffect(() => {
    async function fetchBabyBump() {
      const today = getTodayInAppTimeZone();
      const lookback = new Date(today);
      lookback.setDate(lookback.getDate() - 14);
      const startDate = lookback.toISOString().slice(0, 10);
      try {
        const txRes = await fetch(`https://statsapi.mlb.com/api/v1/transactions?startDate=${startDate}&endDate=${today}&sportId=1`);
        const txData = await txRes.json();
        const reinstatements = (txData.transactions || []).filter(t =>
          t.description?.toLowerCase().includes('from the paternity list')
        );
        const bumpers = [];
        await Promise.all(reinstatements.map(async (tx) => {
          const playerId = tx.person?.id;
          const teamId = tx.toTeam?.id;
          const reinstatedDate = tx.date;
          if (!playerId || !teamId || !reinstatedDate) return;
          const schedRes = await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&teamId=${teamId}&startDate=${reinstatedDate}&endDate=${today}&gameType=R`);
          const schedData = await schedRes.json();
          let gamesPlayed = 0;
          for (const d of (schedData.dates || [])) {
            for (const g of (d.games || [])) {
              if (g.status?.abstractGameState === 'Final') gamesPlayed++;
            }
          }
          if (gamesPlayed < 3) {
            bumpers.push({ playerId, name: tx.person.fullName, teamName: tx.toTeam?.name || "—", reinstatedDate, gamesPlayed, gamesRemaining: 3 - gamesPlayed });
          }
        }));
        const seen = new Set();
        const uniqueBumpers = bumpers.filter(b => { if (seen.has(b.playerId)) return false; seen.add(b.playerId); return true; });
        // Tag pitcher vs batter so the homepage opens the correct profile panel.
        const bios = await getBulkBios(uniqueBumpers.map(b => b.playerId));
        for (const b of uniqueBumpers) {
          const pos = bios[b.playerId]?.primaryPosition;
          b.pitcher = pos?.code === "1" || pos?.abbreviation === "P";
          b.position = pos?.abbreviation || null;
          b.hand = bios[b.playerId]?.pitchHand?.code || null;
        }
        setBabyBumpPlayers(uniqueBumpers);
      } catch (_) {}
    }
    fetchBabyBump();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const babyBumpIds = new Set(babyBumpPlayers.map(b => b.playerId));

  const [teamManagers, setTeamManagers] = useState({});

  useEffect(() => {
    setLoading(true); setSelectedGame(null); setSelectedBatter(null); setSelectedPitcher(null); setGameWeather(null);
    setRostersByTeam({}); setTeamManagers({});
    getSchedule(date).then(g => {
      setGames(g);
      if (g.length > 0) setSelectedGame(g[0]);
      setLoading(false);
      const teamIds = [...new Set(g.flatMap(game => [game.teams?.away?.team?.id, game.teams?.home?.team?.id]).filter(Boolean))];
      Promise.all(teamIds.map(async id => [id, await getTeamManager(id).catch(() => null)]))
        .then(entries => setTeamManagers(Object.fromEntries(entries)));
    });
  }, [date]);

  // Lazy-fetch active rosters for all today's teams when player search opens (cached per date)
  useEffect(() => {
    if (!playerSearchOpen || Object.keys(rostersByTeam).length > 0 || games.length === 0) return;
    const teamEntries = [];
    for (const g of games) {
      const away = g.teams?.away?.team;
      const home = g.teams?.home?.team;
      if (away?.id && away?.abbreviation) teamEntries.push({ id: away.id, abbr: away.abbreviation });
      if (home?.id && home?.abbreviation) teamEntries.push({ id: home.id, abbr: home.abbreviation });
    }
    const seen = new Set();
    const unique = teamEntries.filter(t => !seen.has(t.id) && seen.add(t.id));
    Promise.all(unique.map(async ({ id, abbr }) => {
      const roster = await getRoster(id, season);
      return [abbr, roster];
    })).then(entries => setRostersByTeam(Object.fromEntries(entries)));
  }, [playerSearchOpen, games, season, rostersByTeam]);

  useEffect(() => {
    const handler = (e) => { if (e.key === "Escape") setPlayerSearchOpen(false); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Rotowire lineups — fetched once per date, 15-min TTL cache in the module
  const [lineupData, setLineupData] = useState({});
  const [lineupRefreshing, setLineupRefreshing] = useState(false);
  useEffect(() => {
    fetchRotowireLineups()
      .then(data => setLineupData(data || {}))
      .catch(() => setLineupData({}));
  }, [date]); // eslint-disable-line react-hooks/exhaustive-deps
  const refreshLineups = () => {
    _rwLineupCache.ts = 0; // bust TTL so next fetch is live
    setLineupRefreshing(true);
    fetchRotowireLineups({ force: true }) // ...and past /api/proxy's 30-min cache
      .then(data => { setLineupData(data || {}); setLineupRefreshing(false); })
      .catch(() => setLineupRefreshing(false));
  };

  // Resolve Rotowire probable starters for the WHOLE slate, not just the open game.
  // StatsAPI leaves probablePitcher null while a start is TBD; Rotowire usually has the
  // name hours earlier. This used to run only for the selected game, so a RW-only starter
  // existed inside the Games detail view and nowhere else — every other entry point that
  // opens a BatterPanel (Today flags, boards, search, Golden) passed pitcherId=null and
  // silently lost the matchup (BvP quick look, ⚔️ vs Pitcher tab, arsenal-vs-this-starter).
  useEffect(() => {
    if (!games.length) { setRwProbables({}); return; }
    let cancelled = false;
    Promise.all(games.map(async gm => {
      const a = gm.teams?.away, h = gm.teams?.home;
      const [away, home] = await Promise.all([
        resolveRotowirePitcher(a, lineupData[a?.team?.abbreviation], season).catch(() => null),
        resolveRotowirePitcher(h, lineupData[h?.team?.abbreviation], season).catch(() => null),
      ]);
      return [gm.gamePk, { away, home }];
    })).then(entries => { if (!cancelled) setRwProbables(Object.fromEntries(entries)); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [games, lineupData, season]);

  // Effective probable starter for one side of a game: StatsAPI first, Rotowire second.
  // Single source of truth — every matchup lookup in the app goes through this.
  const probableFor = useCallback((game, side) => {
    const api = game?.teams?.[side]?.probablePitcher;
    if (api?.id) return api;
    return rwProbables[game?.gamePk]?.[side] || null;
  }, [rwProbables]);

  // Odds API — moneyline & spread, loaded once on date change (no manual refresh)
  const [oddsData, setOddsData] = useState([]);
  useEffect(() => { fetchMLBOdds().then(d => setOddsData(d || [])); }, [date]);

  // Preload all prop data for all games on this date
  const { scanData, scanProgress, scanComplete } = usePropsScan(games, season, lineupData, oddsData);

  // Whole-league Statcast reference for the board tile strips (window + season percentiles).
  const statcastRef = useStatcastReference(season);

  // Player prop odds — 4-hour cache, enriches scanData with real book odds
  const [propOddsMap, setPropOddsMap] = useState({});
  useEffect(() => {
    if (games.length === 0) return;
    fetchMLBPlayerProps().then(m => setPropOddsMap(m || {}));
  }, [date, games.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Enrich scanData with book odds from propOddsMap, then backfill the starter on rows
  // the scan saw as TBD. The scan reads probablePitcher straight off StatsAPI, so every
  // row from a game that was still TBD at scan time carries oppPitcher: "TBD" even once
  // Rotowire has named the arm — the board then printed TBD while the panel it opens
  // shows the real starter. DISPLAY FIELDS ONLY: `players` and `byModel` are the rendered
  // views; the save substrate (byModelAll / pitchersAll) and every _snapshot payload are
  // left untouched, so nothing the model scored or captured changes.
  const enrichedScanData = useMemo(() => {
    const base = enrichScanData(scanData, propOddsMap);
    if (!base || !Object.keys(rwProbables).length) return base;
    const fill = (row) => {
      if (!row || (row.oppPitcherId && row.oppPitcher && row.oppPitcher !== "TBD")) return row;
      const gm = row.game;
      const rw = rwProbables[gm?.gamePk];
      if (!rw) return row;
      const p = rw[row.isHome ? "away" : "home"];
      if (!p?.id) return row;
      return {
        ...row,
        oppPitcherId:   row.oppPitcherId || p.id,
        oppPitcher:     (row.oppPitcher && row.oppPitcher !== "TBD") ? row.oppPitcher : p.fullName,
        oppPitcherHand: row.oppPitcherHand || p.pitchHand?.code || null,
      };
    };
    return {
      ...base,
      players: (base.players || []).map(fill),
      byModel: Object.fromEntries(
        Object.entries(base.byModel || {}).map(([k, rows]) => [k, (rows || []).map(fill)])
      ),
    };
  }, [scanData, propOddsMap, rwProbables]);

  // Resolve today's pitching matchup + game context for a batter about to be opened in a
  // BatterPanel. EVERY setSelectedBatter callsite funnels through here so a panel opened
  // from Today / a board / search / Golden carries the same matchup the Games view shows.
  //
  // It FILLS GAPS rather than short-circuiting: a board pick already carries
  // opponentPitcherId, but that value is null whenever StatsAPI had the start as TBD at
  // scan time. The old version returned early on any truthy pitcher field and left those
  // nulls in place, which is why a Rotowire-only starter never reached the panel.
  // Layer 1 = the scan player record (richest: hand + venue), layer 2 = the schedule
  // joined with the slate-wide Rotowire probables.
  const enrichBatterWithMatchup = useCallback((pick) => {
    if (!pick) return pick;
    const out = { ...pick };
    // Placeholder names are absence, not data — otherwise ??= below would preserve "TBD".
    if (out.opponentPitcherName === "TBD") out.opponentPitcherName = null;
    const pid = out.id || out.playerId;
    const team = out.batterTeam || out.team || out.currentTeam?.abbreviation || null;

    const scanPlayer = pid ? (enrichedScanData?.players || []).find(p => p.playerId === pid) : null;
    if (scanPlayer) {
      out.batterTeam          ??= scanPlayer.team || team;
      out.opponentPitcherId   ??= scanPlayer.oppPitcherId   ?? null;
      out.opponentPitcherName ??= (scanPlayer.oppPitcher === "TBD" ? null : scanPlayer.oppPitcher) ?? null;
      out.opponentPitcherTeam ??= scanPlayer.opponent       ?? null;
      out.opponentPitcherHand ??= scanPlayer.oppPitcherHand ?? null;
      out.isHome              ??= scanPlayer.isHome;
      out.gamePk              ??= scanPlayer.game?.gamePk;
      out.homeTeamAbbrev      ??= scanPlayer.game?.teams?.home?.team?.abbreviation;
      out.venueName           ??= scanPlayer.venue;
    }

    const bt = out.batterTeam || team;
    const gm = (games || []).find(x => out.gamePk && x.gamePk === out.gamePk)
      || (bt ? (games || []).find(x =>
           x.teams?.home?.team?.abbreviation === bt ||
           x.teams?.away?.team?.abbreviation === bt) : null);
    if (gm) {
      const isHome = out.isHome ?? (gm.teams?.home?.team?.abbreviation === bt);
      const oppSide = isHome ? "away" : "home";
      const opp = gm.teams?.[oppSide];
      const oppPitcher = probableFor(gm, oppSide);
      out.batterTeam          ??= bt;
      out.isHome              ??= isHome;
      out.opponentPitcherId   ??= oppPitcher?.id || null;
      out.opponentPitcherName ??= oppPitcher?.fullName || null;
      out.opponentPitcherTeam ??= opp?.team?.abbreviation || null;
      out.gamePk              ??= gm.gamePk;
      out.homeTeamAbbrev      ??= gm.teams?.home?.team?.abbreviation;
      out.venueName           ??= gm.venue?.name;
    }
    return out;
  }, [enrichedScanData, games, probableFor]);

  // Same idea for the pitcher side: a PitcherPanel opened from Ks / search / a board
  // gets the opposing club + venue so the "opposing lineup" and park sections render.
  // Callsites that already supply them (the Games detail cards) pass straight through.
  const enrichPitcherWithMatchup = useCallback((sel) => {
    if (!sel) return sel;
    const out = { ...sel };
    const sd = out.pitcherScanData;
    const team = out.pitcherTeam || sd?.team || null;
    out.opponentTeam ??= sd?.opponent && sd.opponent !== "?" ? sd.opponent : null;
    out.venueName    ??= sd?.venue || null;
    const gm = (games || []).find(x => sd?.gamePk && x.gamePk === sd.gamePk)
      || (team ? (games || []).find(x =>
           x.teams?.home?.team?.abbreviation === team ||
           x.teams?.away?.team?.abbreviation === team) : null);
    if (gm) {
      const isHome = gm.teams?.home?.team?.abbreviation === team;
      out.opponentTeam ??= gm.teams?.[isHome ? "away" : "home"]?.team?.abbreviation || null;
      out.venueName    ??= gm.venue?.name || null;
    }
    return out;
  }, [games]);

  // Fetch weather when game changes. MLB live feed FIRST: on game day it reports the actual
  // roof decision + measured wind/temp (ground truth). It's empty until ~Warmup, so for preview
  // games we fall back to the NWS hourly forecast. (Old order was NWS-first, which meant the app
  // showed a forecast even after MLB had posted "Roof Closed" — the roof state never surfaced.)
  useEffect(() => {
    if (!selectedGame?.gamePk) { setGameWeather(null); return; }
    const homeAbbrev = selectedGame.teams?.home?.team?.abbreviation;
    const coords = getParkCoords(selectedGame.venue?.name, homeAbbrev);
    const cfBearing = getParkCfBearing(selectedGame.venue?.name, homeAbbrev);
    const run = async () => {
      let w = await getGameWeather(selectedGame.gamePk).catch(() => null);
      // MLB feed not yet populated (preview) → forecast fills the gap.
      if ((!w || !w.condition) && coords) {
        const nws = await getNWSForecast(coords[0], coords[1], selectedGame.gameDate, cfBearing).catch(() => null);
        if (nws) w = nws;
      }
      setGameWeather(w);
    };
    run();
  }, [selectedGame?.gamePk]); // eslint-disable-line react-hooks/exhaustive-deps

  const g = selectedGame;
  const away = g?.teams?.away, home = g?.teams?.home;
  // Effective probable starters: StatsAPI when present, else the Rotowire-resolved player.
  // Sourced from the slate-wide map so the detail view and every player panel agree.
  const awayProbable = probableFor(g, "away");
  const homeProbable = probableFor(g, "home");
  const awayColor = away ? getTeamColor(away.team.id)[0] : "#cbcbd2";
  const homeColor = home ? getTeamColor(home.team.id)[0] : "#cbcbd2";
  const displayDate = new Date(date+"T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });

  // ── Picks automation — always-on, independent of Results tab being mounted ──
  const [picks, setPicks] = useState([]);
  // Mirrors `picks` for loadPicks, which has no deps and so cannot read the
  // state it is deciding whether to overwrite.
  const picksRef = useRef([]);
  const [picksLoading, setPicksLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [scoring, setScoring] = useState(false);
  const [scoreMsg, setScoreMsg] = useState("");
  const [picksError, setPicksError] = useState("");
  const [autoLog, setAutoLog] = useState("");
  const autoSavedRef = useRef(false);
  const autoScoredRef = useRef(false);
  const saveTodayPicksRef = useRef(null);
  const scorePicksRef = useRef(null);
  const slateRowsRef = useRef([]); // game pick rows from SlateOddsTab
  const [slateRowsState, setSlateRowsState] = useState([]); // mirror for Golden 10 reactivity

  // Edge-controller controls (market_health): fetched once on mount, installed
  // into the module store so the deep board renders + sizing functions in
  // lib/picks.js see it without prop threading. State copy drives the Results
  // weighted track + the ControllerStatus banner. Failure → null → identity
  // controls (the app never blocks on the controller).
  const [marketHealth, setMarketHealth] = useState(null);
  useEffect(() => {
    fetchJson("/api/picks?view=market-health").then(d => {
      if (!Array.isArray(d?.rows) || d.rows.length === 0) return;
      const lookup = buildHealthLookup(d.rows);
      setActiveHealthLookup(lookup);
      setMarketHealth(lookup);
    }).catch(() => {});
  }, []);

  const loadPicks = useCallback(async () => {
    setPicksLoading(true);
    setPicksError("");
    // Fetch full history via pagination — Supabase PostgREST caps each response
    // at 1000 rows. The previous limit=500 silently truncated to the most-recent
    // ~17 days, which made the by-prop-type breakdown weighted toward markets
    // that pick more frequently (RBI ~150/window vs Hits ~25).
    //
    // sbGetAllPages owns the retry/partial policy (see src/lib/supa.js): a page
    // starved by the scan's fetch storm retries instead of discarding the six
    // pages that did arrive, which is how this surface ended up reading
    // "0 picks tracked" behind a 20s timeout banner on 2026-09-04.
    try {
      const { rows, complete, error } = await sbGetAllPages(
        "mlb_picks", "order=pick_date.desc,id.desc"
      );
      // A complete read is authoritative and always wins — it is the only one
      // that can reflect a deletion. A partial read replaces what's on screen
      // only if it is strictly more: pages arrive newest-first and contiguously,
      // so the longer of the two always contains the shorter. Without this, a
      // refresh that lost the race blanked a history the tab was already showing
      // — which is the "0 picks tracked" the retry was added to prevent.
      const shown = complete ? rows.length : Math.max(rows.length, picksRef.current.length);
      if (complete || rows.length > picksRef.current.length) {
        picksRef.current = rows;
        setPicks(rows);
      }
      if (!complete) {
        // A partial history is usable — it is the most recent N picks — but every
        // all-time total below it is understated, so it has to say so.
        setPicksError(
          shown
            ? `Showing the ${shown.toLocaleString()} most recent picks — the rest of the history didn't arrive. Totals cover that range only; retry for the full record. (${error.replace(/\.$/, "")})`
            : error
        );
      }
    } catch (e) {
      // sbGetAllPages reports failure in its return value rather than throwing,
      // so reaching here means something else broke — the flag still has to
      // clear, or the tab spins on "Loading pick history…" forever.
      setPicksError(e?.message || String(e));
    } finally {
      setPicksLoading(false);
    }
  }, []);
  useEffect(() => { loadPicks(); }, [loadPicks]);

  // Auto-save: fires once when scan completes, after 11am ET
  useEffect(() => {
    if (!scanComplete || !enrichedScanData || autoSavedRef.current) return;
    const etHour = getHourInTimeZone();
    if (etHour < 11) return;
    autoSavedRef.current = true;
    const today = getTodayInAppTimeZone();
    // Cron-owned prop_types are excluded: nrfi-picks.yml fires at 11 AM ET, this
    // effect's gate opens at 11 AM ET, and the daily-picks driver loads the page
    // at 12:30 PM ET — so on any day NRFI has a play, its row lands first and a
    // bare existence check reads as "already saved". That silently skipped the
    // ENTIRE slate on 2026-07-19, 07-20 and 07-22 (1-2 picks saved, not dozens).
    sbGet("mlb_picks", savedPicksParams(today, { limit: 1 })).then(existing => {
      if (!existing || existing.length === 0) {
        setAutoLog(`Auto-saving picks for ${today}…`);
        setTimeout(() => saveTodayPicksRef.current?.(), 500);
      }
    }).catch(() => {});
  }, [scanComplete, enrichedScanData]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-score: fires once on initial picks load for any pending dates before today
  useEffect(() => {
    if (picksLoading || autoScoredRef.current || picks.length === 0) return;
    const today = getTodayInAppTimeZone();
    const pendingDates = [...new Set(
      picks.filter(p => p.outcome === "pending" && p.pick_date < today).map(p => p.pick_date)
    )].sort();
    if (pendingDates.length === 0) return;
    autoScoredRef.current = true;
    (async () => {
      for (const d of pendingDates) {
        setAutoLog(`Auto-scoring ${d}…`);
        await scorePicksRef.current?.(d);
      }
      setAutoLog("");
    })();
  }, [picksLoading]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveTodayPicks = useCallback(async () => {
    if (!scanComplete || !enrichedScanData) return;
    setSaving(true); setPicksError("");
    const today = getTodayInAppTimeZone();
    try {
      // Same cron-owned exclusion as the auto-save effect above — otherwise the
      // manual "Save today's picks" button also refuses with "already saved" on
      // any day the NRFI cron got there first.
      const existing = await sbGet("mlb_picks", savedPicksParams(today, { limit: 1 }));
      if (existing && existing.length > 0) {
        setPicksError(`Picks for ${today} already saved (${existing.length}+ rows). Delete them first to re-save.`);
        setSaving(false); return;
      }
      const rows = [];
      // Use the unfiltered substrate (byModelAll/pitchersAll) so late-firing
      // auto-saves still capture picks for games that have already started.
      // byModel/pitchers are cosmetic, locked-game-filtered views.
      const saveByModel = enrichedScanData.byModelAll || enrichedScanData.byModel || {};
      const savePitchers = enrichedScanData.pitchersAll || enrichedScanData.pitchers || [];
      // Parent-player lookup: byModel picks carry only the per-market model result.
      // The wide-capture extraSignals + advancedStats live on the parent player record.
      // We attach them inline as a `_snapshot` sidecar so api/picks.js can write
      // pick_signals without depending on daily_scan_results existing — which has
      // been failing with 413 since extraSignals landed (commit 33ee852, 2026-05-28),
      // silently nulling raw_signals/model_intermediates/game_context for every pick.
      const playersById = new Map(
        (enrichedScanData.players || []).map(pl => [pl.playerId, pl])
      );
      // Same omit set as api/picks.js KS_OMIT — kept in sync. Strips display/noise
      // fields when curating pitcher signals; extraSignals is held separately.
      const KS_OMIT_FIELDS = new Set([
        "name", "team", "hand", "opponent", "isHome", "gamePk", "venue", "parkAbbrev",
        "proj", "game", "advancedStats", "umpireInfo",
        "rateL5", "rateL10", "rateL20", "drought",
      ]);

      // ── Stage-1 picks-only capture: same-hand (vs starter's hand) arsenal ──
      // The overall arsenal_matchup is already captured for every pick. This adds
      // the batter's platoon-specific arsenal — both the aggregate (vs LHP/RHP) AND
      // the full per-pitch-type breakdown ("handedness vs all pitch types") — so we
      // can later mine whether the platoon view, at the pitch-type level, relates to
      // how our picks cash. The split is an event-level fetch (heavy), so we run it
      // ONLY for official picks — not the full slate. NOT a model input; forward data
      // only. See memory/project_arsenal_analytics.md.
      const _sameHandMemo = new Map(); // `${playerId}-${hand}` → { matchup, byPitch } | null
      const saveSeasonYr = getSeason(today);
      const sameHandArsenalFor = async (playerId, pHand, pArsenal) => {
        if (!playerId || !pHand || !pArsenal) return null;
        const key = `${playerId}-${pHand}`;
        if (_sameHandMemo.has(key)) return _sameHandMemo.get(key);
        let out = null;
        try {
          const bvp = await getStatcastBatterVsPitchByHand(playerId, saveSeasonYr, pHand);
          if (bvp && Object.keys(bvp).length) {
            const m = computeArsenalMatchup(bvp, pArsenal);
            out = { matchup: m ? { ...m, pitchHand: pHand } : null, byPitch: bvp };
          }
        } catch { /* leave null — never block the save */ }
        _sameHandMemo.set(key, out);
        return out;
      };

      for (const [propType, players] of Object.entries(saveByModel)) {
        if (propType === "hits15") continue; // removed model
        for (const p of (players || [])) {
          if (p.watch) continue; // SB watch tier — research-only, never saved
          // Only save official picks (meet per-prop quality threshold)
          const conf = calcConfidence(p.score, propType, p);
          if (!isOfficialPick(conf, propType, p)) continue;
          const best = p.bestLine || {};
          const books = p.bookOdds || {};
          const bestBook = Object.entries(books).sort((a,b) => (b[1]||0) - (a[1]||0))[0];
          // Use the actual market line (bookLine) the user sees and bets — not the Poisson-derived
          // bestLine. For TB/HRR, findBestLine walked from O4.5 down and could pick O3.5/O2.5 when
          // the real book line was O1.5, causing Results to grade against an impossible line.
          // p.impliedProb is set in enrichment to match the chosen bookLine (selectedImpliedProb).
          const savedLine = p.bookLine ?? best.line ?? 0.5;
          const savedProb = p.impliedProb ?? best.impliedProb ?? null;
          const savedFair = (savedProb != null && savedLine === best.line) ? best.fairLine : probToAmericanOdds(savedProb);
          const parent = playersById.get(p.playerId);
          const extra = parent?.extraSignals || {};
          // Same-hand arsenal capture (picks-only; memoized per player+hand). Stored as:
          //   • raw_signals.arsenal_matchup_samehand   — aggregate matchup (wide capture)
          //   • raw_signals.batter_pitch_data_samehand — full per-pitch-type map ("handedness
          //     vs all pitch types"), for later pitch-type-level platoon mining
          //   • flat atoms + delta-vs-overall merged into `signals`, because feature-lab.mjs
          //     flattens signals/adv_stats (NOT raw_signals) — so the delta auto-mines.
          let snapRawSignals = extra.raw_signals || null;
          let snapSignals = p.result || null;
          if (snapRawSignals?.pitcher_arsenal) {
            const sameHand = await sameHandArsenalFor(
              p.playerId, extra.game_context?.opp_pitcher_hand, snapRawSignals.pitcher_arsenal
            );
            if (sameHand?.byPitch) {
              snapRawSignals = { ...snapRawSignals, batter_pitch_data_samehand: sameHand.byPitch };
            }
            const m = sameHand?.matchup;
            if (m) {
              snapRawSignals = { ...snapRawSignals, arsenal_matchup_samehand: m };
              const ov = snapSignals || {};
              const d = (a, b) => (a != null && b != null) ? a - b : null;
              snapSignals = {
                ...ov,
                arsenalSameHandXwoba:   m.avgXwoba   ?? null,
                arsenalSameHandXslg:    m.avgXslg    ?? null,
                arsenalSameHandHardHit: m.avgHardHit ?? null,
                arsenalSameHandMult:    m.mult       ?? null,
                arsenalHandDeltaXwoba:  d(m.avgXwoba,   ov.rawArsenalAvgXwoba),
                arsenalHandDeltaXslg:   d(m.avgXslg,    ov.rawArsenalAvgXslg),
                arsenalHandDeltaHardHit:d(m.avgHardHit, ov.rawArsenalAvgHardHit),
              };
            }
          }
          rows.push({
            pick_date: today, player_name: p.name, player_id: p.playerId || null,
            team: p.team || null, prop_type: propType,
            line: savedLine, model_score: p.score ?? null, conf: parseFloat(conf.toFixed(2)),
            model_prob: savedProb, fair_line: savedFair,
            fd_odds: books.fanduel ?? null, dk_odds: books.draftkings ?? null,
            hr_odds: books.hardrockbet ?? null,
            best_book: bestBook ? bestBook[0] : null, best_odds: bestBook ? bestBook[1] : null,
            direction: "over", outcome: "pending",
            model_version: tagPick(propType),
            // Inline pick_signals snapshot — stripped by api/picks.js before insert.
            _snapshot: {
              signals:             snapSignals,
              adv_stats:           parent?.advancedStats || null,
              raw_signals:         snapRawSignals,
              model_intermediates: extra.model_intermediates || null,
              game_context:        extra.game_context || null,
            },
          });
        }
      }
      for (const p of savePitchers) {
        // Only save Ks picks that meet score + K-Edge threshold
        if (!isOfficialKsPick(p)) continue;
        const dir = ksPickDirection(p);
        // Pitch Lab ladder when the morning job scored him (its calibrated NegBin), else the
        // legacy Poisson around xK.
        const ladderSides = p.kLadder ? sideProbs(p.kLadder, p.line ?? 4.5) : null;
        const savedProb = ladderSides ? ladderSides[dir] : directionalModelProb(p.xK, "ks", p.line ?? 4.5, dir);
        // The price must belong to the SIDE being wagered. This used to fall back from a
        // missing bookUnderOdds to p.bookOdds — the OVER prices — and then save them
        // alongside direction:"under", so the row claimed a price for a bet nobody had
        // quoted. An over price cannot settle an under wager at any book: on a K prop the
        // two sides are opposite ends of the same vig, so inheriting the over is not an
        // approximation, it is the wrong number with the wrong sign of juice.
        //
        // No under quote now means no price, and src/lib/settlement.js treats the row as
        // unpriced: it still scores W/L, it just cannot pay or stake. That is strictly
        // better than settling at a price that was never available.
        const books = dir === "under" ? (p.bookUnderOdds || {}) : (p.bookOdds || {});
        const bestBook = Object.entries(books).sort((a,b) => (b[1]||0) - (a[1]||0))[0];
        // Pitcher snapshot: pitcher object IS the model. Curate by stripping
        // display fields + extraSignals (same shape api/picks.js produced before).
        const pitcherCurated = {};
        for (const [k, v] of Object.entries(p)) {
          if (!KS_OMIT_FIELDS.has(k) && k !== "extraSignals") pitcherCurated[k] = v;
        }
        const extra = p.extraSignals || {};
        rows.push({
          pick_date: today, player_name: p.name, player_id: p.pitcherId || null,
          team: p.team || null, prop_type: "ks",
          line: p.line ?? 4.5, model_score: p.xK ?? null, conf: parseFloat((p.conf || 0).toFixed(2)),
          model_prob: savedProb, fair_line: probToAmericanOdds(savedProb),
          fd_odds: books.fanduel ?? null, dk_odds: books.draftkings ?? null,
          hr_odds: books.hardrockbet ?? null,
          best_book: bestBook ? bestBook[0] : null, best_odds: bestBook ? bestBook[1] : null,
          direction: dir, outcome: "pending",
          model_version: tagPick("ks"),
          _snapshot: {
            signals:             pitcherCurated,
            adv_stats:           null, // pitcher.advancedStats was already filtered out of pitcherCurated
            raw_signals:         extra.raw_signals || null,
            model_intermediates: extra.model_intermediates || null,
            game_context:        extra.game_context || null,
          },
        });
      }
      // Pitch Lab pitcher props (outs / hits_allowed / walks / er) — official calls only:
      // a real book line AND the model's RAW confidence at that line ≥ its gate (the top
      // 20% of holdout regular starters; lab/pitchlab/meta.json). model_score stores that raw
      // confidence (score space), model_prob the calibrated probability of the side taken.
      for (const p of savePitchers) {
        for (const [propType, call] of Object.entries(p.pitcherProps || {})) {
          if (!call?.official) continue;
          const books = call.sideOdds || {};
          const bestBook = Object.entries(books).filter(([, v]) => v != null).sort((a, b) => b[1] - a[1])[0];
          rows.push({
            pick_date: today, player_name: p.name, player_id: p.pitcherId || null,
            team: p.team || null, prop_type: propType,
            line: call.line, model_score: parseFloat(call.rawConf.toFixed(4)),
            conf: parseFloat((call.rawConf * 10).toFixed(2)),
            model_prob: call.prob, fair_line: probToAmericanOdds(call.prob),
            fd_odds: books.fanduel ?? null, dk_odds: books.draftkings ?? null, hr_odds: books.hardrockbet ?? null,
            best_book: bestBook ? bestBook[0] : null, best_odds: bestBook ? bestBook[1] : null,
            direction: call.side, outcome: "pending",
            model_version: tagPick(propType),
            _snapshot: {
              signals: { propType, line: call.line, side: call.side, prob: call.prob, probOver: call.probOver,
                         rawConf: call.rawConf, mean: call.mean, pitchlab: p.pitchlabProps?.[PITCHER_PROPS[propType].key] ?? null },
              adv_stats: null, raw_signals: null,
              model_intermediates: null,
              game_context: p.extraSignals?.game_context || null,
            },
          });
        }
      }
      // Add ML/RL/OU game picks from SlateOddsTab — official PLAYs only (matches dice icons).
      // Gate matches SlateOddsTab per-market PLAY thresholds (see top-of-component comment):
      //   ML PLAY → (high conf AND edge >4%) OR (medium conf AND edge >6%)
      //   RL PLAY → margin edge ≥0.75R (any non-low conf)
      //   OU PLAY → |projected total − market| ≥1.5R
      // Shared model snapshot — pick_signals.signals JSONB. Includes model output +
      // the inputs that drove it (FIP, lineup OPS, weather, ump). Picked up by
      // api/picks.js → snapshotGamePickSignals via the sidecar `_signals` field.
      const buildGameSignals = (r, market, extra) => ({
        market,
        gamePk:           r.gamePk ?? null,
        homeAbbr:         r.homeAbbr ?? null,
        awayAbbr:         r.awayAbbr ?? null,
        // Model output
        model:            r.model,
        // Model inputs
        homeFIP:          r.homeFIP ?? null,
        awayFIP:          r.awayFIP ?? null,
        homeL5FIP:        r.homeL5FIP ?? null,
        awayL5FIP:        r.awayL5FIP ?? null,
        homeLineupOPS:    r.homeLineupOPS ?? null,
        awayLineupOPS:    r.awayLineupOPS ?? null,
        weatherRunDelta:  r.weatherRunDelta ?? null,
        umpireRunAdjust:  r.umpireRunAdjust ?? null,
        homeL10:          r.homeL10 ?? null,
        awayL10:          r.awayL10 ?? null,
        ...extra,
      });
      for (const r of (slateRowsRef.current || [])) {
        if (r.isMLPlay && r.mlPick) {
          const pickSide = r.mlPick.side;
          const pickAbbr = pickSide === "home" ? r.homeAbbr : r.awayAbbr;
          const pickBest  = pickSide === "home" ? r.homeMLBest : r.awayMLBest;
          const mlKey = pickSide === "home" ? "homeML" : "awayML";
          rows.push({
            pick_date: today,
            player_name: `${r.awayAbbr} @ ${r.homeAbbr}`,
            player_id: r.gamePk || null,
            team: pickAbbr,
            prop_type: "ml",
            line: 0, model_score: parseFloat((r.mlPick.edge * 100).toFixed(2)),
            conf: parseFloat((r.mlPick.edge * 100).toFixed(2)),
            model_prob: pickSide === "home" ? r.model.homeWinPct : r.model.awayWinPct,
            fair_line: null,
            fd_odds: r.odds?.books?.fanduel?.[mlKey] ?? null,
            dk_odds: r.odds?.books?.draftkings?.[mlKey] ?? null,
            hr_odds: r.odds?.books?.hardrockbet?.[mlKey] ?? null,
            best_book: pickBest?.book ?? null, best_odds: pickBest?.odds ?? null,
            direction: "over", outcome: "pending",
            model_version: tagPick("ml"),
            _signals: buildGameSignals(r, "ml", {
              pickSide,
              mlEdge:      r.mlPick.edge,
              homeMLEdge:  r.homeMLEdge,
              awayMLEdge:  r.awayMLEdge,
              homeMLBest:  r.homeMLBest,
              awayMLBest:  r.awayMLBest,
              isMLPlay:    !!r.isMLPlay,
              isMLEV:      !!r.isMLEV,
            }),
          });
        }
        if (r.isRLPlay && r.rlPick) {
          // Store the PICKED team's spread: home gets -1.5 (must win by 2+), away gets +1.5 (covers even losing by 1)
          const pickedSpread = r.rlPick.side === "home"
            ? (r.spreadPoint ?? -1.5)
            : Math.abs(r.spreadPoint ?? -1.5);
          const rlSide = r.rlPick.side;
          const rlSprKey = rlSide === "home" ? "homeSpread" : "awaySpread";
          // P(picked side covers): run margin ~ Normal(model.margin, σ=√(homeRuns+awayRuns)).
          // home covers if margin > -pickedSpread; away covers if margin < pickedSpread.
          const _rlSigma = Math.sqrt(Math.max(1, (r.model.homeRuns || 0) + (r.model.awayRuns || 0)));
          const _rlMargin = r.model.margin ?? 0;
          const rlCoverProb = +(rlSide === "home"
            ? normalCDF((_rlMargin + pickedSpread) / _rlSigma)
            : normalCDF((pickedSpread - _rlMargin) / _rlSigma)).toFixed(4);
          rows.push({
            pick_date: today,
            player_name: `${r.awayAbbr} @ ${r.homeAbbr}`,
            player_id: r.gamePk || null,
            team: rlSide === "home" ? r.homeAbbr : r.awayAbbr,
            prop_type: "rl",
            line: pickedSpread, model_score: parseFloat((r.rlMarginEdge || 0).toFixed(2)),
            conf: parseFloat((r.rlMarginEdge || 0).toFixed(2)),
            model_prob: rlCoverProb, fair_line: null,
            fd_odds: r.odds?.books?.fanduel?.[rlSprKey]?.price ?? null,
            dk_odds: r.odds?.books?.draftkings?.[rlSprKey]?.price ?? null,
            hr_odds: r.odds?.books?.hardrockbet?.[rlSprKey]?.price ?? null,
            best_book: r.rlBest?.book ?? null, best_odds: r.rlBest?.odds ?? null,
            direction: "over", outcome: "pending",
            model_version: tagPick("rl"),
            _signals: buildGameSignals(r, "rl", {
              pickSide:      rlSide,
              spreadPoint:   r.spreadPoint ?? null,
              pickedSpread,
              rlMarginEdge:  r.rlMarginEdge,
              modelMargin:   r.model.margin,
              rlBest:        r.rlBest ?? null,
              isRLPlay:      !!r.isRLPlay,
            }),
          });
        }
        if (r.isOUPlay && r.gameTotal != null) {
          const ouDir = r.ouDirection;
          const fdOu  = ouDir === "over" ? r.odds?.books?.fanduel?.overOdds  : r.odds?.books?.fanduel?.underOdds;
          const dkOu  = ouDir === "over" ? r.odds?.books?.draftkings?.overOdds  : r.odds?.books?.draftkings?.underOdds;
          const hrOu  = ouDir === "over" ? r.odds?.books?.hardrockbet?.overOdds  : r.odds?.books?.hardrockbet?.underOdds;
          // Whole-number totals can push. Store P(side wins | bet is decided)
          // for calibration, and retain push probability for exact EV below.
          const ouOutcome = ouSideProb(r.model.total, r.gameTotal, ouDir); // NegBin r=7.9 around fair mean + 0.2 x edge (models.js)
          const ouProb = ouOutcome?.conditional == null ? null : +ouOutcome.conditional.toFixed(4);
          rows.push({
            pick_date: today,
            player_name: `${r.awayAbbr} @ ${r.homeAbbr}`,
            player_id: r.gamePk || null,
            team: null,
            prop_type: "ou",
            line: r.gameTotal, model_score: parseFloat(Math.abs(r.ouEdge).toFixed(2)),
            conf: parseFloat(Math.abs(r.ouEdge).toFixed(2)),
            model_prob: ouProb, fair_line: null,
            fd_odds: fdOu ?? null,
            dk_odds: dkOu ?? null,
            hr_odds: hrOu ?? null,
            best_book: r.ouBest?.[0] ?? null, best_odds: r.ouBest?.[1] ?? null,
            direction: ouDir, outcome: "pending",
            model_version: tagPick("ou"),
            _signals: buildGameSignals(r, "ou", {
              gameTotal:    r.gameTotal,
              ouEdge:       r.ouEdge,
              ouDirection:  ouDir,
              pushProbability: ouOutcome?.push ?? 0,
              ouBest:       r.ouBest ?? null,
              isOUPlay:     !!r.isOUPlay,
            }),
          });
        }
      }
      if (rows.length === 0) { setPicksError("No picks to save."); setSaving(false); return; }
      // Stamp decision-time EV (%) on every row so the CLV/self-improvement loop has a
      // complete substrate (ev_pct was historically null on 100% of picks — 2026-06-21).
      // Uses the same calcEVFromOdds the board displays, so stored EV == on-screen EV.
      // Clamped to ev_pct's numeric(5,2) range to survive model_prob≈1.0 longshot artifacts.
      for (const row of rows) {
        const rawEV = (row.model_prob != null && row.best_odds != null)
          ? calcEVFromOdds(row.model_prob, row.best_odds, row._signals?.pushProbability ?? 0) * 100 : null;
        row.ev_pct = rawEV == null ? null
          : Math.max(-999.99, Math.min(999.99, Math.round(rawEV * 100) / 100));
      }
      await sbPost("mlb_picks", rows);
      await loadPicks();
      setAutoLog(`✓ Picks auto-saved for ${today}`);
      setTimeout(() => setAutoLog(""), 8000);
    } catch(e) { setPicksError(e.message); }
    finally { setSaving(false); }
  }, [scanComplete, enrichedScanData, loadPicks]);
  useEffect(() => { saveTodayPicksRef.current = saveTodayPicks; }, [saveTodayPicks]);

  const scorePicks = useCallback(async (dateStr) => {
    if (!dateStr) return;
    setScoring(true); setScoreMsg(""); setPicksError("");
    try {
      const pending = picks.filter(p => p.pick_date === dateStr && p.outcome === "pending");
      if (pending.length === 0) { setScoreMsg(`No pending picks for ${dateStr}.`); setScoring(false); return; }
      const sched = await fetch(`${API}/schedule?sportId=1&date=${dateStr}&gameType=R${SCHEDULE_STATUS_PARAMS}`).then(r=>r.json());
      const schedGames = sched.dates?.[0]?.games || [];
      const gamePks = schedGames.map(g => g.gamePk);

      // Postponed/cancelled (and suspended-with-no-resume-date) games never get a
      // box score, so their picks would sit pending forever — and starve the
      // daily-picks score-poll (2026-06-11 ATL@CWS). Grade those "push": the
      // established no-action outcome, excluded from ROI. Picks are only pushed
      // after normal scoring fails to find data, so a split doubleheader (one
      // game played, one postponed) still grades the played game.
      const deadGamePks = new Set();
      const deadTeamAbbrs = new Set();
      for (const g of schedGames) {
        if (!isDeadGame(g)) continue;
        deadGamePks.add(String(g.gamePk));
        for (const ab of gameTeamAbbrs(g)) deadTeamAbbrs.add(ab);
      }
      const pushDeadGamePick = async (pick) => {
        await sbPatch("mlb_picks", `id=eq.${pick.id}`, { outcome: "push" });
        pushes++;
      };

      // Build team abbreviation → final score map for ML/RL picks
      const gameScoreByPk = {}; // gamePk → { homeAbbr, awayAbbr, homeScore, awayScore, isFinal }
      const boxResults = {};
      await Promise.all(gamePks.map(async gk => {
        try {
          const box = await fetch(`${API}/game/${gk}/boxscore`).then(r=>r.json());
          const homeAbbr = box.teams?.home?.team?.abbreviation;
          const awayAbbr = box.teams?.away?.team?.abbreviation;
          const homeScore = box.teams?.home?.teamStats?.batting?.runs ?? null;
          const awayScore = box.teams?.away?.teamStats?.batting?.runs ?? null;
          const isFinal = box.gameBoxscore?.status?.abstractGameState === "Final" ||
            box.teams?.home?.teamStats?.batting?.atBats > 0;
          if (homeAbbr && awayAbbr && homeScore != null && awayScore != null) {
            gameScoreByPk[gk] = { homeAbbr, awayAbbr, homeScore, awayScore, isFinal };
          }
          for (const side of ["home","away"]) {
            const batters = box.teams?.[side]?.batters || [];
            const pitchers = box.teams?.[side]?.pitchers || [];
            const players = box.teams?.[side]?.players || {};
            for (const pid of [...batters, ...pitchers]) {
              const pdata = players[`ID${pid}`];
              if (pdata?.stats) boxResults[pid] = pdata.stats;
            }
          }
        } catch {}
      }));

      // First-inning runs for `nrfi` picks. The boxscore carries no inning-by-inning
      // line, so pull the linescore — but only for games a pending NRFI pick actually
      // references. The 1st must be COMPLETE (currentInning > 1) before a scoreless
      // first can grade an NRFI win; a run already in clinches YRFI immediately.
      const firstInningByPk = {}; // gamePk → runs in the 1st
      const nrfiPks = [...new Set(pending.filter(p => p.prop_type === "nrfi").map(p => String(p.player_id)))];
      await Promise.all(nrfiPks.map(async gk => {
        try {
          const ls = await fetch(`${API}/game/${gk}/linescore`).then(r => r.json());
          const inn1 = ls.innings?.[0];
          if (inn1?.home?.runs == null || inn1?.away?.runs == null) return;
          const r1 = inn1.home.runs + inn1.away.runs;
          if (r1 > 0 || (ls.currentInning || 0) > 1) firstInningByPk[gk] = r1;
        } catch {}
      }));

      // Also build a team-abbr → score lookup for game picks
      const scoreByTeam = {}; // abbr → { score, opponentScore, gamePk }
      for (const [gk, gs] of Object.entries(gameScoreByPk)) {
        scoreByTeam[gs.homeAbbr] = { score: gs.homeScore, opponentScore: gs.awayScore, gamePk: gk };
        scoreByTeam[gs.awayAbbr] = { score: gs.awayScore, opponentScore: gs.homeScore, gamePk: gk };
      }

      const getActual = (stats, propType) => {
        const b = stats?.batting || {};
        const p = stats?.pitching || {};
        switch(propType) {
          case "hits":   case "hits15": return b.hits ?? null;
          case "hr":     return b.homeRuns ?? null;
          case "tb":     return (b.hits != null) ? (b.hits - (b.doubles||0) - (b.triples||0) - (b.homeRuns||0)) + (b.doubles||0)*2 + (b.triples||0)*3 + (b.homeRuns||0)*4 : null;
          case "hrr":    return (b.hits != null) ? (b.hits||0) + (b.runs||0) + (b.rbi||0) : null;
          case "sb":     return b.stolenBases ?? null;
          case "rbi":    return b.rbi ?? null;
          case "ks":     return p.strikeOuts ?? null;
          // Pitch Lab pitcher props — the official box line, as books grade them.
          case "outs":   return p.outs ?? (p.inningsPitched != null ? Math.round(ipToDec(p.inningsPitched) * 3) : null);
          case "hits_allowed": return p.hits ?? null;
          case "walks":  return p.baseOnBalls ?? null;
          case "er":     return p.earnedRuns ?? null;
          default:       return null;
        }
      };
      let wins=0, losses=0, pushes=0;
      for (const pick of pending) {
        if (pick.prop_type === "nrfi") {
          const r1 = firstInningByPk[String(pick.player_id)];
          if (r1 == null) {
            if (deadGamePks.has(String(pick.player_id))) await pushDeadGamePick(pick);
            continue;
          }
          // over 0.5 = YRFI, under 0.5 = NRFI. A 0.5 line cannot push.
          const outcome = pick.direction === "under"
            ? (r1 < pick.line ? "win" : "loss")
            : (r1 > pick.line ? "win" : "loss");
          await sbPatch("mlb_picks", `id=eq.${pick.id}`, { result: r1, outcome });
          if (outcome === "win") wins++; else losses++;
          continue;
        }
        if (pick.prop_type === "ml" || pick.prop_type === "rl" || pick.prop_type === "ou") {
          if (pick.prop_type === "ou") {
            const gs = gameScoreByPk[pick.player_id];
            if (!gs) {
              if (deadGamePks.has(String(pick.player_id))) await pushDeadGamePick(pick);
              continue;
            }
            const actualTotal = gs.homeScore + gs.awayScore;
            const line = pick.line;
            let outcome = null;
            if (pick.direction === "over") {
              if (actualTotal > line) outcome = "win";
              else if (actualTotal < line) outcome = "loss";
              else outcome = "push";
            } else {
              if (actualTotal < line) outcome = "win";
              else if (actualTotal > line) outcome = "loss";
              else outcome = "push";
            }
            if (outcome) {
              await sbPatch("mlb_picks", `id=eq.${pick.id}`, { result: actualTotal, outcome });
              if (outcome === "win") wins++;
              else if (outcome === "loss") losses++;
              else pushes++;
            }
            continue;
          }
          const gs = scoreByTeam[pick.team];
          if (!gs) {
            // ml/rl store the gamePk in player_id; fall back to team abbr
            if (deadGamePks.has(String(pick.player_id)) || deadTeamAbbrs.has(pick.team)) await pushDeadGamePick(pick);
            continue;
          }
          let outcome = null;
          if (pick.prop_type === "ml") {
            if (gs.score > gs.opponentScore) outcome = "win";
            else if (gs.score < gs.opponentScore) outcome = "loss";
            else outcome = "push";
          } else {
            // RL: picked team must cover the spread (line is the spread point, e.g. -1.5)
            const spread = pick.line ?? -1.5; // negative means favored (e.g. -1.5 means win by 2+)
            const margin = gs.score - gs.opponentScore; // positive = picked team winning
            const covered = margin + spread; // > 0 means covered
            if (covered > 0) outcome = "win";
            else if (covered < 0) outcome = "loss";
            else outcome = "push";
          }
          if (outcome) {
            await sbPatch("mlb_picks", `id=eq.${pick.id}`, { result: gs.score, outcome });
            if (outcome === "win") wins++;
            else if (outcome === "loss") losses++;
            else pushes++;
          }
          continue;
        }
        const stats = boxResults[pick.player_id];
        if (!stats) {
          // Player props store the MLB player id, not a gamePk — map via team abbr.
          if (deadTeamAbbrs.has(pick.team)) await pushDeadGamePick(pick);
          continue;
        }
        const actual = getActual(stats, pick.prop_type);
        if (actual === null) continue;
        const dir = pick.direction || "over";
        const outcome = dir === "under"
          ? (actual < pick.line ? "win" : actual === pick.line ? "push" : "loss")
          : (actual > pick.line ? "win" : actual === pick.line ? "push" : "loss");
        await sbPatch("mlb_picks", `id=eq.${pick.id}`, { result: actual, outcome });
        if (outcome === "win") wins++;
        else if (outcome === "loss") losses++;
        else pushes++;
      }
      setScoreMsg(`Scored ${wins+losses+pushes} picks: ${wins}W / ${losses}L / ${pushes}P`);
      await loadPicks();
    } catch(e) { setPicksError(e.message); }
    finally { setScoring(false); }
  }, [picks, loadPicks]);
  useEffect(() => { scorePicksRef.current = scorePicks; }, [scorePicks]);

  return (
    <div style={{ minHeight: "100vh", width: "100%", maxWidth: "100vw", overflowX: "clip", background: "linear-gradient(160deg, #e3e9f3 0%, #eaeef6 40%, #eef2f9 100%)", color: "#3c4f6d", fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        html, body, #root, #__next, [data-reactroot] {
          overflow-x: clip;
          background: #e6ebf4 !important;
          min-height: 100vh;
          width: 100% !important;
        }
        body > div, body > div > div { background: #e6ebf4 !important; width: 100% !important; }
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(32,98,200,0.2); border-radius: 3px; }
        .mono { font-family: 'JetBrains Mono', monospace; text-align: center; color: #4c5f7d; font-size: 12px; }
        .th-sm { padding: 4px 6px; text-align: center; color: #74839d; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; }
        .td-sm { padding: 4px 6px; text-align: center; color: #5d6f8b; font-size: 12px; }
        .td-sm.mono { font-family: 'JetBrains Mono', monospace; }
        @keyframes slideIn { from { transform: translateX(100%); } to { transform: translateX(0); } }
        @keyframes spin { to { transform: rotate(360deg); } }
        .spin { animation: spin 0.8s linear infinite; }
        @keyframes fadeUp { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
        .fade-up { animation: fadeUp 0.4s ease-out both; }

        /* ── Mobile responsive ───────────────────────────────────────────────── */
        @media (max-width: 700px) {
          /* Hide secondary table columns */
          .hide-mobile { display: none !important; }
          /* Compact table cells */
          .th-sm { padding: 3px 4px; font-size: 9px; }
          .td-sm { padding: 3px 4px; font-size: 10px; }
          /* Header subtitle */
          .header-subtitle { display: none; }
          /* Header action labels (show icon only) */
          .btn-label { display: none; }
          /* Header title smaller */
          .header-title { font-size: 15px !important; }
          /* Tab buttons more touch-friendly */
          .tab-btn { padding: 8px 8px !important; font-size: 10px !important; }
          /* Ensure content area doesn't overflow */
          .page-content { padding: 12px !important; }
        }
      `}</style>

      {/* Header */}
      <div style={{ borderBottom: "1px solid rgba(255,255,255,0.08)", background: "rgba(21,38,67,0.97)", backdropFilter: "blur(20px)", position: "sticky", top: 0, zIndex: 100 }}>
        {/* Main header row */}
        <div style={{ padding: isMobile ? "10px 12px 6px" : "12px 20px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: isMobile ? 8 : 14, minWidth: 0 }}>
            <SportSwitcher isMobile={isMobile} />
            <div style={{ minWidth: 0 }}>
              <div className="header-title" style={{ fontSize: 18, fontWeight: 700, color: "#eef2f9", letterSpacing: -0.5, whiteSpace: "nowrap" }}>MLB Research Dashboard</div>
              <div className="header-subtitle" style={{ fontSize: 11, color: "#8fa2c4" }}>Research Dashboard · {season} Season · {PROJ_BATTERS.length} Batters · {PROJ_PITCHERS.length} Pitchers · {Object.keys(PARK_DATA).length} Parks</div>
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3, flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: isMobile ? 4 : 8, flexShrink: 0 }}>
            {/* Player Search — desktop only here; mobile gets full-width row below */}
            {!isMobile && (
              <button onClick={() => setPlayerSearchOpen(true)} title="Search players" style={{
                display: "flex", alignItems: "center", gap: 5, padding: "6px 10px", fontSize: 11, fontWeight: 600,
                background: "rgba(91,224,143,0.12)", border: "1px solid rgba(91,224,143,0.3)",
                borderRadius: 6, color: "#5be08f", cursor: "pointer", transition: "all 0.15s",
              }}>
                🔍
              </button>
            )}
            <button onClick={refreshLineups} disabled={lineupRefreshing} title="Refresh lineups from Rotowire" style={{
              display: "flex", alignItems: "center", gap: 5, padding: isMobile ? "7px 9px" : "6px 10px", fontSize: 11, fontWeight: 600,
              background: lineupRefreshing ? "rgba(125,182,255,0.06)" : "rgba(125,182,255,0.12)",
              border: "1px solid rgba(125,182,255,0.3)", borderRadius: 6, color: lineupRefreshing ? "#6f82a6" : "#7db6ff",
              cursor: lineupRefreshing ? "default" : "pointer", transition: "all 0.15s", whiteSpace: "nowrap",
            }}>
              <span style={{ display: "inline-block", animation: lineupRefreshing ? "spin 1s linear infinite" : "none", fontSize: 13 }}>↻</span>
              <span className="btn-label">{lineupRefreshing ? "Fetching…" : "Lineups"}</span>
            </button>
            <button onClick={toggleSabHints} title={sabHints ? "Sabermetric hints ON — click to turn off" : "Sabermetric hints OFF — click to turn on"} style={{
              display: "flex", alignItems: "center", gap: 4, padding: isMobile ? "7px 9px" : "6px 10px", fontSize: 11, fontWeight: 600,
              background: sabHints ? "rgba(179,157,252,0.16)" : "rgba(255,255,255,0.05)",
              border: sabHints ? "1px solid rgba(179,157,252,0.45)" : "1px solid rgba(255,255,255,0.14)",
              borderRadius: 6, color: sabHints ? "#b39dfc" : "#8b9cbd",
              cursor: "pointer", transition: "all 0.15s", whiteSpace: "nowrap",
            }}>
              🎓<span className="btn-label"> {sabHints ? "Hints ON" : "Hints"}</span>
            </button>
            <DatePicker value={date} onChange={setDate} />
          </div>
          {oddsCredits && (
            <div style={{ fontSize: 10, color: oddsCredits.remaining != null && oddsCredits.remaining < 100 ? "#ff8f8f" : "#8fa2c4", textAlign: "right", paddingRight: 4, fontFamily: "'JetBrains Mono', monospace", letterSpacing: "0.02em" }}>
              odds api: {oddsCredits.used != null ? `${oddsCredits.used} used` : ""}{oddsCredits.used != null && oddsCredits.remaining != null ? " · " : ""}{oddsCredits.remaining != null ? `${oddsCredits.remaining} left` : ""}
            </div>
          )}
          </div>
        </div>
        {/* Mobile: search button as its own full-width row below the header */}
        {isMobile && (
          <div style={{ padding: "0 12px 8px" }}>
            <button onClick={() => setPlayerSearchOpen(true)} style={{
              width: "100%", display: "flex", alignItems: "center", gap: 8,
              padding: "7px 12px", fontSize: 12, fontWeight: 600,
              background: "rgba(91,224,143,0.1)", border: "1px solid rgba(91,224,143,0.25)",
              borderRadius: 7, color: "#5be08f", cursor: "pointer",
            }}>
              <span>🔍</span>
              <span style={{ color: "#84ac90", fontWeight: 500 }}>Search players…</span>
            </button>
          </div>
        )}
      </div>

      {/* Tab Navigation */}
      <div className="hscroll" style={{ padding: "0 20px", borderBottom: "1px solid rgba(255,255,255,0.06)", background: "#1b2e51" }}>
        <div style={{ display: "flex", gap: 2, paddingTop: 8 }}>
          {[
            { key: "today", label: "Today", emoji: "📅" },
            { key: "results", label: "Results", emoji: "📈" },
            { key: "games", label: "Games", emoji: "⚾" },
            // The six batter prop boards (hits/hrr/hr/tb/sb/rbi) collapse behind
            // this one parent tab; BatterBoardTabs renders the sub-strip.
            { key: "batter", label: "Batter Props", emoji: "🥎", parent: true },
            { key: "ks", label: "Ks", emoji: "⚾" },
            { key: "pprops", label: "Pitcher Props", emoji: "🧤" },
            { key: "firstinning", label: "1st Inning", emoji: "1️⃣" },
            { key: "slate", label: "Slate Odds", emoji: "🎰" },
            { key: "golden", label: "Golden 10", emoji: "🏆" },
            { key: "braintrust", label: "Brain Trust", emoji: "💎" },
            { key: "leaders", label: "Leaders", emoji: "📊" },
            { key: "payroll", label: "Payroll", emoji: "💰" },
            { key: "cracked", label: "Cracked", emoji: "💥" },
            { key: "props", label: "Props", emoji: "📋" },
            { key: "bullpen", label: "Bullpen", emoji: "🛡" },
            { key: "matchup", label: "Matchup", emoji: "🔬" },
            { key: "model", label: "Model", emoji: "🧠" },
            { key: "findings", label: "Findings", emoji: "🔍" },
          ].map(tab => {
            const isActive = tab.parent ? BATTER_BOARDS.some(b => b.key === page) : page === tab.key;
            const pickCount = tab.parent
              ? BATTER_BOARDS.reduce((sum, b) => sum + (enrichedScanData?.byModel?.[b.key]?.filter(p => !p.watch).length || 0), 0)
              : (tab.key !== "games" && tab.key !== "today" && tab.key !== "ks" && tab.key !== "pprops" && tab.key !== "leaders" && tab.key !== "golden" && enrichedScanData?.byModel?.[tab.key]?.length);
            return (
              <button key={tab.key} onClick={() => { setPage(tab.parent ? lastBatterBoard : tab.key); if (tab.key === "games" || tab.key === "today" || tab.key === "slate" || tab.key === "ks" || tab.key === "pprops" || tab.key === "firstinning" || tab.key === "cracked" || tab.key === "bullpen" || tab.key === "matchup" || tab.key === "leaders" || tab.key === "payroll" || tab.key === "results" || tab.key === "props" || tab.key === "golden" || tab.key === "braintrust" || tab.key === "findings") setSelectedBatter(null); }}
                style={{
                  padding: "8px 12px", fontSize: 11, fontWeight: 600, whiteSpace: "nowrap",
                  background: isActive ? "rgba(125,182,255,0.14)" : "transparent",
                  color: isActive ? "#7db6ff" : "#8b9cbd",
                  borderBottom: isActive ? "2px solid #7db6ff" : "2px solid transparent",
                  border: "none", borderRadius: "6px 6px 0 0", cursor: "pointer",
                  transition: "all 0.15s",
                  display: "flex", alignItems: "center", gap: 4,
                }}>
                <span>{tab.emoji}</span>{tab.label}
                {pickCount > 0 && <span style={{ fontSize: 9, fontWeight: 700, color: "#5be08f", background: "rgba(91,224,143,0.16)", padding: "1px 5px", borderRadius: 8, marginLeft: 2 }}>{pickCount}</span>}
                {tab.key === "ks" && enrichedScanData?.pitchers?.length > 0 && <span style={{ fontSize: 9, fontWeight: 700, color: "#5be08f", background: "rgba(91,224,143,0.16)", padding: "1px 5px", borderRadius: 8, marginLeft: 2 }}>{enrichedScanData.pitchers.length}</span>}
              </button>
            );
          })}
        </div>
      </div>

      {/* Scheduled-pipeline health. Renders nothing unless a source is actually
          down or has a hole, so it costs no vertical space on a normal day.
          Sits directly under the nav rather than on one page: a dead cron shows
          up as missing rows on whichever board you happen to open. */}
      <PipelineHealth />

      {/* Scan Overlay — shown while preloading all prop data */}
      {!loading && games.length > 0 && !scanComplete && page !== "games" && page !== "today" && page !== "slate" && page !== "ks" && page !== "pprops" && page !== "firstinning" && page !== "cracked" && page !== "bullpen" && page !== "matchup" && page !== "leaders" && page !== "payroll" && page !== "model" && page !== "results" && page !== "golden" && page !== "braintrust" && page !== "findings" && (
        <ScanOverlay progress={scanProgress} gameCount={games.length} />
      )}

      {/* Page Content */}
      <ErrorBoundary resetKey={page} label="This board">
      {page === "today" ? (
        <TodayBoard scanData={enrichedScanData} scanComplete={scanComplete} scanProgress={scanProgress}
          games={games} season={season} lineupData={lineupData} babyBumpPlayers={babyBumpPlayers}
          probableFor={probableFor}
          onSelectBatter={(pick) => {
            setSelectedBatter(enrichBatterWithMatchup({
              id: pick.playerId,
              fullName: pick.name,
              batSide: pick.batSide ? { code: pick.batSide } : null,
              position: { abbreviation: pick.position },
              batterTeam: pick.team,
              opponentPitcherId: pick.oppPitcherId ?? null,
              opponentPitcherName: pick.oppPitcher ?? null,
              opponentPitcherTeam: pick.opponent ?? null,
              opponentPitcherHand: pick.oppPitcherHand ?? null,
              isHome: pick.isHome,
              gamePk: pick.game?.gamePk,
              homeTeamAbbrev: pick.game?.teams?.home?.team?.abbreviation,
              venueName: pick.venue,
            }));
          }}
          onSelectPitcher={(p) => setSelectedPitcher(enrichPitcherWithMatchup({
            pitcher: { id: p.pitcherId, fullName: p.name, pitchHand: p.hand ? { code: p.hand } : undefined },
            pitcherTeam: p.team,
            pitcherScanData: p,
          }))} />
      ) : page === "games" ? (<>
      {(() => {
        // Filter games: hide genuinely started (In Progress / Final) games when
        // toggle is on. Warmup is excluded so pre-first-pitch games stay visible.
        const gamesForDisplay = hideStarted
          ? games.filter(gm => !isGameStarted(gm.status, gm.gameDate))
          : games;
        const startedCount = games.filter(gm => isGameStarted(gm.status, gm.gameDate)).length;
        // If selected game is now hidden, auto-select first visible game
        const visibleSelected = !hideStarted || gamesForDisplay.some(gm => gm.gamePk === selectedGame?.gamePk);
        if (hideStarted && !visibleSelected && gamesForDisplay.length > 0) {
          // defer to avoid setState-in-render
          setTimeout(() => setSelectedGame(gamesForDisplay[0]), 0);
        }
        return (
      <div style={{ padding: "16px 20px", borderBottom: "1px solid rgba(32,98,200,0.128)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <div style={{ fontSize: 10, color: "#74839d", textTransform: "uppercase", letterSpacing: 1.2 }}>
            {displayDate} · {gamesForDisplay.length}{hideStarted && startedCount > 0 ? `/${games.length}` : ""} Game{games.length !== 1 ? "s" : ""}
            {hideStarted && startedCount > 0 && <span style={{ color: "#b6c5dc", marginLeft: 4 }}>({startedCount} hidden)</span>}
          </div>
          {!loading && games.length > 0 && startedCount > 0 && (
            <button onClick={() => setHideStarted(h => !h)} style={{
              display: "flex", alignItems: "center", gap: 5, padding: "4px 10px",
              fontSize: 10, fontWeight: 600, borderRadius: 6, cursor: "pointer",
              background: hideStarted ? "rgba(194,87,15,0.12)" : "rgba(210,217,236,0.4)",
              border: hideStarted ? "1px solid rgba(194,87,15,0.35)" : "1px solid rgba(32,98,200,0.24)",
              color: hideStarted ? "#c2570f" : "#74839d",
              transition: "all 0.15s",
            }}>
              <span style={{ fontSize: 12 }}>{hideStarted ? "🔴" : "⚪"}</span>
              Hide Started
            </button>
          )}
        </div>
        {loading ? <Loader text="Loading schedule..." /> : games.length === 0 ? null : (
          <div className="hscroll" style={{ display: "flex", gap: 10, paddingBottom: 8 }}>
            {gamesForDisplay.map(game => <GameCard key={game.gamePk} game={game} isSelected={selectedGame?.gamePk === game.gamePk} onClick={() => { setSelectedGame(game); setSelectedBatter(null); }} lineupData={lineupData} />)}
          </div>
        )}
      </div>
        );
      })()}

      {!loading && games.length === 0 && <NoGames date={date} />}

      {g && (
        <div className="fade-up" style={{ padding: "24px 20px" }} key={g.gamePk}>
          {(() => {
            const go = getGameOdds(oddsData, away.team.name, home.team.name);
            const bkKeys = ["fanduel","draftkings","hardrockbet"];
            function OddsPanel({ side }) {
              // side: "away" | "home"
              const align = side === "away" ? "right" : "left";
              return (
                <div style={{ textAlign: align, minWidth: 110 }}>
                  {go ? bkKeys.map(bk => {
                    const d = go.books[bk];
                    if (!d) return null;
                    const ml = side === "away" ? d.awayML : d.homeML;
                    const spr = side === "away" ? d.awaySpread : d.homeSpread;
                    if (ml == null && !spr) return null;
                    return (
                      <div key={bk} style={{ display: "flex", alignItems: "center", gap: 4, justifyContent: align === "right" ? "flex-end" : "flex-start", marginBottom: 2 }}>
                        <span style={{ fontSize: 9, fontWeight: 700, color: BOOK_COLORS[bk], minWidth: 18 }}>{BOOK_ABBR[bk]}</span>
                        {ml != null && <span style={{ fontSize: 10, fontFamily: "'JetBrains Mono',monospace", color: ml > 0 ? "#0f8a44" : "#3c4f6d" }}>{formatOdds(ml)}</span>}
                        {spr && <span style={{ fontSize: 9, fontFamily: "'JetBrains Mono',monospace", color: "#74839d" }}>
                          {spr.point > 0 ? "+" : ""}{spr.point} ({formatOdds(spr.price)})
                        </span>}
                      </div>
                    );
                  }) : <div style={{ fontSize: 10, color: "#c9d5e8" }}>—</div>}
                </div>
              );
            }
            return (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: isMobile ? 10 : 24, marginBottom: 28, padding: "20px 0", flexWrap: isMobile ? "wrap" : undefined }}>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: isMobile ? 22 : 28, fontWeight: 700, color: awayColor }}>{away.team.abbreviation}</div>
                  <div style={{ fontSize: 12, color: "#6d7c96" }}>{away.team.name}</div>
                  {away.leagueRecord && <div style={{ fontSize: 10, color: "#6d7c96", fontFamily: "'JetBrains Mono',monospace" }}>{away.leagueRecord.wins}-{away.leagueRecord.losses}</div>}
                  {teamManagers[away.team.id] && <div style={{ fontSize: 10, color: "#6d7c96", fontFamily: "'JetBrains Mono',monospace", marginTop: 1 }}>{teamManagers[away.team.id]}</div>}
                </div>
                {!isMobile && <OddsPanel side="away" />}
                <div style={{ fontSize: 12, color: "#8b99b0", padding: "8px 16px", background: "rgba(210,217,236,0.5)", borderRadius: 8, border: "1px solid rgba(32,98,200,0.16)", textAlign: "center" }}>
                  <div>{g.venue?.name || ""}</div>
                  {(() => {
                    const pk = getParkData(g.venue?.name, home?.team?.abbreviation);
                    const hrL  = parkWeatherMult(pk, gameWeather, "L", "HR");
                    const hrR  = parkWeatherMult(pk, gameWeather, "R", "HR");
                    const hrM  = pk ? (hrL + hrR) / 2 : null;
                    const dbM  = parkWeatherMult(pk, gameWeather, "R", "2B");
                    const tbM  = parkWeatherMult(pk, gameWeather, "R", "3B");
                    const xtraM = pk ? dbM * 0.75 + tbM * 0.25 : null;
                    const fmtPF = v => { const p = Math.round((v - 1) * 100); return (p >= 0 ? "+" : "") + p + "%"; };
                    const pfColor = v => v >= 1.05 ? "#0f8a44" : v >= 1.01 ? "#1c9a50" : v <= 0.95 ? "#d03131" : v <= 0.99 ? "#c25555" : "#74839d";
                    // Roof closed (dome, or retractable w/ rain/cold) → temp+wind are suppressed in the
                    // multipliers above. Reflect that in the display so the weather string isn't mistaken
                    // for an applied park factor. Mirrors the Weather tab's getRoofStatus badge.
                    const wxNeutral = isWeatherNeutral(pk, gameWeather);
                    const roofStat = pk ? getRoofStatus(pk, gameWeather) : null;
                    return (<>
                      {pk && <div style={{ fontSize: 10, color: "#b6c5dc", fontFamily: "'JetBrains Mono', monospace", marginTop: 2 }}>
                        {pk.dims.LF}-{pk.dims.LCF}-{pk.dims.CF}-{pk.dims.RCF}-{pk.dims.RF}
                        {pk.elev > 3000 ? ` · ⛰ ${pk.elev.toLocaleString()}ft` : ""}
                        {pk.roof !== "open" && roofStat ? <span style={{ color: roofStat.color, fontWeight: 700 }}> · {pk.roof === "dome" ? "🏛" : "🔄"} {roofStat.label}</span> : null}
                      </div>}
                      {gameWeather ? (
                        <div style={{ fontSize: 10, color: wxNeutral ? "#9aa6ba" : "#6e88a3", marginTop: 2, textDecoration: wxNeutral ? "line-through" : undefined }} title={wxNeutral ? "Roof closed — temp & wind not applied to projections" : undefined}>
                          {gameWeather.temp != null && `🌡 ${gameWeather.temp}°F`}
                          {gameWeather.windSpeed > 0 && ` · 💨 ${gameWeather.windSpeed}mph ${gameWeather.windDir}`}
                          {gameWeather.condition && ` · ${gameWeather.condition}`}
                        </div>
                      ) : pk?.roof === "open" && (
                        <div style={{ fontSize: 10, color: "#b6c5dc", marginTop: 2 }}>Weather loading…</div>
                      )}
                      {pk && hrM !== null && (
                        <div style={{ display: "flex", gap: 10, justifyContent: "center", marginTop: 5, fontSize: 10, fontFamily: "'JetBrains Mono',monospace", fontWeight: 700 }}>
                          <span>HR <span style={{ color: pfColor(hrM) }}>{fmtPF(hrM)}</span></span>
                          <span>2B/3B <span style={{ color: pfColor(xtraM) }}>{fmtPF(xtraM)}</span></span>
                        </div>
                      )}
                    </>);
                  })()}
                </div>
                {!isMobile && <OddsPanel side="home" />}
                <div style={{ textAlign: "left" }}>
                  <div style={{ fontSize: isMobile ? 22 : 28, fontWeight: 700, color: homeColor }}>{home.team.abbreviation}</div>
                  <div style={{ fontSize: 12, color: "#6d7c96" }}>{home.team.name}</div>
                  {home.leagueRecord && <div style={{ fontSize: 10, color: "#6d7c96", fontFamily: "'JetBrains Mono',monospace" }}>{home.leagueRecord.wins}-{home.leagueRecord.losses}</div>}
                  {teamManagers[home.team.id] && <div style={{ fontSize: 10, color: "#6d7c96", fontFamily: "'JetBrains Mono',monospace", marginTop: 1 }}>{teamManagers[home.team.id]}</div>}
                </div>
              </div>
            );
          })()}

          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: isMobile ? 16 : 20, marginBottom: 32, minWidth: 0 }}>
            <div style={{ minWidth: 0, overflow: "hidden" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: awayColor, textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ width: 3, height: 14, background: awayColor, borderRadius: 2 }} />{away.team.abbreviation} · Probable Starter
              </div>
              <PitcherCard pitcher={awayProbable} teamColor={awayColor} season={season}
                onDetails={p => setSelectedPitcher({ pitcher: p, pitcherTeam: away.team.abbreviation, opponentTeam: home.team.abbreviation, venueName: g?.venue?.name })} />
              <div style={{ marginTop: 20 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: awayColor, textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ width: 3, height: 14, background: awayColor, borderRadius: 2 }} />
                  {away.team.abbreviation} · {lineupData[away.team.abbreviation]?.batters?.length ? (lineupData[away.team.abbreviation].confirmed ? "Confirmed Lineup" : "Projected Lineup") : "Roster"}
                </div>
                <LineupPanel teamId={away.team.id} teamName={away.team.abbreviation} teamColor={awayColor}
                  homeTeamAbbrev={home.team.abbreviation}
                  pitcherId={homeProbable?.id} pitcherName={homeProbable?.fullName} season={season}
                  lineupPlayers={lineupData[away.team.abbreviation]} babyBumpIds={babyBumpIds}
                  onSelectBatter={b => setSelectedBatter(enrichBatterWithMatchup({ ...b, batterTeam: away.team.abbreviation, opponentPitcherId: homeProbable?.id ?? null, opponentPitcherName: homeProbable?.fullName ?? null, opponentPitcherTeam: home.team?.abbreviation ?? null, isHome: false, gamePk: g?.gamePk, homeTeamAbbrev: home?.team?.abbreviation, venueName: g?.venue?.name }))} />
              </div>
            </div>
            <div style={{ minWidth: 0, overflow: "hidden" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: homeColor, textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ width: 3, height: 14, background: homeColor, borderRadius: 2 }} />{home.team.abbreviation} · Probable Starter
              </div>
              <PitcherCard pitcher={homeProbable} teamColor={homeColor} season={season}
                onDetails={p => setSelectedPitcher({ pitcher: p, pitcherTeam: home.team.abbreviation, opponentTeam: away.team.abbreviation, venueName: g?.venue?.name })} />
              <div style={{ marginTop: 20 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: homeColor, textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ width: 3, height: 14, background: homeColor, borderRadius: 2 }} />
                  {home.team.abbreviation} · {lineupData[home.team.abbreviation]?.batters?.length ? (lineupData[home.team.abbreviation].confirmed ? "Confirmed Lineup" : "Projected Lineup") : "Roster"}
                </div>
                <LineupPanel teamId={home.team.id} teamName={home.team.abbreviation} teamColor={homeColor}
                  homeTeamAbbrev={home.team.abbreviation}
                  pitcherId={awayProbable?.id} pitcherName={awayProbable?.fullName} season={season}
                  lineupPlayers={lineupData[home.team.abbreviation]} babyBumpIds={babyBumpIds}
                  onSelectBatter={b => setSelectedBatter(enrichBatterWithMatchup({ ...b, batterTeam: home.team.abbreviation, opponentPitcherId: awayProbable?.id ?? null, opponentPitcherName: awayProbable?.fullName ?? null, opponentPitcherTeam: away.team?.abbreviation ?? null, isHome: true, gamePk: g?.gamePk, homeTeamAbbrev: home?.team?.abbreviation, venueName: g?.venue?.name }))} />
              </div>
            </div>
          </div>
        </div>
      )}

      </>) : (
        /* Dashboard Pages — instant, data already preloaded */
        page === "slate" ? (
          // SlateOddsTab is rendered always-mounted below so Golden 10 can use its picks.
          // This branch is intentionally empty — visibility is controlled by the hidden mount.
          null
        ) : page === "firstinning" ? (
          <FirstInning games={games} date={date} lineupData={lineupData} />
        ) : page === "golden" ? (
          <GoldenBoard
            scanData={enrichedScanData}
            scanComplete={scanComplete}
            slateRows={slateRowsState}
            games={games}
            date={date}
            onSelectBatter={(pick) => {
              setSelectedBatter(enrichBatterWithMatchup({
                id: pick.playerId,
                fullName: pick.name,
                batSide: pick.batSide ? { code: pick.batSide } : null,
                position: { abbreviation: pick.position },
                batterTeam: pick.team ?? null,
                opponentPitcherId: pick.oppPitcherId ?? null,
                opponentPitcherName: pick.oppPitcher ?? null,
                opponentPitcherTeam: pick.opponent ?? null,
                opponentPitcherHand: pick.oppPitcherHand ?? null,
                isHome: pick.isHome,
                gamePk: pick.game?.gamePk,
                homeTeamAbbrev: pick.game?.teams?.home?.team?.abbreviation,
                venueName: pick.venue,
              }));
            }}
            onSelectPitcher={(p) => setSelectedPitcher(enrichPitcherWithMatchup(p))} />
        ) : page === "braintrust" ? (
          <BrainTrust
            enrichedScanData={enrichedScanData}
            propOddsMap={propOddsMap}
            lookupBookOdds={lookupBookOdds}
            getAllLinesFromMap={getAllLinesFromMap} />
        ) : page === "bullpen" ? (
          <BullpenPanel season={season} />
        ) : page === "model" ? (
          <ModelGate label="Model"><ModelBreakdown /></ModelGate>
        ) : page === "results" ? (
          <>
            <ControllerStatus health={marketHealth} />
            <ResultsTab scanComplete={scanComplete}
              picks={picks} picksLoading={picksLoading} saving={saving} scoring={scoring}
              scoreMsg={scoreMsg} picksError={picksError} clearPicksError={() => setPicksError("")} autoLog={autoLog}
              loadPicks={loadPicks} saveTodayPicks={saveTodayPicks} scorePicks={scorePicks}
              marketHealth={marketHealth} />
          </>
        ) : page === "findings" ? (
          <ModelGate label="Findings"><FindingsTab /></ModelGate>
        ) : page === "matchup" ? (
          <MatchupEvaluator season={season} />
        ) : page === "leaders" ? (
          <LeadersBoard
            season={season}
            enrichedScanData={enrichedScanData}
            onSelectBatter={(pick) => setSelectedBatter(enrichBatterWithMatchup(pick))}
            onSelectPitcher={(p) => setSelectedPitcher(enrichPitcherWithMatchup(p))}
          />
        ) : page === "payroll" ? (
          <PayrollBoard season={season} />
        ) : page === "props" ? (
          scanComplete
            ? <ConsolidatedPropsTable
                enrichedScanData={enrichedScanData}
                games={games}
                onSelectBatter={(pick) => setSelectedBatter(enrichBatterWithMatchup({
                  id: pick.playerId, fullName: pick.name,
                  batSide: { code: pick.batSide }, position: { abbreviation: pick.position },
                  currentTeam: { id: pick.teamId },
                  team: pick.team,
                  _scanPick: pick,
                }))}
                onSelectPitcher={(p) => setSelectedPitcher(enrichPitcherWithMatchup(p))}
              />
            : <ScanOverlay progress={scanProgress} gameCount={games.length} />
        ) : page === "ks" ? (
          scanComplete
            ? <KsBoard scanData={enrichedScanData} windowData={statcastRef} onSelectPitcher={(p) => setSelectedPitcher(enrichPitcherWithMatchup({
                pitcher: { id: p.pitcherId, fullName: p.name, pitchHand: p.hand ? { code: p.hand } : undefined },
                pitcherTeam: p.team,
                pitcherScanData: p,
              }))} />
            : <ScanOverlay progress={scanProgress} gameCount={games.length} />
        ) : page === "pprops" ? (
          scanComplete
            ? <PitcherPropsBoard scanData={enrichedScanData} onSelectPitcher={(p) => setSelectedPitcher(enrichPitcherWithMatchup({
                pitcher: { id: p.pitcherId, fullName: p.name, pitchHand: p.hand ? { code: p.hand } : undefined },
                pitcherTeam: p.team,
                pitcherScanData: p,
              }))} />
            : <ScanOverlay progress={scanProgress} gameCount={games.length} />
        ) : page === "cracked" ? (
          <CrackedBoard propOddsMap={propOddsMap} enrichedScanData={enrichedScanData} />
        ) : scanComplete ? (
          <>
          <BatterBoardTabs page={page}
            counts={Object.fromEntries(BATTER_BOARDS.map(b => [b.key, enrichedScanData?.byModel?.[b.key]?.filter(p => !p.watch).length || 0]))}
            onSelect={k => { setPage(k); setLastBatterBoard(k); }} />
          <PropsBoard key={page} boardKey={page} scanData={enrichedScanData} gameCount={games.length} lineupData={lineupData}
            windowData={statcastRef}
            onSelectBatter={(pick) => {
              setSelectedBatter(enrichBatterWithMatchup({
                id: pick.playerId,
                fullName: pick.name,
                batSide: pick.batSide ? { code: pick.batSide } : null,
                position: { abbreviation: pick.position },
                batterTeam: pick.team ?? null,
                opponentPitcherId: pick.oppPitcherId ?? null,
                opponentPitcherName: pick.oppPitcher ?? null,
                opponentPitcherTeam: pick.opponent ?? null,
                opponentPitcherHand: pick.oppPitcherHand ?? null,
                isHome: pick.isHome,
                gamePk: pick.game?.gamePk,
                homeTeamAbbrev: pick.game?.teams?.home?.team?.abbreviation,
                venueName: pick.venue,
              }));
            }}
            onSelectPitcher={p => setSelectedPitcher(enrichPitcherWithMatchup(p))} />
          </>
        ) : (
          <ScanOverlay progress={scanProgress} gameCount={games.length} />
        )
      )}
      </ErrorBoundary>

      {/* Always-mounted Slate Odds computation. SlateOdds fetches team/pitcher/weather/
          umpire data and emits its ML/RL/OU picks via onGamePicksReady on mount. Mounting
          it always (hidden when not on the Slate Odds tab) means Golden 10 gets the full
          cross-market universe without the user having to visit Slate Odds first.
          The three loaders come from here rather than from the component so their
          promise caches stay single-instance (2026-06-26 Savant CSV storm). */}
      {games.length > 0 && (
        <div style={{ display: page === "slate" ? "block" : "none" }}>
          <ErrorBoundary label="Slate Odds">
            <SlateOdds games={games} oddsData={oddsData} season={season}
              lineupData={lineupData} probableFor={probableFor}
              dataSources={{ getTeamOAAMap, fetchAllTeamBullpenERAs, fetchAdvancedStatsBulk }}
              onGamePicksReady={rows => { slateRowsRef.current = rows; setSlateRowsState(rows); }} />
          </ErrorBoundary>
        </div>
      )}

      {/* BatterPanel slide-out overlay */}
      {selectedBatter && (
        <>
          <div onClick={() => setSelectedBatter(null)}
            style={{ position: "fixed", inset: 0, zIndex: 999, background: "rgba(0,0,0,0.175)" }} />
          <ErrorBoundary resetKey={selectedBatter?.id} label="Batter panel">
            <BatterPanel batter={selectedBatter} batterTeam={selectedBatter.batterTeam || selectedBatter.team || ""}
              pitcherId={selectedBatter.opponentPitcherId} pitcherName={selectedBatter.opponentPitcherName}
              pitcherTeam={selectedBatter.opponentPitcherTeam} season={season} isHome={selectedBatter.isHome}
              gamePk={selectedBatter.gamePk || g?.gamePk} homeTeamAbbrev={selectedBatter.homeTeamAbbrev || home?.team?.abbreviation} venueName={selectedBatter.venueName || g?.venue?.name}
              propOddsMap={propOddsMap}
              fullPageMode={false}
              lineupData={lineupData}
              sabHints={sabHints}
              onSelectPitcher={(p) => setSelectedPitcher(enrichPitcherWithMatchup(p))}
              onClose={() => setSelectedBatter(null)} />
          </ErrorBoundary>
        </>
      )}

      {/* PitcherPanel slide-out overlay */}
      {selectedPitcher && (
        <>
          <div onClick={() => setSelectedPitcher(null)}
            style={{ position: "fixed", inset: 0, zIndex: 999, background: "rgba(0,0,0,0.175)" }} />
          <ErrorBoundary resetKey={selectedPitcher?.pitcher?.id} label="Pitcher panel">
            <PitcherPanel pitcher={selectedPitcher.pitcher} pitcherTeam={selectedPitcher.pitcherTeam}
              season={season} onClose={() => setSelectedPitcher(null)}
              pitcherScanData={selectedPitcher.pitcherScanData || null}
              propOddsMap={propOddsMap}
              fullPageMode={false}
              opponentTeam={selectedPitcher.opponentTeam || null}
              lineupData={lineupData}
              venueName={selectedPitcher.venueName || selectedPitcher.pitcherScanData?.venue || null} />
          </ErrorBoundary>
        </>
      )}

      {/* Player Search Overlay */}
      {playerSearchOpen && (
        <PlayerSearch
          enrichedScanData={enrichedScanData}
          rostersByTeam={rostersByTeam}
          onSelectBatter={(pick) => {
            setSelectedBatter(enrichBatterWithMatchup({
              id: pick.playerId, fullName: pick.name,
              currentTeam: { id: pick.teamId, abbreviation: pick.team },
              primaryPosition: { abbreviation: pick.position },
              batSide: { code: pick.batSide },
              team: pick.team,
            }));
            setPage("hits"); setLastBatterBoard("hits");
          }}
          onSelectPitcher={(p) => {
            setSelectedPitcher(enrichPitcherWithMatchup(p));
            setPage("ks");
          }}
          onClose={() => setPlayerSearchOpen(false)}
        />
      )}
    </div>
  );
}

export default function App() {
  return <PasswordGate><AppInner /></PasswordGate>;
}
