-- Add Odds API credit tracking columns to daily_odds.
-- Run once in Supabase SQL Editor.

ALTER TABLE daily_odds
  ADD COLUMN IF NOT EXISTS odds_credits_used      INTEGER,
  ADD COLUMN IF NOT EXISTS odds_credits_remaining INTEGER;
