// Per-market model versions. Every saved pick is tagged `<market>@<version>` so
// the calibration monitor and backtests can tell "the league moved" apart from
// "we changed the model". Bump a market's entry in the same commit as any
// behavioral change to its model.
//
// Public build: one placeholder version for every market. The production
// version history (and the reasoning behind each change) is private.
const PUBLIC = "public-1";

export const MODEL_VERSIONS = {
  hits: PUBLIC, hits15: PUBLIC, hr: PUBLIC, hrr: PUBLIC, tb: PUBLIC, sb: PUBLIC, rbi: PUBLIC,
  ks: PUBLIC, outs: PUBLIC, hits_allowed: PUBLIC, walks: PUBLIC, er: PUBLIC,
  nrfi: PUBLIC, ml: PUBLIC, rl: PUBLIC, ou: PUBLIC,
};

export function tagPick(propType) {
  const v = MODEL_VERSIONS[propType];
  return v ? `${propType}@${v}` : "untagged";
}
