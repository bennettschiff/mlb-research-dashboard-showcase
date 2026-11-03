import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, utimesSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncTodo } from './date-archive.mjs'
import { needsRefresh, pullIfStale, REFRESH_AFTER_MS } from './archive.mjs'

// 2026-09-23: readIndex pulled the Drive index only when the local copy was MISSING,
// so a long-lived checkout froze at 09-14 while Drive held through 09-21.
describe('needsRefresh', () => {
  const now = Date.parse('2026-09-23T12:00:00Z')

  it('pulls when the local copy is missing', () => {
    expect(needsRefresh({ exists: false, mtimeMs: 0, now })).toBe(true)
  })
  it('keeps a copy checked within the window', () => {
    expect(needsRefresh({ exists: true, mtimeMs: now - 60_000, now })).toBe(false)
    expect(needsRefresh({ exists: true, mtimeMs: now - REFRESH_AFTER_MS, now })).toBe(false)
  })
  it('re-pulls a copy older than the window', () => {
    expect(needsRefresh({ exists: true, mtimeMs: now - REFRESH_AFTER_MS - 1, now })).toBe(true)
    expect(needsRefresh({ exists: true, mtimeMs: now - 9 * 86_400_000, now })).toBe(true)
  })
})

describe('pullIfStale', () => {
  const setup = (ageMs) => {
    const p = join(mkdtempSync(join(tmpdir(), 'pis-')), 'idx')
    writeFileSync(p, 'old')
    const t = new Date(Date.now() - ageMs)
    utimesSync(p, t, t)
    return p
  }

  it('does not pull a fresh copy', () => {
    const p = setup(60_000)
    let pulls = 0
    pullIfStale(p, () => { pulls++ }, 'test')
    expect(pulls).toBe(0)
  })

  it('re-pulls a stale copy and resets its clock (rclone stamps the Drive modtime)', () => {
    const p = setup(REFRESH_AFTER_MS + 60_000)
    pullIfStale(p, () => {
      writeFileSync(p, 'new')
      const drive = new Date(Date.now() - REFRESH_AFTER_MS - 3_600_000)
      utimesSync(p, drive, drive)
    }, 'test')
    expect(readFileSync(p, 'utf8')).toBe('new')
    expect(Date.now() - statSync(p).mtimeMs).toBeLessThan(60_000)
  })

  it('falls back to the stale copy when the refresh fails', () => {
    const p = setup(REFRESH_AFTER_MS + 60_000)
    expect(() => pullIfStale(p, () => { throw new Error('offline') }, 'test')).not.toThrow()
    expect(readFileSync(p, 'utf8')).toBe('old')
  })

  it('still throws when a first pull fails', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'pis-')), 'missing')
    expect(() => pullIfStale(p, () => { throw new Error('offline') }, 'test')).toThrow('offline')
  })
})

// The nightly panel sync decides which Postgres dates to export. 2026-09-15: the
// weekly as-of refresh wrote 09-08..09-11 for the first time, the 3-day sync window
// (since 09-12) never exported them, verify refused the prune and the backup went red.

describe('syncTodo', () => {
  const since = '2026-09-12'

  it('re-pulls every date inside the window, even ones Drive already has', () => {
    const db = ['2026-09-12', '2026-09-13', '2026-09-14']
    expect(syncTodo(db, new Set(db), since)).toEqual(db)
  })

  it('also pulls older Postgres dates that Drive is missing (late backfill)', () => {
    const db = ['2026-09-07', '2026-09-08', '2026-09-11', '2026-09-12', '2026-09-14']
    const drive = new Set(['2026-09-07', '2026-09-12'])
    expect(syncTodo(db, drive, since)).toEqual(['2026-09-08', '2026-09-11', '2026-09-12', '2026-09-14'])
  })

  it('never re-pulls an old date Drive already holds — the Postgres copy may be a partial re-fold', () => {
    const db = ['2026-04-01', '2026-05-01']
    expect(syncTodo(db, ['2026-04-01', '2026-05-01'], since)).toEqual([])
  })

  it('accepts the Drive listing as an array', () => {
    expect(syncTodo(['2026-09-01'], [], since)).toEqual(['2026-09-01'])
  })
})
