// The canonical market breakdown. One row per tradeable thing — Ks Over and Ks
// Under are separate rows, so are NRFI/YRFI and the two sides of a game total,
// because averaging a market's two directions together lets a losing side hide
// inside a winning one.
//
// Both stake tracks are columns, not a toggle: weighted answers "did following
// the model make money", flat answers "was the model right". Those come apart
// (a 2u market at 51% and a 0.5u market at 58% can disagree on which is better)
// and seeing them together is the point.
import { Fragment, useState } from "react";
import { C, MONO, Card, Dots, Rate, Units, Money, Roi, Th, tdStyle, pnlColor, EmptyNote, Pill } from "./primitives.jsx";
import {
  byOddsBand, byPlayer, dailySeries, equitySeries, tierConf, rollup, FLAT,
  marketOrder, MIN_N_VERDICT,
} from "../../lib/results.js";
import EquityCurve from "./EquityCurve.jsx";

const SORTS = {
  // Display order, not alphabetical — the reader expects the hitter props
  // grouped in their usual sequence, the same way every other board shows them.
  market: (r) => marketOrder(r.market),
  n: (r) => r.flat.decided,
  win: (r) => (r.flat.decided ? r.flat.winPct : -1),
  weighted: (r) => r.weighted.units,
  flat: (r) => r.flat.units,
  roi: (r) => (r.flat.roiPct ?? -999),
  clv: (r) => (r.flat.avgCLV ?? -999),
  delta: (r) => (r.prior?.roiPct != null && r.flat.roiPct != null ? r.flat.roiPct - r.prior.roiPct : -999),
};

export default function MarketTable({ rows, perUnit, weightedStakeOf = FLAT, title = "By market" }) {
  const [sort, setSort] = useState({ key: "market", dir: "asc" });
  const [open, setOpen] = useState(null);

  if (!rows.length) return <Card title={title}><EmptyNote>No graded picks in this window.</EmptyNote></Card>;

  const sorted = [...rows].sort((a, b) => {
    const va = SORTS[sort.key](a), vb = SORTS[sort.key](b);
    const cmp = typeof va === "string" ? va.localeCompare(vb) : va - vb;
    return (sort.dir === "asc" ? cmp : -cmp) || a.market.localeCompare(b.market);
  });

  const head = (key, label, align = "center", titleAttr) => (
    <Th align={align} active={sort.key === key} dir={sort.dir} title={titleAttr}
      onClick={() => setSort(s => s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "market" ? "asc" : "desc" })}>
      {label}
    </Th>
  );

  const total = rows.reduce((acc, r) => ({
    w: acc.w + r.flat.w, l: acc.l + r.flat.l, pu: acc.pu + r.flat.pu,
    weighted: acc.weighted + r.weighted.units, flat: acc.flat + r.flat.units,
  }), { w: 0, l: 0, pu: 0, weighted: 0, flat: 0 });

  return (
    <Card title={title} pad={false}
      right={<span style={{ fontSize: 10, color: C.muted }}>rates below {MIN_N_VERDICT} graded picks are uncolored — they carry no verdict</span>}>
      <div className="hscroll">
        <table style={{ width: "100%", minWidth: 900, borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${C.rule}` }}>
              {head("market", "Market", "left")}
              {head("n", "N")}
              <Th>W-L-P</Th>
              {head("win", "Win% (95% CI)", "center", "Wilson interval — the range the true rate is consistent with")}
              {head("weighted", "Units ⚖", "center", "Weighted track: model-suggested stake × edge-controller multiplier")}
              {head("flat", "Units 1u", "center", "Flat track: every pick 1u, controller-blind")}
              {head("roi", "ROI", "center", "Flat-track return on amount staked")}
              <Th title="Realized P/L on the weighted track at your $/unit">$ ⚖</Th>
              {head("clv", "CLV", "center", "Mean closing-line value — did the market move toward these picks")}
              <Th>Last 10</Th>
              {head("delta", "Δ prior", "center", "ROI change vs the immediately preceding window of equal length")}
            </tr>
          </thead>
          <tbody>
            {sorted.map(r => {
              const isOpen = open === r.market;
              const dRoi = r.prior?.roiPct != null && r.flat.roiPct != null ? r.flat.roiPct - r.prior.roiPct : null;
              return (
                <Fragment key={r.market}>
                  <tr
                    onClick={() => setOpen(isOpen ? null : r.market)}
                    style={{
                      borderBottom: `1px solid ${C.ruleSoft}`, cursor: "pointer",
                      background: isOpen ? "rgba(32,98,200,0.06)" : "transparent",
                    }}>
                    <td style={{ ...tdStyle("left"), paddingLeft: 16, color: C.ink, fontWeight: 600 }}>
                      <span style={{ color: C.faint, marginRight: 6, fontSize: 10 }}>{isOpen ? "▾" : "▸"}</span>
                      {r.market}
                    </td>
                    <td style={tdStyle()}>{r.flat.decided || "—"}</td>
                    <td style={{ ...tdStyle(), fontFamily: MONO }}>
                      <span style={{ color: C.green, fontWeight: 700 }}>{r.flat.w}</span>
                      <span style={{ color: C.faint }}>-</span>
                      <span style={{ color: C.red, fontWeight: 700 }}>{r.flat.l}</span>
                      {r.flat.pu > 0 && <><span style={{ color: C.faint }}>-</span><span style={{ color: C.amber }}>{r.flat.pu}</span></>}
                    </td>
                    <td style={tdStyle()}><Rate r={r.flat} /></td>
                    <td style={tdStyle()}><Units v={r.weighted.units} /></td>
                    <td style={tdStyle()}><Units v={r.flat.units} bold={false} /></td>
                    <td style={tdStyle()}><Roi r={r.flat} /></td>
                    <td style={tdStyle()}><Money units={r.weighted.units} perUnit={perUnit} /></td>
                    <td style={{ ...tdStyle(), fontFamily: MONO }}>
                      {r.flat.avgCLV == null ? <span style={{ color: C.faint }}>—</span> : (
                        <span title={`n=${r.flat.clvN} priced picks`} style={{ color: r.flat.clvN < 10 ? C.muted : pnlColor(r.flat.avgCLV), fontWeight: r.flat.clvN < 10 ? 400 : 700 }}>
                          {r.flat.avgCLV >= 0 ? "+" : ""}{(r.flat.avgCLV * 100).toFixed(1)}pp
                        </span>
                      )}
                    </td>
                    <td style={tdStyle()}><Dots outcomes={r.recent} /></td>
                    <td style={{ ...tdStyle(), fontFamily: MONO }}>
                      {/* A sub-point move is noise; showing "▼ 0pt" implies a
                          direction the number doesn't actually support. */}
                      {dRoi == null ? <span style={{ color: C.faint }}>—</span>
                        : Math.abs(dRoi) < 0.5 ? <span style={{ color: C.muted }}>flat</span> : (
                        <span style={{ color: pnlColor(dRoi), fontWeight: 600 }}>
                          {dRoi >= 0 ? "▲" : "▼"} {Math.abs(dRoi).toFixed(0)}pt
                        </span>
                      )}
                    </td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={11} style={{ padding: 0, background: "rgba(32,98,200,0.03)", borderBottom: `1px solid ${C.rule}` }}>
                        <MarketDetail row={r} perUnit={perUnit} weightedStakeOf={weightedStakeOf} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
          <tfoot>
            <tr style={{ borderTop: `2px solid ${C.rule}` }}>
              <td style={{ ...tdStyle("left"), paddingLeft: 16, color: C.ink, fontWeight: 700 }}>All markets</td>
              <td style={{ ...tdStyle(), fontWeight: 700 }}>{total.w + total.l}</td>
              <td style={{ ...tdStyle(), fontFamily: MONO, fontWeight: 700 }}>{total.w}-{total.l}{total.pu ? `-${total.pu}` : ""}</td>
              <td style={tdStyle()}>—</td>
              <td style={tdStyle()}><Units v={total.weighted} /></td>
              <td style={tdStyle()}><Units v={total.flat} bold={false} /></td>
              <td style={tdStyle()}>—</td>
              <td style={tdStyle()}><Money units={total.weighted} perUnit={perUnit} /></td>
              <td colSpan={3} style={tdStyle()} />
            </tr>
          </tfoot>
        </table>
      </div>
    </Card>
  );
}

// ── Drill-down ───────────────────────────────────────────────────────────────
// Everything you'd want after a market row looks wrong: is it the whole window
// or one bad week (curve), is it a price problem (odds bands), is conviction
// working (thirds), and which side/line is doing the damage.
function MarketDetail({ row, perUnit, weightedStakeOf }) {
  const graded = row.picks.filter(p => p.outcome === "win" || p.outcome === "loss" || p.outcome === "push");
  // The curve has to be built on the weighted track so it lands on the same
  // number as the row's ⚖ column. Built on flat, it ends somewhere else
  // entirely and silently contradicts the row that opened it.
  const daily = dailySeries(graded, weightedStakeOf);
  const eq = equitySeries(daily);
  const bands = byOddsBand(graded, FLAT);
  const players = byPlayer(graded, 2);
  const best = players.slice(0, 5);
  const worst = [...players].reverse().slice(0, 5);

  // Conviction thirds — the HR-inversion check, per market.
  const withConf = graded.filter(p => p.outcome !== "push").map(p => ({ p, c: tierConf(p) }))
    .filter(x => x.c > 0).sort((a, b) => a.c - b.c);
  const third = Math.floor(withConf.length / 3);
  const thirds = third >= 5 ? [
    { label: "Low conviction", r: rollup(withConf.slice(0, third).map(x => x.p), FLAT) },
    { label: "Mid", r: rollup(withConf.slice(third, withConf.length - third).map(x => x.p), FLAT) },
    { label: "High conviction", r: rollup(withConf.slice(-third).map(x => x.p), FLAT) },
  ] : null;

  // Line/direction split — for markets that carry both sides at multiple lines.
  const byLine = new Map();
  for (const p of graded) {
    const k = `${p.direction === "under" ? "U" : "O"} ${p.line ?? "—"}`;
    if (!byLine.has(k)) byLine.set(k, []);
    byLine.get(k).push(p);
  }
  const lines = [...byLine.entries()].map(([k, ps]) => ({ k, r: rollup(ps, FLAT) }))
    .sort((a, b) => b.r.decided - a.r.decided).slice(0, 8);

  const box = { background: "rgba(255,255,255,0.5)", border: `1px solid ${C.rule}`, borderRadius: 8, padding: 12 };
  const hdr = { fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: 1, fontWeight: 600, marginBottom: 8 };
  const miniRow = (label, r, extra) => (
    <div key={label} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "4px 0", borderBottom: `1px solid ${C.ruleSoft}` }}>
      <span style={{ fontSize: 11, color: C.body, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>
      <span style={{ display: "flex", gap: 10, alignItems: "baseline", flexShrink: 0 }}>
        <span style={{ fontSize: 10, color: C.muted, fontFamily: MONO }}>{r.w}-{r.l}</span>
        <Rate r={r} showCI={false} size={11} />
        <Units v={r.units} size={11} />
        {extra}
      </span>
    </div>
  );

  return (
    <div style={{ padding: 16, display: "grid", gap: 14 }}>
      <div style={box}>
        <div style={hdr}>{row.market} — cumulative weighted units in this window</div>
        <EquityCurve series={eq} height={150} showFlat={false} markers={false} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 14 }}>
        {thirds && (
          <div style={box}>
            <div style={hdr}>By conviction (n={third} per third)</div>
            {thirds.map(t => miniRow(t.label, t.r))}
            {thirds[2].r.roiPct != null && thirds[0].r.roiPct != null && thirds[2].r.roiPct < thirds[0].r.roiPct - 10 && (
              <div style={{ marginTop: 8, fontSize: 10, color: C.red }}>
                ⚠ Inverted — the model's best picks are returning less than its worst.
              </div>
            )}
          </div>
        )}

        <div style={box}>
          <div style={hdr}>By price</div>
          {bands.length ? bands.map(b => miniRow(b.label, b.flat)) : <span style={{ fontSize: 11, color: C.muted }}>No priced picks.</span>}
        </div>

        <div style={box}>
          <div style={hdr}>By line / side</div>
          {lines.map(l => miniRow(l.k, l.r))}
        </div>

        {players.length > 0 && (
          <>
            <div style={box}>
              <div style={hdr}>✓ Model gets right</div>
              {best.map(p => miniRow(p.name, p))}
            </div>
            <div style={box}>
              <div style={hdr}>✗ Model gets wrong</div>
              {worst.map(p => miniRow(p.name, p))}
            </div>
          </>
        )}
      </div>

      <div style={{ display: "flex", gap: 18, flexWrap: "wrap", fontSize: 11, color: C.muted }}>
        <span style={{ color: C.faint }}>
          Splits above are flat 1u — they ask whether the model was right, not how it was sized.
        </span>
        <span>Realized: <Money units={row.weighted.units} perUnit={perUnit} size={11} /> on the weighted track</span>
        {row.flat.avgCLV != null && <span>CLV {(row.flat.avgCLV * 100).toFixed(1)}pp over {row.flat.clvN} priced picks</span>}
        {row.flat.thin && <Pill color={C.amber}>thin sample — {row.flat.decided} graded</Pill>}
      </div>
    </div>
  );
}
