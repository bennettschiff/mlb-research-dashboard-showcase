import { useEffect, useState } from "react";
import { accessCodeHeader } from "../lib/utils.js";

// ── Pipeline health strip ────────────────────────────────────────────────────
//
// Scheduled-job failures used to surface ONLY as GitHub issues. That channel is
// write-only in practice: on 2026-08-18 the 12:30 ET daily-picks run was killed
// by a hung apt mirror inside the Playwright install, its self-alert opened
// issue #34, and the first anyone knew of it was noticing the Golden tab read
// "No board written for this date" — an issue about a *monthly* job failing had
// by then been sitting open and unread for 17 days. The dashboard is the surface
// that actually gets looked at, so the alert belongs here.
//
// The judgment is NOT reimplemented here. api/_freshness.js already measures
// every source against the LEAGUE SCHEDULE rather than the clock (an off-day is
// IDLE, not broken) and against an expectedByET hour (a morning load does not
// report the noon run as missing). This renders that verdict and nothing more.
//
// Silent when healthy. A banner that shows a green "all good" every day is a
// banner you stop reading, which is the exact failure being fixed.

const FRESHNESS_URL = "/api/picks?view=freshness&sport=mlb";
const POLL_MS = 10 * 60 * 1000;

// STALE = the newest expected slate never landed (pipe is down NOW).
// ERROR  = the probe itself failed against that table.
// GAP    = newest landed, older days missing (permanent hole, not urgent).
// UNKNOWN= league schedule unreachable, so the verdict is not trustworthy.
// OK / IDLE are healthy and never shown.
const SEVERITY = { STALE: 2, ERROR: 2, GAP: 1, UNKNOWN: 1 };

const C = {
  down: "#d03131", downBg: "rgba(208,49,49,0.08)", downBd: "rgba(208,49,49,0.28)",
  warn: "#a16207", warnBg: "rgba(161,98,7,0.08)", warnBd: "rgba(161,98,7,0.28)",
  muted: "#74839d",
};

/**
 * Parse the freshness CSV. `detail` legitimately contains commas ("missing 2/13
 * slates, newest 2026-08-18"), so a naive split on "," silently truncates the
 * one field a reader needs — quotes are honoured, including "" escapes.
 */
export function parseFreshnessCsv(text) {
  const lines = String(text || "").trim().split("\n").filter(Boolean);
  if (lines.length < 2) return [];
  const cells = (line) => {
    const out = [];
    let cur = "", inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
        } else cur += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === ",") { out.push(cur); cur = ""; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const header = cells(lines[0]);
  return lines.slice(1).map((line) => {
    const c = cells(line);
    return Object.fromEntries(header.map((h, i) => [h, c[i] ?? ""]));
  });
}

/** Unhealthy rows only, worst first, then alphabetical for a stable order. */
export function unhealthyRows(rows) {
  return (rows || [])
    .filter((r) => SEVERITY[r.status])
    .sort((a, b) =>
      (SEVERITY[b.status] - SEVERITY[a.status]) || a.source.localeCompare(b.source));
}

export default function PipelineHealth() {
  const [rows, setRows] = useState([]);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let dead = false;
    const tick = () => {
      fetch(FRESHNESS_URL, { headers: accessCodeHeader() })
        .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((t) => { if (!dead) setRows(unhealthyRows(parseFreshnessCsv(t))); })
        // A failing probe stays silent. Rendering "could not check health" on
        // every dropped request would train the same blindness as a green bar.
        .catch(() => {});
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => { dead = true; clearInterval(id); };
  }, []);

  if (dismissed || !rows.length) return null;

  const down = rows.some((r) => SEVERITY[r.status] === 2);
  const color = down ? C.down : C.warn;

  return (
    <div style={{
      display: "flex", alignItems: "flex-start", gap: 10, flexWrap: "wrap",
      padding: "8px 16px", fontSize: 11.5,
      background: down ? C.downBg : C.warnBg,
      borderBottom: `1px solid ${down ? C.downBd : C.warnBd}`,
      color,
    }}>
      <span style={{ fontWeight: 700, whiteSpace: "nowrap" }}>
        {down ? "⚠️ Pipeline down" : "⚠️ Pipeline gap"}
      </span>
      <div style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 240 }}>
        {rows.map((r) => (
          <div key={r.source}>
            <span style={{ fontWeight: 700 }}>{r.source}</span>
            <span style={{ color: C.muted }}> · {r.cadence} · </span>
            <span style={{ fontWeight: 600 }}>{r.status}</span>
            <span style={{ color: C.muted }}> — {r.detail}</span>
          </div>
        ))}
      </div>
      <button
        onClick={() => setDismissed(true)}
        title="Hide until the next page load"
        style={{
          marginLeft: "auto", padding: "2px 8px", fontSize: 10, fontWeight: 600,
          borderRadius: 6, cursor: "pointer", color,
          background: "transparent", border: `1px solid ${down ? C.downBd : C.warnBd}`,
        }}
      >
        Dismiss
      </button>
    </div>
  );
}
