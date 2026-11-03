# MLB Research Dashboard

A daily MLB player and game research dashboard: projections, matchup context,
odds from four sportsbooks, and a self-grading ledger that settles every
prediction against the box score the next morning.

**Live:** https://schiffpicks.com · React 19 · Vite · Vercel serverless · Supabase Postgres · GitHub Actions

> **About this repository.** This is a public showcase copy of a private repo
> with 760+ commits. It contains the real UI, API routes, schema, CI, and test
> suite. **The production prediction model and its calibration are private.**
> `src/lib/models.js` here is a structural stand-in: same exports and output
> shapes, simple textbook math (Bayesian rate blending + Poisson/Normal pricing),
> neutral context multipliers and illustrative constants. Research notes,
> backtests, tuning scripts, and git history are not included.

<!-- Screenshot: add docs/screenshot.png (board view) and uncomment
![MLB Research Dashboard](docs/screenshot.png)
-->

## What it does

- **Daily slate board.** For every batter and starting pitcher on the day's
  slate it projects hits, total bases, HR, H+R+RBI, RBI, stolen bases and
  strikeouts, then prices each against the posted lines.
- **Player panels.** Statcast profile, pitch-arsenal matchup, splits, recent
  form, park and weather context, all in one drill-down.
- **Game markets.** Moneyline, run line, totals and a first-inning (NRFI/YRFI)
  model.
- **Self-grading ledger.** Every board row is snapshotted before first pitch
  (a headless Playwright run of the live app),
  settled from the official box score the next morning, and rolled into
  calibration, CLV (closing-line value) and ROI views. The app tells you when
  the model is wrong, not just when it's right.
- **Promotion pipeline.** Proposed changes to pick thresholds run as a
  shadow slate on out-of-sample games before they go live, and the UI shows
  the full history of promotions, failures and reverts. (This copy ships a
  synthetic sample of that history.)

## Architecture

```
            ┌────────────── GitHub Actions (cron) ───────────────┐
            │ daily-picks · morning-score · closing-odds · backup │
            └───────────────┬──────────────────────┬─────────────┘
                            │ HTTP (CRON_SECRET)   │ service role
                            ▼                      ▼
 Browser ──► Vercel ── /api/*  (16 serverless functions) ──► Supabase Postgres
 (React SPA)            odds · picks · cron · proxy · …        (RLS on, ledger +
                        server-side keys only                   scan snapshots)
                            │                                       │ nightly
                            ▼                                       ▼
                 MLB StatsAPI · Statcast · The Odds API     Google Drive cold archive
```

More detail in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

A few engineering decisions worth pointing at:

| Area | Where to look |
|---|---|
| Keeping paid API keys and DB write credentials out of the browser | [`api/odds.js`](api/odds.js), [`api/picks.js`](api/picks.js), [`api/_auth.js`](api/_auth.js) |
| A read-through cache with a circuit breaker for flaky upstreams | [`api/_cache.js`](api/_cache.js) + tests |
| Schedule-aware freshness checks (an off-day reads IDLE, not broken) | [`api/_freshness.js`](api/_freshness.js) |
| Settlement that agrees between the UI and the ledger to the cent | [`src/lib/settlement.js`](src/lib/settlement.js), [`src/lib/results.js`](src/lib/results.js) |
| Hot/cold storage: 14 days in Postgres, everything else archived to Drive and verified before any prune | [`scripts/lib/archive.mjs`](scripts/lib/archive.mjs), [`.github/workflows/backup-to-drive.yml`](.github/workflows/backup-to-drive.yml) |
| Ops: failure alerts that open/dedupe GitHub issues and auto-retry runner flakes | [`.github/workflows/ops-alert.yml`](.github/workflows/ops-alert.yml) |
| Deterministic tripwires that catch silent pipeline rot (replaced a ~$14/run LLM audit) | [`scripts/plumbing-tripwire.mjs`](scripts/plumbing-tripwire.mjs) |
| A tracked-files secret scanner that runs first in CI | [`scripts/scan-secrets.mjs`](scripts/scan-secrets.mjs) |

## Running it

```bash
npm ci
npm test        # 650+ unit tests, no network or keys needed
npm run build
npm run dev     # UI at http://localhost:5173
```

The UI loads live data through the `/api` routes, so a local run without
credentials renders the shell but no slate. Copy `.env.example` to
`.env.local` and run under `vercel dev` to bring up the API locally.

## Repository layout

```
src/            React app (components/, lib/ for pure logic + tests)
api/            Vercel serverless functions
scripts/        Scheduled jobs (snapshot, grade, archive, health checks)
db/migrations/  Postgres schema for the ledger tables
.github/        CI + scheduled workflows (manual-only in this copy)
```

## License

All rights reserved. The code is published for viewing and evaluation; see [LICENSE](LICENSE).
