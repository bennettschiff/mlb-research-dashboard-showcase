import { useEffect, useMemo, useState } from "react";
import { API, fetchJson, getTeamColor, formatDateInTimeZone, APP_TIME_ZONE } from "../lib/utils.js";
import { NRFI_PARAMS_VERSION, NRFI_TIERS } from "../lib/nrfi.js";
import { fetchSeasonState, fetchSlateInputs, predictGame } from "../lib/nrfiSlate.js";
import Loader from "./Loader.jsx";

/**
 * 1st Inning — NRFI / YRFI board.
 *
 * Pure-prediction market (no odds pulled): for every game on the slate, the
 * half-inning GBM (src/lib/nrfi.js + nrfiParams.json) estimates the chance a
 * run scores in the 1st inning, from the starter's first-inning history +
 * FIP/K-BB% form, the confirmed top of the order, team first-inning offense,
 * and the venue's empirical first-inning factor.
 *
 * Data flow (all client-side, cached at module level per day) lives in
 * src/lib/nrfiSlate.js, shared with scripts/nrfi-picks.mjs so the board and the
 * graded picks can never drift:
 *   1. Season linescore sweep (~1.6 MB once/session) → walk-forward state
 *   2. Today's schedule hydrate=lineups → confirmed batting orders (IDs)
 *   3. Two bulk people?personIds calls → starter + batter season lines
 * Games whose 1st inning is already in the books self-grade (✓ / ✗) so the
 * board doubles as the day's running scorecard. ★ strong leans are also
 * persisted to mlb_picks (prop_type `nrfi`) and carried in the Results tracker.
 */

// ── Palette (validated: NRFI↔YRFI diverging pair, ΔE 107 on light surface) ──
const C_NRFI = "#2062c8"; // cool blue — zeros
const C_YRFI = "#c2570f"; // warm ember — runs
const C_INK = "#16233c";
const C_MUTED = "#74839d";
const C_GOOD = "#0f8a44";
const C_BAD = "#b3352c";
const C_LINE = "rgba(32,98,200,0.128)";

// ── Module caches (per calendar day) ─────────────────────────────────────────
const _sweepCache = { key: null, promise: null };
const _todayCache = { key: null, promise: null };

function fetchSeasonSweep(todayStr) {
  if (_sweepCache.key === todayStr && _sweepCache.promise) return _sweepCache.promise;
  _sweepCache.key = todayStr;
  _sweepCache.promise = fetchSeasonState({ fetchJson, todayStr, api: API });
  return _sweepCache.promise;
}

function fetchTodayInputs(dateStr, games, { bust = false } = {}) {
  const key = `${dateStr}|${games.map((g) => g.gamePk).join(",")}`;
  if (!bust && _todayCache.key === key && _todayCache.promise) return _todayCache.promise;
  _todayCache.key = key;
  // bustLineups must ride along: busting only this module's cache re-runs the
  // pipeline against fetchJson's session memo of the lineups URL, which is the
  // exact stale copy we are trying to replace.
  _todayCache.promise = fetchSlateInputs({ fetchJson, dateStr, games, api: API, bustLineups: bust });
  return _todayCache.promise;
}

// Live status/linescore for a game. The `games` prop is memoized for the life of
// the tab (App's getSchedule → fetchJson, keyed on date only), so reading state
// off it means a board opened before first pitch never grades anything. Prefer
// the copy that came back with the lineups.
function liveState(game, inputs) {
  return inputs?.liveByPk?.[game.gamePk] || game;
}

// How many games still have a card to post: pre-game and fewer than 6 names on
// at least one side. Drives the header's posted count.
function awaitingLineups(games, inputs) {
  if (!inputs) return 0;
  return games.filter((g) => {
    if (liveState(g, inputs).status?.abstractGameState !== "Preview") return false;
    const lu = inputs.lineupsByPk[g.gamePk];
    return !(lu && lu.home.length >= 6 && lu.away.length >= 6);
  }).length;
}

// Anything left to poll for: a card still to post, or a game whose 1st inning
// hasn't been put to bed yet. Once every game is Final and every card is in,
// nothing on this board can change again and the poll stops for the night.
function stillMoving(games, inputs, pendingCards) {
  if (pendingCards > 0) return true;
  return games.some((g) => liveState(g, inputs).status?.abstractGameState !== "Final");
}

// ── Self-grading: has this game's 1st inning finished, and did a run score? ──
function firstInningResult(game) {
  const abstract = game.status?.abstractGameState;
  if (abstract !== "Live" && abstract !== "Final") return null;
  const inn1 = game.linescore?.innings?.[0];
  if (!inn1) return null;
  const done =
    abstract === "Final" ||
    (game.linescore?.currentInning || 0) > 1 ||
    (inn1.home?.runs != null && inn1.away?.runs != null && game.linescore?.isTopInning === false && (game.linescore?.currentInning || 0) >= 2);
  if (abstract === "Live" && (game.linescore?.currentInning || 0) <= 1) {
    // still in the 1st — a run may already be in (YRFI clinched) but zeros aren't final
    const runsSoFar = (inn1.home?.runs || 0) + (inn1.away?.runs || 0);
    return runsSoFar > 0 ? { yrfi: true, live: true } : { pending: true };
  }
  if (!done || inn1.home?.runs == null || inn1.away?.runs == null) return null;
  return { yrfi: inn1.home.runs + inn1.away.runs > 0, runs: inn1.home.runs + inn1.away.runs };
}

// ── Presentational bits ──────────────────────────────────────────────────────
function TierChip({ tier, lean }) {
  const col = lean === "YRFI" ? C_YRFI : C_NRFI;
  if (tier === "pass")
    return (
      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.8, color: C_MUTED, background: "rgba(116,131,157,0.12)", padding: "3px 9px", borderRadius: 10 }}>
        PASS
      </span>
    );
  const filled = tier === "strong";
  return (
    <span style={{
      fontSize: 10, fontWeight: 800, letterSpacing: 0.8,
      color: filled ? "#fff" : col,
      background: filled ? col : "transparent",
      border: `1.5px solid ${col}`,
      padding: "3px 9px", borderRadius: 10,
    }}>
      {lean} {tier === "strong" ? "★" : ""}
    </span>
  );
}

// Diverging confidence gauge: NRFI (left, blue) ↔ YRFI (right, ember).
// Domain clamped to 35–65% — the model's realistic range — so movement reads.
// The midpoint is the model's OWN median (PARAMS.tiers.median), not 0.5: side
// selection keys off that median too, so anchoring the gauge at 0.5 would paint
// a game between 0.5 and the median in the opposite side's colour to its label.
function ConfidenceGauge({ p }) {
  const lo = 0.35, hi = 0.65;
  const mid = NRFI_TIERS?.median ?? 0.5;
  const x = Math.max(0, Math.min(1, (p - lo) / (hi - lo)));
  const midX = Math.max(0, Math.min(1, (mid - lo) / (hi - lo)));
  return (
    <div style={{ width: "100%" }}>
      <div style={{ position: "relative", height: 8, borderRadius: 4, background: `linear-gradient(90deg, ${C_NRFI} 0%, #d9dde6 46%, #d9dde6 54%, ${C_YRFI} 100%)`, opacity: 0.9 }}>
        {/* midpoint tick — the model's median, where the lean flips */}
        <div style={{ position: "absolute", left: `${(midX * 100).toFixed(1)}%`, top: -2, width: 1.5, height: 12, background: "rgba(22,35,60,0.35)" }} />
        {/* marker */}
        <div style={{
          position: "absolute", left: `calc(${(x * 100).toFixed(1)}% - 7px)`, top: -3,
          width: 14, height: 14, borderRadius: "50%",
          background: p >= mid ? C_YRFI : C_NRFI,
          border: "2.5px solid #fcfcfb", boxShadow: "0 1px 3px rgba(22,35,60,0.35)",
        }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4, fontSize: 8.5, fontWeight: 700, letterSpacing: 0.8, color: C_MUTED }}>
        <span>NRFI</span><span>YRFI</span>
      </div>
    </div>
  );
}

// Two thin half-inning bars — P(run) in the top and bottom of the 1st.
function HalfBars({ pTop, pBot, awayAbbr, homeAbbr }) {
  const row = (label, p) => (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span style={{ fontSize: 8.5, fontWeight: 700, color: C_MUTED, width: 34, textAlign: "right", letterSpacing: 0.3 }}>{label}</span>
      <div style={{ flex: 1, height: 5, background: "rgba(116,131,157,0.15)", borderRadius: 3, overflow: "hidden" }}>
        <div style={{ width: `${Math.round(p * 100)}%`, height: "100%", background: C_YRFI, opacity: 0.45 + p * 0.55, borderRadius: 3 }} />
      </div>
      <span style={{ fontSize: 9, fontWeight: 700, color: C_INK, width: 28 }}>{Math.round(p * 100)}%</span>
    </div>
  );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, width: "100%" }} title="Chance a run scores in each half of the 1st">
      {row(`▲ ${awayAbbr}`, pTop)}
      {row(`▼ ${homeAbbr}`, pBot)}
    </div>
  );
}

// A row is settled once its 1st inning can no longer change: a finished inning,
// or a run already in (YRFI clinched). A game sitting in a scoreless 1st is NOT
// settled — firstInningResult hands back {pending:true}, which is an object and
// therefore truthy, and treating that as "has a result" is what broke the
// conviction sort: pending games were demoted into the graded group while the
// row itself still rendered as live. One definition, used by the sort and the
// render, so the two cannot disagree again.
export function isSettled(row) {
  return !!row.result && !row.result.pending;
}

/** Board order. "edge" = conviction: still-in-play first, settled games sink. */
export function sortSlateRows(rows, sortBy) {
  const arr = [...rows];
  if (sortBy !== "edge") return arr.sort((a, b) => a.time - b.time);
  return arr.sort((a, b) => {
    const as = isSettled(a), bs = isSettled(b);
    if (as !== bs) return as ? 1 : -1;
    return b.pred.edge - a.pred.edge;
  });
}

function ResultBadge({ result, lean, tier }) {
  if (result?.pending || result?.live) {
    const clinched = result?.live && result?.yrfi;
    return (
      <span style={{ fontSize: 10, fontWeight: 700, color: clinched ? C_YRFI : C_MUTED, background: "rgba(116,131,157,0.10)", padding: "4px 10px", borderRadius: 10 }}>
        {clinched ? "🔴 run in — YRFI" : "🔴 in the 1st…"}
      </span>
    );
  }
  const actual = result.yrfi ? "YRFI" : "NRFI";
  // Pass-tier games weren't picks — show the outcome without claiming a grade.
  if (tier === "pass")
    return (
      <span style={{ fontSize: 10.5, fontWeight: 700, color: C_MUTED, background: "rgba(116,131,157,0.10)", padding: "4px 10px", borderRadius: 10, whiteSpace: "nowrap" }}>
        {actual}{result.runs > 0 ? ` · ${result.runs}R` : ""} — no play
      </span>
    );
  const hit = actual === lean;
  return (
    <span style={{
      fontSize: 10.5, fontWeight: 800, color: hit ? C_GOOD : C_BAD,
      background: hit ? "rgba(15,138,68,0.10)" : "rgba(179,53,44,0.10)",
      border: `1px solid ${hit ? "rgba(15,138,68,0.35)" : "rgba(179,53,44,0.35)"}`,
      padding: "4px 10px", borderRadius: 10, whiteSpace: "nowrap",
    }}>
      {actual}{result.runs > 0 ? ` · ${result.runs}R` : ""} {hit ? "✓" : "✗"}
    </span>
  );
}

// ── Main board ───────────────────────────────────────────────────────────────
export default function FirstInning({ games, date, lineupData = {} }) {
  const [sweep, setSweep] = useState(null);
  const [today, setToday] = useState(null);
  const [err, setErr] = useState(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [lastSync, setLastSync] = useState(null);
  const [sortBy, setSortBy] = useState("edge"); // edge | time

  const dateStr = date || games?.[0]?.officialDate || formatDateInTimeZone();

  useEffect(() => {
    let dead = false;
    fetchSeasonSweep(dateStr)
      .then((s) => !dead && setSweep(s))
      .catch((e) => !dead && setErr(String(e?.message || e)));
    return () => { dead = true; };
  }, [dateStr]);

  useEffect(() => {
    if (!games?.length) return;
    let dead = false;
    const bust = refreshTick > 0;
    if (bust) setRefreshing(true);
    fetchTodayInputs(dateStr, games, { bust })
      .then((t) => {
        if (dead) return;
        setToday(t);
        setLastSync(new Date());
      })
      .catch((e) => !dead && setErr(String(e?.message || e)))
      .finally(() => !dead && setRefreshing(false));
    return () => { dead = true; };
  }, [dateStr, games, refreshTick]);

  // Lineups drop one card at a time across the afternoon and first innings settle
  // one game at a time across the evening. Without this the board shows whatever
  // was true the moment the tab was opened, for the rest of the session.
  const pendingCards = awaitingLineups(games || [], today);
  const moving = stillMoving(games || [], today, pendingCards);
  useEffect(() => {
    if (!moving) return;
    const id = setInterval(() => setRefreshTick((t) => t + 1), 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [moving]);

  const rows = useMemo(() => {
    if (!sweep || !today || !games?.length) return null;
    return games.map((g) => {
      const p = predictGame(g, { state: sweep.state, inputs: today });
      const rw = { home: lineupData[p.homeAbbr], away: lineupData[p.awayAbbr] };
      return {
        game: g, ...p,
        rwConfirmed: !!(rw.home?.confirmed && rw.away?.confirmed),
        result: firstInningResult(liveState(g, today)),
        time: new Date(g.gameDate),
      };
    });
  }, [sweep, today, games, lineupData]);

  const sorted = useMemo(() => {
    if (!rows) return null;
    return sortSlateRows(rows, sortBy);
  }, [rows, sortBy]);

  const summary = useMemo(() => {
    if (!rows) return null;
    const pending = rows.filter((r) => !r.result || r.result.pending);
    // The day's record counts only committed picks (lean/strong) — pass-tier
    // games display their outcome but were never plays.
    const graded = rows.filter((r) => r.result && !r.result.pending && !r.result.live && r.pred.tier !== "pass");
    const hits = graded.filter((r) => (r.result.yrfi ? "YRFI" : "NRFI") === r.pred.lean).length;
    const strong = rows.filter((r) => r.pred.tier === "strong").length;
    const lean = rows.filter((r) => r.pred.tier === "lean").length;
    return { pending: pending.length, graded: graded.length, hits, strong, lean, pass: rows.length - strong - lean };
  }, [rows]);

  if (err)
    return <div style={{ padding: "40px 20px", textAlign: "center", color: C_BAD, fontSize: 13 }}>1st Inning board failed to load: {err}</div>;
  if (!games?.length)
    return <div style={{ padding: "40px 20px", textAlign: "center", color: C_MUTED }}>No games on the slate.</div>;
  if (!sorted)
    return (
      <div style={{ padding: "30px 20px" }}>
        <Loader text={sweep ? "Loading today's lineups & starter form…" : "Sweeping season first-inning history…"} />
      </div>
    );

  return (
    <div style={{ padding: "16px 20px 40px", maxWidth: 1080, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 4 }}>
        <div>
          <span style={{ fontSize: 20, fontWeight: 800, color: C_INK }}>1st Inning</span>
          <span style={{ fontSize: 12, color: C_MUTED, marginLeft: 10 }}>
            NRFI / YRFI · half-inning model · starter form × top of the order × venue
          </span>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: 9.5, color: C_MUTED, background: "rgba(116,131,157,0.10)", padding: "3px 8px", borderRadius: 8 }}>
            model {NRFI_PARAMS_VERSION} · no odds — pure prediction
          </span>
          {lastSync && (
            <span style={{ fontSize: 9.5, color: C_MUTED }} title="Last lineup sync">
              lineups {games.length - pendingCards}/{games.length} ·{" "}
              {lastSync.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: APP_TIME_ZONE })}
            </span>
          )}
          <button
            onClick={() => setRefreshTick((t) => t + 1)}
            disabled={refreshing}
            title="Re-read today's posted batting orders from the MLB schedule"
            style={{
              fontSize: 10, fontWeight: 700, padding: "4px 10px", borderRadius: 8,
              cursor: refreshing ? "default" : "pointer",
              background: "rgba(32,98,200,0.08)", border: "1px solid rgba(32,98,200,0.25)", color: C_NRFI,
              opacity: refreshing ? 0.55 : 1,
            }}
          >
            {refreshing ? "↻ syncing…" : "↻ lineups"}
          </button>
        </div>
      </div>

      {/* Summary strip */}
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center", padding: "8px 0 14px", borderBottom: `1px solid ${C_LINE}`, marginBottom: 6 }}>
        <span style={{ fontSize: 11, color: C_MUTED }}>
          <b style={{ color: C_INK }}>{games.length}</b> games
        </span>
        <span style={{ fontSize: 11, color: C_MUTED }}>
          <b style={{ color: C_INK }}>{summary.strong}</b> strong · <b style={{ color: C_INK }}>{summary.lean}</b> lean · {summary.pass} pass
        </span>
        {summary.graded > 0 && (
          <span style={{ fontSize: 11, fontWeight: 700, color: summary.hits * 2 >= summary.graded ? C_GOOD : C_BAD }}>
            today {summary.hits}–{summary.graded - summary.hits}
          </span>
        )}
        <span style={{ fontSize: 10, color: C_MUTED, marginLeft: "auto" }}>
          sort:{" "}
          {["edge", "time"].map((k) => (
            <button key={k} onClick={() => setSortBy(k)} style={{
              fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 6, cursor: "pointer", marginLeft: 4,
              background: sortBy === k ? "rgba(32,98,200,0.12)" : "transparent",
              border: sortBy === k ? "1px solid rgba(32,98,200,0.3)" : "1px solid transparent",
              color: sortBy === k ? C_NRFI : C_MUTED,
            }}>
              {k === "edge" ? "conviction" : "first pitch"}
            </button>
          ))}
        </span>
      </div>

      {/* Rows */}
      {sorted.map((r) => {
        const g = r.game;
        const [awayCol] = getTeamColor(g.teams?.away?.team?.id);
        const [homeCol] = getTeamColor(g.teams?.home?.team?.id);
        const decided = isSettled(r);
        const p = r.pred;
        return (
          <div key={g.gamePk} style={{
            display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap",
            padding: "13px 14px", marginBottom: 8, borderRadius: 12,
            background: decided ? "rgba(116,131,157,0.05)" : "#fff",
            border: `1px solid ${p.tier === "strong" && !decided ? (p.lean === "YRFI" ? "rgba(194,87,15,0.45)" : "rgba(32,98,200,0.45)") : C_LINE}`,
            boxShadow: p.tier === "strong" && !decided ? "0 1px 6px rgba(22,35,60,0.07)" : "none",
            opacity: decided ? 0.82 : 1,
          }}>
            {/* Matchup */}
            <div style={{ width: 200, minWidth: 170 }}>
              <div style={{ fontSize: 13.5, fontWeight: 800, color: C_INK, display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: awayCol, display: "inline-block" }} />
                {r.awayAbbr}
                <span style={{ color: C_MUTED, fontWeight: 500 }}>@</span>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: homeCol, display: "inline-block" }} />
                {r.homeAbbr}
                <span style={{ fontSize: 10, color: C_MUTED, fontWeight: 600, marginLeft: 2 }}>
                  {r.time.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: APP_TIME_ZONE })}
                </span>
              </div>
              <div style={{ fontSize: 10, color: C_MUTED, marginTop: 3, lineHeight: 1.5 }}>
                {r.awayProb?.fullName || "TBD"} · {r.homeProb?.fullName || "TBD"}
              </div>
              <div style={{ fontSize: 9, marginTop: 2, color: r.lineupsPosted ? C_GOOD : C_MUTED, fontWeight: 600 }}>
                {r.lineupsPosted ? "✓ lineups official" : r.rwConfirmed ? "◐ RW confirmed — avg lineup used" : "⏳ lineups pending — avg lineup used"}
              </div>
            </div>

            {/* Half bars */}
            <div style={{ flex: "1 1 150px", minWidth: 140, maxWidth: 210 }}>
              <HalfBars pTop={p.pTop} pBot={p.pBot} awayAbbr={r.awayAbbr} homeAbbr={r.homeAbbr} />
            </div>

            {/* Gauge + headline number */}
            <div style={{ flex: "1 1 170px", minWidth: 150, maxWidth: 240, display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ flex: 1 }}>
                <ConfidenceGauge p={p.pYrfi} />
              </div>
              <div style={{ textAlign: "right", minWidth: 58 }}>
                <div style={{ fontSize: 19, fontWeight: 800, color: C_INK, lineHeight: 1 }}>
                  {Math.round((p.lean === "YRFI" ? p.pYrfi : 1 - p.pYrfi) * 100)}%
                </div>
                <div style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: 0.6, color: p.lean === "YRFI" ? C_YRFI : C_NRFI }}>
                  {p.lean} CHANCE
                </div>
              </div>
            </div>

            {/* Projected runs + O/U 0.5 */}
            <div style={{ width: 108, textAlign: "center" }}>
              <div style={{ fontSize: 13, fontWeight: 800, color: C_INK }}>{p.projRuns.toFixed(2)}</div>
              <div style={{ fontSize: 8.5, color: C_MUTED, letterSpacing: 0.5, fontWeight: 600, marginBottom: 3 }}>PROJ 1ST-INN R</div>
              <span style={{
                fontSize: 9.5, fontWeight: 800, padding: "2px 8px", borderRadius: 8,
                color: p.lean === "YRFI" ? C_YRFI : C_NRFI,
                background: p.lean === "YRFI" ? "rgba(194,87,15,0.10)" : "rgba(32,98,200,0.10)",
              }}>
                {p.lean === "YRFI" ? "OVER" : "UNDER"} 0.5
              </span>
            </div>

            {/* Verdict / result */}
            <div style={{ width: 118, display: "flex", justifyContent: "flex-end" }}>
              {decided ? <ResultBadge result={r.result} lean={p.lean} tier={p.tier} /> : <TierChip tier={p.tier} lean={p.lean} />}
            </div>
          </div>
        );
      })}

      {/* Footnote */}
      <div style={{ fontSize: 10, color: C_MUTED, marginTop: 14, lineHeight: 1.7 }}>
        Backtest (rolling-origin, May–Jul 2026): 56.9% on committed picks (|p−50| ≥ 4pp) vs 52.5% always-YRFI baseline · AUC .543, positive every month.
        ★ strong = model ≥ 57/43 lean · sample: {sweep.sampleSize} games of first-inning history · projected runs = P(run) × league runs-per-scoring-half.
        Started games self-grade against the model's pre-game lean.
      </div>
    </div>
  );
}
