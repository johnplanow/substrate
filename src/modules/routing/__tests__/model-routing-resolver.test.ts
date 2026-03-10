/**
 * Tests for model-routing-resolver.ts
 *
 * AC3: Task-type to phase mapping (known + unknown task types)
 * AC4: Per-task-type overrides take precedence over phase-level config
 * AC5: Graceful fallback when config file is missing
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import type pino from 'pino'

import { RoutingResolver, TASK_TYPE_PHASE_MAP } from '../model-routing-resolver.js'
import type { ModelRoutingConfig } from '../model-routing-config.js'

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
}))

const mockReadFileSync = vi.mocked(readFileSync)

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createMockLogger(): pino.Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    silent: vi.fn(),
    child: vi.fn(),
    level: 'debug',
  } as unknown as pino.Logger
}

/** Minimal config covering all three phases — no overrides (for AC3 tests) */
const FIXTURE_CONFIG_PLAIN: ModelRoutingConfig = {
  version: 1,
  phases: {
    explore: { model: 'claude-haiku-4-5' },
    generate: { model: 'claude-sonnet-4-5', max_tokens: 8192 },
    review: { model: 'claude-sonnet-4-5' },
  },
  baseline_model: 'claude-sonnet-4-5',
}

/** Config with a dev-story override (for AC4 tests) */
const FIXTURE_CONFIG_WITH_OVERRIDE: ModelRoutingConfig = {
  version: 1,
  phases: {
    explore: { model: 'claude-haiku-4-5' },
    generate: { model: 'claude-sonnet-4-5' },
    review: { model: 'claude-sonnet-4-5' },
  },
  baseline_model: 'claude-sonnet-4-5',
  overrides: {
    'dev-story': { model: 'claude-opus-4-6' },
  },
}

// ---------------------------------------------------------------------------
// TASK_TYPE_PHASE_MAP constant
// ---------------------------------------------------------------------------

describe('TASK_TYPE_PHASE_MAP', () => {
  it('maps create-story to generate', () => {
    expect(TASK_TYPE_PHASE_MAP['create-story']).toBe('generate')
  })

  it('maps dev-story to generate', () => {
    expect(TASK_TYPE_PHASE_MAP['dev-story']).toBe('generate')
  })

  it('maps code-review to review', () => {
    expect(TASK_TYPE_PHASE_MAP['code-review']).toBe('review')
  })

  it('maps explore to explore', () => {
    expect(TASK_TYPE_PHASE_MAP['explore']).toBe('explore')
  })
})

// ---------------------------------------------------------------------------
// RoutingResolver.resolveModel — AC3
// ---------------------------------------------------------------------------

describe('RoutingResolver.resolveModel (AC3 — phase mapping)', () => {
  let logger: pino.Logger
  let resolver: RoutingResolver

  beforeEach(() => {
    logger = createMockLogger()
    resolver = new RoutingResolver(FIXTURE_CONFIG_PLAIN, logger)
  })

  it('AC3: dev-story maps to generate phase', () => {
    const result = resolver.resolveModel('dev-story')
    expect(result).not.toBeNull()
    expect(result?.model).toBe('claude-sonnet-4-5')
    expect(result?.phase).toBe('generate')
    expect(result?.source).toBe('phase')
    expect(result?.maxTokens).toBe(8192)
  })

  it('AC3: create-story maps to generate phase', () => {
    const result = resolver.resolveModel('create-story')
    expect(result).not.toBeNull()
    expect(result?.model).toBe('claude-sonnet-4-5')
    expect(result?.phase).toBe('generate')
    expect(result?.source).toBe('phase')
  })

  it('AC3: code-review maps to review phase', () => {
    const result = resolver.resolveModel('code-review')
    expect(result).not.toBeNull()
    expect(result?.model).toBe('claude-sonnet-4-5')
    expect(result?.phase).toBe('review')
    expect(result?.source).toBe('phase')
  })

  it('AC3: explore maps to explore phase', () => {
    const result = resolver.resolveModel('explore')
    expect(result).not.toBeNull()
    expect(result?.model).toBe('claude-haiku-4-5')
    expect(result?.phase).toBe('explore')
    expect(result?.source).toBe('phase')
  })

  it('AC3: unknown task type defaults to generate phase', () => {
    const result = resolver.resolveModel('unknown-task-type')
    expect(result).not.toBeNull()
    expect(result?.model).toBe('claude-sonnet-4-5')
    expect(result?.phase).toBe('generate')
    expect(result?.source).toBe('phase')
  })

  it('returns null when the resolved phase is absent from config.phases', () => {
    const configWithoutReview: ModelRoutingConfig = {
      version: 1,
      phases: {
        generate: { model: 'claude-sonnet-4-5' },
      },
      baseline_model: 'claude-sonnet-4-5',
    }
    const res = new RoutingResolver(configWithoutReview, logger)
    expect(res.resolveModel('code-review')).toBeNull()
  })

  it('logs a debug message for each resolved model', () => {
    resolver.resolveModel('code-review')
    expect(logger.debug).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// RoutingResolver.resolveModel — AC4: per-task-type override
// ---------------------------------------------------------------------------

describe('RoutingResolver.resolveModel (AC4 — overrides)', () => {
  let logger: pino.Logger
  let resolver: RoutingResolver

  beforeEach(() => {
    logger = createMockLogger()
    resolver = new RoutingResolver(FIXTURE_CONFIG_WITH_OVERRIDE, logger)
  })

  it('AC4: dev-story override takes precedence over phase model', () => {
    const result = resolver.resolveModel('dev-story')
    expect(result).not.toBeNull()
    expect(result?.model).toBe('claude-opus-4-6')
    expect(result?.phase).toBe('generate')
    expect(result?.source).toBe('override')
  })

  it('AC4: create-story (no override) falls through to phase model with source: phase', () => {
    const result = resolver.resolveModel('create-story')
    expect(result).not.toBeNull()
    expect(result?.model).toBe('claude-sonnet-4-5')
    expect(result?.phase).toBe('generate')
    expect(result?.source).toBe('phase')
  })

  it('AC4: override includes maxTokens when specified', () => {
    const configWithTokenOverride: ModelRoutingConfig = {
      version: 1,
      phases: {
        generate: { model: 'claude-sonnet-4-5' },
      },
      baseline_model: 'claude-sonnet-4-5',
      overrides: {
        'dev-story': { model: 'claude-opus-4-6', max_tokens: 16384 },
      },
    }
    const res = new RoutingResolver(configWithTokenOverride, logger)
    const result = res.resolveModel('dev-story')
    expect(result?.maxTokens).toBe(16384)
    expect(result?.source).toBe('override')
  })
})

// ---------------------------------------------------------------------------
// RoutingResolver.createWithFallback — AC5
// ---------------------------------------------------------------------------

describe('RoutingResolver.createWithFallback (AC5)', () => {
  let logger: pino.Logger

  beforeEach(() => {
    logger = createMockLogger()
    vi.clearAllMocks()
  })

  it('AC5: returns a resolver where all resolveModel calls return null when config is missing', () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT: no such file or directory, open \'/missing.yml\'')
    })

    const resolver = RoutingResolver.createWithFallback('/missing.yml', logger)

    expect(resolver).toBeInstanceOf(RoutingResolver)
    expect(resolver.resolveModel('dev-story')).toBeNull()
    expect(resolver.resolveModel('create-story')).toBeNull()
    expect(resolver.resolveModel('code-review')).toBeNull()
    expect(resolver.resolveModel('explore')).toBeNull()
    expect(resolver.resolveModel('unknown')).toBeNull()
  })

  it('AC5: emits exactly one warn-level log at construction time', () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT: no such file or directory')
    })

    RoutingResolver.createWithFallback('/missing.yml', logger)

    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ component: 'routing', reason: 'config not found', configPath: '/missing.yml' }),
      expect.any(String),
    )
  })

  it('AC5: does not throw when config file is missing', () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT')
    })

    expect(() => RoutingResolver.createWithFallback('/missing.yml', logger)).not.toThrow()
  })

  it('rethrows non-NOT_FOUND errors (e.g. SCHEMA_INVALID)', () => {
    // Valid YAML but schema validation fails (wrong version)
    mockReadFileSync.mockReturnValue(`version: 2\nbaseline_model: x\nphases: {}` as unknown as Buffer)

    expect(() => RoutingResolver.createWithFallback('/bad-schema.yml', logger)).toThrow()
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('constructs a valid resolver when config exists', () => {
    mockReadFileSync.mockReturnValue(`
version: 1
baseline_model: claude-sonnet-4-5
phases:
  generate:
    model: claude-sonnet-4-5
` as unknown as Buffer)

    const resolver = RoutingResolver.createWithFallback('/valid.yml', logger)
    const result = resolver.resolveModel('dev-story')
    expect(result).not.toBeNull()
    expect(result?.model).toBe('claude-sonnet-4-5')
    expect(logger.warn).not.toHaveBeenCalled()
  })
})
