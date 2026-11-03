import { placeWindowValue } from "../lib/recentWindow.js";

/**
 * Batter Statcast percentile card — Savant-style bars, season-anchored.
 *
 * Moved out of App.jsx when the recent-form window landed (project rule: any component
 * meaningfully edited inside App.jsx moves to src/components in the same commit).
 *
 * TWO MARKERS PER BAR. The filled badge is the season percentile — Savant's own, and the
 * number that anchors every read. The hollow ring is where the last 15 games sit, placed by
 * the shift measured against the league season distribution (see lib/recentWindow.js). The
 * gap between them IS the hot/cold signal, on one scale.
 *
 * WHY SEASON STAYS PRIMARY. scripts/recent-form-lift.mjs tested whether a window carries
 * information season-to-date does not, across 10,347 batter-days: it does not, at any window
 * length tried, on any outcome (ΔAUC −0.003 to −0.011 under walk-forward), and its
 * coefficients lean mean-reverting. So the window is context, never the headline — and rows
 * whose window is mostly sampling noise are dimmed or drawn without a ring at all.
 */

const BADGE_BG = "#eef1f8";          // card background — the ring punches through the track
const GOOD = "#0f8a44";
const BAD  = "#d03131";

const rankColor = r => r == null ? "#74839d"
  : r >= 80 ? "#0f8a44" : r >= 60 ? "#65a30d" : r >= 40 ? "#a16207" : r >= 20 ? "#c2570f" : "#d03131";

/** Season value and league-distribution key for each metric a window can carry. */
const WINDOW_ROWS = {
  exitVelo:    { season: p => p?.exitVelo,    savant: "exit_velocity" },
  barrelPct:   { season: p => p?.barrelRate,  savant: "brl_percent" },
  hardHitPct:  { season: p => p?.hardHitPct,  savant: "hard_hit_percent" },
  bbPct:       { season: p => p?.bbPct,       savant: "bb_percent" },
  kPct:        { season: p => p?.kPct,        savant: "k_percent" },
  whiffPct:    { season: p => p?.whiffPct,    savant: "whiff_percent" },
  chasePct:    { season: p => p?.chasePct,    savant: "chase_percent" },
  batSpeed:    { season: p => p?.batSpeed,    savant: "bat_speed" },
  swingLength: { season: p => p?.swingLength, savant: "swing_length" },
};

const MON = "'JetBrains Mono',monospace";

export default function StatcastCard({ percentiles, powerStats, playerName, hintsEnabled = false, recent = null, league = null }) {
  if (!percentiles) {
    return (
      <div style={{ textAlign:"center", padding:40, color:"#b6c5dc", fontSize:12 }}>
        Loading Statcast data…
      </div>
    );
  }
  const p = percentiles;
  const fmt1 = (v) => v != null ? v.toFixed(1) : null;
  const fmtPct = (v) => v != null ? v.toFixed(1) + "%" : null;
  const fmtOBA = (v) => v != null ? "." + Math.round(v * 1000).toString().padStart(3,"0") : null;
  // Generational suffixes are not surnames — the bare last token turns Chisholm Jr. into "JR."
  const lastName = (() => {
    if (!playerName) return "Player";
    const SUFFIX = /^(jr|sr|ii|iii|iv|v)\.?$/i;
    const parts = playerName.trim().split(/\s+/).filter(t => !SUFFIX.test(t));
    return parts.length ? parts[parts.length - 1] : "Player";
  })();

  /** Placement + formatted window value for one row, or null if it can't be drawn honestly. */
  const windowFor = (metric, fmt, unit = "") => {
    if (!metric || !recent?.values || !league) return null;
    const spec = WINDOW_ROWS[metric];
    if (!spec) return null;
    const wv = recent.values[metric];
    const sv = spec.season(powerStats);
    if (wv == null || sv == null) return null;
    const place = placeWindowValue({
      metric, windowValue: wv, seasonValue: sv,
      savantPct: p[spec.savant], leagueSorted: league[metric], counts: recent.counts,
    });
    if (!place) return null;
    const d = place.delta;
    return {
      ...place,
      text: (fmt(wv) ?? "—") + unit,
      deltaText: (d >= 0 ? "▲" : "▼") + Math.abs(d).toFixed(Math.abs(d) < 10 ? 1 : 0),
    };
  };

  /**
   * Savant-style percentile bar carrying both windows. Season badge is drawn last so it is
   * never occluded; the ring and connector sit beneath it.
   */
  const PctBar = ({ rank, win }) => {
    const r = rank != null ? Math.round(rank) : null;
    const col = rankColor(r);
    const pos = r != null ? Math.max(3, Math.min(97, r)) : 0;
    // A thin window gets no marker at all — a ring on 3 batted balls would read as a
    // measurement. `marginal` is drawn faintly: visible, but plainly discounted.
    // MIN_GAP: below a few percentile points the ring lands under the season badge and reads
    // as a rendering artefact rather than as "these agree". The delta chip still carries the
    // exact number, so nothing is lost by leaving the bar clean.
    const MIN_GAP = 4;
    const showRing = win && win.tier !== "thin" && Math.abs(win.shift) >= MIN_GAP;
    const wPos = showRing ? Math.max(3, Math.min(97, win.pct)) : null;
    const dirCol = win?.better ? GOOD : BAD;
    const strong = win?.tier === "stable";
    const ringOp = strong ? 1 : 0.45;

    return (
      <div style={{ position:"relative", width:"100%", height:20, display:"flex", alignItems:"center" }}>
        <div style={{ position:"absolute", left:0, right:0, top:"50%", transform:"translateY(-50%)", height:6, background:"rgba(32,98,200,0.128)", borderRadius:3 }} />
        <div style={{ position:"absolute", left:"50%", top:"50%", transform:"translate(-50%, -50%)", width:1, height:10, background:"rgba(93,111,139,0.35)" }} />
        <div style={{ position:"absolute", left:"25%", top:"50%", transform:"translate(-50%, -50%)", width:1, height:6, background:"rgba(93,111,139,0.18)" }} />
        <div style={{ position:"absolute", left:"75%", top:"50%", transform:"translate(-50%, -50%)", width:1, height:6, background:"rgba(93,111,139,0.18)" }} />
        {r != null && (
          <div style={{ position:"absolute", left:0, top:"50%", transform:"translateY(-50%)", height:6, width:`${pos}%`, background:col, opacity:0.5, borderRadius:3 }} />
        )}
        {showRing && (
          <>
            {/* Connector: length is the measured shift, colour is its direction. */}
            <div style={{
              position:"absolute", top:"50%", transform:"translateY(-50%)",
              left:`${Math.min(pos, wPos)}%`, width:`${Math.abs(wPos - pos)}%`,
              height:6, borderRadius:3, background:dirCol, opacity: strong ? 0.55 : 0.28,
            }} />
            <div style={{
              position:"absolute", left:`${wPos}%`, top:"50%", transform:"translate(-50%, -50%)",
              width:12, height:12, borderRadius:6, background:BADGE_BG,
              border:`${strong ? 2 : 1.5}px solid ${dirCol}`, opacity:ringOp, boxSizing:"border-box",
            }} />
          </>
        )}
        {r != null && (
          // 2.5px of card background around the badge so it punches cleanly over a connector
          // or ring that runs beneath it, instead of appearing fused to one.
          <div style={{ position:"absolute", left:`${pos}%`, top:"50%", transform:"translate(-50%, -50%)", minWidth:19, height:19, padding:"0 4px", borderRadius:10, background:col, border:`2.5px solid ${BADGE_BG}`, display:"flex", alignItems:"center", justifyContent:"center", boxShadow:`0 0 4px ${col}55` }}>
            <span style={{ fontSize:9, fontWeight:800, color:"#eef1f8", fontFamily:"system-ui" }}>{r}</span>
          </div>
        )}
      </div>
    );
  };

  const LABEL_W = 92;
  const VAL_W   = 84;
  const LG_W    = 52;

  const TableSection = ({ title, rows }) => {
    const validRows = rows.filter(r => r.pct != null);
    if (!validRows.length) return null;
    const showPlayerCol = validRows.some(r => r.rawVal);
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
          {validRows.map(({ label, pct, rawVal, lgAvg, hint, win }, i) => {
            const r = Math.round(pct);
            const dirCol = win?.better ? GOOD : BAD;
            const strong = win?.tier === "stable";
            const title2 = win
              ? `Last ${recent?.games ?? 15} games: ${win.text} (season ${rawVal || "—"})`
                + (strong ? "" : " · small sample — discount this")
              : undefined;
            return (
              <div key={label} title={hintsEnabled && hint ? hint : undefined} style={{ display:"flex", alignItems:"center", padding:"5px 0", borderBottom: i < validRows.length - 1 ? "1px solid rgba(32,98,200,0.096)" : "none", gap:8 }}>
                <span style={{ fontSize:11, color:"#5d6f8b", width:LABEL_W }}>{label}</span>
                <div style={{ flex:1, minWidth:80 }}>
                  <PctBar rank={r} win={win} />
                </div>
                {showPlayerCol && (
                  <div style={{ width:VAL_W, textAlign:"right", lineHeight:1.15 }}>
                    <div style={{ fontSize:11, fontWeight:700, color:"#16233c", fontFamily:MON }}>{rawVal || "—"}</div>
                    {win && (
                      // Colour always carries direction, opacity carries confidence. Greying
                      // a marginal row out entirely left "K% ▲9.1" looking like good news —
                      // the arrow tracks the raw value, so only colour says whether up is bad.
                      <div title={title2} style={{ fontSize:8.5, fontFamily:MON, marginTop:1, color: dirCol, opacity: strong ? 1 : 0.6, whiteSpace:"nowrap" }}>
                        <span style={{ color:"#b6c5dc", letterSpacing:0.3 }}>L15 </span>
                        {win.text} <span style={{ fontWeight:700 }}>{win.deltaText}</span>
                      </div>
                    )}
                  </div>
                )}
                <span style={{ width:LG_W, textAlign:"right", fontSize:10, fontWeight:600, color:"#64748d", fontFamily:MON }}>{lgAvg || "—"}</span>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  const hasWindow = !!(recent?.values && league);

  return (
    <div>
      {hasWindow && (
        <div style={{ display:"flex", alignItems:"center", flexWrap:"wrap", gap:"4px 12px", marginBottom:10, padding:"6px 8px", background:"rgba(32,98,200,0.05)", borderRadius:6, fontSize:9, color:"#74839d" }}>
          <span style={{ display:"flex", alignItems:"center", gap:4 }}>
            <span style={{ width:11, height:11, borderRadius:6, background:"#5d6f8b", display:"inline-block" }} />
            season percentile
          </span>
          <span style={{ display:"flex", alignItems:"center", gap:4 }}>
            <span style={{ width:11, height:11, borderRadius:6, background:BADGE_BG, border:"2px solid #5d6f8b", display:"inline-block", boxSizing:"border-box" }} />
            last {recent.games} games
          </span>
          <span style={{ color:"#b6c5dc" }}>
            {recent.counts?.pa ?? 0} PA · {recent.counts?.bbe ?? 0} BBE
            {recent.firstDate ? ` · ${recent.firstDate.slice(5)} – ${recent.lastDate.slice(5)}` : ""}
          </span>
        </div>
      )}

      <TableSection title="Contact Quality" rows={[
        { label:"Exit Velocity", pct:p.exit_velocity,   rawVal: fmt1(powerStats?.exitVelo) ? fmt1(powerStats.exitVelo)+" mph" : null, lgAvg:"88.5 mph", hint:"Exit velo percentile. 99 = hardest contact in MLB.", win: windowFor("exitVelo", fmt1, " mph") },
        { label:"Max EV",        pct:p.max_ev,           rawVal: null, lgAvg:null, hint:"Max exit velocity percentile — ceiling power." },
        { label:"Barrel%",       pct:p.brl_percent,      rawVal: fmtPct(powerStats?.barrelRate), lgAvg:"8%",   hint:"Barrels per batted ball. Optimal EV + launch angle. Best HR predictor.", win: windowFor("barrelPct", fmtPct) },
        { label:"Hard Hit%",     pct:p.hard_hit_percent, rawVal: fmtPct(powerStats?.hardHitPct), lgAvg:"36%",  hint:"Balls hit ≥95 mph. Hard contact drives both hits and total bases.", win: windowFor("hardHitPct", fmtPct) },
      ]} />
      <TableSection title="Expected Outcomes" rows={[
        { label:"xwOBA",  pct:p.xwoba, rawVal: fmtOBA(powerStats?.xwoba), lgAvg:".310", hint:"Expected wOBA by contact quality. Best single luck-adjusted production metric." },
        { label:"xBA",    pct:p.xba,   rawVal: fmtOBA(powerStats?.xba),   lgAvg:".240", hint:"Expected batting average by contact quality. If xBA >> BA, regression to mean is due." },
        { label:"xSLG",   pct:p.xslg,  rawVal: null,                       lgAvg:null,   hint:"Expected slugging. Best predictor of future total bases." },
        { label:"xOBP",   pct:p.xobp,  rawVal: null,                       lgAvg:null,   hint:"Expected OBP by contact quality and walk rate." },
      ]} />
      <TableSection title="Plate Discipline" rows={[
        { label:"BB%",    pct:p.bb_percent,    rawVal: fmtPct(powerStats?.bbPct),    lgAvg:"8.5%", hint:"Walk rate. Higher = better eye. Boosts OBP and run-scoring.", win: windowFor("bbPct", fmtPct) },
        { label:"K%",     pct:p.k_percent,     rawVal: fmtPct(powerStats?.kPct),     lgAvg:"22.5%",hint:"Strikeout rate. Lower = better contact. Affects hits and TB props most.", win: windowFor("kPct", fmtPct) },
        { label:"Whiff%", pct:p.whiff_percent, rawVal: fmtPct(powerStats?.whiffPct), lgAvg:"24%",  hint:"Swings-and-misses per swing. Lower = better contact.", win: windowFor("whiffPct", fmtPct) },
        { label:"Chase%", pct:p.chase_percent, rawVal: fmtPct(powerStats?.chasePct), lgAvg:"28%",  hint:"Out-of-zone swing rate. Lower = better discipline.", win: windowFor("chasePct", fmtPct) },
      ]} />
      {(p.bat_speed != null || p.swing_length != null || p.squared_up_rate != null) && (
        <TableSection title="Bat Speed (2024+)" rows={[
          { label:"Bat Speed",    pct:p.bat_speed,       rawVal: fmt1(powerStats?.batSpeed) ? fmt1(powerStats.batSpeed)+" mph" : null, lgAvg:"71 mph", hint:"Bat speed in mph. Higher = more raw power potential.", win: windowFor("batSpeed", fmt1, " mph") },
          { label:"Squared Up%",  pct:p.squared_up_rate, rawVal: null,                                                                  lgAvg:null,     hint:"Well-timed contact rate — bat meets ball flush." },
          { label:"Swing Length", pct:p.swing_length,    rawVal: fmt1(powerStats?.swingLength) ? fmt1(powerStats.swingLength)+'"' : null, lgAvg:null,   hint:"Swing path length — how far the barrel travels to contact.", win: windowFor("swingLength", fmt1, '"') },
        ]} />
      )}
      {p.sprint_speed != null && (
        <TableSection title="Speed" rows={[
          { label:"Sprint Speed", pct:p.sprint_speed, rawVal: null, lgAvg:"27 ft/s", hint:"Savant sprint speed. Elite: 29+ ft/s. Below avg: <25 ft/s." },
        ]} />
      )}
      <div style={{ fontSize:9, color:"#c9d5e8", marginTop:4, lineHeight:1.5 }}>
        Percentile ranks vs all MLB batters · Source: Baseball Savant · 99 = best, 1 = worst
        {hasWindow && (
          <>
            <br />
            Faint rings are small-sample rows — a 15-game barrel% swings nearly as much as the
            gap between real hitters. Recent form tested no better than season-to-date at
            predicting outcomes, so it is shown as context, not as a signal.
          </>
        )}
      </div>
    </div>
  );
}
