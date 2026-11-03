// ── Golden 10 snapshot persistence ───────────────────────────────────────────
//
// Snapshots live in Supabase (golden_snapshots) so a lock made on one device
// shows up on another. localStorage is a write-through cache for fast initial
// reads — the DB is the source of truth and overwrites the cache on hydration.
//
// Extracted from App.jsx 2026-08-09 with the GoldenBoard move. Shared: the board
// writes locks here, and the Results tracker reads every date's snapshot back to
// match saved picks against what was actually locked.

import { accessCodeHeader } from "./utils.js";

const GOLDEN_LS_PREFIX = "mlb_golden_v1_";

export function loadGoldenSnapshot(date) {
  try {
    const raw = localStorage.getItem(GOLDEN_LS_PREFIX + date);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function writeGoldenCache(date, lockedAt, picks) {
  try {
    localStorage.setItem(GOLDEN_LS_PREFIX + date, JSON.stringify({ lockedAt, picks }));
  } catch {}
}

export function saveGoldenSnapshot(date, picks) {
  const lockedAt = new Date().toISOString();
  writeGoldenCache(date, lockedAt, picks);
  // Fire-and-forget DB upsert — local cache stays usable if the call fails.
  fetch("/api/golden-snapshots", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...accessCodeHeader() },
    // board is explicit so this legacy writer can never land on — or upsert over —
    // one of the three current boards written by scripts/golden-snapshot.mjs.
    body: JSON.stringify({ pick_date: date, board: "legacy", locked_at: lockedAt, picks }),
  }).catch(err => console.warn("[golden] save failed:", err?.message || err));
  return lockedAt;
}

export function deleteGoldenSnapshot(date) {
  try { localStorage.removeItem(GOLDEN_LS_PREFIX + date); } catch {}
  // Scoped to the legacy board — unscoped, this unlock button would delete that
  // date's likely/lines/value rows too.
  fetch(`/api/golden-snapshots?query=${encodeURIComponent(`pick_date=eq.${date}&board=eq.legacy`)}`, { method: "DELETE", headers: { ...accessCodeHeader() } })
    .catch(err => console.warn("[golden] delete failed:", err?.message || err));
}

/** One date's snapshot, DB-first. Used by the board on mount. */
export async function fetchGoldenSnapshot(date) {
  const res = await fetch(`/api/golden-snapshots?query=${encodeURIComponent(`pick_date=eq.${date}&board=eq.legacy&select=locked_at,picks`)}`);
  if (!res.ok) return null;
  const rows = await res.json();
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row?.picks?.length) return null;
  writeGoldenCache(date, row.locked_at, row.picks);
  return { lockedAt: row.locked_at, picks: row.picks };
}

// Map of date → picks[] for every Golden 10 snapshot. Reads from DB and hydrates
// localStorage. Falls back to cache on network failure so Results still works offline.
export async function loadAllGoldenSnapshots() {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 12000);
  try {
    // board=eq.legacy is REQUIRED, not optional: golden_snapshots is keyed
    // (pick_date, board) since 2026-08-06, so an unfiltered read returns up to
    // four rows per date and the map below would keep whichever landed last.
    // This path renders the historical single-board Golden 10; the three current
    // boards are read by GoldenBoards.jsx.
    const res = await fetch("/api/golden-snapshots?query=" + encodeURIComponent("board=eq.legacy&select=pick_date,locked_at,picks"), { signal: ctrl.signal });
    if (res.ok) {
      const rows = await res.json();
      const out = {};
      for (const r of rows || []) {
        if (r?.pick_date && r?.picks?.length) {
          out[r.pick_date] = r.picks;
          writeGoldenCache(r.pick_date, r.locked_at, r.picks);
        }
      }
      return out;
    }
  } catch (err) {
    console.warn("[golden] fetch failed, falling back to cache:", err?.message || err);
  } finally { clearTimeout(tid); }
  // Fallback: localStorage scan
  const out = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(GOLDEN_LS_PREFIX)) continue;
      const date = k.slice(GOLDEN_LS_PREFIX.length);
      const raw = localStorage.getItem(k);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      if (parsed?.picks?.length) out[date] = parsed.picks;
    }
  } catch {}
  return out;
}

// Picks from mlb_picks that match a given Golden 10 snapshot entry
export function matchSavedPickToGolden(dbPick, snap) {
  if (!snap || !dbPick) return false;
  if (dbPick.prop_type !== snap.market) return false;
  if (dbPick.player_id != null && snap.playerId != null) {
    if (String(dbPick.player_id) !== String(snap.playerId)) return false;
  } else if ((dbPick.player_name || "") !== (snap.playerName || "")) return false;
  if ((dbPick.direction || "over") !== (snap.direction || "over")) return false;
  // Line tolerance — ML uses 0, others match nominal
  if (snap.line != null && dbPick.line != null) {
    if (Math.abs(Number(dbPick.line) - Number(snap.line)) > 0.001) return false;
  }
  return true;
}
