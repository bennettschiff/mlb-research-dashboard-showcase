#!/usr/bin/env node
/**
 * scripts/daily-picks.mjs
 *
 * Headless daily save + score driver. Runs the deployed app in Playwright so
 * the existing browser code paths (scan → auto-save → auto-score) execute
 * without a human opening the page. This is what closes the gap during the
 * user's travel: auto-save and auto-score are React useEffects with no
 * server-side equivalent, so without a browser session nothing persists.
 *
 * Env (all required):
 *   APP_URL              — deployed app origin (e.g. https://mlb-research-dashboard.vercel.app)
 *   APP_ACCESS_CODE      — value the password gate accepts (stored in localStorage as `mlb_auth`)
 *   SUPABASE_URL         — for verification polls against mlb_picks
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Usage: node scripts/daily-picks.mjs
 *
 * (Standalone prior-day scoring lives in scripts/backfill-scores.mjs, which the
 * morning-score.yml workflow runs server-side — the in-browser auto-score effect
 * grades 0 in headless, so we don't rely on this driver for scoring alone.)
 */
import { chromium } from "playwright";
import { isUnscoreableGame, gameTeamAbbrs, SCHEDULE_STATUS_PARAMS, regularSeasonGameCount } from "../src/lib/gameStatus.js";
import { savedPicksParams } from "../src/lib/pickQueries.js";
import { sbJson } from "./lib/sb.mjs";

const APP_URL = process.env.APP_URL;
const ACCESS_CODE = process.env.APP_ACCESS_CODE;
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

for (const [k, v] of [
  ["APP_URL", APP_URL],
  ["APP_ACCESS_CODE", ACCESS_CODE],
  ["SUPABASE_URL", SB_URL],
  ["SUPABASE_SERVICE_ROLE_KEY", SB_KEY],
]) if (!v) { console.error(`Missing env ${k}`); process.exit(1); }

const todayET = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());

// Current ET hour (0-23). Mirrors the app's auto-save gate: the save useEffect
// in App.jsx returns early when etHour < 11, so the deployed app physically
// cannot persist today's picks before 11 AM ET — there's no slate/odds yet.
const hourET = () =>
  parseInt(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "2-digit", hour12: false,
  }).format(new Date()), 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// These are the verification polls the whole run is judged on: if one of them
// throws, a slate that saved perfectly well is reported as a failed save. On
// 2026-09-05 the shared instance stalled for ~8 minutes and answered every
// request with a 504 after 135-180 s (PostgREST's own `SET client_encoding` hit
// the statement timeout), so a bare fetch here is a coin flip on a bad night.
// A longer backoff than the shared default: this job runs once, and there is no
// second pass that re-saves the slate if this one gives up early.
const sb = (path) =>
  sbJson(`${SB_URL}/rest/v1/${path}`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } },
    { backoff: [5_000, 15_000, 45_000, 90_000, 120_000] });

// ── Unscoreable-pick detection ───────────────────────────────────────────────
// Picks from postponed/cancelled/suspended games can't reach a non-pending
// outcome from box scores, so the score-poll must not wait on them (2026-06-11:
// ATL@CWS postponement burned the full 15-min budget and starved the save
// phase). The browser scorer now grades dead-game picks "push", but suspended
// games awaiting a resume date legitimately stay pending — treat "only
// unscoreable picks remain" as poll success either way.
const GAME_PROPS = new Set(["ml", "rl", "ou"]);
const schedCache = new Map(); // pick_date → schedule games (statuses for prior days don't move mid-run)

async function gamesForDate(date) {
  if (!schedCache.has(date)) {
    const r = await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}${SCHEDULE_STATUS_PARAMS}`);
    if (!r.ok) throw new Error(`statsapi schedule ${date}: ${r.status}`);
    schedCache.set(date, (await r.json()).dates?.[0]?.games || []);
  }
  return schedCache.get(date);
}

async function pickIsUnscoreable(pick) {
  const games = await gamesForDate(pick.pick_date);
  // Game picks (ml/rl/ou) store the gamePk in player_id — exact match.
  if (GAME_PROPS.has(pick.prop_type)) {
    const g = games.find((g) => String(g.gamePk) === String(pick.player_id));
    return g ? isUnscoreableGame(g) : false;
  }
  // Player props store the MLB player id — map via team abbr. Unscoreable only
  // if EVERY game the team had that day is unscoreable (split-doubleheader
  // picks could still grade off the played game).
  const teamGames = games.filter((g) => pick.team && gameTeamAbbrs(g).includes(pick.team));
  return teamGames.length > 0 && teamGames.every(isUnscoreableGame);
}

async function onlyUnscoreableRemain(stillPending) {
  for (const p of stillPending) {
    if (!(await pickIsUnscoreable(p).catch(() => false))) return false;
  }
  console.log(`  → ${stillPending.length} pending pick(s) are from postponed/cancelled/suspended games — treating score check as done.`);
  return true;
}

// `stallMs` + `progress` bail out early when the poll is provably going nowhere.
// The score poll is budgeted 15 min to absorb large backlogs, but a backlog only
// justifies that budget while it's actually shrinking. Every post-midnight
// backstop run through 2026-07 spent the full 900s and graded ZERO picks
// (browser auto-score can't grade games whose box scores aren't final yet), then
// exited 0 — ~16 min of billed Actions time per night, ~24% of the monthly quota,
// for no work at all. That is what exhausted the free tier on 2026-07-29.
// `progress` is a cheap synchronous getter over state `fn` already fetched, so
// the stall check costs no extra Supabase round-trips.
async function pollUntil(label, fn, { timeoutMs, intervalMs = 5_000, stallMs = 0, progress = null }) {
  const start = Date.now();
  let best = null;
  let lastGain = start;
  while (Date.now() - start < timeoutMs) {
    if (await fn()) { console.log(`✅ ${label}`); return true; }
    if (stallMs && progress) {
      const p = progress();
      if (typeof p === "number" && (best === null || p > best)) {
        best = p;
        lastGain = Date.now();
      } else if (Date.now() - lastGain >= stallMs) {
        console.warn(`⚠️  ${label} — no progress for ${(stallMs / 1000) | 0}s (${best ?? 0} done); giving up early rather than burning the full budget.`);
        return false;
      }
    }
    await sleep(intervalMs);
  }
  console.warn(`⚠️  ${label} — timed out after ${(timeoutMs / 1000) | 0}s`);
  return false;
}

(async () => {
  const today = todayET();
  console.log(`📅 ET date: ${today}`);
  console.log(`🌐 App: ${APP_URL}`);

  // Snapshot existing state so we know what changed. Scope pending lookups to
  // the last 14 days — anything older needs an MLB-Stats-archive backfill
  // script, not the browser auto-scorer (which can't catch up past ~2 weeks
  // before the 15-min poll window expires). Old-pending grinding was masking
  // real "no progress" failures by always reporting timeout.
  const scoreWindowStart = (() => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 14);
    return d.toISOString().slice(0, 10);
  })();
  // savedPicksParams excludes cron-owned prop_types (nrfi): nrfi-picks.yml writes
  // its own row on an independent cron (11 AM/2 PM/5 PM/7 PM ET), bypassing this
  // script's save gate entirely. Counting that row as "today already saved" made
  // this existence check skip the real save for the rest of the day (2026-07-19,
  // 2026-07-20 — 1-2 picks saved instead of dozens, and 0 pick_signals either day).
  // The same exclusion now lives in App.jsx's own save gate, which is where the
  // 2026-07-22 repeat happened: fixing only this script left the app still refusing.
  const todayBefore = await sb(`mlb_picks?${savedPicksParams(today)}`);
  const pendingBefore = await sb(`mlb_picks?outcome=eq.pending&pick_date=lt.${today}&pick_date=gte.${scoreWindowStart}&select=id,pick_date`);
  const ancientPending = await sb(`mlb_picks?outcome=eq.pending&pick_date=lt.${scoreWindowStart}&select=id`);
  console.log(`  pre: today=${todayBefore.length} picks · pending(<=14d)=${pendingBefore.length} · ancient pending(>14d)=${ancientPending.length}`);

  // If today already has picks, the save side of the run has nothing to do —
  // saveTodayPicks short-circuits when picks for the date exist. Skip the
  // save poll so we don't time out waiting for growth that can't happen.
  //
  // Also skip when it's before 11 AM ET: the app's auto-save useEffect gates on
  // etHour >= 11 (no slate/odds posted yet), so it physically cannot save now.
  // This is the post-midnight backstop case — the 9:30 PM ET cron gets delayed
  // by GitHub Actions past midnight ET into the early-AM of the next day, where
  // `today` rolls over to 0 picks and the save can never fire. Without this gate
  // the poll burns 15 min and exits 1 (false failure). The next noon run saves.
  //
  // Also skip when there's no regular-season slate (All-Star break, league
  // off-day). The app scans nothing, so no picks can ever save and the poll
  // burns its full 15-min budget before exiting 1 — a false failure that pages
  // ops. This is what failed 2026-07-13 (0 games) and 2026-07-14 (All-Star Game
  // only; see regularSeasonGameCount on why a raw totalGames check misses it).
  // If the schedule API is unreachable we assume a slate exists and poll as
  // usual: a false alarm costs an issue comment, a wrongly-skipped save costs
  // a day of picks.
  const nowHourET = hourET();
  const tooEarlyToSave = nowHourET < 11;
  const slateGames = await regularSeasonGameCount(today).catch((e) => {
    console.warn(`  ⚠️  schedule lookup failed (${e.message}) — assuming a slate exists.`);
    return null;
  });
  const noSlate = slateGames === 0;
  const needSave = todayBefore.length === 0 && !tooEarlyToSave && !noSlate;
  if (todayBefore.length > 0) {
    console.log(`  → save check: skipped (${todayBefore.length} picks already exist)`);
  } else if (tooEarlyToSave) {
    console.log(`  → save check: skipped (${nowHourET}:00 ET < 11 AM — app auto-save gate not open yet; next run saves)`);
  } else if (noSlate) {
    console.log(`  → save check: skipped (no regular-season games on ${today} — off-day/All-Star break; nothing to pick)`);
  }

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 mlb-research-dashboard-cron",
    timezoneId: "America/New_York",
  });

  // Bypass the password gate by pre-seeding localStorage on the app origin.
  await ctx.addInitScript((code) => {
    try { localStorage.setItem("mlb_auth", code); } catch {}
  }, ACCESS_CODE);

  const page = await ctx.newPage();
  page.on("console", (m) => {
    const t = m.type();
    if (t === "error" || t === "warning" || m.text().startsWith("⚾") || m.text().includes("[pick_signals]") || m.text().includes("Auto-")) {
      console.log(`[page:${t}] ${m.text().slice(0, 300)}`);
    }
  });
  page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));
  // Surface failed network requests with their URL + status. The original 413
  // showed up as a bare "Failed to load resource" with no URL, which makes
  // diagnosis pointlessly hard.
  page.on("response", (r) => {
    if (r.status() >= 400) console.log(`[net ${r.status()}] ${r.request().method()} ${r.url()}`);
  });
  page.on("requestfailed", (r) => {
    console.log(`[netfail] ${r.method()} ${r.url()} — ${r.failure()?.errorText}`);
  });

  console.log("→ navigating…");
  await page.goto(APP_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });

  // The scan + auto-save + auto-score are all browser useEffects. Just keep the
  // tab alive and verify state via Supabase rather than scraping the DOM.
  //
  // CRITICAL: poll score and save CONCURRENTLY, not sequentially. Both browser
  // effects fire independently the moment the page loads (auto-score has no scan
  // dependency; auto-save waits on scan + hour≥11 ET) — so the polls are just
  // parallel observers of state the tab is already producing. Run sequentially
  // and the worst case is 15 min (score) + 15 min (save) = 30 min, which blows
  // the 25-min job timeout. That is exactly what killed the 2026-06-13 run: a
  // 59-pick score backlog ate the full 15-min score poll, the job was cancelled
  // before the save poll could finish, and BOTH yesterday's grading and today's
  // save were lost in one stroke. Concurrent caps wall-clock at ~15 min so the
  // mandatory save can never be starved by a slow score backlog again.

  // 1. Auto-score: fires on first picks-load for any pending picks with pick_date < today.
  //    Should happen within ~30s of page load (no scan dependency). 15 min to
  //    absorb large backlogs (e.g. weeks of travel-accumulated pending picks).
  //    Soft-fail: if it times out, log a warning but don't exit nonzero — auto-score
  //    continues in the browser tab after we move on, and tomorrow's run picks up
  //    whatever remains. Real failures show up as save failures or scan errors below.
  //
  //    stallMs: keep the full 15 min ONLY while the backlog is shrinking. If nothing
  //    grades for 3 straight minutes the browser auto-scorer isn't going to grade
  //    this backlog at all (typically: games whose box scores aren't final yet), and
  //    morning-score.yml owns that case at 7 AM ET — it clears the same backlog in
  //    ~20s. Waiting the remaining 12 min changes nothing but the Actions bill.
  let scoredSoFar = 0;
  const scorePoll = pollUntil(
    `scored ${pendingBefore.length} prior-day pending pick(s)`,
    async () => {
      if (pendingBefore.length === 0) return true;
      const stillPending = await sb(`mlb_picks?outcome=eq.pending&pick_date=lt.${today}&pick_date=gte.${scoreWindowStart}&select=id,pick_date,team,player_id,prop_type`);
      scoredSoFar = pendingBefore.length - stillPending.length;
      if (stillPending.length === 0) return true;
      return onlyUnscoreableRemain(stillPending);
    },
    { timeoutMs: 15 * 60_000, intervalMs: 10_000, stallMs: 3 * 60_000, progress: () => scoredSoFar }
  );

  // 2. Auto-save today's picks: fires after scan completes AND hour ≥ 11 ET.
  //    Scan typically takes 3-5 min. Be patient — up to 15 min.
  //    Skip if today already has picks (saveTodayPicks won't re-save).
  //
  //    savedPicksParams for the same reason the pre-check above uses it:
  //    nrfi-picks.yml writes its row on an independent cron whose fire times
  //    (11 AM/2 PM/5 PM/7 PM ET) land inside this 15-min poll window. Counting
  //    it as success let the poll pass — and the run exit 0 — while the real
  //    save never happened. Scoping only the pre-check (2026-07-21) left this
  //    success condition as a second, still-armed copy of the 7/19–7/20 bug.
  const savePoll = !needSave ? Promise.resolve(true) : pollUntil(
    `saved today's picks (date=${today})`,
    async () => {
      const rows = await sb(`mlb_picks?${savedPicksParams(today)}`);
      return rows.length > 0;
    },
    { timeoutMs: 15 * 60_000, intervalMs: 10_000 }
  );

  const [scoreOk, saveOk] = await Promise.all([scorePoll, savePoll]);

  // Give snapshot writes (pick_signals) and any final useEffect cleanup
  // a beat to finish before tearing the browser down.
  await sleep(20_000);

  const todayAfter = await sb(`mlb_picks?pick_date=eq.${today}&select=prop_type`);
  const byProp = todayAfter.reduce((m, r) => ((m[r.prop_type] = (m[r.prop_type] || 0) + 1), m), {});
  const pendingAfter = await sb(`mlb_picks?outcome=eq.pending&pick_date=lt.${today}&pick_date=gte.${scoreWindowStart}&select=id`);
  const scoredDelta = pendingBefore.length - pendingAfter.length;
  console.log(`  post: today=${todayAfter.length} picks — ${JSON.stringify(byProp)}`);
  console.log(`  post: pending(<=14d)=${pendingAfter.length} (scored ${scoredDelta} this run)`);

  await browser.close();

  // Save is mandatory — if it was needed and didn't happen, that's a real failure.
  if (!saveOk) {
    console.error("❌ daily-picks: save did not complete");
    process.exit(1);
  }
  // Score is best-effort — a partial pass with progress is fine; a partial pass
  // with zero progress is suspicious but not a true failure (could be no box
  // scores available yet, no completed games, etc.). Log loudly, exit 0.
  if (!scoreOk && scoredDelta === 0 && pendingBefore.length > 0) {
    console.warn(`⚠️  daily-picks: score check timed out with no progress (${pendingBefore.length} still pending). Open the page in a browser to grind through the backlog.`);
  } else if (!scoreOk) {
    console.log(`ℹ️  daily-picks: score check timed out but ${scoredDelta} were graded this run. Auto-score continues across runs.`);
  }
  console.log("✅ daily-picks run complete");
})().catch((e) => {
  console.error("daily-picks fatal:", e);
  process.exit(1);
});
