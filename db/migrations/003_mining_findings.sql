-- ============================================================================
-- 003_mining_findings.sql
-- Findings store for the mining cron — one row per (cycle × market × feature × type).
-- Lets us track signal lifecycle: when it emerged, whether the effect is stable,
-- whether it's been promoted into the model, whether it's gone stale.
--
-- Run in Supabase SQL Editor.
-- ============================================================================

create table if not exists mining_findings (
  id            bigserial primary key,
  -- Cycle context
  cycle_id      text         not null,      -- 'YYYY-MM-DD' (one cycle = one mining-cron run)
  run_at        timestamptz  not null default now(),
  -- Pattern context
  market        text         not null,      -- 'hits' | 'hr' | 'tb' | 'hrr' | 'sb' | 'rbi' | 'ks' | 'ml' | 'rl' | 'ou'
  finding_type  text         not null,      -- 'univariate' | 'interaction' | 'cluster' | 'calibration' | 'drift'
  feature       text         not null,      -- dotted feature name, e.g. 'rawPitBarrelPct' or 'rawXslg×rawPitFbPct'
  -- Effect
  n             integer      not null,      -- sample size used
  effect_size   numeric(10,5),               -- spread (univariate), lift (interaction), max-cluster-rate (cluster), abs(slope) (calibration)
  direction     text,                       -- 'high' | 'low' | 'high-low' | 'low-high' etc.
  p_value       numeric(10,8),
  q_value       numeric(10,8),               -- BH-FDR adjusted
  monotonic     boolean,                    -- univariate only — strict Q1→Q4 ordering
  -- Lifecycle
  status        text         not null default 'active',   -- 'active' | 'stale' | 'promoted' | 'rejected'
  first_seen    date,                       -- first cycle_id this finding appeared at q < threshold
  last_seen     date,                       -- most recent cycle_id confirming it
  prior_effect  numeric(10,5),               -- effect size from previous cycle (for drift detection)
  effect_delta  numeric(10,5),               -- effect_size - prior_effect (signed)
  -- Raw analysis output for drill-down
  raw_data      jsonb,                      -- {quartile_cash:[...], correlation:..., cluster_profile:...}
  -- Notes / human review
  notes         text
);

create unique index if not exists mining_findings_cycle_market_feature_type_idx
  on mining_findings (cycle_id, market, finding_type, feature);
create index if not exists mining_findings_market_idx        on mining_findings (market);
create index if not exists mining_findings_q_value_idx       on mining_findings (q_value);
create index if not exists mining_findings_status_idx        on mining_findings (status);
create index if not exists mining_findings_last_seen_idx     on mining_findings (last_seen);
create index if not exists mining_findings_finding_type_idx  on mining_findings (finding_type);

comment on table  mining_findings is 'Living catalog of statistical patterns discovered by the daily mining cron. One row per (cycle × market × feature × type). Status tracks signal lifecycle from emergence → promotion → staleness.';
comment on column mining_findings.cycle_id      is 'YYYY-MM-DD of the mining run that produced this finding.';
comment on column mining_findings.finding_type  is 'univariate (Q1-Q4 spread), interaction (pairwise lift), cluster (k-means subgroup rate), calibration (model accuracy by predicted bucket), drift (signal predictive power decay).';
comment on column mining_findings.q_value       is 'Benjamini-Hochberg FDR-adjusted p-value. q < 0.05 = significant after multiple-comparison correction.';
comment on column mining_findings.status        is 'active = still significant in latest cycle. stale = dropped below threshold for 7+ days. promoted = wired into models.js. rejected = manually dismissed.';
comment on column mining_findings.effect_delta  is 'Current effect minus prior cycle effect. Large negative values flag drifting/decaying signals.';
