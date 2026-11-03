// Sub-navigation strip for the condensed "Batter Props" tab. The six batter
// prop boards (Hits / H+R+RBI / HR / TB / SB / RBI) used to be six top-level
// nav tabs; they now live behind one "Batter Props" tab with this strip,
// mirroring the props.cash player screen. Ks stays top-level (pitcher prop).
export const BATTER_BOARDS = [
  { key: "hits", label: "Hits",    emoji: "🎯" },
  { key: "hrr",  label: "H+R+RBI", emoji: "🔥" },
  { key: "hr",   label: "HR",      emoji: "💣" },
  { key: "tb",   label: "TB",      emoji: "📊" },
  { key: "sb",   label: "SB",      emoji: "🏃" },
  { key: "rbi",  label: "RBI",     emoji: "🏅" },
];

export default function BatterBoardTabs({ page, counts = {}, onSelect }) {
  return (
    <div style={{
      display: "flex", gap: 6, flexWrap: "wrap",
      padding: "12px 20px 4px",
      borderBottom: "1px solid rgba(32,98,200,0.128)",
    }}>
      {BATTER_BOARDS.map(b => {
        const active = page === b.key;
        const n = counts[b.key];
        return (
          <button key={b.key} onClick={() => onSelect(b.key)} style={{
            display: "flex", alignItems: "center", gap: 5,
            padding: "6px 13px", fontSize: 12, fontWeight: 700, whiteSpace: "nowrap",
            borderRadius: 999, cursor: "pointer",
            background: active ? "rgba(32,98,200,0.16)" : "rgba(210,217,236,0.4)",
            color: active ? "#2062c8" : "#64748d",
            border: active ? "1px solid rgba(32,98,200,0.5)" : "1px solid rgba(32,98,200,0.192)",
            transition: "all 0.15s",
          }}>
            <span style={{ fontSize: 13 }}>{b.emoji}</span>{b.label}
            {n > 0 && (
              <span style={{
                fontSize: 9, fontWeight: 700, color: "#0f8a44",
                background: "rgba(15,138,68,0.15)", padding: "1px 5px", borderRadius: 8,
              }}>{n}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
