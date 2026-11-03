import { describe, it, expect } from "vitest";
import { CRON_OWNED_PROP_TYPES, EXCLUDE_CRON_OWNED, savedPicksParams } from "./pickQueries.js";

describe("pickQueries", () => {
  it("treats nrfi as cron-owned", () => {
    expect(CRON_OWNED_PROP_TYPES).toContain("nrfi");
  });

  it("builds a PostgREST filter that excludes every cron-owned prop_type", () => {
    for (const t of CRON_OWNED_PROP_TYPES) expect(EXCLUDE_CRON_OWNED).toContain(t);
    expect(EXCLUDE_CRON_OWNED.startsWith("prop_type=")).toBe(true);
  });

  it("scopes the existence check to the date AND excludes cron-owned rows", () => {
    const p = savedPicksParams("2026-07-22", { limit: 1 });
    expect(p).toContain("pick_date=eq.2026-07-22");
    expect(p).toContain(EXCLUDE_CRON_OWNED);
    expect(p).toContain("limit=1");
  });

  it("omits limit when not asked for, so callers can count the full day", () => {
    expect(savedPicksParams("2026-07-22")).not.toContain("limit");
  });

  // The regression itself: a day whose only row is the nrfi cron's must not
  // read as "already saved". 2026-07-19/20/22 each lost a full slate this way.
  it("a day holding only cron-owned rows is NOT reported as saved", () => {
    const dayRows = [{ prop_type: "nrfi", pick_date: "2026-07-22" }];
    const matches = dayRows.filter(
      (r) => r.pick_date === "2026-07-22" && !CRON_OWNED_PROP_TYPES.includes(r.prop_type)
    );
    expect(matches).toHaveLength(0);
  });
});
