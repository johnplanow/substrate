/**
 * Tests for Zod validation schemas and validator helpers
 */

import { describe, it, expect } from 'vitest'
import {
  validateSpawnCommand,
  validateAdapterCapabilities,
  validateAdapterHealthResult,
  validateWithSchema,
  BillingModeSchema,
  TokenEstimateSchema,
  TaskResultSchema,
  PlannedTaskSchema,
  PlanParseResultSchema,
} from '@adapters/schemas'
import { AdtError } from '@core/errors'

// ---------------------------------------------------------------------------
// validateSpawnCommand
// ---------------------------------------------------------------------------
describe('validateSpawnCommand', () => {
  it('accepts a valid SpawnCommand', () => {
    const result = validateSpawnCommand({
      binary: 'claude',
      args: ['-p', 'Fix it', '--output-format', 'json'],
      cwd: '/tmp/worktree',
    })
    expect(result.binary).toBe('claude')
    expect(result.args).toHaveLength(4)
    expect(result.cwd).toBe('/tmp/worktree')
  })

  it('accepts optional env, stdin, and timeoutMs fields', () => {
    const result = validateSpawnCommand({
      binary: 'codex',
      args: ['exec', '--json'],
      cwd: '/tmp/wt',
      env: { OPENAI_API_KEY: 'sk-abc' },
      stdin: 'Fix the bug',
      timeoutMs: 30_000,
    })
    expect(result.env).toEqual({ OPENAI_API_KEY: 'sk-abc' })
    expect(result.stdin).toBe('Fix the bug')
    expect(result.timeoutMs).toBe(30_000)
  })

  it('throws AdtError for missing binary', () => {
    expect(() =>
      validateSpawnCommand({ args: [], cwd: '/tmp' })
    ).toThrow(AdtError)
  })

  it('throws AdtError for empty binary', () => {
    expect(() =>
      validateSpawnCommand({ binary: '', args: [], cwd: '/tmp' })
    ).toThrow(AdtError)
  })

  it('throws AdtError for missing cwd', () => {
    expect(() =>
      validateSpawnCommand({ binary: 'claude', args: [] })
    ).toThrow(AdtError)
  })

  it('throws AdtError for empty cwd', () => {
    expect(() =>
      validateSpawnCommand({ binary: 'claude', args: [], cwd: '' })
    ).toThrow(AdtError)
  })

  it('throws AdtError for negative timeoutMs', () => {
    expect(() =>
      validateSpawnCommand({ binary: 'claude', args: [], cwd: '/tmp', timeoutMs: -1 })
    ).toThrow(AdtError)
  })

  it('throws AdtError for non-integer timeoutMs', () => {
    expect(() =>
      validateSpawnCommand({ binary: 'claude', args: [], cwd: '/tmp', timeoutMs: 1.5 })
    ).toThrow(AdtError)
  })
})

// ---------------------------------------------------------------------------
// validateAdapterCapabilities
// ---------------------------------------------------------------------------
describe('validateAdapterCapabilities', () => {
  const validCapabilities = {
    supportsJsonOutput: true,
    supportsStreaming: true,
    supportsSubscriptionBilling: true,
    supportsApiBilling: true,
    supportsPlanGeneration: true,
    maxContextTokens: 200_000,
    supportedTaskTypes: ['code', 'refactor'],
    supportedLanguages: ['*'],
  }

  it('accepts valid AdapterCapabilities', () => {
    const result = validateAdapterCapabilities(validCapabilities)
    expect(result.supportsJsonOutput).toBe(true)
    expect(result.maxContextTokens).toBe(200_000)
    expect(result.supportedTaskTypes).toContain('code')
  })

  it('throws AdtError for missing boolean field', () => {
    const { supportsJsonOutput: _, ...missing } = validCapabilities
    expect(() => validateAdapterCapabilities(missing)).toThrow(AdtError)
  })

  it('throws AdtError for zero maxContextTokens', () => {
    expect(() =>
      validateAdapterCapabilities({ ...validCapabilities, maxContextTokens: 0 })
    ).toThrow(AdtError)
  })

  it('throws AdtError for negative maxContextTokens', () => {
    expect(() =>
      validateAdapterCapabilities({ ...validCapabilities, maxContextTokens: -1 })
    ).toThrow(AdtError)
  })

  it('throws AdtError for non-integer maxContextTokens', () => {
    expect(() =>
      validateAdapterCapabilities({ ...validCapabilities, maxContextTokens: 1.5 })
    ).toThrow(AdtError)
  })

  it('throws AdtError for non-array supportedTaskTypes', () => {
    expect(() =>
      validateAdapterCapabilities({ ...validCapabilities, supportedTaskTypes: 'code' })
    ).toThrow(AdtError)
  })
})

// ---------------------------------------------------------------------------
// validateAdapterHealthResult
// ---------------------------------------------------------------------------
describe('validateAdapterHealthResult', () => {
  it('accepts a minimal healthy result', () => {
    const result = validateAdapterHealthResult({
      healthy: true,
      supportsHeadless: true,
    })
    expect(result.healthy).toBe(true)
    expect(result.supportsHeadless).toBe(true)
  })

  it('accepts a full healthy result with detectedBillingModes array', () => {
    const result = validateAdapterHealthResult({
      healthy: true,
      version: '1.0.0',
      cliPath: '/usr/bin/claude',
      detectedBillingModes: ['subscription', 'api'],
      supportsHeadless: true,
    })
    expect(result.version).toBe('1.0.0')
    expect(result.detectedBillingModes).toEqual(['subscription', 'api'])
  })

  it('accepts an unhealthy result with error', () => {
    const result = validateAdapterHealthResult({
      healthy: false,
      error: 'CLI not found',
      supportsHeadless: false,
    })
    expect(result.healthy).toBe(false)
    expect(result.error).toBe('CLI not found')
  })

  it('throws AdtError for missing healthy field', () => {
    expect(() =>
      validateAdapterHealthResult({ supportsHeadless: true })
    ).toThrow(AdtError)
  })

  it('throws AdtError for missing supportsHeadless field', () => {
    expect(() =>
      validateAdapterHealthResult({ healthy: true })
    ).toThrow(AdtError)
  })

  it('throws AdtError for invalid billing mode in array', () => {
    expect(() =>
      validateAdapterHealthResult({
        healthy: true,
        supportsHeadless: true,
        detectedBillingModes: ['invalid'],
      })
    ).toThrow(AdtError)
  })
})

// ---------------------------------------------------------------------------
// validateWithSchema (generic helper)
// ---------------------------------------------------------------------------
describe('validateWithSchema', () => {
  it('returns parsed data on valid input', () => {
    const result = validateWithSchema(BillingModeSchema, 'api', 'BillingMode')
    expect(result).toBe('api')
  })

  it('throws AdtError with VALIDATION_ERROR code on invalid input', () => {
    try {
      validateWithSchema(BillingModeSchema, 'invalid', 'BillingMode')
      expect.fail('Should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(AdtError)
      expect((err as AdtError).code).toBe('VALIDATION_ERROR')
      expect((err as AdtError).message).toContain('BillingMode')
    }
  })
})

// ---------------------------------------------------------------------------
// Additional schema shape tests
// ---------------------------------------------------------------------------
describe('Schema shape validation', () => {
  it('BillingModeSchema accepts valid values', () => {
    expect(BillingModeSchema.parse('subscription')).toBe('subscription')
    expect(BillingModeSchema.parse('api')).toBe('api')
    expect(BillingModeSchema.parse('free')).toBe('free')
  })

  it('TokenEstimateSchema accepts valid data', () => {
    const result = TokenEstimateSchema.parse({ input: 100, output: 50, total: 150 })
    expect(result.total).toBe(150)
  })

  it('TokenEstimateSchema rejects negative values', () => {
    expect(() => TokenEstimateSchema.parse({ input: -1, output: 0, total: 0 })).toThrow()
  })

  it('TaskResultSchema accepts valid data', () => {
    const result = TaskResultSchema.parse({
      success: true,
      output: 'Done',
      exitCode: 0,
    })
    expect(result.success).toBe(true)
  })

  it('PlannedTaskSchema accepts valid task', () => {
    const result = PlannedTaskSchema.parse({
      title: 'Setup DB',
      description: 'Configure database',
      complexity: 5,
      dependencies: ['Init project'],
    })
    expect(result.title).toBe('Setup DB')
  })

  it('PlannedTaskSchema rejects complexity out of range', () => {
    expect(() =>
      PlannedTaskSchema.parse({ title: 'T', description: '', complexity: 11 })
    ).toThrow()
  })

  it('PlanParseResultSchema accepts valid plan result', () => {
    const result = PlanParseResultSchema.parse({
      success: true,
      tasks: [{ title: 'Task 1', description: 'Do something' }],
    })
    expect(result.tasks).toHaveLength(1)
  })
})
