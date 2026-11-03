#!/usr/bin/env node
/**
 * scripts/backfill-scores.mjs
 *
 * Grades the standing backlog of pending picks that the in-browser auto-scorer
 * never resolved (season-start picks from before the headless driver existed,
 * plus DNPs/postponed games it skips). Mirrors scorePicks() in src/App.jsx
 * exactly: per pick_date it pulls that date's MLB schedule + box scores, maps
 * the player's box line to the prop stat via the SAME getActual() formulas, and
 * grades over/under against pick.line.
 *
 *   Gradeable  → win / loss / push (truthful), result = actual stat value.
 *   Ungradeable (player DNP / no Final game / doubleheader-ambiguous) → settled
 *                as `push` with result=null. `push` is the only math-safe
 *                no-action value: computeDashboardStats() excludes pushes from
 *                W/L and ROI (allScored = outcome!=="pending", and ROI treats
 *                any non-win/non-push as a loss — so `void` would read as a loss).
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * Usage:
 *   node scripts/backfill-scores.mjs              # dry run, prints plan only
 *   node scripts/backfill-scores.mjs --apply      # grade gradeable picks
 *   node scripts/backfill-scores.mjs --apply --void-ungradeable   # also settle DNP/postponed as push
 */
const API = "https://statsapi.mlb.com/api/v1";
import { sbRequest } from './lib/sb.mjs';
import { ipToDec } from '../src/lib/innings.js';
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const todayET = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// The local backoff here was 800/1600/2400 ms — five seconds of cover, which is
// inside any real stall rather than across it. On 2026-09-05 the shared instance
// was unreachable for ~8 minutes (504 after 135-180 s per request). Policy now
// lives in scripts/lib/sb.mjs. Safe to retry at any step: reads are idempotent
// and every write here is a PATCH addressed by primary key.
const sbFetch = (label, url, init) =>
  sbRequest(url, init, { label, idempotent: true });
async function sbGet(path) {
  const r = await sbFetch(`sbGet ${path}`, `${SB_URL}/rest/v1/${path}`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  return r.json();
}
async function sbPatch(id, body) {
  await sbFetch(`sbPatch ${id}`, `${SB_URL}/rest/v1/mlb_picks?id=eq.${id}`, {
    method: "PATCH",
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(body),
  });
}
async function getJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return r.json();
    } catch { /* retry */ }
    await sleep(400 * (i + 1));
  }
  return null;
}

// Mirror of getActual() in src/App.jsx scorePicks().
function getActual(stats, propType) {
  const b = stats?.batting || {};
  const p = stats?.pitching || {};
  switch (propType) {
    case "hits": case "hits15": return b.hits ?? null;
    case "hr":   return b.homeRuns ?? null;
    case "tb":   return (b.hits != null) ? (b.hits - (b.doubles||0) - (b.triples||0) - (b.homeRuns||0)) + (b.doubles||0)*2 + (b.triples||0)*3 + (b.homeRuns||0)*4 : null;
    case "hrr":  return (b.hits != null) ? (b.hits||0) + (b.runs||0) + (b.rbi||0) : null;
    case "sb":   return b.stolenBases ?? null;
    case "rbi":  return b.rbi ?? null;
    case "ks":   return p.strikeOuts ?? null;
    // Pitch Lab pitcher props — the official box line, as books grade them.
    case "outs": return p.outs ?? (p.inningsPitched != null ? Math.round(ipToDec(p.inningsPitched) * 3) : null);
    case "hits_allowed": return p.hits ?? null;
    case "walks": return p.baseOnBalls ?? null;
    case "er":   return p.earnedRuns ?? null;
    default:     return null;
  }
}

// Game props (ml/rl/ou) store the gamePk in player_id, not an MLB player id, so
// they never match the player-keyed boxResults map and were silently bucketed as
// "player_dnp" — which --void-ungradeable would then settle as push, hiding real
// game-line W/L (caught 2026-06-13 when 6 final game lines got mislabeled). Grade
// them directly off the final score, mirroring scorePicks() in src/App.jsx.
// `nrfi` is a game-keyed prop too (player_id = gamePk) but grades off the FIRST
// inning, not the final score — see gradeGameLine.
const GAME_PROPS = new Set(["ml", "rl", "ou", "nrfi"]);

// gamePk → { home:{abbr,runs}, away:{abbr,runs}, firstInningRuns } for one Final game.
async function gameScore(gamePk) {
  const [box, ls] = await Promise.all([
    getJson(`${API}/game/${gamePk}/boxscore`),
    getJson(`${API}/game/${gamePk}/linescore`),
  ]);
  if (!box || !ls || ls.teams?.home?.runs == null || ls.teams?.away?.runs == null) return null;
  const inn1 = ls.innings?.[0];
  return {
    home: { abbr: box.teams?.home?.team?.abbreviation, runs: ls.teams.home.runs },
    away: { abbr: box.teams?.away?.team?.abbreviation, runs: ls.teams.away.runs },
    // null (not 0) when the inning-by-inning line is missing, so a data gap can
    // never grade a YRFI pick as a loss on a phantom scoreless first.
    firstInningRuns:
      inn1?.home?.runs == null || inn1?.away?.runs == null ? null : inn1.home.runs + inn1.away.runs,
  };
}

// Grade one ml/rl/ou pick against a final score. Returns {outcome,result} or null
// if it can't be graded (game not final / team not matched).
function gradeGameLine(pick, gs) {
  if (!gs) return null;
  const line = Number(pick.line);
  const dir = pick.direction || "over";
  if (pick.prop_type === "nrfi") {
    // over 0.5 = YRFI, under 0.5 = NRFI. The 0.5 line can't push.
    if (gs.firstInningRuns == null) return null;
    const r1 = gs.firstInningRuns;
    const outcome = dir === "under"
      ? (r1 < line ? "win" : "loss")
      : (r1 > line ? "win" : "loss");
    return { outcome, result: r1 };
  }
  if (pick.prop_type === "ou") {
    const total = gs.home.runs + gs.away.runs;
    const outcome = dir === "under"
      ? (total < line ? "win" : total === line ? "push" : "loss")
      : (total > line ? "win" : total === line ? "push" : "loss");
    return { outcome, result: total };
  }
  // ml / rl: pick.team identifies the side.
  const mine = gs.home.abbr === pick.team ? gs.home : gs.away.abbr === pick.team ? gs.away : null;
  const opp  = gs.home.abbr === pick.team ? gs.away : gs.away.abbr === pick.team ? gs.home : null;
  if (!mine || !opp) return null;
  const margin = mine.runs - opp.runs;
  if (pick.prop_type === "ml") {
    return { outcome: margin > 0 ? "win" : margin < 0 ? "loss" : "push", result: mine.runs };
  }
  // rl: spread (e.g. -1.5 favored). covered>0 = win.
  const covered = margin + (line || -1.5);
  return { outcome: covered > 0 ? "win" : covered < 0 ? "loss" : "push", result: mine.runs };
}

// Core grader — importable so the punctual Vercel cron (api/cron.js) can run the
// exact same scoring server-side, instead of relying on GitHub Actions' schedule
// (which lags hours and left Results stale past 8 AM). Returns a summary.
//   beforeDate       — grade picks with pick_date < this (default today ET)
//   apply            — write win/loss/push (false = dry run, returns plan only)
//   voidUngradeable  — settle ALL ungradeable leftovers as push (CLI sweep)
//   voidReasons      — settle ONLY these ungradeable reasons as push. Use for the
//                      automated morning run: void terminal DNPs (player was absent
//                      from a Final game → never grades) but LEAVE `no_final_game`
//                      pending, since a postponed/suspended game can still resume
//                      and grade for real later. voidUngradeable overrides this.
export async function gradePendingPicks({ beforeDate, apply = false, voidUngradeable = false, voidReasons = null } = {}) {
  const today = beforeDate || todayET();
  console.log(`📅 grading picks before ${today} · mode: ${apply ? (voidUngradeable ? "APPLY + void-ungradeable" : "APPLY") : "DRY RUN"}`);

  // Pull all pending picks before today (player props AND game lines — ml/rl/ou
  // can sit pending too, e.g. when the headless run is starved before scoring).
  const pending = await sbGet(`mlb_picks?outcome=eq.pending&pick_date=lt.${today}&select=id,pick_date,player_name,player_id,team,prop_type,line,direction&order=pick_date.asc`);
  console.log(`Found ${pending.length} pending picks across ${new Set(pending.map(p=>p.pick_date)).size} dates\n`);
  if (pending.length === 0) return { gradeable: 0, applied: 0, ungradeable: 0, voided: 0 };

  const byDate = {};
  for (const p of pending) (byDate[p.pick_date] ||= []).push(p);

  const updates = [];       // { pick, outcome, result }
  const ungradeable = [];   // { pick, reason }

  for (const date of Object.keys(byDate).sort()) {
    const sched = await getJson(`${API}/schedule?sportId=1&date=${date}`);
    const games = sched?.dates?.[0]?.games || [];
    // Only Final games can grade. Track postponed/other separately.
    const finalPks = games.filter(g => g.status?.abstractGameState === "Final").map(g => g.gamePk);

    // player_id → { byGame: { gamePk → stats }, gameCount }. We keep stats PER game
    // so a doubleheader can be graded against Game 1 (the matchup the single-game
    // line was posted for) rather than voided — see grade loop below.
    const boxResults = {};
    await Promise.all(finalPks.map(async gk => {
      const box = await getJson(`${API}/game/${gk}/boxscore`);
      if (!box) return;
      // Count DISTINCT games per player, not box-list entries. A pitcher who also
      // had a plate appearance is listed in BOTH `batters` and `pitchers` of the
      // SAME game, so concatenating the two lists counts him twice and falsely
      // trips the doubleheader-ambiguous guard below — which stranded gradeable
      // pitcher-Ks picks pending forever (caught 2026-06-17: Eovaldi/Early on
      // 6/14 both two-listed, never graded). Dedupe ids within the game first.
      const seen = new Set();
      for (const side of ["home", "away"]) {
        const players = box.teams?.[side]?.players || {};
        const ids = [...(box.teams?.[side]?.batters || []), ...(box.teams?.[side]?.pitchers || [])];
        for (const pid of ids) {
          if (seen.has(pid)) continue;
          seen.add(pid);
          const pdata = players[`ID${pid}`];
          if (pdata?.stats) {
            const r = (boxResults[pid] ||= { byGame: {}, gameCount: 0 });
            if (!(gk in r.byGame)) { r.byGame[gk] = pdata.stats; r.gameCount++; }
          }
        }
      }
    }));

    // Game lines key off the gamePk (stored in player_id) rather than a player
    // box line. Grade each unique referenced game once, then apply per pick.
    const gameProps = byDate[date].filter(p => GAME_PROPS.has(p.prop_type));
    const gsByPk = {};
    if (gameProps.length) {
      const pks = [...new Set(gameProps.map(p => p.player_id))];
      await Promise.all(pks.map(async pk => { gsByPk[pk] = finalPks.includes(Number(pk)) ? await gameScore(pk) : null; }));
    }

    for (const pick of byDate[date]) {
      if (GAME_PROPS.has(pick.prop_type)) {
        const graded = gradeGameLine(pick, gsByPk[pick.player_id]);
        if (!graded) { ungradeable.push({ pick, reason: finalPks.length === 0 ? "no_final_game" : "game_not_matched" }); continue; }
        updates.push({ pick, outcome: graded.outcome, result: graded.result });
        continue;
      }
      const hit = boxResults[pick.player_id];
      if (!hit) { ungradeable.push({ pick, reason: finalPks.length === 0 ? "no_final_game" : "player_dnp" }); continue; }
      // Doubleheader: the prop is a single-game line driven by one batter/pitcher
      // matchup (Game 1's starter), so grade it against Game 1 — the lowest gamePk,
      // which books default single-game props to — rather than voiding it. We don't
      // store the opposing SP, so G1-by-gamePk is the principled proxy. (Previously
      // gameCount>1 stranded these as doubleheader_ambiguous → push; caught 6/18
      // when a suspended-game DH voided every SF@ATL batter prop on 6/17.)
      const gk1 = Object.keys(hit.byGame).map(Number).sort((a, b) => a - b)[0];
      const actual = getActual(hit.byGame[gk1], pick.prop_type);
      if (actual === null) { ungradeable.push({ pick, reason: "no_stat_for_prop" }); continue; }
      const line = Number(pick.line);
      const dir = pick.direction || "over";
      const outcome = dir === "under"
        ? (actual < line ? "win" : actual === line ? "push" : "loss")
        : (actual > line ? "win" : actual === line ? "push" : "loss");
      updates.push({ pick, outcome, result: actual });
    }
    process.stdout.write(`  ${date}: ${byDate[date].length} picks · ${finalPks.length}/${games.length} final games\n`);
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  const tally = updates.reduce((m, u) => ((m[u.outcome] = (m[u.outcome]||0)+1), m), {});
  console.log(`\n=== GRADEABLE: ${updates.length} ===`);
  console.log(`  ${tally.win||0}W / ${tally.loss||0}L / ${tally.push||0}P`);
  const byPropOutcome = {};
  for (const u of updates) {
    const k = u.pick.prop_type;
    (byPropOutcome[k] ||= { win:0, loss:0, push:0 })[u.outcome]++;
  }
  for (const [k, v] of Object.entries(byPropOutcome)) console.log(`    ${k.padEnd(7)} ${v.win}W / ${v.loss}L / ${v.push}P`);

  const reasonTally = ungradeable.reduce((m, u) => ((m[u.reason] = (m[u.reason]||0)+1), m), {});
  console.log(`\n=== UNGRADEABLE: ${ungradeable.length} ===`);
  for (const [r, n] of Object.entries(reasonTally)) console.log(`    ${r}: ${n}`);
  if (ungradeable.length) {
    console.log("  sample:");
    for (const u of ungradeable.slice(0, 12)) console.log(`    ${u.pick.pick_date} ${u.pick.player_name} ${u.pick.prop_type} O${u.pick.line} — ${u.reason}`);
  }

  if (!apply) {
    console.log(`\n(dry run — nothing written. Re-run with --apply${ungradeable.length ? " [--void-ungradeable to settle the above as push]" : ""})`);
    return { gradeable: updates.length, applied: 0, ungradeable: ungradeable.length, voided: 0, byPropOutcome, tally };
  }

  // ── Apply ────────────────────────────────────────────────────────────────
  console.log(`\nApplying ${updates.length} grades…`);
  let n = 0;
  for (const u of updates) { await sbPatch(u.pick.id, { result: u.result, outcome: u.outcome }); if (++n % 25 === 0) console.log(`  ${n}/${updates.length}`); }
  console.log(`✅ graded ${updates.length} picks`);

  let voided = 0;
  const toVoid = voidUngradeable
    ? ungradeable
    : voidReasons ? ungradeable.filter(u => voidReasons.includes(u.reason)) : [];
  if (toVoid.length) {
    console.log(`Settling ${toVoid.length} ungradeable as push (no-action)…`);
    let m = 0;
    for (const u of toVoid) { await sbPatch(u.pick.id, { result: null, outcome: "push" }); if (++m % 25 === 0) console.log(`  ${m}/${toVoid.length}`); }
    voided = toVoid.length;
    console.log(`✅ settled ${toVoid.length} ungradeable as push`);
  }
  const leftPending = ungradeable.length - voided;
  if (leftPending) console.log(`ℹ️  ${leftPending} ungradeable left pending (resumable or needs manual --void-ungradeable)`);
  return { gradeable: updates.length, applied: updates.length, ungradeable: ungradeable.length, voided, byPropOutcome, tally };
}

// ── CLI entry — skipped when imported (e.g. by api/cron.js) ───────────────────
const isCli = import.meta.url === `file://${process.argv[1]}`;
if (isCli) {
  if (!SB_URL || !SB_KEY) { console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }
  gradePendingPicks({
    apply: process.argv.includes("--apply"),
    voidUngradeable: process.argv.includes("--void-ungradeable"),
  }).catch(e => { console.error("backfill-scores fatal:", e); process.exit(1); });
}
