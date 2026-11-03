// ─────────────────────────────────────────────────────────────────────────────
// The daily_scan_results cold archive lives on Google Drive, ONE FILE PER DATE.
//
//   Drive (durable)  gdrive:mlb-research-dashboard-archive/daily-scan-results/2026-09-08.json.gz
//   local (working)  scripts/out/scan-archive/2026-09-08.json.gz   [gitignored]
//   Supabase         the serving window only (see scripts/prune-scan-results.mjs)
//
// WHY PER-DATE, unlike the pick_signals archive's single file. Each row is a
// ~2 MB jsonb blob and EVERY reader asks for one date at a time
// (`game_date=eq.${d}&limit=1`) — alt-line-backtest, calibrate-retune, fit-blend,
// hrr-drop-hrfb-refit, feature-lab-scans, backtest-thresholds, brain-trust-
// snapshot, bullpen-replay, alt-line-audit all share that shape. One file per
// date maps onto it exactly: a reader that wants eight days pulls eight small
// files instead of gunzipping an 80 MB blob to reach one of them.
//
// UNLIKE pick_signals, this table has a LIVE SERVING PATH — api/scan-results.js
// hands today's blob to the browser, and api/picks.js falls back to it when the
// inline snapshot is missing. So Postgres keeps the recent window and the
// archive holds the history. The archive is not a replacement, it is the tail.
//
// WHAT THIS BUYS BEYOND SPACE. prune-scan-results.mjs caps Postgres at 35 days,
// which silently capped every backtest at 35 days too. The archive keeps the
// full season, so the analysis substrate gets LONGER as Postgres gets smaller.
// ─────────────────────────────────────────────────────────────────────────────

import { existsSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { sbJson } from "./sb.mjs";
import { serveDb } from "../_lab.mjs";
import {
  OUT_DIR, DRIVE_ROOT, gzReadJson, gzWriteJson,
  pushFile, pushDir, pullFile, pullDir, listRemote, mb, pullIfStale,
} from "./archive.mjs";

export const LOCAL_DIR = join(OUT_DIR, "scan-archive");
export const DRIVE_REMOTE = `${DRIVE_ROOT}/daily-scan-results`;
export const INDEX_NAME = "_index.json.gz";

const fileFor = (date) => `${date}.json.gz`;
const pathFor = (date) => join(LOCAL_DIR, fileFor(date));

/** Every column. `results` is the 2 MB blob; the rest are metadata readers show. */
export const COLUMNS = "game_date,scanned_at,results,player_count,version";

// ── index ────────────────────────────────────────────────────────────────────
// The date list is its own tiny file so `scanDates()` does not have to list a
// Drive directory (a network round trip) or trust whatever happens to be sitting
// in the local dir (a partial pull would silently shorten every backtest).

export function writeIndex(entries) {
  gzWriteJson(join(LOCAL_DIR, INDEX_NAME), entries);
}

export function readIndex({ autoPull = true } = {}) {
  const p = join(LOCAL_DIR, INDEX_NAME);
  if (autoPull) {
    // Re-pull when stale too, not only when missing — see pullIfStale.
    pullIfStale(p, () => pullFile(`${DRIVE_REMOTE}/${INDEX_NAME}`, LOCAL_DIR), "scan archive index");
  } else if (!existsSync(p)) {
    throw new Error(`scan archive index missing: ${p}`);
  }
  if (!existsSync(p)) {
    throw new Error(
      `No local scan archive index and the Drive pull produced nothing.\n` +
      `  Check: rclone lsl "${DRIVE_REMOTE}"`
    );
  }
  return gzReadJson(p);
}

/** Sorted ascending, matching `order=game_date.asc` that readers used to send. */
export function scanDates({ autoPull = true } = {}) {
  return readIndex({ autoPull }).map((e) => e.game_date).sort();
}

/**
 * The full archived row for one date, or null when the archive has no such day.
 * Pulls the single file from Drive on a local miss — this is the hot path for a
 * backtest walking the season, so it fetches exactly the one date it was asked
 * for and nothing else.
 */
export function scanRow(date, { autoPull = true } = {}) {
  const p = pathFor(date);
  if (!existsSync(p) && autoPull) {
    try { pullFile(`${DRIVE_REMOTE}/${fileFor(date)}`, LOCAL_DIR); } catch { /* absent on Drive */ }
  }
  if (!existsSync(p)) return null;
  return gzReadJson(p);
}

/** Just the `results` blob — what almost every reader actually wanted. */
export function scanFor(date, opts) {
  return scanRow(date, opts)?.results ?? null;
}

/** Pull many dates up front, so a season walk is one rclone call, not N. */
export function prefetch(dates) {
  const missing = dates.filter((d) => !existsSync(pathFor(d)));
  if (!missing.length) return 0;
  pullDir(DRIVE_REMOTE, LOCAL_DIR);
  return missing.length;
}

export function writeDate(row) {
  gzWriteJson(pathFor(row.game_date), row);
  return pathFor(row.game_date);
}

export function pushDate(date) {
  return pushFile(pathFor(date), DRIVE_REMOTE);
}

export function pushAll() {
  return pushDir(LOCAL_DIR, DRIVE_REMOTE);
}

export function datesOnDrive() {
  return listRemote(DRIVE_REMOTE)
    .filter((n) => n.endsWith(".json.gz") && n !== INDEX_NAME)
    .map((n) => n.replace(".json.gz", ""))
    .sort();
}

export function localDates() {
  if (!existsSync(LOCAL_DIR)) return [];
  return readdirSync(LOCAL_DIR)
    .filter((n) => n.endsWith(".json.gz") && n !== INDEX_NAME)
    .map((n) => n.replace(".json.gz", ""))
    .sort();
}

export function localBytes() {
  if (!existsSync(LOCAL_DIR)) return 0;
  return readdirSync(LOCAL_DIR).reduce((n, f) => n + statSync(join(LOCAL_DIR, f)).size, 0);
}

/** The dates Postgres still holds. Cheap — one column, no blob. */
export async function datesInSupabase() {
  const { url, headers } = serveDb();
  const rows = await sbJson(
    `${url}/rest/v1/daily_scan_results?select=game_date&order=game_date.asc`,
    { headers }, { label: "scan dates" }
  );
  return rows.map((r) => r.game_date);
}

/** One date's full row from Postgres. ~2 MB — always fetch one at a time. */
export async function rowFromSupabase(date) {
  const { url, headers } = serveDb();
  const rows = await sbJson(
    `${url}/rest/v1/daily_scan_results?select=${COLUMNS}&game_date=eq.${date}&limit=1`,
    { headers }, { label: `scan ${date}`, timeoutMs: 120000 }
  );
  return rows?.[0] ?? null;
}

export function stats() {
  const d = localDates();
  return { dates: d.length, first: d[0], last: d[d.length - 1], size: mb(localBytes()) };
}
