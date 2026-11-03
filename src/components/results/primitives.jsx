// Shared visual vocabulary for the Results surface. Every panel is built from
// these so the five tabs read as one system instead of five stacked screens.
// Palette matches the Press Box theme the rest of the app uses.
import { fmtUnits, fmtPct, fmtMoney, MIN_N_VERDICT } from "../../lib/results.js";

export const C = {
  ink: "#16233c",
  body: "#3c4f6d",
  sub: "#4c5f7d",
  muted: "#74839d",
  faint: "#b6c5dc",
  blue: "#2062c8",
  green: "#0f8a44",
  red: "#d03131",
  amber: "#a16207",
  rule: "rgba(32,98,200,0.128)",
  ruleSoft: "rgba(32,98,200,0.064)",
  card: "rgba(210,217,236,0.5)",
  cardSolid: "rgba(210,217,236,0.7)",
};

export const MONO = "'JetBrains Mono', ui-monospace, monospace";

// Green when up, red when down, neutral at exactly zero.
export const pnlColor = (v) => (v == null ? C.muted : v > 0 ? C.green : v < 0 ? C.red : C.sub);

// A rate is only colored once the sample can support a verdict. Below the gate
// it renders in muted gray — the number is still there, it just doesn't get to
// look like a conclusion.
export const rateColor = (pct, n, { good = 55, bad = 50 } = {}) => {
  if (pct == null) return C.faint;
  if (n < MIN_N_VERDICT) return C.muted;
  return pct >= good ? C.green : pct < bad ? C.red : C.sub;
};

export function Card({ title, right, children, accent, pad = true, style }) {
  return (
    <div style={{
      background: C.card, borderRadius: 10,
      border: `1px solid ${accent || C.rule}`,
      overflow: "hidden", ...style,
    }}>
      {(title || right) && (
        <div style={{
          padding: "10px 16px", borderBottom: `1px solid ${C.rule}`,
          display: "flex", alignItems: "center", justifyContent: "space-between",
          gap: 10, flexWrap: "wrap",
        }}>
          <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: 1, fontWeight: 600 }}>{title}</div>
          {right}
        </div>
      )}
      <div style={pad ? { padding: 16 } : undefined}>{children}</div>
    </div>
  );
}

export function Stat({ label, value, color = C.ink, sub, size = 24, title }) {
  return (
    <div title={title} style={{ minWidth: 0 }}>
      <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: 1, marginBottom: 5 }}>{label}</div>
      <div style={{ fontSize: size, fontWeight: 700, color, lineHeight: 1.1, fontFamily: MONO }}>{value}</div>
      {sub != null && <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

// Last-N outcome dots, oldest → newest. Reads as a streak at a glance without
// costing a column of numbers.
export function Dots({ outcomes = [], size = 11 }) {
  if (!outcomes.length) return <span style={{ color: C.faint }}>—</span>;
  return (
    <span style={{ letterSpacing: 2, fontSize: size, whiteSpace: "nowrap" }}>
      {outcomes.map((o, i) => (
        <span key={i} style={{ color: o === "win" ? C.green : o === "loss" ? C.red : C.muted }}>●</span>
      ))}
    </span>
  );
}

// Win% with its Wilson interval. The interval is the point: it's what stops a
// 6-pick market from reading like a finding.
export function Rate({ r, showCI = true, size = 12 }) {
  if (!r || r.decided === 0) return <span style={{ color: C.faint }}>—</span>;
  const pct = r.winPct;
  return (
    <span style={{ whiteSpace: "nowrap" }}>
      <span style={{ fontSize: size, fontWeight: r.decided < MIN_N_VERDICT ? 500 : 700, color: rateColor(pct, r.decided), fontFamily: MONO }}>
        {pct.toFixed(0)}%
      </span>
      {showCI && r.ci.lo != null && (
        <span style={{ fontSize: size - 3, color: C.faint, marginLeft: 4, fontFamily: MONO }}>
          {(r.ci.lo * 100).toFixed(0)}–{(r.ci.hi * 100).toFixed(0)}
        </span>
      )}
    </span>
  );
}

export function Units({ v, size = 12, bold = true }) {
  return (
    <span style={{ fontSize: size, fontWeight: bold ? 700 : 500, color: pnlColor(v), fontFamily: MONO, whiteSpace: "nowrap" }}>
      {fmtUnits(v)}
    </span>
  );
}

// The one place dollars get rendered. Every panel uses this rather than inlining
// the multiply-and-format, so the conversion has a single definition to be wrong
// in — see the note on fmtMoney.
export function Money({ units, perUnit, size = 12, bold = true }) {
  if (units == null) return <span style={{ color: C.faint }}>—</span>;
  return (
    <span style={{ fontSize: size, fontWeight: bold ? 700 : 500, color: pnlColor(units), fontFamily: MONO, whiteSpace: "nowrap" }}>
      {fmtMoney(units, perUnit)}
    </span>
  );
}

export function Roi({ r, size = 12 }) {
  if (!r || r.roiPct == null) return <span style={{ color: C.faint }}>—</span>;
  return (
    <span style={{ fontSize: size, fontWeight: r.decided < MIN_N_VERDICT ? 500 : 700, color: r.decided < MIN_N_VERDICT ? C.muted : pnlColor(r.roiPct), fontFamily: MONO }}>
      {r.roiPct >= 0 ? "+" : ""}{fmtPct(r.roiPct)}
    </span>
  );
}

export function Pill({ children, color = C.muted, bg }) {
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, color, background: bg || `${color}18`,
      padding: "2px 8px", borderRadius: 6, whiteSpace: "nowrap",
    }}>{children}</span>
  );
}

export function Chip({ active, onClick, children, title }) {
  return (
    <button onClick={onClick} title={title} style={{
      padding: "5px 13px", fontSize: 11, fontWeight: 600, borderRadius: 16, cursor: "pointer",
      background: active ? "rgba(32,98,200,0.18)" : "rgba(210,217,236,0.5)",
      border: `1px solid ${active ? "rgba(32,98,200,0.5)" : "rgba(32,98,200,0.192)"}`,
      color: active ? C.blue : "#5d6f8b", whiteSpace: "nowrap",
    }}>{children}</button>
  );
}

// A Chip is one option in a set — pick one, the others turn off. A Toggle is a
// single switch with two states. They were the same pill, which made the
// threshold filter read as a sixth time window sitting next to "All Time".
export function Toggle({ on, onClick, children, title }) {
  return (
    <button onClick={onClick} title={title} role="switch" aria-checked={on} style={{
      display: "inline-flex", alignItems: "center", gap: 7,
      padding: "5px 12px 5px 7px", fontSize: 11, fontWeight: 600, borderRadius: 8, cursor: "pointer",
      background: on ? "rgba(32,98,200,0.14)" : "rgba(210,217,236,0.5)",
      border: `1px solid ${on ? "rgba(32,98,200,0.42)" : "rgba(32,98,200,0.192)"}`,
      color: on ? C.blue : "#5d6f8b", whiteSpace: "nowrap",
    }}>
      <span style={{
        width: 26, height: 15, borderRadius: 9, flexShrink: 0, position: "relative",
        background: on ? "rgba(32,98,200,0.55)" : "rgba(116,131,157,0.32)",
        transition: "background 120ms ease",
      }}>
        <span style={{
          position: "absolute", top: 2, left: on ? 13 : 2, width: 11, height: 11, borderRadius: "50%",
          background: "#fff", boxShadow: "0 1px 2px rgba(22,35,60,0.3)", transition: "left 120ms ease",
        }} />
      </span>
      {children}
    </button>
  );
}

// Labels a cluster of controls so the bar reads as three decisions rather than
// nine peers: which window, which population, what a unit is worth.
export function ControlGroup({ label, children }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
      <span style={{
        fontSize: 9, fontWeight: 700, color: C.faint, textTransform: "uppercase",
        letterSpacing: 0.8, whiteSpace: "nowrap",
      }}>{label}</span>
      {children}
    </div>
  );
}

export function Th({ children, align = "center", onClick, active, dir, title, width }) {
  const arrow = active ? (dir === "asc" ? " ▲" : " ▼") : "";
  return (
    <th onClick={onClick} title={title} style={{
      padding: "7px 10px", fontSize: 10, textAlign: align, fontWeight: 600, width,
      color: active ? C.blue : C.muted, cursor: onClick ? "pointer" : "default",
      userSelect: "none", whiteSpace: "nowrap", textTransform: "uppercase", letterSpacing: 0.5,
    }}>{children}{arrow}</th>
  );
}

export const tdStyle = (align = "center") => ({
  padding: "8px 10px", fontSize: 12, textAlign: align, color: C.sub, whiteSpace: "nowrap",
});

export function EmptyNote({ children }) {
  return <div style={{ padding: "18px 4px", fontSize: 12, color: C.muted, textAlign: "center" }}>{children}</div>;
}
