import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchJson } from "./utils.js";

// fetchJson memoizes by URL for the whole session. That is right for the static
// statsapi reads a scan repeats hundreds of times, and wrong for URLs whose
// content fills in during the session — the lineups hydrate above all. These
// pin the bypass path that the 1st Inning refresh depends on.
describe("fetchJson session cache", () => {
  const URL_A = "https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-08-09&hydrate=lineups";
  let calls;

  beforeEach(() => {
    calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, opts) => {
      calls.push({ url, cache: opts?.cache });
      return { ok: true, json: async () => ({ n: calls.length }) };
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("serves repeat reads of the same URL from the memo", async () => {
    const url = `${URL_A}&t=memo`;
    expect(await fetchJson(url)).toEqual({ n: 1 });
    expect(await fetchJson(url)).toEqual({ n: 1 });
    expect(calls).toHaveLength(1);
  });

  it("bypassCache refetches, skips the HTTP cache, and refreshes the memo", async () => {
    const url = `${URL_A}&t=bypass`;
    expect(await fetchJson(url)).toEqual({ n: 1 });

    expect(await fetchJson(url, 15000, { bypassCache: true })).toEqual({ n: 2 });
    expect(calls[1].cache).toBe("no-store");

    // the fresh copy replaces the stale memo, so ordinary callers see it too
    expect(await fetchJson(url)).toEqual({ n: 2 });
    expect(calls).toHaveLength(2);
  });

  it("falls back to the stale entry when a bypass refetch fails", async () => {
    const url = `${URL_A}&t=fallback`;
    expect(await fetchJson(url)).toEqual({ n: 1 });

    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    vi.spyOn(console, "error").mockImplementation(() => {});

    // a refresh that cannot reach the API must not blank out what we already had
    expect(await fetchJson(url, 15000, { bypassCache: true })).toEqual({ n: 1 });
  });

  it("returns null on a failure with nothing cached", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await fetchJson(`${URL_A}&t=cold-fail`)).toBeNull();
  });
});
