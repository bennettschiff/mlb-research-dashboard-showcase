// What's running hot — ranked by recent P/L per unit staked against each
// market's OWN longer-run baseline, not by raw win%.
//
// Raw win% ranks Hits (heavy chalk, ~70% and priced for it) at the top forever
// and never moves, which answers a question nobody asked. Measuring each market
// against its own norm surfaces the thing that actually changed this fortnight.
import { C, MONO, Dots, pnlColor } from "./primitives.jsx";
import { fmtUnits } from "../../lib/results.js";

export default function HotColdRail({ rows, days = 14, onSelectMarket }) {
  if (!rows.length) {
    return <div style={{ fontSize: 11, color: C.muted, padding: "12px 2px" }}>
      No market has enough graded picks in the last {days} days to rank.
    </div>;
  }

  const max = Math.max(...rows.map(r => Math.abs(r.perPick)), 0.01);

  return (
    <div style={{ display: "grid", gap: 2 }}>
      {rows.map(r => {
        const w = (Math.abs(r.perPick) / max) * 50; // % of the half-width bar
        const pos = r.perPick >= 0;
        return (
          <div key={r.market}
            onClick={() => onSelectMarket?.(r.market)}
            title={`${r.market}: ${(r.perPick * 100).toFixed(1)}% per unit over the last ${days}d vs ${((r.perPick - r.delta) * 100).toFixed(1)}% since the revamp`}
            style={{
              display: "grid", gridTemplateColumns: "104px 1fr 92px", gap: 8, alignItems: "center",
              padding: "5px 4px", borderRadius: 6, cursor: onSelectMarket ? "pointer" : "default",
            }}>
            <span style={{ fontSize: 11, color: C.ink, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {r.market}
            </span>

            {/* Diverging bar from a center baseline — left is losing, right is winning. */}
            <div style={{ position: "relative", height: 14 }}>
              <div style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: 1, background: "rgba(32,98,200,0.25)" }} />
              <div style={{
                position: "absolute", top: 2, height: 10, borderRadius: 3,
                background: pos ? "rgba(15,138,68,0.55)" : "rgba(208,49,49,0.55)",
                left: pos ? "50%" : `${50 - w}%`, width: `${w}%`,
              }} />
            </div>

            <span style={{ display: "flex", gap: 7, alignItems: "center", justifyContent: "flex-end" }}>
              <Dots outcomes={r.dots} size={9} />
              <span style={{ fontSize: 11, fontWeight: 700, color: pnlColor(r.recent.units), fontFamily: MONO, minWidth: 42, textAlign: "right" }}>
                {fmtUnits(r.recent.units)}
              </span>
            </span>
          </div>
        );
      })}
      <div style={{ fontSize: 10, color: C.muted, marginTop: 6, lineHeight: 1.5 }}>
        Bar = return per unit staked over the last {days} days. Ranked against each market's own
        since-revamp baseline, so this shows what <i>changed</i> — not which market is priced cheapest.
      </div>
    </div>
  );
}
