// ── Injury status UI ─────────────────────────────────────────────────────────
// A ⚕️ badge (next to a player name) + a detail line (in a panel header) that
// surface whether a player is currently on the injured list, which list, since
// when, and the injury cause. Data comes from src/lib/injuries.js.
import { useState, useEffect } from "react";
import { INJURY_EMOJI, getInjuryMap, getPlayerInjuryDetails, ilShortLabel } from "../lib/injuries.js";

// Resolve a player's current IL status once, enriching the authoritative roster
// status (which list) with the placement date + injury cause from the transactions
// feed. Returns null while loading or when the player is healthy.
export function usePlayerInjury(playerId, season) {
  const [inj, setInj] = useState(null);
  useEffect(() => {
    setInj(null);
    if (playerId == null) return;
    let cancelled = false;
    (async () => {
      try {
        const map = await getInjuryMap();
        const status = map[playerId] || map[String(playerId)];
        if (!status || cancelled) return; // healthy / not on a 40-man roster
        let details = null;
        try { details = await getPlayerInjuryDetails(playerId, season); } catch { /* enrichment optional */ }
        if (cancelled) return;
        setInj({
          label: ilShortLabel(status),
          statusDesc: status.description || "Injured List",
          since: details?.date || null,
          retroTo: details?.retroTo || null,
          cause: details?.cause || null,
        });
      } catch { /* leave null on failure — absence of a badge, not a broken panel */ }
    })();
    return () => { cancelled = true; };
  }, [playerId, season]);
  return inj;
}

function fmtSince(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + "T12:00:00");
  if (isNaN(d)) return null;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// Inline ⚕️ badge for a player name (panel headers + leaderboard rows).
export function InjuryBadge({ inj, size = 16 }) {
  if (!inj) return null;
  const since = fmtSince(inj.since);
  const title = [inj.label, since && `since ${since}`, inj.cause].filter(Boolean).join(" · ");
  return <span title={title} style={{ fontSize: size, cursor: "help" }}>{INJURY_EMOJI}</span>;
}

// Full detail row for a player panel header.
export function InjuryLine({ inj }) {
  if (!inj) return null;
  const since = fmtSince(inj.since);
  return (
    <div style={{
      marginTop: 4, display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap",
      fontSize: 11, fontWeight: 700, color: "#d03131",
      background: "rgba(208,49,49,0.1)", border: "1px solid rgba(208,49,49,0.28)",
      borderRadius: 6, padding: "3px 8px",
    }}>
      <span>{INJURY_EMOJI} {inj.label}</span>
      {since && <span style={{ color: "#c25555", fontWeight: 500 }}>· since {since}{inj.retroTo ? ` (retro ${inj.retroTo})` : ""}</span>}
      {inj.cause && <span style={{ color: "#b06060", fontWeight: 500 }}>· {inj.cause}</span>}
    </div>
  );
}
