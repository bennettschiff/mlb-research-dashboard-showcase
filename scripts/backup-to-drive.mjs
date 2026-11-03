#!/usr/bin/env node
/**
 * Nightly Supabase backup dump (uploaded to Google Drive via rclone).
 *
 * This script only dumps tables to a local folder — JSON for everything,
 * plus CSV for mlb_picks (the table you'd open in Sheets). Files over
 * ~5 MB are gzipped. The upload step is `rclone copy` (see
 * .github/workflows/backup-to-drive.yml), which uses YOUR Google account
 * so backups live in (and count against) your own Drive storage.
 *
 * --- Full vs incremental (Supabase egress control) ---
 * A full dump re-downloads every row nightly; the three big append-mostly
 * tables (daily_scan_results, pick_signals, mining_findings) dominate that and
 * their historical rows never change, so re-pulling them wastes the free tier's
 * 5 GB/mo egress. The workflow runs a FULL dump weekly (Sunday) and an
 * INCREMENTAL dump the other days via `--since=<YYYY-MM-DD>`, which limits only
 * those flagged tables to `dateCol >= SINCE` (a ~3-day rolling window that
 * overlaps so a missed night self-heals); every other table is always full.
 *
 * RESTORE: take the most recent FULL folder (_manifest.json mode="full") as the
 * base, then replay each later INCREMENTAL folder's flagged tables on top
 * (POST rows back via PostgREST, upsert on the table PK). Non-flagged tables are
 * complete in every folder. A row marked partial:true in a manifest is a window,
 * not the whole table.
 *
 * --- One-time setup (already done if RCLONE_CONF secret exists) ---
 * 1. Locally: `brew install rclone && rclone config create gdrive drive scope=drive.file`
 *    (opens a browser — log in with your Google account and click Allow).
 * 2. `gh secret set RCLONE_CONF < ~/.config/rclone/rclone.conf`
 *
 * --- Local run ---
 *   node --env-file=.env.local scripts/backup-to-drive.mjs --out-dir=backup-out [--tables=mlb_picks,pick_signals]
 *   rclone copy backup-out "gdrive:mlb-research-dashboard-backups/$(date +%F)"
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import { sbJson } from "./lib/sb.mjs";

// table -> { order: stable sort key for pagination, page: rows per request,
//            keyset: paginate by `order > cursor` instead of OFFSET }
//
// Prefer KEYSET pagination. OFFSET is O(n²) — the k-th page makes Postgres
// scan and discard the preceding k·page rows — so on the big tables
// (mining_findings 129 MB, daily_scan_results 66 MB of 2 MB blobs,
// pick_signals 62 MB) the nightly dump got quadratically heavier as they grew,
// which is exactly the kind of pre-dawn disk churn a 0.5 GB Nano can't absorb.
// Keyset walks the primary-key index once: O(n).
//
// keyset is only correct when `order` is UNIQUE (a strict `>` cursor would skip
// rows tied at a page boundary otherwise). Verified against the live PKs: the
// tables below marked keyset have a single-column unique PK equal to `order`.
// The advanced-stats family has a composite PK (mlbam_id, season) so mlbam_id
// is NOT unique — but each of those tables is well under one page, so OFFSET
// never actually skips a row there. Left on OFFSET rather than risk a silent
// backup gap.
// `incremental` + `dateCol`: under --since, fetch only rows with dateCol >= SINCE.
// Set ONLY on the big append-mostly tables whose historical rows are immutable
// and re-downloading them nightly is the bulk of Supabase egress. Small or
// mutable tables (mlb_picks grades, daily_odds) stay full — they're cheap and
// full dumps keep every dated folder self-restorable for them.
const TABLES = {
  mlb_picks: { order: "id", page: 1000, keyset: true },
  pick_signals: { order: "pick_id", page: 200, keyset: true, incremental: true, dateCol: "pick_date" },
  daily_scan_results: { order: "game_date", page: 1, keyset: true, incremental: true, dateCol: "game_date" },
  daily_odds: { order: "game_date", page: 5, keyset: true },
  // Pitch Lab morning scores (db/migrations/019). The scorer keeps only 14 days in Postgres,
  // so this incremental archive IS the history the pitcher-prop picks were made from.
  pitchlab_predictions: { order: "game_date", page: 5, keyset: true, incremental: true, dateCol: "game_date" },
  odds_credit_log: { order: "id", page: 1000, keyset: true },
  historical_odds: { order: "id", page: 1000, keyset: true },
  mining_findings: { order: "id", page: 1000, keyset: true, incremental: true, dateCol: "cycle_id" },
  golden_snapshots: { order: "pick_date", page: 50, keyset: true },
  player_id_crosswalk: { order: "mlbam_id", page: 1000, keyset: true },
  // Composite PK (mlbam_id, season): order col not unique → OFFSET (tiny tables).
  batter_advanced_stats: { order: "mlbam_id", page: 1000 },
  pitcher_advanced_stats: { order: "mlbam_id", page: 1000 },
  pitcher_running_game: { order: "mlbam_id", page: 1000 },
  catcher_throwing: { order: "mlbam_id", page: 1000 },
  basestealing_run_value: { order: "mlbam_id", page: 1000 },
  // The other two running-game leaderboards. Omitted until 2026-08-01 for no reason
  // other than oversight — they feed the SB model exactly as the three above do.
  baserunning: { order: "mlbam_id", page: 1000 },
  batter_sprint: { order: "mlbam_id", page: 1000 },

  // ── Analysis substrate, added 2026-08-01 ──────────────────────────────────
  // None of these were backed up. player_day_features is the worst of the omissions:
  // it is the unbiased panel every model claim is validated against, it cannot be
  // rebuilt from anything else (the atoms are morning-of snapshots of tables that get
  // overwritten daily), and it was the only copy.
  //
  // The three as-of tables CAN be rebuilt from Savant, but only at the cost of ~380
  // leaderboard fetches and two full pitch-level season pulls, so they are worth the
  // bytes. All are date-keyed and append-mostly → incremental, same as pick_signals.
  player_day_features: { order: "game_date", page: 500, incremental: true, dateCol: "game_date" },
  batter_asof_features: { order: "game_date", page: 1000, incremental: true, dateCol: "game_date" },
  pitcher_asof_features: { order: "game_date", page: 1000, incremental: true, dateCol: "game_date" },
  game_matchups: { order: "game_date", page: 1000, incremental: true, dateCol: "game_date" },
};

// Also export as CSV (in addition to JSON) — tables you'd ever want to open in Sheets.
const CSV_TABLES = new Set(["mlb_picks"]);

const GZIP_THRESHOLD = 5 * 1024 * 1024;

const TABLE_OVERRIDE = (process.argv.find((a) => a.startsWith("--tables=")) || "")
  .split("=")[1];
const OUT_DIR = (process.argv.find((a) => a.startsWith("--out-dir=")) || "").split("=")[1];
// Incremental mode: only tables flagged `incremental` are date-filtered to
// `dateCol >= SINCE`; every other table is always dumped in full. Omitting
// --since dumps everything (the weekly full snapshot and any local run).
const SINCE = (process.argv.find((a) => a.startsWith("--since=")) || "").split("=")[1] || null;

function env(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

/**
 * Tables that live on the LAB project rather than SERVE (moved 2026-08-11 — see
 * scripts/_lab.mjs). The backup MUST follow them: this dump is the only off-Supabase copy,
 * and pointing it at the project a table no longer lives in does not error loudly — PostgREST
 * returns 404 for the relation, which surfaces as a failed table rather than as the silent
 * empty file it would be if the relation merely had no rows. Either way the safety net is
 * gone, which is exactly the state that makes a later prune unrecoverable.
 *
 * Keep this in sync when a table moves. The manifest records which project each came from.
 */
const LAB_TABLES = new Set([
  "mining_findings",
  "player_day_features",
  "batter_asof_features",
  "pitcher_asof_features",
]);

export function projectFor(table) {
  return LAB_TABLES.has(table)
    ? { url: env("LAB_SUPABASE_URL"), key: env("LAB_SUPABASE_SERVICE_ROLE_KEY"), name: "LAB" }
    : { url: env("SUPABASE_URL"), key: env("SUPABASE_SERVICE_ROLE_KEY"), name: "SERVE" };
}

// A bare fetch here meant one transient 5xx anywhere in a ~40-page sweep threw
// away the whole night's backup. On 2026-09-05 the shared instance stalled hard
// enough that PostgREST's own `SET client_encoding` hit the statement timeout,
// and every request for ~8 minutes came back 504 after 135–180 s at the gateway
// — the NFL lab's copy of this script died on `teams`, a 32-row table.
// A nightly job can afford to wait, so this takes a longer per-request timeout
// than the shared default; the retry policy itself is scripts/lib/sb.mjs.
function fetchRange(table, query) {
  const { url: base, key } = projectFor(table);
  return sbJson(`${base}/rest/v1/${table}?${query}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  }, { label: table, timeoutMs: 120_000 });
}

async function dumpTable(table, { order, page, keyset, incremental, dateCol }) {
  // Under --since, incremental tables fetch only their recent window; the
  // dateCol filter composes with both pagination styles.
  const inc = SINCE && incremental && dateCol ? `&${dateCol}=gte.${SINCE}` : "";
  const rows = [];
  if (keyset) {
    // Walk the PK index once: fetch `order > cursor`, advance cursor to the
    // last row seen. Correct because `order` is unique (see TABLES).
    let cursor = null;
    for (;;) {
      const bound = cursor == null ? "" : `&${order}=gt.${encodeURIComponent(cursor)}`;
      const batch = await fetchRange(table, `select=*&order=${order}.asc&limit=${page}${bound}${inc}`);
      rows.push(...batch);
      if (batch.length < page) break;
      cursor = batch[batch.length - 1][order];
    }
  } else {
    for (let offset = 0; ; offset += page) {
      const batch = await fetchRange(table, `select=*&order=${order}.asc&limit=${page}&offset=${offset}${inc}`);
      rows.push(...batch);
      if (batch.length < page) break;
    }
  }
  return rows;
}

function toCsv(rows) {
  if (!rows.length) return "";
  const cols = Array.from(
    rows.reduce((set, r) => {
      Object.keys(r).forEach((k) => set.add(k));
      return set;
    }, new Set())
  );
  const esc = (v) => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
}

function writeJson(dir, table, rows) {
  const json = JSON.stringify(rows);
  if (Buffer.byteLength(json) > GZIP_THRESHOLD) {
    const file = path.join(dir, `${table}.json.gz`);
    fs.writeFileSync(file, zlib.gzipSync(json));
    return file;
  }
  const file = path.join(dir, `${table}.json`);
  fs.writeFileSync(file, json);
  return file;
}

async function main() {
  const tables = TABLE_OVERRIDE ? TABLE_OVERRIDE.split(",") : Object.keys(TABLES);
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  const outDir = OUT_DIR
    ? (fs.mkdirSync(OUT_DIR, { recursive: true }), OUT_DIR)
    : fs.mkdtempSync(path.join(os.tmpdir(), "sb-backup-"));
  const mode = SINCE ? `incremental (since ${SINCE})` : "full";
  console.log(`[backup] date=${today} mode=${mode} tables=${tables.length} out=${outDir}`);

  const summary = { date: today, mode: SINCE ? "incremental" : "full", since: SINCE, tables: {}, failed: {} };
  for (const t of tables) {
    const cfg = TABLES[t];
    if (!cfg) throw new Error(`Unknown table: ${t}`);
    const partial = SINCE && cfg.incremental && cfg.dateCol;
    process.stdout.write(`  ${t}${partial ? " (Δ)" : ""} … `);
    // One table that stays unreachable after every retry must not cost the other
    // nineteen their nightly copy — dump what we can, record what we couldn't, and
    // let the caller fail the job. The upload step runs `if: always()` so the
    // partial folder still reaches Drive; the prune step does not, so nothing is
    // deleted on the strength of a backup that is missing rows.
    let rows;
    try {
      rows = await dumpTable(t, cfg);
    } catch (e) {
      summary.failed[t] = String(e.message || e);
      console.log(`FAILED — ${String(e.message || e).slice(0, 200)}`);
      continue;
    }
    const file = writeJson(outDir, t, rows);
    summary.tables[t] = { rows: rows.length, bytes: fs.statSync(file).size, partial: !!partial };
    if (CSV_TABLES.has(t)) {
      fs.writeFileSync(path.join(outDir, `${t}.csv`), toCsv(rows));
    }
    console.log(`${rows.length} rows`);
  }
  fs.writeFileSync(path.join(outDir, "_manifest.json"), JSON.stringify(summary, null, 2));

  const missing = Object.keys(summary.failed);
  if (missing.length) {
    console.error(
      `::error::Backup incomplete — ${missing.length}/${tables.length} table(s) could not be read after retries: ${missing.join(", ")}. ` +
      `The tables that did dump are in ${outDir} and still upload; see _manifest.json.`
    );
    process.exitCode = 1;
    return;
  }
  console.log(`[backup] dump complete: ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
