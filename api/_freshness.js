// Data-freshness heartbeat for the "SchiffPicks Lab" Google Sheets workbooks.
//
// NOT a serverless function (underscore prefix): the Hobby plan caps the
// project at 12 functions, so this is served through api/picks.js as
// GET /api/picks?view=freshness — the same fold-in pattern as view=sheets-feed.
//
// Why this exists: staring at a Data tab full of picks cannot answer "is this
// still flowing?". A quiet feed looks identical to a league that isn't playing
// (2026-07-13→15 All-Star break) and to a broken cron. So every slate-gated
// source is measured against the LEAGUE SCHEDULE, not against now() — an empty
// day with no games is IDLE, an empty day with 15 games is STALE. That
// distinction is the whole point; a plain max(timestamp) dashboard would have
// cried wolf for three straight days in July.
//
// GAP vs STALE: STALE = the newest expected slate never landed (the pipe is
// down now). GAP = the newest landed but older ones are missing (the pipe is
// up and the hole is permanent — scan blobs are a single point of loss and are
// never re-derivable; see docs and the daily-picks verify step).
//
// Auth mirrors _sheets-feed.js: APP_ACCESS_CODE as a `key` query param, since
// IMPORTDATA cannot send headers. Unset → open (anti-lockout, see api/_auth.js).

import { PINGERS, evaluatePing } from "../src/lib/watchdog.js";

export const LOOKBACK_DAYS = 14;

function getEnv(name) {
  const value = globalThis.process?.env?.[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function csvField(v) {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const etDate = (d) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);

export const etHour = (d) =>
  parseInt(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "2-digit", hour12: false,
  }).format(d), 10);

// Last N ET dates, newest first, today included.
export function recentDates(now, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(etDate(new Date(now.getTime() - i * 86400000)));
  }
  return out;
}

// ── Schedules ────────────────────────────────────────────────────────────────
// Both leagues answer a whole date range in one request, so a health check
// costs 2 upstream calls regardless of lookback.

// A single bare fetch here is a false-alarm generator: when the schedule call
// blips, mlbSlates throws, and BOTH callers treat "schedule unreachable" as a
// pipeline event — the dashboard falls back to UNKNOWN and the plumbing
// tripwire emits a P1 that opens an ops-alert issue and wakes the auditor.
// Every sibling call in the tripwire's freshness path already retries; this one
// didn't. Give it the same resilience: a few retries with backoff and a hard
// per-attempt timeout, so a momentary hiccup is absorbed while a genuine
// multi-minute outage still surfaces. (2026-09-07: a transient statsapi timeout
// tripped the wire; the endpoint was fine 2 minutes later.)
async function fetchJsonRetry(url, { tries = 3, timeoutMs = 12_000, label = "upstream" } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < tries; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 800 * 2 ** (attempt - 1)));
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { signal: ctrl.signal });
      // 4xx is a bad request, not a blip — fail fast, don't burn retries on it.
      if (r.status >= 400 && r.status < 500) throw new Error(`${label}: ${r.status}`);
      if (!r.ok) { lastErr = new Error(`${label}: ${r.status}`); continue; }
      return await r.json();
    } catch (e) {
      lastErr = e;
      if (e instanceof Error && / 4\d\d$/.test(e.message)) throw e;
    } finally {
      clearTimeout(tid);
    }
  }
  throw lastErr ?? new Error(`${label}: unreachable`);
}

// gameType=R excludes the All-Star Game itself, which would otherwise read as
// "there was a slate on 7/14" and mark every source STALE through the break.
export async function mlbSlates(dates) {
  const json = await fetchJsonRetry(
    "https://statsapi.mlb.com/api/v1/schedule?sportId=1&gameType=R" +
    `&startDate=${dates[dates.length - 1]}&endDate=${dates[0]}`,
    { label: "statsapi schedule" }
  );
  return new Set(
    (json.dates || []).filter((d) => (d.totalGames ?? 0) > 0).map((d) => d.date)
  );
}

// ESPN stamps each event in UTC, so a 10 PM ET tip lands on the next UTC day.
// Convert back to ET so a slate date means the same thing it does in
// wnba_picks.game_date.
async function wnbaSlates(dates) {
  const compact = (s) => s.replace(/-/g, "");
  const json = await fetchJsonRetry(
    "https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/scoreboard" +
    `?dates=${compact(dates[dates.length - 1])}-${compact(dates[0])}&limit=500`,
    { label: "espn scoreboard" }
  );
  return new Set(
    (json.events || [])
      .map((e) => (e.date ? etDate(new Date(e.date)) : null))
      .filter(Boolean)
  );
}

// ── Sources ──────────────────────────────────────────────────────────────────
// expectedByET: the ET hour by which a healthy run has written. Before it,
// today is PENDING rather than missing — otherwise every check run in the
// morning would report a false STALE.
//
// It is NOT the job's cron hour, and setting it from the `cadence` string is
// the bug this constant exists to prevent. GitHub delivers scheduled workflows
// late — measured across every scheduled run in this repo over the 21 days to
// 2026-08-30: median 43 min, p75 4h08m, p90 8h51m, worst 11h57m; daily-picks
// alone ran median 33 min / p90 5h36m / worst 8h02m behind its slot. A deadline
// derived from the cron hour therefore expires HOURS before the producing job
// has plausibly run, and the window between the two reads as STALE on a
// perfectly healthy pipeline.
//
// That is not hypothetical: the tripwire's afternoon slot (15:30 UTC nominal,
// itself delivered ~18:42 UTC = 14:42 ET) failed three days running — 2026-08-28,
// -29 and -30 — reporting pick_signals and golden_snapshots STALE each time,
// while daily-picks was simply still undelivered and landed normally afterwards.
//
// So the rule is: expectedByET = the LAST scheduled slot that can still write
// this slate + DELIVERY_LAG_H, capped at 23 (past that the ET day rolls over and
// `today` stops meaning this slate). Sources with a backstop slot are measured
// against the backstop, not the primary — a missed primary is not late until
// the backstop has also had its chance.
//
// This deliberately trades same-day detection for silence on healthy days. It
// costs nothing real: a slate that never lands is still caught the next morning
// (it becomes a prior slate → GAP), CHECK 6 in the tripwire catches a genuine
// save outage from days 1-3 without consulting today at all, and the watchdog
// beacons answer "did the job run" same-day. What it buys is an alarm that only
// rings when something is actually wrong — see the "cries every morning gets
// ignored" note at the top of scripts/plumbing-tripwire.mjs.
export const DELIVERY_LAG_H = 6;
const due = (lastSlotET) => Math.min(23, lastSlotET + DELIVERY_LAG_H);

export const SOURCES = [
  // MLB — slate-gated
  //
  // picks / pick_signals / scan_blobs / odds are ALL written by one job —
  // daily-picks.yml, which runs 12:30 PM ET and backstops at 6 PM ET. So they
  // share one deadline, taken off the 6 PM backstop: due(18) → capped at 23.
  // golden_snapshots rides the same deadline for a different reason; see its
  // own note below.
  { sport: "mlb", label: "picks", table: "mlb_picks", dateCol: "pick_date",
    tsCol: "created_at", gated: "mlb", expectedByET: due(18), cadence: "daily 12:30 PM ET" },
  { sport: "mlb", label: "pick_signals", table: "pick_signals", dateCol: "pick_date",
    tsCol: "created_at", gated: "mlb", expectedByET: due(18), cadence: "with picks" },
  { sport: "mlb", label: "scan_blobs", table: "daily_scan_results", dateCol: "game_date",
    tsCol: "scanned_at", gated: "mlb", expectedByET: due(18), cadence: "daily 12:30 PM ET" },
  // daily_odds is pruned to a rolling week, so slates older than that are
  // absent BY DESIGN — checking the full lookback would report permanent GAP.
  { sport: "mlb", label: "odds", table: "daily_odds", dateCol: "game_date",
    tsCol: "fetched_at", gated: "mlb", expectedByET: due(18), retentionDays: 7,
    cadence: "daily 12:30 PM ET" },
  // player-day-panel.yml, 9 AM ET, no backstop slot.
  { sport: "mlb", label: "player_day_panel", table: "player_day_features", dateCol: "game_date",
    tsCol: "captured_at", gated: "mlb", expectedByET: due(9), cadence: "daily 9:00 AM ET" },
  // Since 2026-08-31 the boards have TWO writers: the daily-picks.yml steps
  // above, and a pg_cron tick every 30 min from 10 AM ET that GitHub cannot
  // drop (db/migrations/016). The deadline still rides the same due(18) as the
  // scan, and must: the boards select from the Brain Trust surface, which is
  // built from the scan, so they can never be fresher than scan_blobs however
  // punctual their own writer is. What the second writer changes is the gap
  // between the scan landing and the boards existing — half an hour now, rather
  // than "whenever the tail of daily-picks.yml gets delivered".
  { sport: "mlb", label: "golden_snapshots", table: "golden_snapshots", dateCol: "pick_date",
    tsCol: "locked_at", gated: "mlb", expectedByET: due(18), cadence: "≤30 min after the scan" },
  // closing-odds.yml, 6:45 PM ET → due(18) after the cap, which is where this
  // one already sat: it was the only deadline sized for delivery lag.
  { sport: "mlb", label: "closing_props", table: "closing_props", dateCol: "pick_date",
    tsCol: "captured_at", gated: "mlb", expectedByET: due(18), cadence: "daily 6:45 PM ET" },
  // MLB — ungated (these crons run whether or not a slate exists)
  { sport: "mlb", label: "batter_adv_stats", table: "batter_advanced_stats", dateCol: null,
    tsCol: "updated_at", gated: null, maxAgeH: 30, cadence: "daily 8:00 AM ET" },
  { sport: "mlb", label: "pitcher_adv_stats", table: "pitcher_advanced_stats", dateCol: null,
    tsCol: "updated_at", gated: null, maxAgeH: 30, cadence: "daily 8:00 AM ET" },
  { sport: "mlb", label: "market_health", table: "market_health", dateCol: "eval_date",
    tsCol: "created_at", gated: null, maxAgeH: 30, cadence: "daily 7:00 AM ET" },
  // WNBA — slate-gated. daily-predict.yml in the WNBA repo runs 03:37 and
  // 11:07 AM ET; the 11:07 slot is the last that can write today's slate.
  { sport: "wnba", label: "picks", table: "wnba_picks", dateCol: "game_date",
    tsCol: "created_at", gated: "wnba", expectedByET: due(11), cadence: "daily 11:00 AM ET" },
];

// GETs only, and every caller is idempotent, so a transient network failure
// ("fetch failed" from undici on a DNS/connection blip) or a hung socket is
// safe to retry. Without this, one blip on any probe throws straight up: on
// 2026-08-31 it surfaced as a spurious `closing_props freshness probe failed`
// P1 in the plumbing tripwire while the slate was in fact present and fresh —
// the "tripwire that cries every morning" failure mode. Also guards the live
// dashboard banner against the same false STALE.
async function sb(url, key, path) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(`${url}/rest/v1/${path}`, {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(30000),
      });
      if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
      return r.json();
    } catch (err) {
      lastErr = err;
      if (attempt < 3) await new Promise((res) => setTimeout(res, 500 * attempt));
    }
  }
  throw lastErr;
}

// Distinct data dates present in the lookback window.
//
// Selecting the raw column and deduping client-side LOOKS fine and is wrong:
// PostgREST hard-caps every response at 1000 rows, so player_day_features
// (~5k rows/day) returns one truncated day and every other slate reads as
// missing. Aggregates are disabled on this project (PGRST123), so instead walk
// the dates with a keyset cursor — `order desc limit 1` below the last date
// found returns the next DISTINCT date, so this costs one small indexed
// request per date present, not per row.
export async function presentDates(url, key, src, since) {
  if (!src.dateCol) return null;
  const found = new Set();
  let cursor = null;
  for (let i = 0; i <= LOOKBACK_DAYS; i++) {
    const bound = cursor ? `&${src.dateCol}=lt.${cursor}` : "";
    const rows = await sb(url, key,
      `${src.table}?select=${src.dateCol}&${src.dateCol}=gte.${since}${bound}` +
      `&order=${src.dateCol}.desc&limit=1`);
    const d = rows[0]?.[src.dateCol];
    if (!d) break;
    found.add(d);
    cursor = d;
  }
  return found;
}

// Newest write timestamp. `scopeDate` narrows to a single slate first: the
// timestamp columns are unindexed, so an unbounded ORDER BY on a big table
// (player_day_features, ~67k rows) blows the statement timeout. Filtering on
// the indexed date column first makes the sort trivial, and the newest write
// always lives on the newest date anyway.
export async function lastWrite(url, key, src, scopeDate) {
  const scope = scopeDate ? `&${src.dateCol}=eq.${scopeDate}` : "";
  const rows = await sb(url, key,
    `${src.table}?select=${src.tsCol}${scope}&order=${src.tsCol}.desc.nullslast&limit=1`);
  return rows[0]?.[src.tsCol] ?? null;
}

// Exported for tests: this is the whole judgment of the feed, and its failure
// mode is silent (reporting OK while a pipe is down), so it's covered directly
// rather than only through a live call.
export function evaluate(src, slates, present, lastTs, now, today, hourET) {
  const ageH = lastTs
    ? Math.round(((now - new Date(lastTs)) / 3600000) * 10) / 10
    : null;

  // Ungated: a plain age budget is honest, since these run every day.
  if (!src.gated) {
    const status = ageH == null ? "NO DATA" : ageH > src.maxAgeH ? "STALE" : "OK";
    const detail = ageH == null ? "table empty"
      : status === "STALE" ? `no write in ${ageH}h (budget ${src.maxAgeH}h)`
      : `wrote ${ageH}h ago`;
    return { lastData: null, ageH, status, detail };
  }

  // Slate-gated: measure against the schedule, not the clock. Pruned tables
  // are only accountable for slates still inside their retention window.
  const horizon = src.retentionDays
    ? etDate(new Date(now.getTime() - src.retentionDays * 86400000))
    : null;
  const expected = [...slates].filter((d) => !horizon || d >= horizon)
    .sort().reverse();
  const missing = expected.filter((d) => {
    if (present.has(d)) return false;
    // Today's run may simply not be due yet.
    if (d === today && hourET < src.expectedByET) return false;
    return true;
  });
  const lastData = [...present].sort().reverse()[0] ?? null;

  if (!expected.length) {
    return { lastData, ageH, status: "IDLE", detail: `no games in last ${LOOKBACK_DAYS}d` };
  }
  const pendingToday =
    expected[0] === today && hourET < src.expectedByET && !present.has(today);

  if (!missing.length) {
    return {
      lastData, ageH, status: "OK",
      detail: pendingToday
        ? `today's run due by ${src.expectedByET}:00 ET; ${expected.length - 1} prior slates all present`
        : `all ${expected.length} slates present`,
    };
  }
  // Newest expected slate absent → the pipe is down right now.
  if (missing[0] === expected[0]) {
    return {
      lastData, ageH, status: "STALE",
      detail: `missing ${missing.length}/${expected.length} slates, newest ${missing[0]}`,
    };
  }
  // Newest landed, older holes → pipe is up; these days are lost for good.
  return {
    lastData, ageH, status: "GAP",
    detail: `missing ${missing.length}/${expected.length} slates: ${missing.join(" ")}`,
  };
}

// ── Watchdog beacons ─────────────────────────────────────────────────────────
// The rows above all answer "did the DATA land". These two answer "is anything
// still checking" — a distinction that cost two days on 2026-08-28, when the
// panel went stale, the tripwire that would have caught it had also not run,
// and neither absence produced a signal anywhere. See db/migrations/014.
//
// Emitted with sport "mlb" so the dashboard banner (which fetches ?sport=mlb)
// renders them; they are repo-wide rather than sport-specific, but this repo is
// the MLB lab and a second sport filter would just hide the alarm.
async function watchdogRows(url, key, now) {
  let bySource;
  try {
    const rows = await sb(url, key, "watchdog_pings?select=source,pinged_at,status,detail");
    bySource = new Map(rows.map((r) => [r.source, r]));
  } catch (err) {
    return PINGERS.map((p) => ["mlb", `watchdog:${p.source}`, p.cadence,
      null, null, null, "ERROR", err.message]);
  }
  return PINGERS.map((p) => {
    const row = bySource.get(p.source) || null;
    const e = evaluatePing(p, row, now);
    return ["mlb", `watchdog:${p.source}`, p.cadence, null,
      row?.pinged_at ?? null, e.ageH, e.status, e.detail];
  });
}

/**
 * The full verdict, as rows. Split out of the handler so the independent
 * pg_cron watchdog (/api/cron?scope=watchdog) evaluates exactly what the
 * dashboard shows instead of a second, drifting copy of the same judgment.
 */
export async function collectFreshness(now = new Date()) {
  const url = getEnv("SUPABASE_URL");
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");

  // Some sources live on the LAB project (moved 2026-08-11 to get the serving database
  // off 91.6% of the free plan's 500 MB cap). Credentials are chosen per source rather
  // than once, because a freshness probe pointed at the wrong project reports the table
  // as absent — which this page renders as STALE, i.e. a fabricated outage.
  //
  // Routing is kept local to api/ rather than importing scripts/_lab.mjs: Vercel turns
  // files in api/ into functions and this deployment already sits on the Hobby 12-function
  // cap, so pulling a scripts/ module into the bundle is not worth the risk.
  const LAB_ONLY = new Set(["player_day_features", "batter_asof_features", "pitcher_asof_features"]);
  const labUrl = globalThis.process?.env?.LAB_SUPABASE_URL;
  const labKey = globalThis.process?.env?.LAB_SUPABASE_SERVICE_ROLE_KEY;
  const credsFor = (src) =>
    LAB_ONLY.has(src.table) && labUrl && labKey ? [labUrl, labKey] : [url, key];

  const today = etDate(now);
  const hourET = etHour(now);
  const dates = recentDates(now, LOOKBACK_DAYS);
  const since = dates[dates.length - 1];

  // A schedule outage must not masquerade as a data outage: fall back to an
  // empty slate set and let the row say so, rather than reporting STALE.
  const [mlb, wnba] = await Promise.all([
    mlbSlates(dates).catch(() => null),
    wnbaSlates(dates).catch(() => null),
  ]);
  const slatesFor = { mlb, wnba };

  const rows = await Promise.all(SOURCES.map(async (src) => {
    try {
      const [sUrl, sKey] = credsFor(src);
      const present = await presentDates(sUrl, sKey, src, since);
      // Scope the timestamp lookup to the newest date we actually found.
      const newest = present ? [...present].sort().reverse()[0] : null;
      const lastTs = present && !newest
        ? null
        : await lastWrite(sUrl, sKey, src, newest);
      const slates = src.gated ? slatesFor[src.gated] : null;
      if (src.gated && !slates) {
        return [src.sport, src.label, src.cadence, null, lastTs, null,
          "UNKNOWN", "league schedule unreachable"];
      }
      const e = evaluate(src, slates, present, lastTs, now, today, hourET);
      return [src.sport, src.label, src.cadence, e.lastData, lastTs, e.ageH,
        e.status, e.detail];
    } catch (err) {
      return [src.sport, src.label, src.cadence, null, null, null,
        "ERROR", err.message];
    }
  }));

  return [...rows, ...(await watchdogRows(url, key, now))];
}

export const FRESHNESS_HEADER = ["sport", "source", "cadence", "last_data_date",
  "last_write_utc", "age_h", "status", "detail"];

/** Upsert one watchdog beacon. One row per pinger, overwritten forever. */
export async function stampWatchdog(url, key, source, status, detail) {
  const r = await fetch(`${url}/rest/v1/watchdog_pings?on_conflict=source`, {
    method: "POST",
    headers: {
      apikey: key, Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify([{
      source, status, detail,
      pinged_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }]),
  });
  if (!r.ok) throw new Error(`stamp ${source}: ${r.status} ${await r.text()}`);
}

/**
 * GET /api/cron?scope=watchdog — the pinger GitHub cannot silence.
 *
 * Driven by Supabase pg_cron (db/migrations/014) rather than Actions, on purpose:
 * when `schedule` delivery stopped account-wide on 2026-08-26, every watcher
 * that lived in Actions stopped with it. This one re-runs the same freshness
 * verdict the dashboard shows and stamps its own beacon, so the pair of beacons
 * answers both "is the data landing" and "is anything still looking".
 */
export async function handleWatchdog(req, res) {
  try {
    const url = getEnv("SUPABASE_URL");
    const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");
    const rows = await collectFreshness();
    // Grade the data sources only. Judging the beacons here would let this
    // pinger trip on the OTHER pinger being quiet and then report that as its
    // own finding — the dashboard already reads both rows directly.
    const stale = rows
      .filter((r) => !String(r[1]).startsWith("watchdog:"))
      .filter((r) => r[6] === "STALE" || r[6] === "ERROR")
      .map((r) => ({ label: r[1], status: r[6], detail: r[7] }));
    const status = stale.length ? "TRIPPED" : "OK";
    await stampWatchdog(url, key, "vercel_cron", status, { stale });
    res.status(200).json({ ok: true, scope: "watchdog", status, stale });
  } catch (error) {
    res.status(500).json({ error: error.message || "watchdog failed" });
  }
}

export async function handleFreshness(req, res) {
  try {
    const expectedKey = globalThis.process?.env?.APP_ACCESS_CODE;
    if (expectedKey) {
      // `key` query param for IMPORTDATA (which cannot send headers); the
      // X-Access-Code header for the app itself, so the dashboard's health
      // banner never has to put the access code in a URL.
      const provided = req.query?.key ?? req.headers?.["x-access-code"];
      const ok = typeof provided === "string" &&
        provided.trim().toLowerCase() === expectedKey.trim().toLowerCase();
      if (!ok) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
    }

    const rows = await collectFreshness();
    const wanted = req.query?.sport;
    const body = (wanted ? rows.filter((r) => r[0] === wanted) : rows);
    const csv = [FRESHNESS_HEADER.join(","), ...body.map((r) => r.map(csvField).join(","))]
      .join("\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    // Short TTL: this is the one feed whose whole job is being current, and
    // IMPORTDATA refetches roughly hourly anyway.
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
    res.status(200).send(csv);
  } catch (error) {
    res.status(500).json({ error: error.message || "freshness failed" });
  }
}
