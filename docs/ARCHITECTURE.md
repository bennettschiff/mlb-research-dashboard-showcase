# Architecture

The dashboard is one of five sport dashboards (MLB, NFL, NBA, WNBA, NHL) that
share a data platform: one Supabase project for the ledger, one odds-API
credit budget split across sports, a shared header and ops pattern, and a
shared visual system. This document covers the MLB app.

## Daily lifecycle

```
 pre-game                       game time                    next morning
 ────────                       ─────────                    ────────────
 daily-picks.yml                cron-pings.yml (every 30m)   morning-score.yml
  └ snapshot the slate:          ├ refresh lineups            └ settle every row
    projections, odds,           └ capture closing prices       from the box score
    model output → Postgres                                   closing-odds.yml
                                                              └ CLV vs. close
                                                              backup-to-drive.yml
                                                              └ archive + verify + prune
```

1. **Snapshot before first pitch.** `scripts/daily-picks.mjs` opens the
   deployed app in headless Playwright and lets the page's own scan-and-save
   path run, so the ledger is written by exactly the code users see. One
   model, two runners: the browser and the server-side scripts import the
   same `src/lib` modules, so the board and the ledger agree to the decimal.
2. **Capture the close.** Closing prices are captured progressively during
   the day; CLV (did the price move toward us?) is the early signal that a
   model is sharp, long before win rate is.
3. **Settle.** `scripts/backfill-scores.mjs` pulls box scores and grades
   every pending row with the same stat formulas the UI uses. Pushes, voids and unpriced rows follow one shared settlement
   function (`src/lib/settlement.js`).
4. **Archive.** Postgres keeps a 14-day hot window. Everything older is
   appended to compressed JSONL on Google Drive, **verified row-for-row
   against Postgres**, and only then pruned. A failed verify skips the
   prune, so nothing is deleted that is not already archived.

## Storage

| Store | Holds | Why |
|---|---|---|
| Supabase Postgres (RLS on) | Ledger, scan snapshots, 14-day hot window | Queried by the UI and API |
| Google Drive (rclone) | Full history as dated `.jsonl.gz` | Free-tier egress and disk limits made Postgres the wrong place for cold data |
| Build-time JSON | Gate overrides, promotion history | Changes ship as a commit, so every gate change has a diff and a deploy |

## API layer

Vercel serverless functions under `api/`. The rules:

- Paid keys (`ODDS_API_KEY`) and the service-role key exist only server-side.
- Writes require auth (`api/_auth.js`); reads are cached (`api/_cache.js`)
  with a circuit breaker, so a slow upstream degrades to stale data instead of
  an error page.
- Several views are folded into one function by `?view=` because the hosting
  plan caps the number of functions per project.

## Operations

- **CI** (`ci.yml`): secret scan of every tracked file, the unit suite, a
  static check that every job reading the cold archive installs rclone, and
  the production build.
- **Ops alert** (`ops-alert.yml`): any scheduled workflow failure opens (or
  comments on) one deduplicated GitHub issue, and transient runner failures
  are retried automatically.
- **Plumbing tripwire** (`scripts/plumbing-tripwire.mjs`): deterministic
  checks, twice a day, for the failures that silently degrade a model, such
  as a column the model reads that the API stopped selecting, a table whose
  ETL stopped, or a field that is populated in the database but arrives null
  on the pick. It replaced a paid LLM audit that cost about $14 a run.
- **Uptime** (`uptime.yml`): all five sport dashboards, plus the auth
  endpoint, every 12 hours.

In this public copy every scheduled workflow is manual-only, so a fork never
fires a job without secrets.

## What is not in this copy

The production model, its calibration and fitted parameters, the research
lab (feature mining, backtests, threshold sweeps, analyst digests) and the
git history. `src/lib/models.js`, `src/lib/nrfiParams.json`,
`src/lib/gateOverrides.json` and `src/fixtures/` contain stand-ins or
synthetic data so that everything else builds, renders and tests.
