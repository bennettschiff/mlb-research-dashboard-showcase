-- 017 — scan_result_meta: answer "should I use the cached scan?" without
-- shipping the scan.
--
-- The app's cache-first mount effect fetched the whole daily_scan_results row —
-- a ~5.2 MB jsonb blob — and then ran five guards over it, four of which only
-- ever read metadata (found / stale / scanned_at / version) and one of which
-- (minimum viable player counts) needs nothing but two array lengths. Every
-- mount that failed a guard, which is most of them before the day's picks are
-- saved, moved 5.2 MB to reach a boolean.
--
-- Measured 2026-09-04→05: 32 full-blob GETs in 24 h = ~165 MB of Supabase
-- egress per day, the single largest line item on an org that had just blown
-- through the free plan's 5 GB/mo quota.
--
-- This RPC returns the guard inputs — ~200 bytes — so the blob is fetched only
-- once the guards have already said yes. jsonb_array_length is computed inside
-- Postgres against the stored jsonb, so guard 3 keeps its exact semantics
-- (>= 40 batters, >= 3 pitchers) rather than being weakened to a player_count
-- approximation.
--
-- jsonb_typeof guard: jsonb_array_length() raises on a non-array, and an
-- interrupted or pre-slim payload can leave `players` absent or an object. A
-- missing key must read as 0 and fail the guard, not error the whole load.
create or replace function public.scan_result_meta(p_date date)
returns table (
  game_date     date,
  scanned_at    timestamptz,
  player_count  integer,
  version       text,
  batter_count  integer,
  pitcher_count integer
)
language sql
stable
parallel safe
as $$
  select
    d.game_date,
    d.scanned_at,
    d.player_count,
    d.version,
    (case when jsonb_typeof(d.results -> 'players')  = 'array'
          then jsonb_array_length(d.results -> 'players')  else 0 end)::integer,
    (case when jsonb_typeof(d.results -> 'pitchers') = 'array'
          then jsonb_array_length(d.results -> 'pitchers') else 0 end)::integer
  from public.daily_scan_results d
  where d.game_date = p_date;
$$;

comment on function public.scan_result_meta(date) is
  'Guard inputs for the app''s scan-cache load (see src/lib/scanCache.js loadCachedScan) without transferring the ~5 MB results blob.';
