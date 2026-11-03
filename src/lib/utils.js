// ── Shared utilities: constants + date/timezone helpers ───────────────────────

import { registerFetch, unregisterFetch } from "./health.js";

export const API = "https://statsapi.mlb.com/api/v1";
export const APP_TIME_ZONE = "America/New_York";

// Session-lifetime JSON fetch cache. The same statsapi URLs are requested many
// times across a scan, so memoize by URL. Returns null (never throws) on failure.
// A hard timeout (AbortController) prevents a hung upstream — /api/proxy and the
// Supabase routes have been seen hitting the 300s server cap — from leaving a
// click pending indefinitely (dry click / stale freeze). Matches the abort
// pattern used by fetchText and _proxiedFetch elsewhere in the app.
//
// `bypassCache` is for URLs whose CONTENT changes during a session while the URL
// stays fixed — the lineups hydrate is the canonical case: it is requested once
// at page load (nothing posted yet) and memoized as empty for the rest of the
// session, so every later re-read replays "no lineups" no matter how many
// callers bust their own caches. Bypassing skips the memo AND the browser HTTP
// cache, then overwrites the memo so normal callers see the fresh copy too.
// A failed bypass falls back to the stale entry rather than returning null —
// a refresh that can't reach the API must not blank out data we already have.
const _fetchCache = new Map();
export async function fetchJson(url, timeoutMs = 15000, { bypassCache = false } = {}) {
  if (!bypassCache && _fetchCache.has(url)) return _fetchCache.get(url);
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  const hid = registerFetch(url);  // track in-flight for the freeze detector
  try {
    const r = await fetch(url, { signal: ctrl.signal, ...(bypassCache ? { cache: "no-store" } : {}) });
    if (!r.ok) throw new Error(r.status);
    const data = await r.json();
    _fetchCache.set(url, data);
    return data;
  } catch (e) {
    console.error("Fetch:", url, e);
    return bypassCache && _fetchCache.has(url) ? _fetchCache.get(url) : null;
  }
  finally { clearTimeout(tid); unregisterFetch(hid); }
}

// Access-code header for mutating API calls. The gate stores the validated code
// in localStorage("mlb_auth"); the headless daily driver seeds the same value.
// Server endpoints (api/picks, api/golden-snapshots) require it on POST/PATCH/DELETE.
// Lives here rather than in App.jsx so extracted components can write without
// importing back into App.
export function accessCodeHeader() {
  try {
    const code = localStorage.getItem("mlb_auth");
    return code ? { "X-Access-Code": code } : {};
  } catch { return {}; }
}

export function formatDateInTimeZone(date = new Date(), timeZone = APP_TIME_ZONE) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function getTodayInAppTimeZone() {
  return formatDateInTimeZone(new Date(), APP_TIME_ZONE);
}

export function getHourInTimeZone(timeZone = APP_TIME_ZONE) {
  return Number(new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    hour12: false,
  }).format(new Date()));
}

// ── Shared display helpers (moved out of App.jsx 2026-07-06, PropsBoard extraction) ──

// American-odds display: +145 / -120 / null → null
export function formatOdds(price) {
  if (price == null) return null;
  return price > 0 ? `+${price}` : `${price}`;
}

// Loose player-name normalizer for cross-source joins (odds feeds, lineups):
// strips accents, suffixes (Jr/Sr/II–IV), punctuation; collapses whitespace.
export const normName = n => n?.toLowerCase()
  .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, "")
  .replace(/[^a-z\s]/g, "")
  .replace(/\s+/g, " ").trim() || "";

// MLB team id → [primary, secondary] brand colors
export const TEAM_COLORS = {
  108:["#A71930","#000"],109:["#A71930","#E3D4AD"],110:["#DF4601","#000"],
  111:["#BD3039","#0C2340"],112:["#CC3433","#0C2340"],113:["#27251F","#C4CED4"],
  114:["#C6011F","#000"],115:["#E31937","#002B5C"],116:["#0C2340","#FA4616"],
  117:["#002D62","#EB6E1F"],118:["#003831","#EFB21E"],119:["#003263","#C4CED4"],
  120:["#27251F","#FDB827"],121:["#005A9C","#EF3E42"],133:["#003831","#EFB21E"],
  134:["#FD5A1E","#27251F"],135:["#002D62","#C4CED4"],136:["#E81828","#002147"],
  137:["#FD5A1E","#27251F"],138:["#C41E3A","#0C2340"],139:["#E8291C","#FFC425"],
  140:["#003278","#C4CED4"],141:["#134A8E","#1D2D5C"],142:["#005C5C","#000"],
  143:["#AB0003","#0C2340"],144:["#002D72","#FF5910"],145:["#27251F","#C4CED4"],
  146:["#C41E3A","#0C2340"],147:["#002D62","#FFC425"],158:["#0A2351","#B6922E"],
};
export const getTeamColor = (id) => TEAM_COLORS[id] || ["#333","#888"];
