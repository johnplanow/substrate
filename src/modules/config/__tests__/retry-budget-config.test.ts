/**
 * Unit tests for retry_budget field in SubstrateConfigSchema — Story 53-4.
 *
 * Covers AC2 (retry_budget field in SubstrateConfig).
 */

import { describe, it, expect } from 'vitest'
import { SubstrateConfigSchema, PartialSubstrateConfigSchema } from '../config-schema.js'
import { DEFAULT_CONFIG } from '../defaults.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid config derived from the built-in defaults. */
function makeMinimalValidConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...DEFAULT_CONFIG, ...overrides }
}

// ---------------------------------------------------------------------------
// SubstrateConfigSchema: retry_budget (AC2)
// ---------------------------------------------------------------------------

describe('SubstrateConfigSchema: retry_budget field (Story 53-4)', () => {
  it('AC2: accepts config with retry_budget: 3', () => {
    const cfg = makeMinimalValidConfig({ retry_budget: 3 })
    const result = SubstrateConfigSchema.safeParse(cfg)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.retry_budget).toBe(3)
    }
  })

  it('AC2: accepts config with retry_budget: 1 (minimum positive integer)', () => {
    const cfg = makeMinimalValidConfig({ retry_budget: 1 })
    const result = SubstrateConfigSchema.safeParse(cfg)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.retry_budget).toBe(1)
    }
  })

  it('AC2: retry_budget is undefined when absent (field is optional)', () => {
    const cfg = makeMinimalValidConfig()
    const result = SubstrateConfigSchema.safeParse(cfg)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.retry_budget).toBeUndefined()
    }
  })

  it('AC2: rejects retry_budget: 0 (must be positive)', () => {
    const cfg = makeMinimalValidConfig({ retry_budget: 0 })
    const result = SubstrateConfigSchema.safeParse(cfg)
    expect(result.success).toBe(false)
  })

  it('AC2: rejects negative retry_budget', () => {
    const cfg = makeMinimalValidConfig({ retry_budget: -1 })
    const result = SubstrateConfigSchema.safeParse(cfg)
    expect(result.success).toBe(false)
  })

  it('AC2: rejects non-integer retry_budget', () => {
    const cfg = makeMinimalValidConfig({ retry_budget: 2.5 })
    const result = SubstrateConfigSchema.safeParse(cfg)
    expect(result.success).toBe(false)
  })

  it('AC2: default config still passes with retry_budget absent', () => {
    const result = SubstrateConfigSchema.safeParse(DEFAULT_CONFIG)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.retry_budget).toBeUndefined()
    }
  })
})

// ---------------------------------------------------------------------------
// PartialSubstrateConfigSchema: retry_budget (AC2)
// ---------------------------------------------------------------------------

describe('PartialSubstrateConfigSchema: retry_budget field (Story 53-4)', () => {
  it('AC2: accepts partial config with retry_budget: 5', () => {
    const result = PartialSubstrateConfigSchema.safeParse({ retry_budget: 5 })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.retry_budget).toBe(5)
    }
  })

  it('AC2: accepts partial config without retry_budget', () => {
    const result = PartialSubstrateConfigSchema.safeParse({})
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.retry_budget).toBeUndefined()
    }
  })

  it('AC2: rejects retry_budget: 0 in partial config (must be positive)', () => {
    const result = PartialSubstrateConfigSchema.safeParse({ retry_budget: 0 })
    expect(result.success).toBe(false)
  })
})
