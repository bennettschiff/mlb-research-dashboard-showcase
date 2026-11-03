import { useState, useEffect } from "react";

/**
 * ModelGate — client-side access gate for the Model + Findings pages.
 *
 * These two pages expose the full projection-engine internals (weights,
 * multipliers, thresholds) and the raw mining output. We don't want them
 * publicly browsable, but they don't warrant real auth either — it's an
 * anti-casual gate, same spirit as the app-wide PasswordGate.
 *
 * The access code is NEVER stored in plaintext in the bundle. Only the SHA-256
 * hash of the lowercased code is committed; entry is lowercased before hashing
 * (so capitalization doesn't matter) and compared against the constant. Unlock
 * persists in localStorage so it's a one-time prompt per browser.
 *
 * Dev builds skip the gate (see GATE_OPEN_IN_DEV). Vite substitutes a literal
 * `false` for import.meta.env.DEV in a production build, so the branch is
 * dead-code-eliminated out of the shipped bundle — the live gate is unchanged.
 */

// sha256(lowercased access code). Plaintext intentionally absent from source.
const GATE_HASH = "5c9292f867d31a07015bb951c5b594c180231d71da4c4e10e41860d69762e75f";
const UNLOCK_KEY = "mlb_model_unlock";
const GATE_OPEN_IN_DEV = import.meta.env.DEV;

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

export default function ModelGate({ children, label = "Model" }) {
  const [unlocked, setUnlocked] = useState(() => {
    if (GATE_OPEN_IN_DEV) return true;
    try { return localStorage.getItem(UNLOCK_KEY) === "1"; } catch { return false; }
  });
  const [code, setCode] = useState("");
  const [error, setError] = useState(false);
  const [checking, setChecking] = useState(false);

  // SubtleCrypto needs a secure context; if unavailable (rare), fall open.
  useEffect(() => {
    if (!unlocked && !globalThis.crypto?.subtle) setUnlocked(true);
  }, [unlocked]);

  if (unlocked) return children;

  const submit = async (e) => {
    e.preventDefault();
    if (checking) return;
    setChecking(true); setError(false);
    try {
      const hex = await sha256Hex(code.trim().toLowerCase());
      if (hex === GATE_HASH) {
        try { localStorage.setItem(UNLOCK_KEY, "1"); } catch { /* ignore */ }
        setUnlocked(true);
      } else {
        setError(true); setCode("");
      }
    } catch {
      setError(true);
    } finally {
      setChecking(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "80px 20px", minHeight: 360 }}>
      <div style={{ fontSize: 34, marginBottom: 10 }}>🔒</div>
      <div style={{ fontSize: 16, fontWeight: 700, color: "#16233c", marginBottom: 4 }}>{label} — Restricted</div>
      <div style={{ fontSize: 12, color: "#74839d", marginBottom: 20, textAlign: "center", maxWidth: 360, lineHeight: 1.5 }}>
        This page exposes the internal projection engine. Enter the access code to continue.
      </div>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 10, width: 260 }}>
        <input
          type="password"
          value={code}
          autoFocus
          onChange={e => { setCode(e.target.value); setError(false); }}
          placeholder="Access code"
          style={{
            padding: "10px 12px", fontSize: 13, borderRadius: 8, outline: "none",
            background: "rgba(210,217,236,0.6)", color: "#16233c",
            border: `1px solid ${error ? "#d03131" : "rgba(32,98,200,0.25)"}`,
          }}
        />
        <button type="submit" disabled={checking} style={{
          padding: "10px 12px", fontSize: 13, fontWeight: 700, borderRadius: 8, cursor: "pointer",
          background: "rgba(32,98,200,0.24)", border: "1px solid rgba(32,98,200,0.4)", color: "#2062c8",
          opacity: checking ? 0.6 : 1,
        }}>{checking ? "Checking…" : "Unlock"}</button>
        {error && <div style={{ fontSize: 11, color: "#d03131", textAlign: "center" }}>Incorrect code — try again.</div>}
      </form>
    </div>
  );
}
