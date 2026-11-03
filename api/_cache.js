/**
 * api/_cache.js — Two-tier cache for server-side API responses.
 *
 *   L1: in-process memory (LRU, this serverless instance only) — sub-ms, free.
 *   L2: Supabase `api_cache` table — persistent across cold starts / instances.
 *
 * WHY TWO TIERS: the Supabase instance is shared across several apps (MLB / WNBA /
 * NFL + others) and gets Disk-IO-contended, so even an L2 cache HIT could take
 * seconds — which surfaced as "dry clicks / stale freeze" in the UI. L1 serves the
 * hot keys (the same statsapi/Savant URLs are requested across every panel) without
 * ever touching Postgres. L2 is kept ONLY for persistence — notably so the odds
 * cache survives cold starts and never forces api/odds.js to burn Odds API credits.
 *
 * Table schema (run setup/create-cache-table.sql in Supabase SQL editor once):
 *
 *   CREATE TABLE api_cache (
 *     key          text         PRIMARY KEY,
 *     data         text         NOT NULL,
 *     cache_date   date         NOT NULL DEFAULT CURRENT_DATE,
 *     fetched_at   timestamptz  NOT NULL DEFAULT NOW(),
 *     ttl_seconds  integer      NOT NULL DEFAULT 3600
 *   );
 *   CREATE INDEX api_cache_date_idx ON api_cache(cache_date);
 *
 * All functions are safe to call from any serverless function.
 * Non-fatal errors are swallowed so a cache failure never breaks a live request.
 */

const TABLE = "api_cache";

// ── L1 in-memory tier ─────────────────────────────────────────────────────────
// Module-level Map persists across requests on a warm (Fluid Compute) instance.
// LRU by insertion order: any access moves the key to the end; eviction drops the
// front. Entries are kept past expiry so a contended/unreachable L2 can be covered
// by a STALE in-memory copy (see cacheGet) rather than returning a miss.
// SIZED IN BYTES, NOT ENTRIES. The cap used to be 64 entries, which is far below the real
// working set: a full board sweep requests one statsapi gameLog per batter — ~300 distinct
// keys on a normal slate. L1 thrashed to a ~0% hit rate and every one of those fell through
// to L2, so a single board render pulled ~300 payloads out of TOAST on a 0.5 GB shared Nano.
// That is what exhausted the instance's Disk IO budget and OOM-wedged it on 2026-08-11
// (16:01 read storm → 522s → crash recovery; NRFI and the WNBA daily job both died on it).
//
// An entry cap cannot express this safely because payload sizes span two orders of magnitude:
// measured over the live table, mean 110 kB but max 3 MB. Sizing by count to fit the sweep
// (say 512) would admit a 1.5 GB worst case; sizing by bytes holds the whole sweep in the
// common case and degrades gracefully when a few giant Savant CSVs are resident.
const MAX_MEM_BYTES = 96 * 1024 * 1024; // ~870 mean-sized entries; safe inside a 1 GB function
const MAX_ENTRY_BYTES = 8 * 1024 * 1024; // never let one payload evict most of the cache
const STALE_MAX_MS = 24 * 3600 * 1000; // never serve a stale entry older than this
const L2_TIMEOUT_MS = 5000;            // bound every Supabase round-trip
const _mem = new Map(); // key → { data, expiresAt, storedAt, bytes }
let _memBytes = 0;

// ── L2 circuit breaker ────────────────────────────────────────────────────────
// A TIMEOUT-BOUNDED L2 is not the same as a HARMLESS one. When Postgres wedges —
// SERVE did it on 2026-08-25 and again on 08-29, both times answering the edge
// (401 in 80ms) while every real query hung — cacheGet still swallowed the error
// and returned a correct miss, so nothing "failed". It just cost L2_TIMEOUT_MS
// EVERY TIME, on both the read and the write.
//
// That tax is what turned "the database is slow" into "the app is broken":
// api/proxy.js budgets 5s cache + 15s upstream = 20s worst case, while the
// browser's _proxiedFetch aborts the whole attempt at 12s. On 08-29 every
// Rotowire lineup fetch blew that budget, fell through to the public CORS
// proxies (allorigins → corsproxy 403), and the board silently served PROJECTED
// lineups for games whose real cards were already posted. Nothing logged an
// error; the workflows stayed green.
//
// So: after CB_THRESHOLD consecutive L2 failures, stop calling L2 at all for
// CB_COOLDOWN_MS. Reads become instant L1-or-miss and go straight upstream;
// writes populate L1 only. One request per cooldown is let through as a probe
// (half-open), and any success closes the breaker immediately, so recovery is
// automatic and costs at most one timeout per minute.
const CB_THRESHOLD = 3;
const CB_COOLDOWN_MS = 60_000;
const _cb = { fails: 0, openUntil: 0 };

// True when L2 should be skipped entirely. Lets exactly one probe through once
// the cooldown lapses by re-arming the window before returning false.
function _l2Down() {
  if (!_cb.openUntil) return false;
  if (Date.now() < _cb.openUntil) return true;
  _cb.openUntil = Date.now() + CB_COOLDOWN_MS; // half-open: re-arm behind this probe
  return false;
}

function _l2Ok() {
  _cb.fails = 0;
  _cb.openUntil = 0;
}

function _l2Fail() {
  _cb.fails += 1;
  if (_cb.fails >= CB_THRESHOLD) _cb.openUntil = Date.now() + CB_COOLDOWN_MS;
}

// Test-only: the breaker is module state on a warm instance, so tests that
// exercise it need a way back to a known-good starting point.
export function _resetBreaker() {
  _cb.fails = 0;
  _cb.openUntil = 0;
}

function _memDelete(key) {
  const e = _mem.get(key);
  if (e) { _memBytes -= e.bytes; _mem.delete(key); }
}

function _memTouch(key, entry) {
  _memDelete(key);
  _mem.set(key, entry);
  _memBytes += entry.bytes;
  // LRU eviction from the front until we are back under budget.
  while (_memBytes > MAX_MEM_BYTES && _mem.size > 1) {
    const oldest = _mem.keys().next().value;
    if (oldest === key) break; // never evict the entry we just admitted
    _memDelete(oldest);
  }
}

function _memSet(key, data, ttlMs) {
  const bytes = typeof data === "string" ? data.length : 1024;
  // An oversized payload still serves this request; it just never becomes resident, so it
  // cannot flush the hundreds of small entries the sweep depends on.
  if (bytes > MAX_ENTRY_BYTES) { _memDelete(key); return; }
  const now = Date.now();
  _memTouch(key, { data, expiresAt: now + ttlMs, storedAt: now, bytes });
}

// Returns { data, fresh } if present and not beyond STALE_MAX, else undefined.
function _memLookup(key) {
  const e = _mem.get(key);
  if (!e) return undefined;
  const now = Date.now();
  // _memDelete, not _mem.delete — a raw delete would leak the entry's bytes from the
  // running total and shrink the effective cache toward zero over a long-lived instance.
  if (now - e.storedAt > STALE_MAX_MS) { _memDelete(key); return undefined; }
  _memTouch(key, e); // LRU bump
  return { data: e.data, fresh: now < e.expiresAt };
}

function supabaseHeaders() {
  const url = globalThis.process?.env?.SUPABASE_URL;
  const key = globalThis.process?.env?.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  return { url, headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" } };
}

async function _sbFetch(path, opts = {}) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), L2_TIMEOUT_MS);
  try {
    return await fetch(path, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(tid);
  }
}

/**
 * Read a cached value.
 * Returns the raw text string if a valid entry exists, else null.
 *
 * Order: fresh L1 → L2 (Supabase) → stale L1 (only when L2 is unreachable/slow).
 * The stale fallback is what guarantees a contended Supabase can never turn into
 * an Odds-API credit burn in api/odds.js: once a key is in memory it keeps serving.
 */
export async function cacheGet(key, ttlSeconds) {
  const mem = _memLookup(key);
  if (mem?.fresh) return mem.data; // fast path — no Postgres touched

  // L2 known-down → answer instantly from stale L1 or report a miss. Identical
  // to the catch below, minus the multi-second wait for a result we can predict.
  if (_l2Down()) return mem ? mem.data : null;

  try {
    const { url, headers } = supabaseHeaders();
    const encoded = encodeURIComponent(key);
    // Push the freshness test into the WHERE clause when the caller gave us a TTL. An expired
    // row then matches nothing, so Postgres never detoasts `data` and never ships it — the
    // miss costs one index probe instead of pulling a ~110 kB (occasionally 3 MB) payload off
    // a disk-IO-throttled instance purely to discover it was stale. Without a TTL we cannot
    // compute the cutoff, so fall back to reading the row and judging it client-side below.
    let filter = "";
    if (ttlSeconds != null) {
      const cutoff = new Date(Date.now() - ttlSeconds * 1000).toISOString();
      filter = `&fetched_at=gte.${encodeURIComponent(cutoff)}`;
    }
    const res = await _sbFetch(
      `${url}/rest/v1/${TABLE}?key=eq.${encoded}${filter}&select=data,fetched_at,ttl_seconds&limit=1`,
      { headers }
    );
    if (!res.ok) throw new Error(`api_cache read ${res.status}`);
    const rows = await res.json();
    _l2Ok(); // L2 answered — close the breaker even if the row was absent

    if (rows?.length) {
      const row = rows[0];
      const effectiveTtl = ttlSeconds ?? row.ttl_seconds ?? 3600;
      const ageMs = Date.now() - new Date(row.fetched_at).getTime();
      if (ageMs <= effectiveTtl * 1000) {
        const remainingMs = Math.max(0, effectiveTtl * 1000 - ageMs);
        _memSet(key, row.data, remainingMs); // promote into L1
        return row.data;
      }
    }
    // L2 reachable but entry absent/expired → a genuine miss.
    return null;
  } catch {
    // L2 unreachable/slow → serve a stale L1 copy if we have one (prevents the
    // miss from cascading into a live upstream/Odds-API call). Else null.
    _l2Fail();
    return mem ? mem.data : null;
  }
}

/**
 * Write a value to cache. Populates L1 immediately (sync) so the next read on this
 * instance is instant, then upserts L2 (timeout-bounded; non-fatal on failure).
 */
export async function cacheSet(key, data, ttlSeconds = 3600) {
  _memSet(key, data, ttlSeconds * 1000);
  // L1 is already populated, so a skipped L2 write costs this instance nothing.
  // Skipping it is the point: the write timeout is the SECOND L2_TIMEOUT_MS a
  // request pays during a wedge, and it lands after the upstream fetch has
  // already returned — pure added latency on a response that is ready to send.
  if (_l2Down()) return;
  try {
    const { url, headers } = supabaseHeaders();
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const res = await _sbFetch(`${url}/rest/v1/${TABLE}`, {
      method: "POST",
      headers: { ...headers, Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({
        key,
        data,
        cache_date: today,
        fetched_at: new Date().toISOString(),
        ttl_seconds: ttlSeconds,
      }),
    });
    // A non-2xx here is a real L2 failure. Without this the breaker could only
    // ever trip on reads, and a write-only caller (api/odds.js credit logging)
    // would keep paying the full timeout against a dead database.
    if (!res.ok) throw new Error(`api_cache write ${res.status}`);
    _l2Ok();
  } catch {
    // Non-fatal — L1 still holds the value for this instance.
    _l2Fail();
  }
}

/**
 * Delete all cache rows that are NOT from today (ET).
 * Called at the top of the morning cron to keep the table lean.
 */
export async function wipePreviousDays() {
  try {
    const { url, headers } = supabaseHeaders();
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    await _sbFetch(`${url}/rest/v1/${TABLE}?cache_date=lt.${today}`, {
      method: "DELETE",
      headers,
    });
  } catch {
    // Non-fatal
  }
}

/**
 * Fetch a URL server-side (no CORS) with standard browser-like headers.
 * Returns raw text or null on error/timeout.
 */
export async function serverFetch(url, timeoutMs = 15_000) {
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,text/plain,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    clearTimeout(tid);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/**
 * Like serverFetch, but also returns The Odds API credit headers
 * (x-requests-used / x-requests-remaining) so callers can log credit burn.
 * Returns { text, creditsUsed, creditsRemaining }; text is null on error/timeout
 * but the credit fields may still be present if the response arrived non-OK.
 */
export async function serverFetchWithCredits(url, timeoutMs = 15_000) {
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,text/plain,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    clearTimeout(tid);
    const usedH = res.headers.get("x-requests-used");
    const remH  = res.headers.get("x-requests-remaining");
    return {
      text: res.ok ? await res.text() : null,
      creditsUsed:      usedH != null ? parseInt(usedH, 10) : null,
      creditsRemaining: remH  != null ? parseInt(remH, 10)  : null,
    };
  } catch {
    return { text: null, creditsUsed: null, creditsRemaining: null };
  }
}
