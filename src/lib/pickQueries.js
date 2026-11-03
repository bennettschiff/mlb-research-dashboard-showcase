// ══════════════════════════════════════════════════════════════════════════
// "Has today's save already happened?" — the one query that answers it.
//
// Some prop_types are written to mlb_picks by their OWN cron, entirely outside
// the app's scan → auto-save path:
//   nrfi — scripts/nrfi-picks.mjs via .github/workflows/nrfi-picks.yml
//          (11 AM / 2 PM / 5 PM / 7 PM ET)
//
// A bare `pick_date=eq.<today>&limit=1` therefore answers "does ANY row exist
// for today", which is NOT the question any caller is asking. Every caller
// means "did the app's own save run yet". One cron-owned row makes the answer
// wrongly yes, and the day's real save is skipped.
//
// This has now bitten in five separate copies of the same one-line query:
//   • scripts/daily-picks.mjs pre-check + save poll (2026-07-19, 2026-07-20 —
//     1-2 picks saved instead of dozens; fixed 2026-07-21 in 6fc30d5)
//   • App.jsx auto-save effect + saveTodayPicks guard (2026-07-22 — the app
//     itself refused to save; the driver fix could not reach this)
//   • App.jsx scan-cache Guard 0, which reads the same signal to decide whether
//     the slimmed cache is safe to load. A cron-owned row made it accept slim
//     data, which nulls raw_signals/model_intermediates for the whole day.
//
// So it lives here once, dependency-free, imported by both the browser app and
// the headless Node driver. Add a new cron-owned prop_type to the set below and
// every caller stays correct.
// ══════════════════════════════════════════════════════════════════════════

// prop_types whose rows are written by an independent cron, not by the app's save.
export const CRON_OWNED_PROP_TYPES = ["nrfi"];

// PostgREST filter excluding every cron-owned prop_type.
// One type → `neq`; more than one → `not.in`. (PostgREST has no multi-neq.)
export const EXCLUDE_CRON_OWNED =
  CRON_OWNED_PROP_TYPES.length === 1
    ? `prop_type=neq.${CRON_OWNED_PROP_TYPES[0]}`
    : `prop_type=not.in.(${CRON_OWNED_PROP_TYPES.join(",")})`;

/**
 * PostgREST query params for "the picks the app's own save wrote for `date`".
 * Returns the params only (no table, no `?`), so it composes with both
 * App.jsx's sbGet(table, params) and the driver's `mlb_picks?${params}`.
 */
export function savedPicksParams(date, { select = "id", limit } = {}) {
  const parts = [`pick_date=eq.${date}`, EXCLUDE_CRON_OWNED, `select=${select}`];
  if (limit != null) parts.push(`limit=${limit}`);
  return parts.join("&");
}
