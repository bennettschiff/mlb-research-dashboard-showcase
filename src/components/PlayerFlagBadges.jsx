// Personal-context emoji badges shown next to a player's name (birthday,
// home/road split advantage, hometown game, paternity return). Flags are
// computed by computePlayerFlags at scan time.
// Extracted from App.jsx 2026-07-06 as part of the incremental dissolution.
export default function PlayerFlagBadges({ flags, size = 14 }) {
  if (!flags || (!flags.birthday && !flags.homeAdvantage && !flags.roadAdvantage && !flags.hometown && !flags.babyBump)) return null;
  return (
    <span style={{ display: "inline-flex", gap: 2, marginLeft: 4, verticalAlign: "middle", lineHeight: 1 }}>
      {flags.babyBump      && <span title="New dad — back from paternity list" style={{ fontSize: size }}>👶</span>}
      {flags.birthday      && <span title="Birthday today!"               style={{ fontSize: size }}>🎂</span>}
      {flags.homeAdvantage && <span title="Performs better at home"       style={{ fontSize: size }}>🏠</span>}
      {flags.roadAdvantage && <span title="Performs better on the road"   style={{ fontSize: size }}>🥷</span>}
      {flags.hometown      && <span title="Playing near their hometown"   style={{ fontSize: size }}>👨‍👩‍👧</span>}
    </span>
  );
}
