-- 009_golden_boards.sql — Golden 10 becomes three tracked boards.
--
-- The single Golden 10 ranked saved official picks by goldenScore (0.6*conf +
-- 0.4*prob), which never looked at price: 76% of its slots went to Hits O0.5 at
-- an average of -238 (breakeven 69.2%) for -5.2% ROI over 57 days at a 63.8% win
-- rate. It is replaced by three boards over the Brain Trust per-line surface —
-- 'likely', 'lines' and 'value' (see src/lib/goldenBoards.js).
--
-- golden_snapshots was one row per date. It becomes one row per (date, board).
-- Existing rows are preserved under board = 'legacy' so the historical Golden 10
-- record stays intact and queryable rather than being silently reinterpreted as
-- one of the new boards — the selection math is different, so those rows are NOT
-- comparable to 'likely'.

ALTER TABLE golden_snapshots
  ADD COLUMN IF NOT EXISTS board text NOT NULL DEFAULT 'legacy';

-- Repoint the primary key from (pick_date) to (pick_date, board).
ALTER TABLE golden_snapshots DROP CONSTRAINT IF EXISTS golden_snapshots_pkey;
ALTER TABLE golden_snapshots ADD PRIMARY KEY (pick_date, board);

-- New writes must name a known board; 'legacy' stays valid so the old rows and
-- any re-run of the retired writer remain insertable.
ALTER TABLE golden_snapshots DROP CONSTRAINT IF EXISTS golden_snapshots_board_chk;
ALTER TABLE golden_snapshots ADD CONSTRAINT golden_snapshots_board_chk
  CHECK (board IN ('likely', 'lines', 'value', 'legacy'));

-- The Results page reads "yesterday, all boards" on every load.
CREATE INDEX IF NOT EXISTS golden_snapshots_date_board_idx
  ON golden_snapshots (pick_date DESC, board);

COMMENT ON COLUMN golden_snapshots.board IS
  'likely | lines | value (src/lib/goldenBoards.js), or legacy for pre-2026-08-06 single-board goldenScore snapshots.';
