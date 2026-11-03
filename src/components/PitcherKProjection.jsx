// K Projection box for the pitcher panel — lives on the Book Odds tab so the
// Stats & Splits tab leads with splits (the thing we read most).
function MiniStat({ label, value, accent }) {
  return (
    <div style={{ textAlign: "center", flex: "1 1 50px" }}>
      <div style={{ fontSize: 9, color: "#74839d", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 700, color: accent || "#3c4f6d", fontFamily: "'JetBrains Mono', monospace" }}>{value}</div>
    </div>
  );
}

export default function PitcherKProjection({ pitcherScanData, kModel, ppr }) {
  const sd = pitcherScanData;
  if (!sd && !(kModel && ppr?.type === "SP")) return null;
  const signal = sd?.signal;
  const signalColor = signal === "over" ? "#0f8a44" : signal === "under" ? "#d03131" : "#74839d";

  return (
    <div style={{ marginBottom: 16, padding: "12px 16px", background: "rgba(15,138,68,0.05)", borderRadius: 10, border: "1px solid rgba(15,138,68,0.15)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
        <span style={{ fontSize: 10, color: "#0f8a44", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>K Projection (Today)</span>
        {sd ? (
          <span style={{ fontSize: 11, fontWeight: 700, color: sd.roleUncertain ? "#a15c00" : signalColor, fontFamily: "'JetBrains Mono', monospace" }}>
            {sd.roleUncertain ? "⚠ ROLE?" : signal === "over" ? "▲ OVER" : signal === "under" ? "▼ UNDER" : "—"} · Line {(sd.line||0).toFixed(1)}
          </span>
        ) : (
          <span style={{ fontSize: 16, fontWeight: 700, color: "#0f8a44", fontFamily: "'JetBrains Mono', monospace" }}>{kModel.score.toFixed(1)} K/start</span>
        )}
      </div>
      {sd?.roleUncertain && (
        <div style={{ marginBottom: 10, padding: "7px 10px", borderRadius: 6, fontSize: 11, lineHeight: 1.45, color: "#7a4600", background: "rgba(214,138,0,0.12)", border: "1px solid rgba(214,138,0,0.3)" }}>
          <b>Role uncertain.</b> The book's line ({(sd.line || 0).toFixed(1)}) is {Math.abs(sd.xKEdge || 0).toFixed(1)} Ks off our
          projection ({(sd.xK || 0).toFixed(1)}). A gap this size is usually an opener, bulk day or innings limit the book
          already knows about — in 2026 about 2 of 3 of these went under. Trust the line; no pick.
        </div>
      )}
      {sd ? (
        <div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
            <div style={{ background: "rgba(32,98,200,0.128)", borderRadius: 6, padding: "8px 10px", textAlign: "center" }}>
              <div style={{ fontSize: 9, color: "#2062c8", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 4 }}>xK (Regression)</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: "#2062c8", fontFamily: "'JetBrains Mono', monospace" }}>{(sd.xK||0).toFixed(1)}</div>
              <div style={{ fontSize: 9, color: "#b6c5dc", marginTop: 2 }}>60% season + 40% L5 K/9</div>
            </div>
            <div style={{ background: "rgba(60,80,110,0.06)", borderRadius: 6, padding: "8px 10px", textAlign: "center" }}>
              <div style={{ fontSize: 9, color: "#4c5f7d", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 4 }}>K-Edge (Multiplier)</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: "#4c5f7d", fontFamily: "'JetBrains Mono', monospace" }}>{(sd.kEdge||0).toFixed(1)}</div>
              <div style={{ fontSize: 9, color: "#b6c5dc", marginTop: 2 }}>50% career + 50% season K/9</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <MiniStat label="Proj IP" value={(sd.projIP||0).toFixed(1)} />
            <MiniStat label="SwStr%" value={sd.swStrPct != null ? sd.swStrPct.toFixed(1)+"%" : "—"} accent={sd.swStrPct > 12 ? "#0f8a44" : sd.swStrPct < 9 ? "#d03131" : undefined} />
            <MiniStat label="Opp K%" value={sd.oppKRatePct != null ? sd.oppKRatePct.toFixed(1)+"%" : "—"} accent={sd.oppKRatePct > 24 ? "#0f8a44" : undefined} />
            <MiniStat label="±σ (L5)" value={"±"+(sd.l5Stddev||0).toFixed(1)} />
            <MiniStat label={sd.roleUncertain ? "Edge (role?)" : "Edge"} value={(sd.xKEdge>=0?"+":"")+(sd.xKEdge||0).toFixed(1)} accent={sd.roleUncertain ? "#b6c5dc" : sd.xKEdge > 0 ? "#0f8a44" : "#d03131"} />
            <MiniStat label="Conf" value={(sd.conf||0).toFixed(1)} accent={(sd.conf||0) >= 7.5 ? "#0f8a44" : undefined} />
          </div>
          <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
            <MiniStat label="M1 Arsenal" value={"×"+(sd.M1||1).toFixed(2)} accent={sd.M1 > 1.05 ? "#0f8a44" : sd.M1 < 0.95 ? "#d03131" : undefined} />
            <MiniStat label="M3 Opp" value={"×"+(sd.M3||1).toFixed(2)} accent={sd.M3 > 1.05 ? "#0f8a44" : sd.M3 < 0.95 ? "#d03131" : undefined} />
            <MiniStat label="M4 Geo" value={"×"+(sd.M4||1).toFixed(2)} />
            {sd.M7 != null && sd.M7 !== 1.0 && (
              <MiniStat label="M7 Lineup" value={"×"+(sd.M7||1).toFixed(2)} accent={sd.M7 > 1.05 ? "#0f8a44" : sd.M7 < 0.95 ? "#d03131" : undefined} />
            )}
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <MiniStat label="Proj K/9" value={ppr?.k9?.toFixed(1) || "—"} />
          <MiniStat label="Avg L5 K" value={kModel.recentKAvg.toFixed(1)} accent={kModel.recentKAvg >= 7 ? "#0f8a44" : undefined} />
          <MiniStat label="StdDev" value={kModel.recentStddev != null ? kModel.recentStddev.toFixed(1) : "—"} />
          <MiniStat label="Consistency" value={kModel.consistency != null ? (kModel.consistency*100).toFixed(0)+"%" : "—"} accent={kModel.consistency >= 0.8 ? "#0f8a44" : undefined} />
        </div>
      )}
    </div>
  );
}
