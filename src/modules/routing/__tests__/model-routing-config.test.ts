/**
 * Tests for model-routing-config.ts
 *
 * AC1: Valid YAML parses correctly against ModelRoutingConfigSchema
 * AC2: Loader error handling — CONFIG_NOT_FOUND, INVALID_YAML, SCHEMA_INVALID
 * AC6: Model name allowlist validation via regex
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'

import {
  ModelRoutingConfigSchema,
  loadModelRoutingConfig,
  RoutingConfigError,
} from '../model-routing-config.js'
import { SubstrateError } from '../../../errors/substrate-error.js'

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
}))

const mockReadFileSync = vi.mocked(readFileSync)

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function setYamlContent(yaml: string): void {
  mockReadFileSync.mockReturnValue(yaml as unknown as Buffer)
}

function setReadError(message: string): void {
  mockReadFileSync.mockImplementation(() => {
    throw new Error(message)
  })
}

// ---------------------------------------------------------------------------
// ModelRoutingConfigSchema — unit tests (AC1)
// ---------------------------------------------------------------------------

describe('ModelRoutingConfigSchema', () => {
  it('AC1: accepts a complete valid config with all three phases', () => {
    const result = ModelRoutingConfigSchema.safeParse({
      version: 1,
      baseline_model: 'claude-sonnet-4-5',
      phases: {
        explore: { model: 'claude-haiku-4-5' },
        generate: { model: 'claude-sonnet-4-5', max_tokens: 8192 },
        review: { model: 'claude-sonnet-4-5' },
      },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.version).toBe(1)
      expect(result.data.phases.explore?.model).toBe('claude-haiku-4-5')
      expect(result.data.phases.generate?.model).toBe('claude-sonnet-4-5')
      expect(result.data.phases.generate?.max_tokens).toBe(8192)
      expect(result.data.phases.review?.model).toBe('claude-sonnet-4-5')
      expect(result.data.baseline_model).toBe('claude-sonnet-4-5')
    }
  })

  it('AC1: accepts a partial phases config (all phase keys optional)', () => {
    const result = ModelRoutingConfigSchema.safeParse({
      version: 1,
      baseline_model: 'claude-sonnet-4-5',
      phases: {
        generate: { model: 'claude-sonnet-4-5' },
      },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.phases.explore).toBeUndefined()
      expect(result.data.phases.generate?.model).toBe('claude-sonnet-4-5')
    }
  })

  it('AC1: accepts overrides map', () => {
    const result = ModelRoutingConfigSchema.safeParse({
      version: 1,
      baseline_model: 'claude-sonnet-4-5',
      phases: {
        generate: { model: 'claude-sonnet-4-5' },
      },
      overrides: {
        'dev-story': { model: 'claude-opus-4-6' },
      },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.overrides?.['dev-story']?.model).toBe('claude-opus-4-6')
    }
  })

  it('AC1: rejects version 2 (must be literal 1)', () => {
    const result = ModelRoutingConfigSchema.safeParse({
      version: 2,
      baseline_model: 'claude-sonnet-4-5',
      phases: {},
    })
    expect(result.success).toBe(false)
  })

  it('AC1: rejects missing version field', () => {
    const result = ModelRoutingConfigSchema.safeParse({
      baseline_model: 'claude-sonnet-4-5',
      phases: {},
    })
    expect(result.success).toBe(false)
  })

  it('AC1: rejects missing baseline_model field', () => {
    const result = ModelRoutingConfigSchema.safeParse({
      version: 1,
      phases: {},
    })
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// loadModelRoutingConfig — error handling (AC2)
// ---------------------------------------------------------------------------

describe('loadModelRoutingConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // --- AC1: happy path ---

  it('AC1: parses a valid YAML file and returns typed config', () => {
    setYamlContent(`
version: 1
baseline_model: claude-sonnet-4-5
phases:
  explore:
    model: claude-haiku-4-5
  generate:
    model: claude-sonnet-4-5
    max_tokens: 8192
  review:
    model: claude-sonnet-4-5
`)
    const config = loadModelRoutingConfig('/path/to/routing.yml')
    expect(config.version).toBe(1)
    expect(config.baseline_model).toBe('claude-sonnet-4-5')
    expect(config.phases.explore?.model).toBe('claude-haiku-4-5')
    expect(config.phases.generate?.model).toBe('claude-sonnet-4-5')
    expect(config.phases.generate?.max_tokens).toBe(8192)
    expect(config.phases.review?.model).toBe('claude-sonnet-4-5')
  })

  // --- AC2: error modes ---

  it('AC2: throws RoutingConfigError (CONFIG_NOT_FOUND) when file is missing', () => {
    setReadError('ENOENT: no such file or directory, open \'/missing.yml\'')

    expect(() => loadModelRoutingConfig('/missing.yml')).toThrow(RoutingConfigError)

    try {
      loadModelRoutingConfig('/missing.yml')
    } catch (e) {
      expect(e).toBeInstanceOf(RoutingConfigError)
      expect(e).toBeInstanceOf(SubstrateError)
      expect(e).toBeInstanceOf(Error)
      expect((e as RoutingConfigError).code).toBe('CONFIG_NOT_FOUND')
      expect((e as RoutingConfigError).message).toContain('/missing.yml')
    }
  })

  it('AC2: throws RoutingConfigError (INVALID_YAML) for malformed YAML', () => {
    // A string that is invalid YAML
    setYamlContent('key: [unclosed bracket')

    expect(() => loadModelRoutingConfig('/bad.yml')).toThrow(RoutingConfigError)

    try {
      loadModelRoutingConfig('/bad.yml')
    } catch (e) {
      expect(e).toBeInstanceOf(RoutingConfigError)
      expect(e).toBeInstanceOf(SubstrateError)
      expect((e as RoutingConfigError).code).toBe('INVALID_YAML')
      expect((e as RoutingConfigError).message).toContain('/bad.yml')
    }
  })

  it('AC2: throws RoutingConfigError (SCHEMA_INVALID) for wrong version', () => {
    setYamlContent(`
version: 2
baseline_model: claude-sonnet-4-5
phases:
  generate:
    model: claude-sonnet-4-5
`)

    expect(() => loadModelRoutingConfig('/wrong-version.yml')).toThrow(RoutingConfigError)

    try {
      loadModelRoutingConfig('/wrong-version.yml')
    } catch (e) {
      expect(e).toBeInstanceOf(RoutingConfigError)
      expect(e).toBeInstanceOf(SubstrateError)
      expect((e as RoutingConfigError).code).toBe('SCHEMA_INVALID')
    }
  })

  it('AC2: throws RoutingConfigError (SCHEMA_INVALID) for schema validation failures', () => {
    setYamlContent(`
version: 1
baseline_model: claude-sonnet-4-5
phases:
  generate:
    max_tokens: 8192
`)
    // Missing required 'model' field in generate phase

    expect(() => loadModelRoutingConfig('/invalid-schema.yml')).toThrow(RoutingConfigError)

    try {
      loadModelRoutingConfig('/invalid-schema.yml')
    } catch (e) {
      expect((e as RoutingConfigError).code).toBe('SCHEMA_INVALID')
    }
  })

  // --- AC6: model name allowlist ---

  it('AC6: accepts valid model name matching allowlist pattern', () => {
    setYamlContent(`
version: 1
baseline_model: claude-3-5-sonnet-20241022
phases:
  generate:
    model: claude-3-5-sonnet-20241022
`)
    expect(() => loadModelRoutingConfig('/valid-model.yml')).not.toThrow()
  })

  it('AC6: accepts model name with dots (e.g. claude.sonnet)', () => {
    setYamlContent(`
version: 1
baseline_model: claude.sonnet.v1
phases:
  generate:
    model: claude.sonnet.v1
`)
    expect(() => loadModelRoutingConfig('/dot-model.yml')).not.toThrow()
  })

  it('AC6: rejects model name with spaces — SCHEMA_INVALID with field path', () => {
    setYamlContent(`
version: 1
baseline_model: claude-sonnet
phases:
  generate:
    model: "claude 3!"
`)

    expect(() => loadModelRoutingConfig('/invalid-model.yml')).toThrow(RoutingConfigError)

    try {
      loadModelRoutingConfig('/invalid-model.yml')
    } catch (e) {
      expect(e).toBeInstanceOf(RoutingConfigError)
      expect((e as RoutingConfigError).code).toBe('SCHEMA_INVALID')
      // Error message should identify the offending field path
      const msg = (e as RoutingConfigError).message
      expect(msg).toContain('phases')
      expect(msg).toContain('generate')
      expect(msg).toContain('model')
    }
  })

  it('AC6: rejects invalid baseline_model — SCHEMA_INVALID', () => {
    setYamlContent(`
version: 1
baseline_model: "claude 3 invalid!"
phases:
  generate:
    model: claude-sonnet
`)

    expect(() => loadModelRoutingConfig('/invalid-baseline.yml')).toThrow(RoutingConfigError)

    try {
      loadModelRoutingConfig('/invalid-baseline.yml')
    } catch (e) {
      expect(e).toBeInstanceOf(RoutingConfigError)
      expect((e as RoutingConfigError).code).toBe('SCHEMA_INVALID')
      expect((e as RoutingConfigError).message).toContain('baseline_model')
    }
  })

  // --- RoutingConfigError carries filePath context ---

  it('carries filePath in error context', () => {
    setReadError('ENOENT')

    expect(() => loadModelRoutingConfig('/specific/path.yml')).toThrow(RoutingConfigError)

    try {
      loadModelRoutingConfig('/specific/path.yml')
    } catch (e) {
      expect((e as RoutingConfigError).context?.filePath).toBe('/specific/path.yml')
    }
  })
})
