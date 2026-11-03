import { useEffect, useMemo, useState } from "react";
import { gradeAllLines } from "../lib/models.js";
import { buildParlays } from "../lib/parlays.js";

// ── Mobile detection hook (mirrors App.jsx/PayrollBoard.jsx pattern) ─────────
function useIsMobile(breakpoint = 900) {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth < breakpoint : false
  );
  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < breakpoint);
    window.addEventListener("resize", handler, { passive: true });
    return () => window.removeEventListener("resize", handler);
  }, [breakpoint]);
  return isMobile;
}

// Brain Trust only prices legs off FanDuel and DraftKings — the two books with reliable
// player-prop coverage. Each leg (and each slip) tracks which book gave the better price.
const BOOK_LABEL = { fanduel: "FanDuel", draftkings: "DraftKings" };
const BOOK_ABBR = { fanduel: "FD", draftkings: "DK" };
const BOOK_COLOR = { fanduel: "#2062c8", draftkings: "#0f8a44" };

const bestFdDk = bookObj => {
  if (!bookObj) return { price: null, book: null };
  const fd = bookObj.fanduel, dk = bookObj.draftkings;
  if (fd == null && dk == null) return { price: null, book: null };
  if (fd == null) return { price: dk, book: "draftkings" };
  if (dk == null) return { price: fd, book: "fanduel" };
  return fd >= dk ? { price: fd, book: "fanduel" } : { price: dk, book: "draftkings" };
};

const americanToDecimal = a => (a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a));
const decimalToAmerican = d => (d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)));

// A parlay must be booked at ONE sportsbook. Given each leg's raw FD/DK prices, find which
// book (if any) covers every leg, and rank those by combined payout — best one is the pick.
function slipBookOptions(slip) {
  const options = [];
  for (const book of ["fanduel", "draftkings"]) {
    const key = book === "fanduel" ? "fanduelOdds" : "draftkingsOdds";
    if (slip.legs.every(l => l[key] != null)) {
      const dec = slip.legs.reduce((d, l) => d * americanToDecimal(l[key]), 1);
      options.push({ book, decimal: dec, american: decimalToAmerican(dec) });
    }
  }
  options.sort((a, b) => b.decimal - a.decimal);
  return options;
}

// Market → Odds API keys (static config; mirrors App.jsx PROP_MARKETS). Brain Trust reads the
// model's FULL per-line surface (gradeAllLines) for these, including the low-alt legs the
// existing boards' findBestLine selection deliberately skips.
const BATTER_MARKETS = [
  { key: "hits", std: "batter_hits", alt: "batter_hits_alternate", label: "Hits" },
  { key: "hrr", std: "batter_hits_runs_rbis", alt: "batter_hits_runs_rbis_alternate", label: "H+R+RBI" },
  { key: "tb", std: "batter_total_bases", alt: "batter_total_bases_alternate", label: "TB" },
  { key: "rbi", std: "batter_rbis", alt: "batter_rbis_alternate", label: "RBI" },
  { key: "hr", std: "batter_home_runs", alt: "batter_home_runs_alternate", label: "HR" },
  { key: "sb", std: "batter_stolen_bases", alt: "batter_stolen_bases_alternate", label: "SB" },
];
const KS_MARKET = { key: "ks", std: "pitcher_strikeouts", alt: "pitcher_strikeouts_alternate", label: "Ks" };

const fmtOdds = a => (a == null ? "—" : a > 0 ? `+${a}` : `${a}`);
const fmtPct = p => (p == null ? "—" : `${(100 * p).toFixed(0)}%`);
const fmtPctEdge = p => (p == null ? "—" : `${p >= 0 ? "+" : ""}${(100 * p).toFixed(1)}pp`);
const edgeColor = e => (e == null ? "#74839d" : e >= 0.05 ? "#0f8a44" : e >= 0 ? "#1c9a50" : "#d03131");

export default function BrainTrust({ enrichedScanData, propOddsMap, lookupBookOdds, getAllLinesFromMap }) {
  const [view, setView] = useState("predictions"); // "predictions" | "parlays"
  const [minEdge, setMinEdge] = useState(0); // straight-prediction edge filter
  const [trustedOnly, setTrustedOnly] = useState(true); // hide directional (over-confident) lines by default

  const { rows, legs } = useMemo(() => {
    const rows = [];  // every graded line with a book price (the model's surface)
    const legs = [];  // parlay-eligible: trusted + positive edge
    if (!propOddsMap || !enrichedScanData) return { rows, legs };

    const oddsByLine = (name, m) => {
      const lines = getAllLinesFromMap(propOddsMap, name, m.std, m.alt);
      const prices = {}, books = {}, raw = {};
      for (const line of lines) {
        const bookOdds = lookupBookOdds(propOddsMap, name, m.std, m.alt, line);
        const { price, book } = bestFdDk(bookOdds);
        if (price != null) {
          prices[line] = price;
          books[line] = book;
          raw[line] = { fanduel: bookOdds?.fanduel ?? null, draftkings: bookOdds?.draftkings ?? null };
        }
      }
      return { prices, books, raw };
    };
    const ingest = (name, gamePk, team, opp, m, score) => {
      if (!Number.isFinite(score) || score <= 0) return;
      const { prices, books, raw } = oddsByLine(name, m);
      const grid = gradeAllLines(score, m.key, prices);
      for (const r of grid) {
        // Show the model's full per-line surface as soon as the scan runs — book odds (which post
        // hours later) only add the Book/Edge/EV columns and parlay eligibility on top.
        const book = books[r.line] ?? null;
        const row = { name, gamePk, team, opp, market: m.key, marketLabel: m.label, book, ...r };
        rows.push(row);
        // Parlay-eligible legs need a real price. Value gates on combined EV; Safe wants
        // high-probability anchors (e.g. HRR O0.5) even when their edge is flat. Raw per-book
        // prices ride along so a slip can later find the one book that covers every leg.
        if (r.trust === "trusted" && r.bookOdds != null) {
          legs.push({ id: `${name}|${m.key}|${r.line}`, player: name, gamePk, team, opp,
            market: m.key, marketLabel: m.label, line: r.line,
            modelProb: r.modelProb, bookOdds: r.bookOdds, edge: r.edge, ev: r.ev, trust: r.trust,
            book, fanduelOdds: raw[r.line]?.fanduel ?? null, draftkingsOdds: raw[r.line]?.draftkings ?? null });
        }
      }
    };

    for (const p of enrichedScanData.players || []) {
      for (const m of BATTER_MARKETS) ingest(p.name, p.gamePk, p.team, p.opponent, m, p.models?.[m.key]?.score);
    }
    for (const p of enrichedScanData.pitchers || []) {
      ingest(p.name, p.gamePk, p.team, p.opponent, KS_MARKET, Number(p.xK));
    }
    return { rows, legs };
  }, [enrichedScanData, propOddsMap, lookupBookOdds, getAllLinesFromMap]);

  // Two flavors: Value (beat the price, higher odds) and Safe (most likely to hit, low-alt anchors).
  // haircut shrinks each leg toward the book before combining — discounts tail-overconfidence on
  // the max-edge legs a slip selects. Value over-reaches most, so it gets the larger hedge.
  const valueParlays = useMemo(() => buildParlays(legs, { rankBy: "ev", minEv: 0.05, minLegProb: 0.45, haircut: 0.33, maxResults: 8 }), [legs]);
  const safeParlays = useMemo(() => buildParlays(legs, { rankBy: "jointProb", minEv: -1, minLegProb: 0.55, minJointProb: 0.33, minCombinedDecimal: 2.0, haircut: 0.25, maxResults: 8 }), [legs]);

  const predictions = useMemo(() => {
    return rows
      // unpriced lines (no edge yet) show only when no edge bar is set; an edge filter implies a price
      .filter(r => (!trustedOnly || r.trust === "trusted") && (r.edge == null ? minEdge <= 0 : r.edge >= minEdge))
      .sort((a, b) => {
        const ea = a.edge == null ? -Infinity : a.edge, eb = b.edge == null ? -Infinity : b.edge;
        return eb !== ea ? eb - ea : b.modelProb - a.modelProb;
      })
      .slice(0, 100);
  }, [rows, minEdge, trustedOnly]);

  const hasScan = (enrichedScanData?.players?.length || 0) > 0;
  const oddsPosted = rows.some(r => r.bookOdds != null);

  return (
    <div style={{ padding: "16px 20px", maxWidth: 1400, margin: "0 auto" }}>
      <div style={{ marginBottom: 14 }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, color: "#14213a", margin: "0 0 4px" }}>💎 Brain Trust</h2>
        <p style={{ fontSize: 12, color: "#64748d", margin: 0, lineHeight: 1.5 }}>
          The model's <b>full per-line surface</b> — every posted line, including the low-alt legs the
          boards skip. <span style={{ color: "#0f8a44" }}>Trusted</span> lines are backtest-calibrated
          (alt-line-backtest, ECE ≤ ~8pp); <span style={{ color: "#a16207" }}>directional</span> lines have
          rank-order power but a biased level — shown, never bet. Parlays admit only trusted, edge-positive,
          cross-game legs and ship only if they beat their combined price. Priced off <b>FanDuel</b> and
          <b> DraftKings</b> only — each line and each parlay slip recommends the book to take it on.
        </p>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 14, alignItems: "center", flexWrap: "wrap" }}>
        {["predictions", "parlays"].map(v => (
          <button key={v} onClick={() => setView(v)}
            style={{ padding: "6px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer",
              borderRadius: 6, border: "1px solid",
              borderColor: view === v ? "#2062c8" : "rgba(32,98,200,0.24)",
              background: view === v ? "rgba(32,98,200,0.192)" : "transparent",
              color: view === v ? "#2062c8" : "#74839d", textTransform: "capitalize" }}>
            {v === "predictions" ? "🎯 Predictions" : "🎲 Parlays"}
          </button>
        ))}
        {view === "predictions" && (
          <label style={{ fontSize: 11, color: "#64748d", marginLeft: "auto", display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}
            title="Directional lines (e.g. high-K overs) have rank-order power but a biased level — they manufacture phantom edge. Trusted lines are backtest-calibrated.">
            <input type="checkbox" checked={trustedOnly} onChange={e => setTrustedOnly(e.target.checked)} style={{ cursor: "pointer" }} />
            trusted only
          </label>
        )}
        {view === "predictions" && (
          <label style={{ fontSize: 11, color: "#64748d", display: "flex", gap: 6, alignItems: "center" }}>
            min edge
            <select value={minEdge} onChange={e => setMinEdge(Number(e.target.value))}
              style={{ background: "#ffffff", color: "#14213a", border: "1px solid rgba(32,98,200,0.2)", borderRadius: 4, padding: "3px 6px", fontSize: 11 }}>
              <option value={-1}>all</option>
              <option value={0}>0%+</option>
              <option value={0.03}>3%+</option>
              <option value={0.05}>5%+</option>
            </select>
          </label>
        )}
      </div>

      {!oddsPosted && hasScan && (
        <div style={{ fontSize: 12, color: "#a16207", background: "rgba(161,98,7,0.08)", border: "1px solid rgba(161,98,7,0.2)", borderRadius: 8, padding: "10px 12px", marginBottom: 14, lineHeight: 1.5 }}>
          ⏳ Player-prop odds haven't posted for today's slate yet — showing the model's predictions only.
          Book / Edge / EV and the parlay builder fill in once books post lines (usually a few hours before first pitch).
        </div>
      )}
      {!hasScan ? (
        <div style={{ color: "#74839d", fontSize: 13, padding: "40px 0", textAlign: "center" }}>
          Waiting for the scan to load…
        </div>
      ) : view === "predictions" ? (
        <PredictionsTable rows={predictions} total={rows.length} oddsPosted={oddsPosted} />
      ) : (
        <ParlaysView valueParlays={valueParlays} safeParlays={safeParlays} legCount={legs.length} oddsPosted={oddsPosted} />
      )}
    </div>
  );
}

function trustBadge(trust) {
  const trusted = trust === "trusted";
  return (
    <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 8,
      color: trusted ? "#0f8a44" : "#a16207",
      background: trusted ? "rgba(15,138,68,0.13)" : "rgba(161,98,7,0.13)" }}>
      {trusted ? "TRUSTED" : "DIRECTIONAL"}
    </span>
  );
}

function PredictionsTable({ rows, total, oddsPosted }) {
  if (!rows.length) return <div style={{ color: "#74839d", fontSize: 13, padding: "30px 0", textAlign: "center" }}>No lines clear that edge filter.</div>;
  const th = { textAlign: "right", padding: "6px 10px", fontSize: 10, color: "#74839d", fontWeight: 600, textTransform: "uppercase", whiteSpace: "nowrap" };
  const td = { textAlign: "right", padding: "6px 10px", fontSize: 12, color: "#3c4f6d", fontFamily: "'JetBrains Mono',monospace", whiteSpace: "nowrap" };
  return (
    <>
      <div style={{ fontSize: 11, color: "#74839d", marginBottom: 6 }}>
        Top {rows.length} of {total} lines, by {oddsPosted ? "model edge over the book" : "model probability (book/edge fill in once odds post)"}.
      </div>
      <div className="hscroll" style={{ border: "1px solid rgba(32,98,200,0.16)", borderRadius: 8 }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "rgba(225,231,242,0.5)" }}>
              <th style={{ ...th, textAlign: "left" }}>Player</th>
              <th style={{ ...th, textAlign: "left" }}>Prop</th>
              <th style={th}>Model</th><th style={th}>Fair</th><th style={th}>Book</th>
              <th style={th}>Edge</th><th style={th}>EV</th><th style={{ ...th, textAlign: "center" }}>Trust</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} style={{ borderTop: "1px solid rgba(32,98,200,0.096)" }}>
                <td style={{ ...td, textAlign: "left", color: "#14213a", fontFamily: "inherit", fontWeight: 600 }}>
                  {r.name}<span style={{ color: "#74839d", fontWeight: 400, fontSize: 10 }}> {r.team}{r.opp ? ` v ${r.opp}` : ""}</span>
                </td>
                <td style={{ ...td, textAlign: "left", fontFamily: "inherit" }}>{r.marketLabel} <b>O{r.line}</b></td>
                <td style={td}>{fmtPct(r.modelProb)}</td>
                <td style={{ ...td, color: "#64748d" }}>{fmtOdds(r.fairOdds)}</td>
                <td style={td}>
                  {fmtOdds(r.bookOdds)}
                  {r.book && <span style={{ marginLeft: 4, fontSize: 9, fontWeight: 700, color: BOOK_COLOR[r.book] }}>{BOOK_ABBR[r.book]}</span>}
                </td>
                <td style={{ ...td, color: edgeColor(r.edge), fontWeight: 700 }}>{fmtPctEdge(r.edge)}</td>
                <td style={{ ...td, color: r.ev >= 0 ? "#0f8a44" : "#d03131" }}>{r.ev == null ? "—" : `${r.ev >= 0 ? "+" : ""}${(100 * r.ev).toFixed(0)}%`}</td>
                <td style={{ ...td, textAlign: "center" }}>{trustBadge(r.trust)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function ParlayCard({ slip, accent }) {
  const bookOptions = slipBookOptions(slip);
  const bestBook = bookOptions[0] || null;
  return (
    <div style={{ border: `1px solid ${accent}26`, borderRadius: 10, padding: 14, background: "rgba(225,231,242,0.4)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, flexWrap: "wrap", gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: accent }}>{slip.legCount}-leg · {fmtOdds(slip.combinedAmerican)}</span>
        <div style={{ display: "flex", gap: 14, fontSize: 11, fontFamily: "'JetBrains Mono',monospace" }}>
          <span style={{ color: "#3c4f6d" }}>hit {fmtPct(slip.jointProb)}</span>
          <span style={{ color: "#64748d" }}>book {fmtPct(slip.bookImpliedProb)}</span>
          <span style={{ color: edgeColor(slip.edge), fontWeight: 700 }}>edge {fmtPctEdge(slip.edge)}</span>
          <span style={{ color: slip.ev >= 0 ? "#0f8a44" : "#d03131", fontWeight: 700 }}>EV {slip.ev >= 0 ? "+" : ""}{(100 * slip.ev).toFixed(0)}%</span>
        </div>
      </div>
      <div style={{ marginBottom: 10 }}>
        {bestBook ? (
          <span style={{ fontSize: 10, fontWeight: 700, padding: "3px 8px", borderRadius: 8,
            color: BOOK_COLOR[bestBook.book], background: `${BOOK_COLOR[bestBook.book]}1f` }}>
            📖 book this on {BOOK_LABEL[bestBook.book]} · {fmtOdds(bestBook.american)}
          </span>
        ) : (
          <span style={{ fontSize: 10, fontWeight: 700, padding: "3px 8px", borderRadius: 8, color: "#a16207", background: "rgba(161,98,7,0.13)" }}>
            ⚠ no single book covers every leg — shop each leg by its badge below
          </span>
        )}
      </div>
      <div style={{ display: "grid", gap: 6 }}>
        {slip.legs.map((l, j) => (
          <div key={j} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "4px 8px", background: "rgba(32,98,200,0.08)", borderRadius: 5 }}>
            <span style={{ color: "#14213a" }}>{l.player} <span style={{ color: "#74839d", fontSize: 10 }}>{l.team}{l.opp ? ` v ${l.opp}` : ""}</span></span>
            <span style={{ fontFamily: "'JetBrains Mono',monospace", color: "#3c4f6d" }}>
              {l.marketLabel} O{l.line} · {fmtPct(l.probUsed ?? l.modelProb)} · {fmtOdds(l.bookOdds)}
              {l.book && <span style={{ marginLeft: 3, fontWeight: 700, color: BOOK_COLOR[l.book] }}>{BOOK_ABBR[l.book]}</span>}
              {" "}<span style={{ color: edgeColor(l.edge) }}>{fmtPctEdge(l.edge)}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ParlaySection({ title, accent, blurb, slips, emptyMsg }) {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 4 }}>
        <h3 style={{ fontSize: 14, fontWeight: 700, color: accent, margin: 0 }}>{title}</h3>
        <span style={{ fontSize: 11, color: "#64748d" }}>{blurb}</span>
      </div>
      {slips.length ? (
        <div style={{ display: "grid", gap: 12 }}>{slips.map((s, i) => <ParlayCard key={i} slip={s} accent={accent} />)}</div>
      ) : (
        <div style={{ color: "#74839d", fontSize: 12, padding: "16px 0" }}>{emptyMsg}</div>
      )}
    </div>
  );
}

function ParlaysView({ valueParlays, safeParlays, legCount, oddsPosted }) {
  const isMobile = useIsMobile();
  if (!oddsPosted) {
    return (
      <div style={{ color: "#74839d", fontSize: 13, padding: "30px 0", textAlign: "center", lineHeight: 1.6 }}>
        Parlays need posted book prices to size the payout.<br />
        <span style={{ fontSize: 11 }}>No player-prop odds for today's slate yet — check the Predictions tab for the model's read, and come back once books post lines.</span>
      </div>
    );
  }
  return (
    <div style={{ display: "grid", gap: 26 }}>
      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 20, alignItems: "start" }}>
        <ParlaySection
          title="🛡 Safe / High-Hit" accent="#0f8a44"
          blurb="ranked by hit chance — low-alt anchors (HRR O0.5, low-K); EV shown, not gated"
          slips={safeParlays}
          emptyMsg={`No high-probability slips clear 40% combined hit chance right now.`} />
        <ParlaySection
          title="🎯 Value" accent="#2062c8"
          blurb="ranked by EV — beats the combined price by 5%+, higher odds"
          slips={valueParlays}
          emptyMsg={`No positive-EV slips from ${legCount} trusted legs right now.`} />
      </div>
      <div style={{ fontSize: 11, color: "#74839d", lineHeight: 1.5, borderTop: "1px solid rgba(32,98,200,0.128)", paddingTop: 10 }}>
        All legs are backtest-trusted, cross-game (independent), and priced off <b>FanDuel</b> and
        <b> DraftKings</b> only. <b>Safe</b> maximizes hit probability and may carry a negative EV (the book's
        juice on heavy favorites); <b>Value</b> maximizes edge over the book — that's the consistency-vs-EV
        tradeoff, shown honestly so you choose. Each slip is tagged with the single book that covers every leg
        at the best combined price (📖); if no book covers the whole slip, shop each leg by its FD/DK badge.
        Leg % and slip estimates are <b>hedged toward the market</b> (Value 33%, Safe 25%) to discount
        tail-overconfidence on the selected legs; the raw model read for every line is in the Predictions tab.
      </div>
    </div>
  );
}
