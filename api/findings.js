/**
 * api/findings.js — read-only relay for mining_findings.
 *
 * Mining-cron writes findings server-side (via GitHub Actions with service-role key).
 * This endpoint exposes them to the app's Findings tab, with filtering on market,
 * status, finding_type, and lookback window.
 *
 * GET /api/findings?market=hr&status=active&type=univariate&since=2026-05-01&limit=200
 *   → 200 most-recent active univariate findings for HR market since 2026-05-01
 *
 * GET /api/findings?id=12345 → single finding (full raw_data drill-down)
 */
const TABLE = 'mining_findings';

function getEnv(name) {
  const value = globalThis.process?.env?.[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    const { id, market, status, type, since, limit, order } = req.query || {};

    // mining_findings lives on the LAB project (moved 2026-08-11 to get the serving database
    // off 91.6% of the free plan's 500 MB cap). This route is the Findings page's only data
    // source, so it must follow the table — reading SERVE now returns PGRST205 "relation does
    // not exist" and the page renders empty.
    //
    // Falls back to SERVE when LAB is unconfigured so a preview deployment without the new
    // secrets degrades to the old behaviour instead of 500-ing.
    const url = process.env.LAB_SUPABASE_URL || getEnv('SUPABASE_URL');
    const key = process.env.LAB_SUPABASE_SERVICE_ROLE_KEY || getEnv('SUPABASE_SERVICE_ROLE_KEY');

    // Build PostgREST query
    const params = [];
    if (id) params.push(`id=eq.${encodeURIComponent(id)}`);
    if (market && market !== 'all') params.push(`market=eq.${encodeURIComponent(market)}`);
    if (status) params.push(`status=eq.${encodeURIComponent(status)}`);
    if (type) params.push(`finding_type=eq.${encodeURIComponent(type)}`);
    if (since) params.push(`cycle_id=gte.${encodeURIComponent(since)}`);

    // Default order: latest cycle first, then by absolute effect size
    const ord = order || 'cycle_id.desc,q_value.asc';
    params.push(`order=${ord}`);

    const lim = parseInt(limit || '200', 10);
    params.push(`limit=${Math.min(lim, 1000)}`);

    const qs = params.join('&');
    const supaUrl = `${url}/rest/v1/${TABLE}?${qs}`;

    const r = await fetch(supaUrl, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Prefer: 'count=exact',
      },
    });
    if (!r.ok) {
      const txt = await r.text();
      res.status(r.status).json({ error: txt.slice(0, 400) });
      return;
    }
    const data = await r.json();
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message || 'findings query failed' });
  }
}
