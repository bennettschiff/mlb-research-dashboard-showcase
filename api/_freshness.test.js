import { describe, it, expect } from "vitest";
import { evaluate, SOURCES, DELIVERY_LAG_H } from "./_freshness.js";

// Fixed clock: 2026-07-16, 12:00 ET (16:00 UTC).
const NOW = new Date("2026-07-16T16:00:00Z");
const TODAY = "2026-07-16";
const HOUR_ET = 12;

const gated = (over = {}) => ({
  sport: "mlb", label: "picks", table: "t", dateCol: "d", tsCol: "ts",
  gated: "mlb", expectedByET: 13, cadence: "daily", ...over,
});
const ungated = (over = {}) => ({
  sport: "mlb", label: "adv", table: "t", dateCol: null, tsCol: "ts",
  gated: null, maxAgeH: 30, cadence: "daily", ...over,
});

const run = (src, slates, present, lastTs = "2026-07-16T15:00:00Z") =>
  evaluate(src, new Set(slates), new Set(present), lastTs, NOW, TODAY, HOUR_ET);

describe("freshness — slate-gated", () => {
  it("is OK when every slate landed", () => {
    const days = ["2026-07-14", "2026-07-15", "2026-07-16"];
    expect(run(gated(), days, days).status).toBe("OK");
  });

  // The bug this feed exists to avoid: the All-Star break wrote nothing for
  // three days and that is correct behavior, not an outage.
  it("is IDLE, not STALE, when the league played no games at all", () => {
    const r = run(gated(), [], []);
    expect(r.status).toBe("IDLE");
  });

  it("does not blame a source for a day the league didn't play", () => {
    // Games 7/12 and 7/16 only (ASB between). Source has both → healthy.
    const r = run(gated(), ["2026-07-12", "2026-07-16"], ["2026-07-12", "2026-07-16"]);
    expect(r.status).toBe("OK");
  });

  it("fires STALE when the newest slate never landed", () => {
    const r = run(gated({ expectedByET: 10 }), // already past due at 12:00 ET
      ["2026-07-15", "2026-07-16"], ["2026-07-15"]);
    expect(r.status).toBe("STALE");
    expect(r.detail).toContain("2026-07-16");
  });

  it("fires GAP when older slates are missing but the pipe is live", () => {
    const r = run(gated(),
      ["2026-07-14", "2026-07-15", "2026-07-16"],
      ["2026-07-14", "2026-07-16"]);
    expect(r.status).toBe("GAP");
    expect(r.detail).toContain("2026-07-15");
  });

  it("holds today PENDING (OK) until the run is actually due", () => {
    // 12:00 ET, run due 13:00 ET → today's absence is not yet a failure.
    const r = run(gated({ expectedByET: 13 }),
      ["2026-07-15", "2026-07-16"], ["2026-07-15"]);
    expect(r.status).toBe("OK");
    expect(r.detail).toContain("due by 13:00 ET");
  });

  it("stops excusing today once the due hour passes", () => {
    const r = run(gated({ expectedByET: 11 }),
      ["2026-07-15", "2026-07-16"], ["2026-07-15"]);
    expect(r.status).toBe("STALE");
  });

  // daily_odds keeps a rolling week; slates older than that are gone by design
  // and must not read as permanent data loss.
  it("ignores slates outside a pruned table's retention window", () => {
    const r = run(gated({ retentionDays: 7 }),
      ["2026-07-04", "2026-07-15", "2026-07-16"],
      ["2026-07-15", "2026-07-16"]);
    expect(r.status).toBe("OK");
    expect(r.detail).not.toContain("2026-07-04");
  });
});

// The 2026-08-28/29/30 regression: the tripwire's afternoon slot fired STALE on
// pick_signals and golden_snapshots three days running because their deadline was
// the producing job's CRON hour (13:00 ET) while GitHub had simply not delivered
// daily-picks yet — it landed normally afterwards each time. These lock the rule
// that survived it: the deadline covers the job's last slot plus delivery lag.
describe("freshness — deadlines absorb GitHub's delivery lag", () => {
  const NOON_ISH = 15; // ET hour the afternoon tripwire actually runs at

  it("holds today PENDING at the hour the afternoon tripwire runs", () => {
    const picks = SOURCES.find((s) => s.label === "pick_signals");
    const r = evaluate(picks, new Set(["2026-07-15", "2026-07-16"]),
      new Set(["2026-07-15"]), "2026-07-15T17:00:00Z", NOW, TODAY, NOON_ISH);
    expect(r.status).toBe("OK");
  });

  it("gives every slate-gated source room for the measured lag", () => {
    // Producing job's last slot for the slate, in ET. Tightening any deadline
    // back toward these cron hours reintroduces the false STALE.
    const lastSlotET = {
      picks: 18, pick_signals: 18, scan_blobs: 18, odds: 18,
      golden_snapshots: 18, closing_props: 18, player_day_panel: 9,
    };
    for (const src of SOURCES.filter((s) => s.gated === "mlb")) {
      expect.soft(src.expectedByET,
        `${src.label} is due before its producer can plausibly have run`)
        .toBe(Math.min(23, lastSlotET[src.label] + DELIVERY_LAG_H));
    }
  });

  it("still calls a slate STALE once the real deadline passes", () => {
    const picks = SOURCES.find((s) => s.label === "pick_signals");
    const r = evaluate(picks, new Set(["2026-07-15", "2026-07-16"]),
      new Set(["2026-07-15"]), "2026-07-15T17:00:00Z", NOW, TODAY, 23);
    expect(r.status).toBe("STALE");
  });

  // The trade the widened window makes: a slate that never lands is caught the
  // NEXT morning as a prior-slate GAP rather than same-day. That path has to
  // keep working, or the widening would be a real loss of coverage.
  it("catches a slate that never landed as a GAP the next morning", () => {
    const picks = SOURCES.find((s) => s.label === "pick_signals");
    const r = evaluate(picks, new Set(["2026-07-15", "2026-07-16"]),
      new Set([]), null, NOW, TODAY, 8);
    expect(r.status).toBe("GAP");
    expect(r.detail).toContain("2026-07-15");
  });
});

describe("freshness — ungated", () => {
  it("is OK inside the age budget", () => {
    expect(run(ungated(), [], [], "2026-07-16T13:00:00Z").status).toBe("OK");
  });

  it("fires STALE past the age budget", () => {
    const r = run(ungated({ maxAgeH: 30 }), [], [], "2026-07-14T00:00:00Z");
    expect(r.status).toBe("STALE");
  });

  it("reports an empty table rather than claiming freshness", () => {
    expect(run(ungated(), [], [], null).status).toBe("NO DATA");
  });
});
