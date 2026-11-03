import { requireWriteAuth } from "./_auth.js";
import { handleFreshness } from "./_freshness.js";

const TABLE = "mlb_picks";

function getEnv(name) {
  const value = globalThis.process?.env?.[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function parseBody(body) {
  if (body == null) return null;
  if (typeof body === "string") {
    return body.length ? JSON.parse(body) : null;
  }
  return body;
}

async function relaySupabase(method, query = "", body, table = TABLE) {
  const url = getEnv("SUPABASE_URL");
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  const qs = query ? `?${query}` : "";
  const res = await fetch(`${url}/rest/v1/${table}${qs}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: method === "PATCH" ? "return=minimal" : "return=representation",
    },
    body: body == null ? undefined : JSON.stringify(body),
  });

  if (res.status === 204) return { status: 204, data: null };

  const text = await res.text();
  if (!res.ok) {
    throw new Error(text || `Supabase request failed (${res.status})`);
  }

  return { status: res.status, data: text ? JSON.parse(text) : null };
}

// ── pick_signals snapshot (async, non-blocking) ──────────────────────────────
// For player-prop picks: look up the player in today's scan_results row and
// snapshot the model output.
// For game-line picks (ml/rl/ou): the caller attaches `_signals` directly to
// the pick row (slate model isn't in scan_results); we strip it before relay
// and use it after the pick row comes back with an id.
//
// Failure is non-fatal — we never block pick creation on this. Logs to console.
const MARKET_SOURCE = {
  hits:    { kind: "players",  modelKey: "hits" },
  hits15:  { kind: "players",  modelKey: "hits" },
  hr:      { kind: "players",  modelKey: "hr"   },
  hrr:     { kind: "players",  modelKey: "hrr"  },
  tb:      { kind: "players",  modelKey: "tb"   },
  sb:      { kind: "players",  modelKey: "sb"   },
  rbi:     { kind: "players",  modelKey: "rbi"  },
  ks:      { kind: "pitchers", modelKey: null   }, // whole pitcher result IS the model
  // Pitch Lab pitcher props (src/lib/pitchlab.js) — always saved with an inline _snapshot.
  outs:         { kind: "pitchers", modelKey: null },
  hits_allowed: { kind: "pitchers", modelKey: null },
  walks:        { kind: "pitchers", modelKey: null },
  er:           { kind: "pitchers", modelKey: null },
};
const GAME_MARKETS = new Set(["ml", "rl", "ou"]);

// Fields excluded from Ks pitcher snapshot (large/redundant)
const KS_OMIT = new Set([
  "name", "team", "hand", "opponent", "isHome", "gamePk", "venue", "parkAbbrev",
  "proj", "game", "advancedStats", "umpireInfo",
  "rateL5", "rateL10", "rateL20", "drought",
]);

async function insertPickSignalRow(row) {
  const url = getEnv("SUPABASE_URL");
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  const insertRes = await fetch(
    `${url}/rest/v1/pick_signals?on_conflict=pick_id`,
    {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(row),
    }
  );
  if (!insertRes.ok) {
    const txt = await insertRes.text();
    console.warn(`[pick_signals] insert failed: ${insertRes.status} ${txt.slice(0, 200)}`);
    return false;
  }
  return true;
}

async function snapshotGamePickSignals(pick) {
  // Game lines pass the model snapshot inline via `_signals` on the pick row.
  const signals = pick._signals;
  if (!signals) {
    console.warn(`[pick_signals] no _signals attached to game pick ${pick.id} (${pick.prop_type})`);
    return;
  }
  const ok = await insertPickSignalRow({
    pick_id:     pick.id,
    pick_date:   pick.pick_date,
    market:      pick.prop_type,
    direction:   pick.direction,
    conf:        pick.conf,
    model_score: pick.model_score,
    signals,
    adv_stats:   null,
  });
  if (ok) console.log(`[pick_signals] captured pick ${pick.id} (${pick.prop_type})`);
}

async function snapshotPickSignals(pick) {
  if (GAME_MARKETS.has(pick.prop_type)) return snapshotGamePickSignals(pick);

  const cfg = MARKET_SOURCE[pick.prop_type];
  if (!cfg) return; // unknown market

  // Primary path: inline `_snapshot` sidecar attached by saveTodayPicks. Avoids
  // the daily_scan_results dependency, which has been failing with 413 on the
  // scan-results POST since extraSignals landed (commit 33ee852). Until this
  // landed, every pick saved with raw_signals/model_intermediates/game_context = null.
  if (pick._snapshot) {
    const s = pick._snapshot;
    const ok = await insertPickSignalRow({
      pick_id:     pick.id,
      pick_date:   pick.pick_date,
      market:      pick.prop_type,
      direction:   pick.direction,
      conf:        pick.conf,
      model_score: pick.model_score,
      signals:             s.signals     || null,
      adv_stats:           s.adv_stats   || null,
      raw_signals:         s.raw_signals || null,
      model_intermediates: s.model_intermediates || null,
      game_context:        s.game_context || null,
    });
    if (ok) console.log(`[pick_signals] captured pick ${pick.id} (${pick.prop_type}) via inline snapshot`);
    return;
  }

  // Fallback path: legacy DB lookup against daily_scan_results. Kept for back-
  // compat with any pick row that lacks a sidecar (manual inserts, older clients).
  const url = getEnv("SUPABASE_URL");
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };

  const scanRes = await fetch(
    `${url}/rest/v1/daily_scan_results?game_date=eq.${pick.pick_date}&select=results`,
    { headers }
  );
  if (!scanRes.ok) {
    console.warn(`[pick_signals] no scan_results for ${pick.pick_date}`);
    return;
  }
  const scanRows = await scanRes.json();
  if (!scanRows?.length) return;
  const results = scanRows[0].results;

  const arr = results?.[cfg.kind] || [];
  const idKey = cfg.kind === "pitchers" ? "pitcherId" : "playerId";
  const player = arr.find(p => p[idKey] === pick.player_id);
  if (!player) {
    console.warn(`[pick_signals] player ${pick.player_id} not in ${cfg.kind} for ${pick.pick_date}`);
    return;
  }

  let signals;
  if (cfg.kind === "pitchers") {
    signals = {};
    for (const [k, v] of Object.entries(player)) {
      if (!KS_OMIT.has(k) && k !== "extraSignals") signals[k] = v;
    }
  } else {
    signals = (player.models || {})[cfg.modelKey];
    if (!signals) {
      console.warn(`[pick_signals] no models.${cfg.modelKey} for player ${pick.player_id}`);
      return;
    }
  }

  const extra = player.extraSignals || {};

  const ok = await insertPickSignalRow({
    pick_id:     pick.id,
    pick_date:   pick.pick_date,
    market:      pick.prop_type,
    direction:   pick.direction,
    conf:        pick.conf,
    model_score: pick.model_score,
    signals,
    adv_stats:   player.advancedStats || null,
    raw_signals:        extra.raw_signals || null,
    model_intermediates: extra.model_intermediates || null,
    game_context:       extra.game_context || null,
  });
  if (ok) console.log(`[pick_signals] captured pick ${pick.id} (${pick.prop_type})`);
}

// Run snapshots for one or more newly-created picks. Promise.allSettled so a
// single failure doesn't poison the batch. Awaited by the caller — Vercel
// Fluid Compute kills the invocation when the handler returns, so detached
// background work was silently dropped (≈10 of 11 player-prop snapshots/day
// were lost from 2026-05-31 through 2026-06-01 before this was caught).
async function runSnapshots(picks) {
  const list = Array.isArray(picks) ? picks : [picks];
  try {
    await Promise.allSettled(list.filter(Boolean).map(snapshotPickSignals));
  } catch (e) {
    console.warn("[pick_signals] batch error:", e?.message);
  }
}

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      // Edge-controller controls (written daily by scripts/edge-controller.mjs).
      // Folded in here instead of its own api/market-health.js file: the Hobby
      // plan caps the project at 12 serverless functions and this repo is at
      // exactly 12 — a 13th function fails the whole deploy at output time.
      // Read-only, no auth (same stance as the picks GET below).
      // Per-source data-freshness heartbeat, schedule-aware so an off-day reads
      // IDLE rather than broken (same fold-in pattern — see api/_freshness.js).
      if (req.query.view === "freshness") {
        await handleFreshness(req, res);
        return;
      }
      // Pitch Lab morning scores for one slate date (db/migrations/019, scripts/pitchlab/score.py).
      // Folded in here rather than a new api/ route: the deployment sits at Vercel's 12-function cap.
      if (req.query.view === "pitchlab") {
        const date = String(req.query.date || "");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          res.status(400).json({ error: "view=pitchlab needs date=YYYY-MM-DD" });
          return;
        }
        const result = await relaySupabase(
          "GET", `select=game_date,model_version,generated_at,payload&game_date=eq.${date}&limit=1`,
          undefined, "pitchlab_predictions");
        const row = Array.isArray(result.data) ? result.data[0] ?? null : null;
        // Written once each morning; a short CDN cache is plenty, browsers always revalidate.
        res.setHeader("Cache-Control", "public, max-age=0, must-revalidate, s-maxage=300, stale-while-revalidate=1800");
        res.status(200).json(row);
        return;
      }
      if (req.query.view === "market-health") {
        const since = new Date(Date.now() - 120 * 86400_000).toISOString().slice(0, 10);
        const qs =
          `select=eval_date,market,status,unit_mult,prob_shift,avg_clv_pp,n_clv,n_graded,units_pl,pl_per_pick,cash_pct,calib_gap_pp,reasons` +
          `&eval_date=gte.${since}&order=eval_date.asc`;
        const result = await relaySupabase("GET", qs, undefined, "market_health");
        // CDN caches 10 min / serves stale 1 h (fine for a once-daily writer),
        // but browsers must always revalidate — without max-age=0 heuristic
        // browser caching served stale statuses (seen in dev 2026-07-02).
        res.setHeader("Cache-Control", "public, max-age=0, must-revalidate, s-maxage=600, stale-while-revalidate=3600");
        res.status(200).json({ rows: result.data ?? [] });
        return;
      }
      const result = await relaySupabase("GET", req.query.query || "");
      res.status(result.status).json(result.data);
      return;
    }

    // All mutating methods require the access-code header (see api/_auth.js).
    if (!requireWriteAuth(req, res)) return;

    if (req.method === "POST") {
      // Strip sidecar fields (_signals for game lines, _snapshot for batter/Ks
      // picks) before relaying to Supabase — mlb_picks has no such columns.
      // After insert, re-attach by index so snapshotPickSignals can read them
      // without depending on daily_scan_results existing.
      const body = parseBody(req.body);
      let stash = null;
      let cleaned = body;
      const extractSidecars = (r) => ({
        _signals:  r?._signals  ?? null,
        _snapshot: r?._snapshot ?? null,
      });
      const stripSidecars = (r) => {
        if (!r) return r;
        const { _signals, _snapshot, ...rest } = r; // eslint-disable-line no-unused-vars
        return rest;
      };
      if (Array.isArray(body)) {
        stash = body.map(extractSidecars);
        cleaned = body.map(stripSidecars);
      } else if (body && typeof body === "object" && ("_signals" in body || "_snapshot" in body)) {
        stash = [extractSidecars(body)];
        cleaned = stripSidecars(body);
      }
      const result = await relaySupabase("POST", "", cleaned);
      if (result.data && stash) {
        const rows = Array.isArray(result.data) ? result.data : [result.data];
        rows.forEach((row, i) => {
          if (!row || !stash[i]) return;
          if (stash[i]._signals)  row._signals  = stash[i]._signals;
          if (stash[i]._snapshot) row._snapshot = stash[i]._snapshot;
        });
      }
      // Await snapshots before responding. Vercel Fluid Compute kills the
      // invocation when the handler returns, so detached background work
      // was being dropped (~10/11 player-prop snapshots/day were lost).
      // Snapshot inserts are ~few hundred ms in parallel, well under the
      // 300s function timeout, and picks-save is already async to the user.
      if (result.data) await runSnapshots(result.data);
      res.status(result.status).json(result.data);
      return;
    }

    if (req.method === "PATCH") {
      const result = await relaySupabase("PATCH", req.query.query || "", parseBody(req.body));
      if (result.status === 204) {
        res.status(204).end();
        return;
      }
      res.status(result.status).json(result.data);
      return;
    }

    if (req.method === "DELETE") {
      // Require a query filter — guard against accidental table wipe.
      const q = req.query.query || "";
      if (!q || !q.includes("=")) {
        res.status(400).json({ error: "DELETE requires a query filter (e.g. pick_date=eq.2026-05-26)" });
        return;
      }
      const result = await relaySupabase("DELETE", q);
      if (result.status === 204) {
        res.status(204).end();
        return;
      }
      res.status(result.status).json(result.data);
      return;
    }

    res.status(405).json({ error: "Method not allowed" });
  } catch (error) {
    res.status(500).json({ error: error.message || "Picks proxy failed" });
  }
}
