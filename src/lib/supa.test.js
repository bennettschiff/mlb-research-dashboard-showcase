import { describe, it, expect, vi, afterEach } from "vitest";
import { describeApiError, sbFetch, sbGetAllPages, sbPost, SB_READ_TIMEOUT_MS, SB_WRITE_TIMEOUT_MS } from "./supa.js";

// The body that actually reached the Results tab on 2026-08-25, trimmed. The
// full page is ~4 KB of Cloudflare markup; every byte of it was rendered.
const CF_522 = JSON.stringify({
  error: `<!DOCTYPE html>\n<!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]-->\n<html class="no-js" lang="en-US">\n<head>\n<title>supabase.co | 522: Connection timed out</title>\n<meta charset="UTF-8" />\n</head>\n<body>\n<div id="cf-wrapper">\n<div id="cf-error-details" class="p-0">\n<header class="mx-auto pt-10">\n<h1 class="inline-block">Connection timed out</h1>\n<span class="code-label">Error code 522</span>\n</header>\n<div>What happened?</div>\n<p>The initial connection between Cloudflare's network and the origin web server timed out.</p>\n</div></div></body></html>`,
});

describe("describeApiError", () => {
  it("reduces a Cloudflare 522 page to one actionable line", () => {
    const msg = describeApiError(500, CF_522);
    expect(msg).toContain("Database unreachable");
    expect(msg).toContain("522");
    expect(msg).toContain("stopped responding");
    // The whole point: no markup, and short enough to read.
    expect(msg).not.toMatch(/</);
    expect(msg.length).toBeLessThan(200);
  });

  it("names the other Cloudflare origin failures", () => {
    const at = (code, title) => describeApiError(500, JSON.stringify({
      error: `<!DOCTYPE html><html><head><title>supabase.co | ${code}: ${title}</title></head><body><span class="code-label">Error code ${code}</span></body></html>`,
    }));
    expect(at(521, "Web server is down")).toContain("database is down");
    expect(at(524, "A timeout occurred")).toContain("ran too long");
  });

  it("falls back to the page title for an unrecognised HTML error", () => {
    const msg = describeApiError(502, "<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>");
    expect(msg).toBe("Database unreachable — 502 Bad Gateway.");
  });

  it("falls back to the status when the HTML has no title either", () => {
    const msg = describeApiError(503, "<html><body>cf-error-details</body></html>");
    expect(msg).toBe("Database unreachable — upstream returned HTTP 503.");
  });

  it("passes a real PostgREST error through intact", () => {
    const msg = describeApiError(400, JSON.stringify({
      message: 'column mlb_picks.nope does not exist',
      hint: "Perhaps you meant 'note'",
      code: "42703",
    }));
    expect(msg).toBe("column mlb_picks.nope does not exist — Perhaps you meant 'note'");
  });

  it("unwraps the api/picks { error } envelope", () => {
    expect(describeApiError(400, JSON.stringify({ error: "DELETE requires a query filter" })))
      .toBe("DELETE requires a query filter");
    expect(describeApiError(405, JSON.stringify({ error: "Method not allowed" })))
      .toBe("Method not allowed");
  });

  it("handles a plain-text body and an empty one", () => {
    expect(describeApiError(500, "upstream exploded")).toBe("upstream exploded");
    expect(describeApiError(500, "")).toBe("Request failed (HTTP 500).");
    expect(describeApiError(500, null)).toBe("Request failed (HTTP 500).");
  });

  it("caps a long non-HTML body instead of letting it flood the banner", () => {
    const msg = describeApiError(500, "x".repeat(5000));
    expect(msg.length).toBeLessThanOrEqual(301);
    expect(msg.endsWith("…")).toBe(true);
  });

  it("collapses newlines so the banner stays one block", () => {
    expect(describeApiError(500, "line one\n\n  line two")).toBe("line one line two");
  });
});

// A wedged database held every call open for the full 90s Cloudflare waits.
// These pin the leash and, more importantly, the message it produces.
describe("sbFetch timeouts", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  const abortError = () => Object.assign(new Error("aborted"), { name: "AbortError" });

  it("reads get a short leash, writes a long one", () => {
    expect(SB_READ_TIMEOUT_MS).toBe(20_000);
    expect(SB_WRITE_TIMEOUT_MS).toBe(45_000);
    expect(SB_WRITE_TIMEOUT_MS).toBeGreaterThan(SB_READ_TIMEOUT_MS);
  });

  it("turns a timed-out read into a plain sentence, not a hang", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(abortError())));
    await expect(sbFetch("select=id")).rejects.toThrow(
      "Database did not respond within 20s — the request was cancelled."
    );
  });

  it("warns that a timed-out WRITE may still have landed", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(abortError())));
    // A save that times out is genuinely ambiguous — the row may exist. Saying
    // so is the difference between a safe retry and a double-save.
    await expect(sbPost("mlb_picks", [{ id: 1 }])).rejects.toThrow(
      "Database did not respond within 45s — the request was cancelled and may or may not have been saved."
    );
  });

  it("passes a caller's own abort straight through", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(abortError())));
    const ctrl = new AbortController();
    // The caller owns this cancellation, so it must not be relabelled a timeout.
    await expect(sbFetch("select=id", { signal: ctrl.signal })).rejects.toThrow("aborted");
  });

  it("clears the timer on success so a slow later call is unaffected", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({
      ok: true, status: 200, json: () => Promise.resolve([{ id: 1 }]),
    })));
    await expect(sbFetch("select=id")).resolves.toEqual([{ id: 1 }]);
  });

  it("still reduces an HTML error body when the request completes", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({
      ok: false, status: 500,
      text: () => Promise.resolve(JSON.stringify({
        error: '<!DOCTYPE html><html><head><title>supabase.co | 522: Connection timed out</title></head><body><span class="code-label">Error code 522</span></body></html>',
      })),
    })));
    await expect(sbFetch("select=id")).rejects.toThrow(/Database unreachable.*522/);
  });

  it("flags a timeout so callers can tell it apart from a server refusal", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(abortError())));
    await expect(sbFetch("select=id")).rejects.toMatchObject({ timedOut: true });
  });
});

// 2026-09-04: the Results tab read "0 picks tracked · 0 graded" behind a 20s
// timeout banner while the database was answering every page in ~0.5s. One page
// starved by the scan's fetch storm discarded the entire history.
describe("sbGetAllPages", () => {
  const noDelay = [0, 0];
  const timeout = () => Object.assign(new Error("Database did not respond within 20s — the request was cancelled."), { timedOut: true });
  // Offsets are read back out of the params, so the fakes serve the right slice
  // regardless of how the caller composes the rest of the query.
  const offsetOf = (params) => Number(params.match(/offset=(\d+)/)[1]);

  it("walks pages until a short one comes back", async () => {
    const rows = Array.from({ length: 2300 }, (_, i) => ({ id: i }));
    const fetchPage = vi.fn((_t, params) => {
      const off = offsetOf(params);
      return Promise.resolve(rows.slice(off, off + 1000));
    });
    const res = await sbGetAllPages("mlb_picks", "order=id.desc", { fetchPage, retryDelays: noDelay });
    expect(res).toEqual({ rows, complete: true, error: null });
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(fetchPage.mock.calls.map(c => c[1])).toEqual([
      "order=id.desc&limit=1000&offset=0",
      "order=id.desc&limit=1000&offset=1000",
      "order=id.desc&limit=1000&offset=2000",
    ]);
  });

  it("stops on an exactly-full last page without claiming a partial read", async () => {
    const rows = Array.from({ length: 2000 }, (_, i) => ({ id: i }));
    const fetchPage = vi.fn((_t, params) => Promise.resolve(rows.slice(offsetOf(params), offsetOf(params) + 1000)));
    const res = await sbGetAllPages("mlb_picks", "", { fetchPage, retryDelays: noDelay });
    expect(res.rows).toHaveLength(2000);
    expect(res.complete).toBe(true);
    expect(fetchPage).toHaveBeenCalledTimes(3);  // the third comes back empty
    expect(fetchPage.mock.calls[0][1]).toBe("limit=1000&offset=0");
  });

  it("retries a timed-out page and keeps the whole history", async () => {
    const rows = Array.from({ length: 1500 }, (_, i) => ({ id: i }));
    let starved = 2;   // the second page loses the race twice before landing
    const fetchPage = vi.fn((_t, params) => {
      const off = offsetOf(params);
      if (off === 1000 && starved-- > 0) return Promise.reject(timeout());
      return Promise.resolve(rows.slice(off, off + 1000));
    });
    const res = await sbGetAllPages("mlb_picks", "", { fetchPage, retryDelays: noDelay });
    expect(res.complete).toBe(true);
    expect(res.rows).toHaveLength(1500);
  });

  it("keeps the pages that did arrive when retries run out", async () => {
    const fetchPage = vi.fn((_t, params) =>
      offsetOf(params) === 0
        ? Promise.resolve(Array.from({ length: 1000 }, (_, i) => ({ id: i })))
        : Promise.reject(timeout())
    );
    const res = await sbGetAllPages("mlb_picks", "", { fetchPage, retryDelays: noDelay });
    // The old loop threw all 1000 of these away and rendered an empty tab.
    expect(res.rows).toHaveLength(1000);
    expect(res.complete).toBe(false);
    expect(res.error).toMatch(/did not respond within 20s/);
    expect(fetchPage).toHaveBeenCalledTimes(1 + 3);  // page 0, then 3 attempts at page 1
  });

  it("does not retry an error the server actually returned", async () => {
    // A wedged database or a bad query has told us something true; retrying it
    // three times only delays the banner the user needs to see.
    const fetchPage = vi.fn(() => Promise.reject(new Error("Database unreachable — the Supabase database is down (Cloudflare 521).")));
    const res = await sbGetAllPages("mlb_picks", "", { fetchPage, retryDelays: noDelay });
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ rows: [], complete: false, error: "Database unreachable — the Supabase database is down (Cloudflare 521)." });
  });

  it("backs off between attempts so the retry does not join the same pile-up", async () => {
    // Fake timers, not a wall-clock floor: libuv can fire a timer ~1 ms early
    // relative to Date.now(), so `elapsed >= 90` measured 89 on a loaded CI
    // runner (run 36585873166). Stepping the clock asserts each retry waits
    // exactly its delay — no sooner, no later.
    vi.useFakeTimers();
    try {
      const fetchPage = vi.fn(() => Promise.reject(timeout()));
      const done = sbGetAllPages("mlb_picks", "", { fetchPage, retryDelays: [30, 60] });
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchPage).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(29);
      expect(fetchPage).toHaveBeenCalledTimes(1);   // still backing off
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchPage).toHaveBeenCalledTimes(2);   // first retry at t=30
      await vi.advanceTimersByTimeAsync(59);
      expect(fetchPage).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchPage).toHaveBeenCalledTimes(3);   // second retry at t=90
      const res = await done;
      expect(res.complete).toBe(false);
      expect(fetchPage).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
