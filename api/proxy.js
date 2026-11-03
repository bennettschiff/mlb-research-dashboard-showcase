/**
 * api/proxy.js — Server-side URL proxy with Supabase caching
 *
 * GET /api/proxy?url=<encoded-url>&ttl=<seconds>&ct=text&fresh=1
 *   url   — the URL to fetch (required)
 *   ttl   — cache TTL in seconds (default 3600; 0 = no cache)
 *   ct    — expected content-type hint: "text" (default) or "json"
 *   fresh — 1 = skip the cache READ, go upstream, then store the result under
 *           the normal ttl. For user-initiated refreshes: the Rotowire lineups
 *           page is proxied at ttl=1800, so "↻ Lineups" could only ever see a
 *           copy up to 30 min old no matter how many client caches it busted.
 *           Distinct from ttl=0, which skips the read AND the write and so
 *           leaves the stale row in place for the next ordinary load.
 *
 * Replaces the browser-side public CORS proxies (allorigins.win, corsproxy.io).
 * Returns raw text/JSON so callers can parse exactly as before.
 */

import { cacheGet, cacheSet } from "./_cache.js";

const DEFAULT_TTL = 3600; // 1 hour

// Hosts the app actually fetches through this proxy. Anything else is refused
// so the public deployment can't be used as an open proxy (SSRF/abuse).
const ALLOWED_HOSTS = new Set([
  "statsapi.mlb.com",      // schedules, game logs, live feeds
  "baseballsavant.mlb.com", // Statcast leaderboards / CSVs (cron-warmed cache)
  "www.rotowire.com",      // daily lineups + news RSS
  "news.google.com",       // player news RSS
  "umpscorecards.com",     // umpire stats
]);

const FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
};

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const targetUrl = req.query.url;
  if (!targetUrl) {
    return res.status(400).json({ error: "Missing url parameter" });
  }

  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return res.status(400).json({ error: "Invalid url parameter" });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return res.status(403).json({ error: "Protocol not allowed" });
  }
  if (!ALLOWED_HOSTS.has(parsed.hostname)) {
    return res.status(403).json({ error: `Host not allowed: ${parsed.hostname}` });
  }

  const ttl = req.query.ttl !== undefined ? parseInt(req.query.ttl) : DEFAULT_TTL;
  const useCache = ttl > 0;
  const fresh = req.query.fresh === "1" || req.query.fresh === "true";

  // ── Cache check ────────────────────────────────────────────────────────────
  if (useCache && !fresh) {
    const cached = await cacheGet(targetUrl, ttl);
    if (cached !== null) {
      res.setHeader("X-Cache", "HIT");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      return res.status(200).end(cached);
    }
  }

  // ── Live fetch ─────────────────────────────────────────────────────────────
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    const upstream = await fetch(targetUrl, {
      headers: FETCH_HEADERS,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!upstream.ok) {
      return res
        .status(502)
        .json({ error: `Upstream returned ${upstream.status}: ${targetUrl}` });
    }

    const text = await upstream.text();

    // ── Store in cache ───────────────────────────────────────────────────────
    if (useCache && text) {
      await cacheSet(targetUrl, text, ttl).catch(() => {
        // Non-fatal — cache miss just means a slower next request
      });
    }

    res.setHeader("X-Cache", "MISS");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.status(200).end(text);
  } catch (err) {
    if (err.name === "AbortError") {
      return res.status(504).json({ error: "Upstream request timed out" });
    }
    return res.status(502).json({ error: err.message || "Proxy fetch failed" });
  }
}
