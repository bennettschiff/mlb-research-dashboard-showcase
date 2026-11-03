// ─────────────────────────────────────────────────────────────────────────────
// scripts/lib/date-archive.mjs — a Drive-backed archive for a DATE-KEYED,
// ROW-PER-DAY table, built once and instantiated per table.
//
// This is the third archive shape in the lab, and the split is deliberate:
//
//   signals-archive.mjs  ONE file, keyed pick_id      — readers want the whole
//                                                       history, joined
//   scan-archive.mjs     one file per date, ONE BLOB  — readers want one date
//   date-archive.mjs     one file per date, MANY ROWS — readers want a RANGE
//
// The LAB panel tables (player_day_features, batter_asof_features,
// pitcher_asof_features) are all the third: a composite PK on (game_date, …),
// hundreds of rows a day, and readers that filter `game_date=gte.lo&lte.hi`.
// One file per date lets a reader pull exactly the window it asked for.
//
// WHY THESE MOVE. LAB was at 367 MB of the free plan's 500 MB (73%), and these
// three are 254 MB of it — all batch-read analysis substrate with no live
// consumer but api/_freshness.js, which reads only the max date. mining_findings
// stays: api/findings.js is a live relay for the Findings tab. pick_feature_matrix
// stays: it is mining-cron's own rebuildable cache.
//
// PAGING WITHIN A DATE IS NOT OPTIONAL. player_day_features returns exactly 1000
// rows for a recent date — PostgREST's hard cap — so a single unpaged request per
// date silently truncates the busiest days. Every fetch here pages until short.
// ─────────────────────────────────────────────────────────────────────────────

import { existsSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { sbJson } from "./sb.mjs";
import {
  OUT_DIR, DRIVE_ROOT, gzReadJsonl, gzWriteJsonl, gzReadJson, gzWriteJson,
  pushFile, pushDir, pullFile, pullDir, listRemote, mb, pullIfStale,
} from "./archive.mjs";

const INDEX_NAME = "_index.json.gz";

/**
 * Which Postgres dates a nightly sync must (re-)export.
 *
 * Two sets, and the second is the one that was missing (2026-09-15 backup red):
 *   1. every date inside the sync window — a re-run upserts, so the newest wins;
 *   2. every date Postgres holds that Drive does NOT, however old. asof-refresh.yml
 *      writes a 10-day lookback once a week, so on the night after it runs, dates
 *      9-10 days old appear in Postgres for the first time. A window-only sync
 *      never exported them, verify refused the prune, and the job went red — and
 *      would have gone red every week.
 *
 * Dates OUTSIDE the window that Drive already holds are deliberately NOT re-pulled:
 * backfill-pitch-level / backfill-batter-contact re-fold the whole season and
 * upsert PARTIAL rows onto dates the prune already removed, so the Postgres copy
 * of an old date can be less complete than the Drive one.
 */
export function syncTodo(dbDates, onDrive, since) {
  const drive = onDrive instanceof Set ? onDrive : new Set(onDrive);
  return dbDates.filter((d) => d >= since || !drive.has(d));
}

/**
 * @param {object} cfg
 *   name     - human label used in logs
 *   table    - PostgREST table name
 *   db       - () => ({ url, headers }) for the project it lives on
 *   dateCol  - the date column (default game_date)
 *   syncDays - minimum nightly re-pull window, for tables whose writer rewrites
 *              a lookback longer than archive.mjs's default overlap
 */
export function makeDateArchive({ name, table, db, dateCol = "game_date", syncDays = 0 }) {
  const LOCAL_DIR = join(OUT_DIR, "lab-archive", table);
  const DRIVE_REMOTE = `${DRIVE_ROOT}/${table.replace(/_/g, "-")}`;
  const fileFor = (d) => `${d}.jsonl.gz`;
  const pathFor = (d) => join(LOCAL_DIR, fileFor(d));

  function writeIndex(entries) { gzWriteJson(join(LOCAL_DIR, INDEX_NAME), entries); }

  function readIndex({ autoPull = true } = {}) {
    const p = join(LOCAL_DIR, INDEX_NAME);
    if (autoPull) {
      // Re-pull when stale too, not only when missing — see pullIfStale.
      pullIfStale(p, () => pullFile(`${DRIVE_REMOTE}/${INDEX_NAME}`, LOCAL_DIR), `${name} index`);
    } else if (!existsSync(p)) {
      throw new Error(`${name} index missing: ${p}`);
    }
    if (!existsSync(p)) {
      throw new Error(`No local ${name} index and the Drive pull produced nothing.\n  Check: rclone lsl "${DRIVE_REMOTE}"`);
    }
    return gzReadJson(p);
  }

  const dates = (opts) => readIndex(opts).map((e) => e[dateCol]).sort();

  function rowsFor(d, { autoPull = true } = {}) {
    const p = pathFor(d);
    if (!existsSync(p) && autoPull) {
      try { pullFile(`${DRIVE_REMOTE}/${fileFor(d)}`, LOCAL_DIR); } catch { /* absent */ }
    }
    if (!existsSync(p)) return [];
    return gzReadJsonl(p);
  }

  /** Pull everything once, so a season walk is one rclone call rather than N. */
  function prefetch(want) {
    const missing = (want || []).filter((d) => !existsSync(pathFor(d)));
    if (!missing.length) return 0;
    pullDir(DRIVE_REMOTE, LOCAL_DIR);
    return missing.length;
  }

  /**
   * THE READER ENTRY POINT — replaces `?${dateCol}=gte.${lo}&${dateCol}=lte.${hi}`.
   * Omit both bounds for the full history, which several callers genuinely want.
   */
  function range(lo = null, hi = null, { autoPull = true } = {}) {
    const all = dates({ autoPull }).filter((d) => (!lo || d >= lo) && (!hi || d <= hi));
    if (autoPull) prefetch(all);
    const out = [];
    for (const d of all) out.push(...rowsFor(d, { autoPull: false }));
    return out;
  }

  function writeDate(d, rows) { gzWriteJsonl(pathFor(d), rows); return rows.length; }

  const localDates = () => (!existsSync(LOCAL_DIR) ? [] : readdirSync(LOCAL_DIR)
    .filter((n) => n.endsWith(".jsonl.gz")).map((n) => n.replace(".jsonl.gz", "")).sort());

  const datesOnDrive = () => listRemote(DRIVE_REMOTE)
    .filter((n) => n.endsWith(".jsonl.gz")).map((n) => n.replace(".jsonl.gz", "")).sort();

  const localBytes = () => (!existsSync(LOCAL_DIR) ? 0
    : readdirSync(LOCAL_DIR).reduce((n, f) => n + statSync(join(LOCAL_DIR, f)).size, 0));

  /** The distinct dates Postgres holds. One column, keyset-paged — cheap. */
  async function datesInDb() {
    const { url, headers } = db();
    const seen = new Set();
    let cursor = null;
    for (;;) {
      const after = cursor ? `&${dateCol}=gt.${cursor}` : "";
      const rows = await sbJson(
        `${url}/rest/v1/${table}?select=${dateCol}&order=${dateCol}.asc&limit=1000${after}`,
        { headers }, { label: `${table} dates@${cursor ?? "start"}` }
      );
      if (!rows?.length) break;
      for (const r of rows) seen.add(r[dateCol]);
      const last = rows[rows.length - 1][dateCol];
      if (last === cursor) break;         // a single date wider than a page
      cursor = last;
      if (rows.length < 1000) break;
    }
    return [...seen].sort();
  }

  /** Every row for one date, OFFSET-paged — see the 1000-row note in the header. */
  async function rowsFromDb(d) {
    const { url, headers } = db();
    const out = [];
    for (let from = 0; ; from += 1000) {
      const rows = await sbJson(
        `${url}/rest/v1/${table}?select=*&${dateCol}=eq.${d}&order=${dateCol}.asc&limit=1000&offset=${from}`,
        { headers }, { label: `${table} ${d}@${from}`, timeoutMs: 120000 }
      );
      if (!rows?.length) break;
      out.push(...rows);
      if (rows.length < 1000) break;
    }
    return out;
  }

  return {
    name, table, dateCol, syncDays, LOCAL_DIR, DRIVE_REMOTE, INDEX_NAME,
    writeIndex, readIndex, dates, rowsFor, prefetch, range, writeDate,
    localDates, datesOnDrive, localBytes, datesInDb, rowsFromDb,
    pushDate: (d) => pushFile(pathFor(d), DRIVE_REMOTE),
    pushAll: () => pushDir(LOCAL_DIR, DRIVE_REMOTE),
    stats() {
      const d = localDates();
      return { dates: d.length, first: d[0], last: d[d.length - 1], size: mb(localBytes()) };
    },
  };
}
