/**
 * Tests for the shared Supabase fetch policy.
 *
 * The incident these exist to prevent (2026-09-05): the shared instance stalled
 * for ~8 minutes and answered every request with a 504 after 135-180 s. Jobs
 * with no retry threw away work that was computed correctly; jobs with a
 * five-second backoff retried entirely inside the stall and then gave up. The
 * two behaviours that matter are therefore "wait long enough" and "know what is
 * worth waiting for" — and the third, "don't retry a write that isn't safe to
 * repeat", which is what keeps a stall from duplicating a slate.
 *
 * Run: npx vitest run
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { sbRequest, sbJson, isTransientStatus, SbHttpError, DEFAULT_BACKOFF_MS } from "./sb.mjs";

const URL_ = "https://example.supabase.co/rest/v1/mlb_picks?select=id";

// No real waiting: pass a zero backoff of the same length as the default.
const FAST = { backoff: DEFAULT_BACKOFF_MS.map(() => 0), onRetry: () => {} };

function response(status, body = "") {
  return { ok: status >= 200 && status < 300, status, text: async () => body };
}

afterEach(() => { vi.unstubAllGlobals(); });

function stubFetch(...responses) {
  const calls = [];
  const fn = vi.fn(async (url, init) => {
    calls.push({ url, init });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (next instanceof Error) throw next;
    return next;
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
}

describe("classification", () => {
  it("treats 5xx, 429 and 408 as the instance being unavailable", () => {
    for (const s of [500, 502, 503, 504, 429, 408]) expect(isTransientStatus(s)).toBe(true);
  });
  it("treats other 4xx as our own bug", () => {
    for (const s of [400, 401, 403, 404, 409, 422]) expect(isTransientStatus(s)).toBe(false);
  });
});

describe("reads", () => {
  it("returns the first ok response without retrying", async () => {
    const { fn } = stubFetch(response(200, "[]"));
    const res = await sbRequest(URL_, {}, FAST);
    expect(res.status).toBe(200);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries a 504 and succeeds when the stall ends", async () => {
    const { fn } = stubFetch(response(504, "upstream request timeout"), response(200, "[]"));
    const res = await sbRequest(URL_, {}, FAST);
    expect(res.status).toBe(200);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries network failures", async () => {
    const { fn } = stubFetch(new TypeError("fetch failed"), response(200, "[]"));
    await sbRequest(URL_, {}, FAST);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("gives up after the whole backoff and throws the last error", async () => {
    const { fn } = stubFetch(response(504, "still down"));
    await expect(sbRequest(URL_, {}, FAST)).rejects.toThrow(/504/);
    expect(fn).toHaveBeenCalledTimes(DEFAULT_BACKOFF_MS.length + 1);
  });

  it("fails fast on 401 — retrying a bad key only makes it slower", async () => {
    const { fn } = stubFetch(response(401, '{"message":"Invalid API key"}'));
    await expect(sbRequest(URL_, {}, FAST)).rejects.toBeInstanceOf(SbHttpError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("fails fast on 404", async () => {
    const { fn } = stubFetch(response(404, "not found"));
    await expect(sbRequest(URL_, {}, FAST)).rejects.toThrow(/404/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("carries the status on the error so callers can branch on it", async () => {
    stubFetch(response(404, "nope"));
    await sbRequest(URL_, {}, FAST).catch((e) => {
      expect(e.status).toBe(404);
      expect(e.transient).toBe(false);
    });
  });
});

describe("writes", () => {
  it("does NOT retry a plain insert — a retried insert that landed duplicates the slate", async () => {
    const { fn } = stubFetch(response(504, "upstream request timeout"));
    await expect(
      sbRequest(URL_, { method: "POST", body: "[]" }, FAST)
    ).rejects.toThrow(/504/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries a write the caller declares idempotent (upsert / DELETE / PATCH-by-key)", async () => {
    const { fn } = stubFetch(response(503, "unavailable"), response(201, ""));
    const res = await sbRequest(
      `${URL_}&on_conflict=id`,
      { method: "POST", body: "[]" },
      { ...FAST, idempotent: true }
    );
    expect(res.status).toBe(201);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("still fails fast on 4xx even when idempotent", async () => {
    const { fn } = stubFetch(response(400, "bad on_conflict"));
    await expect(
      sbRequest(URL_, { method: "DELETE" }, { ...FAST, idempotent: true })
    ).rejects.toThrow(/400/);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("sbJson", () => {
  it("parses a body", async () => {
    stubFetch(response(200, '[{"id":1}]'));
    expect(await sbJson(URL_, {}, FAST)).toEqual([{ id: 1 }]);
  });

  it("returns null for the empty body of Prefer: return=minimal, rather than throwing after a successful write", async () => {
    stubFetch(response(201, ""));
    expect(await sbJson(URL_, { method: "POST" }, { ...FAST, idempotent: true })).toBeNull();
  });
});

describe("timeouts", () => {
  it("passes a signal on every request so a hung socket can't hold the job open", async () => {
    const { calls } = stubFetch(response(200, "[]"));
    await sbRequest(URL_, {}, FAST);
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it("honours a caller's own abort instead of retrying past it", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const err = Object.assign(new Error("aborted"), { name: "AbortError" });
    const { fn } = stubFetch(err);
    await expect(sbRequest(URL_, { signal: ctrl.signal }, FAST)).rejects.toThrow(/aborted/);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("backoff shape", () => {
  it("waits long enough to cross a multi-minute stall", () => {
    const total = DEFAULT_BACKOFF_MS.reduce((a, b) => a + b, 0);
    // The 2026-09-05 stall ran ~8 minutes; a 5-second backoff retried entirely
    // inside it. Anything under two minutes is not a retry policy, it's a shrug.
    expect(total).toBeGreaterThanOrEqual(120_000);
  });
});
