/**
 * api/health-log.js — sink for client-side freeze events (no DB writes).
 *
 * The browser freeze detector (src/lib/health.js) beacons a JSON event here
 * whenever the main thread stalls. We just console.log it so it lands in the
 * Vercel function logs — durable, queryable in the Vercel dashboard, and zero
 * load on the shared Supabase. Always returns 204; sendBeacon ignores the body.
 *
 * Each line is prefixed [client-health] for easy grep/filter in Vercel logs.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }
  try {
    // Body may arrive parsed (Vercel) or raw (sendBeacon Blob). Normalize.
    let event = req.body;
    if (typeof event === 'string') {
      try { event = JSON.parse(event); } catch { /* leave as string */ }
    }
    const summary = event && typeof event === 'object'
      ? {
          at: event.at,
          stallMs: event.stallMs,
          longestTaskMs: event.longestTaskMs,
          lastAction: event.lastAction?.label,
          pending: (event.pending || []).map((p) => `${p.url} (${p.pendingMs}ms)`),
          url: event.url,
          ua: event.ua,
        }
      : event;
    console.log('[client-health]', JSON.stringify(summary));
  } catch (err) {
    console.log('[client-health] parse-error', err?.message);
  }
  res.status(204).end();
}
