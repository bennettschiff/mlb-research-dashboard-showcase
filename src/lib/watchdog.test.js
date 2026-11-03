import { describe, it, expect } from "vitest";
import { PINGERS, summarize, evaluatePing } from "./watchdog.js";

const NOW = new Date("2026-08-28T16:10:00Z");
const gh = PINGERS.find((p) => p.source === "github_actions");
const vc = PINGERS.find((p) => p.source === "vercel_cron");

describe("evaluatePing", () => {
  it("is OK on a recent clean ping", () => {
    const r = evaluatePing(gh, { pinged_at: "2026-08-28T15:30:00Z", status: "OK" }, NOW);
    expect(r.status).toBe("OK");
    expect(r.ageH).toBe(0.7);
  });

  // The whole point: a watchdog hosted inside GitHub Actions goes quiet in the
  // same outage it is supposed to report, so its SILENCE has to be the alarm.
  it("fires when the watchdog itself stopped running", () => {
    const r = evaluatePing(gh, { pinged_at: "2026-08-27T06:00:00Z", status: "OK" }, NOW);
    expect(r.status).toBe("STALE");
    expect(r.detail).toMatch(/silent for 34\.2h/);
    expect(r.detail).toMatch(/scheduler itself is not running/);
  });

  it("fires when the ledger is empty", () => {
    expect(evaluatePing(gh, null, NOW).status).toBe("STALE");
  });

  it("holds the independent pinger to a much tighter budget", () => {
    const twoHoursAgo = { pinged_at: "2026-08-28T14:10:00Z", status: "OK" };
    expect(evaluatePing(gh, twoHoursAgo, NOW).status).toBe("OK");
    expect(evaluatePing(vc, twoHoursAgo, NOW).status).toBe("OK");
    const fourHoursAgo = { pinged_at: "2026-08-28T12:10:00Z", status: "OK" };
    expect(evaluatePing(gh, fourHoursAgo, NOW).status).toBe("OK");
    expect(evaluatePing(vc, fourHoursAgo, NOW).status).toBe("STALE");
  });

  it("surfaces what a fresh-but-tripped ping found", () => {
    const r = evaluatePing(gh, {
      pinged_at: "2026-08-28T15:30:00Z",
      status: "TRIPPED",
      detail: { overdue: [{ name: "Player-day panel (daily)", lateMinutes: 310 }] },
    }, NOW);
    expect(r.status).toBe("STALE");
    expect(r.detail).toBe("1 cron(s) not delivered: Player-day panel (daily) (5.2h late)");
  });

  // The 2026-08-31 banner, pinned. The github_actions pinger checks twice a
  // day, so its verdict was asserted in the present tense for sixteen hours:
  // "4 cron(s) not delivered" was stamped at 15:07Z and every one of the four
  // had run by 19:00Z, while the dashboard still read "Pipeline down" at
  // 4:26 PM ET. An overdue finding is evidence about a moment, and a late
  // delivery repairs itself, so past the confidence window it stops being
  // grounds for a red banner.
  it("stops claiming the pipeline is down once an overdue finding is stale", () => {
    const at2026 = new Date("2026-08-31T20:26:00Z");
    const r = evaluatePing(gh, {
      pinged_at: "2026-08-31T15:07:00Z",
      status: "TRIPPED",
      detail: { overdue: [{ name: "Lab analyst (daily)", lateMinutes: 412 }] },
    }, at2026);
    expect(r.status).toBe("GAP");                       // visible, not "Pipeline down"
    expect(r.detail).toMatch(/not re-verified since/);
  });

  // ...but a DISABLED workflow never starts itself, so age must not soften it.
  // lab-analyst.yml sat disabled 2026-07-25 → 08-10 precisely because nothing
  // kept saying so.
  it("keeps full severity on a stale finding that cannot self-heal", () => {
    const at2026 = new Date("2026-08-31T20:26:00Z");
    const r = evaluatePing(gh, {
      pinged_at: "2026-08-31T15:07:00Z",
      status: "TRIPPED",
      detail: {
        disabled: [{ name: "Lab analyst (daily)" }],
        overdue: [{ name: "Uptime check", lateMinutes: 187 }],
      },
    }, at2026);
    expect(r.status).toBe("STALE");
    expect(r.detail).toMatch(/DISABLED/);
  });
});

describe("summarize", () => {
  it("leads with disabled workflows, which can never self-heal", () => {
    const s = summarize({
      disabled: [{ name: "Lab analyst (daily)" }],
      overdue: [{ name: "A", lateMinutes: 60 }],
    });
    expect(s).toMatch(/^1 workflow\(s\) DISABLED: Lab analyst \(daily\)/);
    expect(s).toMatch(/1 cron\(s\) not delivered/);
  });

  it("truncates a long list rather than writing a wall of text into the banner", () => {
    const overdue = ["a", "b", "c", "d", "e"].map((n) => ({ name: n, lateMinutes: 300 }));
    expect(summarize({ overdue })).toMatch(/a \(5\.0h late\), b \(5\.0h late\), c \(5\.0h late\) \+2 more/);
  });

  it("never returns an empty string", () => {
    expect(summarize({})).toBe("tripped with no detail recorded");
    expect(summarize(null)).toBe("tripped with no detail recorded");
  });

  it("reports stale data sources found by the independent pinger", () => {
    expect(summarize({ stale: [{ label: "player_day_panel" }] }))
      .toBe("1 source(s) stale: player_day_panel");
  });
});
