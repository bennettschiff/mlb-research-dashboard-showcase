#!/usr/bin/env node
/**
 * check-archive-workflows.mjs — a job that READS the cold archive must SET UP rclone.
 *
 * WHY THIS EXISTS. On 2026-09-08 the cold half of the database (daily_scan_results,
 * pick_signals, and the three LAB panel tables) moved to Drive and the readers in
 * scripts/lib/*-archive.mjs were pointed at it. The five workflows that run those
 * readers were not touched, because only backup-to-drive.yml had ever needed
 * rclone. Nothing failed that day: panel.range()/scanFor()/loadSignalsJoined()
 * only reach for Drive once the dates they want have aged out of the 14-day
 * Postgres window. So the jobs kept passing on warm data and then began failing
 * one at a time as their windows aged past it — mining-engine.yml first, on
 * 2026-09-09, with `spawnSync rclone ENOENT` and nothing in the message about
 * archives at all.
 *
 * That is the project's signature failure (docs: "silent degradation"): a
 * migration lands, the code that reads is updated, and the ENVIRONMENT the code
 * runs in is updated one workflow at a time, by whoever notices. This check moves
 * the discovery from "the night the window ages out" to "the commit that adds the
 * script", which is the only place it is cheap.
 *
 * WHAT IT ENFORCES. For each workflow, resolve every scripts/*.mjs it runs,
 * follow local imports transitively, and if any of them reaches the archive
 * layer, require the workflow to reference .github/actions/setup-rclone.
 *
 * Run: node scripts/check-archive-workflows.mjs   (exit 1 on a violation)
 */
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WF_DIR = path.join(ROOT, ".github/workflows");
const SCRIPTS = path.join(ROOT, "scripts");
const ACTION = ".github/actions/setup-rclone";

// The modules that shell out to rclone. archive.mjs owns the rclone call itself;
// the other four are the per-archive readers built on it. A script that imports
// any of them, at any depth, can end up on Drive.
const ARCHIVE_MODULES = new Set([
  "lib/archive.mjs",
  "lib/date-archive.mjs",
  "lib/panel-archive.mjs",
  "lib/scan-archive.mjs",
  "lib/signals-archive.mjs",
]);

/** Local (relative) import specifiers in a module's source. */
function localImports(src) {
  const out = [];
  const re = /(?:from|import)\s+["'](\.[^"']+)["']/g;
  let m;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}

const cache = new Map();
/** Does `file` (absolute) reach the archive layer through local imports? */
function reachesArchive(file, seen = new Set()) {
  if (cache.has(file)) return cache.get(file);
  if (seen.has(file) || !fs.existsSync(file)) return false;
  seen.add(file);

  const rel = path.relative(SCRIPTS, file);
  if (ARCHIVE_MODULES.has(rel.split(path.sep).join("/"))) return true;

  let hit = false;
  for (const spec of localImports(fs.readFileSync(file, "utf8"))) {
    if (reachesArchive(path.resolve(path.dirname(file), spec), seen)) { hit = true; break; }
  }
  cache.set(file, hit);
  return hit;
}

const violations = [];
const okJobs = [];
for (const f of fs.readdirSync(WF_DIR).filter((n) => /\.ya?ml$/.test(n))) {
  const src = fs.readFileSync(path.join(WF_DIR, f), "utf8");
  const scripts = [...new Set(src.match(/scripts\/[\w-]+\.mjs/g) ?? [])];
  const needing = scripts.filter((s) => reachesArchive(path.join(ROOT, s)));
  if (!needing.length) continue;
  if (src.includes(ACTION) || /Install rclone/.test(src)) okJobs.push(`${f} (${needing.length})`);
  else violations.push({ workflow: f, scripts: needing });
}

for (const v of violations) {
  console.error(`✗ ${v.workflow} runs ${v.scripts.join(", ")} — which read the Drive cold archive — without setting up rclone.`);
}
if (violations.length) {
  console.error(
    `\n::error::${violations.length} workflow(s) read the cold archive without rclone. They will pass ` +
    `until the dates they want age out of the 14-day Postgres window, then fail with ` +
    `\`spawnSync rclone ENOENT\` (mining-engine, 2026-09-09). Add to the job, after setup-node:\n\n` +
    `      - uses: ./${ACTION}\n        with:\n          rclone-conf: \${{ secrets.RCLONE_CONF }}\n`
  );
  process.exit(1);
}
console.log(`✓ all ${okJobs.length} archive-reading workflow(s) set up rclone: ${okJobs.join(", ")}`);
