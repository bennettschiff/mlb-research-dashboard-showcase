#!/usr/bin/env node
/**
 * sanity-check.mjs — catch GREEN-BUT-WRONG pipeline failures.
 *
 * ops-alert.yml only fires when a workflow reports failure/cancel/timeout. But
 * the most expensive incidents here were workflows that ran "successfully" while
 * producing nothing:
 *   - headless auto-score graded 0 picks in CI (looked green for days)
 *   - raw_signals capture silently broke for 5 days
 *   - postponed games left picks pending forever
 *   - HRR official picks were silently 0 for 10 days
 *
 * This script asserts data-level invariants and EXITS NON-ZERO on violation, so
 * the existing ops-alert plumbing opens a GitHub issue. Checks are deliberately
 * conservative (require a populated window + TOTAL failure) to avoid alert fatigue
 * on legitimate off-days.
 *
 * Run: set -a; source .env.local; set +a; node scripts/sanity-check.mjs
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { dbForPath } from './_lab.mjs';
import { sbJson } from './lib/sb.mjs';

try {
  const envFile = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8');
  envFile.split('\n').forEach(line => {
    const [k, ...rest] = line.split('=');
    if (k && rest.length && !process.env[k.trim()]) process.env[k.trim()] = rest.join('=').trim();
  });
} catch {}

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) { console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
const sbHeaders = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

const dayStr = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => dayStr(new Date(Date.now() - n * 86400000));

// This job's whole output is "are the data invariants holding" — so a read that
// dies on a transient 5xx doesn't just fail the run, it reports a data problem
// that doesn't exist. On 2026-09-05 the shared instance stalled for ~8 minutes
// and 504'd every request after 135-180 s; a bare fetch here would have raised a
// false alarm about the pipeline.
async function sb(path) {
  const { url: _sbUrl, headers: _sbH } = dbForPath(path);
  return sbJson(`${_sbUrl}/rest/v1/${path}`, { headers: _sbH }, { label: path.slice(0, 80) });
}

const failures = [];
const notes = [];

// ── Check A: the save pipeline is producing picks ──────────────────────────
// A 3-day in-season window with ZERO saved picks means daily-picks save is dead
// (the lock-filter / headless-0 / timeout-kill class). 3 days never goes all-off
// in-season, so this won't fire on a single off-day.
async function checkSavePipeline() {
  const since = daysAgo(3);
  const rows = await sb(`mlb_picks?select=id&pick_date=gte.${since}&limit=1`);
  if (rows.length === 0) {
    failures.push(`No picks saved in the last 3 days (since ${since}). daily-picks save pipeline is likely broken.`);
  } else {
    notes.push(`✓ Save pipeline: picks exist within the last 3 days.`);
  }
}

// ── Check B: yesterday's settled slate got SCORED ──────────────────────────
// Picks from 2–7 days ago are old enough that the game has finished and
// morning-score should have graded them. If a populated window is ENTIRELY
// pending, scoring is broken (headless-0-score / postponed-starvation class).
async function checkScoring() {
  const lo = daysAgo(7), hi = daysAgo(2);
  const rows = await sb(`mlb_picks?select=outcome&pick_date=gte.${lo}&pick_date=lte.${hi}&limit=1000`);
  if (rows.length < 10) { notes.push(`• Scoring: only ${rows.length} picks in the ${lo}..${hi} window — skipped (too few).`); return; }
  const graded = rows.filter(r => r.outcome === 'win' || r.outcome === 'loss' || r.outcome === 'push').length;
  if (graded === 0) {
    failures.push(`All ${rows.length} picks from ${lo}..${hi} are still ungraded. Scoring pipeline (morning-score) is likely broken.`);
  } else {
    notes.push(`✓ Scoring: ${graded}/${rows.length} settled picks graded in ${lo}..${hi}.`);
  }
}

// ── Check C: CLV capture is running ────────────────────────────────────────
// The closing-odds workflow stamps clv_pct after each game closes. Capture is
// judged by RECENCY of the newest stamp, not by whether some window is entirely
// null: a historical gap that has since recovered (e.g. the 2026-06-25..06-30
// Odds-API credit exhaustion) must NOT page — the fixed-window "all null" test
// false-alarmed on exactly that on 2026-07-02, days after capture resumed.
// Real breakage still trips it: if closing-odds actually stops, the newest
// clv_pct date falls behind the staleness cutoff and this fails.
async function checkClvCapture() {
  const lo = daysAgo(10), hi = daysAgo(1);
  const rows = await sb(`mlb_picks?select=pick_date,clv_pct&pick_date=gte.${lo}&pick_date=lte.${hi}&limit=2000`);
  if (rows.length < 10) { notes.push(`• CLV: only ${rows.length} picks in the ${lo}..${hi} window — skipped (too few).`); return; }
  const withClv = rows.filter(r => r.clv_pct != null);
  // Newest pick_date carrying ANY CLV. A 4-day cutoff absorbs a weekend/off-day
  // or a slate whose closing snapshot hasn't landed yet, while still catching a
  // genuinely dead capture (which goes many days with no fresh stamp).
  const newestClvDate = withClv.reduce((m, r) => (r.pick_date > m ? r.pick_date : m), '');
  const staleCutoff = daysAgo(4);
  if (!newestClvDate) {
    failures.push(`No picks from ${lo}..${hi} have clv_pct populated (${rows.length} checked). CLV capture (closing-odds) is likely broken.`);
  } else if (newestClvDate < staleCutoff) {
    failures.push(`CLV capture is stale: newest clv_pct is ${newestClvDate} (older than ${staleCutoff}). closing-odds has likely stopped stamping.`);
  } else {
    notes.push(`✓ CLV capture: newest closing-line value ${newestClvDate} (${withClv.length}/${rows.length} populated in ${lo}..${hi}).`);
  }
}

// ── Check D: the advanced-stats ETL is actually refreshing ──────────────────
// The daily Savant ETL upserts batter/pitcher advanced stats in place. It exits
// green even when it writes nothing — which is exactly how batter_advanced_stats
// froze 2026-05-20..06-22 (cron ran the deprecated pybaseball script). ops-alert
// can't see a green no-op, so assert freshness directly: if either table's newest
// updated_at is older than 48h, the feed is stale and the model is pricing on old
// inputs. 48h tolerates one skipped daily run without firing.
async function checkAdvStatsFreshness() {
  const STALE_H = 48;
  for (const table of ['batter_advanced_stats', 'pitcher_advanced_stats']) {
    const rows = await sb(`${table}?select=updated_at&order=updated_at.desc&limit=1`);
    if (rows.length === 0) { failures.push(`${table} is EMPTY — advanced-stats ETL has never populated it.`); continue; }
    const ageH = (Date.now() - Date.parse(rows[0].updated_at)) / 3600000;
    if (ageH > STALE_H) {
      failures.push(`${table} last updated ${ageH.toFixed(0)}h ago (>${STALE_H}h). Advanced-stats ETL (Savant) is green-but-stale — model is pricing on old stats.`);
    } else {
      notes.push(`✓ Adv-stats freshness: ${table} updated ${ageH.toFixed(0)}h ago.`);
    }
  }
}

// ── Check E: the player-day panel is accumulating ──────────────────────────
// The daily panel workflow snapshots today's atoms and grades yesterday's
// outcomes into player_day_features. Like the ETL, it can exit green while
// writing nothing (Supabase blip, API change). Assert both halves moved: a
// recent atom snapshot exists, and a recent slate got graded. 3-day windows
// tolerate a single skipped run / off-day without firing.
async function checkPanel() {
  const recent = daysAgo(3);
  const [snap, graded] = await Promise.all([
    sb(`player_day_features?select=game_date&atoms=neq.${encodeURIComponent('{}')}&game_date=gte.${recent}&limit=1`),
    sb(`player_day_features?select=game_date&played=is.true&game_date=gte.${daysAgo(4)}&game_date=lte.${daysAgo(1)}&limit=1`),
  ]);
  if (snap.length === 0) failures.push(`player_day_features has no atom snapshot since ${recent}. Panel snapshot step is likely broken.`);
  else notes.push(`✓ Panel: atom snapshot exists within 3 days.`);
  if (graded.length === 0) failures.push(`player_day_features has no graded slate in ${daysAgo(4)}..${daysAgo(1)}. Panel grade step is likely broken.`);
  else notes.push(`✓ Panel: realized outcomes graded within the last few days.`);
}

async function main() {
  await Promise.all([checkSavePipeline(), checkScoring(), checkClvCapture(), checkAdvStatsFreshness(), checkPanel()]);

  console.log('── Sanity check', daysAgo(0), '──');
  notes.forEach(n => console.log(n));
  if (failures.length) {
    console.error('\n🚨 SANITY CHECK FAILED:');
    failures.forEach(f => console.error(`  - ${f}`));
    process.exit(1);
  }
  console.log('\n✓ All sanity checks passed.');
}

main().catch(e => { console.error(`sanity-check error: ${e.message}`); process.exit(1); });
