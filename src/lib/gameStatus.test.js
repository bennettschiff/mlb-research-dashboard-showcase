import { describe, it, expect, vi } from "vitest";
import {
  fetchGameStates, gameStatesFromGames, anyGameStarted, allGamesFinal, isDeadGame,
} from "./gameStatus.js";

// The Golden 10 locks at first pitch. It used to read game status off App's
// `games` array, which is fetched once per date through fetchJson's session
// memo — so a tab opened in the morning saw "Preview" on every game for the
// rest of the night and the lock never fired. These pin the pieces that make
// the lock reachable: state that is read fresh, and predicates that only fire
// on real data.

const API = "https://statsapi.mlb.com/api/v1";

describe("live game state", () => {
  it("always bypasses the session memo — a cached Preview is the whole bug", async () => {
    const fetchJson = vi.fn(async () => ({
      dates: [{ games: [{ gamePk: 1, status: { abstractGameState: "Live" } }] }],
    }));

    const states = await fetchGameStates({ fetchJson, date: "2026-08-09", api: API });

    expect(states).toEqual({ 1: "Live" });
    const [, , opts] = fetchJson.mock.calls[0];
    expect(opts).toMatchObject({ bypassCache: true });
  });

  it("flips the lock predicate that a stale schedule held shut", async () => {
    // what the memoized `games` prop still believes
    const stale = gameStatesFromGames([
      { gamePk: 1, status: { abstractGameState: "Preview" } },
      { gamePk: 2, status: { abstractGameState: "Preview" } },
    ]);
    expect(anyGameStarted(stale)).toBe(false); // <- the board sat here all night

    const fetchJson = vi.fn(async () => ({
      dates: [{ games: [
        { gamePk: 1, status: { abstractGameState: "Live" } },
        { gamePk: 2, status: { abstractGameState: "Preview" } },
      ] }],
    }));
    const fresh = await fetchGameStates({ fetchJson, date: "2026-08-09", api: API });

    expect(anyGameStarted(fresh)).toBe(true);
  });

  it("never claims the slate started on missing or empty data", async () => {
    expect(anyGameStarted({})).toBe(false);
    expect(anyGameStarted(null)).toBe(false);
    expect(anyGameStarted(undefined)).toBe(false);

    const fetchJson = vi.fn(async () => null); // fetchJson swallows failures as null
    expect(await fetchGameStates({ fetchJson, date: "2026-08-09", api: API })).toEqual({});
  });

  it("defaults a game with no status to Preview rather than dropping it", () => {
    expect(gameStatesFromGames([{ gamePk: 7 }])).toEqual({ 7: "Preview" });
    expect(gameStatesFromGames([{ status: { abstractGameState: "Live" } }])).toEqual({});
    expect(gameStatesFromGames(null)).toEqual({});
  });

  it("stops the poll only when every game is genuinely Final", () => {
    expect(allGamesFinal({ 1: "Final", 2: "Final" })).toBe(true);
    expect(allGamesFinal({ 1: "Final", 2: "Live" })).toBe(false);
    expect(allGamesFinal({})).toBe(false); // empty must not read as "done"
  });

  it("leaves the existing dead-game helpers alone", () => {
    expect(isDeadGame({ status: { detailedState: "Postponed" } })).toBe(true);
    expect(isDeadGame({ status: { detailedState: "Scheduled" } })).toBe(false);
  });
});
