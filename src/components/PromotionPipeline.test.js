import { describe, it, expect } from "vitest";
import { parseChangelog } from "./PromotionPipeline.jsx";

// 2026-08-14: the first-ever revert used a different shape than every prior
// changelog entry — scripts/promotion-gate.mjs's revert path puts the event
// in the HEADING ("## DATE — REVERTED `sport.market`") with plain
// "- Removed:" / "- Reason:" bullets below, not a "**REVERTED**" bold bullet
// under a dated section like PROMOTED/SHADOW FAILED use. The original parser
// only recognized the bold-bullet form, so the revert silently vanished from
// the pipeline's History panel. Fixture below is the real entry, shortened.
const FIXTURE = `# Gate changelog

## 2026-08-03 — MLB

- **PROMOTED** \`hr.conf_max = 8.2\` — hr: set conf_max = 8.2
  - Shadow: 11d, 81 picks, +16.13u vs incumbent.
- **SHADOW FAILED** \`hits.conf_max = 9.7\` — hits: set conf_max = 9.7
  - -0.8u over 12d; validated lift did not replicate. Not promoted.

## 2026-08-14 — REVERTED \`mlb.hr\`

- Removed: score_max = 0.081
- Reason: Redundant with the conf_max 8.2 promoted the same day.
- Source proposal: —

## 2026-08-15 — MLB

- **SHADOW FAILED** \`ks.conf_max = 8.9\` — ks: set conf_max = 8.9
  - -3.63u over 12d; validated lift did not replicate. Not promoted.
`;

describe("PromotionPipeline changelog parsing", () => {
  it("surfaces a heading-style REVERTED entry, not just bold-bullet PROMOTED/SHADOW FAILED", () => {
    const entries = parseChangelog(FIXTURE);
    const revert = entries.find((e) => e.date === "2026-08-14");
    expect(revert).toBeTruthy();
    expect(revert.events).toHaveLength(1);
    expect(revert.events[0].status).toBe("REVERTED");
    expect(revert.events[0].title).toContain("mlb.hr");
    expect(revert.events[0].title).toContain("score_max = 0.081");
    expect(revert.events[0].reason).toContain("Redundant with the conf_max 8.2");
  });

  it("still parses bold-bullet PROMOTED and SHADOW FAILED events under a dated section", () => {
    const entries = parseChangelog(FIXTURE);
    const aug3 = entries.find((e) => e.date === "2026-08-03");
    expect(aug3.events).toHaveLength(2);
    expect(aug3.events[0]).toMatchObject({ status: "PROMOTED", title: "hr.conf_max = 8.2 — hr: set conf_max = 8.2" });
    expect(aug3.events[0].reason).toContain("+16.13u");
    expect(aug3.events[1].status).toBe("SHADOW FAILED");
  });

  it("sorts newest-first by date", () => {
    const entries = parseChangelog(FIXTURE);
    expect(entries.map((e) => e.date)).toEqual(["2026-08-15", "2026-08-14", "2026-08-03"]);
  });
});
