-- ============================================================================
-- 001_pick_signals.sql
-- Permanent per-pick signal snapshot for empirical model validation.
-- One row per pick in mlb_picks, capturing the full model output + advancedStats
-- at the moment the pick was created. ~1 KB per row in JSONB.
--
-- Storage projection: 50 picks/day × 365 = ~18k rows/year × ~1 KB = ~18 MB/yr.
-- Free tier (500 MB) holds ~25 years.
--
-- Run in Supabase SQL Editor:
--   https://supabase.com/dashboard/project/_/sql
-- ============================================================================

create table if not exists pick_signals (
  pick_id      bigint primary key references mlb_picks(id) on delete cascade,
  pick_date    date         not null,
  market       text         not null,    -- 'hits' | 'hr' | 'sb' | 'ks' | 'hrr' | 'tb' | 'rbi' | 'ml' | 'rl'
  direction    text,                     -- 'over' | 'under' | 'home' | 'away'
  -- Flat columns for fast querying / indexing
  conf         numeric(4,2),
  model_score  numeric(10,5),
  -- Full model output snapshot (multipliers + components for this market)
  signals      jsonb        not null,
  -- advancedStats snapshot at pick-time (separate so we can recover historical baselines)
  adv_stats    jsonb,
  created_at   timestamptz  not null default now()
);

create index if not exists pick_signals_market_idx     on pick_signals(market);
create index if not exists pick_signals_pick_date_idx  on pick_signals(pick_date);
create index if not exists pick_signals_created_at_idx on pick_signals(created_at);

comment on table  pick_signals        is 'Per-pick snapshot of model multipliers + advanced stats. Used for empirical backtesting of model changes.';
comment on column pick_signals.signals is 'JSONB of result.models[market] from scan output — all multipliers (parkMult, arsenalAdj, kVulnAdj, M1-M8, etc).';
comment on column pick_signals.adv_stats is 'JSONB of player.advancedStats at pick time (xwoba, barrel%, pit_plus, fastball_velo, etc).';
