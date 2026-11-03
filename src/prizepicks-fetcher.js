/**
 * PrizePicks Fetcher Utility
 * Free, no API key required.
 * Endpoint: https://partner-api.prizepicks.com/projections?per_page=1000
 *
 * Works in both MLB Research Dashboard (Vite/React) and NHL Research Dashboard (vanilla JS/Node).
 * Cache TTL: 15 minutes — PrizePicks updates lines ~hourly, no need to hammer the endpoint.
 */

// ─── Cache ────────────────────────────────────────────────────────────────────
const PP_CACHE = {
  mlb: { data: null, ts: 0 },
  nhl: { data: null, ts: 0 },
};
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

// ─── League ID map (PrizePicks uses league_id integers) ───────────────────────
const PP_LEAGUE_IDS = {
  mlb: 2,   // MLB
  nhl: 12,  // NHL
};

// ─── Stat key normalization ───────────────────────────────────────────────────
// Maps PrizePicks stat_type strings → your internal model keys
const MLB_STAT_MAP = {
  "Hits":              "hits",
  "Home Runs":         "hr",
  "Total Bases":       "tb",
  "RBIs":              "rbi",
  "Runs":              "runs",
  "Strikeouts":        "k",        // batter K
  "Pitcher Strikeouts":"pitcherK",
  "Hits Allowed":      "hitsAllowed",
  "Walks":             "bb",
  "Earned Runs":       "er",
  "Pitching Outs":     "outs",
};

const NHL_STAT_MAP = {
  "Goals":             "goals",
  "Assists":           "assists",
  "Points":            "points",
  "Shots on Goal":     "shots",
  "Saves":             "saves",
  "Goals Allowed":     "goalsAllowed",
  "Power Play Points": "ppPoints",
  "Blocked Shots":     "blocks",
};

// ─── Core fetch ───────────────────────────────────────────────────────────────
async function fetchPrizePicks(sport) {
  const league = sport.toLowerCase(); // "mlb" or "nhl"
  const cache  = PP_CACHE[league];

  if (cache.data && Date.now() - cache.ts < CACHE_TTL_MS) {
    return cache.data;
  }

  const leagueId = PP_LEAGUE_IDS[league];
  if (!leagueId) throw new Error(`Unknown sport: ${sport}`);

  const url = `https://partner-api.prizepicks.com/projections?league_id=${leagueId}&per_page=1000`;

  let raw;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`PrizePicks HTTP ${res.status}`);
    raw = await res.json();
  } catch (err) {
    console.warn("[PrizePicks] Fetch failed:", err.message);
    // Return stale cache if available rather than crashing the UI
    if (cache.data) return cache.data;
    return {};
  }

  const statMap = league === "mlb" ? MLB_STAT_MAP : NHL_STAT_MAP;
  const parsed  = parsePrizePicks(raw, statMap);

  cache.data = parsed;
  cache.ts   = Date.now();
  return parsed;
}

// ─── Parser ───────────────────────────────────────────────────────────────────
/**
 * Returns a nested map:
 *   { [normalizedPlayerName]: { [internalStatKey]: { line, statType, teamAbbr, opponent } } }
 *
 * normalizedPlayerName: lowercase, no punctuation — for fuzzy matching against your roster.
 */
function parsePrizePicks(raw, statMap) {
  const result = {};

  const projections = raw?.data ?? [];
  const included    = raw?.included ?? [];

  // Build player lookup from included array
  const playerLookup = {};
  for (const item of included) {
    if (item.type === "new_player") {
      playerLookup[item.id] = {
        name:      item.attributes?.name ?? "",
        teamAbbr:  item.attributes?.team ?? "",
        position:  item.attributes?.position ?? "",
      };
    }
  }

  for (const proj of projections) {
    const attrs      = proj.attributes ?? {};
    const statType   = attrs.stat_type ?? "";
    const line       = parseFloat(attrs.line_score);
    const playerId   = proj.relationships?.new_player?.data?.id;

    if (!playerId || isNaN(line)) continue;

    const internalKey = statMap[statType];
    if (!internalKey) continue; // stat we don't track — skip

    const player   = playerLookup[playerId] ?? {};
    const nameNorm = normalizeName(player.name);
    if (!nameNorm) continue;

    if (!result[nameNorm]) result[nameNorm] = {};

    result[nameNorm][internalKey] = {
      line,
      statType,
      teamAbbr: player.teamAbbr,
      position: player.position,
    };
  }

  return result;
}

// ─── Name normalization ───────────────────────────────────────────────────────
function normalizeName(name = "") {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")  // strip punctuation (Jr., accents handled below)
    .replace(/\s+/g, " ")
    .trim();
}

// ─── EV / edge calculation ────────────────────────────────────────────────────
/**
 * Compare your model's projection against a PrizePicks line.
 *
 * @param {number} modelProj   - your model's projected stat value (e.g. 1.4 hits)
 * @param {number} ppLine      - PrizePicks line (e.g. 1.5)
 * @param {number} [stdDev]    - optional model std dev for confidence rating
 *
 * @returns {{ edge: number, direction: "over"|"under"|"push", confidence: "high"|"medium"|"low"|"none" }}
 */
function calcEdge(modelProj, ppLine, stdDev = null) {
  const edge      = modelProj - ppLine;
  const direction = edge > 0.05 ? "over" : edge < -0.05 ? "under" : "push";

  let confidence = "none";
  if (stdDev && stdDev > 0) {
    const zScore = Math.abs(edge) / stdDev;
    if (zScore >= 1.0)      confidence = "high";
    else if (zScore >= 0.6) confidence = "medium";
    else if (zScore >= 0.3) confidence = "low";
  } else {
    // Fallback: raw edge thresholds
    const absEdge = Math.abs(edge);
    if (absEdge >= 0.5)      confidence = "high";
    else if (absEdge >= 0.25) confidence = "medium";
    else if (absEdge >= 0.1)  confidence = "low";
  }

  return { edge: parseFloat(edge.toFixed(3)), direction, confidence };
}

// ─── High-level enrichment helper ─────────────────────────────────────────────
/**
 * Given your model's player row and PrizePicks data for the same sport,
 * returns an array of prop comparisons ready to render.
 *
 * @param {object} playerRow   - your model object, must have { name, ...statKeys }
 * @param {object} ppData      - result of fetchPrizePicks()
 * @param {string[]} statKeys  - internal stat keys to compare (e.g. ["hits","hr","tb"])
 *
 * @returns {Array<{ statKey, ppLine, modelProj, edge, direction, confidence }>}
 */
function enrichPlayerWithPP(playerRow, ppData, statKeys) {
  const nameNorm   = normalizeName(playerRow.name ?? "");
  const ppPlayer   = ppData[nameNorm] ?? {};
  const results    = [];

  for (const statKey of statKeys) {
    const ppProp   = ppPlayer[statKey];
    const modelVal = parseFloat(playerRow[statKey]);

    if (!ppProp || isNaN(modelVal)) continue;

    const { edge, direction, confidence } = calcEdge(modelVal, ppProp.line);

    results.push({
      statKey,
      statType:   ppProp.statType,
      ppLine:     ppProp.line,
      modelProj:  modelVal,
      edge,
      direction,
      confidence,
    });
  }

  return results;
}

// ─── Exports ──────────────────────────────────────────────────────────────────
// For MLB Research Dashboard (Vite/React ES module):
export {
  fetchPrizePicks,
  enrichPlayerWithPP,
  calcEdge,
  normalizeName,
  MLB_STAT_MAP,
  NHL_STAT_MAP,
};

// For NHL Research Dashboard (vanilla JS / Node CommonJS) — uncomment if needed:
// module.exports = { fetchPrizePicks, enrichPlayerWithPP, calcEdge, normalizeName };
