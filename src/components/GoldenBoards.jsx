import { useEffect, useState } from "react";
import { GOLDEN_BOARDS, isPlayPick, boardPlayLimit } from "../lib/goldenBoards.js";
import BookLogo from "./BookLogo.jsx";
import { BOOK_NAMES } from "./OddsLink.jsx";

// ── Golden boards ────────────────────────────────────────────────────────────
// Renders the three ranked boards written by scripts/golden-snapshot.mjs, one
// golden_snapshots row per (pick_date, board). Read-only: selection and grading
// both happen server-side, so this never re-ranks and never re-grades — it shows
// exactly what was locked and how it settled.
//
// Replaces the single Golden 10, which ranked saved official picks by
// goldenScore (0.6*conf + 0.4*prob). That board never looked at price and went
// 63.8% / -5.2% ROI over 57 days by loading up on Hits O0.5 chalk at an average
// of -238 against a 69.2% breakeven. See src/lib/goldenBoards.js for the split.

const fmtOdds = (o) => (o == null ? "—" : `${o > 0 ? "+" : ""}${o}`);
const fmtPct = (p) => (p == null ? "—" : `${(p * 100).toFixed(1)}%`);
const fmtPp = (e) => (e == null ? "—" : `${e >= 0 ? "+" : ""}${(e * 100).toFixed(1)}`);
const fmtU = (u) => (u == null ? "—" : `${u >= 0 ? "+" : ""}${Number(u).toFixed(2)}u`);

const C = {
  win: "#15803d", loss: "#b91c1c", pending: "#a16207",
  muted: "#74839d", rule: "#e6ebf3", head: "#16233c",
};

function ResultPill({ won }) {
  if (won == null) return <span style={{ color: C.pending, fontWeight: 700, fontSize: 11 }}>PEND</span>;
  return (
    <span style={{ color: won ? C.win : C.loss, fontWeight: 700, fontSize: 11 }}>
      {won ? "WIN" : "LOSS"}
    </span>
  );
}

// The boards are written server-side once the day's scan and odds have landed
// and the Brain Trust per-line surface they select from has been frozen.
//
// This used to promise "12:30 PM ET", which was the daily-picks.yml cron time
// and had not been true for a week: GitHub was delivering that schedule 2.9-3.5h
// late, so the boards actually locked at 3:24-4:00 PM ET, and on 2026-08-31 the
// fire was dropped and they never landed at all. Meanwhile this component
// switched to the flat "No board written for this date" at 1 PM ET — so on a
// normal, merely-late day the tab reported a failure for three hours. Naming an
// hour the pipeline does not hit is how a normal state gets read as a broken one.
//
// Two paths now write them, whichever gets there first (db/migrations/016): a
// pg_cron tick every 30 min from 10 AM ET that GitHub cannot drop, and the
// original daily-picks.yml steps. So the honest wait is not a clock time — it is
// the scan and odds landing, which is what this says.
const etParts = () => {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date());
  const get = (t) => f.find((p) => p.type === t)?.value;
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) };
};

// Player name cell. Clickable wherever the caller can hand back a scan row for
// the player (the Golden page can, because it holds today's scan; the Results
// page renders yesterday's boards and cannot), matching the dotted-underline
// affordance the props boards use for the opposing pitcher.
function PlayerCell({ pick, resolvePlayer }) {
  const open = resolvePlayer ? resolvePlayer(pick) : null;
  if (!open) {
    return <span style={{ fontWeight: 600, color: C.head }}>{pick.playerName}</span>;
  }
  return (
    <span
      onClick={open}
      title={`Open ${pick.playerName}`}
      style={{
        fontWeight: 600, color: C.head, cursor: "pointer",
        textDecoration: "underline", textDecorationStyle: "dotted",
        textDecorationColor: "rgba(22,35,60,0.35)",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.color = "#2062c8"; }}
      onMouseLeave={(e) => { e.currentTarget.style.color = C.head; }}
    >
      {pick.playerName}
    </span>
  );
}

function BoardTable({ cfg, row, emptyNote, resolvePlayer }) {
  const picks = row?.picks || [];
  const res = row?.results || null;
  const graded = !!row?.graded && !!res;

  return (
    <div style={{ marginBottom: 22, border: `1px solid ${C.rule}`, borderRadius: 10, overflow: "hidden" }}>
      <div style={{
        display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap",
        padding: "10px 14px", background: "#f7f9fc", borderBottom: `1px solid ${C.rule}`,
      }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: C.head, letterSpacing: 0.3 }}>
          🏆 {cfg.label}
        </span>
        {cfg.research && (
          <span style={{
            fontSize: 9, fontWeight: 700, letterSpacing: 0.8, textTransform: "uppercase",
            color: "#7c3aed", background: "#f3e8ff", border: "1px solid #ddd0f7",
            borderRadius: 4, padding: "2px 6px",
          }}>
            Research only
          </span>
        )}
        <span style={{ fontSize: 11, color: C.muted, flex: 1 }}>
          {cfg.blurb}
          {boardPlayLimit(cfg.key) != null && (
            <span style={{ color: C.ink, fontWeight: 600 }}>
              {" "}🎲 Top {boardPlayLimit(cfg.key)} are the plays — the rest is tracked research.
            </span>
          )}
        </span>
        {graded && (
          <span style={{ fontSize: 13, fontWeight: 700, color: res.units >= 0 ? C.win : C.loss }}>
            {res.wins}-{res.losses}
            {res.pending ? <span style={{ color: C.pending }}> ·{res.pending}p</span> : null}
            <span style={{ color: C.muted, fontWeight: 500 }}> · </span>
            {fmtPct(res.winRate)}
            <span style={{ color: C.muted, fontWeight: 500 }}> · </span>
            {fmtU(res.units)}
            {/* Units cover only priced picks — NRFI has no book, so it counts in
                the W-L but cannot contribute P/L. */}
            {res.pricedN != null && res.pricedN < res.n && (
              <span style={{ color: C.muted, fontWeight: 500, fontSize: 11 }}>
                {" "}({res.pricedN} priced)
              </span>
            )}
          </span>
        )}
      </div>

      {picks.length === 0 ? (
        <div style={{ padding: "18px 14px", color: C.muted, fontSize: 12 }}>
          {emptyNote}
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, minWidth: 620 }}>
            <thead>
              <tr style={{ color: C.muted, fontSize: 10, textTransform: "uppercase", letterSpacing: 0.6 }}>
                <th style={{ textAlign: "left", padding: "7px 10px", fontWeight: 600 }}>#</th>
                <th style={{ textAlign: "left", padding: "7px 10px", fontWeight: 600 }}>Market</th>
                <th style={{ textAlign: "left", padding: "7px 10px", fontWeight: 600 }}>Play</th>
                <th style={{ textAlign: "right", padding: "7px 10px", fontWeight: 600 }}>Odds</th>
                <th style={{ textAlign: "right", padding: "7px 10px", fontWeight: 600 }}>Model</th>
                <th style={{ textAlign: "right", padding: "7px 10px", fontWeight: 600 }}>Edge</th>
                <th style={{ textAlign: "right", padding: "7px 10px", fontWeight: 600 }}>Actual</th>
                <th style={{ textAlign: "right", padding: "7px 10px", fontWeight: 600 }}>Result</th>
              </tr>
            </thead>
            <tbody>
              {picks.map((p) => {
                // Trust the flag the snapshot stored; fall back to the current
                // line only for rows written before the play tier existed.
                const isPlay = typeof p.play === "boolean" ? p.play : isPlayPick(p.board, p.rank);
                // A heavier rule under the last play row makes the cut visible
                // without hiding anything: ranks below it stay on the board as
                // research, they just aren't bet.
                const lastPlay = isPlay && !picks.some((q) => q.rank === p.rank + 1 &&
                  (typeof q.play === "boolean" ? q.play : isPlayPick(q.board, q.rank)));
                return (
                <tr key={`${p.rank}-${p.playerName}-${p.market}-${p.line}`}
                  style={{
                    borderTop: `1px solid ${C.rule}`,
                    borderBottom: lastPlay ? `2px solid ${C.rule}` : undefined,
                    background: isPlay ? "rgba(32,98,200,0.05)" : undefined,
                    opacity: isPlay ? 1 : 0.72,
                  }}>
                  <td style={{ padding: "7px 10px", color: isPlay ? C.ink : C.muted, fontWeight: isPlay ? 700 : 400, whiteSpace: "nowrap" }}>
                    {isPlay && <span title="Play — inside this board's play line" style={{ marginRight: 4 }}>🎲</span>}
                    {p.rank}
                  </td>
                  <td style={{ padding: "7px 10px", whiteSpace: "nowrap" }}>
                    <span style={{ marginRight: 5 }}>{p.emoji}</span>{p.marketLabel}
                  </td>
                  <td style={{ padding: "7px 10px" }}>
                    <PlayerCell pick={p} resolvePlayer={resolvePlayer} />
                  </td>
                  <td style={{ padding: "7px 10px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, justifyContent: "flex-end" }}>
                      {p.book && (
                        <BookLogo
                          book={p.book} size={14}
                          title={`Best price: ${BOOK_NAMES[p.book] || p.book}`}
                        />
                      )}
                      {fmtOdds(p.bookOdds)}
                    </span>
                  </td>
                  <td style={{ padding: "7px 10px", textAlign: "right", fontVariantNumeric: "tabular-nums", color: C.muted }}>{fmtPct(p.modelProb)}</td>
                  <td style={{ padding: "7px 10px", textAlign: "right", fontVariantNumeric: "tabular-nums", color: p.edge >= 0 ? C.win : C.loss }}>{fmtPp(p.edge)}</td>
                  <td style={{ padding: "7px 10px", textAlign: "right", fontVariantNumeric: "tabular-nums", color: C.muted }}>{p.actual ?? "—"}</td>
                  <td style={{ padding: "7px 10px", textAlign: "right" }}>
                    {graded || p.won != null ? <ResultPill won={p.won} /> : <span style={{ color: C.muted, fontSize: 11 }}>—</span>}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * @param date          YYYY-MM-DD to render boards for.
 * @param title         heading above the set.
 * @param resolvePlayer optional (pick) => onClick | null. Returning a function
 *                      makes that row's player name open their panel; returning
 *                      null leaves it plain text (unmatched player, game-line
 *                      market, or a date whose scan isn't loaded).
 */
export default function GoldenBoards({ date, title, resolvePlayer }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (!date) return;
    let cancelled = false;
    setRows(null); setErr(null);
    const q = `pick_date=eq.${date}&board=neq.legacy&select=board,locked_at,picks,graded,results`;
    fetch(`/api/golden-snapshots?query=${encodeURIComponent(q)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) => { if (!cancelled) setRows(Array.isArray(data) ? data : []); })
      .catch((e) => { if (!cancelled) setErr(e?.message || String(e)); });
    return () => { cancelled = true; };
  }, [date]);

  const byBoard = {};
  for (const r of rows || []) byBoard[r.board] = r;

  const et = etParts();
  const emptyNote = date !== et.date
    ? "No board written for this date."
    : et.hour >= 17
      // Past 5 PM ET the slate is underway and the 30-minute retry has had all
      // day, so the scan or the odds genuinely never landed. Say what to do
      // about it instead of repeating "not written yet" into the evening.
      ? "Still not written — today's scan or odds never landed. Open the Today tab to run a scan; the boards follow within 30 minutes."
      : "Not written yet — the boards need today's scan and odds. Rechecked every 30 minutes until they land.";

  return (
    <div style={{ marginTop: 18 }}>
      {title && (
        <div style={{
          fontSize: 10, color: C.muted, textTransform: "uppercase",
          letterSpacing: 1, fontWeight: 600, marginBottom: 10,
        }}>
          {title} · {date}
        </div>
      )}
      {err && <div style={{ color: C.loss, fontSize: 12, marginBottom: 10 }}>Could not load boards: {err}</div>}
      {rows === null && !err && <div style={{ color: C.muted, fontSize: 12 }}>Loading boards…</div>}
      {rows !== null && GOLDEN_BOARDS.map((cfg) => (
        <BoardTable
          key={cfg.key} cfg={cfg} row={byBoard[cfg.key]}
          emptyNote={emptyNote} resolvePlayer={resolvePlayer} />
      ))}
    </div>
  );
}
