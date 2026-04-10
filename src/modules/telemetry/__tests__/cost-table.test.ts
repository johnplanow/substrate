/**
 * Unit tests for cost-table.ts
 *
 * Covers: COST_TABLE structure, resolveModel(), estimateCost()
 */

import { describe, it, expect } from 'vitest'
import { COST_TABLE, resolveModel, estimateCost } from '../cost-table.js'
import type { TokenCounts } from '../types.js'

// ---------------------------------------------------------------------------
// COST_TABLE
// ---------------------------------------------------------------------------

describe('COST_TABLE', () => {
  it('contains all required models', () => {
    const expectedModels = [
      'claude-3-opus-20240229',
      'claude-3-sonnet-20240229',
      'claude-3-haiku-20240307',
      'claude-3-5-sonnet-20241022',
      'claude-3-5-haiku-20241022',
      'gpt-4',
      'gpt-4-turbo',
      'gpt-3.5-turbo',
    ]
    for (const model of expectedModels) {
      expect(COST_TABLE).toHaveProperty(model)
    }
  })

  it('each entry has all four pricing fields', () => {
    for (const [model, pricing] of Object.entries(COST_TABLE)) {
      expect(typeof pricing.inputPerMToken, `${model}.inputPerMToken`).toBe('number')
      expect(typeof pricing.outputPerMToken, `${model}.outputPerMToken`).toBe('number')
      expect(typeof pricing.cacheReadPerMToken, `${model}.cacheReadPerMToken`).toBe('number')
      expect(typeof pricing.cacheCreationPerMToken, `${model}.cacheCreationPerMToken`).toBe(
        'number'
      )
    }
  })

  it('claude-3-opus-20240229 has correct rates', () => {
    const pricing = COST_TABLE['claude-3-opus-20240229']
    expect(pricing.inputPerMToken).toBe(15.0)
    expect(pricing.outputPerMToken).toBe(75.0)
    expect(pricing.cacheReadPerMToken).toBe(1.5)
    expect(pricing.cacheCreationPerMToken).toBe(18.75)
  })

  it('claude-3-5-haiku-20241022 cacheReadPerMToken is 10% of inputPerMToken', () => {
    const pricing = COST_TABLE['claude-3-5-haiku-20241022']
    expect(pricing.cacheReadPerMToken).toBeCloseTo(pricing.inputPerMToken * 0.1, 5)
  })
})

// ---------------------------------------------------------------------------
// resolveModel
// ---------------------------------------------------------------------------

describe('resolveModel', () => {
  it('returns exact key for known model', () => {
    expect(resolveModel('claude-3-5-sonnet-20241022')).toBe('claude-3-5-sonnet-20241022')
  })

  it('returns undefined for unknown model', () => {
    expect(resolveModel('unknown-model-xyz')).toBeUndefined()
  })

  it('matches case-insensitively', () => {
    expect(resolveModel('GPT-4')).toBe('gpt-4')
  })

  it('matches via substring', () => {
    // "claude-3-haiku" substring present in "claude-3-haiku-20240307"
    const resolved = resolveModel('claude-3-haiku-20240307-extra')
    expect(resolved).toBe('claude-3-haiku-20240307')
  })
})

// ---------------------------------------------------------------------------
// estimateCost
// ---------------------------------------------------------------------------

describe('estimateCost', () => {
  const zeroTokens: TokenCounts = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }

  it('returns 0 for unknown model without throwing', () => {
    expect(() => estimateCost('unknown-model', zeroTokens)).not.toThrow()
    expect(estimateCost('unknown-model', zeroTokens)).toBe(0)
  })

  it('returns 0 for zero tokens on known model', () => {
    expect(estimateCost('claude-3-5-sonnet-20241022', zeroTokens)).toBe(0)
  })

  it('computes correct cost for claude-3-5-sonnet-20241022 with input tokens', () => {
    const tokens: TokenCounts = { input: 1_000_000, output: 0, cacheRead: 0, cacheCreation: 0 }
    // 1M input tokens at $3.00/M = $3.00
    expect(estimateCost('claude-3-5-sonnet-20241022', tokens)).toBeCloseTo(3.0, 5)
  })

  it('computes correct cost for output tokens', () => {
    const tokens: TokenCounts = { input: 0, output: 1_000_000, cacheRead: 0, cacheCreation: 0 }
    // 1M output tokens at $15.00/M = $15.00
    expect(estimateCost('claude-3-5-sonnet-20241022', tokens)).toBeCloseTo(15.0, 5)
  })

  it('applies cacheReadPerMToken from table (not 10% of input)', () => {
    const tokens: TokenCounts = { input: 0, output: 0, cacheRead: 1_000_000, cacheCreation: 0 }
    // 1M cache read tokens at $0.30/M = $0.30
    expect(estimateCost('claude-3-5-sonnet-20241022', tokens)).toBeCloseTo(0.3, 5)
  })

  it('applies cacheCreationPerMToken', () => {
    const tokens: TokenCounts = { input: 0, output: 0, cacheRead: 0, cacheCreation: 1_000_000 }
    // 1M cache creation tokens at $3.75/M = $3.75
    expect(estimateCost('claude-3-5-sonnet-20241022', tokens)).toBeCloseTo(3.75, 5)
  })

  it('sums all four cost components', () => {
    const tokens: TokenCounts = {
      input: 1_000_000,
      output: 1_000_000,
      cacheRead: 1_000_000,
      cacheCreation: 1_000_000,
    }
    // 3.00 + 15.00 + 0.30 + 3.75 = 22.05
    expect(estimateCost('claude-3-5-sonnet-20241022', tokens)).toBeCloseTo(22.05, 5)
  })

  it('handles gpt-4 pricing', () => {
    const tokens: TokenCounts = { input: 1_000_000, output: 0, cacheRead: 0, cacheCreation: 0 }
    // 1M input tokens at $30.00/M = $30.00
    expect(estimateCost('gpt-4', tokens)).toBeCloseTo(30.0, 5)
  })

  it('handles partial token counts (e.g. only output)', () => {
    const tokens: TokenCounts = { input: 0, output: 500_000, cacheRead: 0, cacheCreation: 0 }
    // 0.5M output tokens at $60.00/M = $30.00
    expect(estimateCost('gpt-4', tokens)).toBeCloseTo(30.0, 5)
  })
})
