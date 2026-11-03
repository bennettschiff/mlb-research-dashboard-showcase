import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

import { startedGamePks } from './golden-snapshot.mjs'

// A Golden board is only worth anything if it was a FORWARD prediction. The job is
// scheduled for 12:30 PM ET to guarantee that, and GitHub does not honour the schedule:
// on 2026-08-28 the 16:30 UTC cron was still undelivered at 3:55 PM ET, while the same
// day's 7:30 AM ET morning-score cron landed at 3:35 PM ET — 8 hours late. A cron that
// arrives mid-slate used to rank players whose games were already in progress and hand
// those rows to forward grading as if they had been locked at noon, which corrupts the
// board-vs-board ROI series the whole surface exists to measure.

const SRC = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), 'golden-snapshot.mjs'), 'utf8',
)

const HOUR = 3600_000
const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString()

const game = (gamePk, abstractGameState, gameDate) => ({
  gamePk, gameDate, status: { abstractGameState },
})

const mockSchedule = (games) => {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ dates: [{ games }] }),
  })))
}

afterEach(() => vi.unstubAllGlobals())

describe('startedGamePks', () => {
  it('leaves games that have not started alone', async () => {
    mockSchedule([
      game(1, 'Preview', iso(4 * HOUR)),   // Scheduled
      game(2, 'Preview', iso(30 * 60_000)), // Pre-Game, first pitch in 30 min
    ])
    expect(await startedGamePks('2026-08-28')).toEqual(new Set())
  })

  it('catches games that are live or already final', async () => {
    mockSchedule([
      game(10, 'Live', iso(-2 * HOUR)),
      game(11, 'Final', iso(-6 * HOUR)),
      game(12, 'Preview', iso(3 * HOUR)),
    ])
    expect(await startedGamePks('2026-08-28')).toEqual(new Set(['10', '11']))
  })

  // StatsAPI's status trails first pitch by a few minutes, and those few minutes are
  // exactly when a delayed cron is most likely to land.
  it('catches a game whose start time has passed but whose status still says Preview', async () => {
    mockSchedule([game(20, 'Preview', iso(-5 * 60_000))])
    expect(await startedGamePks('2026-08-28')).toEqual(new Set(['20']))
  })

  // Returning null means "do not filter". A board built from a slate we could not inspect
  // is the pre-existing behaviour and is recoverable; no board at all is not.
  it('returns null when the schedule cannot be read', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503 })))
    expect(await startedGamePks('2026-08-28')).toBeNull()
  })

  it('returns null when the schedule fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ENOTFOUND') }))
    expect(await startedGamePks('2026-08-28')).toBeNull()
  })

  it('returns null on an empty slate rather than an empty filter', async () => {
    mockSchedule([])
    expect(await startedGamePks('2026-08-28')).toBeNull()
  })
})

describe('the filter is today-only', () => {
  // Load-bearing guard. Every game on a PAST date is Final, so applying this filter to a
  // reconstruction (--backfill, or re-running an old slate) drops 100% of the candidate
  // pool and writes nothing at all. Verified live on 2026-08-27, which still built from
  // all 1,568 candidates after this shipped.
  it('gates the started-game filter on the date being today', () => {
    const guard = /if \(date === todayET\(\)\) \{[\s\S]*?startedGamePks\(date\)/
    expect(
      guard.test(SRC),
      'the started-game filter must stay inside an `if (date === todayET())` guard — ' +
      'on any past date every game is Final, so filtering empties the pool and --backfill ' +
      'silently writes nothing.',
    ).toBe(true)
  })
})
