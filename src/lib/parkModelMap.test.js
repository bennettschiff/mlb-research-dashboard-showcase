import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { PARK_MODEL_BY_MARKET, parkWeatherMult } from './weather.js'

// PARK_MODEL_BY_MARKET used to be two inline literals in App.jsx that drifted
// apart: the panel had `hrr` but not `rbi`, the pick-writing scan had `rbi` but
// not `hrr`. An unmapped market resolves to `undefined`, matches no branch in
// parkWeatherMult, and silently returns exactly 1.0 — so HRR picks got NO park
// or weather adjustment for as long as that scan has existed (162/162 saved HRR
// picks over 30 days had parkMult === 1.0 while every other batter market varied).
//
// Nothing failed, nothing was null, and the value was a perfectly plausible 1.0.
// These tests are what make that class of drift loud.

const SRC = (p) => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), p), 'utf8')
// The two call sites: the pick-writing scan (App.jsx) and the batter detail
// panel (moved to components/BatterPanel.jsx 2026-10-06).
const CALL_SITES = { 'App.jsx': SRC('../App.jsx'), 'BatterPanel.jsx': SRC('../components/BatterPanel.jsx') }

// Batter markets whose scores are park/weather sensitive. `sb` is deliberately
// excluded: park and wind don't move stolen bases, so its 1.0 is correct.
const PARK_SENSITIVE = ['hits', 'hr', 'hrr', 'rbi', 'tb']

const PARK = { pf: { H: 1.05, HR_L: 1.20, HR_R: 1.15, '2B': 1.08, '3B': 1.10 } }

describe('PARK_MODEL_BY_MARKET', () => {
  it('maps every park-sensitive batter market', () => {
    const missing = PARK_SENSITIVE.filter(m => !PARK_MODEL_BY_MARKET[m])
    expect(missing, `unmapped markets silently get parkMult 1.0: ${JSON.stringify(missing)}`).toEqual([])
  })

  it('every park-sensitive market actually moves parkWeatherMult off 1.0', () => {
    // The real regression test: a mapping that exists but names a model
    // parkWeatherMult has no branch for is just as dead as a missing key.
    const inert = PARK_SENSITIVE.filter(m => parkWeatherMult(PARK, null, 'R', PARK_MODEL_BY_MARKET[m]) === 1.0)
    expect(inert, `these markets map to a model parkWeatherMult ignores: ${JSON.stringify(inert)}`).toEqual([])
  })

  it('sb stays neutral — park and wind do not affect stolen bases', () => {
    expect(parkWeatherMult(PARK, null, 'R', PARK_MODEL_BY_MARKET.sb)).toBe(1.0)
  })

  it.each(Object.keys(CALL_SITES))('%s declares no competing inline park-model map', (file) => {
    // Both call sites must read the shared constant. A re-inlined literal is
    // exactly how the two copies drifted the first time.
    const src = CALL_SITES[file]
    const inlined = src.match(/(?:modelMap|modelKeyMap)\s*=\s*\{[^}]*["']?HR["']?/g) || []
    expect(inlined, `${file} re-inlined a park-model map instead of importing PARK_MODEL_BY_MARKET`).toEqual([])
    expect(src).toContain('PARK_MODEL_BY_MARKET')
  })
})
