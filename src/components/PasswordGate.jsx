import { useState, useEffect } from "react";

/**
 * PasswordGate — app-wide access gate.
 *
 * The code is verified server-side (/api/auth vs APP_ACCESS_CODE env) so it no
 * longer ships in the JS bundle. The stored code is re-verified on mount:
 * optimistic render (the headless daily driver pre-seeds localStorage), then
 * de-auth only on an explicit 401 — network errors fail open since this is an
 * anti-casual gate, not real auth.
 *
 * Dev builds skip the gate entirely (see GATE_OPEN_IN_DEV). Vite substitutes a
 * literal `false` for import.meta.env.DEV in a production build, so the branch
 * and the bypass are dead-code-eliminated out of the shipped bundle — the live
 * gate is byte-for-byte what it was.
 */
const GATE_OPEN_IN_DEV = import.meta.env.DEV;

async function postAccessCode(code) {
  const res = await fetch("/api/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  return { status: res.status, ok: res.ok };
}
// Stored-code revalidation: lenient — only an explicit 401 de-auths, so a network
// blip can't lock out the headless daily driver mid-automation.
async function verifyStoredCode(code) {
  try { return (await postAccessCode(code)).status !== 401; } catch { return true; }
}
// Active submission: strict — the server must say yes; errors reject.
async function submitAccessCode(code) {
  try { return (await postAccessCode(code)).ok; } catch { return false; }
}

export default function PasswordGate({ children }) {
  const [authed, setAuthed] = useState(() => {
    if (GATE_OPEN_IN_DEV) return true;
    try { return !!localStorage.getItem("mlb_auth"); } catch { return false; }
  });
  const [input, setInput] = useState("");
  const [shake, setShake] = useState(false);
  const [checking, setChecking] = useState(false);

  // Re-verify the stored code once per load; clear it if the server rejects it.
  useEffect(() => {
    if (GATE_OPEN_IN_DEV) return;
    if (!authed) return;
    let stored = null;
    try { stored = localStorage.getItem("mlb_auth"); } catch { /* ignore */ }
    if (!stored) return;
    verifyStoredCode(stored).then((ok) => {
      if (!ok) {
        try { localStorage.removeItem("mlb_auth"); } catch { /* ignore */ }
        setAuthed(false);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (authed) return children;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (checking) return;
    const code = input.trim().toLowerCase();
    setChecking(true);
    const ok = code && (await submitAccessCode(code));
    setChecking(false);
    if (ok) {
      try { localStorage.setItem("mlb_auth", code); } catch { /* ignore */ }
      setAuthed(true);
    } else {
      setShake(true);
      setInput("");
      setTimeout(() => setShake(false), 600);
    }
  };

  return (
    <div style={{
      minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
      background: "radial-gradient(ellipse at 50% 30%, #0a1628 0%, #060d1a 100%)",
      fontFamily: "'Inter', system-ui, sans-serif",
    }}>
      {/* subtle grid overlay */}
      <div style={{
        position: "fixed", inset: 0, pointerEvents: "none",
        backgroundImage: "linear-gradient(rgba(74,158,255,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(74,158,255,0.03) 1px, transparent 1px)",
        backgroundSize: "40px 40px",
      }} />

      <div style={{
        position: "relative", zIndex: 1,
        background: "rgba(10,22,48,0.85)", backdropFilter: "blur(20px)",
        border: "1px solid rgba(74,158,255,0.15)", borderRadius: 16,
        padding: "48px 40px", width: "100%", maxWidth: 380,
        boxShadow: "0 32px 80px rgba(0,0,0,0.6), 0 0 0 1px rgba(74,158,255,0.08)",
        animation: shake ? "shake 0.5s ease" : "none",
      }}>
        {/* Logo / brand */}
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>⚾</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: "#e8edf5", letterSpacing: -0.5 }}>
            MLB Research Dashboard
          </div>
          <div style={{ fontSize: 12, color: "#4a6080", marginTop: 6, letterSpacing: 0.5 }}>
            2026 SEASON · PRIVATE ACCESS
          </div>
        </div>

        {/* Divider */}
        <div style={{ height: 1, background: "linear-gradient(90deg, transparent, rgba(74,158,255,0.2), transparent)", marginBottom: 28 }} />

        <form onSubmit={handleSubmit}>
          <label style={{ fontSize: 11, fontWeight: 600, color: "#4a9eff", letterSpacing: 1, textTransform: "uppercase", display: "block", marginBottom: 8 }}>
            Access Code
          </label>
          <input
            autoFocus
            type="password"
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="Enter access code"
            style={{
              width: "100%", padding: "12px 14px", fontSize: 14, borderRadius: 8,
              background: "rgba(255,255,255,0.04)", border: "1px solid rgba(74,158,255,0.2)",
              color: "#e8edf5", outline: "none", boxSizing: "border-box", marginBottom: 14,
              transition: "border-color 0.15s",
            }}
            onFocus={e => e.target.style.borderColor = "rgba(74,158,255,0.5)"}
            onBlur={e => e.target.style.borderColor = "rgba(74,158,255,0.2)"}
          />
          <button type="submit" style={{
            width: "100%", padding: "12px 0", fontSize: 13, fontWeight: 700,
            background: "linear-gradient(135deg, #1e40af, #2563eb)",
            border: "1px solid rgba(74,158,255,0.3)", borderRadius: 8,
            color: "#fff", cursor: "pointer", letterSpacing: 0.5,
            boxShadow: "0 4px 16px rgba(37,99,235,0.3)", transition: "all 0.15s",
          }}
            onMouseEnter={e => e.currentTarget.style.background = "linear-gradient(135deg, #1d4ed8, #3b82f6)"}
            onMouseLeave={e => e.currentTarget.style.background = "linear-gradient(135deg, #1e40af, #2563eb)"}
          >
            Enter Dashboard
          </button>
        </form>

        <div style={{ textAlign: "center", marginTop: 24, fontSize: 11, color: "#2a3f5f" }}>
          Private research tool · Not for redistribution
        </div>
      </div>

      <style>{`
        @keyframes shake {
          0%,100% { transform: translateX(0); }
          20%      { transform: translateX(-8px); }
          40%      { transform: translateX(8px); }
          60%      { transform: translateX(-5px); }
          80%      { transform: translateX(5px); }
        }
      `}</style>
    </div>
  );
}
