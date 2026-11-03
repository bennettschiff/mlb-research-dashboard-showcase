// Watchdog ping ledger — the judgment, kept pure and tested.
//
// WHY A LEDGER AND NOT JUST A CHECK (2026-08-28)
// Every existing alarm is hosted by the thing it watches. ops-alert.yml is a
// GitHub workflow reacting to GitHub workflows, so an account-wide `schedule`
// outage silences the watcher and the watched together — which is exactly what
// happened from 2026-08-26 on, and why a stale player_day_panel was first seen
// by a human reading the dashboard two days later.
//
// So the watchdogs do not alarm; they PING. Each one writes a row saying "I ran,
// here is what I found". The alarm is a different system — Vercel serving
// api/_freshness.js to a browser that polls every 10 minutes — asking whether
// those rows are recent. A watchdog that dies stops writing, and its silence is
// itself the finding. Nothing in that path depends on GitHub delivering
// anything.
//
// Two independent pingers, each covering the other's blind spot:
//   github_actions — runs in Actions, has GITHUB_TOKEN, so it is the only one
//                    that can see "workflow X never ran" and "workflow X is
//                    disabled_manually". Dies when Actions dies.
//   vercel_cron    — driven by Supabase pg_cron → /api/cron (the independent
//                    scheduler added in db/migrations/013). Cannot see GitHub,
//                    but proves the non-GitHub path is alive and re-checks the
//                    data-freshness verdict on a schedule GitHub cannot break.

/** Ping sources, their expected cadence, and how long silence is tolerated. */
export const PINGERS = [
  {
    source: "github_actions",
    cadence: "2× daily (Actions)",
    // Fires 07:15 and 15:30 UTC, so the honest worst case between pings is
    // 15h45m. Past 20h the pinger itself has missed a delivery.
    maxAgeH: 20,
  },
  {
    source: "vercel_cron",
    cadence: "hourly (pg_cron)",
    // Hourly; 3h of silence means the independent scheduler is down too, which
    // is the one condition under which nothing is watching anything.
    maxAgeH: 3,
  },
];

// How long a "this cron never arrived" finding stays believable.
//
// WHY A VERDICT HAS TO EXPIRE (2026-08-31)
// The github_actions pinger only checks twice a day, so its verdict is a
// SNAPSHOT of one moment that the banner then asserted as present tense for up
// to sixteen hours. On 2026-08-31 the 15:07Z ping reported four workflows "not
// delivered"; all four ran between 15:28Z and 19:00Z, and the dashboard still
// read "Pipeline down" at 4:26 PM ET with every one of them long since green.
//
// The asymmetry that makes this safe: a late delivery REPAIRS ITSELF — a
// workflow reported overdue is precisely one that is about to run — whereas a
// DISABLED workflow never does. So an overdue-only finding stops being evidence
// once it is older than the window in which those deliveries land, while a
// disabled one keeps full severity forever. And a genuine outage does not slip
// through: it turns into stale DATA, which the hourly vercel_cron pinger reports
// on evidence that is never more than an hour old.
export const OVERDUE_CONFIDENCE_H = 3;

const trunc = (list, n = 3) =>
  list.length <= n ? list.join(", ") : `${list.slice(0, n).join(", ")} +${list.length - n} more`;

/** Findings that will NOT resolve on their own, so their age never softens them. */
function hasPermanentFinding(detail) {
  return ((detail || {}).disabled || []).length > 0;
}

/** One-line summary of what a TRIPPED ping found. */
export function summarize(detail) {
  const d = detail || {};
  const parts = [];
  const disabled = d.disabled || [];
  const overdue = d.overdue || [];
  const stale = d.stale || [];
  if (disabled.length) parts.push(`${disabled.length} workflow(s) DISABLED: ${trunc(disabled.map((w) => w.name))}`);
  if (overdue.length) {
    parts.push(`${overdue.length} cron(s) not delivered: ` +
      trunc(overdue.map((w) => `${w.name} (${((w.lateMinutes ?? 0) / 60).toFixed(1)}h late)`)));
  }
  if (stale.length) parts.push(`${stale.length} source(s) stale: ${trunc(stale.map((s) => s.label ?? s))}`);
  if (d.note) parts.push(d.note);
  return parts.join("; ") || "tripped with no detail recorded";
}

/**
 * Verdict for one ping source, in the same vocabulary api/_freshness.js uses so
 * the dashboard banner can render it without a special case.
 *
 * STALE is used for both "the pinger went quiet" and "the pinger reported a
 * problem" on purpose: to a reader the pipeline is equally down either way, and
 * a second severity would just be a second thing to learn.
 */
export function evaluatePing(pinger, row, now) {
  const cadence = pinger.cadence;
  if (!row || !row.pinged_at) {
    return { status: "STALE", ageH: null, cadence,
      detail: "watchdog has never checked in" };
  }
  const ageH = Math.round(((now - new Date(row.pinged_at)) / 3600000) * 10) / 10;
  if (ageH > pinger.maxAgeH) {
    return { status: "STALE", ageH, cadence,
      detail: `watchdog silent for ${ageH}h (${cadence}, budget ${pinger.maxAgeH}h) — ` +
        `the scheduler itself is not running` };
  }
  if (row.status === "TRIPPED") {
    const detail = summarize(row.detail);
    // Still inside the window where the finding is present tense, or it is the
    // kind that never self-heals: report it at full severity.
    if (hasPermanentFinding(row.detail) || ageH <= OVERDUE_CONFIDENCE_H) {
      return { status: "STALE", ageH, cadence, detail };
    }
    // Older than that and the only findings repair themselves. Downgrade to the
    // "gap" tier: still visible on the dashboard, no longer claiming the
    // pipeline is down right now — because nothing here actually knows that.
    return {
      status: "GAP", ageH, cadence,
      detail: `${detail} — as of a check ${ageH}h ago, not re-verified since ` +
        `(late deliveries arrive on their own)`,
    };
  }
  return { status: "OK", ageH, cadence, detail: `checked ${ageH}h ago, clean` };
}
