// The upstream half of the promotion pipeline: the ledger funnel.
//
// PromotionPipeline.jsx already renders what happens AFTER a proposal is
// validated — shadow slate, promotion, revert. But the digests' recurring
// story is about the part before that: 118 proposals filed, a minority
// validated, a smaller minority ever eligible to shadow, two live. And the
// 6 that are mid-flight right now — each forward-validating against the
// incumbent on newly-graded picks — are invisible unless you read
// lab/mlb/ledger.jsonl by hand. (The 2026-08-31 digest headline was a
// 4-day queue jam nobody could see.)
//
// Source: lab/mlb/latest.json's `ledger_summary`, which the lab-analyst run
// computes and commits alongside shadow.jsonl — same build-time-import,
// same freshness contract as the rest of PromotionPipeline. No math is
// reimplemented here; by_status counts and each pending proposal's
// latest OOS eval come straight from that block.

const GREEN = "#0f8a44";
const RED = "#d03131";
const AMBER = "#a16207";
const BLUE = "#2062c8";
const MUTED = "#74839d";
const INK = "#16233c";
const GREY = "#8a97ac";

function fmtUnits(u) {
  if (u == null || !Number.isFinite(u)) return "—";
  return `${u >= 0 ? "+" : ""}${u.toFixed(2)}u`;
}

// Mirrors the "read" column the analyst digest writes for its own pending
// table: nothing to say until the proposal actually diverges from the
// incumbent and has graded picks behind it.
function pendingRead(lastEval) {
  const pn = lastEval?.oos_proposal?.n ?? 0;
  const bn = lastEval?.oos_base?.n ?? 0;
  const d = lastEval?.delta_units ?? 0;
  if (pn === 0) return { label: "fresh", color: BLUE, note: "no graded OOS picks yet" };
  if (d === 0 && pn === bn) return { label: "not binding", color: AMBER, note: "proposal keeps every pick the base does" };
  if (d <= -1) return { label: "trending negative", color: RED, note: `${fmtUnits(d)} vs incumbent` };
  if (d >= 1) return { label: "trending positive", color: GREEN, note: `${fmtUnits(d)} vs incumbent` };
  return { label: "flat / on watch", color: GREY, note: `${fmtUnits(d)} vs incumbent` };
}

// A stage is a horizontal bar on a shared 0..filed scale — a plain bar chart,
// not a tapered funnel graphic (those distort by area). The staircase IS the
// attrition; the drop to the next stage is called out in muted text.
function FunnelStage({ label, n, max, drop, isLast }) {
  const pct = max > 0 ? (n / max) * 100 : 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <div style={{ width: 108, flexShrink: 0, fontSize: 11, color: INK, fontWeight: 600, textAlign: "right" }}>{label}</div>
      <div
        style={{ flex: 1, minWidth: 0, position: "relative", height: 22 }}
        title={`${label}: ${n} of ${max} (${max > 0 ? ((n / max) * 100).toFixed(0) : 0}%)`}
      >
        <div style={{
          position: "absolute", inset: 0, background: "rgba(32,98,200,0.06)", borderRadius: 4,
        }} />
        <div style={{
          position: "absolute", top: 0, bottom: 0, left: 0, width: `${Math.max(pct, 1.5)}%`,
          background: isLast ? GREEN : BLUE, opacity: isLast ? 0.9 : 0.72, borderRadius: 4,
        }} />
      </div>
      <div style={{ width: 96, flexShrink: 0, fontSize: 11, fontFamily: "'JetBrains Mono',monospace", color: INK, fontWeight: 700 }}>
        {n}
        {drop != null && !isLast && (
          <span style={{ color: MUTED, fontWeight: 400, marginLeft: 6 }}>−{drop}</span>
        )}
      </div>
    </div>
  );
}

function VerdictBar({ byStatus, total }) {
  // validated / pending / neutral / refuted — outcome, so status colors with
  // an always-present labelled legend (never colour alone).
  const segs = [
    { key: "validated", label: "validated", n: byStatus.validated ?? 0, color: GREEN },
    { key: "pending", label: "pending", n: byStatus.pending ?? 0, color: BLUE },
    { key: "neutral", label: "neutral", n: byStatus.neutral ?? 0, color: GREY },
    { key: "refuted", label: "refuted", n: byStatus.refuted ?? 0, color: RED },
  ].filter(s => s.n > 0);
  return (
    <div style={{ marginTop: 4 }}>
      <div style={{ display: "flex", height: 14, borderRadius: 4, overflow: "hidden", gap: 2, background: "transparent" }}>
        {segs.map(s => (
          <div
            key={s.key}
            style={{ width: `${(s.n / total) * 100}%`, background: s.color, opacity: 0.82 }}
            title={`${s.label}: ${s.n} (${((s.n / total) * 100).toFixed(0)}%)`}
          />
        ))}
      </div>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 7 }}>
        {segs.map(s => (
          <span key={s.key} style={{ fontSize: 10, color: MUTED, display: "inline-flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: s.color, flexShrink: 0 }} />
            {s.label} <b style={{ color: INK, fontFamily: "'JetBrains Mono',monospace" }}>{s.n}</b>
            <span style={{ color: "#9aa7bc" }}>{((s.n / total) * 100).toFixed(0)}%</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function PendingCard({ p }) {
  const le = p.last_eval || {};
  const read = pendingRead(le);
  const pn = le.oos_proposal?.n ?? 0;
  const age = le.age_days ?? 0;
  return (
    <div style={{
      background: "rgba(210,217,236,0.5)", border: `1px solid ${read.color}33`,
      borderRadius: 10, padding: 12, display: "flex", flexDirection: "column", gap: 8,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: INK, lineHeight: 1.3 }}>{p.title}</div>
        <span style={{
          fontSize: 9, fontWeight: 700, padding: "2px 7px", borderRadius: 8, whiteSpace: "nowrap",
          color: read.color, background: `${read.color}1f`, border: `1px solid ${read.color}44`,
        }}>
          {read.label}
        </span>
      </div>
      <div style={{ fontSize: 10, color: MUTED }}>filed {p.created} · day {age}</div>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 11, fontFamily: "'JetBrains Mono',monospace" }}>
        <span style={{ color: (le.delta_units ?? 0) >= 0 ? GREEN : RED, fontWeight: 700 }}>Δ {fmtUnits(le.delta_units)}</span>
        <span style={{ color: MUTED }}>OOS n {pn}</span>
      </div>
      <div style={{ fontSize: 10, color: MUTED }}>{read.note}</div>
    </div>
  );
}

export default function PipelineFunnel({ summary, shadowCount, liveCount }) {
  if (!summary || !summary.by_status) return null;
  const filed = summary.total ?? 0;
  const byStatus = summary.by_status;
  const validated = byStatus.validated ?? 0;
  const pending = summary.pending ?? [];

  // Stage counts. "Reached shadow" and "Live" are counted by PromotionPipeline
  // from shadow.jsonl / gateOverrides.json and passed in, so there is one
  // source for each number on the page.
  const stages = [
    { label: "Filed", n: filed, drop: filed - validated },
    { label: "Validated", n: validated, drop: Math.max(0, validated - shadowCount) },
    { label: "Reached shadow", n: shadowCount, drop: Math.max(0, shadowCount - liveCount) },
    { label: "Live", n: liveCount, isLast: true },
  ];

  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: INK, marginBottom: 8, display: "flex", alignItems: "center", gap: 8 }}>
        📥 Proposal funnel <span style={{ fontSize: 10, fontWeight: 400, color: MUTED }}>(lab-analyst ledger → validated → shadow → live)</span>
      </div>

      <div style={{
        background: "rgba(210,217,236,0.5)", border: "1px solid rgba(32,98,200,0.128)",
        borderRadius: 10, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 9,
      }}>
        {stages.map(s => (
          <FunnelStage key={s.label} label={s.label} n={s.n} max={filed} drop={s.drop} isLast={s.isLast} />
        ))}
        <div style={{ fontSize: 10, color: MUTED, marginTop: 4, lineHeight: 1.5 }}>
          Most validated proposals never reach shadow — a cap with no <code style={{ background: "rgba(32,98,200,0.1)", padding: "0 3px", borderRadius: 3 }}>picks.js</code> analog,
          a global lever that is advisory-only, one that starves its market, or one still short of the 40-pick OOS depth check. See History below for what did land.
        </div>
      </div>

      {/* Verdict split of everything filed */}
      <div style={{ marginTop: 14 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: INK, marginBottom: 6 }}>
          All {filed} filed, by verdict
        </div>
        <VerdictBar byStatus={byStatus} total={filed} />
      </div>

      {/* The proposals mid-flight right now */}
      <div style={{ marginTop: 16 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: INK, marginBottom: 8, display: "flex", alignItems: "center", gap: 8 }}>
          🔬 Forward-validating now
          <span style={{ fontSize: 10, fontWeight: 400, color: MUTED }}>({pending.length} pending · each vs its market's incumbent on newly-graded picks)</span>
        </div>
        {pending.length === 0 ? (
          <div style={{ fontSize: 12, color: MUTED, padding: "8px 0" }}>No proposals pending a verdict.</div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 10 }}>
            {pending.map(p => <PendingCard key={p.id} p={p} />)}
          </div>
        )}
      </div>
    </div>
  );
}
