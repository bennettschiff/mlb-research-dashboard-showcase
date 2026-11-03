// Read-only PostgREST passthrough for brain_trust_snapshots (Results tab parlay record).
// Writes happen server-side in scripts/brain-trust-snapshot.mjs; the client only reads.
const TABLE = "brain_trust_snapshots";

function getEnv(name) {
  const value = globalThis.process?.env?.[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }
    const url = getEnv("SUPABASE_URL");
    const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");
    const qs = req.query.query ? `?${req.query.query}` : "";
    const r = await fetch(`${url}/rest/v1/${TABLE}${qs}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    const text = await r.text();
    if (!r.ok) throw new Error(text || `Supabase request failed (${r.status})`);
    res.status(r.status).json(text ? JSON.parse(text) : null);
  } catch (error) {
    res.status(500).json({ error: error.message || "Brain Trust proxy failed" });
  }
}
