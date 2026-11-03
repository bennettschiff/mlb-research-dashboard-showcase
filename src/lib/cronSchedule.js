// Cron-delivery math for the pipeline watchdog.
//
// WHY THIS EXISTS (2026-08-28)
// Every alarm we had keys off a job that RAN and produced something wrong. None
// of them can see a job that never ran at all: ops-alert.yml triggers on
// `workflow_run: completed`, and a schedule GitHub never delivers emits no such
// event. On 2026-08-26 GitHub stopped delivering `schedule` account-wide (see
// db/migrations/013) and the first signal was a human noticing a red banner two
// days later. This is the missing assertion: for every workflow with a cron,
// compare its most recent SCHEDULED fire against when it actually last ran.
//
// Also catches `disabled_manually`, which is the same failure with a different
// cause — lab-analyst.yml sat disabled 2026-07-25 → 08-10 and nothing noticed,
// because a disabled workflow, like an undelivered one, is simply silent.
//
// Everything here is pure so the judgment is testable without GitHub: its
// failure mode is reporting OK while the pipeline is dead, which is exactly the
// mode that hides for weeks.

const MIN = 60_000;

// ── Cron parsing ─────────────────────────────────────────────────────────────
// Standard 5-field UTC cron: minute hour day-of-month month day-of-week.
// Supports *, a, a-b, a,b, */n and a-b/n — the whole vocabulary used by
// .github/workflows, and anything richer is rejected loudly rather than
// silently mis-parsed into a schedule that never matches.

function expandField(spec, min, max, label) {
  const out = new Set();
  for (const part of String(spec).split(",")) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part.trim());
    if (!m) throw new Error(`unsupported cron ${label} field: "${spec}"`);
    const [, range, stepRaw] = m;
    const step = stepRaw ? Number(stepRaw) : 1;
    if (!step) throw new Error(`zero step in cron ${label} field: "${spec}"`);
    let lo, hi;
    if (range === "*") { lo = min; hi = max; }
    else if (range.includes("-")) { [lo, hi] = range.split("-").map(Number); }
    else { lo = hi = Number(range); if (stepRaw) hi = max; }
    if (lo < min || hi > max || lo > hi) {
      throw new Error(`out-of-range cron ${label} field: "${spec}"`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/** Parse one 5-field cron expression into matchable sets (UTC). */
export function parseCron(expr) {
  const f = String(expr).trim().split(/\s+/);
  if (f.length !== 5) throw new Error(`cron needs 5 fields, got ${f.length}: "${expr}"`);
  const [min, hour, dom, mon, dow] = f;
  return {
    min: expandField(min, 0, 59, "minute"),
    hour: expandField(hour, 0, 23, "hour"),
    dom: expandField(dom, 1, 31, "day-of-month"),
    mon: expandField(mon, 1, 12, "month"),
    // 7 and 0 both mean Sunday; normalise so Date.getUTCDay() (0-6) matches.
    dow: new Set([...expandField(dow, 0, 7, "day-of-week")].map((d) => (d === 7 ? 0 : d))),
    domStar: dom.trim() === "*",
    dowStar: dow.trim() === "*",
  };
}

// Cron's one genuinely surprising rule: when BOTH day-of-month and day-of-week
// are restricted the match is OR, not AND. Getting this backwards would make a
// restricted schedule look like it fires far less often than it does, which in
// this file means a false "overdue".
function dayMatches(c, date) {
  if (!c.mon.has(date.getUTCMonth() + 1)) return false;
  const dom = c.dom.has(date.getUTCDate());
  const dow = c.dow.has(date.getUTCDay());
  if (!c.domStar && !c.dowStar) return dom || dow;
  return (c.domStar || dom) && (c.dowStar || dow);
}

// A monthly cron ('0 13 1 * *') can be 31 days between fires, so the walk has
// to reach back further than that before concluding "never scheduled".
const SEARCH_DAYS = 40;

/**
 * The most recent scheduled fire time at or before `now`, or null if this cron
 * has no fire in the last SEARCH_DAYS. Walks whole days backwards and only then
 * scans that day's hour/minute sets, so a monthly cron costs 40 day-checks
 * rather than 57,600 minute-checks.
 */
export function prevFire(cron, now) {
  const c = typeof cron === "string" ? parseCron(cron) : cron;
  const hours = [...c.hour].sort((a, b) => b - a);
  const mins = [...c.min].sort((a, b) => b - a);
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  for (let d = 0; d <= SEARCH_DAYS; d++) {
    const day = new Date(midnight - d * 86400000);
    if (!dayMatches(c, day)) continue;
    for (const h of hours) {
      for (const m of mins) {
        const t = new Date(day.getTime() + h * 3600000 + m * MIN);
        if (t <= now) return t;
      }
    }
  }
  return null;
}

/** Most recent fire across a workflow's full set of cron lines. */
export function lastDue(crons, now) {
  let best = null;
  for (const expr of crons) {
    const t = prevFire(expr, now);
    if (t && (!best || t > best)) best = t;
  }
  return best;
}

/**
 * How long this workflow normally waits between fires, in minutes. Measured
 * from the schedule itself (the gap before the most recent fire) rather than
 * assumed, because the crons here range from every 30 minutes to monthly.
 */
export function periodMinutes(crons, now) {
  const t1 = lastDue(crons, now);
  if (!t1) return null;
  const t0 = lastDue(crons, new Date(t1.getTime() - MIN));
  return t0 ? Math.round((t1 - t0) / MIN) : 24 * 60;
}

// How late GitHub's own `schedule` delivery normally is. Measured, not guessed:
// through 2026-08 the p75 delay between a cron's nominal fire and the run
// actually starting was 4h08m, and the tail runs past five hours. api/_freshness.js
// already judges data staleness as "last slot + 6h" for the same reason
// (2026-08-30); this is that constant, applied to the workflow layer.
export const DELIVERY_LAG_MINUTES = 6 * 60;

// How late a delivery may be before we call it dropped.
//
// This used to scale with the workflow's own period — floor 90 min, ceiling
// 4h — which is the wrong model, and it made the banner lie every single day.
// A workflow's period says how long its OUTPUT may be stale; it says nothing
// about how late GitHub delivers, and GitHub's lag is the same ~4h whether the
// cron is half-hourly or daily. So a 12-hourly job got 3h of grace against a
// 4h+ typical delay and tripped on healthy behaviour: on 2026-08-31 the beacon
// reported four workflows "not delivered" and all four ran within the hour.
// An alarm that fires on the normal case is an alarm that stops being read.
//
// So the floor is GitHub's delivery lag, for every workflow. On top of that a
// slow cron still gets a quarter-period (a weekly job late by six hours is
// nothing), capped at a day so nothing is allowed to vanish unnoticed.
export function graceMinutes(crons, now) {
  const p = periodMinutes(crons, now);
  if (!p) return DELIVERY_LAG_MINUTES;
  return Math.max(DELIVERY_LAG_MINUTES, Math.min(24 * 60, Math.round(p * 0.25)));
}

/**
 * The verdict for one workflow.
 *
 * `lastRunAt` is the newest run of ANY event (schedule, dispatch, a manual
 * re-run). The question this answers is "did the work happen", not "did the
 * schedule specifically deliver" — a job someone kicked by hand produced its
 * output, and alarming on it would train the banner-blindness this replaces.
 */
export function evaluateWorkflow({ name, crons = [], state = "active", lastRunAt, now }) {
  const base = { name, status: "OK", detail: "", dueAt: null, lateMinutes: null };

  // A disabled workflow's cron cannot fire at all, so the freshness question
  // below would never trip — it has to be its own finding.
  if (state && state !== "active") {
    return { ...base, status: "DISABLED", detail: `workflow is ${state} — its cron cannot fire` };
  }
  if (!crons.length) return { ...base, detail: "no cron" };

  const due = lastDue(crons, now);
  if (!due) return { ...base, detail: `no scheduled fire in the last ${SEARCH_DAYS}d` };

  const grace = graceMinutes(crons, now);
  const lateMinutes = Math.round((now - due) / MIN);
  const dueAt = due.toISOString();

  // Still inside the window where a normally-late delivery is expected.
  if (lateMinutes <= grace) return { ...base, dueAt, lateMinutes, detail: "due recently" };

  if (!lastRunAt) {
    return { ...base, status: "OVERDUE", dueAt, lateMinutes, detail: "has never run" };
  }
  // One minute of slack: GitHub stamps a run's created_at a beat after the
  // nominal fire time, and an exact `>=` would flag every punctual run.
  if (new Date(lastRunAt).getTime() >= due.getTime() - MIN) {
    return { ...base, dueAt, lateMinutes, detail: "ran for the latest fire" };
  }
  return {
    ...base,
    status: "OVERDUE",
    dueAt,
    lateMinutes,
    detail: `due ${dueAt.slice(11, 16)}Z, no run since ${String(lastRunAt).slice(0, 16)}Z ` +
      `(${(lateMinutes / 60).toFixed(1)}h late, grace ${(grace / 60).toFixed(1)}h)`,
  };
}

// ── Workflow-file reading ────────────────────────────────────────────────────
// Deliberately not a YAML parse. The watchdog must keep working when a workflow
// file has something this repo's js-yaml version chokes on, and it needs
// exactly two things. Anchoring `name:` to column zero skips the `- name:` of
// every step; requiring the quoted form of `cron:` skips prose in comments.

/** Pull the workflow's display name and its cron lines out of raw YAML text. */
export function extractSchedule(yamlText) {
  const text = String(yamlText || "");
  const name = /^name:[ \t]*(?:"([^"]*)"|'([^']*)'|(.*))$/m.exec(text);
  const crons = [...text.matchAll(/^[ \t]*-[ \t]*cron:[ \t]*(?:"([^"]+)"|'([^']+)')/gm)]
    .map((m) => (m[1] ?? m[2]).trim());
  return {
    name: (name?.[1] ?? name?.[2] ?? name?.[3] ?? "").trim(),
    crons,
  };
}
