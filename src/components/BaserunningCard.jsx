// Baserunning Metrics card for the batter panel's Baserunning tab — or, when the
// batter has no tracked advance opportunities, the opposing pitcher's running-game
// numbers so the section is never blank.
//
// Extracted from App.jsx during the 2026-06 Savant schema audit. The fields changed
// with the data source: the old running_splits columns (firstToThird, extraBasePct, …)
// never existed upstream, so this card had shown "No baserunning data available" for
// every player since it shipped. Data now comes from /leaderboard/baserunning via
// getBatterBaserunning: rateAttXB, rateSafe, runnerRuns (+ lgAvg from the same CSV).

const MetricRow = ({ label, value, sub, color = "#16233c" }) => (
  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 14px", borderBottom: "1px solid rgba(32,98,200,0.08)" }}>
    <div>
      <div style={{ fontSize: 12, color: "#4c5f7d", fontWeight: 600 }}>{label}</div>
      {sub && <div style={{ fontSize: 10, color: "#8b99b0", marginTop: 2 }}>{sub}</div>}
    </div>
    <div style={{ fontSize: 15, fontWeight: 700, color, fontFamily: "'JetBrains Mono', monospace" }}>{value}</div>
  </div>
);

// Opposing bullpen hold — relievers cover the late, steal-prone innings the starter's numbers
// miss. n_init-weighted reliever rate_sbx (Statcast expected steal rate) vs the league pen avg.
function BullpenHoldRow({ bullpen, pitcherTeam }) {
  if (!bullpen || bullpen.bullpenRateSbx == null) return null;
  const vsLg = bullpen.lgRateSbx ? bullpen.bullpenRateSbx / bullpen.lgRateSbx : null;
  // vsLg > 1 = easier to run on than an average pen (good for the steal bettor) → green.
  const color = vsLg == null ? "#4c5f7d" : vsLg > 1.12 ? "#0f8a44" : vsLg < 0.88 ? "#d03131" : "#9333ea";
  const label = vsLg == null ? "—" : vsLg > 1.12 ? "Run-friendly" : vsLg < 0.88 ? "Locks it down" : "League-avg";
  return (
    <div style={{ padding: "12px 16px", background: "rgba(210,217,236,0.5)", borderRadius: 10, border: "1px solid rgba(147,51,234,0.18)", marginBottom: 16 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: "#9333ea", textTransform: "uppercase", letterSpacing: 1, marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
        <span>🔄</span> Bullpen Hold
        {pitcherTeam && <span style={{ fontSize: 9, color: "#5d6f8b", fontWeight: 400, textTransform: "none" }}>· {pitcherTeam} relievers (late innings)</span>}
      </div>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        {[
          { label: "vs Lg Pen", val: vsLg != null ? `${vsLg.toFixed(2)}×` : "—", color },
          { label: "Exp SB Rate", val: (bullpen.bullpenRateSbx * 100).toFixed(1) + "%", color: "#4c5f7d" },
          { label: "Relievers", val: bullpen.nRelievers ?? "—", color: "#5d6f8b" },
        ].map(({ label, val, color }) => (
          <div key={label} style={{ textAlign: "center", padding: "6px 14px", background: "rgba(147,51,234,0.06)", borderRadius: 6 }}>
            <div style={{ fontSize: 9, color: "#8b99b0", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 3 }}>{label}</div>
            <div style={{ fontSize: 18, fontWeight: 800, color, fontFamily: "'JetBrains Mono',monospace" }}>{val}</div>
          </div>
        ))}
        <div style={{ display: "flex", alignItems: "center", paddingLeft: 4, fontSize: 11, fontWeight: 700, color }}>{label}</div>
      </div>
      <div style={{ fontSize: 8, color: "#c9d5e8", marginTop: 6 }}>n_init-weighted reliever expected-steal-rate vs league bullpen avg · capture-only signal · Source: Baseball Savant</div>
    </div>
  );
}

export default function BaserunningCard({ baserunningData, oppPitcherRunningGame, oppBullpenHold, pitcherName, pitcherTeam }) {
  const hasBaserunningData = baserunningData && (
    baserunningData.rateAttXB != null ||
    baserunningData.rateSafe != null ||
    baserunningData.runnerRuns != null
  );
  const lgAtt  = baserunningData?.lgAvg?.rateAttXB;
  const lgSafe = baserunningData?.lgAvg?.rateSafe;

  if (!hasBaserunningData && baserunningData !== undefined && oppPitcherRunningGame) {
    const rg = oppPitcherRunningGame;
    const totalSBA = (rg.nSb || 0) + (rg.nCs || 0);
    const sbPct = totalSBA > 0 ? rg.nSb / totalSBA : null;
    return (
      <>
      <div style={{ padding: "14px 16px", background: "rgba(210,217,236,0.5)", borderRadius: 10, border: "1px solid rgba(194,87,15,0.15)", marginBottom: 16 }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: "#c2570f", textTransform: "uppercase", letterSpacing: 1, marginBottom: 12, display: "flex", alignItems: "center", gap: 6 }}>
          <span>🏃</span> Running Game Allowed
          {pitcherName && <span style={{ fontSize: 9, color: "#5d6f8b", fontWeight: 400, textTransform: "none", marginLeft: 4 }}>vs {pitcherName}</span>}
          <span style={{ fontSize: 9, color: "#b6c5dc", fontWeight: 400, textTransform: "none" }}>· {totalSBA} SBA · pitcher's ability to hold runners</span>
        </div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          {[
            { label: "SB Allow", val: rg.nSb || 0, color: "#d03131" },
            { label: "CS", val: rg.nCs || 0, color: "#0f8a44" },
            ...(rg.nPk > 0 ? [{ label: "PK", val: rg.nPk, color: "#a16207" }] : []),
            ...(sbPct != null ? [{ label: "SB%", val: (sbPct * 100).toFixed(0) + "%", color: sbPct > 0.80 ? "#d03131" : sbPct > 0.65 ? "#a16207" : "#0f8a44" }] : []),
            ...(rg.runsPrevented != null ? [{ label: "Runs Prev", val: (rg.runsPrevented > 0 ? "+" : "") + rg.runsPrevented.toFixed(1), color: rg.runsPrevented > 0 ? "#0f8a44" : "#d03131" }] : []),
          ].map(({ label, val, color }) => (
            <div key={label} style={{ textAlign: "center", padding: "6px 14px", background: "rgba(32,98,200,0.096)", borderRadius: 6 }}>
              <div style={{ fontSize: 9, color: "#8b99b0", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 3 }}>{label}</div>
              <div style={{ fontSize: 18, fontWeight: 800, color, fontFamily: "'JetBrains Mono',monospace" }}>{val}</div>
            </div>
          ))}
        </div>
        <div style={{ fontSize: 8, color: "#c9d5e8", marginTop: 6 }}>Runs prevented on running attempts · Used in SB prop model · Source: Baseball Savant</div>
      </div>
      <BullpenHoldRow bullpen={oppBullpenHold} pitcherTeam={pitcherTeam} />
      </>
    );
  }

  return (
    <>
    <div style={{ background: "rgba(210,217,236,0.5)", borderRadius: 10, border: "1px solid rgba(15,138,68,0.15)", overflow: "hidden", marginBottom: 16 }}>
      <div style={{ padding: "8px 14px", borderBottom: "1px solid rgba(15,138,68,0.1)", display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 13 }}>🗺️</span>
        <span style={{ fontSize: 10, fontWeight: 700, color: "#0f8a44", textTransform: "uppercase", letterSpacing: 1 }}>Baserunning Metrics</span>
        {baserunningData === undefined && <span style={{ fontSize: 10, color: "#b6c5dc" }}>Loading…</span>}
      </div>
      {hasBaserunningData ? (
        <div style={{ padding: "10px 0" }}>
          {[
            ["XB Attempt %", baserunningData.rateAttXB, v => (v * 100).toFixed(0) + "%",
              v => v > (lgAtt ?? 0.30) * 1.15 ? "#0f8a44" : v > (lgAtt ?? 0.30) * 0.85 ? "#9333ea" : "#d03131",
              `Extra-base advance attempts${lgAtt != null ? ` · Lg avg ${(lgAtt * 100).toFixed(0)}%` : ""}`],
            ["XB Safe %", baserunningData.rateSafe, v => (v * 100).toFixed(0) + "%",
              v => v > (lgSafe ?? 0.30) * 1.15 ? "#0f8a44" : v > (lgSafe ?? 0.30) * 0.85 ? "#9333ea" : "#d03131",
              `Safe advances per opportunity${lgSafe != null ? ` · Lg avg ${(lgSafe * 100).toFixed(0)}%` : ""}`],
            ["Runner Runs", baserunningData.runnerRuns, v => (v > 0 ? "+" : "") + v.toFixed(1),
              v => v > 1 ? "#0f8a44" : v > -1 ? "#4c5f7d" : "#d03131", "Runs above avg · Season total"],
          ].map(([label, val, fmt, colorFn, sub]) => val != null ? (
            <MetricRow key={label} label={label} value={fmt(val)} sub={sub} color={colorFn(val)} />
          ) : null)}
          {baserunningData.opportunities != null && (
            <div style={{ padding: "6px 14px 2px", fontSize: 10, color: "#b6c5dc" }}>
              {baserunningData.opportunities} opportunities tracked
            </div>
          )}
        </div>
      ) : baserunningData === null ? (
        <div style={{ padding: 14, fontSize: 11, color: "#b6c5dc", textAlign: "center" }}>No baserunning data available</div>
      ) : (
        <div style={{ padding: 14, fontSize: 11, color: "#b6c5dc" }}>Loading baserunning data…</div>
      )}
    </div>
    <BullpenHoldRow bullpen={oppBullpenHold} pitcherTeam={pitcherTeam} />
    </>
  );
}
