import { describe, it, expect } from "vitest";
import { computePlayerFlags } from "./parks.js";

const home = (birthCity, birthState, parkAbbrev) =>
  !!computePlayerFlags({ bio: { birthCity, birthState }, parkAbbrev, today: "2026-07-01" }).hometown;

describe("computePlayerFlags — hometown", () => {
  it("matches the park city and its metro", () => {
    expect(home("Tampa", "FL", "TB")).toBe(true);
    expect(home("St. Petersburg", "FL", "TB")).toBe(true);
    expect(home("Anaheim", "CA", "LAD")).toBe(true);
    expect(home("Brooklyn", "NY", "NYY")).toBe(true);
    expect(home("Brooklyn Park", "MN", "MIN")).toBe(true);
    expect(home("Saint Louis", "MO", "STL")).toBe(true);
    expect(home("Toronto", "ON", "TOR")).toBe(true);
    expect(home("Sacramento", "CA", "ATH")).toBe(true);
  });

  // Every case below was a live false positive in the 2026 season (post-mortem, 2026-09-28).
  it("rejects same-name cities in another state", () => {
    expect(home("Brooklyn", "NY", "MIN")).toBe(false);
    expect(home("Brooklyn Park", "MN", "NYY")).toBe(false);
    expect(home("Richmond", "VA", "SF")).toBe(false);
    expect(home("Glendale", "AZ", "LAD")).toBe(false);
    expect(home("Brandon", "MS", "TB")).toBe(false);
    expect(home("Carrollton", "GA", "TEX")).toBe(false);
    expect(home("Bloomington", "IN", "MIN")).toBe(false);
  });

  it("rejects substring matches", () => {
    expect(home("Evans", "GA", "CWS")).toBe(false);   // not Evanston
    expect(home("Chester", "SC", "STL")).toBe(false); // not Chesterfield
    expect(home("Layton", "UT", "STL")).toBe(false);  // not Clayton
  });
});
