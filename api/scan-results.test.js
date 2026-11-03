import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The retry path in sbRequest is what stands between a transient Supabase 5xx
// and a permanently missing scan blob for the day (a 500 here used to lose the
// day outright unless a human happened to re-scan). These drive the handler
// end-to-end with a stubbed fetch, since sbRequest is module-private.

process.env.SUPABASE_URL = "https://stub.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-key";

const { default: handler } = await import("./scan-results.js");

const mkRes = () => {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
};

const postReq = (body) => ({ method: "POST", body });

// PostgREST returns 500 with SQLSTATE 57014 when statement_timeout fires.
const timeout = () =>
  new Response(JSON.stringify({ code: "57014", message: "canceling statement due to statement timeout" }),
    { status: 500 });
const ok = () => new Response(null, { status: 200 });

const SAVE = { date: "2026-07-20", results: [{ p: 1 }], player_count: 1 };

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("scan-results POST — transient failures must not lose the day", () => {
  it("retries a statement timeout and succeeds on the second attempt", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(timeout())
      .mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", fetchMock);

    const res = mkRes();
    await handler(postReq(SAVE), res);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, date: "2026-07-20" });
  });

  it("gives up after 3 attempts and reports the real error", async () => {
    // A fresh Response per call: a body can only be read once, so reusing one
    // instance would blank the error text on attempts 2-3 (test artifact only).
    const fetchMock = vi.fn(async () => timeout());
    vi.stubGlobal("fetch", fetchMock);

    const res = mkRes();
    await handler(postReq(SAVE), res);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toMatch(/57014|statement timeout/);
  });

  it("does NOT retry a 4xx — a bad payload or bad auth won't fix itself", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: "invalid input syntax" }), { status: 400 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = mkRes();
    await handler(postReq(SAVE), res);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(500);
  });

  it("retries a network-level failure", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", fetchMock);

    const res = mkRes();
    await handler(postReq(SAVE), res);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.statusCode).toBe(200);
  });

  it("stops retrying once the deadline is blown, to stay inside maxDuration", async () => {
    // Each attempt burns the full 120s statement_timeout. The function only has
    // 300s, so the third attempt must never be started.
    const fetchMock = vi.fn(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
      return timeout();
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = mkRes();
    await handler(postReq(SAVE), res);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.statusCode).toBe(500);
  });
});
