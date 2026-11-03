// Sweep-surface: for each market's four gate params (conf_min, conf_max,
// score_min, score_max), how train vs held-out-test Δ-units move as the
// threshold slides — the overfit gap (train ≫ test) and the current sweep's
// peak become visible at a glance. PromotionPipeline answers "what happened
// after a proposal was filed"; this answers "why would the sweep file this
// level in the first place."
//
// Source: lab/mlb/latest.json's `sweeps` block (276 rows, market × param ×
// level), recomputed fresh every lab-analyst run — unlike a filed proposal's
// frozen evidence, this is always current against whatever model version is
// live (run_date trails every modelVersions.js bump by construction), so
// there is no CHECK-9-style staleness risk here. Every row's `space` is
// "score" — these sweeps are already in score space, the same rule
// src/lib/picks.js gates enforce (CLAUDE.md: "Gates live in score space,
// never probability space").
//
// Live gates (gateOverrides.json) and reverted ones (GATE_CHANGELOG.md, via
// the same parseChangelog PromotionPipeline already exports) are drawn as
// reference lines so a curve reads against what's actually been tried, not
// in a vacuum.
import { useState } from "react";
import gateOverrides from "../lib/gateOverrides.json" with { type: "json" };
import labLatest from "../fixtures/lab-latest.json" with { type: "json" };
import changelogRaw from "../fixtures/GATE_CHANGELOG.md?raw";
import { parseChangelog } from "./PromotionPipeline.jsx";
import { Chip, Toggle } from "./results/primitives.jsx";

const GREEN = "#0f8a44";
const RED = "#d03131";
const AMBER = "#a16207";
const BLUE = "#2062c8";
const MUTED = "#74839d";
const INK = "#16233c";

const MARKETS = [
  { key: "tb", label: "Total Bases", emoji: "📊" },
  { key: "hr", label: "Home Run", emoji: "💣" },
  { key: "hits", label: "Hits O/U 0.5", emoji: "🎯" },
  { key: "hrr", label: "H+R+RBI", emoji: "🔥" },
  { key: "rbi", label: "RBI O/U 0.5", emoji: "🏅" },
  { key: "sb", label: "Stolen Base", emoji: "🏃" },
  { key: "ks", label: "Strikeouts", emoji: "⚾" },
  { key: "ml", label: "Moneyline", emoji: "🏆" },
  { key: "ou", label: "Game O/U", emoji: "🔢" },
];

const PARAMS = ["conf_min", "conf_max", "score_min", "score_max"];

function fmtUnits(u) {
  if (u == null || !Number.isFinite(u)) return "—";
  return `${u >= 0 ? "+" : ""}${u.toFixed(2)}u`;
}
function fmtLevel(v) {
  if (v == null || !Number.isFinite(v)) return "—";
  return parseFloat(v.toFixed(3)).toString();
}

// "## DATE — REVERTED `mlb.tb`" + "- Removed: conf_max = 9.3" folds, in
// parseChangelog, into one event: { status: "REVERTED", title: "mlb.tb —
// removed conf_max = 9.3", reason }. Pull market/param/level back out.
function revertedMarkers(changelog) {
  const out = [];
  for (const entry of changelog) {
    for (const ev of entry.events) {
      if (ev.status !== "REVERTED") continue;
      const m = ev.title.match(/^mlb\.(\w+)\s+—\s+removed\s+(\w+)\s*=\s*([\d.]+)/);
      if (!m) continue;
      out.push({ market: m[1], param: m[2], level: parseFloat(m[3]), date: entry.date, reason: ev.reason });
    }
  }
  return out;
}

const W = 236, H = 118, PAD_L = 6, PAD_R = 6, PAD_TOP = 16, PAD_BOTTOM = 20;
const PLOT_W = W - PAD_L - PAD_R, PLOT_H = H - PAD_TOP - PAD_BOTTOM;

function SweepPanel({ param, series, maxAbs, live, reverted }) {
  if (!series.length) {
    return (
      <div style={{ background: "rgba(210,217,236,0.5)", border: "1px dashed rgba(32,98,200,0.2)", borderRadius: 8, padding: 10, fontSize: 10, color: MUTED }}>
        <div style={{ fontWeight: 700, color: INK, fontSize: 11, marginBottom: 4 }}>{param}</div>
        no sweep rows
      </div>
    );
  }
  const levels = series.map(s => s.level);
  const lo = Math.min(...levels), hi = Math.max(...levels);
  const span = hi - lo || 1;
  const x = lvl => PAD_L + ((lvl - lo) / span) * PLOT_W;
  const zeroY = PAD_TOP + PLOT_H / 2;
  const y = d => zeroY - (Math.max(-maxAbs, Math.min(maxAbs, d)) / maxAbs) * (PLOT_H / 2);

  const testPath = series.map((s, i) => `${i === 0 ? "M" : "L"}${x(s.level).toFixed(1)},${y(s.test.delta_units).toFixed(1)}`).join(" ");
  const trainPath = series.map((s, i) => `${i === 0 ? "M" : "L"}${x(s.level).toFixed(1)},${y(s.train.delta_units).toFixed(1)}`).join(" ");

  const peak = series.reduce((best, s) => (s.test.delta_units > best.test.delta_units ? s : best), series[0]);
  const gap = peak.train.delta_units - peak.test.delta_units;
  const flag = peak.test.delta_units <= 0
    ? { label: "no held-out lift", color: RED }
    : gap > 5
      ? { label: "overfit gap", color: AMBER }
      : null;

  const clampX = lvl => PAD_L + Math.max(0, Math.min(1, (lvl - lo) / span)) * PLOT_W;

  return (
    <div style={{ background: "rgba(210,217,236,0.5)", border: `1px solid ${flag ? `${flag.color}52` : "rgba(32,98,200,0.128)"}`, borderRadius: 8, padding: "8px 8px 6px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 2 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: INK, fontFamily: "'JetBrains Mono',monospace" }}>{param}</span>
        <span style={{ fontSize: 9, color: MUTED }}>{series.length} levels</span>
      </div>
      <svg width={W} height={H} style={{ display: "block", overflow: "visible" }}>
        {/* zero baseline */}
        <line x1={PAD_L} y1={zeroY} x2={W - PAD_R} y2={zeroY} stroke="rgba(32,98,200,0.2)" strokeWidth={1} />
        <text x={W - PAD_R} y={zeroY - 3} textAnchor="end" fontSize={8} fill={MUTED}>0u</text>

        {/* reverted markers — tried and pulled */}
        {reverted.map((r, i) => (
          <g key={`rv-${i}`}>
            <line x1={clampX(r.level)} y1={PAD_TOP} x2={clampX(r.level)} y2={H - PAD_BOTTOM} stroke={AMBER} strokeWidth={1.25} strokeDasharray="2,2" opacity={0.75}>
              <title>{`reverted ${r.date} @ ${fmtLevel(r.level)}${r.reason ? ` — ${r.reason}` : ""}`}</title>
            </line>
          </g>
        ))}
        {/* live gate — currently binding */}
        {live != null && (
          <g>
            <line x1={clampX(live)} y1={PAD_TOP} x2={clampX(live)} y2={H - PAD_BOTTOM} stroke={GREEN} strokeWidth={1.5} strokeDasharray="4,2">
              <title>{`live gate: ${param} = ${fmtLevel(live)}`}</title>
            </line>
            <text x={clampX(live)} y={PAD_TOP - 4} textAnchor="middle" fontSize={8} fontWeight={700} fill={GREEN}>live</text>
          </g>
        )}

        {/* train — dashed, secondary (prone to overfitting the split it was measured on) */}
        <path d={trainPath} fill="none" stroke={MUTED} strokeWidth={1.5} strokeDasharray="3,3" opacity={0.85} />

        {/* test — solid, primary (held-out, the number that matters) */}
        <path d={testPath} fill="none" stroke={BLUE} strokeWidth={2} />
        {series.map((s, i) => {
          const r = 2 + 2.5 * Math.sqrt(Math.min(1, s.test.n / 2000));
          return (
            <g key={i}>
              <circle cx={x(s.level)} cy={y(s.test.delta_units)} r={r} fill={BLUE} stroke="#fff" strokeWidth={0.75} />
              <circle cx={x(s.level)} cy={y(s.test.delta_units)} r={8} fill="transparent">
                <title>{`level ${fmtLevel(s.level)} · test Δ ${fmtUnits(s.test.delta_units)} (n=${s.test.n}) · train Δ ${fmtUnits(s.train.delta_units)} (n=${s.train.n}, dropped ${s.dropped_train})`}</title>
              </circle>
              {s === peak && (
                <circle cx={x(s.level)} cy={y(s.test.delta_units)} r={r + 3} fill="none" stroke={INK} strokeWidth={1} opacity={0.55} />
              )}
            </g>
          );
        })}

        <text x={PAD_L} y={H - 4} fontSize={8} fill={MUTED}>{fmtLevel(lo)}</text>
        <text x={W - PAD_R} y={H - 4} textAnchor="end" fontSize={8} fill={MUTED}>{fmtLevel(hi)}</text>
      </svg>
      <div style={{ fontSize: 10, color: MUTED, marginTop: 2 }}>
        peak <b style={{ color: INK, fontFamily: "'JetBrains Mono',monospace" }}>{fmtLevel(peak.level)}</b>{" "}
        <span style={{ color: peak.test.delta_units >= 0 ? GREEN : RED, fontFamily: "'JetBrains Mono',monospace" }}>{fmtUnits(peak.test.delta_units)}</span>{" "}
        <span style={{ color: "#9aa7bc" }}>(train {fmtUnits(peak.train.delta_units)})</span>
      </div>
      {flag && (
        <div style={{ fontSize: 9, color: flag.color, fontWeight: 700, marginTop: 2 }}>⚠ {flag.label}</div>
      )}
    </div>
  );
}

function SweepTable({ rows }) {
  return (
    <div style={{ overflowX: "auto", border: "1px solid rgba(32,98,200,0.128)", borderRadius: 8 }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
        <thead>
          <tr style={{ background: "rgba(32,98,200,0.06)" }}>
            {["param", "level", "train Δ", "train n", "test Δ", "test n", "dropped"].map(h => (
              <th key={h} style={{ padding: "6px 8px", textAlign: h === "param" ? "left" : "right", color: MUTED, fontSize: 9, textTransform: "uppercase", letterSpacing: 0.5 }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((s, i) => (
            <tr key={i} style={{ borderTop: "1px solid rgba(32,98,200,0.08)" }}>
              <td style={{ padding: "5px 8px", fontFamily: "'JetBrains Mono',monospace", color: INK }}>{s.param}</td>
              <td style={{ padding: "5px 8px", textAlign: "right", fontFamily: "'JetBrains Mono',monospace" }}>{fmtLevel(s.level)}</td>
              <td style={{ padding: "5px 8px", textAlign: "right", fontFamily: "'JetBrains Mono',monospace", color: s.train.delta_units >= 0 ? GREEN : RED }}>{fmtUnits(s.train.delta_units)}</td>
              <td style={{ padding: "5px 8px", textAlign: "right", color: MUTED }}>{s.train.n}</td>
              <td style={{ padding: "5px 8px", textAlign: "right", fontFamily: "'JetBrains Mono',monospace", color: s.test.delta_units >= 0 ? GREEN : RED }}>{fmtUnits(s.test.delta_units)}</td>
              <td style={{ padding: "5px 8px", textAlign: "right", color: MUTED }}>{s.test.n}</td>
              <td style={{ padding: "5px 8px", textAlign: "right", color: MUTED }}>{s.dropped_train}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function SweepSurface() {
  const sweeps = labLatest?.sweeps ?? [];
  const marketsPresent = new Set(sweeps.map(s => s.market));
  const markets = MARKETS.filter(m => marketsPresent.has(m.key));
  const [market, setMarket] = useState(markets.find(m => m.key === "tb")?.key ?? markets[0]?.key);
  const [table, setTable] = useState(false);

  if (!sweeps.length || !market) {
    return <div style={{ fontSize: 12, color: MUTED, padding: "10px 0" }}>No sweep data in the latest lab-analyst run.</div>;
  }

  const changelog = parseChangelog(changelogRaw);
  const reverted = revertedMarkers(changelog);
  const gates = gateOverrides?.mlb ?? {};

  const marketRows = sweeps.filter(s => s.market === market);
  const seriesByParam = {};
  for (const p of PARAMS) {
    seriesByParam[p] = marketRows.filter(s => s.param === p).sort((a, b) => a.level - b.level);
  }
  // Shared y-scale across a market's four panels — same units (Δ-units), so the
  // best achievable lift is directly comparable across which param you'd tune.
  const maxAbs = Math.max(1, ...marketRows.flatMap(s => [Math.abs(s.train.delta_units), Math.abs(s.test.delta_units)]));

  return (
    <div>
      <div style={{ fontSize: 11, color: MUTED, marginBottom: 12, lineHeight: 1.6, maxWidth: 900 }}>
        Every gate the auto-sweep tried for this market, at the current model version — train Δ-units (dashed) vs
        held-out-test Δ-units (solid, the number that decides) against the incumbent, by threshold level. The gap
        between the two lines at the peak is the overfit risk a proposal carries into shadow; <span style={{ color: GREEN, fontWeight: 700 }}>green</span> marks
        today's live gate, <span style={{ color: AMBER, fontWeight: 700 }}>amber</span> a level that was promoted and later reverted.
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {markets.map(m => (
            <Chip key={m.key} active={market === m.key} onClick={() => setMarket(m.key)}>{m.emoji} {m.label}</Chip>
          ))}
        </div>
        <Toggle on={table} onClick={() => setTable(t => !t)}>table view</Toggle>
      </div>

      {table ? (
        <SweepTable rows={marketRows.slice().sort((a, b) => a.param.localeCompare(b.param) || a.level - b.level)} />
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(236px, 1fr))", gap: 10 }}>
          {PARAMS.map(p => (
            <SweepPanel
              key={p}
              param={p}
              series={seriesByParam[p]}
              maxAbs={maxAbs}
              live={gates[market]?.[p] ?? null}
              reverted={reverted.filter(r => r.market === market && r.param === p)}
            />
          ))}
        </div>
      )}

      <div style={{ fontSize: 9, color: "#9aa7bc", marginTop: 10 }}>
        legend: <span style={{ color: BLUE }}>●</span> test Δ (held-out) · <span style={{ color: MUTED }}>- -</span> train Δ ·
        {" "}<span style={{ color: GREEN, fontWeight: 700 }}>┊</span> live gate · <span style={{ color: AMBER, fontWeight: 700 }}>┊</span> reverted ·
        {" "}marker size ∝ held-out sample size
      </div>
    </div>
  );
}
