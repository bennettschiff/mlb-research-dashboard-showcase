/**
 * api/_cache.test.js — L1 tier accounting.
 *
 * The 2026-08-11 outage was an L1 sizing bug: a 64-ENTRY cap against a ~300-key board sweep
 * meant L1 never hit, every read fell through to L2, and several hundred TOAST payloads came
 * off a 0.5 GB shared Nano per render until it OOM-wedged. The cap is now in BYTES, and these
 * tests pin the two properties that make that fix hold:
 *
 *   1. a realistic sweep stays fully resident (the actual regression), and
 *   2. the running byte total never drifts from the map's real contents — a leak would shrink
 *      the effective cache toward zero over a long-lived warm instance and silently
 *      reintroduce the outage without changing a single line of the eviction code.
 *
 * No network: only the memory tier is exercised, via cacheGet's fresh-L1 fast path, which
 * returns before it ever builds a Supabase request.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const KB = 1024;
const MB = 1024 * KB;

// These are memory-pressure tests, not unit tests: each deliberately pushes ~100 MB through
// the cache to breach its budget, which takes seconds, and the full suite runs 29 files in
// parallel so they contend for CPU. vitest's 5s default left them passing locally and timing
// out in CI. Generous and explicit beats fast and flaky.
const SLOW = 30_000;

let cacheGet, cacheSet;

beforeEach(async () => {
  vi.resetModules();
  vi.unstubAllEnvs();
  // supabaseHeaders() throws without these; the fast paths under test never reach it, but a
  // miss would otherwise throw inside cacheGet's try and mask a real failure as a null.
  vi.stubEnv("SUPABASE_URL", "http://localhost:0");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-key");
  ({ cacheGet, cacheSet } = await import("./_cache.js"));
});

/**
 * Distinct payload of an exact byte length (1 char = 1 byte, matching _memSet's .length).
 *
 * The filler is built ONCE and sliced, rather than padEnd-ing a fresh multi-MB string per
 * call. These tests deliberately push ~100 MB through the cache to breach its budget, and
 * rebuilding the filler each time made the suite allocation-bound: it ran at 4.3–4.7s
 * against vitest's 5s default and so passed locally but timed out in CI. A test whose
 * result depends on machine load is not evidence of anything.
 */
const FILLER = "x".repeat(1 * MB);
const payload = (bytes, tag) => (tag + FILLER).slice(0, bytes);

describe("L1 holds a realistic board sweep", () => {
  it("keeps ~300 mean-sized gameLog payloads resident", { timeout: SLOW }, async () => {
    // The access pattern that broke: one statsapi gameLog per batter, ~110 kB each (measured
    // mean over the live api_cache table). Under the old 64-entry cap the first ~240 of these
    // were evicted before the sweep finished and every one became an L2 TOAST read.
    const N = 300;
    for (let i = 0; i < N; i++) {
      await cacheSet(`gamelog:${i}`, payload(110 * KB, `p${i}`), 3600);
    }
    for (let i = 0; i < N; i++) {
      expect(await cacheGet(`gamelog:${i}`, 3600), `key ${i} evicted`).toBe(
        payload(110 * KB, `p${i}`)
      );
    }
  });
});

describe("byte accounting does not drift", () => {
  it("re-setting one key repeatedly does not shrink capacity", { timeout: SLOW }, async () => {
    // If _memTouch double-counted on overwrite, the running total would climb without bound
    // and evict everything else — the cache would appear to work, then quietly stop holding
    // anything. Overwrite one key many times, then confirm a full sweep still fits.
    //
    // 220 × 512 kB = 112 MB of phantom usage against the 96 MB budget, so a double-count
    // breaches it and evicts the sweep below. Sized to clear the budget with margin while
    // moving a fifth of the bytes the first version did.
    for (let i = 0; i < 220; i++) {
      await cacheSet("hot", payload(512 * KB, `v${i}`), 3600);
    }
    for (let i = 0; i < 200; i++) {
      await cacheSet(`other:${i}`, payload(110 * KB, `o${i}`), 3600);
    }
    for (let i = 0; i < 200; i++) {
      expect(await cacheGet(`other:${i}`, 3600), `key ${i} evicted`).toBe(
        payload(110 * KB, `o${i}`)
      );
    }
  });

  it("expiring a stale entry returns its bytes to the budget", { timeout: SLOW }, async () => {
    // _memLookup drops entries past STALE_MAX_MS. Doing that with a raw _mem.delete would
    // leak the bytes: the total stays high forever while the map is empty, so the next sweep
    // gets evicted against phantom usage.
    // The stale set must be large enough that leaking it actually breaches MAX_MEM_BYTES —
    // otherwise the leaked total still leaves room for the sweep and the test passes against
    // the bug. 95 MB leaked + 22 MB of fresh entries = 117 MB against a 96 MB budget, so a
    // leak evicts most of the sweep. (Verified by mutation: reverting _memDelete to a raw
    // _mem.delete fails this test. An earlier 60 MB version did not.)
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 95; i++) {
        await cacheSet(`old:${i}`, payload(1 * MB, `s${i}`), 1);
      }
      vi.advanceTimersByTime(25 * 3600 * 1000); // past STALE_MAX_MS
      // Touch each one so _memLookup runs its stale-eviction branch and settles the budget.
      for (let i = 0; i < 95; i++) await cacheGet(`old:${i}`, 1);

      for (let i = 0; i < 200; i++) {
        await cacheSet(`fresh:${i}`, payload(110 * KB, `f${i}`), 3600);
      }
      for (let i = 0; i < 200; i++) {
        expect(await cacheGet(`fresh:${i}`, 3600), `key ${i} evicted`).toBe(
          payload(110 * KB, `f${i}`)
        );
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a single giant payload cannot flush the sweep", () => {
  it("keeps small entries resident when an oversized one arrives", { timeout: SLOW }, async () => {
    // Savant CSVs run to several MB. Admitting one must not cost hundreds of small entries.
    for (let i = 0; i < 200; i++) {
      await cacheSet(`small:${i}`, payload(110 * KB, `s${i}`), 3600);
    }
    await cacheSet("huge", payload(9 * MB, "H"), 3600); // over MAX_ENTRY_BYTES

    for (let i = 0; i < 200; i++) {
      expect(await cacheGet(`small:${i}`, 3600), `key ${i} evicted`).toBe(
        payload(110 * KB, `s${i}`)
      );
    }
  });
});
