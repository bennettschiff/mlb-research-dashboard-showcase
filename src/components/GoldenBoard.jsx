import { useCallback, useEffect, useMemo, useState } from "react";
import { API, fetchJson, normName } from "../lib/utils.js";
import { computeGoldenCandidates } from "../lib/golden.js";
import {
  loadGoldenSnapshot, fetchGoldenSnapshot, saveGoldenSnapshot, deleteGoldenSnapshot,
} from "../lib/goldenSnapshot.js";
import {
  fetchGameStates, gameStatesFromGames, anyGameStarted, allGamesFinal,
} from "../lib/gameStatus.js";
import GoldenBoards from "./GoldenBoards.jsx";
import BookLogo from "./BookLogo.jsx";
import { BOOK_NAMES } from "./OddsLink.jsx";

/**
 * Golden 10 — cross-market top-10 highest conviction plays of the day.
 *
 * Universe: official picks only (dice 🎲) from all markets — batter props, Ks,
 * ML/RL/OU. Ranked by goldenScore = 0.6 * conf_norm + 0.4 * prob_norm, blending
 * model confidence with implied probability so chalk-but-shaky and
 * edge-but-50-50 picks both stay honest (src/lib/golden.js).
 *
 * The board LOCKS at first pitch: once the slate's first game leaves Preview the
 * current 10 are snapshotted to Supabase + localStorage and stop reshuffling, so
 * the day's record is judged against what was actually showing before any game
 * started. Started games grey out rather than being replaced.
 *
 * Extracted from App.jsx 2026-08-09.
 *
 * THE LOCK USED TO BE UNREACHABLE. It keyed off the `games` prop, which App
 * fetches once per date through fetchJson's session memo — so in a tab opened
 * before first pitch every game read "Preview" for the rest of the session and
 * the auto-lock never fired. The board stayed "Live", the 10 kept reshuffling as
 * the scan and slate updated, and the only way to freeze it was the manual Lock
 * Now button. Live state now comes from its own small polled request
 * (src/lib/gameStatus.js), NOT from refreshing `games` — `games` is a dependency
 * of usePropsScan, so putting it on a timer would re-run the whole league-wide
 * scan every cycle.
 */

// Poll cadence for game state. The lock is supposed to land AT first pitch, so
// this is the width of the window in which the board can still drift; a 5-minute
// poll would let the 10 reshuffle for five minutes of live baseball.
const STATE_POLL_MS = 60 * 1000;

export default function GoldenBoard({ scanData, scanComplete, slateRows, games, date, onSelectBatter, onSelectPitcher }) {
  const live = useMemo(
    () => scanComplete ? computeGoldenCandidates(scanData, slateRows) : [],
    [scanData, slateRows, scanComplete]
  );

  // Name → scan row, so a board written server-side (which stores only the
  // player's NAME) can still open the same panel the props boards open. Rows are
  // the raw scan entities, which is exactly what onSelectBatter/onSelectPitcher
  // expect.
  //
  // Pitchers come from `pitchersAll`, the UNFILTERED list: enrichScanData drops
  // started games out of `pitchers` for display, and the board is locked at
  // first pitch, so keying off the filtered list would make every starter's name
  // go dead exactly when the locked board is what you're looking at. Batters
  // need no equivalent — `players` is never filtered.
  const scanIndex = useMemo(() => {
    const batters = new Map(), pitchers = new Map();
    for (const p of scanData?.players || []) if (p?.name) batters.set(normName(p.name), p);
    for (const p of scanData?.pitchersAll || scanData?.pitchers || []) {
      if (p?.name) pitchers.set(normName(p.name), p);
    }
    return { batters, pitchers };
  }, [scanData]);

  // Returns a click handler for a board row, or null when there is nobody to
  // open: game-line markets (NRFI's "player" is a matchup string) and players
  // the current scan doesn't carry.
  const resolvePlayer = useCallback((pick) => {
    if (!pick?.playerName) return null;
    const key = normName(pick.playerName);
    if (pick.market === "ks") {
      const row = scanIndex.pitchers.get(key);
      if (!row || !onSelectPitcher) return null;
      return () => onSelectPitcher({
        pitcher: { id: row.pitcherId, fullName: row.name, pitchHand: { code: row.hand } },
        pitcherTeam: row.team,
        pitcherScanData: row,
      });
    }
    const row = scanIndex.batters.get(key);
    if (!row || !onSelectBatter) return null;
    return () => onSelectBatter(row);
  }, [scanIndex, onSelectBatter, onSelectPitcher]);

  // Live game state, seeded from the (possibly stale) prop so the first render
  // is never worse than the old behaviour, then kept honest by polling.
  const [gameStateByPk, setGameStateByPk] = useState(() => gameStatesFromGames(games));
  useEffect(() => { setGameStateByPk(gameStatesFromGames(games)); }, [date]); // eslint-disable-line react-hooks/exhaustive-deps

  const settled = allGamesFinal(gameStateByPk);
  useEffect(() => {
    if (!date || settled) return;
    let dead = false;
    const tick = () => {
      fetchGameStates({ fetchJson, date, api: API })
        .then((s) => { if (!dead && Object.keys(s).length) setGameStateByPk(s); })
        .catch(() => {});
    };
    tick();
    const id = setInterval(tick, STATE_POLL_MS);
    return () => { dead = true; clearInterval(id); };
  }, [date, settled]);

  const firstGameStarted = anyGameStarted(gameStateByPk);

  // Cache-first init, then hydrate from DB so locks made on another device sync in.
  const [snapshot, setSnapshot] = useState(() => loadGoldenSnapshot(date));
  useEffect(() => {
    let cancelled = false;
    setSnapshot(loadGoldenSnapshot(date));
    fetchGoldenSnapshot(date)
      .then((snap) => { if (!cancelled && snap) setSnapshot(snap); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [date]);

  // Slate-ready gate — auto-lock waits for slate data to arrive so ML/RL/OU plays
  // can be considered. Falls back to locking anyway after a 15s grace if slate never
  // populates (e.g. odds outage), so the Golden 10 still freezes at first pitch.
  const [slateReady, setSlateReady] = useState((slateRows || []).length > 0);
  useEffect(() => { if ((slateRows || []).length > 0) setSlateReady(true); }, [slateRows]);
  useEffect(() => {
    if (!firstGameStarted) return;
    if (slateReady) return;
    const t = setTimeout(() => setSlateReady(true), 15000);
    return () => clearTimeout(t);
  }, [firstGameStarted, slateReady]);

  // Lock when first game starts, slate data is in, and we have a live list
  useEffect(() => {
    if (!firstGameStarted) return;
    if (!slateReady) return;
    if (snapshot?.picks?.length) return;
    if (live.length === 0) return;
    const lockedAt = saveGoldenSnapshot(date, live);
    setSnapshot({ lockedAt, picks: live });
  }, [firstGameStarted, slateReady, live, date, snapshot]);

  const locked = !!snapshot?.picks?.length;
  const display = locked ? snapshot.picks : live;

  // Manual override — only useful before the first game starts
  const relock = () => {
    if (!live.length) return;
    const lockedAt = saveGoldenSnapshot(date, live);
    setSnapshot({ lockedAt, picks: live });
  };
  const unlock = () => {
    deleteGoldenSnapshot(date);
    setSnapshot(null);
  };

  if (!scanComplete) {
    return <div style={{ padding: "40px 20px", textAlign: "center", color: "#74839d" }}>Scan still running — Golden 10 will populate once props are loaded.</div>;
  }

  return (
    <div style={{ padding: "20px", minHeight: "calc(100vh - 120px)" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
        <span style={{ fontSize: 28 }}>🏆</span>
        <div>
          <div style={{ fontSize: 20, fontWeight: 700, color: "#16233c" }}>Golden Boards</div>
          <div style={{ fontSize: 11, color: "#74839d", marginTop: 2 }}>
            Three ranked boards over the per-line surface · legacy board below —
            0.6 × conf + 0.4 × model prob ·
            {locked
              ? <> 🔒 Locked at first pitch ({new Date(snapshot.lockedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })})</>
              : <> 🔓 Live — locks when first game starts</>}
          </div>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          {!locked && live.length > 0 && (
            <button onClick={relock} title="Lock the current 10 now (otherwise auto-locks at first game start)" style={{
              padding: "4px 10px", fontSize: 10, fontWeight: 600, borderRadius: 8,
              background: "rgba(15,138,68,0.1)", border: "1px solid rgba(15,138,68,0.3)", color: "#0f8a44", cursor: "pointer",
            }}>🔒 Lock Now</button>
          )}
          {locked && (
            <button onClick={unlock} title="Clear today's locked snapshot — only useful for testing" style={{
              padding: "4px 10px", fontSize: 10, fontWeight: 600, borderRadius: 8,
              background: "rgba(208,49,49,0.08)", border: "1px solid rgba(208,49,49,0.25)", color: "#d03131", cursor: "pointer",
            }}>Unlock</button>
          )}
        </div>
      </div>

      {/* The three current boards, written server-side by
          scripts/golden-snapshot.mjs from the Brain Trust per-line surface. */}
      <GoldenBoards date={date} title="Today's boards" resolvePlayer={resolvePlayer} />

      <div style={{
        fontSize: 10, color: "#74839d", textTransform: "uppercase",
        letterSpacing: 1, fontWeight: 600, margin: "26px 0 10px",
      }}>
        Legacy Golden 10 · goldenScore
      </div>

      {(!slateRows || slateRows.length === 0) && !locked && (
        <div style={{
          marginBottom: 14, padding: "8px 14px", borderRadius: 8, fontSize: 11,
          background: "rgba(161,98,7,0.08)", border: "1px solid rgba(161,98,7,0.25)", color: "#a16207",
        }}>
          Slate Odds not loaded yet — visit the Slate Odds tab once so ML/RL/OU plays can be considered for Golden 10.
        </div>
      )}

      {display.length === 0 ? (
        <div style={{ padding: "40px 20px", textAlign: "center", color: "#74839d" }}>
          No official picks yet — Golden 10 needs at least one dice-grade play across markets.
        </div>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {display.map((g, i) => {
            const gameState = gameStateByPk[g.gamePk] || "Preview";
            const isLive   = gameState === "Live";
            const isFinal  = gameState === "Final";
            const started = isLive || isFinal;
            const confColor = g.conf >= 9 ? "#0f8a44" : g.conf >= 8 ? "#1c9a50" : g.conf >= 7 ? "#2569d6" : "#a16207";
            const goldenColor = g.goldenScore >= 0.85 ? "#a16207" : g.goldenScore >= 0.75 ? "#a16207" : "#16233c";
            const dirBadge = g.direction === "under"
              ? <span style={{ fontSize: 9, fontWeight: 700, color: "#d03131", marginLeft: 3 }}>U</span>
              : g.market !== "ml" && g.market !== "rl"
                ? <span style={{ fontSize: 9, fontWeight: 700, color: "#0f8a44", marginLeft: 3 }}>O</span>
                : null;
            return (
              <div key={`${g.market}_${g.playerId}_${i}`}
                onClick={() => {
                  if (g.market === "ks") {
                    onSelectPitcher?.({
                      pitcher: { id: g._pick.pitcherId, fullName: g._pick.name, pitchHand: { code: g._pick.hand } },
                      pitcherTeam: g._pick.team,
                      pitcherScanData: g._pick,
                    });
                  } else if (["ml","rl","ou"].includes(g.market)) {
                    // No detail panel for game picks — soft no-op
                  } else {
                    onSelectBatter?.(g._pick);
                  }
                }}
                style={{
                  display: "grid", gridTemplateColumns: "32px 1.2fr 1fr 0.9fr 0.7fr 0.7fr 0.8fr 0.6fr",
                  alignItems: "center", gap: 8, padding: "12px 14px", borderRadius: 10,
                  background: started ? "rgba(210,217,236,0.35)" : "rgba(210,217,236,0.6)",
                  border: `1px solid ${started ? "rgba(116,131,157,0.15)" : "rgba(161,98,7,0.18)"}`,
                  cursor: ["ml","rl","ou"].includes(g.market) ? "default" : "pointer",
                  opacity: started ? 0.55 : 1,
                  transition: "background 0.15s",
                }}
                onMouseEnter={e => { if (!started && !["ml","rl","ou"].includes(g.market)) e.currentTarget.style.background = "rgba(32,98,200,0.112)"; }}
                onMouseLeave={e => { e.currentTarget.style.background = started ? "rgba(210,217,236,0.35)" : "rgba(210,217,236,0.6)"; }}>
                <div style={{ fontSize: 16, fontWeight: 700, color: goldenColor, textAlign: "center" }}>#{i+1}</div>
                <div>
                  <div style={{
                    fontSize: 13, fontWeight: 700, color: "#16233c",
                    // Game-line rows have no panel to open, so only player rows
                    // advertise the click.
                    ...(["ml", "rl", "ou"].includes(g.market) ? {} : {
                      textDecoration: "underline", textDecorationStyle: "dotted",
                      textDecorationColor: "rgba(22,35,60,0.35)",
                    }),
                  }}>{g.playerName}</div>
                  <div style={{ fontSize: 10, color: "#74839d", marginTop: 1 }}>
                    {g.team || "—"}{g.opponent ? ` vs ${g.opponent}` : ""}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#4c5f7d" }}>
                    {g.emoji} {g.marketLabel}{dirBadge}
                  </div>
                  {g.line != null && g.market !== "ml" && (
                    <div style={{ fontSize: 10, color: "#74839d", fontFamily: "'JetBrains Mono',monospace", marginTop: 1 }}>
                      {g.market === "rl" ? (g.line > 0 ? `+${g.line}` : g.line) : g.market === "ou" ? `T ${g.line}` : `O${g.line}`}
                    </div>
                  )}
                </div>
                <div style={{ textAlign: "center" }}>
                  <div style={{ fontSize: 10, color: "#74839d" }}>Golden</div>
                  <div style={{ fontSize: 14, fontWeight: 800, color: goldenColor, fontFamily: "'JetBrains Mono',monospace" }}>
                    {(g.goldenScore * 100).toFixed(1)}
                  </div>
                </div>
                <div style={{ textAlign: "center" }}>
                  <div style={{ fontSize: 10, color: "#74839d" }}>Conf</div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: confColor, fontFamily: "'JetBrains Mono',monospace" }}>
                    {g.conf != null ? g.conf.toFixed(1) : "—"}
                  </div>
                </div>
                <div style={{ textAlign: "center" }}>
                  <div style={{ fontSize: 10, color: "#74839d" }}>Prob</div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#2062c8", fontFamily: "'JetBrains Mono',monospace" }}>
                    {g.impliedProb != null ? `${(g.impliedProb * 100).toFixed(0)}%` : "—"}
                  </div>
                </div>
                <div style={{ textAlign: "center" }}>
                  <div style={{ fontSize: 10, color: "#74839d" }}>Best Odds</div>
                  <div style={{
                    fontSize: 12, fontWeight: 700, color: "#16233c", fontFamily: "'JetBrains Mono',monospace",
                    display: "inline-flex", alignItems: "center", gap: 4,
                  }}>
                    {g.bestBook && <BookLogo book={g.bestBook} size={13} title={`Best price: ${BOOK_NAMES[g.bestBook] || g.bestBook}`} />}
                    {g.bestOdds != null ? (g.bestOdds > 0 ? `+${g.bestOdds}` : g.bestOdds) : "—"}
                  </div>
                </div>
                <div style={{ textAlign: "center" }}>
                  {started ? (
                    <span style={{ fontSize: 9, fontWeight: 700, color: isFinal ? "#74839d" : "#a16207", background: isFinal ? "rgba(116,131,157,0.1)" : "rgba(161,98,7,0.12)", padding: "2px 6px", borderRadius: 6 }}>
                      {isFinal ? "FINAL" : "LIVE"}
                    </span>
                  ) : (
                    <span style={{ fontSize: 10, color: "#74839d", fontFamily: "'JetBrains Mono',monospace" }}>
                      {g.gameTime ? new Date(g.gameTime).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "—"}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
