import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The Rotowire lineups page is proxied at ttl=1800. Before `fresh`, a user
// hitting "↻ Lineups" busted the client TTL, landed here, and got an X-Cache
// HIT — so the button re-parsed HTML up to 30 minutes old and the board never
// moved (verified against prod: first AND second click both returned HIT).
// These pin that a forced refresh goes upstream and still repopulates the cache,
// which is what separates `fresh=1` from the pre-existing `ttl=0`.

const cacheGet = vi.fn();
const cacheSet = vi.fn(async () => {});
vi.mock("./_cache.js", () => ({ cacheGet, cacheSet }));

const { default: handler } = await import("./proxy.js");

const RW = "https://www.rotowire.com/baseball/daily-lineups.php";

const mkRes = () => {
  const res = { statusCode: null, body: null, headers: {} };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.end = (b) => { res.body = b; return res; };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  return res;
};
const req = (query) => ({ method: "GET", query });

beforeEach(() => {
  cacheGet.mockReset();
  cacheSet.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("FRESH-HTML", { status: 200 })));
});
afterEach(() => vi.unstubAllGlobals());

describe("api/proxy cache freshness", () => {
  it("serves the cached copy on an ordinary request", async () => {
    cacheGet.mockResolvedValue("STALE-HTML");
    const res = mkRes();
    await handler(req({ url: RW, ttl: "1800" }), res);

    expect(res.headers["X-Cache"]).toBe("HIT");
    expect(res.body).toBe("STALE-HTML");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fresh=1 skips the cached copy and goes upstream", async () => {
    cacheGet.mockResolvedValue("STALE-HTML");
    const res = mkRes();
    await handler(req({ url: RW, ttl: "1800", fresh: "1" }), res);

    expect(cacheGet).not.toHaveBeenCalled();
    expect(res.headers["X-Cache"]).toBe("MISS");
    expect(res.body).toBe("FRESH-HTML");
  });

  it("fresh=1 still writes back, so the next ordinary load is not stale again", async () => {
    cacheGet.mockResolvedValue("STALE-HTML");
    await handler(req({ url: RW, ttl: "1800", fresh: "1" }), mkRes());

    // this is the difference from ttl=0, which skips the write and leaves the
    // stale row in place for every subsequent reader
    expect(cacheSet).toHaveBeenCalledWith(RW, "FRESH-HTML", 1800);
  });

  it("keeps refusing hosts outside the allowlist when fresh is set", async () => {
    const res = mkRes();
    await handler(req({ url: "https://evil.example.com/x", ttl: "1800", fresh: "1" }), res);

    expect(res.statusCode).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });
});
