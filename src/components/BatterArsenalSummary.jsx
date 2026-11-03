// High-level pitch-family summary for the batter Arsenal tab, inspired by the
// props.cash "Pitch Analysis" card. Buckets the already-loaded batter-vs-pitch
// data (per pitch type) into Fastball / Breaking / Offspeed and shows how the
// batter performs against each family — weighted, when a matchup pitcher is
// known, by that pitcher's actual pitch mix (P% column). Reuses bvpData +
// pitcherPitches that the Arsenal tab already has in scope; no new fetch.

const PITCH_FAMILY = {
  FF: "Fastball", FA: "Fastball", SI: "Fastball", FT: "Fastball", FC: "Fastball",
  SL: "Breaking", ST: "Breaking", CU: "Breaking", KC: "Breaking", CS: "Breaking",
  SV: "Breaking", SC: "Breaking", KN: "Breaking", St: "Breaking",
  CH: "Offspeed", FS: "Offspeed", FO: "Offspeed", EP: "Offspeed",
};
const FAMILY_ORDER = ["Fastball", "Breaking", "Offspeed"];
const FAMILY_COLOR = { Fastball: "#d03131", Breaking: "#6d4fd0", Offspeed: "#0f8a44" };

function aggregateFamilies(bvpData, pitcherPitches) {
  const fam = {};
  let totalPitches = 0;
  const hasMix = pitcherPitches && Object.keys(pitcherPitches).length > 0;

  for (const [code, m] of Object.entries(bvpData || {})) {
    const name = PITCH_FAMILY[code];
    if (!name) continue;
    // In matchup mode, only count pitch types the opposing pitcher actually throws.
    if (hasMix && !(code in pitcherPitches)) continue;
    const f = fam[name] || (fam[name] = {
      pitches: 0, mix: 0,
      whiffW: 0, whiffN: 0, hhW: 0, hhN: 0, kW: 0, kN: 0, xwW: 0, xwN: 0,
    });
    const p = m.pitches || 0, pa = m.pa || 0;
    f.pitches += p; totalPitches += p;
    if (m.whiff   != null) { f.whiffW += m.whiff   * p; f.whiffN += p; }
    if (m.hardHit != null) { f.hhW    += m.hardHit * p; f.hhN    += p; }
    if (m.kPct    != null && pa) { f.kW  += m.kPct  * pa; f.kN  += pa; }
    if (m.xwoba   != null && pa) { f.xwW += m.xwoba * pa; f.xwN += pa; }
    if (hasMix && pitcherPitches[code]) f.mix += pitcherPitches[code].usage || 0;
  }

  const totalMix = FAMILY_ORDER.reduce((s, n) => s + (fam[n]?.mix || 0), 0);
  return {
    hasMix,
    rows: FAMILY_ORDER.filter(n => fam[n]).map(n => {
      const f = fam[n];
      return {
        name: n,
        // P%: opposing pitcher's family mix (normalized) when available, else the
        // batter's share of pitches faced for that family.
        pPct: hasMix
          ? (totalMix ? (f.mix / totalMix) * 100 : null)
          : (totalPitches ? (f.pitches / totalPitches) * 100 : null),
        whiff:   f.whiffN ? f.whiffW / f.whiffN : null,
        hardHit: f.hhN ? f.hhW / f.hhN : null,
        kPct:    f.kN ? f.kW / f.kN : null,
        xwoba:   f.xwN ? f.xwW / f.xwN : null,
      };
    }),
  };
}

const fmtPct  = v => v != null ? v.toFixed(0) + "%" : "—";
const fmtXw   = v => v != null ? v.toFixed(3).replace(/^0/, "") : "—";
const whiffColor = v => v == null ? "#4c5f7d" : v >= 30 ? "#d03131" : v <= 18 ? "#0f8a44" : "#3c4f6d";
const hardColor  = v => v == null ? "#4c5f7d" : v >= 40 ? "#0f8a44" : v <= 28 ? "#d03131" : "#3c4f6d";
const kColor     = v => v == null ? "#4c5f7d" : v >= 28 ? "#d03131" : v <= 18 ? "#0f8a44" : "#3c4f6d";
const xwColor    = v => v == null ? "#4c5f7d" : v >= 0.350 ? "#0f8a44" : v <= 0.290 ? "#d03131" : "#3c4f6d";

export default function BatterArsenalSummary({ bvpData, pitcherPitches, pitcherName, batterName }) {
  const { hasMix, rows } = aggregateFamilies(bvpData, pitcherPitches);
  if (!rows.length) return null;

  const th = { fontSize: 9, fontWeight: 700, color: "#74839d", textTransform: "uppercase", letterSpacing: 0.6, textAlign: "right", padding: "0 0 6px" };
  const td = { fontSize: 13, fontWeight: 600, textAlign: "right", padding: "7px 0", fontVariantNumeric: "tabular-nums" };

  return (
    <div style={{
      background: "rgba(210,217,236,0.4)", border: "1px solid rgba(32,98,200,0.192)",
      borderRadius: 10, padding: "14px 16px", marginBottom: 16,
    }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 800, color: "#16233c" }}>⚾ Pitch Family Matchup</span>
        <span style={{ fontSize: 10, color: "#74839d" }}>
          {hasMix && pitcherName ? `vs ${pitcherName}'s mix` : "all pitchers faced"}
        </span>
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={{ ...th, textAlign: "left" }}>Pitch</th>
            <th style={th} title={hasMix ? "Opposing pitcher's usage of this family" : "Share of pitches faced"}>P%</th>
            <th style={th} title="Whiff rate (lower = better contact)">Whiff%</th>
            <th style={th} title="Hard-hit rate (higher = better)">Hard%</th>
            <th style={th} title="Strikeout rate vs this family">K%</th>
            <th style={th} title="Expected wOBA vs this family">xwOBA</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.name} style={{ borderTop: "1px solid rgba(32,98,200,0.112)" }}>
              <td style={{ ...td, textAlign: "left", color: FAMILY_COLOR[r.name], fontWeight: 700 }}>{r.name}</td>
              <td style={{ ...td, color: "#3c4f6d" }}>{fmtPct(r.pPct)}</td>
              <td style={{ ...td, color: whiffColor(r.whiff) }}>{fmtPct(r.whiff)}</td>
              <td style={{ ...td, color: hardColor(r.hardHit) }}>{fmtPct(r.hardHit)}</td>
              <td style={{ ...td, color: kColor(r.kPct) }}>{fmtPct(r.kPct)}</td>
              <td style={{ ...td, color: xwColor(r.xwoba) }}>{fmtXw(r.xwoba)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
