/**
 * scripts/_lab.mjs — connection details for the two Supabase projects.
 *
 * The free plan allows 2 active projects at 500 MB each, and one of them had reached 91.6%
 * of that cap on a 0.5 GB Nano whose working set no longer fit in RAM — the standing
 * condition behind the 2026-08-11 OOM wedge. So the data is split by ACCESS PATTERN, not by
 * sport (splitting by sport buys nothing: MLB is 99.3% of the bytes):
 *
 *   SERVE — anything a page render or a pick save touches. The default client; every script
 *           that does not import from here already uses it via SUPABASE_URL.
 *   LAB   — the analysis substrate, read in batch by the lab/mining jobs:
 *           player_day_features, mining_findings, batter_asof_features, pitcher_asof_features.
 *
 * Underscore prefix so this is never mistaken for a runnable script (same convention as api/).
 *
 * A script that reads BOTH (mining-engine.mjs wants player_day_features from LAB and
 * mining_signal_history from SERVE) should import both helpers and keep the two clients
 * visibly distinct — do not let one variable named `SB_URL` quietly mean different projects
 * in different functions.
 */

function need(name) {
  const v = process.env[name];
  if (!v) {
    console.error(
      `Missing ${name}.\n` +
        `  Local: add it to .env.local and run with --env-file=.env.local\n` +
        `  CI:    add it as a repo secret and map it in the workflow's env: block`
    );
    process.exit(1);
  }
  return v;
}

/** The research project. Batch reads only — never put a page-render dependency here. */
export function labDb() {
  const url = need("LAB_SUPABASE_URL");
  const key = need("LAB_SUPABASE_SERVICE_ROLE_KEY");
  return {
    url,
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  };
}

/** The serving project. */
export function serveDb() {
  const url = need("SUPABASE_URL");
  const key = need("SUPABASE_SERVICE_ROLE_KEY");
  return {
    url,
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  };
}

/** Tables that live on LAB. Everything not listed here is on SERVE. */
export const LAB_TABLES = new Set([
  "mining_findings",
  "player_day_features",
  "batter_asof_features",
  "pitcher_asof_features",
  // Derived cache of mining-cron's flattened feature vectors (db/migrations/018).
  // Lives with the findings it feeds, not with the pick_signals it is built from.
  "pick_feature_matrix",
  "pick_feature_schema",
]);

/**
 * Pick the project for a PostgREST path by reading the TABLE NAME off the front of it.
 *
 * This exists because hand-classifying call sites does not scale and is not safe. Twenty-odd
 * scripts touch the moved tables, and several of them touch moved AND unmoved tables in the
 * same file — mining-cron writes mining_findings on LAB while mining pick_signals on SERVE;
 * findings-digest reads findings from LAB and mlb_picks from SERVE. Two greps missed those
 * because the table name is assembled into a template string and handed to a helper.
 *
 * Routing on the path means a script only has to change the ONE place it builds a request,
 * and every call site in it — including ones nobody re-read during the migration — lands on
 * the right project automatically. Add a table to LAB_TABLES and every caller follows.
 *
 *   const { url, headers } = dbForPath(path);
 *   fetch(`${url}/rest/v1/${path}`, { headers });
 */
export function dbForPath(path) {
  const table = String(path).split(/[?/&#]/)[0].trim();
  return LAB_TABLES.has(table) ? labDb() : serveDb();
}
