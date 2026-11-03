// ── Pitcher Props board (outs · hits allowed · walks · earned runs) ────────────
// The four pitcher props the app did not model before 2026-10. They come from the Pitch Lab
// (src/lib/pitchlab.js): LightGBM count distributions on 2.1M raw pitches, scored each
// in-season morning by scripts/pitchlab/score.py. enrichScanData (App.jsx) prices each one
// against the book line; without odds the cell shows the model's own median line, display only.
//
// Honest framing on the header, from lab/pitchlab/report.md: the probabilities are calibrated
// (when it says 60%, it has been right ~60%), and the 🎲 calls — the top 20% of the model's
// raw confidence at a real book line — were right 56–67% on the Jul–Sep 2026 holdout.
import { useMemo, useState } from "react";
import { PITCHER_PROPS, pitcherPropCall } from "../lib/pitchlab.js";
import { formatOdds } from "../lib/utils.js";

const HOLDOUT_RIGHT = { outs: "59.8%", hits_allowed: "56.5%", walks: "67.3%", er: "62.5%" };
const BOOK_ABBR = { fanduel: "FD", draftkings: "DK", hardrockbet: "HR" };

// enrichScanData only runs once odds exist; before that, price at the model's median line.
function callsFor(p) {
  if (p.pitcherProps) return p.pitcherProps;
  const pl = p.pitchlabProps;
  if (!pl) return null;
  const out = {};
  for (const [propType, mk] of Object.entries(PITCHER_PROPS)) {
    const c = pitcherPropCall(pl[mk.key], null, pl.gates?.[mk.key], false);
    if (c) out[propType] = { ...c, hasBookLine: false, mean: pl[mk.key]?.mean ?? null, sideOdds: null };
  }
  return Object.keys(out).length ? out : null;
}

function bestPrice(odds) {
  let best = null;
  for (const [bk, price] of Object.entries(odds || {})) {
    if (price != null && (best == null || price > best.price)) best = { bk, price };
  }
  return best;
}

function PropCell({ call }) {
  if (!call) return <td style={{ padding: "8px 10px", color: "#a3afc4", fontSize: 11, textAlign: "center" }}>—</td>;
  const over = call.side === "over";
  const best = bestPrice(call.sideOdds);
  return (
    <td style={{ padding: "8px 10px", textAlign: "center", verticalAlign: "middle",
      background: call.official ? (over ? "rgba(15,138,68,0.07)" : "rgba(208,49,49,0.06)") : "transparent" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 5 }}>
        {call.official && <span title="Official call: model's top 20% of raw confidence at a real book line">🎲</span>}
        <span style={{ fontSize: 11, fontWeight: 700, color: over ? "#0f8a44" : "#d03131" }}>
          {over ? "▲ O" : "▼ U"} {call.line}
        </span>
        {!call.hasBookLine && (
          <span title="No book line yet — the model's own median line, for reading only" style={{ fontSize: 9, color: "#8b99b0" }}>model</span>
        )}
      </div>
      <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, fontWeight: 700, color: "#16233c", marginTop: 2 }}>
        {(call.prob * 100).toFixed(0)}%
      </div>
      <div style={{ fontSize: 9, color: "#74839d", marginTop: 1 }}>
        avg {call.mean != null ? call.mean.toFixed(1) : "—"}
        {best && <> · {BOOK_ABBR[best.bk] || best.bk} {formatOdds(best.price)}</>}
      </div>
    </td>
  );
}

export default function PitcherPropsBoard({ scanData, onSelectPitcher }) {
  const [officialOnly, setOfficialOnly] = useState(false);
  const rows = useMemo(() => {
    const list = (scanData?.pitchers || []).map(p => ({ p, calls: callsFor(p) })).filter(r => r.calls);
    const strength = r => Math.max(0, ...Object.values(r.calls).map(c => (c.official ? 1 : 0) + c.rawConf));
    return list
      .filter(r => !officialOnly || Object.values(r.calls).some(c => c.official))
      .sort((a, b) => strength(b) - strength(a));
  }, [scanData, officialOnly]);

  if (!scanData?.pitchers) {
    return <div style={{ padding: "40px 20px", textAlign: "center", color: "#74839d" }}>Loading pitcher data…</div>;
  }
  const scored = (scanData.pitchers || []).filter(p => p.pitchlabProps).length;
  const plays = rows.reduce((n, r) => n + Object.values(r.calls).filter(c => c.official).length, 0);

  return (
    <div style={{ padding: "20px", minHeight: "calc(100vh - 120px)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
        <span style={{ fontSize: 28 }}>🧤</span>
        <div>
          <div style={{ fontSize: 20, fontWeight: 700, color: "#16233c" }}>Pitcher Props</div>
          <div style={{ fontSize: 11, color: "#74839d", marginTop: 2 }}>
            Outs · hits allowed · walks · earned runs — Pitch Lab models on 2.1M pitches, scored each morning
          </div>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 12, fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, color: plays ? "#0f8a44" : "#8b99b0" }}>
            🎲 {plays} play{plays !== 1 ? "s" : ""}
          </span>
          <button onClick={() => setOfficialOnly(v => !v)} style={{
            padding: "3px 10px", fontSize: 10, fontWeight: 600, borderRadius: 10, cursor: "pointer",
            background: officialOnly ? "rgba(32,98,200,0.24)" : "rgba(22,44,80,0.05)",
            border: "1px solid rgba(32,98,200,0.2)", color: officialOnly ? "#2062c8" : "#74839d",
          }}>{officialOnly ? "Showing 🎲 only" : "Show 🎲 only"}</button>
        </div>
      </div>

      <div style={{ marginBottom: 14, padding: "10px 14px", borderRadius: 10, fontSize: 11, lineHeight: 1.5,
        background: "rgba(32,98,200,0.06)", border: "1px solid rgba(32,98,200,0.15)", color: "#3d4f6e" }}>
        <b>How sure is it?</b> Probabilities are calibrated — a 60% call has been right about 60% of the time.
        Books post these lines near each starter's median, so most calls sit at 50–60%. The 🎲 calls are the model's
        top 20% at a real book line; on the Jul–Sep 2026 holdout they were right{" "}
        {Object.entries(PITCHER_PROPS).map(([k, m], i) => (
          <span key={k}>{i ? ", " : ""}{m.label.toLowerCase()} <b>{HOLDOUT_RIGHT[k]}</b></span>
        ))}.
      </div>

      {scored === 0 ? (
        <div style={{ padding: "40px 20px", textAlign: "center", color: "#74839d" }}>
          The Pitch Lab hasn't scored this slate yet — it runs each in-season morning (pitchlab workflow).
        </div>
      ) : (
        <div style={{ background: "rgba(210,217,236,0.4)", borderRadius: 12, border: "1px solid rgba(32,98,200,0.128)", overflow: "hidden" }}>
          <div className="hscroll">
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 640 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid rgba(32,98,200,0.16)" }}>
                  <th style={{ padding: "8px 10px", textAlign: "left", fontSize: 10, color: "#74839d", fontWeight: 700 }}>Pitcher</th>
                  {Object.values(PITCHER_PROPS).map(m => (
                    <th key={m.key} style={{ padding: "8px 10px", textAlign: "center", fontSize: 10, color: "#74839d", fontWeight: 700 }}>{m.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(({ p, calls }) => (
                  <tr key={p.pitcherId} style={{ borderBottom: "1px solid rgba(32,98,200,0.08)" }}>
                    <td style={{ padding: "8px 10px", whiteSpace: "nowrap" }}>
                      <button onClick={() => onSelectPitcher?.(p)} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", textAlign: "left" }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: "#16233c" }}>{p.name}</div>
                        <div style={{ fontSize: 10, color: "#74839d" }}>{p.team} {p.isHome ? "vs" : "@"} {p.opponent}{p.hand ? ` · ${p.hand}HP` : ""}</div>
                      </button>
                    </td>
                    {Object.keys(PITCHER_PROPS).map(k => <PropCell key={k} call={calls[k]} />)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
