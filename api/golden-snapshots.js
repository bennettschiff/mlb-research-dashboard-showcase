import { requireWriteAuth } from "./_auth.js";

const TABLE = "golden_snapshots";

function getEnv(name) {
  const value = globalThis.process?.env?.[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function parseBody(body) {
  if (body == null) return null;
  if (typeof body === "string") {
    return body.length ? JSON.parse(body) : null;
  }
  return body;
}

async function relaySupabase(method, query = "", body, extraHeaders = {}) {
  const url = getEnv("SUPABASE_URL");
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  const qs = query ? `?${query}` : "";
  const res = await fetch(`${url}/rest/v1/${TABLE}${qs}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: method === "PATCH" ? "return=minimal" : "return=representation",
      ...extraHeaders,
    },
    body: body == null ? undefined : JSON.stringify(body),
  });

  if (res.status === 204) return { status: 204, data: null };

  const text = await res.text();
  if (!res.ok) {
    throw new Error(text || `Supabase request failed (${res.status})`);
  }

  return { status: res.status, data: text ? JSON.parse(text) : null };
}

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const result = await relaySupabase("GET", req.query.query || "");
      res.status(result.status).json(result.data);
      return;
    }

    // All mutating methods require the access-code header (see api/_auth.js).
    if (!requireWriteAuth(req, res)) return;

    if (req.method === "POST") {
      // Upsert on (pick_date, board) so re-locks for the same day+board overwrite
      // cleanly. The conflict target MUST match the table's primary key, which
      // became composite in db/migrations/009_golden_boards.sql — leaving this at
      // `pick_date` alone makes PostgREST reject every write with 42P10.
      // Callers that omit `board` get the column default, 'legacy'.
      const result = await relaySupabase(
        "POST",
        "on_conflict=pick_date,board",
        parseBody(req.body),
        { Prefer: "resolution=merge-duplicates,return=representation" }
      );
      res.status(result.status).json(result.data);
      return;
    }

    if (req.method === "DELETE") {
      const q = req.query.query || "";
      if (!q || !q.includes("=")) {
        res.status(400).json({ error: "DELETE requires a query filter" });
        return;
      }
      const result = await relaySupabase("DELETE", q);
      if (result.status === 204) {
        res.status(204).end();
        return;
      }
      res.status(result.status).json(result.data);
      return;
    }

    res.status(405).json({ error: "Method not allowed" });
  } catch (error) {
    res.status(500).json({ error: error.message || "Golden snapshots proxy failed" });
  }
}
