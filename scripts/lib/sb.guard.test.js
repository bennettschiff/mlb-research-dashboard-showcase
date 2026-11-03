/**
 * The guard that keeps the retry policy from re-diverging.
 *
 * The 2026-09-05 incident was not really a Supabase stall — it was seventeen
 * scheduled scripts each with their own idea of what a failed Supabase request
 * means. That is why a fix lands in one place and the next stall surfaces
 * somewhere else, and why "the NFL lab is broken too" looked like a second,
 * separate regression when it was the same one.
 *
 * A fix you have to remember to apply is not a fix. So this test enumerates the
 * scripts the workflows actually run and fails the build if one of them talks to
 * Supabase without going through scripts/lib/sb.mjs. Adding a new scheduled
 * script that hand-rolls a fetch now breaks CI on the first commit, rather than
 * on the first outage six weeks later.
 *
 * If a script legitimately needs a raw fetch, add it to ALLOWED with a reason.
 * The list is meant to stay short; each entry is a place the next stall can still
 * reach.
 *
 * Run: npx vitest run
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WF_DIR = path.join(ROOT, ".github/workflows");

// Files allowed to reach Supabase with a bare fetch, and why.
const ALLOWED = new Map([
  [
    "scripts/serve-health.mjs",
    "It is the prober: it MEASURES whether the database answers within a fixed " +
      "budget and restarts the project when it doesn't. Retrying inside it would " +
      "paper over the exact condition it exists to detect.",
  ],
]);

// Markers that say a fetch is aimed at Supabase rather than at MLB Stats,
// Savant or the GitHub API. Deliberately generous: a false positive is fixed by
// converting the call (which is the point), a false negative is a hole.
const SUPABASE_NEAR = /\/rest\/v1\/|sbHeaders|serveHeaders|labHeaders|SB_KEY|SERVICE_ROLE|apikey\s*:|labDb\(\)|serveDb\(\)|dbForPath\(/;
const WINDOW = 400;

/** Strip comments so a line that only LOOKS like code doesn't count as code. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function workflowScripts() {
  const found = new Set();
  for (const f of fs.readdirSync(WF_DIR).filter((f) => /\.ya?ml$/.test(f))) {
    const text = fs.readFileSync(path.join(WF_DIR, f), "utf8");
    for (const m of text.matchAll(/scripts\/[A-Za-z0-9._-]+\.mjs/g)) found.add(m[0]);
  }
  return [...found].filter((rel) => fs.existsSync(path.join(ROOT, rel))).sort();
}

/**
 * The text of fetch()'s first argument — the URL expression — up to the
 * top-level comma or the closing paren.
 */
function firstArg(code, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < code.length; i++) {
    const c = code[i];
    if ("([{`".includes(c)) depth++;
    else if (")]}".includes(c)) { if (--depth === 0) return code.slice(openIdx + 1, i); }
    else if (c === "," && depth === 1) return code.slice(openIdx + 1, i);
  }
  return code.slice(openIdx, openIdx + WINDOW);
}

function bareSupabaseFetches(code) {
  const hits = [];
  for (const m of code.matchAll(/\bfetch\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const arg = firstArg(code, open);
    // An absolute URL that isn't a PostgREST path is some other API — MLB Stats,
    // Savant, GitHub. Those legitimately use plain fetch and often sit a few
    // lines from Supabase code, so judging them by proximity flags the wrong file.
    if (/https?:\/\//.test(arg) && !/rest\/v1/.test(arg)) continue;

    let isSupabase = /rest\/v1/.test(arg);
    // fetch(url) where the URL was assembled a few lines up. Look for that
    // identifier being assigned a PostgREST path — NOT for Supabase-ish tokens
    // merely nearby, which flags a helper that only ever fetches MLB Stats
    // because a Supabase call happens to sit twenty lines away.
    const ident = arg.trim().match(/^[A-Za-z_$][\w$]*$/)?.[0];
    if (!isSupabase && ident) {
      const before = code.slice(Math.max(0, m.index - WINDOW), m.index);
      isSupabase = new RegExp(`\\b${ident}\\s*=[^;]*rest\\/v1`).test(before);
    }
    if (isSupabase) hits.push(code.slice(0, m.index).split("\n").length); // 1-indexed line
  }
  return hits;
}

const SCRIPTS = workflowScripts();

describe("scheduled scripts route Supabase through scripts/lib/sb.mjs", () => {
  it("finds the workflow-referenced scripts at all (the guard is not vacuous)", () => {
    expect(SCRIPTS.length).toBeGreaterThan(5);
  });

  for (const rel of SCRIPTS) {
    const reason = ALLOWED.get(rel);
    it(`${rel}${reason ? " (allowed)" : ""}`, () => {
      const code = stripComments(fs.readFileSync(path.join(ROOT, rel), "utf8"));
      const hits = bareSupabaseFetches(code);
      if (reason) {
        // An allowlisted file must still be DOING the thing it was excused for.
        // Otherwise the exemption outlives its reason and quietly re-opens a hole.
        expect(hits.length, `${rel} is allowlisted but no longer has a raw Supabase fetch — remove it from ALLOWED`).toBeGreaterThan(0);
        return;
      }
      expect(
        hits,
        `${rel} calls fetch() against Supabase directly (line${hits.length > 1 ? "s" : ""} ${hits.join(", ")}).\n` +
          `Use sbRequest/sbJson from scripts/lib/sb.mjs so this script survives a stall like 2026-09-05,\n` +
          `or add it to ALLOWED in this file with the reason it must be raw.`
      ).toEqual([]);
    });
  }
});

describe("the helper is actually imported where it is used", () => {
  // A sed-inserted import once landed INSIDE a file's block comment: the code
  // parsed fine and would have died at runtime with "sbJson is not defined".
  // Comments are stripped first, so an import that isn't real doesn't count.
  for (const rel of SCRIPTS) {
    it(rel, () => {
      const raw = fs.readFileSync(path.join(ROOT, rel), "utf8");
      const code = stripComments(raw);
      const uses = /\bsb(?:Json|Request)\s*\(/.test(code) || /\bSbHttpError\b/.test(code);
      if (!uses) return;
      expect(
        /import\s*\{[^}]*\}\s*from\s*['"]\.\/lib\/sb\.mjs['"]/.test(code),
        `${rel} uses the sb helper but has no live import of it (an import inside a comment does not count)`
      ).toBe(true);
    });
  }
});
