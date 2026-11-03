import { describe, it, expect } from "vitest";
import { parseFreshnessCsv, unhealthyRows } from "./PipelineHealth.jsx";

const HEADER = "sport,source,cadence,last_data_date,last_write_utc,age_h,status,detail";

describe("parseFreshnessCsv", () => {
  it("keeps a quoted detail containing commas intact", () => {
    // This is the whole reason for a real parser: `detail` is the field a reader
    // needs, and it routinely carries a comma ("missing 2/13 slates, newest …").
    const csv = [
      HEADER,
      'mlb,golden_snapshots,"daily, first pitch",2026-08-17,2026-08-17T16:00:00Z,26.3,STALE,"missing 1/13 slates, newest 2026-08-18"',
    ].join("\n");
    const [row] = parseFreshnessCsv(csv);
    expect(row.cadence).toBe("daily, first pitch");
    expect(row.detail).toBe("missing 1/13 slates, newest 2026-08-18");
    expect(row.status).toBe("STALE");
  });

  it("unescapes doubled quotes", () => {
    const csv = [HEADER, 'mlb,odds,daily,,,,ERROR,"said ""nope"""'].join("\n");
    expect(parseFreshnessCsv(csv)[0].detail).toBe('said "nope"');
  });

  it("returns [] for empty or header-only input", () => {
    expect(parseFreshnessCsv("")).toEqual([]);
    expect(parseFreshnessCsv(HEADER)).toEqual([]);
  });
});

describe("unhealthyRows", () => {
  const row = (source, status) => ({ source, status, cadence: "daily", detail: "" });

  it("drops healthy rows — OK and IDLE never surface", () => {
    // An off-day reads IDLE by design (api/_freshness.js measures against the
    // league schedule); showing it would cry wolf every off-day.
    expect(unhealthyRows([row("picks", "OK"), row("odds", "IDLE")])).toEqual([]);
  });

  it("ranks pipe-is-down above a historical hole", () => {
    const out = unhealthyRows([
      row("odds", "GAP"), row("picks", "STALE"), row("panel", "UNKNOWN"), row("scan", "ERROR"),
    ]);
    expect(out.map((r) => r.source)).toEqual(["picks", "scan", "odds", "panel"]);
  });

  it("tolerates a null/undefined row set", () => {
    expect(unhealthyRows(null)).toEqual([]);
  });
});
