#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// scripts/archive.mjs — manage the two Drive-backed cold archives.
//
//   node --env-file=.env.local scripts/archive.mjs --stats
//   node --env-file=.env.local scripts/archive.mjs --export --dataset=signals
//   node --env-file=.env.local scripts/archive.mjs --export --dataset=scans
//   node --env-file=.env.local scripts/archive.mjs --sync            # both, nightly
//   node --env-file=.env.local scripts/archive.mjs --verify          # archive vs Postgres
//   node scripts/archive.mjs --pull                                  # Drive → local
//
// --export is the ONE-TIME migration: it reads the whole table out of Supabase
// and writes the archive. --sync is what runs nightly and only moves what is
// new. Both are idempotent — the archive merges on its key, so running either
// twice is the same as running it once.
//
// Nothing here deletes from Postgres. Reclaiming that space is a separate,
// deliberate step (prune-scan-results.mjs / prune-pick-signals.mjs) that must
// not happen until --verify is clean and the readers have run a full cycle.
// ─────────────────────────────────────────────────────────────────────────────

import * as signals from "./lib/signals-archive.mjs";
import * as scans from "./lib/scan-archive.mjs";
import { ALL as PANELS } from "./lib/panel-archive.mjs";
import { syncTodo } from "./lib/date-archive.mjs";
import { mb } from "./lib/archive.mjs";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = null) => {
  const hit = argv.find((a) => a.startsWith(`${f}=`));
  return hit ? hit.split("=").slice(1).join("=") : d;
};

// "both" is kept as the default for backward compatibility with the SERVE-only
// invocations that shipped first; it now means "everything".
const DATASET = val("--dataset", "both");
const ALL_SETS = DATASET === "both" || DATASET === "all";
const wantSignals = ALL_SETS || DATASET === "signals";
const wantScans = ALL_SETS || DATASET === "scans";
const wantPanels = ALL_SETS || DATASET === "panels";

// A sync overlaps its window so a missed night self-heals rather than leaving a
// permanent hole — the same reason backup-to-drive.mjs uses a 3-day window.
const SYNC_OVERLAP_DAYS = Number(val("--overlap", "3"));

const isoDaysAgo = (n) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

// ── export: the one-time migration ───────────────────────────────────────────

async function exportSignals() {
  console.log("\n[signals] exporting pick_signals from Supabase (keyset, paced)…");
  const rows = await signals.fetchFromSupabase({
    onPage: (total) => process.stdout.write(`\r  ${total} rows…`),
  });
  console.log(`\r  pulled ${rows.length} rows          `);
  const existing = signals.localSize() ? signals.readArchive({ autoPull: false }) : [];
  const merged = signals.mergeRows(existing, rows);
  signals.writeArchive(merged);
  console.log(`  wrote ${merged.length} rows → ${signals.ARCHIVE_PATH} (${mb(signals.localSize())})`);
  const remote = signals.pushToDrive();
  console.log(`  pushed → ${signals.DRIVE_REMOTE}/${remote.Name} (${mb(remote.Size)})`);
}

async function exportScans() {
  console.log("\n[scans] exporting daily_scan_results from Supabase (one date at a time)…");
  const dates = await scans.datesInSupabase();
  const have = new Set(scans.localDates());
  const todo = dates.filter((d) => !have.has(d));
  console.log(`  ${dates.length} dates in Postgres, ${have.size} already local, ${todo.length} to pull`);

  const index = [];
  for (const d of scans.localDates()) {
    const row = scans.scanRow(d, { autoPull: false });
    if (row) index.push({ game_date: d, scanned_at: row.scanned_at, player_count: row.player_count, version: row.version });
  }

  let n = 0;
  for (const d of todo) {
    // Each row is ~2 MB. Sequential with a pause, never parallel — this runs
    // against the instance that serves the app.
    const row = await scans.rowFromSupabase(d);
    if (!row) { console.warn(`  ✗ ${d} — no row returned`); continue; }
    scans.writeDate(row);
    index.push({ game_date: d, scanned_at: row.scanned_at, player_count: row.player_count, version: row.version });
    n++;
    process.stdout.write(`\r  ${n}/${todo.length} dates…`);
    await new Promise((r) => setTimeout(r, 300));
  }
  if (todo.length) console.log("");

  index.sort((a, b) => a.game_date.localeCompare(b.game_date));
  scans.writeIndex(index);
  console.log(`  index: ${index.length} dates, ${index[0]?.game_date} → ${index[index.length - 1]?.game_date}`);
  const count = scans.pushAll();
  console.log(`  pushed → ${scans.DRIVE_REMOTE} (${count} files, ${mb(scans.localBytes())} local)`);
}

/**
 * The LAB panel tables. Same shape for all three, so one routine drives them:
 * walk the dates Postgres holds, pull the ones the archive is missing, write a
 * file per date, rebuild the index, push.
 *
 * `since` limits the walk for the nightly sync. With no `since` this is the
 * one-time migration.
 */
async function exportPanel(a, { since = null } = {}) {
  console.log(`\n[${a.name}] exporting from LAB…`);
  const allDb = await a.datesInDb();
  const have = new Set(a.localDates());
  const onDrive = new Set(a.datesOnDrive());
  // A sync presumes an archive already exists. An empty listing here is a failed
  // rclone call (listRemote swallows errors), and carrying on would rebuild the
  // index from this run's window alone — refuse instead.
  if (since && !onDrive.size) {
    throw new Error(`${a.name}: ${a.DRIVE_REMOTE} lists no files — refusing to sync against an unreadable archive`);
  }
  // Inside the sync window, always re-pull: a same-day re-run of
  // player-day-panel.mjs upserts rows, so the newest copy wins. Outside it, pull
  // only what Drive lacks — see syncTodo for why both halves are needed.
  const todo = since ? syncTodo(allDb, onDrive, since) : allDb.filter((d) => !have.has(d));
  const catchUp = since ? todo.filter((d) => d < since) : [];
  console.log(`  ${allDb.length} dates in Postgres, ${onDrive.size} on Drive, ${have.size} already local, ${todo.length} to pull` +
    (catchUp.length ? ` (incl. ${catchUp.length} older date(s) missing from Drive: ${catchUp.join(", ")})` : ""));

  // THE INDEX IS WHAT range() WALKS, so it must describe the whole archive. It
  // used to be seeded from local files only — and a CI checkout has none — so
  // every nightly sync from 2026-09-09 pushed an index listing just its 3-day
  // window over the full one, and every panel.range() reader (mining-engine,
  // theory-harness, alt-line-backtest, …) silently saw three days of history.
  // Start from Drive's copy, then re-count any Drive file the index is missing.
  let base = [];
  try { base = a.readIndex({ autoPull: true }); } catch (e) { if (since) throw e; }
  const index = new Map(base.map((e) => [e[a.dateCol], e]));
  for (const d of a.localDates()) {
    if (!index.has(d)) index.set(d, { [a.dateCol]: d, rows: a.rowsFor(d, { autoPull: false }).length });
  }
  const unindexed = [...onDrive].filter((d) => !index.has(d)).sort();
  if (unindexed.length) {
    console.log(`  ${unindexed.length} Drive file(s) missing from the index — pulling to re-count…`);
    a.prefetch(unindexed);
    for (const d of unindexed) index.set(d, { [a.dateCol]: d, rows: a.rowsFor(d, { autoPull: false }).length });
  }

  let n = 0;
  for (const d of todo) {
    const rows = await a.rowsFromDb(d);
    if (!rows.length) { console.warn(`  ✗ ${d} — no rows`); continue; }
    a.writeDate(d, rows);
    index.set(d, { [a.dateCol]: d, rows: rows.length });
    n++;
    process.stdout.write(`\r  ${n}/${todo.length} dates…`);
    await new Promise((r) => setTimeout(r, 120));
  }
  if (todo.length) console.log("");

  const merged = [...index.values()].sort((x, y) => x[a.dateCol].localeCompare(y[a.dateCol]));
  a.writeIndex(merged);
  const total = merged.reduce((s, e) => s + (e.rows || 0), 0);
  console.log(`  index: ${merged.length} dates / ${total} rows, ${merged[0]?.[a.dateCol]} → ${merged[merged.length - 1]?.[a.dateCol]}`);
  a.pushAll();
  console.log(`  pushed → ${a.DRIVE_REMOTE} (${mb(a.localBytes())} local)`);
}

// ── sync: the nightly delta ──────────────────────────────────────────────────

async function syncSignals() {
  const since = isoDaysAgo(SYNC_OVERLAP_DAYS);
  console.log(`\n[signals] sync since ${since}…`);
  const fresh = await signals.fetchFromSupabase({ sinceDate: since });
  const existing = signals.existsOnDrive() || signals.localSize() ? signals.readArchive() : [];
  const merged = signals.mergeRows(existing, fresh);
  const added = merged.length - existing.length;
  signals.writeArchive(merged);
  signals.pushToDrive();
  console.log(`  ${fresh.length} rows in window, ${added} new → ${merged.length} total (${mb(signals.localSize())})`);
}

async function syncScans() {
  const since = isoDaysAgo(SYNC_OVERLAP_DAYS);
  console.log(`\n[scans] sync since ${since}…`);
  const dates = (await scans.datesInSupabase()).filter((d) => d >= since);
  const index = scans.readIndex({ autoPull: true });
  const byDate = new Map(index.map((e) => [e.game_date, e]));
  let n = 0;
  for (const d of dates) {
    const row = await scans.rowFromSupabase(d);
    if (!row) continue;
    // Re-write within the overlap window even when present: a same-day re-scan
    // upserts on game_date, so the newest blob wins.
    scans.writeDate(row);
    byDate.set(d, { game_date: d, scanned_at: row.scanned_at, player_count: row.player_count, version: row.version });
    scans.pushDate(d);
    n++;
    await new Promise((r) => setTimeout(r, 300));
  }
  const merged = [...byDate.values()].sort((a, b) => a.game_date.localeCompare(b.game_date));
  scans.writeIndex(merged);
  scans.pushAll();
  console.log(`  refreshed ${n} dates → ${merged.length} in archive`);
}

// ── verify: is the archive safe to prune Postgres against? ───────────────────

async function verify() {
  let bad = 0;

  if (wantSignals) {
    console.log("\n[signals] verify");
    const arch = signals.readArchive();
    const ids = new Set(arch.map((r) => String(r.pick_id)));
    // IDS ONLY — never the jsonb. A coverage check asks "is every pick_id in the
    // archive", which `select=pick_id` answers for ~120 bytes a row instead of
    // ~30 KB. The first version of this pulled all six columns and hit the
    // statement timeout, i.e. the guard on the prune was itself the heaviest read
    // in the job.
    const live = await signals.fetchIdsFromSupabase();
    const missing = live.filter((id) => !ids.has(id));
    console.log(`  Postgres ${live.length} rows · archive ${arch.length} rows`);
    if (missing.length) { console.error(`  ✗ ${missing.length} rows in Postgres are NOT in the archive`); bad++; }
    else console.log("  ✓ every Postgres row is in the archive");
  }

  if (wantScans) {
    console.log("\n[scans] verify");
    const pg = await scans.datesInSupabase();
    const onDrive = scans.datesOnDrive();
    const idx = scans.scanDates();
    const missing = pg.filter((d) => !onDrive.includes(d));
    console.log(`  Postgres ${pg.length} dates · Drive ${onDrive.length} files · index ${idx.length} dates`);
    if (missing.length) { console.error(`  ✗ dates in Postgres but not on Drive: ${missing.join(", ")}`); bad++; }
    else console.log("  ✓ every Postgres date is on Drive");
    const orphanIndex = idx.filter((d) => !onDrive.includes(d));
    if (orphanIndex.length) { console.error(`  ✗ index lists dates with no file: ${orphanIndex.join(", ")}`); bad++; }
  }

  if (wantPanels) {
    for (const a of PANELS) {
      console.log(`\n[${a.name}] verify`);
      const pg = await a.datesInDb();
      const onDrive = a.datesOnDrive();
      const missing = pg.filter((d) => !onDrive.includes(d));
      console.log(`  Postgres ${pg.length} dates · Drive ${onDrive.length} files`);
      if (missing.length) {
        console.error(`  ✗ ${missing.length} date(s) in Postgres are NOT on Drive: ${missing.slice(0, 8).join(", ")}${missing.length > 8 ? "…" : ""}`);
        bad++;
      } else console.log("  ✓ every Postgres date is on Drive");
      // The index is what range() readers walk. A file on Drive the index does not
      // list is history no reader can see — the 3-date clobber of 2026-09-09→15.
      const idx = new Set(a.dates());
      const unindexed = onDrive.filter((d) => !idx.has(d));
      const orphan = [...idx].filter((d) => !onDrive.includes(d));
      if (unindexed.length) { console.error(`  ✗ index lists ${idx.size} dates but ${unindexed.length} Drive file(s) are not in it`); bad++; }
      if (orphan.length) { console.error(`  ✗ index lists dates with no file: ${orphan.slice(0, 8).join(", ")}`); bad++; }
      if (!unindexed.length && !orphan.length) console.log(`  ✓ index covers all ${idx.size} Drive dates`);
    }
  }

  if (bad) { console.error(`\nVERIFY FAILED (${bad} problem${bad > 1 ? "s" : ""}). Do NOT prune Postgres.`); process.exit(2); }
  console.log("\n✓ verify clean — the archive covers everything Postgres holds.");
}

function showStats() {
  if (wantSignals) {
    try {
      const s = signals.stats(signals.readArchive());
      console.log(`\npick_signals archive · ${signals.ARCHIVE_PATH}`);
      console.log(`  ${s.rows} rows · ${s.dates} dates · ${s.first} → ${s.last} · ${s.size}`);
      console.log(`  ${s.withRaw} rows carry raw_signals`);
      const top = Object.entries(s.markets).sort((a, b) => b[1] - a[1]);
      console.log(`  markets: ${top.map(([k, v]) => `${k} ${v}`).join(", ")}`);
    } catch (e) { console.log(`\npick_signals archive: ${e.message}`); }
  }
  if (wantScans) {
    try {
      const s = scans.stats();
      console.log(`\ndaily_scan_results archive · ${scans.LOCAL_DIR}`);
      console.log(`  ${s.dates} dates · ${s.first} → ${s.last} · ${s.size}`);
    } catch (e) { console.log(`\ndaily_scan_results archive: ${e.message}`); }
  }
  if (wantPanels) {
    for (const a of PANELS) {
      try {
        const s = a.stats();
        console.log(`\n${a.name} archive · ${a.LOCAL_DIR}`);
        console.log(`  ${s.dates} dates · ${s.first} → ${s.last} · ${s.size}`);
      } catch (e) { console.log(`\n${a.name} archive: ${e.message}`); }
    }
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

if (has("--export")) {
  if (wantSignals) await exportSignals();
  if (wantScans) await exportScans();
  if (wantPanels) for (const a of PANELS) await exportPanel(a);
} else if (has("--sync")) {
  if (wantSignals) await syncSignals();
  if (wantScans) await syncScans();
  if (wantPanels) for (const a of PANELS) await exportPanel(a, { since: isoDaysAgo(Math.max(SYNC_OVERLAP_DAYS, a.syncDays)) });
} else if (has("--verify")) {
  await verify();
} else if (has("--pull")) {
  if (wantSignals) { signals.pullFromDrive(); console.log(`pulled ${signals.DRIVE_REMOTE}`); }
  if (wantScans) { scans.prefetch(scans.datesOnDrive()); console.log(`pulled ${scans.DRIVE_REMOTE}`); }
} else if (has("--push")) {
  if (wantSignals) signals.pushToDrive();
  if (wantScans) scans.pushAll();
  console.log("pushed");
} else {
  showStats();
}
