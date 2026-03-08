/**
 * Unit tests for token-ceiling.ts
 *
 * Story 24-7: Configurable Token Ceiling Per Workflow
 * Covers AC1-AC6 from the test requirements:
 *  - Config with token_ceilings.create-story: 15000 resolves to 15000
 *  - Config without token_ceilings resolves to hardcoded defaults
 *  - Config with partial ceilings uses config for that, defaults for others
 *  - Schema validation rejects invalid values
 *  - Workflow log message includes ceiling and source
 */

import { describe, it, expect } from 'vitest'
import { getTokenCeiling, TOKEN_CEILING_DEFAULTS } from '../token-ceiling.js'
import type { TokenCeilings } from '../../config/config-schema.js'
import { TokenCeilingsSchema } from '../../config/config-schema.js'

// ---------------------------------------------------------------------------
// getTokenCeiling — resolution logic
// ---------------------------------------------------------------------------

describe('getTokenCeiling', () => {
  it('returns configured ceiling when token_ceilings.create-story is set', () => {
    const tokenCeilings: TokenCeilings = { 'create-story': 15000 }
    const result = getTokenCeiling('create-story', tokenCeilings)
    expect(result.ceiling).toBe(15000)
    expect(result.source).toBe('config')
  })

  it('returns hardcoded default when token_ceilings is undefined', () => {
    const result = getTokenCeiling('create-story', undefined)
    expect(result.ceiling).toBe(TOKEN_CEILING_DEFAULTS['create-story'])
    expect(result.source).toBe('default')
  })

  it('returns hardcoded default when token_ceilings is an empty object', () => {
    const result = getTokenCeiling('create-story', {})
    expect(result.ceiling).toBe(TOKEN_CEILING_DEFAULTS['create-story'])
    expect(result.source).toBe('default')
  })

  it('uses config ceiling for create-story and defaults for others when partial config', () => {
    const tokenCeilings: TokenCeilings = { 'create-story': 15000 }

    const createResult = getTokenCeiling('create-story', tokenCeilings)
    expect(createResult.ceiling).toBe(15000)
    expect(createResult.source).toBe('config')

    const devResult = getTokenCeiling('dev-story', tokenCeilings)
    expect(devResult.ceiling).toBe(TOKEN_CEILING_DEFAULTS['dev-story'])
    expect(devResult.source).toBe('default')

    const reviewResult = getTokenCeiling('code-review', tokenCeilings)
    expect(reviewResult.ceiling).toBe(TOKEN_CEILING_DEFAULTS['code-review'])
    expect(reviewResult.source).toBe('default')
  })

  it('returns correct defaults for all workflow types', () => {
    const workflowDefaults: Array<[string, number]> = [
      ['create-story', 10_000],
      ['dev-story', 80_000],
      ['code-review', 100_000],
      ['test-plan', 20_000],
      ['test-expansion', 40_000],
    ]

    for (const [workflow, expected] of workflowDefaults) {
      const result = getTokenCeiling(workflow, undefined)
      expect(result.ceiling, `${workflow} default`).toBe(expected)
      expect(result.source, `${workflow} source`).toBe('default')
    }
  })

  it('supports override for all workflow types', () => {
    const tokenCeilings: TokenCeilings = {
      'create-story': 10000,
      'dev-story': 50000,
      'code-review': 200000,
      'test-plan': 16000,
      'test-expansion': 40000,
    }

    for (const workflow of Object.keys(tokenCeilings) as Array<keyof TokenCeilings>) {
      const result = getTokenCeiling(workflow, tokenCeilings)
      expect(result.ceiling, `${workflow} config`).toBe(tokenCeilings[workflow])
      expect(result.source, `${workflow} source`).toBe('config')
    }
  })

  it('returns 0 for unknown workflow type with no config', () => {
    const result = getTokenCeiling('unknown-workflow', undefined)
    expect(result.ceiling).toBe(0)
    expect(result.source).toBe('default')
  })
})

// ---------------------------------------------------------------------------
// TOKEN_CEILING_DEFAULTS exports
// ---------------------------------------------------------------------------

describe('TOKEN_CEILING_DEFAULTS', () => {
  it('exports the expected hardcoded default values', () => {
    expect(TOKEN_CEILING_DEFAULTS['create-story']).toBe(10_000)
    expect(TOKEN_CEILING_DEFAULTS['dev-story']).toBe(80_000)
    expect(TOKEN_CEILING_DEFAULTS['code-review']).toBe(100_000)
    expect(TOKEN_CEILING_DEFAULTS['test-plan']).toBe(20_000)
    expect(TOKEN_CEILING_DEFAULTS['test-expansion']).toBe(40_000)
  })
})

// ---------------------------------------------------------------------------
// TokenCeilingsSchema — Zod validation (AC5)
// ---------------------------------------------------------------------------

describe('TokenCeilingsSchema validation', () => {
  it('accepts a valid create-story ceiling', () => {
    const result = TokenCeilingsSchema.safeParse({ 'create-story': 15000 })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data['create-story']).toBe(15000)
    }
  })

  it('accepts partial overrides (only create-story)', () => {
    const result = TokenCeilingsSchema.safeParse({ 'create-story': 15000 })
    expect(result.success).toBe(true)
  })

  it('accepts a full set of overrides', () => {
    const result = TokenCeilingsSchema.safeParse({
      'create-story': 10000,
      'dev-story': 50000,
      'code-review': 200000,
      'test-plan': 16000,
      'test-expansion': 40000,
    })
    expect(result.success).toBe(true)
  })

  it('accepts empty object (all keys optional)', () => {
    const result = TokenCeilingsSchema.safeParse({})
    expect(result.success).toBe(true)
  })

  it('rejects negative values', () => {
    const result = TokenCeilingsSchema.safeParse({ 'create-story': -500 })
    expect(result.success).toBe(false)
  })

  it('rejects zero values', () => {
    const result = TokenCeilingsSchema.safeParse({ 'create-story': 0 })
    expect(result.success).toBe(false)
  })

  it('rejects non-integer values', () => {
    const result = TokenCeilingsSchema.safeParse({ 'create-story': 1500.5 })
    expect(result.success).toBe(false)
  })

  it('rejects string values', () => {
    const result = TokenCeilingsSchema.safeParse({ 'create-story': 'abc' })
    expect(result.success).toBe(false)
  })

  it('rejects boolean values', () => {
    const result = TokenCeilingsSchema.safeParse({ 'create-story': true })
    expect(result.success).toBe(false)
  })
})
