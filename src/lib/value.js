// src/lib/value.js — player "value" model: production vs. pay, with a skill-vs-luck
// confidence layer. This is intentionally WALLED OFF from the pick/board models —
// salary never feeds a prop decision. It powers the Payroll tab and the contract
// line on the panels only.
//
// Inputs:
//   • player_value.json rows  (WAR, cash salary, contract, ids)  — src/data/player_value.json
//   • advanced-stats rows     (wrc_plus/xwoba/siera/stf_plus/…)  — /api/advanced-stats
// Everything population-relative (percentiles, z-scores) is computed here so the UI
// never reimplements the math.

// ── Market constants ────────────────────────────────────────────────────────
// Open-market cost of a win in 2026 free agency (~$8M/WAR). Surplus value is the
// gap between what a player produced at that rate and what he's actually paid.
export const MARKET_DOLLAR_PER_WAR = 8_000_000;
// 2026 MLB league-minimum salary — the assumed cost of a player BBRef lists as null
// (pre-arbitration players, who are the structural bargains).
export const LEAGUE_MIN = 760_000;
// Rough league baselines for turning rate stats into 100-centered "+" indexes.
const LG_SIERA = 4.00;
const LG_K_BB_PCT = 13.5;
const LG_XWOBA = 0.320;

// ── Small pure helpers ──────────────────────────────────────────────────────
export const effectiveSalary = salary => (salary == null ? LEAGUE_MIN : salary);

// $/WAR is only meaningful for positive production.
export const dollarsPerWar = (salary, war) =>
  war > 0 ? effectiveSalary(salary) / war : null;

// Surplus value in dollars: market value of the WAR produced minus actual pay.
export const surplusValue = (war, salary) =>
  MARKET_DOLLAR_PER_WAR * (war ?? 0) - effectiveSalary(salary);

// Which side of the ball drives this player's value. Two-way players (Ohtani)
// keep both, but role picks the production lens.
export function playerRole(p) {
  const pa = p?.bat?.pa ?? 0;
  const ip = p?.pitch?.ip ?? 0;
  if (p?.pitch && (!p?.bat || (ip >= 10 && ip * 4 > pa))) return 'P';
  return 'B';
}

// Total WAR across roles (two-way sums both).
export const playerWar = p => (p?.bat?.war ?? 0) + (p?.pitch?.war ?? 0);

// 100-centered production index. Batters: wRC+ is already exactly this. Pitchers:
// blend SIERA (inverted), K-BB%, and Stuff+ into a comparable "Pit+".
export function productionPlus(p, adv) {
  if (!adv) {
    // No Statcast row — fall back to a coarse index from WAR rate so the player
    // still ranks somewhere sane rather than dropping out.
    return null;
  }
  if (playerRole(p) === 'B') {
    if (adv.wrc_plus != null) return adv.wrc_plus;
    if (adv.xwoba != null) return 100 * (adv.xwoba / LG_XWOBA);
    return null;
  }
  // Pitcher: assemble from whatever's present.
  const parts = [];
  if (adv.siera != null && adv.siera > 0) parts.push([0.45, 100 * (LG_SIERA / adv.siera)]);
  if (adv.k_bb_pct != null) parts.push([0.30, 100 * (adv.k_bb_pct / LG_K_BB_PCT)]);
  if (adv.stf_plus != null) parts.push([0.25, adv.stf_plus]);
  if (!parts.length) return null;
  const wsum = parts.reduce((s, [w]) => s + w, 0);
  return parts.reduce((s, [w, v]) => s + (w / wsum) * v, 0);
}

// Infer a service-time bucket. Real contract data (when the scraper lands) wins;
// otherwise infer from cash salary. The structural bargains are pre-arb.
export function inferServiceClass(p) {
  const c = p?.contract;
  if (c?.serviceClass) return c.serviceClass;
  const sal = p?.salary;
  if (sal == null || sal <= LEAGUE_MIN * 1.15) return 'pre-arb';
  if (sal < 4_000_000) return 'arb';
  return 'vet';
}

// ── Population stats ─────────────────────────────────────────────────────────
function percentileRanker(values) {
  const sorted = values.filter(v => v != null && Number.isFinite(v)).sort((a, b) => a - b);
  const n = sorted.length;
  return v => {
    if (v == null || !Number.isFinite(v) || n === 0) return null;
    // fraction of population at or below v, 0..100
    let lo = 0, hi = n;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] <= v) lo = mid + 1; else hi = mid; }
    return Math.round((lo / n) * 100);
  };
}
function zScorer(values) {
  const v = values.filter(x => x != null && Number.isFinite(x));
  const n = v.length || 1;
  const mean = v.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / n) || 1;
  return x => (x == null || !Number.isFinite(x) ? null : (x - mean) / sd);
}

// ── Main entry: enrich every player with all value lenses ────────────────────
// players  : object map mlbamId -> player_value row
// advByMlb : object map mlbamId -> advanced-stats row (batter OR pitcher)
// opts.minPa / opts.minIp : leaderboard qualification (rows kept but flagged)
export function buildValueRows(players, advByMlb = {}, opts = {}) {
  const minPa = opts.minPa ?? 20;
  const minIp = opts.minIp ?? 5;

  // 1) Base rows with role + raw value numbers.
  const rows = Object.values(players || {}).map(p => {
    const role = playerRole(p);
    const adv = advByMlb[p.mlbamId] || advByMlb[String(p.mlbamId)] || null;
    const war = playerWar(p);
    const salary = p.salary ?? null;
    const pa = p?.bat?.pa ?? 0;
    const ip = p?.pitch?.ip ?? 0;
    return {
      mlbamId: p.mlbamId, name: p.name, team: p.team, role,
      war, salary, effSalary: effectiveSalary(salary),
      pa, ip, opsPlus: p?.bat?.opsPlus ?? null,
      contract: p.contract || null,
      serviceClass: inferServiceClass(p),
      surplus: surplusValue(war, salary),
      dollarsPerWar: dollarsPerWar(salary, war),
      productionPlus: productionPlus(p, adv),
      // skill anchor (expected) vs results anchor — for the divergence lens
      _skill: role === 'B' ? (adv?.xwoba ?? null)
                           : (adv?.siera != null ? -adv.siera : null), // higher = better
      _result: role === 'B' ? (p?.bat?.opsPlus ?? p?.bat?.war ?? null)
                            : (p?.pitch?.war ?? null),
      qualified: role === 'B' ? pa >= minPa : ip >= minIp,
    };
  });

  // 2) Percentiles / z-scores within each role population (qualified only, so a
  //    3-PA cup-of-coffee line doesn't distort the scale).
  for (const role of ['B', 'P']) {
    const pop = rows.filter(r => r.role === role && r.qualified);
    const surplusZ = zScorer(pop.map(r => r.surplus));
    const skillPct = percentileRanker(pop.map(r => r._skill));
    const resultPct = percentileRanker(pop.map(r => r._result));
    const paymPct = percentileRanker(pop.map(r => r.effSalary));
    const prodPct = percentileRanker(pop.map(r => r.productionPlus));
    for (const r of rows) {
      if (r.role !== role) continue;
      r.surplusZ = surplusZ(r.surplus);
      r.skillPct = skillPct(r._skill);
      r.resultPct = resultPct(r._result);
      r.payPct = paymPct(r.effSalary);
      r.prodPct = prodPct(r.productionPlus);
      // Bang-for-buck: how much more you produce than you're paid (percentile gap).
      r.valueGap = (r.prodPct != null && r.payPct != null) ? r.prodPct - r.payPct : null;
      // Skill-vs-luck: skills ahead of results (+) = real/underrated/buy-low;
      // results ahead of skills (−) = over-performing / regression risk.
      r.divergence = (r.skillPct != null && r.resultPct != null) ? r.skillPct - r.resultPct : null;
      r.luckTag = r.divergence == null ? null
        : r.divergence >= 12 ? 'underrated'
        : r.divergence <= -12 ? 'regression-risk'
        : 'fair';
      // Composite bargain score: surplus (z) tilted by the skill confidence signal.
      const div = r.divergence == null ? 0 : r.divergence / 100;
      r.bargainScore = (r.surplusZ ?? 0) + 0.5 * div;
    }
  }
  return rows;
}

// ── Formatting (shared by Payroll tab + panels) ──────────────────────────────
export function formatMoney(n, { compact = false } = {}) {
  if (n == null) return '—';
  const neg = n < 0; const abs = Math.abs(n);
  let s;
  if (compact) {
    s = abs >= 1e9 ? `$${(abs / 1e9).toFixed(2)}B`
      : abs >= 1e6 ? `$${(abs / 1e6).toFixed(1)}M`
      : abs >= 1e3 ? `$${Math.round(abs / 1e3)}K`
      : `$${Math.round(abs)}`;
  } else {
    s = '$' + Math.round(abs).toLocaleString('en-US');
  }
  return neg ? `−${s}` : s;
}

// "5 Years / $150,000,000" — the panel header line. Falls back to current-year
// cash salary while contract structure is unavailable.
export function formatContract(p) {
  const c = p?.contract;
  if (c && c.years && c.totalValue) {
    const yr = c.years === 1 ? '1 Year' : `${c.years} Years`;
    return `${yr} / ${formatMoney(c.totalValue)}`;
  }
  if (p?.salary != null) return `${formatMoney(p.salary)} (${p.seasonLabel || 'current'})`;
  return null;
}
