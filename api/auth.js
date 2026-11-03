/**
 * api/auth.js — server-side access-code check for the password gate.
 *
 * POST /api/auth  { code: "..." }  →  200 { ok: true } | 401 { ok: false }
 *
 * The old gate compared against a string hardcoded in the client bundle, so the
 * "password" shipped to everyone who opened devtools. The code now lives only in
 * the APP_ACCESS_CODE env var (Vercel + GH Actions). If the env var is missing
 * (e.g. a preview deploy), the gate accepts rather than locking the app out —
 * it's an anti-casual gate, not real auth.
 */
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  const expected = globalThis.process?.env?.APP_ACCESS_CODE;
  if (!expected) {
    return res.status(200).json({ ok: true, enforced: false });
  }
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const code = String(body?.code ?? "").trim().toLowerCase();
  const ok = code === expected.trim().toLowerCase();
  return res.status(ok ? 200 : 401).json({ ok, enforced: true });
}
