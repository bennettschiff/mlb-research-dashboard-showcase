#!/usr/bin/env node
/**
 * Prune old pick_signals rows now that the Drive archive is the history.
 *
 * pick_signals was 73 MB — the second-largest table on SERVE and, with
 * daily_scan_results, half of the 154 MB of cold jsonb competing for a 224 MB
 * shared_buffers on a 0.5 GB Nano. That competition is the standing condition
 * behind the 2026-09-08 outage, in which single-row reads took 10-25 seconds.
 *
 * It had NO retention because it could not have one: feature-lab, loss-profile,
 * clv-miner and mining-cron read its FULL history with no date filter, so any
 * cut-off silently shortened their samples (the trap [[project_incremental_value
 * _sample_leak]] describes). Those readers now go through
 * scripts/lib/signals-archive.mjs, which serves the whole history from Drive —
 * so trimming Postgres costs them nothing.
 *
 * RETENTION IS 14 DAYS, set by the deepest remaining Postgres-side reader rather
 * than by taste:
 *   - plumbing-tripwire.mjs reads a 7-day window (pick_date >= since) and must
 *     keep seeing live rows — it is a liveness check on the WRITE path, so
 *     pointing it at the archive would make it validate the archive instead.
 *   - api/_freshness.js reads only the max pick_date.
 *   - api/picks.js WRITES here on every pick save and is untouched.
 * 14 leaves 2x headroom over the 7-day consumer.
 *
 * SAFETY: run `node scripts/archive.mjs --verify` first — it fails (exit 2) if a
 * single pick_id in Postgres is missing from Drive. backup-to-drive.yml runs
 * sync → verify → prune in that order for exactly this reason. The archive is
 * the only durable copy of what this deletes.
 *
 * Usage:
 *   node --env-file=.env.local scripts/prune-pick-signals.mjs            # dry-run
 *   node --env-file=.env.local scripts/prune-pick-signals.mjs --apply
 *   node --env-file=.env.local scripts/prune-pick-signals.mjs --days=30 --apply
 *
 * Deletes one pick_date at a time. A single bulk DELETE across thousands of
 * jsonb rows hits the statement timeout — the same failure prune-scan-results
 * was rewritten to avoid.
 */
import { sbJson, sbRequest } from './lib/sb.mjs';
import { serveDb } from './_lab.mjs';
import { keysetPage } from './lib/archive.mjs';

const DAYS = Number((process.argv.find(a => a.startsWith('--days=')) || '--days=14').split('=')[1]);
const APPLY = process.argv.includes('--apply');

const { url: SUP, headers: H } = serveDb();

function cutoffISO(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const cutoff = cutoffISO(DAYS);

  // Cheap: pick_id + pick_date, never the jsonb. KEYSET-paged on pick_id, which
  // is not optional — PostgREST caps a response at 1000 rows, so the unpaginated
  // version of this query saw 1000 of 4472 rows and would have pruned against a
  // third of the table's date range. pick_date is not unique, so the cursor rides
  // on the PK.
  const rows = await keysetPage({
    sbJson, url: SUP, headers: H, table: 'pick_signals',
    select: 'pick_id,pick_date', order: 'pick_id', page: 1000, pause: 0,
  });
  const dates = [...new Set(rows.map(r => r.pick_date).filter(Boolean))].sort();
  const counts = new Map();
  for (const r of rows) counts.set(r.pick_date, (counts.get(r.pick_date) || 0) + 1);

  const old = dates.filter(d => d < cutoff);
  const oldRows = old.reduce((n, d) => n + (counts.get(d) || 0), 0);
  console.log(`pick_signals: ${rows.length} rows across ${dates.length} dates`);
  console.log(`  range: ${dates[0]} … ${dates[dates.length - 1]}`);
  console.log(`  cutoff (keep last ${DAYS}d): < ${cutoff} → ${old.length} dates / ${oldRows} rows to prune`);

  if (!old.length) { console.log('Nothing to prune.'); return; }
  if (!APPLY) {
    console.log('\nDry-run. Verify the archive first:');
    console.log('  node --env-file=.env.local scripts/archive.mjs --verify');
    console.log('then re-run with --apply.');
    return;
  }

  let done = 0, failed = 0;
  for (const d of old) {
    // Idempotent: deleting one pick_date twice deletes the same nothing the
    // second time, so this is safe to retry across a stall.
    try {
      await sbRequest(
        `${SUP}/rest/v1/pick_signals?pick_date=eq.${d}`,
        { method: 'DELETE', headers: H },
        { idempotent: true, label: `prune ${d}` }
      );
    } catch (e) { console.error(`  ✗ ${d} → ${e.message}`); failed++; continue; }
    done++;
    if (done % 10 === 0) console.log(`  …deleted ${done}/${old.length} dates`);
  }
  console.log(`Pruned ${done}/${old.length} dates (${failed} failed). Autovacuum reclaims the space.`);
  if (failed) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
