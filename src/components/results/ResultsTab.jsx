// Results — the surface that decides whether a model change ships.
//
// Structure: one control bar governs every tab beneath it. The pre-revamp
// version forked this — the Dashboard and Windows sub-tabs each carried their
// own window state while sharing the stake and threshold toggles, so the same
// picks read differently depending on which tab you happened to be standing in.
// Everything below reads from a single `scored` set derived once, here.
import { useState, useMemo, useEffect } from "react";
import { getTodayInAppTimeZone } from "../../lib/utils.js";
import { pickMeetsCurrentThreshold, pickStakeUnits } from "../../lib/picks.js";
import {
  filterWindow, priorWindow, dailySeries, equitySeries, byMarket, hotCold,
  alarms, rollupBoth, shiftDays, windowBounds, WINDOWS, REVAMP_DATE, MIN_N_VERDICT,
} from "../../lib/results.js";
import { C, MONO, Chip, Toggle, ControlGroup } from "./primitives.jsx";
import OverviewTab from "./OverviewTab.jsx";
import MarketTable from "./MarketTable.jsx";
import GoldenTable from "./GoldenTable.jsx";
import DiagnosticsTab from "./DiagnosticsTab.jsx";
import ExperimentsTab from "./ExperimentsTab.jsx";
import LedgerTab from "./LedgerTab.jsx";
import DayDrawer from "./DayDrawer.jsx";

const TABS = [
  ["overview", "📊 Overview"],
  ["markets", "🎯 Markets"],
  ["diagnostics", "🔬 Diagnostics"],
  ["experiments", "🧪 Experiments"],
  ["ledger", "📋 Ledger"],
];

const PER_UNIT_KEY = "results.perUnit";

const MONTHS = ["January","February","March","April","May","June","July",
  "August","September","October","November","December"];
// "2026-08-10" → "August 10". Built off the app-timezone today, so the label
// re-reads correctly tomorrow rather than freezing on the day it was written.
const dayLabel = (d) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;

export default function ResultsTab({
  scanComplete, picks, picksLoading, saving, scoring, scoreMsg,
  picksError, clearPicksError, autoLog, loadPicks, saveTodayPicks, scorePicks, marketHealth,
}) {
  const [tab, setTab] = useState("overview");
  // Opens on Yesterday: "how did last night go" is the question this surface
  // gets asked most mornings. Any other window is one chip away.
  const [win, setWin] = useState("custom");
  const [custom, setCustom] = useState(() => {      // { from, to } when a day is pinned
    const y = shiftDays(getTodayInAppTimeZone(), -1);
    return { from: y, to: y };
  });
  const [modelOnly, setModelOnly] = useState(true);
  const [drawerDate, setDrawerDate] = useState(null);
  const [perUnit, setPerUnit] = useState(() => {
    const saved = Number(localStorage.getItem(PER_UNIT_KEY));
    return Number.isFinite(saved) && saved > 0 ? saved : 1.23;
  });
  useEffect(() => { localStorage.setItem(PER_UNIT_KEY, String(perUnit)); }, [perUnit]);

  const todayStr = getTodayInAppTimeZone();

  // Weighted stake: market base units × the edge-controller multiplier that was
  // in force on the pick's own date, so a suspended market contributes 0u rather
  // than being retroactively credited at today's multiplier.
  const weightedStakeOf = useMemo(
    () => (p) => pickStakeUnits(p.prop_type, marketHealth, p.pick_date),
    [marketHealth]
  );

  const allScored = useMemo(() => picks.filter(p => p.outcome && p.outcome !== "pending"), [picks]);
  const baseScored = useMemo(
    () => (modelOnly ? allScored.filter(pickMeetsCurrentThreshold) : allScored),
    [allScored, modelOnly]
  );
  const filteredOut = allScored.length - baseScored.length;

  const scored = useMemo(
    () => filterWindow(baseScored, win, todayStr, custom),
    [baseScored, win, todayStr, custom]
  );

  const stats = useMemo(() => rollupBoth(scored, weightedStakeOf), [scored, weightedStakeOf]);
  const daily = useMemo(() => dailySeries(scored, weightedStakeOf), [scored, weightedStakeOf]);
  const equity = useMemo(() => equitySeries(daily), [daily]);
  const calendarDaily = useMemo(
    // The calendar always shows the full history so you can navigate months
    // outside the active window; the window governs everything else.
    () => dailySeries(baseScored, weightedStakeOf), [baseScored, weightedStakeOf]
  );
  const marketRows = useMemo(() => {
    const prior = priorWindow(baseScored, win, todayStr, custom);
    return byMarket(scored, weightedStakeOf, prior);
  }, [scored, baseScored, win, todayStr, custom, weightedStakeOf]);
  const hot = useMemo(() => hotCold(baseScored, todayStr), [baseScored, todayStr]);
  // The Golden table filters golden_snapshots rows by date rather than reusing
  // `scored`, so it needs the window as bounds. Same control bar, same dates —
  // the only thing it can't share is the pick set, since board picks mostly do
  // not exist in mlb_picks at all (alternate lines, sub-threshold players).
  const goldenBounds = useMemo(
    () => windowBounds(win, todayStr, custom), [win, todayStr, custom]
  );
  const alarmItems = useMemo(
    () => alarms(baseScored, picks, todayStr, weightedStakeOf, win, custom),
    [baseScored, picks, todayStr, weightedStakeOf, win, custom]
  );

  // Derived after the memo block on purpose: passing `todayStr` into shiftDays
  // above it makes the React Compiler treat todayStr as possibly-mutated, which
  // costs every useMemo in this component its memoization.
  const yesterdayStr = shiftDays(todayStr, -1);
  const isYesterday = custom?.from === yesterdayStr && (custom.to || custom.from) === yesterdayStr;

  const windowLabel = isYesterday ? `Yesterday · ${dayLabel(yesterdayStr)}`
    : custom
    ? (custom.to && custom.to !== custom.from ? `${custom.from} → ${custom.to}` : custom.from)
    : win === "all" ? "All time"
    : win === "v2" ? `Since revamp (${REVAMP_DATE})`
    : `Last ${WINDOWS.find(w => w.key === win)?.days} days`;

  const goToMarket = () => setTab("markets");

  return (
    <div style={{ padding: "16px 20px 40px", maxWidth: 1400, margin: "0 auto" }}>

      {/* ── Header ───────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 19, fontWeight: 700, color: C.ink }}>Results</div>
          <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>
            {/* "0 picks tracked · 0 graded" is a claim about the record, and
                during the multi-page history read it is simply not true yet. */}
            {picksLoading && picks.length === 0 ? "Loading pick history…" : <>
              {picks.length.toLocaleString()} picks tracked · {allScored.length.toLocaleString()} graded ·{" "}
              <span style={{ color: C.amber }}>{picks.filter(p => p.outcome === "pending").length} pending</span>
            </>}
          </div>
        </div>
        {scanComplete && (
          <button onClick={saveTodayPicks} disabled={saving} style={{
            padding: "8px 16px", fontSize: 12, fontWeight: 600, borderRadius: 8,
            cursor: saving ? "not-allowed" : "pointer", background: "rgba(32,98,200,0.24)",
            border: "1px solid rgba(32,98,200,0.3)", color: C.blue, opacity: saving ? 0.6 : 1,
          }}>{saving ? "Saving…" : "📥 Save today's picks"}</button>
        )}
      </div>

      {picksError && (
        // A failed history read used to be a dead end — the banner said the
        // database timed out and the only way to ask again was a full reload,
        // which restarts the scan that caused the timeout in the first place.
        <Banner color={C.red} onClose={clearPicksError}
          action={picksLoading ? null : { label: "Retry", onClick: loadPicks }}>
          {picksError}
        </Banner>
      )}
      {scoreMsg && <Banner color={C.green}>{scoreMsg}</Banner>}
      {autoLog && <Banner color={C.blue}><span style={{ fontSize: 10, marginRight: 6 }}>⚡ AUTO</span>{autoLog}</Banner>}

      {/* ── Tabs + control bar ───────────────────────────────────────────────
          These stick together as one band. The control bar alone used to be
          sticky, which meant that on a 3,700px Overview you kept the filters
          but lost the tab strip — you had to scroll back to the top of the page
          to get from Overview to Markets. The band is full-bleed inside the
          page gutter so the blur covers content passing underneath it. */}
      <div style={{
        position: "sticky", top: 0, zIndex: 20, marginBottom: 16,
        marginLeft: -20, marginRight: -20, paddingLeft: 20, paddingRight: 20, paddingTop: 4,
        background: "rgba(232,237,246,0.94)", backdropFilter: "blur(8px)",
      }}>
        <div style={{ display: "flex", gap: 2, borderBottom: `1px solid ${C.rule}` }}>
          {TABS.map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)} style={{
              padding: "8px 17px", fontSize: 12, fontWeight: tab === k ? 700 : 500,
              borderRadius: "6px 6px 0 0", background: tab === k ? "rgba(32,98,200,0.16)" : "transparent",
              color: tab === k ? C.blue : C.muted, border: "none",
              borderBottom: `2px solid ${tab === k ? C.blue : "transparent"}`, cursor: "pointer",
            }}>{label}</button>
          ))}
        </div>

        {tab !== "ledger" && (
          <div style={{
            marginTop: 10, marginBottom: 10,
            display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap",
            padding: "9px 14px", background: "rgba(255,255,255,0.5)",
            border: `1px solid ${C.rule}`, borderRadius: 10,
          }}>
            <ControlGroup label="Window">
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                {/* Yesterday is the window you actually want most mornings —
                    "how did last night go" — and it was previously reachable
                    only by hunting for the date in the calendar heat map. */}
                <Chip active={isYesterday} onClick={() => { setCustom({ from: yesterdayStr, to: yesterdayStr }); setWin("custom"); }}
                  title={`Filter the whole page to ${yesterdayStr}`}>
                  Yesterday · {dayLabel(yesterdayStr)}
                </Chip>
                {WINDOWS.map(w => (
                  <Chip key={w.key} active={!custom && win === w.key}
                    onClick={() => { setCustom(null); setWin(w.key); }}>
                    {w.label}
                  </Chip>
                ))}
                {custom && !isYesterday && (
                  <Chip active onClick={() => setCustom(null)}>
                    {windowLabel} ✕
                  </Chip>
                )}
              </div>
            </ControlGroup>

            <span style={{ width: 1, height: 22, background: C.rule }} />

            {/* The exclusion count belongs to the toggle, not beside it — it is
                the toggle's consequence, and as detached 10px gray it read as a
                footnote rather than "you are looking at 91% of the record". */}
            <ControlGroup label="Population">
              <Toggle on={modelOnly} onClick={() => setModelOnly(v => !v)}
                title="On: only picks that would still qualify under today's thresholds. Off: the full historical record, including picks the current gates would reject.">
                {modelOnly ? "Current thresholds" : "All historical picks"}
                {modelOnly && filteredOut > 0 && (
                  <span style={{ fontWeight: 500, color: C.muted }}>
                    · {filteredOut.toLocaleString()} excluded
                  </span>
                )}
              </Toggle>
            </ControlGroup>

            <span style={{ width: 1, height: 22, background: C.rule }} />

            <ControlGroup label="Stake">
              <label style={{
                display: "flex", alignItems: "center", gap: 2, padding: "3px 9px",
                border: `1px solid ${C.rule}`, borderRadius: 7, background: "rgba(255,255,255,0.8)",
              }}>
                <span style={{ fontSize: 12, color: C.muted, fontFamily: MONO }}>$</span>
                <input type="number" min="0.01" step="0.25" value={perUnit}
                  onChange={e => setPerUnit(Math.max(0.01, Number(e.target.value) || 0.01))}
                  aria-label="Dollars per unit"
                  style={{
                    width: 58, padding: 0, fontSize: 12, fontFamily: MONO, fontWeight: 700,
                    border: "none", outline: "none", background: "transparent", color: C.ink,
                  }} />
                <span style={{ fontSize: 10, color: C.faint, whiteSpace: "nowrap" }}>/ unit</span>
              </label>
              <div style={{ display: "flex", gap: 3 }}>
                {[1, 5, 10, 25].map(v => (
                  <button key={v} onClick={() => setPerUnit(v)} style={{
                    padding: "3px 7px", fontSize: 10, fontFamily: MONO, borderRadius: 5, cursor: "pointer",
                    background: perUnit === v ? "rgba(32,98,200,0.16)" : "transparent",
                    border: `1px solid ${perUnit === v ? "rgba(32,98,200,0.4)" : C.rule}`,
                    color: perUnit === v ? C.blue : C.muted,
                  }}>${v}</button>
                ))}
              </div>
            </ControlGroup>

            <span style={{ marginLeft: "auto", fontSize: 11, color: C.muted, fontFamily: MONO }}>
              {scored.length.toLocaleString()} graded
            </span>
          </div>
        )}
      </div>

      {/* ── Panels ───────────────────────────────────────────────────────── */}
      {tab === "overview" && (
        <OverviewTab
          windowLabel={windowLabel} daily={daily} calendarDaily={calendarDaily} equity={equity}
          marketRows={marketRows} hot={hot} alarmItems={alarmItems} stats={stats}
          perUnit={perUnit} todayStr={todayStr} yesterdayStr={yesterdayStr}
          selectedDate={custom?.from && !custom.to ? custom.from : null}
          onSelectDay={setDrawerDate} onSelectMarket={goToMarket}
        />
      )}

      {tab === "markets" && (
        <div style={{ display: "grid", gap: 16 }}>
          <MarketTable rows={marketRows} perUnit={perUnit} weightedStakeOf={weightedStakeOf}
            title={`By market · ${windowLabel}`} />
          {/* The boards are a second, overlapping way to slice the same nights:
              a market row answers "is Ks any good", a board row answers "is the
              list I actually read every morning any good". They live on one tab
              because the answer to the second one is usually a market from the
              first (Ks is what sinks the likely board). Board records come from
              golden_snapshots, not mlb_picks, so this table does its own fetch
              and is untouched by the threshold filter. */}
          <GoldenTable from={goldenBounds.from} to={goldenBounds.to}
            windowLabel={windowLabel} perUnit={perUnit} />
        </div>
      )}

      {tab === "diagnostics" && (
        <DiagnosticsTab scored={scored} baseScored={baseScored} weightedStakeOf={weightedStakeOf} />
      )}

      {tab === "experiments" && (
        <ExperimentsTab baseScored={baseScored} weightedStakeOf={weightedStakeOf} perUnit={perUnit} />
      )}

      {tab === "ledger" && (
        <LedgerTab picks={picks} loading={picksLoading} scoring={scoring}
          scoreMsg={scoreMsg} scorePicks={scorePicks} loadPicks={loadPicks} />
      )}

      {tab !== "ledger" && scored.length === 0 && (
        <div style={{
          marginTop: 14, padding: "12px 16px", background: "rgba(161,98,7,0.07)",
          border: "1px solid rgba(161,98,7,0.22)", borderRadius: 9, fontSize: 12, color: C.amber,
        }}>
          No graded picks in this window{modelOnly ? " under current thresholds" : ""}.
          {modelOnly && filteredOut > 0 && " Turn off the threshold filter to see the full historical record."}
        </div>
      )}

      <DayDrawer
        date={drawerDate} picks={picks} daily={calendarDaily} perUnit={perUnit}
        /* the drawer's 14-day strip must span the season, not the window */
        weightedStakeOf={weightedStakeOf} onClose={() => setDrawerDate(null)}
        onPinWindow={(d) => { setCustom({ from: d, to: d }); setWin("custom"); setDrawerDate(null); }}
      />

      <div style={{ marginTop: 20, fontSize: 10, color: C.faint, lineHeight: 1.7 }}>
        Win rates on fewer than {MIN_N_VERDICT} graded picks are shown uncolored and carry no verdict.
        Units are realized P/L at the price actually taken; the weighted track sizes each pick the way
        the model suggested and applies the edge-controller multiplier in force on that date.
      </div>
    </div>
  );
}

function Banner({ color, children, onClose, action }) {
  return (
    <div style={{
      marginBottom: 10, padding: "8px 14px", borderRadius: 8, fontSize: 12, color,
      background: `${color}14`, border: `1px solid ${color}40`,
      display: "flex", alignItems: "center", gap: 8,
    }}>
      {/* Belt and braces with describeApiError (src/lib/supa.js): messages are
          short by the time they get here, but a banner is not a log viewer and
          must never be able to grow into one. Scrolls at ~6 lines. */}
      <span style={{ flex: 1, maxHeight: 118, overflowY: "auto", lineHeight: 1.5, wordBreak: "break-word" }}>
        {children}
      </span>
      {action && (
        <button onClick={action.onClick} style={{
          flexShrink: 0, padding: "4px 12px", fontSize: 11, fontWeight: 600, borderRadius: 6,
          background: `${color}1f`, border: `1px solid ${color}59`, color, cursor: "pointer",
        }}>{action.label}</button>
      )}
      {onClose && <button onClick={onClose} style={{ background: "none", border: "none", color, cursor: "pointer" }}>✕</button>}
    </div>
  );
}
