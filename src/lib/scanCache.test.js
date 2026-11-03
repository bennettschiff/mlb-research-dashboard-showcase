import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { gunzipSync } from 'zlib'
import { gzipToBase64, postScanResults, isScanCacheable, loadCachedScan } from './scanCache.js'

describe('isScanCacheable', () => {
  it('caches the 1-game slate that broke 2026-07-16 (Mets @ Phillies, ~20 batters, 2 pitchers)', () => {
    expect(isScanCacheable({ gameCount: 1, batters: 20, pitchers: 2, hourET: 12 })).toBe(true)
  })

  it('is unchanged on a normal full slate — still needs 40 batters / 3 pitchers', () => {
    expect(isScanCacheable({ gameCount: 15, batters: 400, pitchers: 15, hourET: 12 })).toBe(true)
    expect(isScanCacheable({ gameCount: 15, batters: 39, pitchers: 15, hourET: 12 })).toBe(false)
    expect(isScanCacheable({ gameCount: 15, batters: 400, pitchers: 2, hourET: 12 })).toBe(false)
  })

  it('never caches an empty slate, even with a vacuous 0 >= 0', () => {
    expect(isScanCacheable({ gameCount: 0, batters: 0, pitchers: 0, hourET: 12 })).toBe(false)
  })

  it('still refuses a half-finished short-slate scan', () => {
    expect(isScanCacheable({ gameCount: 1, batters: 0, pitchers: 0, hourET: 12 })).toBe(false)
  })

  it('keeps the pre-10am ET hold-off', () => {
    expect(isScanCacheable({ gameCount: 15, batters: 400, pitchers: 15, hourET: 2 })).toBe(false)
  })
})

const VERCEL_BODY_CAP = 4.5 * 1024 * 1024

/** Stand-in for a full-slate scan: repetitive like the real blob, so it gzips like it. */
function fakeScan(players = 400) {
  return {
    players: Array.from({ length: players }, (_, i) => ({
      playerId: 100000 + i,
      name: `Player ${i}`,
      models: { hits: { score: 8.1, prob: 0.51 }, hr: { score: 3.2, prob: 0.09 } },
      advancedStats: { xwoba: 0.331, barrel_rate: 7.8, hard_hit: 41.2, ev: 89.4 },
    })),
    pitchers: Array.from({ length: 30 }, (_, i) => ({ playerId: 200000 + i, xK: 5.4 })),
  }
}

describe('gzipToBase64', () => {
  it('round-trips through the same inflate path api/scan-results.js uses', async () => {
    const original = { hello: 'world', nested: [1, 2, 3] }
    const b64 = await gzipToBase64(JSON.stringify(original))
    const inflated = JSON.parse(gunzipSync(Buffer.from(b64, 'base64')).toString('utf8'))
    expect(inflated).toEqual(original)
  })

  it('keeps a full-slate payload under Vercel\'s 4.5 MB body cap', async () => {
    const json = JSON.stringify(fakeScan())
    const b64 = await gzipToBase64(json)
    // The regression this guards: raw JSON straddles the cap, compressed must not.
    expect(b64.length).toBeLessThan(VERCEL_BODY_CAP)
    expect(b64.length).toBeLessThan(json.length) // actually compressed
  })
})

describe('postScanResults', () => {
  let errSpy
  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  const payload = { date: '2026-07-16', results: fakeScan(20), player_count: 20 }

  it('sends results_gz, not raw results, and stays JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true })
    await postScanResults(payload, { fetchImpl })

    const [url, opts] = fetchImpl.mock.calls[0]
    expect(url).toBe('/api/scan-results')
    expect(opts.headers['Content-Type']).toBe('application/json')

    const body = JSON.parse(opts.body)
    expect(body.results_gz).toBeTruthy()
    expect(body.results).toBeUndefined()
    expect(body.date).toBe('2026-07-16')
    // Server must be able to inflate exactly what we send.
    expect(JSON.parse(gunzipSync(Buffer.from(body.results_gz, 'base64')).toString('utf8')))
      .toEqual(payload.results)
  })

  it('reports a 413 instead of swallowing it (the silence that hid this for weeks)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 413, text: async () => 'too large' })
    expect(await postScanResults(payload, { fetchImpl })).toBe(false)
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('413'))
  })

  it('reports a network failure and never throws into the scan', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('offline'))
    await expect(postScanResults(payload, { fetchImpl })).resolves.toBe(false)
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('offline'))
  })

  it('returns true on success', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true })
    expect(await postScanResults(payload, { fetchImpl })).toBe(true)
  })
})

// The point of the two-phase load is that a rejected mount never pays for the
// ~5.2 MB blob, so every guard test below asserts on WHICH endpoints were
// called, not just on the return value. A guard that still fetches the blob is
// a guard that costs 5.2 MB of egress to say no.
describe('loadCachedScan — guards run before the blob is fetched', () => {
  const DATE = '2026-09-04'
  const GOOD_META = {
    found: true, date: DATE, scanned_at: '2026-09-04T16:30:00Z',
    player_count: 219, version: '1', stale: false,
    batter_count: 219, pitcher_count: 32,
  }
  const BLOB = { found: true, results: { players: [{ id: 1 }], pitchers: [] }, player_count: 219, scanned_at: GOOD_META.scanned_at }

  /** @returns fetchApiJson spy serving `meta` on ?meta=1 and `blob` otherwise */
  function api(meta, blob = BLOB) {
    return vi.fn(async (path) => (path.includes('meta=1') ? meta : blob))
  }
  const picksSaved = vi.fn().mockResolvedValue([{ id: 1 }])
  const savedPicksParams = (d, o) => `pick_date=eq.${d}&limit=${o.limit}`
  const blobCalls = (f) => f.mock.calls.filter(([p]) => !p.includes('meta=1')).length

  it('fetches the blob exactly once when every guard passes', async () => {
    const fetchApiJson = api(GOOD_META)
    const out = await loadCachedScan({ date: DATE, fetchApiJson, sbGet: picksSaved, savedPicksParams })
    expect(out?.results).toEqual(BLOB.results)
    expect(out?.player_count).toBe(219)
    expect(blobCalls(fetchApiJson)).toBe(1)
  })

  it('never fetches the blob when nothing is cached', async () => {
    const fetchApiJson = api({ found: false, date: DATE })
    expect(await loadCachedScan({ date: DATE, fetchApiJson, sbGet: picksSaved, savedPicksParams })).toBeNull()
    expect(blobCalls(fetchApiJson)).toBe(0)
  })

  // Guard 0 — the 2026-06-10 / 06-12 / 07-22 capture-nulling regression.
  it('never fetches the blob when the day’s picks are not saved yet', async () => {
    const fetchApiJson = api(GOOD_META)
    const noPicks = vi.fn().mockResolvedValue([])
    expect(await loadCachedScan({ date: DATE, fetchApiJson, sbGet: noPicks, savedPicksParams })).toBeNull()
    expect(blobCalls(fetchApiJson)).toBe(0)
  })

  it('still accepts the cache when the picks lookup itself fails', async () => {
    const fetchApiJson = api(GOOD_META)
    const broken = vi.fn().mockRejectedValue(new Error('offline'))
    expect(await loadCachedScan({ date: DATE, fetchApiJson, sbGet: broken, savedPicksParams })).not.toBeNull()
  })

  it('never fetches the blob for a stale scan', async () => {
    const fetchApiJson = api({ ...GOOD_META, stale: true })
    expect(await loadCachedScan({ date: DATE, fetchApiJson, sbGet: picksSaved, savedPicksParams })).toBeNull()
    expect(blobCalls(fetchApiJson)).toBe(0)
  })

  it('never fetches the blob for a scan taken before 10am ET', async () => {
    // 12:30 UTC = 8:30 AM ET
    const fetchApiJson = api({ ...GOOD_META, scanned_at: '2026-09-04T12:30:00Z' })
    expect(await loadCachedScan({ date: DATE, fetchApiJson, sbGet: picksSaved, savedPicksParams })).toBeNull()
    expect(blobCalls(fetchApiJson)).toBe(0)
  })

  it('keeps guard 3 at 40 batters / 3 pitchers, off the RPC counts', async () => {
    const thin = api({ ...GOOD_META, batter_count: 39, pitcher_count: 32 })
    expect(await loadCachedScan({ date: DATE, fetchApiJson: thin, sbGet: picksSaved, savedPicksParams })).toBeNull()
    expect(blobCalls(thin)).toBe(0)

    const fewP = api({ ...GOOD_META, batter_count: 219, pitcher_count: 2 })
    expect(await loadCachedScan({ date: DATE, fetchApiJson: fewP, sbGet: picksSaved, savedPicksParams })).toBeNull()
    expect(blobCalls(fewP)).toBe(0)

    const edge = api({ ...GOOD_META, batter_count: 40, pitcher_count: 3 })
    expect(await loadCachedScan({ date: DATE, fetchApiJson: edge, sbGet: picksSaved, savedPicksParams })).not.toBeNull()
  })

  it('never fetches the blob for a foreign scan version', async () => {
    const fetchApiJson = api({ ...GOOD_META, version: '2' })
    expect(await loadCachedScan({ date: DATE, fetchApiJson, sbGet: picksSaved, savedPicksParams })).toBeNull()
    expect(blobCalls(fetchApiJson)).toBe(0)
  })

  it('falls back to the browser scan when the blob arrives empty', async () => {
    const fetchApiJson = api(GOOD_META, { found: true, results: null })
    expect(await loadCachedScan({ date: DATE, fetchApiJson, sbGet: picksSaved, savedPicksParams })).toBeNull()
  })
})
