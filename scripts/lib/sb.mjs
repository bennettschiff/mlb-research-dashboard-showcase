/**
 * scripts/lib/sb.mjs — the one place a scheduled job talks to Supabase.
 *
 * WHY THIS EXISTS
 *
 * On 2026-09-05 the shared instance stalled for ~8 minutes: PostgREST's own
 * session setup (`SET client_encoding`) hit the statement timeout and every
 * request came back 504 after 135-180 s. Two jobs in two repos died inside that
 * window and reported it in two different vocabularies, which read like two
 * unrelated regressions. It wasn't. It was one stall meeting seventeen separate
 * hand-rolled fetch helpers, each with its own idea of what a failure means.
 *
 * That is the actual bug. Every script having its own `sb()` is why a fix lands
 * in one place and the next stall surfaces somewhere else — the "fix and break,
 * repair fix and break" loop. So: one helper, one retry policy, one test suite,
 * and a guard test (sb.guard.test.js) that fails the build if a scheduled script
 * starts talking to /rest/v1/ with a bare fetch again.
 *
 * POLICY
 *
 * - Retry 408, 429, 5xx, and network/timeout errors. Those are the instance
 *   being unavailable; the request is still valid.
 * - Never retry other 4xx. A bad query, a bad key, a missing table — retrying
 *   only turns a clear error into a slow one.
 * - GET and HEAD retry by default: they are idempotent.
 * - Anything else does NOT retry unless the caller passes `idempotent: true`.
 *   This is the important one. mlb_picks has no unique key but `id`, so a
 *   retried plain INSERT that actually landed duplicates the slate. Pass
 *   `idempotent` only for an upsert (`on_conflict=`), a DELETE, or a
 *   PATCH/PUT addressed by primary key — all of which land the same answer
 *   whether they run once or three times.
 * - Every request carries a timeout, so a socket the server never closes can't
 *   hold a job open until the workflow's own timeout kills it.
 *
 * Backoff totals ~2.6 minutes, which covers the stalls this instance has
 * actually produced. Jobs that can afford to wait longer pass their own.
 */

/** Waits between attempts. Length = number of retries after the first try. */
export const DEFAULT_BACKOFF_MS = [5_000, 15_000, 45_000, 90_000];

/** Per-request ceiling. The gateway itself gives up around 150 s. */
export const DEFAULT_TIMEOUT_MS = 60_000;

const IDEMPOTENT_METHODS = new Set(["GET", "HEAD"]);

/** Is this HTTP status the instance being unavailable rather than us being wrong? */
export function isTransientStatus(status) {
  return status >= 500 || status === 429 || status === 408;
}

/**
 * An error raised by sbRequest for a non-ok response. Carries the status so
 * callers can branch (e.g. treat a 404 as "not provisioned yet") without
 * re-parsing a message string.
 */
export class SbHttpError extends Error {
  constructor(label, status, body) {
    super(`${label}: ${status} ${String(body || "").slice(0, 300)}`);
    this.name = "SbHttpError";
    this.status = status;
    this.body = body;
    this.transient = isTransientStatus(status);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch() against Supabase with the policy above.
 *
 * @param {string} url   full URL, including the /rest/v1/ path and query
 * @param {RequestInit} init
 * @param {object} opts
 *   label      — what to call this in logs (defaults to the path)
 *   idempotent — allow retries for a non-GET (upsert / DELETE / PATCH-by-key)
 *   backoff    — array of waits in ms (default DEFAULT_BACKOFF_MS)
 *   timeoutMs  — per-request timeout (default DEFAULT_TIMEOUT_MS)
 *   onRetry    — ({ attempt, wait, error }) => void, defaults to a warn line
 * @returns {Promise<Response>} an ok Response
 */
export async function sbRequest(url, init = {}, opts = {}) {
  const method = (init.method || "GET").toUpperCase();
  const label = opts.label || labelFor(url, method);
  const mayRetry = IDEMPOTENT_METHODS.has(method) || opts.idempotent === true;
  const backoff = mayRetry ? (opts.backoff || DEFAULT_BACKOFF_MS) : [];
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const onRetry = opts.onRetry || defaultOnRetry;

  let lastErr;
  for (let attempt = 0; attempt <= backoff.length; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal: timeoutSignal(init.signal, timeoutMs) });
      if (res.ok) return res;
      const err = new SbHttpError(label, res.status, await res.text().catch(() => ""));
      if (!err.transient) throw err;          // our bug, not the instance's — fail now
      lastErr = err;
    } catch (e) {
      // A non-transient SbHttpError re-thrown from the try block above, or a
      // caller-supplied abort. Anything else (network, DNS, our own timeout) is
      // the instance being unreachable → retry.
      if (e instanceof SbHttpError && !e.transient) throw e;
      if (e?.name === "AbortError" && init.signal?.aborted) throw e;
      lastErr = e;
    }
    const wait = backoff[attempt];
    if (wait === undefined) break;
    onRetry({ attempt: attempt + 1, wait, error: lastErr, label });
    await sleep(wait);
  }
  throw lastErr;
}

/**
 * sbRequest + JSON parse. Tolerates the empty body PostgREST returns for
 * `Prefer: return=minimal`, which would otherwise throw AFTER a successful
 * write and read as a failed run.
 */
export async function sbJson(url, init = {}, opts = {}) {
  const res = await sbRequest(url, init, opts);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

function labelFor(url, method) {
  const path = String(url).split("/rest/v1/")[1] || String(url);
  return `${method} ${path.slice(0, 120)}`;
}

function defaultOnRetry({ wait, error, label }) {
  console.warn(`  ⚠️  ${label} — ${String(error?.message || error).slice(0, 140)}; retrying in ${wait / 1000}s`);
}

// AbortSignal.any exists from Node 20.3; the workflows pin node 20.x. Fall back
// to the caller's own signal rather than dropping their cancellation on the floor.
function timeoutSignal(callerSignal, timeoutMs) {
  const t = AbortSignal.timeout(timeoutMs);
  if (!callerSignal) return t;
  return typeof AbortSignal.any === "function" ? AbortSignal.any([callerSignal, t]) : callerSignal;
}
