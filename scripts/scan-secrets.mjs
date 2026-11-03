#!/usr/bin/env node
/**
 * scan-secrets.mjs — local stand-in for GitHub secret scanning + push protection.
 *
 * GitHub gates both behind the paid Secret Protection add-on for PRIVATE repos
 * (422 "Secret scanning is not available for this repository"), so this covers
 * the same ground for free:
 *   --staged   pre-commit hook   → blocks a secret before it lands  (push protection)
 *   --tracked  CI on every push  → sweeps all tracked files         (secret scanning)
 *
 * DESIGN NOTE — false positives are the real hazard here. Scheduled routines
 * commit unattended with no human to unblock them, so this deliberately uses
 * only high-confidence patterns (known vendor prefixes, JWT triplets, named
 * sensitive vars assigned a real-looking value). No generic entropy heuristic:
 * that is where noisy scanners earn their reputation, and a routine blocked at
 * 4am by a base64 blob in lab/ output costs more than it saves.
 *
 * Escape hatch: put `allowlist-secret` in a line's comment to exempt it.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const ALLOWLIST_MARKER = 'allowlist-secret';

// Paths that legitimately hold placeholder credentials.
const EXEMPT_PATH = /(\.example$|\.sample$|(^|\/)fixtures\/|(^|\/)__fixtures__\/|^docs\/.*\.example)/;

// Binary / generated paths never worth scanning.
const SKIP_PATH = /(^|\/)(node_modules|dist|\.git)\/|\.(png|jpg|jpeg|gif|webp|svg|ico|woff2?|ttf|eot|pdf|zip|gz|tgz|mp4|lock)$/;

const MAX_BYTES = 2 * 1024 * 1024; // skip files above this; lab blobs get large

/** Vendor-prefixed credentials. Prefix makes these near-zero false positive. */
const PREFIX_RULES = [
  { name: 'Apify API token',            re: /\bapify_api_[A-Za-z0-9]{24,}/g },
  { name: 'Supabase secret key',        re: /\bsb_secret_[A-Za-z0-9_-]{20,}/g },
  { name: 'Supabase access token',      re: /\bsbp_[A-Za-z0-9]{36,}/g },
  { name: 'GitHub token',               re: /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})/g },
  { name: 'OpenAI / Anthropic key',     re: /\bsk-(ant-)?[A-Za-z0-9_-]{24,}/g },
  { name: 'AWS access key id',          re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'Google API key',             re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'Slack token',                re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'Stripe live key',            re: /\bsk_live_[A-Za-z0-9]{20,}/g },
  { name: 'Private key block',          re: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g },
  // Supabase service-role keys are JWTs; this is the shape that actually leaks.
  { name: 'JWT (service-role key?)',    re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
];

/** Sensitive var names — flagged only when assigned something real. */
const SENSITIVE_VARS = [
  'SUPABASE_SERVICE_ROLE_KEY', 'ODDS_API_KEY', 'APIFY_TOKEN', 'APP_ACCESS_CODE',
  'CRON_SECRET', 'RCLONE_CONF', 'VERCEL_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN',
];
const ASSIGN_RE = new RegExp(
  String.raw`\b(${SENSITIVE_VARS.join('|')})\s*[:=]\s*(['"\`]?)([^\s'"\`,;]{8,})\2`,
  'g',
);

/** A value that is plainly a reference or a placeholder, not a live credential. */
function isPlaceholder(value) {
  return (
    /process\.env|import\.meta\.env|secrets\.|\$\{|^\$|^<|>$|^\.\.\.|^\*+$/.test(value) ||
    /^(your|my|the)[-_]?/i.test(value) ||
    /(example|placeholder|changeme|redacted|dummy|sample|fake|stub|mock|noop|invalid|test[-_]?key|xxx+|todo)/i.test(value)
  );
}

function redact(match) {
  const s = String(match);
  const head = s.slice(0, 4);
  return `${head}${'*'.repeat(Math.min(12, Math.max(0, s.length - 4)))} (${s.length} chars)`;
}

function scanText(path, text) {
  const findings = [];
  const lines = text.split('\n');

  lines.forEach((line, i) => {
    if (line.includes(ALLOWLIST_MARKER)) return;
    if (line.length > 5000) return; // minified/bundled line, not hand-authored

    for (const rule of PREFIX_RULES) {
      rule.re.lastIndex = 0;
      for (const m of line.matchAll(rule.re)) {
        findings.push({ path, line: i + 1, rule: rule.name, preview: redact(m[0]) });
      }
    }

    ASSIGN_RE.lastIndex = 0;
    for (const m of line.matchAll(ASSIGN_RE)) {
      const [, varName, , value] = m;
      if (isPlaceholder(value)) continue;
      findings.push({
        path, line: i + 1,
        rule: `${varName} assigned a literal value`,
        preview: redact(value),
      });
    }
  });

  return findings;
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function scannablePaths(paths) {
  return paths.filter((p) => p && !SKIP_PATH.test(p) && !EXEMPT_PATH.test(p));
}

function scanStaged() {
  const paths = scannablePaths(
    git(['diff', '--cached', '--name-only', '--diff-filter=ACMR']).split('\n'),
  );
  const findings = [];
  for (const path of paths) {
    // Read the STAGED blob, not the worktree file — they can differ.
    let content;
    try {
      content = git(['show', `:${path}`]);
    } catch {
      continue; // deleted or unreadable in the index
    }
    findings.push(...scanText(path, content));
  }
  return findings;
}

function scanTracked() {
  const paths = scannablePaths(git(['ls-files']).split('\n'));
  const findings = [];
  for (const path of paths) {
    try {
      if (statSync(path).size > MAX_BYTES) continue;
      findings.push(...scanText(path, readFileSync(path, 'utf8')));
    } catch {
      continue;
    }
  }
  return findings;
}

const mode = process.argv.includes('--tracked') ? 'tracked' : 'staged';
const findings = mode === 'tracked' ? scanTracked() : scanStaged();

if (findings.length === 0) {
  console.log(`scan-secrets: clean (${mode})`);
  process.exit(0);
}

console.error(`\n✖ scan-secrets: ${findings.length} potential secret(s) in ${mode} content\n`);
for (const f of findings) {
  console.error(`  ${f.path}:${f.line}`);
  console.error(`    ${f.rule}`);
  console.error(`    ${f.preview}\n`);
}
console.error('Blocked. If this is a real credential:');
console.error('  1. Remove it from the file and load it from .env.local instead.');
console.error('  2. ROTATE it — assume it is burned the moment it was written to disk.');
console.error(`\nIf it is a false positive, add "${ALLOWLIST_MARKER}" to a comment on that line.`);
console.error('To bypass entirely (recorded in reflog): git commit --no-verify\n');
process.exit(1);
