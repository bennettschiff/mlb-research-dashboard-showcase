// Cumulative units over the window, both stake tracks, as inline SVG.
// The project has no chart library and shouldn't grow one for two line charts.
//
// The overhaul markers are the reason this chart exists rather than a table: a
// model change that worked shows up as a slope change at its own vertical line,
// which is a claim you can check by eye instead of taking on faith from a
// before/after row.
import { useState } from "react";
import { C, MONO, pnlColor } from "./primitives.jsx";
import { OVERHAULS, fmtUnits } from "../../lib/results.js";

const PAD = { top: 14, right: 16, bottom: 22, left: 46 };

// `mainLabel` names the solid series. It defaults to the weighted track because
// that is what every caller on this page plots; the Golden boards plot flat 1u —
// a board suggests picks, not stakes — and would otherwise be mislabelled.
export default function EquityCurve({
  series, height = 220, showFlat = true, markers = true,
  mainLabel = "Weighted (model-suggested units)", mainKey = "weighted",
}) {
  const [hover, setHover] = useState(null);

  if (!series || series.length < 2) {
    return (
      <div style={{ height, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: C.muted }}>
        Not enough graded days in this window to plot a curve.
      </div>
    );
  }

  const W = 1000; // viewBox units; the SVG scales to its container
  const H = height;
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;

  const vals = series.flatMap(p => (showFlat ? [p.weighted, p.flat] : [p.weighted])).concat([0]);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const padY = span * 0.08;
  const lo = min - padY, hi = max + padY;

  const x = (i) => PAD.left + (series.length === 1 ? innerW / 2 : (i / (series.length - 1)) * innerW);
  const y = (v) => PAD.top + innerH - ((v - lo) / (hi - lo)) * innerH;

  const path = (key) => series.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join(" ");
  const area = `${path("weighted")} L${x(series.length - 1).toFixed(1)},${y(0).toFixed(1)} L${x(0).toFixed(1)},${y(0).toFixed(1)} Z`;

  const finalW = series[series.length - 1].weighted;
  const tint = finalW >= 0 ? "rgba(15,138,68,0.10)" : "rgba(208,49,49,0.10)";

  // Overhaul verticals, positioned at the first day on/after the cutoff.
  const marks = markers
    ? OVERHAULS.map(oh => {
        const i = series.findIndex(p => p.date >= oh.date);
        return i === -1 ? null : { ...oh, i };
      }).filter(Boolean)
      // Several overhauls landed on the same date — collapse to one line each.
      .filter((m, i, arr) => arr.findIndex(o => o.i === m.i) === i)
    : [];

  // Y gridlines at 0 plus the two extremes — but drop any extreme that would
  // render within a label-height of the zero line, which is what happens when a
  // curve peaks just above 0 and bottoms out far below it.
  const ticks = [0, Math.round(min), Math.round(max)]
    .filter((t, i, arr) => t >= lo && t <= hi && arr.indexOf(t) === i)
    .filter((t, i, arr) => i === 0 || arr.slice(0, i).every(o => Math.abs(y(t) - y(o)) > 13));

  const onMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.round(((px - PAD.left) / innerW) * (series.length - 1));
    if (i >= 0 && i < series.length) setHover(i);
  };

  const h = hover != null ? series[hover] : null;

  return (
    <div style={{ position: "relative" }}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none"
        style={{ width: "100%", height, display: "block" }}
        onMouseMove={onMove} onMouseLeave={() => setHover(null)}>

        {ticks.map(t => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)}
              stroke={t === 0 ? "rgba(32,98,200,0.35)" : "rgba(32,98,200,0.10)"}
              strokeWidth={t === 0 ? 1.5 : 1} strokeDasharray={t === 0 ? "none" : "3 4"} />
            <text x={PAD.left - 7} y={y(t) + 3.5} textAnchor="end"
              fontSize={10} fill={C.muted} fontFamily={MONO}>{t > 0 ? `+${t}` : t}u</text>
          </g>
        ))}

        {marks.map(m => (
          <g key={m.key}>
            <line x1={x(m.i)} x2={x(m.i)} y1={PAD.top} y2={PAD.top + innerH}
              stroke="rgba(161,98,7,0.45)" strokeWidth={1} strokeDasharray="2 3" />
            <circle cx={x(m.i)} cy={PAD.top + 4} r={3} fill="rgba(161,98,7,0.8)">
              <title>{`${m.label} — ${m.date}\n${m.summary}`}</title>
            </circle>
          </g>
        ))}

        <path d={area} fill={tint} stroke="none" />
        {showFlat && (
          <path d={path("flat")} fill="none" stroke={C.muted} strokeWidth={1.5}
            strokeDasharray="5 4" strokeLinejoin="round" />
        )}
        <path d={path("weighted")} fill="none" stroke={C.blue} strokeWidth={2.2} strokeLinejoin="round" />

        {h && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + innerH} stroke="rgba(32,98,200,0.3)" strokeWidth={1} />
            <circle cx={x(hover)} cy={y(h.weighted)} r={3.5} fill={C.blue} />
            {showFlat && <circle cx={x(hover)} cy={y(h.flat)} r={3} fill={C.muted} />}
          </g>
        )}

        <text x={PAD.left} y={H - 6} fontSize={10} fill={C.muted} fontFamily={MONO}>{series[0].date}</text>
        <text x={W - PAD.right} y={H - 6} textAnchor="end" fontSize={10} fill={C.muted} fontFamily={MONO}>
          {series[series.length - 1].date}
        </text>
      </svg>

      {h && (
        <div style={{
          position: "absolute", top: 6, left: "50%", transform: "translateX(-50%)",
          background: "rgba(255,255,255,0.96)", border: `1px solid ${C.rule}`, borderRadius: 7,
          padding: "6px 12px", fontSize: 11, color: C.body, display: "flex", gap: 14,
          fontFamily: MONO, pointerEvents: "none", whiteSpace: "nowrap",
          boxShadow: "0 2px 8px rgba(22,35,60,0.10)",
        }}>
          <span style={{ color: C.ink, fontWeight: 700 }}>{h.date}</span>
          <span>{mainKey} <b style={{ color: pnlColor(h.weighted) }}>{fmtUnits(h.weighted)}</b></span>
          {showFlat && <span>flat <b style={{ color: pnlColor(h.flat) }}>{fmtUnits(h.flat)}</b></span>}
          <span style={{ color: C.muted }}>day <b style={{ color: pnlColor(h.dayWeighted) }}>{fmtUnits(h.dayWeighted)}</b></span>
        </div>
      )}

      <div style={{ display: "flex", gap: 16, marginTop: 6, fontSize: 10, color: C.muted, flexWrap: "wrap" }}>
        <span><span style={{ display: "inline-block", width: 16, height: 2, background: C.blue, verticalAlign: "middle", marginRight: 5 }} />{mainLabel}</span>
        {showFlat && <span><span style={{ display: "inline-block", width: 16, borderTop: `2px dashed ${C.muted}`, verticalAlign: "middle", marginRight: 5 }} />Flat 1u</span>}
        {marks.length > 0 && <span><span style={{ color: "rgba(161,98,7,0.9)" }}>●</span> model overhaul (hover for detail)</span>}
      </div>
    </div>
  );
}
