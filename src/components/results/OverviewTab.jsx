// The briefing. Reads top-down: what did we make → how did we get here → what
// needs attention → where is it coming from.
import { useState } from "react";
import { C, MONO, Card, Stat, Rate, Units, Money, pnlColor } from "./primitives.jsx";
import { fmtUnits, MIN_N_VERDICT } from "../../lib/results.js";
import EquityCurve from "./EquityCurve.jsx";
import CalendarHeatmap from "./CalendarHeatmap.jsx";
import AlarmRail from "./AlarmRail.jsx";
import HotColdRail from "./HotColdRail.jsx";
import GoldenBoards from "../GoldenBoards.jsx";

// One stake track's P/L, stated in the two currencies that matter: units (the
// model's own scale) and dollars (yours).
function TrackBlock({ label, hint, r, perUnit, emphasis }) {
  return (
    <div style={{
      background: emphasis ? "rgba(32,98,200,0.09)" : C.cardSolid,
      border: `1px solid ${emphasis ? "rgba(32,98,200,0.3)" : C.rule}`,
      borderRadius: 10, padding: "14px 18px",
    }}>
      <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: 1, marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 9, color: C.faint, marginBottom: 9 }}>{hint}</div>
      <div style={{ fontSize: 30, fontWeight: 700, color: pnlColor(r.units), fontFamily: MONO, lineHeight: 1 }}>
        {fmtUnits(r.units)}
      </div>
      <div style={{ display: "flex", gap: 14, marginTop: 9, alignItems: "baseline", flexWrap: "wrap" }}>
        <Money units={r.units} perUnit={perUnit} size={16} />
        <span style={{ fontSize: 12, color: C.muted }}>
          ROI <b style={{ color: r.decided < MIN_N_VERDICT ? C.muted : pnlColor(r.roiPct), fontFamily: MONO }}>
            {r.roiPct == null ? "—" : `${r.roiPct >= 0 ? "+" : ""}${r.roiPct.toFixed(1)}%`}
          </b>
        </span>
        <span style={{ fontSize: 11, color: C.faint, fontFamily: MONO }}>{r.staked.toFixed(0)}u staked</span>
      </div>
    </div>
  );
}

export default function OverviewTab({
  windowLabel, daily, calendarDaily, equity, marketRows, hot, alarmItems,
  perUnit, todayStr, selectedDate, onSelectDay, onSelectMarket, stats, yesterdayStr,
}) {
  const { flat, weighted } = stats;
  // Days IN THE WINDOW — `calendarDaily` spans the whole season so the calendar
  // can navigate outside the window, and dividing window units by season days
  // would understate the pace by however far back the history runs.
  const gradedDays = daily.length;
  const perDay = gradedDays ? weighted.units / gradedDays : null;

  return (
    <div style={{ display: "grid", gap: 16 }}>

      {/* ── Headline ─────────────────────────────────────────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12 }}>
        <TrackBlock emphasis label="Weighted — model-suggested units" r={weighted} perUnit={perUnit}
          hint="Hits 2u · HR/SB 0.5u · × edge-controller multiplier in force that day" />
        <TrackBlock label="Flat — 1u every pick" r={flat} perUnit={perUnit}
          hint="Controller-blind. Answers 'was the model right', not 'did we size it well'" />

        {/* Four supporting stats in a fixed 2×2. An auto-fit grid fitted three
            across at this card's width and orphaned "Per day" onto a second row
            with a column of dead space beside it — the card is a peer of the two
            track blocks, so its height has to be theirs, not whatever wrapping
            produced. It also gets a title now; it was the one nameless card in
            the row. */}
        <div style={{
          background: C.cardSolid, border: `1px solid ${C.rule}`, borderRadius: 10, padding: "14px 18px",
        }}>
          <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: 1, marginBottom: 2 }}>
            The record behind it
          </div>
          <div style={{ fontSize: 9, color: C.faint, marginBottom: 11 }}>
            Flat track · CLV is the leading indicator, units the lagging one
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px 14px", alignItems: "start" }}>
            <Stat label="Record" size={17} color={C.blue}
              value={flat.n ? `${flat.w}-${flat.l}${flat.pu ? `-${flat.pu}` : ""}` : "—"} />
            <div>
              <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: 1, marginBottom: 5 }}>Win %</div>
              <div style={{ fontSize: 17 }}><Rate r={flat} size={17} /></div>
            </div>
            <Stat label="CLV" size={17}
              color={flat.avgCLV == null ? C.faint : flat.clvN < MIN_N_VERDICT ? C.muted : pnlColor(flat.avgCLV)}
              value={flat.avgCLV == null ? "—" : `${flat.avgCLV >= 0 ? "+" : ""}${(flat.avgCLV * 100).toFixed(1)}pp`}
              sub={flat.clvN ? `n=${flat.clvN} priced` : "not priced"}
              title="Mean closing-line value. Converges on real edge faster than win rate." />
            <Stat label="Per day" size={17} color={pnlColor(perDay)}
              value={perDay == null ? "—" : fmtUnits(perDay)}
              sub={gradedDays ? `over ${gradedDays} graded days` : null}
              title="Weighted units per graded day in this window — multiply by days remaining to pace the rest of the season." />
          </div>
        </div>
      </div>

      {/* ── Equity ───────────────────────────────────────────────────────── */}
      {/* The pick count lives in the control bar, which governs this card and
          every other one — repeating it here made the same number read as two
          different facts. Days are what this card adds. */}
      <Card title={`Cumulative units · ${windowLabel}`}
        right={<span style={{ fontSize: 10, color: C.muted }}>
          {gradedDays} graded day{gradedDays === 1 ? "" : "s"}
        </span>}>
        <EquityCurve series={equity} height={240} />
      </Card>

      {/* ── Alarms ───────────────────────────────────────────────────────── */}
      <Card title="Watch list"
        right={<span style={{ fontSize: 10, color: C.muted }}>derived every render — nothing here is hand-maintained</span>}>
        <AlarmRail items={alarmItems} onSelectMarket={onSelectMarket} />
      </Card>

      {/* ── Calendar + hot/cold ──────────────────────────────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(380px, 1.35fr) minmax(300px, 1fr)", gap: 16 }}>
        <Card title="Daily P/L">
          <CalendarHeatmap daily={calendarDaily} track="weighted" todayStr={todayStr}
            selectedDate={selectedDate} onSelectDay={onSelectDay} />
        </Card>

        <div style={{ display: "grid", gap: 16, alignContent: "start" }}>
          <Card title="Running hot / cold · last 14 days">
            <HotColdRail rows={hot} days={14} onSelectMarket={onSelectMarket} />
          </Card>

          <Card title="Biggest movers in this window">
            <MoversList rows={marketRows} perUnit={perUnit} onSelectMarket={onSelectMarket} />
          </Card>
        </div>
      </div>

      {/* ── Yesterday's golden boards (server-graded, own record) ───────────
          Collapsed by default. This block is 1,224px — a third of the whole
          Overview — and it is the one section on the page the control bar does
          not govern: it is always yesterday, whatever window is selected. Open
          by default it buried the calendar and made the page read as if the
          briefing continued when it had actually ended. */}
      <CollapsibleSection
        title="🏆 Yesterday's Golden Boards"
        note={`${yesterdayStr} · graded server-side, outside the window filter`}>
        <GoldenBoards date={yesterdayStr} title={null} />
      </CollapsibleSection>
    </div>
  );
}

function CollapsibleSection({ title, note, children }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ background: C.card, border: `1px solid ${C.rule}`, borderRadius: 10, overflow: "hidden" }}>
      <button onClick={() => setOpen(o => !o)} style={{
        width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "10px 16px",
        background: "transparent", border: "none", cursor: "pointer", textAlign: "left",
        borderBottom: open ? `1px solid ${C.rule}` : "none",
      }}>
        <span style={{ color: C.faint, fontSize: 10 }}>{open ? "▾" : "▸"}</span>
        <span style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: 1, fontWeight: 600 }}>{title}</span>
        <span style={{ fontSize: 10, color: C.faint, marginLeft: "auto" }}>{note}</span>
      </button>
      {open && <div style={{ padding: 16 }}>{children}</div>}
    </div>
  );
}

// The three markets carrying the window and the three bleeding it. Not a
// ranking of quality — a ranking of contribution, which is what you'd want
// before deciding where to spend attention.
function MoversList({ rows, perUnit, onSelectMarket }) {
  const ranked = [...rows].sort((a, b) => b.weighted.units - a.weighted.units);
  const up = ranked.filter(r => r.weighted.units > 0).slice(0, 3);
  const down = ranked.filter(r => r.weighted.units < 0).slice(-3).reverse();

  const line = (r, sign) => (
    <div key={r.market} onClick={() => onSelectMarket?.(r.market)}
      style={{
        display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10,
        padding: "6px 0", borderBottom: `1px solid ${C.ruleSoft}`, cursor: "pointer",
      }}>
      <span style={{ fontSize: 12, color: C.ink, fontWeight: 600 }}>
        <span style={{ color: sign > 0 ? C.green : C.red, marginRight: 6 }}>{sign > 0 ? "▲" : "▼"}</span>
        {r.market}
      </span>
      <span style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
        <span style={{ fontSize: 10, color: C.muted, fontFamily: MONO }}>{r.flat.w}-{r.flat.l}</span>
        <Units v={r.weighted.units} size={12} />
        <span style={{ minWidth: 62, textAlign: "right" }}>
          <Money units={r.weighted.units} perUnit={perUnit} size={11} bold={false} />
        </span>
      </span>
    </div>
  );

  if (!up.length && !down.length) {
    return <div style={{ fontSize: 11, color: C.muted }}>No graded markets in this window.</div>;
  }
  return (
    <div>
      {up.map(r => line(r, 1))}
      {down.map(r => line(r, -1))}
    </div>
  );
}
