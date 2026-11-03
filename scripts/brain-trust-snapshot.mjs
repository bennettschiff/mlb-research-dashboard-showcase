#!/usr/bin/env node
/**
 * brain-trust-snapshot.mjs — forward-grade capture for the Brain Trust tab.
 *
 * WHY: the tab computes predictions + parlays client-side from the day's scan + odds. Without a
 * persisted snapshot we can never prove whether "model says 55% / +80% EV" actually returns money
 * (the calibrated-vs-bettable question, and the selection-effect on Value EVs). And per the Golden 10
 * lesson (project_golden_snapshot_server), a browser-only snapshot vanishes on any day nobody opens
 * the tab. So this runs SERVER-SIDE, mirroring the tab exactly by importing the same lib functions.
 *
 *   --snapshot [--date=YYYY-MM-DD]   build + upsert that day's predictions + value/safe parlays
 *                                    (default date = today ET). Run midday after scan + odds land.
 *   --grade    [--date=YYYY-MM-DD]   grade a past day's snapshot vs player_day_features outcomes
 *                                    (default = yesterday ET). Realized hit rate + ROI per tier,
 *                                    and per-flavor parlay W/L + ROI.
 *
 * Substrate: daily_scan_results (model scores) + daily_odds (book odds) + player_day_features
 * (outcomes). Paged 1 date at a time (2MB scan blobs). Fidelity guaranteed by importing
 * gradeAllLines/buildParlays — server snapshot == what the tab renders.
 *
 * Run: set -a; source .env.local; set +a; node scripts/brain-trust-snapshot.mjs --snapshot
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gradeAllLines, bestBookOdds } from '../src/lib/models.js';
import { buildParlays } from '../src/lib/parlays.js';
import { dbForPath } from './_lab.mjs';
import { sbJson } from './lib/sb.mjs';

// Reading .env.local is a LOCAL convenience only, and it must not run when this
// module is imported by api/cron.js: on Vercel there is no .env.local, cwd is
// not the repo root, and the filesystem is read-only. Guarded to the CLI entry
// point below for the same reason the credential check moved there.
function loadLocalEnv() {
  try { // in CI the vars come from the workflow env, no .env.local exists
    for (const line of readFileSync(resolve(process.cwd(), '.env.local'), 'utf8').split('\n')) {
      const [k, ...v] = line.split('=');
      if (k && v.length && !process.env[k.trim()]) process.env[k.trim()] = v.join('=').trim();
    }
  } catch {}
}

// Credentials are read PER CALL, not at module load. Throwing at import time
// made this module unimportable, which is why the whole board chain could only
// ever run from a GitHub workflow — the single delivery path that failed on
// 2026-08-31 and left the Golden tab empty all slate. golden-snapshot.mjs
// already carries the same note; this is the other half of it.
const H = () => {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!process.env.SUPABASE_URL || !key) throw new Error('Missing Supabase credentials');
  return { apikey: key, Authorization: `Bearer ${key}` };
};
const arg = k => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1] || null;
const etToday = () => new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })).toISOString().slice(0, 10);
const etYesterday = () => new Date(Date.parse(etToday()) - 86400000).toISOString().slice(0, 10);

// Retries 5xx/network — Supabase is behind Cloudflare and a lone transient 520
// used to fail the run outright. 4xx is a real error, so fail fast on it. The
// policy moved into scripts/lib/sb.mjs on 2026-09-05; the local three-tries /
// 500 ms version here retried entirely inside that day's 8-minute stall.
// Writes are merge-duplicates upserts, so retrying one is safe.
async function sb(path, opts = {}) {
  const { url: _sbUrl, headers: _sbH } = dbForPath(path);
  return sbJson(`${_sbUrl}/rest/v1/${path}`, { headers: _sbH, ...opts },
    { idempotent: true, label: path.slice(0, 80) });
}
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');
const dec = a => (a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a));

// market → { role, stat (panel-outcomes key), std, alt }. Mirrors BrainTrust.jsx config.
const MARKETS = {
  hits: { role: 'batter', stat: 'hits', std: 'batter_hits', alt: 'batter_hits_alternate' },
  hrr:  { role: 'batter', stat: 'hrr',  std: 'batter_hits_runs_rbis', alt: 'batter_hits_runs_rbis_alternate' },
  tb:   { role: 'batter', stat: 'tb',   std: 'batter_total_bases', alt: 'batter_total_bases_alternate' },
  rbi:  { role: 'batter', stat: 'rbi',  std: 'batter_rbis', alt: 'batter_rbis_alternate' },
  hr:   { role: 'batter', stat: 'hr',   std: 'batter_home_runs', alt: 'batter_home_runs_alternate' },
  sb:   { role: 'batter', stat: 'sb',   std: 'batter_stolen_bases', alt: 'batter_stolen_bases_alternate' },
  ks:   { role: 'pitcher', stat: 'ks',  std: 'pitcher_strikeouts', alt: 'pitcher_strikeouts_alternate' },
};

// ── odds map for a date → { 'market|normName|line': { price, book } } ──
// The book that posted the best price is carried alongside it so downstream
// consumers (Golden boards) can show WHERE a quoted price came from. Collapsing
// to a bare number here is what used to make that unrecoverable.
async function loadOdds(date) {
  const rows = await sb(`daily_odds?select=props_data&game_date=eq.${date}&limit=1`).catch(() => []);
  const best = new Map();
  const pd = rows?.[0]?.props_data;
  if (!Array.isArray(pd)) return best;
  const byKey = {}; // odds-api market key → our label
  for (const [label, m] of Object.entries(MARKETS)) { byKey[m.std] = label; byKey[m.alt] = label; }
  for (const ev of pd) for (const bm of ev.bookmakers || []) for (const m of bm.markets || []) {
    const label = byKey[m.key]; if (!label) continue;
    for (const o of m.outcomes || []) {
      if (o.name !== 'Over' || o.point == null || o.price == null) continue;
      const k = `${label}|${norm(o.description)}|${Number(o.point)}`;
      const prev = best.get(k);
      if (prev == null || Number(o.price) > prev.price) best.set(k, { price: Number(o.price), book: bm.key });
    }
  }
  return best;
}

// { line: price } for gradeAllLines, plus the parallel { line: book }.
function oddsByLine(best, label, name) {
  const o = {}, books = {}; const pre = `${label}|${norm(name)}|`;
  for (const [k, v] of best) {
    if (!k.startsWith(pre)) continue;
    const line = Number(k.slice(pre.length));
    o[line] = v.price;
    books[line] = v.book;
  }
  return { prices: o, books };
}

// ── build predictions + parlays for a date (mirrors the tab) ──
async function build(date) {
  const scan = (await sb(`daily_scan_results?select=results&game_date=eq.${date}&limit=1`))?.[0]?.results;
  if (!scan) throw new Error(`no daily_scan_results for ${date}`);
  const best = await loadOdds(date);
  const predictions = [], legs = [];
  const ingest = (name, gamePk, team, opp, label, score) => {
    if (!Number.isFinite(score) || score <= 0) return;
    const { prices, books } = oddsByLine(best, label, name);
    const grid = gradeAllLines(score, label, prices);
    for (const r of grid) {
      if (r.bookOdds == null) continue;
      predictions.push({ name, gamePk, team, opp, market: label, line: r.line, modelProb: r.modelProb,
        bookOdds: r.bookOdds, book: books[r.line] ?? null, fairOdds: r.fairOdds, edge: r.edge, ev: r.ev, trust: r.trust });
      if (r.trust === 'trusted')
        legs.push({ id: `${name}|${label}|${r.line}`, player: name, gamePk, team, opp, market: label,
          marketLabel: label, line: r.line, modelProb: r.modelProb, bookOdds: r.bookOdds, edge: r.edge, ev: r.ev, trust: r.trust });
    }
  };
  for (const p of scan.players || []) for (const label of ['hits', 'hrr', 'tb', 'rbi', 'hr', 'sb'])
    ingest(p.name, p.gamePk, p.team, p.opponent, label, Number(p.models?.[label]?.score));
  for (const p of scan.pitchers || []) ingest(p.name, p.gamePk, p.team, p.opponent, 'ks', Number(p.xK));

  const value = buildParlays(legs, { rankBy: 'ev', minEv: 0.05, minLegProb: 0.45, haircut: 0.33, maxResults: 8 });
  const safe = buildParlays(legs, { rankBy: 'jointProb', minEv: -1, minLegProb: 0.55, minJointProb: 0.33, minCombinedDecimal: 2.0, haircut: 0.25, maxResults: 8 });
  return { predictions, value, safe, legCount: legs.length };
}

export async function snapshot(date) {
  const { predictions, value, safe, legCount } = await build(date);
  await sb(`brain_trust_snapshots?on_conflict=game_date`, {
    method: 'POST',
    headers: { ...H(), 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ game_date: date, predictions, value_parlays: value, safe_parlays: safe, graded: false, results: null, graded_at: null }),
  });
  console.log(`[brain-trust] snapshot ${date}: ${predictions.length} priced predictions, ${legCount} trusted legs, ${value.length} value + ${safe.length} safe parlays`);
}

// Self-healing snapshot backfill (companion to gradeSweep). The 12:30 PM ET snapshot soft-skips
// when the day's scan hasn't landed yet, and it never retried — a scan that persisted late (or on
// a later app load) left a permanent hole with no snapshot to grade (this is how 2026-07-08 was
// lost: scan-blob write missed at snapshot time, never recaptured). Each run now also backfills
// any recent date that HAS a scan+odds but NO snapshot row yet. build() reads only scan+odds, so a
// snapshot rebuilt later is byte-for-byte what the tab would have shown that day — outcomes never
// enter it, so there's no look-ahead. Guarded to dates with no existing row, so it can never
// overwrite (and reset graded=false on) an already-graded snapshot.
async function backfillMissing(daysBack = 5) {
  const since = new Date(Date.parse(etToday()) - daysBack * 86400000).toISOString().slice(0, 10);
  const scanDates = (await sb(`daily_scan_results?select=game_date&game_date=gte.${since}&order=game_date.desc`).catch(() => [])) || [];
  const snapDates = new Set(((await sb(`brain_trust_snapshots?select=game_date&game_date=gte.${since}`).catch(() => [])) || []).map(r => r.game_date));
  const missing = scanDates.map(r => r.game_date).filter(d => d !== etToday() && !snapDates.has(d));
  if (!missing.length) { console.log('[brain-trust] backfill: no missing snapshots in window'); return; }
  let done = 0, skipped = 0;
  for (const d of missing) {
    try { await snapshot(d); done++; }
    catch (e) {
      if (isSoftSkip(e)) { console.warn(`[brain-trust] backfill skip ${d}: ${e.message}`); skipped++; }
      else throw e;
    }
  }
  console.log(`[brain-trust] backfill done: ${done} recaptured, ${skipped} still waiting on data`);
}

// ── grading ──
async function loadOutcomes(date) {
  const map = new Map();
  const rows = await sb(`player_day_features?select=player_name,role,outcomes&game_date=eq.${date}&outcomes=not.is.null&limit=2000`);
  for (const r of rows) map.set(`${r.role}|${norm(r.player_name)}`, r.outcomes);
  return map;
}
const won = (oc, market, line) => {
  const v = Number(oc?.[MARKETS[market].stat]);
  return Number.isFinite(v) ? v > line : null;
};
const roi = arr => (arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : null);

async function grade(date) {
  const row = (await sb(`brain_trust_snapshots?select=*&game_date=eq.${date}&limit=1`))?.[0];
  if (!row) throw new Error(`no snapshot for ${date} — run --snapshot first`);
  const oc = await loadOutcomes(date);
  if (!oc.size) throw new Error(`no graded outcomes for ${date} yet`);

  // predictions: realized hit rate + flat-bet ROI by trust tier and overall
  const tiers = {};
  let graded = 0;
  for (const p of row.predictions || []) {
    const w = won(oc.get(`${MARKETS[p.market].role}|${norm(p.name)}`), p.market, p.line);
    if (w == null) continue;
    graded++;
    const t = (tiers[p.trust] ??= { n: 0, hits: 0, pnl: [] });
    t.n++; if (w) t.hits++;
    t.pnl.push(w ? dec(p.bookOdds) - 1 : -1);
  }
  const predSummary = Object.fromEntries(Object.entries(tiers).map(([k, t]) => [k, { n: t.n, hitRate: t.hits / t.n, roi: roi(t.pnl) }]));

  // parlays: a slip wins iff every leg clears. Keep per-slip + per-leg detail so the Results tab
  // can show the record AND which legs lost.
  const gradeSlips = slips => {
    let n = 0, wins = 0; const pnl = []; const detail = [];
    for (const s of slips || []) {
      const legs = s.legs.map(l => {
        const v = Number(oc.get(`${MARKETS[l.market].role}|${norm(l.player)}`)?.[MARKETS[l.market].stat]);
        const graded = Number.isFinite(v);
        return { player: l.player, team: l.team, opp: l.opp, market: l.market, line: l.line,
          bookOdds: l.bookOdds, modelProb: l.modelProb, value: graded ? v : null, won: graded ? v > l.line : null };
      });
      const slipBase = { legCount: s.legCount, combinedAmerican: s.combinedAmerican, combinedDecimal: s.combinedDecimal,
        jointProb: s.jointProb, ev: s.ev, legs };
      if (legs.some(l => l.won == null)) { detail.push({ ...slipBase, graded: false, won: null }); continue; }
      n++;
      const win = legs.every(l => l.won);
      if (win) wins++;
      pnl.push(win ? s.combinedDecimal - 1 : -1);
      detail.push({ ...slipBase, graded: true, won: win });
    }
    return { n, wins, winRate: n ? wins / n : null, roi: roi(pnl), slips: detail };
  };

  const results = {
    predictions: { graded, byTrust: predSummary },
    value_parlays: gradeSlips(row.value_parlays),
    safe_parlays: gradeSlips(row.safe_parlays),
  };
  await sb(`brain_trust_snapshots?game_date=eq.${date}`, {
    method: 'PATCH',
    headers: { ...H(), 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ graded: true, graded_at: new Date().toISOString(), results }),
  });
  const pct = x => (x == null ? '—' : `${(100 * x).toFixed(1)}%`);
  console.log(`[brain-trust] graded ${date}: ${graded} predictions`);
  for (const [t, s] of Object.entries(predSummary)) console.log(`  ${t.padEnd(12)} n=${s.n}  hit ${pct(s.hitRate)}  ROI ${pct(s.roi)}`);
  console.log(`  value parlays  n=${results.value_parlays.n}  win ${pct(results.value_parlays.winRate)}  ROI ${pct(results.value_parlays.roi)}`);
  console.log(`  safe parlays   n=${results.safe_parlays.n}  win ${pct(results.safe_parlays.winRate)}  ROI ${pct(results.safe_parlays.roi)}`);
}

export const isSoftSkip = e => /^no (daily_scan_results|snapshot|graded outcomes)/.test(e.message);

// Sweep every ungraded snapshot and grade the ones whose outcomes have landed.
// This is what makes the record self-healing: --grade with no --date no longer
// grades only yesterday (which races the 9 AM player_day_features outcome write
// and left the record stuck at 6/23), it retries EVERY still-ungraded day. A day
// that soft-skips today because outcomes aren't ready gets picked up automatically
// on the next run — no orphaned dates, no manual backfill.
async function gradeSweep() {
  const rows = await sb('brain_trust_snapshots?select=game_date&graded=eq.false&order=game_date.asc');
  if (!rows?.length) { console.log('[brain-trust] sweep: nothing ungraded'); return; }
  let graded = 0, skipped = 0;
  for (const { game_date } of rows) {
    try { await grade(game_date); graded++; }
    catch (e) {
      if (isSoftSkip(e)) { console.warn(`[brain-trust] skip ${game_date}: ${e.message}`); skipped++; }
      else throw e;
    }
  }
  console.log(`[brain-trust] sweep done: ${graded} graded, ${skipped} still waiting on data`);
}

// CLI entry point. Guarded so `import { snapshot }` from api/cron.js loads the
// module without running a grade sweep as a side effect of being imported.
const isCli = import.meta.url === `file://${process.argv[1]}`;

await (async () => {
  if (!isCli) return;
  loadLocalEnv();
  const date = arg('date');
  try {
    // --grade --date=X grades one day (manual/backfill). --grade alone sweeps all ungraded.
    if (process.argv.includes('--grade')) { if (date) await grade(date); else await gradeSweep(); }
    else if (process.argv.includes('--snapshot')) {
      if (date) { await snapshot(date); }
      else {
        // Today's scan may not have landed yet — soft-skip that alone so the backfill still runs.
        try { await snapshot(etToday()); }
        catch (e) { if (isSoftSkip(e)) console.warn(`[brain-trust] skip ${etToday()}: ${e.message}`); else throw e; }
        // Backfill any recent day whose scan landed after its own snapshot window (self-healing).
        await backfillMissing();
      }
    }
    else { console.error('usage: --snapshot [--date=YYYY-MM-DD] | --grade [--date=YYYY-MM-DD]'); process.exit(1); }
  } catch (e) {
    // Upstream data not landed yet (scan/odds/outcomes) is a soft skip, not a failure — a cron
    // alert here would be noise. Genuine errors (bad SQL, auth) still exit 1.
    if (isSoftSkip(e)) {
      console.warn(`[brain-trust] skip ${date || ''}: ${e.message}`);
      process.exit(0);
    }
    throw e;
  }
})();
