// Panel UI kit shared by BatterPanel and PitcherPanel (moved out of App.jsx
// 2026-10-06 with the BatterPanel extraction): split/log tables, zone + movement
// charts, small stat boxes, giveaways, contract line.
import { useState, useEffect, useMemo } from 'react';
import PLAYER_VALUE from '../data/player_value.json';
import { formatContract } from '../lib/value.js';
import PROMOTIONS from '../data/promotions.json';
import { getTodayInAppTimeZone } from '../lib/utils.js';
import { getGameLogStat } from '../lib/mlbData.js';

// Contract / salary line for the panel headers. Reads the walled-off value dataset
// (WAR + cash salary now; years/total once the contract scraper lands) and renders
// "5 Years / $150,000,000" — or current-year cash as the interim fallback. Salary
// is display-only and never feeds a pick model.
export function ContractLine({ playerId }) {
  const pv = playerId != null ? PLAYER_VALUE.players[playerId] || PLAYER_VALUE.players[String(playerId)] : null;
  const text = pv && formatContract({ ...pv, seasonLabel: PLAYER_VALUE.meta.season });
  if (!text) return null;
  const isStructured = !!(pv.contract && pv.contract.years);
  return (
    <div style={{ fontSize: 11, color: "#158556", marginTop: 2, fontWeight: 700 }}
         title={isStructured ? "Total contract" : "Current-season cash salary (contract structure pending)"}>
      💵 {text}
    </div>
  );
}

// ── Mobile detection hook ─────────────────────────────────────────────────────
export function useIsMobile(breakpoint = 700) {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth < breakpoint : false
  );
  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < breakpoint);
    window.addEventListener("resize", handler, { passive: true });
    return () => window.removeEventListener("resize", handler);
  }, [breakpoint]);
  return isMobile;
}

export const fmtAvg = (v) => {
  if (v == null || v === "") return "—";
  const n = Number(v);
  return n >= 1 ? n.toFixed(3) : n.toFixed(3).replace(/^0/, "");
};

// Every giveaway tied to a player across the season (past + future), for the panels.
function getPlayerPromos(playerId) {
  if (!playerId) return [];
  const out = [];
  for (const [team, recs] of Object.entries(PROMOTIONS.teams || {})) {
    for (const r of recs) {
      for (const it of r.items) {
        if (it.playerId === playerId) out.push({ date: r.date, dateLabel: r.dateLabel, opp: r.opp, name: it.name, team });
      }
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// Season-long giveaway schedule for one player — shown atop the News tab in the
// batter/pitcher panels. Past dates are dimmed so the full year stays visible
// (useful for future "did the giveaway move the line / the bat?" matching).
export function PlayerGiveaways({ playerId }) {
  const promos = useMemo(() => getPlayerPromos(playerId), [playerId]);
  if (!promos.length) return null;
  const today = getTodayInAppTimeZone();
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 10, color: "#6d7c96", textTransform: "uppercase", letterSpacing: 1.2, marginBottom: 10 }}>
        🎁 {promos.length} Giveaway{promos.length !== 1 ? "s" : ""} This Season
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {promos.map((p, i) => (
          <div key={i} style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "8px 12px", borderRadius: 8,
            background: "rgba(161,98,7,0.06)", border: "1px solid rgba(161,98,7,0.18)", opacity: p.date < today ? 0.5 : 1 }}>
            <span style={{ fontSize: 11, color: "#a16207", fontWeight: 700, whiteSpace: "nowrap", minWidth: 104 }}>{p.dateLabel}</span>
            <span style={{ fontSize: 12, color: "#2c3d5c", fontWeight: 600, flex: 1, lineHeight: 1.35 }}>{p.name}</span>
            <span style={{ fontSize: 10, color: "#74839d", whiteSpace: "nowrap" }}>vs {p.opp}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function _timeAgo(dateStr) {
  if (!dateStr) return "";
  const sec = Math.round((Date.now() - new Date(dateStr)) / 1000);
  if (isNaN(sec) || sec < 0) return "";
  if (sec < 60)    return `${sec}s ago`;
  if (sec < 3600)  return `${Math.round(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
  return `${Math.round(sec / 86400)}d ago`;
}

// Per-game bar chart for player pages
export function PropBarChart({ gameLog, propKey, threshold }) {
  const games = (gameLog || []).slice(0, 20).reverse();
  if (!games.length) return (
    <div style={{ height: 100, display: "flex", alignItems: "center", justifyContent: "center", color: "#8b99b0", fontSize: 12 }}>
      No game log data available
    </div>
  );
  const values = games.map(g => getGameLogStat(g, propKey));
  const maxVal = Math.max(...values, threshold + 0.5, 2);
  const cleared = values.filter(v => v > threshold).length;
  const BAR_H = 110, LABEL_H = 30;
  return (
    <div>
      <div style={{ fontSize: 10, color: "#8b99b0", marginBottom: 6, fontFamily: "'JetBrains Mono',monospace" }}>
        {cleared}/{games.length} games · O{threshold} cleared {Math.round(cleared / games.length * 100)}%
      </div>
      <div style={{ position: "relative", height: BAR_H + LABEL_H, display: "flex", alignItems: "flex-end", gap: 2 }}>
        <div style={{
          position: "absolute", left: 0, right: 0, pointerEvents: "none",
          bottom: LABEL_H + (threshold / maxVal) * BAR_H,
          borderTop: "1px dashed rgba(32,98,200,0.4)", zIndex: 1,
        }}>
          <span style={{ position: "absolute", right: 0, top: -8, fontSize: 8, color: "#8b99b0", background: "#ffffff", padding: "0 3px" }}>{threshold}</span>
        </div>
        {games.map((g, i) => {
          const v = values[i];
          const bH = Math.max(3, (v / maxVal) * BAR_H);
          const hit = v > threshold;
          const opp = g.opponent?.abbreviation || g.opponent?.name?.slice(0,3)?.toUpperCase() || "?";
          const dt  = g.date ? g.date.slice(5) : "";
          return (
            <div key={i} title={`${opp} · ${dt} · ${v}`} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", height: BAR_H + LABEL_H, justifyContent: "flex-end", cursor: "default" }}>
              {v > 0 && <div style={{ fontSize: 9, fontWeight: 700, color: "#16233c", marginBottom: 2, fontFamily: "'JetBrains Mono',monospace" }}>{v}</div>}
              <div style={{ width: "100%", height: bH, background: hit ? "rgba(15,138,68,0.65)" : "rgba(201,213,232,0.7)", borderRadius: "2px 2px 0 0" }} />
              <div style={{ height: LABEL_H, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-start", paddingTop: 3 }}>
                <div style={{ fontSize: 8, color: "#2062c8", fontWeight: 700 }}>{opp}</div>
                <div style={{ fontSize: 7, color: "#c9d5e8" }}>{dt}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Collapsible sidebar/section wrapper
export function CollapsibleSection({ title, children, defaultOpen = true, accent = "#2062c8" }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ marginBottom: 8, borderRadius: 8, border: "1px solid rgba(32,98,200,0.128)", overflow: "hidden" }}>
      <div onClick={() => setOpen(o => !o)} style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        padding: "9px 14px", cursor: "pointer", background: "rgba(210,217,236,0.5)", userSelect: "none",
      }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: accent, textTransform: "uppercase", letterSpacing: 0.8 }}>{title}</span>
        <span style={{ color: "#8b99b0", fontSize: 11, transition: "transform 0.2s", display: "inline-block", transform: open ? "rotate(0deg)" : "rotate(-90deg)" }}>▼</span>
      </div>
      {open && <div style={{ padding: "12px 14px", background: "rgba(225,231,242,0.3)" }}>{children}</div>}
    </div>
  );
}

export function StatBox({ label, value, sub, accent }) {
  return (
    <div style={{
      background: "rgba(203,212,233,0.6)", borderRadius: 8, padding: "8px 10px",
      border: "1px solid rgba(32,98,200,0.16)", minWidth: 64, textAlign: "center",
      transition: "border-color 0.2s", flex: "1 1 64px",
    }}
    onMouseEnter={e => e.currentTarget.style.borderColor = "rgba(32,98,200,0.3)"}
    onMouseLeave={e => e.currentTarget.style.borderColor = "rgba(32,98,200,0.16)"}
    >
      <div style={{ fontSize: 11, color: "#6d7c96", textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: accent || "#16233c", fontFamily: "'JetBrains Mono', monospace" }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: "#74839d", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

export function MiniStat({ label, value, accent }) {
  return (
    <div style={{ textAlign: "center", flex: "1 1 50px" }}>
      <div style={{ fontSize: 9, color: "#74839d", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 700, color: accent || "#3c4f6d", fontFamily: "'JetBrains Mono', monospace" }}>{value}</div>
    </div>
  );
}

// ── Beat reporters by team — 5 per team, outlet prioritized for display ──
export const BEAT_REPORTERS = {
  BAL:[{r:"Andy Kostka",o:"Baltimore Banner"},{r:"Matt Weyrich",o:"Baltimore Sun"},{r:"Roch Kubatko",o:"MASN"},{r:"Dan Connolly",o:"The Athletic"},{r:"Jon Meoli",o:"Baltimore Sun"}],
  BOS:[{r:"Pete Abraham",o:"Boston Globe"},{r:"Chad Jennings",o:"The Athletic"},{r:"Chris Cotillo",o:"MassLive"},{r:"Julian McWilliams",o:"Boston Globe"},{r:"Jason MacNeil",o:"The Athletic"}],
  NYY:[{r:"Bryan Hoch",o:"MLB.com"},{r:"Jack Curry",o:"YES Network"},{r:"Kristie Ackert",o:"NY Daily News"},{r:"Randy Miller",o:"NJ.com"},{r:"Lindsey Adler",o:"The Athletic"}],
  TB: [{r:"Marc Topkin",o:"Tampa Bay Times"},{r:"Adam Berry",o:"MLB.com"},{r:"Juan Toribio",o:"MLB.com"},{r:"Tricia Whitaker",o:"Bally Sports FL"},{r:"Will Sammon",o:"The Athletic"}],
  TOR:[{r:"Shi Davidi",o:"Sportsnet"},{r:"Jeff Blair",o:"Sportsnet 590"},{r:"Scott MacArthur",o:"Toronto Sun"},{r:"Laura Armstrong",o:"Toronto Star"},{r:"Keegan Matheson",o:"MLB.com"}],
  CWS:[{r:"James Fegan",o:"The Athletic"},{r:"Scott Merkin",o:"MLB.com"},{r:"Daryl Van Schouwen",o:"Chicago Sun-Times"},{r:"Laurence Holmes",o:"670 The Score"},{r:"Will Sammon",o:"The Athletic"}],
  CLE:[{r:"Zack Meisel",o:"The Athletic"},{r:"Mandy Bell",o:"MLB.com"},{r:"Paul Hoynes",o:"Cleveland.com"},{r:"Joe Noga",o:"Cleveland.com"},{r:"Francys Romero",o:"Bally Sports"}],
  DET:[{r:"Cody Stavenhagen",o:"The Athletic"},{r:"Jason Beck",o:"MLB.com"},{r:"Evan Woodbery",o:"MLive"},{r:"Chris McCosky",o:"Detroit News"},{r:"Brice Paterik",o:"Detroit Free Press"}],
  KC: [{r:"Alec Lewis",o:"The Athletic"},{r:"Lynn Worthy",o:"Kansas City Star"},{r:"Sam Mellinger",o:"Kansas City Star"},{r:"Josh Vernier",o:"610 Sports Radio"},{r:"Anne Rogers",o:"MLB.com"}],
  MIN:[{r:"Aaron Gleeman",o:"The Athletic"},{r:"Dan Hayes",o:"The Athletic"},{r:"LaVelle E. Neal",o:"Star Tribune"},{r:"Betsy Helfand",o:"Pioneer Press"},{r:"Do-Hyoung Park",o:"MLB.com"}],
  HOU:[{r:"Jake Kaplan",o:"The Athletic"},{r:"Chandler Rome",o:"Houston Chronicle"},{r:"Brian McTaggart",o:"MLB.com"},{r:"Julia Morales",o:"AT&T SportsNet"},{r:"Jesus Ortiz",o:"Houston Chronicle"}],
  LAA:[{r:"Jeff Fletcher",o:"OC Register"},{r:"Mike DiGiovanna",o:"LA Times"},{r:"Rhett Bollinger",o:"MLB.com"},{r:"Sam Blum",o:"The Athletic"},{r:"Ryan Gorcey",o:"Angels Wire"}],
  ATH:[{r:"Martin Gallegos",o:"MLB.com"},{r:"Matt Kawahara",o:"SF Chronicle"},{r:"Alex Coffey",o:"The Athletic"},{r:"Melissa Lockard",o:"The Athletic"},{r:"Mark Ling",o:"NBC Sports Bay Area"}],
  OAK:[{r:"Martin Gallegos",o:"MLB.com"},{r:"Matt Kawahara",o:"SF Chronicle"},{r:"Alex Coffey",o:"The Athletic"},{r:"Melissa Lockard",o:"The Athletic"},{r:"Mark Ling",o:"NBC Sports Bay Area"}],
  SEA:[{r:"Ryan Divish",o:"Seattle Times"},{r:"Shannon Drayer",o:"710 ESPN Seattle"},{r:"Daniel Kramer",o:"MLB.com"},{r:"Corey Brock",o:"The Athletic"},{r:"Adam Jude",o:"Seattle Times"}],
  TEX:[{r:"Evan Grant",o:"Dallas Morning News"},{r:"Jeff Wilson",o:"Fort Worth Star-Telegram"},{r:"Levi Weaver",o:"The Athletic"},{r:"Jose Romero",o:"MLB.com"},{r:"Kennedi Landry",o:"MLB.com"}],
  ATL:[{r:"David O'Brien",o:"The Athletic"},{r:"Gabe Burns",o:"Atlanta Journal-Constitution"},{r:"Mark Bowman",o:"MLB.com"},{r:"Grant McAuley",o:"92.9 The Game"},{r:"Kevin McAlpin",o:"680 The Fan"}],
  MIA:[{r:"Craig Mish",o:"SiriusXM"},{r:"Joe Frisaro",o:"MLB.com"},{r:"Jordan McPherson",o:"Miami Herald"},{r:"Andre Fernandez",o:"The Athletic"},{r:"Christina De Nicola",o:"MLB.com"}],
  NYM:[{r:"Anthony DiComo",o:"MLB.com"},{r:"Tim Britton",o:"The Athletic"},{r:"Deesha Thosar",o:"NY Daily News"},{r:"Anthony Rieber",o:"Newsday"},{r:"Justin Toscano",o:"The Record"}],
  PHI:[{r:"Matt Gelb",o:"The Athletic"},{r:"Todd Zolecki",o:"MLB.com"},{r:"Ryan Lawrence",o:"Philadelphia Inquirer"},{r:"Scott Lauber",o:"Philadelphia Inquirer"},{r:"Alex Coffey",o:"The Athletic"}],
  WSH:[{r:"Jesse Dougherty",o:"Washington Post"},{r:"Mark Zuckerman",o:"MASN"},{r:"Andy Kostka",o:"Baltimore Banner"},{r:"Jamal Collier",o:"MLB.com"},{r:"Byron Kerr",o:"NBC Washington"}],
  CHC:[{r:"Patrick Mooney",o:"The Athletic"},{r:"Sahadev Sharma",o:"The Athletic"},{r:"Jordan Bastian",o:"MLB.com"},{r:"Mark Gonzales",o:"Chicago Tribune"},{r:"Gordon Wittenmyer",o:"NBC Sports Chicago"}],
  CIN:[{r:"Charlie Goldsmith",o:"Cincinnati Enquirer"},{r:"Bobby Nightengale",o:"Cincinnati Enquirer"},{r:"C. Trent Rosecrans",o:"The Athletic"},{r:"Mark Sheldon",o:"MLB.com"},{r:"Hal McCoy",o:"Dayton Daily News"}],
  MIL:[{r:"Adam McCalvy",o:"MLB.com"},{r:"Tom Haudricourt",o:"Milwaukee Journal Sentinel"},{r:"Todd Rosiak",o:"Milwaukee Journal Sentinel"},{r:"Curt Hogg",o:"Milwaukee Journal Sentinel"},{r:"Matt Pauley",o:"620 WTMJ Radio"}],
  PIT:[{r:"Jason Mackey",o:"Pittsburgh Post-Gazette"},{r:"Dejan Kovacevic",o:"DK Pittsburgh Sports"},{r:"Stephen Nesbitt",o:"The Athletic"},{r:"Justin de los Santos",o:"MLB.com"},{r:"Neil Walker",o:"Various"}],
  STL:[{r:"Katie Woo",o:"The Athletic"},{r:"Derrick Goold",o:"St. Louis Post-Dispatch"},{r:"Jeff Jones",o:"Belleville News-Democrat"},{r:"Anne Rogers",o:"MLB.com"},{r:"Rob Rains",o:"STLSportsPage"}],
  ARI:[{r:"Nick Piecoro",o:"Arizona Republic"},{r:"Zach Buchanan",o:"The Athletic"},{r:"Steve Gilbert",o:"MLB.com"},{r:"Ashley Docking",o:"Bally Sports AZ"},{r:"Jack Magruder",o:"Various"}],
  COL:[{r:"Patrick Saunders",o:"Denver Post"},{r:"Nick Groke",o:"The Athletic"},{r:"Thomas Harding",o:"MLB.com"},{r:"Kyle Newman",o:"Denver Post"},{r:"Drew Goodman",o:"AT&T SportsNet"}],
  LAD:[{r:"Fabian Ardaya",o:"The Athletic"},{r:"Jorge Castillo",o:"LA Times"},{r:"J.P. Hoornstra",o:"LA Daily News"},{r:"Juan Toribio",o:"MLB.com"},{r:"Bill Plunkett",o:"OC Register"}],
  SD: [{r:"Kevin Acee",o:"SD Union-Tribune"},{r:"AJ Cassavell",o:"MLB.com"},{r:"Dennis Lin",o:"The Athletic"},{r:"Jeff Sanders",o:"SD Union-Tribune"},{r:"Kerry Crowley",o:"Bay Area News Group"}],
  SF: [{r:"Susan Slusser",o:"SF Chronicle"},{r:"Grant Brisbee",o:"The Athletic"},{r:"Alex Pavlovic",o:"NBC Sports Bay Area"},{r:"Christina Kahrl",o:"SF Chronicle"},{r:"Kerry Crowley",o:"Bay Area News Group"}],
};

// Opaque backing for the sticky label column in the splits tables. Matches the
// panel surface so scrolled numeric cells disappear cleanly underneath it.
const SPLIT_STICK_BG = "#eef2f9";

// A full-width section header cell inside a horizontally-scrolled table renders
// its text at x=0, so it slides out of view the moment the table is scrolled —
// which is what left a blank grey band above the columns on mobile. Pinning the
// text keeps the section name ("Breakdown", "Handedness") readable at any
// scroll offset.
const StickyLabel = ({ children }) => (
  <span style={{ position: "sticky", left: 8, display: "inline-block" }}>{children}</span>
);

export function SplitsTable({ splits, isPitching, overall, overallLabel = "Last 10 Games", only }) {
  if (!splits || splits.length === 0) return <div style={{ color: "#74839d", fontSize: 12, padding: 10 }}>No split data</div>;
  if (isPitching) return <PitcherSplitsTable splits={splits} only={only} />;

  const COLS = ["AB","R","H","2B","3B","HR","RBI","BB","HBP","SO","SB","CS","AVG","OBP","SLG","OPS"];
  const fmtN = v => (v != null && v !== "" && !isNaN(v)) ? v : "—";
  const fmtAvg = v => {
    const n = parseFloat(v);
    if (isNaN(n)) return "—";
    return "." + Math.round(n * 1000).toString().padStart(3, "0");
  };

  function statCols(st = {}) {
    return [
      fmtN(st.atBats),
      fmtN(st.runs),
      fmtN(st.hits),
      fmtN(st.doubles),
      fmtN(st.triples),
      fmtN(st.homeRuns),
      fmtN(st.rbi),
      fmtN(st.baseOnBalls),
      fmtN(st.hitByPitch ?? 0),
      fmtN(st.strikeOuts),
      fmtN(st.stolenBases ?? 0),
      fmtN(st.caughtStealing ?? 0),
      fmtAvg(st.avg),
      fmtAvg(st.obp),
      fmtAvg(st.slg),
      fmtAvg(st.ops),
    ];
  }

  const thStyle = { padding: "5px 8px", textAlign: "center", fontSize: 10, color: "#74839d", textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 700, whiteSpace: "nowrap" };
  // Label column is sticky (see .stickcol) so it needs an opaque background —
  // the scrolling numeric cells pass underneath it.
  const thLeft = { ...thStyle, textAlign: "left", minWidth: 80, background: SPLIT_STICK_BG };
  const sectionHdr = { fontSize: 10, fontWeight: 800, color: "#5d6f8b", textTransform: "uppercase", letterSpacing: 1, padding: "10px 8px 4px", background: "rgba(32,98,200,0.064)", borderTop: "1px solid rgba(32,98,200,0.128)" };
  const cellStyle = { padding: "6px 8px", textAlign: "center", fontSize: 12, fontFamily: "'JetBrains Mono', monospace", color: "#4c5f7d", whiteSpace: "nowrap" };
  const labelCell = { padding: "6px 8px", textAlign: "left", fontSize: 12, color: "#3c4f6d", fontWeight: 500, whiteSpace: "nowrap", background: SPLIT_STICK_BG };
  const rowBorder = { borderBottom: "1px solid rgba(32,98,200,0.096)" };

  // Breakdown splits: Left, Right, Home, Away, Day, Night (exclude RISP for this section)
  const breakdownOrder = ["vs. Left", "vs. Right", "Home", "Away", "Day", "Night"];
  const breakdown = breakdownOrder.map(lbl => splits.find(s => s.label === lbl)).filter(Boolean);

  const colHeaders = (
    <tr style={{ borderBottom: "1px solid rgba(32,98,200,0.24)" }}>
      <th className="stickcol" style={thLeft}>Split</th>
      {COLS.map(h => <th key={h} style={thStyle}>{h}</th>)}
    </tr>
  );

  function DataRow({ label, st }) {
    const vals = statCols(st);
    return (
      <tr style={rowBorder}>
        <td className="stickcol" style={labelCell}>{label}</td>
        {vals.map((v, i) => {
          // Color hints for rate stats
          const col = COLS[i];
          let color = "#4c5f7d";
          if (col === "AVG") color = parseFloat(st?.avg) >= 0.300 ? "#0f8a44" : parseFloat(st?.avg) <= 0.220 ? "#d03131" : "#4c5f7d";
          if (col === "OPS") color = parseFloat(st?.ops) >= 0.900 ? "#0f8a44" : parseFloat(st?.ops) <= 0.650 ? "#d03131" : "#4c5f7d";
          if (col === "HR") color = (st?.homeRuns || 0) >= 10 ? "#b45309" : "#4c5f7d";
          return <td key={i} style={{ ...cellStyle, color }}>{v}</td>;
        })}
      </tr>
    );
  }

  return (
    <div className="hscroll">
      <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 700 }}>
        {/* OVERALL / LAST 10 */}
        {overall && (
          <>
            <thead>
              <tr><td colSpan={17} style={{ ...sectionHdr, borderTop: "none", paddingTop: 4 }}><StickyLabel>{overallLabel}</StickyLabel></td></tr>
              {colHeaders}
            </thead>
            <tbody>
              <DataRow label="L10 (agg)" st={overall} />
            </tbody>
          </>
        )}
        {/* BREAKDOWN */}
        {breakdown.length > 0 && (
          <>
            <thead>
              <tr><td colSpan={17} style={sectionHdr}><StickyLabel>Breakdown</StickyLabel></td></tr>
              {colHeaders}
            </thead>
            <tbody>
              {breakdown.map((s, i) => <DataRow key={i} label={s.label} st={s.stat || {}} />)}
            </tbody>
          </>
        )}
      </table>
    </div>
  );
}

// Pitcher splits: two distinct sections with different column sets
// Breakdown (H/A/Day/Night) — pitcher stats | Handedness (vs LHB/vs RHB) — batter stats against
// `only` renders just one section ("breakdown" | "handedness") so callers can
// order the two independently; omit it to render both stacked as before.
function PitcherSplitsTable({ splits, only }) {
  if (!splits || splits.length === 0) return <div style={{ color: "#74839d", fontSize: 12, padding: 10 }}>No split data</div>;
  const breakdownLabels = ["Home", "Away", "Day", "Night"];
  const handLabels = ["vs LHB", "vs RHB"];
  const breakdown = only === "handedness" ? [] : splits.filter(s => breakdownLabels.includes(s.label));
  const handedness = only === "breakdown" ? [] : splits.filter(s => handLabels.includes(s.label));
  if (breakdown.length === 0 && handedness.length === 0) return <div style={{ color: "#74839d", fontSize: 12, padding: 10 }}>No split data</div>;

  const cellStyle = { padding: "6px 7px", textAlign: "center", fontSize: 12, fontFamily: "'JetBrains Mono', monospace", color: "#4c5f7d" };
  // Sticky label column needs an opaque background (scrolling cells pass under).
  const labelCell = { padding: "6px 8px", textAlign: "left", fontSize: 12, color: "#3c4f6d", fontWeight: 600, whiteSpace: "nowrap", background: SPLIT_STICK_BG };
  const thStyle = { padding: "4px 7px", textAlign: "center", fontSize: 9, color: "#74839d", textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 600 };
  const sectionTitle = { fontSize: 10, color: "#5d6f8b", textTransform: "uppercase", letterSpacing: 1, fontWeight: 700, padding: "8px 8px 4px", background: "rgba(32,98,200,0.064)" };

  const fmt2 = v => v != null && v !== "" && !isNaN(v) ? parseFloat(v).toFixed(2) : "—";
  const fmt1 = v => v != null && v !== "" && !isNaN(v) ? parseFloat(v).toFixed(1) : "—";
  const fmtN = v => v != null && v !== "" ? v : "—";
  const fmtAvgP = v => v != null && v !== "" && !isNaN(v) ? "." + Math.round(parseFloat(v) * 1000).toString().padStart(3, "0") : "—";

  return (
    <div className="hscroll">
      <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 560 }}>
        {breakdown.length > 0 && (<>
          <thead>
            <tr><td colSpan={17} style={sectionTitle}><StickyLabel>Breakdown</StickyLabel></td></tr>
            <tr style={{ borderBottom: "1px solid rgba(32,98,200,0.192)" }}>
              {["Split","ERA","W","L","SV","SVOP","GP","GS","CG","IP","H","R","ER","HR","BB","K","OBA"].map(h => (
                <th key={h} className={h === "Split" ? "stickcol" : undefined} style={{ ...thStyle, textAlign: h === "Split" ? "left" : "center", background: h === "Split" ? SPLIT_STICK_BG : undefined }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {breakdown.map((s, i) => {
              const st = s.stat || {};
              return (
                <tr key={i} style={{ borderBottom: "1px solid rgba(32,98,200,0.08)" }}>
                  <td className="stickcol" style={labelCell}>{s.label}</td>
                  <td style={{ ...cellStyle, color: parseFloat(st.era) < 3 ? "#0f8a44" : parseFloat(st.era) > 5 ? "#d03131" : "#4c5f7d" }}>{fmt2(st.era)}</td>
                  <td style={cellStyle}>{fmtN(st.wins)}</td>
                  <td style={cellStyle}>{fmtN(st.losses)}</td>
                  <td style={cellStyle}>{fmtN(st.saves ?? 0)}</td>
                  <td style={cellStyle}>{fmtN(st.saveOpportunities ?? 0)}</td>
                  <td style={cellStyle}>{fmtN(st.gamesPlayed)}</td>
                  <td style={cellStyle}>{fmtN(st.gamesStarted)}</td>
                  <td style={cellStyle}>{fmtN(st.completeGames ?? 0)}</td>
                  <td style={cellStyle}>{fmtN(st.inningsPitched)}</td>
                  <td style={cellStyle}>{fmtN(st.hits)}</td>
                  <td style={cellStyle}>{fmtN(st.runs)}</td>
                  <td style={cellStyle}>{fmtN(st.earnedRuns)}</td>
                  <td style={cellStyle}>{fmtN(st.homeRuns)}</td>
                  <td style={cellStyle}>{fmtN(st.baseOnBalls)}</td>
                  <td style={{ ...cellStyle, color: (st.strikeOuts || 0) >= 30 ? "#0f8a44" : "#4c5f7d", fontWeight: 600 }}>{fmtN(st.strikeOuts)}</td>
                  <td style={cellStyle}>{fmtAvgP(st.avg)}</td>
                </tr>
              );
            })}
          </tbody>
        </>)}
        {handedness.length > 0 && (<>
          <thead>
            <tr><td colSpan={17} style={{ ...sectionTitle, borderTop: breakdown.length > 0 ? "2px solid rgba(32,98,200,0.128)" : undefined }}><StickyLabel>Right / Left (Batters vs Pitcher)</StickyLabel></td></tr>
            <tr style={{ borderBottom: "1px solid rgba(32,98,200,0.192)" }}>
              {["Split","AB","R","H","2B","3B","HR","RBI","BB","HBP","SO","SB","CS","AVG","OBP","SLG","OPS"].map(h => (
                <th key={h} className={h === "Split" ? "stickcol" : undefined} style={{ ...thStyle, textAlign: h === "Split" ? "left" : "center", background: h === "Split" ? SPLIT_STICK_BG : undefined }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {handedness.map((s, i) => {
              const st = s.stat || {};
              return (
                <tr key={i} style={{ borderBottom: "1px solid rgba(32,98,200,0.08)" }}>
                  <td className="stickcol" style={labelCell}>{s.label}</td>
                  <td style={cellStyle}>{fmtN(st.atBats)}</td>
                  <td style={cellStyle}>{fmtN(st.runs)}</td>
                  <td style={cellStyle}>{fmtN(st.hits)}</td>
                  <td style={cellStyle}>{fmtN(st.doubles)}</td>
                  <td style={cellStyle}>{fmtN(st.triples)}</td>
                  <td style={cellStyle}>{fmtN(st.homeRuns)}</td>
                  <td style={cellStyle}>{fmtN(st.rbi)}</td>
                  <td style={cellStyle}>{fmtN(st.baseOnBalls)}</td>
                  <td style={cellStyle}>{fmtN(st.hitByPitch ?? 0)}</td>
                  <td style={{ ...cellStyle, color: (st.strikeOuts || 0) >= 20 ? "#0f8a44" : "#4c5f7d" }}>{fmtN(st.strikeOuts)}</td>
                  <td style={cellStyle}>{fmtN(st.stolenBases ?? 0)}</td>
                  <td style={cellStyle}>{fmtN(st.caughtStealing ?? 0)}</td>
                  <td style={{ ...cellStyle, color: parseFloat(st.avg) >= 0.300 ? "#d03131" : "#4c5f7d" }}>{fmtAvgP(st.avg)}</td>
                  <td style={cellStyle}>{fmtAvgP(st.obp)}</td>
                  <td style={cellStyle}>{fmtAvgP(st.slg)}</td>
                  <td style={{ ...cellStyle, color: parseFloat(st.ops) >= 0.900 ? "#d03131" : "#4c5f7d", fontWeight: parseFloat(st.ops) >= 0.900 ? 700 : 400 }}>{fmtAvgP(st.ops)}</td>
                </tr>
              );
            })}
          </tbody>
        </>)}
      </table>
    </div>
  );
}

export function GameLogTable({ logs, isPitching }) {
  if (!logs || logs.length === 0) return <div style={{ color: "#74839d", fontSize: 12, padding: 10 }}>No game log data</div>;
  const sorted = [...logs]; // getGameLog already returns newest-first
  return (
    <div className="hscroll">
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr style={{ borderBottom: "1px solid rgba(32,98,200,0.192)" }}>
          {isPitching ? (
            <><th className="th-sm">Date</th><th className="th-sm">vs</th><th className="th-sm">IP</th><th className="th-sm">H</th><th className="th-sm">ER</th><th className="th-sm">K</th><th className="th-sm">BB</th><th className="th-sm">HR</th><th className="th-sm">Dec</th></>
          ) : (
            <><th className="th-sm">Date</th><th className="th-sm">vs</th><th className="th-sm">AB</th><th className="th-sm">H</th><th className="th-sm">1B</th><th className="th-sm">2B</th><th className="th-sm">3B</th><th className="th-sm">HR</th><th className="th-sm">TB</th><th className="th-sm">RBI</th><th className="th-sm">SB</th><th className="th-sm">CS</th><th className="th-sm">BB</th><th className="th-sm">K</th></>
          )}
        </tr></thead>
        <tbody>{sorted.map((g, i) => {
          const s = g.stat;
          if (!s) return null;
          // opponent.id → abbreviation via reverse map; fall back to name initials
          const oppId = g.opponent?.id;
          const oppAbbr = (oppId && MLB_ID_TO_ABBREV_GL[oppId]) || g.opponent?.abbreviation || g.team?.abbreviation || "—";
          const opp = g.isHome === false ? `@${oppAbbr}` : oppAbbr;
          const date = g.date ? g.date.slice(5) : "—";
          const isHit = !isPitching && (s.hits > 0);
          const isHR = !isPitching && (s.homeRuns > 0);
          const singles = !isPitching ? Math.max(0, (s.hits||0)-(s.doubles||0)-(s.triples||0)-(s.homeRuns||0)) : 0;
          const tb = !isPitching ? singles + (s.doubles||0)*2 + (s.triples||0)*3 + (s.homeRuns||0)*4 : 0;
          return (
            <tr key={i} style={{ borderBottom: "1px solid rgba(32,98,200,0.08)", background: isHR ? "rgba(194,87,15,0.08)" : isHit ? "rgba(47,167,100,0.06)" : "transparent" }}>
              {isPitching ? (
                <><td className="td-sm">{date}</td><td className="td-sm">{opp}</td><td className="td-sm mono">{s.inningsPitched}</td><td className="td-sm mono">{s.hits}</td><td className="td-sm mono">{s.earnedRuns}</td><td className="td-sm mono" style={{ color: s.strikeOuts >= 7 ? "#0f8a44" : undefined }}>{s.strikeOuts}</td><td className="td-sm mono">{s.baseOnBalls}</td><td className="td-sm mono">{s.homeRuns}</td><td className="td-sm mono" style={{ color: s.wins > 0 ? "#0f8a44" : s.losses > 0 ? "#d03131" : "#74839d" }}>{s.wins > 0 ? "W" : s.losses > 0 ? "L" : "—"}</td></>
              ) : (
                <><td className="td-sm">{date}</td><td className="td-sm">{opp}</td><td className="td-sm mono">{s.atBats}</td><td className="td-sm mono" style={{ color: isHit ? "#0f8a44" : undefined }}>{s.hits}</td><td className="td-sm mono">{singles}</td><td className="td-sm mono" style={{ color: (s.doubles||0) > 0 ? "#2569d6" : undefined }}>{s.doubles||0}</td><td className="td-sm mono" style={{ color: (s.triples||0) > 0 ? "#6d4fd0" : undefined }}>{s.triples||0}</td><td className="td-sm mono" style={{ color: isHR ? "#a16207" : undefined, fontWeight: isHR ? 700 : 400 }}>{s.homeRuns}</td><td className="td-sm mono" style={{ fontWeight: 600, color: tb >= 3 ? "#0f8a44" : "#4c5f7d" }}>{tb}</td><td className="td-sm mono">{s.rbi}</td><td className="td-sm mono" style={{ color: (s.stolenBases||0) > 0 ? "#9333ea" : undefined }}>{s.stolenBases||0}</td><td className="td-sm mono" style={{ color: (s.caughtStealing||0) > 0 ? "#d03131" : undefined }}>{s.caughtStealing||0}</td><td className="td-sm mono">{s.baseOnBalls}</td><td className="td-sm mono">{s.strikeOuts}</td></>
              )}
            </tr>
          );
        })}</tbody>
      </table>
    </div>
  );
}

export function Section({ title, accent, children }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: accent || "#2062c8", textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 12, paddingBottom: 8, borderBottom: `1px solid ${accent || "#2062c8"}33`, display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ width: 3, height: 14, background: accent, borderRadius: 2 }} />{title}
      </div>
      {children}
    </div>
  );
}

export const MLB_TEAM_IDS = {
  ARI:109,ATL:144,BAL:110,BOS:111,CHC:112,CWS:145,CIN:113,CLE:114,
  COL:115,DET:116,HOU:117,KC:118,LAA:108,LAD:119,MIA:146,MIL:158,
  MIN:142,NYM:121,NYY:147,OAK:133,PHI:143,PIT:134,SD:135,SF:137,
  SEA:136,STL:138,TB:139,TEX:140,TOR:141,WSH:120,ATH:133,
};

// Reverse map: team id → abbreviation (for game log opponent lookup)
const MLB_ID_TO_ABBREV_GL = Object.fromEntries(Object.entries(MLB_TEAM_IDS).map(([k,v]) => [v, k]));

// ── MATCHUP ZONE CHART ─────────────────────────────────────────────────────────
// SVG zone heatmap (batter hot zones) + pitcher pitch location dots overlay.
// Coordinate system: Savant catcher-perspective — negative x = 3B/inside-RHB on left,
// positive x = 1B/outside-RHB on right. z = feet above ground.
export const PITCH_COLORS_ZONE = {
  FF:"#c62828",FA:"#c62828",SI:"#c2570f",FC:"#b45309",SL:"#a16207",
  SW:"#5c9a0c",ST:"#5c9a0c",KC:"#15803d",CU:"#0891b2",CH:"#6d38d8",
  FS:"#d61f7f",FO:"#d61f7f",CS:"#0891b2",KN:"#5d6b82",
};

export const ZONE_PITCH_LABELS = {
  FF:"4S-FB",FA:"4S-FB",SI:"Sinker",FC:"Cutter",SL:"Slider",SW:"Sweeper",
  ST:"Sweeper",KC:"K-Curve",CU:"Curve",CH:"Change",FS:"Split",FO:"Fork",CS:"Curve",KN:"Knuckle",
};

export function MatchupZoneChart({ hotZones, pitchLocations, arsenalData, metric = "ops", overlay = true, activePitchTypes, batterHand = "R" }) {
  const W = 210, H = 255;
  const PAD = 4; // small padding inside svg

  // Savant display range
  const xMin = -1.35, xMax = 1.35;
  const zMin = 0.65, zMax = 4.35;
  const toX = px => PAD + (px - xMin) / (xMax - xMin) * (W - PAD * 2);
  const toY = pz => PAD + (zMax - pz) / (zMax - zMin) * (H - PAD * 2);

  // Strike zone boundaries (standard)
  const szL = -0.708, szR = 0.708, szB = 1.5, szT = 3.5;
  const dx = (szR - szL) / 3, dz = (szT - szB) / 3;

  // 13-zone definitions in Savant coords [x1,z1 (bottom-left), x2,z2 (top-right)]
  const ZONE_DEFS = [
    { id:1,  x1:szL,        z1:szB+dz*2,  x2:szL+dx,      z2:szT },
    { id:2,  x1:szL+dx,     z1:szB+dz*2,  x2:szL+dx*2,    z2:szT },
    { id:3,  x1:szL+dx*2,   z1:szB+dz*2,  x2:szR,         z2:szT },
    { id:4,  x1:szL,        z1:szB+dz,    x2:szL+dx,      z2:szB+dz*2 },
    { id:5,  x1:szL+dx,     z1:szB+dz,    x2:szL+dx*2,    z2:szB+dz*2 },
    { id:6,  x1:szL+dx*2,   z1:szB+dz,    x2:szR,         z2:szB+dz*2 },
    { id:7,  x1:szL,        z1:szB,       x2:szL+dx,      z2:szB+dz },
    { id:8,  x1:szL+dx,     z1:szB,       x2:szL+dx*2,    z2:szB+dz },
    { id:9,  x1:szL+dx*2,   z1:szB,       x2:szR,         z2:szB+dz },
    { id:11, x1:xMin+PAD/W*(xMax-xMin), z1:szT, x2:0, z2:zMax-PAD/H*(zMax-zMin) },
    { id:12, x1:0, z1:szT, x2:xMax-PAD/W*(xMax-xMin), z2:zMax-PAD/H*(zMax-zMin) },
    { id:13, x1:xMin+PAD/W*(xMax-xMin), z1:zMin+PAD/H*(zMax-zMin), x2:0, z2:szB },
    { id:14, x1:0, z1:zMin+PAD/H*(zMax-zMin), x2:xMax-PAD/W*(xMax-xMin), z2:szB },
  ];

  function zoneColor(val, isChase) {
    if (val == null) return isChase ? "rgba(210,217,236,0.5)" : "rgba(194,204,229,0.7)";
    // Color scale: cold blue → neutral → hot red
    const v = metric === "ops" ? val : val * 3.2; // rough OPS equiv for avg
    const alpha = isChase ? 0.65 : 0.85;
    if (v < 0.45) return `rgba(20,60,160,${alpha})`;
    if (v < 0.60) return `rgba(40,100,200,${alpha})`;
    if (v < 0.72) return `rgba(80,140,210,${alpha})`;
    if (v < 0.82) return `rgba(200,140,40,${alpha})`;
    if (v < 0.95) return `rgba(220,70,25,${alpha})`;
    return `rgba(200,20,20,${alpha})`;
  }

  const hasHotZones = hotZones && Object.keys(hotZones).length > 0;
  const hasPitchDots = overlay && pitchLocations && Object.keys(pitchLocations).length > 0;

  return (
    <svg width={W} height={H} style={{ display:"block", overflow:"visible" }}>
      {/* Background */}
      <rect x={0} y={0} width={W} height={H} fill="rgba(222,226,241,0.98)" rx={6} />

      {/* Zone fills */}
      {ZONE_DEFS.map(z => {
        const isChase = z.id >= 11;
        const zData = hotZones?.[z.id];
        const val = zData ? (metric === "ops" ? zData.ops : zData.avg) : null;
        const x = toX(z.x1), y = toY(z.z2);
        const w = toX(z.x2) - toX(z.x1);
        const h = toY(z.z1) - toY(z.z2);
        const textVal = val != null
          ? (metric === "ops" ? val.toFixed(3) : val.toFixed(3).replace(/^0/, ""))
          : null;
        return (
          <g key={z.id}>
            <rect x={x} y={y} width={w} height={h}
              fill={zoneColor(val, isChase)}
              stroke="rgba(32,98,200,0.18)" strokeWidth={0.5} />
            {textVal && (
              <text x={x+w/2} y={y+h/2+(isChase?3:4)} textAnchor="middle"
                fontSize={isChase ? 9 : 12} fontFamily="'JetBrains Mono',monospace"
                fontWeight={700} fill="rgba(22,44,80,0.92)">
                {textVal}
              </text>
            )}
            {!textVal && !hasHotZones && (
              <text x={x+w/2} y={y+h/2+4} textAnchor="middle"
                fontSize={isChase ? 7 : 9} fill="rgba(22,44,80,0.15)">
                {z.id}
              </text>
            )}
          </g>
        );
      })}

      {/* Strike zone outline */}
      <rect x={toX(szL)} y={toY(szT)} width={toX(szR)-toX(szL)} height={toY(szB)-toY(szT)}
        fill="none" stroke="rgba(22,44,80,0.45)" strokeWidth={1.5} />

      {/* Home plate symbol */}
      {(() => {
        const px = W/2, py = H-PAD+2, hw = 9, hh = 5;
        return <polygon points={`${px-hw},${py} ${px+hw},${py} ${px+hw},${py-hh} ${px},${py-hh+3} ${px-hw},${py-hh}`}
          fill="rgba(22,44,80,0.12)" stroke="rgba(22,44,80,0.3)" strokeWidth={0.5} />;
      })()}

      {/* Pitch location dots */}
      {hasPitchDots && Object.entries(pitchLocations).map(([pt, loc]) => {
        if (activePitchTypes && !activePitchTypes.has(pt)) return null;
        const cx = toX(loc.px), cy = toY(loc.pz);
        const color = PITCH_COLORS_ZONE[pt] || "#5d6b82";
        const usage = arsenalData?.[pt]?.usage || 15;
        const r = Math.max(7, Math.min(16, usage / 4.5));
        return (
          <g key={pt}>
            <circle cx={cx} cy={cy} r={r+3} fill={color} opacity={0.12} />
            <circle cx={cx} cy={cy} r={r} fill={color} opacity={0.88}
              stroke="rgba(22,44,80,0.7)" strokeWidth={1.2} />
            <text x={cx} y={cy+3.5} textAnchor="middle" fontSize={7}
              fontWeight={800} fill="white" style={{ pointerEvents:"none" }}>
              {pt}
            </text>
          </g>
        );
      })}

      {/* No-data message */}
      {!hasHotZones && (
        <>
          <text x={W/2} y={H/2-10} textAnchor="middle" fontSize={10}
            fill="rgba(32,98,200,0.3)" fontFamily="sans-serif">Zone data unavailable</text>
          <text x={W/2} y={H/2+6} textAnchor="middle" fontSize={9}
            fill="rgba(32,98,200,0.2)" fontFamily="sans-serif">(MLB API not accessible)</text>
        </>
      )}
    </svg>
  );
}

// ── Pitch Movement Chart ── (break_x vs induced vertical break, in inches)
const PITCH_MOVE_COLORS = {
  FF:"#d03131", FA:"#d03131", SI:"#cf6c1c", FC:"#a16207",
  SL:"#0a8564", ST:"#0d9488", SV:"#0e8da6",
  CU:"#4f5ad9", KC:"#6d4fd0", CS:"#9333ea",
  CH:"#2569d6", FS:"#0d84c4", FO:"#0d7fc2",
  KN:"#243247",
};

// Tiny deterministic PRNG so the scatter cloud doesn't reshuffle on every re-render.
// Mulberry32 seeded by pitch code so each pitch gets its own stable jitter.
function _mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6D2B79F5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function _strHash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }

// Box-Muller for gaussian jitter (so scatter clouds look like real Savant pitch dispersion).
function _gauss(rng) {
  const u = Math.max(rng(), 1e-9), v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Savant-style polar pitch-movement chart.
// Concentric inch-rings (12/18/24"), hatched MLB-avg ellipses per pitch (same-hand),
// scattered player dots around the pitcher's (px, pz), arm-angle stick figure in
// bottom-right, and a per-pitch bottom legend (Usage / MPH / LHP-or-RHP avg MPH).
export function PitchMovementChart({ pitchLocs, lgPitchMove, pitcherHand = "R", armAngle = null, year, width = 360, height = 360 }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => { const t = setTimeout(() => setVisible(true), 60); return () => clearTimeout(t); }, [pitchLocs]);

  if (!pitchLocs || Object.keys(pitchLocs).length === 0) {
    return (
      <div style={{ width, height, display:"flex", alignItems:"center", justifyContent:"center",
        background:"rgba(222,226,241,0.95)", borderRadius:8, border:"1px solid rgba(32,98,200,0.128)" }}>
        <span style={{ fontSize:10, color:"rgba(32,98,200,0.25)", textAlign:"center", lineHeight:1.8 }}>
          Pitch movement<br/>data unavailable
        </span>
      </div>
    );
  }

  const W = width, H = height;
  const cx0 = W / 2, cy0 = H / 2 - 6;
  const SPAN = 26;  // ± inches on each axis
  const R = Math.min(W, H) * 0.42;
  const toX = v => cx0 + (v / SPAN) * R;
  const toY = v => cy0 - (v / SPAN) * R;

  // For LHP, mirror the viewer x-axis so the arm-side cluster always appears on
  // the same side of the chart regardless of handedness. Matches Savant convention.
  const handIsL = (pitcherHand || "R").toUpperCase().startsWith("L");
  const flipX = x => handIsL ? -x : x;
  const lgForHand = (lgPitchMove && lgPitchMove[handIsL ? "L" : "R"]) || {};

  const totalN = Object.values(pitchLocs).reduce((s, v) => s + v.n, 0) || 1;
  const entries = Object.entries(pitchLocs).sort((a,b) => b[1].n - a[1].n);

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
      <svg width={W} height={H} style={{ display:"block", overflow:"visible" }}>
        <defs>
          {entries.map(([pt]) => {
            const c = PITCH_MOVE_COLORS[pt] || "#5d6b82";
            return (
              <pattern key={`p-${pt}`} id={`hatch-${pt}`} patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(35)">
                <rect width="6" height="6" fill={c} opacity={0.05}/>
                <line x1="0" y1="0" x2="0" y2="6" stroke={c} strokeWidth="1.4" opacity={0.65}/>
              </pattern>
            );
          })}
        </defs>

        <rect x={0} y={0} width={W} height={H} fill="rgba(229,233,244,0.98)" rx={8}/>

        {/* Concentric inch-rings at 6 / 12 / 18 / 24" */}
        {[24,18,12,6].map(r => {
          const rad = (r / SPAN) * R;
          return <circle key={`r${r}`} cx={cx0} cy={cy0} r={rad}
            fill="none" stroke="rgba(32,98,200,0.16)" strokeWidth={r===12 ? 1 : 0.6}
            strokeDasharray={r===12 ? "none" : "2,5"}/>;
        })}
        {[12,18,24].map(r => (
          <text key={`rl${r}`} x={cx0+3} y={cy0 - (r/SPAN)*R - 3} fontSize={8}
            fill="rgba(32,98,200,0.3)" fontFamily="'JetBrains Mono',monospace">{r}"</text>
        ))}

        {/* Cross-axes */}
        <line x1={cx0} y1={cy0-R} x2={cx0} y2={cy0+R} stroke="rgba(32,98,200,0.22)" strokeWidth={1}/>
        <line x1={cx0-R} y1={cy0} x2={cx0+R} y2={cy0} stroke="rgba(32,98,200,0.22)" strokeWidth={1}/>

        {/* Direction labels */}
        <text x={cx0} y={cy0-R-8} textAnchor="middle" fontSize={9} fill="rgba(60,80,110,0.55)"
          fontWeight={600} letterSpacing={0.5}>
          {handIsL ? "3B ◄ MOVES TOWARD ► 1B" : "1B ◄ MOVES TOWARD ► 3B"}
        </text>
        <text x={cx0-R-6} y={cy0-R+4} textAnchor="end" fontSize={8} fill="rgba(60,80,110,0.35)"
          fontStyle="italic">MORE RISE ▲</text>
        <text x={cx0-R-6} y={cy0+R} textAnchor="end" fontSize={8} fill="rgba(60,80,110,0.35)"
          fontStyle="italic">MORE DROP ▼</text>

        {/* Hatched MLB-avg ellipses (per pitch type, same hand) */}
        {entries.map(([pt]) => {
          const lg = lgForHand[pt];
          if (!lg || lg.px == null || lg.pz == null) return null;
          const cx = toX(flipX(lg.px));
          const cy = toY(lg.pz);
          const rxIn = 4.5, ryIn = 4.0;
          const rx = (rxIn / SPAN) * R, ry = (ryIn / SPAN) * R;
          return (
            <ellipse key={`lg-${pt}`} cx={cx} cy={cy} rx={rx} ry={ry}
              fill={`url(#hatch-${pt})`} stroke={PITCH_MOVE_COLORS[pt] || "#5d6b82"}
              strokeOpacity={0.4} strokeWidth={0.8} strokeDasharray="3,3"/>
          );
        })}

        <circle cx={cx0} cy={cy0} r={2.5} fill="rgba(32,98,200,0.45)"/>

        {/* Player scatter clouds — jittered dots around (px, pz), usage-scaled count */}
        {entries.map(([pt, d], idx) => {
          if (d.px == null || d.pz == null) return null;
          const color = PITCH_MOVE_COLORS[pt] || "#5d6b82";
          const cx = toX(flipX(d.px)), cy = toY(d.pz);
          const usage = d.n / totalN;
          const nDots = Math.max(12, Math.round(usage * 100));
          const rng = _mulberry32(_strHash(pt) >>> 0);
          const sigX = (2.0 / SPAN) * R, sigY = (2.5 / SPAN) * R;
          const dots = [];
          for (let i = 0; i < nDots; i++) {
            const dx = _gauss(rng) * sigX;
            const dy = _gauss(rng) * sigY;
            dots.push(<circle key={i} cx={cx+dx} cy={cy+dy} r={3.5}
              fill={color} opacity={0.55} stroke="rgba(22,44,80,0.2)" strokeWidth={0.5}/>);
          }
          return (
            <g key={pt} style={{ opacity: visible ? 1 : 0, transition:`opacity 0.45s ease ${idx*90}ms` }}>
              {dots}
            </g>
          );
        })}

        {/* Arm-angle stick figure (bottom-right) */}
        {armAngle != null && (() => {
          const ax = W - 38, ay = H - 26;
          const a = (armAngle * Math.PI) / 180;
          const xs = handIsL ? -1 : 1;
          const armLen = 16;
          const shoulderX = ax;
          const shoulderY = ay - 6;
          const releaseX = shoulderX + xs * armLen * Math.cos(a);
          const releaseY = shoulderY - armLen * Math.sin(a);
          return (
            <g>
              <circle cx={ax} cy={ay-16} r={3.5} fill="none" stroke="rgba(60,80,110,0.55)" strokeWidth={1.2}/>
              <line x1={ax} y1={ay-12} x2={ax} y2={ay+8} stroke="rgba(60,80,110,0.55)" strokeWidth={1.2}/>
              <line x1={ax} y1={ay-6} x2={ax - xs*10} y2={ay+3} stroke="rgba(60,80,110,0.35)" strokeWidth={1}/>
              <line x1={shoulderX} y1={shoulderY} x2={releaseX} y2={releaseY}
                stroke="#a16207" strokeWidth={1.8} strokeLinecap="round"/>
              <circle cx={releaseX} cy={releaseY} r={2} fill="#a16207"/>
              <line x1={ax} y1={ay+8} x2={ax-4} y2={ay+18} stroke="rgba(60,80,110,0.45)" strokeWidth={1.1}/>
              <line x1={ax} y1={ay+8} x2={ax+4} y2={ay+18} stroke="rgba(60,80,110,0.45)" strokeWidth={1.1}/>
              <text x={ax} y={ay+30} textAnchor="middle" fontSize={8} fill="rgba(60,80,110,0.5)" letterSpacing={0.5}>ARM ANGLE</text>
              <text x={ax} y={ay+41} textAnchor="middle" fontSize={13} fontWeight={800} fill="#a16207" fontFamily="'JetBrains Mono',monospace">{armAngle.toFixed(0)}°</text>
            </g>
          );
        })()}

        {/* Header badge (top-left, like Savant) */}
        <text x={14} y={20} fontSize={9} fontWeight={800} fill="rgba(60,80,110,0.55)" letterSpacing={0.8}>
          {year ? `${year} ` : ""}MOVEMENT PROFILE
        </text>
        <text x={14} y={32} fontSize={8} fill="rgba(60,80,110,0.3)" fontStyle="italic">
          induced break · sample ∝ usage
        </text>
      </svg>

      {/* Bottom per-pitch legend (Pitch / Usage% / MPH / Lg-Avg MPH) */}
      <div style={{ background:"rgba(222,226,241,0.7)", borderRadius:8, border:"1px solid rgba(32,98,200,0.128)", padding:"6px 8px 4px" }}>
        <div style={{ display:"grid", gridTemplateColumns:`repeat(${entries.length}, 1fr)`, gap:4 }}>
          {entries.map(([pt, d]) => {
            const color = PITCH_MOVE_COLORS[pt] || "#5d6b82";
            const usage = (d.n / totalN) * 100;
            const lgV = lgForHand[pt]?.speed;
            return (
              <div key={pt} style={{ textAlign:"center", padding:"2px 0" }}>
                <div style={{ height:6, background:color, borderRadius:3, marginBottom:4, boxShadow:`0 0 6px ${color}88` }}/>
                <div style={{ fontSize:10, fontWeight:800, color, fontFamily:"'JetBrains Mono',monospace" }}>{pt}</div>
                <div style={{ fontSize:7, color:"#b6c5dc", textTransform:"uppercase", letterSpacing:0.5, marginTop:3 }}>USAGE</div>
                <div style={{ fontSize:10, fontWeight:700, color:"#4c5f7d", fontFamily:"'JetBrains Mono',monospace" }}>{usage.toFixed(0)}%</div>
                <div style={{ fontSize:7, color:"#b6c5dc", textTransform:"uppercase", letterSpacing:0.5, marginTop:3 }}>MPH</div>
                <div style={{ fontSize:10, fontWeight:700, color:"#16233c", fontFamily:"'JetBrains Mono',monospace" }}>{d.speed ? d.speed.toFixed(1) : "—"}</div>
                <div style={{ fontSize:7, color:"#b6c5dc", textTransform:"uppercase", letterSpacing:0.5, marginTop:3 }}>{handIsL?"LHP":"RHP"} AVG</div>
                <div style={{ fontSize:9, color:"#64748d", fontFamily:"'JetBrains Mono',monospace" }}>{lgV ? lgV.toFixed(1) : "—"}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Pitch Breakdown Table ── (movement + usage + whiff, per pitch type)
export function PitchBreakdownTable({ pitchLocs, arsenalSplits, statcastData, compact = false }) {
  if (!pitchLocs || Object.keys(pitchLocs).length === 0) return null;

  // Build arsenal map from MLB splits
  const aMap = {};
  if (arsenalSplits) {
    for (const split of arsenalSplits) {
      const code = split.stat?.type?.code || split.split?.pitchType?.code;
      if (code) aMap[code] = {
        usage: (parseFloat(split.stat?.percentage) || 0) * 100,
        count: parseInt(split.stat?.count) || 0,
        vel:   parseFloat(split.stat?.averageSpeed) || null,
      };
    }
  }

  const totalN = Object.values(pitchLocs).reduce((s, v) => s + v.n, 0);
  const entries = Object.entries(pitchLocs).sort((a, b) => {
    const ua = aMap[a[0]]?.usage ?? (totalN > 0 ? a[1].n / totalN * 100 : 0);
    const ub = aMap[b[0]]?.usage ?? (totalN > 0 ? b[1].n / totalN * 100 : 0);
    return ub - ua;
  });

  const cols = compact
    ? ["Pitch","Velo","IVB","HB","Use%"]
    : ["Pitch","Velo","IVB","HB","Use%","SwStr%"];

  return (
    <div style={{ marginTop:10, background:"rgba(222,226,241,0.7)", borderRadius:8,
      border:"1px solid rgba(32,98,200,0.128)", overflow:"hidden" }}>
      {/* Header */}
      <div style={{ display:"grid", gridTemplateColumns: compact ? "2fr 1fr 1fr 1fr 1fr" : "2fr 1fr 1fr 1fr 1fr 1fr",
        padding:"5px 10px", borderBottom:"1px solid rgba(32,98,200,0.16)", background:"rgba(210,217,236,0.6)" }}>
        {cols.map(h => (
          <div key={h} style={{ fontSize:8.5, color:"#8b99b0", textTransform:"uppercase",
            letterSpacing:0.6, fontWeight:700, textAlign: h==="Pitch" ? "left" : "center" }}>
            {h}
          </div>
        ))}
      </div>
      {/* Rows */}
      {entries.map(([code, d], i) => {
        const color = PITCH_MOVE_COLORS[code] || "#5d6b82";
        const usage = aMap[code]?.usage ?? (totalN > 0 ? d.n / totalN * 100 : 0);
        const velo  = aMap[code]?.vel ?? d.speed;
        const whiff = statcastData?.[code]?.whiff;
        const ivbColor = d.pz >= 14 ? "#0f8a44" : d.pz >= 6 ? "#4c5f7d" : d.pz >= 0 ? "#a16207" : "#d03131";
        return (
          <div key={code} style={{
            display:"grid",
            gridTemplateColumns: compact ? "2fr 1fr 1fr 1fr 1fr" : "2fr 1fr 1fr 1fr 1fr 1fr",
            padding:"5px 10px", alignItems:"center",
            borderBottom: i < entries.length-1 ? "1px solid rgba(32,98,200,0.08)" : "none",
            background: i % 2 === 0 ? "transparent" : "rgba(32,98,200,0.032)",
          }}>
            {/* Pitch type */}
            <div style={{ display:"flex", alignItems:"center", gap:6 }}>
              <div style={{ width:7, height:7, borderRadius:"50%", background:color, flexShrink:0,
                boxShadow:`0 0 5px ${color}88` }} />
              <span style={{ color, fontWeight:700, fontSize:10.5, fontFamily:"'JetBrains Mono',monospace" }}>{code}</span>
              <span style={{ color:"#8b99b0", fontSize:8.5, whiteSpace:"nowrap", overflow:"hidden",
                textOverflow:"ellipsis", maxWidth:60 }}>
                {ZONE_PITCH_LABELS?.[code] || d.name || ""}
              </span>
            </div>
            {/* Velo */}
            <div style={{ textAlign:"center", fontFamily:"'JetBrains Mono',monospace",
              fontSize:11, fontWeight:600, color:"#3c4f6d" }}>
              {velo ? velo.toFixed(1) : "—"}
            </div>
            {/* IVB */}
            <div style={{ textAlign:"center", fontFamily:"'JetBrains Mono',monospace",
              fontSize:11, fontWeight:700, color: ivbColor }}>
              {d.pz >= 0 ? "+" : ""}{d.pz.toFixed(1)}"
            </div>
            {/* HB */}
            <div style={{ textAlign:"center", fontFamily:"'JetBrains Mono',monospace",
              fontSize:11, fontWeight:600, color:"#5d6f8b" }}>
              {d.px >= 0 ? "+" : ""}{d.px.toFixed(1)}"
            </div>
            {/* Usage */}
            <div style={{ textAlign:"center" }}>
              <span style={{ fontFamily:"'JetBrains Mono',monospace", fontSize:11,
                fontWeight:700, color }}>
                {usage.toFixed(1)}%
              </span>
            </div>
            {/* SwStr% */}
            {!compact && (
              <div style={{ textAlign:"center", fontFamily:"'JetBrains Mono',monospace", fontSize:11,
                fontWeight:600,
                color: whiff != null ? (whiff > 28 ? "#0f8a44" : whiff > 16 ? "#4c5f7d" : "#d03131") : "#c9d5e8" }}>
                {whiff != null ? whiff.toFixed(1)+"%" : "—"}
              </div>
            )}
          </div>
        );
      })}
      {/* Footer note */}
      <div style={{ padding:"4px 10px 5px", fontSize:8, color:"#c9d5e8", borderTop:"1px solid rgba(32,98,200,0.08)" }}>
        IVB = induced vertical break · HB = horizontal break · inches · + = rise / arm-side
      </div>
    </div>
  );
}

export const PITCH_COLORS = { FF:"#c62828", SI:"#c2570f", FC:"#b45309", SL:"#6d4fd0", CU:"#2569d6", KC:"#0d84c4", CH:"#0f8a44", FS:"#0a8564", SV:"#9333ea", ST:"#cf6c1c", CS:"#3b74cf", KN:"#243247" };

export const PITCH_LABELS = { FF:"4-Seam", SI:"Sinker", FC:"Cutter", SL:"Slider", CU:"Curveball", KC:"Knuckle-Curve", CH:"Changeup", FS:"Splitter", SV:"Sweeper", ST:"Sweeper", CS:"Slow Curve", KN:"Knuckleball" };
