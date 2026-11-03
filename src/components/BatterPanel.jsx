// BatterPanel — the single-batter detail panel (moved out of App.jsx 2026-10-06).
import { useState, useEffect, useMemo } from 'react';
import { fetchJson, API, getTodayInAppTimeZone } from '../lib/utils.js';
import { fetchText, parseCSVText, getGameLog, getSplits, getVsPitcher, getSeasonStats, getPlayerBio, getPlayerNews, getStatcastBatterVsPitch, getPitchArsenal, getPlateDiscipline, getStatcastBatterVsPitchByHand, getCatcherPopTimesMap, getBatterSprintStats, getBatterBaserunning, getBasestealingRunValue, getPitcherRunningGame, getTeamBullpenHold, getTeamRoster, getBatterHotZones, getPitcherPitchLocations, getBatterPowerStats, getExpectedStats, getBattedBall, getSwingTake, getHomeRunStats, getSwingPathAttackAngle, _normPropName } from '../lib/mlbData.js';
import { windowMetrics, tallyPitchRows } from '../lib/recentWindow.js';
import { loadPitchlab } from '../lib/pitchlab.js';
import { MiniStat, useIsMobile, MLB_TEAM_IDS, ContractLine, PropBarChart, CollapsibleSection, PITCH_LABELS, PITCH_COLORS, _timeAgo, StatBox, fmtAvg, Section, SplitsTable, GameLogTable, MatchupZoneChart, PitchMovementChart, PitchBreakdownTable, PlayerGiveaways, BEAT_REPORTERS } from './PanelKit.jsx';
import { usePlayerInjury, InjuryBadge, InjuryLine } from './InjuryStatus.jsx';
import { getGameWeather, PARK_MODEL_BY_MARKET, parkWeatherMult } from '../lib/weather.js';
import { getBatterProj, getPitcherProj, batterProjRates } from '../lib/projections.js';
import { getParkData, computePlayerFlags, _ABBREV_ALIASES, PARK_DATA } from '../lib/parks.js';
import { modelHits, modelHR, modelSB, modelTB, modelHRR, computeExpectedStatsLuck, computeAttackAngleMult, computeBattedBallHRMult, computeHRLuckMult, computeBasestealingMult, computePitcherHoldingMult, attackAngleLevelHRR, modelImpliedProb, calcEVFromOdds } from '../lib/models.js';
import PlayerFlagBadges from './PlayerFlagBadges.jsx';
import Loader from './Loader.jsx';
import OddsLink, { BOOK_COLORS, BOOK_ABBR } from './OddsLink.jsx';
import KellyBadge from './KellyBadge.jsx';
import PlayerHeadshot from './PlayerHeadshot.jsx';
import BaserunningCard from './BaserunningCard.jsx';
import StatcastCard from './StatcastCard.jsx';
import BatterArsenalSummary from './BatterArsenalSummary.jsx';

async function getSprayData(batterId, gamePks) {
  const validPks = gamePks.filter(Boolean); // no slice — process every game passed in
  const results = await Promise.all(
    validPks.map(async pk => {
      try {
        const d = await fetchJson(`https://statsapi.mlb.com/api/v1.1/game/${pk}/feed/live`);
        if (!d?.liveData?.plays?.allPlays) return [];
        const plays = [];
        for (const play of d.liveData.plays.allPlays) {
          if (String(play.matchup?.batter?.id) !== String(batterId)) continue;
          // hitData lives on the individual playEvent (the in-play pitch), NOT on the play itself
          const hitEvent = play.playEvents?.find(e => e.hitData?.coordinates?.coordX != null);
          if (!hitEvent) continue;
          const hd = hitEvent.hitData;
          plays.push({
            x: hd.coordinates.coordX,
            y: hd.coordinates.coordY,
            speed: hd.launchSpeed,
            angle: hd.launchAngle,
            dist: hd.totalDistance,
            traj: hd.trajectory,
            hardness: hd.hardness,
            event: play.result?.event,
            date: d.gameData?.datetime?.officialDate,
            venue: d.gameData?.venue?.name || null,
          });
        }
        return plays;
      } catch { return []; }
    })
  );
  return results.flat();
}

async function getBatterVsPitch(batterId, season) {
  try {
    const d = await fetchJson(`${API}/people/${batterId}?hydrate=stats(group=[hitting],type=[pitchArsenal],season=${season})`);
    const stats = d?.people?.[0]?.stats || [];
    const s = stats.find(s => s.type?.displayName === "pitchArsenal");
    return s?.splits || [];
  } catch { return []; }
}

// ── League season distributions, for placing a recent-form window on the same bar ──
// Both CSVs are the exact URLs getBatterPowerStats already pulls, so _textCache serves them
// and this costs no extra network. getBatterPowerStats parses the whole league and keeps one
// row; this keeps the column, which is all an empirical percentile needs.
const LEAGUE_DIST_COLS = [
  ['exitVelo',    'custom', 'exit_velocity_avg'],
  ['barrelPct',   'custom', 'barrel_batted_rate'],
  ['hardHitPct',  'custom', 'hard_hit_percent'],
  ['bbPct',       'custom', 'bb_percent'],
  ['kPct',        'custom', 'k_percent'],
  ['whiffPct',    'custom', 'whiff_percent'],
  ['chasePct',    'custom', 'oz_swing_percent'],
  ['batSpeed',    'bat',    'avg_bat_speed'],
  ['swingLength', 'bat',    'swing_length'],
];

async function getLeagueBatterDistributions(season) {
  const tryYear = async (yr) => {
    const [customText, batText] = await Promise.all([
      fetchText(`https://baseballsavant.mlb.com/leaderboard/custom?year=${yr}&type=batter&filter=&sort=4&sortDir=desc&min=10&selections=exit_velocity_avg%2Claunch_angle_avg%2Cbarrel_batted_rate%2Chard_hit_percent%2Cxba%2Cxwoba%2Cwoba%2Cbb_percent%2Ck_percent%2Cwhiff_percent%2Coz_swing_percent&csv=true`),
      fetchText(`https://baseballsavant.mlb.com/leaderboard/bat-tracking?year=${yr}&team=&min_pa=1&csv=true`).catch(() => ""),
    ]);
    const src = { custom: parseCSVText(customText), bat: batText ? parseCSVText(batText) : [] };
    const out = {};
    for (const [key, which, col] of LEAGUE_DIST_COLS) {
      const vals = src[which]
        .map(r => parseFloat(r[col]))
        .filter(v => Number.isFinite(v))
        .sort((a, b) => a - b);
      if (vals.length >= 50) out[key] = vals;   // too thin a league to rank against
    }
    return Object.keys(out).length ? out : null;
  };
  try {
    const v = await tryYear(season);
    if (v) return v;
    if (season > 2024) return await tryYear(season - 1);
    return null;
  } catch { return null; }
}

// ── Recent-form window: pitch-level rows for one batter over a date range ──
// Savant's leaderboards accept date parameters and ignore them; statcast_search/csv honours
// game_date_gt/lt, so this is the only route to a window. One batter over ~15 games is ~165 KB.
async function getBatterRecentWindow(batterId, season, fromDate, toDate) {
  if (!fromDate) return null;
  try {
    const url = `https://baseballsavant.mlb.com/statcast_search/csv?all=true&type=details&hfGT=R%7C`
              + `&player_type=batter&hfSea=${season}%7C&batters_lookup%5B%5D=${batterId}`
              + `&game_date_gt=${fromDate}&game_date_lt=${toDate}&min_pitches=0&min_results=0`;
    const text = await fetchText(url, 25000);
    const rows = parseCSVText(text);
    if (!rows.length) return null;
    const m = windowMetrics(tallyPitchRows(rows));
    return m?.games ? m : null;
  } catch { return null; }
}

// ── Batter Statcast percentile rankings (Savant) ──
// Returns 0–100 percentile rank for each metric (higher = better player, regardless of stat direction).
async function getBatterStatcastPercentiles(batterId, season) {
  const tryYear = async (yr) => {
    try {
      const text = await fetchText(`https://baseballsavant.mlb.com/leaderboard/percentile-rankings?type=batter&year=${yr}&min=1&csv=true`);
      const rows = parseCSVText(text);
      const row = rows.find(r => String(r.player_id) === String(batterId));
      if (!row) return null;
      const p = (k) => { const v = parseFloat(row[k]); return isNaN(v) ? null : v; };
      return {
        xwoba:          p("xwoba"),
        xba:            p("xba"),
        xslg:           p("xslg"),
        xiso:           p("xiso"),
        xobp:           p("xobp"),
        brl_percent:    p("brl_percent"),
        exit_velocity:  p("exit_velocity"),
        max_ev:         p("max_ev"),
        hard_hit_percent: p("hard_hit_percent"),
        k_percent:      p("k_percent"),
        bb_percent:     p("bb_percent"),
        whiff_percent:  p("whiff_percent"),
        chase_percent:  p("chase_percent"),
        bat_speed:      p("bat_speed"),
        squared_up_rate:p("squared_up_rate"),
        swing_length:   p("swing_length"),
        sprint_speed:   p("sprint_speed"),
      };
    } catch { return null; }
  };
  const v = await tryYear(season);
  if (v) return v;
  if (season > 2024) return await tryYear(season - 1);
  return null;
}

// Batter sprint speed from Savant (ft/s) — primary SB model input
async function getBatterSprintSpeed(batterId, season) {
  const tryYear = async (yr) => {
    const url = `https://baseballsavant.mlb.com/leaderboard/sprint_speed?year=${yr}&position=&team=&min=1&csv=true`;
    const text = await fetchText(url);
    const rows = parseCSVText(text);
    const row = rows.find(r => String(r.player_id) === String(batterId));
    return row ? (parseFloat(row.sprint_speed) || null) : null;
  };
  try {
    const v = await tryYear(season);
    if (v != null) return v;
    // Early in season — fall back to prior year
    if (season > 2024) return await tryYear(season - 1);
    return null;
  } catch { return null; }
}

// Individual advanced stats fetch — used by BatterPanel / PitcherPanel on open
async function fetchPlayerAdvancedStats(mlbamId, season, type = "batter") {
  // Fires on Batter/Pitcher panel open (a click) — hard timeout so a hung
  // /api/advanced-stats can't leave the panel frozen on stale data.
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(`/api/advanced-stats?season=${season}&type=${type}&mlbam_id=${mlbamId}`, { signal: ctrl.signal });
    if (!res.ok) return null;
    const json = await res.json();
    return json.data || null;
  } catch { return null; }
  finally { clearTimeout(tid); }
}

function ScoreBar({ value, max = 1, color = "#2062c8", label }) {
  const pctVal = Math.min((value / max) * 100, 100);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
      {label && <div style={{ fontSize: 10, color: "#6d7c96", minWidth: 60 }}>{label}</div>}
      <div style={{ flex: 1, height: 6, background: "rgba(203,212,233,0.8)", borderRadius: 3, overflow: "hidden" }}>
        <div style={{ width: `${pctVal}%`, height: "100%", background: color, borderRadius: 3, transition: "width 0.5s ease" }} />
      </div>
      <div style={{ fontSize: 11, fontWeight: 600, color, fontFamily: "'JetBrains Mono', monospace", minWidth: 42, textAlign: "right" }}>
        {typeof value === "number" ? value.toFixed(3) : value}
      </div>
    </div>
  );
}

// v3: Model tier classification from Monte Carlo backtesting (87K+ simulated games)
// v6: Monte Carlo validated tiers (58,200 simulated decisions)
const MODEL_TIERS = {
  Hits: { tier: "PROVEN", badge: "🎯", note: "78.6% @ -160 | MC validated", color: "#0f8a44" },
  "Home Run": { tier: "PROVEN", badge: "💎", note: "31.5% @ +300 | +6.5% edge", color: "#0f8a44" },
  Single: { tier: "PROVEN", badge: "🎯", note: "65.7% @ -125 | MC validated", color: "#0f8a44" },
  Double: { tier: "CAUTION", badge: "⚠️", note: "16% vs 29% needed | -EV", color: "#c62828" },
  Triple: { tier: "PROVEN", badge: "💎", note: "11.7% @ +1200 | +4% edge", color: "#0f8a44" },
  "Pitcher K": { tier: "PROVEN", badge: "🎯", note: "edge +0.3K | MC validated", color: "#0f8a44" },
  "Stolen Base": { tier: "CAUTION", badge: "⚠️", note: "23% vs 33% needed | -EV", color: "#c62828" },
  "Total Bases": { tier: "MARGINAL", badge: "📊", note: "54% @ -120 | thin edge", color: "#a16207" },
  HRR: { tier: "PROVEN", badge: "🎯", note: "~64% @ -140 | OPS-driven", color: "#0f8a44" },
  RBI: { tier: "MARGINAL", badge: "📊", note: "RISP+xwOBA+HR | new model", color: "#a16207" },
};

function PropCard({ title, emoji, result, children }) {
  const [open, setOpen] = useState(false);
  if (!result) return null;
  const tierInfo = MODEL_TIERS[result.label || title] || {};
  const getVerdict = () => {
    if (result.skip) return { text: "SKIP", color: "#6b7280" };
    if (result.strong || result.over25 || result.strongOver) return { text: "STRONG OVER", color: "#0f8a44" };
    if (result.yes || result.over05 || result.over15 || result.overLine) return { text: "LEAN OVER", color: "#2569d6" };
    if (result.underLine) return { text: "LEAN UNDER", color: "#d03131" };
    return { text: "NEUTRAL", color: "#6d7c96" };
  };
  const verdict = getVerdict();
  const isLowConf = result.lowConf || tierInfo.tier === "CAUTION";
  return (
    <div style={{ background: "rgba(210,217,236,0.5)", borderRadius: 10, border: `1px solid ${isLowConf ? "rgba(198,40,40,0.15)" : "rgba(32,98,200,0.128)"}`, marginBottom: 8, overflow: "hidden", opacity: isLowConf ? 0.70 : 1 }}>
      <button onClick={() => setOpen(!open)} style={{
        width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "10px 14px", background: "transparent", border: "none", cursor: "pointer",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 16 }}>{emoji}</span>
          <span style={{ fontSize: 13, fontWeight: 600, color: "#3c4f6d" }}>{title}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {result.parkMult != null && result.parkMult !== 1.0 && (() => {
            const pct = ((result.parkMult - 1) * 100).toFixed(0);
            const isBoost = result.parkMult > 1.005;
            const isNerf = result.parkMult < 0.995;
            if (!isBoost && !isNerf) return null;
            return <span style={{ fontSize: 9, fontWeight: 600, padding: "1px 5px", borderRadius: 3,
              color: isBoost ? "#0f8a44" : "#d03131",
              background: isBoost ? "rgba(15,138,68,0.12)" : "rgba(208,49,49,0.12)" }}>
              {isBoost ? "▲" : "▼"}{Math.abs(pct)}%</span>;
          })()}
          <span style={{
            fontSize: 10, fontWeight: 700, color: verdict.color,
            background: `${verdict.color}18`, padding: "2px 8px", borderRadius: 4, letterSpacing: 0.5,
          }}>{result.adjVerdict || verdict.text}</span>
          <span style={{ fontSize: 13, fontWeight: 700, color: "#2062c8", fontFamily: "'JetBrains Mono', monospace" }}>
            {typeof result.score === "number" ? result.score.toFixed(3) : "—"}
          </span>
          <span style={{ fontSize: 11, color: "#74839d", transform: open ? "rotate(180deg)" : "rotate(0)", transition: "transform 0.2s" }}>▼</span>
        </div>
      </button>
      {open && <div style={{ padding: "0 14px 12px", borderTop: "1px solid rgba(32,98,200,0.096)" }}>{children}</div>}
    </div>
  );
}

// ══════════════════════════════════════════════════════════
// ── SPRAY CHART SVG ──
// Renders GUMBO hitData coordinates on a baseball field SVG.
// Overlays today's park dimensions for context (pull-side awareness).
// ══════════════════════════════════════════════════════════
function SprayChart({ hits = [], park, battingHand }) {
  const [activeTypes, setActiveTypes] = useState(new Set(["HR", "3B", "2B", "1B", "Out"]));
  const toggleType = type => setActiveTypes(prev => {
    const next = new Set(prev);
    if (next.has(type)) next.delete(type); else next.add(type);
    return next;
  });

  // Coordinate system: GUMBO uses screen coords, home plate ≈ (125, 215), CF ≈ (125, 35)
  // Scale: ~0.44 SVG coords per foot (400ft CF → ~176 units up from HP)
  const HP = { x: 125, y: 215 };
  const SCALE = 0.44;

  const wallPt = (distFt, angleDeg) => {
    const rad = (angleDeg * Math.PI) / 180;
    return {
      x: HP.x + Math.sin(rad) * distFt * SCALE,
      y: HP.y - Math.cos(rad) * distFt * SCALE,
    };
  };

  // Park wall points (LF, LCF, CF, RCF, RF at canonical angles)
  const ANGLES = [-45, -22, 0, 22, 45];
  const dists = park
    ? [park.dims.LF, park.dims.LCF, park.dims.CF, park.dims.RCF, park.dims.RF]
    : [330, 370, 400, 370, 330];
  const wallPts = ANGLES.map((a, i) => wallPt(dists[i], a));
  const wtPts = ANGLES.map((a, i) => wallPt(dists[i] - 15, a));

  const toPath = (pts, cmd = "M") =>
    pts.map((p, i) => `${i === 0 ? cmd : "L"} ${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");

  const lfLine = wallPt(380, -45);
  const rfLine = wallPt(380, 45);
  const base1 = wallPt(90, 45);
  const base2 = wallPt(127, 0);
  const base3 = wallPt(90, -45);
  const mound = wallPt(60.5, 0);

  const hitColor = (event) => {
    if (!event) return "#cbd5e1";
    const e = event.toLowerCase();
    if (e.includes("home run")) return "#a16207";
    if (e.includes("triple")) return "#6d4fd0";
    if (e.includes("double")) return "#2569d6";
    if (e.includes("single")) return "#0f8a44";
    return "#cbd5e1";
  };

  const isHit = (event) => {
    if (!event) return false;
    const e = event.toLowerCase();
    return e.includes("single") || e.includes("double") || e.includes("triple") || e.includes("home run");
  };

  const getHitType = event => {
    if (!event) return "Out";
    const e = event.toLowerCase();
    if (e.includes("home run")) return "HR";
    if (e.includes("triple"))   return "3B";
    if (e.includes("double"))   return "2B";
    if (e.includes("single"))   return "1B";
    return "Out";
  };

  // Total counts always reflect full dataset (unfiltered)
  const hrCount     = hits.filter(h => getHitType(h.event) === "HR").length;
  const tripleCount = hits.filter(h => getHitType(h.event) === "3B").length;
  const doubleCount = hits.filter(h => getHitType(h.event) === "2B").length;
  const singleCount = hits.filter(h => getHitType(h.event) === "1B").length;
  const evHits  = hits.filter(h => h.speed);
  const avgEV   = evHits.length > 0 ? (evHits.reduce((s, h) => s + h.speed, 0) / evHits.length).toFixed(1) : null;
  const maxDist = hits.filter(h => h.dist).reduce((m, h) => Math.max(m, h.dist), 0);

  // Filtered hits — only show active types on the field
  const displayHits = hits.filter(h => activeTypes.has(getHitType(h.event)));

  const LEGEND = [
    { color: "#a16207", label: "HR" },
    { color: "#6d4fd0", label: "3B" },
    { color: "#2569d6", label: "2B" },
    { color: "#0f8a44", label: "1B" },
    { color: "#a3b2c9", label: "Out" },
  ];

  return (
    <div>
      {/* Stats bar — only when we have data */}
      {hits.length > 0 && (
        <div style={{ display: "flex", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
          <MiniStat label="BIP" value={hits.length} />
          <MiniStat label="1B" value={singleCount} accent={singleCount > 0 ? "#0f8a44" : undefined} />
          <MiniStat label="2B" value={doubleCount} accent={doubleCount > 0 ? "#2569d6" : undefined} />
          <MiniStat label="3B" value={tripleCount} accent={tripleCount > 0 ? "#6d4fd0" : undefined} />
          <MiniStat label="HR" value={hrCount} accent={hrCount > 0 ? "#a16207" : undefined} />
          {avgEV && <MiniStat label="Avg EV" value={`${avgEV}`} accent="#2569d6" />}
          {maxDist > 0 && <MiniStat label="Max Dist" value={`${maxDist}ft`} accent="#6d4fd0" />}
        </div>
      )}

      {/* SVG Field — toggles live inside the dark box */}
      <div style={{ background: "#e6ebf4", borderRadius: 10, overflow: "hidden", border: "1px solid rgba(32,98,200,0.16)" }}>
        {/* Toggle bar — centered at top of the dark box */}
        <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 6, padding: "10px 14px 4px", flexWrap: "wrap" }}>
          {LEGEND.map(l => {
            const on = activeTypes.has(l.label);
            return (
              <button key={l.label} onClick={() => toggleType(l.label)} style={{
                display: "flex", alignItems: "center", gap: 5, fontSize: 11, cursor: "pointer",
                padding: "4px 10px", borderRadius: 20, border: on ? `1px solid ${l.color}55` : "1px solid #e3e9f4",
                background: on ? `${l.color}18` : "rgba(219,225,240,0.6)",
                color: on ? l.color : "#b6c5dc", fontWeight: on ? 600 : 400,
                transition: "all 0.15s", userSelect: "none",
              }}>
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: on ? l.color : "#e3e9f4", flexShrink: 0, transition: "background 0.15s" }} />
                {l.label}
              </button>
            );
          })}
          {battingHand && (
            <div style={{ fontSize: 9, color: "#b6c5dc", marginLeft: 6 }}>
              Pull → {battingHand === "L" ? "RF" : "LF"} · Bats {battingHand}
            </div>
          )}
        </div>
        <svg viewBox="0 -40 250 270" style={{ width: "100%", display: "block" }}>
          {/* Sky — covers full extended area including beyond-wall zone for deep HRs */}
          <rect x="0" y="-40" width="250" height="270" fill="#e6ebf4" />

          {/* Outfield grass */}
          <path
            d={`M ${HP.x},${HP.y} L ${lfLine.x.toFixed(1)},${lfLine.y.toFixed(1)} ${toPath(wallPts, "L")} L ${rfLine.x.toFixed(1)},${rfLine.y.toFixed(1)} Z`}
            fill="#ddefe0"
          />

          {/* Warning track */}
          <path
            d={`${toPath(wallPts)} ${toPath([...wtPts].reverse(), "L")} Z`}
            fill="#faf4ec" opacity="0.9"
          />

          {/* Pull-side highlight */}
          {battingHand === "L" && (
            <path
              d={`M ${HP.x},${HP.y} L ${wallPts[2].x.toFixed(1)},${wallPts[2].y.toFixed(1)} L ${wallPts[3].x.toFixed(1)},${wallPts[3].y.toFixed(1)} L ${wallPts[4].x.toFixed(1)},${wallPts[4].y.toFixed(1)} L ${rfLine.x.toFixed(1)},${rfLine.y.toFixed(1)} Z`}
              fill="rgba(161,98,7,0.05)"
            />
          )}
          {battingHand === "R" && (
            <path
              d={`M ${HP.x},${HP.y} L ${lfLine.x.toFixed(1)},${lfLine.y.toFixed(1)} L ${wallPts[0].x.toFixed(1)},${wallPts[0].y.toFixed(1)} L ${wallPts[1].x.toFixed(1)},${wallPts[1].y.toFixed(1)} L ${wallPts[2].x.toFixed(1)},${wallPts[2].y.toFixed(1)} Z`}
              fill="rgba(37,105,214,0.05)"
            />
          )}

          {/* Outfield wall */}
          <path d={toPath(wallPts)} fill="none" stroke="#ecdfd3" strokeWidth="2.5" />

          {/* Park dimension labels — only when park provided */}
          {park && (() => {
            const labelPt = (angleDeg, distFt) => {
              const rad = (angleDeg * Math.PI) / 180;
              const d = (distFt + 14) * SCALE;
              return { x: HP.x + Math.sin(rad) * d, y: HP.y - Math.cos(rad) * d };
            };
            const lf  = labelPt(-45, park.dims.LF);
            const lcf = labelPt(-22, park.dims.LCF);
            const cf  = labelPt(0,   park.dims.CF);
            const rcf = labelPt(22,  park.dims.RCF);
            const rf  = labelPt(45,  park.dims.RF);
            const style = { fill: "#998a7a", fontSize: "8", fontFamily: "monospace" };
            return (<>
              <text {...style} x={lf.x.toFixed(1)}  y={lf.y.toFixed(1)}  textAnchor="middle">{park.dims.LF}</text>
              <text {...style} x={lcf.x.toFixed(1)} y={lcf.y.toFixed(1)} textAnchor="middle">{park.dims.LCF}</text>
              <text {...style} x={cf.x.toFixed(1)}  y={cf.y.toFixed(1)}  textAnchor="middle">{park.dims.CF}</text>
              <text {...style} x={rcf.x.toFixed(1)} y={rcf.y.toFixed(1)} textAnchor="middle">{park.dims.RCF}</text>
              <text {...style} x={rf.x.toFixed(1)}  y={rf.y.toFixed(1)}  textAnchor="middle">{park.dims.RF}</text>
            </>);
          })()}

          {/* Foul lines */}
          <line x1={HP.x} y1={HP.y} x2={lfLine.x.toFixed(1)} y2={lfLine.y.toFixed(1)} stroke="#a3b2c9" strokeWidth="0.8" opacity="0.6" />
          <line x1={HP.x} y1={HP.y} x2={rfLine.x.toFixed(1)} y2={rfLine.y.toFixed(1)} stroke="#a3b2c9" strokeWidth="0.8" opacity="0.6" />

          {/* Infield dirt */}
          <path
            d={`M ${HP.x},${HP.y} L ${base1.x.toFixed(1)},${base1.y.toFixed(1)} Q ${base2.x.toFixed(1)},${(base2.y - 8).toFixed(1)} ${base2.x.toFixed(1)},${base2.y.toFixed(1)} Q ${base2.x.toFixed(1)},${(base2.y - 8).toFixed(1)} ${base3.x.toFixed(1)},${base3.y.toFixed(1)} Z`}
            fill="#f6ede1"
          />

          {/* Base paths */}
          {[[HP, base1], [base1, base2], [base2, base3], [base3, HP]].map(([a, b], i) => (
            <line key={i} x1={a.x.toFixed(1)} y1={a.y.toFixed(1)} x2={b.x.toFixed(1)} y2={b.y.toFixed(1)} stroke="#6a7684" strokeWidth="0.8" opacity="0.5" />
          ))}

          {/* Bases */}
          {[base1, base2, base3].map((b, i) => (
            <rect key={i} x={(b.x - 3).toFixed(1)} y={(b.y - 3).toFixed(1)} width="6" height="6" fill="white" opacity="0.6" transform={`rotate(45,${b.x.toFixed(1)},${b.y.toFixed(1)})`} />
          ))}

          {/* Pitcher's mound */}
          <circle cx={mound.x.toFixed(1)} cy={mound.y.toFixed(1)} r="4" fill="#f3e6d4" stroke="#ecdfd3" strokeWidth="1" />

          {/* Home plate */}
          <polygon points={`${HP.x},${HP.y - 5} ${HP.x + 4},${HP.y} ${HP.x + 4},${HP.y + 3} ${HP.x - 4},${HP.y + 3} ${HP.x - 4},${HP.y}`} fill="white" opacity="0.75" />

          {/* Hit dots — filtered by active types */}
          {displayHits.map((h, i) => (
            <circle key={i} cx={h.x.toFixed(1)} cy={h.y.toFixed(1)} r={isHit(h.event) ? 3.5 : 2.5}
              fill={hitColor(h.event)} stroke="rgba(0,0,0,0.14)" strokeWidth="0.5" opacity="0.88"
            >
              <title>{h.event || "Unknown"}{h.dist ? ` · ${h.dist}ft` : ""}{h.speed ? ` · ${h.speed}mph EV` : ""}{h.angle ? ` · ${h.angle}° LA` : ""}{h.date ? ` · ${h.date}` : ""}</title>
            </circle>
          ))}

          {/* No-data overlay */}
          {hits.length === 0 && (
            <>
              <text x="125" y="118" textAnchor="middle" fill="#8b99b0" fontSize="11" fontFamily="sans-serif">No batted ball data</text>
              <text x="125" y="133" textAnchor="middle" fill="#b6c5dc" fontSize="9" fontFamily="sans-serif">for this selection</text>
            </>
          )}
        </svg>

        {/* Park name footer — only when park provided */}
        {park && (
          <div style={{ textAlign: "center", fontSize: 9, color: "#a3b2c9", padding: "4px 0 6px", letterSpacing: 0.5 }}>
            {park.name}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Sabermetric Stat Hints dictionary ──
const STAT_HINTS = {
  // Statcast / Contact Quality
  "Exit Velocity":   "Average speed of the ball off the bat (mph). Higher = harder contact. MLB avg ~88.5 mph.",
  "Max EV":          "Hardest single batted ball of the season. Measures raw power ceiling.",
  "Barrel %":        "% of batted balls that are 'barreled' — ideal combination of exit velo & launch angle. Barrels become hits/HRs at an elite rate. MLB avg ~8%.",
  "Hard Hit %":      "% of batted balls hit 95+ mph. Strong indicator of contact quality. MLB avg ~36%.",
  "xwOBA":           "Expected weighted on-base average based on exit velocity & launch angle — strips out luck and defense. .370+ = elite, .290- = well below avg.",
  "xBA":             "Expected batting average based purely on quality of contact. Diverges from actual BA when BABIP luck is present.",
  "xSLG":            "Expected slugging percentage based on contact quality. Higher than actual SLG = batter due for positive regression.",
  "xOBP":            "Expected on-base percentage combining expected BA with walk rate. Useful for identifying true on-base skill.",
  "BB %":            "Walk rate — plate appearances resulting in a base on balls. MLB avg ~8.5%. High BB% = elite plate discipline.",
  "K %":             "Strikeout rate — % of plate appearances ending in a K. MLB avg ~22.5%. Lower is better for contact.",
  "Whiff %":         "Swing-and-miss rate per pitch seen. MLB avg ~24%. High whiff% = vulnerability to breaking balls.",
  "Chase %":         "Rate of swinging at pitches outside the strike zone. MLB avg ~28%. Lower = better discipline.",
  "Bat Speed":       "Average bat speed through the zone (mph). Faster bat speed = more time to read the pitch. MLB avg ~71 mph.",
  "Squared Up %":    "% of swings where the bat makes solid contact in the 'sweet spot'. Higher = better contact efficiency.",
  "Swing Length":    "Average length of the swing path (inches). Shorter swing = quicker to the ball, harder to cheat. MLB avg ~7.2 in.",
  "Sprint Speed":    "Top running speed in ft/sec (best 1-sec burst). MLB avg ~27 ft/s. 30+ = elite.",
  // Arsenal tab stats
  "BA":              "Batting average against this pitch type. .300+ = batter is hitting it well; below .200 = struggles.",
  "SLG":             "Slugging percentage against this pitch. .500+ = plus power on this pitch type.",
  "wOBA":            "Weighted on-base average — a single number capturing overall offensive value per PA against this pitch.",
  "Whiff%":          "% of swings that miss vs. this pitch. 35%+ = exploitable weakness; 15%- = batter handles it well.",
  "Hard Hit%":       "% of batted balls hit 95+ mph vs. this pitch. 50%+ = batter squares it up regularly.",
  "K%":              "Strikeout rate when facing this pitch type. 30%+ = significant strikeout vulnerability.",
  "RV/100":          "Run value per 100 pitches seen (batter perspective). Positive = batter advantages; negative = pitcher advantages.",
  // Plate Discipline
  "F-Strike% Seen":  "Rate at which the first pitch was a called strike. High% = pitcher establishing early count advantage.",
  "Chase%":          "% of pitches outside the zone the batter swings at. Lower = better discipline.",
  "Zone Swing%":     "% of pitches in the zone the batter swings at. Too low = takes too many strikes; too high = overly aggressive.",
  "Zone Contact%":   "Contact rate on pitches inside the strike zone. 87%+ = elite zone contact; 75%- = below average.",
  "Chase Contact%":  "Contact rate on pitches outside the zone when swinging. Higher = better at making contact on bad balls.",
};

// ── HintTooltip: wraps a stat label with a hover popup if hints are enabled ──
function HintTooltip({ stat, children, enabled = true }) {
  const [visible, setVisible] = useState(false);
  const hint = STAT_HINTS[stat];
  if (!enabled || !hint) return children;
  return (
    <span style={{ position: "relative", display: "inline-block", cursor: "help" }}
      onMouseEnter={() => setVisible(true)} onMouseLeave={() => setVisible(false)}>
      {children}
      {visible && (
        <div style={{
          position: "absolute", bottom: "calc(100% + 6px)", left: "50%", transform: "translateX(-50%)",
          background: "#edf2fa", border: "1px solid rgba(32,98,200,0.25)",
          borderRadius: 8, padding: "8px 10px", zIndex: 9999,
          minWidth: 200, maxWidth: 280, boxShadow: "0 8px 24px rgba(0,0,0,0.21)",
          pointerEvents: "none",
        }}>
          <div style={{ fontSize: 9, fontWeight: 700, color: "#2062c8", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 4 }}>{stat}</div>
          <div style={{ fontSize: 11, color: "#4c5f7d", lineHeight: 1.5 }}>{hint}</div>
        </div>
      )}
    </span>
  );
}

export default function BatterPanel({ batter, batterTeam, pitcherId, pitcherName, pitcherTeam, season, isHome, gamePk, homeTeamAbbrev, venueName, onClose, propOddsMap, fullPageMode = false, lineupData = {}, sabHints = false, onSelectPitcher }) {
  const isMobile = useIsMobile();
  const [gameLog, setGameLog] = useState(null);
  const [splits, setSplits] = useState(null);
  const [bvp, setBvp] = useState(null);
  const [seasonStats, setSeasonStats] = useState(null);
  const [weather, setWeather] = useState(null);
  // This batter's Pitch Lab row from today's morning payload — the same row the scan feeds
  // modelTB, so the panel's TB matches the board. null = job not run / batter not scored.
  const [pitchlabRow, setPitchlabRow] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("arsenal");
  const [sprayCache, setSprayCache] = useState({});
  const [sprayLoading, setSprayLoading] = useState(false);
  const [sprayLoadingMsg, setSprayLoadingMsg] = useState("");
  const [sprayYear, setSprayYear] = useState(2026);
  const [sprayMode, setSprayMode] = useState("season");
  const [sprayStadium, setSprayStadium] = useState(null); // null = use homeTeamAbbrev
  const [headerStatsYear, setHeaderStatsYear] = useState(parseInt(season) || 2026);
  // Stats & Splits inner subtab
  const [statsSubtab, setStatsSubtab] = useState("season");
  // Arsenal Performance tab
  const [arsenalBatterYear, setArsenalBatterYear] = useState(2026);
  const [arsenalBatterCache, setArsenalBatterCache] = useState({});  // year → { pitchCode → metrics }
  const [arsenalBatterLoading, setArsenalBatterLoading] = useState(false);
  const [arsenalSubtab, setArsenalSubtab] = useState("pitches"); // "pitches" | "discipline"
  const [matchupMode, setMatchupMode] = useState(true);
  const [matchupPitcherCache, setMatchupPitcherCache] = useState({}); // year → { pitchCode → {usage,vel} }
  const [arsenalHandSplit, setArsenalHandSplit] = useState("both"); // "both" | "L" | "R" → opposing-pitcher hand filter
  const [bvpByHandCache, setBvpByHandCache] = useState({}); // `${year}-${hand}` → { pitchCode → metrics } (event-aggregated)
  const [pitcherThrows, setPitcherThrows] = useState(null); // starter's throwing hand "L"|"R" — drives ⚡ default side
  const [vsPitchData, setVsPitchData] = useState(null);  // batter vs pitch type stats
  const [disciplineCache, setDisciplineCache] = useState({}); // year → plate discipline metrics
  const [multiYearStats, setMultiYearStats] = useState({});
  const [bio, setBio] = useState(null);
  const [news, setNews] = useState(null);       // null=loading, []=empty, [...]=loaded
  const [newsLoading, setNewsLoading] = useState(true);
  // Splits year selector — cache each year so switching is instant
  const [splitsYear, setSplitsYear] = useState(parseInt(season));
  const [splitsCache, setSplitsCache] = useState({});
  const [seasonStatsCache, setSeasonStatsCache] = useState({});
  const [activeProp, setActiveProp] = useState("hits");
  const [activePeriod, setActivePeriod] = useState("L20");
  const [activeFilters, setActiveFilters] = useState(new Set());
  const [pitcherSplits, setPitcherSplits] = useState(null);
  const [sprayTabLocal, setSprayTabLocal] = useState("all");
  const [gameLog2025, setGameLog2025] = useState(null);
  const [splits2025, setSplits2025] = useState(null);
  const [loading2025, setLoading2025] = useState(false);
  // SB / Baserunning tab
  const [sbSprintSpeed, setSbSprintSpeed] = useState(undefined); // undefined=not yet fetched
  const [sbCatcherData, setSbCatcherData] = useState(undefined);
  const [sbSprintStats, setSbSprintStats] = useState(undefined); // hp1b, bolts
  const [baserunningData, setBaserunningData] = useState(undefined); // rateAttXB/rateSafe/runnerRuns (+lgAvg)
  // vs Pitcher tab
  const [oppPitcherRoster, setOppPitcherRoster] = useState(null); // null=not loaded, []+=loaded
  const [bvpPitcherSelect, setBvpPitcherSelect] = useState(null); // null=use default pitcherId
  const [bvpAltCache, setBvpAltCache] = useState({}); // pitcherId → bvp data|"loading"|null
  const [bvpTeamAbbr, setBvpTeamAbbr] = useState(null); // null = today's pitcherTeam
  const [bvpAltTeamRoster, setBvpAltTeamRoster] = useState(null); // roster for non-opponent team
  const [bvpSortCol, setBvpSortCol] = useState(null);  // null = default (name)
  const [bvpSortDir, setBvpSortDir] = useState("desc");
  // Zone matchup tab
  const [hotZones, setHotZones] = useState(null);         // null=not loaded
  const [pitchLocCache, setPitchLocCache] = useState({}); // pitcherId → locations
  const [zoneMetric, setZoneMetric] = useState("ops");    // "ops" | "avg"
  const [zoneOverlay, setZoneOverlay] = useState(true);
  const [zoneActivePitches, setZoneActivePitches] = useState(null); // null = all
  // Statcast percentile tab
  const [statcastPct, setStatcastPct] = useState(undefined); // undefined=not fetched, null=failed, {}=loaded
  const [statcastPower, setStatcastPower] = useState(undefined);
  const [recentWindow, setRecentWindow]   = useState(null); // last-15-game Statcast tallies
  const [leagueDist, setLeagueDist]       = useState(null); // league season distributions
  // FanGraphs + Savant advanced stats from Supabase DB (separate from live Savant per-game lookup)
  const [panelAdvStats, setPanelAdvStats] = useState(null); // null=not fetched, {}=loaded
  // Extended Savant data — loaded lazily with statcast tab
  const [expectedStats, setExpectedStats]     = useState(undefined); // xBA/xwOBA diffs
  const [battedBall, setBattedBall]           = useState(undefined); // GB%, pull_air_rate, etc.
  const [swingTake, setSwingTake]             = useState(undefined); // zone run values
  const [hrStats, setHrStats]                 = useState(undefined); // xHR vs actual
  const [attackAngle, setAttackAngle]         = useState(undefined); // swing path data
  const [basestealingRV, setBasestealingRV]   = useState(undefined); // SB aggressiveness
  const [oppPitcherRunningGame, setOppPitcherRunningGame] = useState(undefined); // pitcher holding data for batter SB tab
  const [oppBullpenHold, setOppBullpenHold] = useState(undefined); // opposing team's reliever hold aggregate
  const injury = usePlayerInjury(batter?.id, season); // null unless currently on the IL

  useEffect(() => {
    let cancelled = false;
    setSprayCache({}); setMultiYearStats({}); setArsenalBatterCache({}); setMatchupPitcherCache({}); setDisciplineCache({}); setMatchupMode(true); setArsenalSubtab("pitches"); setStatsSubtab("season");
    setVsPitchData(null);
    setBio(null);
    setSbSprintSpeed(undefined); setSbCatcherData(undefined);
    setOppPitcherRoster(null); setBvpPitcherSelect(null); setBvpAltCache({});
    setBvpTeamAbbr(null); setBvpAltTeamRoster(null); setBvpSortCol(null); setBvpSortDir("desc");
    setHotZones(null); setPitchLocCache({}); setZoneActivePitches(null);
    setStatcastPct(undefined); setStatcastPower(undefined);
    setPanelAdvStats(null);
    setExpectedStats(undefined); setBattedBall(undefined); setSwingTake(undefined);
    setHrStats(undefined); setAttackAngle(undefined); setBasestealingRV(undefined);
    setOppPitcherRunningGame(undefined);
    setNews(null);
    setNewsLoading(true);

    const playerName = batter.fullName || `${batter.firstName || ""} ${batter.lastName || ""}`.trim();

    // Main stats — MLB Stats API
    async function load() {
      setLoading(true);
      const [gl, splitsRaw, bvpRaw, ss, wx, bioData, pitchlab] = await Promise.all([
        getGameLog(batter.id, season, "hitting", 30),
        getSplits(batter.id, "vl,vr,h,a,d,n,risp", season),
        pitcherId ? getVsPitcher(batter.id, pitcherId, season) : Promise.resolve(null),
        getSeasonStats(batter.id, season),
        getGameWeather(gamePk),
        getPlayerBio(batter.id),
        // Same date the scan scores (usePropsScan's scanDate); never rejects — null on any miss.
        loadPitchlab(getTodayInAppTimeZone()),
      ]);
      if (cancelled) return;
      const labelMap = { "vs Left": "vs. Left", "vs Right": "vs. Right", "Home Games": "Home", "Away Games": "Away", "Day Games": "Day", "Night Games": "Night", "Scoring Position": "RISP" };
      setPitchlabRow(pitchlab?.batters?.[String(batter.id)] ?? null);
      setGameLog(gl);
      setSplits(splitsRaw.map(s => ({ ...s, label: labelMap[s.split?.description] || s.split?.description })));
      setBvp(bvpRaw);
      setSeasonStats(ss);
      setWeather(wx);
      setBio(bioData);
      setLoading(false);
    }

    // News — fires in parallel, independent of stats
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
  }, [batter.id, pitcherId, season]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch splits for the selected year (current season loaded on mount; historical fetched on demand)
  useEffect(() => {
    if (tab !== "statsplits" || !batter?.id) return;
    const yr = splitsYear;
    if (splitsCache[yr]) return; // already cached
    let cancelled = false;
    const labelMap = { "vs Left": "vs. Left", "vs Right": "vs. Right", "Home Games": "Home", "Away Games": "Away", "Day Games": "Day", "Night Games": "Night", "Scoring Position": "RISP" };
    Promise.all([
      getSplits(batter.id, "vl,vr,h,a,d,n,risp", yr),
      getSeasonStats(batter.id, yr),
    ]).then(([raw, ss]) => {
      if (cancelled) return;
      setSplitsCache(c => ({ ...c, [yr]: raw.map(s => ({ ...s, label: labelMap[s.split?.description] || s.split?.description })) }));
      setSeasonStatsCache(c => ({ ...c, [yr]: ss }));
    });
    return () => { cancelled = true; };
  }, [tab, splitsYear, batter?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Pre-seed cache with the current-season splits + season stats once loaded
  useEffect(() => {
    if (splits && !splitsCache[parseInt(season)]) {
      setSplitsCache(c => ({ ...c, [parseInt(season)]: splits }));
    }
    if (seasonStats && !seasonStatsCache[parseInt(season)]) {
      setSeasonStatsCache(c => ({ ...c, [parseInt(season)]: seasonStats }));
    }
  }, [splits, seasonStats]); // eslint-disable-line react-hooks/exhaustive-deps

  // Lazy-fetch 2025 game log + splits when "2025" period is selected
  useEffect(() => {
    if (activePeriod !== "2025" || !batter?.id || gameLog2025 !== null) return;
    let cancelled = false;
    setLoading2025(true);
    const labelMap = { "vs Left": "vs. Left", "vs Right": "vs. Right", "Home Games": "Home", "Away Games": "Away", "Day Games": "Day", "Night Games": "Night", "Scoring Position": "RISP" };
    Promise.all([
      getGameLog(batter.id, 2025, "hitting", 162),
      getSplits(batter.id, "vl,vr,h,a,d,n,risp", 2025),
    ]).then(([gl, splitsRaw]) => {
      if (cancelled) return;
      setGameLog2025(gl || []);
      setSplits2025(splitsRaw.map(s => ({ ...s, label: labelMap[s.split?.description] || s.split?.description })));
      setLoading2025(false);
    }).catch(() => { if (!cancelled) { setGameLog2025([]); setLoading2025(false); } });
    return () => { cancelled = true; };
  }, [activePeriod, batter?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Lazy-load spray chart data only when that tab is opened (or in full-page mode)
  // Fetch spray data for selected year (cached; venue included so stadium filter works in-memory)
  useEffect(() => {
    if (!fullPageMode && tab !== "spray") return;
    if (!batter?.id) return;
    if (sprayCache[sprayYear] !== undefined) return; // already cached (even if empty)
    let cancelled = false;
    setSprayLoading(true);
    setSprayLoadingMsg(`Fetching ${sprayYear} game list…`);
    getGameLog(batter.id, sprayYear, "hitting", 162).then(async log => {
      if (cancelled) return;
      const gamePks = log.map(g => g.game?.gamePk).filter(Boolean);
      setSprayLoadingMsg(`Loading ${gamePks.length} game${gamePks.length !== 1 ? "s" : ""}…`);
      const data = await getSprayData(batter.id, gamePks);
      if (!cancelled) {
        setSprayCache(c => ({ ...c, [sprayYear]: data || [] }));
        setSprayLoading(false);
        setSprayLoadingMsg("");
      }
    });
    return () => { cancelled = true; };
  }, [tab, sprayYear, batter?.id, fullPageMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch batter vs pitch type once
  useEffect(() => {
    if (!batter?.id || vsPitchData !== null) return;
    getBatterVsPitch(batter.id, season).then(d => setVsPitchData(d || []));
  }, [batter?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Lazy-fetch multi-year stats when Stats tab opens (or always in full-page mode)
  useEffect(() => {
    if (!fullPageMode && tab !== "statsplits") return;
    if (!batter?.id) return;
    const missing = [2024, 2025, 2026].filter(y => multiYearStats[y] === undefined);
    if (missing.length === 0) return;
    Promise.all(missing.map(y => getSeasonStats(batter.id, y).then(s => ({ y, s }))))
      .then(results => {
        setMultiYearStats(prev => {
          const next = { ...prev };
          results.forEach(({ y, s }) => { next[y] = s || null; });
          return next;
        });
      });
  }, [tab, batter?.id, fullPageMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Lazy-fetch batter vs pitch type (Baseball Savant) when Arsenal tab opens or full-page loads
  useEffect(() => {
    if (!fullPageMode && tab !== "arsenal") return;
    if (!batter?.id) return;
    if (arsenalBatterCache[arsenalBatterYear] !== undefined) return;
    setArsenalBatterLoading(true);
    getStatcastBatterVsPitch(batter.id, arsenalBatterYear).then(data => {
      setArsenalBatterCache(c => ({ ...c, [arsenalBatterYear]: data || {} }));
      setArsenalBatterLoading(false);
    });
  }, [tab, arsenalBatterYear, batter?.id, fullPageMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Lazy-fetch pitcher's pitch mix for matchup overlay — also fires in full-page mode
  useEffect(() => {
    if (!fullPageMode && tab !== "arsenal") return;
    if (!pitcherId) return;
    if (matchupPitcherCache[arsenalBatterYear] !== undefined) return;
    getPitchArsenal(pitcherId, arsenalBatterYear).then(splits => {
      const map = {};
      for (const split of splits) {
        const code = split.stat?.type?.code;
        if (code) map[code] = {
          usage: (parseFloat(split.stat?.percentage) || 0) * 100,
          vel:   parseFloat(split.stat?.averageSpeed) || 0,
          count: parseInt(split.stat?.count) || 0,
        };
      }
      setMatchupPitcherCache(c => ({ ...c, [arsenalBatterYear]: map }));
    });
  }, [tab, pitcherId, arsenalBatterYear, fullPageMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Lazy-fetch batter plate discipline when Arsenal tab + discipline subtab is open or full-page loads
  useEffect(() => {
    if (!fullPageMode && (tab !== "arsenal" || arsenalSubtab !== "discipline")) return;
    if (!batter?.id) return;
    if (disciplineCache[arsenalBatterYear] !== undefined) return;
    getPlateDiscipline(batter.id, arsenalBatterYear, "batter").then(data => {
      setDisciplineCache(c => ({ ...c, [arsenalBatterYear]: data }));
    });
  }, [tab, arsenalSubtab, batter?.id, arsenalBatterYear, fullPageMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch the starter's throwing hand — drives the ⚡ default side on the L/R arsenal toggle
  useEffect(() => {
    if (!pitcherId) { setPitcherThrows(null); return; }
    let cancelled = false;
    fetchJson(`${API}/people/${pitcherId}`).then(d => {
      if (!cancelled) setPitcherThrows(d?.people?.[0]?.pitchHand?.code === "L" ? "L" : "R");
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [pitcherId]);

  // Lazy-fetch this batter's per-pitch results split by opposing-pitcher hand (vs LHP / vs RHP).
  // Aggregated from event-level Statcast Search (the leaderboard CSV can't split by hand).
  // Fires for whichever hand is needed: the active L/R toggle, plus the starter's hand for the
  // sidebar "vs LHP/RHP" block.
  useEffect(() => {
    if (!fullPageMode && tab !== "arsenal") return;
    if (!batter?.id) return;
    const wanted = new Set();
    if (arsenalHandSplit === "L" || arsenalHandSplit === "R") wanted.add(arsenalHandSplit);
    if (pitcherThrows) wanted.add(pitcherThrows);
    for (const hand of wanted) {
      const cacheKey = `${arsenalBatterYear}-${hand}`;
      if (bvpByHandCache[cacheKey] !== undefined) continue;
      setBvpByHandCache(c => ({ ...c, [cacheKey]: "loading" }));
      getStatcastBatterVsPitchByHand(batter.id, arsenalBatterYear, hand).then(data => {
        setBvpByHandCache(c => ({ ...c, [cacheKey]: data || {} }));
      }).catch(() => setBvpByHandCache(c => ({ ...c, [cacheKey]: {} })));
    }
  }, [tab, batter?.id, arsenalBatterYear, arsenalHandSplit, pitcherThrows, fullPageMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Lazy-fetch sprint speed + catcher pop time + baserunning when Baserunning tab opens
  useEffect(() => {
    if (tab !== "sb" || !batter?.id) return;
    let cancelled = false;
    if (sbSprintSpeed === undefined) {
      getBatterSprintSpeed(batter.id, season).then(v => { if (!cancelled) setSbSprintSpeed(v ?? null); }).catch(() => { if (!cancelled) setSbSprintSpeed(null); });
    }
    if (sbCatcherData === undefined) {
      getCatcherPopTimesMap(season).then(map => {
        if (!cancelled) setSbCatcherData(map[pitcherTeam?.toUpperCase()] ?? null);
      }).catch(() => { if (!cancelled) setSbCatcherData(null); });
    }
    if (sbSprintStats === undefined) {
      getBatterSprintStats(batter.id, season).then(v => { if (!cancelled) setSbSprintStats(v ?? null); }).catch(() => { if (!cancelled) setSbSprintStats(null); });
    }
    if (baserunningData === undefined) {
      getBatterBaserunning(batter.id, season).then(v => { if (!cancelled) setBaserunningData(v ?? null); }).catch(() => { if (!cancelled) setBaserunningData(null); });
    }
    if (basestealingRV === undefined) {
      getBasestealingRunValue(batter.id, season).then(v => { if (!cancelled) setBasestealingRV(v ?? null); }).catch(() => { if (!cancelled) setBasestealingRV(null); });
    }
    if (oppPitcherRunningGame === undefined && pitcherId) {
      getPitcherRunningGame(pitcherId, season).then(v => { if (!cancelled) setOppPitcherRunningGame(v ?? null); }).catch(() => { if (!cancelled) setOppPitcherRunningGame(null); });
    }
    if (oppBullpenHold === undefined && pitcherTeam) {
      getTeamBullpenHold(pitcherTeam, season).then(v => { if (!cancelled) setOppBullpenHold(v ?? null); }).catch(() => { if (!cancelled) setOppBullpenHold(null); });
    }
    return () => { cancelled = true; };
  }, [tab, batter?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Lazy-fetch opposing pitcher roster when vs Pitcher tab opens
  useEffect(() => {
    if (tab !== "bvp" || !pitcherTeam || oppPitcherRoster !== null) return;
    const tid = MLB_TEAM_IDS[pitcherTeam?.toUpperCase()];
    if (!tid) { setOppPitcherRoster([]); return; }
    getTeamRoster(tid, season, "pitcher").then(r => setOppPitcherRoster(r || [])).catch(() => setOppPitcherRoster([]));
  }, [tab, pitcherTeam]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch pitcher roster for a non-opponent team chosen via the team toggle
  useEffect(() => {
    if (!bvpTeamAbbr || bvpTeamAbbr === pitcherTeam) return;
    setBvpAltTeamRoster(null);
    const tid = MLB_TEAM_IDS[bvpTeamAbbr.toUpperCase()];
    if (!tid) { setBvpAltTeamRoster([]); return; }
    getTeamRoster(tid, season, "pitcher").then(r => setBvpAltTeamRoster(r || [])).catch(() => setBvpAltTeamRoster([]));
  }, [bvpTeamAbbr, pitcherTeam, season]); // eslint-disable-line react-hooks/exhaustive-deps

  // Batch-fetch BvP stats for all pitchers on the active team when bvp tab is open
  useEffect(() => {
    if (tab !== "bvp" || !batter?.id) return;
    const activeTeam = bvpTeamAbbr || pitcherTeam;
    const roster = (activeTeam === pitcherTeam ? oppPitcherRoster : bvpAltTeamRoster) || [];
    if (!roster.length) return;
    for (const p of roster) {
      const pid = String(p.person?.id || "");
      if (!pid || bvpAltCache[pid] !== undefined) continue;
      setBvpAltCache(c => ({ ...c, [pid]: "loading" }));
      getVsPitcher(batter.id, pid, season)
        .then(d => setBvpAltCache(c => ({ ...c, [pid]: d })))
        .catch(() => setBvpAltCache(c => ({ ...c, [pid]: null })));
    }
  }, [tab, batter?.id, oppPitcherRoster, bvpAltTeamRoster, bvpTeamAbbr, pitcherTeam]); // eslint-disable-line react-hooks/exhaustive-deps

  // Lazy-load hot zones + pitcher pitch movement when Zones tab opens
  useEffect(() => {
    if (tab !== "zones") return;
    if (!batter?.id) return;
    // Hot zones (MLB Stats API) — endpoint currently returns 400 but we still try; fallback returns {}
    if (hotZones === null) {
      getBatterHotZones(batter.id, season).then(z => setHotZones(z || {}));
    }
    // Pitcher pitch movement (Savant pitch-movement CSV — fixed URL + column names)
    const pid = String(bvpPitcherSelect ?? pitcherId ?? "");
    if (pid && pitchLocCache[pid] === undefined) {
      setPitchLocCache(c => ({ ...c, [pid]: "loading" }));
      getPitcherPitchLocations(pid, parseInt(season)).then(locs => {
        setPitchLocCache(c => ({ ...c, [pid]: locs }));
      }).catch(() => setPitchLocCache(c => ({ ...c, [pid]: {} })));
    }
  }, [tab, batter?.id, bvpPitcherSelect, pitcherId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Lazy-load Statcast percentile rankings + FanGraphs advanced stats when Statcast tab opens
  useEffect(() => {
    if (tab !== "statcast" || !batter?.id) return;
    if (statcastPct !== undefined) return; // already loaded or loading
    setStatcastPct(null); // null = loading
    setStatcastPower(null);
    setRecentWindow(null);
    const yr = parseInt(season);

    // Recent form is a separate chain: it needs the game log first to find the window bounds,
    // and it must never delay or fail the season card. Bounded by the 15th-most-recent GAME
    // (not 15 calendar days) so an IL stint or an off-week doesn't silently shrink the window.
    getGameLog(batter.id, yr, "hitting", 15)
      .then(async (log) => {
        const dates = log.map(g => g.date).filter(Boolean).sort();
        if (!dates.length) return;
        const [win, dist] = await Promise.all([
          getBatterRecentWindow(batter.id, yr, dates[0], dates[dates.length - 1]),
          getLeagueBatterDistributions(yr),
        ]);
        if (win && dist) { setRecentWindow(win); setLeagueDist(dist); }
      })
      .catch(() => {});

    Promise.all([
      getBatterStatcastPercentiles(batter.id, yr),
      getBatterPowerStats(batter.id, yr),
      panelAdvStats === null ? fetchPlayerAdvancedStats(batter.id, yr, "batter") : Promise.resolve(panelAdvStats),
      getExpectedStats(batter.id, yr, "batter"),
      getBattedBall(batter.id, yr),
      getSwingTake(batter.id, yr, "Batter"),
      getHomeRunStats(batter.id, yr, "batter"),
      getSwingPathAttackAngle(batter.id, yr),
      getBasestealingRunValue(batter.id, yr),
    ]).then(([pct, power, adv, expStats, bb, st, hrs, aa, bsrv]) => {
      setStatcastPct(pct);
      setStatcastPower(power);
      if (adv) setPanelAdvStats(adv);
      setExpectedStats(expStats ?? null);
      setBattedBall(bb ?? null);
      setSwingTake(st ?? null);
      setHrStats(hrs ?? null);
      setAttackAngle(aa ?? null);
      setBasestealingRV(bsrv ?? null);
    }).catch(() => { setStatcastPct({}); setStatcastPower(null); });
  }, [tab, batter?.id, season]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch pitcher splits for full-page mode right sidebar
  useEffect(() => {
    if (!pitcherId || !fullPageMode) return;
    setSplitsCache({}); setPitcherSplits(null);
    getSplits(pitcherId, "vl,vr,h,a", season, "pitching").then(raw => {
      const lm = { "vs Left": "vs LHB", "vs Right": "vs RHB", "Home Games": "Home", "Away Games": "Away" };
      setPitcherSplits(raw.map(s => ({ ...s, label: lm[s.split?.description] || s.split?.description })));
    }).catch(() => {});
  }, [pitcherId, season, fullPageMode]); // eslint-disable-line react-hooks/exhaustive-deps

  const info = batter;
  const pos = info.position?.abbreviation || info.primaryPosition?.abbreviation || "";
  // Bio is the authoritative source — scan/roster objects may have stale/missing batSide
  // Only fall back to info if bio hasn't loaded yet
  const bats = bio?.batSide?.code || info.batSide?.code || "?";
  const throws = bio?.pitchHand?.code || info.pitchHand?.code || "?";
  const jerseyNum = bio?.primaryNumber || info.jerseyNumber || info.primaryNumber || "—";
  const batterProj = useMemo(() => getBatterProj(info.fullName || `${info.firstName} ${info.lastName}`), [info]);
  const pitcherProjData = useMemo(() => getPitcherProj(pitcherName, pitcherTeam), [pitcherName, pitcherTeam]);
  const pr = useMemo(() => batterProjRates(batterProj), [batterProj]);
  const park = useMemo(() => getParkData(venueName, homeTeamAbbrev), [venueName, homeTeamAbbrev]);

  const modelInputs = useMemo(() => {
    if (loading) return null;
    const handSplit = splits?.find(s => s.label === "vs LHP" || s.label === "vs RHP");
    const haSplit = splits?.find(s => s.label === (isHome ? "Home" : "Away"));
    const dnSplit = splits?.find(s => s.label === "Day" || s.label === "Night");
    const careerBvp = bvp?.career?.[0]?.stat || null;
    return {
      proj: batterProj, seasonStats, recentGames: gameLog, bvpStats: careerBvp,
      splits: { handedness: handSplit?.stat || {}, homeAway: haSplit?.stat || {}, dayNight: dnSplit?.stat || {}, isHome },
      pitcherProj: pitcherProjData,
    };
  }, [loading, splits, bvp, batterProj, pitcherProjData, seasonStats, gameLog, isHome]);

  // Apply park + weather + extended Savant signal multipliers to raw model scores
  const models = useMemo(() => {
    if (!modelInputs) return null;
    const raw = {
      hits: modelHits(modelInputs), hr: modelHR(modelInputs),
      sb: modelSB(modelInputs), tb: modelTB({ ...modelInputs, pitchlab: pitchlabRow }),
      hrr: modelHRR(modelInputs),
    };
    const hand = bats || "R";
    const modelMap = PARK_MODEL_BY_MARKET;   // single source of truth — see weather.js
    for (const [key, result] of Object.entries(raw)) {
      if (!result || result.verdict === "SKIP") continue;

      // Pitch Lab TB already carries park, weather and swing shape, and its score is mapped
      // straight onto the board's scoring scale (models.js tbScoreFromProb) — no multipliers.
      // Mirrors the scan (App.jsx usePropsScan) so the panel shows the board's TB number.
      const pitchlabTB = key === 'tb' && !!result.pitchlabTB;

      // 1. Park + weather multiplier (existing)
      const mult = pitchlabTB ? 1 : parkWeatherMult(park, weather, hand, modelMap[key]);
      result.parkMult = mult;
      if (result.score != null) result.adjScore = result.score * mult;

      // 2. Extended Savant signals (new) — applied on top of park/weather adj
      let extMult = 1.0;

      if (key === 'hits') {
        // Luck: xBA vs actual BA regression signal
        const lm = computeExpectedStatsLuck(expectedStats?.xbaDiff, null, 'H');
        if (lm !== 1.0) { result.luckMult = lm; extMult *= lm; }
        // Zone-discipline swing-take term REMOVED 2026-07-29 — it sat at its 0.96
        // floor on 98.5% of scanned rows, so it was a flat −4% for having the data
        // rather than a signal. Absorbed into HITS_CAL_B1/CAP (see models.js:170).
        // The swing-take STATS are still fetched and displayed; only the multiplier is gone.
      }
      if (key === 'tb' && !pitchlabTB) {
        // Luck: xwOBA vs actual wOBA regression signal
        const lm = computeExpectedStatsLuck(null, expectedStats?.xwobaDiff, 'TB');
        if (lm !== 1.0) { result.luckMult = lm; extMult *= lm; }
        // Attack angle: ideal launch-angle zone rate → air-ball quality
        const aam = computeAttackAngleMult(attackAngle, 'TB');
        if (aam !== 1.0) { result.attackAngleMult = aam; extMult *= aam; }
      }
      if (key === 'hr') {
        // Batted ball HR corridor: pull_air_rate + GB%
        const bm = computeBattedBallHRMult(battedBall);
        if (bm !== 1.0) { result.battedBallMult = bm; extMult *= bm; }
        // xHR regression: actual HR vs expected HR (luck-corrected signal)
        const hlm = computeHRLuckMult(hrStats);
        if (hlm !== 1.0) { result.hrLuckMult = hlm; extMult *= hlm; }
        // Attack angle: ideal launch-angle zone rate boosts HR ceiling
        const aam = computeAttackAngleMult(attackAngle, 'HR');
        if (aam !== 1.0) { result.attackAngleMult = aam; extMult *= aam; }
      }
      if (key === 'sb') {
        // Basestealing aggressiveness + success quality
        const bsm = computeBasestealingMult(basestealingRV);
        if (bsm !== 1.0) { result.basestealingMult = bsm; extMult *= bsm; }
        // Pitcher holding: how well the opposing pitcher controls the running game
        const phm = computePitcherHoldingMult(oppPitcherRunningGame, pitcherThrows);
        if (phm !== 1.0) { result.pitcherHoldingMult = phm; extMult *= phm; }
      }
      if (key === 'hrr') {
        // Luck: blend xBA vs BA (H component) + xwOBA vs wOBA (overall quality)
        const lm = computeExpectedStatsLuck(expectedStats?.xbaDiff, expectedStats?.xwobaDiff, 'HRR');
        if (lm !== 1.0) { result.luckMult = lm; extMult *= lm; }
        // Attack angle: removed as an HRR signal 2026-09-12 (no replication on HRR/PA);
        // only its level is kept so calibration + gates hold — see models.js attackAngleLevelHRR.
        extMult *= attackAngleLevelHRR(attackAngle);
      }

      if (extMult !== 1.0 && result.adjScore != null) {
        result.adjScore = result.adjScore * extMult;
        // HR: hard cap to prevent compounding into unrealistic rates
        if (key === 'hr') result.adjScore = Math.min(result.adjScore, 0.085);
        result.extMult = extMult;
      }

      // Adjust verdict if combined adjustments swing it significantly
      if (result.adjScore != null && result.thresholds) {
        const s = result.adjScore;
        if (s >= (result.thresholds?.strong || 0.7)) result.adjVerdict = "STRONG OVER";
        else if (s >= (result.thresholds?.lean || 0.55)) result.adjVerdict = "LEAN OVER";
        else if (s <= (result.thresholds?.under || 0.35)) result.adjVerdict = "LEAN UNDER";
        else result.adjVerdict = "NEUTRAL";
      }
    }
    return raw;
  }, [modelInputs, pitchlabRow, park, weather, bats, expectedStats, battedBall, swingTake, basestealingRV, hrStats, attackAngle, oppPitcherRunningGame]);

  // Personal flags: birthday, home/road advantage, hometown
  const playerFlags = useMemo(() => {
    if (loading) return {};
    const homeSplit = splits?.find(s => s.label === "Home");
    const awaySplit = splits?.find(s => s.label === "Away");
    return computePlayerFlags({
      bio,
      homeAvg: homeSplit?.stat?.avg ? parseFloat(homeSplit.stat.avg) : null,
      awayAvg: awaySplit?.stat?.avg ? parseFloat(awaySplit.stat.avg) : null,
      parkAbbrev: homeTeamAbbrev,
      today: getTodayInAppTimeZone(),
    });
  }, [loading, bio, splits, homeTeamAbbrev]);

  const tabStyle = (active) => ({
    padding: "8px 14px", fontSize: 11, fontWeight: 600, letterSpacing: 0.5,
    background: active ? "rgba(32,98,200,0.24)" : "transparent",
    color: active ? "#2062c8" : "#74839d",
    border: active ? "1px solid rgba(32,98,200,0.3)" : "1px solid transparent",
    borderRadius: 6, cursor: "pointer", textTransform: "uppercase", transition: "all 0.15s",
  });

  // ── FULL PAGE MODE ──
  const PROP_PILLS = [
    { key: "hits", label: "HITS",  thresh: 0.5 },
    { key: "hr",   label: "HR",    thresh: 0.5 },
    { key: "tb",   label: "TB",    thresh: 1.5 },
    { key: "hrr",  label: "HRR",   thresh: 1.5 },
    { key: "rbi",  label: "RBI",   thresh: 0.5 },
    { key: "sb",   label: "SB",    thresh: 0.5 },
  ];
  const PERIODS = ["2026","2025","L5","L10","L20"];

  const filteredGameLog = useMemo(() => {
    let gl = activePeriod === "2025" ? (gameLog2025 || []) : (gameLog || []);
    if (activePeriod === "L5")  gl = gl.slice(0, 5);
    else if (activePeriod === "L10") gl = gl.slice(0, 10);
    else if (activePeriod === "L20") gl = gl.slice(0, 20);
    // "2026" / "2025" = all games from that year
    if (activeFilters.has("home"))  gl = gl.filter(g => g.isHome === true);
    if (activeFilters.has("away"))  gl = gl.filter(g => g.isHome === false);
    if (activeFilters.has("day"))   gl = gl.filter(g => g.game?.dayNight === "day");
    if (activeFilters.has("night")) gl = gl.filter(g => g.game?.dayNight === "night");
    return gl;
  }, [gameLog, gameLog2025, activePeriod, activeFilters]);

  const activePropConfig = PROP_PILLS.find(p => p.key === activeProp) || PROP_PILLS[0];

  const toggleFilter = (f) => setActiveFilters(prev => {
    const next = new Set(prev);
    if (next.has(f)) next.delete(f); else next.add(f);
    return next;
  });

  if (fullPageMode) {
    const pillStyle = (active) => ({
      padding: "5px 12px", fontSize: 11, fontWeight: 700, borderRadius: 20, cursor: "pointer",
      background: active ? "rgba(32,98,200,0.2)" : "transparent",
      color: active ? "#2062c8" : "#8b99b0",
      border: active ? "1px solid rgba(32,98,200,0.4)" : "1px solid rgba(32,98,200,0.128)",
      transition: "all 0.12s",
    });
    const periodStyle = (active) => ({
      padding: "4px 10px", fontSize: 10, fontWeight: 700, borderRadius: 4, cursor: "pointer",
      background: active ? "#2062c8" : "transparent",
      color: active ? "#fff" : "#74839d",
      border: "none",
    });
    const filterStyle = (active) => ({
      padding: "4px 10px", fontSize: 10, fontWeight: 600, borderRadius: 4, cursor: "pointer",
      background: active ? "rgba(32,98,200,0.24)" : "rgba(210,217,236,0.4)",
      color: active ? "#2062c8" : "#8b99b0",
      border: active ? "1px solid rgba(32,98,200,0.3)" : "1px solid rgba(32,98,200,0.096)",
    });

    // Projections table data
    const projRows = [
      { stat: "Hits", proj: models?.hits ? (models.hits.score * 4.1).toFixed(2) : null, line: "0.5" },
      { stat: "HR",   proj: models?.hr   ? (models.hr.score * 100).toFixed(1) + "%" : null, line: "0.5" },
      { stat: "TB",   proj: models?.tb   ? models.tb.score?.toFixed(2) : null, line: "1.5" },
      { stat: "HRR",  proj: models?.hrr  ? models.hrr.score?.toFixed(2) : null, line: "1.5" },
      { stat: "RBI",  proj: models?.rbi  ? ((models.rbi.impliedProb05 ?? 0) * 100).toFixed(0) + "%" : null, line: "0.5" },
      { stat: "SB",   proj: models?.sb   ? (models.sb.score * 100).toFixed(0) + "%" : null, line: "0.5" },
    ].filter(r => r.proj != null);

    // Opposing lineup from lineupData
    const oppLineup = lineupData[pitcherTeam] || null;

    // Book odds table (all markets × all books)
    const BOOKS_LIST = ["fanduel","draftkings","hardrockbet"];
    const MARKET_GROUPS_FP = [
      { label: "Hits",        std: "batter_hits",           alt: "batter_hits_alternate" },
      { label: "Home Run",    std: "batter_home_runs",      alt: "batter_home_runs_alternate" },
      { label: "Total Bases", std: "batter_total_bases",    alt: "batter_total_bases_alternate" },
      { label: "H+R+RBI",    std: "batter_hits_runs_rbis", alt: "batter_hits_runs_rbis_alternate" },
      { label: "RBI",         std: "batter_rbis",           alt: "batter_rbis_alternate" },
    ];
    const nn = _normPropName(batter?.fullName || batter?.name || info?.fullName || "");
    const pdFP = propOddsMap?.[nn] || {};

    return (
      <div style={{
        position: "fixed", inset: 0, zIndex: 1000,
        background: "linear-gradient(135deg, #f2f5fb 0%, #ffffff 50%, #f0f4fb 100%)",
        display: "grid",
        gridTemplateColumns: isMobile ? "1fr" : "64fr 36fr",
        overflow: isMobile ? "auto" : "hidden",
        // iOS: this is the only scroller on mobile. Contain the overscroll so a
        // rubber-band at either end doesn't hand off to the document behind the
        // overlay (which reads as the panel freezing mid-scroll).
        WebkitOverflowScrolling: "touch",
        overscrollBehavior: "contain",
      }}>
        {/* ── LEFT COLUMN ── */}
        <div style={{ overflowY: isMobile ? undefined : "auto", borderRight: isMobile ? "none" : "1px solid rgba(32,98,200,0.16)", display: "flex", flexDirection: "column" }}>
          {/* Sticky header */}
          <div style={{ position: "sticky", top: 0, zIndex: 10, background: "rgba(221,228,240,0.97)", borderBottom: "1px solid rgba(32,98,200,0.16)", padding: "12px 20px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
              <button onClick={onClose} style={{ background: "rgba(32,98,200,0.128)", border: "1px solid rgba(32,98,200,0.2)", color: "#2062c8", borderRadius: 6, padding: "5px 12px", cursor: "pointer", fontSize: 12, fontWeight: 700 }}>← Back</button>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 20, fontWeight: 800, color: "#16233c", display: "flex", alignItems: "center", gap: 8 }}>
                  {info.fullName || `${info.firstName || ""} ${info.lastName || ""}`}
                  <PlayerFlagBadges flags={playerFlags} size={16} />
                  <InjuryBadge inj={injury} size={16} />
                </div>
                <div style={{ fontSize: 11, color: "#6d7c96", marginTop: 1 }}>
                  {batterTeam} · {pos} · Bats {bats}
                  {pitcherName && ` · vs ${pitcherName}${pitcherTeam ? ` (${pitcherTeam})` : ""}`}
                  {venueName && ` · ${venueName}`}
                </div>
                <ContractLine playerId={info.id || batter?.id} />
                <InjuryLine inj={injury} />
              </div>
            </div>
            {/* Season stat pills with year toggle */}
            {(() => {
              const sstats = multiYearStats[headerStatsYear] || (headerStatsYear === parseInt(season) ? seasonStats : null);
              const yearToggle = (yr) => ({
                fontSize: 9, padding: "2px 7px", borderRadius: 3, cursor: "pointer", fontWeight: 700,
                background: headerStatsYear === yr ? "rgba(32,98,200,0.18)" : "transparent",
                color: headerStatsYear === yr ? "#2062c8" : "#b6c5dc",
                border: headerStatsYear === yr ? "1px solid rgba(32,98,200,0.3)" : "1px solid transparent",
              });
              return (
                <div style={{ display: "flex", gap: 5, alignItems: "center", flexWrap: "wrap", marginBottom: 6 }}>
                  <div style={{ display: "flex", gap: 2, marginRight: 4 }}>
                    {[2025, 2026].map(yr => <button key={yr} onClick={() => setHeaderStatsYear(yr)} style={yearToggle(yr)}>{yr}</button>)}
                  </div>
                  {sstats ? [
                    { label: "AVG", val: sstats.avg || "—" },
                    { label: "OBP", val: sstats.obp || "—" },
                    { label: "SLG", val: sstats.slg || "—" },
                    { label: "HR",  val: sstats.homeRuns ?? "—" },
                    { label: "RBI", val: sstats.rbi ?? "—" },
                    { label: "SB",  val: sstats.stolenBases ?? "—" },
                    { label: "CS",  val: sstats.caughtStealing ?? "—" },
                    { label: "G",   val: sstats.gamesPlayed ?? "—" },
                  ].map(({ label, val }) => (
                    <div key={label} style={{ padding: "2px 8px", borderRadius: 10, background: "rgba(32,98,200,0.096)", border: "1px solid rgba(32,98,200,0.16)", display: "flex", gap: 4, alignItems: "center" }}>
                      <span style={{ fontSize: 8, color: "#b6c5dc", textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</span>
                      <span style={{ fontSize: 11, fontWeight: 700, color: "#16233c", fontFamily: "'JetBrains Mono',monospace" }}>{val}</span>
                    </div>
                  )) : <span style={{ fontSize: 10, color: "#b6c5dc" }}>Loading stats…</span>}
                </div>
              );
            })()}
            {/* Prop pills */}
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {PROP_PILLS.map(p => (
                <button key={p.key} onClick={() => setActiveProp(p.key)} style={pillStyle(activeProp === p.key)}>{p.label}</button>
              ))}
            </div>
          </div>

          <div style={{ padding: "16px 20px 40px", flex: 1 }}>
            {/* Period toggle + filters */}
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
              <div style={{ display: "flex", gap: 2, background: "rgba(210,217,236,0.5)", borderRadius: 6, padding: 2 }}>
                {PERIODS.map(p => <button key={p} onClick={() => setActivePeriod(p)} style={periodStyle(activePeriod === p)}>{p}</button>)}
              </div>
              <div style={{ display: "flex", gap: 4 }}>
                {[["home","HOME"],["away","AWAY"],["day","DAY"],["night","NIGHT"]].map(([k,l]) => (
                  <button key={k} onClick={() => toggleFilter(k)} style={filterStyle(activeFilters.has(k))}>{l}</button>
                ))}
              </div>
            </div>

            {/* Bar chart */}
            {(loading || (activePeriod === "2025" && loading2025)) ? (
              <div style={{ height: 140, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <Loader text={activePeriod === "2025" ? "Loading 2025 game log..." : "Loading game log..."} />
              </div>
            ) : (
              <div style={{ background: "rgba(210,217,236,0.4)", borderRadius: 10, border: "1px solid rgba(32,98,200,0.128)", padding: "14px 16px", marginBottom: 20 }}>
                <PropBarChart gameLog={filteredGameLog} propKey={activeProp} threshold={activePropConfig.thresh} />
              </div>
            )}

            {/* Projections mini-table */}
            {projRows.length > 0 && (
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 10, color: "#8b99b0", textTransform: "uppercase", letterSpacing: 1.2, fontWeight: 700, marginBottom: 8 }}>Today's Projections</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
                  {projRows.map(r => {
                    const lineNum = parseFloat(r.line);
                    const projNum = parseFloat(r.proj);
                    const isOver = !isNaN(projNum) && !isNaN(lineNum) && projNum > lineNum;
                    return (
                      <div key={r.stat} style={{ background: "rgba(210,217,236,0.5)", borderRadius: 8, padding: "8px 10px", border: "1px solid rgba(32,98,200,0.128)", textAlign: "center" }}>
                        <div style={{ fontSize: 9, color: "#8b99b0", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 4 }}>{r.stat} O{r.line}</div>
                        <div style={{ fontSize: 16, fontWeight: 800, color: isOver ? "#0f8a44" : "#16233c", fontFamily: "'JetBrains Mono',monospace" }}>{r.proj}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

          </div>
        </div>

        {/* ── RIGHT COLUMN ── */}
        <div style={{ overflowY: isMobile ? undefined : "auto", padding: isMobile ? "8px 12px 40px" : "8px 10px 40px", borderTop: isMobile ? "1px solid rgba(32,98,200,0.16)" : "none" }}>

          {/* Book Odds */}
          {(() => {
            const PROP_LABEL_MAP = { hits:"Hits", hits15:"1.5+ Hits", hr:"Home Run", tb:"Total Bases", hrr:"H+R+RBI", rbi:"RBI", sb:"Stolen Base" };
            const PROP_MARKET_MAP = {
              hits:  { std: "batter_hits",           alt: "batter_hits_alternate" },
              hits15:{ std: "batter_hits",           alt: "batter_hits_alternate" },
              hr:    { std: "batter_home_runs",      alt: "batter_home_runs_alternate" },
              tb:    { std: "batter_total_bases",    alt: "batter_total_bases_alternate" },
              hrr:   { std: "batter_hits_runs_rbis", alt: "batter_hits_runs_rbis_alternate" },
              rbi:   { std: "batter_rbis",           alt: "batter_rbis_alternate" },
              sb:    { std: "batter_stolen_bases",   alt: "batter_stolen_bases_alternate" },
            };
            const activePropLabel = PROP_LABEL_MAP[activeProp] || activeProp;
            const mg = PROP_MARKET_MAP[activeProp];
            const lineMap = {};
            if (mg) {
              for (const [mk, books] of Object.entries(pdFP)) {
                if (mk !== mg.std && mk !== mg.alt) continue;
                for (const [line, bkData] of Object.entries(books)) {
                  if (!lineMap[line]) lineMap[line] = {};
                  for (const bk of BOOKS_LIST) {
                    if (bkData[bk]?.price != null && !lineMap[line][bk]) lineMap[line][bk] = bkData[bk];
                  }
                }
              }
            }
            const lines = Object.keys(lineMap).map(Number).sort((a, b) => a - b);
            // Use the same calibrated probability path as the board/save pipeline.
            const _propMdlKey = { hits:"hits", hits15:"hits", hr:"hr", tb:"tb", hrr:"hrr", rbi:"rbi", sb:"sb" };
            const _pMdl = models?.[_propMdlKey[activeProp]];
            const _getModelProb = (line) => {
              // Pitch Lab TB: the board prices 1.5/2.5 from the model's own ladder (impliedProb15/25
              // = tb2/tb3), not from a calibration curve over the mapped score — so does the panel.
              if (activeProp === "tb" && _pMdl?.pitchlabTB) {
                const atLine = line === 1.5 ? _pMdl.impliedProb15 : line === 2.5 ? _pMdl.impliedProb25 : null;
                if (atLine != null) return atLine;
              }
              const score = _pMdl?.adjScore ?? _pMdl?.score;
              return score == null ? null : modelImpliedProb(score, _propMdlKey[activeProp], line);
            };

            return (
              <CollapsibleSection title={`Book Odds · ${activePropLabel}`} accent="#2062c8" defaultOpen={true}>
                {!lines.length ? (
                  <div style={{ color: "#8b99b0", fontSize: 11, padding: "8px 0", textAlign: "center" }}>No {activePropLabel} odds</div>
                ) : (
                  <div>
                    <div style={{ display: "grid", gridTemplateColumns: "55px 1fr 1fr 1fr auto", padding: "4px 0 4px", borderBottom: "1px solid rgba(32,98,200,0.16)", marginBottom: 2 }}>
                      <span style={{ fontSize: 9, color: "#8b99b0", fontWeight: 700, textTransform: "uppercase" }}>LINE</span>
                      {["FD","DK","HR"].map(h => <span key={h} style={{ fontSize: 9, color: "#8b99b0", fontWeight: 700, textTransform: "uppercase", textAlign: "right" }}>{h}</span>)}
                      <span style={{ fontSize: 9, color: "#8b99b0", fontWeight: 700, textTransform: "uppercase", textAlign: "right", paddingLeft: 8 }}>SIZE</span>
                    </div>
                    {lines.map(line => {
                      const entry = lineMap[line];
                      const prices = BOOKS_LIST.map(bk => entry[bk]?.price).filter(p => p != null);
                      const bestP = prices.length ? Math.max(...prices) : null;
                      const modelProb = _getModelProb(line);
                      return (
                        <div key={line} style={{ display: "grid", gridTemplateColumns: "55px 1fr 1fr 1fr auto", padding: "5px 0", borderBottom: "1px solid rgba(32,98,200,0.064)", alignItems: "center" }}>
                          <span style={{ fontSize: 11, fontWeight: 700, color: "#a16207", fontFamily: "'JetBrains Mono',monospace" }}>O{line}</span>
                          {BOOKS_LIST.map(bk => {
                            const e = entry[bk];
                            let url = null;
                            if (e && bk === "hardrockbet" && e.sid) url = `https://share.hardrock.bet/Pt0T/bet?deep_link_value=hardrock://betslip/${e.sid}`;
                            else if (e) url = e.link;
                            return <span key={bk} style={{ textAlign: "right" }}><OddsLink price={e?.price ?? null} url={url} isBest={e?.price != null && e.price === bestP} bk={bk} style={{ fontSize: 11 }} /></span>;
                          })}
                          <span style={{ textAlign: "right", paddingLeft: 8 }}>
                            <KellyBadge modelProb={modelProb} americanOdds={bestP} />
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </CollapsibleSection>
            );
          })()}

          {/* Spray Chart */}
          <CollapsibleSection title={`Spray Chart · ${sprayYear}`} accent="#0f8a44" defaultOpen={false}>
            {(() => {
              // Park filter logic (reuses sprayMode / sprayStadium states)
              const parkAbbrev = (() => {
                const raw = sprayStadium || homeTeamAbbrev;
                return _ABBREV_ALIASES?.[raw] || raw;
              })();
              const stadiumPark = parkAbbrev ? PARK_DATA[parkAbbrev] : null;
              const allBIP = sprayCache[sprayYear] || [];
              const parkFiltered = sprayMode === "stadium" && stadiumPark
                ? allBIP.filter(h => h.venue === stadiumPark.name)
                : allBIP;
              const handFiltered = sprayTabLocal === "vl" ? parkFiltered.filter(d => d.pitcherHand === "L")
                : sprayTabLocal === "vr" ? parkFiltered.filter(d => d.pitcherHand === "R")
                : parkFiltered;

              const smBtnStyle = (active) => ({
                fontSize: 9, padding: "2px 8px", borderRadius: 4, cursor: "pointer", fontWeight: 700,
                background: active ? "rgba(15,138,68,0.15)" : "transparent",
                color: active ? "#0f8a44" : "#8b99b0",
                border: active ? "1px solid rgba(15,138,68,0.3)" : "1px solid rgba(32,98,200,0.16)",
              });
              const yrBtnStyle = (yr) => ({
                fontSize: 9, padding: "2px 7px", borderRadius: 4, cursor: "pointer", fontWeight: 700,
                background: sprayYear === yr ? "rgba(15,138,68,0.12)" : "transparent",
                color: sprayYear === yr ? "#0f8a44" : "#8b99b0",
                border: sprayYear === yr ? "1px solid rgba(15,138,68,0.25)" : "1px solid rgba(32,98,200,0.16)",
              });

              return (
                <div>
                  {/* Park + Weather bar — same as Props Analysis tab */}
                  {park && (
                    <div style={{ marginBottom: 10, padding: "10px 14px", background: "rgba(32,98,200,0.096)", borderRadius: 10, border: "1px solid rgba(32,98,200,0.192)" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ fontSize: 14 }}>🏟️</span>
                          <span style={{ fontSize: 12, fontWeight: 600, color: "#16233c" }}>{park.name}</span>
                          <span style={{ fontSize: 10, color: "#74839d", fontFamily: "'JetBrains Mono', monospace" }}>
                            {park.dims.LF}-{park.dims.LCF}-{park.dims.CF}-{park.dims.RCF}-{park.dims.RF}
                          </span>
                          {park.elev > 3000 && <span style={{ fontSize: 10, padding: "1px 5px", background: "rgba(161,98,7,0.15)", color: "#a16207", borderRadius: 4 }}>⛰ {park.elev.toLocaleString()}ft</span>}
                          {park.roof !== "open" && <span style={{ fontSize: 10, padding: "1px 5px", background: "rgba(32,98,200,0.24)", color: "#2569d6", borderRadius: 4 }}>{park.roof === "dome" ? "🏛 Dome" : "🔄 Retractable"}</span>}
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          {weather?.temp != null && <span style={{ fontSize: 11, color: "#4c5f7d", fontFamily: "'JetBrains Mono', monospace" }}>🌡 {weather.temp}°F</span>}
                          {weather?.windSpeed > 0 && <span style={{ fontSize: 11, color: "#4c5f7d", fontFamily: "'JetBrains Mono', monospace" }}>💨 {weather.windSpeed}mph {weather.windDir}</span>}
                          {weather?.condition && <span style={{ fontSize: 11, color: "#74839d" }}>{weather.condition}</span>}
                          {!weather && <span style={{ fontSize: 10, color: "#8b99b0" }}>Weather: pre-game</span>}
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 16, marginTop: 8, flexWrap: "wrap" }}>
                        {(() => {
                          const hand = bats || "R";
                          const pullSide = hand === "L" ? "RF" : "LF";
                          const pullDist = hand === "L" ? park.dims.RF : park.dims.LF;
                          const pullWall = hand === "L" ? park.wall.RF : park.wall.LF;
                          const pullAlley = hand === "L" ? park.dims.RCF : park.dims.LCF;
                          const hrPF = hand === "L" ? park.pf.HR_L : park.pf.HR_R;
                          const pfColor = hrPF >= 1.08 ? "#0f8a44" : hrPF <= 0.92 ? "#d03131" : "#4c5f7d";
                          const pfLabel = hrPF >= 1.08 ? "▲ Hitter-friendly" : hrPF <= 0.92 ? "▼ Pitcher-friendly" : "— Neutral";
                          return (<>
                            <div style={{ fontSize: 10, color: "#74839d" }}>
                              Pull ({pullSide}): <span className="mono" style={{ color: pullDist <= 322 ? "#0f8a44" : pullDist >= 340 ? "#c2570f" : "#4c5f7d" }}>{pullDist}ft</span>
                              {" · "}Wall: <span className="mono">{pullWall}ft</span>
                              {" · "}Alley: <span className="mono">{pullAlley}ft</span>
                            </div>
                            <div style={{ fontSize: 10, color: pfColor, fontWeight: 600 }}>HR PF: {(hrPF * 100).toFixed(0)} {pfLabel}</div>
                            {park.pf["2B"] >= 1.10 && <div style={{ fontSize: 10, color: "#a16207", fontWeight: 600 }}>2B PF: {(park.pf["2B"] * 100).toFixed(0)} ▲ Gap-friendly</div>}
                            {park.pf["3B"] >= 1.10 && <div style={{ fontSize: 10, color: "#9333ea", fontWeight: 600 }}>3B PF: {(park.pf["3B"] * 100).toFixed(0)} ▲ Speed-friendly</div>}
                          </>);
                        })()}
                      </div>
                    </div>
                  )}
                  {/* Row 1: handedness tabs + year toggle */}
                  <div style={{ display: "flex", gap: 4, marginBottom: 6, alignItems: "center", flexWrap: "wrap" }}>
                    {[["all","All"],["vl","vs LHP"],["vr","vs RHP"]].map(([k,l]) => (
                      <button key={k} onClick={() => setSprayTabLocal(k)} style={{
                        fontSize: 10, padding: "3px 8px", borderRadius: 4, cursor: "pointer", fontWeight: 600,
                        background: sprayTabLocal === k ? "rgba(15,138,68,0.15)" : "transparent",
                        color: sprayTabLocal === k ? "#0f8a44" : "#8b99b0",
                        border: sprayTabLocal === k ? "1px solid rgba(15,138,68,0.3)" : "1px solid transparent",
                      }}>{l}</button>
                    ))}
                    <div style={{ marginLeft: "auto", display: "flex", gap: 3 }}>
                      {[2026, 2025, 2024].map(yr => <button key={yr} onClick={() => setSprayYear(yr)} style={yrBtnStyle(yr)}>{yr}</button>)}
                    </div>
                  </div>
                  {/* Row 2: park filter */}
                  <div style={{ display: "flex", gap: 4, marginBottom: 8, alignItems: "center" }}>
                    <button onClick={() => { setSprayMode("season"); setSprayStadium(null); }} style={smBtnStyle(sprayMode !== "stadium")}>All Parks</button>
                    <select
                      value={sprayMode === "stadium" ? parkAbbrev : ""}
                      onChange={e => { if (e.target.value) { setSprayStadium(e.target.value); setSprayMode("stadium"); } else { setSprayMode("season"); setSprayStadium(null); } }}
                      style={{
                        fontSize: 9, padding: "2px 6px", borderRadius: 4, cursor: "pointer",
                        background: "#edf2fa",
                        border: `1px solid ${sprayMode === "stadium" ? "rgba(15,138,68,0.35)" : "rgba(32,98,200,0.24)"}`,
                        color: sprayMode === "stadium" ? "#0f8a44" : "#74839d", outline: "none",
                      }}
                    >
                      <option value="">— Park Filter —</option>
                      {Object.entries(PARK_DATA).sort((a,b) => a[0].localeCompare(b[0])).map(([abbr, p]) => (
                        <option key={abbr} value={abbr}>{abbr} — {p.name}</option>
                      ))}
                    </select>
                    {sprayMode === "stadium" && stadiumPark && (
                      <span style={{ fontSize: 9, color: "#0f8a44" }}>{parkFiltered.length} BIP</span>
                    )}
                  </div>
                  {sprayLoading && allBIP.length === 0 ? <Loader text={`Loading ${sprayYear} spray data...`} /> :
                   !handFiltered.length ? (
                    <div style={{ color: "#8b99b0", fontSize: 12, padding: "10px 0", textAlign: "center" }}>
                      No batted ball data
                      {sprayYear === 2026 && <span style={{ fontSize: 10, color: "#c9d5e8" }}> — try 2025</span>}
                    </div>
                  ) : (
                    <SprayChart hits={handFiltered} park={sprayMode === "stadium" ? stadiumPark : null} battingHand={bats !== "?" ? bats : undefined} />
                  )}
                </div>
              );
            })()}
          </CollapsibleSection>

          {/* Batter Splits */}
          <CollapsibleSection title={`Batter Splits · ${activePeriod === "2025" ? "2025" : "2026"}`} accent="#2062c8" defaultOpen={false}>
            {(loading || (activePeriod === "2025" && loading2025)) ? <Loader text="Loading..." /> : (() => {
              const activeSplits = activePeriod === "2025" ? (splits2025 || []) : (splits || []);
              const rows = activeSplits.filter(s => ["vs LHB","vs RHB","Home","Away","vs RISP","vs. Left","vs. Right"].includes(s.label) || ["vs Left","vs Right","Home Games","Away Games","vs RISP"].includes(s.split?.description));
              if (!rows.length) return <div style={{ color: "#8b99b0", fontSize: 12 }}>No splits data</div>;
              return (
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                  <thead><tr style={{ borderBottom: "1px solid rgba(32,98,200,0.128)" }}>
                    {["SPLIT","AVG","OBP","SLG","HR","K"].map(h => <th key={h} style={{ padding: "4px 6px", textAlign: h === "SPLIT" ? "left" : "right", color: "#8b99b0", fontSize: 9, fontWeight: 700 }}>{h}</th>)}
                  </tr></thead>
                  <tbody>
                    {rows.map((s, i) => {
                      const st = s.stat || {};
                      const lbl = s.label || s.split?.description || "";
                      return (
                        <tr key={i} style={{ borderBottom: "1px solid rgba(32,98,200,0.064)" }}>
                          <td style={{ padding: "5px 6px", color: "#5d6f8b", fontSize: 10, fontWeight: 600 }}>{lbl}</td>
                          <td style={{ padding: "5px 6px", textAlign: "right", color: "#16233c", fontFamily: "'JetBrains Mono',monospace", fontSize: 11 }}>{st.avg || "—"}</td>
                          <td style={{ padding: "5px 6px", textAlign: "right", color: "#5d6f8b", fontFamily: "'JetBrains Mono',monospace", fontSize: 11 }}>{st.obp || "—"}</td>
                          <td style={{ padding: "5px 6px", textAlign: "right", color: "#5d6f8b", fontFamily: "'JetBrains Mono',monospace", fontSize: 11 }}>{st.slg || "—"}</td>
                          <td style={{ padding: "5px 6px", textAlign: "right", color: "#5d6f8b", fontSize: 11 }}>{st.homeRuns ?? "—"}</td>
                          <td style={{ padding: "5px 6px", textAlign: "right", color: "#5d6f8b", fontSize: 11 }}>{st.strikeOuts ?? "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              );
            })()}
          </CollapsibleSection>

          {/* Pitcher Splits */}
          {pitcherId && (
            <CollapsibleSection title={`${pitcherName ? pitcherName.split(" ").pop() : "Pitcher"} Splits`} accent="#c2570f">
              {!pitcherSplits ? <Loader text="Loading pitcher splits..." /> : (() => {
                const rows = pitcherSplits.filter(s => ["vs LHB","vs RHB","Home","Away"].includes(s.label));
                if (!rows.length) return <div style={{ color: "#8b99b0", fontSize: 12 }}>No splits data</div>;
                return (
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                    <thead><tr style={{ borderBottom: "1px solid rgba(32,98,200,0.128)" }}>
                      {["SPLIT","AVG","ERA","K","BB","WHIP"].map(h => <th key={h} style={{ padding: "4px 6px", textAlign: h === "SPLIT" ? "left" : "right", color: "#8b99b0", fontSize: 9, fontWeight: 700 }}>{h}</th>)}
                    </tr></thead>
                    <tbody>
                      {rows.map((s, i) => {
                        const st = s.stat || {};
                        return (
                          <tr key={i} style={{ borderBottom: "1px solid rgba(32,98,200,0.064)" }}>
                            <td style={{ padding: "5px 6px", color: "#5d6f8b", fontSize: 10, fontWeight: 600 }}>{s.label}</td>
                            <td style={{ padding: "5px 6px", textAlign: "right", color: "#16233c", fontFamily: "'JetBrains Mono',monospace", fontSize: 11 }}>{st.avg || "—"}</td>
                            <td style={{ padding: "5px 6px", textAlign: "right", color: "#c2570f", fontFamily: "'JetBrains Mono',monospace", fontSize: 11 }}>{st.era || "—"}</td>
                            <td style={{ padding: "5px 6px", textAlign: "right", color: "#0f8a44", fontSize: 11 }}>{st.strikeOuts ?? "—"}</td>
                            <td style={{ padding: "5px 6px", textAlign: "right", color: "#5d6f8b", fontSize: 11 }}>{st.baseOnBalls ?? "—"}</td>
                            <td style={{ padding: "5px 6px", textAlign: "right", color: "#5d6f8b", fontFamily: "'JetBrains Mono',monospace", fontSize: 11 }}>{st.whip || "—"}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                );
              })()}
            </CollapsibleSection>
          )}

          {/* Pitch Analysis — combined pitcher arsenal + batter vs pitch */}
          <CollapsibleSection title={`Pitch Analysis · ${pitcherName?.split(" ").pop() || "Pitcher"}`} accent="#6d4fd0" defaultOpen={false}>
            {(() => {
              const pitcherPitches = matchupPitcherCache[arsenalBatterYear];
              const bvPitch = arsenalBatterCache[arsenalBatterYear];
              // This batter's per-pitch results vs the starter's throwing hand (vs LHP/RHP),
              // aggregated from event-level Statcast (the leaderboard CSV can't split by hand).
              const pHand = pitcherThrows || "R";
              const handArsenal = bvpByHandCache[`${arsenalBatterYear}-${pHand}`]; // "loading" | {} | map
              const yrBtnStyle = (yr) => ({
                fontSize: 9, padding: "2px 7px", borderRadius: 3, cursor: "pointer", fontWeight: 700,
                background: arsenalBatterYear === yr ? "rgba(109,79,208,0.15)" : "transparent",
                color: arsenalBatterYear === yr ? "#6d4fd0" : "#b6c5dc",
                border: arsenalBatterYear === yr ? "1px solid rgba(109,79,208,0.3)" : "1px solid transparent",
              });
              return (
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                    <span style={{ fontSize: 10, color: "#6d4fd0", fontWeight: 700 }}>{pitcherName || "Pitcher"} · Arsenal</span>
                    <div style={{ display: "flex", gap: 3 }}>
                      {[2025, 2026].map(yr => <button key={yr} onClick={() => setArsenalBatterYear(yr)} style={yrBtnStyle(yr)}>{yr}</button>)}
                    </div>
                  </div>
                  {arsenalBatterLoading && !pitcherPitches ? (
                    <Loader text="Loading pitch data..." />
                  ) : !pitcherPitches || !Object.keys(pitcherPitches).length ? (
                    <div style={{ color: "#8b99b0", fontSize: 12, textAlign: "center", padding: "12px 0" }}>No arsenal data available</div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                      {Object.entries(pitcherPitches)
                        .filter(([, p]) => p.usage > 0)
                        .sort((a, b) => b[1].usage - a[1].usage)
                        .map(([code, p]) => {
                          const name = PITCH_LABELS[code] || code;
                          const color = PITCH_COLORS[code] || "#2062c8";
                          const bv = bvPitch?.[code];
                          const hasMatchup = bv && bv.pa >= 5;
                          const xw = bv?.xwoba;
                          const xwColor = xw == null ? "#5d6f8b" : xw >= 0.37 ? "#0f8a44" : xw >= 0.32 ? "#4c5f7d" : "#d03131";
                          const hs = (typeof handArsenal === "object" && handArsenal !== null) ? handArsenal[code] : null;
                          return (
                            <div key={code} style={{ background: "rgba(210,217,236,0.5)", borderRadius: 8, padding: "8px 10px", border: `1px solid ${color}22` }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 4 }}>
                                <span style={{ fontSize: 9, fontWeight: 700, color, background: `${color}18`, padding: "1px 5px", borderRadius: 3 }}>{code}</span>
                                <span style={{ fontSize: 11, fontWeight: 600, color: "#223350", flex: 1 }}>{name}</span>
                                <span style={{ fontSize: 11, fontWeight: 700, color, fontFamily: "'JetBrains Mono',monospace" }}>{p.usage.toFixed(1)}%</span>
                              </div>
                              <div style={{ height: 3, borderRadius: 2, background: "rgba(22,44,80,0.05)", marginBottom: 5 }}>
                                <div style={{ height: "100%", width: `${Math.min(p.usage, 100)}%`, background: color, borderRadius: 2 }} />
                              </div>
                              <div style={{ fontSize: 10, color: "#6d7c96" }}>{p.vel > 0 ? p.vel.toFixed(1) + " mph" : "—"}</div>
                              {/* This batter's per-pitch results vs the starter's hand (vs LHP/RHP) */}
                              {hs && (hs.woba != null || hs.ba != null || hs.whiff > 0) && (
                                <div style={{ marginTop: 5, paddingTop: 5, borderTop: `1px solid ${color}18` }}>
                                  <div style={{ fontSize: 8, color: "#8b99b0", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 3 }}>
                                    vs {pHand}HP {hs.pa ? <span style={{ color: "#64748d" }}> · {hs.pa} PA</span> : null}
                                  </div>
                                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                                    {hs.xwoba != null && <span style={{ fontSize: 11, fontFamily: "'JetBrains Mono',monospace", color: hs.xwoba >= 0.37 ? "#0f8a44" : hs.xwoba >= 0.32 ? "#4c5f7d" : "#d03131", fontWeight: 700 }}>xwOBA {hs.xwoba.toFixed(3)}</span>}
                                    {hs.woba  != null && <span style={{ fontSize: 10, color: "#64748d" }}>wOBA {hs.woba.toFixed(3)}</span>}
                                    {hs.ba    != null && <span style={{ fontSize: 10, color: "#64748d" }}>BA {hs.ba.toFixed(3)}</span>}
                                    {hs.whiff > 0 && <span style={{ fontSize: 10, color: hs.whiff > 35 ? "#d03131" : "#64748d" }}>Whiff {hs.whiff.toFixed(1)}%</span>}
                                  </div>
                                </div>
                              )}
                              {hasMatchup && (
                                <div style={{ marginTop: 5, paddingTop: 5, borderTop: `1px solid ${color}18` }}>
                                  <div style={{ fontSize: 8, color: "#e6def4", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 3 }}>vs This Batter · {bv.pa} PA</div>
                                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                                    {xw != null && <span style={{ fontSize: 11, fontFamily: "'JetBrains Mono',monospace", color: xwColor, fontWeight: 700 }}>xwOBA {xw.toFixed(3)}</span>}
                                    {bv.ba != null && <span style={{ fontSize: 10, color: "#64748d" }}>BA {bv.ba.toFixed(3)}</span>}
                                    {bv.whiff > 0 && <span style={{ fontSize: 10, color: bv.whiff > 35 ? "#d03131" : "#64748d" }}>Whiff {bv.whiff.toFixed(1)}%</span>}
                                    {bv.kPct > 0 && <span style={{ fontSize: 10, color: bv.kPct > 30 ? "#d03131" : "#64748d" }}>K {bv.kPct.toFixed(1)}%</span>}
                                    {bv.hardHit > 0 && <span style={{ fontSize: 10, color: bv.hardHit > 45 ? "#0f8a44" : "#64748d" }}>HH {bv.hardHit.toFixed(1)}%</span>}
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      <div style={{ fontSize: 9, color: "#c9d5e8", textAlign: "right", marginTop: 2 }}>
                        Arsenal: MLB Stats API · vs {pHand}HP + BvP: Savant {arsenalBatterYear}
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}
          </CollapsibleSection>

          {/* BvP */}
          <CollapsibleSection title={`BvP vs ${pitcherName?.split(" ").pop() || "Pitcher"}`} accent="#a16207" defaultOpen={true}>
            {loading ? <Loader text="Loading..." /> : (() => {
              // career = all-time vs this pitcher (vsPlayerTotal), season = current year only (vsPlayer)
              const careerSplits = bvp?.career || [];
              const seasonSplits = bvp?.season || [];
              const cs = careerSplits[0]?.stat || {};
              const ss2 = seasonSplits[0]?.stat || {};
              if (!cs.atBats && !ss2.atBats) return <div style={{ color: "#8b99b0", fontSize: 11, padding: "8px 0", textAlign: "center" }}>No matchup history</div>;
              const bs = cs.atBats ? cs : ss2; // prefer career, fall back to season
              const isCareer = !!cs.atBats;
              return (
                <div>
                  <div style={{ fontSize: 9, color: isCareer ? "#a16207" : "#2062c8", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 8 }}>
                    {isCareer ? `All-Time · ${cs.atBats} AB` : `${season} · ${ss2.atBats} AB`}
                    {isCareer && ss2.atBats > 0 && <span style={{ color: "#8b99b0", fontWeight: 400, marginLeft: 8 }}>({season}: {ss2.atBats} AB, {ss2.avg})</span>}
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 5 }}>
                    {[["PA", bs.plateAppearances ?? "—"],["H", bs.hits ?? "—"],["HR", bs.homeRuns ?? "—"],["K", bs.strikeOuts ?? "—"],["BB", bs.baseOnBalls ?? "—"],["AVG", bs.avg ?? "—"],["OBP", bs.obp ?? "—"],["SLG", bs.slg ?? "—"]].map(([l,v]) => (
                      <div key={l} style={{ background: "rgba(210,217,236,0.5)", borderRadius: 6, padding: "6px 8px", textAlign: "center", border: "1px solid rgba(32,98,200,0.096)" }}>
                        <div style={{ fontSize: 9, color: "#8b99b0", marginBottom: 2 }}>{l}</div>
                        <div style={{ fontSize: 13, fontWeight: 700, color: "#16233c", fontFamily: "'JetBrains Mono',monospace" }}>{v}</div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}
          </CollapsibleSection>

          {/* News (collapsed by default) */}
          <CollapsibleSection title="News" accent="#6d7c96" defaultOpen={false}>
            {newsLoading ? <Loader text="Fetching news..." /> : (!news?.length ? <div style={{ color: "#8b99b0", fontSize: 12, textAlign: "center", padding: "12px 0" }}>No recent news</div> : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {news.slice(0, 5).map((a, i) => (
                  <a key={i} href={a.link || "#"} target="_blank" rel="noopener noreferrer"
                    style={{ display: "block", textDecoration: "none", padding: "8px 10px", borderRadius: 6,
                      background: a.isRotowire ? "rgba(161,98,7,0.06)" : "rgba(210,217,236,0.4)",
                      border: `1px solid ${a.isRotowire ? "rgba(161,98,7,0.2)" : "rgba(32,98,200,0.128)"}` }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: "#223350", lineHeight: 1.3 }}>{a.title}</div>
                    <div style={{ fontSize: 10, color: a.isRotowire ? "#a16207" : "#2062c8", marginTop: 3 }}>{a.source} · {a.pubDate ? _timeAgo(a.pubDate) : ""}</div>
                  </a>
                ))}
              </div>
            ))}
          </CollapsibleSection>

        </div>
      </div>
    );
  }

  return (
    <div style={{
      position: "fixed", top: 0, right: 0, width: "min(640px, 100vw)", height: "100dvh",
      background: "linear-gradient(135deg, #ffffff 0%, #edf2fa 100%)", zIndex: 1000,
      borderLeft: "1px solid rgba(32,98,200,0.2)", overflowY: "auto",
      WebkitOverflowScrolling: "touch", overscrollBehavior: "contain",
      boxShadow: "-20px 0 60px rgba(0,0,0,0.175)", animation: "slideIn 0.25s ease-out",
    }}>
      {/* Header */}
      <div style={{ padding: "16px 20px", borderBottom: "1px solid rgba(32,98,200,0.192)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
          <PlayerHeadshot personId={info.id || batter?.id} size={72} alt={info.fullName || ""} />
          <div>
            <div style={{ fontSize: 11, color: "#2062c8", textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 4 }}>Batter Profile</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: "#16233c", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              {info.fullName || `${info.firstName || ""} ${info.lastName || ""}`}
              <PlayerFlagBadges flags={playerFlags} size={18} />
              <InjuryBadge inj={injury} size={18} />
            </div>
            <div style={{ fontSize: 12, color: "#6d7c96", marginTop: 2 }}>
              {pos} · Bats: {bats} / Throws: {throws} · #{jerseyNum}
            </div>
            <ContractLine playerId={info.id || batter?.id} />
            <InjuryLine inj={injury} />
            {seasonStats && Object.keys(seasonStats).length > 0 ? (
              <div style={{ fontSize: 10, color: "#0f8a44", marginTop: 4, display: "flex", alignItems: "center", gap: 4, fontFamily: "'JetBrains Mono',monospace" }}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#0f8a44", display: "inline-block", flexShrink: 0 }} />
                {seasonStats.avg ? parseFloat(seasonStats.avg).toFixed(3).replace(/^0/, "") : ".000"}
                {" · "}{parseInt(seasonStats.hits) || 0}H/{parseInt(seasonStats.atBats) || 0}AB
                {(parseInt(seasonStats.homeRuns) || 0) > 0 && <span style={{ color: "#a16207", marginLeft: 4 }}>{seasonStats.homeRuns}HR</span>}
                {(parseInt(seasonStats.rbi) || 0) > 0 && <span style={{ marginLeft: 4 }}>{seasonStats.rbi}RBI</span>}
                {(parseInt(seasonStats.stolenBases) || 0) > 0 && <span style={{ color: "#9333ea", marginLeft: 4 }}>{seasonStats.stolenBases}SB</span>}
              </div>
            ) : loading ? null : (
              <div style={{ fontSize: 10, color: "#8b99b0", marginTop: 4 }}>No 2026 stats yet</div>
            )}
            {/* Birthday + hometown info */}
            {bio?.birthDate && (() => {
              const bday = new Date(bio.birthDate + "T12:00:00");
              const age = Math.floor((Date.now() - bday) / (365.25 * 24 * 3600 * 1000));
              const bdayStr = bday.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
              const birthPlace = [bio.birthCity, bio.birthState].filter(Boolean).join(", ");
              return (
                <div style={{ fontSize: 10, color: "#8b99b0", marginTop: 5, display: "flex", gap: 12, flexWrap: "wrap" }}>
                  <span>🎂 {bdayStr} · Age {age}{birthPlace && ` · Born: ${birthPlace}`}</span>
                  {playerFlags.hometown && <span style={{ color: "#0f8a44" }}>👨‍👩‍👧 Playing near hometown</span>}
                  {playerFlags.homeAdvantage && <span style={{ color: "#2569d6" }}>🏠 Performs better at home</span>}
                  {playerFlags.roadAdvantage && <span style={{ color: "#6d4fd0" }}>🥷 Performs better on road</span>}
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

      {/* BvP Quick Look — always shows when a matchup pitcher is set; "—" values when no prior matchup */}
      {!loading && pitcherId && (
        <div style={{ padding: "12px 20px", borderBottom: "1px solid rgba(32,98,200,0.128)", background: "rgba(161,98,7,0.04)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
            <div style={{ fontSize: 10, color: "#a16207", textTransform: "uppercase", letterSpacing: 1 }}>
              vs{" "}
              {onSelectPitcher && pitcherId ? (
                <span
                  onClick={() => onSelectPitcher({
                    pitcher: { id: pitcherId, fullName: pitcherName || "Pitcher", pitchHand: pitcherThrows ? { code: pitcherThrows } : undefined },
                    pitcherTeam: pitcherTeam || null,
                    opponentTeam: batterTeam || null,
                    venueName: venueName || null,
                  })}
                  title="View pitcher panel"
                  style={{ cursor: "pointer", textDecoration: "underline", textDecorationStyle: "dotted", textUnderlineOffset: 2 }}
                >{pitcherName || "Pitcher"}</span>
              ) : (pitcherName || "Pitcher")}
              {" "}(Career)
              {bvp && bvp.career.length === 0 && <span style={{ marginLeft: 6, color: "#6d7c96", fontWeight: 500 }}>· no prior matchup</span>}
            </div>
            {venueName && (
              <div style={{ fontSize: 10, color: "#5d6f8b", display: "flex", alignItems: "center", gap: 4 }}>
                <span>🏟️</span><span>{venueName}</span>
              </div>
            )}
          </div>
          {(() => {
            const cs = bvp?.career?.[0]?.stat || {};
            const has = !!(bvp && bvp.career.length > 0);
            return (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <StatBox label="AB" value={has ? (cs.atBats ?? "—") : "—"} />
                <StatBox label="H" value={has ? (cs.hits ?? "—") : "—"} />
                <StatBox label="HR" value={has ? (cs.homeRuns ?? "—") : "—"} accent={has && (cs.homeRuns||0) > 0 ? "#a16207" : undefined} />
                <StatBox label="AVG" value={has ? fmtAvg(cs.avg) : "—"} />
                <StatBox label="OPS" value={has ? fmtAvg(cs.ops) : "—"} />
                <StatBox label="K" value={has ? (cs.strikeOuts ?? "—") : "—"} />
              </div>
            );
          })()}
        </div>
      )}

      {/* Tabs */}
      <div style={{ padding: "12px 20px 0", display: "flex", gap: 6, borderBottom: "1px solid rgba(32,98,200,0.128)", paddingBottom: 12, flexWrap: "wrap" }}>
        <button onClick={() => setTab("arsenal")} style={tabStyle(tab==="arsenal")}>Arsenal</button>
        <button onClick={() => setTab("bookodds")} style={tabStyle(tab==="bookodds")}>📖 Book Odds</button>
        <button onClick={() => setTab("statcast")} style={tabStyle(tab==="statcast")}>📊 Statcast</button>
        <button onClick={() => setTab("log")} style={tabStyle(tab==="log")}>Game Log</button>
        <button onClick={() => setTab("statsplits")} style={tabStyle(tab==="statsplits")}>Stats & Splits</button>
        <button onClick={() => setTab("spray")} style={tabStyle(tab==="spray")}>Spray Chart</button>
        <button onClick={() => setTab("sb")} style={tabStyle(tab==="sb")}>🏃 Baserunning</button>
        <button onClick={() => setTab("news")} style={{ ...tabStyle(tab==="news"), position: "relative" }}>
          News{newsLoading ? <span style={{ position: "absolute", top: 2, right: 2, width: 5, height: 5, borderRadius: "50%", background: "#2062c8", animation: "pulse 1s infinite" }} /> : news?.length > 0 ? <span style={{ position: "absolute", top: 2, right: 2, width: 5, height: 5, borderRadius: "50%", background: "#0f8a44" }} /> : null}
        </button>
        {pitcherId && <button onClick={() => setTab("bvp")} style={tabStyle(tab==="bvp")}>⚔️ vs Pitcher</button>}
        <button onClick={() => setTab("props")} style={tabStyle(tab==="props")}>Props Analysis</button>
      </div>

      {loading ? <div style={{ padding: 24 }}><Loader text="Loading player data..." /></div> : (
        <div style={{ padding: "12px 20px 40px" }}>
          {/* PROPS TAB */}
          {tab === "props" && models && (<div>
            {/* Park + Weather Info Bar */}
            {park && (
              <div style={{ marginBottom: 14, padding: "10px 14px", background: "rgba(32,98,200,0.096)", borderRadius: 10, border: "1px solid rgba(32,98,200,0.192)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 14 }}>🏟️</span>
                    <span style={{ fontSize: 12, fontWeight: 600, color: "#16233c" }}>{park.name}</span>
                    <span style={{ fontSize: 10, color: "#74839d", fontFamily: "'JetBrains Mono', monospace" }}>
                      {park.dims.LF}-{park.dims.LCF}-{park.dims.CF}-{park.dims.RCF}-{park.dims.RF}
                    </span>
                    {park.elev > 3000 && <span style={{ fontSize: 10, padding: "1px 5px", background: "rgba(161,98,7,0.15)", color: "#a16207", borderRadius: 4 }}>⛰ {park.elev.toLocaleString()}ft</span>}
                    {park.roof !== "open" && <span style={{ fontSize: 10, padding: "1px 5px", background: "rgba(32,98,200,0.24)", color: "#2569d6", borderRadius: 4 }}>{park.roof === "dome" ? "🏛 Dome" : "🔄 Retractable"}</span>}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    {weather?.temp != null && <span style={{ fontSize: 11, color: "#4c5f7d", fontFamily: "'JetBrains Mono', monospace" }}>🌡 {weather.temp}°F</span>}
                    {weather?.windSpeed > 0 && <span style={{ fontSize: 11, color: "#4c5f7d", fontFamily: "'JetBrains Mono', monospace" }}>💨 {weather.windSpeed}mph {weather.windDir}</span>}
                    {weather?.condition && <span style={{ fontSize: 11, color: "#74839d" }}>{weather.condition}</span>}
                    {!weather && <span style={{ fontSize: 10, color: "#8b99b0" }}>Weather: pre-game</span>}
                  </div>
                </div>
                {/* Pull-side analysis */}
                <div style={{ display: "flex", gap: 16, marginTop: 8, flexWrap: "wrap" }}>
                  {(() => {
                    const hand = bats || "R";
                    const pullSide = hand === "L" ? "RF" : "LF";
                    const pullDist = hand === "L" ? park.dims.RF : park.dims.LF;
                    const pullWall = hand === "L" ? park.wall.RF : park.wall.LF;
                    const pullAlley = hand === "L" ? park.dims.RCF : park.dims.LCF;
                    const hrPF = hand === "L" ? park.pf.HR_L : park.pf.HR_R;
                    const pfColor = hrPF >= 1.08 ? "#0f8a44" : hrPF <= 0.92 ? "#d03131" : "#4c5f7d";
                    const pfLabel = hrPF >= 1.08 ? "▲ Hitter-friendly" : hrPF <= 0.92 ? "▼ Pitcher-friendly" : "— Neutral";
                    return (<>
                      <div style={{ fontSize: 10, color: "#74839d" }}>
                        Pull ({pullSide}): <span className="mono" style={{ color: pullDist <= 322 ? "#0f8a44" : pullDist >= 340 ? "#c2570f" : "#4c5f7d" }}>{pullDist}ft</span>
                        {" · "}Wall: <span className="mono">{pullWall}ft</span>
                        {" · "}Alley: <span className="mono">{pullAlley}ft</span>
                      </div>
                      <div style={{ fontSize: 10, color: pfColor, fontWeight: 600 }}>HR PF: {(hrPF * 100).toFixed(0)} {pfLabel}</div>
                      {park.pf["2B"] >= 1.10 && <div style={{ fontSize: 10, color: "#a16207", fontWeight: 600 }}>2B PF: {(park.pf["2B"] * 100).toFixed(0)} ▲ Gap-friendly</div>}
                      {park.pf["3B"] >= 1.10 && <div style={{ fontSize: 10, color: "#9333ea", fontWeight: 600 }}>3B PF: {(park.pf["3B"] * 100).toFixed(0)} ▲ Speed-friendly</div>}
                    </>);
                  })()}
                </div>
              </div>
            )}
            <PropCard title="Hits" emoji="🎯" result={models.hits}>
              <div style={{ paddingTop: 8 }}>
                <ScoreBar label="Baseline" value={models.hits.baseline} color="#2569d6" />
                <ScoreBar label="Recent" value={models.hits.recentAvg} color="#0f8a44" />
                <ScoreBar label="BvP" value={models.hits.bvpW} color="#a16207" />
                <ScoreBar label="Splits" value={models.hits.handednessAvg} color="#9333ea" />
                <ScoreBar label="Pitcher" value={models.hits.pitcherFactor} color="#c2570f" />
                <div style={{ display: "flex", gap: 12, marginTop: 8, flexWrap: "wrap" }}>
                  <MiniStat label="Hit Rate L10" value={(models.hits.recentHitRate*100).toFixed(0)+"%"} accent={models.hits.recentHitRate > 0.7 ? "#0f8a44" : undefined} />
                  <MiniStat label="BvP ABs" value={models.hits.bvpABs} accent={models.hits.bvpABs >= 20 ? "#a16207" : undefined} />
                  <MiniStat label="O/U 0.5" value={models.hits.over05 ? "OVER" : "—"} accent={models.hits.over05 ? "#0f8a44" : "#6d7c96"} />
                  <MiniStat label="O/U 1.5" value={models.hits.over15 ? "OVER" : "—"} accent={models.hits.over15 ? "#0f8a44" : "#6d7c96"} />
                </div>
              </div>
            </PropCard>
            <PropCard title="Home Run" emoji="💣" result={models.hr}>
              <div style={{ paddingTop: 8 }}>
                <ScoreBar label="Baseline" value={models.hr.baseline} max={0.12} color="#2569d6" />
                <ScoreBar label="Recent" value={models.hr.recentHRRate} max={0.12} color="#0f8a44" />
                <ScoreBar label="BvP" value={models.hr.bvpFactor} max={0.12} color="#a16207" />
                <ScoreBar label="Power×" value={models.hr.powerMult} max={1.5} color="#d03131" />
                <div style={{ display: "flex", gap: 12, marginTop: 8, flexWrap: "wrap" }}>
                  <MiniStat label="BvP HR" value={models.hr.bvpHR} accent={models.hr.bvpHR > 0 ? "#a16207" : "#6d7c96"} />
                  <MiniStat label="Dry Spell" value={models.hr.drySpell+"g"} accent={models.hr.drySpell > 5 ? "#c2570f" : undefined} />
                  <MiniStat label="Verdict" value={models.hr.yes ? (models.hr.strong ? "STRONG" : "YES") : "NO"} accent={models.hr.yes ? "#0f8a44" : "#d03131"} />
                </div>
              </div>
            </PropCard>
            {models.single && <PropCard title="Single" emoji="☝️" result={models.single}>
              <div style={{ paddingTop: 8 }}>
                <ScoreBar label="Baseline" value={models.single.baseline} color="#2569d6" />
                <ScoreBar label="Recent" value={models.single.recent1BRate} color="#0f8a44" />
                <ScoreBar label="Contact" value={models.single.contactMatchup} color="#9333ea" />
                <ScoreBar label="Pitcher×" value={models.single.pitcherMult} max={1.5} color="#c2570f" />
                <div style={{ display: "flex", gap: 12, marginTop: 8, flexWrap: "wrap" }}>
                  <MiniStat label="1B/H Ratio" value={(models.single.contactAdj*100).toFixed(0)+"%"} />
                  <MiniStat label="Over 0.5" value={models.single.over05 ? "OVER" : "—"} accent={models.single.over05 ? "#0f8a44" : "#6d7c96"} />
                </div>
              </div>
            </PropCard>}
            {models.double && <PropCard title="Double" emoji="✌️" result={models.double}>
              <div style={{ paddingTop: 8 }}>
                <ScoreBar label="Baseline" value={models.double.baseline} max={0.08} color="#2569d6" />
                <ScoreBar label="Recent" value={models.double.recent2BRate} max={0.08} color="#0f8a44" />
                <ScoreBar label="Power×" value={models.double.powerMult} max={1.5} color="#9333ea" />
                <ScoreBar label="Pitcher×" value={models.double.pitcherMult} max={1.5} color="#c2570f" />
                <div style={{ display: "flex", gap: 12, marginTop: 8, flexWrap: "wrap" }}>
                  <MiniStat label="2B L15" value={models.double.recent2B} accent={models.double.recent2B >= 3 ? "#2569d6" : undefined} />
                  <MiniStat label="Over 0.5" value={models.double.over05 ? "OVER" : "—"} accent={models.double.over05 ? "#0f8a44" : "#6d7c96"} />
                </div>
              </div>
            </PropCard>}
            {models.triple && <PropCard title="Triple" emoji="🏃" result={models.triple}>
              <div style={{ paddingTop: 8 }}>
                {models.triple.skip ? (
                  <div style={{ fontSize: 12, color: "#6b7280", padding: "8px 0" }}>Player projected for {models.triple.projTriples} triples — not a viable triple threat. SKIP.</div>
                ) : (<>
                  <ScoreBar label="Baseline" value={models.triple.baseline} max={0.015} color="#2569d6" />
                  <ScoreBar label="Speed" value={models.triple.speedFactor} max={0.3} color="#6d4fd0" />
                  <MiniStat label="Proj 3B" value={models.triple.projTriples} />
                </>)}
              </div>
            </PropCard>}
            <PropCard title="Stolen Base" emoji="⚡" result={models.sb}>
              <div style={{ paddingTop: 8 }}>
                {models.sb.skip ? (
                  <div style={{ fontSize: 12, color: "#6b7280", padding: "8px 0" }}>Player projected for {models.sb.projSB} SB — not a base-stealing threat. SKIP.</div>
                ) : (<>
                  <ScoreBar label="Baseline" value={models.sb.baseline} max={0.3} color="#2569d6" />
                  <ScoreBar label="Recent" value={models.sb.recentSBRate} max={0.3} color="#0f8a44" />
                  <ScoreBar label="Speed×" value={models.sb.speedMult} max={1.5} color="#c2570f" />
                  <div style={{ display: "flex", gap: 12, marginTop: 8, flexWrap: "wrap" }}>
                    <MiniStat label="Proj SB" value={models.sb.projSB} />
                    <MiniStat label="Recent SB" value={models.sb.recentSB} accent={models.sb.recentSB > 0 ? "#9333ea" : undefined} />
                    <MiniStat label="Over 0.5" value={models.sb.over05 ? "OVER" : "—"} accent={models.sb.over05 ? "#0f8a44" : "#6d7c96"} />
                  </div>
                </>)}
              </div>
            </PropCard>
            {models.rbi && <PropCard title="RBI" emoji="🏅" result={models.rbi}>
              <div style={{ paddingTop: 8 }}>
                <ScoreBar label="Recent RBI/G" value={models.rbi.recentRBIPerGame} max={1.2} color="#0f8a44" />
                <ScoreBar label="Season RBI/G" value={models.rbi.seasonRBIPerGame} max={1.2} color="#2569d6" />
                <ScoreBar label="RISP×" value={models.rbi.rispMult} max={1.5} color="#c2570f" />
                {models.rbi.lineupOpportunityMult != null && (
                  <ScoreBar label="Lineup Opp×" value={models.rbi.lineupOpportunityMult} max={1.5} color="#0a8564" />
                )}
                <ScoreBar label="xwOBA×" value={models.rbi.xwobaMult} max={1.5} color="#9333ea" />
                <ScoreBar label="Contact×" value={models.rbi.contactMult} max={1.5} color="#d03131" />
                <ScoreBar label="Pitcher×" value={models.rbi.pitcherMult} max={1.5} color="#a16207" />
                {models.rbi.impliedRunsMult != null && (
                  <ScoreBar label="Run Env×" value={models.rbi.impliedRunsMult} max={1.3} color="#6d4fd0" />
                )}
                <div style={{ display: "flex", gap: 10, marginTop: 8, flexWrap: "wrap" }}>
                  {models.rbi.rispOPS != null && models.rbi.rispAB >= 8 && (
                    <MiniStat label={`RISP OPS (${models.rbi.rispAB}AB)`}
                      value={models.rbi.rispOPS.toFixed(3)}
                      accent={models.rbi.rispOPS >= 0.800 ? "#0f8a44" : models.rbi.rispOPS >= 0.650 ? "#4c5f7d" : "#d03131"} />
                  )}
                  {models.rbi.rispOpportunityFromPreds != null && (
                    <MiniStat label="RISP Freq×" value={models.rbi.rispOpportunityFromPreds.toFixed(2) + "×"} accent={models.rbi.rispOpportunityFromPreds >= 1.1 ? "#0a8564" : models.rbi.rispOpportunityFromPreds < 0.90 ? "#d03131" : "#6d7c96"} />
                  )}
                  {models.rbi.xwoba != null && (
                    <MiniStat label="xwOBA" value={models.rbi.xwoba.toFixed(3)} accent="#9333ea" />
                  )}
                  {models.rbi.woba != null && (
                    <MiniStat label="wOBA" value={models.rbi.woba.toFixed(3)} accent="#5d6f8b" />
                  )}
                  {models.rbi.barrelRate != null && (
                    <MiniStat label="Barrel%" value={models.rbi.barrelRate.toFixed(1) + "%"} accent={models.rbi.barrelRate >= 10 ? "#c2570f" : "#5d6f8b"} />
                  )}
                  <MiniStat label="HR Boost" value={"+" + (models.rbi.hrContrib * 100).toFixed(0) + "%"} accent="#a16207" />
                  <MiniStat label="Over 0.5" value={models.rbi.over05 ? "OVER" : "—"} accent={models.rbi.over05 ? "#0f8a44" : "#6d7c96"} />
                </div>
              </div>
            </PropCard>}
            <PropCard title="Total Bases" emoji="📊" result={models.tb}>
              <div style={{ paddingTop: 8 }}>
                <ScoreBar label="Baseline" value={models.tb.baseline} max={3} color="#2569d6" />
                <ScoreBar label="Recent" value={models.tb.recentTBAvg} max={3} color="#0f8a44" />
                <ScoreBar label="Power×" value={models.tb.powerMult} max={1.5} color="#d03131" />
                <ScoreBar label="Pitcher×" value={models.tb.pitcherMult} max={1.5} color="#c2570f" />
                <div style={{ display: "flex", gap: 12, marginTop: 8, flexWrap: "wrap" }}>
                  <MiniStat label="Best Line" value={models.tb.bestLine?.line != null ? `O ${models.tb.bestLine.line}` : "—"} accent="#a16207" />
                  <MiniStat label="Prob" value={models.tb.bestLine?.impliedProb != null ? (models.tb.bestLine.impliedProb * 100).toFixed(0) + "%" : "—"} accent="#2062c8" />
                  <MiniStat label="O/U 1.5" value={models.tb.over15 ? "OVER" : "—"} accent={models.tb.over15 ? "#0f8a44" : "#6d7c96"} />
                  <MiniStat label="O/U 2.5" value={models.tb.over25 ? "OVER" : "—"} accent={models.tb.over25 ? "#0f8a44" : "#6d7c96"} />
                  <MiniStat label="O/U 3.5" value={models.tb.over35 ? "OVER" : "—"} accent={models.tb.over35 ? "#0f8a44" : "#6d7c96"} />
                </div>
              </div>
            </PropCard>

            <PropCard title="H+R+RBI" emoji="🔥" result={models.hrr}>
              <div style={{ paddingTop: 8 }}>
                <ScoreBar label="Proj HRR/G" value={models.hrr.projHRR} max={3.5} color="#2569d6" />
                <ScoreBar label="Recent L10" value={models.hrr.recentHRRPG} max={3.5} color="#0f8a44" />
                <ScoreBar label="Season" value={models.hrr.seasonHRRPG || 0} max={3.5} color="#a16207" />
                <ScoreBar label="L10 2+ HRR%" value={models.hrr.recentHRRFreq} max={1} color="#d03131" />
                <ScoreBar label="L10 3+ HRR%" value={models.hrr.recentHRR25Freq} max={1} color="#cf6c1c" />
                <div style={{ display: "flex", gap: 12, marginTop: 8, flexWrap: "wrap" }}>
                  <MiniStat
                    label={models.hrr.o25IsMain ? "Main Line" : "Main Line"}
                    value={models.hrr.bestLine?.line != null ? `O${models.hrr.bestLine.line}` : "—"}
                    accent="#a16207"
                  />
                  <MiniStat
                    label="Main Prob"
                    value={models.hrr.bestLine?.impliedProb != null ? (models.hrr.bestLine.impliedProb * 100).toFixed(0) + "%" : "—"}
                    accent={models.hrr.yes ? "#0f8a44" : "#6d7c96"}
                  />
                  <MiniStat
                    label="Main Fair"
                    value={models.hrr.bestLine?.fairLine != null ? (models.hrr.bestLine.fairLine > 0 ? "+" : "") + models.hrr.bestLine.fairLine : "—"}
                    accent="#4c5f7d"
                  />
                  <MiniStat
                    label={models.hrr.o25IsMain ? "Alt O1.5" : "Alt O2.5"}
                    value={models.hrr.altLine?.impliedProb != null ? (models.hrr.altLine.impliedProb * 100).toFixed(0) + "%" : "—"}
                    accent="#6d7c96"
                  />
                  <MiniStat label="O1.5" value={models.hrr.over15 ? "PICK" : "—"} accent={models.hrr.over15 ? "#0f8a44" : "#6d7c96"} />
                  <MiniStat label="O2.5" value={models.hrr.over25 ? "PICK" : "—"} accent={models.hrr.over25 ? "#cf6c1c" : "#6d7c96"} />
                  <MiniStat label="Pit Mult" value={models.hrr.pitcherMult?.toFixed(2)} accent="#5d6f8b" />
                  <MiniStat label="Pwr Mult" value={models.hrr.powerMult?.toFixed(2)} accent="#5d6f8b" />
                </div>
              </div>
            </PropCard>
          </div>)}

          {/* VS PITCH TYPE moved to Arsenal tab → "vs Pitch Type" subtab */}

          {/* ── STATS & SPLITS TAB ── */}
          {tab === "statsplits" && (
            <div>
              {/* Season Stats section */}
              {(() => {
                const STAT_COLS = ["G","AB","H","2B","3B","HR","RBI","BB","K","SB","CS","AVG","OBP","SLG","OPS"];
                const getVal = (ss, col) => {
                  if (!ss) return null;
                  switch(col) {
                    case "G":   return ss.gamesPlayed ?? null;
                    case "AB":  return ss.atBats ?? null;
                    case "H":   return ss.hits ?? null;
                    case "2B":  return ss.doubles ?? null;
                    case "3B":  return ss.triples ?? null;
                    case "HR":  return ss.homeRuns ?? null;
                    case "RBI": return ss.rbi ?? null;
                    case "BB":  return ss.baseOnBalls ?? null;
                    case "K":   return ss.strikeOuts ?? null;
                    case "SB":  return ss.stolenBases ?? null;
                    case "CS":  return ss.caughtStealing ?? null;
                    case "AVG": return ss.avg ? fmtAvg(ss.avg) : null;
                    case "OBP": return ss.obp ? fmtAvg(ss.obp) : null;
                    case "SLG": return ss.slg ? fmtAvg(ss.slg) : null;
                    case "OPS": return ss.ops ? fmtAvg(ss.ops) : null;
                    default: return null;
                  }
                };
                const cellColor = (ss, col) => {
                  if (!ss) return "#74839d";
                  switch(col) {
                    case "H":   return (ss.hits > 0) ? "#0f8a44" : "#4c5f7d";
                    case "HR":  return (ss.homeRuns > 0) ? "#a16207" : "#4c5f7d";
                    case "3B":  return (ss.triples > 0) ? "#6d4fd0" : "#4c5f7d";
                    case "SB":  return (ss.stolenBases > 0) ? "#9333ea" : "#4c5f7d";
                    case "CS":  return (ss.caughtStealing > 0) ? "#d03131" : "#4c5f7d";
                    case "AVG": return parseFloat(ss.avg) >= 0.300 ? "#0f8a44" : parseFloat(ss.avg) < 0.220 && parseFloat(ss.avg) > 0 ? "#d03131" : "#4c5f7d";
                    case "OPS": return parseFloat(ss.ops) >= 0.900 ? "#0f8a44" : parseFloat(ss.ops) < 0.680 && parseFloat(ss.ops) > 0 ? "#d03131" : "#4c5f7d";
                    default: return "#4c5f7d";
                  }
                };
                return (
                  <div>
                    <div style={{ fontSize: 10, color: "#2062c8", textTransform: "uppercase", letterSpacing: 1.2, fontWeight: 600, marginBottom: 12 }}>Season Stats</div>
                    <div className="hscroll">
                      <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 520 }}>
                        <thead>
                          <tr style={{ borderBottom: "2px solid rgba(32,98,200,0.2)" }}>
                            <th style={{ padding: "6px 8px 6px 4px", textAlign: "left", fontSize: 10, color: "#2062c8", textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 700, whiteSpace: "nowrap" }}>Season</th>
                            {STAT_COLS.map(h => (
                              <th key={h} style={{ padding: "6px 4px", textAlign: "center", fontSize: 9, color: "#74839d", textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 700 }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {[2026, 2025, 2024].map((yr, rowIdx) => {
                            const ss = multiYearStats[yr];
                            const isLoading = ss === undefined;
                            const isEmpty = ss === null || (ss && Object.keys(ss).length === 0);
                            return (
                              <tr key={yr} style={{ borderBottom: "1px solid rgba(32,98,200,0.096)", background: rowIdx === 0 ? "rgba(32,98,200,0.048)" : "transparent" }}>
                                <td style={{ padding: "7px 8px 7px 4px", fontSize: 12, fontWeight: 700, color: rowIdx === 0 ? "#6d4fd0" : "#6d7c96", whiteSpace: "nowrap" }}>{yr}</td>
                                {isLoading ? (
                                  <td colSpan={14} style={{ textAlign: "center", padding: "7px", fontSize: 10, color: "#b6c5dc" }}>Loading…</td>
                                ) : isEmpty ? (
                                  <td colSpan={14} style={{ textAlign: "center", padding: "7px", fontSize: 10, color: "#b6c5dc" }}>No data</td>
                                ) : STAT_COLS.map(col => {
                                  const val = getVal(ss, col);
                                  return (
                                    <td key={col} style={{
                                      padding: "7px 4px", textAlign: "center", fontSize: 11,
                                      fontFamily: "'JetBrains Mono', monospace",
                                      color: cellColor(ss, col),
                                      fontWeight: col === "HR" && (ss?.homeRuns > 0) ? 700 : col === "OPS" && parseFloat(ss?.ops) >= 0.900 ? 700 : 400,
                                    }}>
                                      {val ?? "—"}
                                    </td>
                                  );
                                })}
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })()}

              {/* Splits section — always shown below season stats */}
              {(() => {
                const yr = splitsYear;
                const cachedSplits = splitsCache[yr];
                // Compute aggregated Last 10 stats from current season game log
                const last10Games = (gameLog || []).slice(0, 10);
                const last10Stats = last10Games.length > 0 ? (() => {
                  const totals = {
                    gamesPlayed:    last10Games.length,
                    atBats:         last10Games.reduce((s, g) => s + (g.stat?.atBats || 0), 0),
                    runs:           last10Games.reduce((s, g) => s + (g.stat?.runs || 0), 0),
                    hits:           last10Games.reduce((s, g) => s + (g.stat?.hits || 0), 0),
                    doubles:        last10Games.reduce((s, g) => s + (g.stat?.doubles || 0), 0),
                    triples:        last10Games.reduce((s, g) => s + (g.stat?.triples || 0), 0),
                    homeRuns:       last10Games.reduce((s, g) => s + (g.stat?.homeRuns || 0), 0),
                    rbi:            last10Games.reduce((s, g) => s + (g.stat?.rbi || 0), 0),
                    baseOnBalls:    last10Games.reduce((s, g) => s + (g.stat?.baseOnBalls || 0), 0),
                    hitByPitch:     last10Games.reduce((s, g) => s + (g.stat?.hitByPitch || 0), 0),
                    strikeOuts:     last10Games.reduce((s, g) => s + (g.stat?.strikeOuts || 0), 0),
                    stolenBases:    last10Games.reduce((s, g) => s + (g.stat?.stolenBases || 0), 0),
                    caughtStealing: last10Games.reduce((s, g) => s + (g.stat?.caughtStealing || 0), 0),
                  };
                  if (totals.atBats > 0) {
                    totals.avg = (totals.hits / totals.atBats).toFixed(3);
                    const pa = totals.atBats + totals.baseOnBalls + totals.hitByPitch;
                    totals.obp = pa > 0 ? ((totals.hits + totals.baseOnBalls + totals.hitByPitch) / pa).toFixed(3) : "0";
                    const singles = totals.hits - totals.doubles - totals.triples - totals.homeRuns;
                    const tb = singles + totals.doubles * 2 + totals.triples * 3 + totals.homeRuns * 4;
                    totals.slg = (tb / totals.atBats).toFixed(3);
                    totals.ops = (parseFloat(totals.obp) + parseFloat(totals.slg)).toFixed(3);
                  }
                  return totals;
                })() : null;
                return (
                  <Section title="Splits" accent="#2062c8">
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                      <span style={{ fontSize: 11, color: "#5d6f8b" }}>Season:</span>
                      {[2024, 2025, 2026].map(y => (
                        <button key={y} onClick={() => setSplitsYear(y)} style={{
                          padding: "3px 10px", fontSize: 11, borderRadius: 4, cursor: "pointer",
                          border: yr === y ? "1px solid #2062c8" : "1px solid #c6cdd9",
                          background: yr === y ? "#d7e6fa" : "#e8edf6",
                          color: yr === y ? "#2062c8" : "#5d6f8b", fontWeight: yr === y ? 700 : 400,
                        }}>{y}</button>
                      ))}
                    </div>
                    {cachedSplits === undefined
                      ? <Loader text={`Loading ${yr} splits…`} />
                      : <SplitsTable splits={cachedSplits} overall={last10Stats} overallLabel="Last 10 Games" />}
                  </Section>
                );
              })()}
            </div>
          )}
          {tab === "log" && <Section title="Recent Game Log" accent="#0f8a44"><GameLogTable logs={gameLog} /></Section>}

          {/* ── SB ANALYZER TAB ── */}
          {tab === "sb" && (() => {
            const LEAGUE_SPRINT = 27.0;
            const LEAGUE_POP2B  = 1.93;
            const LEAGUE_EXCH   = 0.646;
            const LEAGUE_ARM    = 79.6;
            const LEAGUE_EST_CS = 0.199;
            const sbModel = models?.sb;
            const ss = seasonStats;
            const sbSeason = ss?.stolenBases ?? null;
            const csSeason = ss?.caughtStealing ?? null;
            const sbPct    = (sbSeason != null && csSeason != null && (sbSeason + csSeason) > 0)
              ? (sbSeason / (sbSeason + csSeason) * 100).toFixed(0) + "%" : "—";
            const recentSB = (gameLog || []).slice(0, 10).reduce((s, g) => s + (g.stat?.stolenBases || 0), 0);

            const spd = sbSprintSpeed;
            const spdLabel = spd == null ? (sbSprintSpeed === undefined ? "Loading…" : "—")
              : spd >= 29 ? "Elite" : spd >= 28 ? "Above Avg" : spd >= 26.5 ? "Average" : spd >= 25 ? "Below Avg" : "Slow";
            const spdColor = spd == null ? "#74839d"
              : spd >= 29 ? "#0f8a44" : spd >= 27.5 ? "#4c5f7d" : spd >= 25.5 ? "#a16207" : "#d03131";

            const cd = sbCatcherData;
            const popColor = !cd?.popTime2b ? "#74839d"
              : cd.popTime2b > 2.05 ? "#0f8a44" : cd.popTime2b > 1.95 ? "#4c5f7d" : cd.popTime2b > 1.88 ? "#a16207" : "#d03131";
            const popLabel = !cd?.popTime2b ? "—"
              : cd.popTime2b > 2.05 ? "Slow" : cd.popTime2b > 1.95 ? "Average" : cd.popTime2b > 1.88 ? "Quick" : "Elite";

            const MetricRow = ({ label, value, sub, color = "#16233c" }) => (
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 14px", borderBottom: "1px solid rgba(32,98,200,0.08)" }}>
                <div>
                  <div style={{ fontSize: 12, color: "#4c5f7d", fontWeight: 600 }}>{label}</div>
                  {sub && <div style={{ fontSize: 10, color: "#8b99b0", marginTop: 2 }}>{sub}</div>}
                </div>
                <div style={{ fontSize: 15, fontWeight: 700, color, fontFamily: "'JetBrains Mono', monospace" }}>{value}</div>
              </div>
            );

            const Badge = ({ text, color, bg }) => (
              <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 4, color, background: bg }}>{text}</span>
            );

            return (
              <div>
                {/* Header */}
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
                  <span style={{ fontSize: 22 }}>🏃</span>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: "#9333ea" }}>Baserunning Analyzer</div>
                    <div style={{ fontSize: 11, color: "#74839d", marginTop: 2 }}>Speed · Baserunning · Catcher Profile · Model Breakdown</div>
                  </div>
                  {sbModel && <div style={{ marginLeft: "auto", textAlign: "right" }}>
                    <div style={{ fontSize: 10, color: "#74839d" }}>Model Score</div>
                    <div style={{ fontSize: 22, fontWeight: 700, color: sbModel.score >= 0.35 ? "#0f8a44" : sbModel.score >= 0.20 ? "#9333ea" : "#4c5f7d", fontFamily: "'JetBrains Mono',monospace" }}>
                      {(sbModel.score * 100).toFixed(0)}%
                    </div>
                  </div>}
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 20 }}>

                  {/* Sprint Speed card */}
                  <div style={{ background: "rgba(210,217,236,0.5)", borderRadius: 10, border: "1px solid rgba(147,51,234,0.15)", overflow: "hidden" }}>
                    <div style={{ padding: "8px 14px", borderBottom: "1px solid rgba(147,51,234,0.1)", display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontSize: 13 }}>⚡</span>
                      <span style={{ fontSize: 10, fontWeight: 700, color: "#9333ea", textTransform: "uppercase", letterSpacing: 1 }}>Sprint Speed</span>
                    </div>
                    <div style={{ padding: "14px" }}>
                      <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
                        <span style={{ fontSize: 32, fontWeight: 700, color: spdColor, fontFamily: "'JetBrains Mono',monospace", lineHeight: 1 }}>
                          {spd != null ? spd.toFixed(1) : (sbSprintSpeed === undefined ? "…" : "—")}
                        </span>
                        {spd != null && <span style={{ fontSize: 11, color: "#74839d", paddingBottom: 4 }}>ft/s</span>}
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8 }}>
                        {spd != null && <Badge text={spdLabel} color={spdColor} bg={`${spdColor}22`} />}
                        <span style={{ fontSize: 10, color: "#b6c5dc" }}>Lgavg {LEAGUE_SPRINT} ft/s</span>
                      </div>
                      {spd != null && (
                        <div style={{ marginTop: 10, height: 4, background: "rgba(22,44,80,0.06)", borderRadius: 2, overflow: "hidden" }}>
                          <div style={{ height: "100%", background: spdColor, borderRadius: 2, width: Math.min(100, Math.max(0, (spd - 23) / (31 - 23) * 100)) + "%" }} />
                        </div>
                      )}
                      {/* Home-to-1B time */}
                      {(sbSprintStats?.hp1b != null) && (
                        <div style={{ marginTop: 10, paddingTop: 8, borderTop: "1px solid rgba(147,51,234,0.08)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <span style={{ fontSize: 10, color: "#74839d" }}>Home → 1B</span>
                          <span style={{ fontSize: 13, fontWeight: 700, color: sbSprintStats.hp1b < 4.2 ? "#0f8a44" : sbSprintStats.hp1b < 4.4 ? "#9333ea" : "#d03131", fontFamily: "'JetBrains Mono',monospace" }}>
                            {sbSprintStats.hp1b.toFixed(2)}s
                          </span>
                        </div>
                      )}
                      {(sbSprintStats?.bolts != null) && (
                        <div style={{ marginTop: 4, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <span style={{ fontSize: 10, color: "#74839d" }}>Bolts (30+ ft/s)</span>
                          <span style={{ fontSize: 13, fontWeight: 700, color: sbSprintStats.bolts > 10 ? "#0f8a44" : "#4c5f7d", fontFamily: "'JetBrains Mono',monospace" }}>
                            {sbSprintStats.bolts}
                          </span>
                        </div>
                      )}
                      {sbSprintStats === undefined && <div style={{ marginTop: 8, fontSize: 10, color: "#b6c5dc" }}>Loading…</div>}
                    </div>
                  </div>

                  {/* Season SB stats card */}
                  <div style={{ background: "rgba(210,217,236,0.5)", borderRadius: 10, border: "1px solid rgba(147,51,234,0.15)", overflow: "hidden" }}>
                    <div style={{ padding: "8px 14px", borderBottom: "1px solid rgba(147,51,234,0.1)", display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontSize: 13 }}>📊</span>
                      <span style={{ fontSize: 10, fontWeight: 700, color: "#9333ea", textTransform: "uppercase", letterSpacing: 1 }}>Season SB Stats</span>
                    </div>
                    <div style={{ padding: "10px 14px" }}>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, textAlign: "center" }}>
                        {[["SB", sbSeason ?? "—", "#9333ea"],["CS", csSeason ?? "—", "#d03131"],["SB%", sbPct, "#4c5f7d"]].map(([l, v, c]) => (
                          <div key={l}>
                            <div style={{ fontSize: 18, fontWeight: 700, color: c, fontFamily: "'JetBrains Mono',monospace" }}>{v}</div>
                            <div style={{ fontSize: 9, color: "#8b99b0", textTransform: "uppercase", letterSpacing: 0.8, marginTop: 2 }}>{l}</div>
                          </div>
                        ))}
                      </div>
                      <div style={{ marginTop: 10, paddingTop: 8, borderTop: "1px solid rgba(32,98,200,0.112)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span style={{ fontSize: 10, color: "#8b99b0" }}>Last 10 games</span>
                        <span style={{ fontSize: 13, fontWeight: 700, color: recentSB > 0 ? "#9333ea" : "#b6c5dc", fontFamily: "'JetBrains Mono',monospace" }}>{recentSB} SB</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Baserunning Metrics — or pitcher running game allowed when batter data is blank */}
                <BaserunningCard
                  baserunningData={baserunningData}
                  oppPitcherRunningGame={oppPitcherRunningGame}
                  oppBullpenHold={oppBullpenHold}
                  pitcherName={pitcherName}
                  pitcherTeam={pitcherTeam}
                />

                {/* Catcher Profile */}
                <div style={{ background: "rgba(210,217,236,0.5)", borderRadius: 10, border: "1px solid rgba(32,98,200,0.16)", overflow: "hidden", marginBottom: 16 }}>
                  <div style={{ padding: "8px 14px", borderBottom: "1px solid rgba(32,98,200,0.128)", display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 13 }}>🎯</span>
                    <span style={{ fontSize: 10, fontWeight: 700, color: "#2569d6", textTransform: "uppercase", letterSpacing: 1 }}>
                      Opposing Catcher — {pitcherTeam || "opp"}
                    </span>
                    {sbCatcherData === undefined && <span style={{ fontSize: 10, color: "#b6c5dc" }}>Loading…</span>}
                  </div>
                  {cd ? (<>
                    <MetricRow
                      label="Pop Time to 2B"
                      sub={`League avg ${LEAGUE_POP2B}s · Lower = harder to steal`}
                      value={cd.popTime2b != null ? cd.popTime2b.toFixed(2) + "s" : "—"}
                      color={popColor}
                    />
                    <MetricRow
                      label="Exchange Time"
                      sub={`Catch-to-throw release · League avg ${LEAGUE_EXCH}s`}
                      value={cd.exchange != null ? cd.exchange.toFixed(2) + "s" : "—"}
                      color={cd.exchange != null ? (cd.exchange < 0.65 ? "#d03131" : cd.exchange < 0.72 ? "#4c5f7d" : "#0f8a44") : "#74839d"}
                    />
                    <MetricRow
                      label="Arm Speed"
                      sub={`Throw velocity to 2B · League avg ${LEAGUE_ARM} mph`}
                      value={cd.armSpeed != null ? cd.armSpeed.toFixed(1) + " mph" : "—"}
                      color={cd.armSpeed != null ? (cd.armSpeed > 87 ? "#d03131" : cd.armSpeed > 82 ? "#4c5f7d" : "#0f8a44") : "#74839d"}
                    />
                    {cd.estCsPct != null && <MetricRow
                      label="Est. CS%"
                      sub={`Controls for runner speed · League avg ${(LEAGUE_EST_CS * 100).toFixed(1)}%`}
                      value={(cd.estCsPct * 100).toFixed(1) + "%"}
                      color={cd.estCsPct > 0.25 ? "#d03131" : cd.estCsPct > 0.20 ? "#4c5f7d" : cd.estCsPct > 0.14 ? "#a16207" : "#0f8a44"}
                    />}
                    {cd.csAboveAvg != null && <MetricRow
                      label="CS Above Avg"
                      sub="Caught stealings added vs avg catcher"
                      value={(cd.csAboveAvg > 0 ? "+" : "") + cd.csAboveAvg.toFixed(2)}
                      color={cd.csAboveAvg > 1.0 ? "#d03131" : cd.csAboveAvg > 0 ? "#4c5f7d" : cd.csAboveAvg > -1.0 ? "#a16207" : "#0f8a44"}
                    />}
                    <div style={{ padding: "8px 14px", display: "flex", alignItems: "center", gap: 8 }}>
                      <Badge text={popLabel} color={popColor} bg={`${popColor}22`} />
                      <span style={{ fontSize: 10, color: "#b6c5dc" }}>{cd.attempts ?? "—"} SBA attempts this season</span>
                    </div>
                  </>) : (sbCatcherData === null ? (
                    <div style={{ padding: "14px", fontSize: 11, color: "#b6c5dc", textAlign: "center" }}>No catcher data available for {pitcherTeam}</div>
                  ) : (
                    <div style={{ padding: "14px" }}><Loader text="Loading catcher data…" /></div>
                  ))}
                </div>

                {/* Model breakdown */}
                {sbModel && (
                  <div style={{ background: "rgba(210,217,236,0.5)", borderRadius: 10, border: "1px solid rgba(147,51,234,0.1)", overflow: "hidden" }}>
                    <div style={{ padding: "8px 14px", borderBottom: "1px solid rgba(147,51,234,0.08)", display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontSize: 13 }}>🧠</span>
                      <span style={{ fontSize: 10, fontWeight: 700, color: "#9333ea", textTransform: "uppercase", letterSpacing: 1 }}>Model Inputs</span>
                    </div>
                    <div style={{ padding: "10px 0" }}>
                      <MetricRow label="SB Model Score" value={(sbModel.score * 100).toFixed(0) + "%"} sub="Raw composite probability (pre-line)" color={sbModel.score >= 0.35 ? "#0f8a44" : sbModel.score >= 0.20 ? "#9333ea" : "#4c5f7d"} />
                      {sbModel.label && <MetricRow label="Model Label" value={sbModel.label} sub="" color="#4c5f7d" />}
                      <MetricRow label="Speed Multiplier" value={spd != null ? (0.65 + (spd - 24.0) / (30.5 - 24.0) * 0.75).toFixed(2) + "×" : "—"} sub="Applied to base SB rate" color="#9333ea" />
                      {cd?.popTime2b != null && <MetricRow label="Catcher Multiplier" value={(() => { let m = 1.0; m += (cd.popTime2b - LEAGUE_POP2B) / LEAGUE_POP2B * 1.4; if (cd.exchange != null) m += (cd.exchange - LEAGUE_EXCH) / LEAGUE_EXCH * 0.6; if (cd.armSpeed != null) m += (LEAGUE_ARM - cd.armSpeed) / LEAGUE_ARM * 0.4; if (cd.estCsPct != null) m -= (cd.estCsPct - LEAGUE_EST_CS) / LEAGUE_EST_CS * 0.3; return Math.min(1.20, Math.max(0.80, m)).toFixed(2) + "×"; })()} sub="Higher = easier to steal" color={popColor} />}
                    </div>
                  </div>
                )}
              </div>
            );
          })()}

          {/* ── VS PITCHER TAB ── */}
          {tab === "bvp" && (() => {
            const activeTeam = bvpTeamAbbr || pitcherTeam || "";
            const isAltTeam  = !!(bvpTeamAbbr && bvpTeamAbbr !== pitcherTeam);
            const roster     = (isAltTeam ? bvpAltTeamRoster : oppPitcherRoster) || [];
            const rosterLoading = isAltTeam ? bvpAltTeamRoster === null : oppPitcherRoster === null;
            const batterLast = batter.fullName?.split(" ").slice(1).join(" ") || batter.fullName || "Batter";

            // Sorted team list for the toggle dropdown (today's opponent first)
            const allTeams = Object.keys(MLB_TEAM_IDS).filter(k => k !== "ATH").sort();
            const orderedTeams = pitcherTeam
              ? [pitcherTeam, ...allTeams.filter(t => t !== pitcherTeam)]
              : allTeams;

            const statCols = [
              { key: "atBats",      label: "AB",  color: () => "#74839d" },
              { key: "hits",        label: "H",   color: v => v > 0 ? "#0f8a44" : "#b6c5dc" },
              { key: "homeRuns",    label: "HR",  color: v => v > 0 ? "#c2570f" : "#b6c5dc" },
              { key: "rbi",         label: "RBI", color: () => "#4c5f7d" },
              { key: "baseOnBalls", label: "BB",  color: () => "#4c5f7d" },
              { key: "strikeOuts",  label: "K",   color: v => v > 4 ? "#d03131" : "#4c5f7d" },
              { key: "avg",         label: "AVG", color: v => { const f=parseFloat(v); return f>=.300?"#0f8a44":f<=.200?"#d03131":"#4c5f7d"; }, fmt: fmtAvg },
              { key: "obp",         label: "OBP", color: () => "#4c5f7d", fmt: fmtAvg },
              { key: "ops",         label: "OPS", color: v => { const f=parseFloat(v); return f>=.900?"#0f8a44":f<.600?"#d03131":"#4c5f7d"; }, fmt: fmtAvg },
            ];
            const gridCols = `18px 1fr ${statCols.map(() => "32px").join(" ")}`;

            const handleBvpSort = col => {
              if (bvpSortCol === col) setBvpSortDir(d => d === "desc" ? "asc" : "desc");
              else { setBvpSortCol(col); setBvpSortDir("desc"); }
            };

            // Sort roster by stat column (or by name when col=null)
            const getStat = (p, key) => {
              const pid = String(p.person?.id || "");
              const entry = pid ? bvpAltCache[pid] : undefined;
              if (!entry || entry === "loading") return -1;
              const cs = entry?.career?.[0]?.stat || {};
              const raw = cs[key];
              return raw != null ? (typeof raw === "string" ? parseFloat(raw) || 0 : raw) : -1;
            };
            const sortedRoster = bvpSortCol == null
              ? roster
              : [...roster].sort((a, b) => {
                  const av = getStat(a, bvpSortCol);
                  const bv = getStat(b, bvpSortCol);
                  return bvpSortDir === "desc" ? bv - av : av - bv;
                });

            // Aggregate totals row
            let totAB=0,totH=0,totHR=0,totRBI=0,totBB=0,totK=0;
            let totWithData = 0;
            for (const p of roster) {
              const pid = String(p.person?.id || "");
              const entry = pid ? bvpAltCache[pid] : undefined;
              const cs = (entry && entry !== "loading") ? (entry?.career?.[0]?.stat || {}) : {};
              if (cs.atBats) {
                totAB  += cs.atBats || 0;
                totH   += cs.hits || 0;
                totHR  += cs.homeRuns || 0;
                totRBI += cs.rbi || 0;
                totBB  += cs.baseOnBalls || 0;
                totK   += cs.strikeOuts || 0;
                totWithData++;
              }
            }
            const totAVG = totAB > 0 ? fmtAvg(totH / totAB) : null;

            return (
              <div>
                {/* Header */}
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                  <span style={{ fontSize: 20 }}>⚔️</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: "#a16207" }}>
                      {batterLast} vs {activeTeam} Pitchers
                    </div>
                    <div style={{ fontSize: 11, color: "#74839d", marginTop: 2 }}>Career stats · ⭐ = today's probable starter</div>
                  </div>
                  {/* Team toggle */}
                  <select
                    value={activeTeam}
                    onChange={e => setBvpTeamAbbr(e.target.value === pitcherTeam ? null : e.target.value)}
                    style={{
                      background: "#edf2fa", border: "1px solid rgba(161,98,7,0.3)",
                      color: isAltTeam ? "#a16207" : "#5d6f8b",
                      borderRadius: 8, padding: "4px 8px", fontSize: 10, fontWeight: 600,
                      cursor: "pointer", outline: "none",
                    }}>
                    {orderedTeams.map(t => (
                      <option key={t} value={t}>
                        {t === pitcherTeam ? `★ ${t} (today)` : t}
                      </option>
                    ))}
                  </select>
                </div>

                {rosterLoading ? (
                  <div style={{ padding: "30px 0" }}><Loader text={`Loading ${activeTeam} pitchers…`} /></div>
                ) : roster.length === 0 ? (
                  <div style={{ padding: "30px 0", textAlign: "center", fontSize: 12, color: "#b6c5dc" }}>No pitcher roster found for {activeTeam}</div>
                ) : (
                  <div style={{ background: "rgba(210,217,236,0.5)", borderRadius: 10, border: "1px solid rgba(161,98,7,0.12)", overflow: "hidden" }}>
                    {/* Column header */}
                    <div style={{ display: "grid", gridTemplateColumns: gridCols,
                      padding: "6px 12px", borderBottom: "1px solid rgba(161,98,7,0.15)",
                      background: "rgba(161,98,7,0.04)", gap: 4, alignItems: "center" }}>
                      <span />
                      <span style={{ fontSize: 8, color: "#74839d", fontWeight: 700 }}>PITCHER</span>
                      {statCols.map(c => {
                        const active = bvpSortCol === c.key;
                        return (
                          <span key={c.key} onClick={() => handleBvpSort(c.key)}
                            style={{ fontSize: 8, fontWeight: 700, textAlign: "right", cursor: "pointer",
                              userSelect: "none",
                              color: active ? "#2062c8" : c.key === "avg" || c.key === "ops" ? "#a16207" : "#74839d" }}>
                            {c.label}{active ? (bvpSortDir === "desc" ? "↓" : "↑") : ""}
                          </span>
                        );
                      })}
                    </div>
                    {/* Pitcher rows */}
                    {sortedRoster.map((p, i) => {
                      const pid      = String(p.person?.id || "");
                      const fullName = p.person?.fullName || "—";
                      const throws   = p.person?.pitchHand?.code || p.pitchHand?.code || "";
                      const throwColor = throws === "L" ? "#2569d6" : throws === "S" ? "#6d4fd0" : "#74839d";
                      const isStarter = String(p.person?.id) === String(pitcherId) && !isAltTeam;
                      const entry    = pid ? bvpAltCache[pid] : undefined;
                      const isLoading = entry === "loading";
                      const cs = (entry && entry !== "loading") ? (entry?.career?.[0]?.stat || {}) : {};
                      const hasStats = !!cs.atBats;
                      const lastIdx = sortedRoster.length - 1;
                      return (
                        <div key={pid || i} style={{
                          display: "grid", gridTemplateColumns: gridCols,
                          padding: "7px 12px", gap: 4, alignItems: "center",
                          borderBottom: i < lastIdx ? "1px solid rgba(32,98,200,0.064)" : "none",
                          background: isStarter
                            ? "rgba(161,98,7,0.04)"
                            : i % 2 === 0 ? "transparent" : "rgba(32,98,200,0.024)",
                        }}
                          onMouseEnter={e => e.currentTarget.style.background = "rgba(161,98,7,0.06)"}
                          onMouseLeave={e => e.currentTarget.style.background = isStarter ? "rgba(161,98,7,0.04)" : i % 2 === 0 ? "transparent" : "rgba(32,98,200,0.024)"}>
                          {/* ⭐ for probable starter */}
                          <span style={{ fontSize: 9, textAlign: "center" }}>
                            {isStarter ? "⭐" : ""}
                          </span>
                          <span style={{
                            fontSize: 12, fontWeight: isStarter ? 700 : 500,
                            color: isStarter ? "#a16207" : "#223350",
                            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                            display: "flex", alignItems: "center", gap: 4,
                          }}>
                            {fullName}
                            {throws && <span style={{ fontSize: 9, fontWeight: 700, color: throwColor, flexShrink: 0 }}>({throws})</span>}
                          </span>
                          {statCols.map(col => {
                            let raw = cs[col.key];
                            const val = col.fmt ? (raw != null ? col.fmt(raw) : null) : raw;
                            const color = hasStats && val != null ? col.color(val) : "#c9d5e8";
                            return (
                              <span key={col.key} style={{
                                fontSize: 10, textAlign: "right",
                                fontFamily: "'JetBrains Mono',monospace",
                                color,
                                fontWeight: col.key === "avg" || col.key === "ops" ? 700 : 400,
                              }}>
                                {isLoading ? <span style={{ color: "#c9d5e8" }}>…</span> : (hasStats && val != null ? val : "—")}
                              </span>
                            );
                          })}
                        </div>
                      );
                    })}
                    {/* Totals footer */}
                    {totWithData > 0 && (
                      <div style={{ display: "grid", gridTemplateColumns: gridCols,
                        padding: "7px 12px", gap: 4, alignItems: "center",
                        borderTop: "1px solid rgba(161,98,7,0.15)",
                        background: "rgba(161,98,7,0.03)" }}>
                        <span />
                        <span style={{ fontSize: 10, fontWeight: 700, color: "#a16207" }}>TOTALS</span>
                        {statCols.map(col => {
                          let val;
                          if (col.key === "atBats")      val = totAB;
                          else if (col.key === "hits")   val = totH;
                          else if (col.key === "homeRuns") val = totHR;
                          else if (col.key === "rbi")    val = totRBI;
                          else if (col.key === "baseOnBalls") val = totBB;
                          else if (col.key === "strikeOuts")  val = totK;
                          else if (col.key === "avg")    val = totAVG;
                          else val = null;
                          const color = col.key === "avg" && totAVG
                            ? col.color(totAVG)
                            : "#4c5f7d";
                          return (
                            <span key={col.key} style={{
                              fontSize: 10, textAlign: "right",
                              fontFamily: "'JetBrains Mono',monospace",
                              color, fontWeight: col.key === "avg" ? 700 : 600,
                            }}>
                              {val ?? "—"}
                            </span>
                          );
                        })}
                      </div>
                    )}
                    <div style={{ padding: "6px 12px", borderTop: "1px solid rgba(161,98,7,0.08)", display: "flex", justifyContent: "space-between" }}>
                      <span style={{ fontSize: 9, color: "#c9d5e8" }}>Career totals only</span>
                      <span style={{ fontSize: 9, color: "#c9d5e8" }}>{totWithData} / {roster.length} with career data</span>
                    </div>
                  </div>
                )}
              </div>
            );
          })()}

          {/* ── BOOK ODDS TAB ── */}
          {tab === "bookodds" && (() => {
            const BOOKS = ["fanduel","draftkings","hardrockbet"];
            const MARKET_GROUPS = [
              { label: "H+R+RBI",    std: "batter_hits_runs_rbis", alt: "batter_hits_runs_rbis_alternate" },
              { label: "Home Run",    std: "batter_home_runs",      alt: "batter_home_runs_alternate" },
              { label: "Hits",        std: "batter_hits",           alt: "batter_hits_alternate" },
              { label: "Total Bases", std: "batter_total_bases",    alt: "batter_total_bases_alternate" },
              { label: "Stolen Base", std: "batter_stolen_bases",   alt: "batter_stolen_bases_alternate" },
              { label: "RBI",         std: "batter_rbis",           alt: "batter_rbis_alternate" },
            ];
            const nn = _normPropName(batter?.fullName || batter?.name || "");
            const pd = propOddsMap?.[nn] || {};

            // Build rows: for each group, collect all lines across std+alt markets
            const rows = [];
            for (const grp of MARKET_GROUPS) {
              const lineMap = {}; // line → { fanduel, draftkings, hardrockbet, isAlt }
              for (const [mk, isAlt] of [[grp.std, false], [grp.alt, true]]) {
                if (!mk) continue;
                for (const [line, books] of Object.entries(pd[mk] || {})) {
                  if (!lineMap[line]) lineMap[line] = { isAlt };
                  for (const bk of BOOKS) {
                    if (books[bk]?.price != null) lineMap[line][bk] = { price: books[bk].price, link: books[bk].link, sid: books[bk].sid };
                  }
                }
              }
              const sortedLines = Object.keys(lineMap).map(Number).sort((a,b) => a-b);
              if (sortedLines.length === 0) continue;
              rows.push({ grp, sortedLines, lineMap });
            }

            if (rows.length === 0) return (
              <div style={{ padding: "40px 0", textAlign: "center", color: "#8b99b0", fontSize: 13 }}>
                No odds available — click <strong>Odds</strong> to fetch live lines
              </div>
            );

            return (
              <div>
                <div style={{ fontSize: 11, color: "#8b99b0", marginBottom: 16 }}>
                  All available lines from all books for this player. Click an odds number to share the betslip link.
                </div>
                {rows.map(({ grp, sortedLines, lineMap }) => (
                  <div key={grp.label} style={{ marginBottom: 20 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "#4c5f7d", textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>{grp.label}</div>
                    <div style={{ background: "rgba(210,217,236,0.5)", borderRadius: 8, border: "1px solid rgba(32,98,200,0.128)", overflow: "hidden" }}>
                      {/* Header */}
                      <div style={{ display: "grid", gridTemplateColumns: "60px 1fr 1fr 1fr 52px", gap: 0, borderBottom: "1px solid rgba(32,98,200,0.128)", padding: "6px 12px" }}>
                        <span style={{ fontSize: 10, color: "#8b99b0", fontWeight: 700 }}>LINE</span>
                        {BOOKS.map(bk => (
                          <span key={bk} style={{ fontSize: 10, fontWeight: 700, color: BOOK_COLORS[bk], textAlign: "right" }}>{BOOK_ABBR[bk]}</span>
                        ))}
                        <span style={{ fontSize: 10, fontWeight: 700, color: "#8b2fc9", textAlign: "right" }}>EV</span>
                      </div>
                      {/* Rows */}
                      {sortedLines.map(line => {
                        const entry = lineMap[line];
                        const allPrices = BOOKS.map(bk => entry[bk]?.price).filter(p => p != null);
                        const bestPrice = allPrices.length > 0 ? Math.max(...allPrices) : null;
                        // Market-consensus EV: average book implied → de-vig → compare vs best price
                        const toImpl = p => p > 0 ? 100/(p+100) : Math.abs(p)/(Math.abs(p)+100);
                        const avgImpl = allPrices.length ? allPrices.reduce((s,p) => s + toImpl(p), 0) / allPrices.length : null;
                        const fairProb = avgImpl ? avgImpl / 1.045 : null; // strip ~4.5% average vig
                        const rowEV = fairProb != null && bestPrice != null ? calcEVFromOdds(fairProb, bestPrice) : null;
                        return (
                          <div key={line} style={{ display: "grid", gridTemplateColumns: "60px 1fr 1fr 1fr 52px", gap: 0, padding: "7px 12px", borderBottom: "1px solid rgba(32,98,200,0.064)", alignItems: "center" }}
                            onMouseEnter={e => e.currentTarget.style.background = "rgba(32,98,200,0.064)"}
                            onMouseLeave={e => e.currentTarget.style.background = ""}>
                            <span style={{ fontSize: 12, fontWeight: 700, fontFamily: "'JetBrains Mono',monospace", color: "#a16207" }}>O{line}</span>
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
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            );
          })()}

          {/* ── ZONES MATCHUP TAB ── */}
          {tab === "zones" && (() => {
            const selPid = String(bvpPitcherSelect ?? pitcherId ?? "");
            const rawLocs = pitchLocCache[selPid];
            const pitchLocs = (rawLocs && rawLocs !== "loading") ? rawLocs : null;
            const locLoading = rawLocs === "loading";
            const hasHotData = hotZones && Object.keys(hotZones).length > 0;
            const hasPitchData = pitchLocs && Object.keys(pitchLocs).length > 0;

            return (
              <div>
                <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:14 }}>
                  <span style={{ fontSize:22 }}>🎯</span>
                  <div>
                    <div style={{ fontSize:14, fontWeight:700, color:"#16233c" }}>Zones &amp; Pitch Movement</div>
                    <div style={{ fontSize:11, color:"#74839d", marginTop:1 }}>
                      Strike zone grid · pitcher movement profile
                    </div>
                  </div>
                </div>

                {/* Two-column layout: zone grid | pitch movement */}
                <div style={{ display:"flex", gap:20, alignItems:"flex-start", flexWrap:"wrap" }}>
                  {/* Left: Strike zone grid */}
                  <div>
                    <div style={{ fontSize:10, color:"#8b99b0", fontWeight:700, textTransform:"uppercase", letterSpacing:0.8, marginBottom:6 }}>
                      {hasHotData ? "Hot Zone Grid" : "Strike Zone"} · {batter.fullName?.split(" ").pop()}
                    </div>
                    {hotZones === null ? (
                      <div style={{ width:210, height:255, display:"flex", alignItems:"center", justifyContent:"center",
                        background:"rgba(222,226,241,0.95)", borderRadius:6 }}>
                        <Loader text="Loading zones…" />
                      </div>
                    ) : (
                      <MatchupZoneChart
                        hotZones={hotZones}
                        pitchLocations={{}}
                        arsenalData={{}}
                        metric={zoneMetric}
                        overlay={false}
                        activePitchTypes={new Set()}
                        batterHand={bats}
                      />
                    )}
                    {/* OPS / AVG toggle only shown when zone data exists */}
                    {hasHotData && (
                      <div style={{ display:"flex", justifyContent:"center", marginTop:6 }}>
                        <div style={{ display:"flex", background:"rgba(210,217,236,0.6)", borderRadius:6, border:"1px solid rgba(32,98,200,0.192)", overflow:"hidden" }}>
                          {["ops","avg"].map(m => (
                            <button key={m} onClick={() => setZoneMetric(m)} style={{
                              padding:"3px 12px", fontSize:10, fontWeight:700, cursor:"pointer", border:"none",
                              background: zoneMetric===m ? "rgba(32,98,200,0.2)" : "transparent",
                              color: zoneMetric===m ? "#2062c8" : "#8b99b0",
                            }}>{m.toUpperCase()}</button>
                          ))}
                        </div>
                      </div>
                    )}
                    {/* Zone color legend */}
                    {hasHotData && (
                      <div style={{ marginTop:8 }}>
                        {[
                          { color:"rgba(200,20,20,0.85)", label: zoneMetric==="ops" ? "≥1.000 Scorching" : "≥.320 Hot" },
                          { color:"rgba(182,126,32,0.85)", label: zoneMetric==="ops" ? ".820–1.000" : ".260–.320" },
                          { color:"rgba(41,102,174,0.85)", label: zoneMetric==="ops" ? ".600–.820" : ".170–.260" },
                          { color:"rgba(20,60,160,0.85)",  label: zoneMetric==="ops" ? "< .600 Cold" : "< .170 Cold" },
                        ].map(({ color, label }) => (
                          <div key={label} style={{ display:"flex", alignItems:"center", gap:5, marginBottom:2 }}>
                            <div style={{ width:12, height:8, background:color, borderRadius:2, flexShrink:0 }} />
                            <span style={{ fontSize:9, color:"#6d7c96" }}>{label}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Right: Pitch Movement Chart */}
                  <div style={{ flex:1, minWidth:220 }}>
                    <div style={{ fontSize:10, color:"#c2570f", fontWeight:700, textTransform:"uppercase", letterSpacing:0.8, marginBottom:6 }}>
                      {pitcherName || "Pitcher"} · Pitch Movement
                    </div>
                    {locLoading ? (
                      <div style={{ width:280, height:280, display:"flex", alignItems:"center", justifyContent:"center",
                        background:"rgba(222,226,241,0.95)", borderRadius:6 }}>
                        <Loader text="Loading…" />
                      </div>
                    ) : (
                      <PitchMovementChart pitchLocs={pitchLocs} width={280} height={280} />
                    )}
                    {/* Pitch breakdown table replaces old legend */}
                    {hasPitchData && (
                      <PitchBreakdownTable pitchLocs={pitchLocs} compact={true} />
                    )}
                    {!pitcherId && !selPid && (
                      <div style={{ fontSize:10, color:"#b6c5dc", marginTop:8 }}>No pitcher selected for this game.</div>
                    )}
                  </div>
                </div>

                {/* Pitcher selector */}
                {pitcherTeam && (
                  <div style={{ marginTop:14, padding:"10px 12px", background:"rgba(210,217,236,0.5)", borderRadius:8, border:"1px solid rgba(32,98,200,0.16)" }}>
                    <div style={{ fontSize:10, color:"#8b99b0", marginBottom:6, textTransform:"uppercase", letterSpacing:0.8 }}>
                      View pitcher movement:
                    </div>
                    <div style={{ display:"flex", flexWrap:"wrap", gap:5 }}>
                      {pitcherId && (
                        <button onClick={() => { setBvpPitcherSelect(null); setZoneActivePitches(null); }} style={{
                          padding:"3px 10px", fontSize:11, borderRadius:16, cursor:"pointer", fontWeight:700,
                          background: bvpPitcherSelect === null ? "rgba(32,98,200,0.18)" : "rgba(210,217,236,0.5)",
                          color: bvpPitcherSelect === null ? "#2062c8" : "#8b99b0",
                          border: bvpPitcherSelect === null ? "1px solid rgba(32,98,200,0.4)" : "1px solid rgba(32,98,200,0.16)",
                        }}>⭐ {pitcherName || "Starter"}</button>
                      )}
                      {(oppPitcherRoster || []).filter(p => String(p.person?.id) !== String(pitcherId)).map(p => {
                        const pid2 = String(p.person?.id);
                        const isSel = bvpPitcherSelect === pid2;
                        return (
                          <button key={pid2} onClick={() => { setBvpPitcherSelect(pid2); setZoneActivePitches(null); }} style={{
                            padding:"3px 10px", fontSize:11, borderRadius:16, cursor:"pointer",
                            background: isSel ? "rgba(32,98,200,0.18)" : "rgba(210,217,236,0.5)",
                            color: isSel ? "#2062c8" : "#8b99b0",
                            border: isSel ? "1px solid rgba(32,98,200,0.35)" : "1px solid rgba(32,98,200,0.128)",
                          }}>{p.person?.fullName?.split(" ").slice(1).join(" ") || p.person?.fullName}</button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            );
          })()}

          {/* ── STATCAST PERCENTILE TAB ── */}
          {tab === "statcast" && (() => {
            const isLoading = statcastPct === null;
            const hasPct = statcastPct && Object.keys(statcastPct).length > 0;
            return (
              <div>
                <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:16 }}>
                  <span style={{ fontSize:22 }}>📊</span>
                  <div>
                    <div style={{ fontSize:14, fontWeight:700, color:"#16233c" }}>Statcast Rankings</div>
                    <div style={{ fontSize:11, color:"#74839d", marginTop:1 }}>
                      Percentile vs all MLB batters · Baseball Savant
                    </div>
                  </div>
                </div>
                {(statcastPct === undefined || isLoading) ? (
                  <div style={{ padding:32, textAlign:"center" }}>
                    <Loader text="Loading Statcast data…" />
                  </div>
                ) : !hasPct ? (
                  <div style={{ padding:24, textAlign:"center", color:"#b6c5dc", fontSize:12 }}>
                    <div style={{ fontSize:32, marginBottom:8 }}>📊</div>
                    <div>No Statcast percentile data found for this player.</div>
                    <div style={{ fontSize:10, color:"#c9d5e8", marginTop:4 }}>
                      Requires 2+ PA to appear in Savant leaderboard. Showing {parseInt(season)-1} data if early season.
                    </div>
                  </div>
                ) : (
                  <div style={{ maxWidth:460 }}>
                    <StatcastCard percentiles={statcastPct} powerStats={statcastPower} playerName={batter.fullName} hintsEnabled={sabHints} recent={recentWindow} league={leagueDist} />
                  </div>
                )}

                {/* ── Expected Stats Luck Signal ── */}
                {expectedStats && (() => {
                  const es = expectedStats;
                  const fmtAvgStat = v => v != null ? "." + Math.round(v * 1000).toString().padStart(3, "0") : "—";
                  const diffColor = (d) => d == null ? "#5d6f8b" : d > 0.020 ? "#0f8a44" : d < -0.020 ? "#d03131" : "#a16207";
                  const diffLabel = (d) => d == null ? "—" : (d > 0 ? "+" : "") + (d * 1000).toFixed(0) + " pts";
                  return (
                    <div style={{ marginTop:16, padding:"14px 16px", background:"rgba(210,217,236,0.6)", borderRadius:10, border:"1px solid rgba(15,138,68,0.12)" }}>
                      <div style={{ fontSize:10, fontWeight:700, color:"#0f8a44", textTransform:"uppercase", letterSpacing:1, marginBottom:12, display:"flex", alignItems:"center", gap:6 }}>
                        <span>🎯</span> Expected Stats · Luck Signal
                        <span style={{ fontSize:9, color:"#b6c5dc", fontWeight:400, textTransform:"none", marginLeft:4 }}>
                          {es.pa} PA · xStat − Actual (positive = due for more)
                        </span>
                      </div>
                      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8 }}>
                        {[
                          { label:"BA / xBA",   actual: es.ba,    xval: es.xba,    diff: es.xbaDiff,   hint:"If xBA >> BA, batter is getting unlucky on contact — positive regression expected." },
                          { label:"SLG / xSLG", actual: es.slg,   xval: es.xslg,   diff: es.xslgDiff,  hint:"xSLG removes luck from extra-base hits. Large positive diff = underperforming power." },
                          { label:"wOBA / xwOBA",actual: es.woba,  xval: es.xwoba,  diff: es.xwobaDiff, hint:"Best all-in-one luck signal. Positive = batter is underperforming contact quality." },
                        ].map(({ label, actual, xval, diff, hint }) => (
                          <div key={label} title={sabHints ? hint : undefined} style={{ padding:"8px 10px", background:"rgba(15,138,68,0.04)", borderRadius:6, border:"1px solid rgba(15,138,68,0.08)" }}>
                            <div style={{ fontSize:9, color:"#8b99b0", textTransform:"uppercase", letterSpacing:0.6, marginBottom:5 }}>{label}</div>
                            <div style={{ display:"flex", justifyContent:"space-between", marginBottom:3 }}>
                              <span style={{ fontSize:9, color:"#74839d" }}>Act</span>
                              <span style={{ fontSize:11, fontWeight:600, color:"#3c4f6d", fontFamily:"'JetBrains Mono',monospace" }}>{fmtAvgStat(actual)}</span>
                            </div>
                            <div style={{ display:"flex", justifyContent:"space-between", marginBottom:5 }}>
                              <span style={{ fontSize:9, color:"#74839d" }}>xVal</span>
                              <span style={{ fontSize:11, fontWeight:600, color:"#4c5f7d", fontFamily:"'JetBrains Mono',monospace" }}>{fmtAvgStat(xval)}</span>
                            </div>
                            <div style={{ height:1, background:"rgba(32,98,200,0.128)", marginBottom:5 }} />
                            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                              <span style={{ fontSize:9, color:"#8b99b0" }}>Diff</span>
                              <span style={{ fontSize:12, fontWeight:800, color:diffColor(diff), fontFamily:"'JetBrains Mono',monospace" }}>{diffLabel(diff)}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}

                {/* ── Batted Ball Profile ── */}
                {battedBall && (() => {
                  const bb = battedBall;
                  const pct = v => v != null ? (v * 100).toFixed(1) + "%" : "—";
                  const barColor = (v, low, hi) => v == null ? "#b6c5dc" : v >= hi ? "#0f8a44" : v >= low ? "#a16207" : "#d03131";
                  return (
                    <div style={{ marginTop:16, padding:"14px 16px", background:"rgba(210,217,236,0.6)", borderRadius:10, border:"1px solid rgba(194,87,15,0.12)" }}>
                      <div style={{ fontSize:10, fontWeight:700, color:"#c2570f", textTransform:"uppercase", letterSpacing:1, marginBottom:12, display:"flex", alignItems:"center", gap:6 }}>
                        <span>⚾</span> Batted Ball Profile
                        <span style={{ fontSize:9, color:"#b6c5dc", fontWeight:400, textTransform:"none", marginLeft:4 }}>
                          {bb.bbe} BBE · pull_air_rate drives HR corridor model
                        </span>
                      </div>
                      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"6px 20px" }}>
                        {[
                          { label:"GB%",          val: bb.gbRate,       low:0.38, hi:0.50, invert:true,  hint:"Ground ball rate. Higher = contact approach. Lower = fly ball power approach." },
                          { label:"FB% (Air)",    val: bb.fbRate,       low:0.32, hi:0.45, invert:false, hint:"Fly ball / air ball rate. 40%+ with pull power = HR upside." },
                          { label:"Pull%",        val: bb.pullRate,     low:0.38, hi:0.48, invert:false, hint:"Pull rate on all batted balls. Pull power hitters generate more HRs in favorable parks." },
                          { label:"Pull Air%",    val: bb.pullAirRate,  low:0.12, hi:0.22, invert:false, hint:"Pull fly ball rate — the HR corridor. Model uses this directly: 20%+ is elite HR profile." },
                          { label:"Oppo Air%",    val: bb.oppoAirRate,  low:0.04, hi:0.10, invert:false, hint:"Opposite field fly ball rate. Spray hitters may have lower pull air% but consistent contact." },
                          { label:"LD%",          val: bb.ldRate,       low:0.20, hi:0.27, invert:false, hint:"Line drive rate. 24%+ = quality contact. Strong BABIP and hits predictor." },
                        ].map(({ label, val, low, hi, invert, hint }) => {
                          const color = val == null ? "#b6c5dc" : invert
                            ? (val >= hi ? "#d03131" : val >= low ? "#a16207" : "#0f8a44")
                            : barColor(val, low, hi);
                          return (
                            <div key={label} title={sabHints ? hint : undefined} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"4px 0", borderBottom:"1px solid rgba(32,98,200,0.08)" }}>
                              <span style={{ fontSize:11, color:"#5d6f8b" }}>{label}</span>
                              <span style={{ fontSize:12, fontWeight:700, color, fontFamily:"'JetBrains Mono',monospace" }}>{pct(val)}</span>
                            </div>
                          );
                        })}
                      </div>
                      {/* HR Stats row if available */}
                      {hrStats && (
                        <div style={{ marginTop:10, padding:"8px 10px", background:"rgba(161,98,7,0.05)", borderRadius:6, border:"1px solid rgba(161,98,7,0.1)" }}>
                          <div style={{ fontSize:9, color:"#a16207", textTransform:"uppercase", letterSpacing:0.8, marginBottom:5, fontWeight:700 }}>HR Luck (xHR)</div>
                          <div style={{ display:"flex", gap:16, flexWrap:"wrap" }}>
                            <div style={{ display:"flex", gap:4, alignItems:"baseline" }}>
                              <span style={{ fontSize:9, color:"#74839d" }}>HR</span>
                              <span style={{ fontSize:13, fontWeight:800, color:"#a16207", fontFamily:"'JetBrains Mono',monospace" }}>{hrStats.hrTotal}</span>
                            </div>
                            {hrStats.xhr != null && (
                              <div style={{ display:"flex", gap:4, alignItems:"baseline" }}>
                                <span style={{ fontSize:9, color:"#74839d" }}>xHR</span>
                                <span style={{ fontSize:13, fontWeight:800, color:"#3c4f6d", fontFamily:"'JetBrains Mono',monospace" }}>{hrStats.xhr.toFixed(1)}</span>
                              </div>
                            )}
                            {hrStats.xhrDiff != null && (
                              <div style={{ display:"flex", gap:4, alignItems:"baseline" }}>
                                <span style={{ fontSize:9, color:"#74839d" }}>xHR−HR</span>
                                <span style={{ fontSize:12, fontWeight:800, fontFamily:"'JetBrains Mono',monospace",
                                  color: hrStats.xhrDiff > 1 ? "#0f8a44" : hrStats.xhrDiff < -1 ? "#d03131" : "#5d6f8b" }}>
                                  {hrStats.xhrDiff > 0 ? "+" : ""}{hrStats.xhrDiff.toFixed(1)}
                                </span>
                              </div>
                            )}
                            {hrStats.noDoubters > 0 && (
                              <div style={{ display:"flex", gap:4, alignItems:"baseline" }}>
                                <span style={{ fontSize:9, color:"#74839d" }}>No-Doubters</span>
                                <span style={{ fontSize:12, fontWeight:700, color:"#c2570f", fontFamily:"'JetBrains Mono',monospace" }}>{hrStats.noDoubters}</span>
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })()}

                {/* ── Swing-Take Zone Discipline ── */}
                {swingTake && (() => {
                  const st = swingTake;
                  const fmtRV = v => v != null ? (v > 0 ? "+" : "") + v.toFixed(2) : "—";
                  const rvColor = v => v == null ? "#5d6f8b" : v > 0.5 ? "#0f8a44" : v > 0 ? "#65a30d" : v > -0.5 ? "#a16207" : "#d03131";
                  return (
                    <div style={{ marginTop:16, padding:"14px 16px", background:"rgba(210,217,236,0.6)", borderRadius:10, border:"1px solid rgba(32,98,200,0.192)" }}>
                      <div style={{ fontSize:10, fontWeight:700, color:"#2062c8", textTransform:"uppercase", letterSpacing:1, marginBottom:12, display:"flex", alignItems:"center", gap:6 }}>
                        <span>🎯</span> Swing-Take Zone Discipline
                        <span style={{ fontSize:9, color:"#b6c5dc", fontWeight:400, textTransform:"none", marginLeft:4 }}>
                          {st.pa} PA · {st.pitches?.toLocaleString()} pitches · run value per zone
                        </span>
                      </div>
                      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8, marginBottom:10 }}>
                        {[
                          { label:"Heart",  val: st.runsHeart,  hint:"Run value in the heart of the strike zone (premium pitches). Positive = batter is winning on meatballs." },
                          { label:"Shadow", val: st.runsShadow, hint:"Run value on shadow/edge pitches (borderline calls). Critical zone — elite batters win the shadow zone." },
                          { label:"Chase",  val: st.runsChase,  hint:"Run value on chase pitches (out of zone). Negative = batter is getting hurt chasing. Model penalizes high chase losses." },
                          { label:"Waste",  val: st.runsWaste,  hint:"Run value on waste pitches (far out of zone). Should be near 0 — big negatives = undisciplined free swingers." },
                          { label:"Overall",val: st.runsAll,    hint:"Total run value across all pitch zones. Best single zone discipline score. Positive = batter wins vs. the whole pitch mix." },
                        ].map(({ label, val, hint }) => (
                          <div key={label} title={sabHints ? hint : undefined} style={{ padding:"6px 10px", background:"rgba(32,98,200,0.064)", borderRadius:6, border:`1px solid rgba(74,158,255,${Math.abs(val ?? 0) > 0.3 ? "0.12" : "0.06"})`, textAlign:"center" }}>
                            <div style={{ fontSize:9, color:"#8b99b0", textTransform:"uppercase", letterSpacing:0.6, marginBottom:4 }}>{label}</div>
                            <div style={{ fontSize:14, fontWeight:800, color:rvColor(val), fontFamily:"'JetBrains Mono',monospace" }}>{fmtRV(val)}</div>
                            <div style={{ fontSize:8, color:"#b6c5dc", marginTop:2 }}>RV/100</div>
                          </div>
                        ))}
                      </div>
                      <div style={{ fontSize:8, color:"#c9d5e8" }}>Run value per 100 pitches seen in each zone · Positive = batter advantage · Source: Baseball Savant Swing-Take leaderboard</div>
                    </div>
                  );
                })()}

                {/* ── Bat Tracking / Attack Angle ── */}
                {attackAngle && (() => {
                  const aa = attackAngle;
                  const fmtDeg = v => v != null ? v.toFixed(1) + "°" : "—";
                  const fmtSpd = v => v != null ? v.toFixed(1) + " mph" : "—";
                  const fmtPctAA = v => v != null ? (v * 100).toFixed(1) + "%" : "—";
                  return (
                    <div style={{ marginTop:16, padding:"14px 16px", background:"rgba(210,217,236,0.6)", borderRadius:10, border:"1px solid rgba(147,51,234,0.12)" }}>
                      <div style={{ fontSize:10, fontWeight:700, color:"#9333ea", textTransform:"uppercase", letterSpacing:1, marginBottom:12, display:"flex", alignItems:"center", gap:6 }}>
                        <span>🏏</span> Bat Tracking · Swing Path
                        <span style={{ fontSize:9, color:"#b6c5dc", fontWeight:400, textTransform:"none", marginLeft:4 }}>
                          {aa.competitiveSwings?.toLocaleString()} competitive swings
                        </span>
                      </div>
                      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"6px 24px" }}>
                        {[
                          { label:"Bat Speed",   val: fmtSpd(aa.avgBatSpeed),   color: aa.avgBatSpeed == null ? "#5d6f8b" : aa.avgBatSpeed >= 75 ? "#0f8a44" : aa.avgBatSpeed >= 70 ? "#a16207" : "#d03131",   hint:"Average bat speed on competitive swings. 75+ mph = elite." },
                          { label:"Attack Angle",val: fmtDeg(aa.attackAngle),   color: aa.attackAngle == null ? "#5d6f8b" : aa.attackAngle >= 8 && aa.attackAngle <= 18 ? "#0f8a44" : "#a16207",              hint:"Vertical bat angle at contact. 8–18° = ideal launch angle zone." },
                          { label:"Ideal AA%",   val: fmtPctAA(aa.idealAttackAngle), color: aa.idealAttackAngle == null ? "#5d6f8b" : aa.idealAttackAngle >= 0.55 ? "#0f8a44" : aa.idealAttackAngle >= 0.45 ? "#a16207" : "#d03131", hint:"Rate of swings in the 8–18° ideal zone. 55%+ = elite contact." },
                          { label:"Swing Tilt",  val: fmtDeg(aa.swingTilt),     color: "#4c5f7d",                                                                                                              hint:"Rotation angle of swing path. Affects pull power and spray." },
                        ].map(({ label, val, color, hint }) => (
                          <div key={label} title={sabHints ? hint : undefined} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"5px 0", borderBottom:"1px solid rgba(32,98,200,0.096)" }}>
                            <span style={{ fontSize:11, color:"#5d6f8b" }}>{label}</span>
                            <span style={{ fontSize:12, fontWeight:700, color, fontFamily:"'JetBrains Mono',monospace" }}>{val}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}

                {/* ── FanGraphs + Savant Advanced Metrics from DB ── */}
                {panelAdvStats && (() => {
                  const adv = panelAdvStats;
                  const fmtPct = (v, decimals=1) => v != null ? v.toFixed(decimals) + "%" : "—";
                  const fmtOBA = (v) => v != null ? "." + Math.round(v * 1000).toString().padStart(3, "0") : "—";
                  const fmtN = (v) => v != null ? Math.round(v) : "—";
                  const MetricRow = ({ label, value, hint, compare }) => (
                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"5px 0", borderBottom:"1px solid rgba(32,98,200,0.096)" }}>
                      <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                        <span style={{ fontSize:11, color:"#5d6f8b" }}>{label}</span>
                        {sabHints && hint && (
                          <span title={hint} style={{ fontSize:9, color:"#8b99b0", cursor:"help", background:"rgba(32,98,200,0.128)", padding:"1px 5px", borderRadius:3 }}>?</span>
                        )}
                      </div>
                      <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                        {compare != null && value !== "—" && <span style={{ fontSize:9, color:"#8b99b0" }}>lg: {compare}</span>}
                        <span style={{ fontSize:12, fontWeight:700, fontFamily:"'JetBrains Mono',monospace", color:"#16233c", minWidth:50, textAlign:"right" }}>{value}</span>
                      </div>
                    </div>
                  );
                  const hasFgProduction = adv.wrc_plus != null || adv.iso != null || adv.babip != null || adv.hr_fb_pct != null || adv.k_pct != null || adv.bb_pct != null;
                  const hasSavantAdv = adv.xwoba != null || adv.xba != null || adv.xslg != null || adv.hard_hit_pct != null || adv.barrel_pct != null || adv.sprint_speed != null;
                  if (!hasFgProduction && !hasSavantAdv) return null;
                  return (
                    <div style={{ marginTop:16, padding:"14px 16px", background:"rgba(210,217,236,0.6)", borderRadius:10, border:"1px solid rgba(32,98,200,0.192)" }}>
                      <div style={{ fontSize:10, fontWeight:700, color:"#c2570f", textTransform:"uppercase", letterSpacing:1, marginBottom:12, display:"flex", alignItems:"center", gap:6 }}>
                        <span>📐</span> FanGraphs Advanced Metrics
                        {sabHints && <span style={{ fontSize:9, color:"#8b99b0", fontWeight:400, textTransform:"none" }}> · Hover ? for explanations</span>}
                      </div>
                      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"0 20px" }}>
                        {hasFgProduction && (
                          <div>
                            <div style={{ fontSize:9, color:"#2062c8", textTransform:"uppercase", letterSpacing:0.8, marginBottom:6, fontWeight:700 }}>Production</div>
                            <MetricRow label="wRC+"    value={fmtN(adv.wrc_plus)}  compare="100"   hint="Park- and league-adjusted production. 100 = avg. 130+ = elite." />
                            <MetricRow label="ISO"     value={adv.iso != null ? fmtOBA(adv.iso) : "—"} compare=".155" hint="Isolated Power = SLG − AVG. .250+ = elite power." />
                            <MetricRow label="BABIP"   value={adv.babip != null ? fmtOBA(adv.babip) : "—"} compare=".300" hint="Luck indicator. Sustained deviation regresses toward mean." />
                            <MetricRow label="HR/FB%"  value={fmtPct(adv.hr_fb_pct)} compare="12%"  hint="HRs per fly ball. 25%+ = elite power." />
                            <MetricRow label="K%"      value={fmtPct(adv.k_pct)}    compare="22%"   hint="Strikeout rate. Lower = better contact." />
                            <MetricRow label="BB%"     value={fmtPct(adv.bb_pct)}   compare="8.5%"  hint="Walk rate. Higher = better eye." />
                          </div>
                        )}
                        {hasSavantAdv && (
                          <div>
                            <div style={{ fontSize:9, color:"#2062c8", textTransform:"uppercase", letterSpacing:0.8, marginBottom:6, fontWeight:700 }}>Expected Outcomes</div>
                            <MetricRow label="xwOBA"      value={fmtOBA(adv.xwoba)}      compare=".320"    hint="Expected wOBA by contact quality. Best luck-adjusted production metric." />
                            <MetricRow label="xBA"        value={fmtOBA(adv.xba)}        compare=".250"    hint="Expected BA. xBA >> BA = getting unlucky." />
                            <MetricRow label="xSLG"       value={fmtOBA(adv.xslg)}       compare=".410"    hint="Expected SLG. Best future total bases predictor." />
                            <MetricRow label="Hard Hit%"  value={fmtPct(adv.hard_hit_pct)} compare="38%"   hint="Balls hit ≥95 mph." />
                            <MetricRow label="Barrel%"    value={fmtPct(adv.barrel_pct)} compare="7.5%"    hint="Best HR predictor. 15%+ = elite." />
                            <MetricRow label="Sprint Spd" value={adv.sprint_speed != null ? adv.sprint_speed.toFixed(1) + " ft/s" : "—"} compare="27 ft/s" hint="Elite: 29+ ft/s." />
                          </div>
                        )}
                      </div>
                      {(adv.pull_pct != null || adv.oz_swing_pct != null) && (
                        <div style={{ marginTop:10, display:"grid", gridTemplateColumns:"1fr 1fr", gap:"0 20px" }}>
                          <div>
                            <div style={{ fontSize:9, color:"#2062c8", textTransform:"uppercase", letterSpacing:0.8, marginBottom:6, fontWeight:700 }}>Batted Ball</div>
                            <MetricRow label="Pull%"  value={fmtPct(adv.pull_pct)}  compare="41%" hint="Higher pull% + power = HR threat." />
                            <MetricRow label="Hard-Hit%"  value={fmtPct(adv.hard_hit_pct)}  compare="35%" hint="Share of batted balls hit 95+ mph (Statcast)." />
                          </div>
                          <div>
                            <div style={{ fontSize:9, color:"#2062c8", textTransform:"uppercase", letterSpacing:0.8, marginBottom:6, fontWeight:700 }}>Swing Profile</div>
                            <MetricRow label="OZ-Swing%" value={fmtPct(adv.oz_swing_pct)} compare="29%" hint="Chase rate. Lower = better discipline." />
                            <MetricRow label="Whiff%"    value={fmtPct(adv.whiff_pct)}    compare="24%" hint="Swings-and-misses per swing." />
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
            );
          })()}

          {/* ── ARSENAL PERFORMANCE TAB ── */}
          {tab === "arsenal" && (() => {
            const yr = arsenalBatterYear;
            // Hand split: "both" = leaderboard CSV (exact), "L"/"R" = vs LHP/RHP (event-aggregated).
            const isBothHand = arsenalHandSplit === "both";
            const rawBvp = isBothHand ? arsenalBatterCache[yr] : bvpByHandCache[`${yr}-${arsenalHandSplit}`];
            const bvpLoading = rawBvp === undefined || rawBvp === "loading";
            const bvpData = (rawBvp && rawBvp !== "loading") ? rawBvp : undefined;
            const pitcherPitches = matchupPitcherCache[yr]; // { pitchCode → {usage, vel} }
            const hasPitcher = !!pitcherId;
            const hasMatchupData = pitcherPitches && Object.keys(pitcherPitches).length > 0;

            const allEntries = bvpData ? Object.entries(bvpData).sort((a, b) => (b[1].pitches || 0) - (a[1].pitches || 0)) : [];
            // In matchup mode: filter to pitcher's pitch types AND sort by pitcher usage% (most-thrown first)
            const displayEntries = matchupMode && hasMatchupData
              ? allEntries
                  .filter(([code]) => code in pitcherPitches)
                  .sort((a, b) => (pitcherPitches[b[0]]?.usage || 0) - (pitcherPitches[a[0]]?.usage || 0))
              : allEntries;

            const fmtPct = v => v != null ? v.toFixed(1) + "%" : "—";
            const fmtStat = v => v != null ? fmtAvg(v) : "—";
            const rvColor = rv => rv == null ? "#4c5f7d" : rv >= 1 ? "#0f8a44" : rv <= -1 ? "#d03131" : "#4c5f7d";

            return (<>
              {/* Arsenal inner subtab bar */}
              <div style={{ display: "flex", gap: 4, marginBottom: 16, borderBottom: "1px solid rgba(32,98,200,0.128)", paddingBottom: 10 }}>
                {[["pitches", "Pitch Arsenal"], ["discipline", "Plate Discipline"], ["bvp", "vs Pitch Type"]].map(([k, label]) => (
                  <button key={k} onClick={() => setArsenalSubtab(k)} style={{
                    padding: "5px 14px", fontSize: 11, borderRadius: 6, cursor: "pointer", fontWeight: arsenalSubtab === k ? 700 : 400,
                    background: arsenalSubtab === k ? "rgba(194,87,15,0.15)" : "transparent",
                    color: arsenalSubtab === k ? "#c2570f" : "#74839d",
                    border: arsenalSubtab === k ? "1px solid rgba(194,87,15,0.3)" : "1px solid transparent",
                  }}>{label}</button>
                ))}
              </div>

              {/* High-level pitch-family matchup summary (props.cash-style), always
                  visible across arsenal subtabs. Reuses bvpData + pitcher mix already in scope. */}
              {bvpData && <BatterArsenalSummary bvpData={bvpData}
                pitcherPitches={matchupMode ? pitcherPitches : null} pitcherName={pitcherName} />}

              {arsenalSubtab === "pitches" && <Section title="Arsenal Performance" accent="#c2570f">
                {/* Year selector + Matchup toggle */}
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 11, color: "#5d6f8b" }}>Season:</span>
                  {[2024, 2025, 2026].map(y => (
                    <button key={y} onClick={() => setArsenalBatterYear(y)} style={{
                      padding: "3px 10px", fontSize: 11, borderRadius: 4, cursor: "pointer",
                      border: arsenalBatterYear === y ? "1px solid #c2570f" : "1px solid #c6cdd9",
                      background: arsenalBatterYear === y ? "rgba(194,87,15,0.15)" : "#e8edf6",
                      color: arsenalBatterYear === y ? "#c2570f" : "#5d6f8b",
                      fontWeight: arsenalBatterYear === y ? 700 : 400,
                    }}>{y}</button>
                  ))}
                  {hasPitcher && (
                    <button onClick={() => setMatchupMode(m => !m)} style={{
                      marginLeft: "auto", padding: "5px 14px", fontSize: 11, borderRadius: 6, cursor: "pointer",
                      border: matchupMode ? "1px solid #c2570f" : "1px solid #8b99b0",
                      background: matchupMode ? "rgba(194,87,15,0.15)" : "rgba(210,217,236,0.5)",
                      color: matchupMode ? "#c2570f" : "#74839d", fontWeight: matchupMode ? 700 : 400,
                    }}>
                      {matchupMode ? `⚡ vs ${pitcherName || "Pitcher"} (${displayEntries.length} pitches)` : `⚡ Matchup: vs ${pitcherName || "Pitcher"}`}
                    </button>
                  )}
                </div>

                {/* Pitcher-hand split: Both / vs LHP / vs RHP — ⚡ marks the starter's hand */}
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 11, color: "#5d6f8b" }}>Split:</span>
                  {[["both", "Both"], ["L", "Left"], ["R", "Right"]].map(([val, label]) => {
                    const active = arsenalHandSplit === val;
                    const isStarterHand = (val === "L" || val === "R") && pitcherThrows === val;
                    return (
                      <button key={val} onClick={() => setArsenalHandSplit(val)} style={{
                        padding: "3px 11px", fontSize: 11, borderRadius: 4, cursor: "pointer",
                        display: "flex", alignItems: "center", gap: 4,
                        border: active ? "1px solid #c2570f" : "1px solid #c6cdd9",
                        background: active ? "rgba(194,87,15,0.15)" : "#e8edf6",
                        color: active ? "#c2570f" : "#5d6f8b", fontWeight: active ? 700 : 400,
                      }}>
                        {isStarterHand && <span style={{ fontSize: 10 }} title={`${pitcherName || "Starter"} throws ${val === "L" ? "left" : "right"}`}>⚡</span>}
                        {label}
                      </button>
                    );
                  })}
                  {!isBothHand && (
                    <span style={{ fontSize: 10, color: "#74839d" }}>
                      vs {arsenalHandSplit === "L" ? "LHP" : "RHP"} · xwOBA est., RV/100 n/a
                    </span>
                  )}
                </div>

                {matchupMode && !hasMatchupData && hasPitcher && (
                  <div style={{ fontSize: 11, color: "#74839d", marginBottom: 10 }}>Loading pitcher arsenal…</div>
                )}

                {bvpLoading ? (
                  <Loader text={`Loading ${yr} pitch performance…`} />
                ) : bvpData !== undefined && Object.keys(bvpData).length === 0 ? (
                  <div style={{ color: "#74839d", padding: "20px 0", textAlign: "center", fontSize: 12 }}>
                    No Statcast data {isBothHand ? "" : `vs ${arsenalHandSplit === "L" ? "LHP" : "RHP"} `}available for {yr}
                    <br /><button onClick={() => isBothHand
                        ? setArsenalBatterCache(c => { const n={...c}; delete n[yr]; return n; })
                        : setBvpByHandCache(c => { const n={...c}; delete n[`${yr}-${arsenalHandSplit}`]; return n; })
                      } style={{ marginTop: 8, padding: "5px 14px", fontSize: 11, borderRadius: 6, cursor: "pointer", border: "1px solid #c6cdd9", background: "rgba(194,87,15,0.1)", color: "#c2570f" }}>↺ Retry</button>
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {displayEntries.map(([code, s]) => {
                      const color = PITCH_COLORS[code] || "#6d4fd0";
                      const pitcherP = pitcherPitches?.[code];
                      const rv = s.rv100;
                      return (
                        <div key={code} style={{ background: "rgba(210,217,236,0.5)", borderRadius: 10, padding: "12px 14px", border: `1px solid ${color}22` }}>
                          {/* Pitch header */}
                          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                            <span style={{ fontSize: 10, fontWeight: 700, color, background: `${color}18`, padding: "2px 7px", borderRadius: 4, minWidth: 28, textAlign: "center" }}>{code}</span>
                            <span style={{ fontSize: 13, fontWeight: 600, color: "#223350", flex: 1 }}>{PITCH_LABELS[code] || code}</span>
                            <span style={{ fontSize: 10, color: "#74839d" }}>{s.pitches} pitches · {s.pa} PA</span>
                          </div>

                          {/* Pitcher context row (matchup mode) */}
                          {matchupMode && pitcherP && (
                            <div style={{ display: "flex", gap: 10, marginBottom: 10, padding: "6px 10px", background: `${color}0d`, borderRadius: 6, border: `1px solid ${color}22`, flexWrap: "wrap", alignItems: "center" }}>
                              <span style={{ fontSize: 10, color: "#74839d" }}>Pitcher usage:</span>
                              <span style={{ fontSize: 10, fontWeight: 700, color }}>{pitcherP.usage.toFixed(1)}%</span>
                              <span style={{ fontSize: 10, color: "#74839d" }}>· Pitcher avg velo:</span>
                              <span style={{ fontSize: 10, fontWeight: 700, color: "#4c5f7d" }}>{pitcherP.vel.toFixed(1)} mph</span>
                              {s.avgVel != null && (<>
                                <span style={{ fontSize: 10, color: "#b6c5dc" }}>·</span>
                                <span style={{ fontSize: 10, color: "#74839d" }}>Batter avg faced:</span>
                                <span style={{ fontSize: 10, fontWeight: 700, color: (() => {
                                  const diff = pitcherP.vel - s.avgVel;
                                  return diff >= 2 ? "#d03131" : diff <= -2 ? "#0f8a44" : "#4c5f7d";
                                })() }}>{s.avgVel.toFixed(1)} mph</span>
                                {Math.abs(pitcherP.vel - s.avgVel) >= 1.5 && (
                                  <span style={{ fontSize: 9, color: pitcherP.vel > s.avgVel ? "#d03131" : "#0f8a44", fontWeight: 700 }}>
                                    {pitcherP.vel > s.avgVel ? `▲ ${(pitcherP.vel - s.avgVel).toFixed(1)} harder` : `▼ ${(s.avgVel - pitcherP.vel).toFixed(1)} softer`}
                                  </span>
                                )}
                              </>)}
                            </div>
                          )}

                          {/* Stats grid — 4 cols */}
                          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
                            {[
                              ["BA",       fmtStat(s.ba),    parseFloat(s.ba) >= 0.300 ? "#0f8a44" : parseFloat(s.ba) < 0.200 ? "#d03131" : "#4c5f7d"],
                              ["SLG",      fmtStat(s.slg),   parseFloat(s.slg) >= 0.500 ? "#0f8a44" : "#4c5f7d"],
                              ["wOBA",     fmtStat(s.woba),  parseFloat(s.woba) >= 0.370 ? "#0f8a44" : parseFloat(s.woba) < 0.290 ? "#d03131" : "#4c5f7d"],
                              ["xwOBA",    fmtStat(s.xwoba), parseFloat(s.xwoba) >= 0.370 ? "#0f8a44" : parseFloat(s.xwoba) < 0.290 ? "#d03131" : "#4c5f7d"],
                              ["Whiff%",   fmtPct(s.whiff),  s.whiff >= 35 ? "#d03131" : s.whiff <= 15 ? "#0f8a44" : "#4c5f7d"],
                              ["Hard Hit%",fmtPct(s.hardHit),s.hardHit >= 50 ? "#0f8a44" : s.hardHit <= 30 ? "#d03131" : "#4c5f7d"],
                              ["K%",       fmtPct(s.kPct),   s.kPct >= 30 ? "#d03131" : s.kPct <= 12 ? "#0f8a44" : "#4c5f7d"],
                              ["RV/100",   rv != null ? (rv > 0 ? "+" : "") + rv.toFixed(1) : "—", rvColor(rv)],
                            ].map(([label, val, clr]) => (
                              <div key={label} style={{ textAlign: "center" }}>
                                <div style={{ fontSize: 9, color: "#74839d", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 3 }}>
                                  <HintTooltip stat={label} enabled={sabHints}>{label}</HintTooltip>
                                </div>
                                <div style={{ fontSize: 12, fontWeight: 600, color: clr, fontFamily: "'JetBrains Mono', monospace" }}>{val}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                    {displayEntries.length === 0 && !bvpLoading && (
                      <div style={{ color: "#74839d", padding: "20px 0", textAlign: "center", fontSize: 12 }}>
                        {matchupMode ? "No overlapping pitch types found for this matchup." : "No data yet."}
                      </div>
                    )}
                    <div style={{ fontSize: 9, color: "#b6c5dc", marginTop: 4, lineHeight: 1.6 }}>
                      <strong style={{ color: "#8b99b0" }}>RV/100</strong> run value per 100 pitches seen (positive = batter advantage) · <strong style={{ color: "#8b99b0" }}>Whiff%</strong> swings-and-misses / pitches seen · via Baseball Savant Statcast
                      {!isBothHand && <><br />Split vs {arsenalHandSplit === "L" ? "LHP" : "RHP"} aggregated from pitch-level events — xwOBA is estimated and RV/100 is unavailable per hand.</>}
                    </div>
                  </div>
                )}
              </Section>}

              {/* ── PLATE DISCIPLINE (batter) ── shown in discipline subtab */}
              {arsenalSubtab === "discipline" && (disciplineCache[arsenalBatterYear] === undefined
                ? <Loader text={`Loading ${arsenalBatterYear} plate discipline…`} />
                : disciplineCache[arsenalBatterYear] === null
                  ? <div style={{ color: "#74839d", padding: "20px 0", textAlign: "center", fontSize: 12 }}>No plate discipline data for {arsenalBatterYear}</div>
                  : null)}
              {arsenalSubtab === "discipline" && disciplineCache[arsenalBatterYear] && (() => {
                const d = disciplineCache[arsenalBatterYear];
                const fp = v => v != null ? v.toFixed(1) + "%" : "—";
                // Color thresholds: green = batter advantage, red = batter disadvantage
                const rows = [
                  { label: "F-Strike% Seen", val: fp(d.fStrike),   color: d.fStrike > 62 ? "#d03131" : d.fStrike < 50 ? "#0f8a44" : "#4c5f7d", tip: "First pitch called strike rate (lower = batter sees more balls early)" },
                  { label: "Chase%",          val: fp(d.ozSwing),   color: d.ozSwing > 32 ? "#d03131" : d.ozSwing < 20 ? "#0f8a44" : "#4c5f7d", tip: "Out-of-zone swing rate (lower = elite patience)" },
                  { label: "Zone Swing%",     val: fp(d.zSwing),    color: d.zSwing > 72 ? "#0f8a44" : d.zSwing < 55 ? "#d03131" : "#4c5f7d",  tip: "In-zone swing rate" },
                  { label: "Zone Contact%",   val: fp(d.izContact), color: d.izContact > 87 ? "#0f8a44" : d.izContact < 75 ? "#d03131" : "#4c5f7d", tip: "Contact rate on pitches in the zone" },
                  { label: "Chase Contact%",  val: fp(d.ozContact), color: d.ozContact > 68 ? "#0f8a44" : d.ozContact < 50 ? "#d03131" : "#4c5f7d", tip: "Contact rate on pitches out of zone" },
                  { label: "Whiff%",          val: fp(d.whiff),     color: d.whiff > 30 ? "#d03131" : d.whiff < 18 ? "#0f8a44" : "#4c5f7d",  tip: "Swing-and-miss per pitch seen" },
                ];
                return (
                  <Section title="Plate Discipline" accent="#2569d6">
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
                      {rows.map(({ label, val, color }) => (
                        <div key={label} style={{ background: "rgba(210,217,236,0.5)", borderRadius: 8, padding: "10px 12px", textAlign: "center", border: "1px solid rgba(37,105,214,0.1)" }}>
                          <div style={{ fontSize: 9, color: "#74839d", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 5, lineHeight: 1.3 }}>
                            <HintTooltip stat={label} enabled={sabHints}>{label}</HintTooltip>
                          </div>
                          <div style={{ fontSize: 18, fontWeight: 700, color, fontFamily: "'JetBrains Mono', monospace" }}>{val}</div>
                        </div>
                      ))}
                    </div>
                    <div style={{ marginTop: 8, fontSize: 9, color: "#b6c5dc", lineHeight: 1.8 }}>
                      <strong style={{ color: "#8b99b0" }}>Chase%</strong> swings on pitches outside zone · <strong style={{ color: "#8b99b0" }}>Zone Contact%</strong> contact on pitches in zone · <strong style={{ color: "#8b99b0" }}>Whiff%</strong> misses / pitches seen · via Baseball Savant {arsenalBatterYear}
                    </div>
                  </Section>
                );
              })()}

              {arsenalSubtab === "bvp" && (() => {
                // Uses same Savant CSV as Pitch Arsenal (arsenalBatterCache) — reliable historical data
                const bvpSavant = arsenalBatterCache[yr]; // { pitchCode → { pa, pitches, ba, slg, xwoba, whiff, kPct, rv100, ... } }
                const fmtDec = v => v != null ? "." + Math.round(v * 1000).toString().padStart(3, "0") : "—";
                const fmtPct = v => v != null && v > 0 ? v.toFixed(1) + "%" : "—";
                const rvColor = v => v == null ? "#4c5f7d" : v >= 2 ? "#d03131" : v <= -2 ? "#0f8a44" : "#4c5f7d";
                const xwobaColor = v => v == null ? "#4c5f7d" : v >= 0.380 ? "#d03131" : v <= 0.280 ? "#0f8a44" : "#4c5f7d";

                return (
                  <Section title={`Batter vs Pitch Type · ${yr}`} accent="#0a8564">
                    {/* Year selector */}
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 11, color: "#5d6f8b" }}>Season:</span>
                      {[2024, 2025, 2026].map(y => (
                        <button key={y} onClick={() => setArsenalBatterYear(y)} style={{
                          padding: "3px 10px", fontSize: 11, borderRadius: 4, cursor: "pointer",
                          border: yr === y ? "1px solid #0a8564" : "1px solid #c6cdd9",
                          background: yr === y ? "rgba(10,133,100,0.15)" : "#e8edf6",
                          color: yr === y ? "#0a8564" : "#5d6f8b",
                          fontWeight: yr === y ? 700 : 400,
                        }}>{y}</button>
                      ))}
                      <span style={{ fontSize: 10, color: "#b6c5dc", marginLeft: 4 }}>2026 data populates mid-season · use 2024/2025 for full splits</span>
                    </div>

                    {arsenalBatterLoading && bvpSavant === undefined ? (
                      <Loader text={`Loading ${yr} Statcast pitch data…`} />
                    ) : !bvpSavant || Object.keys(bvpSavant).length === 0 ? (
                      <div style={{ color: "#74839d", padding: "20px 0", textAlign: "center", fontSize: 12 }}>
                        No Statcast pitch data for {yr}
                        {yr === 2026 && <div style={{ fontSize: 10, color: "#b6c5dc", marginTop: 6 }}>Try 2024 or 2025 for full-season splits</div>}
                        <br /><button onClick={() => setArsenalBatterCache(c => { const n={...c}; delete n[yr]; return n; })} style={{ marginTop: 8, padding: "5px 14px", fontSize: 11, borderRadius: 6, cursor: "pointer", border: "1px solid #c6cdd9", background: "rgba(10,133,100,0.1)", color: "#0a8564" }}>↺ Retry</button>
                      </div>
                    ) : (
                      <div className="hscroll">
                        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 520 }}>
                          <thead>
                            <tr style={{ borderBottom: "1px solid rgba(32,98,200,0.192)" }}>
                              {["Pitch","PA","BA","SLG","xwOBA","Whiff%","K%","Put Away%","RV/100"].map(h => (
                                <th key={h} style={{ padding: "4px 7px", textAlign: h === "Pitch" ? "left" : "center", fontSize: 9, color: "#74839d", textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 700 }}>{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {Object.entries(bvpSavant).sort((a, b) => (b[1].pitches || 0) - (a[1].pitches || 0)).map(([code, s]) => {
                              const color = PITCH_COLORS[code] || "#6d4fd0";
                              return (
                                <tr key={code} style={{ borderBottom: "1px solid rgba(32,98,200,0.08)" }}>
                                  <td style={{ padding: "5px 7px", fontSize: 12, color: "#3c4f6d" }}>
                                    <span style={{ fontSize: 9, fontWeight: 700, color, background: `${color}18`, padding: "1px 5px", borderRadius: 3, marginRight: 5 }}>{code}</span>
                                    {PITCH_LABELS[code] || code}
                                  </td>
                                  <td style={{ padding: "5px 7px", textAlign: "center", fontSize: 11, fontFamily: "'JetBrains Mono',monospace", color: (s.pa || 0) < 20 ? "#74839d" : "#4c5f7d" }}>{s.pa || 0}</td>
                                  <td style={{ padding: "5px 7px", textAlign: "center", fontSize: 11, fontFamily: "'JetBrains Mono',monospace", color: (s.ba || 0) >= 0.300 ? "#0f8a44" : "#4c5f7d" }}>{fmtDec(s.ba)}</td>
                                  <td style={{ padding: "5px 7px", textAlign: "center", fontSize: 11, fontFamily: "'JetBrains Mono',monospace", color: (s.slg || 0) >= 0.500 ? "#0f8a44" : "#4c5f7d" }}>{fmtDec(s.slg)}</td>
                                  <td style={{ padding: "5px 7px", textAlign: "center", fontSize: 11, fontFamily: "'JetBrains Mono',monospace", color: xwobaColor(s.xwoba), fontWeight: s.xwoba >= 0.380 || s.xwoba <= 0.280 ? 700 : 400 }}>{fmtDec(s.xwoba)}</td>
                                  <td style={{ padding: "5px 7px", textAlign: "center", fontSize: 11, fontFamily: "'JetBrains Mono',monospace", color: (s.whiff || 0) >= 35 ? "#d03131" : "#4c5f7d" }}>{fmtPct(s.whiff)}</td>
                                  <td style={{ padding: "5px 7px", textAlign: "center", fontSize: 11, fontFamily: "'JetBrains Mono',monospace", color: (s.kPct || 0) >= 30 ? "#d03131" : "#4c5f7d" }}>{fmtPct(s.kPct)}</td>
                                  <td style={{ padding: "5px 7px", textAlign: "center", fontSize: 11, fontFamily: "'JetBrains Mono',monospace", color: "#4c5f7d" }}>{fmtPct(s.putAway)}</td>
                                  <td style={{ padding: "5px 7px", textAlign: "center", fontSize: 11, fontFamily: "'JetBrains Mono',monospace", color: rvColor(s.rv100), fontWeight: s.rv100 != null && Math.abs(s.rv100) >= 2 ? 700 : 400 }}>{s.rv100 != null ? (s.rv100 > 0 ? "+" : "") + s.rv100.toFixed(1) : "—"}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                        <div style={{ marginTop: 8, fontSize: 9, color: "#b6c5dc", lineHeight: 1.8 }}>
                          PA &lt; 20 = small sample · <strong style={{ color: "#8b99b0" }}>xwOBA</strong> red ≥ .380 (pitcher advantage), green ≤ .280 (batter advantage) · <strong style={{ color: "#8b99b0" }}>RV/100</strong> red = positive (pitcher giving up runs) · via Baseball Savant
                        </div>
                      </div>
                    )}
                  </Section>
                );
              })()}
            </>);
          })()}
          {tab === "spray" && (() => {
            // Resolve which park to show in stadium mode
            const activeStadiumAbbrev = (() => {
              if (sprayMode !== "stadium") return null;
              const raw = sprayStadium || homeTeamAbbrev;
              if (!raw) return Object.keys(PARK_DATA).sort()[0];
              // Apply abbreviation aliases (e.g. ATH → OAK)
              return _ABBREV_ALIASES[raw] || raw;
            })();
            const stadiumPark = activeStadiumAbbrev ? PARK_DATA[activeStadiumAbbrev] : null;

            const allBIP = sprayCache[sprayYear] || [];
            const displayBIP = sprayMode === "stadium" && stadiumPark
              ? allBIP.filter(h => h.venue === stadiumPark.name)
              : allBIP;

            const isLoading = sprayLoading && sprayCache[sprayYear] === undefined;
            const isEmpty = !isLoading && sprayCache[sprayYear] !== undefined && allBIP.length === 0;

            return (
              <Section title="Spray Chart" accent="#6d4fd0">
                {/* Year + Season/Stadium controls */}
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 11, color: "#5d6f8b" }}>Season:</span>
                  {[2024, 2025, 2026].map(yr => (
                    <button key={yr} onClick={() => setSprayYear(yr)} style={{
                      padding: "3px 10px", fontSize: 11, borderRadius: 4, cursor: "pointer",
                      border: sprayYear === yr ? "1px solid #6d4fd0" : "1px solid #c6cdd9",
                      background: sprayYear === yr ? "rgba(109,79,208,0.15)" : "#e8edf6",
                      color: sprayYear === yr ? "#6d4fd0" : "#5d6f8b",
                      fontWeight: sprayYear === yr ? 700 : 400,
                    }}>{yr}</button>
                  ))}
                  <div style={{ display: "flex", background: "rgba(210,217,236,0.6)", border: "1px solid #c6cdd9", borderRadius: 6, overflow: "hidden", marginLeft: "auto" }}>
                    {[["season", "Season"], ["stadium", "Stadium"]].map(([m, label]) => (
                      <button key={m} onClick={() => setSprayMode(m)} style={{
                        padding: "4px 12px", fontSize: 11, cursor: "pointer", fontWeight: sprayMode === m ? 700 : 400,
                        background: sprayMode === m ? "rgba(109,79,208,0.2)" : "transparent",
                        color: sprayMode === m ? "#6d4fd0" : "#74839d", border: "none",
                      }}>{label}</button>
                    ))}
                  </div>
                </div>

                {/* Stadium picker — only in stadium mode */}
                {sprayMode === "stadium" && (
                  <div style={{ marginBottom: 12 }}>
                    <select
                      value={activeStadiumAbbrev}
                      onChange={e => setSprayStadium(e.target.value)}
                      style={{
                        width: "100%", padding: "7px 10px", fontSize: 12, borderRadius: 6, cursor: "pointer",
                        background: "#edf2fa", border: "1px solid rgba(109,79,208,0.3)",
                        color: "#3c4f6d", outline: "none", appearance: "none",
                      }}
                    >
                      {Object.entries(PARK_DATA)
                        .sort((a, b) => a[0].localeCompare(b[0]))
                        .map(([abbr, p]) => (
                          <option key={abbr} value={abbr}>{abbr} — {p.name}</option>
                        ))}
                    </select>
                    {stadiumPark && (
                      <div style={{ fontSize: 10, color: "#74839d", marginTop: 5 }}>
                        Showing {displayBIP.length} ball{displayBIP.length !== 1 ? "s" : ""} in play at {stadiumPark.name} · {sprayYear}
                      </div>
                    )}
                  </div>
                )}

                {isLoading ? (
                  <Loader text={sprayLoadingMsg || `Fetching ${sprayYear} batted ball data…`} />
                ) : (
                  <>
                    <SprayChart
                      hits={displayBIP}
                      park={stadiumPark}
                      battingHand={bats !== "?" ? bats : undefined}
                    />
                    {isEmpty && (
                      <div style={{ marginTop: 8, textAlign: "center" }}>
                        <button onClick={() => setSprayCache(c => { const n = {...c}; delete n[sprayYear]; return n; })} style={{
                          padding: "5px 14px", fontSize: 11, borderRadius: 6, cursor: "pointer",
                          border: "1px solid #c6cdd9", background: "rgba(109,79,208,0.1)", color: "#6d4fd0", fontWeight: 600,
                        }}>↺ Retry</button>
                      </div>
                    )}
                  </>
                )}
              </Section>
            );
          })()}

          {/* ── NEWS TAB ── */}
          {tab === "news" && (
            <div>
              {/* Season giveaway schedule for this player */}
              <PlayerGiveaways playerId={batter.id} />
              {/* Articles */}
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 10, color: "#6d7c96", textTransform: "uppercase", letterSpacing: 1.2, marginBottom: 10 }}>
                  Latest News · Google News + Rotowire
                </div>

                {newsLoading && <Loader text="Fetching latest news..." />}

                {!newsLoading && (!news || news.length === 0) && (
                  <div style={{ padding: "24px 0", textAlign: "center", color: "#74839d", fontSize: 13 }}>
                    No recent news found — check back on game day.
                  </div>
                )}

                {!newsLoading && news?.length > 0 && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {news.map((a, i) => (
                      <a key={i} href={a.link || "#"} target="_blank" rel="noopener noreferrer"
                        style={{ display: "block", textDecoration: "none",
                          padding: "10px 12px", borderRadius: 8,
                          background: a.isRotowire ? "rgba(161,98,7,0.06)" : "rgba(210,217,236,0.4)",
                          border: `1px solid ${a.isRotowire ? "rgba(161,98,7,0.2)" : "rgba(32,98,200,0.128)"}`,
                          transition: "border-color 0.15s",
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
              </div>

              {/* Beat writers for this team */}
              {batterTeam && BEAT_REPORTERS[batterTeam] && (
                <div style={{ paddingTop: 16, borderTop: "1px solid rgba(32,98,200,0.128)" }}>
                  <div style={{ fontSize: 10, color: "#6d7c96", textTransform: "uppercase", letterSpacing: 1.2, marginBottom: 8 }}>
                    {batterTeam} Beat Writers
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {BEAT_REPORTERS[batterTeam].map((rep, i) => (
                      <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0",
                        borderBottom: i < BEAT_REPORTERS[batterTeam].length - 1 ? "1px solid rgba(32,98,200,0.08)" : "none" }}>
                        <span style={{ fontSize: 11, color: "#2062c8", background: "rgba(32,98,200,0.16)", padding: "1px 6px", borderRadius: 4, minWidth: 90, textAlign: "center", flexShrink: 0 }}>{rep.o}</span>
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
