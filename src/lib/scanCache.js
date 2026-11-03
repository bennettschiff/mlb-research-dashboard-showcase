// ── Scan-cache upload ────────────────────────────────────────────────────────
// The daily scan blob is the substrate for backtests (alt-line-backtest,
// calibrate-retune, backfill_pick_signals), and a day lost here is permanent —
// the scan cannot be reconstructed after the fact.
//
// Even after slimScanResults(), a full slate serializes to 4.4-5.5 MB, which
// straddles Vercel's 4.5 MB request-body cap. Over the cap the platform returns
// 413 FUNCTION_PAYLOAD_TOO_LARGE before api/scan-results.js runs at all, so the
// write is unfixable server-side. Because slate size varies day to day, the
// payload crossed the line only some days — which is exactly why this read as
// flaky rather than broken, and why 7 of 14 game days were lost through 7/12.
//
// gzip takes 5.5 MB → ~0.51 MB (~91% smaller, measured on the 7/7 blob); base64
// brings it to ~0.68 MB, leaving ~6x headroom under the cap. Base64-inside-JSON
// keeps Content-Type: application/json so the body still arrives pre-parsed on
// Vercel — no raw-body/bodyParser edge cases.

/**
 * Should this scan be written to the cache?
 *
 * Guards against caching a stale/interrupted scan that would poison other users'
 * loads. The thresholds were fixed at 40 batters / 3 pitchers, which silently
 * assumed a full ~15-game slate. On 2026-07-16 — 1 game (Mets @ Phillies), the
 * first day back from the All-Star break — the scan yielded ~20 batters and 2
 * pitchers, so the gate could never pass, the POST never fired, and
 * daily-picks.yml failed demanding a scan the app would never save.
 *
 * Scaling off gameCount reproduces the old 40/3 exactly for any slate of 4+
 * games while letting genuinely short slates through.
 */
export function isScanCacheable({ gameCount, batters, pitchers, hourET }) {
  if (!gameCount || gameCount < 1) return false; // empty slate: nothing to cache
  const minBatters = Math.max(1, Math.min(40, gameCount * 12));
  const minPitchers = Math.max(1, Math.min(3, gameCount));
  return batters >= minBatters && pitchers >= minPitchers && hourET >= 10;
}

/** gzip a string and base64 it. Returns null if the platform lacks CompressionStream. */
export async function gzipToBase64(str) {
  if (typeof CompressionStream !== "function") return null;

  const stream = new Blob([str]).stream().pipeThrough(new CompressionStream("gzip"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());

  // Chunked: String.fromCharCode(...bytes) blows the argument limit on ~500 KB.
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * POST a scan payload to /api/scan-results, gzipped when possible.
 * Never throws — the scan itself must not fail on a cache-write problem — but,
 * unlike the previous `.catch(() => {})`, it reports failures. Silence here is
 * what let the 413 run for weeks unnoticed.
 *
 * @returns {Promise<boolean>} true when the row was accepted.
 */
export async function postScanResults(payload, { fetchImpl = fetch } = {}) {
  const { date, results, player_count, version = "1" } = payload;
  try {
    const resultsJson = JSON.stringify(results);
    const gz = await gzipToBase64(resultsJson);

    const body = gz
      ? JSON.stringify({ date, results_gz: gz, player_count, version })
      : JSON.stringify({ date, results, player_count, version });

    if (!gz) {
      console.warn("[scan-results] CompressionStream unavailable — posting uncompressed; may 413 over 4.5 MB");
    }

    const res = await fetchImpl("/api/scan-results", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    if (!res.ok) {
      const detail = res.status === 413
        ? "413 payload too large — gzipped body still exceeded Vercel's 4.5 MB cap"
        : `${res.status} ${await res.text().catch(() => "")}`.slice(0, 200);
      console.error(`[scan-results] save FAILED for ${date}: ${detail}. This gap is permanent.`);
      return false;
    }
    console.log(`[scan-results] saved ${date} (${player_count} players, ${gz ? `${(gz.length / 1048576).toFixed(2)} MB gzip+b64` : "uncompressed"})`);
    return true;
  } catch (e) {
    console.error(`[scan-results] save FAILED for ${payload?.date}: ${e?.message || e}. This gap is permanent.`);
    return false;
  }
}

// ── Scan-cache load ──────────────────────────────────────────────────────────
//
// The mount-time "can I skip the browser scan?" decision. It used to live inline
// in App.jsx and opened by fetching the whole cached row — a ~5.2 MB jsonb blob —
// before running five guards over it. Four of those guards only ever read
// metadata, and the fifth (minimum viable player counts) needs two array
// lengths. So every mount that failed a guard — which is most of them, since the
// cache is refused outright until the day's picks are saved — moved 5.2 MB to
// reach a boolean.
//
// Measured over 2026-09-04→05 that was 32 full-blob GETs, ~165 MB/day, the
// largest single consumer of a Supabase free-plan egress quota the org had just
// exceeded. The guards now run against /api/scan-results?meta=1 (144 bytes, see
// db/migrations/017_scan_result_meta.sql) and the blob is fetched only once they
// have all passed.
//
// The guards themselves are unchanged — same order, same thresholds; only the
// point at which the payload arrives moved. Each is an independent predicate
// that ends the load, so evaluating them before the fetch rather than after
// cannot change which loads are accepted.

/** Hour-of-day in ET for an ISO timestamp. 12 (safe to accept) if unparseable. */
function hourET(iso) {
  if (!iso) return 12;
  try {
    const h = parseInt(new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", hour: "2-digit", hour12: false,
    }).format(new Date(iso)), 10);
    return Number.isNaN(h) ? NaN : h;
  } catch {
    return 12;
  }
}

/**
 * Decide whether the cached scan for `date` is usable, and fetch it if so.
 *
 * @param {object}   opts
 * @param {string}   opts.date              slate date, YYYY-MM-DD (app timezone)
 * @param {Function} opts.fetchApiJson      (path, fallback) => Promise<any>
 * @param {Function} opts.sbGet             (table, params) => Promise<rows>
 * @param {Function} opts.savedPicksParams  (date, opts) => PostgREST params
 * @returns {Promise<{results:object, player_count:number, scanned_at:string}|null>}
 *          null whenever the browser must run its own scan.
 */
export async function loadCachedScan({ date, fetchApiJson, sbGet, savedPicksParams }) {
  const meta = await fetchApiJson(`/api/scan-results?date=${date}&meta=1`, null);
  if (!meta?.found) return null; // nothing cached

  // ── Guard 0: today's picks not saved yet → force a fresh scan ──────────────
  // The cached payload is slimmed (extraSignals stripped, see slimScanResults),
  // so a save fired from cache-loaded data writes NULL raw_signals/
  // model_intermediates/game_context for the whole day. This silently nulled
  // capture on 2026-06-10 and 2026-06-12: any browser that scans after 10 AM ET
  // seeds the cache, and the headless save run then loads slim data. Only accept
  // the cache once the day's picks (and their sidecars) exist. savedPicksParams
  // excludes cron-owned prop_types (nrfi): its cron writes a row around 11 AM ET
  // with no sidecars, which made this guard accept the slim cache and null the
  // day's capture again (2026-07-22).
  try {
    const saved = await sbGet("mlb_picks", savedPicksParams(date, { limit: 1 }));
    if (Array.isArray(saved) && saved.length === 0) {
      console.log("⚡ Scan cache skipped — today's picks not saved yet (full-fidelity scan required for signal capture)");
      return null;
    }
  } catch { /* on lookup failure, fall through to cache (display-only risk) */ }

  // ── Guard 1: staleness (>8 hours old) ─────────────────────────────────────
  if (meta.stale) return null;

  // ── Guard 2: scanned before 10am ET (prior-night game logs not finalized) ──
  const scannedHourET = hourET(meta.scanned_at);
  if (Number.isNaN(scannedHourET) || scannedHourET < 10) return null;

  // ── Guard 3: minimum viable player counts (reject interrupted scans) ──────
  if ((meta.batter_count ?? 0) < 40 || (meta.pitcher_count ?? 0) < 3) return null;

  // ── Guard 4: version must match current scan format ───────────────────────
  if (meta.version && meta.version !== "1") return null;

  // ── All guards passed — now, and only now, pay for the blob ───────────────
  const full = await fetchApiJson(`/api/scan-results?date=${date}`, null);
  if (!full?.found || !full.results) return null;

  return {
    results: full.results,
    player_count: full.player_count ?? meta.player_count,
    scanned_at: full.scanned_at ?? meta.scanned_at,
  };
}
