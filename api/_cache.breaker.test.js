/**
 * api/_cache.breaker.test.js — the L2 circuit breaker.
 *
 * WHAT THIS PROTECTS. SERVE wedged on 2026-08-25 and 2026-08-29. Both times
 * cacheGet behaved "correctly": it caught the failure and returned a miss. It
 * just took L2_TIMEOUT_MS to do it, on every read AND every write, for the whole
 * duration of the outage.
 *
 * That latency — not any error — is what broke the app. api/proxy.js budgets 5s
 * of cache plus 15s of upstream, and the browser aborted the whole attempt at
 * 12s, so every Rotowire lineup fetch blew its budget and the board silently
 * served PROJECTED lineups for games whose real cards were already posted.
 *
 * So the property under test is not "errors are swallowed" (they always were).
 * It is "a dead L2 stops being CONSULTED", which is the part that makes a
 * database outage survivable instead of app-wide.
 *
 * These tests use a stubbed global.fetch rather than the network, and separate
 * "L2 is down" from "L2 says no" — the breaker must trip on the first and never
 * on the second, or an ordinary cold cache would disable L2 for everyone.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

let cacheGet, cacheSet, _resetBreaker;
let fetchCalls;

beforeEach(async () => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv("SUPABASE_URL", "http://localhost:0");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-key");
  fetchCalls = [];
  ({ cacheGet, cacheSet, _resetBreaker } = await import("./_cache.js"));
  _resetBreaker();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** L2 is unreachable: every call rejects, the way an aborted timeout does. */
function stubDeadL2() {
  vi.stubGlobal("fetch", (...args) => {
    fetchCalls.push(args[0]);
    return Promise.reject(new Error("The operation was aborted due to timeout"));
  });
}

/** L2 is healthy but holds nothing — an ordinary cold cache. */
function stubEmptyL2() {
  vi.stubGlobal("fetch", (...args) => {
    fetchCalls.push(args[0]);
    return Promise.resolve({ ok: true, status: 200, json: async () => [] });
  });
}

describe("a dead L2 stops being consulted", () => {
  it("trips after 3 consecutive failures and then skips Postgres entirely", async () => {
    stubDeadL2();

    // Threshold is 3, so the first three misses must still try L2 — a breaker
    // that opened on one failure would disable the cache on a single blip.
    for (let i = 0; i < 3; i++) await cacheGet(`k${i}`, 60);
    expect(fetchCalls.length).toBe(3);

    // Breaker is now open. These must not reach the network at all: this is the
    // multi-second-per-request tax that broke lineup fetches during the wedge.
    for (let i = 0; i < 25; i++) await cacheGet(`later${i}`, 60);
    expect(fetchCalls.length).toBe(3);
  });

  it("skips the L2 write too, and still populates L1", async () => {
    stubDeadL2();
    for (let i = 0; i < 3; i++) await cacheGet(`k${i}`, 60);
    const afterTrip = fetchCalls.length;

    await cacheSet("hot", "value", 3600);
    expect(fetchCalls.length).toBe(afterTrip); // no write attempted

    // L1 is the point of the write — a skipped L2 must not cost this instance
    // its cache, or the breaker would trade one outage for another.
    expect(await cacheGet("hot", 3600)).toBe("value");
  });

  it("serves a stale L1 copy instantly while L2 is written off", async () => {
    stubEmptyL2();
    await cacheSet("stale", "old-value", 1); // 1s TTL
    stubDeadL2();

    vi.useFakeTimers();
    vi.advanceTimersByTime(5000); // expire it, but stay inside STALE_MAX_MS
    for (let i = 0; i < 3; i++) await cacheGet(`trip${i}`, 60);
    const afterTrip = fetchCalls.length;

    // Expired in L1 and L2 is off: the stale fallback must still answer, because
    // the alternative is a live upstream call (in api/odds.js, a burned credit).
    expect(await cacheGet("stale", 1)).toBe("old-value");
    expect(fetchCalls.length).toBe(afterTrip);
  });
});

describe("the breaker recovers on its own", () => {
  it("lets one probe through after the cooldown and closes on success", async () => {
    stubDeadL2();
    for (let i = 0; i < 3; i++) await cacheGet(`k${i}`, 60);
    const afterTrip = fetchCalls.length;

    await cacheGet("blocked", 60);
    expect(fetchCalls.length).toBe(afterTrip); // still open

    // Recovery must not need a deploy or a human. After the cooldown the next
    // call is a probe; L2 is healthy again, so the breaker closes and normal
    // traffic resumes.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 61_000);
    stubEmptyL2();

    await cacheGet("probe", 60);
    expect(fetchCalls.length).toBe(afterTrip + 1); // probe went through

    await cacheGet("after", 60);
    expect(fetchCalls.length).toBe(afterTrip + 2); // breaker closed
  });
});

describe("an ordinary cache miss never trips the breaker", () => {
  it("keeps consulting L2 through a long run of empty results", async () => {
    stubEmptyL2();
    // A cold cache returns [] forever. Treating that as an L2 failure would
    // disable Postgres for every caller on a fresh deploy — the breaker must
    // distinguish "L2 is down" from "L2 says no".
    for (let i = 0; i < 20; i++) await cacheGet(`cold${i}`, 60);
    expect(fetchCalls.length).toBe(20);
  });
});
