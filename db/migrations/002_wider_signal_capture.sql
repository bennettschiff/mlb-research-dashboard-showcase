-- ============================================================================
-- 002_wider_signal_capture.sql
-- Widen the pick-time snapshot to capture EVERY raw Savant payload and model
-- intermediate, not just the curated atoms in extractRawSignals.
--
-- Why: the mining substrate is bottlenecked by what we store. Curated atoms
-- bias us toward signals we already suspected. Capturing the full fetched
-- payloads at pick-time lets future mining ask questions we haven't thought
-- of yet, without re-fetching historical Savant data (which can drift).
--
-- Run in Supabase SQL Editor.
-- ============================================================================

-- Full raw Savant + game-context payloads, snapshotted at pick time.
-- Keys (typical):
--   pitcher_arsenal     — full per-pitch object (whiff, putAway, kPct, rv100, velo, spin, usage per pitch type)
--   pitcher_statcast    — full custom-leaderboard row + lgAvg (GB/FB/LD/PU%, contact-quality, extension, arm angle)
--   batter_pitch_data   — batter's xwoba/xslg/whiff/hardHit per pitch type
--   batter_power_stats  — barrel, hard_hit, exit_velo, launch_angle, batSpeed, swing_length
--   batter_swing_take   — zone-value run values
--   batter_batted_ball  — gb/fb/ld%, pull_air_rate
--   batter_baserunning  — first_to_third%, extra_base%, br_runs_above_avg
--   batter_sprint_speed — ft/s
--   batter_bvp          — vs this pitcher career
--   batter_splits       — hand/H-A/risp splits raw stat objects
--   batter_attack_angle — bat-tracking swing path
--   bullpen_vector      — opp bullpen HR/9, K-BB%, WHIP etc. (HRR signal)
--   pitcher_arm_angles  — release point, ball angle, shoulder
--   pitcher_running_game— hold-runner SB allowed rate
--   pitcher_active_spin — spin-efficiency per pitch type
alter table pick_signals add column if not exists raw_signals jsonb;

-- Every Adj/Mult/score component computed inside the model. The named ones already
-- bubble up via the model return (signals JSONB), but un-named locals don't.
-- This column stores them all in one place keyed by model name.
--
-- Example:
--   { hr: { score, pitcherMult, discMult, combinedPowerMult, fbVeloAllowanceMult,
--           pitBattedBallMult, pitContactQualityMult, pitArmAngleMult, ... },
--     hits: { ... }, tb: { ... }, hrr: { ... }, ks: { M1, M2, M3, ... } }
alter table pick_signals add column if not exists model_intermediates jsonb;

-- Pick-time game context: weather (temp, wind dir/mph, humidity), park HR factor,
-- park 2B/3B factor, HP umpire (name, K%, BB%, k_mult), day/night, dome, lineup
-- positions of predecessors, slate-level betting volume, etc.
--
-- Mining-side: these explain a meaningful chunk of variance that the model
-- only partially captures (parkMult is a single number — the actual park HAS
-- left/right asymmetry, alley distances, foul ground that aren't in one mult).
alter table pick_signals add column if not exists game_context jsonb;

-- GIN indexes on the JSONB columns so mining queries like
--   raw_signals->'pitcher_statcast'->>'gbPct' > 50
-- stay fast as the table grows.
create index if not exists pick_signals_raw_signals_gin       on pick_signals using gin (raw_signals);
create index if not exists pick_signals_model_intermediates_gin on pick_signals using gin (model_intermediates);
create index if not exists pick_signals_game_context_gin      on pick_signals using gin (game_context);

comment on column pick_signals.raw_signals        is 'Full raw Savant fetcher payloads at pick-time (pitcher_arsenal, batter_pitch_data, batter_power_stats, etc).';
comment on column pick_signals.model_intermediates is 'Every Adj/Mult/score component computed inside the model, keyed by model name. Wider than signals (which only carries named return fields).';
comment on column pick_signals.game_context       is 'Pick-time game context: weather, park, umpire, day/night, lineup predecessor stats.';
