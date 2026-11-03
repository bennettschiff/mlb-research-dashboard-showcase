/**
 * api/scan-results.js — Daily scan results cache
 *
 * GET  /api/scan-results?date=YYYY-MM-DD
 *   → Returns today's pre-computed scan results from daily_scan_results, or null.
 *   → The React app checks this on load — if fresh results exist, skip the browser scan.
 *
 * POST /api/scan-results
 *   Body: { date, player_count, version, results | results_gz }
 *   → Saves scan results to daily_scan_results (upsert by date).
 *   → Called automatically when the browser scan completes, or by Supabase Edge Function.
 *
 *   `results_gz` (preferred) is gzipped JSON, base64'd. A full slate slims to
 *   4.4-5.5 MB of raw JSON, which straddles Vercel's 4.5 MB request-body cap —
 *   over it the platform rejects the POST with 413 FUNCTION_PAYLOAD_TOO_LARGE
 *   before this handler ever runs, so no amount of server-side handling helps.
 *   That silently cost 7 of 14 game days through 7/12 and every day 7/10-7/16.
 *   gzip takes 5.5 MB → 0.51 MB (~91% smaller); base64 brings it to ~0.68 MB,
 *   leaving ~6x headroom so ordinary payload growth can't quietly re-cross it.
 *   Base64-inside-JSON keeps Content-Type: application/json, so the body still
 *   arrives pre-parsed and we avoid Vercel's raw-body/bodyParser edge cases.
 *   `results` (plain) is still accepted for older clients and small payloads.
 *
 * Auth: POST requires CRON_SECRET in Authorization header (same as cron.js).
 *       GET is open (results are not sensitive and come through the app password gate).
 */

import { gunzipSync } from "zlib";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function todayET() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retry budget. The upsert writes a ~5 MB jsonb and normally lands in ~2s
// (observed mean 1.9s, max 6.2s), but Postgres' statement_timeout is 120s, so a
// single stalled attempt can burn most of the function's 300s maxDuration. We
// therefore refuse to *start* an attempt that can't finish inside the budget
// rather than retrying a fixed number of times: fast transient failures (a
// Cloudflare 5xx in front of Supabase) still get all 3 attempts, while a
// 120s statement timeout gets exactly one retry and returns a real error
// instead of being killed mid-write by the platform.
const RETRY_DEADLINE_MS = 150_000;

// Retries 5xx/network the same way the daily panel scripts do (see
// scripts/player-day-panel.mjs). 4xx is a real query/auth error → fail fast.
// Retrying the POST is safe: it's an upsert keyed on game_date with
// resolution=merge-duplicates, so a re-send is idempotent even if a timed-out
// attempt actually committed.
async function sbRequest(method, path, body) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (method === "POST" || method === "PATCH") {
    headers["Prefer"] = "return=minimal,resolution=merge-duplicates";
  }
  const payload = body ? JSON.stringify(body) : undefined;
  const startedAt = Date.now();
  let lastErr;

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0 && Date.now() - startedAt > RETRY_DEADLINE_MS) break;
    try {
      const res = await fetch(url, { method, headers, body: payload });
      if (res.ok) return method === "GET" ? res.json() : null;
      const text = await res.text().catch(() => "");
      const err = new Error(
        `Supabase ${method} ${path}: ${res.status} ${text.slice(0, 200)}`
      );
      if (res.status < 500) throw err;   // bad query/auth → retrying won't help
      lastErr = err;
    } catch (e) {
      if (e instanceof Error && /: 4\d\d /.test(e.message)) throw e;
      lastErr = e;                        // transient network failure → retry
    }
    if (attempt < 2) {
      console.warn(
        `[scan-results] ${method} ${path} attempt ${attempt + 1} failed, retrying: ${lastErr?.message}`
      );
      await sleep(500 * (attempt + 1));
    }
  }
  throw lastErr;
}

export default async function handler(req, res) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set" });
  }

  // ── GET: return today's cached scan results ──────────────────────────────────
  if (req.method === "GET") {
    const date = req.query?.date || todayET();

    // ?meta=1 — everything the app's cache-first guards need EXCEPT the blob.
    //
    // The row is ~5.2 MB of jsonb and the guards that decide whether to use it
    // read six scalars. Fetching the blob to compute a boolean cost ~165 MB of
    // Supabase egress a day (measured 2026-09-04→05, 32 full-blob GETs) on an
    // org that had just exceeded the free plan's quota. scan_result_meta
    // (db/migrations/017) computes the two array lengths inside Postgres, so
    // the minimum-player-count guard keeps its exact thresholds instead of
    // being approximated from player_count. 144 bytes vs 5.2 MB.
    if (req.query?.meta === "1") {
      // GET, not POST, on the RPC: sbRequest sends `Prefer: return=minimal` on
      // every POST (it exists for the upsert below), which makes PostgREST
      // answer 204 with no body. scan_result_meta is declared STABLE, so
      // PostgREST accepts it over GET and the shared retry path works as-is.
      try {
        const rows = await sbRequest(
          "GET",
          `rpc/scan_result_meta?p_date=${encodeURIComponent(date)}`
        );
        const row = rows?.[0];
        if (!row) return res.status(200).json({ found: false, date });
        const ageHours = (Date.now() - new Date(row.scanned_at).getTime()) / 3_600_000;
        return res.status(200).json({
          found: true,
          date: row.game_date,
          scanned_at: row.scanned_at,
          player_count: row.player_count,
          version: row.version,
          stale: ageHours > 8,
          batter_count: row.batter_count,
          pitcher_count: row.pitcher_count,
        });
      } catch (e) {
        console.error("[scan-results GET meta]", e.message);
        return res.status(200).json({ found: false, error: e.message });
      }
    }

    try {
      const rows = await sbRequest(
        "GET",
        `daily_scan_results?game_date=eq.${date}&select=game_date,scanned_at,player_count,version,results`
      );
      if (!rows || rows.length === 0) {
        return res.status(200).json({ found: false, date });
      }
      const row = rows[0];
      // Treat results as stale if scanned more than 8 hours ago
      const scannedAt = new Date(row.scanned_at);
      const ageHours = (Date.now() - scannedAt.getTime()) / 3_600_000;
      return res.status(200).json({
        found: true,
        date: row.game_date,
        scanned_at: row.scanned_at,
        player_count: row.player_count,
        version: row.version,
        stale: ageHours > 8,
        results: row.results,
      });
    } catch (e) {
      console.error("[scan-results GET]", e.message);
      return res.status(200).json({ found: false, error: e.message });
    }
  }

  // ── POST: save scan results ──────────────────────────────────────────────────
  // No auth required — scan results are not sensitive (prop recommendations only).
  // The app itself is password-gated. Browser writes populate the cache for other users.
  if (req.method === "POST") {

    let body;
    try {
      body = typeof req.body === "object" ? req.body : JSON.parse(req.body);
    } catch {
      return res.status(400).json({ error: "Invalid JSON body" });
    }

    const { date, results_gz, player_count, version = "1" } = body;
    let { results } = body;

    if (!results && results_gz) {
      try {
        results = JSON.parse(gunzipSync(Buffer.from(results_gz, "base64")).toString("utf8"));
      } catch (e) {
        console.error("[scan-results POST] results_gz inflate failed:", e.message);
        return res.status(400).json({ error: `results_gz not valid gzipped JSON: ${e.message}` });
      }
    }

    if (!date || !results) {
      return res.status(400).json({ error: "date and results (or results_gz) required" });
    }

    try {
      await sbRequest("POST", "daily_scan_results?on_conflict=game_date", {
        game_date:    date,
        scanned_at:   new Date().toISOString(),
        results,
        player_count: player_count || (Array.isArray(results) ? results.length : null),
        version,
      });
      console.log(`[scan-results] Saved ${player_count || "?"} players for ${date}`);
      return res.status(200).json({ ok: true, date, player_count });
    } catch (e) {
      console.error("[scan-results POST]", e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  res.status(405).json({ error: "Method not allowed" });
}
