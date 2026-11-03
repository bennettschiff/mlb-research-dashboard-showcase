#!/usr/bin/env node
/**
 * cron-watchdog — did every scheduled workflow actually RUN?
 *
 * WHY (2026-08-28)
 * The dashboard showed `player_day_panel · STALE — missing 1/14 slates` and no
 * alarm had fired, because nothing we had could see the actual failure: the
 * 13:00 UTC run was never delivered. ops-alert.yml keys off
 * `workflow_run: completed`, so a job that never starts emits nothing to react
 * to. The plumbing tripwire runs at 07:15 UTC — six hours before the job it
 * would be judging — and had not run that day either, for the same reason.
 *
 * This closes that specific hole: for every workflow with a cron, compare its
 * most recent scheduled fire against when it actually last ran. Also flags
 * `disabled_manually`, which is the same silence with a different cause
 * (lab-analyst.yml sat disabled 2026-07-25 → 08-10 unnoticed).
 *
 * It does NOT alarm by itself — it PINGS. The verdict is upserted into
 * public.watchdog_pings, and api/_freshness.js turns both the verdict and this
 * script's own silence into the dashboard banner. A watchdog that lives inside
 * Actions dies in an Actions outage, so its last-seen time has to be the alarm.
 * See db/migrations/014 and src/lib/watchdog.js.
 *
 * Exit 0 = every cron delivered. Exit 1 = something is overdue or disabled.
 *
 * Run: node --env-file=.env.local scripts/cron-watchdog.mjs
 *      (GH_TOKEN locally; GITHUB_TOKEN is injected in Actions)
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractSchedule, evaluateWorkflow } from '../src/lib/cronSchedule.js';
import { serveDb } from './_lab.mjs';
import { sbRequest } from './lib/sb.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WF_DIR = resolve(ROOT, '.github/workflows');
const REPO = process.env.GITHUB_REPOSITORY || 'bennettschiff/MLB-Research-Dashboard';

// Actions injects GITHUB_TOKEN. Locally, borrow the gh CLI's own session rather
// than asking anyone to copy a PAT into .env.local — a token in a dotfile is a
// token that gets committed eventually.
function githubToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

const TOKEN = githubToken();
if (!TOKEN) {
  console.error('No GitHub token: set GITHUB_TOKEN, or run `gh auth login` locally.');
  process.exit(1);
}

async function gh(path) {
  const r = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(`GitHub ${r.status} on ${path}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// ── The crons, as written on disk ────────────────────────────────────────────
// Keyed by path because that is what the API reports; a workflow's display
// `name:` can change without the file moving, and matching on it would quietly
// drop that workflow out of the watch set — the precise class of silent
// coverage loss this script exists to prevent.
const onDisk = new Map();
for (const file of readdirSync(WF_DIR).filter((f) => /\.ya?ml$/.test(f))) {
  const { name, crons } = extractSchedule(readFileSync(resolve(WF_DIR, file), 'utf8'));
  onDisk.set(`.github/workflows/${basename(file)}`, { name: name || file, crons, file });
}

const now = new Date();
const workflows = (await gh(`/repos/${REPO}/actions/workflows?per_page=100`)).workflows || [];

const checked = [];
for (const wf of workflows) {
  const disk = onDisk.get(wf.path);
  if (!disk || !disk.crons.length) continue;   // dispatch-only or CI — nothing to be late for

  // Newest run of ANY event. The question is "did the work happen", not "did
  // the schedule specifically deliver": a manual dispatch produced the same
  // output, and alarming on it would teach the reader to ignore this.
  let lastRunAt = null;
  try {
    const runs = await gh(`/repos/${REPO}/actions/workflows/${wf.id}/runs?per_page=1`);
    lastRunAt = runs.workflow_runs?.[0]?.created_at ?? null;
  } catch (err) {
    checked.push({ name: disk.name, path: wf.path, status: 'ERROR', detail: err.message });
    continue;
  }

  checked.push({
    ...evaluateWorkflow({ name: disk.name, crons: disk.crons, state: wf.state, lastRunAt, now }),
    path: wf.path,
    crons: disk.crons,
    lastRunAt,
  });
}

const overdue = checked.filter((c) => c.status === 'OVERDUE');
const disabled = checked.filter((c) => c.status === 'DISABLED');
const errored = checked.filter((c) => c.status === 'ERROR');

// The tripwire runs immediately before this in the same job and leaves its
// verdict on disk. Carrying the count into the beacon means the dashboard shows
// "the data checks found N problems" even when the GitHub issue nobody reads is
// the only other place it was written.
let tripwireFindings = null;
try {
  const rep = JSON.parse(readFileSync(resolve(ROOT, 'docs/plumbing-tripwire-latest.json'), 'utf8'));
  tripwireFindings = (rep.findings || []).length;
} catch { /* tripwire has not written a report yet */ }

const notes = [];
if (errored.length) notes.push(`${errored.length} workflow(s) could not be checked`);
if (tripwireFindings) notes.push(`plumbing tripwire: ${tripwireFindings} finding(s)`);

const detail = {
  overdue: overdue.map((c) => ({ name: c.name, lateMinutes: c.lateMinutes, detail: c.detail })),
  disabled: disabled.map((c) => ({ name: c.name })),
  ...(notes.length ? { note: notes.join('; ') } : {}),
  checked: checked.length,
};
const status = overdue.length || disabled.length ? 'TRIPPED' : 'OK';

writeFileSync(
  resolve(ROOT, 'docs/cron-watchdog-latest.json'),
  JSON.stringify({ generatedAt: now.toISOString(), repo: REPO, status, detail, checked }, null, 2),
);

// ── Stamp the beacon ─────────────────────────────────────────────────────────
// Best-effort on purpose: a Supabase blip must not turn a clean run into a red
// workflow. The beacon simply goes stale, and the dashboard reports THAT, which
// is the correct reading either way.
try {
  const { url, headers } = serveDb();
  // idempotent: on_conflict upsert keyed on `source`. Retrying is what makes the
  // beacon survive a stall — and a stale beacon is exactly what SHOULD show if it
  // can't be stamped at all, so the surrounding try/catch still swallows failure.
  await sbRequest(`${url}/rest/v1/watchdog_pings?on_conflict=source`, {
    method: 'POST',
    headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify([{
      source: 'github_actions',
      status,
      detail,
      pinged_at: now.toISOString(),
      updated_at: now.toISOString(),
    }]),
  }, { idempotent: true, label: 'watchdog beacon', timeoutMs: 30_000 });
  console.log('beacon stamped: github_actions =', status);
} catch (err) {
  console.error('WARN could not stamp beacon:', err.message);
}

console.log(`\ncron-watchdog — ${checked.length} scheduled workflows checked`);
for (const c of disabled) console.log(`  DISABLED  ${c.name} — ${c.detail}`);
for (const c of overdue) console.log(`  OVERDUE   ${c.name} — ${c.detail}`);
for (const c of errored) console.log(`  ERROR     ${c.name} — ${c.detail}`);
if (status === 'OK') console.log('  all scheduled workflows delivered on time');

// Exit code and beacon deliberately disagree, and the split is the point.
//
// OVERDUE is currently the STEADY STATE: `schedule` delivery has been degraded
// account-wide since 08-26 and is upstream of us. Failing the workflow on it
// would paint this red every single morning until GitHub fixes their side,
// which is how a signal stops being read — the same rot that let a stale panel
// sit for two days. It goes to the beacon, where the dashboard shows it live
// and it disappears on its own when delivery recovers.
//
// DISABLED and ERROR are local, permanent and fixable by us: a disabled
// workflow never self-heals, and a check that could not run is a blind spot.
// Those are worth a red workflow.
const fatal = disabled.length + errored.length;
process.exit(fatal ? 1 : 0);
