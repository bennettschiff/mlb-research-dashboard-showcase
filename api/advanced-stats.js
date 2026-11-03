/**
 * api/advanced-stats.js — FanGraphs + Statcast advanced metrics from Supabase
 *
 * GET /api/advanced-stats?season=2026
 *   → Returns bulk advanced stats for all batters + pitchers for the season.
 *   → Used at scan start to build lookup maps keyed by mlbam_id.
 *
 * GET /api/advanced-stats?season=2026&type=batter&mlbam_id=12345
 * GET /api/advanced-stats?season=2026&type=pitcher&mlbam_id=12345
 *   → Individual player lookup for BatterPanel / PitcherPanel display.
 *
 * NOTE: the bulk selects are EXPLICIT column lists — see BATTER_COLS / PITCHER_COLS
 * below, which are the single source of truth. Any new column that src/lib/models.js
 * reads off advancedStats/pitAdvStats must be added there too, or the term is silently
 * dead on every scan pick (killed HR fbRateMult until 2026-07-13; killed rawOppoPct
 * capture until 2026-07-21).
 *
 * 2026-07-31: both lists expanded substantially. The audit found 54 of 98 fetched Savant
 * columns were being discarded at the ETL row builder, including the pitcher's entire
 * contact-quality profile and his whole secondary arsenal. Those now land in the tables
 * and are selected here, so the model layer can reach them. `hard_pct` was dropped from
 * the batter list: it was written from the same source as `hard_hit_pct` and was
 * byte-identical on all 609 rows.
 */
import { batterWindowHandler } from "./_batter-window.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Explicit column lists, hoisted out of the request handler so there is ONE place to
// edit when a column is added. Inlined in the template literal they were easy to skim
// past, which is how fb_pct stayed dead for two months and oppo_pct for one.
//
// The rule: if src/lib/models.js reads a field off advancedStats / pitAdvStats, it MUST
// appear here. A missing name doesn't error — the property is simply undefined and the
// term silently evaluates to its no-op default on every scan pick.
const BATTER_COLS = [
  "mlbam_id",
  // rate + expected stats
  "wrc_plus", "iso", "babip", "hr_fb_pct", "k_pct", "bb_pct",
  "xwoba", "xba", "xslg", "xiso", "xobp", "woba", "obp",
  // batted-ball profile
  "fb_pct", "gb_pct", "ld_pct", "popup_pct", "pull_pct", "oppo_pct", "straightaway_pct",
  // contact quality — the full six-way partition, not just the barrel tail (landed 2026-07-31)
  "barrel_pct", "solid_contact_pct", "flareburner_pct",
  "poorly_under_pct", "poorly_topped_pct", "poorly_weak_pct",
  "hard_hit_pct", "avg_exit_velo", "ev50", "ev_adjusted",
  "launch_angle_avg", "la_sweet_spot_pct",
  // plate discipline
  "oz_swing_pct", "z_swing_pct", "swing_pct", "iz_contact_pct", "oz_contact_pct",
  "whiff_pct", "edge_pct", "f_strike_pct", "meatball_pct", "meatball_swing_pct",
  // swing geometry + bat tracking. These were absent from the bulk select entirely, so
  // the DB copies were invisible to the scan; the live model got them from a per-scan
  // Savant CSV instead. Selected here so the two sources can be reconciled.
  "attack_angle", "attack_direction", "swing_path_tilt", "ideal_attack_angle_rate",
  "bat_speed", "swing_length", "blasts_per_swing", "fast_swing_rate", "squared_up_per_swing",
  // speed
  "sprint_speed",
  // display-only percentile ranks
  "xwoba_rank", "barrel_rank", "sprint_rank", "hard_hit_rank",
].join(",");

const PITCHER_COLS = [
  "mlbam_id",
  // run prevention + strikeout axis
  "siera", "fip", "xfip", "k_pct", "bb_pct", "k_bb_pct", "csw_pct",
  "whiff_pct", "chase_pct",
  // CONTACT ALLOWED — landed 2026-07-31. Every batter market was previously modelled
  // against the strikeout axis alone; these describe what happens when the ball is hit.
  "barrel_pct", "hard_hit_pct", "avg_exit_velo", "launch_angle_avg",
  "xwoba", "xba", "xslg", "xiso", "woba", "batting_avg", "slg_pct", "obp",
  "gb_pct", "fb_pct", "ld_pct", "popup_pct", "pull_pct", "oppo_pct",
  "z_swing_pct", "iz_contact_pct", "oz_contact_pct", "swing_pct", "meatball_swing_pct",
  // stuff, command, release geometry
  "stf_plus", "loc_plus", "pit_plus", "fastball_velo", "avg_spin_rate", "arm_angle",
  "edge_pct", "f_strike_pct", "meatball_pct",
  // the secondary arsenal — velocity separation needs these
  "sl_velo", "sl_spin", "ch_velo", "cu_velo", "si_velo", "fc_velo",
  // display-only percentile ranks
  "k_pct_rank", "bb_pct_rank", "whiff_rank", "fastball_velo_rank",
].join(",");

async function sbRequest(path) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const res = await fetch(url, {
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

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // ?window=15 → the props boards' Statcast reference bundle (every batter's last-N-game
  // window plus the batter/pitcher season distributions). It rides this route rather than
  // its own because the Hobby plan caps a deployment at 12 Serverless Functions and this
  // project sits exactly on that line — a 13th file in api/ fails the deploy outright.
  // The logic is in api/_batter-window.js; `_`-prefixed files are not routed, so it is free.
  if (req.query.window != null) {
    return batterWindowHandler(req, res);
  }

  const { season = "2026", type, mlbam_id } = req.query;

  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=7200");

  try {
    // Individual player lookup
    if (mlbam_id && type) {
      const table = type === "pitcher" ? "pitcher_advanced_stats" : "batter_advanced_stats";
      const data = await sbRequest(
        `${table}?mlbam_id=eq.${mlbam_id}&season=eq.${season}&limit=1`
      );
      return res.status(200).json({ data: data[0] || null });
    }

    // Bulk fetch for scan — both tables in parallel
    const [batters, pitchers] = await Promise.all([
      sbRequest(`batter_advanced_stats?season=eq.${season}&select=${BATTER_COLS}&limit=1000`),
      sbRequest(`pitcher_advanced_stats?season=eq.${season}&select=${PITCHER_COLS}&limit=1000`),
    ]);

    return res.status(200).json({
      season: parseInt(season),
      batters: batters || [],
      pitchers: pitchers || [],
    });
  } catch (err) {
    console.error("[advanced-stats]", err);
    return res.status(500).json({ error: err.message });
  }
}
