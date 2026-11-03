// ── Conviction display — the number, the dice, and why ──────────────────────
// One renderer for every board (props, Ks, Slate Odds) so "how strong is this
// play" reads identically wherever it appears. Consumes the result of
// src/lib/conviction.js; contains no gate logic of its own.
//
// The rule it makes visible: the play line is drawn on the page, the 🎲 sits
// above it, and a row that the model liked but a gate rejected wears a chip
// saying which gate and what its raw read was — instead of silently keeping
// the big number and quietly losing the dice (the 2026-08-14 TB/HR board).
import { TIER, TIER_META } from "../lib/conviction.js";

const confColor = (conf, line) => {
  if (conf == null) return "#b6c5dc";
  if (line != null && conf >= line) return "#0f8a44";
  if (line != null && conf >= line - 1.0) return "#2569d6";
  return conf >= 4.5 ? "#a16207" : "#d03131";
};

// Chips are deliberately NOT drawn for lean/research: those are most of a
// board, and a chip on every row is noise. Only the two "the model liked this
// and something overruled it" states get called out.
const CHIP_TIERS = new Set([TIER.pricedIn, TIER.blocked]);

export default function ConvictionCell({ c, dice = "🎲", diceTitle = "Official scored pick", size = 14, stack = false }) {
  if (!c || c.conf == null) {
    return <span style={{ fontSize: 10, color: "#b6c5dc" }}>—</span>;
  }
  const meta = TIER_META[c.tier];
  const showChip = CHIP_TIERS.has(c.tier);
  const tip = c.folded
    ? `${meta.label} — ${c.reason}\nModel's raw read was ${c.raw.toFixed(1)}; shown below the ${c.line} play line because it is not a play.`
    : c.tier === TIER.play
      ? `${diceTitle} — conviction ${c.conf.toFixed(1)} vs a ${c.line} play line`
      : `${meta.label} — conviction ${c.conf.toFixed(1)}, play line ${c.line}`;

  return (
    <span
      title={tip}
      style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        flexDirection: stack ? "column" : "row", gap: stack ? 2 : 4, cursor: "help",
      }}
    >
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
        <span style={{
          fontSize: size, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace",
          color: confColor(c.conf, c.line), lineHeight: 1,
        }}>
          {c.conf.toFixed(1)}
        </span>
        {c.tier === TIER.play && <span style={{ fontSize: 11, lineHeight: 1 }}>{dice}</span>}
      </span>
      {showChip && (
        <span style={{
          fontSize: 8, fontWeight: 700, letterSpacing: 0.3, whiteSpace: "nowrap",
          padding: "1px 4px", borderRadius: 3,
          color: meta.color, background: meta.bg, border: `1px solid ${meta.color}33`,
        }}>
          {meta.label}
        </span>
      )}
    </span>
  );
}

// The one-line explainer that belongs under any board carrying convictions.
// `line` is that board's play line; `capNote` describes a live promoted gate.
export function ConvictionLegend({ line, capNote = null, style }) {
  return (
    <div style={{ fontSize: 10, color: "#8b99b0", lineHeight: 1.8, ...style }}>
      <strong style={{ color: "#8b99b0" }}>Conviction</strong> — one 1–10 scale per market.{" "}
      <span style={{ color: "#0f8a44", fontWeight: 700 }}>🎲 {line?.toFixed?.(1) ?? line}+</span> is an official
      play and is saved to Results; below that is research. A row can never sit at or above the play line
      without the dice — if the model liked it and a gate overruled it, it folds under the line wearing the
      reason.{" "}
      <span style={{ color: TIER_META[TIER.pricedIn].color, fontWeight: 700 }}>PRICED IN</span> = a validated
      cap on this market's top tail (its most-confident picks lose money).{" "}
      <span style={{ color: TIER_META[TIER.blocked].color, fontWeight: 700 }}>NO PLAY</span> = a requirement
      the row can't meet (missing lineup, a line the book is sharp on).
      {capNote && (
        <>
          {" "}
          <span style={{ color: TIER_META[TIER.pricedIn].color }}>{capNote}</span>
        </>
      )}
    </div>
  );
}
