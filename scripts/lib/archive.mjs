// ─────────────────────────────────────────────────────────────────────────────
// scripts/lib/archive.mjs — shared plumbing for the Drive-backed cold archives.
//
// WHY THESE EXIST. The SERVE project is a 0.5 GB Nano with ~224 MB of
// shared_buffers. On 2026-09-08 it spent six hours I/O-throttled because the
// working set no longer fit in RAM: 154 MB of the 254 MB database was cold jsonb
// (`daily_scan_results` 81 MB, `pick_signals` 73 MB) that only batch lab jobs
// ever read. LAB could not absorb it either — LAB was at 367 MB of its own
// 500 MB cap — so the cold half goes to Drive, which is free, durable, and
// already the backup target.
//
// This module owns ONLY the mechanics both archives share: gzip, JSONL, and
// rclone. What each archive IS — its path, its key, its shape — lives in
// signals-archive.mjs and scan-archive.mjs, so there is exactly one definition
// of each and a reader cannot pick up a different idea of the layout.
//
// Precedent: the WNBA odds archive (WNBA repo, scripts/lib/odds-archive.mjs),
// which moved 40k rows off Supabase for the same reason and has run since
// 2026-08-31 without a reader noticing it was not a table.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, utimesSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const OUT_DIR = join(ROOT, "scripts", "out");
export const DRIVE_ROOT = "gdrive:mlb-research-dashboard-archive";

/**
 * rclone shells out rather than using an API client because the nightly backup
 * already depends on rclone and the RCLONE_CONF secret — adding a second
 * credential path for the same Drive account would be one more thing to rotate.
 */
function rclone(args) {
  try {
    return execFileSync("rclone", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    // ENOENT means rclone is not on this machine at all — a missing ENVIRONMENT,
    // not a failed transfer, and the two want completely different fixes. It
    // surfaced on 2026-09-09 as a bare `spawnSync rclone ENOENT` from inside
    // mining-engine, which says nothing about archives, Drive, or which workflow
    // is under-provisioned. Say all three.
    if (e.code === "ENOENT") {
      throw new Error(
        `rclone is not installed here, and the cold archive on ${DRIVE_ROOT} cannot be read without it. ` +
        `This is the environment, not the data: any job reading the scan/signals/panel history older than ` +
        `the 14-day Postgres window needs it. In a workflow, add ` +
        `\`- uses: ./.github/actions/setup-rclone\` (with rclone-conf: \${{ secrets.RCLONE_CONF }}) after ` +
        `setup-node — scripts/check-archive-workflows.mjs enforces this in CI. Locally: \`brew install rclone\`.`
      );
    }
    const detail = (e.stderr || e.stdout || e.message || "").toString().trim().slice(0, 400);
    throw new Error(`rclone ${args[0]} failed: ${detail}`);
  }
}

export function gzWriteJsonl(path, rows) {
  mkdirSync(dirname(path), { recursive: true });
  const jsonl = rows.map((r) => JSON.stringify(r)).join("\n");
  writeFileSync(path, zlib.gzipSync(Buffer.from(jsonl), { level: 9 }));
  return rows.length;
}

export function gzReadJsonl(path) {
  const text = zlib.gunzipSync(readFileSync(path)).toString("utf8");
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

export function gzWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, zlib.gzipSync(Buffer.from(JSON.stringify(value)), { level: 9 }));
}

export function gzReadJson(path) {
  return JSON.parse(zlib.gunzipSync(readFileSync(path)).toString("utf8"));
}

/**
 * Copy one local file up to `remoteDir`, then VERIFY it is listed there.
 *
 * rclone exits 0 on a copy that wrote nothing (a filter that matched no files,
 * say), so trusting the exit code alone can report a successful push of an
 * archive that is not on Drive. The archive is the only durable copy once
 * Postgres is trimmed, so this checks the bytes landed.
 */
export function pushFile(localPath, remoteDir) {
  if (!existsSync(localPath)) throw new Error(`nothing to push: ${localPath} missing`);
  rclone(["copy", localPath, remoteDir]);
  const name = localPath.split("/").pop();
  const listed = JSON.parse(rclone(["lsjson", remoteDir])).find((f) => f.Name === name);
  if (!listed) throw new Error(`push reported success but ${remoteDir} does not list ${name}`);
  return listed;
}

/** Copy a whole local directory up, then verify the file COUNT matches. */
export function pushDir(localDir, remoteDir) {
  if (!existsSync(localDir)) throw new Error(`nothing to push: ${localDir} missing`);
  rclone(["copy", localDir, remoteDir]);
  return JSON.parse(rclone(["lsjson", remoteDir])).length;
}

export function pullFile(remotePath, localDir) {
  mkdirSync(localDir, { recursive: true });
  rclone(["copy", remotePath, localDir]);
}

export function pullDir(remoteDir, localDir) {
  mkdirSync(localDir, { recursive: true });
  rclone(["copy", remoteDir, localDir]);
}

// ── local-cache freshness ────────────────────────────────────────────────────
// The archive readers used to pull from Drive ONLY when the local file was
// missing, so on a long-lived checkout the local copy froze at whatever it was
// first cached as. 2026-09-23: panel.range() returned 03-25..09-14 while Drive
// held through 09-21, with the panel and backup workflows both green. CI never
// saw it because every runner starts from a fresh checkout.
export const REFRESH_AFTER_MS = 12 * 60 * 60 * 1000;

/** Pure: must the local copy be (re-)pulled? Missing, or last checked > maxAgeMs ago. */
export function needsRefresh({ exists, mtimeMs, now, maxAgeMs = REFRESH_AFTER_MS }) {
  return !exists || now - mtimeMs > maxAgeMs;
}

/**
 * Pull `localPath` via `pull()` when it is missing or stale. A failed refresh of
 * an existing copy falls back to that copy (offline work keeps running, with a
 * warning); a failed first pull still throws, as before. After a pull the file is
 * touched: rclone stamps it with the DRIVE modtime, which for a file written
 * nightly would otherwise look stale again within hours and re-pull on every call.
 */
export function pullIfStale(localPath, pull, label) {
  const exists = existsSync(localPath);
  if (!needsRefresh({ exists, mtimeMs: exists ? statSync(localPath).mtimeMs : 0, now: Date.now() })) return;
  console.log(exists
    ? `  ${label} last refreshed >12h ago — re-pulling from Drive…`
    : `  ${label} not local — pulling from Drive…`);
  try {
    pull();
  } catch (e) {
    if (!exists) throw e;
    console.warn(`  ${label} refresh failed (${e.message.split("\n")[0]}) — using the local copy`);
    return;
  }
  if (existsSync(localPath)) { const t = new Date(); utimesSync(localPath, t, t); }
}

/** Names of the files in a remote dir. Empty array when the dir does not exist. */
export function listRemote(remoteDir) {
  try {
    return JSON.parse(rclone(["lsjson", remoteDir])).map((f) => f.Name);
  } catch {
    return [];
  }
}

export function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * Page a PostgREST table with a KEYSET cursor.
 *
 * OFFSET paging is O(n²) — the k-th page makes Postgres scan and discard the
 * preceding k·page rows — which on these tables is exactly the sustained disk
 * churn the archive exists to stop. `order` must be UNIQUE or a strict `>`
 * cursor silently skips rows tied at a page boundary.
 *
 * `pause` is deliberate. A one-shot export of 63 MB is the single heaviest read
 * these tables ever get, and it runs against the instance that page renders and
 * pick saves share. Breathing between pages keeps the export from being the
 * thing that starves them.
 */
export async function keysetPage({ sbJson, url, headers, table, select, order, page = 500, pause = 150, filter = "", timeoutMs, onPage }) {
  const out = [];
  let cursor = null;
  for (;;) {
    const after = cursor === null ? "" : `&${order}=gt.${encodeURIComponent(cursor)}`;
    const q = `${url}/rest/v1/${table}?select=${select}&order=${order}.asc&limit=${page}${after}${filter}`;
    const rows = await sbJson(q, { headers }, { label: `${table} keyset@${cursor ?? "start"}`, timeoutMs });
    if (!rows || rows.length === 0) break;
    out.push(...rows);
    if (onPage) onPage(out.length, rows.length);
    cursor = rows[rows.length - 1][order];
    if (rows.length < page) break;
    if (pause) await new Promise((r) => setTimeout(r, pause));
  }
  return out;
}
