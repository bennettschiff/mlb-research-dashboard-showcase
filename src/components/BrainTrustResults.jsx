import { useEffect, useState, useMemo } from "react";

const MKT_LABEL = { hits: "Hits", hrr: "H+R+RBI", tb: "TB", rbi: "RBI", hr: "HR", sb: "SB", ks: "Ks" };
const fmtOdds = a => (a == null ? "—" : a > 0 ? `+${a}` : `${a}`);
const fmtPct = p => (p == null ? "—" : `${(100 * p).toFixed(1)}%`);

// Aggregate one flavor across all graded days. ROI is n-weighted so days combine correctly.
// resultsKey indexes r.results (value_parlays/safe_parlays); flavor is the short slip label
// (value/safe) the filter buttons and SlipRow match on — they MUST stay distinct or the
// Value/Safe filter silently matches nothing.
function aggregate(rows, resultsKey, flavor) {
  let n = 0, wins = 0, pnl = 0;
  const slips = [];
  for (const r of rows) {
    const f = r.results?.[resultsKey];
    if (!f) continue;
    n += f.n || 0;
    wins += f.wins || 0;
    if (f.roi != null && f.n) pnl += f.roi * f.n;
    for (const s of f.slips || []) slips.push({ ...s, date: r.game_date, flavor });
  }
  return { n, wins, losses: n - wins, winRate: n ? wins / n : null, roi: n ? pnl / n : null, slips };
}

function StatCard({ title, accent, agg }) {
  return (
    <div style={{ flex: 1, minWidth: 220, border: `1px solid ${accent}26`, borderRadius: 10, padding: "12px 16px", background: "rgba(225,231,242,0.4)" }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: accent, marginBottom: 8 }}>{title}</div>
      <div style={{ display: "flex", gap: 18, fontFamily: "'JetBrains Mono',monospace" }}>
        <div><div style={{ fontSize: 18, fontWeight: 700, color: "#14213a" }}>{agg.wins}-{agg.losses}</div><div style={{ fontSize: 9, color: "#74839d" }}>RECORD</div></div>
        <div><div style={{ fontSize: 18, fontWeight: 700, color: "#3c4f6d" }}>{fmtPct(agg.winRate)}</div><div style={{ fontSize: 9, color: "#74839d" }}>WIN %</div></div>
        <div><div style={{ fontSize: 18, fontWeight: 700, color: agg.roi >= 0 ? "#0f8a44" : "#d03131" }}>{agg.roi == null ? "—" : `${agg.roi >= 0 ? "+" : ""}${(100 * agg.roi).toFixed(0)}%`}</div><div style={{ fontSize: 9, color: "#74839d" }}>ROI (flat)</div></div>
      </div>
    </div>
  );
}

function SlipRow({ slip }) {
  const accent = slip.flavor === "value" ? "#2062c8" : "#0f8a44";
  const result = slip.won == null ? { txt: "PENDING", c: "#64748d", bg: "rgba(100,116,141,0.12)" }
    : slip.won ? { txt: "WON", c: "#0f8a44", bg: "rgba(15,138,68,0.13)" }
    : { txt: "LOST", c: "#d03131", bg: "rgba(208,49,49,0.13)" };
  return (
    <div style={{ border: "1px solid rgba(32,98,200,0.16)", borderRadius: 8, padding: "10px 12px", background: "rgba(225,231,242,0.3)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, flexWrap: "wrap", gap: 6 }}>
        <span style={{ fontSize: 11, color: "#64748d", fontFamily: "'JetBrains Mono',monospace" }}>
          {slip.date} · <span style={{ color: accent, fontWeight: 700, textTransform: "uppercase" }}>{slip.flavor}</span> · {slip.legCount}-leg · {fmtOdds(slip.combinedAmerican)}
        </span>
        <span style={{ fontSize: 10, fontWeight: 700, color: result.c, background: result.bg, padding: "2px 8px", borderRadius: 8 }}>{result.txt}</span>
      </div>
      <div style={{ display: "grid", gap: 4 }}>
        {slip.legs.map((l, i) => {
          const c = l.won == null ? "#64748d" : l.won ? "#0f8a44" : "#d03131";
          const mark = l.won == null ? "•" : l.won ? "✓" : "✗";
          return (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "3px 6px" }}>
              <span style={{ color: "#14213a" }}><span style={{ color: c, fontWeight: 700, marginRight: 6 }}>{mark}</span>{l.player} <span style={{ color: "#74839d", fontSize: 10 }}>{l.team}{l.opp ? ` v ${l.opp}` : ""}</span></span>
              <span style={{ fontFamily: "'JetBrains Mono',monospace", color: "#3c4f6d" }}>
                {MKT_LABEL[l.market] || l.market} O{l.line} · {fmtOdds(l.bookOdds)} · <span style={{ color: c }}>got {l.value == null ? "—" : l.value}</span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function BrainTrustResults() {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState("");
  const [flavor, setFlavor] = useState("all"); // all | value | safe

  useEffect(() => {
    let alive = true;
    fetch("/api/brain-trust?query=" + encodeURIComponent("select=game_date,results&graded=eq.true&order=game_date.desc&limit=60"))
      .then(r => r.json())
      .then(d => { if (alive) setRows(Array.isArray(d) ? d : []); })
      .catch(e => { if (alive) setErr(e.message || "load failed"); });
    return () => { alive = false; };
  }, []);

  const value = useMemo(() => aggregate(rows || [], "value_parlays", "value"), [rows]);
  const safe = useMemo(() => aggregate(rows || [], "safe_parlays", "safe"), [rows]);
  const slips = useMemo(() => {
    const all = [...value.slips, ...safe.slips].filter(s => flavor === "all" || s.flavor === flavor);
    return all.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)).slice(0, 60);
  }, [value, safe, flavor]);

  if (err) return <div style={{ color: "#d03131", fontSize: 12, padding: 16 }}>Brain Trust results: {err}</div>;
  if (rows == null) return <div style={{ color: "#74839d", fontSize: 12, padding: 16 }}>Loading Brain Trust parlay record…</div>;
  if (!rows.length) return <div style={{ color: "#74839d", fontSize: 12, padding: 16 }}>No graded Brain Trust parlays yet — the morning-score job grades each day's slips at 7 AM ET.</div>;

  return (
    <div>
      <h3 style={{ fontSize: 15, fontWeight: 700, color: "#14213a", margin: "0 0 2px" }}>💎 Brain Trust Parlay Record</h3>
      <p style={{ fontSize: 11, color: "#64748d", margin: "0 0 14px" }}>
        Forward-graded record of the tab's proposed parlays (tracking only — not yet bet). Each slip shows which legs hit (✓) and lost (✗).
      </p>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
        <StatCard title="🎯 Value parlays" accent="#2062c8" agg={value} />
        <StatCard title="🛡 Safe parlays" accent="#0f8a44" agg={safe} />
      </div>
      <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
        {["all", "value", "safe"].map(f => (
          <button key={f} onClick={() => setFlavor(f)}
            style={{ padding: "4px 12px", fontSize: 11, fontWeight: 600, cursor: "pointer", borderRadius: 6,
              border: "1px solid", borderColor: flavor === f ? "#2062c8" : "rgba(32,98,200,0.24)",
              background: flavor === f ? "rgba(32,98,200,0.192)" : "transparent",
              color: flavor === f ? "#2062c8" : "#74839d", textTransform: "capitalize" }}>{f}</button>
        ))}
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        {slips.map((s, i) => <SlipRow key={i} slip={s} />)}
      </div>
    </div>
  );
}
