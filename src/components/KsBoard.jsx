// ── Pitcher Strikeouts board ────────────────────────────────────────────────
// Extracted from App.jsx when the Statcast tile strip landed (project rule: any component
// meaningfully edited inside App.jsx moves to src/components in the same commit).
//
// Dual-model board: xK (Bayesian blend) and K-Edge (stable baseline), with the Mx multiplier
// atoms spread onto each row at scan time. The tile strip above the table ranks today's
// starters on the strikeout skills those atoms carry — see src/lib/statTiles.js.
import { useState } from "react";
import { isOfficialKsPick, ksPickDirection, ksPickUnits, PICK_UNIT_COLORS } from "../lib/picks.js";
import { ksConviction, KS_PLAY_LINE, TIER } from "../lib/conviction.js";
import { getTileById, tileComparator } from "../lib/statTiles.js";
import ConvictionCell, { ConvictionLegend } from "./ConvictionCell.jsx";
import OddsLink, { BOOK_COLORS } from "./OddsLink.jsx";
import StatTiles from "./StatTiles.jsx";

const KS_COLS_DEFAULT = [
  { id: "rank",    label: "#",        always: true,  sortKey: null },
  { id: "pitcher", label: "Pitcher",  always: true,  sortKey: "name" },
  { id: "team",    label: "Team",     always: false, sortKey: "team" },
  { id: "opp",     label: "Opp",      always: false, sortKey: "opp" },
  { id: "hand",    label: "Hand",     always: false, sortKey: "hand" },
  { id: "projIP",  label: "Proj IP",  always: false, sortKey: "projIP" },
  { id: "xK",      label: "xK",       always: true,  sortKey: "xK" },
  { id: "kEdge",   label: "K-Edge",   always: false, sortKey: "kEdge" },
  { id: "stddev",  label: "±σ",       always: false, sortKey: "stddev" },
  { id: "whiff",   label: "Whiff%",   always: false, sortKey: "swStr" },
  { id: "fstrike", label: "F-Str%",   always: false, sortKey: "fStrike" },
  { id: "chase",   label: "Chase%",   always: false, sortKey: "chase" },
  { id: "line",    label: "Line",     always: false, sortKey: "line" },
  { id: "edge",    label: "Edge",     always: false, sortKey: "xKEdge" },
  { id: "score",    label: "Conf",     always: true,  sortKey: "conf" },
  { id: "signal",  label: "Signal",   always: false, sortKey: "signal" },
  { id: "ks_kelly", label: "Size",     always: false, sortKey: null },
  { id: "ks_fd",   label: "FD",       always: false, sortKey: "ks_fd" },
  { id: "ks_dk",   label: "DK",       always: false, sortKey: "ks_dk" },
  { id: "ks_hr",   label: "HR",       always: false, sortKey: "ks_hr" },
];

export default function KsBoard({ scanData, onSelectPitcher, windowData }) {
  const [sortCol, setSortCol] = useState("xK");
  // Sorting the table by a tile's axis. Separate from sortCol because a tile ranks on a raw
  // Statcast atom with no board column of its own — clearing it must restore the column sort.
  const [tileSort, setTileSort] = useState(null);
  const [sortDir, setSortDir] = useState("desc");
  const [sortMode, setSortMode] = useState("conf"); // "proj" | "conf"
  const [ksColsOpen, setKsColsOpen] = useState(false);
  const [ksDragIdx, setKsDragIdx] = useState(null);
  const ksColKey = "mlb_colprefs_v1_ks";
  const loadKsColPrefs = () => {
    try {
      const saved = JSON.parse(localStorage.getItem(ksColKey) || "null");
      if (saved?.order && Array.isArray(saved.order)) {
        const validIds = new Set(KS_COLS_DEFAULT.map(c => c.id));
        const cleaned = saved.order.filter(c => validIds.has(c.id));
        const savedIds = new Set(cleaned.map(c => c.id));
        return [...cleaned, ...KS_COLS_DEFAULT.filter(c => !savedIds.has(c.id)).map(c => ({ ...c, hidden: false }))];
      }
    } catch(e) {}
    return KS_COLS_DEFAULT.map(c => ({ ...c, hidden: false }));
  };
  const [ksColOrder, setKsColOrder] = useState(loadKsColPrefs);
  const saveKsColPrefs = (newOrder) => {
    try { localStorage.setItem(ksColKey, JSON.stringify({ order: newOrder })); } catch(e) {}
    setKsColOrder(newOrder);
  };
  const ksActiveCols = ksColOrder.filter(c => !c.hidden);

  const handleSort = (col) => {
    if (sortCol === col) setSortDir(d => d === "desc" ? "asc" : "desc");
    else { setSortCol(col); setSortDir("desc"); }
  };

  const SortTh = ({ col, label, title, align = "center" }) => {
    const active = sortCol === col && sortMode === "proj";
    return (
      <th className="th-sm" onClick={() => { setSortMode("proj"); handleSort(col); }}
        title={title}
        style={{ textAlign: align, cursor: "pointer", userSelect: "none",
          color: active ? "#2062c8" : undefined, whiteSpace: "nowrap" }}>
        {label}{active ? (sortDir === "desc" ? " ▼" : " ▲") : " ⇅"}
      </th>
    );
  };

  const tileSortDef = tileSort ? getTileById("ks", tileSort) : null;
  const pitchers = tileSortDef
    ? [...(scanData?.pitchers || [])].sort(tileComparator(tileSortDef, "desc"))
    : [...(scanData?.pitchers || [])].sort((a, b) => {
    const effectiveCol = sortMode === "conf" ? "conf" : sortCol;
    let va, vb;
    switch (effectiveCol) {
      case "name":       va = a.name;           vb = b.name;           break;
      case "team":       va = a.team;           vb = b.team;           break;
      case "opp":        va = a.opponent;       vb = b.opponent;       break;
      case "hand":       va = a.hand;           vb = b.hand;           break;
      case "projIP":     va = a.projIP;         vb = b.projIP;         break;
      case "kEdge":      va = a.kEdge;          vb = b.kEdge;          break;
      case "line":       va = a.line;           vb = b.line;           break;
      case "xKEdge":     va = a.xKEdge;         vb = b.xKEdge;         break;
      case "swStr":      va = a.swStrPct ?? -1;      vb = b.swStrPct ?? -1;      break;
      case "fStrike":    va = a.fStrikePct ?? -1;    vb = b.fStrikePct ?? -1;    break;
      case "chase":      va = a.ozSwingPct ?? -1;    vb = b.ozSwingPct ?? -1;    break;
      case "oppK":       va = a.oppKRatePct ?? -1;   vb = b.oppKRatePct ?? -1;   break;
      case "stddev":     va = -(a.l5Stddev ?? 99); vb = -(b.l5Stddev ?? 99); break;
      // Rank on the DISPLAYED conviction: a 9.6 over at O7.5 is not a play
      // (the book is sharp there) and must not outrank the 8.7 under that is.
      case "conf":       va = ksConviction(a).conf; vb = ksConviction(b).conf; break;
      case "signal": {
        const sv = s => s === "over" ? 2 : s === "under" ? 0 : 1;
        va = sv(a.signal); vb = sv(b.signal); break;
      }
      case "ks_fd":  va = a.bookOdds?.fanduel   ?? -9999; vb = b.bookOdds?.fanduel   ?? -9999; break;
      case "ks_dk":  va = a.bookOdds?.draftkings ?? -9999; vb = b.bookOdds?.draftkings ?? -9999; break;
      case "ks_hr":  va = a.bookOdds?.hardrockbet   ?? -9999; vb = b.bookOdds?.hardrockbet   ?? -9999; break;
      default:           va = a.xK;             vb = b.xK;
    }
    if (typeof va === "string") return sortDir === "desc" ? vb.localeCompare(va) : va.localeCompare(vb);
    return sortDir === "desc" ? vb - va : va - vb;
  });

  const signalColor = { over: "#0f8a44", under: "#d03131", neutral: "#74839d" };
  const signalLabel = { over: "▲ OVER", under: "▼ UNDER", neutral: "—" };

  if (!scanData?.pitchers) {
    return <div style={{ padding: "40px 20px", textAlign: "center", color: "#74839d" }}>Loading pitcher data…</div>;
  }
  if (pitchers.length === 0) {
    return <div style={{ padding: "40px 20px", textAlign: "center", color: "#74839d" }}>No probable starters available for this date.</div>;
  }

  return (
    <div style={{ padding: "20px", minHeight: "calc(100vh - 120px)" }}>
      {/* Statcast tile strip — the same component the batter boards use, on the ks tile set. */}
      <div style={{ margin: "-20px -20px 4px" }}>
        <StatTiles
          boardKey="ks"
          rows={pitchers}
          windowData={windowData}
          onSelectPitcher={onSelectPitcher}
          onSortByTile={id => setTileSort(cur => (cur === id ? null : id))}
          activeSort={tileSort}
        />
      </div>

      {/* Board Header — matches PropsBoard style */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
        <span style={{ fontSize: 28 }}>⚾</span>
        <div>
          <div style={{ fontSize: 20, fontWeight: 700, color: "#16233c" }}>Pitcher Strikeouts</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 2 }}>
            <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 3,
              color: "#0f8a44", background: "rgba(15,138,68,0.12)" }}>⭐⭐⭐⭐ PREMIUM</span>
            <span style={{ fontSize: 11, color: "#74839d" }}>Dual-model · xK + K-Edge · M1–M4 multipliers</span>
            <span style={{ fontSize: 10, color: "#8b99b0" }}>
              · <span style={{ color: "#0f8a44", fontWeight: 700 }}>🎲 play line {KS_PLAY_LINE.toFixed(1)}</span>
            </span>
          </div>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          {(() => {
            const tiers = pitchers.map(p => ksConviction(p).tier);
            const plays = tiers.filter(t => t === TIER.play).length;
            const folded = tiers.filter(t => t === TIER.pricedIn || t === TIER.blocked).length;
            return (
              <>
                <span style={{ fontSize: 12, fontFamily: "'JetBrains Mono', monospace", fontWeight: 700,
                  color: plays > 0 ? "#0f8a44" : "#8b99b0" }}>🎲 {plays} play{plays !== 1 ? "s" : ""}</span>
                {folded > 0 && (
                  <span title="Starters the model rates highly that the Ks gate overruled — a directionless read, or an over on a line the book is sharp on" style={{
                    fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 10, cursor: "help",
                    background: "rgba(139,106,201,0.12)", color: "#8b6ac9", border: "1px solid rgba(139,106,201,0.25)",
                  }}>⚑ {folded} held back</span>
                )}
              </>
            );
          })()}
          <span style={{ fontSize: 12, color: "#74839d", fontFamily: "'JetBrains Mono', monospace" }}>
            {pitchers.length} starter{pitchers.length !== 1 ? "s" : ""}
          </span>
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
          <button onClick={() => { setSortMode(m => m === "proj" ? "conf" : "proj"); if (sortMode === "proj") { setSortCol("conf"); setSortDir("desc"); } else { setSortCol("xK"); setSortDir("desc"); } }}
            style={{
              padding: "3px 10px", fontSize: 10, fontWeight: 600, borderRadius: 10,
              background: sortMode === "conf" ? "rgba(32,98,200,0.24)" : "rgba(22,44,80,0.05)",
              border: "1px solid rgba(32,98,200,0.2)", color: sortMode === "conf" ? "#2062c8" : "#74839d",
              cursor: "pointer", marginLeft: 4,
            }}>
            {sortMode === "proj" ? "Sort: xK ⇅" : "Sort: Score ⇅"}
          </button>
          <button onClick={() => setKsColsOpen(o => !o)} style={{
            padding: "3px 10px", fontSize: 10, fontWeight: 600, borderRadius: 10,
            background: ksColsOpen ? "rgba(139,47,201,0.15)" : "rgba(22,44,80,0.05)",
            border: `1px solid ${ksColsOpen ? "rgba(139,47,201,0.4)" : "rgba(22,44,80,0.1)"}`,
            color: ksColsOpen ? "#8b2fc9" : "#74839d", cursor: "pointer", marginLeft: 4,
          }}>⚙ Cols</button>
        </div>
      </div>

      {ksColsOpen && (
        <div style={{ marginBottom: 16, padding: "12px 16px", background: "rgba(139,47,201,0.06)", border: "1px solid rgba(139,47,201,0.2)", borderRadius: 10, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: "#8b2fc9", marginRight: 4 }}>Columns:</span>
          {ksColOrder.map((col, idx) => (
            <div key={col.id} draggable={!col.always}
              onDragStart={() => setKsDragIdx(idx)}
              onDragOver={e => e.preventDefault()}
              onDrop={() => {
                if (ksDragIdx == null || ksDragIdx === idx) return;
                const next = [...ksColOrder]; const [moved] = next.splice(ksDragIdx, 1); next.splice(idx, 0, moved);
                setKsDragIdx(null); saveKsColPrefs(next);
              }}
              style={{ display: "flex", alignItems: "center", gap: 5, padding: "3px 8px", borderRadius: 6, fontSize: 11, fontWeight: 600,
                background: col.hidden ? "rgba(22,44,80,0.04)" : "rgba(139,47,201,0.12)",
                border: `1px solid ${col.hidden ? "rgba(22,44,80,0.08)" : "rgba(139,47,201,0.3)"}`,
                color: col.hidden ? "#8b99b0" : "#7a5fd0", cursor: col.always ? "default" : "grab", opacity: col.hidden ? 0.6 : 1, userSelect: "none" }}>
              {!col.always && <input type="checkbox" checked={!col.hidden} onChange={() => { const next = ksColOrder.map((c,i) => i===idx ? {...c,hidden:!c.hidden} : c); saveKsColPrefs(next); }} style={{ cursor: "pointer", margin: 0 }} />}
              {!col.always && <span style={{ fontSize: 9, opacity: 0.5 }}>⠿</span>}
              {col.label}
            </div>
          ))}
          <button onClick={() => saveKsColPrefs(KS_COLS_DEFAULT.map(c => ({ ...c, hidden: false })))}
            style={{ marginLeft: "auto", padding: "3px 8px", fontSize: 10, borderRadius: 6, cursor: "pointer", background: "rgba(22,44,80,0.05)", border: "1px solid rgba(22,44,80,0.1)", color: "#74839d" }}>Reset</button>
        </div>
      )}

      <div style={{ background: "rgba(210,217,236,0.4)", borderRadius: 12, border: "1px solid rgba(32,98,200,0.128)", overflow: "hidden" }}>
      <div className="hscroll">
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 680 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid rgba(32,98,200,0.16)" }}>
              {ksActiveCols.map((col, ci) => {
                const isLast = ci === ksActiveCols.length - 1;
                if (col.id === "rank") return <th key="rank" className="th-sm" style={{ textAlign: "left", paddingLeft: 12 }}>#</th>;
                if (col.id === "pitcher") return <SortTh key="pitcher" col="name" label="Pitcher" align="left" title="Pitcher name" />;
                if (col.id === "xK") return <SortTh key="xK" col="xK" label="xK" title="Bayesian blend: 40% seasonK9 + 30% L5K9 + 30% prior" />;
                if (col.id === "kEdge") return <SortTh key="kEdge" col="kEdge" label="K-Edge" title="Stable baseline model" />;
                if (col.id === "stddev") return <SortTh key="stddev" col="stddev" label="±σ" title="L5 starts standard deviation" />;
                if (col.id === "whiff") return <SortTh key="whiff" col="swStr" label="Whiff%" title="Savant weighted whiff% (M1)" />;
                if (col.id === "fstrike") return <SortTh key="fstrike" col="fStrike" label="F-Str%" title="First-pitch strike rate (M2)" />;
                if (col.id === "chase") return <SortTh key="chase" col="chase" label="Chase%" title="O-Swing% vs this pitcher (M2)" />;
                if (col.id === "oppK") return <SortTh key="oppK" col="oppK" label="Opp K%" title="Opponent team K% (M3)" />;
                if (col.id === "edge") return <SortTh key="edge" col="xKEdge" label="Edge" title="xK minus line" />;
                if (col.id === "score") return <SortTh key="score" col="conf" label="Conviction" title={`Data completeness + model agreement (1–10). 🎲 at ${KS_PLAY_LINE.toFixed(1)} and above = official play. A starter the gate overruled (no directional read, or an over on a line the book is sharp on) folds below the line rather than keeping its number.`} />;
                if (col.id === "ks_kelly") return <th key="ks_kelly" className="th-sm" style={{ textAlign: "center", color: "#74839d", whiteSpace: "nowrap" }} title="Quarter-Kelly bet size on 1–5 unit scale">Size</th>;
                if (col.id === "signal") return <SortTh key="signal" col="signal" label="Signal" title="OVER/UNDER signal" />;
                if (col.id === "ks_fd") return <SortTh key="ks_fd" col="ks_fd" label="FD" title="FanDuel" />;
                if (col.id === "ks_dk") return <SortTh key="ks_dk" col="ks_dk" label="DK" title="DraftKings" />;
                if (col.id === "ks_hr") return <SortTh key="ks_hr" col="ks_hr" label="HR" title="Hard Rock" />;
                if (col.sortKey) return <SortTh key={col.id} col={col.sortKey} label={col.label} />;
                return <th key={col.id} className="th-sm" style={{ textAlign: "center", color: "#74839d" }}>{col.label}</th>;
              })}
            </tr>
          </thead>
          <tbody>
            {pitchers.map((p, i) => {
              const isOver  = p.signal === "over";
              const isUnder = p.signal === "under";
              const rank = i + 1;
              const isTop3 = rank <= 3;
              const rowBg = isTop3 ? "rgba(15,138,68,0.04)" : isOver ? "rgba(15,138,68,0.02)" : "";
              return (
                <tr key={p.pitcherId || i}
                  onClick={() => onSelectPitcher && onSelectPitcher(p)}
                  style={{ borderBottom: "1px solid rgba(32,98,200,0.064)", background: rowBg, transition: "background 0.15s", cursor: "pointer" }}
                  onMouseEnter={e => e.currentTarget.style.background = "rgba(32,98,200,0.096)"}
                  onMouseLeave={e => e.currentTarget.style.background = rowBg}>
                  {ksActiveCols.map((col) => {
                    if (col.id === "rank") return <td key="rank" style={{ padding: "10px 8px 10px 12px", fontSize: 12, fontWeight: 700, color: isTop3 ? "#0f8a44" : "#6d7c96", fontFamily: "'JetBrains Mono', monospace" }}>{rank}</td>;
                    if (col.id === "pitcher") return (
                      <td key="pitcher" className="td-sm" style={{ textAlign: "left", fontWeight: 600, color: "#16233c" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                          {p.name}
                          {p.isRoleChange && (
                            <span title={`Recent role change: ${p.gamesStartedSeason} start${p.gamesStartedSeason !== 1 ? "s" : ""} vs ${p.reliefAppearances} relief apps this season — projection anchored to career/prior`}
                              style={{ fontSize: 9, fontWeight: 700, color: "#c2570f", background: "rgba(194,87,15,0.12)", border: "1px solid rgba(194,87,15,0.25)", borderRadius: 4, padding: "1px 5px", flexShrink: 0 }}>
                              🔄 NEW STARTER
                            </span>
                          )}
                          {p.roleUncertain && (
                            <span title={`Book line ${p.line?.toFixed(1)} is ${Math.abs(p.xKEdge || 0).toFixed(1)} Ks off our projection (${(p.xK || 0).toFixed(1)}). A gap this size is usually a role or workload change the book already knows about — opener, bulk day, innings limit. Trust the line: no signal, no pick.`}
                              style={{ fontSize: 9, fontWeight: 700, color: "#a15c00", background: "rgba(214,138,0,0.14)", border: "1px solid rgba(214,138,0,0.35)", borderRadius: 4, padding: "1px 5px", flexShrink: 0 }}>
                              ⚠ ROLE?
                            </span>
                          )}
                        </div>
                        {p.seasonGS > 0 ? (
                          <div style={{ fontSize: 9, color: "#74839d", marginTop: 1, fontFamily: "'JetBrains Mono',monospace", whiteSpace: "nowrap" }}>
                            {p.seasonW}-{p.seasonL}<span style={{ marginLeft: 5 }}>{p.seasonSO}K</span><span style={{ marginLeft: 5 }}>{p.seasonIP.toFixed(1)}IP</span><span style={{ marginLeft: 5 }}>{p.seasonGS}GS</span>
                            {p.isRoleChange && <span style={{ marginLeft: 5, color: "#c2570f" }}>({p.reliefAppearances} relief apps)</span>}
                          </div>
                        ) : null}
                      </td>
                    );
                    if (col.id === "team") return <td key="team" className="td-sm">{p.team}</td>;
                    if (col.id === "opp") return <td key="opp" className="td-sm">{p.opponent}</td>;
                    if (col.id === "hand") return <td key="hand" className="td-sm">{p.hand}HP</td>;
                    if (col.id === "projIP") return <td key="projIP" className="td-sm mono">{(p.projIP || 0).toFixed(1)}</td>;
                    if (col.id === "xK") return <td key="xK" className="td-sm mono" style={{ color: "#2062c8", fontWeight: 700 }}>{(p.xK || 0).toFixed(1)}</td>;
                    if (col.id === "kEdge") return <td key="kEdge" className="td-sm mono" style={{ color: "#4c5f7d" }}>{(p.kEdge || 0).toFixed(1)}</td>;
                    if (col.id === "stddev") return <td key="stddev" className="td-sm mono" style={{ color: (p.l5Stddev || 99) > 2.5 ? "#d03131" : "#74839d" }}>±{(p.l5Stddev || 0).toFixed(1)}</td>;
                    if (col.id === "whiff") return <td key="whiff" className="td-sm mono" style={{ color: (p.swStrPct || 0) > 29 ? "#0f8a44" : (p.swStrPct || 0) < 22 ? "#d03131" : "#4c5f7d" }}>{p.swStrPct != null ? p.swStrPct.toFixed(1) + "%" : "—"}</td>;
                    if (col.id === "fstrike") return <td key="fstrike" className="td-sm mono" style={{ color: (p.fStrikePct || 0) > 65 ? "#0f8a44" : (p.fStrikePct || 0) < 58 ? "#d03131" : "#4c5f7d" }}>{p.fStrikePct != null ? p.fStrikePct.toFixed(1) + "%" : "—"}</td>;
                    if (col.id === "chase") return <td key="chase" className="td-sm mono" style={{ color: (p.ozSwingPct || 0) > 32 ? "#0f8a44" : (p.ozSwingPct || 0) < 26 ? "#d03131" : "#4c5f7d" }}>{p.ozSwingPct != null ? p.ozSwingPct.toFixed(1) + "%" : "—"}</td>;
                    if (col.id === "oppK") return <td key="oppK" className="td-sm mono" style={{ color: (p.oppKRatePct || 0) > 24 ? "#0f8a44" : (p.oppKRatePct || 0) < 20 ? "#d03131" : "#4c5f7d" }}>{p.oppKRatePct != null ? p.oppKRatePct.toFixed(1) + "%" : "—"}</td>;
                    if (col.id === "line") return <td key="line" className="td-sm mono">{p.line != null ? p.line.toFixed(1) : "—"}</td>;
                    if (col.id === "edge") return <td key="edge" className="td-sm mono" title={p.roleUncertain ? "Role-uncertain: this gap is a role/workload signal, not an edge" : undefined} style={{ color: p.roleUncertain ? "#b6c5dc" : (p.xKEdge || 0) > 0 ? "#0f8a44" : "#d03131", fontWeight: 600, textDecoration: p.roleUncertain ? "line-through" : "none" }}>{(p.xKEdge || 0) >= 0 ? "+" : ""}{(p.xKEdge || 0).toFixed(1)}</td>;
                    if (col.id === "score") return (
                      <td key="score" className="td-sm" style={{ textAlign: "center" }}>
                        <ConvictionCell
                          c={ksConviction(p)}
                          stack
                          dice={`🎲${ksPickDirection(p) === "under" ? "▼" : "▲"}`}
                          diceTitle={`Official scored pick — ${ksPickDirection(p).toUpperCase()}`}
                        />
                      </td>
                    );
                    if (col.id === "ks_kelly") {
                      if (!isOfficialKsPick(p)) return <td key="ks_kelly" className="td-sm" style={{ textAlign: "center" }}><span style={{ fontSize: 10, color: "#b6c5dc" }}>—</span></td>;
                      const units = ksPickUnits(p);
                      const uColor = PICK_UNIT_COLORS[units];
                      return (
                        <td key="ks_kelly" className="td-sm" style={{ textAlign: "center" }}>
                          <span style={{ fontSize: 11, fontWeight: 700, fontFamily: "'JetBrains Mono',monospace", color: uColor, background: `${uColor}18`, padding: "1px 6px", borderRadius: 4, whiteSpace: "nowrap" }}>
                            {units}u{units === 5 ? " 💪" : ""}
                          </span>
                        </td>
                      );
                    }
                    if (col.id === "signal") return p.roleUncertain
                      ? <td key="signal" className="td-sm" title="Book line and our projection disagree by 2+ Ks — role/workload uncertain" style={{ color: "#a15c00", fontWeight: 700, fontSize: 10 }}>⚠ ROLE?</td>
                      : <td key="signal" className="td-sm" style={{ color: signalColor[p.signal] || "#74839d", fontWeight: 600, fontSize: 10 }}>{signalLabel[p.signal] || "—"}</td>;
                    const bookMap = { ks_fd: "fanduel", ks_dk: "draftkings", ks_hr: "hardrockbet" };
                    const bk = bookMap[col.id];
                    if (bk) {
                      // Show under odds when the signal is under and under lines are available
                      const isUnderSignal = p.signal === "under";
                      const useUnder = isUnderSignal && p.bookUnderOdds;
                      const displayOdds = useUnder ? p.bookUnderOdds : p.bookOdds;
                      const displayLinks = useUnder ? (p.bookUnderLinks || p.bookLinks) : p.bookLinks;
                      const allPrices = ["fanduel","draftkings","hardrockbet"].map(b => displayOdds?.[b]).filter(v => v != null);
                      const thisPrice = displayOdds?.[bk] ?? null;
                      const isBest = thisPrice != null && allPrices.length > 0 && thisPrice === Math.max(...allPrices);
                      return <td key={col.id} className="td-sm mono"><OddsLink price={thisPrice} url={displayLinks?.[bk]} isBest={isBest} bk={bk} style={{ background: isBest ? `${BOOK_COLORS[bk]}18` : "transparent", padding: isBest ? "1px 5px" : "0", borderRadius: isBest ? 4 : 0 }} /></td>;
                    }
                    return null;
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div style={{ padding: "10px 12px", borderTop: "1px solid rgba(32,98,200,0.096)", fontSize: 10, color: "#b6c5dc", lineHeight: 1.8 }}>
        <strong style={{ color: "#8b99b0" }}>xK</strong> — Bayesian blend (40% seasonK9 + 30% L5K9 + 30% prior) — all Bayesian-shrunk toward career prior (N=150 TBF / N=18 IP) ·{" "}
        <strong style={{ color: "#8b99b0" }}>K-Edge</strong> — Stable baseline (40% career + 35% bayesSeason + 25% prior) · market comparison ·{" "}
        <strong style={{ color: "#8b99b0" }}>Signal</strong> — OVER / UNDER when both models agree above/below line
        <ConvictionLegend line={KS_PLAY_LINE} style={{ marginTop: 6 }} />
      </div>
      </div>
    </div>
  );
}
