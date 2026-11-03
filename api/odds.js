/**
 * api/odds.js — The Odds API proxy with Supabase daily_odds table
 *
 * GET /api/odds?type=games   → MLB moneylines/spreads
 * GET /api/odds?type=props   → Player prop markets
 *
 * Priority:  daily_odds table (written by morning cron) → Supabase _cache → Odds API
 * The morning cron (api/cron.js) is the ONLY place that calls the Odds API.
 * This endpoint serves cached data for the rest of the day — no credits burned here.
 */

import { cacheGet, cacheSet } from "./_cache.js";

const BOOKS  = "fanduel,draftkings,hardrockbet";
const SPORT  = "baseball_mlb";

const STD_MARKETS = [
  "batter_hits",
  "batter_home_runs",
  "batter_total_bases",
  "batter_hits_runs_rbis",
  "batter_stolen_bases",
  "batter_rbis",
  "pitcher_strikeouts",
  // Pitch Lab pitcher props (src/lib/pitchlab.js) — must match api/cron.js's morning pull.
  "pitcher_outs",
  "pitcher_hits_allowed",
  "pitcher_walks",
  "pitcher_earned_runs",
];

const ALT_MARKETS = [
  "batter_hits_alternate",
  "batter_home_runs_alternate",
  "batter_total_bases_alternate",
  "batter_hits_runs_rbis_alternate",
  "batter_stolen_bases_alternate", // DraftKings only posts SB props on the alternate market
  "batter_rbis_alternate",
  "pitcher_strikeouts_alternate",
];

const ALL_MARKETS = [...STD_MARKETS, ...ALT_MARKETS].join(",");

// Supabase helpers
const SUP_URL = globalThis.process?.env?.SUPABASE_URL;
const SUP_KEY = globalThis.process?.env?.SUPABASE_SERVICE_ROLE_KEY;

function todayET() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

async function getDailyOdds(field) {
  if (!SUP_URL || !SUP_KEY) return null;
  try {
    const today = todayET();
    const res = await fetch(
      `${SUP_URL}/rest/v1/daily_odds?game_date=eq.${today}&select=${field}&limit=1`,
      { headers: { apikey: SUP_KEY, Authorization: `Bearer ${SUP_KEY}` } }
    );
    if (!res.ok) return null;
    const rows = await res.json();
    return rows?.[0]?.[field] ?? null;
  } catch { return null; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Odds API ${res.status}`);
  return res.json();
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const apiKey = globalThis.process?.env?.ODDS_API_KEY;
  const type   = req.query.type || "games";
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");

  // ── Moneylines ────────────────────────────────────────────────────────────────
  if (type === "games") {
    // 1. daily_odds table (set by morning cron)
    const daily = await getDailyOdds("moneyline_data");
    if (daily) {
      res.setHeader("X-Cache", "DAILY");
      return res.status(200).json(daily);
    }

    // 2. Supabase _cache TTL fallback
    const cached = await cacheGet("mlb:odds:moneylines", 8 * 3600);
    if (cached) {
      res.setHeader("X-Cache", "HIT");
      return res.status(200).json(JSON.parse(cached));
    }

    // 3. Live Odds API (only if cron hasn't run yet today)
    if (!apiKey) return res.status(200).json([]);
    try {
      const data = await fetchJson(
        `https://api.the-odds-api.com/v4/sports/${SPORT}/odds/?apiKey=${apiKey}&regions=us&markets=h2h,spreads,totals&bookmakers=${BOOKS}&oddsFormat=american&includeLinks=true&includeSids=true`
      );
      await cacheSet("mlb:odds:moneylines", JSON.stringify(data), 8 * 3600);
      res.setHeader("X-Cache", "MISS");
      return res.status(200).json(data);
    } catch (err) {
      return res.status(200).json([]);  // degrade gracefully
    }
  }

  // ── Player props ──────────────────────────────────────────────────────────────
  if (type === "props") {
    // 1. daily_odds table (set by morning cron — no credits burned here)
    const daily = await getDailyOdds("props_data");
    if (daily) {
      res.setHeader("X-Cache", "DAILY");
      return res.status(200).json(daily);
    }

    // 2. Supabase _cache TTL fallback
    const cached = await cacheGet("mlb:odds:props", 8 * 3600);
    if (cached) {
      res.setHeader("X-Cache", "HIT");
      return res.status(200).json(JSON.parse(cached));
    }

    // 3. Live Odds API (only if cron hasn't run yet today — e.g. first run of season)
    if (!apiKey) return res.status(200).json([]);
    try {
      const events = await fetchJson(
        `https://api.the-odds-api.com/v4/sports/${SPORT}/events?apiKey=${apiKey}`
      );
      const propResponses = [];
      for (const event of events.slice(0, 15)) {
        try {
          const data = await fetchJson(
            `https://api.the-odds-api.com/v4/sports/${SPORT}/events/${event.id}/odds?apiKey=${apiKey}&regions=us&markets=${ALL_MARKETS}&bookmakers=${BOOKS}&oddsFormat=american&includeLinks=true&includeSids=true`
          );
          propResponses.push(data);
        } catch { /* skip failed event */ }
        await sleep(200);
      }
      await cacheSet("mlb:odds:props", JSON.stringify(propResponses), 8 * 3600);
      res.setHeader("X-Cache", "MISS");
      return res.status(200).json(propResponses);
    } catch (err) {
      return res.status(200).json([]);  // degrade gracefully
    }
  }

  // ── Credit usage ──────────────────────────────────────────────────────────────
  if (type === "credits") {
    const daily = await getDailyOdds("odds_credits_used");
    const remaining = await getDailyOdds("odds_credits_remaining");
    return res.status(200).json({ used: daily, remaining });
  }

  return res.status(400).json({ error: "Unknown type. Use games, props, or credits." });
}
