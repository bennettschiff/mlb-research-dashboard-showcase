import { describe, it, expect } from "vitest";
import { isILStatus, ilShortLabel, parseInjuryDescription } from "./injuries.js";

describe("isILStatus", () => {
  it("flags the injured-list roster codes", () => {
    expect(isILStatus({ code: "D10", description: "Injured 10-Day" })).toBe(true);
    expect(isILStatus({ code: "D60", description: "Injured 60-Day" })).toBe(true);
    expect(isILStatus({ code: "ILF", description: "Injured - Full Season" })).toBe(true);
  });
  it("does not flag active / minors / development statuses", () => {
    expect(isILStatus({ code: "A", description: "Active" })).toBe(false);
    expect(isILStatus({ code: "RM", description: "Reassigned to Minors" })).toBe(false);
    expect(isILStatus({ code: "DEV", description: "Development List" })).toBe(false);
    expect(isILStatus(null)).toBe(false);
  });
});

describe("ilShortLabel", () => {
  it("renders day-length lists from the code", () => {
    expect(ilShortLabel({ code: "D10", description: "Injured 10-Day" })).toBe("10-Day IL");
    expect(ilShortLabel({ code: "D7", description: "Injured 7-Day" })).toBe("7-Day IL");
    expect(ilShortLabel({ code: "ILF", description: "Injured - Full Season" })).toBe("IL — Full Season");
  });
  it("falls back to the description when the code is unknown", () => {
    expect(ilShortLabel({ code: "??", description: "Injured 15-Day" })).toBe("15-Day IL");
  });
});

describe("parseInjuryDescription", () => {
  it("extracts the injury cause after the injured-list clause", () => {
    const desc = "Chicago White Sox placed 1B Munetaka Murakami on the 10-day injured list. Right hamstring strain.";
    expect(parseInjuryDescription(desc)).toEqual({ cause: "Right hamstring strain", retroTo: null });
  });
  it("handles a retroactive clause before the cause", () => {
    const desc = "Team placed P Jane Doe on the 15-day injured list, retroactive to May 28. Left elbow inflammation.";
    expect(parseInjuryDescription(desc)).toEqual({ cause: "Left elbow inflammation", retroTo: "May 28" });
  });
  it("returns nulls when there is no cause sentence", () => {
    expect(parseInjuryDescription("Team placed X on the 10-day injured list.")).toEqual({ cause: null, retroTo: null });
    expect(parseInjuryDescription("")).toEqual({ cause: null, retroTo: null });
  });
});
