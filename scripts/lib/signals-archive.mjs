// ─────────────────────────────────────────────────────────────────────────────
// The pick_signals cold archive lives on Google Drive, NOT in Supabase.
//
//   Drive (durable)  gdrive:mlb-research-dashboard-archive/pick-signals/pick_signals.jsonl.gz
//   local (working)  scripts/out/pick_signals.jsonl.gz   [gitignored]
//   Supabase         the recent window only — see scripts/prune-pick-signals.mjs
//
// WHY. pick_signals is written ONCE by api/picks.js and thereafter read only in
// batch by lab jobs. That is the LAB definition in scripts/_lab.mjs, but the
// table sat on SERVE, where its 73 MB competed for the 224 MB of shared_buffers
// that page renders need. It could not move to LAB (LAB was at 367 MB of a
// 500 MB cap), so the history goes to Drive.
//
// THE SHAPE IS THE CONTRACT. Every reader used a PostgREST embedded join and
// got rows shaped { pick_id, signals, …, mlb_picks: { … } }. loadSignalsJoined()
// returns that EXACT shape, so a converted reader changes one function and no
// analysis code below it moves.
//
// mlb_picks is NOT archived and is pulled live on every call. That is
// deliberate, not laziness: it is 1.7 MB, it is the serving table, and a
// re-grade (backfill-scores fixing a doubleheader) flips `outcome` on mlb_picks
// without touching pick_signals. An archive that froze the joined fields would
// quietly serve stale outcomes to every miner.
// ─────────────────────────────────────────────────────────────────────────────

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { sbJson } from "./sb.mjs";
import { serveDb } from "../_lab.mjs";
import {
  OUT_DIR, DRIVE_ROOT, gzReadJsonl, gzWriteJsonl,
  pushFile, pullFile, listRemote, keysetPage, mb, pullIfStale,
} from "./archive.mjs";

export const FILE_NAME = "pick_signals.jsonl.gz";
export const ARCHIVE_PATH = join(OUT_DIR, FILE_NAME);
export const DRIVE_REMOTE = `${DRIVE_ROOT}/pick-signals`;

/** Every column of pick_signals. The archive is the table, not a projection. */
export const COLUMNS =
  "pick_id,pick_date,market,direction,conf,model_score,signals,adv_stats,created_at,raw_signals,model_intermediates,game_context";

/** pick_id is the table's PK — unique, which keyset paging and merging both need. */
export const rowKey = (r) => String(r.pick_id);

/** Merge incoming over existing, last-write-wins on pick_id. */
export function mergeRows(existing, incoming) {
  const m = new Map();
  for (const r of existing) m.set(rowKey(r), r);
  for (const r of incoming) m.set(rowKey(r), r);
  // Sorted by pick_id so the file is stable across runs and diffable.
  return [...m.values()].sort((a, b) => Number(a.pick_id) - Number(b.pick_id));
}

export function writeArchive(rows) {
  return gzWriteJsonl(ARCHIVE_PATH, rows);
}

/**
 * Read the archive, pulling from Drive when the local copy is missing (fresh
 * checkout, CI runner) or stale (long-lived checkout — see pullIfStale). Drive
 * is the durable copy — a missing local file is recoverable, not fatal.
 */
export function readArchive({ autoPull = true } = {}) {
  if (autoPull) {
    pullIfStale(ARCHIVE_PATH, pullFromDrive, "pick_signals archive");
  } else if (!existsSync(ARCHIVE_PATH)) {
    throw new Error(`archive missing: ${ARCHIVE_PATH}`);
  }
  if (!existsSync(ARCHIVE_PATH)) {
    throw new Error(
      `No local pick_signals archive and the Drive pull produced nothing.\n` +
      `  Check: rclone lsl "${DRIVE_REMOTE}"`
    );
  }
  return gzReadJsonl(ARCHIVE_PATH);
}

export function pushToDrive() {
  return pushFile(ARCHIVE_PATH, DRIVE_REMOTE);
}

export function pullFromDrive() {
  pullFile(`${DRIVE_REMOTE}/${FILE_NAME}`, OUT_DIR);
}

export function existsOnDrive() {
  return listRemote(DRIVE_REMOTE).includes(FILE_NAME);
}

export function localSize() {
  return existsSync(ARCHIVE_PATH) ? statSync(ARCHIVE_PATH).size : 0;
}

/**
 * Pull rows from Supabase with keyset paging. `sinceDate` limits to
 * pick_date >= that day, which is how the nightly sync stays cheap.
 */
export async function fetchFromSupabase({ sinceDate = null, page = 300, pause = 200, onPage } = {}) {
  const { url, headers } = serveDb();
  const filter = sinceDate ? `&pick_date=gte.${sinceDate}` : "";
  return keysetPage({
    sbJson, url, headers, table: "pick_signals", select: COLUMNS, order: "pick_id",
    page, pause, filter, timeoutMs: 120000, onPage,
  });
}

/**
 * THE READER ENTRY POINT — the PostgREST embedded join, served from Drive.
 *
 * @param {(pick: object) => boolean} where  predicate over the mlb_picks row,
 *        replacing the `&mlb_picks.prop_type=eq.x` filters readers used to send.
 * @returns rows shaped { …pick_signals columns, mlb_picks: { …every mlb_picks column } }
 *
 * There is deliberately NO date-window parameter. feature-lab, loss-profile and
 * clv-miner all read the FULL history on purpose; a helper that quietly defaulted
 * to a recent window would reproduce the `woba` sample leak, which cost four
 * baselines two thirds of their sample and was invisible in the output.
 */
// Memoised for the life of the process. feature-lab, loss-profile, clv-miner and
// mining-cron all call this once PER MARKET in a loop — without this, a nine-market
// run would gunzip the archive nine times and re-pull mlb_picks nine times, which
// is the sort of accidental N× that put the instance in trouble to begin with.
let _archiveCache = null;
let _picksCache = null;

export function resetCache() { _archiveCache = null; _picksCache = null; }

export async function loadSignalsJoined({ where = () => true } = {}) {
  if (!_archiveCache) _archiveCache = readArchive();
  if (!_picksCache) _picksCache = await fetchPicksIndex();
  const rows = _archiveCache, picks = _picksCache;
  const out = [];
  for (const r of rows) {
    const pick = picks.get(String(r.pick_id));
    if (!pick) continue;                 // inner join: a signal whose pick is gone
    if (!where(pick)) continue;
    out.push({ ...r, mlb_picks: pick });
  }
  return out;
}

/**
 * Just the pick_ids Postgres holds — the cheap side of a coverage check.
 * ~120 bytes a row against ~30 KB with the jsonb, so this is safe to run
 * nightly as the guard in front of a prune.
 */
export async function fetchIdsFromSupabase() {
  const { url, headers } = serveDb();
  const rows = await keysetPage({
    sbJson, url, headers, table: "pick_signals", select: "pick_id", order: "pick_id",
    page: 1000, pause: 0,
  });
  return rows.map((r) => String(r.pick_id));
}

/** pick_id -> the live mlb_picks row. Small enough (1.7 MB) to take whole. */
export async function fetchPicksIndex() {
  const { url, headers } = serveDb();
  const rows = await keysetPage({
    sbJson, url, headers, table: "mlb_picks", select: "*", order: "id", page: 1000, pause: 0,
  });
  return new Map(rows.map((p) => [String(p.id), p]));
}

export function stats(rows) {
  const dates = new Set(), markets = {};
  let withRaw = 0;
  for (const r of rows) {
    dates.add(r.pick_date);
    markets[r.market] = (markets[r.market] || 0) + 1;
    if (r.raw_signals) withRaw++;
  }
  const d = [...dates].filter(Boolean).sort();
  return {
    rows: rows.length, dates: d.length, first: d[0], last: d[d.length - 1],
    withRaw, markets, size: mb(localSize()),
  };
}
