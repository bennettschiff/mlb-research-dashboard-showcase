// One day, fully accounted for. Opens from a calendar cell.
//
// Absorbs what the legacy "Yesterday's Golden 10" table and the Recent Picks
// list each did partially: every pick that day, what it settled at, and what it
// paid — plus the surrounding fortnight so a red day reads as either an outlier
// or the fifth in a row.
import { C, MONO, Rate, Units, Money, Pill } from "./primitives.jsx";
import { rollupBoth, pickLabel, pickProfitUnits, fmtOdds, OUTCOME_COLORS } from "../../lib/results.js";
import { MiniStrip } from "./CalendarHeatmap.jsx";

export default function DayDrawer({ date, picks, daily, perUnit, weightedStakeOf, onClose, onPinWindow }) {
  if (!date) return null;
  const dayPicks = picks.filter(p => p.pick_date === date);
  const settled = dayPicks.filter(p => p.outcome && p.outcome !== "pending");
  const r = rollupBoth(settled, weightedStakeOf);
  const pending = dayPicks.length - settled.length;

  const sorted = [...dayPicks].sort((a, b) => {
    const rank = o => (o === "win" ? 0 : o === "loss" ? 1 : o === "push" ? 2 : 3);
    return rank(a.outcome) - rank(b.outcome) || pickLabel(a).localeCompare(pickLabel(b));
  });

  return (
    <>
      {/* Above the app's sticky header (z-index 100) — otherwise the drawer's
          own title and close button render underneath it and can't be reached. */}
      <div onClick={onClose} style={{
        position: "fixed", inset: 0, background: "rgba(22,35,60,0.28)", zIndex: 200,
      }} />
      <aside style={{
        position: "fixed", top: 0, right: 0, bottom: 0, width: "min(560px, 94vw)", zIndex: 201,
        background: "#eef2f9", borderLeft: `1px solid ${C.rule}`, boxShadow: "-8px 0 28px rgba(22,35,60,0.16)",
        display: "flex", flexDirection: "column",
      }}>
        <div style={{ padding: "16px 20px", borderBottom: `1px solid ${C.rule}`, background: "rgba(210,217,236,0.6)" }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
            <div>
              <div style={{ fontSize: 16, fontWeight: 700, color: C.ink, fontFamily: MONO }}>{date}</div>
              <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>
                {dayPicks.length} pick{dayPicks.length === 1 ? "" : "s"}
                {pending > 0 && <> · <span style={{ color: C.amber }}>{pending} pending</span></>}
              </div>
            </div>
            <button onClick={onClose} style={{
              background: "none", border: "none", color: C.muted, fontSize: 18, cursor: "pointer", lineHeight: 1,
            }}>✕</button>
          </div>

          <div style={{ display: "flex", gap: 20, marginTop: 14, alignItems: "baseline", flexWrap: "wrap" }}>
            <span style={{ fontSize: 20, fontWeight: 700, color: C.blue, fontFamily: MONO }}>
              {r.flat.w}-{r.flat.l}{r.flat.pu > 0 ? `-${r.flat.pu}` : ""}
            </span>
            <Rate r={r.flat} size={14} />
            <span><span style={{ fontSize: 10, color: C.muted, marginRight: 5 }}>⚖</span><Units v={r.weighted.units} size={15} /></span>
            <span><span style={{ fontSize: 10, color: C.muted, marginRight: 5 }}>1u</span><Units v={r.flat.units} size={13} bold={false} /></span>
            <Money units={r.weighted.units} perUnit={perUnit} size={14} />
          </div>

          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 9, color: C.muted, textTransform: "uppercase", letterSpacing: 1, marginBottom: 5 }}>Preceding 14 days</div>
            <MiniStrip daily={daily} endDate={date} days={14} />
          </div>

          <button onClick={() => onPinWindow?.(date)} style={{
            marginTop: 14, padding: "5px 12px", fontSize: 11, fontWeight: 600, borderRadius: 6,
            background: "rgba(32,98,200,0.14)", border: "1px solid rgba(32,98,200,0.3)", color: C.blue, cursor: "pointer",
          }}>Filter the whole page to this day</button>
        </div>

        <div style={{ overflowY: "auto", flex: 1, padding: "8px 0" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <tbody>
              {sorted.map(p => {
                const stake = weightedStakeOf(p);
                const paid = pickProfitUnits(p, stake);
                const oc = p.outcome || "pending";
                return (
                  <tr key={p.id ?? `${p.player_name}-${p.prop_type}-${p.line}`} style={{ borderBottom: `1px solid ${C.ruleSoft}` }}>
                    <td style={{ padding: "9px 8px 9px 20px", width: 6 }}>
                      <span style={{
                        display: "block", width: 4, height: 28, borderRadius: 2,
                        background: OUTCOME_COLORS[oc] || C.muted,
                      }} />
                    </td>
                    <td style={{ padding: "9px 8px" }}>
                      <div style={{ fontSize: 12, color: C.ink, fontWeight: 600 }}>{p.player_name}</div>
                      <div style={{ fontSize: 10, color: C.muted, marginTop: 1 }}>
                        {pickLabel(p)}
                        {p.line != null && p.prop_type !== "ml" && p.prop_type !== "rl" && p.prop_type !== "nrfi" &&
                          ` ${p.direction === "under" ? "U" : "O"}${p.line}`}
                        {p.team ? ` · ${p.team}` : ""}
                      </div>
                    </td>
                    <td style={{ padding: "9px 8px", textAlign: "right", fontFamily: MONO, fontSize: 11, color: C.sub }}>
                      {fmtOdds(p.best_odds)}
                      {p.best_book && <span style={{ fontSize: 9, color: C.faint, marginLeft: 3 }}>{p.best_book.toUpperCase().slice(0, 2)}</span>}
                    </td>
                    <td title={stake ? undefined : "Stake 0 — the edge controller had this market suspended on this date, so a win pays nothing on the weighted track."}
                      style={{ padding: "9px 8px", textAlign: "right", fontFamily: MONO, fontSize: 11, color: stake ? C.muted : C.faint }}>
                      {stake ? `${stake.toFixed(stake % 1 ? 1 : 0)}u` : "0u"}
                    </td>
                    <td style={{ padding: "9px 8px", textAlign: "right" }}>
                      {p.result != null && <span style={{ fontSize: 11, fontFamily: MONO, color: C.body, marginRight: 8 }}>{p.result}</span>}
                      <Pill color={OUTCOME_COLORS[oc] || C.muted}>{oc.toUpperCase()}</Pill>
                    </td>
                    <td style={{ padding: "9px 20px 9px 8px", textAlign: "right", minWidth: 62 }}>
                      {oc === "pending" ? <span style={{ color: C.faint, fontSize: 11 }}>—</span>
                        : stake === 0 ? <span title="Suspended market — no stake, no P/L" style={{ color: C.faint, fontSize: 11, fontFamily: MONO }}>—</span>
                        : <Units v={paid} size={11} />}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </aside>
    </>
  );
}
