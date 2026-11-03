// Month calendar with each day tinted by that day's realized units.
//
// This replaces the old Yesterday / Last-7-Days cards. Those answered "how did
// the last day go" and nothing else; a calendar answers that plus the question
// the cards couldn't — is a bad stretch a bad day or a bad fortnight. Clicking a
// day sets the whole page's window to that day.
import { useMemo, useState } from "react";
import { C, MONO, pnlColor } from "./primitives.jsx";
import { monthGrid, fmtUnits, shiftDays } from "../../lib/results.js";

const DOW = ["S", "M", "T", "W", "T", "F", "S"];
const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];

// Tint strength is relative to the biggest day in the month, so a quiet month
// still shows shape instead of washing out against a blowout day elsewhere.
function cellBg(units, scale) {
  if (units == null) return "transparent";
  const a = Math.min(1, Math.abs(units) / (scale || 1));
  const strength = 0.10 + a * 0.55;
  return units >= 0 ? `rgba(15,138,68,${strength.toFixed(3)})` : `rgba(208,49,49,${strength.toFixed(3)})`;
}

export default function CalendarHeatmap({ daily, track = "weighted", selectedDate, onSelectDay, todayStr }) {
  const byDate = useMemo(() => new Map(daily.map(d => [d.date, d])), [daily]);

  // Land on the month of the most recent graded day, not the calendar's today —
  // in the offseason or after a quiet stretch that would open on an empty grid.
  const latest = daily.length ? daily[daily.length - 1].date : todayStr;
  const [cursor, setCursor] = useState(() => ({ y: Number(latest.slice(0, 4)), m: Number(latest.slice(5, 7)) }));

  const weeks = monthGrid(cursor.y, cursor.m);

  const monthDays = weeks.flat().filter(Boolean).map(d => byDate.get(d)).filter(Boolean);
  const scale = Math.max(1, ...monthDays.map(d => Math.abs(d[track].units)));
  const monthTotal = monthDays.reduce((a, d) => a + d[track].units, 0);
  const monthW = monthDays.reduce((a, d) => a + d[track].w, 0);
  const monthL = monthDays.reduce((a, d) => a + d[track].l, 0);

  const step = (n) => setCursor(c => {
    const m = c.m + n;
    if (m < 1) return { y: c.y - 1, m: 12 };
    if (m > 12) return { y: c.y + 1, m: 1 };
    return { y: c.y, m };
  });

  const navBtn = (label, onClick, disabled) => (
    <button onClick={onClick} disabled={disabled} style={{
      padding: "2px 9px", fontSize: 12, borderRadius: 6, cursor: disabled ? "default" : "pointer",
      background: "transparent", border: `1px solid ${C.rule}`, color: disabled ? C.faint : C.blue,
    }}>{label}</button>
  );

  const earliest = daily.length ? daily[0].date : todayStr;
  const atStart = cursor.y < Number(earliest.slice(0, 4)) || (cursor.y === Number(earliest.slice(0, 4)) && cursor.m <= Number(earliest.slice(5, 7)));
  const atEnd = cursor.y > Number(latest.slice(0, 4)) || (cursor.y === Number(latest.slice(0, 4)) && cursor.m >= Number(latest.slice(5, 7)));

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, gap: 10, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {navBtn("‹", () => step(-1), atStart)}
          <span style={{ fontSize: 13, fontWeight: 700, color: C.ink, minWidth: 120, textAlign: "center" }}>
            {MONTH_NAMES[cursor.m - 1]} {cursor.y}
          </span>
          {navBtn("›", () => step(1), atEnd)}
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "baseline", fontFamily: MONO }}>
          <span style={{ fontSize: 11, color: C.muted }}>{monthW}-{monthL}</span>
          <span style={{ fontSize: 15, fontWeight: 700, color: pnlColor(monthTotal) }}>{fmtUnits(monthTotal)}</span>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4 }}>
        {DOW.map((d, i) => (
          <div key={i} style={{ fontSize: 9, color: C.muted, textAlign: "center", fontWeight: 700, paddingBottom: 2 }}>{d}</div>
        ))}
        {weeks.flat().map((date, i) => {
          if (!date) return <div key={i} />;
          const d = byDate.get(date);
          const units = d ? d[track].units : null;
          const isToday = date === todayStr;
          const isSelected = date === selectedDate;
          const future = date > todayStr;
          return (
            <button
              key={date}
              onClick={() => d && onSelectDay?.(date)}
              disabled={!d}
              title={d ? `${date} · ${d[track].w}-${d[track].l}${d[track].pu ? `-${d[track].pu}` : ""} · ${fmtUnits(units)}` : `${date} · no graded picks`}
              style={{
                aspectRatio: "1 / 1", minHeight: 42, borderRadius: 7, padding: "4px 2px",
                background: future ? "transparent" : cellBg(units, scale),
                border: isSelected ? `2px solid ${C.blue}`
                  : isToday ? `1px solid rgba(32,98,200,0.55)`
                  : `1px solid ${d ? "rgba(32,98,200,0.14)" : "rgba(32,98,200,0.06)"}`,
                cursor: d ? "pointer" : "default",
                display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 1,
                opacity: future ? 0.35 : 1,
              }}>
              <span style={{ fontSize: 10, color: d ? C.ink : C.faint, fontWeight: d ? 700 : 400, fontFamily: MONO }}>
                {Number(date.slice(8, 10))}
              </span>
              {d && (
                <>
                  <span style={{ fontSize: 10, fontWeight: 700, color: pnlColor(units), fontFamily: MONO, lineHeight: 1 }}>
                    {units >= 0 ? "+" : "−"}{Math.abs(units).toFixed(1)}
                  </span>
                  <span style={{ fontSize: 8, color: C.muted, fontFamily: MONO, lineHeight: 1 }}>
                    {d[track].w}-{d[track].l}
                  </span>
                </>
              )}
            </button>
          );
        })}
      </div>

      <div style={{ marginTop: 10, display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 10, color: C.muted, flexWrap: "wrap", gap: 8 }}>
        <span>Click a day to filter the whole page to it.</span>
        <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
          −{scale.toFixed(1)}u
          {[-1, -0.6, -0.25, 0.25, 0.6, 1].map(f => (
            <span key={f} style={{ width: 14, height: 10, borderRadius: 2, background: cellBg(f * scale, scale), border: "1px solid rgba(32,98,200,0.1)" }} />
          ))}
          +{scale.toFixed(1)}u
        </span>
      </div>
    </div>
  );
}

// Compact "last N days" strip — used in the day drawer for context around the
// selected date without making the reader go back to the calendar.
export function MiniStrip({ daily, endDate, days = 14, track = "weighted" }) {
  const byDate = new Map(daily.map(d => [d.date, d]));
  const cells = Array.from({ length: days }, (_, i) => shiftDays(endDate, -(days - 1 - i)));
  const scale = Math.max(1, ...cells.map(d => Math.abs(byDate.get(d)?.[track].units ?? 0)));
  return (
    <div style={{ display: "flex", gap: 3, alignItems: "flex-end" }}>
      {cells.map(d => {
        const rec = byDate.get(d);
        const u = rec ? rec[track].units : null;
        return (
          <div key={d} title={rec ? `${d} · ${fmtUnits(u)}` : `${d} · no picks`} style={{
            flex: 1, height: 26, borderRadius: 3,
            background: cellBg(u, scale),
            border: d === endDate ? `1.5px solid ${C.blue}` : "1px solid rgba(32,98,200,0.1)",
          }} />
        );
      })}
    </div>
  );
}
