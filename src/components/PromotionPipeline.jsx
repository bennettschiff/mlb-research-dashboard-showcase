// Promotion pipeline visibility — the lab-analyst ledger files proposals, the
// promotion gate (scripts/promotion-gate.mjs) forward-validates them on a live
// shadow slate, and graduates (or reverts) them into src/lib/gateOverrides.json.
// Until now that whole lifecycle was legible only by reading lab/mlb/shadow.jsonl
// and docs/GATE_CHANGELOG.md by hand. This reads the same three files the
// pipeline already writes — no new API, no duplicated math — and renders what
// stage every proposal is in and how it's tracking against the incumbent.
//
// All three sources are committed to git and pushed by lab-analyst.yml, which
// triggers a redeploy — so these are build-time imports (like nrfiParams.json),
// not a runtime fetch. The view is exactly as fresh as the last lab-analyst run.
import shadowRaw from "../fixtures/shadow.jsonl?raw";
import changelogRaw from "../fixtures/GATE_CHANGELOG.md?raw";
import gateOverrides from "../lib/gateOverrides.json" with { type: "json" };
import labLatest from "../fixtures/lab-latest.json" with { type: "json" };
import PipelineFunnel from "./PipelineFunnel.jsx";

const SHADOW_MATURITY_DAYS = 14; // docs/GATE_CHANGELOG.md: "train/test split → forward validation → shadow slate"
const SHADOW_MATURITY_N = 40;    // digest language: "not yet mature (needs 14d/40 picks)"

const GREEN = "#0f8a44";
const RED = "#d03131";
const AMBER = "#a16207";
const BLUE = "#2062c8";
const MUTED = "#74839d";
const INK = "#16233c";

function parseShadow(raw) {
  return raw.split("\n").map(l => l.trim()).filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

// docs/GATE_CHANGELOG.md sections look like:
//   ## 2026-07-23 — MLB
//   - **SHADOW FAILED** `tb.conf_max = 9.6` — tb: set conf_max = 9.6
//     - -1.08u over 3d; validated lift did not replicate. Not promoted.
// The founding entry (2026-07-20) is narrative, not a structured event list —
// it's dropped by the events.length filter below.
//
// A revert is written differently: promotion-gate.mjs's appendChangelog call
// for a revert (scripts/promotion-gate.mjs ~line 440) puts the event in the
// HEADING itself — "## DATE — REVERTED `sport.market`" — with plain
// "- Removed: …" / "- Reason: …" / "- Source proposal: …" bullets below, not
// a "**REVERTED**" bold bullet under a dated MLB/WNBA section. The original
// parser only recognized the bold-bullet form, so the 2026-08-14 hr
// score_max revert — the pipeline's first-ever revert — silently vanished
// from History. Both shapes are handled below.
export function parseChangelog(raw) {
  const entries = [];
  let current = null;
  let inRevertHeading = false;
  for (const line of raw.split("\n")) {
    const h = line.match(/^##\s+(\d{4}-\d{2}-\d{2})\s+—\s+(.+)$/);
    if (h) {
      current = { date: h[1], scope: h[2].trim(), events: [] };
      entries.push(current);
      const rh = current.scope.match(/^REVERTED\s+`([^`]+)`/);
      inRevertHeading = !!rh;
      if (rh) current.events.push({ status: "REVERTED", title: rh[1], reason: null });
      continue;
    }
    if (!current) continue;
    if (inRevertHeading && current.events.length) {
      const last = current.events[current.events.length - 1];
      const removed = line.match(/^-\s+Removed:\s*(.+)$/);
      const reasonM = line.match(/^-\s+Reason:\s*(.+)$/);
      if (removed) { last.title = `${last.title} — removed ${removed[1]}`; continue; }
      if (reasonM) { last.reason = last.reason ? `${last.reason} ${reasonM[1]}` : reasonM[1]; continue; }
      continue; // "- Source proposal: …" and blank lines carry nothing worth showing
    }
    const b = line.match(/^-\s+\*\*(PROMOTED|SHADOW FAILED|REVERTED)\*\*\s*(.*)$/);
    if (b) { current.events.push({ status: b[1], title: b[2].replace(/`/g, "").trim(), reason: null }); continue; }
    const r = line.match(/^\s{2,}-\s+(.+)$/);
    if (r && current.events.length) {
      const last = current.events[current.events.length - 1];
      last.reason = last.reason ? `${last.reason} ${r[1]}` : r[1];
    }
  }
  return entries.filter(e => e.events.length > 0).sort((a, b) => b.date.localeCompare(a.date));
}

const EVENT_STYLE = {
  PROMOTED: { icon: "🏆", color: GREEN, label: "promoted" },
  "SHADOW FAILED": { icon: "⛔", color: RED, label: "shadow failed" },
  REVERTED: { icon: "↩️", color: AMBER, label: "reverted" },
};

function fmtUnits(u) {
  if (u == null || !Number.isFinite(u)) return "—";
  return `${u >= 0 ? "+" : ""}${u.toFixed(2)}u`;
}
function fmtPct(p) {
  if (p == null || !Number.isFinite(p)) return "—";
  return `${(p * 100).toFixed(0)}%`;
}
function paramLabel(change) {
  if (!change) return "—";
  return `${change.market} ${change.param} = ${change.value}`;
}

// Small-multiple bar: one bar per eval date, delta_units vs the incumbent,
// anchored to a shared zero baseline so magnitude is comparable card-to-card.
function DeltaBars({ evals, maxAbs }) {
  const h = 44;
  const scale = maxAbs > 0 ? (h / 2 - 3) / maxAbs : 0;
  return (
    <svg width={Math.max(60, evals.length * 16)} height={h} style={{ display: "block", overflow: "visible" }}>
      <line x1={0} y1={h / 2} x2={Math.max(60, evals.length * 16)} y2={h / 2} stroke="rgba(32,98,200,0.2)" strokeWidth={1} />
      {evals.map((e, i) => {
        const d = e.delta_units ?? 0;
        const barH = Math.max(1.5, Math.abs(d) * scale);
        const x = i * 16 + 3;
        const color = d >= 0 ? GREEN : RED;
        const y = d >= 0 ? h / 2 - barH : h / 2;
        return (
          <g key={i}>
            <rect x={x} y={y} width={10} height={barH} rx={2} fill={color} opacity={0.85}>
              <title>{`${e.date} (day ${e.age_days}) · Δ ${fmtUnits(d)} · n=${e.market_oos_n}`}</title>
            </rect>
          </g>
        );
      })}
    </svg>
  );
}

function ShadowCard({ entry, maxAbs }) {
  const failed = entry.status === "shadow_failed";
  const lastEval = entry.evals?.[entry.evals.length - 1] ?? null;
  const dayN = lastEval?.age_days ?? entry.evals?.length ?? 0;
  const nSince = lastEval?.market_oos_n ?? 0;
  // Each eval is a fresh cumulative snapshot re-measured over the full shadow-to-date
  // sample (incumbent.n/proposal.n grow monotonically across evals) — delta_units is
  // already "as of this day," so the current standing is the LAST eval's value, never
  // a sum across evals (that would multiply-count the same underlying picks).
  const cumUnits = lastEval?.delta_units ?? 0;
  const mature = dayN >= SHADOW_MATURITY_DAYS && nSince >= SHADOW_MATURITY_N;
  const badge = failed
    ? { icon: "⛔", color: RED, label: "failed" }
    : mature
      ? { icon: "✅", color: GREEN, label: "mature" }
      : { icon: "🕒", color: AMBER, label: "tracking" };
  return (
    <div style={{
      background: "rgba(210,217,236,0.5)", border: `1px solid ${failed ? "rgba(208,49,49,0.28)" : "rgba(32,98,200,0.128)"}`,
      borderRadius: 10, padding: 12, display: "flex", flexDirection: "column", gap: 8,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: INK, lineHeight: 1.3 }}>{paramLabel(entry.change)}</div>
          <div style={{ fontSize: 10, color: MUTED, marginTop: 2 }}>{entry.ledger_source} · filed {entry.ledger_created}</div>
        </div>
        <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 7px", borderRadius: 8, whiteSpace: "nowrap",
          color: badge.color, background: `${badge.color}1f`, border: `1px solid ${badge.color}44` }}>
          {badge.icon} {badge.label}
        </span>
      </div>
      <DeltaBars evals={entry.evals || []} maxAbs={maxAbs} />
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 11, fontFamily: "'JetBrains Mono',monospace" }}>
        <span style={{ color: cumUnits >= 0 ? GREEN : RED, fontWeight: 700 }}>Δ {fmtUnits(cumUnits)}</span>
        <span style={{ color: MUTED }}>retain {fmtPct(entry.retain_pct)}</span>
        <span style={{ color: MUTED }}>day {dayN}/{SHADOW_MATURITY_DAYS}</span>
        <span style={{ color: MUTED }}>n {nSince}/{SHADOW_MATURITY_N}</span>
      </div>
    </div>
  );
}

function ChangelogRow({ date, ev }) {
  const s = EVENT_STYLE[ev.status] ?? { icon: "•", color: MUTED, label: ev.status };
  return (
    <div style={{ display: "flex", gap: 10, padding: "8px 10px", borderBottom: "1px solid rgba(32,98,200,0.08)", alignItems: "baseline", flexWrap: "wrap" }}>
      <span style={{ fontSize: 10, color: MUTED, fontFamily: "'JetBrains Mono',monospace", width: 78, flexShrink: 0 }}>{date}</span>
      <span style={{ fontSize: 10, fontWeight: 700, color: s.color, whiteSpace: "nowrap" }}>{s.icon} {s.label}</span>
      <span style={{ fontSize: 12, color: INK, fontWeight: 600 }}>{ev.title}</span>
      {ev.reason && <span style={{ fontSize: 11, color: MUTED, flexBasis: "100%", marginTop: 2 }}>{ev.reason}</span>}
    </div>
  );
}

export default function PromotionPipeline() {
  const shadow = parseShadow(shadowRaw);
  const changelog = parseChangelog(changelogRaw);
  const promoted = Object.entries(gateOverrides?.mlb ?? {});
  // Sort by the latest eval's delta_units, not a sum across evals — each eval is a
  // fresh cumulative snapshot (n grows across evals), so summing would multiply-count
  // the same underlying picks. See the matching comment in ShadowCard.
  const lastDelta = s => { const evs = s.evals || []; return evs[evs.length - 1]?.delta_units ?? 0; };
  const active = shadow.filter(s => s.status === "shadow").sort((a, b) => lastDelta(b) - lastDelta(a));
  const failed = shadow.filter(s => s.status === "shadow_failed");
  const maxAbs = Math.max(1, ...shadow.flatMap(s => (s.evals || []).map(e => Math.abs(e.delta_units ?? 0))));

  return (
    <div>
      <div style={{ fontSize: 11, color: MUTED, marginBottom: 16, lineHeight: 1.6, maxWidth: 900 }}>
        Every gate proposal's lifecycle: filed by the lab-analyst ledger → forward-validated on a
        live shadow slate (bars = daily units vs the incumbent, shared scale) → graduated into
        <code style={{ background: "rgba(32,98,200,0.1)", padding: "0 4px", borderRadius: 3, margin: "0 3px" }}>gateOverrides.json</code>
        or reverted. A capped market never stops surfacing picks — it only loses the 🎲.
        Source: <code style={{ background: "rgba(32,98,200,0.1)", padding: "0 4px", borderRadius: 3 }}>lab/mlb/shadow.jsonl</code>,{" "}
        <code style={{ background: "rgba(32,98,200,0.1)", padding: "0 4px", borderRadius: 3 }}>latest.json</code>,{" "}
        <code style={{ background: "rgba(32,98,200,0.1)", padding: "0 4px", borderRadius: 3 }}>gateOverrides.json</code>,{" "}
        <code style={{ background: "rgba(32,98,200,0.1)", padding: "0 4px", borderRadius: 3 }}>GATE_CHANGELOG.md</code> — refreshed each time lab-analyst.yml runs.
      </div>

      <PipelineFunnel summary={labLatest?.ledger_summary} shadowCount={shadow.length} liveCount={promoted.length} />

      {/* ── Live gates ─────────────────────────────────────────────────── */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: INK, marginBottom: 8, display: "flex", alignItems: "center", gap: 8 }}>
          🏆 Live <span style={{ fontSize: 10, fontWeight: 400, color: MUTED }}>({promoted.length} promoted)</span>
        </div>
        {promoted.length === 0 ? (
          <div style={{ fontSize: 12, color: MUTED, background: "rgba(210,217,236,0.4)", border: "1px dashed rgba(32,98,200,0.2)", borderRadius: 8, padding: "12px 14px" }}>
            Nothing has graduated yet — <code>gateOverrides.json</code> is still empty for MLB. That's the honest current state, not a missing feature: everything below is still earning it.
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 10 }}>
            {promoted.map(([market, g]) => (
              <div key={market} style={{ background: "rgba(15,138,68,0.08)", border: "1px solid rgba(15,138,68,0.28)", borderRadius: 10, padding: 12 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: INK }}>{market}</div>
                <div style={{ fontSize: 11, color: MUTED, marginTop: 2 }}>
                  {["conf_min", "conf_max", "score_min", "score_max"].filter(k => g[k] != null).map(k => `${k}=${g[k]}`).join(", ")}
                </div>
                <div style={{ fontSize: 10, color: GREEN, marginTop: 4, fontFamily: "'JetBrains Mono',monospace" }}>
                  {fmtUnits(g.shadow_delta_units)} over {g.shadow_days}d · retain {fmtPct(g.retain_pct)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Shadow slate ───────────────────────────────────────────────── */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: INK, marginBottom: 8, display: "flex", alignItems: "center", gap: 8 }}>
          🕒 In shadow <span style={{ fontSize: 10, fontWeight: 400, color: MUTED }}>({active.length} tracking · sorted healthiest first)</span>
        </div>
        {active.length === 0 ? (
          <div style={{ fontSize: 12, color: MUTED, padding: "10px 0" }}>No proposals currently in shadow.</div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 10 }}>
            {active.map(entry => <ShadowCard key={entry.id} entry={entry} maxAbs={maxAbs} />)}
          </div>
        )}
      </div>

      {/* ── Failed shadow runs ─────────────────────────────────────────── */}
      {failed.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: INK, marginBottom: 8, display: "flex", alignItems: "center", gap: 8 }}>
            ⛔ Failed shadow <span style={{ fontSize: 10, fontWeight: 400, color: MUTED }}>({failed.length})</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 10 }}>
            {failed.map(entry => <ShadowCard key={entry.id} entry={entry} maxAbs={maxAbs} />)}
          </div>
        </div>
      )}

      {/* ── Changelog history ──────────────────────────────────────────── */}
      <div>
        <div style={{ fontSize: 12, fontWeight: 700, color: INK, marginBottom: 8 }}>📜 History <span style={{ fontSize: 10, fontWeight: 400, color: MUTED }}>(from GATE_CHANGELOG.md)</span></div>
        {changelog.length === 0 ? (
          <div style={{ fontSize: 12, color: MUTED, padding: "10px 0" }}>No promotions or reverts logged yet beyond the founding entry.</div>
        ) : (
          <div style={{ background: "rgba(210,217,236,0.5)", border: "1px solid rgba(32,98,200,0.128)", borderRadius: 10, overflow: "hidden" }}>
            {changelog.flatMap(entry => entry.events.map((ev, i) => <ChangelogRow key={`${entry.date}-${i}`} date={entry.date} ev={ev} />))}
          </div>
        )}
      </div>
    </div>
  );
}
