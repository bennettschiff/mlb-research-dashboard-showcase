#!/usr/bin/env node
/**
 * Plumbing tripwire — deterministic daily replacement for the LLM plumbing audit.
 *
 * WHY: the plumbing-auditor agent cost ~$14/run to conclude "everything is clean"
 * on most days (2026-07-21 burn review). Every check it runs first is a mechanical
 * assertion, so it runs here for free in CI, and the agent is only woken when this
 * script actually trips. Coverage goes UP (this runs even when Claude usage is
 * capped) and cost goes to zero.
 *
 * Failure classes this exists to catch, all of which have really happened:
 *   - CHECK 1  bulk endpoint select omits a column models.js reads → term silently
 *              evaluates to its neutral default (HR fbRateMult, dead ~7 weeks, 2026-07-13)
 *   - CHECK 2  source table column exists but is never populated (csw_pct, 0/720)
 *   - CHECK 3  an ETL stops running and a table freezes (batter adv stats, ~1 month)
 *   - CHECK 4  field is populated in Supabase but arrives null on the actual pick
 *              (the join-key class: bat-tracking dead from day one on id vs player_id)
 *   - CHECK 5  player ids stop resolving through the crosswalk
 *   - CHECK 6  picks stop saving entirely (the NRFI save-gate bug, 2 days lost, 2026-07-19)
 *
 * Known-and-accepted findings live in scripts/plumbing-baseline.json so this only
 * fires on NEW breakage. A tripwire that cries every morning gets ignored, which
 * is the exact failure mode it's meant to prevent.
 *
 * Exit 0 = clean (or baselined). Exit 1 = P0/P1 → ops-alert opens an issue.
 * Always writes docs/plumbing-tripwire-latest.json for the agent to read.
 *
 * Run: node --env-file=.env.local scripts/plumbing-tripwire.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { savedPicksParams } from '../src/lib/pickQueries.js';
import { dbForPath, LAB_TABLES } from './_lab.mjs';
import { sbRequest } from './lib/sb.mjs';
import {
  SOURCES, LOOKBACK_DAYS, recentDates, mlbSlates, presentDates, lastWrite,
  evaluate, etDate, etHour,
} from '../api/_freshness.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_ || !KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const SEASON = Number(process.env.TRIPWIRE_SEASON) || new Date().getUTCFullYear();

const findings = [];
const add = (sev, check, msg, detail) => findings.push({ sev, check, msg, detail });

async function sb(path, { head = false } = {}) {
  const { url: _u, headers: _h } = dbForPath(path);
  const r = await sbRequest(`${_u}/rest/v1/${path}`, {
    headers: { ..._h, ...(head ? { Prefer: 'count=exact', Range: '0-0' } : {}) },
  }, { label: path.slice(0, 80), timeoutMs: 30_000 });
  if (head) return Number((r.headers.get('content-range') || '').split('/')[1] || 0);
  return r.json();
}
const count = p => sb(p, { head: true });
const daysAgo = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

// ---------------------------------------------------------------- baseline
let baseline = { accepted: [] };
try {
  baseline = JSON.parse(readFileSync(resolve(ROOT, 'scripts/plumbing-baseline.json'), 'utf8'));
} catch { /* no baseline yet — everything is new */ }
// An accept may carry `expires` (YYYY-MM-DD). Past that date it stops suppressing,
// so the finding re-trips instead of being permanently muted. This exists for
// LAGGING findings: when a dead model term is removed, the fix is immediate but the
// tripwire reads a 7-day pick_signals window, so it keeps seeing the term on
// historical rows and would fail the workflow every morning for a week — the exact
// cry-wolf failure the baseline is meant to prevent. A dated accept covers the lag
// without becoming a permanent blind spot.
const TODAY = new Date().toISOString().slice(0, 10);
const expiredAccepts = (baseline.accepted || []).filter(a => a.expires && a.expires < TODAY);
const isAccepted = key => (baseline.accepted || []).some(a => a.key === key && (!a.expires || a.expires >= TODAY));

// ------------------------------------------------- CHECK 1: select omission
// Static: every advancedStats field models.js consumes must be in the bulk SELECT
// that api/advanced-stats.js issues, or it arrives undefined on every scan pick.
// Parsed per-table, because which table a field lives on decides where it can
// legitimately appear. pick_signals.adv_stats only ever carries the BATTER row,
// so checking a pitcher field against it reports a dead term that isn't dead.
//
// Two shapes are supported, because api/advanced-stats.js hoisted its column lists out of
// the request handler on 2026-07-31 and the old inline-only regex reported all 29 live
// fields as dead the moment it did. Reading only one shape makes this check silently
// wrong on a refactor — the exact failure mode it exists to catch.
//
//   1. hoisted:  const BATTER_COLS = [ "a", "b", ... ].join(",")   ← current
//   2. inline:   `batter_advanced_stats?...&select=a,b,c`          ← historical
//
function bulkSelectColumns() {
  const src = readFileSync(resolve(ROOT, 'api/advanced-stats.js'), 'utf8');
  const byTable = { batter: new Set(), pitcher: new Set() };

  // Shape 1 — a hoisted BATTER_COLS / PITCHER_COLS array literal. Take everything from
  // the opening bracket to the matching `].join`, then pull the quoted names out; that
  // way `// comments` between entries are ignored rather than parsed as columns.
  for (const side of ['batter', 'pitcher']) {
    const decl = new RegExp(`const\\s+${side.toUpperCase()}_COLS\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*\\.join`, 'i');
    const m = src.match(decl);
    if (m) for (const c of m[1].matchAll(/["']([a-z0-9_]+)["']/gi)) byTable[side].add(c[1]);
  }

  // Shape 2 — an inline select= in the request URL.
  for (const m of src.matchAll(/(batter|pitcher)_advanced_stats\?[^`'"]*?select=([a-z0-9_,]+)/gi))
    for (const c of m[2].split(',')) byTable[m[1].toLowerCase()].add(c.trim());

  // Neither shape matched at all → the parser has drifted from the file again. Fail
  // loudly here rather than emitting a wall of bogus "term is dead" P0s downstream.
  if (!byTable.batter.size || !byTable.pitcher.size) {
    add('P0', 'select-omission',
      `plumbing-tripwire could not parse the bulk SELECT out of api/advanced-stats.js ` +
      `(batter=${byTable.batter.size} cols, pitcher=${byTable.pitcher.size} cols). ` +
      `CHECK 1 is blind until bulkSelectColumns() is taught the current shape — ` +
      `treat every select-omission result below as unreliable.`,
      { batterCols: byTable.batter.size, pitcherCols: byTable.pitcher.size });
  }

  const all = new Set([...byTable.batter, ...byTable.pitcher]);
  return { all, batter: byTable.batter, pitcher: byTable.pitcher };
}
// Batter-side and pitcher-side stats reach models.js as two SEPARATE parameters
// (`advancedStats` and `pitAdvStats`). Auditing only the first leaves every
// pitcher term — including pitDbQualityAdj, the strongest cross-market signal
// we have — completely unguarded.
function consumedFields() {
  const src = readFileSync(resolve(ROOT, 'src/lib/models.js'), 'utf8');
  const batter = new Set(), pitcher = new Set();
  for (const m of src.matchAll(/advancedStats\?\.([a-zA-Z0-9_]+)/g)) batter.add(m[1]);
  for (const m of src.matchAll(/pitAdv(?:Stats)?\??\.([a-zA-Z0-9_]+)/g)) pitcher.add(m[1]);
  return { batter, pitcher };
}
const SEL = bulkSelectColumns();
const selectCols = SEL.all;
const CONSUMED = consumedFields();
const consumed = [...CONSUMED.batter].sort();
const consumedPit = [...CONSUMED.pitcher].sort();

for (const field of consumed) {
  // The Ks model's subject IS the pitcher, so it binds the pitcher row to a
  // parameter also named `advancedStats` (models.js:1906 reads fastball_velo
  // that way). A field missing from the batter select but present in the
  // pitcher select is that naming reuse, not a dead term — runtime delivery is
  // what settles it, and CHECK 4/4b cover that. Only a field in NEITHER select
  // is unambiguously unreachable.
  if (!SEL.batter.has(field) && !SEL.pitcher.has(field)) {
    add('P0', 'select-omission',
      `models.js reads advancedStats.${field} but api/advanced-stats.js SELECTs it from neither table — the term is dead on every scan pick`,
      { field });
  }
}
for (const field of consumedPit) {
  if (!SEL.pitcher.has(field)) {
    add('P0', 'select-omission',
      `models.js reads pitAdvStats.${field} but api/advanced-stats.js never SELECTs it from pitcher_advanced_stats — the pitcher term is dead on every scan pick`,
      { field });
  }
}

// -------------------------------------------- CHECK 2: source-table population
// `popAudit` gates the per-column population sweep below, which only makes sense for
// the two advanced-stats tables (they're the ones api/advanced-stats.js SELECTs from and
// models.js reads off). Every table here still gets the CHECK 3 freshness test.
//
// The five running-game tables were added 2026-07-31. They were absent from this map, so
// nothing watched them — and they were unwatchable anyway until the same commit taught
// etl_running_game.py to stamp updated_at. Before that, a merge-duplicates UPDATE left
// the column at its INSERT default, so max(updated_at) reported when the last NEW player
// first appeared (68 of 77 catcher rows still read 2026-05-24) rather than when the stats
// were refreshed. Adding them here without that fix would have fired false P0s forever.
const TABLES = {
  batter_advanced_stats:  { season: true,  maxAgeDays: 3, popAudit: true },
  pitcher_advanced_stats: { season: true,  maxAgeDays: 3, popAudit: true },
  player_id_crosswalk:    { season: false, maxAgeDays: 8 },
  // SB-model substrate — all five refreshed daily by advanced-stats-etl.yml.
  catcher_throwing:       { season: true,  maxAgeDays: 3 },
  pitcher_running_game:   { season: true,  maxAgeDays: 3 },
  basestealing_run_value: { season: true,  maxAgeDays: 3 },
  baserunning:            { season: true,  maxAgeDays: 3 },
  batter_sprint:          { season: true,  maxAgeDays: 3 },
};
const popReport = {};
for (const [table, cfg] of Object.entries(TABLES)) {
  if (!cfg.season || !cfg.popAudit) continue;
  const q = `season=eq.${SEASON}`;
  const total = await count(`${table}?${q}&select=mlbam_id`);
  popReport[table] = { total, fields: {} };
  if (!total) {
    add('P0', 'population', `${table} has ZERO rows for season ${SEASON}`, { table });
    continue;
  }
  // Only audit columns that are both selected by the API and read by models.js —
  // an unpopulated column nobody reads is payload bloat, not a broken model term.
  const isBat = table.startsWith('batter');
  const own = isBat ? SEL.batter : SEL.pitcher;
  const read = isBat ? consumed : consumedPit;
  const audit = [...own].filter(c => read.includes(c));
  for (const col of audit) {
    let nonNull;
    try {
      nonNull = await count(`${table}?${q}&${col}=not.is.null&select=mlbam_id`);
    } catch { continue; } // column not on this table — it lives on the other one
    const pct = total ? (nonNull / total) * 100 : 0;
    popReport[table].fields[col] = { nonNull, total, pct: +pct.toFixed(1) };
    const key = `population:${table}.${col}`;
    if (isAccepted(key)) continue;
    if (pct === 0) {
      add('P0', 'population', `${table}.${col} is 0% populated (0/${total}) and models.js consumes it — term is dead`, { table, col, pct });
    } else if (pct < 50) {
      add('P1', 'population', `${table}.${col} only ${pct.toFixed(1)}% populated (${nonNull}/${total})`, { table, col, pct });
    }
  }
}

// ------------------------------------------------------- CHECK 3: freshness
for (const [table, cfg] of Object.entries(TABLES)) {
  const rows = await sb(`${table}?select=updated_at&order=updated_at.desc&limit=1`);
  const latest = rows?.[0]?.updated_at;
  if (!latest) { add('P0', 'freshness', `${table} has no updated_at rows at all`, { table }); continue; }
  const ageDays = (Date.now() - new Date(latest).getTime()) / 864e5;
  popReport[table] = { ...(popReport[table] || {}), latest, ageDays: +ageDays.toFixed(1) };
  if (ageDays > cfg.maxAgeDays) {
    add('P0', 'freshness', `${table} is STALE — last updated ${latest} (${ageDays.toFixed(1)}d ago, max ${cfg.maxAgeDays}d)`, { table, latest, ageDays });
  }
}
// ------------------------------------------- CHECK 3b: slate-aware freshness
// Replaces a `player_day_features.game_date older than 3 days` assertion that
// could not fire on the failure it was meant to catch: on 2026-08-28 the panel
// missed exactly one slate, which is ~1 day of age, and the check stayed green
// while the dashboard banner read STALE.
//
// The judgment is NOT reimplemented here. api/_freshness.js already measures
// every pipeline output against the LEAGUE SCHEDULE (an off-day is IDLE, not
// broken) and against the hour a healthy run writes by. Importing it means the
// tripwire and the dashboard can never drift into disagreeing about whether the
// pipeline is up — and it extends the daily assertion from one table to every
// slate-gated MLB source at no extra cost.
{
  const now = new Date();
  const dates = recentDates(now, LOOKBACK_DAYS);
  const since = dates[dates.length - 1];
  const today = etDate(now);
  const hourET = etHour(now);
  let slates = null;
  try { slates = await mlbSlates(dates); } catch { /* handled below */ }

  if (!slates) {
    // Without the schedule every source looks missing. Say so instead of
    // manufacturing a dozen P0s out of an upstream blip.
    add('P1', 'freshness', 'MLB schedule unreachable — slate coverage not verified', {});
  } else {
    popReport.freshness = {};
    for (const src of SOURCES.filter(s => s.gated === 'mlb')) {
      const [u, k] = LAB_TABLES.has(src.table)
        ? [process.env.LAB_SUPABASE_URL, process.env.LAB_SUPABASE_SERVICE_ROLE_KEY]
        : [URL_, KEY];
      try {
        const present = await presentDates(u, k, src, since);
        const newest = [...present].sort().reverse()[0] ?? null;
        const lastTs = newest ? await lastWrite(u, k, src, newest) : null;
        const e = evaluate(src, slates, present, lastTs, now, today, hourET);
        popReport.freshness[src.label] = { status: e.status, detail: e.detail, lastData: e.lastData };
        if (isAccepted(`freshness:${src.label}`)) continue;
        // STALE = the newest expected slate never landed (down now).
        // GAP = older holes only; scan blobs are unrecoverable but not urgent.
        if (e.status === 'STALE') {
          add('P0', 'freshness', `${src.label} STALE — ${e.detail}`, { source: src.label, table: src.table });
        } else if (e.status === 'GAP') {
          add('P1', 'freshness', `${src.label} GAP — ${e.detail}`, { source: src.label, table: src.table });
        }
      } catch (err) {
        add('P1', 'freshness', `${src.label} freshness probe failed — ${err.message}`, { source: src.label });
      }
    }
  }
}

// ------------------------------- CHECK 4: pick-level delivery (the real test)
// A field can be 99% populated in Supabase and still arrive null on every pick.
// pick_signals.adv_stats is what the model actually saw at scan time.
// adv_stats carries the BATTER row only, so pitcher markets (ks) and game markets
// (ou) legitimately have none — checking them here would manufacture P0s.
const BATTER_MARKETS = new Set(['hits', 'hr', 'hrr', 'tb', 'rbi', 'sb']);
{
  const since = daysAgo(7);
  const all = await sb(`pick_signals?pick_date=gte.${since}&select=pick_date,market,adv_stats&limit=1500`);
  const rows = all.filter(r => BATTER_MARKETS.has(r.market));
  const withAdv = rows.filter(r => r.adv_stats && typeof r.adv_stats === 'object' && Object.keys(r.adv_stats).length);
  popReport.pick_delivery = { rows: rows.length, withAdvStats: withAdv.length, since, fields: {} };
  if (!rows.length) {
    add('P0', 'pick-delivery', `pick_signals has ZERO rows since ${since} — mining capture is not running`, { since });
  } else if (withAdv.length / rows.length < 0.5) {
    add('P0', 'pick-delivery', `only ${withAdv.length}/${rows.length} pick_signals rows since ${since} carry adv_stats`, { since });
  } else {
    for (const field of consumed.filter(f => SEL.batter.has(f))) {
      const present = withAdv.filter(r => r.adv_stats[field] !== null && r.adv_stats[field] !== undefined).length;
      const pct = (present / withAdv.length) * 100;
      popReport.pick_delivery.fields[field] = { present, of: withAdv.length, pct: +pct.toFixed(1) };
      const key = `pick-delivery:${field}`;
      if (isAccepted(key)) continue;
      if (pct === 0) {
        add('P0', 'pick-delivery', `advancedStats.${field} arrives null on 100% of picks in the last 7d (0/${withAdv.length}) — model term is silently dead`, { field, pct });
      } else if (pct < 40) {
        add('P1', 'pick-delivery', `advancedStats.${field} present on only ${pct.toFixed(1)}% of picks in the last 7d`, { field, pct });
      }
    }
  }
}

// ------------- CHECK 4b: pitcher-side delivery + neutral-default pinning
// Pitcher stats do NOT ride in adv_stats — they land in pick_signals.signals as
// raw* / *Adj entries (rawPitPlus, rawFastballVelo, pitDbQualityAdj, ...).
//
// The sharper test is not "is it null" but "is it PINNED at its neutral value".
// The fbRateMult outage was a term sitting at exactly 1.0 on every pick for
// ~7 weeks: never null, never alarming, and contributing nothing. A multiplier
// that is identical on 100% of picks is carrying zero information regardless of
// what number it holds.
{
  const since = daysAgo(7);
  const rows = await sb(`pick_signals?pick_date=gte.${since}&select=market,signals&limit=1500`);
  const sig = rows.filter(r => r.signals && Object.keys(r.signals).length);
  popReport.pitcher_delivery = { rows: sig.length, since, fields: {}, pinned: {} };
  if (sig.length >= 20) {
    // Every *Mult / *Adj term the scan actually emits, checked for pinning.
    const termNames = new Set();
    for (const r of sig) for (const k of Object.keys(r.signals)) if (/(Mult|Adj)$/.test(k)) termNames.add(k);
    for (const term of [...termNames].sort()) {
      const vals = sig.map(r => r.signals[term]).filter(v => typeof v === 'number');
      if (vals.length < 20) continue;
      const uniq = new Set(vals.map(v => v.toFixed(6)));
      const coverage = (vals.length / sig.length) * 100;
      popReport.pitcher_delivery.pinned[term] = { n: vals.length, distinct: uniq.size, coverage: +coverage.toFixed(1) };
      const key = `pinned:${term}`;
      if (isAccepted(key)) continue;
      // Only meaningful for terms emitted on essentially EVERY pick. Many terms
      // are sentinel-encoded — `x !== 1.0 ? x : null` (models.js:2407) — so they
      // appear only when they fire, and a single distinct value there just means
      // one tier triggered. fbRateMult, the outage this check exists for, was
      // emitted on every pick and stuck at 1.0.
      if (uniq.size === 1 && coverage >= 90) {
        add('P0', 'neutral-pinned',
          `signals.${term} is emitted on ${coverage.toFixed(0)}% of picks and identical (${vals[0]}) on all ${vals.length} of them in the last 7d — the term is carrying no information`,
          { term, value: vals[0], n: vals.length, coverage });
      }
    }
    // The check above only fires at coverage >= 90, which is right for terms that
    // are sentinel-encoded discrete TIERS (`x !== 1.0 ? x : null`) — one distinct
    // value there just means one tier fired. But it is blind to the failure mode
    // that actually keeps happening: a CONTINUOUS term pinned at a clamp bound,
    // emitted on a minority of picks. Two blind spots, found 2026-07-29:
    //
    //   1. Pooling by key hides per-model pinning. modelHR and modelHRR BOTH emit
    //      `hrFbAdj`. Each was 100% pinned at its own ceiling (1.18 and 1.08), but
    //      pooled they read as "2 distinct values" and looked healthy. Group by
    //      (market, term) so each model's term is judged on its own.
    //   2. Distinct-count misses near-constants. swingTakeMult had 4 distinct
    //      values over 30 days — and 98.9% of them were exactly its 0.96 floor.
    //      Concentration (modal share) catches that; distinct count does not.
    //
    // This is the same pathology as the fbRateMult outage and the hr_fb_pct term
    // removed in 6b46ce7 — a clamped input pinned at a bound is a level shift with
    // zero discrimination, and it is invisible unless you measure concentration.
    // Reported as P1, not P0: unlike a term stuck at exactly neutral (1.0), a pinned
    // non-neutral term still moves scores, so it is wrong rather than inert.
    const MODAL_PIN = 0.95;
    const MODAL_MIN_N = 20;
    popReport.pitcher_delivery.pinnedByMarket = {};
    for (const market of [...new Set(sig.map(r => r.market))].sort()) {
      const mRows = sig.filter(r => r.market === market);
      if (mRows.length < MODAL_MIN_N) continue;
      for (const term of [...termNames].sort()) {
        const vals = mRows.map(r => r.signals[term]).filter(v => typeof v === 'number');
        if (vals.length < MODAL_MIN_N) continue;
        const counts = new Map();
        for (const v of vals) {
          const k = v.toFixed(6);
          counts.set(k, (counts.get(k) || 0) + 1);
        }
        const [modeVal, modeN] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
        const share = modeN / vals.length;
        if (share < MODAL_PIN) continue;
        popReport.pitcher_delivery.pinnedByMarket[`${market}.${term}`] =
          { n: vals.length, mode: +modeVal, share: +(share * 100).toFixed(1) };
        const key = `pinned-modal:${market}.${term}`;
        if (isAccepted(key)) continue;
        add('P1', 'modal-pinned',
          `signals.${term} on ${market} picks is ${(share * 100).toFixed(1)}% identical (${+modeVal}) across ${vals.length} picks in the last 7d — a continuous term stuck at one value is a level shift, not a signal`,
          { market, term, value: +modeVal, n: vals.length, share: +(share * 100).toFixed(1) });
      }
    }

    // Pitcher raw atoms should reach a meaningful share of batter picks.
    const PIT_ATOMS = ['rawPitPlus', 'rawFastballVelo', 'rawPitKPct', 'rawPitBbPct'];
    const batterRows = sig.filter(r => BATTER_MARKETS.has(r.market));
    if (batterRows.length >= 20) {
      for (const atom of PIT_ATOMS) {
        const present = batterRows.filter(r => r.signals[atom] != null).length;
        const pct = (present / batterRows.length) * 100;
        popReport.pitcher_delivery.fields[atom] = { present, of: batterRows.length, pct: +pct.toFixed(1) };
        if (isAccepted(`pitcher-delivery:${atom}`)) continue;
        if (pct === 0) {
          add('P0', 'pitcher-delivery', `signals.${atom} is absent from 100% of batter picks in the last 7d — pitcher stats are not reaching the model`, { atom });
        } else if (pct < 40) {
          add('P1', 'pitcher-delivery', `signals.${atom} present on only ${pct.toFixed(1)}% of batter picks in the last 7d`, { atom, pct });
        }
      }
    }
  }
}

// -------------------------------------------------- CHECK 5: join integrity
// Game-level markets (ml/rl/ou, plus nrfi) store the game's gamePk in player_id,
// not an mlbam player id — App.jsx writes `player_id: r.gamePk` for those rows.
// They were never crosswalk-joinable and must be excluded or every gamePk that
// doesn't collide with a real mlbam id reads as a false "unresolved" player.
const GAME_LEVEL_PROP_TYPES = ['nrfi', 'ml', 'rl', 'ou'];
{
  const since = daysAgo(7);
  const picks = await sb(`mlb_picks?pick_date=gte.${since}&prop_type=not.in.(${GAME_LEVEL_PROP_TYPES.join(',')})&select=player_id&limit=1000`);
  const ids = [...new Set(picks.map(p => p.player_id).filter(Boolean))];
  if (ids.length) {
    const batch = ids.slice(0, 300);
    const cw = await sb(`player_id_crosswalk?mlbam_id=in.(${batch.join(',')})&select=mlbam_id&limit=1000`);
    const resolved = new Set(cw.map(r => String(r.mlbam_id)));
    const missing = batch.filter(id => !resolved.has(String(id)));
    const pct = ((batch.length - missing.length) / batch.length) * 100;
    popReport.join_integrity = { sampled: batch.length, unresolved: missing.length, pct: +pct.toFixed(1) };
    if (pct < 80) {
      add('P0', 'join-integrity', `only ${pct.toFixed(1)}% of recent pick player_ids resolve in player_id_crosswalk (${missing.length}/${batch.length} unresolved)`, { missing: missing.slice(0, 10) });
    } else if (pct < 95) {
      add('P1', 'join-integrity', `${missing.length}/${batch.length} recent pick player_ids unresolved in crosswalk`, { missing: missing.slice(0, 10) });
    }
  }
}

// ------------------------------------------- CHECK 6: picks are actually saving
// The 2026-07-19 outage: daily_scan_results computed a full candidate pool every
// day while mlb_picks saved 1 row. Model layer healthy, save layer dead, exit 0.
{
  // Dates already investigated and closed out (see plumbing-baseline.json) stay
  // out of the count — otherwise a resolved outage keeps tripping for 3 more days
  // and trains you to ignore the alarm.
  const known = new Set(baseline.known_outage_dates || []);
  const days = [1, 2, 3].map(daysAgo).filter(d => !known.has(d));
  const saved = {};
  // savedPicksParams excludes the cron-owned prop_types (nrfi) — a day whose only
  // row came from nrfi-picks.yml is exactly the outage this check exists to catch.
  for (const d of days) saved[d] = await count(`mlb_picks?${savedPicksParams(d)}`);
  popReport.pick_saves = saved;
  const empty = days.filter(d => saved[d] === 0);
  if (empty.length >= 2) {
    add('P0', 'pick-save', `mlb_picks has ZERO non-NRFI picks on ${empty.length} of the last 3 days (${empty.join(', ')}) — the save gate is failing`, { saved });
  } else if (empty.length === 1) {
    add('P1', 'pick-save', `no non-NRFI picks saved for ${empty[0]}`, { saved });
  }
}

// ------------------------------------------------------------------- report
const p0 = findings.filter(f => f.sev === 'P0');
const p1 = findings.filter(f => f.sev === 'P1');
const report = {
  ranAt: new Date().toISOString(),
  season: SEASON,
  clean: p0.length === 0 && p1.length === 0,
  counts: { P0: p0.length, P1: p1.length },
  findings,
  evidence: popReport,
};
writeFileSync(resolve(ROOT, 'docs/plumbing-tripwire-latest.json'), JSON.stringify(report, null, 2));

console.log(`Plumbing tripwire — season ${SEASON} — ${new Date().toISOString().slice(0, 10)}`);
console.log(`consumed model fields: ${consumed.length} · P0: ${p0.length} · P1: ${p1.length}`);
for (const f of [...p0, ...p1]) console.log(`  [${f.sev}] (${f.check}) ${f.msg}`);
// Surface expired accepts so the baseline self-cleans instead of accumulating
// entries nobody remembers the reason for. These no longer suppress anything.
for (const a of expiredAccepts) {
  console.log(`  [note] baseline accept "${a.key}" expired ${a.expires} — it no longer suppresses; delete it from scripts/plumbing-baseline.json`);
}
if (report.clean) console.log('CLEAN — all plumbing checks passed.');
console.log('report → docs/plumbing-tripwire-latest.json');

process.exit(report.clean ? 0 : 1);
