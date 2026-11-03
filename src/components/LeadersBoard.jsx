// ── League Leaders Board ──────────────────────────────────────────────────
// Shows top 15 in 4 batter categories (HR, RBI, SB, Hits) and 2 pitcher
// categories (Ks, ERA), pulled live from MLB Stats API. Each row includes
// a "Games Without" / "Starts Since" drought column computed from gameLog.
//
// Season / Last 15 toggle: the MLB leaders endpoint only returns season totals,
// so "Last 15" keeps the same season-top-15 player set and re-ranks each card by
// that player's production over their last 15 games (derived from the gameLog we
// already fetch for the drought column). Reads as who's hot vs. cold/cooling —
// the drought column flags the genuinely absent (injured) players.
//
// Extracted from App.jsx 2026-06 as part of the incremental App.jsx dissolution.
import { useState, useEffect, useMemo } from "react";
import { API, fetchJson } from "../lib/utils.js";
import { getInjuryMap, INJURY_EMOJI, ilShortLabel } from "../lib/injuries.js";
import { ipToDec } from "../lib/innings.js";
import Loader from "./Loader.jsx";

const RECENT_WINDOW = 15; // games for the "Last 15" view

const LEADER_CATEGORIES = [
  { key: "homeRuns",         label: "Home Runs",     group: "hitting",  type: "batter",  accent: "#d02a4b", emoji: "💣", statField: "homeRuns",       fmt: v => v },
  { key: "runsBattedIn",     label: "RBI",           group: "hitting",  type: "batter",  accent: "#a16207", emoji: "🏅", statField: "rbi",            fmt: v => v },
  { key: "stolenBases",      label: "Stolen Bases",  group: "hitting",  type: "batter",  accent: "#0a8564", emoji: "🏃", statField: "stolenBases",    fmt: v => v },
  { key: "hits",             label: "Hits",          group: "hitting",  type: "batter",  accent: "#2062c8", emoji: "🎯", statField: "hits",           fmt: v => v },
  { key: "strikeouts",       label: "Strikeouts",    group: "pitching", type: "pitcher", accent: "#0891b2", emoji: "⚾", statField: "strikeOuts",     fmt: v => v },
  { key: "earnedRunAverage", label: "ERA",           group: "pitching", type: "pitcher", accent: "#6d4fd0", emoji: "🛡", statField: null, lowerBetter: true, fmt: v => Number(v).toFixed(2) },
];

// Cache team id → abbreviation (loaded once per app session)
let _teamAbbrevMap = null;
async function getTeamAbbrevMap() {
  if (_teamAbbrevMap) return _teamAbbrevMap;
  const d = await fetchJson(`${API}/teams?sportId=1`);
  const map = {};
  for (const t of d?.teams || []) map[t.id] = t.abbreviation;
  _teamAbbrevMap = map;
  return map;
}

// Returns games-since-last-event from a hitter gameLog (most-recent first after reverse).
// statField: "homeRuns" | "rbi" | "stolenBases" | "hits"
function batterDrought(gameLogSplits, statField) {
  if (!gameLogSplits?.length) return null;
  const recentFirst = [...gameLogSplits].reverse();
  for (let i = 0; i < recentFirst.length; i++) {
    if ((recentFirst[i]?.stat?.[statField] || 0) > 0) return i;
  }
  return recentFirst.length; // never recorded one this season
}

// Pitcher: starts since last start with strikeOuts > line
function pitcherStartsSinceOverLine(gameLogSplits, kLine) {
  if (!gameLogSplits?.length || kLine == null) return null;
  const recentFirst = [...gameLogSplits].reverse();
  for (let i = 0; i < recentFirst.length; i++) {
    if ((recentFirst[i]?.stat?.strikeOuts || 0) > kLine) return i;
  }
  return recentFirst.length;
}

// MLB innings-pitched strings encode thirds in the decimal: "5.2" = 5⅔ = 17 outs.
// This file had the conversion right from the start; it is routed through the shared
// src/lib/innings.js now so there is one definition rather than three (nrfi.js had a
// second, and modelKs had none at all and was parseFloat-ing — fixed 2026-09-08).
const ipToOuts = (ip) => Math.round(ipToDec(ip) * 3);

// Production over the player's last `n` gameLog entries. Counting stats → sum;
// ERA (lowerBetter) → 9·ER/IP. Returns null when it can't be computed (ERA with
// no recorded outs in the window) so the caller can render a dash.
function computeWindowValue(splits, cat, n) {
  const last = (splits || []).slice(-n);
  if (cat.lowerBetter) {
    let er = 0, outs = 0;
    for (const s of last) { er += Number(s.stat?.earnedRuns || 0); outs += ipToOuts(s.stat?.inningsPitched); }
    if (outs === 0) return null;
    return (er * 27) / outs; // 9·ER / (outs/3)
  }
  let sum = 0;
  for (const s of last) sum += Number(s.stat?.[cat.statField] || 0);
  return sum;
}

export default function LeadersBoard({ season, enrichedScanData, onSelectBatter, onSelectPitcher }) {
  const [leaderData, setLeaderData] = useState(null); // { [catKey]: leaders[] }
  const [gameLogs, setGameLogs] = useState({}); // { playerId: splits[] }
  const [teamAbbrev, setTeamAbbrev] = useState({});
  const [injuryMap, setInjuryMap] = useState({}); // playerId → { code, description } for IL players
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [view, setView] = useState("season"); // "season" | "last15"

  // Index today's starting pitchers by playerId for K-line + signal lookup
  const todayPitcherById = useMemo(() => {
    const m = new Map();
    for (const p of (enrichedScanData?.pitchers || [])) {
      if (p.pitcherId) m.set(p.pitcherId, p);
    }
    return m;
  }, [enrichedScanData]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    // Injury statuses resolve independently of the leader/gameLog stream.
    getInjuryMap().then(m => { if (!cancelled) setInjuryMap(m); }).catch(() => {});
    (async () => {
      const abbrevMap = await getTeamAbbrevMap();
      if (cancelled) return;
      setTeamAbbrev(abbrevMap);

      // Fetch all 6 leaderboards in parallel
      const responses = await Promise.all(LEADER_CATEGORIES.map(c =>
        fetchJson(`${API}/stats/leaders?leaderCategories=${c.key}&statGroup=${c.group}&limit=15&season=${season}&sportId=1`)
      ));
      if (cancelled) return;

      const leadersByKey = {};
      const uniquePlayers = new Map(); // id → group ("hitting"|"pitching")
      responses.forEach((resp, i) => {
        const cat = LEADER_CATEGORIES[i];
        const arr = resp?.leagueLeaders?.[0]?.leaders || [];
        leadersByKey[cat.key] = arr;
        for (const l of arr) {
          if (l.person?.id) uniquePlayers.set(l.person.id, cat.group);
        }
      });
      setLeaderData(leadersByKey);

      // Batch-fetch gameLogs (in chunks of 8 to be polite)
      const ids = [...uniquePlayers.entries()];
      setProgress({ done: 0, total: ids.length });
      const logs = {};
      const chunkSize = 8;
      for (let i = 0; i < ids.length; i += chunkSize) {
        if (cancelled) return;
        const chunk = ids.slice(i, i + chunkSize);
        const chunkResults = await Promise.all(chunk.map(([id, group]) =>
          fetchJson(`${API}/people/${id}/stats?stats=gameLog&season=${season}&group=${group}`)
            .then(d => [id, d?.stats?.[0]?.splits || []])
        ));
        for (const [id, splits] of chunkResults) logs[id] = splits;
        if (!cancelled) setProgress({ done: Math.min(i + chunkSize, ids.length), total: ids.length });
      }
      if (cancelled) return;
      setGameLogs(logs);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [season]);

  if (loading && !leaderData) {
    return <div style={{ padding: 40, textAlign: "center", color: "#74839d" }}>
      <Loader text={`Loading league leaders…`} />
    </div>;
  }

  return (
    <div style={{ padding: "20px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, gap: 12, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700, color: "#16233c" }}>📊 League Leaders</div>
          <div style={{ fontSize: 11, color: "#74839d", marginTop: 2 }}>
            {view === "last15"
              ? `Season's top 15 · re-ranked by last ${RECENT_WINDOW} games`
              : `Top 15 · ${season} season`} · live from MLB Stats API
            {loading && progress.total > 0 && (
              <span style={{ marginLeft: 8, color: "#a16207" }}>· loading game logs {progress.done}/{progress.total}</span>
            )}
          </div>
        </div>
        <div style={{ display: "flex", background: "rgba(210,217,236,0.6)", border: "1px solid rgba(32,98,200,0.24)", borderRadius: 8, overflow: "hidden" }}>
          {[{ k: "season", label: "Season" }, { k: "last15", label: `Last ${RECENT_WINDOW}` }].map(opt => (
            <button
              key={opt.k}
              onClick={() => setView(opt.k)}
              title={opt.k === "last15" ? "Re-rank the season leaders by their last 15 games — hot vs. cooling" : "Season-to-date totals"}
              style={{
                padding: "6px 16px", fontSize: 11, fontWeight: 700, cursor: "pointer", border: "none",
                letterSpacing: 0.3, transition: "background 0.12s, color 0.12s",
                background: view === opt.k ? "rgba(32,98,200,0.18)" : "transparent",
                color: view === opt.k ? "#2062c8" : "#74839d",
              }}
            >{opt.label}</button>
          ))}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))", gap: 14 }}>
        {LEADER_CATEGORIES.map(cat => (
          <LeaderCard
            key={cat.key}
            cat={cat}
            view={view}
            leaders={leaderData?.[cat.key] || []}
            gameLogs={gameLogs}
            teamAbbrev={teamAbbrev}
            injuryMap={injuryMap}
            todayPitcherById={todayPitcherById}
            onSelectBatter={onSelectBatter}
            onSelectPitcher={onSelectPitcher}
          />
        ))}
      </div>
    </div>
  );
}

function LeaderCard({ cat, view, leaders, gameLogs, teamAbbrev, injuryMap, todayPitcherById, onSelectBatter, onSelectPitcher }) {
  const isPitcher = cat.type === "pitcher";
  const isLast15 = view === "last15";

  // Derive the active value per leader. In Last-15 mode, recompute from gameLog;
  // hold null until that player's log has loaded so we don't sort on partial data.
  const rows = leaders.map((l, idx) => {
    const pid = l.person?.id;
    const splits = gameLogs[pid] || null; // null === not yet fetched
    const loaded = splits !== null;
    const val = isLast15
      ? (loaded ? computeWindowValue(splits, cat, RECENT_WINDOW) : null)
      : Number(l.value);
    return { l, idx, pid, splits, loaded, val };
  });

  // Only re-rank once every row in the card has a value, so the list doesn't
  // jump around while game logs stream in.
  const allLoaded = !isLast15 || rows.every(r => r.val != null);
  const display = (isLast15 && allLoaded)
    ? [...rows].sort((a, b) => cat.lowerBetter ? (a.val - b.val) : (b.val - a.val))
    : rows;

  const valHeader = isLast15 ? `L${RECENT_WINDOW}` : (cat.key === "earnedRunAverage" ? "ERA" : "Val");

  return (
    <div style={{
      background: "rgba(210,217,236,0.4)",
      border: `1px solid ${cat.accent}33`,
      borderRadius: 10,
      overflow: "hidden",
    }}>
      <div style={{
        padding: "10px 14px",
        background: `linear-gradient(90deg, ${cat.accent}22, transparent)`,
        borderBottom: `1px solid ${cat.accent}33`,
        display: "flex", alignItems: "center", gap: 8,
      }}>
        <span style={{ fontSize: 16 }}>{cat.emoji}</span>
        <div style={{ fontSize: 13, fontWeight: 700, color: cat.accent, letterSpacing: 0.5 }}>{cat.label}</div>
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
        <thead>
          <tr style={{ color: "#74839d", textTransform: "uppercase", fontSize: 9, letterSpacing: 1 }}>
            <th style={{ padding: "6px 6px 6px 12px", textAlign: "left", width: 24 }}>#</th>
            <th style={{ padding: "6px 6px", textAlign: "left" }}>Player</th>
            <th style={{ padding: "6px 6px", textAlign: "left", width: 38 }}>Team</th>
            <th style={{ padding: "6px 6px", textAlign: "right", width: 48 }} title={isLast15 ? `Last ${RECENT_WINDOW} games` : `${cat.label} (season)`}>{valHeader}</th>
            {isPitcher
              ? <>
                  <th style={{ padding: "6px 6px", textAlign: "right", width: 64 }} title="Today's strikeout line · arrow = model edge">K Line</th>
                  <th style={{ padding: "6px 12px 6px 6px", textAlign: "right", width: 56 }} title="Starts since last start with K's over today's line">St W/O</th>
                </>
              : <th style={{ padding: "6px 12px 6px 6px", textAlign: "right", width: 56 }} title={`Games since last ${cat.label.toLowerCase()}`}>G W/O</th>}
          </tr>
        </thead>
        <tbody>
          {display.map((r, rankIdx) => {
            const { l, pid, splits, loaded, val } = r;
            const teamAbbr = teamAbbrev[l.team?.id] || "—";
            const loadingDrought = !loaded;
            let droughtCell;
            let kLineCell = null;

            if (isPitcher) {
              const todayP = todayPitcherById.get(pid);
              const kLine = todayP?.line ?? null;
              const signal = todayP?.signal || null;
              if (kLine != null) {
                const arrow = signal === "over" ? "▲" : signal === "under" ? "▼" : "·";
                const arrowColor = signal === "over" ? "#0f8a44" : signal === "under" ? "#d03131" : "#74839d";
                kLineCell = (
                  <span style={{ fontFamily: "'JetBrains Mono', monospace", color: "#3c4f6d" }}>
                    {kLine.toFixed(1)}
                    <span style={{ color: arrowColor, marginLeft: 4, fontSize: 10 }}>{arrow}</span>
                  </span>
                );
              } else {
                kLineCell = <span style={{ color: "#b6c5dc" }}>—</span>;
              }
              // Drought baseline: today's book line if starting; otherwise fall back to a synthetic 6.5
              const cmpLine = kLine ?? 6.5;
              const d = loadingDrought ? null : pitcherStartsSinceOverLine(splits, cmpLine);
              droughtCell = renderDrought(d, loadingDrought, /*pitcher*/ true);
            } else {
              const d = loadingDrought ? null : batterDrought(splits, cat.statField);
              droughtCell = renderDrought(d, loadingDrought, false);
            }

            // Value cell: season totals come from the API; Last-15 is computed.
            const valDisplay = isLast15
              ? (val == null ? (loaded ? "—" : "…") : cat.fmt(val))
              : cat.fmt(l.value);
            const rankDisplay = isLast15 ? (rankIdx + 1) : (l.rank ?? (rankIdx + 1));

            const onClick = () => {
              if (isPitcher) {
                onSelectPitcher && onSelectPitcher({
                  pitcher: { id: pid, fullName: l.person?.fullName, pitchHand: { code: todayPitcherById.get(pid)?.hand || null } },
                  pitcherTeam: teamAbbr,
                  pitcherScanData: todayPitcherById.get(pid) || null,
                });
              } else {
                onSelectBatter && onSelectBatter({
                  id: pid,
                  fullName: l.person?.fullName,
                  currentTeam: { id: l.team?.id, abbreviation: teamAbbr },
                  team: teamAbbr,
                });
              }
            };

            return (
              <tr key={pid || rankIdx} onClick={onClick}
                onMouseEnter={e => e.currentTarget.style.background = "rgba(32,98,200,0.096)"}
                onMouseLeave={e => e.currentTarget.style.background = "transparent"}
                style={{ cursor: "pointer", borderTop: "1px solid rgba(32,98,200,0.08)", transition: "background 0.12s" }}>
                <td style={{ padding: "7px 6px 7px 12px", color: "#74839d", fontFamily: "'JetBrains Mono', monospace", fontSize: 10 }}>{rankDisplay}</td>
                <td style={{ padding: "7px 6px", color: "#16233c", fontWeight: 500 }}>
                  {l.person?.fullName}
                  {(() => {
                    const inj = injuryMap[pid] || injuryMap[String(pid)];
                    if (!inj) return null;
                    const title = `${ilShortLabel(inj)}${inj.description ? ` · ${inj.description}` : ""}`;
                    return <span title={title} style={{ marginLeft: 5, fontSize: 12, cursor: "help" }}>{INJURY_EMOJI}</span>;
                  })()}
                </td>
                <td style={{ padding: "7px 6px", color: "#5d6f8b", fontSize: 10, fontFamily: "'JetBrains Mono', monospace" }}>{teamAbbr}</td>
                <td style={{ padding: "7px 6px", textAlign: "right", color: cat.accent, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" }}>{valDisplay}</td>
                {isPitcher && <td style={{ padding: "7px 6px", textAlign: "right" }}>{kLineCell}</td>}
                <td style={{ padding: "7px 12px 7px 6px", textAlign: "right" }}>{droughtCell}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function renderDrought(d, isLoading, isPitcher) {
  if (isLoading) return <span style={{ color: "#b6c5dc", fontSize: 10 }}>…</span>;
  if (d == null) return <span style={{ color: "#b6c5dc" }}>—</span>;
  // Color scale: 0 = green (just did it), 1-2 = neutral, 3-5 = amber, 6+ = red
  const threshold = isPitcher ? 3 : 5;
  const color = d === 0 ? "#0f8a44"
              : d <= 2 ? "#3c4f6d"
              : d <= threshold ? "#a16207"
              : "#d03131";
  const fontWeight = d >= threshold + 1 ? 700 : 500;
  return <span style={{ color, fontWeight, fontFamily: "'JetBrains Mono', monospace" }}>{d}</span>;
}
