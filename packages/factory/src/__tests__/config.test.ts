/**
 * Unit tests for FactoryConfigSchema, FactoryExtendedConfigSchema, and loadFactoryConfig.
 *
 * AC1 — FactoryConfigSchema validates fields with defaults and enforces constraints.
 * AC2 — FactoryExtendedConfigSchema extends SubstrateConfigSchema with optional factory key.
 * AC3 — loadFactoryConfig reads config.yaml and returns parsed FactoryExtendedConfig.
 *
 * Story 44-9.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ZodError } from 'zod'
import { FactoryConfigSchema, FactoryExtendedConfigSchema, loadFactoryConfig } from '../config.js'

// ---------------------------------------------------------------------------
// Module mocks (hoisted before imports in vitest)
// ---------------------------------------------------------------------------

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}))

vi.mock('js-yaml', () => ({
  default: {
    load: vi.fn(),
  },
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const validExtendedBase = {
  config_format_version: '1' as const,
  global: {
    log_level: 'info' as const,
    max_concurrent_tasks: 4,
    budget_cap_tokens: 0,
    budget_cap_usd: 0,
  },
  providers: {},
}

// ---------------------------------------------------------------------------
// FactoryConfigSchema tests (AC1)
// ---------------------------------------------------------------------------

describe('FactoryConfigSchema', () => {
  it('AC1a: parses all fields explicitly provided', () => {
    const input = {
      graph: 'pipeline.dot',
      scenario_dir: '/custom/scenarios/',
      satisfaction_threshold: 0.9,
      budget_cap_usd: 10.0,
      wall_clock_cap_seconds: 3600,
      plateau_window: 5,
      plateau_threshold: 0.1,
      backend: 'direct' as const,
    }
    const result = FactoryConfigSchema.parse(input)
    expect(result.graph).toBe('pipeline.dot')
    expect(result.scenario_dir).toBe('/custom/scenarios/')
    expect(result.satisfaction_threshold).toBe(0.9)
    expect(result.budget_cap_usd).toBe(10.0)
    expect(result.wall_clock_cap_seconds).toBe(3600)
    expect(result.plateau_window).toBe(5)
    expect(result.plateau_threshold).toBe(0.1)
    expect(result.backend).toBe('direct')
  })

  it('AC1b: empty object applies all defaults', () => {
    const result = FactoryConfigSchema.parse({})
    expect(result.graph).toBeUndefined()
    expect(result.scenario_dir).toBe('.substrate/scenarios/')
    expect(result.satisfaction_threshold).toBe(0.8)
    expect(result.budget_cap_usd).toBe(0)
    expect(result.wall_clock_cap_seconds).toBe(3600)
    expect(result.plateau_window).toBe(3)
    expect(result.plateau_threshold).toBe(0.05)
    expect(result.backend).toBe('cli')
  })

  it('AC1c: rejects satisfaction_threshold > 1', () => {
    expect(() => FactoryConfigSchema.parse({ satisfaction_threshold: 1.5 })).toThrow(ZodError)
  })

  it('AC1c: rejects satisfaction_threshold < 0', () => {
    expect(() => FactoryConfigSchema.parse({ satisfaction_threshold: -0.1 })).toThrow(ZodError)
  })

  it('AC1d: rejects invalid backend value', () => {
    expect(() => FactoryConfigSchema.parse({ backend: 'invalid' })).toThrow(ZodError)
  })

  it('AC1e: rejects plateau_window below min of 2', () => {
    expect(() => FactoryConfigSchema.parse({ plateau_window: 1 })).toThrow(ZodError)
  })

  it('AC1e: rejects plateau_window of 0', () => {
    expect(() => FactoryConfigSchema.parse({ plateau_window: 0 })).toThrow(ZodError)
  })

  it('AC1: rejects unknown fields (strict mode)', () => {
    expect(() => FactoryConfigSchema.parse({ unknown_field: 'value' })).toThrow(ZodError)
  })

  it('AC1: plateau_window of 2 is valid (minimum boundary)', () => {
    const result = FactoryConfigSchema.parse({ plateau_window: 2 })
    expect(result.plateau_window).toBe(2)
  })

  it('AC1: backend "cli" is valid', () => {
    const result = FactoryConfigSchema.parse({ backend: 'cli' })
    expect(result.backend).toBe('cli')
  })

  // ---------------------------------------------------------------------------
  // quality_mode field — story 46-6 (AC1)
  // ---------------------------------------------------------------------------

  it('AC1 (46-6): quality_mode defaults to dual-signal when omitted', () => {
    const result = FactoryConfigSchema.parse({})
    expect(result.quality_mode).toBe('dual-signal')
  })

  it('AC1 (46-6): quality_mode scenario-primary parses correctly', () => {
    const result = FactoryConfigSchema.parse({ quality_mode: 'scenario-primary' })
    expect(result.quality_mode).toBe('scenario-primary')
  })

  it('AC1 (46-6): quality_mode dual-signal parses correctly', () => {
    const result = FactoryConfigSchema.parse({ quality_mode: 'dual-signal' })
    expect(result.quality_mode).toBe('dual-signal')
  })

  it('AC1 (46-6): quality_mode code-review parses correctly', () => {
    const result = FactoryConfigSchema.parse({ quality_mode: 'code-review' })
    expect(result.quality_mode).toBe('code-review')
  })

  it('AC1 (46-6): quality_mode scenario-only parses correctly', () => {
    const result = FactoryConfigSchema.parse({ quality_mode: 'scenario-only' })
    expect(result.quality_mode).toBe('scenario-only')
  })

  it('AC1 (46-6): invalid quality_mode value throws ZodError', () => {
    expect(() => FactoryConfigSchema.parse({ quality_mode: 'invalid-mode' })).toThrow(ZodError)
  })
})

// ---------------------------------------------------------------------------
// FactoryExtendedConfigSchema tests (AC2)
// ---------------------------------------------------------------------------

describe('FactoryExtendedConfigSchema', () => {
  it('AC2a: parses base substrate config without factory key', () => {
    const result = FactoryExtendedConfigSchema.parse(validExtendedBase)
    expect(result.config_format_version).toBe('1')
    expect(result.factory).toBeUndefined()
  })

  it('AC2b: parses config with factory section and applies factory defaults', () => {
    const result = FactoryExtendedConfigSchema.parse({
      ...validExtendedBase,
      factory: { satisfaction_threshold: 0.9 },
    })
    expect(result.factory).toBeDefined()
    expect(result.factory!.satisfaction_threshold).toBe(0.9)
    expect(result.factory!.scenario_dir).toBe('.substrate/scenarios/')
    expect(result.factory!.backend).toBe('cli')
    expect(result.factory!.plateau_window).toBe(3)
  })

  it('AC2: factory key being absent results in undefined (not an error)', () => {
    expect(() => FactoryExtendedConfigSchema.parse(validExtendedBase)).not.toThrow()
    const result = FactoryExtendedConfigSchema.parse(validExtendedBase)
    expect(result.factory).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// loadFactoryConfig tests (AC3)
// ---------------------------------------------------------------------------

describe('loadFactoryConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('AC3: reads .substrate/config.yaml and returns validated config', async () => {
    const { readFile } = await import('node:fs/promises')
    const yaml = await import('js-yaml')

    const mockConfig = {
      ...validExtendedBase,
      factory: { satisfaction_threshold: 0.75 },
    }

    vi.mocked(readFile).mockResolvedValueOnce('yaml content')
    vi.mocked(yaml.default.load).mockReturnValueOnce(mockConfig)

    const result = await loadFactoryConfig('/project')
    expect(result.factory?.satisfaction_threshold).toBe(0.75)
    expect(result.config_format_version).toBe('1')
  })

  it('AC3: falls back to config.yaml in projectDir if .substrate/config.yaml not found', async () => {
    const { readFile } = await import('node:fs/promises')
    const yaml = await import('js-yaml')

    const notFoundError = Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    const mockConfig = { ...validExtendedBase }

    vi.mocked(readFile)
      .mockRejectedValueOnce(notFoundError) // .substrate/config.yaml not found
      .mockResolvedValueOnce('yaml content') // config.yaml found

    vi.mocked(yaml.default.load).mockReturnValueOnce(mockConfig)

    const result = await loadFactoryConfig('/project')
    expect(result.config_format_version).toBe('1')
    expect(result.factory).toBeUndefined()
  })

  it('AC3: returns all-defaults config when no file is found', async () => {
    const { readFile } = await import('node:fs/promises')

    const notFoundError = Object.assign(new Error('ENOENT'), { code: 'ENOENT' })

    vi.mocked(readFile).mockRejectedValue(notFoundError)

    const result = await loadFactoryConfig('/project')
    expect(result.config_format_version).toBe('1')
    expect(result.factory).toBeUndefined()
    // Factory defaults are not present in the result since factory key is absent
  })

  it('AC3: re-throws non-ENOENT errors', async () => {
    const { readFile } = await import('node:fs/promises')

    const parseError = new Error('YAML parse error')
    vi.mocked(readFile).mockRejectedValueOnce(parseError)

    await expect(loadFactoryConfig('/project')).rejects.toThrow('YAML parse error')
  })
})
