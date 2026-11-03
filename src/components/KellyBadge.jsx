import { computeKellyUnits } from '../lib/models.js';

const KELLY_COLORS = ["", "#64748d", "#2062c8", "#a16207", "#cf6c1c", "#0f8a44"];

export default function KellyBadge({ modelProb, americanOdds, validated = false, style = {} }) {
  const units = computeKellyUnits(modelProb, americanOdds, { validated });
  if (!units) {
    return (
      <span title="Sizing held until this model version is forward-calibrated" style={{ fontSize: 10, color: "#b6c5dc", ...style }}>
        —
      </span>
    );
  }
  const color = KELLY_COLORS[units];
  return (
    <span style={{
      fontSize: 11, fontWeight: 700, fontFamily: "'JetBrains Mono',monospace",
      color, background: `${color}18`, padding: "1px 6px", borderRadius: 4,
      whiteSpace: "nowrap", ...style,
    }}>
      {units}u{units === 5 ? " 💪" : ""}
    </span>
  );
}
