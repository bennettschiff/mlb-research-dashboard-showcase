/**
 * statTiles.js — the ranking math behind the Statcast tile strip above each props board.
 *
 * WHAT A TILE IS. One axis (barrel rate, pull-side air contact, pitcher hold, …) ranked
 * across the batters on today's slate for one market, rendered as a five-name leaderboard.
 * The atoms it ranks on are already attached to every scan row by extractRawSignals() in
 * models.js — the strip adds no fetch, it renders data the board was already holding.
 *
 * THE THREE RANKINGS, AND WHY THERE ARE THREE.
 * A tile that simply sorts by season barrel% prints the same five sluggers every day. Those
 * names are also the ones the market has already priced — the project's own HR audit found
 * top-confidence HR picks at −66% ROI against +9% for the bottom (project_hr_inversion),
 * because "who hits homers" is not private information. So a tile ranks three ways:
 *
 *   best     season value scaled by the model's OWN matchup adjustments for this game, so a
 *            mid-tier bat facing a homer-prone arm outranks an elite bat facing an ace.
 *   heating  biggest move in the last-15-game window against the same batter's season, which
 *            is the only ranking that can surface a name no season leaderboard would.
 *   value    the metric's league percentile minus the market's implied-probability percentile
 *            across the slate — an elite profile at a long price, which is where the edge is.
 *
 * The default body is a SPLIT: three `best` rows, then two `heating` rows. Expected and
 * unexpected in one glance, which is the whole point of the strip.
 *
 * MATCHUP ADJUSTMENT REUSES THE MODEL. `matchupTerms` name multipliers the model already
 * computed and left on the row (pitContactQualityAdj, pitBattedBallAdj, pullParkAdj, …). The
 * strip multiplies them; it does not re-derive them. Per the project rule, pure model math
 * lives in models.js and the UI never reimplements it — so a tile can only be as right or
 * wrong about a matchup as the model itself is, and a model retune moves the tiles with it.
 *
 * WHICH FIVE AXES A BOARD SHOWS IS MEASURED, NOT ARGUED (2026-08-11).
 * The sets below were re-picked by scripts/tile-rank.mjs, which ranks every numeric atom the
 * scan carries by how well it separates that market's own cash outcome — 5,725 graded
 * batter-days and 892 starter-days from daily_scan_results (the unbiased candidate pool, not
 * the picks we made), AUC as the metric because rank order is the only thing a five-name tile
 * claims. Two rules decide the set:
 *
 *   1. REPLICATION. An axis must hold direction and separation on the last 35% of dates,
 *      scored separately from the first 65%. Five shipped tiles failed that and are gone —
 *      see the drop list below.
 *   2. ONE TILE PER REDUNDANCY CLUSTER. Atoms correlated at |r| ≥ 0.80 tell the reader one
 *      thing, so only the strongest of each cluster gets a slot. Ranking power alone would
 *      have filled the Hits strip with five spellings of "this hitter is good" (season AVG,
 *      xBA, recent AVG, wRC+ all rank top-12 and all cluster together), which prints the same
 *      five names every night — the market's own ranking, already priced.
 *
 * WHAT WAS DROPPED AND WHY (rank of the atom pool for that market, AUC, holdout):
 *   Bullpen HR/9 on HRR       74/130, .485 — points the WRONG WAY, q=0.12, no replication.
 *                             It was the 2nd tile on the board. The retro-mining result it
 *                             came from (q=0.004, +22pp) was measured on saved picks; on the
 *                             unbiased pool the axis is not there. Also dropped from RBI
 *                             (74/107, .490).
 *   Hit Luck on Hits          77/122, .490, q=0.43 — the FIRST tile on the board. xBA alone
 *                             ranks 3rd (.558); subtracting season AVG destroys it, because
 *                             the difference keeps AVG's day-to-day noise and throws away the
 *                             skill both terms share. Replaced by xBA itself.
 *   Bat Speed on HRR          121/130, .503, −0.7pp. (Kept on HR, where it is 25/127 at .566
 *                             — that split is the finding, not an inconsistency.)
 *   Run Environment on HRR    89/130, .510, q=0.38. Park Factor on RBI 81/107, .506, q=0.44.
 *   Pitcher HR Risk on HR     121/127, .503, q=0.37 — barrels allowed does not rank HR days.
 *   Sprint Speed on TB        93/132, .510, q=0.30.
 *   Catcher Runs On / Bullpen Leaks / Secondary Lead on SB — 75/74/71 of 78, AUC .499/.498/
 *                             .491. The catcher tile is the cleanest null in the whole study:
 *                             AUC .4993, Q1→Q4 −0.0pp. SB is a runner market; the defensive
 *                             axes do not rank it.
 *   Opponent K% on Ks         oppKRatePct is NULL league-wide (the statSplits sitCode trap,
 *                             2026-08-09) — the tile has never rendered. Replaced by
 *                             lineupWhiff, which is populated on 99% of starter rows and
 *                             ranks at .582 / +16.1pp.
 *
 * The digest lives at scripts/tile-rank/YYYY-MM-DD.md; re-run it before changing a set.
 *
 * HEATING IS NOISE-GATED, AND DELIBERATELY NOT THE DEFAULT SORT.
 * scripts/recent-form-lift.mjs measured a 15-game window over 18,475 batter-days: it adds no
 * predictive lift over season-to-date at any window length (ΔAUC −0.003 to −0.011,
 * walk-forward), and NOISE_RATIO puts barrel% at 0.95 — a 15-game barrel% swings about as far
 * as the real spread between players. So the window never ranks a tile's headline rows, only
 * its two trailing slots; a row must clear both its denominator floor (noiseTier) and
 * MIN_HEAT_SHIFT to appear at all; and rows on `marginal` metrics are flagged so the UI can
 * dim them. Bat speed (0.33) and swing length (0.27) are the windows that actually hold up.
 */
import { empiricalPercentile, noiseTier, WINDOW_METRICS } from "./recentWindow.js";
import { oddsToImplied, bestBookOdds } from "./models.js";

/** Percentile points a window must move before it counts as "heating" rather than drift. */
export const MIN_HEAT_SHIFT = 8;

/**
 * Season sample a player needs before a tile will rank him.
 *
 * A rate over 10 at-bats is not a measurement, and it wins leaderboards precisely because it
 * is unconstrained: on 2026-08-09 the Hits board's Zone Contact tile was topped by a hitter
 * at 100.0% on 10 AB, and Barrel Rate by one at 22.2% on 13 AB. Both read as elite and were
 * noise. The floor costs almost nothing real — 2 of 131 rows on that slate sat below it,
 * against a median of 376 AB — while removing exactly the rows that are artefacts.
 *
 * Deliberately low rather than a true qualification bar: the point of these tiles is to
 * surface hitters the season leaderboard would not, so a July callup with a few hundred PA
 * must survive. Only the genuinely unmeasurable is cut.
 */
export const MIN_BATTER_AB = 50;
export const MIN_PITCHER_IP = 20;

/**
 * Is this row's season sample big enough to rank? Rows that do not carry a sample field at
 * all (per-pitcher / per-team tiles, whose values are season aggregates of the opposition)
 * are not constrained — there is nothing to constrain them by.
 */
function hasSample(r) {
  if (typeof r?.seasonAB === "number") return r.seasonAB >= MIN_BATTER_AB;
  if (typeof r?.seasonIP === "number") return r.seasonIP >= MIN_PITCHER_IP;
  return true;
}

/** Rows in a tile: three ranked by matchup-adjusted season, two by window movement. */
export const TILE_BEST_ROWS = 3;
export const TILE_HEAT_ROWS = 2;

/**
 * Metrics where a LOWER raw value is the better outcome. Used to orient both the percentile
 * bar and the window shift, so a falling K% reads as improvement exactly like a rising
 * barrel% does. (recentWindow.js infers this per player from Savant's published percentile;
 * on a board there is no per-player Savant percentile to infer from, so the direction is
 * declared once here.)
 */
const LOWER_IS_BETTER = new Set(["k_pct", "whiff_pct", "oz_swing_pct", "gb_pct", "popup_pct",
                                 "kPct", "whiffPct", "chasePct", "swingLength"]);

const num = v => (typeof v === "number" && Number.isFinite(v) ? v : null);
const pct1 = v => (v == null ? null : `${v.toFixed(1)}%`);
// Baseball's leading-dot convention, but only where it is true: OPS and RISP OPS run past
// 1.000 (this slate topped out at 1.138 and 1.406), and ".1138" is not a number anyone
// reads. Above 1 it prints normally.
const dec3 = v => v == null ? null
  : Math.abs(v) >= 1 ? v.toFixed(3)
  : `${v < 0 ? "-" : ""}.${Math.round(Math.abs(v) * 1000).toString().padStart(3, "0")}`;
const int0 = v => (v == null ? null : String(Math.round(v)));

/** Multiply the model's own adjustment terms for this game. Absent/no-op terms are 1.0. */
function matchupMult(result, terms) {
  if (!terms?.length || !result) return 1;
  let m = 1;
  for (const t of terms) {
    const v = num(result[t]);
    if (v != null && v > 0) m *= v;
  }
  // The product of four independent ±15% terms can reach 1.7, which would let matchup
  // outrank the metric itself and turn a "barrel rate" tile into a "bad pitcher" tile.
  return Math.min(1.35, Math.max(0.74, m));
}

// ── Tile definitions ─────────────────────────────────────────────────────────
// value:        season value for the axis, read off the row (result atoms / pick fields)
// leagueField:  key into seasonLeague for a true league percentile; omit for derived axes,
//               which fall back to a percentile within the slate (labelled as such in the UI)
// windowMetric: key into the L15 window, when one of the nine measured metrics fits the axis
// matchupTerms: model adjustment terms that make this axis matchup-aware
// sortKey:      board column this tile re-sorts to on click, when the board has one
// why:          the one-line thesis, shown on hover — a tile with no stated mechanism is
//               a number, not a signal

const barrelTile = {
  id: "barrel", label: "Barrel Rate", emoji: "💥", unit: "%",
  value: r => num(r.result?.rawBarrelPct),
  leagueField: "barrel_pct", windowMetric: "barrelPct",
  matchupTerms: ["pitContactQualityAdj", "pitBattedBallAdj"],
  fmt: pct1,
  why: "Barrels are the batted balls that actually leave the yard — EV and launch angle in the range where the ball carries. Scaled here by how much contact quality this pitcher allows.",
};

const hardHitTile = {
  id: "hardhit", label: "Hard-Hit%", emoji: "🔨", unit: "%",
  value: r => num(r.result?.rawHardHitPct),
  leagueField: "hard_hit_pct", windowMetric: "hardHitPct",
  matchupTerms: ["pitContactQualityAdj"],
  fmt: pct1,
  why: "Share of batted balls at 95+ mph. Stabilises far faster than barrel rate, so it is the steadier read on whether the bat is on the ball.",
};

const exitVeloTile = {
  id: "ev", label: "Exit Velocity", emoji: "🚀", unit: " mph",
  value: r => num(r.result?.rawExitVelo),
  leagueField: "avg_exit_velo", windowMetric: "exitVelo",
  matchupTerms: ["pitContactQualityAdj"],
  fmt: v => (v == null ? null : `${v.toFixed(1)}`),
  why: "Average exit velocity — the rawest measure of how hard a hitter is striking the ball, independent of where it lands.",
};

const batSpeedTile = {
  id: "batspeed", label: "Bat Speed", emoji: "⚡", unit: " mph",
  value: r => num(r.result?.rawBatSpeed),
  leagueField: "bat_speed", windowMetric: "batSpeed",
  matchupTerms: [],
  fmt: v => (v == null ? null : v.toFixed(1)),
  why: "Swing speed at the sweet spot. The lowest-noise window on the board (ratio 0.33), so its recent movement is the one form signal worth trusting.",
};

const pullAirTile = {
  id: "pullair", label: "Pull-Side Air", emoji: "🎣", unit: "%",
  // The archetype that actually homers: balls in the air, pulled. Neither half alone
  // separates — a pull-heavy groundball hitter and a spray-hitting flyball hitter both
  // score mid. Derived, so there is no league column and the bar is slate-relative.
  value: r => {
    const pull = num(r.result?.rawPullPct), fb = num(r.result?.rawFbPct);
    return pull != null && fb != null ? (pull * fb) / 100 : null;
  },
  matchupTerms: ["pullParkAdj", "pitBattedBallAdj"],
  fmt: pct1,
  why: "Pull rate × fly-ball rate: the pulled-air contact profile home runs come from. Scaled by this park's pull-side dimensions and the pitcher's fly-ball tendency.",
};

// NOT hr_fb_pct. That column is a synthesised proxy — etl_savant.py computes it as
// `min(40, barrel% * 2.0 / fb% * 100)` with a constant known to be ~4x too large, so it
// clamps at exactly 40.0 for 64% of the league (measured 2026-08-09, 386 of 604) and carries
// no rank order at the top. It is deliberately left broken for blend-refit reasons (see the
// ETL comment and modelHR's removal note), so it must not be ranked on.
// Replaces the Hit Luck tile (xBA − AVG), which ranked 77/122 on Hits at AUC .490 with no
// replication. xBA on its own is 3rd at .558. The difference was the problem, not the input:
// both terms carry the same season-skill signal, so subtracting cancels it and leaves the
// day-to-day noise of a batting average behind.
const xbaTile = {
  id: "xba", label: "Expected AVG", emoji: "🎯", unit: "",
  value: r => num(r.result?.rawXba),
  leagueField: "xba",
  matchupTerms: ["pitContactQualityAdj"],
  fmt: dec3,
  why: "The batting average his contact quality earns, regardless of where the balls landed. The single strongest axis on this board — 3rd of 122 atoms against the O0.5 outcome.",
};

const contactTile = {
  id: "contact", label: "Zone Contact", emoji: "🎾", unit: "%",
  value: r => num(r.result?.rawIzContactPct),
  leagueField: "iz_contact_pct",
  matchupTerms: ["pitDbQualityAdj"],
  fmt: pct1,
  why: "Contact rate on pitches in the zone. The floor skill behind a hits prop — a hitter who does not miss strikes rarely goes 0-for-4.",
};

const sweetSpotTile = {
  id: "sweetspot", label: "Sweet-Spot%", emoji: "🍬", unit: "%",
  value: r => num(r.result?.rawLdPct),
  leagueField: "ld_pct",
  matchupTerms: ["pitBattedBallAdj"],
  fmt: pct1,
  why: "Line-drive rate — the launch-angle band that falls in for hits more often than any other.",
};

const pitContactAllowedTile = {
  id: "pitcontact", label: "Contact Allowed", emoji: "🕳", unit: "%",
  value: r => num(r.result?.rawPitHardHitPct),
  leagueField: "hard_hit_pct", leagueSource: "pitcher",
  matchupTerms: [],
  perPitcher: true,
  fmt: pct1,
  why: "Hard-hit rate this pitcher allows. The arms at the top of this list are the ones giving up authoritative contact to everyone.",
};

const xslgTile = {
  id: "xslg", label: "Expected SLG", emoji: "📊", unit: "",
  value: r => num(r.result?.rawXslg),
  leagueField: "xslg",
  matchupTerms: ["pitContactQualityAdj", "pitBattedBallAdj"],
  fmt: dec3,
  why: "Slugging the contact quality earns, independent of where the balls happened to land. The cleanest read on extra-base ability behind a total-bases line.",
};

// ── Arsenal tiles — this batter against THIS pitcher's actual pitch mix ──────
//
// computeArsenalMatchup already weights the batter's per-pitch-type performance by how often
// the starter throws each pitch. The scan has carried these atoms all along and no board
// showed them; tile-rank puts them among the top matchup axes on every batter market
// (Rv100: 17/122 hits, 16/132 TB, 11/130 HRR, 8/107 RBI — all replicating). They are the
// only axes on the strip whose ranking CHANGES with the opponent rather than restating the
// season, which is exactly what a matchup tile is for.
//
// Slate-relative bars: an arsenal value is defined against one specific pitcher, so there is
// no league distribution of it to place a hitter in.

const arsenalFitTile = {
  id: "arsfit", label: "Arsenal Fit", emoji: "🧩", unit: "",
  value: r => num(r.result?.rawArsenalAvgRv100),
  matchupTerms: [],
  fmt: v => (v == null ? null : `${v >= 0 ? "+" : ""}${v.toFixed(1)}`),
  why: "Run value per 100 pitches this hitter has produced against the pitch types this starter actually throws, weighted by his usage. Positive means the arsenal suits him.",
};

const arsenalPowerTile = {
  id: "arspower", label: "Arsenal Damage", emoji: "🧨", unit: "%",
  value: r => num(r.result?.rawArsenalAvgHardHit),
  matchupTerms: [],
  fmt: pct1,
  why: "Hard-hit rate this batter posts against this starter's specific pitch mix. 21st of 127 atoms on the HR outcome — the matchup axis that replaced barrels-allowed, which did not rank at all.",
};

const arsenalSlugTile = {
  id: "arsslug", label: "Arsenal Slug", emoji: "🧱", unit: "",
  value: r => num(r.result?.rawArsenalAvgXslg),
  matchupTerms: [],
  fmt: dec3,
  why: "Expected slugging this batter earns against this starter's pitch types. 15th of 132 on total bases, ahead of every batter-only power axis except his own split.",
};

// ── Handedness splits ────────────────────────────────────────────────────────
// The platoon line, which no tile showed. Slate-relative: the value is already conditioned
// on the opposing hand, so a league distribution of "OPS vs hand" would mix two populations.

const splitOpsTile = {
  id: "splitops", label: "OPS vs Hand", emoji: "🤚", unit: "",
  value: r => num(r.result?.rawSplitOps),
  matchupTerms: [],
  fmt: dec3,
  why: "Season OPS against this starter's throwing hand. 3rd of 132 atoms on total bases and 5th of 130 on H+R+RBI — the platoon split outranks every Statcast contact-quality axis on both.",
};

const splitSlgTile = {
  id: "splitslg", label: "SLG vs Hand", emoji: "🤚", unit: "",
  value: r => num(r.result?.rawSplitSlg),
  matchupTerms: [],
  fmt: dec3,
  why: "Season slugging against this starter's throwing hand — the power half of the platoon split, 16th of 127 on the home-run outcome.",
};

const wrcTile = {
  id: "wrc", label: "wRC+", emoji: "🏆", unit: "",
  value: r => num(r.result?.rawWrcPlus),
  leagueField: "wrc_plus",
  matchupTerms: ["pitDbQualityAdj"],
  fmt: int0,
  why: "Park- and league-adjusted offensive production, 100 = average. The single best summary of a hitter's overall contribution to a H+R+RBI line.",
};

// ── Opposing-starter tiles ───────────────────────────────────────────────────
// One row per pitcher, not per hitter: every batter in a game carries the same value, so
// listing all nine would fill the tile with one matchup.

const pitToppedTile = {
  id: "pittopped", label: "Topped Rate", emoji: "⛏", unit: "%",
  // Lowest first: a starter who tops the ball is beating it into the ground, and a ground
  // ball is worth one base at most. 26th of 132 on TB, +6.4pp Q1→Q4.
  value: r => num(r.result?.rawPitToppedPct),
  invert: true,
  matchupTerms: [],
  perPitcher: true,
  fmt: pct1,
  why: "How often this starter induces topped contact, lowest first. Topped balls are grounders, and grounders cap a total-bases line at one base — the arms at the top of this list are the ones who cannot keep the ball down.",
};

const pitBlastAllowedTile = {
  id: "pitblast", label: "Blasts Allowed", emoji: "💥", unit: "%",
  // Stored as a FRACTION (0.05–0.13 across a slate), unlike the pitcher's other batted-ball
  // atoms which are already percentages. Rendering it with the shared pct1 printed "0.1%"
  // for the slate leader.
  value: r => { const v = num(r.result?.rawPitBlastAllowed); return v != null ? v * 100 : null; },
  matchupTerms: [],
  perPitcher: true,
  fmt: pct1,
  why: "Share of swings against this starter that bat-tracking scores as a blast — fast and squared up at once. The damage-swing rate he concedes, before any of it turns into a result.",
};

// ── RBI opportunity ──────────────────────────────────────────────────────────
// computeRBIModel emits a narrower atom set than the other batter models — no pitcher
// batted-ball atoms and no gameEnvAdj (verified on the 2026-08-09 scan). Its two strongest
// axes are its own: how often this hitter comes up with runners in scoring position, and
// what he does when he gets there. rispAB is the single best atom on the board — 1st of 107,
// +10.6pp — and the tile that used to hold that slot (Park Factor) was 81st and did not
// replicate.
const rispAbTile = {
  id: "rispab", label: "RISP At-Bats", emoji: "🧭", unit: "",
  value: r => num(r.result?.rispAB),
  matchupTerms: [],
  fmt: int0,
  why: "Season at-bats with runners in scoring position. An RBI needs someone on base first, and this is the cleanest measure of how often this hitter actually gets that chance — the top-ranked axis of 107 tested on the O0.5 outcome.",
};

const rispOpsTile = {
  id: "rispops", label: "RISP OPS", emoji: "🎪", unit: "",
  value: r => num(r.result?.rispOPS),
  matchupTerms: [],
  fmt: dec3,
  why: "OPS with runners in scoring position — what he does with the chances RISP At-Bats counts.",
};

const lineupTile = {
  id: "lineup", label: "Lineup Slot", emoji: "📋", unit: "",
  value: r => {
    const o = num(r.lineupOrder ?? r.result?.lineupOrder);
    return o != null ? o : null;
  },
  invert: true,
  matchupTerms: [],
  fmt: v => (v == null ? null : `#${Math.round(v)}`),
  why: "Batting order position. Slot drives plate appearances, and for RBI it also drives how often men are on base ahead of him.",
};

// ── SB tiles — the running-game atoms behind the green-light columns ──────────

const sbIntentTile = {
  id: "sbintent", label: "Steal Intent", emoji: "🎯", unit: "%",
  value: r => { const v = num(r.result?.rawSbRateSbx); return v != null ? v * 100 : null; },
  matchupTerms: [],
  fmt: v => (v == null ? null : `${v.toFixed(1)}%`),
  why: "Statcast expected steal rate — how often this runner goes, given the situations he is actually in. Intent, separated from opportunity.",
};

const sbSpeedTile = {
  id: "sbspeed", label: "Home-to-First", emoji: "⚡", unit: "s",
  value: r => num(r.result?.rawHpTo1b),
  invert: true,
  matchupTerms: [],
  fmt: v => (v == null ? null : `${v.toFixed(2)}s`),
  why: "Home-to-first time, lowest first (league ≈4.40s). A steal is a standing start, so this may read the skill better than top-end sprint speed does.",
};

const sbHoldTile = {
  id: "sbhold", label: "Pitcher Hold", emoji: "🐌", unit: "%",
  value: r => { const v = num(r.result?.rawPitRateSbx); return v != null ? v * 100 : null; },
  matchupTerms: [],
  perPitcher: true,
  fmt: v => (v == null ? null : `${v.toFixed(1)}%`),
  why: "Expected steal rate allowed by the pitcher. Slow to the plate is worth more to a steal than raw speed is.",
};

// The three axes that replaced the catcher / bullpen / secondary-lead tiles. Those three
// were the weakest group in the whole study — 75th, 74th and 71st of 78 atoms, AUC .499,
// .498 and .491. The catcher tile in particular is the cleanest null measured anywhere on
// the strip: AUC .4993, Q1→Q4 −0.0pp over 5,725 batter-days. Pitcher Hold survives and stays.

// NOT rawSbAttemptRate, which ranks 3rd of 78 (AUC .701) and looks like the obvious pick.
// It is byte-identical to rawSbRateSbx — Steal Intent, the tile above it — on 96 of 129 rows
// of a live slate, with the same slate maximum. The correlation clustering did not catch it
// because the 26% of rows that do differ are enough to drop |r| under 0.80, but a tile shows
// FIVE NAMES and those two would show the same five. Run value is the next distinct cluster.
const sbRunValueTile = {
  id: "sbrv", label: "Steal Run Value", emoji: "🏃", unit: "",
  value: r => num(r.result?.rawSbRunValue),
  matchupTerms: [],
  fmt: v => (v == null ? null : `${v >= 0 ? "+" : ""}${v.toFixed(1)}`),
  why: "Runs this baserunner has added by stealing — attempts and successes net of the times he was thrown out. 7th of 78 atoms at AUC .614, and unlike attempt rate it prices the outs.",
};

const boltsTile = {
  id: "bolts", label: "Bolts", emoji: "⚡", unit: "",
  value: r => num(r.result?.rawBolts),
  matchupTerms: [],
  fmt: int0,
  why: "Count of runs tracked at 30+ ft/s this season. A top-end-speed measure that also counts how often he is put in a position to use it.",
};

const xbAggroTile = {
  id: "xbaggro", label: "Extra-Base Push", emoji: "👟", unit: "",
  // A rate difference spanning about −0.17 to +0.12, so one decimal on the raw value printed
  // "+0.1" for the slate leader and "-0.0" for most of the board. Scaled to percentage points.
  value: r => { const v = num(r.result?.rawXbAttAboveAvg); return v != null ? v * 100 : null; },
  matchupTerms: [],
  fmt: v => (v == null ? null : `${v >= 0 ? "+" : ""}${v.toFixed(1)}`),
  why: "Extra-base attempts above what an average runner would try from the same spots — first-to-third, scoring from second. Aggression on the bases, which ranks steals better than the defence he is running against does.",
};

// ── Ks tiles (pitcher board) ─────────────────────────────────────────────────
// A Ks row is a scanned STARTER, not a batter pick: the atoms live on `advancedStats` (the
// pitcher_advanced_stats row passed through at scan time) and on the spread-in Mx model
// outputs, not under `result`. `pitcherLeague` is the distribution these rank against —
// with ~15 starters on a slate, a slate rank alone would be far too coarse to mean anything.

const cswTile = {
  id: "csw", label: "CSW%", emoji: "🎯", unit: "%",
  value: r => num(r.advancedStats?.csw_pct),
  leagueField: "csw_pct", leagueSource: "pitcher",
  matchupTerms: [],
  fmt: pct1,
  why: "Called strikes plus whiffs over total pitches. The most stable single-number strikeout skill — it counts the pitches that get strikes regardless of how.",
};

// Whiff% is NOT a separate tile: it clusters with Stuff+ at |r| ≥ 0.80 on the Ks board
// (along with Pit+ and Savant whiff), and two tiles from one cluster print one leaderboard
// twice. Stuff+ carries the cluster because it is the one the pitch-quality model produces.

const kRateTile = {
  id: "krate", label: "K Rate", emoji: "🥶", unit: "%",
  value: r => num(r.advancedStats?.k_pct),
  leagueField: "k_pct", leagueSource: "pitcher",
  matchupTerms: [],
  fmt: pct1,
  why: "Share of batters he strikes out. The plainest possible axis and among the strongest — 6th of 59, +36.9pp Q1→Q4. It carries the cluster SIERA used to occupy, and says the same thing without an ERA estimator's indirection.",
};

// Its own cluster, and strong: 18th of 59 at AUC .335 (lowest first), +34.7pp. What a
// strikeout actually requires is that the hitter misses a strike, and no shipped tile
// measured that from the pitcher's side.
const izContactAllowedTile = {
  id: "pitizcontact", label: "Zone Contact Allowed", emoji: "🕸", unit: "%",
  value: r => num(r.izContactPct ?? r.advancedStats?.iz_contact_pct),
  leagueField: "iz_contact_pct", leagueSource: "pitcher",
  invert: true,
  matchupTerms: [],
  fmt: pct1,
  why: "Contact hitters make on his pitches inside the zone, lowest first. A strikeout needs a missed strike, and this is the direct measure of how often he gets one.",
};

const stuffTile = {
  id: "stuff", label: "Stuff+", emoji: "🔧", unit: "",
  value: r => num(r.advancedStats?.stf_plus),
  leagueField: "stf_plus", leagueSource: "pitcher",
  matchupTerms: [],
  fmt: int0,
  why: "Pitch-quality model on velocity, movement and release, 100 = average. Rates the pitches themselves independent of results.",
};

// Replaces the Opponent K% tile, whose atom (oppKRatePct) is NULL on 100% of starter rows —
// the statSplits sitCode trap (vls/vrs are batting-only, so the vs-hand team split has
// always come back empty). That tile has never rendered a single row. lineupWhiff answers
// the same question from data the scan does have: it is populated on 99% of starter rows and
// ranks 40th of 59 at +16.1pp, and it is the only axis on this board that changes with the
// opponent rather than restating the pitcher.
const lineupWhiffTile = {
  id: "lineupwhiff", label: "Lineup Whiff%", emoji: "🥶", unit: "%",
  value: r => num(r.lineupWhiff),
  matchupTerms: [],
  fmt: pct1,
  why: "Swing-and-miss rate of the lineup he faces tonight, from the confirmed or projected order. The opponent half of the matchup — a mid-tier arm against a whiff-prone lineup beats an ace against a contact team.",
};

const fbVeloTile = {
  id: "fbvelo", label: "Fastball Velo", emoji: "🔥", unit: " mph",
  value: r => num(r.advancedStats?.fastball_velo),
  leagueField: "fastball_velo", leagueSource: "pitcher",
  matchupTerms: [],
  fmt: v => (v == null ? null : v.toFixed(1)),
  why: "Average four-seam velocity. Velocity is the input every other strikeout skill is built on top of.",
};

const chaseTile = {
  id: "pitchase", label: "Chase Induced", emoji: "🪝", unit: "%",
  value: r => num(r.ozSwingPct ?? r.advancedStats?.chase_pct),
  leagueField: "chase_pct", leagueSource: "pitcher",
  matchupTerms: [],
  fmt: pct1,
  why: "How often hitters swing at his pitches outside the zone. Chase is where two-strike counts turn into strikeouts.",
};

/**
 * Which tiles each board shows, in strip order — strongest measured axis first.
 *
 * Every entry replicates on held-out dates and comes from a distinct redundancy cluster; the
 * ranks in the `why` strings are its position in that market's own atom pool (see the header
 * and scripts/tile-rank/). Each strip deliberately spans three kinds of axis rather than
 * five spellings of one:
 *
 *   SKILL      what the hitter or pitcher does, season-to-date
 *   MATCHUP    what changes tonight — arsenal fit, the platoon hand, the opposing arm
 *   OPPORTUNITY how many chances he gets — lineup slot, RISP at-bats
 *
 * A strip of pure skill axes would rank the same five names every night, which is the
 * market's own ranking and is already in the price (project_hr_inversion).
 */
export const TILE_SETS = {
  hits: [xbaTile, sweetSpotTile, arsenalFitTile, lineupTile, contactTile, pitContactAllowedTile],
  hr:   [barrelTile, hardHitTile, splitSlgTile, arsenalPowerTile, batSpeedTile, pullAirTile],
  tb:   [splitOpsTile, arsenalSlugTile, xslgTile, exitVeloTile, pitToppedTile, pitBlastAllowedTile],
  hrr:  [xbaTile, splitOpsTile, arsenalFitTile, wrcTile, lineupTile, pitContactAllowedTile],
  rbi:  [rispAbTile, arsenalFitTile, wrcTile, hardHitTile, lineupTile, rispOpsTile],
  sb:   [sbIntentTile, sbRunValueTile, sbSpeedTile, boltsTile, xbAggroTile, sbHoldTile],
  ks:   [kRateTile, izContactAllowedTile, stuffTile, cswTile, fbVeloTile, chaseTile, lineupWhiffTile],
};

// ── Ranking ──────────────────────────────────────────────────────────────────

/**
 * "TOR vs Gray", "BOS · vs TOR" — who each row's number actually applies to.
 *
 * A pitcher-subject row names an arm; without this the reader cannot tell whose hitters that
 * arm is a problem for, which is the only reason the row is on a batter board at all. And a
 * batter-subject row on a batter board is only half a matchup until it names the starter.
 *
 * The perspective flips with the subject, because `team` and `opponent` are always stated
 * from the SCANNED row's point of view:
 *   batter tile   the row is the hitter    → his team, and the arm he faces
 *   pitcher tile  the row is the opposing starter, so `opponent` is HIS club and `team` is
 *                 the lineup he is being ranked against → "his club · vs that lineup"
 *   Ks board      the row IS the starter, so `team` is already his → "his club vs lineup"
 */
function matchupLabel(tile, r) {
  const last = n => (typeof n === "string" && n ? n.trim().split(/\s+/).slice(-1)[0] : null);
  if (tile.perPitcher || tile.perTeam) {
    // Named from the opposition's side: the value describes them, the ranking serves the
    // hitters in `team`.
    return [r.opponent, r.team ? `vs ${r.team}` : null].filter(Boolean).join(" · ") || null;
  }
  // A Ks row carries no oppPitcher (it IS the pitcher), so it falls through to the opponent.
  const foe = last(r.oppPitcher) || r.opponent;
  return [r.team, foe ? `vs ${foe}` : null].filter(Boolean).join(" ") || null;
}

/** Orient a percentile so "higher is better" always reads as a higher number. */
function orient(p, lowerBetter) {
  if (p == null) return null;
  return lowerBetter ? 100 - p : p;
}

/**
 * Where a batter's window sits relative to his own season, in percentile points.
 *
 * Both values are placed on the SAME season distribution, so the systematic offset between
 * our empirical percentile and Savant's published one cancels and only the difference has to
 * be right — the property placeWindowValue() depends on for the panel's bar markers.
 */
function windowShift(metric, windowValue, seasonValue, seasonSorted, lowerBetter) {
  if (windowValue == null || seasonValue == null || !seasonSorted?.length) return null;
  const w = empiricalPercentile(seasonSorted, windowValue);
  const s = empiricalPercentile(seasonSorted, seasonValue);
  if (w == null || s == null) return null;
  return orient(w, lowerBetter) - orient(s, lowerBetter);
}

/**
 * Build one tile's rows from the slate.
 *
 * @param {object} tile     a definition from TILE_SETS
 * @param {Array}  rows     board pick rows (each carrying .result from the scan)
 * @param {object} ctx      { window, mode }  window = the /api/batter-window payload
 * @returns {object|null}   null when the axis has no data on this slate — the strip drops the
 *                          tile rather than rendering an empty box, because a blank tile reads
 *                          as "nobody qualifies" when the truth is "this feed is down".
 */
export function buildTile(tile, rows, ctx = {}) {
  const { window: win = null, mode = "split" } = ctx;
  const lowerBetter = !!tile.invert;
  const seasonSorted = tile.leagueField
    ? (tile.leagueSource === "pitcher" ? win?.pitcherLeague : win?.seasonLeague)?.[tile.leagueField]
    : null;

  // One row per entity. Most tiles rank hitters; perPitcher / perTeam tiles describe the
  // opposition, where every hitter in a game carries an identical value — listing all nine
  // would fill the tile with one matchup.
  const seen = new Set();
  const cand = [];
  for (const r of rows) {
    const v = tile.value(r);
    if (v == null) continue;
    // A per-pitcher / per-team tile describes the opposition, whose season sample is not the
    // scanned row's — only a tile ranking the row's own player is sample-gated.
    if (!tile.perPitcher && !tile.perTeam && !hasSample(r)) continue;
    // A Ks row IS a pitcher, so its identity is pitcherId — not oppPitcher, which is the
    // batter-board notion of "the arm this row faces".
    const key = tile.perPitcher ? `P:${r.oppPitcher || r.opponent}`
              : tile.perTeam    ? `T:${r.opponent}`
              : `B:${r.playerId ?? r.pitcherId ?? r.name}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const mm = matchupMult(r.result, tile.matchupTerms);
    // Adjusting an inverted axis has to move it the same direction as a normal one: a
    // favourable matchup should improve the number, which for K%/whiff/time means down.
    const adjusted = lowerBetter ? v / mm : v * mm;

    const leaguePct = seasonSorted?.length
      ? orient(empiricalPercentile(seasonSorted, v), lowerBetter)
      : null;

    cand.push({
      key,
      name: tile.perPitcher ? (r.oppPitcher || "—") : tile.perTeam ? (r.opponent || "—") : r.name,
      subject: tile.perPitcher ? "pitcher" : tile.perTeam ? "team" : "batter",
      team: r.team, teamId: r.teamId, playerId: r.playerId ?? r.pitcherId ?? null,
      opponent: r.opponent, oppPitcher: r.oppPitcher,
      pick: r,
      matchupLabel: matchupLabel(tile, r),
      value: v, adjusted, matchup: mm, leaguePct,
      display: tile.fmt(v),
    });
  }
  if (!cand.length) return null;

  // Slate-relative percentile — the bar for derived axes with no league column, and the
  // basis of the price residual for every axis (a residual has to compare like with like).
  const slateSorted = cand.map(c => c.value).sort((a, b) => a - b);
  const byValue = [...cand].sort((a, b) => (lowerBetter ? a.value - b.value : b.value - a.value));
  byValue.forEach((c, i) => { c.slateRank = i + 1; });
  for (const c of cand) {
    c.slatePct = orient(empiricalPercentile(slateSorted, c.value), lowerBetter);
    if (c.leaguePct == null) c.leaguePct = c.slatePct;
    c.slateN = cand.length;
  }

  // ── Price residual: profile percentile minus market percentile, across the slate ──
  // Positive = the metric says more than the price does. Only defined for hitter tiles with
  // odds loaded; a pitcher/team axis has no per-row market to compare against.
  const priced = cand.filter(c => c.subject === "batter"
    && oddsToImplied(bestBookOdds(c.pick?.bookOdds)) != null);
  if (priced.length >= 4) {
    const impliedSorted = priced
      .map(c => oddsToImplied(bestBookOdds(c.pick.bookOdds)))
      .sort((a, b) => a - b);
    for (const c of priced) {
      const imp = oddsToImplied(bestBookOdds(c.pick.bookOdds));
      const impPct = empiricalPercentile(impliedSorted, imp);
      c.impliedPct = impPct;
      c.residual = c.slatePct != null && impPct != null ? c.slatePct - impPct : null;
    }
  }

  // ── Window movement ──
  if (tile.windowMetric && win?.batters) {
    for (const c of cand) {
      if (c.subject !== "batter" || c.playerId == null) continue;
      const w = win.batters[c.playerId] ?? win.batters[String(c.playerId)];
      if (!w) continue;
      const wv = w.values?.[tile.windowMetric];
      if (wv == null) continue;
      const tier = noiseTier(tile.windowMetric, w.counts);
      // `thin` means the denominator never reached the floor — the value exists but is not
      // a measurement, so it must not rank anything.
      if (tier === "thin") continue;
      const shift = windowShift(tile.windowMetric, wv, c.value, seasonSorted, lowerBetter);
      if (shift == null) continue;
      c.window = {
        value: wv, display: tile.fmt(wv), shift, tier,
        // Where the WINDOW sits, so a heating row's bar and its printed value describe the
        // same thing. Placed as season percentile + measured shift rather than at the
        // window's own absolute percentile: the offset between the two distributions then
        // cancels, which is the same reason placeWindowValue() draws the panel's markers
        // this way. Without it the bar showed the season while the number showed the window.
        pct: Math.max(1, Math.min(99, Math.round((c.leaguePct ?? 50) + shift))),
        games: w.games, den: w.counts?.[WINDOW_METRICS[tile.windowMetric].den] ?? null,
      };
    }
  }

  const byAdjusted = [...cand].sort((a, b) =>
    lowerBetter ? a.adjusted - b.adjusted : b.adjusted - a.adjusted);

  let picked;
  if (mode === "value") {
    const withResidual = cand.filter(c => c.residual != null);
    // Falling back to the default ranking would silently answer a different question than
    // the one the user clicked. The UI reads `empty` and says why instead.
    if (withResidual.length < 4) {
      return { ...tileMeta(tile), rows: [], mode, empty: "no odds loaded for this market yet" };
    }
    picked = withResidual.sort((a, b) => b.residual - a.residual)
                         .slice(0, TILE_BEST_ROWS + TILE_HEAT_ROWS)
                         .map(c => ({ ...c, rank: "value" }));
  } else if (mode === "heating") {
    const hot = cand.filter(c => c.window && c.window.shift >= MIN_HEAT_SHIFT);
    if (!hot.length) {
      return {
        ...tileMeta(tile), rows: [], mode,
        empty: tile.windowMetric ? "nobody's 15-game window has moved on this metric"
                                 : "no measured 15-game window for this metric",
      };
    }
    picked = hot.sort((a, b) => b.window.shift - a.window.shift)
                .slice(0, TILE_BEST_ROWS + TILE_HEAT_ROWS)
                .map(c => ({ ...c, rank: "heating" }));
  } else {
    // Split: the season/matchup leaders, then the biggest movers who are not already shown.
    const best = byAdjusted.slice(0, TILE_BEST_ROWS).map(c => ({ ...c, rank: "best" }));
    const shown = new Set(best.map(c => c.key));
    const heat = cand
      .filter(c => !shown.has(c.key) && c.window && c.window.shift >= MIN_HEAT_SHIFT)
      .sort((a, b) => b.window.shift - a.window.shift)
      .slice(0, TILE_HEAT_ROWS)
      .map(c => ({ ...c, rank: "heating" }));
    picked = [...best, ...heat];
  }

  return {
    ...tileMeta(tile),
    rows: picked,
    mode,
    // Whether the bar is a league percentile or only a slate rank changes what the bar
    // MEANS, so the UI has to be able to say which.
    scale: seasonSorted?.length ? "league" : "slate",
    hasWindow: !!tile.windowMetric && cand.some(c => c.window),
    hasResidual: cand.some(c => c.residual != null),
  };
}

function tileMeta(tile) {
  return {
    id: tile.id, label: tile.label, emoji: tile.emoji, why: tile.why,
    unit: tile.unit ?? "", invert: !!tile.invert,
    subject: tile.perPitcher ? "pitcher" : tile.perTeam ? "team" : "batter",
    windowMetric: tile.windowMetric ?? null,
    noiseTier: tile.windowMetric ? NOISE_TIER_LABEL[tile.windowMetric] ?? null : null,
  };
}

/** Static per-metric window quality, so a tile can say up front how much its window is worth. */
const NOISE_TIER_LABEL = {
  swingLength: "stable", batSpeed: "stable", whiffPct: "stable", chasePct: "stable",
  exitVelo: "marginal", kPct: "marginal", hardHitPct: "marginal", barrelPct: "marginal",
  bbPct: "noisy",
};

/** Build the whole strip for a board. Tiles with no data on this slate are dropped. */
export function buildTiles(boardKey, rows, ctx = {}) {
  const set = TILE_SETS[boardKey];
  if (!set || !rows?.length) return [];
  return set.map(t => buildTile(t, rows, ctx)).filter(Boolean);
}

/**
 * Look a tile definition up by id, so the board can sort its table on the same axis the
 * tile ranks — one definition drives both, and they cannot drift apart.
 */
export function getTileById(boardKey, id) {
  return (TILE_SETS[boardKey] || []).find(t => t.id === id) || null;
}

/**
 * Comparator for sorting board rows on a tile's axis. Sorts on the RAW value, not the
 * matchup-adjusted one: the board's other columns are all raw, and a column that silently
 * reordered by an invisible multiplier would be unreadable.
 */
export function tileComparator(tile, dir = "desc") {
  const lowerBetter = !!tile.invert;
  return (a, b) => {
    const va = tile.value(a), vb = tile.value(b);
    // Missing values sort last in both directions — a null is "unknown", not "worst".
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    const better = lowerBetter ? va - vb : vb - va;
    return dir === "desc" ? better : -better;
  };
}
