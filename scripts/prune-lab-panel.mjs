#!/usr/bin/env node
/**
 * Prune the three LAB panel tables now that the Drive archive is the history.
 *
 *   player_day_features    176 MB
 *   batter_asof_features    44 MB
 *   pitcher_asof_features   34 MB
 *
 * 254 MB of LAB's 367 MB — and LAB's cap is the same 500 MB SERVE has, on the
 * same 0.5 GB Nano. This is the LAB half of the 2026-09-08 archive migration;
 * see scripts/lib/panel-archive.mjs for why these three move and why
 * mining_findings (a live Findings-tab relay via api/findings.js) and
 * pick_feature_matrix (mining-cron's rebuildable cache) do not.
 *
 * RETENTION IS 14 DAYS, set by the deepest remaining Postgres-side reader:
 *   - brain-trust-snapshot.mjs backfillMissing(daysBack = 5) and its per-date
 *     grade read
 *   - sanity-check.mjs, which asserts on daysAgo(4)..daysAgo(1)
 *   - api/_freshness.js, max date only
 *   - player-day-panel.mjs WRITES here daily and is untouched
 * 14 leaves ~3x headroom over the 5-day consumer. Every full-history reader
 * (alt-line-backtest, fit-blend, calibrate-retune, alt-line-audit, mining-engine,
 * incremental-value, theory-harness, prediction-lab, recent-form-lift,
 * composite-dilution-test, clamp-width-test, hits-drop-swingtake-refit) goes
 * through the archive now, so this costs them nothing.
 *
 * SAFETY: run `node scripts/archive.mjs --verify` first — it exits 2 if any date
 * in Postgres is missing from Drive. backup-to-drive.yml runs sync → verify →
 * prune in that order for exactly this reason.
 *
 *   node --env-file=.env.local scripts/prune-lab-panel.mjs            # dry-run
 *   node --env-file=.env.local scripts/prune-lab-panel.mjs --apply
 *   node --env-file=.env.local scripts/prune-lab-panel.mjs --days=30 --apply
 *
 * Deletes one game_date at a time: a bulk DELETE across a 176 MB table hits the
 * statement timeout, the same failure prune-scan-results was rewritten to avoid.
 */
import { sbRequest } from './lib/sb.mjs';
import { labDb } from './_lab.mjs';
import { ALL as PANELS } from './lib/panel-archive.mjs';

const DAYS = Number((process.argv.find(a => a.startsWith('--days=')) || '--days=14').split('=')[1]);
const APPLY = process.argv.includes('--apply');

function cutoffISO(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const cutoff = cutoffISO(DAYS);
  const { url, headers } = labDb();
  let totalOld = 0;

  for (const a of PANELS) {
    const pg = await a.datesInDb();
    const onDrive = new Set(a.datesOnDrive());
    const old = pg.filter(d => d < cutoff);

    // Belt and braces on top of `archive.mjs --verify`: never delete a date this
    // table's own archive cannot produce, even if the verify step were skipped.
    const unarchived = old.filter(d => !onDrive.has(d));
    console.log(`\n${a.name}: ${pg.length} dates in Postgres, ${onDrive.size} on Drive`);
    console.log(`  cutoff (keep last ${DAYS}d): < ${cutoff} → ${old.length} dates to prune`);
    if (unarchived.length) {
      console.error(`  ✗ ${unarchived.length} of those are NOT on Drive — refusing to prune ${a.name}`);
      console.error(`    run: node --env-file=.env.local scripts/archive.mjs --export --dataset=panels`);
      process.exitCode = 2;
      continue;
    }
    totalOld += old.length;
    if (!old.length || !APPLY) continue;

    let done = 0, failed = 0;
    for (const d of old) {
      try {
        await sbRequest(
          `${url}/rest/v1/${a.table}?game_date=eq.${d}`,
          { method: 'DELETE', headers },
          { idempotent: true, label: `prune ${a.table} ${d}` }
        );
      } catch (e) { console.error(`  ✗ ${d} → ${e.message}`); failed++; continue; }
      done++;
      if (done % 25 === 0) console.log(`  …deleted ${done}/${old.length} dates`);
    }
    console.log(`  pruned ${done}/${old.length} dates (${failed} failed)`);
    if (failed) process.exitCode = 1;
  }

  if (!APPLY) {
    console.log(`\nDry-run: ${totalOld} dates would be pruned across ${PANELS.length} tables.`);
    console.log('Verify the archive first:  node --env-file=.env.local scripts/archive.mjs --verify');
    console.log('then re-run with --apply.');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
