// Edge-controller status strip — shows what the closed feedback loop decided
// today for each market (scripts/edge-controller.mjs → market_health →
// /api/picks?view=market-health). Rendered above the Results dashboard so a suddenly
// 0-unit market is never a mystery: hover a chip for the exact rule(s) that
// fired. Suspended markets still record picks (shadow) so they can recover.

const STATUS_STYLE = {
  active:    { icon: "✅", color: "#0f8a44", label: "active" },
  throttled: { icon: "⚠️", color: "#a16207", label: "½ units" },
  suspended: { icon: "⛔", color: "#d03131", label: "0 units" },
};

export default function ControllerStatus({ health }) {
  if (!health?.markets) return null;
  const rows = health.markets()
    .map(m => health.latest(m))
    .filter(Boolean)
    .sort((a, b) => (a.status === b.status ? (b.n_graded ?? 0) - (a.n_graded ?? 0)
      : a.status === "suspended" ? -1 : b.status === "suspended" ? 1
      : a.status === "throttled" ? -1 : 1));
  if (!rows.length) return null;
  const evalDate = rows.reduce((d, r) => (r.eval_date > d ? r.eval_date : d), "");

  return (
    <div style={{ margin: "0 0 14px", padding: "10px 12px", background: "rgba(32,98,200,0.08)",
      border: "1px solid rgba(32,98,200,0.24)", borderRadius: 10 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: "#3e6cb0" }}>🧠 Edge controller</span>
        <span style={{ fontSize: 10, color: "#74839d" }}>
          learned from the last 30d of graded results · sizes stakes, never blocks tracking · {evalDate}
        </span>
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {rows.map(r => {
          const s = STATUS_STYLE[r.status] ?? STATUS_STYLE.active;
          const tip = [
            `${r.market.toUpperCase()} — ${r.status} (stake ×${r.unit_mult})`,
            r.n_graded != null ? `last 30d: ${r.n_graded} picks, ${r.cash_pct ?? "—"}% cash, ${r.units_pl ?? "—"}u` : null,
            r.avg_clv_pp != null ? `CLV ${r.avg_clv_pp > 0 ? "+" : ""}${r.avg_clv_pp}pp (n=${r.n_clv})` : null,
            r.calib_gap_pp != null ? `calibration gap ${r.calib_gap_pp}pp` : null,
            ...(Array.isArray(r.reasons) ? r.reasons.map(x => `• ${x}`) : []),
          ].filter(Boolean).join("\n");
          return (
            <span key={r.market} title={tip} style={{ display: "inline-flex", alignItems: "center", gap: 4,
              fontSize: 11, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", color: s.color,
              background: `${s.color}14`, border: `1px solid ${s.color}33`, borderRadius: 5,
              padding: "2px 7px", cursor: "help" }}>
              {s.icon} {r.market}
              <span style={{ fontWeight: 500, fontSize: 10, opacity: 0.8 }}>{s.label}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}
