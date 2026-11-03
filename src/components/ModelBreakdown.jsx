import { useState } from "react";

/**
 * ModelBreakdown — internal reference for the projection engine.
 *
 * One tab per prop model (Hits, H+R+RBI, HR, TB, SB, RBI, Pitcher Ks) plus a
 * shared Scoring & EV tab. Each model tab documents its inputs/weights, the
 * multiplier chain that scales the base rate, line selection + probability
 * calibration, the pick thresholds, and the data sources it consumes.
 *
 * This is descriptive documentation of src/lib/models.js — when a model's math
 * changes, update the matching tab here. Gated behind ModelGate (not public).
 */

const Section = ({ title, accent = "#2062c8", children }) => (
  <div style={{ background: "rgba(22,44,80,0.03)", border: "1px solid rgba(32,98,200,0.16)", borderRadius: 10, padding: "16px 18px", marginBottom: 12 }}>
    <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, color: accent, marginBottom: 12 }}>{title}</div>
    {children}
  </div>
);

const Row = ({ label, value, sub, color, mono = true }) => (
  <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid rgba(32,98,200,0.08)" }}>
    <div style={{ paddingRight: 10 }}>
      <span style={{ fontSize: 12, color: "#3c4f6d", fontWeight: 500 }}>{label}</span>
      {sub && <div style={{ fontSize: 10, color: "#74839d", marginTop: 2, lineHeight: 1.4 }}>{sub}</div>}
    </div>
    {value != null && <span style={{ fontSize: 11, fontFamily: mono ? "'JetBrains Mono', monospace" : undefined, color: color || "#2062c8", fontWeight: 600, textAlign: "right", maxWidth: "52%", lineHeight: 1.4, whiteSpace: "nowrap" }}>{value}</span>}
  </div>
);

const Note = ({ children, color = "#74839d" }) => (
  <div style={{ marginTop: 8, fontSize: 11, color, lineHeight: 1.55 }}>{children}</div>
);

const Formula = ({ children }) => (
  <div className="hscroll" style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: "#65a30d", background: "rgba(222,226,241,0.7)", border: "1px solid rgba(32,98,200,0.16)", borderRadius: 6, padding: "8px 10px", margin: "6px 0", whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{children}</div>
);

const Tag = ({ label, color = "#2062c8" }) => (
  <span style={{ fontSize: 10, fontWeight: 600, background: `${color}18`, border: `1px solid ${color}33`, borderRadius: 4, padding: "2px 7px", color, marginRight: 5, marginBottom: 5, display: "inline-block" }}>{label}</span>
);

const Sources = ({ items }) => (
  <Section title="Data Sources" accent="#0a8564">
    {items.map((it, i) => <Row key={i} label={it.label} value={it.value} sub={it.sub} color="#0a8564" />)}
  </Section>
);

const Grid = ({ children }) => (
  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>{children}</div>
);

export default function ModelBreakdown() {
  const [activeModel, setActiveModel] = useState("hits");

  const tabs = [
    { key: "hits",    label: "Hits",        emoji: "🎯", color: "#2062c8" },
    { key: "hrr",     label: "H+R+RBI",     emoji: "🔥", color: "#c2570f" },
    { key: "hr",      label: "HR",          emoji: "💣", color: "#d02a4b" },
    { key: "tb",      label: "TB",          emoji: "📊", color: "#6d38d8" },
    { key: "sb",      label: "SB",          emoji: "🏃", color: "#0a8564" },
    { key: "rbi",     label: "RBI",         emoji: "🏅", color: "#a16207" },
    { key: "ks",      label: "Pitcher Ks",  emoji: "⚾", color: "#0891b2" },
    { key: "scoring", label: "Scoring & EV", emoji: "🧮", color: "#6d4fd0" },
  ];

  return (
    <div style={{ padding: "20px", maxWidth: 1100, margin: "0 auto" }}>
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 20, fontWeight: 700, color: "#16233c", marginBottom: 4 }}>🧠 Model Breakdown</div>
        <div style={{ fontSize: 12, color: "#74839d" }}>Per-model reference — inputs, multiplier chains, calibration, thresholds, and data sources for each projection model.</div>
      </div>

      {/* Sub-nav */}
      <div style={{ display: "flex", gap: 6, marginBottom: 20, flexWrap: "wrap" }}>
        {tabs.map(t => (
          <button key={t.key} onClick={() => setActiveModel(t.key)} style={{
            padding: "6px 13px", fontSize: 11, fontWeight: 600, borderRadius: 6, cursor: "pointer",
            display: "flex", alignItems: "center", gap: 5,
            background: activeModel === t.key ? `${t.color}22` : "rgba(22,44,80,0.04)",
            border: `1px solid ${activeModel === t.key ? `${t.color}66` : "rgba(22,44,80,0.08)"}`,
            color: activeModel === t.key ? t.color : "#74839d",
          }}><span>{t.emoji}</span>{t.label}</button>
        ))}
      </div>

      {/* ─────────────── HITS ─────────────── */}
      {activeModel === "hits" && (
        <Grid>
          <div>
            <Section title="Projection Base (per-AB hit rate)">
              <Row label="Season BA / OBP / SLG" value="40%" sub="Full-season rate stats — most stable anchor" />
              <Row label="L5 game log" value="30%" sub="Recent form — hot/cold streaks, approach shifts" />
              <Row label="L10 game log" value="15%" sub="Medium-term trend, smooths single-game noise" />
              <Row label="Handedness split vL/vR" value="15%" sub="Season BA/OBP vs actual pitcher hand" color="#6d4fd0" />
              <Row label="BvP weighting" value="≥50 AB sample" sub="Career batter-vs-pitcher blended toward baseline below 50 AB" />
              <Note>Projection weight decays with games played (preseason proj fades as the season's own sample grows).</Note>
            </Section>
            <Section title="Multiplier Chain (applied to base rate)">
              <Row label="Pitcher quality (M3)" value="ERA·WHIP·xFIP blend" sub="Higher ERA/WHIP = batter-friendly" />
              <Row label="Arsenal matchup (M_am)" value="0.85–1.18" sub="Batter xwOBA vs each pitch type × usage share, vs 0.315 lg avg" color="#0a8564" />
              <Row label="Plate discipline (M_disc)" value="0.88–1.12" sub="IZ-Contact 45% · Whiff 35% · O-Swing 20%" />
              <Row label="DB pitcher quality" value="composite" sub="pitDbQualityAdj — cross-market alpha signal" color="#65a30d" />
              <Row label="K vulnerability" value="suppresses contact" sub="Batter K% vs pitcher's specific pitch mix" />
              <Row label="Contact ceiling / xBA regr / wRC+" value="luck + quality" sub="Hard-hit ceiling, BA−xBA regression, wRC+ context" />
              <Row label="Game environment" value="0.95–1.06" sub="O/U total vs 8.8 lg avg → ±3% (H model)" />
              <Row label="Batting-order PA" value="leadoff +16% PA" sub="Effective AB count scaled by slot (1→4.65, 9→3.70 PA)" color="#a16207" />
            </Section>
          </div>
          <div>
            <Section title="Line Selection & Probability" accent="#a16207">
              <Row label="Line ladder" value="O0.5 / 1.5 / 2.5 / 3.5" sub="findBestLine returns highest line with prob in 50–70%" />
              <Row label="O0.5 probability" value="logistic calibration" sub="hitsCalibratedProb05 — raw Poisson overstated O0.5 by ~11pp" color="#0a8564" />
              <Row label="O1.5+ probability" value="Poisson, shrunk rate" sub="score × HITS_HILINE_SHRINK × 4.0 PA → P(≥k)" />
            </Section>
            <Section title="Pick Thresholds (score space)" accent="#d02a4b">
              <Row label="Over 0.5" value="score > 0.245" sub="Effective score (after PA mult)" />
              <Row label="Over 1.5" value="> 0.290 + L-rate > 0.80" sub="And recent avg > 0.290" />
              <Row label="Over 2.5" value="> 0.330 + recent avg > 0.340" sub="And recent hit rate > 0.85" />
              <Note color="#5d6f8b">Gates live in <strong>score space</strong>, never probability space — prob-space gates silently tighten when a calibration retunes.</Note>
            </Section>
            <Sources items={[
              { label: "MLB Stats API", value: "season + gameLog + splits", sub: "BA/OBP/SLG, L5/L10, vL/vR, BvP" },
              { label: "Savant pitch-arsenal CSV", value: "xwOBA / pitch type", sub: "Arsenal matchup + K vulnerability" },
              { label: "Savant discipline CSV", value: "whiff / contact / chase", sub: "Plate-discipline multiplier" },
              { label: "The Odds API", value: "batter_hits (+alt)", sub: "Live lines + EV" },
            ]} />
          </div>
        </Grid>
      )}

      {/* ─────────────── H+R+RBI ─────────────── */}
      {activeModel === "hrr" && (
        <Grid>
          <div>
            <Section title="What HRR measures" accent="#c2570f">
              <Note color="#5d6f8b">Hits + Runs + RBIs combined. A hit can feed all three at once (correlated), and any HR is automatically 3+ HRR (1H + 1R + 1RBI). <strong>OPS is the strongest single predictor (r ≈ 0.65)</strong>, so the base rate is OPS-anchored rather than pure hit rate.</Note>
            </Section>
            <Section title="Base Rate + Multiplier Chain">
              <Row label="Base" value="OPS-anchored λ" sub="Season + recent OPS, on-base + slugging contributions" />
              <Row label="Pitcher quality" value="M3 blend" sub="ERA/WHIP/xFIP — run + baserunner environment" />
              <Row label="Arsenal matchup" value="0.85–1.18" sub="xwOBA vs pitch mix" color="#0a8564" />
              <Row label="Power / contact ceiling" value="barrel · hard-hit" sub="Drives the run + RBI legs via XBH/HR" />
              <Row label="DB pitcher quality" value="composite" sub="pitDbQualityAdj" color="#65a30d" />
              <Row label="K vulnerability" value="suppresses all 3 legs" sub="A strikeout produces 0 HRR" />
              <Row label="Game environment" value="0.93–1.08" sub="O/U total × 0.38 (HRR)" />
              <Row label="Batting-order PA" value="slot-scaled" sub="More PA = more HRR chances" color="#a16207" />
            </Section>
          </div>
          <div>
            <Section title="Line Selection & Probability" accent="#a16207">
              <Row label="Line ladder" value="O1.5 → 5.5" sub="Books never post O0.5; ladder starts at 1.5" />
              <Row label="Probability" value="Poisson, λ-shrink" sub="score × HRR_CALIBRATION → P(≥k); displayed probs stay calibration-honest" color="#0a8564" />
              <Row label="Main-line switch" value="score ≥ 2.10 → O2.5 main" sub="Elite hitters (Judge/Ohtani tier); else O1.5 is main" color="#6d4fd0" />
            </Section>
            <Section title="Pick Thresholds (score space)" accent="#d02a4b">
              <Row label="Over 1.5 (non-elite)" value="score > 1.90" sub="And recent HRR ≥1.5 freq ≥ 0.38" />
              <Row label="Over 2.5 (elite)" value="score > 2.70" sub="And recent HRR ≥2.5 freq > 0.30" />
              <Note color="#5d6f8b">2026-06-11: old p15 ≥ 0.643 prob-gate had silently tightened to score ≥ 3.12 under the λ-shrink calibration and zeroed out HRR picks. Gates were moved to score space (raw-era λ equivalents).</Note>
            </Section>
            <Sources items={[
              { label: "MLB Stats API", value: "OPS, R, RBI, gameLog", sub: "Base rate + recent HRR frequency" },
              { label: "Savant power CSV", value: "barrel% / hard-hit%", sub: "Run + RBI leg ceiling" },
              { label: "Opposing bullpen", value: "full-pen HR/9", sub: "FDR-significant HRR signal (q≈0.004, +22pp)" },
              { label: "The Odds API", value: "batter_hits_runs_rbis (+alt)", sub: "Live lines + EV" },
            ]} />
          </div>
        </Grid>
      )}

      {/* ─────────────── HR ─────────────── */}
      {activeModel === "hr" && (
        <Grid>
          <div>
            <Section title="Base Rate (HR per AB)" accent="#d02a4b">
              <Row label="Season + recent HR/AB" value="power-weighted" sub="BvP HR factor blended in above 50 AB" />
              <Row label="Effective AB/game" value="3.5" sub="Below 4.0 PA — many ABs end in K/BB with no HR chance" />
              <Row label="Projection cap" value="projRelCap" sub="Score capped relative to projected power ceiling" />
            </Section>
            <Section title="Multiplier Chain">
              <Row label="Combined power mult" value="barrel · ISO · FB-rate" sub="Core power ceiling" color="#0a8564" />
              <Row label="Arsenal hard-hit power" value="vs pitch mix" sub="Hard-hit allowed by pitch type" color="#0a8564" />
              <Row label="FB-velo allowance" value="pitcher HR/FB" sub="Fastball velo + HR/FB allowed" />
              <Row label="Pull × park" value="0.94–1.08" sub="Pull% × pull-side wall distance (RHB→LF, LHB→RF), ref 330ft" color="#a16207" />
              <Row label="K suppression" value="0.85 + 0.15·kSupp" sub="High-K matchup caps HR upside" />
              <Row label="Dry-spell" value="0.95–1.05" sub="±1% per game vs 4-game reference; needs ≥5 recent games" />
              <Row label="Game environment" value="0.92–1.10" sub="O/U total × 0.50 (HR — most total-sensitive)" />
            </Section>
          </div>
          <div>
            <Section title="Line Selection & Probability" accent="#a16207">
              <Row label="Line" value="O0.5 only" sub="2+ HR ≈ pHR × 0.10 (extremely rare), never selected" />
              <Formula>pHR = 1 − (1 − min(score×0.750, 0.10))^3.5</Formula>
              <Note>×0.750 = HR_CAL_SHRINK (N=99 new-era picks): raw path predicted 26.3% vs 20.2% actual. Level fix only — rank-order within picks is still inverted (T1 33% &gt; T3 12%), a selection problem not a curve problem.</Note>
            </Section>
            <Section title="Pick Thresholds (score space)" accent="#d02a4b">
              <Row label="Yes (HR pick)" value="score > 0.068" sub="≈22% Poisson P(HR); needs +354 to break even. AND recent HR/AB > 0.050" />
              <Row label="Strong" value="score > 0.082" sub="AND split SLG > 0.490 AND recent HR/AB > 0.058" color="#0a8564" />
            </Section>
            <Sources items={[
              { label: "Savant power CSV", value: "barrel / ISO / HR/FB / FB%", sub: "Core power ceiling" },
              { label: "Savant batted-ball", value: "exit velo / launch angle", sub: "Squared-up / blast atoms" },
              { label: "Park data + weather", value: "HR park factor × wind", sub: "Pull-park multiplier" },
              { label: "The Odds API", value: "batter_home_runs (+alt)", sub: "Live lines + EV" },
            ]} />
          </div>
        </Grid>
      )}

      {/* ─────────────── TB ─────────────── */}
      {activeModel === "tb" && (
        <Grid>
          <div>
            <Section title="Base Rate (total bases / game)" accent="#6d38d8">
              <Row label="Season + recent TB/game" value="PA-weighted" sub="Slugging-anchored; BvP TB factor blended" />
              <Row label="Score cap" value="3.4" sub="Top bucket (≥3.6) empirically regressed — overconfidence cap" color="#d03131" />
            </Section>
            <Section title="Multiplier Chain">
              <Row label="Pitcher quality" value="M3 blend" sub="ERA/WHIP/xFIP" />
              <Row label="Arsenal TB / hard-hit" value="vs pitch mix" sub="arsenalTBAdj + arsenalHHTBAdj" color="#0a8564" />
              <Row label="Power × arsenal synergy" value="+14pp (mined)" sub="powerMult × arsenalTBAdj interaction" color="#65a30d" />
              <Row label="DB pitcher quality" value="+24pp (#1 mined)" sub="pitDbQualityAdj — strongest TB feature" color="#65a30d" />
              <Row label="TB ceiling / ISO / wRC+" value="quality blend" sub="XBH ceiling signals" />
              <Row label="Pull × park (TB)" value="extra-base geometry" sub="pullParkTB" color="#a16207" />
              <Row label="Game environment" value="0.93–1.08" sub="O/U total × 0.40 (TB)" />
              <Row label="Batting-order PA" value="slot-scaled" sub="More PA = more TB" color="#a16207" />
            </Section>
          </div>
          <div>
            <Section title="Line Selection & Probability" accent="#a16207">
              <Row label="Line ladder" value="O0.5 → 4.5" sub="Two fitted curves: O1.5 (value) and O2.5 (stud)" />
              <Formula>{`P(cash) = sigmoid(b0 + b1·min(score, 3.4))
O1.5:  b0=-1.3942  b1=0.4229
O2.5:  b0=-2.2176  b1=0.4508`}</Formula>
              <Note>Logistic fit on N=2661 player-days (scripts/tb-calibrate.mjs) replaces raw Poisson so the EV column matches the line-selection calibration.</Note>
            </Section>
            <Section title="Pick Thresholds (score space)" accent="#d02a4b">
              <Row label="o25IsMain" value="stud switch" sub="Elite sluggers route to O2.5 as main line" color="#6d4fd0" />
              <Row label="Over 1.5 (value)" value="score > 2.55 + p15 ≥ 0.42" />
              <Row label="Over 2.5 (stud)" value="score > 3.20 + p25 ≥ 0.32" />
              <Note color="#5d6f8b">Empirical mining (N=2661): sprint_speed INVERTED for TB; parkMult + luckMult FLAT (r≈−0.05) → dampened in the blend.</Note>
            </Section>
            <Sources items={[
              { label: "Savant power CSV", value: "ISO / barrel / hard-hit", sub: "XBH ceiling" },
              { label: "Savant pitch-arsenal", value: "TB allowed / pitch type", sub: "Arsenal TB + synergy" },
              { label: "The Odds API", value: "batter_total_bases (+alt)", sub: "Live lines + EV" },
            ]} />
          </div>
        </Grid>
      )}

      {/* ─────────────── SB ─────────────── */}
      {activeModel === "sb" && (
        <Grid>
          <div>
            <Section title="Base Composite (steal rate / game)" accent="#0a8564">
              <Row label="Recent + season SB rate" value="opportunity-weighted" sub="Recent SB frequency primary; skip gate on non-runners" />
              <Row label="Score cap" value="0.55 SB/game" sub="Elite stealers project ~0.30/game; cap prevents stack blow-up" />
            </Section>
            <Section title="Multiplier Chain">
              <Row label="Sprint speed" value="primary signal" sub="ft/s — the only stat that separates SB hits in backtest" color="#0a8564" />
              <Row label="Catcher" value="0.80–1.20" sub="Pop time + exchange + arm speed of primary catcher" color="#0a8564" />
              <Row label="Baserunning" value="aggression" sub="Jump / secondary-lead baserunning value" />
              <Row label="Basestealing intent" value="attempt rate" sub="Green-light tendency from Savant running splits" />
              <Row label="Pitcher holding" value="hold runners" sub="Pickoff / time-to-plate of opposing pitcher" />
              <Row label="Opportunity" value="lineup / on-base" sub="Expected times on base ahead of steal chances" color="#a16207" />
            </Section>
          </div>
          <div>
            <Section title="Line Selection & Probability" accent="#a16207">
              <Row label="Line ladder" value="O0.5 / 1.5" sub="O0.5 is the live line for essentially all runners" />
              <Formula>P(≥1) = Poisson(score × 0.55)</Formula>
              <Note>SB_CALIBRATION = 0.55 (backtest n=173): raw composite implied 33–42% at the top band but realized P(≥1)≈18–22% across all bands — stacked multipliers over-state the true steal rate.</Note>
            </Section>
            <Section title="Pick Thresholds & Skips" accent="#d02a4b">
              <Row label="Over 0.5" value="score > 0.34" sub="AND recent SB freq > 0.22" />
              <Row label="Skip" value="proj SB ≤ 12 & season SB ≤ 5" sub="Non-runners excluded entirely" color="#74839d" />
              <Row label="Low confidence" value="no sprint + no steal data" sub="Flagged when both speed signals missing" color="#a16207" />
              <Note color="#5d6f8b">Model has no rank-order power and was ~2× overconfident pre-calibration; composite reweighted, sprint speed is the dominant separator.</Note>
            </Section>
            <Sources items={[
              { label: "Savant sprint speed", value: "ft/s leaderboard", sub: "Primary multiplier" },
              { label: "Savant catcher-throwing", value: "pop time / arm", sub: "Primary catcher by SBA" },
              { label: "Savant running splits", value: "basestealing intent", sub: "Green-light tendency" },
              { label: "Pitcher running game", value: "holds / pickoffs", sub: "Time-to-plate" },
              { label: "The Odds API", value: "batter_stolen_bases (+alt)", sub: "FanDuel + Hard Rock on the standard market; DraftKings posts SB only on batter_stolen_bases_alternate" },
            ]} />
          </div>
        </Grid>
      )}

      {/* ─────────────── RBI ─────────────── */}
      {activeModel === "rbi" && (
        <Grid>
          <div>
            <Section title="Base Rate (Poisson λ)" accent="#a16207">
              <Row label="L15 RBI/game" value="55%" sub="Recent form — primary driver" color="#2062c8" />
              <Row label="Season RBI/game" value="35%" sub="Stable anchor vs small-sample noise" />
              <Row label="Projection RBI/game" value="10%" sub="Preseason proj ÷ 155 GP — light context" color="#74839d" />
              <Note>Final λ range 0.05–2.5 after all multipliers below.</Note>
            </Section>
            <Section title="Clutch + Opportunity">
              <Row label="RISP OPS mult" value="0.68–1.35" sub="Batter RISP OPS vs 0.730 lg avg — primary clutch signal" color="#c2570f" />
              <Row label="RISP AVG delta" value="secondary" sub="+0.025 per .010 above season AVG; needs ≥15 PA" color="#a16207" />
              <Row label="Lineup opportunity" value="slot ROB/PA" sub="Slot 4 sees ~45% more runners than slot 1" color="#a16207" />
              <Row label="Predecessor OBP" value="confirmed lineup" sub="Runners-on-base from actual table-setters ahead" color="#6d4fd0" />
            </Section>
          </div>
          <div>
            <Section title="Contact + HR Contribution" accent="#0a8564">
              <Row label="xwOBA − wOBA delta" value="× 3.2 → 0.88–1.14" sub="Luck-adjustment: positive delta = due to regress up" color="#0a8564" />
              <Row label="Barrel% / Hard-Hit%" value="60% / 40% blend" sub="vs 7.5% / 39% lg avg → 0.86–1.20" color="#0a8564" />
              <Row label="Pitcher WHIP" value="0.78–1.28" sub="Baserunner environment vs 1.30 lg avg" color="#6d4fd0" />
              <Row label="HR direct contribution" value="hrImpliedProb × 0.60" sub="A homer always scores ≥1 RBI; ×0.60 avoids double-count" color="#d02a4b" />
            </Section>
            <Section title="Probability & Thresholds" accent="#d02a4b">
              <Row label="O0.5 probability" value="logistic (N=612)" sub="rbiCalibratedProb — replaced overconfident Poisson (was +26pp), maxes ~42%" color="#0a8564" />
              <Row label="Reference" value="P(≥1)=1−e^(−λ)" sub="Poisson CDF kept for the fair-line column" />
              <Row label="Over 0.5 / Lean" value="finalRate ≥ 1.0" sub="≈40% calibration tier" />
              <Row label="Strong" value="finalRate ≥ 1.2" sub="Genuinely-profitable elite tier" color="#0a8564" />
            </Section>
            <Sources items={[
              { label: "MLB Stats API", value: "RBI gameLog + sitCode=risp", sub: "Base rate + RISP clutch" },
              { label: "Savant power CSV", value: "xwOBA / barrel / hard-hit", sub: "Contact multiplier" },
              { label: "Lineups (Rotowire)", value: "confirmed order + predecessors", sub: "Opportunity + predecessor OBP" },
              { label: "The Odds API", value: "batter_rbis (+alt)", sub: "Live lines + EV" },
            ]} />
          </div>
        </Grid>
      )}

      {/* ─────────────── PITCHER Ks ─────────────── */}
      {activeModel === "ks" && (
        <Grid>
          <div>
            <Section title="xK Projection Base" accent="#0891b2">
              <Formula>xK = (blendedK9 / 9) × projIP × M1·M2·M3·M4·M5·M6·M7·M8·M_VELO·M_UMP·M_REST</Formula>
              <Row label="Career K/9" value="40%" sub="kEdge blend" />
              <Row label="Bayes-regressed season K/9" value="35%" sub="Shrunk to prior on small samples" color="#6d4fd0" />
              <Row label="Prior K/9" value="25%" sub="Projection / league prior" />
              <Row label="Role-change guard" value="starts-only filter" sub="Reliever→starter: filter gameLog to IP≥3 so relief K9 doesn't inflate" color="#a16207" />
            </Section>
            <Section title="Projected IP">
              <Row label="IP/start baseline" value="career-adjusted" sub="Accounts for modern bullpen usage" />
              <Row label="BB% penalty" value="floor 0.88" sub="−1.4× per % above 9% BB — walks exhaust pitch counts" color="#d03131" />
              <Row label="Final projIP" value="clamp 3.0–7.0" />
            </Section>
          </div>
          <div>
            <Section title="Multiplier Chain (M1–M_REST)">
              <Row label="M1 Arsenal stuff" value="0.85–1.22" sub="SwStr% / whiff / put-away / extension" color="#0a8564" />
              <Row label="M2 Count dynamics" value="0.90–1.12" sub="F-Strike 28% · Chase 44% · IZ-Contact 28%(inv)" />
              <Row label="M3 Opponent K%" value="0.82–1.28" sub="Team K% 40% + lineup whiff/chase profile 60%" color="#0a8564" />
              <Row label="M4 Park + home/away" value="0.92–1.08" sub="Park K factor × H/A K9 split" />
              <Row label="M5 Arsenal K-rate" value="0.88–1.15" sub="Pitcher K% per pitch type × usage" color="#0a8564" />
              <Row label="M6 Breaking-ball spin" value="0.95–1.08" sub="Avg breaking spin vs lg avg" />
              <Row label="M7 Lineup K-vuln" value="0.88–1.18" sub="Lineup whiff vs THIS pitcher's mix" color="#0a8564" />
              <Row label="M8 DB pitcher quality" value="0.90–1.18" sub="Composite, sample-weighted" color="#65a30d" />
              <Row label="M_UMP" value="0.88–1.15" sub="Home-plate umpire K tendency" />
              <Row label="M_REST" value="0.87–1.03" sub="Days rest: ≤2→0.87, 4–5→1.00, 6–7→1.03" />
            </Section>
            <Section title="Line, Probability & Confidence" accent="#a16207">
              <Row label="Line ladder" value="O4.5 → 10.5" sub="findBestLine targets 50–70% prob" />
              <Formula>{`P(over) = Φ((xK − line) / σ)
σ = max(1.5, √xK × 1.25)`}</Formula>
              <Row label="Confidence" value="1.0–9.5" sub="4.0 + consistency×3.0 + data/signal bonuses − volatility/rest/role penalties" color="#6d4fd0" />
            </Section>
            <Sources items={[
              { label: "Savant pitch-arsenal", value: "whiff / put-away / K% / spin", sub: "M1, M5, M6" },
              { label: "MLB Stats API", value: "K9, IP, BB%, splits, gameLog", sub: "Base + projIP + rest" },
              { label: "Lineup K-profile", value: "opponent whiff vs mix", sub: "M3, M7" },
              { label: "Umpire data", value: "HP ump K tendency", sub: "M_UMP" },
              { label: "The Odds API", value: "pitcher_strikeouts (+alt)", sub: "Live lines + EV" },
            ]} />
          </div>
        </Grid>
      )}

      {/* ─────────────── SCORING & EV (shared) ─────────────── */}
      {activeModel === "scoring" && (
        <Grid>
          <div>
            <Section title="Confidence Score (1.0–10.0)" accent="#6d4fd0">
              <Row label="Base (4.0–9.5)" value="threshold → ceiling" sub="How far above the bet threshold the projection sits" />
              <Row label="Park boost" value="+0.0 to +0.5" sub="Favorable park factor for this prop type" />
              <Row label="Recent form" value="+0.0 to +0.4" sub="L5 above season average" />
              <Row label="Handedness split" value="+0.0 to +0.3" sub="Significant split edge vs pitcher hand" color="#6d4fd0" />
              <Row label="Arsenal matchup" value="+0.0 to +0.3" sub="When coverage ≥ 60%" color="#0a8564" />
              <Row label="Plate discipline" value="+0.0 to +0.2" sub="Strong discipline signal" />
            </Section>
            <Section title="Best-Line Selection" accent="#a16207">
              <Note color="#5d6f8b">The model walks each prop's line ladder from highest to lowest and returns the highest line where model probability lands in <strong style={{ color: "#3c4f6d" }}>50–70%</strong> — actionable bets, not locks or longshots.</Note>
              <Row label="Target range" value="50–70% implied" sub="≈ −110 to −233 fair line" />
              <Row label="Filtered out" value="fair line worse than −300" sub="Books price it appropriately, no edge" color="#d03131" />
            </Section>
          </div>
          <div>
            <Section title="EV Calculation" accent="#8b2fc9">
              <Formula>{`payout = odds>0 ? odds/100 : 100/|odds|
EV = prob × payout − (1 − prob)`}</Formula>
              <Row label="EV badge" value="> +3%" color="#a16207" />
              <Row label="Edge (no live odds)" value="prob − 0.524" sub="vs −110 breakeven (52.4%)" />
            </Section>
            <Section title="Which Props Count">
              <div style={{ marginBottom: 8 }}>
                <Tag label="Hits O0.5 / O1.5" color="#2062c8" /><Tag label="H+R+RBI (dyn)" color="#c2570f" />
                <Tag label="HR O0.5" color="#d02a4b" /><Tag label="TB (dyn)" color="#6d38d8" />
                <Tag label="SB O0.5" color="#0a8564" /><Tag label="RBI O0.5" color="#a16207" />
                <Tag label="Ks O4.5–10.5" color="#0891b2" />
              </div>
              <Note>Singles / doubles / triples are excluded — too rare, too model-noisy, poor book juice. Performance = picks above confidence threshold vs box-score outcome, tagged by modelVersions.js.</Note>
            </Section>
            <Section title="Cross-Market Calibration Notes" accent="#0a8564">
              <Row label="Gates" value="score space only" sub="Never probability space — calibrations retune, prob-gates silently tighten" color="#d03131" />
              <Row label="Count markets" value="overpredict" sub="RBI / HRR / Hits ran hot pre-calibration; HR was already calibrated" />
              <Row label="pitDbQualityAdj" value="cross-market alpha" sub="#1 TB feature (+24pp), strong in hits/HRR too" color="#65a30d" />
            </Section>
          </div>
        </Grid>
      )}
    </div>
  );
}
