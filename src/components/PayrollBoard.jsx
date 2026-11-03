// ── Payroll & Value Board ────────────────────────────────────────────────────
// League-wide player value: production vs. pay, with a skill-vs-luck layer.
// This board is deliberately WALLED OFF from the pick models — salary never
// influences a prop decision (see src/lib/value.js). It's a reference/analytics
// surface only.
//
// Data:
//   • src/data/player_value.json — WAR + cash salary + ids (scripts/fetch-player-value.mjs)
//   • /api/advanced-stats        — wRC+/xwOBA/SIERA/Stf+ etc. (joined for production+ & luck)
// All value math lives in src/lib/value.js; this file is presentation only.
import { useState, useEffect, useMemo } from "react";
import VALUE_DATA from "../data/player_value.json";
import { buildValueRows, formatMoney } from "../lib/value.js";
import Loader from "./Loader.jsx";

function useIsMobile(bp = 700) {
  const [m, setM] = useState(typeof window !== "undefined" && window.innerWidth < bp);
  useEffect(() => {
    const on = () => setM(window.innerWidth < bp);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, [bp]);
  return m;
}

const C = {
  bg: "rgba(210,217,236,0.5)", border: "rgba(32,98,200,0.192)",
  accent: "#2062c8", muted: "#74839d", text: "#3c4f6d",
  good: "#0a8564", bad: "#d02a4b", warn: "#a16207",
};

const LUCK_STYLE = {
  "underrated":       { label: "Buy-low",     color: C.good, hint: "Skills ahead of results — undervalued, room to rise" },
  "regression-risk":  { label: "Sell-high",   color: C.bad,  hint: "Results ahead of skills — over-performing, regression risk" },
  "fair":             { label: "Fair",        color: C.muted, hint: "Results roughly match underlying skills" },
};

const SVC_STYLE = {
  "pre-arb": { color: C.good, hint: "Pre-arbitration — paid near league minimum regardless of production" },
  "arb":     { color: C.warn, hint: "Arbitration-eligible" },
  "vet":     { color: C.muted, hint: "Free-agent / veteran contract" },
};

const surplusColor = s => (s == null ? C.muted : s > 0 ? C.good : C.bad);

function Chip({ children, color, title }) {
  return (
    <span title={title} style={{
      fontSize: 9, fontWeight: 700, color, background: `${color}18`,
      padding: "2px 6px", borderRadius: 4, whiteSpace: "nowrap",
    }}>{children}</span>
  );
}

const VIEWS = [
  { key: "bargains", label: "Bargains", emoji: "💎", hint: "Most surplus value — production far above pay" },
  { key: "overpaid", label: "Overpaid", emoji: "🧾", hint: "Least surplus value — pay far above production" },
  { key: "teams",    label: "Teams",    emoji: "🏟", hint: "Team payroll & efficiency" },
];
const ROLES = [{ key: "all", label: "All" }, { key: "B", label: "Batters" }, { key: "P", label: "Pitchers" }];

export default function PayrollBoard({ season }) {
  const [adv, setAdv] = useState(null); // { mlbam_id: row } merged batters+pitchers
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState("bargains");
  const [role, setRole] = useState("all");
  const isMobile = useIsMobile();

  useEffect(() => {
    let alive = true;
    setLoading(true);
    (async () => {
      try {
        const res = await fetch(`/api/advanced-stats?season=${season}`);
        const json = res.ok ? await res.json() : { batters: [], pitchers: [] };
        const map = {};
        for (const r of json.batters || []) if (r.mlbam_id) map[r.mlbam_id] = r;
        for (const r of json.pitchers || []) if (r.mlbam_id) map[r.mlbam_id] = r;
        if (alive) setAdv(map);
      } catch {
        if (alive) setAdv({});
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [season]);

  const rows = useMemo(
    () => (adv == null ? [] : buildValueRows(VALUE_DATA.players, adv)),
    [adv]
  );

  const players = useMemo(() => {
    let r = rows.filter(x => x.qualified);
    if (role !== "all") r = r.filter(x => x.role === role);
    if (view === "bargains") r = [...r].sort((a, b) => b.surplus - a.surplus).slice(0, 60);
    else if (view === "overpaid") r = [...r].sort((a, b) => a.surplus - b.surplus).slice(0, 60);
    return r;
  }, [rows, view, role]);

  const teams = useMemo(() => {
    const byTeam = {};
    for (const r of rows) {
      const t = r.team || "—";
      const g = (byTeam[t] ||= { team: t, payroll: 0, knownSalaries: 0, war: 0, n: 0, best: null, worst: null });
      g.n++;
      g.war += r.war || 0;
      if (r.salary != null) { g.payroll += r.salary; g.knownSalaries++; }
      if (r.qualified) {
        if (!g.best || r.surplus > g.best.surplus) g.best = r;
        if (!g.worst || r.surplus < g.worst.surplus) g.worst = r;
      }
    }
    return Object.values(byTeam)
      .filter(g => g.team !== "—")
      .map(g => ({ ...g, dollarsPerWar: g.war > 0 ? g.payroll / g.war : null }))
      .sort((a, b) => b.payroll - a.payroll);
  }, [rows]);

  const cell = (extra = {}) => ({ padding: isMobile ? "7px 6px" : "8px 10px", fontSize: isMobile ? 10 : 12, ...extra });
  const th = (extra = {}) => ({ ...cell(extra), color: C.muted, fontWeight: 700, fontSize: 9.5, textTransform: "uppercase", letterSpacing: 0.4, position: "sticky", top: 0, background: "#ffffff", zIndex: 1 });

  return (
    <div style={{ padding: isMobile ? "12px 10px 60px" : "16px 20px 80px", color: C.text }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginBottom: 4 }}>
        <h2 style={{ margin: 0, fontSize: isMobile ? 18 : 22, color: "#14213a" }}>💰 Payroll &amp; Value</h2>
        <span style={{ fontSize: 11, color: C.muted }}>{season} · surplus value vs. ${(8).toFixed(0)}M/WAR market</span>
      </div>
      <div style={{ fontSize: 10.5, color: C.muted, marginBottom: 14, lineHeight: 1.5 }}>
        Reference only — <strong style={{ color: C.text }}>salary never affects pick models</strong>. Cash salary from
        Baseball-Reference (pre-arb players assumed league-min); WAR + Statcast joined for production &amp; luck.
        Contract structure (years / total / deferrals) is being wired in separately.
      </div>

      {/* View + role toggles */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
        {VIEWS.map(v => (
          <button key={v.key} title={v.hint} onClick={() => setView(v.key)} style={{
            padding: "6px 12px", fontSize: 11, fontWeight: 700, borderRadius: 6, cursor: "pointer",
            border: `1px solid ${view === v.key ? C.accent : C.border}`,
            background: view === v.key ? "rgba(32,98,200,0.224)" : "transparent",
            color: view === v.key ? C.accent : C.muted,
          }}>{v.emoji} {v.label}</button>
        ))}
        {view !== "teams" && (
          <div style={{ display: "flex", gap: 2, marginLeft: "auto" }}>
            {ROLES.map(r => (
              <button key={r.key} onClick={() => setRole(r.key)} style={{
                padding: "6px 10px", fontSize: 10.5, fontWeight: 600, borderRadius: 6, cursor: "pointer",
                border: `1px solid ${role === r.key ? C.accent : "transparent"}`,
                background: role === r.key ? "rgba(32,98,200,0.16)" : "transparent",
                color: role === r.key ? C.accent : C.muted,
              }}>{r.label}</button>
            ))}
          </div>
        )}
      </div>

      {loading ? <Loader /> : view === "teams" ? (
        <TeamTable teams={teams} th={th} cell={cell} isMobile={isMobile} />
      ) : (
        <PlayerTable players={players} th={th} cell={cell} isMobile={isMobile} view={view} />
      )}
    </div>
  );
}

function PlayerTable({ players, th, cell, isMobile }) {
  if (!players.length) return <div style={{ color: C.muted, fontSize: 12, padding: 20 }}>No qualified players.</div>;
  return (
    <div className="hscroll" style={{ border: `1px solid ${C.border}`, borderRadius: 10, background: C.bg }}>
      <table style={{ width: "100%", borderCollapse: "collapse", minWidth: isMobile ? 560 : 720 }}>
        <thead>
          <tr style={{ borderBottom: `1px solid ${C.border}` }}>
            <th style={th({ textAlign: "left" })}>#</th>
            <th style={th({ textAlign: "left" })}>Player</th>
            <th style={th()}>Tm</th>
            <th style={th()}>Pos</th>
            <th style={th({ textAlign: "right" })}>WAR</th>
            <th style={th({ textAlign: "right" })}>Salary</th>
            <th style={th({ textAlign: "right" })}>Surplus</th>
            {!isMobile && <th style={th({ textAlign: "right" })}>$/WAR</th>}
            {!isMobile && <th style={th({ textAlign: "right" })}>Prod+</th>}
            <th style={th()}>Outlook</th>
            <th style={th()}>Svc</th>
          </tr>
        </thead>
        <tbody>
          {players.map((r, i) => {
            const luck = LUCK_STYLE[r.luckTag];
            const svc = SVC_STYLE[r.serviceClass];
            return (
              <tr key={r.mlbamId} style={{ borderBottom: "1px solid rgba(32,98,200,0.08)" }}>
                <td style={cell({ color: C.muted, textAlign: "left" })}>{i + 1}</td>
                <td style={cell({ textAlign: "left", fontWeight: 600, color: "#14213a", whiteSpace: "nowrap" })}>{r.name}</td>
                <td style={cell({ textAlign: "center", color: C.muted, fontWeight: 700 })}>{r.team}</td>
                <td style={cell({ textAlign: "center", color: C.muted })}>{r.role}</td>
                <td style={cell({ textAlign: "right", fontVariantNumeric: "tabular-nums", color: r.war >= 2 ? C.good : r.war < 0 ? C.bad : C.text })}>{r.war?.toFixed(1)}</td>
                <td style={cell({ textAlign: "right", fontVariantNumeric: "tabular-nums" })}>{formatMoney(r.salary, { compact: true })}</td>
                <td style={cell({ textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 700, color: surplusColor(r.surplus) })}>{formatMoney(r.surplus, { compact: true })}</td>
                {!isMobile && <td style={cell({ textAlign: "right", fontVariantNumeric: "tabular-nums", color: C.muted })}>{r.dollarsPerWar == null ? "—" : formatMoney(r.dollarsPerWar, { compact: true })}</td>}
                {!isMobile && <td style={cell({ textAlign: "right", fontVariantNumeric: "tabular-nums", color: C.muted })}>{r.productionPlus == null ? "—" : Math.round(r.productionPlus)}</td>}
                <td style={cell({ textAlign: "center" })}>{luck ? <Chip color={luck.color} title={luck.hint}>{luck.label}</Chip> : "—"}</td>
                <td style={cell({ textAlign: "center" })}>{svc ? <Chip color={svc.color} title={svc.hint}>{r.serviceClass}</Chip> : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function TeamTable({ teams, th, cell, isMobile }) {
  return (
    <div className="hscroll" style={{ border: `1px solid ${C.border}`, borderRadius: 10, background: C.bg }}>
      <table style={{ width: "100%", borderCollapse: "collapse", minWidth: isMobile ? 540 : 760 }}>
        <thead>
          <tr style={{ borderBottom: `1px solid ${C.border}` }}>
            <th style={th({ textAlign: "left" })}>#</th>
            <th style={th({ textAlign: "left" })}>Team</th>
            <th style={th({ textAlign: "right" })}>Known Payroll</th>
            <th style={th({ textAlign: "right" })}>WAR</th>
            <th style={th({ textAlign: "right" })}>$/WAR</th>
            {!isMobile && <th style={th({ textAlign: "left" })}>Best bargain</th>}
            {!isMobile && <th style={th({ textAlign: "left" })}>Biggest overpay</th>}
          </tr>
        </thead>
        <tbody>
          {teams.map((g, i) => (
            <tr key={g.team} style={{ borderBottom: "1px solid rgba(32,98,200,0.08)" }}>
              <td style={cell({ color: C.muted })}>{i + 1}</td>
              <td style={cell({ fontWeight: 700, color: "#14213a" })}>{g.team}</td>
              <td style={cell({ textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 600 })}>{formatMoney(g.payroll, { compact: true })}</td>
              <td style={cell({ textAlign: "right", fontVariantNumeric: "tabular-nums" })}>{g.war.toFixed(1)}</td>
              <td style={cell({ textAlign: "right", fontVariantNumeric: "tabular-nums", color: C.muted })}>{g.dollarsPerWar == null ? "—" : formatMoney(g.dollarsPerWar, { compact: true })}</td>
              {!isMobile && <td style={cell({ color: C.good, fontSize: 10.5 })}>{g.best ? `${g.best.name} (${formatMoney(g.best.surplus, { compact: true })})` : "—"}</td>}
              {!isMobile && <td style={cell({ color: C.bad, fontSize: 10.5 })}>{g.worst ? `${g.worst.name} (${formatMoney(g.worst.surplus, { compact: true })})` : "—"}</td>}
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ fontSize: 10, color: C.muted, padding: "10px 12px", lineHeight: 1.5 }}>
        "Known Payroll" sums only salaries Baseball-Reference publishes — pre-arb players show as gaps, so totals
        run below the true 40-man number until contract data is merged. $/WAR = known payroll ÷ total WAR.
      </div>
    </div>
  );
}
