import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

// ops-alert.yml is the only thing that turns a failed scheduled run into a
// visible signal (GitHub issue → email). It subscribes via `on: workflow_run:`,
// which matches by workflow NAME — not by filename, not by id. That makes two
// silent-failure modes possible, and both have bitten this repo:
//
//   1. A scheduled workflow is added but never listed here, so its failures are
//      invisible. CLAUDE.md carries a standing rule about this precisely because
//      the rule is the only thing enforcing it.
//   2. A watched workflow is RENAMED without updating the list. The list still
//      looks populated, ops-alert still runs, and it silently watches a workflow
//      that no longer exists. This is the nastier one: nothing errors.
//
// The motivating incident is older than both — a Drive backup sat broken and
// disabled for 11 days, and HRR picks were silently zero for 10, which is why
// ops-alert exists at all. A watch list that drifts recreates that blind spot
// while looking healthy. 2026-07-29: uptime.yml was renamed "Uptime check
// (hourly)" → "Uptime check" during the Actions-cap review; this test is what
// makes that rename safe to do again.

const WORKFLOW_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../.github/workflows')

const workflows = readdirSync(WORKFLOW_DIR)
  .filter(f => f.endsWith('.yml') || f.endsWith('.yaml'))
  .map(file => ({ file, src: readFileSync(resolve(WORKFLOW_DIR, file), 'utf8') }))

/** First top-level `name:` line → its value, unquoted. */
function workflowName(src) {
  const line = src.split('\n').find(l => /^name:/.test(l))
  if (!line) return null
  return line.slice('name:'.length).trim().replace(/^["']|["']$/g, '')
}

/** True when the workflow declares a `schedule:` trigger (i.e. runs unattended). */
function isScheduled(src) {
  return /^\s{2}schedule:/m.test(src)
}

/** The `workflows:` list ops-alert subscribes to → array of names. */
function watchList(src) {
  const lines = src.split('\n')
  const start = lines.findIndex(l => /^\s*workflows:\s*$/.test(l))
  if (start === -1) return []
  const indent = lines[start].match(/^\s*/)[0].length
  const names = []
  for (const line of lines.slice(start + 1)) {
    if (/^\s*(#.*)?$/.test(line)) continue
    const pad = line.match(/^\s*/)[0].length
    const item = line.match(/^\s*-\s*(.+?)\s*$/)
    if (!item || pad <= indent) break // dedent or a non-item key ends the list
    names.push(item[1].replace(/^["']|["']$/g, ''))
  }
  return names
}

const opsAlert = workflows.find(w => w.file === 'ops-alert.yml')
const watched = opsAlert ? watchList(opsAlert.src) : []
const byName = new Map(workflows.map(w => [workflowName(w.src), w]))

describe('ops-alert watch list', () => {
  it('finds ops-alert and a non-empty watch list', () => {
    expect(opsAlert, 'ops-alert.yml is missing — nothing reports scheduled failures').toBeTruthy()
    expect(watched.length).toBeGreaterThan(0)
  })

  it('every watched name resolves to a real workflow (catches renames)', () => {
    const orphans = watched.filter(n => !byName.has(n))
    expect(
      orphans,
      `ops-alert watches ${JSON.stringify(orphans)}, which match no workflow's \`name:\`. ` +
      `A rename broke the subscription — those failures are now silent. ` +
      `Available names: ${JSON.stringify([...byName.keys()].filter(Boolean).sort())}`
    ).toEqual([])
  })

  it('every scheduled workflow is watched (catches new unmonitored crons)', () => {
    const unwatched = workflows
      .filter(w => isScheduled(w.src) && w.file !== 'ops-alert.yml')
      .map(w => workflowName(w.src))
      .filter(n => !watched.includes(n))
    expect(
      unwatched,
      `These scheduled workflows are not in ops-alert.yml's \`workflows:\` list, ` +
      `so their failures open no issue and send no email: ${JSON.stringify(unwatched)}`
    ).toEqual([])
  })

  it('has no duplicate entries', () => {
    const dupes = watched.filter((n, i) => watched.indexOf(n) !== i)
    expect(dupes, `duplicated in the watch list: ${JSON.stringify(dupes)}`).toEqual([])
  })
})
