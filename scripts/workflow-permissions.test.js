import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

// A GitHub `permissions:` block replaces the default token scopes instead of
// adding to them. So a workflow that declares any permissions and also runs
// actions/checkout MUST list contents: read, or checkout of this private repo
// fails with "remote: Repository not found" — a 403 that GitHub masks as a 404.
// That masking is the trap: the error names a cause (missing repo) that isn't
// the real one, so it reads as a transient infra blip. daily-picks.yml lost a
// day of picks to it (26b4e10 added `permissions: issues: write`; every run
// after it failed at checkout, and the retry added in response could not help).

const WORKFLOW_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../.github/workflows')

/** Top-level `permissions:` block → its raw body, or null if absent. */
function topLevelPermissions(src) {
  const lines = src.split('\n')
  const start = lines.findIndex(l => /^permissions:/.test(l))
  if (start === -1) return null

  const inline = lines[start].slice('permissions:'.length).trim()
  if (inline) return inline // `permissions: read-all` / `write-all` / `{}`

  const body = []
  for (const line of lines.slice(start + 1)) {
    if (/^\s*(#.*)?$/.test(line)) continue      // blank / comment
    if (!/^\s/.test(line)) break                // dedent ends the block
    body.push(line)
  }
  return body.join('\n')
}

const workflows = readdirSync(WORKFLOW_DIR)
  .filter(f => f.endsWith('.yml') || f.endsWith('.yaml'))
  .map(file => ({ file, src: readFileSync(resolve(WORKFLOW_DIR, file), 'utf8') }))

describe('workflow permissions', () => {
  it('finds workflows to check', () => {
    expect(workflows.length).toBeGreaterThan(0)
  })

  const checkoutWorkflows = workflows.filter(w => /uses:\s*actions\/checkout/.test(w.src))

  it.each(checkoutWorkflows)('$file grants contents access to actions/checkout', ({ src }) => {
    const perms = topLevelPermissions(src)
    if (perms === null) return // no block → inherits defaults, which include contents: read
    if (/^(read-all|write-all)$/.test(perms.trim())) return

    expect(perms).toMatch(/^\s*contents:\s*(read|write)\b/m)
  })
})
