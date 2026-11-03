// ─────────────────────────────────────────────────────────────────────────────
// The three LAB panel tables, as Drive-backed date-partitioned archives.
//
//   gdrive:mlb-research-dashboard-archive/player-day-features/YYYY-MM-DD.jsonl.gz
//   gdrive:mlb-research-dashboard-archive/batter-asof-features/YYYY-MM-DD.jsonl.gz
//   gdrive:mlb-research-dashboard-archive/pitcher-asof-features/YYYY-MM-DD.jsonl.gz
//
// 254 MB of LAB's 367 MB, against ~42 MB gzipped on Drive. All three are
// append-mostly, date-keyed, and read only in batch — see date-archive.mjs for
// why they move and why mining_findings and pick_feature_matrix do not.
//
// READERS: use `panel.range(lo, hi)` in place of
// `player_day_features?game_date=gte.${lo}&game_date=lte.${hi}`, and
// `panel.range()` with no bounds for the full history. Do NOT give range() a
// default window — alt-line-backtest, fit-blend and incremental-value read the
// whole panel on purpose, and a silent default is the `woba` sample leak that
// cost four baselines two thirds of their sample.
// ─────────────────────────────────────────────────────────────────────────────

import { labDb } from "../_lab.mjs";
import { makeDateArchive } from "./date-archive.mjs";

export const panel = makeDateArchive({
  name: "player_day_features",
  table: "player_day_features",
  db: labDb,
});

// The as-of tables are written ONCE A WEEK by asof-refresh.yml with a 10-day
// lookback that rewrites already-archived dates, so their nightly re-pull covers
// that lookback (12 = 10 + slack for GH schedule lateness; still inside the
// 14-day Postgres retention). Both tables are ~800 rows/date, so this is cheap.
export const batterAsof = makeDateArchive({
  name: "batter_asof_features",
  table: "batter_asof_features",
  db: labDb,
  syncDays: 12,
});

export const pitcherAsof = makeDateArchive({
  name: "pitcher_asof_features",
  table: "pitcher_asof_features",
  db: labDb,
  syncDays: 12,
});

export const ALL = [panel, batterAsof, pitcherAsof];
