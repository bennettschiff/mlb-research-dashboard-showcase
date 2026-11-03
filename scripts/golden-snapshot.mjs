#!/usr/bin/env node
/**
 * scripts/golden-snapshot.mjs
 *
 * Writes the day's Golden boards — 'likely', 'lines' and 'value' — one
 * golden_snapshots row per (pick_date, board). The Results page renders a
 * "Yesterday's" table per board from these rows.
 *
 * WHAT CHANGED (2026-08-06). This used to write a single Golden 10 built from
 * that day's saved official picks (mlb_picks) ranked by goldenScore, which blends
 * confidence and raw event probability and never looks at price. Over 57 days
 * that board went 329-187 (63.8%) for -22.02u / -5.2% ROI: it was selecting the
 * events most likely to occur, which on this slate means Hits O0.5 chalk at an
 * average of -238 against a 69.2% breakeven. It also had a structural ceiling —
 * probNorm is the raw base rate, so HR picks maxed at goldenScore 0.647 against a
 * ~0.83 daily cut and could never qualify however good they were. src/lib/golden.js
 * is retired for board building and kept only to read back 'legacy' rows.
 *
 * The substrate is now the Brain Trust per-line surface
 * (brain_trust_snapshots.predictions, written by scripts/brain-trust-snapshot.mjs),
 * which prices every line on the ladder from daily_odds standard + alternate
 * markets and carries modelProb / edge / ev / trust per row. Board selection math
 * is pure and shared with the UI in src/lib/goldenBoards.js.
 *
 * ORDERING: this depends on the Brain Trust snapshot for the same date. Run it
 * after brain-trust-snapshot.mjs --snapshot, or it will find no surface and skip.
 *
 * Idempotent per board: skips boards that already have a row unless --force.
 *
 * GRADING. Board rows mostly do NOT exist in mlb_picks — alternate lines, and
 * players who never cleared an official pick gate — so the old
 * matchSavedPickToGolden path cannot grade them. --grade instead settles each
 * pick against player_day_features.outcomes (the same unbiased panel
 * brain-trust-snapshot.mjs grades on) and writes a per-board summary.
 *
 * Env (required): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *
 * Usage:
 *   node --env-file=.env.local scripts/golden-snapshot.mjs                # today ET
 *   node --env-file=.env.local scripts/golden-snapshot.mjs 2026-08-05
 *   node --env-file=.env.local scripts/golden-snapshot.mjs 2026-08-05 --force
 *   node --env-file=.env.local scripts/golden-snapshot.mjs 2026-08-05 --dry
 *   node --env-file=.env.local scripts/golden-snapshot.mjs --backfill       # every BT date
 *   node --env-file=.env.local scripts/golden-snapshot.mjs --grade          # sweep ungraded
 *   node --env-file=.env.local scripts/golden-snapshot.mjs 2026-08-05 --grade
 */
import { GOLDEN_BOARDS, selectBoard } from "../src/lib/goldenBoards.js";
import { summarizePicks, settlePick } from "../src/lib/goldenResults.js";
import { dbForPath } from './_lab.mjs';
import { sbJson, sbRequest } from './lib/sb.mjs';

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
// Env presence is checked in the CLI block below — NOT at module load, so that
// importing buildGoldenSnapshot (api/cron.js) can never process.exit the caller.

const todayET = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());

const MARKET_META = {
  nrfi: { label: "1st Inning",  emoji: "1️⃣" },
  hits: { label: "Hits",        emoji: "🎯" },
  hr:   { label: "Home Run",    emoji: "💣" },
  tb:   { label: "Total Bases", emoji: "📊" },
  sb:   { label: "Stolen Base", emoji: "🏃" },
  hrr:  { label: "H+R+RBI",     emoji: "🔥" },
  rbi:  { label: "RBI",         emoji: "🏅" },
  ks:   { label: "Strikeouts",  emoji: "⚾" },
};

// Routed per table: this script grades against player_day_features, which moved to LAB on
// 2026-08-11, while everything else it reads (mlb_picks, golden_snapshots) stayed on SERVE.
// Only the GET side needs routing — sbPatch below writes to golden_snapshots on SERVE.
const sbGet = async (path) => {
  const { url: _sbUrl, headers: _sbH } = dbForPath(path);
  return sbJson(`${_sbUrl}/rest/v1/${path}`, { headers: _sbH }, { label: `sb GET ${path.slice(0, 80)}` });
};

/**
 * NRFI/YRFI as board candidates.
 *
 * NRFI is modelled but never priced — The Odds API posts no first-inning market,
 * so best_odds is null on all 37 saved picks. It is still a real, fully graded
 * pick market (mlb_picks carries outcome win/loss for every row), so it belongs
 * on the probability-ranked board; only the edge-ranked boards genuinely cannot
 * rank it, since edge vs. the book is undefined without a book.
 *
 * Saved as first-inning runs O/U 0.5: direction 'over' is YRFI, 'under' is NRFI.
 *
 * CALIBRATION CAVEAT (2026-08-06): these rows are marked trusted so they can be
 * ranked, but the market is NOT currently well calibrated — 16-21 (43.2%) live
 * against a ~58% predicted probability, and all 37 picks have been YRFI. The
 * board's probability ranking largely handles this on its own (model_prob spans
 * only 0.571-0.620, so NRFI cleared the daily cut on 1 of 17 dates), but the
 * miscalibration is real and is a model problem, not a board problem.
 */
async function loadNrfiCandidates(date) {
  const rows = await sbGet(
    `mlb_picks?pick_date=eq.${date}&prop_type=eq.nrfi` +
    `&select=player_name,player_id,line,direction,model_prob,model_score,conf`
  );
  return rows
    .filter((r) => Number.isFinite(Number(r.model_prob)))
    .map((r) => ({
      name: r.player_name,          // matchup string, e.g. "SF @ TEX"
      gamePk: r.player_id ?? null,  // game-line markets store gamePk in player_id
      market: "nrfi",
      line: r.line ?? 0.5,
      direction: r.direction || "over",
      modelProb: Number(r.model_prob),
      bookOdds: null,
      fairOdds: null,
      edge: null,
      ev: null,
      trust: "trusted",
    }));
}

// Shape one selected prediction into the row the Results table reads. Keep this
// flat and small — a snapshot is read on every Results page load.
function snapshotEntry(p) {
  const meta = MARKET_META[p.market] || { label: p.market, emoji: "•" };
  const label = p.market === "nrfi"
    ? `${meta.label} ${p.direction === "under" ? "NRFI" : "YRFI"}`
    : `${meta.label} O${p.line}`;
  return {
    board: p.board,
    rank: p.rank,
    market: p.market,
    marketLabel: label,
    emoji: meta.emoji,
    direction: p.direction || "over",
    playerName: p.name,
    team: p.team ?? null,
    opponent: p.opp ?? null,
    gamePk: p.gamePk ?? null,
    line: p.line,
    modelProb: p.modelProb,
    fairOdds: p.fairOdds ?? null,
    bookOdds: p.bookOdds,
    // Which book posted bookOdds — the board shows its logo so a play is
    // traceable to a place you can actually bet it. Null on unpriced markets
    // (NRFI) and on rows written before 2026-08-18, which the UI renders as a
    // bare price. scripts/backfill-golden-book.mjs fills those from daily_odds.
    book: p.book ?? null,
    edge: p.edge,
    ev: p.ev,
    trust: p.trust,
  };
}

/**
 * gamePks whose game has already started on `date`.
 *
 * WHY. This job is supposed to run at 12:30 PM ET, before first pitch, so every board row
 * is a genuine forward prediction. GitHub does not honour that: on 2026-08-28 the 16:30 UTC
 * cron was still undelivered at 3:55 PM ET (morning-score's 7:30 AM ET cron landed at 3:35
 * PM ET the same day — 8 h late), and nothing in this script cared. A cron that arrives
 * mid-slate would happily rank a player whose game is in the 6th, then hand that row to
 * forward grading as if it had been picked at noon. One such row does not just distort its
 * own board — it contaminates the board-vs-board ROI series the whole surface exists to
 * measure.
 *
 * Preview covers "Scheduled" and "Pre-Game"; anything else (Live, Final, Suspended) has
 * started. The gameDate check is a belt-and-braces second opinion for the minutes where
 * StatsAPI's status lags first pitch.
 *
 * Returns null — meaning "do not filter" — if the schedule cannot be read. A board built
 * from a slate we could not inspect is the pre-existing behaviour and is recoverable; no
 * board at all is not.
 */
export async function startedGamePks(date) {
  try {
    const r = await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}`);
    if (!r.ok) throw new Error(`schedule ${r.status}`);
    const games = (await r.json())?.dates?.[0]?.games || [];
    if (!games.length) return null;
    const now = Date.now();
    const started = new Set();
    for (const g of games) {
      const live = g.status?.abstractGameState && g.status.abstractGameState !== "Preview";
      const past = g.gameDate && Date.parse(g.gameDate) <= now;
      if (live || past) started.add(String(g.gamePk));
    }
    return started;
  } catch (err) {
    console.log(`⚠️  ${date}: could not read the schedule (${err.message}) — building the board without a started-game filter.`);
    return null;
  }
}

export async function buildGoldenSnapshot(date, { force = false, dry = false } = {}) {
  const [btRow] = await sbGet(
    `brain_trust_snapshots?game_date=eq.${date}&select=predictions&limit=1`
  );
  const btPredictions = btRow?.predictions;
  if (!Array.isArray(btPredictions) || !btPredictions.length) {
    console.log(`⚠️  ${date}: no brain_trust_snapshots surface — run brain-trust-snapshot.mjs --snapshot first`);
    return { skipped: true, boards: 0 };
  }
  // Unpriced-but-graded markets are appended to the same candidate pool; the
  // per-board price rules in selectBoard decide which boards can rank them.
  const nrfi = await loadNrfiCandidates(date);
  let predictions = btPredictions.concat(nrfi);

  // Started games are dropped from the candidate pool — but ONLY for today. A past date is
  // a reconstruction (--backfill, or a re-run of an old slate) where every game is Final by
  // definition; filtering there would empty the pool and write nothing at all.
  let lateRun = false;
  if (date === todayET()) {
    const started = await startedGamePks(date);
    if (started?.size) {
      const before = predictions.length;
      predictions = predictions.filter((p) => !started.has(String(p.gamePk)));
      const dropped = before - predictions.length;
      if (dropped) {
        lateRun = true;
        console.log(
          `⏱️  ${date}: ${started.size} game(s) already underway — dropped ${dropped} of ${before} candidates. ` +
          `The board will be built from the ${predictions.length} rows whose games have not started.`
        );
      }
    }
    if (!predictions.length) {
      console.log(`⏱️  ${date}: every game has already started — too late to lock a board, nothing written.`);
      return { skipped: true, boards: 0 };
    }
  }

  const existing = await sbGet(
    `golden_snapshots?pick_date=eq.${date}&select=board,picks`
  );
  const haveBoard = new Set(existing.filter((r) => r.picks?.length).map((r) => r.board));

  // 12:00 ET noon for the date, so the UI shows a stable lock time rather than
  // whenever this job happened to run.
  //
  // EXCEPT on a late run: if games were already underway when the pool was built, stamping
  // noon would assert a lock that never happened, and the row would be indistinguishable
  // from a clean one forever after. Record the real time instead, so `locked_at != noon` is
  // the marker that this board was written mid-slate off a shortened pool.
  const lockedAt = lateRun ? new Date().toISOString() : `${date}T16:00:00.000Z`;
  let written = 0;

  for (const cfg of GOLDEN_BOARDS) {
    if (haveBoard.has(cfg.key) && !force && !dry) {
      console.log(`⏭️  ${date} ${cfg.key}: already written — skipping (use --force)`);
      continue;
    }
    const picked = selectBoard(predictions, cfg.key, 10);
    if (!picked.length) {
      console.log(`⚠️  ${date} ${cfg.key}: no qualifying rows — nothing written`);
      continue;
    }
    const rows = picked.map(snapshotEntry);

    console.log(`\n${dry ? "🔎" : "✅"} ${date} · ${cfg.label}${cfg.research ? " (research)" : ""} — ${rows.length} of ${predictions.length} priced rows`);
    for (const g of rows) {
      console.log(
        `   ${String(g.rank).padStart(2)}. ${g.emoji} ${g.marketLabel.padEnd(16)} ${String(g.playerName).slice(0, 22).padEnd(22)} ` +
        `${g.bookOdds == null ? "   —  " : `${g.bookOdds > 0 ? "+" : ""}${String(g.bookOdds).padStart(5)}`}  ` +
        `p ${g.modelProb.toFixed(3)}  edge ${g.edge == null ? "   — " : (g.edge * 100).toFixed(1).padStart(5)}pp`
      );
    }
    if (dry) continue;

    // idempotent: on_conflict upsert keyed on (pick_date, board).
    await sbRequest(`${SB_URL}/rest/v1/golden_snapshots?on_conflict=pick_date,board`, {
      method: "POST",
      headers: {
        apikey: SB_KEY,
        Authorization: `Bearer ${SB_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify({ pick_date: date, board: cfg.key, locked_at: lockedAt, picks: rows }),
    }, { idempotent: true, label: `upsert ${cfg.key}` });
    written++;
  }

  if (dry) return { skipped: true, dry: true, boards: GOLDEN_BOARDS.length };
  return { skipped: false, boards: written };
}

// ── grading ─────────────────────────────────────────────────────────────────
// Panel keys mirror scripts/brain-trust-snapshot.mjs so a board pick and a Brain
// Trust prediction settle identically.
const PANEL = {
  hits: { role: "batter", stat: "hits" },
  hrr:  { role: "batter", stat: "hrr" },
  tb:   { role: "batter", stat: "tb" },
  rbi:  { role: "batter", stat: "rbi" },
  hr:   { role: "batter", stat: "hr" },
  sb:   { role: "batter", stat: "sb" },
  ks:   { role: "pitcher", stat: "ks" },
};
const normName = (s) =>
  String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]/g, "");

// idempotent: a filtered PATCH sets the same columns to the same values however
// many times it runs.
const sbPatch = async (path, body) => {
  await sbRequest(`${SB_URL}/rest/v1/${path}`, {
    method: "PATCH",
    headers: {
      apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json", Prefer: "return=minimal",
    },
    body: JSON.stringify(body),
  }, { idempotent: true, label: `sb PATCH ${path.slice(0, 80)}` });
};

export async function gradeGoldenSnapshot(date) {
  // 'legacy' rows are pre-2026-08-06 goldenScore snapshots built from mlb_picks.
  // They carry a different pick shape (bestOdds, conf, goldenScore — no bookOdds
  // or per-line edge) and are graded through matchSavedPickToGolden on the
  // Results page. Grading them here yields NaN units, so they are excluded.
  const rows = (await sbGet(
    `golden_snapshots?pick_date=eq.${date}&graded=eq.false&board=neq.legacy&select=pick_date,board,picks`
  ));
  if (!rows.length) return { graded: 0, waiting: false };

  const panel = await sbGet(
    `player_day_features?game_date=eq.${date}&outcomes=not.is.null&select=player_name,role,outcomes&limit=2000`
  );
  if (!panel.length) {
    console.log(`⏳ ${date}: panel outcomes have not landed yet — leaving ungraded`);
    return { graded: 0, waiting: true };
  }
  const outcomes = new Map(panel.map((r) => [`${r.role}|${normName(r.player_name)}`, r.outcomes]));

  // NRFI is a GAME-level market — player_day_features has no row for it — so it
  // settles from its own already-graded mlb_picks row instead of the panel.
  const nrfiRows = await sbGet(
    `mlb_picks?pick_date=eq.${date}&prop_type=eq.nrfi&select=player_name,outcome,result`
  );
  const nrfiByMatchup = new Map(nrfiRows.map((r) => [normName(r.player_name), r]));

  let done = 0;
  for (const row of rows) {
    const picks = (row.picks || []).map((p) => {
      if (p.market === "nrfi") {
        const g = nrfiByMatchup.get(normName(p.playerName));
        const won = g?.outcome === "win" ? true : g?.outcome === "loss" ? false : null;
        return { ...p, actual: g?.result ?? null, won, push: g?.outcome === "push" };
      }
      const meta = PANEL[p.market];
      const v = meta ? outcomes.get(`${meta.role}|${normName(p.playerName)}`)?.[meta.stat] : null;
      // A player with no panel row (scratched, never appeared) settles as null and
      // is excluded from the record entirely — never counted as a loss.
      return { ...p, ...settlePick(p, v) };
    });

    // Units are only realisable on picks that had a price. NRFI has none, so it
    // counts toward the W-L record but is excluded from units/ROI — averaging it
    // in at an assumed price would invent P/L that could not have been bet.
    // summarizePicks (src/lib/goldenResults.js) is the one place that math lives;
    // the Results table sums these blobs back up with the same functions.
    const results = summarizePicks(picks);
    if (results.n === 0) {
      console.log(`⏳ ${date} ${row.board}: no picks settled yet — leaving ungraded`);
      continue;
    }
    const units = results.units;
    await sbPatch(`golden_snapshots?pick_date=eq.${date}&board=eq.${row.board}`, {
      picks, graded: true, graded_at: new Date().toISOString(), results,
    });
    console.log(
      `✅ ${date} ${row.board.padEnd(6)} ${results.wins}-${results.losses}` +
      `${results.pushes ? `-${results.pushes}` : ""}` +
      `${results.pending ? ` (${results.pending} pending)` : ""}  ` +
      `${(results.winRate * 100).toFixed(1)}%  ${units >= 0 ? "+" : ""}${units.toFixed(2)}u  ` +
      `${results.roi == null ? "n/a" : (results.roi * 100).toFixed(1) + "%"} ROI` +
      `${results.pricedN < results.n ? `  (${results.n - results.pricedN} unpriced)` : ""}`
    );
    done++;
  }
  return { graded: done, waiting: false };
}

/** Grade every still-ungraded date. Mirrors the Brain Trust sweep: retries all of
 *  them, not just yesterday, so one bad night can't strand a day forever. */
export async function sweepUngraded() {
  const rows = await sbGet(`golden_snapshots?graded=eq.false&board=neq.legacy&select=pick_date&order=pick_date.asc`);
  const dates = [...new Set(rows.map((r) => r.pick_date))];
  if (!dates.length) { console.log("[golden] sweep: nothing ungraded"); return; }
  let graded = 0, waiting = 0;
  for (const d of dates) {
    const res = await gradeGoldenSnapshot(d);
    graded += res.graded;
    if (res.waiting) waiting++;
  }
  console.log(`[golden] sweep done: ${graded} board-rows graded, ${waiting} dates still waiting on outcomes`);
}

/**
 * Re-run summarizePicks over the picks ALREADY stored on graded rows and rewrite
 * the `results` blob. Settlement is untouched — no outcome is re-fetched and no
 * `won` is recomputed — so this cannot change a record. It exists for the case
 * where the ROLLUP gains a field and history would otherwise read as "the tier
 * went 0-0" rather than "this day predates the tier".
 *
 * Used 2026-08-27 to backfill the play-tier counters (playWins/playUnits/…) onto
 * every day written before the play line existed. Those days stored `board` and
 * `rank` on each pick, which is all isPlayPick needs, so the tier is recoverable
 * exactly rather than approximated.
 *
 *   node --env-file=.env.local scripts/golden-snapshot.mjs --recompute
 *   node --env-file=.env.local scripts/golden-snapshot.mjs --recompute --dry
 */
export async function recomputeResults({ dry = false } = {}) {
  const rows = await sbGet(
    `golden_snapshots?graded=eq.true&board=neq.legacy&select=pick_date,board,picks,results&order=pick_date.asc`
  );
  let changed = 0, same = 0;
  for (const row of rows) {
    if (!row.picks?.length) continue;
    const next = summarizePicks(row.picks);
    // Guard: a recompute must never move the settled record. If it does, the
    // stored picks and the stored results disagree and that is a real bug —
    // report it and leave the row alone rather than overwriting the evidence.
    const prev = row.results || {};
    if (
      (prev.wins != null && prev.wins !== next.wins) ||
      (prev.losses != null && prev.losses !== next.losses) ||
      (prev.units != null && Math.abs(prev.units - next.units) > 0.005)
    ) {
      console.error(
        `⚠️  ${row.pick_date} ${row.board}: recompute disagrees with stored results ` +
        `(${prev.wins}-${prev.losses} ${prev.units}u → ${next.wins}-${next.losses} ${next.units}u) — SKIPPED`
      );
      continue;
    }
    if (prev.playWins != null && prev.playPricedN === next.playPricedN && prev.playWins === next.playWins) {
      same++;
      continue;
    }
    if (!dry) await sbPatch(`golden_snapshots?pick_date=eq.${row.pick_date}&board=eq.${row.board}`, { results: next });
    changed++;
    console.log(
      `${dry ? "[dry] " : ""}↻ ${row.pick_date} ${row.board.padEnd(6)} ` +
      `board ${next.wins}-${next.losses} ${next.units >= 0 ? "+" : ""}${next.units.toFixed(2)}u  ` +
      `play ${next.playWins}-${next.playLosses} ${next.playUnits >= 0 ? "+" : ""}${next.playUnits.toFixed(2)}u`
    );
  }
  console.log(`[golden] recompute: ${changed} rows updated, ${same} already current`);
}

// CLI entry — skipped when imported (e.g. by api/cron.js).
const isCli = import.meta.url === `file://${process.argv[1]}`;
if (isCli) {
  for (const [k, v] of [["SUPABASE_URL", SB_URL], ["SUPABASE_SERVICE_ROLE_KEY", SB_KEY]]) {
    if (!v) { console.error(`Missing env ${k}`); process.exit(1); }
  }
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const dry = args.includes("--dry");
  const explicitDate = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));

  const run = async () => {
    if (args.includes("--backfill")) {
      const bt = await sbGet(`brain_trust_snapshots?select=game_date&order=game_date.asc&limit=400`);
      for (const { game_date } of bt) await buildGoldenSnapshot(game_date, { force, dry });
      return;
    }
    if (args.includes("--recompute")) {
      await recomputeResults({ dry });
      return;
    }
    if (args.includes("--grade")) {
      if (explicitDate) await gradeGoldenSnapshot(explicitDate);
      else await sweepUngraded();
      return;
    }
    await buildGoldenSnapshot(explicitDate || todayET(), { force, dry });
  };
  run().then(() => process.exit(0))
       .catch((err) => { console.error(`❌ ${err.message || err}`); process.exit(1); });
}
