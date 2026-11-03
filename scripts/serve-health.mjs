#!/usr/bin/env node
/**
 * scripts/serve-health.mjs — detect (and optionally auto-heal) a wedged Postgres.
 *
 * THE GAP THIS FILLS. SERVE wedged on 2026-08-25 and again on 2026-08-29. Both
 * times the failure was invisible to every guard we had:
 *
 *   - Supabase's own control plane reported ACTIVE_HEALTHY throughout.
 *   - uptime.yml probed the homepages and /api/auth. The React shell is static
 *     and /api/auth never touches Postgres, so all five probes returned green
 *     while not a single database query could complete.
 *   - Every scheduled workflow stayed GREEN, because the scripts they run treat
 *     a cache/DB miss as non-fatal and exit 0.
 *   - ops-alert only reacts to a workflow that already failed, so it had nothing
 *     to react to.
 *
 * The only signal was a human opening the site and seeing "Database did not
 * respond within 45s". That is the thing being fixed: this probe issues a REAL
 * authenticated query and fails when the answer does not come back.
 *
 * WHAT A WEDGE LOOKS LIKE (measured both times): the REST root answers 401 in
 * ~100ms — edge and Kong are fine — while `select ... limit 1` against any table
 * hangs past 30s and Cloudflare eventually returns a 522. PostgREST talks to
 * Postgres directly rather than through Supavisor, so REST hanging *and* the
 * management API timing out isolates it to Postgres itself.
 *
 * AUTO-HEAL. A dashboard restart fixed it in seconds both times, with no data
 * loss. With SUPABASE_ACCESS_TOKEN set this script performs that same restart
 * over the Management API. Without the token it still detects and reports; it
 * just cannot act. It ALWAYS exits 2 on a wedge, even when the restart succeeds,
 * because a database that needs restarting twice in five days is something you
 * should be told about, not something that should quietly self-repair forever.
 *
 * Exit codes follow capacity-check.mjs so the two read the same way:
 *   0 — healthy
 *   1 — the check itself is broken (missing credentials, unusable response)
 *   2 — wedge detected (alarm; caller opens an issue and the RUN still succeeds)
 */

const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN || "";

// Sustained-failure gate. A wedge is minutes-long; a blip is not. Three spaced
// attempts (~45s of sustained failure) is what keeps a single slow response from
// triggering a production restart.
const ATTEMPTS = 3;
const ATTEMPT_TIMEOUT_MS = 12_000;
const GAP_MS = 8_000;

// Deliberately the cheapest possible query: one narrow column, one row, from a
// table that is tiny. A wedge blocks it exactly as hard as it blocks a big query,
// so paying for a big one buys nothing and risks blaming the query for the hang.
// `source`, not `id` — watchdog_pings is keyed on (source) and has NO id column,
// and PostgREST answers a select of a non-existent column with 400, which this
// script correctly classifies as a broken check rather than an outage. A probe
// that cannot tell "my query is wrong" from "the database is down" is worse than
// no probe: it would page for a wedge on every single run.
const PROBE = "watchdog_pings?select=source&limit=1";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function projectRef(url) {
  // https://<ref>.supabase.co → <ref>
  try {
    return new URL(url).hostname.split(".")[0];
  } catch {
    return null;
  }
}

async function probeOnce() {
  const t0 = Date.now();
  try {
    const res = await fetch(`${URL_}/rest/v1/${PROBE}`, {
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
      signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
    });
    const ms = Date.now() - t0;
    if (!res.ok) {
      // A 522/504 here is the Cloudflare face of the wedge. A 4xx is our problem
      // (bad key, table renamed) and must NOT be reported as a database outage —
      // restarting Postgres would not fix it and would be a pointless production
      // action. Those surface as a broken check instead.
      const body = (await res.text()).slice(0, 200);
      return { ok: false, ms, status: res.status, body, ourFault: res.status >= 400 && res.status < 500 };
    }
    await res.json();
    return { ok: true, ms, status: res.status };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, status: 0, body: e.message };
  }
}

async function restartProject(ref) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/restart`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text().catch(() => "");
  return { ok: res.ok, status: res.status, body: text.slice(0, 300) };
}

async function main() {
  if (!URL_ || !KEY) {
    console.error("BROKEN CHECK: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");
    return 1;
  }
  const ref = projectRef(URL_);
  console.log(`Probing SERVE (${ref}) — ${ATTEMPTS} attempts, ${ATTEMPT_TIMEOUT_MS}ms each`);

  let last = null;
  for (let i = 1; i <= ATTEMPTS; i++) {
    last = await probeOnce();
    console.log(`  attempt ${i}: ${last.ok ? "OK" : "FAIL"} status=${last.status} ${last.ms}ms${last.ok ? "" : " :: " + String(last.body).replace(/\s+/g, " ").slice(0, 120)}`);
    if (last.ok) {
      console.log(`✅ SERVE healthy (${last.ms}ms)`);
      return 0;
    }
    // A 4xx is a credential/schema problem, not a wedge — stop immediately rather
    // than spending two more attempts confirming our own misconfiguration.
    if (last.ourFault) {
      console.error(`BROKEN CHECK: probe returned ${last.status} — credentials or table wrong, not a database outage.`);
      console.error(last.body);
      return 1;
    }
    if (i < ATTEMPTS) await sleep(GAP_MS);
  }

  console.error("");
  console.error(`❌ WEDGED: ${ATTEMPTS} consecutive failures against ${ref}.`);
  console.error(`   last status=${last.status} after ${last.ms}ms`);

  if (!ACCESS_TOKEN) {
    console.error("");
    console.error("   No SUPABASE_ACCESS_TOKEN — cannot auto-restart.");
    console.error(`   Fix by hand: https://supabase.com/dashboard/project/${ref}/settings/general → Restart project`);
    return 2;
  }

  console.error("");
  console.error("   SUPABASE_ACCESS_TOKEN present — restarting the project.");
  const r = await restartProject(ref);
  if (!r.ok) {
    console.error(`   Restart REJECTED (${r.status}): ${r.body}`);
    console.error(`   Restart by hand: https://supabase.com/dashboard/project/${ref}/settings/general`);
    return 2;
  }
  console.error("   Restart accepted. Waiting 90s for Postgres to come back…");
  await sleep(90_000);

  for (let i = 1; i <= ATTEMPTS; i++) {
    const p = await probeOnce();
    console.error(`   post-restart attempt ${i}: ${p.ok ? "OK" : "FAIL"} status=${p.status} ${p.ms}ms`);
    if (p.ok) {
      console.error(`   ✅ Recovered after restart (${p.ms}ms).`);
      // Still exit 2. The restart worked, but a wedge happened and the alarm is
      // the record of that — silently self-healing hides the recurrence rate,
      // which is the actual thing worth watching.
      return 2;
    }
    if (i < ATTEMPTS) await sleep(GAP_MS);
  }
  console.error("   ❌ Still wedged after restart — needs a human.");
  return 2;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error("BROKEN CHECK:", e?.stack || e);
    process.exit(1);
  });
