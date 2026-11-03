// The "why" layer. Nothing here is a headline — it's what you open when a
// number on Overview or Markets looks wrong and you want to know which part of
// the model produced it.
import { C, MONO, Card, Rate, Units, Roi, Th, tdStyle, EmptyNote } from "./primitives.jsx";
import { byTier, byOddsBand, byPlayer, calibrationBuckets, MIN_N_VERDICT } from "../../lib/results.js";
import ConfidenceDecileBoard from "../ConfidenceDecileBoard.jsx";

export default function DiagnosticsTab({ scored, baseScored, weightedStakeOf }) {
  const tiers = byTier(scored, weightedStakeOf);
  const bands = byOddsBand(scored, weightedStakeOf);
  const players = byPlayer(scored, 2);
  const best = players.slice(0, 10);
  const worst = [...players].reverse().slice(0, 10);
  const calib = calibrationBuckets(scored);

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))", gap: 16 }}>
        <Card title="By confidence tier" pad={false}>
          {tiers.length ? (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr style={{ borderBottom: `1px solid ${C.rule}` }}>
                <Th align="left">Tier</Th><Th>N</Th><Th>W-L-P</Th><Th>Win%</Th><Th>Units ⚖</Th><Th>ROI</Th>
              </tr></thead>
              <tbody>
                {tiers.map(t => (
                  <tr key={t.label} style={{ borderBottom: `1px solid ${C.ruleSoft}` }}>
                    <td style={{ ...tdStyle("left"), paddingLeft: 16, color: C.ink, fontWeight: 600, fontFamily: MONO }}>{t.label}</td>
                    <td style={tdStyle()}>{t.flat.decided}</td>
                    <td style={{ ...tdStyle(), fontFamily: MONO }}>{t.flat.w}-{t.flat.l}{t.flat.pu ? `-${t.flat.pu}` : ""}</td>
                    <td style={tdStyle()}><Rate r={t.flat} /></td>
                    <td style={tdStyle()}><Units v={t.weighted.units} /></td>
                    <td style={tdStyle()}><Roi r={t.flat} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <EmptyNote>No tiered picks in this window.</EmptyNote>}
        </Card>

        <Card title="By price band" pad={false}
          right={<span style={{ fontSize: 10, color: C.muted }}>where the money is actually made</span>}>
          {bands.length ? (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr style={{ borderBottom: `1px solid ${C.rule}` }}>
                <Th align="left">Odds</Th><Th>N</Th><Th>W-L</Th><Th>Win%</Th><Th>Units ⚖</Th><Th>ROI</Th>
              </tr></thead>
              <tbody>
                {bands.map(b => (
                  <tr key={b.key} style={{ borderBottom: `1px solid ${C.ruleSoft}` }}>
                    <td style={{ ...tdStyle("left"), paddingLeft: 16, color: C.ink, fontWeight: 600, fontFamily: MONO }}>{b.label}</td>
                    <td style={tdStyle()}>{b.flat.decided}</td>
                    <td style={{ ...tdStyle(), fontFamily: MONO }}>{b.flat.w}-{b.flat.l}</td>
                    <td style={tdStyle()}><Rate r={b.flat} /></td>
                    <td style={tdStyle()}><Units v={b.weighted.units} /></td>
                    <td style={tdStyle()}><Roi r={b.flat} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <EmptyNote>No priced picks in this window.</EmptyNote>}
        </Card>
      </div>

      <Card title="Calibration — stated probability vs realized rate"
        right={<span style={{ fontSize: 10, color: C.muted }}>a model can be profitable and still be lying about its confidence</span>}>
        <CalibrationPlot buckets={calib} />
      </Card>

      {/* Confidence-decile P/L per market — the structural "priced-in top" check. */}
      <ConfidenceDecileBoard picks={baseScored} />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))", gap: 16 }}>
        <PlayerCard title="✓ Model gets right" rows={best} accent="rgba(15,138,68,0.14)" />
        <PlayerCard title="✗ Model gets wrong" rows={worst} accent="rgba(208,49,49,0.14)" />
      </div>
    </div>
  );
}

// Reliability diagram. Points on the diagonal = honest probabilities; points
// below it = overconfident, which is the failure mode that quietly eats ROI
// while win% still looks fine.
function CalibrationPlot({ buckets }) {
  if (!buckets.length) return <EmptyNote>No picks with a stored model probability in this window.</EmptyNote>;

  const W = 720, H = 300, P = { t: 12, r: 14, b: 30, l: 40 };
  const iw = W - P.l - P.r, ih = H - P.t - P.b;
  const x = (v) => P.l + v * iw;
  const y = (v) => P.t + ih - v * ih;
  const maxN = Math.max(...buckets.map(b => b.n));

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", maxHeight: 320, display: "block" }}>
        {[0, 0.25, 0.5, 0.75, 1].map(t => (
          <g key={t}>
            <line x1={x(t)} x2={x(t)} y1={P.t} y2={P.t + ih} stroke="rgba(32,98,200,0.08)" />
            <line x1={P.l} x2={P.l + iw} y1={y(t)} y2={y(t)} stroke="rgba(32,98,200,0.08)" />
            <text x={x(t)} y={H - 10} textAnchor="middle" fontSize={10} fill={C.muted} fontFamily={MONO}>{(t * 100).toFixed(0)}%</text>
            <text x={P.l - 7} y={y(t) + 3.5} textAnchor="end" fontSize={10} fill={C.muted} fontFamily={MONO}>{(t * 100).toFixed(0)}%</text>
          </g>
        ))}

        {/* Perfect calibration */}
        <line x1={x(0)} y1={y(0)} x2={x(1)} y2={y(1)} stroke="rgba(32,98,200,0.4)" strokeWidth={1.5} strokeDasharray="5 4" />

        {buckets.map(b => {
          const r = 4 + (b.n / maxN) * 12;
          const off = b.actual < b.predicted;
          return (
            <g key={b.lo}>
              <line x1={x(b.predicted)} y1={y(b.actual)} x2={x(b.predicted)} y2={y(b.predicted)}
                stroke={off ? "rgba(208,49,49,0.35)" : "rgba(15,138,68,0.35)"} strokeWidth={1} />
              <line x1={x(b.predicted)} y1={y(b.ci.lo)} x2={x(b.predicted)} y2={y(b.ci.hi)}
                stroke="rgba(116,131,157,0.45)" strokeWidth={1} />
              <circle cx={x(b.predicted)} cy={y(b.actual)} r={r}
                fill={off ? "rgba(208,49,49,0.5)" : "rgba(15,138,68,0.5)"}
                stroke={off ? C.red : C.green} strokeWidth={1}>
                <title>{`Model said ${(b.predicted * 100).toFixed(0)}% · hit ${(b.actual * 100).toFixed(0)}% · n=${b.n}\n${b.gap >= 0 ? "under" : "over"}confident by ${Math.abs(b.gap * 100).toFixed(1)}pp`}</title>
              </circle>
            </g>
          );
        })}

        <text x={P.l + iw / 2} y={H - 1} textAnchor="middle" fontSize={9} fill={C.faint}>model probability →</text>
      </svg>

      <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginTop: 8, fontSize: 10, color: C.muted }}>
        <span>Dot area = sample size · vertical gray bar = 95% interval on the realized rate</span>
        <span><span style={{ color: C.red }}>●</span> below the diagonal = overconfident</span>
        <span><span style={{ color: C.green }}>●</span> above = underconfident</span>
      </div>
    </div>
  );
}

function PlayerCard({ title, rows, accent }) {
  return (
    <Card title={title} accent={accent} pad={false}>
      {rows.length ? (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr style={{ borderBottom: `1px solid ${C.rule}` }}>
            <Th align="left">Player</Th><Th align="left">Markets</Th><Th>W-L</Th><Th>Win%</Th><Th>Units</Th>
          </tr></thead>
          <tbody>
            {rows.map(p => (
              <tr key={p.name} style={{ borderBottom: `1px solid ${C.ruleSoft}` }}>
                <td style={{ ...tdStyle("left"), paddingLeft: 16, color: C.ink, fontWeight: 600 }}>{p.name}</td>
                <td style={{ ...tdStyle("left"), fontSize: 10, color: C.muted, maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis" }}>{p.propList}</td>
                <td style={{ ...tdStyle(), fontFamily: MONO }}>{p.w}-{p.l}{p.pu ? `-${p.pu}` : ""}</td>
                <td style={tdStyle()}><Rate r={p} showCI={false} /></td>
                <td style={tdStyle()}><Units v={p.units} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <EmptyNote>Needs at least two graded picks on a player.</EmptyNote>}
      <div style={{ padding: "8px 16px", fontSize: 10, color: C.faint, borderTop: `1px solid ${C.ruleSoft}` }}>
        Player-level records run small — treat anything under {MIN_N_VERDICT} picks as texture, not signal.
      </div>
    </Card>
  );
}
