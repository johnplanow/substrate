/**
 * Unit tests for resolveMaxReviewCycles in run.ts
 *
 * Tests per-agent review cycle resolution logic that selects the higher
 * of the CLI default and the adapter's defaultMaxReviewCycles.
 */

import { describe, it, expect } from 'vitest'
import { resolveMaxReviewCycles } from '../run.js'

// Mock adapter registry with configurable capabilities
function makeRegistry(capabilities: { defaultMaxReviewCycles?: number } = {}) {
  return {
    get: () => ({
      getCapabilities: () => capabilities,
      buildCommand: () => ({ binary: 'test', args: [], cwd: '.' }),
      id: 'test',
    }),
    getAll: () => [],
    discoverAndRegister: async () => ({ registeredCount: 0, failedCount: 0, results: [] }),
  } as any
}

describe('resolveMaxReviewCycles', () => {
  it('returns CLI value when no agentId is provided', () => {
    expect(resolveMaxReviewCycles(2, undefined, makeRegistry())).toBe(2)
  })

  it('returns CLI value when no registry is provided', () => {
    expect(resolveMaxReviewCycles(2, 'codex', undefined)).toBe(2)
  })

  it('returns adapter default when higher than CLI value', () => {
    const registry = makeRegistry({ defaultMaxReviewCycles: 3 })
    expect(resolveMaxReviewCycles(2, 'codex', registry)).toBe(3)
  })

  it('returns CLI value when higher than adapter default', () => {
    const registry = makeRegistry({ defaultMaxReviewCycles: 2 })
    expect(resolveMaxReviewCycles(5, 'codex', registry)).toBe(5)
  })

  it('returns CLI value when adapter has no defaultMaxReviewCycles', () => {
    const registry = makeRegistry({})
    expect(resolveMaxReviewCycles(2, 'codex', registry)).toBe(2)
  })

  it('returns CLI value when adapter has no getCapabilities', () => {
    const registry = {
      get: () => ({ buildCommand: () => ({ binary: 'test', args: [], cwd: '.' }) }),
    } as any
    expect(resolveMaxReviewCycles(2, 'codex', registry)).toBe(2)
  })

  it('returns CLI value when registry returns undefined for agent', () => {
    const registry = { get: () => undefined } as any
    expect(resolveMaxReviewCycles(2, 'nonexistent', registry)).toBe(2)
  })

  it('uses Math.max — equal values return that value', () => {
    const registry = makeRegistry({ defaultMaxReviewCycles: 3 })
    expect(resolveMaxReviewCycles(3, 'codex', registry)).toBe(3)
  })
})
