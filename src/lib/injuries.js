// ── Injury / Injured-List status ─────────────────────────────────────────────
// MLB Stats API exposes injury state two complementary ways:
//   • Team fullRoster → each player carries status {code, description}; IL players
//     show code D7/D10/D15/D60/ILF with description "Injured 10-Day" etc. This is
//     the authoritative "is this player on the IL right now" source, and it's bulk
//     (one call per club), so it drives the leaderboard badges + panel chip.
//   • Transactions feed → the "Status Change" entry that placed the player on the
//     IL carries the date and a human description ("...on the 10-day injured list.
//     Right hamstring strain."), which enriches the panel with a since-date + cause.
import { API, fetchJson } from "./utils.js";

export const INJURY_EMOJI = "⚕️"; // medical symbol (rod of Asclepius — snake around a pole)

// A roster status counts as "on the IL" when its description mentions injury or its
// code is one of the injured-list codes (D7/D10/D15/D60, ILF, IL, DL). Description-
// first keeps this robust to any new day-length code MLB adds.
const IL_CODE_RE = /^(D\d+|IL[A-Z]?|DL)$/i;
export function isILStatus(status) {
  if (!status) return false;
  if (/injured/i.test(status.description || "")) return true;
  return IL_CODE_RE.test(status.code || "");
}

// Short chip label from a roster status: "10-Day IL", "60-Day IL", "IL — Full Season".
export function ilShortLabel(status) {
  if (!status) return "IL";
  const code = (status.code || "").toUpperCase();
  const dayMatch = code.match(/^D(\d+)$/);
  if (dayMatch) return `${dayMatch[1]}-Day IL`;
  if (code === "ILF" || /full season/i.test(status.description || "")) return "IL — Full Season";
  // Fall back to the API description, trimmed to something chip-sized.
  const desc = status.description || "Injured List";
  return desc.replace(/^Injured\s+/i, "").replace(/-Day$/i, "-Day IL") || "IL";
}

// Pull the human bits out of a transaction description. Given e.g.
//   "White Sox placed 1B Munetaka Murakami on the 10-day injured list. Right hamstring strain."
// returns { cause: "Right hamstring strain", retroTo: null }. Handles an optional
// "retroactive to <date>" clause that MLB inserts before the injury sentence.
export function parseInjuryDescription(desc) {
  if (!desc) return { cause: null, retroTo: null };
  const afterIL = desc.split(/injured list/i)[1] || "";
  const retroMatch = afterIL.match(/retroactive to ([A-Za-z]+\.?\s?\d+)/i);
  // Last sentence after a period is the injury cause ("Right hamstring strain").
  const causeMatch = afterIL.match(/\.\s*([A-Z][^.]*?)\.?\s*$/);
  return {
    cause: causeMatch ? causeMatch[1].trim() : null,
    retroTo: retroMatch ? retroMatch[1].trim() : null,
  };
}

// Module-cached map of injured players across all 30 clubs: id → {code, description,
// teamId}. Only IL players are kept, so it stays small. One-time cost of ~30 roster
// calls, shared across the leaderboard and any player panel opened this session.
let _injuryMapPromise = null;
export function getInjuryMap() {
  if (_injuryMapPromise) return _injuryMapPromise;
  _injuryMapPromise = (async () => {
    const teamsResp = await fetchJson(`${API}/teams?sportId=1`);
    const teamIds = (teamsResp?.teams || []).map(t => t.id).filter(Boolean);
    const rosters = await Promise.all(teamIds.map(id =>
      fetchJson(`${API}/teams/${id}/roster?rosterType=fullRoster`).then(r => [id, r]).catch(() => [id, null])
    ));
    const map = {};
    for (const [teamId, r] of rosters) {
      for (const row of r?.roster || []) {
        const status = row.status || {};
        if (isILStatus(status) && row.person?.id != null) {
          map[row.person.id] = { code: status.code, description: status.description, teamId };
        }
      }
    }
    return map;
  })();
  // Don't cache a rejected promise — let a later call retry the fetch.
  _injuryMapPromise.catch(() => { _injuryMapPromise = null; });
  return _injuryMapPromise;
}

// Most-recent IL placement for one player from the transactions feed:
// { date, retroTo, cause, description }. Returns null when there's no IL placement
// in range. Used to enrich a panel — the map already confirms current IL state.
export async function getPlayerInjuryDetails(personId, season) {
  if (personId == null) return null;
  const yr = season || new Date().getFullYear();
  const today = new Date().toISOString().slice(0, 10);
  const d = await fetchJson(`${API}/transactions?playerId=${personId}&startDate=${yr}-01-01&endDate=${today}`);
  const txns = d?.transactions || []; // API returns oldest-first
  for (let i = txns.length - 1; i >= 0; i--) {
    const t = txns[i];
    const desc = t.description || "";
    if (/injured list/i.test(desc) && /placed|transferred/i.test(desc)) {
      const { cause, retroTo } = parseInjuryDescription(desc);
      return { date: t.date || t.effectiveDate || null, retroTo, cause, description: desc };
    }
  }
  return null;
}
