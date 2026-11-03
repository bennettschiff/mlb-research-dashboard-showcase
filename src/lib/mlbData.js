// MLB Stats API / Baseball Savant fetchers shared by BatterPanel, PitcherPanel
// and the props scan (moved out of App.jsx 2026-10-06 with the BatterPanel
// extraction). _textCache is module-level so every Savant CSV is still fetched
// once per tab no matter which caller asks first.
import { API, fetchJson } from './utils.js';
import { dedupeSplitRows } from './splits.js';

// TEAM_COLORS / getTeamColor moved to src/lib/utils.js (2026-07-06 PropsBoard extraction).

// Text (CSV) cache — Savant bulk CSVs are the same URL for all players, so cache the raw text
// to avoid fetching the same 2MB CSV 30 times per scan.
const _textCache = new Map();

export async function fetchText(url, timeoutMs = 15000) {
  if (_textCache.has(url)) return _textCache.get(url);
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    const text = await r.text();
    _textCache.set(url, text);
    return text;
  } finally {
    clearTimeout(tid);
  }
}

export function _normPropName(name) {
  return (name || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z]/g, "");
}

export async function getGameLog(personId, season, group = "hitting", limit = 15) {
  const mlbUrl = `${API}/people/${personId}?hydrate=stats(group=[${group}],type=[gameLog],season=${season})`;
  const d = await fetchJson(`/api/proxy?url=${encodeURIComponent(mlbUrl)}&ttl=7200`);
  const splits = d?.people?.[0]?.stats?.find(s => s.type?.displayName === "gameLog")?.splits || [];
  return [...splits].reverse().slice(0, limit);
}

export async function getSeasonStats(personId, season, group = "hitting") {
  const d = await fetchJson(`${API}/people/${personId}?hydrate=stats(group=[${group}],type=[season],season=${season})`);
  return d?.people?.[0]?.stats?.find(s => s.type?.displayName === "season")?.splits?.[0]?.stat || {};
}

export async function getSplits(personId, sitCodes, season, group = "hitting") {
  const d = await fetchJson(`${API}/people/${personId}/stats?stats=statSplits&season=${season}&group=${group}&sitCodes=${sitCodes}`);
  // Traded players get one row per team per sitCode plus a combined season row —
  // collapse to the season line so tables don't repeat "vs LHB" and `.find()`
  // consumers don't read a single stint's partial split. See src/lib/splits.js.
  return dedupeSplitRows(d?.stats?.[0]?.splits || []);
}

export async function getVsPitcher(batterId, pitcherId, season) {
  const d = await fetchJson(`${API}/people/${batterId}?hydrate=stats(group=[hitting],type=[vsPlayer,vsPlayerTotal],opposingPlayerId=${pitcherId},season=${season})`);
  const stats = d?.people?.[0]?.stats || [];
  return {
    season: stats.find(s => s.type?.displayName === "vsPlayer")?.splits || [],
    career: stats.find(s => s.type?.displayName === "vsPlayerTotal")?.splits || [],
  };
}

export async function getPlayerBio(personId) {
  // No fields restriction — truncated fields param strips nested .code from batSide/pitchHand
  const d = await fetchJson(`${API}/people/${personId}`);
  const p = d?.people?.[0];
  return p ? {
    birthDate: p.birthDate || null,
    birthCity: p.birthCity || null,
    birthState: p.birthStateProvince || null,
    batSide: p.batSide || null,     // { code: "L"/"R"/"S" }
    pitchHand: p.pitchHand || null, // { code: "L"/"R" }
    primaryNumber: p.primaryNumber || null, // jersey #
  } : null;
}

// Pitch arsenal: SwStr% & usage per pitch type (MLB Stats API pitchArsenal type)
export async function getPitchArsenal(pitcherId, season) {
  try {
    const d = await fetchJson(`${API}/people/${pitcherId}?hydrate=stats(group=[pitching],type=[pitchArsenal],season=${season})`);
    const stats = d?.people?.[0]?.stats || [];
    const s = stats.find(s => s.type?.displayName === "pitchArsenal");
    return s?.splits || [];
  } catch { return []; }
}

// Simple CSV parser that handles quoted fields (e.g. "last_name, first_name")
export function parseCSVText(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  const rawHeaders = [];
  let cur = '', inQ = false;
  for (const ch of lines[0]) {
    if (ch === '"') { inQ = !inQ; }
    else if (ch === ',' && !inQ) { rawHeaders.push(cur.trim()); cur = ''; }
    else { cur += ch; }
  }
  rawHeaders.push(cur.trim());
  return lines.slice(1).map(line => {
    const vals = []; cur = ''; inQ = false;
    for (const ch of line) {
      if (ch === '"') { inQ = !inQ; }
      else if (ch === ',' && !inQ) { vals.push(cur); cur = ''; }
      else { cur += ch; }
    }
    vals.push(cur);
    const obj = {};
    rawHeaders.forEach((h, i) => { obj[h] = vals[i] ?? ''; });
    return obj;
  });
}

// Baseball Savant batter vs pitch type stats
// Returns { "FF": { ba, slg, woba, xba, xslg, xwoba, whiff, hardHit, kPct, putAway, rv100, pitches, pa }, ... }
export async function getStatcastBatterVsPitch(batterId, year) {
  try {
    const url = `https://baseballsavant.mlb.com/leaderboard/pitch-arsenal-stats?type=batter&pitchType=&year=${year}&run_value_type=per100&min=1&csv=true`;
    // 2026-06: avg_speed vanished from this CSV, so the batter-specific "avg velocity
    // of pitches faced" is gone. Fall back to the league-average velocity for the
    // pitch type (from the cached pitcher custom CSV) — within ~0.5 mph of the
    // batter-specific number for all but extreme schedules.
    const [text, { lgAvg: pitLgAvg }] = await Promise.all([
      fetchText(url),
      _getPitcherStatcastCsv(year),
    ]);
    const rows = parseCSVText(text);
    const map = {};
    for (const row of rows) {
      if (row.player_id !== String(batterId)) continue;
      const _veloCol = PITCH_TYPE_TO_CUSTOM_COL[row.pitch_type];
      map[row.pitch_type] = {
        pa:       parseInt(row.pa) || 0,
        pitches:  parseInt(row.pitches) || 0,
        ba:       parseFloat(row.ba) || null,
        slg:      parseFloat(row.slg) || null,
        woba:     parseFloat(row.woba) || null,
        xba:      parseFloat(row.est_ba) || null,
        xslg:     parseFloat(row.est_slg) || null,
        xwoba:    parseFloat(row.est_woba) || null,
        whiff:    parseFloat(row.whiff_percent) || 0,
        kPct:     parseFloat(row.k_percent) || 0,
        putAway:  parseFloat(row.put_away) || 0,
        hardHit:  parseFloat(row.hard_hit_percent) || 0,
        rv100:    row.run_value_per_100 !== '' ? parseFloat(row.run_value_per_100) : null,
        avgVel:   _veloCol ? (parseFloat(pitLgAvg[`${_veloCol}_avg_speed`]) || null) : null,  // league-avg velocity for this pitch type (batter-specific column removed upstream)
      };
    }
    return map;
  } catch { return {}; }
}

// Hand-split batter-vs-pitch: same shape as getStatcastBatterVsPitch but split by the
// OPPOSING pitcher's throwing hand (vs LHP / vs RHP). The pitch-arsenal-stats leaderboard
// CSV silently ignores every hand param, so we aggregate event-level Statcast Search data
// ourselves. RV/100 is a Savant-internal model not in the event feed, so it is returned null.
// pitchHand = "L" | "R". Returns { pitchType → { pa, pitches, ba, slg, xslg, woba, xwoba,
//   whiff, kPct, putAway, hardHit, rv100:null, avgVel } }.
export async function getStatcastBatterVsPitchByHand(batterId, year, pitchHand) {
  try {
    const hand = pitchHand === "L" ? "L" : "R";
    const url = `https://baseballsavant.mlb.com/statcast_search/csv?all=true&type=details&player_type=batter&hfSea=${year}%7C&batters_lookup%5B%5D=${batterId}&pitcher_throws=${hand}&min_pitches=0&group_by=name`;
    const text = await fetchText(url);
    const rows = parseCSVText(text);
    const HIT_TB = { single: 1, double: 2, triple: 3, home_run: 4 };
    const SWINGS = new Set(["swinging_strike", "swinging_strike_blocked", "foul", "foul_tip", "hit_into_play", "missed_bunt", "foul_bunt", "bunt_foul_tip"]);
    const WHIFFS = new Set(["swinging_strike", "swinging_strike_blocked", "missed_bunt"]);
    // Terminal events: count AB / PA directly (deriving AB from woba_denom mislabels ROE/DP edge cases)
    const AB_OUTS = new Set(["field_out", "force_out", "grounded_into_double_play", "double_play", "triple_play", "fielders_choice", "fielders_choice_out", "field_error", "strikeout", "strikeout_double_play", "other_out"]);
    const NON_AB_PA = new Set(["walk", "intent_walk", "hit_by_pitch", "sac_fly", "sac_fly_double_play", "sac_bunt", "sac_bunt_double_play", "catcher_interf"]);
    const agg = {};
    for (const r of rows) {
      const pt = r.pitch_type;
      if (!pt) continue;
      let a = agg[pt];
      if (!a) a = agg[pt] = { pitches: 0, velSum: 0, velN: 0, swings: 0, whiffs: 0,
        twoStrike: 0, k: 0, ab: 0, pa: 0, hits: 0, tb: 0,
        bbe: 0, hardHit: 0, wobaNum: 0, wobaDen: 0, xwobaNum: 0, xslgNum: 0 };
      a.pitches++;
      const rel = parseFloat(r.release_speed);
      if (!isNaN(rel)) { a.velSum += rel; a.velN++; }
      const desc = r.description;
      if (SWINGS.has(desc)) a.swings++;
      if (WHIFFS.has(desc)) a.whiffs++;
      if (parseInt(r.strikes) === 2) a.twoStrike++;
      if (desc === "hit_into_play") {
        const ls = parseFloat(r.launch_speed);
        if (!isNaN(ls)) { a.bbe++; if (ls >= 95) a.hardHit++; }
        const xslgVal = parseFloat(r.estimated_slg_using_speedangle);
        if (!isNaN(xslgVal)) a.xslgNum += xslgVal;
      }
      // wOBA (exact) + xwOBA (batted balls use estimated value, others use actual)
      const wd = parseFloat(r.woba_denom);
      if (!isNaN(wd) && wd > 0) {
        const wv = parseFloat(r.woba_value) || 0;
        a.wobaNum += wv; a.wobaDen += wd;
        const xw = parseFloat(r.estimated_woba_using_speedangle);
        a.xwobaNum += (!isNaN(xw) ? xw : wv);
      }
      const ev = r.events;
      if (ev) {
        if (HIT_TB[ev] != null) { a.hits++; a.tb += HIT_TB[ev]; a.ab++; a.pa++; }
        else if (AB_OUTS.has(ev)) { a.ab++; a.pa++; if (ev === "strikeout" || ev === "strikeout_double_play") a.k++; }
        else if (NON_AB_PA.has(ev)) a.pa++;
        // runner-only events (caught_stealing, pickoff, stolen_base, wild_pitch, …) are not PAs
      }
    }
    const out = {};
    for (const [pt, a] of Object.entries(agg)) {
      const ab = a.ab, pa = a.pa;
      out[pt] = {
        pitches: a.pitches,
        pa: Math.round(pa),
        ba:    ab > 0 ? a.hits / ab : null,
        slg:   ab > 0 ? a.tb / ab : null,
        xslg:  ab > 0 ? a.xslgNum / ab : null,
        woba:  a.wobaDen > 0 ? a.wobaNum / a.wobaDen : null,
        xwoba: a.wobaDen > 0 ? a.xwobaNum / a.wobaDen : null,
        whiff: a.swings > 0 ? (a.whiffs / a.swings) * 100 : 0,
        kPct:  pa > 0 ? (a.k / pa) * 100 : 0,
        putAway: a.twoStrike > 0 ? (a.k / a.twoStrike) * 100 : 0,
        hardHit: a.bbe > 0 ? (a.hardHit / a.bbe) * 100 : 0,
        rv100: null,  // not derivable from the event feed
        avgVel: a.velN > 0 ? a.velSum / a.velN : null,
      };
    }
    return out;
  } catch { return {}; }
}

// Baseball Savant Statcast pitch-level metrics: whiff%, put-away%, K%, run value/100, velo, usage
// Returns { "FF": { whiff, putAway, kPct, rv100, velo, usage }, ... }
// Pitch type → custom-leaderboard wide-column prefix. Savant's custom CSV folds
// curve variants (KC knuckle-curve, CS slow curve) into the `cu_*` columns.
export const PITCH_TYPE_TO_CUSTOM_COL = {
  FF: "ff", SI: "si", FC: "fc", SL: "sl", CH: "ch",
  CU: "cu", KC: "cu", CS: "cu", FS: "fs", FO: "fo",
  SC: "sc", KN: "kn", ST: "st", SV: "sv",
};

// Plate discipline stats from Baseball Savant custom leaderboard
// type: "batter" | "pitcher"
// The plate-discipline custom leaderboard is league-wide and identical for every
// player of a given (type, year) — only the row lookup differs. Without caching, the
// scan refetched + reparsed this whole-league CSV once per batter AND per pitcher
// (~250 identical requests/slate), which tripped Savant rate-limiting and stalled the
// scan at "0/216". Promise-cache the parsed rows per (type, year) so the slate costs
// one fetch, mirroring _getPitcherStatcastCsv below.
const _plateDisciplineCsvCache = new Map(); // `${type}|${year}` → Promise<rows[]>
function _getPlateDisciplineCsv(year, type) {
  const key = `${type}|${year}`;
  if (_plateDisciplineCsvCache.has(key)) return _plateDisciplineCsvCache.get(key);
  const p = (async () => {
    const fields = type === "pitcher"
      ? "f_strike_percent,z_swing_percent,oz_swing_percent,iz_contact_percent,oz_contact_percent,whiff_percent,edge_percent,meatball_percent,meatball_swing_percent"
      : "f_strike_percent,z_swing_percent,oz_swing_percent,iz_contact_percent,oz_contact_percent,whiff_percent";
    const url = `https://baseballsavant.mlb.com/leaderboard/custom?year=${year}&type=${type}&filter=&min=1&selections=${fields}&csv=true`;
    try { return parseCSVText(await fetchText(url)); } catch { return []; }
  })();
  _plateDisciplineCsvCache.set(key, p);
  return p;
}

export async function getPlateDiscipline(playerId, year, type = "batter") {
  try {
    const rows = await _getPlateDisciplineCsv(year, type);
    const row = rows.find(r => String(r.player_id) === String(playerId));
    if (!row) return null;
    return {
      fStrike:      parseFloat(row.f_strike_percent) || null,
      zSwing:       parseFloat(row.z_swing_percent) || null,
      ozSwing:      parseFloat(row.oz_swing_percent) || null,
      izContact:    parseFloat(row.iz_contact_percent) || null,
      ozContact:    parseFloat(row.oz_contact_percent) || null,
      whiff:        parseFloat(row.whiff_percent) || null,
      edge:         parseFloat(row.edge_percent) || null,
      meatball:     parseFloat(row.meatball_percent) || null,
      meatballSwing:parseFloat(row.meatball_swing_percent) || null,
    };
  } catch { return null; }
}

// Pitcher Statcast quality-of-contact profile: xERA, xwOBA, Whiff%, HardHit%, Barrel%, K%, BB%
// Single-fetch cache for the pitcher custom-leaderboard CSV — keyed by season.
// Scan code calls getPitcherStatcast() once per pitcher in the slate; sharing the
// parsed CSV across calls turns N network round-trips into 1.
const _pitStatcastCsvCache = {};   // season → Promise<{ rows, lgAvg }>  (promise-cached: concurrent batch jobs share one in-flight fetch instead of racing)
export function _getPitcherStatcastCsv(season) {
  if (!_pitStatcastCsvCache[season]) _pitStatcastCsvCache[season] = _loadPitcherStatcastCsv(season);
  return _pitStatcastCsvCache[season];
}

async function _loadPitcherStatcastCsv(season) {
  try {
    // Savant field naming is inconsistent: batted-ball type uses `groundballs_percent`
    // (not `gb_percent`), quality-of-contact uses `poorlyweak_percent` (not `weak_percent`).
    // Verified empirically against the live CSV: short forms return null for every pitcher.
    // 2026-06 schema drift: `p_k_percent`/`p_bb_percent` selections now return empty for
    // every pitcher and every year — the live names are `k_percent`/`bb_percent`.
    // `release_extension` was removed from the custom leaderboard entirely (no alias
    // works); extension now comes from getPitcherExtension (statcast_search).
    // `<pt>_avg_speed`/`<pt>_avg_spin` per-pitch-type columns replace the avg_speed/
    // avg_spin columns that vanished from the pitch-arsenal-stats CSV.
    const PITCH_TYPE_COLS = ["ff","si","fc","sl","ch","cu","fs","fo","sc","kn","st","sv"]
      .flatMap(pt => [`${pt}_avg_speed`, `${pt}_avg_spin`]);
    const lgKeys = [
      "xera","xba","xslg","xwoba",
      "whiff_percent","oz_swing_percent","k_percent","bb_percent",
      "hard_hit_percent","barrel_batted_rate","exit_velocity_avg","launch_angle_avg",
      "pull_percent","straightaway_percent","opposite_percent",
      "groundballs_percent","flyballs_percent","linedrives_percent","popups_percent",
      "poorlyweak_percent","poorlytopped_percent","poorlyunder_percent","flareburner_percent","solidcontact_percent",
      ...PITCH_TYPE_COLS,
    ];
    const url = `https://baseballsavant.mlb.com/leaderboard/custom?year=${season}&type=pitcher&filter=&min=1&selections=${lgKeys.join(",")}&csv=true`;
    const text = await fetchText(url);
    const rows = parseCSVText(text);
    const lgAvg = {};
    for (const k of lgKeys) {
      let s = 0, n = 0;
      for (const r of rows) {
        const v = parseFloat(r[k]);
        if (!isNaN(v)) { s += v; n++; }
      }
      lgAvg[k] = n > 0 ? s / n : null;
    }
    return { rows, lgAvg };
  } catch { return { rows: [], lgAvg: {} }; }
}

// Batter Statcast power profile: barrel%, hard hit%, exit velo, launch angle, xBA
export async function getBatterPowerStats(batterId, season) {
  const tryYear = async (yr) => {
    const [customText, batText] = await Promise.all([
      fetchText(`https://baseballsavant.mlb.com/leaderboard/custom?year=${yr}&type=batter&filter=&sort=4&sortDir=desc&min=10&selections=exit_velocity_avg%2Claunch_angle_avg%2Cbarrel_batted_rate%2Chard_hit_percent%2Cxba%2Cxwoba%2Cwoba%2Cbb_percent%2Ck_percent%2Cwhiff_percent%2Coz_swing_percent&csv=true`),
      fetchText(`https://baseballsavant.mlb.com/leaderboard/bat-tracking?year=${yr}&team=&min_pa=1&csv=true`).catch(() => ""),
    ]);
    const rows = parseCSVText(customText);
    const row = rows.find(r => String(r.player_id) === String(batterId));
    if (!row) return null;
    const batRows = batText ? parseCSVText(batText) : [];
    // bat-tracking CSV keys its player column `id` (not `player_id` like the custom
    // leaderboard). Matching on player_id silently found nothing → every bat-tracking
    // field was null regardless of column name. Verified against the live CSV.
    const batRow = batRows.find(r => String(r.id) === String(batterId));
    const numOrNull = (v) => { const n = parseFloat(v); return isNaN(n) ? null : n; };
    return {
      exitVelo:      parseFloat(row.exit_velocity_avg)   || null,
      launchAngle:   parseFloat(row.launch_angle_avg)    || null,
      barrelRate:    parseFloat(row.barrel_batted_rate)  || null,
      hardHitPct:    parseFloat(row.hard_hit_percent)    || null,
      xba:           parseFloat(row.xba)                 || null,
      xwoba:         parseFloat(row.xwoba)               || null,
      woba:          parseFloat(row.woba)                || null,
      // Plate discipline rates (use numOrNull — 0 is a valid value, || null would drop it)
      bbPct:         numOrNull(row.bb_percent),
      kPct:          numOrNull(row.k_percent),
      whiffPct:      numOrNull(row.whiff_percent),
      chasePct:      numOrNull(row.oz_swing_percent),
      // Bat-tracking (2024+) — direct swing measurement, strongest HR predictor.
      // Savant renamed these CSV columns: bat_speed→avg_bat_speed,
      // blasts_per_swing→blast_per_swing, fast_swing_rate→hard_swing_rate. Reading
      // the old names silently returned null, killing the bat-speed/blasts terms in
      // the HR/TB/HRR power models. numOrNull (not || null) — 0 is valid for rates.
      batSpeed:            batRow ? numOrNull(batRow.avg_bat_speed)              : null,
      swingLength:         batRow ? numOrNull(batRow.swing_length)              : null,
      blastsPerSwing:      batRow ? numOrNull(batRow.blast_per_swing)           : null,
      fastSwingRate:       batRow ? numOrNull(batRow.hard_swing_rate)           : null,
      // New bat-tracking axes — squared-up is the genuinely novel signal (blast =
      // f(squared-up, bat_speed), so it's collinear with bat_speed above). Captured
      // into pick_signals only; no model weight until Q1→Q4 mining proves lift.
      squaredUpPerSwing:   batRow ? numOrNull(batRow.squared_up_per_swing)      : null,
      squaredUpPerContact: batRow ? numOrNull(batRow.squared_up_per_bat_contact): null,
      blastsPerContact:    batRow ? numOrNull(batRow.blast_per_bat_contact)     : null,
      swords:              batRow ? numOrNull(batRow.swords)                    : null,
      pctSwingsCompetitive:batRow ? numOrNull(batRow.percent_swings_competitive): null,
      batterRunValue:      batRow ? numOrNull(batRow.batter_run_value)          : null,
      // Bat-tracking COUNT denominators (cumulative swings / contacts). The
      // leaderboard exposes no date-range filter, so a recent-form window is
      // unreachable directly — but Δnumerator/Δdenominator across two daily
      // snapshots reconstructs a true interval rate (the Durbin "fast-swing% is
      // climbing" signal). Captured so scripts/feature-lab.mjs can difference them.
      swingsCompetitive:   batRow ? numOrNull(batRow.swings_competitive)        : null,
      batContact:          batRow ? numOrNull(batRow.contact)                   : null,
    };
  };
  try {
    const v = await tryYear(season);
    if (v) return v;
    // Early-season fallback: current year may have too few PAs — use prior year
    if (season > 2024) return await tryYear(season - 1);
    return null;
  } catch { return null; }
}

// ── Batter hot zones from MLB Stats API (zones 1-9 = strike zone, 11-14 = chase) ──
export async function getBatterHotZones(batterId, season) {
  const tryYear = async (yr) => {
    try {
      const d = await fetchJson(`${API}/people/${batterId}/stats?stats=hotZones&season=${yr}&group=hitting`);
      const splits = d?.stats?.[0]?.splits || [];
      const zones = {};
      for (const s of splits) {
        const z = parseInt(s.stat?.zone);
        if (!z) continue;
        zones[z] = {
          avg:  parseFloat(s.stat?.avg ?? s.stat?.value) || null,
          ops:  parseFloat(s.stat?.ops) || null,
          slg:  parseFloat(s.stat?.slg) || null,
          ab:   parseInt(s.stat?.atBats ?? s.stat?.pa) || 0,
          temp: s.stat?.temp || null,
        };
      }
      return Object.keys(zones).length > 0 ? zones : null;
    } catch { return null; }
  };
  const v = await tryYear(season);
  if (v) return v;
  // Early season fallback — try prior year
  if (season > 2024) return await tryYear(season - 1) || {};
  return {};
}

// ── Pitcher pitch movement per pitch type (Savant pitch-movement leaderboard) ──
// Returns break_x (horizontal, inches) and break_z_induced (vertical spin rise, inches).
// NOTE: player_id in the URL returns HTML, not CSV — fetch full leaderboard and filter client-side.
export async function getPitcherPitchLocations(pitcherId, year) {
  const tryYear = async (yr) => {
    try {
      // No player_id in URL — adding it returns the page HTML instead of CSV
      const url = `https://baseballsavant.mlb.com/leaderboard/pitch-movement?pitchYear=${yr}&team=&min=1&pitch_hand=&type=pa&csv=true`;
      const text = await fetchText(url);
      const rows = parseCSVText(text);
      const result = {};
      for (const row of rows) {
        if (String(row.pitcher_id) !== String(pitcherId)) continue;
        const pt = row.pitch_type;
        if (!pt) continue;
        // Actual column names in this CSV: pitcher_break_x, pitcher_break_z_induced (inches)
        const bx = parseFloat(row.pitcher_break_x);
        const bz = parseFloat(row.pitcher_break_z_induced);
        if (isNaN(bx) || isNaN(bz)) continue;
        result[pt] = {
          px: bx,   // horizontal break (inches, negative = glove side / tails inside to RHB)
          pz: bz,   // induced vertical break (inches, positive = rises)
          n:    parseInt(row.pitches_thrown) || 0,
          name: row.pitch_type_name || pt,
          speed: parseFloat(row.avg_speed) || null,
        };
      }
      return Object.keys(result).length > 0 ? result : null;
    } catch { return null; }
  };
  const v = await tryYear(year);
  if (v) return v;
  // Early season fallback — try prior year
  if (year > 2024) return await tryYear(year - 1) || {};
  return {};
}

// Extended sprint speed stats: hp_to_1b, bolts count, plus standard sprint speed
export async function getBatterSprintStats(batterId, season) {
  const tryYear = async (yr) => {
    const url = `https://baseballsavant.mlb.com/leaderboard/sprint_speed?year=${yr}&position=&team=&min=1&csv=true`;
    const text = await fetchText(url);
    const rows = parseCSVText(text);
    const row = rows.find(r => String(r.player_id) === String(batterId));
    if (!row) return null;
    return {
      speed:  parseFloat(row.sprint_speed) || null,
      hp1b:   parseFloat(row.hp_to_1b)    || null,  // home to 1B time (seconds)
      bolts:  parseInt(row.bolts)          || 0,     // # of max-effort sprints at 30+ ft/s
    };
  };
  try {
    const v = await tryYear(season);
    if (v?.speed != null) return v;
    if (season > 2024) return await tryYear(season - 1);
    return null;
  } catch { return null; }
}

// Baserunning metrics from the Savant `baserunning` leaderboard.
// HISTORY (2026-06 audit): this used to parse first_to_third_pct / extra_bases_taken_pct
// etc. out of the running_splits CSV — columns that have NEVER existed there
// (running_splits is the home-to-first time-split leaderboard). Every field was null
// from the day it was written, so the SB baserunning mult and the Baserunning UI card
// never fired. The advance-rate stats live in /leaderboard/baserunning:
//   rate_att_xb  — extra-base advance ATTEMPT rate on opportunities (aggressiveness)
//   rate_safe    — safe-advance rate per opportunity
//   runner_runs  — Savant composite runner runs above average (runs scale)
// League averages are computed from the same CSV so the model compares relatively
// instead of trusting hardcoded constants.
const _baserunningCsvCache = {}; // year → { rows, lgAvg } | null
async function _getBaserunningCsv(yr) {
  if (_baserunningCsvCache[yr] !== undefined) return _baserunningCsvCache[yr];
  try {
    const text = await fetchText(`https://baseballsavant.mlb.com/leaderboard/baserunning?year=${yr}&csv=true`);
    const rows = parseCSVText(text);
    const lgAvg = {};
    for (const k of ["rate_att_xb", "est_rate_att_generic_runner", "rate_safe", "rate_safe_per_attempt", "runner_runs"]) {
      let s = 0, n = 0;
      for (const r of rows) { const v = parseFloat(r[k]); if (!isNaN(v)) { s += v; n++; } }
      lgAvg[k] = n > 0 ? s / n : null;
    }
    const result = rows.length ? { rows, lgAvg } : null;
    _baserunningCsvCache[yr] = result;
    return result;
  } catch { _baserunningCsvCache[yr] = null; return null; }
}

export async function getBatterBaserunning(batterId, season) {
  const tryYear = async (yr) => {
    const csv = await _getBaserunningCsv(yr);
    const row = csv?.rows.find(r => String(r.entity_id) === String(batterId));
    if (!row) return null;
    const numOrNull = (v) => { const n = parseFloat(v); return isNaN(n) ? null : n; };
    const rateAtt = numOrNull(row.rate_att_xb);
    const estAtt  = numOrNull(row.est_rate_att_generic_runner);  // context-expected attempt rate for a generic runner
    return {
      rateAttXB:     rateAtt,                               // XB advance attempt rate (aggressiveness)
      estAttXB:      estAtt,                                // expected attempt rate given his opportunities/context
      // Attempt % Above Average — actual minus context-expected. The pure aggressiveness/"runner
      // intent" signal stripped of opportunity mix. Higher-N analogue of SB attemptRate: every
      // runner-on-base advance chance counts, so it stabilizes far earlier than rare SB attempts.
      attAboveAvg:   (rateAtt != null && estAtt != null) ? rateAtt - estAtt : null,
      rateSafe:      numOrNull(row.rate_safe),              // safe advances per opportunity
      rateSafePerAtt:numOrNull(row.rate_safe_per_attempt), // success rate WHEN he attempts (conversion skill)
      runnerRuns:    numOrNull(row.runner_runs),            // runner runs above avg (season total)
      opportunities: parseInt(row.n_opp_xb) || 0,
      lgAvg: {
        rateAttXB:      csv.lgAvg.rate_att_xb,
        estAttXB:       csv.lgAvg.est_rate_att_generic_runner,
        rateSafe:       csv.lgAvg.rate_safe,
        rateSafePerAtt: csv.lgAvg.rate_safe_per_attempt,
      },
    };
  };
  try {
    const v = await tryYear(season);
    if (v) return v;
    if (season > 2024) return await tryYear(season - 1);
    return null;
  } catch { return null; }
}

// Catcher pop time leaderboard from Savant — grouped by team (primary catcher = most SBA attempts)
// Returns { [teamAbbrev]: { popTime2b, exchange, armSpeed, estCsPct, csAboveAvg, stealingRuns, attempts, name } }
export async function getCatcherPopTimesMap(season) {
  const tryYear = async (yr) => {
    try {
      const text = await fetchText(`https://baseballsavant.mlb.com/leaderboard/catcher-throwing?year=${yr}&csv=true`, 8000);
      const rows = parseCSVText(text);
      if (rows.length) return rows;
    } catch { /* fall through */ }
    return [];
  };
  try {
    // Try current season first; if empty, fall back to prior year — run in parallel to save time
    const years = season > 2024 ? [season, season - 1] : [season];
    const [rows] = await Promise.all(years.map(tryYear)).then(results => {
      const found = results.find(r => r.length > 0);
      return [found || []];
    });
    const byTeam = {};
    for (const row of rows) {
      const team = (row.team_name || '').trim().toUpperCase();
      const attempts = parseInt(row.sb_attempts) || 0;
      if (!team) continue;
      if (!byTeam[team] || attempts > (byTeam[team].attempts || 0)) {
        byTeam[team] = {
          popTime2b:   parseFloat(row.pop_time)      || null,
          exchange:    parseFloat(row.exchange_time) || null,
          armSpeed:    parseFloat(row.arm_strength)  || null,
          estCsPct:    parseFloat(row.est_cs_pct)    || null,
          csAboveAvg:  parseFloat(row.caught_stealing_above_average) || null,
          csAaPerThrow: parseFloat(row.cs_aa_per_throw) || null,
          stealingRuns: parseFloat(row.catcher_stealing_runs) || null,
          attempts,
          name: row.player_name || '',
        };
      }
    }
    return byTeam;
  } catch { return {}; }
}

// ── New Savant endpoint fetch functions ──────────────────────────────────────

// Expected statistics: xBA/xSLG/xwOBA vs actual — luck / regression-to-mean signal
export async function getExpectedStats(playerId, season, type = "batter") {
  const tryYear = async (yr) => {
    try {
      const url = `https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=${type}&year=${yr}&position=&team=&min=1&csv=true`;
      const text = await fetchText(url);
      const rows = parseCSVText(text);
      const row = rows.find(r => String(r.player_id) === String(playerId));
      if (!row) return null;
      const pf = (k) => { const v = parseFloat(row[k]); return isNaN(v) ? null : v; };
      return {
        ba:        pf("ba"),
        xba:       pf("est_ba"),
        xbaDiff:   pf("est_ba_minus_ba_diff"),
        slg:       pf("slg"),
        xslg:      pf("est_slg"),
        xslgDiff:  pf("est_slg_minus_slg_diff"),
        woba:      pf("woba"),
        xwoba:     pf("est_woba"),
        xwobaDiff: pf("est_woba_minus_woba_diff"),
        era:       pf("era"),
        xera:      pf("xera"),
        xeraDiff:  pf("era_minus_xera_diff"),
        pa:        parseInt(row.pa) || 0,
      };
    } catch { return null; }
  };
  try {
    const v = await tryYear(season);
    if (v?.pa > 0) return v;
    if (season > 2024) return await tryYear(season - 1);
    return null;
  } catch { return null; }
}

// HR leaderboard: xHR vs actual HR — HR luck / regression signal
export async function getHomeRunStats(playerId, season, type = "batter") {
  const param = type === "pitcher" ? "player_type=Pitcher&" : "";
  const tryYear = async (yr) => {
    try {
      const url = `https://baseballsavant.mlb.com/leaderboard/home-runs?year=${yr}&${param}csv=true`;
      const text = await fetchText(url);
      const rows = parseCSVText(text);
      const row = rows.find(r => String(r.player_id) === String(playerId));
      if (!row) return null;
      return {
        hrTotal:      parseInt(row.hr_total)     || 0,
        xhr:          parseFloat(row.xhr)         || null,
        xhrDiff:      parseFloat(row.xhr_diff)    || null,
        noDoubters:   parseInt(row.no_doubters)   || 0,
        noDoubterPct: parseFloat(row.no_doubter_per) || null,
        doubters:     parseInt(row.doubters)      || 0,
      };
    } catch { return null; }
  };
  try {
    const v = await tryYear(season);
    if (v?.hrTotal > 0) return v;
    if (season > 2024) return await tryYear(season - 1);
    return null;
  } catch { return null; }
}

// Batted ball profile: GB%, FB%, pull%, pull_air_rate — directional batted-ball signal
export async function getBattedBall(batterId, season) {
  const tryYear = async (yr) => {
    try {
      const url = `https://baseballsavant.mlb.com/leaderboard/batted-ball?year=${yr}&min_pa=1&csv=true`;
      const text = await fetchText(url);
      const rows = parseCSVText(text);
      const row = rows.find(r => String(r.id) === String(batterId));
      if (!row) return null;
      const pf = (k) => { const v = parseFloat(row[k]); return isNaN(v) ? null : v; };
      return {
        bbe:          parseInt(row.bbe)   || 0,
        gbRate:       pf("gb_rate"),
        fbRate:       pf("air_rate"),   // air_rate ≈ FB + LD
        ldRate:       pf("ld_rate"),
        puRate:       pf("pu_rate"),
        pullRate:     pf("pull_rate"),
        straightRate: pf("straight_rate"),
        oppoRate:     pf("oppo_rate"),
        pullAirRate:  pf("pull_air_rate"), // pull fly balls — HR corridor
        oppoAirRate:  pf("oppo_air_rate"),
      };
    } catch { return null; }
  };
  try {
    const v = await tryYear(season);
    if (v?.bbe > 10) return v;
    if (season > 2024) return await tryYear(season - 1);
    return null;
  } catch { return null; }
}

// Swing-take zone run values: heart/shadow/chase/waste — zone discipline signal
export async function getSwingTake(playerId, season, group = "Batter") {
  const tryYear = async (yr) => {
    try {
      const url = `https://baseballsavant.mlb.com/leaderboard/swing-take?group=${group}&year=${yr}&min_pa=1&csv=true`;
      const text = await fetchText(url);
      const rows = parseCSVText(text);
      const row = rows.find(r => String(r.player_id) === String(playerId));
      if (!row) return null;
      const pf = (k) => { const v = parseFloat(row[k]); return isNaN(v) ? null : v; };
      return {
        pa:          parseInt(row.pa)      || 0,
        pitches:     parseInt(row.pitches) || 0,
        runsAll:     pf("runs_all"),
        runsHeart:   pf("runs_heart"),
        runsShadow:  pf("runs_shadow"),
        runsChase:   pf("runs_chase"),
        runsWaste:   pf("runs_waste"),
      };
    } catch { return null; }
  };
  try {
    const v = await tryYear(season);
    if (v?.pa > 0) return v;
    if (season > 2024) return await tryYear(season - 1);
    return null;
  } catch { return null; }
}

// Basestealing run value: runner aggressiveness + SB quality signal
export async function getBasestealingRunValue(playerId, season) {
  const tryYear = async (yr) => {
    try {
      const url = `https://baseballsavant.mlb.com/leaderboard/basestealing-run-value?year=${yr}&min=1&csv=true`;
      const text = await fetchText(url);
      const rows = parseCSVText(text);
      const row = rows.find(r => String(r.player_id) === String(playerId));
      if (!row) return null;
      const pf = (k) => { const v = parseFloat(row[k]); return isNaN(v) ? null : v; };
      const nSb = parseInt(row.n_sb) || 0;
      const nCs = parseInt(row.n_cs) || 0;
      const nPk = parseInt(row.n_pk) || 0;
      const nInit = parseInt(row.n_init) || 0;  // opportunities: times on base able to steal
      return {
        runsStolen:    pf("runs_stolen_on_running_act"),
        rateSbx:       pf("rate_sbx"),
        nSb, nCs, nPk, nInit,
        // Runner intent: how often he GOES per opportunity, decoupled from speed/success.
        // The "strong runner intent" signal — high attempt-per-chance regardless of outcome.
        attemptRate:   nInit > 0 ? (nSb + nCs + nPk) / nInit : null,
        successRate:   (nSb + nCs) > 0 ? nSb / (nSb + nCs) : null,
        primaryLead:   pf("r_primary_lead"),
        secondaryLead: pf("r_secondary_lead"),
        leadDiff:      pf("r_sec_minus_prim_lead"),
        // _sbx variants = lead profile measured ON steal attempts (vs the all-opportunity avg
        // above). The gap = how much he extends/jumps when he commits = read/jump quality.
        primaryLeadSbx:   pf("r_primary_lead_sbx"),
        secondaryLeadSbx: pf("r_secondary_lead_sbx"),
        leadDiffSbx:      pf("r_sec_minus_prim_lead_sbx"),
      };
    } catch { return null; }
  };
  try {
    const v = await tryYear(season);
    if (v) return v;
    if (season > 2024) return await tryYear(season - 1);
    return null;
  } catch { return null; }
}

// Pitcher running game: how well the pitcher holds baserunners
export async function getPitcherRunningGame(pitcherId, season) {
  const tryYear = async (yr) => {
    try {
      const url = `https://baseballsavant.mlb.com/leaderboard/pitcher-running-game?year=${yr}&csv=true`;
      const text = await fetchText(url);
      const rows = parseCSVText(text);
      const row = rows.find(r => String(r.player_id) === String(pitcherId));
      if (!row) return null;
      const pf = (k) => { const v = parseFloat(row[k]); return isNaN(v) ? null : v; };
      return {
        runsPrevented:  pf("runs_prevented_on_running_attr"),
        rateSbx:        pf("rate_sbx"),
        nSb:            parseInt(row.n_sb) || 0,
        nCs:            parseInt(row.n_cs) || 0,
        nPk:            parseInt(row.n_pk) || 0,
        primaryLead:    pf("r_primary_lead"),
        secondaryLead:  pf("r_secondary_lead"),
      };
    } catch { return null; }
  };
  try {
    const v = await tryYear(season);
    if (v) return v;
    if (season > 2024) return await tryYear(season - 1);
    return null;
  } catch { return null; }
}

// ── Opposing-team BULLPEN hold aggregate ─────────────────────────────────────
// Relievers throw ~30–40% of a game — the LATE innings where steal attempts cluster — but
// modelSB otherwise only sees the STARTER's running game. This aggregates the team's relievers
// (GS/G < 0.5) into an n_init-weighted mean rate_sbx + lead-burst, so we can read how holdable a
// team's pen is. Built once per year (full league CSV + one GS leaderboard call), cached; every
// team lookup is then a Map hit. Capture-first — surfaced + logged for mining, NOT yet in score.
const _bullpenHoldCache = new Map(); // year → Promise<{ byTeam: Map, league: {...} }>
function _getBullpenHoldData(season) {
  if (_bullpenHoldCache.has(season)) return _bullpenHoldCache.get(season);
  const p = (async () => {
    const empty = { byTeam: new Map(), league: null };
    try {
      const [csvText, gsData] = await Promise.all([
        fetchText(`https://baseballsavant.mlb.com/leaderboard/pitcher-running-game?year=${season}&csv=true`),
        fetchJson(`/api/proxy?url=${encodeURIComponent(`${API}/stats?stats=season&group=pitching&season=${season}&gameType=R&playerPool=all&limit=3000`)}&ttl=21600`).catch(() => null),
      ]);
      // games-started map for reliever classification
      const gsMap = new Map();
      for (const s of (gsData?.stats?.[0]?.splits || [])) {
        const id = s.player?.id;
        if (id) gsMap.set(String(id), { g: s.stat?.gamesPlayed || 0, gs: s.stat?.gamesStarted || 0 });
      }
      if (!gsMap.size) return empty;
      const rows = parseCSVText(csvText);
      const pf = (r, k) => { const v = parseFloat(r[k]); return isNaN(v) ? null : v; };
      const byTeam = new Map();
      let lgSbx = 0, lgLead = 0, lgInit = 0;
      for (const r of rows) {
        const role = gsMap.get(String(r.player_id));
        if (!role || role.g < 5) continue;        // too few appearances to classify
        if (role.gs / role.g >= 0.5) continue;     // primarily a starter → not bullpen
        const init = parseInt(r.n_init) || 0;
        if (init <= 0) continue;
        const team = (r.team_name || "").trim().toUpperCase();
        if (!team) continue;
        const rsbx = pf(r, "rate_sbx");
        const lead = pf(r, "sec_minus_prim_lead");
        let agg = byTeam.get(team);
        if (!agg) { agg = { wSbx: 0, wLead: 0, totInit: 0, nRel: 0 }; byTeam.set(team, agg); }
        if (rsbx != null) { agg.wSbx += rsbx * init; lgSbx += rsbx * init; }
        if (lead != null) { agg.wLead += lead * init; lgLead += lead * init; }
        agg.totInit += init; agg.nRel += 1; lgInit += init;
      }
      const league = lgInit > 0 ? { rateSbx: lgSbx / lgInit, leadDiff: lgLead / lgInit } : null;
      return { byTeam, league };
    } catch { return empty; }
  })();
  _bullpenHoldCache.set(season, p);
  return p;
}

export async function getTeamBullpenHold(teamAbbr, season) {
  if (!teamAbbr) return null;
  const { byTeam, league } = await _getBullpenHoldData(season);
  const agg = byTeam.get(String(teamAbbr).toUpperCase());
  if (!agg || agg.totInit === 0) return null;
  return {
    bullpenRateSbx:  agg.wSbx / agg.totInit,        // n_init-weighted expected steal rate vs the pen
    bullpenLeadDiff: agg.wLead / agg.totInit,        // weighted lead-burst (time-to-plate proxy)
    nRelievers:      agg.nRel,
    totalInit:       agg.totInit,
    lgRateSbx:       league?.rateSbx ?? null,        // league bullpen baseline for comparison
    lgLeadDiff:      league?.leadDiff ?? null,
  };
}

// Bat-tracking swing path: attack angle, swing tilt, ideal attack angle rate
export async function getSwingPathAttackAngle(batterId, season) {
  const tryYear = async (yr) => {
    try {
      // minSwings, NOT min_pa — the board ignores min_pa and falls back to its
      // qualified-hitters default, which returns 205 batters instead of 608 (verified
      // 2026-07-31). Every batter outside that top ~200 came back as no-row, so
      // computeAttackAngleMult returned a flat 1.0 for roughly two thirds of the league
      // and the attack-angle term was quietly dead for them.
      const url = `https://baseballsavant.mlb.com/leaderboard/bat-tracking/swing-path-attack-angle?year=${yr}&minSwings=1&min_pa=1&csv=true`;
      const text = await fetchText(url);
      const rows = parseCSVText(text);
      const row = rows.find(r => String(r.id) === String(batterId));
      if (!row) return null;
      const pf = (k) => { const v = parseFloat(row[k]); return isNaN(v) ? null : v; };
      return {
        avgBatSpeed:       pf("avg_bat_speed"),
        swingTilt:         pf("swing_tilt"),
        attackAngle:       pf("attack_angle"),
        attackDirection:   pf("attack_direction"),
        idealAttackAngle:  pf("ideal_attack_angle_rate"),
        competitiveSwings: parseInt(row.competitive_swings) || 0,
      };
    } catch { return null; }
  };
  try {
    const v = await tryYear(season);
    if (v?.competitiveSwings > 0) return v;
    if (season > 2024) return await tryYear(season - 1);
    return null;
  } catch { return null; }
}

// Active roster for a team; type = "batter" | "pitcher" | "all"
export async function getTeamRoster(teamId, season, type = "all") {
  const d = await fetchJson(`${API}/teams/${teamId}/roster?rosterType=active&season=${season}&hydrate=person`);
  const all = (d?.roster || []).sort((a, b) => a.person.fullName.localeCompare(b.person.fullName));
  if (type === "pitcher") return all.filter(p => p.position?.type === "Pitcher");
  if (type === "batter") return all.filter(p => p.position?.type !== "Pitcher");
  return all;
}

// ── News helpers ──
// Multiple CORS proxies tried in order — different proxies get blocked by different sources
// Proxy list — our server-side proxy is first (cache-backed, no CORS issues).
// Public proxies are fallbacks for local dev when /api/proxy isn't available.
// Each entry carries its OWN budget, because the proxies are not interchangeable.
// Our proxy's worst case is 5s (api_cache read) + 15s (upstream) = 20s, and a flat
// 12s budget for the whole chain aborted it *below its own success case* whenever
// Supabase was slow. On 2026-08-29 that is exactly what happened: SERVE wedged,
// every /api/proxy call blew 12s, and the chain fell through to the public proxies
// (allorigins fails on Rotowire, corsproxy 403s) — so the board showed PROJECTED
// lineups for games whose real cards were posted, with no error anywhere.
// The public proxies stay as local-dev fallbacks but get a short leash: they are
// last-resort, and waiting on them is how a recoverable failure became a silent one.
const _PROXIES = [
  // Our Vercel serverless proxy — works in production and local `vite dev`
  { budgetMs: 22000, make: (url, fresh) => `/api/proxy?url=${encodeURIComponent(url)}&ttl=1800${fresh ? "&fresh=1" : ""}` },
  // Public CORS proxies — fallbacks only (fragile, rate-limited, no caching)
  { budgetMs: 8000, make: url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}` },
  { budgetMs: 8000, make: url => `https://corsproxy.io/?${encodeURIComponent(url)}` },
];

// Fetch a URL through each proxy in sequence until one succeeds (2xx response).
// `fresh` forces our proxy past its own 30-min cache — without it a user-initiated
// refresh gets an X-Cache HIT and never reaches the source (verified in prod:
// both the first and second click returned HIT).
// `timeoutMs` is a CEILING applied per attempt, not the budget itself — each proxy
// uses the smaller of its own budget and the caller's. Passing a large value keeps
// every proxy at its natural budget; passing a small one tightens all of them.
export async function _proxiedFetch(url, timeoutMs = 22000, { fresh = false } = {}) {
  for (const proxy of _PROXIES) {
    try {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), Math.min(proxy.budgetMs, timeoutMs));
      const r = await fetch(proxy.make(url, fresh), { signal: ctrl.signal });
      clearTimeout(tid);
      if (r.ok) return await r.text();
    } catch { /* try next proxy */ }
  }
  return null; // all proxies failed
}

function _parseRSSItems(xmlText) {
  try {
    return Array.from(new DOMParser().parseFromString(xmlText, "text/xml").querySelectorAll("item"));
  } catch { return []; }
}

export async function getPlayerNews(playerName) {
  const articles = [];

  // 1. Rotowire — highest-signal (injury / lineup / DFS notes). Try multiple RSS endpoints.
  const ROTOWIRE_URLS = [
    "https://www.rotowire.com/baseball/rss/news.htm",
    "https://www.rotowire.com/rss/news.htm?sport=baseball",
  ];
  for (const rwUrl of ROTOWIRE_URLS) {
    try {
      const text = await _proxiedFetch(rwUrl);
      if (!text) continue;
      const items = _parseRSSItems(text);
      if (items.length === 0) continue;
      const lastName = playerName.split(" ").pop().toLowerCase();
      const full = playerName.toLowerCase();
      for (const item of items) {
        const title = item.querySelector("title")?.textContent || "";
        const desc  = item.querySelector("description")?.textContent || "";
        if (!(title + " " + desc).toLowerCase().includes(lastName) &&
            !(title + " " + desc).toLowerCase().includes(full)) continue;
        const link    = item.getElementsByTagName("link")[0]?.textContent?.trim() || "";
        const pubDate = item.querySelector("pubDate")?.textContent || "";
        articles.push({ title, source: "Rotowire", link, pubDate, isRotowire: true });
      }
      break; // stop once one endpoint works
    } catch { /* try next */ }
  }

  // 2. Google News — always fire BOTH queries in parallel (exact phrase + broad unquoted),
  //    through the multi-proxy fetcher. Merged and deduplicated by URL.
  const _fetchGoogleNews = async (query) => {
    try {
      const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
      const text = await _proxiedFetch(rssUrl);
      return text ? _parseRSSItems(text) : [];
    } catch { return []; }
  };
  try {
    const [exactItems, broadItems] = await Promise.all([
      _fetchGoogleNews(`"${playerName}" baseball`),
      _fetchGoogleNews(`${playerName} baseball MLB`),
    ]);
    const seen = new Set();
    const merged = [];
    for (const item of [...exactItems, ...broadItems]) {
      const link = item.getElementsByTagName("link")[0]?.textContent?.trim() || "";
      if (!seen.has(link)) { seen.add(link); merged.push(item); }
    }
    for (const item of merged.slice(0, 18)) {
      const full   = item.querySelector("title")?.textContent || "";
      const dash   = full.lastIndexOf(" - ");
      const title  = dash > 0 ? full.slice(0, dash) : full;
      const source = dash > 0 ? full.slice(dash + 3) : (item.querySelector("source")?.textContent || "");
      const link   = item.getElementsByTagName("link")[0]?.textContent?.trim() || "";
      const pubDate = item.querySelector("pubDate")?.textContent || "";
      if (title) articles.push({ title, source, link, pubDate, isRotowire: false });
    }
  } catch(e) { console.warn("Google News RSS:", e); }

  // Sort all articles by pubDate descending (most recent first)
  return articles.sort((a, b) => {
    const da = a.pubDate ? new Date(a.pubDate) : new Date(0);
    const db = b.pubDate ? new Date(b.pubDate) : new Date(0);
    return db - da;
  });
}

// ── Phase 0: shared utilities for consolidated table & future player pages ──

export function getGameLogStat(entry, propKey) {
  const s = entry?.stat || {};
  switch (propKey) {
    case 'hits':
    case 'hits15': return s.hits || 0;
    case 'hr':     return s.homeRuns || 0;
    case 'tb': {
      const h = s.hits || 0, d = s.doubles || 0, t = s.triples || 0, hr = s.homeRuns || 0;
      return (h - d - t - hr) + d * 2 + t * 3 + hr * 4;
    }
    case 'hrr':    return (s.hits || 0) + (s.runs || 0) + (s.rbi || 0);
    case 'sb':     return s.stolenBases || 0;
    case 'rbi':    return s.rbi || 0;
    case 'ks':     return s.strikeOuts || 0;
    default:       return 0;
  }
}
