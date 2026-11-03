#!/usr/bin/env node
/**
 * install-git-hooks.mjs — writes .git/hooks/pre-commit.
 *
 * Git hooks are not themselves versioned, so this runs from npm's `prepare`
 * lifecycle (i.e. on `npm install`) to keep the hook in sync with the repo.
 * No-ops quietly when there is no .git directory (CI `npm ci`, tarball installs).
 */

import { writeFileSync, chmodSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const HOOK = `#!/bin/sh
# Managed by scripts/install-git-hooks.mjs — edits here are overwritten.
# Local stand-in for GitHub push protection (paid add-on on private repos).
exec node "$(git rev-parse --show-toplevel)/scripts/scan-secrets.mjs" --staged
`;

const gitDir = '.git';
if (!existsSync(gitDir)) {
  process.exit(0);
}

const hooksDir = join(gitDir, 'hooks');
if (!existsSync(hooksDir)) mkdirSync(hooksDir, { recursive: true });

const target = join(hooksDir, 'pre-commit');
writeFileSync(target, HOOK, 'utf8');
chmodSync(target, 0o755);
console.log('install-git-hooks: pre-commit installed (secret scan)');
