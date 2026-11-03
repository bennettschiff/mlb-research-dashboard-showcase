// Confidence-decile P/L, per market — the project's most reproducible structural
// finding (top-confidence picks underperforming the middle of the distribution:
// HR top-conf −66% ROI vs bottom +9%, later recurring in tb/hits/hrr/ks) currently
// lives only as prose scattered across digests and memory notes. This renders it
// as small multiples so the "priced-in top" shape can be seen at a glance and
// re-checked continuously as new picks grade, instead of re-derived by hand.
//
// Confidence is recomputed at CURRENT calibration (pickCurrentConf / BOARD_CONFIGS)
// for every graded pick regardless of when it was saved — the same convention the
// existing "By Confidence Tier" panel uses — so a market's shape reflects what
// today's model would have said, not a frozen historical scale. Units are flat
// (1u/pick), matching the app's primary flat-track P/L convention.
import { pickCurrentConf } from "../lib/picks.js";

const GREEN = "#0f8a44";
const RED = "#d03131";
const AMBER = "#a16207";
const MUTED = "#74839d";
const INK = "#16233c";

const MARKETS = [
  { key: "hits", label: "Hits O/U 0.5", emoji: "🎯" },
  { key: "hr",   label: "Home Run",     emoji: "💣" },
  { key: "tb",   label: "Total Bases",  emoji: "📊" },
  { key: "hrr",  label: "H+R+RBI",      emoji: "🔥" },
  { key: "rbi",  label: "RBI O/U 0.5",  emoji: "🏅" },
  { key: "sb",   label: "Stolen Base",  emoji: "🏃" },
  { key: "ks",   label: "Strikeouts",   emoji: "⚾" },
];

const MIN_SAMPLE = 20; // below this, deciles are noise — show the count, not a chart

function confOf(p) {
  return p.prop_type === "ks" ? (p.conf ?? null) : pickCurrentConf(p);
}
function pickProfitUnits(p) {
  if (p.outcome === "push") return 0;
  const odds = p.best_odds || p.fair_line || -110;
  const payout = odds > 0 ? odds / 100 : 100 / Math.abs(odds);
  return p.outcome === "win" ? payout : -1;
}

function computeDeciles(picks, marketKey) {
  const rows = picks
    .filter(p => p.prop_type === marketKey && p.outcome !== "pending")
    .map(p => ({ p, c: confOf(p) }))
    .filter(x => x.c != null && Number.isFinite(x.c))
    .sort((a, b) => a.c - b.c);
  const n = rows.length;
  if (n < MIN_SAMPLE) return { n, bins: [] };
  const nBins = Math.min(10, Math.max(4, Math.floor(n / 8)));
  const bins = [];
  for (let i = 0; i < nBins; i++) {
    const start = Math.floor((i * n) / nBins);
    const end = Math.floor(((i + 1) * n) / nBins);
    const slice = rows.slice(start, end);
    if (!slice.length) continue;
    const w = slice.filter(x => x.p.outcome === "win").length;
    const l = slice.filter(x => x.p.outcome === "loss").length;
    const pu = slice.filter(x => x.p.outcome === "push").length;
    const units = slice.reduce((acc, x) => acc + pickProfitUnits(x.p), 0);
    bins.push({
      idx: i, n: slice.length, w, l, pu, units,
      confLo: slice[0].c, confHi: slice[slice.length - 1].c,
      wp: (w + l) > 0 ? w / (w + l) : null,
      perPick: units / slice.length,
    });
  }
  return { n, bins };
}

// Small-multiple bar: one bar per decile bin, units P/L, anchored to a shared
// zero baseline. Bottom and top bins get a border ring — those are the two the
// "priced-in top" pattern compares.
function DecileBars({ bins, maxAbs }) {
  const w = 16, gap = 3, barW = 12, h = 64;
  const scale = maxAbs > 0 ? (h / 2 - 4) / maxAbs : 0;
  const width = Math.max(80, bins.length * w);
  return (
    <svg width={width} height={h} style={{ display: "block", overflow: "visible" }}>
      <line x1={0} y1={h / 2} x2={width} y2={h / 2} stroke="rgba(32,98,200,0.2)" strokeWidth={1} />
      {bins.map((b, i) => {
        const barH = Math.max(1.5, Math.abs(b.units) * scale);
        const x = i * w + gap / 2;
        const color = b.units >= 0 ? GREEN : RED;
        const y = b.units >= 0 ? h / 2 - barH : h / 2;
        const isEdge = i === 0 || i === bins.length - 1;
        return (
          <rect key={i} x={x} y={y} width={barW} height={barH} rx={2} fill={color}
            opacity={isEdge ? 1 : 0.65} stroke={isEdge ? INK : "none"} strokeWidth={isEdge ? 0.75 : 0} strokeOpacity={0.25}>
            <title>{`decile ${i + 1}/${bins.length} · conf ${b.confLo.toFixed(1)}–${b.confHi.toFixed(1)} · n=${b.n} (${b.w}-${b.l}${b.pu ? `-${b.pu}` : ""}) · ${b.units >= 0 ? "+" : ""}${b.units.toFixed(2)}u`}</title>
          </rect>
        );
      })}
    </svg>
  );
}

function MarketCard({ m, picks }) {
  const { n, bins } = computeDeciles(picks, m.key);
  if (bins.length < 4) {
    return (
      <div style={{ background: "rgba(210,217,236,0.5)", border: "1px dashed rgba(32,98,200,0.2)", borderRadius: 10, padding: 12 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: INK }}>{m.emoji} {m.label}</div>
        <div style={{ fontSize: 11, color: MUTED, marginTop: 6 }}>
          Only {n} graded pick{n !== 1 ? "s" : ""} — need {MIN_SAMPLE}+ for a stable decile read.
        </div>
      </div>
    );
  }
  const maxAbs = Math.max(1, ...bins.map(b => Math.abs(b.units)));
  const top = bins[bins.length - 1], bottom = bins[0];
  const pricedInTop = top.perPick < bottom.perPick;
  return (
    <div style={{
      background: "rgba(210,217,236,0.5)", border: `1px solid ${pricedInTop ? "rgba(161,98,7,0.32)" : "rgba(32,98,200,0.128)"}`,
      borderRadius: 10, padding: 12, display: "flex", flexDirection: "column", gap: 8,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: INK }}>{m.emoji} {m.label}</div>
        <span style={{ fontSize: 10, color: MUTED }}>n={n}</span>
      </div>
      <DecileBars bins={bins} maxAbs={maxAbs} />
      <div style={{ fontSize: 10, color: MUTED, display: "flex", justifyContent: "space-between" }}>
        <span>low conf</span><span>high conf</span>
      </div>
      <div style={{ fontSize: 11, fontFamily: "'JetBrains Mono',monospace", display: "flex", gap: 12, flexWrap: "wrap" }}>
        <span style={{ color: bottom.units >= 0 ? GREEN : RED }}>bottom {bottom.perPick >= 0 ? "+" : ""}{bottom.perPick.toFixed(2)}u/pk</span>
        <span style={{ color: top.units >= 0 ? GREEN : RED }}>top {top.perPick >= 0 ? "+" : ""}{top.perPick.toFixed(2)}u/pk</span>
      </div>
      {pricedInTop && (
        <div style={{ fontSize: 10, color: AMBER, fontWeight: 600 }}>
          ⚠ priced-in top — highest-confidence decile underperforms the lowest
        </div>
      )}
    </div>
  );
}

export default function ConfidenceDecileBoard({ picks }) {
  if (!picks?.length) return null;
  return (
    <div style={{ background: "rgba(210,217,236,0.5)", borderRadius: 10, border: "1px solid rgba(32,98,200,0.128)", overflow: "hidden", marginBottom: 20 }}>
      <div style={{ padding: "10px 16px", borderBottom: "1px solid rgba(32,98,200,0.128)" }}>
        <div style={{ fontSize: 10, color: "#74839d", textTransform: "uppercase", letterSpacing: 1, fontWeight: 600 }}>
          Confidence-Decile P/L, by Market
        </div>
        <div style={{ fontSize: 10, color: MUTED, marginTop: 3 }}>
          Graded picks split into equal-count confidence deciles (current calibration) · flat 1u/pick ·
          amber border flags a market where the top decile pays worse than the bottom — the recurring "priced-in top" shape.
        </div>
      </div>
      <div style={{ padding: 12, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 10 }}>
        {MARKETS.map(m => <MarketCard key={m.key} m={m} picks={picks} />)}
      </div>
    </div>
  );
}
