/**
 * Prune old daily_scan_results rows to cap disk + Disk-IO budget on free-tier Supabase.
 *
 * daily_scan_results holds ONE ~2 MB jsonb row per game_date (upsert on_conflict=game_date).
 * Unbounded since season start → bloats the 500 MB free-tier disk and burns sustained
 * Disk IO (autovacuum churn + heavy reads/writes). Old blobs are already mirrored to Drive
 * by backup-to-drive.mjs, so pruning them is recoverable.
 *
 * RETENTION IS 35 DAYS, and that number is load-bearing rather than round. The
 * day-level research on this table — edge-scout's matchup joins, alt-line-backtest,
 * tb-replay, calibrate-retune — all describe 35 usable days as their substrate, so
 * 35 is the largest trim that costs no analysis anything. Going shorter frees
 * ~1.9 MB per day dropped and starts breaking those joins; going longer buys
 * nothing any current script reads. Measured 2026-08-25: 41 rows, 1902 kB average,
 * 76 MB of payload, of which `players[].models` is 92%.
 *
 * This does NOT need to defend the 500 MB disk cap — SERVE sits at 240 MB with
 * 261 MB free. It caps how much cold jsonb competes for a 224 MB shared_buffers
 * on a 0.5 GB Nano, which is the resource that actually runs out (2026-08-11 OOM,
 * 2026-08-25 wedge).
 *
 * Usage:
 *   node --env-file=.env.local scripts/prune-scan-results.mjs            # dry-run
 *   node --env-file=.env.local scripts/prune-scan-results.mjs --apply
 *   node --env-file=.env.local scripts/prune-scan-results.mjs --days=21 --apply
 *
 * Rows are deleted one date at a time (each row is ~2 MB) to avoid statement timeouts.
 *
 * Space is reclaimed by autovacuum, not here: db/migrations/011 lowers this table's
 * autovacuum thresholds to 2 tuples, because the defaults are row-COUNT based and a
 * 41-row table never reaches them however many megabytes it holds. Before that
 * migration this table had never been vacuumed or analyzed in its life.
 */
import { sbJson, sbRequest } from './lib/sb.mjs';

const SUP = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUP || !KEY) { console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }

const DAYS  = Number((process.argv.find(a => a.startsWith("--days=")) || "--days=35").split("=")[1]);
const APPLY = process.argv.includes("--apply");

const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

function cutoffISO(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const cutoff = cutoffISO(DAYS);

  // Cheap: pull just the game_date column (no 2 MB results payload).
  const dates = (await sbJson(`${SUP}/rest/v1/daily_scan_results?select=game_date&order=game_date.asc`, { headers: H }))
    .map(r => r.game_date);

  const old = dates.filter(d => d < cutoff);
  console.log(`daily_scan_results: ${dates.length} rows (one ~2 MB blob/day)`);
  console.log(`  range: ${dates[0]} … ${dates[dates.length - 1]}`);
  console.log(`  cutoff (keep last ${DAYS}d): < ${cutoff} → ${old.length} rows to prune (~${(old.length * 2).toFixed(0)} MB)`);

  if (!old.length) { console.log("Nothing to prune."); return; }
  if (!APPLY) { console.log("\nDry-run. Re-run with --apply to delete."); return; }

  let done = 0;
  for (const d of old) {
    // idempotent: deleting one game_date twice deletes the same nothing the
    // second time, so this is safe to retry across a stall.
    try {
      await sbRequest(`${SUP}/rest/v1/daily_scan_results?game_date=eq.${d}`, { method: "DELETE", headers: H }, { idempotent: true, label: `prune ${d}` });
    } catch (e) { console.error(`  ✗ ${d} → ${e.message}`); continue; }
    done++;
    if (done % 10 === 0) console.log(`  …deleted ${done}/${old.length}`);
  }
  // No manual VACUUM instruction here any more: db/migrations/011 sets this
  // table's autovacuum threshold to 2 tuples, so the deletes above are enough to
  // trigger a vacuum + analyze on their own. The old note told the operator to
  // run VACUUM (FULL) by hand, which nobody ever did — hence a table that had
  // never been vacuumed once.
  console.log(`Pruned ${done}/${old.length} rows. Autovacuum will reclaim the space (migration 011).`);
}

main().catch(e => { console.error(e); process.exit(1); });
