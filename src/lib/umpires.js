// ── Umpire Data: HP Assignments + K Tendency from Run Impact ─────────────────
//
// Step 1: MLB Stats API schedule?hydrate=officials → HP ump name per gamePk
// Step 2: UmpScorecards ?year=YYYY → per-ump total_run_impact_mean
//         Low run impact (0.9) = pitcher-friendly zone → more Ks
//         High run impact (2.4) = batter-friendly zone → fewer Ks
//         League avg ≈ 1.46, std ≈ 0.26 (2026 data)
// Step 3: computeUmpireMult(name, umpiresMap) → 0.88–1.15 for K model
//
// Sources: MLB Stats API (no key), UmpScorecards (public, no key)

const _umpCache = new Map();
const UMP_TTL = 4 * 60 * 60 * 1000; // 4 hr — assignments fixed by game time

async function _fetchJson(url, timeoutMs = 6000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(r.status);
    return await r.json();
  } catch { return null; }
  finally { clearTimeout(timer); }
}

// Step 1: HP umpire assignment per gamePk
// Returns { [gamePk]: { name, id } }
export async function fetchGameUmpires(date) {
  const key = `ump:officials:${date}`;
  const cached = _umpCache.get(key);
  if (cached && Date.now() - cached.ts < UMP_TTL) return cached.data;

  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&hydrate=officials`;
  const data = await _fetchJson(url);
  const result = {};
  for (const d of (data?.dates || [])) {
    for (const game of (d.games || [])) {
      const hp = (game.officials || []).find(
        o => o.officialType?.description === "Home Plate"
      );
      if (hp?.official) {
        result[game.gamePk] = { name: hp.official.fullName, id: hp.official.id };
      }
    }
  }
  _umpCache.set(key, { data: result, ts: Date.now() });
  return result;
}

// Step 2: UmpScorecards season umpire stats
// Returns { [normalizedName]: { run_impact, run_impact_z, n } }
//
// UmpScorecards API: https://umpscorecards.com/api/umpires?year=YYYY
// Response: { rows: [{ umpire, n, total_run_impact_mean, ... }] }
//
// total_run_impact_mean: avg extra runs above baseline per game this ump allows.
// We compute z-scores relative to the season mean, then derive K tendency.
// Bayesian shrinkage toward season mean based on games worked (N=20 reg constant).
export async function fetchUmpireSeasonStats(season) {
  const key = `ump:scorecards:${season}`;
  const cached = _umpCache.get(key);
  if (cached && Date.now() - cached.ts < UMP_TTL * 6) return cached.data; // 24 hr

  const proxyUrl = `/api/proxy?url=${encodeURIComponent(`https://umpscorecards.com/api/umpires?year=${season}`)}&ttl=86400&ct=json`;
  const data = await _fetchJson(proxyUrl, 8000);
  const rows = data?.rows ?? (Array.isArray(data) ? data : null);
  const result = {};

  if (!rows || rows.length === 0) {
    // Short-circuit so we retry sooner on empty response
    _umpCache.set(key, { data: result, ts: Date.now() - UMP_TTL * 5 });
    return result;
  }

  // League mean + std of total_run_impact_mean across all umps this season
  const allRI = rows
    .map(u => _float(u.total_run_impact_mean))
    .filter(v => v != null);
  if (allRI.length === 0) {
    _umpCache.set(key, { data: result, ts: Date.now() - UMP_TTL * 5 });
    return result;
  }
  const mean = allRI.reduce((s, v) => s + v, 0) / allRI.length;
  const std  = Math.sqrt(
    allRI.reduce((s, v) => s + (v - mean) ** 2, 0) / allRI.length
  ) || 0.26; // fallback std if all umps identical

  // Regression constant: shrink toward league mean proportionally to games worked
  const REGRESS_N = 20;

  for (const u of rows) {
    const name = _normUmpName(u.umpire || "");
    if (!name) continue;
    const ri = _float(u.total_run_impact_mean);
    const n  = _int(u.n) ?? 0;
    if (ri == null) continue;

    // Bayesian shrinkage: weight observed ri toward league mean
    const shrunk = (n * ri + REGRESS_N * mean) / (n + REGRESS_N);
    // Z-score: positive = batter-friendly (more runs), negative = pitcher-friendly (fewer runs)
    const z = (shrunk - mean) / std;

    result[name] = { run_impact: ri, run_impact_z: z, n };
  }

  // Store league meta so callers can display it
  result._meta = { mean: +mean.toFixed(3), std: +std.toFixed(3) };

  _umpCache.set(key, { data: result, ts: Date.now() });
  return result;
}

// Step 3: Combine → K model multiplier (0.88–1.15)
//
// High run_impact_z → batter-friendly ump → fewer Ks → mult < 1.0
// Low  run_impact_z → pitcher-friendly ump → more  Ks → mult > 1.0
//
// 1 z-score ≈ 6% shift in K tendency (conservative; run impact and K rate
// are moderately correlated — ump zone strictness drives both).
export function computeUmpireMult(umpName, umpiresMap) {
  if (!umpName || !umpiresMap) return 1.0;

  const norm = _normUmpName(umpName);
  let stats = umpiresMap[norm];

  if (!stats) {
    // Fuzzy: first + last name token match
    const parts = norm.split(" ");
    const last = parts[parts.length - 1];
    const match = Object.keys(umpiresMap).find(
      k => k !== "_meta" && (k.endsWith(last) || k.startsWith(parts[0]))
    );
    if (match) stats = umpiresMap[match];
  }

  if (!stats?.run_impact_z) return 1.0;

  const mult = 1.0 - stats.run_impact_z * 0.06;
  return Math.min(1.15, Math.max(0.88, mult));
}

// Build combined umpire info for display + model
// Returns { name, mult, run_impact, run_impact_z, n } or null
export function buildUmpireInfo(gamePk, gameUmpires, umpiresMap) {
  const ump = gameUmpires?.[gamePk];
  if (!ump?.name) return null;
  const mult = computeUmpireMult(ump.name, umpiresMap);
  const norm  = _normUmpName(ump.name);
  const parts = norm.split(" ");
  const last  = parts[parts.length - 1];
  const match =
    umpiresMap?.[norm] ??
    Object.entries(umpiresMap ?? {})
      .find(([k]) => k !== "_meta" && (k.endsWith(last) || k.startsWith(parts[0])))?.[1];
  return {
    name:         ump.name,
    mult,
    run_impact:   match?.run_impact   ?? null,
    run_impact_z: match?.run_impact_z ?? null,
    n:            match?.n            ?? null,
  };
}

function _normUmpName(s) {
  return (s || "").toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
function _float(v) { const f = parseFloat(v); return isNaN(f) ? null : f; }
function _int(v)   { const i = parseInt(v);   return isNaN(i) ? null : i; }
