// Supabase access for the browser, routed through /api/picks so the service
// role key never reaches the client. Lives here (rather than inside App.jsx)
// so extracted components can read and write without importing back into App
// and creating a cycle — the same reason accessCodeHeader moved in 2026-08.
import { accessCodeHeader } from "./utils.js";

// Per-tab cache-buster. Appended to every request so a hard reload always asks
// our server again instead of reading a stale edge/browser copy.
export const APP_LOAD_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export function apiFreshUrl(path) {
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}_load=${APP_LOAD_ID}`;
}

// ── Error bodies are not error messages ──────────────────────────────────────
//
// This used to `throw new Error(await res.text())`, which is fine while the
// failure is a PostgREST JSON error and catastrophic when it isn't. On
// 2026-08-25 the SERVE database wedged: Postgres stopped answering, Cloudflare
// held the request 90s and returned its 522 interstitial, api/picks wrapped that
// whole HTML page as { error: "<!DOCTYPE html>…" }, and App's `catch(e)
// setPicksError(e.message)` painted four kilobytes of Cloudflare markup across
// the Results tab. The database being down is expected occasionally; the page
// looking like it crashed is not.
//
// So: every failure is reduced to one line a person can act on, and the raw body
// goes to the console for whoever actually needs it.

const CF_CODES = {
  520: "Supabase returned an unknown error",
  521: "the Supabase database is down",
  522: "the Supabase database stopped responding (connection timed out)",
  523: "Supabase is unreachable",
  524: "the Supabase query ran too long and timed out",
};

/**
 * Reduce an upstream failure to one short, honest sentence.
 *
 * @param status HTTP status from /api/picks
 * @param body   raw response text (JSON error envelope, HTML, or plain text)
 */
export function describeApiError(status, body) {
  const raw = String(body ?? "").trim();

  // api/picks wraps everything as { error: <upstream message> }, so unwrap one
  // layer before deciding what we're looking at — the interesting part is inside.
  let inner = raw;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.error === "string" && parsed.error) {
      inner = parsed.error.trim();
    } else if (parsed && typeof parsed === "object") {
      // PostgREST's own shape: { message, details, hint, code }. The hint is the
      // half that tells you what to do, so it rides along.
      const detail = [parsed.message, parsed.hint].filter(Boolean).join(" — ");
      if (detail) inner = detail;
    }
  } catch { /* not JSON — fall through with the raw text */ }

  // A Cloudflare interstitial. The status code inside it is the real signal;
  // the surrounding 4 KB of markup is noise in every case.
  if (/^<(!doctype|html)/i.test(inner) || /cf-error-details|cloudflare/i.test(inner)) {
    const code = Number(inner.match(/Error code (\d{3})/i)?.[1]);
    const why = CF_CODES[code];
    if (why) return `Database unreachable — ${why} (Cloudflare ${code}). The app will work again once it recovers; nothing was saved.`;
    const title = inner.match(/<title>([^<]{0,120})<\/title>/i)?.[1]?.trim();
    return `Database unreachable — ${title || `upstream returned HTTP ${status}`}.`;
  }

  if (!inner) return `Request failed (HTTP ${status}).`;
  // Anything else: one line, capped. A legitimate PostgREST error is short and
  // survives this untouched.
  const oneLine = inner.replace(/\s+/g, " ");
  return oneLine.length > 300 ? `${oneLine.slice(0, 300)}…` : oneLine;
}

// Nothing here had a timeout, so a wedged database held every call open for the
// full 90 seconds Cloudflare waits before giving up — the Results tab spun on
// "0 picks tracked" that whole time and only then showed an error. Reads get a
// short leash; writes get a long one, because saving a full slate of picks is
// genuinely slower than reading one and must not be cut off mid-save.
// (Same reasoning and the same AbortController shape as fetchJson in utils.js.)
export const SB_READ_TIMEOUT_MS = 20_000;
export const SB_WRITE_TIMEOUT_MS = 45_000;

export async function sbFetch(query = "", opts = {}) {
  const qs = query ? `?query=${encodeURIComponent(query)}` : "";
  const method = opts.method || "GET";
  const budget = method === "GET" ? SB_READ_TIMEOUT_MS : SB_WRITE_TIMEOUT_MS;
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), budget);
  let res;
  try {
    res = await fetch(apiFreshUrl(`/api/picks${qs}`), {
      ...opts,
      cache: "no-store",
      signal: opts.signal ?? ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
        ...accessCodeHeader(),
        ...(opts.headers || {}),
      },
    });
  } catch (e) {
    if (e?.name === "AbortError" && !opts.signal) {
      // Flagged so callers can tell "we gave up waiting" apart from "the server
      // answered and said no". Only the former is worth retrying — see
      // sbGetAllPages below.
      throw Object.assign(
        new Error(
          `Database did not respond within ${budget / 1000}s — the request was cancelled` +
          `${method === "GET" ? "." : " and may or may not have been saved."}`
        ),
        { timedOut: true }
      );
    }
    throw e;
  } finally {
    clearTimeout(tid);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // The full body still goes somewhere — just not into the UI.
    console.warn(`[supa] ${opts.method || "GET"} /api/picks ${res.status}:`, body.slice(0, 2000));
    throw new Error(describeApiError(res.status, body));
  }
  return res.status === 204 ? null : res.json();
}

// The `table` argument is vestigial — /api/picks is single-table — but every
// call site reads better with it, so it stays and is deliberately ignored.
export function sbGet(table, params = "") {
  void table;
  return sbFetch(params);
}

// ── Reading a whole table from a tab that is also running a scan ─────────────
//
// PostgREST hard-caps every response at 1000 rows (Supabase's db-max-rows), so
// the full pick history can only arrive as a sequence of pages. Measured
// against production on 2026-09-04 that is 7 pages, ~3.3 MB (~340 KB on the
// wire), and about 4 seconds of actual server time — a request that finishes in
// half a second has no business tripping a 20-second leash.
//
// It tripped anyway, and the Results tab read "0 picks tracked · 0 graded"
// behind a red banner. The leash is wall-clock from the moment fetch() is
// called, and during a scan the tab is saturated: batches of ~70 concurrent
// upstream fetches, hundreds of /api/proxy invocations, and long synchronous
// model math between them. A page can spend its entire budget waiting for the
// tab rather than for the database. The old loop had no retry and no partial
// result, so losing that race once threw the other six pages away too.
//
// The leash itself stays as it is — a genuinely wedged database must not hold
// the tab open (SB_READ_TIMEOUT_MS, 2026-08-25). Two things change:
//
//   • A timed-out page is retried with backoff, which also gives the burst that
//     starved it time to drain. Only timeouts retry: if the server answered at
//     all — Cloudflare 522, a PostgREST error — it has told us something true
//     and hammering it just delays the banner the user needs to see.
//   • Whatever did arrive is kept. Pages come back newest-first, so a partial
//     load is a contiguous run of the most recent picks: worth showing, as long
//     as it is labelled as partial rather than passed off as the whole history.

export const PAGE_SIZE = 1000;            // PostgREST's cap, not a choice
export const PAGE_RETRY_DELAYS_MS = [2_000, 6_000];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Read every row matching `params`, one PostgREST page at a time.
 *
 * Never throws: returns `{ rows, complete, error }` so a caller that got six of
 * seven pages can render six pages instead of nothing.
 *
 * @param table   passed through to sbGet (vestigial — see below)
 * @param params  PostgREST params WITHOUT limit/offset, e.g. "order=id.desc"
 */
export async function sbGetAllPages(table, params = "", {
  pageSize = PAGE_SIZE,
  retryDelays = PAGE_RETRY_DELAYS_MS,
  fetchPage = sbGet,
} = {}) {
  const rows = [];
  const base = params ? `${params}&` : "";

  for (let offset = 0; ; offset += pageSize) {
    let page, err;
    for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
      if (attempt > 0) await sleep(retryDelays[attempt - 1]);
      try {
        page = await fetchPage(table, `${base}limit=${pageSize}&offset=${offset}`);
        err = null;
        break;
      } catch (e) {
        err = e;
        if (!e?.timedOut) break;   // the server answered; retrying won't change it
      }
    }
    if (err) return { rows, complete: false, error: err?.message || String(err) };
    if (!Array.isArray(page) || page.length === 0) break;
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return { rows, complete: true, error: null };
}

export function sbPost(table, body) {
  void table;
  return sbFetch("", { method: "POST", body: JSON.stringify(body) });
}

export function sbPatch(table, matchParam, body) {
  void table;
  return sbFetch(matchParam, { method: "PATCH", body: JSON.stringify(body) });
}
