// The raw record and the tools that maintain it. Everything above this tab is
// an interpretation; this is the ledger those interpretations are built from,
// so it stays filterable down to the individual row.
import { useMemo, useState } from "react";
import { C, MONO, Card, Chip, Pill, Th, tdStyle, EmptyNote } from "./primitives.jsx";
import { pickLabel, fmtOdds, OUTCOME_COLORS, PROP_LABELS_R } from "../../lib/results.js";
import { sbPost } from "../../lib/supa.js";

const PROP_FILTERS = ["all", "hits", "hrr", "hr", "tb", "sb", "rbi", "ks", "ml", "rl", "ou", "nrfi"];
const OUTCOME_FILTERS = ["all", "win", "loss", "push", "pending"];
const PAGE = 250;

export default function LedgerTab({ picks, loading, scoring, scoreMsg, scorePicks, loadPicks }) {
  const [filterProp, setFilterProp] = useState("all");
  const [filterOutcome, setFilterOutcome] = useState("all");
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(PAGE);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return picks.filter(p =>
      (filterProp === "all" || p.prop_type === filterProp) &&
      (filterOutcome === "all" || p.outcome === filterOutcome) &&
      (!q || p.player_name?.toLowerCase().includes(q) || p.team?.toLowerCase().includes(q))
    );
  }, [picks, filterProp, filterOutcome, search]);

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <Card title="All picks" pad={false}
        right={<span style={{ fontSize: 10, color: C.muted }}>
          {filtered.length.toLocaleString()} row{filtered.length === 1 ? "" : "s"}
          {filtered.length > limit && ` · showing ${limit.toLocaleString()}`}
        </span>}>
        <div style={{ padding: "12px 16px", display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", borderBottom: `1px solid ${C.rule}` }}>
          <span style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: 1, marginRight: 2 }}>Prop</span>
          {PROP_FILTERS.map(k => (
            <Chip key={k} active={filterProp === k} onClick={() => { setFilterProp(k); setLimit(PAGE); }}>
              {k === "all" ? "All" : (PROP_LABELS_R[k] || k)}
            </Chip>
          ))}
          <span style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: 1, margin: "0 2px 0 10px" }}>Outcome</span>
          {OUTCOME_FILTERS.map(k => (
            <Chip key={k} active={filterOutcome === k} onClick={() => { setFilterOutcome(k); setLimit(PAGE); }}>
              {k.charAt(0).toUpperCase() + k.slice(1)}
            </Chip>
          ))}
          <input value={search} onChange={e => { setSearch(e.target.value); setLimit(PAGE); }}
            placeholder="Search player or team…"
            style={{
              marginLeft: "auto", padding: "5px 11px", fontSize: 11, borderRadius: 6,
              border: `1px solid ${C.rule}`, background: "rgba(255,255,255,0.6)", color: C.ink, minWidth: 180,
            }} />
        </div>

        <div className="hscroll">
          <table style={{ width: "100%", minWidth: 1000, borderCollapse: "collapse" }}>
            <thead><tr style={{ borderBottom: `1px solid ${C.rule}` }}>
              <Th align="left">Date</Th><Th align="left">Player</Th><Th align="left">Team</Th>
              <Th align="left">Market</Th><Th>Line</Th><Th>Model%</Th><Th>Fair</Th>
              <Th>FD</Th><Th>DK</Th><Th>HR</Th><Th>Best</Th><Th>Close</Th><Th>CLV</Th>
              <Th>Result</Th><Th>Outcome</Th>
            </tr></thead>
            <tbody>
              {loading && <tr><td colSpan={15}><EmptyNote>Loading…</EmptyNote></td></tr>}
              {!loading && filtered.slice(0, limit).map(p => (
                <tr key={p.id ?? `${p.pick_date}-${p.player_name}-${p.prop_type}-${p.line}`}
                  style={{
                    borderBottom: `1px solid ${C.ruleSoft}`,
                    background: p.outcome === "win" ? "rgba(15,138,68,0.035)" : p.outcome === "loss" ? "rgba(208,49,49,0.035)" : "transparent",
                  }}>
                  <td style={{ ...tdStyle("left"), paddingLeft: 16, fontSize: 11, fontFamily: MONO }}>{p.pick_date}</td>
                  <td style={{ ...tdStyle("left"), color: C.ink, fontWeight: 600 }}>{p.player_name}</td>
                  <td style={{ ...tdStyle("left"), fontSize: 11 }}>{p.team}</td>
                  <td style={{ ...tdStyle("left"), fontSize: 11 }}>{pickLabel(p)}</td>
                  <td style={{ ...tdStyle(), fontFamily: MONO, fontSize: 11 }}>
                    {p.prop_type === "ml" || p.prop_type === "rl" || p.prop_type === "nrfi" ? "—"
                      : <>{p.direction === "under" ? <span style={{ color: C.red, fontWeight: 700 }}>U</span> : "O"}{p.line}</>}
                  </td>
                  <td style={{ ...tdStyle(), fontFamily: MONO, fontSize: 11 }}>{p.model_prob != null ? `${(p.model_prob * 100).toFixed(0)}%` : "—"}</td>
                  <td style={{ ...tdStyle(), fontFamily: MONO, fontSize: 11, color: C.muted }}>{fmtOdds(p.fair_line)}</td>
                  {[p.fd_odds, p.dk_odds, p.hr_odds].map((o, i) => (
                    <td key={i} style={{ ...tdStyle(), fontFamily: MONO, fontSize: 11, color: o == null ? C.faint : C.body }}>{fmtOdds(o)}</td>
                  ))}
                  <td style={{ ...tdStyle(), fontFamily: MONO, fontSize: 11, color: C.ink, fontWeight: 600 }}>
                    {fmtOdds(p.best_odds)}
                    {p.best_book && <span style={{ fontSize: 9, color: C.faint, marginLeft: 3 }}>{p.best_book.toUpperCase().slice(0, 2)}</span>}
                  </td>
                  <td style={{ ...tdStyle(), fontFamily: MONO, fontSize: 11, color: C.muted }}>{fmtOdds(p.closing_odds)}</td>
                  <td style={{ ...tdStyle(), fontFamily: MONO, fontSize: 11, color: p.clv_pct == null ? C.faint : p.clv_pct >= 0 ? C.green : C.red }}>
                    {p.clv_pct == null ? "—" : `${p.clv_pct >= 0 ? "+" : ""}${(p.clv_pct * 100).toFixed(1)}`}
                  </td>
                  <td style={{ ...tdStyle(), fontFamily: MONO, fontSize: 11 }}>{p.result ?? "—"}</td>
                  <td style={{ ...tdStyle(), paddingRight: 16 }}>
                    <Pill color={OUTCOME_COLORS[p.outcome] || C.muted}>{p.outcome?.toUpperCase() || "—"}</Pill>
                  </td>
                </tr>
              ))}
              {!loading && filtered.length === 0 && (
                <tr><td colSpan={15}><EmptyNote>No picks match this filter.</EmptyNote></td></tr>
              )}
            </tbody>
          </table>
        </div>

        {filtered.length > limit && (
          <div style={{ padding: 12, textAlign: "center", borderTop: `1px solid ${C.rule}` }}>
            <button onClick={() => setLimit(l => l + PAGE)} style={{
              padding: "6px 18px", fontSize: 11, fontWeight: 600, borderRadius: 7, cursor: "pointer",
              background: "rgba(32,98,200,0.12)", border: `1px solid ${C.rule}`, color: C.blue,
            }}>Show {Math.min(PAGE, filtered.length - limit)} more</button>
          </div>
        )}
      </Card>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(400px, 1fr))", gap: 16, alignItems: "start" }}>
        <ScorePanel picks={picks} scoring={scoring} scoreMsg={scoreMsg} scorePicks={scorePicks} />
        <BackfillPanel picks={picks} scorePicks={scorePicks} loadPicks={loadPicks} />
      </div>
    </div>
  );
}

function ScorePanel({ picks, scoring, scoreMsg, scorePicks }) {
  const [scoreDate, setScoreDate] = useState("");
  const pendingDates = useMemo(
    () => [...new Set(picks.filter(p => p.outcome === "pending").map(p => p.pick_date))].sort().reverse(),
    [picks]
  );

  return (
    <Card title="Score pending picks">
      <div style={{ fontSize: 11, color: C.sub, marginBottom: 14, lineHeight: 1.6 }}>
        Fetches MLB box scores for the selected date and grades each pick against its line.
        Win = actual beats the line · push = exactly on it · loss = under.
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14, alignItems: "center" }}>
        {pendingDates.slice(0, 7).map(d => (
          <Chip key={d} active={scoreDate === d} onClick={() => setScoreDate(d)}>{d}</Chip>
        ))}
        <input type="date" value={scoreDate} onChange={e => setScoreDate(e.target.value)}
          style={{ padding: "4px 10px", fontSize: 11, borderRadius: 6, border: `1px solid ${C.rule}`, background: "rgba(255,255,255,0.6)", color: C.ink }} />
        {pendingDates.length === 0 && <span style={{ fontSize: 11, color: C.green }}>✓ Nothing pending.</span>}
      </div>

      <button onClick={() => scorePicks(scoreDate)} disabled={!scoreDate || scoring} style={{
        padding: "8px 20px", fontSize: 12, fontWeight: 600, borderRadius: 8,
        cursor: !scoreDate || scoring ? "not-allowed" : "pointer",
        background: !scoreDate || scoring ? "rgba(116,131,157,0.12)" : "rgba(15,138,68,0.15)",
        border: "1px solid rgba(15,138,68,0.3)", color: C.green, opacity: !scoreDate || scoring ? 0.5 : 1,
      }}>{scoring ? "Scoring…" : "Score picks"}</button>

      {scoreMsg && (
        <div style={{
          marginTop: 12, padding: "8px 13px", background: "rgba(15,138,68,0.08)",
          border: "1px solid rgba(15,138,68,0.2)", borderRadius: 8, color: C.green, fontSize: 11,
        }}>{scoreMsg}</div>
      )}

      <div style={{ marginTop: 18, fontSize: 10, color: C.muted, lineHeight: 1.7 }}>
        Grading also runs server-side each morning (morning-score.yml) and via the nightly
        backstop, so this is a manual re-run, not the primary path.
      </div>
    </Card>
  );
}

// Manual ML/RL entry for a past date. Rows are tagged model_version "backfill"
// so feature-lab can exclude them from version-stratified mining — they didn't
// come from a live model run and would otherwise pollute it.
function BackfillPanel({ picks, scorePicks, loadPicks }) {
  const [date, setDate] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  });
  const [games, setGames] = useState([]);
  const [loading, setLoading] = useState(false);
  const [added, setAdded] = useState(new Set());
  const [msg, setMsg] = useState("");
  const [saving, setSaving] = useState(null);

  const loadGames = async () => {
    setLoading(true); setGames([]); setMsg("");
    try {
      const schedUrl = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&gameType=R&fields=dates,games,gamePk,teams,status`;
      const sched = await fetch(`/api/proxy?url=${encodeURIComponent(schedUrl)}&ttl=3600`).then(r => r.json());
      const list = sched?.dates?.[0]?.games || [];
      if (!list.length) { setMsg("No games found for that date."); setLoading(false); return; }
      const results = await Promise.all(list.map(async g => {
        try {
          const box = await fetch(`/api/proxy?url=${encodeURIComponent(`https://statsapi.mlb.com/api/v1/game/${g.gamePk}/boxscore`)}&ttl=86400`).then(r => r.json());
          const homeAbbr = box.teams?.home?.team?.abbreviation;
          const awayAbbr = box.teams?.away?.team?.abbreviation;
          const homeScore = box.teams?.home?.teamStats?.batting?.runs ?? null;
          const awayScore = box.teams?.away?.teamStats?.batting?.runs ?? null;
          const isFinal = box.gameBoxscore?.status?.abstractGameState === "Final" ||
            (homeScore != null && awayScore != null && homeScore !== awayScore);
          return { gamePk: g.gamePk, homeAbbr, awayAbbr, homeScore, awayScore, isFinal };
        } catch { return null; }
      }));
      const valid = results.filter(r => r?.homeAbbr && r?.awayAbbr);
      const existing = picks.filter(p => p.pick_date === date && (p.prop_type === "ml" || p.prop_type === "rl"));
      setAdded(new Set(existing.map(p => {
        const g = valid.find(v => v.gamePk == p.player_id);
        return `${p.player_id}-${g && p.team === g.homeAbbr ? "home" : "away"}-${p.prop_type}`;
      })));
      setGames(valid);
    } catch (e) { setMsg(`Error: ${e.message}`); }
    finally { setLoading(false); }
  };

  const addPick = async (game, side, propType) => {
    const key = `${game.gamePk}-${side}-${propType}`;
    if (added.has(key) || saving === key) return;
    setSaving(key); setMsg("");
    try {
      const team = side === "home" ? game.homeAbbr : game.awayAbbr;
      const line = propType === "rl" ? (side === "home" ? -1.5 : 1.5) : 0;
      await sbPost("mlb_picks", [{
        pick_date: date,
        player_name: `${game.awayAbbr} @ ${game.homeAbbr}`,
        player_id: game.gamePk ?? null,
        team, prop_type: propType,
        line, model_score: null, conf: null,
        model_prob: null, fair_line: null,
        fd_odds: null, dk_odds: null, hr_odds: null,
        best_book: null, best_odds: null,
        direction: "over", outcome: "pending",
        model_version: "backfill",
      }]);
      setAdded(prev => new Set([...prev, key]));
      await scorePicks(date);
      await loadPicks();
      setMsg(`✓ Saved & scored ${team} ${propType.toUpperCase()}`);
    } catch (e) { setMsg(`Error: ${e.message}`); }
    finally { setSaving(null); }
  };

  const GRID = "1fr 74px 58px 58px 58px 58px";

  return (
    <Card title="🕐 Backfill past game picks" accent="rgba(161,98,7,0.18)">
      <div style={{ fontSize: 11, color: C.sub, marginBottom: 14, lineHeight: 1.6 }}>
        Load any past date and add ML/RL picks you want tracked. Saved rows grade immediately and are
        tagged <code style={{ fontFamily: MONO, fontSize: 10 }}>backfill</code> so mining can exclude them.
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 14, alignItems: "center", flexWrap: "wrap" }}>
        <input type="date" value={date} onChange={e => { setDate(e.target.value); setGames([]); setMsg(""); }}
          style={{ padding: "5px 10px", fontSize: 11, borderRadius: 6, border: `1px solid ${C.rule}`, background: "rgba(255,255,255,0.6)", color: C.ink }} />
        <button onClick={loadGames} disabled={loading} style={{
          padding: "6px 15px", fontSize: 11, fontWeight: 600, borderRadius: 6,
          cursor: loading ? "not-allowed" : "pointer", background: "rgba(161,98,7,0.12)",
          border: "1px solid rgba(161,98,7,0.3)", color: C.amber, opacity: loading ? 0.6 : 1,
        }}>{loading ? "Loading…" : "Load games"}</button>
      </div>

      {msg && (
        <div style={{
          marginBottom: 12, padding: "6px 12px", borderRadius: 7, fontSize: 11,
          background: msg.startsWith("✓") ? "rgba(15,138,68,0.08)" : "rgba(208,49,49,0.08)",
          border: `1px solid ${msg.startsWith("✓") ? "rgba(15,138,68,0.2)" : "rgba(208,49,49,0.2)"}`,
          color: msg.startsWith("✓") ? C.green : C.red,
        }}>{msg}</div>
      )}

      {games.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "grid", gridTemplateColumns: GRID, gap: 4, padding: "0 8px" }}>
            {["Game", "Final", "Away ML", "Home ML", "Away RL", "Home RL"].map((h, i) => (
              <span key={h} style={{ fontSize: 9, color: C.muted, fontWeight: 700, textTransform: "uppercase", textAlign: i === 0 ? "left" : "center" }}>{h}</span>
            ))}
          </div>
          {games.map(game => (
            <div key={game.gamePk} style={{
              display: "grid", gridTemplateColumns: GRID, gap: 4, padding: "7px 8px",
              background: "rgba(210,217,236,0.45)", borderRadius: 7, border: `1px solid ${C.ruleSoft}`, alignItems: "center",
            }}>
              <span style={{ fontSize: 12, color: C.body, fontWeight: 600 }}>{game.awayAbbr} @ {game.homeAbbr}</span>
              <span style={{ fontSize: 12, textAlign: "center", fontFamily: MONO, fontWeight: 700, color: game.isFinal ? C.sub : C.muted }}>
                {game.awayScore != null ? `${game.awayScore}–${game.homeScore}` : "—"}
              </span>
              {[["away", "ml"], ["home", "ml"], ["away", "rl"], ["home", "rl"]].map(([side, type]) => {
                const key = `${game.gamePk}-${side}-${type}`;
                const isAdded = added.has(key);
                const isSaving = saving === key;
                const existing = picks.find(p => p.player_id == game.gamePk && p.prop_type === type &&
                  ((side === "home" && p.team === game.homeAbbr) || (side === "away" && p.team === game.awayAbbr)));
                const o = existing?.outcome;
                const color = o === "win" ? C.green : o === "loss" ? C.red : o === "push" ? C.amber : isAdded ? C.blue : C.muted;
                return (
                  <button key={key} onClick={() => addPick(game, side, type)} disabled={isAdded || isSaving} style={{
                    padding: "4px 2px", fontSize: 10, fontWeight: 700, borderRadius: 5,
                    cursor: isAdded || isSaving ? "default" : "pointer",
                    border: `1px solid ${color}55`, background: `${color}1e`, color, textAlign: "center",
                  }}>
                    {isSaving ? "…" : o === "win" ? "WIN ✓" : o === "loss" ? "LOSS ✗" : o === "push" ? "PUSH" : isAdded ? "✓" : "+"}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
