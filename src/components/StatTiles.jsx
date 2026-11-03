// ── Statcast tile strip — the research layer above each props board ─────────
// Renders src/lib/statTiles.js's rankings. All math lives there; this file only draws.
//
// Each tile is one axis, five names. The default body is a split — three ranked by
// matchup-adjusted season value, two by how far the last-15-game window has moved — so the
// strip shows the hitters you expect AND the ones you wouldn't have looked up. Two more
// rankings are one click away per tile: 🔥 (window movement only) and 💰 (metric percentile
// minus the market's implied-probability percentile across the slate).
//
// HONESTY RULES THIS COMPONENT ENFORCES VISUALLY, because the numbers alone would mislead:
//   · the bar says whether it is a LEAGUE percentile or only a rank within today's slate
//   · a 🔥 row on a metric whose 15-game window is mostly sampling noise (barrel%, hard-hit%,
//     BB% — see NOISE_RATIO) is dimmed and labelled, not drawn like a measurement
//   · a tile with nothing to show says why instead of rendering an empty box
//   · every row states the matchup it belongs to. A pitcher-subject tile (Contact Allowed,
//     Topped Rate) names an ARM, and the arm alone does not say whose hitters it is a
//     problem for — "BOS · vs TOR" does. Batter rows name the starter they face for the
//     same reason: half a matchup is not a matchup.
import { useState, useMemo } from "react";
import { TILE_SETS, buildTile } from "../lib/statTiles.js";

const MON = "'JetBrains Mono',monospace";
const GOOD = "#0f8a44";
const WARN = "#a16207";
const INK = "#16233c";
const MUTE = "#64748d";
const LINE = "rgba(32,98,200,0.128)";

const pctColor = p => p == null ? "#c9d5e8"
  : p >= 80 ? GOOD : p >= 60 ? "#65a30d" : p >= 40 ? WARN : p >= 20 ? "#c2570f" : "#d03131";

const MODES = [
  { key: "split",   icon: "◆", title: "Best in this matchup, plus the biggest 15-game movers" },
  { key: "heating", icon: "🔥", title: "Ranked only by how far the last-15-game window has moved" },
  { key: "value",   icon: "💰", title: "Ranked by profile percentile minus the market's implied percentile — a strong profile at a long price" },
];

/** The percentile bar. Width is the percentile; the fill colours by tier. */
function Bar({ pct }) {
  return (
    <div style={{ position: "relative", height: 4, borderRadius: 2, background: "rgba(32,98,200,0.10)", overflow: "hidden" }}>
      <div style={{
        position: "absolute", left: 0, top: 0, bottom: 0,
        width: `${Math.max(2, Math.min(100, pct ?? 0))}%`,
        background: pctColor(pct), borderRadius: 2,
      }} />
    </div>
  );
}

function TileRow({ r, scale, onSelectRow }) {
  const heating = r.rank === "heating";
  // A `marginal` window is one whose 15-game swing is comparable to the real spread between
  // players — real enough to show, not real enough to read as news.
  const marginal = heating && r.window?.tier === "marginal";
  // Only a row that IS a scanned player opens a panel. A perPitcher/perTeam tile row stands
  // for the opposition shared by several picks, so there is no one player to open.
  const clickable = r.subject === "batter" && !!onSelectRow;

  return (
    <div
      onClick={clickable ? () => onSelectRow(r.pick) : undefined}
      title={[
        // The matchup leads the tooltip: on a pitcher-subject row the name alone does not
        // say whose board slot this is answering.
        r.subject === "pitcher" ? `${r.name} (${r.opponent || "—"}) vs ${r.team || "—"} hitters`
          : r.subject === "team" ? `${r.name} vs ${r.team || "—"} hitters`
          : [r.name, r.team, r.oppPitcher ? `vs ${r.oppPitcher}` : null].filter(Boolean).join(" · "),
        heating
          ? `Last ${r.window.games} games: ${r.window.display} vs ${r.display} season — ${r.window.shift > 0 ? "+" : ""}${Math.round(r.window.shift)} percentile points${marginal ? " (this metric's 15-game window is close to sampling noise)" : ""}`
          : r.residual != null
            ? `Profile ${Math.round(r.slatePct)}th percentile on this slate, market prices him ${Math.round(r.impliedPct)}th — ${r.residual > 0 ? "+" : ""}${Math.round(r.residual)}`
            : `${r.display}${r.matchup !== 1 ? ` · matchup ${r.matchup > 1 ? "+" : ""}${Math.round((r.matchup - 1) * 100)}%` : ""}`,
      ].join("\n")}
      style={{
        padding: "5px 10px",
        cursor: clickable ? "pointer" : "default",
        opacity: marginal ? 0.62 : 1,
        borderLeft: heating ? `2px solid ${marginal ? "rgba(193,110,15,0.4)" : "#e07a1f"}` : "2px solid transparent",
        transition: "background 0.12s",
      }}
      onMouseEnter={e => { if (clickable) e.currentTarget.style.background = "rgba(32,98,200,0.07)"; }}
      onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
        <span style={{
          fontSize: 11.5, fontWeight: 600, color: INK,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1,
        }}>
          {heating && <span style={{ marginRight: 3 }}>🔥</span>}
          {r.name}
        </span>
        {r.rank === "value" && r.residual != null && (
          <span style={{ fontSize: 9.5, fontWeight: 700, color: GOOD, fontFamily: MON }}>
            +{Math.round(r.residual)}
          </span>
        )}
        {heating && (
          <span style={{ fontSize: 9.5, fontWeight: 700, color: marginal ? WARN : "#e07a1f", fontFamily: MON }}>
            {r.window.shift > 0 ? "+" : ""}{Math.round(r.window.shift)}
          </span>
        )}
        <span style={{ fontSize: 11.5, fontWeight: 700, color: INK, fontFamily: MON }}>
          {heating ? r.window.display : r.display}
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 3 }}>
        {/* Who the number applies to. On a pitcher-subject tile this is the whole point of
            the row — "BOS · vs TOR" says the arm is Boston's and the ranking is being made
            on behalf of Toronto's hitters. Fixed width so the bars stay aligned down the
            tile; the full string is in the row's tooltip when it ellipses. */}
        <span style={{
          fontSize: 8.5, color: MUTE, width: 74, flexShrink: 0,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {r.matchupLabel || (r.subject === "batter" ? r.team : "")}
        </span>
        {/* A heating row prints its WINDOW value, so its bar must show where the window sits,
            not where the season does — otherwise number and bar describe different things. */}
        <div style={{ flex: 1 }}><Bar pct={heating ? r.window.pct : r.leaguePct} /></div>
        {/* A slate-only axis prints its RANK, not a percentile. "97" out of 15 starters reads
            like a league standing; "3/15" cannot be mistaken for one. */}
        <span style={{ fontSize: 9, color: MUTE, fontFamily: MON, width: scale === "league" ? 18 : 30, textAlign: "right", flexShrink: 0 }}>
          {scale === "league"
            ? ((heating ? r.window.pct : r.leaguePct) != null ? Math.round(heating ? r.window.pct : r.leaguePct) : "—")
            : `${r.slateRank}/${r.slateN}`}
        </span>
      </div>
    </div>
  );
}

function Tile({ def, rows, onSelectRow, onSortByTile, activeSort, windowData }) {
  const [mode, setMode] = useState("split");
  // Only this tile rebuilds when its own mode toggles — the rest of the strip is untouched.
  const built = useMemo(
    () => buildTile(def, rows, { window: windowData, mode }),
    [def, rows, windowData, mode]);
  if (!built) return null;

  const isSorted = activeSort === built.id;
  const available = MODES.filter(m =>
    m.key === "split" ||
    (m.key === "heating" && built.windowMetric) ||
    (m.key === "value" && built.subject === "batter"));

  return (
    <div style={{
      background: "#ffffff",
      border: `1px solid ${isSorted ? "rgba(32,98,200,0.45)" : LINE}`,
      boxShadow: isSorted ? "0 0 0 2px rgba(32,98,200,0.12)" : "0 1px 2px rgba(22,35,60,0.05)",
      borderRadius: 10, overflow: "hidden", minWidth: 0,
    }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 5,
        padding: "7px 9px 6px", borderBottom: `1px solid ${LINE}`,
        background: "rgba(32,98,200,0.035)",
      }}>
        <span style={{ fontSize: 12 }}>{built.emoji}</span>
        <button
          onClick={() => onSortByTile && onSortByTile(built.id)}
          title={`${built.why}\n\nClick to sort the board by ${built.label}.`}
          style={{
            flex: 1, minWidth: 0, textAlign: "left", border: "none", background: "none",
            padding: 0, cursor: onSortByTile ? "pointer" : "help",
            fontSize: 10.5, fontWeight: 700, letterSpacing: 0.2, color: isSorted ? "#2062c8" : INK,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
          {built.label}{isSorted ? " ⇅" : ""}
        </button>
        {available.length > 1 && (
          <div style={{ display: "flex", gap: 2 }}>
            {available.map(m => (
              <button key={m.key} onClick={() => setMode(m.key)} title={m.title}
                style={{
                  border: "none", borderRadius: 4, cursor: "pointer", lineHeight: 1,
                  padding: "2px 4px", fontSize: 9,
                  background: mode === m.key ? "rgba(32,98,200,0.18)" : "transparent",
                  color: mode === m.key ? "#2062c8" : "#9aa8bf",
                }}>
                {m.icon}
              </button>
            ))}
          </div>
        )}
      </div>

      {built.rows.length === 0 ? (
        <div style={{ padding: "14px 10px", fontSize: 10, color: MUTE, textAlign: "center", lineHeight: 1.4 }}>
          {built.empty || "no data"}
        </div>
      ) : (
        <div style={{ padding: "3px 0" }}>
          {built.rows.map(r => (
            <TileRow key={r.key} r={r} scale={built.scale} onSelectRow={onSelectRow} />
          ))}
        </div>
      )}

      <div style={{
        padding: "4px 9px 5px", borderTop: `1px solid ${LINE}`,
        fontSize: 8.5, color: "#9aa8bf", display: "flex", justifyContent: "space-between", gap: 6,
      }}>
        <span>{built.scale === "league" ? "league %ile" : "rank on today's slate"}</span>
        <span>{built.subject === "pitcher" ? "per pitcher" : built.subject === "team" ? "per team" : ""}</span>
      </div>
    </div>
  );
}

/**
 * @param boardKey     which market's tile set to render
 * @param rows         the board's pick rows (unfiltered by the table's own line filter, so
 *                     the tiles describe the whole slate rather than the current view)
 * @param windowData   /api/batter-window payload, or null while it loads / if it failed
 * @param onSortByTile called with a tile id when its header is clicked
 * @param activeSort   the tile id the board is currently sorted by, for the active outline
 */
export default function StatTiles({
  boardKey, rows, windowData, onSelectBatter, onSelectPitcher, onSortByTile, activeSort,
}) {
  const [collapsed, setCollapsed] = useState(false);
  const defs = TILE_SETS[boardKey];
  // On the Ks board a tile row IS the scanned starter, so clicking one opens the pitcher
  // panel; everywhere else a row is a hitter.
  const onSelectRow = boardKey === "ks" ? onSelectPitcher : onSelectBatter;
  if (!defs?.length || !rows?.length) return null;

  return (
    <div style={{ padding: "12px 20px 0" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 10.5, fontWeight: 700, color: MUTE, letterSpacing: 0.5 }}>
          STATCAST · TODAY'S SLATE
        </span>
        <div style={{ flex: 1, height: 1, background: LINE }} />
        {windowData
          ? <span style={{ fontSize: 9, color: "#9aa8bf" }}>
              🔥 = last {windowData.games} games vs season
            </span>
          : <span style={{ fontSize: 9, color: "#9aa8bf" }}>season only — window unavailable</span>}
        <button onClick={() => setCollapsed(c => !c)} style={{
          border: `1px solid ${LINE}`, background: "#fff", borderRadius: 6, cursor: "pointer",
          fontSize: 9, fontWeight: 700, color: MUTE, padding: "2px 7px",
        }}>{collapsed ? "show" : "hide"}</button>
      </div>

      {!collapsed && (
        <div style={{
          display: "grid", gap: 8,
          gridTemplateColumns: "repeat(auto-fit, minmax(178px, 1fr))",
        }}>
          {defs.map(d => (
            <Tile key={d.id} def={d} rows={rows} windowData={windowData}
              onSelectRow={onSelectRow} onSortByTile={onSortByTile} activeSort={activeSort} />
          ))}
        </div>
      )}
    </div>
  );
}
