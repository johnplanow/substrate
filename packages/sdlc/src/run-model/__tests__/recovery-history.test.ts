/**
 * Unit tests for RecoveryEntry and CostAccumulation schemas — Story 52-8.
 *
 * Tests AC1 (RecoveryEntrySchema), AC2 (CostAccumulationSchema), and
 * AC7 (backward compatibility: empty arrays, default cost_accumulation,
 * unknown outcome fallback).
 */

import { describe, it, expect } from 'vitest'
import { RecoveryEntrySchema, CostAccumulationSchema } from '../recovery-history.js'
import { RunManifestSchema } from '../schemas.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides?: Record<string, unknown>) {
  return {
    story_key: '52-8',
    attempt_number: 1,
    strategy: 'retry-with-context',
    root_cause: 'NEEDS_MAJOR_REWORK',
    outcome: 'retried',
    cost_usd: 0.05,
    timestamp: '2026-04-06T12:00:00.000Z',
    ...overrides,
  }
}

function makeMinimalManifest(overrides?: Record<string, unknown>) {
  return {
    run_id: 'test-run',
    cli_flags: {},
    story_scope: [],
    supervisor_pid: null,
    supervisor_session_id: null,
    per_story_state: {},
    recovery_history: [],
    cost_accumulation: { per_story: {}, run_total: 0 },
    pending_proposals: [],
    generation: 1,
    created_at: '2026-04-06T00:00:00.000Z',
    updated_at: '2026-04-06T00:00:00.000Z',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// AC1: RecoveryEntrySchema
// ---------------------------------------------------------------------------

describe('RecoveryEntrySchema (AC1)', () => {
  it('accepts a fully-populated valid entry', () => {
    const result = RecoveryEntrySchema.safeParse(makeEntry())
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.story_key).toBe('52-8')
      expect(result.data.attempt_number).toBe(1)
      expect(result.data.strategy).toBe('retry-with-context')
      expect(result.data.outcome).toBe('retried')
      expect(result.data.cost_usd).toBe(0.05)
    }
  })

  it('rejects an entry with attempt_number: -1 (negative integer)', () => {
    const result = RecoveryEntrySchema.safeParse(makeEntry({ attempt_number: -1 }))
    expect(result.success).toBe(false)
  })

  it('rejects an entry missing story_key', () => {
    const { story_key: _sk, ...withoutStoryKey } = makeEntry()
    const result = RecoveryEntrySchema.safeParse(withoutStoryKey)
    expect(result.success).toBe(false)
  })

  it('rejects an entry missing timestamp', () => {
    const { timestamp: _ts, ...withoutTimestamp } = makeEntry()
    const result = RecoveryEntrySchema.safeParse(withoutTimestamp)
    expect(result.success).toBe(false)
  })

  it('accepts an unknown outcome string via string fallback (AC1, AC7)', () => {
    const result = RecoveryEntrySchema.safeParse(makeEntry({ outcome: 'custom-outcome-v2' }))
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.outcome).toBe('custom-outcome-v2')
    }
  })

  it('accepts outcome: escalated', () => {
    const result = RecoveryEntrySchema.safeParse(makeEntry({ outcome: 'escalated' }))
    expect(result.success).toBe(true)
  })

  it('accepts outcome: skipped', () => {
    const result = RecoveryEntrySchema.safeParse(makeEntry({ outcome: 'skipped' }))
    expect(result.success).toBe(true)
  })

  it('accepts attempt_number: 0 (valid nonnegative integer)', () => {
    const result = RecoveryEntrySchema.safeParse(makeEntry({ attempt_number: 0 }))
    expect(result.success).toBe(true)
  })

  it('rejects a non-integer attempt_number', () => {
    const result = RecoveryEntrySchema.safeParse(makeEntry({ attempt_number: 1.5 }))
    expect(result.success).toBe(false)
  })

  it('rejects negative cost_usd', () => {
    const result = RecoveryEntrySchema.safeParse(makeEntry({ cost_usd: -0.01 }))
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// AC2: CostAccumulationSchema
// ---------------------------------------------------------------------------

describe('CostAccumulationSchema (AC2)', () => {
  it('accepts empty { per_story: {}, run_total: 0 } (initial value)', () => {
    const result = CostAccumulationSchema.safeParse({ per_story: {}, run_total: 0 })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.per_story).toEqual({})
      expect(result.data.run_total).toBe(0)
    }
  })

  it('accepts populated per_story and run_total', () => {
    const result = CostAccumulationSchema.safeParse({
      per_story: { '52-8': 0.12, '52-1': 0.05 },
      run_total: 0.17,
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.per_story['52-8']).toBe(0.12)
      expect(result.data.run_total).toBe(0.17)
    }
  })

  it('rejects negative run_total', () => {
    const result = CostAccumulationSchema.safeParse({ per_story: {}, run_total: -0.01 })
    expect(result.success).toBe(false)
  })

  it('rejects missing run_total', () => {
    const result = CostAccumulationSchema.safeParse({ per_story: {} })
    expect(result.success).toBe(false)
  })

  it('rejects missing per_story', () => {
    const result = CostAccumulationSchema.safeParse({ run_total: 0 })
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// AC7: Backward compatibility
// ---------------------------------------------------------------------------

describe('RunManifestSchema backward compatibility (AC7)', () => {
  it('validates recovery_history: [] (empty array) without error', () => {
    const manifest = makeMinimalManifest({ recovery_history: [] })
    const result = RunManifestSchema.safeParse(manifest)
    expect(result.success).toBe(true)
  })

  it('coerces missing cost_accumulation to { per_story: {}, run_total: 0 } via .default()', () => {
    const { cost_accumulation: _ca, ...withoutCostAccumulation } = makeMinimalManifest()
    const result = RunManifestSchema.safeParse(withoutCostAccumulation)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.cost_accumulation).toEqual({ per_story: {}, run_total: 0 })
    }
  })

  it('accepts a recovery entry with unknown outcome string in the history (AC7)', () => {
    const manifest = makeMinimalManifest({
      recovery_history: [
        makeEntry({ outcome: 'some-future-outcome' }),
      ],
    })
    const result = RunManifestSchema.safeParse(manifest)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.recovery_history[0]?.outcome).toBe('some-future-outcome')
    }
  })

  it('validates a manifest with populated recovery_history and cost_accumulation', () => {
    const manifest = makeMinimalManifest({
      recovery_history: [makeEntry(), makeEntry({ story_key: '52-1', attempt_number: 2 })],
      cost_accumulation: {
        per_story: { '52-8': 0.05, '52-1': 0.03 },
        run_total: 0.08,
      },
    })
    const result = RunManifestSchema.safeParse(manifest)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.recovery_history).toHaveLength(2)
      expect(result.data.cost_accumulation.run_total).toBe(0.08)
    }
  })
})
