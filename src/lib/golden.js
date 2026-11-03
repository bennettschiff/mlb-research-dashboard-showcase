// ── Golden 10 scoring math ───────────────────────────────────────────────────
// Shared so the browser board (components/GoldenBoard.jsx) and the server-side
// snapshot writer (scripts/golden-snapshot.mjs) rank with one set of constants.
// Pure math — no React, no fetch.
//
// goldenScore blends model confidence with implied probability so that
// chalk-but-shaky and edge-but-50-50 picks both stay honest. Cross-market
// normalization (confNorm/probNorm in 0..1) lets batter props, Ks, and game
// lines compete on the same scale.

import { BOARD_CONFIGS, calcConfidence, isOfficialPick, isOfficialKsPick, ksPickDirection } from "./picks.js";
import { modelImpliedProb } from "./models.js";

export const GOLDEN_W_CONF = 0.6;
export const GOLDEN_W_PROB = 0.4;

export function goldenScore(confNorm, probNorm) {
  return GOLDEN_W_CONF * confNorm + GOLDEN_W_PROB * probNorm;
}

export function goldenNormFromMarket(market, payload) {
  // Returns { confNorm: 0-1, probNorm: 0-1 } so cross-market picks compare fairly.
  switch (market) {
    case "hits": case "hr": case "hrr": case "tb": case "sb": case "rbi": {
      const conf = payload.conf ?? 0;
      const prob = payload.impliedProb ?? 0.5;
      return { confNorm: Math.min(conf / 10, 1), probNorm: Math.max(0, Math.min(1, prob)) };
    }
    case "ks": {
      const conf = payload.conf ?? 0;
      const prob = payload.impliedProb ?? 0.5;
      return { confNorm: Math.min(conf / 10, 1), probNorm: Math.max(0, Math.min(1, prob)) };
    }
    case "ml": {
      // edge 4% → 0.7, 6% → 0.85, 8% → 0.95 (matches ML PLAY tiers)
      const edge = payload.edge ?? 0;
      const confNorm = Math.min(0.5 + edge * 6, 1);
      const probNorm = Math.max(0, Math.min(1, payload.winPct ?? 0.5));
      return { confNorm, probNorm };
    }
    case "rl": {
      // 0.75-run cover edge → 0.7, 1.5 → 0.9, 2+ → ~0.95
      const me = payload.marginEdge ?? 0;
      const confNorm = Math.min(0.5 + me * 0.27, 1);
      // RL doesn't expose a clean implied prob; rough heuristic from marginEdge.
      const probNorm = Math.max(0.5, Math.min(0.7, 0.5 + me * 0.08));
      return { confNorm, probNorm };
    }
    case "ou": {
      // 1.5-run total edge → 0.7, 3 → 0.9
      const oe = Math.abs(payload.ouEdge ?? 0);
      const confNorm = Math.min(0.5 + oe * 0.13, 1);
      const probNorm = Math.max(0.5, Math.min(0.7, 0.5 + oe * 0.04));
      return { confNorm, probNorm };
    }
    default:
      return { confNorm: 0, probNorm: 0 };
  }
}

/**
 * Assemble every official pick across markets into one ranked Golden 10.
 * Moved out of App.jsx 2026-08-09 with the GoldenBoard extraction — pure math,
 * so it belongs next to the constants it ranks with rather than in the UI.
 */
export function computeGoldenCandidates(scanData, slateRows) {
  const out = [];

  // Batter props (hits, hr, hrr, tb, sb, rbi)
  const batterMarkets = ["hits","hr","hrr","tb","sb","rbi"];
  for (const market of batterMarkets) {
    const picks = scanData?.byModel?.[market] || [];
    for (const p of picks) {
      if (p.watch) continue; // SB watch tier — research-only rows
      const conf = calcConfidence(p.score, market, p);
      if (!isOfficialPick(conf, market, p)) continue;
      const line = p.bookLine ?? p.bestLine?.line ?? null;
      const bookOdds = p.bookOdds || {};
      const bookEntries = Object.entries(bookOdds).filter(([,v]) => v != null);
      const bestBook = bookEntries.sort((a,b) => (b[1]||0) - (a[1]||0))[0] || null;
      const { confNorm, probNorm } = goldenNormFromMarket(market, { conf, impliedProb: p.impliedProb });
      out.push({
        market,
        marketLabel: BOARD_CONFIGS[market]?.label || market,
        emoji: BOARD_CONFIGS[market]?.emoji || "•",
        direction: "over",
        playerName: p.name,
        playerId: p.playerId,
        team: p.team,
        opponent: p.opponent,
        oppPitcher: p.oppPitcher,
        line,
        score: p.score,
        conf,
        impliedProb: p.impliedProb ?? null,
        bestBook: bestBook?.[0] ?? null,
        bestOdds: bestBook?.[1] ?? null,
        gamePk: p.game?.gamePk ?? null,
        gameTime: p.game?.gameDate ?? null,
        confNorm, probNorm,
        goldenScore: goldenScore(confNorm, probNorm),
        // raw pick for click-through
        _pick: p,
      });
    }
  }

  // Ks
  const ksPicks = scanData?.pitchers || [];
  for (const p of ksPicks) {
    if (!isOfficialKsPick(p)) continue;
    const dir = ksPickDirection(p);
    const best = p.bestLine || {};
    const oddsMap = (dir === "under" && p.bookUnderOdds) ? p.bookUnderOdds : (p.bookOdds || {});
    const bookEntries = Object.entries(oddsMap).filter(([,v]) => v != null);
    const bestBook = bookEntries.sort((a,b) => (b[1]||0) - (a[1]||0))[0] || null;
    // Ks objects don't carry a bestLine.impliedProb (batter-prop construct only). Without this
    // derivation every Ks pick defaulted to probNorm=0.5 and was capped at goldenScore≈0.77,
    // unable to crack Golden 10 against batter props with real 0.65–0.80 implieds.
    const ksLine = p.line ?? 4.5;
    const overProb = modelImpliedProb(p.xK, 'ks', ksLine);
    const ksImpliedProb = overProb == null ? 0.5 : (dir === "under" ? 1 - overProb : overProb);
    const { confNorm, probNorm } = goldenNormFromMarket("ks", { conf: p.conf, impliedProb: ksImpliedProb });
    out.push({
      market: "ks",
      marketLabel: "Strikeouts",
      emoji: "⚾",
      direction: dir,
      playerName: p.name,
      playerId: p.pitcherId,
      team: p.team,
      opponent: p.opponent,
      oppPitcher: null,
      line: p.line ?? 4.5,
      score: p.xK,
      conf: p.conf,
      impliedProb: best.impliedProb ?? null,
      bestBook: bestBook?.[0] ?? null,
      bestOdds: bestBook?.[1] ?? null,
      gamePk: p.game?.gamePk ?? null,
      gameTime: p.game?.gameDate ?? null,
      confNorm, probNorm,
      goldenScore: goldenScore(confNorm, probNorm),
      _pick: p,
    });
  }

  // ML/RL/OU from slate rows
  for (const r of (slateRows || [])) {
    if (r.isMLPlay && r.mlPick) {
      const pickSide = r.mlPick.side;
      const pickAbbr = pickSide === "home" ? r.homeAbbr : r.awayAbbr;
      const winPct = pickSide === "home" ? r.model.homeWinPct : r.model.awayWinPct;
      const best = pickSide === "home" ? r.homeMLBest : r.awayMLBest;
      const { confNorm, probNorm } = goldenNormFromMarket("ml", { edge: r.mlPick.edge, winPct });
      out.push({
        market: "ml",
        marketLabel: "Moneyline",
        emoji: "💰",
        direction: "over",
        playerName: `${r.awayAbbr} @ ${r.homeAbbr}`,
        playerId: r.gamePk,
        team: pickAbbr,
        opponent: pickSide === "home" ? r.awayAbbr : r.homeAbbr,
        oppPitcher: null,
        line: 0,
        score: r.mlPick.edge,
        conf: +(r.mlPick.edge * 100).toFixed(2),
        impliedProb: winPct ?? null,
        bestBook: best?.book ?? null,
        bestOdds: best?.odds ?? null,
        gamePk: r.gamePk,
        gameTime: r.gameTime ?? null,
        confNorm, probNorm,
        goldenScore: goldenScore(confNorm, probNorm),
        _pick: r,
      });
    }
    if (r.isRLPlay && r.rlPick) {
      const rlSide = r.rlPick.side;
      const pickedSpread = rlSide === "home" ? (r.spreadPoint ?? -1.5) : Math.abs(r.spreadPoint ?? -1.5);
      const { confNorm, probNorm } = goldenNormFromMarket("rl", { marginEdge: r.rlMarginEdge });
      out.push({
        market: "rl",
        marketLabel: "Run Line",
        emoji: "📏",
        direction: "over",
        playerName: `${r.awayAbbr} @ ${r.homeAbbr}`,
        playerId: r.gamePk,
        team: rlSide === "home" ? r.homeAbbr : r.awayAbbr,
        opponent: rlSide === "home" ? r.awayAbbr : r.homeAbbr,
        oppPitcher: null,
        line: pickedSpread,
        score: r.rlMarginEdge,
        conf: +(r.rlMarginEdge || 0).toFixed(2),
        impliedProb: null,
        bestBook: r.rlBest?.book ?? null,
        bestOdds: r.rlBest?.odds ?? null,
        gamePk: r.gamePk,
        gameTime: r.gameTime ?? null,
        confNorm, probNorm,
        goldenScore: goldenScore(confNorm, probNorm),
        _pick: r,
      });
    }
    if (r.isOUPlay && r.gameTotal != null) {
      const { confNorm, probNorm } = goldenNormFromMarket("ou", { ouEdge: r.ouEdge });
      out.push({
        market: "ou",
        marketLabel: "Total " + (r.ouDirection === "over" ? "Over" : "Under"),
        emoji: "📈",
        direction: r.ouDirection,
        playerName: `${r.awayAbbr} @ ${r.homeAbbr}`,
        playerId: r.gamePk,
        team: null,
        opponent: null,
        oppPitcher: null,
        line: r.gameTotal,
        score: Math.abs(r.ouEdge),
        conf: +Math.abs(r.ouEdge).toFixed(2),
        impliedProb: null,
        bestBook: r.ouBest?.[0] ?? null,
        bestOdds: r.ouBest?.[1] ?? null,
        gamePk: r.gamePk,
        gameTime: r.gameTime ?? null,
        confNorm, probNorm,
        goldenScore: goldenScore(confNorm, probNorm),
        _pick: r,
      });
    }
  }

  // Sort by goldenScore desc, take top 10
  return out.sort((a, b) => b.goldenScore - a.goldenScore).slice(0, 10);
}
