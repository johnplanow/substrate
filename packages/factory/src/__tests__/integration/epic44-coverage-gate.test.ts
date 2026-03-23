/**
 * Epic 44 coverage gate — smoke tests for all public API exports (Story 44-10 AC7).
 *
 * This file validates that all Epic 44 public API exports are present and functional.
 * It does NOT duplicate logic from unit tests — it verifies the public API contract only.
 *
 * Expected per-story test counts and running total:
 * // 44-1: ~10, 44-2: ~8, 44-3: ~6, 44-4: ~8, 44-5: ~13, 44-6: ~7, 44-7: ~8, 44-8: ~6,
 * // 44-9: ~16, 44-10: ~33 → Total ≥ 115 >> gate of 60
 */

import { describe, it, expect } from 'vitest'

// Import all Epic 44 public API exports.
// factorySchema is not re-exported from the barrel, so import from its direct path.
import {
  ScenarioStore,
  computeSatisfactionScore,
  FactoryConfigSchema,
  loadFactoryConfig,
  registerFactoryCommand,
} from '@substrate-ai/factory'
import { factorySchema } from '../../persistence/factory-schema.js'

// ---------------------------------------------------------------------------
// Epic 44 public API smoke tests
// ---------------------------------------------------------------------------

describe('Epic 44 public API gate (AC7)', () => {
  it('gate-1: ScenarioStore is exported and constructible (story 44-1)', () => {
    expect(typeof ScenarioStore).not.toBe('undefined')
    const store = new ScenarioStore()
    expect(store).toBeDefined()
    expect(typeof store.discover).toBe('function')
    expect(typeof store.verify).toBe('function')
    expect(typeof store.verifyIntegrity).toBe('function')
  })

  it('gate-2: computeSatisfactionScore is exported as a function (story 44-5)', () => {
    expect(typeof computeSatisfactionScore).toBe('function')
  })

  it('gate-3: computeSatisfactionScore computes correct score (story 44-5)', () => {
    const result = {
      scenarios: [],
      summary: { total: 3, passed: 2, failed: 1 },
      durationMs: 150,
    }
    const score = computeSatisfactionScore(result)
    expect(score.score).toBeCloseTo(2 / 3, 5)
    expect(score.passes).toBe(false)
    expect(score.threshold).toBe(0.8)
  })

  it('gate-4: factorySchema is exported as a function (story 44-6)', () => {
    expect(typeof factorySchema).toBe('function')
  })

  it('gate-5: FactoryConfigSchema.parse({}) returns defaults without throwing (story 44-9)', () => {
    const config = FactoryConfigSchema.parse({})
    expect(config).toBeDefined()
    expect(config.scenario_dir).toBe('.substrate/scenarios/')
    expect(config.satisfaction_threshold).toBe(0.8)
  })

  it('gate-6: loadFactoryConfig is exported as a function (story 44-9)', () => {
    expect(typeof loadFactoryConfig).toBe('function')
  })

  it('gate-7: registerFactoryCommand is exported as a function (story 44-8)', () => {
    expect(typeof registerFactoryCommand).toBe('function')
  })
})
