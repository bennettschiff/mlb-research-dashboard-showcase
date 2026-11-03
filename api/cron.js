/**
 * api/cron.js — Morning data warm-up
 *
 * Triggered automatically by Vercel Cron at 7:00 AM ET (DST) daily (see vercel.json —
 * cron is UTC and does not auto-adjust, so this is 6:00 AM ET in winter).
 * This is the ONLY scheduled trigger for the full warm-up — do not add a second
 * one (e.g. via GitHub Actions) that hits this endpoint with the default scope,
 * or the Odds API gets pulled twice a day for no reason.
 * Can also be triggered manually: GET /api/cron?secret=<CRON_SECRET>
 *
 * What it does:
 *   1. Wipes yesterday's cache rows from Supabase
 *   2. Pre-fetches all slow/expensive data sources for today
 *   3. Stores everything in cache so the first page load is instant
 *
 * Data fetched:
 *   - Today's MLB schedule (game PKs, teams, probable pitchers)
 *   - Rotowire confirmed lineups
 *   - Baseball Savant league-wide CSVs (percentile rankings, arsenal stats)
 *   - MLB moneylines from The Odds API
 *
 * Both moneylines AND player props are fetched here and stored in the daily_odds
 * Supabase table (date-keyed). api/odds.js serves from that table all day —
 * no further Odds API calls happen regardless of how many users load the page.
 */

import { cacheSet, wipePreviousDays, serverFetch, serverFetchWithCredits } from "./_cache.js";
import { handleWatchdog } from "./_freshness.js";
import { gradePendingPicks } from "../scripts/backfill-scores.mjs";
import { buildGoldenSnapshot } from "../scripts/golden-snapshot.mjs";
import { snapshot as buildBrainTrust, isSoftSkip } from "../scripts/brain-trust-snapshot.mjs";

const MLB_API = "https://statsapi.mlb.com/api/v1";
const SAVANT = "https://baseballsavant.mlb.com";

/**
 * Append one row to the odds_credit_log audit trail (The Odds API credit headers).
 * Best-effort: never throws, so a logging failure can't break an odds fetch.
 * Skips no-op snapshots where both credit values are null.
 */
async function logOddsCredits(supUrl, supKey, { source, used, remaining, today }) {
  if (!supUrl || !supKey) return;
  if (used == null && remaining == null) return;
  try {
    await fetch(`${supUrl}/rest/v1/odds_credit_log`, {
      method: "POST",
      headers: {
        apikey: supKey,
        Authorization: `Bearer ${supKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        game_date: today ?? null,
        source: source ?? null,
        credits_used: used ?? null,
        credits_remaining: remaining ?? null,
      }),
    });
  } catch (e) {
    console.log(`  ⚠️ odds_credit_log insert failed (${source}): ${e.message}`);
  }
}

/**
 * Lightweight lineup refresh — called every 30 min by the GitHub Actions cron.
 * Only re-fetches Rotowire lineups and the MLB schedule (which carries liveGamePk
 * status updates). Everything else (Savant CSVs, moneylines, pitcher stats) is
 * handled by the full morning warm-up and has a multi-hour TTL anyway.
 */
async function handleLineupRefresh(req, res) {
  const today = todayET();
  const start = Date.now();
  console.log(`\n🔄 Lineup refresh — ${today}\n`);

  // Re-fetch Rotowire (30-min TTL is intentional — warms the cache)
  const rwUrl = "https://www.rotowire.com/baseball/daily-lineups.php";
  const rwText = await serverFetch(rwUrl, 15_000);
  let rwOk = false;
  if (rwText) {
    await cacheSet(rwUrl, rwText, 30 * 60);
    console.log(`  ✅ Rotowire lineups — ${rwText.length} bytes`);
    rwOk = true;
  } else {
    console.log("  ❌ Rotowire lineups — failed");
  }

  // Re-fetch schedule too (game statuses change during the day)
  const scheduleUrl = `${MLB_API}/schedule?sportId=1&date=${today}&hydrate=team,probablePitcher,lineScore`;
  const schedText = await serverFetch(scheduleUrl, 10_000);
  let schedOk = false;
  if (schedText) {
    await cacheSet(scheduleUrl, schedText, 30 * 60); // shorter TTL for live-day refreshes
    console.log(`  ✅ Schedule — ${schedText.length} bytes`);
    schedOk = true;
  } else {
    console.log("  ❌ Schedule — failed");
  }

  const totalMs = Date.now() - start;
  console.log(`\n✅ Lineup refresh complete in ${(totalMs / 1000).toFixed(1)}s\n`);

  res.status(200).json({
    ok: true,
    scope: "lineups",
    date: today,
    duration_ms: totalMs,
    rotowire: rwOk,
    schedule: schedOk,
  });
}

/**
 * Closing-odds snapshot + CLV grading — called at ~6:45 PM ET by GitHub Actions
 * (scope=closing-odds). Fetches standard prop markets + game lines one more time,
 * stores them in daily_odds.closing_*, then stamps today's player-prop picks with
 * closing_odds and clv_pct (impliedProb(close) − impliedProb(taken); positive =
 * the line moved toward the pick after we took it).
 *
 * Standard markets only (no alternates): halves the credit cost, and picks on
 * alt lines simply get null CLV when the closing point doesn't match.
 */
const CLV_MARKET_KEYS = {
  hits: "batter_hits",
  hr: "batter_home_runs",
  tb: "batter_total_bases",
  hrr: "batter_hits_runs_rbis",
  sb: "batter_stolen_bases",
  rbi: "batter_rbis",
  ks: "pitcher_strikeouts",
};

const normPlayerName = (s) =>
  (s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z ]/g, "")
    .replace(/\s+/g, " ")
    .trim();

// Game-line picks store teams as MLB abbrevs ("SEA @ BAL", team: "SEA"); The Odds
// API uses full names. Static 30-team map (Athletics have no city since 2025).
const TEAM_FULL_NAMES = {
  ARI: "Arizona Diamondbacks", ATL: "Atlanta Braves", BAL: "Baltimore Orioles",
  BOS: "Boston Red Sox", CHC: "Chicago Cubs", CWS: "Chicago White Sox",
  CIN: "Cincinnati Reds", CLE: "Cleveland Guardians", COL: "Colorado Rockies",
  DET: "Detroit Tigers", HOU: "Houston Astros", KC: "Kansas City Royals",
  LAA: "Los Angeles Angels", LAD: "Los Angeles Dodgers", MIA: "Miami Marlins",
  MIL: "Milwaukee Brewers", MIN: "Minnesota Twins", NYM: "New York Mets",
  NYY: "New York Yankees", ATH: "Athletics", OAK: "Athletics",
  PHI: "Philadelphia Phillies", PIT: "Pittsburgh Pirates", SD: "San Diego Padres",
  SF: "San Francisco Giants", SEA: "Seattle Mariners", STL: "St. Louis Cardinals",
  TB: "Tampa Bay Rays", TEX: "Texas Rangers", TOR: "Toronto Blue Jays",
  WSH: "Washington Nationals",
};

function impliedFromAmerican(odds) {
  const o = +odds;
  if (!isFinite(o) || o === 0) return null;
  return o > 0 ? 100 / (o + 100) : Math.abs(o) / (Math.abs(o) + 100);
}

async function handleClosingOdds(req, res) {
  const today = todayET();
  const start = Date.now();
  const oddsKey = globalThis.process?.env?.ODDS_API_KEY;
  const supUrl = globalThis.process?.env?.SUPABASE_URL;
  const supKey = globalThis.process?.env?.SUPABASE_SERVICE_ROLE_KEY;
  if (!oddsKey || !supUrl || !supKey) {
    return res.status(500).json({ error: "Missing ODDS_API_KEY or Supabase env" });
  }
  const sbHeaders = {
    apikey: supKey,
    Authorization: `Bearer ${supKey}`,
    "Content-Type": "application/json",
  };
  console.log(`\n🌆 Closing odds snapshot — ${today}\n`);

  const BOOKS = "fanduel,draftkings,hardrockbet";
  const SPORT = "baseball_mlb";
  const STD_MARKETS =
    "batter_hits,batter_home_runs,batter_total_bases,batter_hits_runs_rbis,batter_stolen_bases,batter_stolen_bases_alternate,batter_rbis,pitcher_strikeouts";

  // ── Fetch closing game lines + props ──
  let closingML = null;
  const mlResp = await serverFetchWithCredits(
    `https://api.the-odds-api.com/v4/sports/${SPORT}/odds/?apiKey=${oddsKey}&regions=us&markets=h2h,spreads,totals&bookmakers=${BOOKS}&oddsFormat=american`
  );
  await logOddsCredits(supUrl, supKey, {
    source: "closing", used: mlResp.creditsUsed, remaining: mlResp.creditsRemaining, today,
  });
  if (mlResp.text) closingML = JSON.parse(mlResp.text);
  console.log(closingML ? `  ✅ Closing moneylines (credits remaining: ${mlResp.creditsRemaining})` : "  ❌ Closing moneylines failed");

  let closingProps = null;
  const eventsText = await serverFetch(
    `https://api.the-odds-api.com/v4/sports/${SPORT}/events?apiKey=${oddsKey}`
  );
  if (eventsText) {
    const events = JSON.parse(eventsText);
    // Per-game closing snapshots already captured near each first pitch
    // (scope=progressive-close) — reuse these (already paid for) and DON'T re-fetch
    // their events. The evening grader only fetches games the per-game capture
    // MISSED, so each game's props cost at most once/day. If closing_props is empty
    // (capture not running), this degrades to fetching the full slate, as before.
    const capRes = await fetch(`${supUrl}/rest/v1/closing_props?pick_date=eq.${today}&select=event_id,props`, { headers: sbHeaders });
    const capturedRows = capRes.ok ? await capRes.json() : [];
    const capturedEventIds = new Set(capturedRows.map((r) => r.event_id).filter(Boolean));
    const out = capturedRows.map((r) => r.props).filter(Boolean);
    // Only today's (ET) games — /events is ordered by commence_time and includes
    // tomorrow's early games, so a fixed slice(0,15) could spend the budget on the
    // wrong day and drop today's late games. Doubleheaders are separate event IDs,
    // so a 15-game slate can be 16-17 events; cap generously to never truncate a real
    // slate. (CLV match-rate was capping ~70% partly from this drop — 2026-06-21.)
    const todaysEvents = events.filter(
      (e) => e?.commence_time &&
        new Date(e.commence_time).toLocaleDateString("en-CA", { timeZone: "America/New_York" }) === today
    );
    let fetchedNow = 0;
    for (const event of todaysEvents.slice(0, 40)) {
      if (capturedEventIds.has(event.id)) continue; // captured at its close — skip (no credit spend)
      try {
        const pText = await serverFetch(
          `https://api.the-odds-api.com/v4/sports/${SPORT}/events/${event.id}/odds?apiKey=${oddsKey}&regions=us&markets=${STD_MARKETS}&bookmakers=${BOOKS}&oddsFormat=american`,
          8000
        );
        if (pText) { out.push(JSON.parse(pText)); fetchedNow++; }
      } catch { /* skip failed event */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    closingProps = out;
    console.log(`  ✅ Closing props — ${out.length} events (${capturedRows.length} progressive, ${fetchedNow} fetched now)`);
  } else {
    console.log("  ❌ Closing props events list failed");
  }

  // ── Store snapshot on today's daily_odds row ──
  await fetch(`${supUrl}/rest/v1/daily_odds?on_conflict=game_date`, {
    method: "POST",
    headers: { ...sbHeaders, Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({
      game_date: today,
      closing_props_data: closingProps,
      closing_moneyline_data: closingML,
      closing_fetched_at: new Date().toISOString(),
    }),
  }).catch((e) => console.log(`  ⚠️ daily_odds closing upsert failed: ${e.message}`));

  // ── Index closing prices: book|market|player|side|point → price (+ best across books) ──
  const byBook = new Map();
  const bestAcross = new Map();
  const index = (bookKey, k, price) => {
    byBook.set(`${bookKey}|${k}`, price);
    const prev = bestAcross.get(k);
    // "best" for the bettor = highest american price
    if (prev === undefined || +price > +prev) bestAcross.set(k, price);
  };
  for (const ev of closingProps || []) {
    for (const bm of ev?.bookmakers || []) {
      for (const mkt of bm?.markets || []) {
        for (const oc of mkt?.outcomes || []) {
          index(bm.key, `${mkt.key}|${normPlayerName(oc.description)}|${oc.name}|${oc.point ?? ""}`, oc.price);
        }
      }
    }
  }
  // Game lines: keyed by event matchup so "SEA @ BAL" picks can find their game.
  for (const ev of closingML || []) {
    const evKey = `${ev.away_team}|${ev.home_team}`;
    for (const bm of ev?.bookmakers || []) {
      for (const mkt of bm?.markets || []) {
        for (const oc of mkt?.outcomes || []) {
          index(bm.key, `${mkt.key}|${evKey}|${oc.name}|${oc.point ?? ""}`, oc.price);
        }
      }
    }
  }

  // ── Grade today's picks (player props + ml/rl/ou game lines) with closing odds + CLV ──
  let graded = 0, noMatch = 0;
  const picksRes = await fetch(
    `${supUrl}/rest/v1/mlb_picks?pick_date=eq.${today}&select=id,player_name,team,prop_type,line,direction,best_book,best_odds`,
    { headers: sbHeaders }
  );
  const picks = picksRes.ok ? await picksRes.json() : [];
  for (const p of picks) {
    const marketKey = CLV_MARKET_KEYS[p.prop_type];
    let k = null;
    if (marketKey) {
      const side = p.direction === "under" ? "Under" : "Over";
      k = `${marketKey}|${normPlayerName(p.player_name)}|${side}|${p.line ?? ""}`;
    } else if (p.prop_type === "ml" || p.prop_type === "rl" || p.prop_type === "ou") {
      // player_name is "AWAY @ HOME" in MLB abbrevs
      const [awayAb, homeAb] = String(p.player_name || "").split(" @ ");
      const evKey = `${TEAM_FULL_NAMES[awayAb]}|${TEAM_FULL_NAMES[homeAb]}`;
      if (evKey.includes("undefined")) continue;
      if (p.prop_type === "ml") {
        const side = TEAM_FULL_NAMES[p.team];
        if (!side) continue;
        k = `h2h|${evKey}|${side}|`;
      } else if (p.prop_type === "rl") {
        const side = TEAM_FULL_NAMES[p.team];
        if (!side) continue;
        k = `spreads|${evKey}|${side}|${p.line != null ? Number(p.line) : ""}`;
      } else {
        const side = p.direction === "under" ? "Under" : "Over";
        k = `totals|${evKey}|${side}|${p.line != null ? Number(p.line) : ""}`;
      }
    } else {
      continue;
    }
    const closing = (p.best_book && byBook.get(`${p.best_book}|${k}`)) ?? bestAcross.get(k) ?? null;
    if (closing == null) { noMatch++; continue; }
    const taken = impliedFromAmerican(p.best_odds);
    const close = impliedFromAmerican(closing);
    const clv = taken != null && close != null ? +(close - taken).toFixed(4) : null;
    const patch = await fetch(`${supUrl}/rest/v1/mlb_picks?id=eq.${p.id}`, {
      method: "PATCH",
      headers: sbHeaders,
      body: JSON.stringify({ closing_odds: closing, clv_pct: clv }),
    });
    if (patch.ok) graded++;
  }
  console.log(`  📐 CLV graded ${graded}/${picks.length} picks (${noMatch} no closing match)`);

  const totalMs = Date.now() - start;
  return res.status(200).json({
    ok: true,
    scope: "closing-odds",
    date: today,
    duration_ms: totalMs,
    props_events: closingProps?.length ?? 0,
    picks_total: picks.length,
    picks_graded: graded,
    picks_no_match: noMatch,
  });
}

// ── Progressive closing-odds capture ──────────────────────────────────────
// Runs every ~15 min (GitHub Actions) during game hours. For each of today's
// games that is within ~12 min of first pitch and NOT yet captured, fetch its
// player props ONCE and store in closing_props. This replaces the single 6:45 PM
// batch's prop fetch: day games finish before the evening cron and drop off
// /events, so their closing odds were never captured (~70% CLV ceiling).
//
// Credit-safe invariant: each game's props are fetched AT MOST ONCE per day —
// the captured-set check below skips done games, and the closing-odds grader
// only fetches games this capture MISSED. /events listing + MLB schedule are
// free; only /events/{id}/odds costs (8 markets = 8 credits). Total/day ≈ the
// same ~120 credits the old single batch cost, but with full-slate coverage.
async function handleProgressiveClose(req, res) {
  const today = todayET();
  const start = Date.now();
  const oddsKey = globalThis.process?.env?.ODDS_API_KEY;
  const supUrl = globalThis.process?.env?.SUPABASE_URL;
  const supKey = globalThis.process?.env?.SUPABASE_SERVICE_ROLE_KEY;
  if (!oddsKey || !supUrl || !supKey) {
    return res.status(500).json({ error: "Missing ODDS_API_KEY or Supabase env" });
  }
  const sbHeaders = { apikey: supKey, Authorization: `Bearer ${supKey}`, "Content-Type": "application/json" };
  const SPORT = "baseball_mlb";
  const BOOKS = "fanduel,draftkings,hardrockbet";
  const STD_MARKETS =
    "batter_hits,batter_home_runs,batter_total_bases,batter_hits_runs_rbis,batter_stolen_bases,batter_stolen_bases_alternate,batter_rbis,pitcher_strikeouts";
  const WINDOW_BEFORE_MS = 12 * 60 * 1000;  // start capturing ~12 min before first pitch (≈ closing line)
  const WINDOW_AFTER_MS  = 60 * 60 * 1000;  // safety: still grab up to 60 min after if a run was missed

  // Today's schedule (free) → game_pk + full team names + first-pitch time.
  const schedText = await serverFetch(`${MLB_API}/schedule?sportId=1&date=${today}&hydrate=team`, 10_000);
  const games = schedText ? (JSON.parse(schedText)?.dates?.[0]?.games || []) : [];

  // Games already captured today — never re-fetch (credit guard).
  const capRes = await fetch(`${supUrl}/rest/v1/closing_props?pick_date=eq.${today}&select=game_pk`, { headers: sbHeaders });
  const captured = new Set((capRes.ok ? await capRes.json() : []).map((r) => Number(r.game_pk)));

  const now = Date.now();
  const due = games.filter((g) => {
    if (captured.has(Number(g.gamePk))) return false;
    const ct = Date.parse(g.gameDate);
    return Number.isFinite(ct) && now >= ct - WINDOW_BEFORE_MS && now <= ct + WINDOW_AFTER_MS;
  });
  if (!due.length) {
    return res.status(200).json({ ok: true, scope: "progressive-close", date: today, due: 0, already_captured: captured.size });
  }

  // Map MLB games → Odds API events by normalized team names (/events is free).
  const eventsText = await serverFetch(`https://api.the-odds-api.com/v4/sports/${SPORT}/events?apiKey=${oddsKey}`);
  const events = eventsText ? JSON.parse(eventsText) : [];
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z]/g, "");
  const evByKey = new Map();
  for (const e of events) evByKey.set(`${norm(e.away_team)}|${norm(e.home_team)}`, e);

  let capturedNow = 0, noEvent = 0, failed = 0;
  let lastCreditsUsed = null, lastCreditsRemaining = null;
  for (const g of due) {
    const ev = evByKey.get(`${norm(g.teams?.away?.team?.name)}|${norm(g.teams?.home?.team?.name)}`);
    if (!ev) { noEvent++; continue; }
    const pResp = await serverFetchWithCredits(
      `https://api.the-odds-api.com/v4/sports/${SPORT}/events/${ev.id}/odds?apiKey=${oddsKey}&regions=us&markets=${STD_MARKETS}&bookmakers=${BOOKS}&oddsFormat=american`,
      8000
    );
    if (pResp.creditsUsed != null) lastCreditsUsed = pResp.creditsUsed;
    if (pResp.creditsRemaining != null) lastCreditsRemaining = pResp.creditsRemaining;
    const pText = pResp.text;
    let props = null;
    try { props = pText ? JSON.parse(pText) : null; } catch { props = null; }
    if (!props) { failed++; continue; }
    const up = await fetch(`${supUrl}/rest/v1/closing_props?on_conflict=pick_date,game_pk`, {
      method: "POST",
      headers: { ...sbHeaders, Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ pick_date: today, game_pk: g.gamePk, event_id: ev.id, props, captured_at: new Date().toISOString() }),
    });
    if (up.ok) capturedNow++; else failed++;
    await new Promise((r) => setTimeout(r, 250));
  }
  console.log(`  📸 progressive-close: captured ${capturedNow}/${due.length} due (${noEvent} no event match, ${failed} failed)`);
  // Snapshot credit usage after this run's per-event burns (cumulative used / remaining).
  await logOddsCredits(supUrl, supKey, {
    source: "progressive", used: lastCreditsUsed, remaining: lastCreditsRemaining, today,
  });
  return res.status(200).json({
    ok: true, scope: "progressive-close", date: today,
    due: due.length, captured_now: capturedNow, no_event: noEvent, failed,
    total_captured: captured.size + capturedNow, duration_ms: Date.now() - start,
  });
}

function todayET() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

async function fetchAndCache(label, url, ttl) {
  const t0 = Date.now();
  const data = await serverFetch(url, 20_000);
  if (data) {
    await cacheSet(url, data, ttl);
    console.log(`  ✅ ${label} — ${Date.now() - t0}ms (${data.length} bytes)`);
    return true;
  } else {
    console.log(`  ❌ ${label} — failed`);
    return false;
  }
}

/**
 * GET /api/cron?scope=boards — write TODAY's Golden boards, on a schedule
 * GitHub cannot drop.
 *
 * WHY (2026-08-31)
 * The three Golden boards had exactly one writer: two steps near the end of
 * daily-picks.yml, gated on a GitHub `schedule` cron at 16:30 UTC. Since the
 * 08-26 delivery degradation that cron has been landing 2.9-3.5 h late — the
 * boards locked at 3:24, 3:27 and 4:00 PM ET on 08-29/30/28 against a UI that
 * promises 12:30 PM ET — and on 08-31 the 16:30 slot was never delivered at
 * all. GitHub drops a scheduled fire it cannot start rather than queueing it,
 * so "late" and "never" are the same event with different luck, and the tab
 * read "No board written for this date" through the entire slate.
 *
 * Nothing about writing the boards actually needs Actions. The Playwright
 * driver does (it makes the deployed app compute and persist the scan), but by
 * the time the scan blob is in daily_scan_results the rest is pure server-side
 * data work — 6 s for the Brain Trust surface, 2 s for the three boards. So the
 * board half moves onto the pg_cron → Vercel path from db/migrations/013, which
 * has stayed punctual to the minute throughout (its beacon stamped 20:07:08Z on
 * the same day the four GitHub crons above were hours late).
 *
 * This does NOT replace the daily-picks steps. Both paths run; whichever fires
 * first writes the boards and the other no-ops, exactly like the closing-odds
 * fallback. Neither is a single point of failure — that property is the point.
 *
 * Idempotent and cheap on the common path: one indexed count, and if today's
 * boards exist it returns without touching anything. No --force anywhere, so a
 * board already locked is never rewritten under a reader who has seen it.
 */
async function handleBoards(req, res) {
  const today = todayET();
  const url = globalThis.process?.env?.SUPABASE_URL;
  const key = globalThis.process?.env?.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return res.status(500).json({ error: "Missing Supabase credentials" });

  const sbGet = async (path) => {
    const r = await fetch(`${url}/rest/v1/${path}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) throw new Error(`sb ${path}: ${r.status}`);
    return r.json();
  };

  try {
    // Cheap exit: the boards are already written for today. This is the state on
    // every tick after the first, so it is the path that has to stay trivial.
    const existing = await sbGet(
      `golden_snapshots?pick_date=eq.${today}&board=neq.legacy&select=board`,
    );
    if (existing.length >= 3) {
      return res.status(200).json({ ok: true, scope: "boards", date: today, wrote: false, reason: "already written" });
    }

    // The boards select from the Brain Trust per-line surface, so that has to
    // exist first — and it is REBUILT every time the boards are missing, not
    // just when no surface row exists.
    //
    // "Row exists → surface is good" is a trap: build() prices predictions off
    // daily_odds, and if the scan has landed but the odds have not, it writes a
    // surface with zero priced rows. buildGoldenSnapshot never writes an empty
    // board (`no qualifying rows — nothing written`), so that combination wedges
    // permanently: every later tick sees a surface row, skips the rebuild, and
    // selects three empty boards out of it, forever. Rebuilding costs ~6 s, is
    // idempotent, and reads scan + odds only — no outcomes ever enter it, so a
    // surface rebuilt at 2 PM is byte-for-byte what it would have been at noon
    // and there is no look-ahead. Safe to redo for `today` specifically, which
    // is the only date this handler touches: today's surface is not graded until
    // tomorrow, so nothing is being reset under a grade.
    let builtSurface = false;
    try {
      await buildBrainTrust(today);
      builtSurface = true;
    } catch (e) {
      // The scan or odds have not landed yet. Normal before the driver runs,
      // and a 200 keeps pg_cron from retrying into an alert — the next tick
      // picks it up on its own.
      if (isSoftSkip(e)) {
        return res.status(200).json({ ok: true, scope: "boards", date: today, wrote: false, reason: e.message });
      }
      throw e;
    }

    await buildGoldenSnapshot(today);
    const after = await sbGet(
      `golden_snapshots?pick_date=eq.${today}&board=neq.legacy&select=board`,
    );
    return res.status(200).json({
      ok: true, scope: "boards", date: today,
      wrote: after.length > existing.length, builtSurface, boards: after.map((b) => b.board),
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "boards failed" });
  }
}

export default async function handler(req, res) {
  // ── Auth: Vercel Cron sends Authorization: Bearer <CRON_SECRET> ────────────
  const cronSecret = globalThis.process?.env?.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers?.authorization || "";
    const querySecret = req.query?.secret;
    const bearerMatch = authHeader === `Bearer ${cronSecret}`;
    const queryMatch = querySecret === cronSecret;
    if (!bearerMatch && !queryMatch) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  // scope=lineups → lightweight refresh used by the 30-min GitHub Actions cron.
  // scope=full (default) → full morning warm-up.
  const scope = req.query?.scope || "full";
  if (scope === "lineups") return handleLineupRefresh(req, res);
  if (scope === "closing-odds") return handleClosingOdds(req, res);
  if (scope === "progressive-close") return handleProgressiveClose(req, res);
  // scope=watchdog → hourly pg_cron beacon (db/migrations/014). Cheap: one
  // schedule fetch plus a handful of indexed reads, no Odds API credits.
  if (scope === "watchdog") return handleWatchdog(req, res);
  // scope=boards → today's Golden boards on the punctual path (see above).
  // Free on every tick after the boards exist: one indexed count and out.
  if (scope === "boards") return handleBoards(req, res);

  // An unrecognised scope must NOT fall through to the full warm-up. That
  // default costs Odds API credits, and the fall-through is live the moment a
  // caller is pointed at a scope this deployment does not have yet — exactly
  // what an hourly pg_cron job would have done to a deployment predating the
  // watchdog scope. Fail loudly instead of silently doing the expensive thing.
  if (scope !== "full") {
    return res.status(400).json({ error: `Unknown scope "${scope}"` });
  }

  const today = todayET();
  const season = today.startsWith("2026") ? 2026 : new Date().getFullYear();
  const start = Date.now();

  console.log(`\n🌅 MLB Research Dashboard cron starting — ${today}\n`);

  // ── Step 0: Score yesterday's picks + Golden 10 (runs from the PUNCTUAL Vercel
  // cron so Results is fully current by ~7 AM ET). Previously this only lived in
  // GitHub Actions' morning-score.yml, whose schedule lags hours (observed firing
  // 10:27 AM ET for a 7 AM cron), leaving Results stale all morning. Isolated in
  // its own try/catch: a scoring failure must not block the data warm-up below,
  // and the warm-up must not block scoring. morning-score.yml stays as a backup.
  //
  // voidReasons (not blanket void): settle terminal DNPs — a player absent from a
  // Final game never grades — but LEAVE no_final_game pending, since a yesterday
  // game that was postponed/suspended can still resume and grade for real today.
  console.log("[Score yesterday]");
  try {
    const g = await gradePendingPicks({
      apply: true,
      voidReasons: ["player_dnp", "no_stat_for_prop"],
    });
    console.log(`  ✅ Graded ${g.applied}, voided ${g.voided}, left pending ${g.ungradeable - g.voided}`);
    const yest = new Date(Date.now() - 86_400_000).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    // Backstop only — no force. daily-picks.yml writes the boards at 12:30 PM ET
    // on the slate day; a rebuild here would overwrite the board the Golden tab
    // already showed as locked. Empty boards still get filled (see morning-score.yml).
    await buildGoldenSnapshot(yest);
  } catch (e) {
    console.log(`  ⚠️ Morning scoring failed (warm-up continues): ${e.message}`);
  }
  console.log("");

  // ── Step 1: Wipe yesterday's cache ──────────────────────────────────────────
  await wipePreviousDays();
  console.log("  🗑  Wiped previous days' cache\n");

  // ── Step 2: Today's schedule ─────────────────────────────────────────────────
  console.log("[Schedule]");
  const scheduleUrl = `${MLB_API}/schedule?sportId=1&date=${today}&hydrate=team,probablePitcher,lineScore`;
  const scheduleText = await serverFetch(scheduleUrl);
  let pitcherIds = [];
  let teamIds = [];
  if (scheduleText) {
    await cacheSet(scheduleUrl, scheduleText, 4 * 3600);
    console.log(`  ✅ Schedule — ${scheduleText.length} bytes`);
    try {
      const sched = JSON.parse(scheduleText);
      const games = sched?.dates?.[0]?.games || [];
      // Collect probable pitcher IDs and team IDs for batter pre-fetching
      for (const g of games) {
        const ap = g.teams?.away?.probablePitcher?.id;
        const hp = g.teams?.home?.probablePitcher?.id;
        if (ap) pitcherIds.push(ap);
        if (hp) pitcherIds.push(hp);
        if (g.teams?.away?.team?.id) teamIds.push(g.teams.away.team.id);
        if (g.teams?.home?.team?.id) teamIds.push(g.teams.home.team.id);
      }
      console.log(`       ${games.length} game(s), ${pitcherIds.length} probable pitchers, ${teamIds.length} teams`);
    } catch { /* parse error non-fatal */ }
  } else {
    console.log("  ❌ Schedule — failed");
  }

  // ── Step 3: Rotowire lineups ─────────────────────────────────────────────────
  console.log("\n[Rotowire]");
  await fetchAndCache(
    "Daily lineups",
    "https://www.rotowire.com/baseball/daily-lineups.php",
    30 * 60 // 30 min TTL — lineups refresh throughout the morning
  );

  // ── Step 4: Baseball Savant league-wide CSVs ─────────────────────────────────
  // These are fetched once and shared by ALL player lookups — the most expensive
  // calls to make on-demand (1-3 seconds each).
  console.log("\n[Baseball Savant]");
  const savantCalls = [
    {
      label: `Percentile rankings ${season}`,
      url: `${SAVANT}/leaderboard/percentile-rankings?type=batter&year=${season}&min=1&csv=true`,
      ttl: 6 * 3600,
    },
    {
      label: `Batter arsenal stats ${season}`,
      url: `${SAVANT}/leaderboard/pitch-arsenal-stats?type=batter&pitchType=&year=${season}&run_value_type=per100&min=1&csv=true`,
      ttl: 6 * 3600,
    },
    {
      label: `Pitcher arsenal stats ${season}`,
      url: `${SAVANT}/leaderboard/pitch-arsenal-stats?type=pitcher&pitchType=&year=${season}&run_value_type=per100&min=1&csv=true`,
      ttl: 6 * 3600,
    },
    {
      label: `Statcast custom leaderboard ${season}`,
      url: `${SAVANT}/leaderboard/custom?year=${season}&type=batter&filter=&sort=4&sortDir=desc&min=10&selections=exit_velocity_avg%2Claunch_angle_avg%2Cbarrel_batted_rate%2Chard_hit_percent%2Cxba%2Cxwoba%2Cwoba&csv=true`,
      ttl: 6 * 3600,
    },
    // Prior year data — stable, only needs fetching once per season
    {
      label: `Percentile rankings ${season - 1}`,
      url: `${SAVANT}/leaderboard/percentile-rankings?type=batter&year=${season - 1}&min=1&csv=true`,
      ttl: 24 * 3600,
    },
    {
      label: `Batter arsenal stats ${season - 1}`,
      url: `${SAVANT}/leaderboard/pitch-arsenal-stats?type=batter&pitchType=&year=${season - 1}&run_value_type=per100&min=1&csv=true`,
      ttl: 24 * 3600,
    },
    {
      label: `Pitcher arsenal stats ${season - 1}`,
      url: `${SAVANT}/leaderboard/pitch-arsenal-stats?type=pitcher&pitchType=&year=${season - 1}&run_value_type=per100&min=1&csv=true`,
      ttl: 24 * 3600,
    },
    // ── New endpoints (season) ────────────────────────────────────────────────
    // Expected statistics: xBA/xSLG/xwOBA vs actual → regression-to-mean signal
    { label: `Expected stats batter ${season}`,   url: `${SAVANT}/leaderboard/expected_statistics?type=batter&year=${season}&position=&team=&min=1&csv=true`,  ttl: 6 * 3600 },
    { label: `Expected stats pitcher ${season}`,  url: `${SAVANT}/leaderboard/expected_statistics?type=pitcher&year=${season}&position=&team=&min=1&csv=true`, ttl: 6 * 3600 },
    // HR leaderboard: xHR vs actual → HR regression signal
    { label: `HR leaderboard batter ${season}`,   url: `${SAVANT}/leaderboard/home-runs?year=${season}&csv=true`,                                               ttl: 6 * 3600 },
    // Batted ball profile: GB%, FB%, pull%, pull_air_rate → HR corridor signal
    { label: `Batted ball profile ${season}`,     url: `${SAVANT}/leaderboard/batted-ball?year=${season}&min_pa=1&csv=true`,                                    ttl: 6 * 3600 },
    // Swing-take zone run values: heart/shadow/chase/waste → discipline signal
    { label: `Swing-take batter ${season}`,       url: `${SAVANT}/leaderboard/swing-take?group=Batter&year=${season}&min_pa=1&csv=true`,                        ttl: 6 * 3600 },
    { label: `Swing-take pitcher ${season}`,      url: `${SAVANT}/leaderboard/swing-take?group=Pitcher&year=${season}&min_pa=1&csv=true`,                       ttl: 6 * 3600 },
    // Basestealing run value: runner aggressiveness + success quality
    { label: `Basestealing run value ${season}`,  url: `${SAVANT}/leaderboard/basestealing-run-value?year=${season}&min=1&csv=true`,                            ttl: 6 * 3600 },
    // Pitcher running game: how well pitcher holds baserunners
    { label: `Pitcher running game ${season}`,    url: `${SAVANT}/leaderboard/pitcher-running-game?year=${season}&csv=true`,                                    ttl: 6 * 3600 },
    // Pitcher percentile rankings
    { label: `Pitcher percentile rankings ${season}`, url: `${SAVANT}/leaderboard/percentile-rankings?type=pitcher&year=${season}&min=1&csv=true`,             ttl: 6 * 3600 },
    // Bat tracking: attack angle + swing tilt (2024+)
    { label: `Bat tracking attack angle ${season}`, url: `${SAVANT}/leaderboard/bat-tracking/swing-path-attack-angle?year=${season}&min_pa=1&csv=true`,        ttl: 6 * 3600 },
    // Pitcher arm angles: ball release angle + shoulder position
    { label: `Pitcher arm angles ${season}`,      url: `${SAVANT}/leaderboard/pitcher-arm-angles?year=${season}&min=1&csv=true`,                               ttl: 6 * 3600 },
    // Active spin efficiency per pitch type
    { label: `Active spin ${season}`,             url: `${SAVANT}/leaderboard/active-spin?year=${season}&min=1&csv=true`,                                       ttl: 6 * 3600 },
    // Outs Above Average (all fielders) — aggregated per team for game model defense
    { label: `OAA fielding ${season}`,            url: `${SAVANT}/leaderboard/outs_above_average?type=Fielder&team=&range=year&min=q&pos=&roles=&viz=show&year=${season}&csv=true`, ttl: 6 * 3600 },
  ];

  for (const call of savantCalls) {
    await fetchAndCache(call.label, call.url, call.ttl);
    // Small delay to be polite to Savant — they don't rate-limit but no need to hammer
    await new Promise(r => setTimeout(r, 300));
  }

  // ── Step 5: Odds API — moneylines + player props → stored in daily_odds table ──
  // This is the ONLY place in the entire app that calls the Odds API.
  // Storing results in daily_odds (date-keyed) means api/odds.js serves from DB
  // for the rest of the day — no credits burned on subsequent page loads.
  console.log("\n[Odds API — moneylines + player props]");
  const oddsKey = globalThis.process?.env?.ODDS_API_KEY;
  const supUrl  = globalThis.process?.env?.SUPABASE_URL;
  const supKey  = globalThis.process?.env?.SUPABASE_SERVICE_ROLE_KEY;

  let moneylineData = null;
  let propsData     = null;

  if (!oddsKey) {
    console.log("  ⚠️  ODDS_API_KEY not set — skipping");
  } else {
    const BOOKS  = "fanduel,draftkings,hardrockbet";
    const SPORT  = "baseball_mlb";
    // + the four Pitch Lab pitcher props (src/lib/pitchlab.js PITCHER_PROPS), standard markets
    // only: +4 credits per event on this one morning pull (a market no book posts is not billed).
    // Their alternates and the closing snapshots are deliberately left out to hold the cost down.
    const STD_MARKETS = "batter_hits,batter_home_runs,batter_total_bases,batter_hits_runs_rbis,batter_stolen_bases,batter_rbis,pitcher_strikeouts,pitcher_outs,pitcher_hits_allowed,pitcher_walks,pitcher_earned_runs";
    const ALT_MARKETS = "batter_hits_alternate,batter_home_runs_alternate,batter_total_bases_alternate,batter_hits_runs_rbis_alternate,batter_stolen_bases_alternate,batter_rbis_alternate,pitcher_strikeouts_alternate";
    const ALL_MARKETS = `${STD_MARKETS},${ALT_MARKETS}`;

    // Moneylines + run lines (spreads). Use direct fetch (not serverFetch) so we
    // can read the x-requests-* credit headers from The Odds API response.
    let oddsCreditsUsed = null;
    let oddsCreditsRemaining = null;
    try {
      const mlRes = await fetch(
        `https://api.the-odds-api.com/v4/sports/${SPORT}/odds/?apiKey=${oddsKey}&regions=us&markets=h2h,spreads,totals&bookmakers=${BOOKS}&oddsFormat=american&includeLinks=true&includeSids=true`
      );
      oddsCreditsUsed      = mlRes.headers.get("x-requests-used");
      oddsCreditsRemaining = mlRes.headers.get("x-requests-remaining");
      await logOddsCredits(supUrl, supKey, {
        source: "morning",
        used:      oddsCreditsUsed != null ? parseInt(oddsCreditsUsed, 10) : null,
        remaining: oddsCreditsRemaining != null ? parseInt(oddsCreditsRemaining, 10) : null,
        today,
      });
      if (mlRes.ok) {
        const mlText = await mlRes.text();
        moneylineData = JSON.parse(mlText);
        await cacheSet("mlb:odds:moneylines", mlText, 12 * 3600);
        console.log(`  ✅ Moneylines — ${mlText.length} bytes (credits used: ${oddsCreditsUsed}, remaining: ${oddsCreditsRemaining})`);
      } else {
        console.log("  ❌ Moneylines — failed");
      }
    } catch (e) {
      console.log(`  ❌ Moneylines — error: ${e.message}`);
    }

    // Player props — fetch per event, collect all into one array
    const eventsText = await serverFetch(
      `https://api.the-odds-api.com/v4/sports/${SPORT}/events?apiKey=${oddsKey}`
    );
    if (eventsText) {
      const events = JSON.parse(eventsText);
      const propResponses = [];
      for (const event of events.slice(0, 15)) {
        try {
          const pText = await serverFetch(
            `https://api.the-odds-api.com/v4/sports/${SPORT}/events/${event.id}/odds?apiKey=${oddsKey}&regions=us&markets=${ALL_MARKETS}&bookmakers=${BOOKS}&oddsFormat=american&includeLinks=true&includeSids=true`,
            8000
          );
          if (pText) propResponses.push(JSON.parse(pText));
        } catch { /* skip failed event */ }
        await new Promise(r => setTimeout(r, 250));
      }
      propsData = propResponses;
      await cacheSet("mlb:odds:props", JSON.stringify(propsData), 12 * 3600);
      console.log(`  ✅ Props — ${events.length} events, ${propResponses.length} fetched`);
    } else {
      console.log("  ❌ Props events list — failed");
    }

    // Write both to daily_odds table (date-keyed, survives all day)
    if (supUrl && supKey && (moneylineData || propsData)) {
      try {
        const upsertRes = await fetch(
          `${supUrl}/rest/v1/daily_odds?on_conflict=game_date`,
          {
            method: "POST",
            headers: {
              apikey:         supKey,
              Authorization: `Bearer ${supKey}`,
              "Content-Type": "application/json",
              Prefer:         "resolution=merge-duplicates",
            },
            body: JSON.stringify({
              game_date:           today,
              props_data:          propsData,
              moneyline_data:      moneylineData,
              fetched_at:          new Date().toISOString(),
              odds_credits_used:      oddsCreditsUsed ? parseInt(oddsCreditsUsed, 10) : null,
              odds_credits_remaining: oddsCreditsRemaining ? parseInt(oddsCreditsRemaining, 10) : null,
            }),
          }
        );
        if (upsertRes.ok || upsertRes.status === 201) {
          console.log(`  ✅ daily_odds upserted for ${today}`);
        } else {
          const errText = await upsertRes.text();
          console.log(`  ⚠️  daily_odds upsert status ${upsertRes.status}: ${errText.slice(0, 200)}`);
        }
      } catch (e) {
        console.log(`  ❌ daily_odds upsert error: ${e.message}`);
      }

      // Prune daily_odds rows older than 7 days
      try {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 7);
        const cutoffStr = cutoff.toISOString().slice(0, 10);
        await fetch(
          `${supUrl}/rest/v1/daily_odds?game_date=lt.${cutoffStr}`,
          { method: "DELETE", headers: { apikey: supKey, Authorization: `Bearer ${supKey}` } }
        );
      } catch { /* non-fatal */ }
    }
  }

  // ── Step 6: Pitcher stats for today's starters ───────────────────────────────
  if (pitcherIds.length > 0) {
    console.log(`\n[Pitcher stats — ${pitcherIds.length} starters]`);
    for (const id of pitcherIds) {
      const url = `${MLB_API}/people/${id}?hydrate=stats(group=[pitching],type=[season,gameLog],season=${season}),currentTeam`;
      await fetchAndCache(`Pitcher ${id}`, url, 2 * 3600);
    }
  }

  // ── Step 7: Batter game logs for all position players on today's teams ────────
  // Fetches each player individually (not bulk) so the cached URL exactly matches
  // what the app requests through /api/proxy. The bulk /people?personIds= endpoint
  // can return stale or partial game log data compared to individual /people/{id}
  // requests, causing player-level inconsistencies within the same team.
  if (teamIds.length > 0) {
    console.log(`\n[Batter game logs — ${teamIds.length} teams]`);
    const batterIds = [];
    for (const tid of teamIds) {
      try {
        const rosterText = await serverFetch(`${MLB_API}/teams/${tid}/roster?rosterType=active&season=${season}`, 10_000);
        if (!rosterText) continue;
        const roster = JSON.parse(rosterText);
        for (const p of roster?.roster || []) {
          if (p.position?.code !== "1") batterIds.push(p.person?.id);
        }
      } catch { /* non-fatal */ }
    }
    const uniqueBatterIds = [...new Set(batterIds.filter(Boolean))];
    console.log(`  Fetching game logs for ${uniqueBatterIds.length} batters (individual)`);

    let cached = 0;
    for (const id of uniqueBatterIds) {
      try {
        const url = `${MLB_API}/people/${id}?hydrate=stats(group=[hitting],type=[gameLog],season=${season})`;
        const text = await serverFetch(url, 10_000);
        if (text) {
          await cacheSet(url, text, 2 * 3600);
          cached++;
        }
      } catch { /* non-fatal */ }
      await new Promise(r => setTimeout(r, 50));
    }
    console.log(`  ✅ Batter game logs — ${cached} players cached`);
  }

  const totalMs = Date.now() - start;
  const summary = `Cron complete in ${(totalMs / 1000).toFixed(1)}s`;
  console.log(`\n✅ ${summary}\n`);

  res.status(200).json({ ok: true, date: today, duration_ms: totalMs, message: summary });
}
