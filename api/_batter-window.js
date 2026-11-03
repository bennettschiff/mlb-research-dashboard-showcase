/**
 * api/_batter-window.js — last-N-game Statcast window for EVERY batter, in one response.
 *
 * NOT ITS OWN ROUTE. The Hobby plan caps a deployment at 12 Serverless Functions and this
 * project sits exactly on that line, so shipping this as api/batter-window.js made a 13th and
 * failed every production deploy with exceeded_serverless_functions_per_deployment (2026-08-09,
 * dpl_6f6YDuPPXUPQebyXdLzpgeZ2iXCA). Vercel does not route files whose name starts with `_`,
 * so the logic lives here for free and api/advanced-stats.js delegates to it. That endpoint is
 * the right host rather than an arbitrary one: the season distributions below come from the
 * very tables it already serves. See .vercelignore for the same trap hit via a test file.
 *
 * GET /api/advanced-stats?season=2026&window=15
 *   → { season, games, asOf,
 *       batters:      { [mlbam_id]: { values, counts, games, firstDate, lastDate } },
 *       league:        { [metric]: number[] },  // ascending WINDOW values
 *       seasonLeague:  { [field]:  number[] },  // ascending SEASON values, all batters
 *       pitcherLeague: { [field]:  number[] } } // ascending SEASON values, all pitchers
 *
 * The two season distributions ride along rather than living in their own endpoint: the
 * boards need them on the same render as the window (a tile states a league percentile and
 * the window's shift from it), and all three are the same shape of cheap, day-stable,
 * whole-league reference data. One request, one cache entry.
 *
 * The props boards use this to mark which batters are trending away from their season
 * profile. It exists because the panel's route to a window — one ~165 KB statcast_search CSV
 * per batter — costs ~20 MB and ~130 requests for a full board. scripts/batter-window-refresh.mjs
 * caches a per-(batter, date) tally nightly; folding a date range here is a field-wise sum,
 * so the whole league costs one query.
 *
 * The fold is src/lib/recentWindow.js's own foldDayTallies + windowMetrics — the same pair
 * the panel uses — so a board's window and a panel's window for the same batter agree.
 *
 * READ THE NOISE TIERS BEFORE USING THIS. recentWindow.js's NOISE_RATIO records how far each
 * metric's window swings relative to real between-player spread, measured over 18,475
 * batter-days. barrel%/hard-hit%/BB% are at or near 1.0 — a 15-game value is mostly sampling
 * noise, and scripts/recent-form-lift.mjs found no predictive lift over season-to-date at any
 * window length. Callers must render window values as secondary context, never as a ranking
 * of who is "hot". The `tier` this endpoint does NOT compute is the caller's to apply via
 * noiseTier(metric, counts).
 */
import { foldDayTallies, windowMetrics, WINDOW_METRICS } from "../src/lib/recentWindow.js";
import { cacheGet, cacheSet } from "./_cache.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// A 15-game window is ~18 calendar days for a regular, but a platoon bat or an IL return can
// stretch it much further. 70 days covers those without unbounded paging; a batter whose
// window is still short simply reports fewer games and the caller's denominator floors
// (WINDOW_METRICS[m].floor) decide whether each row is drawable.
const LOOKBACK_DAYS = 70;
const TTL_SECONDS = 6 * 3600;

/**
 * BUMP THIS whenever the payload's shape or its inputs change (a new field, a different
 * MIN_PA, a changed fold).
 *
 * Deleting the api_cache row is NOT enough on its own: cacheGet's L1 tier lives in the
 * serverless instance's memory, so a warm Vercel instance keeps serving the old object for
 * the full TTL no matter what L2 says. On 2026-08-09 the MIN_PA qualification landed six
 * minutes after an entry was written, and production served league distributions built from
 * the UNFILTERED table (621 batters instead of 416) — through a purged L2 — until the key
 * changed. Versioning the key is the only eviction that reaches both tiers at once.
 */
const CACHE_VERSION = "v3-pit-izcontact";

/**
 * Season fields the boards rank tiles on. Every name here must exist in
 * batter_advanced_stats — a typo yields an all-null column, which sorts to an empty
 * distribution and silently renders every batter's percentile as "unknown" rather than
 * erroring. Cross-check against api/advanced-stats.js's BATTER_COLS when adding one.
 */
const SEASON_FIELDS = [
  "barrel_pct", "hard_hit_pct", "avg_exit_velo", "ev50", "la_sweet_spot_pct",
  "iso", "xiso", "xwoba", "xba", "xslg", "woba", "wrc_plus", "hr_fb_pct",
  "fb_pct", "gb_pct", "ld_pct", "pull_pct", "popup_pct", "solid_contact_pct",
  "k_pct", "bb_pct", "whiff_pct", "oz_swing_pct", "iz_contact_pct",
  "bat_speed", "swing_length", "blasts_per_swing", "squared_up_per_swing",
  "sprint_speed",
];

/** Season fields the Ks board's tiles rank on. Same contract as SEASON_FIELDS. */
const PITCHER_FIELDS = [
  "csw_pct", "whiff_pct", "chase_pct", "stf_plus", "loc_plus", "pit_plus",
  "siera", "fip", "xfip", "k_pct", "bb_pct", "k_bb_pct",
  "fastball_velo", "avg_spin_rate", "arm_angle",
  "barrel_pct", "hard_hit_pct", "xwoba", "gb_pct", "fb_pct",
  // Added 2026-08-11 for the Ks board's Zone Contact Allowed tile. Without it that tile
  // falls back to a rank within the ~15 starters on the slate, which reads like a league
  // standing it is not.
  "iz_contact_pct",
];

/**
 * Plate appearances a player needs before he counts toward a league distribution.
 *
 * Without this the tables' full population lands in the percentiles, and a September callup
 * with 3 batted balls contributes a 0% or 100% barrel rate. Measured on 2026-08-09: 14.2% of
 * batter barrel_pct values were exactly 0 and the field topped out at 100 — a distribution
 * shaped mostly by players nobody would rank. Savant applies its own qualification minimum
 * for the same reason, which is also why our empirical percentiles sit a few points off its
 * published ones (see the note in recentWindow.js's placeWindowValue).
 */
const MIN_PA = 100;

/** Ascending value arrays per field, nulls dropped — the shape empiricalPercentile expects. */
async function fetchLeague(table, fields, season) {
  const rows = [];
  // Keyset, not OFFSET — see fetchTallies for the measurement that motivated it.
  // mlbam_id is unique within a (table, season), so a single-column cursor is
  // both stable and exact here.
  let afterId = null;
  for (;;) {
    const page = await sbPage(
      `${table}?season=eq.${season}&pa=gte.${MIN_PA}&select=${["mlbam_id", "pa", ...fields].join(",")}` +
      (afterId == null ? "" : `&mlbam_id=gt.${afterId}`) +
      `&order=mlbam_id.asc&limit=1000`
    );
    rows.push(...page);
    if (page.length < 1000) break;
    afterId = page[page.length - 1].mlbam_id;
  }
  const out = {};
  for (const f of fields) {
    out[f] = rows.map(r => r[f]).filter(v => typeof v === "number" && Number.isFinite(v))
                 .sort((a, b) => a - b);
  }
  return out;
}

async function sbPage(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Supabase ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

/** POST a Postgres function through PostgREST. See fetchTallies for why. */
async function sbRpc(fn, args) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Supabase rpc ${fn} ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Page the whole date range, KEYSET rather than OFFSET.
 *
 * The order stays (mlbam_id, game_date) — paging over a non-unique sort is not
 * stable, so rows can repeat or vanish between pages and silently corrupt a fold
 * (the 2026-08-04 fix). That reasoning is unchanged; only the cursor is.
 *
 * WHY THE REWRITE. OFFSET does not skip rows, it FETCHES AND DISCARDS them, so
 * page N re-walks all N-1 pages before it. Measured 2026-08-29 against the live
 * table (40,973 rows for 2026, 41 pages), the LAST page alone cost:
 *
 *     OFFSET 39000 : 40,121 shared buffers, 2,413 ms   (walks 40,000 rows for 1,000)
 *     keyset       :  1,335 shared buffers,     8.5 ms
 *
 * — 30x the buffers and 284x the time, for identical output. Summed over the
 * sweep, OFFSET reads ~861,000 rows to return ~41,000: a 21x amplification that
 * pushed ~637 MB of buffer traffic through a 224 MB shared_buffers, flushing the
 * whole cache roughly three times per call. On a 0.5 GB Nano that is not a
 * slow query, it is the memory pressure itself — pg_stat_statements ranked these
 * two calls first and second on the instance, ahead of every blob table.
 *
 * The cursor is the full primary key (mlbam_id, game_date). A cursor on mlbam_id
 * ALONE would drop every remaining row of the player straddling a page boundary,
 * which is exactly the silent-fold-corruption bug the ordering comment above
 * exists to prevent.
 *
 * IT GOES THROUGH AN RPC ON PURPOSE. PostgREST can only spell the cursor as
 * `or=(a.gt.x,and(a.eq.x,b.gt.y))`, and Postgres plans that as a `Filter:`, not
 * an `Index Cond:` — so it still re-walks the index from the start of the range
 * on every page. Measured over a full 41-page sweep that cut buffers only
 * 864,822 → 746,233 (14%), nowhere near enough. Only the row-comparison form
 * `(a,b) > (x,y)` becomes an Index Cond and seeks straight to the cursor, at a
 * flat ~1,005 buffers per page however deep it is — ~41,000 for the sweep, a
 * ~21x reduction. SQL grammar, not query planning, is why this needs a function:
 * see db/migrations/015 for the three-way measurement.
 */
async function fetchTallies(season, since) {
  const out = [];
  let after = null; // { mlbam_id, game_date } — last row of the previous page
  for (;;) {
    const rows = await sbRpc("batter_day_tally_page", {
      p_season: season,
      p_since: since,
      p_after_id: after ? after.mlbam_id : null,
      p_after_date: after ? after.game_date : null,
      p_limit: 1000,
    });
    out.push(...rows);
    if (rows.length < 1000) break;
    after = rows[rows.length - 1];
  }
  return out;
}

/** Named, not default: this file is delegated to, never routed to directly. */
export async function batterWindowHandler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const season = parseInt(req.query.season || "2026", 10);
  // `window` is the caller-facing name on the shared route; `games` stays accepted so the
  // endpoint can still be exercised directly with the name the payload itself reports.
  const games = Math.max(1, Math.min(60,
    parseInt(req.query.window || req.query.games || "15", 10)));

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=7200");

  const cacheKey = `batter-window:${CACHE_VERSION}:${season}:${games}`;
  try {
    // The cache stores STRINGS — api_cache.data is a text column, so an object handed to
    // cacheSet comes back out as its JSON text. Every other consumer stringifies on write and
    // parses on read (see api/odds.js); skipping that shipped a payload that was a JSON
    // *string* rather than an object, and the boards silently got no window.
    //
    // It survived local testing because cacheGet's L1 tier hands back the exact value passed
    // to cacheSet: within one warm process the object round-trips intact, and only a cold
    // instance reading L2 sees the text. Production is always that cold instance.
    const hit = await cacheGet(cacheKey, TTL_SECONDS);
    if (hit) return res.status(200).json(typeof hit === "string" ? JSON.parse(hit) : hit);
  } catch { /* a miss, or an unparseable entry, just falls through to a rebuild */ }

  try {
    const since = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10);
    const [rows, seasonLeague, pitcherLeague] = await Promise.all([
      fetchTallies(season, since),
      fetchLeague("batter_advanced_stats", SEASON_FIELDS, season),
      fetchLeague("pitcher_advanced_stats", PITCHER_FIELDS, season),
    ]);

    const byBatter = new Map();
    for (const r of rows) {
      let days = byBatter.get(r.mlbam_id);
      if (!days) { days = []; byBatter.set(r.mlbam_id, days); }
      days.push({ date: r.game_date, tally: r.tally });
    }

    const batters = {};
    let asOf = null;
    for (const [id, days] of byBatter) {
      const folded = foldDayTallies(days, games);
      if (!folded) continue;
      const m = windowMetrics(folded);
      if (!m?.games) continue;
      batters[id] = m;
      if (!asOf || m.lastDate > asOf) asOf = m.lastDate;
    }

    // League distribution of the WINDOW values themselves, ascending. The caller places a
    // batter's window against the season distribution (placeWindowValue), so this is only
    // for "how unusual is this window" reads — it is not a season percentile.
    const league = {};
    for (const metric of Object.keys(WINDOW_METRICS)) {
      const floor = WINDOW_METRICS[metric].floor;
      const den = WINDOW_METRICS[metric].den;
      const vals = [];
      for (const m of Object.values(batters)) {
        const v = m.values[metric];
        // Below the denominator floor the value is not a measurement, and letting it into
        // the distribution would drag the percentiles every other batter is placed against.
        if (v != null && (m.counts[den] ?? 0) >= floor) vals.push(v);
      }
      league[metric] = vals.sort((a, b) => a - b);
    }

    const payload = {
      season, games, asOf, count: Object.keys(batters).length,
      batters, league, seasonLeague, pitcherLeague,
    };
    // AWAITED, not fire-and-forget. A serverless instance can be frozen the moment the
    // response flushes, so a dangling promise after res.json() is not guaranteed to run —
    // observed here as a cache that never persisted: production served correct data but
    // wrote no api_cache row, so every cold instance re-paged ~25k tally rows plus both
    // league tables against an IO-contended shared Supabase. api/odds.js awaits for the
    // same reason. cacheSet swallows its own errors, so this cannot fail the request; it
    // only adds the write's latency to the miss path.
    // Stringify on write to match how it is read back — see the cacheGet note above.
    await cacheSet(cacheKey, JSON.stringify(payload), TTL_SECONDS);
    return res.status(200).json(payload);
  } catch (err) {
    console.error("[batter-window]", err);
    return res.status(500).json({ error: err.message });
  }
}
