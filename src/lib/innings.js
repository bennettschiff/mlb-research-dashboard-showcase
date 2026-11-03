// ══════════════════════════════════════════════════════════════════════════
// Baseball innings notation.
//
// MLB writes innings pitched in a base-3 fraction, not base 10: the digit after
// the point counts OUTS, so "5.1" is five and one third and "5.2" is five and
// two thirds. There is no ".3". Every innings string StatsAPI returns —
// gameLog[].stat.inningsPitched, seasonStats.inningsPitched,
// careerStats.inningsPitched — is in this notation.
//
// WHY THIS IS ITS OWN MODULE. `parseFloat("5.2")` is 5.2, which is wrong by a
// sixth of an inning, and wrong in the SAME DIRECTION every time: it always
// understates. Summed over a season the error compounds — ten "5.2" outings are
// 56⅔ innings, which parseFloat reads as 52 — and because innings is a
// DENOMINATOR for every rate this repo computes off it (K/9, K%, batters faced,
// IP per start), understating it inflates the rate. Five strikeouts in a "5.2"
// outing is 7.94 K/9, not the 8.65 parseFloat implies.
//
// The conversion already existed, correctly, in src/lib/nrfi.js, where it was
// written for the first-inning model and never shared. modelKs was parseFloat-ing
// the same strings a few hundred lines away. It lives here now so there is one
// definition and one place to test it.
//
// WHAT IS NOT IN THIS NOTATION — do not route these through here:
//   - projections.js `ip` (201.0, 193.0): full-season projections, genuine
//     decimals. Converting them would invent thirds that were never there.
//   - anything already divided (IP per start, IP per game), which is a real
//     decimal by the time it is computed.
// The rule: convert at the BOUNDARY, where a StatsAPI string is first read, and
// treat everything downstream as a true decimal.
// ══════════════════════════════════════════════════════════════════════════

/**
 * Convert MLB innings notation to a true decimal. "5.2" -> 5.6667, "7" -> 7.
 *
 * Returns 0 for null/undefined/blank/unparseable, which is what every existing
 * call site wanted (they all wrote `parseFloat(x) || 0`).
 *
 * DOUBLE-CONVERSION GUARD: a fractional part that is not a single 0, 1 or 2 is
 * not innings notation — it is a decimal someone has already converted, or a
 * per-start average. Those are returned as-is rather than being re-read as
 * outs, so passing an already-decimal 5.67 back through cannot silently become
 * 5 + 67/3. This is the realistic failure mode once one helper is shared across
 * models, and it is cheaper to make the function total than to audit callers.
 */
export function ipToDec(ip) {
  if (ip == null) return 0;
  const s = String(ip).trim();
  if (s === "") return 0;
  const m = /^(-?\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) {
    const n = Number(s);
    return Number.isFinite(n) ? n : 0;
  }
  const whole = parseInt(m[1], 10);
  if (m[2] == null) return whole;
  // Exactly one digit, 0-2 → outs. Anything else → already a decimal.
  if (m[2].length === 1 && m[2] <= "2") {
    const outs = parseInt(m[2], 10);
    return whole < 0 ? whole - outs / 3 : whole + outs / 3;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

/** True when a string is well-formed innings notation (no ".3".."[.]9" digit). */
export function isInningsNotation(ip) {
  if (ip == null) return false;
  const m = /^(-?\d+)(?:\.(\d))?$/.exec(String(ip).trim());
  return !!m && (m[2] == null || m[2] <= "2");
}
