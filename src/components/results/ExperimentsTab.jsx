// Model changes and their evidence: what shipped, what it did, and what's still
// forward-validating on a shadow slate before it's allowed near a live gate.
import { useState } from "react";
import { C, MONO, Card, Rate, Units, Money, Roi, Chip, pnlColor } from "./primitives.jsx";
import { OVERHAULS, overhaulSplit } from "../../lib/results.js";
import PromotionPipeline from "../PromotionPipeline.jsx";
import SweepSurface from "../SweepSurface.jsx";
import BrainTrustResults from "../BrainTrustResults.jsx";

const VIEWS = [
  { key: "overhauls", label: "Shipped overhauls" },
  { key: "pipeline", label: "Promotion pipeline" },
  { key: "sweeps", label: "Sweep surface" },
  { key: "braintrust", label: "Brain Trust parlays" },
];

export default function ExperimentsTab({ baseScored, weightedStakeOf, perUnit }) {
  const [view, setView] = useState("overhauls");

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {VIEWS.map(v => (
          <Chip key={v.key} active={view === v.key} onClick={() => setView(v.key)}>{v.label}</Chip>
        ))}
      </div>

      {view === "overhauls" && <Overhauls baseScored={baseScored} weightedStakeOf={weightedStakeOf} perUnit={perUnit} />}
      {view === "pipeline" && <PromotionPipeline />}
      {view === "sweeps" && <SweepSurface />}
      {view === "braintrust" && <BrainTrustResults />}
    </div>
  );
}

function Overhauls({ baseScored, weightedStakeOf, perUnit }) {
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.6 }}>
        Each row splits the affected market(s) on the overhaul's cutoff date. These are observational
        before/after comparisons, not experiments — schedule, opponent quality and market conditions all
        move underneath them, so a verdict needs both a decent sample and a plausible mechanism.
      </div>

      {OVERHAULS.map(oh => {
        const split = overhaulSplit(baseScored, oh.markets, oh.date, weightedStakeOf);
        const beforeN = split.before.flat.decided;
        const afterN = split.after.flat.decided;
        const insufficient = afterN < 10;
        const dWp = (split.after.flat.winPct != null && split.before.flat.winPct != null)
          ? split.after.flat.winPct - split.before.flat.winPct : null;
        const dRoi = (split.after.flat.roiPct != null && split.before.flat.roiPct != null)
          ? split.after.flat.roiPct - split.before.flat.roiPct : null;

        return (
          <Card key={oh.key} title={oh.label}
            right={<span style={{ fontSize: 10, color: C.muted }}>
              cutoff <b style={{ color: C.blue, fontFamily: MONO }}>{oh.date}</b> · {oh.markets.join(", ")}
            </span>}>
            <div style={{ fontSize: 11, color: C.sub, marginBottom: 12, lineHeight: 1.5 }}>{oh.summary}</div>

            {insufficient && (
              <div style={{
                fontSize: 11, color: C.amber, marginBottom: 10, background: "rgba(161,98,7,0.08)",
                border: "1px solid rgba(161,98,7,0.2)", borderRadius: 6, padding: "6px 10px",
              }}>
                Only {afterN} graded pick{afterN === 1 ? "" : "s"} since the cutoff — no verdict yet.
              </div>
            )}

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 12, alignItems: "stretch" }}>
              {[["Before", split.before, beforeN], ["After", split.after, afterN]].map(([label, s, n]) => (
                <div key={label} style={{ background: C.cardSolid, border: `1px solid ${C.rule}`, borderRadius: 8, padding: 12 }}>
                  <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>
                    {label} · {n} graded
                  </div>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 18, fontWeight: 700, color: C.blue, fontFamily: MONO }}>
                      {s.flat.w}-{s.flat.l}{s.flat.pu ? `-${s.flat.pu}` : ""}
                    </span>
                    <Rate r={s.flat} />
                    <Units v={s.weighted.units} />
                    <Roi r={s.flat} />
                  </div>
                  <div style={{ marginTop: 6 }}>
                    <Money units={s.weighted.units} perUnit={perUnit} size={11} bold={false} />
                  </div>
                </div>
              ))}

              <div style={{
                display: "grid", gap: 8, alignContent: "center", minWidth: 110,
                background: "rgba(32,98,200,0.05)", border: `1px solid ${C.rule}`, borderRadius: 8, padding: "12px 14px",
              }}>
                <Delta label="Win%" v={dWp} suppressed={insufficient} />
                <Delta label="ROI" v={dRoi} suppressed={insufficient} />
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

function Delta({ label, v, suppressed }) {
  return (
    <div>
      <div style={{ fontSize: 9, color: C.muted, textTransform: "uppercase", letterSpacing: 1 }}>{label} Δ</div>
      <div style={{ fontSize: 15, fontWeight: 700, fontFamily: MONO, color: suppressed || v == null ? C.faint : pnlColor(v) }}>
        {v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}pt`}
      </div>
    </div>
  );
}
