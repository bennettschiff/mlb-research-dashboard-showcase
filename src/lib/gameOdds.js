// ── The Odds API → per-game book shape ──────────────────────────────────────
// Pure reshaping of an Odds API event into the { books, gameTotal } object the
// Slate Odds table and the game-pick save path both read. Moved out of App.jsx
// with the 2026-08-14 SlateOdds extraction (project rule: a component that
// leaves App.jsx takes its pure helpers to src/lib with it). No fetching and no
// caching happen here — fetchMLBOdds still owns that.

const BOOKS = ["fanduel", "draftkings", "hardrockbet"];

// Team names arrive spelled differently across feeds ("St. Louis Cardinals" vs
// "St Louis Cardinals"), so match on letters only.
const normTeam = (s) => (s || "").toLowerCase().replace(/[^a-z]/g, "");

export function getGameOdds(oddsData, awayFullName, homeFullName) {
  if (!oddsData?.length || !awayFullName || !homeFullName) return null;
  const na = normTeam(awayFullName), nh = normTeam(homeFullName);
  const game = oddsData.find(g =>
    (normTeam(g.away_team) === na && normTeam(g.home_team) === nh) ||
    (normTeam(g.home_team) === na && normTeam(g.away_team) === nh)
  );
  if (!game) return null;
  // The feed occasionally lists the pair the other way round; re-derive which
  // of our two names is the feed's home side before matching outcomes.
  const flipped = normTeam(game.home_team) === na;
  const eAway = flipped ? homeFullName : awayFullName;
  const eHome = flipped ? awayFullName : homeFullName;
  const books = {};
  for (const bk of BOOKS) {
    const bkData = game.bookmakers?.find(b => b.key === bk);
    if (!bkData) { books[bk] = null; continue; }
    const h2h = bkData.markets?.find(m => m.key === "h2h");
    const spr = bkData.markets?.find(m => m.key === "spreads");
    const na2 = normTeam(eAway), nh2 = normTeam(eHome);
    const awayH2H = h2h?.outcomes.find(o => normTeam(o.name) === na2);
    const homeH2H = h2h?.outcomes.find(o => normTeam(o.name) === nh2);
    const tot = bkData.markets?.find(m => m.key === "totals");
    const overOut  = tot?.outcomes?.find(o => o.name === "Over");
    const underOut = tot?.outcomes?.find(o => o.name === "Under");
    books[bk] = {
      awayML:       awayH2H?.price ?? null,
      homeML:       homeH2H?.price ?? null,
      awayMLLink:   awayH2H?.link ?? null,
      homeMLLink:   homeH2H?.link ?? null,
      awaySpread:   spr?.outcomes.find(o => normTeam(o.name) === na2) ?? null,
      homeSpread:   spr?.outcomes.find(o => normTeam(o.name) === nh2) ?? null,
      overOdds:     overOut?.price ?? null,
      overPoint:    overOut?.point ?? null,
      overLink:     overOut?.link ?? null,
      underOdds:    underOut?.price ?? null,
      underLink:    underOut?.link ?? null,
    };
  }
  // Consensus total — books share the line, so the first Over point wins.
  let gameTotal = null;
  for (const bkData of (game.bookmakers || [])) {
    const tot = bkData.markets?.find(m => m.key === "totals");
    const over = tot?.outcomes?.find(o => o.name === "Over");
    if (over?.point != null) { gameTotal = over.point; break; }
  }

  return { books, gameTotal };
}

// Sportsbook landing pages — the fallback href when a book gives no deep link.
export const BOOK_URLS = {
  fanduel: "https://sportsbook.fanduel.com/baseball/mlb",
  draftkings: "https://sportsbook.draftkings.com/leagues/baseball/mlb",
  hardrockbet: "https://www.hardrock.bet/sports/baseball",
};
