// ── Golden boards, as a record ───────────────────────────────────────────────
//
// The four Golden 10 boards side by side, on the same footing the market table
// puts hits and Ks. The Overview already renders YESTERDAY's boards; this is the
// other half of the question — over the window, which board is actually worth
// real money.
//
// WHY WIN% IS NOT THE HEADLINE HERE. The "10 Most Likely" board wins ~68% of its
// picks, which reads like the best thing on the site, and loses money doing it:
// its average price is about −237, where breakeven is 70.3%. So the lead column
// is GAP — win% minus the breakeven implied by the prices actually taken. Green
// gap means the board beat its prices. Everything else on the row supports it.
//
// Every number here is flat 1u. A board is a list of ten suggestions, not a
// staking plan, so there is no weighted track to show — sizing is the reader's
// decision and the drill-down's rank slice is what informs it.
import { Fragment, useEffect, useMemo, useState } from "react";
import { C, MONO, Card, Th, tdStyle, pnlColor, EmptyNote, Pill, Money } from "./primitives.jsx";
import { fmtUnits, MIN_N_VERDICT } from "../../lib/results.js";
import {
  goldenBoardRows, goldenEquity, byRankSlice, byGoldenMarket, byGoldenOddsBand,
  bestMoneySlice, worstMarket, inDateRange, MIN_SLICE_N,
} from "../../lib/goldenResults.js";
import EquityCurve from "./EquityCurve.jsx";

const pct = (v, d = 1) => (v == null ? "—" : `${v.toFixed(d)}%`);
const signedPct = (v, d = 1) => (v == null ? "—" : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}`);
const fmtOdds = (o) => (o == null ? "—" : `${o > 0 ? "+" : "−"}${Math.abs(o)}`);

// A day's record, exactly the way you'd say it out loud: 8-2, or 5-4-1 when
// something pushed.
const dayRecord = (d) =>
  `${d.wins}-${d.losses}${d.pushes ? `-${d.pushes}` : ""}`;

const GAP_HINT = "Win% minus the breakeven win rate implied by the prices actually taken. This is the number that decides whether a board makes money.";

function GapCell({ r, size = 13 }) {
  if (r.gap == null) return <span style={{ color: C.faint }}>—</span>;
  const thin = r.decided < MIN_N_VERDICT;
  return (
    <span title={`${pct(r.winPct)} actual vs ${pct(r.breakeven)} needed at ${fmtOdds(r.avgOdds)}`}
      style={{ fontFamily: MONO, fontWeight: 700, fontSize: size, color: thin ? C.muted : pnlColor(r.gap) }}>
      {signedPct(r.gap)}pp
    </span>
  );
}

const PLAY_HINT =
  "The ranks actually bet, not the whole board. `10 Most Likely` plays its top 3 " +
  "(+7.4% ROI over 52 days); ranks 4-10 stay on the board as tracked research and " +
  "are where its loss lives. Boards with no play line show — here.";

// The played record, which is the only column on this table that describes money
// you would actually have risked. A board can be well underwater overall and
// profitable where it counts — on `likely` that is the entire story — so this
// sits immediately after the board name rather than at the end of the row.
function PlayCell({ r, perUnit }) {
  if (!r.playDecided) {
    return <span style={{ color: C.faint }} title="This board has no play line — nothing on it is bet.">—</span>;
  }
  const thin = r.playDecided < MIN_N_VERDICT;
  return (
    <span title={`${r.playWins}-${r.playLosses} · ${pct(r.playWinPct)} vs a ${pct(r.playBreakeven)} breakeven · ${fmtUnits(r.playUnits)}`}
      style={{ fontFamily: MONO, fontSize: 11, whiteSpace: "nowrap" }}>
      <span style={{ color: C.green, fontWeight: 700 }}>{r.playWins}</span>
      <span style={{ color: C.faint }}>-</span>
      <span style={{ color: C.red, fontWeight: 700 }}>{r.playLosses}</span>
      <span style={{ marginLeft: 6, fontWeight: 700, color: thin ? C.muted : pnlColor(r.playUnits) }}>
        {fmtUnits(r.playUnits)}
      </span>
      <div style={{ fontSize: 9, color: thin ? C.faint : pnlColor(r.playRoiPct) }}>
        {r.playRoiPct == null ? "—" : `${r.playRoiPct >= 0 ? "+" : ""}${r.playRoiPct.toFixed(1)}%`}
        {thin && <span style={{ color: C.faint }}> · thin</span>}
      </div>
    </span>
  );
}

// One dot per graded DAY (not per pick) — a board plays ten picks a night, so
// per-pick dots would say nothing about whether the night was green.
function DayDots({ days, n = 12 }) {
  const last = days.slice(-n);
  if (!last.length) return <span style={{ color: C.faint }}>—</span>;
  return (
    <span style={{ display: "inline-flex", gap: 3 }}>
      {last.map((d) => (
        <span key={d.date}
          title={`${d.date} · ${dayRecord(d)} · ${fmtUnits(d.units)}`}
          style={{
            width: 9, height: 9, borderRadius: 2, display: "inline-block",
            background: d.units > 0 ? C.green : d.units < 0 ? C.red : C.faint,
            opacity: d.units === 0 ? 0.4 : 1,
          }} />
      ))}
    </span>
  );
}

const SORTS = {
  board: (r) => r.label,
  days: (r) => r.dayCount,
  win: (r) => (r.decided ? r.winPct : -1),
  gap: (r) => (r.gap ?? -999),
  units: (r) => r.units,
  roi: (r) => (r.roiPct ?? -999),
  play: (r) => (r.playRoiPct ?? -999),
  calib: (r) => (r.calibErr ?? -999),
};

/**
 * @param from  inclusive window start (null = open)
 * @param to    inclusive window end (null = open)
 * @param windowLabel  for the card title
 * @param perUnit      $/unit, from the Results control bar
 */
export default function GoldenTable({ from, to, windowLabel, perUnit }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  const [sort, setSort] = useState({ key: "gap", dir: "desc" });
  const [open, setOpen] = useState(null);

  // Day summaries only — every top-level number is derivable from the stored
  // `results` blobs, so the table never pulls a single pick until a row is
  // opened. The whole season of summaries is ~30 KB; the picks behind it are
  // closer to a megabyte.
  useEffect(() => {
    let dead = false;
    const q = "graded=eq.true&select=pick_date,board,results&order=pick_date.asc&limit=1000";
    fetch(`/api/golden-snapshots?query=${encodeURIComponent(q)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => { if (!dead) setRows(Array.isArray(d) ? d : []); })
      .catch((e) => { if (!dead) setErr(e?.message || String(e)); });
    return () => { dead = true; };
  }, []);

  const boards = useMemo(() => goldenBoardRows(rows || [], { from, to }), [rows, from, to]);

  const sorted = useMemo(() => {
    const out = [...boards].sort((a, b) => {
      const va = SORTS[sort.key](a), vb = SORTS[sort.key](b);
      const cmp = typeof va === "string" ? va.localeCompare(vb) : va - vb;
      return (sort.dir === "asc" ? cmp : -cmp);
    });
    // A closed board is history, not a contender — it sinks below the live ones
    // whatever the sort says, so the eye lands on a board you can still bet.
    return out.sort((a, b) => Number(a.closed) - Number(b.closed));
  }, [boards, sort]);

  const head = (key, label, align = "center", titleAttr) => (
    <Th align={align} active={sort.key === key} dir={sort.dir} title={titleAttr}
      onClick={() => setSort((s) => (s.key === key
        ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key, dir: key === "board" ? "asc" : "desc" }))}>
      {label}
    </Th>
  );

  const title = `Golden boards · ${windowLabel}`;

  if (err) return <Card title={title}><EmptyNote>Could not load board snapshots — {err}</EmptyNote></Card>;
  if (rows === null) return <Card title={title}><EmptyNote>Loading board records…</EmptyNote></Card>;
  if (!sorted.length) return <Card title={title}><EmptyNote>No graded board days in this window. Boards start 2026-06-18.</EmptyNote></Card>;

  return (
    <Card title={title} pad={false}
      right={<span style={{ fontSize: 10, color: C.muted }}>flat 1u per pick · every board judged against the price it actually got</span>}>
      <div className="hscroll">
        <table style={{ width: "100%", minWidth: 940, borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${C.rule}` }}>
              {head("board", "Board", "left")}
              {head("play", "Played", "center", PLAY_HINT)}
              {head("days", "Days", "center", "Graded days in this window")}
              <Th title="Wins-losses-pushes across the window. Scratched picks are excluded, never counted as losses.">W-L-P</Th>
              {head("win", "Win%")}
              <Th title="The win rate these exact prices need to break even, weighted by pick.">Breakeven</Th>
              {head("gap", "Gap", "center", GAP_HINT)}
              {head("units", "Units 1u")}
              {head("roi", "ROI", "center", "Return per 1u staked on priced picks")}
              <Th title="Realized P/L at your $/unit">$</Th>
              {head("calib", "Model−actual", "center", "Mean model probability minus the rate that actually hit. Positive = the board's probabilities are optimistic.")}
              <Th title="One dot per graded day — green if the day made units">Last 12 days</Th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const isOpen = open === r.board;
              return (
                <Fragment key={r.board}>
                  <tr onClick={() => setOpen(isOpen ? null : r.board)}
                    style={{
                      borderBottom: `1px solid ${C.ruleSoft}`, cursor: "pointer",
                      background: isOpen ? "rgba(32,98,200,0.06)" : "transparent",
                      opacity: r.closed ? 0.72 : 1,
                    }}>
                    <td style={{ ...tdStyle("left"), paddingLeft: 16, color: C.ink, fontWeight: 600 }}>
                      <span style={{ color: C.faint, marginRight: 6, fontSize: 10 }}>{isOpen ? "▾" : "▸"}</span>
                      🏆 {r.label}
                      {r.research && <span style={{ marginLeft: 7 }}><Pill color="#7c3aed" bg="#f3e8ff">research</Pill></span>}
                      {r.closed && <span style={{ marginLeft: 7 }}><Pill color={C.muted}>closed {r.lastDate}</Pill></span>}
                    </td>
                    <td style={tdStyle()}><PlayCell r={r} perUnit={perUnit} /></td>
                    <td style={tdStyle()}>{r.dayCount}</td>
                    <td style={{ ...tdStyle(), fontFamily: MONO }}>
                      <span style={{ color: C.green, fontWeight: 700 }}>{r.wins}</span>
                      <span style={{ color: C.faint }}>-</span>
                      <span style={{ color: C.red, fontWeight: 700 }}>{r.losses}</span>
                      {r.pushes > 0 && <><span style={{ color: C.faint }}>-</span><span style={{ color: C.amber }}>{r.pushes}</span></>}
                    </td>
                    <td style={{ ...tdStyle(), fontFamily: MONO, fontWeight: 600 }}>{pct(r.winPct)}</td>
                    <td style={{ ...tdStyle(), fontFamily: MONO, color: C.muted }}>
                      {pct(r.breakeven)}
                      <div style={{ fontSize: 9, color: C.faint }}>{fmtOdds(r.avgOdds)} avg</div>
                    </td>
                    <td style={tdStyle()}><GapCell r={r} /></td>
                    <td style={{ ...tdStyle(), fontFamily: MONO, fontWeight: 700, color: pnlColor(r.units) }}>{fmtUnits(r.units)}</td>
                    <td style={{ ...tdStyle(), fontFamily: MONO, color: pnlColor(r.roiPct) }}>
                      {r.roiPct == null ? "—" : `${r.roiPct >= 0 ? "+" : ""}${r.roiPct.toFixed(1)}%`}
                    </td>
                    <td style={tdStyle()}><Money units={r.units} perUnit={perUnit} /></td>
                    <td style={{ ...tdStyle(), fontFamily: MONO, color: r.calibErr == null ? C.faint : Math.abs(r.calibErr) > 5 ? C.amber : C.muted }}>
                      {r.calibErr == null ? "—" : `${signedPct(r.calibErr)}pp`}
                    </td>
                    <td style={tdStyle()}><DayDots days={r.days} /></td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={12} style={{ padding: 0, background: "rgba(32,98,200,0.03)", borderBottom: `1px solid ${C.rule}` }}>
                        <BoardDetail row={r} from={from} to={to} perUnit={perUnit} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ── Drill-down ───────────────────────────────────────────────────────────────
// Ordered by what you'd act on. How deep to bet (rank) comes first, because a
// board is not one bet — it is ten, and on the likely board the top three are
// profitable while the bottom four are not. Then what to cut (market), then
// where the prices hurt (band), then the receipts (daily log).

function BoardDetail({ row, from, to, perUnit }) {
  const [picks, setPicks] = useState(null);
  const [err, setErr] = useState(null);

  // No reset on the way in: the detail row is keyed by board in the table above,
  // so opening a different board unmounts this component and mounts a fresh one.
  // Clearing state here would only add a render.
  useEffect(() => {
    let dead = false;
    const q = `board=eq.${row.board}&graded=eq.true&select=pick_date,picks&order=pick_date.asc&limit=1000`;
    fetch(`/api/golden-snapshots?query=${encodeURIComponent(q)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => {
        if (dead) return;
        // Tag each pick with its date so the window filter below can work on a
        // flat list rather than re-walking the day rows for every slice.
        setPicks((Array.isArray(d) ? d : []).flatMap((r2) =>
          (r2.picks || []).map((p) => ({ ...p, pick_date: r2.pick_date }))));
      })
      .catch((e) => { if (!dead) setErr(e?.message || String(e)); });
    return () => { dead = true; };
  }, [row.board]);

  const inWindow = useMemo(
    () => (picks || []).filter((p) => inDateRange(p.pick_date, from, to)),
    [picks, from, to]
  );

  const eq = useMemo(() => goldenEquity(row.days), [row.days]);
  const ranks = useMemo(() => byRankSlice(inWindow), [inWindow]);
  const markets = useMemo(() => byGoldenMarket(inWindow), [inWindow]);
  const bands = useMemo(() => byGoldenOddsBand(inWindow), [inWindow]);
  const money = useMemo(() => bestMoneySlice(inWindow), [inWindow]);
  const drag = useMemo(() => worstMarket(inWindow), [inWindow]);

  const box = { background: "rgba(255,255,255,0.5)", border: `1px solid ${C.rule}`, borderRadius: 8, padding: 12 };
  const hdr = { fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: 1, fontWeight: 600, marginBottom: 8 };

  const miniRow = (label, r, key) => (
    <div key={key ?? label} style={{
      display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10,
      padding: "5px 0", borderBottom: `1px solid ${C.ruleSoft}`,
    }}>
      <span style={{ fontSize: 11, color: C.body, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>
      <span style={{ display: "flex", gap: 10, alignItems: "baseline", flexShrink: 0, fontFamily: MONO, fontSize: 10 }}>
        <span style={{ color: C.muted, minWidth: 46, textAlign: "right" }}>{r.wins}-{r.losses}{r.pushes ? `-${r.pushes}` : ""}</span>
        <span style={{ color: C.muted, minWidth: 40, textAlign: "right" }}>{pct(r.winPct, 0)}</span>
        <span style={{ minWidth: 52, textAlign: "right" }}><GapCell r={r} size={11} /></span>
        <span style={{ minWidth: 48, textAlign: "right", fontWeight: 700, color: pnlColor(r.units) }}>{fmtUnits(r.units)}</span>
      </span>
    </div>
  );

  const legend = (
    <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, fontSize: 9, color: C.faint, fontFamily: MONO, marginBottom: 4 }}>
      <span style={{ minWidth: 46, textAlign: "right" }}>W-L</span>
      <span style={{ minWidth: 40, textAlign: "right" }}>win%</span>
      <span style={{ minWidth: 52, textAlign: "right" }}>gap</span>
      <span style={{ minWidth: 48, textAlign: "right" }}>units</span>
    </div>
  );

  return (
    <div style={{ padding: 16, display: "grid", gap: 14 }}>

      {/* The one line in here that is an instruction rather than a record. */}
      <MoneyCallout row={row} money={money} drag={drag} loading={picks === null} perUnit={perUnit} />

      <div style={box}>
        <div style={hdr}>{row.label} — cumulative units, 1u per pick</div>
        <EquityCurve series={eq} height={150} showFlat={false} markers={false}
          mainLabel="Flat 1u per pick" mainKey="units" />
      </div>

      {err && <EmptyNote>Could not load this board&apos;s picks — {err}</EmptyNote>}
      {picks === null && !err && <EmptyNote>Loading picks…</EmptyNote>}

      {picks !== null && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 14 }}>
          <div style={box}>
            <div style={hdr}>How deep to bet</div>
            {legend}
            {ranks.length ? ranks.map((s) => miniRow(s.label, s, s.key))
              : <span style={{ fontSize: 11, color: C.muted }}>No ranked picks in this window.</span>}
            <div style={{ marginTop: 8, fontSize: 9, color: C.faint, lineHeight: 1.5 }}>
              A board is ten suggestions, not one bet. If the top slice clears its
              breakeven and the tail does not, the board is a shortlist — bet the top.
            </div>
          </div>

          <div style={box}>
            <div style={hdr}>What to cut · worst first</div>
            {legend}
            {markets.map((m) => miniRow(m.label, m, m.key))}
          </div>

          <div style={box}>
            <div style={hdr}>By price</div>
            {legend}
            {bands.length ? bands.map((b) => miniRow(b.label, b, b.key))
              : <span style={{ fontSize: 11, color: C.muted }}>No priced picks.</span>}
          </div>
        </div>
      )}

      <div style={box}>
        <div style={hdr}>Daily log · {row.dayCount} graded day{row.dayCount === 1 ? "" : "s"}</div>
        <DailyLog days={row.days} />
      </div>

      <div style={{ display: "flex", gap: 18, flexWrap: "wrap", fontSize: 11, color: C.muted }}>
        <span>{row.note}</span>
        {row.pricedN < row.decided && (
          <Pill color={C.amber}>{row.decided - row.pricedN} picks had no price — in the record, out of the units</Pill>
        )}
        {row.decided < MIN_N_VERDICT && <Pill color={C.amber}>thin sample — {row.decided} graded</Pill>}
      </div>
    </div>
  );
}

// The board's verdict in a sentence: where real money should sit, and what is
// dragging. Deliberately silent when the sample can't support a claim.
function MoneyCallout({ row, money, drag, loading, perUnit }) {
  const positive = row.gap != null && row.gap > 0;
  const base = {
    borderRadius: 8, padding: "12px 14px",
    border: `1px solid ${positive ? "rgba(15,138,68,0.3)" : "rgba(208,49,49,0.25)"}`,
    background: positive ? "rgba(15,138,68,0.07)" : "rgba(208,49,49,0.05)",
  };
  return (
    <div style={base}>
      <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: 1, fontWeight: 600, marginBottom: 6 }}>
        Real money verdict
      </div>
      <div style={{ fontSize: 13, color: C.ink, lineHeight: 1.6 }}>
        {row.decided < MIN_N_VERDICT ? (
          <>Only {row.decided} graded picks in this window — no verdict yet. Widen the window.</>
        ) : positive ? (
          <><b>Ahead of its prices</b> by {signedPct(row.gap)}pp — {row.wins}-{row.losses} at {pct(row.winPct)} against a {pct(row.breakeven)} breakeven,
            worth <b style={{ color: pnlColor(row.units) }}>{fmtUnits(row.units)}</b> (<Money units={row.units} perUnit={perUnit} size={13} bold={false} />).</>
        ) : (
          <><b>Behind its prices</b> by {signedPct(row.gap)}pp. It wins {pct(row.winPct)} of the time and still needs {pct(row.breakeven)} at
            {" "}{fmtOdds(row.avgOdds)} — a great hit rate bought at a worse price is a losing board.</>
        )}
      </div>

      {loading ? null : (
        <div style={{ marginTop: 8, display: "grid", gap: 5 }}>
          {money ? (
            <div style={{ fontSize: 12, color: C.ink }}>
              💰 <b>Bet ranks 1–{money.depth} only</b> — {money.wins}-{money.losses}, {pct(money.winPct)} vs {pct(money.breakeven)} breakeven,
              {" "}<b style={{ color: pnlColor(money.units) }}>{fmtUnits(money.units)}</b> at {money.roiPct >= 0 ? "+" : ""}{money.roiPct.toFixed(1)}% ROI over {money.decided} picks.
            </div>
          ) : (
            <div style={{ fontSize: 12, color: C.muted }}>
              No rank cut clears breakeven on {MIN_SLICE_N}+ picks in this window — there is no slice of this board to size up.
            </div>
          )}
          {drag && drag.decided >= 10 && (
            <div style={{ fontSize: 12, color: C.ink }}>
              ✂️ <b>{drag.market}</b> costs it {fmtUnits(drag.units)} over {drag.decided} picks. Without {drag.market} the board is
              {" "}<b style={{ color: pnlColor(drag.without.units) }}>{fmtUnits(drag.without.units)}</b> ({signedPct(drag.without.gap)}pp gap).
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// The receipts. Newest first — the question asked of a daily log is almost
// always "how have the last few nights gone", not "how did June open".
function DailyLog({ days }) {
  const [expanded, setExpanded] = useState(false);
  const ordered = [...days].reverse();
  const shown = expanded ? ordered : ordered.slice(0, 14);
  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(148px, 1fr))", gap: "5px 14px" }}>
        {shown.map((d) => (
          <div key={d.date} style={{
            display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8,
            padding: "3px 0", borderBottom: `1px solid ${C.ruleSoft}`, fontFamily: MONO, fontSize: 11,
          }}>
            <span style={{ color: C.muted }}>{d.date.slice(5)}</span>
            <span style={{ color: C.body, fontWeight: 600 }}>{dayRecord(d)}</span>
            <span style={{ color: pnlColor(d.units), fontWeight: 700, minWidth: 46, textAlign: "right" }}>
              {fmtUnits(d.units)}
            </span>
          </div>
        ))}
      </div>
      {ordered.length > 14 && (
        <button onClick={() => setExpanded((e) => !e)} style={{
          marginTop: 9, background: "transparent", border: "none", cursor: "pointer",
          fontSize: 10, color: C.blue, padding: 0,
        }}>
          {expanded ? "Show fewer" : `Show all ${ordered.length} days`}
        </button>
      )}
    </div>
  );
}
