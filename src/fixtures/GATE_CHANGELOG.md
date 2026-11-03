# Gate changelog (sample)

Append-only history of live pick-gate changes made by the promotion pipeline:
promotions, shadow slates that failed, and reverts. This public copy ships a
short synthetic sample so the Promotion Pipeline and Sweep Surface views render.
The production changelog is private.

## 2026-08-03 — MLB

- **PROMOTED** `tb.conf_max = 9.0` — tb: cap conf_max = 9.0
  - Shadow: 12d, 180 picks, +6.2u vs incumbent.
- **SHADOW FAILED** `hits.conf_max = 9.5` — hits: set conf_max = 9.5
  - -1.4u over 12d; validated lift did not replicate. Not promoted.

## 2026-08-14 — REVERTED `mlb.tb`

- Removed: conf_max = 9.0
- Reason: live performance after promotion fell below the incumbent for 10 straight days.
