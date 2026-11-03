// ── Weather Engine: Fetch + Adjustments ────────────────────────────────────
import { PARK_DATA, PARK_COORDS, PARK_CF_BEARING, _ABBREV_ALIASES } from './parks.js';

// Minimal fetch helper (browser + edge-function compatible)
const _wFetchCache = new Map();
async function _fetchJson(url) {
  if (_wFetchCache.has(url)) return _wFetchCache.get(url);
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(r.status);
    const data = await r.json();
    _wFetchCache.set(url, data);
    return data;
  } catch (e) { console.error('Weather fetch:', url, e); return null; }
}

// ══════════════════════════════════════════════════════════
// WEATHER ENGINE: Fetch + Adjustments
// ══════════════════════════════════════════════════════════
export async function getGameWeather(gamePk) {
  if (!gamePk) return null;
  try {
    const d = await _fetchJson(`https://statsapi.mlb.com/api/v1.1/game/${gamePk}/feed/live`);
    const w = d?.gameData?.weather;
    if (!w) return null;
    const windMatch = w.wind?.match(/(\d+)\s*mph[,\s]*(.*)/i);
    // source:"mlb_live" flags this as the game-day feed, which reports the ACTUAL roof
    // decision ("Roof Closed"/"Dome") once the game reaches Warmup. isWeatherNeutral trusts
    // this literally; the NWS forecast (source:"nws_forecast") is only a preview-window proxy.
    return { temp: w.temp ? Number(w.temp) : null, condition: w.condition || null,
      windSpeed: windMatch ? Number(windMatch[1]) : 0, windDir: windMatch ? windMatch[2].trim() : "",
      source: "mlb_live", raw: w };
  } catch { return null; }
}

// ── NWS Forecast (no API key, US only) ──────────────────────────────────────
const _nwsPointCache = {};   // { [latlon]: { forecastUrl, expires } }
const _nwsForecastCache = {}; // { [forecastUrl]: { periods, expires } }
const NWS_TTL = 60 * 60 * 1000; // 1 hr

function _compassToDeg(dir) {
  const m = { N:0,NNE:22.5,NE:45,ENE:67.5,E:90,ESE:112.5,SE:135,SSE:157.5,
              S:180,SSW:202.5,SW:225,WSW:247.5,W:270,WNW:292.5,NW:315,NNW:337.5 };
  return m[(dir||"").toUpperCase()] ?? null;
}

function _nwsWindToMLBDir(windDir, cfBearing) {
  const fromDeg = _compassToDeg(windDir);
  if (fromDeg == null || cfBearing == null) return windDir || "";
  // Meteorological: wind "from" a direction travels toward (from+180)%360
  const toDeg = (fromDeg + 180) % 360;
  const delta = ((toDeg - cfBearing + 540) % 360) - 180; // –180..+180
  if (Math.abs(delta) <= 45)  return "Out To CF";
  if (Math.abs(delta) >= 135) return "In From CF";
  return delta > 0 ? "L To R" : "R To L";
}

function _parseNWSWindSpeed(str) {
  if (!str) return 0;
  const nums = (str.match(/\d+/g) || []).map(Number);
  if (!nums.length) return 0;
  return nums.length === 1 ? nums[0] : Math.round((nums[0] + nums[1]) / 2);
}

export async function getNWSForecast(lat, lon, gameTimeISO, cfBearing) {
  const coordKey = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  const now = Date.now();

  // Helper: fetch with a timeout so slow/unresponsive NWS never hangs
  const fetchWithTimeout = (url, opts, ms = 5000) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(timer));
  };

  let forecastUrl;
  const cachedPoint = _nwsPointCache[coordKey];
  if (cachedPoint?.expires > now) {
    // A cached MISS is stored as forecastUrl:null — see below. Honour it without
    // re-asking, which is the whole point of caching the failure.
    if (!cachedPoint.forecastUrl) return null;
    forecastUrl = cachedPoint.forecastUrl;
  } else {
    try {
      const ptRes = await fetchWithTimeout(
        `https://api.weather.gov/points/${lat},${lon}`,
        { headers: { "Accept": "application/geo+json" } }
      );
      if (!ptRes.ok) {
        // NWS is the US National Weather Service and covers US territory ONLY, so
        // Rogers Centre (43.64, -79.39) gets a hard 404 that will never succeed.
        // Only successes were cached, so every Blue Jays render re-requested it:
        // five identical 404s in the console per load, each costing up to the 5s
        // timeout. A 404/400 is a permanent verdict about these coordinates —
        // cache it for the full point TTL. Other statuses (429, 5xx) are
        // transient, so those get a short retry window instead of a day-long one.
        const permanent = ptRes.status === 404 || ptRes.status === 400;
        _nwsPointCache[coordKey] = {
          forecastUrl: null,
          expires: now + (permanent ? NWS_TTL * 24 : 5 * 60 * 1000),
        };
        return null;
      }
      const pt = await ptRes.json();
      forecastUrl = pt?.properties?.forecastHourly;
      if (!forecastUrl) {
        _nwsPointCache[coordKey] = { forecastUrl: null, expires: now + NWS_TTL };
        return null;
      }
      _nwsPointCache[coordKey] = { forecastUrl, expires: now + NWS_TTL * 24 };
    } catch { return null; }
  }

  let periods;
  if (_nwsForecastCache[forecastUrl]?.expires > now) {
    periods = _nwsForecastCache[forecastUrl].periods;
  } else {
    try {
      const fcRes = await fetchWithTimeout(forecastUrl, { headers: { "Accept": "application/geo+json" } });
      if (!fcRes.ok) return null;
      const fc = await fcRes.json();
      periods = fc?.properties?.periods;
      if (!periods?.length) return null;
      _nwsForecastCache[forecastUrl] = { periods, expires: now + NWS_TTL };
    } catch { return null; }
  }

  // Find hourly period closest to game time
  const gameMs = gameTimeISO ? new Date(gameTimeISO).getTime() : Date.now();
  let best = null, bestDiff = Infinity;
  for (const p of periods) {
    const diff = Math.abs(new Date(p.startTime).getTime() - gameMs);
    if (diff < bestDiff) { bestDiff = diff; best = p; }
  }
  if (!best) return null;

  const windSpeed = _parseNWSWindSpeed(best.windSpeed);
  const mlbDir   = _nwsWindToMLBDir(best.windDirection, cfBearing);
  const tempF    = best.temperature != null
    ? (best.temperatureUnit === "C" ? Math.round(best.temperature * 9/5 + 32) : best.temperature)
    : null;

  return { temp: tempF, condition: best.shortForecast || null,
           windSpeed, windDir: mlbDir, windDirRaw: best.windDirection,
           source: "nws_forecast" };
}
// ─────────────────────────────────────────────────────────────────────────────

// Research-calibrated temperature multipliers — baseline 72°F ≈ MLB average game temp
// Triple-confirmed HR rate: +1%/°F (open air only)
//   Nathan (2023) GAM logistic regression, Statcast 2017-22: 0.96%/°F avg
//   Callahan et al. (2023) BAMS, Statcast 2015-19: 1.0%/°F (1.8%/°C)
//   WeatherApplied (2025) physics simulation: +4 ft/10°F for HR-like fly ball ≈ 0.8-1%/°F
//   Koch & Panorska (2013) 22k-game empirical: +31% HR cold(<60°F)→warm(>83°F) → 0.78%/°F
// Nathan (2023) key insight: effect is largest for borderline fly balls (mid-range prob);
//   negligible for "no doubters" (>110 mph) and "no wayers" — captured naturally by our
//   Poisson conversion + projRelCap ceiling, no structural change needed.
// Pressure: WeatherApplied quantifies +2 ft per 0.3 inHg drop (7 ft/inHg). Day-to-day
//   swings are ±0.3 inHg → ±0.4% HR probability. NWS hourly API does not return surface
//   pressure, so not modeled. Worth adding if a pressure data source is added.
// Humidity: +1 ft per 50% RH increase — tiny, and offset by ball-absorption effects
//   (heavier/less elastic ball in humid air). MLB humidors further neutralize. Not modeled.
// Hits/BA included (Koch: BA also increases in warm weather; smaller effect than HR).
export function tempFactor(tempF, model) {
  if (tempF == null) return 1.0;
  const d = tempF - 72; // deviation from league-average game temp
  // HR: raised 0.80→0.90%/°F — consensus across four independent studies is ~0.96-1.0%/°F.
  // Using 0.90 (slightly below consensus) for conservatism vs Poisson tail uncertainty.
  // Clamped ±20% so fringe temps (>97°F or <47°F) don't over-extrapolate.
  const clamp = (v) => Math.min(1.20, Math.max(0.80, v));
  if (model === "HR")                    return clamp(1.0 + d * 0.0090);
  if (model === "2B")                    return clamp(1.0 + d * 0.0040);
  if (model === "3B")                    return clamp(1.0 + d * 0.0030);
  if (model === "TB")                    return clamp(1.0 + d * 0.0055);
  if (model === "H" || model === "1B")   return clamp(1.0 + d * 0.0020);
  return 1.0; // K, SB: no documented temperature effect
}
// Elevation: kept for reference but NOT applied in parkWeatherMult —
// park factors are empirical multi-year averages that already capture altitude.
// Applying elevFactor on top of pf would double-count Coors, MIL, etc.
export function elevFactor(elevFt) { return 1.0 + (elevFt / 100000); }

// Wind: "Out To CF" = tailwind, "In From CF" = headwind, "L To R"/"R To L" = cross
export function windFactor(windSpeed, windDir, model) {
  if (!windSpeed || !windDir) return 1.0;
  const dir = windDir.toLowerCase();
  const isOut = dir.includes("out to"), isIn = dir.includes("in from");
  const spd = windSpeed / 100; // 10mph → 0.10
  if (model === "HR" || model === "TB" || model === "2B") {
    if (isOut) return 1.0 + (spd * 0.5); if (isIn) return 1.0 - (spd * 0.4); }
  if (model === "3B") { if (isOut) return 1.0 + (spd * 0.3); if (isIn) return 1.0 - (spd * 0.2); }
  if (model === "H" || model === "1B") { if (isOut) return 1.0 + (spd * 0.1); if (isIn) return 1.0 - (spd * 0.1); }
  return 1.0; // K, SB: no wind effect
}

// Returns true when wind/temp adjustments should be suppressed (indoor or retractable-closed).
// Park factor is always applied regardless — this only gates weather variables.
//
// Ground-truth hierarchy:
//   1. MLB live feed (source:"mlb_live") reports the ACTUAL roof state once the game hits
//      Warmup ("Roof Closed"/"Dome" ⇢ neutral; any other reading ⇢ roof is genuinely open).
//      Trusted literally — no heuristic overrides a real roof decision.
//   2. Preview window (NWS forecast or no data): no official decision exists yet, so infer —
//      parks that keep the roof shut the vast majority of the time (roofDefault:"closed") are
//      treated as neutral, else rain/cold in the forecast implies a likely closure.
export function isWeatherNeutral(park, weather) {
  if (!park) return false;
  if (park.roof === "dome") return true;
  if (park.roof !== "retractable") return false;

  const c = (weather?.condition || "").toLowerCase();

  // 1. MLB live feed = the real roof decision. Believe it verbatim.
  if (weather?.source === "mlb_live" && c) {
    return c.includes("roof closed") || c.includes("dome") || c.includes("indoor");
  }

  // 2. Preview window (forecast / no live reading).
  if (c.includes("dome") || c.includes("roof closed") || c.includes("indoor")) return true;
  // Parks that are shut ≥83% of the time (loanDepot, Rogers Centre, Globe Life, American Family,
  // Daikin) — default closed until the live feed says otherwise. Chase/T-Mobile open more often
  // than not, so they stay forecast-driven.
  if (park.roofDefault === "closed") return true;
  // Rain/storms → virtually all retractable parks close their roof.
  if (c.includes("rain") || c.includes("shower") || c.includes("drizzl") || c.includes("thunder")) return true;
  // Very cold (< 45 °F) → most retractable parks close.
  if (weather?.temp != null && weather.temp < 45) return true;
  return false;
}

// Derive human-readable roof status for the weather table.
export function getRoofStatus(park, weather) {
  if (!park) return null;
  if (park.roof === "open") return { label: "Open", color: "#0f8a44", note: null };
  if (park.roof === "dome") return { label: "Dome", color: "#2569d6", note: "Indoor — park factor only" };
  // Retractable
  const c = (weather?.condition || "").toLowerCase();

  // MLB live feed = confirmed roof decision (game day, Warmup onward).
  if (weather?.source === "mlb_live" && c) {
    if (c.includes("roof closed") || c.includes("dome") || c.includes("indoor"))
      return { label: "Closed", color: "#2569d6", note: "Roof confirmed closed (MLB game feed)" };
    return { label: "Open", color: "#0f8a44", note: "Roof confirmed open (MLB game feed) — weather applies" };
  }

  // Preview window — no confirmed decision yet.
  if (c.includes("roof closed") || c.includes("dome") || c.includes("indoor"))
    return { label: "Closed", color: "#2569d6", note: "Roof reported closed" };
  if (park.roofDefault === "closed")
    return { label: "Closed*", color: "#2569d6", note: "Usually closed here — assumed shut until game feed confirms" };
  if (c.includes("rain") || c.includes("shower") || c.includes("drizzl") || c.includes("thunder"))
    return { label: "Closed ☔", color: "#2569d6", note: "Retractable — rain → roof likely closed" };
  if (weather?.temp != null && weather.temp < 45)
    return { label: "Closed 🥶", color: "#2569d6", note: "Retractable — cold → roof likely closed" };
  if (!weather) return { label: "Open?", color: "#a16207", note: "Retractable — status unknown" };
  return { label: "Open?", color: "#a16207", note: "Retractable — likely open (weather applies until game feed confirms)" };
}

// Combined multiplier: park factor × temp × wind
// NOTE: elevation deliberately excluded — park factors are empirical multi-year averages
// that already incorporate altitude (Coors HR_R=1.38 reflects thin air; adding elevFactor
// would double-count and over-inflate COL, MIL, etc.)
// Market key → the park-factor model parkWeatherMult() should use.
//
// This lived as TWO inline object literals in App.jsx (the player panel and the
// bulk scan that writes picks) and they silently DIVERGED: the panel had `hrr`
// but not `rbi`, the scan had `rbi` but not `hrr`. An unmapped market yields
// `undefined`, which matches no branch below, so parkWeatherMult returns exactly
// 1.0 — and because the scan is what writes picks, HRR received NO park or
// weather adjustment at all: 162/162 saved HRR picks over 30 days had parkMult
// pinned at exactly 1.0 while hits/hr/rbi/tb all varied (found 2026-07-29 by the
// tripwire's modal-pinning check). Keep this as the single source of truth.
//
// `sb` maps to "SB" deliberately: no branch handles it and none should — park
// and wind don't move stolen bases — so it correctly resolves to 1.0. That is
// the one market where a pinned 1.0 is right.
export const PARK_MODEL_BY_MARKET = {
  hits: "H",
  hr: "HR",
  hrr: "H",
  rbi: "H",
  single: "1B",
  double: "2B",
  triple: "3B",
  sb: "SB",
  tb: "TB",
};

export function parkWeatherMult(park, weather, batterHand, model) {
  let m = 1.0;
  if (!park) return m;
  const pf = park.pf;
  if (model === "HR") { m *= batterHand === "L" ? (pf.HR_L || 1) : (pf.HR_R || 1); }
  else if (model === "2B") { m *= pf["2B"] || 1; }
  else if (model === "3B") { m *= pf["3B"] || 1; }
  else if (model === "H" || model === "1B") { m *= pf.H || 1; }
  else if (model === "TB") {
    // Feature-mining (N=2661, see scripts/tb-park-mining.mjs) showed the old 40/30/30 blend
    // correlates with actual TB cash@O1.5 at r=−0.047 — pure noise. The HR weight was too high
    // (Coors HR_R=1.35 inflated total to 1.276 but empirical cash was just baseline).
    // Rebalanced toward 2B + H (the actual O1.5 drivers) and dampened to 60% magnitude so
    // a 1.20 raw park stays at 1.12 net — directional fundamentals kept, noise compressed.
    const hrF = batterHand === "L" ? (pf.HR_L || 1) : (pf.HR_R || 1);
    const rawTB = hrF * 0.25 + (pf["2B"] || 1) * 0.40 + (pf.H || 1) * 0.35;
    m *= 1.0 + (rawTB - 1.0) * 0.60;
  }
  // Weather (skipped for dome/retractable-closed)
  if (weather && !isWeatherNeutral(park, weather)) {
    // Temperature — per-model rates backed by Nathan (2014) and Koch & Panorska (2013)
    // Applied to all offensive models since Koch shows BA, SLG, HR all increase in heat
    if (weather.temp != null) m *= tempFactor(weather.temp, model);
    // Wind — only affects ball-in-play distance (no effect on K, SB)
    m *= windFactor(weather.windSpeed, weather.windDir, model);
  }
  return m;
}
