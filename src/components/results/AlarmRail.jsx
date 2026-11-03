// Derived alarms. Nothing here is hand-maintained — every item is recomputed
// from the graded picks each render, so a problem announces itself the day it
// starts instead of the week someone thinks to go looking.
//
// The stalled-market check is the one that earns its keep: a market that stops
// producing picks and a market that's healthy look identical on a results page
// that only renders what exists. That blind spot hid the HRR gate collapse for
// weeks and the lab-analyst outage for a fortnight.
//
// Presentation note: this used to render every item flat at equal weight. On a
// normal day that is twelve full-width cards — seven of them the same finding
// repeated per market — filling 786px, which is more page than the headline,
// the equity curve and the calendar combined. A rail that always looks like a
// twelve-alarm emergency is a rail you stop reading. So items are grouped by
// class, ranked by cost within the class, and everything past the worst few is
// one click away rather than gone.
import { useState } from "react";
import { C } from "./primitives.jsx";
import { ALARM_GROUPS } from "../../lib/results.js";

const LEVEL = {
  alarm: { icon: "▲", color: C.red,   bg: "rgba(208,49,49,0.07)",  border: "rgba(208,49,49,0.28)" },
  warn:  { icon: "▲", color: C.amber, bg: "rgba(161,98,7,0.07)",   border: "rgba(161,98,7,0.28)" },
  info:  { icon: "•", color: C.muted, bg: "rgba(116,131,157,0.06)", border: "rgba(116,131,157,0.22)" },
};

// How many items of a group stay open before the rest collapse. Two is enough to
// establish that a class has more than one instance without paying for all of them.
const SHOWN = 2;

export default function AlarmRail({ items, onSelectMarket }) {
  const [openGroups, setOpenGroups] = useState(() => new Set());

  if (!items.length) {
    return (
      <div style={{
        display: "flex", alignItems: "center", gap: 10, padding: "10px 14px",
        background: "rgba(15,138,68,0.06)", border: "1px solid rgba(15,138,68,0.22)", borderRadius: 9,
        fontSize: 12, color: C.green, fontWeight: 600,
      }}>
        ✓ Nothing flagged in this window — no market losing at a decisive sample, no negative CLV, no stalled gate.
      </div>
    );
  }

  // Preserve the lib's ordering (level, then cost) inside each group, and order
  // the groups themselves by the severity of their worst member.
  const groups = ALARM_GROUPS
    .map(g => ({ ...g, items: items.filter(a => a.group === g.key) }))
    .filter(g => g.items.length);
  // Anything the lib emits without a known group still has to render.
  const ungrouped = items.filter(a => !ALARM_GROUPS.some(g => g.key === a.group));
  if (ungrouped.length) groups.push({ key: "other", label: "Other", noun: "note", items: ungrouped });

  const toggle = (key) => setOpenGroups(s => {
    const next = new Set(s);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  });

  const total = items.length;
  const alarmCount = items.filter(a => a.level === "alarm").length;

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div style={{ fontSize: 11, color: C.muted }}>
        <b style={{ color: alarmCount ? C.red : C.body, fontWeight: 700 }}>{total}</b> flagged
        {alarmCount > 0 && <> · <b style={{ color: C.red }}>{alarmCount}</b> at alarm level</>}
        {" "}· grouped by kind, worst first
      </div>

      {groups.map(g => {
        const open = openGroups.has(g.key);
        const shown = open ? g.items : g.items.slice(0, SHOWN);
        const hidden = g.items.length - shown.length;
        const worst = g.items[0];
        const L = LEVEL[worst.level];

        return (
          <div key={g.key} style={{ display: "grid", gap: 6 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ color: L.color, fontSize: 10 }}>{L.icon}</span>
              <span style={{ fontSize: 10, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: 1 }}>
                {g.label}
              </span>
              <span style={{
                fontSize: 10, fontWeight: 700, color: L.color, background: L.bg,
                border: `1px solid ${L.border}`, borderRadius: 20, padding: "1px 7px",
              }}>
                {g.items.length}
              </span>
              <span style={{ flex: 1, height: 1, background: C.ruleSoft }} />
            </div>

            {shown.map(a => (
              <div key={a.key}
                onClick={() => a.market && onSelectMarket?.(a.market)}
                title={a.market ? `Open ${a.market} in the Markets tab` : undefined}
                style={{
                  display: "flex", gap: 11, alignItems: "flex-start", padding: "9px 14px",
                  background: LEVEL[a.level].bg, border: `1px solid ${LEVEL[a.level].border}`, borderRadius: 9,
                  cursor: a.market ? "pointer" : "default",
                }}>
                <span style={{ color: LEVEL[a.level].color, fontSize: 12, lineHeight: 1.5, flexShrink: 0 }}>
                  {LEVEL[a.level].icon}
                </span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: a.level === "info" ? C.body : LEVEL[a.level].color }}>{a.title}</div>
                  <div style={{ fontSize: 11, color: C.sub, marginTop: 2, lineHeight: 1.45 }}>{a.detail}</div>
                </div>
              </div>
            ))}

            {(hidden > 0 || open) && g.items.length > SHOWN && (
              <button onClick={() => toggle(g.key)} style={{
                justifySelf: "start", padding: "3px 10px", fontSize: 10, fontWeight: 600,
                borderRadius: 14, cursor: "pointer", background: "transparent",
                border: `1px dashed ${C.rule}`, color: C.muted,
              }}>
                {open ? "▴ Collapse" : `▾ ${hidden} more ${g.noun}${hidden === 1 ? "" : "s"}`}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
