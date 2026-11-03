#!/usr/bin/env node
/**
 * verify-scan-blob.mjs — confirm the day's daily_scan_results row actually landed.
 *
 * WHY THIS EXISTS. The scan-blob write is the single point of loss in the daily pipeline:
 * picks can save fine while the daily_scan_results upsert silently fails, and the gap is
 * permanent (7 of 14 game days lost through 2026-07-12 — docs/plumbing-audit-2026-07-13.md
 * P1). scripts/daily-picks.mjs exits 0 either way and brain-trust-snapshot soft-skips, so
 * nothing upstream catches it. This check fails the run instead, which fires the retry +
 * alert path in daily-picks.yml.
 *
 * WHY IT IS A SCRIPT AND NOT INLINE curl. It was six lines of `curl -sf` under `bash -e`
 * until 2026-08-28. That morning Supabase returned a 504 on this exact GET (edge_logs,
 * 06:06:27Z, inside a ~70 s window of 504/525 gateway errors), `curl -sf` exited 22, and
 * `set -e` killed the step with no message beyond "Process completed with exit code 22".
 * The row was present the whole time — the dispatched retry four minutes later found it
 * and passed. So a transient gateway blip was indistinguishable, in the log, from the
 * permanent data loss this check exists to catch. Two defects, both fixed here:
 *
 *   1. NO RETRY. A single 1-second request decided the fate of a check whose subject
 *      (a row already written hours earlier) cannot change while we poll. The window is
 *      now ~110 s across 6 attempts, which comfortably outlasts the blip that broke it.
 *   2. FAILURE MODES COLLAPSED. "row missing" and "could not ask" exited the same way
 *      with the same silence. They are now distinct exit codes and distinct ::error::
 *      messages, so the email tells you which one happened.
 *
 * Usage:
 *   node --env-file=.env.local scripts/verify-scan-blob.mjs
 *   node --env-file=.env.local scripts/verify-scan-blob.mjs --date=2026-08-27
 *
 * EXIT CODES — deliberately distinct (same reasoning as capacity-check.mjs: a red X you
 * are meant to interpret differently should not look identical):
 *
 *   0  row present, or no regular-season slate that day (nothing to save)
 *   1  row MISSING — real data gap, becomes permanent unless the slate is re-run today
 *   3  could not verify — Supabase unreachable/erroring after every retry
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Backoff schedule in seconds before attempts 1..6 (first is immediate). Sized against the
// 2026-08-28 outage: the 504/525 window ran 06:06:27 → 06:07:38 UTC, ~71 s. 110 s of total
// wall clock spans that with room to spare, and still costs nothing on the happy path.
const RETRY_DELAYS_S = [0, 5, 10, 20, 30, 45];

// Every request is bounded. A hung socket with no timeout is how the 2026-06-27 dry spell
// happened (see fetchJson's AbortController) — an unbounded fetch turns a slow gateway into
// a 25-minute job timeout, which reports as `cancelled` and reads like an infra kill.
const REQUEST_TIMEOUT_MS = 15_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * ET slate date for a given instant.
 *
 * Before 11 AM ET there is no row to demand: the app's auto-save useEffect gates on
 * etHour >= 11 (see scripts/daily-picks.mjs), so today's scan physically cannot exist yet.
 * A run landing here at 2 AM is the backstop cron delivered past midnight ET; its slate day
 * is YESTERDAY, and that is the row whose absence means a permanent gap. Demanding today's
 * row from such a run is what caused the guaranteed 2 AM ET failures on 2026-07-16/17.
 */
export function etSlateDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false,
  }).formatToParts(now).reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});

  // Intl renders midnight as hour "24" in some ICU versions; normalise before comparing.
  const hour = Number(parts.hour) % 24;
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  if (hour >= 11) return { date, hour, shifted: false };

  const prior = new Date(`${date}T12:00:00Z`);
  prior.setUTCDate(prior.getUTCDate() - 1);
  return { date: prior.toISOString().slice(0, 10), hour, shifted: true };
}

/**
 * Is this HTTP status worth trying again?
 *
 * Retrying an auth or schema error just delays a real diagnosis by two minutes, so those
 * are terminal. 5xx and the throttle/timeout family are the gateway class that broke this
 * check in the first place — 504 (gateway timeout) and 525 (Cloudflare could not complete
 * the TLS handshake to origin) both appeared in the 2026-08-28 window.
 */
export function isRetryableStatus(status) {
  if (status === 408 || status === 425 || status === 429) return true;
  return status >= 500;
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * How many regular-season games were scheduled on this ET date.
 *
 * gameType=R is load-bearing: unfiltered, the schedule counts exhibitions, and the All-Star
 * Game is one (gameType "A"). On 2026-07-14 raw totalGames was 1, so the zero-game guard did
 * not trip and the run failed demanding a scan for a slate that never existed.
 *
 * Returns null when the schedule API itself cannot be read. That is deliberately NOT fatal:
 * we still run the row check, because a missed alert costs a permanent data gap while a
 * false one costs an issue comment.
 */
async function scheduledGames(date) {
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&gameType=R`;
  for (const delay of [0, 5]) {
    if (delay) await sleep(delay * 1000);
    try {
      const res = await fetchWithTimeout(url);
      if (!res.ok) continue;
      const body = await res.json();
      if (typeof body?.totalGames === "number") return body.totalGames;
    } catch {
      // fall through to the next attempt
    }
  }
  return null;
}

/**
 * Ask whether the row exists, retrying only the gateway class.
 *
 * select=game_date only, limit=1: rows are ~2 MB jsonb, so never pull `results` — a full
 * row here hits the statement timeout. (The table has no `id` column; game_date is the
 * upsert key.)
 *
 * Resolves { ok: true, present } on a definitive answer, or { ok: false, reason } when
 * every attempt failed.
 */
async function rowExists(date) {
  const url = `${SUPABASE_URL}/rest/v1/daily_scan_results`
    + `?select=game_date&game_date=eq.${date}&limit=1`;
  const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };
  let last = "no attempt made";

  for (const [i, delay] of RETRY_DELAYS_S.entries()) {
    if (delay) await sleep(delay * 1000);
    try {
      const res = await fetchWithTimeout(url, { headers });

      if (res.ok) {
        const rows = await res.json();
        return { ok: true, present: Array.isArray(rows) && rows.length >= 1 };
      }

      const body = (await res.text().catch(() => "")).slice(0, 200);
      last = `HTTP ${res.status}${body ? ` — ${body}` : ""}`;
      if (!isRetryableStatus(res.status)) {
        return { ok: false, reason: last, attempts: i + 1, retryable: false };
      }
    } catch (err) {
      last = err?.name === "AbortError"
        ? `no response within ${REQUEST_TIMEOUT_MS / 1000}s`
        : String(err?.message || err);
    }
    console.log(`attempt ${i + 1}/${RETRY_DELAYS_S.length} failed: ${last}`);
  }

  return { ok: false, reason: last, attempts: RETRY_DELAYS_S.length, retryable: true };
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.log("::error::SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set — cannot verify the scan blob.");
    process.exit(3);
  }

  const override = process.argv.find((a) => a.startsWith("--date="))?.slice(7);
  const slate = override ? { date: override, shifted: false } : etSlateDate();
  if (slate.shifted) {
    console.log(`${slate.hour}:xx ET is before the app's 11 AM save gate — verifying prior slate day ${slate.date} instead.`);
  }

  const games = await scheduledGames(slate.date);
  if (games === 0) {
    console.log(`No regular-season MLB games on ${slate.date} — no scan expected, skipping check.`);
    process.exit(0);
  }
  const gamesLabel = games === null ? "schedule API unreachable" : `${games} games scheduled`;

  const result = await rowExists(slate.date);

  if (!result.ok) {
    // Two different sentences on purpose. "It kept timing out for two minutes" and "it
    // rejected the key instantly" want different first moves, and the failure email shows
    // little more than this line.
    const how = result.retryable
      ? `all ${result.attempts} attempts over ~${RETRY_DELAYS_S.reduce((a, b) => a + b, 0)}s failed`
      : "the request failed with an error that retrying cannot fix";
    console.log(`::error::Could NOT verify daily_scan_results for ${slate.date} — ${how}. Last error: ${result.reason}. This is an API-reachability failure, NOT a confirmed data gap; fix access or re-run this workflow to get a real answer.`);
    process.exit(3);
  }

  if (result.present) {
    console.log(`OK: daily_scan_results row exists for ${slate.date} (${gamesLabel}).`);
    process.exit(0);
  }

  console.log(`::error::daily_scan_results row MISSING for ${slate.date} (${gamesLabel}) — scan blob save failed. This gap becomes permanent if not re-run today.`);
  process.exit(1);
}

// Importable for tests; only the CLI entry point runs the check.
if (process.argv[1] && process.argv[1].endsWith("verify-scan-blob.mjs")) {
  await main();
}
