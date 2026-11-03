// ── Props board — the per-market batter research table ──────────────────────
// Pure display component reading the precomputed scan cache (byModel rows).
// Extracted from App.jsx 2026-07-06 (incremental dissolution) alongside the SB
// board reopen: score-only membership gate, Green-Light columns, watch tier.
import { useState } from "react";
import { BOARD_CONFIGS, calcConfidence, isOfficialPick, batterPickUnits, PICK_UNIT_COLORS } from "../lib/picks.js";
import { boardConviction, TIER } from "../lib/conviction.js";
import { getGateOverride } from "../lib/gateOverrides.js";
import { bestBookOdds, calcEVFromOdds, computeSbGreenLight } from "../lib/models.js";
import { getActiveHealthLookup, applyProbShift } from "../lib/marketHealth.js";
import { getTeamColor, normName } from "../lib/utils.js";
import ConvictionCell, { ConvictionLegend } from "./ConvictionCell.jsx";
import OddsLink, { BOOK_COLORS } from "./OddsLink.jsx";
import PlayerFlagBadges from "./PlayerFlagBadges.jsx";
import StatTiles from "./StatTiles.jsx";
import { getTileById, tileComparator } from "../lib/statTiles.js";

const BATTER_COLS_DEFAULT = [
  { id: "rank",    label: "#",       always: true,  sortKey: null },
  { id: "player",  label: "Player",  always: true,  sortKey: "name" },
  { id: "team",    label: "Team",    always: false, sortKey: "team" },
  { id: "opp",     label: "VS",      always: false, sortKey: "opp" },
  { id: "pitcher", label: "Pitcher", always: false, sortKey: "pitcher" },
  { id: "park",    label: "Park",    always: false, sortKey: "park" },
  { id: "line",    label: "Line",    always: false, sortKey: null },
  { id: "l5",      label: "L5",      always: false, sortKey: "l5" },
  { id: "l10",     label: "L10",     always: false, sortKey: "l10" },
  { id: "avg",     label: "AVG",     always: false, sortKey: "proj" },
  { id: "score",   label: "Score",   always: true,  sortKey: "conf" },
  { id: "ev",      label: "EV%",     always: false, sortKey: "ev" },
  { id: "kelly",   label: "Size",    always: false, sortKey: null },
  { id: "fd",      label: "FD",      always: false, sortKey: "fd" },
  { id: "dk",      label: "DK",      always: false, sortKey: "dk" },
  { id: "hr_odds", label: "HR",      always: false, sortKey: "hr" },
];

// SB-only research columns (2026-07-06 board reopen) — the daily miner's
// validated steal signals surfaced first-class. Merged into the sb board's
// column set only; other boards never see them. Layout (07-07 revision):
// GL index + one light column per green-light actor, headers name the signal
// (emoji + noun), colored light below, raw values in the hover tooltip.
const SB_EXTRA_COLS = [
  { id: "green",     label: "🟢 GL",      always: false, sortKey: "green" },
  { id: "gl_speed",  label: "⚡ Speed",   always: false, sortKey: "gl_speed" },
  { id: "gl_intent", label: "🎯 Intent",  always: false, sortKey: "gl_intent" },
  { id: "gl_hold",   label: "🐌 Hold",    always: false, sortKey: "gl_hold" },
  { id: "gl_catch",  label: "🧤 Catcher", always: false, sortKey: "gl_catch" },
  { id: "pen",       label: "🔥 Bullpen", always: false, sortKey: "pen" },
];

// Traffic-light color for a 0–1 green-light sub-score (null = no measured data).
// Yellow is a true bright traffic-light yellow — the earlier #a16207 amber read
// as orange/brown next to the green and red lights.
const glLightColor = v => v == null ? "#c9d5e8" : v >= 0.67 ? "#0f8a44" : v >= 0.40 ? "#ffd21f" : "#d03131";
// One mini light cell: colored dot, details on hover.
function GlLightCell({ id, value, tip }) {
  return (
    <td key={id} style={{ padding: "10px 3px", textAlign: "center" }} title={tip}>
      <span style={{
        width: 9, height: 9, borderRadius: "50%", display: "inline-block", cursor: "help",
        background: glLightColor(value),
        boxShadow: value != null && value >= 0.67 ? "0 0 5px rgba(15,138,68,0.5)" : "none",
      }} />
    </td>
  );
}
function boardColsDefault(boardKey) {
  if (boardKey !== "sb") return BATTER_COLS_DEFAULT;
  // SB drops AVG (2026-07-07): batting average isn't a steal signal, and the
  // width buys room for the named green-light columns. loadColPrefs filters
  // saved orders against this set, so stale saved "avg" entries self-heal.
  const base = BATTER_COLS_DEFAULT.filter(c => c.id !== "avg");
  const at = base.findIndex(c => c.id === "line") + 1;
  return [...base.slice(0, at), ...SB_EXTRA_COLS, ...base.slice(at)];
}

// Why-a-watch-row-is-interesting chips (display heuristics over captured signals;
// the model math itself lives in models.js — these only pick which to mention).
function sbWatchChips(r) {
  if (!r) return [];
  const chips = [];
  if ((r.rawHpTo1b != null && r.rawHpTo1b <= 4.15) || (r.rawSprintSpeed ?? 0) >= 28.5 || (r.rawBolts ?? 0) >= 15) chips.push("⚡ elite wheels");
  if ((r.rawXbAttAboveAvg ?? -1) > 0.05 || (r.rawSbRateSbx ?? 0) >= 0.02) chips.push("🎯 runs with intent");
  if ((r.pitcherHoldingMult ?? 1) >= 1.10 || (r.rawPitRateSbx ?? 0) >= 0.02) chips.push("🐌 slow to the plate");
  if (((typeof r.catcherMult === "number" ? r.catcherMult : null) ?? r.rawCatcherMult ?? 1) >= 1.08) chips.push("🧤 catcher runs on");
  if ((r.rawBullpenVsLg ?? 1) >= 1.15) chips.push("🔥 pen leaks steals");
  return chips.slice(0, 3);
}


// ── Pure display component — reads from precomputed scan cache ──
export default function PropsBoard({ boardKey, scanData, gameCount, onSelectBatter, onSelectPitcher, lineupData, windowData }) {
  const cfg = BOARD_CONFIGS[boardKey];
  const [showCount, setShowCount] = useState(15);
  const [sortCol, setSortCol] = useState("score");
  const [sortDir, setSortDir] = useState("desc");
  const [sortMode, setSortMode] = useState("conf"); // "proj" | "conf"
  // Sorting the table by a tile's axis. Held separately from sortCol because a tile ranks on
  // a raw Statcast atom that has no board column — clearing it must restore the previous
  // column sort, not fall through to a column that was never selected.
  const [tileSort, setTileSort] = useState(null);
  const [lineFilter, setLineFilter] = useState("all");
  const [colsOpen, setColsOpen] = useState(false);
  const [dragColIdx, setDragColIdx] = useState(null);

  const colPrefsKey = `mlb_colprefs_v1_${boardKey}`;
  const loadColPrefs = () => {
    try {
      const saved = JSON.parse(localStorage.getItem(colPrefsKey) || "null");
      if (saved?.order && Array.isArray(saved.order)) {
        // Drop saved ids that no longer exist in the board's default set (a
        // stale id would render a header with no matching cell → skewed rows).
        const validIds = new Set(boardColsDefault(boardKey).map(c => c.id));
        const kept = saved.order.filter(c => validIds.has(c.id));
        const savedIds = new Set(kept.map(c => c.id));
        return [
          ...kept,
          ...boardColsDefault(boardKey).filter(c => !savedIds.has(c.id)).map(c => ({ ...c, hidden: false })),
        ];
      }
    } catch(e) {}
    return boardColsDefault(boardKey).map(c => ({ ...c, hidden: false }));
  };
  const [colOrder, setColOrder] = useState(loadColPrefs);
  const saveColPrefs = (newOrder) => {
    try { localStorage.setItem(colPrefsKey, JSON.stringify({ order: newOrder })); } catch(e) {}
    setColOrder(newOrder);
  };
  const activeCols = colOrder.filter(c => !c.hidden);

  if (!cfg) return null;

  const handleSort = (col) => {
    if (sortCol === col) setSortDir(d => d === "desc" ? "asc" : "desc");
    else { setSortCol(col); setSortDir("desc"); }
  };

  const SortTh = ({ col, label, title, align = "center", pl, pr, style: extraStyle }) => {
    const active = sortCol === col;
    return (
      <th className="th-sm" onClick={() => handleSort(col)} title={title} style={{
        textAlign: align, cursor: "pointer", userSelect: "none",
        paddingLeft: pl, paddingRight: pr,
        color: active ? "#2062c8" : undefined, whiteSpace: "nowrap",
        ...extraStyle,
      }}>
        {label}{active ? (sortDir === "desc" ? " ▼" : " ▲") : " ⇅"}
      </th>
    );
  };

  const boardRows = scanData?.byModel?.[boardKey] || [];
  const allPicks = boardRows.filter(p => !p.watch);
  // SB watch tier (2026-07-06): research-only rows tagged watch:true at scan
  // time (isSbWatch). Rendered as a grey section below the board; excluded from
  // the pick count, sorting and pagination. Ranked by Green-Light Index.
  const watchRowsRaw = boardKey === "sb" ? boardRows.filter(p => p.watch) : [];
  // Filter to lineup players only when a team has a near-complete lineup (≥8 batters).
  // Partial projected lineups (3–5 players early in the day) would silently drop
  // most of the field — don't filter until lineups are substantially filled in.
  const lineupActive = lineupData && Object.keys(lineupData).length > 0;
  const inConfirmedLineup = pick => {
    const tl = lineupData[pick.team];
    if (!tl?.batters?.length || tl.batters.length < 8) return true; // incomplete lineup — keep all
    return tl.batters.some(b => normName(b.name) === normName(pick.name));
  };
  const lineupPicks = lineupActive ? allPicks.filter(inConfirmedLineup) : allPicks;
  const filteredCount = allPicks.length - lineupPicks.length;
  const watchRows = (lineupActive ? watchRowsRaw.filter(inConfirmedLineup) : watchRowsRaw)
    .sort((a, b) => (computeSbGreenLight(b.result)?.index ?? -1) - (computeSbGreenLight(a.result)?.index ?? -1));

  // Distinct lines available for the line filter dropdown
  const availableLines = [...new Set(lineupPicks.map(p => (p.bookLine ?? p.bestLine?.line)).filter(l => l != null))].sort((a,b)=>a-b);
  const rawPicks = lineFilter === "all"
    ? lineupPicks
    : lineupPicks.filter(p => (p.bookLine ?? p.bestLine?.line) === parseFloat(lineFilter));

  // A tile sort overrides both the column sort and the Proj/Conf toggle — it is an explicit
  // click on a specific axis, which is a stronger statement of intent than either.
  const tileSortDef = tileSort ? getTileById(boardKey, tileSort) : null;
  const effectiveSortCol = sortMode === "conf" ? "conf" : sortCol;
  const picks = tileSortDef
    ? [...rawPicks].sort(tileComparator(tileSortDef, "desc"))
    : [...rawPicks].sort((a, b) => {
    let va, vb;
    switch (effectiveSortCol) {
      case "name":    va = a.name;          vb = b.name;          break;
      case "team":    va = a.team;          vb = b.team;          break;
      case "opp":     va = a.opponent||"";  vb = b.opponent||"";  break;
      case "pitcher": va = a.oppPitcher||""; vb = b.oppPitcher||""; break;
      case "park":    va = a.parkMult??1;   vb = b.parkMult??1;   break;
      case "drought": va = a.drought??0;    vb = b.drought??0;    break;
      case "proj":    va = a.score;         vb = b.score;         break;
      // Rank on the DISPLAYED conviction, not the raw one. Before 2026-08-14
      // these differed: a row capped out by a promoted lab gate kept its raw
      // number, sorted to the top of the board, and then showed no 🎲 — the
      // top eight TB rows all read "10.0" with zero picks among them.
      case "conf":    va = boardConviction(a.score, boardKey, a).conf; vb = boardConviction(b.score, boardKey, b).conf; break;
      case "ev":      va = calcEVFromOdds(a.impliedProb, bestBookOdds(a.bookOdds)) ?? -999; vb = calcEVFromOdds(b.impliedProb, bestBookOdds(b.bookOdds)) ?? -999; break;
      case "l5":      va = a.rateL5 ?? -1; vb = b.rateL5 ?? -1;  break;
      case "l10":     va = a.rateL10 ?? -1; vb = b.rateL10 ?? -1; break;
      case "green":     va = computeSbGreenLight(a.result)?.index   ?? -1; vb = computeSbGreenLight(b.result)?.index   ?? -1; break;
      case "gl_speed":  va = computeSbGreenLight(a.result)?.speed   ?? -1; vb = computeSbGreenLight(b.result)?.speed   ?? -1; break;
      case "gl_intent": va = computeSbGreenLight(a.result)?.intent  ?? -1; vb = computeSbGreenLight(b.result)?.intent  ?? -1; break;
      case "gl_hold":   va = computeSbGreenLight(a.result)?.pitcher ?? -1; vb = computeSbGreenLight(b.result)?.pitcher ?? -1; break;
      case "gl_catch":  va = computeSbGreenLight(a.result)?.catcher ?? -1; vb = computeSbGreenLight(b.result)?.catcher ?? -1; break;
      case "pen":       va = a.result?.rawBullpenVsLg ?? -1;               vb = b.result?.rawBullpenVsLg ?? -1;               break;
      case "fd":      va = a.bookOdds?.fanduel   ?? -9999; vb = b.bookOdds?.fanduel   ?? -9999; break;
      case "dk":      va = a.bookOdds?.draftkings ?? -9999; vb = b.bookOdds?.draftkings ?? -9999; break;
      case "hr":      va = a.bookOdds?.hardrockbet   ?? -9999; vb = b.bookOdds?.hardrockbet   ?? -9999; break;
      default:        va = a.score;         vb = b.score;
    }
    if (typeof va === "string") return sortDir === "desc" ? vb.localeCompare(va) : va.localeCompare(vb);
    // Conviction is rounded to 1dp for display, so a busy board ties a lot —
    // several TB rows share the top value on a normal night. Break ties on the
    // underlying model score so the order is at least meaningful rather than
    // whatever order the scan happened to emit.
    if (va === vb && effectiveSortCol === "conf") return sortDir === "desc" ? b.score - a.score : a.score - b.score;
    return sortDir === "desc" ? vb - va : va - vb;
    });

  const visible = picks.slice(0, showCount);
  const hasMore = picks.length > showCount;

  // Board census by tier. The header used to read "N picks" while counting
  // board ROWS — on a night when every high row was capped out that label was
  // simply false. Count what each row actually is.
  const census = picks.reduce((acc, p) => {
    const t = boardConviction(p.score, boardKey, p).tier;
    acc[t] = (acc[t] || 0) + 1;
    return acc;
  }, {});
  const playCount = census[TIER.play] || 0;
  const foldedCount = (census[TIER.pricedIn] || 0) + (census[TIER.blocked] || 0);
  // A live promoted lab gate is the single most surprising thing about a board
  // ("why is nothing a pick tonight?"), so it says so out loud.
  const override = getGateOverride(boardKey);
  const capNote = override && foldedCount > 0
    ? `Promoted gate live on ${boardKey}: ${[
        override.conf_max != null ? `conviction ≤ ${override.conf_max}` : null,
        override.score_max != null ? `model score ≤ ${override.score_max}` : null,
        override.conf_min != null ? `conviction ≥ ${override.conf_min}` : null,
        override.score_min != null ? `model score ≥ ${override.score_min}` : null,
      ].filter(Boolean).join(" and ")} — ${foldedCount} row${foldedCount !== 1 ? "s" : ""} folded below the play line tonight.`
    : null;

  // One board row — shared by the main table and the SB watch tier.
  const renderRow = (pick, idx, isWatch = false) => {
                const teamColors = getTeamColor(pick.teamId);
                const rank = idx + 1;
                const isTop3 = rank <= 3;
                return (
                  <tr key={`${isWatch ? "w-" : ""}${pick.name}-${pick.teamId}-${idx}`}
                    onClick={() => onSelectBatter && onSelectBatter(pick)}
                    style={{
                      borderBottom: "1px solid rgba(32,98,200,0.064)",
                      background: "transparent",
                      opacity: isWatch ? 0.65 : 1,
                      transition: "background 0.15s", cursor: "pointer",
                    }}
                    onMouseEnter={e => e.currentTarget.style.background = "rgba(32,98,200,0.096)"}
                    onMouseLeave={e => e.currentTarget.style.background = "transparent"}
                  >
                    {activeCols.map((col, ci) => {
                      const isLast = ci === activeCols.length - 1;
                      const pr = isLast ? 12 : 8;
                      if (col.id === "rank") return (
                        <td key="rank" style={{ padding: "10px 12px", fontSize: 12, fontWeight: 700, color: "#6d7c96", fontFamily: "'JetBrains Mono', monospace", position: "sticky", left: 0, zIndex: 1, background: "#ffffff", width: 36 }}>
                          {isWatch ? "👀" : rank}
                        </td>
                      );
                      if (col.id === "player") return (
                        <td key="player" style={{ padding: "10px 8px", position: "sticky", left: 36, zIndex: 1, background: "#ffffff", boxShadow: "2px 0 6px rgba(0,0,0,0.14)", width: 190, maxWidth: 190 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: "#16233c", display: "flex", alignItems: "center", flexWrap: "wrap", gap: 2 }}>
                            {pick.name}<PlayerFlagBadges flags={pick.flags} size={12} />
                          </div>
                          <span style={{ fontSize: 10, color: "#74839d" }}>{pick.position}</span>
                          {isWatch && (
                            <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginTop: 3 }}>
                              {sbWatchChips(pick.result).map(c => (
                                <span key={c} style={{ fontSize: 9, fontWeight: 600, padding: "1px 5px", borderRadius: 6, background: "rgba(32,98,200,0.128)", border: "1px solid rgba(32,98,200,0.24)", color: "#5d6f8b", whiteSpace: "nowrap" }}>{c}</span>
                              ))}
                            </div>
                          )}
                        </td>
                      );
                      if (col.id === "team") return (
                        <td key="team" style={{ padding: "10px 8px", textAlign: "center" }}>
                          <span style={{ fontSize: 11, fontWeight: 700, color: teamColors[0], background: `${teamColors[0]}15`, padding: "2px 8px", borderRadius: 4 }}>
                            {pick.team}
                          </span>
                        </td>
                      );
                      if (col.id === "opp") return (
                        <td key="opp" style={{ padding: "10px 8px", textAlign: "center", fontSize: 11, color: "#5d6f8b" }}>
                          {pick.opponent}
                        </td>
                      );
                      if (col.id === "pitcher") return (
                        <td key="pitcher" style={{ padding: "10px 8px", textAlign: "center", fontSize: 11, color: "#5d6f8b" }}>
                          {pick.oppPitcherId && onSelectPitcher ? (
                            <span
                              onClick={e => { e.stopPropagation(); onSelectPitcher({
                                pitcher: { id: pick.oppPitcherId, fullName: pick.oppPitcher, pitchHand: { code: pick.oppPitcherHand || "R" } },
                                pitcherTeam: pick.opponent,
                                opponentTeam: pick.team,
                              }); }}
                              style={{ cursor: "pointer", textDecoration: "underline", textDecorationStyle: "dotted", textDecorationColor: "rgba(93,111,139,0.4)" }}
                              onMouseEnter={e => e.currentTarget.style.color = "#3c4f6d"}
                              onMouseLeave={e => e.currentTarget.style.color = "#5d6f8b"}
                            >
                              {pick.oppPitcher}
                              {pick.oppPitcherHand && (
                                <span style={{ fontSize: 9, fontWeight: 700, marginLeft: 4, opacity: 0.75,
                                  color: pick.oppPitcherHand === "L" ? "#2569d6" : "#6d4fd0" }}>
                                  ({pick.oppPitcherHand})
                                </span>
                              )}
                            </span>
                          ) : (
                            <>
                              {pick.oppPitcher}
                              {pick.oppPitcherHand && (
                                <span style={{ fontSize: 9, fontWeight: 700, marginLeft: 4, opacity: 0.75,
                                  color: pick.oppPitcherHand === "L" ? "#2569d6" : "#6d4fd0" }}>
                                  ({pick.oppPitcherHand})
                                </span>
                              )}
                            </>
                          )}
                        </td>
                      );
                      if (col.id === "park") return boardKey === "sb" ? (
                        <td key="park" style={{ padding: "10px 8px", textAlign: "center" }}>
                          {pick.drought != null ? (
                            <span style={{ fontSize: 11, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace",
                              color: pick.drought === 0 ? "#0f8a44" : pick.drought <= 3 ? "#a16207" : pick.drought <= 7 ? "#d03131" : "#c62828",
                              background: pick.drought === 0 ? "rgba(15,138,68,0.12)" : pick.drought <= 3 ? "rgba(161,98,7,0.08)" : "rgba(208,49,49,0.1)",
                              padding: "1px 6px", borderRadius: 3 }}>
                              {pick.drought}
                            </span>
                          ) : <span style={{ fontSize: 10, color: "#8b99b0" }}>—</span>}
                        </td>
                      ) : (
                        <td key="park" style={{ padding: "10px 8px", textAlign: "center" }}>
                          {pick.parkMult != null && Math.abs(pick.parkMult - 1) > 0.005 ? (
                            <span style={{ fontSize: 10, fontWeight: 600, padding: "1px 5px", borderRadius: 3,
                              color: pick.parkMult > 1 ? "#0f8a44" : "#d03131",
                              background: pick.parkMult > 1 ? "rgba(15,138,68,0.12)" : "rgba(208,49,49,0.12)" }}>
                              {pick.parkMult > 1 ? "▲" : "▼"}{Math.abs((pick.parkMult - 1) * 100).toFixed(0)}%
                            </span>
                          ) : <span style={{ fontSize: 10, color: "#8b99b0" }}>—</span>}
                        </td>
                      );
                      if (col.id === "line") return (
                        <td key="line" style={{ padding: "10px 8px", textAlign: "center" }}>
                          <span style={{ fontSize: 11, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace",
                            color: "#a16207", background: "rgba(161,98,7,0.1)", padding: "2px 6px", borderRadius: 4 }}>
                            O {pick.bookLine ?? pick.bestLine?.line ?? 0.5}
                          </span>
                        </td>
                      );
                      if (col.id === "l5") return (
                        <td key="l5" style={{ padding: "10px 8px", textAlign: "center" }}>
                          {pick.rateL5 != null ? (
                            <span style={{ fontSize: 11, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace",
                              color: pick.rateL5 >= 0.6 ? "#0f8a44" : pick.rateL5 >= 0.4 ? "#a16207" : "#d03131" }}>
                              {(pick.rateL5 * 100).toFixed(0)}%
                            </span>
                          ) : <span style={{ fontSize: 10, color: "#8b99b0" }}>—</span>}
                        </td>
                      );
                      if (col.id === "l10") return (
                        <td key="l10" style={{ padding: "10px 8px", textAlign: "center" }}>
                          {pick.rateL10 != null ? (
                            <span style={{ fontSize: 11, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace",
                              color: pick.rateL10 >= 0.6 ? "#0f8a44" : pick.rateL10 >= 0.4 ? "#a16207" : "#d03131" }}>
                              {(pick.rateL10 * 100).toFixed(0)}%
                            </span>
                          ) : <span style={{ fontSize: 10, color: "#8b99b0" }}>—</span>}
                        </td>
                      );
                      if (col.id === "avg") return (
                        <td key="avg" style={{ padding: "10px 8px", textAlign: "center" }}>
                          <span style={{ fontSize: 13, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace",
                            color: pick.seasonAvg >= 0.300 ? "#0f8a44" : pick.seasonAvg > 0 && pick.seasonAvg < 0.220 ? "#d03131" : "#2062c8" }}>
                            {pick.seasonAvg != null && pick.seasonAB > 0 ? pick.seasonAvg.toFixed(3).replace(/^0/, "") : "—"}
                          </span>
                        </td>
                      );
                      if (col.id === "score") return (
                        <td key="score" style={{ padding: "10px 8px", textAlign: "center" }}>
                          <ConvictionCell c={boardConviction(pick.score, boardKey, pick)} stack />
                        </td>
                      );
                      if (col.id === "ev") return (
                        <td key="ev" style={{ padding: "10px 8px", textAlign: "center" }}>
                          {(() => {
                            const bestOdds = bestBookOdds(pick.bookOdds);
                            // EV lens runs through the edge-controller's rolling calibration
                            // correction (market_health.prob_shift) so a drifted-hot market
                            // can't show flattering edges. Raw modelImpliedProb untouched.
                            const evShift = getActiveHealthLookup()?.latest?.(boardKey)?.prob_shift;
                            const pAdj = applyProbShift(pick.impliedProb, evShift);
                            const ev = calcEVFromOdds(pAdj, bestOdds);
                            if (ev == null) return <span style={{ fontSize: 10, color: "#8b99b0" }}>—</span>;
                            const isPos = ev > 0;
                            const showInfo = ev >= 0.90;
                            const modelPct = pAdj != null ? (pAdj * 100).toFixed(1) + "%" + (evShift != null ? " (ctrl-adj)" : "") : "—";
                            const bookImplied = bestOdds != null
                              ? (bestOdds > 0 ? (100 / (bestOdds + 100)) : (Math.abs(bestOdds) / (Math.abs(bestOdds) + 100))) * 100 : null;
                            const bookPct = bookImplied != null ? bookImplied.toFixed(1) + "%" : "—";
                            const bestLine = pick.bestLine?.line ?? 0.5;
                            const tooltip = showInfo ? `Why +${(ev*100).toFixed(0)}% EV?\nLine: O${bestLine}\nModel probability: ${modelPct}\nBook implied: ${bookPct} (${bestOdds > 0 ? "+" : ""}${bestOdds})\nEdge = model sees ${modelPct} vs book's ${bookPct}` : null;
                            return (
                              <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                                <span style={{ fontSize: 11, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace",
                                  color: isPos ? "#0f8a44" : "#d03131",
                                  background: isPos ? "rgba(15,138,68,0.08)" : "transparent",
                                  padding: "1px 4px", borderRadius: 3 }}>
                                  {isPos ? "+" : ""}{(ev * 100).toFixed(0)}%
                                </span>
                                {showInfo && <span title={tooltip} style={{ fontSize: 10, color: "#b45309", cursor: "help", fontWeight: 700, lineHeight: 1 }}>ⓘ</span>}
                              </span>
                            );
                          })()}
                        </td>
                      );
                      if (col.id === "kelly") {
                        const kConf = calcConfidence(pick.score, boardKey, pick);
                        const kOfficial = isOfficialPick(kConf, boardKey, pick);
                        if (!kOfficial) return <td key="kelly" style={{ padding: "10px 8px", textAlign: "center" }}><span style={{ fontSize: 10, color: "#b6c5dc" }}>—</span></td>;
                        const kUnits = batterPickUnits(kConf, boardKey, pick);
                        if (!kUnits) return <td key="kelly" style={{ padding: "10px 8px", textAlign: "center" }}><span style={{ fontSize: 10, color: "#b6c5dc" }}>—</span></td>;
                        const kColor = PICK_UNIT_COLORS[kUnits];
                        return (
                          <td key="kelly" style={{ padding: "10px 8px", textAlign: "center" }}>
                            <span style={{ fontSize: 11, fontWeight: 700, fontFamily: "'JetBrains Mono',monospace", color: kColor, background: `${kColor}18`, padding: "1px 6px", borderRadius: 4, whiteSpace: "nowrap" }}>
                              {kUnits}u{kUnits === 5 ? " 💪" : ""}
                            </span>
                          </td>
                        );
                      }
                      if (col.id === "green") {
                        const gl = computeSbGreenLight(pick.result);
                        if (!gl || gl.index == null) return <td key="green" style={{ padding: "10px 8px", textAlign: "center" }}><span style={{ fontSize: 10, color: "#8b99b0" }}>—</span></td>;
                        const idxColor = gl.index >= 67 ? "#0f8a44" : gl.index >= 45 ? "#a16207" : "#d03131";
                        return (
                          <td key="green" style={{ padding: "10px 8px", textAlign: "center" }} title={`Green-Light Index ${gl.index}/100 — availability-weighted blend of the four actor lights to the right`}>
                            <span style={{ fontSize: 13, fontWeight: 700, fontFamily: "'JetBrains Mono',monospace", color: idxColor, cursor: "help" }}>{gl.index}</span>
                          </td>
                        );
                      }
                      if (col.id === "gl_speed" || col.id === "gl_intent" || col.id === "gl_hold" || col.id === "gl_catch") {
                        const gl = computeSbGreenLight(pick.result);
                        const r = pick.result || {};
                        const pct = v => v == null ? "no data" : `${Math.round(v * 100)}/100`;
                        if (col.id === "gl_speed") {
                          const raw = r.rawHpTo1b != null ? `${r.rawHpTo1b.toFixed(2)}s home→1B (league ≈4.40)`
                            : r.rawSprintSpeed != null ? `${r.rawSprintSpeed.toFixed(1)} ft/s sprint (league ≈27.0)` : "no measured speed";
                          return <GlLightCell key="gl_speed" id="gl_speed" value={gl?.speed} tip={`⚡ Runner speed ${pct(gl?.speed)}\n${raw}`} />;
                        }
                        if (col.id === "gl_intent") {
                          const parts = [];
                          if (r.rawXbAttAboveAvg != null) parts.push(`XB attempts ${r.rawXbAttAboveAvg > 0 ? "+" : ""}${(r.rawXbAttAboveAvg * 100).toFixed(1)}% vs expected`);
                          if (r.rawSbRateSbx != null) parts.push(`xSteal rate ${(r.rawSbRateSbx * 100).toFixed(1)}% (league 1.3%)`);
                          else if (r.rawSbAttemptRate != null) parts.push(`attempt rate ${(r.rawSbAttemptRate * 100).toFixed(1)}%`);
                          return <GlLightCell key="gl_intent" id="gl_intent" value={gl?.intent} tip={`🎯 Runner intent ${pct(gl?.intent)}\n${parts.join("\n") || "no measured intent"}`} />;
                        }
                        if (col.id === "gl_hold") {
                          const m = r.pitcherHoldingMult ?? 1.0;
                          return <GlLightCell key="gl_hold" id="gl_hold" value={gl?.pitcher} tip={`🐌 Pitcher hold ${pct(gl?.pitcher)}\nholding mult ${m > 1 ? "+" : ""}${((m - 1) * 100).toFixed(0)}% (green = easy to run on)`} />;
                        }
                        const cm = (typeof r.catcherMult === "number" ? r.catcherMult : null) ?? r.rawCatcherMult;
                        return <GlLightCell key="gl_catch" id="gl_catch" value={gl?.catcher} tip={`🧤 Catcher ${pct(gl?.catcher)}\n${cm != null ? `catcher mult ×${cm.toFixed(2)} (green = gets run on)` : "no catcher data"}`} />;
                      }
                      if (col.id === "pen") {
                        const v = pick.result?.rawBullpenVsLg;
                        // Not a GL actor (not in the index) — same light language, ratio-scaled
                        // so green starts at ×1.10 and red at ×0.90 (matches the header title).
                        const norm = v != null ? Math.max(0, Math.min(1, 0.5 + (v - 1) * 1.7)) : null;
                        return <GlLightCell key="pen" id="pen" value={norm} tip={`🔥 Bullpen ${v != null ? `×${v.toFixed(2)} expected-steal-rate vs league` : "no data"} (green = pen leaks steals)`} />;
                      }
                      // Book odds columns
                      const bookMap = { fd: "fanduel", dk: "draftkings", hr_odds: "hardrockbet" };
                      const bk = bookMap[col.id];
                      if (bk) {
                        const books = ["fanduel","draftkings","hardrockbet"];
                        const allPrices = books.map(b => pick.bookOdds?.[b]).filter(v => v != null);
                        const thisPrice = pick.bookOdds?.[bk] ?? null;
                        const isBest = thisPrice != null && allPrices.length > 0 && thisPrice === Math.max(...allPrices);
                        return (
                          // Center-aligned even when last — matches the header fix
                          // that closed the giant DK↔HR slack gap.
                          <td key={col.id} style={{ padding: `10px ${pr}px`, textAlign: "center" }}>
                            <OddsLink price={thisPrice} url={pick.bookLinks?.[bk]} isBest={isBest} bk={bk}
                              style={{ fontSize: 12, background: isBest ? `${BOOK_COLORS[bk]}18` : "transparent", padding: isBest ? "1px 5px" : "0", borderRadius: isBest ? 4 : 0 }} />
                          </td>
                        );
                      }
                      return null;
                    })}
                  </tr>
                );
  };

  return (
    <div style={{ padding: "20px", minHeight: "calc(100vh - 120px)" }}>
      {/* Statcast tile strip. Built from lineupPicks — the same lineup filter the table
          applies, but before the line filter, so the tiles describe today's slate rather
          than whichever line the reader happens to be looking at. */}
      <div style={{ margin: "-20px -20px 4px" }}>
        <StatTiles
          boardKey={boardKey}
          rows={lineupPicks}
          windowData={windowData}
          onSelectBatter={onSelectBatter}
          onSortByTile={id => setTileSort(cur => (cur === id ? null : id))}
          activeSort={tileSort}
        />
      </div>

      {/* Board Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
        <span style={{ fontSize: 28 }}>{cfg.emoji}</span>
        <div>
          <div style={{ fontSize: 20, fontWeight: 700, color: "#16233c" }}>{cfg.label}</div>
          <div style={{ fontSize: 10, color: "#8b99b0", marginTop: 1 }}>
            Conviction 1–10 · <span style={{ color: "#0f8a44", fontWeight: 700 }}>🎲 play line {cfg.pickThresh.toFixed(1)}</span>
          </div>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 12, fontFamily: "'JetBrains Mono', monospace",
            color: playCount > 0 ? "#0f8a44" : "#8b99b0", fontWeight: 700 }}
            title={playCount > 0 ? "Rows at or above the play line — these get saved to Results" : "No row on this board clears the play line today"}>
            🎲 {playCount} play{playCount !== 1 ? "s" : ""}
          </span>
          <span style={{ fontSize: 12, color: "#74839d", fontFamily: "'JetBrains Mono', monospace" }}
            title="Rows on the research board (every row the market surfaces, play or not)">
            {picks.length} on board
          </span>
          {foldedCount > 0 && (
            <span title={capNote || "Rows the model liked that a gate overruled"} style={{
              fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 10, cursor: "help",
              background: "rgba(194,87,15,0.12)", color: "#c2570f", border: "1px solid rgba(194,87,15,0.25)",
            }}>
              ⚑ {foldedCount} capped
            </span>
          )}
          {filteredCount > 0 && (
            <span title={`${filteredCount} player${filteredCount !== 1 ? "s" : ""} filtered — not in today's lineup`} style={{
              fontSize: 10, fontWeight: 600, padding: "2px 7px", borderRadius: 10,
              background: "rgba(15,138,68,0.1)", color: "#0f8a44", border: "1px solid rgba(15,138,68,0.2)",
            }}>
              ✓ Lineup filtered · {filteredCount} out
            </span>
          )}
          {availableLines.length > 1 && (
            <select value={lineFilter} onChange={e => setLineFilter(e.target.value)} style={{
              background: "#edf2fa", border: "1px solid rgba(32,98,200,0.2)",
              color: lineFilter !== "all" ? "#2062c8" : "#5d6f8b",
              borderRadius: 8, padding: "3px 8px", fontSize: 10, fontWeight: 600,
              cursor: "pointer", outline: "none", marginLeft: 4,
            }}>
              <option value="all">All Lines</option>
              {availableLines.map(l => <option key={l} value={String(l)}>O{l}</option>)}
            </select>
          )}
          {tileSortDef && (
            <button onClick={() => setTileSort(null)}
              title="Sorted by a Statcast tile — click to return to the board's own sort"
              style={{
                padding: "3px 10px", fontSize: 10, fontWeight: 700, borderRadius: 10,
                background: "rgba(32,98,200,0.24)", border: "1px solid rgba(32,98,200,0.45)",
                color: "#2062c8", cursor: "pointer", marginLeft: 4,
              }}>
              {tileSortDef.emoji} {tileSortDef.label} ✕
            </button>
          )}
          <button onClick={() => setSortMode(m => m === "proj" ? "conf" : "proj")} style={{
            padding: "3px 10px", fontSize: 10, fontWeight: 600, borderRadius: 10,
            background: sortMode === "conf" && !tileSortDef ? "rgba(32,98,200,0.24)" : "rgba(22,44,80,0.05)",
            border: "1px solid rgba(32,98,200,0.2)", color: sortMode === "conf" && !tileSortDef ? "#2062c8" : "#74839d",
            cursor: "pointer", marginLeft: 4, opacity: tileSortDef ? 0.5 : 1,
          }}>
            {sortMode === "proj" ? "Sort: Proj ⇅" : "Sort: Conf ⇅"}
          </button>
          <button onClick={() => setColsOpen(o => !o)} style={{
            padding: "3px 10px", fontSize: 10, fontWeight: 600, borderRadius: 10,
            background: colsOpen ? "rgba(139,47,201,0.15)" : "rgba(22,44,80,0.05)",
            border: `1px solid ${colsOpen ? "rgba(139,47,201,0.4)" : "rgba(22,44,80,0.1)"}`,
            color: colsOpen ? "#8b2fc9" : "#74839d",
            cursor: "pointer", marginLeft: 4,
          }}>
            ⚙ Cols
          </button>
        </div>
      </div>

      {/* Promoted-gate banner — why the top of this board may have no dice */}
      {capNote && (
        <div style={{
          marginBottom: 16, padding: "9px 14px", borderRadius: 10, fontSize: 11, lineHeight: 1.6,
          background: "rgba(194,87,15,0.07)", border: "1px solid rgba(194,87,15,0.22)", color: "#8a4a12",
        }}>
          <strong style={{ color: "#c2570f" }}>⚑ {capNote}</strong>{" "}
          Those rows stay on the board — the model still likes the bat — but this market's most-confident
          picks are a validated money-loser, so they rank below the plays instead of above them.
        </div>
      )}

      {/* Column editor panel */}
      {colsOpen && (
        <div style={{
          marginBottom: 16, padding: "12px 16px",
          background: "rgba(139,47,201,0.06)", border: "1px solid rgba(139,47,201,0.2)",
          borderRadius: 10, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center",
        }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: "#8b2fc9", marginRight: 4 }}>Columns:</span>
          {colOrder.map((col, idx) => (
            <div key={col.id} draggable={!col.always}
              onDragStart={() => setDragColIdx(idx)}
              onDragOver={e => { e.preventDefault(); }}
              onDrop={() => {
                if (dragColIdx == null || dragColIdx === idx) return;
                const next = [...colOrder];
                const [moved] = next.splice(dragColIdx, 1);
                next.splice(idx, 0, moved);
                setDragColIdx(null);
                saveColPrefs(next);
              }}
              style={{
                display: "flex", alignItems: "center", gap: 5, padding: "3px 8px",
                borderRadius: 6, fontSize: 11, fontWeight: 600,
                background: col.hidden ? "rgba(22,44,80,0.04)" : "rgba(139,47,201,0.12)",
                border: `1px solid ${col.hidden ? "rgba(22,44,80,0.08)" : "rgba(139,47,201,0.3)"}`,
                color: col.hidden ? "#8b99b0" : "#7a5fd0",
                cursor: col.always ? "default" : "grab",
                opacity: col.hidden ? 0.6 : 1,
                userSelect: "none",
              }}>
              {!col.always && (
                <input type="checkbox" checked={!col.hidden} onChange={() => {
                  const next = colOrder.map((c, i) => i === idx ? { ...c, hidden: !c.hidden } : c);
                  saveColPrefs(next);
                }} style={{ cursor: "pointer", margin: 0 }} />
              )}
              {!col.always && <span style={{ fontSize: 9, opacity: 0.5 }}>⠿</span>}
              {col.label}
            </div>
          ))}
          <button onClick={() => { saveColPrefs(boardColsDefault(boardKey).map(c => ({ ...c, hidden: false }))); }}
            style={{ marginLeft: "auto", padding: "3px 8px", fontSize: 10, borderRadius: 6, cursor: "pointer",
              background: "rgba(22,44,80,0.05)", border: "1px solid rgba(22,44,80,0.1)", color: "#74839d" }}>
            Reset
          </button>
        </div>
      )}

      {/* No picks */}
      {picks.length === 0 && watchRows.length === 0 && (
        <div style={{ padding: "40px 20px", textAlign: "center" }}>
          <div style={{ fontSize: 40, marginBottom: 12, opacity: 0.3 }}>🔍</div>
          <div style={{ fontSize: 14, color: "#6d7c96" }}>No {cfg.label} picks found for today</div>
          <div style={{ fontSize: 12, color: "#8b99b0", marginTop: 4 }}>
            The model didn't find any batters clearing the threshold.
          </div>
        </div>
      )}

      {/* Picks table */}
      {(visible.length > 0 || watchRows.length > 0) && (
        <div style={{ background: "rgba(210,217,236,0.4)", borderRadius: 12, border: "1px solid rgba(32,98,200,0.128)", overflow: "hidden" }}>
          <div className="hscroll">
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 600 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid rgba(32,98,200,0.16)" }}>
                {activeCols.map((col, ci) => {
                  const isLast = ci === activeCols.length - 1;
                  if (col.id === "rank") return <th key="rank" className="th-sm" style={{ textAlign: "left", paddingLeft: 12, position: "sticky", left: 0, zIndex: 3, background: "#ffffff", width: 36 }}>#</th>;
                  if (col.id === "player") return <SortTh key="player" col="name" label="Player" align="left" style={{ position: "sticky", left: 36, zIndex: 3, background: "#ffffff", boxShadow: "2px 0 6px rgba(0,0,0,0.14)", width: 190, maxWidth: 190 }} />;
                  if (col.id === "line") return <th key="line" className="th-sm" style={{ textAlign: "center", whiteSpace: "nowrap", color: "#74839d" }}>Line</th>;
                  if (col.id === "avg") return <SortTh key="avg" col="proj" label="AVG" title="Current season batting average" />;
                  if (col.id === "score") return <SortTh key="score" col="conf" label="Conviction" title={`Model conviction 1–10. 🎲 at ${cfg.pickThresh.toFixed(1)} and above = official play, saved to Results. A row that the model liked but a gate overruled folds below the line with a chip saying which gate.`} />;
                  if (col.id === "kelly") return <th key="kelly" className="th-sm" style={{ textAlign: "center", color: "#74839d", whiteSpace: "nowrap" }} title="Quarter-Kelly bet size on 1–5 unit scale">Size</th>;
                  // hr_odds stays center-aligned even as the last column — right-
                  // aligning it pinned the values to the table edge, so all the
                  // table's slack width read as a giant DK↔HR gap.
                  if (col.id === "hr_odds") return <SortTh key="hr_odds" col="hr" label="HR" align="center" pr={isLast ? 12 : undefined} />;
                  if (col.id === "park" && boardKey === "sb") return <SortTh key="park" col="drought" label="G W/O" title="Games without a stolen base (consecutive)" align={isLast ? "right" : "center"} pr={isLast ? 12 : undefined} />;
                  if (col.id === "green")     return <SortTh key="green" col="green" label="🟢 GL" title="Green-Light Index 0–100 — runner speed × intent × pitcher hold × catcher, from computeSbGreenLight (display decomposition; not a score input)" />;
                  if (col.id === "gl_speed")  return <SortTh key="gl_speed"  col="gl_speed"  label="⚡ Speed" title="Runner speed — home-to-first (league ≈4.40s, elite ≈4.0; a steal is a standing start), sprint ft/s fallback. Hover a light for the raw value" pl={4} pr={4} />;
                  if (col.id === "gl_intent") return <SortTh key="gl_intent" col="gl_intent" label="🎯 Intent" title="Runner intent — extra-base attempt rate above context-expected + steal-attempt propensity vs league. Hover a light for the raw values" pl={4} pr={4} />;
                  if (col.id === "gl_hold")   return <SortTh key="gl_hold"   col="gl_hold"   label="🐌 Hold" title="Pitcher hold — the model's holding multiplier led by Statcast rate_sbx (expected steal rate allowed). Green = easy to run on" pl={4} pr={4} />;
                  if (col.id === "gl_catch")  return <SortTh key="gl_catch"  col="gl_catch"  label="🧤 Catcher" title="Catcher — pop-time/CS multiplier. Green = catcher gets run on" pl={4} pr={4} />;
                  if (col.id === "pen")       return <SortTh key="pen"       col="pen"       label="🔥 Bullpen" title="Opposing bullpen expected-steal-rate vs league (relievers throw the steal-prone late innings). Green ≥ ×1.10 = pen leaks steals" pl={4} pr={4} />;
                  if (col.sortKey) return <SortTh key={col.id} col={col.sortKey} label={col.label} align={isLast ? "right" : "center"} pr={isLast ? 12 : undefined} />;
                  return <th key={col.id} className="th-sm" style={{ textAlign: "center", color: "#74839d" }}>{col.label}</th>;
                })}
              </tr>
            </thead>
            <tbody>
              {visible.map((pick, idx) => renderRow(pick, idx))}
              {watchRows.length > 0 && (
                <>
                  <tr>
                    <td colSpan={activeCols.length} style={{ padding: "10px 12px", background: "rgba(32,98,200,0.064)", borderTop: "1px solid rgba(32,98,200,0.192)", fontSize: 10, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: "#6d7c96" }}>
                      👀 Watch list · {watchRows.length} — below the board floor, but the matchup is interesting. Research only, never picked.
                    </td>
                  </tr>
                  {watchRows.map((pick, idx) => renderRow(pick, idx, true))}
                </>
              )}
            </tbody>
          </table>
          </div>{/* end overflowX scroll wrapper */}

          {/* Show More button */}
          {hasMore && (
            <div style={{ padding: "12px", borderTop: "1px solid rgba(32,98,200,0.096)", textAlign: "center" }}>
              <button
                onClick={() => setShowCount(prev => prev + 50)}
                style={{
                  background: "rgba(32,98,200,0.16)", border: "1px solid rgba(32,98,200,0.2)",
                  borderRadius: 8, padding: "10px 24px", color: "#2062c8", fontSize: 12,
                  fontWeight: 600, cursor: "pointer", transition: "all 0.15s",
                }}
                onMouseEnter={e => { e.currentTarget.style.background = "rgba(32,98,200,0.2)"; }}
                onMouseLeave={e => { e.currentTarget.style.background = "rgba(32,98,200,0.16)"; }}
              >
                Show {Math.min(50, picks.length - showCount)} More ({picks.length - showCount} remaining)
              </button>
            </div>
          )}

          {/* Summary footer */}
          <div style={{ padding: "10px 12px", borderTop: "1px solid rgba(32,98,200,0.096)", display: "flex", justifyContent: "space-between" }}>
            <span style={{ fontSize: 10, color: "#8b99b0" }}>
              Showing {Math.min(showCount, picks.length)} of {picks.length} · Sorted by {sortCol} {sortDir === "desc" ? "▼" : "▲"}{watchRows.length > 0 ? ` · +${watchRows.length} on watch` : ""}
            </span>
            <span style={{ fontSize: 10, color: "#8b99b0" }}>
              {gameCount} games scanned
            </span>
          </div>

          {/* Conviction legend — what the number means and where the dice starts */}
          <div style={{ padding: "8px 12px 11px", borderTop: "1px solid rgba(32,98,200,0.096)" }}>
            <ConvictionLegend line={cfg.pickThresh} />
          </div>
        </div>
      )}
    </div>
  );
}

