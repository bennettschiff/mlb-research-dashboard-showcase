import { describe, it, expect } from "vitest";
import {
  parseCron, prevFire, lastDue, periodMinutes, graceMinutes,
  evaluateWorkflow, extractSchedule,
} from "./cronSchedule.js";

// Fixed clock: Fri 2026-08-28 16:10 UTC — the moment the player_day_panel
// banner appeared, with that day's 13:00 UTC run never delivered.
const NOW = new Date("2026-08-28T16:10:00Z");

describe("parseCron", () => {
  it("expands lists, ranges and steps", () => {
    const c = parseCron("*/30 16-23,0-3 * * *");
    expect([...c.min].sort((a, b) => a - b)).toEqual([0, 30]);
    expect(c.hour.has(16)).toBe(true);
    expect(c.hour.has(3)).toBe(true);
    expect(c.hour.has(10)).toBe(false);
  });

  it("treats day-of-week 7 as Sunday", () => {
    expect(parseCron("0 0 * * 7").dow.has(0)).toBe(true);
  });

  it("throws rather than silently matching nothing", () => {
    expect(() => parseCron("0 0 * *")).toThrow(/5 fields/);
    expect(() => parseCron("0 99 * * *")).toThrow(/out-of-range/);
    expect(() => parseCron("0 0 * * MON")).toThrow(/unsupported/);
  });
});

describe("prevFire", () => {
  it("finds the most recent fire of a daily cron", () => {
    // player-day-panel: 13:00 UTC daily → today at 13:00.
    expect(prevFire("0 13 * * *", NOW).toISOString()).toBe("2026-08-28T13:00:00.000Z");
  });

  it("rolls to the previous day when today's fire has not arrived", () => {
    // closing-odds at 22:45 UTC has not fired yet today.
    expect(prevFire("45 22 * * *", NOW).toISOString()).toBe("2026-08-27T22:45:00.000Z");
  });

  it("respects day-of-week restrictions", () => {
    // Monday-only cron, evaluated on a Friday → the preceding Monday.
    expect(prevFire("0 14 * * 1", NOW).toISOString()).toBe("2026-08-24T14:00:00.000Z");
  });

  it("reaches back far enough for a monthly cron", () => {
    // contracts-refresh: 13:00 UTC on the 1st.
    expect(prevFire("0 13 1 * *", NOW).toISOString()).toBe("2026-08-01T13:00:00.000Z");
  });

  it("ORs day-of-month with day-of-week when both are restricted", () => {
    // The 1st OR any Monday — 08-24 is a Monday and is the nearer match.
    expect(prevFire("0 12 1 * 1", NOW).toISOString()).toBe("2026-08-24T12:00:00.000Z");
  });
});

describe("period and grace", () => {
  it("measures a half-hourly schedule inside its active window", () => {
    const at2010 = new Date("2026-08-28T20:10:00Z");
    expect(periodMinutes(["*/30 16-23,0-3 * * *"], at2010)).toBe(30);
  });

  // progressive-close only runs 16:00-03:30 UTC, so the fire before 16:00 is
  // 03:30 — a 12.5h gap that is the schedule working as written. Measuring the
  // real gap rather than assuming the step interval is what keeps the watchdog
  // from screaming every morning at a window-limited cron.
  it("measures the real gap across a schedule's own dead window", () => {
    expect(periodMinutes(["*/30 16-23,0-3 * * *"], NOW)).toBe(750);
  });

  it("measures a daily schedule", () => {
    expect(periodMinutes(["0 13 * * *"], NOW)).toBe(1440);
  });

  it("takes the tightest fire across multiple cron lines", () => {
    // daily-picks fires at 16:30 and 22:00 UTC; at 16:10 the latest is 22:00 prior day.
    expect(lastDue(["30 16 * * *", "0 22 * * *"], NOW).toISOString())
      .toBe("2026-08-27T22:00:00.000Z");
  });

  // Grace is floored at GitHub's own delivery lag for EVERY workflow, however
  // often it runs. Scaling it by period was the old model and it made the
  // banner fire on healthy days — a half-hourly job is subject to the same ~4h
  // delivery delay as a daily one, so its period tells you nothing about when
  // to worry. A slow cron still earns a quarter-period on top.
  it("floors grace at GitHub's delivery lag regardless of period", () => {
    const at2010 = new Date("2026-08-28T20:10:00Z");
    expect(graceMinutes(["*/30 16-23,0-3 * * *"], at2010)).toBe(360);  // not 7 min, not 90
    expect(graceMinutes(["0 13 * * *"], NOW)).toBe(360);               // daily: the floor
    expect(graceMinutes(["0 14 * * 1"], NOW)).toBe(1440);              // weekly: capped at a day
  });
});

describe("evaluateWorkflow", () => {
  const run = (over) => evaluateWorkflow({ name: "w", now: NOW, ...over });

  // The failure this whole file exists for: the 13:00 UTC panel run was never
  // delivered, and the newest run belongs to yesterday's fire.
  it("flags a dropped delivery", () => {
    const at1940 = new Date("2026-08-28T19:40:00Z");
    const r = evaluateWorkflow({
      name: "Player-day panel (daily)", crons: ["0 13 * * *"],
      now: at1940, lastRunAt: "2026-08-27T22:52:02Z",
    });
    expect(r.status).toBe("OVERDUE");
    expect(r.lateMinutes).toBe(400);
    expect(r.detail).toMatch(/6\.7h late/);
  });

  // The 2026-08-31 false alarm, pinned. The dashboard read "Pipeline down — 4
  // cron(s) not delivered" all afternoon; every one of the four ran within the
  // hour, because the old period-scaled grace put the line BELOW GitHub's
  // routine delivery lag. Uptime check was the tightest: 3.1h late against 3.0h
  // of grace, i.e. six minutes of jitter away from a red banner.
  it("does not alarm on GitHub's routine delivery lag", () => {
    const at1507 = new Date("2026-08-31T15:07:00Z");
    const uptime = evaluateWorkflow({
      name: "Uptime check", crons: ["0 0,12 * * *"],
      now: at1507, lastRunAt: "2026-08-31T04:57:00Z",
    });
    expect(uptime.status).toBe("OK");

    const backup = evaluateWorkflow({
      name: "Nightly Supabase → Drive backup", crons: ["30 9 * * *"],
      now: at1507, lastRunAt: "2026-08-30T14:29:00Z",
    });
    expect(backup.status).toBe("OK");   // 5.6h late — and it ran at 17:11Z
  });

  it("accepts a run that satisfied the latest fire", () => {
    expect(run({ crons: ["0 13 * * *"], lastRunAt: "2026-08-28T13:56:19Z" }).status).toBe("OK");
  });

  // A late-but-delivered run is the normal state of this account's Actions and
  // must not alarm on the hour, or the banner gets ignored — the exact rot being
  // fixed. A daily job gets 4h before it counts as dropped.
  it("stays quiet inside the grace window", () => {
    const r = run({ crons: ["0 13 * * *"], lastRunAt: "2026-08-27T22:52:02Z" });
    expect(r.status).toBe("OK");
    expect(r.lateMinutes).toBe(190);
  });

  it("counts a manual dispatch as the work having happened", () => {
    const at1810 = new Date("2026-08-28T18:10:00Z");
    const r = evaluateWorkflow({ name: "w", crons: ["0 13 * * *"], now: at1810, lastRunAt: "2026-08-28T14:02:00Z" });
    expect(r.status).toBe("OK");
  });

  // lab-analyst.yml sat disabled_manually 2026-07-25 → 08-10 with no signal.
  it("flags a disabled workflow, whose cron can never fire", () => {
    const r = run({ crons: ["0 13 * * *"], state: "disabled_manually", lastRunAt: "2026-08-28T13:00:00Z" });
    expect(r.status).toBe("DISABLED");
  });

  it("flags a scheduled workflow that has never run", () => {
    const at1940 = new Date("2026-08-28T19:40:00Z");
    const r = evaluateWorkflow({ name: "w", crons: ["0 13 * * *"], now: at1940, lastRunAt: null });
    expect(r.status).toBe("OVERDUE");
    expect(r.detail).toBe("has never run");
  });

  it("ignores workflows with no cron", () => {
    expect(run({ crons: [], lastRunAt: null }).status).toBe("OK");
  });
});

describe("extractSchedule", () => {
  const yaml = [
    "name: Player-day panel (daily)",
    "# - cron: '0 0 * * *'   <- prose in a comment, not a schedule",
    "on:",
    "  schedule:",
    "    - cron: '0 13 * * *'   # 13:00 UTC = 9:00 AM ET",
    "  workflow_dispatch:",
    "jobs:",
    "  panel:",
    "    steps:",
    "      - name: Grade realized outcomes",
  ].join("\n");

  it("reads the workflow name, not a step name", () => {
    expect(extractSchedule(yaml).name).toBe("Player-day panel (daily)");
  });

  it("reads cron lines and strips trailing comments", () => {
    expect(extractSchedule(yaml).crons).toEqual(["0 13 * * *"]);
  });

  it("returns no crons for a dispatch-only workflow", () => {
    expect(extractSchedule("name: Manual\non:\n  workflow_dispatch:\n").crons).toEqual([]);
  });
});
