// Sportsbook identity badge — a small brand-coloured mark for whichever book
// supplied a price. Inline SVG rather than an image asset: the boards render one
// per row, the app ships no book images, and an inline mark stays crisp at 14px
// with no extra request.
//
// The book keys are The Odds API bookmaker keys, the same ones propOddsMap and
// daily_odds use. Colours come from OddsLink so a badge and its odds cell always
// agree on what "FanDuel blue" means.
import { BOOK_COLORS, BOOK_NAMES, BOOK_ABBR } from "./OddsLink.jsx";

// DraftKings is a crown; FanDuel and Hard Rock get their monogram. Drawn in a
// 16x16 box so the badge scales off a single `size`.
const CROWN = "M2.6 11.4 L2.6 5.1 L5.9 7.4 L8 3.3 L10.1 7.4 L13.4 5.1 L13.4 11.4 Z";

export default function BookLogo({ book, size = 16, title, style = {} }) {
  if (!book) return null;
  const key = String(book).toLowerCase();
  const fill = BOOK_COLORS[key] || "#74839d";
  const label = BOOK_NAMES[key] || book;
  const abbr = BOOK_ABBR[key] || String(book).slice(0, 2).toUpperCase();

  return (
    <svg
      width={size} height={size} viewBox="0 0 16 16"
      role="img" aria-label={label}
      style={{ display: "inline-block", verticalAlign: "middle", flex: "none", ...style }}
    >
      <title>{title || label}</title>
      <rect x="0" y="0" width="16" height="16" rx="3.5" fill={fill} />
      {key === "draftkings" ? (
        <path d={CROWN} fill="#fff" />
      ) : (
        <text
          x="8" y="11.6" textAnchor="middle" fill="#fff"
          fontSize="8.2" fontWeight="700" fontFamily="system-ui, -apple-system, sans-serif"
          letterSpacing="-0.4"
        >
          {abbr}
        </text>
      )}
    </svg>
  );
}
