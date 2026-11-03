/**
 * api/running-game.js — stolen-base running-game signals from Supabase.
 *
 * GET /api/running-game?season=2026
 *   → { season, catchers:[], pitchers:[], batters:[] }
 *   → Used at scan start as a DB fallback when the live Baseball Savant CSVs fail.
 *
 * Tables: catcher_throwing, pitcher_running_game, basestealing_run_value.
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

  const { season = "2026" } = req.query;
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=7200");

  try {
    const [catchers, pitchers, batters] = await Promise.all([
      sbRequest(`catcher_throwing?season=eq.${season}&select=mlbam_id,team,player_name,sb_attempts,pop_time,exchange_time,arm_strength,est_cs_pct,cs_aa_per_throw,cs_above_avg,catcher_stealing_runs&limit=2000`),
      sbRequest(`pitcher_running_game?season=eq.${season}&select=mlbam_id,team,player_name,n_init,n_sb,n_cs,n_pk,rate_sbx,runs_prevented,primary_lead,secondary_lead,sec_minus_prim_lead&limit=2000`),
      sbRequest(`basestealing_run_value?season=eq.${season}&select=mlbam_id,team,player_name,n_init,n_sb,n_cs,n_pk,rate_sbx,runs_stolen,primary_lead,secondary_lead,sec_minus_prim_lead&limit=2000`),
    ]);

    return res.status(200).json({
      season: parseInt(season),
      catchers: catchers || [],
      pitchers: pitchers || [],
      batters: batters || [],
    });
  } catch (err) {
    console.error("[running-game]", err);
    return res.status(500).json({ error: err.message });
  }
}
