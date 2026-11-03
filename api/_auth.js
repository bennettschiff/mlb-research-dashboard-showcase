/**
 * api/_auth.js — shared write-auth gate for mutating API endpoints.
 *
 * The picks/golden-snapshots endpoints relay to Supabase with the SERVICE-ROLE
 * key, which bypasses Row-Level Security. Without a guard, any POST/PATCH/DELETE
 * to those routes lets the entire public internet insert, alter, or wipe rows in
 * mlb_picks / golden_snapshots — the substrate the whole ROI/CLV loop depends on.
 *
 * Writes legitimately originate in the browser (and the headless daily driver),
 * so a server-only secret won't work. Instead we reuse the access-gate code:
 *   - the browser stores the validated code in localStorage("mlb_auth")
 *   - the daily driver seeds the same value (scripts/daily-picks.mjs)
 *   - both send it as the X-Access-Code header on writes
 * This raises the bar from "anyone" to "anyone past the gate" — consistent with
 * the UI wall, and enough to stop drive-by abuse of the open write endpoints.
 *
 * If APP_ACCESS_CODE is unset (preview/local), writes are allowed rather than
 * locking the app out — same anti-lockout philosophy as api/auth.js.
 *
 * Returns true if the request may proceed; otherwise writes a 401 and returns
 * false (caller should `return` immediately).
 */
export function requireWriteAuth(req, res) {
  const expected = globalThis.process?.env?.APP_ACCESS_CODE;
  if (!expected) return true; // not configured → don't lock out previews/local

  const provided = req.headers?.["x-access-code"];
  const ok =
    typeof provided === "string" &&
    provided.trim().toLowerCase() === expected.trim().toLowerCase();

  if (!ok) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}
